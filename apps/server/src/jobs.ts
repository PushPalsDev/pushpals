import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  classifyToolFailure,
  inferToolNameFromFailureText,
  isWorkerOwnedRuntimeStackFrame,
  normalizeToolName,
  redactToolText,
  resolveToolKind,
  truncateToolText,
  type ToolEffect,
  type ToolFailureClass,
  type ToolKind,
  type ToolRunRecord,
} from "shared";

export type JobStatus =
  | "pending"
  | "claimed"
  | "finalizing"
  | "completed"
  | "failed"
  | "abandoned"
  | "publish_blocked";
export type WorkerStatus = "idle" | "busy" | "error" | "offline";
export type JobPriority = "interactive" | "normal" | "background";
export type JobRetrySafety = "retry_safe" | "manual_retry_required";
type JobRecoveryReason =
  | "worker_heartbeat_mismatch"
  | "stale_worker_claim"
  | "worker_runtime_canary_lease_expired";

const JOB_PRIORITY_ORDER: JobPriority[] = ["interactive", "normal", "background"];
const JOB_PRIORITY_QUEUE_SLA_MS: Record<JobPriority, number> = {
  interactive: 20_000,
  normal: 90_000,
  background: 240_000,
};
const JOB_EXECUTION_BUDGET_MS: Record<JobPriority, number> = {
  interactive: 300_000,
  normal: 900_000,
  background: 1_200_000,
};
const JOB_FINALIZATION_BUDGET_MS_DEFAULT = 120_000;
const PR_WORKER_ASSIGNMENT_MAX_AGE_MS = 120_000;
const ORPHANED_CLAIM_HEARTBEAT_GRACE_MS = 15_000;
const RETRY_SAFE_REQUEUE_DELAY_MS = 5_000;
const WORKER_RUNTIME_CANARY_LEASE_MS_DEFAULT = 45_000;
const WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT = 30_000;
const WORKER_RUNTIME_DEFERRAL_LOG_DEDUPE_MS = 5 * 60_000;
const WORKER_RUNTIME_DEFERRAL_LOG_RETAIN = 8;
const DEFAULT_WORKER_RUNTIME_GENERATION = "default";
export const MAX_JOB_WORKER_ID_LENGTH = 128;

export interface JobRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  dedupeKey: string | null;
  dedupeCooldownMs: number;
  priority: JobPriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  status: JobStatus;
  workerId: string | null;
  targetWorkerId: string | null;
  deferredByWorkerId: string | null;
  runtimeGeneration: string | null;
  claimGeneration: number;
  result: string | null;
  prUrl: string | null;
  error: string | null;
  availableAt: string | null;
  deferReason: string | null;
  deferredAt: string | null;
  enqueuedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  firstLogAt: string | null;
  lastActivityAt: string | null;
  failedAt: string | null;
  abandonedAt: string | null;
  publishBlockedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  resumeOfJobId: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedPrLinkRow {
  cursor: number;
  jobId: string;
  sessionId: string;
  prUrl: string;
  updatedAt: string;
}

export interface JobClaimAuthority {
  workerId: string;
  claimGeneration: number;
}

export const JOB_DEFERRAL_CONFLICT_CODE = "job_deferral_conflict" as const;
export const JOB_DEFERRAL_PERSISTENCE_FAILED_CODE = "job_deferral_persistence_failed" as const;
export type JobDeferralResultCode =
  | typeof JOB_DEFERRAL_CONFLICT_CODE
  | typeof JOB_DEFERRAL_PERSISTENCE_FAILED_CODE;

export function normalizeJobWorkerId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const workerId = value.trim();
  if (!workerId || workerId.length > MAX_JOB_WORKER_ID_LENGTH) return null;
  return workerId;
}

export function repointDurableRecoveryLinks(
  db: Database,
  previousJobId: string,
  replacementJobId: string,
  now: string,
): void {
  const requestColumns = db.prepare(`PRAGMA table_info(requests)`).all() as Array<{
    name: string;
  }>;
  const names = new Set(requestColumns.map((column) => column.name));
  if (names.has("handoffJobId")) {
    const durablePredicate = names.has("workerRequired") ? " AND workerRequired = 1" : "";
    if (names.has("updatedAt")) {
      db.prepare(
        `UPDATE requests
         SET handoffJobId = ?, updatedAt = ?
         WHERE handoffJobId = ?${durablePredicate}`,
      ).run(replacementJobId, now, previousJobId);
    } else {
      db.prepare(
        `UPDATE requests
         SET handoffJobId = ?
         WHERE handoffJobId = ?${durablePredicate}`,
      ).run(replacementJobId, previousJobId);
    }
  }

  const objectiveColumns = db.prepare(`PRAGMA table_info(autonomy_objectives)`).all() as Array<{
    name: string;
  }>;
  const objectiveNames = new Set(objectiveColumns.map((column) => column.name));
  if (
    objectiveNames.has("job_id") &&
    objectiveNames.has("status") &&
    objectiveNames.has("updated_at")
  ) {
    db.prepare(
      `UPDATE autonomy_objectives
       SET job_id = ?, updated_at = ?
       WHERE job_id = ?
         AND status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`,
    ).run(replacementJobId, now, previousJobId);
  }
}

export interface JobLogRow {
  id: number;
  jobId: string;
  ts: string;
  message: string;
}

export interface NoPublishableFailureCircuitSummary {
  blocked: boolean;
  windowMs: number;
  threshold: number;
  failureRateThreshold: number;
  terminalCount: number;
  noPublishableFailureCount: number;
  noPublishableFailureRate: number;
  completedCount: number;
  lastFailureAt: string | null;
}

export interface WorkerRuntimeFailureCircuitSummary {
  blocked: boolean;
  phase: "closed" | "open" | "half_open";
  runtimeGeneration: string;
  windowMs: number;
  blockDurationMs: number;
  threshold: number;
  qualifyingFailureCount: number;
  recentMatchingFailureCount: number;
  fingerprint: string | null;
  failureClass: string | null;
  executorBackend: string | null;
  signatureSample: string | null;
  lastFailureAt: string | null;
  retryAt: string | null;
  canaryJobId: string | null;
  canaryWorkerId: string | null;
  canaryLeaseExpiresAt: string | null;
}

export interface WorkerRuntimeCanaryDecision {
  allowed: boolean;
  canary: boolean;
  summary: WorkerRuntimeFailureCircuitSummary;
  reason?: "circuit_open" | "canary_in_flight" | "canary_lease_expired";
}

export interface WorkerRuntimeCanaryRecovery {
  circuitRecovered: boolean;
  recoveredJob: RecoveredStaleJob | null;
  runtimeGeneration: string | null;
  jobId: string | null;
  retryAt: string | null;
}

interface WorkerRuntimeCircuitRow {
  runtimeGeneration: string;
  state: "closed" | "open" | "half_open";
  fingerprint: string | null;
  failureClass: string | null;
  executorBackend: string | null;
  signatureSample: string | null;
  openedAt: string | null;
  retryAt: string | null;
  lastFailureAt: string | null;
  recoveredAt: string | null;
  canaryJobId: string | null;
  canaryWorkerId: string | null;
  canaryClaimedAt: string | null;
  canaryLeaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SimilarNoPublishableFailureSummary {
  blocked: boolean;
  windowMs: number;
  threshold: number;
  recentSimilarFailureCount: number;
  patternKey: string | null;
  targetPathSample: string[];
  lastFailureAt: string | null;
}

export interface SimilarFailureFingerprintSummary {
  blocked: boolean;
  windowMs: number;
  threshold: number;
  recentSimilarFailureCount: number;
  fingerprint: string | null;
  targetPathSample: string[];
  failureClass: string | null;
  command: string | null;
  failedTestSample: string[];
  lastFailureAt: string | null;
}

interface ToolRunDbRow {
  id: string;
  jobId: string | null;
  workerId: string | null;
  sessionId: string | null;
  phase: string | null;
  tool: string;
  kind: ToolKind;
  capability: string | null;
  envProfile: string | null;
  cwd: string | null;
  argvJson: string;
  commandLine: string | null;
  allowedEffectsJson: string;
  ok: number;
  exitCode: number | null;
  failureClass: ToolFailureClass | null;
  retryable: number;
  remediation: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutTail: string | null;
  stderrTail: string | null;
  metadataJson: string;
  createdAt: string;
}

interface WorkerDbRow {
  workerId: string;
  status: WorkerStatus;
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: string | null;
  details: string | null;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
}

interface ClaimedJobActivityRow {
  jobId: string;
  taskId: string;
  sessionId: string;
  updatedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  firstLogAt: string | null;
  lastLogTs: string | null;
  activityAt: string;
}

export interface WorkerRow {
  workerId: string;
  status: WorkerStatus;
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: Record<string, unknown>;
  details: Record<string, unknown>;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
  isOnline: boolean;
}

export interface RecoveredStaleJob {
  jobId: string;
  taskId: string;
  sessionId: string;
  workerId: string | null;
  message: string;
  detail: string;
  action: "failed" | "requeued";
  finalStatus: "failed" | "abandoned";
  retrySafety: JobRetrySafety;
  replacementJobId?: string;
  replacementAvailableAt?: string | null;
  recoveredAt: string;
}

export interface WorkerHeartbeatResult {
  ok: boolean;
  message?: string;
  recoveredJobs?: RecoveredStaleJob[];
}

export interface JobSloMetricSummary {
  p50: number | null;
  p95: number | null;
  avg: number | null;
  sampleSize: number;
}

export interface JobSloSummary {
  windowHours: number;
  terminal: number;
  completed: number;
  failed: number;
  abandoned: number;
  publishBlocked: number;
  timeoutFailures: number;
  successRate: number | null;
  timeoutRate: number | null;
  durationMs: JobSloMetricSummary;
  queueWaitMs: JobSloMetricSummary;
}

export type WorkerPrMergeState = "open_unmerged" | "merged" | "closed_unmerged";

export interface WorkerPrBacklogEntry {
  prUrl: string;
  normalizedPrUrl: string;
  latestJobId: string;
  latestJobStatus: JobStatus;
  latestJobAt: string;
  latestFeedbackVerdict: string | null;
  latestFeedbackAt: string | null;
  mergeState: WorkerPrMergeState;
}

function parseObjectJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseStringArrayJson(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseToolEffectsJson(value: string | null): ToolEffect[] {
  const allowed = new Set<ToolEffect>(["read", "write", "network", "git", "process"]);
  return parseStringArrayJson(value).filter((entry): entry is ToolEffect =>
    allowed.has(entry as ToolEffect),
  );
}

const TOOL_FAILURE_CLASSES: ToolFailureClass[] = [
  "missing_binary",
  "missing_runtime",
  "auth",
  "network",
  "permission",
  "policy_denied",
  "timeout",
  "worker_runtime_failure",
  "nonzero_exit",
  "repo_state",
  "sandbox_mount",
  "unknown",
];

function normalizeToolFailureClass(value: unknown): ToolFailureClass | null {
  const text = String(value ?? "").trim();
  return TOOL_FAILURE_CLASSES.includes(text as ToolFailureClass)
    ? (text as ToolFailureClass)
    : null;
}

function shouldAcceptClientToolFailureClass(
  serverClass: ToolFailureClass | null | undefined,
  clientClass: ToolFailureClass | null,
): boolean {
  if (!clientClass) return false;
  return !serverClass || serverClass === "unknown" || serverClass === "nonzero_exit";
}

function compactDbText(value: unknown, maxChars: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function boolFromUnknown(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function sanitizeToolRunMetadata(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === "string") return compactDbText(redactToolText(value), 1000) ?? "";
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeToolRunMetadata(entry, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 100)) {
    const key = compactDbText(rawKey, 120);
    if (!key) continue;
    out[key] = sanitizeToolRunMetadata(rawValue, depth + 1);
  }
  return out;
}

const MAX_JOB_DIAGNOSTIC_ATTEMPTS = 8;
const MAX_JOB_DIAGNOSTIC_PHASE_SPANS = 32;
const MAX_JOB_DIAGNOSTIC_VALIDATION_RUNS = 20;
const MAX_JOB_DIAGNOSTIC_PATCH_SNAPSHOTS = 20;
const MAX_JOB_DIAGNOSTIC_PATH_SAMPLE = 50;

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedDbInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}

function diagnosticText(value: unknown, maxChars: number): string | null {
  return compactDbText(redactToolText(value), maxChars);
}

function diagnosticMetadataJson(value: unknown): string {
  const sanitized = sanitizeToolRunMetadata(value ?? {});
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return "{}";
  return JSON.stringify(sanitized);
}

function diagnosticStringArrayJson(value: unknown, limit = MAX_JOB_DIAGNOSTIC_PATH_SAMPLE): string {
  const values = arrayFromUnknown(value)
    .map((entry) => diagnosticText(entry, 240))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, limit);
  return JSON.stringify(values);
}

function diagnosticIso(value: unknown): string | null {
  return coerceIsoTimestamp(value);
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0);
}

function normalizedJobPath(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function normalizedJobPathList(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of stringArrayFromUnknown(value)) {
    const normalized = normalizedJobPath(entry);
    if (!normalized || normalized === "." || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizedJobPathValues(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const path of normalizedJobPathList(value)) out.add(path);
      continue;
    }
    const path = normalizedJobPath(value);
    if (path && path !== ".") out.add(path);
  }
  return [...out];
}

function jobPathOverlaps(left: string[], right: string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

function overlappingFailureTargetPaths(currentPaths: string[], previousPaths: string[]): string[] {
  const overlapping = new Set<string>();
  for (const current of currentPaths) {
    for (const previous of previousPaths) {
      if (
        current === previous ||
        current.startsWith(`${previous}/`) ||
        previous.startsWith(`${current}/`)
      ) {
        overlapping.add(current.length >= previous.length ? current : previous);
      }
    }
  }
  return [...overlapping].sort();
}

function normalizeFailureCommand(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, 1000);
}

function jobFailureText(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return [parsed.message, parsed.detail, parsed.error]
      .map((part) => String(part ?? ""))
      .filter(Boolean)
      .join("\n");
  } catch {
    return raw;
  }
}

const WORKER_RUNTIME_CIRCUIT_FAILURE_CLASSES = new Set([
  "worker_runtime_failure",
  "missing_runtime_asset",
  "no_structured_result",
  "malformed_structured_result",
]);

function normalizeWorkerRuntimeFailureEvidence(value: unknown): string {
  return jobFailureText(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\\/g, "/")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gi, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "<hash>")
    .replace(/\/\.worktrees\/[^/\s:)]+/gi, "/.worktrees/<worktree>")
    .replace(/\b(job|request|task)(?:Id)?[=: ]+[a-z0-9_-]{8,}\b/gi, "$1=<id>")
    .replace(
      /\b(?:elapsed|duration|uptime|timeout|limit)(?:_ms)?[=: ]+\d+(?:\.\d+)?(?:\s*(?:ms|s))?\b/gi,
      (match) => match.replace(/\d+(?:\.\d+)?(?:\s*(?:ms|s))?/i, "<duration>"),
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|s)\b/gi, "<duration>")
    .replace(/\bpid[=: ]+\d+\b/gi, "pid=<pid>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function workerRuntimeFailureSignature(
  failureClassValue: unknown,
  errorValue: unknown,
  summaryValue: unknown,
  terminalStageValue: unknown,
): { fingerprint: string; signature: string; failureClass: string } | null {
  const failureClass = String(failureClassValue ?? "")
    .trim()
    .toLowerCase();

  const rawEvidence = [jobFailureText(errorValue), String(summaryValue ?? "")]
    .filter(Boolean)
    .join("\n")
    .replace(/\\/g, "/");
  const exceptionMatch =
    /\b(?:ReferenceError|TypeError|SyntaxError|RangeError|URIError|EvalError|AggregateError|Error):[^\r\n]{1,500}/i.exec(
      rawEvidence,
    );
  const exception = exceptionMatch?.[0];
  const firstFrameLine = exceptionMatch
    ? rawEvidence
        .slice((exceptionMatch.index ?? 0) + exceptionMatch[0].length)
        .split(/\r?\n/)
        .find((line) => /^\s*at\b/i.test(line))
    : undefined;
  const normalizedFirstFrame = String(firstFrameLine ?? "").replace(/\\/g, "/");
  const sourceWorkerFrame = normalizedFirstFrame.match(
    /(?:file:\/\/)?(?:[^\s():]+\/)?(apps\/workerpals\/src\/[^\s():]+):\d+:\d+/i,
  );
  const packagedWorkerFrame = normalizedFirstFrame.match(
    /(?:\.pushpals\/runtime\/sandbox\/)?(\.pushpals-workerpals-runtime\.js):\d+:\d+/i,
  );
  const workerFramePath = sourceWorkerFrame?.[1] ?? packagedWorkerFrame?.[1];
  const hasStrongInternalStackEvidence = Boolean(
    exception && workerFramePath && isWorkerOwnedRuntimeStackFrame(firstFrameLine),
  );
  const hasStructuredWorkerRuntimeEvidence =
    String(terminalStageValue ?? "")
      .trim()
      .toLowerCase() === "worker_runtime" &&
    (failureClass === "worker_runtime_failure" || failureClass === "missing_runtime_asset");
  if (
    !hasStrongInternalStackEvidence &&
    !hasStructuredWorkerRuntimeEvidence &&
    (!WORKER_RUNTIME_CIRCUIT_FAILURE_CLASSES.has(failureClass) ||
      failureClass === "worker_runtime_failure")
  ) {
    return null;
  }

  let signature = "";
  if (hasStrongInternalStackEvidence && exception && workerFramePath) {
    signature = `${normalizeWorkerRuntimeFailureEvidence(exception)} at ${workerFramePath.toLowerCase()}`;
  } else {
    const normalized = normalizeWorkerRuntimeFailureEvidence(rawEvidence);
    if (!normalized) return null;
    signature = `${failureClass}: ${normalized.slice(0, 1_200)}`;
  }

  return {
    fingerprint: createHash("sha256").update(signature).digest("hex").slice(0, 24),
    signature: signature.slice(0, 500),
    failureClass: hasStrongInternalStackEvidence ? "worker_runtime_failure" : failureClass,
  };
}

export function resolveWorkerRuntimeCircuitRetryAfterMs(
  summary: Pick<WorkerRuntimeFailureCircuitSummary, "blockDurationMs" | "lastFailureAt"> &
    Partial<Pick<WorkerRuntimeFailureCircuitSummary, "phase" | "retryAt" | "canaryLeaseExpiresAt">>,
  options?: { nowMs?: number; maxRetryAfterMs?: number; minRetryAfterMs?: number },
): number {
  const maxRetryAfterMs = Math.max(1_000, Math.floor(options?.maxRetryAfterMs ?? 30 * 60 * 1000));
  const minRetryAfterMs = Math.max(
    1_000,
    Math.min(maxRetryAfterMs, Math.floor(options?.minRetryAfterMs ?? 1_000)),
  );
  const nowMs = Number.isFinite(options?.nowMs) ? Number(options?.nowMs) : Date.now();
  const canaryLeaseExpiresAtMs = Date.parse(String(summary.canaryLeaseExpiresAt ?? ""));
  if (summary.phase === "half_open" && Number.isFinite(canaryLeaseExpiresAtMs)) {
    return Math.max(
      minRetryAfterMs,
      Math.min(maxRetryAfterMs, Math.floor(canaryLeaseExpiresAtMs - nowMs)),
    );
  }
  const retryAtMs = Date.parse(String(summary.retryAt ?? ""));
  if (Number.isFinite(retryAtMs)) {
    return Math.max(minRetryAfterMs, Math.min(maxRetryAfterMs, Math.floor(retryAtMs - nowMs)));
  }
  const lastFailureAtMs = Date.parse(String(summary.lastFailureAt ?? ""));
  if (!Number.isFinite(lastFailureAtMs)) return maxRetryAfterMs;
  const remainingBlockMs = lastFailureAtMs + summary.blockDurationMs - nowMs;
  return Math.max(minRetryAfterMs, Math.min(maxRetryAfterMs, Math.floor(remainingBlockMs)));
}

function nestedFailureCommand(value: unknown): string {
  const text = jobFailureText(value);
  const scriptMatches = [
    ...text.matchAll(/error:\s*script\s+"([^"]+)"\s+(?:exited|was terminated)/gi),
  ];
  const nestedScript = scriptMatches.at(-1)?.[1]?.trim();
  if (nestedScript) return normalizeFailureCommand(`bun run ${nestedScript}`);
  const unchanged = text.match(
    /validation failed unchanged after two attempts for "([^"]+)"/i,
  )?.[1];
  if (unchanged) return normalizeFailureCommand(unchanged);
  const required = text.match(
    /required vision\.md validation (?:failed|blocked publishing)[^:\r\n]*:\s*([^\r\n;]+?)(?:\s+exited\b|;|$)/i,
  )?.[1];
  return normalizeFailureCommand(required);
}

function failureClassFromEvidence(value: unknown): string | null {
  const text = jobFailureText(value).toLowerCase();
  if (!text) return null;
  if (
    /\/var\/run\/docker\.sock|docker daemon|operation not permitted|permission denied|read-only file system|\beacces\b|\beperm\b/.test(
      text,
    )
  ) {
    return "environment";
  }
  return null;
}

