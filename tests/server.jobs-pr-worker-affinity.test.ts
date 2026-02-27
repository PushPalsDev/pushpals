import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue PR worker affinity", () => {
  test("routes same PR URL to the worker that previously claimed it", () => {
    const queue = new JobQueue(":memory:");
    const prUrl = "https://github.com/org/repo/pull/123";

    const first = queue.enqueue({
      taskId: "task-pr-affinity-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:123:sha-a",
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const claimedFirst = queue.claim("worker-a");
    expect(claimedFirst.ok).toBe(true);
    expect(claimedFirst.job?.id).toBe(firstJobId);
    expect(queue.complete(firstJobId, { summary: "done" }).ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-pr-affinity-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:123:sha-b",
    });
    expect(second.ok).toBe(true);
    const secondJobId = String(second.jobId ?? "");
    expect(secondJobId.length).toBeGreaterThan(0);

    const secondJob = queue.getJob(secondJobId);
    expect(secondJob?.targetWorkerId).toBe("worker-a");

    const wrongWorkerClaim = queue.claim("worker-b");
    expect(wrongWorkerClaim.ok).toBe(false);
    expect(wrongWorkerClaim.message).toBe("No pending jobs");

    const rightWorkerClaim = queue.claim("worker-a");
    expect(rightWorkerClaim.ok).toBe(true);
    expect(rightWorkerClaim.job?.id).toBe(secondJobId);
    queue.close();
  });

  test("learns PR affinity when prUrl is attached after claim", () => {
    const queue = new JobQueue(":memory:");
    const prUrl = "https://github.com/org/repo/pull/124";

    const first = queue.enqueue({
      taskId: "task-pr-affinity-setpr-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:124:sha-a",
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");

    const claimedFirst = queue.claim("worker-c");
    expect(claimedFirst.ok).toBe(true);
    expect(queue.setPrUrl(firstJobId, prUrl).ok).toBe(true);
    expect(queue.complete(firstJobId, { summary: "done" }).ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-pr-affinity-setpr-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:124:sha-b",
    });
    expect(second.ok).toBe(true);
    const secondJob = queue.getJob(String(second.jobId ?? ""));
    expect(secondJob?.targetWorkerId).toBe("worker-c");
    queue.close();
  });

  test("keeps explicit targetWorkerId over PR affinity", () => {
    const queue = new JobQueue(":memory:");
    const prUrl = "https://github.com/org/repo/pull/125";

    const first = queue.enqueue({
      taskId: "task-pr-affinity-explicit-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:125:sha-a",
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(queue.claim("worker-z").job?.id).toBe(firstJobId);
    expect(queue.complete(firstJobId, { summary: "done" }).ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-pr-affinity-explicit-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      targetWorkerId: "worker-explicit",
      dedupeKey: "pr:125:sha-b",
    });
    expect(second.ok).toBe(true);
    const secondJob = queue.getJob(String(second.jobId ?? ""));
    expect(secondJob?.targetWorkerId).toBe("worker-explicit");
    queue.close();
  });

  test("does not pin to stale worker affinity mappings", () => {
    const queue = new JobQueue(":memory:");
    const prUrl = "https://github.com/org/repo/pull/126";

    const first = queue.enqueue({
      taskId: "task-pr-affinity-stale-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:126:sha-a",
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(queue.claim("worker-stale").job?.id).toBe(firstJobId);
    expect(queue.complete(firstJobId, { summary: "done" }).ok).toBe(true);

    const db = (queue as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare(`UPDATE workers SET lastHeartbeat = ? WHERE workerId = ?`).run(
      "2001-01-01T00:00:00.000Z",
      "worker-stale",
    );

    const second = queue.enqueue({
      taskId: "task-pr-affinity-stale-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {
        reviewAgent: { prUrl },
      },
      dedupeKey: "pr:126:sha-b",
    });
    expect(second.ok).toBe(true);
    const secondJob = queue.getJob(String(second.jobId ?? ""));
    expect(secondJob?.targetWorkerId).toBeNull();
    queue.close();
  });
});
