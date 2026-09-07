import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MergeQueueDB } from "../apps/source_control_manager/src/db";
import {
  ReviewAgent,
  type ReviewAgentConfig,
} from "../apps/source_control_manager/src/review_agent";
import type { GitHubPR } from "../apps/source_control_manager/src/github_pr";
import type { ReviewJournal } from "../apps/source_control_manager/src/review_journal";

const config: ReviewAgentConfig = {
  enabled: true,
  pollIntervalMs: 60_000,
  reviewerMdPath: "prompts/review_agent/reviewer.md",
  passThreshold: 8.5,
  maxPrCommentsBeforeGiveUp: 10,
  mergeMethod: "squash",
  codexBin: "fixture-codex",
  codexAuthMode: "chatgpt",
  codexHomeDir: "",
  codexTimeoutMs: 5_000,
};

class ReviewHarness {
  root = mkdtempSync(join(tmpdir(), "pushpals-review-journal-"));
  dbPath = join(this.root, "state.db");
  journal = new MergeQueueDB(this.dbPath);
  reviewCalls = 0;
  enqueueCalls = 0;
  mergeCalls = 0;
  closeCalls = 0;
  admissionStatus = 200;
  admissionCode = "";
  admissionDeduped = false;
  mergeConflict = false;
  activateOnMergeConflict = false;
  repairResolutionType: "review_fix" | "merge_conflict" = "review_fix";
  failedMergeAttempts = 0;
  completedMergeAt: number | null = null;
  clockMs = Date.parse("2026-09-07T00:00:00Z");
  activeStatus: "pending" | "claimed" | "finalizing" | null = null;
  scanFailure = false;
  malformedScan = false;
  pendingScans = 0;
  activateOnPendingScan = 0;
  lifecycleState: "none" | "active" | "exhausted" | "settled" = "none";
  lifecycleStatus = 200;
  malformedLifecycle = false;
  lifecycleStateOverride: unknown = undefined;
  beforeReview: (() => void) | null = null;
  beforeProviderProbe: (() => void) | null = null;
  mergedExpectedHead: string | undefined;
  score = 7.8;
  pr: GitHubPR = {
    number: 42,
    html_url: "https://github.com/org/repo/pull/42",
    title: "Add behavior coverage",
    body: "<!-- pushpals-jobId: source-job -->\n<!-- pushpals-sessionId: dev -->",
    state: "open",
    head: {
      ref: "agent/candidate",
      sha: "a".repeat(40),
      label: "org:agent/candidate",
      repo: { full_name: "org/repo", name: "repo", owner: { login: "org" } },
    },
    base: { ref: "main", sha: "b".repeat(40) },
  };
  repairHead = this.pr.head.sha;
  repairBase = this.pr.base.sha;
  comments: string[] = [];

