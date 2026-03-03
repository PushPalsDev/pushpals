import { existsSync } from "fs";
import { resolve } from "path";
import type { RepoStatus } from "./checklist.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitCommandRunner = (
  args: string[],
  cwd: string,
) => Promise<GitCommandResult>;

export interface WorkspaceProbeOptions {
  cwd?: string;
  runGitCommand?: GitCommandRunner;
  exists?: (path: string) => boolean;
}

const defaultRunGitCommand: GitCommandRunner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
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
      exitCode,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: String(err),
      exitCode: 127,
    };
  }
};

const IN_PROGRESS_MARKERS: readonly {
  name: string;
  label: string;
}[] = [
  { name: "rebase-merge", label: "rebase-merge" },
  { name: "rebase-apply", label: "rebase-apply" },
  { name: "MERGE_HEAD", label: "merge-head" },
  { name: "CHERRY_PICK_HEAD", label: "cherry-pick" },
  { name: "REVERT_HEAD", label: "revert" },
  { name: "BISECT_LOG", label: "bisect" },
];

const summarizeGitFailure = (command: string, result: GitCommandResult) => {
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  return `git ${command} failed: ${detail}`;
};

const resolveGitPath = (
  value: string,
  repoRoot: string,
  cwd: string,
): string => {
  if (!value) return "";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return value;
  if (value.startsWith(".git")) return resolve(repoRoot, value);
  return resolve(cwd, value);
};

const detectInProgressMarkers = async (
  runGit: GitCommandRunner,
  cwd: string,
  repoRoot: string,
  gitDir: string,
  exists: (path: string) => boolean,
): Promise<string[]> => {
  const hits: string[] = [];
  for (const marker of IN_PROGRESS_MARKERS) {
    const result = await runGit(["rev-parse", "--git-path", marker.name], cwd);
    let target = "";
    if (result.ok) {
      target = resolveGitPath(result.stdout.trim(), repoRoot, cwd);
    }
    if (!target) {
      target = resolve(gitDir, marker.name);
    }
    if (target && exists(target)) {
      hits.push(marker.label);
    }
  }
  return hits;
};

const summarizeDirtyEntries = (porcelain: string): string => {
  const entries = porcelain
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line.trim());
  if (entries.length === 0) return "";
  return entries.length === 5
    ? `${entries.join(", ")}${porcelain.trim().split("\n").length > 5 ? ", ..." : ""}`
    : entries.join(", ");
};

export const defaultWorkspaceProbe = async (
  options: WorkspaceProbeOptions = {},
): Promise<RepoStatus> => {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const runGit = options.runGitCommand ?? defaultRunGitCommand;
  const exists = options.exists ?? existsSync;

  const repoRootResult = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRootResult.ok) {
    throw new Error(summarizeGitFailure("--show-toplevel", repoRootResult));
  }
  const repoRoot = repoRootResult.stdout || cwd;

  const gitDirResult = await runGit(["rev-parse", "--git-dir"], cwd);
  if (!gitDirResult.ok) {
    throw new Error(summarizeGitFailure("--git-dir", gitDirResult));
  }
  const gitDir =
    resolveGitPath(gitDirResult.stdout.trim(), repoRoot, cwd) ||
    resolve(repoRoot, ".git");

  const branchResult = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  );
  const branch = branchResult.ok ? branchResult.stdout : undefined;

  const statusResult = await runGit(["status", "--porcelain"], cwd);
  if (!statusResult.ok) {
    throw new Error(summarizeGitFailure("status --porcelain", statusResult));
  }
  const isDirty = Boolean(statusResult.stdout.trim());

  const markers = await detectInProgressMarkers(
    runGit,
    cwd,
    repoRoot,
    gitDir,
    exists,
  );
  const isMergeInProgress = markers.length > 0;

  const detailParts: string[] = [];
  if (isMergeInProgress) {
    detailParts.push(
      `git operation in progress: ${markers
        .map((marker) => marker.replace(/_/g, "-"))
        .join(", ")}`,
    );
  }
  if (isDirty) {
    const summary = summarizeDirtyEntries(statusResult.stdout);
    detailParts.push(
      summary ? `dirty files: ${summary}` : "dirty worktree detected",
    );
  }
  if (detailParts.length === 0 && branch) {
    detailParts.push(`on branch ${branch}`);
  }

  return {
    isDirty,
    isMergeInProgress,
    branch,
    detail: detailParts.join(" | ") || undefined,
  };
};
