import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../apps/server/src/db";

const lockerSource = `
import { Database } from 'bun:sqlite';
const db = new Database(process.env.PUSHPALS_TEST_LOCK_DB);
db.exec('BEGIN EXCLUSIVE');
console.log('LOCKED');
setTimeout(() => { db.exec('COMMIT'); db.close(); console.log('RELEASED'); }, Number(process.env.PUSHPALS_TEST_LOCK_MS));
`;

async function withDatabaseLock(holdMs: number, action: (path: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pushpals-event-startup-lock-"));
  const path = join(root, "events.sqlite");
  const seed = new Database(path);
  seed.exec(
    "PRAGMA journal_mode = DELETE; CREATE TABLE existing_data(value TEXT); INSERT INTO existing_data VALUES ('preserved');",
  );
  seed.close();
  const locker = Bun.spawn([process.execPath, "-e", lockerSource], {
    env: { ...process.env, PUSHPALS_TEST_LOCK_DB: path, PUSHPALS_TEST_LOCK_MS: String(holdMs) },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stderr = new Response(locker.stderr).text();
  const reader = locker.stdout.getReader();
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        readinessTimer = setTimeout(
          () => reject(new Error("SQLite locker did not become ready")),
          3_000,
        );
      }),
    ]);
    clearTimeout(readinessTimer);
    expect(new TextDecoder().decode(first.value)).toContain("LOCKED");
    action(path);
  } finally {
    clearTimeout(readinessTimer);
    locker.kill();
    await Promise.race([
      locker.exited,
      Bun.sleep(2_000).then(() => {
        throw new Error("SQLite locker did not stop");
      }),
    ]);
    try {
      await reader.cancel();
    } catch {
      /* process already stopped */
    }
    await stderr;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("EventStore startup SQLite locks", () => {
  test("waits for a real transient lock before enabling WAL, preserving data and runtime wait policy", async () => {
    await withDatabaseLock(200, (path) => {
      const startedAt = Date.now();
      const store = new EventStore(path);
      try {
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        expect(store.createSession("after-lock", "Recovered startup")).toBe(true);
        expect(store.getSession("after-lock")?.label).toBe("Recovered startup");
        const db = (store as unknown as { db: Database }).db;
        expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
        expect(db.query("SELECT value FROM existing_data").get()).toEqual({ value: "preserved" });
      } finally {
        store.close();
      }
    });
  }, 8_000);

  test("persistent lock fails within the startup bound without leaving an owned connection", async () => {
    await withDatabaseLock(5_000, (path) => {
      const startedAt = Date.now();
      const close = spyOn(Database.prototype, "close");
      try {
        expect(() => new EventStore(path, { startupBusyTimeoutMs: 75 })).toThrow(/locked|busy/i);
        expect(Date.now() - startedAt).toBeLessThan(500);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
      }
    });
  }, 8_000);
});
