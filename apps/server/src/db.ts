/**
 * Durable event store backed by SQLite (bun:sqlite).
 *
 * Design principles:
 * - Append-only `events` table with AUTOINCREMENT `event_id` as the cursor
 * - Persist FIRST, broadcast SECOND → crash-safe
 * - Cursor replay via `getEventsAfter(sessionId, afterEventId)` for SSE/WS reconnects
 * - Sessions table for metadata (created_at, label, etc.)
 */

import { Database } from "bun:sqlite";
import type { EventEnvelope } from "protocol";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StoredEvent {
  /** Auto-incrementing cursor — used for `after=` replay */
  eventId: number;
  /** UUID from the EventEnvelope */
  id: string;
  sessionId: string;
  type: string;
  ts: string;
  /** Full JSON-serialized EventEnvelope */
  envelope: string;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  label: string | null;
}

// ─── EventStore class ───────────────────────────────────────────────────────

export class EventStore {
  private db: Database;

  // Prepared statements (compiled once, reused)
  private insertEventStmt: ReturnType<Database["prepare"]>;
  private getEventsAfterStmt: ReturnType<Database["prepare"]>;
  private getAllEventsStmt: ReturnType<Database["prepare"]>;
  private getLatestCursorStmt: ReturnType<Database["prepare"]>;
  private insertSessionStmt: ReturnType<Database["prepare"]>;
  private getSessionStmt: ReturnType<Database["prepare"]>;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);

    // WAL mode for concurrent reads + writes
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this._migrate();

    // Prepare statements
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events (id, session_id, type, ts, envelope)
      VALUES ($id, $sessionId, $type, $ts, $envelope)
      RETURNING event_id AS eventId
    `);

    this.getEventsAfterStmt = this.db.prepare(`
      SELECT event_id AS eventId, id, session_id AS sessionId, type, ts, envelope
      FROM events
      WHERE session_id = $sessionId AND event_id > $afterEventId
      ORDER BY event_id ASC
      LIMIT $limit
    `);

    this.getAllEventsStmt = this.db.prepare(`
      SELECT event_id AS eventId, id, session_id AS sessionId, type, ts, envelope
      FROM events
      WHERE session_id = $sessionId
      ORDER BY event_id ASC
    `);

    this.getLatestCursorStmt = this.db.prepare(`
      SELECT MAX(event_id) AS cursor FROM events WHERE session_id = $sessionId
    `);

    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO sessions (session_id, created_at, label)
      VALUES ($sessionId, $createdAt, $label)
      ON CONFLICT(session_id) DO NOTHING
    `);

    this.getSessionStmt = this.db.prepare(`
      SELECT session_id AS sessionId, created_at AS createdAt, label
      FROM sessions
      WHERE session_id = $sessionId
    `);
  }

  // ─── Schema migration ──────────────────────────────────────────────────

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        label       TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        ts          TEXT    NOT NULL,
        envelope    TEXT    NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_cursor
        ON events (session_id, event_id);
    `);
  }

  // ─── Session operations ─────────────────────────────────────────────────

  createSession(sessionId: string, label?: string): void {
    this.insertSessionStmt.run({
      $sessionId: sessionId,
      $createdAt: new Date().toISOString(),
      $label: label ?? null,
    });
  }

  getSession(sessionId: string): SessionRecord | null {
    return (this.getSessionStmt.get({ $sessionId: sessionId }) as SessionRecord) ?? null;
  }

  // ─── Event operations ───────────────────────────────────────────────────

  /**
   * Persist a full event envelope. Returns the auto-generated cursor (event_id).
   *
   * Accepts the complete EventEnvelope (including payload) so the DB
   * stores exactly what subscribers see. The `type` and `ts` columns are
   * derived from the envelope for indexing — the source of truth is the
   * `envelope` JSON column.
   *
   * MUST be called BEFORE broadcasting to subscribers.
   */
  insertEvent(envelope: EventEnvelope): number {
    const row = this.insertEventStmt.get({
      $id: envelope.id,
      $sessionId: envelope.sessionId,
      $type: envelope.type,
      $ts: envelope.ts,
      $envelope: JSON.stringify(envelope),
    }) as { eventId: number };
    return row.eventId;
  }

  /** Default and maximum replay limits to prevent unbounded queries. */
  static readonly DEFAULT_REPLAY_LIMIT = 1000;
  static readonly MAX_REPLAY_LIMIT = 10_000;

  /**
   * Get all events for a session with event_id > afterEventId.
   * If afterEventId is 0, returns ALL events (full replay).
   * Results are clamped to `limit` rows (default 1 000, max 10 000).
   */
  getEventsAfter(
    sessionId: string,
    afterEventId: number = 0,
    limit: number = EventStore.DEFAULT_REPLAY_LIMIT,
  ): StoredEvent[] {
    const clampedLimit = Math.min(Math.max(1, limit), EventStore.MAX_REPLAY_LIMIT);
    return this.getEventsAfterStmt.all({
      $sessionId: sessionId,
      $afterEventId: afterEventId,
      $limit: clampedLimit,
    }) as StoredEvent[];
  }

  /**
   * Get all events for a session (full history).
   */
  getAllEvents(sessionId: string): StoredEvent[] {
    return this.getAllEventsStmt.all({ $sessionId: sessionId }) as StoredEvent[];
  }

  /**
   * Get the latest cursor (event_id) for a session.
   * Returns 0 if no events exist.
   */
  getLatestCursor(sessionId: string): number {
    const row = this.getLatestCursorStmt.get({ $sessionId: sessionId }) as {
      cursor: number | null;
    };
    return row?.cursor ?? 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
