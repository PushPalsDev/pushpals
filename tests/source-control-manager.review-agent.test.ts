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

  test("normalizes bun and bunx codex commands to current Bun executable", () => {
    const bunExec = process.execPath;
    const bunCmd = resolveCodexCmd("bun x --yes @openai/codex");
    expect(bunCmd[0]).toBe(bunExec);
    expect(bunCmd.slice(1)).toEqual(["x", "--yes", "@openai/codex"]);

    const bunxCmd = resolveCodexCmd("bunx --yes @openai/codex");
    expect(bunxCmd[0]).toBe(bunExec);
    expect(bunxCmd.slice(1)).toEqual(["x", "--yes", "@openai/codex"]);
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
    const prompt = buildReviewPrompt("Criteria body", makePr(), "diff --git a/file b/file\n+line", 8.5);
    expect(prompt).toContain("ReviewAgent approves iff score >= 8.5/10.");
  });

  test("derives scoped write globs from PR diff paths", () => {
    const globs = deriveFixWriteGlobsFromDiff([
      "diff --git a/apps/localbuddy/src/request_status.ts b/apps/localbuddy/src/request_status.ts",
      "diff --git a/tests/localbuddy.request-status.test.ts b/tests/localbuddy.request-status.test.ts",
      "diff --git a/README.md b/README.md",
      "diff --git \"a/apps/local buddy/src/space file.ts\" \"b/apps/local buddy/src/space file.ts\"",
    ].join("\n"));
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
          return [makePr({ number: prNumber, html_url: `https://example.com/pr/${prNumber}`, head: { sha } })];
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

  test("enqueues fallback instruction when reviewer omits fix_instruction", async () => {
    const pr = makePr({ number: 7, html_url: "https://example.com/pr/7" });
    let enqueuedInstruction = "";
    let enqueuedWriteGlobs: string[] = [];
    let enqueuedTaskId = "";
    let enqueuedCompletionBranch = "";
    let enqueuedRecentContext: string[] = [];
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
            enqueuedInstruction = String(params.instruction ?? "");
            enqueuedCompletionBranch = String(params.completionBranch ?? "");
            enqueuedRecentContext = Array.isArray(params.recentContext)
              ? params.recentContext.map((entry) => String(entry))
              : [];
            enqueuedWriteGlobs = Array.isArray(scope.writeGlobs)
              ? scope.writeGlobs.map((entry) => String(entry))
              : [];
            return new Response(JSON.stringify({ ok: true, jobId: "job-fix-7" }), { status: 200 });
          }
          if (url.endsWith("/sessions/dev/command")) {
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
    expect(enqueuedCompletionBranch).toBe("agent/test-branch");
    expect(enqueuedWriteGlobs.length).toBeGreaterThan(0);
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
        addPullRequestComment: async (opts) => {
          commentCalls += 1;
          approvalCommentBody = opts.body;
        },
        fetchImpl: async () => {
          enqueueCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        ...silentLogs,
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
    expect(approvalCommentBody).toContain("This PR met the configured review threshold and is approved for automated merge");
    expect(mergeCommitTitle).toBe("feat(local_agent): expand localbuddy test coverage");
    expect(mergeCommitMessage).toContain("- A new meaningful test case is added under apps/localbuddy");
    expect(mergeCommitMessage).toContain("Tests:\n- bun --cwd apps/localbuddy test");
    expect(mergeCommitMessage).toContain("ReviewAgent:");
    expect(mergeCommitMessage).toContain("passed threshold of 8.5, commit rating 8.7/10");
    expect(mergeCommitMessage).toContain("PR: https://example.com/pr/55");
    expect(enqueueCalls).toBe(0);
  });

  test("falls back to PR title merge metadata when head commit message lookup fails", async () => {
    const pr = makePr({ number: 58, html_url: "https://example.com/pr/58", title: "Keep tests green" });
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
    const pr = makePr({ number: 59, html_url: "https://example.com/pr/59", title: "Fallback title" });
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
