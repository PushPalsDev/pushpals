/**
 * Completion Queue for finished work from WorkerPals -> SourceControlManager
 *
 * Flow:
 *   1. WorkerPal completes job and creates git commit
 *   2. WorkerPal enqueues completion with commit SHA + branch
 *   3. SourceControlManager polls and claims completions
 *   4. SourceControlManager runs format/test checks
 *   5. If pass: merge to integration branch and mark processed
 *   6. If fail: mark failed with error
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export type CompletionStatus = "pending" | "claimed" | "processed" | "failed";

export interface CompletionRow {
  id: string;
  jobId: string;
  sessionId: string;
  commitSha: string | null;
  branch: string | null;
  message: string;
  status: CompletionStatus;
  pusherId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CompletionQueue {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completions (
        id         TEXT PRIMARY KEY,
        jobId      TEXT NOT NULL,
        sessionId  TEXT NOT NULL,
        commitSha  TEXT,
        branch     TEXT,
        message    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        pusherId   TEXT,
        error      TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_completions_status ON completions(status);
      CREATE INDEX IF NOT EXISTS idx_completions_job ON completions(jobId);
    `);
  }

  /**
   * Enqueue a new completion from WorkerPal
   */
  enqueue(body: Record<string, unknown>): { ok: boolean; completionId?: string; message?: string } {
    const jobId = body.jobId as string;
    const sessionId = body.sessionId as string;
    const commitSha = body.commitSha as string | undefined;
    const branch = body.branch as string | undefined;
    const message = body.message as string;

    if (!jobId || !sessionId || !message) {
      return { ok: false, message: "jobId, sessionId, and message are required" };
    }

    const completionId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO completions (id, jobId, sessionId, commitSha, branch, message, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(completionId, jobId, sessionId, commitSha ?? null, branch ?? null, message, now, now);

    return { ok: true, completionId };
  }

  /**
   * Atomically claim the next pending completion (FIFO by createdAt)
   */
  claim(pusherId: string): { ok: boolean; completion?: CompletionRow; message?: string } {
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM completions WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`,
        )
        .get() as CompletionRow | undefined;

      if (!row) return null;

      this.db
        .prepare(
          `UPDATE completions SET status = 'claimed', pusherId = ?, updatedAt = ? WHERE id = ?`,
        )
        .run(pusherId, now, row.id);

      return { ...row, status: "claimed" as CompletionStatus, pusherId, updatedAt: now };
    });

    const completion = tx();
    if (!completion) return { ok: false, message: "No pending completions" };
    return { ok: true, completion };
  }

  /**
   * Mark a completion as processed (checks passed, merged to integration branch)
   */
  markProcessed(completionId: string): { ok: boolean; message?: string } {
    const now = new Date().toISOString();

    const info = this.db
      .prepare(
        `UPDATE completions SET status = 'processed', updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(now, completionId);

    if (info.changes === 0) {
      return { ok: false, message: "Completion not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Mark a completion as failed (checks failed or merge conflict)
   */
  markFailed(completionId: string, error: string): { ok: boolean; message?: string } {
    const now = new Date().toISOString();

    const info = this.db
      .prepare(
        `UPDATE completions SET status = 'failed', error = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(error, now, completionId);

    if (info.changes === 0) {
      return { ok: false, message: "Completion not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Get a specific completion by ID
   */
  getCompletion(completionId: string): CompletionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM completions WHERE id = ?`)
        .get(completionId) as CompletionRow) ?? null
    );
  }

  /**
   * Get all pending completions (for debugging)
   */
  getPendingCompletions(): CompletionRow[] {
    return this.db
      .prepare(`SELECT * FROM completions WHERE status = 'pending' ORDER BY createdAt ASC`)
      .all() as CompletionRow[];
  }

  listCompletions(options?: {
    status?: CompletionStatus | "all";
    limit?: number;
  }): CompletionRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      return this.db
        .prepare(`SELECT * FROM completions ORDER BY createdAt DESC LIMIT ?`)
        .all(limit) as CompletionRow[];
    }

    return this.db
      .prepare(`SELECT * FROM completions WHERE status = ? ORDER BY createdAt DESC LIMIT ?`)
      .all(status, limit) as CompletionRow[];
  }

  countByStatus(): Record<CompletionStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM completions GROUP BY status`)
      .all() as Array<{ status: CompletionStatus; count: number }>;

    const counts: Record<CompletionStatus, number> = {
      pending: 0,
      claimed: 0,
      processed: 0,
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
