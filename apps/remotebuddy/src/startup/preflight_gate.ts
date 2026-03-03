import { detectRepoRoot, loadPushPalsConfig } from "shared";
import {
  runStartupPreflight,
  type RepoStatus,
  type StartupChecklistContext,
  type StartupChecklistFailure,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupCheckRecord,
  type SyntheticStartupTester,
} from "./checklist.js";

type GitCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const CONFIG = loadPushPalsConfig();
const REPO_ROOT = detectRepoRoot(process.cwd());

function logPreflightRecord(record: StartupCheckRecord): void {
  const scope = `[RemoteBuddyPreflight] [${record.category}] step=${record.step} code=${record.code}`;
  if (record.status === "pass") {
    console.log(`${scope} ok (${record.elapsedMs}ms): ${record.detail}`);
    return;
  }
  console.error(`${scope} FAILED (${record.elapsedMs}ms): ${record.detail}`);
  if (record.action) {
    console.error(`${scope} action: ${record.action}`);
  }
}

async function runGitCommand(repoRoot: string, args: string[]): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
}

function summarizePorcelain(porcelain: string): string {
  const lines = porcelain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "Worktree is clean.";
  }
  const previewLimit = 4;
  const preview = lines.slice(0, previewLimit).join(", ");
  const extra = lines.length > previewLimit ? ` (+${lines.length - previewLimit} more)` : "";
  return `Dirty entries: ${preview}${extra}`;
}

async function describeRepoStatus(repoRoot: string): Promise<RepoStatus> {
  const [porcelain, branch, mergeHead] = await Promise.all([
    runGitCommand(repoRoot, ["status", "--short"]),
    runGitCommand(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGitCommand(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
  ]);

  if (!porcelain.ok) {
    throw new Error(
      `git status failed (exit ${porcelain.exitCode}): ${porcelain.stderr || porcelain.stdout}`,
    );
  }

  const isDirty = porcelain.stdout.trim().length > 0;
  const isMergeInProgress = mergeHead.ok;
  const branchName = branch.ok ? branch.stdout.trim() : undefined;
  const detail = isDirty
    ? summarizePorcelain(porcelain.stdout)
    : branchName
      ? `Worktree is clean on ${branchName}.`
      : "Worktree is clean.";

  return {
    isDirty,
    isMergeInProgress,
    branch: branchName,
    detail,
  };
}

const defaultSyntheticTester: SyntheticStartupTester = {
  async runSyntheticJob() {
    // Default wiring does not probe external services yet. Returning a fast success keeps
    // the checklist deterministic while the synthetic harness is implemented.
    await Bun.sleep(5);
    return { ok: true, latencyMs: 5 };
  },
};

async function listFiringAlerts(): Promise<string[]> {
  // TODO: wire up Alertmanager polling when telemetry endpoints are available.
  return [];
}

export class RemoteBuddyPreflightError extends Error {
  readonly failure: StartupChecklistFailure;
  readonly history: StartupCheckRecord[];

  constructor(failure: StartupChecklistFailure, history: StartupCheckRecord[]) {
    super(`[RemoteBuddyPreflightError] ${failure.code}: ${failure.detail}`);
    this.name = "RemoteBuddyPreflightError";
    this.failure = failure;
    this.history = history;
  }
}

function asStartupChecklistOptions(
  overrides?: StartupChecklistOptions,
): StartupChecklistOptions {
  const allowDirty = overrides?.allowDirtyWorktree ?? CONFIG.remotebuddy.autonomy.allowDirtyWorktree;
  const base: StartupChecklistOptions = {
    allowDirtyWorktree: allowDirty,
    syntheticMaxLatencyMs: overrides?.syntheticMaxLatencyMs,
    syntheticProbeName: overrides?.syntheticProbeName,
  };
  return base;
}

export async function enforceStartupPreflightGate(
  options: StartupChecklistOptions = {},
): Promise<StartupChecklistResult> {
  const ctx: StartupChecklistContext = {
    describeRepo: () => describeRepoStatus(REPO_ROOT),
    listFiringAlerts,
    syntheticTester: defaultSyntheticTester,
    log: logPreflightRecord,
  };
  const mergedOptions = asStartupChecklistOptions(options);
  const result = await runStartupPreflight(ctx, mergedOptions);
  if (!result.ok && result.failure) {
    console.error(
      `[RemoteBuddyPreflight] BLOCKED (${result.failure.code}): ${result.failure.detail}`,
    );
    if (result.failure.action) {
      console.error(`[RemoteBuddyPreflight] Next action: ${result.failure.action}`);
    }
  }
  return result;
}

export async function ensurePreflightPasses(
  options: StartupChecklistOptions = {},
): Promise<void> {
  const result = await enforceStartupPreflightGate(options);
  if (!result.ok && result.failure) {
    throw new RemoteBuddyPreflightError(result.failure, result.history);
  }
  console.log("[RemoteBuddyPreflight] Startup checklist passed.");
}
