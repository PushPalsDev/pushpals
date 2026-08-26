import { fetchBufferedWithHardDeadline, type FetchLike } from "./bounded_fetch.js";
import {
  MemoryConflictError,
  MemoryHttpClient,
  type MemoryHttpClientOptions,
  type MemoryEvidence,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryReinforcementOutcome,
  type MemoryStore,
} from "./memory.js";

export const REPOSITORY_AGENT_SCHEMA_VERSION = 1 as const;

export const REPOSITORY_AGENT_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  responseBytes: 2 * 1024 * 1024,
  deadlineHorizonMs: 60 * 60_000,
  questionChars: 32_000,
  contextChars: 96_000,
  contextDepth: 8,
  contextEntries: 1_024,
  contextStringChars: 16_000,
  answerChars: 128_000,
  summaryChars: 16_000,
  evidenceItems: 128,
  recommendationItems: 64,
  validationProposalItems: 32,
  memoryRefItems: 128,
});

export type RepositoryAgentCallerService =
  | "server"
  | "localbuddy"
  | "remotebuddy"
  | "workerpals"
  | "source_control_manager"
  | "repository_agent"
  | "cli"
  | "client";

export type RepositoryAgentPurpose =
  | "architecture"
  | "priority"
  | "ownership"
  | "validation"
  | "debug"
  | "impact"
  | "general";

export type RepositoryAgentPriority = "interactive" | "normal" | "background";

export type RepositoryAgentFreshness = "cache_preferred" | "fresh_required" | "cache_only";

export type RepositoryAgentRequestStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type RepositoryAgentJsonPrimitive = string | number | boolean | null;
export type RepositoryAgentJsonValue =
  | RepositoryAgentJsonPrimitive
  | RepositoryAgentJsonValue[]
  | { [key: string]: RepositoryAgentJsonValue };
export type RepositoryAgentContext = Record<string, RepositoryAgentJsonValue>;

export interface RepositoryAgentCaller {
  service: RepositoryAgentCallerService;
  instanceId?: string;
  sessionId?: string;
  correlationId?: string;
}

export interface RepositoryAgentRepositoryRef {
  /** Stable identity shared by linked worktrees and, when configured, clones. */
  identity: string;
  /** Absolute worktree root that the agent is allowed to inspect. */
  root: string;
  /** Exact commit or snapshot revision the answer describes. */
  revision: string;
  /** Git tree or equivalent content-tree fingerprint. */
  tree: string;
  /** True when the requested snapshot includes uncommitted content. */
  dirty: boolean;
}

export interface RepositoryAgentRequest {
  schemaVersion: typeof REPOSITORY_AGENT_SCHEMA_VERSION;
  caller: RepositoryAgentCaller;
  purpose: RepositoryAgentPurpose;
  repository: RepositoryAgentRepositoryRef;
  question: string;
  context?: RepositoryAgentContext;
  priority: RepositoryAgentPriority;
  /** Absolute ISO-8601 deadline after which the request may be expired. */
  deadlineAt: string;
  freshness: RepositoryAgentFreshness;
  idempotencyKey: string;
}

export interface RepositoryAgentEvidence {
  /** Repository-relative path. */
  path: string;
  revision: string;
  blobHash?: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
  rationale?: string;
}

export interface RepositoryAgentRecommendation {
  title: string;
  rationale: string;
  priority?: "high" | "normal" | "low";
  paths?: string[];
}

export interface RepositoryAgentValidationProposal {
  label: string;
  /** Repository-relative working directory, or `.` for the repository root. */
  cwd: string;
  /** Direct argv only. This is a proposal and still requires trusted host validation. */
  argv: string[];
  rationale: string;
}

export interface RepositoryAgentCacheMetadata {
  hit: boolean;
  key: string | null;
  storedAt?: string;
  expiresAt?: string;
}

export type RepositoryAgentMemoryRole = "analysis_cache" | "evidence_fact" | "recalled_fact";

export interface RepositoryAgentMemoryRef {
  id: string;
  namespace: string;
  key?: string;
  /** How this memory influenced the result, used to scope outcome learning safely. */
  role: RepositoryAgentMemoryRole;
  relevance?: number;
  sourceRevision?: string;
}

export interface RepositoryAgentResult {
  schemaVersion: typeof REPOSITORY_AGENT_SCHEMA_VERSION;
  requestId: string;
  analyzedRepository: Pick<RepositoryAgentRepositoryRef, "identity" | "revision" | "tree">;
  answer: string;
  summary: string;
  /** Purpose-specific structured output (for example autonomy candidates). */
  data?: RepositoryAgentJsonValue;
  confidence: number;
  evidence: RepositoryAgentEvidence[];
  recommendations: RepositoryAgentRecommendation[];
  validationProposals: RepositoryAgentValidationProposal[];
  cache: RepositoryAgentCacheMetadata;
  memoryRefs: RepositoryAgentMemoryRef[];
  completedAt: string;
}

export interface RepositoryAgentRemoteError {
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
}

export interface RepositoryAgentRequestSnapshot {
  requestId: string;
  status: RepositoryAgentRequestStatus;
  submittedAt: string;
  updatedAt: string;
  pollAfterMs?: number;
  result?: RepositoryAgentResult;
  error?: RepositoryAgentRemoteError;
}

export interface RepositoryAgentSubmitResult {
  requestId: string;
  status: RepositoryAgentRequestStatus;
  deduplicated: boolean;
  pollAfterMs: number;
  result?: RepositoryAgentResult;
}

export interface RepositoryAgentSubmitInput extends Omit<
  RepositoryAgentRequest,
  "schemaVersion" | "caller"
> {
  caller?: Omit<RepositoryAgentCaller, "service">;
}

export interface RepositoryAgentCallOptions {
  signal?: AbortSignal;
  /** Complete HTTP exchange deadline for this call. */
  timeoutMs?: number;
}

