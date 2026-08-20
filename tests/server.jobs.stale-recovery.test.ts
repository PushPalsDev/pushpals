import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_DEFERRAL_CONFLICT_CODE,
  JOB_DEFERRAL_PERSISTENCE_FAILED_CODE,
  JobQueue,
  type JobClaimAuthority,
  type JobStatus,
} from "../apps/server/src/jobs";

type JobMutationResult = {
  ok: boolean;
  replayed?: boolean;
};

type JobMutationCase = {
  name: string;
  finalStatus: JobStatus;
  prepare?: (queue: JobQueue, jobId: string, authority: JobClaimAuthority) => void;
  mutate: (queue: JobQueue, jobId: string, authority: JobClaimAuthority) => JobMutationResult;
};

const jobMutationCases: JobMutationCase[] = [
  {
    name: "complete",
    finalStatus: "completed",
    mutate: (queue, jobId, authority) =>
      queue.complete(jobId, { summary: "claim-authorized completion" }, authority),
  },
  {
    name: "fail",
    finalStatus: "failed",
    mutate: (queue, jobId, authority) =>
      queue.fail(
        jobId,
        {
          message: "claim-authorized failure",
          detail: "terminal mutation fencing test",
        },
        authority,
      ),
  },
  {
    name: "publishBlocked",
    finalStatus: "publish_blocked",
    mutate: (queue, jobId, authority) =>
      queue.publishBlocked(
        jobId,
        {
          message: "claim-authorized publication block",
          detail: "terminal mutation fencing test",
          publishBlocked: { stage: "push" },
        },
        authority,
      ),
  },
  {
    name: "defer",
    finalStatus: "pending",
    mutate: (queue, jobId, authority) =>
      queue.defer(
        jobId,
        {
          workerId: authority.workerId,
          deferMs: 60_000,
          reason: "claim_authority_test",
        },
        authority,
      ),
  },
  {
    name: "failDeferred",
    finalStatus: "failed",
    prepare: (queue, jobId, authority) => {
      const deferred = queue.defer(
        jobId,
        {
          workerId: authority.workerId,
          deferMs: 60_000,
          reason: "pre_execution_maintenance",
        },
        authority,
      );
      expect(deferred.ok).toBe(true);
    },
    mutate: (queue, jobId, authority) =>
      queue.failDeferred(
        jobId,
        {
          workerId: authority.workerId,
          message: "claim-authorized deferred failure",
          detail: "terminal mutation fencing test",
        },
        authority,
      ),
  },
];

function enqueueAndClaim(queue: JobQueue, workerId: string): string {
  const enqueue = queue.enqueue({
    taskId: `task-${workerId}`,
    sessionId: "dev",
    kind: "task.execute",
    params: { requestId: `req-${workerId}` },
  });
  expect(enqueue.ok).toBe(true);
  const claim = queue.claim(workerId);
  expect(claim.ok).toBe(true);
  return claim.job!.id;
}

function enqueueKindAndClaim(
  queue: JobQueue,
  workerId: string,
  kind: string,
  params: Record<string, unknown> = {},
): string {
  const enqueue = queue.enqueue({
    taskId: `task-${workerId}-${kind.replace(/[^a-z0-9]+/gi, "-")}`,
    sessionId: "dev",
    kind,
    params,
  });
  expect(enqueue.ok).toBe(true);
  const claim = queue.claim(workerId);
  expect(claim.ok).toBe(true);
  return claim.job!.id;
}

function reclaimForAuthorityTest(
  queue: JobQueue,
  label: string,
): {
  jobId: string;
  staleAuthority: JobClaimAuthority;
  currentAuthority: JobClaimAuthority;
} {
  const enqueued = queue.enqueue({
    taskId: `task-${label}`,
    sessionId: "dev",
    kind: "task.execute",
    params: {},
  });
  expect(enqueued.ok).toBe(true);

  const staleWorkerId = `worker-${label}-stale`;
  const firstClaim = queue.claim(staleWorkerId, { runtimeGeneration: "runtime-v1" });
  expect(firstClaim.ok).toBe(true);
  const staleAuthority: JobClaimAuthority = {
    workerId: staleWorkerId,
    claimGeneration: Number(firstClaim.job?.claimGeneration ?? 0),
  };
  expect(staleAuthority.claimGeneration).toBeGreaterThan(0);

  const jobId = String(enqueued.jobId ?? "");
  expect(
    queue.defer(
      jobId,
      {
        workerId: staleWorkerId,
        targetWorkerId: null,
        deferMs: 1_000,
        reason: "claim_authority_handoff",
      },
      staleAuthority,
    ).ok,
  ).toBe(true);

  const db = (queue as unknown as { db: any }).db as any;
  db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
    new Date(Date.now() - 1_000).toISOString(),
    jobId,
  );

  const currentWorkerId = `worker-${label}-current`;
  const reclaimed = queue.claim(currentWorkerId, { runtimeGeneration: "runtime-v1" });
  expect(reclaimed.ok).toBe(true);
  expect(reclaimed.job?.id).toBe(jobId);
  const currentAuthority: JobClaimAuthority = {
    workerId: currentWorkerId,
    claimGeneration: Number(reclaimed.job?.claimGeneration ?? 0),
  };
  expect(currentAuthority.claimGeneration).toBe(staleAuthority.claimGeneration + 1);
  return { jobId, staleAuthority, currentAuthority };
}

