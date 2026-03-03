import { constants as fsConstants, promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { PushPalsConfig } from "shared";

export type StartupPreflightRuntimeMode = "remotebuddy" | string;

export interface StartupPreflightSpec {
  runtimeMode: StartupPreflightRuntimeMode;
  requireBun?: boolean;
  requireAuthToken?: boolean;
  authToken?: string | null;
  authTokenEnvVar?: string;
  docker?: {
    requireDocker?: boolean;
    requireAuth?: boolean;
    workerImage?: string | null;
    registries?: string[];
    configPath?: string;
  };
}

export interface StartupPreflightContext {
  env?: Record<string, string | undefined>;
  fs?: {
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  detectBunRuntime?: () => { isBun: boolean; version?: string };
  runCredentialHelper?: CredentialHelperRunner;
}

export interface RemotebuddyStartupPreflightOverrides {
  authToken?: string | null;
  requireAuthToken?: boolean;
  workerpalImage?: string | null;
  requireDocker?: boolean;
  requireDockerAuth?: boolean;
  registries?: string[];
}

const defaultFs = {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, "utf8");
  },
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};

function defaultDetectBunRuntime(): { isBun: boolean; version?: string } {
  if (typeof Bun !== "undefined" && typeof Bun.version === "string") {
    return { isBun: true, version: Bun.version };
  }
  const bunVersion = typeof process !== "undefined" && typeof process.versions?.bun === "string"
    ? process.versions.bun
    : undefined;
  return { isBun: typeof bunVersion === "string", version: bunVersion };
}

type CredentialHelperRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CredentialHelperRunner = (
  binary: string,
  args: string[],
  input?: string,
) => Promise<CredentialHelperRunResult>;

const defaultCredentialHelperRunner: CredentialHelperRunner = async (binary, args, input) => {
  if (typeof Bun === "undefined" || typeof Bun.spawnSync !== "function") {
    throw new Error(
      `Startup preflight requires the Bun runtime to execute Docker credential helper ${binary}.`,
    );
  }
  try {
    const result = Bun.spawnSync([binary, ...args], {
      stdin: input ? new TextEncoder().encode(input) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const decoder = new TextDecoder();
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ? decoder.decode(result.stdout) : "",
      stderr: result.stderr ? decoder.decode(result.stderr) : "",
    };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

export async function ensureStartupPreflightReadiness(
  spec: StartupPreflightSpec,
  ctx: StartupPreflightContext = {},
): Promise<void> {
  const env = ctx.env ?? process.env;
  const fsApi = ctx.fs ?? defaultFs;
  const detectRuntime = ctx.detectBunRuntime ?? defaultDetectBunRuntime;

  if (spec.requireBun ?? false) {
    const runtime = detectRuntime();
    if (!runtime.isBun) {
      throw new Error(
        `Startup preflight requires the Bun runtime for ${spec.runtimeMode}; run via \`bun run\` instead of Node.`,
      );
    }
  }

  if (spec.requireAuthToken ?? false) {
    const envVar = spec.authTokenEnvVar ?? "PUSHPALS_AUTH_TOKEN";
    const token = spec.authToken ?? env[envVar] ?? null;
    if (!token || token.trim().length === 0) {
      throw new Error(
        `Startup preflight requires ${envVar} (or --token) for ${spec.runtimeMode} mode.`,
      );
    }
  }

  const dockerSpec = spec.docker;
  if (!dockerSpec) return;

  const requireDocker = dockerSpec.requireDocker ?? false;
  const requireAuth = dockerSpec.requireAuth ?? false;
  if (!requireDocker || !requireAuth) return;

  const registries = resolveRegistryList(dockerSpec);
  if (registries.length === 0) return;

  const dockerConfigPath = dockerSpec.configPath ?? resolveDockerConfigPath(env);
  if (!(await fsApi.exists(dockerConfigPath))) {
    throw new Error(
      `Startup preflight requires Docker login for ${registries.join(
        ", ",
      )}, but ${dockerConfigPath} is missing. Run \"docker login <registry>\" first.`,
    );
  }

  let config: DockerConfig;
  try {
    const contents = await fsApi.readFile(dockerConfigPath);
    config = JSON.parse(contents) as DockerConfig;
  } catch (error) {
    throw new Error(
      `Startup preflight could not parse Docker config at ${dockerConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const runHelper = ctx.runCredentialHelper ?? defaultCredentialHelperRunner;
  for (const registry of registries) {
    await ensureDockerRegistryCredentials(config, registry, dockerConfigPath, runHelper);
  }
}

type DockerAuthEntry = {
  auth?: string;
  identitytoken?: string;
  username?: string;
  password?: string;
};

type DockerConfig = {
  auths?: Record<string, DockerAuthEntry | undefined>;
  credsStore?: string;
  credHelpers?: Record<string, string | undefined>;
};

async function ensureDockerRegistryCredentials(
  config: DockerConfig,
  registry: string,
  dockerConfigPath: string,
  runHelper: CredentialHelperRunner,
): Promise<void> {
  const match = findDockerAuthEntry(config, registry);
  if (match && entryHasInlineCredentials(match.entry)) {
    return;
  }

  const helperName = resolveCredentialHelperName(config, match?.key ?? null, registry);
  if (helperName) {
    const helperBinary = normalizeCredentialHelperBinary(helperName);
    const probe = await credentialHelperHasRegistryEntry(helperBinary, registry, runHelper);
    if (probe.found) return;
    const suffix = probe.detail ? ` (${probe.detail})` : "";
    throw new Error(
      `Startup preflight requires Docker login for ${registry}, but credential helper ${helperBinary} has no stored credentials${suffix}. Run \"docker login ${registry}\" again to refresh the helper.`,
    );
  }

  throw new Error(
    `Startup preflight requires Docker login for ${registry}, but ${dockerConfigPath} does not contain credentials for that registry. Run \"docker login ${registry}\" to store credentials.`,
  );
}

function entryHasInlineCredentials(entry: DockerAuthEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.auth && entry.auth.trim()) return true;
  if (entry.identitytoken && entry.identitytoken.trim()) return true;
  if (entry.username && entry.password) return true;
  return false;
}

type DockerAuthMatch = {
  key: string;
  entry: DockerAuthEntry;
};

function findDockerAuthEntry(config: DockerConfig, registry: string): DockerAuthMatch | null {
  const auths = config.auths ?? {};
  const target = normalizeRegistryKey(registry);
  for (const [rawKey, entry] of Object.entries(auths)) {
    if (!entry) continue;
    if (normalizeRegistryKey(rawKey) !== target) continue;
    return { key: rawKey, entry };
  }
  return null;
}

function resolveCredentialHelperName(
  config: DockerConfig,
  matchedKey: string | null,
  registry: string,
): string | null {
  if (matchedKey) {
    const helper = lookupCredentialHelper(config.credHelpers, matchedKey);
    if (helper) return helper;
  }
  const fallback = lookupCredentialHelper(config.credHelpers, registry);
  if (fallback) return fallback;
  return config.credsStore ?? null;
}

function lookupCredentialHelper(
  helpers: Record<string, string | undefined> | undefined,
  key: string,
): string | null {
  if (!helpers) return null;
  const target = normalizeRegistryKey(key);
  for (const [rawKey, helper] of Object.entries(helpers)) {
    if (!helper) continue;
    if (normalizeRegistryKey(rawKey) !== target) continue;
    return helper;
  }
  return null;
}

function normalizeCredentialHelperBinary(helperName: string): string {
  if (!helperName) return helperName;
  if (helperName.startsWith("docker-credential-")) {
    return helperName;
  }
  return `docker-credential-${helperName}`;
}

type CredentialProbeResult = {
  found: boolean;
  detail?: string;
};

async function credentialHelperHasRegistryEntry(
  helperBinary: string,
  registry: string,
  runHelper: CredentialHelperRunner,
): Promise<CredentialProbeResult> {
  const normalizedTarget = normalizeRegistryKey(registry);
  const listResult = await runHelper(helperBinary, ["list"]);
  if (listResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(listResult.stdout || "{}") as Record<string, string>;
      for (const key of Object.keys(parsed)) {
        if (normalizeRegistryKey(key) === normalizedTarget) {
          return { found: true };
        }
      }
    } catch {
      // Ignore and fall back to `get`.
    }
  }

  const getResult = await runHelper(helperBinary, ["get"], `${registry}\n`);
  if (getResult.exitCode === 0) {
    if (credentialPayloadHasSecret(getResult.stdout)) {
      return { found: true };
    }
    return { found: false };
  }

  const detail = getResult.stderr?.trim() || listResult.stderr?.trim();
  return {
    found: false,
    detail: detail ? `${detail} (exit ${getResult.exitCode})` : `exit ${getResult.exitCode}`,
  };
}

function credentialPayloadHasSecret(payload: string): boolean {
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload) as { Username?: string; username?: string; Secret?: string; secret?: string };
    const username = parsed.Username ?? parsed.username ?? "";
    const secret = parsed.Secret ?? parsed.secret ?? "";
    return Boolean(username && secret);
  } catch {
    return false;
  }
}

