/**
 * Extracted job execution logic.
 * Used by both the host Worker (direct mode) and the Docker job runner.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import {
  buildGitCommitArgs as buildSourceControlGitCommitArgs,
  explicitSourceControlCommitIdentityFromEnv,
  loadPromptTemplate,
  loadPushPalsConfig,
  buildToolchainPlan,
  extractVisionKeyItems,
  formatToolRequirement,
  matchesGlob,
  normalizeTargetPath,
  requirementsForValidationCommand,
  resolveGitStateFilePath,
  sanitizeSourceControlIdentityField,
  type SourceControlCommitIdentity,
  type ToolRequirement,
} from "shared";
import { resolveExecutor, type WorkerpalsRuntimeConfig } from "./common/executor_backend.js";
import type {
  JobDiagnostics,
  JobPatchSnapshotDiagnostics,
  JobPublishBlockedInfo,
  JobResult,
  JobTerminalDiagnostics,
  JobValidationRunDiagnostics,
} from "./common/types.js";
import {
  compactJobOutput,
  truncate,
  type OutputCompactionPolicy,
} from "./common/execution_utils.js";
import {
  buildWorkerSandboxWritableEnv,
  resolveBunExecutableFromEnv,
  withResolvedBunOnPath,
} from "./common/sandbox_env.js";
// Re-export shared utilities for backward compatibility with external consumers.
export { compactJobOutput, truncate, streamLines } from "./common/execution_utils.js";
export { extractClarificationQuestionFromOutput } from "./backends/openhands_task_execute.js";
import { getBackendTaskExecutor } from "./backends/task_execute_registry.js";
import { extractMergeConflictReviewContext } from "./merge_conflict_job.js";

const DEFAULT_CONFIG = loadPushPalsConfig();

export interface TaskExecutePlanning {
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
  requiredValidationSteps?: string[];
  repoHintDiagnostics?: string[];
  repoHintStalePaths?: string[];
  queuePriority: TaskExecutePriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
}

export interface ValidationExecutionResult {
  step: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export interface ValidationBlocker {
  category: "repo" | "environment";
  detail: string;
}

type BrowserValidationFailureKind = "assertion" | "startup" | "runtime" | "network" | "unknown";

export interface BrowserValidationRepairPacket {
  command: string;
  failureKind: BrowserValidationFailureKind;
  stage: string | null;
  selector: string | null;
  expected: string | null;
  failureFocus: string | null;
  lastVerifiedStage?: string | null;
  pageUrl?: string | null;
  digest: string;
  previousDigest: string | null;
  previousStage: string | null;
  previousSelector: string | null;
  previousExpected: string | null;
  previousFailureFocus: string | null;
  progress: "first_failure" | "same_failure" | "new_failure";
  needsDiagnosticProbe: boolean;
  mustReadArtifactsBeforeEdit?: boolean;
  artifacts: string[];
  artifactSummaries?: string[];
  knownFailureHints?: string[];
  output: string;
}

interface BrowserFailureMemoryEntry {
  key: string;
  jobFamily: string;
  command: string;
  failureKind: BrowserValidationFailureKind;
  stage: string | null;
  selector: string | null;
  expected: string | null;
  failureFocus: string | null;
  digest: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedStage: string | null;
  pageUrl: string | null;
  artifactSummaries: string[];
  suggestedRemedy: string;
}

interface ValidationRemedyMemoryEntry {
  key: string;
  jobFamily: string;
  command: string;
  failureClass: string;
  digest: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  suggestedRemedy: string;
}

interface DeterministicQualityResult {
  ok: boolean;
  skipped: boolean;
  issues: string[];
  scopeIssues: string[];
  validationIssues: string[];
  changedPaths: string[];
  changedTestPaths: string[];
  validationRuns: ValidationExecutionResult[];
  requiredValidationFailures: string[];
  blocker: ValidationBlocker | null;
  validationFailureScope: "none" | "task_scope" | "outside_task_scope";
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
  validationMaxAutoRevisions: number;
  scopeGateEnabled: boolean;
  validationGateEnabled: boolean;
  criticGateEnabled: boolean;
  publishGateEnabled: boolean;
  softPassOnExhausted: boolean;
  criticMinScore: number;
}

const BROWSER_VALIDATION_MAX_AUTO_REVISIONS = 3;
const REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS = 4;
const CRITIC_COMPACT_RETRY_MIN_REDUCTION_RATIO = 0.25;
const MAX_DIAGNOSTIC_PATH_SAMPLES = 50;
const MAX_DIAGNOSTIC_TEXT_CHARS = 8_000;
const QUALITY_MIN_REVISION_BUDGET_MS = 120_000;
const QUALITY_MAX_REVISION_BUDGET_MS = 420_000;
const QUALITY_REVISION_BUDGET_RATIO = 0.25;
const BROWSER_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 900_000;
const BROWSER_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120_000;
const REPO_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 900_000;
const REPO_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120_000;
const IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 600_000;
const IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120_000;

export function qualityRevisionLoopUpperBound(
  policy: {
    maxAutoRevisions: number;
    validationMaxAutoRevisions: number;
  },
  opts: {
    browserValidation?: boolean;
  } = {},
): number {
  return Math.max(
    policy.maxAutoRevisions,
    policy.validationMaxAutoRevisions,
    opts.browserValidation ? BROWSER_VALIDATION_MAX_AUTO_REVISIONS : 0,
  );
}

export function qualityRevisionBudgetDecision(opts: {
  jobElapsedMs: number;
  executionBudgetMs: number;
}): {
  shouldStart: boolean;
  remainingBudgetMs: number;
  minimumRevisionBudgetMs: number;
} {
  const executionBudgetMs = Number(opts.executionBudgetMs);
  if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
    return {
      shouldStart: true,
      remainingBudgetMs: Number.POSITIVE_INFINITY,
      minimumRevisionBudgetMs: 0,
    };
  }
  const elapsedMs = Math.max(0, Number(opts.jobElapsedMs) || 0);
  const remainingBudgetMs = Math.max(0, Math.floor(executionBudgetMs - elapsedMs));
  const minimumRevisionBudgetMs = Math.floor(
    Math.min(
      executionBudgetMs,
      Math.max(
        QUALITY_MIN_REVISION_BUDGET_MS,
        Math.min(QUALITY_MAX_REVISION_BUDGET_MS, executionBudgetMs * QUALITY_REVISION_BUDGET_RATIO),
      ),
    ),
  );
  return {
    shouldStart: remainingBudgetMs >= minimumRevisionBudgetMs,
    remainingBudgetMs,
    minimumRevisionBudgetMs,
  };
}

export function browserValidationRepairContinuationBudgetDecision(opts: {
  browserRepairPacket?: BrowserValidationRepairPacket | null;
  validationOutsideTaskScope?: boolean;
  changedPaths: string[];
  revisionBudget: Pick<
    ReturnType<typeof qualityRevisionBudgetDecision>,
    "shouldStart" | "remainingBudgetMs" | "minimumRevisionBudgetMs"
  >;
}): {
  shouldContinue: boolean;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  reason: string;
} {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available",
    };
  }
  if (!opts.browserRepairPacket) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no browser validation repair packet",
    };
  }
  if (opts.validationOutsideTaskScope) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "browser validation failure is outside task scope",
    };
  }
  const publishablePaths = publishableChangedPaths(opts.changedPaths);
  if (publishablePaths.length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable browser repair patch is present",
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: BROWSER_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: BROWSER_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason:
      "browser validation repair made a publishable patch but exhausted the original revision budget",
  };
}

export function shouldRepairOutsideTaskRequiredValidation(opts: {
  requiredValidationFailures: string[];
  validationFailureScope: "none" | "task_scope" | "outside_task_scope";
  changedPaths: string[];
  revisionAttempt: number;
  maxAutoRevisions: number;
}): boolean {
  if (opts.validationFailureScope !== "outside_task_scope") return false;
  if (opts.requiredValidationFailures.length === 0) return false;
  if (opts.revisionAttempt >= opts.maxAutoRevisions) return false;
  return publishableChangedPaths(opts.changedPaths).length > 0;
}

export function repoValidationRepairContinuationBudgetDecision(opts: {
  repoValidationRepairMode: boolean;
  changedPaths: string[];
  revisionBudget: Pick<
    ReturnType<typeof qualityRevisionBudgetDecision>,
    "shouldStart" | "remainingBudgetMs" | "minimumRevisionBudgetMs"
  >;
}): {
  shouldContinue: boolean;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  reason: string;
} {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available",
    };
  }
  if (!opts.repoValidationRepairMode) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "not in repo validation repair mode",
    };
  }
  if (publishableChangedPaths(opts.changedPaths).length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable patch is present",
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: REPO_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: REPO_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason:
      "repo validation repair has publishable work but exhausted the original revision budget",
  };
}

export function inScopeValidationRepairContinuationBudgetDecision(opts: {
  requiredValidationFailures: string[];
  validationOutsideTaskScope?: boolean;
  changedPaths: string[];
  revisionBudget: Pick<
    ReturnType<typeof qualityRevisionBudgetDecision>,
    "shouldStart" | "remainingBudgetMs" | "minimumRevisionBudgetMs"
  >;
}): {
  shouldContinue: boolean;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  reason: string;
} {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available",
    };
  }
  if (opts.requiredValidationFailures.length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no required validation failure is present",
    };
  }
  if (opts.validationOutsideTaskScope) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "validation failure is outside task scope",
    };
  }
  if (publishableChangedPaths(opts.changedPaths).length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable validation repair patch is present",
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason:
      "in-scope validation repair has publishable work but exhausted the original revision budget",
  };
}

export function shouldSoftPassCriticOnlyBudgetExhaustion(opts: {
  softPassOnExhausted: boolean;
  deterministicRequiresRevision: boolean;
  criticRequiresRevision: boolean;
  requiredValidationFailures: string[];
  changedPaths: string[];
}): boolean {
  if (!opts.softPassOnExhausted) return false;
  if (opts.deterministicRequiresRevision) return false;
  if (!opts.criticRequiresRevision) return false;
  if (opts.requiredValidationFailures.length > 0) return false;
  return publishableChangedPaths(opts.changedPaths).length > 0;
}

const MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS = 300_000;
const MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS = 60_000;
const MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS = 120_000;

export function mergeConflictResolverRetryBudgetDecision(opts: {
  jobElapsedMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
}): {
  shouldStart: boolean;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  remainingTotalBudgetMs: number;
  minimumExecutionBudgetMs: number;
} {
  const configuredExecutionBudgetMs = Number(opts.executionBudgetMs);
  if (!Number.isFinite(configuredExecutionBudgetMs) || configuredExecutionBudgetMs <= 0) {
    return {
      shouldStart: true,
      executionBudgetMs: MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS,
      finalizationBudgetMs: MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS,
      remainingTotalBudgetMs: Number.POSITIVE_INFINITY,
      minimumExecutionBudgetMs: MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS,
    };
  }

  const configuredFinalizationBudgetMs = Math.max(0, Number(opts.finalizationBudgetMs) || 0);
  const elapsedMs = Math.max(0, Number(opts.jobElapsedMs) || 0);
  const remainingTotalBudgetMs = Math.max(
    0,
    Math.floor(configuredExecutionBudgetMs + configuredFinalizationBudgetMs - elapsedMs),
  );
  const finalizationBudgetMs = Math.min(
    MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS,
    configuredFinalizationBudgetMs,
    remainingTotalBudgetMs,
  );
  const availableExecutionBudgetMs = Math.max(0, remainingTotalBudgetMs - finalizationBudgetMs);
  const executionBudgetMs = Math.min(
    MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS,
    Math.floor(availableExecutionBudgetMs),
  );

  return {
    shouldStart: executionBudgetMs >= MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS,
    executionBudgetMs: Math.max(10_000, executionBudgetMs),
    finalizationBudgetMs,
    remainingTotalBudgetMs,
    minimumExecutionBudgetMs: MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS,
  };
}

export function shouldRetryCriticTimeoutWithCompact(opts: {
  timeoutBehavior: string;
  qualityOk: boolean;
  validationPassed: boolean;
  initialPromptChars: number;
  compactPromptChars: number;
}): boolean {
  if (opts.timeoutBehavior !== "retry_once") return false;
  if (!opts.qualityOk || !opts.validationPassed) return true;
  const initialPromptChars = Math.max(1, Math.floor(opts.initialPromptChars));
  const compactPromptChars = Math.max(0, Math.floor(opts.compactPromptChars));
  const reductionRatio = 1 - compactPromptChars / initialPromptChars;
  return reductionRatio >= CRITIC_COMPACT_RETRY_MIN_REDUCTION_RATIO;
}

export function shouldSkipCriticAfterExecutorTimeout(opts: {
  executor: string;
  policyMode: string;
  executorText: string;
  qualityOk: boolean;
  validationPassed: boolean;
  qualityIssues: string[];
  changedPaths: string[];
}): boolean {
  if (opts.executor !== "openai_codex") return false;
  if (opts.policyMode !== "default") return false;
  if (!opts.qualityOk || !opts.validationPassed) return false;
  if (opts.qualityIssues.length > 0 || opts.changedPaths.length === 0) return false;
  return /\b(openai_codex|codex(?: exec)?)\b[^\r\n]*\btimed out\b/i.test(opts.executorText);
}

export function shouldSkipCriticForDeterministicValidationRevision(opts: {
  deterministicRequiresRevision: boolean;
  validationOutsideTaskScope: boolean;
  validationRuns: ValidationExecutionResult[];
}): boolean {
  if (!opts.deterministicRequiresRevision || opts.validationOutsideTaskScope) return false;
  return opts.validationRuns.some(isDeterministicFastValidationFailure);
}

export function shouldSkipCriticToPreserveRevisionBudget(opts: {
  deterministicRequiresRevision: boolean;
  remainingBudgetMs: number;
  minimumRevisionBudgetMs: number;
  criticTimeoutMs: number;
  criticTimeoutBehavior: "skip" | "retry_once" | "block" | string;
}): boolean {
  if (!opts.deterministicRequiresRevision) return false;
  const remainingBudgetMs = Math.max(0, Math.floor(opts.remainingBudgetMs));
  const minimumRevisionBudgetMs = Math.max(0, Math.floor(opts.minimumRevisionBudgetMs));
  const criticTimeoutMs = Math.max(0, Math.floor(opts.criticTimeoutMs));
  const criticAttempts = opts.criticTimeoutBehavior === "retry_once" ? 2 : 1;
  const criticWorstCaseMs = criticTimeoutMs * criticAttempts;
  return remainingBudgetMs < minimumRevisionBudgetMs + criticWorstCaseMs;
}

export function workerAttemptRolloutScore(params: {
  executorElapsedMs: number;
  qualityElapsedMs: number;
  changedPaths: string[];
  validationRuns: ValidationExecutionResult[];
  qualityIssues: string[];
  criticScore?: number | null;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const publishable = publishableChangedPaths(params.changedPaths);
  if (publishable.length > 0) {
    score += 35;
    reasons.push("publishable_diff");
  } else if (params.changedPaths.length > 0) {
    score -= 35;
    reasons.push("artifact_only_diff");
  } else {
    score -= 20;
    reasons.push("no_diff");
  }
  const passedFast = params.validationRuns.filter(
    (run) => run.ok && !isLongRunningBrowserValidationCommand(run.command),
  ).length;
  const failedFast = params.validationRuns.filter(
    (run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command),
  ).length;
  if (passedFast > 0) {
    score += Math.min(20, passedFast * 8);
    reasons.push("fast_validation_passed");
  }
  if (failedFast > 0) {
    score -= Math.min(20, failedFast * 8);
    reasons.push("fast_validation_failed");
  }
  if (
    params.validationRuns.some(
      (run) => run.ok && isLongRunningBrowserValidationCommand(run.command),
    )
  ) {
    score += 15;
    reasons.push("long_validation_passed");
  }
  if (params.qualityIssues.length === 0) {
    score += 20;
    reasons.push("quality_clean");
  } else {
    score -= Math.min(30, params.qualityIssues.length * 6);
    reasons.push("quality_issues");
  }
  if (typeof params.criticScore === "number" && Number.isFinite(params.criticScore)) {
    score += Math.max(-20, Math.min(20, Math.round((params.criticScore - 8) * 5)));
    reasons.push("critic_scored");
  }
  const totalElapsedMs = Math.max(0, params.executorElapsedMs + params.qualityElapsedMs);
  if (totalElapsedMs > 1_800_000) {
    score -= 20;
    reasons.push("over_30m");
  } else if (totalElapsedMs <= 1_200_000) {
    score += 10;
    reasons.push("under_20m");
  }
  return {
    score: Math.max(-100, Math.min(100, score)),
    reasons: reasons.slice(0, 8),
  };
}

function taskRequestsBrowserValidation(params: Record<string, unknown>): boolean {
  const candidates: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    }
  };
  const planning =
    params.planning && typeof params.planning === "object"
      ? (params.planning as Record<string, unknown>)
      : {};
  collect(planning.requiredValidationSteps);
  collect(planning.validationSteps);
  collect(params.requiredValidationSteps);
  collect(params.validationSteps);
  collect(params.instruction);
  return candidates.some((candidate) => isLongRunningBrowserValidationCommand(candidate));
}

function shouldSoftPassValidationBlocker(
  policy: QualityGatePolicy,
  blocker: ValidationBlocker | null,
): boolean {
  if (!blocker) return false;
  if (!policy.softPassOnExhausted) return false;
  return policy.mode === "review_fix" || policy.mode === "merge_conflict";
}

export function shouldReviseRequiredValidationBlocker(opts: {
  requiredValidationFailures: string[];
  blocker: ValidationBlocker | null;
  revisionAttempt: number;
  maxAutoRevisions: number;
  outsideTaskScope?: boolean;
  allowOutsideTaskScope?: boolean;
}): boolean {
  if (opts.requiredValidationFailures.length === 0) return false;
  if (!opts.blocker) return false;
  if (opts.outsideTaskScope && !opts.allowOutsideTaskScope) return false;
  if (opts.blocker.category !== "repo") return false;
  return opts.revisionAttempt < opts.maxAutoRevisions;
}

export function revisionLimitForQualityGateFailures(opts: {
  policy: Pick<QualityGatePolicy, "maxAutoRevisions" | "validationMaxAutoRevisions">;
  qualityIssues: string[];
  requiredValidationFailures: string[];
  blocker: ValidationBlocker | null;
  browserRepairPacket?: BrowserValidationRepairPacket | null;
}): number {
  const hasValidationGateFailure =
    opts.requiredValidationFailures.length > 0 ||
    opts.blocker !== null ||
    opts.qualityIssues.some((issue) => issue.startsWith("ValidationGate:"));
  if (!hasValidationGateFailure) return opts.policy.maxAutoRevisions;
  if (opts.browserRepairPacket) {
    return Math.max(opts.policy.validationMaxAutoRevisions, BROWSER_VALIDATION_MAX_AUTO_REVISIONS);
  }
  if (opts.requiredValidationFailures.length > 0 && opts.blocker?.category === "repo") {
    return Math.max(
      opts.policy.validationMaxAutoRevisions,
      REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS,
    );
  }
  return opts.policy.validationMaxAutoRevisions;
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

function buildDiffBudgetWarning(
  planning: TaskExecutePlanning,
  changedPaths: string[],
  focusedBrowserRepair: boolean,
): string | null {
  const meaningfulChangedPaths = changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
  if (meaningfulChangedPaths.length === 0) return null;
  const explicitBudget = Number(planning.scope.maxFilesToEdit);
  const hasExplicitBudget = Number.isFinite(explicitBudget) && explicitBudget > 0;
  const smallTask =
    focusedBrowserRepair ||
    (planning.riskLevel !== "high" &&
      (planning.targetPaths?.length ?? 0) <= 2 &&
      planning.acceptanceCriteria.length <= 3);
  const budget = hasExplicitBudget ? Math.floor(explicitBudget) : smallTask ? 5 : 10;
  if (meaningfulChangedPaths.length <= budget) return null;
  return `Diff budget warning: this task now changes ${meaningfulChangedPaths.length} file(s), above the ${budget}-file ${
    hasExplicitBudget ? "planning.scope.maxFilesToEdit" : smallTask ? "small-task" : "default"
  } budget. Before editing more, remove unrelated churn and keep only behavior-owning files needed for the current repair. Changed files: ${meaningfulChangedPaths
    .slice(0, 12)
    .join(", ")}${meaningfulChangedPaths.length > 12 ? ", ..." : ""}`;
}

function isNonPublishableArtifactPath(path: string): boolean {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (
    /^Microsoft\/Windows\/PowerShell\/(?:ModuleAnalysisCache|PSReadLine(?:\/|$))/i.test(normalized)
  ) {
    return true;
  }
  return /(^|\/)(outputs|node_modules|\.worktrees|\.codex|dist|build|coverage)(\/|$)/i.test(
    normalized,
  );
}

function isNestedNodeModulesChange(path: string): boolean {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  return /(^|\/)node_modules\/.+/i.test(normalized);
}

export function publishableChangedPaths(changedPaths: string[]): string[] {
  return changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
}

function compactDiagnosticText(
  value: unknown,
  maxChars = MAX_DIAGNOSTIC_TEXT_CHARS,
): string | null {
  const text = String(value ?? "").replace(/\s+$/g, "");
  if (!text.trim()) return null;
  return text.length <= maxChars ? text : text.slice(Math.max(0, text.length - maxChars));
}

function diagnosticPathSample(paths: string[], limit = MAX_DIAGNOSTIC_PATH_SAMPLES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = String(raw ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

function diagnosticTopLevelDirs(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = String(path ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .trim();
    if (!normalized) continue;
    const top = normalized.includes("/") ? normalized.split("/", 1)[0] : normalized;
    if (top) seen.add(top);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

function buildPatchSnapshotDiagnostics(
  changedPaths: string[],
  attempt: number,
  phase: string,
): JobPatchSnapshotDiagnostics {
  const publishable = publishableChangedPaths(changedPaths);
  const artifactOnly = changedPaths.filter((path) => isNonPublishableArtifactPath(path));
  return {
    attempt,
    phase,
    publishableFileCount: publishable.length,
    artifactOnlyPathCount: artifactOnly.length,
    changedPathSample: diagnosticPathSample(changedPaths),
    topLevelDirs: diagnosticTopLevelDirs(publishable.length > 0 ? publishable : changedPaths),
    capturedAt: new Date().toISOString(),
  };
}

function classifyValidationRunFailure(run: ValidationExecutionResult): string | null {
  if (run.ok) return null;
  const combined = `${run.command}\n${run.stdout}\n${run.stderr}`.toLowerCase();
  if (run.exitCode === 124 || combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  if (run.exitCode === 127 || combined.includes("missing tool") || combined.includes("not found")) {
    return "missing_tool";
  }
  if (/browser|playwright|cypress|locator|page\.|screenshot|web:e2e/.test(combined)) {
    return "browser_validation";
  }
  if (
    /cannot find module|import error|does not provide an export|no exported member|mock/.test(
      combined,
    )
  ) {
    return "test_harness";
  }
  return "nonzero_exit";
}

function buildValidationRunDiagnostics(
  runs: ValidationExecutionResult[],
  attempt: number,
): JobValidationRunDiagnostics[] {
  return runs.slice(0, 20).map((run) => ({
    attempt,
    command: run.command,
    exitCode: run.exitCode,
    durationMs: run.elapsedMs,
    passed: run.ok,
    failureClass: classifyValidationRunFailure(run),
    stdoutTail: compactDiagnosticText(run.stdout),
    stderrTail: compactDiagnosticText(run.stderr),
  }));
}

function inferTerminalFailureClass(result: JobResult, changedPaths: string[]): string {
  if (result.ok) return "success";
  const summaryText = `${result.summary ?? ""}`.toLowerCase();
  const text =
    `${result.summary ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  const publishableCount = publishableChangedPaths(changedPaths).length;
  if (text.includes("stalled before first response") || text.includes("startup stall")) {
    return "codex_startup_stall";
  }
  if (summaryText.includes("validationgate") || summaryText.includes("validation")) {
    return "validation";
  }
  if (changedPaths.length > 0 && publishableCount === 0)
    return "artifact_only_no_publishable_patch";
  if (result.exitCode === 124 || text.includes("timed out") || text.includes("timeout"))
    return "timeout";
  if (text.includes("validationgate") || text.includes("validation")) return "validation";
  if (text.includes("scopegate") || text.includes("scope")) return "scope";
  if (text.includes("criticgate") || text.includes("critic")) return "critic";
  if (text.includes("publish")) return "publish";
  if (text.includes("shell-wrapper") || text.includes("command-router")) return "command_policy";
  return "executor_failure";
}

function inferTerminalStage(result: JobResult, fallback: string): string {
  const text = `${result.summary ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("stalled before first response") || text.includes("startup stall")) {
    return "executor_startup";
  }
  if (text.includes("validationgate") || text.includes("validation")) return "validation";
  if (text.includes("scopegate") || text.includes("scope")) return "scope";
  if (text.includes("criticgate") || text.includes("critic")) return "critic";
  if (text.includes("publish")) return "publish";
  if (text.includes("quality gate")) return "quality";
  if (text.includes("codex") || text.includes("executor")) return "executor";
  return fallback;
}

function mergeJobDiagnostics(
  base: JobDiagnostics | undefined,
  extra: JobDiagnostics,
): JobDiagnostics {
  return {
    ...(base ?? {}),
    ...extra,
    attempts: [...(base?.attempts ?? []), ...(extra.attempts ?? [])],
    phaseSpans: [...(base?.phaseSpans ?? []), ...(extra.phaseSpans ?? [])],
    validationRuns: [...(base?.validationRuns ?? []), ...(extra.validationRuns ?? [])],
    patchSnapshots: [...(base?.patchSnapshots ?? []), ...(extra.patchSnapshots ?? [])],
    terminal: extra.terminal ?? base?.terminal,
    metadata: {
      ...(base?.metadata ?? {}),
      ...(extra.metadata ?? {}),
    },
  };
}

function withJobDiagnostics(result: JobResult, diagnostics: JobDiagnostics): JobResult {
  return {
    ...result,
    diagnostics: mergeJobDiagnostics(result.diagnostics, diagnostics),
  };
}

function buildTerminalDiagnostics(args: {
  result: JobResult;
  executor: string;
  changedPaths: string[];
  terminalStage: string;
  timeoutMs?: number | null;
  metadata?: Record<string, unknown>;
}): JobTerminalDiagnostics {
  const publishable = publishableChangedPaths(args.changedPaths);
  const artifactOnly = args.changedPaths.filter((path) => isNonPublishableArtifactPath(path));
  const text = `${args.result.summary ?? ""}\n${args.result.stderr ?? ""}\n${args.result.stdout ?? ""}`;
  return {
    failureClass: inferTerminalFailureClass(args.result, args.changedPaths),
    terminalStage: inferTerminalStage(args.result, args.terminalStage),
    executorBackend: args.executor,
    summary: compactDiagnosticText(args.result.summary, 1_000),
    watchdogFired: /watchdog|rollout coach|stalled before first response|startup stall/i.test(text),
    timeoutMs: args.timeoutMs ?? null,
    publishableFileCount: publishable.length,
    artifactOnlyPathCount: artifactOnly.length,
    changedPathSample: diagnosticPathSample(args.changedPaths),
    metadata: args.metadata,
  };
}

function collectPlanningText(planning: TaskExecutePlanning): string {
  return [
    planning.intent,
    planning.riskLevel,
    ...(planning.targetPaths ?? []),
    ...(planning.acceptanceCriteria ?? []),
    ...(planning.validationSteps ?? []),
    ...(planning.requiredValidationSteps ?? []),
    ...(planning.repoHintDiagnostics ?? []),
    ...(planning.discovery?.keywords ?? []),
    ...(planning.discovery?.likelyDirs ?? []),
    ...(planning.discovery?.ripgrepQueries ?? []),
  ]
    .map((part) => String(part ?? ""))
    .join("\n")
    .toLowerCase();
}

function planningLooksLikeVisualDerivationTask(planning: TaskExecutePlanning): boolean {
  const text = collectPlanningText(planning);
  return /\b(visual|readability|battlefield|render(?:ing)?|projectile|planet|ship|ring|danger|threat|ownership|dense action|style|ui surface)\b/i.test(
    text,
  );
}

function buildTestHarnessConvergenceWarning(
  planning: TaskExecutePlanning,
  issues: string[],
  validationRuns: ValidationExecutionResult[],
): string | null {
  const combined = [
    ...issues,
    ...validationRuns.flatMap((run) => [run.command, run.stdout, run.stderr]),
  ]
    .map((part) => String(part ?? ""))
    .join("\n");
  const hasMockImportFailure =
    /\bCannot find module\b|\bdoes not provide an export\b|\bno exported member\b|\bimport error\b|\bundefined is not a function\b/i.test(
      combined,
    ) &&
    /\b(react[- ]native|reactNativeMock|Animated\.View|expo-secure-store|SettingsContext|skin validator|mock|test helper|__mocks__)\b/i.test(
      combined,
    );
  if (!hasMockImportFailure) return null;
  const visualPrefix = planningLooksLikeVisualDerivationTask(planning)
    ? " For this visual/rendering task, prefer pure helper/state/style-prop tests over a full React Native surface render."
    : "";
  return (
    "Test harness convergence warning: validation is failing in mock/import setup rather than product behavior." +
    visualPrefix +
    " Do not keep expanding broad shared mocks to rescue an over-scoped component render test. If the repo does not already have stable React Native render-test infrastructure for this surface, replace the full-surface regression with smaller deterministic helper/state coverage and one focused assertion on the behavior-owning API."
  );
}

function buildBroadSharedMockWarning(
  planning: TaskExecutePlanning,
  changedPaths: string[],
): string | null {
  const meaningfulChangedPaths = changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
  const broadMockPaths = meaningfulChangedPaths.filter((path) =>
    /(^|\/)(__mocks__|tests\/.*mock|test.*mock|reactNativeMock|setupTests?|jest\.|vitest\.|mock)(\.|\/|$)/i.test(
      path,
    ),
  );
  if (broadMockPaths.length === 0) return null;
  const smallTask =
    planning.riskLevel !== "high" &&
    ((planning.targetPaths?.length ?? 0) <= 2 || planning.acceptanceCriteria.length <= 3);
  if (!smallTask && !planningLooksLikeVisualDerivationTask(planning)) return null;
  const explicitlyRequested = /mock|test harness|react native test|component render/i.test(
    collectPlanningText(planning),
  );
  if (explicitlyRequested) return null;
  return `Broad mock warning: this focused task now changes shared mock/test-harness file(s): ${broadMockPaths
    .slice(0, 6)
    .join(", ")}${
    broadMockPaths.length > 6 ? ", ..." : ""
  }. Before continuing, prefer behavior-owned helper/state tests or existing stable render-test infrastructure; do not add broad React Native mocks for a small visual/control change unless the task explicitly requires harness repair.`;
}

const TEST_ASSERTION_BALANCE_ISSUE =
  "Changed test files do not show both positive and negative assertion coverage (expected both).";

function isAssertionBalanceIssue(issue: string): boolean {
  return (
    issue === TEST_ASSERTION_BALANCE_ISSUE ||
    issue.includes("positive and negative assertion coverage")
  );
}

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

  const relaxed = normalizedQualityIssues.filter((issue) => !isAssertionBalanceIssue(issue));
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
    prHeadRef:
      typeof reviewAgent.prHeadRef === "string" ? reviewAgent.prHeadRef.trim() || null : null,
    prBaseRef:
      typeof reviewAgent.prBaseRef === "string" ? reviewAgent.prBaseRef.trim() || null : null,
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
        : 3,
    ),
  );
  const baseValidationMaxAutoRevisions = Math.max(
    0,
    Math.min(
      10,
      Number.isFinite(Number(runtimeConfig.workerpals.qualityValidationMaxAutoRevisions))
        ? Math.floor(Number(runtimeConfig.workerpals.qualityValidationMaxAutoRevisions))
        : 3,
    ),
  );
  const baseSoftPassOnExhausted =
    typeof runtimeConfig.workerpals.qualitySoftPassOnExhausted === "boolean"
      ? runtimeConfig.workerpals.qualitySoftPassOnExhausted
      : true;
  const gateSwitches = {
    scopeGateEnabled:
      typeof runtimeConfig.workerpals.qualityScopeGateEnabled === "boolean"
        ? runtimeConfig.workerpals.qualityScopeGateEnabled
        : true,
    validationGateEnabled:
      typeof runtimeConfig.workerpals.qualityValidationGateEnabled === "boolean"
        ? runtimeConfig.workerpals.qualityValidationGateEnabled
        : true,
    criticGateEnabled:
      typeof runtimeConfig.workerpals.qualityCriticGateEnabled === "boolean"
        ? runtimeConfig.workerpals.qualityCriticGateEnabled
        : true,
    publishGateEnabled:
      typeof runtimeConfig.workerpals.qualityPublishGateEnabled === "boolean"
        ? runtimeConfig.workerpals.qualityPublishGateEnabled
        : true,
  };
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
        validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
        ...gateSwitches,
        softPassOnExhausted: baseSoftPassOnExhausted,
        criticMinScore: baseCriticMinScore,
      };
    }
    return {
      mode: "default",
      maxAutoRevisions: baseMaxAutoRevisions,
      validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
      ...gateSwitches,
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
    validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
    ...gateSwitches,
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
const COMMIT_MSG_LLM_MAX_CHANGED_PATHS = 20;
const COMMIT_MSG_GENERATOR_DEFAULT_TIMEOUT_MS = 15_000;
const COMMIT_MSG_GENERATOR_MIN_TIMEOUT_MS = 3_000;
const COMMIT_MSG_GENERATOR_MAX_TIMEOUT_MS = 30_000;

const SHELL_CONTROL_TOKENS = new Set(["&&", "||", ";", "|"]);
const BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND =
  "bun install --offline --frozen-lockfile --ignore-scripts";

export function tokenizeValidationCommandArgv(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    if (!current) return;
    out.push(current);
    current = "";
  };

  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
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
  if (escaped) current += "\\";
  if (quote) return null;
  pushCurrent();
  if (out.length === 0) return null;
  if (out.some((token) => SHELL_CONTROL_TOKENS.has(token))) return null;
  return out;
}

async function terminateValidationProcessTree(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const pid = Number(proc.pid);
  if (process.platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return;
    } catch {
      // Fall through to Bun's process handle.
    }
  }

  if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    await Bun.sleep(2_000);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    return;
  }

  try {
    proc.kill();
  } catch {
    // ignore
  }
}

function captureValidationStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk?: (chunk: string) => void,
) {
  let text = "";
  let done = false;
  const reader = stream?.getReader();
  const promise = reader
    ? (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = Buffer.from(result.value).toString("utf8");
            text += chunk;
            onChunk?.(chunk);
          }
        } catch {
          // Stream cancellation after process exit is expected when descendants
          // inherit pipes from failed browser/dev-server launchers.
        } finally {
          done = true;
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }
      })()
    : Promise.resolve().then(() => {
        done = true;
      });

  return {
    cancel: async () => {
      try {
        await reader?.cancel();
      } catch {
        // ignore
      }
    },
    isDone: () => done,
    promise,
    text: () => text,
  };
}

const DEFAULT_BROWSER_VALIDATION_FAILURE_IDLE_MS = 15_000;
const DEFAULT_BROWSER_VALIDATION_SUCCESS_IDLE_MS = 1_000;

function browserValidationFailureIdleMs(env: Record<string, string>): number {
  const configured = Number(env.PUSHPALS_VALIDATION_FAILURE_IDLE_MS ?? "");
  if (Number.isFinite(configured) && configured >= 250) {
    return Math.min(120_000, Math.trunc(configured));
  }
  return DEFAULT_BROWSER_VALIDATION_FAILURE_IDLE_MS;
}

function browserValidationSuccessIdleMs(env: Record<string, string>): number {
  const configured = Number(env.PUSHPALS_VALIDATION_SUCCESS_IDLE_MS ?? "");
  if (Number.isFinite(configured) && configured >= 250) {
    return Math.min(120_000, Math.trunc(configured));
  }
  return DEFAULT_BROWSER_VALIDATION_SUCCESS_IDLE_MS;
}

function hasBrowserValidationFailureSignal(output: string): boolean {
  const text = String(output ?? "");
  if (!text.trim()) return false;
  const patterns = [
    /\bAssertionError\b/i,
    /\bTimeoutError\b/i,
    /\bWeb end-to-end smoke test failed:/i,
    /\bexpect\([^)]*\)\.[a-z0-9_]+\([^)]*\)\s+failed/i,
    /\bError:\s+expect\(/i,
    /\blocator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded\b/i,
    /\bpage\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded\b/i,
    /\bTimeout\s+\d+ms\s+exceeded\b/i,
    /\bTest timeout of \d+ms exceeded\b/i,
    /\bCall log:\s*(?:\r?\n|$)/i,
    /\bwaiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)]*\)/i,
    /\bpage\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+/i,
    /\bbrowserType\.launch:/i,
    /\bERR_SOCKET_BAD_PORT\b/i,
    /\blisten\s+EPERM\b/i,
    /\bEADDRINUSE\b/i,
    /\berror:\s+script\s+"[^"]+"\s+exited with code\s+\d+/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function hasBrowserValidationSuccessSignal(output: string): boolean {
  const text = String(output ?? "");
  if (!text.trim()) return false;
  const patterns = [
    /\bWeb end-to-end smoke test completed successfully\./i,
    /\bWeb smoke test completed successfully\./i,
    /\bBrowser smoke test completed successfully\./i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export async function runValidationArgv(
  repo: string,
  command: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  outputPolicy: Partial<OutputCompactionPolicy>,
  timeoutMessage: string,
): Promise<ValidationExecutionResult> {
  type ValidationWaitResult =
    | { type: "exit"; code: number }
    | { type: "timeout" }
    | { type: "failure-signal" }
    | { type: "success-signal" };
  const startedAt = Date.now();
  const spawnEnv = withResolvedBunOnPath(env);
  const spawnArgv = prepareValidationSpawnArgv(argv, spawnEnv);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(spawnArgv, {
      cwd: repo,
      env: spawnEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      step: command,
      command,
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: compactJobOutput(
        [`Validation command could not start executable "${spawnArgv[0] ?? ""}".`, detail]
          .filter(Boolean)
          .join("\n"),
        outputPolicy,
      ),
      elapsedMs: Math.max(1, Date.now() - startedAt),
    };
  }
  let lastOutputAt = Date.now();
  const noteOutput = () => {
    lastOutputAt = Date.now();
  };
  const stdoutCapture = captureValidationStream(
    (proc.stdout ?? null) as ReadableStream<Uint8Array> | null,
    noteOutput,
  );
  const stderrCapture = captureValidationStream(
    (proc.stderr ?? null) as ReadableStream<Uint8Array> | null,
    noteOutput,
  );
  let timedOut = false;
  let stoppedAfterFailureSignal = false;
  let stoppedAfterSuccessSignal = false;
  const timeout = Math.max(1_000, timeoutMs);
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<ValidationWaitResult>((resolveTimeout) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      resolveTimeout({ type: "timeout" });
    }, timeout);
  });

  let browserSignalTimer: ReturnType<typeof setInterval> | null = null;
  const browserSignalPromise = isLongRunningBrowserValidationCommand(command)
    ? new Promise<ValidationWaitResult>((resolveBrowserSignal) => {
        const idleMs = browserValidationFailureIdleMs(spawnEnv);
        const successIdleMs = browserValidationSuccessIdleMs(spawnEnv);
        browserSignalTimer = setInterval(() => {
          const combinedOutput = `${stdoutCapture.text()}\n${stderrCapture.text()}`;
          if (
            hasBrowserValidationFailureSignal(combinedOutput) &&
            Date.now() - lastOutputAt >= idleMs
          ) {
            stoppedAfterFailureSignal = true;
            resolveBrowserSignal({ type: "failure-signal" });
            return;
          }
          if (
            hasBrowserValidationSuccessSignal(combinedOutput) &&
            Date.now() - lastOutputAt >= successIdleMs
          ) {
            stoppedAfterSuccessSignal = true;
            resolveBrowserSignal({ type: "success-signal" });
          }
        }, 250);
      })
    : new Promise<ValidationWaitResult>(() => {
        // Non-browser validations should only end on process exit or timeout.
      });

  const exitOrTimeout = await Promise.race<ValidationWaitResult>([
    proc.exited.then((code) => ({ type: "exit" as const, code })),
    timeoutPromise,
    browserSignalPromise,
  ]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (browserSignalTimer) clearInterval(browserSignalTimer);

  if (timedOut || stoppedAfterFailureSignal || stoppedAfterSuccessSignal) {
    await terminateValidationProcessTree(proc);
  }

  const exitCode =
    exitOrTimeout.type === "timeout"
      ? 124
      : exitOrTimeout.type === "failure-signal"
        ? 1
        : exitOrTimeout.type === "success-signal"
          ? 0
          : exitOrTimeout.code;

  if (!timedOut && !stoppedAfterFailureSignal && !stoppedAfterSuccessSignal) {
    await Promise.race([
      Promise.all([stdoutCapture.promise, stderrCapture.promise]),
      Bun.sleep(1_000),
    ]);
    if (!stdoutCapture.isDone() || !stderrCapture.isDone()) {
      await terminateValidationProcessTree(proc);
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    }
  } else {
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
  }

  await Promise.race([Promise.all([stdoutCapture.promise, stderrCapture.promise]), Bun.sleep(500)]);

  return {
    step: command,
    command,
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout: compactJobOutput(stdoutCapture.text().trim(), outputPolicy),
    stderr: compactJobOutput(
      [
        stderrCapture.text().trim(),
        timedOut ? timeoutMessage : "",
        stoppedAfterFailureSignal
          ? `Validation command emitted a browser/e2e failure signal and then produced no output for ${browserValidationFailureIdleMs(spawnEnv)}ms. PushPals terminated the leaked process tree and preserved the captured failure output for repair.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      outputPolicy,
    ),
    elapsedMs: Math.max(1, Date.now() - startedAt),
  };
}

async function runValidationCommand(
  repo: string,
  command: string,
  timeoutMs: number,
  outputPolicy: Partial<OutputCompactionPolicy>,
): Promise<ValidationExecutionResult> {
  const env = buildWorkerSandboxWritableEnv(repo);
  const argv = prepareValidationCommandArgv(command, env);
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

  return runValidationArgv(
    repo,
    command,
    argv,
    env,
    timeoutMs,
    outputPolicy,
    `Validation command timed out after ${Math.max(1_000, timeoutMs)}ms. Captured output is the process output emitted before PushPals terminated the command and its process tree.`,
  );
}

export function isLongRunningBrowserValidationCommand(command: string): boolean {
  const normalized = validationCommandKey(command);
  if (!normalized) return false;
  const tokens = tokenizeValidationCommandArgv(command)?.map((token) => token.toLowerCase()) ?? [];
  const joined = tokens.join(" ");
  return (
    /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke)\b/.test(normalized) ||
    /\b(playwright|cypress)\b/.test(joined) ||
    (/\bexpo\b/.test(joined) && /\b(web|start)\b/.test(joined))
  );
}

function textIncludesLongRunningBrowserValidation(text: string): boolean {
  return (
    /(?:^|[^a-z0-9_-])(?:web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke|playwright|cypress)(?:$|[^a-z0-9_-])/i.test(
      text,
    ) || /\bexpo\b[\s\S]{0,160}\b(?:--web|web|start)\b/i.test(text)
  );
}

export function validationCommandIncludesLongRunningBrowserWork(
  repo: string,
  command: string,
): boolean {
  const visited = new Set<string>();

  const visit = (cwd: string, currentCommand: string, depth: number): boolean => {
    if (isLongRunningBrowserValidationCommand(currentCommand)) return true;
    if (depth >= 8) return false;

    const resolvedScript = resolvePackageScriptForValidationCommand(cwd, currentCommand);
    if (!resolvedScript) return false;
    const visitKey = `${resolvedScript.cwd}\0${resolvedScript.script}`;
    if (visited.has(visitKey)) return false;
    visited.add(visitKey);

    const referencedText = readReferencedValidationScriptText(
      resolvedScript.cwd,
      resolvedScript.script,
    );
    if (textIncludesLongRunningBrowserValidation(`${resolvedScript.script}\n${referencedText}`)) {
      return true;
    }

    for (const match of resolvedScript.script.matchAll(
      /\b(bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9][A-Za-z0-9:._-]*)\b/gi,
    )) {
      const packageManager = match[1] ?? "";
      const scriptName = match[2] ?? "";
      if (!packageManager || !scriptName) continue;
      if (visit(resolvedScript.cwd, `${packageManager} run ${scriptName}`, depth + 1)) {
        return true;
      }
    }

    return false;
  };

  return visit(repo, command, 0);
}

function textIncludesTestValidation(text: string): boolean {
  if (
    /(?:^|[^a-z0-9_-])(?:bun|bunx|npm|npx|pnpm|yarn)\s+(?:run\s+)?test(?::[a-z0-9._-]+)?(?:$|[^a-z0-9_-])/im.test(
      text,
    ) ||
    /(?:^|[^a-z0-9_-])(?:pytest|vitest|jest)(?:$|[^a-z0-9_-])/im.test(text) ||
    /(?:^|[^a-z0-9_-])(?:python|python3)\s+-m\s+pytest(?:$|[^a-z0-9_-])/im.test(text) ||
    /(?:^|[^a-z0-9_-])(?:go|cargo|make)\s+test(?:$|[^a-z0-9_-])/im.test(text)
  ) {
    return true;
  }

  // Recognize declarative JavaScript validation runners such as
  // createStep("Unit tests", "bun", ["test"]) and
  // createStep("Worker tests", "bun", ["run", "test:worker"]).
  return /["'`](?:bun|bunx|npm|npx|pnpm|yarn)["'`][\s\S]{0,240}?\[\s*["'`](?:test|run["'`]\s*,\s*["'`]test(?::[a-z0-9._-]+)?)["'`]/i.test(
    text,
  );
}

/** Returns true when a validation command resolves to direct or aggregate test work. */
export function validationCommandIncludesTestWork(repo: string, command: string): boolean {
  const visited = new Set<string>();

  const visit = (cwd: string, currentCommand: string, depth: number): boolean => {
    if (isTestLikeValidationStep(currentCommand)) return true;
    if (depth >= 8) return false;

    const resolvedScript = resolvePackageScriptForValidationCommand(cwd, currentCommand);
    if (!resolvedScript) return false;
    const visitKey = `${resolvedScript.cwd}\0${resolvedScript.script}`;
    if (visited.has(visitKey)) return false;
    visited.add(visitKey);

    const referencedText = readReferencedValidationScriptText(
      resolvedScript.cwd,
      resolvedScript.script,
    );
    const aggregateText = `${resolvedScript.script}\n${referencedText}`;
    if (textIncludesTestValidation(aggregateText)) return true;

    for (const match of aggregateText.matchAll(
      /\b(bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9][A-Za-z0-9:._-]*)\b/gi,
    )) {
      const packageManager = match[1] ?? "";
      const scriptName = match[2] ?? "";
      if (!packageManager || !scriptName) continue;
      if (visit(resolvedScript.cwd, `${packageManager} run ${scriptName}`, depth + 1)) {
        return true;
      }
    }

    return false;
  };

  return visit(repo, command, 0);
}

