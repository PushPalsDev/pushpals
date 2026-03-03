import type { StartupCheckRecord, StartupChecklistResult } from "./startup/checklist";

export interface RemoteBuddyLaunchOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
}

type StartupGuardInvoker = (options: {
  repoRoot: string;
  serverUrl: string;
  authToken: string | null;
  allowDirtyWorktree: boolean;
  log?: (entry: StartupCheckRecord) => void;
}) => Promise<StartupChecklistResult>;

type RemoteBuddyCliCommand =
  | { type: "help" }
  | { type: "version" }
  | {
      type: "run";
      options: RemoteBuddyLaunchOptions;
      skipGuard: boolean;
      allowDirtyWorktree: boolean;
    };

export interface RemoteBuddyCliRuntimeOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  version?: string;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  guard?: StartupGuardInvoker;
  launch?: (options: RemoteBuddyLaunchOptions) => Promise<void>;
  detectRepoRoot?: () => string;
  defaults?: RemoteBuddyLaunchOptions;
}

export interface RemoteBuddyCliRunState {
  ok: boolean;
  code: number;
  detail?: string;
}

export interface RemoteBuddyCliRuntime {
  run(): Promise<RemoteBuddyCliRunState>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function createRemoteBuddyCliRuntime(
  options: RemoteBuddyCliRuntimeOptions = {},
): RemoteBuddyCliRuntime {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const guardImpl = options.guard ?? (async () => ({ ok: true, history: [] }));
  const launcher = options.launch ?? (async () => {});
  const version = resolveRuntimeVersion(options.version, env);
  const detectRepo = options.detectRepoRoot ?? (() => process.cwd());
  const defaults: RemoteBuddyLaunchOptions = options.defaults ?? {
    server: "",
    sessionId: null,
    authToken: null,
  };

  return {
    async run(): Promise<RemoteBuddyCliRunState> {
      try {
        const parsed = parseRemoteBuddyCliCommand(argv, env, defaults);
        if (parsed.type === "help") {
          stdout.write(buildHelpText(version));
          return { ok: true, code: 0 };
        }
        if (parsed.type === "version") {
          stdout.write(`${version}\n`);
          return { ok: true, code: 0 };
        }

        const { options: launchOptions, skipGuard, allowDirtyWorktree } = parsed;
        if (!skipGuard) {
          const guardResult = await guardImpl({
            repoRoot: detectRepo(),
            serverUrl: launchOptions.server,
            authToken: launchOptions.authToken,
            allowDirtyWorktree,
            log: (entry) => stdout.write(formatStartupCheckRecord(entry)),
          });
          if (!guardResult.ok) {
            const failureMessage = describeStartupFailure(guardResult);
            stderr.write(`${failureMessage}\n`);
            if (guardResult.failure?.action) {
              stderr.write(`[RemoteBuddy] Action: ${guardResult.failure.action}\n`);
            }
            return { ok: false, code: 2, detail: failureMessage };
          }
        } else {
          stdout.write("[RemoteBuddy] Startup guard skipped via PUSHPALS_SKIP_STARTUP_PREFLIGHT.\n");
        }

        await launcher(launchOptions);
        return { ok: true, code: 0 };
      } catch (error) {
        if (error instanceof CliUsageError) {
          stderr.write(`[RemoteBuddy] ${error.message}\n`);
          return { ok: false, code: 64, detail: error.message };
        }
        stderr.write(`[RemoteBuddy] Fatal: ${String(error)}\n`);
        return {
          ok: false,
          code: 1,
          detail: error instanceof Error ? error.message : undefined,
        };
      }
    },
  };
}

function parseRemoteBuddyCliCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  defaults: RemoteBuddyLaunchOptions,
): RemoteBuddyCliCommand {
  let server = defaults.server;
  let sessionId: string | null = defaults.sessionId;
  let authToken: string | null = defaults.authToken;
  let allowDirtyWorktree = parseBooleanEnv(env.REMOTEBUDDY_ALLOW_DIRTY_WORKTREE);
  const skipGuard = parseBooleanEnv(env.PUSHPALS_SKIP_STARTUP_PREFLIGHT);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { type: "help" };
    if (arg === "--version" || arg === "-v") return { type: "version" };

    const serverMatch = matchOptionFlag(arg, "--server");
    if (serverMatch) {
      if (serverMatch.inline) {
        server = serverMatch.value ?? "";
      } else {
        const { value, nextIndex } = readExplicitFlagValue(argv, i, "--server");
        server = value;
        i = nextIndex;
      }
      continue;
    }

    const sessionMatch = matchOptionFlag(arg, "--sessionId");
    if (sessionMatch) {
      if (sessionMatch.inline) {
        sessionId = sessionMatch.value ?? null;
      } else {
        const { value, nextIndex } = readExplicitFlagValue(argv, i, "--sessionId");
        sessionId = value ?? null;
        i = nextIndex;
      }
      continue;
    }

    const tokenMatch = matchOptionFlag(arg, "--token");
    if (tokenMatch) {
      if (tokenMatch.inline) {
        authToken = tokenMatch.value ?? null;
      } else {
        const { value, nextIndex } = readExplicitFlagValue(argv, i, "--token");
        authToken = value ?? null;
        i = nextIndex;
      }
      continue;
    }

    if (arg === "--allowDirtyWorktree") {
      allowDirtyWorktree = true;
      continue;
    }
    if (arg === "--no-allowDirtyWorktree") {
      allowDirtyWorktree = false;
      continue;
    }

    if (arg === "--") {
      throw new CliUsageError("Positional arguments are not supported.");
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown flag: ${arg}`);
    }
    throw new CliUsageError(`Unexpected argument: ${arg}`);
  }

  return {
    type: "run",
    options: { server, sessionId, authToken },
    skipGuard,
    allowDirtyWorktree,
  };
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function matchOptionFlag(arg: string, name: string): { inline: boolean; value?: string } | null {
  if (arg === name) return { inline: false };
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    return { inline: true, value: arg.slice(prefix.length) };
  }
  return null;
}

function readExplicitFlagValue(
  argv: string[],
  currentIndex: number,
  flagName: string,
): { value: string; nextIndex: number } {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= argv.length) {
    throw new CliUsageError(`${flagName} requires a value.`);
  }
  const value = argv[nextIndex];
  if (typeof value !== "string") {
    throw new CliUsageError(`${flagName} requires a value.`);
  }
  return { value, nextIndex };
}

function buildHelpText(version: string): string {
  return [
    `PushPals RemoteBuddy v${version}`,
    "Usage: bun run src/remotebuddy_main.ts [options]",
    "",
    "Options:",
    "  --server <url>           Override server URL.",
    "  --sessionId <id>         Override session identifier.",
    "  --token <value>          Override auth token.",
    "  --allowDirtyWorktree     Allow startup guard to pass with a dirty repo.",
    "  --no-allowDirtyWorktree  Force guard to require clean repo.",
    "  -h, --help               Show this help text.",
    "  -v, --version            Print the RemoteBuddy version.",
    "",
    "Environment variables:",
    "  PUSHPALS_SKIP_STARTUP_PREFLIGHT=1  Skip the startup guard (not recommended).",
    "  REMOTEBUDDY_ALLOW_DIRTY_WORKTREE=1 Allow dirty worktree during startup guard.",
    "",
  ].join("\n");
}

function formatStartupCheckRecord(record: StartupCheckRecord): string {
  const status = record.status === "pass" ? "PASS" : "FAIL";
  const detail = record.detail ? ` - ${record.detail}` : "";
  return `[RemoteBuddy] [startup step=${record.step} code=${record.code}] ${status}: ${record.label}${detail}\n`;
}

function describeStartupFailure(result: StartupChecklistResult): string {
  const failure = result.failure;
  if (!failure) return "[RemoteBuddy] Startup preflight failed.";
  return `[RemoteBuddy] Startup preflight failed at step ${failure.step} (${failure.code}): ${failure.detail}`;
}

function resolveRuntimeVersion(
  explicitVersion: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const normalizedExplicit = normalizeVersionText(explicitVersion);
  const normalizedEnv = normalizeVersionText(env.REMOTEBUDDY_VERSION);
  const resolved = normalizedExplicit ?? normalizedEnv;
  if (resolved) return resolved;
  throw new Error(
    "RemoteBuddy CLI runtime requires version metadata. Provide options.version or set REMOTEBUDDY_VERSION.",
  );
}

function normalizeVersionText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
