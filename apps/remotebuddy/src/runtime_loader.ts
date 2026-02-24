import { loadPushPalsConfig, type PushPalsConfig } from "shared";

export interface RuntimeLoaderOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  config?: PushPalsConfig;
}

export interface RuntimeBootstrap {
  config: PushPalsConfig;
  server: string;
  sessionId: string | null;
  authToken: string | null;
  workerPassthroughArgs: string[];
}

export function loadRuntime(options: RuntimeLoaderOptions = {}): RuntimeBootstrap {
  const config = options.config ?? loadPushPalsConfig();
  const env = options.env ?? process.env;
  const rawArgv = options.argv ?? process.argv.slice(2);
  const { cliArgs, passthroughArgs } = splitArgv(rawArgv);
  const cliOverrides = parseCliArgs(cliArgs);

  const envServer = readEnvString(env.PUSHPALS_SERVER_URL);
  const envSession = readEnvString(env.PUSHPALS_SESSION_ID);
  const envAuth = readEnvAuthToken(env);

  const server = (cliOverrides.server ?? envServer ?? config.server.url ?? "").trim();
  if (!server) {
    throw new Error(
      "Server URL is required (configure via config.server.url, PUSHPALS_SERVER_URL, or --server)",
    );
  }

  const sessionIdRaw = cliOverrides.sessionId ?? envSession ?? config.sessionId ?? "";
  const sessionId = sessionIdRaw.trim() || null;
  const authToken = resolveAuthToken(cliOverrides.authToken, envAuth, config.authToken);

  return {
    config,
    server,
    sessionId,
    authToken,
    workerPassthroughArgs: [...passthroughArgs],
  };
}

function splitArgv(args: string[]): { cliArgs: string[]; passthroughArgs: string[] } {
  const idx = args.indexOf("--");
  if (idx === -1) {
    return { cliArgs: [...args], passthroughArgs: [] };
  }
  return {
    cliArgs: args.slice(0, idx),
    passthroughArgs: args.slice(idx + 1),
  };
}

type CliOverrides = {
  server?: string;
  sessionId?: string;
  authToken?: string;
};

function parseCliArgs(args: string[]): CliOverrides {
  const overrides: CliOverrides = {};
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    const eqIndex = token.indexOf("=");
    const flag = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    const inlineValue = eqIndex >= 0 ? token.slice(eqIndex + 1) : undefined;

    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${token}"`);
    }

    switch (flag) {
      case "--server": {
        const { value, consumed } = consumeValue(args, i, inlineValue, flag);
        overrides.server = requireNonEmpty(value, flag);
        i += consumed + 1;
        break;
      }
      case "--sessionId": {
        const { value, consumed } = consumeValue(args, i, inlineValue, flag);
        overrides.sessionId = requireNonEmpty(value, flag);
        i += consumed + 1;
        break;
      }
      case "--token":
      case "--authToken": {
        const { value, consumed } = consumeValue(args, i, inlineValue, flag);
        overrides.authToken = requireNonEmpty(value, flag);
        i += consumed + 1;
        break;
      }
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }
  return overrides;
}

function consumeValue(
  args: string[],
  index: number,
  inlineValue: string | undefined,
  flag: string,
): { value: string; consumed: number } {
  if (inlineValue !== undefined) {
    return { value: inlineValue, consumed: 0 };
  }
  const nextIndex = index + 1;
  if (nextIndex >= args.length) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: args[nextIndex], consumed: 1 };
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${flag} cannot be blank`);
  }
  return trimmed;
}

function readEnvString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readEnvAuthToken(env: Record<string, string | undefined>): string | null | undefined {
  if (env.PUSHPALS_AUTH_TOKEN !== undefined) {
    const trimmed = env.PUSHPALS_AUTH_TOKEN.trim();
    return trimmed ? trimmed : null;
  }
  if (env.AUTH_TOKEN !== undefined) {
    const trimmed = env.AUTH_TOKEN.trim();
    return trimmed ? trimmed : null;
  }
  return undefined;
}

function resolveAuthToken(
  cliValue: string | undefined,
  envValue: string | null | undefined,
  configValue: string | null,
): string | null {
  if (cliValue !== undefined) {
    return cliValue;
  }
  if (envValue !== undefined) {
    return envValue;
  }
  const trimmed = (configValue ?? "").trim();
  return trimmed || null;
}
