import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RepositorySnapshotError,
  resolveRepositorySnapshot,
  type RepositoryAgentRepositoryRef,
  type RepositorySnapshotGitResult,
} from "shared";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals repository snapshot "));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  writeFileSync(join(root, "README.md"), "initial\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, [
    "-c",
    "user.name=PushPals Tests",
    "-c",
    "user.email=pushpals-tests@example.invalid",
    "commit",
    "-m",
    "initial fixture",
  ]);
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      // Windows may retain a short-lived Git handle after the test.
    }
  }
});

describe("resolveRepositorySnapshot", () => {
  test("returns a canonical clean snapshot using the authoritative HEAD tree", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });

    const snapshot = await resolveRepositorySnapshot(nested);
    const compatible: RepositoryAgentRepositoryRef = snapshot;

    expect(compatible.root).toBe(realpathSync.native(root));
    expect(snapshot.identity).toMatch(/^repo_[0-9a-f]{64}$/);
    expect(snapshot.revision).toBe(git(root, ["rev-parse", "HEAD^{commit}"]).toLowerCase());
    expect(snapshot.tree).toBe(git(root, ["rev-parse", "HEAD^{tree}"]).toLowerCase());
    expect(snapshot.dirty).toBe(false);
  });

  test("hashes tracked dirty state deterministically", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    writeFileSync(join(root, "README.md"), "first dirty value\n", "utf8");

    const first = await resolveRepositorySnapshot(root);
    const repeated = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);
    expect(first.tree).toMatch(/^dirty:sha256:[0-9a-f]{64}$/);
    expect(repeated.tree).toBe(first.tree);
    expect(repeated.revision).toBe(first.revision);

    writeFileSync(join(root, "README.md"), "second dirty value\n", "utf8");
    const changedContent = await resolveRepositorySnapshot(root);
    expect(changedContent.tree).not.toBe(first.tree);

    git(root, ["add", "README.md"]);
    const staged = await resolveRepositorySnapshot(root);
    expect(staged.tree).not.toBe(changedContent.tree);
    expect(staged.revision).toBe(first.revision);
  });

  test("includes untracked file content in the dirty fingerprint", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const untrackedPath = join(root, "--untracked file.bin");
    writeFileSync(untrackedPath, Buffer.from([0, 1, 2, 3]));

    const first = await resolveRepositorySnapshot(root);
    const repeated = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);
    expect(repeated.tree).toBe(first.tree);

    writeFileSync(untrackedPath, Buffer.from([0, 1, 2, 4]));
    const changedContent = await resolveRepositorySnapshot(root);
    expect(changedContent.tree).not.toBe(first.tree);
  });

  test("records nested repository boundaries without trying to hash a directory", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const nested = join(root, "nested-repository");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init"]);
    writeFileSync(join(nested, "nested.txt"), "nested content\n", "utf8");

    const first = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);
    expect(first.tree).toMatch(/^dirty:sha256:[0-9a-f]{64}$/);

    // Contents below a nested Git boundary are intentionally outside the
    // parent repository snapshot; changing the boundary itself is still
    // represented by status/path state.
    writeFileSync(join(nested, "nested.txt"), "changed nested content\n", "utf8");
    const repeated = await resolveRepositorySnapshot(root);
    expect(repeated.tree).toBe(first.tree);
  });

  test("uses one repository identity across linked worktrees while preserving exact revisions", async () => {
    const fixture = fixtureRoot();
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    initializeRepository(main);
    git(main, ["worktree", "add", "-b", "snapshot-linked", linked, "HEAD"]);

    const mainSnapshot = await resolveRepositorySnapshot(main);
    const linkedSnapshot = await resolveRepositorySnapshot(linked);
    expect(linkedSnapshot.identity).toBe(mainSnapshot.identity);
    expect(linkedSnapshot.revision).toBe(mainSnapshot.revision);
    expect(linkedSnapshot.tree).toBe(mainSnapshot.tree);
    expect(linkedSnapshot.root).not.toBe(mainSnapshot.root);
  });

  test("fails closed outside Git repositories", async () => {
    const root = fixtureRoot();
    try {
      await resolveRepositorySnapshot(root);
      throw new Error("expected snapshot resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("git_failed");
    }
  });

  test("fails closed on Git timeout without invoking a shell", async () => {
    const root = fixtureRoot();
    const calls: Array<{ root: string; args: string[] }> = [];
    try {
      await resolveRepositorySnapshot(root, {
        runGit: async (repoRoot, args) => {
          calls.push({ root: repoRoot, args });
          return {
            exitCode: 124,
            stdout: "",
            stderr: "timed out",
            timedOut: true,
            drainTimedOut: false,
          };
        },
      });
      throw new Error("expected snapshot resolution to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("git_timeout");
      expect((error as RepositorySnapshotError).gitArgs).toEqual(["rev-parse", "--show-toplevel"]);
    }
    expect(calls).toEqual([
      { root: realpathSync.native(root), args: ["rev-parse", "--show-toplevel"] },
    ]);
  });

  test("rejects a repository that changes while dirty state is captured", async () => {
    const root = fixtureRoot();
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    let statusCalls = 0;
    const calls: string[][] = [];
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"c".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: commit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          calls.push(args);
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === "rev-parse --verify HEAD^{tree}") return success(tree);
          if (args[0] === "status") {
            statusCalls += 1;
            return success(statusCalls === 1 ? " M README.md\0" : "MM README.md\0");
          }
          if (args[0] === "ls-files") return success("");
          if (args[0] === "diff") return success("diff --git a/README.md b/README.md\n");
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected concurrent repository change to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }

    expect(statusCalls).toBe(2);
    expect(calls.every((args) => args[0] !== "sh" && args[0] !== "cmd")).toBe(true);
    expect(calls).toContainEqual([
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
    ]);
  });

  test("rejects same-status tracked content changes during capture", async () => {
    const root = fixtureRoot();
    const commit = "1".repeat(40);
    const tree = "2".repeat(40);
    let statusCalls = 0;
    let unstagedDiffCalls = 0;
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"3".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: commit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === "rev-parse --verify HEAD^{tree}") return success(tree);
          if (args[0] === "status") {
            statusCalls += 1;
            return success(" M README.md\0");
          }
          if (args[0] === "ls-files") return success("");
          if (args[0] === "diff" && args.includes("--cached")) return success("");
          if (args[0] === "diff") {
            unstagedDiffCalls += 1;
            return success(
              unstagedDiffCalls === 1
                ? "diff --git a/README.md b/README.md\n+first\n"
                : "diff --git a/README.md b/README.md\n+second\n",
            );
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected same-status content change to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }

    expect(statusCalls).toBe(2);
    expect(unstagedDiffCalls).toBe(2);
  });

  test("rejects same-status untracked content changes during capture", async () => {
    const root = fixtureRoot();
    const commit = "4".repeat(40);
    const tree = "5".repeat(40);
    let statusCalls = 0;
    let untrackedListCalls = 0;
    let hashObjectCalls = 0;
    const calls: string[][] = [];
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"6".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: commit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          calls.push(args);
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === "rev-parse --verify HEAD^{tree}") return success(tree);
          if (args[0] === "status") {
            statusCalls += 1;
            return success("?? --untracked file.bin\0");
          }
          if (args[0] === "diff") return success("");
          if (args[0] === "ls-files") {
            untrackedListCalls += 1;
            return success("--untracked file.bin\0");
          }
          if (args[0] === "hash-object") {
            hashObjectCalls += 1;
            return success((hashObjectCalls === 1 ? "7" : "8").repeat(40));
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected same-status untracked content change to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }

    expect(statusCalls).toBe(2);
    expect(untrackedListCalls).toBe(2);
    expect(hashObjectCalls).toBe(2);
    expect(calls).toContainEqual(["hash-object", "--no-filters", "--", "--untracked file.bin"]);
    expect(calls.every((args) => args[0] !== "sh" && args[0] !== "cmd")).toBe(true);
  });

  test("rejects bounded diff output instead of hashing a truncated snapshot", async () => {
    const root = fixtureRoot();
    const commit = "d".repeat(40);
    const tree = "e".repeat(40);
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"f".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: commit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === "rev-parse --verify HEAD^{tree}") return success(tree);
          if (args[0] === "status") return success(" M README.md\0");
          if (args[0] === "ls-files") return success("");
          if (args[0] === "diff") {
            return success("partial diff\n[pushpals: process output truncated]");
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected truncated output to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("git_output_truncated");
    }
  });
});
