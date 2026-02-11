import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";

/**
 * File-based exclusive lock for SourceControlManager.
 *
 * Ensures only one SourceControlManager instance operates on a repo at a time.
 * The lock file contains the PID and start time of the holder.
 * Acquire on startup, hold for process lifetime, release on exit.
 */
export class FileLock {
  private lockPath: string;
  private held = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.lockPath = join(stateDir, "merge_queue.lock");
  }

  /**
   * Attempt to acquire the lock. Returns true if acquired.
   * If a stale lock is detected (holder PID no longer running), it is removed.
   */
  acquire(): boolean {
    if (this.held) return true;

    if (existsSync(this.lockPath)) {
      // Check if holding process is still alive
      try {
        const contents = readFileSync(this.lockPath, "utf-8");
        const parsed = JSON.parse(contents);
        const pid = parsed.pid as number;

        if (isProcessAlive(pid)) {
          return false; // Another live instance holds the lock
        }
        // Stale lock — remove it
        unlinkSync(this.lockPath);
      } catch {
        // Corrupt lock file — remove it
        try {
          unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      }
    }

    // Write our lock file atomically
    const lockData = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    try {
      // Use writeFileSync with 'wx' flag for exclusive creation
      writeFileSync(this.lockPath, lockData, { flag: "wx" });
      this.held = true;
      // Register only the 'exit' hook for last-resort cleanup.
      // Signal handling (SIGINT/SIGTERM) is owned by the daemon entry point
      // (source_control_manager_main.ts) which calls lock.release() during shutdown.
      process.on("exit", () => this.release());
      return true;
    } catch {
      // Race condition — another process beat us to it
      return false;
    }
  }

  /**
   * Release the lock.
   */
  release(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // ignore — file may already be removed
    }
    this.held = false;
  }

  /**
   * Check if the lock is currently held by this process.
   */
  isHeld(): boolean {
    return this.held;
  }
}

/**
 * Check if a process with the given PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we lack permission to signal it —
    // treat as alive to avoid stealing a valid lock.
    if (e.code === "EPERM") return true;
    return false;
  }
}
