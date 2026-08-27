import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  lstat as lstatPath,
  open as openPath,
  readdir as readdirPath,
  readlink as readlinkPath,
  realpath as realpathPath,
} from "fs/promises";
import {
  RepositorySnapshotError,
  resolveRepositorySnapshot,
  type RepositoryAgentRepositoryRef,
  type RepositorySnapshotFileSystem,
  type RepositorySnapshotGitRunner,
  type RepositorySnapshotGitResult,
} from "shared";

const roots: string[] = [];
setDefaultTimeout(30_000);

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals repository snapshot "));
  roots.push(root);
  return root;
}

function canonicalPathKey(path: string): string {
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isSameCanonicalPath(actual: string, expected: string): boolean {
  return canonicalPathKey(actual) === canonicalPathKey(expected);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const directSnapshotGit: RepositorySnapshotGitRunner = async (repoRoot, args, options) => {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input: options.stdin,
    maxBuffer: options.outputLimitBytes,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const errorCode = (result.error as { code?: string } | undefined)?.code;
  return {
    exitCode: result.status ?? (errorCode === "ETIMEDOUT" ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDecodeError: false,
    stderrDecodeError: false,
    timedOut: errorCode === "ETIMEDOUT",
    drainTimedOut: false,
  };
};

function initializeRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "PushPals Tests"]);
  git(root, ["config", "user.email", "pushpals-tests@example.invalid"]);
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

const nativeSnapshotFileSystem: RepositorySnapshotFileSystem = {
  async lstat(path) {
    return await lstatPath(path, { bigint: true });
  },
  async readdir(path) {
    return await readdirPath(path, { withFileTypes: true });
  },
  async readlink(path) {
    return (await readlinkPath(path, { encoding: "buffer" })) as Buffer;
  },
  async realpath(path) {
    return await realpathPath(path);
  },
  async open(path, flags) {
    return await openPath(path, flags);
  },
};

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

  test("rejects a repository root renamed and replaced by another repository junction", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const movedRoot = join(fixture, "repository-moved");
    const otherRoot = join(fixture, "other-repository");
    initializeRepository(root);
    initializeRepository(otherRoot);
    let revisionCalls = 0;

    try {
      await resolveRepositorySnapshot(root, {
        runGit: async (repoRoot, args, options) => {
          const result = await directSnapshotGit(repoRoot, args, options);
          if (args.join(" ") === "rev-parse --verify HEAD^{commit}") {
            revisionCalls += 1;
            if (revisionCalls === 3) {
              renameSync(root, movedRoot);
              symlinkSync(otherRoot, root, process.platform === "win32" ? "junction" : "dir");
            }
          }
          return result;
        },
      });
      throw new Error("expected repository root replacement to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(revisionCalls).toBe(3);
  });

  test("rejects a root swap after the first injected source-path lstat", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const movedRoot = join(fixture, "repository-moved");
    const otherRoot = join(fixture, "other-repository");
    initializeRepository(root);
    initializeRepository(otherRoot);
    let sourceLstatCalls = 0;
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async lstat(path) {
        const observed = await nativeSnapshotFileSystem.lstat(path);
        if (path === root) {
          sourceLstatCalls += 1;
          if (sourceLstatCalls === 1) {
            renameSync(root, movedRoot);
            symlinkSync(otherRoot, root, process.platform === "win32" ? "junction" : "dir");
          }
        }
        return observed;
      },
    };

    try {
      await resolveRepositorySnapshot(root, { fileSystem });
      throw new Error("expected bracketed root observation to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("invalid_root");
    }
    expect(sourceLstatCalls).toBe(2);
  });

  test("supports repositories that use SHA-256 object IDs", async () => {
    const root = fixtureRoot();
    mkdirSync(root, { recursive: true });
    git(root, ["init", "--object-format=sha256"]);
    git(root, ["config", "user.name", "PushPals Tests"]);
    git(root, ["config", "user.email", "pushpals-tests@example.invalid"]);
    writeFileSync(join(root, "README.md"), "sha256 repository\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "initialize sha256 fixture"]);

    const clean = await resolveRepositorySnapshot(root);
    expect(clean.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(clean.tree).toBe(git(root, ["rev-parse", "HEAD^{tree}"]).toLowerCase());
    expect(clean.dirty).toBe(false);

    writeFileSync(join(root, "untracked.txt"), "first sha256 content\n", "utf8");
    const dirty = await resolveRepositorySnapshot(root);
    const repeated = await resolveRepositorySnapshot(root);
    expect(dirty.tree).toMatch(/^dirty:sha256:[0-9a-f]{64}$/);
    expect(repeated.tree).toBe(dirty.tree);
    writeFileSync(join(root, "untracked.txt"), "second sha256 content\n", "utf8");
    expect((await resolveRepositorySnapshot(root)).tree).not.toBe(dirty.tree);
  });

  test("rejects mixed SHA-1 and SHA-256 widths across commit, tree, and index output", async () => {
    const root = fixtureRoot();
    const sha1Commit = "1".repeat(40);
    const sha256Commit = "3".repeat(64);
    const sha256Tree = "4".repeat(64);
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });

    for (const mismatch of ["tree", "index"] as const) {
      const commit = mismatch === "tree" ? sha1Commit : sha256Commit;
      let code: string | null = null;
      try {
        await resolveRepositorySnapshot(root, {
          resolveIdentity: async () => ({
            repositoryId: `repo_${"5".repeat(64)}`,
            source: "git-common-dir",
            normalizedOrigin: null,
            rootCommit: commit,
            gitCommonDir: join(root, ".git"),
          }),
          runGit: async (_repoRoot, args) => {
            const key = args.join(" ");
            if (key === "rev-parse --show-toplevel") return success(root);
            if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
            if (key === `rev-parse --verify ${commit}^{tree}`) {
              return success(sha256Tree);
            }
            if (args[0] === "ls-files" && args.includes("--stage")) {
              return success(`100644 ${sha1Commit} 0\tREADME.md\0`);
            }
            if (args[0] === "ls-files" || args[0] === "status" || args[0] === "diff") {
              return success("");
            }
            throw new Error(`unexpected Git args: ${key}`);
          },
        });
      } catch (error) {
        code = error instanceof RepositorySnapshotError ? error.code : null;
      }
      expect(code).toBe("invalid_git_output");
    }
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

  test("includes the Git-relevant executable bit for untracked files", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot();
    initializeRepository(root);
    const script = join(root, "untracked-script.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(script, 0o644);

    const nonExecutable = await resolveRepositorySnapshot(root);
    chmodSync(script, 0o755);
    const executable = await resolveRepositorySnapshot(root);
    expect(executable.tree).not.toBe(nonExecutable.tree);

    chmodSync(script, 0o644);
    const restored = await resolveRepositorySnapshot(root);
    expect(restored.tree).toBe(nonExecutable.tree);
  });

  test("rejects an executable-bit mutation between stable observations", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot();
    initializeRepository(root);
    const script = join(root, "changing-mode.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(script, 0o644);
    let fullUntrackedCalls = 0;

    try {
      await resolveRepositorySnapshot(root, {
        runGit: async (repoRoot, args, options) => {
          const result = await directSnapshotGit(repoRoot, args, options);
          if (
            args[0] === "ls-files" &&
            args.includes("--others") &&
            !args.includes("--directory")
          ) {
            fullUntrackedCalls += 1;
            if (fullUntrackedCalls === 2) chmodSync(script, 0o755);
          }
          return result;
        },
      });
      throw new Error("expected executable-bit mutation to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(fullUntrackedCalls).toBe(2);
  });

  test("rejects an executable-bit mutation between lstat and the second file open", async () => {
    if (process.platform === "win32") return;
    const root = fixtureRoot();
    initializeRepository(root);
    const script = join(root, "open-race.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(script, 0o644);
    let openCalls = 0;
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async open(path, flags) {
        if (path === script) {
          openCalls += 1;
          if (openCalls === 2) chmodSync(script, 0o755);
        }
        return await nativeSnapshotFileSystem.open(path, flags);
      },
    };

    try {
      await resolveRepositorySnapshot(root, { fileSystem });
      throw new Error("expected lstat/open mode race to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(openCalls).toBe(2);
  });

  test("rejects a mismatched opened file before reading its bytes", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const outside = join(fixture, "outside-secret.txt");
    initializeRepository(root);
    const untracked = join(root, "candidate.txt");
    writeFileSync(untracked, "safe candidate\n", "utf8");
    writeFileSync(outside, "outside secret\n", "utf8");
    let readCalls = 0;
    let closeCalls = 0;
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async open(path, flags) {
        const handle = await openPath(isSameCanonicalPath(path, untracked) ? outside : path, flags);
        return {
          async stat(options) {
            return await handle.stat(options);
          },
          async read(buffer, offset, length, position) {
            readCalls += 1;
            return await handle.read(buffer, offset, length, position);
          },
          async close() {
            closeCalls += 1;
            await handle.close();
          },
        };
      },
    };

    try {
      await resolveRepositorySnapshot(root, { fileSystem });
      throw new Error("expected mismatched file handle to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(readCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test("caches shared directory prefixes within each stable observation", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const shared = join(root, "shared");
    const deep = join(shared, "deep");
    mkdirSync(deep, { recursive: true });
    for (let index = 0; index < 24; index += 1) {
      writeFileSync(join(deep, `file-${index}.txt`), `fixture ${index}\n`, "utf8");
    }
    const counts = new Map<string, number>();
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async lstat(path) {
        const key = canonicalPathKey(path);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return await nativeSnapshotFileSystem.lstat(path);
      },
    };

    const snapshot = await resolveRepositorySnapshot(root, { fileSystem });
    expect(snapshot.dirty).toBe(true);
    // Each capture observes a prefix once and validates it once. The number of
    // descendant files must not multiply shared-prefix lstat calls.
    expect(counts.get(canonicalPathKey(shared))).toBe(4);
    expect(counts.get(canonicalPathKey(deep))).toBe(4);
  });

  test("does not recurse into ignored directories while discovering boundaries", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    writeFileSync(join(root, ".gitignore"), "ordinary-container/vendor/\n", "utf8");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "ignore fixture vendor directory"]);
    const container = join(root, "ordinary-container");
    const ignored = join(container, "vendor");
    mkdirSync(join(ignored, "deep"), { recursive: true });
    writeFileSync(join(container, "visible.txt"), "visible untracked content\n", "utf8");
    writeFileSync(join(ignored, "deep", "ignored.txt"), "ignored content\n", "utf8");
    const readdirCounts = new Map<string, number>();
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async readdir(path) {
        const key = canonicalPathKey(path);
        readdirCounts.set(key, (readdirCounts.get(key) ?? 0) + 1);
        return await nativeSnapshotFileSystem.readdir(path);
      },
    };

    const snapshot = await resolveRepositorySnapshot(root, { fileSystem });
    expect(snapshot.dirty).toBe(true);
    expect(readdirCounts.get(canonicalPathKey(container))).toBe(2);
    expect(readdirCounts.has(canonicalPathKey(ignored))).toBe(false);
  });

  test("records nested repository boundaries without trying to hash a directory", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const nested = join(root, "nested-repository");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init"]);
    git(nested, ["config", "user.name", "PushPals Nested Tests"]);
    git(nested, ["config", "user.email", "pushpals-nested@example.invalid"]);
    writeFileSync(join(nested, "nested.txt"), "nested content\n", "utf8");
    git(nested, ["add", "nested.txt"]);
    git(nested, ["commit", "-m", "initialize nested fixture"]);

    const first = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);
    expect(first.tree).toMatch(/^dirty:sha256:[0-9a-f]{64}$/);

    // Worktree-only contents below a nested Git boundary stay opaque.
    writeFileSync(join(nested, "nested.txt"), "changed nested content\n", "utf8");
    const repeated = await resolveRepositorySnapshot(root);
    expect(repeated.tree).toBe(first.tree);

    // The exact nested HEAD is part of the opaque boundary identity.
    git(nested, ["add", "nested.txt"]);
    git(nested, ["commit", "-m", "advance nested head"]);
    const advancedHead = await resolveRepositorySnapshot(root);
    expect(advancedHead.tree).not.toBe(first.tree);
  });

  test("excludes a validated nested repository from full Git enumeration during marker ABA", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const nested = join(root, "nested-repository");
    const marker = join(nested, ".git");
    const heldMarker = join(nested, ".git-held");
    const outside = join(fixture, "outside-target");
    initializeRepository(root);
    mkdirSync(nested, { recursive: true });
    git(nested, ["init"]);
    git(nested, ["config", "user.name", "PushPals Nested Tests"]);
    git(nested, ["config", "user.email", "pushpals-nested@example.invalid"]);
    writeFileSync(join(nested, "tracked.txt"), "nested tracked\n", "utf8");
    git(nested, ["add", "tracked.txt"]);
    git(nested, ["commit", "-m", "initialize nested fixture"]);
    mkdirSync(outside);
    writeFileSync(join(outside, "outside-secret-name.md"), "opaque outside\n", "utf8");
    symlinkSync(
      outside,
      join(nested, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const calls: string[][] = [];
    let markerAbaCount = 0;
    let leakedExternalNamespace = false;
    let failureCode: string | null = null;
    try {
      await resolveRepositorySnapshot(root, {
        runGit: async (repoRoot, args, options) => {
          calls.push(args);
          const fullUntracked =
            args[0] === "ls-files" && args.includes("--others") && !args.includes("--directory");
          if (!fullUntracked) {
            const result = await directSnapshotGit(repoRoot, args, options);
            if (result.stdout.includes("outside-secret-name.md")) {
              leakedExternalNamespace = true;
            }
            return result;
          }
          expect(args).toContain(":(top,exclude,literal)nested-repository");
          renameSync(marker, heldMarker);
          try {
            const result = await directSnapshotGit(repoRoot, args, options);
            if (result.stdout.includes("outside-secret-name.md")) {
              leakedExternalNamespace = true;
            }
            return result;
          } finally {
            renameSync(heldMarker, marker);
            markerAbaCount += 1;
          }
        },
      });
    } catch (error) {
      failureCode = error instanceof RepositorySnapshotError ? error.code : null;
    }
    expect(markerAbaCount).toBeGreaterThan(0);
    expect(leakedExternalNamespace).toBe(false);
    expect(failureCode === null || failureCode === "repository_changed").toBe(true);
    const fullProbes = calls.filter(
      (args) =>
        args[0] === "ls-files" && args.includes("--others") && !args.includes("--directory"),
    );
    expect(fullProbes.length).toBe(markerAbaCount);
    expect(
      fullProbes.every((args) => args.includes(":(top,exclude,literal)nested-repository")),
    ).toBe(true);
  });

  test("fingerprints an untracked directory indirection without following its target", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const firstTarget = join(fixture, "outside-first");
    const secondTarget = join(fixture, "outside-second");
    initializeRepository(root);
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    writeFileSync(join(firstTarget, "security.md"), "first outside secret\n", "utf8");
    writeFileSync(join(secondTarget, "security.md"), "second outside secret\n", "utf8");
    const link = join(root, "outside-secret");
    symlinkSync(firstTarget, link, process.platform === "win32" ? "junction" : "dir");

    const first = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);
    expect(first.tree).toMatch(/^dirty:sha256:[0-9a-f]{64}$/);

    writeFileSync(join(firstTarget, "security.md"), "changed outside secret\n", "utf8");
    const changedTargetContent = await resolveRepositorySnapshot(root);
    expect(changedTargetContent.tree).toBe(first.tree);

    writeFileSync(join(firstTarget, "added.md"), "another outside secret\n", "utf8");
    const addedTargetDescendant = await resolveRepositorySnapshot(root);
    expect(addedTargetDescendant.tree).toBe(first.tree);

    renameSync(join(firstTarget, "security.md"), join(firstTarget, "renamed.md"));
    unlinkSync(join(firstTarget, "added.md"));
    const renamedTargetDescendant = await resolveRepositorySnapshot(root);
    expect(renamedTargetDescendant.tree).toBe(first.tree);

    unlinkSync(join(firstTarget, "renamed.md"));
    const emptyTarget = await resolveRepositorySnapshot(root);
    expect(emptyTarget.tree).toBe(first.tree);

    unlinkSync(link);
    symlinkSync(secondTarget, link, process.platform === "win32" ? "junction" : "dir");
    const changedIndirection = await resolveRepositorySnapshot(root);
    expect(changedIndirection.tree).not.toBe(first.tree);
  });

  test("finds an empty indirection nested below an ordinary untracked directory", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const firstTarget = join(fixture, "nested-outside-first");
    const secondTarget = join(fixture, "nested-outside-second");
    initializeRepository(root);
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    const container = join(root, "ordinary-container");
    mkdirSync(container);
    const link = join(container, "empty-link");
    symlinkSync(firstTarget, link, process.platform === "win32" ? "junction" : "dir");

    const first = await resolveRepositorySnapshot(root);
    expect(first.dirty).toBe(true);

    writeFileSync(join(firstTarget, "appeared.txt"), "outside content\n", "utf8");
    const addedExternalDescendant = await resolveRepositorySnapshot(root);
    expect(addedExternalDescendant.tree).toBe(first.tree);

    unlinkSync(join(firstTarget, "appeared.txt"));
    const emptyAgain = await resolveRepositorySnapshot(root);
    expect(emptyAgain.tree).toBe(first.tree);

    unlinkSync(link);
    symlinkSync(secondTarget, link, process.platform === "win32" ? "junction" : "dir");
    const retargeted = await resolveRepositorySnapshot(root);
    expect(retargeted.tree).not.toBe(first.tree);
  });

  test("does not let a fake nested .git marker hide sibling indirections or expose targets to Git", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const directTarget = join(fixture, "direct-outside");
    const nestedFirstTarget = join(fixture, "nested-outside-first");
    const nestedSecondTarget = join(fixture, "nested-outside-second");
    initializeRepository(root);
    mkdirSync(directTarget);
    mkdirSync(nestedFirstTarget);
    mkdirSync(nestedSecondTarget);
    writeFileSync(join(directTarget, "direct-secret-a.md"), "outside direct\n", "utf8");

    const directLink = join(root, "direct-link");
    symlinkSync(directTarget, directLink, process.platform === "win32" ? "junction" : "dir");
    const container = join(root, "ordinary-container");
    mkdirSync(join(container, ".git"), { recursive: true });
    const nestedLink = join(container, "empty-link");
    symlinkSync(nestedFirstTarget, nestedLink, process.platform === "win32" ? "junction" : "dir");

    const controller = new AbortController();
    const calls: Array<{ args: string[]; stdin?: Buffer; signal?: AbortSignal }> = [];
    let leakedExternalNamespace = false;
    const runGit: RepositorySnapshotGitRunner = async (repoRoot, args, options) => {
      calls.push({
        args,
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const result = await directSnapshotGit(repoRoot, args, options);
      if (/(?:direct|nested)-secret-[ab]\.md/.test(result.stdout)) {
        leakedExternalNamespace = true;
      }
      return result;
    };

    const first = await resolveRepositorySnapshot(root, {
      runGit,
      signal: controller.signal,
    });
    expect(first.dirty).toBe(true);
    expect(leakedExternalNamespace).toBe(false);
    const fullNamespaceProbes = calls.filter(
      ({ args }) =>
        args[0] === "ls-files" && args.includes("--others") && !args.includes("--directory"),
    );
    expect(fullNamespaceProbes.length).toBe(2);
    expect(
      fullNamespaceProbes.every(
        ({ args }) =>
          args.includes(":(top,exclude,literal)direct-link") &&
          args.includes(":(top,exclude,literal)ordinary-container/empty-link"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ args }) =>
          args[0] === "-C" && isSameCanonicalPath(args[1], container) && args[2] === "rev-parse",
      ),
    ).toBe(true);
    const ignoreProbes = calls.filter(({ args }) => args[0] === "check-ignore");
    expect(ignoreProbes.length).toBeGreaterThan(0);
    expect(ignoreProbes.every(({ stdin }) => Buffer.isBuffer(stdin) && stdin.length > 0)).toBe(
      true,
    );
    expect(ignoreProbes.every(({ signal }) => signal === controller.signal)).toBe(true);

    writeFileSync(join(nestedFirstTarget, "nested-secret-a.md"), "outside nested\n", "utf8");
    const addedNestedExternalDescendant = await resolveRepositorySnapshot(root);
    expect(addedNestedExternalDescendant.tree).toBe(first.tree);
    renameSync(
      join(nestedFirstTarget, "nested-secret-a.md"),
      join(nestedFirstTarget, "nested-secret-b.md"),
    );
    const renamedExternalDescendant = await resolveRepositorySnapshot(root);
    expect(renamedExternalDescendant.tree).toBe(first.tree);
    unlinkSync(join(nestedFirstTarget, "nested-secret-b.md"));
    unlinkSync(join(directTarget, "direct-secret-a.md"));
    const removedExternalDescendants = await resolveRepositorySnapshot(root);
    expect(removedExternalDescendants.tree).toBe(first.tree);
    writeFileSync(join(directTarget, "direct-secret-b.md"), "outside direct again\n", "utf8");
    const addedExternalDescendant = await resolveRepositorySnapshot(root);
    expect(addedExternalDescendant.tree).toBe(first.tree);

    unlinkSync(nestedLink);
    symlinkSync(nestedSecondTarget, nestedLink, process.platform === "win32" ? "junction" : "dir");
    const retargeted = await resolveRepositorySnapshot(root);
    expect(retargeted.tree).not.toBe(first.tree);
  });

  test("fails closed when a fake .git directory is populated only during nested-repository validation", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const outside = join(fixture, "outside-empty");
    initializeRepository(root);
    mkdirSync(outside);
    const container = join(root, "ordinary-container");
    const marker = join(container, ".git");
    mkdirSync(marker, { recursive: true });
    symlinkSync(
      outside,
      join(container, "empty-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let markerPopulated = false;
    let validationInitializations = 0;
    let cleanupBeforeFullListing = 0;

    try {
      await resolveRepositorySnapshot(root, {
        runGit: async (repoRoot, args, options) => {
          if (
            args[0] === "-C" &&
            isSameCanonicalPath(args[1], container) &&
            args[2] === "rev-parse"
          ) {
            git(container, ["init"]);
            markerPopulated = true;
            validationInitializations += 1;
          } else if (
            markerPopulated &&
            args[0] === "ls-files" &&
            args.includes("--others") &&
            !args.includes("--directory")
          ) {
            rmSync(marker, { recursive: true, force: true });
            mkdirSync(marker);
            markerPopulated = false;
            cleanupBeforeFullListing += 1;
          }
          return await directSnapshotGit(repoRoot, args, options);
        },
      });
      throw new Error("expected nested .git classification race to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(validationInitializations).toBe(1);
    // The immediate marker revalidation catches the race before Git can run a
    // full namespace listing or the attacker can restore the empty marker.
    expect(cleanupBeforeFullListing).toBe(0);
  });

  test("treats a parent indirection above tracked paths as one opaque dirty boundary", async () => {
    const fixture = fixtureRoot();
    const root = join(fixture, "repository");
    const firstTarget = join(fixture, "tracked-outside-first");
    const secondTarget = join(fixture, "tracked-outside-second");
    initializeRepository(root);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "priority.md"), "tracked original\n", "utf8");
    git(root, ["add", "docs/priority.md"]);
    git(root, ["commit", "-m", "add tracked indirection fixture"]);
    renameSync(join(root, "docs"), firstTarget);
    mkdirSync(secondTarget);
    writeFileSync(join(secondTarget, "priority.md"), "second tracked target\n", "utf8");
    writeFileSync(join(firstTarget, "hidden-target-name.md"), "opaque target namespace\n", "utf8");
    const link = join(root, "docs");
    symlinkSync(firstTarget, link, process.platform === "win32" ? "junction" : "dir");

    const gitCalls: string[][] = [];
    let leakedTargetNamespace = false;
    const first = await resolveRepositorySnapshot(root, {
      runGit: async (repoRoot, args, options) => {
        gitCalls.push(args);
        const result = await directSnapshotGit(repoRoot, args, options);
        if (result.stdout.includes("hidden-target-name.md")) leakedTargetNamespace = true;
        return result;
      },
    });
    expect(first.dirty).toBe(true);
    const namespaceProbes = gitCalls.filter(
      (args) => args[0] === "ls-files" && args.includes("--directory"),
    );
    expect(namespaceProbes.length).toBe(2);
    expect(namespaceProbes.every((args) => args.includes(":(top,exclude,literal)docs"))).toBe(true);
    expect(leakedTargetNamespace).toBe(false);

    writeFileSync(join(firstTarget, "priority.md"), "changed external tracked bytes\n", "utf8");
    writeFileSync(join(firstTarget, "external-only.md"), "external namespace\n", "utf8");
    const changedExternalTree = await resolveRepositorySnapshot(root);
    expect(changedExternalTree.tree).toBe(first.tree);

    const stagedFixture = join(root, "staged-boundary-fixture.tmp");
    writeFileSync(stagedFixture, "staged replacement\n", "utf8");
    const stagedBlob = git(root, ["hash-object", "-w", "staged-boundary-fixture.tmp"]);
    unlinkSync(stagedFixture);
    git(root, ["update-index", "--cacheinfo", "100644", stagedBlob, "docs/priority.md"]);
    const changedBoundaryIndex = await resolveRepositorySnapshot(root);
    expect(changedBoundaryIndex.tree).not.toBe(first.tree);

    unlinkSync(link);
    symlinkSync(secondTarget, link, process.platform === "win32" ? "junction" : "dir");
    const changedIndirection = await resolveRepositorySnapshot(root);
    expect(changedIndirection.tree).not.toBe(changedBoundaryIndex.tree);
  });

  test("represents a deleted or replaced tracked directory as ordinary dirty state", async () => {
    const root = fixtureRoot();
    initializeRepository(root);
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "priority.md"), "tracked priority\n", "utf8");
    git(root, ["add", "docs/priority.md"]);
    git(root, ["commit", "-m", "add tracked directory fixture"]);

    rmSync(docs, { recursive: true, force: true });
    const deleted = await resolveRepositorySnapshot(root);
    const repeatedDeletion = await resolveRepositorySnapshot(root);
    expect(deleted.dirty).toBe(true);
    expect(repeatedDeletion.tree).toBe(deleted.tree);

    writeFileSync(docs, "untracked replacement file\n", "utf8");
    const replacedByFile = await resolveRepositorySnapshot(root);
    expect(replacedByFile.dirty).toBe(true);
    expect(replacedByFile.tree).not.toBe(deleted.tree);
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
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutDecodeError: false,
            stderrDecodeError: false,
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

  test("serializes Git probes so a failed staged diff cannot leave a sibling stalled", async () => {
    const root = fixtureRoot();
    const commit = "1".repeat(40);
    const tree = "2".repeat(40);
    let stagedStarted = false;
    let unstagedStarted = false;
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
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
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
          if (args[0] === "ls-files" || args[0] === "status") return success("");
          if (args[0] === "diff" && args.includes("--cached")) {
            stagedStarted = true;
            return {
              ...success(""),
              exitCode: 2,
              stderr: "fixture staged diff failure",
            };
          }
          if (args[0] === "diff") {
            unstagedStarted = true;
            return await new Promise<RepositorySnapshotGitResult>(() => undefined);
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected staged diff failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("git_failed");
    }
    expect(stagedStarted).toBe(true);
    expect(unstagedStarted).toBe(false);
  });

  test("passes cancellation to Git and drains a Windows-length abort cleanup", async () => {
    const root = fixtureRoot();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let cleanedUp = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const resolving = resolveRepositorySnapshot(root, {
      signal: controller.signal,
      runGit: async (_repoRoot, _args, options) => {
        observedSignal = options.signal;
        markStarted();
        return await new Promise((_resolveRun, rejectRun) => {
          const onAbort = () => {
            setTimeout(() => {
              cleanedUp = true;
              rejectRun(new Error("fixture Git runner aborted"));
            }, 10_500);
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    });
    await started;
    const abortedAt = Date.now();
    controller.abort(new Error("fixture cancellation"));

    try {
      await resolving;
      throw new Error("expected repository snapshot cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("snapshot_aborted");
    }
    expect(observedSignal).toBe(controller.signal);
    expect(cleanedUp).toBe(true);
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(10_000);
    expect(Date.now() - abortedAt).toBeLessThan(13_500);
  });

  test("does not start filesystem work for a pre-aborted snapshot", async () => {
    const root = fixtureRoot();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let realpathCalls = 0;
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async realpath(path) {
        realpathCalls += 1;
        return await nativeSnapshotFileSystem.realpath(path);
      },
    };

    try {
      await resolveRepositorySnapshot(root, { signal: controller.signal, fileSystem });
      throw new Error("expected pre-aborted snapshot to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("snapshot_aborted");
    }
    expect(realpathCalls).toBe(0);
  });

  test("observes an abort triggered synchronously while filesystem work starts", async () => {
    const root = fixtureRoot();
    const controller = new AbortController();
    let realpathCalls = 0;
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async realpath() {
        realpathCalls += 1;
        controller.abort(new Error("aborted during filesystem start"));
        return await new Promise<string>(() => undefined);
      },
    };
    const startedAt = Date.now();

    try {
      await resolveRepositorySnapshot(root, {
        timeoutMs: 5_000,
        signal: controller.signal,
        fileSystem,
      });
      throw new Error("expected synchronous-start abort to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("snapshot_aborted");
    }
    expect(realpathCalls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("bounds a delayed filesystem open and closes the late handle", async () => {
    const root = fixtureRoot();
    const candidate = join(root, "slow.txt");
    writeFileSync(candidate, "slow fixture\n", "utf8");
    const commit = "1".repeat(40);
    const tree = "2".repeat(40);
    let closeCalls = 0;
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });
    const fileSystem: RepositorySnapshotFileSystem = {
      ...nativeSnapshotFileSystem,
      async open(path, flags) {
        return await new Promise((resolveOpen, rejectOpen) => {
          setTimeout(() => {
            void openPath(path, flags).then((handle) => {
              resolveOpen({
                async stat(options) {
                  return await handle.stat(options);
                },
                async read(buffer, offset, length, position) {
                  return await handle.read(buffer, offset, length, position);
                },
                async close() {
                  closeCalls += 1;
                  await handle.close();
                },
              });
            }, rejectOpen);
          }, 180);
        });
      },
    };
    const startedAt = Date.now();
    try {
      await resolveRepositorySnapshot(root, {
        timeoutMs: 100,
        fileSystem,
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
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
          if (args[0] === "ls-files") {
            if (args.includes("--stage") || args.includes("--directory")) return success("");
            return success("slow.txt\0");
          }
          if (args[0] === "status" || args[0] === "diff") return success("");
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected delayed filesystem open to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("snapshot_timeout");
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(closeCalls).toBe(1);
  });

  test("rejects a dirty transition after an initially clean observation", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "late.txt"), "late fixture\n", "utf8");
    const commit = "4".repeat(40);
    const tree = "5".repeat(40);
    let untrackedListCalls = 0;
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
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
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
          if (args[0] === "status" || args[0] === "diff") return success("");
          if (args[0] === "ls-files") {
            if (args.includes("--stage") || args.includes("--directory")) return success("");
            untrackedListCalls += 1;
            return success(untrackedListCalls === 1 ? "" : "late.txt\0");
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected clean-to-dirty transition to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(untrackedListCalls).toBe(2);
  });

  test("anchors the clean tree lookup to the revision read before capture", async () => {
    const root = fixtureRoot();
    const initialCommit = "7".repeat(40);
    const advancedCommit = "8".repeat(40);
    const initialTree = "9".repeat(40);
    let revisionCalls = 0;
    const calls: string[][] = [];
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"a".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: initialCommit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          calls.push(args);
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") {
            revisionCalls += 1;
            return success(revisionCalls === 1 ? initialCommit : advancedCommit);
          }
          if (key === `rev-parse --verify ${initialCommit}^{tree}`) {
            return success(initialTree);
          }
          if (args[0] === "status" || args[0] === "diff" || args[0] === "ls-files") {
            return success("");
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected concurrent HEAD advance to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
    expect(calls).toContainEqual(["rev-parse", "--verify", `${initialCommit}^{tree}`]);
    expect(calls).not.toContainEqual(["rev-parse", "--verify", "HEAD^{tree}"]);
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
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
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
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
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
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
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
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
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
    writeFileSync(join(root, "--untracked file.bin"), "fixture\n", "utf8");
    const commit = "4".repeat(40);
    const tree = "5".repeat(40);
    let statusCalls = 0;
    let untrackedListCalls = 0;
    const calls: string[][] = [];
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
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
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
          if (args[0] === "status") {
            statusCalls += 1;
            return success("");
          }
          if (args[0] === "diff") return success("");
          if (args[0] === "ls-files") {
            if (args.includes("--stage")) return success("");
            if (args.includes("--directory")) return success("");
            untrackedListCalls += 1;
            if (untrackedListCalls === 2) {
              writeFileSync(join(root, "--untracked file.bin"), "changed\n", "utf8");
            }
            return success("--untracked file.bin\0");
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
    expect(calls.every((args) => args[0] !== "hash-object")).toBe(true);
    expect(calls.every((args) => args[0] !== "sh" && args[0] !== "cmd")).toBe(true);
  });

  test("reports an enumerated untracked path removal as a repository change", async () => {
    const root = fixtureRoot();
    const commit = "9".repeat(40);
    const tree = "a".repeat(40);
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });

    try {
      await resolveRepositorySnapshot(root, {
        resolveIdentity: async () => ({
          repositoryId: `repo_${"b".repeat(64)}`,
          source: "git-common-dir",
          normalizedOrigin: null,
          rootCommit: commit,
          gitCommonDir: join(root, ".git"),
        }),
        runGit: async (_repoRoot, args) => {
          const key = args.join(" ");
          if (key === "rev-parse --show-toplevel") return success(root);
          if (key === "rev-parse --verify HEAD^{commit}") return success(commit);
          if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
          if (args[0] === "status") return success("");
          if (args[0] === "diff") return success("");
          if (args[0] === "ls-files") {
            if (args.includes("--stage")) return success("");
            if (args.includes("--directory")) return success("");
            return success("vanished.txt\0");
          }
          throw new Error(`unexpected Git args: ${key}`);
        },
      });
      throw new Error("expected missing untracked path to fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotError);
      expect((error as RepositorySnapshotError).code).toBe("repository_changed");
    }
  });

  test("rejects structured Git truncation and decode failures", async () => {
    const root = fixtureRoot();
    const commit = "d".repeat(40);
    const tree = "e".repeat(40);
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });

    for (const failure of [
      { field: "stdoutTruncated", code: "git_output_truncated" },
      { field: "stdoutDecodeError", code: "invalid_git_output" },
    ] as const) {
      let code: string | null = null;
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
            if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
            if (args[0] === "status") return success(" M README.md\0");
            if (args[0] === "ls-files") return success("");
            if (args[0] === "diff") {
              return { ...success("partial diff"), [failure.field]: true };
            }
            throw new Error(`unexpected Git args: ${key}`);
          },
        });
      } catch (error) {
        code = error instanceof RepositorySnapshotError ? error.code : null;
      }
      expect(code).toBe(failure.code);
    }
  });

  test("accepts literal marker text and a valid U+FFFD in Git output", async () => {
    const root = fixtureRoot();
    const commit = "1".repeat(40);
    const tree = "2".repeat(40);
    const success = (stdout: string): RepositorySnapshotGitResult => ({
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDecodeError: false,
      stderrDecodeError: false,
      timedOut: false,
      drainTimedOut: false,
    });

    const snapshot = await resolveRepositorySnapshot(root, {
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
        if (key === `rev-parse --verify ${commit}^{tree}`) return success(tree);
        if (args[0] === "ls-files" || args[0] === "status") return success("");
        if (args[0] === "diff" && args.includes("--cached")) return success("");
        if (args[0] === "diff") {
          return success(
            "diff --git a/README.md b/README.md\n+valid replacement �\n+[pushpals: process output truncated]\n",
          );
        }
        throw new Error(`unexpected Git args: ${key}`);
      },
    });
    expect(snapshot.dirty).toBe(true);
  });
});