function normalizeRegistryKey(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
}

function resolveRegistryList(dockerSpec: StartupPreflightSpec["docker"]): string[] {
  const explicit = dockerSpec?.registries ?? [];
  const derived = registryFromImage(dockerSpec?.workerImage ?? null);
  const all = [...explicit];
  if (derived) all.push(derived);
  const normalized = Array.from(new Set(all.map((entry) => entry.trim()).filter(Boolean)));
  return normalized;
}

function registryFromImage(image: string | null): string | null {
  if (!image) return null;
  const trimmed = image.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) return null;
  const candidate = trimmed.slice(0, slashIndex);
  if (candidate === "localhost") return candidate;
  if (candidate.includes(".") || candidate.includes(":")) {
    return candidate;
  }
  return null;
}

function resolveDockerConfigPath(env: Record<string, string | undefined>): string {
  const configDir = env.DOCKER_CONFIG && env.DOCKER_CONFIG.trim().length > 0
    ? env.DOCKER_CONFIG.trim()
    : join(homedir(), ".docker");
  return join(configDir, "config.json");
}

export function buildRemotebuddyStartupPreflightSpec(
  config: PushPalsConfig,
  overrides: RemotebuddyStartupPreflightOverrides = {},
): StartupPreflightSpec {
  const authToken = overrides.authToken ?? config.authToken ?? null;
  const requireAuthToken = overrides.requireAuthToken ?? true;
  const workerpalImage = overrides.workerpalImage ?? config.remotebuddy.workerpalImage;
  const requireDocker =
    overrides.requireDocker ??
    Boolean(config.remotebuddy.workerpalDocker && config.remotebuddy.workerpalRequireDocker);
  const requireDockerAuth =
    overrides.requireDockerAuth ??
    (requireDocker && Boolean(workerpalImage && registryFromImage(workerpalImage)));
  const registries = overrides.registries ?? undefined;

  return {
    runtimeMode: "remotebuddy",
    requireBun: true,
    requireAuthToken,
    authToken,
    authTokenEnvVar: "PUSHPALS_AUTH_TOKEN",
    docker: {
      requireDocker,
      requireAuth: requireDockerAuth,
      workerImage: workerpalImage,
      registries,
    },
  };
}
