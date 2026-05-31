import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import {
  ReviewAgent,
  buildReviewFeedbackContext,
  buildReviewPrompt,
  buildCodexExecArgs,
  deriveFixWriteGlobsFromDiff,
  parseReviewVerdict,
  resolveCodexCmd,
  resolveReviewerMdPath,
  type ReviewAgentConfig,
} from "../apps/source_control_manager/src/review_agent";
import type { GitHubPR } from "../apps/source_control_manager/src/github_pr";

const baseConfig: ReviewAgentConfig = {
  enabled: true,
  pollIntervalMs: 60_000,
  reviewerMdPath: "prompts/review_agent/reviewer.md",
  passThreshold: 9.5,
  maxPrCommentsBeforeGiveUp: 10,
  mergeMethod: "squash",
  codexBin: "bun x --yes @openai/codex",
  codexAuthMode: "chatgpt",
  codexHomeDir: "",
  codexTimeoutMs: 30_000,
};

function makePr(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 42,
    html_url: "https://example.com/pr/42",
    title: "Add tests",
    body: "<!-- pushpals-jobId: job-1 -->\n<!-- pushpals-sessionId: dev -->",
    state: "open",
    head: {
      ref: "agent/test-branch",
      sha: "abc123def456",
      label: "owner:agent/test-branch",
      ...(overrides.head ?? {}),
    },
    base: {
      ref: "main",
      sha: "ffff1111",
      ...(overrides.base ?? {}),
    },
    ...overrides,
  };
}

const silentLogs = {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
  closePullRequest: async () => ({ state: "closed", closed: true }),
  deleteBranchRef: async () => ({ deleted: true, reason: "deleted" as const }),
};