function nestedFailedTestSample(value: unknown): string[] {
  const text = jobFailureText(value);
  const samples = new Set<string>();
  for (const match of text.matchAll(/error:\s*script\s+"([^"]+)"\s+(?:exited|was terminated)/gi)) {
    const script = String(match[1] ?? "")
      .trim()
      .toLowerCase();
    if (script) samples.add(`script:${script}`);
  }
  return [...samples].sort();
}

function extractFailedTestSample(...values: unknown[]): string[] {
  const text = values.map((value) => String(value ?? "")).join("\n");
  const samples = new Set<string>();
  for (const match of text.matchAll(
    /(?:\(fail\)|\bfail(?:ed)?\b|[×✗])\s*[:>-]?\s*([^\r\n]{3,240})/gi,
  )) {
    const normalized = String(match[1] ?? "")
      .replace(/\s+\[[\d.]+\s*(?:ms|s)\]\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (normalized) samples.add(normalized);
    if (samples.size >= 8) break;
  }
  if (samples.size < 8) {
    for (const match of text.matchAll(
      /(?:^|[\s("'`])([a-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=$|[\s:)"'`])/gim,
    )) {
      samples.add(
        String(match[1] ?? "")
          .replace(/\\/g, "/")
          .toLowerCase(),
      );
      if (samples.size >= 8) break;
    }
  }
  return [...samples].sort();
}

function failureFingerprint(parts: {
  targetPaths: string[];
  failureClass: string;
  command: string;
  failedTests: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetPaths: [...parts.targetPaths].sort(),
        failureClass: parts.failureClass,
        command: parts.command,
        failedTests: parts.failedTests,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function normalizeWorkerStatus(value: unknown): WorkerStatus {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "busy" || text === "error" || text === "offline") {
    return text;
  }
  return "idle";
}

function normalizeJobPriority(value: unknown): JobPriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
}

function parseBudgetMs(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1_000, parsed);
}

function parseDedupeCooldownMs(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.min(parsed, 24 * 60 * 60 * 1000));
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeWorkerRuntimeGeneration(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return normalized || DEFAULT_WORKER_RUNTIME_GENERATION;
}

function coerceIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

class JobClaimAuthorityError extends Error {
  constructor() {
    super("Job not found, not claimed, or claim ownership changed");
    this.name = "JobClaimAuthorityError";
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const value = sorted[rank];
  return Number.isFinite(value) ? value : null;
}

function summarizeSamples(samples: number[]): JobSloMetricSummary {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) return { p50: null, p95: null, avg: null, sampleSize: 0 };
  const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  return {
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    avg: Number.isFinite(avg) ? avg : null,
    sampleSize: valid.length,
  };
}

function isTimeoutFailureError(errorPayload: string | null): boolean {
  if (!errorPayload) return false;
  let haystack = errorPayload;
  try {
    const parsed = JSON.parse(errorPayload) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      haystack =
        `${String(record.message ?? "")} ${String(record.detail ?? "")}`.trim() || errorPayload;
    }
  } catch {
    // Keep raw payload fallback.
  }
  return /\b(timeout|timed out|deadline exceeded|stale worker claim|heartbeat stale|watchdog)\b/i.test(
    haystack,
  );
}

function parseJobParamsRecord(value: string | null): Record<string, unknown> {
  return parseObjectJson(value);
}

function extractResolutionType(params: Record<string, unknown>): string | null {
  const direct = params.resolutionType;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const reviewAgent = params.reviewAgent;
  if (reviewAgent && typeof reviewAgent === "object" && !Array.isArray(reviewAgent)) {
    const nested = (reviewAgent as Record<string, unknown>).resolutionType;
    if (typeof nested === "string" && nested.trim()) return nested.trim().toLowerCase();
  }
  return null;
}

function classifyJobRetrySafety(
  kind: string,
  params: Record<string, unknown>,
): { retrySafety: JobRetrySafety; reason: string } {
  const explicit = String(params.retrySafety ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "retry_safe" || explicit === "retry-safe" || explicit === "safe") {
    return {
      retrySafety: "retry_safe",
      reason: "params.retrySafety explicitly marked this job retry-safe",
    };
  }
  if (
    explicit === "manual_retry_required" ||
    explicit === "manual-retry-required" ||
    explicit === "unsafe" ||
    explicit === "non_idempotent"
  ) {
    return {
      retrySafety: "manual_retry_required",
      reason: "params.retrySafety explicitly marked this job non-idempotent",
    };
  }
  if (kind === "warmup.execute") {
    return {
      retrySafety: "retry_safe",
      reason: "warmup.execute is side-effect free and safe to restart from scratch",
    };
  }
  if (kind === "task.execute") {
    const resolutionType = extractResolutionType(params);
    if (resolutionType === "merge_conflict") {
      return {
        retrySafety: "manual_retry_required",
        reason: "merge_conflict task.execute may rewrite rebase or branch state before abandonment",
      };
    }
    if (resolutionType === "review_fix") {
      return {
        retrySafety: "manual_retry_required",
        reason: "review_fix task.execute may create follow-up commit or PR side effects",
      };
    }
    return {
      retrySafety: "manual_retry_required",
      reason:
        "task.execute may mutate repository or publish side effects and is not auto-requeue safe",
    };
  }
  return {
    retrySafety: "manual_retry_required",
    reason: `${kind || "unknown"} is not classified as retry-safe`,
  };
}

function buildResumeParams(
  params: Record<string, unknown>,
  recovery: {
    previousJobId: string;
    previousWorkerId: string | null;
    recoveredAt: string;
    reason: JobRecoveryReason;
    detail: string;
    retrySafety: JobRetrySafety;
    classificationReason: string;
    attempt: number;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const rawHistory = Array.isArray(next.resumeHistory) ? next.resumeHistory : [];
  const history = rawHistory
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .slice(-7) as Record<string, unknown>[];
  history.push({
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt,
  });
  next.resume = {
    strategy: "restart_after_abandonment",
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt,
  };
  next.resumeHistory = history;
  return next;
}

function extractPlanningField(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const planning = (params as Record<string, unknown>).planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning)) return undefined;
  return (planning as Record<string, unknown>)[key];
}

function normalizeDedupeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return key.slice(0, 512);
}

function normalizePrUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

