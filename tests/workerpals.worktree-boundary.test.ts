import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildLinuxWorktreeAddArgs, DockerExecutor } from "../apps/workerpals/src/docker_executor";
import { resolveReviewWorktreeBase } from "../apps/workerpals/src/worktree_base_ref";

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout ? Buffer.from(result.stdout).toString("utf8").trim() : "";
  const stderr = result.stderr ? Buffer.from(result.stderr).toString("utf8").trim() : "";
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

describe("workerpals host/container worktree boundary", () => {
  test("worktree add command disables host CRLF conversion before checkout", () => {
    expect(buildLinuxWorktreeAddArgs("C:/repo/.worktrees/job", "abc123")).toEqual([
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "worktree",
      "add",
      "--detach",
      "C:/repo/.worktrees/job",
      "abc123",
    ]);
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest(
    "creates LF-only container-targeted worktrees on a Windows host with autocrlf enabled",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-lf-worktree-"));
      const repo = join(root, "repo");
      const worktree = join(root, "linux-worktree");
      try {
        git(root, ["init", repo]);
        git(repo, ["config", "user.name", "PushPals Test"]);
        git(repo, ["config", "user.email", "pushpals-test@example.com"]);
        git(repo, ["config", "core.autocrlf", "true"]);
        writeFileSync(join(repo, "line-endings.txt"), "one\ntwo\n", "utf8");
        git(repo, ["-c", "core.autocrlf=false", "add", "line-endings.txt"]);
        git(repo, ["commit", "-m", "seed LF file"]);

        const executor = new DockerExecutor({
          repo,
          workerId: "lf-boundary-test",
          imageName: "unused:test",
          baseRef: "HEAD",
        }) as unknown as {
          createWorktree: (path: string, baseRef: string) => Promise<void>;
        };
        await executor.createWorktree(worktree, "HEAD");

        const bytes = readFileSync(join(worktree, "line-endings.txt"));
        expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
        expect(bytes.toString("utf8")).toBe("one\ntwo\n");
        expect(git(worktree, ["config", "--worktree", "--get", "core.autocrlf"])).toBe("false");
        expect(git(worktree, ["config", "--worktree", "--get", "core.eol"])).toBe("lf");
      } finally {
        try {
          git(repo, ["worktree", "remove", "--force", worktree]);
        } catch {
          // The worktree may not have been registered if setup failed.
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  const windowsLinuxContainerTest =
    process.platform === "win32" && process.env.PUSHPALS_WINDOWS_LINUX_WORKTREE_E2E?.trim() === "1"
      ? test
      : test.skip;
  windowsLinuxContainerTest(
    "reads LF bytes and worktree-local Git configuration inside a Linux container",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-lf-container-boundary-"));
      const repo = join(root, "repo");
      const imageName =
        process.env.PUSHPALS_WORKTREE_BOUNDARY_IMAGE?.trim() || "pushpals-worktree-boundary:test";
      try {
        git(root, ["init", repo]);
        git(repo, ["config", "user.name", "PushPals Test"]);
        git(repo, ["config", "user.email", "pushpals-test@example.com"]);
        git(repo, ["config", "core.autocrlf", "true"]);
        writeFileSync(join(repo, "line-endings.txt"), "one\ntwo\n", "utf8");
        git(repo, ["-c", "core.autocrlf=false", "add", "line-endings.txt"]);
        git(repo, ["commit", "-m", "seed LF container boundary"]);

        const executor = new DockerExecutor({
          repo,
          workerId: "lf-container-boundary",
          imageName,
          baseRef: "HEAD",
        });
        await executor.validateLinuxContainerWorktreeBoundary("line-endings.txt");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("review worktree base leases", () => {
  const expectedSha = "a".repeat(40);
  const expectedBaseSha = "b".repeat(40);

  test("seeds review-fix work from the exact verified PR head SHA", async () => {
    const calls: string[][] = [];
    const resolved = await resolveReviewWorktreeBase({
      jobId: "job-review",
      params: {
        reviewAgent: {
          resolutionType: "review_fix",
          prHeadRef: "refs/heads/feature/review",
          prHeadSha: expectedSha,
        },
      },
      git: async (args) => {
        calls.push(args);
        return args[0] === "fetch"
          ? { ok: true, stdout: "", stderr: "" }
          : { ok: true, stdout: `${expectedSha}\n`, stderr: "" };
      },
      fallback: async () => "main_agents",
    });

    expect(resolved).toBe(expectedSha);
    expect(calls).toEqual([
      [
        "fetch",
        "origin",
        "+refs/heads/feature/review:refs/remotes/origin/feature/review",
        "--quiet",
      ],
      ["rev-parse", "--verify", "origin/feature/review^{commit}"],
    ]);
  });

  test("rejects a stale PR-head lease instead of falling back to a generic base", async () => {
    await expect(
      resolveReviewWorktreeBase({
        jobId: "job-conflict",
        params: {
          reviewAgent: {
            resolutionType: "merge_conflict",
            prHeadRef: "feature/conflict",
            prHeadSha: expectedSha,
          },
        },
        git: async (args) =>
          args[0] === "fetch"
            ? { ok: true, stdout: "", stderr: "" }
            : { ok: true, stdout: `${"b".repeat(40)}\n`, stderr: "" },
        fallback: async () => "main_agents",
      }),
    ).rejects.toThrow("stale PR-head lease");
  });

  test("verifies the exact PR base before preparing a merge-conflict rebase", async () => {
    const calls: string[][] = [];
    const resolved = await resolveReviewWorktreeBase({
      jobId: "job-conflict",
      params: {
        reviewAgent: {
          resolutionType: "merge_conflict",
          prHeadRef: "feature/conflict",
          prHeadSha: expectedSha,
          prBaseRef: "main",
          prBaseSha: expectedBaseSha,
        },
      },
      git: async (args) => {
        calls.push(args);
        if (args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
        return {
          ok: true,
          stdout: args[2]?.startsWith("origin/main") ? expectedBaseSha : expectedSha,
          stderr: "",
        };
      },
      fallback: async () => "main_agents",
    });

    expect(resolved).toBe(expectedSha);
    expect(calls).toEqual([
      [
        "fetch",
        "origin",
        "+refs/heads/feature/conflict:refs/remotes/origin/feature/conflict",
        "--quiet",
      ],
      ["rev-parse", "--verify", "origin/feature/conflict^{commit}"],
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--quiet"],
      ["rev-parse", "--verify", "origin/main^{commit}"],
    ]);
  });
});
