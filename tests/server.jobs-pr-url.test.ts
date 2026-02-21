import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";

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
});
