type RuntimeDefaults = {
  serverUrl: string;
  sessionId: string | null;
  authToken: string | null;
};

export type ParsedRuntimeOptions = {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  workerPassthroughArgs: string[];
};

type ProcessEnv = NodeJS.ProcessEnv;

const SERVER_ENV_KEYS = ["REMOTEBUDDY_SERVER_URL", "REMOTEBUDDY_SERVER"];
const SESSION_ENV_KEYS = ["REMOTEBUDDY_SESSION_ID"];
const TOKEN_ENV_KEYS = ["REMOTEBUDDY_AUTH_TOKEN", "REMOTEBUDDY_TOKEN"];

function sanitizeNonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireServer(url: string | null): string {
  const normalized = sanitizeNonEmpty(url);
  if (!normalized) {
    throw new Error("RemoteBuddy server URL is required.");
  }
  return normalized;
}

function readEnvValue(env: ProcessEnv, keys: string[]): { provided: boolean; value: string } | null {
  for (const key of keys) {
    if (key in env) {
      return { provided: true, value: env[key] ?? "" };
    }
  }
  return null;
}

function nextValue(
  args: string[],
  index: number,
  flag: "--server" | "--sessionId" | "--token",
  { allowEmpty }: { allowEmpty: boolean },
): { value: string | null; nextIndex: number } {
  const next = args[index + 1];
  if (next === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (next === "--" || next.startsWith("-")) {
    throw new Error(`Missing value for ${flag}; received "${next}"`);
  }
  const trimmed = next.trim();
  if (!trimmed && !allowEmpty) {
    throw new Error(`Value for ${flag} cannot be empty.`);
  }
  return { value: trimmed ? trimmed : null, nextIndex: index + 2 };
}

export function parseRuntimeOptions(opts: {
  argv: string[];
  defaults: RuntimeDefaults;
  env?: ProcessEnv;
}): ParsedRuntimeOptions {
  const env = opts.env ?? process.env;
  let server = requireServer(opts.defaults.serverUrl);
  let sessionId = sanitizeNonEmpty(opts.defaults.sessionId);
  let authToken = sanitizeNonEmpty(opts.defaults.authToken);

  const serverEnv = readEnvValue(env, SERVER_ENV_KEYS);
  if (serverEnv) {
    const normalized = sanitizeNonEmpty(serverEnv.value);
    if (normalized) {
      server = normalized;
    }
  }

  const sessionEnv = readEnvValue(env, SESSION_ENV_KEYS);
  if (sessionEnv) {
    sessionId = sanitizeNonEmpty(sessionEnv.value);
  }

  const tokenEnv = readEnvValue(env, TOKEN_ENV_KEYS);
  if (tokenEnv) {
    authToken = sanitizeNonEmpty(tokenEnv.value);
  }

  const args = opts.argv.slice();
  let workerPassthroughArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      workerPassthroughArgs = args.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    switch (arg) {
      case "--server": {
        const { value, nextIndex } = nextValue(args, i, "--server", { allowEmpty: false });
        server = requireServer(value);
        i = nextIndex - 1;
        break;
      }
      case "--sessionId": {
        const { value, nextIndex } = nextValue(args, i, "--sessionId", { allowEmpty: true });
        sessionId = sanitizeNonEmpty(value);
        i = nextIndex - 1;
        break;
      }
      case "--token": {
        const { value, nextIndex } = nextValue(args, i, "--token", { allowEmpty: true });
        authToken = sanitizeNonEmpty(value);
        i = nextIndex - 1;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return {
    server,
    sessionId: sessionId ?? null,
    authToken: authToken ?? null,
    workerPassthroughArgs,
  };
}

export async function connectWithRetry(
  server: string,
  sessionId?: string | null,
  maxRetries = Infinity,
  baseDelay = 2000,
  maxDelay = 30000,
  deps?: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleepImpl = deps?.sleepImpl ?? ((ms: number) => Bun.sleep(ms));
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const res = await fetchImpl(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { sessionId: string };
      const normalized = sanitizeNonEmpty(data?.sessionId);
      if (!normalized) throw new Error("Server response missing sessionId");
      return normalized;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(
        `[RemoteBuddy] Server unavailable (${err?.message ?? String(err)}), retrying in ${(delay / 1000).toFixed(
          1,
        )} s... (attempt ${attempt})`,
      );
      await sleepImpl(delay);
    }
  }
}
