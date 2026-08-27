import { createHash, randomUUID } from "crypto";
import { fetchBufferedWithHardDeadline, type FetchLike } from "./bounded_fetch.js";

export type MemoryJsonPrimitive = string | number | boolean | null;
export type MemoryJsonValue =
  | MemoryJsonPrimitive
  | MemoryJsonValue[]
  | { [key: string]: MemoryJsonValue };

export type MemoryStatus = "active" | "stale" | "superseded" | "invalid";
export const MEMORY_REINFORCEMENT_OUTCOMES = Object.freeze([
  "confirmed",
  "successful",
  "failed",
  "contradicted",
] as const);
export type MemoryReinforcementOutcome = (typeof MEMORY_REINFORCEMENT_OUTCOMES)[number];

/** Backend-independent limits. Address fields are rejected, never truncated. */
export const MEMORY_LIMITS = Object.freeze({
  namespaceChars: 128,
  repositoryIdChars: 256,
  sessionIdChars: 256,
  keyChars: 512,
  kindChars: 128,
  subjectKeyChars: 512,
  summaryChars: 16_000,
  listItems: 128,
  listItemChars: 256,
  tagChars: 128,
  evidenceItems: 128,
  evidencePathChars: 1_000,
  evidenceBlobOidChars: 256,
  evidenceSourceIdChars: 512,
  evidenceDetailChars: 2_000,
  provenanceServiceChars: 128,
  provenanceFieldChars: 512,
  searchTextChars: 2_000,
  selectorReasonChars: 1_000,
  recordIdChars: 256,
  searchMaxItems: 128,
  searchMaxChars: 1_000_000,
  /** Bounds backend work before application-level evidence/tag/text ranking. */
  searchCandidateRows: 4_096,
});

export type MemoryHttpCallerService =
  | "server"
  | "localbuddy"
  | "remotebuddy"
  | "workerpals"
  | "source_control_manager"
  | "repository_agent"
  | "cli"
  | "client";

export type MemoryHttpAuthority = "repository_agent" | "server";

export const MEMORY_HTTP_CALLER_HEADER = "x-pushpals-memory-caller";
export const MEMORY_HTTP_AUTHORITY_HEADER = "x-pushpals-memory-authority";
export const REPOSITORY_AGENT_MEMORY_NAMESPACES = Object.freeze([
  "repository_agent_cache",
  "repository_agent_capabilities",
  "repository_facts",
] as const);

export interface MemoryScope {
  namespace: string;
  repositoryId?: string | null;
  sessionId?: string | null;
}

export interface MemoryAddress {
  scope: MemoryScope;
  key: string;
}

export interface MemoryEvidence {
  /** Repository-relative path. Absolute paths must not be persisted as evidence. */
  path?: string;
  /** Git blob object ID observed for `path`. */
  blobOid?: string;
  sourceId?: string;
  detail?: string;
  observedAt?: string;
}

export interface MemoryProvenance {
  service: string;
  agentId?: string;
  runId?: string;
  requestId?: string;
  jobId?: string;
  modelId?: string;
  headSha?: string;
  promptVersion?: string;
}

export interface MemoryReinforcementObservation {
  /** Stable within a record; callers can provide an idempotency key through `observationId`. */
  id: string;
  outcome: MemoryReinforcementOutcome;
  /** Effective weight after contract-level normalization. */
  weight: number;
  observedAt: string;
  evidence?: MemoryEvidence[];
  provenance?: MemoryProvenance;
}

export const MAX_MEMORY_REINFORCEMENT_OBSERVATIONS = 256;

