// Supervisor and worker must agree on startup budgets. These are upper bounds,
// not readiness signals: only a registered, online worker may receive a job.
export const WORKER_STARTUP_CLEANUP_GRACE_MS = 30_000;
export const WORKER_STARTUP_IMAGE_BUILD_MS = 600_000;
export const WORKER_STARTUP_IMAGE_PULL_MS = 600_000;
export const WORKER_STARTUP_SELFCHECK_MS = 300_000;
export const WORKER_STARTUP_DEADLINE_ENV = "PUSHPALS_WORKER_STARTUP_DEADLINE_MS";
export const WORKER_STARTUP_TIMEOUT_ENV = "PUSHPALS_WORKER_STARTUP_TIMEOUT_MS";

export type WorkerStartupPhase =
  | "docker-startup-preflight"
  | "docker-image-build"
  | "docker-image-pull"
  | "docker-startup-selfcheck";

export function isWorkerStartupPhase(value: unknown): value is WorkerStartupPhase {
  return (
    value === "docker-startup-preflight" ||
    value === "docker-image-build" ||
    value === "docker-image-pull" ||
    value === "docker-startup-selfcheck"
  );
}

function normalStartupTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) || 1 : 120_000;
}

export function workerStartupPhaseTimeoutMs(phase: WorkerStartupPhase, normalMs: number): number {
  switch (phase) {
    case "docker-startup-preflight":
      return normalStartupTimeoutMs(normalMs);
    case "docker-image-build":
      return WORKER_STARTUP_IMAGE_BUILD_MS;
    case "docker-image-pull":
      return WORKER_STARTUP_IMAGE_PULL_MS;
    case "docker-startup-selfcheck":
      return WORKER_STARTUP_SELFCHECK_MS;
  }
}

/** One absolute ceiling shared by preparation, fallback, checks, and registration. */
export function workerStartupAllowanceMs(normalMs: number, docker: boolean): number {
  return (
    normalStartupTimeoutMs(normalMs) +
    (docker
      ? WORKER_STARTUP_IMAGE_BUILD_MS +
        WORKER_STARTUP_IMAGE_PULL_MS +
        WORKER_STARTUP_SELFCHECK_MS +
        WORKER_STARTUP_CLEANUP_GRACE_MS
      : 0)
  );
}
