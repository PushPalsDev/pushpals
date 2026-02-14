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

export type RequestStatus = "pending" | "claimed" | "completed" | "failed";
export type QueuePriority = "interactive" | "normal" | "background";

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
  status: RequestStatus;
  agentId: string | null;
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

export class RequestQueue {
  private db: Database;
  private static readonly SELECT_COLUMNS = `
    id,
    sessionId,
    prompt,
    priority,
    queueWaitBudgetMs,
    status,
    agentId,
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
        status           TEXT NOT NULL DEFAULT 'pending',
        agentId          TEXT,
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
    ensureColumn("enqueuedAt", `ALTER TABLE requests ADD COLUMN enqueuedAt TEXT;`);
    ensureColumn("claimedAt", `ALTER TABLE requests ADD COLUMN claimedAt TEXT;`);
    ensureColumn("completedAt", `ALTER TABLE requests ADD COLUMN completedAt TEXT;`);
    ensureColumn("failedAt", `ALTER TABLE requests ADD COLUMN failedAt TEXT;`);
    ensureColumn("durationMs", `ALTER TABLE requests ADD COLUMN durationMs INTEGER;`);

    // Column-dependent index is created after legacy column backfills complete.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_requests_priority_created ON requests(status, priority, createdAt);`,
    );

    this.db.exec(`
      UPDATE requests
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        queueWaitBudgetMs = CASE WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000 ELSE queueWaitBudgetMs END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
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
    message?: string;
  } {
    const sessionId = String(body.sessionId ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    const priority = normalizePriority(body.priority);
    const queueWaitBudgetMs = parseBudgetMs(body.queueWaitBudgetMs, PRIORITY_SLA_MS[priority]);

    if (!sessionId || !prompt) {
      return { ok: false, message: "sessionId and prompt are required" };
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO requests (
          id, sessionId, prompt, priority, queueWaitBudgetMs, status, agentId, result, error,
          enqueuedAt, claimedAt, completedAt, failedAt, durationMs, createdAt, updatedAt
        )
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(requestId, sessionId, prompt, priority, queueWaitBudgetMs, now, now, now);

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
  claim(agentIdRaw: string): {
    ok: boolean;
    request?: RequestRow;
    queueWaitMs?: number;
    message?: string;
  } {
    const now = new Date().toISOString();
    const agentId = String(agentIdRaw ?? "").trim() || "unknown";

    const tx = this.db.transaction(() => {
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
               claimedAt = ?,
               completedAt = NULL,
               failedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
           WHERE id = ?`,
        )
        .run(agentId, now, now, row.id);

      const queueWaitMs = Math.max(
        0,
        Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0),
      );

      return {
        request: {
          ...row,
          status: "claimed" as RequestStatus,
          agentId,
          claimedAt: now,
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

  /**
   * Mark a request as completed.
   */
  complete(requestId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const result = body.result ? JSON.stringify(body.result) : null;

    const info = this.db
      .prepare(
        `UPDATE requests
         SET status = 'completed',
             result = ?,
             completedAt = ?,
             failedAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(result, now, now, now, requestId);

    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Mark a request as failed.
   */
  fail(requestId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);

    const info = this.db
      .prepare(
        `UPDATE requests
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             completedAt = NULL,
             durationMs = MAX(0, CAST((julianday(?) - julianday(COALESCE(enqueuedAt, createdAt))) * 86400000 AS INTEGER)),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail }), now, now, now, requestId);

    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }

    return { ok: true };
  }

  getRequest(requestId: string): RequestRow | null {
    return (
      (this.db
        .prepare(`SELECT ${RequestQueue.SELECT_COLUMNS} FROM requests WHERE id = ?`)
        .get(requestId) as RequestRow) ?? null
    );
  }

  getPendingRequests(): RequestRow[] {
    return this.db
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
  }

  listRequests(options?: { status?: RequestStatus | "all"; limit?: number }): RequestRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      return this.db
        .prepare(
          `SELECT ${RequestQueue.SELECT_COLUMNS}
           FROM requests
           ORDER BY createdAt DESC
           LIMIT ?`,
        )
        .all(limit) as RequestRow[];
    }

    return this.db
      .prepare(
        `SELECT ${RequestQueue.SELECT_COLUMNS}
         FROM requests
         WHERE status = ?
         ORDER BY createdAt DESC
         LIMIT ?`,
      )
      .all(status, limit) as RequestRow[];
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
