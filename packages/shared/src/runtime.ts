import { loadPushPalsConfig, type PushPalsConfig } from "./config.js";

type EnvMap = Record<string, string | undefined>;

const DEFAULT_SERVER_FLAGS = ["--server"];
const DEFAULT_SESSION_FLAGS = ["--sessionId", "--session-id", "--session"];
const DEFAULT_TOKEN_FLAGS = ["--token", "--authToken", "--auth-token"];
const DEFAULT_SERVER_ENV_KEYS = ["REMOTEBUDDY_SERVER_URL", "PUSHPALS_SERVER_URL"];
const DEFAULT_SESSION_ENV_KEYS = ["REMOTEBUDDY_SESSION_ID", "PUSHPALS_SESSION_ID"];
const DEFAULT_TOKEN_ENV_KEYS = ["REMOTEBUDDY_AUTH_TOKEN", "PUSHPALS_AUTH_TOKEN"];

type FlagAliases = {
  server: string[];
  session: string[];
  token: string[];
};

type EnvAliases = {
  server: string[];
  session: string[];
  token: string[];
};

export interface RuntimeArgDefaults {
  server: string;
  sessionId?: string | null;
  authToken?: string | null;
}

export interface RuntimeArgResolution {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  rest: string[];
}

export interface ResolveRuntimeArgsOptions {
  argv?: readonly string[];
  env?: EnvMap;
  defaults?: RuntimeArgDefaults;
  flags?: Partial<FlagAliases>;
  envKeys?: Partial<EnvAliases>;
}

export interface BootstrapRuntimeOptions {
  config?: PushPalsConfig;
  argv?: readonly string[];
  env?: EnvMap;
  flags?: Partial<FlagAliases>;
  envKeys?: Partial<EnvAliases>;
  requireSessionInput?: boolean;
  normalizeSession?: (value: string) => string;
  ensureSession?:
    | false
    | {
        enabled: boolean;
        logLabel?: string;
        maxRetries?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
      };
  ensureSessionImpl?: typeof ensureSessionWithRetry;
}

export interface BootstrapRuntimeResult {
  runtime: RuntimeArgResolution;
  config: PushPalsConfig;
  sessionId: string | null;
}

function normalizeString(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = normalizeString(value);
  return trimmed ? trimmed : null;
}

function firstEnvValue(
  keys: string[] | undefined,
  env: EnvMap,
): { value: string | null; found: boolean } {
  if (!keys) return { value: null, found: false };
  for (const key of keys) {
    if (!(key in env)) continue;
    return { value: normalizeOptional(env[key]), found: true };
  }
  return { value: null, found: false };
}

function parseFlagValue(arg: string, next: string | undefined): { flag: string; value: string | undefined; consumedNext: boolean } | null {
  if (!arg.startsWith("--")) return null;
  const eqIndex = arg.indexOf("=");
  if (eqIndex > 0) {
    return {
      flag: arg.slice(0, eqIndex),
      value: arg.slice(eqIndex + 1),
      consumedNext: false,
    };
  }
  return {
    flag: arg,
    value: next,
    consumedNext: true,
  };
}

export function extractForwardedArgs(rawArgs?: readonly string[]): string[] {
  if (!rawArgs || rawArgs.length === 0) return [];
  if (rawArgs[0] === "--") {
    return rawArgs.slice(1);
  }
  return Array.from(rawArgs);
}

