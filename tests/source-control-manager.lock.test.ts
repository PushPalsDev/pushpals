import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileLock } from "../apps/source_control_manager/src/lock";

function withLocks(action: (root: string, first: FileLock, second: FileLock) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pushpals-scm-lock-"));
  const first = new FileLock(root);
  const second = new FileLock(root);
  try {
    action(root, first, second);
  } finally {
    first.release();
    second.release();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("SourceControlManager lifetime lock", () => {
  test("real SQLite connections exclude contenders without waiting and support release/reacquire", () => {
    withLocks((root, first, second) => {
      const originalExitListeners = process.listenerCount("exit");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(first.acquire()).toBe(true);
        expect(first.acquire()).toBe(true);
        expect(process.listenerCount("exit")).toBe(originalExitListeners + 1);
        const startedAt = Date.now();
        expect(second.acquire()).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(500);
        expect(first.isHeld()).toBe(true);
        expect(second.isHeld()).toBe(false);

        first.release();
        expect(process.listenerCount("exit")).toBe(originalExitListeners);
        expect(existsSync(join(root, "merge_queue.lock.sqlite"))).toBe(true);
        expect(second.acquire()).toBe(true);
        // A duplicate/stale release cannot release the successor's connection.
        first.release();
        expect(first.acquire()).toBe(false);
        expect(second.isHeld()).toBe(true);
        second.release();
        expect(process.listenerCount("exit")).toBe(originalExitListeners);
      }
    });
  });

  test("serializes the exact stale-read/reentrant-acquire interleaving that admitted two owners", () => {
    withLocks((root, first, second) => {
      const stalePid = 2_147_483_000;
      writeFileSync(join(root, "merge_queue.lock"), JSON.stringify({ pid: stalePid }));
      let nestedAcquisition: boolean | undefined;
      const probe = spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(stalePid);
        expect(signal).toBe(0);
        // The first owner has read stale metadata but has not published its
        // replacement yet. The old unlink/recreate implementation admitted
        // second here and then removed second's freshly acquired record.
        nestedAcquisition = second.acquire();
        throw Object.assign(new Error("stale PID"), { code: "ESRCH" });
      });
      try {
        expect(first.acquire()).toBe(true);
        expect(nestedAcquisition).toBe(false);
        expect(first.isHeld()).toBe(true);
        expect(second.isHeld()).toBe(false);
        expect(probe).toHaveBeenCalledTimes(1);
        first.release();
        expect(second.acquire()).toBe(true);
      } finally {
        probe.mockRestore();
      }
    });
  });

  test("release never removes replaced metadata or the shared SQLite locking domain", () => {
    withLocks((root, first, second) => {
      expect(first.acquire()).toBe(true);
      const metadataPath = join(root, "merge_queue.lock");
      const replacement = JSON.stringify({ pid: process.pid, token: "replacement" });
      writeFileSync(metadataPath, replacement);
      expect(second.acquire()).toBe(false);
      first.release();
      expect(readFileSync(metadataPath, "utf8")).toBe(replacement);
      expect(existsSync(join(root, "merge_queue.lock.sqlite"))).toBe(true);
      // The replaced record is legacy/unknown, so its live PID is respected.
      expect(second.acquire()).toBe(false);
    });
  });

  test("live legacy records remain protected regardless of token or unknown backend", () => {
    withLocks((root, first) => {
      for (const extra of [
        {},
        { token: "old-token" },
        { lockBackend: "unknown", token: "token" },
      ]) {
        const record = JSON.stringify({ pid: process.pid, ...extra });
        writeFileSync(join(root, "merge_queue.lock"), record);
        expect(first.acquire()).toBe(false);
        expect(first.isHeld()).toBe(false);
        expect(readFileSync(join(root, "merge_queue.lock"), "utf8")).toBe(record);
        // A rejected legacy owner check must close/roll back its candidate DB.
        const db = new Database(join(root, "merge_queue.lock.sqlite"));
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } finally {
          db.close(true);
        }
      }
    });
  });

  test("EPERM preserves a legacy owner and indeterminate probes fail closed", () => {
    withLocks((root, first, second) => {
      writeFileSync(join(root, "merge_queue.lock"), JSON.stringify({ pid: 123 }));
      const probe = spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      });
      try {
        expect(first.acquire()).toBe(false);
        probe.mockImplementation(() => {
          throw Object.assign(new Error("indeterminate probe"), { code: "EIO" });
        });
        expect(() => first.acquire()).toThrow("indeterminate probe");
        probe.mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        });
        expect(second.acquire()).toBe(true);
      } finally {
        probe.mockRestore();
      }
    });
  });

  test("recovers corrupt metadata and modern stale metadata even when the PID is reused", () => {
    withLocks((root, first) => {
      const probe = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("modern ownership must not depend on PID liveness");
      });
      try {
        for (const metadata of [
          "",
          "{incomplete",
          JSON.stringify({ pid: process.pid, lockBackend: "sqlite-v1", token: "dead-owner" }),
        ]) {
          writeFileSync(join(root, "merge_queue.lock"), metadata);
          expect(first.acquire()).toBe(true);
          first.release();
        }
        expect(probe).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
      }
    });
  });

  test("metadata publication failure rolls back and closes the acquired connection", () => {
    withLocks((_root, first, second) => {
      const originalExitListeners = process.listenerCount("exit");
      const publish = spyOn(
        first as unknown as { publishMetadata(): void },
        "publishMetadata",
      ).mockImplementation(() => {
        throw new Error("metadata publication failed");
      });
      try {
        expect(() => first.acquire()).toThrow("metadata publication failed");
        expect(first.isHeld()).toBe(false);
        expect(process.listenerCount("exit")).toBe(originalExitListeners);
        expect(second.acquire()).toBe(true);
      } finally {
        publish.mockRestore();
      }
    });
  });

  test("SQLite setup failure closes the candidate without retaining ownership", () => {
    withLocks((_root, first, second) => {
      const setup = spyOn(Database.prototype, "exec").mockImplementationOnce(() => {
        throw new Error("SQLite setup failed");
      });
      const close = spyOn(Database.prototype, "close");
      try {
        expect(() => first.acquire()).toThrow("SQLite setup failed");
        expect(close).toHaveBeenCalledTimes(1);
        expect(first.isHeld()).toBe(false);
        expect(second.acquire()).toBe(true);
      } finally {
        setup.mockRestore();
        close.mockRestore();
      }
    });
  });

  // Run in the normal isolated Bun/CI test environment, not against a runtime.
  test("a killed child releases its OS lock without running JavaScript cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-scm-lock-crash-"));
    const cleanupMarker = join(root, "exit-hook-ran");
    const lockModule = resolve(import.meta.dir, "../apps/source_control_manager/src/lock.ts");
    const source = [
      `import { FileLock } from ${JSON.stringify(lockModule)};`,
      `import { writeFileSync } from 'node:fs';`,
      `const lock = new FileLock(${JSON.stringify(root)});`,
      `if (!lock.acquire()) process.exit(2);`,
      `process.once('exit', () => writeFileSync(${JSON.stringify(cleanupMarker)}, 'ran'));`,
      `console.log('LOCKED');`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", source], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    const successor = new FileLock(root);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const waitForChildExit = async (): Promise<void> => {
      let exitDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_resolve, reject) => {
            exitDeadline = setTimeout(() => reject(new Error("lock child did not exit")), 3_000);
          }),
        ]);
      } finally {
        clearTimeout(exitDeadline);
      }
    };
    try {
      const readiness = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("lock child did not become ready")), 3_000);
        }),
      ]);
      clearTimeout(deadline);
      expect(new TextDecoder().decode(readiness.value)).toContain("LOCKED");
      expect(successor.acquire()).toBe(false);
      child.kill("SIGKILL");
      await waitForChildExit();
      expect(existsSync(cleanupMarker)).toBe(false);
      expect(existsSync(join(root, "merge_queue.lock"))).toBe(true);
      expect(successor.acquire()).toBe(true);
    } finally {
      clearTimeout(deadline);
      try {
        child.kill("SIGKILL");
      } catch {
        // Only the fixture child is targeted; it may already have exited.
      }
      await waitForChildExit();
      await reader.cancel();
      await stderr;
      successor.release();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
