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
import { normalizeTrustedValidationCommands } from "../../../packages/shared/src/trusted_validation.js";

export type CompletionStatus = "pending" | "claimed" | "processed" | "failed";

export interface CompletionRow {
  id: string;
  jobId: string;
  sessionId: string;
  origin: "user" | "autonomy";
  commitSha: string | null;
  branch: string | null;
  message: string;
  prUrl: string | null;
  prTitle: string | null;
  prBody: string | null;
  trustedValidationCommandsJson: string | null;
  trustedValidationSummary: string | null;
  trustedValidationDetail: string | null;
  status: CompletionStatus;
  pusherId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CompletionQueue {
  private db: Database;

  constructor(dbPath: string | Database = ":memory:") {
    this.db = typeof dbPath === "string" ? new Database(dbPath) : dbPath;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completions (
        id         TEXT PRIMARY KEY,
        jobId      TEXT NOT NULL,
        sessionId  TEXT NOT NULL,
        origin     TEXT NOT NULL DEFAULT 'user',
        commitSha  TEXT,
        branch     TEXT,
        message    TEXT NOT NULL,
        prUrl      TEXT,
        prTitle    TEXT,
        prBody     TEXT,
        trustedValidationCommandsJson TEXT,
        trustedValidationSummary TEXT,
        trustedValidationDetail TEXT,
        status     TEXT NOT NULL DEFAULT 'pending',
        pusherId   TEXT,
        error      TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_completions_status ON completions(status);
      CREATE INDEX IF NOT EXISTS idx_completions_job ON completions(jobId);
    `);

    const columns = this.db.prepare(`PRAGMA table_info(completions)`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((col) => col.name === "prTitle")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prTitle TEXT;`);
    }
    if (!columns.some((col) => col.name === "prBody")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prBody TEXT;`);
    }
    if (!columns.some((col) => col.name === "prUrl")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN prUrl TEXT;`);
    }
    if (!columns.some((col) => col.name === "origin")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';`);
    }
    if (!columns.some((col) => col.name === "trustedValidationCommandsJson")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationCommandsJson TEXT;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationSummary")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationSummary TEXT;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationDetail")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationDetail TEXT;`);
    }
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
    const origin = body.origin === "autonomy" ? "autonomy" : "user";
    const prUrl =
      typeof body.prUrl === "string" && body.prUrl.trim().length > 0 ? body.prUrl.trim() : null;
    const prTitle =
      typeof body.prTitle === "string" && body.prTitle.trim().length > 0
        ? body.prTitle.trim()
        : null;
    const prBody =
      typeof body.prBody === "string" && body.prBody.trim().length > 0 ? body.prBody.trim() : null;
    let trustedValidationCommandsJson: string | null = null;
    let trustedValidationSummary: string | null = null;
    let trustedValidationDetail: string | null = null;
    if (body.trustedValidationCommands !== undefined) {
      const trustedCommands = normalizeTrustedValidationCommands(body.trustedValidationCommands);
      if (!trustedCommands.ok) {
        return { ok: false, message: trustedCommands.message };
      }
      trustedValidationCommandsJson = JSON.stringify(trustedCommands.commands);
      trustedValidationSummary =
        typeof body.trustedValidationSummary === "string"
          ? body.trustedValidationSummary.trim().slice(0, 500) || null
          : null;
      trustedValidationDetail =
        typeof body.trustedValidationDetail === "string"
          ? body.trustedValidationDetail.trim().slice(0, 4_000) || null
          : null;
    }

    if (!jobId || !sessionId || !message) {
      return { ok: false, message: "jobId, sessionId, and message are required" };
    }

    const completionId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO completions (
           id, jobId, sessionId, origin, commitSha, branch, message, prUrl, prTitle, prBody,
           trustedValidationCommandsJson, trustedValidationSummary, trustedValidationDetail,
           status, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        completionId,
        jobId,
        sessionId,
        origin,
        commitSha ?? null,
        branch ?? null,
        message,
        prUrl,
        prTitle,
        prBody,
        trustedValidationCommandsJson,
        trustedValidationSummary,
        trustedValidationDetail,
        now,
        now,
      );

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
  markProcessed(completionId: string, prUrl?: string | null): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const normalizedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;

    const info = this.db
      .prepare(
        `UPDATE completions
         SET status = 'processed',
             prUrl = COALESCE(?, prUrl),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(normalizedPrUrl, now, completionId);

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
