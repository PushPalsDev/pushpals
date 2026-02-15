/**
 * Extracted job execution logic.
 * Used by both the host Worker (direct mode) and the Docker job runner.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { loadPromptTemplate, loadPushPalsConfig } from "shared";
import { computeTimeoutWarningWindow } from "./timeout_policy.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Job kinds that modify files and should trigger commits */
export const FILE_MODIFYING_JOBS = new Set(["task.execute"]);

const MAX_OUTPUT = 192 * 1024;
const MAX_OUTPUT_LINES = 600;
const MAX_OUTPUT_HEAD_LINES = 120;
const OPENHANDS_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
const CONFIG = loadPushPalsConfig();

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

const OPENHANDS_NO_CHANGE_SIGNAL = [
  "no file changes detected",
  "no modified files were detected",
];

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

// ─── Utilities ───────────────────────────────────────────────────────────────

export function shouldCommit(kind: string): boolean {
  return FILE_MODIFYING_JOBS.has(kind);
}

export function compactJobOutput(text: string): string {
  if (!text) return "";
  let compact = text;
  const lines = compact.split(/\r?\n/);
  if (lines.length > MAX_OUTPUT_LINES) {
    const headCount = Math.min(MAX_OUTPUT_HEAD_LINES, MAX_OUTPUT_LINES, lines.length);
    const tailBudget = Math.max(0, MAX_OUTPUT_LINES - headCount);
    const tailCount = Math.max(0, Math.min(lines.length - headCount, tailBudget));
    const omitted = Math.max(0, lines.length - headCount - tailCount);
    const marker = omitted > 0 ? [`... (${omitted} lines omitted) ...`] : [];
    const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
    compact = [...lines.slice(0, headCount), ...marker, ...tail].join("\n");
  }
  if (compact.length > MAX_OUTPUT) {
    const markerPrefix = "... (";
    const markerSuffix = " chars omitted) ...\n";
    const markerBudget = markerPrefix.length + markerSuffix.length + 20;
    if (markerBudget >= MAX_OUTPUT) {
      compact = compact.slice(-MAX_OUTPUT);
    } else {
      const keepChars = Math.max(0, MAX_OUTPUT - markerBudget);
      const omittedChars = Math.max(0, compact.length - keepChars);
      const marker = `${markerPrefix}${omittedChars}${markerSuffix}`;
      const tail = keepChars > 0 ? compact.slice(-keepChars) : "";
      compact = `${marker}${tail}`;
    }
  }
  return compact;
}

export function truncate(s: string): string {
  return compactJobOutput(s);
}

function inferTargetPathFromInstruction(text: string): string | null {
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!raw) continue;
    if (raw.includes("/") || raw.includes("\\") || raw.includes(".")) return raw;
  }
  return null;
}

function normalizeStagePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;
  path = path.replace(/\\/g, "/");

  // Convert common workspace-absolute prefixes to repo-relative paths.
  if (path === "/repo" || path === "/workspace") return ".";
  if (path.startsWith("/repo/")) path = path.slice("/repo/".length);
  else if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/")) path = path.replace(/^\/+/, "");

  path = path.replace(/^\.\//, "").trim();
  return path.length > 0 ? path : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeStagePath(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function summarizeRecentJobsForDoc(value: unknown, limit = 6): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const job = row as Record<string, unknown>;
    const kind = String(job.kind ?? "").trim();
    const status = String(job.status ?? "").trim();
    const summary = String(job.summary ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const error = String(job.error ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!kind && !status && !summary && !error) continue;
    const tail = summary || error;
    const entry = tail ? `- ${kind} [${status}]: ${tail}` : `- ${kind} [${status}]`;
    out.push(entry.slice(0, 220));
    if (out.length >= limit) break;
  }
  return out;
}

async function buildArchitectureDocument(
  repo: string,
  instruction: string,
  recentJobs: unknown,
): Promise<string> {
  const { readdirSync, readFileSync, statSync } = await import("fs");
  const { join } = await import("path");

  const ignore = new Set([
    ".git",
    "node_modules",
    "outputs",
    ".worktrees",
    "workspace",
    ".venv",
    "dist",
    "build",
  ]);

  const list = (dir: string, depth: number, prefix = ""): string[] => {
    if (depth < 0) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir).sort() as string[];
    } catch {
      return [];
    }

    const lines: string[] = [];
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".env.example") continue;
      if (ignore.has(name)) continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      lines.push(`${prefix}- ${name}${isDir ? "/" : ""}`);
      if (isDir && depth > 0 && lines.length < 120) {
        lines.push(...list(full, depth - 1, `${prefix}  `));
      }
      if (lines.length >= 120) break;
    }
    return lines;
  };

  const readmePath = join(repo, "README.md");
  let readmeExcerpt = "";
  try {
    readmeExcerpt = readFileSync(readmePath, "utf-8").slice(0, 2400).trim();
  } catch {
    readmeExcerpt = "";
  }

  const lines: string[] = [];
  lines.push("# Repository Architecture");
  lines.push("");
  lines.push(`Requested task: ${instruction}`);
  lines.push("");
  lines.push("## Top-level Structure");
  lines.push(...list(repo, 1));
  if (readmeExcerpt) {
    lines.push("");
    lines.push("## README Excerpt");
    lines.push(readmeExcerpt);
  }
  const jobSummaries = summarizeRecentJobsForDoc(recentJobs);
  if (jobSummaries.length > 0) {
    lines.push("");
    lines.push("## Recent Worker Job Context");
    lines.push(...jobSummaries);
  }
  lines.push("");
  lines.push(
    "Generated by worker task.execute from repository state. Review and refine as needed.",
  );

  return lines.join("\n").trim() + "\n";
}

