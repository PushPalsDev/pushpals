import { describe, expect, test } from "bun:test";
import { ContextManager } from "../apps/workerpals/src/context_manager";
import { Database } from "bun:sqlite";

describe("workerpals ContextManager", () => {
  test("creates session context table on initialization", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(rows).toContainEqual({ name: "session_context" });
  });

  test("sets and retrieves a single context value", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    manager.set("session-1", "key-1", "value-1");
    expect(manager.get("session-1", "key-1")).toBe("value-1");
  });

  test("returns null for non-existent context values", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    expect(manager.get("session-1", "key-1")).toBeNull();
  });

  test("overwrites existing context values", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    manager.set("session-1", "key-1", "value-1");
    manager.set("session-1", "key-1", "value-2");
    expect(manager.get("session-1", "key-1")).toBe("value-2");
  });

  test("retrieves all context values for a session", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    manager.set("session-1", "key-1", "value-1");
    manager.set("session-1", "key-2", "value-2");
    manager.set("session-2", "key-1", "value-3");

    const session1 = manager.getAll("session-1");
    expect(session1).toEqual({ "key-1": "value-1", "key-2": "value-2" });

    const session2 = manager.getAll("session-2");
    expect(session2).toEqual({ "key-1": "value-3" });
  });

  test("returns empty object for session with no context", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    expect(manager.getAll("session-1")).toEqual({});
  });

  test("handles multiple sessions independently", () => {
    const db = new Database(":memory:");
    const manager = new ContextManager(db);
    manager.set("session-1", "key-1", "value-1");
    manager.set("session-2", "key-2", "value-2");

    expect(manager.get("session-1", "key-1")).toBe("value-1");
    expect(manager.get("session-2", "key-2")).toBe("value-2");
    expect(manager.get("session-1", "key-2")).toBeNull();
    expect(manager.get("session-2", "key-1")).toBeNull();
  });
});