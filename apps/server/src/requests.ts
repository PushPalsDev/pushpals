/**
 * Request Queue for routed prompts from LocalBuddy -> RemoteBuddy
 *
 * Flow:
 *   1. LocalBuddy enqueues the routed user request to this queue
 *   2. RemoteBuddy polls and claims requests
 *   3. RemoteBuddy handles deeper planning/context as needed
 *   4. RemoteBuddy processes and marks complete/failed
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  normalizeAutonomyComponentArea,
  validateScopeInvariants,
  type AutonomyComponentArea,
} from "shared";

export type RequestStatus = "pending" | "claimed" | "completed" | "failed";
export type QueuePriority = "interactive" | "normal" | "background";

export const DEFAULT_REQUEST_LEASE_MS = 3 * 60_000;
const MIN_REQUEST_LEASE_MS = 30_000;
const MAX_REQUEST_LEASE_MS = 15 * 60_000;

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
  status: RequestStatus;
  agentId: string | null;
  claimToken: string | null;
  claimGeneration: number;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
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

export interface RequestHandoffReconciliationResult {
  completed: number;
  requestIds: string[];
  jobIds: string[];
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
    status,
    agentId,
    claimToken,
    claimGeneration,
    leaseExpiresAt,
    lastHeartbeatAt,
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
        status           TEXT NOT NULL DEFAULT 'pending',
        agentId          TEXT,
        claimToken       TEXT,
        claimGeneration  INTEGER NOT NULL DEFAULT 0,
        leaseExpiresAt   TEXT,
        lastHeartbeatAt  TEXT,
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

    const columns = this.db.prepare(`PRAGMA table_info(requests)`).all() as Array<{ name: string }>;
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
    ensureColumn("claimToken", `ALTER TABLE requests ADD COLUMN claimToken TEXT;`);
    ensureColumn(
      "claimGeneration",
      `ALTER TABLE requests ADD COLUMN claimGeneration INTEGER NOT NULL DEFAULT 0;`,
    );
    ensureColumn("leaseExpiresAt", `ALTER TABLE requests ADD COLUMN leaseExpiresAt TEXT;`);
    ensureColumn("lastHeartbeatAt", `ALTER TABLE requests ADD COLUMN lastHeartbeatAt TEXT;`);
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
    this.db
      .prepare(
        `UPDATE requests
         SET status = 'pending',
             agentId = NULL,
             claimToken = NULL,
             claimedAt = NULL,
             leaseExpiresAt = NULL,
             lastHeartbeatAt = NULL,
             updatedAt = ?
         WHERE status = 'claimed'
           AND (claimToken IS NULL OR claimToken = '')`,
      )
      .run(migrationNow);
  }

  private pendingOrderedIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id, priority, createdAt
         FROM requests
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
      .all() as Array<{ id: string }>;
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

    if (idempotencyKey) {
      const existing = this.db
        .prepare(
          `SELECT id, priority, status
           FROM requests
           WHERE idempotencyKey = ?
           ORDER BY createdAt DESC
           LIMIT 1`,
        )
        .get(idempotencyKey) as {
        id: string;
        priority: QueuePriority;
        status: RequestStatus;
      } | null;
      if (existing?.id) {
        if (existing.status === "failed") {
          const now = new Date().toISOString();
          const reopened = this.db
            .prepare(
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
            )
            .run(
              sessionId,
              prompt,
              priority,
              queueWaitBudgetMs,
              metadataJson,
              forceWorker,
              forceLane,
              forceWorker,
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
              requeued: true,
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
          deduplicated: true,
        };
      }
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO requests (
          id, sessionId, prompt, priority, queueWaitBudgetMs, metadataJson, idempotencyKey, forceWorker, forceLane,
          workerRequired, handoffJobId, status, agentId, claimToken, claimGeneration, leaseExpiresAt, lastHeartbeatAt, claimAttempts, result, error,
          enqueuedAt, claimedAt, completedAt, failedAt, durationMs, createdAt, updatedAt
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, 0, NULL, NULL, 0, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
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
    };
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
    this.reconcileWorkerHandoffsFromJobs(now);

    const tx = this.db.transaction(() => {
      this.recoverExpiredClaims(now);
      const row = this.db
        .prepare(
          `SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           WHERE status = 'pending'
           ORDER BY
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC
           LIMIT 1`,
        )
        .get() as RequestRow | undefined;

      if (!row) return null;

      this.db
        .prepare(
          `UPDATE requests
           SET status = 'claimed',
               agentId = ?,
               claimToken = ?,
               claimGeneration = COALESCE(claimGeneration, 0) + 1,
               claimedAt = ?,
               leaseExpiresAt = ?,
               lastHeartbeatAt = ?,
               claimAttempts = COALESCE(claimAttempts, 0) + 1,
               completedAt = NULL,
               failedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
           WHERE id = ?`,
        )
        .run(agentId, claimToken, now, leaseExpiresAt, now, now, row.id);

      const queueWaitMs = Math.max(
        0,
        Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0),
      );

      return {
        request: {
          ...row,
          metadata: parseMetadataJson(row.metadataJson),
          status: "claimed" as RequestStatus,
          agentId,
          claimToken,
          claimGeneration: Number(row.claimGeneration ?? 0) + 1,
          claimedAt: now,
          leaseExpiresAt,
          lastHeartbeatAt: now,
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
    const result = this.db
      .prepare(
        `UPDATE requests
         SET lastHeartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND agentId = ?
           AND claimToken = ?
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt > ?`,
      )
      .run(now, leaseExpiresAt, now, requestId, agentId, claimToken, now);
    if (result.changes === 0) {
      return {
        ok: false,
        message: "Request lease is missing, expired, or owned by another agent",
      };
    }
    return { ok: true, leaseExpiresAt };
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
    const rows = this.db
      .prepare(
        `SELECT id FROM requests
         WHERE status = 'claimed'
           AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
         ORDER BY createdAt ASC`,
      )
      .all(now) as Array<{ id: string }>;
    if (rows.length === 0) return { recovered: 0, requestIds: [] };
    const result = this.db
      .prepare(
        `UPDATE requests
         SET status = 'pending',
             agentId = NULL,
             claimToken = NULL,
             claimedAt = NULL,
             leaseExpiresAt = NULL,
             lastHeartbeatAt = NULL,
             updatedAt = ?
         WHERE status = 'claimed'
           AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
      )
      .run(now, now);
    return {
      recovered: result.changes,
      requestIds: rows.slice(0, result.changes).map((row) => row.id),
    };
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
    const jobsTable = this.db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`)
      .get() as { present: number } | undefined;
    if (!jobsTable) return { completed: 0, requestIds: [], jobIds: [] };

    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const now = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
    const rows = this.db
      .prepare(
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
         WHERE r.status = 'pending'
            OR (
              r.status = 'claimed'
              AND (r.leaseExpiresAt IS NULL OR r.leaseExpiresAt <= ?)
            )
         ORDER BY r.createdAt ASC
         LIMIT 400`,
      )
      .all(now) as Array<{ requestId: string; requestSessionId: string; jobId: string }>;
    if (rows.length === 0) return { completed: 0, requestIds: [], jobIds: [] };

    const requestIds: string[] = [];
    const jobIds: string[] = [];
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const updated = this.db
          .prepare(
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
                 status = 'pending'
                 OR (
                   status = 'claimed'
                   AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
                 )
               )`,
          )
          .run(
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
    const result = this.db
      .prepare(
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
      )
      .run(jobId, now, requestId, agentId, claimToken, now);
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

    const info = this.db
      .prepare(
        `UPDATE requests
         SET status = 'completed',
              result = ?,
              completedAt = ?,
              failedAt = NULL,
              leaseExpiresAt = NULL,
              lastHeartbeatAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt > ?
           AND agentId = ?
           AND claimToken = ?`,
      )
      .run(result, now, now, now, requestId, now, agentId, claimToken);

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

    const info = this.db
      .prepare(
        `UPDATE requests
         SET status = 'failed',
              error = ?,
              failedAt = ?,
              completedAt = NULL,
              leaseExpiresAt = NULL,
             lastHeartbeatAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt > ?
           AND agentId = ?
           AND claimToken = ?`,
      )
      .run(JSON.stringify({ message, detail }), now, now, now, requestId, now, agentId, claimToken);

    if (info.changes === 0) {
      return {
        ok: false,
        message: "Request is not claimed with an active lease owned by this agent",
      };
    }

    return { ok: true, transitioned: true };
  }

  getRequest(requestId: string): RequestRow | null {
    const row =
      (this.db
        .prepare(`SELECT ${RequestQueue.SELECT_COLUMNS} FROM requests WHERE id = ?`)
        .get(requestId) as RequestRow | undefined) ?? null;
    if (!row) return null;
    return { ...row, metadata: parseMetadataJson(row.metadataJson) };
  }

  getPendingRequests(): RequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
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
      .all() as RequestRow[];
    return rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
  }

  listRequests(options?: { status?: RequestStatus | "all"; limit?: number }): RequestRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      const rows = this.db
        .prepare(
          `SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           ORDER BY createdAt DESC
           LIMIT ?`,
        )
        .all(limit) as RequestRow[];
      return rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
    }

    const rows = this.db
      .prepare(
        `SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         WHERE status = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
      )
      .all(status, limit) as RequestRow[];
    return rows.map((row) => ({ ...row, metadata: parseMetadataJson(row.metadataJson) }));
  }

  countByStatus(): Record<RequestStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM requests GROUP BY status`)
      .all() as Array<{ status: RequestStatus; count: number }>;

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
    const rows = this.db
      .prepare(
        `SELECT priority, COUNT(*) AS count
         FROM requests
         WHERE status IN ('pending', 'claimed')
         GROUP BY priority`,
      )
      .all() as Array<{ priority: string; count: number }>;

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
    const rows = this.db
      .prepare(
        `SELECT metadataJson
         FROM requests
         WHERE status IN (${placeholders})
           AND metadataJson IS NOT NULL
           AND metadataJson <> ''`,
      )
      .all(...normalized) as Array<{ metadataJson: string | null }>;

    let count = 0;
    for (const row of rows) {
      const metadata = parseMetadataJson(row.metadataJson);
      if (isAutonomyMetadata(metadata)) count += 1;
    }
    return count;
  }

  nextPendingSnapshot(
    limit = 10,
  ): Array<{ id: string; priority: QueuePriority; position: number; etaMs: number }> {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.db.prepare(`SELECT priority FROM requests WHERE id = ?`).get(id) as
        | { priority: string }
        | undefined;
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
    const rows = this.db
      .prepare(
        `SELECT status, durationMs, enqueuedAt, claimedAt, createdAt, updatedAt
         FROM requests
         WHERE status IN ('completed', 'failed')
           AND updatedAt >= ?`,
      )
      .all(cutoffIso) as Array<{
      status: RequestStatus;
      durationMs: number | null;
      enqueuedAt: string | null;
      claimedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    }>;

    let completed = 0;
    let failed = 0;
    const durationSamples: number[] = [];
    const queueWaitSamples: number[] = [];

    for (const row of rows) {
      if (row.status === "completed") completed += 1;
      if (row.status === "failed") failed += 1;
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
    this.db.close();
  }
}