describe("ReviewAgent", () => {
  test("resolves reviewer markdown path from workspace root", () => {
    const workspaceRoot = resolve(import.meta.dir, "..");
    const reviewerPath = resolveReviewerMdPath("prompts/review_agent/reviewer.md", {
      workspaceRoot,
      cwd: resolve(workspaceRoot, "apps/source_control_manager"),
    });
    expect(reviewerPath).toBe(resolve(workspaceRoot, "prompts/review_agent/reviewer.md"));
  });

  test("resolves reviewer markdown path from embedded prompts root override", () => {
    const previous = process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE;
    const runtimeRoot = resolve(import.meta.dir, "..", "packages", "cli", "runtime");
    process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE = runtimeRoot;
    try {
      const reviewerPath = resolveReviewerMdPath("prompts/review_agent/reviewer.md", {
        workspaceRoot: "B:/compiled/runtime",
        cwd: "C:/Users/data_pi/Documents/programming/SectorCommand",
      });
      expect(reviewerPath).toBe(resolve(runtimeRoot, "prompts", "review_agent", "reviewer.md"));
    } finally {
      if (typeof previous === "string") {
        process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE = previous;
      } else {
        delete process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE;
      }
    }
  });

  test("normalizes bun and bunx codex commands to current Bun executable", () => {
    const bunExec = process.execPath;
    const bunCmd = resolveCodexCmd("bun x --yes @openai/codex");
    expect(bunCmd[0]).toBe(bunExec);
    expect(bunCmd.slice(1)).toEqual(["x", "--yes", "@openai/codex"]);

    const bunxCmd = resolveCodexCmd("bunx --yes @openai/codex");
    expect(bunxCmd[0]).toBe(bunExec);
    expect(bunxCmd.slice(1)).toEqual(["x", "--yes", "@openai/codex"]);
  });

  test("prefers embedded runtime bun executable when provided", () => {
    const previous = process.env.PUSHPALS_BUN_BIN;
    process.env.PUSHPALS_BUN_BIN = "C:/runtime/bin/bun.exe";
    try {
      const bunCmd = resolveCodexCmd("bun x --yes @openai/codex");
      expect(bunCmd[0]).toBe("C:/runtime/bin/bun.exe");
      expect(bunCmd.slice(1)).toEqual(["x", "--yes", "@openai/codex"]);
    } finally {
      if (typeof previous === "string") {
        process.env.PUSHPALS_BUN_BIN = previous;
      } else {
        delete process.env.PUSHPALS_BUN_BIN;
      }
    }
  });

  test("builds review codex args using CLI-compatible approval/sandbox flags", () => {
    const args = buildCodexExecArgs(["bun", "x", "--yes", "@openai/codex"], "/tmp/out.txt");
    expect(args).toContain("-a");
    expect(args).toContain("never");
    expect(args).toContain("-s");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--approval-policy");
    expect(args).not.toContain("--sandbox");
    expect(args).toContain("exec");
  });

  test("builds review prompt with configured score threshold policy", () => {
    const prompt = buildReviewPrompt(
      "Criteria body",
      makePr(),
      "diff --git a/file b/file\n+line",
      8.5,
    );
    expect(prompt).toContain("ReviewAgent approves iff score >= 8.5/10.");
  });

  test("derives scoped write globs from PR diff paths", () => {
    const globs = deriveFixWriteGlobsFromDiff(
      [
        "diff --git a/apps/localbuddy/src/request_status.ts b/apps/localbuddy/src/request_status.ts",
        "diff --git a/tests/localbuddy.request-status.test.ts b/tests/localbuddy.request-status.test.ts",
        "diff --git a/README.md b/README.md",
        'diff --git "a/apps/local buddy/src/space file.ts" "b/apps/local buddy/src/space file.ts"',
      ].join("\n"),
    );
    expect(globs).toContain("apps/localbuddy/**");
    expect(globs).toContain("tests/**");
    expect(globs).toContain("README.md");
    expect(globs).toContain("apps/local buddy/**");
  });

  test("poll uses configured PR base branch", async () => {
    let capturedBase = "";

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "release",
      undefined,
      {
        listOpenPullRequests: async (opts) => {
          capturedBase = opts.base;
          return [];
        },
        ...silentLogs,
      },
    );

    await agent.poll();
    expect(capturedBase).toBe("release");
  });

  test("retries same PR SHA when verdict parsing fails", async () => {
    const pr = makePr();
    let reviewCalls = 0;
    let mergeCalls = 0;
    let commentCalls = 0;

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () => {
          reviewCalls += 1;
          if (reviewCalls === 1) return "not-json";
          return JSON.stringify({
            score: 9.8,
            approved: true,
            summary: "Looks good",
            issues: [],
            fix_instruction: "",
          });
        },
        mergePullRequest: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        getCommitMessage: async () => "feat(test): improve coverage\n- Adds regression assertions",
        addPullRequestComment: async () => {
          commentCalls += 1;
        },
        ...silentLogs,
      },
    );

    await agent.poll();
    await agent.poll();

    expect(reviewCalls).toBe(2);
    expect(commentCalls).toBe(1);
    expect(mergeCalls).toBe(1);
  });

  test("re-reviews the same PR SHA exactly once when re-review is requested", async () => {
    const pr = makePr({ number: 61, html_url: "https://example.com/pr/61" });
    let reviewCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () => {
          reviewCalls += 1;
          return JSON.stringify({
            score: 9.1,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          });
        },
        addPullRequestComment: async () => {},
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
        getCommitMessage: async () => "feat(tests): keep coverage stable",
        ...silentLogs,
      },
    );

    await agent.poll();
    agent.requestReReview(pr.number, pr.head.sha);
    await agent.poll();
    await agent.poll();

    expect(reviewCalls).toBe(2);
  });

  test("caps auto-enqueued re-reviews at 500 per PR", async () => {
    const prNumber = 62;
    let pollCount = 0;
    let jobEnqueueCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => {
          const sha = pollCount.toString(16).padStart(40, "0");
          pollCount += 1;
          return [
            makePr({
              number: prNumber,
              html_url: `https://example.com/pr/${prNumber}`,
              head: { sha },
            }),
          ];
        },
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 7.0,
            summary: "Needs follow-up fixes",
            issues: ["Add missing edge-case assertions"],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        listPullRequestComments: async () => [],
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/jobs/enqueue")) {
            jobEnqueueCalls += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        now: () => 789,
        ...silentLogs,
      },
    );

    for (let i = 0; i < 505; i += 1) {
      await agent.poll();
    }

    expect(jobEnqueueCalls).toBe(500);
  });

  test("skips duplicate fix enqueue when active job already exists for same PR head SHA", async () => {
    const pr = makePr({ number: 77, html_url: "https://example.com/pr/77" });
    let enqueueCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 7.0,
            summary: "Needs follow-up fixes",
            issues: ["Add missing edge-case assertions"],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        listPullRequestComments: async () => [],
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.includes("/jobs?status=pending")) {
            return new Response(
              JSON.stringify({
                ok: true,
                jobs: [
                  {
                    id: "existing-fix-job",
                    kind: "task.execute",
                    params: JSON.stringify({
                      reviewAgent: {
                        prNumber: pr.number,
                        prHeadSha: pr.head.sha,
                      },
                    }),
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            return new Response(JSON.stringify({ ok: true, jobId: "new-job" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
      },
    );

    await agent.poll();
    expect(enqueueCalls).toBe(0);
  });

  test("does not let an active review-fix job suppress merge-conflict repair enqueue", async () => {
    const pr = makePr({ number: 78, html_url: "https://example.com/pr/78" });
    let enqueueCalls = 0;
    let enqueuedResolutionType = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.1,
            summary: "Approved but needs a rebase",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "feat: update app",
        mergePullRequest: async () => {
          throw new Error('GitHub API 405: {"message":"Pull Request is not mergeable"}');
        },
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.includes("/jobs?status=pending")) {
            return new Response(
              JSON.stringify({
                ok: true,
                jobs: [
                  {
                    id: "active-review-fix-job",
                    kind: "task.execute",
                    params: JSON.stringify({
                      reviewAgent: {
                        prNumber: pr.number,
                        prHeadSha: pr.head.sha,
                        resolutionType: "review_fix",
                      },
                    }),
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.includes("/jobs?status=claimed")) {
            return new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200 });
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            const params =
              payload.params && typeof payload.params === "object"
                ? (payload.params as Record<string, unknown>)
                : {};
            const reviewAgent =
              params.reviewAgent && typeof params.reviewAgent === "object"
                ? (params.reviewAgent as Record<string, unknown>)
                : {};
            enqueuedResolutionType = String(reviewAgent.resolutionType ?? "");
            return new Response(JSON.stringify({ ok: true, jobId: "merge-conflict-job" }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(enqueueCalls).toBe(1);
    expect(enqueuedResolutionType).toBe("merge_conflict");
  });

  test("enqueues fallback instruction when reviewer omits fix_instruction", async () => {
    const pr = makePr({ number: 7, html_url: "https://example.com/pr/7" });
    let enqueuedInstruction = "";
    let enqueuedPlannerWorkerInstruction = "";
    let enqueuedWriteGlobs: string[] = [];
    let enqueuedTargetPaths: string[] = [];
    let enqueuedValidationSteps: string[] = [];
    let enqueuedTaskId = "";
    let enqueuedCompletionBranch = "";
    let enqueuedRecentContext: string[] = [];
    let enqueuedDedupeKey = "";
    let enqueuedDedupeCooldownMs = -1;
    let enqueuedResolutionType = "";
    let enqueuedReviewThreshold = 0;
    let enqueuedReviewerFindings: string[] = [];
    let createdTaskTitle = "";
    let createdTaskTags: string[] = [];
    const emittedCommandTypes: string[] = [];

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () =>
          "diff --git a/tests/api/review.test.ts b/tests/api/review.test.ts\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 7.2,
            approved: false,
            summary: "Needs stronger tests",
            issues: ["Missing negative-path assertions"],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        listPullRequestComments: async () => [
          {
            id: 101,
            body: "Please include stronger assertions for malformed payload handling.",
            userLogin: "reviewer-alpha",
            createdAt: "2026-02-20T01:00:00Z",
            htmlUrl: "https://example.com/pr/7#issuecomment-101",
          },
          {
            id: 102,
            body: "Also validate status transitions when no jobs exist.",
            userLogin: "reviewer-beta",
            createdAt: "2026-02-20T02:00:00Z",
            htmlUrl: "https://example.com/pr/7#issuecomment-102",
          },
        ],
        fetchImpl: async (_input, init) => {
          const url = String(_input);
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          if (url.endsWith("/jobs/enqueue")) {
            enqueuedTaskId = String(payload.taskId ?? "");
            enqueuedDedupeKey = String(payload.dedupeKey ?? "");
            enqueuedDedupeCooldownMs = Number(payload.dedupeCooldownMs ?? -1);
            const params =
              payload.params && typeof payload.params === "object"
                ? (payload.params as Record<string, unknown>)
                : {};
            const planning =
              params.planning && typeof params.planning === "object"
                 ? (params.planning as Record<string, unknown>)
                 : {};
             const scope =
               planning.scope && typeof planning.scope === "object"
                 ? (planning.scope as Record<string, unknown>)
                 : {};
             const reviewAgent =
               params.reviewAgent && typeof params.reviewAgent === "object"
                 ? (params.reviewAgent as Record<string, unknown>)
                 : {};
             enqueuedInstruction = String(params.instruction ?? "");
             enqueuedPlannerWorkerInstruction = String(params.plannerWorkerInstruction ?? "");
             enqueuedCompletionBranch = String(params.completionBranch ?? "");
             enqueuedRecentContext = Array.isArray(params.recentContext)
               ? params.recentContext.map((entry) => String(entry))
               : [];
             enqueuedWriteGlobs = Array.isArray(scope.writeGlobs)
               ? scope.writeGlobs.map((entry) => String(entry))
               : [];
             enqueuedTargetPaths = Array.isArray(planning.targetPaths)
               ? planning.targetPaths.map((entry) => String(entry))
               : [];
             enqueuedValidationSteps = Array.isArray(planning.validationSteps)
               ? planning.validationSteps.map((entry) => String(entry))
               : [];
             enqueuedResolutionType = String(reviewAgent.resolutionType ?? "");
             enqueuedReviewThreshold = Number(reviewAgent.reviewThreshold ?? 0);
             enqueuedReviewerFindings = Array.isArray(reviewAgent.reviewerFindings)
               ? reviewAgent.reviewerFindings.map((entry) => String(entry))
               : [];
             return new Response(JSON.stringify({ ok: true, jobId: "job-fix-7" }), { status: 200 });
           }
           if (url.endsWith("/sessions/dev/command")) {
             if (String(payload.type ?? "") === "task_created") {
               const commandPayload =
                  payload.payload && typeof payload.payload === "object"
                    ? (payload.payload as Record<string, unknown>)
                    : {};
                createdTaskTitle = String(commandPayload.title ?? "");
                createdTaskTags = Array.isArray(commandPayload.tags)
                  ? commandPayload.tags.map((entry) => String(entry))
                  : [];
              }
              emittedCommandTypes.push(String(payload.type ?? ""));
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
          return new Response("ok", { status: 200 });
        },
        now: () => 123,
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(enqueuedInstruction).toContain("Address ReviewAgent feedback for PR #7");
    expect(enqueuedInstruction).toContain("Missing negative-path assertions");
    expect(enqueuedTaskId).toBe("review-fix-pr7-123");
    expect(enqueuedDedupeKey).toBe("7:abc123def456");
    expect(enqueuedDedupeCooldownMs).toBe(60_000);
    expect(enqueuedCompletionBranch).toBe("agent/test-branch");
    expect(enqueuedPlannerWorkerInstruction).toContain("Rejected PR revision brief:");
    expect(enqueuedPlannerWorkerInstruction).toContain("Previous ReviewAgent score: 7.2 / 10");
    expect(enqueuedPlannerWorkerInstruction).toContain("Required approval threshold: 9.5 / 10");
    expect(createdTaskTitle).toBe("Address ReviewAgent feedback for PR #7 @ abc123de");
    expect(createdTaskTags).toEqual(["review-agent", "review-fix"]);
    expect(enqueuedWriteGlobs.length).toBeGreaterThan(0);
    expect(enqueuedTargetPaths).toEqual(["tests/api/review.test.ts"]);
    expect(enqueuedValidationSteps).toEqual(["bun test ./tests/api/review.test.ts"]);
    expect(enqueuedResolutionType).toBe("review_fix");
    expect(enqueuedReviewThreshold).toBe(9.5);
    expect(enqueuedReviewerFindings).toEqual(["Missing negative-path assertions"]);
    expect(enqueuedPlannerWorkerInstruction).toContain("Do not return an unchanged branch");
    expect(enqueuedRecentContext).toContain(
      "Review-fix jobs must produce at least one concrete committed change. If a reviewer finding is invalid, make a small code/test/docs update that documents the reason; unchanged branch re-review is refused.",
    );
    expect(enqueuedRecentContext).toContain("Recent PR feedback comments:");
    expect(
      enqueuedRecentContext.some(
        (line) => line.includes("@reviewer-alpha") && line.includes("malformed payload handling"),
      ),
    ).toBe(true);
    expect(
      enqueuedRecentContext.some(
        (line) =>
          line.includes("@reviewer-beta") && line.includes("status transitions when no jobs exist"),
      ),
    ).toBe(true);
    expect(emittedCommandTypes).toEqual(["task_created", "task_started", "job_enqueued"]);
  });

  test("rejection comment includes fallback reasoning when reviewer omits issues", async () => {
    const pr = makePr({ number: 71, html_url: "https://example.com/pr/71" });
    let rejectionCommentBody = "";
    let enqueuedRecentContext: string[] = [];

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 6.9,
            summary: "Not production-ready yet",
            issues: [],
            fix_instruction:
              "Add deterministic failure-path assertions for malformed board ops.\nValidate the telemetry hook payloads with explicit expectations.",
          }),
        addPullRequestComment: async (opts) => {
          rejectionCommentBody = opts.body;
        },
        listPullRequestComments: async () => [],
        fetchImpl: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/jobs/enqueue")) {
            const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            const params =
              payload.params && typeof payload.params === "object"
                ? (payload.params as Record<string, unknown>)
                : {};
            enqueuedRecentContext = Array.isArray(params.recentContext)
              ? params.recentContext.map((entry) => String(entry))
              : [];
            return new Response(JSON.stringify({ ok: true, jobId: "job-fix-71" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        now: () => 456,
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(rejectionCommentBody).toContain("ReviewAgent: Changes Rejected");
    expect(rejectionCommentBody).toContain("Why this was rejected:");
    expect(rejectionCommentBody).toContain(
      "Add deterministic failure-path assertions for malformed board ops.",
    );
    expect(rejectionCommentBody).toContain(
      "Validate the telemetry hook payloads with explicit expectations.",
    );
    expect(enqueuedRecentContext.join("\n")).toContain(
      "Issues: Add deterministic failure-path assertions for malformed board ops.; Validate the telemetry hook payloads with explicit expectations.",
    );
  });

  test("does not emit duplicate session task events when fix enqueue is deduped", async () => {
    const pr = makePr({ number: 8, html_url: "https://example.com/pr/8" });
    let enqueueCalls = 0;
    const emittedCommandTypes: string[] = [];

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 7.1,
            approved: false,
            summary: "Needs work",
            issues: ["add stronger assertions"],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        listPullRequestComments: async () => [],
        fetchImpl: async (_input, init) => {
          const url = String(_input);
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          if (url.includes("/jobs?status=pending") || url.includes("/jobs?status=claimed")) {
            return new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200 });
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            return new Response(
              JSON.stringify({
                ok: true,
                jobId: "existing-fix-job",
                deduped: true,
                message: "Active job already exists for dedupeKey 8:abc123def456",
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/sessions/dev/command")) {
            emittedCommandTypes.push(String(payload.type ?? ""));
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        now: () => 234,
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(enqueueCalls).toBe(1);
    expect(emittedCommandTypes).toEqual([]);
  });

  test("skips overlapping poll ticks", async () => {
    let listCalls = 0;

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => {
          listCalls += 1;
          await Bun.sleep(50);
          return [];
        },
        ...silentLogs,
      },
    );

    await Promise.all([agent.poll(), agent.poll()]);

    expect(listCalls).toBe(1);
  });

  test("approves by score threshold even when reviewer sets approved=false", async () => {
    const pr = makePr({ number: 55, html_url: "https://example.com/pr/55" });
    let mergeCalls = 0;
    let mergeCommitTitle = "";
    let mergeCommitMessage = "";
    let approvalCommentBody = "";
    let commentCalls = 0;
    let enqueueCalls = 0;
    let branchDeleteCalls = 0;
    let deletedBranchRef = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.7,
            approved: false,
            summary: "Good quality overall",
            issues: ["Minor cleanup suggested"],
            fix_instruction: "",
          }),
        getCommitMessage: async () =>
          [
            "feat(local_agent): expand localbuddy test coverage",
            "- A new meaningful test case is added under apps/localbuddy exercising an untested scenario relevant to LocalBuddy.",
            "- All existing and new tests pass and any necessary fixtures/mocks updated accordingly.",
            "",
            "Tests:",
            "- bun --cwd apps/localbuddy test",
          ].join("\n"),
        mergePullRequest: async (opts) => {
          mergeCalls += 1;
          mergeCommitTitle = opts.commitTitle ?? "";
          mergeCommitMessage = opts.commitMessage ?? "";
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        deleteBranchRef: async (opts) => {
          branchDeleteCalls += 1;
          deletedBranchRef = opts.branchRef;
          return { deleted: true, reason: "deleted" as const };
        },
        addPullRequestComment: async (opts) => {
          commentCalls += 1;
          approvalCommentBody = opts.body;
        },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    );

    await agent.poll();

    expect(mergeCalls).toBe(1);
    expect(commentCalls).toBe(1);
    expect(approvalCommentBody).toContain("ReviewAgent: Changes Approved");
    expect(approvalCommentBody).toContain("Verdict:** Good quality overall");
    expect(approvalCommentBody).toContain("Threshold:** 8.5/10");
    expect(approvalCommentBody).toContain("Why this passed:** Score 8.7/10 is >= 8.5/10");
    expect(approvalCommentBody).toContain("Potential Improvements:**");
    expect(approvalCommentBody).toContain("Minor cleanup suggested");
    expect(approvalCommentBody).toContain(
      "This PR met the configured review threshold and is approved for automated merge",
    );
    expect(mergeCommitTitle).toBe("feat(local_agent): expand localbuddy test coverage");
    expect(mergeCommitMessage).toContain(
      "- A new meaningful test case is added under apps/localbuddy",
    );
    expect(mergeCommitMessage).toContain("Tests:\n- bun --cwd apps/localbuddy test");
    expect(mergeCommitMessage).toContain("ReviewAgent:");
    expect(mergeCommitMessage).toContain("passed threshold of 8.5, commit rating 8.7/10");
    expect(mergeCommitMessage).toContain("PR: https://example.com/pr/55");
    expect(enqueueCalls).toBe(0);
    expect(branchDeleteCalls).toBe(1);
    expect(deletedBranchRef).toBe("agent/test-branch");
  });

  test("approval comment includes fallback improvement guidance when reviewer omits issues", async () => {
    const pr = makePr({ number: 72, html_url: "https://example.com/pr/72" });
    let approvalCommentBody = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.9,
            summary: "Ready to merge with one minor follow-up",
            issues: [],
            fix_instruction:
              "Consider tightening malformed payload assertions in a follow-up cleanup.",
          }),
        addPullRequestComment: async (opts) => {
          approvalCommentBody = opts.body;
        },
        getCommitMessage: async () => "feat(client): improve board-op fallback handling",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
      },
    );

    await agent.poll();

    expect(approvalCommentBody).toContain("ReviewAgent: Changes Approved");
    expect(approvalCommentBody).toContain("Potential Improvements:");
    expect(approvalCommentBody).toContain(
      "Consider tightening malformed payload assertions in a follow-up cleanup.",
    );
    expect(approvalCommentBody).not.toContain("None noted by reviewer.");
  });

  test("approval comment falls back to reviewer notes when summary is the only guidance", async () => {
    const pr = makePr({ number: 73, html_url: "https://example.com/pr/73" });
    let approvalCommentBody = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.0,
            summary: "Ready to merge; consider broadening malformed payload coverage later",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async (opts) => {
          approvalCommentBody = opts.body;
        },
        getCommitMessage: async () => "feat(client): keep adapter telemetry stable",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
      },
    );

    await agent.poll();

    expect(approvalCommentBody).toContain("ReviewAgent: Changes Approved");
    expect(approvalCommentBody).toContain("Reviewer Notes:");
    expect(approvalCommentBody).toContain(
      "Ready to merge; consider broadening malformed payload coverage later",
    );
    expect(approvalCommentBody).not.toContain("None noted by reviewer.");
  });

  test("does not delete protected branch main after merge", async () => {
    const pr = makePr({
      number: 63,
      html_url: "https://example.com/pr/63",
      head: { ref: "main", sha: "abc123def456" },
    });
    let branchDeleteCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.2,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "feat(local_agent): preserve quality",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
        deleteBranchRef: async () => {
          branchDeleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(branchDeleteCalls).toBe(0);
  });

  test("does not delete protected branch main_agent after merge", async () => {
    const pr = makePr({
      number: 64,
      html_url: "https://example.com/pr/64",
      head: { ref: "main_agent", sha: "abc123def457" },
      base: { ref: "main" },
    });
    let branchDeleteCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.0,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "feat(local_agent): preserve quality",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
        deleteBranchRef: async () => {
          branchDeleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(branchDeleteCalls).toBe(0);
  });

  test("does not delete protected branch main_agents after merge", async () => {
    const pr = makePr({
      number: 66,
      html_url: "https://example.com/pr/66",
      head: { ref: "main_agents", sha: "abc123def459" },
      base: { ref: "main" },
    });
    let branchDeleteCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.0,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "feat(local_agent): preserve quality",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
        deleteBranchRef: async () => {
          branchDeleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(branchDeleteCalls).toBe(0);
  });

  test("does not delete branch when head ref fails safety validation", async () => {
    const pr = makePr({
      number: 65,
      html_url: "https://example.com/pr/65",
      head: { ref: "agent/unsafe branch", sha: "abc123def458" },
    });
    let branchDeleteCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.1,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "feat(local_agent): preserve quality",
        mergePullRequest: async () => ({ merged: true, sha: "deadbeef", message: "merged" }),
        deleteBranchRef: async () => {
          branchDeleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(branchDeleteCalls).toBe(0);
  });

  test("falls back to PR title merge metadata when head commit message lookup fails", async () => {
    const pr = makePr({
      number: 58,
      html_url: "https://example.com/pr/58",
      title: "Keep tests green",
    });
    let mergeCommitTitle = "";
    let mergeCommitMessage = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.9,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => {
          throw new Error("commit lookup failed");
        },
        getPullRequestCommitMessage: async () => {
          throw new Error("pr commit lookup failed");
        },
        mergePullRequest: async (opts) => {
          mergeCommitTitle = opts.commitTitle ?? "";
          mergeCommitMessage = opts.commitMessage ?? "";
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(mergeCommitTitle).toBe("Keep tests green (#58)");
    expect(mergeCommitMessage).toContain("ReviewAgent:");
    expect(mergeCommitMessage).toContain("passed threshold of 8.5, commit rating 8.9/10");
    expect(mergeCommitMessage).toContain("PR: https://example.com/pr/58");
  });

  test("uses PR commit fallback when head commit lookup fails", async () => {
    const pr = makePr({
      number: 59,
      html_url: "https://example.com/pr/59",
      title: "Fallback title",
    });
    let mergeCommitTitle = "";
    let mergeCommitMessage = "";

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 9.2,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => {
          throw new Error("head lookup failed");
        },
        getPullRequestCommitMessage: async () =>
          [
            "feat(local_agent): fallback commit subject",
            "- Preserved from PR commit list fallback.",
          ].join("\n"),
        mergePullRequest: async (opts) => {
          mergeCommitTitle = opts.commitTitle ?? "";
          mergeCommitMessage = opts.commitMessage ?? "";
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(mergeCommitTitle).toBe("feat(local_agent): fallback commit subject");
    expect(mergeCommitMessage).toContain("- Preserved from PR commit list fallback.");
    expect(mergeCommitMessage).toContain("ReviewAgent:");
    expect(mergeCommitMessage).toContain("passed threshold of 8.5, commit rating 9.2/10");
    expect(mergeCommitMessage).toContain("PR: https://example.com/pr/59");
  });

  test("does not merge when approval comment cannot be posted", async () => {
    const pr = makePr({ number: 57, html_url: "https://example.com/pr/57" });
    let mergeCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.9,
            summary: "Ready to merge",
            issues: [],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {
          throw new Error("comment API failed");
        },
        mergePullRequest: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(mergeCalls).toBe(0);
  });

  test("enqueues dedicated merge-conflict resolution job for approved unmergeable PRs", async () => {
    const pr = makePr({ number: 70, html_url: "https://example.com/pr/70" });
    let reviewCalls = 0;
    let mergeCalls = 0;
    let enqueueCalls = 0;
    let enqueuedTaskId = "";
    let enqueuedDedupeKey = "";
    let enqueuedResolutionType = "";
    let enqueuedInstruction = "";
    let enqueuedPlannerWorkerInstruction = "";
    let enqueuedTargetPaths: string[] = [];
    let enqueuedValidationSteps: string[] = [];
    let createdTaskTitle = "";
    let createdTaskTags: string[] = [];
    const emittedCommandTypes: string[] = [];

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () =>
          "diff --git a/apps/remotebuddy/README.md b/apps/remotebuddy/README.md\n+line",
        invokeCodexReview: async () => {
          reviewCalls += 1;
          return JSON.stringify({
            score: 9.4,
            summary: "Docs update is good",
            issues: [],
            fix_instruction: "",
          });
        },
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "docs(remotebuddy): improve onboarding",
        mergePullRequest: async () => {
          mergeCalls += 1;
          throw new Error(
            'GitHub API 405: {"message":"Pull Request is not mergeable","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}',
          );
        },
        fetchImpl: async (_input, init) => {
          const url = String(_input);
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          if (url.includes("/jobs?status=pending") || url.includes("/jobs?status=claimed")) {
            return new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200 });
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            enqueuedTaskId = String(payload.taskId ?? "");
            enqueuedDedupeKey = String(payload.dedupeKey ?? "");
            const params =
              payload.params && typeof payload.params === "object"
                ? (payload.params as Record<string, unknown>)
                : {};
            enqueuedInstruction = String(params.instruction ?? "");
            enqueuedPlannerWorkerInstruction = String(params.plannerWorkerInstruction ?? "");
            const planning =
              params.planning && typeof params.planning === "object"
                ? (params.planning as Record<string, unknown>)
                : {};
            enqueuedTargetPaths = Array.isArray(planning.targetPaths)
              ? planning.targetPaths.map((entry) => String(entry))
              : [];
            enqueuedValidationSteps = Array.isArray(planning.validationSteps)
              ? planning.validationSteps.map((entry) => String(entry))
              : [];
            const reviewAgent =
              params.reviewAgent && typeof params.reviewAgent === "object"
                ? (params.reviewAgent as Record<string, unknown>)
                : {};
            enqueuedResolutionType = String(reviewAgent.resolutionType ?? "");
            return new Response(JSON.stringify({ ok: true, jobId: "job-merge-70" }), {
              status: 200,
            });
          }
          if (url.endsWith("/sessions/dev/command")) {
            if (String(payload.type ?? "") === "task_created") {
              const commandPayload =
                payload.payload && typeof payload.payload === "object"
                  ? (payload.payload as Record<string, unknown>)
                  : {};
              createdTaskTitle = String(commandPayload.title ?? "");
              createdTaskTags = Array.isArray(commandPayload.tags)
                ? commandPayload.tags.map((entry) => String(entry))
                : [];
            }
            emittedCommandTypes.push(String(payload.type ?? ""));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        now: () => 321,
        ...silentLogs,
      },
    );

    await agent.poll();
    await agent.poll();

    expect(reviewCalls).toBe(1);
    expect(mergeCalls).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(enqueuedTaskId).toBe("review-merge-conflict-pr70-321");
    expect(enqueuedDedupeKey).toBe("70:abc123def456");
    expect(enqueuedResolutionType).toBe("merge_conflict");
    expect(enqueuedInstruction).toContain("Resolve merge conflicts for PR #70");
    expect(enqueuedInstruction).toContain("Do not create a new PR");
    expect(enqueuedPlannerWorkerInstruction).toContain("Existing PR branch: agent/test-branch");
    expect(enqueuedPlannerWorkerInstruction).toContain("Rebase target: main");
    expect(enqueuedPlannerWorkerInstruction).toContain("Expected remote lease SHA: abc123def456");
    expect(enqueuedTargetPaths).toEqual(["apps/remotebuddy/README.md"]);
    expect(enqueuedValidationSteps).toEqual(["bun test"]);
    expect(createdTaskTitle).toBe("Resolve merge conflicts for PR #70 @ abc123de");
    expect(createdTaskTags).toEqual(["review-agent", "merge-conflict"]);
    expect(emittedCommandTypes).toEqual(["task_created", "task_started", "job_enqueued"]);
  });

  test("does not emit duplicate session task events when merge-conflict enqueue is deduped", async () => {
    const pr = makePr({ number: 72, html_url: "https://example.com/pr/72" });
    let reviewCalls = 0;
    let enqueueCalls = 0;
    const emittedCommandTypes: string[] = [];

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () =>
          "diff --git a/apps/remotebuddy/README.md b/apps/remotebuddy/README.md\n+line",
        invokeCodexReview: async () => {
          reviewCalls += 1;
          return JSON.stringify({
            score: 9.3,
            summary: "Looks good",
            issues: [],
            fix_instruction: "",
          });
        },
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "docs(remotebuddy): improve onboarding",
        mergePullRequest: async () => {
          throw new Error(
            'GitHub API 405: {"message":"Pull Request is not mergeable","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}',
          );
        },
        fetchImpl: async (_input, init) => {
          const url = String(_input);
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          if (url.includes("/jobs?status=pending") || url.includes("/jobs?status=claimed")) {
            return new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200 });
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            return new Response(
              JSON.stringify({
                ok: true,
                jobId: "existing-merge-job",
                deduped: true,
                message: "Active job already exists for dedupeKey 72:abc123def456",
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/sessions/dev/command")) {
            emittedCommandTypes.push(String(payload.type ?? ""));
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(reviewCalls).toBe(1);
    expect(enqueueCalls).toBe(1);
    expect(emittedCommandTypes).toEqual([]);
  });

  test("skips duplicate merge-conflict enqueue when matching review job is already active", async () => {
    const pr = makePr({ number: 71, html_url: "https://example.com/pr/71" });
    let reviewCalls = 0;
    let enqueueCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () =>
          "diff --git a/apps/remotebuddy/README.md b/apps/remotebuddy/README.md\n+line",
        invokeCodexReview: async () => {
          reviewCalls += 1;
          return JSON.stringify({
            score: 9.2,
            summary: "Looks solid",
            issues: [],
            fix_instruction: "",
          });
        },
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "docs(remotebuddy): improve onboarding",
        mergePullRequest: async () => {
          throw new Error(
            'GitHub API 405: {"message":"Pull Request is not mergeable","status":"405"}',
          );
        },
        fetchImpl: async (_input) => {
          const url = String(_input);
          if (url.includes("/jobs?status=pending")) {
            return new Response(
              JSON.stringify({
                ok: true,
                jobs: [
                  {
                    id: "existing-merge-job",
                    kind: "task.execute",
                    params: JSON.stringify({
                      reviewAgent: {
                        prNumber: pr.number,
                        prHeadSha: pr.head.sha,
                        resolutionType: "merge_conflict",
                      },
                    }),
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            return new Response(JSON.stringify({ ok: true, jobId: "new-job" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
      },
    );

    await agent.poll();
    await agent.poll();

    expect(reviewCalls).toBe(1);
    expect(enqueueCalls).toBe(0);
  });

  test("rejects when score is below threshold even when reviewer sets approved=true", async () => {
    const pr = makePr({ number: 56, html_url: "https://example.com/pr/56" });
    let mergeCalls = 0;
    let commentCalls = 0;
    let enqueueCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.4,
            approved: true,
            summary: "Close, but not enough",
            issues: ["Edge-case test missing"],
            fix_instruction: "",
          }),
        mergePullRequest: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        addPullRequestComment: async () => {
          commentCalls += 1;
        },
        listPullRequestComments: async () => [],
        fetchImpl: async () => {
          enqueueCalls += 1;
          return new Response(JSON.stringify({ ok: true, jobId: "job-fix-56" }), { status: 200 });
        },
        now: () => 456,
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(mergeCalls).toBe(0);
    expect(commentCalls).toBe(1);
    expect(enqueueCalls).toBeGreaterThan(0);
  });

  test("closes PR and deletes branch when rejection hits configured PR comment cap", async () => {
    const pr = makePr({ number: 67, html_url: "https://example.com/pr/67" });
    let mergeCalls = 0;
    let closeCalls = 0;
    let closedPrNumber = 0;
    let commentCalls = 0;
    let deleteCalls = 0;
    let deletedBranchRef = "";
    let enqueueCalls = 0;

    const comments = Array.from({ length: 10 }, (_, idx) => ({
      id: idx + 1,
      body: `Feedback item ${idx + 1}`,
      userLogin: `reviewer-${idx + 1}`,
      createdAt: `2026-02-20T00:${String(idx).padStart(2, "0")}:00Z`,
      htmlUrl: `https://example.com/comment/${idx + 1}`,
    }));

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5, maxPrCommentsBeforeGiveUp: 10 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 7.9,
            summary: "Major gaps remain",
            issues: ["Expand negative-path coverage"],
            fix_instruction: "",
          }),
        mergePullRequest: async () => {
          mergeCalls += 1;
          return { merged: true, sha: "deadbeef", message: "merged" };
        },
        closePullRequest: async (opts) => {
          closeCalls += 1;
          closedPrNumber = opts.prNumber;
          return { state: "closed", closed: true };
        },
        addPullRequestComment: async () => {
          commentCalls += 1;
        },
        deleteBranchRef: async (opts) => {
          deleteCalls += 1;
          deletedBranchRef = opts.branchRef;
          return { deleted: true, reason: "deleted" as const };
        },
        listPullRequestComments: async () => comments,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    );

    await agent.poll();

    expect(mergeCalls).toBe(0);
    expect(closeCalls).toBe(1);
    expect(closedPrNumber).toBe(pr.number);
    expect(commentCalls).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(deletedBranchRef).toBe(pr.head.ref);
    expect(enqueueCalls).toBe(0);
  });

  test("continues enqueue flow when PR feedback comment lookup fails", async () => {
    const pr = makePr({ number: 66, html_url: "https://example.com/pr/66" });
    let enqueueCalls = 0;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/file b/file\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({
            score: 8.2,
            summary: "Needs more work",
            issues: ["Add stronger edge-case assertions"],
            fix_instruction: "",
          }),
        addPullRequestComment: async () => {},
        listPullRequestComments: async () => {
          throw new Error("temporary github comment API issue");
        },
        fetchImpl: async (_input) => {
          const url = String(_input);
          if (url.endsWith("/jobs/enqueue")) {
            enqueueCalls += 1;
            return new Response(JSON.stringify({ ok: true, jobId: "job-fix-66" }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(enqueueCalls).toBe(1);
  });

  test("buildReviewFeedbackContext excludes configured bodies and truncates long entries", () => {
    const comments = [
      {
        id: 1,
        body: "This exact entry should be excluded.",
        userLogin: "reviewer-1",
        createdAt: "2026-02-20T00:00:00Z",
        htmlUrl: "https://example.com/comment/1",
      },
      {
        id: 2,
        body: "Need stronger assertions on timeout transitions and malformed payload handling. ".repeat(
          12,
        ),
        userLogin: "reviewer-2",
        createdAt: "2026-02-20T00:05:00Z",
        htmlUrl: "https://example.com/comment/2",
      },
    ];

    const context = buildReviewFeedbackContext(comments, ["This exact entry should be excluded."]);

    expect(context[0]).toBe("Recent PR feedback comments:");
    expect(context.some((line) => line.includes("@reviewer-1"))).toBe(false);
    const reviewerLine = context.find((line) => line.includes("@reviewer-2")) ?? "";
    expect(reviewerLine.endsWith("...")).toBe(true);
    expect(reviewerLine.length).toBeLessThanOrEqual(360);
  });

  test("parseReviewVerdict ignores reviewer approved flag and keeps score payload", () => {
    const raw = JSON.stringify({
      score: 8.7,
      approved: false,
      summary: "Looks good enough",
      issues: ["needs follow-up"],
      fix_instruction: "",
    });

    const verdict = parseReviewVerdict(raw);

    expect(verdict?.score).toBe(8.7);
    expect(verdict?.summary).toBe("Looks good enough");
    expect(verdict?.issues).toEqual(["needs follow-up"]);
    expect("approved" in ((verdict as unknown as Record<string, unknown>) ?? {})).toBe(false);
  });

  test("parseReviewVerdict rejects out-of-range score payloads", () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({
        score: 10.5,
        summary: "Invalid score",
        issues: [],
        fix_instruction: "",
      }),
    );

    expect(verdict).toBeNull();
  });
});
