import type { PushPalsConfig } from "shared";

type EnvSource = Record<string, string | undefined>;

export type RemoteBuddyRuntimeOptions = {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthroughArgs: string[];
};

export type RemoteBuddyRuntimeLoaderConfig = {
  server: { url: string };
} & Pick<PushPalsConfig, "sessionId" | "authToken">;

export type LoadRemoteBuddyRuntimeOptionsParams = {
  argv?: string[];
  env?: EnvSource;
  config: RemoteBuddyRuntimeLoaderConfig;
};

export function loadRemoteBuddyRuntimeOptions({
  argv = process.argv.slice(2),
  env = process.env,
  config,
}: LoadRemoteBuddyRuntimeOptionsParams): RemoteBuddyRuntimeOptions {
  const args = [...argv];
  let cliServer: string | null = null;
  let cliSession: string | null = null;
  let cliSessionProvided = false;
  let cliToken: string | null = null;
  let cliTokenProvided = false;
  const passthroughArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      passthroughArgs.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      throw new Error(
        `Unexpected positional argument "${arg}". Use \"--\" to pass through additional args.`,
      );
    }

    const { flag, inlineValue } = splitFlag(arg);
    switch (flag) {
      case "--server": {
        const raw = inlineValue ?? args[++i];
        ensureHasValue(flag, raw);
        cliServer = requireNonBlank(flag, raw!);
        break;
      }
      case "--session":
      case "--sessionId": {
        const raw = inlineValue ?? args[++i];
        ensureHasValue(flag, raw);
        cliSessionProvided = true;
        cliSession = normalizeNullable(raw!);
        break;
      }
      case "--token": {
        const raw = inlineValue ?? args[++i];
        ensureHasValue(flag, raw);
        cliTokenProvided = true;
        cliToken = requireNonBlank(flag, raw!);
        break;
      }
      default: {
        throw new Error(
          `Unknown flag \"${flag}\". Valid flags: --server, --sessionId (--session), --token.`,
        );
      }
    }
  }

  const server =
    cliServer ??
    firstNonEmpty(env.PUSHPALS_SERVER_URL, env.PUSHPALS_URL) ??
    normalizeNullable(config.server?.url);
  if (!server) {
    throw new Error(
      "RemoteBuddy requires a server URL. Provide --server, set PUSHPALS_SERVER_URL/PUSHPALS_URL, or configure server.url.",
    );
  }

  const sessionId = cliSessionProvided
    ? cliSession
    : firstNonEmpty(env.PUSHPALS_SESSION_ID, config.sessionId);

  const authToken =
    (cliTokenProvided ? cliToken : null) ??
    firstNonEmpty(env.PUSHPALS_AUTH_TOKEN, env.AUTH_TOKEN, config.authToken ?? undefined);

  return {
    server,
    sessionId,
    authToken,
    passthroughArgs,
  };
}

type ConnectWithRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
};

export async function connectWithRetry(
  server: string,
  sessionId?: string,
  {
    maxRetries = Infinity,
    baseDelayMs = 2_000,
    maxDelayMs = 30_000,
    fetchFn = fetch,
    sleepFn = (ms: number) => Bun.sleep(ms),
  }: ConnectWithRetryOptions = {},
): Promise<string> {
  if (!server || !server.trim()) {
    throw new Error("connectWithRetry requires a server URL.");
  }
  const normalizedServer = server.trim().replace(/\/+$/, "");
  const effectiveMaxRetries =
    Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : Infinity;
  const payloadSession = normalizeNullable(sessionId ?? undefined);

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const res = await fetchFn(`${normalizedServer}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadSession ? { sessionId: payloadSession } : {}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { sessionId?: string };
      const received = normalizeNullable(data.sessionId ?? null);
      if (!received) {
        throw new Error("Server response did not include sessionId.");
      }
      return received;
    } catch (err: any) {
      if (attempt >= effectiveMaxRetries) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.log(
        `[RemoteBuddy] Server unavailable (${err?.message ?? err}), retrying in ${(delay / 1000).toFixed(
          1,
        )} s... (attempt ${attempt})`,
      );
      await sleepFn(delay);
    }
  }
}

function splitFlag(arg: string): { flag: string; inlineValue?: string } {
  const eqIdx = arg.indexOf("=");
  if (eqIdx === -1) return { flag: arg };
  return {
    flag: arg.slice(0, eqIdx),
    inlineValue: arg.slice(eqIdx + 1),
  };
}

function ensureHasValue(flag: string, value: string | undefined): void {
  if (value === undefined) {
    throw new Error(`Flag \"${flag}\" requires a value.`);
  }
}

function normalizeNullable(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = `${raw}`.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireNonBlank(flag: string, raw: string): string {
  const normalized = normalizeNullable(raw);
  if (!normalized) {
    throw new Error(`Flag \"${flag}\" requires a non-empty value.`);
  }
  return normalized;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const normalized = normalizeNullable(value);
    if (normalized) return normalized;
  }
  return null;
}
