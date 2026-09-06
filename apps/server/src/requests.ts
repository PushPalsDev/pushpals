/**
 * Request Queue for routed prompts from LocalBuddy -> RemoteBuddy
 *
 * Flow:
 *   1. LocalBuddy enqueues the routed user request to this queue
 *   2. RemoteBuddy polls and claims requests
 *   3. RemoteBuddy handles deeper planning/context as needed
 *   4. RemoteBuddy processes and marks complete/failed
 */

import { Database, type Changes, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  normalizeAutonomyComponentArea,
  validateScopeInvariants,
  type AutonomyComponentArea,
} from "shared";

export type RequestStatus = "pending" | "claimed" | "completed" | "failed";
export type RequestOutcomeStatus = RequestStatus | "delegated";
export type QueuePriority = "interactive" | "normal" | "background";

export const DEFAULT_REQUEST_LEASE_MS = 3 * 60_000;
const MIN_REQUEST_LEASE_MS = 30_000;
const MAX_REQUEST_LEASE_MS = 15 * 60_000;
const MIN_REQUEST_DEFER_MS = 1_000;
const MAX_REQUEST_DEFER_MS = 30 * 60_000;
const MAX_RUNTIME_CIRCUIT_RECHECK_MS = 30_000;
const DEFAULT_HANDOFF_CHAIN_RECONCILE_LIMIT = 200;
const MAX_HANDOFF_CHAIN_RECONCILE_LIMIT = 1_000;
const DEFAULT_HANDOFF_CHAIN_DEPTH = 16;
const MAX_HANDOFF_CHAIN_DEPTH = 64;
const DEFAULT_DISPATCH_CONFIRMATION_TTL_MS = 30_000;
const MIN_DISPATCH_CONFIRMATION_TTL_MS = 1;
const MAX_DISPATCH_CONFIRMATION_TTL_MS = 2 * 60_000;

const PRIORITY_ORDER: QueuePriority[] = ["interactive", "normal", "background"];
const PRIORITY_SLA_MS: Record<QueuePriority, number> = {
  interactive: 20_000,
  normal: 90_000,
  background: 240_000,
};

function normalizePriority(value: unknown): QueuePriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
}

function priorityRank(priority: QueuePriority): number {
  const idx = PRIORITY_ORDER.indexOf(priority);
  return idx >= 0 ? idx : 1;
}

function parseBudgetMs(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1_000, parsed);
}

function normalizeRequestLeaseMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REQUEST_LEASE_MS;
  return Math.max(MIN_REQUEST_LEASE_MS, Math.min(MAX_REQUEST_LEASE_MS, Math.floor(parsed)));
}

function normalizeDispatchConfirmationTtlMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_CONFIRMATION_TTL_MS;
  return Math.max(
    MIN_DISPATCH_CONFIRMATION_TTL_MS,
    Math.min(MAX_DISPATCH_CONFIRMATION_TTL_MS, Math.floor(parsed)),
  );
}

function resolveDispatchConfirmationExpiresAt(
  body: Record<string, unknown>,
  nowMs: number,
): string {
  const ttlDeadlineMs = nowMs + normalizeDispatchConfirmationTtlMs(body.dispatchConfirmationTtlMs);
  const deadlineText = asString(body.dispatchConfirmationDeadlineAt);
  const requestedDeadlineMs = deadlineText ? Date.parse(deadlineText) : Number.NaN;
  const expiresAtMs = Number.isFinite(requestedDeadlineMs)
    ? Math.min(ttlDeadlineMs, requestedDeadlineMs)
    : ttlDeadlineMs;
  return new Date(expiresAtMs).toISOString();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter(Boolean);
}

function parseMetadataJson(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const obj = asObject(parsed);
    return obj ?? undefined;
  } catch {
    return undefined;
  }
}

function isAutonomyMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return asString(metadata?.origin).toLowerCase() === "autonomy";
}

function sanitizeRequestMetadata(input: unknown): {
  metadata: Record<string, unknown> | null;
  error?: string;
} {
  const record = asObject(input);
  if (!record) return { metadata: null };
  const origin = asString(record.origin).toLowerCase();
  if (origin !== "autonomy") return { metadata: null };
  const autonomy = asObject(record.autonomy);
  if (!autonomy) {
    return { metadata: null, error: "metadata.autonomy object is required for origin=autonomy" };
  }
  const componentAreaRaw = asString(autonomy.componentArea ?? autonomy.component_area);
  const componentArea = normalizeAutonomyComponentArea(componentAreaRaw);
  const targetPathsRaw = asStringArray(autonomy.targetPaths ?? autonomy.target_paths);
  const writeGlobsRaw = asStringArray(autonomy.writeGlobs ?? autonomy.write_globs);
  const scope = validateScopeInvariants(
    componentArea as AutonomyComponentArea | null,
    targetPathsRaw,
    writeGlobsRaw,
    { requireWriteGlobs: true, hintsOnly: true },
  );
  if (!scope.ok) {
    return {
      metadata: null,
      error: `autonomy metadata scope invalid: ${scope.errors.join("; ")}`,
    };
  }
  const validationIncidentInput = asObject(
    autonomy.validationIncident ?? autonomy.validation_incident,
  );
  const validationIncidentId = asString(
    validationIncidentInput?.incidentId ?? validationIncidentInput?.incident_id,
  ).slice(0, 256);
  const validationIncident = validationIncidentId
    ? {
        incidentId: validationIncidentId,
        candidateSha: asString(
          validationIncidentInput?.candidateSha ?? validationIncidentInput?.candidate_sha,
        ).slice(0, 128),
        candidateRef: asString(
          validationIncidentInput?.candidateRef ?? validationIncidentInput?.candidate_ref,
        ).slice(0, 256),
        baselineSha: asString(
          validationIncidentInput?.baselineSha ?? validationIncidentInput?.baseline_sha,
        ).slice(0, 128),
        validationScope: asString(
          validationIncidentInput?.validationScope ?? validationIncidentInput?.validation_scope,
        ).slice(0, 64),
        failureFingerprint: asString(
          validationIncidentInput?.failureFingerprint ??
            validationIncidentInput?.failure_fingerprint,
        ).slice(0, 256),
      }
    : null;
  return {
    metadata: {
      origin: "autonomy",
      autonomy: {
        objectiveId: asString(autonomy.objectiveId ?? autonomy.objective_id),
        runId: asString(autonomy.runId ?? autonomy.run_id),
        snapshotId: asString(autonomy.snapshotId ?? autonomy.snapshot_id),
        patternKey: asString(autonomy.patternKey ?? autonomy.pattern_key),
        componentArea: scope.componentArea ?? componentAreaRaw,
        targetPaths: scope.normalizedTargetPaths,
        writeGlobs: scope.normalizedWriteGlobs,
        reservationRequired:
          autonomy.reservationRequired === true || autonomy.reservation_required === true,
        ...(validationIncident ? { validationIncident } : {}),
      },
    },
  };
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const value = sorted[rank];
  return Number.isFinite(value) ? value : null;
}

function summarizeSamples(samples: number[]): SloMetricSummary {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) {
    return { p50: null, p95: null, avg: null, sampleSize: 0 };
  }
  const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  return {
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    avg: Number.isFinite(avg) ? avg : null,
    sampleSize: valid.length,
  };
}

