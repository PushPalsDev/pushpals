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
    const claim2 = queue.claim("worker-a");
    const claim3 = queue.claim("worker-a");
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
});
