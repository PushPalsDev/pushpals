#!/usr/bin/env bun

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

import {
  runStartupPreflight,
  type DockerAuthProbe,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistContext,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupTelemetryEmitter,
  type StartupTelemetryEvent,
  type SyntheticStartupTester,
} from "./checklist.js";
import {
  detectRepoRoot,
  loadPushPalsConfig,
  type PushPalsConfig,
} from "shared";

const DEFAULT_MIN_BUN_VERSION = "1.3.0";
const DEFAULT_REQUIRED_ENV_VARS = [
  "PUSHPALS_AUTH_TOKEN",
  "REMOTE_STABLE_ID",
  "WORKERPALS_API_URL",
  "SERVER_BASE_URL",
];

type Logger = (line: string) => void;

const createLogger = (logger?: Logger): Logger =>
  typeof logger === "function" ? logger : console.log;

const resolveGitPath = (repoRoot: string, relativePath: string): string | undefined => {
  const result = Bun.spawnSync(
    ["git", "rev-parse", "--git-path", relativePath],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const output = result.stdout.toString().trim();
  if (!output) return undefined;
  return isAbsolute(output) ? output : join(repoRoot, output);
};

const detectMergeOrRebaseState = (
  repoRoot: string,
): { inProgress: boolean; reason?: string } => {
  const indicators = [
    { path: "MERGE_HEAD", reason: "merge in progress" },
    { path: "REBASE_HEAD", reason: "rebase in progress" },
    { path: "rebase-merge", reason: "rebase in progress" },
    { path: "rebase-apply", reason: "rebase in progress" },
    { path: "CHERRY_PICK_HEAD", reason: "cherry-pick in progress" },
  ];
  for (const indicator of indicators) {
    const resolved = resolveGitPath(repoRoot, indicator.path);
    if (resolved && existsSync(resolved)) {
      return { inProgress: true, reason: indicator.reason };
    }
  }
  return { inProgress: false };
};

const runGitDescribe = (repoRoot: string): RepoStatus => {
  const status = Bun.spawnSync(["git", "status", "--porcelain=2", "--branch"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (status.exitCode !== 0) {
    throw new Error(
      `git status failed: ${status.stderr.toString().trim() || "unknown error"}`,
    );
  }
  const lines = status.stdout.toString().split("\n");
  const branchLine = lines.find((line) => line.startsWith("# branch.head"));
  const branch = branchLine ? branchLine.split(" ").at(-1) ?? undefined : undefined;
  const dirtyEntries = lines.filter(
    (line) => line.trim() !== "" && !line.startsWith("#"),
  );
  const isDirty = dirtyEntries.length > 0;
  const mergeState = detectMergeOrRebaseState(repoRoot);
  const detailParts: string[] = [];
  if (isDirty) {
    detailParts.push(dirtyEntries.slice(0, 4).join(", "));
  } else {
    detailParts.push("Worktree clean.");
  }
  if (mergeState.reason) {
    detailParts.push(mergeState.reason);
  }
  return {
    isDirty,
    isMergeInProgress: mergeState.inProgress,
    branch,
    detail: detailParts.join(" | "),
  };
};

const parseAlertsFromEnv = (): string[] => {
  const raw = process.env.REMOTEBUDDY_ACTIVE_ALERTS ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const dockerConfigPaths = (): string[] => {
  const candidate = process.env.DOCKER_CONFIG;
  if (candidate && candidate.trim()) {
    return [join(candidate.trim(), "config.json")];
  }
  const home = homedir();
  return [join(home, ".docker", "config.json")];
};

const readDockerConfigAuthSummary = (): {
  hasCreds: boolean;
  registries: number;
} => {
  for (const configPath of dockerConfigPaths()) {
    if (!existsSync(configPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      const auths = parsed?.auths && typeof parsed.auths === "object" ? parsed.auths : {};
      const credsStore = typeof parsed?.credsStore === "string" && parsed.credsStore.trim();
      const credHelpers =
        parsed?.credHelpers && typeof parsed.credHelpers === "object"
          ? Object.keys(parsed.credHelpers)
          : [];
      const registries = Object.keys(auths);
      const hasCreds =
        registries.some((registry) => {
          const entry = auths[registry];
          if (!entry || typeof entry !== "object") return false;
          const auth = typeof entry.auth === "string" && entry.auth.trim();
          const identityToken =
            typeof entry.identitytoken === "string" && entry.identitytoken.trim();
          return Boolean(auth || identityToken);
        }) ||
        Boolean(credsStore) ||
        credHelpers.length > 0;
      return { hasCreds, registries: registries.length };
    } catch {
      // fallback to best-effort no creds
    }
  }
  return { hasCreds: false, registries: 0 };
};

const probeDockerAuth = (): Promise<{ ok: boolean; detail?: string }> => {
  return new Promise((resolve) => {
    try {
      const probe = Bun.spawnSync(["docker", "info", "--format", "{{json .ServerVersion}}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (probe.exitCode !== 0) {
        const stderr = probe.stderr.toString().trim();
        resolve({
          ok: false,
          detail: stderr || "Docker daemon not reachable. Start Docker and rerun.",
        });
        return;
      }
      const versionText = probe.stdout.toString().trim().replace(/(^\"|\"$)/g, "");
      const creds = readDockerConfigAuthSummary();
      if (!creds.hasCreds) {
        resolve({
          ok: false,
          detail:
            "Docker daemon responded but no registry credentials found. Run `docker login` for the required registry.",
        });
        return;
      }
      resolve({
        ok: true,
        detail: `Docker server ${versionText || "unknown"} with ${creds.registries} credential entries.`,
      });
    } catch (error) {
      resolve({
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : "Docker probe crashed. Ensure docker is installed and in PATH.",
      });
    }
  });
};

const createConsoleTelemetry = (logger: Logger): StartupTelemetryEmitter => ({
  emit: (event: StartupTelemetryEvent) => {
    const fields = [
      `event=${event.event}`,
      `step=${event.step}`,
      `code=${event.code}`,
      `category=${event.category}`,
    ];
    if (event.status) fields.push(`status=${event.status}`);
    if (typeof event.elapsedMs === "number") fields.push(`elapsedMs=${event.elapsedMs}`);
    if (event.detail) fields.push(`detail=${event.detail}`);
    logger(`[startup.telemetry] ${fields.join(" ")}`);
  },
});

const createSyntheticTester = (serverUrl: string) => ({
  async runSyntheticJob(options: { maxLatencyMs: number; probeName: string }) {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = Math.max(options.maxLatencyMs, 2_000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/healthz`, {
        method: "GET",
        signal: controller.signal,
      });
      const latencyMs = Math.max(1, Date.now() - started);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          latencyMs,
          failureDetail: `HTTP ${res.status} ${res.statusText} ${text}`.trim(),
        };
      }
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Math.max(1, Date.now() - started);
      return {
        ok: false,
        latencyMs,
        failureDetail:
          error instanceof Error ? error.message : "Synthetic probe failed unexpectedly.",
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});

export interface StartupPreflightRunOptions {
  config?: PushPalsConfig;
  allowDirtyWorktree?: boolean;
  minBunVersion?: string;
  requiredEnvVars?: string[];
  logger?: Logger;
  bunVersionProvider?: () => string | Promise<string>;
  dockerProbe?: DockerAuthProbe;
  envVarResolver?: StartupChecklistOptions["envVarResolver"];
  repoStatusProvider?: () => RepoStatus | Promise<RepoStatus>;
  alertsProvider?: () => string[] | Promise<string[]>;
  syntheticTester?: SyntheticStartupTester;
  telemetry?: StartupTelemetryEmitter;
  now?: () => number;
  checkLogger?: (entry: StartupCheckRecord) => void;
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
}

export interface StartupPreflightCliOptions extends StartupPreflightRunOptions {
  exit?: (code: number) => never | void;
  ensureFn?: (
    options?: StartupPreflightRunOptions,
  ) => Promise<StartupChecklistResult>;
}

const buildChecklistOptions = (
  options: StartupPreflightRunOptions,
): StartupChecklistOptions => ({
  allowDirtyWorktree: options.allowDirtyWorktree,
  minBunVersion: options.minBunVersion ?? DEFAULT_MIN_BUN_VERSION,
  bunVersionProvider:
    options.bunVersionProvider ??
    (async () => {
      if (typeof Bun !== "undefined" && typeof Bun.version === "string") {
        return Bun.version;
      }
      const runtime = process?.version ?? "";
      return runtime.replace(/^v/, "");
    }),
  dockerProbe: options.dockerProbe ?? probeDockerAuth,
  requiredEnvVars: options.requiredEnvVars ?? DEFAULT_REQUIRED_ENV_VARS,
  envVarResolver:
    options.envVarResolver ??
    ((key: string) => process.env[key]),
  syntheticMaxLatencyMs: options.syntheticMaxLatencyMs,
  syntheticProbeName: options.syntheticProbeName,
});

const createChecklistContext = (
  repoRoot: string,
  config: PushPalsConfig,
  logger: Logger,
  options: StartupPreflightRunOptions,
): StartupChecklistContext => {
  const describeRepo =
    options.repoStatusProvider
      ? async () => options.repoStatusProvider!()
      : async () => runGitDescribe(repoRoot);
  const listFiringAlerts =
    options.alertsProvider
      ? async () => options.alertsProvider!()
      : async () => parseAlertsFromEnv();
  const syntheticTester =
    options.syntheticTester ?? createSyntheticTester(config.server.url);
  const now = options.now ?? (() => Date.now());
  const telemetry = options.telemetry ?? createConsoleTelemetry(logger);
  const log =
    options.checkLogger ??
    ((entry) => {
      logger(
        `[startup.check ${entry.step}] ${entry.code} status=${entry.status} detail=${entry.detail}`,
      );
    });
  return {
    describeRepo,
    listFiringAlerts,
    syntheticTester,
    now,
    log,
    telemetry,
  };
};

export const runStartupPreflightWithDiagnostics = async (
  options: StartupPreflightRunOptions = {},
): Promise<StartupChecklistResult> => {
  const logger = createLogger(options.logger);
  const config = options.config ?? loadPushPalsConfig();
  const repoRoot = detectRepoRoot(process.cwd());
  const ctx = createChecklistContext(repoRoot, config, logger, options);
  const checklistOptions = buildChecklistOptions(options);
  return runStartupPreflight(ctx, checklistOptions);
};

export const ensureStartupPreflightReadiness = async (
  options: StartupPreflightRunOptions = {},
): Promise<StartupChecklistResult> => {
  const result = await runStartupPreflightWithDiagnostics(options);
  if (!result.ok) {
    const failure = result.failure!;
    const logger = createLogger(options.logger);
    logger(
      `[startup.failure] step=${failure.step} code=${failure.code} category=${failure.category}`,
    );
    logger(`[startup.failure] detail=${failure.detail}`);
    logger(`[startup.failure] action=${failure.action}`);
    throw new Error(
      `Startup preflight failed (${failure.code}): ${failure.detail}. Action: ${failure.action}`,
    );
  }
  return result;
};

export const runStartupPreflightCli = async (
  cliOptions: StartupPreflightCliOptions = {},
): Promise<void> => {
  const { exit: exitOverride, ensureFn, ...runOptions } = cliOptions;
  const logger = createLogger(runOptions.logger);
  const exit =
    exitOverride ??
    ((code: number) => {
      process.exit(code);
    });
  const ensure = ensureFn ?? ensureStartupPreflightReadiness;
  const runOptionsWithLogger: StartupPreflightRunOptions = {
    ...runOptions,
    logger,
  };
  logger("[startup] Running RemoteBuddy startup preflight...");
  try {
    const result = await ensure(runOptionsWithLogger);
    logger(
      `[startup] All ${result.history.length} checks passed. RemoteBuddy is ready to dispatch.`,
    );
    exit(0);
  } catch (error) {
    logger(
      `[startup] Preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    exit(1);
  }
};

if (import.meta.main) {
  runStartupPreflightCli().catch((error) => {
    console.error(`[startup] Fatal error: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
}