  agent(
    options: {
      journal?: ReviewJournal;
      config?: Partial<ReviewAgentConfig>;
      repository?: string;
    } = {},
  ): ReviewAgent {
    return new ReviewAgent(
      { ...config, ...options.config },
      "http://server",
      "fixture-token",
      options.repository ?? "https://github.com/org/repo.git",
      "main",
      undefined,
      {
        reviewJournal: options.journal ?? this.journal,
        listOpenPullRequests: async () =>
          this.pr.state === "open" ? [structuredClone(this.pr)] : [],
        getPullRequest: async () => {
          this.beforeProviderProbe?.();
          return structuredClone(this.pr);
        },
        listRecentlyClosedPullRequests: async () => [],
        listPersistedPrLinks: async () => ({ links: [], nextCursor: null }),
        getPullRequestDiff: async () =>
          "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
        invokeCodexReview: async () => {
          this.reviewCalls++;
          this.beforeReview?.();
          return JSON.stringify({
            score: this.score,
            summary: "Missing failure coverage",
            issues: ["Add the failure-path assertion"],
            fix_instruction: "Add the failure-path assertion.",
          });
        },
        getCommitMessage: async () => "test: add regression coverage",
        listPullRequestComments: async () => [],
        addPullRequestComment: async ({ body }) => {
          this.comments.push(body);
        },
        mergePullRequest: async (args) => {
          this.mergeCalls++;
          this.mergedExpectedHead = args.expectedHeadSha;
          if (this.mergeConflict) {
            this.repairResolutionType = "merge_conflict";
            if (this.activateOnMergeConflict) this.activeStatus = "pending";
            throw new Error('GitHub API 405: {"message":"Pull Request is not mergeable"}');
          }
          this.pr.state = "closed";
          return { merged: true, sha: "c".repeat(40), message: "merged" };
        },
        closePullRequest: async () => {
          this.closeCalls++;
          this.pr.state = "closed";
          return { closed: true, state: "closed" };
        },
        deleteBranchRef: async () => ({ deleted: true, reason: "deleted" }),
        feedbackFetchImpl: async () => Response.json({ ok: true, ignored: false }),
        fetchImpl: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/jobs/review-repair-lifecycle") {
            if (this.lifecycleStatus !== 200)
              return new Response("unavailable", { status: this.lifecycleStatus });
            if (this.malformedLifecycle) return Response.json({ ok: true });
            const matches =
              url.searchParams.get("headSha") === this.repairHead &&
              (this.lifecycleState === "active" ||
                url.searchParams.get("baseSha") === this.repairBase);
            return Response.json({
              ok: true,
              state:
                this.lifecycleStateOverride === undefined
                  ? matches
                    ? this.lifecycleState
                    : "none"
                  : this.lifecycleStateOverride,
              activeJobId: null,
              detail: "Original failure-path assertion was not repaired.",
            });
          }
          if (url.pathname === "/jobs") {
            if (this.scanFailure) return new Response("unavailable", { status: 503 });
            if (this.malformedScan) return Response.json({ ok: true });
            const status = url.searchParams.get("status");
            if (status === "pending") {
              this.pendingScans++;
              if (this.activateOnPendingScan === this.pendingScans) this.activeStatus = "pending";
            }
            const jobs =
              status === this.activeStatus
                ? [
                    {
                      id: "active-repair",
                      kind: "task.execute",
                      status,
                      params: {
                        reviewAgent: {
                          prNumber: this.pr.number,
                          prHeadSha: this.repairHead,
                          prBaseSha: this.repairBase,
                          resolutionType: this.repairResolutionType,
                        },
                      },
                    },
                  ]
                : [];
            if (status === "failed" || status === "completed") {
              const count =
                status === "failed"
                  ? this.failedMergeAttempts
                  : this.completedMergeAt === null
                    ? 0
                    : 1;
              for (let i = 0; i < count; i++) {
                jobs.push({
                  id: `terminal-merge-${status}-${i}`,
                  kind: "task.execute",
                  status,
                  completedAt: new Date(this.completedMergeAt ?? this.clockMs).toISOString(),
                  params: {
                    reviewAgent: {
                      prNumber: this.pr.number,
                      prHeadSha: this.repairHead,
                      prBaseSha: this.repairBase,
                      resolutionType: "merge_conflict",
                    },
                  },
                } as (typeof jobs)[number]);
              }
            }
            return Response.json({ ok: true, jobs });
          }
          if (url.pathname === "/jobs/enqueue") {
            this.enqueueCalls++;
            if (this.admissionStatus !== 200)
              return Response.json(
                { code: this.admissionCode, message: "repair admission" },
                { status: this.admissionStatus },
              );
            this.activeStatus = "pending";
            this.repairHead = this.pr.head.sha;
            this.repairBase = this.pr.base.sha;
            this.repairResolutionType = JSON.parse(
              String(init?.body),
            ).params.reviewAgent.resolutionType;
            return Response.json({
              ok: true,
              jobId: "active-repair",
              deduped: this.admissionDeduped,
            });
          }
          return Response.json({ ok: true });
        },
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {},
        sleep: async () => {},
        now: () => this.clockMs,
        validationRepoRoot: () => this.root,
      },
    );
  }

  reopen(): void {
    this.journal.close();
    this.journal = new MergeQueueDB(this.dbPath);
  }
  cleanup(): void {
    this.journal.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe("durable PR review journal and repair ownership", () => {
  test.each(["pending", "claimed", "finalizing"] as const)(
    "an approved merge-conflict repair remains nonterminal while %s and closes after exhaustion across restart",
    async (status) => {
      const h = new ReviewHarness();
      try {
        h.score = 9.4;
        h.mergeConflict = true;
        await h.agent().poll();
        expect(h.reviewCalls).toBe(1);
        expect(h.mergeCalls).toBe(1);
        expect(h.enqueueCalls).toBe(1);
        h.reopen();
        h.activeStatus = status;
        h.score = 9.9;
        const restarted = h.agent();
        restarted.requestReReview(h.pr.number, h.pr.head.sha);
        await restarted.poll();
        expect(h.reviewCalls).toBe(1);
        expect(h.mergeCalls).toBe(1);
        expect(h.enqueueCalls).toBe(1);
        expect(h.closeCalls).toBe(0);
        h.activeStatus = null;
        h.lifecycleState = "exhausted";
        await restarted.poll();
        expect(h.closeCalls).toBe(1);
        expect(h.reviewCalls).toBe(1);
        expect(h.mergeCalls).toBe(1);
      } finally {
        h.cleanup();
      }
    },
  );

  test.each(["deduped-admission", "active-at-merge"])(
    "merge-conflict %s does not finalize a revision before its repair settles",
    async (dedupe) => {
      const h = new ReviewHarness();
      try {
        h.score = 9.4;
        h.mergeConflict = true;
        h.admissionDeduped = dedupe === "deduped-admission";
        h.activateOnMergeConflict = dedupe === "active-at-merge";
        await h.agent().poll();
        expect(h.reviewCalls).toBe(1);
        expect(h.mergeCalls).toBe(1);
        expect(h.enqueueCalls).toBe(dedupe === "deduped-admission" ? 1 : 0);
        h.reopen();
        h.activeStatus = null;
        h.lifecycleState = "exhausted";
        await h.agent().poll();
        expect(h.closeCalls).toBe(1);
        expect(h.reviewCalls).toBe(1);
      } finally {
        h.cleanup();
      }
    },
  );

  test("a completed conflict repair's settle window expires after restart without rescoring", async () => {
    const h = new ReviewHarness();
    try {
      h.score = 9.4;
      h.mergeConflict = true;
      h.completedMergeAt = h.clockMs;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(0);
      h.reopen();
      h.score = 1; // Retain the actual approved verdict, not a new random score.
      const restarted = h.agent();
      await restarted.poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(0);
      h.clockMs += 31 * 60_000;
      await restarted.poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(1);
      expect(h.closeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("an open conflict circuit still reconciles durable exhaustion after restart", async () => {
    const h = new ReviewHarness();
    try {
      h.score = 9.4;
      h.mergeConflict = true;
      h.failedMergeAttempts = 2;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(0);
      h.reopen();
      h.lifecycleState = "exhausted";
      await h.agent().poll();
      expect(h.closeCalls).toBe(1);
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("a changed head after a finalizing merge-conflict repair receives a new review and merges", async () => {
    const h = new ReviewHarness();
    try {
      h.score = 9.4;
      h.mergeConflict = true;
      await h.agent().poll();
      h.reopen();
      h.activeStatus = "finalizing";
      h.pr.base.sha = "d".repeat(40);
      const restarted = h.agent();
      await restarted.poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.mergeCalls).toBe(1);
      h.activeStatus = null;
      h.lifecycleState = "settled";
      h.pr.head.sha = "e".repeat(40);
      h.mergeConflict = false;
      await restarted.poll();
      expect(h.reviewCalls).toBe(2);
      expect(h.mergeCalls).toBe(2);
      expect(h.mergedExpectedHead).toBe("e".repeat(40));
      expect(h.pr.state).toBe("closed");
      expect(h.closeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("a pre-journal exhausted lifecycle cannot receive a fresh random approval", async () => {
    const h = new ReviewHarness();
    try {
      h.lifecycleState = "exhausted";
      h.score = 9.9;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(0);
      expect(h.enqueueCalls).toBe(0);
      expect(h.mergeCalls).toBe(0);
      expect(h.closeCalls).toBe(1);
      expect(h.comments.join("\n")).toContain("failure-path assertion");
    } finally {
      h.cleanup();
    }
  });

  test.each(["active", "settled"] as const)(
    "pre-journal %s lifecycle defers model work",
    async (state) => {
      const h = new ReviewHarness();
      try {
        h.lifecycleState = state;
        await h.agent().poll();
        expect(h.reviewCalls).toBe(0);
        expect(h.mergeCalls).toBe(0);
        expect(h.closeCalls).toBe(0);
      } finally {
        h.cleanup();
      }
    },
  );

  test.each(["unavailable", "malformed"])("lifecycle lookup %s fails closed", async (failure) => {
    const h = new ReviewHarness();
    try {
      h.lifecycleStatus = failure === "unavailable" ? 503 : 200;
      h.malformedLifecycle = failure === "malformed";
      await expect(h.agent().poll()).rejects.toThrow("lifecycle authority");
      expect(h.reviewCalls).toBe(0);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("an old exhausted revision cannot close a PR whose provider head advanced", async () => {
    const h = new ReviewHarness();
    try {
      h.lifecycleState = "exhausted";
      h.beforeProviderProbe = () => {
        h.pr.head.sha = "f".repeat(40);
      };
      await h.agent().poll();
      expect(h.closeCalls).toBe(0);
      expect(h.mergeCalls).toBe(0);
      expect(h.reviewCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test.each([
    { label: "array containing none", state: ["none"] },
    { label: "array containing exhausted", state: ["exhausted"] },
    { label: "object", state: { state: "none" } },
    { label: "null", state: null },
  ])(
    "a $label lifecycle state cannot become review authority through coercion",
    async ({ state }) => {
      const h = new ReviewHarness();
      try {
        h.lifecycleStateOverride = state;
        await expect(h.agent().poll()).rejects.toThrow(
          "lifecycle authority returned an invalid response",
        );
        expect(h.reviewCalls).toBe(0);
        expect(h.enqueueCalls).toBe(0);
        expect(h.closeCalls).toBe(0);
        expect(h.mergeCalls).toBe(0);
      } finally {
        h.cleanup();
      }
    },
  );

  test("a policy change during the model call cannot apply the old verdict under new policy", async () => {
    const h = new ReviewHarness();
    try {
      h.score = 9.9;
      const agent = h.agent();
      h.beforeReview = () => agent.updateRuntimeConfig({ ...config, passThreshold: 9.7 });
      await expect(agent.poll()).rejects.toThrow("policy changed during review");
      expect(h.reviewCalls).toBe(1);
      expect(h.mergeCalls).toBe(0);
      expect(h.enqueueCalls).toBe(0);
      expect(h.comments).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("restart cannot rescore and merge an unchanged rejected head while its repair is finalizing", async () => {
    const h = new ReviewHarness();
    try {
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(1);
      expect(h.journal.getReviewRepairEnqueueCount("github.com/org/repo", 42)).toBe(1);
      h.reopen();
      h.activeStatus = "finalizing";
      h.score = 9.9; // A second random verdict must never be requested.
      const restarted = h.agent();
      await restarted.poll();
      h.pr.base.sha = "d".repeat(40);
      await restarted.poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.mergeCalls).toBe(0);
      expect(h.enqueueCalls).toBe(1);
      h.activeStatus = null;
      h.pr.head.sha = "e".repeat(40);
      await restarted.poll();
      expect(h.reviewCalls).toBe(2);
      expect(h.mergeCalls).toBe(1);
      expect(h.mergedExpectedHead).toBe("e".repeat(40));
    } finally {
      h.cleanup();
    }
  });

  test("transient admission recovery reuses the persisted rejection after reopening SQLite", async () => {
    const h = new ReviewHarness();
    try {
      h.admissionStatus = 503;
      await h.agent().poll();
      expect(h.journal.getReviewRepairEnqueueCount("github.com/org/repo", 42)).toBe(0);
      h.reopen();
      h.score = 9.9;
      h.admissionStatus = 200;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(2);
      expect(h.mergeCalls).toBe(0);
      expect(h.comments.some((comment) => comment.includes("failure-path assertion"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("an exhausted repair lifecycle closes the rejected PR without re-rolling its verdict", async () => {
    const h = new ReviewHarness();
    try {
      await h.agent().poll();
      h.activeStatus = null;
      h.admissionStatus = 409;
      h.admissionCode = "review_repair_lifecycle_exhausted";
      h.score = 9.9;
      h.reopen();
      const restarted = h.agent();
      await restarted.poll();
      await restarted.poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(2);
      expect(h.closeCalls).toBe(1);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("settled lifecycle acknowledgement neither closes nor repeatedly reviews the same revision", async () => {
    const h = new ReviewHarness();
    try {
      h.admissionStatus = 409;
      h.admissionCode = "review_repair_lifecycle_settled";
      await h.agent().poll();
      h.reopen();
      h.score = 9.9;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.enqueueCalls).toBe(1);
      expect(h.closeCalls).toBe(0);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test.each(["pending", "claimed", "finalizing"] as const)(
    "existing %s repair blocks review even without a previous local journal",
    async (status) => {
      const h = new ReviewHarness();
      try {
        h.activeStatus = status;
        h.score = 9.9;
        await h.agent().poll();
        expect(h.reviewCalls).toBe(0);
        expect(h.mergeCalls).toBe(0);
      } finally {
        h.cleanup();
      }
    },
  );

  test.each(["unavailable", "malformed"])(
    "fails closed when active repair authority is %s",
    async (failure) => {
      const h = new ReviewHarness();
      try {
        h.scanFailure = failure === "unavailable";
        h.malformedScan = failure === "malformed";
        await expect(h.agent().poll()).rejects.toThrow("repair authority");
        expect(h.reviewCalls).toBe(0);
        expect(h.mergeCalls).toBe(0);
        expect(h.enqueueCalls).toBe(0);
      } finally {
        h.cleanup();
      }
    },
  );

  test("a repair appearing during review is checked again before merge", async () => {
    const h = new ReviewHarness();
    try {
      h.score = 9.9;
      h.activateOnPendingScan = 3;
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.mergeCalls).toBe(0);
      h.reopen();
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("repository, head, base, model, threshold and reviewer policy invalidate only the relevant decision", async () => {
    const h = new ReviewHarness();
    try {
      h.admissionStatus = 503;
      await h.agent().poll();
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      h.pr.base.sha = "d".repeat(40);
      await h.agent().poll();
      h.pr.head.sha = "e".repeat(40);
      await h.agent().poll();
      await h.agent({ config: { model: "custom-review-model" } }).poll();
      await h.agent({ config: { passThreshold: 9.5 } }).poll();
      const reviewerPath = join(h.root, "reviewer.md");
      writeFileSync(reviewerPath, "Require a targeted failure-path test.");
      await h.agent({ config: { reviewerMdPath: reviewerPath } }).poll();
      await h.agent({ repository: "https://github.com/another/repo.git" }).poll();
      h.pr.title = "Different task intent";
      await h.agent().poll();
      h.pr.body += "\nA new acceptance criterion.";
      await h.agent().poll();
      expect(h.reviewCalls).toBe(9);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("remote transport aliases preserve durable verdicts and repair counts across SQLite reopen", async () => {
    const h = new ReviewHarness();
    try {
      await h.agent().poll();
      expect(h.reviewCalls).toBe(1);
      expect(h.journal.getReviewRepairEnqueueCount("github.com/org/repo", 42)).toBe(1);
      // Admission fails after the initial repair. If a transport alias loses
      // the journal, a new model invocation would return an unsafe approval.
      h.activeStatus = null;
      h.admissionStatus = 503;
      h.score = 9.9;
      for (const repository of [
        "git@github.com:org/repo.git",
        "ssh://git@github.com/org/repo.git",
        "https://github.com/ORG/REPO/",
        "https://fixture-user:fixture-password@github.com/org/repo.git?ignored=fixture#fragment",
      ]) {
        h.reopen();
        await h.agent({ repository }).poll();
        expect(h.reviewCalls).toBe(1);
        expect(h.mergeCalls).toBe(0);
        expect(h.journal.getReviewRepairEnqueueCount("github.com/org/repo", 42)).toBe(1);
        expect(h.journal.getReviewRepairEnqueueCount(repository, 42)).toBe(0);
      }
      h.reopen();
      h.score = 7.1;
      await h.agent({ repository: "git@github.com:another/repo.git" }).poll();
      expect(h.reviewCalls).toBe(2);
      expect(h.journal.getReviewRepairEnqueueCount("github.com/another/repo", 42)).toBe(0);
      expect(h.journal.getReviewRepairEnqueueCount("github.com/org/repo", 42)).toBe(1);
      expect(h.mergeCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test.each(["read", "write"])(
    "journal %s failure cannot cause unrecorded publication",
    async (failure) => {
      const h = new ReviewHarness();
      try {
        h.score = 9.9;
        const journal: ReviewJournal = {
          getReviewDecision: (...args) => {
            if (failure === "read") throw new Error("journal unavailable");
            return h.journal.getReviewDecision(...args);
          },
          saveReviewDecision: (...args) => {
            if (failure === "write") throw new Error("journal unavailable");
            h.journal.saveReviewDecision(...args);
          },
          getReviewRepairEnqueueCount: (...args) => h.journal.getReviewRepairEnqueueCount(...args),
        };
        await expect(h.agent({ journal }).poll()).rejects.toThrow("journal unavailable");
        expect(h.reviewCalls).toBe(failure === "read" ? 0 : 1);
        expect(h.mergeCalls).toBe(0);
        expect(h.enqueueCalls).toBe(0);
      } finally {
        h.cleanup();
      }
    },
  );
});
