import type { ExecutorBackend } from "../common/types.js";
import type { BackendTaskExecutor } from "./types.js";

export type { BackendTaskExecutor };

const specializedTaskExecutors = new Map<ExecutorBackend, BackendTaskExecutor>();

export function registerBackendTaskExecutor(
  backend: ExecutorBackend,
  executor: BackendTaskExecutor,
): void {
  specializedTaskExecutors.set(backend, executor);
}

export function getBackendTaskExecutor(backend: ExecutorBackend): BackendTaskExecutor | undefined {
  return specializedTaskExecutors.get(backend);
}
