import type { WorkerRow } from "./jobs.js";

export interface WorkerExecutionCapability {
  state: "ready" | "blocked" | "unknown";
  reason?: string;
  retry_after_ms?: number;
  observed_at: string;
}

type ExecutionWorker = Pick<WorkerRow, "isOnline" | "details" | "activeJobCount" | "status">;

export function workerExecutionBlocked(worker: ExecutionWorker): boolean {
  return worker.isOnline && worker.details.executionReady === false;
}

export function workerExecutionIdle(worker: ExecutionWorker): boolean {
  return (
    worker.isOnline &&
    !workerExecutionBlocked(worker) &&
    worker.status === "idle" &&
    worker.activeJobCount === 0
  );
}

/** A heartbeat proves liveness, not that the executor can accept work. */
export function summarizeWorkerExecutionCapability(
  workers: readonly ExecutionWorker[],
  nowMs = Date.now(),
): WorkerExecutionCapability {
  const observed_at = new Date(nowMs).toISOString();
  const online = workers.filter((worker) => worker.isOnline);
  if (online.some((worker) => worker.details.executionReady === true)) {
    return { state: "ready", observed_at };
  }
  // Legacy/absent workers must not cause a permanent bootstrap freeze. Only
  // fresh, explicit capability failures warrant admission backpressure.
  if (online.length === 0 || online.some((worker) => !workerExecutionBlocked(worker))) {
    return { state: "unknown", observed_at };
  }
  const delays = online.map((worker) => {
    const readiness = worker.details.executionReadiness;
    const retryAt =
      readiness && typeof readiness === "object"
        ? (readiness as Record<string, unknown>).retryAt
        : null;
    const retryMs = typeof retryAt === "string" ? Date.parse(retryAt) : Number.NaN;
    return Number.isFinite(retryMs) ? Math.max(1_000, retryMs - nowMs) : 30_000;
  });
  return {
    state: "blocked",
    reason: "All online workers are checking or blocked on execution infrastructure",
    retry_after_ms: Math.min(30 * 60_000, ...delays),
    observed_at,
  };
}
