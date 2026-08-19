import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

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

  test("does not recover a claimed job when log activity is recent", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-a");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-a");
    db.prepare("UPDATE jobs SET updatedAt = ? WHERE id = ?").run(staleIso, jobId);

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
      "UPDATE jobs SET claimedAt = ?, startedAt = ?, firstLogAt = NULL, updatedAt = ? WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, jobId);
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

  test("does not let a worker claim a second job while another claim is still active", () => {
    const queue = new JobQueue(":memory:");

    const first = queue.enqueue({
      taskId: "task-first",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });
    const second = queue.enqueue({
      taskId: "task-second",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const firstClaim = queue.claim("worker-serial");
    expect(firstClaim.ok).toBe(true);
    expect(firstClaim.job?.id).toBe(first.jobId);

    const secondClaim = queue.claim("worker-serial");
    expect(secondClaim.ok).toBe(false);
    expect(secondClaim.message).toContain("already has claimed job");

    const queuedJob = queue.getJob(second.jobId!);
    expect(queuedJob?.status).toBe("pending");
    expect(queue.listWorkers()[0]?.currentJobId).toBe(first.jobId);
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

  test("recovers a claimed job when both heartbeat and log activity are stale", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-b");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-b");
    db.prepare(
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, jobId);

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(queue.getJob(jobId)?.status).toBe("failed");
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
    db.prepare("UPDATE jobs SET updatedAt = ?, startedAt = ?, claimedAt = ? WHERE id = ?").run(
      onlyThreeMinutesOld,
      onlyThreeMinutesOld,
      onlyThreeMinutesOld,
      jobId,
    );

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(0);
    expect(queue.getJob(jobId)?.status).toBe("claimed");
  });

  test("recovers an aligned busy job when heartbeat is stale beyond base TTL", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-d");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 3 * 60 * 1000).toISOString();

    db.prepare("UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?").run(staleIso, "worker-d");
    db.prepare("UPDATE jobs SET updatedAt = ?, startedAt = ?, claimedAt = ? WHERE id = ?").run(
      staleIso,
      staleIso,
      staleIso,
      jobId,
    );

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
      "UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ?, firstLogAt = NULL WHERE id = ?",
    ).run(staleIso, staleIso, staleIso, jobId);

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

  test("heartbeat fails orphaned claimed jobs once the worker reports idle past grace", () => {
    const queue = new JobQueue(":memory:");
    const jobId = enqueueAndClaim(queue, "worker-heartbeat-orphan");
    const db = (queue as unknown as { db: any }).db as any;
    const staleIso = new Date(Date.now() - 60 * 1000).toISOString();

    db.prepare("UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ? WHERE id = ?").run(
      staleIso,
      staleIso,
      staleIso,
      jobId,
    );

    const heartbeat = queue.heartbeat({
      workerId: "worker-heartbeat-orphan",
      status: "idle",
      currentJobId: null,
    });

    expect(heartbeat.ok).toBe(true);
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

    db.prepare("UPDATE jobs SET updatedAt = ?, claimedAt = ?, startedAt = ? WHERE id = ?").run(
      staleIso,
      staleIso,
      staleIso,
      jobId,
    );

    const heartbeat = queue.heartbeat({
      workerId: "worker-heartbeat-warmup",
      status: "idle",
      currentJobId: null,
    });

    expect(heartbeat.ok).toBe(true);
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
