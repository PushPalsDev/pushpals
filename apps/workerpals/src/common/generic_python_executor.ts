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
import type { JobResult } from "./types.js";
import type { WorkerpalsRuntimeConfig } from "./executor_backend.js";
import type { BackendTaskExecutor } from "../backends/types.js";
import { EXECUTOR_RESULT_PREFIX } from "./constants.js";
import { truncate, parseStructuredResult, filterResultLines } from "./execution_utils.js";

interface GenericPythonExecutorConfig {
  backendName: string;
  scriptPath: string;
  pythonConfigKey: string;
  timeoutConfigKey: string;
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
    const executionBudgetMs =
      typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs)
        ? Math.max(10_000, Math.floor(budgets.executionBudgetMs))
        : null;
    const timeoutMs =
      executionBudgetMs != null
        ? Math.min(configuredTimeoutMs, executionBudgetMs)
        : configuredTimeoutMs;
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
      `[${backendLabel}Executor] Spawning ${backendName} executor (timeout=${timeoutMs}ms)`,
    );

    try {
      const proc = Bun.spawn(args, {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PUSHPALS_REPO_PATH: repo,
          PUSHPALS_ASSIGNED_REPO_ROOT: repo,
          PYTHONIOENCODING: "utf-8",
        },
      });

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        onLog?.(
          "stdout",
          `[${backendLabel}Executor] Timeout reached after ${timeoutMs}ms; terminating process.`,
        );
        proc.kill();
      }, timeoutMs);

      const [rawStdout, rawStderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      clearTimeout(timeoutTimer);

      const stdout = rawStdout ?? "";
      const stderr = rawStderr ?? "";

      for (const line of stdout.split(/\r?\n/)) {
        if (line.trim() && !line.startsWith(EXECUTOR_RESULT_PREFIX)) {
          onLog?.("stdout", line);
        }
      }
      for (const line of stderr.split(/\r?\n/)) {
        if (line.trim()) onLog?.("stderr", line);
      }

      const parsed = parseStructuredResult(stdout);
      const filteredStdout = filterResultLines(stdout);

      if (!parsed) {
        if (timedOut) {
          return {
            ok: false,
            summary: `${backendName} wrapper timed out after ${timeoutMs}ms for ${kind}`,
            stdout: truncate(filteredStdout),
            stderr: truncate(stderr),
            exitCode: exitCode === 0 ? 124 : exitCode,
          };
        }
        return {
          ok: false,
          summary: `${backendName} wrapper did not return a structured result for ${kind}`,
          stdout: truncate(filteredStdout),
          stderr: truncate(stderr),
          exitCode,
        };
      }

      return {
        ok: typeof parsed.ok === "boolean" ? parsed.ok : exitCode === 0,
        summary:
          typeof parsed.summary === "string"
            ? parsed.summary
            : exitCode === 0
              ? `${kind} passed via ${backendName}`
              : `${kind} failed via ${backendName} (exit ${exitCode})`,
        stdout: truncate(typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout),
        stderr: truncate(typeof parsed.stderr === "string" ? parsed.stderr : stderr),
        exitCode:
          typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
            ? parsed.exitCode
            : exitCode,
      };
    } catch (err) {
      return {
        ok: false,
        summary: `${backendName} wrapper execution error for ${kind}: ${String(err)}`,
        exitCode: 1,
      };
    }
  };
}
