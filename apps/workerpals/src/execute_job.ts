/**
 * Extracted job execution logic.
 * Used by both the host Worker (direct mode) and the Docker job runner.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import {
  deriveAutonomyComponentArea,
  loadPromptTemplate,
  loadPushPalsConfig,
  matchesGlob,
  normalizeAutonomyComponentArea,
  normalizeTargetPath,
  validateScopeInvariants,
  type AutonomyComponentArea,
} from "shared";
import { resolveExecutor, type WorkerpalsRuntimeConfig } from "./common/executor_backend.js";
import type { JobResult } from "./common/types.js";
import {
  compactJobOutput,
  truncate,
  type OutputCompactionPolicy,
} from "./common/execution_utils.js";
// Re-export shared utilities for backward compatibility with external consumers.
export { compactJobOutput, truncate, streamLines } from "./common/execution_utils.js";
export { extractClarificationQuestionFromOutput } from "./backends/openhands_task_execute.js";
import { getBackendTaskExecutor } from "./backends/task_execute_registry.js";
import { extractMergeConflictReviewContext } from "./merge_conflict_job.js";

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

interface ValidationBlocker {
  category: "repo" | "environment";
  detail: string;
}

interface DeterministicQualityResult {
  ok: boolean;
  skipped: boolean;
  issues: string[];
  changedPaths: string[];
  changedTestPaths: string[];
  validationRuns: ValidationExecutionResult[];
  blocker: ValidationBlocker | null;
}

interface CriticReview {
  score: number;
  findings: string[];
  mustFix: string[];
  revisionGuidance: string;
  raw: string;
}

export interface ReviewFixContext {
  resolutionType: "review_fix";
  prHeadRef: string | null;
  prBaseRef: string | null;
  previousReviewScore: number | null;
  reviewThreshold: number | null;
  previousReviewSummary: string;
  reviewerFindings: string[];
}

export interface QualityGatePolicy {
  mode: "default" | "review_fix" | "merge_conflict";
  maxAutoRevisions: number;
  softPassOnExhausted: boolean;
  criticMinScore: number;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function shouldCommit(
  kind: string,
  runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): boolean {
  const configured = Array.isArray(runtimeConfig.workerpals.fileModifyingJobs)
    ? runtimeConfig.workerpals.fileModifyingJobs
    : [];
  const fallback = ["task.execute"];
  const jobs = configured.length > 0 ? configured : fallback;
  return jobs.includes(kind);
}

function outputPolicyForRuntime(
  runtimeConfig: WorkerpalsRuntimeConfig,
): Partial<OutputCompactionPolicy> {
  return {
    maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
    maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
    maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
    executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix,
  };
}

function toSingleLine(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

export function redactSensitiveText(value: string): string {
  let out = String(value ?? "");
  if (!out) return "";
  // redact URL userinfo credentials: https://user:pass@host -> https://***@host
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  // redact malformed/encoded scheme userinfo from legacy rewrite bugs: https%3A//user%3Apass@host
  out = out.replace(/https%3a\/\/[^@\s/]+@/gi, "https%3A//***@");
  // redact bearer tokens
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-:+/=]+\b/gi, "$1***");
  // redact common VCS token shapes
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  out = out.replace(/\bglpat-[A-Za-z0-9\-_]{20,}\b/gi, "glpat-***");
  return out;
}

export function buildCriticRevisionIssues(
  critic:
    | {
        score: number;
        findings?: string[];
        mustFix?: string[];
        revisionGuidance?: string;
      }
    | null
    | undefined,
  qualityCriticMinScore: number,
): string[] {
  if (!critic) return [];
  if (critic.score >= qualityCriticMinScore) return [];
  const issues = [
    `Critic score ${critic.score.toFixed(1)} is below required threshold ${qualityCriticMinScore}.`,
  ];
  const mustFix = Array.isArray(critic.mustFix) ? critic.mustFix : [];
  const findings = Array.isArray(critic.findings) ? critic.findings : [];
  const revisionGuidance = String(critic.revisionGuidance ?? "").trim();
  const actionableItems = (mustFix.length > 0 ? mustFix : findings)
    .map((entry) => toSingleLine(entry, 180))
    .filter(Boolean)
    .slice(0, 3);
  for (const item of actionableItems) {
    issues.push(mustFix.length > 0 ? `Critic must-fix: ${item}` : `Critic finding: ${item}`);
  }
  if (revisionGuidance) {
    issues.push(`Critic revision guidance: ${toSingleLine(revisionGuidance, 220)}`);
  }
  return issues;
}

export function buildQualityGateRevisionIssues(
  qualityIssues: string[],
  critic: CriticReview | null,
  qualityCriticMinScore: number,
): string[] {
  const normalizedQualityIssues = qualityIssues
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (!critic || critic.score >= qualityCriticMinScore) {
    return [...normalizedQualityIssues];
  }
  const merged = [
    ...normalizedQualityIssues,
    ...buildCriticRevisionIssues(critic, qualityCriticMinScore),
  ];
  return [...new Set(merged)];
}

const TEST_ASSERTION_BALANCE_ISSUE =
  "Changed test files do not show both positive and negative assertion coverage (expected both).";

export function relaxAdvisoryQualityIssues(
  qualityIssues: string[],
  validationRuns: Array<{ ok: boolean }>,
  critic: CriticReview | null,
  qualityCriticMinScore: number,
): string[] {
  const normalizedQualityIssues = qualityIssues
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (normalizedQualityIssues.length === 0) return [];

  const hasPassingValidation = validationRuns.some((run) => Boolean(run?.ok));
  const criticPasses = !critic || critic.score >= qualityCriticMinScore;
  if (!hasPassingValidation || !criticPasses) {
    return normalizedQualityIssues;
  }

  const relaxed = normalizedQualityIssues.filter((issue) => issue !== TEST_ASSERTION_BALANCE_ISSUE);
  return relaxed;
}

export function resolveReviewFixCompletionBranch(
  value: unknown,
  fallbackBranch: string,
): { branch: string; overridden: boolean } {
  if (typeof value !== "string") {
    return { branch: fallbackBranch, overridden: false };
  }
  const trimmed = value.trim();
  if (!trimmed) return { branch: fallbackBranch, overridden: false };
  const withoutPrefix = trimmed.replace(/^refs\/heads\//, "");
  const normalized = withoutPrefix
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("agent/")) return { branch: fallbackBranch, overridden: false };
  if (
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock")
  ) {
    return { branch: fallbackBranch, overridden: false };
  }
  if (/[~^:?*\[\]\s]/.test(normalized)) return { branch: fallbackBranch, overridden: false };
  return { branch: normalized, overridden: true };
}

export function resolveReviewNoChangeCompletionBranch(
  params: Record<string, unknown> | null | undefined,
): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const reviewAgent =
    params.reviewAgent &&
    typeof params.reviewAgent === "object" &&
    !Array.isArray(params.reviewAgent)
      ? (params.reviewAgent as Record<string, unknown>)
      : null;
  const reviewAgentHeadRef = reviewAgent?.prHeadRef;
  const candidate = params.completionBranch ?? reviewAgentHeadRef;
  const resolved = resolveReviewFixCompletionBranch(candidate, "");
  return resolved.overridden ? resolved.branch : null;
}

function toFiniteReviewScore(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(10, parsed));
}

function toNonEmptyReviewStringArray(value: unknown, limit: number = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function extractReviewFixContext(
  params: Record<string, unknown> | null | undefined,
): ReviewFixContext | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const reviewAgent =
    params.reviewAgent &&
    typeof params.reviewAgent === "object" &&
    !Array.isArray(params.reviewAgent)
      ? (params.reviewAgent as Record<string, unknown>)
      : null;
  if (!reviewAgent) return null;
  const resolutionType = String(reviewAgent.resolutionType ?? "")
    .trim()
    .toLowerCase();
  if (resolutionType === "merge_conflict") return null;
  const looksLikeLegacyReviewFix =
    typeof reviewAgent.prHeadRef === "string" ||
    typeof reviewAgent.previousReviewSummary === "string" ||
    Number.isFinite(Number(reviewAgent.previousReviewScore)) ||
    Array.isArray(reviewAgent.reviewerFindings);
  if (resolutionType && resolutionType !== "review_fix") return null;
  if (!resolutionType && !looksLikeLegacyReviewFix) return null;
  return {
    resolutionType: "review_fix",
    prHeadRef: typeof reviewAgent.prHeadRef === "string" ? reviewAgent.prHeadRef.trim() || null : null,
    prBaseRef: typeof reviewAgent.prBaseRef === "string" ? reviewAgent.prBaseRef.trim() || null : null,
    previousReviewScore: toFiniteReviewScore(reviewAgent.previousReviewScore),
    reviewThreshold: toFiniteReviewScore(reviewAgent.reviewThreshold),
    previousReviewSummary: String(reviewAgent.previousReviewSummary ?? "").trim(),
    reviewerFindings: toNonEmptyReviewStringArray(reviewAgent.reviewerFindings),
  };
}

export function shouldEnqueueNoChangeReviewCompletion(
  params: Record<string, unknown> | null | undefined,
): boolean {
  return extractReviewFixContext(params) == null;
}

export function deriveQualityGatePolicy(
  params: Record<string, unknown> | null | undefined,
  runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): QualityGatePolicy {
  const baseMaxAutoRevisions = Math.max(
    0,
    Math.min(
      10,
      Number.isFinite(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions))
        ? Math.floor(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions))
        : 4,
    ),
  );
  const baseSoftPassOnExhausted =
    typeof runtimeConfig.workerpals.qualitySoftPassOnExhausted === "boolean"
      ? runtimeConfig.workerpals.qualitySoftPassOnExhausted
      : true;
  const baseCriticMinScore = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMinScore);
    if (!Number.isFinite(value)) return 8;
    return Math.max(0, Math.min(10, value));
  })();
  const reviewFix = extractReviewFixContext(params);
  if (!reviewFix) {
    const mergeConflict = extractMergeConflictReviewContext(params);
    if (mergeConflict) {
      return {
        mode: "merge_conflict",
        maxAutoRevisions: baseMaxAutoRevisions,
        softPassOnExhausted: baseSoftPassOnExhausted,
        criticMinScore: baseCriticMinScore,
      };
    }
    return {
      mode: "default",
      maxAutoRevisions: baseMaxAutoRevisions,
      softPassOnExhausted: baseSoftPassOnExhausted,
      criticMinScore: baseCriticMinScore,
    };
  }
  const tightenedCriticMinScore =
    reviewFix.reviewThreshold != null
      ? Math.max(baseCriticMinScore, Math.max(0, Math.min(10, reviewFix.reviewThreshold - 0.2)))
      : baseCriticMinScore;
  return {
    mode: "review_fix",
    maxAutoRevisions: Math.max(baseMaxAutoRevisions, 2),
    softPassOnExhausted: baseSoftPassOnExhausted,
    criticMinScore: tightenedCriticMinScore,
  };
}

function normalizeChatCompletionsEndpoint(endpoint: string): string {
  const source = endpoint.trim().replace(/\/+$/, "");
  if (!source) return "http://127.0.0.1:1234/v1/chat/completions";
  if (source.endsWith("/chat/completions")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current.length > 0) out.push(current);
  return out;
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

const COMMIT_MSG_MAX_DIFF_CHARS = 120_000;

const SHELL_CONTROL_TOKENS = new Set(["&&", "||", ";", "|"]);

export function tokenizeValidationCommandArgv(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    if (!current) return;
    out.push(current);
    current = "";
  };

  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  pushCurrent();
  if (out.length === 0) return null;
  if (out.some((token) => SHELL_CONTROL_TOKENS.has(token))) return null;
  return out;
}

async function runValidationCommand(
  repo: string,
  command: string,
  timeoutMs: number,
  outputPolicy: Partial<OutputCompactionPolicy>,
): Promise<ValidationExecutionResult> {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv) {
    return {
      step: command,
      command,
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr:
        "Validation command could not be parsed safely. Use a plain command without shell chaining/pipes.",
      elapsedMs: 1,
    };
  }
  const startedAt = Date.now();
  const proc = Bun.spawn(argv, {
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
    stdout: compactJobOutput(stdout.trim(), outputPolicy),
    stderr: compactJobOutput(stderr.trim(), outputPolicy),
    elapsedMs: Math.max(1, Date.now() - startedAt),
  };
}

function extractPreparedMergeConflictPaths(params: Record<string, unknown>): string[] {
  const reviewAgent =
    params.reviewAgent && typeof params.reviewAgent === "object" && !Array.isArray(params.reviewAgent)
      ? (params.reviewAgent as Record<string, unknown>)
      : null;
  const preparedPaths = Array.isArray(reviewAgent?.preparedConflictPaths)
    ? reviewAgent.preparedConflictPaths
    : [];
  return preparedPaths
    .map((entry) => String(entry ?? "").trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function detectValidationBlocker(runs: ValidationExecutionResult[]): ValidationBlocker | null {
  const combined = runs
    .flatMap((run) => [run.stdout, run.stderr])
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!combined) return null;

  if (
    combined.includes("cannot find module") ||
    combined.includes("module not found") ||
    combined.includes("failed to resolve import") ||
    combined.includes("could not resolve") ||
    combined.includes("no such file or directory") ||
    combined.includes("package not found")
  ) {
    return {
      category: "repo",
      detail:
        "Validation is blocked by missing repo dependencies or imported files. Fix the repository test/runtime setup before retrying this job.",
    };
  }

  if (
    combined.includes("read-only file system") ||
    combined.includes("permission denied") ||
    combined.includes("network access") ||
    combined.includes("connection refused") ||
    combined.includes("getaddrinfo") ||
    combined.includes("eacces")
  ) {
    return {
      category: "environment",
      detail:
        "Validation is blocked by sandbox environment restrictions (filesystem, permissions, or network). Retry only after the worker environment is fixed.",
    };
  }

  return null;
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

export function inferFallbackValidationCommandsForTestTask(
  instruction: string,
  targetPath: string | undefined,
  planning: TaskExecutePlanning,
  changedTestPaths: string[],
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  const lowerInstruction = instruction.toLowerCase();
  const pythonSignal =
    /\b(pytest|python)\b/.test(lowerInstruction) ||
    changedTestPaths.some((entry) => entry.toLowerCase().endsWith(".py"));

  const normalizedTarget = (targetPath ?? "").replace(/\\/g, "/").trim();
  if (normalizedTarget && isLikelyTestPath(normalizedTarget)) {
    add(pythonSignal ? `pytest ${normalizedTarget}` : `bun test ${normalizedTarget}`);
  }

  if (changedTestPaths.length > 0) {
    const focused = changedTestPaths.slice(0, 4).join(" ");
    add(pythonSignal ? `pytest ${focused}` : `bun test ${focused}`);
  }

  const scopeHints = [
    targetPath ?? "",
    ...(planning.targetPaths ?? []),
    ...(planning.scope.writeGlobs ?? []),
    ...(planning.discovery?.likelyDirs ?? []),
  ]
    .map((entry) => entry.replace(/\\/g, "/").trim())
    .filter(Boolean);
  const appRoot = scopeHints
    .map((entry) => {
      const match = entry.match(/^apps\/[^/]+/i);
      return match?.[0] ?? "";
    })
    .find(Boolean);
  if (appRoot) {
    add(pythonSignal ? `pytest ${appRoot}` : `bun --cwd ${appRoot} test`);
  }

  // Prefer scoped validation; only fall back to full-suite test runs when no scope is available.
  if (candidates.length === 0) {
    add(pythonSignal ? "pytest" : "bun test");
  }
  return candidates.slice(0, 4);
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
    /(\.not\b|\b(invalid|negative|error|throw|reject|null|undefined|non[- ]?existent|toThrow|toBeNull|toBeUndefined|without|missing|absent|unchanged|same|remains?|stays?|prevent|avoid|zero|none)\b|<\s*0|<=\s*0)/i;
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
  runtimeConfig: WorkerpalsRuntimeConfig,
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
      blocker: null,
    };
  }

  const statusResult = await git(repo, ["status", "--porcelain"]);
  const changedPaths = statusResult.ok ? parseChangedPathsFromStatus(statusResult.stdout) : [];
  const preparedMergeConflictPaths = extractPreparedMergeConflictPaths(params);
  const changedTestPaths = Array.from(
    new Set(
      [...changedPaths, ...preparedMergeConflictPaths].filter((path) => isLikelyTestPath(path)),
    ),
  );
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
  const fallbackValidationSteps =
    runnableSteps.length === 0
      ? inferFallbackValidationCommandsForTestTask(
          instruction,
          targetPath,
          planning,
          changedTestPaths,
        )
      : [];
  const commandsToRun = runnableSteps.length > 0 ? runnableSteps : fallbackValidationSteps;
  const validationRuns: ValidationExecutionResult[] = [];
  const outputPolicy = outputPolicyForRuntime(runtimeConfig);
  const qualityValidationStepTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityValidationStepTimeoutMs);
    if (!Number.isFinite(value)) return 180_000;
    return Math.max(1_000, Math.min(7_200_000, Math.floor(value)));
  })();
  if (commandsToRun.length === 0) {
    issues.push(
      "No runnable validation command was provided in planning.validationSteps (expected at least one test command).",
    );
  } else {
    if (runnableSteps.length === 0) {
      onLog?.(
        "stdout",
        `[QualityGate] No runnable planning.validationSteps found; using fallback validation command(s): ${commandsToRun.join(" | ")}`,
      );
    }
    for (const command of commandsToRun) {
      onLog?.("stdout", `[QualityGate] Quality gate validation: running "${command}"`);
      const run = await runValidationCommand(
        repo,
        command,
        qualityValidationStepTimeoutMs,
        outputPolicy,
      );
      validationRuns.push(run);
      const runSummary = `[QualityGate] Quality gate validation ${run.ok ? "passed" : "failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}`;
      onLog?.(run.ok ? "stdout" : "stderr", runSummary);
    }
    // exit 127 = command not found: separate tool-availability issues from real test failures.
    const notFoundRuns = validationRuns.filter((run) => run.exitCode === 127);
    const executedRuns = validationRuns.filter((run) => run.exitCode !== 127);
    if (notFoundRuns.length > 0) {
      const cmds = notFoundRuns.map((run) => run.command).join(", ");
      onLog?.(
        "stderr",
        `[QualityGate] Some validation commands not found (exit 127 — wrong tool?): ${cmds}. This project uses Bun: prefer "bun test".`,
      );
    }
    if (executedRuns.length > 0 && executedRuns.every((run) => !run.ok)) {
      issues.push("Validation commands were executed but none passed.");
    } else if (executedRuns.length === 0 && notFoundRuns.length > 0) {
      issues.push(
        'No validation command could be run (command not found). Use "bun test" or another available test runner.',
      );
    }
    if (
      !validationRuns.some((run) => /\b(test|pytest|coverage|vitest|jest)\b/i.test(run.command))
    ) {
      issues.push("Validation steps did not execute a recognizable test command.");
    }
  }
  const blocker = detectValidationBlocker(validationRuns);

  return {
    ok: issues.length === 0 && blocker === null,
    skipped: false,
    issues,
    changedPaths,
    changedTestPaths,
    validationRuns,
    blocker,
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
  const qualityCriticMaxDiffChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
    if (!Number.isFinite(value)) return 16_000;
    return Math.max(256, Math.min(524_288, Math.floor(value)));
  })();
  const qualityCriticMaxValidationOutputChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
    if (!Number.isFinite(value)) return 8_000;
    return Math.max(256, Math.min(524_288, Math.floor(value)));
  })();
  const qualityCriticTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
    if (!Number.isFinite(value)) return 45_000;
    return Math.max(1_000, Math.min(7_200_000, Math.floor(value)));
  })();
  diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(
    0,
    qualityCriticMaxDiffChars,
  );

  const validationSummary = quality.validationRuns
    .map((run) => {
      const output = [run.stdout, run.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(0, qualityCriticMaxValidationOutputChars);
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
  const acceptanceCriteriaText =
    planning.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const validationStepsText =
    planning.validationSteps.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const changedPathsText =
    quality.changedPaths.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const criticSystem = loadPromptTemplate("workerpals/task_quality_critic_system_prompt.md").trim();
  const criticUser = loadPromptTemplate("workerpals/task_quality_critic_user_prompt.md", {
    instruction,
    acceptance_criteria: acceptanceCriteriaText,
    validation_steps: validationStepsText,
    changed_paths: changedPathsText,
    diff_excerpt: diffText || "(empty diff excerpt)",
    validation_evidence: validationSummary || "(no validation output)",
  });

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
    const timer = setTimeout(() => controller.abort(), qualityCriticTimeoutMs);
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
      raw: compactJobOutput(content, outputPolicyForRuntime(runtimeConfig)),
    };
  } catch (err) {
    onLog?.(
      "stderr",
      `[QualityGate] Critic review unavailable: ${toSingleLine(err, 220)} (continuing without critic gate).`,
    );
    return null;
  }
}

export function buildQualityRevisionHint(
  issues: string[],
  critic: CriticReview | null,
  planning: TaskExecutePlanning,
  reviewFixContext?: ReviewFixContext | null,
): string {
  const lines: string[] = [];
  lines.push("Quality revision required before completion.");
  if (reviewFixContext) {
    lines.push("Rejected PR retry requirements:");
    if (reviewFixContext.previousReviewScore != null) {
      lines.push(
        `Previous ReviewAgent score: ${reviewFixContext.previousReviewScore.toFixed(1)} / 10`,
      );
    }
    if (reviewFixContext.reviewThreshold != null) {
      lines.push(
        `Required approval threshold: ${reviewFixContext.reviewThreshold.toFixed(1)} / 10`,
      );
    }
    if (reviewFixContext.previousReviewSummary) {
      lines.push(
        `Previous reviewer summary: ${toSingleLine(reviewFixContext.previousReviewSummary, 220)}`,
      );
    }
    if (reviewFixContext.reviewerFindings.length > 0) {
      lines.push("Previous reviewer must-fix items:");
      for (const finding of reviewFixContext.reviewerFindings.slice(0, 5)) {
        lines.push(`- ${finding}`);
      }
    }
    lines.push("Raise the score above the approval threshold without reopening already accepted behavior.");
  }
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

function normalizeChangedPathForCommit(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;

  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1).trim();
  }

  // Git may emit escaped spaces in some contexts.
  path = path.replace(/\\ /g, " ").replace(/\\/g, "/");

  if (path === "." || path === "/repo" || path === "/workspace") return null;
  if (path.startsWith("/repo/")) path = path.slice("/repo/".length);
  else if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/")) return null;
  if (/^[A-Za-z]:[\\/]/.test(path)) return null;

  path = path
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!path || path === ".") return null;

  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return null;
  }

  return path;
}

export function parseChangedPathsFromNameOnlyOutput(output: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const path = normalizeChangedPathForCommit(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
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
  const defaultPublicBranchName = `agent/${workerId}/${job.id}`;
  const reviewAgentHeadRef =
    job.params?.reviewAgent &&
    typeof job.params.reviewAgent === "object" &&
    !Array.isArray(job.params.reviewAgent)
      ? (job.params.reviewAgent as Record<string, unknown>).prHeadRef
      : undefined;
  const resolvedPublicBranch = resolveReviewFixCompletionBranch(
    job.params?.completionBranch ?? reviewAgentHeadRef,
    defaultPublicBranchName,
  );
  const publicBranchName = resolvedPublicBranch.branch;
  if (extractMergeConflictReviewContext(job.params ?? null)) {
    return createMergeConflictJobCommit(repo, workerId, job, publicBranchName, runtimeConfig);
  }
  const requirePush = runtimeConfig.workerpals.requirePush || resolvedPublicBranch.overridden;
  const pushAgentBranch =
    requirePush || runtimeConfig.workerpals.pushAgentBranch || resolvedPublicBranch.overridden;
  // Keep worker refs out of refs/heads so user-visible branch lists stay clean.
  const hiddenCommitRef = `refs/pushpals/agent/${workerId}/${job.id}`;
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

    // Generate commit message from actual staged diff; fall back to deterministic.
    const cachedDiff = await git(repo, ["diff", "--cached"]);
    const diff = cachedDiff.ok ? cachedDiff.stdout : "";
    const cachedNameOnly = await git(repo, ["diff", "--cached", "--name-only"]);
    const changedPaths = cachedNameOnly.ok
      ? parseChangedPathsFromNameOnlyOutput(cachedNameOnly.stdout)
      : [];
    const jobPlanning = job.params?.planning as Record<string, unknown> | undefined;
    const jobValidationSteps = toNonEmptyStringArray(
      jobPlanning?.validationSteps ?? job.params?.validationSteps,
    );
    const llmCommitMsg = await generateCommitMessageFromDiff(
      diff,
      {
        instruction: String(job.params?.instruction ?? ""),
        type: normalizeCommitType(job.kind, job.params),
        area: inferCommitArea(job.kind, job.params, changedPaths),
        validationSteps: jobValidationSteps,
      },
      repo,
      runtimeConfig,
    ).catch(() => null);
    if (!llmCommitMsg) {
      console.warn(
        `[WorkerPals] Commit message generator unavailable for job ${job.id}; using deterministic fallback.`,
      );
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);

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
    let sha = result.stdout;

    // Persist commit under an internal ref so it remains reachable after worktree cleanup.
    result = await git(repo, ["update-ref", hiddenCommitRef, sha]);
    if (!result.ok) {
      return { ok: false, error: `Failed to store worker commit ref: ${result.stderr}` };
    }
    hiddenRefCreated = true;

    // Push branch to origin (optional; disabled by default for shared-.git workflows)
    if (pushAgentBranch) {
      const maxPushAttempts = 3;
      let pushed = false;
      let pushError = "";
      for (let attempt = 1; attempt <= maxPushAttempts; attempt++) {
        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          repo,
          hiddenCommitRef,
          publicBranchName,
          job.id,
        );
        if (!sync.ok) {
          pushError = `Failed to sync branch before push: ${redactSensitiveText(sync.error)}`;
          break;
        }
        sha = sync.sha;

        result = await git(repo, [
          "push",
          "origin",
          `${hiddenCommitRef}:refs/heads/${publicBranchName}`,
        ]);
        if (result.ok) {
          completionRef = publicBranchName;
          pushed = true;
          break;
        }

        pushError = `Failed to push branch: ${redactSensitiveText(result.stderr || result.stdout)}`;
        if (attempt < maxPushAttempts && isNonFastForwardPushOutput(pushError)) {
          console.warn(
            `[WorkerPals] Push rejected as non-fast-forward for ${publicBranchName}; retrying after git pull --rebase (attempt ${attempt + 1}/${maxPushAttempts}).`,
          );
          continue;
        }
        break;
      }

      if (!pushed) {
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

function inferCommitArea(
  kind: string,
  params?: Record<string, unknown>,
  changedPaths: string[] = [],
): string {
  const explicit = String(params?.area ?? params?.scope ?? params?.component ?? "").trim();
  if (explicit) return normalizeCommitArea(explicit);

  const targets =
    changedPaths.length > 0
      ? changedPaths
      : buildStageTargets(kind, params).filter((p) => p !== ".");
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

function summarizeScope(
  kind: string,
  params?: Record<string, unknown>,
  changedPaths: string[] = [],
): string {
  const targets =
    changedPaths.length > 0
      ? changedPaths
      : buildStageTargets(kind, params).filter((p) => p !== ".");
  if (targets.length === 0) return "repository-level changes";
  const visible = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `${visible}, +${targets.length - 3} more` : visible;
}

function isDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith("docs/") ||
    lower.startsWith("wiki/") ||
    lower === "readme.md" ||
    lower.endsWith(".md")
  );
}

function isTestPath(path: string): boolean {
  return /(?:^|[/\\])tests?[/\\]|\.test\.[a-z0-9]+$|\.spec\.[a-z0-9]+$/i.test(path);
}

function humanizeCommitArea(area: string): string {
  switch (area) {
    case "local_agent":
      return "localbuddy";
    case "remote_agent":
      return "remotebuddy";
    case "source_control_manager":
      return "source control manager";
    default:
      return area.replace(/_/g, " ");
  }
}

function deriveSummary(
  action: string,
  params?: Record<string, unknown>,
  changedPaths: string[] = [],
  areaHint = "worker",
): string {
  const explicit = sanitizeCommitValue(params?.commitSummary, 72);
  if (explicit) return explicit;

  if (changedPaths.length > 0) {
    const label = humanizeCommitArea(areaHint);
    const testCount = changedPaths.filter(isTestPath).length;
    const docCount = changedPaths.filter(isDocPath).length;
    const codeCount = changedPaths.length - testCount - docCount;

    if (testCount > 0 && codeCount === 0 && docCount === 0) {
      return sanitizeCommitValue(`expand ${label} test coverage`, 72);
    }
    if (docCount > 0 && codeCount === 0 && testCount === 0) {
      return sanitizeCommitValue(`update ${label} documentation`, 72);
    }
    if (testCount > 0 && codeCount > 0) {
      return sanitizeCommitValue(`update ${label} implementation and test coverage`, 72);
    }
    if (codeCount > 0) {
      return sanitizeCommitValue(`update ${label} implementation`, 72);
    }
  }

  const raw = sanitizeCommitValue(action, 72);
  if (!raw) return "apply requested repository update";
  return raw;
}

/** Returns true for acceptance criteria that are generic boilerplate with no commit signal. */
function isBoilerplateCriterion(criterion: string): boolean {
  return /produce a correct and helpful result|complete the requested task|accomplish the (?:stated )?goal|provide a (?:correct|good|helpful) (?:solution|result|answer)|the task (?:is|should be) completed|successfully complete(?:d)? the task/i.test(
    criterion,
  );
}

