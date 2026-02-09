import { Database } from "bun:sqlite";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MergeJobStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface MergeJob {
  id: number;
  branch: string;
  remote: string;
  head_sha: string;
  status: MergeJobStatus;
  priority: number;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SeenBranch {
  remote: string;
  branch: string;
  last_seen_sha: string;
  last_seen_at: string;
}

// ─── Database ───────────────────────────────────────────────────────────────

export class MergeQueueDB {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this._migrate();
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        branch      TEXT NOT NULL,
        remote      TEXT NOT NULL DEFAULT 'origin',
        head_sha    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'queued',
        priority    INTEGER NOT NULL DEFAULT 0,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_head
        ON jobs(remote, branch, head_sha);

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
        ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS seen (
        remote        TEXT NOT NULL,
        branch        TEXT NOT NULL,
        last_seen_sha TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        PRIMARY KEY(remote, branch)
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id  INTEGER NOT NULL,
        ts      TEXT NOT NULL,
        level   TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
    `);
  }

  // ── Seen branches ───────────────────────────────────────────────────────

  getSeenSha(remote: string, branch: string): string | null {
    const row = this.db
      .prepare(`SELECT last_seen_sha FROM seen WHERE remote = ? AND branch = ?`)
      .get(remote, branch) as { last_seen_sha: string } | undefined;
    return row?.last_seen_sha ?? null;
  }

  updateSeen(remote: string, branch: string, sha: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO seen (remote, branch, last_seen_sha, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(remote, branch)
         DO UPDATE SET last_seen_sha = excluded.last_seen_sha,
                       last_seen_at  = excluded.last_seen_at`,
      )
      .run(remote, branch, sha, now);
  }

  removeSeen(remote: string, branch: string): void {
    this.db
      .prepare(`DELETE FROM seen WHERE remote = ? AND branch = ?`)
      .run(remote, branch);
  }

  /**
   * Prune `seen` rows for branches that no longer exist on the remote.
   * Call periodically (e.g. after branch discovery) with the set of
   * currently-known branches to prevent unbounded table growth.
   */
  pruneSeenBranches(remote: string, activeBranches: Set<string>): number {
    const rows = this.db
      .prepare(`SELECT remote, branch FROM seen WHERE remote = ?`)
      .all(remote) as Array<{ remote: string; branch: string }>;

    let pruned = 0;
    for (const row of rows) {
      if (!activeBranches.has(row.branch)) {
        this.removeSeen(row.remote, row.branch);
        pruned++;
      }
    }
    return pruned;
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a branch for merge processing.
   * Returns the job ID, or null if the exact (remote, branch, head_sha) already exists.
   */
  enqueue(
    remote: string,
    branch: string,
    headSha: string,
    priority = 0,
  ): number | null {
    const now = new Date().toISOString();
    try {
      const info = this.db
        .prepare(
          `INSERT INTO jobs (branch, remote, head_sha, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(branch, remote, headSha, priority, now, now);
      return Number(info.lastInsertRowid);
    } catch (err: any) {
      // UNIQUE constraint violation = already enqueued
      // Check for SQLite error code 19 (CONSTRAINT) or message fallback
      const code = err.code ?? err.errno;
      if (code === 19 || err.message?.includes("UNIQUE")) return null;
      throw err;
    }
  }

  // ── Claim next job ──────────────────────────────────────────────────────

  /**
   * Atomically claim the next queued job. Returns null if queue is empty.
   * Only one job can be `running` at a time.
   */
  claimNext(): MergeJob | null {
    const tx = this.db.transaction(() => {
      // Check no job is already running
      const running = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'running' LIMIT 1`)
        .get() as { id: number } | undefined;
      if (running) return null;

      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'queued'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get() as MergeJob | undefined;
      if (!row) return null;

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempts = attempts + 1,
               started_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, row.id);

      return {
        ...row,
        status: "running" as MergeJobStatus,
        attempts: row.attempts + 1,
        started_at: now,
        updated_at: now,
      };
    });

    return tx();
  }

  // ── Update job status ───────────────────────────────────────────────────

  markSuccess(jobId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'success', finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, jobId);
  }

  markFailed(jobId: number, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, now, now, jobId);
  }

  markSkipped(jobId: number, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'skipped', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, now, now, jobId);
  }

  // ── Requeue ─────────────────────────────────────────────────────────────

  /**
   * Re-queue a failed job (e.g. when main advanced mid-run).
   */
  requeue(jobId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, jobId);
  }

  // ── Query ───────────────────────────────────────────────────────────────

  getJob(jobId: number): MergeJob | null {
    return (
      (this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as MergeJob) ?? null
    );
  }

  getJobsByStatus(status: MergeJobStatus, limit?: number): MergeJob[] {
    if (limit != null && limit > 0) {
      return this.db
        .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`)
        .all(status, limit) as MergeJob[];
    }
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC`)
      .all(status) as MergeJob[];
  }

  getRecentJobs(limit = 50): MergeJob[] {
    return this.db
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as MergeJob[];
  }

  getQueuedCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM jobs WHERE status = 'queued'`)
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Get counts of jobs grouped by status. Efficient single-query scan.
   */
  getStatusCounts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status`)
      .all() as Array<{ status: string; cnt: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.cnt;
    }
    return counts;
  }

  // ── Job logs ────────────────────────────────────────────────────────────

  addLog(jobId: number, message: string, level: "info" | "warn" | "error" = "info"): void {
    this.db
      .prepare(`INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)`)
      .run(jobId, new Date().toISOString(), level, message);
  }

  getJobLogs(jobId: number, limit = 500): Array<{ ts: string; level: string; message: string }> {
    const safeLimit = Math.max(1, Math.min(limit, 2001));
    return this.db
      .prepare(`SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT ?`)
      .all(jobId, safeLimit) as Array<{ ts: string; level: string; message: string }>;
  }

  // ── Recovery ────────────────────────────────────────────────────────────

  /**
   * Recover any jobs stuck in 'running' state (e.g. after a daemon crash).
   * Resets them to 'queued' so the queue doesn't hard-deadlock.
   * Should be called once at startup, before the poll loop begins.
   */
  recoverStuckJobs(): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', started_at = NULL, updated_at = ?
         WHERE status = 'running'`,
      )
      .run(now);
    return info.changes;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
