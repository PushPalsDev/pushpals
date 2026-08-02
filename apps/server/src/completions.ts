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

export interface CompletionFinalizationResult {
  ok: boolean;
  message?: string;
  jobId?: string;
  jobTransitioned?: boolean;
  durationMs?: number;
  completedAt?: string;
  publishBlockedAt?: string;
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

    this.reconcileLegacyParentJobStates();
  }

  private reconcileLegacyParentJobStates(): void {
    const jobsTable = this.db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`)
      .get() as { present: number } | undefined;
    if (!jobsTable) return;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      // Older workers marked the job completed immediately after enqueueing a
      // candidate. Restore unresolved handoffs to a nonterminal state.
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'finalizing', completedAt = NULL, updatedAt = ?
           WHERE status = 'completed'
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status IN ('pending', 'claimed')
             )`,
        )
        .run(now);

      // Repair persisted false positives from releases where completion
      // failure did not propagate back to the parent job.
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'publish_blocked',
               error = COALESCE(
                 (SELECT c.error FROM completions c
                  WHERE c.jobId = jobs.id AND c.status = 'failed'
                  ORDER BY c.updatedAt DESC LIMIT 1),
                 error
               ),
               completedAt = NULL,
               publishBlockedAt = COALESCE(publishBlockedAt, ?),
               updatedAt = ?
           WHERE status IN ('completed', 'finalizing')
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status = 'failed'
             )`,
        )
        .run(now, now);

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed',
               completedAt = COALESCE(completedAt, ?),
               error = NULL,
               publishBlockedAt = NULL,
               updatedAt = ?
           WHERE status = 'finalizing'
             AND EXISTS (
               SELECT 1 FROM completions c
               WHERE c.jobId = jobs.id AND c.status = 'processed'
             )`,
        )
        .run(now, now);

      const diagnosticsTable = this.db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
           WHERE type = 'table' AND name = 'job_terminal_diagnostics'`,
        )
        .get() as { present: number } | undefined;
      if (diagnosticsTable) {
        const failedParents = this.db
          .prepare(
            `SELECT j.id AS jobId,
                    c.error AS error,
                    c.trustedValidationCommandsJson AS trustedValidationCommandsJson
             FROM jobs j
             JOIN completions c ON c.id = (
               SELECT latest.id FROM completions latest
               WHERE latest.jobId = j.id AND latest.status = 'failed'
               ORDER BY latest.updatedAt DESC LIMIT 1
             )
             WHERE j.status = 'publish_blocked'`,
          )
          .all() as Array<{
          jobId: string;
          error: string | null;
          trustedValidationCommandsJson: string | null;
        }>;
        for (const row of failedParents) {
          this.upsertPublicationTerminalDiagnostics({
            jobId: row.jobId,
            status: "publish_blocked",
            failureClass: row.trustedValidationCommandsJson
              ? "trusted_validation_failed"
              : "publication_failed",
            terminalStage: row.trustedValidationCommandsJson
              ? "trusted_environment_validation"
              : "publication",
            summary: row.error || "Candidate publication failed",
            now,
          });
        }
      }
    });
    tx();
  }

  /**
   * Enqueue a new completion from WorkerPal
   */
  enqueue(
    body: Record<string, unknown>,
    options: { beginJobFinalization?: boolean } = {},
  ): {
    ok: boolean;
    completionId?: string;
    message?: string;
    deduped?: boolean;
    jobStatus?: "finalizing";
  } {
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

    const tx = this.db.transaction(() => {
      if (options.beginJobFinalization) {
        const job = this.db.prepare(`SELECT status, workerId FROM jobs WHERE id = ?`).get(jobId) as
          | { status: string; workerId: string | null }
          | undefined;
        if (!job) return { ok: false as const, message: "Job not found" };

        const existing = this.db
          .prepare(
            `SELECT id FROM completions
             WHERE jobId = ? AND status IN ('pending', 'claimed')
             ORDER BY createdAt DESC
             LIMIT 1`,
          )
          .get(jobId) as { id: string } | undefined;
        if (existing && job.status === "finalizing") {
          return {
            ok: true as const,
            completionId: existing.id,
            deduped: true,
            jobStatus: "finalizing" as const,
          };
        }
        if (job.status !== "claimed") {
          return {
            ok: false as const,
            message: `Job is ${job.status}; expected claimed before completion handoff`,
          };
        }
        if (existing) {
          return {
            ok: false as const,
            message: `Job already has active completion ${existing.id}`,
          };
        }
      }

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

      if (options.beginJobFinalization) {
        const summary =
          typeof body.jobResultSummary === "string" ? body.jobResultSummary.trim() : "";
        const artifacts = Array.isArray(body.jobArtifacts) ? body.jobArtifacts : [];
        const transitioned = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'finalizing',
                 result = ?,
                 prUrl = COALESCE(?, prUrl),
                 error = NULL,
                 completedAt = NULL,
                 failedAt = NULL,
                 abandonedAt = NULL,
                 publishBlockedAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(JSON.stringify({ summary: summary || message, artifacts }), prUrl, now, jobId);
        if (transitioned.changes === 0) {
          throw new Error(`Job ${jobId} left claimed state during completion handoff`);
        }
        this.db
          .prepare(
            `UPDATE workers
             SET status = 'idle',
                 currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                 lastHeartbeat = ?,
                 updatedAt = ?
             WHERE workerId = (SELECT workerId FROM jobs WHERE id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM jobs active
                 WHERE active.workerId = workers.workerId AND active.status = 'claimed'
               )`,
          )
          .run(jobId, now, now, jobId);
      }

      return {
        ok: true as const,
        completionId,
        ...(options.beginJobFinalization ? { jobStatus: "finalizing" as const } : {}),
      };
    });

    try {
      return tx();
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
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
   * Finalize a published completion and its parent job in one SQLite transaction.
   * A worker candidate is not a successful job until this transition commits.
   */
  markProcessedAndFinalizeJob(
    completionId: string,
    prUrl?: string | null,
  ): CompletionFinalizationResult {
    const now = new Date().toISOString();
    const normalizedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    const tx = this.db.transaction((): CompletionFinalizationResult => {
      const completion = this.getCompletion(completionId);
      if (!completion) return { ok: false, message: "Completion not found" };
      if (completion.status === "processed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      const job = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(completion.jobId) as
        | { status: string }
        | undefined;
      if (!job) return { ok: false, message: "Parent job not found" };
      if (job.status !== "finalizing" && job.status !== "completed") {
        return {
          ok: false,
          message: `Parent job is ${job.status}; expected finalizing`,
        };
      }

      this.db
        .prepare(
          `UPDATE completions
           SET status = 'processed', prUrl = COALESCE(?, prUrl), error = NULL, updatedAt = ?
           WHERE id = ? AND status = 'claimed'`,
        )
        .run(normalizedPrUrl, now, completionId);
      const transitioned = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed',
               prUrl = COALESCE(?, prUrl),
               error = NULL,
               completedAt = ?,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ? AND status = 'finalizing'`,
        )
        .run(normalizedPrUrl, now, now, now, completion.jobId);

      if (transitioned.changes > 0) {
        this.upsertPublicationTerminalDiagnostics({
          jobId: completion.jobId,
          status: "completed",
          failureClass: "success",
          terminalStage: "publication",
          summary: normalizedPrUrl
            ? `Candidate published successfully: ${normalizedPrUrl}`
            : "Candidate published successfully",
          now,
        });
      }
      const saved = this.db
        .prepare(`SELECT durationMs, completedAt FROM jobs WHERE id = ?`)
        .get(completion.jobId) as
        | { durationMs: number | null; completedAt: string | null }
        | undefined;
      return {
        ok: true,
        jobId: completion.jobId,
        jobTransitioned: transitioned.changes > 0,
        durationMs: saved?.durationMs ?? undefined,
        completedAt: saved?.completedAt ?? undefined,
      };
    });
    return tx();
  }

  /**
   * Fail publication and move the parent job to publish_blocked atomically.
   * Completed is accepted only to repair state written by older workers.
   */
  markFailedAndBlockJob(completionId: string, error: string): CompletionFinalizationResult {
    const now = new Date().toISOString();
    const failure = String(error || "Unknown publication error");
    const tx = this.db.transaction((): CompletionFinalizationResult => {
      const completion = this.getCompletion(completionId);
      if (!completion) return { ok: false, message: "Completion not found" };
      if (completion.status === "failed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      const job = this.db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(completion.jobId) as
        | { status: string }
        | undefined;
      if (!job) return { ok: false, message: "Parent job not found" };
      if (job.status !== "finalizing" && job.status !== "completed") {
        return {
          ok: false,
          message: `Parent job is ${job.status}; expected finalizing`,
        };
      }

      this.db
        .prepare(
          `UPDATE completions
           SET status = 'failed', error = ?, updatedAt = ?
           WHERE id = ? AND status = 'claimed'`,
        )
        .run(failure, now, completionId);
      const transitioned = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'publish_blocked',
               error = ?,
               publishBlockedAt = ?,
               completedAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ? AND status IN ('finalizing', 'completed')`,
        )
        .run(
          JSON.stringify({
            message: "Candidate publication failed",
            detail: failure,
            completionId,
          }),
          now,
          now,
          now,
          completion.jobId,
        );
      if (transitioned.changes > 0) {
        this.upsertPublicationTerminalDiagnostics({
          jobId: completion.jobId,
          status: "publish_blocked",
          failureClass: completion.trustedValidationCommandsJson
            ? "trusted_validation_failed"
            : "publication_failed",
          terminalStage: completion.trustedValidationCommandsJson
            ? "trusted_environment_validation"
            : "publication",
          summary: failure,
          now,
        });
      }
      const saved = this.db
        .prepare(`SELECT durationMs, publishBlockedAt FROM jobs WHERE id = ?`)
        .get(completion.jobId) as
        | { durationMs: number | null; publishBlockedAt: string | null }
        | undefined;
      return {
        ok: true,
        jobId: completion.jobId,
        jobTransitioned: transitioned.changes > 0,
        durationMs: saved?.durationMs ?? undefined,
        publishBlockedAt: saved?.publishBlockedAt ?? undefined,
      };
    });
    return tx();
  }

  private upsertPublicationTerminalDiagnostics(options: {
    jobId: string;
    status: "completed" | "publish_blocked";
    failureClass: string;
    terminalStage: string;
    summary: string;
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_terminal_diagnostics (
           jobId, status, failureClass, terminalStage, summary,
           watchdogFired, changedPathSampleJson, metadataJson, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, ?)
         ON CONFLICT(jobId) DO UPDATE SET
           status = excluded.status,
           failureClass = excluded.failureClass,
           terminalStage = excluded.terminalStage,
           summary = excluded.summary,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        options.jobId,
        options.status,
        options.failureClass,
        options.terminalStage,
        options.summary.slice(0, 1000),
        JSON.stringify({ completionFinalized: true }),
        options.now,
        options.now,
      );
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
