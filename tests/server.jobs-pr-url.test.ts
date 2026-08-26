import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobQueue } from "../apps/server/src/jobs";
import { AutonomyStore } from "../apps/server/src/autonomy";

describe("server JobQueue PR URL persistence", () => {
  test("stores prUrl when job is completed with PR metadata", () => {
    const queue = new JobQueue(":memory:");
    const enqueued = queue.enqueue({
      taskId: "task-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueued.ok).toBe(true);
    const jobId = String(enqueued.jobId ?? "");
    expect(jobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-1");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(jobId);

    const completed = queue.complete(jobId, {
      summary: "done",
      prUrl: "https://github.com/org/repo/pull/77",
    });
    expect(completed.ok).toBe(true);

    const saved = queue.getJob(jobId);
    expect(saved?.status).toBe("completed");
    expect(saved?.prUrl).toBe("https://github.com/org/repo/pull/77");
    queue.close();
  });

  test("can sync prUrl onto an existing completed job", () => {
    const queue = new JobQueue(":memory:");
    const enqueued = queue.enqueue({
      taskId: "task-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueued.ok).toBe(true);
    const jobId = String(enqueued.jobId ?? "");
    expect(jobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-2");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(jobId);

    const completed = queue.complete(jobId, { summary: "done" });
    expect(completed.ok).toBe(true);
    expect(queue.getJob(jobId)?.prUrl).toBeNull();

    const synced = queue.setPrUrl(jobId, "https://github.com/org/repo/pull/88");
    expect(synced.ok).toBe(true);
    expect(queue.getJob(jobId)?.prUrl).toBe("https://github.com/org/repo/pull/88");
    queue.close();
  });

  test("marks worker PR backlog entries as open until merged feedback is recorded", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-backlog-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const enqueued = queue.enqueue({
        taskId: "task-3",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      expect(enqueued.ok).toBe(true);
      const jobId = String(enqueued.jobId ?? "");
      expect(jobId.length).toBeGreaterThan(0);
      expect(queue.claim("worker-3").ok).toBe(true);
      expect(
        queue.complete(jobId, {
          summary: "done",
          prUrl: "https://github.com/org/repo/pull/99",
        }).ok,
      ).toBe(true);

      const before = queue.listWorkerPrBacklog();
      const prBefore = before.find(
        (entry) => entry.prUrl === "https://github.com/org/repo/pull/99",
      );
      expect(prBefore?.mergeState).toBe("open_unmerged");
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(1);

      const feedback = store.recordPrFeedback({
        patternKey: "lint_fix::apps/server::queue_health",
        jobId,
        prUrl: "https://github.com/org/repo/pull/99",
        verdict: "approved_merged",
        source: "review_agent",
      });
      expect(feedback.ok).toBe(true);

      const after = queue.listWorkerPrBacklog();
      const prAfter = after.find((entry) => entry.prUrl === "https://github.com/org/repo/pull/99");
      expect(prAfter?.mergeState).toBe("merged");
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(0);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("pages compact unresolved persisted PR links with a stable cursor", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-links-page-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const completed: Array<{ jobId: string; prUrl: string }> = [];
      for (let index = 1; index <= 3; index += 1) {
        const prUrl = `https://github.com/org/repo/pull/${index}`;
        const enqueued = queue.enqueue({
          taskId: `compact-link-${index}`,
          sessionId: `session-${index}`,
          kind: "task.execute",
          params: { deliberatelyLargeField: "x".repeat(10_000) },
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(`worker-${index}`).ok).toBe(true);
        expect(queue.complete(jobId, { summary: "done", prUrl }).ok).toBe(true);
        completed.push({ jobId, prUrl });
      }

      const firstPage = queue.listPersistedPrLinksPage({ limit: 2 });
      expect(firstPage).toHaveLength(2);
      expect(firstPage.map((row) => row.prUrl)).toEqual([
        "https://github.com/org/repo/pull/3",
        "https://github.com/org/repo/pull/2",
      ]);
      expect(firstPage[0]).toEqual({
        cursor: expect.any(Number),
        jobId: completed[2]?.jobId,
        sessionId: "session-3",
        prUrl: completed[2]?.prUrl,
        updatedAt: expect.any(String),
      });

      const secondPage = queue.listPersistedPrLinksPage({
        limit: 2,
        beforeCursor: firstPage.at(-1)?.cursor,
      });
      expect(secondPage.map((row) => row.prUrl)).toEqual(["https://github.com/org/repo/pull/1"]);

      expect(
        store.recordPrFeedback({
          patternKey: "test::compact-pr-links",
          jobId: "unrelated-job",
          prUrl: completed[2]?.prUrl,
          verdict: "approved_merged",
        }).ok,
      ).toBe(true);
      expect(queue.listPersistedPrLinksPage({ limit: 3 })).toHaveLength(3);

      expect(
        store.recordPrFeedback({
          patternKey: "test::compact-pr-links",
          jobId: completed[2]?.jobId,
          prUrl: completed[2]?.prUrl,
          verdict: "approved_merged",
        }).ok,
      ).toBe(true);
      expect(queue.listPersistedPrLinksPage({ limit: 3 }).map((row) => row.prUrl)).toEqual([
        "https://github.com/org/repo/pull/2",
        "https://github.com/org/repo/pull/1",
      ]);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("one terminal provider outcome resolves every completed job link for the same PR", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-links-siblings-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const prUrl = "https://github.com/org/repo/pull/501";
      const jobIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const enqueued = queue.enqueue({
          taskId: `same-pr-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
        });
        const jobId = String(enqueued.jobId ?? "");
        jobIds.push(jobId);
        expect(queue.claim(`worker-same-pr-${index}`).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      }

      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(2);
      const acknowledgement = store.recordPrFeedback({
        jobId: jobIds[1],
        prUrl,
        verdict: "closed_unmerged",
      });
      expect(acknowledgement).toMatchObject({
        ok: true,
        ignored: true,
        acknowledged: true,
      });
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);
      expect(queue.listWorkerPrBacklog()).toContainEqual(
        expect.objectContaining({ prUrl, mergeState: "closed_unmerged" }),
      );
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(0);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("does not classify natural-language unmerged verdicts as a merge", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-verdict-negatives-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const verdicts = ["not merged", "never merged", "closed without merged"];
      for (let index = 0; index < verdicts.length; index += 1) {
        const prUrl = `https://github.com/example/repository/pull/${550 + index}`;
        const enqueued = queue.enqueue({
          taskId: `negative-verdict-${index}`,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(`worker-negative-verdict-${index}`).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
        expect(
          store.recordPrFeedback({
            feedbackKey: `negative-verdict:${index}`,
            jobId,
            patternKey: `negative-verdict::${index}`,
            prUrl,
            verdict: verdicts[index],
          }).ok,
        ).toBe(true);
      }

      const backlog = queue.listWorkerPrBacklog(10);
      expect(backlog).toHaveLength(3);
      expect(backlog.every((entry) => entry.mergeState === "open_unmerged")).toBe(true);
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(3);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("never regresses a confirmed merge when delayed closed feedback arrives", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-provider-monotonic-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const prUrl = "https://github.com/example/repository/pull/560";
      const enqueued = queue.enqueue({
        taskId: "provider-monotonic",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-provider-monotonic").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      expect(store.recordPrFeedback({ jobId, prUrl, verdict: "approved_merged" })).toMatchObject({
        ok: true,
        acknowledged: true,
      });
      expect(store.recordPrFeedback({ jobId, prUrl, verdict: "closed_unmerged" })).toMatchObject({
        ok: true,
        acknowledged: true,
      });

      const provider = (store as unknown as { db: any }).db
        .prepare(
          `SELECT verdict, merged FROM pr_provider_outcomes WHERE normalizedPrUrl = ? LIMIT 1`,
        )
        .get(prUrl) as { verdict: string; merged: number };
      expect(provider).toEqual({ verdict: "approved_merged", merged: 1 });
      expect(queue.listWorkerPrBacklog()).toContainEqual(
        expect.objectContaining({ prUrl, mergeState: "merged" }),
      );
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(0);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("normalizes a PR URL supplied at enqueue before terminal reconciliation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-link-normalization-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const enqueued = queue.enqueue({
        taskId: "pr-link-normalization",
        sessionId: "dev",
        kind: "task.execute",
        prUrl: "HTTPS://GITHUB.COM/Example/Repository/pull/701/?source=queue",
        params: {},
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-pr-link-normalization").job?.id).toBe(jobId);
      expect(queue.complete(jobId, { summary: "published" }).ok).toBe(true);
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(1);

      expect(
        store.recordPrFeedback({
          jobId,
          prUrl: "https://github.com/example/repository/pull/701",
          verdict: "approved_merged",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(0);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("orders delayed provider outcomes by job generation and provider state time", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-link-reopened-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    const prUrl = "https://github.com/example/repository/pull/702";
    try {
      const first = queue.enqueue({
        taskId: "pr-link-reopened-first",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const firstJobId = String(first.jobId ?? "");
      expect(queue.claim("worker-pr-link-reopened-first").job?.id).toBe(firstJobId);
      expect(queue.complete(firstJobId, { summary: "published", prUrl }).ok).toBe(true);
      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:first-close",
          jobId: firstJobId,
          prUrl,
          verdict: "closed_unmerged",
          providerStateAt: "2026-06-01T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);

      const db = (store as unknown as { db: any }).db;
      const firstProviderState = db
        .prepare(
          `SELECT jobId, verdict, providerStateAt, updatedAt
           FROM pr_provider_outcomes
           WHERE normalizedPrUrl = ?`,
        )
        .get(prUrl) as {
        jobId: string;
        verdict: string;
        providerStateAt: string;
        updatedAt: string;
      };

      const second = queue.enqueue({
        taskId: "pr-link-reopened-second",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const secondJobId = String(second.jobId ?? "");
      expect(queue.claim("worker-pr-link-reopened-second").job?.id).toBe(secondJobId);
      expect(queue.complete(secondJobId, { summary: "reopened", prUrl }).ok).toBe(true);

      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:first-close-delayed-replay",
          jobId: firstJobId,
          patternKey: "reopened::delayed_old_generation",
          prUrl,
          verdict: "closed_unmerged",
          providerStateAt: "2026-06-01T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE job_id = ?`)
            .get(firstJobId) as { count: number }
        ).count,
      ).toBe(0);

      expect(
        db
          .prepare(
            `SELECT jobId, verdict, providerStateAt, updatedAt
             FROM pr_provider_outcomes
             WHERE normalizedPrUrl = ?`,
          )
          .get(prUrl),
      ).toEqual(firstProviderState);

      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toContainEqual(
        expect.objectContaining({ jobId: secondJobId, prUrl }),
      );
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(1);

      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:second-close",
          jobId: secondJobId,
          prUrl,
          verdict: "closed_unmerged",
          provider_state_at: "2026-06-01T03:00:00.000Z",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(0);
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(0);

      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:second-close-delayed-older-state",
          jobId: secondJobId,
          prUrl,
          verdict: "rejected_comment_cap_closed",
          providerStateAt: "2026-06-01T02:00:00.000Z",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(
        db
          .prepare(
            `SELECT jobId, verdict, providerStateAt
             FROM pr_provider_outcomes
             WHERE normalizedPrUrl = ?`,
          )
          .get(prUrl),
      ).toEqual({
        jobId: secondJobId,
        verdict: "closed_unmerged",
        providerStateAt: "2026-06-01T03:00:00.000Z",
      });

      const beforeMalformedFutureMs = Date.now();
      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:second-close-malformed-future",
          jobId: secondJobId,
          prUrl,
          verdict: "rejected_comment_cap_closed",
          providerStateAt: "3000-01-01T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      const afterMalformedFutureMs = Date.now();
      const boundedFuture = db
        .prepare(
          `SELECT verdict, providerStateAt
           FROM pr_provider_outcomes
           WHERE normalizedPrUrl = ?`,
        )
        .get(prUrl) as { verdict: string; providerStateAt: string };
      expect(boundedFuture.verdict).toBe("rejected_comment_cap_closed");
      expect(Date.parse(boundedFuture.providerStateAt)).toBeGreaterThanOrEqual(
        beforeMalformedFutureMs,
      );
      expect(Date.parse(boundedFuture.providerStateAt)).toBeLessThanOrEqual(afterMalformedFutureMs);

      const nextAuthoritativeStateAt = new Date(afterMalformedFutureMs + 60_000).toISOString();
      expect(
        store.recordPrFeedback({
          feedbackKey: "reopened:second-close-after-malformed-future",
          jobId: secondJobId,
          prUrl,
          verdict: "closed_unmerged",
          providerStateAt: nextAuthoritativeStateAt,
        }),
      ).toMatchObject({ ok: true, acknowledged: true });
      expect(
        db
          .prepare(
            `SELECT verdict, providerStateAt
             FROM pr_provider_outcomes
             WHERE normalizedPrUrl = ?`,
          )
          .get(prUrl),
      ).toEqual({
        verdict: "closed_unmerged",
        providerStateAt: nextAuthoritativeStateAt,
      });
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("counts distinct PRs even when one PR has many newer job attempts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-backlog-distinct-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    try {
      const completeJob = (taskId: string, workerId: string, prUrl: string): void => {
        const enqueued = queue.enqueue({
          taskId,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
        });
        const jobId = String(enqueued.jobId ?? "");
        expect(queue.claim(workerId).job?.id).toBe(jobId);
        expect(queue.complete(jobId, { summary: "published", prUrl }).ok).toBe(true);
      };
      const olderPrUrl = "https://github.com/example/repository/pull/801";
      const repeatedPrUrl = "https://github.com/example/repository/pull/802";
      completeJob("distinct-older", "worker-distinct-older", olderPrUrl);
      await Bun.sleep(5);
      for (let index = 0; index < 55; index += 1) {
        completeJob(`repeated-${index}`, `worker-repeated-${index}`, repeatedPrUrl);
      }

      const backlog = queue.listWorkerPrBacklog(2);
      expect(backlog).toHaveLength(2);
      expect(backlog.map((entry) => entry.prUrl).sort()).toEqual(
        [olderPrUrl, repeatedPrUrl].sort(),
      );
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(2);
    } finally {
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });

  test("rejects a provider outcome whose job and PR URL do not match", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pushpals-pr-link-mismatch-"));
    const dbPath = join(tempDir, "shared.db");
    const queue = new JobQueue(dbPath);
    const store = new AutonomyStore(dbPath);
    try {
      const enqueued = queue.enqueue({
        taskId: "pr-link-mismatch",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const jobId = String(enqueued.jobId ?? "");
      expect(queue.claim("worker-pr-link-mismatch").job?.id).toBe(jobId);
      expect(
        queue.complete(jobId, {
          summary: "published",
          prUrl: "https://github.com/org/repo/pull/601",
        }).ok,
      ).toBe(true);

      const rejected = store.recordPrFeedback({
        jobId,
        prUrl: "https://github.com/org/repo/pull/999",
        verdict: "approved_merged",
      });
      expect(rejected).toMatchObject({ ok: true, ignored: true });
      expect(rejected.acknowledged).toBeUndefined();
      expect(queue.listPersistedPrLinksPage({ limit: 10 })).toHaveLength(1);
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(1);
    } finally {
      store.close();
      queue.close();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep SQLite temp handles briefly after close; cleanup best-effort.
      }
    }
  });
});
