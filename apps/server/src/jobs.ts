import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export type JobStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "abandoned"
  | "publish_blocked";
export type WorkerStatus = "idle" | "busy" | "error" | "offline";
export type JobPriority = "interactive" | "normal" | "background";
export type JobRetrySafety = "retry_safe" | "manual_retry_required";
type JobRecoveryReason = "worker_heartbeat_mismatch" | "stale_worker_claim";

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
const PR_WORKER_ASSIGNMENT_MAX_AGE_MS = 120_000;
const ORPHANED_CLAIM_HEARTBEAT_GRACE_MS = 15_000;
const RETRY_SAFE_REQUEUE_DELAY_MS = 5_000;

export interface JobRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  dedupeKey: string | null;
  dedupeCooldownMs: number;
  priority: JobPriority;
  queueWaitBudgetMs: number;
  executionBudgetMs: number;
  finalizationBudgetMs: number;
  status: JobStatus;
  workerId: string | null;
  targetWorkerId: string | null;
  result: string | null;
  prUrl: string | null;
  error: string | null;
  availableAt: string | null;
  enqueuedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  firstLogAt: string | null;
  failedAt: string | null;
  abandonedAt: string | null;
  publishBlockedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  resumeOfJobId: string | null;
  attempt: number;
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

interface ClaimedJobActivityRow {
  jobId: string;
  taskId: string;
  sessionId: string;
  updatedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  firstLogAt: string | null;
  lastLogTs: string | null;
  activityAt: string;
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
  action: "failed" | "requeued";
  finalStatus: "failed" | "abandoned";
  retrySafety: JobRetrySafety;
  replacementJobId?: string;
  replacementAvailableAt?: string | null;
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
  abandoned: number;
  publishBlocked: number;
  timeoutFailures: number;
  successRate: number | null;
  timeoutRate: number | null;
  durationMs: JobSloMetricSummary;
  queueWaitMs: JobSloMetricSummary;
}

export type WorkerPrMergeState = "open_unmerged" | "merged" | "closed_unmerged";

export interface WorkerPrBacklogEntry {
  prUrl: string;
  normalizedPrUrl: string;
  latestJobId: string;
  latestJobStatus: JobStatus;
  latestJobAt: string;
  latestFeedbackVerdict: string | null;
  latestFeedbackAt: string | null;
  mergeState: WorkerPrMergeState;
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

function parseDedupeCooldownMs(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.min(parsed, 10 * 60 * 1000));
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function coerceIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
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

function parseJobParamsRecord(value: string | null): Record<string, unknown> {
  return parseObjectJson(value);
}

function extractResolutionType(params: Record<string, unknown>): string | null {
  const direct = params.resolutionType;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const reviewAgent = params.reviewAgent;
  if (reviewAgent && typeof reviewAgent === "object" && !Array.isArray(reviewAgent)) {
    const nested = (reviewAgent as Record<string, unknown>).resolutionType;
    if (typeof nested === "string" && nested.trim()) return nested.trim().toLowerCase();
  }
  return null;
}

function classifyJobRetrySafety(
  kind: string,
  params: Record<string, unknown>,
): { retrySafety: JobRetrySafety; reason: string } {
  const explicit = String(params.retrySafety ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "retry_safe" || explicit === "retry-safe" || explicit === "safe") {
    return {
      retrySafety: "retry_safe",
      reason: "params.retrySafety explicitly marked this job retry-safe",
    };
  }
  if (
    explicit === "manual_retry_required" ||
    explicit === "manual-retry-required" ||
    explicit === "unsafe" ||
    explicit === "non_idempotent"
  ) {
    return {
      retrySafety: "manual_retry_required",
      reason: "params.retrySafety explicitly marked this job non-idempotent",
    };
  }
  if (kind === "warmup.execute") {
    return {
      retrySafety: "retry_safe",
      reason: "warmup.execute is side-effect free and safe to restart from scratch",
    };
  }
  if (kind === "task.execute") {
    const resolutionType = extractResolutionType(params);
    if (resolutionType === "merge_conflict") {
      return {
        retrySafety: "manual_retry_required",
        reason: "merge_conflict task.execute may rewrite rebase or branch state before abandonment",
      };
    }
    if (resolutionType === "review_fix") {
      return {
        retrySafety: "manual_retry_required",
        reason: "review_fix task.execute may create follow-up commit or PR side effects",
      };
    }
    return {
      retrySafety: "manual_retry_required",
      reason: "task.execute may mutate repository or publish side effects and is not auto-requeue safe",
    };
  }
  return {
    retrySafety: "manual_retry_required",
    reason: `${kind || "unknown"} is not classified as retry-safe`,
  };
}

function buildResumeParams(
  params: Record<string, unknown>,
  recovery: {
    previousJobId: string;
    previousWorkerId: string | null;
    recoveredAt: string;
    reason: JobRecoveryReason;
    detail: string;
    retrySafety: JobRetrySafety;
    classificationReason: string;
    attempt: number;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const rawHistory = Array.isArray(next.resumeHistory) ? next.resumeHistory : [];
  const history = rawHistory
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .slice(-7) as Record<string, unknown>[];
  history.push({
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt,
  });
  next.resume = {
    strategy: "restart_after_abandonment",
    previousJobId: recovery.previousJobId,
    previousWorkerId: recovery.previousWorkerId,
    recoveredAt: recovery.recoveredAt,
    reason: recovery.reason,
    detail: recovery.detail,
    retrySafety: recovery.retrySafety,
    classificationReason: recovery.classificationReason,
    attempt: recovery.attempt,
  };
  next.resumeHistory = history;
  return next;
}

function extractPlanningField(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const planning = (params as Record<string, unknown>).planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning)) return undefined;
  return (planning as Record<string, unknown>)[key];
}

function normalizeDedupeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return key.slice(0, 512);
}

function normalizePrUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

function normalizePrFeedbackVerdict(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isMergedPrFeedbackVerdict(value: unknown): boolean {
  const verdict = normalizePrFeedbackVerdict(value);
  if (!verdict) return false;
  if (
    verdict.includes("unmergeable") ||
    verdict.includes("merge_conflict") ||
    verdict.includes("merge_failed")
  ) {
    return false;
  }
  return verdict.includes("merged");
}

function isClosedPrFeedbackVerdict(value: unknown): boolean {
  const verdict = normalizePrFeedbackVerdict(value);
  if (!verdict) return false;
  if (isMergedPrFeedbackVerdict(verdict)) return false;
  return verdict.includes("closed");
}

function extractReviewAgentPrUrl(params: Record<string, unknown>): string | null {
  const reviewAgent = params.reviewAgent;
  if (!reviewAgent || typeof reviewAgent !== "object" || Array.isArray(reviewAgent)) return null;
  return normalizePrUrl((reviewAgent as Record<string, unknown>).prUrl);
}

function resolveJobPrUrl(
  body: Record<string, unknown>,
  params: Record<string, unknown>,
): string | null {
  return normalizePrUrl(body.prUrl) ?? extractReviewAgentPrUrl(params);
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
          dedupeKey           TEXT,
          dedupeCooldownMs    INTEGER NOT NULL DEFAULT 0,
          priority            TEXT NOT NULL DEFAULT 'normal',
          queueWaitBudgetMs   INTEGER NOT NULL DEFAULT 90000,
          executionBudgetMs   INTEGER NOT NULL DEFAULT 900000,
          finalizationBudgetMs INTEGER NOT NULL DEFAULT 120000,
          status              TEXT NOT NULL DEFAULT 'pending',
          workerId            TEXT,
          targetWorkerId      TEXT,
          result              TEXT,
          prUrl               TEXT,
          error               TEXT,
          availableAt         TEXT,
          enqueuedAt          TEXT,
          claimedAt           TEXT,
          startedAt           TEXT,
          firstLogAt          TEXT,
          failedAt            TEXT,
          abandonedAt         TEXT,
          publishBlockedAt    TEXT,
          completedAt         TEXT,
          durationMs          INTEGER,
          resumeOfJobId       TEXT,
          attempt             INTEGER NOT NULL DEFAULT 1,
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

      CREATE TABLE IF NOT EXISTS pr_worker_assignments (
        prUrl         TEXT PRIMARY KEY,
        workerId      TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_worker_assignments_worker ON pr_worker_assignments(workerId);
    `);

    const jobColumns = this.db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!jobColumns.some((col) => col.name === "targetWorkerId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN targetWorkerId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "priority")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeKey")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeKey TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "dedupeCooldownMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN dedupeCooldownMs INTEGER NOT NULL DEFAULT 0;`);
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
    if (!jobColumns.some((col) => col.name === "abandonedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN abandonedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "publishBlockedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN publishBlockedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "completedAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN completedAt TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "durationMs")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN durationMs INTEGER;`);
    }
    if (!jobColumns.some((col) => col.name === "resumeOfJobId")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN resumeOfJobId TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "attempt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!jobColumns.some((col) => col.name === "prUrl")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN prUrl TEXT;`);
    }
    if (!jobColumns.some((col) => col.name === "availableAt")) {
      this.db.exec(`ALTER TABLE jobs ADD COLUMN availableAt TEXT;`);
    }

    // Column-dependent indexes are created after legacy column backfills complete.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_target_worker ON jobs(targetWorkerId);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_priority_created ON jobs(status, priority, createdAt);`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_available_at ON jobs(status, availableAt);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_created ON jobs(dedupeKey, createdAt);`,
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe_active
         ON jobs(dedupeKey)
       WHERE dedupeKey IS NOT NULL
         AND dedupeKey <> ''
         AND status IN ('pending','claimed');`,
    );

    this.db.exec(`
      UPDATE jobs
      SET
        priority = CASE LOWER(COALESCE(priority, 'normal'))
          WHEN 'interactive' THEN 'interactive'
          WHEN 'background' THEN 'background'
          ELSE 'normal'
        END,
        dedupeCooldownMs = CASE
          WHEN dedupeCooldownMs IS NULL OR dedupeCooldownMs < 0 THEN 0
          ELSE dedupeCooldownMs
        END,
        attempt = CASE WHEN attempt IS NULL OR attempt <= 0 THEN 1 ELSE attempt END,
        queueWaitBudgetMs = CASE WHEN queueWaitBudgetMs IS NULL OR queueWaitBudgetMs <= 0 THEN 90000 ELSE queueWaitBudgetMs END,
        executionBudgetMs = CASE WHEN executionBudgetMs IS NULL OR executionBudgetMs <= 0 THEN 900000 ELSE executionBudgetMs END,
        finalizationBudgetMs = CASE WHEN finalizationBudgetMs IS NULL OR finalizationBudgetMs <= 0 THEN 120000 ELSE finalizationBudgetMs END,
        enqueuedAt = COALESCE(enqueuedAt, createdAt)
      WHERE 1 = 1;
    `);
  }

  private assignedWorkerForPr(prUrl: string | null): string | null {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    if (!normalizedPrUrl) return null;
    const row = this.db
      .prepare(`SELECT workerId FROM pr_worker_assignments WHERE prUrl = ?`)
      .get(normalizedPrUrl) as { workerId: string | null } | undefined;
    const workerId = row?.workerId?.trim() ?? "";
    if (!workerId) return null;
    const worker = this.db
      .prepare(`SELECT status, lastHeartbeat FROM workers WHERE workerId = ?`)
      .get(workerId) as { status: string | null; lastHeartbeat: string | null } | undefined;
    if (!worker) return null;
    if (
      String(worker.status ?? "")
        .trim()
        .toLowerCase() === "offline"
    )
      return null;
    const heartbeatMs = parseIsoMs(worker.lastHeartbeat);
    if (heartbeatMs == null) return null;
    if (Date.now() - heartbeatMs > PR_WORKER_ASSIGNMENT_MAX_AGE_MS) return null;
    return workerId ? workerId : null;
  }

  private upsertPrWorkerAssignment(
    prUrl: string | null,
    workerId: string | null,
    now: string,
  ): void {
    const normalizedPrUrl = normalizePrUrl(prUrl);
    const normalizedWorkerId = typeof workerId === "string" ? workerId.trim() : "";
    if (!normalizedPrUrl || !normalizedWorkerId) return;
    this.db
      .prepare(
        `INSERT INTO pr_worker_assignments (prUrl, workerId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(prUrl) DO UPDATE SET
           workerId = excluded.workerId,
           updatedAt = excluded.updatedAt`,
      )
      .run(normalizedPrUrl, normalizedWorkerId, now, now);
  }

  private refreshPrWorkerAssignmentForJob(jobId: string, now: string): void {
    const row = this.db.prepare(`SELECT prUrl, workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { prUrl: string | null; workerId: string | null }
      | undefined;
    if (!row) return;
    this.upsertPrWorkerAssignment(row.prUrl, row.workerId, now);
  }

  private pendingOrderedIds(targetWorkerId: string | null = null): string[] {
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    if (targetWorkerId) {
      const rows = this.db
        .prepare(
          `SELECT id
           FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
               OR targetWorkerId = ?
               OR (
                 targetWorkerId IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM workers tw
                   WHERE tw.workerId = jobs.targetWorkerId
                     AND COALESCE(tw.status, 'idle') <> 'offline'
                     AND tw.lastHeartbeat >= ?
                 )
               )
             )
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
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
        .all(
          targetWorkerId,
          targetWorkerCutoff,
          now,
          targetWorkerId,
          targetWorkerCutoff,
          targetWorkerId,
          targetWorkerCutoff,
          targetWorkerId,
        ) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    }

    const rows = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
             OR (
               targetWorkerId IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )
         ORDER BY
           CASE LOWER(priority)
             WHEN 'interactive' THEN 0
             WHEN 'normal' THEN 1
             WHEN 'background' THEN 2
             ELSE 1
           END ASC,
           createdAt ASC`,
      )
      .all(now, targetWorkerCutoff, targetWorkerCutoff) as Array<{ id: string }>;
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
    taskId?: string;
    queuePosition?: number;
    etaMs?: number;
    deduped?: boolean;
    message?: string;
  } {
    const taskId = String(body.taskId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    const sessionId = String(body.sessionId ?? "").trim();
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const prUrl = resolveJobPrUrl(body, params);
    const targetWorkerIdRaw = body.targetWorkerId;
    const requestedTargetWorkerId =
      typeof targetWorkerIdRaw === "string" && targetWorkerIdRaw.trim().length > 0
        ? targetWorkerIdRaw.trim()
        : null;
    const targetWorkerId =
      requestedTargetWorkerId || (prUrl ? this.assignedWorkerForPr(prUrl) : null);

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
    const dedupeKey = normalizeDedupeKey(body.dedupeKey);
    const dedupeCooldownMs = parseDedupeCooldownMs(body.dedupeCooldownMs, dedupeKey ? 0 : 0);

    if (dedupeKey) {
      const active = this.db
        .prepare(
          `SELECT id, taskId
           FROM jobs
           WHERE dedupeKey = ?
             AND status IN ('pending', 'claimed')
           ORDER BY createdAt DESC
           LIMIT 1`,
        )
        .get(dedupeKey) as { id: string; taskId: string } | undefined;
      if (active?.id) {
        return {
          ok: true,
          jobId: active.id,
          taskId: active.taskId,
          deduped: true,
          message: `Active job already exists for dedupeKey ${dedupeKey}`,
        };
      }

      if (dedupeCooldownMs > 0) {
        const latest = this.db
          .prepare(
            `SELECT id, taskId, createdAt
             FROM jobs
             WHERE dedupeKey = ?
             ORDER BY createdAt DESC
             LIMIT 1`,
          )
          .get(dedupeKey) as { id: string; taskId: string; createdAt: string } | undefined;
        if (latest?.id) {
          const createdAtMs = parseIsoMs(latest.createdAt);
          if (createdAtMs != null && Date.now() - createdAtMs < dedupeCooldownMs) {
            return {
              ok: true,
              jobId: latest.id,
              taskId: latest.taskId,
              deduped: true,
              message: `Dedupe cooldown active for dedupeKey ${dedupeKey}`,
            };
          }
        }
      }
    }

    const jobId = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO jobs (
            id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
            queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
            status, workerId, targetWorkerId, result, prUrl, error,
            enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, completedAt, durationMs,
            createdAt, updatedAt
          )
           VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            'pending', NULL, ?, NULL, ?, NULL,
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
          dedupeKey,
          dedupeCooldownMs,
          priority,
          queueWaitBudgetMs,
          executionBudgetMs,
          finalizationBudgetMs,
          targetWorkerId,
          prUrl,
          now,
          now,
          now,
        );
    } catch (err: any) {
      const message = String(err?.message ?? err ?? "");
      if (dedupeKey && /UNIQUE constraint failed/i.test(message)) {
        const active = this.db
          .prepare(
            `SELECT id, taskId
             FROM jobs
             WHERE dedupeKey = ?
               AND status IN ('pending', 'claimed')
             ORDER BY createdAt DESC
             LIMIT 1`,
          )
          .get(dedupeKey) as { id: string; taskId: string } | undefined;
        if (active?.id) {
          return {
            ok: true,
            jobId: active.id,
            taskId: active.taskId,
            deduped: true,
            message: `Active job already exists for dedupeKey ${dedupeKey}`,
          };
        }
      }
      throw err;
    }

    const queuePosition = this.queuePosition(jobId, targetWorkerId);
    const etaMs = this.estimateEtaMs(priority, queuePosition);
    return {
      ok: true,
      jobId,
      taskId,
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
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();

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

      const existingClaim = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE workerId = ?
             AND status = 'claimed'
           ORDER BY COALESCE(startedAt, claimedAt, updatedAt, createdAt) ASC
           LIMIT 1`,
        )
        .get(workerId) as JobRow | undefined;

      if (existingClaim) {
        this.db
          .prepare(
            `UPDATE workers SET status = 'busy', currentJobId = ?, lastHeartbeat = ?, updatedAt = ?
             WHERE workerId = ?`,
          )
          .run(existingClaim.id, now, now, workerId);
        return {
          job: {
            ...existingClaim,
            workerId,
            status: "claimed" as JobStatus,
          },
          queueWaitMs: 0,
          reusedActiveClaim: true as const,
        };
      }

      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending'
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
             AND (
               availableAt IS NULL
               OR availableAt <= ?
               OR targetWorkerId = ?
               OR (
                 targetWorkerId IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM workers tw
                   WHERE tw.workerId = jobs.targetWorkerId
                     AND COALESCE(tw.status, 'idle') <> 'offline'
                     AND tw.lastHeartbeat >= ?
                 )
               )
             )
             AND (
               targetWorkerId IS NULL
               OR targetWorkerId = ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
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
        .get(
          workerId,
          targetWorkerCutoff,
          now,
          workerId,
          targetWorkerCutoff,
          workerId,
          targetWorkerCutoff,
          workerId,
        ) as JobRow | undefined;

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
               availableAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
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
      this.upsertPrWorkerAssignment(row.prUrl, workerId, now);

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
          publishBlockedAt: null,
          completedAt: null,
          durationMs: null,
          updatedAt: now,
        },
        queueWaitMs,
      };
    });

    const claimed = tx();
    if (!claimed) return { ok: false, message: "No pending jobs" };
    if ("reusedActiveClaim" in claimed) {
      return {
        ok: false,
        message: `Worker ${workerId} already has claimed job ${claimed.job.id}`,
      };
    }
    return { ok: true, job: claimed.job, queueWaitMs: claimed.queueWaitMs };
  }

  private recoverClaimedJob(
    jobId: string,
    now: string,
    options: {
      expectedWorkerId?: string | null;
      recoveryReason: JobRecoveryReason;
      failureMessage: string;
      abandonmentMessage: string;
      detail: string;
    },
  ): RecoveredStaleJob | null {
    const job = this.getJob(jobId);
    if (!job || job.status !== "claimed") return null;
    if (options.expectedWorkerId && job.workerId !== options.expectedWorkerId) return null;

    const params = parseJobParamsRecord(job.params);
    const { retrySafety, reason: classificationReason } = classifyJobRetrySafety(job.kind, params);
    const detailWithClassification = [
      options.detail,
      `retrySafety=${retrySafety}`,
      `classificationReason=${classificationReason}`,
    ].join("; ");

    if (retrySafety === "retry_safe") {
      const replacementJobId = randomUUID();
      const attempt = Math.max(1, Math.floor(Number(job.attempt || 1))) + 1;
      const replacementAvailableAt = new Date(
        Date.parse(now) + RETRY_SAFE_REQUEUE_DELAY_MS,
      ).toISOString();
      const replacementParams = buildResumeParams(params, {
        previousJobId: job.id,
        previousWorkerId: job.workerId,
        recoveredAt: now,
        reason: options.recoveryReason,
        detail: options.detail,
        retrySafety,
        classificationReason,
        attempt,
      });
      const nextTargetWorkerId =
        job.targetWorkerId && job.targetWorkerId !== job.workerId ? job.targetWorkerId : null;
      const abandonmentError = JSON.stringify({
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        replacementJobId,
        replacementAvailableAt,
      });
      const abandonedInfo = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'abandoned',
               error = ?,
               failedAt = NULL,
               abandonedAt = ?,
               publishBlockedAt = NULL,
               availableAt = NULL,
               completedAt = NULL,
               durationMs = MAX(
                 0,
                 CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
               ),
               updatedAt = ?
           WHERE id = ?
             AND status = 'claimed'
             AND (? IS NULL OR workerId = ?)` ,
        )
        .run(
          abandonmentError,
          now,
          now,
          now,
          job.id,
          options.expectedWorkerId ?? null,
          options.expectedWorkerId ?? null,
        );
      if (abandonedInfo.changes === 0) return null;

      this.db
        .prepare(
          `INSERT INTO jobs (
             id, taskId, sessionId, kind, params, dedupeKey, dedupeCooldownMs, priority,
             queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs,
             status, workerId, targetWorkerId, result, prUrl, error, availableAt,
             enqueuedAt, claimedAt, startedAt, firstLogAt, failedAt, abandonedAt, completedAt,
             durationMs, resumeOfJobId, attempt, createdAt, updatedAt
           )
           VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?,
             'pending', NULL, ?, NULL, ?, NULL, ?,
             ?, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, ?, ?, ?, ?
           )`,
        )
        .run(
          replacementJobId,
          job.taskId,
          job.sessionId,
          job.kind,
          JSON.stringify(replacementParams),
          job.dedupeKey,
          job.dedupeCooldownMs,
          job.priority,
          job.queueWaitBudgetMs,
          job.executionBudgetMs,
          job.finalizationBudgetMs,
          nextTargetWorkerId,
          job.prUrl,
          replacementAvailableAt,
          now,
          job.id,
          attempt,
          now,
          now,
        );

      return {
        jobId: job.id,
        taskId: job.taskId,
        sessionId: job.sessionId,
        workerId: job.workerId,
        message: options.abandonmentMessage,
        detail: detailWithClassification,
        action: "requeued",
        finalStatus: "abandoned",
        retrySafety,
        replacementJobId,
        replacementAvailableAt,
        recoveredAt: now,
      };
    }

    const failureError = JSON.stringify({
      message: options.failureMessage,
      detail: detailWithClassification,
    });
    const failedInfo = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             availableAt = NULL,
             completedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND (? IS NULL OR workerId = ?)` ,
      )
      .run(
        failureError,
        now,
        now,
        now,
        job.id,
        options.expectedWorkerId ?? null,
        options.expectedWorkerId ?? null,
      );
    if (failedInfo.changes === 0) return null;

    return {
      jobId: job.id,
      taskId: job.taskId,
      sessionId: job.sessionId,
      workerId: job.workerId,
      message: options.failureMessage,
      detail: detailWithClassification,
      action: "failed",
      finalStatus: "failed",
      retrySafety,
      recoveredAt: now,
    };
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

    this.reconcileWorkerHeartbeatMismatch(workerId, status, currentJobId, now);

    return { ok: true };
  }

  private reconcileWorkerHeartbeatMismatch(
    workerId: string,
    status: WorkerStatus,
    currentJobId: string | null,
    now: string,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT
           j.id AS jobId,
           j.taskId AS taskId,
           j.sessionId AS sessionId,
           j.updatedAt AS updatedAt,
           j.claimedAt AS claimedAt,
           j.startedAt AS startedAt,
           j.firstLogAt AS firstLogAt,
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
         WHERE j.status = 'claimed'
           AND j.workerId = ?`,
      )
      .all(workerId) as ClaimedJobActivityRow[];
    if (rows.length === 0) return;

    const mismatchedRows =
      status === "busy" && currentJobId
        ? rows.filter((row) => row.jobId !== currentJobId)
        : rows;
    if (mismatchedRows.length === 0) return;

    const nowMs = Date.parse(now);
    const tx = this.db.transaction((claimedRows: ClaimedJobActivityRow[]) => {
      for (const row of claimedRows) {
        const activityMs = parseIsoMs(row.activityAt) ?? parseIsoMs(row.updatedAt) ?? nowMs;
        const activityAgeMs = Math.max(0, nowMs - activityMs);
        if (activityAgeMs < ORPHANED_CLAIM_HEARTBEAT_GRACE_MS) continue;

        const failureMessage = "Job auto-failed after worker heartbeat dropped claimed job";
        const abandonmentMessage = "Job auto-abandoned after worker heartbeat dropped claimed job";
        const detailParts = [
          `worker=${workerId}`,
          `workerStatus=${status}`,
          currentJobId ? `workerCurrentJobId=${currentJobId}` : "workerCurrentJobId=missing",
          `jobId=${row.jobId}`,
          row.lastLogTs ? `lastLogTs=${row.lastLogTs}` : "lastLogTs=none",
          `activityAt=${row.activityAt}`,
          `jobUpdatedAt=${row.updatedAt}`,
          `activityAgeMs=${activityAgeMs}`,
          `graceMs=${ORPHANED_CLAIM_HEARTBEAT_GRACE_MS}`,
        ];
        const detail = detailParts.join("; ");
        const recovered = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: workerId,
          recoveryReason: "worker_heartbeat_mismatch",
          failureMessage,
          abandonmentMessage,
          detail,
        });
        if (!recovered) continue;
      }
    });

    tx(mismatchedRows);
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
    const prUrl =
      typeof body.prUrl === "string" && body.prUrl.trim().length > 0 ? body.prUrl.trim() : null;

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             result = ?,
             prUrl = COALESCE(?, prUrl),
             completedAt = ?,
             failedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ summary, artifacts }), prUrl, now, now, now, jobId);

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

    this.refreshPrWorkerAssignmentForJob(jobId, now);
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
             availableAt = NULL,
             completedAt = NULL,
             abandonedAt = NULL,
             publishBlockedAt = NULL,
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

    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: failed?.durationMs ?? undefined,
      failedAt: failed?.failedAt ?? undefined,
    };
  }

  publishBlocked(
    jobId: string,
    body: Record<string, unknown>,
  ): { ok: boolean; message?: string; durationMs?: number; publishBlockedAt?: string } {
    const now = new Date().toISOString();
    const message = String(body.message ?? "Publish blocked");
    const detail = body.detail == null ? null : String(body.detail);
    const publishBlocked = body.publishBlocked ?? null;

    const jobRow = this.db.prepare(`SELECT workerId FROM jobs WHERE id = ?`).get(jobId) as
      | { workerId: string | null }
      | undefined;

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'publish_blocked',
             error = ?,
             publishBlockedAt = ?,
             availableAt = NULL,
             completedAt = NULL,
             failedAt = NULL,
             abandonedAt = NULL,
             durationMs = MAX(
               0,
               CAST((julianday(?) - julianday(COALESCE(startedAt, claimedAt, enqueuedAt, createdAt))) * 86400000 AS INTEGER)
             ),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(JSON.stringify({ message, detail, publishBlocked }), now, now, now, jobId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found or not in claimed state" };
    }

    const blocked = this.db
      .prepare(`SELECT durationMs, publishBlockedAt FROM jobs WHERE id = ?`)
      .get(jobId) as
      | {
          durationMs: number | null;
          publishBlockedAt: string | null;
        }
      | undefined;

    this.refreshPrWorkerAssignmentForJob(jobId, now);
    this.setWorkerIdleIfNoClaimedJobs(jobRow?.workerId ?? null, now);
    return {
      ok: true,
      durationMs: blocked?.durationMs ?? undefined,
      publishBlockedAt: blocked?.publishBlockedAt ?? undefined,
    };
  }

  defer(
    jobId: string,
    body: Record<string, unknown>,
  ): { ok: boolean; message?: string; availableAt?: string } {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    const now = new Date().toISOString();
    const deferMsRaw = Number.parseInt(String(body.deferMs ?? ""), 10);
    const deferMs = Number.isFinite(deferMsRaw) ? Math.max(1_000, Math.min(deferMsRaw, 30 * 60_000)) : 60_000;
    const availableAt = new Date(Date.now() + deferMs).toISOString();

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending',
             workerId = NULL,
             targetWorkerId = ?,
             claimedAt = NULL,
             startedAt = NULL,
             firstLogAt = NULL,
             availableAt = ?,
             updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND workerId = ?`,
      )
      .run(workerId, availableAt, now, jobId, workerId);

    if (info.changes === 0) {
      return { ok: false, message: "Job not found, not claimed, or not owned by worker" };
    }

    this.setWorkerIdleIfNoClaimedJobs(workerId, now);
    return { ok: true, availableAt };
  }

  failDeferred(
    jobId: string,
    body: Record<string, unknown>,
  ): { ok: boolean; message?: string; failedAt?: string } {
    const workerId = String(body.workerId ?? "").trim();
    if (!workerId) {
      return { ok: false, message: "workerId is required" };
    }
    const now = new Date().toISOString();
    const message = String(body.message ?? "Unknown error");
    const detail = body.detail == null ? null : String(body.detail);

    const info = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error = ?,
             failedAt = ?,
             availableAt = NULL,
             targetWorkerId = NULL,
             completedAt = NULL,
             durationMs = NULL,
             updatedAt = ?
         WHERE id = ?
           AND status = 'pending'
           AND targetWorkerId = ?
           AND availableAt IS NOT NULL`,
      )
      .run(JSON.stringify({ message, detail }), now, now, jobId, workerId);

    if (info.changes === 0) {
      return { ok: false, message: "Deferred job not found or not owned by worker" };
    }

    return { ok: true, failedAt: now };
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
        // before stale recovery kicks in, but only while heartbeat freshness indicates
        // the worker is still alive. If heartbeat is already stale, fall back to base TTL.
        const alignedGraceMs = Math.max(ttlMs, Math.min(combinedBudgetMs, ttlMs * 5));
        const heartbeatFreshForGrace =
          heartbeatMs != null &&
          Number.isFinite(heartbeatMs) &&
          !Number.isNaN(heartbeatMs) &&
          heartbeatAgeMs <= ttlMs;
        const effectiveStaleAfterMs =
          workerAligned && heartbeatFreshForGrace ? alignedGraceMs : ttlMs;
        if (activityAgeMs < effectiveStaleAfterMs) continue;
        if (workerAligned && heartbeatAgeMs < effectiveStaleAfterMs) continue;

        const failureMessage = "Job auto-failed after stale worker claim";
        const abandonmentMessage = "Job auto-abandoned after stale worker claim";
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
          `heartbeatFreshForGrace=${heartbeatFreshForGrace ? "yes" : "no"}`,
          `activityAgeMs=${activityAgeMs}`,
          `heartbeatAgeMs=${Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : -1}`,
          `staleAfterMs=${ttlMs}`,
          `effectiveStaleAfterMs=${effectiveStaleAfterMs}`,
        ];
        const detail = detailParts.join("; ");
        const recoveredItem = this.recoverClaimedJob(row.jobId, now, {
          expectedWorkerId: row.workerId,
          recoveryReason: "stale_worker_claim",
          failureMessage,
          abandonmentMessage,
          detail,
        });
        if (!recoveredItem) continue;

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

        recovered.push(recoveredItem);
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

  setPrUrl(jobId: string, prUrl: string | null | undefined): { ok: boolean; message?: string } {
    const normalizedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    if (!normalizedPrUrl) {
      return { ok: false, message: "prUrl is required" };
    }
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET prUrl = COALESCE(?, prUrl),
             updatedAt = ?
         WHERE id = ?`,
      )
      .run(normalizedPrUrl, now, jobId);
    if (info.changes === 0) {
      return { ok: false, message: "Job not found" };
    }
    this.refreshPrWorkerAssignmentForJob(jobId, now);
    return { ok: true };
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
      abandoned: 0,
      publish_blocked: 0,
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

  countByKindAndStatus(
    kind: string,
    statuses: JobStatus | JobStatus[],
  ): number {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind) return 0;
    const requestedStatuses = Array.isArray(statuses) ? statuses : [statuses];
    const normalizedStatuses = [...new Set(requestedStatuses.map((status) => String(status).trim()))]
      .filter(
        (status) =>
          status === "pending" ||
          status === "claimed" ||
          status === "completed" ||
          status === "failed" ||
          status === "abandoned" ||
          status === "publish_blocked",
      );
    if (normalizedStatuses.length === 0) return 0;
    const placeholders = normalizedStatuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status IN (${placeholders})`,
      )
      .get(normalizedKind, ...normalizedStatuses) as { count: number } | undefined;
    return Number(row?.count || 0);
  }

  countAutoscalablePendingByKind(kind: string): number {
    const normalizedKind = String(kind ?? "").trim();
    if (!normalizedKind) return 0;
    const now = new Date().toISOString();
    const targetWorkerCutoff = new Date(Date.now() - PR_WORKER_ASSIGNMENT_MAX_AGE_MS).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM jobs
         WHERE kind = ?
           AND status = 'pending'
           AND (
             availableAt IS NULL
             OR availableAt <= ?
             OR (
               targetWorkerId IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM workers tw
                 WHERE tw.workerId = jobs.targetWorkerId
                   AND COALESCE(tw.status, 'idle') <> 'offline'
                   AND tw.lastHeartbeat >= ?
               )
             )
           )
           AND (
             targetWorkerId IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM workers tw
               WHERE tw.workerId = jobs.targetWorkerId
                 AND COALESCE(tw.status, 'idle') <> 'offline'
                 AND tw.lastHeartbeat >= ?
             )
           )`,
      )
      .get(normalizedKind, now, targetWorkerCutoff, targetWorkerCutoff) as
      | { count: number }
      | undefined;
    return Number(row?.count || 0);
  }

  listWorkerPrBacklog(limit = 200): WorkerPrBacklogEntry[] {
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.min(2_000, Math.floor(limit))) : 200;
    const scanRows = Math.max(50, maxRows * 8);
    const latestJobs = new Map<
      string,
      {
        prUrl: string;
        latestJobId: string;
        latestJobStatus: JobStatus;
        latestJobAt: string;
      }
    >();
    const jobRows = this.db
      .prepare(
        `SELECT
           id,
           prUrl,
           status,
           COALESCE(completedAt, failedAt, updatedAt, createdAt) AS latestJobAt
         FROM jobs
         WHERE prUrl IS NOT NULL
           AND TRIM(prUrl) <> ''
         ORDER BY latestJobAt DESC
         LIMIT ?`,
      )
      .all(scanRows) as Array<{
      id: string;
      prUrl: string | null;
      status: JobStatus;
      latestJobAt: string;
    }>;

    for (const row of jobRows) {
      const normalizedPrUrl = normalizePrUrl(row.prUrl);
      if (!normalizedPrUrl || latestJobs.has(normalizedPrUrl)) continue;
      latestJobs.set(normalizedPrUrl, {
        prUrl: String(row.prUrl ?? "").trim(),
        latestJobId: row.id,
        latestJobStatus: row.status,
        latestJobAt: row.latestJobAt,
      });
      if (latestJobs.size >= maxRows) break;
    }

    const latestFeedbackByPr = new Map<
      string,
      {
        verdict: string | null;
        createdAt: string | null;
      }
    >();
    try {
      const feedbackRows = this.db
        .prepare(
          `SELECT pr_url AS prUrl, verdict, created_at AS createdAt
           FROM autonomy_pr_feedback
           WHERE pr_url IS NOT NULL
             AND TRIM(pr_url) <> ''
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(Math.max(200, maxRows * 12)) as Array<{
        prUrl: string | null;
        verdict: string | null;
        createdAt: string | null;
      }>;
      for (const row of feedbackRows) {
        const normalizedPrUrl = normalizePrUrl(row.prUrl);
        if (!normalizedPrUrl || latestFeedbackByPr.has(normalizedPrUrl)) continue;
        latestFeedbackByPr.set(normalizedPrUrl, {
          verdict: row.verdict ? String(row.verdict).trim() : null,
          createdAt: row.createdAt ? String(row.createdAt).trim() : null,
        });
      }
    } catch {
      // autonomy_pr_feedback may not exist in isolated JobQueue tests.
    }

    const entries: WorkerPrBacklogEntry[] = [];
    for (const [normalizedPrUrl, job] of latestJobs.entries()) {
      const feedback = latestFeedbackByPr.get(normalizedPrUrl);
      const latestFeedbackVerdict = feedback?.verdict ?? null;
      const mergeState: WorkerPrMergeState = isMergedPrFeedbackVerdict(latestFeedbackVerdict)
        ? "merged"
        : isClosedPrFeedbackVerdict(latestFeedbackVerdict)
          ? "closed_unmerged"
          : "open_unmerged";
      entries.push({
        prUrl: job.prUrl,
        normalizedPrUrl,
        latestJobId: job.latestJobId,
        latestJobStatus: job.latestJobStatus,
        latestJobAt: job.latestJobAt,
        latestFeedbackVerdict,
        latestFeedbackAt: feedback?.createdAt ?? null,
        mergeState,
      });
    }
    return entries.slice(0, maxRows);
  }

  countOpenUnmergedWorkerPrs(limit = 500): number {
    return this.listWorkerPrBacklog(limit).filter((entry) => entry.mergeState === "open_unmerged")
      .length;
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
         WHERE status IN ('completed', 'failed', 'abandoned', 'publish_blocked')
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
    let abandoned = 0;
    let publishBlocked = 0;
    let timeoutFailures = 0;
    const durationSamples: number[] = [];
    const queueWaitSamples: number[] = [];

    for (const row of rows) {
      if (row.status === "completed") completed += 1;
      if (
        row.status === "failed" ||
        row.status === "abandoned" ||
        row.status === "publish_blocked"
      ) {
        if (row.status === "failed") failed += 1;
        if (row.status === "abandoned") abandoned += 1;
        if (row.status === "publish_blocked") publishBlocked += 1;
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

    const terminal = completed + failed + abandoned + publishBlocked;
    const successRate = terminal > 0 ? Number((completed / terminal).toFixed(4)) : null;
    const timeoutRate = terminal > 0 ? Number((timeoutFailures / terminal).toFixed(4)) : null;

    return {
      windowHours: boundedWindowHours,
      terminal,
      completed,
      failed,
      abandoned,
      publishBlocked,
      timeoutFailures,
      successRate,
      timeoutRate,
      durationMs: summarizeSamples(durationSamples),
      queueWaitMs: summarizeSamples(queueWaitSamples),
    };
  }

  addLog(jobId: string, message: string, ts?: string): number | null {
    const now = coerceIsoTimestamp(ts) ?? new Date().toISOString();
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

  close(): void {
    this.db.close();
  }
}
