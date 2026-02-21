import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import {
  ReviewAgent,
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
        ...silentLogs,
      },
    );

    await agent.poll();
    await agent.poll();

    expect(reviewCalls).toBe(2);
    expect(mergeCalls).toBe(1);
  });

  test("enqueues fallback instruction when reviewer omits fix_instruction", async () => {
    const pr = makePr({ number: 7, html_url: "https://example.com/pr/7" });
    let enqueuedInstruction = "";
    let enqueuedWriteGlobs: string[] = [];
    let enqueuedTaskId = "";
    let enqueuedCompletionBranch = "";
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

  test("parseReviewVerdict uses configured fallback threshold when approved is missing", () => {
    const raw = JSON.stringify({
      score: 8.7,
      summary: "Looks good enough",
      issues: [],
      fix_instruction: "",
    });

    const withHighThreshold = parseReviewVerdict(raw, { fallbackApprovedThreshold: 9.5 });
    const withLowerThreshold = parseReviewVerdict(raw, { fallbackApprovedThreshold: 8.5 });
    const withExplicitFalse = parseReviewVerdict(
      JSON.stringify({
        score: 9.8,
        approved: false,
        summary: "Not approved",
        issues: ["needs work"],
        fix_instruction: "",
      }),
      { fallbackApprovedThreshold: 8.5 },
    );

    expect(withHighThreshold?.approved).toBe(false);
    expect(withLowerThreshold?.approved).toBe(true);
    expect(withExplicitFalse?.approved).toBe(false);
  });
});
