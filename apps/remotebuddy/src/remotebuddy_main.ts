#!/usr/bin/env bun
/**
 * PushPals RemoteBuddy Orchestrator
 *
 * AI-powered orchestrator that:
 *   1) Listens for user `message` events via cursor-based WS stream
 *   2) Runs them through an LLM brain (LM Studio / Ollama)
 *   3) Emits assistant_message and optionally creates tasks + enqueues jobs
 *   4) Tracks job lifecycle and closes out tasks when all jobs complete
 *
 * Replay-safe: uses IdempotencyStore to avoid re-processing messages on reconnect.
 *
 * Usage:
 *   bun run src/remotebuddy_main.ts --server http://localhost:3001 [--sessionId <id>] [--token <auth>]
 *   Defaults resolve from configs/*.toml via shared config loader.
 */

import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { createLLMClient, type LLMClient } from "./llm.js";
import { AgentBrain, PlannerOutput } from "./brain.js";
import { IdempotencyStore } from "./idempotency.js";
import { createSessionMemoryBackend, type SessionMemoryBackend } from "./memory.js";
import { PersistentSessionMemory } from "./persistent_memory.js";
import {
  CommunicationManager,
  detectRepoRoot,
  extractVisionKeyItems,
  fetchBufferedWithHardDeadline,
  loadPushPalsConfig,
  normalizeAutonomyComponentArea,
  resolveLocalServerConnection,
  sanitizePushPalsConfigForLogging,
  terminateProcessTree,
  matchesGlob,
  normalizeTargetPath,
  normalizeWriteGlob,
} from "shared";
import type { AutonomyComponentArea } from "shared";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { RemoteBuddyAutonomousEngine } from "./autonomous_engine.js";
import {
  extractExplicitTargetPath,
  normalizePathHints,
  plannerTargetPaths,
} from "./path_targeting.js";
import {
  canonicalizeInstructionTextForBun,
  canonicalizeValidationCommandForBun,
} from "./command_policy.js";
import {
  buildWorkerSpawnCommand,
  createWorkerPalId,
  resolveWorkerStartupTimeoutMs,
} from "./worker_spawn.js";

const TASK_EXECUTE_REQUEST_IDEMPOTENCY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const REQUEST_LEASE_MS = 3 * 60_000;
const REQUEST_LEASE_HEARTBEAT_MS = 30_000;
const REQUEST_LEASE_RENEW_TIMEOUT_MS = 10_000;
const REQUEST_TRANSITION_MAX_ATTEMPTS = 3;
const REQUEST_TRANSITION_TIMEOUT_MS = 10_000;
const JOB_ENQUEUE_MAX_ATTEMPTS = 3;
const JOB_ENQUEUE_TIMEOUT_MS = 10_000;
const SERVICE_CONTROL_HTTP_TIMEOUT_MS = 10_000;
const STARTUP_SESSION_HTTP_TIMEOUT_MS = 5_000;

// ─── CLI args ───────────────────────────────────────────────────────────────

const CONFIG = loadPushPalsConfig();

function parseArgs(): {
  server: string;
  sessionId: string | null;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = CONFIG.server.url;
  let sessionId: string | null = CONFIG.sessionId;
  let authToken = CONFIG.authToken;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
    }
  }

  const resolved = resolveLocalServerConnection({
    serverUrl: server,
    authToken,
    fallbackPort: CONFIG.server.port,
  });
  if (resolved.serverWasNormalized) {
    console.warn(`[RemoteBuddy] Coerced server URL to local-only endpoint: ${resolved.serverUrl}`);
  }
  if (resolved.authTokenWasIgnored) {
    console.warn("[RemoteBuddy] Ignoring auth token in local-only mode.");
  }

  return { server: resolved.serverUrl, sessionId, authToken: resolved.authToken };
}

// ─── RemoteBuddy Orchestrator ───────────────────────────────────────────────

function isLikelyChitChat(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  const short = t.length <= 64;
  return (
    short &&
    /^(hi|hello|hey|hi there|hello there|thanks|thank you|ok|okay|cool|nice|yo|sup|what's up|whats up)[!. ]*$/.test(
      t,
    )
  );
}

function isQuestionLike(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(is|are|can|could|should|would|what|why|how|when|where|which|does|do)\b/.test(t);
}

function isExecutionIntent(text: string, targetPath: string | null): boolean {
  const t = text.trim().toLowerCase();
  if (!t || isLikelyChitChat(t)) return false;
  if (targetPath) return true;

  if (isArchitectureIntent(t)) return true;

  const mutatingVerb =
    /\b(create|write|add|append|edit|update|modify|delete|remove|rename|implement|fix|refactor|generate)\b/.test(
      t,
    );
  const operationalVerb =
    /\b(run|test|lint|build|compile|search|find|inspect|check|validate|trace|debug)\b/.test(t);
  const repoHint =
    /\b(repo|repository|project|architecture|structure|module|component|workflow|pipeline|branch|worker|orchestrator|server|client|docker|git|code|file|readme)\b/.test(
      t,
    );

  if (mutatingVerb && (repoHint || t.length >= 12)) return true;
  if (operationalVerb && repoHint) return true;

  // Keep question-style prompts in chat unless there is a clear execution signal.
  if (isQuestionLike(t)) return false;

  // Long, imperative prompts without explicit verbs are still likely execution intents.
  return t.length > 220;
}

function isArchitectureIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const architectureCue =
    /\b(architecture|repo architecture|repository architecture|system design|high[- ]level|overview|describe the architecture|how .* works|explain .* architecture)\b/.test(
      t,
    );
  const codeChangeCue =
    /\b(refactor|rename|change|modify|edit|update|implement|fix|add|remove|delete|create|write|patch)\b/.test(
      t,
    );
  return architectureCue && !codeChangeCue;
}

function parseEnabledFlag(raw: string | undefined | null, defaultValue: boolean): boolean {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return defaultValue;
  return !["0", "false", "no", "off"].includes(text);
}

function parseNonNegativeMs(raw: string | undefined | null, defaultValue = 0): number {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return Math.max(0, defaultValue);
  return Math.floor(parsed);
}

function isCodexUnavailableFailureSignal(message: string, detail: string): boolean {
  const text = `${message}\n${detail}`.toLowerCase();
  return [
    "openai_codex cli is not installed",
    "openai_codex chatgpt auth is not ready",
    "openai_codex api_key auth requires openai_api_key",
    "openai_codex policy violation: codex cli workaround detected",
    "codex cli isn't available",
    "codex cli is mandatory in this backend",
  ].some((needle) => text.includes(needle));
}

const CODEX_STARTUP_STALL_WORKER_EXIT_CODE = 87;

export type TaskExecutionLane = "deterministic" | "worker";
export type RequestPriority = "interactive" | "normal" | "background";
export type PlannerIntent = "chat" | "status" | "code_change" | "analysis" | "other";
export type PlannerRisk = "low" | "medium" | "high";

export type AutonomyJobMetadata = {
  origin: "autonomy";
  objectiveId?: string;
  runId?: string;
  snapshotId?: string;
  patternKey?: string;
  componentArea?: AutonomyComponentArea;
  validationIncident?: {
    incidentId: string;
    candidateSha?: string;
    candidateRef?: string;
    baselineSha?: string;
    validationScope?: string;
    failureFingerprint?: string;
  };
};

export type TaskExecutePlanningScope = {
  readAnywhere: boolean;
  writeAllowed: boolean;
  writeGlobs?: string[];
  forbiddenGlobs?: string[];
  maxFilesToEdit?: number;
};

export type TaskExecutePlanningDiscovery = {
  ripgrepQueries: string[];
  likelyDirs?: string[];
  keywords?: string[];
};

export type TaskExecutePlanning = {
  intent: PlannerIntent;
  riskLevel: PlannerRisk;
  targetPaths?: string[];
  scope: TaskExecutePlanningScope;
  discovery?: TaskExecutePlanningDiscovery;
  acceptanceCriteria: string[];
  validationSteps: string[];
  requiredValidationSteps?: string[];
  repoHintDiagnostics?: string[];
  repoHintStalePaths?: string[];
  queuePriority: RequestPriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
};

export type WorkerRecentJobSummary = {
  jobId: string;
  taskId: string;
  kind: string;
  status: string;
  workerId: string | null;
  summary: string;
  error: string;
  updatedAt: string;
};

export type BaseTaskExecuteJobParams = {
  schemaVersion: 2;
  requestId: string;
  sessionId: string;
  instruction: string;
  plannerWorkerInstruction?: string;
  lane: TaskExecutionLane;
  paths?: string[];
  planning: TaskExecutePlanning;
  targetPath?: string;
  recentContext: string[];
  recentJobs: WorkerRecentJobSummary[];
};

export type TaskExecuteJobParams =
  | (BaseTaskExecuteJobParams & {
      origin: "user";
      autonomy?: undefined;
    })
  | (BaseTaskExecuteJobParams & {
      origin: "autonomy";
      autonomy: AutonomyJobMetadata;
    });

export type RequestAutonomyMetadata = AutonomyJobMetadata & {
  targetPaths: string[];
  writeGlobs: string[];
};

type EnqueueJobResult = {
  jobId: string;
  taskId: string;
  deduped: boolean;
};

type AmbiguousEnqueueJobResult = {
  ambiguous: true;
  detail: string;
};

function asAutonomyComponentArea(value: unknown): AutonomyComponentArea | undefined {
  return normalizeAutonomyComponentArea(value) ?? undefined;
}

function normalizeRequestPriority(value: unknown): RequestPriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
}

function toSingleLine(value: unknown, max = 220): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function withHardDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new Error(timeoutMessage));
      },
      Math.max(1, Math.floor(timeoutMs)),
    );
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sessionEventOrigin(payload: unknown): "user" | "autonomy" {
  const record = asObject(payload);
  if (!record) return "user";
  if (record.origin === "autonomy") return "autonomy";
  if (asObject(record.autonomy)) return "autonomy";
  if (asObject(record.params) && sessionEventOrigin(record.params) === "autonomy") {
    return "autonomy";
  }
  return "user";
}

function normalizeMetadataTargetPaths(value: unknown, maxItems = 48): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const normalized = normalizeTargetPath(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeMetadataWriteGlobs(value: unknown, maxItems = 48): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const normalized = normalizeWriteGlob(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function buildTaskExecuteDedupeKey(
  sessionId: string,
  params: TaskExecuteJobParams,
): string | null {
  const normalizedSessionId = String(sessionId ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedSessionId) return null;
  const normalizedOrigin = params.origin === "autonomy" ? "autonomy" : "user";
  const normalizedRequestId = String(params.requestId ?? "")
    .trim()
    .toLowerCase();
  // A task.execute job belongs to one durable request lifecycle. Reusing a job
  // across request IDs loses the second request/objective's terminal outcome.
  if (!normalizedRequestId) return null;

  const rawTargetPaths = Array.isArray(params.planning.targetPaths)
    ? params.planning.targetPaths
    : [];
  const normalizedTargets = rawTargetPaths
    .map((entry) => normalizeTargetPath(entry))
    .filter((entry): entry is string => Boolean(entry))
    .filter((entry) => entry !== ".")
    .slice(0, 8);
  if (normalizedTargets.length === 0) return null;

  const uniqueTargets = [...new Set(normalizedTargets)].sort((a, b) => a.localeCompare(b));
  if (uniqueTargets.length > 4) return null;

  const maxFilesToEdit = params.planning.scope.maxFilesToEdit;
  if (typeof maxFilesToEdit === "number" && Number.isFinite(maxFilesToEdit) && maxFilesToEdit > 4) {
    return null;
  }

  return `task.execute:${normalizedOrigin}:${normalizedSessionId}:request:${normalizedRequestId}:${uniqueTargets.join("|")}`.toLowerCase();
}

export function buildTaskExecuteRequestDedupeKey(
  sessionId: string,
  params: TaskExecuteJobParams,
): string | null {
  const normalizedSessionId = String(sessionId ?? "")
    .trim()
    .toLowerCase();
  const normalizedRequestId = String(params.requestId ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedSessionId || !normalizedRequestId) return null;
  const normalizedOrigin = params.origin === "autonomy" ? "autonomy" : "user";
  return `task.execute:${normalizedOrigin}:${normalizedSessionId}:request:${normalizedRequestId}:idempotent`;
}

export function resolveTaskExecuteDedupeCooldownMs(
  _params: TaskExecuteJobParams,
  dedupeKey: string | null,
): number {
  if (!dedupeKey) return 0;
  // Every generated task.execute key is scoped to one durable request ID, so
  // this is an idempotency window rather than cross-request work suppression.
  // It keeps a lost enqueue response safe even if the committed job reaches a
  // terminal state before RemoteBuddy retries.
  return TASK_EXECUTE_REQUEST_IDEMPOTENCY_COOLDOWN_MS;
}

function parseAutonomyRequestMetadata(value: unknown): RequestAutonomyMetadata | null {
  let root = asObject(value);
  if (!root && typeof value === "string") {
    const text = value.trim();
    if (text) {
      try {
        root = asObject(JSON.parse(text));
      } catch {
        root = null;
      }
    }
  }
  if (!root) return null;
  const rootOrigin = String(root.origin ?? "")
    .trim()
    .toLowerCase();
  const autonomy = asObject(root.autonomy);
  const autonomyOrigin = String(autonomy?.origin ?? "")
    .trim()
    .toLowerCase();
  if (rootOrigin !== "autonomy" && autonomyOrigin !== "autonomy") return null;

  const payload = autonomy ?? root;
  const validationIncidentRaw = asObject(payload.validationIncident ?? payload.validation_incident);
  const validationIncidentId = String(
    validationIncidentRaw?.incidentId ?? validationIncidentRaw?.incident_id ?? "",
  ).trim();
  return {
    origin: "autonomy",
    objectiveId: String(payload.objectiveId ?? payload.objective_id ?? "").trim() || undefined,
    runId: String(payload.runId ?? payload.run_id ?? "").trim() || undefined,
    snapshotId: String(payload.snapshotId ?? payload.snapshot_id ?? "").trim() || undefined,
    patternKey: String(payload.patternKey ?? payload.pattern_key ?? "").trim() || undefined,
    componentArea: asAutonomyComponentArea(payload.componentArea ?? payload.component_area),
    ...(validationIncidentId
      ? {
          validationIncident: {
            incidentId: validationIncidentId,
            candidateSha:
              String(
                validationIncidentRaw?.candidateSha ?? validationIncidentRaw?.candidate_sha ?? "",
              ).trim() || undefined,
            candidateRef:
              String(
                validationIncidentRaw?.candidateRef ?? validationIncidentRaw?.candidate_ref ?? "",
              ).trim() || undefined,
            baselineSha:
              String(
                validationIncidentRaw?.baselineSha ?? validationIncidentRaw?.baseline_sha ?? "",
              ).trim() || undefined,
            validationScope:
              String(
                validationIncidentRaw?.validationScope ??
                  validationIncidentRaw?.validation_scope ??
                  "",
              ).trim() || undefined,
            failureFingerprint:
              String(
                validationIncidentRaw?.failureFingerprint ??
                  validationIncidentRaw?.failure_fingerprint ??
                  "",
              ).trim() || undefined,
          },
        }
      : {}),
    targetPaths: normalizeMetadataTargetPaths(payload.targetPaths ?? payload.target_paths),
    writeGlobs: normalizeMetadataWriteGlobs(payload.writeGlobs ?? payload.write_globs),
  };
}

function ensureWriteGlobsCoverTargetPaths(
  targetPaths: string[],
  writeGlobs: string[] | undefined,
): {
  normalizedWriteGlobs: string[];
  uncoveredTargets: string[];
  addedGlobs: string[];
} {
  const normalizedTargets = targetPaths
    .map((entry) => normalizeTargetPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  const normalizedWriteGlobs = normalizeMetadataWriteGlobs(writeGlobs ?? []);
  const uncoveredTargets = normalizedTargets.filter(
    (targetPath) => !normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob)),
  );
  if (uncoveredTargets.length === 0) {
    return { normalizedWriteGlobs, uncoveredTargets: [], addedGlobs: [] };
  }

  const addedGlobs: string[] = [];
  const seen = new Set<string>(normalizedWriteGlobs.map((entry) => entry.toLowerCase()));
  for (const targetPath of uncoveredTargets) {
    const exact = normalizeWriteGlob(targetPath);
    if (exact && !seen.has(exact.toLowerCase())) {
      seen.add(exact.toLowerCase());
      normalizedWriteGlobs.push(exact);
      addedGlobs.push(exact);
    }
    const tail = targetPath.split("/").pop() ?? targetPath;
    const looksDirectory = !tail.includes(".");
    if (looksDirectory) {
      const recursive = normalizeWriteGlob(`${targetPath}/**`);
      if (recursive && !seen.has(recursive.toLowerCase())) {
        seen.add(recursive.toLowerCase());
        normalizedWriteGlobs.push(recursive);
        addedGlobs.push(recursive);
      }
    }
  }

  return { normalizedWriteGlobs, uncoveredTargets, addedGlobs };
}

function buildExecutionGuidance(
  plan: PlannerOutput,
  targetPaths: string[],
  requiredValidationSteps: string[] = [],
  repoHintDiagnostics: string[] = [],
): string {
  const lines: string[] = [];
  const targets = normalizePathHints(
    targetPaths.length > 0 ? targetPaths : (plan.scope.write_globs ?? []),
  );
  if (targets.length > 0) {
    lines.push("Suggested starting points:");
    for (const path of targets) lines.push(`- ${path}`);
    lines.push("Path handling:");
    lines.push("- Treat all target paths as repo-relative to the current working directory.");
    lines.push("- Do not prepend a leading slash to target paths.");
    lines.push(
      "- These paths are relevance hints, not hard write boundaries; edit the behavior-owning files needed for the task and explain any expansion.",
    );
  }
  if (repoHintDiagnostics.length > 0) {
    lines.push("Repo hint preflight:");
    for (const diagnostic of repoHintDiagnostics.slice(0, 8)) {
      lines.push(`- ${diagnostic}`);
    }
    lines.push(
      "- If a hinted path is absent, treat it as stale guidance unless the user explicitly asked to create that path. Prefer an existing repo-native owner or nearby test.",
    );
  }
  lines.push("Scope:");
  lines.push(`- read_anywhere: ${plan.scope.read_anywhere ? "true" : "false"}`);
  lines.push(`- write_allowed: ${plan.scope.write_allowed ? "true" : "false"}`);
  if (plan.scope.max_files_to_edit && plan.scope.max_files_to_edit > 0) {
    lines.push(`- max_files_to_edit: ${plan.scope.max_files_to_edit}`);
  }
  if (Array.isArray(plan.scope.write_globs) && plan.scope.write_globs.length > 0) {
    lines.push("Write intent hints:");
    for (const glob of plan.scope.write_globs) lines.push(`- ${glob}`);
  }
  if (Array.isArray(plan.scope.forbidden_globs) && plan.scope.forbidden_globs.length > 0) {
    lines.push("Review guardrail hints:");
    for (const glob of plan.scope.forbidden_globs) lines.push(`- ${glob}`);
  }
  if (plan.discovery) {
    if (plan.discovery.ripgrep_queries.length > 0) {
      lines.push("Discovery ripgrep queries:");
      for (const q of plan.discovery.ripgrep_queries) lines.push(`- ${q}`);
    }
    if (Array.isArray(plan.discovery.likely_dirs) && plan.discovery.likely_dirs.length > 0) {
      lines.push("Likely directories:");
      for (const d of plan.discovery.likely_dirs) lines.push(`- ${d}`);
    }
    if (Array.isArray(plan.discovery.keywords) && plan.discovery.keywords.length > 0) {
      lines.push("Discovery keywords:");
      for (const k of plan.discovery.keywords) lines.push(`- ${k}`);
    }
  }
  if (plan.acceptance_criteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const criterion of plan.acceptance_criteria) lines.push(`- ${criterion}`);
  }
  if (plan.validation_steps.length > 0) {
    lines.push("Validation steps:");
    for (const step of plan.validation_steps) lines.push(`- ${step}`);
  }
  if (requiredValidationSteps.length > 0) {
    lines.push("Required vision.md testing criteria:");
    for (const step of requiredValidationSteps) lines.push(`- ${step}`);
    lines.push(
      "- These repo-level checks are mandatory before reporting completion or publishing a PR.",
    );
  }
  return lines.join("\n").trim();
}

function pathHintHasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function pathHintLooksLikeConcreteFile(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const tail = normalized.split("/").pop() ?? normalized;
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/.test(tail);
}

function requestAllowsCreatingMissingPath(value: string): boolean {
  return /\b(create|add|new|scaffold|generate|introduce|write)\b.{0,80}\b(file|test|module|component|script|page|route|fixture|helper)\b/i.test(
    value,
  );
}

function shouldTreatMissingTargetAsStale(
  repoRoot: string,
  path: string,
  requestText: string,
): boolean {
  const normalized = normalizeTargetPath(path);
  if (!normalized || normalized === "." || pathHintHasGlob(normalized)) return false;
  if (!pathHintLooksLikeConcreteFile(normalized)) return false;
  if (existsSync(resolve(repoRoot, normalized))) return false;
  if (requestAllowsCreatingMissingPath(requestText)) return false;
  return true;
}

function sanitizeRepoNativeTargetHints(params: {
  repoRoot: string;
  prompt: string;
  plan: PlannerOutput;
  targetPaths: string[];
}): { targetPaths: string[]; diagnostics: string[]; staleHints: string[] } {
  const requestText = [
    params.prompt,
    params.plan.worker_instruction,
    params.plan.assistant_message,
    ...params.plan.acceptance_criteria,
    ...params.targetPaths,
  ].join("\n");
  const diagnostics: string[] = [];
  const staleHints: string[] = [];
  const targetPaths = params.targetPaths.filter((path) => {
    const normalized = normalizeTargetPath(path);
    if (!normalized) return false;
    if (!shouldTreatMissingTargetAsStale(params.repoRoot, normalized, requestText)) return true;
    staleHints.push(normalized);
    diagnostics.push(
      `Path hint "${normalized}" does not exist in this checkout; it was removed as a canonical target and kept only as advisory context.`,
    );
    return false;
  });
  if (staleHints.length > 0) {
    const staleLower = staleHints.map((path) => path.toLowerCase());
    params.plan.validation_steps = params.plan.validation_steps.filter((step) => {
      const lower = step.replace(/\\/g, "/").toLowerCase();
      return !staleLower.some((path) => lower.includes(path));
    });
    params.plan.scope.write_globs = (params.plan.scope.write_globs ?? []).filter((glob) => {
      const normalized = normalizeTargetPath(glob);
      if (!normalized) return false;
      return !staleLower.includes(normalized.toLowerCase());
    });
    if (!params.plan.discovery) {
      params.plan.discovery = { ripgrep_queries: [] };
    }
    const keywords = new Set([...(params.plan.discovery.keywords ?? [])]);
    for (const path of staleHints) {
      const tail = path.split("/").pop();
      if (tail) keywords.add(tail.replace(/\.[^.]+$/, ""));
    }
    params.plan.discovery.keywords = [...keywords].slice(0, 12);
  }
  return { targetPaths, diagnostics, staleHints };
}

const VALIDATION_COMMAND_PREFIX =
  /^(git|bun|bunx|npm|npx|pnpm|yarn|node|python|python3|uv|pytest|vitest|jest|tsc|eslint|ruff|mypy|go|cargo|make|docker|pwsh|powershell|sh|bash)\b/i;
const VALIDATION_GENERIC_SAFE = /^(git\s+status\s+--porcelain|git\s+diff\b)/i;
const PATH_TOKEN_REGEX = /\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g;

function isCommandLikeValidationStep(step: string): boolean {
  return VALIDATION_COMMAND_PREFIX.test(step);
}

function hasRelevantTargetPath(step: string, targetPaths: string[]): boolean {
  if (targetPaths.length === 0) return true;
  const lower = step.toLowerCase();
  if (VALIDATION_GENERIC_SAFE.test(lower)) return true;
  for (const target of targetPaths) {
    if (!target || target === ".") continue;
    if (lower.includes(target.toLowerCase())) return true;
  }
  const explicitPathTokens = [...step.matchAll(PATH_TOKEN_REGEX)].map((match) =>
    String(match[1] ?? "")
      .replace(/\\/g, "/")
      .toLowerCase(),
  );
  if (explicitPathTokens.length === 0) return true;
  for (const token of explicitPathTokens) {
    for (const target of targetPaths) {
      const normalizedTarget = target.toLowerCase();
      if (token === normalizedTarget || token.startsWith(`${normalizedTarget}/`)) return true;
    }
  }
  return false;
}

const VALIDATION_SHELL_CONTROL_TOKENS = new Set(["&&", "||", ";", "|"]);

function isPlainValidationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = () => {
    if (!current) return;
    tokens.push(current);
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
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      ch === "|" ||
      ch === ";" ||
      ch === "&" ||
      ch === ">" ||
      ch === "<" ||
      ch === "`" ||
      ch === "$"
    ) {
      return false;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) return false;
  pushCurrent();
  return tokens.length > 0 && !tokens.some((token) => VALIDATION_SHELL_CONTROL_TOKENS.has(token));
}

