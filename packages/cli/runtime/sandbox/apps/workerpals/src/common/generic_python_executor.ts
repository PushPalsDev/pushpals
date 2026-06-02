/**
 * Factory for a generic Python-wrapper backend task executor.
 *
 * Backends that don't need specialized streaming/stuck-guard logic can use
 * this as their taskExecute implementation. It spawns the backend's Python
 * script, applies timeout + budget capping, and parses the structured
 * sentinel result.
 */

import { existsSync } from "fs";
import { resolve } from "path";
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

interface GenericPythonExecutorConfig {
  backendName: string;
  scriptPath: string;
  pythonConfigKey: string;
  timeoutConfigKey: string;
  capTimeoutToExecutionBudget?: boolean;
}

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
  capTimeoutToExecutionBudget?: boolean;
}): number {
  const configuredTimeoutMs = Math.max(10_000, Math.floor(params.configuredTimeoutMs));
  const executionBudgetMs =
    typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs)
      ? Math.max(10_000, Math.floor(params.executionBudgetMs))
      : null;
  if (executionBudgetMs != null && params.capTimeoutToExecutionBudget !== false) {
    return Math.min(configuredTimeoutMs, executionBudgetMs);
  }
  return configuredTimeoutMs;
}

function toSnakeConfigKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function formatGenericPythonExecutorTimeoutDetail(
  config: GenericPythonExecutorConfig,
  configuredTimeoutMs: number,
  executionBudgetMs: number | null,
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
    return `${configPath}=${configuredTimeoutMs}ms capped by planning executionBudgetMs=${executionBudgetMs}ms`;
  }
  return `${configPath}=${configuredTimeoutMs}ms within planning executionBudgetMs=${executionBudgetMs}ms`;
}

export function createGenericPythonExecutor(
  config: GenericPythonExecutorConfig,
): BackendTaskExecutor {
  const { backendName, scriptPath } = config;
  const backendLabel = backendName[0].toUpperCase() + backendName.slice(1);

  return async (
    kind: string,
    params: Record<string, unknown>,
    repo: string,
    runtimeConfig: WorkerpalsRuntimeConfig,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number },
  ): Promise<JobResult> => {
    if (!existsSync(scriptPath)) {
      return {
        ok: false,
        summary: `${backendName} wrapper script not found: ${scriptPath}`,
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
    const timeoutMs = resolveGenericPythonExecutorTimeoutMs({
      configuredTimeoutMs,
      executionBudgetMs,
      capTimeoutToExecutionBudget: config.capTimeoutToExecutionBudget,
    });
    const timeoutDetail = formatGenericPythonExecutorTimeoutDetail(
      config,
      configuredTimeoutMs,
      executionBudgetMs,
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
    const args = [pythonBin, scriptPath, payloadBase64];

    onLog?.(
      "stdout",
      `[${backendLabel}Executor] Spawning ${backendName} executor (timeout=${timeoutMs}ms; ${timeoutDetail})`,
    );

    try {
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

      return {
        ok: typeof parsed.ok === "boolean" ? parsed.ok : exitCode === 0,
        summary,
        stdout: truncate(parsedStdout, outputPolicy),
        stderr: truncate(parsedStderr, outputPolicy),
        exitCode:
          typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
            ? parsed.exitCode
            : exitCode,
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
    }
  };
}
