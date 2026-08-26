import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";

export type RepositoryAgentQueueStatus = "pending" | "claimed" | "completed" | "failed";
export type RepositoryAgentQueuePriority = "interactive" | "normal" | "background";

export interface RepositoryAgentQueueRow {
  id: string;
  sessionId: string;
  callerService: string;
  purpose: string;
  repositoryId: string;
  repositoryRoot: string;
  revision: string;
  treeHash: string;
  dirty: number;
  priority: RepositoryAgentQueuePriority;
  deadlineAt: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestJson: string;
  request?: Record<string, unknown>;
  status: RepositoryAgentQueueStatus;
  agentId: string | null;
  claimToken: string | null;
  claimGeneration: number;
  claimAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  resultJson: string | null;
  result?: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface EnqueueRepositoryAgentRequestInput {
  sessionId: string;
  callerService: string;
  purpose: string;
  repositoryId: string;
  repositoryRoot: string;
  revision: string;
  treeHash: string;
  dirty: boolean;
  priority: RepositoryAgentQueuePriority;
  deadlineAt: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
}

const DEFAULT_LEASE_MS = 3 * 60_000;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 15 * 60_000;
export const REPOSITORY_AGENT_MAX_DEADLINE_HORIZON_MS = 60 * 60_000;
export const REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS = 3;
export const REPOSITORY_AGENT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const MAINTENANCE_PRUNE_LIMIT = 500;
const HEALTH_PENDING_UNHEALTHY_AFTER_MS = 5 * 60_000;

export interface RepositoryAgentQueueOptions {
  now?: () => Date;
  maxDeadlineHorizonMs?: number;
  maxClaimAttempts?: number;
  terminalRetentionMs?: number;
}

export interface RepositoryAgentQueueHealthSummary {
  counts: Record<RepositoryAgentQueueStatus, number>;
  oldestPendingAgeMs: number;
  oldestClaimedAgeMs: number;
  delayedRetryCount: number;
  staleClaimCount: number;
  pastDeadlineActiveCount: number;
  exhaustedPendingCount: number;
  maxClaimAttempts: number;
  pendingUnhealthyAfterMs: number;
  unhealthy: boolean;
}

export interface RepositoryAgentTerminalPruneResult {
  pruned: number;
  requestIds: string[];
}

type IdempotencyLookupRow = {
  id: string;
  status: RepositoryAgentQueueStatus;
  requestFingerprint: string;
};

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("RepositoryAgent request must not be cyclic");
    ancestors.add(value);
    const encoded = `[${value
      .map((entry) =>
        entry === undefined || typeof entry === "function" || typeof entry === "symbol"
          ? "null"
          : canonicalJson(entry, ancestors),
      )
      .join(",")}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("RepositoryAgent request must not be cyclic");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const encoded = `{${Object.keys(record)
      .sort()
      .flatMap((key) => {
        const entry = record[key];
        return entry === undefined || typeof entry === "function" || typeof entry === "symbol"
          ? []
          : [`${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`];
      })
      .join(",")}}`;
    ancestors.delete(value);
    return encoded;
  }
  return "null";
}

function fingerprintRequest(input: {
  sessionId: string;
  callerService: string;
  purpose: string;
  repositoryId: string;
  repositoryRoot: string;
  revision: string;
  treeHash: string;
  dirty: boolean | number;
  priority: RepositoryAgentQueuePriority;
  deadlineAt: string;
  idempotencyKey: string;
  request: unknown;
}): string {
  const deadlineMs = Date.parse(input.deadlineAt);
  const canonical = canonicalJson({
    schema: "pushpals-repository-agent-idempotency-v1",
    sessionId: String(input.sessionId ?? "").trim(),
    callerService: String(input.callerService ?? "").trim(),
    purpose: String(input.purpose ?? "").trim(),
    repositoryId: String(input.repositoryId ?? "").trim(),
    repositoryRoot: String(input.repositoryRoot ?? "").trim(),
    revision: String(input.revision ?? "").trim(),
    treeHash: String(input.treeHash ?? "").trim(),
    dirty: input.dirty === true || Number(input.dirty) === 1,
    priority: input.priority,
    deadlineAt: Number.isFinite(deadlineMs)
      ? new Date(deadlineMs).toISOString()
      : String(input.deadlineAt ?? "").trim(),
    idempotencyKey: String(input.idempotencyKey ?? "").trim(),
    request: input.request,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function retryDelayMs(claimAttempts: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(claimAttempts) - 1));
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent);
}

function normalizedNow(value: Date): Date {
  return Number.isFinite(value.getTime()) ? value : new Date();
}

function parseRetryableError(raw: string): { retryable: boolean; message: string } {
  const compact = String(raw ?? "RepositoryAgent request failed").slice(0, 4_000);
  try {
    const parsed = JSON.parse(compact) as { retryable?: unknown; message?: unknown };
    return {
      retryable: parsed?.retryable === true,
      message:
        typeof parsed?.message === "string" && parsed.message.trim()
          ? parsed.message.trim().slice(0, 1_500)
          : "RepositoryAgent request failed",
    };
  } catch {
    return { retryable: false, message: compact };
  }
}

function retryExhaustedError(original: string, claimAttempts: number): string {
  const parsed = parseRetryableError(original);
  return JSON.stringify({
    code: "repository_agent_retry_exhausted",
    message: `RepositoryAgent request exhausted ${claimAttempts} bounded attempt(s): ${parsed.message}`,
    detail: String(original ?? "").slice(0, 2_000),
    retryable: false,
  });
}

function retryDeadlineExhaustedError(original: string, claimAttempts: number): string {
  const parsed = parseRetryableError(original);
  return JSON.stringify({
    code: "repository_agent_retry_deadline_exhausted",
    message: `RepositoryAgent request cannot retry attempt ${claimAttempts} before its deadline: ${parsed.message}`,
    detail: String(original ?? "").slice(0, 2_000),
    retryable: false,
  });
}

function boundedLeaseMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_MS;
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(parsed)));
}

function boundedIntegerOption(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hydrateRow(
  row: RepositoryAgentQueueRow | null | undefined,
): RepositoryAgentQueueRow | null {
  if (!row) return null;
  return {
    ...row,
    dirty: Number(row.dirty) === 1 ? 1 : 0,
    claimGeneration: Number(row.claimGeneration ?? 0),
    claimAttempts: Number(row.claimAttempts ?? 0),
    request: parseObject(row.requestJson) ?? undefined,
    result: parseObject(row.resultJson),
  };
}

export class RepositoryAgentQueue {
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly maxDeadlineHorizonMs: number;
  private readonly maxClaimAttempts: number;
  private readonly terminalRetentionMs: number;
  private lastMaintenanceAtMs = 0;

  private static readonly SELECT_COLUMNS = `
    id, sessionId, callerService, purpose, repositoryId, repositoryRoot, revision,
    treeHash, dirty, priority, deadlineAt, idempotencyKey, requestFingerprint,
    requestJson, status, agentId, claimToken, claimGeneration, claimAttempts,
    nextAttemptAt, leaseExpiresAt,
    lastHeartbeatAt, resultJson, error, createdAt, updatedAt, claimedAt,
    completedAt, failedAt
  `;

  constructor(dbPath = ":memory:", options: RepositoryAgentQueueOptions = {}) {
    this.db = new Database(dbPath);
    this.now = options.now ?? (() => new Date());
    this.maxDeadlineHorizonMs = boundedIntegerOption(
      options.maxDeadlineHorizonMs,
      REPOSITORY_AGENT_MAX_DEADLINE_HORIZON_MS,
      60_000,
      24 * 60 * 60_000,
    );
    this.maxClaimAttempts = boundedIntegerOption(
      options.maxClaimAttempts,
      REPOSITORY_AGENT_MAX_CLAIM_ATTEMPTS,
      1,
      20,
    );
    this.terminalRetentionMs = boundedIntegerOption(
      options.terminalRetentionMs,
      REPOSITORY_AGENT_TERMINAL_RETENTION_MS,
      60_000,
      365 * 24 * 60 * 60_000,
    );
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repository_agent_requests (
        id              TEXT PRIMARY KEY,
        sessionId       TEXT NOT NULL,
        callerService   TEXT NOT NULL,
        purpose         TEXT NOT NULL,
        repositoryId    TEXT NOT NULL,
        repositoryRoot  TEXT NOT NULL,
        revision        TEXT NOT NULL,
        treeHash        TEXT NOT NULL,
        dirty           INTEGER NOT NULL DEFAULT 0,
        priority        TEXT NOT NULL DEFAULT 'normal',
        deadlineAt      TEXT NOT NULL,
        idempotencyKey  TEXT NOT NULL,
        requestFingerprint TEXT NOT NULL DEFAULT '',
        requestJson     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        agentId         TEXT,
        claimToken      TEXT,
        claimGeneration INTEGER NOT NULL DEFAULT 0,
        claimAttempts   INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt   TEXT,
        leaseExpiresAt  TEXT,
        lastHeartbeatAt TEXT,
        resultJson      TEXT,
        error           TEXT,
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL,
        claimedAt       TEXT,
        completedAt     TEXT,
        failedAt        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_repository_agent_request_claim
        ON repository_agent_requests(status, priority, createdAt);
      CREATE INDEX IF NOT EXISTS idx_repository_agent_request_deadline
        ON repository_agent_requests(status, deadlineAt);
    `);

    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(repository_agent_requests)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("requestFingerprint")) {
      this.db.exec(
        "ALTER TABLE repository_agent_requests ADD COLUMN requestFingerprint TEXT NOT NULL DEFAULT '';",
      );
    }
    if (!columns.has("nextAttemptAt")) {
      this.db.exec("ALTER TABLE repository_agent_requests ADD COLUMN nextAttemptAt TEXT;");
    }
    const idempotencyIndexColumns = (
      this.db
        .prepare("PRAGMA index_info(idx_repository_agent_request_idempotency)")
        .all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    if (
      idempotencyIndexColumns.join("\0") !==
      ["repositoryId", "callerService", "sessionId", "idempotencyKey"].join("\0")
    ) {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_repository_agent_request_idempotency;
        CREATE UNIQUE INDEX idx_repository_agent_request_idempotency
          ON repository_agent_requests(repositoryId, callerService, sessionId, idempotencyKey);
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_repository_agent_request_available
        ON repository_agent_requests(status, nextAttemptAt, priority, createdAt);
      CREATE INDEX IF NOT EXISTS idx_repository_agent_request_terminal_retention
        ON repository_agent_requests(status, completedAt, failedAt, updatedAt);
    `);
    this.backfillRequestFingerprints();
  }

  private currentDate(): Date {
    return normalizedNow(this.now());
  }

  private backfillRequestFingerprints(): void {
    type LegacyRow = {
      id: string;
      sessionId: string;
      callerService: string;
      purpose: string;
      repositoryId: string;
      repositoryRoot: string;
      revision: string;
      treeHash: string;
      dirty: number;
      priority: RepositoryAgentQueuePriority;
      deadlineAt: string;
      idempotencyKey: string;
      requestJson: string;
    };
    const select = this.db.prepare(
      `SELECT id, sessionId, callerService, purpose, repositoryId, repositoryRoot,
              revision, treeHash, dirty, priority, deadlineAt, idempotencyKey,
              requestJson
       FROM repository_agent_requests
       WHERE requestFingerprint IS NULL OR requestFingerprint = ''
       ORDER BY id ASC
       LIMIT 250`,
    );
    const update = this.db.prepare(
      `UPDATE repository_agent_requests SET requestFingerprint = ?
       WHERE id = ? AND (requestFingerprint IS NULL OR requestFingerprint = '')`,
    );
    const backfillBatch = this.db.transaction((rows: LegacyRow[]) => {
      for (const row of rows) {
        const request = parseObject(row.requestJson) ?? { legacyRequestJson: row.requestJson };
        update.run(fingerprintRequest({ ...row, request }), row.id);
      }
    });
    while (true) {
      const rows = select.all() as LegacyRow[];
      if (rows.length === 0) return;
      backfillBatch(rows);
    }
  }

  private maybeMaintain(now: Date): void {
    const nowMs = now.getTime();
    if (nowMs - this.lastMaintenanceAtMs < MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenanceAtMs = nowMs;
    this.pruneTerminal({
      now,
      retentionMs: this.terminalRetentionMs,
      limit: MAINTENANCE_PRUNE_LIMIT,
    });
  }

  enqueue(input: EnqueueRepositoryAgentRequestInput): {
    ok: boolean;
    requestId?: string;
    deduplicated?: boolean;
    status?: RepositoryAgentQueueStatus;
    conflict?: boolean;
    code?: "idempotency_conflict";
    message?: string;
  } {
    const required: Array<[string, string]> = [
      ["sessionId", input.sessionId],
      ["callerService", input.callerService],
      ["purpose", input.purpose],
      ["repositoryId", input.repositoryId],
      ["repositoryRoot", input.repositoryRoot],
      ["revision", input.revision],
      ["treeHash", input.treeHash],
      ["idempotencyKey", input.idempotencyKey],
    ];
    for (const [name, value] of required) {
      if (!String(value ?? "").trim()) return { ok: false, message: `${name} is required` };
    }
    const nowDate = this.currentDate();
    const nowMs = nowDate.getTime();
    const deadlineMs = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) {
      return { ok: false, message: "deadlineAt must be a future ISO timestamp" };
    }
    if (deadlineMs - nowMs > this.maxDeadlineHorizonMs) {
      return {
        ok: false,
        message: `deadlineAt must be no more than ${this.maxDeadlineHorizonMs}ms in the future`,
      };
    }

    let requestJson: string;
    let requestFingerprint: string;
    try {
      requestJson = JSON.stringify(input.request);
      if (!requestJson) throw new TypeError("request must be a JSON object");
      requestFingerprint = fingerprintRequest({ ...input, request: JSON.parse(requestJson) });
    } catch (error) {
      return {
        ok: false,
        message: `request must be finite, acyclic JSON: ${String(error)}`,
      };
    }
    this.maybeMaintain(nowDate);

    const prior = this.db
      .prepare(
        `SELECT id, status, requestFingerprint
         FROM repository_agent_requests
         WHERE repositoryId = ? AND callerService = ? AND sessionId = ? AND idempotencyKey = ?
         LIMIT 1`,
      )
      .get(
        input.repositoryId.trim(),
        input.callerService.trim(),
        input.sessionId.trim(),
        input.idempotencyKey.trim(),
      ) as IdempotencyLookupRow | undefined;
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) {
        return {
          ok: false,
          requestId: prior.id,
          conflict: true,
          code: "idempotency_conflict",
          message:
            "RepositoryAgent idempotency key is already bound to a different caller, request, or repository snapshot",
        };
      }
      return {
        ok: true,
        requestId: prior.id,
        deduplicated: true,
        status: prior.status,
      };
    }

    const id = randomUUID();
    const now = nowDate.toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO repository_agent_requests (
             id, sessionId, callerService, purpose, repositoryId, repositoryRoot,
             revision, treeHash, dirty, priority, deadlineAt, idempotencyKey,
             requestFingerprint, requestJson, status, claimGeneration, claimAttempts,
             nextAttemptAt, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)`,
        )
        .run(
          id,
          input.sessionId.trim(),
          input.callerService.trim(),
          input.purpose.trim(),
          input.repositoryId.trim(),
          input.repositoryRoot.trim(),
          input.revision.trim(),
          input.treeHash.trim(),
          input.dirty ? 1 : 0,
          input.priority,
          new Date(deadlineMs).toISOString(),
          input.idempotencyKey.trim(),
          requestFingerprint,
          requestJson,
          now,
          now,
        );
    } catch (error) {
      const raced = this.db
        .prepare(
          `SELECT id, status, requestFingerprint FROM repository_agent_requests
           WHERE repositoryId = ? AND callerService = ? AND sessionId = ? AND idempotencyKey = ?
           LIMIT 1`,
        )
        .get(
          input.repositoryId.trim(),
          input.callerService.trim(),
          input.sessionId.trim(),
          input.idempotencyKey.trim(),
        ) as IdempotencyLookupRow | undefined;
      if (raced) {
        if (raced.requestFingerprint !== requestFingerprint) {
          return {
            ok: false,
            requestId: raced.id,
            conflict: true,
            code: "idempotency_conflict",
            message:
              "RepositoryAgent idempotency key raced with a different caller, request, or repository snapshot",
          };
        }
        return {
          ok: true,
          requestId: raced.id,
          deduplicated: true,
          status: raced.status,
        };
      }
      return { ok: false, message: String(error) };
    }
    return { ok: true, requestId: id, deduplicated: false, status: "pending" };
  }

  get(requestId: string): RepositoryAgentQueueRow | null {
    const row = this.db
      .prepare(
        `SELECT ${RepositoryAgentQueue.SELECT_COLUMNS}
         FROM repository_agent_requests WHERE id = ? LIMIT 1`,
      )
      .get(requestId) as RepositoryAgentQueueRow | undefined;
    return hydrateRow(row);
  }

  claim(
    agentIdRaw: string,
    options: { leaseMs?: number; repositoryIdentities?: string[] } = {},
  ): {
    ok: boolean;
    request?: RepositoryAgentQueueRow;
    message?: string;
  } {
    const agentId = String(agentIdRaw ?? "").trim();
    if (!agentId) return { ok: false, message: "agentId is required" };
    const nowDate = this.currentDate();
    const now = nowDate.toISOString();
    this.maybeMaintain(nowDate);
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + boundedLeaseMs(options.leaseMs),
    ).toISOString();

    const tx = this.db.transaction(() => {
      this.recoverExpiredClaims(now);
      this.expirePastDeadlines(now);
      this.deadLetterExhaustedPending(now);
      const repositoryIdentities = Array.from(
        new Set(
          (options.repositoryIdentities ?? [])
            .map((identity) => String(identity ?? "").trim())
            .filter(Boolean),
        ),
      ).slice(0, 128);
      const identityClause = repositoryIdentities.length
        ? `AND repositoryId IN (${repositoryIdentities.map(() => "?").join(",")})`
        : "";
      const row = this.db
        .prepare(
          `SELECT ${RepositoryAgentQueue.SELECT_COLUMNS}
           FROM repository_agent_requests
           WHERE status = 'pending' AND deadlineAt > ?
             AND claimAttempts < ?
             AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
             ${identityClause}
           ORDER BY
             CASE LOWER(priority)
               WHEN 'interactive' THEN 0
               WHEN 'normal' THEN 1
               WHEN 'background' THEN 2
               ELSE 1
             END,
             createdAt ASC
           LIMIT 1`,
        )
        .get(now, this.maxClaimAttempts, now, ...repositoryIdentities) as
        | RepositoryAgentQueueRow
        | undefined;
      if (!row) return null;
      const updated = this.db
        .prepare(
          `UPDATE repository_agent_requests
           SET status = 'claimed', agentId = ?, claimToken = ?,
               claimGeneration = claimGeneration + 1,
               claimAttempts = claimAttempts + 1,
               nextAttemptAt = NULL, leaseExpiresAt = ?, lastHeartbeatAt = ?,
               claimedAt = ?, updatedAt = ?
           WHERE id = ? AND status = 'pending' AND claimAttempts < ?
             AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)`,
        )
        .run(
          agentId,
          claimToken,
          leaseExpiresAt,
          now,
          now,
          now,
          row.id,
          this.maxClaimAttempts,
          now,
        );
      if (updated.changes !== 1) return null;
      return hydrateRow({
        ...row,
        status: "claimed",
        agentId,
        claimToken,
        claimGeneration: Number(row.claimGeneration ?? 0) + 1,
        claimAttempts: Number(row.claimAttempts ?? 0) + 1,
        nextAttemptAt: null,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        claimedAt: now,
        updatedAt: now,
      });
    });
    const request = tx();
    return request ? { ok: true, request } : { ok: false, message: "No pending requests" };
  }

  renewLease(
    requestId: string,
    agentIdRaw: string,
    claimTokenRaw: string,
    claimGeneration: number,
    options: { leaseMs?: number } = {},
  ): { ok: boolean; leaseExpiresAt?: string; message?: string } {
    const agentId = String(agentIdRaw ?? "").trim();
    const claimToken = String(claimTokenRaw ?? "").trim();
    if (!agentId || !claimToken || !Number.isSafeInteger(claimGeneration) || claimGeneration < 1) {
      return { ok: false, message: "agentId, claimToken, and claimGeneration are required" };
    }
    const nowDate = this.currentDate();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + boundedLeaseMs(options.leaseMs),
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE repository_agent_requests
         SET leaseExpiresAt = ?, lastHeartbeatAt = ?, updatedAt = ?
         WHERE id = ? AND status = 'claimed' AND agentId = ? AND claimToken = ?
           AND claimGeneration = ?
           AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ? AND deadlineAt > ?`,
      )
      .run(leaseExpiresAt, now, now, requestId, agentId, claimToken, claimGeneration, now, now);
    return result.changes === 1
      ? { ok: true, leaseExpiresAt }
      : {
          ok: false,
          message: "RepositoryAgent lease is stale, expired, or owned by another agent",
        };
  }

  complete(
    requestId: string,
    input: {
      agentId: string;
      claimToken: string;
      claimGeneration: number;
      result: Record<string, unknown>;
    },
  ): { ok: boolean; message?: string } {
    const now = this.currentDate().toISOString();
    const result = this.db
      .prepare(
        `UPDATE repository_agent_requests
         SET status = 'completed', resultJson = ?, error = NULL, completedAt = ?,
             claimToken = NULL, nextAttemptAt = NULL, leaseExpiresAt = NULL,
             lastHeartbeatAt = ?, updatedAt = ?
         WHERE id = ? AND status = 'claimed' AND agentId = ? AND claimToken = ?
           AND claimGeneration = ?
           AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ? AND deadlineAt > ?`,
      )
      .run(
        JSON.stringify(input.result),
        now,
        now,
        now,
        requestId,
        input.agentId.trim(),
        input.claimToken.trim(),
        input.claimGeneration,
        now,
        now,
      );
    return result.changes === 1
      ? { ok: true }
      : { ok: false, message: "RepositoryAgent completion rejected by lease fencing" };
  }

  fail(
    requestId: string,
    input: { agentId: string; claimToken: string; claimGeneration: number; message: string },
  ): {
    ok: boolean;
    message?: string;
    requeued?: boolean;
    deadLettered?: boolean;
    nextAttemptAt?: string;
  } {
    const nowDate = this.currentDate();
    const now = nowDate.toISOString();
    const message = String(input.message ?? "RepositoryAgent request failed").slice(0, 4_000);
    const authority = this.db
      .prepare(
        `SELECT claimAttempts, deadlineAt
         FROM repository_agent_requests
         WHERE id = ? AND status = 'claimed' AND agentId = ? AND claimToken = ?
           AND claimGeneration = ? AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
         LIMIT 1`,
      )
      .get(requestId, input.agentId.trim(), input.claimToken.trim(), input.claimGeneration, now) as
      | { claimAttempts: number; deadlineAt: string }
      | undefined;
    if (!authority) {
      return { ok: false, message: "RepositoryAgent failure rejected by lease fencing" };
    }

    const claimAttempts = Number(authority.claimAttempts ?? 0);
    const deadlineMs = Date.parse(authority.deadlineAt);
    const retryable = parseRetryableError(message).retryable;
    const retryAtMs = nowDate.getTime() + retryDelayMs(claimAttempts);
    const mayRetry =
      retryable &&
      claimAttempts < this.maxClaimAttempts &&
      Number.isFinite(deadlineMs) &&
      retryAtMs < deadlineMs;

    if (mayRetry) {
      const nextAttemptAt = new Date(retryAtMs).toISOString();
      const requeued = this.db
        .prepare(
          `UPDATE repository_agent_requests
           SET status = 'pending', agentId = NULL, claimToken = NULL,
               leaseExpiresAt = NULL, lastHeartbeatAt = NULL, claimedAt = NULL,
               nextAttemptAt = ?, error = ?, failedAt = NULL, updatedAt = ?
           WHERE id = ? AND status = 'claimed' AND agentId = ? AND claimToken = ?
             AND claimGeneration = ? AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?`,
        )
        .run(
          nextAttemptAt,
          message,
          now,
          requestId,
          input.agentId.trim(),
          input.claimToken.trim(),
          input.claimGeneration,
          now,
        );
      return requeued.changes === 1
        ? { ok: true, requeued: true, nextAttemptAt }
        : { ok: false, message: "RepositoryAgent failure rejected by lease fencing" };
    }

    const deadlineExpired = !Number.isFinite(deadlineMs) || deadlineMs <= nowDate.getTime();
    const attemptsExhausted = retryable && claimAttempts >= this.maxClaimAttempts;
    const retryDeadlineExhausted = retryable && !attemptsExhausted && retryAtMs >= deadlineMs;
    const deadLettered = attemptsExhausted || retryDeadlineExhausted;
    const terminalError = attemptsExhausted
      ? retryExhaustedError(message, claimAttempts)
      : retryDeadlineExhausted
        ? retryDeadlineExhaustedError(message, claimAttempts)
        : deadlineExpired
          ? "RepositoryAgent request deadline expired"
          : message;
    const failed = this.db
      .prepare(
        `UPDATE repository_agent_requests
         SET status = 'failed', error = ?, failedAt = ?, nextAttemptAt = NULL,
             leaseExpiresAt = NULL, claimToken = NULL, lastHeartbeatAt = ?, updatedAt = ?
         WHERE id = ? AND status = 'claimed' AND agentId = ? AND claimToken = ?
           AND claimGeneration = ? AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?`,
      )
      .run(
        terminalError,
        now,
        now,
        now,
        requestId,
        input.agentId.trim(),
        input.claimToken.trim(),
        input.claimGeneration,
        now,
      );
    return failed.changes === 1
      ? { ok: true, ...(deadLettered ? { deadLettered: true } : {}) }
      : { ok: false, message: "RepositoryAgent failure rejected by lease fencing" };
  }

  recoverExpiredClaims(nowInput?: string | Date): {
    recovered: number;
    requestIds: string[];
  } {
    const parsed =
      nowInput instanceof Date ? nowInput : nowInput ? new Date(nowInput) : this.currentDate();
    const nowDate = Number.isFinite(parsed.getTime()) ? parsed : this.currentDate();
    const now = nowDate.toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, claimAttempts, error FROM repository_agent_requests
         WHERE status = 'claimed' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
           AND deadlineAt > ? ORDER BY createdAt ASC`,
      )
      .all(now, now) as Array<{ id: string; claimAttempts: number; error: string | null }>;
    if (rows.length === 0) return { recovered: 0, requestIds: [] };
    const recover = this.db.prepare(
      `UPDATE repository_agent_requests
       SET status = 'pending', agentId = NULL, claimToken = NULL,
           leaseExpiresAt = NULL, lastHeartbeatAt = NULL, claimedAt = NULL,
           nextAttemptAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'claimed'
         AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?) AND deadlineAt > ?`,
    );
    const deadLetter = this.db.prepare(
      `UPDATE repository_agent_requests
       SET status = 'failed', agentId = NULL, claimToken = NULL,
           leaseExpiresAt = NULL, nextAttemptAt = NULL, failedAt = ?, updatedAt = ?,
           error = ?
       WHERE id = ? AND status = 'claimed'
         AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?) AND deadlineAt > ?`,
    );
    const recoveredIds: string[] = [];
    for (const row of rows) {
      const claimAttempts = Number(row.claimAttempts ?? 0);
      if (claimAttempts >= this.maxClaimAttempts) {
        deadLetter.run(
          now,
          now,
          retryExhaustedError(
            row.error ??
              JSON.stringify({
                code: "repository_agent_lease_expired",
                message: "RepositoryAgent worker lease repeatedly expired",
                retryable: true,
              }),
            claimAttempts,
          ),
          row.id,
          now,
          now,
        );
        continue;
      }
      const nextAttemptAt = new Date(nowDate.getTime() + retryDelayMs(claimAttempts)).toISOString();
      if (recover.run(nextAttemptAt, now, row.id, now, now).changes === 1) {
        recoveredIds.push(row.id);
      }
    }
    return { recovered: recoveredIds.length, requestIds: recoveredIds };
  }

  private deadLetterExhaustedPending(now: string): number {
    const error = JSON.stringify({
      code: "repository_agent_retry_exhausted",
      message: "RepositoryAgent request exhausted bounded attempts before claim",
      retryable: false,
    });
    return this.db
      .prepare(
        `UPDATE repository_agent_requests
         SET status = 'failed', failedAt = ?, updatedAt = ?, nextAttemptAt = NULL,
             error = ?
         WHERE status = 'pending' AND claimAttempts >= ? AND deadlineAt > ?`,
      )
      .run(now, now, error, this.maxClaimAttempts, now).changes;
  }

  expirePastDeadlines(nowInput?: string | Date): number {
    const parsed =
      nowInput instanceof Date ? nowInput : nowInput ? new Date(nowInput) : this.currentDate();
    const now = Number.isFinite(parsed.getTime())
      ? parsed.toISOString()
      : this.currentDate().toISOString();
    return this.db
      .prepare(
        `UPDATE repository_agent_requests
         SET status = 'failed', error = 'RepositoryAgent request deadline expired',
             failedAt = ?, agentId = NULL, claimToken = NULL, nextAttemptAt = NULL,
             leaseExpiresAt = NULL, updatedAt = ?
         WHERE status IN ('pending', 'claimed') AND deadlineAt <= ?`,
      )
      .run(now, now, now).changes;
  }

  countByStatus(): Record<RepositoryAgentQueueStatus, number> {
    const counts: Record<RepositoryAgentQueueStatus, number> = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
    };
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM repository_agent_requests GROUP BY status`)
      .all() as Array<{ status: RepositoryAgentQueueStatus; count: number }>;
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = Number(row.count ?? 0);
    }
    return counts;
  }

  pruneTerminal(
    options: {
      now?: string | Date;
      retentionMs?: number;
      limit?: number;
    } = {},
  ): RepositoryAgentTerminalPruneResult {
    const parsed =
      options.now instanceof Date
        ? options.now
        : options.now
          ? new Date(options.now)
          : this.currentDate();
    const now = Number.isFinite(parsed.getTime()) ? parsed : this.currentDate();
    const rawRetentionMs = Number(options.retentionMs);
    const retentionMs = Number.isFinite(rawRetentionMs)
      ? Math.max(0, Math.min(365 * 24 * 60 * 60_000, Math.floor(rawRetentionMs)))
      : this.terminalRetentionMs;
    const limit = Math.max(1, Math.min(5_000, Math.floor(Number(options.limit) || 500)));
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM repository_agent_requests
         WHERE status IN ('completed', 'failed')
           AND COALESCE(completedAt, failedAt, updatedAt) <= ?
         ORDER BY COALESCE(completedAt, failedAt, updatedAt) ASC
         LIMIT ?`,
      )
      .all(cutoff, limit) as Array<{ id: string }>;
    if (rows.length === 0) return { pruned: 0, requestIds: [] };
    const placeholders = rows.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `DELETE FROM repository_agent_requests
         WHERE status IN ('completed', 'failed') AND id IN (${placeholders})`,
      )
      .run(...rows.map((row) => row.id));
    return { pruned: result.changes, requestIds: rows.map((row) => row.id) };
  }

  healthSummary(nowInput: string | Date = this.currentDate()): RepositoryAgentQueueHealthSummary {
    const parsed = nowInput instanceof Date ? nowInput : new Date(nowInput);
    const nowDate = Number.isFinite(parsed.getTime()) ? parsed : this.currentDate();
    const now = nowDate.toISOString();
    const active = this.db
      .prepare(
        `SELECT
           MIN(CASE WHEN status = 'pending' THEN createdAt END) AS oldestPendingAt,
           MIN(CASE WHEN status = 'claimed' THEN COALESCE(claimedAt, updatedAt) END) AS oldestClaimedAt,
           SUM(CASE WHEN status = 'pending' AND nextAttemptAt > ? THEN 1 ELSE 0 END) AS delayedRetryCount,
           SUM(CASE WHEN status = 'claimed' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?) THEN 1 ELSE 0 END) AS staleClaimCount,
           SUM(CASE WHEN status IN ('pending', 'claimed') AND deadlineAt <= ? THEN 1 ELSE 0 END) AS pastDeadlineActiveCount,
           SUM(CASE WHEN status = 'pending' AND claimAttempts >= ? THEN 1 ELSE 0 END) AS exhaustedPendingCount
         FROM repository_agent_requests`,
      )
      .get(now, now, now, this.maxClaimAttempts) as {
      oldestPendingAt: string | null;
      oldestClaimedAt: string | null;
      delayedRetryCount: number | null;
      staleClaimCount: number | null;
      pastDeadlineActiveCount: number | null;
      exhaustedPendingCount: number | null;
    };
    const age = (timestamp: string | null): number => {
      const value = timestamp ? Date.parse(timestamp) : Number.NaN;
      return Number.isFinite(value) ? Math.max(0, nowDate.getTime() - value) : 0;
    };
    const oldestPendingAgeMs = age(active.oldestPendingAt);
    const oldestClaimedAgeMs = age(active.oldestClaimedAt);
    const staleClaimCount = Number(active.staleClaimCount ?? 0);
    const pastDeadlineActiveCount = Number(active.pastDeadlineActiveCount ?? 0);
    const exhaustedPendingCount = Number(active.exhaustedPendingCount ?? 0);
    return {
      counts: this.countByStatus(),
      oldestPendingAgeMs,
      oldestClaimedAgeMs,
      delayedRetryCount: Number(active.delayedRetryCount ?? 0),
      staleClaimCount,
      pastDeadlineActiveCount,
      exhaustedPendingCount,
      maxClaimAttempts: this.maxClaimAttempts,
      pendingUnhealthyAfterMs: HEALTH_PENDING_UNHEALTHY_AFTER_MS,
      unhealthy:
        oldestPendingAgeMs >= HEALTH_PENDING_UNHEALTHY_AFTER_MS ||
        staleClaimCount > 0 ||
        pastDeadlineActiveCount > 0 ||
        exhaustedPendingCount > 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