export interface RepositoryAgentAskOptions extends RepositoryAgentCallOptions {
  /** Overall submit-and-poll deadline. A caller timeout does not cancel durable work. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RepositoryAgentClaimInput {
  agentId: string;
  leaseMs?: number;
  repositoryIdentities?: string[];
  capabilities?: RepositoryAgentContext;
}

export interface RepositoryAgentClaim {
  requestId: string;
  claimToken: string;
  claimGeneration: number;
  leaseExpiresAt: string;
  request: RepositoryAgentRequest;
}

export interface RepositoryAgentClaimResult {
  claim: RepositoryAgentClaim | null;
  pollAfterMs: number;
}

export interface RepositoryAgentLeaseInput {
  agentId: string;
  claimToken: string;
  claimGeneration: number;
  leaseMs?: number;
}

export interface RepositoryAgentLeaseResult {
  requestId: string;
  status: RepositoryAgentRequestStatus;
  leaseExpiresAt?: string;
}

export interface RepositoryAgentCompleteInput extends RepositoryAgentLeaseInput {
  result: RepositoryAgentResult;
}

export interface RepositoryAgentFailInput extends RepositoryAgentLeaseInput {
  error: RepositoryAgentRemoteError;
}

export type RepositoryAgentClientErrorCode =
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "transport_error"
  | "http_error"
  | "invalid_response"
  | "remote_failed"
  | "remote_cancelled"
  | "remote_expired";

export class RepositoryAgentClientError extends Error {
  readonly code: RepositoryAgentClientErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly remoteCode: string | null;
  readonly detail: string | null;
  readonly retryable: boolean | null;

  constructor(
    code: RepositoryAgentClientErrorCode,
    message: string,
    options: {
      status?: number | null;
      requestId?: string | null;
      retryAfterMs?: number | null;
      remoteCode?: string | null;
      detail?: string | null;
      retryable?: boolean | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepositoryAgentClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.remoteCode = options.remoteCode ?? null;
    this.detail = options.detail ?? null;
    this.retryable = options.retryable ?? null;
  }
}

export interface RepositoryAgentClientOptions {
  serverUrl: string;
  callerService: RepositoryAgentCallerService;
  callerInstanceId?: string;
  authToken?: string | null;
  fetchImpl?: FetchLike;
  /** Default deadline for one complete HTTP exchange. */
  requestTimeoutMs?: number;
  /** Default overall deadline for `ask`. */
  askTimeoutMs?: number;
  pollIntervalMs?: number;
  maxResponseBytes?: number;
}

export interface RepositoryAgentWorkerClientOptions extends Omit<
  RepositoryAgentClientOptions,
  "callerService" | "callerInstanceId" | "askTimeoutMs"
> {
  /** Worker control is always the internal RepositoryAgent authority. */
  callerService?: never;
  callerInstanceId?: never;
  askTimeoutMs?: never;
}

