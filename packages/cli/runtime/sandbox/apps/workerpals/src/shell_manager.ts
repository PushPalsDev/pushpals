// Persistent ShellManager for multi-worker shell sessions
// Milestone 1: Correctness, lease management, command framing, audit logging

import { spawn } from "bun";
import Database from "bun:sqlite";
import { randomUUID } from "crypto";
import { ContextManager } from "./context_manager";

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min
const LEASE_DURATION_MS = 60 * 1000; // 1 min

export interface ShellCommand {
  cmdId: string;
  command: string;
  status: "pending" | "running" | "completed" | "crashed" | "killed";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  startedAt?: number;
  completedAt?: number;
}

export class ShellManager {
  private db: Database;
  private workerId: string;
  private sessions = new Map<string, ShellSessionRuntime>();
  private contextMgr: ContextManager;

  constructor(db: Database, workerId: string) {
    this.db = db;
    this.workerId = workerId;
    this.contextMgr = new ContextManager(db);
    this.ensureTables();
  }

  ensureTables() {
    this.db.run(`CREATE TABLE IF NOT EXISTS shell_sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT,
      lease_expiry INTEGER,
      last_used_at INTEGER,
      last_known_cwd TEXT,
      status TEXT
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS shell_commands (
      cmd_id TEXT PRIMARY KEY,
      session_id TEXT,
      command TEXT,
      status TEXT,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      started_at INTEGER,
      completed_at INTEGER
    )`);
  }

  acquireLease(sessionId: string): boolean {
    const now = Date.now();
    const expiry = now + LEASE_DURATION_MS;
    // Try to acquire lease
    this.db.run(
      `INSERT OR IGNORE INTO shell_sessions (session_id, worker_id, lease_expiry, last_used_at, status) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, this.workerId, expiry, now, "active"],
    );
    const row = this.db
      .query(`SELECT worker_id, lease_expiry FROM shell_sessions WHERE session_id = ?`)
      .get(sessionId) as { worker_id: string; lease_expiry: number } | null;
    if (row && (row.worker_id === this.workerId || row.lease_expiry < now)) {
      this.db.run(
        `UPDATE shell_sessions SET worker_id = ?, lease_expiry = ?, last_used_at = ?, status = ? WHERE session_id = ?`,
        [this.workerId, expiry, now, "active", sessionId],
      );
      return true;
    }
    return false;
  }

  getOrCreate(sessionId: string): ShellSessionRuntime | null {
    if (!this.acquireLease(sessionId)) return null;
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      // Restore last_known_cwd from context
      const cwd = this.contextMgr.get(sessionId, "last_known_cwd") || process.cwd();
      runtime = new ShellSessionRuntime(sessionId, this.workerId, this.db, this.contextMgr, cwd);
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  cleanupIdleSessions() {
    const now = Date.now();
    for (const [sessionId, runtime] of this.sessions) {
      if (now - runtime.lastUsedAt > SESSION_TTL_MS) {
        runtime.terminate();
        this.sessions.delete(sessionId);
        this.db.run(`UPDATE shell_sessions SET status = ? WHERE session_id = ?`, [
          "stopped",
          sessionId,
        ]);
      }
    }
  }

  startContextRefresh(intervalMs = 10000) {
    setInterval(() => {
      for (const sessionId of this.sessions.keys()) {
        // Refresh context for this session
        const context = this.contextMgr.getAll(sessionId);
        // Feed context to agent if handler exists
        const session = this.sessions.get(sessionId);
        if (session && typeof session.onContextRefresh === "function") {
          session.onContextRefresh(context);
        }
      }
    }, intervalMs);
  }
}

export class ShellSessionRuntime {
  private sessionId: string;
  private workerId: string;
  private db: Database;
  private shellProc: ReturnType<typeof spawn> | null = null;
  private commandQueue: ShellCommand[] = [];
  public lastUsedAt: number = Date.now();
  public cwd: string = process.cwd();
  private running: boolean = false;
  private contextMgr: ContextManager;
  public onContextRefresh?: (context: Record<string, string>) => void;

  constructor(
    sessionId: string,
    workerId: string,
    db: Database,
    contextMgr: ContextManager,
    cwd: string,
  ) {
    this.sessionId = sessionId;
    this.workerId = workerId;
    this.db = db;
    this.contextMgr = contextMgr;
    this.cwd = cwd;
    this.spawnShell();
  }

  spawnShell() {
    // Spawn shell process (PowerShell or bash)
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "powershell.exe" : "bash";
    this.shellProc = spawn([shell], {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Attach parser, etc.
  }

  terminate() {
    if (this.shellProc) {
      this.shellProc.kill();
      this.shellProc = null;
    }
  }

  enqueueCommand(command: string) {
    const cmdId = randomUUID();
    const shellCmd: ShellCommand = {
      cmdId,
      command,
      status: "pending",
      startedAt: Date.now(),
    };
    this.commandQueue.push(shellCmd);
    const startedAt = shellCmd.startedAt ?? Date.now();
    this.db.run(
      `INSERT INTO shell_commands (cmd_id, session_id, command, status, started_at) VALUES (?, ?, ?, ?, ?)`,
      [cmdId, this.sessionId, command, "pending", startedAt],
    );
    this.processQueue();
    return cmdId;
  }

  async processQueue() {
    if (this.running || this.commandQueue.length === 0) return;
    this.running = true;
    const cmd = this.commandQueue.shift();
    if (!cmd || !this.shellProc) {
      this.running = false;
      return;
    }
    // Framing: BEGIN/EXIT/CWD/END
    const framed = `echo BEGIN ${cmd.cmdId}\n${cmd.command}\necho EXIT ${cmd.cmdId} $?\necho CWD ${cmd.cmdId} $(pwd)\necho END ${cmd.cmdId}`;
    const stdin = this.shellProc.stdin;
    if (!stdin || typeof stdin === "number" || typeof stdin.write !== "function") {
      this.running = false;
      return;
    }
    stdin.write(framed + "\n");
    // TODO: parse output, update db, handle exit/cwd
    // TODO: renew lease, update last_used_at
    // On command completion, update last_known_cwd in context
    if (this.cwd) {
      this.contextMgr.set(this.sessionId, "last_known_cwd", this.cwd);
    }
    this.running = false;
    this.processQueue();
  }
}