function buildChangedPathImplementationPoints(changedPaths: string[]): string {
  if (changedPaths.length === 0) return "";
  const lines: string[] = [];
  for (const path of changedPaths.slice(0, 6)) {
    if (isTestPath(path)) {
      lines.push(`- add or update tests in ${sanitizeCommitValue(path, 220)}`);
    } else if (isDocPath(path)) {
      lines.push(`- update documentation in ${sanitizeCommitValue(path, 220)}`);
    } else {
      lines.push(`- update ${sanitizeCommitValue(path, 220)}`);
    }
  }
  if (changedPaths.length > 6) {
    lines.push(`- update +${changedPaths.length - 6} additional file(s)`);
  }
  return lines.join("\n");
}

function buildImplementationPoints(
  kind: string,
  params?: Record<string, unknown>,
  changedPaths: string[] = [],
): string {
  // 1. Explicit commit points take highest priority (set by dispatcher or worker).
  const explicitPoints = toNonEmptyStringArray(
    params?.commitPoints ?? params?.changeDetails ?? params?.implementationPoints,
  );
  if (explicitPoints.length > 0) {
    return explicitPoints
      .slice(0, 8)
      .map((point) => `- ${sanitizeCommitValue(point, 220)}`)
      .join("\n");
  }

  // 2. Use acceptance criteria from planning as implementation bullets, but only
  //    when they describe specific outcomes (not generic boilerplate phrases).
  const planning =
    params && typeof params.planning === "object" && !Array.isArray(params.planning)
      ? (params.planning as Record<string, unknown>)
      : undefined;
  const criteria = toNonEmptyStringArray(
    planning?.acceptanceCriteria ?? planning?.acceptance_criteria,
  ).filter((criterion) => !isBoilerplateCriterion(criterion));
  if (criteria.length > 0) {
    return criteria
      .slice(0, 6)
      .map((criterion) => `- ${sanitizeCommitValue(criterion, 220)}`)
      .join("\n");
  }

  // 3. Use actual changed file paths when available.
  const fromChangedPaths = buildChangedPathImplementationPoints(changedPaths);
  if (fromChangedPaths) return fromChangedPaths;

  // 4. Fall back to staged target hints.
  const targets = buildStageTargets(kind, params).filter((target) => target !== ".");
  if (targets.length === 0) return "";
  const lines: string[] = [];
  for (const target of targets.slice(0, 5)) {
    lines.push(`- update ${sanitizeCommitValue(target, 220)}`);
  }
  if (targets.length > 5) {
    lines.push(`- update +${targets.length - 5} additional file(s)`);
  }
  return lines.join("\n");
}

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => sanitizeCommitValue(entry, 240)).filter((entry) => entry.length > 0);
}

