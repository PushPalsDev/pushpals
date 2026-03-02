import { existsSync, lstatSync, readFileSync } from "fs";
import { isAbsolute, resolve } from "path";

type GitCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

async function git(repo: string, args: string[]): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
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
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const result = await git(repo, args);
  return result.ok ? result.stdout : "";
}

function resolveGitDir(repo: string): string | null {
  const dotGitPath = resolve(repo, ".git");
  try {
    const stat = lstatSync(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    const raw = readFileSync(dotGitPath, "utf8");
    const match = raw.match(/gitdir:\s*(.+)/i);
    if (!match) return null;
    const target = match[1].trim();
    if (!target) return null;
    if (isAbsolute(target)) return target;
    return resolve(repo, target);
  } catch {
    return null;
  }
}

const REBASE_DIRECTORY_SENTINELS = ["rebase-apply", "rebase-merge"];

function rebaseDirectoryMarkers(gitDir: string): string[] {
  const markers: string[] = [];
  for (const candidate of REBASE_DIRECTORY_SENTINELS) {
    const markerPath = resolve(gitDir, candidate);
    if (existsSync(markerPath)) markers.push(candidate);
  }
  return markers;
}

export type RepoPreflightResult = {
  isWorktreeDirty: boolean;
  isMergeInProgress: boolean;
  isRebaseInProgress: boolean;
  mergeEvidence: string[];
  rebaseEvidence: string[];
};

export async function repoPreflight(repo: string): Promise<RepoPreflightResult> {
  const [porcelain, mergeHead, rebaseHead] = await Promise.all([
    gitOutput(repo, ["status", "--porcelain"]),
    gitOutput(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    gitOutput(repo, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]),
  ]);
  const gitDir = resolveGitDir(repo);
  const mergeEvidence: string[] = [];
  const rebaseEvidence: string[] = [];
  if (mergeHead) mergeEvidence.push("MERGE_HEAD");
  if (rebaseHead) rebaseEvidence.push("REBASE_HEAD");
  if (gitDir) rebaseEvidence.push(...rebaseDirectoryMarkers(gitDir));
  return {
    isWorktreeDirty: porcelain.length > 0,
    isMergeInProgress: mergeEvidence.length > 0,
    isRebaseInProgress: rebaseEvidence.length > 0,
    mergeEvidence,
    rebaseEvidence,
  };
}

export type MergeRebaseStatus = Pick<
  RepoPreflightResult,
  "isMergeInProgress" | "isRebaseInProgress" | "mergeEvidence" | "rebaseEvidence"
>;

export function mergeRebaseRemediationMessage(
  repoPath: string,
  status: MergeRebaseStatus,
): string {
  const normalized = repoPath.replace(/\\/g, "/");
  const activeOps: string[] = [];
  if (status.isMergeInProgress) activeOps.push("merge");
  if (status.isRebaseInProgress) activeOps.push("rebase");
  const subject =
    activeOps.length === 0 ? "merge/rebase" : activeOps.length === 2 ? "merge/rebase" : activeOps[0];
  const mergeGuidance = status.isMergeInProgress
    ? `"git merge --continue" or "git merge --abort"`
    : null;
  const rebaseGuidance = status.isRebaseInProgress
    ? `"git rebase --continue" or "git rebase --abort"`
    : null;
  const guidanceParts = [mergeGuidance, rebaseGuidance].filter(
    (part): part is string => typeof part === "string",
  );
  const guidanceText =
    guidanceParts.length === 0
      ? `"git merge --continue/--abort" or "git rebase --continue/--abort"`
      : guidanceParts.length === 1
        ? guidanceParts[0]
        : `${guidanceParts[0]} and ${guidanceParts[1]}`;
  const evidenceSegments: string[] = [];
  if (status.isMergeInProgress && status.mergeEvidence.length > 0) {
    evidenceSegments.push(`merge markers: ${status.mergeEvidence.join(", ")}`);
  }
  if (status.isRebaseInProgress && status.rebaseEvidence.length > 0) {
    evidenceSegments.push(`rebase markers: ${status.rebaseEvidence.join(", ")}`);
  }
  const evidenceDetail = evidenceSegments.length > 0 ? ` Evidence: ${evidenceSegments.join("; ")}.` : "";
  return `Finish or abort the git ${subject} inside ${normalized}. Run "git status" to inspect, then ${guidanceText} as appropriate.${evidenceDetail}`;
}
