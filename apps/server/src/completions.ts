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
import { createHash, randomUUID } from "crypto";
import {
  extractTrustedValidationFailureEvidence,
  normalizeTrustedValidationCommands,
  type TrustedValidationExecutionResult,
  type TrustedValidationReport,
} from "../../../packages/shared/src/trusted_validation.js";

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
  trustedInstallDurationMs: number | null;
  trustedValidationDurationMs: number | null;
  trustedValidationCacheHit: number | null;
  trustedValidationRecoveryAttempts: number;
  status: CompletionStatus;
  pusherId: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  claimAttempts: number;
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
  requeuedCompletionIds?: string[];
  requeuedJobIds?: string[];
}

// The original failure plus one recovery run is enough to distinguish a
// transient host outage from an unchanged candidate failure. Further retries
// must come from a new repair candidate instead of cycling publication.
const TRUSTED_VALIDATION_RECOVERY_MAX_ATTEMPTS = 1;
export const DEFAULT_COMPLETION_LEASE_MS = 3 * 60_000;
const MIN_COMPLETION_LEASE_MS = 30_000;
const MAX_COMPLETION_LEASE_MS = 15 * 60_000;

export type CompletionLeaseRecoveryResult = {
  recovered: number;
  completionIds: string[];
};

export type PublicationBacklogSummary = {
  pending: number;
  claimed: number;
  finalizing: number;
  backlog: number;
  oldestPendingAgeMs: number;
  oldestFinalizingAgeMs: number;
  expiredClaims: number;
  unhealthy: boolean;
  observedAt: string;
};

function normalizeCompletionLeaseMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMPLETION_LEASE_MS;
  return Math.max(MIN_COMPLETION_LEASE_MS, Math.min(MAX_COMPLETION_LEASE_MS, Math.floor(parsed)));
}

type TrustedValidationRecoveryCandidate = {
  completionId: string;
  jobId: string;
};

export interface TrustedValidationTiming {
  installDurationMs?: number | null;
  validationDurationMs?: number | null;
  installCacheHit?: boolean | null;
}

function normalizeTrustedValidationTiming(timing?: TrustedValidationTiming): {
  installDurationMs: number | null;
  validationDurationMs: number | null;
  installCacheHit: number | null;
} {
  const normalizedDuration = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  return {
    installDurationMs: normalizedDuration(timing?.installDurationMs),
    validationDurationMs: normalizedDuration(timing?.validationDurationMs),
    installCacheHit:
      typeof timing?.installCacheHit === "boolean" ? (timing.installCacheHit ? 1 : 0) : null,
  };
}

function trustedValidationText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function trustedValidationStringArray(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => trustedValidationText(entry, 1_000))
        .filter(Boolean)
        .slice(0, maxItems),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function normalizeTrustedValidationReport(value: unknown): TrustedValidationReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.results)) return null;
  const results: TrustedValidationExecutionResult[] = [];
  for (const raw of input.results.slice(0, 16)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const result = raw as Record<string, unknown>;
    const command = trustedValidationText(result.command, 1_000);
    const phase = result.phase === "dependency_install" ? "dependency_install" : "validation";
    if (!command) continue;
    const ok = result.ok === true;
    const output = trustedValidationText(result.output, 16_000);
    const exitCode =
      typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
        ? Math.max(-1, Math.min(999, Math.floor(result.exitCode)))
        : ok
          ? 0
          : 1;
    const evidence = extractTrustedValidationFailureEvidence({ command, phase, output, exitCode });
    results.push({
      ok,
      command,
      output,
      exitCode,
      durationMs:
        typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
          ? Math.max(0, Math.min(24 * 60 * 60 * 1_000, Math.floor(result.durationMs)))
          : 0,
      cached: result.cached === true,
      phase,
      ...(ok
        ? {}
        : {
            failureClass: evidence.failureClass,
            failedTests:
              trustedValidationStringArray(result.failedTests).length > 0
                ? trustedValidationStringArray(result.failedTests)
                : evidence.failedTests,
            targetPathHints:
              trustedValidationStringArray(result.targetPathHints).length > 0
                ? trustedValidationStringArray(result.targetPathHints)
                : evidence.targetPathHints,
          }),
    });
  }
  return {
    version: 1,
    baselineSha: trustedValidationText(input.baselineSha, 128) || null,
    candidateSha: trustedValidationText(input.candidateSha, 128) || null,
    results,
  };
}

