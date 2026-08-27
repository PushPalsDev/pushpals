/**
 * Factory for a generic Python-wrapper backend task executor.
 *
 * Backends that don't need specialized streaming/stuck-guard logic can use
 * this as their taskExecute implementation. It spawns the backend's Python
 * script, applies timeout + budget capping, and parses the structured
 * sentinel result.
 */

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  isWorkerOwnedRuntimeStackFrame,
  runBoundedProcess as runBoundedWorkerProcess,
} from "shared";
import type {
  JobCandidateState,
  JobDiagnostics,
  JobResult,
  JobTokenUsage,
  JobUsageAttempt,
  JobUsageStage,
} from "./types.js";
import type { WorkerpalsRuntimeConfig } from "./executor_backend.js";
import type { BackendTaskExecutor } from "../backends/types.js";
import {
  truncate,
  parseStructuredResult,
  filterResultLines,
  hasStructuredResultSentinel,
  validateStructuredJobResultEnvelope,
} from "./execution_utils.js";
import { buildWorkerSandboxWritableEnv } from "./sandbox_env.js";
import {
  createPythonPayloadTransport,
  type PythonPayloadTransport,
} from "./python_payload_transport.js";

interface GenericPythonExecutorConfig {
  backendName: string;
  scriptPath: string;
  scriptSegments?: readonly string[];
  pythonConfigKey: string;
  timeoutConfigKey: string;
  capTimeoutToExecutionBudget?: boolean;
  /** Override only for deterministic progress-heartbeat tests. */
  progressIntervalMs?: number;
  /** Override only for deterministic process-outcome tests. */
  processRunner?: typeof runBoundedWorkerProcess;
}

const BACKEND_TIMEOUT_RESULT_GRACE_MS = 30_000;
const OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS = 240_000;
const OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS = 720_000;
const OPENAI_CODEX_MIN_PRIMARY_TURN_BUDGET_MS = 540_000;
const OPENAI_CODEX_VALIDATION_RESERVE_RATIO = 0.25;

function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}

function estimateJobTokenUsage(
  backendName: string,
  modelId: string,
  params: Record<string, unknown>,
  summary: string,
  stdout: string,
  stderr: string,
): JobTokenUsage {
  const promptSource = (() => {
    try {
      return JSON.stringify(params);
    } catch {
      return String(params?.instruction ?? params?.prompt ?? "");
    }
  })();
  const completionSource = [summary, stdout, stderr].filter(Boolean).join("\n\n");
  const promptTokens = estimateTokensFromText(promptSource);
  const completionTokens = estimateTokensFromText(completionSource);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
    backend: backendName,
    modelId,
  };
}

function coerceJobTokenUsage(value: unknown, fallback: JobTokenUsage): JobTokenUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const raw = value as Record<string, unknown>;
  const promptTokens = Number(raw.promptTokens ?? raw.prompt_tokens);
  const completionTokens = Number(raw.completionTokens ?? raw.completion_tokens);
  const totalTokens = Number(raw.totalTokens ?? raw.total_tokens);
  const hasPrompt = Number.isFinite(promptTokens) && promptTokens >= 0;
  const hasCompletion = Number.isFinite(completionTokens) && completionTokens >= 0;
  const hasTotal = Number.isFinite(totalTokens) && totalTokens >= 0;
  if (!hasPrompt && !hasCompletion && !hasTotal) {
    return fallback;
  }
  const normalizedPrompt = hasPrompt
    ? Math.round(promptTokens)
    : hasTotal
      ? Math.max(0, Math.round(totalTokens) - fallback.completionTokens)
      : fallback.promptTokens;
  const normalizedCompletion = hasCompletion
    ? Math.round(completionTokens)
    : hasTotal
      ? Math.max(0, Math.round(totalTokens) - normalizedPrompt)
      : fallback.completionTokens;
  const normalizedTotal = hasTotal
    ? Math.round(totalTokens)
    : normalizedPrompt + normalizedCompletion;
  return {
    promptTokens: normalizedPrompt,
    completionTokens: normalizedCompletion,
    totalTokens: normalizedTotal,
    estimated: typeof raw.estimated === "boolean" ? raw.estimated : false,
    backend:
      typeof raw.backend === "string" && raw.backend.trim().length > 0
        ? raw.backend.trim()
        : fallback.backend,
    modelId:
      typeof raw.modelId === "string" && raw.modelId.trim().length > 0
        ? raw.modelId.trim()
        : fallback.modelId,
  };
}

