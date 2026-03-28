import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitOps, runGitCommandCapture } from "../apps/source_control_manager/src/git";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-scm-git-cleanup-"));
  tempDirs.push(dir);
  return dir;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function runGit(repoPath: string, args: string[]) {
  const result = await runGitCommandCapture(repoPath, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function initRepo(repoPath: string): Promise<void> {
  await runGit(repoPath, ["init"]);
  await runGit(repoPath, ["config", "user.name", "PushPals Test"]);
  await runGit(repoPath, ["config", "user.email", "tests@pushpals.dev"]);
  await runGit(repoPath, ["checkout", "-B", "main"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, ["commit", "-m", "init"]);
}

describe("source_control_manager git cleanup", () => {
  test("cleanupLocalTempBranches removes linked temp worktrees and deletes their branches", async () => {
    const repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
    await initRepo(repoRoot);

    await runGit(repoRoot, ["checkout", "-B", "_source_control_manager/leftover"]);
    await runGit(repoRoot, ["checkout", "--detach", "main"]);
    const tempWorktree = join(repoRoot, ".worktrees", "source_control_manager");
    await runGit(repoRoot, ["worktree", "add", tempWorktree, "_source_control_manager/leftover"]);

    const gitOps = new GitOps({
      repoPath: repoRoot,
      remote: "origin",
      mainBranch: "main_agents",
      integrationBaseBranch: "main",
      branchPrefix: "agent/",
      gitToken: null,
    } as any);

    const cleanup = await gitOps.cleanupLocalTempBranches("_source_control_manager/");

    expect(cleanup.removedWorktrees.map(normalizePath)).toEqual([normalizePath(tempWorktree)]);
    expect(cleanup.deletedBranches).toContain("_source_control_manager/leftover");
    expect(cleanup.failedBranches).toEqual([]);
    expect(existsSync(tempWorktree)).toBe(false);

    const branches = await runGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/_source_control_manager/",
    ]);
    expect(branches.stdout.trim()).toBe("");
  });
});
