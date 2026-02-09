import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

// ─── Job status lifecycle ───────────────────────────────────────────────────

export type JobStatus = "pending" | "claimed" | "completed" | "failed";

export interface JobRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string; // JSON string
  status: JobStatus;
  workerId: string | null;
  result: string | null; // JSON string — summary / artifacts
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite-backed job queue with atomic claim semantics.
 *
 * Tables:
 *   jobs        – main job records
 *   job_logs    – optional append-only log per job
 */
export class JobQueue {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  // ── Schema migration ────────────────────────────────────────────────────

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id         TEXT PRIMARY KEY,
        taskId     TEXT NOT NULL,
        sessionId  TEXT NOT NULL DEFAULT '',
        kind       TEXT NOT NULL,
        params     TEXT NOT NULL DEFAULT '{}',
        status     TEXT NOT NULL DEFAULT 'pending',
        workerId   TEXT,
        result     TEXT,
        error      TEXT,
        createdAt  TEXT NOT NULL,
        updatedAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs(taskId);

      CREATE TABLE IF NOT EXISTS job_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        ts      TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );

      CREATE TABLE IF NOT EXISTS job_artifacts (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        uri     TEXT,
        text    TEXT,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
    `);
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────

  enqueue(body: Record<string, unknown>): { ok: boolean; jobId?: string; message?: string } {
    const taskId = body.taskId as string;
    const kind = body.kind as string;
    const sessionId = (body.sessionId as string) ?? "";
    const params = body.params ?? {};

    if (!taskId || !kind) {
      return { ok: false, message: "taskId and kind are required" };
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO jobs (id, taskId, sessionId, kind, params, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(jobId, taskId, sessionId, kind, JSON.stringify(params), now, now);

    return { ok: true, jobId };
  }

  // ── Claim (atomic) ─────────────────────────────────────────────────────

  claim(workerId: string): { ok: boolean; job?: JobRow; message?: string } {
    const now = new Date().toISOString();

    // Atomic: find first pending job and update with a single transaction
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`)
        .get() as JobRow | undefined;

      if (!row) return null;

      this.db
        .prepare(`UPDATE jobs SET status = 'claimed', workerId = ?, updatedAt = ? WHERE id = ?`)
        .run(workerId, now, row.id);

      return { ...row, status: "claimed" as JobStatus, workerId, updatedAt: now };
    });

    const job = tx();
    if (!job) return { ok: false, message: "No pending jobs" };
    return { ok: true, job };
  }

  // ── Complete ────────────────────────────────────────────────────────────

  complete(jobId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const summary = (body.summary as string) ?? null;
    const artifacts = body.artifacts ? JSON.stringify(body.artifacts) : null;

    const info = this.db
      .prepare(
        `UPDATE jobs SET status = 'completed', result = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ summary, artifacts }), now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    return { ok: true };
  }

  // ── Fail ────────────────────────────────────────────────────────────────

  fail(jobId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const message = (body.message as string) ?? "Unknown error";
    const detail = (body.detail as string) ?? null;

    const info = this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail }), now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    return { ok: true };
  }

  // ── Query helpers ───────────────────────────────────────────────────────

  getJob(jobId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as JobRow) ?? null;
  }

  getPendingJobs(): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY createdAt ASC`)
      .all() as JobRow[];
  }

  addLog(jobId: string, message: string): void {
    this.db
      .prepare(`INSERT INTO job_logs (jobId, ts, message) VALUES (?, ?, ?)`)
      .run(jobId, new Date().toISOString(), message);
  }
}
