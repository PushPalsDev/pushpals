import { Database } from "bun:sqlite";
import type {
  SessionMemoryBackend,
  SessionMemoryRecallOptions,
  SessionMemoryWriteInput,
  SessionMemoryWriteOptions,
} from "./memory.js";
import { mergeMemoryLines } from "./memory.js";

type MemoryRow = {
  id: number;
  sessionId: string;
  kind: string;
  summary: string;
  createdAt: string;
};

const SQLITE_BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]);
const SQLITE_BUSY_RETRY_ATTEMPTS = 3;
const SQLITE_BUSY_TIMEOUT_MS = 3_000;

function normalizeSummary(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class PersistentSessionMemory implements SessionMemoryBackend {
  private db: Database;

  constructor(dbPath: string = "remotebuddy-state.db") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.migrate();
  }

  private isBusyError(error: unknown): boolean {
    const code = String((error as { code?: unknown })?.code ?? "").toUpperCase();
    if (SQLITE_BUSY_CODES.has(code)) return true;
    const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
    return message.includes("database is locked");
  }

  private runWithBusyRetry<T>(operation: string, action: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_ATTEMPTS; attempt++) {
      try {
        return action();
      } catch (error) {
        lastError = error;
        if (!this.isBusyError(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw (
      lastError ??
      new Error(`[RemoteBuddy] SQLite busy retry exhausted for operation: ${operation}`)
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remotebuddy_memory (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repoRoot   TEXT NOT NULL,
        sessionId  TEXT NOT NULL,
        requestId  TEXT,
        kind       TEXT NOT NULL,
        summary    TEXT NOT NULL,
        createdAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_remotebuddy_memory_repo_created
        ON remotebuddy_memory(repoRoot, createdAt DESC);

      CREATE INDEX IF NOT EXISTS idx_remotebuddy_memory_repo_session_created
        ON remotebuddy_memory(repoRoot, sessionId, createdAt DESC);
    `);
  }

  remember(input: SessionMemoryWriteInput, options: SessionMemoryWriteOptions = {}): void {
    const repoRoot = normalizeSummary(input.repoRoot);
    const sessionId = normalizeSummary(input.sessionId);
    const kind = normalizeSummary(input.kind) || "note";
    const maxSummaryChars = clampPositiveInt(options.maxSummaryChars, 420, 32, 8_000);
    const summaryRaw = normalizeSummary(input.summary);
    if (!repoRoot || !sessionId || !summaryRaw) return;
    const summary =
      summaryRaw.length <= maxSummaryChars
        ? summaryRaw
        : `${summaryRaw.slice(0, maxSummaryChars - 14)} ...[truncated]`;
    const requestId = normalizeSummary(input.requestId ?? "") || null;
    const createdAt = new Date().toISOString();
    this.runWithBusyRetry("remember.insert", () =>
      this.db
        .prepare(
          `INSERT INTO remotebuddy_memory (repoRoot, sessionId, requestId, kind, summary, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(repoRoot, sessionId, requestId, kind, summary, createdAt),
    );

    const retentionDays = clampPositiveInt(options.retentionDays, 30, 1, 3650);
    try {
      this.purgeExpired(retentionDays, repoRoot);
    } catch (error) {
      console.warn("[RemoteBuddy] Persistent memory purge skipped:", error);
    }
  }

  recallForPlanning(options: SessionMemoryRecallOptions): string[] {
    const repoRoot = normalizeSummary(options.repoRoot);
    const sessionId = normalizeSummary(options.sessionId);
    if (!repoRoot || !sessionId) return [];

    const includeCurrentSession = options.includeCurrentSession !== false;
    const includeCrossSession = options.includeCrossSession !== false;
    if (!includeCurrentSession && !includeCrossSession) return [];

    const maxItems = clampPositiveInt(options.maxItems, 8, 1, 64);
    const maxChars = clampPositiveInt(options.maxChars, 2_400, 120, 24_000);
    const scanLimit = Math.max(maxItems, Math.min(400, maxItems * 8));

    let sessionClause = "";
    const params: Array<string | number> = [repoRoot];
    if (includeCurrentSession && !includeCrossSession) {
      sessionClause = " AND sessionId = ?";
      params.push(sessionId);
    } else if (!includeCurrentSession && includeCrossSession) {
      sessionClause = " AND sessionId <> ?";
      params.push(sessionId);
    }

    params.push(scanLimit);

    const rows = this.db
      .prepare(
        `SELECT id, sessionId, kind, summary, createdAt
         FROM remotebuddy_memory
         WHERE repoRoot = ?${sessionClause}
         ORDER BY createdAt DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as MemoryRow[];

    const lines = rows
      .map((row) => {
        const summary = normalizeSummary(row.summary);
        if (!summary) return "";
        const source = row.sessionId === sessionId ? "this-session" : "repo-history";
        const kind = normalizeSummary(row.kind) || "note";
        return `[memory ${source} ${kind}] ${summary}`;
      })
      .filter(Boolean);
    return mergeMemoryLines(lines, { maxItems, maxChars });
  }

  purgeExpired(retentionDays: number, repoRoot?: string): number {
    const days = clampPositiveInt(retentionDays, 30, 1, 3650);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const repo = normalizeSummary(repoRoot ?? "");
    const result = this.runWithBusyRetry("remember.purge_expired", () =>
      repo
        ? this.db
            .prepare(`DELETE FROM remotebuddy_memory WHERE repoRoot = ? AND createdAt < ?`)
            .run(repo, cutoff)
        : this.db.prepare(`DELETE FROM remotebuddy_memory WHERE createdAt < ?`).run(cutoff),
    );
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
