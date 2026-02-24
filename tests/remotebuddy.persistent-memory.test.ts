import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PersistentSessionMemory } from "../apps/remotebuddy/src/persistent_memory";

describe("remotebuddy persistent session memory", () => {
  test("recalls repo history across sessions from sqlite", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-memory-"));
    const dbPath = join(root, "remotebuddy-state.db");
    const repoRoot = "C:/repo/pushpals";

    try {
      const writer = new PersistentSessionMemory(dbPath);
      writer.remember(
        {
          repoRoot,
          sessionId: "session-a",
          requestId: "req-1",
          kind: "request",
          summary: "User asked to stabilize review-agent threshold handling.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );
      writer.remember(
        {
          repoRoot,
          sessionId: "session-a",
          requestId: "req-1",
          kind: "plan",
          summary: "Plan set threshold gating to score-only and updated config wiring.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );
      writer.close();

      const reader = new PersistentSessionMemory(dbPath);
      const recalled = reader.recallForPlanning({
        repoRoot,
        sessionId: "session-b",
        includeCurrentSession: true,
        includeCrossSession: true,
        maxItems: 8,
        maxChars: 2000,
      });
      reader.close();

      expect(recalled.length).toBeGreaterThan(0);
      expect(recalled.join("\n")).toContain("repo-history");
      expect(recalled.join("\n")).toContain("threshold");
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can briefly hold sqlite handles; cleanup is best-effort in tests.
      }
    }
  });

  test("scopes recall to repo and enforces recall limits", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-memory-"));
    const dbPath = join(root, "remotebuddy-state.db");
    const repoA = "C:/repo/pushpals";
    const repoB = "C:/repo/other";

    try {
      const store = new PersistentSessionMemory(dbPath);
      store.remember(
        {
          repoRoot: repoA,
          sessionId: "session-a",
          kind: "note",
          summary: "First memory item about repo A test coverage gaps.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );
      store.remember(
        {
          repoRoot: repoA,
          sessionId: "session-a",
          kind: "note",
          summary: "Second memory item about repo A queue behavior and retry semantics.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );
      store.remember(
        {
          repoRoot: repoB,
          sessionId: "session-z",
          kind: "note",
          summary: "Memory from repo B that must never bleed into repo A context.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );

      const recalled = store.recallForPlanning({
        repoRoot: repoA,
        sessionId: "session-a",
        includeCurrentSession: true,
        includeCrossSession: true,
        maxItems: 1,
        maxChars: 110,
      });
      store.close();

      expect(recalled.length).toBe(1);
      expect(recalled.join("\n")).not.toContain("repo B");
      expect(recalled.join("\n").length).toBeLessThanOrEqual(110);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can briefly hold sqlite handles; cleanup is best-effort in tests.
      }
    }
  });

  test("retries SQLITE_BUSY during remember insert and persists once lock clears", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-memory-"));
    const dbPath = join(root, "remotebuddy-state.db");
    const repoRoot = "C:/repo/pushpals";
    const store = new PersistentSessionMemory(dbPath);
    const db = (store as unknown as { db: { prepare: (sql: string) => any } }).db;
    const originalPrepare = db.prepare.bind(db);
    let busyRemaining = 2;

    db.prepare = ((sql: string) => {
      const stmt = originalPrepare(sql);
      if (!/INSERT INTO remotebuddy_memory/i.test(sql)) return stmt;
      const originalRun = stmt.run.bind(stmt);
      stmt.run = (...args: unknown[]) => {
        if (busyRemaining > 0) {
          busyRemaining -= 1;
          const err = new Error("database is locked") as Error & { code?: string; errno?: number };
          err.code = "SQLITE_BUSY";
          err.errno = 5;
          throw err;
        }
        return originalRun(...args);
      };
      return stmt;
    }) as typeof db.prepare;

    try {
      store.remember(
        {
          repoRoot,
          sessionId: "session-a",
          requestId: "req-1",
          kind: "note",
          summary: "Memory write should survive transient SQLITE_BUSY lock.",
        },
        { retentionDays: 30, maxSummaryChars: 420 },
      );
      const recalled = store.recallForPlanning({
        repoRoot,
        sessionId: "session-a",
        includeCurrentSession: true,
        includeCrossSession: true,
        maxItems: 5,
        maxChars: 1200,
      });
      expect(busyRemaining).toBe(0);
      expect(recalled.join("\n")).toContain("transient SQLITE_BUSY lock");
    } finally {
      db.prepare = originalPrepare;
      store.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows can briefly hold sqlite handles; cleanup is best-effort in tests.
      }
    }
  });
});