const JOB_USAGE_STAGES = new Set<JobUsageStage>([
  "executor",
  "executor_recovery",
  "critic",
  "validation",
  "finalization",
]);

function coerceJobUsageAttempts(
  value: unknown,
  backendName: string,
  modelId: string,
): JobUsageAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attempts: JobUsageAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const stage = String(raw.stage ?? "") as JobUsageStage;
    const attempt = Number(raw.attempt);
    const source = String(raw.source ?? "").trim();
    const hasUsage = [
      raw.promptTokens,
      raw.prompt_tokens,
      raw.completionTokens,
      raw.completion_tokens,
      raw.totalTokens,
      raw.total_tokens,
    ].some((tokenCount) => Number.isFinite(Number(tokenCount)) && Number(tokenCount) >= 0);
    if (
      !JOB_USAGE_STAGES.has(stage) ||
      !Number.isInteger(attempt) ||
      attempt <= 0 ||
      !source ||
      !hasUsage
    ) {
      continue;
    }
    const usage = coerceJobTokenUsage(raw, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: true,
      backend: backendName,
      modelId,
    });
    attempts.push({
      ...usage,
      stage,
      attempt,
      source,
      ...(raw.timedOut === true ? { timedOut: true } : {}),
    });
  }
  return attempts.length > 0 ? attempts : undefined;
}

function coerceJobCandidateState(value: unknown): JobCandidateState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.status !== "held" && raw.status !== "partial") return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  const changedPaths = Array.isArray(raw.changedPaths)
    ? raw.changedPaths.map((path) => String(path).trim()).filter(Boolean)
    : [];
  if (!reason) return undefined;
  const checkpointRaw =
    raw.checkpoint && typeof raw.checkpoint === "object" && !Array.isArray(raw.checkpoint)
      ? (raw.checkpoint as Record<string, unknown>)
      : null;
  const checkpoint =
    checkpointRaw &&
    typeof checkpointRaw.ref === "string" &&
    checkpointRaw.ref.trim() &&
    typeof checkpointRaw.sha === "string" &&
    /^[a-f0-9]{40,64}$/i.test(checkpointRaw.sha.trim()) &&
    typeof checkpointRaw.capturedAt === "string" &&
    checkpointRaw.capturedAt.trim()
      ? {
          ref: checkpointRaw.ref.trim(),
          sha: checkpointRaw.sha.trim().toLowerCase(),
          capturedAt: checkpointRaw.capturedAt.trim(),
        }
      : undefined;
  return {
    status: raw.status,
    reason,
    changedPaths,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

function resolveRuntimeSettings(
  config: GenericPythonExecutorConfig,
  runtimeConfig: WorkerpalsRuntimeConfig,
): { pythonBin: string; timeoutMs: number } {
  const workerCfg = runtimeConfig.workerpals as Record<string, unknown>;
  const rawPython = String(workerCfg[config.pythonConfigKey] ?? "python");
  const pythonBin =
    rawPython.includes("/") || rawPython.includes("\\")
      ? resolve(runtimeConfig.projectRoot, rawPython)
      : rawPython;
  const rawTimeout = Number(workerCfg[config.timeoutConfigKey]);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.max(10_000, Math.floor(rawTimeout))
    : 300_000;
  return { pythonBin, timeoutMs };
}

export function resolveGenericPythonExecutorTimeoutMs(params: {
  configuredTimeoutMs: number;
  executionBudgetMs?: number | null;
  finalizationBudgetMs?: number | null;
  capTimeoutToExecutionBudget?: boolean;
}): number {
  const configuredTimeoutMs = Math.max(10_000, Math.floor(params.configuredTimeoutMs));
  const executionBudgetMs =
    typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs)
      ? Math.max(1, Math.floor(params.executionBudgetMs))
      : null;
  const finalizationBudgetMs =
    typeof params.finalizationBudgetMs === "number" && Number.isFinite(params.finalizationBudgetMs)
      ? Math.max(0, Math.floor(params.finalizationBudgetMs))
      : 0;
  if (executionBudgetMs != null && params.capTimeoutToExecutionBudget !== false) {
    return Math.min(configuredTimeoutMs, executionBudgetMs + finalizationBudgetMs);
  }
  return configuredTimeoutMs;
}

