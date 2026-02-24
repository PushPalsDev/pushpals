export interface RemotebuddyRuntimeDefaults {
  server?: string | null;
  sessionId?: string | null;
  authToken?: string | null;
}

export interface RemotebuddyRuntimeLoaderInit {
  argv?: string[];
  env?: Record<string, string | undefined>;
  defaults?: RemotebuddyRuntimeDefaults;
}

export interface RemotebuddyRuntimeOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  passthrough: string[];
}

export class RemotebuddyRuntimeOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotebuddyRuntimeOptionsError";
  }
}

function sanitize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function coalesceServer(
  defaults: RemotebuddyRuntimeDefaults | undefined,
  env: Record<string, string | undefined>,
): string {
  const fromDefaults = sanitize(defaults?.server);
  const fromEnv = sanitize(env.PUSHPALS_SERVER_URL);
  const server = fromEnv || fromDefaults;
  if (server) return server;
  return "http://localhost:3001";
}

function coalesceSessionId(
  defaults: RemotebuddyRuntimeDefaults | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const fromDefaults = sanitize(defaults?.sessionId);
  const fromEnv = sanitize(env.PUSHPALS_SESSION_ID);
  const value = fromEnv || fromDefaults;
  return value || null;
}

function coalesceAuthToken(
  defaults: RemotebuddyRuntimeDefaults | undefined,
  env: Record<string, string | undefined>,
): string | null {
  const fromDefaults = sanitize(defaults?.authToken);
  const fromEnv = sanitize(env.PUSHPALS_AUTH_TOKEN);
  const value = fromEnv || fromDefaults;
  return value || null;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new RemotebuddyRuntimeOptionsError(`Missing value for ${flag}.`);
  }
  return value;
}

export function loadRemotebuddyRuntimeOptions(
  init: RemotebuddyRuntimeLoaderInit = {},
): RemotebuddyRuntimeOptions {
  const argv = [...(init.argv ?? process.argv.slice(2))];
  const env = init.env ?? process.env;
  const defaults = init.defaults;

  let server = coalesceServer(defaults, env);
  let sessionId = coalesceSessionId(defaults, env);
  let authToken = coalesceAuthToken(defaults, env);
  const passthrough: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      throw new RemotebuddyRuntimeOptionsError(
        `Unexpected positional argument "${arg}". RemoteBuddy only accepts --server, --sessionId, and --token.`,
      );
    }

    const eqIndex = arg.indexOf("=");
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    let inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);

    switch (flag) {
      case "--server": {
        if (inlineValue === undefined) {
          const next = argv[index + 1];
          const nextInvalid = typeof next !== "string" || next.startsWith("--");
          if (nextInvalid) {
            inlineValue = undefined;
          } else {
            index += 1;
            inlineValue = next;
          }
        }
        const value = sanitize(requireValue("--server", inlineValue));
        if (!value) {
          throw new RemotebuddyRuntimeOptionsError("--server value cannot be blank.");
        }
        server = value;
        break;
      }
      case "--sessionId": {
        if (inlineValue === undefined) {
          const next = argv[index + 1];
          const nextInvalid = typeof next !== "string" || next.startsWith("--");
          if (nextInvalid) {
            inlineValue = undefined;
          } else {
            index += 1;
            inlineValue = next;
          }
        }
        const raw = sanitize(requireValue("--sessionId", inlineValue));
        sessionId = raw || null;
        break;
      }
      case "--token": {
        if (inlineValue === undefined) {
          const next = argv[index + 1];
          const nextInvalid = typeof next !== "string" || next.startsWith("--");
          if (nextInvalid) {
            inlineValue = undefined;
          } else {
            index += 1;
            inlineValue = next;
          }
        }
        const value = sanitize(requireValue("--token", inlineValue));
        if (!value) {
          throw new RemotebuddyRuntimeOptionsError(
            "--token value cannot be blank; omit the flag to use the config/env token or run without auth.",
          );
        }
        authToken = value;
        break;
      }
      default: {
        throw new RemotebuddyRuntimeOptionsError(
          `Unknown flag "${flag}". RemoteBuddy only accepts --server, --sessionId, and --token.`,
        );
      }
    }

    index += 1;
  }

  return { server, sessionId, authToken, passthrough };
}
