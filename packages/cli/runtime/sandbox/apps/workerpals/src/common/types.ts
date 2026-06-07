export type ExecutorBackend = string;

export interface JobTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  estimated?: boolean;
  backend?: string;
  modelId?: string;
}

export interface JobPublishBlockedInfo {
  summary: string;
  detail: string;
  publicBranch: string;
  localRef: string;
  sha: string;
  stage: "sync" | "push";
}

export interface JobDiagnosticAttempt {
  attempt: number;
  workerId?: string | null;
  backend?: string | null;
  model?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  terminalReason?: string | null;
  exitCode?: number | null;
  metadata?: Record<string, unknown>;
}

export interface JobTerminalDiagnostics {
  failureClass?: string | null;
  terminalStage?: string | null;
  executorBackend?: string | null;
  summary?: string | null;
  watchdogFired?: boolean;
  timeoutMs?: number | null;
  publishableFileCount?: number | null;
  artifactOnlyPathCount?: number | null;
  changedPathSample?: string[];
  metadata?: Record<string, unknown>;
}

export interface JobPhaseSpanDiagnostics {
  attempt?: number | null;
  phase: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome?: string | null;
  metadata?: Record<string, unknown>;
}

export interface JobValidationRunDiagnostics {
  attempt?: number | null;
  command: string;
  exitCode?: number | null;
  durationMs?: number | null;
  passed: boolean;
  failureClass?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  metadata?: Record<string, unknown>;
}

export interface JobPatchSnapshotDiagnostics {
  attempt?: number | null;
  phase?: string | null;
  publishableFileCount?: number | null;
  artifactOnlyPathCount?: number | null;
  changedPathSample?: string[];
  topLevelDirs?: string[];
  capturedAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface JobDiagnostics {
  attempts?: JobDiagnosticAttempt[];
  terminal?: JobTerminalDiagnostics;
  phaseSpans?: JobPhaseSpanDiagnostics[];
  validationRuns?: JobValidationRunDiagnostics[];
  patchSnapshots?: JobPatchSnapshotDiagnostics[];
  metadata?: Record<string, unknown>;
}

export interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  usage?: JobTokenUsage;
  publishBlocked?: JobPublishBlockedInfo;
  diagnostics?: JobDiagnostics;
}
