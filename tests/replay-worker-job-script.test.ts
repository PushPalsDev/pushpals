import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildReplayJobEnqueuePayload,
  loadReplayJobFromDb,
  parseReplayWorkerJobArgs,
  resolveDefaultPushpalsDbPath,
} from "../scripts/replay-worker-job";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pushpals-replay-worker-job-test-"));
}

describe("replay-worker-job script", () => {
  test("parses the minimal replay command", () => {
    const parsed = parseReplayWorkerJobArgs([
      "--repo",
      "C:/repo/demo",
      "--job-id",
      "job-123",
      "--server",
      "http://127.0.0.1:3999/",
    ]);

    expect(parsed.repo.replace(/\\/g, "/")).toEndWith("C:/repo/demo");
    expect(parsed.jobId).toBe("job-123");
    expect(parsed.server).toBe("http://127.0.0.1:3999");
    expect(parsed.preserveDedupe).toBe(false);
  });

  test("resolves the default durable jobs DB inside the target repo", () => {
    expect(resolveDefaultPushpalsDbPath("C:/repo/demo").replace(/\\/g, "/")).toEndWith(
      "C:/repo/demo/outputs/data/pushpals.db",
    );
  });

  test("loads a source job and builds a replay-safe enqueue payload", () => {
    const root = makeTempDir();
    try {
      const dbPath = join(root, "pushpals.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          sessionId TEXT NOT NULL,
          kind TEXT NOT NULL,
          params TEXT NOT NULL,
          dedupeKey TEXT,
          priority TEXT NOT NULL,
          queueWaitBudgetMs INTEGER NOT NULL,
          executionBudgetMs INTEGER NOT NULL,
          finalizationBudgetMs INTEGER NOT NULL,
          targetWorkerId TEXT,
          prUrl TEXT
        );
      `);
      db.query(
        `INSERT INTO jobs (
          id, taskId, sessionId, kind, params, dedupeKey, priority,
          queueWaitBudgetMs, executionBudgetMs, finalizationBudgetMs, targetWorkerId, prUrl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "job-source",
        "task-source",
        "dev",
        "task.execute",
        JSON.stringify({
          instruction: "Fix the browser smoke assertion.",
          planning: { targetPaths: ["scripts/test-web-e2e.js"] },
        }),
        "original-dedupe",
        "normal",
        90_000,
        900_000,
        120_000,
        "workerpal-original",
        "https://github.com/PushPalsDev/pushpals/pull/123",
      );
      db.close();

      const row = loadReplayJobFromDb(dbPath, "job-source");
      const payload = buildReplayJobEnqueuePayload(
        row,
        {
          preserveDedupe: false,
          preserveTargetWorker: false,
        },
        new Date("2026-05-24T17:26:30.000Z"),
      );

      expect(payload.taskId).toBe("task-source-replay-20260524172630");
      expect(payload.sessionId).toBe("dev");
      expect(payload.kind).toBe("task.execute");
      expect(payload.dedupeKey).toBe("replay:job-source:20260524172630");
      expect(payload.dedupeKey).not.toBe("original-dedupe");
      expect(payload.targetWorkerId).toBeUndefined();
      expect(payload.params.instruction).toBe("Fix the browser smoke assertion.");
      expect(payload.params.replayOfJobId).toBe("job-source");
      expect(payload.params.replayedAt).toBe("2026-05-24T17:26:30.000Z");
      expect(payload.prUrl).toBe("https://github.com/PushPalsDev/pushpals/pull/123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can intentionally preserve source dedupe and worker targeting", () => {
    const payload = buildReplayJobEnqueuePayload(
      {
        id: "job-source",
        taskId: "task-source",
        sessionId: "",
        kind: "task.execute",
        params: "{}",
        dedupeKey: "original-dedupe",
        priority: "interactive",
        queueWaitBudgetMs: 1_000,
        executionBudgetMs: 2_000,
        finalizationBudgetMs: 3_000,
        targetWorkerId: "workerpal-original",
        prUrl: null,
      },
      {
        sessionId: "replay-session",
        targetWorkerId: "",
        preserveDedupe: true,
        preserveTargetWorker: true,
      },
      new Date("2026-05-24T17:26:30.000Z"),
    );

    expect(payload.sessionId).toBe("replay-session");
    expect(payload.dedupeKey).toBe("original-dedupe");
    expect(payload.targetWorkerId).toBe("workerpal-original");
  });
});