export function isParallelSafeFastValidationCommand(repo: string, command: string): boolean {
  if (isLongRunningBrowserValidationCommand(command)) return false;
  if (shouldEnsurePlaywrightBrowserRuntime(repo, command)) return false;
  const tokens = tokenizeValidationCommandArgv(command);
  if (!tokens || tokens.length === 0) return false;
  const lower = tokens.map((token) => token.toLowerCase());
  if (lower[0] !== "bun") return false;
  if (lower[1] === "test") return true;
  if (lower[1] === "x" && lower[2] === "tsc") return true;
  if (lower[1] === "run" && ["lint", "typecheck", "test", "test:unit"].includes(lower[2] ?? "")) {
    return true;
  }
  return false;
}

function isDeterministicFastValidationFailure(run: ValidationExecutionResult): boolean {
  if (run.ok || run.exitCode === 127 || isLongRunningBrowserValidationCommand(run.command)) {
    return false;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  if (!combined.trim()) return false;
  return (
    /\bCannot find module\b|\bmodule not found\b|\bfailed to resolve import\b|\bcould not resolve\b|\bNo such file or directory\b|\bENOENT\b/i.test(
      combined,
    ) ||
    /\bTS\d{4}\b|\btype error\b|\bno exported member\b|\bdoes not exist on type\b|\bis not assignable to\b/i.test(
      combined,
    ) ||
    /\berror:\s+"eslint"\s+exited with code\s+\d+\b/i.test(combined) ||
    /\bSyntaxError\b|\bReferenceError\b|\bTypeError\b/i.test(combined)
  );
}

export function shouldDeferLongValidationAfterFastFailures(
  command: string,
  previousRuns: ValidationExecutionResult[],
  repo?: string,
): string | null {
  if (
    !isLongRunningBrowserValidationCommand(command) &&
    !(repo && validationCommandIncludesLongRunningBrowserWork(repo, command))
  ) {
    return null;
  }
  const deterministicFailures = previousRuns.filter(isDeterministicFastValidationFailure);
  if (deterministicFailures.length === 0) return null;
  const first = deterministicFailures[0];
  const digest = extractValidationFailureDigest(first);
  return `fast validation already failed for "${first.command}"${digest ? ` (${digest})` : ""}`;
}

function readPackageJson(repo: string): {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
} | null {
  const packagePath = resolve(repo, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    return null;
  }
}

function packageJsonDeclaresPlaywright(repo: string): boolean {
  const parsed = readPackageJson(repo);
  if (!parsed) return false;
  const dependencyGroups = [
    parsed.dependencies,
    parsed.devDependencies,
    parsed.optionalDependencies,
    parsed.peerDependencies,
  ];
  return dependencyGroups.some((group) =>
    Boolean(group && (group.playwright || group["@playwright/test"])),
  );
}

function resolvePackageScriptForValidationCommand(
  repo: string,
  command: string,
): { script: string; cwd: string } | null {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv || argv.length === 0) return null;
  const first = argv[0]?.toLowerCase();
  let cwd = repo;
  let scriptName = "";

  const consumeCwdOption = (index: number): number | null => {
    const token = argv[index] ?? "";
    if ((token === "--cwd" || token === "-C" || token === "--prefix") && argv[index + 1]) {
      cwd = resolve(repo, argv[index + 1] ?? "");
      return index + 2;
    }
    for (const prefix of ["--cwd=", "-C=", "--prefix="]) {
      if (token.startsWith(prefix)) {
        cwd = resolve(repo, token.slice(prefix.length));
        return index + 1;
      }
    }
    return null;
  };

  if (first === "bun") {
    let index = 1;
    while (index < argv.length) {
      const consumed = consumeCwdOption(index);
      if (consumed !== null) {
        index = consumed;
        continue;
      }
      if ((argv[index] ?? "").startsWith("--")) {
        index += 1;
        continue;
      }
      break;
    }
    if ((argv[index] ?? "").toLowerCase() === "run") {
      scriptName = argv[index + 1] ?? "";
    } else {
      const candidate = argv[index] ?? "";
      if (candidate && !["install", "test", "x"].includes(candidate.toLowerCase())) {
        scriptName = candidate;
      }
    }
  } else if (first === "npm" || first === "pnpm" || first === "yarn") {
    let index = 1;
    while (index < argv.length) {
      const consumed = consumeCwdOption(index);
      if (consumed !== null) {
        index = consumed;
        continue;
      }
      if ((argv[index] ?? "").toLowerCase() === "run") {
        scriptName = argv[index + 1] ?? "";
        break;
      }
      if (!(argv[index] ?? "").startsWith("-")) {
        scriptName = argv[index] ?? "";
        break;
      }
      index += 1;
    }
  }

  if (!scriptName) return null;
  const script = readPackageJson(cwd)?.scripts?.[scriptName];
  if (typeof script !== "string" || !script.trim()) return null;
  return { script, cwd };
}