export function normalizeValidationSteps(steps: string[], targetPaths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of steps) {
    const value = canonicalizeValidationCommandForBun(String(raw ?? "").trim());
    if (!value) continue;
    if (!isCommandLikeValidationStep(value)) continue;
    if (!isPlainValidationCommand(value)) continue;
    if (!hasRelevantTargetPath(value, targetPaths)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function extractCommandFromValidationCriterion(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const fenced = raw.match(/`([^`]+)`/)?.[1]?.trim();
  const candidate = fenced || raw.replace(/^(run|execute|verify|validate|check)\s+/i, "").trim();
  return candidate.trim();
}

export function extractRequiredValidationStepsFromVisionMarkdown(markdown: string): string[] {
  const criteria = extractVisionKeyItems(markdown).testingCriteria;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const criterion of criteria) {
    const command = extractCommandFromValidationCriterion(criterion);
    if (!command) continue;
    if (!isCommandLikeValidationStep(command)) continue;
    const key = command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
    if (out.length >= 12) break;
  }
  return out;
}

function defaultValidationStepsForRequest(prompt: string, targetPaths: string[]): string[] {
  const text = prompt.toLowerCase();
  const concreteTargets = targetPaths.filter((entry) => entry && entry !== ".").slice(0, 4);
  if (/\b(lint|eslint|tsc|typecheck)\b/.test(text)) {
    return ["bun run lint"];
  }
  if (/\b(test|tests|pytest|vitest|jest|coverage)\b/.test(text)) {
    const pythonTarget = concreteTargets.some((target) => target.toLowerCase().endsWith(".py"));
    if (pythonTarget) return ["uv run pytest"];
    return ["bun test"];
  }
  if (concreteTargets.length > 0) {
    return [`git diff -- ${concreteTargets.join(" ")}`, "git status --porcelain"];
  }
  return ["git status --porcelain"];
}

function sanitizePlannerWorkerInstruction(
  workerInstruction: string,
  canonicalInstruction: string,
): string {
  const value = canonicalizeInstructionTextForBun(String(workerInstruction ?? "").trim());
  if (!value) return "";
  const canonicalReference = canonicalizeInstructionTextForBun(
    String(canonicalInstruction ?? "").trim(),
  );
  if (value === canonicalReference) return "";
  const lower = value.toLowerCase();
  if (
    lower.includes("no worker instruction needed") ||
    lower.includes("no additional instruction needed") ||
    lower.includes("purely documentation update") ||
    lower.includes("already updated") ||
    lower.includes("nothing to do")
  ) {
    return "";
  }
  if (
    !/\b(apply|append|add|edit|update|modify|change|replace|write|create|remove|run|verify|check|ensure)\b/i.test(
      value,
    )
  ) {
    return "";
  }
  return value;
}

interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy" | "error" | "offline";
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

interface WorkerAutoscaleSnapshot {
  workers: {
    total: number;
    online: number;
    busy: number;
    idle: number;
  };
  jobs: {
    pending: number;
    claimed: number;
    autoscalablePending: number;
  };
  prs: {
    openUnmerged: number;
  };
}

interface JobLogEntry {
  id: number;
  jobId: string;
  ts: string;
  message: string;
}

interface JobToolRunEntry {
  id: string;
  tool: string;
  phase?: string | null;
  commandLine?: string | null;
  argv?: string[] | null;
  ok: boolean;
  exitCode?: number | null;
  failureClass?: string | null;
  retryable?: boolean | null;
  remediation?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
}

function summarizeToolRun(toolRun: JobToolRunEntry): string {
  const command =
    toSingleLine(toolRun.commandLine, 160) ||
    (Array.isArray(toolRun.argv) ? toSingleLine(toolRun.argv.join(" "), 160) : "");
  const parts = [
    `tool=${toSingleLine(toolRun.tool, 40) || "unknown"}`,
    toolRun.phase ? `phase=${toSingleLine(toolRun.phase, 60)}` : "",
    command ? `cmd=${command}` : "",
    toolRun.failureClass ? `class=${toSingleLine(toolRun.failureClass, 60)}` : "",
    typeof toolRun.retryable === "boolean" ? `retryable=${toolRun.retryable ? "yes" : "no"}` : "",
    typeof toolRun.exitCode === "number" ? `exit=${toolRun.exitCode}` : "",
    toolRun.remediation ? `fix=${toSingleLine(toolRun.remediation, 220)}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function explainJobFailureFromToolRuns(toolRuns: JobToolRunEntry[]): string | null {
  const failed = toolRuns.find((entry) => entry && entry.ok === false);
  if (!failed) return null;
  const tool = toSingleLine(failed.tool, 40) || "unknown tool";
  const failureClass = toSingleLine(failed.failureClass, 80) || "tool failure";
  const remediation = toSingleLine(failed.remediation, 260);
  const command =
    toSingleLine(failed.commandLine, 140) ||
    (Array.isArray(failed.argv) ? toSingleLine(failed.argv.join(" "), 140) : "");
  return [
    `Latest tool failure: ${tool} reported ${failureClass}`,
    command ? `while running ${command}` : "",
    remediation ? `Recommended fix: ${remediation}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

function formatToolRunDiagnostics(toolRuns: JobToolRunEntry[]): string {
  const failed = toolRuns.filter((entry) => entry && entry.ok === false).slice(0, 4);
  if (failed.length === 0) return "";
  return `\nTool diagnostics:\n\`\`\`\n${failed.map(summarizeToolRun).join("\n")}\n\`\`\``;
}

function explainJobFailureFromLogs(
  logs: JobLogEntry[],
  fallbackMessage: string,
  fallbackDetail: string,
): string {
  const lines = logs.map((row) => toSingleLine(row.message, 420)).filter(Boolean);
  const joined = lines.join("\n").toLowerCase();

  if (joined.includes("model preflight failed") && joined.includes("timed out")) {
    return "The worker could not reach the local LLM endpoint from Docker in time (model preflight timeout). This is usually LM Studio not responding quickly enough at host.docker.internal:1234.";
  }
  if (joined.includes("model selection exhausted")) {
    return "All candidate models failed preflight/execution, so OpenHands stopped before running the task.";
  }
  if (
    joined.includes("failed to load model") ||
    joined.includes("insufficient system resources") ||
    joined.includes("model loading was stopped")
  ) {
    return "The selected model could not be loaded due to local resource constraints, and no fallback model succeeded.";
  }
  if (joined.includes("cannot truncate prompt with n_keep")) {
    return "The prompt exceeded the LM Studio/llama.cpp context constraints (n_keep >= n_ctx), so the request was rejected before execution.";
  }
  if (joined.includes("context size has been exceeded")) {
    return "The model context window was exceeded before execution could start.";
  }
  if (joined.includes("connection refused") || joined.includes("connection error")) {
    return "The worker could not connect to the configured LLM endpoint from the container.";
  }
  if (joined.includes("timeout reached for task.execute") || joined.includes("wrapper timed out")) {
    return "The wrapper hit its execution timeout before OpenHands returned a structured result.";
  }
  if (
    joined.includes("tool preflight returned non-json response") ||
    joined.includes("preflight must return one valid json object in a single response")
  ) {
    return "The worker stopped before running tools because strict tool preflight expected exactly one JSON object and the model returned non-JSON output.";
  }

  const lastLine = lines[lines.length - 1] ?? "";
  const fallback = [fallbackMessage, fallbackDetail].filter(Boolean).join(" | ");
  if (lastLine) return `Latest failure signal: ${lastLine}`;
  if (fallback) return `Failure signal: ${fallback}`;
  return "No additional diagnostic signal was found in the current log tail.";
}

function isStrictPreflightJsonFailure(message: string, detail: string): boolean {
  const combined = `${message}\n${detail}`.toLowerCase();
  return (
    combined.includes("tool preflight returned non-json response") ||
    combined.includes("preflight must return one valid json object in a single response")
  );
}

function isNoChangeCompletionSummary(summary: string): boolean {
  const text = summary.toLowerCase();
  return (
    text.includes("no targetpath provided") ||
    text.includes("no target path provided") ||
    text.includes("no changes to commit") ||
    text.includes("no file changes detected") ||
    text.includes("no modified files were detected")
  );
}

function extractClarificationFromCompletionSummary(summary: string): string | null {
  const normalized = String(summary ?? "").trim();
  if (!normalized) return null;
  const match = normalized.match(/^OpenHands needs clarification:\s*(.+)$/i);
  if (!match) return null;
  const question = match[1]?.trim();
  return question ? question : null;
}

function isNoProgressBrokerFailure(message: string, detail: string): boolean {
  const combined = `${message}\n${detail}`.toLowerCase();
  return (
    combined.includes("tool broker failed: did not reach done=true before limits") ||
    combined.includes("model did not return done=true before max steps/timeout") ||
    combined.includes("tool broker failed: no explicit validation command was executed")
  );
}

function extractClarificationFromJobFailure(
  message: string,
  detail: string,
  logs: JobLogEntry[] = [],
): string | null {
  if (isNoProgressBrokerFailure(message, detail)) {
    return (
      "Please narrow the request to concrete target file(s), the exact test/assertion to add, and a specific validation command. " +
      "Example: edit `tests/remotebuddy.path-targeting.test.ts`, add one case, then run `bun test tests/remotebuddy.path-targeting.test.ts`."
    );
  }

  if (!Array.isArray(logs) || logs.length === 0) return null;
  const joined = logs
    .map((row) => String(row?.message ?? ""))
    .join("\n")
    .toLowerCase();
  const hasBrokerSteps = joined.includes("[broker] step");
  const hasEditAction =
    joined.includes("append_line") ||
    joined.includes("replace_text_once") ||
    joined.includes("write_file");
  const hasCommandPolicyRejections =
    joined.includes("shell command rejected") ||
    joined.includes("shell metacharacters are not allowed") ||
    joined.includes("binary not allowed");
  if (hasBrokerSteps && !hasEditAction && hasCommandPolicyRejections) {
    return (
      "Please provide a more bounded request with explicit file paths and a simple validation command (no shell pipes/chaining). " +
      "This helps the worker avoid exploration loops and apply an edit in one pass."
    );
  }
  return null;
}

export class RemoteBuddyOrchestrator {
  private static readonly SESSION_MONITOR_MAX_WS_ERRORS = Math.max(
    1,
    Number.parseInt(process.env.REMOTEBUDDY_SESSION_MONITOR_MAX_WS_ERRORS ?? "6", 10) || 6,
  );
  private readonly agentId = "remotebuddy-orchestrator";
  private readonly server: string;
  private readonly sessionId: string;
  private readonly authToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly terminateProcessTreeImpl: typeof terminateProcessTree;
  private readonly repo: string;
  private readonly jobsDbPath: string;
  private readonly workerOnlineTtlMs: number;
  private readonly waitForWorkerMs: number;
  private autoSpawnWorkers: boolean;
  private readonly minWorkers: number;
  private readonly maxWorkers: number;
  private readonly workerStartupTimeoutMs: number;
  private spawnWorkerDocker: boolean;
  private spawnWorkerRequireDocker: boolean;
  private readonly spawnWorkerImage: string | null;
  private readonly spawnWorkerPollMs: number | null;
  private readonly spawnWorkerHeartbeatMs: number | null;
  private readonly spawnWorkerLabels: string[];
  private readonly workerpalsBinaryPath: string | null;
  private readonly workerpalsSourceBundlePath: string | null;
  private readonly workerpalsBunExecutable: string | null;
  private readonly workerpalsLaunchTrampolinePath: string | null;
  private readonly workerpalsEnvFile: string | null;
  private readonly workerpalsEntrypoint: string | null;
  private workerpalsUnavailableReason: string | null;
  private workerDockerFallbackActivated = false;
  private readonly statusHeartbeatMs: number;
  private readonly fetchFailureLogsOnJobFailure: boolean;
  private readonly executionBudgetInteractiveMs: number;
  private readonly executionBudgetNormalMs: number;
  private readonly executionBudgetBackgroundMs: number;
  private readonly finalizationBudgetMs: number;
  private readonly autonomousEngine: RemoteBuddyAutonomousEngine;
  private autonomyRuntimeEnabled: boolean;
  private readonly autonomyConfigPollMs: number;
  private autonomyConfigPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly managedWorkers = new Map<string, ReturnType<typeof Bun.spawn>>();
  private workerSpawnInFlight: Promise<string | null> | null = null;
  private workerStartupPrewarmInFlight: Promise<void> | null = null;
  private workerSpawnCooldownUntil = 0;
  private readonly workerSpawnBackoffMs: number;
  private readonly workerAutoscalePollMs: number;
  private readonly workerPrewarmDelayMs: number;
  private lastWorkerAutoscaleAt = 0;
  private readonly comm: CommunicationManager;
  private statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusSessionReady = false;
  private readonly sessionEventStops = new Map<string, () => void>();
  private readonly fatalSessionMonitors = new Set<string>();
  private readonly seenJobFailures = new Set<string>();
  private readonly seenJobCompletions = new Set<string>();
  private readonly jobOriginById = new Map<string, "user" | "autonomy">();
  private readonly seenAutonomyFeedbackEvents = new Set<string>();
  private readonly seenQuestionEvents = new Set<string>();
  private readonly eventMonitorStartedAt = Date.now();
  private jobsDb: Database | null = null;
  private disposed = false;
  private readonly sessionMonitorWsErrorCounts = new Map<string, number>();
  private readonly requestLeaseHeartbeats = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>;
      inFlight: boolean;
      consecutiveFailures: number;
      claimToken: string;
    }
  >();

  /** Serialises async request handling to preserve ordering */
  private chain: Promise<void> = Promise.resolve();

  /** AI brain — produces assistant messages + optional action plans */
  private brain: AgentBrain;
  /** Durable idempotency store — prevents replay-induced duplicates */
  private idempotency: IdempotencyStore;
  /** Durable planning memory store for cross-session repo context */
  private persistentMemory: SessionMemoryBackend;
  /** Recent session context for LLM (bounded ring buffer per session) */
  private readonly recentContextBySession = new Map<string, string[]>();
  private memoryEnabled = false;
  private memoryIncludeCrossSession = true;
  private memoryMaxRecallItems = 12;
  private memoryMaxRecallChars = 2400;
  private memoryMaxSummaryChars = 420;
  private memoryRetentionDays = 30;
  private static readonly MAX_CONTEXT = 20;
  private static readonly MAX_CONTEXT_ENTRY_CHARS = 1200;
  private static readonly CHAT_CONTEXT_MAX = 8;
  private static readonly CHAT_CONTEXT_ENTRY_CHARS = 420;

  constructor(opts: {
    server: string;
    sessionId: string;
    authToken: string | null;
    brain: AgentBrain;
    llm: LLMClient;
    idempotency: IdempotencyStore;
    persistentMemory: SessionMemoryBackend;
    jobsDbPath: string;
    fetchImpl?: typeof fetch;
    terminateProcessTreeImpl?: typeof terminateProcessTree;
  }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.terminateProcessTreeImpl = opts.terminateProcessTreeImpl ?? terminateProcessTree;
    this.brain = opts.brain;
    this.idempotency = opts.idempotency;
    this.persistentMemory = opts.persistentMemory;
    this.jobsDbPath = opts.jobsDbPath;
    const remoteCfg = CONFIG.remotebuddy;
    this.workerOnlineTtlMs = Math.max(1_000, remoteCfg.workerpalOnlineTtlMs);
    this.waitForWorkerMs = Math.max(0, remoteCfg.waitForWorkerpalMs);
    this.autoSpawnWorkers = remoteCfg.autoSpawnWorkerpals;
    this.minWorkers = Math.max(1, Math.min(remoteCfg.minWorkerpals, remoteCfg.maxWorkerpals));
    this.maxWorkers = Math.max(1, remoteCfg.maxWorkerpals);
    this.spawnWorkerDocker = remoteCfg.workerpalDocker;
    this.spawnWorkerRequireDocker = remoteCfg.workerpalRequireDocker;
    this.workerStartupTimeoutMs = resolveWorkerStartupTimeoutMs({
      configuredMs: remoteCfg.workerpalStartupTimeoutMs,
      docker: this.spawnWorkerDocker,
      dockerAgentStartupTimeoutMs: CONFIG.workerpals.dockerAgentStartupTimeoutMs,
    });
    this.spawnWorkerImage = remoteCfg.workerpalImage;
    this.spawnWorkerPollMs =
      typeof remoteCfg.workerpalPollMs === "number" && remoteCfg.workerpalPollMs > 0
        ? remoteCfg.workerpalPollMs
        : null;
    this.spawnWorkerHeartbeatMs =
      typeof remoteCfg.workerpalHeartbeatMs === "number" && remoteCfg.workerpalHeartbeatMs > 0
        ? remoteCfg.workerpalHeartbeatMs
        : null;
    this.spawnWorkerLabels = remoteCfg.workerpalLabels;
    this.workerpalsBinaryPath = null;
    this.workerpalsSourceBundlePath = null;
    this.workerpalsBunExecutable = null;
    this.workerpalsLaunchTrampolinePath = null;
    this.workerpalsEnvFile = null;
    this.workerpalsEntrypoint = null;
    this.workerpalsUnavailableReason = null;
    this.workerSpawnBackoffMs = Math.max(
      1_000,
      Number.isFinite(remoteCfg.crashRestartBackoffMs) && remoteCfg.crashRestartBackoffMs > 0
        ? remoteCfg.crashRestartBackoffMs
        : 3_000,
    );
    this.workerAutoscalePollMs = Math.max(1_000, remoteCfg.pollMs);
    this.workerPrewarmDelayMs = Math.min(
      5 * 60_000,
      parseNonNegativeMs(process.env.PUSHPALS_REMOTEBUDDY_WORKERPAL_PREWARM_DELAY_MS, 0),
    );
    this.statusHeartbeatMs = Math.max(0, remoteCfg.statusHeartbeatMs);
    this.fetchFailureLogsOnJobFailure = parseEnabledFlag(
      process.env.REMOTEBUDDY_FETCH_FAILURE_LOGS,
      true,
    );
    this.executionBudgetInteractiveMs = Math.max(60_000, remoteCfg.executionBudgetInteractiveMs);
    this.executionBudgetNormalMs = Math.max(120_000, remoteCfg.executionBudgetNormalMs);
    this.executionBudgetBackgroundMs = Math.max(180_000, remoteCfg.executionBudgetBackgroundMs);
    this.finalizationBudgetMs = Math.max(30_000, remoteCfg.finalizationBudgetMs);
    this.autonomyRuntimeEnabled = remoteCfg.autonomy.enabled;
    this.autonomyConfigPollMs = Math.max(
      1_000,
      Number.parseInt(process.env.REMOTEBUDDY_AUTONOMY_CONFIG_POLL_MS ?? "3000", 10) || 3_000,
    );
    this.memoryEnabled = remoteCfg.memory.enabled;
    this.memoryIncludeCrossSession = remoteCfg.memory.includeCrossSession;
    this.memoryMaxRecallItems = Math.max(1, remoteCfg.memory.maxRecallItems);
    this.memoryMaxRecallChars = Math.max(120, remoteCfg.memory.maxRecallChars);
    this.memoryMaxSummaryChars = Math.max(64, remoteCfg.memory.maxSummaryChars);
    this.memoryRetentionDays = Math.max(1, remoteCfg.memory.retentionDays);

    // Detect repo root from current working directory
    this.repo = detectRepoRoot(process.cwd());
    const embeddedWorkerpalsBinary = String(process.env.PUSHPALS_WORKERPALS_BIN ?? "").trim();
    const embeddedWorkerpalsSourceBundle = String(
      process.env.PUSHPALS_WORKERPALS_SOURCE_BUNDLE ?? "",
    ).trim();
    const embeddedRuntimeLaunchTrampoline = String(
      process.env.PUSHPALS_RUNTIME_LAUNCH_TRAMPOLINE ?? "",
    ).trim();
    const embeddedBunExecutable =
      String(process.env.PUSHPALS_BUN_BIN ?? "").trim() || process.execPath;
    const workerpalsEntrypoint = resolve(
      this.repo,
      "apps",
      "workerpals",
      "src",
      "workerpals_main.ts",
    );
    if (
      process.platform === "win32" &&
      embeddedWorkerpalsSourceBundle &&
      existsSync(embeddedWorkerpalsSourceBundle) &&
      embeddedRuntimeLaunchTrampoline &&
      existsSync(embeddedRuntimeLaunchTrampoline) &&
      embeddedBunExecutable &&
      existsSync(embeddedBunExecutable)
    ) {
      this.workerpalsSourceBundlePath = embeddedWorkerpalsSourceBundle;
      this.workerpalsBunExecutable = embeddedBunExecutable;
      this.workerpalsLaunchTrampolinePath = embeddedRuntimeLaunchTrampoline;
    } else if (process.platform === "win32" && this.autoSpawnWorkers) {
      this.autoSpawnWorkers = false;
      this.workerpalsUnavailableReason =
        "WorkerPal isolated Windows source launcher is incomplete; direct standalone-binary launch is disabled";
      console.warn(`[RemoteBuddy] Auto-spawn disabled: ${this.workerpalsUnavailableReason}.`);
    } else if (embeddedWorkerpalsBinary && existsSync(embeddedWorkerpalsBinary)) {
      this.workerpalsBinaryPath = embeddedWorkerpalsBinary;
    } else if (existsSync(workerpalsEntrypoint)) {
      this.workerpalsEntrypoint = workerpalsEntrypoint;
      const envPath = resolve(this.repo, ".env");
      this.workerpalsEnvFile = existsSync(envPath) ? envPath : null;
    } else if (this.autoSpawnWorkers) {
      this.autoSpawnWorkers = false;
      this.workerpalsUnavailableReason = embeddedWorkerpalsBinary
        ? `WorkerPal embedded binary is missing (${embeddedWorkerpalsBinary}) and source entrypoint is missing (${workerpalsEntrypoint})`
        : `WorkerPal source entrypoint is missing (${workerpalsEntrypoint})`;
      console.warn(`[RemoteBuddy] Auto-spawn disabled: ${this.workerpalsUnavailableReason}.`);
      console.warn(
        "[RemoteBuddy] No embedded WorkerPal runtime is available for auto-spawn; start WorkerPals manually if execution workers are required.",
      );
    }
    if (this.memoryEnabled) {
      this.persistentMemory.purgeExpired(this.memoryRetentionDays, this.repo);
    }
    this.comm = new CommunicationManager({
      serverUrl: this.server,
      sessionId: this.sessionId,
      authToken: this.authToken,
      from: `agent:${this.agentId}`,
      fetchImpl: this.fetchImpl,
    });
    this.autonomousEngine = new RemoteBuddyAutonomousEngine({
      server: this.server,
      sessionId: this.sessionId,
      authToken: this.authToken,
      repo: this.repo,
      llm: opts.llm,
      comm: this.comm,
      config: CONFIG,
    });
    this.autonomousEngine.setRuntimeEnabled(this.autonomyRuntimeEnabled);
    console.log(`[RemoteBuddy] Detected repo root: ${this.repo}`);
    console.log(
      `[RemoteBuddy] Worker scheduler: min=${this.minWorkers} max=${this.maxWorkers} autoSpawn=${this.autoSpawnWorkers ? "on" : "off"} wait=${this.waitForWorkerMs}ms`,
    );
    if (this.workerPrewarmDelayMs > 0) {
      console.log(
        `[RemoteBuddy] WorkerPal startup prewarm delayed by ${this.workerPrewarmDelayMs}ms to reduce first-run binary scan contention.`,
      );
    }
    console.log(
      `[RemoteBuddy] Budgets: interactive=${this.executionBudgetInteractiveMs}ms normal=${this.executionBudgetNormalMs}ms background=${this.executionBudgetBackgroundMs}ms finalization=${this.finalizationBudgetMs}ms`,
    );
    console.log(
      `[RemoteBuddy] Failure log fetch on job failures: ${this.fetchFailureLogsOnJobFailure ? "on" : "off"}`,
    );
    console.log(
      `[RemoteBuddy] Persistent memory: ${this.memoryEnabled ? "on" : "off"} crossSession=${this.memoryIncludeCrossSession ? "on" : "off"} recallItems=${this.memoryMaxRecallItems} recallChars=${this.memoryMaxRecallChars} retentionDays=${this.memoryRetentionDays}`,
    );
    console.log(
      `[RemoteBuddy] Autonomous engine: ${CONFIG.remotebuddy.autonomy.enabled ? "enabled" : "disabled"} tick=${CONFIG.remotebuddy.autonomy.tickIntervalMs}ms startupGrace=${CONFIG.remotebuddy.autonomy.startupGraceMs}ms maxConcurrentObjectives=${CONFIG.remotebuddy.autonomy.maxConcurrentObjectives} maxDispatchPerHour=${CONFIG.remotebuddy.autonomy.maxDispatchPerHour} exploreRate=${CONFIG.remotebuddy.autonomy.exploreRate.toFixed(2)} allowDirtyWorktree=${CONFIG.remotebuddy.autonomy.allowDirtyWorktree ? "on" : "off"}`,
    );
    console.log(
      `[RemoteBuddy] Autonomy runtime-config polling: every ${this.autonomyConfigPollMs}ms`,
    );
  }

  async emitStartupStatus(): Promise<void> {
    this.statusSessionReady = await this.ensureSessionWithRetry();
    if (!this.statusSessionReady) {
      console.warn("[RemoteBuddy] Could not ensure session for startup presence events");
      return;
    }
    const startupDeadlineMs = Date.now() + 15_000;
    let startupStatusOk = false;
    while (!this.disposed) {
      startupStatusOk = await this.comm.status(
        this.agentId,
        "idle",
        "RemoteBuddy online and waiting for requests",
      );
      if (startupStatusOk) break;
      this.statusSessionReady = false;
      if (Date.now() >= startupDeadlineMs) break;
      await Bun.sleep(1_000);
      this.statusSessionReady = await this.ensureSessionWithRetry(undefined, 3, 400, 2_500);
    }
    if (!startupStatusOk) {
      console.warn("[RemoteBuddy] Failed to emit startup status event");
    }
  }

  startStatusHeartbeat(): void {
    if (this.statusHeartbeatMs <= 0 || this.statusHeartbeatTimer) return;
    this.statusHeartbeatTimer = setInterval(() => {
      if (this.disposed) return;
      void (async () => {
        if (!this.statusSessionReady) {
          this.statusSessionReady = await this.ensureSessionWithRetry(undefined, 3, 400, 2500);
        }
        const ok = await this.comm.status(this.agentId, "idle", "RemoteBuddy heartbeat");
        if (!ok) {
          this.statusSessionReady = false;
        }
      })();
    }, this.statusHeartbeatMs);
  }

  private async ensureSessionWithRetry(
    sessionId: string = this.sessionId,
    maxRetries = 20,
    baseDelayMs = 500,
    maxDelayMs = 5000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries && !this.disposed; attempt++) {
      try {
        const res = await this.fetchServiceControl(
          `${this.server}/sessions`,
          {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({ sessionId }),
          },
          STARTUP_SESSION_HTTP_TIMEOUT_MS,
        );
        if (res.ok) return true;
      } catch {
        // retry
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await Bun.sleep(delayMs);
    }
    return false;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  private fetchServiceControl(
    input: string | URL | Request,
    init?: RequestInit,
    timeoutMs = SERVICE_CONTROL_HTTP_TIMEOUT_MS,
  ): Promise<Response> {
    return fetchBufferedWithHardDeadline({
      input,
      init,
      timeoutMs,
      fetchImpl: this.fetchImpl,
      timeoutMessage: `RemoteBuddy service-control request timed out after ${timeoutMs}ms`,
    });
  }

  private async fetchDurableRequestState(
    requestIdRaw: string,
    timeoutMs = REQUEST_TRANSITION_TIMEOUT_MS,
  ): Promise<{
    status: string;
    agentId: string | null;
    claimToken: string | null;
    workerRequired: number;
    handoffJobId: string | null;
  } | null> {
    const requestId = String(requestIdRaw ?? "").trim();
    if (!requestId) return null;
    try {
      const payload = await withHardDeadline(
        async (signal) => {
          const response = await this.fetchServiceControl(
            `${this.server}/requests/${encodeURIComponent(requestId)}`,
            {
              method: "GET",
              headers: this.authHeaders(),
              signal,
            },
          );
          if (!response.ok) return null;
          return (await response.json()) as {
            request?: {
              status?: unknown;
              agentId?: unknown;
              claimToken?: unknown;
              workerRequired?: unknown;
              handoffJobId?: unknown;
            };
          };
        },
        timeoutMs,
        `request state lookup timed out after ${timeoutMs}ms`,
      );
      if (!payload?.request || typeof payload.request !== "object") return null;
      return {
        status: String(payload.request.status ?? "").trim(),
        agentId:
          typeof payload.request.agentId === "string" ? payload.request.agentId.trim() : null,
        claimToken:
          typeof payload.request.claimToken === "string" ? payload.request.claimToken.trim() : null,
        workerRequired: Number(payload.request.workerRequired) === 1 ? 1 : 0,
        handoffJobId:
          typeof payload.request.handoffJobId === "string"
            ? payload.request.handoffJobId.trim()
            : null,
      };
    } catch {
      return null;
    }
  }

  private async postRequestLifecycleTransition(params: {
    requestId: string;
    transition: "worker-handoff" | "complete";
    body: Record<string, unknown>;
    claimToken: string;
    jobId?: string;
    attempts?: number;
    timeoutMs?: number;
    retryDelayMs?: number;
  }): Promise<{ ok: boolean; recoveredFromState?: boolean; detail?: string }> {
    const transitionUrl = `${this.server}/requests/${encodeURIComponent(params.requestId)}/${params.transition}`;
    let detail = "request lifecycle callback did not complete";
    const maxAttempts = Math.max(
      1,
      Math.min(5, params.attempts ?? REQUEST_TRANSITION_MAX_ATTEMPTS),
    );
    const timeoutMs = Math.max(1, params.timeoutMs ?? REQUEST_TRANSITION_TIMEOUT_MS);
    const retryDelayMs = Math.max(0, params.retryDelayMs ?? 150);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await withHardDeadline(
          async (signal) => {
            const rawResponse = await this.fetchServiceControl(transitionUrl, {
              method: "POST",
              headers: this.authHeaders(),
              body: JSON.stringify(params.body),
              signal,
            });
            const responseDetail = rawResponse.ok
              ? ""
              : toSingleLine(await rawResponse.text().catch(() => ""), 500);
            return {
              ok: rawResponse.ok,
              status: rawResponse.status,
              responseDetail,
            };
          },
          timeoutMs,
          `request lifecycle callback timed out after ${timeoutMs}ms`,
        );
        if (response.ok) return { ok: true };
        detail = `HTTP ${response.status}${response.responseDetail ? `: ${response.responseDetail}` : ""}`;
        if ([400, 401, 403, 404].includes(response.status)) break;
      } catch (error) {
        detail = toSingleLine(error, 500) || "request lifecycle callback transport failed";
      }
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await Bun.sleep(retryDelayMs * attempt);
      }
    }

    // The server may have committed a terminal transition before the response
    // was lost. Confirm durable state before treating that ambiguity as a
    // planning failure or trying an opposite terminal transition.
    const state = await this.fetchDurableRequestState(params.requestId, timeoutMs);
    const sameTerminalOwner =
      state?.agentId === this.agentId && state?.claimToken === params.claimToken;
    if (
      params.transition === "complete" &&
      state?.status === "completed" &&
      (sameTerminalOwner ||
        (Boolean(params.jobId) &&
          state.workerRequired === 1 &&
          state.handoffJobId === params.jobId))
    ) {
      return { ok: true, recoveredFromState: true };
    }
    if (
      params.transition === "worker-handoff" &&
      Boolean(params.jobId) &&
      state?.workerRequired === 1 &&
      state.handoffJobId === params.jobId &&
      (state.status === "claimed" || state.status === "completed")
    ) {
      return { ok: true, recoveredFromState: true };
    }
    return { ok: false, detail };
  }

  private startRequestLeaseHeartbeat(
    requestIdRaw: string,
    claimTokenRaw: string,
    options: { heartbeatMs?: number; leaseMs?: number; timeoutMs?: number } = {},
  ): () => void {
    const requestId = String(requestIdRaw ?? "").trim();
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!requestId || !claimToken) return () => {};
    const heartbeatMs = Math.max(1, options.heartbeatMs ?? REQUEST_LEASE_HEARTBEAT_MS);
    const leaseMs = Math.max(1, options.leaseMs ?? REQUEST_LEASE_MS);
    const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_LEASE_RENEW_TIMEOUT_MS);
    const existing = this.requestLeaseHeartbeats.get(requestId);
    if (existing) {
      if (existing.claimToken === claimToken) {
        return () => this.stopRequestLeaseHeartbeat(requestId, claimToken);
      }
      this.stopRequestLeaseHeartbeat(requestId, existing.claimToken);
    }

    const state = {
      timer: null as unknown as ReturnType<typeof setInterval>,
      inFlight: false,
      consecutiveFailures: 0,
      claimToken,
    };
    const renew = async () => {
      if (this.disposed || state.inFlight || this.requestLeaseHeartbeats.get(requestId) !== state)
        return;
      state.inFlight = true;
      try {
        const response = await this.fetchServiceControl(
          `${this.server}/requests/${encodeURIComponent(requestId)}/lease/renew`,
          {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({
              agentId: this.agentId,
              claimToken,
              leaseMs,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) {
          state.consecutiveFailures += 1;
          console.warn(
            `[RemoteBuddy] Request lease renewal failed for ${requestId.slice(0, 8)}: HTTP ${response.status}`,
          );
          return;
        }
        state.consecutiveFailures = 0;
      } catch (error) {
        state.consecutiveFailures += 1;
        console.warn(
          `[RemoteBuddy] Request lease renewal error for ${requestId.slice(0, 8)} ` +
            `(attempt ${state.consecutiveFailures}): ${toSingleLine(error, 180)}`,
        );
      } finally {
        state.inFlight = false;
      }
    };
    state.timer = setInterval(() => void renew(), heartbeatMs);
    state.timer.unref?.();
    this.requestLeaseHeartbeats.set(requestId, state);
    return () => this.stopRequestLeaseHeartbeat(requestId, claimToken);
  }

  private stopRequestLeaseHeartbeat(requestIdRaw: string, claimTokenRaw?: string): void {
    const requestId = String(requestIdRaw ?? "").trim();
    const state = this.requestLeaseHeartbeats.get(requestId);
    if (!state) return;
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (claimToken && state.claimToken !== claimToken) return;
    clearInterval(state.timer);
    this.requestLeaseHeartbeats.delete(requestId);
  }

  private async assistantMessage(
    sessionId: string,
    text: string,
    meta: {
      correlationId?: string;
      turnId?: string;
      parentId?: string;
      from?: string;
    } = {},
  ): Promise<void> {
    try {
      const ok = await this.comm.assistantMessageToSession(sessionId, text, meta);
      if (!ok) {
        console.error(
          `[RemoteBuddy] assistant_message failed for session ${sessionId || "(unknown)"}`,
        );
      }
    } catch (err) {
      console.error(
        `[RemoteBuddy] assistant_message error for session ${sessionId || "(unknown)"}:`,
        err,
      );
    }
  }

  /** Send a command event through the server */
  private async sendCommand(sessionId: string, cmd: CommandRequest): Promise<void> {
    try {
      const ok = await this.comm.emitToSession(sessionId, cmd.type, cmd.payload as any, {
        from: cmd.from,
        to: cmd.to,
        correlationId: cmd.correlationId,
        turnId: cmd.turnId,
        parentId: cmd.parentId,
      });
      if (!ok) {
        console.error(
          `[RemoteBuddy] Command ${cmd.type} failed for session ${sessionId || "(unknown)"}`,
        );
      }
    } catch (err) {
      console.error(
        `[RemoteBuddy] Command ${cmd.type} error for session ${sessionId || "(unknown)"}:`,
        err,
      );
    }
  }

  private async fetchJobLogs(jobId: string, limit = 80): Promise<JobLogEntry[]> {
    try {
      const res = await this.fetchServiceControl(
        `${this.server}/jobs/${jobId}/logs?limit=${Math.max(1, Math.min(500, limit))}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { ok?: boolean; logs?: JobLogEntry[] };
      if (!data.ok || !Array.isArray(data.logs)) return [];
      return data.logs.filter((row) => row && typeof row.message === "string").slice(-80);
    } catch {
      return [];
    }
  }

  private async fetchJobToolRuns(jobId: string, limit = 20): Promise<JobToolRunEntry[]> {
    try {
      const res = await this.fetchServiceControl(
        `${this.server}/jobs/${jobId}/tool-runs?limit=${Math.max(1, Math.min(100, limit))}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { ok?: boolean; toolRuns?: JobToolRunEntry[] };
      if (!data.ok || !Array.isArray(data.toolRuns)) return [];
      return data.toolRuns.filter((row) => row && typeof row.tool === "string").slice(0, 20);
    } catch {
      return [];
    }
  }

  private markAutonomyFeedbackEventSeen(eventId: string): boolean {
    const id = String(eventId ?? "").trim();
    if (!id) return true;
    if (this.seenAutonomyFeedbackEvents.has(id)) return false;
    this.seenAutonomyFeedbackEvents.add(id);
    if (this.seenAutonomyFeedbackEvents.size > 2000) {
      const oldest = this.seenAutonomyFeedbackEvents.values().next().value;
      if (typeof oldest === "string" && oldest) {
        this.seenAutonomyFeedbackEvents.delete(oldest);
      }
    }
    return true;
  }

  private markQuestionEventSeen(eventId: string): boolean {
    const id = String(eventId ?? "").trim();
    if (!id) return true;
    if (this.seenQuestionEvents.has(id)) return false;
    this.seenQuestionEvents.add(id);
    if (this.seenQuestionEvents.size > 2000) {
      const oldest = this.seenQuestionEvents.values().next().value;
      if (typeof oldest === "string" && oldest) {
        this.seenQuestionEvents.delete(oldest);
      }
    }
    return true;
  }

  private async fetchLatestAutonomyFeedbackInsight(params: {
    objectiveId?: string;
    patternKey?: string;
  }): Promise<Record<string, unknown> | null> {
    const objectiveId = String(params.objectiveId ?? "").trim();
    const patternKey = String(params.patternKey ?? "").trim();
    const query = new URLSearchParams();
    if (objectiveId) query.set("objectiveId", objectiveId);
    if (patternKey) query.set("patternKey", patternKey);
    query.set("limit", "1");
    query.set("feedbackLimit", "3");
    const suffix = query.toString();
    try {
      const res = await this.fetchServiceControl(
        `${this.server}/autonomy/insights${suffix ? `?${suffix}` : ""}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        ok?: boolean;
        recentPrFeedback?: unknown;
      };
      if (!data.ok || !Array.isArray(data.recentPrFeedback) || data.recentPrFeedback.length === 0) {
        return null;
      }
      const first = data.recentPrFeedback[0];
      if (!first || typeof first !== "object" || Array.isArray(first)) return null;
      return first as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async rememberAutonomyFeedbackFromEvent(
    payload: Record<string, unknown>,
    sessionId: string = this.sessionId,
  ): Promise<void> {
    const objectiveId = toSingleLine(payload.objectiveId, 128) || "unknown";
    const patternKey = toSingleLine(payload.patternKey, 128) || "unknown";
    const outcome = toSingleLine(payload.outcome, 120) || "recorded";
    const success = Boolean(payload.success);
    const insight = await this.fetchLatestAutonomyFeedbackInsight({
      objectiveId: objectiveId !== "unknown" ? objectiveId : undefined,
      patternKey: patternKey !== "unknown" ? patternKey : undefined,
    });
    const summary = toSingleLine(
      insight?.summary ?? payload.feedbackSummary ?? payload.outcomeReason ?? "",
      320,
    );
    const verdict = toSingleLine(insight?.verdict ?? "", 80);
    const source = toSingleLine(insight?.source ?? "", 64);
    const reviewScoreRaw = Number(insight?.reviewScore);
    const reviewThresholdRaw = Number(insight?.reviewThreshold);
    const reviewScore = Number.isFinite(reviewScoreRaw) ? reviewScoreRaw : null;
    const reviewThreshold = Number.isFinite(reviewThresholdRaw) ? reviewThresholdRaw : null;
    const commentCountRaw = Number(insight?.commentCount);
    const commentCount = Number.isFinite(commentCountRaw)
      ? Math.max(0, Math.floor(commentCountRaw))
      : 0;
    const commentExamples = Array.isArray(insight?.comments)
      ? insight.comments
          .slice(0, 2)
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
            const row = entry as Record<string, unknown>;
            const author = toSingleLine(row.user_login ?? row.userLogin ?? row.author, 32);
            const body = toSingleLine(row.body, 140);
            if (!body) return "";
            return `${author ? `@${author}: ` : ""}${body}`;
          })
          .filter(Boolean)
      : [];

    const parts: string[] = [
      `objective=${objectiveId}`,
      `pattern=${patternKey}`,
      `outcome=${outcome}`,
      `success=${success ? "true" : "false"}`,
    ];
    if (source) parts.push(`source=${source}`);
    if (verdict) parts.push(`verdict=${verdict}`);
    if (reviewScore != null || reviewThreshold != null) {
      parts.push(
        `review=${
          reviewScore != null ? reviewScore.toFixed(2) : "?"
        }/${reviewThreshold != null ? reviewThreshold.toFixed(2) : "?"}`,
      );
    }
    if (commentCount > 0) parts.push(`comments=${commentCount}`);
    if (summary) parts.push(`why=${summary}`);
    if (commentExamples.length > 0) {
      parts.push(`examples=${commentExamples.join(" || ")}`);
    }
    const structured = parts.join(" | ");
    this.pushContext(`[autonomy_feedback] ${toSingleLine(structured, 1100)}`, sessionId);
    this.rememberPersistentMemory("autonomy_feedback", structured, null, sessionId);
  }

  private async handleObservedJobFailure(
    sessionId: string,
    envelope: {
      id?: string;
      correlationId?: string;
      turnId?: string;
    },
    jobId: string,
    message: string,
    detail: string,
  ): Promise<void> {
    const shortJob = jobId.slice(0, 8);
    void this.recycleWorkerForCodexUnavailableFailure(jobId, message, detail);
    const clarificationQuestion = extractClarificationFromJobFailure(message, detail);
    if (clarificationQuestion) {
      const clarificationMsg =
        `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationQuestion}\n\n` +
        "Reply with the missing details and I will enqueue a focused follow-up request.";
      await this.assistantMessage(sessionId, clarificationMsg, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id,
      });
      return;
    }

    const willFetchLogs = this.fetchFailureLogsOnJobFailure;
    const fetchMsg = isStrictPreflightJsonFailure(message, detail)
      ? willFetchLogs
        ? `WorkerPal job ${shortJob} stopped before tool execution because strict preflight expected one JSON response and got non-JSON output. I'm fetching logs now to diagnose what happened.`
        : `WorkerPal job ${shortJob} stopped before tool execution because strict preflight expected one JSON response and got non-JSON output.`
      : willFetchLogs
        ? `WorkerPal job ${shortJob} failed: ${message}${detail ? ` (${detail})` : ""} I got an error and I'm fetching logs now to diagnose what happened.`
        : `WorkerPal job ${shortJob} failed: ${message}${detail ? ` (${detail})` : ""}`;
    await this.assistantMessage(sessionId, fetchMsg, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id,
    });

    if (!willFetchLogs) {
      const explanation = explainJobFailureFromLogs([], message, detail);
      await this.assistantMessage(sessionId, `Diagnosis for job ${shortJob}: ${explanation}`, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id,
      });
      return;
    }

    console.warn(`[RemoteBuddy] Fetching failure logs for job ${jobId}...`);
    const [logs, toolRuns] = await Promise.all([
      this.fetchJobLogs(jobId, 80),
      this.fetchJobToolRuns(jobId, 20),
    ]);
    const clarificationFromLogs = extractClarificationFromJobFailure(message, detail, logs);
    if (clarificationFromLogs) {
      const tail = logs
        .slice(-6)
        .map((row) => toSingleLine(row.message, 220))
        .filter(Boolean);
      const tailText = tail.length ? `\nRecent logs:\n\`\`\`\n${tail.join("\n")}\n\`\`\`` : "";
      const toolText = formatToolRunDiagnostics(toolRuns);
      const clarificationMsg =
        `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationFromLogs}\n\n` +
        "Reply with the missing details and I will enqueue a focused follow-up request." +
        toolText +
        tailText;
      await this.assistantMessage(sessionId, clarificationMsg, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id,
      });
      return;
    }

    const explanation =
      explainJobFailureFromToolRuns(toolRuns) ?? explainJobFailureFromLogs(logs, message, detail);

    const tail = logs
      .slice(-6)
      .map((row) => toSingleLine(row.message, 220))
      .filter(Boolean);
    const tailText = tail.length ? `\nRecent logs:\n\`\`\`\n${tail.join("\n")}\n\`\`\`` : "";
    const toolText = formatToolRunDiagnostics(toolRuns);

    await this.assistantMessage(
      sessionId,
      `Diagnosis for job ${shortJob}: ${explanation}${toolText}${tailText}`,
      {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id,
      },
    );
  }

  private handleSessionEvent(envelope: {
    id?: string;
    ts?: string;
    sessionId?: string;
    type?: string;
    correlationId?: string;
    turnId?: string;
    payload?: unknown;
  }): void {
    if (
      envelope.type !== "job_failed" &&
      envelope.type !== "job_completed" &&
      envelope.type !== "job_enqueued" &&
      envelope.type !== "autonomy_feedback_recorded" &&
      envelope.type !== "question_asked" &&
      envelope.type !== "question_answered"
    ) {
      return;
    }
    const tsMs = Date.parse(String(envelope.ts ?? ""));
    if (Number.isFinite(tsMs) && tsMs + 2000 < this.eventMonitorStartedAt) return;
    const eventSessionId = String(envelope.sessionId ?? "").trim() || this.sessionId;

    if (envelope.type === "job_enqueued") {
      const payload = envelope.payload as { jobId?: unknown };
      const jobId = String(payload.jobId ?? "").trim();
      if (jobId) this.jobOriginById.set(jobId, sessionEventOrigin(payload));
      return;
    }

    if (envelope.type === "question_asked") {
      if (!this.markQuestionEventSeen(String(envelope.id ?? ""))) return;
      const payload = asObject(envelope.payload);
      if (!payload) return;
      const questionId = toSingleLine(payload.questionId, 128);
      const objectiveId = toSingleLine(payload.objectiveId, 128);
      const question = toSingleLine(payload.question, 320);
      if (!question) return;
      this.pushContext(
        `[autonomy_question] objective=${objectiveId || "unknown"} question=${question}`,
        eventSessionId,
      );
      this.rememberPersistentMemory(
        "autonomy_question",
        `Objective ${objectiveId || "unknown"} requires clarification: ${question}`,
        null,
        eventSessionId,
      );
      void this.assistantMessage(
        eventSessionId,
        `Autonomy objective ${objectiveId || "unknown"} needs clarification${
          questionId ? ` (${questionId})` : ""
        }: ${question}`,
        {
          correlationId: envelope.correlationId,
          turnId: envelope.turnId,
          parentId: envelope.id,
        },
      );
      return;
    }

    if (envelope.type === "question_answered") {
      if (!this.markQuestionEventSeen(String(envelope.id ?? ""))) return;
      const payload = asObject(envelope.payload);
      if (!payload) return;
      const questionId = toSingleLine(payload.questionId, 128);
      const objectiveId = toSingleLine(payload.objectiveId, 128);
      const status = toSingleLine(payload.status, 32).toLowerCase();
      const answerSummary = toSingleLine(payload.answerSummary, 280);
      const contextLine =
        `[autonomy_question_answered] objective=${objectiveId || "unknown"} ` +
        `question=${questionId || "unknown"} status=${status || "unknown"}` +
        (answerSummary ? ` detail=${answerSummary}` : "");
      this.pushContext(contextLine, eventSessionId);
      this.rememberPersistentMemory(
        "autonomy_question_answered",
        contextLine,
        null,
        eventSessionId,
      );
      const note =
        status === "valid"
          ? `Captured clarification for autonomy objective ${objectiveId || "unknown"}; resuming execution.`
          : `Clarification answer for autonomy objective ${objectiveId || "unknown"} was invalid${
              answerSummary ? `: ${answerSummary}` : "."
            }`;
      void this.assistantMessage(eventSessionId, note, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id,
      });
      return;
    }

    if (envelope.type === "autonomy_feedback_recorded") {
      if (!this.markAutonomyFeedbackEventSeen(String(envelope.id ?? ""))) return;
      const payload = asObject(envelope.payload);
      if (!payload) return;
      void this.rememberAutonomyFeedbackFromEvent(payload, eventSessionId);
      return;
    }

    if (envelope.type === "job_failed") {
      const payload = envelope.payload as {
        jobId?: unknown;
        message?: unknown;
        detail?: unknown;
        origin?: unknown;
      };
      const jobId = String(payload.jobId ?? "").trim();
      const message = toSingleLine(payload.message, 220);
      const detail = toSingleLine(payload.detail, 220);
      if (!jobId || !message) return;
      const origin =
        sessionEventOrigin(payload) === "autonomy" || this.jobOriginById.get(jobId) === "autonomy"
          ? "autonomy"
          : "user";

      const dedupeKey = `${jobId}:${message}`;
      if (this.seenJobFailures.has(dedupeKey)) return;
      this.seenJobFailures.add(dedupeKey);

      const failureLine = `[job_failed ${jobId}] ${message}${detail ? ` | ${detail}` : ""}`;
      this.pushContext(failureLine, eventSessionId);
      this.rememberPersistentMemory(
        "job_failed",
        `Job ${jobId.slice(0, 8)} failed: ${toSingleLine(`${message}${detail ? ` (${detail})` : ""}`, 360)}`,
        null,
        eventSessionId,
      );
      console.warn(`[RemoteBuddy] Observed WorkerPal failure ${jobId}: ${message}`);
      if (origin === "autonomy") return;
      void this.handleObservedJobFailure(eventSessionId, envelope, jobId, message, detail);
      return;
    }

    const payload = envelope.payload as {
      jobId?: unknown;
      summary?: unknown;
      origin?: unknown;
    };
    const jobId = String(payload.jobId ?? "").trim();
    const summary = toSingleLine(payload.summary, 240) || "Job completed";
    if (!jobId) return;
    const origin =
      sessionEventOrigin(payload) === "autonomy" || this.jobOriginById.get(jobId) === "autonomy"
        ? "autonomy"
        : "user";
    if (/startup warmup completed/i.test(summary)) return;
    if (this.seenJobCompletions.has(jobId)) return;
    this.seenJobCompletions.add(jobId);

    this.pushContext(`[job_completed ${jobId}] ${summary}`, eventSessionId);
    this.rememberPersistentMemory(
      "job_completed",
      `Job ${jobId.slice(0, 8)} completed: ${toSingleLine(summary, 360)}`,
      null,
      eventSessionId,
    );
    if (origin === "autonomy") return;
    const shortJob = jobId.slice(0, 8);
    const clarificationQuestion = extractClarificationFromCompletionSummary(summary);
    const note = clarificationQuestion
      ? `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationQuestion}\n\nPlease reply with the missing details and I will enqueue a follow-up request.`
      : isNoChangeCompletionSummary(summary)
        ? `WorkerPal job ${shortJob} completed: ${summary}. No files were changed, so no commit was created.`
        : `WorkerPal job ${shortJob} completed: ${summary}.`;
    void this.assistantMessage(eventSessionId, note, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id,
    });
  }

  private ensureSessionEventMonitor(
    sessionId: string,
    options: { fatalOnWsBudgetExhaustion?: boolean } = {},
  ): void {
    const normalizedSessionId = String(sessionId ?? "").trim() || this.sessionId;
    if (options.fatalOnWsBudgetExhaustion) {
      this.fatalSessionMonitors.add(normalizedSessionId);
    }
    if (this.sessionEventStops.has(normalizedSessionId)) {
      return;
    }

    const stop = this.comm.subscribeSessionEventsForSession(
      normalizedSessionId,
      (envelope) => {
        this.handleSessionEvent(envelope);
      },
      {
        onOpen: () => {
          this.sessionMonitorWsErrorCounts.set(normalizedSessionId, 0);
        },
        onError: (message) => {
          console.warn(`[RemoteBuddy] Session monitor (${normalizedSessionId}) failed: ${message}`);
          if (!/\[SessionEvents\] (WebSocket error|Failed to connect)/.test(message)) return;
          const nextCount = (this.sessionMonitorWsErrorCounts.get(normalizedSessionId) ?? 0) + 1;
          this.sessionMonitorWsErrorCounts.set(normalizedSessionId, nextCount);
          if (
            !this.fatalSessionMonitors.has(normalizedSessionId) ||
            nextCount < RemoteBuddyOrchestrator.SESSION_MONITOR_MAX_WS_ERRORS
          ) {
            return;
          }
          this.fatalSessionMonitors.delete(normalizedSessionId);
          console.error(
            `[RemoteBuddy] Session monitor ${normalizedSessionId} exceeded retry budget (${RemoteBuddyOrchestrator.SESSION_MONITOR_MAX_WS_ERRORS} transport errors). Bailing out.`,
          );
          void this.dispose().finally(() => {
            setTimeout(() => process.exit(1), 0);
          });
        },
      },
    );
    this.sessionEventStops.set(normalizedSessionId, stop);
  }

  startSessionEventMonitor(): void {
    this.ensureSessionEventMonitor(this.sessionId, { fatalOnWsBudgetExhaustion: true });
  }

  /**
   * Enqueue a job via the server job queue.
   * Returns the server-assigned jobId on success, or null on failure.
   */
  private async enqueueJob(
    taskId: string,
    kind: "task.execute",
    sessionId: string,
    params: TaskExecuteJobParams,
    targetWorkerId: string | null = null,
    requestClaimToken: string | null = null,
    retryOptions: { attempts?: number; timeoutMs?: number; retryDelayMs?: number } = {},
  ): Promise<EnqueueJobResult | AmbiguousEnqueueJobResult | null> {
    const payload: Record<string, unknown> = {
      taskId,
      sessionId,
      kind,
      params,
      requestAgentId: this.agentId,
      ...(requestClaimToken ? { requestClaimToken } : {}),
    };
    const targetedDedupeKey = buildTaskExecuteDedupeKey(sessionId, params);
    const dedupeKey = targetedDedupeKey ?? buildTaskExecuteRequestDedupeKey(sessionId, params);
    if (dedupeKey) payload.dedupeKey = dedupeKey;
    const dedupeCooldownMs = resolveTaskExecuteDedupeCooldownMs(params, dedupeKey);
    if (dedupeCooldownMs > 0) payload.dedupeCooldownMs = dedupeCooldownMs;
    if (targetWorkerId) payload.targetWorkerId = targetWorkerId;

    // Reuse byte-for-byte payload identity on retry. JobQueue's active dedupe
    // key then returns the committed job if only the first response was lost.
    const serializedPayload = JSON.stringify(payload);
    let ambiguousDetail = "job enqueue acknowledgement was not received";
    const maxAttempts = Math.max(1, Math.min(5, retryOptions.attempts ?? JOB_ENQUEUE_MAX_ATTEMPTS));
    const timeoutMs = Math.max(1, retryOptions.timeoutMs ?? JOB_ENQUEUE_TIMEOUT_MS);
    const retryDelayMs = Math.max(0, retryOptions.retryDelayMs ?? 150);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await withHardDeadline(
          async (signal) => {
            const res = await this.fetchServiceControl(`${this.server}/jobs/enqueue`, {
              method: "POST",
              headers: this.authHeaders(),
              body: serializedPayload,
              signal,
            });
            if (!res.ok) {
              return {
                ok: false as const,
                status: res.status,
                detail: toSingleLine(await res.text().catch(() => ""), 500),
              };
            }
            return {
              ok: true as const,
              status: res.status,
              data: (await res.json()) as {
                ok: boolean;
                jobId?: string;
                taskId?: string;
                deduped?: boolean;
              },
            };
          },
          timeoutMs,
          `job enqueue timed out after ${timeoutMs}ms`,
        );
        if (!response.ok) {
          const detail = `HTTP ${response.status}${response.detail ? `: ${response.detail}` : ""}`;
          const retryableOrAmbiguous =
            response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryableOrAmbiguous) {
            console.error(`[RemoteBuddy] Enqueue rejected: ${detail}`);
            return null;
          }
          ambiguousDetail = detail;
        } else {
          const data = response.data;
          const resolvedTaskId = String(data.taskId ?? taskId).trim();
          if (data.ok && data.jobId && resolvedTaskId) {
            return {
              jobId: data.jobId,
              taskId: resolvedTaskId,
              deduped: data.deduped === true,
            };
          }
          ambiguousDetail = "successful enqueue response did not include a durable job ID";
        }
      } catch (err) {
        ambiguousDetail = toSingleLine(err, 500) || "job enqueue transport failed";
      }
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await Bun.sleep(retryDelayMs * attempt);
      }
    }

    console.warn(
      `[RemoteBuddy] Job enqueue outcome is ambiguous after ${maxAttempts} attempt(s): ${ambiguousDetail}`,
    );
    return { ambiguous: true, detail: ambiguousDetail };
  }

  // ── Context tracking ───────────────────────────────────────────────────

  private sessionContext(sessionId: string): string[] {
    const normalizedSessionId = String(sessionId ?? "").trim() || this.sessionId;
    let context = this.recentContextBySession.get(normalizedSessionId);
    if (!context) {
      context = [];
      this.recentContextBySession.set(normalizedSessionId, context);
    }
    return context;
  }

  private pushContext(text: string, sessionId: string = this.sessionId): void {
    const normalized = String(text ?? "").trim();
    if (!normalized) return;
    const capped =
      normalized.length <= RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS
        ? normalized
        : `${normalized.slice(0, RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS - 16)}\n...[truncated]`;
    const context = this.sessionContext(sessionId);
    context.push(capped);
    if (context.length > RemoteBuddyOrchestrator.MAX_CONTEXT) {
      context.shift();
    }
  }

  private getChatContextSnapshot(sessionId: string = this.sessionId): string[] {
    const filtered = this.sessionContext(sessionId).filter(
      (entry) => !entry.startsWith("[enhanced]"),
    );
    return filtered
      .slice(-RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX)
      .map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }

  private planningContextSnapshot(
    priority: RequestPriority,
    sessionId: string = this.sessionId,
  ): string[] {
    const filtered = this.sessionContext(sessionId).filter(
      (entry) => !entry.startsWith("[enhanced]"),
    );
    const limit = priority === "interactive" ? 6 : RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX;
    return filtered
      .slice(-limit)
      .map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }

  private persistentPlanningContextSnapshot(
    priority: RequestPriority,
    sessionId: string = this.sessionId,
  ): string[] {
    if (!this.memoryEnabled) return [];
    const maxItems =
      priority === "interactive"
        ? Math.max(2, Math.min(this.memoryMaxRecallItems, 6))
        : this.memoryMaxRecallItems;
    try {
      return this.persistentMemory.recallForPlanning({
        repoRoot: this.repo,
        sessionId,
        includeCurrentSession: true,
        includeCrossSession: this.memoryIncludeCrossSession,
        maxItems,
        maxChars: this.memoryMaxRecallChars,
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not recall persistent planning memory:", err);
      return [];
    }
  }

  private rememberPersistentMemory(
    kind: string,
    summary: string,
    requestId: string | null = null,
    sessionId: string = this.sessionId,
  ): void {
    if (!this.memoryEnabled) return;
    try {
      this.persistentMemory.remember(
        {
          repoRoot: this.repo,
          sessionId,
          requestId,
          kind,
          summary,
        },
        {
          maxSummaryChars: this.memoryMaxSummaryChars,
          retentionDays: this.memoryRetentionDays,
        },
      );
    } catch (err) {
      console.warn("[RemoteBuddy] Could not persist planning memory:", err);
    }
  }

  private buildPlanningContext(
    priority: RequestPriority,
    sessionId: string = this.sessionId,
  ): string[] {
    const fromMemory = this.persistentPlanningContextSnapshot(priority, sessionId);
    const live = this.planningContextSnapshot(priority, sessionId);
    if (fromMemory.length === 0) return live;
    const merged = [...fromMemory, ...live];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of merged) {
      const line = String(entry ?? "").trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }

  private loadVisionRequiredValidationSteps(): string[] {
    const visionPath = resolve(this.repo, "vision.md");
    if (!existsSync(visionPath)) return [];
    try {
      return extractRequiredValidationStepsFromVisionMarkdown(readFileSync(visionPath, "utf8"));
    } catch (err) {
      console.warn("[RemoteBuddy] Could not read vision.md testing criteria:", err);
      return [];
    }
  }

  private getRecentContextSnapshot(sessionId: string = this.sessionId): string[] {
    return this.sessionContext(sessionId).slice(-RemoteBuddyOrchestrator.MAX_CONTEXT);
  }

  private executionBudgetForPriority(priority: RequestPriority): number {
    switch (priority) {
      case "interactive":
        return this.executionBudgetInteractiveMs;
      case "background":
        return this.executionBudgetBackgroundMs;
      default:
        return this.executionBudgetNormalMs;
    }
  }

  private chooseExecutionLane(
    prompt: string,
    plan: {
      lane: TaskExecutionLane;
      intent: PlannerIntent;
      risk_level: PlannerRisk;
      acceptance_criteria: string[];
      validation_steps: string[];
    },
    targetPathCount: number,
  ): TaskExecutionLane {
    if (plan.intent === "status") return "deterministic";
    if (
      plan.risk_level === "low" &&
      targetPathCount >= 1 &&
      targetPathCount <= 3 &&
      plan.validation_steps.length <= 4
    ) {
      if (prompt.trim().length <= 800) return "deterministic";
    }
    return plan.lane;
  }

  private shouldForceDirectReply(prompt: string, intent: PlannerIntent): boolean {
    if (intent !== "chat" && intent !== "status") return false;
    return !isExecutionIntent(prompt, extractExplicitTargetPath(prompt));
  }

  private resolveWorkerIdForJob(jobId: string): string | null {
    const id = String(jobId ?? "").trim();
    if (!id) return null;
    try {
      if (!this.jobsDb) {
        this.jobsDb = new Database(this.jobsDbPath);
      }
      const row = this.jobsDb.prepare("SELECT workerId FROM jobs WHERE id = ? LIMIT 1").get(id) as
        | { workerId: string | null }
        | undefined;
      const workerId = String(row?.workerId ?? "").trim();
      return workerId || null;
    } catch (err) {
      console.warn(`[RemoteBuddy] Could not resolve worker for failed job ${id}:`, err);
      return null;
    }
  }

  private async terminateManagedWorkerProcess(
    workerId: string,
    proc: ReturnType<typeof Bun.spawn>,
    reason: string,
    timeoutMs = 8_000,
  ): Promise<void> {
    const waitForExit = async (waitMs: number): Promise<boolean> => {
      const settled = await Promise.race<boolean>([
        proc.exited.then(() => true).catch(() => true),
        Bun.sleep(Math.max(0, waitMs)).then(() => false),
      ]);
      return settled;
    };

    await this.terminateProcessTreeImpl(proc, {
      terminationTimeoutMs: timeoutMs,
      exitGraceMs: 2_000,
    });
    const exited = await waitForExit(250);

    if (!exited) {
      console.warn(
        `[RemoteBuddy] WorkerPal ${workerId} did not terminate cleanly (${reason}); process may still be running.`,
      );
    }
    this.managedWorkers.delete(workerId);
  }

  private async recycleWorkerForCodexUnavailableFailure(
    jobId: string,
    message: string,
    detail: string,
  ): Promise<void> {
    if (!isCodexUnavailableFailureSignal(message, detail)) return;
    const workerId = this.resolveWorkerIdForJob(jobId);
    if (!workerId) {
      console.warn(
        `[RemoteBuddy] Codex unavailable failure for job ${jobId}, but no workerId was found; cannot recycle.`,
      );
      return;
    }

    const proc = this.managedWorkers.get(workerId);
    if (!proc) {
      console.warn(
        `[RemoteBuddy] Codex unavailable failure for job ${jobId}; worker ${workerId} is not managed by RemoteBuddy, skipping recycle.`,
      );
      return;
    }

    console.warn(
      `[RemoteBuddy] Codex unavailable for job ${jobId}; recycling WorkerPal ${workerId}.`,
    );
    await this.terminateManagedWorkerProcess(workerId, proc, "codex unavailable recycle");

    if (!this.autoSpawnWorkers) {
      console.warn(
        `[RemoteBuddy] Auto-spawn is disabled; WorkerPal ${workerId} was recycled without replacement.`,
      );
      return;
    }

    const replacement = await this.spawnWorker();
    if (replacement) {
      console.log(
        `[RemoteBuddy] WorkerPal recycle complete: replaced ${workerId} with ${replacement}.`,
      );
      return;
    }
    console.warn(
      `[RemoteBuddy] WorkerPal ${workerId} was recycled, but replacement did not become ready in time.`,
    );
  }

  private getRecentJobContext(
    limit: number = 12,
    sessionId: string = this.sessionId,
  ): WorkerRecentJobSummary[] {
    try {
      if (!this.jobsDb) {
        this.jobsDb = new Database(this.jobsDbPath);
      }
      const rows = this.jobsDb
        .prepare(
          `SELECT id, taskId, kind, status, workerId, result, error, updatedAt
           FROM jobs
           WHERE sessionId = ?
           ORDER BY updatedAt DESC
           LIMIT ?`,
        )
        .all(sessionId, Math.max(1, Math.min(limit, 50))) as Array<{
        id: string;
        taskId: string;
        kind: string;
        status: string;
        workerId: string | null;
        result: string | null;
        error: string | null;
        updatedAt: string;
      }>;

      return rows.map((row) => {
        let summary = "";
        let errorMessage = "";
        try {
          if (row.result) {
            const parsed = JSON.parse(row.result) as { summary?: string };
            summary = toSingleLine(parsed.summary ?? "");
          }
        } catch {
          summary = "";
        }
        try {
          if (row.error) {
            const parsed = JSON.parse(row.error) as { message?: string; detail?: string };
            errorMessage = toSingleLine(parsed.message ?? parsed.detail ?? "");
          }
        } catch {
          errorMessage = toSingleLine(row.error ?? "");
        }
        return {
          jobId: row.id,
          taskId: row.taskId,
          kind: row.kind,
          status: row.status,
          workerId: row.workerId,
          summary,
          error: errorMessage,
          updatedAt: row.updatedAt,
        };
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not read recent job context:", err);
      return [];
    }
  }

  private async fetchWorkers(): Promise<WorkerSnapshot[]> {
    try {
      const res = await this.fetchServiceControl(
        `${this.server}/workers?ttlMs=${this.workerOnlineTtlMs}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { ok: boolean; workers?: WorkerSnapshot[] };
      return data.ok ? (data.workers ?? []) : [];
    } catch {
      return [];
    }
  }

  private async fetchWorkerAutoscaleSnapshot(
    timeoutMs = SERVICE_CONTROL_HTTP_TIMEOUT_MS,
  ): Promise<WorkerAutoscaleSnapshot | null> {
    try {
      const res = await this.fetchServiceControl(
        `${this.server}/workers/autoscale?ttlMs=${this.workerOnlineTtlMs}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
        timeoutMs,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        ok: boolean;
        workers?: WorkerAutoscaleSnapshot["workers"];
        jobs?: WorkerAutoscaleSnapshot["jobs"];
        prs?: Partial<WorkerAutoscaleSnapshot["prs"]>;
      };
      if (!data.ok || !data.workers || !data.jobs) return null;
      return {
        workers: data.workers,
        jobs: data.jobs,
        prs: {
          openUnmerged: Math.max(0, Math.floor(Number(data.prs?.openUnmerged ?? 0))),
        },
      };
    } catch {
      return null;
    }
  }

  private pickIdleWorker(workers: WorkerSnapshot[]): WorkerSnapshot | null {
    const idle = workers
      .filter(
        (worker) => worker.isOnline && worker.status !== "offline" && worker.activeJobCount === 0,
      )
      .sort((a, b) => Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat));
    return idle[0] ?? null;
  }

  private pickOnlineWorker(
    workers: WorkerSnapshot[],
    preferredWorkerId?: string,
  ): WorkerSnapshot | null {
    const online = workers
      .filter((worker) => worker.isOnline && worker.status !== "offline")
      .sort((a, b) => Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat));
    if (preferredWorkerId) {
      return online.find((worker) => worker.workerId === preferredWorkerId) ?? null;
    }
    return online[0] ?? null;
  }

  private async waitForOnlineWorker(
    timeoutMs: number,
    preferredWorkerId?: string,
  ): Promise<WorkerSnapshot | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const workers = await this.fetchWorkers();
      const online = this.pickOnlineWorker(workers, preferredWorkerId);
      if (online) return online;
      if (Date.now() >= deadline) return null;
      await Bun.sleep(500);
    }
  }

  private async waitForIdleWorker(
    timeoutMs: number,
    preferredWorkerId?: string,
  ): Promise<WorkerSnapshot | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const workers = await this.fetchWorkers();
      if (preferredWorkerId) {
        const preferred = workers.find(
          (worker) =>
            worker.workerId === preferredWorkerId &&
            worker.isOnline &&
            worker.status !== "offline" &&
            worker.activeJobCount === 0,
        );
        if (preferred) return preferred;
      }

      const idle = this.pickIdleWorker(workers);
      if (idle) return idle;
      if (Date.now() >= deadline) return null;
      await Bun.sleep(500);
    }
  }

  private onlineWorkers(workers: WorkerSnapshot[]): WorkerSnapshot[] {
    return workers.filter((worker) => worker.isOnline && worker.status !== "offline");
  }

  private currentWorkerUnavailableReason(): string {
    if (this.workerpalsUnavailableReason) {
      return this.workerpalsUnavailableReason;
    }
    if (this.autoSpawnWorkers) {
      if (this.spawnWorkerDocker && this.spawnWorkerRequireDocker) {
        return "Docker-backed WorkerPal auto-spawn did not produce an online worker. Verify Docker is installed and running, then retry.";
      }
      return "WorkerPal auto-spawn did not produce an online worker.";
    }
    return "No online WorkerPal backends and auto-spawn is disabled.";
  }

  private desiredWorkerCountFromAutoscaleSnapshot(snapshot: WorkerAutoscaleSnapshot): number {
    const prBacklogFloor =
      Math.max(0, snapshot.prs.openUnmerged) > 0 ? Math.min(2, this.maxWorkers) : 0;
    return Math.max(
      this.minWorkers,
      Math.min(
        this.maxWorkers,
        Math.max(
          prBacklogFloor,
          snapshot.workers.online,
          snapshot.workers.busy + Math.max(0, snapshot.jobs.autoscalablePending),
        ),
      ),
    );
  }

  private async ensureAutoscaledWorkerCapacity(reason = "background"): Promise<void> {
    if (!this.autoSpawnWorkers || this.disposed) return;
    const snapshot = await this.fetchWorkerAutoscaleSnapshot();
    if (!snapshot) return;

    const desiredOnline = this.desiredWorkerCountFromAutoscaleSnapshot(snapshot);
    let online = Math.max(0, snapshot.workers.online);
    if (online >= desiredOnline) return;

    console.log(
      `[RemoteBuddy] Worker autoscaler (${reason}): online=${snapshot.workers.online} busy=${snapshot.workers.busy} pending=${snapshot.jobs.pending} autoscalablePending=${snapshot.jobs.autoscalablePending} openUnmergedPrs=${snapshot.prs.openUnmerged} target=${desiredOnline}.`,
    );

    while (!this.disposed && online < desiredOnline) {
      const spawned = await this.spawnWorker();
      if (!spawned) break;
      online += 1;
    }
  }

  private async maybeAutoscaleWorkers(): Promise<void> {
    if (!this.autoSpawnWorkers || this.disposed) return;
    const now = Date.now();
    if (now - this.lastWorkerAutoscaleAt < this.workerAutoscalePollMs) return;
    this.lastWorkerAutoscaleAt = now;
    await this.ensureAutoscaledWorkerCapacity("poll");
  }

  private buildWorkerSpawnCommand(workerId: string): string[] {
    return buildWorkerSpawnCommand({
      server: this.server,
      workerId,
      repoRoot: this.repo,
      pollMs: this.spawnWorkerPollMs,
      heartbeatMs: this.spawnWorkerHeartbeatMs,
      labels: this.spawnWorkerLabels,
      docker: this.spawnWorkerDocker,
      requireDocker: this.spawnWorkerRequireDocker,
      dockerImage: this.spawnWorkerImage,
      binaryPath: this.workerpalsBinaryPath,
      sourceBundlePath: this.workerpalsSourceBundlePath,
      bunExecutable: this.workerpalsBunExecutable,
      launchTrampolinePath: this.workerpalsLaunchTrampolinePath,
      envFile: this.workerpalsEnvFile,
      entrypoint: this.workerpalsEntrypoint,
    });
  }

  private maybeFallbackFromDockerAfterWorkerExit(workerId: string, code: number | null): boolean {
    if (code !== CODEX_STARTUP_STALL_WORKER_EXIT_CODE) return false;
    if (!this.spawnWorkerDocker) return false;
    if (this.workerDockerFallbackActivated) return false;
    if (parseEnabledFlag(process.env.REMOTEBUDDY_DISABLE_WORKERPAL_DIRECT_FALLBACK, false)) {
      console.warn(
        `[RemoteBuddy] WorkerPal ${workerId} exited after a Docker Codex startup stall, but direct WorkerPal fallback is disabled.`,
      );
      return false;
    }

    this.workerDockerFallbackActivated = true;
    this.spawnWorkerDocker = false;
    this.spawnWorkerRequireDocker = false;
    this.workerSpawnCooldownUntil = 0;
    this.workerpalsUnavailableReason =
      "Docker-backed WorkerPal Codex startup stalled; falling back to direct isolated-worktree WorkerPal.";
    console.warn(
      `[RemoteBuddy] WorkerPal ${workerId} exited after a Docker Codex startup stall; falling back to direct isolated-worktree WorkerPal for future spawns.`,
    );
    return true;
  }

  private async spawnWorker(): Promise<string | null> {
    if (this.workerSpawnInFlight) {
      return await this.workerSpawnInFlight;
    }

    if (this.managedWorkers.size >= this.maxWorkers) {
      return null;
    }

    if (this.workerSpawnCooldownUntil > Date.now()) {
      const retryInMs = Math.max(0, this.workerSpawnCooldownUntil - Date.now());
      this.workerpalsUnavailableReason = `WorkerPal spawn cooldown in effect; retrying in ${retryInMs}ms.`;
      return null;
    }

    const spawnPromise = (async () => {
      this.workerpalsUnavailableReason = null;
      const workerId = createWorkerPalId();
      const cmd = this.buildWorkerSpawnCommand(workerId);
      console.log(
        `[RemoteBuddy] Spawning WorkerPal ${workerId} (${this.managedWorkers.size + 1}/${this.maxWorkers})`,
      );
      try {
        const child = Bun.spawn(cmd, {
          cwd: this.repo,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          detached: process.platform !== "win32",
        });
        this.managedWorkers.set(workerId, child);
        child.exited.then((code) => {
          this.managedWorkers.delete(workerId);
          if (this.maybeFallbackFromDockerAfterWorkerExit(workerId, code)) {
            void this.ensureAutoscaledWorkerCapacity("docker codex startup fallback");
          }
          console.warn(`[RemoteBuddy] WorkerPal process ${workerId} exited with code ${code}`);
        });

        const ready = await this.waitForOnlineWorker(this.workerStartupTimeoutMs, workerId);
        if (ready) {
          this.workerSpawnCooldownUntil = 0;
          if (ready.activeJobCount > 0 || ready.status === "busy") {
            console.log(
              `[RemoteBuddy] WorkerPal ${ready.workerId} came online and is already busy; treating startup as healthy.`,
            );
          }
          return ready.workerId;
        }
        this.workerpalsUnavailableReason =
          this.spawnWorkerDocker && this.spawnWorkerRequireDocker
            ? `WorkerPal ${workerId} did not report online within ${this.workerStartupTimeoutMs}ms. Verify Docker is installed, running, and able to start the WorkerPal sandbox image.`
            : `WorkerPal ${workerId} did not report online within ${this.workerStartupTimeoutMs}ms.`;
        console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
        await this.terminateManagedWorkerProcess(workerId, child, "startup timeout");
        this.workerSpawnCooldownUntil = Date.now() + this.workerSpawnBackoffMs;
        return null;
      } catch (err) {
        this.workerpalsUnavailableReason =
          this.spawnWorkerDocker && this.spawnWorkerRequireDocker
            ? `Failed to spawn Docker-backed WorkerPal: ${String(err)}`
            : `Failed to spawn WorkerPal: ${String(err)}`;
        console.error(`[RemoteBuddy] Failed to spawn WorkerPal ${workerId}:`, err);
        this.workerSpawnCooldownUntil = Date.now() + this.workerSpawnBackoffMs;
        return null;
      }
    })();

    this.workerSpawnInFlight = spawnPromise;
    try {
      return await spawnPromise;
    } finally {
      if (this.workerSpawnInFlight === spawnPromise) {
        this.workerSpawnInFlight = null;
      }
    }
  }

  async ensureWorkerCapacityOnStartup(): Promise<void> {
    if (this.workerPrewarmDelayMs > 0) {
      console.log(
        `[RemoteBuddy] Waiting ${this.workerPrewarmDelayMs}ms before WorkerPal startup prewarm.`,
      );
      await Bun.sleep(this.workerPrewarmDelayMs);
      if (this.disposed) return;
    }
    const workers = await this.fetchWorkers();
    if (this.pickIdleWorker(workers)) {
      return;
    }
    const onlineWorkers = this.onlineWorkers(workers);
    if (!this.autoSpawnWorkers) {
      if (onlineWorkers.length > 0) {
        const idleWorker = await this.waitForIdleWorker(Math.max(this.waitForWorkerMs, 5_000));
        if (idleWorker) {
          console.log(
            `[RemoteBuddy] Initial WorkerPal capacity became idle via ${idleWorker.workerId}.`,
          );
          return;
        }
        this.workerpalsUnavailableReason = `${onlineWorkers.length} online WorkerPal(s) reported but none became idle within ${Math.max(
          this.waitForWorkerMs,
          5_000,
        )}ms.`;
        console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
      }
      return;
    }
    if (onlineWorkers.length < this.maxWorkers) {
      console.log("[RemoteBuddy] Prewarming initial WorkerPal capacity...");
      const spawned = await this.spawnWorker();
      if (spawned) {
        console.log(`[RemoteBuddy] Initial WorkerPal capacity ready via ${spawned}.`);
        void this.ensureAutoscaledWorkerCapacity("startup warm pool");
        return;
      }
    }

    const idleWorker = await this.waitForIdleWorker(
      Math.max(this.waitForWorkerMs, this.workerStartupTimeoutMs),
    );
    if (idleWorker) {
      console.log(
        `[RemoteBuddy] Initial WorkerPal capacity became idle via ${idleWorker.workerId}.`,
      );
      void this.ensureAutoscaledWorkerCapacity("startup warm pool");
      return;
    }
    const after = await this.fetchWorkers();
    const onlineAfter = this.onlineWorkers(after);
    if (onlineAfter.length > 0) {
      this.workerpalsUnavailableReason = `${onlineAfter.length} online WorkerPal(s) reported but none became idle within ${Math.max(
        this.waitForWorkerMs,
        this.workerStartupTimeoutMs,
      )}ms.`;
      console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
      return;
    }

    console.warn(`[RemoteBuddy] ${this.currentWorkerUnavailableReason()}`);
  }

  startWorkerCapacityPrewarmOnStartup(): void {
    if (this.workerStartupPrewarmInFlight || this.disposed) return;
    this.workerStartupPrewarmInFlight = this.ensureWorkerCapacityOnStartup()
      .catch((err) => {
        this.workerpalsUnavailableReason = `WorkerPal startup prewarm failed: ${String(err)}`;
        console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
      })
      .finally(() => {
        this.workerStartupPrewarmInFlight = null;
      });
  }

  private async selectTargetWorkerForJob(): Promise<string | null> {
    const workers = await this.fetchWorkers();
    const idleNow = this.pickIdleWorker(workers);
    if (idleNow) {
      return idleNow.workerId;
    }

    const onlineWorkers = workers.filter(
      (worker) => worker.isOnline && worker.status !== "offline",
    );
    if (this.autoSpawnWorkers && onlineWorkers.length < this.maxWorkers) {
      const spawned = await this.spawnWorker();
      if (spawned) return spawned;
    }

    const waited = await this.waitForIdleWorker(this.waitForWorkerMs);
    return waited?.workerId ?? null;
  }

  // In this architecture, RemoteBuddy only creates tasks/jobs via polling.
  // Job completion tracking is handled by the server event stream and workers.
  // ── Dispatch, Polling for Request Queue ────────────────────────────────────────

  /** Process a request from the Request Queue (replaces handleMessage) */
  private async processRequest(
    request: {
      id: string;
      sessionId?: string;
      prompt: string;
      priority?: string;
      queueWaitBudgetMs?: number;
      forceWorker?: boolean;
      forceLane?: TaskExecutionLane;
      metadata?: Record<string, unknown>;
      metadataJson?: string | null;
      claimToken: string;
    },
    queueWaitMs = 0,
  ): Promise<void> {
    const requestId = String(request.id ?? "").trim();
    if (!requestId) return;
    const claimToken = String(request.claimToken ?? "").trim();
    if (!claimToken) {
      console.error(`[RemoteBuddy] Claimed request ${requestId} did not include a fencing token.`);
      return;
    }
    const requestSessionId = String(request.sessionId ?? "").trim() || this.sessionId;

    await this.ensureSessionWithRetry(requestSessionId, 3, 250, 2_000);
    this.ensureSessionEventMonitor(requestSessionId);

    // RequestQueue's claim lease and terminal state are authoritative here.
    // Marking the ID handled before a durable handoff made crash recovery skip
    // the requeued request forever.

    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) {
      console.warn(`[RemoteBuddy] Request ${requestId} missing prompt; marking failed`);
      await this.fetchServiceControl(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          agentId: this.agentId,
          claimToken,
          message: "Request missing prompt",
        }),
      }).catch(() => {});
      return;
    }

    const reqAny = request as any;
    let forceWorker = Boolean(reqAny.forceWorker ?? reqAny.force_worker);
    const laneRaw = String(reqAny.forceLane ?? reqAny.force_lane ?? "")
      .trim()
      .toLowerCase();
    let forceLane: TaskExecutionLane | undefined =
      laneRaw === "deterministic" || laneRaw === "worker"
        ? (laneRaw as TaskExecutionLane)
        : undefined;
    const autonomyMetadata = parseAutonomyRequestMetadata(reqAny.metadata ?? reqAny.metadataJson);
    if (autonomyMetadata) {
      forceWorker = true;
      forceLane = "worker";
    }

    const priority = normalizeRequestPriority(request.priority);
    const queueWaitBudgetMs = Math.max(
      5_000,
      Number.isFinite(Number(request.queueWaitBudgetMs))
        ? Number(request.queueWaitBudgetMs)
        : priority === "interactive"
          ? 20_000
          : priority === "background"
            ? 240_000
            : 90_000,
    );
    const turnId = randomUUID();
    const eventFrom = autonomyMetadata ? `agent:${this.agentId}/autonomy` : undefined;
    const planningContext = this.buildPlanningContext(priority, requestSessionId);
    let durableWorkerJob: EnqueueJobResult | null = null;
    this.rememberPersistentMemory(
      "request",
      `priority=${priority} prompt=${toSingleLine(prompt, 520)}`,
      requestId,
      requestSessionId,
    );

    try {
      console.log(
        `[RemoteBuddy] Planning request ${requestId.slice(0, 8)} session=${requestSessionId} priority=${priority} queueWait=${Math.max(
          0,
          Math.floor(queueWaitMs),
        )}ms${forceWorker ? ` forceWorker=true forceLane=${forceLane ?? "worker"}` : ""}`,
      );

      const plan: PlannerOutput = await this.brain.think(prompt, planningContext, {
        forceWorker,
        forceLane,
      });
      if (autonomyMetadata) {
        // Autonomy requests are durably stored as worker-required. Do not let a
        // planner classification silently downgrade that server-side invariant.
        plan.requires_worker = true;
        plan.job_kind = "task.execute";
        plan.lane = "worker";
        plan.scope.read_anywhere = true;
        plan.scope.write_allowed = true;
        plan.scope.write_globs = [...autonomyMetadata.writeGlobs];
      }
      this.pushContext(`[user] ${toSingleLine(prompt, 700)}`, requestSessionId);
      this.pushContext(`[plan] ${toSingleLine(JSON.stringify(plan), 900)}`, requestSessionId);
      let targetPaths =
        autonomyMetadata && autonomyMetadata.targetPaths.length > 0
          ? autonomyMetadata.targetPaths
          : plannerTargetPaths(plan, prompt);
      const repoHintPreflight = sanitizeRepoNativeTargetHints({
        repoRoot: this.repo,
        prompt,
        plan,
        targetPaths,
      });
      targetPaths = repoHintPreflight.targetPaths;
      if (repoHintPreflight.diagnostics.length > 0) {
        console.warn(
          `[RemoteBuddy] Repo hint preflight: ${repoHintPreflight.diagnostics
            .slice(0, 3)
            .join(" | ")}`,
        );
      }
      this.rememberPersistentMemory(
        "plan",
        `intent=${plan.intent} worker=${plan.requires_worker ? "yes" : "no"} lane=${plan.lane} risk=${plan.risk_level} targets=${targetPaths.slice(0, 6).join(",") || "(none)"}`,
        requestId,
        requestSessionId,
      );
      const targetPath = targetPaths[0];
      const requiresWorker = forceWorker
        ? true
        : this.shouldForceDirectReply(prompt, plan.intent)
          ? false
          : plan.requires_worker;
      console.log("[RemoteBuddy] Planner output:", { plan, targetPath, requiresWorker });
      let requiredValidationSteps: string[] = [];
      // when forcing worker, don't fail on "planner contract incomplete" — fill safe defaults.
      if (requiresWorker) {
        requiredValidationSteps = this.loadVisionRequiredValidationSteps();
        if (requiredValidationSteps.length > 0) {
          console.log(
            `[RemoteBuddy] Loaded ${requiredValidationSteps.length} required validation step(s) from vision.md testing criteria.`,
          );
        }
        const scopeCoverage = ensureWriteGlobsCoverTargetPaths(targetPaths, plan.scope.write_globs);
        if (scopeCoverage.normalizedWriteGlobs.length > 0) {
          plan.scope.write_globs = scopeCoverage.normalizedWriteGlobs;
        }
        if (scopeCoverage.addedGlobs.length > 0) {
          console.warn(
            `[RemoteBuddy] Planner write_globs did not cover target paths. Added scope globs: ${scopeCoverage.addedGlobs.join(
              ", ",
            )}`,
          );
        }
        if (forceWorker && !autonomyMetadata) {
          const concreteTargetCount = targetPaths.filter((entry) => entry && entry !== ".").length;
          if (concreteTargetCount > 0) {
            const currentMax =
              Number.isFinite(Number(plan.scope.max_files_to_edit)) &&
              Number(plan.scope.max_files_to_edit) > 0
                ? Math.floor(Number(plan.scope.max_files_to_edit))
                : 0;
            if (currentMax < concreteTargetCount) {
              plan.scope.max_files_to_edit = concreteTargetCount;
            }
          }
        }
        if (plan.acceptance_criteria.length === 0) {
          plan.acceptance_criteria = ["Produce a correct and helpful result for the user request."];
        }
        plan.validation_steps = normalizeValidationSteps(plan.validation_steps, targetPaths);
        if (plan.validation_steps.length === 0) {
          plan.validation_steps = defaultValidationStepsForRequest(prompt, targetPaths);
          console.warn(
            `[RemoteBuddy] Planner returned no validation_steps; using fallback: ${plan.validation_steps.join(
              " | ",
            )}`,
          );
        }

        // Keep strictness only for non-forced paths.
        if (!forceWorker) {
          const missing: string[] = [];
          if (targetPaths.length === 0 && repoHintPreflight.diagnostics.length === 0) {
            missing.push("target_paths");
          }
          if (plan.acceptance_criteria.length === 0) missing.push("acceptance_criteria");
          if (plan.validation_steps.length === 0) missing.push("validation_steps");
          if (missing.length > 0) {
            throw new Error(
              `Planner contract incomplete for task.execute: missing ${missing.join(
                ", ",
              )}. RemoteBuddy requires explicit target paths, acceptance criteria, and validation steps.`,
            );
          }
        }
      }

      // allow forcing lane (default to openhands for forced worker)
      let lane = requiresWorker
        ? this.chooseExecutionLane(prompt, plan, targetPaths.length)
        : "deterministic";
      if (requiresWorker && lane === "deterministic" && (!targetPath || targetPath === ".")) {
        lane = "worker";
      }
      if (forceWorker) {
        lane = forceLane ?? "worker";
      }

      const canonicalInstruction = prompt.trim();
      const rawPlannerInstruction = sanitizePlannerWorkerInstruction(
        String(plan.worker_instruction ?? ""),
        canonicalInstruction,
      );
      const executionGuidance = buildExecutionGuidance(
        plan,
        targetPaths,
        requiredValidationSteps,
        repoHintPreflight.diagnostics,
      );
      const plannerWorkerInstruction = [rawPlannerInstruction, executionGuidance]
        .filter(Boolean)
        .join("\n\n")
        .trim();

      if (queueWaitMs > queueWaitBudgetMs) {
        await this.assistantMessage(
          requestSessionId,
          `Request ${requestId.slice(0, 8)} waited ${Math.floor(
            queueWaitMs / 1000,
          )}s in queue (budget ${Math.floor(queueWaitBudgetMs / 1000)}s). Prioritizing execution now.`,
          { turnId, correlationId: requestId, from: eventFrom },
        );
      }

      if (!requiresWorker) {
        if (!autonomyMetadata) {
          await this.sendCommand(requestSessionId, {
            type: "assistant_message",
            payload: { text: plan.assistant_message },
            turnId,
          });
        }

        // For any intent that isn't a pure conversational reply (chat/status), the planner
        // returning requires_worker=false is ambiguous — ask the user or re-route to the engine.
        if (plan.intent !== "chat" && plan.intent !== "status") {
          if (autonomyMetadata && CONFIG.remotebuddy.autonomy.enabled) {
            // Option 3: autonomous engine origin — re-enqueue the worker instruction so
            // the engine can drive next-step execution rather than silently dropping it.
            const workerInstruction = canonicalizeInstructionTextForBun(
              String(plan.worker_instruction ?? "").trim() || plan.assistant_message,
            );
            const enqueued = await this.autonomousEngine.enqueueFromAnalysis(
              workerInstruction,
              autonomyMetadata,
              requestId,
            );
            if (enqueued) {
              console.log(
                `[RemoteBuddy] Non-chat intent (${plan.intent}) from engine re-enqueued as worker request ${enqueued}`,
              );
            } else {
              console.warn(
                `[RemoteBuddy] Non-chat intent (${plan.intent}) from engine: enqueueFromAnalysis returned null (engine disabled or enqueue failed)`,
              );
            }
          } else if (!autonomyMetadata) {
            // Option 2: user origin — ask if they want a worker to implement this.
            await this.assistantMessage(
              requestSessionId,
              "Should I have a WorkerPal implement this? Reply to confirm and I'll enqueue the work, or clarify what you'd like focused on.",
              { turnId, correlationId: requestId, from: eventFrom },
            );
          }
        }

        const completionResult = await this.postRequestLifecycleTransition({
          requestId,
          transition: "complete",
          claimToken,
          body: {
            agentId: this.agentId,
            claimToken,
            result: {
              requiresWorker: false,
              intent: plan.intent,
              lane: "deterministic",
              priority,
              queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
              forceWorker,
              forceLane: forceLane ?? null,
            },
          },
        });
        if (!completionResult.ok) {
          throw new Error(
            `request completion was not durably acknowledged${completionResult.detail ? `: ${completionResult.detail}` : ""}`,
          );
        }
        this.rememberPersistentMemory(
          "decision",
          `completed_without_worker intent=${plan.intent} lane=deterministic`,
          requestId,
          requestSessionId,
        );
        return;
      }

      const taskId = randomUUID();
      const targetWorkerId = await this.selectTargetWorkerForJob();
      if (!targetWorkerId) {
        const onlineWorkers = this.onlineWorkers(await this.fetchWorkers());
        if (onlineWorkers.length === 0) {
          const detail = this.currentWorkerUnavailableReason();
          const userMessage =
            "WorkerPal execution is currently unavailable in this runtime. " + detail;
          console.warn(`[RemoteBuddy] ${userMessage}`);
          await this.assistantMessage(requestSessionId, userMessage, {
            turnId,
            correlationId: requestId,
            from: eventFrom,
          });
          await this.fetchServiceControl(`${this.server}/requests/${requestId}/fail`, {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({
              agentId: this.agentId,
              claimToken,
              message: "WorkerPal backend unavailable",
              detail,
            }),
          }).catch(() => {});
          return;
        }
      }
      if (!autonomyMetadata) {
        await this.assistantMessage(
          requestSessionId,
          "Understood. I am delegating this to a WorkerPal now.",
          {
            turnId,
            correlationId: requestId,
          },
        );
      }
      const executionBudgetMs = this.executionBudgetForPriority(priority);
      const strictTargetPaths = targetPaths.filter((entry) => entry && entry !== ".");
      const baseParams: BaseTaskExecuteJobParams = {
        schemaVersion: 2,
        requestId,
        sessionId: requestSessionId,
        instruction: canonicalInstruction,
        plannerWorkerInstruction:
          plannerWorkerInstruction && plannerWorkerInstruction !== canonicalInstruction
            ? plannerWorkerInstruction
            : undefined,
        lane,
        ...(targetPaths.length > 0 ? { paths: targetPaths } : {}),
        planning: {
          intent: plan.intent,
          riskLevel: plan.risk_level,
          ...(strictTargetPaths.length > 0 ? { targetPaths: strictTargetPaths } : {}),
          scope: {
            readAnywhere: plan.scope.read_anywhere,
            writeAllowed: plan.scope.write_allowed,
            ...(plan.scope.write_globs && plan.scope.write_globs.length > 0
              ? { writeGlobs: plan.scope.write_globs }
              : {}),
            ...(plan.scope.forbidden_globs && plan.scope.forbidden_globs.length > 0
              ? { forbiddenGlobs: plan.scope.forbidden_globs }
              : {}),
            ...(plan.scope.max_files_to_edit && plan.scope.max_files_to_edit > 0
              ? { maxFilesToEdit: plan.scope.max_files_to_edit }
              : {}),
          },
          ...(plan.discovery
            ? {
                discovery: {
                  ripgrepQueries: plan.discovery.ripgrep_queries,
                  ...(plan.discovery.likely_dirs && plan.discovery.likely_dirs.length > 0
                    ? { likelyDirs: plan.discovery.likely_dirs }
                    : {}),
                  ...(plan.discovery.keywords && plan.discovery.keywords.length > 0
                    ? { keywords: plan.discovery.keywords }
                    : {}),
                },
              }
            : {}),
          acceptanceCriteria: plan.acceptance_criteria,
          validationSteps: plan.validation_steps,
          ...(repoHintPreflight.diagnostics.length > 0
            ? { repoHintDiagnostics: repoHintPreflight.diagnostics }
            : {}),
          ...(requiredValidationSteps.length > 0 ? { requiredValidationSteps } : {}),
          queuePriority: priority,
          queueWaitBudgetMs,
          executionBudgetMs,
          finalizationBudgetMs: this.finalizationBudgetMs,
        },
        targetPath,
        recentContext: this.getRecentContextSnapshot(requestSessionId),
        recentJobs: this.getRecentJobContext(12, requestSessionId),
      };
      const params: TaskExecuteJobParams = autonomyMetadata
        ? {
            ...baseParams,
            origin: "autonomy",
            autonomy: {
              origin: "autonomy",
              ...(autonomyMetadata.objectiveId
                ? { objectiveId: autonomyMetadata.objectiveId }
                : {}),
              ...(autonomyMetadata.runId ? { runId: autonomyMetadata.runId } : {}),
              ...(autonomyMetadata.snapshotId ? { snapshotId: autonomyMetadata.snapshotId } : {}),
              ...(autonomyMetadata.patternKey ? { patternKey: autonomyMetadata.patternKey } : {}),
              ...(autonomyMetadata.componentArea
                ? { componentArea: autonomyMetadata.componentArea }
                : {}),
              ...(autonomyMetadata.validationIncident
                ? { validationIncident: autonomyMetadata.validationIncident }
                : {}),
            },
          }
        : {
            ...baseParams,
            origin: "user",
          };

      const enqueueOutcome = await this.enqueueJob(
        taskId,
        "task.execute",
        requestSessionId,
        params,
        targetWorkerId,
        claimToken,
      );
      const enqueueAmbiguous = Boolean(enqueueOutcome && "ambiguous" in enqueueOutcome);
      const enqueueResult =
        enqueueOutcome && !("ambiguous" in enqueueOutcome) ? enqueueOutcome : null;
      if (enqueueResult) {
        durableWorkerJob = enqueueResult;
        const effectiveTaskId = enqueueResult.taskId;
        if (!enqueueResult.deduped) {
          await this.sendCommand(requestSessionId, {
            type: "task_created",
            payload: {
              taskId: effectiveTaskId,
              title: `Execute request: ${toSingleLine(prompt, 64) || "user request"}`,
              description:
                lane === "deterministic"
                  ? "Deterministic execution lane (fast path)"
                  : "Agentic worker execution lane",
              createdBy: autonomyMetadata ? "autonomy" : `agent:${this.agentId}`,
              ...(autonomyMetadata ? { tags: ["autonomy"] } : {}),
              priority,
            },
            turnId,
            from: eventFrom,
          });
          await this.sendCommand(requestSessionId, {
            type: "task_started",
            payload: { taskId: effectiveTaskId },
            turnId,
            from: eventFrom,
          });
        }
        await this.sendCommand(requestSessionId, {
          type: "task_progress",
          payload: {
            taskId: effectiveTaskId,
            message: enqueueResult.deduped
              ? "Reused active WorkerPal task for the same targeted file scope"
              : targetWorkerId
                ? `Assigned to WorkerPal ${targetWorkerId} (${lane} lane)`
                : "No idle WorkerPal available; queued for first available WorkerPal",
          },
          turnId,
          from: eventFrom,
        });

        if (!autonomyMetadata) {
          await this.assistantMessage(
            requestSessionId,
            enqueueResult.deduped
              ? "A matching WorkerPal task is already in progress for the same targeted file scope. Reusing that task instead of queuing a duplicate."
              : targetWorkerId
                ? `Assigned this request to WorkerPal ${targetWorkerId} (${lane} lane).`
                : "No idle WorkerPal right now; request is queued and waiting for the next available WorkerPal.",
            { turnId, correlationId: requestId },
          );
        }

        this.rememberPersistentMemory(
          enqueueResult.deduped ? "job_reused" : "job_enqueued",
          `job=${enqueueResult.jobId.slice(0, 8)} lane=${lane} intent=${plan.intent} worker=${targetWorkerId ?? "queue"} deduped=${enqueueResult.deduped ? "yes" : "no"}`,
          requestId,
          requestSessionId,
        );
        if (!enqueueResult.deduped) {
          await this.sendCommand(requestSessionId, {
            type: "job_enqueued",
            payload: {
              jobId: enqueueResult.jobId,
              taskId: effectiveTaskId,
              kind: "task.execute",
              params,
              origin: autonomyMetadata ? "autonomy" : "user",
              ...(autonomyMetadata
                ? {
                    autonomy: {
                      ...(autonomyMetadata.objectiveId
                        ? { objectiveId: autonomyMetadata.objectiveId }
                        : {}),
                      ...(autonomyMetadata.runId ? { runId: autonomyMetadata.runId } : {}),
                      ...(autonomyMetadata.snapshotId
                        ? { snapshotId: autonomyMetadata.snapshotId }
                        : {}),
                      ...(autonomyMetadata.patternKey
                        ? { patternKey: autonomyMetadata.patternKey }
                        : {}),
                    },
                  }
                : {}),
            },
            turnId,
            from: eventFrom,
          });
        }
      } else {
        if (enqueueAmbiguous) {
          const detail = (enqueueOutcome as AmbiguousEnqueueJobResult).detail;
          console.warn(
            `[RemoteBuddy] Request ${requestId.slice(0, 8)} has an ambiguous job enqueue; leaving its lease lifecycle recoverable: ${detail}`,
          );
          this.rememberPersistentMemory(
            "handoff_reconciliation_pending",
            `enqueue_acknowledgement_ambiguous detail=${detail}`,
            requestId,
            requestSessionId,
          );
          if (!autonomyMetadata) {
            await this.assistantMessage(
              requestSessionId,
              "The WorkerPal enqueue acknowledgement was interrupted. I am preserving the request for automatic reconciliation instead of reporting a false failure.",
              { turnId, correlationId: requestId, from: eventFrom },
            );
          }
          return;
        }
        if (!autonomyMetadata) {
          await this.assistantMessage(
            requestSessionId,
            "I could not queue this WorkerPal task. No task was started.",
            { turnId, correlationId: requestId, from: eventFrom },
          );
        }
        this.rememberPersistentMemory(
          "job_enqueue_failed",
          `enqueue_failed lane=${lane} intent=${plan.intent} origin=${autonomyMetadata ? "autonomy" : "user"}`,
          requestId,
          requestSessionId,
        );
        await this.fetchServiceControl(`${this.server}/requests/${requestId}/fail`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({
            agentId: this.agentId,
            claimToken,
            message: "WorkerPal handoff failed",
            detail:
              "Planner required a worker, but no task.execute job was created. The request remains failed instead of being recorded as a completed dispatch.",
          }),
        }).catch(() => {});
        return;
      }

      const handoffResult = await this.postRequestLifecycleTransition({
        requestId,
        transition: "worker-handoff",
        claimToken,
        jobId: enqueueResult.jobId,
        body: {
          agentId: this.agentId,
          claimToken,
          jobId: enqueueResult.jobId,
          taskId: enqueueResult.taskId,
        },
      });
      if (!handoffResult.ok) {
        throw new Error(
          `durable WorkerPal handoff was not acknowledged${handoffResult.detail ? `: ${handoffResult.detail}` : ""}`,
        );
      }

      const completionResult = await this.postRequestLifecycleTransition({
        requestId,
        transition: "complete",
        claimToken,
        jobId: enqueueResult.jobId,
        body: {
          agentId: this.agentId,
          claimToken,
          result: {
            requiresWorker: true,
            jobId: enqueueResult.jobId,
            taskId: enqueueResult.taskId,
            deduped: enqueueResult.deduped,
            intent: plan.intent,
            lane,
            priority,
            riskLevel: plan.risk_level,
            queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
            executionBudgetMs,
            finalizationBudgetMs: this.finalizationBudgetMs,
            scope: plan.scope,
            discovery: plan.discovery ?? null,
            acceptanceCriteria: plan.acceptance_criteria,
            validationSteps: plan.validation_steps,
            forceWorker,
            forceLane: forceLane ?? null,
          },
        },
      });
      if (!completionResult.ok) {
        throw new Error(
          `request completion was not durably acknowledged${completionResult.detail ? `: ${completionResult.detail}` : ""}`,
        );
      }
    } catch (err) {
      if (durableWorkerJob) {
        const detail = toSingleLine(err, 400) || "request lifecycle callback was interrupted";
        console.warn(
          `[RemoteBuddy] Durable WorkerPal job ${durableWorkerJob.jobId.slice(0, 8)} exists for request ${requestId.slice(0, 8)}; server reconciliation will close the planning handoff after callback uncertainty: ${detail}`,
        );
        this.rememberPersistentMemory(
          "handoff_reconciliation_pending",
          `job=${durableWorkerJob.jobId} detail=${detail}`,
          requestId,
          requestSessionId,
        );
        return;
      }
      const message = `RemoteBuddy planning failed: ${toSingleLine(err, 220) || "unknown error"}`;
      console.error(`[RemoteBuddy] ${message}`);
      this.rememberPersistentMemory("planning_failed", message, requestId, requestSessionId);
      await this.assistantMessage(requestSessionId, message, {
        turnId,
        correlationId: requestId,
        from: eventFrom,
      });
      await this.fetchServiceControl(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          agentId: this.agentId,
          claimToken,
          message: "RemoteBuddy planning failed",
          detail: String(err),
        }),
      }).catch(() => {});
    }
  }

  /** Start polling the Request Queue */
  async startPolling(pollMs: number = 2000): Promise<void> {
    console.log(`[RemoteBuddy] Starting polling loop (every ${pollMs}ms)`);

    while (!this.disposed) {
      try {
        await this.maybeAutoscaleWorkers();
        if (this.requestLeaseHeartbeats.size > 0) {
          await Bun.sleep(pollMs);
          continue;
        }
        const res = await this.fetchServiceControl(`${this.server}/requests/claim`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ agentId: this.agentId, leaseMs: REQUEST_LEASE_MS }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            ok: boolean;
            request?: {
              id: string;
              sessionId?: string;
              prompt: string;
              priority?: string;
              queueWaitBudgetMs?: number;
              forceWorker?: boolean;
              forceLane?: TaskExecutionLane;
              metadata?: Record<string, unknown>;
              metadataJson?: string | null;
              claimToken: string;
            };
            queueWaitMs?: number;
          };
          console.log("[RemoteBuddy] claim payload:", JSON.stringify(data, null, 2));
          if (data.ok && data.request) {
            console.log(
              `[RemoteBuddy] Claimed request ${data.request.id}${
                data.request.forceWorker ? ` (forceWorker=true)` : ""
              }`,
            );
            const stopRequestLeaseHeartbeat = this.startRequestLeaseHeartbeat(
              data.request.id,
              data.request.claimToken,
            );
            // Serialize processing. The lease starts before the work enters the
            // chain so queueing behind another planner cannot make it stale.
            this.chain = this.chain
              .then(() => this.processRequest(data.request!, Number(data.queueWaitMs ?? 0)))
              .catch((err) => console.error("[RemoteBuddy] Process error:", err))
              .finally(stopRequestLeaseHeartbeat);
          }
        }
      } catch (err) {
        console.error(`[RemoteBuddy] Poll error:`, err);
      }

      await Bun.sleep(pollMs);
    }
  }

  startAutonomy(): void {
    if (!this.autonomyRuntimeEnabled) {
      console.log(
        "[RemoteBuddy] Autonomous engine disabled by config (remotebuddy.autonomy.enabled=false).",
      );
      this.autonomousEngine.setRuntimeEnabled(false);
      return;
    }
    this.autonomousEngine.setRuntimeEnabled(true);
    this.autonomousEngine.start();
  }

  private applyAutonomyEnabledFromRuntimeConfig(enabled: boolean): void {
    if (enabled === this.autonomyRuntimeEnabled) return;

    this.autonomyRuntimeEnabled = enabled;
    this.autonomousEngine.setRuntimeEnabled(enabled);
    if (enabled) {
      this.autonomousEngine.start();
      console.log(
        "[RemoteBuddy] Autonomous engine enabled via runtime config (remotebuddy.autonomy.enabled=true).",
      );
      return;
    }

    this.autonomousEngine.stop();
    console.log(
      "[RemoteBuddy] Autonomous engine disabled via runtime config (remotebuddy.autonomy.enabled=false).",
    );
  }

  startAutonomyRuntimeConfigPolling(): void {
    if (this.autonomyConfigPollTimer) return;
    this.autonomyConfigPollTimer = setInterval(() => {
      if (this.disposed) return;
      try {
        const latest = loadPushPalsConfig({ reload: true });
        const enabled = Boolean(latest.remotebuddy.autonomy.enabled);
        this.applyAutonomyEnabledFromRuntimeConfig(enabled);
      } catch (err) {
        console.warn(`[RemoteBuddy] Runtime config poll failed: ${String(err)}`);
      }
    }, this.autonomyConfigPollMs);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.autonomyConfigPollTimer) {
      clearInterval(this.autonomyConfigPollTimer);
      this.autonomyConfigPollTimer = null;
    }
    this.autonomousEngine.stop();
    if (this.statusHeartbeatTimer) {
      clearInterval(this.statusHeartbeatTimer);
      this.statusHeartbeatTimer = null;
    }
    for (const requestId of Array.from(this.requestLeaseHeartbeats.keys())) {
      this.stopRequestLeaseHeartbeat(requestId);
    }
    void this.comm.status(this.agentId, "shutting_down", "RemoteBuddy shutting down");
    for (const [sessionId, stop] of this.sessionEventStops.entries()) {
      try {
        stop();
      } catch {
        // ignore unsubscribe errors on shutdown
      }
      this.sessionEventStops.delete(sessionId);
    }
    this.fatalSessionMonitors.clear();
    this.sessionMonitorWsErrorCounts.clear();
    this.workerSpawnCooldownUntil = 0;
    this.workerSpawnInFlight = null;
    const shutdownWorkers = Array.from(this.managedWorkers.entries()).map(([workerId, proc]) =>
      this.terminateManagedWorkerProcess(workerId, proc, "remotebuddy shutdown"),
    );
    if (shutdownWorkers.length > 0) {
      await Promise.allSettled(shutdownWorkers);
    }
    if (this.jobsDb) {
      try {
        this.jobsDb.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.jobsDb = null;
    }
    try {
      this.persistentMemory.close();
    } catch {
      // ignore close errors on shutdown
    }
  }
}