export function resolveRuntimeArgs(options: ResolveRuntimeArgsOptions = {}): RuntimeArgResolution {
  let defaults: RuntimeArgDefaults;
  if (options.defaults) {
    defaults = options.defaults;
  } else {
    const cfg = loadPushPalsConfig();
    defaults = {
      server: cfg.server.url,
      sessionId: cfg.sessionId,
      authToken: cfg.authToken,
    };
  }
  const env = options.env ?? process.env;
  const argv = extractForwardedArgs(options.argv ?? process.argv.slice(2));

  const flagMap: FlagAliases = {
    server: options.flags?.server ?? DEFAULT_SERVER_FLAGS,
    session: options.flags?.session ?? DEFAULT_SESSION_FLAGS,
    token: options.flags?.token ?? DEFAULT_TOKEN_FLAGS,
  };

  const envMap: EnvAliases = {
    server: options.envKeys?.server ?? DEFAULT_SERVER_ENV_KEYS,
    session: options.envKeys?.session ?? DEFAULT_SESSION_ENV_KEYS,
    token: options.envKeys?.token ?? DEFAULT_TOKEN_ENV_KEYS,
  };

  let server = normalizeString(defaults.server);
  let sessionId = normalizeOptional(defaults.sessionId ?? null);
  let authToken = normalizeOptional(defaults.authToken ?? null);
  let serverFromCli = false;
  let sessionFromCli = false;
  let tokenFromCli = false;

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        rest.push(argv[j]);
      }
      break;
    }
    const parsed = parseFlagValue(arg, next);
    if (!parsed) {
      rest.push(arg);
      continue;
    }

    const { flag, value, consumedNext } = parsed;
    const lowerFlag = flag.toLowerCase();
    if (flagMap.server.some((candidate) => candidate.toLowerCase() === lowerFlag)) {
      if (value === undefined) {
        throw new Error(`Flag ${flag} requires a value`);
      }
      server = normalizeString(value);
      serverFromCli = true;
      if (consumedNext) i++;
      continue;
    }
    if (flagMap.session.some((candidate) => candidate.toLowerCase() === lowerFlag)) {
      if (value === undefined) {
        throw new Error(`Flag ${flag} requires a value`);
      }
      sessionId = normalizeOptional(value);
      sessionFromCli = true;
      if (consumedNext) i++;
      continue;
    }
    if (flagMap.token.some((candidate) => candidate.toLowerCase() === lowerFlag)) {
      if (value === undefined) {
        throw new Error(`Flag ${flag} requires a value`);
      }
      authToken = normalizeOptional(value);
      tokenFromCli = true;
      if (consumedNext) i++;
      continue;
    }

    rest.push(arg);
    if (consumedNext && value !== undefined) {
      rest.push(value);
      i++;
    }
  }

  if (!serverFromCli) {
    const envServer = firstEnvValue(envMap.server, env);
    if (envServer.found) {
      server = envServer.value ?? "";
    }
  }
  if (!sessionFromCli) {
    const envSession = firstEnvValue(envMap.session, env);
    if (envSession.found) {
      sessionId = envSession.value;
    }
  }
  if (!tokenFromCli) {
    const envToken = firstEnvValue(envMap.token, env);
    if (envToken.found) {
      authToken = envToken.value;
    }
  }

  if (!server) {
    throw new Error("Server URL could not be resolved from CLI, env, or config");
  }

  return {
    server,
    sessionId,
    authToken,
    rest,
  };
}

export interface EnsureSessionOptions {
  sessionId?: string | null;
  authToken?: string | null;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logLabel?: string;
  fetchImpl?: typeof fetch;
  shouldContinue?: () => boolean;
}

export async function ensureSessionWithRetry(
  serverUrl: string,
  options: EnsureSessionOptions = {},
): Promise<string> {
  const {
    sessionId,
    authToken,
    maxRetries = 10,
    baseDelayMs = 2000,
    maxDelayMs = 30000,
    logLabel = "PushPals",
    fetchImpl = fetch,
    shouldContinue,
  } = options;

  const payload = sessionId ? { sessionId } : {};
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken && authToken.trim()) {
    headers["Authorization"] = `Bearer ${authToken.trim()}`;
  }
  const prefix = logLabel.trim() ? `[${logLabel.trim()}]` : "";
  let attempt = 0;

  while (true) {
    if (shouldContinue && !shouldContinue()) {
      throw new Error("ensure_session_aborted");
    }

    attempt++;
    try {
      const res = await fetchImpl(`${serverUrl}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const seconds = (delay / 1000).toFixed(1);
      console.log(
        `${prefix ? `${prefix} ` : ""}Server unavailable (${err?.message ?? err}), retrying in ${seconds}s... (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

export async function bootstrapRuntime(
  options: BootstrapRuntimeOptions = {},
): Promise<BootstrapRuntimeResult> {
  const config = options.config ?? loadPushPalsConfig();
  const runtime = resolveRuntimeArgs({
    argv: options.argv,
    env: options.env,
    flags: options.flags,
    envKeys: options.envKeys,
    defaults: {
      server: config.server.url,
      sessionId: config.sessionId,
      authToken: config.authToken,
    },
  });

  const normalizeSession = options.normalizeSession;
  const normalizedSession = normalizeSession
    ? runtime.sessionId && normalizeSession(runtime.sessionId)
    : runtime.sessionId;

  if (options.requireSessionInput && !normalizedSession) {
    throw new Error(
      "Session ID is required but missing. Pass --sessionId, set REMOTEBUDDY_SESSION_ID, or configure session_id.",
    );
  }

  let sessionId = normalizedSession;
  if (options.ensureSession && options.ensureSession.enabled) {
    const ensureImpl = options.ensureSessionImpl ?? ensureSessionWithRetry;
    sessionId = await ensureImpl(runtime.server, {
      sessionId,
      authToken: runtime.authToken,
      logLabel: options.ensureSession.logLabel,
      maxRetries: options.ensureSession.maxRetries,
      baseDelayMs: options.ensureSession.baseDelayMs,
      maxDelayMs: options.ensureSession.maxDelayMs,
    });
  }

  return {
    runtime: { ...runtime, sessionId },
    config,
    sessionId,
  };
}