function readReferencedValidationScriptText(cwd: string, script: string): string {
  const texts: string[] = [];
  const tokens = tokenizeValidationCommandArgv(script) ?? script.split(/\s+/).filter(Boolean);
  for (const rawToken of tokens) {
    const token = rawToken
      .trim()
      .replace(/^['"`]+|['"`]+$/g, "")
      .replace(/\\/g, "/");
    if (!/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(token)) continue;
    if (token.includes("://") || token.includes("node_modules/")) continue;
    const scriptPath = resolve(cwd, token);
    if (!existsSync(scriptPath)) continue;
    try {
      texts.push(readFileSync(scriptPath, "utf8").slice(0, 64_000));
    } catch {
      // Best effort: the validation command will surface unreadable files.
    }
  }
  return texts.join("\n");
}

export function shouldEnsurePlaywrightBrowserRuntime(repo: string, command: string): boolean {
  if (!validationCommandIncludesLongRunningBrowserWork(repo, command)) return false;
  if (/\bplaywright\b/i.test(command)) return true;

  const script = resolvePackageScriptForValidationCommand(repo, command);
  const scriptCwd = script?.cwd ?? repo;
  if (packageJsonDeclaresPlaywright(repo) || packageJsonDeclaresPlaywright(scriptCwd)) {
    return true;
  }
  if (!script) return false;
  return /(?:^|[^A-Za-z0-9_-])(?:@playwright\/test|playwright)(?:$|[^A-Za-z0-9_-])/i.test(
    `${script.script}\n${readReferencedValidationScriptText(script.cwd, script.script)}`,
  );
}

const PLAYWRIGHT_BROWSER_INSTALL_TARGETS = new Set([
  "chromium",
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "msedge",
  "msedge-beta",
  "msedge-dev",
  "msedge-canary",
  "firefox",
  "webkit",
]);

function addPlaywrightInstallTarget(targets: Set<string>, rawValue: string): void {
  const value = rawValue.trim().toLowerCase();
  if (!value) return;
  const normalized = value === "edge" ? "msedge" : value;
  if (PLAYWRIGHT_BROWSER_INSTALL_TARGETS.has(normalized)) {
    targets.add(normalized);
  }
}

export function inferPlaywrightBrowserInstallTargets(repo: string, command: string): string[] {
  const targets = new Set<string>(["chromium"]);
  const script = resolvePackageScriptForValidationCommand(repo, command);
  const scriptText = script
    ? `${script.script}\n${readReferencedValidationScriptText(script.cwd, script.script)}`
    : "";
  const text = `${command}\n${scriptText}`;

  for (const match of text.matchAll(/\bchannel\s*:\s*["'`]([^"'`]+)["'`]/gi)) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const match of text.matchAll(/\bbrowserName\s*:\s*["'`]([^"'`]+)["'`]/gi)) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const match of text.matchAll(
    /(?:^|\s)(?:--browser|--browser-name|--channel)[=\s]+["'`]?([A-Za-z0-9_-]+)/gi,
  )) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const target of PLAYWRIGHT_BROWSER_INSTALL_TARGETS) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\s*\\.\\s*launch\\b`, "i").test(text)) {
      addPlaywrightInstallTarget(targets, target);
    }
  }

  return Array.from(targets).sort((a, b) => {
    if (a === "chromium") return -1;
    if (b === "chromium") return 1;
    return a.localeCompare(b);
  });
}

export function playwrightBrowserInstallArgv(targets: string[] = ["chromium"]): string[] {
  const installTargets = Array.from(
    new Set(targets.map((target) => target.trim()).filter(Boolean)),
  );
  return [
    "bunx",
    "playwright",
    "install",
    ...(installTargets.length > 0 ? installTargets : ["chromium"]),
  ];
}

async function runPlaywrightBrowserRuntimePreflight(
  repo: string,
  command: string,
  targets: string[],
  timeoutMs: number,
  outputPolicy: Partial<OutputCompactionPolicy>,
): Promise<ValidationExecutionResult> {
  const env = buildWorkerSandboxWritableEnv(repo);
  const timeout = Math.max(120_000, Math.min(600_000, timeoutMs));
  return runValidationArgv(
    repo,
    command,
    playwrightBrowserInstallArgv(targets),
    env,
    timeout,
    outputPolicy,
    `Browser runtime preflight timed out after ${timeout}ms while ensuring Playwright browser target(s): ${targets.join(", ")}. Captured output is the process output emitted before PushPals terminated the installer process tree.`,
  );
}

export function resolveValidationCommandTimeoutMs(
  command: string,
  baseTimeoutMs: number,
  repo?: string,
): number {
  const normalizedBase = Number.isFinite(Number(baseTimeoutMs))
    ? Math.max(1_000, Math.min(7_200_000, Math.floor(Number(baseTimeoutMs))))
    : 180_000;
  const includesBrowserWork =
    isLongRunningBrowserValidationCommand(command) ||
    Boolean(repo && validationCommandIncludesLongRunningBrowserWork(repo, command));
  if (!includesBrowserWork) return normalizedBase;
  return Math.max(normalizedBase, 600_000);
}

function commandHasPortArg(argv: string[]): boolean {
  return argv.some((token) => token === "--port" || token.startsWith("--port="));
}

function shouldInjectBrowserValidationPort(command: string, argv: string[]): boolean {
  if (commandHasPortArg(argv)) return false;
  if (!isLongRunningBrowserValidationCommand(command)) return false;
  return /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke)\b/.test(
    validationCommandKey(command),
  );
}

export function prepareValidationCommandArgv(
  command: string,
  env: Record<string, string>,
): string[] | null {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv) return null;
  const spawnArgv = prepareValidationSpawnArgv(argv, env);
  const port = String(env.EXPO_DEV_SERVER_PORT ?? "").trim();
  if (!port || !shouldInjectBrowserValidationPort(command, spawnArgv)) return spawnArgv;
  return [...spawnArgv, "--", "--port", port];
}

function commandLeaf(value: string): string {
  return (value.trim().replace(/\\/g, "/").split("/").pop() ?? value).toLowerCase();
}

function isBunCommandToken(value: string): boolean {
  const leaf = commandLeaf(value);
  return leaf === "bun" || leaf === "bun.exe" || leaf === "bun.cmd" || leaf === "bun.bat";
}

function isBunxCommandToken(value: string): boolean {
  const leaf = commandLeaf(value);
  return leaf === "bunx" || leaf === "bunx.exe" || leaf === "bunx.cmd" || leaf === "bunx.bat";
}

export function prepareValidationSpawnArgv(argv: string[], env: Record<string, string>): string[] {
  const first = argv[0] ?? "";
  if (!first) return argv;
  const bunBin = resolveBunExecutableFromEnv(env);
  if (!bunBin) return argv;
  if (isBunCommandToken(first)) return [bunBin, ...argv.slice(1)];
  if (isBunxCommandToken(first)) return [bunBin, "x", ...argv.slice(1)];
  return argv;
}

interface BunDependencyLayoutPreflightPlan {
  command: string;
  reason: string;
  removeLinkedNodeModules?: boolean;
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function declaredPackageDependencyNames(
  packageJson: Record<string, unknown>,
  fields: Array<"dependencies" | "devDependencies" | "optionalDependencies"> = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ],
): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    const dependencies = asRecord(packageJson[field]);
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.trim()) out.add(name.trim());
    }
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function packageJsonDeclaresDependency(
  packageJson: Record<string, unknown>,
  name: string,
): boolean {
  return declaredPackageDependencyNames(packageJson).includes(name);
}

function hasBunLockfile(repo: string): boolean {
  return existsSync(resolve(repo, "bun.lock")) || existsSync(resolve(repo, "bun.lockb"));
}

function isBunPackageManagedValidationCommand(command: string): boolean {
  const tokens = tokenizeValidationCommandArgv(command);
  if (!tokens || tokens.length === 0) return false;
  const first = tokens[0] ?? "";
  if (isBunxCommandToken(first)) return true;
  if (!isBunCommandToken(first)) return false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").toLowerCase();
    if (token === "--cwd" || token === "-c" || token === "-C") {
      index += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) continue;
    if (token.startsWith("-")) continue;
    return token === "run" || token === "x" || token === "test";
  }
  return false;
}

function resolvePackageRoot(nodeModulesDir: string, packageName: string): string {
  return resolve(nodeModulesDir, ...packageName.split("/").filter(Boolean));
}

function defaultBinNameForPackage(packageName: string): string {
  return packageName.split("/").filter(Boolean).pop() ?? packageName;
}

function isSafeBinName(value: string): boolean {
  return Boolean(value.trim()) && !/[\\/:\0]/.test(value);
}

function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedChild = resolve(child).replace(/\\/g, "/");
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function packageBinaryNames(packageRoot: string, dependencyName: string): string[] {
  const packageJson = readJsonRecord(resolve(packageRoot, "package.json"));
  if (!packageJson) return [];
  const packageName =
    typeof packageJson.name === "string" && packageJson.name.trim()
      ? packageJson.name.trim()
      : dependencyName;
  const bin = packageJson.bin;
  const entries: Array<[string, string]> = [];
  if (typeof bin === "string" && bin.trim()) {
    entries.push([defaultBinNameForPackage(packageName), bin.trim()]);
  } else {
    const binRecord = asRecord(bin);
    if (binRecord) {
      for (const [name, target] of Object.entries(binRecord)) {
        if (typeof target === "string" && target.trim()) entries.push([name, target.trim()]);
      }
    }
  }

  return Array.from(
    new Set(
      entries
        .filter(([name, target]) => {
          if (!isSafeBinName(name)) return false;
          const targetPath = resolve(packageRoot, target);
          return isPathInside(packageRoot, targetPath) && existsSync(targetPath);
        })
        .map(([name]) => name),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function hasLocalBinShim(binDir: string, binName: string): boolean {
  const candidates = ["", ".bunx", ".exe", ".cmd", ".ps1"].map((extension) =>
    resolve(binDir, `${binName}${extension}`),
  );
  return candidates.some((candidate) => existsSync(candidate));
}

function isLinkedNodeModulesDependencyArtifact(repo: string): boolean {
  try {
    return lstatSync(resolve(repo, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
}

function validationNeedsExpoRouterBrowserLocalInstall(
  repo: string,
  packageJson: Record<string, unknown>,
  validationCommands: string[],
): boolean {
  return (
    packageJsonDeclaresDependency(packageJson, "expo-router") &&
    validationCommands.some((command) =>
      validationCommandIncludesLongRunningBrowserWork(repo, command),
    )
  );
}

function collectMissingTopLevelDependencyPackages(
  repo: string,
  packageJson: Record<string, unknown>,
): string[] {
  const nodeModulesDir = resolve(repo, "node_modules");
  const missing: string[] = [];
  for (const dependencyName of declaredPackageDependencyNames(packageJson, [
    "dependencies",
    "devDependencies",
  ])) {
    if (!existsSync(resolvePackageRoot(nodeModulesDir, dependencyName))) {
      missing.push(dependencyName);
      if (missing.length >= 8) return missing;
    }
  }
  return missing;
}

function collectMissingTopLevelDependencyBinaryShims(
  repo: string,
  packageJson: Record<string, unknown>,
): string[] {
  const nodeModulesDir = resolve(repo, "node_modules");
  const binDir = resolve(nodeModulesDir, ".bin");
  const missing: string[] = [];
  for (const dependencyName of declaredPackageDependencyNames(packageJson)) {
    const packageRoot = resolvePackageRoot(nodeModulesDir, dependencyName);
    if (!existsSync(packageRoot)) continue;
    for (const binName of packageBinaryNames(packageRoot, dependencyName)) {
      if (!hasLocalBinShim(binDir, binName)) missing.push(binName);
      if (missing.length >= 8) return Array.from(new Set(missing));
    }
  }
  return Array.from(new Set(missing));
}

export function resolveBunDependencyLayoutPreflight(
  repo: string,
  validationCommands: string[],
): BunDependencyLayoutPreflightPlan | null {
  if (!validationCommands.some((command) => isBunPackageManagedValidationCommand(command))) {
    return null;
  }
  if (!hasBunLockfile(repo)) return null;
  const packageJson = readJsonRecord(resolve(repo, "package.json"));
  if (!packageJson) return null;

  const nodeModulesDir = resolve(repo, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules is missing for Bun validation commands",
    };
  }

  if (
    isLinkedNodeModulesDependencyArtifact(repo) &&
    validationNeedsExpoRouterBrowserLocalInstall(repo, packageJson, validationCommands)
  ) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules is linked for Expo Router browser validation commands",
      removeLinkedNodeModules: true,
    };
  }

  const binDir = resolve(nodeModulesDir, ".bin");
  if (!existsSync(binDir)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules/.bin is missing for Bun validation commands",
    };
  }

  const missingPackages = collectMissingTopLevelDependencyPackages(repo, packageJson);
  if (missingPackages.length > 0) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: `installed dependency package(s) missing: ${missingPackages.join(", ")}`,
    };
  }

  const missingBins = collectMissingTopLevelDependencyBinaryShims(repo, packageJson);
  if (missingBins.length > 0) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: `local dependency binary shim(s) missing: ${missingBins.join(", ")}`,
    };
  }
  return null;
}

export function resolveBunDependencyLayoutPreflightTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(30_000, timeoutMs), 600_000);
}

export function resolveBunDependencyLayoutPreflightTimeoutForValidationCommands(
  repo: string,
  validationCommands: string[],
  baseTimeoutMs: number,
): number {
  const longestValidationTimeoutMs = validationCommands.reduce(
    (longest, command) =>
      Math.max(longest, resolveValidationCommandTimeoutMs(command, baseTimeoutMs, repo)),
    baseTimeoutMs,
  );
  return resolveBunDependencyLayoutPreflightTimeoutMs(longestValidationTimeoutMs);
}

export function buildBunDependencyLayoutPreflightFailureRun(args: {
  validationCommand: string;
  validationCommands: string[];
  preflightCommand: string;
  preflightReason: string;
  run: ValidationExecutionResult;
}): ValidationExecutionResult {
  const validationCommand =
    args.validationCommand.trim() || args.validationCommands[0] || args.preflightCommand;
  return {
    step: validationCommand,
    command: validationCommand,
    ok: false,
    exitCode: args.run.exitCode,
    stdout: args.run.stdout,
    stderr: [
      `Dependency layout preflight failed before validation command "${validationCommand}". WorkerPals could not repair the local Bun dependency layout safely.`,
      `Preflight reason: ${args.preflightReason}.`,
      `Repair command: ${args.preflightCommand}.`,
      args.run.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
    elapsedMs: args.run.elapsedMs,
  };
}

function removeLinkedNodeModulesDependencyArtifact(
  repo: string,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): void {
  const nodeModulesDir = resolve(repo, "node_modules");
  if (!isLinkedNodeModulesDependencyArtifact(repo)) return;
  try {
    rmSync(nodeModulesDir, { recursive: true, force: true });
    onLog?.(
      "stdout",
      "[ValidationGate] Dependency layout preflight removed linked node_modules artifact before local Bun install repair.",
    );
  } catch (err) {
    onLog?.(
      "stderr",
      `[ValidationGate] Dependency layout preflight could not remove linked node_modules artifact: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function runBunDependencyLayoutPreflight(
  repo: string,
  validationCommands: string[],
  failureValidationCommand: string,
  timeoutMs: number,
  outputPolicy: Partial<OutputCompactionPolicy>,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ValidationExecutionResult | null> {
  const preflight = resolveBunDependencyLayoutPreflight(repo, validationCommands);
  if (!preflight) return null;
  onLog?.(
    "stdout",
    `[ValidationGate] Dependency layout preflight: ${preflight.reason}; running "${preflight.command}".`,
  );
  if (preflight.removeLinkedNodeModules) {
    removeLinkedNodeModulesDependencyArtifact(repo, onLog);
  }
  const run = await runValidationCommand(
    repo,
    preflight.command,
    resolveBunDependencyLayoutPreflightTimeoutForValidationCommands(
      repo,
      validationCommands,
      timeoutMs,
    ),
    outputPolicy,
  );
  if (run.ok) {
    onLog?.(
      "stdout",
      `[ValidationGate] Dependency layout preflight repaired local Bun install layout (${run.elapsedMs}ms).`,
    );
    return null;
  }
  const digest = extractValidationFailureDigest(run);
  onLog?.(
    "stderr",
    `[ValidationGate] Dependency layout preflight failed (${run.elapsedMs}ms, exit ${run.exitCode})${digest ? ` - ${digest}` : ""}. Blocking validation because the dependency tree may be incomplete after repair failure.`,
  );
  return buildBunDependencyLayoutPreflightFailureRun({
    validationCommand: failureValidationCommand,
    validationCommands,
    preflightCommand: preflight.command,
    preflightReason: preflight.reason,
    run,
  });
}

function isBrowserAssertionDigest(digest: string): boolean {
  return /\b(Web end-to-end smoke test failed|locator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded|page\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded|waiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\(|Expected .+ to be .+ within \d+ms|AssertionError|Error:\s+expect\()/i.test(
    digest,
  );
}

export function isBrowserValidationInfrastructureDigest(digest: string): boolean {
  if (isBrowserAssertionDigest(digest)) return false;
  return /\b(browserType\.launch|ERR_SOCKET_BAD_PORT|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|listen\s+EPERM|EPERM|EACCES|freeport|port selection|browser runtime|playwright install|executable doesn't exist|Expo exited early|local port bind|Validation command timed out|terminated by signal)\b/i.test(
    digest,
  );
}

interface ToolAvailabilityResult {
  requirement: ToolRequirement;
  ok: boolean;
  candidate: string | null;
  detail: string;
}

function toolProbeArgv(candidate: string, env: Record<string, string>): string[] {
  const normalized = candidate.toLowerCase();
  let argv: string[];
  if (normalized === "sh") {
    argv = [candidate, "-c", "exit 0"];
  } else if (normalized === "cmd") {
    argv = [candidate, "/c", "exit 0"];
  } else if (normalized === "bash") {
    argv = [candidate, "-lc", "exit 0"];
  } else if (normalized === "powershell" || normalized === "pwsh") {
    argv = [candidate, "-NoProfile", "-Command", "exit 0"];
  } else {
    argv = [candidate, "--version"];
  }
  return prepareValidationSpawnArgv(argv, env);
}

async function checkToolCandidate(
  candidate: string,
  env: Record<string, string>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const spawnEnv = withResolvedBunOnPath(env);
  try {
    const proc = Bun.spawn(toolProbeArgv(candidate, spawnEnv), {
      env: spawnEnv,
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
    try {
      const [exitCode] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
      ]);
      return !timedOut && exitCode === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function checkToolAvailability(
  requirements: ToolRequirement[],
  env: Record<string, string> = withResolvedBunOnPath(process.env as Record<string, string>),
): Promise<ToolAvailabilityResult[]> {
  const cache = new Map<string, Promise<boolean>>();
  const check = (candidate: string) => {
    const key = candidate.toLowerCase();
    let cached = cache.get(key);
    if (!cached) {
      cached = checkToolCandidate(candidate, env);
      cache.set(key, cached);
    }
    return cached;
  };

  const out: ToolAvailabilityResult[] = [];
  for (const requirement of requirements) {
    let availableCandidate: string | null = null;
    for (const candidate of requirement.candidates) {
      if (await check(candidate)) {
        availableCandidate = candidate;
        break;
      }
    }
    out.push({
      requirement,
      ok: Boolean(availableCandidate),
      candidate: availableCandidate,
      detail: availableCandidate
        ? `${availableCandidate} is available`
        : `missing ${formatToolRequirement(requirement)}`,
    });
  }
  return out;
}

function formatMissingToolRequirements(requirements: ToolRequirement[]): string {
  return requirements.map(formatToolRequirement).join(", ");
}

function extractPreparedMergeConflictPaths(params: Record<string, unknown>): string[] {
  const reviewAgent =
    params.reviewAgent &&
    typeof params.reviewAgent === "object" &&
    !Array.isArray(params.reviewAgent)
      ? (params.reviewAgent as Record<string, unknown>)
      : null;
  const preparedPaths = Array.isArray(reviewAgent?.preparedConflictPaths)
    ? reviewAgent.preparedConflictPaths
    : [];
  return preparedPaths
    .map((entry) =>
      String(entry ?? "")
        .trim()
        .replace(/\\/g, "/"),
    )
    .filter(Boolean);
}

function normalizeValidationPathToken(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^['"`(<[]+/, "")
    .replace(/[>'"`)\],.;:]+$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (!/[./]/.test(normalized)) return null;
  if (/^(https?|file):/i.test(normalized)) return null;
  return normalized;
}

function extractPathTokensFromValidationOutput(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = normalizeValidationPathToken(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  const normalized = stripAnsiControlSequences(value);
  for (const match of normalized.matchAll(
    /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_.-]+)?/g,
  )) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(
    /(?:from|in|at)\s+['"`]?([^'"`\s]+\/[^'"`\s]+)['"`]?/gi,
  )) {
    add(match[1]);
  }
  return out;
}

function literalScopePrefix(value: string): string | null {
  const normalized = normalizeValidationPathToken(
    value.replace(/\*\*?.*$/, "").replace(/\/+$/, ""),
  );
  if (!normalized || normalized === ".") return null;
  return normalized;
}

function pathMatchesScopeHint(path: string, hint: string): boolean {
  const normalizedPath = normalizeValidationPathToken(path);
  const normalizedHint = hint
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  if (!normalizedPath || !normalizedHint) return false;
  if (matchesGlob(normalizedPath, normalizedHint)) return true;
  const prefix = literalScopePrefix(normalizedHint);
  if (!prefix) return false;
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

function isValidationScopeTestPathHint(path: string): boolean {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function shouldTreatBrowserAssertionAsTaskScope(
  planning: TaskExecutePlanning,
  changedPaths: string[],
  targetPath?: string,
): boolean {
  const pathHints = [
    targetPath ?? "",
    ...changedPaths,
    ...(planning.targetPaths ?? []),
    ...(planning.scope.writeGlobs ?? []),
  ]
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  const allHintsAreTests =
    pathHints.length > 0 && pathHints.every((hint) => isValidationScopeTestPathHint(hint));
  const planningText = collectPlanningText(planning);
  const explicitlyBrowserValidation = /\b(browser|web:e2e|e2e|playwright|smoke)\b/i.test(
    planningText,
  );
  if (allHintsAreTests && !explicitlyBrowserValidation) return false;

  const productPathChanged = changedPaths.some((path) => {
    const normalized = path
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    return (
      !isValidationScopeTestPathHint(normalized) &&
      /^(app|components|screens|styles|utils)\//i.test(normalized)
    );
  });
  if (productPathChanged) return true;

  return /\b(ui|visual|render(?:ing)?|style|screen|route|home|settings|shop|game|battlefield|component|control panel|control-panel)\b/i.test(
    planningText,
  );
}

export function classifyValidationFailureScope(
  runs: ValidationExecutionResult[],
  planning: TaskExecutePlanning,
  changedPaths: string[],
  targetPath?: string,
): "none" | "task_scope" | "outside_task_scope" {
  const failedRuns = runs.filter((run) => !run.ok && run.exitCode !== 127);
  if (failedRuns.length === 0) return "none";
  const scopeHints = [
    targetPath ?? "",
    ...changedPaths,
    ...(planning.targetPaths ?? []),
    ...(planning.scope.writeGlobs ?? []),
  ]
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  if (scopeHints.length === 0) return "none";

  const combined = failedRuns
    .flatMap((run) => [run.stdout, run.stderr])
    .filter(Boolean)
    .join("\n");
  const hasBrowserAssertionFailure = failedRuns.some(
    (run) =>
      isLongRunningBrowserValidationCommand(run.command) &&
      isBrowserAssertionDigest([run.stdout, run.stderr].filter(Boolean).join("\n")),
  );
  if (
    hasBrowserAssertionFailure &&
    shouldTreatBrowserAssertionAsTaskScope(planning, changedPaths, targetPath)
  ) {
    return "task_scope";
  }
  const lowerCombined = combined.toLowerCase().replace(/\\/g, "/");
  for (const hint of scopeHints) {
    const normalized = literalScopePrefix(hint);
    if (normalized && normalized.length >= 4 && lowerCombined.includes(normalized.toLowerCase())) {
      return "task_scope";
    }
  }

  const pathTokens = extractPathTokensFromValidationOutput(combined).filter(
    (token) => !/^(node_modules|\.bun|bun|npm|pnpm|yarn)\//i.test(token),
  );
  if (pathTokens.length === 0) {
    return hasBrowserAssertionFailure ? "outside_task_scope" : "none";
  }
  if (pathTokens.some((token) => scopeHints.some((hint) => pathMatchesScopeHint(token, hint)))) {
    return "task_scope";
  }
  return "outside_task_scope";
}

export function detectValidationBlocker(
  runs: ValidationExecutionResult[],
): ValidationBlocker | null {
  const failedRuns = runs.filter((run) => !run.ok);
  if (failedRuns.length === 0) return null;

  const combined = failedRuns
    .flatMap((run) => [run.stdout, run.stderr])
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!combined) return null;

  const browserFallbackSucceeded =
    combined.includes("using google chrome for browser automation") ||
    combined.includes("using chromium for browser automation") ||
    combined.includes("using firefox for browser automation") ||
    combined.includes("using webkit for browser automation");
  const hasMissingBrowserRuntime =
    !browserFallbackSucceeded &&
    (combined.includes("browser runtime preflight failed") ||
      combined.includes("playwright install") ||
      combined.includes("executable doesn't exist") ||
      combined.includes("please run the following command to download new browsers"));

  if (
    combined.includes("validation skipped before execution because required tool") ||
    combined.includes("missing required tool") ||
    combined.includes("command not found") ||
    combined.includes("executable not found") ||
    hasMissingBrowserRuntime ||
    combined.includes("not recognized as an internal or external command")
  ) {
    return {
      category: "environment",
      detail:
        "Validation is blocked by missing required toolchain executables or browser runtime support in the worker environment. Install/provision the missing tools or browser runtime before retrying this job.",
    };
  }

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
    combined.includes("err_socket_bad_port") ||
    combined.includes("expo exited early") ||
    combined.includes("eperm") ||
    combined.includes("operation not permitted") ||
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

export function expandKnownArtifactDirectoryPaths(repo: string, paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addPath = (rawPath: string) => {
    const path = String(rawPath ?? "")
      .replace(/\\/g, "/")
      .trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  for (const rawPath of paths) {
    const normalized = String(rawPath ?? "")
      .replace(/\\/g, "/")
      .trim()
      .replace(/\/+$/, "");
    if (normalized.toLowerCase() !== "microsoft") {
      addPath(rawPath);
      continue;
    }

    const powerShellRoot = resolve(repo, "Microsoft", "Windows", "PowerShell");
    const knownArtifacts: string[] = [];
    const moduleCache = resolve(powerShellRoot, "ModuleAnalysisCache");
    if (existsSync(moduleCache))
      knownArtifacts.push("Microsoft/Windows/PowerShell/ModuleAnalysisCache");
    const psReadLineRoot = resolve(powerShellRoot, "PSReadLine");
    if (existsSync(psReadLineRoot)) {
      for (const entry of readdirSync(psReadLineRoot, { withFileTypes: true })) {
        if (entry.isFile()) {
          knownArtifacts.push(`Microsoft/Windows/PowerShell/PSReadLine/${entry.name}`);
        }
      }
    }

    if (knownArtifacts.length === 0) {
      addPath(rawPath);
      continue;
    }
    for (const artifact of knownArtifacts.sort()) addPath(artifact);
  }

  return out;
}

export function isAssertionCoverageTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("__tests__/") ||
    /\.test\.[a-z0-9]+$/i.test(normalized) ||
    /\.spec\.[a-z0-9]+$/i.test(normalized)
  );
}

export function isBrowserSmokeHarnessPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)scripts\/test-[^/]*\.(?:c?js|m?js|ts)$/.test(normalized) ||
    /(^|\/)scripts\/[^/]*(?:e2e|smoke|playwright|browser)[^/]*\.(?:c?js|m?js|ts)$/.test(
      normalized,
    ) ||
    /(^|\/)(?:playwright|cypress)\.config\.(?:c?js|m?js|ts)$/.test(normalized)
  );
}

export function isTestSupportPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:tests?|__tests__|__mocks__)\//.test(normalized);
}

export function isLikelyTestPath(path: string): boolean {
  return (
    isAssertionCoverageTestPath(path) || isBrowserSmokeHarnessPath(path) || isTestSupportPath(path)
  );
}

export function isValidationToolingPath(path: string): boolean {
  const normalized = String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return (
    /^(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(base) ||
    /^(tsconfig|jsconfig)(?:\.[a-z0-9_-]+)?\.json$/.test(base) ||
    /^(eslint|prettier|babel|metro|jest|vitest|playwright)\.config\.(?:cjs|mjs|js|ts)$/.test(
      base,
    ) ||
    /^\.eslintrc(?:\.(?:cjs|js|json|yaml|yml))?$/.test(base) ||
    /^\.prettierrc(?:\.(?:cjs|js|json|yaml|yml))?$/.test(base) ||
    base === "bunfig.toml"
  );
}

export function allowsValidationToolingOnlyChangeForTestFocusedTask(params: {
  instruction: string;
  planning: TaskExecutePlanning;
  changedPaths: string[];
}): boolean {
  const changedPaths = params.changedPaths
    .map((path) =>
      String(path ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, ""),
    )
    .filter(Boolean);
  if (changedPaths.length === 0) return false;
  if (!changedPaths.every(isValidationToolingPath)) return false;
  const guidance = [
    params.instruction,
    ...(params.planning.targetPaths ?? []),
    ...(params.planning.scope.writeGlobs ?? []),
    ...(params.planning.discovery?.likelyDirs ?? []),
    ...(params.planning.acceptanceCriteria ?? []),
    ...(params.planning.validationSteps ?? []),
    ...(params.planning.requiredValidationSteps ?? []),
  ].join("\n");
  return /\b(lint|eslint|prettier|format|type\s*check|typecheck|tsc|typescript|validation|tooling|toolchain|package\.json|tsconfig|expo lint|cli)\b/i.test(
    guidance,
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
  const runnable = new Set([
    "bun",
    "bunx",
    "git",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "node",
    "pytest",
    "python",
    "python3",
    "uv",
    "coverage",
    "vitest",
    "jest",
    "tsc",
    "eslint",
    "ruff",
    "mypy",
    "go",
    "cargo",
    "make",
    "docker",
    "pwsh",
    "powershell",
    "sh",
    "bash",
  ]);
  if (runnable.has(firstToken)) return maybeStripped;
  return null;
}

function validationCommandKey(command: string): string {
  const argv = tokenizeValidationCommandArgv(command);
  if (argv && argv.length > 0) {
    const normalized = argv.map((entry) => entry.trim()).filter(Boolean);
    if (normalized[0]?.toLowerCase() === "bunx") {
      normalized.splice(0, 1, "bun", "x");
    }
    return normalized.join(" ").replace(/\s+/g, " ").toLowerCase();
  }
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^bunx\b/i, "bun x")
    .toLowerCase();
}

export function extractValidationFailureDigest(run: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  elapsedMs?: number;
}): string {
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  const patterns = [
    /\bCannot find module\s+['"`][^'"`\r\n]+['"`][^\r\n]*/i,
    /\bFailed to resolve import\s+['"`][^'"`\r\n]+['"`][^\r\n]*/i,
    /\bCould not resolve\s+['"`]?[^'"`\r\n]+['"`]?[^\r\n]*/i,
    /\bModule not found[^\r\n]*/i,
    /\bWeb end-to-end smoke test failed:[^\r\n]*/i,
    /\bbrowserType\.launch:[^\r\n]*/i,
    /\blocator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bpage\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bTimeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bwaiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)]*\)[^\r\n]*/i,
    /\bpage\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+[^\r\n]*/i,
    /\bExecutable doesn't exist[^\r\n]*/i,
    /\bPlease run the following command to download new browsers:[^\r\n]*(?:\r?\n\s+[^\r\n]+)?/i,
    /\bRun ["`]?npx playwright install[^'"`\r\n]*["`]?[^\r\n]*/i,
    /\bERR_SOCKET_BAD_PORT[^\r\n]*/i,
    /\berror TS\d+:[^\r\n]*/i,
    /\bError:\s+[^\r\n]*/i,
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match?.[0]) return toSingleLine(match[0], 180);
  }
  const firstMeaningfulLine = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\b(error|failed|cannot|could not|timeout|timed out)\b/i.test(line));
  if (firstMeaningfulLine) return toSingleLine(firstMeaningfulLine, 180);
  if (Number(run.exitCode) === 124) {
    const elapsed = Number.isFinite(Number(run.elapsedMs))
      ? ` after ${Number(run.elapsedMs)}ms`
      : "";
    return `timed out${elapsed}`;
  }
  return "";
}

function classifyBrowserValidationFailureKindFromText(text: string): BrowserValidationFailureKind {
  const combined = stripAnsiControlSequences(text);
  if (
    /\b(browserType\.launch|Executable doesn't exist|playwright install|Browser runtime preflight failed|Please run the following command to download new browsers|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)\b/i.test(
      combined,
    )
  ) {
    return "runtime";
  }
  if (
    /\b(ERR_SOCKET_BAD_PORT|EADDRINUSE|listen\s+EPERM|EPERM|EACCES|freeport|port selection|Expo exited early|local port bind|cannot bind|operation not permitted)\b/i.test(
      combined,
    )
  ) {
    return "startup";
  }
  if (
    /\b(page\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(
      combined,
    )
  ) {
    return "network";
  }
  if (isBrowserAssertionDigest(combined)) {
    return "assertion";
  }
  return "unknown";
}

export function shouldRetryBrowserValidationRunOnce(
  run: ValidationExecutionResult,
  repo?: string,
): boolean {
  if (
    run.ok ||
    (!isLongRunningBrowserValidationCommand(run.command) &&
      !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command)))
  ) {
    return false;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  const digest = extractValidationFailureDigest(run);
  const failureKind = classifyBrowserValidationFailureKindFromText(`${digest}\n${combined}`);
  if (failureKind === "runtime" || failureKind === "network") return true;
  if (failureKind === "startup") return true;
  return /\b(Route\/startup smoke failure|startup smoke failure|home route startup)\b/i.test(
    `${digest}\n${combined}`,
  );
}

export function shouldRetryPassingVitestTeardownOnce(run: ValidationExecutionResult): boolean {
  if (run.ok) return false;
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  if (
    !/EnvironmentTeardownError/i.test(combined) ||
    !/\[vitest-worker\]:\s*Closing rpc while ["']resolve["'] was pending/i.test(combined)
  ) {
    return false;
  }
  const summaryLines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:Test Files|Tests)\b/i.test(line));
  const testFilesSummary = summaryLines.find((line) => /^Test Files\b/i.test(line)) ?? "";
  const testsSummary = summaryLines.find((line) => /^Tests\b/i.test(line)) ?? "";
  if (!/\b\d+\s+passed\b/i.test(testFilesSummary) || !/\b\d+\s+passed\b/i.test(testsSummary)) {
    return false;
  }
  return !summaryLines.some((line) => /\b\d+\s+failed\b/i.test(line));
}

function extractBrowserValidationStage(text: string): string | null {
  const patterns = [
    /\bBrowser validation failed during\s+([^:.\r\n|]+?)\s+stage\b/i,
    /\bfailed during\s+([^:.\r\n|]+?)\s+stage\b/i,
    /\b(?:stage|phase)\s*[:=]\s*["'`]?([^"'`.\r\n|]+)["'`]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return toSingleLine(value, 80);
  }
  const verifiedStages = [...text.matchAll(/\bVerified:\s+([^|\r\n]+)/gi)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const lastVerifiedStage = verifiedStages.at(-1);
  if (lastVerifiedStage) return toSingleLine(lastVerifiedStage, 80);
  return null;
}

function refineBrowserValidationStage(
  stage: string | null,
  selector: string | null,
  expected: string | null,
  text: string,
): string | null {
  const combined = stripAnsiControlSequences(
    [stage, selector, expected, text].filter(Boolean).join(" "),
  ).toLowerCase();
  if (/\b(game-control-panel|planet control panel|selected planet panel)\b/i.test(combined)) {
    return "planet control panel";
  }
  if (/\bsettings-home-button\b|\breturn to home from settings\b/i.test(combined)) {
    return "settings return";
  }
  if (/\bshop-home-button\b|\breturn to home from shop\b/i.test(combined)) {
    return "shop return";
  }
  return stage;
}

function inferBrowserValidationFailureFocus(params: {
  stage?: string | null;
  selector?: string | null;
  expected?: string | null;
  text?: string | null;
}): string | null {
  const combined = stripAnsiControlSequences(
    [params.stage, params.selector, params.expected, params.text].filter(Boolean).join(" "),
  ).toLowerCase();
  if (!combined.trim()) return null;

  const focusRules: Array<[RegExp, string]> = [
    [
      /\b(settings|ui[-\s]?size|scale(?:\s+option)?|settings-ui-|large ui option|medium|compact)\b/i,
      "settings UI size",
    ],
    [/\b(shop|skin|ship-option|projectile-option)\b/i, "shop navigation"],
    [/\b(home|shell|home-screen|home-play|play button|landing)\b/i, "home shell"],
    [/\b(match[-\s]?entry|start match|game-screen|countdown)\b/i, "match entry"],
    [
      /\b(in[-\s]?game|game-control|help-menu|planet|deploy|allocation|resource|decoy|attack|defense|tank)\b/i,
      "in-game UI",
    ],
  ];
  for (const [pattern, label] of focusRules) {
    if (pattern.test(combined)) return label;
  }

  const stableLocatorMatch = combined.match(
    /\b(?:getbytestid|data-testid|testid)\(?['"`]?([a-z0-9_-]+)/i,
  );
  if (stableLocatorMatch?.[1]) return `test id ${stableLocatorMatch[1]}`;

  const compact = combined
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  return compact ? toSingleLine(compact, 80) : null;
}

function extractBalancedLocatorCall(text: string): string | null {
  const callPattern =
    /\b(?:getBy(?:TestId|Role|Text|Label|Placeholder|Title)|locator\.[a-z0-9_]+|page\.[a-z0-9_]+)\(/gi;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(text)) != null) {
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let index = match.index; index < text.length; index += 1) {
      const char = text[index] ?? "";
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) return toSingleLine(text.slice(match.index, index + 1), 120);
      }
      if (depth <= 0 && /\s/.test(char) && index > match.index) break;
    }
  }
  return null;
}

function extractBrowserValidationSelector(text: string): string | null {
  const balanced = extractBalancedLocatorCall(text);
  if (balanced) return balanced;
  const patterns = [
    /\bwaiting for\s+(getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)\r\n]+\))/i,
    /\b(locator\.[a-z0-9_]+\([^)\r\n]*\))/i,
    /\b(page\.[a-z0-9_]+\([^)\r\n]*\))/i,
    /\b(getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)\r\n]+\))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return toSingleLine(value, 120);
  }
  return null;
}

