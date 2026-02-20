import { describe, expect, test } from "bun:test";
import { ReviewAgent, type ReviewAgentConfig } from "../apps/source_control_manager/src/review_agent";
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
          const payload = JSON.parse(String(init?.body ?? "{}")) as {
            params?: { instruction?: string };
          };
          enqueuedInstruction = payload.params?.instruction ?? "";
          return new Response("ok", { status: 200 });
        },
        now: () => 123,
        ...silentLogs,
      },
    );

    await agent.poll();

    expect(enqueuedInstruction).toContain("Address ReviewAgent feedback for PR #7");
    expect(enqueuedInstruction).toContain("Missing negative-path assertions");
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
});
