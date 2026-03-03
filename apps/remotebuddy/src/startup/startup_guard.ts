import {
  buildSystemPreflightContext,
  createServerSyntheticTester,
  describeRepoStatus,
  ensureSystemPreflight,
  listFiringAlertsFromEnv,
  type SystemPreflightContext,
  type SystemPreflightOptions,
  type SystemPreflightResult,
} from "./system_preflight.js";
import type { StartupCheckRecord } from "./checklist.js";

const HELP_HEADER = "RemoteBuddy Startup";

type CliCommand = "run" | "help" | "version";

export interface RemoteBuddyCliDefaults {
  server: string;
  sessionId: string | null;
  authToken: string | null;
  allowDirtyWorktree?: boolean;
}

export interface RemoteBuddyLaunchOptions {
  server: string;
  sessionId: string | null;
  authToken: string | null;
}

export interface RemoteBuddyCliFlags extends RemoteBuddyLaunchOptions {
  skipPreflight: boolean;
  preflightOnly: boolean;
  allowDirtyWorktree: boolean;
}

export interface StartupGuardIO {
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
}

export interface StartupGuardPreflightHooks {
  ensure?: (
    ctx: SystemPreflightContext,
    options?: SystemPreflightOptions,
  ) => Promise<SystemPreflightResult>;
  contextFactory?: (
    cli: RemoteBuddyCliFlags,
    env: NodeJS.ProcessEnv,
    io: Required<StartupGuardIO>,
  ) => Promise<SystemPreflightContext>;
}

export interface GuardStartupAndLaunchParams {
  argv?: string[];
  version: string;
  defaults: RemoteBuddyCliDefaults;
  env?: NodeJS.ProcessEnv;
  io?: StartupGuardIO;
  preflight?: StartupGuardPreflightHooks;
  run: (opts: RemoteBuddyLaunchOptions) => Promise<void>;
}

export async function guardStartupAndLaunchRemoteBuddy(
  params: GuardStartupAndLaunchParams,
): Promise<void> {
  const argv = params.argv ?? process.argv.slice(2);
  const env = params.env ?? process.env;
  const stdio: Required<StartupGuardIO> = {
    stdout: params.io?.stdout ?? process.stdout,
    stderr: params.io?.stderr ?? process.stderr,
  };

  const parsed = parseCli(argv, params.defaults);

  if (parsed.command === "help") {
    stdio.stdout.write(buildHelpMessage(params.version, params.defaults));
    return;
  }

  if (parsed.command === "version") {
    stdio.stdout.write(`${params.version}\n`);
    return;
  }

  const cli = parsed.options;
  const contextFactory =
    params.preflight?.contextFactory ??
    (async (
      flags: RemoteBuddyCliFlags,
      envInput: NodeJS.ProcessEnv = env,
      ioInput: Required<StartupGuardIO> = stdio,
    ) =>
      buildSystemPreflightContext({
        describeRepo: () => describeRepoStatus(),
        listFiringAlerts: listFiringAlertsFromEnv(envInput),
        syntheticTester: createServerSyntheticTester({ server: flags.server }),
        log: (record) => logStartupRecord(record, ioInput),
      }));
  const ensure = params.preflight?.ensure ?? ensureSystemPreflight;

  if (cli.preflightOnly && cli.skipPreflight) {
    throw new Error("--preflight-only cannot be combined with --skip-preflight");
  }

  if (!cli.skipPreflight) {
    stdio.stdout.write("[startup] Running RemoteBuddy system preflight...\n");
    const ctx = await contextFactory(cli, env, stdio);
    await ensure(ctx, { allowDirtyWorktree: cli.allowDirtyWorktree });
    stdio.stdout.write("[startup] System preflight passed.\n");
    if (cli.preflightOnly) {
      return;
    }
  } else {
    stdio.stderr.write("[startup] WARN: Startup preflight skipped via --skip-preflight.\n");
    if (cli.preflightOnly) {
      return;
    }
  }

  await params.run({
    server: cli.server,
    sessionId: cli.sessionId,
    authToken: cli.authToken,
  });
}

