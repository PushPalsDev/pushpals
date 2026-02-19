/**
 * Extracted job execution logic.
 * Used by both the host Worker (direct mode) and the Docker job runner.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  loadPromptTemplate,
  loadPushPalsConfig,
  matchesGlob,
  normalizeTargetPath,
  validateScopeInvariants,
  type AutonomyComponentArea,
} from "shared";
import {
  FILE_MODIFYING_JOBS,
  QUALITY_CRITIC_MAX_DIFF_CHARS,
  QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS,
  QUALITY_CRITIC_MIN_SCORE,
  QUALITY_CRITIC_TIMEOUT_MS,
  QUALITY_MAX_AUTO_REVISIONS,
  QUALITY_VALIDATION_STEP_TIMEOUT_MS,
} from "./common/constants.js";
import { resolveExecutor, type WorkerpalsRuntimeConfig } from "./common/executor_backend.js";
import type { JobResult } from "./common/types.js";
import { compactJobOutput, truncate } from "./common/execution_utils.js";
// Re-export shared utilities for backward compatibility with external consumers.
export { compactJobOutput, truncate, streamLines } from "./common/execution_utils.js";
export { extractClarificationQuestionFromOutput } from "./backends/openhands_task_execute.js";
import { getBackendTaskExecutor } from "./backends/task_execute_registry.js";

const DEFAULT_CONFIG = loadPushPalsConfig();

interface TaskExecutePlanning {
  intent: TaskExecuteIntent;
  riskLevel: TaskExecuteRisk;
  targetPaths?: string[];
  scope: {
    readAnywhere: boolean;
    writeAllowed: boolean;
    writeGlobs?: string[];
    forbiddenGlobs?: string[];
    maxFilesToEdit?: number;
  };
  discovery?: {
    ripgrepQueries: string[];
    likelyDirs?: string[];
    keywords?: string[];
  };
  acceptanceCriteria: string[];
  validationSteps: string[];
  queuePriority: TaskExecutePriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
}

interface ValidationExecutionResult {
  step: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface DeterministicQualityResult {
  ok: boolean;
  skipped: boolean;
  issues: string[];
  changedPaths: string[];
  changedTestPaths: string[];
  validationRuns: ValidationExecutionResult[];
}

interface CriticReview {
  score: number;
  findings: string[];
  mustFix: string[];
  revisionGuidance: string;
  raw: string;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function shouldCommit(kind: string): boolean {
  return FILE_MODIFYING_JOBS.has(kind);
}

function toSingleLine(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function normalizeChatCompletionsEndpoint(endpoint: string): string {
  const source = endpoint.trim().replace(/\/+$/, "");
  if (!source) return "http://127.0.0.1:1234/v1/chat/completions";
  if (source.endsWith("/chat/completions")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function parseJsonObjectLoose(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return null;
}

function shellCommandForPlatform(command: string): string[] {
  if (process.platform === "win32") {
    return ["powershell", "-NoProfile", "-Command", command];
  }
  return ["/bin/bash", "-lc", command];
}

async function runShellValidationCommand(
  repo: string,
  command: string,
  timeoutMs: number,
): Promise<ValidationExecutionResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(shellCommandForPlatform(command), {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    },
    Math.max(1_000, timeoutMs),
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return {
    step: command,
    command,
    ok: !timedOut && exitCode === 0,
    exitCode: timedOut ? 124 : exitCode,
    stdout: compactJobOutput(stdout.trim()),
    stderr: compactJobOutput(stderr.trim()),
    elapsedMs: Math.max(1, Date.now() - startedAt),
  };
}

function stripAnsiControlSequences(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseChangedPathsFromStatus(statusOutput: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addPath = (rawPath: string) => {
    let path = rawPath;
    if (path.includes(" -> ")) {
      path = path.split(" -> ", 2)[1] ?? path;
    }
    path = path.trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  const normalizedOutput = stripAnsiControlSequences(statusOutput);
  if (normalizedOutput.includes("\u0000")) {
    const entries = normalizedOutput.split("\u0000");
    for (let i = 0; i < entries.length; i++) {
      const raw = (entries[i] ?? "").replace(/\r$/, "");
      if (!raw.trim()) continue;
      const porcelain = raw.match(/^(.{2}) (.*)$/);
      if (!porcelain) {
        addPath(raw);
        continue;
      }
      const status = porcelain[1] ?? "";
      let path = porcelain[2] ?? "";
      if ((status.includes("R") || status.includes("C")) && i + 1 < entries.length) {
        const renamedTo = entries[i + 1] ?? "";
        if (renamedTo) {
          path = renamedTo;
          i += 1;
        }
      }
      addPath(path);
    }
    return out;
  }

  for (const line of normalizedOutput.split(/\r?\n/)) {
    const raw = line.replace(/\r$/, "");
    if (!raw.trim()) continue;
    // git status --porcelain output is "<XY><space><path>".
    // Be tolerant of callers that accidentally trimmed leading space on the first line.
    let path = "";
    const porcelain = raw.match(/^.. (.+)$/);
    if (porcelain?.[1]) {
      path = porcelain[1];
    } else {
      const degraded = raw.match(/^. (.+)$/);
      if (degraded?.[1]) {
        path = degraded[1];
      } else {
        const loose = raw.match(/^[A-Z?]{1,2}\s+(.+)$/i);
        path = loose?.[1] ?? raw;
      }
    }
    addPath(path);
  }
  return out;
}

function isLikelyTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("__tests__/") ||
    /\.test\.[a-z0-9]+$/i.test(normalized) ||
    /\.spec\.[a-z0-9]+$/i.test(normalized)
  );
}

function extractRunnableValidationCommand(step: string): string | null {
  const trimmed = step.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/`([^`]+)`/)?.[1]?.trim();
  if (fenced) return fenced;

  const lower = trimmed.toLowerCase();
  const maybeStripped = lower.startsWith("run ")
    ? trimmed.slice(4).trim()
    : lower.startsWith("execute ")
      ? trimmed.slice(8).trim()
      : trimmed;
  const firstToken = maybeStripped.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const runnable = new Set(["bun", "npm", "pnpm", "yarn", "pytest", "python", "uv", "coverage"]);
  if (runnable.has(firstToken)) return maybeStripped;
  return null;
}

function isTestFocusedTask(
  instruction: string,
  planning: TaskExecutePlanning,
  targetPath?: string,
): boolean {
  const lowerInstruction = instruction.toLowerCase();
  if (
    /\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/.test(lowerInstruction)
  ) {
    return true;
  }
  if (targetPath && isLikelyTestPath(targetPath)) return true;
  const pathHints = [
    ...(planning.scope.writeGlobs ?? []),
    ...(planning.discovery?.likelyDirs ?? []),
  ];
  if (pathHints.some((entry) => isLikelyTestPath(entry))) return true;
  if (
    planning.validationSteps.some((entry) =>
      /\b(test|tests|coverage|pytest|vitest|jest|bun test)\b/i.test(entry),
    )
  ) {
    return true;
  }
  if (
    planning.acceptanceCriteria.some((entry) =>
      /\b(test|tests|coverage|unit|integration|negative|invalid|valid)\b/i.test(entry),
    )
  ) {
    return true;
  }
  return false;
}

function hasBalancedPositiveNegativeAssertions(paths: string[], repo: string): boolean {
  const negativeSignal =
    /\b(invalid|negative|error|throw|reject|null|undefined|non[- ]?existent|toThrow|toBeNull|toBeUndefined|<\s*0|<=\s*0)\b/i;
  let positiveAssertions = 0;
  let negativeAssertions = 0;

  for (const rel of paths) {
    const fullPath = resolve(repo, rel);
    let content = "";
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!/\b(expect\(|assert\s+)/.test(line)) continue;
      if (negativeSignal.test(line)) negativeAssertions += 1;
      else positiveAssertions += 1;
    }
  }

  return positiveAssertions > 0 && negativeAssertions > 0;
}

async function runDeterministicQualityGate(
  repo: string,
  params: Record<string, unknown>,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<DeterministicQualityResult> {
  const instruction = String(params.instruction ?? "");
  const targetPath = String(params.targetPath ?? params.path ?? "").trim() || undefined;
  const planning = params.planning as TaskExecutePlanning;
  const isTestTask = isTestFocusedTask(instruction, planning, targetPath);
  if (!isTestTask) {
    return {
      ok: true,
      skipped: true,
      issues: [],
      changedPaths: [],
      changedTestPaths: [],
      validationRuns: [],
    };
  }

  const statusResult = await git(repo, ["status", "--porcelain"]);
  const changedPaths = statusResult.ok ? parseChangedPathsFromStatus(statusResult.stdout) : [];
  const changedTestPaths = changedPaths.filter((path) => isLikelyTestPath(path));
  const issues: string[] = [];
  if (changedTestPaths.length === 0) {
    issues.push("No relevant test file was modified for this test-focused task.");
  }
  if (
    changedTestPaths.length > 0 &&
    !hasBalancedPositiveNegativeAssertions(changedTestPaths, repo)
  ) {
    issues.push(
      "Changed test files do not show both positive and negative assertion coverage (expected both).",
    );
  }

  const runnableSteps = planning.validationSteps
    .map((step) => extractRunnableValidationCommand(step))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 4);
  const validationRuns: ValidationExecutionResult[] = [];
  if (runnableSteps.length === 0) {
    issues.push(
      "No runnable validation command was provided in planning.validationSteps (expected at least one test command).",
    );
  } else {
    for (const command of runnableSteps) {
      onLog?.("stdout", `[QualityGate] Quality gate validation: running "${command}"`);
      const run = await runShellValidationCommand(
        repo,
        command,
        QUALITY_VALIDATION_STEP_TIMEOUT_MS,
      );
      validationRuns.push(run);
      const runSummary = `[QualityGate] Quality gate validation ${run.ok ? "passed" : "failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}`;
      onLog?.(run.ok ? "stdout" : "stderr", runSummary);
    }
    if (validationRuns.every((run) => !run.ok)) {
      issues.push("Validation commands were executed but none passed.");
    }
    if (
      !validationRuns.some((run) => /\b(test|pytest|coverage|vitest|jest)\b/i.test(run.command))
    ) {
      issues.push("Validation steps did not execute a recognizable test command.");
    }
  }

  return {
    ok: issues.length === 0,
    skipped: false,
    issues,
    changedPaths,
    changedTestPaths,
    validationRuns,
  };
}

async function runTaskCriticReview(
  repo: string,
  params: Record<string, unknown>,
  quality: DeterministicQualityResult,
  runtimeConfig: WorkerpalsRuntimeConfig,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<CriticReview | null> {
  const endpoint = normalizeChatCompletionsEndpoint(runtimeConfig.workerpals.llm.endpoint);
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!endpoint || !model) return null;

  const changedForDiff = quality.changedPaths.slice(0, 8);
  let diffText = "";
  if (changedForDiff.length > 0) {
    const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
    diffText = diffResult.ok ? diffResult.stdout : diffResult.stderr;
  }
  diffText = compactJobOutput(diffText).slice(0, QUALITY_CRITIC_MAX_DIFF_CHARS);

  const validationSummary = quality.validationRuns
    .map((run) => {
      const output = [run.stdout, run.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(0, QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS);
      return [
        `Command: ${run.command}`,
        `Result: ${run.ok ? "pass" : "fail"} (exit ${run.exitCode}, ${run.elapsedMs}ms)`,
        output ? `Output:\n${output}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");

  const planning = params.planning as TaskExecutePlanning;
  const instruction = String(params.instruction ?? "").trim();
  const criticSystem = [
    "You are a strict code-review critic for worker-generated patches.",
    "Return exactly one JSON object with keys:",
    `{"score": <0-10 number>, "findings": [string], "must_fix": [string], "revision_guidance": string}`,
    "Scoring rubric:",
    "- 10: complete, correct, and robust with strong validation coverage.",
    "- 8-9: good quality with minor non-blocking issues.",
    "- <=7: requires revision before commit.",
    "must_fix must list blocking issues only.",
    "Do not include markdown or prose outside JSON.",
  ].join("\n");
  const criticUser = [
    `Instruction:\n${instruction}`,
    `Acceptance criteria:\n${planning.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n") || "- (none)"}`,
    `Validation steps:\n${planning.validationSteps.map((entry) => `- ${entry}`).join("\n") || "- (none)"}`,
    `Changed paths:\n${quality.changedPaths.map((entry) => `- ${entry}`).join("\n") || "- (none)"}`,
    `Diff excerpt:\n${diffText || "(empty diff excerpt)"}`,
    `Validation evidence:\n${validationSummary || "(no validation output)"}`,
  ].join("\n\n");

  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const bodyBase = {
    model,
    messages: [
      { role: "system", content: criticSystem },
      { role: "user", content: criticUser },
    ],
    temperature: 0,
    max_tokens: 700,
  };

  const runCriticRequest = async (responseFormat: Record<string, unknown> | null) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUALITY_CRITIC_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          responseFormat ? { ...bodyBase, response_format: responseFormat } : bodyBase,
        ),
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let request = await runCriticRequest({ type: "json_object" });
    if (!request.response.ok && request.response.status === 400) {
      const lowered = request.text.toLowerCase();
      if (lowered.includes("response_format")) {
        onLog?.(
          "stdout",
          "[QualityGate] Critic fallback: response_format json_object unsupported; retrying without strict response_format.",
        );
        request = await runCriticRequest(null);
      }
    }
    if (!request.response.ok) {
      onLog?.(
        "stderr",
        `[QualityGate] Critic review request failed (${request.response.status}): ${toSingleLine(request.text, 240)}`,
      );
      return null;
    }

    const payload = parseJsonObjectLoose(request.text) ?? JSON.parse(request.text);
    const choices = Array.isArray((payload as Record<string, unknown>).choices)
      ? ((payload as Record<string, unknown>).choices as Array<Record<string, unknown>>)
      : [];
    const content = String(
      (choices[0]?.message as Record<string, unknown> | undefined)?.content ?? "",
    ).trim();
    const reviewObj = parseJsonObjectLoose(content);
    if (!reviewObj) {
      onLog?.(
        "stderr",
        `[QualityGate] Critic produced non-JSON content; skipping critic gate. Raw: ${toSingleLine(
          content,
          220,
        )}`,
      );
      return null;
    }

    const scoreRaw = Number(reviewObj.score);
    const findings = Array.isArray(reviewObj.findings)
      ? reviewObj.findings.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    const mustFix = Array.isArray(reviewObj.must_fix)
      ? reviewObj.must_fix.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "")
      .trim()
      .slice(0, 2000);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    return {
      score,
      findings,
      mustFix,
      revisionGuidance,
      raw: compactJobOutput(content),
    };
  } catch (err) {
    onLog?.(
      "stderr",
      `[QualityGate] Critic review unavailable: ${toSingleLine(err, 220)} (continuing without critic gate).`,
    );
    return null;
  }
}

function buildQualityRevisionHint(
  issues: string[],
  critic: CriticReview | null,
  planning: TaskExecutePlanning,
): string {
  const lines: string[] = [];
  lines.push("Quality revision required before completion.");
  if (issues.length > 0) {
    lines.push("Deterministic quality issues:");
    for (const issue of issues) lines.push(`- ${issue}`);
  }
  if (critic) {
    lines.push(`Critic score: ${critic.score.toFixed(1)} / 10`);
    if (critic.mustFix.length > 0) {
      lines.push("Critic must-fix findings:");
      for (const issue of critic.mustFix) lines.push(`- ${issue}`);
    }
    if (critic.revisionGuidance) {
      lines.push(`Critic revision guidance: ${critic.revisionGuidance}`);
    }
  }
  if (planning.acceptanceCriteria.length > 0) {
    lines.push("Required acceptance criteria:");
    for (const criterion of planning.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  if (planning.validationSteps.length > 0) {
    lines.push("Required validation steps:");
    for (const step of planning.validationSteps) lines.push(`- ${step}`);
  }
  lines.push("Apply a minimal corrective patch, run focused validation, then finish.");
  return lines.join("\n").slice(0, 6000);
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
  else if (path.startsWith("/")) return null;
  if (/^[A-Za-z]:[\\/]/.test(path)) return null;

  path = path
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!path || path === ".") return ".";
  if (path.startsWith(":(")) return null;

  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
  }

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

    // Preserve leading spaces in stdout for porcelain parsers.
    return { ok: exitCode === 0, stdout: stdout.trimEnd(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
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
  runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): Promise<{ ok: boolean; branch?: string; sha?: string; error?: string }> {
  const requirePush = runtimeConfig.workerpals.requirePush;
  const pushAgentBranch = requirePush || runtimeConfig.workerpals.pushAgentBranch;
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

function planningPathHints(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const planning = value as Record<string, unknown>;
  const hints: string[] = [];

  const scope =
    planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope)
      ? (planning.scope as Record<string, unknown>)
      : null;
  if (scope) {
    hints.push(...toStringArray(scope.writeGlobs));
  }

  const discovery =
    planning.discovery &&
    typeof planning.discovery === "object" &&
    !Array.isArray(planning.discovery)
      ? (planning.discovery as Record<string, unknown>)
      : null;
  if (discovery) {
    hints.push(...toStringArray(discovery.likelyDirs));
  }

  return hints.slice(0, 12);
}

function buildStageTargets(kind: string, params?: Record<string, unknown>): string[] {
  const p = params ?? {};
  switch (kind) {
    case "task.execute": {
      const paths = toStringArray(p.paths);
      const planHints = planningPathHints(p.planning);
      const inferred = toPath(inferTargetPathFromInstruction(String(p.instruction ?? "")));
      return dedupePaths([...paths, ...planHints, toPath(p.targetPath), toPath(p.path), inferred]);
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

export type { JobResult } from "./common/types.js";

const SUPPORTED_JOB_KINDS = new Set(["warmup.execute", "task.execute"]);

type TaskExecutePriority = "interactive" | "normal" | "background";
type TaskExecuteIntent = "chat" | "status" | "code_change" | "analysis" | "other";
type TaskExecuteRisk = "low" | "medium" | "high";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasInvalidRepoPathHint(values: string[]): boolean {
  return values.some((entry) => normalizeStagePath(entry) === null);
}

function inferComponentAreaFromPath(path: string): AutonomyComponentArea | null {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("apps/server/")) return "apps/server";
  if (normalized.startsWith("apps/remotebuddy/")) return "apps/remotebuddy";
  if (normalized.startsWith("apps/workerpals/")) return "apps/workerpals";
  if (normalized.startsWith("apps/client/")) return "apps/client";
  if (normalized.startsWith("packages/protocol/")) return "packages/protocol";
  if (normalized.startsWith("packages/shared/")) return "packages/shared";
  if (normalized.startsWith("tests/integration/")) return "tests/integration";
  if (normalized.startsWith("tests/unit/")) return "tests/unit";
  return null;
}

function inferComponentAreaFromTargets(targetPaths: string[]): AutonomyComponentArea | null {
  let area: AutonomyComponentArea | null = null;
  for (const path of targetPaths) {
    const inferred = inferComponentAreaFromPath(path);
    if (!inferred) return null;
    if (!area) area = inferred;
    else if (area !== inferred) return null;
  }
  return area;
}

function asAutonomyComponentArea(value: unknown): AutonomyComponentArea | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  switch (text) {
    case "apps/server":
    case "apps/remotebuddy":
    case "apps/workerpals":
    case "apps/client":
    case "packages/protocol":
    case "packages/shared":
    case "tests/integration":
    case "tests/unit":
      return text;
    default:
      return null;
  }
}

function taskExecuteOrigin(params: Record<string, unknown>): "autonomy" | "user" {
  const explicit = String(params.origin ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "autonomy") return "autonomy";
  const autonomy = params.autonomy;
  if (autonomy && typeof autonomy === "object" && !Array.isArray(autonomy)) {
    const nested = String((autonomy as Record<string, unknown>).origin ?? "")
      .trim()
      .toLowerCase();
    if (nested === "autonomy") return "autonomy";
  }
  return "user";
}

async function enforceWriteScope(
  repo: string,
  planning: TaskExecutePlanning,
): Promise<{ ok: boolean; message?: string }> {
  const writeGlobs = toStringArray(planning.scope.writeGlobs ?? []);
  if (writeGlobs.length === 0) return { ok: true };

  const statusResult = await git(repo, ["status", "--porcelain"]);
  if (!statusResult.ok) {
    return { ok: false, message: "Unable to evaluate changed paths for scope enforcement." };
  }

  const changedPaths = parseChangedPathsFromStatus(statusResult.stdout)
    .map((entry) => normalizeStagePath(entry))
    .filter((entry): entry is string => Boolean(entry) && entry !== ".");
  if (changedPaths.length === 0) return { ok: true };

  const forbidden = toStringArray(planning.scope.forbiddenGlobs ?? []);
  const outOfScope = changedPaths.filter((path) => !writeGlobs.some((glob) => matchesGlob(path, glob)));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      message: `Scope violation: modified paths outside writeGlobs: ${outOfScope.join(", ")}`,
    };
  }
  const forbiddenTouched = changedPaths.filter((path) => forbidden.some((glob) => matchesGlob(path, glob)));
  if (forbiddenTouched.length > 0) {
    return {
      ok: false,
      message: `Scope violation: modified forbidden paths: ${forbiddenTouched.join(", ")}`,
    };
  }
  return { ok: true };
}

function sanitizeTaskExecutePlanningPathHints(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const planning = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...planning };

  if (planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope)) {
    const scope = planning.scope as Record<string, unknown>;
    const normalizedScope: Record<string, unknown> = { ...scope };
    if (isStringArray(scope.writeGlobs)) {
      normalizedScope.writeGlobs = toStringArray(scope.writeGlobs);
    }
    if (isStringArray(scope.forbiddenGlobs)) {
      normalizedScope.forbiddenGlobs = toStringArray(scope.forbiddenGlobs);
    }
    out.scope = normalizedScope;
  }

  if (
    planning.discovery &&
    typeof planning.discovery === "object" &&
    !Array.isArray(planning.discovery)
  ) {
    const discovery = planning.discovery as Record<string, unknown>;
    const normalizedDiscovery: Record<string, unknown> = { ...discovery };
    if (isStringArray(discovery.likelyDirs)) {
      normalizedDiscovery.likelyDirs = toStringArray(discovery.likelyDirs);
    }
    out.discovery = normalizedDiscovery;
  }

  return out;
}

function validateTaskExecutePlanning(
  value: unknown,
  options?: {
    origin?: "autonomy" | "user";
    autonomyComponentArea?: unknown;
  },
): { ok: true } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "task.execute requires params.planning object" };
  }
  const planning = value as Record<string, unknown>;
  const origin = options?.origin === "autonomy" ? "autonomy" : "user";

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
  if (!planning.scope || typeof planning.scope !== "object" || Array.isArray(planning.scope)) {
    return { ok: false, message: "task.execute planning.scope must be an object" };
  }
  const scope = planning.scope as Record<string, unknown>;
  if (typeof scope.readAnywhere !== "boolean") {
    return { ok: false, message: "task.execute planning.scope.readAnywhere must be boolean" };
  }
  if (typeof scope.writeAllowed !== "boolean") {
    return { ok: false, message: "task.execute planning.scope.writeAllowed must be boolean" };
  }
  if (scope.writeGlobs !== undefined && !isStringArray(scope.writeGlobs)) {
    return { ok: false, message: "task.execute planning.scope.writeGlobs must be a string array" };
  }
  if (isStringArray(scope.writeGlobs) && hasInvalidRepoPathHint(scope.writeGlobs)) {
    return {
      ok: false,
      message: "task.execute planning.scope.writeGlobs must contain repo-relative path hints only",
    };
  }
  if (scope.forbiddenGlobs !== undefined && !isStringArray(scope.forbiddenGlobs)) {
    return {
      ok: false,
      message: "task.execute planning.scope.forbiddenGlobs must be a string array",
    };
  }
  if (isStringArray(scope.forbiddenGlobs) && hasInvalidRepoPathHint(scope.forbiddenGlobs)) {
    return {
      ok: false,
      message:
        "task.execute planning.scope.forbiddenGlobs must contain repo-relative path hints only",
    };
  }
  if (
    scope.maxFilesToEdit !== undefined &&
    (!Number.isFinite(Number(scope.maxFilesToEdit)) || Number(scope.maxFilesToEdit) <= 0)
  ) {
    return { ok: false, message: "task.execute planning.scope.maxFilesToEdit must be > 0" };
  }

  if (planning.targetPaths !== undefined && !isStringArray(planning.targetPaths)) {
    return { ok: false, message: "task.execute planning.targetPaths must be a string array" };
  }
  if (isStringArray(planning.targetPaths)) {
    const normalizedTargetPaths = planning.targetPaths
      .map((entry) => normalizeTargetPath(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (normalizedTargetPaths.length !== planning.targetPaths.length) {
      return {
        ok: false,
        message: "task.execute planning.targetPaths must contain literal repo-relative paths",
      };
    }
    const normalizedWriteGlobs = isStringArray(scope.writeGlobs) ? toStringArray(scope.writeGlobs) : [];
    if (origin === "autonomy") {
      const declaredComponentArea = asAutonomyComponentArea(options?.autonomyComponentArea);
      const inferredComponentArea = inferComponentAreaFromTargets(normalizedTargetPaths);
      const componentArea = declaredComponentArea ?? inferredComponentArea;
      if (!componentArea) {
        return {
          ok: false,
          message: "task.execute planning.targetPaths must map to one supported component area",
        };
      }
      if (declaredComponentArea && inferredComponentArea && declaredComponentArea !== inferredComponentArea) {
        return {
          ok: false,
          message: "task.execute planning.targetPaths do not match autonomy componentArea",
        };
      }
      const validatedScope = validateScopeInvariants(
        componentArea,
        normalizedTargetPaths,
        normalizedWriteGlobs,
        { requireWriteGlobs: true },
      );
      if (!validatedScope.ok) {
        return {
          ok: false,
          message: `task.execute scope invariants failed: ${validatedScope.errors.join("; ")}`,
        };
      }
    } else if (normalizedWriteGlobs.length > 0) {
      const uncoveredPaths = normalizedTargetPaths.filter(
        (targetPath) => !normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob)),
      );
      if (uncoveredPaths.length > 0) {
        return {
          ok: false,
          message: `task.execute planning.targetPaths must be covered by planning.scope.writeGlobs: ${uncoveredPaths.join(", ")}`,
        };
      }
    }
  }

  if (planning.discovery !== undefined) {
    if (
      !planning.discovery ||
      typeof planning.discovery !== "object" ||
      Array.isArray(planning.discovery)
    ) {
      return { ok: false, message: "task.execute planning.discovery must be an object" };
    }
    const discovery = planning.discovery as Record<string, unknown>;
    if (!isStringArray(discovery.ripgrepQueries)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.ripgrepQueries must be a string array",
      };
    }
    if (discovery.likelyDirs !== undefined && !isStringArray(discovery.likelyDirs)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.likelyDirs must be a string array",
      };
    }
    if (isStringArray(discovery.likelyDirs) && hasInvalidRepoPathHint(discovery.likelyDirs)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.likelyDirs must be repo-relative path hints",
      };
    }
    if (discovery.keywords !== undefined && !isStringArray(discovery.keywords)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.keywords must be a string array",
      };
    }
  }

  if (!isStringArray(planning.acceptanceCriteria)) {
    return {
      ok: false,
      message: "task.execute planning.acceptanceCriteria must be a string array",
    };
  }
  if (!isStringArray(planning.validationSteps)) {
    return { ok: false, message: "task.execute planning.validationSteps must be a string array" };
  }
  if ((planning.acceptanceCriteria as string[]).length === 0) {
    return {
      ok: false,
      message:
        "task.execute planning.acceptanceCriteria must include at least one acceptance criterion",
    };
  }
  if ((planning.validationSteps as string[]).length === 0) {
    return {
      ok: false,
      message: "task.execute planning.validationSteps must include at least one validation step",
    };
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
  runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): Promise<JobResult> {
  if (!SUPPORTED_JOB_KINDS.has(kind)) {
    return {
      ok: false,
      summary: `Unsupported job kind "${kind}". WorkerPals accepts only ${[...SUPPORTED_JOB_KINDS].join(" or ")}.`,
    };
  }

  if (kind === "warmup.execute") {
    return {
      ok: true,
      summary: "Startup warmup completed (no-op, no commit).",
      stdout: "warmup.execute completed",
      exitCode: 0,
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

  const origin = taskExecuteOrigin(params);
  const autonomyScope =
    params.autonomy && typeof params.autonomy === "object" && !Array.isArray(params.autonomy)
      ? (params.autonomy as Record<string, unknown>)
      : null;
  const planningValidation = validateTaskExecutePlanning(params.planning, {
    origin,
    autonomyComponentArea: autonomyScope?.componentArea ?? autonomyScope?.component_area,
  });
  if (!planningValidation.ok) {
    return {
      ok: false,
      summary: planningValidation.message,
      exitCode: 2,
    };
  }
  const sanitizedPlanning = sanitizeTaskExecutePlanningPathHints(params.planning);
  const planning = sanitizedPlanning as TaskExecutePlanning;
  if (origin === "autonomy" && toStringArray(planning.scope.writeGlobs ?? []).length === 0) {
    return {
      ok: false,
      summary: "autonomy task.execute requires planning.scope.writeGlobs",
      exitCode: 2,
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
    planning: sanitizedPlanning,
    instruction,
  };
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);

  let revisionAttempt = 0;
  let revisionHint = "";
  while (revisionAttempt <= QUALITY_MAX_AUTO_REVISIONS) {
    const attemptParams: Record<string, unknown> = { ...normalizedParams };
    if (revisionHint) {
      attemptParams.qualityRevisionHint = revisionHint;
      attemptParams.qualityRevisionAttempt = revisionAttempt;
    }

    const executor = resolveExecutor(runtimeConfig);
    const executeBudgets = { executionBudgetMs, finalizationBudgetMs };
    const runExecutor = getBackendTaskExecutor(executor);
    if (!runExecutor) {
      return {
        ok: false,
        summary: `No task executor registered for backend "${executor}"`,
        exitCode: 1,
      };
    }
    const result = await runExecutor(
      kind,
      attemptParams,
      repo,
      runtimeConfig,
      onLog,
      executeBudgets,
    );
    if (!result.ok) return result;

    const scopeCheck = await enforceWriteScope(repo, planning);
    if (!scopeCheck.ok) {
      return {
        ok: false,
        summary: scopeCheck.message ?? "Scope enforcement failed for task.execute changes.",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 5,
      };
    }

    const quality = await runDeterministicQualityGate(repo, attemptParams, onLog);
    const critic = quality.skipped
      ? null
      : await runTaskCriticReview(repo, attemptParams, quality, runtimeConfig, onLog);
    const criticRequiresRevision = Boolean(
      critic && (critic.score < QUALITY_CRITIC_MIN_SCORE || critic.mustFix.length > 0),
    );

    if (quality.ok && !criticRequiresRevision) {
      if (critic) {
        onLog?.(
          "stdout",
          `[QualityGate] Critic review score ${critic.score.toFixed(1)}/10 (threshold ${QUALITY_CRITIC_MIN_SCORE}).`,
        );
      }
      return result;
    }

    const issues = [...quality.issues];
    if (criticRequiresRevision && critic) {
      const scoreIssue = `Critic score ${critic.score.toFixed(1)} is below required threshold ${QUALITY_CRITIC_MIN_SCORE}.`;
      issues.push(scoreIssue);
      for (const entry of critic.mustFix.slice(0, 8)) {
        issues.push(`Critic must-fix: ${entry}`);
      }
    }
    const issueSummary = issues.map((entry) => toSingleLine(entry, 180)).join(" | ");
    if (revisionAttempt >= QUALITY_MAX_AUTO_REVISIONS) {
      return {
        ok: false,
        summary: `Quality gate failed after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(
          issueSummary,
          240,
        )}`,
        stdout: result.stdout,
        stderr: truncate(
          [
            result.stderr ?? "",
            quality.skipped
              ? ""
              : `Deterministic issues: ${quality.issues.map((entry) => toSingleLine(entry, 220)).join(" | ")}`,
            critic ? `Critic raw: ${critic.raw}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        exitCode: 4,
      };
    }

    revisionAttempt += 1;
    revisionHint = buildQualityRevisionHint(issues, critic, planning);
    onLog?.(
      "stderr",
      `[QualityGate] Quality gate requested revision ${revisionAttempt}/${QUALITY_MAX_AUTO_REVISIONS}: ${toSingleLine(
        issueSummary,
        260,
      )}`,
    );
  }

  return {
    ok: false,
    summary: "Quality revision loop ended unexpectedly.",
    exitCode: 4,
  };
}
