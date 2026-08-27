import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JobQueue } from "../apps/server/src/jobs";

function reviewRepairParams(sourceJobId = "job-root") {
  return {
    origin: "autonomy",
    instruction: "Repair the rejected pull request.",
    planning: {
      queuePriority: "interactive",
      queueWaitBudgetMs: 90_000,
      workClass: "repair",
    },
    reviewAgent: {
      prNumber: 697,
      prUrl: "https://github.com/example/repo/pull/697",
      repositoryIdentity: "https://github.com/example/repo.git",
      prHeadSha: "abc1234",
      prBaseSha: "def5678",
      resolutionType: "review_fix",
      sourceJobId,
    },
  };
}

function enqueueAuthorizedReviewRepair(
  queue: JobQueue,
  body: Record<string, unknown>,
  suffix: string,
) {
  const source = queue.enqueue({
    taskId: `source-${suffix}`,
    sessionId: "dev",
    kind: "task.execute",
    params: { origin: "autonomy", autonomy: { origin: "autonomy" } },
  });
  const sourceId = String(source.jobId);
  expect(queue.claim(`worker-source-${suffix}`).job?.id).toBe(sourceId);
  expect(
    queue.complete(sourceId, {
      summary: "published",
    }).ok,
  ).toBe(true);
  const db = (queue as unknown as { db: Database }).db;
  db.prepare(`UPDATE jobs SET prUrl = ?, prUrlNormalized = ? WHERE id = ?`).run(
    "https://github.com/example/repo/pull/697",
    "https://github.com/example/repo/pull/697",
    sourceId,
  );
  const authorizedBody = {
    repositoryIdentity: "https://github.com/example/repo.git",
    ...body,
    params: reviewRepairParams(sourceId),
  };
  expect(queue.authorizeReviewRepairCapability(authorizedBody)).toMatchObject({ ok: true });
  return queue.enqueue(authorizedBody, { authorizedElevatedWorkClass: "repair" });
}