function parseCli(
  argv: string[],
  defaults: RemoteBuddyCliDefaults,
): { command: CliCommand; options: RemoteBuddyCliFlags } {
  let command: CliCommand = "run";
  let server = trimOrNull(defaults.server);
  let sessionId = trimOrNull(defaults.sessionId);
  let authToken = trimOrNull(defaults.authToken);
  let skipPreflight = false;
  let preflightOnly = false;
  let allowDirtyWorktree = Boolean(defaults.allowDirtyWorktree);

  const args = [...argv];

  const requireValue = (label: string, raw: string | undefined): string => {
    if (raw === undefined) {
      throw new Error(`Missing value for ${label}`);
    }
    if (/^-{1,2}[A-Za-z0-9]/.test(raw)) {
      throw new Error(`Expected value for ${label}, but received flag-like token "${raw}".`);
    }
    const value = raw.trim();
    if (!value) {
      throw new Error(`Value for ${label} cannot be empty.`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      command = "help";
      break;
    }
    if (arg === "--version" || arg === "-v" || arg === "-V") {
      command = "version";
      break;
    }
    if (arg === "--skip-preflight") {
      skipPreflight = true;
      continue;
    }
    if (arg === "--preflight-only") {
      preflightOnly = true;
      continue;
    }
    if (arg === "--allow-dirty-worktree") {
      allowDirtyWorktree = true;
      continue;
    }
    if (arg === "--no-allow-dirty-worktree") {
      allowDirtyWorktree = false;
      continue;
    }
    if (arg === "--server" || arg.startsWith("--server=")) {
      const value =
        arg === "--server" ? requireValue("--server", args[++i]) : arg.slice("--server=".length);
      server = value.trim();
      continue;
    }
    if (arg === "--sessionId" || arg.startsWith("--sessionId=")) {
      const value =
        arg === "--sessionId"
          ? requireValue("--sessionId", args[++i])
          : arg.slice("--sessionId=".length);
      sessionId = value.trim();
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      const value =
        arg === "--token" ? requireValue("--token", args[++i]) : arg.slice("--token=".length);
      authToken = value.trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!server) {
    throw new Error("Server URL must be provided via config or --server.");
  }

  validateServerUrl(server);

  return {
    command,
    options: {
      server,
      sessionId,
      authToken,
      skipPreflight,
      preflightOnly,
      allowDirtyWorktree,
    },
  };
}

function validateServerUrl(server: string): void {
  try {
    new URL(server);
  } catch {
    throw new Error(`Invalid server URL: ${server}`);
  }
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildHelpMessage(version: string, defaults: RemoteBuddyCliDefaults): string {
  const defaultSession = defaults.sessionId ?? "(config)";
  const defaultServer = defaults.server || "(config)";
  return `${HELP_HEADER} v${version}\n\n` +
    `Usage:\n` +
    `  bun run src/remotebuddy_main.ts [options]\n\n` +
    `Options:\n` +
    `  --server <url>                Remote PushPals server URL (default: ${defaultServer})\n` +
    `  --sessionId <id>              Session identifier (default: ${defaultSession})\n` +
    `  --token <token>               Bearer token override (defaults to config/env).\n` +
    `  --preflight-only              Run startup preflight and exit.\n` +
    `  --skip-preflight              Bypass startup preflight guard (not recommended).\n` +
    `  --allow-dirty-worktree        Permit dirty git worktree during preflight.\n` +
    `  --no-allow-dirty-worktree     Require clean worktree even if config allows dirty.\n` +
    `  -h, --help                    Show this help message and exit.\n` +
    `  -v, --version                 Show version information and exit.\n`;
}

function logStartupRecord(record: StartupCheckRecord, io: Required<StartupGuardIO>): void {
  const target = record.status === "fail" ? io.stderr : io.stdout;
  const prefix = `[startup:${record.category}]`;
  target.write(
    `${prefix} step=${record.step} ${record.status.toUpperCase()} ${record.code} -> ${record.detail}\n`,
  );
  if (record.status === "fail" && record.action) {
    target.write(`${prefix} action: ${record.action}\n`);
  }
}
