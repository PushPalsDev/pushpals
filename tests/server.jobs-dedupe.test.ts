import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../apps/server/src/jobs";

describe("server JobQueue dedupe", () => {
  test("dedupes against active pending/claimed jobs by dedupeKey", () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-dup-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:22:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const second = queue.enqueue({
      taskId: "task-dup-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "PR:22:ABCD1234",
      dedupeCooldownMs: 60_000,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-dup-1");
    queue.close();
  });

  test("dedupes during cooldown after previous job completed", () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-cooldown-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:23:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-1");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.id).toBe(firstJobId);
    const completed = queue.complete(firstJobId, { summary: "ok" });
    expect(completed.ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-cooldown-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:23:abcd1234",
      dedupeCooldownMs: 60_000,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-cooldown-1");
    queue.close();
  });

  test("preserves multi-hour dedupe cooldowns for repeated autonomy work", () => {
    const queue = new JobQueue(":memory:");
    const cooldownMs = 6 * 60 * 60 * 1000;
    const first = queue.enqueue({
      taskId: "task-autonomy-cooldown-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "task.execute:autonomy:dev:app/__tests__/contract.test.ts",
      dedupeCooldownMs: cooldownMs,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");
    expect(firstJobId.length).toBeGreaterThan(0);

    const claimed = queue.claim("worker-autonomy");
    expect(claimed.ok).toBe(true);
    expect(claimed.job?.dedupeCooldownMs).toBe(cooldownMs);
    expect(queue.complete(firstJobId, { summary: "no publishable patch" }).ok).toBe(true);

    const second = queue.enqueue({
      taskId: "task-autonomy-cooldown-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "task.execute:autonomy:dev:app/__tests__/contract.test.ts",
      dedupeCooldownMs: cooldownMs,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(firstJobId);
    expect(second.taskId).toBe("task-autonomy-cooldown-1");
    queue.close();
  });

  test("allows enqueue after dedupe cooldown expires", async () => {
    const queue = new JobQueue(":memory:");
    const first = queue.enqueue({
      taskId: "task-cooldown-expire-1",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:24:abcd1234",
      dedupeCooldownMs: 25,
    });
    expect(first.ok).toBe(true);
    const firstJobId = String(first.jobId ?? "");

    const claimed = queue.claim("worker-2");
    expect(claimed.ok).toBe(true);
    const completed = queue.complete(firstJobId, { summary: "ok" });
    expect(completed.ok).toBe(true);

    await Bun.sleep(40);

    const second = queue.enqueue({
      taskId: "task-cooldown-expire-2",
      sessionId: "dev",
      kind: "task.execute",
      params: {},
      dedupeKey: "pr:24:abcd1234",
      dedupeCooldownMs: 25,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).not.toBe(true);
    expect(second.jobId).not.toBe(firstJobId);
    queue.close();
  });

  test("reconciles active dedupe collisions created by the legacy index", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-job-dedupe-migration-"));
    const dbPath = join(root, "jobs.db");
    let queue: JobQueue | null = null;

    try {
      queue = new JobQueue(dbPath);
      const enqueue = (taskId: string, dedupeKey: string): string => {
        const result = queue!.enqueue({
          taskId,
          sessionId: "dev",
          kind: "task.execute",
          params: {},
          dedupeKey,
        });
        expect(result.ok).toBe(true);
        return String(result.jobId ?? "");
      };

      const finalizingForPending = enqueue("legacy-finalizing-pending", "seed:1");
      const pendingDuplicate = enqueue("legacy-pending-duplicate", "seed:2");
      const finalizingForClaimed = enqueue("legacy-finalizing-claimed", "seed:3");
      const claimedDuplicate = enqueue("legacy-claimed-duplicate", "seed:4");
      const firstPublication = enqueue("legacy-publication-1", "seed:5");
      const secondPublication = enqueue("legacy-publication-2", "seed:6");
      queue.close();
      queue = null;

      const legacy = new Database(dbPath);
      const seededAt = new Date().toISOString();
      try {
        legacy.exec(`
          CREATE TABLE requests (
            id TEXT PRIMARY KEY,
            handoffJobId TEXT,
            workerRequired INTEGER NOT NULL DEFAULT 1,
            updatedAt TEXT
          );
          CREATE TABLE autonomy_objectives (
            id TEXT PRIMARY KEY,
            job_id TEXT,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        legacy.exec(`DROP INDEX idx_jobs_dedupe_active;`);
        legacy
          .prepare(`UPDATE jobs SET status = 'finalizing', dedupeKey = ? WHERE id = ?`)
          .run("legacy:pending", finalizingForPending);
        legacy
          .prepare(`UPDATE jobs SET dedupeKey = ? WHERE id = ?`)
          .run("legacy:pending", pendingDuplicate);
        legacy
          .prepare(`UPDATE jobs SET status = 'finalizing', dedupeKey = ? WHERE id = ?`)
          .run("legacy:claimed", finalizingForClaimed);
        legacy
          .prepare(
            `UPDATE jobs
             SET status = 'claimed',
                 dedupeKey = ?,
                 workerId = 'legacy-worker',
                 claimGeneration = 3,
                 claimedAt = ?,
                 startedAt = ?,
                 lastActivityAt = ?
             WHERE id = ?`,
          )
          .run("legacy:claimed", seededAt, seededAt, seededAt, claimedDuplicate);
        legacy
          .prepare(`UPDATE jobs SET status = 'finalizing', dedupeKey = ? WHERE id = ?`)
          .run("legacy:publication", firstPublication);
        legacy
          .prepare(`UPDATE jobs SET status = 'finalizing', dedupeKey = ? WHERE id = ?`)
          .run("legacy:publication", secondPublication);
        legacy
          .prepare(
            `INSERT INTO workers (
               workerId, status, currentJobId, lastHeartbeat, createdAt, updatedAt
             ) VALUES ('legacy-worker', 'busy', ?, ?, ?, ?)`,
          )
          .run(claimedDuplicate, seededAt, seededAt, seededAt);
        const seedRequestOwner = legacy.prepare(
          `INSERT INTO requests (id, handoffJobId, workerRequired, updatedAt)
           VALUES (?, ?, 1, ?)`,
        );
        seedRequestOwner.run("request-pending-duplicate", pendingDuplicate, seededAt);
        seedRequestOwner.run("request-claimed-duplicate", claimedDuplicate, seededAt);
        const seedObjectiveOwner = legacy.prepare(
          `INSERT INTO autonomy_objectives (id, job_id, status, updated_at)
           VALUES (?, ?, 'running', ?)`,
        );
        seedObjectiveOwner.run("objective-pending-duplicate", pendingDuplicate, seededAt);
        seedObjectiveOwner.run("objective-claimed-duplicate", claimedDuplicate, seededAt);
        legacy.exec(
          `CREATE UNIQUE INDEX idx_jobs_dedupe_active
             ON jobs(dedupeKey)
           WHERE dedupeKey IS NOT NULL
             AND dedupeKey <> ''
             AND status IN ('pending','claimed');`,
        );
      } finally {
        legacy.close();
      }

      queue = new JobQueue(dbPath);

      expect(queue.getJob(finalizingForPending)).toMatchObject({
        status: "finalizing",
        dedupeKey: "legacy:pending",
      });
      const migratedPending = queue.getJob(pendingDuplicate);
      expect(migratedPending).toMatchObject({
        status: "abandoned",
        dedupeKey: "legacy:pending",
      });
      expect(JSON.parse(String(migratedPending?.error))).toMatchObject({
        canonicalJobId: finalizingForPending,
        dedupeKey: "legacy:pending",
      });

      expect(queue.getJob(finalizingForClaimed)).toMatchObject({
        status: "finalizing",
        dedupeKey: "legacy:claimed",
      });
      expect(queue.getJob(claimedDuplicate)).toMatchObject({
        status: "abandoned",
        workerId: "legacy-worker",
        claimGeneration: 3,
      });

      const publicationRows = [queue.getJob(firstPublication), queue.getJob(secondPublication)];
      expect(publicationRows.map((row) => row?.status)).toEqual(["finalizing", "finalizing"]);
      expect(publicationRows.map((row) => row?.dedupeKey).sort()).toEqual([
        "legacy:publication",
        null,
      ]);
      const releasedPublication = publicationRows.find((row) => row?.dedupeKey === null);
      expect(
        queue
          .listJobLogs(String(releasedPublication?.id))
          .some((log) => log.message.includes("publication remains active")),
      ).toBe(true);
      expect(
        queue
          .listJobLogs(pendingDuplicate)
          .some((log) => log.message.includes("Abandoned duplicate active job")),
      ).toBe(true);
      expect(
        queue
          .listJobLogs(claimedDuplicate)
          .some((log) => log.message.includes("Abandoned duplicate active job")),
      ).toBe(true);
      expect(
        queue.listWorkers().find((worker) => worker.workerId === "legacy-worker"),
      ).toMatchObject({
        status: "idle",
        currentJobId: null,
      });

      const migratedOwners = new Database(dbPath, { readonly: true });
      try {
        expect(
          migratedOwners.prepare(`SELECT id, handoffJobId FROM requests ORDER BY id`).all(),
        ).toEqual([
          { id: "request-claimed-duplicate", handoffJobId: finalizingForClaimed },
          { id: "request-pending-duplicate", handoffJobId: finalizingForPending },
        ]);
        expect(
          migratedOwners
            .prepare(`SELECT id, job_id AS jobId FROM autonomy_objectives ORDER BY id`)
            .all(),
        ).toEqual([
          { id: "objective-claimed-duplicate", jobId: finalizingForClaimed },
          { id: "objective-pending-duplicate", jobId: finalizingForPending },
        ]);
      } finally {
        migratedOwners.close();
      }

      const deduped = queue.enqueue({
        taskId: "post-migration-duplicate",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
        dedupeKey: "legacy:pending",
      });
      expect(deduped).toMatchObject({
        ok: true,
        deduped: true,
        jobId: finalizingForPending,
      });

      queue.close();
      queue = null;
    } finally {
      queue?.close();
      Bun.gc(true);
      for (let attempt = 1; attempt <= 10 && existsSync(root); attempt += 1) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          await Bun.sleep(25 * attempt);
        }
      }
    }
  });
});