export interface MemoryRecord<T extends MemoryJsonValue = MemoryJsonValue> {
  id: string;
  scope: MemoryScope;
  key: string;
  kind: string;
  subjectKey: string | null;
  summary: string;
  value: T | null;
  tags: string[];
  evidence: MemoryEvidence[];
  /** Oldest-to-newest bounded history of authoritative outcome feedback. */
  observations: MemoryReinforcementObservation[];
  /** Immutable provenance of the record's initial creation. Outcome provenance lives in observations. */
  provenance: MemoryProvenance;
  confidence: number;
  usefulness: number;
  status: MemoryStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface MemoryPutInput<T extends MemoryJsonValue = MemoryJsonValue> extends MemoryAddress {
  kind: string;
  subjectKey?: string | null;
  summary: string;
  value?: T | null;
  tags?: string[];
  evidence?: MemoryEvidence[];
  provenance: MemoryProvenance;
  confidence?: number;
  usefulness?: number;
  status?: MemoryStatus;
  /** Relative expiry. Ignored when `expiresAt` is supplied. */
  ttlMs?: number | null;
  expiresAt?: string | null;
}

export interface MemoryPutOptions {
  /**
   * Zero means the address must not exist; positive values provide compare-and-set.
   * Existing outcome-learned scores survive ordinary upserts. A successful CAS may
   * replace confidence/usefulness when supplied; creation provenance and observation
   * history are always preserved.
   */
  expectedRevision?: number;
}

export interface MemoryGetOptions {
  includeExpired?: boolean;
  statuses?: MemoryStatus[];
}

export interface MemorySearchQuery {
  scope: MemoryScope;
  text?: string;
  kinds?: string[];
  subjectKeys?: string[];
  tags?: string[];
  /** Every requested path must be cited after slash normalization; matching is case-sensitive. */
  evidencePaths?: string[];
  statuses?: MemoryStatus[];
  includeExpired?: boolean;
  maxItems?: number;
  maxChars?: number;
}

export interface MemoryInvalidateSelector {
  scope: MemoryScope;
  keys?: string[];
  kinds?: string[];
  subjectKeys?: string[];
  tags?: string[];
  /** A record is invalidated when it cites any requested path; matching is case-sensitive. */
  evidencePaths?: string[];
  statuses?: MemoryStatus[];
  reason?: string;
}

export interface MemoryReinforceInput extends MemoryAddress {
  outcome: MemoryReinforcementOutcome;
  /**
   * Optional immutable record identity fence. When the address has been
   * removed and reused by a newer record, reinforcement fails instead of
   * teaching the replacement from a stale outcome.
   */
  expectedId?: string;
  /** Optional durable event identity used to make feedback retries idempotent. */
  observationId?: string;
  weight?: number;
  evidence?: MemoryEvidence[];
  provenance?: MemoryProvenance;
}

export interface MemoryPruneOptions {
  scope?: MemoryScope;
  /** Expired records at or before this time are removed. Defaults to the backend's current time. */
  expiredBefore?: string;
  /** Statuses eligible for age pruning when `updatedBefore` is supplied. Defaults to terminal statuses. */
  statuses?: MemoryStatus[];
  /** Also remove matching terminal/status-selected records updated at or before this time. */
  updatedBefore?: string;
}

export interface MemoryStore {
  put<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryPutInput<T>,
    options?: MemoryPutOptions,
  ): Promise<MemoryRecord<T>>;
  get<T extends MemoryJsonValue = MemoryJsonValue>(
    address: MemoryAddress,
    options?: MemoryGetOptions,
  ): Promise<MemoryRecord<T> | null>;
  search<T extends MemoryJsonValue = MemoryJsonValue>(
    query: MemorySearchQuery,
  ): Promise<Array<MemoryRecord<T>>>;
  invalidate(selector: MemoryInvalidateSelector): Promise<number>;
  reinforce<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryReinforceInput,
  ): Promise<MemoryRecord<T> | null>;
  prune(options?: MemoryPruneOptions): Promise<number>;
  close(): Promise<void>;
}

export class MemoryConflictError extends Error {
  readonly code: "conflict" | "record_conflict";

  constructor(message: string, code: "conflict" | "record_conflict" = "conflict") {
    super(message);
    this.name = "MemoryConflictError";
    this.code = code;
  }
}

export class MemoryStoreClosedError extends Error {
  constructor() {
    super("Memory store is closed");
    this.name = "MemoryStoreClosedError";
  }
}

export type MemoryValidationErrorCode = "invalid_reinforcement_outcome";

export class MemoryValidationError extends TypeError {
  readonly code: MemoryValidationErrorCode;

  constructor(message: string, code: MemoryValidationErrorCode) {
    super(message);
    this.name = "MemoryValidationError";
    this.code = code;
  }
}

export class MemoryHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status = 0, code?: unknown) {
    super(message);
    this.name = "MemoryHttpError";
    this.status = status;
    this.code = typeof code === "string" && code.trim() ? code.trim() : null;
  }
}

export function isMemoryReinforcementOutcome(value: unknown): value is MemoryReinforcementOutcome {
  return (
    typeof value === "string" &&
    (MEMORY_REINFORCEMENT_OUTCOMES as readonly string[]).includes(value)
  );
}

export function assertMemoryReinforcementOutcome(
  value: unknown,
): asserts value is MemoryReinforcementOutcome {
  if (isMemoryReinforcementOutcome(value)) return;
  throw new MemoryValidationError(
    `memory reinforcement outcome must be one of: ${MEMORY_REINFORCEMENT_OUTCOMES.join(", ")}`,
    "invalid_reinforcement_outcome",
  );
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function requiredText(value: unknown, label: string): string {
  const normalized = normalizedText(value);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function compactText(value: unknown, maxChars: number): string {
  return normalizedText(value).slice(0, maxChars);
}

/**
 * Address components are identifiers. Truncating them would make two distinct
 * caller-provided addresses alias the same record, so overlong input is rejected.
 * Internal whitespace is preserved; only surrounding whitespace is insignificant.
 */
function boundedAddressText(
  value: unknown,
  label: string,
  maxChars: number,
  required: boolean,
): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    if (required) throw new TypeError(`${label} is required`);
    return null;
  }
  if (normalized.length > maxChars) {
    throw new TypeError(`${label} must be at most ${maxChars} characters`);
  }
  if (normalized.includes("\0")) throw new TypeError(`${label} must not contain NUL characters`);
  return normalized;
}

