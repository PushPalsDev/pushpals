import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { GitCommandResult, GitCommandRunner } from "./workspace_probe.js";
import { defaultWorkspaceProbe } from "./workspace_probe.js";

const ok = (stdout = ""): GitCommandResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
});

const fail = (stderr = "fatal: git error"): GitCommandResult => ({
  ok: false,
  stdout: "",
  stderr,
  exitCode: 128,
});

describe("defaultWorkspaceProbe", () => {
  test("reports merge/rebase in progress for directory markers", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "preflight-workspace-"));
    try {
      const gitDir = join(repoRoot, ".git");
      const rebaseMergeDir = join(gitDir, "rebase-merge");
      mkdirSync(rebaseMergeDir, { recursive: true });

      const runner: GitCommandRunner = async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return ok(repoRoot);
        }
        if (args[0] === "rev-parse" && args[1] === "--git-dir") {
          return ok(gitDir);
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok("feature/rebase-detection");
        }
        if (args[0] === "status") {
          return ok("");
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          const marker = args[2];
          if (marker === "rebase-merge") {
            return ok(rebaseMergeDir);
          }
          return ok(join(gitDir, marker));
        }
        return ok("");
      };

      const status = await defaultWorkspaceProbe({
        cwd: repoRoot,
        runGitCommand: runner,
      });
      expect(status.isMergeInProgress).toBe(true);
      expect(status.isDirty).toBe(false);
      expect(status.branch).toBe("feature/rebase-detection");
      expect(status.detail).toContain("rebase-merge");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("uses git-dir fallback when git-path resolution fails", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "preflight-workspace-"));
    try {
      const gitDir = join(repoRoot, ".git");
      mkdirSync(join(gitDir, "rebase-apply"), { recursive: true });
      writeFileSync(join(gitDir, "MERGE_HEAD"), "123");
      writeFileSync(join(gitDir, "CHERRY_PICK_HEAD"), "456");

      const runner: GitCommandRunner = async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return ok(repoRoot);
        }
        if (args[0] === "rev-parse" && args[1] === "--git-dir") {
          return ok(gitDir);
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok("feature/fallback");
        }
        if (args[0] === "status") {
          return ok("");
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          const marker = args[2];
          if (marker === "rebase-apply") {
            return fail("git rev-parse failed");
          }
          if (marker === "MERGE_HEAD") {
            return ok("");
          }
          return ok(join(gitDir, marker));
        }
        return ok("");
      };

      const status = await defaultWorkspaceProbe({
        cwd: repoRoot,
        runGitCommand: runner,
      });
      expect(status.isMergeInProgress).toBe(true);
      expect(status.branch).toBe("feature/fallback");
      expect(status.detail).toContain("rebase-apply");
      expect(status.detail).toContain("merge-head");
      expect(status.detail).toContain("cherry-pick");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
