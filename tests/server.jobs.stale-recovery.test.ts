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
    db.prepare("UPDATE jobs SET updatedAt = ? WHERE id = ?").run(staleIso, jobId);

    const recovered = queue.recoverStaleClaimedJobs(120_000);

    expect(recovered.length).toBe(1);
    expect(recovered[0]?.jobId).toBe(jobId);
    expect(queue.getJob(jobId)?.status).toBe("failed");
  });
});
