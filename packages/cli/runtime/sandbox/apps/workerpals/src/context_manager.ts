// ContextManager: persists session context (env, metadata, etc.) in SQLite
import Database from "bun:sqlite";

export class ContextManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  ensureTable() {
    this.db.run(`CREATE TABLE IF NOT EXISTS session_context (
      session_id TEXT,
      key TEXT,
      value TEXT,
      updated_at INTEGER,
      PRIMARY KEY (session_id, key)
    )`);
  }

  get(sessionId: string, key: string): string | null {
    const row = this.db
      .query(`SELECT value FROM session_context WHERE session_id = ? AND key = ?`)
      .get(sessionId, key) as { value: string } | null;
    return row ? row.value : null;
  }

  set(sessionId: string, key: string, value: string) {
    const now = Date.now();
    this.db.run(
      `INSERT OR REPLACE INTO session_context (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      [sessionId, key, value, now],
    );
  }

  getAll(sessionId: string): Record<string, string> {
    const rows = this.db
      .query(`SELECT key, value FROM session_context WHERE session_id = ?`)
      .all(sessionId) as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }
}
