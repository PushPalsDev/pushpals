/**
 * OpenHands specialized task executor.
 *
 * Provides streaming line-by-line processing with stuck-guard detection,
 * auto-steering nudges, activity-based timeout extension, and
 * clarification/no-change detection.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import type { JobResult, JobTokenUsage } from "../common/types.js";
import type { WorkerpalsRuntimeConfig } from "../common/executor_backend.js";
import {
  truncate,
  streamLines,
  parseStructuredResult,
  filterResultLines,
} from "../common/execution_utils.js";
import { buildWorkerSandboxWritableEnv } from "../common/sandbox_env.js";
import {
  createPythonPayloadTransport,
  type PythonPayloadTransport,
} from "../common/python_payload_transport.js";
import { computeTimeoutWarningWindow } from "../timeout_policy.js";

// ---- Script path (resolved relative to this file) ----------------------------

const OPENHANDS_SCRIPT_PATH = resolve(import.meta.dir, "openhands", "openhands_executor.py");

// ---- OpenHands-specific helpers ----------------------------------------------

function estimateTokensFromText(text: string): number {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}

function estimateJobTokenUsage(
  runtimeConfig: WorkerpalsRuntimeConfig,
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
    backend: "openhands",
    modelId: runtimeConfig.workerpals.llm.model.trim(),
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

function classifyShellCommand(cmd: string): "explore" | "progress" {
  const trimmed = cmd.trim().toLowerCase();
  if (!trimmed) return "explore";
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  if (
    token === "ls" ||
    token === "find" ||
    token === "rg" ||
    token === "grep" ||
    token === "cat" ||
    token === "head" ||
    token === "tail" ||
    token === "sed" ||
    token === "awk"
  ) {
    return "explore";
  }
  if (token === "git") {
    if (
      /\bgit\s+(status|log|show|diff|branch|rev-parse|ls-files)\b/.test(trimmed) ||
      /\bgit\s+grep\b/.test(trimmed)
    ) {
      return "explore";
    }
  }
  return "progress";
}

function classifyFileEditorSummary(line: string): "explore" | "progress" | null {
  const lowered = line.toLowerCase();
  if (!lowered.startsWith("summary: file_editor")) return null;
  if (
    lowered.includes('"command": "view"') ||
    lowered.includes('"command":"view"') ||
    lowered.includes('"command": "list"') ||
    lowered.includes('"command":"list"')
  ) {
    return "explore";
  }
  if (
    lowered.includes('"command": "create"') ||
    lowered.includes('"command":"create"') ||
    lowered.includes('"command": "str_replace"') ||
    lowered.includes('"command":"str_replace"') ||
    lowered.includes('"command": "insert"') ||
    lowered.includes('"command":"insert"') ||
    lowered.includes('"command": "delete"') ||
    lowered.includes('"command":"delete"')
  ) {
    return "progress";
  }
  return null;
}

const OPENHANDS_NO_CHANGE_SIGNAL = ["no file changes detected", "no modified files were detected"];

const CLARIFICATION_SIGNAL_REGEX =
  /\b(clarif(?:y|ication)|need to know which|could you clarify|please clarify|which .* would you like|let me ask for clarification)\b/i;

const NON_AGENT_LOG_LINE_REGEX =
  /^(message from user|requested task:|tokens:|summary:|observation|tool:|result:|\$ )/i;

function hasOpenHandsNoChangeSignal(text: string): boolean {
  const lowered = text.toLowerCase();
  return OPENHANDS_NO_CHANGE_SIGNAL.some((token) => lowered.includes(token));
}

function normalizeAgentOutputLine(line: string): string {
  return line
    .replace(/^\[[^\]]+\]\s*/g, "")
    .replace(/<\/?think>/gi, " ")
    .replace(/```+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractClarificationQuestionFromOutput(output: string): string | null {
  if (!output.trim()) return null;

  const rawLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) return null;

  const markerIndex = rawLines.findIndex((line) => /message from agent/i.test(line));
  const scopedLines = markerIndex >= 0 ? rawLines.slice(markerIndex + 1) : rawLines;
  const lines = scopedLines
    .map(normalizeAgentOutputLine)
    .filter((line) => Boolean(line) && !NON_AGENT_LOG_LINE_REGEX.test(line));
  if (lines.length === 0) return null;

  const joined = lines.join("\n");
  if (!CLARIFICATION_SIGNAL_REGEX.test(joined)) return null;

  const explicitQuestion = [...lines].reverse().find((line) => line.includes("?"));
  if (explicitQuestion) return explicitQuestion.slice(0, 280);

  const fallback = [...lines].reverse().find((line) => CLARIFICATION_SIGNAL_REGEX.test(line));
  return fallback ? fallback.slice(0, 280) : null;
}

// ---- Main executor -----------------------------------------------------------

export async function executeWithOpenHands(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  runtimeConfig: WorkerpalsRuntimeConfig,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
  budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number },
): Promise<JobResult> {
  const pythonBin = runtimeConfig.workerpals.openhandsPython || "python";
  const scriptPath = OPENHANDS_SCRIPT_PATH;
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      summary: `OpenHands wrapper script not found: ${scriptPath}`,
      exitCode: 1,
    };
  }

  const configuredTimeoutMs = Math.max(10_000, runtimeConfig.workerpals.openhandsTimeoutMs);
  const executionBudgetMs =
    typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs)
      ? Math.max(10_000, Math.floor(budgets.executionBudgetMs))
      : null;
  const timeoutMs =
    executionBudgetMs != null
      ? Math.min(configuredTimeoutMs, executionBudgetMs)
      : configuredTimeoutMs;
  const timeoutLimitSource =
    executionBudgetMs == null
      ? `workerpals.openhands_timeout_ms=${configuredTimeoutMs}ms`
      : executionBudgetMs < configuredTimeoutMs
        ? `planning executionBudgetMs=${executionBudgetMs}ms (worker cap=${configuredTimeoutMs}ms)`
        : executionBudgetMs > configuredTimeoutMs
          ? `workerpals.openhands_timeout_ms=${configuredTimeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms)`
          : `planning executionBudgetMs=${executionBudgetMs}ms (matches worker cap)`;
  if (executionBudgetMs != null && executionBudgetMs < configuredTimeoutMs) {
    onLog?.(
      "stdout",
      `[OpenHandsExecutor] Capping execution timeout to ${timeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms, worker cap=${configuredTimeoutMs}ms).`,
    );
  } else if (executionBudgetMs != null && executionBudgetMs > configuredTimeoutMs) {
    onLog?.(
      "stdout",
      `[OpenHandsExecutor] Capping execution timeout to ${timeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms, configured cap=${configuredTimeoutMs}ms).`,
    );
  }
  const { leadMs: timeoutWarningLeadMs, delayMs: timeoutWarningDelayMs } =
    computeTimeoutWarningWindow(timeoutMs);
  const finalizationBudgetMs =
    typeof budgets?.finalizationBudgetMs === "number" &&
    Number.isFinite(budgets.finalizationBudgetMs)
      ? Math.max(10_000, Math.floor(budgets.finalizationBudgetMs))
      : 0;
  const activityExtensionMs = Math.min(finalizationBudgetMs, 10 * 60_000);
  const activityWindowMs = 90_000;
  const payload = Buffer.from(
    JSON.stringify({
      kind,
      params,
      repo,
      timeoutMs,
      executionBudgetMs: executionBudgetMs ?? undefined,
      finalizationBudgetMs: finalizationBudgetMs > 0 ? finalizationBudgetMs : undefined,
    }),
    "utf-8",
  ).toString("base64");

  let warningTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckNudgeStartTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckNudgeTimer: ReturnType<typeof setInterval> | null = null;
  let payloadTransport: PythonPayloadTransport | null = null;
  const outputPolicy = {
    maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
    maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
    maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
    executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix,
  };

  try {
    payloadTransport = createPythonPayloadTransport(payload);
    const proc = Bun.spawn([pythonBin, scriptPath, ...payloadTransport.args], {
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
    const startedAtMs = Date.now();
    let lastActivityAtMs = startedAtMs;
    let timeoutDeadlineMs = startedAtMs + timeoutMs;
    let extendedByActivityMs = 0;
    let timedOutAfterMs = timeoutMs;
    const stuckGuardEnabled = runtimeConfig.workerpals.openhandsStuckGuardEnabled;
    const stuckExploreLimit = runtimeConfig.workerpals.openhandsStuckGuardExploreLimit;
    const stuckMinElapsedMs = runtimeConfig.workerpals.openhandsStuckGuardMinElapsedMs;
    const stuckBroadScanLimit = runtimeConfig.workerpals.openhandsStuckGuardBroadScanLimit;
    const stuckNoProgressMaxMs = runtimeConfig.workerpals.openhandsStuckGuardNoProgressMaxMs;
    const stuckNudgeEnabled = runtimeConfig.workerpals.openhandsAutoSteerEnabled;
    const stuckNudgeInitialDelayMs = Math.max(
      0,
      Math.floor(runtimeConfig.workerpals.openhandsAutoSteerInitialDelaySec * 1000),
    );
    const stuckNudgeIntervalMs = Math.max(
      5_000,
      Math.floor(runtimeConfig.workerpals.openhandsAutoSteerIntervalSec * 1000),
    );
    const stuckNudgeMaxCount = Math.max(0, runtimeConfig.workerpals.openhandsAutoSteerMaxNudges);
    let exploreOps = 0;
    let progressOps = 0;
    let broadRepoScans = 0;
    let stuckGuardTriggered = false;
    let stuckGuardReason = "";
    let stuckGuardAfterMs = 0;
    let stuckNudgeCount = 0;

    const stopStuckNudges = (reason?: string) => {
      const hadActiveTimer = Boolean(stuckNudgeStartTimer || stuckNudgeTimer);
      if (stuckNudgeStartTimer) {
        clearTimeout(stuckNudgeStartTimer);
        stuckNudgeStartTimer = null;
      }
      if (stuckNudgeTimer) {
        clearInterval(stuckNudgeTimer);
        stuckNudgeTimer = null;
      }
      if (reason && hadActiveTimer) {
        onLog?.("stdout", `[OpenHandsExecutor] Auto-steering nudges paused: ${reason}.`);
      }
    };

    const buildSteeringNudge = (nudgeIndex: number): string => {
      if (nudgeIndex === 1) {
        return (
          "Auto-steering nudge 1: stop broad exploration and lock onto one concrete target file. " +
          "Make one minimal edit and run one focused validation command."
        );
      }
      if (nudgeIndex === 2) {
        return (
          "Auto-steering nudge 2: choose the best candidate file now, apply a small correct patch, " +
          "then run a narrow test/lint command for that change."
        );
      }
      return (
        "Auto-steering nudge: if still blocked, stop scanning loops and return concise blocker status " +
        "with the next concrete command you would run."
      );
    };

    const startStuckNudges = () => {
      if (!stuckNudgeEnabled || stuckNudgeMaxCount <= 0) return;
      if (stuckNudgeStartTimer || stuckNudgeTimer) return;

      const emitNudge = () => {
        if (timedOut) {
          stopStuckNudges();
          return;
        }
        if (progressOps > 0) {
          stopStuckNudges("progress detected");
          return;
        }
        stuckNudgeCount += 1;
        const elapsedMs = Date.now() - startedAtMs;
        onLog?.(
          "stdout",
          `[OpenHandsExecutor] Auto-steering nudge ${stuckNudgeCount}/${stuckNudgeMaxCount} after ${elapsedMs}ms (${stuckGuardReason || "no edit/test progress"}): ${buildSteeringNudge(stuckNudgeCount)}`,
        );
        if (stuckNudgeCount >= stuckNudgeMaxCount) {
          stopStuckNudges();
        }
      };

      const startInterval = () => {
        if (stuckNudgeTimer || stuckNudgeCount >= stuckNudgeMaxCount) return;
        stuckNudgeTimer = setInterval(emitNudge, stuckNudgeIntervalMs);
      };

      if (stuckNudgeInitialDelayMs <= 0) {
        emitNudge();
        startInterval();
        return;
      }

      stuckNudgeStartTimer = setTimeout(() => {
        stuckNudgeStartTimer = null;
        emitNudge();
        startInterval();
      }, stuckNudgeInitialDelayMs);
    };

    const onProcessLine = (stream: "stdout" | "stderr", line: string) => {
      lastActivityAtMs = Date.now();
      const trimmed = line.trim();
      if (trimmed.startsWith("$ ")) {
        const commandText = trimmed.slice(2).trim();
        if (classifyShellCommand(commandText) === "explore") {
          exploreOps += 1;
        } else {
          progressOps += 1;
        }
        const lowered = commandText.toLowerCase();
        if (/\bfind\s+\/repo\b/.test(lowered) || /\bfind\s+\/\b/.test(lowered)) {
          broadRepoScans += 1;
        }
      }
      const fileEditorClass = classifyFileEditorSummary(trimmed);
      if (fileEditorClass === "explore") exploreOps += 1;
      if (fileEditorClass === "progress") progressOps += 1;
      if (stuckGuardTriggered && progressOps > 0) {
        stopStuckNudges("progress detected");
      }

      if (!stuckGuardTriggered && stuckGuardEnabled && progressOps === 0) {
        const elapsedMs = Date.now() - startedAtMs;
        const noProgressTooLong = elapsedMs >= stuckNoProgressMaxMs;
        const tooManyExplores = elapsedMs >= stuckMinElapsedMs && exploreOps >= stuckExploreLimit;
        const tooManyBroadScans = broadRepoScans >= stuckBroadScanLimit;
        if (noProgressTooLong || tooManyExplores || tooManyBroadScans) {
          stuckGuardTriggered = true;
          stuckGuardAfterMs = elapsedMs;
          if (tooManyBroadScans) {
            stuckGuardReason = `repeated broad filesystem scans (count=${broadRepoScans}) with no edits/tests`;
          } else if (tooManyExplores) {
            stuckGuardReason = `repeated exploratory actions (count=${exploreOps}) with no edits/tests`;
          } else {
            stuckGuardReason = `no edit/test progress for ${stuckNoProgressMaxMs}ms`;
          }
          onLog?.(
            "stdout",
            `[OpenHandsExecutor] Stuck guard triggered after ${stuckGuardAfterMs}ms: ${stuckGuardReason}. Steering hint: stop broad exploration, pick a concrete target file, make a minimal edit, then run a focused validation command.`,
          );
          startStuckNudges();
        }
      }
      onLog?.(stream, line);
    };

    const resetWarningTimer = () => {
      if (warningTimer) {
        clearTimeout(warningTimer);
        warningTimer = null;
      }
      const msUntilWarn = timeoutDeadlineMs - Date.now() - timeoutWarningLeadMs;
      if (msUntilWarn <= 0) return;
      warningTimer = setTimeout(() => {
        onLog?.(
          "stdout",
          `[OpenHandsExecutor] Timeout approaching for ${kind} (${Math.round(
            timeoutWarningLeadMs / 1000,
          )}s remaining). If unfinished, return a concise status/failure update now.`,
        );
      }, msUntilWarn);
    };

    const resetTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const msUntilTimeout = Math.max(1, timeoutDeadlineMs - Date.now());
      timeoutTimer = setTimeout(() => {
        const nowMs = Date.now();
        const quietForMs = nowMs - lastActivityAtMs;
        if (
          extendedByActivityMs === 0 &&
          activityExtensionMs > 0 &&
          quietForMs <= activityWindowMs
        ) {
          extendedByActivityMs = activityExtensionMs;
          timeoutDeadlineMs = nowMs + activityExtensionMs;
          onLog?.(
            "stdout",
            `[OpenHandsExecutor] Extending timeout by ${activityExtensionMs}ms because the agent is still active (last output ${Math.round(
              quietForMs / 1000,
            )}s ago).`,
          );
          resetWarningTimer();
          resetTimeoutTimer();
          return;
        }

        timedOut = true;
        timedOutAfterMs = Math.max(1, nowMs - startedAtMs);
        onLog?.(
          "stdout",
          `[OpenHandsExecutor] Timeout reached for ${kind} after ${timedOutAfterMs}ms (effective limit: ${timeoutLimitSource}${
            extendedByActivityMs > 0 ? ` + activity extension ${extendedByActivityMs}ms` : ""
          }); terminating wrapper process.`,
        );
        stopStuckNudges();
        try {
          proc.kill();
        } catch (_e) {}
      }, msUntilTimeout);
    };

    resetWarningTimer();
    resetTimeoutTimer();

    const [stdout, stderr] = await Promise.all([
      streamLines(proc.stdout, "stdout", onProcessLine),
      streamLines(proc.stderr, "stderr", onProcessLine),
    ]);
    if (warningTimer) {
      clearTimeout(warningTimer);
      warningTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    stopStuckNudges();
    const exitCode = await proc.exited;

    const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
    const filteredStdout = filterResultLines(stdout, outputPolicy.executorResultPrefix);
    const fallbackUsage = estimateJobTokenUsage(runtimeConfig, params, "", filteredStdout, stderr);

    if (!parsed) {
      if (timedOut) {
        const stuckNote = stuckGuardTriggered
          ? ` Stuck guard warning was raised at ${stuckGuardAfterMs}ms (${stuckGuardReason}).`
          : "";
        return {
          ok: false,
          summary: `OpenHands wrapper timed out after ${timedOutAfterMs}ms for ${kind} (effective limit: ${timeoutLimitSource}${
            extendedByActivityMs > 0 ? ` + activity extension ${extendedByActivityMs}ms` : ""
          }). Worker returned a timeout failure.${stuckNote}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode: exitCode === 0 ? 124 : exitCode,
          usage: fallbackUsage,
        };
      }
      return {
        ok: false,
        summary: `OpenHands wrapper did not return a structured result for ${kind}`,
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
          ? `${kind} passed via OpenHands`
          : `${kind} failed via OpenHands (exit ${exitCode})`;
    const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
    const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
    const usage = coerceJobTokenUsage(
      parsed.usage,
      estimateJobTokenUsage(runtimeConfig, params, summary, parsedStdout, parsedStderr),
    );
    const parsedExitCode =
      typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
        ? parsed.exitCode
        : exitCode;
    const parsedOk = typeof parsed.ok === "boolean" ? parsed.ok : parsedExitCode === 0;
    const noChangeResult =
      parsedOk &&
      (hasOpenHandsNoChangeSignal(summary) ||
        hasOpenHandsNoChangeSignal(String(parsedStdout ?? "")) ||
        hasOpenHandsNoChangeSignal(String(parsedStderr ?? "")));
    if (noChangeResult) {
      const clarificationQuestion = extractClarificationQuestionFromOutput(filteredStdout);
      if (clarificationQuestion) {
        return {
          ok: true,
          summary: `OpenHands needs clarification: ${clarificationQuestion}`,
          stdout: truncate(filteredStdout || String(parsedStdout ?? ""), outputPolicy),
          stderr: truncate(`Clarification needed: ${clarificationQuestion}`, outputPolicy),
          exitCode: 0,
          usage,
        };
      }
    }

    return {
      ok: parsedOk,
      summary,
      stdout: truncate(parsedStdout ?? "", outputPolicy),
      stderr: truncate(parsedStderr ?? "", outputPolicy),
      exitCode: parsedExitCode,
      usage,
    };
  } catch (err) {
    return {
      ok: false,
      summary: `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
      exitCode: 1,
      usage: estimateJobTokenUsage(
        runtimeConfig,
        params,
        `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
        "",
        "",
      ),
    };
  } finally {
    if (warningTimer) {
      clearTimeout(warningTimer);
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (stuckNudgeStartTimer) {
      clearTimeout(stuckNudgeStartTimer);
    }
    if (stuckNudgeTimer) {
      clearInterval(stuckNudgeTimer);
    }
    payloadTransport?.cleanup();
  }
}