export interface RequestRow {
  id: string;
  sessionId: string;
  prompt: string;
  priority: QueuePriority;
  queueWaitBudgetMs: number;
  metadataJson: string | null;
  idempotencyKey: string | null;
  metadata?: Record<string, unknown>;
  // Overrides / routing hints for RemoteBuddy
  forceWorker: number; // 0/1 (SQLite INTEGER)
  forceLane: string | null; // "worker" | "deterministic" | null
  workerRequired: number; // Durable server-owned planning/handoff invariant (0/1)
  handoffJobId: string | null;
  /**
   * Autonomous cycles enqueue provisionally, then confirm only while their
   * snapshot/deadline fence is still live. A token without confirmedAt keeps
   * the row durable but invisible to claimers until it expires.
   */
  dispatchConfirmationToken: string | null;
  dispatchConfirmationExpiresAt: string | null;
  dispatchConfirmedAt: string | null;
  /**
   * Read-model fields. `status` remains the planner queue protocol state, while
   * `outcomeStatus` follows a durable WorkerPal handoff through execution.
   */
  handoffJobStatus?: string | null;
  outcomeStatus?: RequestOutcomeStatus;
  outcomeUpdatedAt?: string | null;
  outcomeDurationMs?: number | null;
  status: RequestStatus;
  agentId: string | null;
  claimToken: string | null;
  claimGeneration: number;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  deferReason: string | null;
  claimAttempts: number;
  result: string | null;
  error: string | null;
  enqueuedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SloMetricSummary {
  p50: number | null;
  p95: number | null;
  avg: number | null;
  sampleSize: number;
}

export interface RequestSloSummary {
  windowHours: number;
  terminal: number;
  completed: number;
  failed: number;
  successRate: number | null;
  durationMs: SloMetricSummary;
  queueWaitMs: SloMetricSummary;
}

interface HandoffJobOutcomeRow {
  id: string;
  status: string;
  failedAt: string | null;
  abandonedAt: string | null;
  publishBlockedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

const FAILED_HANDOFF_JOB_STATUSES = new Set(["failed", "abandoned", "publish_blocked"]);

function projectRequestOutcome(
  row: RequestRow,
  handoffJob: HandoffJobOutcomeRow | null,
): RequestRow {
  const handoffJobStatus = asString(handoffJob?.status).toLowerCase() || null;
  const hasDurableWorkerHandoff = row.workerRequired === 1 && Boolean(asString(row.handoffJobId));
  let outcomeStatus: RequestOutcomeStatus = row.status;
  let outcomeUpdatedAt: string | null =
    row.status === "failed"
      ? (row.failedAt ?? row.updatedAt)
      : row.status === "completed"
        ? (row.completedAt ?? row.updatedAt)
        : row.updatedAt;
  let outcomeDurationMs = row.durationMs;

  // A planner failure is terminal regardless of whether it had begun a
  // handoff. Otherwise, a durable handoff owns the user-visible outcome until
  // its exact WorkerPal job terminates.
  if (row.status !== "failed" && hasDurableWorkerHandoff) {
    if (handoffJobStatus === "completed") {
      outcomeStatus = "completed";
      outcomeUpdatedAt = handoffJob?.completedAt ?? handoffJob?.updatedAt ?? row.updatedAt;
    } else if (handoffJobStatus && FAILED_HANDOFF_JOB_STATUSES.has(handoffJobStatus)) {
      outcomeStatus = "failed";
      outcomeUpdatedAt =
        (handoffJobStatus === "failed"
          ? handoffJob?.failedAt
          : handoffJobStatus === "abandoned"
            ? handoffJob?.abandonedAt
            : handoffJob?.publishBlockedAt) ??
        handoffJob?.updatedAt ??
        row.updatedAt;
    } else {
      outcomeStatus = "delegated";
      outcomeUpdatedAt = handoffJob?.updatedAt ?? row.updatedAt;
      outcomeDurationMs = null;
    }

    if (outcomeStatus === "completed" || outcomeStatus === "failed") {
      const startedAt = parseIsoMs(row.enqueuedAt) ?? parseIsoMs(row.createdAt);
      const endedAt = parseIsoMs(outcomeUpdatedAt);
      outcomeDurationMs =
        startedAt != null && endedAt != null && endedAt >= startedAt
          ? Math.round(endedAt - startedAt)
          : null;
    }
  }

  return {
    ...row,
    // The dispatch capability is write-only outside enqueue/confirmation.
    // Never expose it through detail, list, SLO, or lifecycle projections.
    dispatchConfirmationToken: null,
    handoffJobStatus,
    outcomeStatus,
    outcomeUpdatedAt,
    outcomeDurationMs,
  };
}

export interface RequestHandoffReconciliationResult {
  completed: number;
  requestIds: string[];
  jobIds: string[];
}

export interface RequestHandoffChainReconciliationResult {
  scanned: number;
  repointed: number;
  requestIds: string[];
  previousJobIds: string[];
  replacementJobIds: string[];
  cycleDetected: number;
  depthLimitReached: number;
}

export interface RequestTerminalTransitionResult {
  ok: boolean;
  message?: string;
  transitioned?: boolean;
  idempotent?: boolean;
}

export class RequestQueue {
  private db: Database;
  private static readonly SELECT_COLUMNS = `
    id,
    sessionId,
    prompt,
    priority,
    queueWaitBudgetMs,
    metadataJson,
    idempotencyKey,
    forceWorker,
    forceLane,
    workerRequired,
    handoffJobId,
    dispatchConfirmationToken,
    dispatchConfirmationExpiresAt,
    dispatchConfirmedAt,
    status,
    agentId,
    claimToken,
    claimGeneration,
    leaseExpiresAt,
    lastHeartbeatAt,
    deferReason,
    claimAttempts,
    result,
    error,
    enqueuedAt,
    claimedAt,
    completedAt,
    failedAt,
    durationMs,
    createdAt,
    updatedAt
  `;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  /**
   * Bun finalizes transient prepared statements during garbage collection.
   * That is normally invisible, but `sqlite3_close_v2` keeps the database and
   * WAL handles alive until those finalizers run. Keep statement ownership
   * synchronous so `close()` is a real lifecycle boundary on Windows too.
   */
  private all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    const statement = this.db.prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.all(...bindings);
    } finally {
      statement.finalize();
    }
  }

