import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncHiddenRefWithRemoteBranchByRebase } from "../apps/workerpals/src/execute_job";

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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
  };
}

async function mustGit(cwd: string, args: string[], label: string): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error(`${label} failed: git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe("workerpals rebase sync", () => {
  test("syncs hidden ref with pull --rebase and auto-resolves conflicts in worker favor", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-"));
    const remote = join(root, "remote.git");
    const maintainer = join(root, "maintainer");
    const worker = join(root, "worker");
    const branch = "agent/workerpal-test/job-branch";
    const file = "apps/localbuddy/tests/request_status.test.ts";
    const hiddenRef = "refs/pushpals/agent/workerpal-test/job-123";

    try {
      await mustGit(root, ["init", "--bare", remote], "init bare remote");
      await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
      await mustGit(root, ["clone", remote, worker], "clone worker");

      await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
      await mustGit(
        maintainer,
        ["config", "user.email", "pushpals-test@example.com"],
        "set maintainer email",
      );
      await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
      await mustGit(
        worker,
        ["config", "user.email", "pushpals-worker@example.com"],
        "set worker email",
      );

      mkdirSync(join(maintainer, "apps", "localbuddy", "tests"), { recursive: true });
      writeFileSync(join(maintainer, file), "status: base\n", "utf8");
      await mustGit(maintainer, ["add", "-A"], "stage base");
      await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
      await mustGit(
        maintainer,
        ["push", "origin", `HEAD:refs/heads/${branch}`],
        "push base branch",
      );

      await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
      await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");

      writeFileSync(join(worker, file), "status: worker\n", "utf8");
      await mustGit(worker, ["add", "-A"], "stage worker commit");
      await mustGit(worker, ["commit", "-m", "worker change"], "worker commit");
      const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
      await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");
      mkdirSync(join(worker, "workspace"), { recursive: true });
      writeFileSync(join(worker, "workspace", "should-stay-untracked.txt"), "transient\n", "utf8");

      await mustGit(maintainer, ["checkout", "-B", branch, `origin/${branch}`], "maintainer checkout");
      writeFileSync(join(maintainer, file), "status: remote\n", "utf8");
      await mustGit(maintainer, ["add", "-A"], "stage remote commit");
      await mustGit(maintainer, ["commit", "-m", "remote change"], "remote commit");
      await mustGit(maintainer, ["push", "origin", `HEAD:refs/heads/${branch}`], "push remote change");

      const sync = await syncHiddenRefWithRemoteBranchByRebase(
        worker,
        hiddenRef,
        branch,
        "job-12345678",
      );
      expect(sync.ok).toBe(true);
      if (!sync.ok) {
        throw new Error(sync.error);
      }

      const resolvedSha = await mustGit(worker, ["rev-parse", hiddenRef], "resolved hidden ref sha");
      expect(resolvedSha).toBe(sync.sha);
      const resolvedFile = await mustGit(worker, ["show", `${sync.sha}:${file}`], "show resolved file");
      expect(resolvedFile).toContain("status: worker");
      const transientLookup = await git(worker, [
        "show",
        `${sync.sha}:workspace/should-stay-untracked.txt`,
      ]);
      expect(transientLookup.ok).toBe(false);

      const rebaseTempBranches = await mustGit(
        worker,
        ["branch", "--list", "_pushpals/rebase-*"],
        "list temp rebase branches",
      );
      expect(rebaseTempBranches).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