/** Returns true only for validation steps that invoke a recognizable test runner. */
export function isTestLikeValidationStep(step: string): boolean {
  const classify = (candidate: string): boolean => {
    const argv = tokenizeValidationCommandArgv(candidate);
    if (!argv || argv.length === 0) return false;
    const tool = argv[0].toLowerCase();
    const hasToken = (token: string) => argv.some((entry) => entry.toLowerCase() === token);

    switch (tool) {
      case "bun":
      case "npm":
      case "pnpm":
      case "yarn": {
        // "bun test", "npm test", "yarn test"
        if (hasToken("test")) return true;
        const sub = argv[1]?.toLowerCase() ?? "";
        // "bun run test:root", "npm run test:unit", "pnpm run test:integration"
        if (sub === "run" && argv[2]?.toLowerCase().startsWith("test")) return true;
        // "yarn test:integration" — second token itself starts with "test"
        if (sub.startsWith("test")) return true;
        // "bun ./tests/file.ts" or "bun ./path/to/foo.test.ts" — direct execution
        if (tool === "bun") {
          return argv
            .slice(1)
            .some((arg) => /(?:^|[/\\])tests?[/\\]|\.test\.[a-z]+$|\.spec\.[a-z]+$/i.test(arg));
        }
        return false;
      }
      case "pytest":
      case "vitest":
      case "jest":
        return true;
      case "python":
        return (
          argv.length >= 3 && argv[1].toLowerCase() === "-m" && argv[2].toLowerCase() === "pytest"
        );
      case "coverage":
        return hasToken("pytest");
      default:
        return false;
    }
  };

  if (classify(step)) return true;
  // Also check commands wrapped in backticks (e.g. "Run `bun --cwd apps/localbuddy test`").
  const fenced = step.match(/`([^`]+)`/)?.[1]?.trim() ?? "";
  return fenced ? classify(fenced) : false;
}

function buildCommitTestsBlock(params?: Record<string, unknown>): string {
  const planning =
    params && typeof params.planning === "object" && !Array.isArray(params.planning)
      ? (params.planning as Record<string, unknown>)
      : undefined;

  const candidates = [
    ...toNonEmptyStringArray(params?.validationSteps),
    ...toNonEmptyStringArray(params?.validation_steps),
    ...toNonEmptyStringArray(planning?.validationSteps),
    ...toNonEmptyStringArray(planning?.validation_steps),
  ];

  const seen = new Set<string>();
  const unique = candidates
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .filter(isTestLikeValidationStep);

  if (unique.length === 0) return "- not run (no test commands provided)";
  return unique.map((entry) => `- ${entry}`).join("\n");
}

function shouldIncludeCommitMeta(params?: Record<string, unknown>): boolean {
  return (
    parseBooleanFlag(params?.commitIncludeMeta) ||
    parseBooleanFlag(params?.includeCommitMeta) ||
    parseBooleanFlag(params?.commit_meta)
  );
}

function buildCommitMetaBlock(
  kind: string,
  params: Record<string, unknown> | undefined,
  replacements: {
    worker_id: string;
    task_id: string;
    job_id: string;
    context: string;
    session_line: string;
  },
  changedPaths: string[] = [],
): string {
  const lines = [
    "Meta:",
    `- scope: ${sanitizeCommitValue(summarizeScope(kind, params, changedPaths), 220)}`,
    `- job kind: ${sanitizeCommitValue(kind, 64)}`,
    `- traceability: worker ${replacements.worker_id}, task ${replacements.task_id}, job ${replacements.job_id}`,
    `- execution context: ${replacements.context}`,
  ];
  if (replacements.session_line) lines.push(replacements.session_line);
  return `\n\n${lines.join("\n")}`;
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

function combinedGitOutput(result: { stdout: string; stderr: string }): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

export function isNonFastForwardPushOutput(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("non-fast-forward") ||
    normalized.includes("fetch first") ||
    normalized.includes("failed to push some refs") ||
    normalized.includes("updates were rejected because") ||
    normalized.includes("tip is behind its remote counterpart")
  );
}

export function isRebaseConflictOutput(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("conflict") ||
    normalized.includes("resolve all conflicts manually") ||
    normalized.includes("could not apply") ||
    normalized.includes("fix conflicts and then run")
  );
}

export function isRebaseEditorPromptOutput(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("terminal is dumb, but editor unset") ||
    normalized.includes("please supply the message using either -m or -f option") ||
    normalized.includes("waiting for your editor to close the file")
  );
}

export function isPullRebaseDirtyWorkingTreeOutput(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("cannot pull with rebase: you have unstaged changes") ||
    normalized.includes("cannot rebase: you have unstaged changes") ||
    normalized.includes("please commit or stash them")
  );
}

async function currentRefSha(repo: string, ref: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", ref]);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function currentBranchName(repo: string): Promise<string | null> {
  const result = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function gitDirPath(repo: string): Promise<string | null> {
  const result = await git(repo, ["rev-parse", "--git-dir"]);
  if (!result.ok) return null;
  const gitDir = result.stdout.trim();
  if (!gitDir) return null;
  return resolve(repo, gitDir);
}

async function activeGitOperation(repo: string): Promise<"rebase" | "merge" | "cherry-pick" | null> {
  const gitDir = await gitDirPath(repo);
  if (!gitDir) return null;
  if (existsSync(resolve(gitDir, "rebase-merge")) || existsSync(resolve(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(resolve(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(resolve(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  return null;
}

export async function resumePreparedMergeConflictRebase(
  repo: string,
  kind: string,
  params?: Record<string, unknown>,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<
  | { ok: true; resumed: boolean; sequencer: "rebase" | "merge" | "cherry-pick" | null; detail?: string }
  | { ok: false; error: string }
> {
  const sequencer = await activeGitOperation(repo);
  if (sequencer !== "rebase") {
    return { ok: true, resumed: false, sequencer };
  }

  const unresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
  if (!unresolved.ok) {
    return {
      ok: false,
      error: `Failed to inspect unresolved merge-conflict paths: ${combinedGitOutput(unresolved)}`,
    };
  }
  const unresolvedPaths = parseChangedPathsFromNameOnlyOutput(unresolved.stdout);
  if (unresolvedPaths.length > 0) {
    const stillMarked = unresolvedPaths.filter((relativePath) => {
      try {
        const contents = readFileSync(resolve(repo, relativePath), "utf8");
        return /^(<{7}|={7}|>{7})( .*)?$/m.test(contents);
      } catch {
        return true;
      }
    });
    if (stillMarked.length > 0) {
      return {
        ok: true,
        resumed: false,
        sequencer,
        detail: `rebase still has ${stillMarked.length} unresolved conflict marker file(s)`,
      };
    }
    onLog?.(
      "stdout",
      `[MergeConflict] Found ${unresolvedPaths.length} resolved-but-unstaged conflict file(s); staging them before continuing the rebase.`,
    );
  }

  let stageResult: { ok: boolean; stdout: string; stderr: string };
  const stageArgs = buildStageCommand(kind, params);
  if (stageArgs) {
    stageResult = await git(repo, stageArgs);
    if (!stageResult.ok) {
      const stageErr = stageResult.stderr || stageResult.stdout;
      if (
        /pathspec .* did not match any files/i.test(stageErr) ||
        /invalid path/i.test(stageErr) ||
        /outside repository/i.test(stageErr)
      ) {
        onLog?.(
          "stdout",
          `[MergeConflict] Stage target invalid/missing for ${kind}; retrying with fallback "git add -A".`,
        );
        stageResult = await git(repo, [
          "add",
          "-A",
          "--",
          ".",
          ":(exclude)workspace/**",
          ":(exclude)outputs/**",
        ]);
      }
    }
  } else {
    stageResult = await git(repo, [
      "add",
      "-A",
      "--",
      ".",
      ":(exclude)workspace/**",
      ":(exclude)outputs/**",
    ]);
  }
  if (!stageResult.ok) {
    return {
      ok: false,
      error:
        "Failed to stage resolved merge-conflict changes before continuing rebase: " +
        combinedGitOutput(stageResult),
    };
  }

  let rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
  let continueOutput = combinedGitOutput(rebaseContinue);
  if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
    rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    continueOutput = combinedGitOutput(rebaseContinue);
  }
  if (!rebaseContinue.ok) {
    return {
      ok: false,
      error: `Failed to continue prepared merge-conflict rebase: ${continueOutput}`,
    };
  }

  const remainingSequencer = await activeGitOperation(repo);
  if (!remainingSequencer) {
    onLog?.(
      "stdout",
      "[MergeConflict] Auto-continued the prepared rebase after the executor returned with no unresolved conflicts.",
    );
  }
  return {
    ok: true,
    resumed: true,
    sequencer: remainingSequencer,
    detail:
      remainingSequencer === "rebase"
        ? "rebase advanced but another continuation step is still required"
        : undefined,
  };
}

async function isAncestorRef(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.ok;
}

async function refreshMergeConflictTrackingRefs(
  repo: string,
  publicBranchName: string,
  baseBranchName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const refspecs = [
    `+refs/heads/${publicBranchName}:refs/remotes/origin/${publicBranchName}`,
    `+refs/heads/${baseBranchName}:refs/remotes/origin/${baseBranchName}`,
  ];
  const fetch = await git(repo, ["fetch", "--quiet", "origin", ...new Set(refspecs)]);
  if (!fetch.ok) {
    return {
      ok: false,
      error: `Failed to refresh merge-conflict refs for ${publicBranchName}: ${redactSensitiveText(fetch.stderr || fetch.stdout)}`,
    };
  }
  return { ok: true };
}

async function createMergeConflictJobCommit(
  repo: string,
  workerId: string,
  job: {
    id: string;
    taskId: string;
    kind: string;
    params?: Record<string, unknown>;
  },
  publicBranchName: string,
  runtimeConfig: WorkerpalsRuntimeConfig,
): Promise<{ ok: boolean; branch?: string; sha?: string; error?: string }> {
  const mergeConflictContext = extractMergeConflictReviewContext(job.params ?? null);
  if (!mergeConflictContext) {
    return { ok: false, error: "Merge-conflict context is missing required branch metadata." };
  }

  const sequencer = await activeGitOperation(repo);
  if (sequencer) {
    return {
      ok: false,
      error: `Merge-conflict job ${job.id} left a git ${sequencer} in progress. Finish the ${sequencer} before returning control to WorkerPals.`,
    };
  }

  const refreshed = await refreshMergeConflictTrackingRefs(
    repo,
    publicBranchName,
    mergeConflictContext.baseBranch,
  );
  if (!refreshed.ok) return refreshed;

  const currentBranch = await currentBranchName(repo);
  if (!currentBranch) {
    return {
      ok: false,
      error: `Merge-conflict job ${job.id} must finish on a local branch inside the isolated sandbox, but HEAD is detached.`,
    };
  }

  const remoteHeadSha = await currentRefSha(repo, `refs/remotes/origin/${publicBranchName}`);
  if (
    mergeConflictContext.expectedHeadSha &&
    remoteHeadSha &&
    remoteHeadSha !== mergeConflictContext.expectedHeadSha
  ) {
    return {
      ok: false,
      error:
        `origin/${publicBranchName} moved from expected ${mergeConflictContext.expectedHeadSha.slice(0, 8)} ` +
        `to ${remoteHeadSha.slice(0, 8)} while the job was running. Requeue on the newer branch head instead of overwriting it.`,
    };
  }

  let result: { ok: boolean; stdout: string; stderr: string };
  const stageArgs = buildStageCommand(job.kind, job.params);
  if (!stageArgs) {
    return {
      ok: false,
      error: `Unable to determine files to stage for merge-conflict job kind: ${job.kind}`,
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
        `[WorkerPals] Stage target invalid/missing for merge-conflict job ${job.id}; retrying with fallback "git add -A".`,
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
      return { ok: false, error: `Failed to stage merge-conflict changes: ${result.stderr || result.stdout}` };
    }
  }

  const cachedDiffQuiet = await git(repo, ["diff", "--cached", "--quiet"]);
  let headSha = await currentRefSha(repo, "HEAD");
  if (!headSha) {
    return { ok: false, error: `Failed to resolve HEAD SHA for merge-conflict job ${job.id}.` };
  }

  if (!cachedDiffQuiet.ok) {
    const cachedDiff = await git(repo, ["diff", "--cached"]);
    const diff = cachedDiff.ok ? cachedDiff.stdout : "";
    const cachedNameOnly = await git(repo, ["diff", "--cached", "--name-only"]);
    const changedPaths = cachedNameOnly.ok
      ? parseChangedPathsFromNameOnlyOutput(cachedNameOnly.stdout)
      : [];
    const jobPlanning = job.params?.planning as Record<string, unknown> | undefined;
    const jobValidationSteps = toNonEmptyStringArray(
      jobPlanning?.validationSteps ?? job.params?.validationSteps,
    );
    const llmCommitMsg = await generateCommitMessageFromDiff(
      diff,
      {
        instruction: String(job.params?.instruction ?? ""),
        type: normalizeCommitType(job.kind, job.params),
        area: inferCommitArea(job.kind, job.params, changedPaths),
        validationSteps: jobValidationSteps,
      },
      repo,
      runtimeConfig,
    ).catch(() => null);
    if (!llmCommitMsg) {
      console.warn(
        `[WorkerPals] Commit message generator unavailable for merge-conflict job ${job.id}; using deterministic fallback.`,
      );
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);
    const commit = await git(repo, ["commit", "-m", commitMsg]);
    if (!commit.ok) {
      return { ok: false, error: `Failed to commit merge-conflict resolution: ${commit.stderr}` };
    }
    headSha = await currentRefSha(repo, "HEAD");
    if (!headSha) {
      return { ok: false, error: `Failed to resolve committed HEAD SHA for merge-conflict job ${job.id}.` };
    }
  }

  const baseRemoteRef = `refs/remotes/origin/${mergeConflictContext.baseBranch}`;
  const rebasedOntoBase = await isAncestorRef(repo, baseRemoteRef, "HEAD");
  if (!rebasedOntoBase) {
    return {
      ok: false,
      error:
        `Merge-conflict job ${job.id} did not finish rebased onto origin/${mergeConflictContext.baseBranch}. ` +
        `Current branch ${currentBranch} must be a descendant of ${baseRemoteRef} before WorkerPals will push it.`,
    };
  }

  if (remoteHeadSha && remoteHeadSha === headSha) {
    return { ok: true, branch: publicBranchName, sha: headSha };
  }

  const pushArgs = [
    "push",
    mergeConflictContext.expectedHeadSha
      ? `--force-with-lease=refs/heads/${publicBranchName}:${mergeConflictContext.expectedHeadSha}`
      : "--force-with-lease",
    "origin",
    `HEAD:refs/heads/${publicBranchName}`,
  ];
  const push = await git(repo, pushArgs);
  if (!push.ok) {
    return {
      ok: false,
      error: `Failed to push rebased merge-conflict branch ${publicBranchName}: ${redactSensitiveText(push.stderr || push.stdout)}`,
    };
  }

  return { ok: true, branch: publicBranchName, sha: headSha };
}

async function autoResolveRebaseConflicts(
  repo: string,
  maxPasses = 8,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let pass = 1; pass <= maxPasses; pass++) {
    const unresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
    if (!unresolved.ok) {
      return {
        ok: false,
        error: `Failed to inspect rebase conflicts: ${combinedGitOutput(unresolved)}`,
      };
    }
    const unresolvedPaths = parseChangedPathsFromNameOnlyOutput(unresolved.stdout);
    if (unresolvedPaths.length > 0) {
      console.warn(
        `[WorkerPals] Rebase conflict detected (${unresolvedPaths.length} file(s)); auto-resolving in favor of worker changes (pass ${pass}/${maxPasses}).`,
      );
      for (const path of unresolvedPaths) {
        // In rebase conflicts, --theirs preserves the worker commit currently being replayed.
        let checkout = await git(repo, ["checkout", "--theirs", "--", path]);
        if (!checkout.ok) {
          checkout = await git(repo, ["checkout", "--ours", "--", path]);
          if (!checkout.ok) {
            return {
              ok: false,
              error: `Failed to resolve rebase conflict for ${path}: ${combinedGitOutput(checkout)}`,
            };
          }
        }
      }
      // Stage resolved tracked files before continuing rebase, without pulling in unrelated untracked artifacts.
      const addAll = await git(repo, ["add", "--update", "--", "."]);
      if (!addAll.ok) {
        return {
          ok: false,
          error: `Failed to stage resolved rebase conflicts: ${combinedGitOutput(addAll)}`,
        };
      }
    }

    let rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    let continueOutput = combinedGitOutput(rebaseContinue);
    if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
      // Ensure rebase continuation stays non-interactive in worker environments.
      rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      continueOutput = combinedGitOutput(rebaseContinue);
    }
    if (rebaseContinue.ok) {
      continue;
    }
    if (/no rebase in progress/i.test(continueOutput)) {
      return { ok: true };
    }
    if (/no changes - did you forget to use 'git add'|nothing to commit/i.test(continueOutput)) {
      const rebaseSkip = await git(repo, ["rebase", "--skip"]);
      if (rebaseSkip.ok) {
        continue;
      }
      const skipOutput = combinedGitOutput(rebaseSkip);
      if (isRebaseConflictOutput(skipOutput)) {
        continue;
      }
      return { ok: false, error: `Failed to skip empty rebase commit: ${skipOutput}` };
    }
    if (isRebaseConflictOutput(continueOutput)) {
      continue;
    }
    return { ok: false, error: `Failed to continue rebase: ${continueOutput}` };
  }
  return {
    ok: false,
    error: `Rebase conflict auto-resolution exceeded ${maxPasses} passes; manual intervention required.`,
  };
}

export async function syncHiddenRefWithRemoteBranchByRebase(
  repo: string,
  hiddenCommitRef: string,
  publicBranchName: string,
  jobId: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const pullRebaseNonInteractive = () =>
    git(repo, [
      "-c",
      "core.editor=true",
      "-c",
      "rebase.autoStash=true",
      "pull",
      "--rebase",
      "origin",
      publicBranchName,
    ]);

  const remoteHead = await git(repo, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${publicBranchName}`,
  ]);
  if (!remoteHead.ok) {
    return {
      ok: false,
      error: `Failed to inspect remote branch ${publicBranchName}: ${combinedGitOutput(remoteHead)}`,
    };
  }
  const remoteExists = remoteHead.stdout.trim().length > 0;
  if (!remoteExists) {
    const sha = await currentRefSha(repo, hiddenCommitRef);
    if (!sha) return { ok: false, error: `Failed to resolve commit SHA for ${hiddenCommitRef}.` };
    return { ok: true, sha };
  }

  const tempBranch = `_pushpals/rebase-${jobId.slice(0, 8)}-${Date.now().toString(36)}`;
  let branchCheckedOut = false;
  try {
    const checkout = await git(repo, ["checkout", "-B", tempBranch, hiddenCommitRef]);
    if (!checkout.ok) {
      return {
        ok: false,
        error: `Failed to prepare temporary rebase branch ${tempBranch}: ${combinedGitOutput(checkout)}`,
      };
    }
    branchCheckedOut = true;

    const maxPullRebaseAttempts = 5;
    let syncedWithRemote = false;
    for (let attempt = 1; attempt <= maxPullRebaseAttempts; attempt++) {
      let pullRebase = await pullRebaseNonInteractive();
      if (!pullRebase.ok && isPullRebaseDirtyWorkingTreeOutput(combinedGitOutput(pullRebase))) {
        // Recover from dirty index/worktree left by previous attempts and retry non-interactively.
        const reset = await git(repo, ["reset", "--hard", "HEAD"]);
        if (!reset.ok) {
          return {
            ok: false,
            error: `Failed to clean working tree before retrying pull --rebase: ${combinedGitOutput(reset)}`,
          };
        }
        pullRebase = await pullRebaseNonInteractive();
      }

      if (pullRebase.ok) {
        syncedWithRemote = true;
        break;
      }

      const pullOutput = combinedGitOutput(pullRebase);
      if (!isRebaseConflictOutput(pullOutput)) {
        return {
          ok: false,
          error: `git pull --rebase failed for ${publicBranchName}: ${pullOutput}`,
        };
      }
      const resolved = await autoResolveRebaseConflicts(repo);
      if (!resolved.ok) {
        await git(repo, ["rebase", "--abort"]);
        return {
          ok: false,
          error: `Rebase conflict resolution failed for ${publicBranchName}: ${resolved.error}`,
        };
      }
      if (attempt < maxPullRebaseAttempts) {
        console.warn(
          `[WorkerPals] Rebase conflicts resolved for ${publicBranchName}; re-running git pull --rebase (attempt ${attempt + 1}/${maxPullRebaseAttempts}).`,
        );
      }
    }
    if (!syncedWithRemote) {
      return {
        ok: false,
        error: `Failed to sync ${publicBranchName} after ${maxPullRebaseAttempts} pull --rebase attempt(s).`,
      };
    }

    const rebasedSha = await currentRefSha(repo, "HEAD");
    if (!rebasedSha) {
      return { ok: false, error: "Failed to resolve rebased commit SHA after pull --rebase." };
    }
    const updateHiddenRef = await git(repo, ["update-ref", hiddenCommitRef, rebasedSha]);
    if (!updateHiddenRef.ok) {
      return {
        ok: false,
        error: `Failed to update hidden commit ref after rebase: ${combinedGitOutput(updateHiddenRef)}`,
      };
    }
    return { ok: true, sha: rebasedSha };
  } finally {
    if (branchCheckedOut) {
      await git(repo, ["checkout", "--detach", hiddenCommitRef]);
      await git(repo, ["branch", "-D", tempBranch]);
    }
  }
}