  private get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    const statement = this.db.prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.get(...bindings);
    } finally {
      statement.finalize();
    }
  }

  private run(sql: string, ...bindings: SQLQueryBindings[]): Changes {
    const statement = this.db.prepare<unknown, SQLQueryBindings[]>(sql);
    try {
      return statement.run(...bindings);
    } finally {
      statement.finalize();
    }
  }

  private supportsJobOutcomeProjection(): boolean {
    const columns = this.all<{ name: string }>(`PRAGMA table_info(jobs)`);
    const names = new Set(columns.map((column) => column.name));
    return [
      "id",
      "status",
      "failedAt",
      "abandonedAt",
      "publishBlockedAt",
      "completedAt",
      "updatedAt",
    ].every((name) => names.has(name));
  }

  private projectOutcomes(rows: RequestRow[]): RequestRow[] {
    if (rows.length === 0) return [];
    const handoffIds = Array.from(
      new Set(
        rows
          .filter((row) => row.workerRequired === 1)
          .map((row) => asString(row.handoffJobId))
          .filter(Boolean),
      ),
    );
    if (handoffIds.length === 0 || !this.supportsJobOutcomeProjection()) {
      return rows.map((row) => projectRequestOutcome(row, null));
    }

    const placeholders = handoffIds.map(() => "?").join(", ");
    const handoffJobs = this.all<HandoffJobOutcomeRow>(
      `SELECT id, status, failedAt, abandonedAt, publishBlockedAt, completedAt, updatedAt
       FROM jobs
       WHERE id IN (${placeholders})`,
      ...handoffIds,
    );
    const jobsById = new Map(handoffJobs.map((job) => [job.id, job]));
    return rows.map((row) =>
      projectRequestOutcome(row, jobsById.get(asString(row.handoffJobId)) ?? null),
    );
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id               TEXT PRIMARY KEY,
        sessionId        TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        priority         TEXT NOT NULL DEFAULT 'normal',
        queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000,
        metadataJson     TEXT,
        idempotencyKey   TEXT,
        forceWorker      INTEGER NOT NULL DEFAULT 0,
        forceLane        TEXT,
        workerRequired   INTEGER NOT NULL DEFAULT 0,
        handoffJobId     TEXT,
        dispatchConfirmationToken TEXT,
        dispatchConfirmationExpiresAt TEXT,
        dispatchConfirmedAt TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        agentId          TEXT,
        claimToken       TEXT,
        claimGeneration  INTEGER NOT NULL DEFAULT 0,
        leaseExpiresAt   TEXT,
        lastHeartbeatAt  TEXT,
        deferReason      TEXT,
        claimAttempts    INTEGER NOT NULL DEFAULT 0,
        result           TEXT,
        error            TEXT,
        enqueuedAt       TEXT,
        claimedAt        TEXT,
        completedAt      TEXT,
        failedAt         TEXT,
        durationMs       INTEGER,
        createdAt        TEXT NOT NULL,
        updatedAt        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId);
    `);

    const columns = this.all<{ name: string }>(`PRAGMA table_info(requests)`);
    const ensureColumn = (name: string, sql: string) => {
      if (!columns.some((col) => col.name === name)) this.db.exec(sql);
    };

    ensureColumn("prompt", `ALTER TABLE requests ADD COLUMN prompt TEXT NOT NULL DEFAULT '';`);
    ensureColumn(
      "priority",
      `ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`,
    );
    ensureColumn(
      "queueWaitBudgetMs",
      `ALTER TABLE requests ADD COLUMN queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000;`,
    );
    ensureColumn("metadataJson", `ALTER TABLE requests ADD COLUMN metadataJson TEXT;`);
    ensureColumn("idempotencyKey", `ALTER TABLE requests ADD COLUMN idempotencyKey TEXT;`);

    ensureColumn(
      "forceWorker",
      `ALTER TABLE requests ADD COLUMN forceWorker INTEGER NOT NULL DEFAULT 0;`,
    );
    ensureColumn("forceLane", `ALTER TABLE requests ADD COLUMN forceLane TEXT;`);
    ensureColumn(
      "workerRequired",
      `ALTER TABLE requests ADD COLUMN workerRequired INTEGER NOT NULL DEFAULT 0;`,
    );
    ensureColumn("handoffJobId", `ALTER TABLE requests ADD COLUMN handoffJobId TEXT;`);
    ensureColumn(
      "dispatchConfirmationToken",
      `ALTER TABLE requests ADD COLUMN dispatchConfirmationToken TEXT;`,
    );
    ensureColumn(
      "dispatchConfirmationExpiresAt",
      `ALTER TABLE requests ADD COLUMN dispatchConfirmationExpiresAt TEXT;`,
    );
    ensureColumn(
      "dispatchConfirmedAt",
      `ALTER TABLE requests ADD COLUMN dispatchConfirmedAt TEXT;`,
    );
    ensureColumn("claimToken", `ALTER TABLE requests ADD COLUMN claimToken TEXT;`);
    ensureColumn(
      "claimGeneration",
      `ALTER TABLE requests ADD COLUMN claimGeneration INTEGER NOT NULL DEFAULT 0;`,
    );
    ensureColumn("leaseExpiresAt", `ALTER TABLE requests ADD COLUMN leaseExpiresAt TEXT;`);
    ensureColumn("lastHeartbeatAt", `ALTER TABLE requests ADD COLUMN lastHeartbeatAt TEXT;`);
    ensureColumn("deferReason", `ALTER TABLE requests ADD COLUMN deferReason TEXT;`);
    ensureColumn(
      "claimAttempts",
      `ALTER TABLE requests ADD COLUMN claimAttempts INTEGER NOT NULL DEFAULT 0;`,
    );

    ensureColumn("enqueuedAt", `ALTER TABLE requests ADD COLUMN enqueuedAt TEXT;`);
    ensureColumn("claimedAt", `ALTER TABLE requests ADD COLUMN claimedAt TEXT;`);
    ensureColumn("completedAt", `ALTER TABLE requests ADD COLUMN completedAt TEXT;`);
    ensureColumn("failedAt", `ALTER TABLE requests ADD COLUMN failedAt TEXT;`);
    ensureColumn("durationMs", `ALTER TABLE requests ADD COLUMN durationMs INTEGER;`);

    // Column-dependent index is created after legacy column backfills complete.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_priority_created ON requests(status, priority, createdAt);`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idempotency
         ON requests(idempotencyKey)
         WHERE idempotencyKey IS NOT NULL AND idempotencyKey <> '';`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_lease_expiry
         ON requests(status, leaseExpiresAt);`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_dispatch_confirmation
         ON requests(status, dispatchConfirmationExpiresAt, dispatchConfirmedAt);`,
    );

    this.db.exec(`
      UPDATE requests
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        queueWaitBudgetMs = CASE
          WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000
          ELSE queueWaitBudgetMs
        END,
        forceWorker = CASE
          WHEN forceWorker IS NULL THEN 0
          ELSE forceWorker
        END,
        workerRequired = CASE
          WHEN workerRequired IS NULL THEN COALESCE(forceWorker, 0)
          WHEN forceWorker = 1 THEN 1
          ELSE workerRequired
        END,
        claimAttempts = COALESCE(claimAttempts, 0),
        claimGeneration = COALESCE(claimGeneration, 0),
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);

    // A claim without a fencing token cannot be safely distinguished from a
    // stale callback after a same-agent reclaim. Requeue legacy claims so the
    // next owner receives a fresh token and generation.
    const migrationNow = new Date().toISOString();
    this.run(
      `UPDATE requests
       SET status = 'pending',
           agentId = NULL,
           claimToken = NULL,
           claimedAt = NULL,
           leaseExpiresAt = NULL,
           lastHeartbeatAt = NULL,
           deferReason = NULL,
           updatedAt = ?
       WHERE status = 'claimed'
         AND (claimToken IS NULL OR claimToken = '')`,
      migrationNow,
    );
  }

  private pendingOrderedIds(): string[] {
    this.expireUnconfirmedDispatches();
    const rows = this.all<{ id: string }>(
      `SELECT id, priority, createdAt
       FROM requests
       WHERE status = 'pending'
         AND (dispatchConfirmationToken IS NULL OR dispatchConfirmedAt IS NOT NULL)
       ORDER BY
         CASE LOWER(priority)
           WHEN 'interactive' THEN 0
           WHEN 'normal' THEN 1
           WHEN 'background' THEN 2
           ELSE 1
         END ASC,
         createdAt ASC`,
    );
    return rows.map((row) => row.id);
  }

  private queuePosition(requestId: string): number | null {
    const orderedIds = this.pendingOrderedIds();
    const idx = orderedIds.indexOf(requestId);
    if (idx < 0) return null;
    return idx + 1;
  }

  estimateEtaMs(priority: QueuePriority, position: number | null): number | null {
    if (!position || position <= 0) return null;
    const slotMs = PRIORITY_SLA_MS[priority];
    return Math.max(0, slotMs * (position - 1));
  }

  /**
   * Enqueue a new request from LocalBuddy.
   * Priority queue ordering:
   * interactive > normal > background.
   */
  enqueue(body: Record<string, unknown>): {
    ok: boolean;
    requestId?: string;
    queuePosition?: number;
    etaMs?: number;
    dispatchConfirmationRequired?: boolean;
    dispatchConfirmationToken?: string;
    dispatchConfirmationExpiresAt?: string;
    dispatchConfirmed?: boolean;
    deduplicated?: boolean;
    requeued?: boolean;
    message?: string;
  } {
    const sessionId = String(body.sessionId ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    const priority = normalizePriority(body.priority);
    const queueWaitBudgetMs = parseBudgetMs(body.queueWaitBudgetMs, PRIORITY_SLA_MS[priority]);

    // Optional overrides (for RemoteBuddy)
    const forceWorker = body.forceWorker === true ? 1 : 0;
    const rawLane = typeof body.forceLane === "string" ? body.forceLane.trim().toLowerCase() : "";
    const forceLane = rawLane === "deterministic" || rawLane === "worker" ? rawLane : null;
    const metadataSource = body.metadata ?? body.meta;
    const metadataParsed = sanitizeRequestMetadata(metadataSource);
    if (metadataParsed.error) {
      return { ok: false, message: metadataParsed.error };
    }
    const metadataJson = metadataParsed.metadata ? JSON.stringify(metadataParsed.metadata) : null;
    const idempotencyKeyRaw = asString(body.idempotencyKey ?? body.idempotency_key);
    const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 256) : null;

    if (!sessionId || !prompt) {
      return { ok: false, message: "sessionId and prompt are required" };
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const dispatchConfirmationRequired = body.dispatchConfirmationRequired === true;
    const dispatchConfirmationToken = dispatchConfirmationRequired ? randomUUID() : null;
    const dispatchConfirmationExpiresAt = dispatchConfirmationRequired
      ? resolveDispatchConfirmationExpiresAt(body, nowMs)
      : null;
    this.expireUnconfirmedDispatches(now);

    if (idempotencyKey) {
      const existing = this.get<{
        id: string;
        priority: QueuePriority;
        status: RequestStatus;
        dispatchConfirmationToken: string | null;
        dispatchConfirmationExpiresAt: string | null;
        dispatchConfirmedAt: string | null;
      }>(
        `SELECT id, priority, status, dispatchConfirmationToken,
                dispatchConfirmationExpiresAt, dispatchConfirmedAt
         FROM requests
         WHERE idempotencyKey = ?
         ORDER BY createdAt DESC
         LIMIT 1`,
        idempotencyKey,
      );
      if (existing?.id) {
        if (existing.status === "failed") {
          const reopened = this.run(
            `UPDATE requests
             SET sessionId = ?,
                 prompt = ?,
                 priority = ?,
                 queueWaitBudgetMs = ?,
                 metadataJson = ?,
                 forceWorker = ?,
                 forceLane = ?,
                 workerRequired = ?,
                 handoffJobId = NULL,
                 dispatchConfirmationToken = ?,
                 dispatchConfirmationExpiresAt = ?,
                 dispatchConfirmedAt = NULL,
                 status = 'pending',
                 agentId = NULL,
                 claimToken = NULL,
                 result = NULL,
                 error = NULL,
                 enqueuedAt = ?,
                 claimedAt = NULL,
                 leaseExpiresAt = NULL,
                 lastHeartbeatAt = NULL,
                 completedAt = NULL,
                 failedAt = NULL,
                 durationMs = NULL,
                 updatedAt = ?
             WHERE id = ? AND status = 'failed'`,
            sessionId,
            prompt,
            priority,
            queueWaitBudgetMs,
            metadataJson,
            forceWorker,
            forceLane,
            forceWorker,
            dispatchConfirmationToken,
            dispatchConfirmationExpiresAt,
            now,
            now,
            existing.id,
          );
          if (reopened.changes > 0) {
            const queuePosition = this.queuePosition(existing.id);
            const etaMs = this.estimateEtaMs(priority, queuePosition);
            return {
              ok: true,
              requestId: existing.id,
              queuePosition: queuePosition ?? undefined,
              etaMs: etaMs ?? undefined,
              ...(dispatchConfirmationRequired && dispatchConfirmationToken
                ? {
                    dispatchConfirmationRequired: true,
                    dispatchConfirmationToken,
                    dispatchConfirmationExpiresAt: dispatchConfirmationExpiresAt ?? undefined,
                  }
                : {}),
              requeued: true,
            };
          }
        }
        if (
          dispatchConfirmationRequired &&
          existing.status === "pending" &&
          !existing.dispatchConfirmationToken &&
          !existing.dispatchConfirmedAt &&
          dispatchConfirmationToken
        ) {
          const upgraded = this.run(
            `UPDATE requests
             SET dispatchConfirmationToken = ?,
                 dispatchConfirmationExpiresAt = ?,
                 updatedAt = ?
             WHERE id = ?
               AND status = 'pending'
               AND dispatchConfirmationToken IS NULL
               AND dispatchConfirmedAt IS NULL`,
            dispatchConfirmationToken,
            dispatchConfirmationExpiresAt,
            now,
            existing.id,
          );
          if (upgraded.changes > 0) {
            return {
              ok: true,
              requestId: existing.id,
              dispatchConfirmationRequired: true,
              dispatchConfirmationToken,
              dispatchConfirmationExpiresAt: dispatchConfirmationExpiresAt ?? undefined,
              deduplicated: true,
            };
          }
        }
        const queuePosition =
          existing.status === "pending" ? this.queuePosition(existing.id) : null;
        const etaMs = this.estimateEtaMs(normalizePriority(existing.priority), queuePosition);
        return {
          ok: true,
          requestId: existing.id,
          queuePosition: queuePosition ?? undefined,
          etaMs: etaMs ?? undefined,
          ...(existing.dispatchConfirmedAt ? { dispatchConfirmed: true } : {}),
          ...(existing.status === "pending" &&
          existing.dispatchConfirmationToken &&
          !existing.dispatchConfirmedAt
            ? {
                dispatchConfirmationRequired: true,
                dispatchConfirmationToken: existing.dispatchConfirmationToken,
                dispatchConfirmationExpiresAt: existing.dispatchConfirmationExpiresAt ?? undefined,
              }
            : {}),
          deduplicated: true,
        };
      }
    }

    const requestId = randomUUID();

    this.run(
      `INSERT INTO requests (
        id, sessionId, prompt, priority, queueWaitBudgetMs, metadataJson, idempotencyKey, forceWorker, forceLane,
        workerRequired, handoffJobId, dispatchConfirmationToken, dispatchConfirmationExpiresAt,
        dispatchConfirmedAt, status, agentId, claimToken, claimGeneration, leaseExpiresAt, lastHeartbeatAt, claimAttempts, result, error,
        enqueuedAt, claimedAt, completedAt, failedAt, durationMs, createdAt, updatedAt
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'pending', NULL, NULL, 0, NULL, NULL, 0, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      requestId,
      sessionId,
      prompt,
      priority,
      queueWaitBudgetMs,
      metadataJson,
      idempotencyKey,
      forceWorker,
      forceLane,
      forceWorker,
      dispatchConfirmationToken,
      dispatchConfirmationExpiresAt,
      now,
      now,
      now,
    );

    const queuePosition = this.queuePosition(requestId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);

    return {
      ok: true,
      requestId,
      queuePosition: queuePosition ?? undefined,
      etaMs: etaMs ?? undefined,
      ...(dispatchConfirmationRequired && dispatchConfirmationToken
        ? {
            dispatchConfirmationRequired: true,
            dispatchConfirmationToken,
            dispatchConfirmationExpiresAt: dispatchConfirmationExpiresAt ?? undefined,
          }
        : {}),
    };
  }

  expireUnconfirmedDispatches(nowInput: string | Date = new Date()): {
    expired: number;
    requestIds: string[];
  } {
    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const now = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
    const rows = this.all<{ id: string }>(
      `SELECT id
       FROM requests
       WHERE status = 'pending'
         AND dispatchConfirmationToken IS NOT NULL
         AND dispatchConfirmedAt IS NULL
         AND (
           dispatchConfirmationExpiresAt IS NULL
           OR dispatchConfirmationExpiresAt <= ?
         )
       ORDER BY createdAt ASC`,
      now,
    );
    if (rows.length === 0) return { expired: 0, requestIds: [] };
    const result = this.run(
      `UPDATE requests
       SET status = 'failed',
           error = ?,
           failedAt = ?,
           completedAt = NULL,
           durationMs = MAX(
             0,
             CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)
           ),
           updatedAt = ?
       WHERE status = 'pending'
         AND dispatchConfirmationToken IS NOT NULL
         AND dispatchConfirmedAt IS NULL
         AND (
           dispatchConfirmationExpiresAt IS NULL
           OR dispatchConfirmationExpiresAt <= ?
         )`,
      JSON.stringify({
        message: "Autonomy dispatch confirmation expired",
        detail: "dispatch_confirmation_expired",
      }),
      now,
      now,
      now,
      now,
    );
    return {
      expired: result.changes,
      requestIds: rows.slice(0, result.changes).map((row) => row.id),
    };
  }

  confirmDispatch(
    requestIdRaw: string,
    confirmationTokenRaw: string,
    nowInput: string | Date = new Date(),
  ): {
    ok: boolean;
    requestId?: string;
    confirmed?: boolean;
    idempotent?: boolean;
    message?: string;
  } {
    const requestId = asString(requestIdRaw);
    const confirmationToken = asString(confirmationTokenRaw);
    if (!requestId) return { ok: false, message: "requestId is required" };
    if (!confirmationToken) {
      return { ok: false, message: "dispatchConfirmationToken is required" };
    }
    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const now = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();

    const updated = this.run(
      `UPDATE requests
       SET dispatchConfirmedAt = ?, updatedAt = ?
       WHERE id = ?
         AND status = 'pending'
         AND dispatchConfirmationToken = ?
         AND dispatchConfirmedAt IS NULL
         AND dispatchConfirmationExpiresAt IS NOT NULL
         AND dispatchConfirmationExpiresAt > ?`,
      now,
      now,
      requestId,
      confirmationToken,
      now,
    );
    if (updated.changes > 0) {
      return { ok: true, requestId, confirmed: true, idempotent: false };
    }

    const current = this.get<{
      status: RequestStatus;
      dispatchConfirmationToken: string | null;
      dispatchConfirmationExpiresAt: string | null;
      dispatchConfirmedAt: string | null;
    }>(
      `SELECT status, dispatchConfirmationToken, dispatchConfirmationExpiresAt,
              dispatchConfirmedAt
       FROM requests
       WHERE id = ?`,
      requestId,
    );
    if (!current) return { ok: false, message: "Request not found" };
    if (current.dispatchConfirmationToken !== confirmationToken) {
      return { ok: false, message: "Dispatch confirmation token is invalid" };
    }
    if (current.dispatchConfirmedAt) {
      return { ok: true, requestId, confirmed: true, idempotent: true };
    }
    this.expireUnconfirmedDispatches(now);
    if (
      current.status === "pending" &&
      (!current.dispatchConfirmationExpiresAt || current.dispatchConfirmationExpiresAt <= now)
    ) {
      return { ok: false, message: "Dispatch confirmation expired" };
    }
    return { ok: false, message: `Request cannot be confirmed from status ${current.status}` };
  }

  /**
   * Atomically claim the next pending request.
   * Ordering: priority asc (interactive first), then FIFO by createdAt.
   */
  claim(
    agentIdRaw: string,
    options: { leaseMs?: number } = {},
  ): {
    ok: boolean;
    request?: RequestRow;
    queueWaitMs?: number;
    message?: string;
  } {
    const now = new Date().toISOString();
    const agentId = String(agentIdRaw ?? "").trim();
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(
      Date.parse(now) + normalizeRequestLeaseMs(options.leaseMs),
    ).toISOString();

    // A task.execute job is the durable planning handoff. Close any expired
    // crash window before requeueing/claiming the request so a replacement
    // planner cannot dispatch the same user request a second time.
    this.expireUnconfirmedDispatches(now);
    this.reconcileWorkerHandoffsFromJobs(now);

    const tx = this.db.transaction(() => {
      this.recoverExpiredClaims(now);
      const row = this.get<RequestRow>(
        `SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         WHERE status = 'pending'
           AND (dispatchConfirmationToken IS NULL OR dispatchConfirmedAt IS NOT NULL)
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC
         LIMIT 1`,
      );

      if (!row) return null;

      this.run(
        `UPDATE requests
         SET status = 'claimed',
             agentId = ?,
             claimToken = ?,
             claimGeneration = COALESCE(claimGeneration, 0) + 1,
             claimedAt = ?,
             leaseExpiresAt = ?,
             lastHeartbeatAt = ?,
             deferReason = NULL,
             claimAttempts = COALESCE(claimAttempts, 0) + 1,
             completedAt = NULL,
             failedAt = NULL,
             durationMs = NULL,
             updatedAt = ?
         WHERE id = ?`,
        agentId,
        claimToken,
        now,
        leaseExpiresAt,
        now,
        now,
        row.id,
      );

      const queueWaitMs = Math.max(
        0,
        Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0),
      );

      return {
        request: {
          ...row,
          metadata: parseMetadataJson(row.metadataJson),
          dispatchConfirmationToken: null,
          status: "claimed" as RequestStatus,
          agentId,
          claimToken,
          claimGeneration: Number(row.claimGeneration ?? 0) + 1,
          claimedAt: now,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          deferReason: null,
          claimAttempts: Number(row.claimAttempts ?? 0) + 1,
          completedAt: null,
          failedAt: null,
          durationMs: null,
          updatedAt: now,
        },
        queueWaitMs,
      };
    });

    const claimed = tx();
    if (!claimed) return { ok: false, message: "No pending requests" };
    return { ok: true, request: claimed.request, queueWaitMs: claimed.queueWaitMs };
  }

  renewLease(
    requestId: string,
    agentIdRaw: string,
    claimTokenRaw: string,
    options: { leaseMs?: number } = {},
  ): { ok: boolean; leaseExpiresAt?: string; message?: string } {
    const agentId = String(agentIdRaw ?? "").trim();
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!claimToken) return { ok: false, message: "claimToken is required" };
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(
      Date.parse(now) + normalizeRequestLeaseMs(options.leaseMs),
    ).toISOString();
    const result = this.run(
      `UPDATE requests
       SET lastHeartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
       WHERE id = ?
         AND status = 'claimed'
         AND agentId = ?
         AND claimToken = ?
         AND leaseExpiresAt IS NOT NULL
         AND leaseExpiresAt > ?`,
      now,
      leaseExpiresAt,
      now,
      requestId,
      agentId,
      claimToken,
      now,
    );
    if (result.changes === 0) {
      return {
        ok: false,
        message: "Request lease is missing, expired, or owned by another agent",
      };
    }
    return { ok: true, leaseExpiresAt };
  }

  /**
   * Keep a claimed request nonterminal while a temporary admission circuit is
   * open. The claim remains unavailable until ordinary stale-claim recovery
   * requeues it. Only the current fenced owner can defer a claim, and the
   * delay is bounded so a circuit cannot strand work indefinitely.
   */
  deferClaim(
    requestId: string,
    agentIdRaw: string,
    claimTokenRaw: string,
    retryAfterMsRaw: number,
    options: { reason?: string } = {},
  ): {
    ok: boolean;
    retryAfterMs?: number;
    deferredUntil?: string;
    message?: string;
  } {
    const agentId = String(agentIdRaw ?? "").trim();
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!claimToken) return { ok: false, message: "claimToken is required" };
    const parsedRetryAfterMs = Number(retryAfterMsRaw);
    const retryAfterMs = Math.max(
      MIN_REQUEST_DEFER_MS,
      Math.min(
        options.reason === "worker_runtime_circuit_open"
          ? MAX_RUNTIME_CIRCUIT_RECHECK_MS
          : MAX_REQUEST_DEFER_MS,
        Number.isFinite(parsedRetryAfterMs) ? Math.floor(parsedRetryAfterMs) : MIN_REQUEST_DEFER_MS,
      ),
    );
    const now = new Date().toISOString();
    const deferredUntil = new Date(Date.parse(now) + retryAfterMs).toISOString();
    const deferReason = String(options.reason ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const result = this.run(
      `UPDATE requests
       SET leaseExpiresAt = ?,
           lastHeartbeatAt = ?,
           deferReason = ?,
           updatedAt = ?
       WHERE id = ?
         AND status = 'claimed'
         AND agentId = ?
         AND claimToken = ?
         AND leaseExpiresAt IS NOT NULL
         AND leaseExpiresAt > ?`,
      deferredUntil,
      now,
      deferReason || null,
      now,
      requestId,
      agentId,
      claimToken,
      now,
    );
    if (result.changes === 0) {
      return {
        ok: false,
        message: "Request is not claimed with an active lease owned by this agent",
      };
    }
    return { ok: true, retryAfterMs, deferredUntil };
  }

  validateActiveLease(
    requestId: string,
    agentIdRaw: string,
    claimTokenRaw: string,
    nowInput: string | Date = new Date(),
  ): { ok: boolean; message?: string } {
    const agentId = String(agentIdRaw ?? "").trim();
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!claimToken) return { ok: false, message: "claimToken is required" };
    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const nowMs = parsed.getTime();
    const request = this.getRequest(requestId);
    if (!request || request.status !== "claimed") {
      return { ok: false, message: "Request is not claimed" };
    }
    if (request.agentId !== agentId) {
      return { ok: false, message: "Request lease is owned by another agent" };
    }
    if (request.claimToken !== claimToken) {
      return { ok: false, message: "Request claim token is stale" };
    }
    const leaseExpiresAtMs = Date.parse(String(request.leaseExpiresAt ?? ""));
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(leaseExpiresAtMs) ||
      leaseExpiresAtMs <= nowMs
    ) {
      return { ok: false, message: "Request lease is missing or expired" };
    }
    return { ok: true };
  }

  recoverExpiredClaims(nowInput: string | Date = new Date()): {
    recovered: number;
    requestIds: string[];
  } {
    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const now = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
    const rows = this.all<{ id: string }>(
      `SELECT id FROM requests
       WHERE status = 'claimed'
         AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
       ORDER BY createdAt ASC`,
      now,
    );
    if (rows.length === 0) return { recovered: 0, requestIds: [] };
    const result = this.run(
      `UPDATE requests
       SET status = 'pending',
           agentId = NULL,
           claimToken = NULL,
           claimedAt = NULL,
           leaseExpiresAt = NULL,
           lastHeartbeatAt = NULL,
           deferReason = NULL,
           updatedAt = ?
       WHERE status = 'claimed'
         AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
      now,
      now,
    );
    return {
      recovered: result.changes,
      requestIds: rows.slice(0, result.changes).map((row) => row.id),
    };
  }

  shortenWorkerRuntimeCircuitDeferredClaims(
    options: {
      maxDelayMs?: number;
      nowMs?: number;
      limit?: number;
      includeLegacyAutonomyClaims?: boolean;
    } = {},
  ): {
    shortened: number;
    requestIds: string[];
    unreportedRequestIds: number;
    deferredUntil: string;
  } {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const maxDelayMs = Math.max(
      MIN_REQUEST_DEFER_MS,
      Math.min(
        MAX_RUNTIME_CIRCUIT_RECHECK_MS,
        Math.floor(options.maxDelayMs ?? MAX_RUNTIME_CIRCUIT_RECHECK_MS),
      ),
    );
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 500)));
    const includeLegacyAutonomyClaims = options.includeLegacyAutonomyClaims !== false;
    const now = new Date(nowMs).toISOString();
    const deferredUntil = new Date(nowMs + maxDelayMs).toISOString();
    const shorten = this.db.transaction(() => {
      // Report only a bounded ID sample while shortening the complete durable
      // set in SQLite. Restart recovery must not strand row limit + 1 behind a
      // legacy long lease.
      const rows = this.all<{ id: string }>(
        `SELECT id
         FROM requests
         WHERE status = 'claimed'
           AND (
             deferReason = 'worker_runtime_circuit_open'
             OR (
               ? = 1
               AND deferReason IS NULL
               AND json_valid(metadataJson)
               AND json_extract(metadataJson, '$.origin') = 'autonomy'
             )
           )
           AND leaseExpiresAt > ?
         ORDER BY updatedAt ASC, createdAt ASC
         LIMIT ?`,
        includeLegacyAutonomyClaims ? 1 : 0,
        deferredUntil,
        limit,
      );
      if (rows.length === 0) {
        return {
          shortened: 0,
          requestIds: [],
          unreportedRequestIds: 0,
          deferredUntil,
        };
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      const reportedRows = this.all<{ id: string }>(
        `UPDATE requests
         SET leaseExpiresAt = ?, updatedAt = ?
         WHERE id IN (${placeholders})
           AND status = 'claimed'
           AND leaseExpiresAt > ?
         RETURNING id`,
        deferredUntil,
        now,
        ...ids,
        deferredUntil,
      );
      const unreported = this.run(
        `UPDATE requests
         SET leaseExpiresAt = ?, updatedAt = ?
         WHERE status = 'claimed'
           AND (
             deferReason = 'worker_runtime_circuit_open'
             OR (
               ? = 1
               AND deferReason IS NULL
               AND json_valid(metadataJson)
               AND json_extract(metadataJson, '$.origin') = 'autonomy'
             )
           )
           AND leaseExpiresAt > ?`,
        deferredUntil,
        now,
        includeLegacyAutonomyClaims ? 1 : 0,
        deferredUntil,
      );
      return {
        shortened: reportedRows.length + unreported.changes,
        requestIds: reportedRows.map((row) => row.id),
        unreportedRequestIds: unreported.changes,
        deferredUntil,
      };
    });
    return shorten();
  }

  releaseWorkerRuntimeCircuitDeferredClaims(nowMs = Date.now()): {
    released: number;
    requestIds: string[];
  } {
    const now = new Date(nowMs).toISOString();
    const rows = this.all<{ id: string }>(
      `SELECT id
       FROM requests
       WHERE status = 'claimed'
         AND deferReason = 'worker_runtime_circuit_open'
       ORDER BY updatedAt ASC, createdAt ASC
       LIMIT 1000`,
    );
    if (rows.length === 0) return { released: 0, requestIds: [] };
    const result = this.run(
      `UPDATE requests
       SET leaseExpiresAt = ?, deferReason = NULL, updatedAt = ?
       WHERE status = 'claimed'
         AND deferReason = 'worker_runtime_circuit_open'`,
      now,
      now,
    );
    return {
      released: result.changes,
      requestIds: rows.slice(0, result.changes).map((row) => row.id),
    };
  }

  /**
   * Repair durable requests persisted by older runtimes before retry-safe stale
   * recovery atomically repointed request handoffs. Only abandoned handoffs
   * with a deterministic successor are candidates. Traversal is bounded and
   * cycle-safe so corrupt legacy metadata cannot stall startup or the periodic
   * lifecycle watchdog.
   */
  reconcileRecoveredWorkerHandoffChains(options?: {
    maxRequests?: number;
    maxDepth?: number;
  }): RequestHandoffChainReconciliationResult {
    const emptyResult = (): RequestHandoffChainReconciliationResult => ({
      scanned: 0,
      repointed: 0,
      requestIds: [],
      previousJobIds: [],
      replacementJobIds: [],
      cycleDetected: 0,
      depthLimitReached: 0,
    });
    const jobColumns = this.all<{ name: string }>(`PRAGMA table_info(jobs)`);
    const requiredJobColumns = ["id", "status", "resumeOfJobId", "attempt", "createdAt"];
    const jobColumnNames = new Set(jobColumns.map((column) => column.name));
    if (!requiredJobColumns.every((name) => jobColumnNames.has(name))) return emptyResult();

    const requestedMaxRequests = Number(options?.maxRequests);
    const requestedMaxDepth = Number(options?.maxDepth);
    const maxRequests = Number.isFinite(requestedMaxRequests)
      ? Math.max(1, Math.min(MAX_HANDOFF_CHAIN_RECONCILE_LIMIT, Math.floor(requestedMaxRequests)))
      : DEFAULT_HANDOFF_CHAIN_RECONCILE_LIMIT;
    const maxDepth = Number.isFinite(requestedMaxDepth)
      ? Math.max(1, Math.min(MAX_HANDOFF_CHAIN_DEPTH, Math.floor(requestedMaxDepth)))
      : DEFAULT_HANDOFF_CHAIN_DEPTH;
    const now = new Date().toISOString();

    const reconcile = this.db.transaction((): RequestHandoffChainReconciliationResult => {
      const result = emptyResult();
      const candidates = this.all<{ requestId: string; previousJobId: string }>(
        `SELECT r.id AS requestId, r.handoffJobId AS previousJobId
         FROM requests r
         JOIN jobs currentJob ON currentJob.id = r.handoffJobId
         WHERE r.workerRequired = 1
           AND r.handoffJobId IS NOT NULL
           AND currentJob.status = 'abandoned'
           AND EXISTS (
             SELECT 1
             FROM jobs successor
             WHERE successor.resumeOfJobId = currentJob.id
           )
         ORDER BY r.createdAt ASC, r.id ASC
         LIMIT ?`,
        maxRequests,
      );
      result.scanned = candidates.length;
      if (candidates.length === 0) return result;

      const nextSuccessor = this.db.prepare<{ id: string; status: string }, [string]>(
        `SELECT id, status
         FROM jobs
         WHERE resumeOfJobId = ?
         ORDER BY attempt DESC, createdAt DESC, id DESC
         LIMIT 1`,
      );
      const repoint = this.db.prepare<unknown, [string, string, string, string]>(
        `UPDATE requests
         SET handoffJobId = ?, updatedAt = ?
         WHERE id = ?
           AND workerRequired = 1
           AND handoffJobId = ?`,
      );

      try {
        for (const candidate of candidates) {
          const visited = new Set([candidate.previousJobId]);
          let currentJobId = candidate.previousJobId;
          let currentStatus = "abandoned";
          let traversed = 0;
          let invalidChain = false;

          while (currentStatus === "abandoned") {
            const successor = nextSuccessor.get(currentJobId);
            if (!successor) break;
            if (visited.has(successor.id)) {
              result.cycleDetected += 1;
              invalidChain = true;
              break;
            }
            if (traversed >= maxDepth) {
              result.depthLimitReached += 1;
              invalidChain = true;
              break;
            }

            visited.add(successor.id);
            currentJobId = successor.id;
            currentStatus = asString(successor.status).toLowerCase();
            traversed += 1;
          }

          if (invalidChain || traversed === 0) continue;
          const updated = repoint.run(
            currentJobId,
            now,
            candidate.requestId,
            candidate.previousJobId,
          );
          if (updated.changes === 0) continue;
          result.repointed += 1;
          result.requestIds.push(candidate.requestId);
          result.previousJobIds.push(candidate.previousJobId);
          result.replacementJobIds.push(currentJobId);
        }
      } finally {
        nextSuccessor.finalize();
        repoint.finalize();
      }

      return result;
    });

    return reconcile();
  }

  /**
   * Recover requests whose planner created a durable task.execute job but
   * crashed before recording the handoff/completion callbacks. This is kept in
   * RequestQueue (rather than autonomy-only reconciliation) so ordinary user
   * requests receive the same recovery guarantees.
   */
  reconcileWorkerHandoffsFromJobs(
    nowInput: string | Date = new Date(),
  ): RequestHandoffReconciliationResult {
    const jobsTable = this.get<{ present: number }>(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`,
    );
    if (!jobsTable) return { completed: 0, requestIds: [], jobIds: [] };

    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const now = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
    const rows = this.all<{ requestId: string; requestSessionId: string; jobId: string }>(
      `SELECT r.id AS requestId,
              r.sessionId AS requestSessionId,
              j.id AS jobId
       FROM requests r
       JOIN jobs j ON j.id = (
         SELECT candidate.id
         FROM jobs candidate
         WHERE candidate.kind = 'task.execute'
           AND candidate.sessionId = r.sessionId
           AND json_valid(candidate.params)
           AND json_extract(candidate.params, '$.requestId') = r.id
           AND datetime(candidate.createdAt) >= datetime(COALESCE(r.enqueuedAt, r.createdAt))
         ORDER BY candidate.createdAt DESC, candidate.id DESC
         LIMIT 1
       )
       WHERE (
            r.status = 'pending'
            OR (
            r.status = 'claimed'
            AND (r.leaseExpiresAt IS NULL OR r.leaseExpiresAt <= ?)
            )
          )
         AND (r.dispatchConfirmationToken IS NULL OR r.dispatchConfirmedAt IS NOT NULL)
       ORDER BY r.createdAt ASC
       LIMIT 400`,
      now,
    );
    if (rows.length === 0) return { completed: 0, requestIds: [], jobIds: [] };

    const requestIds: string[] = [];
    const jobIds: string[] = [];
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const updated = this.run(
          `UPDATE requests
           SET workerRequired = 1,
               handoffJobId = ?,
               status = 'completed',
               result = CASE
                 WHEN result IS NULL OR result = '' THEN ?
                 ELSE result
               END,
               completedAt = COALESCE(completedAt, ?),
               failedAt = NULL,
               leaseExpiresAt = NULL,
               lastHeartbeatAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ?
             AND sessionId = ?
             AND (
               (
                 status = 'pending'
                 OR (
                 status = 'claimed'
                 AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
                 )
               )
               AND (dispatchConfirmationToken IS NULL OR dispatchConfirmedAt IS NOT NULL)
             )`,
          row.jobId,
          JSON.stringify({
            requiresWorker: true,
            jobId: row.jobId,
            reconciledAfterCrash: true,
          }),
          now,
          now,
          now,
          row.requestId,
          row.requestSessionId,
          now,
        );
        if (updated.changes === 0) continue;
        requestIds.push(row.requestId);
        jobIds.push(row.jobId);
      }
    });
    tx();
    return { completed: requestIds.length, requestIds, jobIds };
  }

  recordWorkerHandoff(
    requestId: string,
    jobIdRaw: string,
    agentIdRaw: string,
    claimTokenRaw: string,
  ): { ok: boolean; message?: string } {
    const jobId = String(jobIdRaw ?? "").trim();
    const agentId = String(agentIdRaw ?? "").trim();
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!jobId) return { ok: false, message: "jobId is required" };
    if (!agentId) return { ok: false, message: "agentId is required" };
    if (!claimToken) return { ok: false, message: "claimToken is required" };
    const now = new Date().toISOString();
    const result = this.run(
      `UPDATE requests
       SET workerRequired = 1,
           handoffJobId = ?,
           updatedAt = ?
       WHERE id = ?
         AND status = 'claimed'
         AND agentId = ?
         AND claimToken = ?
         AND leaseExpiresAt IS NOT NULL
         AND leaseExpiresAt > ?`,
      jobId,
      now,
      requestId,
      agentId,
      claimToken,
      now,
    );
    if (result.changes === 0) {
      return {
        ok: false,
        message: "Request is not claimed with an active lease owned by this agent",
      };
    }
    return { ok: true };
  }

  /**
   * Mark a request as completed.
   */
  complete(requestId: string, body: Record<string, unknown>): RequestTerminalTransitionResult {
    const now = new Date().toISOString();
    const result = body.result ? JSON.stringify(body.result) : null;
    const agentId = asString(body.agentId);
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = asString(body.claimToken);
    if (!claimToken) return { ok: false, message: "claimToken is required" };

    const current = this.getRequest(requestId);
    if (!current) return { ok: false, message: "Request not found" };
    if (current.status === "completed") {
      if (current.agentId === agentId && current.claimToken === claimToken) {
        return { ok: true, transitioned: false, idempotent: true };
      }
      return { ok: false, message: "Request completion token is stale or owned by another agent" };
    }

    const info = this.run(
      `UPDATE requests
       SET status = 'completed',
            result = ?,
            completedAt = ?,
            failedAt = NULL,
            leaseExpiresAt = NULL,
            lastHeartbeatAt = NULL,
            deferReason = NULL,
           durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
           updatedAt = ?
       WHERE id = ?
         AND status = 'claimed'
         AND leaseExpiresAt IS NOT NULL
         AND leaseExpiresAt > ?
         AND agentId = ?
         AND claimToken = ?`,
      result,
      now,
      now,
      now,
      requestId,
      now,
      agentId,
      claimToken,
    );

    if (info.changes === 0) {
      return {
        ok: false,
        message: "Request is not claimed with an active lease owned by this agent",
      };
    }

    return { ok: true, transitioned: true };
  }

  /**
   * Mark a request as failed.
   */
  fail(requestId: string, body: Record<string, unknown>): RequestTerminalTransitionResult {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);
    const agentId = asString(body.agentId);
    if (!agentId) return { ok: false, message: "agentId is required" };
    const claimToken = asString(body.claimToken);
    if (!claimToken) return { ok: false, message: "claimToken is required" };

    const current = this.getRequest(requestId);
    if (!current) return { ok: false, message: "Request not found" };
    if (current.status === "failed") {
      if (current.agentId === agentId && current.claimToken === claimToken) {
        return { ok: true, transitioned: false, idempotent: true };
      }
      return { ok: false, message: "Request failure token is stale or owned by another agent" };
    }

    const info = this.run(
      `UPDATE requests
       SET status = 'failed',
            error = ?,
            failedAt = ?,
            completedAt = NULL,
            leaseExpiresAt = NULL,
            lastHeartbeatAt = NULL,
            deferReason = NULL,
           durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
           updatedAt = ?
       WHERE id = ?
         AND status = 'claimed'
         AND leaseExpiresAt IS NOT NULL
         AND leaseExpiresAt > ?
         AND agentId = ?
         AND claimToken = ?`,
      JSON.stringify({ message, detail }),
      now,
      now,
      now,
      requestId,
      now,
      agentId,
      claimToken,
    );

    if (info.changes === 0) {
      return {
        ok: false,
        message: "Request is not claimed with an active lease owned by this agent",
      };
    }

    return { ok: true, transitioned: true };
  }

  getRequest(requestId: string): RequestRow | null {
    const row = this.get<RequestRow>(
      `SELECT ${RequestQueue.SELECT_COLUMNS} FROM requests WHERE id = ?`,
      requestId,
    );
    if (!row) return null;
    return (
      this.projectOutcomes([{ ...row, metadata: parseMetadataJson(row.metadataJson) }])[0] ?? null
    );
  }

  getPendingRequests(): RequestRow[] {
    this.expireUnconfirmedDispatches();
    const rows = this.all<RequestRow>(
      `SELECT ${RequestQueue.SELECT_COLUMNS}
       FROM requests
       WHERE status = 'pending'
         AND (dispatchConfirmationToken IS NULL OR dispatchConfirmedAt IS NOT NULL)
       ORDER BY
         CASE LOWER(priority)
           WHEN 'interactive' THEN 0
           WHEN 'normal' THEN 1
           WHEN 'background' THEN 2
           ELSE 1
          END ASC,
          createdAt ASC`,
    );
    return rows.map((row) => ({
      ...row,
      metadata: parseMetadataJson(row.metadataJson),
      dispatchConfirmationToken: null,
    }));
  }

  listRequests(options?: { status?: RequestStatus | "all"; limit?: number }): RequestRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      const rows = this.all<RequestRow>(
        `SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         ORDER BY createdAt DESC
         LIMIT ?`,
        limit,
      );
      return this.projectOutcomes(
        rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) })),
      );
    }

    const rows = this.all<RequestRow>(
      `SELECT ${RequestQueue.SELECT_COLUMNS}
       FROM requests
       WHERE status = ?
       ORDER BY createdAt DESC
       LIMIT ?`,
      status,
      limit,
    );
    return this.projectOutcomes(
      rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) })),
    );
  }

  countByStatus(): Record<RequestStatus, number> {
    this.expireUnconfirmedDispatches();
    const rows = this.all<{ status: RequestStatus; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM requests
       WHERE status <> 'pending'
          OR dispatchConfirmationToken IS NULL
          OR dispatchConfirmedAt IS NOT NULL
       GROUP BY status`,
    );

    const counts: Record<RequestStatus, number> = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = Number(row.count || 0);
    }
    return counts;
  }

  countByPriority(): Record<QueuePriority, number> {
    const rows = this.all<{ priority: string; count: number }>(
      `SELECT priority, COUNT(*) AS count
       FROM requests
       WHERE status IN ('pending', 'claimed')
         AND (
           status <> 'pending'
           OR dispatchConfirmationToken IS NULL
           OR dispatchConfirmedAt IS NOT NULL
         )
       GROUP BY priority`,
    );

    const counts: Record<QueuePriority, number> = {
      interactive: 0,
      normal: 0,
      background: 0,
    };
    for (const row of rows) {
      const priority = normalizePriority(row.priority);
      counts[priority] = Number(row.count || 0);
    }
    return counts;
  }

  countAutonomyRequests(statuses: Array<RequestStatus> = ["pending", "claimed"]): number {
    const normalized = Array.from(
      new Set(
        statuses
          .map((status) =>
            String(status ?? "")
              .trim()
              .toLowerCase(),
          )
          .filter(
            (status): status is RequestStatus =>
              status === "pending" ||
              status === "claimed" ||
              status === "completed" ||
              status === "failed",
          ),
      ),
    );
    if (normalized.length === 0) return 0;
    const placeholders = normalized.map(() => "?").join(", ");
    const rows = this.all<{ metadataJson: string | null }>(
      `SELECT metadataJson
       FROM requests
       WHERE status IN (${placeholders})
         AND (
           status <> 'pending'
           OR dispatchConfirmationToken IS NULL
           OR dispatchConfirmedAt IS NOT NULL
         )
         AND metadataJson IS NOT NULL
         AND metadataJson <> ''`,
      ...normalized,
    );

    let count = 0;
    for (const row of rows) {
      const metadata = parseMetadataJson(row.metadataJson);
      if (isAutonomyMetadata(metadata)) count += 1;
    }
    return count;
  }

  /** Durable work already available to probe an open WorkerPal runtime circuit. */
  countWorkerRuntimeProbeRequests(
    options: {
      activeOnly?: boolean;
      excludeRequestId?: string;
      excludeIdempotencyKey?: string;
      nowMs?: number;
    } = {},
  ): number {
    const now = new Date(options.nowMs ?? Date.now()).toISOString();
    const rows = this.all<{ metadataJson: string | null }>(
      `SELECT metadataJson FROM requests
       WHERE status IN ('pending', 'claimed')
         AND id <> ?
         AND (? = '' OR COALESCE(idempotencyKey, '') <> ?)
         AND (dispatchConfirmationToken IS NULL OR dispatchConfirmedAt IS NOT NULL
              OR dispatchConfirmationExpiresAt > ?)
         AND (? = 0 OR (status = 'claimed' AND deferReason IS NULL AND leaseExpiresAt > ?))`,
      options.excludeRequestId ?? "",
      options.excludeIdempotencyKey ?? "",
      options.excludeIdempotencyKey ?? "",
      now,
      options.activeOnly ? 1 : 0,
      now,
    );
    // Unconfirmed dispatches count too: admitting another objective during the
    // confirmation round trip would otherwise create an unbounded probe queue.
    return rows.filter((row) => isAutonomyMetadata(parseMetadataJson(row.metadataJson))).length;
  }

  nextPendingSnapshot(
    limit = 10,
  ): Array<{ id: string; priority: QueuePriority; position: number; etaMs: number }> {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.get<{ priority: string }>(`SELECT priority FROM requests WHERE id = ?`, id);
      const priority = normalizePriority(row?.priority);
      return {
        id,
        priority,
        position: idx + 1,
        etaMs: this.estimateEtaMs(priority, idx + 1) ?? 0,
      };
    });
  }

  sloSummary(windowHours = 24): RequestSloSummary {
    const boundedWindowHours =
      Number.isFinite(windowHours) && windowHours > 0
        ? Math.max(1, Math.min(24 * 30, Math.floor(windowHours)))
        : 24;
    const cutoffIso = new Date(Date.now() - boundedWindowHours * 60 * 60 * 1000).toISOString();
    const rows = this.supportsJobOutcomeProjection()
      ? this.all<RequestRow>(
          `SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           WHERE updatedAt >= ?
              OR handoffJobId IN (
                SELECT id
                FROM jobs
                WHERE COALESCE(completedAt, failedAt, abandonedAt, publishBlockedAt, updatedAt) >= ?
              )`,
          cutoffIso,
          cutoffIso,
        )
      : this.all<RequestRow>(
          `SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           WHERE status IN ('completed', 'failed')
             AND updatedAt >= ?`,
          cutoffIso,
        );
    const projectedRows = this.projectOutcomes(rows);

    let completed = 0;
    let failed = 0;
    const durationSamples: number[] = [];
    const queueWaitSamples: number[] = [];

    for (const row of projectedRows) {
      const outcomeUpdatedAt = parseIsoMs(row.outcomeUpdatedAt);
      if (outcomeUpdatedAt == null || outcomeUpdatedAt < Date.parse(cutoffIso)) continue;
      if (row.outcomeStatus === "completed") completed += 1;
      if (row.outcomeStatus === "failed") failed += 1;
      if (row.outcomeStatus !== "completed" && row.outcomeStatus !== "failed") continue;
      if (
        typeof row.outcomeDurationMs === "number" &&
        Number.isFinite(row.outcomeDurationMs) &&
        row.outcomeDurationMs >= 0
      ) {
        durationSamples.push(Math.round(row.outcomeDurationMs));
      }
      const queueStart = parseIsoMs(row.enqueuedAt) ?? parseIsoMs(row.createdAt) ?? null;
      const queueEnd = parseIsoMs(row.claimedAt) ?? parseIsoMs(row.updatedAt) ?? null;
      if (queueStart != null && queueEnd != null && queueEnd >= queueStart) {
        queueWaitSamples.push(queueEnd - queueStart);
      }
    }

    const terminal = completed + failed;
    const successRate = terminal > 0 ? Number((completed / terminal).toFixed(4)) : null;

    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      successRate,
      durationMs: summarizeSamples(durationSamples),
      queueWaitMs: summarizeSamples(queueWaitSamples),
    };
  }

  close(): void {
    // `Database.close()` defaults to `close(false)`, which lets outstanding
    // statements finish after this method returns. That is a poor ownership
    // boundary for a queue: callers reasonably expect `close()` to release the
    // SQLite/WAL handles before they rotate, replace, or remove the database.
    // It is especially observable on Windows, where a deferred handle keeps the
    // parent directory locked. All RequestQueue operations are synchronous, so
    // a pending statement here is a lifecycle bug that should fail visibly.
    this.db.close(true);
  }
}
