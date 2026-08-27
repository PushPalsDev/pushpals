import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
      prHeadSha: "abc1234",
      resolutionType: "review_fix",
      sourceJobId,
    },
  };
}

describe("server JobQueue repair scheduling", () => {
  test("claims deadline-bound repair work ahead of older background autonomy work", () => {
    const queue = new JobQueue(":memory:");
    try {
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
      const repair = queue.enqueue({
        taskId: "repair-pr-697",
        sessionId: "dev",
        kind: "task.execute",
        workClass: "repair",
        queueWaitBudgetMs: 30_000,
        prUrl: "https://github.com/example/repo/pull/697",
        dedupeKey: "review-fix:697:abc1234",
        params: reviewRepairParams(),
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
      const initial = queue.enqueue({
        taskId: "repair-pr-697",
        sessionId: "dev",
        kind: "task.execute",
        prUrl: "https://github.com/example/repo/pull/697",
        dedupeKey: "review-fix:697:abc1234",
        params: reviewRepairParams(),
      });
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

  test("startup reconciliation rearms a repair stranded between terminal persistence and recovery enqueue", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-startup-"));
    const dbPath = join(root, "state.sqlite");
    let initialJobId = "";
    try {
      const queue = new JobQueue(dbPath);
      try {
        const initial = queue.enqueue({
          taskId: "repair-pr-697-startup",
          sessionId: "dev",
          kind: "task.execute",
          prUrl: "https://github.com/example/repo/pull/697",
          dedupeKey: "review-fix:697:startup",
          params: reviewRepairParams(),
        });
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
             WHERE sourceJobId = ?`,
          )
          .run(initialJobId, "job-root");
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
      const initial = queue.enqueue({
        taskId: "repair-pr-697-success",
        sessionId: "dev",
        kind: "task.execute",
        prUrl: "https://github.com/example/repo/pull/697",
        dedupeKey: "review-fix:697:success",
        params: reviewRepairParams(),
      });
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
             WHERE sourceJobId = ?`,
          )
          .get("job-root"),
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
      const initial = queue.enqueue({
        taskId: "repair-pr-697-stale-claim",
        sessionId: "dev",
        kind: "task.execute",
        prUrl: "https://github.com/example/repo/pull/697",
        dedupeKey: "review-fix:697:stale-claim",
        params: reviewRepairParams(),
      });
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
             WHERE sourceJobId = ?`,
          )
          .get("job-root"),
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
             WHERE sourceJobId = ?`,
          )
          .get("job-root"),
      ).toMatchObject({ activeJobId: successorId, status: "succeeded" });
    } finally {
      queue.close();
    }
  });

  test("surfaces expired queue budgets in pending and terminal backpressure telemetry", () => {
    const queue = new JobQueue(":memory:");
    try {
      const queued = queue.enqueue({
        taskId: "expired-recovery-budget",
        sessionId: "dev",
        kind: "task.execute",
        workClass: "recovery",
        queueWaitBudgetMs: 1_000,
        params: { recovery: { strategy: "root_cause" } },
      });
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

  test("startup migration classifies legacy pending review work and restores its deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-repair-migration-"));
    const dbPath = join(root, "state.sqlite");
    try {
      const first = new JobQueue(dbPath);
      const enqueued = first.enqueue({
        taskId: "legacy-review-repair",
        sessionId: "dev",
        kind: "task.execute",
        prUrl: "https://github.com/example/repo/pull/697",
        params: reviewRepairParams(),
      });
      first.close();

      const legacy = new Database(dbPath);
      legacy
        .prepare(`UPDATE jobs SET workClass = 'standard', queueDeadlineAt = NULL WHERE id = ?`)
        .run(enqueued.jobId);
      legacy.close();

      const restarted = new JobQueue(dbPath);
      try {
        expect(restarted.getJob(String(enqueued.jobId))).toMatchObject({
          workClass: "repair",
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
