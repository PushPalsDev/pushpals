import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

import {
  detectSequencerFlags,
  formatStartupCheckLog,
  runRemoteBuddyPreflight,
  RemoteBuddyPreflightCache,
  type RemoteBuddyPreflightResult,
  type RepoHealthStatus,
  resolveGitDirPath,
  sanitizePreflightDetail,
  type StartupCheckRecord,
} from "./orchestrator_preflight.js";

const tmp = () => mkdtempSync(join(tmpdir(), "preflight-test-"));

const makeRepoStatus = (): RepoHealthStatus => ({
  isDirty: false,
  isMergeInProgress: false,
  branch: "main",
  detail: "clean",
  gitDir: "/tmp/gitdir",
  dirtyFileCount: 0,
  sequencer: {
    isMergeInProgress: false,
    isRebaseInProgress: false,
    isCherryPickInProgress: false,
    isRevertInProgress: false,
    indicators: [],
  },
});

const makeResult = (): RemoteBuddyPreflightResult => ({
  ok: true,
  history: [],
  repoStatus: makeRepoStatus(),
});

describe("resolveGitDirPath", () => {
  test("returns linked worktree gitdir absolute target", () => {
    const repoRoot = tmp();
    const gitStorage = tmp();
    writeFileSync(join(repoRoot, ".git"), `gitdir: ${gitStorage}\n`);
    expect(resolveGitDirPath(repoRoot)).toBe(gitStorage);
  });

  test("resolves relative gitdir pointers for worktrees", () => {
    const repoRoot = tmp();
    const gitContainer = tmp();
    const gitDir = join(gitContainer, "worktrees", "rb");
    mkdirSync(gitDir, { recursive: true });
    const pointer = relative(repoRoot, gitDir);
    writeFileSync(join(repoRoot, ".git"), `gitdir: ${pointer}\n`);
    expect(resolveGitDirPath(repoRoot)).toBe(resolve(repoRoot, pointer));
  });

  test("normalizes gitdir symlink targets via realpath for sequencer checks", () => {
    const repoRoot = tmp();
    const gitStorage = tmp();
    const realGitDir = join(gitStorage, "real.git");
    mkdirSync(realGitDir, { recursive: true });
    const aliasedGitDir = join(gitStorage, "alias.git");
    symlinkSync(realGitDir, aliasedGitDir, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(repoRoot, ".git"), `gitdir: ${aliasedGitDir}\n`);
    expect(resolveGitDirPath(repoRoot)).toBe(realpathSync(realGitDir));
  });
});

describe("detectSequencerFlags", () => {
  test("detects merge/rebase/cherry-pick/revert markers via linked gitdir", () => {
    const repoRoot = tmp();
    const gitStorage = tmp();
    const gitDir = join(gitStorage, "worktrees", "rb");
    mkdirSync(join(gitDir, "rebase-merge"), { recursive: true });
    writeFileSync(join(gitDir, "MERGE_HEAD"), "merge\n");
    writeFileSync(join(gitDir, "CHERRY_PICK_HEAD"), "cherry\n");
    writeFileSync(join(gitDir, "REVERT_HEAD"), "revert\n");
    writeFileSync(join(repoRoot, ".git"), `gitdir: ${gitDir}\n`);

    const resolved = resolveGitDirPath(repoRoot);
    expect(resolved).toBe(gitDir);
    const flags = detectSequencerFlags(resolved);
    expect(flags.isMergeInProgress).toBe(true);
    expect(flags.isRebaseInProgress).toBe(true);
    expect(flags.isCherryPickInProgress).toBe(true);
    expect(flags.isRevertInProgress).toBe(true);
    expect(flags.indicators).toEqual(
      expect.arrayContaining(["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD", "REVERT_HEAD"]),
    );
  });
});