function extractBrowserValidationExpectedUi(text: string): string | null {
  const patterns = [
    /\bExpected\s+([^:.\r\n]+?)\s+within\s+\d+ms\b/i,
    /\bExpected\s+([^:.\r\n]+?)(?:[:.]|\r?\n)/i,
    /\bExpected\s+([^:.\r\n]+?)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return toSingleLine(value, 140);
  }
  return null;
}

function extractBrowserValidationArtifacts(text: string): string[] {
  const combined = stripAnsiControlSequences(text);
  const out: string[] = [];
  const seen = new Set<string>();
  const addArtifact = (raw: string | undefined) => {
    const artifact = String(raw ?? "")
      .trim()
      .replace(/[),.;:]+$/, "");
    if (!artifact || seen.has(artifact)) return;
    seen.add(artifact);
    out.push(toSingleLine(artifact, 220));
  };
  const patterns = [
    /\b(?:screenshot|snapshot|trace|video|artifact|output|saved|wrote)[^:\r\n]*:\s*(["'`]?)([^"'`\s]+(?:outputs|test-results|playwright-report)[^\s"'`]+(?:\.png|\.jpg|\.jpeg|\.webp|\.zip|\.json|\.txt|\.webm))\1/gi,
    /((?:\/repo|\/workspace|[A-Za-z]:[\\/])?[^\s"'`]*?(?:outputs|test-results|playwright-report)[\\/][^\s"'`]+(?:\.png|\.jpg|\.jpeg|\.webp|\.zip|\.json|\.txt|\.webm))/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(combined)) != null) {
      addArtifact(match[2] ?? match[1]);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

function collectRecentBrowserValidationFiles(
  repo: string | undefined,
  extensions: RegExp,
  limit = 8,
): string[] {
  if (!repo) return [];
  const roots = ["outputs/web-e2e", "test-results", "playwright-report"]
    .map((entry) => resolve(repo, entry))
    .filter((entry) => existsSync(entry));
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4 || files.length > 2_000) return;
    let entries: Array<{ name: unknown; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryName = String(entry.name);
      const path = resolve(dir, entryName);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.test(entryName)) continue;
      try {
        const stat = lstatSync(path);
        files.push({ path, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while a validation command is cleaning up.
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path);
}

function collectRecentBrowserValidationArtifacts(repo: string | undefined): string[] {
  return collectRecentBrowserValidationFiles(
    repo,
    /\.(?:png|jpe?g|webp|zip|json|txt|log|webm)$/i,
    6,
  ).map((entry) => toSingleLine(entry, 220));
}

function summarizeRecentBrowserValidationLogs(repo: string | undefined): string {
  const logFiles = collectRecentBrowserValidationFiles(repo, /\.(?:log|txt)$/i, 3);
  const summaries: string[] = [];
  for (const logFile of logFiles) {
    let content = "";
    try {
      content = readFileSync(logFile, "utf8");
    } catch {
      continue;
    }
    const lines = stripAnsiControlSequences(content)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) =>
        /\b(Web end-to-end smoke test failed|Browser validation failed|Expected |locator\.|page\.|waiting for |Call log:|Verified:|Saved screenshot|Saved trace|ERR_SOCKET_BAD_PORT|EADDRINUSE|EPERM|EACCES|browserType\.launch|Expo exited early|freeport|net::ERR_|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)/i.test(
          line,
        ),
      );
    if (lines.length === 0) continue;
    summaries.push(`${logFile}: ${lines.slice(-18).join(" | ")}`);
  }
  return toSingleLine(summaries.join(" | "), 1_400);
}

function mergeBrowserValidationArtifacts(...sources: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const artifact of source ?? []) {
      const clean = toSingleLine(artifact, 220);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function summarizeBrowserValidationOutput(text: string): string {
  const lines = stripAnsiControlSequences(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /\b(Web end-to-end smoke test failed|Browser validation failed|Expected |locator\.|page\.|waiting for getBy|Call log:|Verified:|Saved screenshot|Saved trace|ERR_SOCKET_BAD_PORT|EADDRINUSE|EPERM|EACCES|browserType\.launch|Executable doesn't exist|Expo exited early|freeport|net::ERR_|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)/i.test(
        line,
      ),
    );
  return toSingleLine(lines.slice(0, 8).join(" | "), 900);
}

function lastBrowserVerifiedStage(text: string): string | null {
  const verifiedStages = [
    ...stripAnsiControlSequences(text).matchAll(/\bVerified:\s+([^|\r\n]+)/gi),
  ]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const lastVerified = verifiedStages.at(-1);
  return lastVerified ? toSingleLine(lastVerified, 80) : null;
}

function extractBrowserValidationUrl(text: string): string | null {
  const clean = stripAnsiControlSequences(text);
  const patterns = [
    /\b(?:page\s+url|current\s+url|browser\s+url|url)\s*[:=]\s*(https?:\/\/[^\s|"'`<>]+)/i,
    /\b(?:navigated\s+to|opened|loading)\s+(https?:\/\/[^\s|"'`<>]+)/i,
    /\b(https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+\/?[^\s|"'`<>]*)/i,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const url = match?.[1]?.replace(/[),.;]+$/, "").trim();
    if (url) return toSingleLine(url, 160);
  }
  return null;
}

function inferBrowserArtifactKind(path: string): string {
  if (/\.(?:png|jpe?g|webp)$/i.test(path)) return "screenshot";
  if (/\.zip$/i.test(path)) return "trace";
  if (/\.webm$/i.test(path)) return "video";
  if (/\.(?:log|txt)$/i.test(path)) return "log";
  if (/\.json$/i.test(path)) return "json";
  return "artifact";
}

function inferBrowserArtifactStageFromPath(path: string): string | null {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const candidates = [
    baseName.match(/^\d+[-_](.+)$/)?.[1],
    baseName.match(/(?:failure|failed|screenshot|snapshot)[-_](.+)$/i)?.[1],
  ];
  const raw = candidates.find((entry) => entry && entry.trim());
  if (!raw) return null;
  return toSingleLine(raw.replace(/[-_]+/g, " "), 80);
}

function summarizeBrowserValidationArtifacts(params: {
  repo?: string;
  artifacts: string[];
  context: string;
}): string[] {
  const allArtifacts = mergeBrowserValidationArtifacts(
    params.artifacts,
    collectRecentBrowserValidationArtifacts(params.repo),
  );
  const out: string[] = [];
  const contextStage = extractBrowserValidationStage(params.context);
  const contextSelector = extractBrowserValidationSelector(params.context);
  const contextUrl = extractBrowserValidationUrl(params.context);
  const contextLastVerified = lastBrowserVerifiedStage(params.context);
  for (const artifact of allArtifacts.slice(0, 6)) {
    const kind = inferBrowserArtifactKind(artifact);
    let artifactText = "";
    if (params.repo && !/^(?:\/repo|\/workspace|[A-Za-z]:[\\/])/.test(artifact)) {
      try {
        artifactText = readFileSync(resolve(params.repo, artifact), "utf8");
      } catch {
        artifactText = "";
      }
    } else if (existsSync(artifact) && /\.(?:log|txt|json)$/i.test(artifact)) {
      try {
        artifactText = readFileSync(artifact, "utf8");
      } catch {
        artifactText = "";
      }
    }
    const artifactContext = artifactText ? stripAnsiControlSequences(artifactText) : "";
    const stage =
      inferBrowserArtifactStageFromPath(artifact) ||
      extractBrowserValidationStage(artifactContext) ||
      contextStage;
    const selector = extractBrowserValidationSelector(artifactContext) || contextSelector;
    const url = extractBrowserValidationUrl(artifactContext) || contextUrl;
    const lastVerified = lastBrowserVerifiedStage(artifactContext) || contextLastVerified;
    const detail = [
      `${artifact} [${kind}]`,
      stage ? `stage=${stage}` : "",
      selector ? `selector=${selector}` : "",
      url ? `url=${url}` : "",
      lastVerified ? `last_verified=${lastVerified}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    out.push(toSingleLine(detail, 280));
  }
  return out;
}

function browserFailureSuggestedRemedy(packet: BrowserValidationRepairPacket): string {
  if (packet.failureKind === "assertion") {
    return [
      "Read the latest artifact/log/DOM state before editing.",
      "Preserve already-passing browser stages.",
      packet.selector
        ? `Repair or replace the exact failing locator ${packet.selector} with a stable rendered signal for the same UI stage.`
        : "Repair the exact visible UI assertion or add a stable test id/accessibility label to existing UI.",
    ].join(" ");
  }
  if (packet.failureKind === "startup" || packet.failureKind === "runtime") {
    return "Treat as browser startup/runtime provisioning; do not rewrite product UI assertions until ValidationGate reaches an assertion stage.";
  }
  if (packet.failureKind === "network") {
    return "Treat as local server/network readiness; add bounded startup diagnostics and avoid changing gameplay/UI behavior.";
  }
  return "Inspect captured validation output and repair the current failing stage with the smallest behavior-owning diff.";
}

function normalizeFailureMemoryToken(value: string | null | undefined): string {
  return toSingleLine(value ?? "", 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTaskFailureJobFamily(params: Record<string, unknown>): string {
  const planning =
    params.planning && typeof params.planning === "object"
      ? (params.planning as Partial<TaskExecutePlanning>)
      : {};
  const autonomy =
    params.autonomy && typeof params.autonomy === "object"
      ? (params.autonomy as Record<string, unknown>)
      : {};
  const targetHints = [
    ...(Array.isArray(planning.targetPaths) ? planning.targetPaths : []),
    ...(Array.isArray(planning.scope?.writeGlobs) ? planning.scope.writeGlobs : []),
    ...(Array.isArray(planning.validationSteps) ? planning.validationSteps : []),
    ...(Array.isArray(planning.requiredValidationSteps) ? planning.requiredValidationSteps : []),
  ]
    .map((entry) => normalizeFailureMemoryToken(String(entry)))
    .filter(Boolean)
    .slice(0, 8);
  const area = normalizeFailureMemoryToken(
    String(autonomy.componentArea ?? autonomy.component_area ?? ""),
  );
  const intent = normalizeFailureMemoryToken(String(planning.intent ?? ""));
  return [area, intent, ...targetHints].filter(Boolean).join("|") || "general";
}

function browserFailureMemoryKey(jobFamily: string, packet: BrowserValidationRepairPacket): string {
  return [
    jobFamily,
    validationCommandKey(packet.command),
    packet.failureKind,
    normalizeFailureMemoryToken(packet.failureFocus),
    normalizeFailureMemoryToken(packet.stage),
    normalizeFailureMemoryToken(packet.selector),
    normalizeFailureMemoryToken(packet.expected),
  ]
    .filter(Boolean)
    .join("|");
}

function resolveFailureMemoryPath(repo: string): string {
  const rootCandidates = [
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_PATH,
    repo,
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const root = rootCandidates.find((entry) => existsSync(entry)) ?? repo;
  const gitStatePath = resolveGitStateFilePath(root, "pushpals-worker-failure-memory.json");
  if (gitStatePath) return gitStatePath;
  return resolve(root, "outputs", "data", "workerpals-failure-memory.json");
}

function resolveRemedyMemoryPath(repo: string): string {
  const rootCandidates = [
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_PATH,
    repo,
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const root = rootCandidates.find((entry) => existsSync(entry)) ?? repo;
  const gitStatePath = resolveGitStateFilePath(root, "pushpals-worker-remedy-memory.json");
  if (gitStatePath) return gitStatePath;
  return resolve(root, "outputs", "data", "workerpals-remedy-memory.json");
}

function readBrowserFailureMemory(repo: string): BrowserFailureMemoryEntry[] {
  const memoryPath = resolveFailureMemoryPath(repo);
  try {
    const parsed = JSON.parse(readFileSync(memoryPath, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter((entry): entry is BrowserFailureMemoryEntry =>
        Boolean(entry && typeof entry === "object"),
      )
      .slice(0, 80);
  } catch {
    return [];
  }
}

export function knownFailureHintsForPacket(
  repo: string,
  jobFamily: string,
  packet: BrowserValidationRepairPacket,
): string[] {
  const entries = readBrowserFailureMemory(repo)
    .filter((entry) => {
      if (entry.jobFamily !== jobFamily) return false;
      if (validationCommandKey(entry.command) !== validationCommandKey(packet.command))
        return false;
      if (entry.failureKind !== packet.failureKind) return false;
      if (packet.failureFocus && entry.failureFocus && packet.failureFocus !== entry.failureFocus)
        return false;
      if (packet.stage && entry.stage && packet.stage !== entry.stage) return false;
      return true;
    })
    .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 3);
  return entries.map((entry) =>
    toSingleLine(
      `seen ${entry.count}x before for this repo/job family; last=${entry.lastSeenAt}; focus=${entry.failureFocus ?? entry.stage ?? "unknown"}; remedy=${entry.suggestedRemedy}`,
      360,
    ),
  );
}

export function recordBrowserFailureMemory(
  repo: string,
  jobFamily: string,
  packet: BrowserValidationRepairPacket,
): void {
  const memoryPath = resolveFailureMemoryPath(repo);
  const now = new Date().toISOString();
  const entries = readBrowserFailureMemory(repo);
  const key = browserFailureMemoryKey(jobFamily, packet);
  const existing = entries.find((entry) => entry.key === key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    existing.digest = packet.digest;
    existing.lastVerifiedStage = packet.lastVerifiedStage ?? null;
    existing.pageUrl = packet.pageUrl ?? null;
    existing.artifactSummaries = (packet.artifactSummaries ?? []).slice(0, 6);
    existing.suggestedRemedy = browserFailureSuggestedRemedy(packet);
  } else {
    entries.push({
      key,
      jobFamily,
      command: packet.command,
      failureKind: packet.failureKind,
      stage: packet.stage,
      selector: packet.selector,
      expected: packet.expected,
      failureFocus: packet.failureFocus,
      digest: packet.digest,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedStage: packet.lastVerifiedStage ?? null,
      pageUrl: packet.pageUrl ?? null,
      artifactSummaries: (packet.artifactSummaries ?? []).slice(0, 6),
      suggestedRemedy: browserFailureSuggestedRemedy(packet),
    });
  }
  const next = entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 80);
  try {
    mkdirSync(resolve(memoryPath, ".."), { recursive: true });
    writeFileSync(memoryPath, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`);
  } catch {
    // Failure memory is advisory; never fail a worker job because persistence is unavailable.
  }
}

function classifyValidationFailureForRemedy(run: ValidationExecutionResult): string {
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  if (isLongRunningBrowserValidationCommand(run.command)) return "browser";
  if (
    /\bCannot find module\b|\bmodule not found\b|\bfailed to resolve import\b|\bcould not resolve\b/i.test(
      combined,
    )
  ) {
    return "module-resolution";
  }
  if (
    /\bTS\d{4}\b|\btype error\b|\bno exported member\b|\bdoes not exist on type\b|\bis not assignable to\b/i.test(
      combined,
    )
  ) {
    return "typecheck";
  }
  if (
    /\bESLint\b|\beslint\b|\blint\b/i.test(run.command) ||
    /\berror:\s+"eslint"\s+exited/i.test(combined)
  ) {
    return "lint";
  }
  if (/\bNo such file or directory\b|\bENOENT\b|\bpath does not exist\b/i.test(combined)) {
    return "missing-path";
  }
  if (/\breact[- ]native|mock|__mocks__|setupTests?|jest|vitest|test helper\b/i.test(combined)) {
    return "test-harness";
  }
  return "validation";
}

function validationRemedyMemoryKey(jobFamily: string, run: ValidationExecutionResult): string {
  const failureClass = classifyValidationFailureForRemedy(run);
  const digest = extractValidationFailureRetryDigest(run);
  return [
    jobFamily,
    validationCommandKey(run.command),
    failureClass,
    normalizeFailureMemoryToken(digest),
  ]
    .filter(Boolean)
    .join("|");
}

function validationFailureSuggestedRemedy(run: ValidationExecutionResult): string {
  const failureClass = classifyValidationFailureForRemedy(run);
  switch (failureClass) {
    case "module-resolution":
      return "Fix or avoid the missing import/path first; do not run long browser validation while module resolution is broken.";
    case "typecheck":
      return "Fix TypeScript/type errors before broader validation; prefer the smallest type-safe patch over test-harness expansion.";
    case "lint":
      return "Fix lint/static issues before expensive runtime checks; avoid unrelated formatting churn.";
    case "missing-path":
      return "Treat absent hinted paths as stale unless the task explicitly asks to create them; switch to an existing repo-native owner.";
    case "test-harness":
      return "If failures are in mocks/import setup, reduce to smaller helper/state coverage instead of broad shared mock expansion.";
    default:
      return "Repair the first deterministic fast validation failure before running long browser/e2e validation.";
  }
}

function readValidationRemedyMemory(repo: string): ValidationRemedyMemoryEntry[] {
  const memoryPath = resolveRemedyMemoryPath(repo);
  try {
    const parsed = JSON.parse(readFileSync(memoryPath, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter((entry): entry is ValidationRemedyMemoryEntry =>
        Boolean(entry && typeof entry === "object"),
      )
      .slice(0, 120);
  } catch {
    return [];
  }
}

export function knownValidationRemedyHintsForRuns(
  repo: string,
  jobFamily: string,
  runs: ValidationExecutionResult[],
): string[] {
  const failed = runs.filter(
    (run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command),
  );
  if (failed.length === 0) return [];
  const entries = readValidationRemedyMemory(repo);
  const hints: string[] = [];
  for (const run of failed.slice(0, 4)) {
    const failureClass = classifyValidationFailureForRemedy(run);
    const commandKey = validationCommandKey(run.command);
    const matches = entries
      .filter(
        (entry) =>
          entry.jobFamily === jobFamily &&
          validationCommandKey(entry.command) === commandKey &&
          entry.failureClass === failureClass,
      )
      .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 2);
    for (const entry of matches) {
      hints.push(
        toSingleLine(
          `${entry.command} ${entry.failureClass} seen ${entry.count}x before; last=${entry.lastSeenAt}; remedy=${entry.suggestedRemedy}`,
          360,
        ),
      );
    }
  }
  return Array.from(new Set(hints)).slice(0, 5);
}

export function recordValidationRemedyMemory(
  repo: string,
  jobFamily: string,
  runs: ValidationExecutionResult[],
): void {
  const failed = runs.filter(
    (run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command),
  );
  if (failed.length === 0) return;
  const memoryPath = resolveRemedyMemoryPath(repo);
  const now = new Date().toISOString();
  const entries = readValidationRemedyMemory(repo);
  for (const run of failed.slice(0, 6)) {
    const key = validationRemedyMemoryKey(jobFamily, run);
    const existing = entries.find((entry) => entry.key === key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      existing.digest = extractValidationFailureRetryDigest(run);
      existing.suggestedRemedy = validationFailureSuggestedRemedy(run);
    } else {
      entries.push({
        key,
        jobFamily,
        command: run.command,
        failureClass: classifyValidationFailureForRemedy(run),
        digest: extractValidationFailureRetryDigest(run),
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        suggestedRemedy: validationFailureSuggestedRemedy(run),
      });
    }
  }
  const next = entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 120);
  try {
    mkdirSync(resolve(memoryPath, ".."), { recursive: true });
    writeFileSync(memoryPath, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`);
  } catch {
    // Remedy memory is advisory; never fail a worker job because persistence is unavailable.
  }
}

export function extractValidationFailureRetryDigest(
  run: {
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    elapsedMs?: number;
  },
  repo?: string,
): string {
  const baseDigest = extractValidationFailureDigest(run);
  if (
    !isLongRunningBrowserValidationCommand(run.command) &&
    !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command))
  ) {
    return baseDigest;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
  const failureKind = classifyBrowserValidationFailureKindFromText(`${baseDigest}\n${combined}`);
  if (failureKind !== "assertion") return baseDigest;

  const recentLogSummary = summarizeRecentBrowserValidationLogs(repo);
  const enrichedBrowserContext = [combined, recentLogSummary].filter(Boolean).join("\n");
  const selector = extractBrowserValidationSelector(enrichedBrowserContext);
  const expected = extractBrowserValidationExpectedUi(enrichedBrowserContext);
  const stage = refineBrowserValidationStage(
    extractBrowserValidationStage(enrichedBrowserContext),
    selector,
    expected,
    enrichedBrowserContext,
  );
  const lastVerified = lastBrowserVerifiedStage(enrichedBrowserContext);
  const output = summarizeBrowserValidationOutput(enrichedBrowserContext);
  const parts = [
    baseDigest,
    stage ? `stage=${stage}` : "",
    selector ? `selector=${selector}` : "",
    expected ? `expected=${expected}` : "",
    lastVerified ? `last verified=${lastVerified}` : "",
    output && output !== baseDigest ? output : "",
  ].filter(Boolean);
  return toSingleLine(parts.join(" | "), 900) || baseDigest;
}

export function buildBrowserValidationRepairPacket(
  validationRuns: ValidationExecutionResult[],
  previousFailureDigests: Map<string, string> = new Map(),
  repo?: string,
  knownFailureHints: string[] = [],
): BrowserValidationRepairPacket | null {
  for (const run of validationRuns) {
    if (
      run.ok ||
      (!isLongRunningBrowserValidationCommand(run.command) &&
        !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command)))
    ) {
      continue;
    }
    const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n"));
    const baseDigest = extractValidationFailureDigest(run);
    const failureKind = classifyBrowserValidationFailureKindFromText(`${baseDigest}\n${combined}`);
    if (failureKind === "unknown") continue;
    const digest =
      failureKind === "assertion"
        ? extractValidationFailureRetryDigest(run, repo) || baseDigest
        : baseDigest;
    const previousDigest = previousFailureDigests.get(validationCommandKey(run.command)) ?? null;
    const recentLogSummary = summarizeRecentBrowserValidationLogs(repo);
    const enrichedBrowserContext = [combined, recentLogSummary].filter(Boolean).join("\n");
    const selector = extractBrowserValidationSelector(enrichedBrowserContext);
    const expected = extractBrowserValidationExpectedUi(enrichedBrowserContext);
    const lastVerifiedStage = lastBrowserVerifiedStage(enrichedBrowserContext);
    const pageUrl = extractBrowserValidationUrl(enrichedBrowserContext);
    const stage = refineBrowserValidationStage(
      extractBrowserValidationStage(enrichedBrowserContext),
      selector,
      expected,
      enrichedBrowserContext,
    );
    const previousStage = previousDigest ? extractBrowserValidationStage(previousDigest) : null;
    const previousSelector = previousDigest
      ? extractBrowserValidationSelector(previousDigest)
      : null;
    const previousExpected = previousDigest
      ? extractBrowserValidationExpectedUi(previousDigest)
      : null;
    const failureFocus = inferBrowserValidationFailureFocus({
      stage,
      selector,
      expected,
      text: enrichedBrowserContext,
    });
    const previousFailureFocus = previousDigest
      ? inferBrowserValidationFailureFocus({
          stage: previousStage,
          selector: previousSelector,
          expected: previousExpected,
          text: previousDigest,
        })
      : null;
    const sameFailureSignal =
      Boolean(previousDigest) &&
      (previousDigest === digest ||
        (Boolean(failureFocus) &&
          failureFocus === previousFailureFocus &&
          (!selector || !previousSelector || selector === previousSelector)));
    const progress =
      previousDigest == null ? "first_failure" : sameFailureSignal ? "same_failure" : "new_failure";
    const needsDiagnosticProbe = failureKind === "assertion" && sameFailureSignal;
    const artifacts = mergeBrowserValidationArtifacts(
      extractBrowserValidationArtifacts(combined),
      collectRecentBrowserValidationArtifacts(repo),
    );
    const artifactSummaries = summarizeBrowserValidationArtifacts({
      repo,
      artifacts,
      context: enrichedBrowserContext,
    });
    return {
      command: run.command,
      failureKind,
      stage,
      selector,
      expected,
      failureFocus,
      lastVerifiedStage,
      pageUrl,
      digest,
      previousDigest,
      previousStage,
      previousSelector,
      previousExpected,
      previousFailureFocus,
      progress,
      needsDiagnosticProbe,
      mustReadArtifactsBeforeEdit: failureKind === "assertion",
      artifacts,
      artifactSummaries,
      knownFailureHints: knownFailureHints.slice(0, 3),
      output: [summarizeBrowserValidationOutput(combined) || digest, recentLogSummary]
        .filter(Boolean)
        .join(" | "),
    };
  }
  return null;
}

export function collectRequiredValidationFailures(
  requiredCommands: string[],
  validationRuns: Array<{ command: string; ok: boolean; exitCode?: number }>,
): string[] {
  const requiredKeys = new Set(requiredCommands.map(validationCommandKey).filter(Boolean));
  if (requiredKeys.size === 0) return [];
  return validationRuns
    .filter((run) => requiredKeys.has(validationCommandKey(run.command)) && !run.ok)
    .map((run) => {
      const exitCode = Number.isFinite(Number(run.exitCode)) ? Number(run.exitCode) : "unknown";
      const digest = extractValidationFailureDigest(run);
      return `${run.command} exited ${exitCode}${digest ? ` (${digest})` : ""}`;
    });
}

export function extractRequiredValidationStepsFromVisionMarkdown(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const criterion of extractVisionKeyItems(markdown).testingCriteria) {
    const command = extractRunnableValidationCommand(String(criterion ?? ""));
    if (!command) continue;
    const key = command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
    if (out.length >= 12) break;
  }
  return out;
}

function loadRequiredValidationStepsFromVision(repo: string): string[] {
  const visionPath = resolve(repo, "vision.md");
  if (!existsSync(visionPath)) return [];
  try {
    return extractRequiredValidationStepsFromVisionMarkdown(readFileSync(visionPath, "utf8"));
  } catch {
    return [];
  }
}

function resolveRequiredValidationSteps(repo: string, planning: TaskExecutePlanning): string[] {
  return dedupeValidationCommands(
    runnableValidationCommandsFromSteps(planning.requiredValidationSteps),
    loadRequiredValidationStepsFromVision(repo),
  ).slice(0, 12);
}

function runnableValidationCommandsFromSteps(steps: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of steps ?? []) {
    const extracted = extractRunnableValidationCommand(String(step ?? ""));
    const command = extracted ? normalizeRunnableValidationCommand(extracted) : null;
    if (!command) continue;
    const key = command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}

function normalizeRunnableValidationCommand(command: string): string | null {
  if (/<[A-Za-z][A-Za-z0-9:._ -]*>/.test(command)) return null;
  const bunTestCommand = normalizeBunTestValidationCommand(command);
  return bunTestCommand === undefined ? command : bunTestCommand;
}

function normalizeBunTestValidationCommand(command: string): string | null | undefined {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv || argv.length === 0 || !isBunCommandToken(argv[0] ?? "")) return undefined;

  let testIndex = -1;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--cwd" || lower === "-c" || lower === "-C" || lower === "--prefix") {
      index += 1;
      continue;
    }
    if (lower.startsWith("--cwd=") || lower.startsWith("-c=") || lower.startsWith("--prefix=")) {
      continue;
    }
    if (lower.startsWith("-")) continue;
    if (lower === "test") testIndex = index;
    break;
  }
  if (testIndex < 0) return undefined;

  const prefix = argv.slice(0, testIndex + 1);
  const args = argv.slice(testIndex + 1);
  let droppedSupportPath = false;
  let runnablePathCount = 0;
  const keptArgs: string[] = [];

  for (const arg of args) {
    const normalizedPath = normalizeValidationPathToken(arg);
    if (
      normalizedPath &&
      isTestSupportPath(normalizedPath) &&
      !isAssertionCoverageTestPath(normalizedPath) &&
      !isBrowserSmokeHarnessPath(normalizedPath)
    ) {
      droppedSupportPath = true;
      continue;
    }
    if (
      normalizedPath &&
      (isAssertionCoverageTestPath(normalizedPath) || isBrowserSmokeHarnessPath(normalizedPath))
    ) {
      runnablePathCount += 1;
    }
    keptArgs.push(arg);
  }

  if (!droppedSupportPath) return command;
  if (runnablePathCount === 0) return null;
  return [...prefix, ...keptArgs].map((entry) => quoteValidationCommandArg(entry)).join(" ");
}

function dedupeValidationCommands(...groups: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const command of group) {
      const trimmed = command.trim();
      if (!trimmed) continue;
      const key = validationCommandKey(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export function collectQualityGateValidationCommands(params: {
  instruction: string;
  targetPath?: string;
  planning: TaskExecutePlanning;
  changedTestPaths: string[];
  isTestTask: boolean;
  repo?: string;
  changedPaths?: string[];
}): {
  commandsToRun: string[];
  requiredRunnableSteps: string[];
  plannerRunnableSteps: string[];
  fallbackValidationSteps: string[];
  inferredRepoNativeValidationSteps: string[];
} {
  const requiredRunnableSteps = runnableValidationCommandsFromSteps(
    params.planning.requiredValidationSteps,
  ).slice(0, 12);
  const plannerRunnableSteps = runnableValidationCommandsFromSteps(
    params.planning.validationSteps,
  ).slice(0, 4);
  const fallbackValidationSteps =
    params.isTestTask && plannerRunnableSteps.length === 0
      ? inferFallbackValidationCommandsForTestTask(
          params.instruction,
          params.targetPath,
          params.planning,
          params.changedTestPaths,
        )
      : [];
  const inferredRepoNativeValidationSteps = params.repo
    ? inferRepoNativeValidationCommands(params.repo, params.changedPaths ?? [])
    : [];
  const commandsToRun = dedupeValidationCommands(
    requiredRunnableSteps,
    plannerRunnableSteps.length > 0 ? plannerRunnableSteps : fallbackValidationSteps,
    inferredRepoNativeValidationSteps,
  ).slice(0, 16);
  return {
    commandsToRun,
    requiredRunnableSteps,
    plannerRunnableSteps,
    fallbackValidationSteps,
    inferredRepoNativeValidationSteps,
  };
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

  const bunTestPath = (path: string) => formatBunTestPathArg(path);
  const normalizedTarget = (targetPath ?? "").replace(/\\/g, "/").trim();
  if (
    normalizedTarget &&
    (isAssertionCoverageTestPath(normalizedTarget) || isBrowserSmokeHarnessPath(normalizedTarget))
  ) {
    add(pythonSignal ? `pytest ${normalizedTarget}` : `bun test ${bunTestPath(normalizedTarget)}`);
  }

  const runnableChangedTestPaths = changedTestPaths.filter(
    (entry) => isAssertionCoverageTestPath(entry) || isBrowserSmokeHarnessPath(entry),
  );
  if (runnableChangedTestPaths.length > 0) {
    const focused = runnableChangedTestPaths.slice(0, 4);
    add(
      pythonSignal
        ? `pytest ${focused.join(" ")}`
        : `bun test ${focused.map((entry) => bunTestPath(entry)).join(" ")}`,
    );
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

export function formatBunTestPathArg(path: string): string {
  const normalized = String(path ?? "")
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return normalized;
  const pathArg =
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : `./${normalized}`;
  return quoteValidationCommandArg(pathArg);
}

function quoteValidationCommandArg(arg: string): string {
  if (!/[\s"\\]/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isTestFocusedTask(
  instruction: string,
  planning: TaskExecutePlanning,
  targetPath?: string,
): boolean {
  const lowerInstruction = instruction.toLowerCase();
  if (
    /\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b.{0,80}\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/.test(
      lowerInstruction,
    ) ||
    /\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b.{0,80}\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b/.test(
      lowerInstruction,
    )
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
    planning.acceptanceCriteria.some((entry) =>
      /\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b.{0,80}\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/i.test(
        entry,
      ),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function changedPathMentionsGuidance(pathPattern: RegExp, guidance: string): boolean {
  return pathPattern.test(guidance);
}

export function collectPrePublishHygieneIssues(params: {
  repo: string;
  changedPaths: string[];
  instruction: string;
  targetPath?: string;
  planning: TaskExecutePlanning;
  reviewAgent?: Record<string, unknown> | null;
}): string[] {
  const changedPaths = params.changedPaths.map((path) => path.replace(/\\/g, "/"));
  const changedPathSet = new Set(changedPaths);
  const guidance = [
    params.instruction,
    params.targetPath ?? "",
    ...(params.planning.targetPaths ?? []),
    ...(params.planning.scope.writeGlobs ?? []),
    ...(params.planning.acceptanceCriteria ?? []),
    ...(params.planning.validationSteps ?? []),
    ...((params.reviewAgent?.reviewerFindings as string[] | undefined) ?? []),
  ]
    .join("\n")
    .toLowerCase();
  const issues: string[] = [];

  if (
    changedPathSet.has(".gitignore") &&
    !changedPathMentionsGuidance(
      /\b(gitignore|ignore file|node_modules|dependency cache)\b/i,
      guidance,
    )
  ) {
    issues.push(
      "modified .gitignore without task or reviewer guidance requesting ignore-policy changes.",
    );
  }

  if (changedPathSet.has("tests/reactNativeMock.ts")) {
    const changedTestPaths = changedPaths.filter((path) => isAssertionCoverageTestPath(path));
    const hasConsumerInChangedTests = changedTestPaths.some((rel) => {
      try {
        return /reactNativeMock/i.test(readFileSync(resolve(params.repo, rel), "utf8"));
      } catch {
        return false;
      }
    });
    const explicitlyRequested = changedPathMentionsGuidance(
      /reactnativemock|react native mock/i,
      guidance,
    );
    if (!hasConsumerInChangedTests && !explicitlyRequested) {
      issues.push(
        "changed tests/reactNativeMock.ts without a changed test importing it or explicit reviewer guidance.",
      );
    }
  }

  if (changedPaths.some((path) => isNestedNodeModulesChange(path))) {
    issues.push(
      "attempted to publish node_modules changes; dependency installs must not become PR content.",
    );
  }

  return Array.from(new Set(issues));
}

export function inferRepoNativeValidationCommands(repo: string, changedPaths: string[]): string[] {
  const packageJsonPath = resolve(repo, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  let packageJson: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } = {};
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return [];
  }

  const scripts = packageJson.scripts ?? {};
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  const normalizedPaths = changedPaths.map((path) => path.replace(/\\/g, "/"));
  const hasNonDocChange = normalizedPaths.some((path) => !/\.(?:md|mdx|txt)$/i.test(path));
  const hasTsChange = normalizedPaths.some((path) => /\.[cm]?tsx?$/i.test(path));
  const commands: string[] = [];

  if (hasTsChange) {
    if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
      commands.push("bun run typecheck");
    } else if (
      existsSync(resolve(repo, "tsconfig.json")) ||
      Object.prototype.hasOwnProperty.call(dependencies, "typescript")
    ) {
      commands.push("bun x tsc --noEmit");
    }
  }

  if (hasNonDocChange && typeof scripts.lint === "string" && scripts.lint.trim()) {
    commands.push("bun run lint");
  }

  return dedupeValidationCommands(commands).slice(0, 4);
}

async function runDeterministicQualityGate(
  repo: string,
  params: Record<string, unknown>,
  runtimeConfig: WorkerpalsRuntimeConfig,
  qualityGatePolicy: QualityGatePolicy,
  onLog?: (stream: "stdout" | "stderr", line: string) => void,
  validationRetryState?: {
    previousFailureDigests?: Map<string, string>;
    revisionAttempt?: number;
  },
): Promise<DeterministicQualityResult> {
  const instruction = String(params.instruction ?? "");
  const targetPath = String(params.targetPath ?? params.path ?? "").trim() || undefined;
  const planning = params.planning as TaskExecutePlanning;
  const requiredValidationSteps = resolveRequiredValidationSteps(repo, planning);
  if (requiredValidationSteps.length > 0) {
    planning.requiredValidationSteps = requiredValidationSteps;
  }
  const isTestTask = isTestFocusedTask(instruction, planning, targetPath);
  const hasRequiredValidationCriteria = requiredValidationSteps.length > 0;
  if (
    !qualityGatePolicy.scopeGateEnabled &&
    !qualityGatePolicy.validationGateEnabled &&
    !qualityGatePolicy.criticGateEnabled &&
    !isTestTask &&
    !hasRequiredValidationCriteria
  ) {
    return {
      ok: true,
      skipped: true,
      issues: [],
      scopeIssues: [],
      validationIssues: [],
      changedPaths: [],
      changedTestPaths: [],
      validationRuns: [],
      requiredValidationFailures: [],
      blocker: null,
      validationFailureScope: "none",
    };
  }

  const statusResult = await git(repo, ["status", "--porcelain"]);
  const rawChangedPaths = statusResult.ok
    ? expandKnownArtifactDirectoryPaths(repo, parseChangedPathsFromStatus(statusResult.stdout))
    : [];
  const changedPaths = statusResult.ok
    ? await filterChangedPathsByGitContentDelta(repo, rawChangedPaths)
    : rawChangedPaths;
  const preparedMergeConflictPaths = extractPreparedMergeConflictPaths(params);
  const changedTestPaths = Array.from(
    new Set(
      [...changedPaths, ...preparedMergeConflictPaths].filter((path) => isLikelyTestPath(path)),
    ),
  );
  const changedAssertionCoverageTestPaths = changedTestPaths.filter((path) =>
    isAssertionCoverageTestPath(path),
  );
  const issues: string[] = [];
  const scopeIssues: string[] = [];
  const validationIssues: string[] = [];
  const addScopeIssue = (issue: string): void => {
    scopeIssues.push(issue);
    issues.push(`ScopeGate: ${issue}`);
  };
  const addValidationIssue = (issue: string): void => {
    validationIssues.push(issue);
    issues.push(`ValidationGate: ${issue}`);
  };

  if (qualityGatePolicy.scopeGateEnabled) {
    if (!statusResult.ok) {
      addScopeIssue("could not evaluate changed paths from git status.");
    }
    for (const issue of collectPrePublishHygieneIssues({
      repo,
      changedPaths,
      instruction,
      targetPath,
      planning,
      reviewAgent: asRecord(params.reviewAgent ?? params.review_agent),
    })) {
      addScopeIssue(issue);
    }
    for (const issue of collectWriteScopeIssuesFromChangedPaths(changedPaths, planning)) {
      addScopeIssue(issue);
    }
    if (
      isTestTask &&
      changedTestPaths.length === 0 &&
      !allowsValidationToolingOnlyChangeForTestFocusedTask({
        instruction,
        planning,
        changedPaths,
      })
    ) {
      addScopeIssue("found no relevant test file modified for this test-focused task.");
    }
    if (
      isTestTask &&
      changedAssertionCoverageTestPaths.length > 0 &&
      !hasBalancedPositiveNegativeAssertions(changedAssertionCoverageTestPaths, repo)
    ) {
      addScopeIssue(
        "found changed test files without both positive and negative assertion coverage (expected both).",
      );
    }
    for (const issue of scopeIssues) {
      onLog?.("stderr", `[ScopeGate] ${issue}`);
    }
  } else {
    onLog?.("stdout", "[ScopeGate] Disabled by workerpals.quality_scope_gate_enabled=false.");
  }

  if (!qualityGatePolicy.validationGateEnabled) {
    onLog?.(
      "stdout",
      "[ValidationGate] Disabled by workerpals.quality_validation_gate_enabled=false.",
    );
  }

  const { commandsToRun, requiredRunnableSteps, plannerRunnableSteps, fallbackValidationSteps } =
    collectQualityGateValidationCommands({
      instruction,
      targetPath,
      planning,
      changedTestPaths,
      isTestTask,
      repo,
      changedPaths,
    });
  const validationRuns: ValidationExecutionResult[] = [];
  const outputPolicy = outputPolicyForRuntime(runtimeConfig);
  const qualityValidationStepTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityValidationStepTimeoutMs);
    if (!Number.isFinite(value)) return 180_000;
    return Math.max(1_000, Math.min(7_200_000, Math.floor(value)));
  })();
  let requiredValidationFailures: string[] = [];
  if (qualityGatePolicy.validationGateEnabled) {
    if (hasRequiredValidationCriteria && requiredRunnableSteps.length === 0) {
      addValidationIssue(
        "found vision.md testing criteria, but none contained a runnable validation command.",
      );
    }
    if (commandsToRun.length === 0) {
      addValidationIssue(
        hasRequiredValidationCriteria
          ? "found no runnable validation command from vision.md testing criteria or planning.validationSteps."
          : "found no runnable validation command in planning.validationSteps (expected at least one test command).",
      );
    } else {
      if (requiredRunnableSteps.length > 0) {
        onLog?.(
          "stdout",
          `[ValidationGate] Running required vision.md testing criteria: ${requiredRunnableSteps.join(" | ")}`,
        );
      }
      if (isTestTask && plannerRunnableSteps.length === 0 && fallbackValidationSteps.length > 0) {
        onLog?.(
          "stdout",
          `[ValidationGate] No runnable planning.validationSteps found; using fallback validation command(s): ${commandsToRun.join(" | ")}`,
        );
      }
      const dependencyPreflightFailure = await runBunDependencyLayoutPreflight(
        repo,
        commandsToRun,
        requiredRunnableSteps[0] ?? commandsToRun[0] ?? "",
        qualityValidationStepTimeoutMs,
        outputPolicy,
        onLog,
      );
      if (dependencyPreflightFailure) {
        validationRuns.push(dependencyPreflightFailure);
        onLog?.(
          "stderr",
          `[ValidationGate] Dependency layout preflight blocked validation before "${dependencyPreflightFailure.command}".`,
        );
      } else {
        const toolchainPlan = buildToolchainPlan({
          repoRoot: repo,
          validationCommands: commandsToRun,
        });
        if (toolchainPlan.requirements.length > 0) {
          onLog?.(
            "stdout",
            `[ValidationGate] Toolchain preflight: source=${toolchainPlan.environmentSource}, required=${toolchainPlan.requirements
              .map((requirement) => requirement.tool)
              .join(", ")}`,
          );
        }
        const toolAvailability = await checkToolAvailability(
          toolchainPlan.requirements,
          buildWorkerSandboxWritableEnv(repo),
        );
        const missingToolRequirements = toolAvailability
          .filter((entry) => !entry.ok)
          .map((entry) => entry.requirement);
        if (missingToolRequirements.length > 0) {
          onLog?.(
            "stderr",
            `[ValidationGate] Toolchain preflight blocked dependent validation command(s): ${formatMissingToolRequirements(
              missingToolRequirements,
            )}`,
          );
        }
        const playwrightBrowserRuntimeReadyTargets = new Set<string>();
        for (let commandIndex = 0; commandIndex < commandsToRun.length; ) {
          const parallelBatch: string[] = [];
          while (
            commandIndex + parallelBatch.length < commandsToRun.length &&
            parallelBatch.length < 3
          ) {
            const candidate = commandsToRun[commandIndex + parallelBatch.length];
            if (!isParallelSafeFastValidationCommand(repo, candidate)) break;
            parallelBatch.push(candidate);
          }
          if (parallelBatch.length > 1) {
            onLog?.(
              "stdout",
              `[ValidationGate] Running fast validation batch in parallel: ${parallelBatch.join(" | ")}`,
            );
            const batchRuns = await Promise.all(
              parallelBatch.map(async (command) => {
                const commandMissingTools = requirementsForValidationCommand(
                  toolchainPlan,
                  command,
                ).filter((requirement) =>
                  missingToolRequirements.some((missing) => missing.tool === requirement.tool),
                );
                if (commandMissingTools.length > 0) {
                  const stderr = `Validation skipped before execution because required tool(s) are missing: ${formatMissingToolRequirements(
                    commandMissingTools,
                  )}.`;
                  return {
                    run: {
                      step: command,
                      command,
                      ok: false,
                      exitCode: 127,
                      stdout: "",
                      stderr,
                      elapsedMs: 1,
                    } satisfies ValidationExecutionResult,
                    stream: "stderr" as const,
                    summary: `[ValidationGate] Validation skipped (missing toolchain): ${command}`,
                  };
                }
                const run = await runValidationCommand(
                  repo,
                  command,
                  resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo),
                  outputPolicy,
                );
                const digest = run.ok ? "" : extractValidationFailureDigest(run);
                return {
                  run,
                  stream: (run.ok ? "stdout" : "stderr") as "stdout" | "stderr",
                  summary: `[ValidationGate] ${run.ok ? "Passed" : "Failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}${digest ? ` - ${digest}` : ""}`,
                };
              }),
            );
            for (const { run, stream, summary } of batchRuns) {
              validationRuns.push(run);
              onLog?.(stream, summary);
            }
            commandIndex += parallelBatch.length;
            continue;
          }

          const command = commandsToRun[commandIndex];
          commandIndex += 1;
          const commandMissingTools = requirementsForValidationCommand(
            toolchainPlan,
            command,
          ).filter((requirement) =>
            missingToolRequirements.some((missing) => missing.tool === requirement.tool),
          );
          if (commandMissingTools.length > 0) {
            const stderr = `Validation skipped before execution because required tool(s) are missing: ${formatMissingToolRequirements(
              commandMissingTools,
            )}.`;
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 127,
              stdout: "",
              stderr,
              elapsedMs: 1,
            });
            onLog?.(
              "stderr",
              `[ValidationGate] Validation skipped (missing toolchain): ${command}`,
            );
            continue;
          }
          const deferredReason = shouldDeferLongValidationAfterFastFailures(
            command,
            validationRuns,
            repo,
          );
          if (deferredReason) {
            const stderr =
              `Skipped long validation command because ${deferredReason}. ` +
              "Fix the deterministic fast validation blocker first; PushPals will run long browser/e2e validation after the fast layer is clean.";
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 125,
              stdout: "",
              stderr,
              elapsedMs: 1,
            });
            onLog?.(
              "stderr",
              `[ValidationGate] Deferred long validation after fast failure: ${command} (${deferredReason})`,
            );
            continue;
          }
          const commandNeedsPlaywrightBrowserRuntime = shouldEnsurePlaywrightBrowserRuntime(
            repo,
            command,
          );
          const playwrightBrowserTargets = commandNeedsPlaywrightBrowserRuntime
            ? inferPlaywrightBrowserInstallTargets(repo, command)
            : [];
          const missingPlaywrightBrowserTargets = playwrightBrowserTargets.filter(
            (target) => !playwrightBrowserRuntimeReadyTargets.has(target),
          );
          let commandBrowserRuntimeEnsured =
            commandNeedsPlaywrightBrowserRuntime && missingPlaywrightBrowserTargets.length === 0;
          if (missingPlaywrightBrowserTargets.length > 0) {
            const browserEnv = buildWorkerSandboxWritableEnv(repo);
            onLog?.(
              "stdout",
              `[ValidationGate] Browser runtime preflight: ensuring Playwright browser target(s) ${missingPlaywrightBrowserTargets.join(", ")} for "${command}" at ${browserEnv.PLAYWRIGHT_BROWSERS_PATH ?? "(default browser cache)"}`,
            );
            const browserPreflight = await runPlaywrightBrowserRuntimePreflight(
              repo,
              command,
              missingPlaywrightBrowserTargets,
              resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo),
              outputPolicy,
            );
            if (!browserPreflight.ok) {
              const digest = extractValidationFailureDigest(browserPreflight);
              validationRuns.push({
                ...browserPreflight,
                stderr: [
                  `Browser runtime preflight failed before validation command "${command}". WorkerPals could not ensure Playwright browser target(s) ${missingPlaywrightBrowserTargets.join(", ")} in PLAYWRIGHT_BROWSERS_PATH=${browserEnv.PLAYWRIGHT_BROWSERS_PATH ?? "(default)"}.`,
                  browserPreflight.stderr,
                ]
                  .filter(Boolean)
                  .join("\n"),
              });
              onLog?.(
                "stderr",
                `[ValidationGate] Browser runtime preflight failed for "${command}"${digest ? ` - ${digest}` : ""}`,
              );
              continue;
            }
            for (const target of missingPlaywrightBrowserTargets) {
              playwrightBrowserRuntimeReadyTargets.add(target);
            }
            onLog?.(
              "stdout",
              `[ValidationGate] Browser runtime preflight passed for "${command}" (${missingPlaywrightBrowserTargets.join(", ")})`,
            );
            commandBrowserRuntimeEnsured = true;
          }
          const previousDigest = validationRetryState?.previousFailureDigests?.get(
            validationCommandKey(command),
          );
          if (
            previousDigest &&
            Number(validationRetryState?.revisionAttempt ?? 0) > 0 &&
            validationCommandIncludesLongRunningBrowserWork(repo, command) &&
            isBrowserValidationInfrastructureDigest(previousDigest) &&
            !commandBrowserRuntimeEnsured
          ) {
            const stderr =
              `Skipped repeated browser validation after the same command failed in an earlier revision: ${previousDigest}. ` +
              "Run it once after the underlying blocker changes.";
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 124,
              stdout: "",
              stderr,
              elapsedMs: 1,
            });
            onLog?.(
              "stderr",
              `[ValidationGate] Skipped repeated long browser validation: ${command} (${previousDigest})`,
            );
            continue;
          }
          onLog?.("stdout", `[ValidationGate] Running "${command}"`);
          let run = await runValidationCommand(
            repo,
            command,
            resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo),
            outputPolicy,
          );
          const firstDigest = run.ok ? "" : extractValidationFailureDigest(run);
          const retryBrowserValidation = shouldRetryBrowserValidationRunOnce(run, repo);
          const retryPassingVitestTeardown = shouldRetryPassingVitestTeardownOnce(run);
          if (retryBrowserValidation || retryPassingVitestTeardown) {
            onLog?.(
              "stderr",
              retryPassingVitestTeardown
                ? `[ValidationGate] Retrying validation once after all Vitest assertions passed but worker teardown failed: ${command}${firstDigest ? ` - ${firstDigest}` : ""}`
                : `[ValidationGate] Retrying browser validation once after retryable startup/runtime failure: ${command}${firstDigest ? ` - ${firstDigest}` : ""}`,
            );
            const retryRun = await runValidationCommand(
              repo,
              command,
              resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo),
              outputPolicy,
            );
            if (!retryRun.ok && firstDigest) {
              retryRun.stderr = [
                `Previous browser validation attempt failed before retry: ${firstDigest}`,
                retryRun.stderr,
              ]
                .filter(Boolean)
                .join("\n");
            }
            run = retryRun;
          }
          validationRuns.push(run);
          const digest = run.ok ? "" : extractValidationFailureDigest(run);
          const runSummary = `[ValidationGate] ${run.ok ? "Passed" : "Failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}${digest ? ` - ${digest}` : ""}`;
          onLog?.(run.ok ? "stdout" : "stderr", runSummary);
        }
      }
      // exit 127 = command not found: separate tool-availability issues from real test failures.
      const notFoundRuns = validationRuns.filter((run) => run.exitCode === 127);
      const executedRuns = validationRuns.filter((run) => run.exitCode !== 127);
      if (notFoundRuns.length > 0) {
        const cmds = notFoundRuns.map((run) => run.command).join(", ");
        onLog?.(
          "stderr",
          `[ValidationGate] Some validation commands not found (exit 127 - wrong tool?): ${cmds}. This project uses Bun: prefer "bun test".`,
        );
      }
      if (executedRuns.length > 0 && executedRuns.every((run) => !run.ok)) {
        addValidationIssue("executed validation commands, but none passed.");
      } else if (executedRuns.length === 0 && notFoundRuns.length > 0) {
        addValidationIssue(
          'could not run any validation command (command not found). Use "bun test" or another available test runner.',
        );
      }
      if (
        isTestTask &&
        !validationRuns.some((run) => validationCommandIncludesTestWork(repo, run.command))
      ) {
        addValidationIssue("did not execute a recognizable test command.");
      }
    }
    requiredValidationFailures = collectRequiredValidationFailures(
      requiredRunnableSteps,
      validationRuns,
    );
    if (requiredValidationFailures.length > 0) {
      addValidationIssue(
        `Required vision.md validation failed: ${requiredValidationFailures.join("; ")}`,
      );
    }
  }
  const blocker = qualityGatePolicy.validationGateEnabled
    ? detectValidationBlocker(validationRuns)
    : null;
  const scopedValidationFailure = qualityGatePolicy.validationGateEnabled
    ? classifyValidationFailureScope(validationRuns, planning, changedPaths, targetPath)
    : "none";
  if (scopedValidationFailure === "outside_task_scope") {
    onLog?.(
      "stderr",
      "[ValidationGate] Required validation failures appear outside the task target/relevance hints; blocking publish and allowing guarded repo validation repair when auto-revision budget remains.",
    );
  }

  return {
    ok: issues.length === 0 && blocker === null,
    skipped: false,
    issues,
    scopeIssues,
    validationIssues,
    changedPaths,
    changedTestPaths,
    validationRuns,
    requiredValidationFailures,
    blocker,
    validationFailureScope: scopedValidationFailure,
  };
}

