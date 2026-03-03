import { existsSync } from "fs";
import { join } from "path";
import {
  runStartupPreflight,
  type RepoStatus,
  type StartupCheckRecord,
  type StartupChecklistContext,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type SyntheticStartupTester,
} from "./startup/checklist";

export interface SystemPreflightOptions {
  repo: string;
  allowDirtyWorktree?: boolean;
  syntheticTester?: SyntheticStartupTester;
  listFiringAlerts?: () => Promise<string[]>;
  log?: (record: StartupCheckRecord) => void;
}

export async function runSystemPreflight(
  options: SystemPreflightOptions,
): Promise<StartupChecklistResult> {
  const { repo, allowDirtyWorktree = false } = options;
  if (!repo) {
    throw new Error("system preflight requires a repository path");
  }

  const context: StartupChecklistContext = {
    describeRepo: () => describeRepoStatus(repo),
    listFiringAlerts: options.listFiringAlerts ?? listFiringAlertsFromEnv,
    syntheticTester: options.syntheticTester ?? defaultSyntheticTester,
    log: options.log ?? logStartupCheckRecord,
  };

  const checklistOptions: StartupChecklistOptions = {
    allowDirtyWorktree,
  };

  return runStartupPreflight(context, checklistOptions);
}

async function describeRepoStatus(repo: string): Promise<RepoStatus> {
  const status = await runGit(repo, ["status", "--short", "--branch"]);
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const branch = parseBranch(lines) ?? undefined;
  const dirtyEntries = lines.filter((line) => !line.startsWith("##"));
  const isDirty = dirtyEntries.length > 0;
  const mergeInProgress = await detectMergeInProgress(repo);
  return {
    isDirty,
    isMergeInProgress: mergeInProgress,
    branch,
    detail: buildRepoDetail(branch, dirtyEntries, mergeInProgress),
  };
}

function parseBranch(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("##")) continue;
    const match = line.match(/^##\s+([^.]+?)(?:\.\.\.|$)/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function buildRepoDetail(
  branch: string | null,
  dirtyEntries: string[],
  mergeInProgress: boolean,
): string {
  if (mergeInProgress) {
    const branchHint = branch ? ` on ${branch}` : "";
    return `Merge or rebase in progress${branchHint}.`;
  }
  if (dirtyEntries.length === 0) {
    return branch ? `Worktree clean on ${branch}.` : "Worktree clean.";
  }
  const samples = dirtyEntries
    .slice(0, 3)
    .map((entry) => entry.replace(/^\s+/, "").replace(/\s+$/, ""));
  const extra = dirtyEntries.length > samples.length ? dirtyEntries.length - samples.length : 0;
  const suffix = extra > 0 ? ` (+${extra} more)` : "";
  const branchHint = branch ? ` (${branch})` : "";
  return `Dirty worktree${branchHint}: ${samples.join(", ")}${suffix}`;
}

async function detectMergeInProgress(repo: string): Promise<boolean> {
  const [mergeHead, rebaseHead, gitDir] = await Promise.all([
    runGit(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    runGit(repo, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]),
    runGit(repo, ["rev-parse", "--absolute-git-dir"]),
  ]);

  if (mergeHead.exitCode === 0 && mergeHead.stdout.trim()) return true;
  if (rebaseHead.exitCode === 0 && rebaseHead.stdout.trim()) return true;
  const gitDirPath =
    gitDir.exitCode === 0 && gitDir.stdout.trim() ? gitDir.stdout.trim() : join(repo, ".git");
  if (existsSync(join(gitDirPath, "rebase-merge"))) return true;
  if (existsSync(join(gitDirPath, "rebase-apply"))) return true;
  return false;
}

function listFiringAlertsFromEnv(): Promise<string[]> {
  const raw = process.env.REMOTEBUDDY_ACTIVE_ALERTS ?? "";
  const alerts = raw
    .split(/[,|\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Promise.resolve(alerts);
}

const defaultSyntheticTester: SyntheticStartupTester = {
  async runSyntheticJob(options) {
    const forcedLatency = Number.parseFloat(process.env.REMOTEBUDDY_SYNTHETIC_LATENCY_MS ?? "");
    const latencyMs = Number.isFinite(forcedLatency) ? forcedLatency : Math.min(options.maxLatencyMs, 25);
    const forceFailure = /^1|true|yes$/i.test(process.env.REMOTEBUDDY_SYNTHETIC_FAIL ?? "");
    if (forceFailure) {
      return {
        ok: false,
        latencyMs,
        failureDetail: `${options.probeName} forced failure via REMOTEBUDDY_SYNTHETIC_FAIL`,
      };
    }
    return { ok: true, latencyMs };
  },
};

function logStartupCheckRecord(record: StartupCheckRecord): void {
  const payload = {
    component: "RemoteBuddyStartupPreflight",
    status: record.status,
    code: record.code,
    step: record.step,
    category: record.category,
    detail: record.detail,
    elapsedMs: record.elapsedMs,
  };
  console.log(JSON.stringify(payload));
}

type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runGit(repo: string, args: string[]): Promise<GitRunResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error ?? "unknown git error"),
      exitCode: 1,
    };
  }
}
