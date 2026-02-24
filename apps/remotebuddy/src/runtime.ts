import { loadPushPalsConfig, type PushPalsConfig } from "shared";

export interface RuntimeOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthroughArgs: string[];
}

export interface ResolveRuntimeOptionsParams {
  argv?: string[];
  config?: PushPalsConfig;
}

export interface ConnectWithRetryOptions {
  server: string;
  sessionId?: string | null;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
}

const RUNTIME_CONFIG = loadPushPalsConfig();
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export function getRuntimeConfig(): PushPalsConfig {
  return RUNTIME_CONFIG;
}

export function resolveRuntimeOptions(
  params: ResolveRuntimeOptionsParams = {},
): RuntimeOptions {
  const config = params.config ?? RUNTIME_CONFIG;
  const argv = params.argv ?? process.argv.slice(2);

  let serverOverride: string | undefined;
  let sessionOverride: string | null | undefined;
  let authOverride: string | null | undefined;
  const passthroughArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      passthroughArgs.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${arg}". Provide RemoteBuddy flags before "--".`);
    }
    switch (arg) {
      case "--server": {
        const value = expectValue(argv, i, arg);
        i += 1;
        const trimmed = value.trim();
        if (!trimmed) {
          throw new Error("--server requires a non-empty URL.");
        }
        serverOverride = trimmed;
        break;
      }
      case "--sessionId": {
        const value = expectValue(argv, i, arg);
        i += 1;
        sessionOverride = normalizeOptional(value);
        break;
      }
      case "--token":
      case "--authToken": {
        const value = expectValue(argv, i, arg);
        i += 1;
        authOverride = normalizeOptional(value);
        break;
      }
      default:
        throw new Error(`Unknown RemoteBuddy flag "${arg}".`);
    }
  }

  const server = normalizeServer(serverOverride ?? config.server.url);
  const sessionId =
    sessionOverride !== undefined ? sessionOverride : normalizeOptional(config.sessionId);
  const authToken =
    authOverride !== undefined ? authOverride : normalizeOptional(config.authToken);

  return {
    server,
    sessionId,
    authToken,
    passthroughArgs,
  };
}

export async function connectWithRetry(
  options: ConnectWithRetryOptions,
): Promise<string> {
  const {
    server,
    sessionId,
    maxRetries = Infinity,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    fetchImpl = fetch,
    sleepImpl = (ms: number) => Bun.sleep(ms),
    logger = (message: string) => console.log(message),
  } = options;

  const normalizedServer = normalizeServer(server);
  const sessionPayload = normalizeOptional(sessionId);
  const maxAttempts = Number.isFinite(maxRetries)
    ? Math.max(1, Math.floor(maxRetries))
    : Infinity;
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetchImpl(`${normalizedServer}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionPayload ? { sessionId: sessionPayload } : {}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
      }
      const data = (await res.json()) as { sessionId?: string };
      const resolvedSession = normalizeOptional(data.sessionId);
      if (!resolvedSession) {
        throw new Error("Server response did not include a sessionId.");
      }
      return resolvedSession;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= maxAttempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger(
        `[RemoteBuddy] Server unavailable (${lastError.message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await sleepImpl(delay);
    }
  }

  throw lastError ?? new Error("Failed to connect to RemoteBuddy server.");
}

function normalizeServer(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("RemoteBuddy server URL is required.");
  }
  return trimmed;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Flag "${flag}" expects a value.`);
  }
  if (value.startsWith("--")) {
    throw new Error(
      `Flag "${flag}" expects a value, but received another flag-like token "${value}".`,
    );
  }
  return value;
}