function trustedValidationFailureFingerprint(result: TrustedValidationExecutionResult): string {
  const fallback = result.output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, "<duration>"))
    .filter((line) => /\b(?:error|fail|failed|failure|timeout)\b/i.test(line))
    .slice(0, 4);
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: result.command.trim().replace(/\s+/g, " ").toLowerCase(),
        failureClass: result.failureClass ?? "trusted_validation_failed",
        failedTests: trustedValidationStringArray(result.failedTests),
        targetPathHints: trustedValidationStringArray(result.targetPathHints),
        fallback:
          (result.failedTests?.length ?? 0) > 0 || (result.targetPathHints?.length ?? 0) > 0
            ? []
            : fallback,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function trustedValidationCommandKey(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
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
        trustedInstallDurationMs INTEGER,
        trustedValidationDurationMs INTEGER,
        trustedValidationCacheHit INTEGER,
        trustedValidationRecoveryAttempts INTEGER NOT NULL DEFAULT 0,
        status     TEXT NOT NULL DEFAULT 'pending',
        pusherId   TEXT,
        claimedAt  TEXT,
        leaseExpiresAt TEXT,
        lastHeartbeatAt TEXT,
        claimAttempts INTEGER NOT NULL DEFAULT 0,
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
    if (!columns.some((col) => col.name === "trustedInstallDurationMs")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedInstallDurationMs INTEGER;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationDurationMs")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationDurationMs INTEGER;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationCacheHit")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN trustedValidationCacheHit INTEGER;`);
    }
    if (!columns.some((col) => col.name === "trustedValidationRecoveryAttempts")) {
      this.db.exec(
        `ALTER TABLE completions ADD COLUMN trustedValidationRecoveryAttempts INTEGER NOT NULL DEFAULT 0;`,
      );
    }
    if (!columns.some((col) => col.name === "claimedAt")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN claimedAt TEXT;`);
    }
    if (!columns.some((col) => col.name === "leaseExpiresAt")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN leaseExpiresAt TEXT;`);
    }
    if (!columns.some((col) => col.name === "lastHeartbeatAt")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN lastHeartbeatAt TEXT;`);
    }
    if (!columns.some((col) => col.name === "claimAttempts")) {
      this.db.exec(`ALTER TABLE completions ADD COLUMN claimAttempts INTEGER NOT NULL DEFAULT 0;`);
    }

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_completions_lease_expiry ON completions(status, leaseExpiresAt);`,
    );

    this.recoverExpiredClaims();
    this.reconcileLegacyParentJobStates();
    this.reconcileRecoverableTrustedValidationFailures();
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

  private reconcileRecoverableTrustedValidationFailures(): void {
    const requiredTables = ["jobs", "job_validation_runs", "job_terminal_diagnostics"];
    const present = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('jobs', 'job_validation_runs', 'job_terminal_diagnostics')`,
      )
      .all() as Array<{ name: string }>;
    const presentNames = new Set(present.map((row) => row.name));
    if (!requiredTables.every((name) => presentNames.has(name))) return;

    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id AS completionId,
                          c.jobId AS jobId,
                          failed.command AS failedCommand,
                          passed.command AS passedCommand,
                          json_extract(failed.metadataJson, '$.baselineSha') AS failedBaselineSha,
                          json_extract(passed.metadataJson, '$.baselineSha') AS passedBaselineSha
         FROM completions c
         JOIN jobs blockedJob ON blockedJob.id = c.jobId
         JOIN job_validation_runs failed ON failed.jobId = c.jobId
         JOIN job_validation_runs passed
           ON passed.passed = 1
          AND json_extract(passed.metadataJson, '$.source') = 'trusted_host'
          AND (
            datetime(passed.createdAt) > datetime(failed.createdAt)
            OR (datetime(passed.createdAt) = datetime(failed.createdAt) AND passed.id > failed.id)
          )
         JOIN jobs passedJob ON passedJob.id = passed.jobId AND passedJob.status = 'completed'
         WHERE c.status = 'failed'
           AND blockedJob.status = 'publish_blocked'
           AND c.trustedValidationCommandsJson IS NOT NULL
           AND c.trustedValidationRecoveryAttempts < ?
           AND failed.passed = 0
           AND failed.failureClass IN ('timeout', 'dependency_setup_failed', 'trusted_validation_failed')
           AND json_extract(failed.metadataJson, '$.source') = 'trusted_host'
           AND json_extract(failed.metadataJson, '$.completionId') = c.id
           AND COALESCE(json_array_length(json_extract(failed.metadataJson, '$.failedTests')), 0) = 0
           AND COALESCE(json_extract(failed.metadataJson, '$.baselineSha'), '') != ''
           AND json_extract(failed.metadataJson, '$.baselineSha') =
               json_extract(passed.metadataJson, '$.baselineSha')
         ORDER BY c.createdAt ASC, c.id ASC
         LIMIT 256`,
      )
      .all(TRUSTED_VALIDATION_RECOVERY_MAX_ATTEMPTS) as Array<{
      completionId: string;
      jobId: string;
      failedCommand: string;
      passedCommand: string;
      failedBaselineSha: string | null;
      passedBaselineSha: string | null;
    }>;
    const eligible = new Map<string, TrustedValidationRecoveryCandidate>();
    for (const row of rows) {
      if (
        !trustedValidationCommandKey(row.failedCommand) ||
        trustedValidationCommandKey(row.failedCommand) !==
          trustedValidationCommandKey(row.passedCommand)
      ) {
        continue;
      }
      eligible.set(row.completionId, {
        completionId: row.completionId,
        jobId: row.jobId,
      });
    }
    if (eligible.size === 0) return;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() =>
      this.restoreTrustedValidationBlockedCompletions([...eligible.values()], now),
    );
    const recovered = tx();
    if (recovered.jobIds.length > 0) {
      console.log(
        `[Server] Startup recovery requeued ${recovered.jobIds.length} retained trusted-validation candidate(s): ${recovered.jobIds.join(", ")}`,
      );
    }
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
  claim(
    pusherId: string,
    options: { leaseMs?: number; reconcilePusher?: boolean } = {},
  ): { ok: boolean; completion?: CompletionRow; message?: string } {
    const now = new Date().toISOString();
    const leaseMs = normalizeCompletionLeaseMs(options.leaseMs);
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();

    const tx = this.db.transaction(() => {
      this.recoverExpiredClaims(now);
      if (options.reconcilePusher) {
        this.db
          .prepare(
            `UPDATE completions
             SET status = 'pending',
                 pusherId = NULL,
                 claimedAt = NULL,
                 leaseExpiresAt = NULL,
                 lastHeartbeatAt = NULL,
                 updatedAt = ?
             WHERE status = 'claimed' AND pusherId = ?`,
          )
          .run(now, pusherId);
      }
      const row = this.db
        .prepare(
          `SELECT * FROM completions WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`,
        )
        .get() as CompletionRow | undefined;

      if (!row) return null;

      this.db
        .prepare(
          `UPDATE completions
           SET status = 'claimed',
               pusherId = ?,
               claimedAt = ?,
               leaseExpiresAt = ?,
               lastHeartbeatAt = ?,
               claimAttempts = COALESCE(claimAttempts, 0) + 1,
               updatedAt = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(pusherId, now, leaseExpiresAt, now, now, row.id);

      return this.getCompletion(row.id);
    });

    const completion = tx();
    if (!completion) return { ok: false, message: "No pending completions" };
    return { ok: true, completion };
  }

  renewLease(
    completionId: string,
    pusherId: string,
    options: { leaseMs?: number } = {},
  ): { ok: boolean; leaseExpiresAt?: string; message?: string } {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(
      Date.parse(now) + normalizeCompletionLeaseMs(options.leaseMs),
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE completions
         SET lastHeartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
         WHERE id = ?
           AND status = 'claimed'
           AND pusherId = ?
           AND leaseExpiresAt IS NOT NULL
           AND leaseExpiresAt > ?`,
      )
      .run(now, leaseExpiresAt, now, completionId, pusherId, now);
    if (result.changes === 0) {
      return {
        ok: false,
        message: "Completion lease is missing, expired, or owned by another pusher",
      };
    }
    return { ok: true, leaseExpiresAt };
  }

  recoverExpiredClaims(nowInput: string | Date = new Date()): CompletionLeaseRecoveryResult {
    const now =
      nowInput instanceof Date ? nowInput.toISOString() : new Date(nowInput).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id FROM completions
         WHERE status = 'claimed'
           AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
         ORDER BY createdAt ASC`,
      )
      .all(now) as Array<{ id: string }>;
    if (rows.length === 0) return { recovered: 0, completionIds: [] };
    const ids = rows.map((row) => row.id);
    const result = this.db
      .prepare(
        `UPDATE completions
       SET status = 'pending',
           pusherId = NULL,
           claimedAt = NULL,
           leaseExpiresAt = NULL,
           lastHeartbeatAt = NULL,
           updatedAt = ?
       WHERE status = 'claimed'
         AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
      )
      .run(now, now);
    const recovered = result.changes;
    return { recovered, completionIds: ids.slice(0, recovered) };
  }

  /**
   * Mark a completion as processed (checks passed, merged to integration branch)
   */
  markProcessed(
    completionId: string,
    prUrl?: string | null,
    pusherId?: string | null,
  ): { ok: boolean; message?: string } {
    const now = new Date().toISOString();
    const normalizedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;

    const info = this.db
      .prepare(
        `UPDATE completions
         SET status = 'processed',
             prUrl = COALESCE(?, prUrl),
             updatedAt = ?
         WHERE id = ? AND status = 'claimed'
           AND (
             ? IS NULL OR (
               pusherId = ?
               AND leaseExpiresAt IS NOT NULL
               AND leaseExpiresAt > ?
             )
           )`,
      )
      .run(normalizedPrUrl, now, completionId, pusherId ?? null, pusherId ?? null, now);

    if (info.changes === 0) {
      return { ok: false, message: "Completion not found or not in claimed state" };
    }

    return { ok: true };
  }

  /**
   * Mark a completion as failed (checks failed or merge conflict)
   */
  markFailed(
    completionId: string,
    error: string,
    pusherId?: string | null,
  ): { ok: boolean; message?: string } {
    const now = new Date().toISOString();

    const info = this.db
      .prepare(
        `UPDATE completions SET status = 'failed', error = ?, updatedAt = ?
         WHERE id = ? AND status = 'claimed'
           AND (
             ? IS NULL OR (
               pusherId = ?
               AND leaseExpiresAt IS NOT NULL
               AND leaseExpiresAt > ?
             )
           )`,
      )
      .run(error, now, completionId, pusherId ?? null, pusherId ?? null, now);

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
    trustedTiming?: TrustedValidationTiming,
    trustedReportInput?: unknown,
    pusherId?: string | null,
  ): CompletionFinalizationResult {
    const now = new Date().toISOString();
    const normalizedPrUrl =
      typeof prUrl === "string" && prUrl.trim().length > 0 ? prUrl.trim() : null;
    const normalizedTiming = normalizeTrustedValidationTiming(trustedTiming);
    const trustedReport = normalizeTrustedValidationReport(trustedReportInput);
    const tx = this.db.transaction((): CompletionFinalizationResult => {
      const completion = this.getCompletion(completionId);
      if (!completion) return { ok: false, message: "Completion not found" };
      if (completion.status === "processed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      if (
        pusherId &&
        (completion.pusherId !== pusherId ||
          !completion.leaseExpiresAt ||
          completion.leaseExpiresAt <= now)
      ) {
        return { ok: false, message: "Completion lease is expired or owned by another pusher" };
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

      const completionUpdated = this.db
        .prepare(
          `UPDATE completions
           SET status = 'processed',
               prUrl = COALESCE(?, prUrl),
               trustedInstallDurationMs = COALESCE(?, trustedInstallDurationMs),
               trustedValidationDurationMs = COALESCE(?, trustedValidationDurationMs),
               trustedValidationCacheHit = COALESCE(?, trustedValidationCacheHit),
               error = NULL,
               updatedAt = ?
           WHERE id = ? AND status = 'claimed'
             AND (
               ? IS NULL OR (
                 pusherId = ?
                 AND leaseExpiresAt IS NOT NULL
                 AND leaseExpiresAt > ?
               )
             )`,
        )
        .run(
          normalizedPrUrl,
          normalizedTiming.installDurationMs,
          normalizedTiming.validationDurationMs,
          normalizedTiming.installCacheHit,
          now,
          completionId,
          pusherId ?? null,
          pusherId ?? null,
          now,
        );
      if (completionUpdated.changes === 0) {
        return { ok: false, message: "Completion lease was lost before finalization" };
      }
      this.replaceTrustedValidationRuns(completion, trustedReport, now);
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
      const recovered = this.requeueTrustedValidationBlockedCompletionsAfterPass(
        completion,
        trustedReport,
        now,
      );
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
        ...(recovered.completionIds.length > 0
          ? {
              requeuedCompletionIds: recovered.completionIds,
              requeuedJobIds: recovered.jobIds,
            }
          : {}),
      };
    });
    return tx();
  }

  /**
   * Fail publication and move the parent job to publish_blocked atomically.
   * Completed is accepted only to repair state written by older workers.
   */
  markFailedAndBlockJob(
    completionId: string,
    error: string,
    trustedTiming?: TrustedValidationTiming,
    trustedReportInput?: unknown,
    pusherId?: string | null,
  ): CompletionFinalizationResult {
    const now = new Date().toISOString();
    const failure = String(error || "Unknown publication error");
    const normalizedTiming = normalizeTrustedValidationTiming(trustedTiming);
    const trustedReport = normalizeTrustedValidationReport(trustedReportInput);
    const tx = this.db.transaction((): CompletionFinalizationResult => {
      const completion = this.getCompletion(completionId);
      if (!completion) return { ok: false, message: "Completion not found" };
      if (completion.status === "failed") {
        return { ok: true, jobId: completion.jobId, jobTransitioned: false };
      }
      if (completion.status !== "claimed") {
        return { ok: false, message: "Completion not in claimed state" };
      }
      if (
        pusherId &&
        (completion.pusherId !== pusherId ||
          !completion.leaseExpiresAt ||
          completion.leaseExpiresAt <= now)
      ) {
        return { ok: false, message: "Completion lease is expired or owned by another pusher" };
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

      const completionUpdated = this.db
        .prepare(
          `UPDATE completions
           SET status = 'failed',
               trustedInstallDurationMs = COALESCE(?, trustedInstallDurationMs),
               trustedValidationDurationMs = COALESCE(?, trustedValidationDurationMs),
               trustedValidationCacheHit = COALESCE(?, trustedValidationCacheHit),
               error = ?,
               updatedAt = ?
           WHERE id = ? AND status = 'claimed'
             AND (
               ? IS NULL OR (
                 pusherId = ?
                 AND leaseExpiresAt IS NOT NULL
                 AND leaseExpiresAt > ?
               )
             )`,
        )
        .run(
          normalizedTiming.installDurationMs,
          normalizedTiming.validationDurationMs,
          normalizedTiming.installCacheHit,
          failure,
          now,
          completionId,
          pusherId ?? null,
          pusherId ?? null,
          now,
        );
      if (completionUpdated.changes === 0) {
        return { ok: false, message: "Completion lease was lost before failure finalization" };
      }
      this.replaceTrustedValidationRuns(completion, trustedReport, now);
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

  private replaceTrustedValidationRuns(
    completion: CompletionRow,
    report: TrustedValidationReport | null,
    now: string,
  ): void {
    if (!completion.trustedValidationCommandsJson || !report || report.results.length === 0) return;
    const requested = normalizeTrustedValidationCommands(completion.trustedValidationCommandsJson);
    if (!requested.ok) return;
    const allowedCommands = new Set(
      requested.commands.map((command) => command.trim().replace(/\s+/g, " ").toLowerCase()),
    );
    this.db
      .prepare(
        `DELETE FROM job_validation_runs
         WHERE jobId = ?
           AND json_extract(metadataJson, '$.source') = 'trusted_host'
           AND json_extract(metadataJson, '$.completionId') = ?`,
      )
      .run(completion.jobId, completion.id);
    const insert = this.db.prepare(
      `INSERT INTO job_validation_runs (
         jobId, attempt, command, exitCode, durationMs, passed, failureClass,
         stdoutTail, stderrTail, metadataJson, createdAt
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    for (const result of report.results) {
      const normalizedCommand = result.command.trim().replace(/\s+/g, " ").toLowerCase();
      if (result.phase !== "dependency_install" && !allowedCommands.has(normalizedCommand)) {
        continue;
      }
      const failedTests = trustedValidationStringArray(result.failedTests);
      const targetPathHints = trustedValidationStringArray(result.targetPathHints);
      const failureFingerprint = result.ok ? null : trustedValidationFailureFingerprint(result);
      insert.run(
        completion.jobId,
        result.command,
        result.exitCode,
        result.durationMs,
        result.ok ? 1 : 0,
        result.ok ? null : (result.failureClass ?? "trusted_validation_failed"),
        result.output.slice(-8_000),
        JSON.stringify({
          source: "trusted_host",
          completionId: completion.id,
          phase: result.phase,
          cached: Boolean(result.cached),
          baselineSha: report.baselineSha,
          candidateSha: completion.commitSha ?? report.candidateSha,
          failureFingerprint,
          failedTests,
          targetPathHints,
        }),
        now,
      );
    }
  }

  /**
   * A same-baseline trusted-host pass can prove that a transient validation
   * failure without named test evidence was environmental. Candidate-specific
   * test, lint, and typecheck failures remain blocked until a repair produces a
   * new candidate SHA. Recovery is limited to one retry to prevent publication
   * churn from an unchanged failure.
   */
  private requeueTrustedValidationBlockedCompletionsAfterPass(
    passingCompletion: CompletionRow,
    report: TrustedValidationReport | null,
    now: string,
  ): { completionIds: string[]; jobIds: string[] } {
    if (!passingCompletion.trustedValidationCommandsJson || !report) {
      return { completionIds: [], jobIds: [] };
    }
    const requested = normalizeTrustedValidationCommands(
      passingCompletion.trustedValidationCommandsJson,
    );
    if (!requested.ok) return { completionIds: [], jobIds: [] };
    const allowed = new Set(requested.commands.map(trustedValidationCommandKey));
    const passedCommands = new Set(
      report.results
        .filter(
          (result) =>
            result.ok &&
            (result.phase === "dependency_install" ||
              allowed.has(trustedValidationCommandKey(result.command))),
        )
        .map((result) => trustedValidationCommandKey(result.command))
        .filter(Boolean),
    );
    const passingBaselineSha = trustedValidationText(report.baselineSha, 128);
    if (passedCommands.size === 0 || !passingBaselineSha) {
      return { completionIds: [], jobIds: [] };
    }

    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.id AS completionId,
                         c.jobId AS jobId,
                          c.trustedValidationRecoveryAttempts AS recoveryAttempts,
                          r.command AS command,
                          r.failureClass AS failureClass,
                          json_extract(r.metadataJson, '$.baselineSha') AS baselineSha
         FROM completions c
         JOIN jobs j ON j.id = c.jobId
         JOIN job_validation_runs r ON r.jobId = c.jobId
         WHERE c.status = 'failed'
           AND j.status = 'publish_blocked'
           AND c.id != ?
           AND c.trustedValidationCommandsJson IS NOT NULL
           AND c.trustedValidationRecoveryAttempts < ?
            AND r.passed = 0
            AND r.failureClass IN ('timeout', 'dependency_setup_failed', 'trusted_validation_failed')
            AND json_extract(r.metadataJson, '$.source') = 'trusted_host'
            AND json_extract(r.metadataJson, '$.completionId') = c.id
            AND COALESCE(json_array_length(json_extract(r.metadataJson, '$.failedTests')), 0) = 0
            AND json_extract(r.metadataJson, '$.baselineSha') = ?
            AND datetime(r.createdAt) <= datetime(?)
         ORDER BY c.createdAt ASC, c.id ASC`,
      )
      .all(
        passingCompletion.id,
        TRUSTED_VALIDATION_RECOVERY_MAX_ATTEMPTS,
        passingBaselineSha,
        now,
      ) as Array<{
      completionId: string;
      jobId: string;
      recoveryAttempts: number;
      command: string;
      failureClass: string | null;
      baselineSha: string | null;
    }>;
    const eligible = new Map<string, TrustedValidationRecoveryCandidate>();
    for (const row of rows) {
      if (!passedCommands.has(trustedValidationCommandKey(row.command))) continue;
      eligible.set(row.completionId, {
        completionId: row.completionId,
        jobId: row.jobId,
      });
    }

    return this.restoreTrustedValidationBlockedCompletions([...eligible.values()], now);
  }

  private restoreTrustedValidationBlockedCompletions(
    candidates: TrustedValidationRecoveryCandidate[],
    now: string,
  ): { completionIds: string[]; jobIds: string[] } {
    const completionIds: string[] = [];
    const jobIds: string[] = [];
    for (const row of candidates) {
      const completionUpdate = this.db
        .prepare(
          `UPDATE completions
           SET status = 'pending',
               pusherId = NULL,
               error = NULL,
               trustedValidationRecoveryAttempts = trustedValidationRecoveryAttempts + 1,
               updatedAt = ?
           WHERE id = ?
             AND status = 'failed'
             AND trustedValidationRecoveryAttempts < ?`,
        )
        .run(now, row.completionId, TRUSTED_VALIDATION_RECOVERY_MAX_ATTEMPTS);
      if (completionUpdate.changes === 0) continue;
      const jobUpdate = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'finalizing',
               error = NULL,
               completedAt = NULL,
               failedAt = NULL,
               abandonedAt = NULL,
               publishBlockedAt = NULL,
               durationMs = NULL,
               updatedAt = ?
           WHERE id = ? AND status = 'publish_blocked'`,
        )
        .run(now, row.jobId);
      if (jobUpdate.changes === 0) {
        throw new Error(
          `Failed to restore parent job ${row.jobId} while requeueing completion ${row.completionId}`,
        );
      }
      this.db.prepare(`DELETE FROM job_terminal_diagnostics WHERE jobId = ?`).run(row.jobId);
      completionIds.push(row.completionId);
      jobIds.push(row.jobId);
    }
    return { completionIds, jobIds };
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

  publicationBacklogSummary(
    options: { now?: Date; unhealthyAfterMs?: number } = {},
  ): PublicationBacklogSummary {
    const nowDate = options.now ?? new Date();
    const now = nowDate.toISOString();
    const unhealthyAfterMs = Math.max(60_000, options.unhealthyAfterMs ?? 15 * 60_000);
    const counts = this.countByStatus();
    const oldestPending = this.db
      .prepare(
        `SELECT MIN(createdAt) AS value FROM completions WHERE status IN ('pending', 'claimed')`,
      )
      .get() as { value: string | null } | undefined;
    const expiredClaimsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM completions
         WHERE status = 'claimed' AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
      )
      .get(now) as { count: number } | undefined;
    const jobsTable = this.db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`)
      .get() as { present: number } | undefined;
    const finalizingRow = jobsTable
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS count, MIN(updatedAt) AS oldest
             FROM jobs WHERE status = 'finalizing'`,
          )
          .get() as { count: number; oldest: string | null })
      : { count: counts.pending + counts.claimed, oldest: oldestPending?.value ?? null };
    const ageMs = (value: string | null | undefined): number => {
      if (!value) return 0;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.max(0, nowDate.getTime() - parsed) : 0;
    };
    const pending = Math.max(0, counts.pending);
    const claimed = Math.max(0, counts.claimed);
    const finalizing = Math.max(0, Number(finalizingRow.count || 0));
    const oldestPendingAgeMs = ageMs(oldestPending?.value);
    const oldestFinalizingAgeMs = ageMs(finalizingRow.oldest);
    const expiredClaims = Math.max(0, Number(expiredClaimsRow?.count || 0));
    return {
      pending,
      claimed,
      finalizing,
      backlog: Math.max(pending + claimed, finalizing),
      oldestPendingAgeMs,
      oldestFinalizingAgeMs,
      expiredClaims,
      unhealthy:
        expiredClaims > 0 ||
        (pending + claimed > 0 && oldestPendingAgeMs >= unhealthyAfterMs) ||
        (finalizing > 0 && oldestFinalizingAgeMs >= unhealthyAfterMs),
      observedAt: now,
    };
  }

  close(): void {
    this.db.close();
  }
}
