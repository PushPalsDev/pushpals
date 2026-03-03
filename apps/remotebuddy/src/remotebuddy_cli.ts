export interface RemoteBuddyRunOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
}

export type CliHelpFlag = "--help" | "-h";
export type CliVersionFlag = "--version" | "-V";

export type RemoteBuddyCliCommand =
  | { mode: "help"; flag: CliHelpFlag }
  | { mode: "version"; flag: CliVersionFlag }
  | { mode: "run"; options: RemoteBuddyRunOptions };

export class CliUsageError extends Error {}

export function requireFlagValue(flag: string, value: string | undefined): string {
  if (value == null || value === "") {
    throw new CliUsageError(`Flag ${flag} requires a value.`);
  }
  if (value.startsWith("-")) {
    throw new CliUsageError(
      `Flag ${flag} requires a value, but received another flag-like token "${value}".`,
    );
  }
  return value;
}

export function parseCliCommand(
  argv: string[],
  defaults: RemoteBuddyRunOptions,
): RemoteBuddyCliCommand {
  let server = defaults.server;
  let sessionId = defaults.sessionId;
  let authToken = defaults.authToken;
  let helpFlag: CliHelpFlag | null = null;
  let versionFlag: CliVersionFlag | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      helpFlag = token;
      break;
    }
    if (token === "--version" || token === "-V") {
      versionFlag = token;
      break;
    }
    switch (token) {
      case "--server": {
        const value = requireFlagValue(token, argv[++i]);
        server = value;
        break;
      }
      case "--sessionId": {
        const value = requireFlagValue(token, argv[++i]);
        sessionId = value;
        break;
      }
      case "--token": {
        const value = requireFlagValue(token, argv[++i]);
        authToken = value;
        break;
      }
      default:
        throw new CliUsageError(`Unknown flag ${token}`);
    }
  }

  if (helpFlag) return { mode: "help", flag: helpFlag };
  if (versionFlag) return { mode: "version", flag: versionFlag };
  return { mode: "run", options: { server, sessionId, authToken } };
}

export interface CliDispatchHandlers {
  showHelp: (flag: CliHelpFlag) => void;
  showVersion: (flag: CliVersionFlag) => void;
  runStartupGuard: (options: RemoteBuddyRunOptions) => Promise<boolean>;
  launchOrchestrator: (options: RemoteBuddyRunOptions) => Promise<void>;
}

export async function dispatchCliCommand(
  command: RemoteBuddyCliCommand,
  handlers: CliDispatchHandlers,
): Promise<void> {
  if (command.mode === "help") {
    handlers.showHelp(command.flag);
    return;
  }
  if (command.mode === "version") {
    handlers.showVersion(command.flag);
    return;
  }
  const guardOk = await handlers.runStartupGuard(command.options);
  if (!guardOk) return;
  await handlers.launchOrchestrator(command.options);
}