function normalizePrFeedbackVerdict(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isMergedPrFeedbackVerdict(value: unknown): boolean {
  const verdict = normalizePrFeedbackVerdict(value);
  return verdict === "approved_merged" || verdict === "merged";
}

function isClosedPrFeedbackVerdict(value: unknown): boolean {
  const verdict = normalizePrFeedbackVerdict(value);
  if (!verdict) return false;
  if (isMergedPrFeedbackVerdict(verdict)) return false;
  return (
    verdict === "closed_unmerged" ||
    verdict === "rejected_comment_cap_closed" ||
    verdict === "rejected_re_review_cap_closed"
  );
}

function extractReviewAgentPrUrl(params: Record<string, unknown>): string | null {
  const reviewAgent = params.reviewAgent;
  if (!reviewAgent || typeof reviewAgent !== "object" || Array.isArray(reviewAgent)) return null;
  return normalizePrUrl((reviewAgent as Record<string, unknown>).prUrl);
}

function resolveJobPrUrl(
  body: Record<string, unknown>,
  params: Record<string, unknown>,
): string | null {
  return normalizePrUrl(body.prUrl) ?? extractReviewAgentPrUrl(params);
}

export class JobQueue {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id                  TEXT PRIMARY KEY,
          taskId              TEXT NOT NULL,
          sessionId           TEXT NOT NULL DEFAULT '',
          kind                TEXT NOT NULL,
          params              TEXT NOT NULL DEFAULT '{}',
          dedupeKey           TEXT,
          dedupeCooldownMs    INTEGER NOT NULL DEFAULT 0,
          priority            TEXT NOT NULL DEFAULT 'normal',
          queueWaitBudgetMs   INTEGER NOT NULL DEFAULT 90000,
          executionBudgetMs   INTEGER NOT NULL DEFAULT 900000,
          finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000,
          status              TEXT NOT NULL DEFAULT 'pending',
          workerId            TEXT,
          targetWorkerId      TEXT,
          deferredByWorkerId  TEXT,
          runtimeGeneration   TEXT,
          claimGeneration     INTEGER NOT NULL DEFAULT 0,
          result              TEXT,
          prUrl               TEXT,
          prUrlNormalized     TEXT,
          error               TEXT,
          availableAt         TEXT,
          deferReason         TEXT,
          deferredAt          TEXT,
          enqueuedAt          TEXT,
          claimedAt           TEXT,
          startedAt           TEXT,
          firstLogAt          TEXT,
          lastActivityAt      TEXT,
          failedAt            TEXT,
          abandonedAt         TEXT,
          publishBlockedAt    TEXT,
          completedAt         TEXT,
          durationMs          INTEGER,
          resumeOfJobId       TEXT,
          attempt             INTEGER NOT NULL DEFAULT 1,
          createdAt           TEXT NOT NULL,
          updatedAt           TEXT NOT NULL
        );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs(taskId);
      CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(sessionId, createdAt);

      CREATE TABLE IF NOT EXISTS job_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId           TEXT NOT NULL,
        ts              TEXT NOT NULL,
        message         TEXT NOT NULL,
        claimGeneration INTEGER NOT NULL DEFAULT 0,
        category        TEXT,
        dedupeKey       TEXT,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(jobId, id);

      CREATE TABLE IF NOT EXISTS tool_runs (
        id                 TEXT PRIMARY KEY,
        jobId              TEXT,
        workerId           TEXT,
        sessionId          TEXT,
        phase              TEXT,
        tool               TEXT NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'discovered',
        capability         TEXT,
        envProfile         TEXT,
        cwd                TEXT,
        argvJson           TEXT NOT NULL DEFAULT '[]',
        commandLine        TEXT,
        allowedEffectsJson TEXT NOT NULL DEFAULT '[]',
        ok                 INTEGER NOT NULL DEFAULT 0,
        exitCode           INTEGER,
        failureClass       TEXT,
        retryable          INTEGER NOT NULL DEFAULT 0,
        remediation        TEXT,
        startedAt          TEXT NOT NULL,
        finishedAt         TEXT NOT NULL,
        durationMs         INTEGER NOT NULL DEFAULT 0,
        stdoutTail         TEXT,
        stderrTail         TEXT,
        metadataJson       TEXT NOT NULL DEFAULT '{}',
        createdAt          TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_runs_job_id ON tool_runs(jobId, finishedAt);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_tool ON tool_runs(tool, finishedAt);
      CREATE INDEX IF NOT EXISTS idx_tool_runs_failure_class ON tool_runs(failureClass, finishedAt);

      CREATE TABLE IF NOT EXISTS job_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId          TEXT NOT NULL,
        attempt        INTEGER NOT NULL DEFAULT 1,
        workerId       TEXT,
        backend        TEXT,
        model          TEXT,
        startedAt      TEXT,
        finishedAt     TEXT,
        durationMs     INTEGER,
        terminalReason TEXT,
        exitCode       INTEGER,
        metadataJson   TEXT NOT NULL DEFAULT '{}',
        createdAt      TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id ON job_attempts(jobId, attempt);

      CREATE TABLE IF NOT EXISTS job_terminal_diagnostics (
        jobId                 TEXT PRIMARY KEY,
        status                TEXT NOT NULL,
        failureClass          TEXT,
        terminalStage         TEXT,
        executorBackend       TEXT,
        summary               TEXT,
        watchdogFired         INTEGER NOT NULL DEFAULT 0,
        timeoutMs             INTEGER,
        publishableFileCount  INTEGER,
        artifactOnlyPathCount INTEGER,
        changedPathSampleJson TEXT NOT NULL DEFAULT '[]',
        metadataJson          TEXT NOT NULL DEFAULT '{}',
        createdAt             TEXT NOT NULL,
        updatedAt             TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_terminal_failure_class
        ON job_terminal_diagnostics(failureClass, updatedAt);

      CREATE TABLE IF NOT EXISTS job_phase_spans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId        TEXT NOT NULL,
        attempt      INTEGER,
        phase        TEXT NOT NULL,
        startedAt    TEXT NOT NULL,
        finishedAt   TEXT NOT NULL,
        durationMs   INTEGER NOT NULL DEFAULT 0,
        outcome      TEXT,
        metadataJson TEXT NOT NULL DEFAULT '{}',
        createdAt    TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_phase_spans_job_id ON job_phase_spans(jobId, startedAt);
      CREATE INDEX IF NOT EXISTS idx_job_phase_spans_phase ON job_phase_spans(phase, startedAt);

      CREATE TABLE IF NOT EXISTS job_validation_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId        TEXT NOT NULL,
        attempt      INTEGER,
        command      TEXT NOT NULL,
        exitCode     INTEGER,
        durationMs   INTEGER,
        passed       INTEGER NOT NULL DEFAULT 0,
        failureClass TEXT,
        stdoutTail   TEXT,
        stderrTail   TEXT,
        metadataJson TEXT NOT NULL DEFAULT '{}',
        createdAt    TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_validation_runs_job_id ON job_validation_runs(jobId, id);
      CREATE INDEX IF NOT EXISTS idx_job_validation_runs_failure_class
        ON job_validation_runs(failureClass, createdAt);

      CREATE TABLE IF NOT EXISTS job_patch_snapshots (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId                  TEXT NOT NULL,
        attempt                INTEGER,
        phase                  TEXT,
        publishableFileCount   INTEGER,
        artifactOnlyPathCount  INTEGER,
        changedPathSampleJson  TEXT NOT NULL DEFAULT '[]',
        topLevelDirsJson       TEXT NOT NULL DEFAULT '[]',
        capturedAt             TEXT,
        metadataJson           TEXT NOT NULL DEFAULT '{}',
        createdAt              TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_patch_snapshots_job_id
        ON job_patch_snapshots(jobId, capturedAt);

      CREATE TABLE IF NOT EXISTS job_artifacts (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        uri     TEXT,
        text    TEXT,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS workers (
        workerId      TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'idle',
        currentJobId  TEXT,
        pollMs        INTEGER,
        capabilities  TEXT,
        details       TEXT,
        lastHeartbeat TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(lastHeartbeat);

      CREATE TABLE IF NOT EXISTS worker_runtime_circuits (
        runtimeGeneration     TEXT PRIMARY KEY,
        state                 TEXT NOT NULL DEFAULT 'closed',
        fingerprint           TEXT,
        failureClass          TEXT,
        executorBackend       TEXT,
        signatureSample       TEXT,
        openedAt              TEXT,
        retryAt               TEXT,
        lastFailureAt         TEXT,
        recoveredAt           TEXT,
        canaryJobId           TEXT,
        canaryWorkerId        TEXT,
        canaryClaimedAt       TEXT,
        canaryLeaseExpiresAt  TEXT,
        createdAt             TEXT NOT NULL,
        updatedAt             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runtime_circuit_canary
        ON worker_runtime_circuits(canaryJobId, state);

      CREATE TABLE IF NOT EXISTS pr_worker_assignments (
        prUrl         TEXT PRIMARY KEY,
        workerId      TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_worker_assignments_worker ON pr_worker_assignments(workerId);

      CREATE TABLE IF NOT EXISTS pr_provider_outcomes (
        normalizedPrUrl TEXT PRIMARY KEY,
        prUrl           TEXT NOT NULL,
        jobId           TEXT,
        verdict         TEXT NOT NULL,
        terminal        INTEGER NOT NULL DEFAULT 0,
        merged          INTEGER NOT NULL DEFAULT 0,
        providerStateAt TEXT NOT NULL,
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_provider_outcomes_terminal_updated
        ON pr_provider_outcomes(terminal, updatedAt DESC);
    `);

    const jobColumns = this.db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!jobColumns.some((col) => col.name === "targetWorkerId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN targetWorkerId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "deferredByWorkerId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN deferredByWorkerId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "runtimeGeneration")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN runtimeGeneration TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "claimGeneration")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN claimGeneration INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!jobColumns.some((col) => col.name === "priority")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeKey")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeKey TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeCooldownMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeCooldownMs INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!jobColumns.some((col) => col.name === "queueWaitBudgetMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000;`);
    }
    if (!jobColumns.some((col) => col.name === "executionBudgetMs")) {
      this.db.exec(
        `ALTER TABLE jobs ADD COLUMN executionBudgetMs INTEGER NOT NULL DEFAULT 900000;`,
      );
    }
    if (!jobColumns.some((col) => col.name === "finalizationBudgetMs")) {
      this.db.exec(
        `ALTER TABLE jobs ADD COLUMN finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000;`,
      );
    }
    if (!jobColumns.some((col) => col.name === "enqueuedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN enqueuedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "claimedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN claimedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "startedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN startedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "firstLogAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN firstLogAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "lastActivityAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN lastActivityAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "failedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN failedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "abandonedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN abandonedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "publishBlockedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN publishBlockedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "completedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN completedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "durationMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN durationMs INTEGER;`);
    }
    if (!jobColumns.some((col) => col.name === "resumeOfJobId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN resumeOfJobId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "attempt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!jobColumns.some((col) => col.name === "prUrl")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN prUrl TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "prUrlNormalized")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN prUrlNormalized TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "availableAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN availableAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "deferReason")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN deferReason TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "deferredAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN deferredAt TEXT;`);
    }

    const providerOutcomeColumns = this.db
      .prepare(`PRAGMA table_info(pr_provider_outcomes)`)
      .all() as Array<{ name: string }>;
    if (!providerOutcomeColumns.some((col) => col.name === "providerStateAt")) {
      this.db.exec(`ALTER TABLE pr_provider_outcomes ADD COLUMN providerStateAt TEXT;`);
    }
    this.db.exec(`
      UPDATE pr_provider_outcomes
      SET providerStateAt = COALESCE(providerStateAt, updatedAt, createdAt)
      WHERE providerStateAt IS NULL OR TRIM(providerStateAt) = '';
    `);

    const legacyPrRows = this.db
      .prepare(
        `SELECT id, prUrl
         FROM jobs
         WHERE prUrl IS NOT NULL
           AND TRIM(prUrl) <> ''
           AND (prUrlNormalized IS NULL OR TRIM(prUrlNormalized) = '')`,
      )
      .all() as Array<{ id: string; prUrl: string }>;
    if (legacyPrRows.length > 0) {
      const updateNormalizedPrUrl = this.db.prepare(
        `UPDATE jobs SET prUrlNormalized = ? WHERE id = ?`,
      );
      this.db.transaction(() => {
        for (const row of legacyPrRows) {
          updateNormalizedPrUrl.run(normalizePrUrl(row.prUrl), row.id);
        }
      })();
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_pr_url_normalized
        ON jobs(prUrlNormalized, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_pr_url_latest
        ON jobs(prUrlNormalized, updatedAt DESC)
        WHERE prUrlNormalized IS NOT NULL;
    `);

    const jobLogColumns = this.db.prepare(`PRAGMA table_info(job_logs)`).all() as Array<{
      name: string;
    }>;
    if (!jobLogColumns.some((col) => col.name === "claimGeneration")) {
      this.db.exec(`ALTER TABLE job_logs ADD COLUMN claimGeneration INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!jobLogColumns.some((col) => col.name === "category")) {
      this.db.exec(`ALTER TABLE job_logs ADD COLUMN category TEXT;`);
    }
    if (!jobLogColumns.some((col) => col.name === "dedupeKey")) {
      this.db.exec(`ALTER TABLE job_logs ADD COLUMN dedupeKey TEXT;`);
    }

    // Older workers could copy their clock into job_logs.ts and the job's
    // activity columns. Normalize claimed jobs once into a server-authoritative
    // activity lease; every new claim/log write maintains this field directly.
    const activityNowMs = Date.now();
    const activityNow = new Date(activityNowMs).toISOString();
    const legacyActivityRows = this.db
      .prepare(
        `SELECT id, claimGeneration, firstLogAt, startedAt, claimedAt, updatedAt, createdAt
         FROM jobs
         WHERE status = 'claimed'
           AND (
             lastActivityAt IS NULL
             OR julianday(lastActivityAt) IS NULL
             OR julianday(lastActivityAt) > julianday(?)
           )`,
      )
      .all(activityNow) as Array<{
      id: string;
      claimGeneration: number | null;
      firstLogAt: string | null;
      startedAt: string | null;
      claimedAt: string | null;
      updatedAt: string;
      createdAt: string;
    }>;
    if (legacyActivityRows.length > 0) {
      const latestLog = this.db.prepare(
        `SELECT ts
         FROM job_logs
         WHERE jobId = ?
           AND COALESCE(claimGeneration, 0) = ?
           AND julianday(ts) IS NOT NULL
           AND julianday(ts) <= julianday(?)
         ORDER BY julianday(ts) DESC, id DESC
         LIMIT 1`,
      );
      const updateActivity = this.db.prepare(
        `UPDATE jobs SET lastActivityAt = ? WHERE id = ? AND status = 'claimed'`,
      );
      const backfillActivity = this.db.transaction(() => {
        for (const row of legacyActivityRows) {
          const log = latestLog.get(row.id, Number(row.claimGeneration ?? 0), activityNow) as
            | { ts: string | null }
            | undefined;
          const candidates = [
            log?.ts,
            row.firstLogAt,
            row.startedAt,
            row.claimedAt,
            row.updatedAt,
            row.createdAt,
          ]
            .map((value) => parseIsoMs(value))
            .filter((value): value is number => value != null && value <= activityNowMs);
          const lastActivityAt = new Date(
            candidates.length > 0 ? Math.max(...candidates) : activityNowMs,
          ).toISOString();
          updateActivity.run(lastActivityAt, row.id);
        }
      });
      backfillActivity();
    }

    // Column-dependent indexes are created after legacy column backfills complete.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(status, priority, createdAt);`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_available_at ON jobs(status, availableAt);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_stale_activity ON jobs(status, lastActivityAt, id);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_runtime_generation ON jobs(runtimeGeneration, status);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_job_logs_claim_generation ON job_logs(jobId, claimGeneration, id);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_job_logs_activity
         ON job_logs(jobId, COALESCE(claimGeneration, 0), julianday(ts) DESC, id DESC);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_job_logs_dedupe ON job_logs(jobId, category, dedupeKey, id);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_created ON jobs(dedupeKey, createdAt);`,
    );
    // Keep publication-in-flight jobs active for dedupe. Recreate the partial
    // index so databases made by older releases pick up the finalizing state.
    // The old index excluded finalizing jobs, so a valid legacy database can
    // contain a publication candidate plus newer pending/claimed work for the
    // same key. Reconcile those rows transactionally before widening the index.
    const completionsTablePresent = Boolean(
      this.db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
           WHERE type = 'table' AND name = 'completions'`,
        )
        .get(),
    );
    const unresolvedCompletionPredicate = completionsTablePresent
      ? `EXISTS (
           SELECT 1 FROM completions unresolved
           WHERE unresolved.jobId = j.id
             AND unresolved.status IN ('pending', 'claimed')
         )`
      : "0";
    const migrateActiveDedupeIndex = this.db.transaction(() => {
      this.db.exec(`DROP INDEX IF EXISTS idx_jobs_dedupe_active;`);

      const conflictingRows = this.db
        .prepare(
          `SELECT j.id, j.dedupeKey, j.status, j.claimGeneration, j.createdAt,
                  CASE
                    WHEN j.status = 'finalizing' OR ${unresolvedCompletionPredicate} THEN 1
                    ELSE 0
                  END AS publicationParent
           FROM jobs j
           WHERE j.dedupeKey IS NOT NULL
             AND j.dedupeKey <> ''
             AND j.status IN ('pending','claimed','finalizing')
             AND j.dedupeKey IN (
               SELECT duplicate.dedupeKey
               FROM jobs duplicate
               WHERE duplicate.dedupeKey IS NOT NULL
                 AND duplicate.dedupeKey <> ''
                 AND duplicate.status IN ('pending','claimed','finalizing')
               GROUP BY duplicate.dedupeKey
               HAVING COUNT(*) > 1
             )
           ORDER BY j.dedupeKey ASC,
             CASE
               WHEN j.status = 'finalizing' OR ${unresolvedCompletionPredicate} THEN 0
               WHEN j.status = 'claimed' THEN 1
               ELSE 2
             END ASC,
             j.createdAt ASC,
             j.id ASC`,
        )
        .all() as Array<{
        id: string;
        dedupeKey: string;
        status: "pending" | "claimed" | "finalizing";
        claimGeneration: number | null;
        createdAt: string;
        publicationParent: 0 | 1;
      }>;

      if (conflictingRows.length > 0) {
        const now = new Date().toISOString();
        const abandonDuplicate = this.db.prepare(
          `UPDATE jobs
           SET status = 'abandoned',
               error = COALESCE(error, ?),
               availableAt = NULL,
               abandonedAt = COALESCE(abandonedAt, ?),
               updatedAt = ?
           WHERE id = ?
             AND status IN ('pending','claimed')`,
        );
        const releasePublicationDedupeKey = this.db.prepare(
          `UPDATE jobs
           SET dedupeKey = NULL,
               updatedAt = ?
           WHERE id = ?
             AND dedupeKey = ?`,
        );
        const releaseWorker = this.db.prepare(
          `UPDATE workers
           SET status = 'idle',
               currentJobId = NULL,
               updatedAt = ?
           WHERE currentJobId = ?`,
        );
        const recordReconciliation = this.db.prepare(
          `INSERT INTO job_logs (
             jobId, ts, message, claimGeneration, category, dedupeKey
           ) VALUES (?, ?, ?, ?, 'server_dedupe_migration', ?)`,
        );

        let currentDedupeKey: string | null = null;
        let canonicalJobId = "";
        for (const row of conflictingRows) {
          if (row.dedupeKey !== currentDedupeKey) {
            currentDedupeKey = row.dedupeKey;
            canonicalJobId = row.id;
            continue;
          }

          if (row.publicationParent === 1) {
            releasePublicationDedupeKey.run(now, row.id, row.dedupeKey);
            recordReconciliation.run(
              row.id,
              now,
              `Released duplicate dedupe key during migration; publication remains active and job ${canonicalJobId} retains the key.`,
              Number(row.claimGeneration ?? 0),
              row.dedupeKey,
            );
            continue;
          }

          const error = JSON.stringify({
            message: "Abandoned duplicate active job during dedupe index migration",
            canonicalJobId,
            dedupeKey: row.dedupeKey,
          });
          repointDurableRecoveryLinks(this.db, row.id, canonicalJobId, now);
          abandonDuplicate.run(error, now, now, row.id);
          releaseWorker.run(now, row.id);
          recordReconciliation.run(
            row.id,
            now,
            `Abandoned duplicate active job during migration; job ${canonicalJobId} retains the dedupe key.`,
            Number(row.claimGeneration ?? 0),
            row.dedupeKey,
          );
        }
      }

      this.db.exec(
        `CREATE UNIQUE INDEX idx_jobs_dedupe_active
           ON jobs(dedupeKey)
         WHERE dedupeKey IS NOT NULL
           AND dedupeKey <> ''
           AND status IN ('pending','claimed','finalizing');`,
      );
    });
    migrateActiveDedupeIndex();

    this.db.exec(`
      UPDATE jobs
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        dedupeCooldownMs = CASE
          WHEN dedupeCooldownMs IS NULL OR dedupeCooldownMs < 0 THEN 0
          ELSE dedupeCooldownMs
        END,
        attempt = CASE WHEN attempt IS NULL OR attempt <= 0 THEN 1 ELSE attempt END,
        claimGeneration = COALESCE(claimGeneration, 0),
        queueWaitBudgetMs = CASE WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000 ELSE queueWaitBudgetMs END,
        executionBudgetMs = CASE WHEN executionBudgetMs IS NULL OR executionBudgetMs <= 0 THEN 900000 ELSE executionBudgetMs END,
        finalizationBudgetMs = CASE WHEN finalizationBudgetMs IS NULL OR finalizationBudgetMs <= 0 THEN 120000 ELSE finalizationBudgetMs END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
  }

  private assignedWorkerForPr(prUrl: string | null): string | null {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    if (!normalizedPrUrl) return null;
    const row = this.db
      .prepare(`SELECT workerId FROM pr_worker_assignments WHERE prUrl = ?`)
      .get(normalizedPrUrl) as { workerId: string | null } | undefined;
    const workerId = row?.workerId?.trim() ?? "";
    if (!workerId) return null;
    const worker = this.db
      .prepare(`SELECT status, lastHeartbeat FROM workers WHERE workerId = ?`)
      .get(workerId) as { status: string | null; lastHeartbeat: string | null } | undefined;
    if (!worker) return null;
    if (
      String(worker.status ?? "")
        .trim()
        .toLowerCase() === "offline"
    )
      return null;
    const heartbeatMs = parseIsoMs(worker.lastHeartbeat);
    if (heartbeatMs == null) return null;
    if (Date.now() - heartbeatMs > PR_WORKER_ASSIGNMENT_MAX_AGE_MS) return null;
    return workerId ? workerId : null;
  }

  private upsertPrWorkerAssignment(
    prUrl: string | null,
    workerId: string | null,
    now: string,
  ): void {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    const normalizedWorkerId = typeof workerId === "string" ? workerId.trim() : "";
    if (!normalizedPrUrl || !normalizedWorkerId) return;
    this.db
      .prepare(
        `INSERT INTO pr_worker_assignments (prUrl, workerId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(prUrl) DO UPDATE SET
           workerId = excluded.workerId,
           updatedAt = excluded.updatedAt`,
      )
      .run(normalizedPrUrl, normalizedWorkerId, now, now);
  }

  private refreshPrWorkerAssignmentForJob(jobId: string, now: string): void {
    const row = this.db.prepare(`SELECT prUrl, workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { prUrl: string | null; workerId: string | null }
      | undefined;
    if (!row) return;
    this.upsertPrWorkerAssignment(row.prUrl, row.workerId, now);
  }

  private pendingOrderedIds(targetWorkerId: string | null = null): string[] {
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    if (targetWorkerId) {
      const rows = this.db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
             )
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC`,
        )
        .all(targetWorkerId, targetWorkerCutoff, now, targetWorkerId) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    }

    const rows = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`,
      )
      .all(now, targetWorkerCutoff) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private queuePosition(jobId: string, targetWorkerId: string | null = null): number | null {
    const ordered = this.pendingOrderedIds(targetWorkerId);
    const idx = ordered.indexOf(jobId);
    if (idx < 0) return null;
    return idx + 1;
  }

  estimateEtaMs(priority: JobPriority, position: number | null): number | null {
    if (!position || position <= 0) return null;
    const slotMs = JOB_PRIORITY_QUEUE_SLA_MS[priority];
    return Math.max(0, slotMs * (position - 1));
  }

  enqueue(body: Record<string, unknown>): {
    ok: boolean;
    jobId?: string;
    taskId?: string;
    queuePosition?: number;
    etaMs?: number;
    deduped?: boolean;
    message?: string;
  } {
    const taskId = String(body.taskId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    const sessionId = String(body.sessionId ?? "").trim();
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const prUrl = resolveJobPrUrl(body, params);
    const targetWorkerIdRaw = body.targetWorkerId;
    const requestedTargetWorkerId =
      typeof targetWorkerIdRaw === "string" && targetWorkerIdRaw.trim().length > 0
        ? targetWorkerIdRaw.trim()
        : null;
    const targetWorkerId =
      requestedTargetWorkerId || (prUrl ? this.assignedWorkerForPr(prUrl) : null);

    if (!taskId || !kind) {
      return { ok: false, message: "taskId and kind are required" };
    }

    const priority = normalizeJobPriority(
      body.priority ?? extractPlanningField(params, "queuePriority"),
    );
    const queueWaitBudgetMs = parseBudgetMs(
      body.queueWaitBudgetMs ?? extractPlanningField(params, "queueWaitBudgetMs"),
      JOB_PRIORITY_QUEUE_SLA_MS[priority],
    );
    const executionBudgetMs = parseBudgetMs(
      body.executionBudgetMs ?? extractPlanningField(params, "executionBudgetMs"),
      JOB_EXECUTION_BUDGET_MS[priority],
    );
    const finalizationBudgetMs = parseBudgetMs(
      body.finalizationBudgetMs ?? extractPlanningField(params, "finalizationBudgetMs"),
      JOB_FINALIZATION_BUDGET_MS_DEFAULT,
    );
    const dedupeKey = normalizeDedupeKey(body.dedupeKey);
    const dedupeCooldownMs = parseDedupeCooldownMs(body.dedupeCooldownMs, dedupeKey ? 0 : 0);

    if (dedupeKey) {
      const active = this.db
        .prepare(
          `SELECT id, taskId
           FROM jobs
           WHERE dedupeKey = ?
             AND status IN ('pending', 'claimed', 'finalizing')
           ORDER BY createdAt DESC
           LIMIT 1`,
        )
        .get(dedupeKey) as { id: string; taskId: string } | undefined;
      if (active?.id) {
        return {
          ok: true,
          jobId: active.id,
          taskId: active.taskId,
          deduped: true,
          message: `Active job already exists for dedupeKey ${dedupeKey}`,
        };
      }

      if (dedupeCooldownMs > 0) {
        const latest = this.db
          .prepare(
            `SELECT id, taskId, createdAt
             FROM jobs
             WHERE dedupeKey = ?
             ORDER BY createdAt DESC
             LIMIT 1`,
          )
          .get(dedupeKey) as { id: string; taskId: string; createdAt: string } | undefined;
        if (latest?.id) {
          const createdAtMs = parseIsoMs(latest.createdAt);
          if (createdAtMs != null && Date.now() - createdAtMs < dedupeCooldownMs) {
            return {
              ok: true,
              jobId: latest.id,
              taskId: latest.taskId,
              deduped: true,
              message: `Dedupe cooldown active for dedupeKey ${dedupeKey}`,
            };
          }
        }
      }
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO jobs (
            id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
            queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
            status, workerId, targetWorkerId, result, prUrl, prUrlNormalized, error,
            enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, completedAt, durationMs,
            createdAt, updatedAt
          )
           VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            'pending', NULL, ?, NULL, ?, ?, NULL,
            ?, NULL, NULL, NULL, NULL, NULL, NULL,
            ?, ?
           )`,
        )
        .run(
          jobId,
          taskId,
          sessionId,
          kind,
          JSON.stringify(params),
          dedupeKey,
          dedupeCooldownMs,
          priority,
          queueWaitBudgetMs,
          executionBudgetMs,
          finalizationBudgetMs,
          targetWorkerId,
          prUrl,
          normalizePrUrl(prUrl),
          now,
          now,
          now,
        );
    } catch (err: any) {
      const message = String(err?.message ?? err ?? "");
      if (dedupeKey && /UNIQUE constraint failed/i.test(message)) {
        const active = this.db
          .prepare(
            `SELECT id, taskId
             FROM jobs
             WHERE dedupeKey = ?
               AND status IN ('pending', 'claimed', 'finalizing')
             ORDER BY createdAt DESC
             LIMIT 1`,
          )
          .get(dedupeKey) as { id: string; taskId: string } | undefined;
        if (active?.id) {
          return {
            ok: true,
            jobId: active.id,
            taskId: active.taskId,
            deduped: true,
            message: `Active job already exists for dedupeKey ${dedupeKey}`,
          };
        }
      }
      throw err;
    }

    const queuePosition = this.queuePosition(jobId, targetWorkerId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);
    return {
      ok: true,
      jobId,
      taskId,
      queuePosition: queuePosition ?? undefined,
      etaMs: etaMs ?? undefined,
    };
  }

  claim(
    workerIdRaw: string,
    options: { runtimeGeneration?: string } = {},
  ): {
    ok: boolean;
    job?: JobRow;
    queueWaitMs?: number;
    replayed?: boolean;
    code?: "worker_runtime_generation_mismatch";
    message?: string;
  } {
    const workerId = normalizeJobWorkerId(workerIdRaw);
    if (!workerId) return { ok: false, message: "workerId is required" };
    const runtimeGeneration = normalizeWorkerRuntimeGeneration(options.runtimeGeneration);
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
           VALUES (?, 'idle', NULL, NULL, '{}', '{}', ?, ?, ?)
           ON CONFLICT(workerId) DO UPDATE SET
             lastHeartbeat = excluded.lastHeartbeat,
             updatedAt = excluded.updatedAt`,
        )
        .run(workerId, now, now, now);

      const existingClaim = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE workerId = ?
             AND status = 'claimed'
           ORDER BY COALESCE(startedAt, claimedAt, updatedAt, createdAt) ASC
           LIMIT 1`,
        )
        .get(workerId) as JobRow | undefined;

      if (existingClaim) {
        if (
          normalizeWorkerRuntimeGeneration(existingClaim.runtimeGeneration) !== runtimeGeneration
        ) {
          return {
            job: existingClaim,
            queueWaitMs: 0,
            runtimeGenerationMismatch: true as const,
          };
        }
        this.db
          .prepare(
            `UPDATE jobs
             SET lastActivityAt = ?
             WHERE id = ?
               AND status = 'claimed'
               AND workerId = ?
               AND COALESCE(claimGeneration, 0) = ?`,
          )
          .run(now, existingClaim.id, workerId, Number(existingClaim.claimGeneration ?? 0));
        this.db
          .prepare(
            `UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`,
          )
          .run(existingClaim.id, now, now, workerId);
        return {
          job: {
            ...existingClaim,
            workerId,
            status: "claimed" as JobStatus,
            lastActivityAt: now,
          },
          queueWaitMs: 0,
          reusedActiveClaim: true as const,
        };
      }

      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
             )
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC
           LIMIT 1`,
        )
        .get(workerId, targetWorkerCutoff, now, workerId) as JobRow | undefined;

      if (!row) {
        this.db
          .prepare(
            `UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`,
          )
          .run(now, now, workerId);
        return null;
      }

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'claimed',
               workerId = ?,
               deferredByWorkerId = NULL,
               runtimeGeneration = ?,
               claimGeneration = COALESCE(claimGeneration, 0) + 1,
               claimedAt = ?,
               startedAt = NULL,
               lastActivityAt = ?,
               availableAt = NULL,
               deferReason = NULL,
               deferredAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
               completedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
            WHERE id = ?`,
        )
        .run(workerId, runtimeGeneration, now, now, now, row.id);

      this.db
        .prepare(
          `UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
           WHERE workerId = ?`,
        )
        .run(row.id, now, now, workerId);
      this.upsertPrWorkerAssignment(row.prUrl, workerId, now);

      const queueWaitMs = Math.max(
        0,
        Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0),
      );

      return {
        job: {
          ...row,
          status: "claimed" as JobStatus,
          workerId,
          deferredByWorkerId: null,
          runtimeGeneration,
          claimGeneration: Number(row.claimGeneration ?? 0) + 1,
          claimedAt: now,
          startedAt: null,
          lastActivityAt: now,
          failedAt: null,
          publishBlockedAt: null,
          completedAt: null,
          durationMs: null,
          availableAt: null,
          deferReason: null,
          deferredAt: null,
          updatedAt: now,
        },
        queueWaitMs,
      };
    });

    const claimed = tx();
    if (!claimed) return { ok: false, message: "No pending jobs" };
    if ("runtimeGenerationMismatch" in claimed) {
      return {
        ok: false,
        code: "worker_runtime_generation_mismatch",
        message:
          `Worker ${workerId} already owns job ${claimed.job.id} under runtime generation ` +
          `${claimed.job.runtimeGeneration ?? DEFAULT_WORKER_RUNTIME_GENERATION}`,
      };
    }
    if ("reusedActiveClaim" in claimed) {
      return {
        ok: true,
        job: claimed.job,
        queueWaitMs: claimed.queueWaitMs,
        replayed: true,
      };
    }
    return { ok: true, job: claimed.job, queueWaitMs: claimed.queueWaitMs };
  }

  startClaimedExecution(
    jobId: string,
    authority: JobClaimAuthority,
  ): { ok: boolean; replayed?: boolean; startedAt?: string; message?: string } {
    const workerId = normalizeJobWorkerId(authority.workerId);
    if (
      !workerId ||
      !Number.isSafeInteger(authority.claimGeneration) ||
      authority.claimGeneration < 1
    ) {
      return { ok: false, message: "Valid claim authority is required" };
    }

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const claimed = this.db
        .prepare(
          `SELECT startedAt
           FROM jobs
           WHERE id = ?
             AND status = 'claimed'
             AND workerId = ?
             AND COALESCE(claimGeneration, 0) = ?`,
        )
        .get(jobId, workerId, authority.claimGeneration) as
        | { startedAt: string | null }
        | undefined;
      if (!claimed) return null;

      const startedAt = claimed.startedAt ?? now;
      this.db
        .prepare(
          `UPDATE jobs
           SET startedAt = ?, lastActivityAt = ?, updatedAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND workerId = ?
             AND COALESCE(claimGeneration, 0) = ?`,
        )
        .run(startedAt, now, now, jobId, workerId, authority.claimGeneration);
      this.db
        .prepare(
          `UPDATE workers
           SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
           WHERE workerId = ?`,
        )
        .run(jobId, now, now, workerId);
      return { replayed: claimed.startedAt !== null, startedAt };
    });

    const started = tx();
    if (!started) {
      return {
        ok: false,
        message: "Job not found, not claimed, or claim ownership changed",
      };
    }
    return { ok: true, ...started };
  }

  private recoverClaimedJob(
    jobId: string,
    now: string,
    options: {
      expectedWorkerId?: string | null;
      recoveryReason: JobRecoveryReason;
      failureMessage: string;
      abandonmentMessage: string;
      detail: string;
    },
  ): RecoveredStaleJob | null {
    const job = this.getJob(jobId);
    if (!job || job.status !== "claimed") return null;
    if (options.expectedWorkerId && job.workerId !== options.expectedWorkerId) return null;

    const params = parseJobParamsRecord(job.params);
    const classifiedRetry = classifyJobRetrySafety(job.kind, params);
    const executionStarted = job.startedAt !== null;
    const retrySafety: JobRetrySafety = executionStarted
      ? classifiedRetry.retrySafety
      : "retry_safe";
    const classificationReason = executionStarted
      ? classifiedRetry.reason
      : "job never crossed the authoritative execution boundary (startedAt is null)";
    const detailWithClassification = [
      options.detail,
      `executionStarted=${executionStarted ? "yes" : "no"}`,
      `retrySafety=${retrySafety}`,
      `classificationReason=${classificationReason}`,
    ].join("; ");
    const recordRuntimeRecoveryDiagnostics = (status: JobStatus): void => {
      // A claim lost before the worker's exact busy heartbeat or first authorized
      // log is a control-plane handoff failure, not evidence that the runtime
      // failed. Do not let it contribute synthetic worker-runtime circuit data.
      if (job.kind !== "task.execute" || !executionStarted) return;
      const summary = `WorkerPal lost a claimed task without structured terminal diagnostics (${options.recoveryReason})`;
      try {
        this.recordJobDiagnostics(
          job.id,
          {
            message: summary,
            detail: detailWithClassification,
            diagnostics: {
              terminal: {
                failureClass: "worker_runtime_failure",
                terminalStage: "worker_runtime",
                executorBackend: "unknown",
                summary,
                watchdogFired: true,
                metadata: {
                  classificationOwner: "server_claim_recovery",
                  recoveryReason: options.recoveryReason,
                  structuredResult: false,
                },
              },
            },
          },
          status,
          now,
        );
      } catch (error) {
        console.error(
          `[JobQueue] Failed to persist unstructured runtime recovery diagnostics for ${job.id}: ${
            error instanceof Error ? error.stack || error.message : String(error)
          }`,
        );
      }
    };

    if (retrySafety === "retry_safe") {
      const replacementJobId = randomUUID();
      const attempt = Math.max(1, Math.floor(Number(job.attempt || 1))) + 1;
      const replacementAvailableAt = new Date(
        Date.parse(now) + RETRY_SAFE_REQUEUE_DELAY_MS,
      ).toISOString();
      const replacementParams = buildResumeParams(params, {
        previousJobId: job.id,
        previousWorkerId: job.workerId,
        recoveredAt: now,
        reason: options.recoveryReason,
        detail: options.detail,
        retrySafety,
        classificationReason,
        attempt,
      });
      const nextTargetWorkerId =
        job.targetWorkerId && job.targetWorkerId !== job.workerId ? job.targetWorkerId : null;
      const abandonmentError = JSON.stringify({
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        replacementJobId,
        replacementAvailableAt,
      });
      const recover = this.db.transaction(() => {
        const abandonedInfo = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'abandoned',
                 error = ?,
                 failedAt = NULL,
                 abandonedAt = ?,
                 publishBlockedAt = NULL,
                 availableAt = NULL,
                 completedAt = NULL,
                 durationMs = MAX(
                   0,
                   CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
                 ),
                 updatedAt = ?
             WHERE id = ?
               AND status = 'claimed'
               AND (? IS NULL OR workerId = ?)`,
          )
          .run(
            abandonmentError,
            now,
            now,
            now,
            job.id,
            options.expectedWorkerId ?? null,
            options.expectedWorkerId ?? null,
          );
        if (abandonedInfo.changes === 0) return false;

        this.db
          .prepare(
            `INSERT INTO jobs (
               id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
               queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
               status, workerId, targetWorkerId, result, prUrl, prUrlNormalized, error, availableAt,
               enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, abandonedAt, completedAt,
               durationMs, resumeOfJobId, attempt, createdAt, updatedAt
             )
             VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?,
               'pending', NULL, ?, NULL, ?, ?, NULL, ?,
               ?, NULL, NULL, NULL, NULL, NULL, NULL,
               NULL, ?, ?, ?, ?
             )`,
          )
          .run(
            replacementJobId,
            job.taskId,
            job.sessionId,
            job.kind,
            JSON.stringify(replacementParams),
            job.dedupeKey,
            job.dedupeCooldownMs,
            job.priority,
            job.queueWaitBudgetMs,
            job.executionBudgetMs,
            job.finalizationBudgetMs,
            nextTargetWorkerId,
            job.prUrl,
            normalizePrUrl(job.prUrl),
            replacementAvailableAt,
            now,
            job.id,
            attempt,
            now,
            now,
          );

        repointDurableRecoveryLinks(this.db, job.id, replacementJobId, now);
        return true;
      });
      if (!recover()) return null;
      recordRuntimeRecoveryDiagnostics("abandoned");

      return {
        jobId: job.id,
        taskId: job.taskId,
        sessionId: job.sessionId,
        workerId: job.workerId,
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        action: "requeued",
        finalStatus: "abandoned",
        retrySafety,
        replacementJobId,
        replacementAvailableAt,
        recoveredAt: now,
      };
    }

    const failureError = JSON.stringify({
      message: options.failureMessage,
      detail: detailWithClassification,
    });
    const failedInfo = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             availableAt = NULL,
             completedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND (? IS NULL OR workerId = ?)`,
      )
      .run(
        failureError,
        now,
        now,
        now,
        job.id,
        options.expectedWorkerId ?? null,
        options.expectedWorkerId ?? null,
      );
    if (failedInfo.changes === 0) return null;
    recordRuntimeRecoveryDiagnostics("failed");

    return {
      jobId: job.id,
      taskId: job.taskId,
      sessionId: job.sessionId,
      workerId: job.workerId,
      message: options.failureMessage,
      detail: detailWithClassification,
      action: "failed",
      finalStatus: "failed",
      retrySafety,
      recoveredAt: now,
    };
  }

  heartbeat(body: Record<string, unknown>): WorkerHeartbeatResult {
    const workerId = normalizeJobWorkerId(body.workerId);
    if (!workerId) return { ok: false, message: "workerId is required" };
    const status = normalizeWorkerStatus(body.status);
    const currentJobId =
      typeof body.currentJobId === "string" && body.currentJobId.trim().length > 0
        ? body.currentJobId.trim()
        : null;
    const pollMs =
      typeof body.pollMs === "number" && Number.isFinite(body.pollMs)
        ? Math.max(0, body.pollMs)
        : null;
    const capabilities = JSON.stringify(
      body.capabilities &&
        typeof body.capabilities === "object" &&
        !Array.isArray(body.capabilities)
        ? body.capabilities
        : {},
    );
    const details = JSON.stringify(
      body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? body.details
        : {},
    );
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET
           status = excluded.status,
           currentJobId = excluded.currentJobId,
           pollMs = excluded.pollMs,
           capabilities = excluded.capabilities,
           details = excluded.details,
           lastHeartbeat = excluded.lastHeartbeat,
           updatedAt = excluded.updatedAt`,
      )
      .run(workerId, status, currentJobId, pollMs, capabilities, details, now, now, now);

    if (status === "busy" && currentJobId) {
      this.db
        .prepare(
          `UPDATE jobs
           SET lastActivityAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND workerId = ?
             AND startedAt IS NOT NULL`,
        )
        .run(now, currentJobId, workerId);
      const canaryLeaseExpiresAt = new Date(
        Date.parse(now) + WORKER_RUNTIME_CANARY_LEASE_MS_DEFAULT,
      ).toISOString();
      this.db
        .prepare(
          `UPDATE worker_runtime_circuits
           SET canaryLeaseExpiresAt = ?, updatedAt = ?
           WHERE state = 'half_open'
             AND canaryJobId = ?
             AND canaryWorkerId = ?`,
        )
        .run(canaryLeaseExpiresAt, now, currentJobId, workerId);
    }

    const recoveredJobs = this.reconcileWorkerHeartbeatMismatch(
      workerId,
      status,
      currentJobId,
      now,
    );

    return {
      ok: true,
      ...(recoveredJobs.length > 0 ? { recoveredJobs } : {}),
    };
  }

  private reconcileWorkerHeartbeatMismatch(
    workerId: string,
    status: WorkerStatus,
    currentJobId: string | null,
    now: string,
  ): RecoveredStaleJob[] {
    const rows = this.db
      .prepare(
        `SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.updatedAt AS updatedAt,
           j.claimedAt AS claimedAt,
           j.startedAt AS startedAt,
           j.firstLogAt AS firstLogAt,
           (
             SELECT MAX(jl.ts)
             FROM job_logs jl
             WHERE jl.jobId = j.id
               AND COALESCE(jl.claimGeneration, 0) = COALESCE(j.claimGeneration, 0)
           ) AS lastLogTs,
           j.lastActivityAt AS activityAt
         FROM jobs j
         WHERE j.status = 'claimed'
           AND j.workerId = ?`,
      )
      .all(workerId) as ClaimedJobActivityRow[];
    if (rows.length === 0) return [];

    const mismatchedRows =
      status === "busy" && currentJobId ? rows.filter((row) => row.jobId !== currentJobId) : rows;
    if (mismatchedRows.length === 0) return [];

    const nowMs = Date.parse(now);
    const recoveredJobs: RecoveredStaleJob[] = [];
    const tx = this.db.transaction((claimedRows: ClaimedJobActivityRow[]) => {
      for (const row of claimedRows) {
        const activityMs = parseIsoMs(row.activityAt) ?? parseIsoMs(row.updatedAt) ?? nowMs;
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        if (activityAgeMs < ORPHANED_CLAIM_HEARTBEAT_GRACE_MS) continue;

        const failureMessage = "Job auto-failed after worker heartbeat dropped claimed job";
        const abandonmentMessage = "Job auto-abandoned after worker heartbeat dropped claimed job";
        const detailParts = [
          `worker=${workerId}`,
          `workerStatus=${status}`,
          currentJobId ? `workerCurrentJobId=${currentJobId}` : "workerCurrentJobId=missing",
          `jobId=${row.jobId}`,
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.updatedAt}`,
          `activityAgeMs=${activityAgeMs}`,
          `graceMs=${ORPHANED_CLAIM_HEARTBEAT_GRACE_MS}`,
        ];
        const detail = detailParts.join("; ");
        const recovered = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: workerId,
          recoveryReason: "worker_heartbeat_mismatch",
          failureMessage,
          abandonmentMessage,
          detail,
        });
        if (!recovered) continue;
        recoveredJobs.push(recovered);
      }
    });

    tx(mismatchedRows);
    return recoveredJobs;
  }

  listWorkers(onlineTtlMs: number = 15_000): WorkerRow[] {
    const ttl = Number.isFinite(onlineTtlMs) ? Math.max(1_000, Math.floor(onlineTtlMs)) : 15_000;
    const nowMs = Date.now();

    const rows = this.db
      .prepare(
        `SELECT
           w.workerId,
           w.status,
           w.currentJobId,
           w.pollMs,
           w.capabilities,
           w.details,
           w.lastHeartbeat,
           w.createdAt,
           w.updatedAt,
           COALESCE(claimed.activeJobCount, 0) AS activeJobCount
         FROM workers w
         LEFT JOIN (
           SELECT workerId, COUNT(*) AS activeJobCount
           FROM jobs
           WHERE status = 'claimed'
           GROUP BY workerId
         ) claimed ON claimed.workerId = w.workerId
         ORDER BY w.lastHeartbeat DESC, w.workerId ASC`,
      )
      .all() as WorkerDbRow[];

    return rows.map((row) => {
      const heartbeatMs = Date.parse(row.lastHeartbeat);
      const isOnline = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= ttl;
      return {
        workerId: row.workerId,
        status: row.status,
        currentJobId: row.currentJobId,
        pollMs: row.pollMs,
        capabilities: parseObjectJson(row.capabilities),
        details: parseObjectJson(row.details),
        lastHeartbeat: row.lastHeartbeat,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activeJobCount: Number(row.activeJobCount || 0),
        isOnline,
      };
    });
  }

  private recordJobDiagnostics(
    jobId: string,
    body: Record<string, unknown>,
    status: JobStatus,
    now: string,
    authority?: JobClaimAuthority,
  ): void {
    const diagnostics = recordFromUnknown(body.diagnostics);

    const hasAttempts = Array.isArray(diagnostics?.attempts);
    const hasPhaseSpans = Array.isArray(diagnostics?.phaseSpans);
    const hasValidationRuns = Array.isArray(diagnostics?.validationRuns);
    const hasPatchSnapshots = Array.isArray(diagnostics?.patchSnapshots);
    const attempts = arrayFromUnknown(diagnostics?.attempts)
      .map(recordFromUnknown)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(0, MAX_JOB_DIAGNOSTIC_ATTEMPTS);
    const phaseSpans = arrayFromUnknown(diagnostics?.phaseSpans)
      .map(recordFromUnknown)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(0, MAX_JOB_DIAGNOSTIC_PHASE_SPANS);
    const validationRuns = arrayFromUnknown(diagnostics?.validationRuns)
      .map(recordFromUnknown)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(0, MAX_JOB_DIAGNOSTIC_VALIDATION_RUNS);
    const patchSnapshots = arrayFromUnknown(diagnostics?.patchSnapshots)
      .map(recordFromUnknown)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(0, MAX_JOB_DIAGNOSTIC_PATCH_SNAPSHOTS);
    const terminal = recordFromUnknown(diagnostics?.terminal);

    const tx = this.db.transaction(() => {
      if (authority) {
        const owned = this.db
          .prepare(
            `SELECT 1
             FROM jobs
             WHERE id = ?
               AND status IN ('claimed', 'finalizing')
               AND workerId = ?
               AND COALESCE(claimGeneration, 0) = ?`,
          )
          .get(jobId, authority.workerId, authority.claimGeneration);
        if (!owned) throw new JobClaimAuthorityError();
      }
      if (!diagnostics) return;

      if (hasAttempts) this.db.prepare(`DELETE FROM job_attempts WHERE jobId = ?`).run(jobId);
      if (hasPhaseSpans) this.db.prepare(`DELETE FROM job_phase_spans WHERE jobId = ?`).run(jobId);
      if (hasValidationRuns) {
        this.db.prepare(`DELETE FROM job_validation_runs WHERE jobId = ?`).run(jobId);
      }
      if (hasPatchSnapshots) {
        this.db.prepare(`DELETE FROM job_patch_snapshots WHERE jobId = ?`).run(jobId);
      }
      if (terminal) {
        this.db.prepare(`DELETE FROM job_terminal_diagnostics WHERE jobId = ?`).run(jobId);
      }

      const insertAttempt = this.db.prepare(
        `INSERT INTO job_attempts (
           jobId, attempt, workerId, backend, model, startedAt, finishedAt, durationMs,
           terminalReason, exitCode, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attempt of attempts) {
        insertAttempt.run(
          jobId,
          boundedDbInt(attempt.attempt, 1000) ?? 1,
          diagnosticText(attempt.workerId, 160),
          diagnosticText(attempt.backend, 120),
          diagnosticText(attempt.model, 180),
          diagnosticIso(attempt.startedAt),
          diagnosticIso(attempt.finishedAt),
          boundedDbInt(attempt.durationMs, 30 * 24 * 60 * 60 * 1000),
          diagnosticText(attempt.terminalReason, 1000),
          boundedDbInt(attempt.exitCode, 999),
          diagnosticMetadataJson(attempt.metadata),
          now,
        );
      }

      if (terminal) {
        this.db
          .prepare(
            `INSERT INTO job_terminal_diagnostics (
               jobId, status, failureClass, terminalStage, executorBackend, summary,
               watchdogFired, timeoutMs, publishableFileCount, artifactOnlyPathCount,
               changedPathSampleJson, metadataJson, createdAt, updatedAt
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            jobId,
            status,
            diagnosticText(terminal.failureClass, 160),
            diagnosticText(terminal.terminalStage, 160),
            diagnosticText(terminal.executorBackend, 160),
            diagnosticText(terminal.summary ?? body.summary ?? body.message, 1000),
            boolFromUnknown(terminal.watchdogFired) ? 1 : 0,
            boundedDbInt(terminal.timeoutMs, 30 * 24 * 60 * 60 * 1000),
            boundedDbInt(terminal.publishableFileCount, 100_000),
            boundedDbInt(terminal.artifactOnlyPathCount, 100_000),
            diagnosticStringArrayJson(terminal.changedPathSample),
            diagnosticMetadataJson(terminal.metadata),
            now,
            now,
          );
      }

      const insertPhaseSpan = this.db.prepare(
        `INSERT INTO job_phase_spans (
           jobId, attempt, phase, startedAt, finishedAt, durationMs, outcome, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const span of phaseSpans) {
        const startedAt = diagnosticIso(span.startedAt);
        const finishedAt = diagnosticIso(span.finishedAt);
        const phase = diagnosticText(span.phase, 160);
        if (!startedAt || !finishedAt || !phase) continue;
        insertPhaseSpan.run(
          jobId,
          boundedDbInt(span.attempt, 1000),
          phase,
          startedAt,
          finishedAt,
          boundedDbInt(span.durationMs, 30 * 24 * 60 * 60 * 1000) ?? 0,
          diagnosticText(span.outcome, 160),
          diagnosticMetadataJson(span.metadata),
          now,
        );
      }

      const insertValidationRun = this.db.prepare(
        `INSERT INTO job_validation_runs (
           jobId, attempt, command, exitCode, durationMs, passed, failureClass,
           stdoutTail, stderrTail, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const run of validationRuns) {
        const command = diagnosticText(run.command, 1000);
        if (!command) continue;
        insertValidationRun.run(
          jobId,
          boundedDbInt(run.attempt, 1000),
          command,
          boundedDbInt(run.exitCode, 999),
          boundedDbInt(run.durationMs, 24 * 60 * 60 * 1000),
          boolFromUnknown(run.passed) ? 1 : 0,
          diagnosticText(run.failureClass, 160),
          diagnosticText(run.stdoutTail, 8_000),
          diagnosticText(run.stderrTail, 8_000),
          diagnosticMetadataJson(run.metadata),
          now,
        );
      }

      const insertPatchSnapshot = this.db.prepare(
        `INSERT INTO job_patch_snapshots (
           jobId, attempt, phase, publishableFileCount, artifactOnlyPathCount,
           changedPathSampleJson, topLevelDirsJson, capturedAt, metadataJson, createdAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const snapshot of patchSnapshots) {
        insertPatchSnapshot.run(
          jobId,
          boundedDbInt(snapshot.attempt, 1000),
          diagnosticText(snapshot.phase, 160),
          boundedDbInt(snapshot.publishableFileCount, 100_000),
          boundedDbInt(snapshot.artifactOnlyPathCount, 100_000),
          diagnosticStringArrayJson(snapshot.changedPathSample),
          diagnosticStringArrayJson(snapshot.topLevelDirs, 20),
          diagnosticIso(snapshot.capturedAt),
          diagnosticMetadataJson(snapshot.metadata),
          now,
        );
      }
    });

    tx();
  }

  complete(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): {
    ok: boolean;
    message?: string;
    durationMs?: number;
    completedAt?: string;
    replayed?: boolean;
  } {
    const now = new Date().toISOString();
    const summary = (body.summary as string) ?? null;
    const artifacts = body.artifacts ? JSON.stringify(body.artifacts) : null;
    const prUrl =
      typeof body.prUrl === "string" && body.prUrl.trim().length > 0 ? body.prUrl.trim() : null;
    const prUrlNormalized = normalizePrUrl(prUrl);

    const jobRow = this.db
      .prepare(`SELECT workerId, claimGeneration FROM jobs WHERE id = ?`)
      .get(jobId) as { workerId: string | null; claimGeneration: number | null } | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             result = ?,
             prUrl = COALESCE(?, prUrl),
             prUrlNormalized = COALESCE(?, prUrlNormalized),
             completedAt = ?,
             failedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'
           ${authority ? "AND workerId = ? AND COALESCE(claimGeneration, 0) = ?" : ""}`,
      )
      .run(
        JSON.stringify({ summary, artifacts }),
        prUrl,
        prUrlNormalized,
        now,
        now,
        now,
        jobId,
        ...(authority ? [authority.workerId, authority.claimGeneration] : []),
      );

    if (info.changes === 0) {
      const existing = authority
        ? (this.db
            .prepare(
              `SELECT status, workerId, claimGeneration, durationMs, completedAt
               FROM jobs WHERE id = ?`,
            )
            .get(jobId) as
            | {
                status: JobStatus;
                workerId: string | null;
                claimGeneration: number | null;
                durationMs: number | null;
                completedAt: string | null;
              }
            | undefined)
        : undefined;
      if (
        existing?.status === "completed" &&
        existing.workerId === authority?.workerId &&
        Number(existing.claimGeneration ?? 0) === authority.claimGeneration
      ) {
        return {
          ok: true,
          replayed: true,
          durationMs: existing.durationMs ?? undefined,
          completedAt: existing.completedAt ?? undefined,
        };
      }
      return {
        ok: false,
        message: authority
          ? "Job not found, not claimed, or claim ownership changed"
          : "Job not found or not in claimed state",
      };
    }

    try {
      this.recordJobDiagnostics(jobId, body, "completed", now);
    } catch (error) {
      // Diagnostics are best-effort and must not change terminal job status.
      console.error(
        `[JobQueue] Failed to persist completed diagnostics for ${jobId}: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    }

    const completed = this.db
      .prepare(`SELECT durationMs, completedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          completedAt: string | null;
        }
      | undefined;

    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: completed?.durationMs ?? undefined,
      completedAt: completed?.completedAt ?? undefined,
    };
  }

  fail(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): {
    ok: boolean;
    message?: string;
    durationMs?: number;
    failedAt?: string;
    replayed?: boolean;
  } {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);

    const jobRow = this.db
      .prepare(`SELECT workerId, claimGeneration FROM jobs WHERE id = ?`)
      .get(jobId) as { workerId: string | null; claimGeneration: number | null } | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             availableAt = NULL,
             completedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'
           ${authority ? "AND workerId = ? AND COALESCE(claimGeneration, 0) = ?" : ""}`,
      )
      .run(
        JSON.stringify({ message, detail }),
        now,
        now,
        now,
        jobId,
        ...(authority ? [authority.workerId, authority.claimGeneration] : []),
      );

    if (info.changes === 0) {
      const existing = authority
        ? (this.db
            .prepare(
              `SELECT status, workerId, claimGeneration, durationMs, failedAt
               FROM jobs WHERE id = ?`,
            )
            .get(jobId) as
            | {
                status: JobStatus;
                workerId: string | null;
                claimGeneration: number | null;
                durationMs: number | null;
                failedAt: string | null;
              }
            | undefined)
        : undefined;
      if (
        existing?.status === "failed" &&
        existing.workerId === authority?.workerId &&
        Number(existing.claimGeneration ?? 0) === authority.claimGeneration
      ) {
        return {
          ok: true,
          replayed: true,
          durationMs: existing.durationMs ?? undefined,
          failedAt: existing.failedAt ?? undefined,
        };
      }
      return {
        ok: false,
        message: authority
          ? "Job not found, not claimed, or claim ownership changed"
          : "Job not found or not in claimed state",
      };
    }

    try {
      this.recordJobDiagnostics(jobId, body, "failed", now);
    } catch (error) {
      // Diagnostics are best-effort and must not change terminal job status.
      console.error(
        `[JobQueue] Failed to persist failed diagnostics for ${jobId}: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    }

    const failed = this.db
      .prepare(`SELECT durationMs, failedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          failedAt: string | null;
        }
      | undefined;

    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: failed?.durationMs ?? undefined,
      failedAt: failed?.failedAt ?? undefined,
    };
  }

  publishBlocked(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): {
    ok: boolean;
    message?: string;
    durationMs?: number;
    publishBlockedAt?: string;
    replayed?: boolean;
  } {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Publish blocked");
    const detail = body.detail == null ? null : String(body.detail);
    const publishBlocked = body.publishBlocked ?? null;

    const jobRow = this.db
      .prepare(`SELECT workerId, claimGeneration FROM jobs WHERE id = ?`)
      .get(jobId) as { workerId: string | null; claimGeneration: number | null } | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'publish_blocked',
             error = ?,
             publishBlockedAt = ?,
             availableAt = NULL,
             completedAt = NULL,
             failedAt = NULL,
             abandonedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'
           ${authority ? "AND workerId = ? AND COALESCE(claimGeneration, 0) = ?" : ""}`,
      )
      .run(
        JSON.stringify({ message, detail, publishBlocked }),
        now,
        now,
        now,
        jobId,
        ...(authority ? [authority.workerId, authority.claimGeneration] : []),
      );

    if (info.changes === 0) {
      const existing = authority
        ? (this.db
            .prepare(
              `SELECT status, workerId, claimGeneration, durationMs, publishBlockedAt
               FROM jobs WHERE id = ?`,
            )
            .get(jobId) as
            | {
                status: JobStatus;
                workerId: string | null;
                claimGeneration: number | null;
                durationMs: number | null;
                publishBlockedAt: string | null;
              }
            | undefined)
        : undefined;
      if (
        existing?.status === "publish_blocked" &&
        existing.workerId === authority?.workerId &&
        Number(existing.claimGeneration ?? 0) === authority.claimGeneration
      ) {
        return {
          ok: true,
          replayed: true,
          durationMs: existing.durationMs ?? undefined,
          publishBlockedAt: existing.publishBlockedAt ?? undefined,
        };
      }
      return {
        ok: false,
        message: authority
          ? "Job not found, not claimed, or claim ownership changed"
          : "Job not found or not in claimed state",
      };
    }

    try {
      this.recordJobDiagnostics(jobId, body, "publish_blocked", now);
    } catch (error) {
      // Diagnostics are best-effort and must not change terminal job status.
      console.error(
        `[JobQueue] Failed to persist publish-blocked diagnostics for ${jobId}: ${
          error instanceof Error ? error.stack || error.message : String(error)
        }`,
      );
    }

    const blocked = this.db
      .prepare(`SELECT durationMs, publishBlockedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          publishBlockedAt: string | null;
        }
      | undefined;

    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: blocked?.durationMs ?? undefined,
      publishBlockedAt: blocked?.publishBlockedAt ?? undefined,
    };
  }

  defer(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): {
    ok: boolean;
    code?: JobDeferralResultCode;
    message?: string;
    availableAt?: string;
    replayed?: boolean;
  } {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    if (authority && authority.workerId !== workerId) {
      return {
        ok: false,
        code: JOB_DEFERRAL_CONFLICT_CODE,
        message: "Job not found, not claimed, or claim ownership changed",
      };
    }
    const now = new Date().toISOString();
    const deferMsRaw = Number.parseInt(String(body.deferMs ?? ""), 10);
    const deferMs = Number.isFinite(deferMsRaw)
      ? Math.max(1_000, Math.min(deferMsRaw, 30 * 60_000))
      : 60_000;
    const availableAt = new Date(Date.now() + deferMs).toISOString();
    const deferReason = diagnosticText(body.reason, 160);
    const targetWorkerId =
      body.targetWorkerId === null
        ? null
        : typeof body.targetWorkerId === "string" && body.targetWorkerId.trim().length > 0
          ? body.targetWorkerId.trim()
          : workerId;
    const detail = diagnosticText(body.detail, 2_000);
    let fingerprint = "";
    if (detail) {
      try {
        const parsed = JSON.parse(detail) as Record<string, unknown>;
        fingerprint = diagnosticText(parsed.fingerprint, 80) ?? "";
      } catch {
        // Keep a reason-only key for non-JSON maintenance detail.
      }
    }

    type DeferResult = {
      ok: boolean;
      code?: JobDeferralResultCode;
      message?: string;
      availableAt?: string;
      replayed?: boolean;
    };
    const persistDeferral = this.db.transaction((): DeferResult => {
      const claimed = this.db
        .prepare(
          `SELECT claimGeneration
           FROM jobs
           WHERE id = ? AND status = 'claimed' AND workerId = ?
             ${authority ? "AND COALESCE(claimGeneration, 0) = ?" : ""}`,
        )
        .get(jobId, workerId, ...(authority ? [authority.claimGeneration] : [])) as
        | { claimGeneration: number | null }
        | undefined;
      if (!claimed) {
        if (authority) {
          const existing = this.db
            .prepare(
              `SELECT status, claimGeneration, targetWorkerId, deferredByWorkerId, availableAt
               FROM jobs WHERE id = ?`,
            )
            .get(jobId) as
            | {
                status: JobStatus;
                claimGeneration: number | null;
                targetWorkerId: string | null;
                deferredByWorkerId: string | null;
                availableAt: string | null;
              }
            | undefined;
          if (
            existing?.status === "pending" &&
            Number(existing.claimGeneration ?? 0) === authority.claimGeneration &&
            existing.deferredByWorkerId === authority.workerId &&
            existing.availableAt &&
            existing.targetWorkerId === targetWorkerId
          ) {
            return { ok: true, availableAt: existing.availableAt, replayed: true };
          }
        }
        return {
          ok: false,
          code: JOB_DEFERRAL_CONFLICT_CODE,
          message: authority
            ? "Job not found, not claimed, or claim ownership changed"
            : "Job not found, not claimed, or not owned by worker",
        };
      }

      const info = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'pending',
               workerId = NULL,
               targetWorkerId = ?,
               deferredByWorkerId = ?,
               claimedAt = NULL,
               startedAt = NULL,
               firstLogAt = NULL,
               availableAt = ?,
               deferReason = ?,
               deferredAt = ?,
               updatedAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND workerId = ?
             ${authority ? "AND COALESCE(claimGeneration, 0) = ?" : ""}`,
        )
        .run(
          targetWorkerId,
          workerId,
          availableAt,
          deferReason,
          now,
          now,
          jobId,
          workerId,
          ...(authority ? [authority.claimGeneration] : []),
        );

      if (info.changes === 0) {
        return {
          ok: false,
          code: JOB_DEFERRAL_CONFLICT_CODE,
          message: authority
            ? "Job not found, not claimed, or claim ownership changed"
            : "Job not found, not claimed, or not owned by worker",
        };
      }

      if (detail) {
        const circuitDeferral = deferReason === "worker_runtime_circuit_open";
        const logResult = this.insertJobLog(jobId, `[JobQueue] Deferred: ${detail}`, now, {
          claimGeneration: Number(claimed.claimGeneration ?? 0),
          ...(circuitDeferral
            ? {
                category: "deferral",
                dedupeKey: `${deferReason}:${fingerprint || "runtime"}`,
                dedupeWindowMs: WORKER_RUNTIME_DEFERRAL_LOG_DEDUPE_MS,
                retain: WORKER_RUNTIME_DEFERRAL_LOG_RETAIN,
              }
            : {}),
        });
        if (!logResult.ok) {
          throw new Error(logResult.message ?? "Failed to persist deferral log");
        }
      }
      return { ok: true, availableAt };
    });

    let result: DeferResult;
    try {
      result = persistDeferral();
    } catch (error) {
      return {
        ok: false,
        code: JOB_DEFERRAL_PERSISTENCE_FAILED_CODE,
        message: `Failed to persist job deferral: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!result.ok || result.replayed) return result;
    this.setWorkerIdleIfNoClaimedJobs(workerId, now);
    return result;
  }

  failDeferred(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): {
    ok: boolean;
    code?: JobDeferralResultCode;
    message?: string;
    failedAt?: string;
    replayed?: boolean;
  } {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    if (authority && authority.workerId !== workerId) {
      return {
        ok: false,
        code: JOB_DEFERRAL_CONFLICT_CODE,
        message: "Deferred job not found or claim ownership changed",
      };
    }
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             availableAt = NULL,
             deferReason = NULL,
             deferredAt = NULL,
             targetWorkerId = NULL,
             completedAt = NULL,
             durationMs = NULL,
             updatedAt = ?
         WHERE id = ?
           AND status = 'pending'
           AND availableAt IS NOT NULL
           ${
             authority
               ? "AND deferredByWorkerId = ? AND COALESCE(claimGeneration, 0) = ?"
               : "AND targetWorkerId = ?"
           }`,
      )
      .run(
        JSON.stringify({ message, detail }),
        now,
        now,
        jobId,
        ...(authority ? [authority.workerId, authority.claimGeneration] : [workerId]),
      );

    if (info.changes === 0) {
      const existing = authority
        ? (this.db
            .prepare(
              `SELECT status, claimGeneration, deferredByWorkerId, failedAt
               FROM jobs WHERE id = ?`,
            )
            .get(jobId) as
            | {
                status: JobStatus;
                claimGeneration: number | null;
                deferredByWorkerId: string | null;
                failedAt: string | null;
              }
            | undefined)
        : undefined;
      if (
        existing?.status === "failed" &&
        Number(existing.claimGeneration ?? 0) === authority?.claimGeneration &&
        existing.deferredByWorkerId === authority?.workerId
      ) {
        return { ok: true, failedAt: existing.failedAt ?? undefined, replayed: true };
      }
      return {
        ok: false,
        code: JOB_DEFERRAL_CONFLICT_CODE,
        message: authority
          ? "Deferred job not found or claim ownership changed"
          : "Deferred job not found or not owned by worker",
      };
    }

    return { ok: true, failedAt: now };
  }

  shortenWorkerRuntimeCircuitDeferrals(
    options: {
      maxDelayMs?: number;
      nowMs?: number;
      limit?: number;
    } = {},
  ): {
    shortened: number;
    jobIds: string[];
    unreportedJobIds: number;
    availableAt: string;
  } {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const maxDelayMs = Math.max(
      1_000,
      Math.min(
        WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT,
        Math.floor(options.maxDelayMs ?? WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT),
      ),
    );
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 500)));
    const availableAt = new Date(nowMs + maxDelayMs).toISOString();
    const now = new Date(nowMs).toISOString();
    const shorten = this.db.transaction(() => {
      // Keep the returned ID list bounded for startup observability, then let
      // SQLite shorten every remaining durable deferral in one set operation.
      // The option historically named `limit` now limits only reported IDs;
      // it must never cap restart recovery itself.
      const rows = this.db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'pending'
             AND availableAt > ?
             AND (
               deferReason = 'worker_runtime_circuit_open'
               OR EXISTS (
                 SELECT 1
                 FROM job_logs jl
                 WHERE jl.jobId = jobs.id
                   AND jl.message LIKE '%worker_runtime_circuit_open%'
               )
             )
           ORDER BY COALESCE(deferredAt, updatedAt, createdAt) ASC
           LIMIT ?`,
        )
        .all(availableAt, limit) as Array<{ id: string }>;
      if (rows.length === 0) {
        return { shortened: 0, jobIds: [], unreportedJobIds: 0, availableAt };
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      const reportedRows = this.db
        .prepare(
          `UPDATE jobs
           SET availableAt = ?, updatedAt = ?
           WHERE id IN (${placeholders})
             AND status = 'pending'
             AND availableAt > ?
           RETURNING id`,
        )
        .all(availableAt, now, ...ids, availableAt) as Array<{ id: string }>;
      const unreported = this.db
        .prepare(
          `UPDATE jobs
           SET availableAt = ?, updatedAt = ?
           WHERE status = 'pending'
             AND availableAt > ?
             AND (
               deferReason = 'worker_runtime_circuit_open'
               OR EXISTS (
                 SELECT 1
                 FROM job_logs jl
                 WHERE jl.jobId = jobs.id
                   AND jl.message LIKE '%worker_runtime_circuit_open%'
               )
             )`,
        )
        .run(availableAt, now, availableAt);
      return {
        shortened: reportedRows.length + unreported.changes,
        jobIds: reportedRows.map((row) => row.id),
        unreportedJobIds: unreported.changes,
        availableAt,
      };
    });
    return shorten();
  }

  releaseWorkerRuntimeCircuitDeferrals(nowMs = Date.now()): {
    released: number;
    jobIds: string[];
  } {
    const now = new Date(nowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE status = 'pending'
           AND deferReason = 'worker_runtime_circuit_open'
         ORDER BY COALESCE(deferredAt, updatedAt, createdAt) ASC
         LIMIT 1000`,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return { released: 0, jobIds: [] };
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET availableAt = ?, deferReason = NULL, deferredAt = NULL, updatedAt = ?
         WHERE status = 'pending'
           AND deferReason = 'worker_runtime_circuit_open'`,
      )
      .run(now, now);
    return {
      released: result.changes,
      jobIds: rows.slice(0, result.changes).map((row) => row.id),
    };
  }

  recoverStaleClaimedJobs(staleAfterMs: number, limit = 100): RecoveredStaleJob[] {
    const ttlMs = Number.isFinite(staleAfterMs)
      ? Math.max(5_000, Math.floor(staleAfterMs))
      : 120_000;
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const cutoff = new Date(nowMs - ttlMs).toISOString();

    type StaleCandidate = {
      jobId: string;
      taskId: string;
      sessionId: string;
      executionBudgetMs: number | null;
      finalizationBudgetMs: number | null;
      workerId: string | null;
      workerStatus: string | null;
      workerCurrentJobId: string | null;
      workerLastHeartbeat: string | null;
      jobUpdatedAt: string;
      lastLogTs: string | null;
      activityAt: string;
    };

    const candidates = this.db
      .prepare(
        `SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.executionBudgetMs AS executionBudgetMs,
           j.finalizationBudgetMs AS finalizationBudgetMs,
           j.workerId AS workerId,
           w.status AS workerStatus,
           w.currentJobId AS workerCurrentJobId,
           w.lastHeartbeat AS workerLastHeartbeat,
           j.updatedAt AS jobUpdatedAt,
           NULL AS lastLogTs,
           j.lastActivityAt AS activityAt
         FROM jobs j
         LEFT JOIN workers w ON w.workerId = j.workerId
         WHERE j.status = 'claimed'
           AND j.lastActivityAt IS NOT NULL
           AND j.lastActivityAt <= ?
           AND (
             j.workerId IS NULL
             OR w.status IS NULL
             OR w.status <> 'busy'
             OR w.currentJobId IS NULL
             OR w.currentJobId <> j.id
             OR julianday(w.lastHeartbeat) IS NULL
             OR julianday(w.lastHeartbeat) > julianday(?)
             OR julianday(w.lastHeartbeat) <= julianday(?)
           )
         ORDER BY j.lastActivityAt ASC, j.id ASC
         LIMIT ?`,
      )
      .all(cutoff, now, cutoff, maxRows) as StaleCandidate[];

    if (candidates.length > 0) {
      const latestLog = this.db.prepare(
        `SELECT ts
         FROM job_logs
         WHERE jobId = ?
           AND julianday(ts) IS NOT NULL
           AND julianday(ts) <= julianday(?)
         ORDER BY julianday(ts) DESC, id DESC
         LIMIT 1`,
      );
      for (const row of candidates) {
        const log = latestLog.get(row.jobId, now) as { ts: string | null } | undefined;
        row.lastLogTs = log?.ts ?? null;
      }
    }

    if (candidates.length === 0) return [];

    const recovered: RecoveredStaleJob[] = [];

    const tx = this.db.transaction((rows: StaleCandidate[]) => {
      for (const row of rows) {
        if (recovered.length >= maxRows) break;
        const activityMs = parseIsoMs(row.activityAt) ?? nowMs;
        const parsedHeartbeatMs = parseIsoMs(row.workerLastHeartbeat);
        const heartbeatMs =
          parsedHeartbeatMs != null && parsedHeartbeatMs <= nowMs ? parsedHeartbeatMs : null;
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        const heartbeatAgeMs =
          heartbeatMs == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - heartbeatMs);

        const workerAligned =
          !!row.workerId && row.workerStatus === "busy" && row.workerCurrentJobId === row.jobId;

        const executionBudgetMs =
          typeof row.executionBudgetMs === "number" && Number.isFinite(row.executionBudgetMs)
            ? Math.max(5_000, Math.floor(row.executionBudgetMs))
            : JOB_EXECUTION_BUDGET_MS.normal;
        const finalizationBudgetMs =
          typeof row.finalizationBudgetMs === "number" && Number.isFinite(row.finalizationBudgetMs)
            ? Math.max(5_000, Math.floor(row.finalizationBudgetMs))
            : JOB_FINALIZATION_BUDGET_MS_DEFAULT;
        const combinedBudgetMs = executionBudgetMs + finalizationBudgetMs;

        // Busy workers assigned to the current job are given a longer grace window
        // before stale recovery kicks in, but only while heartbeat freshness indicates
        // the worker is still alive. If heartbeat is already stale, fall back to base TTL.
        const alignedGraceMs = Math.max(ttlMs, Math.min(combinedBudgetMs, ttlMs * 5));
        const heartbeatFreshForGrace =
          heartbeatMs != null &&
          Number.isFinite(heartbeatMs) &&
          !Number.isNaN(heartbeatMs) &&
          heartbeatAgeMs <= ttlMs;
        const effectiveStaleAfterMs =
          workerAligned && heartbeatFreshForGrace ? alignedGraceMs : ttlMs;
        if (activityAgeMs < effectiveStaleAfterMs) continue;
        if (workerAligned && heartbeatAgeMs < effectiveStaleAfterMs) continue;

        const failureMessage = "Job auto-failed after stale worker claim";
        const abandonmentMessage = "Job auto-abandoned after stale worker claim";
        const detailParts = [
          row.workerId ? `worker=${row.workerId}` : "worker=missing",
          row.workerStatus ? `workerStatus=${row.workerStatus}` : "workerStatus=missing",
          row.workerCurrentJobId
            ? `workerCurrentJobId=${row.workerCurrentJobId}`
            : "workerCurrentJobId=missing",
          row.workerLastHeartbeat
            ? `lastHeartbeat=${row.workerLastHeartbeat}`
            : "lastHeartbeat=missing",
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.jobUpdatedAt}`,
          `workerAligned=${workerAligned ? "yes" : "no"}`,
          `heartbeatFreshForGrace=${heartbeatFreshForGrace ? "yes" : "no"}`,
          `activityAgeMs=${activityAgeMs}`,
          `heartbeatAgeMs=${Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : -1}`,
          `staleAfterMs=${ttlMs}`,
          `effectiveStaleAfterMs=${effectiveStaleAfterMs}`,
        ];
        const detail = detailParts.join("; ");
        const recoveredItem = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: row.workerId,
          recoveryReason: "stale_worker_claim",
          failureMessage,
          abandonmentMessage,
          detail,
        });
        if (!recoveredItem) continue;

        if (row.workerId) {
          const staleHeartbeat =
            heartbeatMs == null ||
            !Number.isFinite(heartbeatMs) ||
            Number.isNaN(heartbeatMs) ||
            heartbeatMs < Date.parse(cutoff);
          const nextStatus: WorkerStatus = staleHeartbeat ? "offline" : "error";
          this.db
            .prepare(
              `UPDATE workers
               SET status = ?,
                   currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                   updatedAt = ?
               WHERE workerId = ?`,
            )
            .run(nextStatus, row.jobId, now, row.workerId);
        }

        recovered.push(recoveredItem);
      }
    });

    tx(candidates);
    return recovered;
  }

  private setWorkerIdleIfNoClaimedJobs(workerId: string | null, now: string): void {
    if (!workerId) return;
    const active = this.db
      .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE workerId = ? AND status = 'claimed'`)
      .get(workerId) as { c: number } | undefined;
    if ((active?.c ?? 0) > 0) return;

    this.db
      .prepare(
        `UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
         WHERE workerId = ?`,
      )
      .run(now, now, workerId);
  }

  setPrUrl(jobId: string, prUrl: string | null | undefined): { ok: boolean; message?: string } {
    const persistedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    const normalizedPrUrl = normalizePrUrl(persistedPrUrl);
    if (!persistedPrUrl || !normalizedPrUrl) {
      return { ok: false, message: "prUrl is required" };
    }
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET prUrl = COALESCE(?, prUrl),
             prUrlNormalized = COALESCE(?, prUrlNormalized),
             updatedAt = ?
         WHERE id = ?`,
      )
      .run(persistedPrUrl, normalizedPrUrl, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found" };
    }
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    return { ok: true };
  }

  getJob(jobId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as JobRow) ?? null;
  }

  getPendingJobs(): JobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`,
      )
      .all() as JobRow[];
  }

  listJobs(options?: { status?: JobStatus | "all"; limit?: number }): JobRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      return this.db
        .prepare(`SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?`)
        .all(limit) as JobRow[];
    }

    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY createdAt DESC LIMIT ?`)
      .all(status, limit) as JobRow[];
  }

  countByStatus(): Record<JobStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`)
      .all() as Array<{ status: JobStatus; count: number }>;

    const counts: Record<JobStatus, number> = {
      pending: 0,
      claimed: 0,
      finalizing: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      publish_blocked: 0,
    };
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = Number(row.count || 0);
    }
    return counts;
  }

  countByPriority(): Record<JobPriority, number> {
    const rows = this.db
      .prepare(
        `SELECT priority, COUNT(*) AS count
         FROM jobs
         WHERE status IN ('pending', 'claimed', 'finalizing')
         GROUP BY priority`,
      )
      .all() as Array<{ priority: string; count: number }>;

    const counts: Record<JobPriority, number> = {
      interactive: 0,
      normal: 0,
      background: 0,
    };
    for (const row of rows) {
      const priority = normalizeJobPriority(row.priority);
      counts[priority] = Number(row.count || 0);
    }
    return counts;
  }

  countByKindAndStatus(kind: string, statuses: JobStatus | JobStatus[]): number {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind) return 0;
    const requestedStatuses = Array.isArray(statuses) ? statuses : [statuses];
    const normalizedStatuses = [
      ...new Set(requestedStatuses.map((status) => String(status).trim())),
    ].filter(
      (status) =>
        status === "pending" ||
        status === "claimed" ||
        status === "finalizing" ||
        status === "completed" ||
        status === "failed" ||
        status === "abandoned" ||
        status === "publish_blocked",
    );
    if (normalizedStatuses.length === 0) return 0;
    const placeholders = normalizedStatuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status IN (${placeholders})`,
      )
      .get(normalizedKind, ...normalizedStatuses) as { count: number } | undefined;
    return Number(row?.count || 0);
  }

  countAutoscalablePendingByKind(kind: string): number {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind) return 0;
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )`,
      )
      .get(normalizedKind, now, targetWorkerCutoff) as { count: number } | undefined;
    return Number(row?.count || 0);
  }

  listWorkerPrBacklog(limit = 200): WorkerPrBacklogEntry[] {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(2_000, Math.floor(limit))) : 200;
    const latestJobs = new Map<
      string,
      {
        prUrl: string;
        latestJobId: string;
        latestJobStatus: JobStatus;
        latestJobAt: string;
      }
    >();
    const jobRows = this.db
      .prepare(
        `WITH ranked_jobs AS (
           SELECT
             id,
             prUrl,
             status,
             updatedAt AS latestJobAt,
             ROW_NUMBER() OVER (
               PARTITION BY prUrlNormalized
               ORDER BY datetime(updatedAt) DESC, rowid DESC
             ) AS prRank
           FROM jobs
           WHERE prUrl IS NOT NULL
             AND TRIM(prUrl) <> ''
             AND prUrlNormalized IS NOT NULL
             AND TRIM(prUrlNormalized) <> ''
         )
         SELECT id, prUrl, status, latestJobAt
         FROM ranked_jobs
         WHERE prRank = 1
         ORDER BY datetime(latestJobAt) DESC, id DESC
         LIMIT ?`,
      )
      .all(maxRows) as Array<{
      id: string;
      prUrl: string | null;
      status: JobStatus;
      latestJobAt: string;
    }>;

    for (const row of jobRows) {
      const normalizedPrUrl = normalizePrUrl(row.prUrl);
      if (!normalizedPrUrl || latestJobs.has(normalizedPrUrl)) continue;
      latestJobs.set(normalizedPrUrl, {
        prUrl: String(row.prUrl ?? "").trim(),
        latestJobId: row.id,
        latestJobStatus: row.status,
        latestJobAt: row.latestJobAt,
      });
    }

    const latestFeedbackByPr = new Map<
      string,
      {
        verdict: string | null;
        createdAt: string | null;
        jobId: string | null;
        merged: boolean;
      }
    >();
    const readProviderOutcome = this.db.prepare(
      `SELECT verdict, updatedAt, jobId, merged
       FROM pr_provider_outcomes
       WHERE normalizedPrUrl = ?
         AND terminal = 1
       LIMIT 1`,
    );
    let readAutonomyFeedback: ReturnType<Database["prepare"]> | null = null;
    try {
      readAutonomyFeedback = this.db.prepare(
        `SELECT verdict, created_at AS createdAt, job_id AS jobId
         FROM autonomy_pr_feedback
         WHERE pr_url_normalized = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      );
    } catch {
      // autonomy_pr_feedback may not exist in isolated JobQueue tests.
    }
    for (const normalizedPrUrl of latestJobs.keys()) {
      const provider = readProviderOutcome.get(normalizedPrUrl) as
        | {
            verdict: string | null;
            updatedAt: string | null;
            jobId: string | null;
            merged: number;
          }
        | undefined;
      if (provider) {
        latestFeedbackByPr.set(normalizedPrUrl, {
          verdict: provider.verdict ? String(provider.verdict).trim() : null,
          createdAt: provider.updatedAt ? String(provider.updatedAt).trim() : null,
          jobId: provider.jobId ? String(provider.jobId).trim() : null,
          merged: Number(provider.merged) === 1,
        });
        continue;
      }
      const feedback = readAutonomyFeedback?.get(normalizedPrUrl) as
        | { verdict: string | null; createdAt: string | null; jobId: string | null }
        | undefined;
      if (!feedback) continue;
      latestFeedbackByPr.set(normalizedPrUrl, {
        verdict: feedback.verdict ? String(feedback.verdict).trim() : null,
        createdAt: feedback.createdAt ? String(feedback.createdAt).trim() : null,
        jobId: feedback.jobId ? String(feedback.jobId).trim() : null,
        merged: isMergedPrFeedbackVerdict(feedback.verdict),
      });
    }

    const entries: WorkerPrBacklogEntry[] = [];
    for (const [normalizedPrUrl, job] of latestJobs.entries()) {
      const feedbackCandidate = latestFeedbackByPr.get(normalizedPrUrl);
      const feedback =
        feedbackCandidate &&
        (feedbackCandidate.merged || feedbackCandidate.jobId === job.latestJobId)
          ? feedbackCandidate
          : undefined;
      const latestFeedbackVerdict = feedback?.verdict ?? null;
      const mergeState: WorkerPrMergeState = isMergedPrFeedbackVerdict(latestFeedbackVerdict)
        ? "merged"
        : isClosedPrFeedbackVerdict(latestFeedbackVerdict)
          ? "closed_unmerged"
          : "open_unmerged";
      entries.push({
        prUrl: job.prUrl,
        normalizedPrUrl,
        latestJobId: job.latestJobId,
        latestJobStatus: job.latestJobStatus,
        latestJobAt: job.latestJobAt,
        latestFeedbackVerdict,
        latestFeedbackAt: feedback?.createdAt ?? null,
        mergeState,
      });
    }
    return entries.slice(0, maxRows);
  }

  listPersistedPrLinksPage(
    options: {
      limit?: number;
      beforeCursor?: number | null;
    } = {},
  ): PersistedPrLinkRow[] {
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(101, Math.floor(options.limit ?? 50)))
      : 50;
    const beforeCursor =
      typeof options.beforeCursor === "number" &&
      Number.isSafeInteger(options.beforeCursor) &&
      options.beforeCursor > 0
        ? options.beforeCursor
        : null;
    const cursorFilter = beforeCursor === null ? "" : "AND jobs.rowid < ?";
    const args = beforeCursor === null ? [limit] : [beforeCursor, limit];
    return this.db
      .prepare(
        `SELECT
           jobs.rowid AS cursor,
           jobs.id AS jobId,
           jobs.sessionId AS sessionId,
           jobs.prUrl AS prUrl,
           COALESCE(jobs.completedAt, jobs.updatedAt, jobs.createdAt) AS updatedAt
         FROM jobs
         WHERE jobs.status = 'completed'
           AND jobs.prUrl IS NOT NULL
           AND TRIM(jobs.prUrl) <> ''
           AND jobs.prUrlNormalized IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM pr_provider_outcomes provider
             WHERE provider.normalizedPrUrl = jobs.prUrlNormalized
               AND provider.terminal = 1
               AND (
                 provider.merged = 1
                 OR EXISTS (
                   SELECT 1
                   FROM jobs authority_job
                   WHERE authority_job.id = provider.jobId
                     AND authority_job.rowid >= jobs.rowid
                 )
               )
           )
           ${cursorFilter}
         ORDER BY jobs.rowid DESC
         LIMIT ?`,
      )
      .all(...args) as PersistedPrLinkRow[];
  }

  countOpenUnmergedWorkerPrs(limit = 500): number {
    return this.listWorkerPrBacklog(limit).filter((entry) => entry.mergeState === "open_unmerged")
      .length;
  }

  nextPendingSnapshot(
    limit = 10,
  ): Array<{ id: string; priority: JobPriority; position: number; etaMs: number }> {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.db.prepare(`SELECT priority FROM jobs WHERE id = ?`).get(id) as
        | { priority: string }
        | undefined;
      const priority = normalizeJobPriority(row?.priority);
      return {
        id,
        priority,
        position: idx + 1,
        etaMs: this.estimateEtaMs(priority, idx + 1) ?? 0,
      };
    });
  }

  sloSummary(windowHours = 24): JobSloSummary {
    const boundedWindowHours =
      Number.isFinite(windowHours) && windowHours > 0
        ? Math.max(1, Math.min(24 * 30, Math.floor(windowHours)))
        : 24;
    const cutoffIso = new Date(Date.now() - boundedWindowHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT status, durationMs, enqueuedAt, claimedAt, createdAt, updatedAt, error
         FROM jobs
         WHERE status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
           AND updatedAt >= ?`,
      )
      .all(cutoffIso) as Array<{
      status: JobStatus;
      durationMs: number | null;
      enqueuedAt: string | null;
      claimedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
      error: string | null;
    }>;

    let completed = 0;
    let failed = 0;
    let abandoned = 0;
    let publishBlocked = 0;
    let timeoutFailures = 0;
    const durationSamples: number[] = [];
    const queueWaitSamples: number[] = [];

    for (const row of rows) {
      if (row.status === "completed") completed += 1;
      if (
        row.status === "failed" ||
        row.status === "abandoned" ||
        row.status === "publish_blocked"
      ) {
        if (row.status === "failed") failed += 1;
        if (row.status === "abandoned") abandoned += 1;
        if (row.status === "publish_blocked") publishBlocked += 1;
        if (isTimeoutFailureError(row.error)) timeoutFailures += 1;
      }
      if (
        typeof row.durationMs === "number" &&
        Number.isFinite(row.durationMs) &&
        row.durationMs >= 0
      ) {
        durationSamples.push(Math.round(row.durationMs));
      }
      const queueStart = parseIsoMs(row.enqueuedAt) ?? parseIsoMs(row.createdAt) ?? null;
      const queueEnd = parseIsoMs(row.claimedAt) ?? parseIsoMs(row.updatedAt) ?? null;
      if (queueStart != null && queueEnd != null && queueEnd >= queueStart) {
        queueWaitSamples.push(queueEnd - queueStart);
      }
    }

    const terminal = completed + failed + abandoned + publishBlocked;
    const successRate = terminal > 0 ? Number((completed / terminal).toFixed(4)) : null;
    const timeoutRate = terminal > 0 ? Number((timeoutFailures / terminal).toFixed(4)) : null;

    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      abandoned,
      publishBlocked,
      timeoutFailures,
      successRate,
      timeoutRate,
      durationMs: summarizeSamples(durationSamples),
      queueWaitMs: summarizeSamples(queueWaitSamples),
    };
  }

  noPublishableFailureCircuitSummary(options?: {
    windowMs?: number;
    threshold?: number;
    failureRateThreshold?: number;
  }): NoPublishableFailureCircuitSummary {
    const windowMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 60 * 60 * 1000)),
    );
    const threshold = Math.max(1, Math.min(100, Math.floor(options?.threshold ?? 3)));
    const failureRateThreshold = Math.max(
      0,
      Math.min(1, Number(options?.failureRateThreshold ?? 0.5)),
    );
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS terminalCount,
           SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
           SUM(
             CASE
               WHEN j.status = 'failed'
                AND NOT (
                  d.failureClass = 'codex_startup_stall'
                  OR d.summary LIKE '%stalled before first response%'
                  OR d.summary LIKE '%startup stall%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%stalled before first response%'
                        OR a.terminalReason LIKE '%startup stall%'
                      )
                  )
                )
                AND (
                  d.failureClass = 'artifact_only_no_publishable_patch'
                  OR d.summary LIKE '%no publishable changes%'
                  OR d.summary LIKE '%no publishable file changes%'
                  OR d.summary LIKE '%no-edit watchdog%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%no publishable changes%'
                        OR a.terminalReason LIKE '%no publishable file changes%'
                        OR a.terminalReason LIKE '%no-edit watchdog%'
                      )
                  )
                )
               THEN 1
               ELSE 0
             END
           ) AS noPublishableFailureCount,
           MAX(
             CASE
               WHEN j.status = 'failed'
                AND NOT (
                  d.failureClass = 'codex_startup_stall'
                  OR d.summary LIKE '%stalled before first response%'
                  OR d.summary LIKE '%startup stall%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%stalled before first response%'
                        OR a.terminalReason LIKE '%startup stall%'
                      )
                  )
                )
                AND (
                  d.failureClass = 'artifact_only_no_publishable_patch'
                  OR d.summary LIKE '%no publishable changes%'
                  OR d.summary LIKE '%no publishable file changes%'
                  OR d.summary LIKE '%no-edit watchdog%'
                  OR EXISTS (
                    SELECT 1
                    FROM job_attempts a
                    WHERE a.jobId = j.id
                      AND (
                        a.terminalReason LIKE '%no publishable changes%'
                        OR a.terminalReason LIKE '%no publishable file changes%'
                        OR a.terminalReason LIKE '%no-edit watchdog%'
                      )
                  )
                )
               THEN COALESCE(j.failedAt, d.updatedAt, j.updatedAt)
               ELSE NULL
             END
           ) AS lastFailureAt
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
           AND j.updatedAt >= ?`,
      )
      .get(cutoffIso) as
      | {
          terminalCount: number | null;
          completedCount: number | null;
          noPublishableFailureCount: number | null;
          lastFailureAt: string | null;
        }
      | undefined;

    const terminalCount = Math.max(0, Number(row?.terminalCount ?? 0));
    const noPublishableFailureCount = Math.max(0, Number(row?.noPublishableFailureCount ?? 0));
    const completedCount = Math.max(0, Number(row?.completedCount ?? 0));
    const noPublishableFailureRate =
      terminalCount > 0 ? Number((noPublishableFailureCount / terminalCount).toFixed(4)) : 0;

    return {
      blocked:
        noPublishableFailureCount >= threshold && noPublishableFailureRate >= failureRateThreshold,
      windowMs,
      threshold,
      failureRateThreshold,
      terminalCount,
      noPublishableFailureCount,
      noPublishableFailureRate,
      completedCount,
      lastFailureAt: row?.lastFailureAt ?? null,
    };
  }

  private getWorkerRuntimeCircuit(runtimeGeneration: string): WorkerRuntimeCircuitRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM worker_runtime_circuits WHERE runtimeGeneration = ?`)
        .get(runtimeGeneration) as WorkerRuntimeCircuitRow | undefined) ?? null
    );
  }

  workerRuntimeFailureCircuitSummary(options?: {
    windowMs?: number;
    maxBlockMs?: number;
    threshold?: number;
    nowMs?: number;
    notBeforeMs?: number;
    runtimeGeneration?: string;
  }): WorkerRuntimeFailureCircuitSummary {
    const nowMs = Number.isFinite(options?.nowMs) ? Number(options?.nowMs) : Date.now();
    const now = new Date(nowMs).toISOString();
    const windowMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 60 * 60 * 1000)),
    );
    const blockDurationMs = Math.max(
      60_000,
      Math.min(windowMs, Math.floor(options?.maxBlockMs ?? 30 * 60 * 1000)),
    );
    const threshold = Math.max(2, Math.min(20, Math.floor(options?.threshold ?? 2)));
    const notBeforeMs = Number.isFinite(options?.notBeforeMs)
      ? Math.floor(Number(options?.notBeforeMs))
      : Number.NEGATIVE_INFINITY;
    const runtimeGeneration = normalizeWorkerRuntimeGeneration(options?.runtimeGeneration);
    const circuitBefore = this.getWorkerRuntimeCircuit(runtimeGeneration);
    const recoveredAtMs =
      circuitBefore?.state === "closed"
        ? (parseIsoMs(circuitBefore.recoveredAt) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
    const cutoffIso = new Date(
      Math.max(nowMs - windowMs, notBeforeMs, recoveredAtMs),
    ).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           j.error,
           COALESCE(j.failedAt, j.abandonedAt, d.updatedAt, j.updatedAt) AS failureAt,
           d.failureClass,
           d.terminalStage,
           d.executorBackend,
           d.summary
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('failed', 'abandoned')
           AND COALESCE(j.runtimeGeneration, ?) = ?
           AND COALESCE(j.failedAt, j.abandonedAt, d.updatedAt, j.updatedAt) >= ?
         ORDER BY COALESCE(j.failedAt, j.abandonedAt, d.updatedAt, j.updatedAt) DESC
         LIMIT 1000`,
      )
      .all(DEFAULT_WORKER_RUNTIME_GENERATION, runtimeGeneration, cutoffIso) as Array<{
      error: string | null;
      failureAt: string | null;
      failureClass: string | null;
      terminalStage: string | null;
      executorBackend: string | null;
      summary: string | null;
    }>;

    const clusters = new Map<
      string,
      {
        count: number;
        failureClass: string;
        executorBackend: string;
        signature: string;
        lastFailureAt: string | null;
      }
    >();
    let qualifyingFailureCount = 0;
    for (const row of rows) {
      const signature = workerRuntimeFailureSignature(
        row.failureClass,
        row.error,
        row.summary,
        row.terminalStage,
      );
      if (!signature) continue;
      qualifyingFailureCount += 1;
      const previous = clusters.get(signature.fingerprint);
      if (previous) {
        previous.count += 1;
        if (
          (parseIsoMs(row.failureAt) ?? Number.NEGATIVE_INFINITY) >
          (parseIsoMs(previous.lastFailureAt) ?? Number.NEGATIVE_INFINITY)
        ) {
          previous.lastFailureAt = row.failureAt;
          previous.failureClass = signature.failureClass;
          previous.executorBackend = String(row.executorBackend ?? "");
          previous.signature = signature.signature;
        }
        continue;
      }
      clusters.set(signature.fingerprint, {
        count: 1,
        failureClass: signature.failureClass,
        executorBackend: String(row.executorBackend ?? ""),
        signature: signature.signature,
        lastFailureAt: row.failureAt,
      });
    }

    const rankedClusters = [...clusters.entries()].sort((left, right) => {
      const countDelta = right[1].count - left[1].count;
      if (countDelta !== 0) return countDelta;
      return (
        (parseIsoMs(right[1].lastFailureAt) ?? Number.NEGATIVE_INFINITY) -
        (parseIsoMs(left[1].lastFailureAt) ?? Number.NEGATIVE_INFINITY)
      );
    });
    const thresholdCluster = rankedClusters.find((candidate) => candidate[1].count >= threshold);
    if (thresholdCluster) {
      const [fingerprint, cluster] = thresholdCluster;
      const lastFailureAtMs = parseIsoMs(cluster.lastFailureAt);
      const existingFailureAtMs = parseIsoMs(circuitBefore?.lastFailureAt);
      const canaryLeaseExpiresAtMs = parseIsoMs(circuitBefore?.canaryLeaseExpiresAt);
      const hasActiveHalfOpenCanary =
        circuitBefore?.state === "half_open" &&
        Boolean(circuitBefore.canaryJobId) &&
        Boolean(circuitBefore.canaryWorkerId) &&
        (canaryLeaseExpiresAtMs == null || canaryLeaseExpiresAtMs > nowMs);
      const newEvidence =
        !circuitBefore ||
        circuitBefore.fingerprint !== fingerprint ||
        (lastFailureAtMs != null &&
          (existingFailureAtMs == null || lastFailureAtMs > existingFailureAtMs));
      // A failure from work admitted before the circuit opened must not evict
      // the single in-flight canary. Leave that evidence pending until the
      // canary resolves: success supersedes it, while failure or lease recovery
      // can reassess it without weakening the exact half-open ownership fence.
      if (newEvidence && lastFailureAtMs != null && !hasActiveHalfOpenCanary) {
        const retryAt = new Date(lastFailureAtMs + blockDurationMs).toISOString();
        this.db
          .prepare(
            `INSERT INTO worker_runtime_circuits (
               runtimeGeneration, state, fingerprint, failureClass, executorBackend,
               signatureSample, openedAt, retryAt, lastFailureAt, recoveredAt,
               canaryJobId, canaryWorkerId, canaryClaimedAt, canaryLeaseExpiresAt,
               createdAt, updatedAt
             ) VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
             ON CONFLICT(runtimeGeneration) DO UPDATE SET
               state = 'open',
               fingerprint = excluded.fingerprint,
               failureClass = excluded.failureClass,
               executorBackend = excluded.executorBackend,
               signatureSample = excluded.signatureSample,
               openedAt = excluded.openedAt,
               retryAt = excluded.retryAt,
               lastFailureAt = excluded.lastFailureAt,
               recoveredAt = NULL,
               canaryJobId = NULL,
               canaryWorkerId = NULL,
               canaryClaimedAt = NULL,
               canaryLeaseExpiresAt = NULL,
               updatedAt = excluded.updatedAt`,
          )
          .run(
            runtimeGeneration,
            fingerprint,
            cluster.failureClass,
            cluster.executorBackend,
            cluster.signature,
            now,
            retryAt,
            cluster.lastFailureAt,
            now,
            now,
          );
      }
    }

    const circuit = this.getWorkerRuntimeCircuit(runtimeGeneration);
    const ranked = rankedClusters[0] ?? null;
    const fingerprint = circuit?.fingerprint ?? ranked?.[0] ?? null;
    const cluster = (fingerprint ? clusters.get(fingerprint) : undefined) ?? ranked?.[1] ?? null;
    const phase = circuit?.state ?? "closed";
    return {
      blocked: phase !== "closed",
      phase,
      runtimeGeneration,
      windowMs,
      blockDurationMs,
      threshold,
      qualifyingFailureCount,
      recentMatchingFailureCount: cluster?.count ?? 0,
      fingerprint,
      failureClass: circuit?.failureClass || cluster?.failureClass || null,
      executorBackend: circuit?.executorBackend || cluster?.executorBackend || null,
      signatureSample: circuit?.signatureSample ?? cluster?.signature ?? null,
      lastFailureAt: circuit?.lastFailureAt ?? cluster?.lastFailureAt ?? null,
      retryAt: circuit?.retryAt ?? null,
      canaryJobId: circuit?.canaryJobId ?? null,
      canaryWorkerId: circuit?.canaryWorkerId ?? null,
      canaryLeaseExpiresAt: circuit?.canaryLeaseExpiresAt ?? null,
    };
  }

  acquireWorkerRuntimeCanary(
    jobId: string,
    workerId: string,
    options: {
      windowMs?: number;
      maxBlockMs?: number;
      threshold?: number;
      nowMs?: number;
      notBeforeMs?: number;
      runtimeGeneration?: string;
      canaryLeaseMs?: number;
    } = {},
  ): WorkerRuntimeCanaryDecision {
    const summary = this.workerRuntimeFailureCircuitSummary(options);
    if (!summary.blocked) return { allowed: true, canary: false, summary };

    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const now = new Date(nowMs).toISOString();
    const circuit = this.getWorkerRuntimeCircuit(summary.runtimeGeneration);
    if (!circuit || circuit.state === "closed") {
      return {
        allowed: true,
        canary: false,
        summary: this.workerRuntimeFailureCircuitSummary(options),
      };
    }
    if (circuit.state === "half_open") {
      const leaseExpiresAtMs = parseIsoMs(circuit.canaryLeaseExpiresAt);
      if (
        circuit.canaryJobId === jobId &&
        circuit.canaryWorkerId === workerId &&
        (leaseExpiresAtMs == null || leaseExpiresAtMs > nowMs)
      ) {
        return { allowed: true, canary: true, summary };
      }
      return {
        allowed: false,
        canary: false,
        summary,
        reason:
          leaseExpiresAtMs != null && leaseExpiresAtMs <= nowMs
            ? "canary_lease_expired"
            : "canary_in_flight",
      };
    }
    const retryAtMs = parseIsoMs(circuit.retryAt);
    if (retryAtMs != null && retryAtMs > nowMs) {
      return { allowed: false, canary: false, summary, reason: "circuit_open" };
    }

    const canaryLeaseMs = Math.max(
      5_000,
      Math.min(
        5 * 60_000,
        Math.floor(options.canaryLeaseMs ?? WORKER_RUNTIME_CANARY_LEASE_MS_DEFAULT),
      ),
    );
    const leaseExpiresAt = new Date(nowMs + canaryLeaseMs).toISOString();
    const acquired = this.db
      .prepare(
        `UPDATE worker_runtime_circuits
         SET state = 'half_open',
             canaryJobId = ?,
             canaryWorkerId = ?,
             canaryClaimedAt = ?,
             canaryLeaseExpiresAt = ?,
             updatedAt = ?
         WHERE runtimeGeneration = ?
           AND state = 'open'
           AND (retryAt IS NULL OR retryAt <= ?)`,
      )
      .run(jobId, workerId, now, leaseExpiresAt, now, summary.runtimeGeneration, now);
    const finalSummary = this.workerRuntimeFailureCircuitSummary(options);
    if (acquired.changes === 0) {
      return { allowed: false, canary: false, summary: finalSummary, reason: "canary_in_flight" };
    }
    return { allowed: true, canary: true, summary: finalSummary };
  }

  recordWorkerRuntimeCanarySuccess(
    jobId: string,
    nowMs = Date.now(),
  ): { reopened: boolean; runtimeGeneration?: string; releasedJobCount: number } {
    const now = new Date(nowMs).toISOString();
    const job = this.getJob(jobId);
    if (
      !job ||
      (job.status !== "completed" &&
        job.status !== "finalizing" &&
        job.status !== "publish_blocked")
    ) {
      return { reopened: false, releasedJobCount: 0 };
    }
    const circuit = this.db
      .prepare(
        `SELECT * FROM worker_runtime_circuits
         WHERE state = 'half_open' AND canaryJobId = ?
         LIMIT 1`,
      )
      .get(jobId) as WorkerRuntimeCircuitRow | undefined;
    if (!circuit) return { reopened: false, releasedJobCount: 0 };
    const result = this.db
      .prepare(
        `UPDATE worker_runtime_circuits
         SET state = 'closed',
             recoveredAt = ?,
             retryAt = NULL,
             canaryJobId = NULL,
             canaryWorkerId = NULL,
             canaryClaimedAt = NULL,
             canaryLeaseExpiresAt = NULL,
             updatedAt = ?
         WHERE runtimeGeneration = ?
           AND state = 'half_open'
           AND canaryJobId = ?`,
      )
      .run(now, now, circuit.runtimeGeneration, jobId);
    if (result.changes === 0) return { reopened: false, releasedJobCount: 0 };
    const released = this.releaseWorkerRuntimeCircuitDeferrals(nowMs);
    return {
      reopened: true,
      runtimeGeneration: circuit.runtimeGeneration,
      releasedJobCount: released.released,
    };
  }

  recordWorkerRuntimeCanaryFailure(
    jobId: string,
    options: { nowMs?: number; blockDurationMs?: number; recheckMs?: number } = {},
  ): { renewed: boolean; matchingFailure: boolean; retryAt?: string } {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const now = new Date(nowMs).toISOString();
    const job = this.getJob(jobId);
    if (!job || (job.status !== "failed" && job.status !== "abandoned")) {
      return { renewed: false, matchingFailure: false };
    }
    const circuit = this.db
      .prepare(
        `SELECT * FROM worker_runtime_circuits
         WHERE state = 'half_open' AND canaryJobId = ?
         LIMIT 1`,
      )
      .get(jobId) as WorkerRuntimeCircuitRow | undefined;
    if (!circuit) return { renewed: false, matchingFailure: false };
    const evidence = this.db
      .prepare(
        `SELECT j.error, d.failureClass, d.terminalStage, d.executorBackend, d.summary,
                COALESCE(j.failedAt, j.abandonedAt, d.updatedAt, j.updatedAt) AS failureAt
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.id = ?`,
      )
      .get(jobId) as
      | {
          error: string | null;
          failureClass: string | null;
          terminalStage: string | null;
          executorBackend: string | null;
          summary: string | null;
          failureAt: string | null;
        }
      | undefined;
    const signature = evidence
      ? workerRuntimeFailureSignature(
          evidence.failureClass,
          evidence.error,
          evidence.summary,
          evidence.terminalStage,
        )
      : null;
    const matchingFailure = Boolean(signature && signature.fingerprint === circuit.fingerprint);
    const delayMs = matchingFailure
      ? Math.max(60_000, Math.floor(options.blockDurationMs ?? 30 * 60_000))
      : Math.max(
          1_000,
          Math.min(
            WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT,
            Math.floor(options.recheckMs ?? WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT),
          ),
        );
    const retryAt = new Date(nowMs + delayMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE worker_runtime_circuits
         SET state = 'open',
             retryAt = ?,
             lastFailureAt = CASE WHEN ? THEN COALESCE(?, lastFailureAt) ELSE lastFailureAt END,
             failureClass = CASE WHEN ? THEN COALESCE(?, failureClass) ELSE failureClass END,
             executorBackend = CASE WHEN ? THEN COALESCE(?, executorBackend) ELSE executorBackend END,
             signatureSample = CASE WHEN ? THEN COALESCE(?, signatureSample) ELSE signatureSample END,
             canaryJobId = NULL,
             canaryWorkerId = NULL,
             canaryClaimedAt = NULL,
             canaryLeaseExpiresAt = NULL,
             recoveredAt = NULL,
             updatedAt = ?
         WHERE runtimeGeneration = ?
           AND state = 'half_open'
           AND canaryJobId = ?`,
      )
      .run(
        retryAt,
        matchingFailure ? 1 : 0,
        evidence?.failureAt ?? now,
        matchingFailure ? 1 : 0,
        signature?.failureClass ?? null,
        matchingFailure ? 1 : 0,
        evidence?.executorBackend ?? null,
        matchingFailure ? 1 : 0,
        signature?.signature ?? null,
        now,
        circuit.runtimeGeneration,
        jobId,
      );
    return { renewed: result.changes > 0, matchingFailure, retryAt };
  }

  recoverExpiredWorkerRuntimeCanary(
    options: {
      runtimeGeneration?: string;
      nowMs?: number;
      recheckMs?: number;
    } = {},
  ): WorkerRuntimeCanaryRecovery {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const now = new Date(nowMs).toISOString();
    const runtimeGeneration = options.runtimeGeneration
      ? normalizeWorkerRuntimeGeneration(options.runtimeGeneration)
      : null;
    const circuit = this.db
      .prepare(
        `SELECT * FROM worker_runtime_circuits
         WHERE state = 'half_open'
           AND canaryLeaseExpiresAt IS NOT NULL
           AND canaryLeaseExpiresAt <= ?
           AND (? IS NULL OR runtimeGeneration = ?)
         ORDER BY canaryLeaseExpiresAt ASC
         LIMIT 1`,
      )
      .get(now, runtimeGeneration, runtimeGeneration) as WorkerRuntimeCircuitRow | undefined;
    if (!circuit?.canaryJobId) {
      return {
        circuitRecovered: false,
        recoveredJob: null,
        runtimeGeneration,
        jobId: null,
        retryAt: null,
      };
    }
    const job = this.getJob(circuit.canaryJobId);
    if (
      job?.status === "completed" ||
      job?.status === "finalizing" ||
      job?.status === "publish_blocked"
    ) {
      const success = this.recordWorkerRuntimeCanarySuccess(job.id, nowMs);
      return {
        circuitRecovered: success.reopened,
        recoveredJob: null,
        runtimeGeneration: circuit.runtimeGeneration,
        jobId: job.id,
        retryAt: null,
      };
    }
    if (job?.status === "failed" || job?.status === "abandoned") {
      const failure = this.recordWorkerRuntimeCanaryFailure(job.id, {
        nowMs,
        recheckMs: options.recheckMs,
      });
      return {
        circuitRecovered: failure.renewed,
        recoveredJob: null,
        runtimeGeneration: circuit.runtimeGeneration,
        jobId: job.id,
        retryAt: failure.retryAt ?? null,
      };
    }

    let recoveredJob: RecoveredStaleJob | null = null;
    if (job?.status === "claimed") {
      recoveredJob = this.recoverClaimedJob(job.id, now, {
        expectedWorkerId: circuit.canaryWorkerId,
        recoveryReason: "worker_runtime_canary_lease_expired",
        failureMessage: "Worker runtime canary lease expired without terminal state",
        abandonmentMessage: "Worker runtime canary was abandoned after its lease expired",
        detail: `runtimeGeneration=${circuit.runtimeGeneration}; canaryLeaseExpiresAt=${circuit.canaryLeaseExpiresAt}`,
      });
      if (job.workerId) {
        this.db
          .prepare(
            `UPDATE workers
             SET status = 'offline',
                 currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                 updatedAt = ?
             WHERE workerId = ?`,
          )
          .run(job.id, now, job.workerId);
      }
    }
    const recheckMs = Math.max(
      1_000,
      Math.min(
        WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT,
        Math.floor(options.recheckMs ?? WORKER_RUNTIME_CIRCUIT_RECHECK_MS_DEFAULT),
      ),
    );
    const retryAt = new Date(nowMs + recheckMs).toISOString();
    const updated = this.db
      .prepare(
        `UPDATE worker_runtime_circuits
         SET state = 'open',
             retryAt = ?,
             lastFailureAt = ?,
             canaryJobId = NULL,
             canaryWorkerId = NULL,
             canaryClaimedAt = NULL,
             canaryLeaseExpiresAt = NULL,
             recoveredAt = NULL,
             updatedAt = ?
         WHERE runtimeGeneration = ?
           AND state = 'half_open'
           AND canaryJobId = ?`,
      )
      .run(retryAt, now, now, circuit.runtimeGeneration, circuit.canaryJobId);
    return {
      circuitRecovered: updated.changes > 0,
      recoveredJob,
      runtimeGeneration: circuit.runtimeGeneration,
      jobId: circuit.canaryJobId,
      retryAt,
    };
  }

  similarNoPublishableFailureSummary(options?: {
    patternKey?: string | null;
    targetPaths?: string[];
    windowMs?: number;
    threshold?: number;
  }): SimilarNoPublishableFailureSummary {
    const windowMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 6 * 60 * 60 * 1000)),
    );
    const threshold = Math.max(1, Math.min(20, Math.floor(options?.threshold ?? 2)));
    const patternKey = String(options?.patternKey ?? "").trim() || null;
    const targetPaths = normalizedJobPathList(options?.targetPaths ?? []);
    const base: SimilarNoPublishableFailureSummary = {
      blocked: false,
      windowMs,
      threshold,
      recentSimilarFailureCount: 0,
      patternKey,
      targetPathSample: targetPaths.slice(0, 8),
      lastFailureAt: null,
    };
    if (!patternKey && targetPaths.length === 0) return base;

    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT j.id, j.params, j.failedAt, j.updatedAt
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status = 'failed'
           AND j.updatedAt >= ?
           AND NOT (
             d.failureClass = 'codex_startup_stall'
             OR d.summary LIKE '%stalled before first response%'
             OR d.summary LIKE '%startup stall%'
             OR EXISTS (
               SELECT 1
               FROM job_attempts a
               WHERE a.jobId = j.id
                 AND (
                   a.terminalReason LIKE '%stalled before first response%'
                   OR a.terminalReason LIKE '%startup stall%'
                 )
             )
           )
           AND (
             d.failureClass = 'artifact_only_no_publishable_patch'
             OR d.summary LIKE '%no publishable changes%'
             OR d.summary LIKE '%no publishable file changes%'
             OR d.summary LIKE '%no-edit watchdog%'
             OR EXISTS (
               SELECT 1
               FROM job_attempts a
               WHERE a.jobId = j.id
                 AND (
                   a.terminalReason LIKE '%no publishable changes%'
                   OR a.terminalReason LIKE '%no publishable file changes%'
                   OR a.terminalReason LIKE '%no-edit watchdog%'
                 )
             )
           )
         ORDER BY j.updatedAt DESC
         LIMIT 250`,
      )
      .all(cutoffIso) as Array<{
      id: string;
      params: string | null;
      failedAt: string | null;
      updatedAt: string | null;
    }>;

    let count = 0;
    let lastFailureAt: string | null = null;
    for (const row of rows) {
      const params = parseObjectJson(row.params);
      const autonomy = recordFromUnknown(params.autonomy);
      const origin = String(params.origin ?? autonomy?.origin ?? "")
        .trim()
        .toLowerCase();
      if (origin !== "autonomy") continue;

      const previousPatternKey = String(autonomy?.patternKey ?? autonomy?.pattern_key ?? "").trim();
      const planning = recordFromUnknown(params.planning);
      const previousPaths = [
        ...normalizedJobPathValues(
          params.path,
          params.targetPath,
          params.target_path,
          params.paths,
        ),
        ...normalizedJobPathValues(
          planning?.targetPath,
          planning?.target_path,
          planning?.targetPaths,
          planning?.target_paths,
        ),
        ...normalizedJobPathValues(
          autonomy?.targetPath,
          autonomy?.target_path,
          autonomy?.targetPaths,
          autonomy?.target_paths,
        ),
      ];
      const patternMatches = Boolean(patternKey && previousPatternKey === patternKey);
      const pathMatches =
        targetPaths.length > 0 &&
        previousPaths.length > 0 &&
        jobPathOverlaps(targetPaths, previousPaths);
      if (!patternMatches && !pathMatches) continue;

      count += 1;
      const failureAt = row.failedAt ?? row.updatedAt ?? null;
      if (failureAt && (!lastFailureAt || Date.parse(failureAt) > Date.parse(lastFailureAt))) {
        lastFailureAt = failureAt;
      }
    }

    return {
      ...base,
      blocked: count >= threshold,
      recentSimilarFailureCount: count,
      lastFailureAt,
    };
  }

  similarFailureFingerprintSummary(options?: {
    targetPaths?: string[];
    windowMs?: number;
    threshold?: number;
  }): SimilarFailureFingerprintSummary {
    const windowMs = Math.max(
      60_000,
      Math.min(24 * 60 * 60 * 1000, Math.floor(options?.windowMs ?? 6 * 60 * 60 * 1000)),
    );
    const threshold = Math.max(2, Math.min(20, Math.floor(options?.threshold ?? 2)));
    const targetPaths = normalizedJobPathList(options?.targetPaths ?? []);
    const empty: SimilarFailureFingerprintSummary = {
      blocked: false,
      windowMs,
      threshold,
      recentSimilarFailureCount: 0,
      fingerprint: null,
      targetPathSample: targetPaths.slice(0, 8),
      failureClass: null,
      command: null,
      failedTestSample: [],
      lastFailureAt: null,
    };
    if (targetPaths.length === 0) return empty;

    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           j.id,
           j.params,
           j.error,
           COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt) AS failureAt,
           d.failureClass,
           d.summary,
           (
             SELECT v.command
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS command,
           (
             SELECT v.failureClass
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS validationFailureClass,
           (
             SELECT v.stdoutTail
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS stdoutTail,
           (
             SELECT v.stderrTail
             FROM job_validation_runs v
             WHERE v.jobId = j.id AND v.passed = 0
             ORDER BY v.id DESC
             LIMIT 1
           ) AS stderrTail
         FROM jobs j
         LEFT JOIN job_terminal_diagnostics d ON d.jobId = j.id
         WHERE j.kind = 'task.execute'
           AND j.status IN ('failed', 'abandoned', 'publish_blocked')
           AND COALESCE(j.failedAt, j.publishBlockedAt, j.abandonedAt, j.updatedAt) >= ?
         ORDER BY j.updatedAt DESC
         LIMIT 300`,
      )
      .all(cutoffIso) as Array<{
      id: string;
      params: string | null;
      error: string | null;
      failureAt: string | null;
      failureClass: string | null;
      summary: string | null;
      command: string | null;
      validationFailureClass: string | null;
      stdoutTail: string | null;
      stderrTail: string | null;
    }>;

    const clusters = new Map<
      string,
      {
        count: number;
        failureClass: string;
        command: string;
        failedTests: string[];
        targetPaths: string[];
        lastFailureAt: string | null;
      }
    >();
    for (const row of rows) {
      const params = parseObjectJson(row.params);
      const autonomy = recordFromUnknown(params.autonomy);
      const origin = String(params.origin ?? autonomy?.origin ?? "")
        .trim()
        .toLowerCase();
      if (origin !== "autonomy") continue;
      const planning = recordFromUnknown(params.planning);
      const previousPaths = [
        ...normalizedJobPathValues(
          params.path,
          params.targetPath,
          params.target_path,
          params.paths,
        ),
        ...normalizedJobPathValues(
          planning?.targetPath,
          planning?.target_path,
          planning?.targetPaths,
          planning?.target_paths,
        ),
        ...normalizedJobPathValues(
          autonomy?.targetPath,
          autonomy?.target_path,
          autonomy?.targetPaths,
          autonomy?.target_paths,
        ),
      ];
      const uniquePreviousPaths = [...new Set(previousPaths)].sort();
      if (uniquePreviousPaths.length === 0 || !jobPathOverlaps(targetPaths, uniquePreviousPaths)) {
        continue;
      }
      const fingerprintTargetPaths = overlappingFailureTargetPaths(
        targetPaths,
        uniquePreviousPaths,
      );
      if (fingerprintTargetPaths.length === 0) continue;

      const command = normalizeFailureCommand(row.command) || nestedFailureCommand(row.error);
      const failureClass = String(
        failureClassFromEvidence(row.error) ??
          row.validationFailureClass ??
          row.failureClass ??
          "unknown_failure",
      )
        .trim()
        .toLowerCase();
      const nestedFailedTests = nestedFailedTestSample(row.error);
      const failedTests =
        nestedFailedTests.length > 0
          ? nestedFailedTests
          : extractFailedTestSample(
              row.stdoutTail,
              row.stderrTail,
              row.summary,
              jobFailureText(row.error),
            );
      const fingerprint = failureFingerprint({
        targetPaths: fingerprintTargetPaths,
        failureClass,
        command,
        failedTests,
      });
      const previous = clusters.get(fingerprint);
      const lastFailureAt =
        row.failureAt &&
        (!previous?.lastFailureAt || Date.parse(row.failureAt) > Date.parse(previous.lastFailureAt))
          ? row.failureAt
          : (previous?.lastFailureAt ?? null);
      clusters.set(fingerprint, {
        count: (previous?.count ?? 0) + 1,
        failureClass,
        command,
        failedTests,
        targetPaths: fingerprintTargetPaths,
        lastFailureAt,
      });
    }

    const dominant = [...clusters.entries()].sort((left, right) => {
      if (right[1].count !== left[1].count) return right[1].count - left[1].count;
      return Date.parse(right[1].lastFailureAt ?? "") - Date.parse(left[1].lastFailureAt ?? "");
    })[0];
    if (!dominant) return empty;
    const [fingerprint, cluster] = dominant;
    return {
      ...empty,
      blocked: cluster.count >= threshold,
      recentSimilarFailureCount: cluster.count,
      fingerprint,
      targetPathSample: cluster.targetPaths.slice(0, 8),
      failureClass: cluster.failureClass || null,
      command: cluster.command || null,
      failedTestSample: cluster.failedTests.slice(0, 8),
      lastFailureAt: cluster.lastFailureAt,
    };
  }

  addLog(
    jobId: string,
    message: string,
    ts?: string,
    options: {
      claimGeneration?: number;
      category?: string;
      dedupeKey?: string;
      dedupeWindowMs?: number;
      retain?: number;
    } = {},
  ): number | null {
    const result = this.insertJobLog(jobId, message, ts, options);
    return result.ok ? (result.logId ?? null) : null;
  }

  addClaimedLog(
    jobId: string,
    message: string,
    authority: JobClaimAuthority,
    ts?: string,
  ): { ok: boolean; logId?: number | null; message?: string } {
    return this.insertJobLog(
      jobId,
      message,
      ts,
      { claimGeneration: authority.claimGeneration },
      authority,
    );
  }

  private insertJobLog(
    jobId: string,
    message: string,
    ts: string | undefined,
    options: {
      claimGeneration?: number;
      category?: string;
      dedupeKey?: string;
      dedupeWindowMs?: number;
      retain?: number;
    },
    authority?: JobClaimAuthority,
  ): { ok: boolean; logId?: number | null; message?: string } {
    const receivedAtMs = Date.now();
    const receivedAt = new Date(receivedAtMs).toISOString();
    const requestedAt = coerceIsoTimestamp(ts);
    const requestedAtMs = parseIsoMs(requestedAt);
    // Worker clocks are not liveness authority. Remote logs use server receipt
    // time; trusted internal callers may retain a non-future event timestamp.
    const now = authority
      ? receivedAt
      : requestedAt && requestedAtMs != null && requestedAtMs <= receivedAtMs
        ? requestedAt
        : receivedAt;
    const boundedMessage = diagnosticText(message, 16_000);
    if (!boundedMessage) return { ok: false, message: "message is required" };
    let insertedId: number | null = null;
    const tx = this.db.transaction((): { ok: boolean; logId?: number | null; message?: string } => {
      const job = this.db
        .prepare(`SELECT status, workerId, claimGeneration FROM jobs WHERE id = ?`)
        .get(jobId) as
        | { status: JobStatus; workerId: string | null; claimGeneration: number | null }
        | undefined;
      if (!job) return { ok: false, message: "Job not found" };
      const acceptsWorkerLog =
        job.status === "claimed" ||
        job.status === "finalizing" ||
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "abandoned" ||
        job.status === "publish_blocked";
      if (
        authority &&
        (!acceptsWorkerLog ||
          job.workerId !== authority.workerId ||
          Number(job.claimGeneration ?? 0) !== authority.claimGeneration)
      ) {
        return { ok: false, message: "Job not owned by this worker generation" };
      }
      const claimGeneration = Number.isFinite(options.claimGeneration)
        ? Math.max(0, Math.floor(Number(options.claimGeneration)))
        : Math.max(0, Math.floor(Number(job?.claimGeneration ?? 0)));
      const category = diagnosticText(options.category, 80);
      const dedupeKey = diagnosticText(options.dedupeKey, 240);
      const dedupeWindowMs = Math.max(0, Math.floor(Number(options.dedupeWindowMs ?? 0)));
      if (category && dedupeKey && dedupeWindowMs > 0) {
        const latest = this.db
          .prepare(
            `SELECT ts
             FROM job_logs
             WHERE jobId = ? AND category = ? AND dedupeKey = ?
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get(jobId, category, dedupeKey) as { ts: string } | undefined;
        const latestMs = parseIsoMs(latest?.ts);
        const nowMs = parseIsoMs(now) ?? Date.now();
        if (latestMs != null && nowMs - latestMs < dedupeWindowMs) {
          return { ok: true, logId: null };
        }
      }
      const insertInfo = this.db
        .prepare(
          `INSERT INTO job_logs (
             jobId, ts, message, claimGeneration, category, dedupeKey
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(jobId, now, boundedMessage, claimGeneration, category, dedupeKey);
      const rawId = (insertInfo as { lastInsertRowid?: unknown }).lastInsertRowid;
      if (typeof rawId === "bigint") insertedId = Number(rawId);
      else if (typeof rawId === "number" && Number.isFinite(rawId)) insertedId = rawId;
      if (category && dedupeKey && Number.isFinite(options.retain)) {
        const retain = Math.max(1, Math.min(100, Math.floor(Number(options.retain))));
        this.db
          .prepare(
            `DELETE FROM job_logs
             WHERE id IN (
               SELECT id
               FROM job_logs
               WHERE jobId = ? AND category = ? AND dedupeKey = ?
               ORDER BY id DESC
               LIMIT -1 OFFSET ?
             )`,
          )
          .run(jobId, category, dedupeKey, retain);
      }
      this.db
        .prepare(
          `UPDATE jobs
           SET updatedAt = ?,
               startedAt = COALESCE(startedAt, ?),
               firstLogAt = COALESCE(firstLogAt, ?),
               lastActivityAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND COALESCE(claimGeneration, 0) = ?`,
        )
        .run(receivedAt, receivedAt, receivedAt, receivedAt, jobId, claimGeneration);
      return { ok: true, logId: insertedId };
    });
    return tx();
  }

  listJobLogs(jobId: string, limit = 50, afterId?: number): JobLogRow[] {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
    if (Number.isFinite(afterId as number) && (afterId as number) > 0) {
      return this.db
        .prepare(
          `SELECT id, jobId, ts, message
           FROM job_logs
           WHERE jobId = ? AND id > ?
           ORDER BY id ASC
           LIMIT ?`,
        )
        .all(jobId, Math.floor(afterId as number), maxRows) as JobLogRow[];
    }
    const rows = this.db
      .prepare(
        `SELECT id, jobId, ts, message
         FROM job_logs
         WHERE jobId = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(jobId, maxRows) as JobLogRow[];
    return rows.reverse();
  }

  recordToolRun(body: Partial<ToolRunRecord> & Record<string, unknown>): {
    ok: boolean;
    id?: string;
    message?: string;
  } {
    const now = new Date().toISOString();
    const id = compactDbText(body.id, 128) ?? randomUUID();
    const jobId = compactDbText(body.jobId, 128);
    const workerId = compactDbText(body.workerId, 128);
    const sessionId = compactDbText(body.sessionId, 128);
    const phase = compactDbText(body.phase, 128);
    const capability = compactDbText(body.capability, 128);
    const envProfile = compactDbText(body.envProfile, 128);
    const cwd = compactDbText(body.cwd, 1000);
    const argv = Array.isArray(body.argv)
      ? body.argv
          .map((arg) => String(arg ?? "").trim())
          .filter(Boolean)
          .slice(0, 80)
      : [];
    const commandLine = compactDbText(body.commandLine, 2000);
    const allowedEffects = Array.isArray(body.allowedEffects)
      ? body.allowedEffects
          .map((entry) => String(entry ?? "").trim())
          .filter((entry): entry is ToolEffect =>
            ["read", "write", "network", "git", "process"].includes(entry),
          )
      : [];
    const ok = boolFromUnknown(body.ok);
    const exitCodeRaw = Number(body.exitCode);
    const exitCode = Number.isFinite(exitCodeRaw) ? Math.trunc(exitCodeRaw) : null;
    const stdoutTail = truncateToolText(redactToolText(body.stdoutTail ?? body.stdout), 8_000);
    const stderrTail = truncateToolText(
      redactToolText(body.stderrTail ?? body.stderr ?? body.detail),
      8_000,
    );
    const tool = inferToolNameFromFailureText({
      tool: normalizeToolName(body.tool ?? "shell"),
      argv,
      commandLine,
      stdout: stdoutTail,
      stderr: stderrTail,
      summary: body.summary as string | undefined,
      detail: body.detail as string | undefined,
      exitCode,
      timedOut: boolFromUnknown(body.timedOut),
    });
    const kindRaw = compactDbText(body.kind, 32);
    const kind: ToolKind =
      kindRaw === "known" || kindRaw === "discovered" || kindRaw === "shell"
        ? kindRaw
        : resolveToolKind(tool);
    const classification = ok
      ? null
      : classifyToolFailure({
          tool,
          argv,
          commandLine,
          stdout: stdoutTail,
          stderr: stderrTail,
          summary: body.summary as string | undefined,
          detail: body.detail as string | undefined,
          exitCode,
          timedOut: boolFromUnknown(body.timedOut),
        });
    const clientFailureClass = normalizeToolFailureClass(body.failureClass);
    const serverFailureClass = classification?.failureClass ?? "unknown";
    const acceptsClientFailureClass = shouldAcceptClientToolFailureClass(
      serverFailureClass,
      clientFailureClass,
    );
    const failureClass: ToolFailureClass | null = ok
      ? null
      : acceptsClientFailureClass
        ? clientFailureClass
        : serverFailureClass;
    const retryable = ok
      ? false
      : failureClass === clientFailureClass &&
          body.retryable !== undefined &&
          body.retryable !== null &&
          acceptsClientFailureClass
        ? boolFromUnknown(body.retryable)
        : (classification?.retryable ?? false);
    const clientRemediation = compactDbText(body.remediation, 1000);
    const remediation =
      ok || (failureClass === clientFailureClass && acceptsClientFailureClass)
        ? (clientRemediation ?? classification?.remediation ?? null)
        : (classification?.remediation ?? clientRemediation ?? null);
    const finishedAt = coerceIsoTimestamp(body.finishedAt) ?? now;
    const startedAt = coerceIsoTimestamp(body.startedAt) ?? finishedAt;
    const durationRaw = Number(body.durationMs);
    const durationMs =
      Number.isFinite(durationRaw) && durationRaw >= 0
        ? Math.min(Math.trunc(durationRaw), 86_400_000)
        : 0;
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (sanitizeToolRunMetadata(body.metadata) as Record<string, unknown>)
        : {};

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO tool_runs (
            id, jobId, workerId, sessionId, phase, tool, kind, capability, envProfile, cwd,
            argvJson, commandLine, allowedEffectsJson, ok, exitCode, failureClass, retryable,
            remediation, startedAt, finishedAt, durationMs, stdoutTail, stderrTail, metadataJson, createdAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          jobId,
          workerId,
          sessionId,
          phase,
          tool,
          kind,
          capability,
          envProfile,
          cwd,
          JSON.stringify(argv),
          commandLine,
          JSON.stringify(allowedEffects),
          ok ? 1 : 0,
          exitCode,
          failureClass,
          retryable ? 1 : 0,
          remediation,
          startedAt,
          finishedAt,
          durationMs,
          stdoutTail || null,
          stderrTail || null,
          JSON.stringify(metadata),
          now,
        );
      return { ok: true, id };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listJobToolRuns(jobId: string, limit = 50): ToolRunRecord[] {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
    const rows = this.db
      .prepare(
        `SELECT *
         FROM tool_runs
         WHERE jobId = ?
         ORDER BY finishedAt DESC, createdAt DESC
         LIMIT ?`,
      )
      .all(jobId, maxRows) as ToolRunDbRow[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      workerId: row.workerId,
      sessionId: row.sessionId,
      phase: row.phase,
      tool: row.tool,
      kind: row.kind,
      capability: row.capability,
      envProfile: row.envProfile,
      cwd: row.cwd,
      argv: parseStringArrayJson(row.argvJson),
      commandLine: row.commandLine,
      allowedEffects: parseToolEffectsJson(row.allowedEffectsJson),
      ok: row.ok === 1,
      exitCode: row.exitCode,
      failureClass: row.failureClass,
      retryable: row.retryable === 1,
      remediation: row.remediation,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      stdoutTail: row.stdoutTail,
      stderrTail: row.stderrTail,
      metadata: parseObjectJson(row.metadataJson),
    }));
  }

  getJobDiagnostics(jobId: string): Record<string, unknown> {
    const terminal = this.db
      .prepare(`SELECT * FROM job_terminal_diagnostics WHERE jobId = ?`)
      .get(jobId) as
      | {
          jobId: string;
          status: string;
          failureClass: string | null;
          terminalStage: string | null;
          executorBackend: string | null;
          summary: string | null;
          watchdogFired: number;
          timeoutMs: number | null;
          publishableFileCount: number | null;
          artifactOnlyPathCount: number | null;
          changedPathSampleJson: string | null;
          metadataJson: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    const attempts = this.db
      .prepare(
        `SELECT *
         FROM job_attempts
         WHERE jobId = ?
         ORDER BY attempt ASC, id ASC`,
      )
      .all(jobId) as Array<{
      attempt: number;
      workerId: string | null;
      backend: string | null;
      model: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      durationMs: number | null;
      terminalReason: string | null;
      exitCode: number | null;
      metadataJson: string | null;
      createdAt: string;
    }>;
    const phaseSpans = this.db
      .prepare(
        `SELECT *
         FROM job_phase_spans
         WHERE jobId = ?
         ORDER BY startedAt ASC, id ASC`,
      )
      .all(jobId) as Array<{
      attempt: number | null;
      phase: string;
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      outcome: string | null;
      metadataJson: string | null;
      createdAt: string;
    }>;
    const validationRuns = this.db
      .prepare(
        `SELECT *
         FROM job_validation_runs
         WHERE jobId = ?
         ORDER BY id ASC`,
      )
      .all(jobId) as Array<{
      attempt: number | null;
      command: string;
      exitCode: number | null;
      durationMs: number | null;
      passed: number;
      failureClass: string | null;
      stdoutTail: string | null;
      stderrTail: string | null;
      metadataJson: string | null;
      createdAt: string;
    }>;
    const patchSnapshots = this.db
      .prepare(
        `SELECT *
         FROM job_patch_snapshots
         WHERE jobId = ?
         ORDER BY capturedAt ASC, id ASC`,
      )
      .all(jobId) as Array<{
      attempt: number | null;
      phase: string | null;
      publishableFileCount: number | null;
      artifactOnlyPathCount: number | null;
      changedPathSampleJson: string | null;
      topLevelDirsJson: string | null;
      capturedAt: string | null;
      metadataJson: string | null;
      createdAt: string;
    }>;

    return {
      terminal: terminal
        ? {
            status: terminal.status,
            failureClass: terminal.failureClass,
            terminalStage: terminal.terminalStage,
            executorBackend: terminal.executorBackend,
            summary: terminal.summary,
            watchdogFired: terminal.watchdogFired === 1,
            timeoutMs: terminal.timeoutMs,
            publishableFileCount: terminal.publishableFileCount,
            artifactOnlyPathCount: terminal.artifactOnlyPathCount,
            changedPathSample: parseJsonArray(terminal.changedPathSampleJson),
            metadata: parseObjectJson(terminal.metadataJson),
            createdAt: terminal.createdAt,
            updatedAt: terminal.updatedAt,
          }
        : null,
      attempts: attempts.map((row) => ({
        attempt: row.attempt,
        workerId: row.workerId,
        backend: row.backend,
        model: row.model,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        terminalReason: row.terminalReason,
        exitCode: row.exitCode,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt,
      })),
      phaseSpans: phaseSpans.map((row) => ({
        attempt: row.attempt,
        phase: row.phase,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        outcome: row.outcome,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt,
      })),
      validationRuns: validationRuns.map((row) => ({
        attempt: row.attempt,
        command: row.command,
        exitCode: row.exitCode,
        durationMs: row.durationMs,
        passed: row.passed === 1,
        failureClass: row.failureClass,
        stdoutTail: row.stdoutTail,
        stderrTail: row.stderrTail,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt,
      })),
      patchSnapshots: patchSnapshots.map((row) => ({
        attempt: row.attempt,
        phase: row.phase,
        publishableFileCount: row.publishableFileCount,
        artifactOnlyPathCount: row.artifactOnlyPathCount,
        changedPathSample: parseJsonArray(row.changedPathSampleJson),
        topLevelDirs: parseJsonArray(row.topLevelDirsJson),
        capturedAt: row.capturedAt,
        metadata: parseObjectJson(row.metadataJson),
        createdAt: row.createdAt,
      })),
    };
  }

  saveJobDiagnostics(
    jobId: string,
    body: Record<string, unknown>,
    authority?: JobClaimAuthority,
  ): { ok: boolean; message?: string; counts?: Record<string, number> } {
    const row = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId) as
      | { status: JobStatus }
      | undefined;
    if (!row) return { ok: false, message: "Job not found" };
    try {
      this.recordJobDiagnostics(jobId, body, row.status, new Date().toISOString(), authority);
    } catch (error) {
      if (error instanceof JobClaimAuthorityError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
    const diagnostics = this.getJobDiagnostics(jobId);
    return {
      ok: true,
      counts: {
        attempts: Array.isArray(diagnostics.attempts) ? diagnostics.attempts.length : 0,
        phaseSpans: Array.isArray(diagnostics.phaseSpans) ? diagnostics.phaseSpans.length : 0,
        validationRuns: Array.isArray(diagnostics.validationRuns)
          ? diagnostics.validationRuns.length
          : 0,
        patchSnapshots: Array.isArray(diagnostics.patchSnapshots)
          ? diagnostics.patchSnapshots.length
          : 0,
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