type QualityCriticTimeoutBehavior = "skip" | "retry_once" | "block";

function resolveQualityCriticTimeoutMs(runtimeConfig: WorkerpalsRuntimeConfig): number {
  const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
  if (!Number.isFinite(value)) return 90_000;
  return Math.max(1_000, Math.min(7_200_000, Math.floor(value)));
}

function resolveQualityCriticTimeoutBehavior(
  runtimeConfig: WorkerpalsRuntimeConfig,
): QualityCriticTimeoutBehavior {
  const value = String(runtimeConfig.workerpals.qualityCriticTimeoutBehavior ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (value === "skip" || value === "retry_once" || value === "block") return value;
  return "retry_once";
}

function resolveQualityCriticModel(runtimeConfig: WorkerpalsRuntimeConfig, fallback = ""): string {
  return String(runtimeConfig.workerpals.qualityCriticModel ?? "").trim() || fallback.trim();
}

function resolveQualityCriticMaxDiffChars(
  runtimeConfig: WorkerpalsRuntimeConfig,
  compact = false,
): number {
  const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
  const max = Number.isFinite(value) ? value : 16_000;
  const bounded = Math.max(256, Math.min(524_288, Math.floor(max)));
  return compact ? Math.min(bounded, 6_000) : bounded;
}

function resolveQualityCriticMaxValidationOutputChars(
  runtimeConfig: WorkerpalsRuntimeConfig,
  compact = false,
): number {
  const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
  const max = Number.isFinite(value) ? value : 8_000;
  const bounded = Math.max(256, Math.min(524_288, Math.floor(max)));
  return compact ? Math.min(bounded, 2_000) : bounded;
}

function buildCriticValidationSummary(
  quality: DeterministicQualityResult,
  maxValidationOutputChars: number,
): string {
  const allPassed =
    quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
  return quality.validationRuns
    .map((run) => {
      const output = allPassed
        ? ""
        : [run.stdout, run.stderr].filter(Boolean).join("\n").slice(0, maxValidationOutputChars);
      return [
        `Command: ${run.command}`,
        `Result: ${run.ok ? "pass" : "fail"} (exit ${run.exitCode}, ${run.elapsedMs}ms)`,
        output ? `Output:\n${output}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

function criticTimeoutReview(
  source: "Codex" | "LLM",
  timeoutMs: number,
  elapsedMs: number,
): CriticReview {
  const summary = `${source} critic timed out after ${elapsedMs}ms (timeout=${timeoutMs}ms).`;
  return {
    score: 0,
    findings: [summary],
    mustFix: [
      "CriticGate timeout behavior is set to block; complete the critic review by reducing critic input, choosing a faster critic model, or increasing workerpals.quality_critic_timeout_ms.",
    ],
    revisionGuidance:
      "Do not change product code for this finding unless product code caused the critic prompt explosion. Adjust CriticGate configuration or reduce validation/diff evidence volume.",
    raw: JSON.stringify({ score: 0, findings: [summary], must_fix: ["CriticGate timed out"] }),
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
  const model = resolveQualityCriticModel(runtimeConfig, runtimeConfig.workerpals.llm.model.trim());
  if (!endpoint || !model) return null;
  const qualityCriticTimeoutMs = resolveQualityCriticTimeoutMs(runtimeConfig);
  const timeoutBehavior = resolveQualityCriticTimeoutBehavior(runtimeConfig);

  const planning = params.planning as TaskExecutePlanning;
  const instruction = String(params.instruction ?? "").trim();
  const acceptanceCriteriaText =
    planning.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const validationStepsText =
    [
      ...planning.validationSteps,
      ...(planning.requiredValidationSteps ?? []).map(
        (entry) => `${entry} (required by vision.md testing criteria)`,
      ),
    ]
      .map((entry) => `- ${entry}`)
      .join("\n") || "- (none)";
  const changedPathsText =
    quality.changedPaths.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const criticSystem = loadPromptTemplate("workerpals/task_quality_critic_system_prompt.md").trim();

  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const buildAttemptPayload = async (compact: boolean) => {
    const changedForDiff = quality.changedPaths.slice(0, compact ? 4 : 8);
    let diffText = "";
    if (changedForDiff.length > 0) {
      const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
      diffText = diffResult.ok ? diffResult.stdout : diffResult.stderr;
    }
    diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(
      0,
      resolveQualityCriticMaxDiffChars(runtimeConfig, compact),
    );
    const validationSummary = buildCriticValidationSummary(
      quality,
      resolveQualityCriticMaxValidationOutputChars(runtimeConfig, compact),
    );
    const criticUser = loadPromptTemplate("workerpals/task_quality_critic_user_prompt.md", {
      instruction,
      acceptance_criteria: acceptanceCriteriaText,
      validation_steps: validationStepsText,
      changed_paths: changedPathsText,
      diff_excerpt: diffText || "(empty diff excerpt)",
      validation_evidence: validationSummary || "(no validation output)",
    });
    const promptChars = criticSystem.length + criticUser.length;
    const promptBytes = new TextEncoder().encode(`${criticSystem}\n${criticUser}`).length;
    return {
      bodyBase: {
        model,
        messages: [
          { role: "system", content: criticSystem },
          { role: "user", content: criticUser },
        ],
        temperature: 0,
        max_tokens: compact ? 500 : 700,
      },
      promptChars,
      promptBytes,
      diffChars: diffText.length,
      validationChars: validationSummary.length,
    };
  };

  const runCriticRequest = async (
    bodyBase: Record<string, unknown>,
    responseFormat: Record<string, unknown> | null,
  ) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, qualityCriticTimeoutMs);
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
      return { timedOut: false as const, response, text };
    } catch (err) {
      if (!timedOut && String((err as { name?: unknown })?.name ?? "") !== "AbortError") {
        throw err;
      }
      return { timedOut: true as const, err };
    } finally {
      clearTimeout(timer);
    }
  };

  const runAttempt = async (
    attempt: number,
    compact: boolean,
  ): Promise<{ status: "timeout" } | { status: "done"; review: CriticReview | null }> => {
    const payload = await buildAttemptPayload(compact);
    const startedAt = Date.now();
    onLog?.(
      "stdout",
      `[CriticGate] LLM review attempt ${attempt}${compact ? " (compact)" : ""}: model=${model} timeout_ms=${qualityCriticTimeoutMs} behavior=${timeoutBehavior} prompt_chars=${payload.promptChars} prompt_bytes=${payload.promptBytes} diff_chars=${payload.diffChars} validation_chars=${payload.validationChars}`,
    );
    let request = await runCriticRequest(payload.bodyBase, { type: "json_object" });
    if (request.timedOut) return { status: "timeout" };
    if (!request.response.ok && request.response.status === 400) {
      const lowered = request.text.toLowerCase();
      if (lowered.includes("response_format")) {
        onLog?.(
          "stdout",
          "[CriticGate] fallback: response_format json_object unsupported; retrying without strict response_format.",
        );
        request = await runCriticRequest(payload.bodyBase, null);
        if (request.timedOut) return { status: "timeout" };
      }
    }
    if (!request.response.ok) {
      onLog?.(
        "stderr",
        `[CriticGate] review request failed (${request.response.status}): ${toSingleLine(request.text, 240)}`,
      );
      return { status: "done", review: null };
    }

    const responsePayload = parseJsonObjectLoose(request.text) ?? JSON.parse(request.text);
    const choices = Array.isArray((responsePayload as Record<string, unknown>).choices)
      ? ((responsePayload as Record<string, unknown>).choices as Array<Record<string, unknown>>)
      : [];
    const content = String(
      (choices[0]?.message as Record<string, unknown> | undefined)?.content ?? "",
    ).trim();
    const reviewObj = parseJsonObjectLoose(content);
    if (!reviewObj) {
      onLog?.(
        "stderr",
        `[CriticGate] produced non-JSON content; skipping critic gate. Raw: ${toSingleLine(
          content,
          220,
        )}`,
      );
      return { status: "done", review: null };
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
    onLog?.(
      "stdout",
      `[CriticGate] LLM review completed in ${Date.now() - startedAt}ms (attempt ${attempt}).`,
    );
    return {
      status: "done",
      review: {
        score,
        findings,
        mustFix,
        revisionGuidance,
        raw: compactJobOutput(content, outputPolicyForRuntime(runtimeConfig)),
      },
    };
  };

  try {
    let attempt = await runAttempt(1, false);
    if (attempt.status === "timeout" && timeoutBehavior === "retry_once") {
      onLog?.(
        "stderr",
        `[CriticGate] LLM review timed out after ${qualityCriticTimeoutMs}ms; retrying once with compact critic input.`,
      );
      attempt = await runAttempt(2, true);
    }
    if (attempt.status === "timeout") {
      if (timeoutBehavior === "block") {
        onLog?.(
          "stderr",
          `[CriticGate] LLM review timed out after ${qualityCriticTimeoutMs}ms; blocking because quality_critic_timeout_behavior=block.`,
        );
        return criticTimeoutReview("LLM", qualityCriticTimeoutMs, qualityCriticTimeoutMs);
      }
      onLog?.("stderr", `[CriticGate] LLM timed out after ${qualityCriticTimeoutMs}ms; skipping.`);
      return null;
    }
    return attempt.review;
  } catch (err) {
    onLog?.(
      "stderr",
      `[CriticGate] review unavailable: ${toSingleLine(err, 220)} (continuing without critic gate).`,
    );
    return null;
  }
}

export function buildQualityRevisionHint(
  issues: string[],
  critic: CriticReview | null,
  planning: TaskExecutePlanning,
  reviewFixContext?: ReviewFixContext | null,
  validationRuns: ValidationExecutionResult[] = [],
  validationBlocker: ValidationBlocker | null = null,
  browserRepairPacket: BrowserValidationRepairPacket | null = null,
  changedPaths: string[] = [],
  validationRemedyHints: string[] = [],
  repoValidationRepairMode = false,
): string {
  const lines: string[] = [];
  lines.push("Quality revision required before completion.");
  const focusedBrowserRepair = Boolean(browserRepairPacket) && !repoValidationRepairMode;
  if (repoValidationRepairMode) {
    lines.push(
      "Repo validation repair mode: required project validation failed outside the original target/relevance hints. Keep the original patch only if it remains useful, but temporarily broaden discovery and edits to the smallest behavior-owning source, test, mock, package, or config files needed to make the failed validation commands pass.",
    );
    lines.push(
      "Scope rule for this repair: original target paths and write globs are stale/advisory for the validation blocker; forbidden paths and generated/runtime artifacts are still off limits.",
    );
  }
  lines.push(
    "Worker phase contract: (1) discovering - inspect only the relevant files/artifacts and name the current hypothesis; (2) editing - make the smallest behavior-owning patch; (3) focused validation - run targeted fast checks; (4) full validation - let PushPals ValidationGate own long required checks unless a single local confirmation is explicitly useful; (5) final diff review - verify changed files are necessary and no unrelated churn remains.",
  );
  const diffBudgetWarning = buildDiffBudgetWarning(planning, changedPaths, focusedBrowserRepair);
  if (diffBudgetWarning) lines.push(diffBudgetWarning);
  const broadSharedMockWarning = buildBroadSharedMockWarning(planning, changedPaths);
  if (broadSharedMockWarning) lines.push(broadSharedMockWarning);
  const testHarnessConvergenceWarning = buildTestHarnessConvergenceWarning(
    planning,
    issues,
    validationRuns,
  );
  if (testHarnessConvergenceWarning) lines.push(testHarnessConvergenceWarning);
  if ((planning.repoHintDiagnostics ?? []).length > 0) {
    lines.push("Repo hint diagnostics:");
    for (const hint of planning.repoHintDiagnostics ?? []) {
      lines.push(`- ${hint}`);
    }
    lines.push(
      "Hint handling rule: stale or absent path hints are advisory context, not permission to invent repo-specific scaffolding. Prefer an existing behavior owner or existing nearby test.",
    );
  }
  if (validationRemedyHints.length > 0) {
    lines.push("Known issue/remedy memory for this repo/job family:");
    for (const hint of validationRemedyHints.slice(0, 5)) {
      lines.push(`- ${hint}`);
    }
  }
  if (planningLooksLikeVisualDerivationTask(planning)) {
    lines.push(
      "Visual derivation testing rule: prefer pure helper/state/style-prop tests for planet/projectile/ownership/readability cues. Only add a full React Native render regression when this repo already has a stable harness for that exact surface; otherwise keep render-visible behavior covered through the derived inputs that drive it.",
    );
  }
  lines.push(
    "Phase soft-budget reminder: if discovery, test-harness setup, or validation repair is running long, reduce the approach before spending more time. Small/medium tasks should converge toward a useful patch within roughly 20 minutes.",
  );
  const validationAlreadyPassed =
    validationRuns.length > 0 && validationRuns.every((run) => run.ok);
  if (validationAlreadyPassed && !focusedBrowserRepair) {
    lines.push(
      "Validation-preserving cleanup mode: the previous ValidationGate pass succeeded. Treat the validated patch and browser path as frozen; address only the listed ScopeGate/CriticGate cleanup with the smallest possible diff.",
    );
    lines.push(
      "Do not rewrite app behavior, route flow, browser smoke selectors, validation scripts, or unrelated tests unless the listed cleanup explicitly requires that exact change.",
    );
    lines.push(
      "After the cleanup, run fast focused checks if useful and let PushPals ValidationGate rerun the full required validation set.",
    );
  }
  if (browserRepairPacket && !repoValidationRepairMode) {
    lines.push("Primary ValidationGate repair objective:");
    lines.push(`- Command: ${browserRepairPacket.command}`);
    lines.push(`- Failure type: browser ${browserRepairPacket.failureKind}`);
    lines.push(
      "- First action: inspect the captured browser output/artifacts and actual rendered UI before editing; do not guess from component names or intended copy.",
    );
    if (browserRepairPacket.stage) lines.push(`- Stage: ${browserRepairPacket.stage}`);
    if (browserRepairPacket.failureFocus) {
      lines.push(`- Failure focus: ${browserRepairPacket.failureFocus}`);
    }
    if (browserRepairPacket.lastVerifiedStage) {
      lines.push(`- Last verified browser checkpoint: ${browserRepairPacket.lastVerifiedStage}`);
    }
    if (browserRepairPacket.pageUrl) {
      lines.push(`- Browser URL at failure: ${browserRepairPacket.pageUrl}`);
    }
    if (browserRepairPacket.expected) {
      lines.push(`- Expected UI: ${browserRepairPacket.expected}`);
    }
    if (browserRepairPacket.selector) {
      lines.push(`- Selector/wait: ${browserRepairPacket.selector}`);
    }
    if (browserRepairPacket.artifacts.length > 0) {
      lines.push("Failure artifacts to inspect:");
      for (const artifact of browserRepairPacket.artifacts) {
        lines.push(`- ${artifact}`);
      }
    } else {
      lines.push(
        "- Failure artifacts: none were captured in command output; if this repo writes screenshots/traces, inspect the latest browser failure artifact before changing selectors.",
      );
    }
    if ((browserRepairPacket.artifactSummaries ?? []).length > 0) {
      lines.push("Latest browser artifact summaries:");
      for (const artifactSummary of browserRepairPacket.artifactSummaries ?? []) {
        lines.push(`- ${artifactSummary}`);
      }
    }
    if ((browserRepairPacket.knownFailureHints ?? []).length > 0) {
      lines.push("Known issue/remedy memory for this repo/job family:");
      for (const hint of browserRepairPacket.knownFailureHints ?? []) {
        lines.push(`- ${hint}`);
      }
    }
    if (browserRepairPacket.digest) {
      lines.push(`- Current failure: ${browserRepairPacket.digest}`);
    }
    if (browserRepairPacket.previousDigest) {
      const breadcrumb =
        browserRepairPacket.progress === "same_failure"
          ? "same failure repeated for this command"
          : "new failure for this command after the previous revision";
      lines.push(
        `- Breadcrumb: ${breadcrumb}; previous failure was ${browserRepairPacket.previousDigest}`,
      );
      if (
        browserRepairPacket.previousStage ||
        browserRepairPacket.previousExpected ||
        browserRepairPacket.previousSelector
      ) {
        lines.push("Previous browser failure detail:");
        if (browserRepairPacket.previousStage) {
          lines.push(`- Previous stage: ${browserRepairPacket.previousStage}`);
        }
        if (browserRepairPacket.previousExpected) {
          lines.push(`- Previous expected UI: ${browserRepairPacket.previousExpected}`);
        }
        if (browserRepairPacket.previousSelector) {
          lines.push(`- Previous selector/wait: ${browserRepairPacket.previousSelector}`);
        }
      }
    } else {
      lines.push("- Breadcrumb: first captured failure for this command in this revision loop");
    }
    if (browserRepairPacket.mustReadArtifactsBeforeEdit) {
      lines.push(
        "- Diagnostic artifact read requirement: before editing, explicitly inspect the listed latest artifact/log/DOM summary for the failing stage. If the artifacts are missing, stale, or stop before the failing locator, add a tiny temporary diagnostic/log for locator counts, visible text, URL, and nearby DOM/test-id state before changing product code or selectors.",
      );
    }
    if (browserRepairPacket.needsDiagnosticProbe) {
      lines.push(
        "- Convergence mode: diagnostic-first repair. This same browser focus failed in the previous revision, so do not guess another selector or rewrite a different stage.",
      );
      lines.push(
        "- Diagnostic requirement: before editing again, inspect or add a tiny temporary diagnostic around the failing stage that records locator counts, visible textContent, role/ARIA attributes, data-testid values, bounding boxes, and a nearby DOM snippet for the candidate nodes.",
      );
      lines.push(
        "- Artifact freshness rule: only trust screenshots/logs captured after the failing action in the current revision. If the screenshot is stale or stops before the failing locator, capture or print the DOM state instead of reasoning from that image.",
      );
      lines.push(
        "- React Native Web note: screenshots can show the intended state while Playwright reads a duplicate or stale rendered node. Prefer one unique selected-state test id or a semantic checked attribute on the stable pressable, then assert locator count and visibility.",
      );
    }
    if (browserRepairPacket.output) {
      lines.push(`- Relevant output: ${browserRepairPacket.output}`);
    }
    if (browserRepairPacket.failureKind === "assertion") {
      lines.push(
        "Repair direction: fix this exact visible UI assertion or the app state that should make it true. If the expected text/role/test id is not present in the screenshot, update the smoke assertion to the visible product UI that proves the same stage, or add accessibility metadata to an existing control. Do not add optional navigation or broaden the smoke path. Do not change browser startup, port selection, Playwright installation, or unrelated e2e harness behavior unless the captured failure is reclassified as startup/setup.",
      );
      lines.push(
        "Selector stability rule: prefer existing data-testid/accessibility labels/roles and stage containers over guessed title/body text. If a stage already passed with a stable container such as a home/shell/test-id locator, reuse that signal instead of replacing it with copy checks.",
      );
      lines.push(
        "Text assertion rule: rendered titles may be split across sibling nodes. Do not invent a combined phrase for split text; either assert the individual visible fragments within the stage container or add/reuse a stable test id/accessibility label.",
      );
      if (
        browserRepairPacket.progress === "same_failure" ||
        (browserRepairPacket.stage &&
          browserRepairPacket.previousStage &&
          browserRepairPacket.stage === browserRepairPacket.previousStage)
      ) {
        lines.push(
          "Repeated-stage rule: this browser stage has failed before in the current revision loop, so treat the previous selector/copy assumption as suspect and switch to the most stable rendered locator for that same stage.",
        );
      }
    } else {
      lines.push(
        "Repair direction: this is a browser startup/runtime/network failure. Fix only startup/runtime provisioning for this command and do not rewrite app UI assertions unless a later ValidationGate run reaches an assertion stage.",
      );
    }
    lines.push(
      "Convergence rule: preserve stages that already passed, repair only the current failing browser stage, and stop after one targeted browser confirmation so the next ValidationGate run gets a clean signal.",
    );
    lines.push(
      "Executor sandbox rule: if the full browser command cannot run inside this edit turn because local server binding is denied or Expo/Playwright reports ERR_SOCKET_BAD_PORT, listen EPERM, EACCES, or a local port bind/freeport failure before reaching the app, treat that as a Codex executor verification limitation. Do not change app startup, ports, or browser provisioning for that local-only signal unless the ValidationGate failure above is also a startup/setup failure. Use the captured artifacts plus fast checks, then let ValidationGate perform the authoritative browser run.",
    );
    if (browserRepairPacket.needsDiagnosticProbe) {
      lines.push(
        `Validation rerun rule: PushPals ValidationGate will rerun "${browserRepairPacket.command}" after the patch, but this is now a repeated browser assertion. If a quick local startup probe shows the browser server can run in this executor, run exactly one targeted "${browserRepairPacket.command}" confirmation after the DOM-backed fix. Do not stop after fast checks only. Do not hand off another unverified selector guess.`,
      );
    } else {
      lines.push(
        `Validation rerun rule: PushPals ValidationGate will rerun "${browserRepairPacket.command}" after the patch. During a focused browser repair turn, run fast non-browser checks and inspect captured artifacts first; do not run the full browser command from the Codex executor by default. Only run the full browser command for one targeted confirmation if artifacts are missing and a quick local bind/startup probe shows the browser server can actually run in this executor. Otherwise stop after fast checks so ValidationGate gets the clean authoritative signal.`,
      );
    }
  }
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
    lines.push(
      "Raise the score above the approval threshold without reopening already accepted behavior.",
    );
  }
  if (issues.length > 0) {
    const displayedIssues = focusedBrowserRepair
      ? issues.filter(
          (issue) =>
            issue.startsWith("ValidationGate:") ||
            issue.includes("Required vision.md validation") ||
            issue.includes("Validation blocker"),
        )
      : issues;
    if (displayedIssues.length > 0) {
      lines.push(
        focusedBrowserRepair
          ? "Deterministic quality issues relevant to this validation repair:"
          : "Deterministic quality issues:",
      );
      for (const issue of displayedIssues) lines.push(`- ${issue}`);
    }
    const suppressedCount = issues.length - displayedIssues.length;
    if (focusedBrowserRepair && suppressedCount > 0) {
      lines.push(
        `Suppressed ${suppressedCount} lower-priority ScopeGate/CriticGate note(s) until the browser validation repair passes.`,
      );
    }
  }
  if (validationBlocker) {
    lines.push(
      `Validation blocker: ${validationBlocker.category} - ${toSingleLine(
        validationBlocker.detail,
        300,
      )}`,
    );
  }
  const failedValidationRuns = validationRuns.filter((run) => !run.ok);
  if (failedValidationRuns.length > 0) {
    lines.push(
      "Validation repair continuity rule: existing content changes from earlier repair attempts are prepared candidate fixes. Preserve them unless the latest failing command proves a specific change is wrong; do not revert them merely to restore the original narrow file count, target paths, or write globs.",
    );
    if (changedPaths.length > 0) {
      lines.push("Prepared candidate paths to preserve during this repair:");
      for (const path of changedPaths.slice(0, 12)) lines.push(`- ${path}`);
    }
    lines.push(
      "Validation ownership rule: diagnose and run the smallest focused command or failing subcommand needed for this repair. Do not rerun a long aggregate required-validation command inside the executor; PushPals ValidationGate will rerun the authoritative aggregate after the repair turn.",
    );
    lines.push("Validation failure diagnostics:");
    const runsToShow = browserRepairPacket
      ? failedValidationRuns
          .filter((run) => run.command === browserRepairPacket.command)
          .slice(0, 1)
      : failedValidationRuns.slice(0, 5);
    for (const run of runsToShow) {
      lines.push(`- ${run.command} failed with exit ${run.exitCode} after ${run.elapsedMs}ms.`);
      const output = toSingleLine(
        stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join("\n")),
        700,
      );
      if (output) lines.push(`  Output: ${output}`);
    }
  }
  if (critic) {
    const deferCriticForBrowserAssertion =
      focusedBrowserRepair && browserRepairPacket?.failureKind === "assertion";
    const criticIsSevere =
      critic.score <= 4 ||
      [...critic.mustFix, ...critic.findings, critic.revisionGuidance].some((entry) =>
        /\b(browser|e2e|validation|web smoke|playwright)\b/i.test(entry),
      );
    if (deferCriticForBrowserAssertion) {
      lines.push(
        `CriticGate notes deferred while repairing the primary browser assertion failure (score ${critic.score.toFixed(1)} / 10).`,
      );
    } else if (!focusedBrowserRepair || criticIsSevere) {
      lines.push(`Critic score: ${critic.score.toFixed(1)} / 10`);
    }
    if (
      !deferCriticForBrowserAssertion &&
      (!focusedBrowserRepair || criticIsSevere) &&
      critic.mustFix.length > 0
    ) {
      lines.push("Critic must-fix findings:");
      for (const issue of critic.mustFix) lines.push(`- ${issue}`);
    }
    if (
      !deferCriticForBrowserAssertion &&
      (!focusedBrowserRepair || criticIsSevere) &&
      critic.revisionGuidance
    ) {
      lines.push(`Critic revision guidance: ${critic.revisionGuidance}`);
    }
    if (focusedBrowserRepair && !criticIsSevere && !deferCriticForBrowserAssertion) {
      lines.push(
        `CriticGate notes deferred while repairing the primary browser validation failure (score ${critic.score.toFixed(1)} / 10).`,
      );
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
  if ((planning.requiredValidationSteps ?? []).length > 0) {
    lines.push("Required vision.md testing criteria:");
    for (const step of planning.requiredValidationSteps ?? []) lines.push(`- ${step}`);
  }
  lines.push("Apply a minimal corrective patch, run focused validation, then finish.");
  return lines.join("\n").slice(0, 8000);
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
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
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
    return { ok: exitCode === 0, stdout: stdout.trimEnd(), stderr: stderr.trim(), exitCode };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), exitCode: null };
  }
}

// ─── Git commit creation ─────────────────────────────────────────────────────

async function trackedPathHasGitContentDelta(repo: string, path: string): Promise<boolean | null> {
  const tracked = await git(repo, ["ls-files", "--error-unmatch", "--", path]);
  if (!tracked.ok) return null;

  const unstaged = await git(repo, ["diff", "--quiet", "--", path]);
  if (unstaged.exitCode === 1) return true;
  if (unstaged.exitCode !== 0) return null;

  const staged = await git(repo, ["diff", "--cached", "--quiet", "--", path]);
  if (staged.exitCode === 1) return true;
  if (staged.exitCode !== 0) return null;

  return false;
}

export async function filterChangedPathsByGitContentDelta(
  repo: string,
  changedPaths: string[],
): Promise<string[]> {
  const [trackedResult, unstagedResult, stagedResult] = await Promise.all([
    git(repo, ["ls-files"]),
    git(repo, ["diff", "--name-only", "--no-renames"]),
    git(repo, ["diff", "--cached", "--name-only", "--no-renames"]),
  ]);
  const canFilterInBatch = trackedResult.ok && unstagedResult.ok && stagedResult.ok;
  const trackedPaths = new Set(
    canFilterInBatch ? parseChangedPathsFromNameOnlyOutput(trackedResult.stdout) : [],
  );
  const trackedContentDeltas = new Set(
    canFilterInBatch
      ? [
          ...parseChangedPathsFromNameOnlyOutput(unstagedResult.stdout),
          ...parseChangedPathsFromNameOnlyOutput(stagedResult.stdout),
        ]
      : [],
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of changedPaths) {
    const path = String(rawPath ?? "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const trackedDelta = canFilterInBatch
      ? trackedPaths.has(path)
        ? trackedContentDeltas.has(path)
        : null
      : await trackedPathHasGitContentDelta(repo, path);
    if (trackedDelta === false) continue;
    out.push(path);
  }
  return out;
}

/** Create commit for job result and return commit info */
export type WorkerGitCommitIdentity = SourceControlCommitIdentity;

export const explicitWorkerCommitIdentityFromEnv = explicitSourceControlCommitIdentityFromEnv;

export function buildSandboxArtifactUnstageCommand(): string[] {
  return ["reset", "-q", "--", ...SANDBOX_STAGE_ARTIFACT_PATHS];
}

async function unstageSandboxArtifactPaths(
  repo: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return git(repo, buildSandboxArtifactUnstageCommand());
}

async function resolveGitConfigValue(repo: string, key: string): Promise<string> {
  const value = await git(repo, ["config", "--get", key]);
  return value.ok ? sanitizeSourceControlIdentityField(value.stdout) : "";
}

export async function resolveWorkerCommitIdentity(
  repo: string,
  _runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): Promise<WorkerGitCommitIdentity | null> {
  const fallbackEmail = await resolveGitConfigValue(repo, "user.email");
  const explicit = explicitWorkerCommitIdentityFromEnv(process.env, fallbackEmail);
  if (explicit) return explicit;

  const name = await resolveGitConfigValue(repo, "user.name");
  if (name && fallbackEmail) return { name, email: fallbackEmail, source: "source-control-config" };
  return null;
}

export function buildGitCommitArgs(
  commitMsg: string,
  identity: WorkerGitCommitIdentity | null,
): string[] {
  return buildSourceControlGitCommitArgs(commitMsg, identity);
}

export interface CreateJobCommitResult {
  ok: boolean;
  branch?: string;
  sha?: string;
  error?: string;
  publishBlocked?: JobPublishBlockedInfo;
}

function buildPublishBlockedCommitResult(options: {
  summary: string;
  detail: string;
  publicBranch: string;
  localRef: string;
  sha: string;
  stage: "sync" | "push";
}): CreateJobCommitResult {
  return {
    ok: false,
    branch: options.localRef,
    sha: options.sha,
    error: options.detail,
    publishBlocked: {
      summary: options.summary,
      detail: options.detail,
      publicBranch: options.publicBranch,
      localRef: options.localRef,
      sha: options.sha,
      stage: options.stage,
    },
  };
}

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
): Promise<CreateJobCommitResult> {
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
        result = await git(repo, ["add", "-A"]);
      }
      if (!result.ok) {
        return { ok: false, error: `Failed to stage changes: ${result.stderr || result.stdout}` };
      }
    }
    if (job.kind === "task.execute") {
      const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
      if (!unstageArtifacts.ok) {
        return {
          ok: false,
          error: `Failed to unstage sandbox artifact paths: ${unstageArtifacts.stderr || unstageArtifacts.stdout}`,
        };
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
    const jobValidationSteps = [
      ...toNonEmptyStringArray(job.params?.validationSteps),
      ...toNonEmptyStringArray(job.params?.requiredValidationSteps),
      ...toNonEmptyStringArray(jobPlanning?.validationSteps),
      ...toNonEmptyStringArray(jobPlanning?.requiredValidationSteps),
      ...loadRequiredValidationStepsFromVision(repo),
    ];
    const llmCommitMsg = shouldUseLlmCommitMessageForStagedDiff({ changedPaths, diff })
      ? await generateCommitMessageFromDiff(
          diff,
          {
            instruction: String(job.params?.instruction ?? ""),
            type: normalizeCommitType(job.kind, job.params),
            area: inferCommitArea(job.kind, job.params, changedPaths),
            validationSteps: jobValidationSteps,
          },
          repo,
          runtimeConfig,
        ).catch(() => null)
      : null;
    if (!llmCommitMsg) {
      console.warn(
        `[WorkerPals] Commit message generator unavailable for job ${job.id}; using deterministic fallback.`,
      );
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);

    // Commit changes with a PushPals-resolved author so generated commits use
    // source-control identity instead of falling through to the host account.
    const commitIdentity = await resolveWorkerCommitIdentity(repo, runtimeConfig);
    result = await git(repo, buildGitCommitArgs(commitMsg, commitIdentity));
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
          return buildPublishBlockedCommitResult({
            summary: `Failed to sync and push ${job.kind} commit`,
            detail: pushError,
            publicBranch: publicBranchName,
            localRef: hiddenCommitRef,
            sha,
            stage: "sync",
          });
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
          return buildPublishBlockedCommitResult({
            summary: `Failed to sync and push ${job.kind} commit`,
            detail: pushError || `Failed to push ${publicBranchName}`,
            publicBranch: publicBranchName,
            localRef: hiddenCommitRef,
            sha,
            stage: "push",
          });
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

export function buildStageCommand(kind: string, params?: Record<string, unknown>): string[] | null {
  if (kind === "task.execute") {
    return ["add", "-A"];
  }
  const targets = buildStageTargets(kind, params);
  if (targets.length === 0) {
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

function normalizeCommitPath(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function inferRepoNativeCommitArea(targets: string[]): string | null {
  const normalized = targets.map(normalizeCommitPath).filter((path) => path && path !== ".");
  if (normalized.length === 0) return null;
  if (normalized.every(isDocPath)) return "docs";
  if (
    normalized.some(isTestPath) &&
    normalized.every((path) => isTestPath(path) || isDocPath(path))
  ) {
    return "tests";
  }

  const basis =
    normalized.find((path) => !isTestPath(path) && !isDocPath(path)) ??
    normalized.find((path) => !isDocPath(path)) ??
    normalized[0];
  if (!basis) return null;
  if (/^(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(basis)) {
    return "package";
  }
  if (
    /^(tsconfig|vite\.config|metro\.config|babel\.config|jest\.config|vitest\.config|playwright\.config|eslint\.config|prettier\.config)/i.test(
      basis,
    )
  ) {
    return "tooling";
  }
  const segments = basis.split("/").filter(Boolean);
  if ((segments[0] === "apps" || segments[0] === "packages") && segments[1]) {
    return normalizeCommitArea(segments[1]);
  }
  const first = segments[0] ?? "";
  if (
    [
      "app",
      "components",
      "screens",
      "features",
      "src",
      "scripts",
      "utils",
      "hooks",
      "styles",
      "tests",
    ].includes(first)
  ) {
    return normalizeCommitArea(first);
  }
  return first ? normalizeCommitArea(first) : null;
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
  return inferRepoNativeCommitArea(targets) ?? "repo";
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
  const lower = normalizeCommitPath(path);
  return (
    lower.startsWith("docs/") ||
    lower.startsWith("wiki/") ||
    lower === "readme.md" ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx")
  );
}

function isTestPath(path: string): boolean {
  const normalized = normalizeCommitPath(path);
  if (/(^|\/)(?:__tests__|tests?|e2e|smoke|specs?)(?:\/|$)/i.test(normalized)) {
    return true;
  }
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)) return true;
  const base = normalized.split("/").pop() ?? normalized;
  return /(?:^|[-_.])(?:test|spec|e2e|smoke|coverage)(?:[-_.]|$)/i.test(base);
}

function humanizeCommitArea(area: string): string {
  switch (area) {
    case "local_agent":
      return "localbuddy";
    case "remote_agent":
      return "remotebuddy";
    case "source_control_manager":
      return "source control manager";
    case "tests":
      return "test";
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
      const coverageLabel = label === "test" ? "test" : `${label} test`;
      return sanitizeCommitValue(`expand ${coverageLabel} coverage`, 72);
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
      case "bunx":
      case "npm":
      case "npx":
      case "pnpm":
      case "yarn": {
        // "bun test", "npm test", "yarn test"
        if (hasToken("test")) return true;
        if (["bunx", "npx"].includes(tool)) {
          const runner = argv[1]?.toLowerCase() ?? "";
          if (runner === "vitest" || runner === "jest" || runner === "playwright") return true;
        }
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
      case "python3":
        return (
          argv.length >= 3 && argv[1].toLowerCase() === "-m" && argv[2].toLowerCase() === "pytest"
        );
      case "go":
      case "cargo":
      case "make":
        return hasToken("test");
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
    ...toNonEmptyStringArray(params?.requiredValidationSteps),
    ...toNonEmptyStringArray(params?.validation_steps),
    ...toNonEmptyStringArray(params?.required_validation_steps),
    ...toNonEmptyStringArray(planning?.validationSteps),
    ...toNonEmptyStringArray(planning?.requiredValidationSteps),
    ...toNonEmptyStringArray(planning?.validation_steps),
    ...toNonEmptyStringArray(planning?.required_validation_steps),
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

async function activeGitOperation(
  repo: string,
): Promise<"rebase" | "merge" | "cherry-pick" | null> {
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
  | {
      ok: true;
      resumed: boolean;
      sequencer: "rebase" | "merge" | "cherry-pick" | null;
      detail?: string;
      advancedToNextConflict?: boolean;
    }
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
        stageResult = await git(repo, ["add", "-A"]);
      }
    }
  } else {
    stageResult = await git(repo, ["add", "-A"]);
  }
  if (!stageResult.ok) {
    return {
      ok: false,
      error:
        "Failed to stage resolved merge-conflict changes before continuing rebase: " +
        combinedGitOutput(stageResult),
    };
  }
  const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
  if (!unstageArtifacts.ok) {
    return {
      ok: false,
      error:
        "Failed to unstage sandbox artifact paths before continuing rebase: " +
        combinedGitOutput(unstageArtifacts),
    };
  }

  const maxContinuationPasses = Math.max(1, MAX_MERGE_CONFLICT_RESOLUTION_PASSES);
  let lastContinueOutput = "";
  for (let pass = 1; pass <= maxContinuationPasses; pass += 1) {
    let rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    let continueOutput = combinedGitOutput(rebaseContinue);
    if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
      rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      continueOutput = combinedGitOutput(rebaseContinue);
    }
    lastContinueOutput = continueOutput;

    if (!rebaseContinue.ok) {
      if (/no rebase in progress/i.test(continueOutput)) {
        onLog?.(
          "stdout",
          "[MergeConflict] Prepared rebase was already complete after continuation.",
        );
        return { ok: true, resumed: true, sequencer: null };
      }
      if (/no changes - did you forget to use 'git add'|nothing to commit/i.test(continueOutput)) {
        const rebaseSkip = await git(repo, ["rebase", "--skip"]);
        const skipOutput = combinedGitOutput(rebaseSkip);
        lastContinueOutput = skipOutput || continueOutput;
        if (!rebaseSkip.ok && !isRebaseConflictOutput(skipOutput)) {
          return {
            ok: false,
            error: `Failed to skip empty prepared merge-conflict rebase commit: ${skipOutput}`,
          };
        }
      } else {
        const continuingSequencer = await activeGitOperation(repo);
        if (continuingSequencer === "rebase") {
          const nextUnresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
          if (nextUnresolved.ok) {
            const nextPaths = parseChangedPathsFromNameOnlyOutput(nextUnresolved.stdout);
            if (nextPaths.length > 0) {
              onLog?.(
                "stdout",
                `[MergeConflict] Rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s); rerunning the resolver on updated sandbox state.`,
              );
              return {
                ok: true,
                resumed: true,
                sequencer: "rebase",
                detail: `rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s)`,
                advancedToNextConflict: true,
              };
            }
          }
        }
        return {
          ok: false,
          error: `Failed to continue prepared merge-conflict rebase: ${continueOutput}`,
        };
      }
    }

    const remainingSequencer = await activeGitOperation(repo);
    if (!remainingSequencer) {
      onLog?.(
        "stdout",
        "[MergeConflict] Auto-continued the prepared rebase after the executor returned with no unresolved conflicts.",
      );
      return { ok: true, resumed: true, sequencer: null };
    }
    if (remainingSequencer !== "rebase") {
      return { ok: true, resumed: true, sequencer: remainingSequencer };
    }

    const nextUnresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
    if (nextUnresolved.ok) {
      const nextPaths = parseChangedPathsFromNameOnlyOutput(nextUnresolved.stdout);
      if (nextPaths.length > 0) {
        onLog?.(
          "stdout",
          `[MergeConflict] Rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s); rerunning the resolver on updated sandbox state.`,
        );
        return {
          ok: true,
          resumed: true,
          sequencer: "rebase",
          detail: `rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s)`,
          advancedToNextConflict: true,
        };
      }
    }

    onLog?.(
      "stdout",
      `[MergeConflict] Rebase still active after continuation pass ${pass}/${maxContinuationPasses}; trying another non-interactive continue.`,
    );
  }

  return {
    ok: false,
    error:
      `Prepared merge-conflict rebase remained active after ${maxContinuationPasses} continuation pass(es).` +
      (lastContinueOutput ? ` Last output: ${lastContinueOutput}` : ""),
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
      result = await git(repo, ["add", "-A"]);
    }
    if (!result.ok) {
      return {
        ok: false,
        error: `Failed to stage merge-conflict changes: ${result.stderr || result.stdout}`,
      };
    }
  }
  const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
  if (!unstageArtifacts.ok) {
    return {
      ok: false,
      error: `Failed to unstage sandbox artifact paths: ${unstageArtifacts.stderr || unstageArtifacts.stdout}`,
    };
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
    const jobValidationSteps = [
      ...toNonEmptyStringArray(job.params?.validationSteps),
      ...toNonEmptyStringArray(job.params?.requiredValidationSteps),
      ...toNonEmptyStringArray(jobPlanning?.validationSteps),
      ...toNonEmptyStringArray(jobPlanning?.requiredValidationSteps),
      ...loadRequiredValidationStepsFromVision(repo),
    ];
    const llmCommitMsg = shouldUseLlmCommitMessageForStagedDiff({ changedPaths, diff })
      ? await generateCommitMessageFromDiff(
          diff,
          {
            instruction: String(job.params?.instruction ?? ""),
            type: normalizeCommitType(job.kind, job.params),
            area: inferCommitArea(job.kind, job.params, changedPaths),
            validationSteps: jobValidationSteps,
          },
          repo,
          runtimeConfig,
        ).catch(() => null)
      : null;
    if (!llmCommitMsg) {
      console.warn(
        `[WorkerPals] Commit message generator unavailable for merge-conflict job ${job.id}; using deterministic fallback.`,
      );
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);
    const commitIdentity = await resolveWorkerCommitIdentity(repo, runtimeConfig);
    const commit = await git(repo, buildGitCommitArgs(commitMsg, commitIdentity));
    if (!commit.ok) {
      return { ok: false, error: `Failed to commit merge-conflict resolution: ${commit.stderr}` };
    }
    headSha = await currentRefSha(repo, "HEAD");
    if (!headSha) {
      return {
        ok: false,
        error: `Failed to resolve committed HEAD SHA for merge-conflict job ${job.id}.`,
      };
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
            const rm = await git(repo, ["rm", "--force", "--", path]);
            if (!rm.ok) {
              return {
                ok: false,
                error: `Failed to resolve rebase conflict for ${path}: ${combinedGitOutput(checkout)}`,
              };
            }
          }
        }
      }
      // Stage only the conflicted paths so worker-side resolution can include add/add files
      // without accidentally sweeping unrelated untracked artifacts into the replayed commit.
      const addAll = await git(repo, ["add", "-A", "--", ...unresolvedPaths]);
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
  const scrubKnownPreSyncArtifacts = async (): Promise<
    { ok: true } | { ok: false; error: string }
  > => {
    const codexPath = resolve(repo, ".codex");
    if (!existsSync(codexPath)) return { ok: true };

    const trackedCodex = await git(repo, ["ls-files", "--error-unmatch", "--", ".codex"]);
    if (trackedCodex.ok) {
      const restoreTrackedCodex = await git(repo, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        ".codex",
      ]);
      if (!restoreTrackedCodex.ok) {
        return {
          ok: false,
          error:
            `Tracked .codex path blocks branch sync and could not be restored to HEAD: ` +
            `${combinedGitOutput(restoreTrackedCodex)}`,
        };
      }

      const trackedCodexStatus = await git(repo, ["status", "--porcelain", "--", ".codex"]);
      if (!trackedCodexStatus.ok) {
        return {
          ok: false,
          error:
            `Tracked .codex path blocks branch sync and its status could not be verified: ` +
            `${combinedGitOutput(trackedCodexStatus)}`,
        };
      }
      if (trackedCodexStatus.stdout.trim().length > 0) {
        return {
          ok: false,
          error:
            "Tracked .codex path blocks branch sync because local changes remain after restore. " +
            "Move Codex state outside the repo worktree before retrying.",
        };
      }

      console.warn("[WorkerPals] Preserved tracked .codex sentinel before branch sync.");
      return { ok: true };
    }

    try {
      rmSync(codexPath, { recursive: true, force: true });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to scrub transient .codex artifact before branch sync: ${String(error)}`,
      };
    }

    if (existsSync(codexPath)) {
      return {
        ok: false,
        error: "Failed to scrub transient .codex artifact before branch sync: path still exists.",
      };
    }

    console.warn("[WorkerPals] Removed transient .codex artifact before branch sync.");
    return { ok: true };
  };

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
      const preSyncGuard = await scrubKnownPreSyncArtifacts();
      if (!preSyncGuard.ok) {
        return { ok: false, error: preSyncGuard.error };
      }
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
        const unresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
        const unresolvedPaths = unresolved.ok
          ? parseChangedPathsFromNameOnlyOutput(unresolved.stdout).join(", ")
          : "";
        await git(repo, ["rebase", "--abort"]);
        return {
          ok: false,
          error: `Rebase conflict resolution failed for ${publicBranchName}: ${resolved.error}${
            unresolvedPaths ? ` | unresolved=${unresolvedPaths}` : ""
          }`,
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

type MaskedRepoLocalCodexFile = {
  codexPath: string;
  backupPath: string;
};

function codexProjectConfigRoots(repo: string, env: Record<string, string>): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const text = String(raw ?? "").trim();
    if (!text) return;
    const root = resolve(text);
    const key = root.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(root);
  };
  add(repo);
  for (const key of [
    "PUSHPALS_REPO_ROOT_OVERRIDE",
    "PUSHPALS_PROJECT_ROOT_OVERRIDE",
    "PUSHPALS_ASSIGNED_REPO_ROOT",
    "PUSHPALS_REPO_PATH",
  ]) {
    add(env[key]);
  }
  return roots;
}