describe("sanitizePreflightDetail", () => {
  test("redacts repo path and collapses whitespace", () => {
    const repo = "/Users/example/project";
    const detail =
      "Dirty worktree in /Users/example/project/apps/remotebuddy\n\nFiles:\nREADME.md secrets.txt";
    const sanitized = sanitizePreflightDetail(detail, repo);
    expect(sanitized.includes("<repo>")).toBe(true);
    expect(sanitized.includes(repo)).toBe(false);
    expect(/\s{2,}/.test(sanitized)).toBe(false);
  });

  test("redacts home directory path even without repo reference", () => {
    const previousHome = process.env.HOME;
    const fakeHome = join(tmp(), "home");
    process.env.HOME = fakeHome;
    try {
      const detail = `Sensitive data at ${join(fakeHome, "secrets.txt")}`;
      const sanitized = sanitizePreflightDetail(detail);
      expect(sanitized.includes(fakeHome)).toBe(false);
      expect(sanitized.includes("~")).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("redacts case-insensitive and slash-variant repo paths", () => {
    const repo = join(tmp(), "ProjectRoot");
    mkdirSync(repo, { recursive: true });
    const windowsVariant = repo.split("/").join("\\");
    const detail = `Dirty paths: ${repo.toUpperCase()}/src/index.ts and ${windowsVariant}\\README.md`;
    const sanitized = sanitizePreflightDetail(detail, repo);
    expect(sanitized.includes("<repo>")).toBe(true);
    expect(new RegExp(repo, "i").test(sanitized)).toBe(false);
  });
});

describe("formatStartupCheckLog", () => {
  test("sanitizes repo paths before logging details", () => {
    const repo = join(tmp(), "project");
    mkdirSync(repo, { recursive: true });
    const record: StartupCheckRecord = {
      code: "startup.repo_dirty",
      label: "Worktree must be clean.",
      category: "repo",
      step: 2,
      status: "fail",
      detail: `Dirty repo at ${join(repo, "secret.txt")}`,
      elapsedMs: 3,
      action: "Clean repo",
    };
    const entry = formatStartupCheckLog(record, { repoRoot: repo, source: "test" });
    expect(entry.detail.includes("<repo>")).toBe(true);
    expect(entry.message.includes(repo)).toBe(false);
    expect(entry.level).toBe("error");
  });

  test("redacts repo variants when composing log message", () => {
    const repo = join(tmp(), "project");
    mkdirSync(repo, { recursive: true });
    const variant = repo.split("/").join("\\").toUpperCase();
    const record: StartupCheckRecord = {
      code: "startup.merge_in_progress",
      label: "Git merge or rebase must be resolved.",
      category: "repo",
      step: 1,
      status: "fail",
      detail: `Merge conflict at ${variant}`,
      elapsedMs: 5,
      action: "Resolve merge state",
    };
    const entry = formatStartupCheckLog(record, { repoRoot: repo, source: "test" });
    expect(entry.detail.includes("<repo>")).toBe(true);
    expect(entry.message.includes(variant)).toBe(false);
  });
});

describe("RemoteBuddyPreflightCache", () => {
  test("expires entries via TTL and supports explicit invalidation", () => {
    let now = 1000;
    const cache = new RemoteBuddyPreflightCache(5_000, () => now);
    const result = makeResult();

    cache.set(result);
    expect(cache.get()).toBe(result);

    cache.invalidate();
    expect(cache.get()).toBeNull();

    cache.set(result);
    now += 6000;
    expect(cache.get()).toBeNull();
  });

  test("explicit invalidation clears cache before next enqueue cycle", () => {
    const cache = new RemoteBuddyPreflightCache(60_000, () => 0);
    const result = makeResult();
    cache.set(result);
    expect(cache.get()).toBe(result);
    cache.invalidate();
    expect(cache.get()).toBeNull();
    const refreshed = makeResult();
    cache.set(refreshed);
    expect(cache.get()).toBe(refreshed);
  });

  test("short TTL avoids stale reuse when repo state changes rapidly", () => {
    let now = 0;
    const cache = new RemoteBuddyPreflightCache(200, () => now);
    const result = makeResult();
    cache.set(result);
    expect(cache.get()).toBe(result);
    now += 210;
    expect(cache.get()).toBeNull();
  });
});

describe("runRemoteBuddyPreflight", () => {
  test("sanitizes failure details before emitting results", async () => {
    const repoRoot = process.cwd();
    const alertDetail = `remote alert referencing ${repoRoot}`;
    const result = await runRemoteBuddyPreflight({
      repoRoot,
      allowDirtyWorktree: true,
      listFiringAlerts: async () => [alertDetail],
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBeDefined();
    const failure = result.failure!;
    expect(failure.detail).toContain("<repo>");
    expect(failure.detail).not.toContain(repoRoot);
    expect(failure.sanitizedDetail).toBe(failure.detail);
    expect(failure.rawDetail).toContain(repoRoot);
  });
});