export function shouldUseCodexCliForExecutor(executor: string): boolean {
  return executor.trim().toLowerCase() === "openai_codex";
}

function normalizeCodexReasoningEffort(
  value: unknown,
  model = "",
): "low" | "medium" | "high" | "xhigh" {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(String(model ?? "").trim());
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized === "xhigh" && !supportsExtraHigh ? "high" : normalized;
  }
  if (
    normalized === "extra high" ||
    normalized === "extra-high" ||
    normalized === "extrahigh" ||
    normalized === "x-high"
  ) {
    return supportsExtraHigh ? "xhigh" : "high";
  }
  return "high";
}

async function generateCommitMessageFromDiff(
  diff: string,
  opts: { instruction: string; type: string; area: string; validationSteps: string[] },
  repo: string,
  runtimeConfig: WorkerpalsRuntimeConfig,
): Promise<string | null> {
  const prompt = buildCommitMessageGeneratorPrompt(diff, opts);
  if (!prompt) return null;
  if (shouldUseCodexCliForExecutor(resolveExecutor(runtimeConfig))) {
    return generateCommitMessageFromDiffViaCodex(prompt, opts, repo, runtimeConfig);
  }
  return generateCommitMessageFromDiffViaHttp(prompt, opts, runtimeConfig);
}

