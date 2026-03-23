import type { ExecutorBackend, JobResult } from "../common/types.js";
import type { WorkerpalsRuntimeConfig } from "../common/executor_backend.js";

export interface DockerBackendRuntimeConfigType {
  python: string;
  timeoutMs: number;
}

export type DockerBackendRuntimeConfig = Record<string, DockerBackendRuntimeConfigType>;

export interface DockerWarmShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerWarmStartupContext {
  sharedVenvPython: string;
  warmAgentPort: number;
  startupAttempts: number;
  sleepSeconds: string;
}

export interface DockerWarmRuntimeContext extends DockerWarmStartupContext {
  warmContainerName: string;
  runWarmShell: (command: string) => Promise<DockerWarmShellResult>;
  restartWarmContainer: () => Promise<void>;
  collectWarmDiagnostics: () => Promise<string>;
}

export interface DockerBackendSpec {
  name: ExecutorBackend;
  configuredPython: (config: DockerBackendRuntimeConfig) => string;
  timeoutMs: (config: DockerBackendRuntimeConfig) => number;
  normalizeContainerPython: (configuredPython: string, sharedVenvPython: string) => string;
  warmContainerStartupCommand: (context: DockerWarmStartupContext) => string;
  warmContainerEnv: (context: DockerWarmStartupContext) => Record<string, string>;
  ensureWarmRuntime: ((context: DockerWarmRuntimeContext) => Promise<void>) | null;
  diagnosticChecks: (sharedVenvPython: string) => Array<{ label: string; command: string }>;
  warmupProbeCommand: ((sharedVenvPython: string) => string) | null;
  taskExecute: BackendTaskExecutor;
}

export type BackendTaskExecutor = (
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  runtimeConfig: WorkerpalsRuntimeConfig,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
  budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number },
) => Promise<JobResult>;
