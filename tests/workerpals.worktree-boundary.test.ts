import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildLinuxWorktreeAddArgs, DockerExecutor } from "../apps/workerpals/src/docker_executor";
import {
  normalizeReviewHeadRef,
  resolveReviewWorktreeBase,
} from "../apps/workerpals/src/worktree_base_ref";

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
    "reads LF bytes and creates hardlinks inside a Windows-host Linux container worktree",
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

  test("canonicalizes safe branch spellings and rejects refspec injection", () => {
    const validCases: Array<[unknown, string]> = [
      ["refs/heads/feature/review", "feature/review"],
      ["origin/feature//review", "feature/review"],
      ["\\feature\\review\\", "feature/review"],
      [" release/next ", "release/next"],
    ];
    for (const [input, expected] of validCases) {
      expect(normalizeReviewHeadRef(input)).toBe(expected);
    }

    for (const input of [
      null,
      123,
      "",
      "../main",
      "feature/../main",
      "feature@{1}",
      "feature.lock",
      "feature.",
      "feature name",
      "feature~1",
      "feature^1",
      "feature:main",
      "feature?main",
      "feature*main",
      "feature[main",
    ]) {
      expect(normalizeReviewHeadRef(input), String(input)).toBeNull();
    }
  });

  test("rejects malformed head leases before Git or fallback can run", async () => {
    const invalidLeases = [
      { prHeadRef: "../main", prHeadSha: expectedSha },
      { prHeadRef: "feature/review", prHeadSha: "a".repeat(39) },
      { prHeadRef: "feature/review", prHeadSha: "g".repeat(40) },
      { prHeadRef: "feature/review", prHeadSha: "a".repeat(65) },
    ];

    for (const lease of invalidLeases) {
      let gitCalls = 0;
      let fallbackCalls = 0;
      await expect(
        resolveReviewWorktreeBase({
          jobId: "job-invalid-lease",
          params: {
            reviewAgent: {
              resolutionType: "review_fix",
              ...lease,
            },
          },
          git: async () => {
            gitCalls += 1;
            return { ok: true };
          },
          fallback: async () => {
            fallbackCalls += 1;
            return "main_agents";
          },
        }),
      ).rejects.toThrow("missing a valid prHeadRef/prHeadSha publication lease");
      expect(gitCalls).toBe(0);
      expect(fallbackCalls).toBe(0);
    }
  });

  test("accepts and normalizes a future 64-character object ID lease", async () => {
    const expectedSha256 = "A".repeat(64);
    const resolved = await resolveReviewWorktreeBase({
      jobId: "job-sha256-review",
      params: {
        reviewAgent: {
          resolutionType: "review_fix",
          prHeadRef: "feature/sha256",
          prHeadSha: expectedSha256,
        },
      },
      git: async (args) =>
        args[0] === "fetch"
          ? { ok: true }
          : { ok: true, stdout: `${expectedSha256.toLowerCase()}\n` },
      fallback: async () => "main_agents",
    });

    expect(resolved).toBe(expectedSha256.toLowerCase());
  });

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

  test("surfaces head fetch and verification failures without using a generic base", async () => {
    let fallbackCalls = 0;
    await expect(
      resolveReviewWorktreeBase({
        jobId: "job-fetch-failure",
        params: {
          reviewAgent: {
            resolutionType: "review_fix",
            prHeadRef: "feature/review",
            prHeadSha: expectedSha,
          },
        },
        git: async () => ({ ok: false, stderr: "remote unavailable" }),
        fallback: async () => {
          fallbackCalls += 1;
          return "main_agents";
        },
      }),
    ).rejects.toThrow("could not refresh origin/feature/review: remote unavailable");

    let calls = 0;
    await expect(
      resolveReviewWorktreeBase({
        jobId: "job-verify-failure",
        params: {
          reviewAgent: {
            resolutionType: "review_fix",
            prHeadRef: "feature/review",
            prHeadSha: expectedSha,
          },
        },
        git: async () => {
          calls += 1;
          return calls === 1 ? { ok: true } : { ok: false, stderr: "missing object" };
        },
        fallback: async () => {
          fallbackCalls += 1;
          return "main_agents";
        },
      }),
    ).rejects.toThrow("could not verify origin/feature/review");
    expect(fallbackCalls).toBe(0);
  });

  test("requires an exact base lease after verifying a merge-conflict head", async () => {
    const calls: string[][] = [];
    await expect(
      resolveReviewWorktreeBase({
        jobId: "job-missing-base",
        params: {
          reviewAgent: {
            resolutionType: "merge_conflict",
            prHeadRef: "feature/conflict",
            prHeadSha: expectedSha,
          },
        },
        git: async (args) => {
          calls.push(args);
          return args[0] === "fetch" ? { ok: true } : { ok: true, stdout: `${expectedSha}\n` };
        },
        fallback: async () => "main_agents",
      }),
    ).rejects.toThrow("missing a valid prBaseRef/prBaseSha lease");
    expect(calls).toHaveLength(2);
  });

  test("surfaces base fetch failures without mutating the leased job", async () => {
    const params: Record<string, unknown> = {
      reviewAgent: {
        resolutionType: "integration_reconcile",
        prHeadRef: "main_agents",
        prHeadSha: expectedSha,
        prBaseRef: "main",
        prBaseSha: expectedBaseSha,
      },
    };
    await expect(
      resolveReviewWorktreeBase({
        jobId: "job-base-fetch-failure",
        params,
        git: async (args) => {
          if (args[0] === "fetch" && args[2]?.includes("refs/heads/main:")) {
            return { ok: false, stderr: "base remote unavailable" };
          }
          return args[0] === "fetch" ? { ok: true } : { ok: true, stdout: `${expectedSha}\n` };
        },
        fallback: async () => "main_agents",
      }),
    ).rejects.toThrow("could not refresh origin/main: base remote unavailable");
    expect((params.reviewAgent as Record<string, unknown>).prBaseSha).toBe(expectedBaseSha);
    expect(
      (params.reviewAgent as Record<string, unknown>).prBaseLeaseRefreshedFrom,
    ).toBeUndefined();
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

  test("refreshes a stale merge-conflict base lease before any worker execution", async () => {
    const currentBaseSha = "c".repeat(40);
    const params: Record<string, unknown> = {
      plannerWorkerInstruction: "Resolve the prepared conflicts.",
      reviewAgent: {
        resolutionType: "merge_conflict",
        prHeadRef: "agent/feature/conflict",
        prHeadSha: expectedSha,
        prBaseRef: "main",
        prBaseSha: expectedBaseSha,
      },
    };
    const messages: string[] = [];

    const resolved = await resolveReviewWorktreeBase({
      jobId: "job-stale-base",
      params,
      git: async (args) => {
        if (args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
        return {
          ok: true,
          stdout: args[2]?.startsWith("origin/main") ? currentBaseSha : expectedSha,
          stderr: "",
        };
      },
      fallback: async () => "main_agents",
      log: (_level, message) => messages.push(message),
    });

    expect(resolved).toBe(expectedSha);
    expect((params.reviewAgent as Record<string, unknown>).prBaseSha).toBe(currentBaseSha);
    expect((params.reviewAgent as Record<string, unknown>).prBaseLeaseRefreshedFrom).toBe(
      expectedBaseSha,
    );
    expect(String(params.plannerWorkerInstruction)).toContain(
      `advanced from ${expectedBaseSha} to ${currentBaseSha}`,
    );
    expect(messages.join("\n")).toContain("refreshed stale base lease");
  });

  test("detects real remote head movement between queueing and worker preparation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-review-lease-drift-"));
    const repo = join(root, "repo");
    const origin = join(root, "origin.git");
    let fallbackCalls = 0;
    try {
      git(root, ["init", "--bare", origin]);
      git(root, ["init", repo]);
      git(repo, ["config", "user.name", "PushPals Test"]);
      git(repo, ["config", "user.email", "pushpals-test@example.com"]);
      git(repo, ["branch", "-M", "feature/review"]);
      writeFileSync(join(repo, "review.txt"), "queued\n", "utf8");
      git(repo, ["add", "review.txt"]);
      git(repo, ["commit", "-m", "seed review head"]);
      git(repo, ["remote", "add", "origin", origin]);
      git(repo, ["push", "origin", "feature/review"]);
      const queuedHead = git(repo, ["rev-parse", "HEAD"]).toLowerCase();
      const params = {
        reviewAgent: {
          resolutionType: "review_fix",
          prHeadRef: "feature/review",
          prHeadSha: queuedHead,
        },
      };
      const runGit = async (args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          ok: result.exitCode === 0,
          stdout: result.stdout ? Buffer.from(result.stdout).toString("utf8") : "",
          stderr: result.stderr ? Buffer.from(result.stderr).toString("utf8") : "",
        };
      };
      const fallback = async () => {
        fallbackCalls += 1;
        return "main_agents";
      };

      await expect(
        resolveReviewWorktreeBase({
          jobId: "job-real-lease",
          params,
          git: runGit,
          fallback,
        }),
      ).resolves.toBe(queuedHead);

      writeFileSync(join(repo, "review.txt"), "advanced\n", "utf8");
      git(repo, ["add", "review.txt"]);
      git(repo, ["commit", "-m", "advance review head"]);
      git(repo, ["push", "origin", "feature/review"]);
      const advancedHead = git(repo, ["rev-parse", "HEAD"]).toLowerCase();
      expect(advancedHead).not.toBe(queuedHead);

      await expect(
        resolveReviewWorktreeBase({
          jobId: "job-real-stale-lease",
          params,
          git: runGit,
          fallback,
        }),
      ).rejects.toThrow(`expected ${queuedHead}, but origin/feature/review is ${advancedHead}`);
      expect(fallbackCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
