import { loadPushPalsConfig } from "shared";
import type { ExecutorBackend } from "./types.js";
import { BACKEND_EXECUTOR_SCRIPT_SEGMENTS, DEFAULT_EXECUTOR } from "../backends/backend_config.js";

const DEFAULT_CONFIG = loadPushPalsConfig();
export type WorkerpalsRuntimeConfig = ReturnType<typeof loadPushPalsConfig>;

export function resolveExecutor(config: WorkerpalsRuntimeConfig = DEFAULT_CONFIG): ExecutorBackend {
  const raw = config.workerpals.executor.trim().toLowerCase();
  if (raw in BACKEND_EXECUTOR_SCRIPT_SEGMENTS) return raw as ExecutorBackend;
  console.warn(
    `[WorkerPals] Unknown workerpals.executor="${raw}", falling back to "${DEFAULT_EXECUTOR}".`,
  );
  return DEFAULT_EXECUTOR;
}