function useOpenHandsExecutor(): boolean {
  const executor = CONFIG.workerpals.executor.trim().toLowerCase() || "openhands";
  if (executor !== "openhands") {
    console.warn(
      `[WorkerPals] Unsupported workerpals.executor="${executor}". Only "openhands" is supported.`,
    );
  }
  return true;
}

async function executeWithOpenHands(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
  budgets?: { executionBudgetMs?: number; finalizationBudgetMs?: number },
): Promise<JobResult> {
  const pythonBin = CONFIG.workerpals.openhandsPython || "python";
  const scriptPath = resolve(import.meta.dir, "..", "scripts", "openhands_executor.py");
  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      summary: `OpenHands wrapper script not found: ${scriptPath}`,
      exitCode: 1,
    };
  }

  const configuredTimeoutMs = Math.max(10_000, CONFIG.workerpals.openhandsTimeoutMs);
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
    typeof budgets?.finalizationBudgetMs === "number" && Number.isFinite(budgets.finalizationBudgetMs)
      ? Math.max(10_000, Math.floor(budgets.finalizationBudgetMs))
      : 0;
  // Allow one bounded extension when the agent is still actively emitting output.
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

  try {
    const proc = Bun.spawn([pythonBin, scriptPath, payload], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const startedAtMs = Date.now();
    let lastActivityAtMs = startedAtMs;
    let timeoutDeadlineMs = startedAtMs + timeoutMs;
    let extendedByActivityMs = 0;
    let timedOutAfterMs = timeoutMs;
    const stuckGuardEnabled = CONFIG.workerpals.openhandsStuckGuardEnabled;
    const stuckExploreLimit = CONFIG.workerpals.openhandsStuckGuardExploreLimit;
    const stuckMinElapsedMs = CONFIG.workerpals.openhandsStuckGuardMinElapsedMs;
    const stuckBroadScanLimit = CONFIG.workerpals.openhandsStuckGuardBroadScanLimit;
    const stuckNoProgressMaxMs = CONFIG.workerpals.openhandsStuckGuardNoProgressMaxMs;
    const stuckNudgeEnabled = CONFIG.workerpals.openhandsAutoSteerEnabled;
    const stuckNudgeInitialDelayMs = Math.max(
      0,
      Math.floor(CONFIG.workerpals.openhandsAutoSteerInitialDelaySec * 1000),
    );
    const stuckNudgeIntervalMs = Math.max(
      5_000,
      Math.floor(CONFIG.workerpals.openhandsAutoSteerIntervalSec * 1000),
    );
    const stuckNudgeMaxCount = Math.max(0, CONFIG.workerpals.openhandsAutoSteerMaxNudges);
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
        if (extendedByActivityMs === 0 && activityExtensionMs > 0 && quietForMs <= activityWindowMs) {
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

    const lines = stdout.split(/\r?\n/);
    let parsed: Record<string, unknown> | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith(OPENHANDS_RESULT_PREFIX)) continue;
      const raw = line.slice(OPENHANDS_RESULT_PREFIX.length).trim();
      if (!raw) continue;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (_e) {
        parsed = null;
      }
      break;
    }

    const filteredStdout = lines
      .filter((line) => !line.trim().startsWith(OPENHANDS_RESULT_PREFIX))
      .join("\n")
      .trim();

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
          stdout: truncate(filteredStdout),
          stderr: truncate(stderr),
          exitCode: exitCode === 0 ? 124 : exitCode,
        };
      }
      return {
        ok: false,
        summary: `OpenHands wrapper did not return a structured result for ${kind}`,
        stdout: truncate(filteredStdout),
        stderr: truncate(stderr),
        exitCode,
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
          ok: false,
          summary: "OpenHands requested clarification before making file changes",
          stdout: truncate(filteredStdout || String(parsedStdout ?? "")),
          stderr: truncate(`Clarification needed: ${clarificationQuestion}`),
          exitCode: 3,
        };
      }
    }

    return {
      ok: parsedOk,
      summary,
      stdout: truncate(parsedStdout ?? ""),
      stderr: truncate(parsedStderr ?? ""),
      exitCode: parsedExitCode,
    };
  } catch (err) {
    return {
      ok: false,
      summary: `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
      exitCode: 1,
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
  }
}

/** Execute a git command and return stdout */
export async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

// ─── Stream helper ───────────────────────────────────────────────────────────

/**
 * Read a process stream line-by-line, calling onLine for each.
 * Returns the full concatenated output.
 */
export async function streamLines(
  readable: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      onLine(streamName, clean);
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    onLine(streamName, clean);
  }

  return full;
}

// ─── Git commit creation ─────────────────────────────────────────────────────

/** Create commit for job result and return commit info */
export async function createJobCommit(
  repo: string,
  workerId: string,
  job: {
    id: string;
    taskId: string;
    kind: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    context?: "host" | "docker";
  },
): Promise<{ ok: boolean; branch?: string; sha?: string; error?: string }> {
  const requirePush = CONFIG.workerpals.requirePush;
  const pushAgentBranch = requirePush || CONFIG.workerpals.pushAgentBranch;
  const publicBranchName = `agent/${workerId}/${job.id}`;
  // Keep worker refs out of refs/heads so user-visible branch lists stay clean.
  const hiddenCommitRef = `refs/pushpals/agent/${workerId}/${job.id}`;
  const commitMsg = buildWorkerCommitMessage(workerId, job);
  let completionRef = hiddenCommitRef;
  let hiddenRefCreated = false;

  try {
    let result: { ok: boolean; stdout: string; stderr: string };

    // Stage only the paths implied by this job. This prevents runtime metadata
    // (e.g. workspace/bash_events/*) from being accidentally committed.
    const stageArgs = buildStageCommand(job.kind, job.params);
    if (!stageArgs) {
      return {
        ok: false,
        error: `Unable to determine files to stage for job kind: ${job.kind}`,
      };
    }
    result = await git(repo, stageArgs);
    if (!result.ok) {
      const stageErr = result.stderr || result.stdout;
      if (
        /pathspec .* did not match any files/i.test(stageErr) ||
        /invalid path/i.test(stageErr) ||
        /outside repository/i.test(stageErr)
      ) {
        console.warn(
          `[WorkerPals] Stage target invalid/missing for ${job.kind}; retrying with fallback "git add -A".`,
        );
        result = await git(repo, [
          "add",
          "-A",
          "--",
          ".",
          ":(exclude)workspace/**",
          ":(exclude)outputs/**",
        ]);
      }
      if (!result.ok) {
        return { ok: false, error: `Failed to stage changes: ${result.stderr || result.stdout}` };
      }
    }

    // Check if there are changes to commit
    result = await git(repo, ["diff", "--cached", "--quiet"]);
    if (result.ok) {
      // No changes to commit (diff exited 0)
      console.log(`[WorkerPals] No changes to commit for job ${job.id}`);
      return { ok: true, branch: hiddenCommitRef, sha: "no-changes" };
    }

    // Commit changes
    result = await git(repo, ["commit", "-m", commitMsg]);
    if (!result.ok) {
      return { ok: false, error: `Failed to commit: ${result.stderr}` };
    }

    // Get commit SHA
    result = await git(repo, ["rev-parse", "HEAD"]);
    if (!result.ok) {
      return { ok: false, error: `Failed to get commit SHA: ${result.stderr}` };
    }
    const sha = result.stdout;

    // Persist commit under an internal ref so it remains reachable after worktree cleanup.
    result = await git(repo, ["update-ref", hiddenCommitRef, sha]);
    if (!result.ok) {
      return { ok: false, error: `Failed to store worker commit ref: ${result.stderr}` };
    }
    hiddenRefCreated = true;

    // Push branch to origin (optional; disabled by default for shared-.git workflows)
    if (pushAgentBranch) {
      result = await git(repo, [
        "push",
        "origin",
        `${hiddenCommitRef}:refs/heads/${publicBranchName}`,
      ]);
      if (!result.ok) {
        const pushError = `Failed to push branch: ${result.stderr || result.stdout}`;
        if (requirePush) {
          if (hiddenRefCreated) {
            await git(repo, ["update-ref", "-d", hiddenCommitRef]);
          }
          return { ok: false, error: pushError };
        }
        console.warn(
          `[WorkerPals] ${pushError}. Continuing with local commit ref only (set WORKERPALS_REQUIRE_PUSH=1 to enforce push).`,
        );
        return { ok: true, branch: completionRef, sha };
      }
      completionRef = publicBranchName;
    } else {
      console.log(
        `[WorkerPals] Skipping push for ${publicBranchName} (WORKERPALS_PUSH_AGENT_BRANCH is disabled).`,
      );
    }

    console.log(`[WorkerPals] Created commit ${sha} on ref ${completionRef}`);
    return { ok: true, branch: completionRef, sha };
  } catch (err) {
    if (hiddenRefCreated) {
      await git(repo, ["update-ref", "-d", hiddenCommitRef]);
    }
    return { ok: false, error: String(err) };
  }
}

function toPath(value: unknown): string | null {
  return normalizeStagePath(value);
}

function dedupePaths(paths: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function buildStageTargets(kind: string, params?: Record<string, unknown>): string[] {
  const p = params ?? {};
  switch (kind) {
    case "task.execute": {
      const paths = toStringArray(p.paths);
      return dedupePaths([
        ...paths,
        toPath(p.targetPath),
        toPath(p.path),
        inferTargetPathFromInstruction(String(p.instruction ?? "")),
      ]);
    }
    default:
      return [];
  }
}

function buildStageCommand(kind: string, params?: Record<string, unknown>): string[] | null {
  const targets = buildStageTargets(kind, params);
  if (targets.length === 0) {
    if (kind === "task.execute") {
      return ["add", "-A", "--", ".", ":(exclude)workspace/**", ":(exclude)outputs/**"];
    }
    return null;
  }
  return ["add", "-A", "--", ...targets];
}

function sanitizeCommitValue(value: unknown, max = 140): string {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function normalizeCommitType(kind: string, params?: Record<string, unknown>): string {
  const raw = String(params?.commitType ?? params?.changeType ?? params?.type ?? "")
    .trim()
    .toLowerCase();

  const mapped =
    raw === "bugfix" || raw === "bug" || raw === "fix"
      ? "fix"
      : raw === "feature" || raw === "feat" || raw === "new"
        ? "feat"
        : raw === "docs" || raw === "doc"
          ? "docs"
          : raw === "refactor"
            ? "refactor"
            : raw === "chore"
              ? "chore"
              : "";
  if (mapped) return mapped;

  switch (kind) {
    case "file.patch":
      return "fix";
    case "file.delete":
    case "file.rename":
    case "file.copy":
    case "file.append":
    case "file.mkdir":
      return "refactor";
    default:
      return "feat";
  }
}

function normalizeCommitArea(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return cleaned || "worker";
}

function inferCommitArea(kind: string, params?: Record<string, unknown>): string {
  const explicit = String(params?.area ?? params?.scope ?? params?.component ?? "").trim();
  if (explicit) return normalizeCommitArea(explicit);

  const targets = buildStageTargets(kind, params);
  const pick = (prefix: string): boolean =>
    targets.some((path) => path.toLowerCase().startsWith(prefix.toLowerCase()));

  if (pick("scripts/start.ts") || pick(".env") || pick(".env.example")) return "startup";
  if (pick("apps/remotebuddy/")) return "remote_agent";
  if (pick("apps/localbuddy/")) return "local_agent";
  if (pick("apps/workerpals/")) return "worker";
  if (pick("apps/source_control_manager/")) return "source_control_manager";
  if (pick("apps/client/")) return "client";
  if (pick("apps/server/")) return "server";
  if (pick("README.md") || pick("docs/")) return "docs";
  return "worker";
}

function summarizeScope(kind: string, params?: Record<string, unknown>): string {
  const targets = buildStageTargets(kind, params);
  if (targets.length === 0) return "repository-level changes";
  const visible = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `${visible}, +${targets.length - 3} more` : visible;
}

function deriveSummary(action: string, params?: Record<string, unknown>): string {
  const explicit = sanitizeCommitValue(params?.commitSummary, 72);
  if (explicit) return explicit;
  const raw = sanitizeCommitValue(action, 72);
  if (!raw) return "apply requested repository update";
  return raw;
}

function buildImplementationPoints(kind: string, params?: Record<string, unknown>): string {
  const targets = buildStageTargets(kind, params);
  const lines: string[] = [];
  if (targets.length === 0) return "";

  for (const target of targets.slice(0, 5)) {
    lines.push(`- Updated path: ${sanitizeCommitValue(target, 220)}.`);
  }
  if (targets.length > 5) {
    lines.push(`- Updated path: +${targets.length - 5} additional file(s).`);
  }

  return lines.join("\n");
}

function summarizeJobAction(kind: string, params?: Record<string, unknown>): string {
  const p = params ?? {};
  const get = (key: string): string => sanitizeCommitValue(p[key]);

  switch (kind) {
    case "file.write":
      return `write ${get("path") || "<path>"}`;
    case "file.patch":
      return `patch ${get("path") || "<path>"}`;
    case "file.append":
      return `append ${get("path") || "<path>"}`;
    case "file.rename":
      return `rename ${get("from") || "<from>"} -> ${get("to") || "<to>"}`;
    case "file.copy":
      return `copy ${get("from") || "<from>"} -> ${get("to") || "<to>"}`;
    case "file.delete":
      return `delete ${get("path") || "<path>"}`;
    case "file.mkdir":
      return `mkdir ${get("path") || "<path>"}`;
    case "shell.exec":
      return `exec ${get("command") || "<command>"}`;
    case "bun.test":
      return get("filter") ? `test filter=${get("filter")}` : "run bun test";
    case "bun.lint":
      return "run bun lint";
    case "web.fetch":
      return `fetch ${get("url") || "<url>"}`;
    case "web.search":
      return `search ${get("query") || "<query>"}`;
    case "task.execute":
      return `execute ${get("targetPath") || get("path") || inferTargetPathFromInstruction(get("instruction")) || "task"}`;
    default:
      return kind;
  }
}

function buildWorkerCommitMessage(
  workerId: string,
  job: {
    id: string;
    taskId: string;
    kind: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    context?: "host" | "docker";
  },
): string {
  const action = summarizeJobAction(job.kind, job.params);
  const type = normalizeCommitType(job.kind, job.params);
  const area = inferCommitArea(job.kind, job.params);
  const summary = deriveSummary(action, job.params);
  const contextValue = sanitizeCommitValue(job.context ?? "host", 32);
  const sessionValue = sanitizeCommitValue(job.sessionId ?? "", 128);
  const replacements = {
    type: sanitizeCommitValue(type, 16),
    area: sanitizeCommitValue(area, 48),
    summary: sanitizeCommitValue(summary, 72),
    worker_id: sanitizeCommitValue(workerId, 64),
    task_id: sanitizeCommitValue(job.taskId, 128),
    job_id: sanitizeCommitValue(job.id, 128),
    job_kind: sanitizeCommitValue(job.kind, 64),
    action: sanitizeCommitValue(action, 180),
    scope: sanitizeCommitValue(summarizeScope(job.kind, job.params), 220),
    context: contextValue || "host",
    session_line: sessionValue ? `- Session: ${sessionValue}.` : "",
    implementation_points: buildImplementationPoints(job.kind, job.params),
  };

  const deterministicFallback = () => {
    const fallbackLines = [
      `${replacements.type}(${replacements.area}): ${replacements.summary}`,
      "",
      `- Implementation: ${replacements.action}.`,
      `- Scope: ${sanitizeCommitValue(summarizeScope(job.kind, job.params), 220)}.`,
      `- Traceability: worker:${replacements.worker_id}, task ${replacements.task_id}, job ${replacements.job_id}.`,
      `- Execution context: ${replacements.context}.`,
    ];
    if (replacements.session_line) fallbackLines.push(replacements.session_line);
    return fallbackLines.join("\n");
  };

  const isInstructionalTemplateOutput = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    if (!text) return true;
    if (text.includes("required output structure")) return true;
    if (text.includes("absolute prohibitions")) return true;
    if (text.includes("quality checklist")) return true;
    if (text.startsWith("# commit message writer")) return true;
    if (text.includes("{{")) return true;
    return false;
  };

  try {
    const rendered = loadPromptTemplate("workerpals/commit_message_prompt.md", replacements).trim();
    if (isInstructionalTemplateOutput(rendered)) {
      console.warn(
        `[WorkerPals] Commit message template appears instructional/unrendered; using deterministic fallback message.`,
      );
      return deterministicFallback();
    }
    return rendered;
  } catch (err) {
    console.warn(`[WorkerPals] Failed to load commit message prompt template: ${String(err)}`);
    return deterministicFallback();
  }
}

// ─── Job execution ───────────────────────────────────────────────────────────

export interface JobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

type TaskExecutePriority = "interactive" | "normal" | "background";
type TaskExecuteIntent = "chat" | "status" | "code_change" | "analysis" | "other";
type TaskExecuteRisk = "low" | "medium" | "high";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateTaskExecutePlanning(
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "task.execute requires params.planning object" };
  }
  const planning = value as Record<string, unknown>;

  const intent = String(planning.intent ?? "");
  const riskLevel = String(planning.riskLevel ?? "");
  const queuePriority = String(planning.queuePriority ?? "");
  const queueWaitBudgetMs = Number(planning.queueWaitBudgetMs);
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);

  const validIntents: TaskExecuteIntent[] = ["chat", "status", "code_change", "analysis", "other"];
  const validRisks: TaskExecuteRisk[] = ["low", "medium", "high"];
  const validPriorities: TaskExecutePriority[] = ["interactive", "normal", "background"];

  if (!validIntents.includes(intent as TaskExecuteIntent)) {
    return { ok: false, message: "task.execute planning.intent is invalid" };
  }
  if (!validRisks.includes(riskLevel as TaskExecuteRisk)) {
    return { ok: false, message: "task.execute planning.riskLevel is invalid" };
  }
  if (!validPriorities.includes(queuePriority as TaskExecutePriority)) {
    return { ok: false, message: "task.execute planning.queuePriority is invalid" };
  }
  if (!isStringArray(planning.targetPaths)) {
    return { ok: false, message: "task.execute planning.targetPaths must be a string array" };
  }
  if (!isStringArray(planning.validationSteps)) {
    return { ok: false, message: "task.execute planning.validationSteps must be a string array" };
  }
  if (!Number.isFinite(queueWaitBudgetMs) || queueWaitBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.queueWaitBudgetMs must be > 0" };
  }
  if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.executionBudgetMs must be > 0" };
  }
  if (!Number.isFinite(finalizationBudgetMs) || finalizationBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.finalizationBudgetMs must be > 0" };
  }

  return { ok: true };
}

export async function executeJob(
  kind: string,
  params: Record<string, unknown>,
  repo: string,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<JobResult> {
  if (kind === "warmup.execute") {
    return {
      ok: true,
      summary: "Startup warmup completed (no-op, no commit).",
      stdout: "warmup.execute completed",
      exitCode: 0,
    };
  }

  if (kind !== "task.execute") {
    return {
      ok: false,
      summary: `Unsupported job kind "${kind}". WorkerPals accepts only task.execute or warmup.execute.`,
    };
  }

  const schemaVersion = Number(params.schemaVersion);
  if (!Number.isFinite(schemaVersion) || Math.floor(schemaVersion) !== 2) {
    return {
      ok: false,
      summary: "task.execute requires params.schemaVersion=2",
      exitCode: 2,
    };
  }

  const planningValidation = validateTaskExecutePlanning(params.planning);
  if (!planningValidation.ok) {
    return {
      ok: false,
      summary: planningValidation.message,
      exitCode: 2,
    };
  }

  const lane = String(params.lane ?? "openhands")
    .trim()
    .toLowerCase();
  if (lane !== "openhands" && lane !== "deterministic") {
    return {
      ok: false,
      summary: "task.execute requires params.lane to be either 'openhands' or 'deterministic'.",
    };
  }

  const instruction = String(params.instruction ?? "").trim();
  if (!instruction) {
    return {
      ok: false,
      summary: "task.execute requires an 'instruction' param",
    };
  }

  const normalizedParams: Record<string, unknown> = {
    ...params,
    lane,
    instruction,
  };
  const planning = params.planning as Record<string, unknown>;
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);
  return executeWithOpenHands(kind, normalizedParams, repo, onLog, {
    executionBudgetMs,
    finalizationBudgetMs,
  });
}
