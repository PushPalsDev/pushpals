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

  test("rejects malformed requiredValidationSteps in planning", async () => {
    const planning = {
      ...VALID_PLANNING,
      requiredValidationSteps: "bun run test:root",
    };

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
    expect(result.summary).toContain("planning.requiredValidationSteps");
  });

  test("accepts requiredValidationSteps in planning", async () => {
    const planning = {
      ...VALID_PLANNING,
      requiredValidationSteps: ["bun run test:root"],
      finalizationBudgetMs: 0,
    };

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
    expect(result.summary).toContain("planning.finalizationBudgetMs");
    expect(result.summary).not.toContain("planning.requiredValidationSteps");
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

  test("allows autonomy-origin task when writeGlobs are missing", async () => {
    const planning = {
      ...VALID_PLANNING,
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
      },
      finalizationBudgetMs: 0,
    } as Record<string, unknown>;
    delete (planning.scope as Record<string, unknown>).writeGlobs;

    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "run a bounded task",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain(
      "autonomy task.execute requires planning.scope.writeGlobs",
    );
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows user-origin repo-root targetPaths and continues validation", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["README.md"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["README.md"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        instruction: "append one marker line to README",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows user-origin targetPaths outside writeGlobs as review hints", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["app/game.tsx", "README.md"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["app/game.tsx"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        instruction: "inspect the game route and README context",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("targetPaths must be covered");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows autonomy-origin generic repo scope without declared componentArea", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["src/autonomy.ts"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["src/autonomy.ts"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "adjust the autonomy loop in src/autonomy.ts",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("componentArea");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows autonomy-origin mixed-root scope as review intent hints", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["app/**", "scripts/**"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "fix mixed scope task",
        planning,
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("scope invariants");
    expect(result.summary).not.toContain("componentArea");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows autonomy-origin componentArea mismatches as scope hints", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: [
        "app/__tests__/_layout.autonomy.test.ts",
        "app/_layout.tsx",
        "app/index.tsx",
        "app/game.tsx",
      ],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["app/**"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "harden app shell and web review path",
        planning,
        autonomy: {
          componentArea: "app/__tests__",
        },
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("planning.targetPaths do not match autonomy componentArea");
    expect(result.summary).not.toContain("componentArea");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows review_fix autonomy-origin tasks to use multi-root PR scope", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["app/**", "scripts/**"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "fix PR feedback across app and scripts",
        planning,
        reviewAgent: {
          resolutionType: "review_fix",
        },
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("scope invariants");
    expect(result.summary).not.toContain("componentArea");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows merge_conflict autonomy-origin tasks to use multi-root branch scope", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["app/**", "scripts/**"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "resolve branch conflicts across app and scripts",
        planning,
        reviewAgent: {
          resolutionType: "merge_conflict",
        },
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("scope invariants");
    expect(result.summary).not.toContain("componentArea");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });

  test("allows broad write globs as sandbox review hints for review_fix scope", async () => {
    const planning = {
      ...VALID_PLANNING,
      targetPaths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      scope: {
        ...(VALID_PLANNING.scope ?? {}),
        writeGlobs: ["**"],
      },
      finalizationBudgetMs: 0,
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: "fix PR feedback across app and scripts",
        planning,
        reviewAgent: {
          resolutionType: "review_fix",
        },
      },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("forbidden broad write_glob");
    expect(result.summary).toContain("planning.finalizationBudgetMs");
  });
});
