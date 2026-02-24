import { loadPushPalsConfig, type PushPalsConfig } from "shared";

const RUNTIME_PREFIX = "[RemoteBuddyRuntime]";

type OverrideSource = "config" | "env" | "cli";

export type RemoteBuddyRuntime = {
  serverUrl: string;
  sessionId: string;
  authToken: string | null;
  passthroughArgs: string[];
  sources: {
    serverUrl: OverrideSource;
    sessionId: OverrideSource;
    authToken: OverrideSource;
  };
};

export interface LoadRemoteBuddyRuntimeOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  config?: PushPalsConfig;
}

type CliOverrideAccumulator = {
  serverUrl?: string;
  sessionId?: string;
  authToken?: string | null;
};

type CliParseResult = {
  overrides: CliOverrideAccumulator;
  passthrough: string[];
};

export function loadRemoteBuddyRuntime(
  options: LoadRemoteBuddyRuntimeOptions = {},
): RemoteBuddyRuntime {
  const config = options.config ?? loadPushPalsConfig();
  const env = options.env ?? process.env;
  const argv = options.argv ?? Bun.argv.slice(2);

  const result: RemoteBuddyRuntime = {
    serverUrl: requireConfigValue("server.url", config.server.url),
    sessionId: requireConfigValue("session_id", config.sessionId),
    authToken: normalizeTokenValue(config.authToken),
    passthroughArgs: [],
    sources: {
      serverUrl: "config",
      sessionId: "config",
      authToken: "config",
    },
  };

  const envServer = readEnvOverride(env, ["REMOTEBUDDY_SERVER_URL", "PUSHPALS_SERVER_URL"]);
  if (envServer.provided && envServer.value) {
    result.serverUrl = envServer.value;
    result.sources.serverUrl = "env";
  }

  const envSession = readEnvOverride(env, ["REMOTEBUDDY_SESSION_ID", "PUSHPALS_SESSION_ID"]);
  if (envSession.provided && envSession.value) {
    result.sessionId = envSession.value;
    result.sources.sessionId = "env";
  }

  const envToken = readEnvOverride(
    env,
    ["REMOTEBUDDY_AUTH_TOKEN", "REMOTEBUDDY_TOKEN", "PUSHPALS_AUTH_TOKEN"],
    true,
  );
  if (envToken.provided) {
    result.authToken = envToken.value;
    result.sources.authToken = "env";
  }

  const parsedCli = parseCliArgs(argv);
  if (parsedCli.overrides.serverUrl) {
    result.serverUrl = parsedCli.overrides.serverUrl;
    result.sources.serverUrl = "cli";
  }
  if (parsedCli.overrides.sessionId) {
    result.sessionId = parsedCli.overrides.sessionId;
    result.sources.sessionId = "cli";
  }
  if (Object.prototype.hasOwnProperty.call(parsedCli.overrides, "authToken")) {
    result.authToken = parsedCli.overrides.authToken ?? null;
    result.sources.authToken = "cli";
  }

  result.passthroughArgs = parsedCli.passthrough;

  if (!result.serverUrl) {
    throw new Error(`${RUNTIME_PREFIX} Resolved server URL is empty.`);
  }
  if (!result.sessionId) {
    throw new Error(`${RUNTIME_PREFIX} Resolved session ID is empty.`);
  }

  return result;
}

function requireConfigValue(field: string, raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(`${RUNTIME_PREFIX} Missing required config value ${field}.`);
  }
  return value;
}

function normalizeTokenValue(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return value ? value : null;
}

function readEnvOverride(
  env: Record<string, string | undefined>,
  keys: string[],
  allowBlank = false,
): { provided: boolean; value: string | null } {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      continue;
    }
    const raw = env[key];
    if (raw == null) {
      if (allowBlank) return { provided: true, value: null };
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      if (allowBlank) return { provided: true, value: null };
      continue;
    }
    return { provided: true, value: trimmed };
  }
  return { provided: false, value: null };
}

function parseCliArgs(argv: string[]): CliParseResult {
  const overrides: CliOverrideAccumulator = {};
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      throw new Error(`${RUNTIME_PREFIX} Unexpected positional argument "${arg}".`);
    }

    if (!arg.startsWith("--")) {
      throw new Error(`${RUNTIME_PREFIX} Unknown flag "${arg}".`);
    }

    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;

    const consumeNext = (): string => {
      if (eq >= 0) {
        return arg.slice(eq + 1);
      }
      i += 1;
      if (i >= argv.length) {
        throw missingFlagValue(flag);
      }
      return argv[i];
    };

    switch (flag) {
      case "--server": {
        const value = requireNonEmptyValue(flag, consumeNext());
        overrides.serverUrl = value;
        break;
      }
      case "--sessionId": {
        const value = requireNonEmptyValue(flag, consumeNext());
        overrides.sessionId = value;
        break;
      }
      case "--token": {
        const raw = consumeNext();
        const trimmed = raw.trim();
        overrides.authToken = trimmed ? trimmed : null;
        break;
      }
      default:
        throw new Error(`${RUNTIME_PREFIX} Unknown flag "${flag}".`);
    }
  }

  return { overrides, passthrough };
}

function requireNonEmptyValue(flag: string, raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw missingFlagValue(flag);
  }
  return value;
}

function missingFlagValue(flag: string): Error {
  return new Error(`${RUNTIME_PREFIX} Flag ${flag} requires a non-empty value.`);
}