export function resolveOpenAICodexValidationReserveMs(
  executionBudgetMs: number | null | undefined,
): number {
  if (typeof executionBudgetMs !== "number" || !Number.isFinite(executionBudgetMs)) return 0;
  const budgetMs = Math.max(1, Math.floor(executionBudgetMs));
  const targetReserveMs = Math.floor(
    Math.min(
      budgetMs,
      Math.max(
        OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS,
        Math.min(
          OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS,
          budgetMs * OPENAI_CODEX_VALIDATION_RESERVE_RATIO,
        ),
      ),
    ),
  );
  const maxReserveAfterPrimaryTurn = Math.max(
    0,
    budgetMs - OPENAI_CODEX_MIN_PRIMARY_TURN_BUDGET_MS,
  );
  return Math.max(0, Math.min(targetReserveMs, maxReserveAfterPrimaryTurn));
}

export function resolveGenericPythonExecutorChildTimeoutMs(params: {
  backendName: string;
  hostTimeoutMs: number;
  executionBudgetMs?: number | null;
}): number | null {
  const hostTimeoutMs = Math.max(1, Math.floor(params.hostTimeoutMs));
  if (params.backendName !== "openai_codex") return null;
  const executionBudgetMs =
    typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs)
      ? Math.max(1, Math.floor(params.executionBudgetMs))
      : null;
  const validationReserveMs = resolveOpenAICodexValidationReserveMs(executionBudgetMs);
  const childBudgetMs =
    executionBudgetMs == null
      ? hostTimeoutMs
      : Math.min(hostTimeoutMs, Math.max(1, executionBudgetMs - validationReserveMs));
  const graceMs = Math.min(
    BACKEND_TIMEOUT_RESULT_GRACE_MS,
    Math.max(2_000, Math.floor(childBudgetMs / 10)),
    Math.max(0, childBudgetMs - 1),
  );
  return Math.max(1, childBudgetMs - graceMs);
}

export function resolveGenericPythonExecutorChildTimeoutEnv(params: {
  backendName: string;
  hostTimeoutMs: number;
  executionBudgetMs?: number | null;
}): Record<string, string> {
  const childTimeoutMs = resolveGenericPythonExecutorChildTimeoutMs(params);
  if (childTimeoutMs == null) return {};
  return {
    WORKERPALS_OPENAI_CODEX_TIMEOUT_MS: String(childTimeoutMs),
    WORKERPALS_OPENAI_CODEX_TIMEOUT_S: String(Math.max(1, Math.floor(childTimeoutMs / 1000))),
  };
}

function toSnakeConfigKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function formatGenericPythonExecutorTimeoutDetail(
  config: GenericPythonExecutorConfig,
  configuredTimeoutMs: number,
  executionBudgetMs: number | null,
  finalizationBudgetMs: number | null,
  timeoutMs: number,
): string {
  const configPath = `workerpals.${toSnakeConfigKey(config.timeoutConfigKey)}`;
  if (executionBudgetMs == null) {
    return `${configPath}=${configuredTimeoutMs}ms`;
  }
  if (config.capTimeoutToExecutionBudget === false) {
    return `${configPath}=${configuredTimeoutMs}ms; planning executionBudgetMs=${executionBudgetMs}ms ignored by backend opt-out`;
  }
  if (timeoutMs < configuredTimeoutMs) {
    const finalizationDetail =
      finalizationBudgetMs && finalizationBudgetMs > 0
        ? ` + finalizationBudgetMs=${finalizationBudgetMs}ms`
        : "";
    return `${configPath}=${configuredTimeoutMs}ms capped by planning executionBudgetMs=${executionBudgetMs}ms${finalizationDetail}`;
  }
  return `${configPath}=${configuredTimeoutMs}ms within planning executionBudgetMs=${executionBudgetMs}ms`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function resolveGenericPythonExecutorScriptPath(
  config: GenericPythonExecutorConfig,
  runtimeConfig: WorkerpalsRuntimeConfig,
): { scriptPath: string | null; candidates: string[] } {
  const candidates: string[] = [];
  if (config.scriptSegments && config.scriptSegments.length > 0) {
    const runtimeRoot = dirname(runtimeConfig.configDir);
    candidates.push(join(runtimeRoot, "sandbox", ...config.scriptSegments));
    candidates.push(config.scriptPath);
    candidates.push(join(runtimeRoot, ...config.scriptSegments));
    candidates.push(join(runtimeConfig.projectRoot, ...config.scriptSegments));
  } else {
    candidates.push(config.scriptPath);
  }

  const uniqueCandidates = uniqueStrings(candidates.map((candidate) => resolve(candidate)));
  return {
    scriptPath: uniqueCandidates.find((candidate) => existsSync(candidate)) ?? null,
    candidates: uniqueCandidates,
  };
}

export function normalizeGenericPythonExecutorParsedResultForTimeout(params: {
  backendName: string;
  kind: string;
  timedOut: boolean;
  timeoutMs: number;
  timeoutDetail?: string;
  summary: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}): { summary: string; stdout: string; stderr: string; exitCode: number } {
  const signalTerminatedCodex =
    params.timedOut &&
    params.backendName === "openai_codex" &&
    /\bopenai_codex interrupted by signal 15\b/i.test(params.summary);
  if (!params.timedOut) {
    return {
      summary: params.summary,
      stdout: params.stdout,
      stderr: params.stderr,
      exitCode: params.exitCode,
    };
  }

  if (!signalTerminatedCodex) {
    const timeoutDetail = String(params.timeoutDetail ?? "").trim();
    return {
      summary: `${params.backendName} wrapper timed out after ${params.timeoutMs}ms for ${params.kind}`,
      stdout: params.stdout,
      stderr: [
        params.stderr,
        `The ${params.backendName} wrapper process exceeded the PushPals execution deadline.`,
        timeoutDetail ? `Timeout detail: ${timeoutDetail}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: 124,
    };
  }

  const timeoutDetail = String(params.timeoutDetail ?? "").trim();
  const cleanedStderr = String(params.stderr ?? "")
    .replace(
      /\bopenai_codex interrupted by signal 15\b/gi,
      "OpenAI Codex exceeded the execution budget",
    )
    .trim();
  const stderr = [
    `OpenAI Codex exceeded the PushPals execution budget before returning a completed result.`,
    timeoutDetail ? `Timeout detail: ${timeoutDetail}.` : "",
    cleanedStderr ? `Last stderr:\n${cleanedStderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary: `${params.backendName} execution budget expired after ${params.timeoutMs}ms for ${params.kind}`,
    stdout: params.stdout,
    stderr,
    exitCode: 124,
  };
}

function appendExecutorFailureDetail(existing: string, detail: string): string {
  return [existing.trim(), detail.trim()].filter(Boolean).join("\n");
}

function genericExecutorBoundaryDiagnostics(params: {
  backendName: string;
  summary: string;
  failureClass: string;
  exitCode: number;
  timeoutMs: number;
  structuredResult: boolean;
  metadata?: Record<string, unknown>;
}): JobDiagnostics {
  return {
    terminal: {
      failureClass: params.failureClass,
      terminalStage: "executor",
      executorBackend: params.backendName,
      summary: params.summary,
      watchdogFired: params.failureClass === "timeout",
      timeoutMs: params.timeoutMs,
      metadata: {
        classificationOwner: "generic_python_executor",
        structuredResult: params.structuredResult,
        exitCode: params.exitCode,
        ...(params.metadata ?? {}),
      },
    },
  };
}

function workerOwnedInternalErrorDetail(error: unknown): string | null {
  const detail =
    error instanceof Error
      ? String(error.stack ?? `${error.name}: ${error.message}`).trim()
      : String(error ?? "").trim();
  if (!detail) return null;
  const firstFrame = detail.split(/\r?\n/).find((line) => /^\s*at\b/i.test(line));
  return isWorkerOwnedRuntimeStackFrame(firstFrame) ? detail : null;
}

export function createGenericPythonExecutor(
  config: GenericPythonExecutorConfig,
): BackendTaskExecutor {
  const { backendName } = config;
  const backendLabel = backendName[0].toUpperCase() + backendName.slice(1);

  return async (
    kind: string,
    params: Record<string, unknown>,
    repo: string,
    runtimeConfig: WorkerpalsRuntimeConfig,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number },
  ): Promise<JobResult> => {
    const resolvedScript = resolveGenericPythonExecutorScriptPath(config, runtimeConfig);
    const scriptPath = resolvedScript.scriptPath;
    if (scriptPath == null) {
      return {
        ok: false,
        summary: `${backendName} wrapper script not found`,
        stderr: `Checked wrapper script path(s): ${resolvedScript.candidates.join("; ")}`,
        exitCode: 1,
      };
    }

    const { pythonBin, timeoutMs: configuredTimeoutMs } = resolveRuntimeSettings(
      config,
      runtimeConfig,
    );
    const modelId = runtimeConfig.workerpals.llm.model.trim();
    const executionBudgetMs =
      typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs)
        ? Math.max(1, Math.floor(budgets.executionBudgetMs))
        : null;
    const finalizationBudgetMs =
      typeof budgets?.finalizationBudgetMs === "number" &&
      Number.isFinite(budgets.finalizationBudgetMs)
        ? Math.max(0, Math.floor(budgets.finalizationBudgetMs))
        : null;
    const timeoutMs = resolveGenericPythonExecutorTimeoutMs({
      configuredTimeoutMs,
      executionBudgetMs,
      finalizationBudgetMs,
      capTimeoutToExecutionBudget: config.capTimeoutToExecutionBudget,
    });
    const timeoutDetail = formatGenericPythonExecutorTimeoutDetail(
      config,
      configuredTimeoutMs,
      executionBudgetMs,
      finalizationBudgetMs,
      timeoutMs,
    );
    const payloadBase64 = Buffer.from(
      JSON.stringify({
        kind,
        params,
        repo,
      }),
      "utf-8",
    ).toString("base64");
    const childTimeoutMs = resolveGenericPythonExecutorChildTimeoutMs({
      backendName,
      hostTimeoutMs: timeoutMs,
      executionBudgetMs,
    });
    const childTimeoutEnv =
      childTimeoutMs == null
        ? {}
        : {
            WORKERPALS_OPENAI_CODEX_TIMEOUT_MS: String(childTimeoutMs),
            WORKERPALS_OPENAI_CODEX_TIMEOUT_S: String(
              Math.max(1, Math.floor(childTimeoutMs / 1000)),
            ),
          };
    const childTimeoutDetail =
      childTimeoutMs != null
        ? `; codex_child_timeout=${childTimeoutMs}ms; reserved_validation_budget=${resolveOpenAICodexValidationReserveMs(
            executionBudgetMs,
          )}ms`
        : "";

    let payloadTransport: PythonPayloadTransport | null = null;
    try {
      payloadTransport = createPythonPayloadTransport(payloadBase64);
      const args = [pythonBin, scriptPath, ...payloadTransport.args];
      onLog?.(
        "stdout",
        `[${backendLabel}Executor] Spawning ${backendName} executor (timeout=${timeoutMs}ms; ${timeoutDetail}${childTimeoutDetail})`,
      );

      const outputPolicy = {
        maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
        maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
        maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
        executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix,
      };
      const progressIntervalMs = Math.max(1, Math.floor(config.progressIntervalMs ?? 15_000));
      const startedAt = Date.now();
      let sawProcessOutput = false;
      // This state must exist before the interval starts. The bounded process can
      // remain quiet for many minutes, so its first progress tick is a production
      // execution path rather than merely diagnostic logging.
      let timedOut = false;
      const progressTimer = setInterval(() => {
        if (timedOut || sawProcessOutput) return;
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        onLog?.(
          "stdout",
          `[${backendLabel}Executor] Still running (${Math.floor(
            elapsedMs / 1000,
          )}s elapsed); waiting for executor output...`,
        );
      }, progressIntervalMs);

      const onProcessLine = (stream: "stdout" | "stderr", line: string) => {
        if (!line.trim()) return;
        sawProcessOutput = true;
        if (stream === "stdout" && line.startsWith(outputPolicy.executorResultPrefix)) {
          return;
        }
        onLog?.(stream, line);
      };
      let processResult: Awaited<ReturnType<typeof runBoundedWorkerProcess>>;
      try {
        processResult = await (config.processRunner ?? runBoundedWorkerProcess)(args, {
          cwd: repo,
          env: {
            ...buildWorkerSandboxWritableEnv(repo),
            ...childTimeoutEnv,
            PUSHPALS_REPO_PATH: repo,
            PUSHPALS_ASSIGNED_REPO_ROOT: repo,
            PYTHONIOENCODING: "utf-8",
          },
          timeoutMs,
          outputLimitBytes: Math.max(
            64 * 1024,
            Math.min(4 * 1024 * 1024, runtimeConfig.workerpals.outputMaxChars),
          ),
          retainOutputTail: true,
          onStdoutLine: (line) => onProcessLine("stdout", line),
          onStderrLine: (line) => onProcessLine("stderr", line),
          onTimeout: () => {
            timedOut = true;
            onLog?.(
              "stdout",
              `[${backendLabel}Executor] Timeout reached after ${timeoutMs}ms; terminating process tree.`,
            );
          },
        });
      } finally {
        clearInterval(progressTimer);
      }

      timedOut = processResult.timedOut;
      const drainTimedOut = processResult.drainTimedOut === true;
      const stdout = processResult.stdout;
      const stderr = processResult.stderr;
      const exitCode = processResult.exitCode;

      const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
      const sawStructuredResultSentinel = hasStructuredResultSentinel(
        stdout,
        outputPolicy.executorResultPrefix,
      );
      const filteredStdout = filterResultLines(stdout, outputPolicy.executorResultPrefix);
      const fallbackUsage = estimateJobTokenUsage(
        backendName,
        modelId,
        params,
        "",
        filteredStdout,
        stderr,
      );

      if (!parsed) {
        if (timedOut) {
          const summary = `${backendName} wrapper timed out after ${timeoutMs}ms for ${kind}`;
          return {
            ok: false,
            summary,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(stderr, outputPolicy),
            exitCode: 124,
            usage: fallbackUsage,
            diagnostics: genericExecutorBoundaryDiagnostics({
              backendName,
              summary,
              failureClass: "timeout",
              exitCode: 124,
              timeoutMs,
              structuredResult: false,
              metadata: { processTimedOut: true },
            }),
          };
        }
        if (drainTimedOut) {
          const summary = `${backendName} wrapper process streams did not close after execution for ${kind}`;
          return {
            ok: false,
            summary,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(
              appendExecutorFailureDetail(
                stderr,
                "The wrapper process stream-drain deadline fired; discarded any incomplete result and terminated the process tree.",
              ),
              outputPolicy,
            ),
            exitCode: 124,
            usage: fallbackUsage,
            diagnostics: genericExecutorBoundaryDiagnostics({
              backendName,
              summary,
              failureClass: "timeout",
              exitCode: 124,
              timeoutMs,
              structuredResult: false,
              metadata: { streamDrainTimedOut: true },
            }),
          };
        }
        if (sawStructuredResultSentinel) {
          const summary = `${backendName} wrapper returned a malformed structured result for ${kind}`;
          const malformedDetail =
            "Malformed structured result: sentinel payload was not a JSON object or could not be parsed.";
          const malformedExitCode = exitCode === 0 ? 1 : exitCode;
          return {
            ok: false,
            summary,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(appendExecutorFailureDetail(stderr, malformedDetail), outputPolicy),
            exitCode: malformedExitCode,
            usage: fallbackUsage,
            diagnostics: genericExecutorBoundaryDiagnostics({
              backendName,
              summary,
              failureClass: "malformed_structured_result",
              exitCode: malformedExitCode,
              timeoutMs,
              structuredResult: true,
              metadata: { schemaValidationError: malformedDetail },
            }),
          };
        }
        const summary = `${backendName} wrapper did not return a structured result for ${kind}`;
        const missingExitCode = exitCode === 0 ? 1 : exitCode;
        return {
          ok: false,
          summary,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode: missingExitCode,
          usage: fallbackUsage,
          diagnostics: genericExecutorBoundaryDiagnostics({
            backendName,
            summary,
            failureClass: "no_structured_result",
            exitCode: missingExitCode,
            timeoutMs,
            structuredResult: false,
          }),
        };
      }

      const summary =
        typeof parsed.summary === "string"
          ? parsed.summary
          : exitCode === 0
            ? `${kind} passed via ${backendName}`
            : `${kind} failed via ${backendName} (exit ${exitCode})`;
      const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
      const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
      const usage = coerceJobTokenUsage(
        parsed.usage,
        estimateJobTokenUsage(backendName, modelId, params, summary, parsedStdout, parsedStderr),
      );
      const usageAttempts = coerceJobUsageAttempts(parsed.usageAttempts, backendName, modelId);
      const candidateState = coerceJobCandidateState(parsed.candidateState);
      const envelope = validateStructuredJobResultEnvelope(parsed);
      const malformedResult: JobResult | null = envelope.valid
        ? null
        : (() => {
            const malformedSummary = `${backendName} wrapper returned a malformed structured result for ${kind}`;
            const malformedExitCode = exitCode === 0 ? 1 : exitCode;
            return {
              ok: false,
              summary: malformedSummary,
              stdout: truncate(parsedStdout, outputPolicy),
              stderr: truncate(
                appendExecutorFailureDetail(
                  parsedStderr,
                  `Malformed structured result: ${envelope.detail}.`,
                ),
                outputPolicy,
              ),
              exitCode: malformedExitCode,
              usage,
              ...(usageAttempts ? { usageAttempts } : {}),
              diagnostics: genericExecutorBoundaryDiagnostics({
                backendName,
                summary: malformedSummary,
                failureClass: "malformed_structured_result",
                exitCode: malformedExitCode,
                timeoutMs,
                structuredResult: true,
                metadata: { schemaValidationError: envelope.detail },
              }),
            };
          })();
      const normalized = normalizeGenericPythonExecutorParsedResultForTimeout({
        backendName,
        kind,
        timedOut,
        timeoutMs,
        timeoutDetail,
        summary,
        stdout: parsedStdout,
        stderr: parsedStderr,
        exitCode: envelope.valid && envelope.exitCode !== undefined ? envelope.exitCode : exitCode,
      });

      if (timedOut) {
        return {
          ok: false,
          summary: normalized.summary,
          stdout: truncate(normalized.stdout, outputPolicy),
          stderr: truncate(normalized.stderr, outputPolicy),
          exitCode: 124,
          usage,
          ...(usageAttempts ? { usageAttempts } : {}),
          ...(candidateState ? { candidateState } : {}),
          diagnostics: genericExecutorBoundaryDiagnostics({
            backendName,
            summary: normalized.summary,
            failureClass: "timeout",
            exitCode: 124,
            timeoutMs,
            structuredResult: true,
            metadata: { processTimedOut: true },
          }),
        };
      }

      if (drainTimedOut) {
        const drainSummary = `${backendName} wrapper process streams did not close after returning a structured result for ${kind}`;
        return {
          ok: false,
          summary: drainSummary,
          stdout: truncate(normalized.stdout, outputPolicy),
          stderr: truncate(
            appendExecutorFailureDetail(
              normalized.stderr,
              "Discarded the structured result because the process stream-drain deadline fired and the process tree was terminated.",
            ),
            outputPolicy,
          ),
          exitCode: 124,
          usage,
          ...(usageAttempts ? { usageAttempts } : {}),
          ...(candidateState ? { candidateState } : {}),
          diagnostics: genericExecutorBoundaryDiagnostics({
            backendName,
            summary: drainSummary,
            failureClass: "timeout",
            exitCode: 124,
            timeoutMs,
            structuredResult: true,
            metadata: {
              streamDrainTimedOut: true,
              processStateOverrodeStructuredResult: true,
            },
          }),
        };
      }

      if (!envelope.valid) return malformedResult as JobResult;

      const parsedExitCode = envelope.exitCode ?? exitCode;
      const processExitedNonzero = exitCode !== 0;
      const structuredExitNonzero = parsedExitCode !== 0;
      const parsedOk = envelope.ok;
      let finalSummary = normalized.summary;
      let finalStderr = normalized.stderr;
      let finalExitCode = normalized.exitCode;

      if (!timedOut && processExitedNonzero) {
        finalExitCode = exitCode;
        if (parsedOk) {
          finalSummary = `${backendName} wrapper process exited ${exitCode} after returning a structured success result for ${kind}`;
          finalStderr = appendExecutorFailureDetail(
            finalStderr,
            `Discarded the structured ok=true result because the wrapper process exited with code ${exitCode}.`,
          );
        }
      } else if (!timedOut && parsedOk && structuredExitNonzero) {
        finalSummary = `${backendName} wrapper returned exit ${parsedExitCode} with a structured success result for ${kind}`;
        finalStderr = appendExecutorFailureDetail(
          finalStderr,
          `Discarded the structured ok=true result because its exitCode was ${parsedExitCode}.`,
        );
        finalExitCode = parsedExitCode;
      }

      return {
        ok: parsedOk && !timedOut && !processExitedNonzero && !structuredExitNonzero,
        summary: finalSummary,
        stdout: truncate(normalized.stdout, outputPolicy),
        stderr: truncate(finalStderr, outputPolicy),
        exitCode: finalExitCode,
        usage,
        ...(usageAttempts ? { usageAttempts } : {}),
        ...(candidateState ? { candidateState } : {}),
      };
    } catch (err) {
      const internalErrorDetail = workerOwnedInternalErrorDetail(err);
      if (internalErrorDetail) {
        const summary = `WorkerPal internal runtime failure in ${backendName} executor for ${kind}`;
        return {
          ok: false,
          summary,
          stderr: internalErrorDetail,
          exitCode: 1,
          usage: estimateJobTokenUsage(
            backendName,
            runtimeConfig.workerpals.llm.model.trim(),
            params,
            summary,
            "",
            internalErrorDetail,
          ),
          diagnostics: {
            terminal: {
              failureClass: "worker_runtime_failure",
              terminalStage: "worker_runtime",
              executorBackend: backendName,
              summary: internalErrorDetail.split(/\r?\n/, 1)[0] || summary,
              watchdogFired: false,
              metadata: {
                caughtBy: "generic_python_executor",
                jobKind: kind,
              },
            },
          },
        };
      }
      return {
        ok: false,
        summary: `${backendName} wrapper execution error for ${kind}: ${String(err)}`,
        exitCode: 1,
        usage: estimateJobTokenUsage(
          backendName,
          runtimeConfig.workerpals.llm.model.trim(),
          params,
          `${backendName} wrapper execution error for ${kind}: ${String(err)}`,
          "",
          "",
        ),
      };
    } finally {
      payloadTransport?.cleanup();
    }
  };
}
