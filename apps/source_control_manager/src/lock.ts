import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_BACKEND = "sqlite-v1";

/**
 * Process-lifetime exclusive lock for SourceControlManager.
 *
 * The dedicated SQLite connection holds BEGIN EXCLUSIVE until release/exit.
 * SQLite's OS locks serialize acquisition and disappear on process death, so
 * crash recovery never needs a racy read-PID/unlink/recreate sequence. Never
 * delete or replace the SQLite file: doing so can create two locking domains.
 *
 * merge_queue.lock remains diagnostic/legacy metadata, not the ownership
 * authority. Live legacy holders are respected, and new metadata is published
 * atomically for old readers. Mixed-version concurrent starts still inherit
 * the old binary's unsafe stale-file reclamation protocol; all contenders must
 * use this implementation for the lifetime-lock guarantee.
 */
export class FileLock {
  private readonly lockPath: string;
  private readonly databasePath: string;
  private database: Database | null = null;
  private readonly onExit = (): void => this.release();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.lockPath = join(stateDir, "merge_queue.lock");
    this.databasePath = join(stateDir, "merge_queue.lock.sqlite");
  }

  /** Returns false for a competing owner; other I/O failures remain visible. */
  acquire(): boolean {
    if (this.database) return true;

    let candidate: Database | null = null;
    try {
      candidate = new Database(this.databasePath, { create: true });
      // Contention must not block SCM's synchronous startup path.
      candidate.exec("PRAGMA busy_timeout = 0;");
      candidate.exec("BEGIN EXCLUSIVE;");

      const previous = this.readMetadata();
      if (
        previous?.lockBackend !== LOCK_BACKEND &&
        Number.isSafeInteger(previous?.pid) &&
        Number(previous?.pid) > 0 &&
        isProcessAlive(Number(previous?.pid))
      ) {
        return false;
      }

      // Once SQLite is exclusively held, prior modern metadata cannot denote
      // a live owner, even if its PID has been reused. Do not unlink metadata
      // on release: an old instance must never remove a successor's record.
      this.publishMetadata();
      process.once("exit", this.onExit);
      this.database = candidate;
      candidate = null;
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return false;
      throw error;
    } finally {
      // Closing rolls back an open transaction and releases its OS lock,
      // including every failure after BEGIN EXCLUSIVE but before ownership.
      candidate?.close(true);
    }
  }

  release(): void {
    if (!this.database) return;
    this.database.close(true);
    this.database = null;
    process.removeListener("exit", this.onExit);
  }

  isHeld(): boolean {
    return this.database !== null;
  }

  private readMetadata(): { pid?: unknown; lockBackend?: unknown } | null {
    let contents: string;
    try {
      contents = readFileSync(this.lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // A killed legacy writer can leave incomplete JSON. SQLite already
      // serializes recovery, so corrupt metadata is not an ownership token.
      return null;
    }
  }

  private publishMetadata(): void {
    const token = randomUUID();
    const temporaryPath = `${this.lockPath}.${token}.tmp`;
    // Do not remove a pre-existing staging path if exclusive creation fails.
    const descriptor = openSync(temporaryPath, "wx");
    try {
      try {
        writeFileSync(
          descriptor,
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            lockBackend: LOCK_BACKEND,
            token,
          }),
        );
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.lockPath);
    } finally {
      try {
        // Only this acquisition's private staging path may be removed.
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * Only used while migrating an unversioned/unknown-backend legacy record.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    // An indeterminate probe must not authorize taking a legacy owner's lock.
    throw error;
  }
}
