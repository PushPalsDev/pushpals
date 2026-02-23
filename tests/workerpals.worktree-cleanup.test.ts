import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  forceDeleteWorktreePath,
  windowsDeletionCandidates,
} from "../apps/workerpals/src/common/worktree_cleanup";

describe("workerpals worktree cleanup helpers", () => {
  test("windowsDeletionCandidates includes long-path literal only on Windows", () => {
    const p = process.platform === "win32" ? "C:\\repo\\.worktrees\\job-1" : "/tmp/repo/.worktrees/job-1";
    const candidates = windowsDeletionCandidates(p);
    expect(candidates[0]).toBe(p);
    if (process.platform === "win32") {
      expect(candidates.some((entry) => entry.startsWith("\\\\?\\"))).toBe(true);
    } else {
      expect(candidates.some((entry) => entry.startsWith("\\\\?\\"))).toBe(false);
    }
  });

  test("forceDeleteWorktreePath removes nested directory trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-worktree-cleanup-"));
    const worktree = join(root, "job-abc");
    mkdirSync(join(worktree, "a", "b"), { recursive: true });
    writeFileSync(join(worktree, "a", "b", "file.txt"), "ok", "utf8");

    const result = await forceDeleteWorktreePath(worktree, { retries: 2, delayMs: 1 });
    expect(result.removed).toBe(true);
  });

  test("forceDeleteWorktreePath retries after transient remove failure", async () => {
    let removeCalls = 0;
    let removed = false;
    const removeFn = (_target: string) => {
      removeCalls += 1;
      if (removeCalls === 1) throw new Error("transient lock");
      removed = true;
    };
    const existsFn = (_target: string) => !removed;

    const result = await forceDeleteWorktreePath("C:/fake/worktree", {
      retries: 3,
      delayMs: 1,
      removeFn,
      existsFn,
      sleepFn: async () => {},
    });
    expect(result.removed).toBe(true);
    expect(removeCalls).toBeGreaterThanOrEqual(2);
  });
});
