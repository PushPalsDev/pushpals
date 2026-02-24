import { loadPushPalsConfig, type PushPalsConfig } from "shared";

export interface RemoteBuddyRuntime {
  config: PushPalsConfig;
  serverUrl: string;
  sessionId: string | null;
  authToken: string | null;
}

export interface RemoteBuddyRuntimeOptions {
  /**
   * Optional argv list. Defaults to the process argv slice.
   */
  args?: string[];
  /**
   * Optional env map (mainly for tests). Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Force config reload (passed to shared loader).
   */
  reloadConfig?: boolean;
  /**
   * Override project root passed to shared config loader.
   */
  projectRoot?: string;
  /**
   * Override config dir passed to shared config loader.
   */
  configDir?: string;
  /**
   * Inject a pre-built config (skips loader). Helpful for tests.
   */
  config?: PushPalsConfig;
}

interface RuntimeOverrides {
  server?: string;
  sessionId?: string;
  authToken?: string | null;
}

const SERVER_ENV = "PUSHPALS_SERVER_URL";
const SESSION_ENV = "PUSHPALS_SESSION_ID";
const AUTH_ENV = "PUSHPALS_AUTH_TOKEN";

export function loadRemoteBuddyRuntime(
  options: RemoteBuddyRuntimeOptions = {},
): RemoteBuddyRuntime {
  const {
    args = process.argv.slice(2),
    env = process.env,
    reloadConfig = false,
    projectRoot,
    configDir,
    config: providedConfig,
  } = options;

  const config =
    providedConfig ??
    loadPushPalsConfig({
      projectRoot,
      configDir,
      reload: reloadConfig,
    });

  const cli = parseCliArgs(args);
  const envServer = getEnvString(env, SERVER_ENV);
  const envSession = getEnvString(env, SESSION_ENV);
  const envToken = getEnvString(env, AUTH_ENV);

  const serverUrl = firstDefined(cli.server, envServer) ?? config.server.url;
  const sessionId = firstDefined(cli.sessionId, envSession) ?? config.sessionId ?? null;
  const authToken = normalizeOptional(
    firstDefined(cli.authToken, envToken) ?? config.authToken ?? undefined,
  );

  return {
    config,
    serverUrl,
    sessionId,
    authToken,
  };
}

function parseCliArgs(args: string[]): RuntimeOverrides {
  const overrides: RuntimeOverrides = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--server":
        overrides.server = consumeNext(args, i);
        i += 1;
        break;
      case "--sessionId":
        overrides.sessionId = consumeNext(args, i);
        i += 1;
        break;
      case "--token":
        overrides.authToken = consumeNext(args, i) ?? null;
        i += 1;
        break;
      default:
        break;
    }
  }
  return overrides;
}

function consumeNext(args: string[], currentIndex: number): string | undefined {
  if (currentIndex + 1 >= args.length) return undefined;
  return args[currentIndex + 1];
}

function getEnvString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined) return null;
  return value;
}
