import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export type JobStatus = "pending" | "claimed" | "completed" | "failed";
export type WorkerStatus = "idle" | "busy" | "error" | "offline";

export interface JobRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  status: JobStatus;
  workerId: string | null;
  targetWorkerId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkerDbRow {
  workerId: string;
  status: WorkerStatus;
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: string | null;
  details: string | null;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
}

export interface WorkerRow {
  workerId: string;
  status: WorkerStatus;
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: Record<string, unknown>;
  details: Record<string, unknown>;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
  isOnline: boolean;
}

export interface RecoveredStaleJob {
  jobId: string;
  taskId: string;
  sessionId: string;
  workerId: string | null;
  message: string;
  detail: string;
  recoveredAt: string;
}

function parseObjectJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeWorkerStatus(value: unknown): WorkerStatus {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "busy" || text === "error" || text === "offline") {
    return text;
  }
  return "idle";
}

export class JobQueue {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id             TEXT PRIMARY KEY,
        taskId         TEXT NOT NULL,
        sessionId      TEXT NOT NULL DEFAULT '',
        kind           TEXT NOT NULL,
        params         TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL DEFAULT 'pending',
        workerId       TEXT,
        targetWorkerId TEXT,
        result         TEXT,
        error          TEXT,
        createdAt      TEXT NOT NULL,
        updatedAt      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs(taskId);
      CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);

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

      CREATE TABLE IF NOT EXISTS workers (
        workerId      TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'idle',
        currentJobId  TEXT,
        pollMs        INTEGER,
        capabilities  TEXT,
        details       TEXT,
        lastHeartbeat TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_last_heartbeat ON workers(lastHeartbeat);
    `);

    const jobColumns = this.db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!jobColumns.some((col) => col.name === "targetWorkerId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN targetWorkerId TEXT;`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);`);
    }
  }

  enqueue(body: Record<string, unknown>): { ok: boolean; jobId?: string; message?: string } {
    const taskId = body.taskId as string;
    const kind = body.kind as string;
    const sessionId = (body.sessionId as string) ?? "";
    const params = body.params ?? {};
    const targetWorkerIdRaw = body.targetWorkerId;
    const targetWorkerId =
      typeof targetWorkerIdRaw === "string" && targetWorkerIdRaw.trim().length > 0
        ? targetWorkerIdRaw.trim()
        : null;

    if (!taskId || !kind) {
      return { ok: false, message: "taskId and kind are required" };
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO jobs (id, taskId, sessionId, kind, params, status, workerId, targetWorkerId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      )
      .run(jobId, taskId, sessionId, kind, JSON.stringify(params), targetWorkerId, now, now);

    return { ok: true, jobId };
  }

  claim(workerIdRaw: string): { ok: boolean; job?: JobRow; message?: string } {
    const workerId = workerIdRaw.trim() || "unknown";
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
           VALUES (?, 'idle', NULL, NULL, '{}', '{}', ?, ?, ?)
           ON CONFLICT(workerId) DO UPDATE SET
             lastHeartbeat = excluded.lastHeartbeat,
             updatedAt = excluded.updatedAt`,
        )
        .run(workerId, now, now, now);

      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending'
             AND (targetWorkerId IS NULL OR targetWorkerId = ?)
           ORDER BY CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END, createdAt ASC
           LIMIT 1`,
        )
        .get(workerId, workerId) as JobRow | undefined;

      if (!row) {
        this.db
          .prepare(
            `UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`,
          )
          .run(now, now, workerId);
        return null;
      }

      this.db
        .prepare(`UPDATE jobs SET status = 'claimed', workerId = ?, updatedAt = ? WHERE id = ?`)
        .run(workerId, now, row.id);

      this.db
        .prepare(
          `UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
           WHERE workerId = ?`,
        )
        .run(row.id, now, now, workerId);

      return { ...row, status: "claimed" as JobStatus, workerId, updatedAt: now };
    });

    const job = tx();
    if (!job) return { ok: false, message: "No pending jobs" };
    return { ok: true, job };
  }

  heartbeat(body: Record<string, unknown>): { ok: boolean; message?: string } {
    const workerIdRaw = body.workerId;
    if (typeof workerIdRaw !== "string" || workerIdRaw.trim().length === 0) {
      return { ok: false, message: "workerId is required" };
    }
    const workerId = workerIdRaw.trim();
    const status = normalizeWorkerStatus(body.status);
    const currentJobId =
      typeof body.currentJobId === "string" && body.currentJobId.trim().length > 0
        ? body.currentJobId.trim()
        : null;
    const pollMs =
      typeof body.pollMs === "number" && Number.isFinite(body.pollMs)
        ? Math.max(0, body.pollMs)
        : null;
    const capabilities = JSON.stringify(
      body.capabilities &&
        typeof body.capabilities === "object" &&
        !Array.isArray(body.capabilities)
        ? body.capabilities
        : {},
    );
    const details = JSON.stringify(
      body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? body.details
        : {},
    );
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO workers (workerId, status, currentJobId, pollMs, capabilities, details, lastHeartbeat, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET
           status = excluded.status,
           currentJobId = excluded.currentJobId,
           pollMs = excluded.pollMs,
           capabilities = excluded.capabilities,
           details = excluded.details,
           lastHeartbeat = excluded.lastHeartbeat,
           updatedAt = excluded.updatedAt`,
      )
      .run(workerId, status, currentJobId, pollMs, capabilities, details, now, now, now);

    return { ok: true };
  }

  listWorkers(onlineTtlMs: number = 15_000): WorkerRow[] {
    const ttl = Number.isFinite(onlineTtlMs) ? Math.max(1_000, Math.floor(onlineTtlMs)) : 15_000;
    const nowMs = Date.now();

    const rows = this.db
      .prepare(
        `SELECT
           w.workerId,
           w.status,
           w.currentJobId,
           w.pollMs,
           w.capabilities,
           w.details,
           w.lastHeartbeat,
           w.createdAt,
           w.updatedAt,
           COALESCE(claimed.activeJobCount, 0) AS activeJobCount
         FROM workers w
         LEFT JOIN (
           SELECT workerId, COUNT(*) AS activeJobCount
           FROM jobs
           WHERE status = 'claimed'
           GROUP BY workerId
         ) claimed ON claimed.workerId = w.workerId
         ORDER BY w.lastHeartbeat DESC, w.workerId ASC`,
      )
      .all() as WorkerDbRow[];

    return rows.map((row) => {
      const heartbeatMs = Date.parse(row.lastHeartbeat);
      const isOnline = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs <= ttl;
      return {
        workerId: row.workerId,
        status: row.status,
        currentJobId: row.currentJobId,
        pollMs: row.pollMs,
        capabilities: parseObjectJson(row.capabilities),
        details: parseObjectJson(row.details),
        lastHeartbeat: row.lastHeartbeat,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        activeJobCount: Number(row.activeJobCount || 0),
        isOnline,
      };
    });
  }

  complete(jobId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const summary = (body.summary as string) ?? null;
    const artifacts = body.artifacts ? JSON.stringify(body.artifacts) : null;

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs SET status = 'completed', result = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ summary, artifacts }), now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return { ok: true };
  }

  fail(jobId: string, body: Record<string, unknown>): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const message = (body.message as string) ?? "Unknown error";
    const detail = (body.detail as string) ?? null;

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?, updatedAt = ? WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail }), now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return { ok: true };
  }

  recoverStaleClaimedJobs(staleAfterMs: number, limit = 100): RecoveredStaleJob[] {
    const ttlMs = Number.isFinite(staleAfterMs) ? Math.max(5_000, Math.floor(staleAfterMs)) : 120_000;
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const cutoff = new Date(Date.now() - ttlMs).toISOString();

    type StaleCandidate = {
      jobId: string;
      taskId: string;
      sessionId: string;
      workerId: string | null;
      jobUpdatedAt: string;
      workerLastHeartbeat: string | null;
    };

    const candidates = this.db
      .prepare(
        `SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.workerId AS workerId,
           j.updatedAt AS jobUpdatedAt,
           w.lastHeartbeat AS workerLastHeartbeat
         FROM jobs j
         LEFT JOIN workers w ON w.workerId = j.workerId
         WHERE j.status = 'claimed'
           AND j.updatedAt < ?
           AND (
             j.workerId IS NULL
             OR w.workerId IS NULL
             OR w.lastHeartbeat < ?
           )
         ORDER BY j.updatedAt ASC
         LIMIT ?`,
      )
      .all(cutoff, cutoff, maxRows) as StaleCandidate[];

    if (candidates.length === 0) return [];

    const now = new Date().toISOString();
    const recovered: RecoveredStaleJob[] = [];

    const tx = this.db.transaction((rows: StaleCandidate[]) => {
      for (const row of rows) {
        const message = "Job auto-failed after stale worker claim";
        const detailParts = [
          row.workerId ? `worker=${row.workerId}` : "worker=missing",
          row.workerLastHeartbeat
            ? `lastHeartbeat=${row.workerLastHeartbeat}`
            : "lastHeartbeat=missing",
          `jobUpdatedAt=${row.jobUpdatedAt}`,
          `staleAfterMs=${ttlMs}`,
        ];
        const detail = detailParts.join("; ");

        const info = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'failed', error = ?, updatedAt = ?
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(JSON.stringify({ message, detail }), now, row.jobId);

        if (info.changes === 0) continue;

        if (row.workerId) {
          this.db
            .prepare(
              `UPDATE workers
               SET status = 'offline',
                   currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                   updatedAt = ?
               WHERE workerId = ?`,
            )
            .run(row.jobId, now, row.workerId);
        }

        recovered.push({
          jobId: row.jobId,
          taskId: row.taskId,
          sessionId: row.sessionId,
          workerId: row.workerId,
          message,
          detail,
          recoveredAt: now,
        });
      }
    });

    tx(candidates);
    return recovered;
  }

  private setWorkerIdleIfNoClaimedJobs(workerId: string | null, now: string): void {
    if (!workerId) return;
    const active = this.db
      .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE workerId = ? AND status = 'claimed'`)
      .get(workerId) as { c: number } | undefined;
    if ((active?.c ?? 0) > 0) return;

    this.db
      .prepare(
        `UPDATE workers SET status = 'idle', currentJobId = NULL, lastHeartbeat = ?, updatedAt = ?
         WHERE workerId = ?`,
      )
      .run(now, now, workerId);
  }

  getJob(jobId: string): JobRow | null {
    return (this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as JobRow) ?? null;
  }

  getPendingJobs(): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY createdAt ASC`)
      .all() as JobRow[];
  }

  listJobs(options?: {
    status?: JobStatus | "all";
    limit?: number;
  }): JobRow[] {
    const status = options?.status ?? "all";
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.max(1, Math.min(500, Math.floor(options.limit)))
        : 200;

    if (status === "all") {
      return this.db
        .prepare(`SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?`)
        .all(limit) as JobRow[];
    }

    return this.db
      .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY createdAt DESC LIMIT ?`)
      .all(status, limit) as JobRow[];
  }

  countByStatus(): Record<JobStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`)
      .all() as Array<{ status: JobStatus; count: number }>;

    const counts: Record<JobStatus, number> = {
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

  addLog(jobId: string, message: string): void {
    this.db
      .prepare(`INSERT INTO job_logs (jobId, ts, message) VALUES (?, ?, ?)`)
      .run(jobId, new Date().toISOString(), message);
  }
}
