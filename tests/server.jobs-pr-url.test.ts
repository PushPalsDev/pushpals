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
      const prBefore = before.find((entry) => entry.prUrl === "https://github.com/org/repo/pull/99");
      expect(prBefore?.mergeState).toBe("open_unmerged");
      expect(queue.countOpenUnmergedWorkerPrs()).toBe(1);

      const feedback = store.recordPrFeedback({
        patternKey: "lint_fix::apps/server::queue_health",
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
});