function maskRepoLocalCodexFilesForCodexCli(
  repo: string,
  env: Record<string, string>,
): MaskedRepoLocalCodexFile[] {
  const masked: MaskedRepoLocalCodexFile[] = [];
  for (const root of codexProjectConfigRoots(repo, env)) {
    const codexPath = resolve(root, ".codex");
    if (!existsSync(codexPath)) continue;
    try {
      if (lstatSync(codexPath).isDirectory()) continue;
      let backupPath = resolve(root, `.codex.pushpals-masked-${process.pid}-${masked.length}`);
      let suffix = 0;
      while (existsSync(backupPath)) {
        suffix += 1;
        backupPath = resolve(
          root,
          `.codex.pushpals-masked-${process.pid}-${masked.length}-${suffix}`,
        );
      }
      renameSync(codexPath, backupPath);
      masked.push({ codexPath, backupPath });
      console.warn(
        `[WorkerPals] Temporarily masked repo-local .codex file so Codex CLI can use CODEX_HOME: ${codexPath}`,
      );
    } catch (error) {
      console.warn(
        `[WorkerPals] Failed to mask repo-local .codex file ${codexPath}: ${String(error)}`,
      );
    }
  }
  return masked;
}

function restoreRepoLocalCodexFilesForCodexCli(masked: MaskedRepoLocalCodexFile[]): void {
  for (const entry of [...masked].reverse()) {
    try {
      if (existsSync(entry.codexPath)) {
        rmSync(entry.codexPath, { recursive: true, force: true });
      }
      if (existsSync(entry.backupPath)) {
        renameSync(entry.backupPath, entry.codexPath);
      }
    } catch (error) {
      console.warn(
        `[WorkerPals] Failed to restore repo-local .codex file ${entry.codexPath}: ${String(error)}`,
      );
    }
  }
}

