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
import type { JobResult, JobTokenUsage } from "./types.js";
import type { WorkerpalsRuntimeConfig } from "./executor_backend.js";
import type { BackendTaskExecutor } from "../backends/types.js";
import {
  truncate,
  parseStructuredResult,
  filterResultLines,
  streamLines,
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
}

const BACKEND_TIMEOUT_RESULT_GRACE_MS = 30_000;
const OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS = 180_000;
const OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS = 600_000;
const OPENAI_CODEX_MIN_PRIMARY_TURN_BUDGET_MS = 600_000;

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
      ? Math.max(10_000, Math.floor(params.executionBudgetMs))
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
  const budgetMs = Math.max(10_000, Math.floor(executionBudgetMs));
  const targetReserveMs = Math.floor(
    Math.min(
      budgetMs,
      Math.max(
        OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS,
        Math.min(OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS, budgetMs * 0.35),
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
  const hostTimeoutMs = Math.max(10_000, Math.floor(params.hostTimeoutMs));
  if (params.backendName !== "openai_codex") return null;
  const executionBudgetMs =
    typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs)
      ? Math.max(10_000, Math.floor(params.executionBudgetMs))
      : null;
  const validationReserveMs = resolveOpenAICodexValidationReserveMs(executionBudgetMs);
  const childBudgetMs =
    executionBudgetMs == null
      ? hostTimeoutMs
      : Math.min(hostTimeoutMs, Math.max(1_000, executionBudgetMs - validationReserveMs));
  const graceMs = Math.min(
    BACKEND_TIMEOUT_RESULT_GRACE_MS,
    Math.max(2_000, Math.floor(childBudgetMs / 10)),
  );
  return Math.max(1_000, childBudgetMs - graceMs);
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
  const candidates = [config.scriptPath];
  if (config.scriptSegments && config.scriptSegments.length > 0) {
    const runtimeRoot = dirname(runtimeConfig.configDir);
    candidates.push(join(runtimeRoot, ...config.scriptSegments));
    candidates.push(join(runtimeConfig.projectRoot, ...config.scriptSegments));
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
  if (!signalTerminatedCodex) {
    return {
      summary: params.summary,
      stdout: params.stdout,
      stderr: params.stderr,
      exitCode: params.exitCode,
    };
  }

  const timeoutDetail = String(params.timeoutDetail ?? "").trim();
  const cleanedStderr = String(params.stderr ?? "")
    .replace(/\bopenai_codex interrupted by signal 15\b/gi, "OpenAI Codex exceeded the execution budget")
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
        ? Math.max(10_000, Math.floor(budgets.executionBudgetMs))
        : null;
    const finalizationBudgetMs =
      typeof budgets?.finalizationBudgetMs === "number" && Number.isFinite(budgets.finalizationBudgetMs)
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
      const proc = Bun.spawn(args, {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...buildWorkerSandboxWritableEnv(repo),
          ...childTimeoutEnv,
          PUSHPALS_REPO_PATH: repo,
          PUSHPALS_ASSIGNED_REPO_ROOT: repo,
          PYTHONIOENCODING: "utf-8",
        },
      });

      let timedOut = false;
      let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        onLog?.(
          "stdout",
          `[${backendLabel}Executor] Timeout reached after ${timeoutMs}ms; terminating process.`,
        );
        proc.kill();
        hardKillTimer = setTimeout(() => {
          onLog?.(
            "stdout",
            `[${backendLabel}Executor] Process did not exit after graceful timeout termination; forcing kill.`,
          );
          proc.kill("SIGKILL");
        }, 5_000);
      }, timeoutMs);

      const progressIntervalMs = 15_000;
      const startedAt = Date.now();
      let sawProcessOutput = false;
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

      const [rawStdout, rawStderr, exitCode] = await Promise.all([
        proc.stdout ? streamLines(proc.stdout, "stdout", onProcessLine) : Promise.resolve(""),
        proc.stderr ? streamLines(proc.stderr, "stderr", onProcessLine) : Promise.resolve(""),
        proc.exited,
      ]);

      clearTimeout(timeoutTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      clearInterval(progressTimer);

      const stdout = rawStdout ?? "";
      const stderr = rawStderr ?? "";

      const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
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
          return {
            ok: false,
            summary: `${backendName} wrapper timed out after ${timeoutMs}ms for ${kind}`,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(stderr, outputPolicy),
            exitCode: exitCode === 0 ? 124 : exitCode,
            usage: fallbackUsage,
          };
        }
        return {
          ok: false,
          summary: `${backendName} wrapper did not return a structured result for ${kind}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode,
          usage: fallbackUsage,
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
      const normalized = normalizeGenericPythonExecutorParsedResultForTimeout({
        backendName,
        kind,
        timedOut,
        timeoutMs,
        timeoutDetail,
        summary,
        stdout: parsedStdout,
        stderr: parsedStderr,
        exitCode:
          typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
            ? parsed.exitCode
            : exitCode,
      });

      return {
        ok: typeof parsed.ok === "boolean" ? parsed.ok : exitCode === 0,
        summary: normalized.summary,
        stdout: truncate(normalized.stdout, outputPolicy),
        stderr: truncate(normalized.stderr, outputPolicy),
        exitCode: normalized.exitCode,
        usage,
      };
    } catch (err) {
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
