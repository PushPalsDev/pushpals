/**
 * Agent idempotency store — prevents replay-induced duplicate AI actions.
 *
 * Persists per-session:
 *   - handledUserMessageIds  (bounded set — skip already-processed messages)
 *   - lastCursorProcessed   (max-wins — know where we left off)
 *
 * Uses SQLite for durability across agent restarts.
 */

import { Database } from "bun:sqlite";

const MAX_HANDLED_IDS = 5000;

export class IdempotencyStore {
  private db: Database;

  constructor(dbPath: string = "remotebuddy-state.db") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_cursors (
        sessionId  TEXT PRIMARY KEY,
        cursor     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS handled_messages (
        sessionId  TEXT NOT NULL,
        eventId    TEXT NOT NULL,
        handledAt  TEXT NOT NULL,
        PRIMARY KEY (sessionId, eventId)
      );

      CREATE INDEX IF NOT EXISTS idx_handled_session
        ON handled_messages(sessionId, handledAt);
    `);
  }

  // ── Cursor ──────────────────────────────────────────────────────────────

  getLastCursor(sessionId: string): number {
    const row = this.db
      .prepare("SELECT cursor FROM session_cursors WHERE sessionId = ?")
      .get(sessionId) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  /** Max-wins update — only saves if cursor > previous */
  updateCursor(sessionId: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO session_cursors (sessionId, cursor) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET cursor = MAX(excluded.cursor, session_cursors.cursor)`,
      )
      .run(sessionId, cursor);
  }

  // ── Handled message IDs ─────────────────────────────────────────────────

  hasHandled(sessionId: string, eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM handled_messages WHERE sessionId = ? AND eventId = ?")
      .get(sessionId, eventId);
    return !!row;
  }

  markHandled(sessionId: string, eventId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO handled_messages (sessionId, eventId, handledAt) VALUES (?, ?, ?)",
      )
      .run(sessionId, eventId, now);

    // Prune oldest entries if over cap
    this._prune(sessionId);
  }

  private _prune(sessionId: string): void {
    this.db
      .prepare(
        `DELETE FROM handled_messages
         WHERE rowid IN (
           SELECT rowid FROM handled_messages
           WHERE sessionId = ?
           ORDER BY handledAt ASC
           LIMIT MAX(0, (SELECT COUNT(*) FROM handled_messages WHERE sessionId = ?) - ?)
         )`,
      )
      .run(sessionId, sessionId, MAX_HANDLED_IDS);
  }

  close(): void {
    this.db.close();
  }
}
