import { describe, expect, test } from "bun:test";
import {
  collectRequiredValidationFailures,
  collectQualityGateValidationCommands,
  extractRequiredValidationStepsFromVisionMarkdown,
  inferFallbackValidationCommandsForTestTask,
  isTestLikeValidationStep,
  tokenizeValidationCommandArgv,
} from "../apps/workerpals/src/execute_job";

function planningFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: "code_change",
    riskLevel: "low",
    scope: {
      readAnywhere: true,
      writeAllowed: true,
      writeGlobs: ["apps/localbuddy/**"],
    },
    discovery: {
      ripgrepQueries: ["localbuddy"],
      likelyDirs: ["apps/localbuddy", "tests"],
    },
    acceptanceCriteria: ["Expand localbuddy test coverage"],
    validationSteps: [],
    queuePriority: "normal",
    queueWaitBudgetMs: 90_000,
    executionBudgetMs: 900_000,
    finalizationBudgetMs: 120_000,
    ...(overrides as Record<string, unknown>),
  };
}

describe("workerpals validation command safety", () => {
  test("tokenizes quoted argv without using shell interpolation", () => {
    const argv = tokenizeValidationCommandArgv(
      'bun --cwd "apps/localbuddy" test tests/localbuddy.request-status.test.ts',
    );
    expect(argv).toEqual([
      "bun",
      "--cwd",
      "apps/localbuddy",
      "test",
      "tests/localbuddy.request-status.test.ts",
    ]);
  });

  test("rejects shell control chaining tokens", () => {
    expect(tokenizeValidationCommandArgv("bun test && echo hi")).toBeNull();
    expect(tokenizeValidationCommandArgv("bun test | cat")).toBeNull();
  });

  test("detects test-like validation steps with argv flags and inline backticks", () => {
    expect(isTestLikeValidationStep("bun --cwd apps/localbuddy test")).toBe(true);
    expect(isTestLikeValidationStep("Run `bun --cwd apps/localbuddy test`")).toBe(true);
    expect(isTestLikeValidationStep("npm --prefix apps/server test")).toBe(true);
    expect(isTestLikeValidationStep("python -m pytest tests")).toBe(true);
  });

  test("rejects non-test validation steps", () => {
    expect(isTestLikeValidationStep("bun run build")).toBe(false);
    expect(isTestLikeValidationStep("echo done")).toBe(false);
    expect(isTestLikeValidationStep("Run `node scripts/lint.js`")).toBe(false);
  });

  test("prefers scoped fallback commands before full-suite runs", () => {
    const commands = inferFallbackValidationCommandsForTestTask(
      "add coverage for localbuddy request status",
      "apps/localbuddy",
      planningFixture() as any,
      ["tests/localbuddy.request-status.test.ts"],
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0]).toContain("tests/localbuddy.request-status.test.ts");
    expect(commands).toContain("bun --cwd apps/localbuddy test");
    expect(commands).not.toContain("bun test");
  });

  test("falls back to full-suite command only when no scoped hints exist", () => {
    const commands = inferFallbackValidationCommandsForTestTask(
      "add more tests",
      undefined,
      planningFixture({
        scope: { readAnywhere: true, writeAllowed: true, writeGlobs: [] },
        discovery: { ripgrepQueries: [], likelyDirs: [] },
      }) as any,
      [],
    );
    expect(commands).toEqual(["bun test"]);
  });

  test("runs required vision criteria without classifying normal work as test-focused", () => {
    const planning = planningFixture({
      validationSteps: ["git diff -- app/game.tsx"],
      requiredValidationSteps: ["`bun run test:root`", "Run `bun run smoke:web`"],
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "Improve the game shell polish",
      targetPath: "app/game.tsx",
      planning,
      changedTestPaths: [],
      isTestTask: false,
    });

    expect(commands.requiredRunnableSteps).toEqual(["bun run test:root", "bun run smoke:web"]);
    expect(commands.commandsToRun).toEqual([
      "bun run test:root",
      "bun run smoke:web",
      "git diff -- app/game.tsx",
    ]);
    expect(commands.fallbackValidationSteps).toEqual([]);
  });

  test("keeps focused fallback validation for test-focused work when planner omits a runnable step", () => {
    const planning = planningFixture({
      validationSteps: ["Inspect the changed test"],
      requiredValidationSteps: ["bun run test:root"],
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "add regression tests",
      targetPath: "tests/localbuddy.request-status.test.ts",
      planning,
      changedTestPaths: ["tests/localbuddy.request-status.test.ts"],
      isTestTask: true,
    });

    expect(commands.commandsToRun[0]).toBe("bun run test:root");
    expect(commands.fallbackValidationSteps[0]).toContain("tests/localbuddy.request-status.test.ts");
  });

  test("extracts repo-native required validation commands from vision markdown", () => {
    const markdown = [
      "# Vision",
      "> **One sentence:** Keep every PR validated.",
      "",
      "## 12) Testing criteria",
      "- `go test ./...`",
      "- Run `cargo test --workspace`",
      "- `node --test`",
      "- `tsc --noEmit`",
      "- `sh scripts/smoke.sh`",
      "- Manual QA after release",
    ].join("\n");

    expect(extractRequiredValidationStepsFromVisionMarkdown(markdown)).toEqual([
      "go test ./...",
      "cargo test --workspace",
      "node --test",
      "tsc --noEmit",
      "sh scripts/smoke.sh",
    ]);
  });

  test("treats failed vision-required validation commands as publish blockers", () => {
    expect(
      collectRequiredValidationFailures(["bun run test:root"], [
        { command: "bun run test:root", ok: false, exitCode: 1 },
        { command: "bun test tests/focused.test.ts", ok: true, exitCode: 0 },
      ]),
    ).toEqual(["bun run test:root exited 1"]);
  });
});