function normalizeCodexReasoningEffort(
  value: unknown,
  model = "",
): "low" | "medium" | "high" | "xhigh" {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(String(model ?? "").trim());
  const defaultEffort = supportsExtraHigh ? "xhigh" : "high";
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
  return defaultEffort;
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

export function resolveCommitMessageGeneratorTimeoutMs(
  runtimeConfig: WorkerpalsRuntimeConfig = DEFAULT_CONFIG,
): number {
  const workerpalsConfig = runtimeConfig.workerpals as Record<string, unknown>;
  const llmConfig =
    workerpalsConfig.llm && typeof workerpalsConfig.llm === "object"
      ? (workerpalsConfig.llm as Record<string, unknown>)
      : {};
  const configuredRaw =
    workerpalsConfig.commitMessageTimeoutMs ??
    workerpalsConfig.commit_message_timeout_ms ??
    llmConfig.commitMessageTimeoutMs ??
    llmConfig.commit_message_timeout_ms ??
    Bun.env.WORKERPALS_COMMIT_MESSAGE_TIMEOUT_MS;
  const configured = Number(configuredRaw);
  const value = Number.isFinite(configured) ? configured : COMMIT_MSG_GENERATOR_DEFAULT_TIMEOUT_MS;
  return Math.max(
    COMMIT_MSG_GENERATOR_MIN_TIMEOUT_MS,
    Math.min(COMMIT_MSG_GENERATOR_MAX_TIMEOUT_MS, Math.floor(value)),
  );
}

export function shouldUseLlmCommitMessageForStagedDiff(params: {
  changedPaths: string[];
  diff: string;
}): boolean {
  if (!String(params.diff ?? "").trim()) return false;
  return params.changedPaths.length <= COMMIT_MSG_LLM_MAX_CHANGED_PATHS;
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
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!model) return null;
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix) return null;
  const timeoutMs = resolveCommitMessageGeneratorTimeoutMs(runtimeConfig);
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

  const env = buildWorkerSandboxWritableEnv(repo);
  const codexMask = maskRepoLocalCodexFilesForCodexCli(repo, env);
  try {
    const stdinText = `${prompt.systemPrompt}\n\n${prompt.userMessage}`;
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      env,
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
    restoreRepoLocalCodexFilesForCodexCli(codexMask);
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
  const timer = setTimeout(
    () => controller.abort(),
    resolveCommitMessageGeneratorTimeoutMs(runtimeConfig),
  );
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
const MAX_MERGE_CONFLICT_RESOLUTION_PASSES = 8;

type TaskExecutePriority = "interactive" | "normal" | "background";
type TaskExecuteIntent = "chat" | "status" | "code_change" | "analysis" | "other";
type TaskExecuteRisk = "low" | "medium" | "high";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasInvalidRepoPathHint(values: string[]): boolean {
  return values.some((entry) => normalizeStagePath(entry) === null);
}

export const SANDBOX_STAGE_ARTIFACT_PATHS = ["workspace", "outputs", ".codex", "node_modules"];

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

export function collectWriteScopeIssuesFromChangedPaths(
  changedPaths: string[],
  planning: TaskExecutePlanning,
): string[] {
  void changedPaths;
  void planning;
  // WorkerPals run in isolated worktrees and may write anywhere in that repo sandbox.
  // Scope hints guide planning/review, but they are not hard write privileges.
  return [];
}

function pathHintHasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function pathHintLooksLikeConcreteFile(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const tail = normalized.split("/").pop() ?? normalized;
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/.test(tail);
}

function taskTextAllowsCreatingMissingPaths(value: string): boolean {
  return /\b(create|add|new|scaffold|generate|introduce|write)\b.{0,80}\b(file|test|module|component|script|page|route|fixture|helper)\b/i.test(
    value,
  );
}

function shouldTreatMissingPathHintAsStale(repo: string, path: string, taskText: string): boolean {
  const normalized = normalizeStagePath(path);
  if (!normalized || normalized === "." || pathHintHasGlob(normalized)) return false;
  if (existsSync(resolve(repo, normalized))) return false;
  if (!pathHintLooksLikeConcreteFile(normalized)) return false;
  if (taskTextAllowsCreatingMissingPaths(taskText)) return false;
  return true;
}

function pathParentExists(repo: string, path: string): boolean {
  const normalized = normalizeStagePath(path);
  if (!normalized || normalized === "." || pathHintHasGlob(normalized)) return true;
  const parts = normalized.split("/");
  if (parts.length <= 1) return true;
  return existsSync(resolve(repo, parts.slice(0, -1).join("/")));
}

function sanitizeStalePathHints(
  repo: string,
  values: unknown,
  taskText: string,
  opts: { dropMissingParentHints?: boolean } = {},
): { values: string[]; stale: string[]; diagnostics: string[] } {
  const stale: string[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of toStringArray(values)) {
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    if (shouldTreatMissingPathHintAsStale(repo, raw, taskText)) {
      stale.push(raw);
      diagnostics.push(
        `Path hint "${raw}" does not exist in this checkout; treat it as stale unless the task explicitly asks to create it.`,
      );
      continue;
    }
    if (!pathParentExists(repo, raw) && !taskTextAllowsCreatingMissingPaths(taskText)) {
      const diagnostic = `Path hint "${raw}" has a missing parent directory; verify the existing repo owner before editing.`;
      diagnostics.push(diagnostic);
      if (opts.dropMissingParentHints) {
        stale.push(raw);
        continue;
      }
    }
    out.push(raw);
  }
  return { values: out, stale, diagnostics };
}

function validationStepMentionsAnyPath(step: string, paths: string[]): boolean {
  const lower = step.replace(/\\/g, "/").toLowerCase();
  return paths.some((path) => lower.includes(path.replace(/\\/g, "/").toLowerCase()));
}

export function sanitizeTaskExecutePlanningPathHints(
  value: unknown,
  repo?: string,
  instruction = "",
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const planning = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...planning };
  const taskText = [
    instruction,
    planning.intent,
    ...(isStringArray(planning.targetPaths) ? planning.targetPaths : []),
    ...(isStringArray(planning.acceptanceCriteria) ? planning.acceptanceCriteria : []),
    ...(isStringArray(planning.validationSteps) ? planning.validationSteps : []),
  ]
    .map((entry) => String(entry ?? ""))
    .join("\n");
  const repoDiagnostics: string[] = isStringArray(planning.repoHintDiagnostics)
    ? toStringArray(planning.repoHintDiagnostics)
    : [];
  const staleHints: string[] = [];

  if (repo && isStringArray(planning.targetPaths)) {
    const sanitized = sanitizeStalePathHints(repo, planning.targetPaths, taskText);
    out.targetPaths = sanitized.values;
    staleHints.push(...sanitized.stale);
    repoDiagnostics.push(...sanitized.diagnostics);
  }

  if (planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope)) {
    const scope = planning.scope as Record<string, unknown>;
    const normalizedScope: Record<string, unknown> = { ...scope };
    if (isStringArray(scope.writeGlobs)) {
      const sanitized = repo
        ? sanitizeStalePathHints(repo, scope.writeGlobs, taskText)
        : { values: toStringArray(scope.writeGlobs), stale: [], diagnostics: [] };
      normalizedScope.writeGlobs = sanitized.values;
      staleHints.push(...sanitized.stale);
      repoDiagnostics.push(...sanitized.diagnostics);
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
      const sanitized = repo
        ? sanitizeStalePathHints(repo, discovery.likelyDirs, taskText, {
            dropMissingParentHints: true,
          })
        : { values: toStringArray(discovery.likelyDirs), stale: [], diagnostics: [] };
      normalizedDiscovery.likelyDirs = sanitized.values;
      staleHints.push(...sanitized.stale);
      repoDiagnostics.push(...sanitized.diagnostics);
    }
    out.discovery = normalizedDiscovery;
  }

  if (staleHints.length > 0 && isStringArray(planning.validationSteps)) {
    out.validationSteps = toStringArray(planning.validationSteps).filter(
      (step) => !validationStepMentionsAnyPath(step, staleHints),
    );
  }
  if (staleHints.length > 0 && isStringArray(planning.requiredValidationSteps)) {
    out.requiredValidationSteps = toStringArray(planning.requiredValidationSteps).filter(
      (step) => !validationStepMentionsAnyPath(step, staleHints),
    );
  }
  if (repoDiagnostics.length > 0) {
    out.repoHintDiagnostics = Array.from(new Set(repoDiagnostics)).slice(0, 8);
  }
  if (staleHints.length > 0) {
    out.repoHintStalePaths = Array.from(new Set(staleHints)).slice(0, 16);
  }

  return out;
}

export function sanitizePlannerWorkerInstructionPathHints(
  value: unknown,
  staleHints: unknown,
): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const normalizedHints = toStringArray(staleHints)
    .map((hint) => normalizeStagePath(hint))
    .filter((hint): hint is string => Boolean(hint))
    .map((hint) => hint.toLowerCase());
  if (normalizedHints.length === 0) return text;

  const uniqueHints = Array.from(new Set(normalizedHints));
  const hasStaleHint = (line: string): boolean => {
    const lower = line.replace(/\\/g, "/").toLowerCase();
    return uniqueHints.some((hint) => lower.includes(hint));
  };
  const lines = text.split(/\r?\n/);
  const kept = lines
    .filter((line) => !hasStaleHint(line))
    .map((line) => line.trim())
    .filter(Boolean);
  if (kept.length === lines.length) return text;

  return [
    "Planner path guidance was sanitized because it referenced paths absent from this checkout; rely on the Task planning contract target path hints and existing repo owners instead.",
    ...kept,
  ].join("\n");
}