describe("server JobQueue repair scheduling", () => {
  test("claims deadline-bound repair work ahead of older background autonomy work", () => {
    const queue = new JobQueue(":memory:");
    try {
      const repair = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-pr-697",
          sessionId: "dev",
          kind: "task.execute",
          workClass: "repair",
          queueWaitBudgetMs: 30_000,
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:abc1234",
        },
        "priority",
      );
      const background = queue.enqueue({
        taskId: "background-idea",
        sessionId: "dev",
        kind: "task.execute",
        priority: "background",
        workClass: "background",
        queueWaitBudgetMs: 240_000,
        targetWorkerId: "worker-repair",
        params: { origin: "autonomy" },
      });
      const claimed = queue.claim("worker-repair");
      expect(claimed.job?.id).toBe(repair.jobId);
      expect(claimed.job?.workClass).toBe("repair");
      expect(Date.parse(String(claimed.job?.queueDeadlineAt))).toBeGreaterThan(
        Date.parse(String(claimed.job?.enqueuedAt)),
      );
      expect(queue.complete(String(repair.jobId), { summary: "fixed" }).ok).toBe(true);
      expect(queue.claim("worker-repair").job?.id).toBe(background.jobId);
    } finally {
      queue.close();
    }
  });

  test("rearms one durable root-cause repair after a rejected PR repair fails", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-pr-697",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:abc1234",
        },
        "rearm",
      );
      const first = queue.claim("worker-repair").job;
      expect(first?.id).toBe(initial.jobId);
      expect(
        queue.fail(String(first?.id), {
          message: "Required browser validation unavailable",
          diagnostics: {
            terminal: {
              failureClass: "environment",
              terminalStage: "quality_gate",
              summary: "Browser capability unavailable in the sandbox",
            },
          },
        }).ok,
      ).toBe(true);

      const recovery = queue.getPendingJobs().find((job) => job.resumeOfJobId === first?.id);
      expect(recovery).toMatchObject({
        workClass: "recovery",
        priority: "interactive",
        attempt: 2,
      });
      const recoveryParams = JSON.parse(String(recovery?.params ?? "{}"));
      expect(recoveryParams.recovery).toMatchObject({
        previousJobId: first?.id,
        attempt: 2,
        failureClass: "environment",
        strategy: "capability_root_cause",
      });

      const claimedRecovery = queue.claim("worker-repair").job;
      expect(claimedRecovery?.id).toBe(recovery?.id);
      expect(
        queue.fail(String(claimedRecovery?.id), {
          message: "The strategy-changing recovery still cannot validate",
          diagnostics: {
            terminal: {
              failureClass: "environment",
              terminalStage: "quality_gate",
              summary: "Browser capability remains unavailable",
            },
          },
        }).ok,
      ).toBe(true);
      expect(queue.getPendingJobs()).toHaveLength(0);
      expect(queue.reconcileReviewRepairLifecycles()).toMatchObject({ exhausted: 1, rearmed: 0 });
    } finally {
      queue.close();
    }
  });

  test("dedupes one PR/head lifecycle even when callers vary the dedupe key", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-lifecycle-owner",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:owner",
        },
        "lifecycle-owner",
      );
      const initialParams = JSON.parse(String(queue.getJob(String(initial.jobId))?.params ?? "{}"));
      const duplicate = queue.enqueue(
        {
          taskId: "repair-lifecycle-duplicate",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:caller-varied-key",
          params: initialParams,
        },
        { authorizedElevatedWorkClass: "repair" },
      );
      expect(duplicate).toMatchObject({
        ok: true,
        deduped: true,
        jobId: initial.jobId,
        taskId: "repair-lifecycle-owner",
      });
      expect(queue.getPendingJobs()).toHaveLength(1);
    } finally {
      queue.close();
    }
  });

  test("does not let a legacy dedupe key collapse a base-only repair advance after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-base-advance-"));
    const dbPath = join(root, "state.sqlite");
    let initialJobId = "";
    let initialParams: Record<string, any> = {};
    try {
      const first = new JobQueue(dbPath);
      try {
        const initial = enqueueAuthorizedReviewRepair(
          first,
          {
            taskId: "repair-old-base",
            sessionId: "dev",
            kind: "task.execute",
            prUrl: "https://github.com/example/repo/pull/697",
            dedupeKey: "legacy-review-fix:697:abc1234",
          },
          "base-advance",
        );
        initialJobId = String(initial.jobId);
        initialParams = JSON.parse(String(first.getJob(initialJobId)?.params ?? "{}"));
      } finally {
        first.close();
      }

      const restarted = new JobQueue(dbPath);
      try {
        const advancedParams = structuredClone(initialParams);
        advancedParams.reviewAgent.prBaseSha = "advanced-base-999";
        const advancedBody = {
          taskId: "repair-new-base",
          sessionId: "dev",
          kind: "task.execute",
          workClass: "repair",
          repositoryIdentity: "https://github.com/example/repo.git",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "legacy-review-fix:697:abc1234",
          params: advancedParams,
        };
        expect(restarted.authorizeReviewRepairCapability(advancedBody)).toMatchObject({ ok: true });

        const advanced = restarted.enqueue(advancedBody, {
          authorizedElevatedWorkClass: "repair",
        });
        expect(advanced).toMatchObject({ ok: true });
        expect(advanced.deduped).not.toBe(true);
        expect(advanced.jobId).not.toBe(initialJobId);

        const pending = restarted.getPendingJobs();
        expect(pending).toHaveLength(2);
        const effectiveDedupeKeys = pending.map((job) => job.dedupeKey);
        expect(new Set(effectiveDedupeKeys).size).toBe(2);
        expect(effectiveDedupeKeys.every((key) => key?.startsWith("review-repair:"))).toBe(true);

        const db = (restarted as unknown as { db: Database }).db;
        const lifecycles = db
          .prepare(
            `SELECT baseSha, activeJobId
             FROM pr_repair_lifecycle
             ORDER BY baseSha ASC`,
          )
          .all() as Array<{ baseSha: string; activeJobId: string }>;
        expect(lifecycles).toHaveLength(2);
        expect(new Map(lifecycles.map((row) => [row.baseSha, row.activeJobId]))).toEqual(
          new Map([
            ["def5678", initialJobId],
            ["advanced-base-999", String(advanced.jobId)],
          ]),
        );
        expect(
          restarted.reviewRepairAdmission({
            repositoryIdentity: "https://github.com/example/repo.git",
            prUrl: "https://github.com/example/repo/pull/697",
            params: initialParams,
          }),
        ).toMatchObject({ activeJobId: initialJobId });
        expect(restarted.reviewRepairAdmission(advancedBody)).toMatchObject({
          activeJobId: advanced.jobId,
        });
      } finally {
        restarted.close();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can retain a SQLite handle briefly after close.
      }
    }
  });

  test("startup reconciliation rearms a repair stranded between terminal persistence and recovery enqueue", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-startup-"));
    const dbPath = join(root, "state.sqlite");
    let initialJobId = "";
    try {
      const queue = new JobQueue(dbPath);
      try {
        const initial = enqueueAuthorizedReviewRepair(
          queue,
          {
            taskId: "repair-pr-697-startup",
            sessionId: "dev",
            kind: "task.execute",
            prUrl: "https://github.com/example/repo/pull/697",
            dedupeKey: "review-fix:697:startup",
          },
          "startup",
        );
        initialJobId = initial.jobId;
        expect(queue.claim("worker-repair").job?.id).toBe(initialJobId);
        expect(
          queue.fail(initialJobId, {
            message: "SCM stopped after persisting the rejected repair",
            diagnostics: {
              terminal: {
                failureClass: "orchestration",
                terminalStage: "finalization",
                summary: "Completion handoff was interrupted",
              },
            },
          }).ok,
        ).toBe(true);
        expect(queue.getPendingJobs()).toHaveLength(1);
      } finally {
        queue.close();
      }

      // Reproduce the durable crash window from soak PR #697: the terminal
      // repair is present, while the replacement job was never committed.
      const interrupted = new Database(dbPath);
      try {
        interrupted.prepare(`DELETE FROM jobs WHERE resumeOfJobId = ?`).run(initialJobId);
        interrupted
          .prepare(
            `UPDATE pr_repair_lifecycle
             SET activeJobId = ?, status = 'running', attemptCount = 1
             WHERE headSha = ?`,
          )
          .run(initialJobId, "abc1234");
      } finally {
        interrupted.close();
      }

      const restarted = new JobQueue(dbPath);
      try {
        const pending = restarted.getPendingJobs();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          workClass: "recovery",
          resumeOfJobId: initialJobId,
          attempt: 2,
        });
        expect(restarted.reconcileReviewRepairLifecycles()).toMatchObject({
          rearmed: 0,
        });
        expect(restarted.getPendingJobs()).toHaveLength(1);
      } finally {
        restarted.close();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can retain a SQLite handle for a short time after close.
      }
    }
  });

  test("historical failed attempts cannot overwrite a succeeded repair lifecycle", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-pr-697-success",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:success",
        },
        "success",
      );
      expect(queue.claim("worker-repair").job?.id).toBe(initial.jobId);
      expect(queue.fail(String(initial.jobId), { message: "first repair rejected" }).ok).toBe(true);
      const recovery = queue.claim("worker-repair").job;
      expect(recovery?.workClass).toBe("recovery");
      expect(queue.complete(String(recovery?.id), { summary: "repair published" }).ok).toBe(true);

      queue.reconcileReviewRepairLifecycles();
      const db = (queue as unknown as { db: Database }).db;
      expect(
        db
          .prepare(
            `SELECT activeJobId, status, attemptCount
             FROM pr_repair_lifecycle
             WHERE headSha = ?`,
          )
          .get("abc1234"),
      ).toMatchObject({
        activeJobId: recovery?.id,
        status: "succeeded",
        attemptCount: 2,
      });
      expect(queue.getPendingJobs()).toHaveLength(0);
    } finally {
      queue.close();
    }
  });

  test("stale-claim recovery transfers durable repair ownership to its retry successor", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-pr-697-stale-claim",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:stale-claim",
        },
        "stale",
      );
      expect(queue.claim("worker-stale-repair").job?.id).toBe(initial.jobId);

      const db = (queue as unknown as { db: Database }).db;
      const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
      db.prepare(`UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?`).run(
        staleIso,
        "worker-stale-repair",
      );
      db.prepare(
        `UPDATE jobs
         SET claimedAt = ?, startedAt = NULL, firstLogAt = NULL,
             lastActivityAt = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(staleIso, staleIso, staleIso, initial.jobId);

      const recovered = queue.recoverStaleClaimedJobs(120_000);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        jobId: initial.jobId,
        action: "requeued",
        retrySafety: "retry_safe",
      });
      const successorId = String(recovered[0]?.replacementJobId);
      expect(
        db
          .prepare(
            `SELECT activeJobId, status, attemptCount
             FROM pr_repair_lifecycle
             WHERE headSha = ?`,
          )
          .get("abc1234"),
      ).toMatchObject({ activeJobId: successorId, status: "queued", attemptCount: 1 });

      db.prepare(`UPDATE jobs SET availableAt = NULL WHERE id = ?`).run(successorId);
      expect(queue.claim("worker-stale-repair").job?.id).toBe(successorId);
      expect(queue.complete(successorId, { summary: "repair recovered" }).ok).toBe(true);
      expect(queue.reconcileReviewRepairLifecycles()).toMatchObject({ rearmed: 0 });
      expect(queue.getPendingJobs()).toHaveLength(0);
      expect(
        db
          .prepare(
            `SELECT activeJobId, status
             FROM pr_repair_lifecycle
             WHERE headSha = ?`,
          )
          .get("abc1234"),
      ).toMatchObject({ activeJobId: successorId, status: "succeeded" });
    } finally {
      queue.close();
    }
  });

  test("surfaces expired queue budgets in pending and terminal backpressure telemetry", () => {
    const queue = new JobQueue(":memory:");
    try {
      const queued = queue.enqueue(
        {
          taskId: "expired-recovery-budget",
          sessionId: "dev",
          kind: "task.execute",
          workClass: "recovery",
          queueWaitBudgetMs: 1_000,
          params: { recovery: { strategy: "root_cause" } },
        },
        { authorizedElevatedWorkClass: "recovery" },
      );
      const db = (queue as unknown as { db: Database }).db;
      db.prepare(`UPDATE jobs SET queueDeadlineAt = ? WHERE id = ?`).run(
        new Date(Date.now() - 1_000).toISOString(),
        queued.jobId,
      );

      expect(queue.nextPendingSnapshot(1)[0]).toMatchObject({
        id: queued.jobId,
        workClass: "recovery",
        deadlineMissed: true,
      });
      expect(queue.recoveryBackpressureSummary()).toMatchObject({
        blocked: true,
        pendingRecovery: 1,
        pendingRepair: 0,
        overdue: 1,
      });
      expect(queue.claim("worker-expired-budget").job?.id).toBe(queued.jobId);
      expect(queue.complete(String(queued.jobId), { summary: "recovered" }).ok).toBe(true);
      expect(queue.sloSummary()).toMatchObject({
        terminal: 1,
        queueDeadlineMisses: 1,
        queueDeadlineMissRate: 1,
      });
    } finally {
      queue.close();
    }
  });

  test("does not grant an elevated lane from caller-supplied recovery labels", () => {
    const queue = new JobQueue(":memory:");
    try {
      const spoofed = queue.enqueue({
        taskId: "spoofed-recovery",
        sessionId: "dev",
        kind: "task.execute",
        workClass: "recovery",
        params: { origin: "autonomy", recovery: { strategy: "skip-circuits" } },
      });
      expect(queue.getJob(String(spoofed.jobId))?.workClass).toBe("autonomy");
    } finally {
      queue.close();
    }
  });

  test("serves an overdue standard job before a non-overdue recovery", () => {
    const queue = new JobQueue(":memory:");
    try {
      const recovery = queue.enqueue(
        {
          taskId: "non-overdue-recovery",
          sessionId: "dev",
          kind: "task.execute",
          workClass: "recovery",
        },
        { authorizedElevatedWorkClass: "recovery" },
      );
      const standard = queue.enqueue({
        taskId: "overdue-standard",
        sessionId: "dev",
        kind: "task.execute",
      });
      const db = (queue as unknown as { db: Database }).db;
      db.prepare(`UPDATE jobs SET queueDeadlineAt = ? WHERE id = ?`).run(
        new Date(Date.now() - 1_000).toISOString(),
        standard.jobId,
      );
      expect(queue.claim("worker-fair-deadline").job?.id).toBe(standard.jobId);
      expect(queue.complete(String(standard.jobId), { summary: "done" }).ok).toBe(true);
      expect(queue.claim("worker-fair-deadline").job?.id).toBe(recovery.jobId);
    } finally {
      queue.close();
    }
  });

  test("serves the oldest absolute overdue deadline before applying lane fairness", () => {
    const queue = new JobQueue(":memory:");
    try {
      for (let index = 0; index < 3; index += 1) {
        const burst = queue.enqueue(
          {
            taskId: `deadline-primer-recovery-${index}`,
            sessionId: "dev",
            kind: "task.execute",
            workClass: "recovery",
          },
          { authorizedElevatedWorkClass: "recovery" },
        );
        expect(queue.claim("worker-absolute-deadline").job?.id).toBe(burst.jobId);
        expect(queue.complete(String(burst.jobId), { summary: "done" }).ok).toBe(true);
      }
      const recovery = queue.enqueue(
        {
          taskId: "oldest-overdue-recovery",
          sessionId: "dev",
          kind: "task.execute",
          workClass: "recovery",
        },
        { authorizedElevatedWorkClass: "recovery" },
      );
      const standard = queue.enqueue({
        taskId: "newer-overdue-standard",
        sessionId: "dev",
        kind: "task.execute",
      });
      const db = (queue as unknown as { db: Database }).db;
      db.prepare(`UPDATE jobs SET queueDeadlineAt = ? WHERE id = ?`).run(
        new Date(Date.now() - 60_000).toISOString(),
        recovery.jobId,
      );
      db.prepare(`UPDATE jobs SET queueDeadlineAt = ? WHERE id = ?`).run(
        new Date(Date.now() - 1_000).toISOString(),
        standard.jobId,
      );
      expect(queue.claim("worker-absolute-deadline").job?.id).toBe(recovery.jobId);
    } finally {
      queue.close();
    }
  });

  test("bounds elevated bursts so ordinary work receives a fair share", () => {
    const queue = new JobQueue(":memory:");
    try {
      const recoveries = Array.from({ length: 4 }, (_, index) =>
        queue.enqueue(
          {
            taskId: `burst-recovery-${index}`,
            sessionId: "dev",
            kind: "task.execute",
            workClass: "recovery",
          },
          { authorizedElevatedWorkClass: "recovery" },
        ),
      );
      const standard = queue.enqueue({
        taskId: "fair-share-standard",
        sessionId: "dev",
        kind: "task.execute",
      });
      const recoveryIds = new Set(recoveries.map((entry) => String(entry.jobId)));
      for (let index = 0; index < 3; index += 1) {
        const claimed = queue.claim("worker-fair-share").job;
        expect(claimed?.workClass).toBe("recovery");
        expect(recoveryIds.delete(String(claimed?.id))).toBe(true);
        expect(queue.complete(String(claimed?.id), { summary: "done" }).ok).toBe(true);
      }
      const fairShare = queue.claim("worker-fair-share").job;
      expect(fairShare?.id).toBe(standard.jobId);
      expect(queue.complete(String(fairShare?.id), { summary: "done" }).ok).toBe(true);
      expect(recoveryIds.has(String(queue.claim("worker-fair-share").job?.id))).toBe(true);
    } finally {
      queue.close();
    }
  });

  test("keeps an exhausted PR/head repair tombstoned across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-exhausted-"));
    const dbPath = join(root, "state.sqlite");
    try {
      const queue = new JobQueue(dbPath);
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-exhaustion",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:exhaustion",
        },
        "exhaustion",
      );
      const initialRow = queue.getJob(String(initial.jobId));
      const persistedParams = JSON.parse(String(initialRow?.params ?? "{}"));
      expect(queue.claim("worker-exhaustion").job?.id).toBe(initial.jobId);
      expect(queue.fail(String(initial.jobId), { message: "first failure" }).ok).toBe(true);
      const recovery = queue.claim("worker-exhaustion").job;
      expect(queue.fail(String(recovery?.id), { message: "second failure" }).ok).toBe(true);
      queue.close();

      const restarted = new JobQueue(dbPath);
      try {
        const admission = restarted.reviewRepairAdmission({
          prUrl: "https://github.com/example/repo/pull/697",
          params: persistedParams,
        });
        expect(admission).toMatchObject({ authorized: false, exhausted: true });
        expect(
          restarted.enqueue(
            {
              taskId: "repair-after-restart",
              sessionId: "dev",
              kind: "task.execute",
              prUrl: "https://github.com/example/repo/pull/697",
              params: persistedParams,
            },
            { authorizedElevatedWorkClass: "repair" },
          ),
        ).toMatchObject({ ok: false, message: expect.stringContaining("exhausted") });
      } finally {
        restarted.close();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can retain a SQLite handle briefly after close.
      }
    }
  });

  test("settled lifecycle reconciliation is read-only and does not rewind timestamps", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "settled-repair",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
        },
        "settled",
      );
      expect(queue.claim("worker-settled").job?.id).toBe(initial.jobId);
      expect(queue.complete(String(initial.jobId), { summary: "published" }).ok).toBe(true);
      const db = (queue as unknown as { db: Database }).db;
      const before = db
        .prepare(`SELECT updatedAt FROM pr_repair_lifecycle WHERE activeJobId = ?`)
        .get(initial.jobId) as { updatedAt: string };
      db.exec(`
        CREATE TABLE lifecycle_write_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          marker INTEGER NOT NULL
        );
        CREATE TRIGGER audit_lifecycle_update
        AFTER UPDATE ON pr_repair_lifecycle
        BEGIN
          INSERT INTO lifecycle_write_audit (marker) VALUES (1);
        END;
      `);
      queue.reconcileReviewRepairLifecycles("2000-01-01T00:00:00.000Z");
      queue.reconcileReviewRepairLifecycles("2000-01-01T00:00:00.000Z");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM lifecycle_write_audit`).get()).toMatchObject(
        { count: 0 },
      );
      expect(
        db
          .prepare(`SELECT updatedAt FROM pr_repair_lifecycle WHERE activeJobId = ?`)
          .get(initial.jobId),
      ).toEqual(before);
    } finally {
      queue.close();
    }
  });

  test("rearms a semantic completed_no_change repair instead of succeeding its lifecycle", () => {
    const queue = new JobQueue(":memory:");
    try {
      const initial = enqueueAuthorizedReviewRepair(
        queue,
        {
          taskId: "repair-no-change",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
        },
        "no-change",
      );
      expect(queue.claim("worker-no-change").job?.id).toBe(initial.jobId);
      expect(
        queue.complete(String(initial.jobId), {
          summary: "completed_no_change: no publishable patch was produced",
          diagnostics: {
            terminal: {
              failureClass: "artifact_only_no_publishable_patch",
              terminalStage: "quality_gate",
              summary: "No file changes were detected.",
            },
          },
        }).ok,
      ).toBe(true);
      const recovery = queue.getPendingJobs().find((job) => job.resumeOfJobId === initial.jobId);
      expect(recovery).toMatchObject({ workClass: "recovery", attempt: 2 });
      const db = (queue as unknown as { db: Database }).db;
      expect(
        db
          .prepare(`SELECT status, activeJobId, attemptCount FROM pr_repair_lifecycle LIMIT 1`)
          .get(),
      ).toMatchObject({ status: "queued", activeJobId: recovery?.id, attemptCount: 2 });
      expect(queue.sloSummary()).toMatchObject({
        terminal: 2,
        completed: 2,
        noChange: 1,
        successRate: 0.5,
      });
    } finally {
      queue.close();
    }
  });

  test("requires an exact SCM-issued capability and rejects caller-invented repair heads", () => {
    const queue = new JobQueue(":memory:");
    try {
      const exact = {
        taskId: "repair-capability-exact",
        sessionId: "dev",
        kind: "task.execute",
        workClass: "repair",
        repositoryIdentity: "https://github.com/example/repo.git",
        prUrl: "https://github.com/example/repo/pull/697",
        params: reviewRepairParams("source-job-that-cannot-authorize"),
      };
      expect(queue.enqueue(exact, { authorizedElevatedWorkClass: "repair" })).toMatchObject({
        ok: false,
        message: expect.stringContaining("SourceControlManager"),
      });
      expect(queue.authorizeReviewRepairCapability(exact)).toMatchObject({ ok: true });

      const forgedParams = structuredClone(exact.params);
      forgedParams.reviewAgent.prHeadSha = "invented999";
      expect(
        queue.enqueue(
          { ...exact, taskId: "repair-capability-forged", params: forgedParams },
          { authorizedElevatedWorkClass: "repair" },
        ),
      ).toMatchObject({ ok: false, message: expect.stringContaining("SourceControlManager") });

      const mismatchedPrParams = structuredClone(exact.params);
      mismatchedPrParams.reviewAgent.prNumber = 698;
      expect(
        queue.enqueue(
          { ...exact, taskId: "repair-capability-wrong-pr", params: mismatchedPrParams },
          { authorizedElevatedWorkClass: "repair" },
        ),
      ).toMatchObject({ ok: false, message: expect.stringContaining("exact repository") });

      expect(
        queue.enqueue(
          {
            ...exact,
            taskId: "repair-capability-wrong-repository",
            repositoryIdentity: "https://github.com/other/repo.git",
          },
          { authorizedElevatedWorkClass: "repair" },
        ),
      ).toMatchObject({ ok: false, message: expect.stringContaining("exact repository") });

      expect(queue.enqueue(exact, { authorizedElevatedWorkClass: "repair" })).toMatchObject({
        ok: true,
      });
    } finally {
      queue.close();
    }
  });

  test("atomically persists an initial repair job and its durable lifecycle", () => {
    const queue = new JobQueue(":memory:");
    try {
      const body = {
        taskId: "repair-atomic-lifecycle",
        sessionId: "dev",
        kind: "task.execute",
        workClass: "repair",
        repositoryIdentity: "https://github.com/example/repo.git",
        prUrl: "https://github.com/example/repo/pull/697",
        params: reviewRepairParams(),
      };
      expect(queue.authorizeReviewRepairCapability(body)).toMatchObject({ ok: true });
      const db = (queue as unknown as { db: Database }).db;
      db.exec(`
        CREATE TRIGGER reject_repair_lifecycle_insert
        BEFORE INSERT ON pr_repair_lifecycle
        BEGIN
          SELECT RAISE(ABORT, 'injected lifecycle persistence failure');
        END;
      `);
      expect(() => queue.enqueue(body, { authorizedElevatedWorkClass: "repair" })).toThrow(
        "injected lifecycle persistence failure",
      );
      expect(db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get()).toEqual({ count: 0 });
    } finally {
      queue.close();
    }
  });

  test("startup reconciliation scans unresolved repair lifecycles beyond the old 500-row cap", () => {
    const queue = new JobQueue(":memory:");
    try {
      const db = (queue as unknown as { db: Database }).db;
      const now = new Date().toISOString();
      const insertJob = db.prepare(
        `INSERT INTO jobs (
           id, taskId, sessionId, kind, params, priority, workClass,
           status, prUrl, prUrlNormalized, error, createdAt, updatedAt
         ) VALUES (?, ?, 'dev', 'task.execute', ?, 'interactive', 'repair',
                   'failed', ?, ?, 'repair failed', ?, ?)`,
      );
      const insertLifecycle = db.prepare(
        `INSERT INTO pr_repair_lifecycle (
           lifecycleKey, repositoryIdentity, prUrlNormalized, prNumber, headSha, baseSha, resolutionType,
           sourceJobId, activeJobId, status, attemptCount, maxAttempts, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, 'review_fix', ?, ?, 'running', 2, 2, ?, ?)`,
      );
      const seed = db.transaction(() => {
        for (let index = 0; index < 501; index += 1) {
          const jobId = `repair-terminal-${index}`;
          const sourceJobId = `repair-source-${index}`;
          const prNumber = 10_000 + index;
          const prUrl = `https://github.com/example/repo/pull/${prNumber}`;
          const headSha = `head-${index}`;
          const baseSha = `base-${index}`;
          const repositoryIdentity = "github.com/example/repo";
          const lifecycleKey = createHash("sha256")
            .update(
              JSON.stringify({
                repositoryIdentity,
                prUrlNormalized: prUrl,
                prNumber,
                headSha,
                baseSha,
                resolutionType: "review_fix",
              }),
            )
            .digest("hex")
            .slice(0, 32);
          const params = JSON.stringify({
            origin: "autonomy",
            reviewAgent: {
              prNumber,
              prUrl,
              repositoryIdentity,
              prHeadSha: headSha,
              prBaseSha: baseSha,
              resolutionType: "review_fix",
              sourceJobId,
            },
          });
          insertJob.run(jobId, `repair-${index}`, params, prUrl, prUrl, now, now);
          insertLifecycle.run(
            lifecycleKey,
            repositoryIdentity,
            prUrl,
            prNumber,
            headSha,
            baseSha,
            sourceJobId,
            jobId,
            now,
            now,
          );
        }
      });
      seed();

      expect(queue.reconcileReviewRepairLifecycles()).toMatchObject({
        scanned: 501,
        rearmed: 0,
        exhausted: 501,
      });
    } finally {
      queue.close();
    }
  });

  test("startup migration does not elevate legacy caller-supplied review metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-migration-"));
    const dbPath = join(root, "state.sqlite");
    try {
      const first = new JobQueue(dbPath);
      const enqueued = enqueueAuthorizedReviewRepair(
        first,
        {
          taskId: "legacy-review-repair",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
        },
        "migration",
      );
      first.close();

      const legacy = new Database(dbPath);
      legacy
        .prepare(`UPDATE jobs SET workClass = 'standard', queueDeadlineAt = NULL WHERE id = ?`)
        .run(enqueued.jobId);
      legacy.close();

      const restarted = new JobQueue(dbPath);
      try {
        expect(restarted.getJob(String(enqueued.jobId))).toMatchObject({
          workClass: "interactive",
          queueDeadlineAt: expect.any(String),
        });
      } finally {
        restarted.close();
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can retain a SQLite handle briefly after close.
      }
    }
  });
});