// ─── Bootstrap: connect with retry ──────────────────────────────────────────

async function connectWithRetry(
  server: string,
  sessionId?: string,
  maxRetries = Infinity,
  baseDelay = 2000,
  maxDelay = 30000,
): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetchBufferedWithHardDeadline({
        input: `${server}/sessions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionId ? { sessionId } : {}),
        },
        timeoutMs: STARTUP_SESSION_HTTP_TIMEOUT_MS,
        timeoutMessage: `RemoteBuddy session bootstrap timed out after ${STARTUP_SESSION_HTTP_TIMEOUT_MS}ms`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(
        `[RemoteBuddy] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log("[RemoteBuddy] PushPals RemoteBuddy Orchestrator");
  console.log(`[RemoteBuddy] Server: ${opts.server}`);
  if (CONFIG.startup.logConfigOnStart) {
    console.log("[RemoteBuddy] Effective config snapshot (sanitized):");
    console.log(JSON.stringify(sanitizePushPalsConfigForLogging(CONFIG), null, 2));
  } else {
    console.log(
      "[RemoteBuddy] Config snapshot logging disabled (startup.log_config_on_start=false).",
    );
  }

  // ── Initialise LLM + brain ──
  let brain: AgentBrain;

  // ── Initialise idempotency store ──
  const dataDir = CONFIG.paths.dataDir;
  mkdirSync(dataDir, { recursive: true });
  const sharedDbPath = CONFIG.paths.sharedDbPath;
  const dbPath = CONFIG.paths.remotebuddyDbPath;
  const idempotency = new IdempotencyStore(dbPath);
  const persistentMemory: SessionMemoryBackend = createSessionMemoryBackend(
    CONFIG.remotebuddy.memory.enabled,
    [
      () => new PersistentSessionMemory(dbPath),
      // Future memory systems can be appended here without touching orchestrator code.
    ],
  );
  console.log(`[RemoteBuddy] Idempotency store: ${dbPath}`);
  console.log(
    `[RemoteBuddy] Persistent memory backend: ${
      CONFIG.remotebuddy.memory.enabled ? "composite(sqlite)" : "noop"
    }`,
  );

  let sessionId = opts.sessionId;
  console.log(`[RemoteBuddy] Ensuring session "${sessionId}" exists on server...`);
  sessionId = await connectWithRetry(opts.server, sessionId ?? undefined);
  console.log(`[RemoteBuddy] Using session: ${sessionId}`);

  const llmCfg = CONFIG.remotebuddy.llm;
  const llm = createLLMClient({
    service: "remotebuddy",
    sessionId,
    backend: llmCfg.backend,
    endpoint: llmCfg.endpoint,
    model: llmCfg.model,
    apiKey: llmCfg.apiKey,
    serverUrl: opts.server,
    authToken: opts.authToken,
  });
  brain = new AgentBrain(llm);

  const orchestrator = new RemoteBuddyOrchestrator({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
    brain,
    llm,
    idempotency,
    persistentMemory,
    jobsDbPath: sharedDbPath,
  });

  let shutdownRequested = false;
  const shutdown = (signalName: string, code: number) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`[RemoteBuddy] Received ${signalName}; shutting down...`);
    void orchestrator
      .dispose()
      .catch((err) => {
        console.error(`[RemoteBuddy] Shutdown cleanup failed: ${String(err)}`);
      })
      .finally(() => {
        setTimeout(() => process.exit(code), 0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT", 130));
  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => shutdown("SIGBREAK", 131));
  }

  await orchestrator.emitStartupStatus();
  orchestrator.startStatusHeartbeat();
  orchestrator.startSessionEventMonitor();
  orchestrator.startWorkerCapacityPrewarmOnStartup();
  orchestrator.startAutonomy();
  orchestrator.startAutonomyRuntimeConfigPolling();

  // Start polling for requests from the Request Queue
  const pollMs = CONFIG.remotebuddy.pollMs;
  orchestrator.startPolling(pollMs);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[RemoteBuddy] Fatal:", err);
    process.exit(1);
  });
}