type CommitMessagePrompt = {
  systemPrompt: string;
  userMessage: string;
};

function buildCommitMessageGeneratorPrompt(
  diff: string,
  opts: { instruction: string; type: string; area: string; validationSteps: string[] },
): CommitMessagePrompt | null {
  if (!diff.trim()) return null;
  let systemPrompt: string;
  try {
    systemPrompt = loadPromptTemplate("workerpals/commit_message_prompt.md", {
      type: opts.type,
      area: opts.area,
    }).trim();
    if (!systemPrompt || systemPrompt.includes("{{")) return null;
  } catch {
    return null;
  }
  const userMessage = buildCommitMessageGeneratorUserMessage(
    opts.instruction,
    opts.validationSteps,
    diff,
  );
  return { systemPrompt, userMessage };
}

async function generateCommitMessageFromDiffViaCodex(
  prompt: CommitMessagePrompt,
  opts: { type: string; area: string },
  repo: string,
  runtimeConfig: WorkerpalsRuntimeConfig,
): Promise<string | null> {
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix) return null;
  const model = runtimeConfig.workerpals.llm.model.trim();
  const timeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.llm.codexTimeoutMs);
    if (!Number.isFinite(value)) return 120_000;
    return Math.max(10_000, Math.min(600_000, Math.floor(value)));
  })();
  const reasoningEffort = normalizeCodexReasoningEffort(
    runtimeConfig.workerpals.llm.reasoningEffort,
    model,
  );
  const tmpOutputPath = resolve(
    Bun.env.TEMP || Bun.env.TMP || Bun.env.TMPDIR || "/tmp",
    `pushpals-commit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const cmd = [
    ...codexPrefix,
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-a",
    "never",
    "-s",
    "read-only",
    "exec",
    "--color",
    "never",
    "--output-last-message",
    tmpOutputPath,
  ];
  if (model) cmd.push("-m", model);
  cmd.push("-");

  try {
    const stdinText = `${prompt.systemPrompt}\n\n${prompt.userMessage}`;
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([stdinText]),
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (timedOut || exitCode !== 0) return null;

    let content = "";
    try {
      content = readFileSync(tmpOutputPath, "utf8").trim();
    } catch {
      content = "";
    }
    if (!content) {
      content = (await new Response(proc.stdout).text()).trim();
    }
    if (!content) return null;
    const clean = sanitizeGeneratedCommitMessage(content, opts.type, opts.area);
    return clean;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpOutputPath);
    } catch {
      // ignore
    }
  }
}

async function generateCommitMessageFromDiffViaHttp(
  prompt: CommitMessagePrompt,
  opts: { type: string; area: string },
  runtimeConfig: WorkerpalsRuntimeConfig,
): Promise<string | null> {
  const endpoint = normalizeChatCompletionsEndpoint(runtimeConfig.workerpals.llm.endpoint);
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!endpoint || !model) return null;

  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const payload = parseJsonObjectLoose(await response.text());
    if (!payload) return null;
    const choices = Array.isArray(payload.choices)
      ? (payload.choices as Array<Record<string, unknown>>)
      : [];
    const content = String(
      (choices[0]?.message as Record<string, unknown> | undefined)?.content ?? "",
    ).trim();
    if (!content) return null;
    const clean = sanitizeGeneratedCommitMessage(content, opts.type, opts.area);
    if (!clean) return null;
    return clean;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function buildCommitMessageGeneratorUserMessage(
  instruction: string,
  validationSteps: string[],
  diff: string,
): string {
  const testLines =
    validationSteps
      .filter(isTestLikeValidationStep)
      .map((step) => `- ${step}`)
      .join("\n") || "- (none)";
  return loadPromptTemplate("workerpals/commit_message_user_prompt.md", {
    diff_excerpt: diff.slice(0, COMMIT_MSG_MAX_DIFF_CHARS),
    test_lines: testLines,
    instruction_excerpt: instruction.slice(0, 400),
  });
}

/**
 * Returns true for bullet text that reads like planning/acceptance criteria
 * rather than a concrete description of what the diff changed.
 */
function isPlanningLanguageBullet(bullet: string): boolean {
  return /^at least\b|^all existing\b|^no unrelated\b|\bshould be\b|\bmust be\b|\bwill (pass|work|run|be)\b|\bare (added|modified|changed|updated|created)\b/i.test(
    bullet,
  );
}

export function sanitizeGeneratedCommitMessage(
  content: string,
  type: string,
  area: string,
): string | null {
  // Strip accidental markdown fences.
  const clean = content
    .replace(/^```[^\n]*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  // Sanity check: must open with the expected conventional commit prefix.
  if (!clean.startsWith(`${type}(${area})`)) return null;
  // Reject if the majority of bullet points look like planning/acceptance criteria
  // rather than concrete code-change descriptions derived from the diff.
  const lines = clean.split("\n");
  const testsSectionIndex = lines.findIndex((line) => /^Tests:\s*$/i.test(line.trim()));
  const implementationLines = testsSectionIndex >= 0 ? lines.slice(0, testsSectionIndex) : lines;
  const bullets = implementationLines
    .filter((line) => /^\s*-\s+\S/.test(line) && !/^Tests:/i.test(line.trim()))
    .map((line) => line.replace(/^\s*-\s+/, "").trim());
  const planningCount = bullets.filter(isPlanningLanguageBullet).length;
  if (bullets.length > 0 && planningCount / bullets.length >= 0.67) return null;
  return clean;
}

