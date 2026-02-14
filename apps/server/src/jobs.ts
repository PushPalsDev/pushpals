import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export type JobStatus = "pending" | "claimed" | "completed" | "failed";
export type WorkerStatus = "idle" | "busy" | "error" | "offline";
export type JobPriority = "interactive" | "normal" | "background";

const JOB_PRIORITY_ORDER: JobPriority[] = ["interactive", "normal", "background"];
const JOB_PRIORITY_QUEUE_SLA_MS: Record<JobPriority, number> = {
  interactive: 20_000,
  normal: 90_000,
  background: 240_000,
};
const JOB_EXECUTION_BUDGET_MS: Record<JobPriority, number> = {
  interactive: 300_000,
  normal: 900_000,
  background: 1_800_000,
};
const JOB_FINALIZATION_BUDGET_MS_DEFAULT = 120_000;

export interface JobRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  priority: JobPriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  status: JobStatus;
  workerId: string | null;
  targetWorkerId: string | null;
  result: string | null;
  error: string | null;
  enqueuedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  firstLogAt: string | null;
  failedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobLogRow {
  id: number;
  jobId: string;
  ts: string;
  message: string;
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

export interface JobSloMetricSummary {
  p50: number | null;
  p95: number | null;
  avg: number | null;
  sampleSize: number;
}

export interface JobSloSummary {
  windowHours: number;
  terminal: number;
  completed: number;
  failed: number;
  timeoutFailures: number;
  successRate: number | null;
  timeoutRate: number | null;
  durationMs: JobSloMetricSummary;
  queueWaitMs: JobSloMetricSummary;
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

function normalizeJobPriority(value: unknown): JobPriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
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

function summarizeSamples(samples: number[]): JobSloMetricSummary {
  const valid = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (valid.length === 0) return { p50: null, p95: null, avg: null, sampleSize: 0 };
  const avg = Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
  return {
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    avg: Number.isFinite(avg) ? avg : null,
    sampleSize: valid.length,
  };
}

function isTimeoutFailureError(errorPayload: string | null): boolean {
  if (!errorPayload) return false;
  let haystack = errorPayload;
  try {
    const parsed = JSON.parse(errorPayload) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      haystack =
        `${String(record.message ?? "")} ${String(record.detail ?? "")}`.trim() || errorPayload;
    }
  } catch {
    // Keep raw payload fallback.
  }
  return /\b(timeout|timed out|deadline exceeded|stale worker claim|heartbeat stale|watchdog)\b/i.test(
    haystack,
  );
}

function extractPlanningField(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const planning = (params as Record<string, unknown>).planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning)) return undefined;
  return (planning as Record<string, unknown>)[key];
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
          id                  TEXT PRIMARY KEY,
          taskId              TEXT NOT NULL,
          sessionId           TEXT NOT NULL DEFAULT '',
          kind                TEXT NOT NULL,
          params              TEXT NOT NULL DEFAULT '{}',
          priority            TEXT NOT NULL DEFAULT 'normal',
          queueWaitBudgetMs   INTEGER NOT NULL DEFAULT 90000,
          executionBudgetMs   INTEGER NOT NULL DEFAULT 900000,
          finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000,
          status              TEXT NOT NULL DEFAULT 'pending',
          workerId            TEXT,
          targetWorkerId      TEXT,
          result              TEXT,
          error               TEXT,
          enqueuedAt          TEXT,
          claimedAt           TEXT,
          startedAt           TEXT,
          firstLogAt          TEXT,
          failedAt            TEXT,
          completedAt         TEXT,
          durationMs          INTEGER,
          createdAt           TEXT NOT NULL,
          updatedAt           TEXT NOT NULL
        );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_taskId ON jobs(taskId);
      CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(sessionId, createdAt);

      CREATE TABLE IF NOT EXISTS job_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        jobId   TEXT NOT NULL,
        ts      TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY (jobId) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(jobId, id);

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
    }
    if (!jobColumns.some((col) => col.name === "priority")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`);
    }
    if (!jobColumns.some((col) => col.name === "queueWaitBudgetMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN queueWaitBudgetMs INTEGER NOT NULL DEFAULT 90000;`);
    }
    if (!jobColumns.some((col) => col.name === "executionBudgetMs")) {
      this.db.exec(
        `ALTER TABLE jobs ADD COLUMN executionBudgetMs INTEGER NOT NULL DEFAULT 900000;`,
      );
    }
    if (!jobColumns.some((col) => col.name === "finalizationBudgetMs")) {
      this.db.exec(
        `ALTER TABLE jobs ADD COLUMN finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000;`,
      );
    }
    if (!jobColumns.some((col) => col.name === "enqueuedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN enqueuedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "claimedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN claimedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "startedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN startedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "firstLogAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN firstLogAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "failedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN failedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "completedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN completedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "durationMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN durationMs INTEGER;`);
    }

    // Column-dependent indexes are created after legacy column backfills complete.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(status, priority, createdAt);`,
    );

    this.db.exec(`
      UPDATE jobs
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        queueWaitBudgetMs = CASE WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000 ELSE queueWaitBudgetMs END,
        executionBudgetMs = CASE WHEN executionBudgetMs IS NULL OR executionBudgetMs <= 0 THEN 900000 ELSE executionBudgetMs END,
        finalizationBudgetMs = CASE WHEN finalizationBudgetMs IS NULL OR finalizationBudgetMs <= 0 THEN 120000 ELSE finalizationBudgetMs END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
  }

  private pendingOrderedIds(targetWorkerId: string | null = null): string[] {
    if (targetWorkerId) {
      const rows = this.db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'pending' AND (targetWorkerId IS NULL OR targetWorkerId = ?)
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC`,
        )
        .all(targetWorkerId, targetWorkerId) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    }

    const rows = this.db
      .prepare(
        `SELECT id
         FROM jobs
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

  private queuePosition(jobId: string, targetWorkerId: string | null = null): number | null {
    const ordered = this.pendingOrderedIds(targetWorkerId);
    const idx = ordered.indexOf(jobId);
    if (idx < 0) return null;
    return idx + 1;
  }

  estimateEtaMs(priority: JobPriority, position: number | null): number | null {
    if (!position || position <= 0) return null;
    const slotMs = JOB_PRIORITY_QUEUE_SLA_MS[priority];
    return Math.max(0, slotMs * (position - 1));
  }

  enqueue(body: Record<string, unknown>): {
    ok: boolean;
    jobId?: string;
    queuePosition?: number;
    etaMs?: number;
    message?: string;
  } {
    const taskId = String(body.taskId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    const sessionId = String(body.sessionId ?? "").trim();
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const targetWorkerIdRaw = body.targetWorkerId;
    const targetWorkerId =
      typeof targetWorkerIdRaw === "string" && targetWorkerIdRaw.trim().length > 0
        ? targetWorkerIdRaw.trim()
        : null;

    if (!taskId || !kind) {
      return { ok: false, message: "taskId and kind are required" };
    }

    const priority = normalizeJobPriority(
      body.priority ?? extractPlanningField(params, "queuePriority"),
    );
    const queueWaitBudgetMs = parseBudgetMs(
      body.queueWaitBudgetMs ?? extractPlanningField(params, "queueWaitBudgetMs"),
      JOB_PRIORITY_QUEUE_SLA_MS[priority],
    );
    const executionBudgetMs = parseBudgetMs(
      body.executionBudgetMs ?? extractPlanningField(params, "executionBudgetMs"),
      JOB_EXECUTION_BUDGET_MS[priority],
    );
    const finalizationBudgetMs = parseBudgetMs(
      body.finalizationBudgetMs ?? extractPlanningField(params, "finalizationBudgetMs"),
      JOB_FINALIZATION_BUDGET_MS_DEFAULT,
    );

    const jobId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO jobs (
          id, taskId, sessionId, kind, params, priority,
          queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
          status, workerId, targetWorkerId, result, error,
          enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, completedAt, durationMs,
          createdAt, updatedAt
        )
         VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          'pending', NULL, ?, NULL, NULL,
          ?, NULL, NULL, NULL, NULL, NULL, NULL,
          ?, ?
         )`,
      )
      .run(
        jobId,
        taskId,
        sessionId,
        kind,
        JSON.stringify(params),
        priority,
        queueWaitBudgetMs,
        executionBudgetMs,
        finalizationBudgetMs,
        targetWorkerId,
        now,
        now,
        now,
      );

    const queuePosition = this.queuePosition(jobId, targetWorkerId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);
    return {
      ok: true,
      jobId,
      queuePosition: queuePosition ?? undefined,
      etaMs: etaMs ?? undefined,
    };
  }

  claim(workerIdRaw: string): {
    ok: boolean;
    job?: JobRow;
    queueWaitMs?: number;
    message?: string;
  } {
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
           ORDER BY
             CASE WHEN targetWorkerId = ? THEN 0 ELSE 1 END ASC,
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END ASC,
             createdAt ASC
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
        .prepare(
          `UPDATE jobs
           SET status = 'claimed',
               workerId = ?,
               claimedAt = ?,
               startedAt = COALESCE(startedAt, ?),
               failedAt = NULL,
               completedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
            WHERE id = ?`,
        )
        .run(workerId, now, now, now, row.id);

      this.db
        .prepare(
          `UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
           WHERE workerId = ?`,
        )
        .run(row.id, now, now, workerId);

      const queueWaitMs = Math.max(
        0,
        Math.floor(Date.parse(now) - Date.parse(row.enqueuedAt || row.createdAt || now) || 0),
      );

      return {
        job: {
          ...row,
          status: "claimed" as JobStatus,
          workerId,
          claimedAt: now,
          startedAt: row.startedAt || now,
          failedAt: null,
          completedAt: null,
          durationMs: null,
          updatedAt: now,
        },
        queueWaitMs,
      };
    });

    const claimed = tx();
    if (!claimed) return { ok: false, message: "No pending jobs" };
    return { ok: true, job: claimed.job, queueWaitMs: claimed.queueWaitMs };
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

  complete(
    jobId: string,
    body: Record<string, unknown>,
  ): { ok: boolean; message?: string; durationMs?: number; completedAt?: string } {
    const now = new Date().toISOString();
    const summary = (body.summary as string) ?? null;
    const artifacts = body.artifacts ? JSON.stringify(body.artifacts) : null;

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             result = ?,
             completedAt = ?,
             failedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ summary, artifacts }), now, now, now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    const completed = this.db
      .prepare(`SELECT durationMs, completedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          completedAt: string | null;
        }
      | undefined;

    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: completed?.durationMs ?? undefined,
      completedAt: completed?.completedAt ?? undefined,
    };
  }

  fail(
    jobId: string,
    body: Record<string, unknown>,
  ): { ok: boolean; message?: string; durationMs?: number; failedAt?: string } {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             completedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail }), now, now, now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    const failed = this.db
      .prepare(`SELECT durationMs, failedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          failedAt: string | null;
        }
      | undefined;

    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: failed?.durationMs ?? undefined,
      failedAt: failed?.failedAt ?? undefined,
    };
  }

  recoverStaleClaimedJobs(staleAfterMs: number, limit = 100): RecoveredStaleJob[] {
    const ttlMs = Number.isFinite(staleAfterMs)
      ? Math.max(5_000, Math.floor(staleAfterMs))
      : 120_000;
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - ttlMs).toISOString();

    type StaleCandidate = {
      jobId: string;
      taskId: string;
      sessionId: string;
      executionBudgetMs: number | null;
      finalizationBudgetMs: number | null;
      workerId: string | null;
      workerStatus: string | null;
      workerCurrentJobId: string | null;
      workerLastHeartbeat: string | null;
      jobUpdatedAt: string;
      lastLogTs: string | null;
      activityAt: string;
    };

    const candidates = this.db
      .prepare(
        `SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.executionBudgetMs AS executionBudgetMs,
           j.finalizationBudgetMs AS finalizationBudgetMs,
           j.workerId AS workerId,
           w.status AS workerStatus,
           w.currentJobId AS workerCurrentJobId,
           w.lastHeartbeat AS workerLastHeartbeat,
           j.updatedAt AS jobUpdatedAt,
           (
             SELECT MAX(jl.ts)
             FROM job_logs jl
             WHERE jl.jobId = j.id
           ) AS lastLogTs,
           COALESCE(
             (
               SELECT MAX(jl.ts)
               FROM job_logs jl
               WHERE jl.jobId = j.id
             ),
             j.firstLogAt,
             j.startedAt,
             j.claimedAt,
             j.updatedAt
           ) AS activityAt
         FROM jobs j
         LEFT JOIN workers w ON w.workerId = j.workerId
         WHERE j.status = 'claimed'
         ORDER BY activityAt ASC
         LIMIT ?`,
      )
      .all(maxRows) as StaleCandidate[];

    if (candidates.length === 0) return [];

    const now = new Date().toISOString();
    const recovered: RecoveredStaleJob[] = [];

    const tx = this.db.transaction((rows: StaleCandidate[]) => {
      for (const row of rows) {
        const activityMs = parseIsoMs(row.activityAt) ?? parseIsoMs(row.jobUpdatedAt) ?? nowMs;
        const heartbeatMs = parseIsoMs(row.workerLastHeartbeat);
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        const heartbeatAgeMs =
          heartbeatMs == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - heartbeatMs);

        const workerAligned =
          !!row.workerId && row.workerStatus === "busy" && row.workerCurrentJobId === row.jobId;

        const executionBudgetMs =
          typeof row.executionBudgetMs === "number" && Number.isFinite(row.executionBudgetMs)
            ? Math.max(5_000, Math.floor(row.executionBudgetMs))
            : JOB_EXECUTION_BUDGET_MS.normal;
        const finalizationBudgetMs =
          typeof row.finalizationBudgetMs === "number" && Number.isFinite(row.finalizationBudgetMs)
            ? Math.max(5_000, Math.floor(row.finalizationBudgetMs))
            : JOB_FINALIZATION_BUDGET_MS_DEFAULT;
        const combinedBudgetMs = executionBudgetMs + finalizationBudgetMs;

        // Busy workers assigned to the current job are given a longer grace window
        // before stale recovery kicks in, to avoid false positives on long-running tasks
        // with sparse logs/heartbeats.
        const alignedGraceMs = Math.max(ttlMs, Math.min(combinedBudgetMs, ttlMs * 5));
        const effectiveStaleAfterMs = workerAligned ? alignedGraceMs : ttlMs;
        if (activityAgeMs < effectiveStaleAfterMs) continue;
        if (workerAligned && heartbeatAgeMs < effectiveStaleAfterMs) continue;

        const message = "Job auto-failed after stale worker claim";
        const detailParts = [
          row.workerId ? `worker=${row.workerId}` : "worker=missing",
          row.workerStatus ? `workerStatus=${row.workerStatus}` : "workerStatus=missing",
          row.workerCurrentJobId
            ? `workerCurrentJobId=${row.workerCurrentJobId}`
            : "workerCurrentJobId=missing",
          row.workerLastHeartbeat
            ? `lastHeartbeat=${row.workerLastHeartbeat}`
            : "lastHeartbeat=missing",
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.jobUpdatedAt}`,
          `workerAligned=${workerAligned ? "yes" : "no"}`,
          `activityAgeMs=${activityAgeMs}`,
          `heartbeatAgeMs=${Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : -1}`,
          `staleAfterMs=${ttlMs}`,
          `effectiveStaleAfterMs=${effectiveStaleAfterMs}`,
        ];
        const detail = detailParts.join("; ");

        const info = this.db
          .prepare(
            `UPDATE jobs
             SET status = 'failed',
                 error = ?,
                 failedAt = ?,
                 completedAt = NULL,
                 durationMs = MAX(
                   0,
                   CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
                 ),
                 updatedAt = ?
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(JSON.stringify({ message, detail }), now, now, now, row.jobId);

        if (info.changes === 0) continue;

        if (row.workerId) {
          const staleHeartbeat =
            heartbeatMs == null ||
            !Number.isFinite(heartbeatMs) ||
            Number.isNaN(heartbeatMs) ||
            heartbeatMs < Date.parse(cutoff);
          const nextStatus: WorkerStatus = staleHeartbeat ? "offline" : "error";
          this.db
            .prepare(
              `UPDATE workers
               SET status = ?,
                   currentJobId = CASE WHEN currentJobId = ? THEN NULL ELSE currentJobId END,
                   updatedAt = ?
               WHERE workerId = ?`,
            )
            .run(nextStatus, row.jobId, now, row.workerId);
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
      .prepare(
        `SELECT * FROM jobs
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
      .all() as JobRow[];
  }

  listJobs(options?: { status?: JobStatus | "all"; limit?: number }): JobRow[] {
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

  countByPriority(): Record<JobPriority, number> {
    const rows = this.db
      .prepare(
        `SELECT priority, COUNT(*) AS count
         FROM jobs
         WHERE status IN ('pending', 'claimed')
         GROUP BY priority`,
      )
      .all() as Array<{ priority: string; count: number }>;

    const counts: Record<JobPriority, number> = {
      interactive: 0,
      normal: 0,
      background: 0,
    };
    for (const row of rows) {
      const priority = normalizeJobPriority(row.priority);
      counts[priority] = Number(row.count || 0);
    }
    return counts;
  }

  nextPendingSnapshot(
    limit = 10,
  ): Array<{ id: string; priority: JobPriority; position: number; etaMs: number }> {
    const ordered = this.pendingOrderedIds().slice(0, Math.max(1, Math.min(limit, 50)));
    return ordered.map((id, idx) => {
      const row = this.db.prepare(`SELECT priority FROM jobs WHERE id = ?`).get(id) as
        | { priority: string }
        | undefined;
      const priority = normalizeJobPriority(row?.priority);
      return {
        id,
        priority,
        position: idx + 1,
        etaMs: this.estimateEtaMs(priority, idx + 1) ?? 0,
      };
    });
  }

  sloSummary(windowHours = 24): JobSloSummary {
    const boundedWindowHours =
      Number.isFinite(windowHours) && windowHours > 0
        ? Math.max(1, Math.min(24 * 30, Math.floor(windowHours)))
        : 24;
    const cutoffIso = new Date(Date.now() - boundedWindowHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT status, durationMs, enqueuedAt, claimedAt, createdAt, updatedAt, error
         FROM jobs
         WHERE status IN ('completed', 'failed')
           AND updatedAt >= ?`,
      )
      .all(cutoffIso) as Array<{
      status: JobStatus;
      durationMs: number | null;
      enqueuedAt: string | null;
      claimedAt: string | null;
      createdAt: string | null;
      updatedAt: string | null;
      error: string | null;
    }>;

    let completed = 0;
    let failed = 0;
    let timeoutFailures = 0;
    const durationSamples: number[] = [];
    const queueWaitSamples: number[] = [];

    for (const row of rows) {
      if (row.status === "completed") completed += 1;
      if (row.status === "failed") {
        failed += 1;
        if (isTimeoutFailureError(row.error)) timeoutFailures += 1;
      }
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
    const timeoutRate = terminal > 0 ? Number((timeoutFailures / terminal).toFixed(4)) : null;

    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      timeoutFailures,
      successRate,
      timeoutRate,
      durationMs: summarizeSamples(durationSamples),
      queueWaitMs: summarizeSamples(queueWaitSamples),
    };
  }

  addLog(jobId: string, message: string): number | null {
    const now = new Date().toISOString();
    let insertedId: number | null = null;
    const tx = this.db.transaction(() => {
      const insertInfo = this.db
        .prepare(`INSERT INTO job_logs (jobId, ts, message) VALUES (?, ?, ?)`)
        .run(jobId, now, message);
      const rawId = (insertInfo as { lastInsertRowid?: unknown }).lastInsertRowid;
      if (typeof rawId === "bigint") insertedId = Number(rawId);
      else if (typeof rawId === "number" && Number.isFinite(rawId)) insertedId = rawId;
      this.db
        .prepare(
          `UPDATE jobs
           SET updatedAt = ?,
               startedAt = COALESCE(startedAt, ?),
               firstLogAt = COALESCE(firstLogAt, ?)
           WHERE id = ? AND status = 'claimed'`,
        )
        .run(now, now, now, jobId);
    });
    tx();
    return insertedId;
  }

  listJobLogs(jobId: string, limit = 50, afterId?: number): JobLogRow[] {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
    if (Number.isFinite(afterId as number) && (afterId as number) > 0) {
      return this.db
        .prepare(
          `SELECT id, jobId, ts, message
           FROM job_logs
           WHERE jobId = ? AND id > ?
           ORDER BY id ASC
           LIMIT ?`,
        )
        .all(jobId, Math.floor(afterId as number), maxRows) as JobLogRow[];
    }
    const rows = this.db
      .prepare(
        `SELECT id, jobId, ts, message
         FROM job_logs
         WHERE jobId = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(jobId, maxRows) as JobLogRow[];
    return rows.reverse();
  }
}