function normalizedOptionalText(value: unknown): string | null {
  return normalizedText(value) || null;
}

function normalizeScope(scope: MemoryScope): MemoryScope {
  return {
    namespace: boundedAddressText(
      scope?.namespace,
      "memory scope namespace",
      MEMORY_LIMITS.namespaceChars,
      true,
    )!,
    repositoryId: boundedAddressText(
      scope?.repositoryId,
      "memory scope repositoryId",
      MEMORY_LIMITS.repositoryIdChars,
      false,
    ),
    sessionId: boundedAddressText(
      scope?.sessionId,
      "memory scope sessionId",
      MEMORY_LIMITS.sessionIdChars,
      false,
    ),
  };
}

function scopeKey(scope: MemoryScope): string {
  const normalized = normalizeScope(scope);
  return JSON.stringify([
    normalized.namespace,
    normalized.repositoryId ?? "",
    normalized.sessionId ?? "",
  ]);
}

function addressKey(address: MemoryAddress): string {
  const key = boundedAddressText(address.key, "memory key", MEMORY_LIMITS.keyChars, true);
  return `${scopeKey(address.scope)}\0${key}`;
}

function clampUnit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizedStringList(
  values: unknown,
  maxItems: number = MEMORY_LIMITS.listItems,
  maxChars: number = MEMORY_LIMITS.listItemChars,
): string[] {
  if (!Array.isArray(values)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = compactText(value, maxChars);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
    if (output.length >= maxItems) break;
  }
  return output;
}