function validateTaskExecutePlanning(
  value: unknown,
  options?: {
    origin?: "autonomy" | "user";
    autonomyComponentArea?: unknown;
    reviewAgentResolutionType?: unknown;
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
  if (
    planning.requiredValidationSteps !== undefined &&
    !isStringArray(planning.requiredValidationSteps)
  ) {
    return {
      ok: false,
      message: "task.execute planning.requiredValidationSteps must be a string array",
    };
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
      "[CriticGate] Codex: unable to resolve Codex CLI command (workerpals.llm.codex_bin/PATH); skipping.",
    );
    return null;
  }

  const instruction = String(params.instruction ?? "").trim();
  const planning = params.planning as TaskExecutePlanning;
  const qualityCriticTimeoutMs = resolveQualityCriticTimeoutMs(runtimeConfig);
  const timeoutBehavior = resolveQualityCriticTimeoutBehavior(runtimeConfig);
  const criticModel = resolveQualityCriticModel(runtimeConfig);

  const buildCriticInstruction = async (compact: boolean) => {
    const changedForDiff = quality.changedPaths.slice(0, compact ? 4 : 8);
    let diffText = "";
    if (changedForDiff.length > 0) {
      const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
      diffText = diffResult.ok ? diffResult.stdout : diffResult.stderr;
    }
    diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(
      0,
      resolveQualityCriticMaxDiffChars(runtimeConfig, compact),
    );
    const validationSummary = buildCriticValidationSummary(
      quality,
      resolveQualityCriticMaxValidationOutputChars(runtimeConfig, compact),
    );
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
    return {
      criticInstruction,
      promptChars: criticInstruction.length,
      promptBytes: new TextEncoder().encode(criticInstruction).length,
      diffChars: diffText.length,
      validationChars: validationSummary.length,
    };
  };
  type CodexCriticPayload = Awaited<ReturnType<typeof buildCriticInstruction>>;

  const tmpOutputPath = `/tmp/pushpals-critic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const buildCmd = () => {
    const cmd = [
      ...codexPrefix,
      "-c",
      'model_reasoning_effort="low"',
      "-a",
      "never",
      "exec",
      "-s",
      "read-only",
      "--color",
      "never",
      "--output-last-message",
      tmpOutputPath,
    ];
    if (criticModel) cmd.push("-m", criticModel);
    cmd.push("-");
    return cmd;
  };

  const env = buildWorkerSandboxWritableEnv(repo);
  const codexMask = maskRepoLocalCodexFilesForCodexCli(repo, env);

  const runAttempt = async (
    attempt: number,
    compact: boolean,
    payloadOverride?: CodexCriticPayload,
  ): Promise<
    | { status: "timeout"; payload: CodexCriticPayload }
    | { status: "done"; review: CriticReview | null; payload: CodexCriticPayload }
  > => {
    try {
      unlinkSync(tmpOutputPath);
    } catch {
      /* ignore stale/missing critic output */
    }
    const payload = payloadOverride ?? (await buildCriticInstruction(compact));
    const startedAt = Date.now();
    onLog?.(
      "stdout",
      `[CriticGate] Codex review attempt ${attempt}${compact ? " (compact)" : ""}: model=${criticModel || "(codex default)"} timeout_ms=${qualityCriticTimeoutMs} behavior=${timeoutBehavior} prompt_chars=${payload.promptChars} prompt_bytes=${payload.promptBytes} diff_chars=${payload.diffChars} validation_chars=${payload.validationChars}`,
    );
    const proc = Bun.spawn(buildCmd(), {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([payload.criticInstruction]),
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
      return { status: "timeout", payload };
    }
    if (exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      onLog?.("stderr", `[CriticGate] Codex exited ${exitCode}: ${toSingleLine(stderrText, 220)}`);
      return { status: "done", review: null, payload };
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
      onLog?.("stderr", "[CriticGate] Codex: no output message captured; skipping.");
      return { status: "done", review: null, payload };
    }

    const reviewObj = parseJsonObjectLoose(lastMessage);
    if (!reviewObj) {
      onLog?.("stderr", `[CriticGate] Codex returned non-JSON: ${toSingleLine(lastMessage, 220)}`);
      return { status: "done", review: null, payload };
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
    onLog?.(
      "stdout",
      `[CriticGate] Codex score: ${score}/10 (${Date.now() - startedAt}ms, attempt ${attempt})`,
    );
    return {
      status: "done",
      payload,
      review: {
        score,
        findings,
        mustFix,
        revisionGuidance,
        raw: compactJobOutput(lastMessage, outputPolicyForRuntime(runtimeConfig)),
      },
    };
  };

  try {
    let attempt = await runAttempt(1, false);
    if (attempt.status === "timeout" && timeoutBehavior === "retry_once") {
      const compactPayload = await buildCriticInstruction(true);
      const validationPassed =
        quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
      if (
        shouldRetryCriticTimeoutWithCompact({
          timeoutBehavior,
          qualityOk: quality.ok,
          validationPassed,
          initialPromptChars: attempt.payload.promptChars,
          compactPromptChars: compactPayload.promptChars,
        })
      ) {
        onLog?.(
          "stderr",
          `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; retrying once with compact critic input.`,
        );
        attempt = await runAttempt(2, true, compactPayload);
      } else {
        const reductionPct = Math.max(
          0,
          Math.round(
            (1 - compactPayload.promptChars / Math.max(1, attempt.payload.promptChars)) * 100,
          ),
        );
        onLog?.(
          "stderr",
          `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; compact critic input only reduced prompt by ${reductionPct}% after clean validation; skipping retry.`,
        );
        return null;
      }
    }
    if (attempt.status === "timeout") {
      if (timeoutBehavior === "block") {
        onLog?.(
          "stderr",
          `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; blocking because quality_critic_timeout_behavior=block.`,
        );
        return criticTimeoutReview("Codex", qualityCriticTimeoutMs, qualityCriticTimeoutMs);
      }
      onLog?.(
        "stderr",
        `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; skipping.`,
      );
      return null;
    }
    return attempt.review;
  } catch (err) {
    onLog?.("stderr", `[CriticGate] Codex error: ${toSingleLine(err, 220)} (skipping).`);
    return null;
  } finally {
    restoreRepoLocalCodexFilesForCodexCli(codexMask);
    try {
      unlinkSync(tmpOutputPath);
    } catch {
      /* ignore */
    }
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
  const reviewAgent =
    params.reviewAgent &&
    typeof params.reviewAgent === "object" &&
    !Array.isArray(params.reviewAgent)
      ? (params.reviewAgent as Record<string, unknown>)
      : null;
  const planningValidation = validateTaskExecutePlanning(params.planning, {
    origin,
    autonomyComponentArea: autonomyScope?.componentArea ?? autonomyScope?.component_area,
    reviewAgentResolutionType: reviewAgent?.resolutionType,
  });
  if (!planningValidation.ok) {
    return {
      ok: false,
      summary: planningValidation.message,
      exitCode: 2,
    };
  }
  const instruction = String(params.instruction ?? "").trim();
  const sanitizedPlanning = sanitizeTaskExecutePlanningPathHints(
    params.planning,
    repo,
    instruction,
  );
  const planning = sanitizedPlanning as TaskExecutePlanning;
  if (origin === "autonomy" && toStringArray(planning.scope.writeGlobs ?? []).length === 0) {
    onLog?.(
      "stdout",
      "[TaskExecute] Scope suggestion: planning.scope.writeGlobs is empty for autonomy-origin task.",
    );
  }
  if ((planning.repoHintDiagnostics ?? []).length > 0) {
    onLog?.(
      "stdout",
      `[TaskExecute] Repo hint preflight: ${(planning.repoHintDiagnostics ?? [])
        .slice(0, 3)
        .map((entry) => toSingleLine(entry, 180))
        .join(" | ")}`,
    );
  }

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
  const sanitizedPlannerWorkerInstruction = sanitizePlannerWorkerInstructionPathHints(
    params.plannerWorkerInstruction,
    planning.repoHintStalePaths ?? [],
  );
  if (sanitizedPlannerWorkerInstruction !== undefined) {
    normalizedParams.plannerWorkerInstruction = sanitizedPlannerWorkerInstruction;
  }
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);
  const mergeConflictContext = extractMergeConflictReviewContext(normalizedParams);
  const reviewFixContext = extractReviewFixContext(normalizedParams);
  const qualityGatePolicy = deriveQualityGatePolicy(normalizedParams, runtimeConfig);
  const qualityMaxAutoRevisions = qualityGatePolicy.maxAutoRevisions;
  const qualityValidationMaxAutoRevisions = qualityGatePolicy.validationMaxAutoRevisions;
  const qualityRepoValidationRepairMaxAutoRevisions = Math.max(
    qualityValidationMaxAutoRevisions,
    REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS,
  );
  const qualityRevisionLoopMax = Math.max(
    qualityRevisionLoopUpperBound(qualityGatePolicy, {
      browserValidation: taskRequestsBrowserValidation(normalizedParams),
    }),
    qualityRepoValidationRepairMaxAutoRevisions,
  );
  const qualitySoftPassOnExhausted = qualityGatePolicy.softPassOnExhausted;
  const qualityCriticMinScore = qualityGatePolicy.criticMinScore;

  onLog?.(
    "stdout",
    `[QualityGate] Policy: max_auto_revisions=${qualityMaxAutoRevisions}, validation_max_auto_revisions=${qualityValidationMaxAutoRevisions}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}, critic_min_score=${qualityCriticMinScore}`,
  );
  onLog?.(
    "stdout",
    `[QualityGate] Gates: scope=${qualityGatePolicy.scopeGateEnabled ? "on" : "off"}, validation=${
      qualityGatePolicy.validationGateEnabled ? "on" : "off"
    }, critic=${qualityGatePolicy.criticGateEnabled ? "on" : "off"}, publish=${
      qualityGatePolicy.publishGateEnabled ? "on" : "off"
    }`,
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
      `[QualityGate] review_fix policy active: prior_score=${priorScore}, target_threshold=${threshold}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; unfinished branch-state blockers fail hard, but repo/environment validation blockers soft-pass once the update is publishable.`,
    );
  } else if (qualityGatePolicy.mode === "merge_conflict") {
    onLog?.(
      "stdout",
      `[QualityGate] merge_conflict policy active: soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; unfinished rebases still fail hard, but repo/environment validation blockers soft-pass once the rebase is publishable.`,
    );
  }

  let revisionAttempt = 0;
  let revisionHint = "";
  const jobStartedAt = Date.now();
  const previousValidationFailureDigests = new Map<string, string>();
  const failureJobFamily = buildTaskFailureJobFamily(normalizedParams);
  const diagnosticValidationRuns: JobValidationRunDiagnostics[] = [];
  const diagnosticPatchSnapshots: JobPatchSnapshotDiagnostics[] = [];
  let nextQualityRevisionExecuteBudgets: {
    executionBudgetMs: number;
    finalizationBudgetMs: number;
  } | null = null;
  while (revisionAttempt <= qualityRevisionLoopMax) {
    const attemptStartedAt = Date.now();
    const attemptParams: Record<string, unknown> = { ...normalizedParams };
    if (revisionHint) {
      attemptParams.qualityRevisionHint = revisionHint;
      attemptParams.qualityRevisionAttempt = revisionAttempt;
    }

    const executor = resolveExecutor(runtimeConfig);
    const defaultExecuteBudgets = nextQualityRevisionExecuteBudgets ?? {
      executionBudgetMs,
      finalizationBudgetMs,
    };
    nextQualityRevisionExecuteBudgets = null;
    const runExecutor = getBackendTaskExecutor(executor);
    if (!runExecutor) {
      return {
        ok: false,
        summary: `No task executor registered for backend "${executor}"`,
        exitCode: 1,
      };
    }
    let result: Awaited<ReturnType<typeof runExecutor>> | null = null;
    let mergeConflictPass = 0;
    let executorElapsedMs = 0;
    let nextMergeConflictExecuteBudgets: typeof defaultExecuteBudgets | null = null;
    while (true) {
      const currentExecuteBudgets = nextMergeConflictExecuteBudgets ?? defaultExecuteBudgets;
      nextMergeConflictExecuteBudgets = null;
      const currentResult = await runExecutor(
        kind,
        attemptParams,
        repo,
        runtimeConfig,
        onLog,
        currentExecuteBudgets,
      );
      if (!currentResult.ok) return currentResult;
      result = currentResult;
      if (!mergeConflictContext) break;

      const resume = await resumePreparedMergeConflictRebase(repo, kind, attemptParams, onLog);
      if (!resume.ok) {
        onLog?.("stderr", `[MergeConflict] ${resume.error}`);
        return {
          ok: false,
          summary: "Merge-conflict rebase continuation failed",
          stdout: currentResult.stdout,
          stderr: [currentResult.stderr ?? "", resume.error].filter(Boolean).join("\n"),
          exitCode: 4,
        };
      }
      const sequencer = resume.sequencer;
      if (!sequencer) break;
      if (sequencer === "rebase" && resume.resumed && resume.advancedToNextConflict) {
        mergeConflictPass += 1;
        if (mergeConflictPass >= MAX_MERGE_CONFLICT_RESOLUTION_PASSES) {
          const detail =
            `Merge-conflict rebase required more than ${MAX_MERGE_CONFLICT_RESOLUTION_PASSES} resolver passes. ` +
            "Stopping to avoid an infinite conflict-resolution loop.";
          onLog?.("stderr", `[MergeConflict] ${detail}`);
          return {
            ok: false,
            summary: detail,
            stdout: currentResult.stdout,
            stderr: [currentResult.stderr ?? "", resume.detail ?? detail]
              .filter(Boolean)
              .join("\n"),
            exitCode: 4,
          };
        }
        const retryBudget = mergeConflictResolverRetryBudgetDecision({
          jobElapsedMs: Date.now() - attemptStartedAt,
          executionBudgetMs,
          finalizationBudgetMs,
        });
        if (!retryBudget.shouldStart) {
          const detail =
            "Merge-conflict rebase advanced into another conflicted commit, but remaining job budget " +
            `is ${retryBudget.remainingTotalBudgetMs}ms (< ${retryBudget.minimumExecutionBudgetMs}ms execution).`;
          onLog?.("stderr", `[MergeConflict] ${detail}`);
          return {
            ok: false,
            summary: detail,
            stdout: currentResult.stdout,
            stderr: [currentResult.stderr ?? "", resume.detail ?? detail]
              .filter(Boolean)
              .join("\n"),
            exitCode: 4,
          };
        }
        nextMergeConflictExecuteBudgets = {
          executionBudgetMs: retryBudget.executionBudgetMs,
          finalizationBudgetMs: retryBudget.finalizationBudgetMs,
        };
        onLog?.(
          "stdout",
          `[MergeConflict] Rebase surfaced another conflicted commit after auto-continue; rerunning resolver pass ${
            mergeConflictPass + 1
          } with a capped completion budget (${retryBudget.executionBudgetMs}ms execution).`,
        );
        continue;
      }
      if (sequencer === "rebase" && !resume.resumed) {
        mergeConflictPass += 1;
        const budget = mergeConflictResolverRetryBudgetDecision({
          jobElapsedMs: Date.now() - attemptStartedAt,
          executionBudgetMs,
          finalizationBudgetMs,
        });
        if (mergeConflictPass < MAX_MERGE_CONFLICT_RESOLUTION_PASSES && budget.shouldStart) {
          const retryDetail =
            resume.detail ??
            "the previous resolver pass returned before the prepared rebase completed";
          const previousHint = String(attemptParams.qualityRevisionHint ?? "").trim();
          attemptParams.qualityRevisionHint = [
            previousHint,
            [
              `Merge-conflict resolver pass ${mergeConflictPass} left the rebase unfinished: ${retryDetail}.`,
              "Focus only on completing the active rebase. Inspect unresolved files with `git diff --name-only --diff-filter=U`, remove remaining conflict markers, stage resolved files, and run `git -c core.editor=true rebase --continue` until no rebase remains.",
              "Do not broaden the patch or run full validation before the rebase is complete.",
            ].join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n");
          nextMergeConflictExecuteBudgets = {
            executionBudgetMs: budget.executionBudgetMs,
            finalizationBudgetMs: budget.finalizationBudgetMs,
          };
          onLog?.(
            "stdout",
            `[MergeConflict] ${retryDetail}; rerunning resolver pass ${
              mergeConflictPass + 1
            } with focused rebase-completion guidance and capped budget (${budget.executionBudgetMs}ms execution).`,
          );
          continue;
        }
        if (!budget.shouldStart) {
          onLog?.(
            "stderr",
            `[MergeConflict] Not rerunning unfinished rebase resolver: remaining total budget is ${budget.remainingTotalBudgetMs}ms (< ${budget.minimumExecutionBudgetMs}ms execution).`,
          );
        }
      }
      const detail =
        `Merge-conflict job returned with git ${sequencer} still in progress. ` +
        `Finish the ${sequencer} before returning control to WorkerPals.`;
      onLog?.("stderr", `[MergeConflict] ${detail}`);
      return {
        ok: false,
        summary: detail,
        stdout: currentResult.stdout,
        stderr: [currentResult.stderr ?? "", detail].filter(Boolean).join("\n"),
        exitCode: 4,
      };
    }
    if (!result) {
      return {
        ok: false,
        summary: "Merge-conflict execution ended without an executor result.",
        exitCode: 4,
      };
    }
    executorElapsedMs = Date.now() - attemptStartedAt;

    const preQualityStatus = await git(repo, ["status", "--porcelain"]);
    const rawPreQualityChangedPaths = preQualityStatus.ok
      ? expandKnownArtifactDirectoryPaths(
          repo,
          parseChangedPathsFromStatus(preQualityStatus.stdout),
        )
      : [];
    const preQualityChangedPaths = preQualityStatus.ok
      ? await filterChangedPathsByGitContentDelta(repo, rawPreQualityChangedPaths)
      : rawPreQualityChangedPaths;
    const preQualityPublishablePaths = publishableChangedPaths(preQualityChangedPaths);
    if (preQualityChangedPaths.length > 0) {
      diagnosticPatchSnapshots.push(
        buildPatchSnapshotDiagnostics(preQualityChangedPaths, revisionAttempt, "executor"),
      );
    }
    const executorText = `${result.summary ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const shellWrapperReturn =
      /shell-wrapper command rejections|command-router shell-wrapper|command policy rejection/i.test(
        executorText,
      );
    if (preQualityChangedPaths.length > 0 && preQualityPublishablePaths.length === 0) {
      const detail = `Executor changed only non-publishable dependency/runtime artifact path(s): ${preQualityChangedPaths
        .slice(0, 12)
        .join(", ")}${preQualityChangedPaths.length > 12 ? ", ..." : ""}.`;
      onLog?.(
        "stderr",
        `[QualityGate] ${detail} Skipping ValidationGate/CriticGate because there is no PR-worthy patch to validate.`,
      );
      const failure: JobResult = {
        ok: false,
        summary: `Executor produced no publishable code changes (${detail})`,
        stdout: result.stdout,
        stderr: [result.stderr ?? "", detail].filter(Boolean).join("\n"),
        exitCode: 4,
      };
      return withJobDiagnostics(failure, {
        terminal: buildTerminalDiagnostics({
          result: failure,
          executor,
          changedPaths: preQualityChangedPaths,
          terminalStage: "executor",
          timeoutMs: executionBudgetMs,
          metadata: { revisionAttempt, executorElapsedMs },
        }),
        patchSnapshots: [...diagnosticPatchSnapshots],
      });
    }
    if (
      preQualityPublishablePaths.length === 0 &&
      (qualityGatePolicy.mode === "review_fix" || shellWrapperReturn)
    ) {
      const reason =
        qualityGatePolicy.mode === "review_fix"
          ? "Review-fix executor returned without publishable code changes."
          : "Codex hit shell-wrapper command rejections without leaving a publishable patch.";
      onLog?.(
        "stderr",
        `[QualityGate] ${reason} Skipping ValidationGate/CriticGate and failing fast.`,
      );
      const failure: JobResult = {
        ok: false,
        summary: reason,
        stdout: result.stdout,
        stderr: [result.stderr ?? "", reason].filter(Boolean).join("\n"),
        exitCode: 4,
      };
      return withJobDiagnostics(failure, {
        terminal: buildTerminalDiagnostics({
          result: failure,
          executor,
          changedPaths: preQualityChangedPaths,
          terminalStage: "executor",
          timeoutMs: executionBudgetMs,
          metadata: { revisionAttempt, executorElapsedMs, shellWrapperReturn },
        }),
        patchSnapshots: [...diagnosticPatchSnapshots],
      });
    }

    const qualityStartedAt = Date.now();
    const quality = await runDeterministicQualityGate(
      repo,
      attemptParams,
      runtimeConfig,
      qualityGatePolicy,
      onLog,
      {
        previousFailureDigests: previousValidationFailureDigests,
        revisionAttempt,
      },
    );
    const qualityElapsedMs = Date.now() - qualityStartedAt;
    diagnosticPatchSnapshots.push(
      buildPatchSnapshotDiagnostics(quality.changedPaths, revisionAttempt, "quality"),
    );
    diagnosticValidationRuns.push(
      ...buildValidationRunDiagnostics(quality.validationRuns, revisionAttempt),
    );
    const validationCommandElapsedMs = quality.validationRuns.reduce(
      (total, run) => total + Math.max(0, Number(run.elapsedMs) || 0),
      0,
    );
    onLog?.(
      "stdout",
      `[JobRunner] Performance summary: attempt=${revisionAttempt}, executor=${executorElapsedMs}ms, quality=${qualityElapsedMs}ms, validation_commands=${quality.validationRuns.length}, validation_command_time=${validationCommandElapsedMs}ms, changed_files=${quality.changedPaths.length}`,
    );
    recordValidationRemedyMemory(repo, failureJobFamily, quality.validationRuns);
    const validationRemedyHints = knownValidationRemedyHintsForRuns(
      repo,
      failureJobFamily,
      quality.validationRuns,
    );
    let browserRepairPacket = buildBrowserValidationRepairPacket(
      quality.validationRuns,
      previousValidationFailureDigests,
      repo,
    );
    if (browserRepairPacket) {
      const knownFailureHints = knownFailureHintsForPacket(
        repo,
        failureJobFamily,
        browserRepairPacket,
      );
      browserRepairPacket = {
        ...browserRepairPacket,
        knownFailureHints,
      };
      recordBrowserFailureMemory(repo, failureJobFamily, browserRepairPacket);
    }
    for (const run of quality.validationRuns) {
      if (run.ok) continue;
      const digest = extractValidationFailureRetryDigest(run, repo);
      if (digest) previousValidationFailureDigests.set(validationCommandKey(run.command), digest);
    }
    const validationOutsideTaskScope = quality.validationFailureScope === "outside_task_scope";
    const repoValidationRepairMode = shouldRepairOutsideTaskRequiredValidation({
      requiredValidationFailures: quality.requiredValidationFailures,
      validationFailureScope: quality.validationFailureScope,
      changedPaths: quality.changedPaths,
      revisionAttempt,
      maxAutoRevisions: qualityRepoValidationRepairMaxAutoRevisions,
    });
    const validationOutsideTaskScopeBlocksOnly =
      validationOutsideTaskScope && !repoValidationRepairMode;
    if (repoValidationRepairMode) {
      onLog?.(
        "stderr",
        `[ValidationGate] Required validation failed outside original task scope; entering guarded repo validation repair mode for revision ${
          revisionAttempt + 1
        }/${qualityRepoValidationRepairMaxAutoRevisions}: ${quality.requiredValidationFailures.join("; ")}`,
      );
    }
    const qualityForCritic: DeterministicQualityResult = validationOutsideTaskScopeBlocksOnly
      ? {
          ...quality,
          issues: quality.issues.filter((issue) => !issue.startsWith("ValidationGate:")),
          validationIssues: [],
          validationRuns: [],
          blocker: null,
        }
      : quality;
    const validationPassed =
      quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
    const skipCriticAfterExecutorTimeout = shouldSkipCriticAfterExecutorTimeout({
      executor,
      policyMode: qualityGatePolicy.mode,
      executorText,
      qualityOk: quality.ok,
      validationPassed,
      qualityIssues: qualityForCritic.issues,
      changedPaths: quality.changedPaths,
    });
    const preCriticEffectiveQualityIssues = validationOutsideTaskScopeBlocksOnly
      ? quality.issues.filter((issue) => !issue.startsWith("ValidationGate:"))
      : quality.issues;
    const preCriticDeterministicRequiresRevision =
      preCriticEffectiveQualityIssues.length > 0 ||
      (quality.blocker !== null && !validationOutsideTaskScopeBlocksOnly);
    const skipCriticForDeterministicValidationRevision =
      shouldSkipCriticForDeterministicValidationRevision({
        deterministicRequiresRevision: preCriticDeterministicRequiresRevision,
        validationOutsideTaskScope: validationOutsideTaskScopeBlocksOnly,
        validationRuns: quality.validationRuns,
      });
    const preCriticRevisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: Date.now() - jobStartedAt,
      executionBudgetMs,
    });
    const skipCriticForRevisionBudget = shouldSkipCriticToPreserveRevisionBudget({
      deterministicRequiresRevision: preCriticDeterministicRequiresRevision,
      remainingBudgetMs: preCriticRevisionBudget.remainingBudgetMs,
      minimumRevisionBudgetMs: preCriticRevisionBudget.minimumRevisionBudgetMs,
      criticTimeoutMs: resolveQualityCriticTimeoutMs(runtimeConfig),
      criticTimeoutBehavior: resolveQualityCriticTimeoutBehavior(runtimeConfig),
    });
    const critic =
      quality.skipped ||
      !qualityGatePolicy.criticGateEnabled ||
      skipCriticAfterExecutorTimeout ||
      skipCriticForDeterministicValidationRevision ||
      skipCriticForRevisionBudget
        ? null
        : executor === "openai_codex"
          ? await runCodexCriticReview(repo, attemptParams, qualityForCritic, runtimeConfig, onLog)
          : await runTaskCriticReview(repo, attemptParams, qualityForCritic, runtimeConfig, onLog);
    const annotateTerminalResult = (
      terminalResult: JobResult,
      terminalStage: string,
      changedPaths: string[] = quality.changedPaths,
    ): JobResult =>
      withJobDiagnostics(terminalResult, {
        terminal: buildTerminalDiagnostics({
          result: terminalResult,
          executor,
          changedPaths,
          terminalStage,
          timeoutMs: executionBudgetMs,
          metadata: {
            revisionAttempt,
            executorElapsedMs,
            qualityElapsedMs,
            validationFailureScope: quality.validationFailureScope,
            repoValidationRepairMode,
            validationRuns: quality.validationRuns.length,
            criticScore: critic?.score ?? null,
          },
        }),
        validationRuns: [...diagnosticValidationRuns],
        patchSnapshots: [...diagnosticPatchSnapshots],
      });
    if (!qualityGatePolicy.criticGateEnabled) {
      onLog?.("stdout", "[CriticGate] Disabled by workerpals.quality_critic_gate_enabled=false.");
    } else if (skipCriticAfterExecutorTimeout) {
      onLog?.(
        "stdout",
        "[CriticGate] Skipping Codex critic after primary Codex executor timeout because deterministic quality and validation are clean.",
      );
    } else if (skipCriticForDeterministicValidationRevision) {
      onLog?.(
        "stdout",
        "[CriticGate] Skipping critic because deterministic fast validation already requires a quality revision.",
      );
    } else if (skipCriticForRevisionBudget) {
      onLog?.(
        "stdout",
        `[CriticGate] Skipping critic because deterministic quality already requires revision and remaining budget (${preCriticRevisionBudget.remainingBudgetMs}ms) must be reserved for the next worker turn.`,
      );
    }
    const rolloutScore = workerAttemptRolloutScore({
      executorElapsedMs,
      qualityElapsedMs,
      changedPaths: quality.changedPaths,
      validationRuns: quality.validationRuns,
      qualityIssues: quality.issues,
      criticScore: critic?.score,
    });
    onLog?.(
      "stdout",
      `[JobRunner] Rollout score: score=${rolloutScore.score} reasons=${rolloutScore.reasons.join(",") || "none"}`,
    );
    const advisoryRelaxedQualityIssues = relaxAdvisoryQualityIssues(
      quality.issues,
      quality.validationRuns,
      critic,
      qualityCriticMinScore,
    );
    let effectiveQualityIssues = advisoryRelaxedQualityIssues;
    if (validationOutsideTaskScopeBlocksOnly) {
      effectiveQualityIssues = effectiveQualityIssues.filter(
        (issue) => !issue.startsWith("ValidationGate:"),
      );
      if (effectiveQualityIssues.length !== quality.issues.length) {
        onLog?.(
          "stderr",
          "[ValidationGate] Validation failures are outside the task scope; they will block publishing but will not drive another code revision.",
        );
      }
    }
    if (
      !validationOutsideTaskScope &&
      advisoryRelaxedQualityIssues.length !== quality.issues.length
    ) {
      onLog?.(
        "stdout",
        "[QualityGate] Assertion-balance heuristic downgraded to advisory because validation passed and critic score met threshold.",
      );
    }
    const deterministicRequiresRevision =
      effectiveQualityIssues.length > 0 ||
      (quality.blocker !== null && !validationOutsideTaskScopeBlocksOnly);
    const criticRequiresRevision = Boolean(critic && critic.score < qualityCriticMinScore);
    if (
      !qualityGatePolicy.publishGateEnabled &&
      (deterministicRequiresRevision || criticRequiresRevision)
    ) {
      onLog?.(
        "stderr",
        "[PublishGate] Disabled by workerpals.quality_publish_gate_enabled=false; returning worker result despite gate failures.",
      );
      const advisoryResult: JobResult = {
        ...result,
        summary: `${result.summary} (publish gate disabled; quality gate findings were advisory)`,
        stderr: truncate(
          [
            result.stderr ?? "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
            critic ? `Critic raw: ${critic.raw}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        ),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      };
      return annotateTerminalResult(advisoryResult, "quality");
    }

    if (!deterministicRequiresRevision && !criticRequiresRevision) {
      if (quality.requiredValidationFailures.length > 0) {
        const requiredSummary = `Required vision.md validation blocked publishing: ${quality.requiredValidationFailures.join("; ")}`;
        const diagnostics = truncate(
          [
            result.stderr ?? "",
            validationOutsideTaskScope
              ? "Validation failures appear outside the task target/relevance hints and are treated as pre-existing repo blockers."
              : "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          ]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        );
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure: JobResult = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: diagnostics,
          exitCode: 4,
        };
        return annotateTerminalResult(failure, "validation");
      }
      if (critic) {
        onLog?.(
          "stdout",
          `[CriticGate] review score ${critic.score.toFixed(1)}/10 (threshold ${qualityCriticMinScore}).`,
        );
      }
      return annotateTerminalResult(result, "completed");
    }

    const blockerIssue = quality.blocker
      ? [
          `Validation blocker (${quality.blocker.category}): ${toSingleLine(
            quality.blocker.detail,
            240,
          )}`,
        ]
      : [];
    const issues = buildQualityGateRevisionIssues(
      [...effectiveQualityIssues, ...blockerIssue],
      critic,
      qualityCriticMinScore,
    );
    const activeMaxAutoRevisions = revisionLimitForQualityGateFailures({
      policy: qualityGatePolicy,
      qualityIssues: effectiveQualityIssues,
      requiredValidationFailures: validationOutsideTaskScopeBlocksOnly
        ? []
        : quality.requiredValidationFailures,
      blocker: validationOutsideTaskScopeBlocksOnly ? null : quality.blocker,
      browserRepairPacket:
        validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode
          ? null
          : browserRepairPacket,
    });
    const issueSummary =
      browserRepairPacket && !validationOutsideTaskScopeBlocksOnly && !repoValidationRepairMode
        ? `ValidationGate browser ${browserRepairPacket.failureKind} repair for ${browserRepairPacket.command}: ${toSingleLine(
            browserRepairPacket.digest,
            180,
          )}`
        : issues.map((entry) => toSingleLine(entry, 180)).join(" | ");
    if (quality.blocker && !validationOutsideTaskScopeBlocksOnly) {
      const blockerSummary = `Quality gate blocked by ${quality.blocker.category} issue: ${quality.blocker.detail}`;
      const blockerDiagnostics = truncate(
        [
          result.stderr ?? "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
        ].join("\n"),
        outputPolicyForRuntime(runtimeConfig),
      );
      const requiredValidationCanRevise = shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: quality.requiredValidationFailures,
        blocker: quality.blocker,
        revisionAttempt,
        maxAutoRevisions: activeMaxAutoRevisions,
        outsideTaskScope: validationOutsideTaskScope,
        allowOutsideTaskScope: repoValidationRepairMode,
      });
      if (requiredValidationCanRevise) {
        onLog?.(
          "stderr",
          `[QualityGate] Required vision.md validation hit a repo blocker; requesting revision ${
            revisionAttempt + 1
          }/${activeMaxAutoRevisions} instead of failing immediately: ${quality.requiredValidationFailures.join(
            "; ",
          )}`,
        );
      } else if (quality.requiredValidationFailures.length > 0) {
        const requiredSummary = `Required vision.md validation blocked publishing: ${quality.requiredValidationFailures.join("; ")}`;
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure: JobResult = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: blockerDiagnostics,
          exitCode: 4,
        };
        return annotateTerminalResult(failure, "validation");
      } else if (shouldSoftPassValidationBlocker(qualityGatePolicy, quality.blocker)) {
        onLog?.(
          "stderr",
          `[QualityGate] Soft-pass on ${quality.blocker.category} blocker for publishable ${qualityGatePolicy.mode} job: ${toSingleLine(
            quality.blocker.detail,
            260,
          )}`,
        );
        const softPass: JobResult = {
          ...result,
          summary:
            `${result.summary} ` +
            `(quality gate soft-pass on ${quality.blocker.category} blocker after publishable ${qualityGatePolicy.mode} update)`,
          stderr: blockerDiagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
        return annotateTerminalResult(softPass, "quality");
      } else {
        onLog?.("stderr", `[QualityGate] ${blockerSummary}`);
        const failure: JobResult = {
          ok: false,
          summary: blockerSummary,
          stdout: result.stdout,
          stderr: blockerDiagnostics,
          exitCode: 4,
        };
        return annotateTerminalResult(failure, "quality");
      }
    }
    if (revisionAttempt >= activeMaxAutoRevisions) {
      if (quality.requiredValidationFailures.length > 0) {
        const diagnostics = truncate(
          [
            result.stderr ?? "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
            critic ? `Critic raw: ${critic.raw}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        );
        const requiredSummary = `Required vision.md validation failed after ${revisionAttempt} auto-revision attempt(s): ${quality.requiredValidationFailures.join("; ")}`;
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure: JobResult = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: diagnostics,
          exitCode: 4,
        };
        return annotateTerminalResult(failure, "validation");
      }
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
        const softPass: JobResult = {
          ...result,
          summary: `${result.summary} (quality gate soft-pass after ${revisionAttempt} auto-revision attempt(s))`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
        return annotateTerminalResult(softPass, "quality");
      }
      const failure: JobResult = {
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
      return annotateTerminalResult(failure, "quality");
    }

    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: Date.now() - jobStartedAt,
      executionBudgetMs,
    });
    const browserValidationContinuation = browserValidationRepairContinuationBudgetDecision({
      browserRepairPacket:
        validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode
          ? null
          : browserRepairPacket,
      validationOutsideTaskScope,
      changedPaths: quality.changedPaths,
      revisionBudget,
    });
    const repoValidationContinuation = repoValidationRepairContinuationBudgetDecision({
      repoValidationRepairMode,
      changedPaths: quality.changedPaths,
      revisionBudget,
    });
    const inScopeValidationContinuation = inScopeValidationRepairContinuationBudgetDecision({
      requiredValidationFailures:
        validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode
          ? []
          : quality.requiredValidationFailures,
      validationOutsideTaskScope,
      changedPaths: quality.changedPaths,
      revisionBudget,
    });
    if (
      !revisionBudget.shouldStart &&
      !browserValidationContinuation.shouldContinue &&
      !repoValidationContinuation.shouldContinue &&
      !inScopeValidationContinuation.shouldContinue
    ) {
      if (
        shouldSoftPassCriticOnlyBudgetExhaustion({
          softPassOnExhausted: qualitySoftPassOnExhausted,
          deterministicRequiresRevision,
          criticRequiresRevision,
          requiredValidationFailures: quality.requiredValidationFailures,
          changedPaths: quality.changedPaths,
        })
      ) {
        const diagnostics = truncate(
          [
            result.stderr ?? "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
            critic ? `Critic raw: ${critic.raw}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        );
        onLog?.(
          "stderr",
          `[QualityGate] Soft-pass critic-only revision after validation passed but remaining execution budget ${
            revisionBudget.remainingBudgetMs
          }ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(
            issueSummary,
            260,
          )}`,
        );
        const softPass: JobResult = {
          ...result,
          summary:
            `${result.summary} ` +
            `(quality gate soft-pass after critic-only budget exhaustion with validation passing)`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
        return annotateTerminalResult(softPass, "quality");
      }
      const budgetSummary = `Quality gate needs revision ${
        revisionAttempt + 1
      }/${activeMaxAutoRevisions}, but remaining execution budget is ${
        revisionBudget.remainingBudgetMs
      }ms (< ${revisionBudget.minimumRevisionBudgetMs}ms); stopping before another worker turn to preserve a structured result: ${toSingleLine(
        issueSummary,
        220,
      )}`;
      onLog?.("stderr", `[QualityGate] ${budgetSummary}`);
      const failure: JobResult = {
        ok: false,
        summary: budgetSummary,
        stdout: result.stdout,
        stderr: truncate(
          [
            result.stderr ?? "",
            ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
            critic ? `Critic raw: ${critic.raw}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          outputPolicyForRuntime(runtimeConfig),
        ),
        exitCode: 4,
      };
      return annotateTerminalResult(failure, "quality");
    }
    if (!revisionBudget.shouldStart && browserValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: browserValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: browserValidationContinuation.finalizationBudgetMs,
      };
      onLog?.(
        "stderr",
        `[QualityGate] Continuing browser validation repair ${
          revisionAttempt + 1
        }/${activeMaxAutoRevisions} with dedicated budget ${
          browserValidationContinuation.executionBudgetMs
        }ms execution + ${
          browserValidationContinuation.finalizationBudgetMs
        }ms finalization after original remaining budget ${
          revisionBudget.remainingBudgetMs
        }ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(
          issueSummary,
          220,
        )}`,
      );
    } else if (!revisionBudget.shouldStart && repoValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: repoValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: repoValidationContinuation.finalizationBudgetMs,
      };
      onLog?.(
        "stderr",
        `[QualityGate] Continuing repo validation repair ${
          revisionAttempt + 1
        }/${activeMaxAutoRevisions} with dedicated budget ${
          repoValidationContinuation.executionBudgetMs
        }ms execution + ${
          repoValidationContinuation.finalizationBudgetMs
        }ms finalization after original remaining budget ${
          revisionBudget.remainingBudgetMs
        }ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(
          issueSummary,
          220,
        )}`,
      );
    } else if (!revisionBudget.shouldStart && inScopeValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: inScopeValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: inScopeValidationContinuation.finalizationBudgetMs,
      };
      onLog?.(
        "stderr",
        `[QualityGate] Continuing in-scope validation repair ${
          revisionAttempt + 1
        }/${activeMaxAutoRevisions} with dedicated budget ${
          inScopeValidationContinuation.executionBudgetMs
        }ms execution + ${
          inScopeValidationContinuation.finalizationBudgetMs
        }ms finalization after original remaining budget ${
          revisionBudget.remainingBudgetMs
        }ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(
          issueSummary,
          220,
        )}`,
      );
    }

    revisionAttempt += 1;
    revisionHint = buildQualityRevisionHint(
      issues,
      critic,
      planning,
      reviewFixContext,
      validationOutsideTaskScopeBlocksOnly ? [] : quality.validationRuns,
      validationOutsideTaskScopeBlocksOnly ? null : quality.blocker,
      validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode ? null : browserRepairPacket,
      quality.changedPaths,
      validationRemedyHints,
      repoValidationRepairMode,
    );
    onLog?.(
      "stderr",
      `[QualityGate] Quality gate requested revision ${revisionAttempt}/${activeMaxAutoRevisions}: ${toSingleLine(
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
