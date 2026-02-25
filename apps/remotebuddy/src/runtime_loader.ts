import { loadPushPalsConfig, type PushPalsConfig } from "shared";

export interface RemoteBuddyRuntimeOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthroughArgs: string[];
}

export interface RuntimeLoaderInit {
  argv?: string[];
  env?: Record<string, string | undefined>;
  config?: PushPalsConfig;
}

type CliOverrides = {
  server?: string;
  sessionId?: string | null;
  authToken?: string;
};

type CliParseResult = {
  overrides: CliOverrides;
  passthrough: string[];
};

export function loadRuntimeOptions(init: RuntimeLoaderInit = {}): RemoteBuddyRuntimeOptions {
  const config = init.config ?? loadPushPalsConfig();
  const env = init.env ?? process.env;
  const argv = init.argv ?? process.argv.slice(2);

  const { overrides, passthrough } = parseCliArgs(argv);

  let server = selectServer(config, env);
  let sessionId = selectSessionId(config, env);
  let authToken = selectAuthToken(config, env);

  if (overrides.server !== undefined) {
    server = overrides.server;
  }
  if (overrides.sessionId !== undefined) {
    sessionId = overrides.sessionId;
  }
  if (overrides.authToken !== undefined) {
    authToken = overrides.authToken;
  }

  return {
    server,
    sessionId,
    authToken,
    passthroughArgs: passthrough,
  };
}

function selectServer(config: PushPalsConfig, env: Record<string, string | undefined>): string {
  const envServer = env["PUSHPALS_SERVER_URL"];
  if (envServer !== undefined) {
    const normalized = normalizeNonEmpty(envServer);
    if (normalized) {
      return normalized;
    }
  }
  return normalizeNonEmpty(config.server.url) ?? config.server.url;
}

function selectSessionId(
  config: PushPalsConfig,
  env: Record<string, string | undefined>,
): string | null {
  const envSession = env["PUSHPALS_SESSION_ID"];
  if (envSession !== undefined) {
    return normalizeSessionValue(envSession);
  }
  return normalizeSessionValue(config.sessionId);
}

function selectAuthToken(
  config: PushPalsConfig,
  env: Record<string, string | undefined>,
): string | null {
  const envToken = env["PUSHPALS_AUTH_TOKEN"];
  if (envToken !== undefined) {
    return normalizeOptional(envToken);
  }
  return normalizeOptional(config.authToken);
}

function parseCliArgs(argv: string[]): CliParseResult {
  const overrides: CliOverrides = {};
  const dividerIndex = argv.indexOf("--");
  const args = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv.slice();
  const passthrough = dividerIndex >= 0 ? argv.slice(dividerIndex + 1) : [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("-")) {
      throw new Error(`Unexpected positional argument "${token}"`);
    }
    switch (token) {
      case "--server": {
        const value = nextFlagValue(args, ++i, token);
        overrides.server = requireNonEmpty(value, token);
        break;
      }
      case "--sessionId": {
        const value = nextFlagValue(args, ++i, token);
        overrides.sessionId = normalizeSessionValue(value);
        break;
      }
      case "--token": {
        const value = nextFlagValue(args, ++i, token);
        const trimmed = value.trim();
        if (!trimmed) {
          throw new Error("Flag --token requires a non-empty value.");
        }
        overrides.authToken = trimmed;
        break;
      }
      case "":
        throw new Error("Received empty argument.");
      default:
        throw new Error(`Unknown flag ${token}`);
    }
  }

  return { overrides, passthrough };
}

function nextFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeSessionValue(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function requireNonEmpty(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Flag ${flag} requires a non-empty value.`);
  }
  return trimmed;
}
