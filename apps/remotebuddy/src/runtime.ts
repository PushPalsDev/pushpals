export type RuntimeDefaults = {
  serverUrl: string;
  sessionId: string | null;
  authToken: string | null;
};

export type RuntimeOptions = {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthroughArgs: string[];
};

export type LoadRuntimeOptionsArgs = {
  defaults: RuntimeDefaults;
  argv?: string[];
  env?: Record<string, string | undefined>;
};

type FetchFn = typeof fetch;

export type ConnectWithRetryOptions = {
  server: string;
  sessionId?: string | null;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchFn?: FetchFn;
  sleepFn?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
};

const SERVER_ENV_KEYS = ["PUSHPALS_SERVER_URL", "PUSHPALS_URL"];
const SESSION_ENV_KEYS = ["PUSHPALS_SESSION_ID"];
const TOKEN_ENV_KEYS = ["PUSHPALS_AUTH_TOKEN", "AUTH_TOKEN"];

export function loadRuntimeOptions(args: LoadRuntimeOptionsArgs): RuntimeOptions {
  const env = args.env ?? process.env;
  const argv = args.argv ?? process.argv.slice(2);

  let server = sanitizeServer(args.defaults.serverUrl);
  let sessionId = sanitizeSession(args.defaults.sessionId);
  let authToken = sanitizeToken(args.defaults.authToken);

  const envServer = readEnvValue(SERVER_ENV_KEYS, env);
  if (envServer !== undefined) {
    const normalized = sanitizeServer(envServer);
    if (normalized) server = normalized;
  }

  const envSession = readEnvValue(SESSION_ENV_KEYS, env);
  if (envSession !== undefined) {
    sessionId = sanitizeSession(envSession);
  }

  const envToken = readEnvValue(TOKEN_ENV_KEYS, env);
  if (envToken !== undefined) {
    authToken = sanitizeToken(envToken);
  }

  const passthroughArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const rawArg = argv[i];
    if (rawArg === "--") {
      passthroughArgs.push(...argv.slice(i + 1));
      break;
    }
    if (!rawArg.startsWith("--")) {
      throw new Error(
        `Unexpected positional argument "${rawArg}". Use -- to pass through extra arguments.`,
      );
    }
    const { flag, value, nextIndex } = parseFlag(rawArg, argv, i);
    i = nextIndex;
    const trimmed = value.trim();
    switch (flag) {
      case "--server": {
        if (!trimmed) {
          throw new Error("--server requires a non-empty value.");
        }
        server = trimmed;
        break;
      }
      case "--sessionId": {
        sessionId = trimmed ? trimmed : null;
        break;
      }
      case "--token":
      case "--authToken": {
        if (!trimmed) {
          throw new Error("--token cannot be blank. Remove the flag to omit auth.");
        }
        authToken = trimmed;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (!server) {
    throw new Error(
      "RemoteBuddy server URL is required. Configure config.server.url, PUSHPALS_SERVER_URL, or --server.",
    );
  }

  return {
    server,
    sessionId,
    authToken,
    passthroughArgs,
  };
}

export async function connectWithRetry(options: ConnectWithRetryOptions): Promise<string> {
  const server = sanitizeServer(options.server);
  if (!server) {
    throw new Error("Server URL is required for connectWithRetry().");
  }
  const sessionId = sanitizeSession(options.sessionId);
  const maxAttempts = options.maxAttempts ?? Infinity;
  const baseDelayMs = clampPositive(options.baseDelayMs, 2000);
  const maxDelayMs = clampPositive(options.maxDelayMs, 30000);
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable. Provide a fetchFn implementation.");
  }
  const sleep = options.sleepFn ?? defaultSleep;
  const log = options.logger ?? defaultLogger;

  let attempt = 0;
  const endpoint = buildSessionsEndpoint(server);
  while (true) {
    attempt += 1;
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      const data = (await res.json()) as unknown;
      const remoteSessionId = extractSessionId(data);
      if (remoteSessionId) {
        return remoteSessionId;
      }
      throw new Error("Server response missing sessionId.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        throw err instanceof Error ? err : new Error(message);
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (log) {
        log(
          `[RemoteBuddy] Server unavailable (${message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
        );
      }
      await sleep(delay);
    }
  }
}

function parseFlag(arg: string, argv: string[], index: number): {
  flag: string;
  value: string;
  nextIndex: number;
} {
  const eqIndex = arg.indexOf("=");
  if (eqIndex >= 0) {
    const flag = arg.slice(0, eqIndex) || arg;
    return { flag, value: arg.slice(eqIndex + 1), nextIndex: index };
  }
  if (index + 1 >= argv.length) {
    throw new Error(`Flag ${arg} requires a value.`);
  }
  const next = argv[index + 1];
  if (next.startsWith("--")) {
    throw new Error(`Flag ${arg} requires a value.`);
  }
  return { flag: arg, value: next, nextIndex: index + 1 };
}

function sanitizeServer(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function sanitizeSession(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function sanitizeToken(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function readEnvValue(
  keys: readonly string[],
  env: Record<string, string | undefined>,
): string | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      const raw = env[key];
      if (raw === undefined || raw === null) continue;
      return raw;
    }
  }
  return undefined;
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  const normalized = Math.max(0, Number(value));
  return normalized === 0 ? fallback : normalized;
}

function buildSessionsEndpoint(server: string): string {
  const trimmed = server.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("/")) return `${trimmed.replace(/\/+$/, "")}/sessions`;
  return `${trimmed}/sessions`;
}

function extractSessionId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const sessionId = (data as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  return trimmed || null;
}

const defaultSleep = (ms: number): Promise<void> => {
  if (typeof Bun !== "undefined" && typeof Bun.sleep === "function") {
    return Bun.sleep(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const defaultLogger = (message: string): void => {
  console.log(message);
};
