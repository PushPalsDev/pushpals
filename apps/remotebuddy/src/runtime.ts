import { loadPushPalsConfig, type PushPalsConfig } from "shared";

export type RemoteBuddyRuntimeOptions = {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthroughArgs: string[];
};

export type RuntimeParseOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  config?: PushPalsConfig;
};

export type ConnectWithRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void> | void;
};

const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export function parseRuntimeOptions(
  options: RuntimeParseOptions = {},
): RemoteBuddyRuntimeOptions {
  const config = options.config ?? loadPushPalsConfig();
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);

  let server = normalizeConfigServer(config);
  let sessionId = normalizeConfigSessionId(config);
  let authToken = normalizeConfigAuthToken(config);

  const envServer = normalizeEnvServer(env?.PUSHPALS_SERVER_URL);
  if (envServer) server = envServer;

  const envSessionId = normalizeOverrideSessionId(env?.PUSHPALS_SESSION_ID);
  if (envSessionId !== undefined) sessionId = envSessionId;

  const envAuthToken = normalizeOverrideAuthToken(env?.PUSHPALS_AUTH_TOKEN);
  if (envAuthToken !== undefined) authToken = envAuthToken;

  const { runtimeArgs, passthroughArgs } = splitPassthroughArgs(argv);

  for (let i = 0; i < runtimeArgs.length; i++) {
    const arg = runtimeArgs[i];
    if (!arg.startsWith("-")) {
      throw new Error(`Unexpected positional argument "${arg}" (flags must precede -- passthrough).`);
    }
    switch (arg) {
      case "--server": {
        const value = runtimeArgs[++i];
        if (value === undefined) {
          throw new Error("Missing value for --server");
        }
        const normalized = value.trim();
        if (!normalized) {
          throw new Error("--server requires a non-empty URL");
        }
        server = normalized;
        break;
      }
      case "--sessionId": {
        const value = runtimeArgs[++i];
        if (value === undefined) {
          throw new Error("Missing value for --sessionId");
        }
        const normalized = value.trim();
        sessionId = normalized ? normalized : null;
        break;
      }
      case "--token": {
        const value = runtimeArgs[++i];
        if (value === undefined) {
          throw new Error("Missing value for --token");
        }
        const normalized = value.trim();
        if (!normalized) {
          throw new Error("--token requires a non-empty value");
        }
        authToken = normalized;
        break;
      }
      case "":
        break;
      default:
        throw new Error(`Unknown runtime flag: ${arg}`);
    }
  }

  return {
    server,
    sessionId,
    authToken,
    passthroughArgs,
  };
}

export async function connectWithRetry(
  server: string,
  sessionId?: string | null,
  options: ConnectWithRetryOptions = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? Infinity;
  const baseDelay = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const sleepImpl = options.sleepFn ?? Bun.sleep;

  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available");
  }

  let attempt = 0;
  const payload = sessionId && sessionId.trim() ? { sessionId: sessionId.trim() } : {};
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      const res = await fetchImpl(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { sessionId?: string | null };
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        throw new Error("Server response missing sessionId");
      }
      return data.sessionId;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
      console.log(
        `[RemoteBuddy] Server unavailable (${message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await sleepImpl(delay);
    }
  }
}

function splitPassthroughArgs(args: string[]): {
  runtimeArgs: string[];
  passthroughArgs: string[];
} {
  const dividerIndex = args.indexOf("--");
  if (dividerIndex === -1) {
    return { runtimeArgs: [...args], passthroughArgs: [] };
  }
  return {
    runtimeArgs: args.slice(0, dividerIndex),
    passthroughArgs: args.slice(dividerIndex + 1),
  };
}

function normalizeConfigServer(config: PushPalsConfig): string {
  const base = config.server?.url?.trim();
  if (!base) {
    throw new Error("PushPals config is missing server.url");
  }
  return base;
}

function normalizeConfigSessionId(config: PushPalsConfig): string | null {
  const raw = config.sessionId;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeConfigAuthToken(config: PushPalsConfig): string | null {
  const raw = config.authToken;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeEnvServer(value: string | undefined): string | undefined {
  if (typeof value === "undefined") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOverrideSessionId(
  value: string | undefined,
): string | null | undefined {
  if (typeof value === "undefined") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeOverrideAuthToken(
  value: string | undefined,
): string | null | undefined {
  if (typeof value === "undefined") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}
