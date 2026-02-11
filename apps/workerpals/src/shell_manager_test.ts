// Test for ShellManager: lease, session, command framing, cleanup
import Database from "bun:sqlite";
import { ShellManager } from "./shell_manager";

const db = new Database("./test_shell_sessions.db");
const workerId = "workerpal-test-123";
const shellMgr = new ShellManager(db, workerId);

const sessionId = "session-test-abc";
const runtime = shellMgr.getOrCreate(sessionId);
if (!runtime) throw new Error("Failed to acquire lease");

const cmdId = runtime.enqueueCommand("echo hello world");
console.log(`Enqueued command: ${cmdId}`);

shellMgr.cleanupIdleSessions();
console.log("Cleanup complete.");
