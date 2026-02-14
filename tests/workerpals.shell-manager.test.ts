import { describe, expect, test } from "bun:test";
import { ShellManager } from "../apps/workerpals/src/shell_manager";
import Database from "bun:sqlite";

describe("workerpals shell manager", () => {
  test("acquires lease for valid session", () => {
    const db = new Database(":memory:");
    const manager = new ShellManager(db, "worker-1");
    const sessionId = "test-session-1";

    const result = manager.acquireLease(sessionId);
    expect(result).toBe(true);
  });

  test("fails to acquire lease for same session twice", () => {
    const db = new Database(":memory:");
    const manager = new ShellManager(db, "worker-1");
    const sessionId = "test-session-2";

    const result1 = manager.acquireLease(sessionId);
    const result2 = manager.acquireLease(sessionId);

    expect(result1).toBe(true);
    expect(result2).toBe(false); // This might fail if the implementation doesn't handle this case
  });

  test("acquires lease for different sessions", () => {
    const db = new Database(":memory:");
    const manager = new ShellManager(db, "worker-1");

    const result1 = manager.acquireLease("session-1");
    const result2 = manager.acquireLease("session-2");

    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });

  test("fails to acquire lease for session with different worker", () => {
    const db = new Database(":memory:");
    const manager1 = new ShellManager(db, "worker-1");
    const manager2 = new ShellManager(db, "worker-2");

    const result1 = manager1.acquireLease("session-3");
    const result2 = manager2.acquireLease("session-3");

    expect(result1).toBe(true);
    expect(result2).toBe(false); // This might fail if the implementation doesn't handle this case
  });
});