function normalizeEvidence(evidence: unknown): MemoryEvidence[] {
  if (!Array.isArray(evidence)) return [];
  const output: MemoryEvidence[] = [];
  for (const raw of evidence.slice(0, MEMORY_LIMITS.evidenceItems)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as MemoryEvidence;
    const path =
      compactText(row.path, MEMORY_LIMITS.evidencePathChars).replace(/\\/g, "/") || undefined;
    if (path && (/^(?:[a-z]:)?\//i.test(path) || path.split("/").includes(".."))) {
      throw new TypeError("memory evidence paths must be repository-relative and contained");
    }
    const normalized: MemoryEvidence = {
      ...(path ? { path } : {}),
      ...(compactText(row.blobOid, MEMORY_LIMITS.evidenceBlobOidChars)
        ? { blobOid: compactText(row.blobOid, MEMORY_LIMITS.evidenceBlobOidChars) }
        : {}),
      ...(compactText(row.sourceId, MEMORY_LIMITS.evidenceSourceIdChars)
        ? { sourceId: compactText(row.sourceId, MEMORY_LIMITS.evidenceSourceIdChars) }
        : {}),
      ...(compactText(row.detail, MEMORY_LIMITS.evidenceDetailChars)
        ? { detail: compactText(row.detail, MEMORY_LIMITS.evidenceDetailChars) }
        : {}),
      ...(normalizedOptionalText(row.observedAt)
        ? { observedAt: normalizeTimestamp(row.observedAt, "evidence observedAt") }
        : {}),
    };
    if (Object.keys(normalized).length > 0) output.push(normalized);
  }
  return output;
}

function normalizeProvenance(value: MemoryProvenance): MemoryProvenance {
  const service = compactText(value?.service, MEMORY_LIMITS.provenanceServiceChars);
  if (!service) throw new TypeError("memory provenance service is required");
  const optional = (input: unknown): string | undefined =>
    compactText(input, MEMORY_LIMITS.provenanceFieldChars) || undefined;
  return {
    service,
    ...(optional(value.agentId) ? { agentId: optional(value.agentId) } : {}),
    ...(optional(value.runId) ? { runId: optional(value.runId) } : {}),
    ...(optional(value.requestId) ? { requestId: optional(value.requestId) } : {}),
    ...(optional(value.jobId) ? { jobId: optional(value.jobId) } : {}),
    ...(optional(value.modelId) ? { modelId: optional(value.modelId) } : {}),
    ...(optional(value.headSha) ? { headSha: optional(value.headSha) } : {}),
    ...(optional(value.promptVersion) ? { promptVersion: optional(value.promptVersion) } : {}),
  };
}

function normalizeTimestamp(value: unknown, label: string): string {
  const timestamp = compactText(value, 64);
  const parsed = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(parsed))
    throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeStatus(value: unknown, fallback: MemoryStatus = "active"): MemoryStatus {
  return value === "active" || value === "stale" || value === "superseded" || value === "invalid"
    ? value
    : fallback;
}

function cloneJson<T extends MemoryJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneObservation(
  observation: MemoryReinforcementObservation,
): MemoryReinforcementObservation {
  return {
    ...observation,
    ...(observation.evidence
      ? { evidence: observation.evidence.map((entry) => ({ ...entry })) }
      : {}),
    ...(observation.provenance ? { provenance: { ...observation.provenance } } : {}),
  };
}

function cloneRecord<T extends MemoryJsonValue>(record: MemoryRecord<T>): MemoryRecord<T> {
  return {
    ...record,
    scope: { ...record.scope },
    value: record.value == null ? null : cloneJson(record.value),
    tags: [...record.tags],
    evidence: record.evidence.map((entry) => ({ ...entry })),
    observations: record.observations.map(cloneObservation),
    provenance: { ...record.provenance },
  };
}

/** Exact JSON character cost used by every backend's search result budget. */
export function serializedMemoryRecordChars(record: MemoryRecord): number {
  return JSON.stringify(record).length;
}

function isExpired(record: MemoryRecord, nowMs: number): boolean {
  return record.expiresAt != null && Date.parse(record.expiresAt) <= nowMs;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function matchesAny(
  value: string | null,
  candidates?: string[],
  maxChars: number = MEMORY_LIMITS.listItemChars,
): boolean {
  if (!candidates || candidates.length === 0) return true;
  if (value == null) return false;
  return new Set(
    normalizedStringList(candidates, MEMORY_LIMITS.listItems, maxChars).map((entry) =>
      entry.toLowerCase(),
    ),
  ).has(value.toLowerCase());
}

function hasAllTags(record: MemoryRecord, tags?: string[]): boolean {
  const requested = normalizedStringList(tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars).map(
    (tag) => tag.toLowerCase(),
  );
  if (requested.length === 0) return true;
  const available = new Set(record.tags.map((tag) => tag.toLowerCase()));
  return requested.every((tag) => available.has(tag));
}

function hasAnyEvidencePath(record: MemoryRecord, paths?: string[]): boolean {
  const requested = normalizedStringList(
    paths,
    MEMORY_LIMITS.listItems,
    MEMORY_LIMITS.evidencePathChars,
  ).map((path) => path.replace(/\\/g, "/"));
  if (requested.length === 0) return true;
  const available = new Set(
    record.evidence
      .map((entry) => entry.path?.replace(/\\/g, "/"))
      .filter((path): path is string => Boolean(path)),
  );
  return requested.some((path) => available.has(path));
}

function hasAllEvidencePaths(record: MemoryRecord, paths?: string[]): boolean {
  const requested = normalizedStringList(
    paths,
    MEMORY_LIMITS.listItems,
    MEMORY_LIMITS.evidencePathChars,
  ).map((path) => path.replace(/\\/g, "/"));
  if (requested.length === 0) return true;
  const available = new Set(
    record.evidence
      .map((entry) => entry.path?.replace(/\\/g, "/"))
      .filter((path): path is string => Boolean(path)),
  );
  return requested.every((path) => available.has(path));
}

export interface MemoryReinforcementEffect {
  weight: number;
  confidence: number;
  usefulness: number;
  status: MemoryStatus;
}

/**
 * Applies the backend-independent learning rule used by every MemoryStore.
 * Terminal states remain terminal; confirmed stale memory becomes active again.
 */
export function resolveMemoryReinforcement(
  record: Pick<MemoryRecord, "confidence" | "usefulness" | "status">,
  outcome: MemoryReinforcementOutcome,
  requestedWeight: unknown = 1,
): MemoryReinforcementEffect {
  assertMemoryReinforcementOutcome(outcome);
  const parsedWeight = Number(requestedWeight);
  const weight = Math.max(0, Math.min(4, Number.isFinite(parsedWeight) ? parsedWeight : 1));
  const positive = outcome === "confirmed" || outcome === "successful";
  const confidence = positive
    ? record.confidence + (1 - record.confidence) * 0.15 * weight
    : record.confidence * (1 - 0.25 * weight);
  const usefulness = positive
    ? record.usefulness + (1 - record.usefulness) * 0.12 * weight
    : record.usefulness * (1 - 0.2 * weight);
  const status =
    outcome === "contradicted"
      ? "superseded"
      : positive && record.status === "stale"
        ? "active"
        : record.status;
  return {
    weight,
    confidence: clampUnit(confidence, record.confidence),
    usefulness: clampUnit(usefulness, record.usefulness),
    status,
  };
}

function reinforcementObservationId(recordId: string, input: MemoryReinforceInput): string {
  const explicit = normalizedOptionalText(input.observationId);
  const provenance = input.provenance;
  const inferredParts = provenance
    ? [
        normalizedOptionalText(provenance.service),
        normalizedOptionalText(provenance.requestId),
        normalizedOptionalText(provenance.jobId),
        normalizedOptionalText(provenance.runId),
      ].filter((part): part is string => part != null)
    : [];
  const inferredIdentity = inferredParts.length > 1 ? inferredParts.join("\0") : null;
  if (!explicit && !inferredIdentity) return randomUUID();
  const identity = explicit
    ? [recordId, "explicit", explicit]
    : [recordId, "inferred", inferredIdentity, input.outcome];
  return `observation_${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32)}`;
}

export function createMemoryReinforcementObservation(
  recordId: string,
  input: MemoryReinforceInput,
  observedAt: string,
): MemoryReinforcementObservation {
  assertMemoryReinforcementOutcome(input.outcome);
  const effect = resolveMemoryReinforcement(
    { confidence: 0, usefulness: 0, status: "active" },
    input.outcome,
    input.weight,
  );
  const evidence = normalizeEvidence(input.evidence);
  return {
    id: reinforcementObservationId(recordId, input),
    outcome: input.outcome,
    weight: effect.weight,
    observedAt: normalizeTimestamp(observedAt, "reinforcement observedAt"),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(input.provenance ? { provenance: normalizeProvenance(input.provenance) } : {}),
  };
}

export function appendMemoryReinforcementObservation(
  existing: MemoryReinforcementObservation[],
  observation: MemoryReinforcementObservation,
): { observations: MemoryReinforcementObservation[]; appended: boolean } {
  const prior = existing.find((entry) => entry.id === observation.id);
  if (prior) assertMemoryReinforcementObservationCompatible(prior, observation);
  const appended = prior == null;
  const candidates = appended ? [...existing, observation] : existing;
  const seen = new Set<string>();
  const observations: MemoryReinforcementObservation[] = [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    observations.unshift(cloneObservation(candidate));
    if (observations.length >= MAX_MEMORY_REINFORCEMENT_OBSERVATIONS) break;
  }
  return { observations, appended };
}

function canonicalObservationPayload(observation: MemoryReinforcementObservation): string {
  const evidence = (observation.evidence ?? [])
    .map((entry) =>
      JSON.stringify({
        path: entry.path ?? null,
        blobOid: entry.blobOid ?? null,
        sourceId: entry.sourceId ?? null,
        detail: entry.detail ?? null,
        observedAt: entry.observedAt ?? null,
      }),
    )
    .sort();
  const provenance = observation.provenance
    ? {
        service: observation.provenance.service,
        agentId: observation.provenance.agentId ?? null,
        runId: observation.provenance.runId ?? null,
        requestId: observation.provenance.requestId ?? null,
        jobId: observation.provenance.jobId ?? null,
        modelId: observation.provenance.modelId ?? null,
        headSha: observation.provenance.headSha ?? null,
        promptVersion: observation.provenance.promptVersion ?? null,
      }
    : null;
  return JSON.stringify({
    outcome: observation.outcome,
    weight: observation.weight,
    evidence,
    provenance,
  });
}

/**
 * Enforces the observation idempotency contract. The timestamp of a retry is
 * intentionally ignored, while its normalized outcome payload must be identical.
 */
export function assertMemoryReinforcementObservationCompatible(
  existing: MemoryReinforcementObservation,
  candidate: MemoryReinforcementObservation,
): void {
  if (existing.id !== candidate.id) return;
  if (canonicalObservationPayload(existing) === canonicalObservationPayload(candidate)) return;
  throw new MemoryConflictError(
    `Memory observation conflict for ${candidate.id}: the id was already used for a different outcome payload`,
  );
}

/** Bounded learned-quality tie breaker shared by every MemoryStore backend. */
export function memoryRecordRankingQuality(
  record: Pick<MemoryRecord, "confidence" | "usefulness">,
): number {
  return (clampUnit(record.confidence, 0.5) + clampUnit(record.usefulness, 0.5)) / 2;
}

function searchScore(record: MemoryRecord, text: string): number {
  const tokens = normalizedText(text)
    .toLowerCase()
    .split(/[^a-z0-9_.\/-]+/)
    .filter((token) => token.length > 1)
    .slice(0, 64);
  if (tokens.length === 0) return 0;
  const subject = (record.subjectKey ?? "").toLowerCase();
  const haystack = [record.key, record.kind, subject, record.summary, ...record.tags]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of new Set(tokens)) {
    if (record.key.toLowerCase() === token || subject === token) score += 6;
    else if (record.key.toLowerCase().includes(token) || subject.includes(token)) score += 3;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly now: () => Date;
  private closed = false;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryStoreClosedError();
  }

  async put<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryPutInput<T>,
    options: MemoryPutOptions = {},
  ): Promise<MemoryRecord<T>> {
    this.assertOpen();
    const normalizedScope = normalizeScope(input.scope);
    const key = boundedAddressText(input.key, "memory key", MEMORY_LIMITS.keyChars, true)!;
    const storageKey = addressKey({ scope: normalizedScope, key });
    const existing = this.records.get(storageKey) as MemoryRecord<T> | undefined;
    if (options.expectedRevision != null) {
      const actualRevision = existing?.revision ?? 0;
      if (actualRevision !== options.expectedRevision) {
        throw new MemoryConflictError(
          `Memory revision conflict for ${key}: expected ${options.expectedRevision}, got ${actualRevision}`,
        );
      }
    }

    const now = this.now().toISOString();
    let expiresAt: string | null;
    if (input.expiresAt !== undefined) {
      expiresAt = input.expiresAt == null ? null : normalizeTimestamp(input.expiresAt, "expiresAt");
    } else if (input.ttlMs !== undefined && input.ttlMs !== null) {
      const ttlMs = Number(input.ttlMs);
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
      expiresAt = new Date(Date.parse(now) + Math.floor(ttlMs)).toISOString();
    } else {
      expiresAt = existing?.expiresAt ?? null;
    }

    const status = normalizeStatus(input.status, existing?.status ?? "active");
    const preserveLearnedScores = existing != null && options.expectedRevision === undefined;
    const remainsInvalid = status === "invalid" && existing?.status === "invalid";
    const record: MemoryRecord<T> = {
      id: existing?.id ?? randomUUID(),
      scope: normalizedScope,
      key,
      kind: requiredText(compactText(input.kind, MEMORY_LIMITS.kindChars), "memory kind"),
      subjectKey: compactText(input.subjectKey, MEMORY_LIMITS.subjectKeyChars) || null,
      summary: requiredText(
        compactText(input.summary, MEMORY_LIMITS.summaryChars),
        "memory summary",
      ),
      value: input.value == null ? null : cloneJson(input.value),
      tags: normalizedStringList(input.tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars),
      evidence: normalizeEvidence(input.evidence),
      observations: existing?.observations.map(cloneObservation) ?? [],
      provenance: existing?.provenance ?? normalizeProvenance(input.provenance),
      confidence: preserveLearnedScores
        ? existing.confidence
        : clampUnit(input.confidence, existing?.confidence ?? 0.5),
      usefulness: preserveLearnedScores
        ? existing.usefulness
        : clampUnit(input.usefulness, existing?.usefulness ?? 0.5),
      status,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt,
      invalidatedAt: status === "invalid" ? (remainsInvalid ? existing.invalidatedAt : now) : null,
      invalidationReason:
        status === "invalid" && remainsInvalid ? existing.invalidationReason : null,
    };
    this.records.set(storageKey, record as MemoryRecord);
    return cloneRecord(record);
  }

  async get<T extends MemoryJsonValue = MemoryJsonValue>(
    address: MemoryAddress,
    options: MemoryGetOptions = {},
  ): Promise<MemoryRecord<T> | null> {
    this.assertOpen();
    const record = this.records.get(addressKey(address)) as MemoryRecord<T> | undefined;
    if (!record) return null;
    if (!options.includeExpired && isExpired(record, this.now().getTime())) return null;
    const statuses = options.statuses?.length ? options.statuses : ["active"];
    if (!statuses.includes(record.status)) return null;
    return cloneRecord(record);
  }

  async search<T extends MemoryJsonValue = MemoryJsonValue>(
    query: MemorySearchQuery,
  ): Promise<Array<MemoryRecord<T>>> {
    this.assertOpen();
    const scope = normalizeScope(query.scope);
    const statuses = query.statuses?.length ? query.statuses : ["active"];
    const nowMs = this.now().getTime();
    const candidates = [...this.records.values()]
      .filter((record) => sameScope(record.scope, scope))
      .filter((record) => query.includeExpired || !isExpired(record, nowMs))
      .filter((record) => statuses.includes(record.status))
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          right.revision - left.revision ||
          left.key.localeCompare(right.key),
      )
      .slice(0, MEMORY_LIMITS.searchCandidateRows);
    const scored = candidates
      .filter((record) => matchesAny(record.kind, query.kinds, MEMORY_LIMITS.kindChars))
      .filter((record) =>
        matchesAny(record.subjectKey, query.subjectKeys, MEMORY_LIMITS.subjectKeyChars),
      )
      .filter((record) => hasAllTags(record, query.tags))
      .filter((record) => hasAllEvidencePaths(record, query.evidencePaths))
      .map((record) => ({
        record,
        score: searchScore(record, compactText(query.text, MEMORY_LIMITS.searchTextChars)),
      }))
      .filter((entry) => !compactText(query.text, MEMORY_LIMITS.searchTextChars) || entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          memoryRecordRankingQuality(right.record) - memoryRecordRankingQuality(left.record) ||
          Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt) ||
          right.record.revision - left.record.revision ||
          left.record.key.localeCompare(right.record.key),
      );

    const requestedMaxItems = Number(query.maxItems ?? 12);
    const maxItems = Math.max(
      1,
      Math.min(
        MEMORY_LIMITS.searchMaxItems,
        Number.isFinite(requestedMaxItems) ? Math.floor(requestedMaxItems) : 12,
      ),
    );
    const requestedMaxChars = Number(query.maxChars ?? 16_000);
    const maxChars = Math.max(
      1,
      Math.min(
        MEMORY_LIMITS.searchMaxChars,
        Number.isFinite(requestedMaxChars) ? Math.floor(requestedMaxChars) : 16_000,
      ),
    );
    const output: Array<MemoryRecord<T>> = [];
    let usedChars = 0;
    for (const { record } of scored) {
      if (output.length >= maxItems) break;
      const cloned = cloneRecord(record as MemoryRecord<T>);
      const cost = serializedMemoryRecordChars(cloned);
      if (usedChars + cost > maxChars) continue;
      output.push(cloned);
      usedChars += cost;
    }
    return output;
  }

  async invalidate(selector: MemoryInvalidateSelector): Promise<number> {
    this.assertOpen();
    const scope = normalizeScope(selector.scope);
    const reason = compactText(selector.reason, MEMORY_LIMITS.selectorReasonChars) || "invalidated";
    const now = this.now().toISOString();
    let changed = 0;
    for (const [key, record] of this.records) {
      if (!sameScope(record.scope, scope)) continue;
      if (!matchesAny(record.key, selector.keys, MEMORY_LIMITS.keyChars)) continue;
      if (!matchesAny(record.kind, selector.kinds, MEMORY_LIMITS.kindChars)) continue;
      if (!matchesAny(record.subjectKey, selector.subjectKeys, MEMORY_LIMITS.subjectKeyChars))
        continue;
      if (!hasAllTags(record, selector.tags)) continue;
      if (!hasAnyEvidencePath(record, selector.evidencePaths)) continue;
      if (selector.statuses?.length && !selector.statuses.includes(record.status)) continue;
      if (record.status === "invalid") continue;
      this.records.set(key, {
        ...record,
        status: "invalid",
        revision: record.revision + 1,
        updatedAt: now,
        invalidatedAt: now,
        invalidationReason: reason,
      });
      changed++;
    }
    return changed;
  }

  async reinforce<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryReinforceInput,
  ): Promise<MemoryRecord<T> | null> {
    this.assertOpen();
    assertMemoryReinforcementOutcome(input?.outcome);
    const storageKey = addressKey(input);
    const record = this.records.get(storageKey) as MemoryRecord<T> | undefined;
    if (!record) return null;
    if (input.expectedId !== undefined) {
      const expectedId = boundedAddressText(
        input.expectedId,
        "memory expectedId",
        MEMORY_LIMITS.recordIdChars,
        true,
      )!;
      if (record.id !== expectedId) {
        throw new MemoryConflictError(
          `Memory record conflict for ${record.scope.namespace}/${record.key}: expected id ${expectedId}, got ${record.id}`,
          "record_conflict",
        );
      }
    }
    const effect = resolveMemoryReinforcement(record, input.outcome, input.weight);
    const now = this.now().toISOString();
    const observation = createMemoryReinforcementObservation(record.id, input, now);
    const appended = appendMemoryReinforcementObservation(record.observations, observation);
    if (!appended.appended) return cloneRecord(record);
    const updated: MemoryRecord<T> = {
      ...record,
      confidence: effect.confidence,
      usefulness: effect.usefulness,
      status: effect.status,
      evidence:
        input.evidence && input.evidence.length > 0
          ? normalizeEvidence([...record.evidence, ...input.evidence])
          : record.evidence,
      observations: appended.observations,
      provenance: record.provenance,
      revision: record.revision + 1,
      updatedAt: now,
      invalidatedAt: effect.status === "invalid" ? record.invalidatedAt : null,
      invalidationReason: effect.status === "invalid" ? record.invalidationReason : null,
    };
    this.records.set(storageKey, updated as MemoryRecord);
    return cloneRecord(updated);
  }

  async prune(options: MemoryPruneOptions = {}): Promise<number> {
    this.assertOpen();
    const expiryCutoff = options.expiredBefore
      ? Date.parse(normalizeTimestamp(options.expiredBefore, "expiredBefore"))
      : this.now().getTime();
    const updatedCutoff = options.updatedBefore
      ? Date.parse(normalizeTimestamp(options.updatedBefore, "updatedBefore"))
      : null;
    const ageStatuses = options.statuses?.length
      ? options.statuses
      : (["invalid", "superseded"] satisfies MemoryStatus[]);
    let removed = 0;
    for (const [key, record] of this.records) {
      if (options.scope && !sameScope(record.scope, options.scope)) continue;
      const expired = record.expiresAt != null && Date.parse(record.expiresAt) <= expiryCutoff;
      const agedTerminal =
        updatedCutoff != null &&
        ageStatuses.includes(record.status) &&
        Date.parse(record.updatedAt) <= updatedCutoff;
      if (!expired && !agedTerminal) continue;
      this.records.delete(key);
      removed++;
    }
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface MemoryHttpClientOptions {
  serverUrl: string;
  authToken?: string | null;
  /** Auditable service identity attached to every memory request. Defaults to `client`. */
  callerService?: MemoryHttpCallerService;
  /** Narrow process capability; the Server still enforces namespace/operation policy. */
  authority?: MemoryHttpAuthority | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type MemoryHttpEnvelope = {
  ok?: boolean;
  code?: unknown;
  message?: unknown;
  error?: unknown;
  record?: unknown;
  records?: unknown;
  count?: unknown;
};

export class MemoryHttpClient implements MemoryStore {
  private readonly serverUrl: string;
  private readonly authToken: string | null;
  private readonly callerService: MemoryHttpCallerService;
  private readonly authority: MemoryHttpAuthority | null;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private closed = false;

  constructor(options: MemoryHttpClientOptions) {
    this.serverUrl = requiredText(options.serverUrl, "memory server URL").replace(/\/+$/, "");
    this.authToken = normalizedOptionalText(options.authToken);
    const callerService = normalizedText(options.callerService ?? "client");
    if (
      callerService !== "server" &&
      callerService !== "localbuddy" &&
      callerService !== "remotebuddy" &&
      callerService !== "workerpals" &&
      callerService !== "source_control_manager" &&
      callerService !== "repository_agent" &&
      callerService !== "cli" &&
      callerService !== "client"
    ) {
      throw new TypeError(`Unsupported memory caller service: ${callerService}`);
    }
    this.callerService = callerService;
    const authority = normalizedOptionalText(options.authority);
    if (authority && authority !== "repository_agent" && authority !== "server") {
      throw new TypeError(`Unsupported memory authority: ${authority}`);
    }
    this.authority = authority === "repository_agent" || authority === "server" ? authority : null;
    this.fetchImpl = options.fetchImpl;
    const requestedTimeoutMs = Number(options.timeoutMs ?? 10_000);
    this.timeoutMs = Math.max(
      1,
      Math.min(
        120_000,
        Number.isFinite(requestedTimeoutMs) ? Math.floor(requestedTimeoutMs) : 10_000,
      ),
    );
    const requestedMaxResponseBytes = Number(options.maxResponseBytes ?? 2 * 1024 * 1024);
    this.maxResponseBytes = Math.max(
      1_024,
      Math.min(
        32 * 1024 * 1024,
        Number.isFinite(requestedMaxResponseBytes)
          ? Math.floor(requestedMaxResponseBytes)
          : 2 * 1024 * 1024,
      ),
    );
  }

  private async request(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
  ): Promise<MemoryHttpEnvelope> {
    if (this.closed) throw new MemoryStoreClosedError();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [MEMORY_HTTP_CALLER_HEADER]: this.callerService,
      ...(this.authority ? { [MEMORY_HTTP_AUTHORITY_HEADER]: this.authority } : {}),
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${this.serverUrl}${path}`,
      init: { method, headers, body: JSON.stringify(body) },
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      fetchImpl: this.fetchImpl,
      timeoutMessage: `Memory request ${method} ${path} timed out after ${this.timeoutMs}ms`,
    });
    let payload: MemoryHttpEnvelope = {};
    try {
      payload = (await response.json()) as MemoryHttpEnvelope;
    } catch {
      if (response.ok)
        throw new MemoryHttpError("Memory server returned invalid JSON", response.status);
    }
    if (!response.ok || payload.ok === false) {
      const detail =
        normalizedText(payload.message ?? payload.error) || response.statusText || "request failed";
      if (response.status === 409) {
        throw new MemoryConflictError(
          detail,
          payload.code === "record_conflict" ? "record_conflict" : "conflict",
        );
      }
      throw new MemoryHttpError(
        `Memory server request failed: ${detail}`,
        response.status,
        payload.code,
      );
    }
    return payload;
  }

  async put<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryPutInput<T>,
    options: MemoryPutOptions = {},
  ): Promise<MemoryRecord<T>> {
    const payload = await this.request("/memory/records", "PUT", { input, options });
    if (!payload.record) throw new MemoryHttpError("Memory server response omitted record");
    return payload.record as MemoryRecord<T>;
  }

  async get<T extends MemoryJsonValue = MemoryJsonValue>(
    address: MemoryAddress,
    options: MemoryGetOptions = {},
  ): Promise<MemoryRecord<T> | null> {
    const payload = await this.request("/memory/get", "POST", { address, options });
    return (payload.record as MemoryRecord<T> | null | undefined) ?? null;
  }

  async search<T extends MemoryJsonValue = MemoryJsonValue>(
    query: MemorySearchQuery,
  ): Promise<Array<MemoryRecord<T>>> {
    const payload = await this.request("/memory/search", "POST", { query });
    if (!Array.isArray(payload.records)) {
      throw new MemoryHttpError("Memory server response omitted records");
    }
    return payload.records as Array<MemoryRecord<T>>;
  }

  async invalidate(selector: MemoryInvalidateSelector): Promise<number> {
    const payload = await this.request("/memory/invalidate", "POST", { selector });
    return Math.max(0, Math.floor(Number(payload.count ?? 0)) || 0);
  }

  async reinforce<T extends MemoryJsonValue = MemoryJsonValue>(
    input: MemoryReinforceInput,
  ): Promise<MemoryRecord<T> | null> {
    assertMemoryReinforcementOutcome(input?.outcome);
    const payload = await this.request("/memory/reinforce", "POST", { input });
    return (payload.record as MemoryRecord<T> | null | undefined) ?? null;
  }

  async prune(options: MemoryPruneOptions = {}): Promise<number> {
    const payload = await this.request("/memory/prune", "POST", { options });
    return Math.max(0, Math.floor(Number(payload.count ?? 0)) || 0);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
