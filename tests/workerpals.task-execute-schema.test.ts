import { describe, expect, test } from "bun:test";
import { executeJob } from "../apps/workerpals/src/execute_job";

const VALID_PLANNING = {
  intent: "code_change",
  riskLevel: "low",
  scope: {
    readAnywhere: true,
    writeAllowed: true,
    writeGlobs: ["apps/server/src/jobs.ts"],
  },
  discovery: {
    ripgrepQueries: ["jobs stale"],
    likelyDirs: ["apps/server/src"],
  },
  acceptanceCriteria: ["Queue jobs are persisted and recovered correctly."],
  validationSteps: ["bun test tests/server.jobs.stale-recovery.test.ts"],
  queuePriority: "normal",
  queueWaitBudgetMs: 90_000,
  executionBudgetMs: 900_000,
  finalizationBudgetMs: 120_000,
};

describe("workerpals task.execute strict schema", () => {
  test("accepts warmup.execute without schema/planning and returns success", async () => {
    const result = await executeJob("warmup.execute", {}, process.cwd());

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Startup warmup completed");
  });

  test("rejects missing schemaVersion", async () => {
    const result = await executeJob(
      "task.execute",
      {
        lane: "deterministic",
        instruction: "run a bounded task",
        planning: VALID_PLANNING,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("schemaVersion=2");
  });

  test("rejects missing planning object", async () => {
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        lane: "deterministic",
        instruction: "run a bounded task",
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("params.planning");
  });

  test("rejects missing acceptanceCriteria in planning", async () => {
    const planning = { ...VALID_PLANNING } as Record<string, unknown>;
    delete planning.acceptanceCriteria;

    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        lane: "deterministic",
        instruction: "run a bounded task",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("planning.acceptanceCriteria");
  });

  test("rejects absolute/path-escape writeGlobs hints", async () => {
    const planning = {
      ...VALID_PLANNING,
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["../outside.txt", "/etc/passwd"],
      },
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        instruction: "run a bounded task",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("writeGlobs");
  });
});
