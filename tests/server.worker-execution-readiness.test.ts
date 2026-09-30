import { describe, expect, test } from "bun:test";
import { JobQueue } from "../apps/server/src/jobs";
import {
  summarizeWorkerExecutionCapability,
  workerExecutionIdle,
} from "../apps/server/src/worker_execution_readiness";

const now = Date.parse("2026-09-30T12:00:00Z");
const worker = (details: Record<string, unknown>, isOnline = true) => ({
  details,
  isOnline,
  status: "idle" as const,
  activeJobCount: 0,
});

describe("worker execution capability admission", () => {
  test("a blocked target cannot strand pending work while a healthy worker is available", () => {
    const queue = new JobQueue(":memory:");
    try {
      queue.heartbeat({ workerId: "target", status: "idle", details: { executionReady: true } });
      const job = queue.enqueue({
        taskId: "pinned",
        kind: "task.execute",
        params: {},
        targetWorkerId: "target",
      });
      expect(queue.claim("healthy").job).toBeUndefined();
      expect(queue.countAutoscalablePendingByKind("task.execute")).toBe(0);
      queue.heartbeat({ workerId: "target", status: "error", details: { executionReady: false } });
      expect(queue.countAutoscalablePendingByKind("task.execute")).toBe(1);
      expect(queue.claim("healthy").job).toMatchObject({ id: job.jobId, attempt: 1 });
    } finally {
      queue.close();
    }
  });

  test("fresh blocked workers are live but not executable or idle capacity", () => {
    const blocked = worker({
      executionReady: false,
      executionReadiness: {
        status: "blocked",
        retryAt: new Date(now + 60_000).toISOString(),
      },
    });
    expect(workerExecutionIdle(blocked)).toBe(false);
    expect(summarizeWorkerExecutionCapability([blocked], now)).toMatchObject({
      state: "blocked",
      retry_after_ms: 60_000,
    });
  });

  test("one healthy worker keeps a mixed fleet available", () => {
    expect(
      summarizeWorkerExecutionCapability(
        [worker({ executionReady: false }), worker({ executionReady: true })],
        now,
      ).state,
    ).toBe("ready");
    expect(workerExecutionIdle(worker({ executionReady: true }))).toBe(true);
    expect(workerExecutionIdle({ ...worker({}), activeJobCount: 1 })).toBe(false);
  });

  test("stale failures, absent workers and legacy heartbeats cannot freeze bootstrap", () => {
    for (const workers of [
      [],
      [worker({ executionReady: false }, false)],
      [worker({})],
      [worker({ executionReady: false }), worker({})],
    ]) {
      expect(summarizeWorkerExecutionCapability(workers, now).state).toBe("unknown");
    }
  });

  test.each([
    [null, 30_000],
    ["not-a-date", 30_000],
    [new Date(now - 1000).toISOString(), 1_000],
    [new Date(now + 86_400_000).toISOString(), 1_800_000],
  ])("probe recheck is bounded for retryAt=%s", (retryAt, expected) => {
    expect(
      summarizeWorkerExecutionCapability(
        [worker({ executionReady: false, executionReadiness: { retryAt } })],
        now,
      ).retry_after_ms,
    ).toBe(expected);
  });

  test("repeated blocked claims preserve the original pending job and recover without a new attempt", () => {
    const queue = new JobQueue(":memory:");
    try {
      const job = queue.enqueue({ taskId: "original", kind: "task.execute", params: {} });
      queue.heartbeat({ workerId: "blocked", status: "error", details: { executionReady: false } });
      for (let poll = 0; poll < 10; poll++) {
        expect(queue.claim("blocked")).toEqual({ ok: true, executionBlocked: true });
      }
      expect(queue.countByKindAndStatus("task.execute", "pending")).toBe(1);
      expect(queue.countByKindAndStatus("task.execute", "failed")).toBe(0);
      queue.heartbeat({ workerId: "blocked", status: "idle", details: { executionReady: true } });
      expect(queue.claim("blocked").job).toMatchObject({
        id: job.jobId,
        attempt: 1,
        claimGeneration: 1,
      });
    } finally {
      queue.close();
    }
  });

  test("readiness changes do not strand existing claims or prevent healthy workers claiming", () => {
    const queue = new JobQueue(":memory:");
    try {
      const first = queue.enqueue({ taskId: "owned", kind: "task.execute", params: {} });
      expect(queue.claim("owner").job?.id).toBe(first.jobId);
      queue.heartbeat({
        workerId: "owner",
        status: "busy",
        currentJobId: first.jobId,
        details: { executionReady: false },
      });
      expect(queue.claim("owner")).toMatchObject({ replayed: true, job: { id: first.jobId } });
      const second = queue.enqueue({ taskId: "next", kind: "task.execute", params: {} });
      expect(queue.claim("legacy-healthy").job?.id).toBe(second.jobId);
    } finally {
      queue.close();
    }
  });
});
