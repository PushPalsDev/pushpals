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

export interface RequestRow {
  id: string;
  sessionId: string;
  originalPrompt: string;
  enhancedPrompt: string;
  status: RequestStatus;
  agentId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class RequestQueue {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id             TEXT PRIMARY KEY,
        sessionId      TEXT NOT NULL,
        originalPrompt TEXT NOT NULL,
        enhancedPrompt TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        agentId        TEXT,
        result         TEXT,
        error          TEXT,
        createdAt      TEXT NOT NULL,
        updatedAt      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId);
    `);
  }

  /**
   * Enqueue a new request from LocalBuddy
   */
  enqueue(body: Record<string, unknown>): { ok: boolean; requestId?: string; message?: string } {
    const sessionId = body.sessionId as string;
    const originalPrompt = body.originalPrompt as string;
    const enhancedPrompt = body.enhancedPrompt as string;

    if (!sessionId || !originalPrompt || !enhancedPrompt) {
      return { ok: false, message: "sessionId, originalPrompt, and enhancedPrompt are required" };
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO requests (id, sessionId, originalPrompt, enhancedPrompt, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(requestId, sessionId, originalPrompt, enhancedPrompt, now, now);

    return { ok: true, requestId };
  }

  /**
   * Atomically claim the next pending request (FIFO by createdAt)
   */
  claim(agentId: string): { ok: boolean; request?: RequestRow; message?: string } {
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM requests WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`)
        .get() as RequestRow | undefined;

      if (!row) return null;

      this.db
        .prepare(`UPDATE requests SET status = 'claimed', agentId = ?, updatedAt = ? WHERE id = ?`)
        .run(agentId, now, row.id);

      return { ...row, status: "claimed" as RequestStatus, agentId, updatedAt: now };
    });

    const request = tx();
    if (!request) return { ok: false, message: "No pending requests" };
    return { ok: true, request };
  }

  /**
   * Mark a request as completed
   */
  complete(requestId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const result = body.result ? JSON.stringify(body.result) : null;

    const info = this.db
      .prepare(
        `UPDATE requests SET status = 'completed', result = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(result, now, requestId);

    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Mark a request as failed
   */
  fail(requestId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const message = (body.message as string) ?? "Unknown error";
    const detail = (body.detail as string) ?? null;

    const info = this.db
      .prepare(
        `UPDATE requests SET status = 'failed', error = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail }), now, requestId);

    if (info.changes === 0) {
      return { ok: false, message: "Request not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Get a specific request by ID
   */
  getRequest(requestId: string): RequestRow | null {
    return (
      (this.db.prepare(`SELECT * FROM requests WHERE id = ?`).get(requestId) as RequestRow) ?? null
    );
  }

  /**
   * Get all pending requests (for debugging)
   */
  getPendingRequests(): RequestRow[] {
    return this.db
      .prepare(`SELECT * FROM requests WHERE status = 'pending' ORDER BY createdAt ASC`)
      .all() as RequestRow[];
  }

  /**
   * List requests for observability UI.
   */
  listRequests(options?: {
    status?: RequestStatus | "all";
    limit?: number;
  }): RequestRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      return this.db
        .prepare(`SELECT * FROM requests ORDER BY createdAt DESC LIMIT ?`)
        .all(limit) as RequestRow[];
    }

    return this.db
      .prepare(`SELECT * FROM requests WHERE status = ? ORDER BY createdAt DESC LIMIT ?`)
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

  close(): void {
    this.db.close();
  }
}
