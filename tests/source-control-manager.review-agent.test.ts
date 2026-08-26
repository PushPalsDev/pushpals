import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  ReviewAgent,
  buildReviewFeedbackContext,
  buildReviewPrompt,
  buildCodexExecArgs,
  collectReviewHygieneIssuesFromDiff,
  deriveFixWriteGlobsFromDiff,
  deriveReviewTaskValidationSteps,
  listPersistedPrLinks,
  parseReviewVerdict,
  resolveCodexCmd,
  resolveReviewerMdPath,
  summarizeRepeatedReviewFindings,
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
      repo: {
        full_name: "org/repo",
        name: "repo",
        owner: { login: "org" },
      },
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
  listRecentlyClosedPullRequests: async () => [],
  listPersistedPrLinks: async () => ({ links: [], nextCursor: null }),
  feedbackFetchImpl: async () =>
    new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 }),
  sleep: async () => {},
  closePullRequest: async () => ({ state: "closed", closed: true }),
  deleteBranchRef: async () => ({ deleted: true, reason: "deleted" as const }),
};

describe("ReviewAgent", () => {
  test("bounds an injected server fetch when response headers never arrive", async () => {
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        httpTimeoutMs: 20,
        fetchImpl: async () => new Promise<Response>(() => {}),
      },
    );

    await expect((agent as any).sendSessionCommand("dev", {}, { type: "review" })).rejects.toThrow(
      "ReviewAgent HTTP request timed out after 20ms",
    );
  });

  test("cancels an injected server response body that never completes", async () => {
    let bodyCancelled = false;
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        httpTimeoutMs: 20,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Deliberately leave the response body open.
              },
              cancel() {
                bodyCancelled = true;
              },
            }),
            { status: 200 },
          ),
      },
    );

    await expect((agent as any).sendSessionCommand("dev", {}, { type: "review" })).rejects.toThrow(
      "ReviewAgent HTTP request timed out after 20ms",
    );
    expect(bodyCancelled).toBe(true);
  });

  test("rejects an oversized injected server response before parsing", async () => {
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        httpMaxResponseBytes: 4,
        fetchImpl: async () => new Response("12345", { status: 200 }),
      },
    );

    await expect((agent as any).sendSessionCommand("dev", {}, { type: "review" })).rejects.toThrow(
      "HTTP response exceeded 4 byte buffer limit",
    );
  });

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

  test("derives review-job validation from the target repository instead of PushPals", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-review-validation-"));
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(
        join(root, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
        "utf8",
      );
      writeFileSync(join(root, "tests", "test_review.py"), "def test_review(): pass\n", "utf8");
      expect(deriveReviewTaskValidationSteps(["tests/test_review.py"], root)).toEqual([
        "python -m pytest tests/test_review.py",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not reject helpers or product-name references without evidence of a leak", () => {
    const issues = collectReviewHygieneIssuesFromDiff(
      [
        "diff --git a/.gitignore b/.gitignore",
        "+node_modules",
        "diff --git a/tests/workflow.test.ts b/tests/workflow.test.ts",
        "+test('queue_health workerpal diagnostics are visible', () => {})",
        "diff --git a/utils/retryHelper.ts b/utils/retryHelper.ts",
        "+export function retryHelper() { return true; }",
      ].join("\n"),
    );

    expect(issues.some((issue) => issue.includes(".gitignore"))).toBe(false);
    expect(issues.some((issue) => issue.includes("private monorepo"))).toBe(false);
    expect(issues.some((issue) => issue.includes("runtime integration"))).toBe(false);
  });

  test("distinguishes private source-layout leaks from legitimate PushPals integration", () => {
    const publicIntegration = collectReviewHygieneIssuesFromDiff(
      [
        "diff --git a/tests/pushpals-cli.test.ts b/tests/pushpals-cli.test.ts",
        "+import { runCli } from '@pushpalsdev/cli';",
        "+test('pushpals CLI starts', () => runCli());",
      ].join("\n"),
      { repositoryIdentity: "https://github.com/example/product.git" },
    );
    expect(publicIntegration).toEqual([]);

    const privateLayoutDiff = [
      "diff --git a/tests/orchestration.test.ts b/tests/orchestration.test.ts",
      "+import { executeJob } from '../apps/workerpals/src/execute_job';",
      "+test('runs internal worker', () => executeJob());",
    ].join("\n");
    const externalLeak = collectReviewHygieneIssuesFromDiff(privateLayoutDiff, {
      repositoryIdentity: "git@github.com:example/product.git",
    });
    expect(externalLeak.some((issue) => issue.includes("private monorepo source layout"))).toBe(
      true,
    );

    const selfRepoChange = collectReviewHygieneIssuesFromDiff(privateLayoutDiff, {
      repositoryIdentity: "https://github.com/PushPalsDev/pushpals.git",
    });
    expect(selfRepoChange).toEqual([]);
  });

  test("allows legitimate dependency ignore policy changes", () => {
    const issues = collectReviewHygieneIssuesFromDiff(
      [
        "diff --git a/.gitignore b/.gitignore",
        "--- a/.gitignore",
        "+++ b/.gitignore",
        "+node_modules/",
        "+vendor/",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
  });

  test("detects removed test declarations across common language families", () => {
    const declarations = [
      "test('works', () => {})",
      "def test_works():",
      "func TestWorks(t *testing.T) {",
      "#[test]",
      "@Test",
      "[Fact]",
      "it('works') { true }",
      "public function testWorks() {",
      "func testWorks() throws {",
    ];
    for (const declaration of declarations) {
      const removed = collectReviewHygieneIssuesFromDiff(
        [
          "diff --git a/tests/example.txt b/tests/example.txt",
          `-${declaration}`,
          `-${declaration}`,
          `-${declaration}`,
        ].join("\n"),
      );
      expect(removed.some((issue) => issue.includes("existing test declarations"))).toBe(true);

      const intentionalRemoval = collectReviewHygieneIssuesFromDiff(
        [
          "diff --git a/tests/example.txt b/tests/example.txt",
          `-${declaration}`,
          `-${declaration}`,
          `-${declaration}`,
        ].join("\n"),
        { taskIntent: "Refactor and replace obsolete test coverage" },
      );
      expect(intentionalRemoval.some((issue) => issue.includes("existing test declarations"))).toBe(
        false,
      );

      const replaced = collectReviewHygieneIssuesFromDiff(
        [
          "diff --git a/tests/example.txt b/tests/example.txt",
          `-${declaration}`,
          `-${declaration}`,
          `-${declaration}`,
          `+${declaration}`,
          `+${declaration}`,
          `+${declaration}`,
        ].join("\n"),
      );
      expect(replaced.some((issue) => issue.includes("existing test declarations"))).toBe(false);
    }
  });

  test("recognizes test and helper paths across common repository ecosystems", () => {
    const fixtures = [
      ["tests/retry.test.ts", "src/helpers/retry.ts"],
      ["tests/test_retry.py", "src/helpers/retry.py"],
      ["internal/retry_test.go", "internal/helpers/retry.go"],
      ["tests/retry.rs", "src/utils/retry.rs"],
      ["src/test/java/RetryTest.java", "src/main/java/helpers/Retry.java"],
      ["tests/RetryTests.cs", "src/Helpers/Retry.cs"],
      ["spec/retry_spec.rb", "lib/helpers/retry.rb"],
      ["tests/RetryTest.php", "src/Helpers/Retry.php"],
      ["Tests/AppTests/RetryTests.swift", "Sources/App/Helpers/Retry.swift"],
    ];
    for (const [testPath, helperPath] of fixtures) {
      const issues = collectReviewHygieneIssuesFromDiff(
        [
          `diff --git a/${testPath} b/${testPath}`,
          "+test coverage",
          `diff --git a/${helperPath} b/${helperPath}`,
          "+helper implementation",
        ].join("\n"),
      );
      expect(issues.some((issue) => issue.includes("runtime integration"))).toBe(false);
    }

    const integrated = collectReviewHygieneIssuesFromDiff(
      [
        "diff --git a/tests/test_retry.py b/tests/test_retry.py",
        "+def test_retry(): pass",
        "diff --git a/src/helpers/retry.py b/src/helpers/retry.py",
        "+def retry(): pass",
        "diff --git a/src/services/import_service.py b/src/services/import_service.py",
        "+retry()",
      ].join("\n"),
    );
    expect(integrated.some((issue) => issue.includes("runtime integration"))).toBe(false);
  });

  test("summarizes repeated review findings as hard constraints", () => {
    const summary = summarizeRepeatedReviewFindings({
      currentFindings: ["The new helper is still unintegrated and only referenced by tests."],
      previousFeedback: [
        "ReviewAgent: helper is not integrated into runtime behavior.",
        "ReviewAgent: unused helper only referenced by tests.",
        "ReviewAgent: this revision still has duplicate tests.",
      ],
    });

    expect(summary.shouldGiveUp).toBe(true);
    expect(summary.issues[0]).toContain("Repeated unresolved ReviewAgent finding");
    expect(summary.repeatedThemeKeys).toContain("unintegrated-helper");
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

  test("retains independent provider scan cursors between bounded polls", async () => {
    let now = Date.parse("2026-08-25T18:00:00.000Z");
    const openCursors: Array<{ page: number; offset: number } | null | undefined> = [];
    const closedCursors: Array<{ page: number; offset: number } | null | undefined> = [];
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => now,
        listOpenPullRequests: async (opts) => {
          openCursors.push(opts.cursor);
          opts.onScanComplete?.({ page: 5, offset: 0 });
          return [];
        },
        listRecentlyClosedPullRequests: async (opts) => {
          closedCursors.push(opts.cursor);
          opts.onScanComplete?.({ page: 9, offset: 25 });
          return [];
        },
      },
    );

    await agent.poll();
    now += 60_000;
    await agent.poll();

    expect(openCursors).toEqual([null, { page: 5, offset: 0 }]);
    expect(closedCursors).toEqual([null, { page: 9, offset: 25 }]);
  });

  test("keeps provider reconciliation active with AI review disabled and a custom branch prefix", async () => {
    const externallyMergedPr = makePr({
      number: 80,
      state: "closed",
      merged_at: "2026-08-25T17:00:00.000Z",
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
      head: {
        ref: "automation/merged-branch",
        sha: "external-merge-sha",
        label: "org:automation/merged-branch",
      },
    });
    let openListCalls = 0;
    let capturedClosedPrefix = "";
    let now = Date.parse("2026-08-25T18:00:00.000Z");
    const feedbackPayloads: Array<Record<string, unknown>> = [];

    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => now,
        listOpenPullRequests: async () => {
          openListCalls += 1;
          return [];
        },
        listRecentlyClosedPullRequests: async (opts) => {
          capturedClosedPrefix = opts.headPrefix;
          return [externallyMergedPr];
        },
        feedbackFetchImpl: async (_input, init) => {
          feedbackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, ignored: true, acknowledged: true }), {
            status: 200,
          });
        },
      },
      "automation/",
    );

    await agent.poll();
    now += 60_000;
    await agent.poll();

    expect(openListCalls).toBe(0);
    expect(capturedClosedPrefix).toBe("automation/");
    expect(feedbackPayloads).toHaveLength(1);
    expect(feedbackPayloads[0]).toMatchObject({
      feedbackKey: "review_agent:pr:80:head:external-merge-sha:state:merged:job:job-1",
      verdict: "approved_merged",
    });
  });

  test("enables AI review in place without losing provider or re-review state", async () => {
    let openListCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/example/repository.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => {
          openListCalls += 1;
          return [];
        },
      },
    );
    agent.requestReReview(42, "head-sha");
    const forceReReview = (agent as any).forceReReview;

    await agent.poll();
    expect(openListCalls).toBe(0);

    expect(agent.updateRuntimeConfig({ ...baseConfig, enabled: true })).toEqual({
      becameEnabled: true,
    });
    expect((agent as any).forceReReview).toBe(forceReReview);
    expect((agent as any).forceReReview.get(42)).toBe("head-sha");
    await agent.poll();
    expect(openListCalls).toBe(1);

    expect(agent.updateRuntimeConfig({ ...baseConfig, enabled: false })).toEqual({
      becameEnabled: false,
    });
    await agent.poll();
    expect(openListCalls).toBe(1);
  });

  test("exposes provider reconciliation failures and resets them after recovery", async () => {
    let now = Date.parse("2026-08-25T18:00:00.000Z");
    let providerUnavailable = true;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/example/repository.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => now,
        listRecentlyClosedPullRequests: async () => {
          if (providerUnavailable) throw new Error("provider unavailable");
          return [];
        },
      },
    );

    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "idle",
      consecutiveFailedPolls: 0,
      failureEvents: 0,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await agent.poll();
      expect(agent.getProviderHealthSnapshot()).toMatchObject({
        status: "degraded",
        consecutiveFailedPolls: attempt,
        failureEvents: attempt,
        lastError: expect.stringContaining("provider unavailable"),
      });
      now += 60_000;
    }

    providerUnavailable = false;
    await agent.poll();
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "ok",
      pollAgeMs: 0,
      stalled: false,
      consecutiveFailedPolls: 0,
      failureEvents: 3,
      lastError: null,
      lastSuccessfulPollAt: expect.any(String),
    });
  });

  test("marks an old in-flight provider poll stalled until it completes", async () => {
    let nowMs = 0;
    let releaseProviderPoll!: () => void;
    const providerPollGate = new Promise<void>((resolve) => {
      releaseProviderPoll = resolve;
    });
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/example/repository.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => {
          await providerPollGate;
          return [];
        },
        listPersistedPrLinks: async () => ({ links: [], nextCursor: null }),
      },
    );

    const activePoll = agent.poll();
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "running",
      inFlight: true,
      pollAgeMs: 0,
      stalled: false,
    });

    nowMs = 299_999;
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "running",
      pollAgeMs: 299_999,
      stalled: false,
    });
    nowMs = 300_000;
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "stalled",
      inFlight: true,
      pollAgeMs: 300_000,
      stalled: true,
    });

    releaseProviderPoll();
    await activePoll;
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      status: "ok",
      inFlight: false,
      pollAgeMs: 0,
      stalled: false,
    });
  });

  test("stopAndDrain blocks replacement until active polls settle and rejects new work", async () => {
    let providerPollCalls = 0;
    let releaseProviderPoll!: () => void;
    const providerPollGate = new Promise<void>((resolve) => {
      releaseProviderPoll = resolve;
    });
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/example/repository.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listRecentlyClosedPullRequests: async () => {
          providerPollCalls += 1;
          await providerPollGate;
          return [];
        },
        listPersistedPrLinks: async () => ({ links: [], nextCursor: null }),
      },
    );

    const activePoll = agent.poll();
    expect(providerPollCalls).toBe(1);
    let drainCompleted = false;
    const draining = agent.stopAndDrain().then(() => {
      drainCompleted = true;
    });
    await Bun.sleep(0);
    expect(drainCompleted).toBe(false);

    agent.requestReReview(42, "late-sha");
    expect(agent.updateRuntimeConfig({ ...baseConfig, enabled: true })).toEqual({
      becameEnabled: false,
    });
    await agent.poll();
    expect(providerPollCalls).toBe(1);
    expect((agent as any).forceReReview.has(42)).toBe(false);

    releaseProviderPoll();
    await Promise.all([activePoll, draining]);
    expect(drainCompleted).toBe(true);
    await agent.poll();
    expect(providerPollCalls).toBe(1);
  });

  test("uses the configured branch prefix for open PR review polling", async () => {
    let capturedOpenPrefix = "";
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async (opts) => {
          capturedOpenPrefix = opts.headPrefix;
          return [];
        },
      },
      "pushpals-bot/",
    );

    await agent.poll();

    expect(capturedOpenPrefix).toBe("pushpals-bot/");
  });

  test("reconciles recently closed provider outcomes once with provider terminal timestamps", async () => {
    const mergedPr = makePr({
      number: 81,
      html_url: "https://github.com/org/repo/pull/81",
      state: "closed",
      merged_at: "2026-08-25T17:00:00.000Z",
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:30:00.000Z",
      body: "<!-- pushpals-jobId: job-merged -->\n<!-- pushpals-sessionId: session-merged -->",
      head: {
        ref: "agent/merged-branch",
        sha: "merged123",
        label: "org:agent/merged-branch",
      },
    });
    const closedPr = makePr({
      number: 82,
      html_url: "https://github.com/org/repo/pull/82",
      state: "closed",
      merged_at: null,
      closed_at: "2026-08-25T17:05:00.000Z",
      updated_at: "2026-08-25T17:35:00.000Z",
      body: "<!-- pushpals-jobId: job-closed -->\n<!-- pushpals-sessionId: session-closed -->",
      head: {
        ref: "agent/closed-branch",
        sha: "closed123",
        label: "org:agent/closed-branch",
      },
    });
    const unmanagedPr = makePr({
      number: 83,
      state: "closed",
      merged_at: "2026-08-25T17:10:00.000Z",
      updated_at: "2026-08-25T17:10:00.000Z",
      body: null,
    });
    const feedbackPayloads: Array<Record<string, unknown>> = [];
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    const deletedBranches: string[] = [];

    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listOpenPullRequests: async () => [],
        listRecentlyClosedPullRequests: async () => [mergedPr, closedPr, unmanagedPr],
        feedbackFetchImpl: async (_input, init) => {
          feedbackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 });
        },
        deleteBranchRef: async (opts) => {
          deletedBranches.push(opts.branchRef);
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();
    await agent.poll();

    expect(feedbackPayloads).toHaveLength(2);
    expect(feedbackPayloads[0]).toMatchObject({
      feedbackKey: "review_agent:pr:81:head:merged123:state:merged:job:job-merged",
      jobId: "job-merged",
      sessionId: "session-merged",
      prNumber: 81,
      verdict: "approved_merged",
      providerStateAt: "2026-08-25T17:00:00.000Z",
    });
    expect(feedbackPayloads[1]).toMatchObject({
      feedbackKey: "review_agent:pr:82:head:closed123:state:closed_unmerged:job:job-closed",
      jobId: "job-closed",
      sessionId: "session-closed",
      prNumber: 82,
      verdict: "closed_unmerged",
      providerStateAt: "2026-08-25T17:05:00.000Z",
    });
    expect(deletedBranches).toEqual(["agent/merged-branch", "agent/closed-branch"]);
  });

  test("retries ignored feedback and only acknowledges a closed PR after server acceptance", async () => {
    const pr = makePr({
      number: 84,
      state: "closed",
      merged_at: "2026-08-25T17:00:00.000Z",
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
    });
    let feedbackCalls = 0;
    let deleteCalls = 0;
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listOpenPullRequests: async () => [],
        listRecentlyClosedPullRequests: async () => [pr],
        feedbackFetchImpl: async () => {
          feedbackCalls += 1;
          if (feedbackCalls === 1) return new Response("unavailable", { status: 503 });
          if (feedbackCalls === 2) {
            return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 });
        },
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();
    nowMs += 60_001;
    await agent.poll();

    expect(feedbackCalls).toBe(3);
    expect(deleteCalls).toBe(1);
  });

  test("prioritizes unseen closed outcomes over backed-off ignored outcomes", async () => {
    const prs = Array.from({ length: 9 }, (_, index) =>
      makePr({
        number: 200 + index,
        state: "closed",
        merged_at: "2026-08-25T17:00:00.000Z",
        closed_at: "2026-08-25T17:00:00.000Z",
        updated_at: "2026-08-25T17:00:00.000Z",
        body: `<!-- pushpals-jobId: job-${index} -->\n<!-- pushpals-sessionId: dev -->`,
        head: {
          ref: `agent/starvation-${index}`,
          sha: `starvation-sha-${index}`,
          label: `org:agent/starvation-${index}`,
        },
      }),
    );
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    const attemptedJobIds: string[] = [];
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => prs,
        feedbackFetchImpl: async (_input, init) => {
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const jobId = String(payload.jobId ?? "");
          attemptedJobIds.push(jobId);
          return new Response(
            JSON.stringify(
              jobId === "job-8" ? { ok: true, ignored: false } : { ok: true, ignored: true },
            ),
            { status: 200 },
          );
        },
      },
    );

    await agent.poll();
    nowMs += 60_001;
    await agent.poll();

    expect(attemptedJobIds.slice(0, 8)).toEqual([
      "job-0",
      "job-1",
      "job-2",
      "job-3",
      "job-4",
      "job-5",
      "job-6",
      "job-7",
    ]);
    expect(attemptedJobIds).toContain("job-8");
  });

  test("recovers old markerless PR outcomes from persisted job links", async () => {
    const persistedPr = makePr({
      number: 240,
      html_url: "https://github.com/org/repo/pull/240",
      body: null,
      state: "closed",
      merged_at: "2026-01-01T00:00:00.000Z",
      closed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const feedbackPayloads: Array<Record<string, unknown>> = [];
    const persistedPageUrls: string[] = [];
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => [],
        listPersistedPrLinks,
        getPullRequest: async () => persistedPr,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/jobs/pr-links")) {
            persistedPageUrls.push(url);
            if (persistedPageUrls.length > 1) {
              return Response.json({ ok: true, links: [], nextCursor: null });
            }
            return Response.json({
              ok: true,
              links: [
                {
                  jobId: "persisted-job-240",
                  sessionId: "persisted-session",
                  prUrl: persistedPr.html_url,
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
                {
                  jobId: "different-repo-job",
                  sessionId: "other",
                  prUrl: "https://github.com/other/repo/pull/240",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              nextCursor: "123",
            });
          }
          return Response.json({ ok: true });
        },
        feedbackFetchImpl: async (_input, init) => {
          feedbackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 });
        },
      },
    );

    await agent.poll();
    nowMs += 60_000;
    await agent.poll();

    expect(feedbackPayloads).toHaveLength(1);
    expect(feedbackPayloads[0]).toMatchObject({
      jobId: "persisted-job-240",
      sessionId: "persisted-session",
      prNumber: 240,
      verdict: "approved_merged",
    });
    expect(new URL(persistedPageUrls[0] ?? "").searchParams.get("limit")).toBe("8");
    expect(new URL(persistedPageUrls[1] ?? "").searchParams.get("cursor")).toBe("123");
  });

  test("reconciles a reopened PR linked to a new job when it recloses at the same head", async () => {
    const pr = makePr({
      number: 241,
      html_url: "https://github.com/org/repo/pull/241",
      body: "<!-- pushpals-jobId: stale-body-job -->\n<!-- pushpals-sessionId: stale -->",
      state: "closed",
      merged_at: null,
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
      head: {
        ref: "agent/reopened-same-head",
        sha: "same-head-sha",
        label: "org:agent/reopened-same-head",
      },
    });
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    let generation = 1;
    const feedbackPayloads: Array<Record<string, unknown>> = [];
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => [pr],
        listPersistedPrLinks: async () => ({
          links: [
            {
              jobId: `reopened-job-${generation}`,
              sessionId: "dev",
              prNumber: pr.number,
              prUrl: pr.html_url,
              updatedAt: `2026-08-25T17:0${generation}:00.000Z`,
            },
          ],
          nextCursor: null,
        }),
        getPullRequest: async () => pr,
        feedbackFetchImpl: async (_input, init) => {
          feedbackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true, ignored: true, acknowledged: true });
        },
      },
    );

    await agent.poll();
    generation = 2;
    nowMs += 60_000;
    await agent.poll();

    expect(feedbackPayloads).toHaveLength(2);
    expect(feedbackPayloads.map((payload) => payload.jobId)).toEqual([
      "reopened-job-1",
      "reopened-job-2",
    ]);
    expect(feedbackPayloads.map((payload) => payload.feedbackKey)).toEqual([
      "review_agent:pr:241:head:same-head-sha:state:closed_unmerged:job:reopened-job-1",
      "review_agent:pr:241:head:same-head-sha:state:closed_unmerged:job:reopened-job-2",
    ]);
  });

  test("uses persisted job metadata before stale PR body markers", async () => {
    const pr = makePr({
      number: 242,
      html_url: "https://github.com/org/repo/pull/242",
      body: "<!-- pushpals-jobId: stale-job -->\n<!-- pushpals-sessionId: stale-session -->",
      state: "closed",
      merged_at: "2026-08-25T17:00:00.000Z",
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
    });
    const feedbackPayloads: Array<Record<string, unknown>> = [];
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => Date.parse("2026-08-25T18:00:00.000Z"),
        listRecentlyClosedPullRequests: async () => [pr],
        listPersistedPrLinks: async () => ({
          links: [
            {
              jobId: "authoritative-job",
              sessionId: "authoritative-session",
              prNumber: 242,
              prUrl: pr.html_url,
              updatedAt: "2026-08-25T17:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
        getPullRequest: async () => pr,
        feedbackFetchImpl: async (_input, init) => {
          feedbackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({ ok: true, ignored: false });
        },
      },
    );

    await agent.poll();

    expect(feedbackPayloads).toHaveLength(1);
    expect(feedbackPayloads[0]).toMatchObject({
      jobId: "authoritative-job",
      sessionId: "authoritative-session",
      prNumber: 242,
      verdict: "approved_merged",
    });
  });

  test("retains a failed persisted PR probe while advancing the fair cursor", async () => {
    const failedThenClosedPr = makePr({
      number: 243,
      html_url: "https://github.com/org/repo/pull/243",
      body: null,
      state: "closed",
      merged_at: null,
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
    });
    const openPr = makePr({
      number: 244,
      html_url: "https://github.com/org/repo/pull/244",
      body: null,
      state: "open",
    });
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    let failedPrProbeCalls = 0;
    const observedCursors: Array<string | null | undefined> = [];
    const feedbackJobIds: string[] = [];
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listPersistedPrLinks: async (opts) => {
          observedCursors.push(opts.cursor);
          return opts.cursor
            ? {
                links: [
                  {
                    jobId: "open-job",
                    sessionId: "dev",
                    prNumber: 244,
                    prUrl: openPr.html_url,
                    updatedAt: "2026-08-25T17:01:00.000Z",
                  },
                ],
                nextCursor: null,
              }
            : {
                links: [
                  {
                    jobId: "retry-job",
                    sessionId: "dev",
                    prNumber: 243,
                    prUrl: failedThenClosedPr.html_url,
                    updatedAt: "2026-08-25T17:00:00.000Z",
                  },
                ],
                nextCursor: "200",
              };
        },
        getPullRequest: async (opts) => {
          if (opts.prNumber === 244) return openPr;
          failedPrProbeCalls += 1;
          if (failedPrProbeCalls === 1) throw new Error("temporary provider outage");
          return failedThenClosedPr;
        },
        feedbackFetchImpl: async (_input, init) => {
          const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          feedbackJobIds.push(String(payload.jobId ?? ""));
          return Response.json({ ok: true, ignored: false });
        },
      },
    );

    await agent.poll();
    nowMs += 60_000;
    await agent.poll();

    expect(observedCursors).toEqual([null, "200"]);
    expect(failedPrProbeCalls).toBe(2);
    expect(feedbackJobIds).toEqual(["retry-job"]);
  });

  test("does not let a fresh cursor page bypass persisted-link retry backoff", async () => {
    const poisonPr = makePr({
      number: 245,
      html_url: "https://github.com/org/repo/pull/245",
      body: null,
      state: "closed",
      merged_at: null,
    });
    let nowMs = Date.parse("2026-08-25T18:00:00.000Z");
    let providerProbeCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listPersistedPrLinks: async () => ({
          links: [
            {
              jobId: "poison-job",
              sessionId: "dev",
              prNumber: poisonPr.number,
              prUrl: poisonPr.html_url,
              updatedAt: "2026-08-25T17:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
        getPullRequest: async () => {
          providerProbeCalls += 1;
          throw new Error("persistent provider failure");
        },
      },
    );

    const observedProbeCounts: number[] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      await agent.poll();
      observedProbeCounts.push(providerProbeCalls);
      nowMs += 60_000;
    }

    expect(observedProbeCounts).toEqual([1, 2, 2, 3]);
    expect(agent.getProviderHealthSnapshot()).toMatchObject({
      persistedLinkRetryCount: 1,
      failureEvents: 3,
    });
  });

  test("reconciles but never deletes an unowned branch from a persisted PR link", async () => {
    const persistedPr = makePr({
      number: 241,
      html_url: "https://github.com/org/repo/pull/241",
      body: null,
      state: "closed",
      merged_at: null,
      closed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      head: {
        ref: "release",
        sha: "unowned-release-sha",
        label: "org:release",
      },
    });
    let feedbackCalls = 0;
    let deleteCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => Date.parse("2026-08-25T18:00:00.000Z"),
        listPersistedPrLinks: async () => ({
          links: [
            {
              jobId: "persisted-job-241",
              sessionId: "dev",
              prNumber: 241,
              prUrl: persistedPr.html_url,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
        getPullRequest: async () => persistedPr,
        feedbackFetchImpl: async () => {
          feedbackCalls += 1;
          return Response.json({ ok: true, ignored: false });
        },
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(feedbackCalls).toBe(1);
    expect(deleteCalls).toBe(0);
  });

  test("never deletes a same-named base branch for a persisted fork PR", async () => {
    const forkPr = makePr({
      number: 246,
      html_url: "https://github.com/org/repo/pull/246",
      body: null,
      state: "closed",
      merged_at: "2026-08-25T17:00:00.000Z",
      head: {
        ref: "agent/fork-owned-branch",
        sha: "fork-owned-sha",
        label: "attacker:agent/fork-owned-branch",
        repo: {
          full_name: "attacker/repo",
          name: "repo",
          owner: { login: "attacker" },
        },
      },
    });
    let deleteCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listPersistedPrLinks: async () => ({
          links: [
            {
              jobId: "fork-job",
              sessionId: "dev",
              prNumber: forkPr.number,
              prUrl: forkPr.html_url,
              updatedAt: "2026-08-25T17:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
        getPullRequest: async () => forkPr,
        feedbackFetchImpl: async () => Response.json({ ok: true, acknowledged: true }),
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();
    expect(deleteCalls).toBe(0);
  });

  test("bounds closed-PR feedback reconciliation work per poll", async () => {
    const prs = Array.from({ length: 12 }, (_, index) =>
      makePr({
        number: 100 + index,
        state: "closed",
        merged_at: "2026-08-25T17:00:00.000Z",
        closed_at: "2026-08-25T17:00:00.000Z",
        updated_at: "2026-08-25T17:00:00.000Z",
        body: `<!-- pushpals-jobId: job-${index} -->\n<!-- pushpals-sessionId: dev -->`,
        head: {
          ref: `agent/closed-${index}`,
          sha: `closed-sha-${index}`,
          label: `org:agent/closed-${index}`,
        },
      }),
    );
    let feedbackCalls = 0;
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => Date.parse("2026-08-25T18:00:00.000Z"),
        listOpenPullRequests: async () => [],
        listRecentlyClosedPullRequests: async () => prs,
        feedbackFetchImpl: async () => {
          feedbackCalls += 1;
          return new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 });
        },
      },
    );

    await agent.poll();

    expect(feedbackCalls).toBe(8);
  });

  test("reconciles an external close after a feedback outage and disabled-agent restart", async () => {
    const pr = makePr({
      number: 85,
      state: "closed",
      merged_at: null,
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
    });
    let failedFeedbackCalls = 0;
    let deleteCalls = 0;
    const sharedDeps = {
      ...silentLogs,
      now: () => Date.parse("2026-08-25T18:00:00.000Z"),
      listOpenPullRequests: async () => {
        throw new Error("AI review polling must remain disabled");
      },
      listRecentlyClosedPullRequests: async () => [pr],
      deleteBranchRef: async () => {
        deleteCalls += 1;
        return { deleted: true, reason: "deleted" as const };
      },
    };
    const beforeRestart = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...sharedDeps,
        feedbackFetchImpl: async () => {
          failedFeedbackCalls += 1;
          return new Response("unavailable", { status: 503 });
        },
      },
    );

    await beforeRestart.poll();
    expect(failedFeedbackCalls).toBe(3);
    expect(deleteCalls).toBe(0);

    const afterRestart = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...sharedDeps,
        feedbackFetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, ignored: false }), { status: 200 }),
      },
    );
    await afterRestart.poll();

    expect(deleteCalls).toBe(1);
  });

  test("does not report or delete when GitHub returns merged=false", async () => {
    const pr = makePr({ number: 86, html_url: "https://github.com/org/repo/pull/86" });
    let mergeCalls = 0;
    let feedbackCalls = 0;
    let deleteCalls = 0;
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
        getCommitMessage: async () => "feat: improve repository behavior",
        mergePullRequest: async () => {
          mergeCalls += 1;
          return { merged: false, sha: "", message: "merge was declined" };
        },
        feedbackFetchImpl: async () => {
          feedbackCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();

    expect(mergeCalls).toBe(1);
    expect(feedbackCalls).toBe(0);
    expect(deleteCalls).toBe(0);
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

  test("closes PR when automated review-fix retries hit the cap", async () => {
    const prNumber = 62;
    let pollCount = 0;
    let jobEnqueueCalls = 0;
    let closeCalls = 0;
    let deleteCalls = 0;
    let closed = false;

    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => {
          if (closed) return [];
          const sha = pollCount.toString(16).padStart(40, "0");
          pollCount += 1;
          return [
            makePr({
              number: prNumber,
              html_url: `https://example.com/pr/${prNumber}`,
              head: {
                ref: "agent/test-branch",
                sha,
                label: "owner:agent/test-branch",
              },
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
        closePullRequest: async () => {
          closeCalls += 1;
          closed = true;
          return { state: "closed", closed: true };
        },
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/jobs/enqueue")) {
            jobEnqueueCalls += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        now: () => 789,
      },
    );

    for (let i = 0; i < 5; i += 1) {
      await agent.poll();
    }

    expect(jobEnqueueCalls).toBe(3);
    expect(closeCalls).toBe(1);
    expect(deleteCalls).toBe(1);
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
    let enqueuedBranchPrefix = "";

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
            enqueuedBranchPrefix = String(reviewAgent.branchPrefix ?? "");
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
    expect(enqueuedBranchPrefix).toBe("agent/");
  });

  test("enqueues fallback instruction when reviewer omits fix_instruction", async () => {
    const pr = makePr({
      number: 7,
      html_url: "https://example.com/pr/7",
      head: {
        ref: "automation/test-branch",
        sha: "abc123def456",
        label: "owner:automation/test-branch",
      },
    });
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
    let enqueuedBranchPrefix = "";
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
            enqueuedBranchPrefix = String(reviewAgent.branchPrefix ?? "");
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
      "automation/",
    );

    await agent.poll();

    expect(enqueuedInstruction).toContain("Address ReviewAgent feedback for PR #7");
    expect(enqueuedInstruction).toContain("Missing negative-path assertions");
    expect(enqueuedTaskId).toBe("review-fix-pr7-123");
    expect(enqueuedDedupeKey).toBe("7:abc123def456");
    expect(enqueuedDedupeCooldownMs).toBe(60_000);
    expect(enqueuedCompletionBranch).toBe("automation/test-branch");
    expect(enqueuedPlannerWorkerInstruction).toContain("Rejected PR revision brief:");
    expect(enqueuedPlannerWorkerInstruction).toContain("Previous ReviewAgent score: 7.2 / 10");
    expect(enqueuedPlannerWorkerInstruction).toContain("Required approval threshold: 9.5 / 10");
    expect(createdTaskTitle).toBe("Address ReviewAgent feedback for PR #7 @ abc123de");
    expect(createdTaskTags).toEqual(["review-agent", "review-fix"]);
    expect(enqueuedWriteGlobs.length).toBeGreaterThan(0);
    expect(enqueuedTargetPaths).toEqual(["tests/api/review.test.ts"]);
    expect(enqueuedValidationSteps).toEqual(["bun test ./tests/api/review.test.ts"]);
    expect(enqueuedResolutionType).toBe("review_fix");
    expect(enqueuedBranchPrefix).toBe("automation/");
    expect(enqueuedReviewThreshold).toBe(9.5);
    expect(enqueuedReviewerFindings).toEqual(["Missing negative-path assertions"]);
    expect(enqueuedPlannerWorkerInstruction).toContain("Do not return an unchanged branch");
    expect(enqueuedPlannerWorkerInstruction).toContain(
      "do not checkout, switch, reset, merge, rebase, stage, commit, or push",
    );
    expect(enqueuedPlannerWorkerInstruction).toContain(
      "SourceControlManager publication target after host finalization",
    );
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

  test("bounds each open-review lane run and rotates fairly through large PR sets", async () => {
    const probed: number[] = [];
    const prs = Array.from({ length: 100 }, (_, index) =>
      makePr({
        number: index + 1,
        head: {
          ref: `agent/job-${index + 1}`,
          sha: `sha-${index + 1}`,
          label: `owner:agent/job-${index + 1}`,
        },
      }),
    );
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        listOpenPullRequests: async () => prs,
        getPullRequestDiff: async ({ prNumber }) => {
          probed.push(prNumber);
          throw new Error("simulated bounded review failure");
        },
      },
    );

    await agent.poll();
    await agent.poll();
    await agent.poll();

    expect(probed).toEqual([1, 2, 3]);
  });

  test("keeps provider reconciliation polling while the open-review lane is stalled", async () => {
    let releaseOpenList: (() => void) | null = null;
    let closedListCalls = 0;
    let nowMs = 0;
    const openListGate = new Promise<void>((resolve) => {
      releaseOpenList = resolve;
    });
    const agent = new ReviewAgent(
      baseConfig,
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listOpenPullRequests: async () => {
          await openListGate;
          return [];
        },
        listRecentlyClosedPullRequests: async () => {
          closedListCalls += 1;
          return [];
        },
      },
    );

    const stalledPoll = agent.poll();
    await Bun.sleep(5);
    nowMs += 60_000;
    await agent.poll();
    expect(closedListCalls).toBe(2);

    releaseOpenList?.();
    await stalledPoll;
  });

  test("does not freeze provider reconciliation when the system clock moves backward", async () => {
    let nowMs = 120_000;
    let closedListCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => {
          closedListCalls += 1;
          return [];
        },
      },
    );

    await agent.poll();
    nowMs = 60_000;
    await agent.poll();

    expect(closedListCalls).toBe(2);
  });

  test("retries unacknowledged provider feedback after the system clock moves backward", async () => {
    const pr = makePr({
      number: 245,
      state: "closed",
      merged_at: null,
      closed_at: "2026-08-25T17:00:00.000Z",
      updated_at: "2026-08-25T17:00:00.000Z",
    });
    let nowMs = 120_000;
    let feedbackCalls = 0;
    let deleteCalls = 0;
    const agent = new ReviewAgent(
      { ...baseConfig, enabled: false },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        ...silentLogs,
        now: () => nowMs,
        listRecentlyClosedPullRequests: async () => [pr],
        feedbackFetchImpl: async () => {
          feedbackCalls += 1;
          return Response.json(
            feedbackCalls === 1 ? { ok: true, ignored: true } : { ok: true, ignored: false },
          );
        },
        deleteBranchRef: async () => {
          deleteCalls += 1;
          return { deleted: true, reason: "deleted" as const };
        },
      },
    );

    await agent.poll();
    nowMs = 60_000;
    await agent.poll();

    expect(feedbackCalls).toBe(2);
    expect(deleteCalls).toBe(1);
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
    expect(enqueuedDedupeKey).toBe("merge-conflict:70:abc123def456:ffff1111");
    expect(enqueuedResolutionType).toBe("merge_conflict");
    expect(enqueuedInstruction).toContain("Resolve merge conflicts for PR #70");
    expect(enqueuedInstruction).toContain("Do not create a new PR");
    expect(enqueuedPlannerWorkerInstruction).toContain("Existing PR branch: agent/test-branch");
    expect(enqueuedPlannerWorkerInstruction).toContain(
      "Deterministic orchestration rebase target: main",
    );
    expect(enqueuedPlannerWorkerInstruction).toContain(
      "must not checkout, switch, reset, merge, rebase, stage, commit, or push",
    );
    expect(enqueuedPlannerWorkerInstruction).toContain("Expected remote lease SHA: abc123def456");
    expect(enqueuedTargetPaths).toEqual(["apps/remotebuddy/README.md"]);
    expect(enqueuedValidationSteps).toEqual(["git diff --check"]);
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

  test("opens the merge-conflict circuit after two failures for the same head/base fingerprint", async () => {
    const pr = makePr({ number: 73, html_url: "https://example.com/pr/73" });
    let enqueueCalls = 0;
    const warnings: string[] = [];
    const failedJobs = ["failed-merge-1", "failed-merge-2"].map((id) => ({
      id,
      kind: "task.execute",
      params: JSON.stringify({
        reviewAgent: {
          prNumber: pr.number,
          prHeadSha: pr.head.sha,
          prBaseSha: pr.base.sha,
          resolutionType: "merge_conflict",
        },
      }),
    }));
    const agent = new ReviewAgent(
      { ...baseConfig, passThreshold: 8.5 },
      "http://localhost:3001",
      "token",
      "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        listOpenPullRequests: async () => [pr],
        getPullRequestDiff: async () => "diff --git a/app.ts b/app.ts\n+line",
        invokeCodexReview: async () =>
          JSON.stringify({ score: 9.2, summary: "Approved", issues: [], fix_instruction: "" }),
        addPullRequestComment: async () => {},
        getCommitMessage: async () => "fix(app): improve behavior",
        mergePullRequest: async () => {
          throw new Error('GitHub API 405: {"message":"Pull Request is not mergeable"}');
        },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/jobs?status=failed")) {
            return new Response(JSON.stringify({ ok: true, jobs: failedJobs }), { status: 200 });
          }
          if (url.includes("/jobs?status=")) {
            return new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200 });
          }
          if (url.endsWith("/jobs/enqueue")) enqueueCalls += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        logInfo: () => {},
        logWarn: (message) => warnings.push(message),
        logError: () => {},
        closePullRequest: silentLogs.closePullRequest,
        deleteBranchRef: silentLogs.deleteBranchRef,
      },
    );

    await agent.poll();

    expect(enqueueCalls).toBe(0);
    expect(warnings.join("\n")).toContain("Merge-conflict circuit open");
    expect(warnings.join("\n")).toContain("merge-conflict:73:abc123def456:ffff1111");
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