describe("JobQueue stale recovery", () => {
  test("claims pending jobs by priority order and exposes queue metadata", () => {
    const queue = new JobQueue(":memory:");

    const normal = queue.enqueue({
      taskId: "task-normal",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "normal",
    });
    const background = queue.enqueue({
      taskId: "task-background",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "background",
    });
    const interactive = queue.enqueue({
      taskId: "task-interactive",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "interactive",
    });

    expect(normal.ok).toBe(true);
    expect(background.ok).toBe(true);
    expect(interactive.ok).toBe(true);
    expect(interactive.queuePosition).toBe(1);
    expect(interactive.etaMs).toBe(0);

    const claim1 = queue.claim("worker-a");
    const claim2 = queue.claim("worker-b");
    const claim3 = queue.claim("worker-c");
    expect(claim1.ok).toBe(true);
    expect(claim2.ok).toBe(true);
    expect(claim3.ok).toBe(true);
    expect(claim1.job?.priority).toBe("interactive");
    expect(claim2.job?.priority).toBe("normal");
    expect(claim3.job?.priority).toBe("background");
    expect(typeof claim1.queueWaitMs).toBe("number");
  });

  test("keeps claims pre-execution until an exact-authority start is confirmed", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-execution-start";
    const jobId = enqueueAndClaim(queue, workerId);
    const claimed = queue.getJob(jobId)!;
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: claimed.claimGeneration,
    };

    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.startedAt).toBeNull();
    expect(queue.claim(workerId)).toMatchObject({
      ok: true,
      replayed: true,
      job: { id: jobId, startedAt: null },
    });

    expect(queue.heartbeat({ workerId, status: "busy", currentJobId: jobId }).ok).toBe(true);
    expect(queue.getJob(jobId)?.startedAt).toBeNull();
    expect(
      queue.startClaimedExecution(jobId, {
        workerId,
        claimGeneration: authority.claimGeneration + 1,
      }),
    ).toMatchObject({ ok: false });
    expect(queue.getJob(jobId)?.startedAt).toBeNull();

    const started = queue.startClaimedExecution(jobId, authority);
    expect(started).toMatchObject({ ok: true });
    expect(started.replayed).not.toBe(true);
    expect(started.startedAt).toBeTruthy();
    expect(queue.getJob(jobId)?.startedAt).toBe(started.startedAt);

    expect(queue.startClaimedExecution(jobId, authority)).toMatchObject({
      ok: true,
      replayed: true,
      startedAt: started.startedAt,
    });
    expect(queue.claim(workerId)).toMatchObject({
      ok: true,
      replayed: true,
      job: { id: jobId, startedAt: started.startedAt },
    });
    queue.close();
  });

  test("uses the first exact-authority worker log as an execution boundary", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-log-execution-start";
    const jobId = enqueueAndClaim(queue, workerId);
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
    };

    expect(queue.getJob(jobId)?.startedAt).toBeNull();
    expect(
      queue.addClaimedLog(jobId, "stale log", {
        workerId,
        claimGeneration: authority.claimGeneration + 1,
      }),
    ).toMatchObject({ ok: false });
    expect(queue.getJob(jobId)?.startedAt).toBeNull();

    expect(queue.addClaimedLog(jobId, "execution begins", authority)).toMatchObject({ ok: true });
    expect(queue.getJob(jobId)).toMatchObject({
      startedAt: expect.any(String),
      firstLogAt: expect.any(String),
    });
    queue.close();
  });

  test("does not recover a claimed job when log activity is recent", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-a");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-a");
    db.prepare("UPDATE jobs SET updatedAt = ?, lastActivityAt = ? WHERE id = ?").run(
      staleIso,
      staleIso,
      jobId,
    );

    queue.addLog(jobId, "[job_log] still running");
    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe("claimed");
  });

  test("ignores late log activity from an earlier claim generation", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-old-claim");
    const firstClaimGeneration = Number(queue.getJob(jobId)?.claimGeneration ?? 0);
    expect(
      queue.defer(jobId, {
        workerId: "worker-old-claim",
        targetWorkerId: null,
        deferMs: 1_000,
        reason: "worker_runtime_circuit_open",
      }).ok,
    ).toBe(true);

    const db = (queue as unknown as { db: any }).db as any;
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );
    const reclaimed = queue.claim("worker-current-claim");
    expect(reclaimed.job?.id).toBe(jobId);
    expect(reclaimed.job?.claimGeneration).toBe(firstClaimGeneration + 1);

    const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare(
      "UPDATE jobs SET claimedAt = ?, startedAt = ?, firstLogAt = NULL, updatedAt = ?, lastActivityAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, staleIso, jobId);
    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      staleIso,
      "worker-current-claim",
    );
    queue.addLog(jobId, "late log from stale worker", new Date().toISOString(), {
      claimGeneration: firstClaimGeneration,
    });

    const recovered = queue.recoverStaleClaimedJobs(120_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(["failed", "abandoned"]).toContain(queue.getJob(jobId)?.status);
    queue.close();
  });

  test("fences claimed logs and uses server receipt time for worker liveness", () => {
    const suppliedTimestamps = [
      { label: "future", value: "2099-01-01T00:00:00.000Z" },
      { label: "old", value: "2000-01-01T00:00:00.000Z" },
    ];

    for (const supplied of suppliedTimestamps) {
      const queue = new JobQueue(":memory:");
      const workerId = `worker-log-${supplied.label}`;
      const jobId = enqueueAndClaim(queue, workerId);
      const authority: JobClaimAuthority = {
        workerId,
        claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
      };

      expect(
        queue.addClaimedLog(
          jobId,
          "wrong owner log",
          {
            workerId: "worker-log-intruder",
            claimGeneration: authority.claimGeneration,
          },
          supplied.value,
        ),
      ).toMatchObject({ ok: false });
      expect(
        queue.addClaimedLog(
          jobId,
          "future generation log",
          {
            workerId,
            claimGeneration: authority.claimGeneration + 1,
          },
          supplied.value,
        ),
      ).toMatchObject({ ok: false });
      expect(
        queue.addClaimedLog(
          jobId,
          "stale generation log",
          {
            workerId,
            claimGeneration: authority.claimGeneration - 1,
          },
          supplied.value,
        ),
      ).toMatchObject({ ok: false });
      expect(queue.listJobLogs(jobId, 10)).toHaveLength(0);

      const db = (queue as unknown as { db: any }).db as any;
      const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
      db.prepare(
        "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
      ).run(staleIso, staleIso, staleIso, staleIso, jobId);
      db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, workerId);

      const receiptStartedMs = Date.now();
      const accepted = queue.addClaimedLog(
        jobId,
        `${supplied.label} timestamp accepted at receipt time`,
        authority,
        supplied.value,
      );
      const receiptFinishedMs = Date.now();
      expect(accepted.ok).toBe(true);
      expect(accepted.logId).toBeGreaterThan(0);

      const logs = queue.listJobLogs(jobId, 10);
      expect(logs).toHaveLength(1);
      const storedLogMs = Date.parse(logs[0]!.ts);
      expect(storedLogMs).toBeGreaterThanOrEqual(receiptStartedMs);
      expect(storedLogMs).toBeLessThanOrEqual(receiptFinishedMs);
      const jobAfterLog = queue.getJob(jobId)!;
      expect(Date.parse(jobAfterLog.updatedAt)).toBeGreaterThanOrEqual(receiptStartedMs);
      expect(Date.parse(jobAfterLog.updatedAt)).toBeLessThanOrEqual(receiptFinishedMs);
      expect(Date.parse(jobAfterLog.firstLogAt!)).toBeGreaterThanOrEqual(receiptStartedMs);
      expect(Date.parse(jobAfterLog.firstLogAt!)).toBeLessThanOrEqual(receiptFinishedMs);

      expect(queue.recoverStaleClaimedJobs(120_000)).toHaveLength(0);
      expect(queue.getJob(jobId)?.status).toBe("claimed");

      db.prepare("UPDATE job_logs SET ts = ? WHERE jobId = ?").run(staleIso, jobId);
      db.prepare(
        "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = ?, lastActivityAt = ? WHERE id = ?",
      ).run(staleIso, staleIso, staleIso, staleIso, staleIso, jobId);
      const recovered = queue.recoverStaleClaimedJobs(120_000);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.jobId).toBe(jobId);
      queue.close();
    }
  });

  test("accepts queued exact-authority logs after finalizing or terminal state only", () => {
    for (const status of ["finalizing", "completed"] as const) {
      const queue = new JobQueue(":memory:");
      const workerId = `worker-late-log-${status}`;
      const jobId = enqueueAndClaim(queue, workerId);
      const authority: JobClaimAuthority = {
        workerId,
        claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
      };
      const db = (queue as unknown as { db: any }).db as any;
      if (status === "completed") {
        expect(queue.complete(jobId, { summary: "terminal before queued log" }, authority).ok).toBe(
          true,
        );
      } else {
        db.prepare("UPDATE jobs SET status = 'finalizing' WHERE id = ?").run(jobId);
      }
      const updatedAtBeforeLog = queue.getJob(jobId)?.updatedAt;

      expect(
        queue.addClaimedLog(
          jobId,
          "wrong generation after terminal transition",
          { workerId, claimGeneration: authority.claimGeneration + 1 },
          new Date().toISOString(),
        ),
      ).toMatchObject({ ok: false });
      expect(
        queue.addClaimedLog(
          jobId,
          "queued log delivered after terminal transition",
          authority,
          "2099-01-01T00:00:00.000Z",
        ),
      ).toMatchObject({ ok: true });
      expect(queue.listJobLogs(jobId, 10)).toHaveLength(1);
      expect(queue.getJob(jobId)).toMatchObject({
        status,
        updatedAt: updatedAtBeforeLog,
      });
      queue.close();
    }

    const queue = new JobQueue(":memory:");
    const workerId = "worker-late-log-deferred";
    const jobId = enqueueAndClaim(queue, workerId);
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
    };
    expect(
      queue.defer(jobId, { workerId, deferMs: 60_000, reason: "pending_log_rejection" }, authority)
        .ok,
    ).toBe(true);
    expect(
      queue.addClaimedLog(
        jobId,
        "queued log after claimed ownership was released",
        authority,
        new Date().toISOString(),
      ),
    ).toMatchObject({ ok: false });
    expect(queue.listJobLogs(jobId, 10)).toHaveLength(0);
    queue.close();
  });

  test("rejects stale-generation diagnostic replacement after a job is reclaimed", () => {
    const queue = new JobQueue(":memory:");
    const { jobId, staleAuthority, currentAuthority } = reclaimForAuthorityTest(
      queue,
      "diagnostics",
    );

    const currentSaved = queue.saveJobDiagnostics(
      jobId,
      {
        diagnostics: {
          attempts: [
            {
              attempt: 2,
              workerId: currentAuthority.workerId,
              backend: "codex",
              model: "current-authority-model",
            },
          ],
        },
      },
      currentAuthority,
    );
    expect(currentSaved.ok).toBe(true);

    const staleSaved = queue.saveJobDiagnostics(
      jobId,
      {
        diagnostics: {
          attempts: [
            {
              attempt: 1,
              workerId: currentAuthority.workerId,
              backend: "codex",
              model: "stale-generation-model",
            },
          ],
        },
      },
      {
        workerId: currentAuthority.workerId,
        claimGeneration: staleAuthority.claimGeneration,
      },
    );
    expect(staleSaved).toMatchObject({ ok: false });
    expect(staleSaved.message).toContain("claim ownership changed");

    const attempts = queue.getJobDiagnostics(jobId).attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 2,
      workerId: currentAuthority.workerId,
      model: "current-authority-model",
    });
    queue.close();
  });

  test("deduplicates and bounds repeated circuit deferral logs", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-dedupe");
    const claimGeneration = Number(queue.getJob(jobId)?.claimGeneration ?? 0);
    const startMs = Date.parse("2026-08-18T20:00:00.000Z");

    expect(
      queue.addLog(jobId, "same circuit deferral", new Date(startMs).toISOString(), {
        claimGeneration,
        category: "deferral",
        dedupeKey: "worker_runtime_circuit_open:fingerprint",
        dedupeWindowMs: 5 * 60_000,
        retain: 8,
      }),
    ).not.toBeNull();
    expect(
      queue.addLog(jobId, "same circuit deferral", new Date(startMs + 1_000).toISOString(), {
        claimGeneration,
        category: "deferral",
        dedupeKey: "worker_runtime_circuit_open:fingerprint",
        dedupeWindowMs: 5 * 60_000,
        retain: 8,
      }),
    ).toBeNull();

    for (let index = 1; index <= 12; index += 1) {
      queue.addLog(
        jobId,
        "same circuit deferral",
        new Date(startMs + index * 6 * 60_000).toISOString(),
        {
          claimGeneration,
          category: "deferral",
          dedupeKey: "worker_runtime_circuit_open:fingerprint",
          dedupeWindowMs: 5 * 60_000,
          retain: 8,
        },
      );
    }
    expect(queue.listJobLogs(jobId, 100)).toHaveLength(8);
    queue.close();
  });

  test("shortens every durable runtime-circuit deferral beyond the reported ID limit", () => {
    const queue = new JobQueue(":memory:");
    const db = (queue as unknown as { db: any }).db as any;
    const nowMs = Date.parse("2026-08-19T18:00:00.000Z");
    const now = new Date(nowMs).toISOString();
    const farFuture = new Date(nowMs + 60 * 60_000).toISOString();
    const expectedAvailableAt = new Date(nowMs + 30_000).toISOString();
    const eligibleCount = 605;
    const insertJob = db.prepare(
      `INSERT INTO jobs (
         id, taskId, sessionId, kind, params, status, availableAt,
         deferReason, deferredAt, enqueuedAt, createdAt, updatedAt
       ) VALUES (?, ?, 'bulk-runtime-restart', 'task.execute', '{}', 'pending', ?, ?, ?, ?, ?, ?)`,
    );
    const insertLog = db.prepare(
      `INSERT INTO job_logs (jobId, ts, message)
       VALUES (?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let index = 0; index < eligibleCount; index += 1) {
        const id = `bulk-runtime-job-${String(index).padStart(4, "0")}`;
        const tagged = index % 2 === 0;
        insertJob.run(
          id,
          `bulk-runtime-task-${index}`,
          farFuture,
          tagged ? "worker_runtime_circuit_open" : null,
          now,
          now,
          now,
          now,
        );
        if (!tagged) {
          insertLog.run(
            id,
            now,
            JSON.stringify({ code: "worker_runtime_circuit_open", legacy: true }),
          );
        }
      }
      insertJob.run(
        "bulk-runtime-job-unrelated",
        "bulk-runtime-task-unrelated",
        farFuture,
        null,
        now,
        now,
        now,
        now,
      );
    });
    seed();

    const shortened = queue.shortenWorkerRuntimeCircuitDeferrals({
      nowMs,
      maxDelayMs: 30_000,
    });
    expect(shortened).toMatchObject({
      shortened: eligibleCount,
      unreportedJobIds: eligibleCount - 500,
      availableAt: expectedAvailableAt,
    });
    expect(shortened.jobIds).toHaveLength(500);
    expect(new Set(shortened.jobIds).size).toBe(500);
    expect(shortened.jobIds.every((id) => id.startsWith("bulk-runtime-job-"))).toBe(true);

    const eligible = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM jobs
         WHERE id LIKE 'bulk-runtime-job-%'
           AND id != 'bulk-runtime-job-unrelated'
           AND availableAt = ?`,
      )
      .get(expectedAvailableAt) as { count: number };
    expect(eligible.count).toBe(eligibleCount);
    expect(queue.getJob("bulk-runtime-job-unrelated")?.availableAt).toBe(farFuture);

    expect(queue.shortenWorkerRuntimeCircuitDeferrals({ nowMs, maxDelayMs: 30_000 })).toEqual({
      shortened: 0,
      jobIds: [],
      unreportedJobIds: 0,
      availableAt: expectedAvailableAt,
    });
    queue.close();
  });

  test("replays the same claim generation without dequeuing a second job", () => {
    const queue = new JobQueue(":memory:");

    const first = queue.enqueue({
      taskId: "task-first",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "interactive",
    });
    const second = queue.enqueue({
      taskId: "task-second",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const firstClaim = queue.claim("worker-serial", { runtimeGeneration: "runtime-v1" });
    expect(firstClaim.ok).toBe(true);
    expect(firstClaim.job?.id).toBe(first.jobId);
    const firstGeneration = firstClaim.job?.claimGeneration;
    const firstClaimedAt = firstClaim.job?.claimedAt;
    const staleActivityAt = "2000-01-01T00:00:00.000Z";
    const db = (queue as unknown as { db: any }).db as any;
    db.prepare("UPDATE jobs SET lastActivityAt = ? WHERE id = ?").run(staleActivityAt, first.jobId);

    const replayedClaim = queue.claim("worker-serial", { runtimeGeneration: "runtime-v1" });
    expect(replayedClaim).toMatchObject({
      ok: true,
      replayed: true,
      queueWaitMs: 0,
      job: {
        id: first.jobId,
        workerId: "worker-serial",
        runtimeGeneration: "runtime-v1",
        claimGeneration: firstGeneration,
        claimedAt: firstClaimedAt,
      },
    });
    expect(replayedClaim.job?.lastActivityAt).not.toBe(staleActivityAt);
    expect(queue.getJob(first.jobId!)?.lastActivityAt).toBe(replayedClaim.job?.lastActivityAt);

    const queuedJob = queue.getJob(second.jobId!);
    expect(queuedJob?.status).toBe("pending");
    expect(queue.listWorkers()[0]?.currentJobId).toBe(first.jobId);
    expect(queue.countByStatus()).toMatchObject({ claimed: 1, pending: 1 });
    queue.close();
  });

  test("rejects blank worker identities without claiming queued work", () => {
    const queue = new JobQueue(":memory:");
    const enqueued = queue.enqueue({
      taskId: "task-blank-worker",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueued.ok).toBe(true);

    expect(queue.claim("   ")).toMatchObject({
      ok: false,
      message: "workerId is required",
    });
    expect(queue.claim("w".repeat(129))).toMatchObject({
      ok: false,
      message: "workerId is required",
    });
    expect(queue.getJob(enqueued.jobId!)?.status).toBe("pending");
    expect(queue.listWorkers()).toHaveLength(0);
    queue.close();
  });

  test("rejects replay from an older runtime generation without changing claim authority", () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-runtime-replay",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    const second = queue.enqueue({
      taskId: "task-runtime-replay-next",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const active = queue.claim("worker-runtime-replay", {
      runtimeGeneration: "runtime-v2",
    });
    expect(active.ok).toBe(true);
    const activeGeneration = active.job?.claimGeneration;

    const staleReplay = queue.claim("worker-runtime-replay", {
      runtimeGeneration: "runtime-v1",
    });
    expect(staleReplay).toMatchObject({
      ok: false,
      code: "worker_runtime_generation_mismatch",
    });
    expect(staleReplay.message).toContain("runtime-v2");
    expect(queue.getJob(active.job!.id)).toMatchObject({
      status: "claimed",
      workerId: "worker-runtime-replay",
      runtimeGeneration: "runtime-v2",
      claimGeneration: activeGeneration,
    });
    const unclaimedJobId = active.job!.id === first.jobId ? second.jobId! : first.jobId!;
    expect(queue.getJob(unclaimedJobId)?.status).toBe("pending");
    queue.close();
  });

  for (const mutation of jobMutationCases) {
    test(`${mutation.name} fences stale claim generations and replays the authoritative result`, () => {
      const queue = new JobQueue(":memory:");
      const { jobId, staleAuthority, currentAuthority } = reclaimForAuthorityTest(
        queue,
        mutation.name,
      );
      mutation.prepare?.(queue, jobId, currentAuthority);
      const statusBeforeMutation = mutation.prepare ? "pending" : "claimed";
      expect(queue.getJob(jobId)?.status).toBe(statusBeforeMutation);

      const staleOwnerResult = mutation.mutate(queue, jobId, staleAuthority);
      expect(staleOwnerResult.ok).toBe(false);
      expect(queue.getJob(jobId)?.status).toBe(statusBeforeMutation);

      const staleGenerationResult = mutation.mutate(queue, jobId, {
        workerId: currentAuthority.workerId,
        claimGeneration: staleAuthority.claimGeneration,
      });
      expect(staleGenerationResult.ok).toBe(false);
      expect(queue.getJob(jobId)?.status).toBe(statusBeforeMutation);

      const wrongOwnerResult = mutation.mutate(queue, jobId, {
        workerId: "worker-claim-intruder",
        claimGeneration: currentAuthority.claimGeneration,
      });
      expect(wrongOwnerResult.ok).toBe(false);
      expect(queue.getJob(jobId)?.status).toBe(statusBeforeMutation);

      const authoritativeResult = mutation.mutate(queue, jobId, currentAuthority);
      expect(authoritativeResult.ok).toBe(true);
      expect(authoritativeResult.replayed).not.toBe(true);
      expect(queue.getJob(jobId)).toMatchObject({
        status: mutation.finalStatus,
        claimGeneration: currentAuthority.claimGeneration,
      });

      const replayedResult = mutation.mutate(queue, jobId, currentAuthority);
      expect(replayedResult).toMatchObject({ ok: true, replayed: true });
      expect(queue.getJob(jobId)).toMatchObject({
        status: mutation.finalStatus,
        claimGeneration: currentAuthority.claimGeneration,
      });
      queue.close();
    });
  }

  test("rolls back claimed deferral when its diagnostic log cannot persist", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-atomic-deferral";
    const jobId = enqueueAndClaim(queue, workerId);
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
    };
    const claimedBefore = queue.getJob(jobId)!;
    const db = (queue as unknown as { db: any }).db as any;
    db.exec(`
      CREATE TRIGGER reject_test_deferral_log
      BEFORE INSERT ON job_logs
      BEGIN
        SELECT RAISE(ABORT, 'forced deferral log failure');
      END;
    `);
    const body = {
      workerId,
      targetWorkerId: null,
      deferMs: 60_000,
      reason: "worker_runtime_circuit_open",
      detail: JSON.stringify({
        code: "worker_runtime_circuit_open",
        fingerprint: "atomic-deferral-test",
      }),
    };

    const rejected = queue.defer(jobId, body, authority);
    expect(rejected).toMatchObject({
      ok: false,
      code: JOB_DEFERRAL_PERSISTENCE_FAILED_CODE,
    });
    expect(rejected.message).toContain("forced deferral log failure");
    expect(queue.getJob(jobId)).toMatchObject({
      status: "claimed",
      workerId,
      targetWorkerId: claimedBefore.targetWorkerId,
      claimGeneration: authority.claimGeneration,
      claimedAt: claimedBefore.claimedAt,
      startedAt: claimedBefore.startedAt,
      firstLogAt: claimedBefore.firstLogAt,
      availableAt: claimedBefore.availableAt,
      deferReason: claimedBefore.deferReason,
      deferredAt: claimedBefore.deferredAt,
      updatedAt: claimedBefore.updatedAt,
    });
    expect(queue.listWorkers().find((worker) => worker.workerId === workerId)).toMatchObject({
      status: "busy",
      currentJobId: jobId,
      activeJobCount: 1,
    });
    expect(queue.listJobLogs(jobId, 10)).toHaveLength(0);

    db.exec("DROP TRIGGER reject_test_deferral_log;");
    const retried = queue.defer(jobId, body, authority);
    expect(retried.ok).toBe(true);
    expect(retried.replayed).not.toBe(true);
    expect(queue.getJob(jobId)).toMatchObject({
      status: "pending",
      workerId: null,
      targetWorkerId: null,
      deferredByWorkerId: workerId,
      claimGeneration: authority.claimGeneration,
      deferReason: "worker_runtime_circuit_open",
    });
    expect(queue.listWorkers().find((worker) => worker.workerId === workerId)).toMatchObject({
      status: "idle",
      currentJobId: null,
      activeJobCount: 0,
    });
    expect(queue.listJobLogs(jobId, 10)).toHaveLength(1);

    const replayed = queue.defer(jobId, body, authority);
    expect(replayed).toMatchObject({
      ok: true,
      replayed: true,
      availableAt: retried.availableAt,
    });
    expect(queue.listJobLogs(jobId, 10)).toHaveLength(1);
    queue.close();
  });

  test("fences same-generation defer replays to the persisted original worker", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-defer-authority";
    const jobId = enqueueAndClaim(queue, workerId);
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
    };
    const body = {
      workerId,
      targetWorkerId: null,
      deferMs: 60_000,
      reason: "claim_authority_replay",
    };

    const deferred = queue.defer(jobId, body, authority);
    expect(deferred).toMatchObject({ ok: true });
    expect(queue.getJob(jobId)).toMatchObject({
      status: "pending",
      workerId: null,
      targetWorkerId: null,
      deferredByWorkerId: workerId,
      claimGeneration: authority.claimGeneration,
    });

    const intruderAuthority: JobClaimAuthority = {
      workerId: "worker-defer-intruder",
      claimGeneration: authority.claimGeneration,
    };
    const rejected = queue.defer(
      jobId,
      { ...body, workerId: intruderAuthority.workerId },
      intruderAuthority,
    );
    expect(rejected).toMatchObject({
      ok: false,
      code: JOB_DEFERRAL_CONFLICT_CODE,
    });
    expect(queue.getJob(jobId)).toMatchObject({
      status: "pending",
      workerId: null,
      deferredByWorkerId: workerId,
    });

    expect(queue.defer(jobId, body, authority)).toMatchObject({
      ok: true,
      replayed: true,
      availableAt: deferred.availableAt,
    });
    queue.close();
  });

  test("fences same-generation failDeferred replays to the persisted original worker", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-fail-deferred-authority";
    const jobId = enqueueAndClaim(queue, workerId);
    const authority: JobClaimAuthority = {
      workerId,
      claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
    };
    expect(
      queue.defer(
        jobId,
        {
          workerId,
          targetWorkerId: null,
          deferMs: 60_000,
          reason: "pre_execution_maintenance",
        },
        authority,
      ),
    ).toMatchObject({ ok: true });

    const failed = queue.failDeferred(
      jobId,
      { workerId, message: "pre-execution maintenance failed" },
      authority,
    );
    expect(failed).toMatchObject({ ok: true });
    expect(queue.getJob(jobId)).toMatchObject({
      status: "failed",
      workerId: null,
      targetWorkerId: null,
      deferredByWorkerId: workerId,
      claimGeneration: authority.claimGeneration,
    });

    const intruderAuthority: JobClaimAuthority = {
      workerId: "worker-fail-deferred-intruder",
      claimGeneration: authority.claimGeneration,
    };
    expect(
      queue.failDeferred(
        jobId,
        { workerId: intruderAuthority.workerId, message: "forged replay" },
        intruderAuthority,
      ),
    ).toMatchObject({
      ok: false,
      code: JOB_DEFERRAL_CONFLICT_CODE,
    });
    expect(queue.failDeferred(jobId, { workerId, message: "retry" }, authority)).toMatchObject({
      ok: true,
      replayed: true,
      failedAt: failed.failedAt,
    });
    queue.close();
  });

  test("migrates deferred authority with a safe null default and clears it on the next claim", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "pushpals-deferred-authority-"));
    const dbPath = join(fixtureDir, "pushpals.db");
    let legacyQueue: JobQueue | null = null;
    let migratedQueue: JobQueue | null = null;
    try {
      legacyQueue = new JobQueue(dbPath);
      const legacyDb = (legacyQueue as unknown as { db: any }).db as any;
      const legacyActivityJob = legacyQueue.enqueue({
        taskId: "task-legacy-future-activity",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      const legacyActivityJobId = String(legacyActivityJob.jobId ?? "");
      const legacyActivityClaim = legacyQueue.claim("worker-legacy-future-activity");
      expect(legacyActivityClaim.job?.id).toBe(legacyActivityJobId);
      const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
      const futureIso = "2099-01-01T00:00:00.000Z";
      legacyDb
        .prepare(
          `UPDATE jobs
         SET createdAt = ?, enqueuedAt = ?, claimedAt = ?,
             updatedAt = ?, startedAt = ?, firstLogAt = ?, lastActivityAt = ?
         WHERE id = ?`,
        )
        .run(
          staleIso,
          staleIso,
          staleIso,
          futureIso,
          futureIso,
          futureIso,
          futureIso,
          legacyActivityJobId,
        );
      legacyDb
        .prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?")
        .run(staleIso, "worker-legacy-future-activity");
      legacyDb
        .prepare(
          `INSERT INTO job_logs (jobId, ts, message, claimGeneration)
         VALUES (?, ?, ?, ?)`,
        )
        .run(
          legacyActivityJobId,
          futureIso,
          "legacy future activity",
          legacyActivityClaim.job?.claimGeneration,
        );
      legacyDb.exec("DROP INDEX IF EXISTS idx_jobs_stale_activity;");
      legacyDb.exec("ALTER TABLE jobs DROP COLUMN lastActivityAt;");
      legacyDb.exec("ALTER TABLE jobs DROP COLUMN deferredByWorkerId;");
      legacyQueue.close();
      legacyQueue = null;

      migratedQueue = new JobQueue(dbPath);
      const db = (migratedQueue as unknown as { db: any }).db as any;
      const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "deferredByWorkerId")).toBe(true);
      expect(columns.some((column) => column.name === "lastActivityAt")).toBe(true);
      expect(migratedQueue.getJob(legacyActivityJobId)?.lastActivityAt).toBe(staleIso);
      expect(migratedQueue.recoverStaleClaimedJobs(120_000).map((job) => job.jobId)).toEqual([
        legacyActivityJobId,
      ]);

      const enqueued = migratedQueue.enqueue({
        taskId: "task-deferred-authority-migration",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      });
      expect(enqueued.ok).toBe(true);
      const jobId = String(enqueued.jobId ?? "");
      expect(migratedQueue.getJob(jobId)).toMatchObject({
        status: "pending",
        workerId: null,
        deferredByWorkerId: null,
      });

      const ownerClaim = migratedQueue.claim("worker-migrated-owner");
      expect(ownerClaim).toMatchObject({ ok: true, job: { id: jobId } });
      const authority: JobClaimAuthority = {
        workerId: "worker-migrated-owner",
        claimGeneration: Number(ownerClaim.job?.claimGeneration ?? 0),
      };
      expect(
        migratedQueue.defer(
          jobId,
          {
            workerId: authority.workerId,
            targetWorkerId: null,
            deferMs: 1_000,
          },
          authority,
        ),
      ).toMatchObject({ ok: true });
      expect(migratedQueue.getJob(jobId)).toMatchObject({
        status: "pending",
        workerId: null,
        deferredByWorkerId: authority.workerId,
      });

      db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
        new Date(Date.now() - 1_000).toISOString(),
        jobId,
      );
      const replacementClaim = migratedQueue.claim("worker-migrated-replacement");
      expect(replacementClaim).toMatchObject({
        ok: true,
        job: {
          id: jobId,
          status: "claimed",
          workerId: "worker-migrated-replacement",
          deferredByWorkerId: null,
        },
      });
      expect(migratedQueue.getJob(jobId)?.deferredByWorkerId).toBeNull();
    } finally {
      migratedQueue?.close();
      legacyQueue?.close();
      Bun.gc(true);
      let cleanupError: unknown = null;
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        try {
          rmSync(fixtureDir, { recursive: true, force: true });
          cleanupError = null;
          break;
        } catch (error) {
          cleanupError = error;
          await Bun.sleep(25 * attempt);
        }
      }
      if (cleanupError) throw cleanupError;
    }
  });

  test("replays the exact active half-open canary while fencing every other pair", () => {
    const queue = new JobQueue(":memory:");
    const db = (queue as unknown as { db: any }).db as any;
    const runtimeGeneration = "runtime-canary-replay";
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    db.prepare(
      `INSERT INTO worker_runtime_circuits (
         runtimeGeneration, state, retryAt, createdAt, updatedAt
       ) VALUES (?, 'open', ?, ?, ?)`,
    ).run(runtimeGeneration, new Date(nowMs - 1).toISOString(), now, now);

    const first = queue.enqueue({
      taskId: "task-canary-replay-first",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(first.ok).toBe(true);
    const firstClaim = queue.claim("worker-canary-replay", { runtimeGeneration });
    expect(firstClaim).toMatchObject({ ok: true, job: { id: first.jobId } });
    const firstDecision = queue.acquireWorkerRuntimeCanary(
      String(first.jobId),
      "worker-canary-replay",
      { runtimeGeneration, nowMs },
    );
    expect(firstDecision).toMatchObject({ allowed: true, canary: true });

    const replay = queue.acquireWorkerRuntimeCanary(String(first.jobId), "worker-canary-replay", {
      runtimeGeneration,
      nowMs: nowMs + 1,
    });
    expect(replay).toMatchObject({
      allowed: true,
      canary: true,
      summary: {
        phase: "half_open",
        canaryJobId: first.jobId,
        canaryWorkerId: "worker-canary-replay",
      },
    });

    const second = queue.enqueue({
      taskId: "task-canary-replay-second",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(second.ok).toBe(true);
    const secondClaim = queue.claim("worker-canary-other", { runtimeGeneration });
    expect(secondClaim).toMatchObject({ ok: true, job: { id: second.jobId } });
    expect(
      queue.acquireWorkerRuntimeCanary(String(first.jobId), "worker-canary-other", {
        runtimeGeneration,
        nowMs: nowMs + 2,
      }),
    ).toMatchObject({ allowed: false, canary: false, reason: "canary_in_flight" });
    expect(
      queue.acquireWorkerRuntimeCanary(String(second.jobId), "worker-canary-replay", {
        runtimeGeneration,
        nowMs: nowMs + 2,
      }),
    ).toMatchObject({ allowed: false, canary: false, reason: "canary_in_flight" });
    queue.close();
  });

  test("deferred claimed jobs stay unavailable until their retry time, including to the target worker", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-merge");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;

    const deferred = queue.defer(jobId, {
      workerId: "worker-merge",
      deferMs: 120_000,
    });
    expect(deferred.ok).toBe(true);

    const pending = queue.getJob(jobId);
    expect(pending?.status).toBe("pending");
    expect(pending?.workerId).toBeNull();
    expect(pending?.targetWorkerId).toBe("worker-merge");
    expect(typeof pending?.availableAt).toBe("string");

    const wrongWorkerClaim = queue.claim("worker-other");
    expect(wrongWorkerClaim.ok).toBe(false);

    const rightWorkerClaim = queue.claim("worker-merge");
    expect(rightWorkerClaim.ok).toBe(false);

    const db = (queue as unknown as { db: any }).db as any;
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );
    const retryAtEligibleTime = queue.claim("worker-merge");
    expect(retryAtEligibleTime.ok).toBe(true);
    expect(retryAtEligibleTime.job?.id).toBe(jobId);
  });

  test("deferred claimed jobs can clear the target worker for replacement retry", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred-clear-target",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-docker");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;

    const deferred = queue.defer(jobId, {
      workerId: "worker-docker",
      deferMs: 1_000,
      targetWorkerId: null,
    });
    expect(deferred.ok).toBe(true);

    const pending = queue.getJob(jobId);
    expect(pending?.status).toBe("pending");
    expect(pending?.workerId).toBeNull();
    expect(pending?.targetWorkerId).toBeNull();

    const db = (queue as unknown as { db: any }).db as any;
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );

    const replacementClaim = queue.claim("worker-direct");
    expect(replacementClaim.ok).toBe(true);
    expect(replacementClaim.job?.id).toBe(jobId);
  });

  test("deferred jobs become claimable by another worker once the pinned worker is stale", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred-stale",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-stale-target");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;
    expect(
      queue.defer(jobId, {
        workerId: "worker-stale-target",
        deferMs: 120_000,
      }).ok,
    ).toBe(true);

    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      staleIso,
      "worker-stale-target",
    );

    expect(queue.claim("worker-replacement").ok).toBe(false);
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );
    const claimByReplacement = queue.claim("worker-replacement");
    expect(claimByReplacement.ok).toBe(true);
    expect(claimByReplacement.job?.id).toBe(jobId);
  });

  test("autoscale backlog counts pending task.execute jobs once the pinned worker is stale", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-autoscale-stale-target",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-stale-autoscale");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;
    expect(
      queue.defer(jobId, {
        workerId: "worker-stale-autoscale",
        deferMs: 120_000,
      }).ok,
    ).toBe(true);

    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      staleIso,
      "worker-stale-autoscale",
    );

    expect(queue.countByKindAndStatus("task.execute", "pending")).toBe(1);
    expect(queue.countAutoscalablePendingByKind("task.execute")).toBe(0);
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );
    expect(queue.countAutoscalablePendingByKind("task.execute")).toBe(1);
  });

  test("deferring maintenance retargets the job to the worker performing the prep", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred-retarget",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      targetWorkerId: "worker-original",
    });
    expect(enqueue.ok).toBe(true);

    const db = (queue as unknown as { db: any }).db as any;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
       VALUES (?, 'idle', NULL, NULL, '{}', '{}', ?, ?, ?)`,
    ).run("worker-original", now, now, now);
    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      "worker-original",
    );

    const claimByReplacement = queue.claim("worker-replacement");
    expect(claimByReplacement.ok).toBe(true);
    const jobId = claimByReplacement.job!.id;

    const deferred = queue.defer(jobId, {
      workerId: "worker-replacement",
      deferMs: 120_000,
    });
    expect(deferred.ok).toBe(true);

    const pending = queue.getJob(jobId);
    expect(pending?.status).toBe("pending");
    expect(pending?.targetWorkerId).toBe("worker-replacement");

    const originalWorkerClaim = queue.claim("worker-original");
    expect(originalWorkerClaim.ok).toBe(false);

    const replacementClaim = queue.claim("worker-replacement");
    expect(replacementClaim.ok).toBe(false);
    db.prepare("UPDATE jobs SET availableAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      jobId,
    );
    const eligibleReplacementClaim = queue.claim("worker-replacement");
    expect(eligibleReplacementClaim.ok).toBe(true);
    expect(eligibleReplacementClaim.job?.id).toBe(jobId);
  });

  test("generic fail does not allow failing pending deferred jobs", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred-fail-guard",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-owner");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;
    expect(queue.defer(jobId, { workerId: "worker-owner", deferMs: 60_000 }).ok).toBe(true);

    const fail = queue.fail(jobId, {
      message: "should not work",
      detail: "pending jobs must not be failed generically",
    });
    expect(fail.ok).toBe(false);
    expect(queue.getJob(jobId)?.status).toBe("pending");
  });

  test("failDeferred only allows the owning worker to fail a deferred job", () => {
    const queue = new JobQueue(":memory:");
    const enqueue = queue.enqueue({
      taskId: "task-deferred-fail",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    expect(enqueue.ok).toBe(true);

    const claim = queue.claim("worker-owner");
    expect(claim.ok).toBe(true);
    const jobId = claim.job!.id;
    expect(queue.defer(jobId, { workerId: "worker-owner", deferMs: 60_000 }).ok).toBe(true);

    const wrongWorkerFail = queue.failDeferred(jobId, {
      workerId: "worker-other",
      message: "nope",
    });
    expect(wrongWorkerFail.ok).toBe(false);
    expect(queue.getJob(jobId)?.status).toBe("pending");

    const rightWorkerFail = queue.failDeferred(jobId, {
      workerId: "worker-owner",
      message: "prep failed",
    });
    expect(rightWorkerFail.ok).toBe(true);
    expect(queue.getJob(jobId)?.status).toBe("failed");
  });

  test("requeues stale pre-execution task claims without feeding the runtime circuit", () => {
    const queue = new JobQueue(":memory:");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
    const originalJobIds: string[] = [];

    for (const suffix of ["a", "b"]) {
      const workerId = `worker-pre-execution-stale-${suffix}`;
      const jobId = enqueueKindAndClaim(queue, workerId, "task.execute", {
        requestId: `request-pre-execution-stale-${suffix}`,
        retrySafety: "manual_retry_required",
        reviewAgent: { resolutionType: "merge_conflict" },
      });
      originalJobIds.push(jobId);
      expect(queue.getJob(jobId)?.startedAt).toBeNull();
      db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, workerId);
      db.prepare(
        `UPDATE jobs
         SET updatedAt = ?, claimedAt = ?, startedAt = NULL,
             firstLogAt = NULL, lastActivityAt = ?
         WHERE id = ?`,
      ).run(staleIso, staleIso, staleIso, jobId);
    }

    const recovered = queue.recoverStaleClaimedJobs(120_000);
    expect(recovered).toHaveLength(2);
    expect(recovered.map((item) => item.jobId).sort()).toEqual([...originalJobIds].sort());
    for (const item of recovered) {
      expect(item).toMatchObject({
        action: "requeued",
        finalStatus: "abandoned",
        retrySafety: "retry_safe",
      });
      expect(item.detail).toContain("executionStarted=no");
      expect(item.detail).toContain(
        "job never crossed the authoritative execution boundary (startedAt is null)",
      );
      expect(queue.getJob(item.jobId)?.status).toBe("abandoned");

      const replacement = queue.getPendingJobs().find((row) => row.resumeOfJobId === item.jobId);
      expect(replacement).toMatchObject({
        status: "pending",
        kind: "task.execute",
        attempt: 2,
      });
      const replacementParams = JSON.parse(String(replacement?.params ?? "{}")) as Record<
        string,
        unknown
      >;
      expect(replacementParams.retrySafety).toBe("manual_retry_required");
      expect(replacementParams.resume).toMatchObject({
        previousJobId: item.jobId,
        retrySafety: "retry_safe",
        reason: "stale_worker_claim",
      });
    }

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM job_terminal_diagnostics
           WHERE jobId IN (?, ?)`,
        )
        .get(...originalJobIds),
    ).toEqual({ count: 0 });
    expect(
      queue.workerRuntimeFailureCircuitSummary({
        threshold: 2,
        runtimeGeneration: "default",
      }),
    ).toMatchObject({ blocked: false, qualifyingFailureCount: 0 });
    queue.close();
  });

  test("heartbeat mismatch requeues an unstarted manual task but fails one that started", () => {
    for (const executionStarted of [false, true]) {
      const queue = new JobQueue(":memory:");
      const workerId = `worker-heartbeat-manual-${executionStarted ? "started" : "unstarted"}`;
      const jobId = enqueueKindAndClaim(queue, workerId, "task.execute", {
        retrySafety: "manual_retry_required",
      });
      const job = queue.getJob(jobId)!;
      const authority: JobClaimAuthority = {
        workerId,
        claimGeneration: job.claimGeneration,
      };
      if (executionStarted) {
        expect(queue.startClaimedExecution(jobId, authority).ok).toBe(true);
      }

      const db = (queue as unknown as { db: any }).db as any;
      const staleIso = new Date(Date.now() - 60_000).toISOString();
      db.prepare(
        `UPDATE jobs
         SET updatedAt = ?, claimedAt = ?, startedAt = ?, lastActivityAt = ?
         WHERE id = ?`,
      ).run(staleIso, staleIso, executionStarted ? staleIso : null, staleIso, jobId);

      expect(queue.heartbeat({ workerId, status: "idle", currentJobId: null }).ok).toBe(true);
      expect(queue.getJob(jobId)?.status).toBe(executionStarted ? "failed" : "abandoned");
      if (executionStarted) {
        expect(queue.getPendingJobs().some((row) => row.resumeOfJobId === jobId)).toBe(false);
        expect(
          db
            .prepare(`SELECT failureClass FROM job_terminal_diagnostics WHERE jobId = ?`)
            .get(jobId),
        ).toEqual({ failureClass: "worker_runtime_failure" });
      } else {
        expect(queue.getPendingJobs().some((row) => row.resumeOfJobId === jobId)).toBe(true);
        expect(
          db.prepare(`SELECT jobId FROM job_terminal_diagnostics WHERE jobId = ?`).get(jobId),
        ).toBeNull();
      }
      queue.close();
    }
  });

  test("recovers a claimed job when both heartbeat and log activity are stale", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-b");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-b");
    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, staleIso, jobId);

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(queue.getJob(jobId)?.status).toBe("failed");
  });

  test("ignores legacy future-dated activity when recovering a stale claim", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-future-activity");
    const claimed = queue.getJob(jobId);
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const futureIso = "2099-01-01T00:00:00.000Z";

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      staleIso,
      "worker-future-activity",
    );
    db.prepare(
      `UPDATE jobs
       SET createdAt = ?, enqueuedAt = ?, claimedAt = ?,
           updatedAt = ?, startedAt = ?, firstLogAt = ?, lastActivityAt = ?
       WHERE id = ?`,
    ).run(staleIso, staleIso, staleIso, futureIso, futureIso, futureIso, staleIso, jobId);
    db.prepare(
      `INSERT INTO job_logs (jobId, ts, message, claimGeneration)
       VALUES (?, ?, ?, ?)`,
    ).run(
      jobId,
      futureIso,
      "legacy client clock must not control liveness",
      claimed?.claimGeneration,
    );

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(recovered[0]?.detail).toContain("lastLogTs=none");
    expect(queue.getJob(jobId)?.status).toBe("failed");
  });

  test("ignores malformed and offset-form future legacy activity", () => {
    const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    setSystemTime(nowMs);
    try {
      for (const [label, corruptActivity] of [
        ["malformed", "2026-08-19T10:99:00.000Z"],
        ["offset-future", "2026-08-19T10:30:00-04:00"],
      ] as const) {
        const queue = new JobQueue(":memory:");
        const workerId = `worker-corrupt-activity-${label}`;
        const jobId = enqueueAndClaim(queue, workerId);
        const claimed = queue.getJob(jobId);
        const db = (queue as unknown as { db: any }).db as any;
        const staleIso = "2026-08-19T08:00:00.000Z";

        db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
          staleIso,
          workerId,
        );
        db.prepare(
          `UPDATE jobs
           SET createdAt = ?, enqueuedAt = ?, claimedAt = ?,
               updatedAt = ?, startedAt = ?, firstLogAt = ?, lastActivityAt = ?
           WHERE id = ?`,
        ).run(
          staleIso,
          staleIso,
          staleIso,
          corruptActivity,
          corruptActivity,
          corruptActivity,
          staleIso,
          jobId,
        );
        db.prepare(
          `INSERT INTO job_logs (jobId, ts, message, claimGeneration)
           VALUES (?, ?, ?, ?)`,
        ).run(jobId, corruptActivity, label, claimed?.claimGeneration);

        expect(queue.recoverStaleClaimedJobs(120_000).map((item) => item.jobId)).toEqual([jobId]);
        expect(queue.getJob(jobId)?.status).toBe("failed");
        queue.close();
      }
    } finally {
      setSystemTime();
    }
  });

  test("treats malformed or future aligned heartbeats as stale", () => {
    for (const [label, heartbeat] of [
      ["malformed", "not-a-date"],
      ["future", "2099-01-01T00:00:00.000Z"],
    ] as const) {
      const queue = new JobQueue(":memory:");
      const workerId = `worker-invalid-heartbeat-${label}`;
      const jobId = enqueueAndClaim(queue, workerId);
      const db = (queue as unknown as { db: any }).db as any;
      const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();

      db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
        heartbeat,
        workerId,
      );
      db.prepare(
        "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
      ).run(staleIso, staleIso, staleIso, staleIso, jobId);

      expect(queue.recoverStaleClaimedJobs(120_000).map((item) => item.jobId)).toEqual([jobId]);
      expect(queue.getJob(jobId)?.status).toBe("failed");
      queue.close();
    }
  });

  test("does not recover an aligned busy job before effective grace window when heartbeat is fresh", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-c");
    const db = (queue as unknown as { db: any }).db as any;
    const onlyThreeMinutesOld = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const freshHeartbeat = new Date(Date.now() - 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      freshHeartbeat,
      "worker-c",
    );
    db.prepare(
      "UPDATE jobs SET updatedAt = ?, startedAt = ?, claimedAt = ?, lastActivityAt = ? WHERE id = ?",
    ).run(
      onlyThreeMinutesOld,
      onlyThreeMinutesOld,
      onlyThreeMinutesOld,
      onlyThreeMinutesOld,
      jobId,
    );

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe("claimed");
  });

  test("scans past an older healthy claim to recover an eligible stale claim at the limit", () => {
    const queue = new JobQueue(":memory:");
    const healthyJobId = enqueueAndClaim(queue, "worker-scan-healthy");
    const staleJobId = enqueueAndClaim(queue, "worker-scan-stale");
    const db = (queue as unknown as { db: any }).db as any;
    const healthyActivity = new Date(Date.now() - 3 * 60_000).toISOString();
    const staleActivity = new Date(Date.now() - 150_000).toISOString();
    const freshHeartbeat = new Date().toISOString();
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();

    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
    ).run(healthyActivity, healthyActivity, healthyActivity, healthyActivity, healthyJobId);
    db.prepare(
      `UPDATE workers
       SET status = 'busy', currentJobId = ?, lastHeartbeat = ?
       WHERE workerId = ?`,
    ).run(healthyJobId, freshHeartbeat, "worker-scan-healthy");

    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
    ).run(staleActivity, staleActivity, staleActivity, staleActivity, staleJobId);
    db.prepare(
      `UPDATE workers
       SET status = 'offline', currentJobId = NULL, lastHeartbeat = ?
       WHERE workerId = ?`,
    ).run(staleHeartbeat, "worker-scan-stale");

    const recovered = queue.recoverStaleClaimedJobs(120_000, 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.jobId).toBe(staleJobId);
    expect(queue.getJob(healthyJobId)?.status).toBe("claimed");
    expect(queue.getJob(staleJobId)?.status).toBe("failed");
    queue.close();
  });

  test("recovers an aligned busy job when heartbeat is stale beyond base TTL", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-d");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 3 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-d");
    db.prepare(
      "UPDATE jobs SET updatedAt = ?, startedAt = ?, claimedAt = ?, lastActivityAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, staleIso, jobId);

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(recovered[0]?.detail).toContain("heartbeatFreshForGrace=no");
    expect(queue.getJob(jobId)?.status).toBe("failed");
  });

  test("requeues retry-safe stale claims as abandoned successors with resume metadata", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueKindAndClaim(queue, "worker-warmup-stale", "warmup.execute", {
      bootReason: "prewarm",
    });
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // Legacy databases may have a requests table that predates durable handoff columns.
    db.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY)`);

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(
      staleIso,
      "worker-warmup-stale",
    );
    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL, lastActivityAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, staleIso, jobId);

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.action).toBe("requeued");
    expect(recovered[0]?.finalStatus).toBe("abandoned");
    expect(recovered[0]?.retrySafety).toBe("retry_safe");
    expect(recovered[0]?.replacementJobId).toBeTruthy();

    const abandoned = queue.getJob(jobId);
    expect(abandoned?.status).toBe("abandoned");
    expect(abandoned?.error).toContain("replacementJobId");

    const replacement = queue.getPendingJobs().find((row) => row.resumeOfJobId === jobId);
    expect(replacement?.status).toBe("pending");
    expect(replacement?.attempt).toBe(2);
    expect(replacement?.kind).toBe("warmup.execute");

    const replacementParams = JSON.parse(String(replacement?.params ?? "{}")) as Record<
      string,
      unknown
    >;
    const resume = replacementParams.resume as Record<string, unknown> | undefined;
    expect(resume?.previousJobId).toBe(jobId);
    expect(resume?.reason).toBe("stale_worker_claim");
    expect(queue.countByStatus().abandoned).toBe(1);
    expect(queue.countByStatus().pending).toBe(1);

    const slo = queue.sloSummary(24);
    expect(slo.abandoned).toBe(1);
    expect(slo.timeoutFailures).toBe(1);
  });

  test("heartbeat mismatch uses authoritative activity despite corrupt legacy timestamps", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-heartbeat-orphan");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 60 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `UPDATE jobs
       SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = ?, lastActivityAt = ?
       WHERE id = ?`,
    ).run(futureIso, futureIso, futureIso, futureIso, staleIso, jobId);

    const heartbeat = queue.heartbeat({
      workerId: "worker-heartbeat-orphan",
      status: "idle",
      currentJobId: null,
    });

    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.recoveredJobs).toEqual([
      expect.objectContaining({
        jobId,
        action: "failed",
        finalStatus: "failed",
        retrySafety: "manual_retry_required",
      }),
    ]);
    expect(queue.getJob(jobId)?.status).toBe("failed");
    expect(queue.getJob(jobId)?.error).toContain("worker heartbeat dropped claimed job");
    expect(queue.listWorkers()[0]?.currentJobId).toBeNull();
  });

  test("heartbeat requeues retry-safe orphaned claims instead of failing them", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueKindAndClaim(queue, "worker-heartbeat-warmup", "warmup.execute", {
      bootReason: "heartbeat-restart",
    });
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 60 * 1000).toISOString();

    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, lastActivityAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, staleIso, jobId);

    const heartbeat = queue.heartbeat({
      workerId: "worker-heartbeat-warmup",
      status: "idle",
      currentJobId: null,
    });

    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.recoveredJobs).toEqual([
      expect.objectContaining({
        jobId,
        action: "requeued",
        finalStatus: "abandoned",
        retrySafety: "retry_safe",
        replacementJobId: expect.any(String),
      }),
    ]);
    expect(queue.getJob(jobId)?.status).toBe("abandoned");

    const replacement = queue.getPendingJobs().find((row) => row.resumeOfJobId === jobId);
    expect(replacement?.status).toBe("pending");
    expect(replacement?.attempt).toBe(2);

    const replacementParams = JSON.parse(String(replacement?.params ?? "{}")) as Record<
      string,
      unknown
    >;
    const resume = replacementParams.resume as Record<string, unknown> | undefined;
    expect(resume?.reason).toBe("worker_heartbeat_mismatch");
    expect(queue.listWorkers()[0]?.currentJobId).toBeNull();
  });

  test("heartbeat returns retry-safe recovery metadata before task execution starts", () => {
    const queue = new JobQueue(":memory:");
    const workerId = "worker-heartbeat-pre-start";
    const jobId = enqueueAndClaim(queue, workerId);
    expect(queue.getJob(jobId)?.startedAt).toBeNull();
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare("UPDATE jobs SET updatedAt = ?, claimedAt = ?, lastActivityAt = ? WHERE id = ?").run(
      staleIso,
      staleIso,
      staleIso,
      jobId,
    );

    const heartbeat = queue.heartbeat({
      workerId,
      status: "offline",
      currentJobId: null,
    });
    const replacementJobId = heartbeat.recoveredJobs?.[0]?.replacementJobId;

    expect(heartbeat).toMatchObject({
      ok: true,
      recoveredJobs: [
        {
          jobId,
          action: "requeued",
          finalStatus: "abandoned",
          retrySafety: "retry_safe",
        },
      ],
    });
    expect(typeof replacementJobId).toBe("string");
    expect(queue.getJob(jobId)?.status).toBe("abandoned");
    const replacement = queue.getPendingJobs().find((row) => row.resumeOfJobId === jobId);
    expect(replacement?.id).toBe(replacementJobId);
    expect(replacement).toMatchObject({
      status: "pending",
      resumeOfJobId: jobId,
      attempt: 2,
      startedAt: null,
    });
  });

  test("heartbeat keeps freshly-claimed jobs during orphaned-claim grace window", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-heartbeat-grace");

    const heartbeat = queue.heartbeat({
      workerId: "worker-heartbeat-grace",
      status: "idle",
      currentJobId: null,
    });

    expect(heartbeat.ok).toBe(true);
    expect(queue.getJob(jobId)?.status).toBe("claimed");
  });

  test("an exact busy heartbeat refreshes only its claimed job activity", () => {
    const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    setSystemTime(nowMs);
    const queue = new JobQueue(":memory:");
    try {
      const workerId = "worker-heartbeat-activity";
      const jobId = enqueueAndClaim(queue, workerId);
      expect(
        queue.startClaimedExecution(jobId, {
          workerId,
          claimGeneration: Number(queue.getJob(jobId)?.claimGeneration ?? 0),
        }).ok,
      ).toBe(true);
      const db = (queue as unknown as { db: any }).db as any;
      const priorActivityAt = new Date(nowMs - 1_000).toISOString();
      db.prepare("UPDATE jobs SET lastActivityAt = ? WHERE id = ?").run(priorActivityAt, jobId);

      expect(
        queue.heartbeat({
          workerId: "different-worker",
          status: "busy",
          currentJobId: jobId,
        }).ok,
      ).toBe(true);
      expect(queue.getJob(jobId)?.lastActivityAt).toBe(priorActivityAt);

      expect(
        queue.heartbeat({
          workerId,
          status: "busy",
          currentJobId: "different-job",
        }).ok,
      ).toBe(true);
      expect(queue.getJob(jobId)?.lastActivityAt).toBe(priorActivityAt);

      setSystemTime(nowMs + 1_000);
      expect(
        queue.heartbeat({
          workerId,
          status: "busy",
          currentJobId: jobId,
        }).ok,
      ).toBe(true);
      expect(queue.getJob(jobId)?.lastActivityAt).toBe("2026-08-19T12:00:01.000Z");
    } finally {
      queue.close();
      setSystemTime();
    }
  });

  test("computes job SLO summary including timeout failures", () => {
    const queue = new JobQueue(":memory:");

    const done = queue.enqueue({
      taskId: "task-complete",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "normal",
    });
    expect(done.ok).toBe(true);
    const doneClaim = queue.claim("worker-slo");
    expect(doneClaim.ok).toBe(true);
    const doneComplete = queue.complete(done.jobId!, { summary: "done" });
    expect(doneComplete.ok).toBe(true);

    const timeout = queue.enqueue({
      taskId: "task-timeout",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      priority: "background",
    });
    expect(timeout.ok).toBe(true);
    const timeoutClaim = queue.claim("worker-slo");
    expect(timeoutClaim.ok).toBe(true);
    const timeoutFail = queue.fail(timeout.jobId!, {
      message: "OpenHands wrapper timed out after 120000ms",
      detail: "deadline exceeded",
    });
    expect(timeoutFail.ok).toBe(true);

    const slo = queue.sloSummary(24);
    expect(slo.terminal).toBe(2);
    expect(slo.completed).toBe(1);
    expect(slo.failed).toBe(1);
    expect(slo.timeoutFailures).toBe(1);
    expect(slo.successRate).toBe(0.5);
    expect(slo.timeoutRate).toBe(0.5);
    expect(slo.durationMs.sampleSize).toBeGreaterThanOrEqual(2);
    expect(slo.queueWaitMs.sampleSize).toBeGreaterThanOrEqual(2);
  });

  test("counts stale worker watchdog failures in timeout-rate bucket", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-timeout");
    const fail = queue.fail(jobId, {
      message: "Job auto-failed after stale worker claim",
      detail: "worker heartbeat stale",
    });
    expect(fail.ok).toBe(true);

    const slo = queue.sloSummary(24);
    expect(slo.terminal).toBe(1);
    expect(slo.failed).toBe(1);
    expect(slo.timeoutFailures).toBe(1);
    expect(slo.timeoutRate).toBe(1);
  });

  test("records publish-blocked jobs as a distinct terminal status", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-publish-blocked");

    const blocked = queue.publishBlocked(jobId, {
      message: "Failed to sync and push task.execute commit",
      detail: "Failed to sync branch before push: git pull --rebase failed",
      publishBlocked: {
        publicBranch: "agent/worker/test",
        localRef: "refs/pushpals/agent/worker/test",
        sha: "abc123",
        stage: "sync",
      },
    });
    expect(blocked.ok).toBe(true);

    const job = queue.getJob(jobId);
    expect(job?.status).toBe("publish_blocked");
    expect(job?.error).toContain("publish");
    expect(queue.countByStatus().publish_blocked).toBe(1);

    const slo = queue.sloSummary(24);
    expect(slo.publishBlocked).toBe(1);
    expect(slo.terminal).toBe(1);
    expect(slo.completed).toBe(0);
  });
});
