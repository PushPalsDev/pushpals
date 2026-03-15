import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectRepoRoot,
  findGitRepoRoot,
  resolveGitMetadataDir,
  resolveGitStateFilePath,
} from "../packages/shared/src/repo";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("shared repo helpers", () => {
  test("resolveGitMetadataDir returns the .git directory for normal repos", () => {
    const root = makeTempRoot("pushpals-shared-repo-");
    mkdirSync(join(root, ".git"), { recursive: true });

    expect(resolveGitMetadataDir(root)).toBe(resolve(root, ".git"));
    expect(resolveGitStateFilePath(root, "pushpals-cli-state.json")).toBe(
      resolve(root, ".git", "pushpals-cli-state.json"),
    );
  });

  test("resolveGitMetadataDir follows gitdir pointers for worktrees", () => {
    const root = makeTempRoot("pushpals-shared-worktree-");
    const metadataDir = join(root, "..", "gitdir-store", "worktrees", "demo");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadataDir}\n`, "utf8");

    expect(resolveGitMetadataDir(root)).toBe(resolve(metadataDir));
    expect(resolveGitStateFilePath(root, "pushpals-client-state.json")).toBe(
      resolve(metadataDir, "pushpals-client-state.json"),
    );
  });

  test("detectRepoRoot treats worktree gitdir files as valid repo markers", () => {
    const root = makeTempRoot("pushpals-shared-detect-");
    const nested = join(root, "apps", "client");
    const metadataDir = join(root, "..", "gitdir-store", "worktrees", "detect");
    mkdirSync(nested, { recursive: true });
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadataDir}\n`, "utf8");

    expect(detectRepoRoot(nested)).toBe(resolve(root));
  });

  test("findGitRepoRoot resolves nested directories without falling back to the cwd", () => {
    const root = makeTempRoot("pushpals-shared-find-");
    const nested = join(root, "apps", "client");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(findGitRepoRoot(nested)).toBe(resolve(root));
  });

  test("findGitRepoRoot returns null outside a git repo", () => {
    const root = makeTempRoot("pushpals-shared-missing-");
    mkdirSync(join(root, "nested"), { recursive: true });

    expect(findGitRepoRoot(join(root, "nested"))).toBeNull();
  });
});