export function buildWorkerCommitMessage(
  workerId: string,
  job: {
    id: string;
    taskId: string;
    kind: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    context?: "host" | "docker";
  },
  changedPaths: string[] = [],
): string {
  const normalizedChangedPaths = parseChangedPathsFromNameOnlyOutput(changedPaths.join("\n"));
  const action = summarizeJobAction(job.kind, job.params);
  const type = normalizeCommitType(job.kind, job.params);
  const area = inferCommitArea(job.kind, job.params, normalizedChangedPaths);
  const summary = deriveSummary(action, job.params, normalizedChangedPaths, area);
  const implementationPoints =
    buildImplementationPoints(job.kind, job.params, normalizedChangedPaths) ||
    `- ${sanitizeCommitValue(action, 220) || "apply requested repository update"}`;
  const testsBlock = buildCommitTestsBlock(job.params);
  const lines: string[] = [
    `${sanitizeCommitValue(type, 16)}(${sanitizeCommitValue(area, 48)}): ${sanitizeCommitValue(summary, 72)}`,
    "",
    implementationPoints,
    "",
    "Tests:",
    testsBlock,
  ];
  if (shouldIncludeCommitMeta(job.params)) {
    const contextValue = sanitizeCommitValue(job.context ?? "host", 32);
    const sessionValue = sanitizeCommitValue(job.sessionId ?? "", 128);
    lines.push(
      buildCommitMetaBlock(
        job.kind,
        job.params,
        {
          worker_id: sanitizeCommitValue(workerId, 64),
          task_id: sanitizeCommitValue(job.taskId, 128),
          job_id: sanitizeCommitValue(job.id, 128),
          context: contextValue || "host",
          session_line: sessionValue ? `- session: ${sessionValue}` : "",
        },
        normalizedChangedPaths,
      ),
    );
  }
  return lines.join("\n");
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

function asAutonomyComponentArea(value: unknown): AutonomyComponentArea | null {
  return normalizeAutonomyComponentArea(value);
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

async function collectWriteScopeWarnings(
  repo: string,
  planning: TaskExecutePlanning,
): Promise<{ warnings: string[] }> {
  const writeGlobs = toStringArray(planning.scope.writeGlobs ?? []);
  if (writeGlobs.length === 0) return { warnings: [] };

  const statusResult = await git(repo, ["status", "--porcelain"]);
  if (!statusResult.ok) {
    return { warnings: ["Unable to evaluate changed paths for scope suggestion check."] };
  }

  const changedPaths = parseChangedPathsFromStatus(statusResult.stdout)
    .map((entry) => normalizeStagePath(entry))
    .filter((entry): entry is string => Boolean(entry) && entry !== ".");
  if (changedPaths.length === 0) return { warnings: [] };

  const forbidden = toStringArray(planning.scope.forbiddenGlobs ?? []);
  const warnings: string[] = [];
  const outOfScope = changedPaths.filter(
    (path) => !writeGlobs.some((glob) => matchesGlob(path, glob)),
  );
  if (outOfScope.length > 0) {
    warnings.push(`Scope suggestion: modified paths outside writeGlobs: ${outOfScope.join(", ")}`);
  }
  const forbiddenTouched = changedPaths.filter((path) =>
    forbidden.some((glob) => matchesGlob(path, glob)),
  );
  if (forbiddenTouched.length > 0) {
    warnings.push(
      `Scope suggestion: modified paths matching forbiddenGlobs: ${forbiddenTouched.join(", ")}`,
    );
  }
  return { warnings };
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
    const normalizedWriteGlobs = isStringArray(scope.writeGlobs)
      ? toStringArray(scope.writeGlobs)
      : [];
    if (origin === "autonomy") {
      const declaredComponentArea = asAutonomyComponentArea(options?.autonomyComponentArea);
      const inferredComponentArea = deriveAutonomyComponentArea(
        normalizedTargetPaths,
        normalizedWriteGlobs,
      );
      const componentArea = declaredComponentArea ?? inferredComponentArea;
      if (!componentArea) {
        return {
          ok: false,
          message:
            "task.execute planning.targetPaths must resolve to a repo-relative componentArea",
        };
      }
      if (
        declaredComponentArea &&
        inferredComponentArea &&
        declaredComponentArea !== inferredComponentArea
      ) {
        return {
          ok: false,
          message: "task.execute planning.targetPaths do not match autonomy componentArea",
        };
      }
      const validatedScope = validateScopeInvariants(
        componentArea,
        normalizedTargetPaths,
        normalizedWriteGlobs,
        { requireWriteGlobs: false },
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

// ─── Codex-based critic (used when executor === "openai_codex") ───────────────

const cachedCodexCommandPrefix = new Map<string, string[]>();

async function canExecuteCodexCommandCandidate(
  repo: string,
  candidate: string[],
): Promise<boolean> {
  if (candidate.length === 0) return false;
  try {
    const proc = Bun.spawn([...candidate, "--version"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, 15_000);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return !timedOut && exitCode === 0;
  } catch {
    return false;
  }
}

async function resolveCodexCommandPrefix(
  repo: string,
  configuredCommand = "",
): Promise<string[] | null> {
  const cacheKey = `${repo}\u0000${configuredCommand.trim()}`;
  const cached = cachedCodexCommandPrefix.get(cacheKey);
  if (cached) return [...cached];

  const candidates: string[][] = [];
  const configured = splitArgs(configuredCommand);
  if (configured.length > 0) candidates.push(configured);
  candidates.push(["bun", "x", "--yes", "@openai/codex"]);
  candidates.push(["bunx", "--yes", "@openai/codex"]);
  candidates.push(["codex"]);

  for (const candidate of candidates) {
    if (await canExecuteCodexCommandCandidate(repo, candidate)) {
      cachedCodexCommandPrefix.set(cacheKey, [...candidate]);
      return candidate;
    }
  }
  return null;
}

async function runCodexCriticReview(
  repo: string,
  params: Record<string, unknown>,
  quality: DeterministicQualityResult,
  runtimeConfig: WorkerpalsRuntimeConfig,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<CriticReview | null> {
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix) {
    onLog?.(
      "stderr",
      "[QualityGate] Codex critic: unable to resolve Codex CLI command (workerpals.llm.codex_bin/PATH); skipping.",
    );
    return null;
  }

  const instruction = String(params.instruction ?? "").trim();
  const planning = params.planning as TaskExecutePlanning;

  const changedForDiff = quality.changedPaths.slice(0, 8);
  let diffText = "";
  const qualityCriticMaxDiffChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
    if (!Number.isFinite(value)) return 16_000;
    return Math.max(256, Math.min(524_288, Math.floor(value)));
  })();
  const qualityCriticMaxValidationOutputChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
    if (!Number.isFinite(value)) return 8_000;
    return Math.max(256, Math.min(524_288, Math.floor(value)));
  })();
  const qualityCriticTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
    if (!Number.isFinite(value)) return 45_000;
    return Math.max(1_000, Math.min(7_200_000, Math.floor(value)));
  })();
  if (changedForDiff.length > 0) {
    const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
    diffText = (diffResult.ok ? diffResult.stdout : diffResult.stderr).slice(
      0,
      qualityCriticMaxDiffChars,
    );
  }

  const validationSummary = quality.validationRuns
    .map((run) => {
      const output = [run.stdout, run.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(0, qualityCriticMaxValidationOutputChars);
      return [
        `Command: ${run.command}`,
        `Result: ${run.ok ? "pass" : "fail"} (exit ${run.exitCode})`,
        output,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n---\n");

  const criticInstruction = loadPromptTemplate(
    "workerpals/codex_quality_critic_instruction_prompt.md",
    {
      instruction,
      acceptance_criteria:
        planning.acceptanceCriteria.map((c) => `- ${c}`).join("\n") || "- (none)",
      changed_paths: quality.changedPaths.join(", ") || "(none)",
      diff_section: diffText ? `Diff:\n${diffText}` : "Diff: (empty - no changes detected)",
      validation_section: validationSummary
        ? `Validation:\n${validationSummary}`
        : "Validation: (none)",
    },
  );

  const tmpOutputPath = `/tmp/pushpals-critic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const cmd = [
    ...codexPrefix,
    "-c",
    'model_reasoning_effort="low"',
    "-a",
    "never",
    "exec",
    "-s",
    "read-only",
    "--output-last-message",
    tmpOutputPath,
    "-",
  ];

  try {
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([criticInstruction]),
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, qualityCriticTimeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      onLog?.("stderr", "[QualityGate] Codex critic timed out; skipping.");
      return null;
    }
    if (exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      onLog?.(
        "stderr",
        `[QualityGate] Codex critic exited ${exitCode}: ${toSingleLine(stderrText, 220)}`,
      );
      return null;
    }

    let lastMessage = "";
    try {
      lastMessage = (await Bun.file(tmpOutputPath).text()).trim();
    } catch {
      /* file may not exist if codex produced no output */
    }
    try {
      unlinkSync(tmpOutputPath);
    } catch {
      /* ignore */
    }

    if (!lastMessage) {
      onLog?.("stderr", "[QualityGate] Codex critic: no output message captured; skipping.");
      return null;
    }

    const reviewObj = parseJsonObjectLoose(lastMessage);
    if (!reviewObj) {
      onLog?.(
        "stderr",
        `[QualityGate] Codex critic returned non-JSON: ${toSingleLine(lastMessage, 220)}`,
      );
      return null;
    }

    const scoreRaw = Number(reviewObj.score);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    const findings = Array.isArray(reviewObj.findings)
      ? reviewObj.findings.map((f) => String(f).trim()).filter(Boolean)
      : [];
    const mustFix = Array.isArray(reviewObj.must_fix)
      ? reviewObj.must_fix.map((f) => String(f).trim()).filter(Boolean)
      : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "")
      .trim()
      .slice(0, 2000);
    onLog?.("stdout", `[QualityGate] Codex critic score: ${score}/10`);
    return {
      score,
      findings,
      mustFix,
      revisionGuidance,
      raw: compactJobOutput(lastMessage, outputPolicyForRuntime(runtimeConfig)),
    };
  } catch (err) {
    onLog?.("stderr", `[QualityGate] Codex critic error: ${toSingleLine(err, 220)} (skipping).`);
    return null;
  }
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
    onLog?.(
      "stdout",
      "[TaskExecute] Scope suggestion: planning.scope.writeGlobs is empty for autonomy-origin task.",
    );
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
  const mergeConflictContext = extractMergeConflictReviewContext(normalizedParams);
  const reviewFixContext = extractReviewFixContext(normalizedParams);
  const qualityGatePolicy = deriveQualityGatePolicy(normalizedParams, runtimeConfig);
  const qualityMaxAutoRevisions = qualityGatePolicy.maxAutoRevisions;
  const qualitySoftPassOnExhausted = qualityGatePolicy.softPassOnExhausted;
  const qualityCriticMinScore = qualityGatePolicy.criticMinScore;

  onLog?.(
    "stdout",
    `[QualityGate] Policy: max_auto_revisions=${qualityMaxAutoRevisions}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}, critic_min_score=${qualityCriticMinScore}`,
  );
  if (qualityGatePolicy.mode === "review_fix") {
    const priorScore =
      reviewFixContext?.previousReviewScore != null
        ? reviewFixContext.previousReviewScore.toFixed(1)
        : "unknown";
    const threshold =
      reviewFixContext?.reviewThreshold != null
        ? reviewFixContext.reviewThreshold.toFixed(1)
        : qualityCriticMinScore.toFixed(1);
    onLog?.(
      "stdout",
      `[QualityGate] review_fix policy active: prior_score=${priorScore}, target_threshold=${threshold}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; repo/environment blockers still fail hard.`,
    );
  } else if (qualityGatePolicy.mode === "merge_conflict") {
    onLog?.(
      "stdout",
      `[QualityGate] merge_conflict policy active: soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; unfinished rebases and repo/environment blockers still fail hard.`,
    );
  }

  let revisionAttempt = 0;
  let revisionHint = "";
  while (revisionAttempt <= qualityMaxAutoRevisions) {
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
    if (mergeConflictContext) {
      const resume = await resumePreparedMergeConflictRebase(repo, kind, attemptParams, onLog);
      if (!resume.ok) {
        onLog?.("stderr", `[MergeConflict] ${resume.error}`);
        return {
          ok: false,
          summary: "Merge-conflict rebase continuation failed",
          stdout: result.stdout,
          stderr: [result.stderr ?? "", resume.error].filter(Boolean).join("\n"),
          exitCode: 4,
        };
      }
      const sequencer = resume.sequencer;
      if (sequencer) {
        const detail =
          `Merge-conflict job returned with git ${sequencer} still in progress. ` +
          `Finish the ${sequencer} before returning control to WorkerPals.`;
        onLog?.("stderr", `[MergeConflict] ${detail}`);
        return {
          ok: false,
          summary: detail,
          stdout: result.stdout,
          stderr: [result.stderr ?? "", detail].filter(Boolean).join("\n"),
          exitCode: 4,
        };
      }
    }

    const scopeCheck = await collectWriteScopeWarnings(repo, planning);
    for (const warning of scopeCheck.warnings) {
      onLog?.("stdout", `[TaskExecute] ${warning}`);
    }

    const quality = await runDeterministicQualityGate(repo, attemptParams, runtimeConfig, onLog);
    const critic = quality.skipped
      ? null
      : executor === "openai_codex"
        ? await runCodexCriticReview(repo, attemptParams, quality, runtimeConfig, onLog)
        : await runTaskCriticReview(repo, attemptParams, quality, runtimeConfig, onLog);
    const effectiveQualityIssues = relaxAdvisoryQualityIssues(
      quality.issues,
      quality.validationRuns,
      critic,
      qualityCriticMinScore,
    );
    if (effectiveQualityIssues.length !== quality.issues.length) {
      onLog?.(
        "stdout",
        "[QualityGate] Assertion-balance heuristic downgraded to advisory because validation passed and critic score met threshold.",
      );
    }
    const deterministicRequiresRevision =
      effectiveQualityIssues.length > 0 || quality.blocker !== null;
    const criticRequiresRevision = Boolean(critic && critic.score < qualityCriticMinScore);

    if (!deterministicRequiresRevision && !criticRequiresRevision) {
      if (critic) {
        onLog?.(
          "stdout",
          `[QualityGate] Critic review score ${critic.score.toFixed(1)}/10 (threshold ${qualityCriticMinScore}).`,
        );
      }
      return result;
    }

    const issues = buildQualityGateRevisionIssues(
      effectiveQualityIssues,
      critic,
      qualityCriticMinScore,
    );
    const issueSummary = issues.map((entry) => toSingleLine(entry, 180)).join(" | ");
    if (quality.blocker) {
      const blockerSummary = `Quality gate blocked by ${quality.blocker.category} issue: ${quality.blocker.detail}`;
      onLog?.("stderr", `[QualityGate] ${blockerSummary}`);
      return {
        ok: false,
        summary: blockerSummary,
        stdout: result.stdout,
        stderr: truncate(
          [
            result.stderr ?? "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          ].join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        ),
        exitCode: 4,
      };
    }
    if (revisionAttempt >= qualityMaxAutoRevisions) {
      if (qualitySoftPassOnExhausted) {
        const diagnostics = truncate(
          [result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        );
        onLog?.(
          "stderr",
          `[QualityGate] Soft-pass after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(
            issueSummary,
            260,
          )}`,
        );
        return {
          ...result,
          summary: `${result.summary} (quality gate soft-pass after ${revisionAttempt} auto-revision attempt(s))`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
      }
      return {
        ok: false,
        summary: `Quality gate failed after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(
          issueSummary,
          240,
        )}`,
        stdout: result.stdout,
        stderr: truncate(
          [result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        ),
        exitCode: 4,
      };
    }

    revisionAttempt += 1;
    revisionHint = buildQualityRevisionHint(issues, critic, planning, reviewFixContext);
    onLog?.(
      "stderr",
      `[QualityGate] Quality gate requested revision ${revisionAttempt}/${qualityMaxAutoRevisions}: ${toSingleLine(
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