/** Service-facing capability. Callers depend on this interface, not the HTTP transport. */
export interface RepositoryAgent {
  submit(
    input: RepositoryAgentSubmitInput,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentSubmitResult>;
  get(
    requestId: string,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentRequestSnapshot>;
  ask(
    input: RepositoryAgentSubmitInput,
    options?: RepositoryAgentAskOptions,
  ): Promise<RepositoryAgentResult>;
}

/**
 * Process-local access to the two independent repository knowledge capabilities.
 * Construction is intentionally inert: neither client performs I/O until one of
 * its methods is called.
 */
export interface RepositoryAgentServiceClients {
  readonly repositoryAgent: RepositoryAgent;
  readonly memoryStore: MemoryStore;
  /** Close only clients owned by this bundle. Injected stores retain their owner's lifecycle. */
  close(): Promise<void>;
}

export interface RepositoryAgentServiceClientOptions extends RepositoryAgentClientOptions {
  memoryTimeoutMs?: MemoryHttpClientOptions["timeoutMs"];
  memoryMaxResponseBytes?: MemoryHttpClientOptions["maxResponseBytes"];
  /** Narrow capability for a process that hosts RepositoryAgent or Server-owned memory work. */
  memoryAuthority?: MemoryHttpClientOptions["authority"];
  /** Test/server override. The caller remains responsible for this capability's lifecycle. */
  repositoryAgent?: RepositoryAgent;
  /** Test/server override. The caller remains responsible for this store's lifecycle. */
  memoryStore?: MemoryStore;
}

export interface ReinforceRepositoryAgentMemoryInput {
  memory: MemoryStore;
  repositoryId: string;
  result: RepositoryAgentResult;
  outcome: MemoryReinforcementOutcome;
  /** Stable authoritative outcome/event ID for idempotent feedback retries. */
  observationId?: string;
  weight?: number;
  evidence?: MemoryEvidence[];
  provenance?: MemoryProvenance;
}

export interface ReinforceRepositoryAgentMemoryRefsInput extends Omit<
  ReinforceRepositoryAgentMemoryInput,
  "result"
> {
  memoryRefs: RepositoryAgentMemoryRef[];
  /** Override the conservative role policy for direct evidence confirmation. */
  roles?: RepositoryAgentMemoryRole[];
}

export interface ReinforceRepositoryAgentMemoryResult {
  attempted: number;
  updated: MemoryRecord[];
  missing: Array<{ namespace: string; key: string }>;
  failed: Array<{
    namespace: string;
    key: string;
    message: string;
    code?: "record_conflict";
  }>;
}

/**
 * Apply an authoritative downstream outcome to every addressable memory record
 * used or learned by a RepositoryAgent result. The memory transport remains a
 * separate capability; this helper only translates typed result references
 * into repository-scoped reinforcement calls.
 */
export async function reinforceRepositoryAgentMemoryRefs(
  input: ReinforceRepositoryAgentMemoryRefsInput,
): Promise<ReinforceRepositoryAgentMemoryResult> {
  const repositoryId = String(input.repositoryId ?? "").trim();
  if (!repositoryId) throw new TypeError("repositoryId is required for memory reinforcement");

  // Delivery outcomes measure whether the analysis was useful; they do not
  // prove or disprove host-verified repository facts. Fact confidence changes
  // require an explicit direct-evidence confirmation/contradiction call.
  const defaultRoles: RepositoryAgentMemoryRole[] =
    input.outcome === "successful" || input.outcome === "failed"
      ? ["analysis_cache"]
      : ["analysis_cache", "evidence_fact", "recalled_fact"];
  const permittedRoles = new Set(input.roles?.length ? input.roles : defaultRoles);

  const addresses = new Map<string, { id: string; namespace: string; key: string }>();
  for (const ref of input.memoryRefs.slice(0, REPOSITORY_AGENT_LIMITS.memoryRefItems)) {
    if (!permittedRoles.has(ref.role)) continue;
    const id = String(ref.id ?? "").trim();
    const namespace = String(ref.namespace ?? "").trim();
    const key = String(ref.key ?? "").trim();
    if (!id || !namespace || !key) continue;
    addresses.set(`${namespace}\0${key}\0${id}`, { id, namespace, key });
  }

  const updated: MemoryRecord[] = [];
  const missing: ReinforceRepositoryAgentMemoryResult["missing"] = [];
  const failed: ReinforceRepositoryAgentMemoryResult["failed"] = [];
  for (const address of addresses.values()) {
    try {
      const record = await input.memory.reinforce({
        scope: { namespace: address.namespace, repositoryId },
        key: address.key,
        outcome: input.outcome,
        expectedId: address.id,
        ...(input.observationId ? { observationId: input.observationId } : {}),
        ...(input.weight == null ? {} : { weight: input.weight }),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      if (record) updated.push(record);
      else missing.push(address);
    } catch (error) {
      failed.push({
        ...address,
        message: String(error instanceof Error ? error.message : error).slice(0, 2_000),
        ...(error instanceof MemoryConflictError && error.code === "record_conflict"
          ? { code: "record_conflict" as const }
          : {}),
      });
    }
  }
  return { attempted: addresses.size, updated, missing, failed };
}

export async function reinforceRepositoryAgentMemory(
  input: ReinforceRepositoryAgentMemoryInput,
): Promise<ReinforceRepositoryAgentMemoryResult> {
  if (input.result.analyzedRepository.identity !== input.repositoryId.trim()) {
    throw new TypeError("RepositoryAgent result identity does not match reinforcement scope");
  }
  return reinforceRepositoryAgentMemoryRefs({
    memory: input.memory,
    repositoryId: input.repositoryId,
    memoryRefs: input.result.memoryRefs,
    outcome: input.outcome,
    ...(input.observationId ? { observationId: input.observationId } : {}),
    ...(input.weight == null ? {} : { weight: input.weight }),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
}

/** Lease-authority capability used by Repository Agent worker processes. */
export interface RepositoryAgentWorkerControl {
  claim(
    input: RepositoryAgentClaimInput,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentClaimResult>;
  renewLease(
    requestId: string,
    input: RepositoryAgentLeaseInput,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentLeaseResult>;
  complete(
    requestId: string,
    input: RepositoryAgentCompleteInput,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentLeaseResult>;
  fail(
    requestId: string,
    input: RepositoryAgentFailInput,
    options?: RepositoryAgentCallOptions,
  ): Promise<RepositoryAgentLeaseResult>;
}

const CALLER_SERVICES = new Set<RepositoryAgentCallerService>([
  "server",
  "localbuddy",
  "remotebuddy",
  "workerpals",
  "source_control_manager",
  "repository_agent",
  "cli",
  "client",
]);
const PURPOSES = new Set<RepositoryAgentPurpose>([
  "architecture",
  "priority",
  "ownership",
  "validation",
  "debug",
  "impact",
  "general",
]);
const PRIORITIES = new Set<RepositoryAgentPriority>(["interactive", "normal", "background"]);
const FRESHNESS_VALUES = new Set<RepositoryAgentFreshness>([
  "cache_preferred",
  "fresh_required",
  "cache_only",
]);
const MEMORY_ROLES = new Set<RepositoryAgentMemoryRole>([
  "analysis_cache",
  "evidence_fact",
  "recalled_fact",
]);
const REQUEST_STATUSES = new Set<RepositoryAgentRequestStatus>([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const TERMINAL_STATUSES = new Set<RepositoryAgentRequestStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

function invalidRequest(message: string): never {
  throw new RepositoryAgentClientError("invalid_request", message);
}

function invalidResponse(message: string): never {
  throw new RepositoryAgentClientError("invalid_response", message);
}

function contractViolation(source: "request" | "response", message: string): never {
  return source === "request" ? invalidRequest(message) : invalidResponse(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maxChars: number,
  source: "request" | "response",
): string {
  if (typeof value !== "string") {
    return source === "request"
      ? invalidRequest(`${label} must be a string`)
      : invalidResponse(`${label} must be a string`);
  }
  const normalized = value.replace(/\u0000/g, "").trim();
  if (!normalized) {
    return source === "request"
      ? invalidRequest(`${label} is required`)
      : invalidResponse(`${label} is required`);
  }
  if (normalized.length > maxChars) {
    return source === "request"
      ? invalidRequest(`${label} exceeds ${maxChars} characters`)
      : `${normalized.slice(0, Math.max(1, maxChars - 14))}...[truncated]`;
  }
  return normalized;
}

function optionalString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\u0000/g, "").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxChars - 14))}...[truncated]`;
}

function finiteInt(
  value: unknown,
  options: { min: number; max: number; fallback?: number },
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    if (options.fallback !== undefined) return options.fallback;
    invalidResponse("Expected a finite integer");
  }
  return Math.max(options.min, Math.min(options.max, Math.floor(parsed)));
}

function normalizedIso(value: unknown, label: string, source: "request" | "response"): string {
  const raw = requiredString(value, label, 128, source);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return source === "request"
      ? invalidRequest(`${label} must be a valid ISO-8601 timestamp`)
      : invalidResponse(`${label} must be a valid ISO-8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function sanitizeRelativePath(value: unknown, label: string): string | null {
  const path = optionalString(value, 1_024)?.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:\//i.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  return segments.join("/") || (label === "cwd" && path === "." ? "." : null);
}

type JsonBudget = { entries: number; chars: number };

function sanitizeJsonValue(
  value: unknown,
  label: string,
  depth: number,
  budget: JsonBudget,
  source: "request" | "response",
): RepositoryAgentJsonValue {
  if (depth > REPOSITORY_AGENT_LIMITS.contextDepth) {
    contractViolation(source, `${label} exceeds maximum nesting depth`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      contractViolation(source, `${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > REPOSITORY_AGENT_LIMITS.contextStringChars) {
      contractViolation(
        source,
        `${label} contains a string longer than ${REPOSITORY_AGENT_LIMITS.contextStringChars} characters`,
      );
    }
    budget.chars += value.length;
    if (budget.chars > REPOSITORY_AGENT_LIMITS.contextChars) {
      contractViolation(
        source,
        `${label} exceeds ${REPOSITORY_AGENT_LIMITS.contextChars} characters`,
      );
    }
    return value.replace(/\u0000/g, "");
  }
  if (Array.isArray(value)) {
    budget.entries += value.length;
    if (budget.entries > REPOSITORY_AGENT_LIMITS.contextEntries) {
      contractViolation(source, `${label} contains too many entries`);
    }
    return value.map((entry, index) =>
      sanitizeJsonValue(entry, `${label}[${index}]`, depth + 1, budget, source),
    );
  }
  if (!isRecord(value)) {
    contractViolation(source, `${label} must contain JSON-compatible values`);
  }
  const entries = Object.entries(value);
  budget.entries += entries.length;
  if (budget.entries > REPOSITORY_AGENT_LIMITS.contextEntries) {
    contractViolation(source, `${label} contains too many entries`);
  }
  const output: Record<string, RepositoryAgentJsonValue> = {};
  for (const [rawKey, entry] of entries) {
    const key = rawKey.replace(/\u0000/g, "").trim();
    if (!key || key.length > 256) {
      contractViolation(source, `${label} contains an invalid key`);
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      contractViolation(source, `${label} contains an unsafe key`);
    }
    budget.chars += key.length;
    output[key] = sanitizeJsonValue(entry, `${label}.${key}`, depth + 1, budget, source);
  }
  return output;
}

function sanitizeContext(
  value: unknown,
  label = "context",
  source: "request" | "response" = "request",
): RepositoryAgentContext | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) contractViolation(source, `${label} must be an object`);
  return sanitizeJsonValue(
    value,
    label,
    0,
    { entries: 0, chars: 0 },
    source,
  ) as RepositoryAgentContext;
}

function sanitizeCaller(value: unknown, source: "request" | "response"): RepositoryAgentCaller {
  if (!isRecord(value)) {
    return source === "request"
      ? invalidRequest("caller must be an object")
      : invalidResponse("caller must be an object");
  }
  const service = requiredString(value.service, "caller.service", 64, source);
  if (!CALLER_SERVICES.has(service as RepositoryAgentCallerService)) {
    return source === "request"
      ? invalidRequest(`Unsupported caller.service: ${service}`)
      : invalidResponse(`Unsupported caller.service: ${service}`);
  }
  return {
    service: service as RepositoryAgentCallerService,
    ...(optionalString(value.instanceId, 256)
      ? { instanceId: optionalString(value.instanceId, 256) }
      : {}),
    ...(optionalString(value.sessionId, 256)
      ? { sessionId: optionalString(value.sessionId, 256) }
      : {}),
    ...(optionalString(value.correlationId, 256)
      ? { correlationId: optionalString(value.correlationId, 256) }
      : {}),
  };
}

function sanitizeRepository(
  value: unknown,
  source: "request" | "response",
): RepositoryAgentRepositoryRef {
  if (!isRecord(value)) {
    return source === "request"
      ? invalidRequest("repository must be an object")
      : invalidResponse("repository must be an object");
  }
  if (typeof value.dirty !== "boolean") {
    return source === "request"
      ? invalidRequest("repository.dirty must be a boolean")
      : invalidResponse("repository.dirty must be a boolean");
  }
  return {
    identity: requiredString(value.identity, "repository.identity", 1_024, source),
    root: requiredString(value.root, "repository.root", 4_096, source),
    revision: requiredString(value.revision, "repository.revision", 512, source),
    tree: requiredString(value.tree, "repository.tree", 512, source),
    dirty: value.dirty,
  };
}

function sanitizeRequest(value: unknown, source: "request" | "response"): RepositoryAgentRequest {
  if (!isRecord(value)) {
    return source === "request"
      ? invalidRequest("Repository Agent request must be an object")
      : invalidResponse("Repository Agent request must be an object");
  }
  if (value.schemaVersion !== REPOSITORY_AGENT_SCHEMA_VERSION) {
    return source === "request"
      ? invalidRequest(`schemaVersion must be ${REPOSITORY_AGENT_SCHEMA_VERSION}`)
      : invalidResponse(
          `Unsupported Repository Agent schemaVersion: ${String(value.schemaVersion)}`,
        );
  }
  const purpose = requiredString(value.purpose, "purpose", 32, source);
  const priority = requiredString(value.priority, "priority", 32, source);
  const freshness = requiredString(value.freshness, "freshness", 32, source);
  if (!PURPOSES.has(purpose as RepositoryAgentPurpose)) {
    return source === "request"
      ? invalidRequest(`Unsupported purpose: ${purpose}`)
      : invalidResponse(`Unsupported purpose: ${purpose}`);
  }
  if (!PRIORITIES.has(priority as RepositoryAgentPriority)) {
    return source === "request"
      ? invalidRequest(`Unsupported priority: ${priority}`)
      : invalidResponse(`Unsupported priority: ${priority}`);
  }
  if (!FRESHNESS_VALUES.has(freshness as RepositoryAgentFreshness)) {
    return source === "request"
      ? invalidRequest(`Unsupported freshness: ${freshness}`)
      : invalidResponse(`Unsupported freshness: ${freshness}`);
  }
  const deadlineAt = normalizedIso(value.deadlineAt, "deadlineAt", source);
  if (source === "request" && Date.parse(deadlineAt) <= Date.now()) {
    invalidRequest("deadlineAt must be in the future");
  }
  if (
    source === "request" &&
    Date.parse(deadlineAt) - Date.now() > REPOSITORY_AGENT_LIMITS.deadlineHorizonMs
  ) {
    invalidRequest(
      `deadlineAt must be no more than ${REPOSITORY_AGENT_LIMITS.deadlineHorizonMs}ms in the future`,
    );
  }
  const context = sanitizeContext(value.context, "context", source);
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    caller: sanitizeCaller(value.caller, source),
    purpose: purpose as RepositoryAgentPurpose,
    repository: sanitizeRepository(value.repository, source),
    question: requiredString(
      value.question,
      "question",
      REPOSITORY_AGENT_LIMITS.questionChars,
      source,
    ),
    ...(context ? { context } : {}),
    priority: priority as RepositoryAgentPriority,
    deadlineAt,
    freshness: freshness as RepositoryAgentFreshness,
    idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey", 256, source),
  };
}

/** Validate and normalize an inbound request at the server trust boundary. */
export function sanitizeRepositoryAgentRequest(value: unknown): RepositoryAgentRequest {
  return sanitizeRequest(value, "request");
}

function sanitizeStatus(value: unknown): RepositoryAgentRequestStatus {
  const status = requiredString(value, "status", 32, "response");
  if (!REQUEST_STATUSES.has(status as RepositoryAgentRequestStatus)) {
    invalidResponse(`Unsupported Repository Agent request status: ${status}`);
  }
  return status as RepositoryAgentRequestStatus;
}

function sanitizeEvidence(value: unknown): RepositoryAgentEvidence | null {
  if (!isRecord(value)) return null;
  const path = sanitizeRelativePath(value.path, "path");
  const revision = optionalString(value.revision, 512);
  if (!path || !revision) return null;
  const startLine =
    value.startLine == null
      ? undefined
      : finiteInt(value.startLine, { min: 1, max: 10_000_000, fallback: 1 });
  const endLine =
    value.endLine == null
      ? undefined
      : finiteInt(value.endLine, {
          min: startLine ?? 1,
          max: 10_000_000,
          fallback: startLine ?? 1,
        });
  return {
    path,
    revision,
    ...(optionalString(value.blobHash, 512)
      ? { blobHash: optionalString(value.blobHash, 512) }
      : {}),
    ...(startLine == null ? {} : { startLine }),
    ...(endLine == null ? {} : { endLine }),
    ...(optionalString(value.excerpt, 4_000)
      ? { excerpt: optionalString(value.excerpt, 4_000) }
      : {}),
    ...(optionalString(value.rationale, 2_000)
      ? { rationale: optionalString(value.rationale, 2_000) }
      : {}),
  };
}

function sanitizeRecommendation(value: unknown): RepositoryAgentRecommendation | null {
  if (!isRecord(value)) return null;
  const title = optionalString(value.title, 1_000);
  const rationale = optionalString(value.rationale, 4_000);
  if (!title || !rationale) return null;
  const priority = optionalString(value.priority, 16);
  const paths = Array.isArray(value.paths)
    ? value.paths
        .map((path) => sanitizeRelativePath(path, "path"))
        .filter((path): path is string => Boolean(path))
        .slice(0, 64)
    : undefined;
  return {
    title,
    rationale,
    ...(priority === "high" || priority === "normal" || priority === "low" ? { priority } : {}),
    ...(paths?.length ? { paths } : {}),
  };
}

function sanitizeValidationProposal(value: unknown): RepositoryAgentValidationProposal | null {
  if (!isRecord(value)) return null;
  const label = optionalString(value.label, 1_000);
  const rationale = optionalString(value.rationale, 4_000);
  const rawCwd = optionalString(value.cwd, 1_024) ?? ".";
  const cwd = rawCwd === "." ? "." : sanitizeRelativePath(rawCwd, "cwd");
  const argv = Array.isArray(value.argv)
    ? value.argv
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.replace(/\u0000/g, "").trim())
        .filter(Boolean)
        .slice(0, 64)
        .map((entry) => (entry.length <= 4_096 ? entry : `${entry.slice(0, 4_082)}...[truncated]`))
    : [];
  if (!label || !rationale || !cwd || argv.length === 0) return null;
  return { label, cwd, argv, rationale };
}

function sanitizeMemoryRef(value: unknown): RepositoryAgentMemoryRef | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id, 512);
  const namespace = optionalString(value.namespace, 256);
  const role = optionalString(value.role, 64);
  if (!id || !namespace || !MEMORY_ROLES.has(role as RepositoryAgentMemoryRole)) return null;
  const relevance =
    typeof value.relevance === "number" && Number.isFinite(value.relevance)
      ? Math.max(0, Math.min(1, value.relevance))
      : undefined;
  return {
    id,
    namespace,
    role: role as RepositoryAgentMemoryRole,
    ...(optionalString(value.key, 512) ? { key: optionalString(value.key, 512) } : {}),
    ...(relevance == null ? {} : { relevance }),
    ...(optionalString(value.sourceRevision, 512)
      ? { sourceRevision: optionalString(value.sourceRevision, 512) }
      : {}),
  };
}

export function sanitizeRepositoryAgentResult(
  value: unknown,
  expectedRequestId?: string,
): RepositoryAgentResult {
  if (!isRecord(value)) invalidResponse("Repository Agent result must be an object");
  if (value.schemaVersion !== REPOSITORY_AGENT_SCHEMA_VERSION) {
    invalidResponse(
      `Unsupported Repository Agent result schemaVersion: ${String(value.schemaVersion)}`,
    );
  }
  const requestId = requiredString(value.requestId, "result.requestId", 256, "response");
  if (expectedRequestId && requestId !== expectedRequestId) {
    invalidResponse(`Repository Agent result requestId does not match ${expectedRequestId}`);
  }
  if (!isRecord(value.analyzedRepository)) {
    invalidResponse("result.analyzedRepository must be an object");
  }
  const analyzedRepository = {
    identity: requiredString(
      value.analyzedRepository.identity,
      "result.analyzedRepository.identity",
      1_024,
      "response",
    ),
    revision: requiredString(
      value.analyzedRepository.revision,
      "result.analyzedRepository.revision",
      512,
      "response",
    ),
    tree: requiredString(
      value.analyzedRepository.tree,
      "result.analyzedRepository.tree",
      512,
      "response",
    ),
  };
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence)) invalidResponse("result.confidence must be finite");

  const cacheRecord = isRecord(value.cache) ? value.cache : {};
  const completedAt = normalizedIso(value.completedAt, "result.completedAt", "response");
  const data =
    value.data === undefined
      ? undefined
      : sanitizeJsonValue(value.data, "result.data", 0, { entries: 0, chars: 0 }, "response");
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    requestId,
    analyzedRepository,
    answer: requiredString(
      value.answer,
      "result.answer",
      REPOSITORY_AGENT_LIMITS.answerChars,
      "response",
    ),
    summary: requiredString(
      value.summary,
      "result.summary",
      REPOSITORY_AGENT_LIMITS.summaryChars,
      "response",
    ),
    ...(data === undefined ? {} : { data }),
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence: (Array.isArray(value.evidence) ? value.evidence : [])
      .slice(0, REPOSITORY_AGENT_LIMITS.evidenceItems)
      .map(sanitizeEvidence)
      .filter((entry): entry is RepositoryAgentEvidence => Boolean(entry)),
    recommendations: (Array.isArray(value.recommendations) ? value.recommendations : [])
      .slice(0, REPOSITORY_AGENT_LIMITS.recommendationItems)
      .map(sanitizeRecommendation)
      .filter((entry): entry is RepositoryAgentRecommendation => Boolean(entry)),
    validationProposals: (Array.isArray(value.validationProposals) ? value.validationProposals : [])
      .slice(0, REPOSITORY_AGENT_LIMITS.validationProposalItems)
      .map(sanitizeValidationProposal)
      .filter((entry): entry is RepositoryAgentValidationProposal => Boolean(entry)),
    cache: {
      hit: cacheRecord.hit === true,
      key: optionalString(cacheRecord.key, 1_024) ?? null,
      ...(optionalString(cacheRecord.storedAt, 128)
        ? { storedAt: optionalString(cacheRecord.storedAt, 128) }
        : {}),
      ...(optionalString(cacheRecord.expiresAt, 128)
        ? { expiresAt: optionalString(cacheRecord.expiresAt, 128) }
        : {}),
    },
    memoryRefs: (Array.isArray(value.memoryRefs) ? value.memoryRefs : [])
      .slice(0, REPOSITORY_AGENT_LIMITS.memoryRefItems)
      .map(sanitizeMemoryRef)
      .filter((entry): entry is RepositoryAgentMemoryRef => Boolean(entry)),
    completedAt,
  };
}

function sanitizeRemoteError(value: unknown): RepositoryAgentRemoteError | undefined {
  if (!isRecord(value)) return undefined;
  const code = optionalString(value.code, 128);
  const message = optionalString(value.message, 8_000);
  if (!code || !message) return undefined;
  return {
    code,
    message,
    ...(optionalString(value.detail, 16_000)
      ? { detail: optionalString(value.detail, 16_000) }
      : {}),
    retryable: value.retryable === true,
  };
}

function sanitizeSnapshot(
  value: unknown,
  expectedRequestId: string,
): RepositoryAgentRequestSnapshot {
  if (!isRecord(value)) invalidResponse("Repository Agent request snapshot must be an object");
  const requestId = requiredString(value.requestId, "requestId", 256, "response");
  if (requestId !== expectedRequestId)
    invalidResponse("Repository Agent snapshot requestId mismatch");
  const status = sanitizeStatus(value.status);
  const result =
    value.result == null ? undefined : sanitizeRepositoryAgentResult(value.result, requestId);
  const error = sanitizeRemoteError(value.error);
  return {
    requestId,
    status,
    submittedAt: normalizedIso(value.submittedAt, "submittedAt", "response"),
    updatedAt: normalizedIso(value.updatedAt, "updatedAt", "response"),
    ...(value.pollAfterMs == null
      ? {}
      : { pollAfterMs: finiteInt(value.pollAfterMs, { min: 100, max: 30_000, fallback: 1_000 }) }),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizePositiveDuration(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new RepositoryAgentClientError("aborted", "Repository Agent call aborted"),
    );
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new RepositoryAgentClientError("aborted", "Repository Agent call aborted"));
    };
    timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

abstract class RepositoryAgentHttpClient {
  private readonly serverUrl: string;
  private readonly authToken: string | null;
  private readonly fetchImpl: FetchLike;
  protected readonly requestTimeoutMs: number;
  protected readonly pollIntervalMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    options: Pick<
      RepositoryAgentClientOptions,
      | "serverUrl"
      | "authToken"
      | "fetchImpl"
      | "requestTimeoutMs"
      | "pollIntervalMs"
      | "maxResponseBytes"
    >,
  ) {
    const rawServerUrl = requiredString(options.serverUrl, "serverUrl", 4_096, "request").replace(
      /\/+$/,
      "",
    );
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawServerUrl);
    } catch {
      invalidRequest("serverUrl must be an absolute HTTP URL");
    }
    if (parsedUrl!.protocol !== "http:" && parsedUrl!.protocol !== "https:") {
      invalidRequest("serverUrl must use HTTP or HTTPS");
    }
    this.serverUrl = rawServerUrl;
    this.authToken = optionalString(options.authToken, 8_192) ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = normalizePositiveDuration(options.requestTimeoutMs, 10_000, 120_000);
    this.pollIntervalMs = normalizePositiveDuration(options.pollIntervalMs, 1_000, 30_000);
    this.maxResponseBytes = normalizePositiveDuration(
      options.maxResponseBytes,
      REPOSITORY_AGENT_LIMITS.responseBytes,
      16 * 1024 * 1024,
    );
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
    };
  }

  protected async requestJson(
    path: string,
    init: RequestInit,
    options: RepositoryAgentCallOptions = {},
  ): Promise<Record<string, unknown>> {
    const timeoutMs = normalizePositiveDuration(
      options.timeoutMs,
      this.requestTimeoutMs,
      30 * 60_000,
    );
    try {
      const response = await fetchBufferedWithHardDeadline({
        input: `${this.serverUrl}${path}`,
        init: {
          ...init,
          headers: { ...this.headers(), ...(init.headers ?? {}) },
          signal: options.signal,
        },
        timeoutMs,
        fetchImpl: this.fetchImpl,
        maxResponseBytes: this.maxResponseBytes,
        timeoutMessage: `Repository Agent request timed out after ${timeoutMs}ms`,
      });
      const text = await response.text();
      let payload: unknown = {};
      if (text.trim()) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch (cause) {
          throw new RepositoryAgentClientError(
            "invalid_response",
            "Repository Agent returned malformed JSON",
            { status: response.status, cause },
          );
        }
      }
      if (!isRecord(payload)) {
        throw new RepositoryAgentClientError(
          "invalid_response",
          "Repository Agent response must be a JSON object",
          { status: response.status },
        );
      }
      if (!response.ok) {
        const retryAfterHeaderMs = Number(response.headers.get("retry-after")) * 1_000;
        const retryAfterMs = Number(payload.retryAfterMs);
        throw new RepositoryAgentClientError(
          "http_error",
          optionalString(payload.message, 8_000) ??
            `Repository Agent request failed with HTTP ${response.status}`,
          {
            status: response.status,
            requestId: optionalString(payload.requestId, 256) ?? null,
            remoteCode: optionalString(payload.code, 128) ?? null,
            detail: optionalString(payload.detail, 16_000) ?? null,
            retryable:
              typeof payload.retryable === "boolean" ? payload.retryable : response.status >= 500,
            retryAfterMs: Number.isFinite(retryAfterMs)
              ? Math.max(0, Math.floor(retryAfterMs))
              : Number.isFinite(retryAfterHeaderMs)
                ? Math.max(0, Math.floor(retryAfterHeaderMs))
                : null,
          },
        );
      }
      if (payload.ok !== true) {
        throw new RepositoryAgentClientError(
          "invalid_response",
          "Repository Agent response is missing an exact positive acknowledgement",
          { status: response.status },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof RepositoryAgentClientError) throw error;
      if (options.signal?.aborted) {
        throw new RepositoryAgentClientError("aborted", "Repository Agent call aborted", {
          cause: error,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|timeout/i.test(message)) {
        throw new RepositoryAgentClientError("timeout", message, { cause: error });
      }
      throw new RepositoryAgentClientError("transport_error", message, { cause: error });
    }
  }
}

export class RepositoryAgentClient extends RepositoryAgentHttpClient implements RepositoryAgent {
  private readonly callerService: RepositoryAgentCallerService;
  private readonly callerInstanceId: string | undefined;
  private readonly askTimeoutMs: number;

  constructor(options: RepositoryAgentClientOptions) {
    super(options);
    if (!CALLER_SERVICES.has(options.callerService)) {
      invalidRequest(`Unsupported callerService: ${String(options.callerService)}`);
    }
    this.callerService = options.callerService;
    this.callerInstanceId = optionalString(options.callerInstanceId, 256);
    this.askTimeoutMs = normalizePositiveDuration(options.askTimeoutMs, 120_000, 30 * 60_000);
  }

  private buildRequest(input: RepositoryAgentSubmitInput): RepositoryAgentRequest {
    const request = sanitizeRequest(
      {
        ...input,
        schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
        caller: {
          ...(input.caller ?? {}),
          ...(this.callerInstanceId ? { instanceId: this.callerInstanceId } : {}),
          service: this.callerService,
        },
      },
      "request",
    );
    const encoded = JSON.stringify(request);
    if (new TextEncoder().encode(encoded).byteLength > REPOSITORY_AGENT_LIMITS.requestBytes) {
      invalidRequest(
        `Repository Agent request exceeds ${REPOSITORY_AGENT_LIMITS.requestBytes} bytes`,
      );
    }
    return request;
  }

  async submit(
    input: RepositoryAgentSubmitInput,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentSubmitResult> {
    const request = this.buildRequest(input);
    const payload = await this.requestJson(
      "/repository-agent/requests",
      { method: "POST", body: JSON.stringify(request) },
      options,
    );
    const requestId = requiredString(payload.requestId, "requestId", 256, "response");
    const status = sanitizeStatus(payload.status);
    const result =
      payload.result == null ? undefined : sanitizeRepositoryAgentResult(payload.result, requestId);
    return {
      requestId,
      status,
      deduplicated: payload.deduplicated === true,
      pollAfterMs: finiteInt(payload.pollAfterMs, {
        min: 100,
        max: 30_000,
        fallback: this.pollIntervalMs,
      }),
      ...(result ? { result } : {}),
    };
  }

  async get(
    requestIdRaw: string,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentRequestSnapshot> {
    const requestId = requiredString(requestIdRaw, "requestId", 256, "request");
    const payload = await this.requestJson(
      `/repository-agent/requests/${encodeURIComponent(requestId)}`,
      { method: "GET" },
      options,
    );
    return sanitizeSnapshot(payload.request, requestId);
  }

  async ask(
    input: RepositoryAgentSubmitInput,
    options: RepositoryAgentAskOptions = {},
  ): Promise<RepositoryAgentResult> {
    const overallTimeoutMs = normalizePositiveDuration(
      options.timeoutMs,
      this.askTimeoutMs,
      30 * 60_000,
    );
    const durableDeadlineMs = Date.parse(input.deadlineAt);
    const deadlineMs = Math.min(Date.now() + overallTimeoutMs, durableDeadlineMs);
    const remaining = () => Math.max(0, deadlineMs - Date.now());
    const callOptions = (): RepositoryAgentCallOptions => ({
      signal: options.signal,
      timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, remaining())),
    });

    if (remaining() <= 0) invalidRequest("deadlineAt must be in the future");
    const submitted = await this.submit(input, callOptions());
    if (submitted.status === "completed" && submitted.result) return submitted.result;
    let pollAfterMs = normalizePositiveDuration(
      options.pollIntervalMs ?? submitted.pollAfterMs,
      this.pollIntervalMs,
      30_000,
    );

    while (remaining() > 0) {
      await sleepWithSignal(Math.min(pollAfterMs, remaining()), options.signal);
      if (remaining() <= 0) break;
      const snapshot = await this.get(submitted.requestId, callOptions());
      if (snapshot.status === "completed") {
        if (!snapshot.result) {
          invalidResponse("Completed Repository Agent request has no result");
        }
        return snapshot.result;
      }
      if (snapshot.status === "failed") {
        throw new RepositoryAgentClientError(
          "remote_failed",
          snapshot.error?.message ?? "Repository Agent request failed",
          {
            requestId: snapshot.requestId,
            remoteCode: snapshot.error?.code ?? null,
            detail: snapshot.error?.detail ?? null,
            retryable: snapshot.error?.retryable ?? null,
          },
        );
      }
      if (snapshot.status === "cancelled") {
        throw new RepositoryAgentClientError(
          "remote_cancelled",
          snapshot.error?.message ?? "Repository Agent request was cancelled",
          {
            requestId: snapshot.requestId,
            remoteCode: snapshot.error?.code ?? null,
            detail: snapshot.error?.detail ?? null,
            retryable: snapshot.error?.retryable ?? null,
          },
        );
      }
      if (snapshot.status === "expired") {
        throw new RepositoryAgentClientError(
          "remote_expired",
          snapshot.error?.message ?? "Repository Agent request expired",
          {
            requestId: snapshot.requestId,
            remoteCode: snapshot.error?.code ?? null,
            detail: snapshot.error?.detail ?? null,
            retryable: snapshot.error?.retryable ?? null,
          },
        );
      }
      pollAfterMs = normalizePositiveDuration(
        options.pollIntervalMs ?? snapshot.pollAfterMs,
        pollAfterMs,
        30_000,
      );
    }

    throw new RepositoryAgentClientError(
      "timeout",
      `Repository Agent request ${submitted.requestId} did not complete before the caller deadline`,
      { requestId: submitted.requestId },
    );
  }
}

/** Lease-authority transport reserved for RepositoryAgent worker hosts. */
export class RepositoryAgentWorkerClient
  extends RepositoryAgentHttpClient
  implements RepositoryAgentWorkerControl
{
  constructor(options: RepositoryAgentWorkerClientOptions) {
    super(options);
  }

  async claim(
    input: RepositoryAgentClaimInput,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentClaimResult> {
    const agentId = requiredString(input.agentId, "agentId", 256, "request");
    const repositoryIdentities = (input.repositoryIdentities ?? [])
      .map((identity) => requiredString(identity, "repositoryIdentity", 1_024, "request"))
      .slice(0, 128);
    const capabilities = sanitizeContext(input.capabilities, "capabilities");
    const payload = await this.requestJson(
      "/repository-agent/requests/claim",
      {
        method: "POST",
        body: JSON.stringify({
          agentId,
          ...(input.leaseMs == null
            ? {}
            : { leaseMs: finiteInt(input.leaseMs, { min: 1_000, max: 30 * 60_000 }) }),
          ...(repositoryIdentities.length ? { repositoryIdentities } : {}),
          ...(capabilities ? { capabilities } : {}),
        }),
      },
      options,
    );
    const pollAfterMs = finiteInt(payload.pollAfterMs, {
      min: 100,
      max: 30_000,
      fallback: this.pollIntervalMs,
    });
    if (payload.claim == null) return { claim: null, pollAfterMs };
    if (!isRecord(payload.claim)) invalidResponse("claim must be an object or null");
    const claim = payload.claim;
    const requestId = requiredString(claim.requestId, "claim.requestId", 256, "response");
    return {
      claim: {
        requestId,
        claimToken: requiredString(claim.claimToken, "claim.claimToken", 512, "response"),
        claimGeneration: finiteInt(claim.claimGeneration, { min: 1, max: 1_000_000_000 }),
        leaseExpiresAt: normalizedIso(claim.leaseExpiresAt, "claim.leaseExpiresAt", "response"),
        request: sanitizeRequest(claim.request, "response"),
      },
      pollAfterMs,
    };
  }

  private sanitizeLeaseInput(input: RepositoryAgentLeaseInput): RepositoryAgentLeaseInput {
    return {
      agentId: requiredString(input.agentId, "agentId", 256, "request"),
      claimToken: requiredString(input.claimToken, "claimToken", 512, "request"),
      claimGeneration: finiteInt(input.claimGeneration, { min: 1, max: 1_000_000_000 }),
      ...(input.leaseMs == null
        ? {}
        : { leaseMs: finiteInt(input.leaseMs, { min: 1_000, max: 30 * 60_000 }) }),
    };
  }

  private sanitizeLeaseResult(
    payload: Record<string, unknown>,
    expectedRequestId: string,
  ): RepositoryAgentLeaseResult {
    const requestId = requiredString(payload.requestId, "requestId", 256, "response");
    if (requestId !== expectedRequestId)
      invalidResponse("Repository Agent acknowledgement mismatch");
    return {
      requestId,
      status: sanitizeStatus(payload.status),
      ...(payload.leaseExpiresAt == null
        ? {}
        : {
            leaseExpiresAt: normalizedIso(payload.leaseExpiresAt, "leaseExpiresAt", "response"),
          }),
    };
  }

  async renewLease(
    requestIdRaw: string,
    input: RepositoryAgentLeaseInput,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentLeaseResult> {
    const requestId = requiredString(requestIdRaw, "requestId", 256, "request");
    const payload = await this.requestJson(
      `/repository-agent/requests/${encodeURIComponent(requestId)}/lease/renew`,
      { method: "POST", body: JSON.stringify(this.sanitizeLeaseInput(input)) },
      options,
    );
    return this.sanitizeLeaseResult(payload, requestId);
  }

  async complete(
    requestIdRaw: string,
    input: RepositoryAgentCompleteInput,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentLeaseResult> {
    const requestId = requiredString(requestIdRaw, "requestId", 256, "request");
    const result = sanitizeRepositoryAgentResult(input.result, requestId);
    const payload = await this.requestJson(
      `/repository-agent/requests/${encodeURIComponent(requestId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ ...this.sanitizeLeaseInput(input), result }),
      },
      options,
    );
    return this.sanitizeLeaseResult(payload, requestId);
  }

  async fail(
    requestIdRaw: string,
    input: RepositoryAgentFailInput,
    options: RepositoryAgentCallOptions = {},
  ): Promise<RepositoryAgentLeaseResult> {
    const requestId = requiredString(requestIdRaw, "requestId", 256, "request");
    const error = sanitizeRemoteError(input.error);
    if (!error) invalidRequest("error requires code and message");
    const payload = await this.requestJson(
      `/repository-agent/requests/${encodeURIComponent(requestId)}/fail`,
      {
        method: "POST",
        body: JSON.stringify({ ...this.sanitizeLeaseInput(input), error }),
      },
      options,
    );
    return this.sanitizeLeaseResult(payload, requestId);
  }
}

/**
 * Create one inert caller bundle for a service process. All processes use the
 * same typed contracts and durable Server endpoints, while retaining separate
 * client objects and lifecycle ownership.
 */
export function createRepositoryAgentServiceClients(
  options: RepositoryAgentServiceClientOptions,
): RepositoryAgentServiceClients {
  const repositoryAgent =
    options.repositoryAgent ??
    new RepositoryAgentClient({
      serverUrl: options.serverUrl,
      callerService: options.callerService,
      callerInstanceId: options.callerInstanceId,
      authToken: options.authToken,
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: options.requestTimeoutMs,
      askTimeoutMs: options.askTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      maxResponseBytes: options.maxResponseBytes,
    });
  const ownsMemoryStore = options.memoryStore === undefined;
  const memoryStore =
    options.memoryStore ??
    new MemoryHttpClient({
      serverUrl: options.serverUrl,
      authToken: options.authToken,
      callerService: options.callerService,
      authority: options.memoryAuthority,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.memoryTimeoutMs,
      maxResponseBytes: options.memoryMaxResponseBytes,
    });
  let closePromise: Promise<void> | null = null;

  return Object.freeze({
    repositoryAgent,
    memoryStore,
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = ownsMemoryStore ? memoryStore.close() : Promise.resolve();
      }
      return closePromise;
    },
  });
}

export function isRepositoryAgentTerminalStatus(status: RepositoryAgentRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
