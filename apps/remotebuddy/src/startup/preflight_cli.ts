import type {
  StartupChecklistContext,
  StartupChecklistOptions,
  StartupChecklistResult,
  StartupCheckRecord,
  SyntheticStartupTester,
} from "./checklist.js";
import { runStartupPreflight } from "./checklist.js";
import { defaultWorkspaceProbe } from "./workspace_probe.js";

export interface RunPreflightOptions extends StartupChecklistOptions {
  cwd?: string;
  describeRepo?: StartupChecklistContext["describeRepo"];
  listFiringAlerts?: StartupChecklistContext["listFiringAlerts"];
  syntheticTester?: SyntheticStartupTester;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
}

export interface RunPreflightResult {
  result: StartupChecklistResult;
  exitCode: number;
}

const defaultSyntheticTester: SyntheticStartupTester = {
  runSyntheticJob: async (options) => ({
    ok: true,
    latencyMs: 0,
    failureDetail: `synthetic probe skipped (${options.probeName})`,
  }),
};

const buildContext = (options: RunPreflightOptions): StartupChecklistContext => {
  const describeRepo =
    options.describeRepo ??
    (() => defaultWorkspaceProbe({ cwd: options.cwd }));
  const listFiringAlerts = options.listFiringAlerts ?? (async () => []);
  const syntheticTester = options.syntheticTester ?? defaultSyntheticTester;
  return {
    describeRepo,
    listFiringAlerts,
    syntheticTester,
    now: options.now,
    log: options.log,
  };
};

export const runPreflightImpl = async (
  options: RunPreflightOptions = {},
): Promise<RunPreflightResult> => {
  const ctx = buildContext(options);
  const checklistOptions: StartupChecklistOptions = {
    allowDirtyWorktree: options.allowDirtyWorktree,
    syntheticMaxLatencyMs: options.syntheticMaxLatencyMs,
    syntheticProbeName: options.syntheticProbeName,
  };
  const result = await runStartupPreflight(ctx, checklistOptions);
  return { result, exitCode: result.ok ? 0 : 1 };
};

type Writable = Pick<typeof process.stdout, "write">;

export interface RemoteBuddyPreflightCliOptions {
  args?: string[];
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
  runPreflight?: typeof runPreflightImpl;
}

const USAGE =
  "bun run remotebuddy:preflight [--allow-dirty-worktree] [--json]";

type ParsedCliFlags = {
  allowDirtyWorktree: boolean;
};

const parseCliFlags = (args: string[]): ParsedCliFlags => {
  let allowDirtyWorktree = false;
  for (const arg of args) {
    if (arg === "--allow-dirty-worktree") {
      allowDirtyWorktree = true;
    } else if (arg.startsWith("--allow-dirty-worktree=")) {
      const [, raw] = arg.split("=", 2);
      allowDirtyWorktree = ["1", "true", "yes", "on"].includes(
        (raw ?? "").toLowerCase(),
      );
    }
  }
  return { allowDirtyWorktree };
};

const serializeResult = (result: StartupChecklistResult, exitCode: number) => {
  return JSON.stringify(
    {
      ok: result.ok,
      exitCode,
      failure: result.failure ?? null,
      history: result.history,
    },
  );
};

const serializeFatalError = (error: string) =>
  JSON.stringify({
    ok: false,
    exitCode: 1,
    message: "RemoteBuddy preflight crashed unexpectedly.",
    detail: error,
    usage: USAGE,
  });

export const runRemoteBuddyPreflightCliCommand = async (
  options: RemoteBuddyPreflightCliOptions = {},
): Promise<{ exitCode: number }> => {
  const args = options.args ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runPreflight = options.runPreflight ?? runPreflightImpl;
  const flags = parseCliFlags(args);

  let runResult: RunPreflightResult;
  try {
    runResult = await runPreflight({
      cwd: options.cwd ?? process.cwd(),
      allowDirtyWorktree: flags.allowDirtyWorktree,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error";
    stderr.write(`${serializeFatalError(message)}\n`);
    return { exitCode: 1 };
  }

  stdout.write(`${serializeResult(runResult.result, runResult.exitCode)}\n`);
  return { exitCode: runResult.exitCode };
};

if (import.meta.main) {
  const { exitCode } = await runRemoteBuddyPreflightCliCommand();
  process.exit(exitCode);
}
