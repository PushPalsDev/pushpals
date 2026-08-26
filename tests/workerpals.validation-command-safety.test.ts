import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildBunDependencyLayoutPreflightFailureRun,
  buildValidationExecutionDag,
  bunDependencySnapshotKey,
  allowsValidationToolingOnlyChangeForTestFocusedTask,
  classifyValidationFailureScope,
  collectPrePublishHygieneIssues,
  collectWriteScopeIssuesFromChangedPaths,
  collectRequiredValidationFailures,
  collectQualityGateValidationCommands,
  detectValidationBlocker,
  extractRequiredValidationStepsFromVisionMarkdown,
  extractValidationFailureDigest,
  filterChangedPathsByGitContentDelta,
  formatBunTestPathArg,
  git,
  inferPlaywrightBrowserInstallTargets,
  inferFallbackValidationCommandsForTestTask,
  inferRepoNativeValidationCommands,
  isAssertionCoverageTestPath,
  isBrowserSmokeHarnessPath,
  isLikelyTestPath,
  isLongRunningBrowserValidationCommand,
  isParallelSafeFastValidationCommand,
  isTestFocusedTask,
  isTestSupportPath,
  isTestLikeValidationStep,
  isValidationToolingPath,
  packageScriptSequenceReferences,
  playwrightBrowserInstallArgv,
  playwrightBrowserRuntimeCacheMarkerPath,
  prepareValidationCommandArgv,
  prepareValidationSpawnArgv,
  removeLinkedNodeModulesDependencyArtifact,
  resolveBunDependencyLayoutPreflight,
  resolveBunDependencyLayoutPreflightTimeoutForValidationCommands,
  resolveBunDependencyLayoutPreflightTimeoutMs,
  resolveValidationCommandTimeoutMs,
  runValidationArgv,
  sanitizeMissingExplicitTestTargets,
  sanitizePlannerWorkerInstructionPathHints,
  sanitizeTaskExecutePlanningPathHints,
  shouldEnsurePlaywrightBrowserRuntime,
  shouldRetryAggregateWorkerValidationRunOnce,
  shouldDeferLongValidationAfterFastFailures,
  shouldRetryBrowserValidationRunOnce,
  tokenizeValidationCommandArgv,
  trustedEnvironmentValidationDeferralReason,
  validationCommandIncludesLongRunningBrowserWork,
  validationCommandIncludesTestWork,
  validationCommandRequiresDockerDaemon,
  validationCommandSubsumes,
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

async function runGit(repo: string, args: string[]): Promise<string> {
  const result = await git(repo, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
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
    expect(tokenizeValidationCommandArgv('bun test "./tests/my smoke.test.ts"')).toEqual([
      "bun",
      "test",
      "./tests/my smoke.test.ts",
    ]);
    expect(tokenizeValidationCommandArgv('bun test "./tests/quote\\"case.test.ts"')).toEqual([
      "bun",
      "test",
      './tests/quote"case.test.ts',
    ]);
    expect(
      tokenizeValidationCommandArgv('cmake -S "native module" -B "native module/build"'),
    ).toEqual(["cmake", "-S", "native module", "-B", "native module/build"]);
    expect(
      tokenizeValidationCommandArgv('stack --stack-yaml "compiler app/stack.yaml" test'),
    ).toEqual(["stack", "--stack-yaml", "compiler app/stack.yaml", "test"]);
  });

  test("rejects shell control chaining tokens", () => {
    expect(tokenizeValidationCommandArgv("bun test && echo hi")).toBeNull();
    expect(tokenizeValidationCommandArgv("bun test | cat")).toBeNull();
    expect(tokenizeValidationCommandArgv("bun test|cat")).toBeNull();
    expect(tokenizeValidationCommandArgv("bun test > output.log")).toBeNull();
    expect(tokenizeValidationCommandArgv('bun test -t "route|shell"')).toEqual([
      "bun",
      "test",
      "-t",
      "route|shell",
    ]);
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

  test("treats browser smoke scripts as test validation harnesses without assertion coverage requirements", () => {
    expect(isBrowserSmokeHarnessPath("scripts/test-web-e2e.js")).toBe(true);
    expect(isBrowserSmokeHarnessPath("scripts/run-browser-smoke.ts")).toBe(true);
    expect(isLikelyTestPath("scripts/test-web-e2e.js")).toBe(true);
    expect(isAssertionCoverageTestPath("scripts/test-web-e2e.js")).toBe(false);
    expect(isAssertionCoverageTestPath("app/__tests__/route.test.ts")).toBe(true);
    expect(isTestSupportPath("tests/reactNativeMock.d.ts")).toBe(true);
    expect(isTestSupportPath("tests")).toBe(false);
    expect(isLikelyTestPath("tests/reactNativeMock.d.ts")).toBe(true);
    expect(isAssertionCoverageTestPath("tests/reactNativeMock.d.ts")).toBe(false);
  });

  test("allows validation tooling-only changes for test-focused repair jobs", () => {
    const planning = planningFixture({
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["tests/reactNativeMock.d.ts", "package.json"],
      },
      discovery: { ripgrepQueries: ["reactNativeMock"], likelyDirs: ["tests"] },
      acceptanceCriteria: ["Repair the lint validation baseline"],
      validationSteps: ["bun run lint", "bun test"],
      requiredValidationSteps: ["bun run lint"],
    }) as any;

    expect(isTestFocusedTask("Repair the lint validation failure for tests", planning)).toBe(true);
    expect(isValidationToolingPath("package.json")).toBe(true);
    expect(
      allowsValidationToolingOnlyChangeForTestFocusedTask({
        instruction: "Repair the lint validation failure for tests.",
        planning,
        changedPaths: ["package.json"],
      }),
    ).toBe(true);
    expect(
      allowsValidationToolingOnlyChangeForTestFocusedTask({
        instruction: "Repair the lint validation failure for tests.",
        planning,
        changedPaths: ["package.json", "app/_layout.tsx"],
      }),
    ).toBe(false);
  });

  test("prefers scoped fallback commands before full-suite runs", () => {
    const commands = inferFallbackValidationCommandsForTestTask(
      "add coverage for localbuddy request status",
      "apps/localbuddy",
      planningFixture() as any,
      ["tests/localbuddy.request-status.test.ts"],
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0]).toContain("./tests/localbuddy.request-status.test.ts");
    expect(commands).toContain("bun --cwd apps/localbuddy test");
    expect(commands).not.toContain("bun test");
  });

  test("formats bun test file paths so Bun treats them as paths, not filters", () => {
    expect(formatBunTestPathArg("app/__tests__/battlefieldReadability.test.tsx")).toBe(
      "./app/__tests__/battlefieldReadability.test.tsx",
    );
    expect(formatBunTestPathArg("tests/my smoke.test.ts")).toBe('"./tests/my smoke.test.ts"');
    expect(formatBunTestPathArg("./tests/example.test.ts")).toBe("./tests/example.test.ts");
    expect(formatBunTestPathArg("../outside/example.test.ts")).toBe("../outside/example.test.ts");
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

  test("drops planner validation commands that require a shell pipeline", () => {
    const planning = planningFixture({
      validationSteps: [
        "git diff --check -- README.md",
        "git diff --name-only | grep -qx 'README.md'",
      ],
      requiredValidationSteps: ["bun run validate"],
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "Append one line to README.md",
      targetPath: "README.md",
      planning,
      changedTestPaths: [],
      isTestTask: false,
    });

    expect(commands.commandsToRun).toEqual(["bun run validate", "git diff --check -- README.md"]);
  });

  test("dedupes equivalent bun x and bunx validation commands", () => {
    const planning = planningFixture({
      validationSteps: ["bunx tsc --noEmit"],
      requiredValidationSteps: ["bun x tsc --noEmit"],
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "Improve a UI surface",
      targetPath: "app/game.tsx",
      planning,
      changedTestPaths: [],
      isTestTask: false,
    });

    expect(commands.commandsToRun).toEqual(["bun x tsc --noEmit"]);
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
    expect(commands.fallbackValidationSteps[0]).toContain(
      "./tests/localbuddy.request-status.test.ts",
    );
  });

  test("replaces unresolved planner validation placeholders with a focused fallback", () => {
    const planning = planningFixture({
      targetPaths: ["components/__tests__/matchRendering.test.ts"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["components/__tests__/matchRendering.test.ts"],
      },
      validationSteps: ["bun test <target-test-file>"],
      requiredValidationSteps: ["bun run validate"],
      discovery: { ripgrepQueries: [], likelyDirs: ["components"] },
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "add one focused regression test",
      targetPath: "components/__tests__/matchRendering.test.ts",
      planning,
      changedTestPaths: ["components/__tests__/matchRendering.test.ts"],
      isTestTask: true,
    });

    expect(commands.plannerRunnableSteps).toEqual([]);
    expect(commands.fallbackValidationSteps).toEqual([
      "bun test ./components/__tests__/matchRendering.test.ts",
    ]);
    expect(commands.commandsToRun).toEqual([
      "bun run validate",
      "bun test ./components/__tests__/matchRendering.test.ts",
    ]);
  });

  test("does not run test-support files directly as fallback validation", () => {
    const commands = inferFallbackValidationCommandsForTestTask(
      "repair the React Native mock type surface for tests",
      "tests/reactNativeMock.d.ts",
      planningFixture({
        validationSteps: [],
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: ["tests/reactNativeMock.d.ts"],
        },
        discovery: { ripgrepQueries: ["reactNativeMock"], likelyDirs: ["tests"] },
      }) as any,
      ["tests/reactNativeMock.d.ts"],
    );

    expect(commands).toEqual(["bun test"]);
  });

  test("drops planner validation commands that run only test-support files", () => {
    const planning = planningFixture({
      targetPaths: ["tests/reactNativeMock.d.ts"],
      validationSteps: ["bun test ./tests/reactNativeMock.d.ts"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["tests/reactNativeMock.d.ts"],
      },
      discovery: { ripgrepQueries: ["reactNativeMock"], likelyDirs: ["tests"] },
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "repair the React Native mock type surface for tests",
      targetPath: "tests/reactNativeMock.d.ts",
      planning,
      changedTestPaths: ["tests/reactNativeMock.d.ts"],
      isTestTask: true,
    });

    expect(commands.plannerRunnableSteps).toEqual([]);
    expect(commands.fallbackValidationSteps).toEqual(["bun test"]);
    expect(commands.commandsToRun).toEqual(["bun test"]);
  });

  test("keeps runnable planner validation while dropping support-only test targets", () => {
    const planning = planningFixture({
      targetPaths: ["tests/reactNativeMock.d.ts", "tests/reactNativeMock.test.js"],
      validationSteps: [
        "bun test ./tests/reactNativeMock.d.ts",
        "bun test ./tests/reactNativeMock.test.js",
      ],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["tests/**"],
      },
      discovery: { ripgrepQueries: ["reactNativeMock"], likelyDirs: ["tests"] },
    }) as any;

    const commands = collectQualityGateValidationCommands({
      instruction: "add focused tests for the React Native mock contract",
      targetPath: "tests/reactNativeMock.d.ts",
      planning,
      changedTestPaths: ["tests/reactNativeMock.d.ts", "tests/reactNativeMock.test.js"],
      isTestTask: true,
    });

    expect(commands.plannerRunnableSteps).toEqual(["bun test ./tests/reactNativeMock.test.js"]);
    expect(commands.fallbackValidationSteps).toEqual([]);
    expect(commands.commandsToRun).toEqual(["bun test ./tests/reactNativeMock.test.js"]);
  });

  test("drops deleted explicit test targets before each validation gate run", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-deleted-targets-"));
    try {
      mkdirSync(join(root, "components", "__tests__"), { recursive: true });
      writeFileSync(
        join(root, "components", "__tests__", "Projectile.test.tsx"),
        "test('projectile', () => {});\n",
      );
      const planning = planningFixture({
        validationSteps: [
          "bun test ./components/__tests__/Projectile.test.tsx",
          "bun test ./scripts/__tests__/web-startup-readiness.test.js",
          "bun test ./utils/__tests__/homeActions.test.ts",
        ],
        requiredValidationSteps: ["bun run validate"],
      }) as any;

      const commands = collectQualityGateValidationCommands({
        instruction: "Narrow the PR and keep the projectile behavior covered.",
        targetPath: "components/__tests__/Projectile.test.tsx",
        planning,
        changedTestPaths: ["components/__tests__/Projectile.test.tsx"],
        isTestTask: false,
        repo: root,
        changedPaths: ["components/__tests__/Projectile.test.tsx"],
      });

      expect(commands.plannerRunnableSteps).toEqual([
        "bun test ./components/__tests__/Projectile.test.tsx",
      ]);
      expect(commands.commandsToRun).toContain(
        "bun test ./components/__tests__/Projectile.test.tsx",
      );
      expect(commands.commandsToRun).toContain("bun run validate");
      expect(commands.commandsToRun.join("\n")).not.toContain("web-startup-readiness");
      expect(commands.commandsToRun.join("\n")).not.toContain("homeActions");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps existing targets when pruning a mixed Bun test command", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-mixed-targets-"));
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "kept.test.ts"), "test('kept', () => {});\n");

      expect(
        sanitizeMissingExplicitTestTargets(
          root,
          "bun test ./tests/deleted.test.ts ./tests/kept.test.ts --timeout 5000",
        ),
      ).toBe("bun test ./tests/kept.test.ts --timeout 5000");
      expect(
        sanitizeMissingExplicitTestTargets(root, "bun test ./tests/deleted.test.ts"),
      ).toBeNull();
      expect(sanitizeMissingExplicitTestTargets(root, "bun test")).toBe("bun test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds repo-native typecheck and lint commands for TypeScript changes", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-inference-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { lint: "eslint ." }, devDependencies: { typescript: "^5" } }),
      );
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

      expect(inferRepoNativeValidationCommands(root, ["app/game.tsx"])).toEqual([
        "bun x tsc --noEmit",
        "bun run lint",
      ]);

      const commands = collectQualityGateValidationCommands({
        instruction: "Improve a UI surface",
        targetPath: "app/game.tsx",
        planning: planningFixture({ validationSteps: [] }) as any,
        changedTestPaths: [],
        isTestTask: false,
        repo: root,
        changedPaths: ["app/game.tsx"],
      });
      expect(commands.commandsToRun).toEqual(["bun x tsc --noEmit", "bun run lint"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds a focused-first validation DAG and removes aggregate-subsumed commands", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-dag-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            validate: "node ./scripts/validate.js",
            validateAlias: "node ./scripts/validate.js",
            lint: "eslint .",
            typecheck: "tsc --noEmit",
          },
        }),
      );
      writeFileSync(
        join(root, "scripts", "validate.js"),
        [
          'createStep("Lint", "bun", ["run", "lint"]);',
          'createStep("Typecheck", "bun", ["run", "typecheck"]);',
          'createStep("Tests", "bun", ["test"]);',
        ].join("\n"),
      );

      expect(validationCommandSubsumes(root, "bun run validate", "bun run lint")).toBe(true);
      expect(
        buildValidationExecutionDag(root, [
          "bun run lint",
          "bun run typecheck",
          "bun test ./tests/focused.test.ts",
          "bun run validate",
        ]),
      ).toEqual(["bun test ./tests/focused.test.ts", "bun run validate"]);
      expect(
        buildValidationExecutionDag(root, ["bun run validate", "bun run validateAlias"]),
      ).toEqual(["bun run validate"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags unrelated hygiene churn before publish", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-hygiene-"));
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "reactNativeMock.ts"), "export const Animated = {};\n");
      const issues = collectPrePublishHygieneIssues({
        repo: root,
        changedPaths: [".gitignore", "tests/reactNativeMock.ts"],
        instruction: "Improve home screen readability",
        targetPath: "app/index.tsx",
        planning: planningFixture({
          targetPaths: ["app/index.tsx"],
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs: ["app/index.tsx"] },
        }) as any,
      });

      expect(issues).toContain(
        "modified .gitignore without task or reviewer guidance requesting ignore-policy changes.",
      );
      expect(issues).toContain(
        "changed tests/reactNativeMock.ts without a changed test importing it or explicit reviewer guidance.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops clean tracked paths before hygiene checks while keeping real gitignore edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-hygiene-delta-"));
    const unrelatedGitignoreMessage =
      "modified .gitignore without task or reviewer guidance requesting ignore-policy changes.";
    const baseParams = {
      instruction: "Improve home screen readability",
      targetPath: "app/index.ts",
      planning: planningFixture({
        targetPaths: ["app/index.ts"],
        scope: { readAnywhere: true, writeAllowed: true, writeGlobs: ["app/index.ts"] },
      }) as any,
    };

    try {
      mkdirSync(join(root, "app"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), "outputs/\n");
      writeFileSync(join(root, "app", "index.ts"), "export const value = 1;\n");

      await runGit(root, ["init"]);
      await runGit(root, ["config", "user.email", "pushpals-test@example.com"]);
      await runGit(root, ["config", "user.name", "PushPals Test"]);
      await runGit(root, ["config", "core.autocrlf", "false"]);
      await runGit(root, ["add", ".gitignore", "app/index.ts"]);
      await runGit(root, ["commit", "-m", "initial"]);

      writeFileSync(join(root, "app", "index.ts"), "export const value = 2;\n");
      const cleanGitignorePaths = await filterChangedPathsByGitContentDelta(root, [
        ".gitignore",
        "app/index.ts",
      ]);
      expect(cleanGitignorePaths).toEqual(["app/index.ts"]);
      expect(
        collectPrePublishHygieneIssues({
          repo: root,
          changedPaths: cleanGitignorePaths,
          ...baseParams,
        }),
      ).not.toContain(unrelatedGitignoreMessage);

      writeFileSync(join(root, ".gitignore"), "outputs/\nnode_modules/\n");
      await runGit(root, ["add", ".gitignore"]);
      const realGitignorePaths = await filterChangedPathsByGitContentDelta(root, [
        ".gitignore",
        "app/index.ts",
      ]);
      expect(realGitignorePaths).toEqual([".gitignore", "app/index.ts"]);
      expect(
        collectPrePublishHygieneIssues({
          repo: root,
          changedPaths: realGitignorePaths,
          ...baseParams,
        }),
      ).toContain(unrelatedGitignoreMessage);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not treat the managed root node_modules dependency artifact as PR content", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-hygiene-"));
    try {
      const issues = collectPrePublishHygieneIssues({
        repo: root,
        changedPaths: ["node_modules", "app/index.tsx"],
        instruction: "Improve home screen readability",
        targetPath: "app/index.tsx",
        planning: planningFixture({
          targetPaths: ["app/index.tsx"],
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs: ["app/index.tsx"] },
        }) as any,
      });

      expect(issues).not.toContain(
        "attempted to publish node_modules changes; dependency installs must not become PR content.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still blocks nested node_modules file churn before publish", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-hygiene-"));
    try {
      const issues = collectPrePublishHygieneIssues({
        repo: root,
        changedPaths: ["node_modules/react/index.js", "app/index.tsx"],
        instruction: "Improve home screen readability",
        targetPath: "app/index.tsx",
        planning: planningFixture({
          targetPaths: ["app/index.tsx"],
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs: ["app/index.tsx"] },
        }) as any,
      });

      expect(issues).toContain(
        "attempted to publish node_modules changes; dependency installs must not become PR content.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        {
          command: "bun run test:root",
          ok: false,
          exitCode: 1,
          stderr: "Cannot find module '../../tests/reactNativeMock'",
        },
        { command: "bun test tests/focused.test.ts", ok: true, exitCode: 0 },
      ] as any),
    ).toEqual(["bun run test:root exited 1 (Cannot find module '../../tests/reactNativeMock')"]);
  });

  test("extracts actionable validation failure digests", () => {
    expect(
      extractValidationFailureDigest({
        command: "bun run web:e2e",
        step: "bun run web:e2e",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Error: ERR_SOCKET_BAD_PORT at port 65536",
        elapsedMs: 20,
      }),
    ).toBe("ERR_SOCKET_BAD_PORT at port 65536");

    expect(
      extractValidationFailureDigest({
        command: "bun run web:e2e",
        step: "bun run web:e2e",
        ok: false,
        exitCode: 124,
        stdout:
          "Browser launch failed for bundled Chromium: browserType.launch: Executable doesn't exist at /tmp/cache/ms-playwright/chromium/chrome",
        stderr:
          "Please run the following command to download new browsers:\n    npx playwright install",
        elapsedMs: 600_000,
      }),
    ).toBe(
      "browserType.launch: Executable doesn't exist at /tmp/cache/ms-playwright/chromium/chrome",
    );

    expect(
      extractValidationFailureDigest({
        command: "bun run validate",
        step: "bun run validate",
        ok: false,
        exitCode: 1,
        stdout: [
          "Browser launch failed for Microsoft Edge: browserType.launch: Chromium distribution 'msedge' is not found",
          "Using Google Chrome for browser automation.",
          "Web end-to-end smoke test failed: Route/startup smoke failure (route/startup)",
        ].join("\n"),
        stderr: "",
        elapsedMs: 200_000,
      }),
    ).toBe("Web end-to-end smoke test failed: Route/startup smoke failure (route/startup)");
  });

  test("classifies validation failures outside the task target/relevance hints", () => {
    const planning = planningFixture({
      targetPaths: ["app/game.tsx"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["app/game.tsx"],
      },
    }) as any;

    expect(
      classifyValidationFailureScope(
        [
          {
            step: "bun test",
            command: "bun test",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "components/__tests__/AnimatedSelectionRing.test.tsx: Cannot find module '../../tests/reactNativeMock'",
            elapsedMs: 100,
          },
        ],
        planning,
        ["app/game.tsx"],
        "app/game.tsx",
      ),
    ).toBe("outside_task_scope");

    expect(
      classifyValidationFailureScope(
        [
          {
            step: "bun x tsc --noEmit",
            command: "bun x tsc --noEmit",
            ok: false,
            exitCode: 2,
            stdout: "",
            stderr: "app/game.tsx(12,7): error TS2322: Type 'string' is not assignable.",
            elapsedMs: 100,
          },
        ],
        planning,
        ["app/game.tsx"],
        "app/game.tsx",
      ),
    ).toBe("task_scope");
  });

  test("does not turn browser assertions into repair instructions for test-only autonomy tasks", () => {
    const planning = planningFixture({
      targetPaths: ["app/__tests__/_layout.autonomy.test.ts"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["app/__tests__/_layout.autonomy.test.ts"],
      },
      acceptanceCriteria: ["Add focused autonomy unit coverage."],
      validationSteps: ["bun test", "bunx tsc --noEmit", "bun run lint"],
    }) as any;

    expect(
      classifyValidationFailureScope(
        [
          {
            step: "bun test",
            command: "bun test",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "components/__tests__/AnimatedSelectionRing.test.tsx: Cannot find module '../../tests/reactNativeMock'",
            elapsedMs: 100,
          },
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded. waiting for getByTestId('home-screen')",
            elapsedMs: 127_000,
          },
        ],
        planning,
        ["app/__tests__/_layout.autonomy.test.ts"],
        "app/__tests__/_layout.autonomy.test.ts",
      ),
    ).toBe("outside_task_scope");
  });

  test("treats browser assertion failures as repairable task-scope validation", () => {
    const planning = planningFixture({
      targetPaths: ["app/game.tsx"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["app/game.tsx"],
      },
    }) as any;

    expect(
      classifyValidationFailureScope(
        [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "Verified: settings screen",
            stderr:
              "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n - waiting for getByTestId('home-screen').last() to be visible",
            elapsedMs: 133_253,
          },
        ],
        planning,
        ["app/game.tsx"],
        "app/game.tsx",
      ),
    ).toBe("task_scope");
  });

  test("does not treat scope globs as hard sandbox write boundaries", () => {
    const planning = planningFixture({
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["app/game.tsx"],
      },
    }) as any;

    expect(
      collectWriteScopeIssuesFromChangedPaths(
        ["components/PlanetConquest.tsx", "app/game.tsx"],
        planning,
      ),
    ).toEqual([]);

    expect(
      collectWriteScopeIssuesFromChangedPaths(["outputs/data/runtime.db"], {
        ...planning,
        scope: {
          ...planning.scope,
          forbiddenGlobs: ["outputs/**"],
        },
      }),
    ).toEqual([]);
  });

  test("uses a longer timeout for browser e2e validation commands", () => {
    expect(isLongRunningBrowserValidationCommand("bun run web:e2e")).toBe(true);
    expect(isLongRunningBrowserValidationCommand("bunx playwright test")).toBe(true);
    expect(isLongRunningBrowserValidationCommand("npx cypress run")).toBe(true);
    expect(isLongRunningBrowserValidationCommand("bun test")).toBe(false);
    expect(isLongRunningBrowserValidationCommand("bun run lint")).toBe(false);

    expect(resolveValidationCommandTimeoutMs("bun run web:e2e", 180_000)).toBe(600_000);
    expect(resolveValidationCommandTimeoutMs("bun run lint", 180_000)).toBe(180_000);
    expect(resolveValidationCommandTimeoutMs("bun run web:e2e", 900_000)).toBe(900_000);
  });

  test("uses a longer timeout when an aggregate package script contains browser validation", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-aggregate-browser-validation-"));
    try {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          scripts: {
            validate: "bun run validate:publish",
            "validate:publish": "node ./scripts/validate-publish-readiness.js",
            lint: "eslint .",
          },
          devDependencies: { playwright: "1.0.0" },
        }),
      );
      writeFileSync(
        join(repo, "scripts", "validate-publish-readiness.js"),
        "await Bun.$`bun run web:e2e`;\n",
      );

      expect(validationCommandIncludesLongRunningBrowserWork(repo, "bun run validate")).toBe(true);
      expect(validationCommandIncludesLongRunningBrowserWork(repo, "bun run lint")).toBe(false);
      expect(shouldEnsurePlaywrightBrowserRuntime(repo, "bun run validate")).toBe(true);
      expect(resolveValidationCommandTimeoutMs("bun run validate", 180_000, repo)).toBe(600_000);
      expect(resolveValidationCommandTimeoutMs("bun run lint", 180_000, repo)).toBe(180_000);

      expect(
        shouldRetryBrowserValidationRunOnce(
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            elapsedMs: 200_000,
            stdout: "",
            stderr: "Web end-to-end smoke test failed: Route/startup smoke failure (route/startup)",
          },
          repo,
        ),
      ).toBe(true);

      expect(
        shouldRetryAggregateWorkerValidationRunOnce(
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            elapsedMs: 58_701,
            stdout: "",
            stderr: 'error: script "test:worker" exited with code 1',
          },
          repo,
        ),
      ).toBe(true);
      expect(
        shouldRetryAggregateWorkerValidationRunOnce(
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            elapsedMs: 61_107,
            stdout: "[publish readiness 2/7] Worker tests\nError: Test timed out in 5000ms.",
            stderr: "",
          },
          repo,
        ),
      ).toBe(true);
      expect(
        shouldRetryAggregateWorkerValidationRunOnce(
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            elapsedMs: 61_107,
            stdout: "[publish readiness 7/7] Web e2e smoke\nError: Test timed out in 5000ms.",
            stderr: "",
          },
          repo,
        ),
      ).toBe(false);
      expect(
        shouldRetryAggregateWorkerValidationRunOnce(
          {
            step: "bun run lint",
            command: "bun run lint",
            ok: false,
            exitCode: 1,
            elapsedMs: 1_000,
            stdout: "",
            stderr: 'error: script "test:worker" exited with code 1',
          },
          repo,
        ),
      ).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("recognizes tests nested behind aggregate package scripts and JavaScript runners", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-aggregate-test-validation-"));
    try {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          scripts: {
            validate: "bun run validate:publish",
            "validate:publish": "node ./scripts/validate-publish-readiness.js",
            lint: "eslint .",
          },
        }),
      );
      writeFileSync(
        join(repo, "scripts", "validate-publish-readiness.js"),
        [
          "const steps = [",
          "  createStep('Unit tests', 'bun', ['test']),",
          "  createStep('Worker tests', 'bun', ['run', 'test:worker']),",
          "];",
        ].join("\n"),
      );

      expect(validationCommandIncludesTestWork(repo, "bun run validate")).toBe(true);
      expect(validationCommandIncludesTestWork(repo, "bun run lint")).toBe(false);
      expect(validationCommandIncludesTestWork(repo, "bun test")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("defers long browser validation after deterministic fast failures", () => {
    const reason = shouldDeferLongValidationAfterFastFailures("bun run web:e2e", [
      {
        step: "bun test",
        command: "bun test",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Cannot find module './missing-helper' from 'tests/example.test.ts'",
        elapsedMs: 50,
      },
    ]);

    expect(reason).toContain("fast validation already failed");
    expect(reason).toContain("bun test");
    expect(shouldDeferLongValidationAfterFastFailures("bun run lint", [])).toBeNull();
  });

  test("sanitizes stale existing-file path hints without blocking explicit file creation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-stale-path-hints-"));
    try {
      const planning = planningFixture({
        targetPaths: ["tests/missing-contract.test.ts", "src/existing.ts"],
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: ["tests/missing-contract.test.ts", "src/existing.ts"],
        },
        validationSteps: ["bun test ./tests/missing-contract.test.ts", "bun test"],
      });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "existing.ts"), "export const ok = true;\n");

      const sanitized = sanitizeTaskExecutePlanningPathHints(
        planning,
        root,
        "Update the existing validation contract.",
      ) as ReturnType<typeof planningFixture> & { repoHintDiagnostics?: string[] };

      expect(sanitized.targetPaths).toEqual(["src/existing.ts"]);
      expect(sanitized.scope.writeGlobs).toEqual(["src/existing.ts"]);
      expect(sanitized.validationSteps).toEqual(["bun test"]);
      expect(sanitized.repoHintDiagnostics?.join("\n")).toContain("does not exist");

      const createPlanning = sanitizeTaskExecutePlanningPathHints(
        planningFixture({
          targetPaths: ["tests/new-contract.test.ts"],
        }),
        root,
        "Create a new test file for the contract.",
      ) as ReturnType<typeof planningFixture>;
      expect(createPlanning.targetPaths).toEqual(["tests/new-contract.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops stale likely directories with missing parents before worker guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-stale-likely-dirs-"));
    try {
      mkdirSync(join(root, "app"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(
        join(root, "app", "_layout.tsx"),
        "export default function Layout() { return null; }\n",
      );
      writeFileSync(join(root, "tests", "reactNativeMock.js"), "export const View = 'View';\n");

      const sanitized = sanitizeTaskExecutePlanningPathHints(
        planningFixture({
          targetPaths: ["app/_layout.tsx", "tests/reactNativeMock.js"],
          discovery: {
            ripgrepQueries: ["reactNativeMock"],
            likelyDirs: ["apps/client/app", "apps/client/tests", "app", "tests"],
            keywords: ["app shell"],
          },
        }),
        root,
        "Fix the existing app shell and React Native mock lint issue.",
      ) as ReturnType<typeof planningFixture> & {
        repoHintDiagnostics?: string[];
        repoHintStalePaths?: string[];
      };

      expect(sanitized.discovery.likelyDirs).toEqual(["app", "tests"]);
      expect(sanitized.targetPaths).toEqual(["app/_layout.tsx", "tests/reactNativeMock.js"]);
      expect(sanitized.repoHintStalePaths).toEqual(["apps/client/app", "apps/client/tests"]);
      expect(sanitized.repoHintDiagnostics?.join("\n")).toContain("missing parent directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strips stale planner prose before it reaches worker guidance", () => {
    const guidance = sanitizePlannerWorkerInstructionPathHints(
      [
        "Inspect apps/client/app/_layout.tsx and apps/client/tests/reactNativeMock.js first.",
        "Validate with bun run lint, bunx tsc --noEmit, and bun test.",
      ].join("\n"),
      ["apps/client/app", "apps/client/tests"],
    );

    expect(guidance).toContain("Planner path guidance was sanitized");
    expect(guidance).not.toContain("apps/client/app");
    expect(guidance).not.toContain("apps/client/tests");
    expect(guidance).toContain("Validate with bun run lint");
  });

  test("injects the sandbox Expo port into browser script validation commands", () => {
    const bunExec = process.execPath;

    expect(
      prepareValidationCommandArgv("bun run web:e2e", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual([bunExec, "run", "web:e2e", "--", "--port", "19444"]);

    expect(
      prepareValidationCommandArgv("bun run web:e2e -- --port 19111", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual([bunExec, "run", "web:e2e", "--", "--port", "19111"]);

    expect(
      prepareValidationCommandArgv("bunx playwright test", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual([bunExec, "x", "playwright", "test"]);
  });

  test("resolves validation Bun commands through an embedded Bun executable", () => {
    const bunBin = process.platform === "win32" ? "C:/runtime/bin/bun.exe" : "/runtime/bin/bun";
    const env = {
      EXPO_DEV_SERVER_PORT: "19444",
      PUSHPALS_BUN_BIN: bunBin,
    };

    expect(prepareValidationCommandArgv("bun run web:e2e", env)).toEqual([
      bunBin,
      "run",
      "web:e2e",
      "--",
      "--port",
      "19444",
    ]);
    expect(prepareValidationSpawnArgv(["bunx", "playwright", "test"], env)).toEqual([
      bunBin,
      "x",
      "playwright",
      "test",
    ]);
  });

  test("defers nested Docker-dependent aggregate validation only in socketless workers", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-docker-validation-deferral-"));

    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            validate: "node ./scripts/validate.js",
            "web:review:validate":
              "node ./scripts/run-package-script-sequence.js validate worker:deploy:dry-run",
            "test:supabase": "node ./scripts/test-supabase.js",
            "worker:deploy:dry-run": "wrangler deploy --dry-run",
          },
        }),
        "utf8",
      );
      writeFileSync(
        join(root, "scripts", "validate.js"),
        "const steps = [['run', 'test:supabase']];\n",
        "utf8",
      );
      writeFileSync(
        join(root, "scripts", "test-supabase.js"),
        "console.log('Starting isolated local stack'); run(['start']);\n",
        "utf8",
      );

      expect(validationCommandRequiresDockerDaemon(root, "bun run validate")).toBe(true);
      expect(
        packageScriptSequenceReferences(
          "node ./scripts/run-package-script-sequence.js validate worker:deploy:dry-run",
        ),
      ).toEqual(["validate", "worker:deploy:dry-run"]);
      expect(validationCommandRequiresDockerDaemon(root, "bun run web:review:validate")).toBe(true);
      expect(validationCommandRequiresDockerDaemon(root, "bun run worker:deploy:dry-run")).toBe(
        false,
      );
      expect(
        trustedEnvironmentValidationDeferralReason(root, "bun run validate", {
          PUSHPALS_WORKER_DOCKER_CAPABILITY: "unavailable",
        }),
      ).toContain("trusted host");
      const deferredDetail = trustedEnvironmentValidationDeferralReason(root, "bun run validate", {
        PUSHPALS_WORKER_DOCKER_CAPABILITY: "unavailable",
      });
      expect(
        trustedEnvironmentValidationDeferralReason(root, "bun run web:review:validate", {
          PUSHPALS_WORKER_DOCKER_CAPABILITY: "unavailable",
        }),
      ).toContain("trusted host");
      expect(
        detectValidationBlocker([
          {
            step: "bun run validate",
            command: "bun run validate",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: deferredDetail ?? "",
            elapsedMs: 0,
          },
        ]),
      ).toMatchObject({ category: "environment" });
      expect(
        trustedEnvironmentValidationDeferralReason(root, "bun run validate", {
          PUSHPALS_WORKER_DOCKER_CAPABILITY: "available",
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keys browser-runtime readiness by dependency inputs and browser targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-browser-runtime-cache-"));

    try {
      writeFileSync(join(root, "package.json"), '{"devDependencies":{"playwright":"1.0.0"}}');
      writeFileSync(join(root, "bun.lock"), "lock-a", "utf8");
      const env = { PLAYWRIGHT_BROWSERS_PATH: join(root, "browser-cache") };
      const first = playwrightBrowserRuntimeCacheMarkerPath(root, ["chromium"], env);
      const reordered = playwrightBrowserRuntimeCacheMarkerPath(root, ["chromium"], env);
      const otherTarget = playwrightBrowserRuntimeCacheMarkerPath(root, ["firefox"], env);
      writeFileSync(join(root, "bun.lock"), "lock-b", "utf8");
      const changedLock = playwrightBrowserRuntimeCacheMarkerPath(root, ["chromium"], env);

      expect(first).toBe(reordered);
      expect(otherTarget).not.toBe(first);
      expect(changedLock).not.toBe(first);
      expect(first).toContain(".pushpals-browser-ready-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects a broken Bun dependency binary layout before validation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-bun-layout-preflight-"));

    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            scripts: { lint: "expo lint" },
            dependencies: { expo: "1.0.0" },
            devDependencies: { eslint: "1.0.0", typescript: "1.0.0" },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(join(root, "bun.lock"), "", "utf8");
      for (const [pkg, binName, binPath] of [
        ["expo", "expo", "bin/cli.js"],
        ["eslint", "eslint", "bin/eslint.js"],
        ["typescript", "tsc", "bin/tsc"],
      ] as const) {
        mkdirSync(join(root, "node_modules", pkg, "bin"), { recursive: true });
        writeFileSync(
          join(root, "node_modules", pkg, "package.json"),
          JSON.stringify({ name: pkg, bin: { [binName]: binPath } }, null, 2),
          "utf8",
        );
        writeFileSync(join(root, "node_modules", pkg, binPath), "console.log('ok');\n", "utf8");
      }

      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun x tsc --noEmit", "bun run lint"])?.reason,
      ).toContain("node_modules/.bin is missing");

      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      for (const binName of ["expo", "eslint", "tsc"]) {
        writeFileSync(join(root, "node_modules", ".bin", binName), "", "utf8");
      }
      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun x tsc --noEmit", "bun run lint"]),
      ).toBeNull();

      rmSync(join(root, "node_modules", ".bin", "eslint"), { force: true });
      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun x tsc --noEmit", "bun run lint"])?.reason,
      ).toContain("eslint");

      rmSync(join(root, "node_modules", "typescript"), { recursive: true, force: true });
      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun x tsc --noEmit", "bun run lint"])?.reason,
      ).toContain("typescript");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs linked node_modules before Expo Router browser validation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-linked-expo-router-"));
    const dependencyRoot = join(root, "repo-node-modules");

    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            scripts: { "web:e2e": "node scripts/test-web-e2e.js", lint: "expo lint" },
            dependencies: { expo: "1.0.0", "expo-router": "1.0.0" },
            devDependencies: { playwright: "1.0.0", typescript: "1.0.0" },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(join(root, "bun.lock"), "", "utf8");
      mkdirSync(join(dependencyRoot, ".bin"), { recursive: true });
      for (const dependencyName of ["expo", "expo-router", "playwright", "typescript"]) {
        mkdirSync(join(dependencyRoot, dependencyName), { recursive: true });
        writeFileSync(
          join(dependencyRoot, dependencyName, "package.json"),
          JSON.stringify({ name: dependencyName }, null, 2),
          "utf8",
        );
      }
      symlinkSync(
        dependencyRoot,
        join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      writeFileSync(join(dependencyRoot, ".pushpals-dependency-snapshot"), "key\n", "utf8");
      writeFileSync(
        join(dependencyRoot, ".pushpals-validation-safe-dependency-snapshot"),
        `${bunDependencySnapshotKey(root)}\n`,
        "utf8",
      );
      expect(resolveBunDependencyLayoutPreflight(root, ["bun test", "bun run web:e2e"])).toBeNull();

      rmSync(join(dependencyRoot, ".pushpals-dependency-snapshot"), { force: true });
      rmSync(join(dependencyRoot, ".pushpals-validation-safe-dependency-snapshot"), {
        force: true,
      });

      const browserPlan = resolveBunDependencyLayoutPreflight(root, [
        "bun test",
        "bun run web:e2e",
      ]);
      expect(browserPlan?.reason).toContain("node_modules is linked");
      expect(browserPlan?.removeLinkedNodeModules).toBe(true);

      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            scripts: {
              validate: "node scripts/validate-publish-readiness.js",
              "web:e2e": "node scripts/test-web-e2e.js",
            },
            dependencies: { expo: "1.0.0", "expo-router": "1.0.0" },
            devDependencies: { playwright: "1.0.0", typescript: "1.0.0" },
          },
          null,
          2,
        ),
        "utf8",
      );
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "scripts", "validate-publish-readiness.js"),
        "await Bun.$`bun run web:e2e`;\n",
        "utf8",
      );
      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun run validate"])?.removeLinkedNodeModules,
      ).toBe(true);
      expect(
        resolveBunDependencyLayoutPreflightTimeoutForValidationCommands(
          root,
          ["bun run validate"],
          180_000,
        ),
      ).toBe(600_000);

      expect(resolveBunDependencyLayoutPreflight(root, ["bun test"])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces managed linked-package snapshots before Bun validation", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pushpals-validation-linked-package-snapshot-"));
    const canonicalRepo = join(tempRoot, "repo");
    const root = join(canonicalRepo, ".worktrees", "job-fixture");
    const canonicalWrangler = join(canonicalRepo, "node_modules", "wrangler");

    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify(
          {
            scripts: { "worker:deploy:dry-run": "wrangler deploy --dry-run" },
            devDependencies: { wrangler: "1.0.0" },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(join(root, "bun.lock"), "", "utf8");
      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(root, "node_modules", "@cloudflare", "unenv-preset"), {
        recursive: true,
      });
      mkdirSync(canonicalWrangler, { recursive: true });
      writeFileSync(
        join(canonicalWrangler, "package.json"),
        JSON.stringify({
          name: "wrangler",
          type: "module",
          bin: { wrangler: "cli.js" },
        }),
        "utf8",
      );
      writeFileSync(
        join(canonicalWrangler, "cli.js"),
        'import preset from "@cloudflare/unenv-preset"; process.stdout.write(preset);\n',
        "utf8",
      );
      writeFileSync(
        join(root, "node_modules", "@cloudflare", "unenv-preset", "package.json"),
        JSON.stringify({
          name: "@cloudflare/unenv-preset",
          type: "module",
          exports: "./index.js",
        }),
        "utf8",
      );
      writeFileSync(
        join(root, "node_modules", "@cloudflare", "unenv-preset", "index.js"),
        'export default "job-local";\n',
        "utf8",
      );
      writeFileSync(join(root, "node_modules", ".bin", "wrangler"), "", "utf8");
      writeFileSync(
        join(root, "node_modules", ".pushpals-dependency-snapshot"),
        "fixture\n",
        "utf8",
      );
      symlinkSync(
        canonicalWrangler,
        join(root, "node_modules", "wrangler"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const plan = resolveBunDependencyLayoutPreflight(root, ["bun run worker:deploy:dry-run"]);
      expect(plan?.reason).toContain("linked package directories");
      expect(plan?.removeLinkedNodeModules).toBe(true);

      const linkedRun = spawnSync("node", [join(root, "node_modules", "wrangler", "cli.js")], {
        env: {
          ...process.env,
          NODE_PATH: join(root, "node_modules"),
          BUN_OPTIONS: "",
        },
        encoding: "utf8",
      });
      expect(linkedRun.status).not.toBe(0);
      expect(linkedRun.stderr).toContain("Cannot find package '@cloudflare/unenv-preset'");

      const logs: string[] = [];
      removeLinkedNodeModulesDependencyArtifact(root, (_stream, line) => logs.push(line));
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(logs.join("\n")).toContain(
        "removed linked-package node_modules artifact before local Bun install repair",
      );

      const localWrangler = join(root, "node_modules", "wrangler");
      const localPreset = join(root, "node_modules", "@cloudflare", "unenv-preset");
      mkdirSync(localWrangler, { recursive: true });
      mkdirSync(localPreset, { recursive: true });
      writeFileSync(
        join(localWrangler, "package.json"),
        JSON.stringify({ name: "wrangler", type: "module" }),
        "utf8",
      );
      writeFileSync(
        join(localWrangler, "cli.js"),
        'import preset from "@cloudflare/unenv-preset"; process.stdout.write(preset);\n',
        "utf8",
      );
      writeFileSync(
        join(localPreset, "package.json"),
        JSON.stringify({
          name: "@cloudflare/unenv-preset",
          type: "module",
          exports: "./index.js",
        }),
        "utf8",
      );
      writeFileSync(join(localPreset, "index.js"), 'export default "job-local";\n', "utf8");

      const localizedRun = spawnSync("node", [join(localWrangler, "cli.js")], {
        env: {
          ...process.env,
          NODE_PATH: join(root, "node_modules"),
          BUN_OPTIONS: "",
        },
        encoding: "utf8",
      });
      expect(localizedRun.status).toBe(0);
      expect(localizedRun.stdout).toBe("job-local");
      expect(localizedRun.stderr).toBe("");

      const localizedBunRun = spawnSync(process.execPath, [join(localWrangler, "cli.js")], {
        env: {
          ...process.env,
          NODE_PATH: join(root, "node_modules"),
          BUN_OPTIONS: "",
        },
        encoding: "utf8",
      });
      expect(localizedBunRun.status).toBe(0);
      expect(localizedBunRun.stdout).toBe("job-local");
      expect(localizedBunRun.stderr).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("keeps current validation-safe container dependency projections for Bun validation", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-hardlink-snapshot-"));

    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { "worker:deploy:dry-run": "wrangler deploy --dry-run" },
          devDependencies: { wrangler: "1.0.0" },
        }),
        "utf8",
      );
      writeFileSync(join(root, "bun.lock"), "", "utf8");
      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(root, "node_modules", "wrangler"), { recursive: true });
      writeFileSync(join(root, "node_modules", ".bin", "wrangler"), "", "utf8");
      writeFileSync(
        join(root, "node_modules", "wrangler", "package.json"),
        JSON.stringify({ name: "wrangler", bin: { wrangler: "cli.js" } }),
        "utf8",
      );
      writeFileSync(join(root, "node_modules", "wrangler", "cli.js"), "", "utf8");
      writeFileSync(join(root, "node_modules", ".pushpals-dependency-snapshot"), "key\n");
      writeFileSync(
        join(root, "node_modules", ".pushpals-validation-safe-dependency-snapshot"),
        `${bunDependencySnapshotKey(root)}\n`,
      );

      expect(
        resolveBunDependencyLayoutPreflight(root, ["bun run worker:deploy:dry-run"]),
      ).toBeNull();

      writeFileSync(join(root, "bun.lock"), "changed", "utf8");
      const stale = resolveBunDependencyLayoutPreflight(root, ["bun run worker:deploy:dry-run"]);
      expect(stale?.reason).toContain("fingerprint is stale");
      expect(stale?.removeLinkedNodeModules).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks validation on dependency preflight repair failure", () => {
    expect(resolveBunDependencyLayoutPreflightTimeoutMs(10_000)).toBe(30_000);
    expect(resolveBunDependencyLayoutPreflightTimeoutMs(180_000)).toBe(180_000);
    expect(resolveBunDependencyLayoutPreflightTimeoutMs(900_000)).toBe(600_000);

    const run = buildBunDependencyLayoutPreflightFailureRun({
      validationCommand: "bun test",
      validationCommands: ["bun test", "bun run lint"],
      preflightCommand: "bun install --offline --frozen-lockfile --ignore-scripts",
      preflightReason: "node_modules/.bin is missing for Bun validation commands",
      run: {
        step: "bun install --offline --frozen-lockfile --ignore-scripts",
        command: "bun install --offline --frozen-lockfile --ignore-scripts",
        ok: false,
        exitCode: 124,
        stdout: "",
        stderr: "Validation command timed out after 180000ms.",
        elapsedMs: 180_000,
      },
    });

    expect(run.command).toBe("bun test");
    expect(run.exitCode).toBe(124);
    expect(run.stderr).toContain("Dependency layout preflight failed before validation command");
    expect(run.stderr).toContain("node_modules/.bin is missing");
    expect(collectRequiredValidationFailures(["bun test", "bun run lint"], [run])[0]).toContain(
      "Dependency layout preflight failed",
    );
  });

  test("returns a validation failure when a command executable cannot start", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-missing-exec-"));

    try {
      const result = await runValidationArgv(
        root,
        "missing-tool --version",
        [join(root, process.platform === "win32" ? "missing-tool.exe" : "missing-tool")],
        process.env as Record<string, string>,
        5_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("Validation command could not start executable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns the real command exit when failed browser launchers leave pipes open", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-leaky-pipe-"));
    const script = [
      "Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 4000)'], { stdout: 'inherit', stderr: 'inherit' });",
      "console.error('web:e2e failed before browser assertions');",
      "process.exit(1);",
    ].join("\n");
    const startedAt = Date.now();

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        process.env as Record<string, string>,
        10_000,
        {},
        "validation timed out",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("web:e2e failed before browser assertions");
      expect(result.elapsedMs).toBeLessThan(3_500);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("waits for authoritative exit before applying a browser failure-marker veto", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-idle-browser-failure-"));
    const script = [
      "console.error('Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.');",
      "console.error('Call log:');",
      "console.error(\" - waiting for getByTestId('home-screen').last() to be visible\");",
      "setTimeout(() => process.exit(0), 750);",
    ].join("\n");
    const startedAt = Date.now();

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        {
          ...(process.env as Record<string, string>),
          PUSHPALS_VALIDATION_FAILURE_IDLE_MS: "250",
        },
        10_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.browserSignal).toBe("failure");
      expect(result.stderr).toContain(
        "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
      );
      expect(result.stderr).toContain("waiting for getByTestId('home-screen')");
      expect(result.stderr).not.toContain("validation timed out");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
      expect(result.elapsedMs).toBeLessThan(3_500);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds noisy validation output without losing an evicted browser failure signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-noisy-browser-failure-"));
    const script = [
      "process.stdout.write('validation-head\\n' + 'a'.repeat(1200000));",
      "process.stdout.write('\\nWeb end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.\\n');",
      "process.stdout.write('b'.repeat(1200000) + '\\nvalidation-tail\\n');",
      "setTimeout(() => process.exit(1), 750);",
    ].join("\n");
    const startedAt = Date.now();

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        {
          ...(process.env as Record<string, string>),
          PUSHPALS_VALIDATION_FAILURE_IDLE_MS: "500",
        },
        10_000,
        {
          maxOutputChars: 4_194_304,
          maxOutputLines: 20_000,
          maxOutputHeadLines: 10_000,
        },
        "validation timed out",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toStartWith("validation-head");
      expect(result.stdout).toContain("earlier validation output truncated");
      expect(result.stdout).toEndWith("validation-tail");
      expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(result.browserSignal).toBe("failure");
      expect(result.stderr).not.toContain("validation timed out");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a browser success marker followed by a hang as a timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-idle-browser-success-"));
    const script = [
      "console.log('Verified: home screen');",
      "console.log('Verified: return to home from game');",
      "console.log('Web end-to-end smoke test completed successfully.');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const startedAt = Date.now();

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        {
          ...(process.env as Record<string, string>),
          PUSHPALS_VALIDATION_SUCCESS_IDLE_MS: "250",
        },
        1_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.browserSignal).toBe("success");
      expect(result.stdout).toContain("Web end-to-end smoke test completed successfully.");
      expect(result.stderr).toContain("validation timed out");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
      expect(result.elapsedMs).toBeLessThan(6_000);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not synthesize success before a later nonzero browser exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-browser-false-green-"));
    const script = [
      "console.log('Web end-to-end smoke test completed successfully.');",
      "setTimeout(() => { console.error('post-test cleanup failed'); process.exit(7); }, 750);",
    ].join("\n");

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        {
          ...(process.env as Record<string, string>),
          PUSHPALS_VALIDATION_SUCCESS_IDLE_MS: "250",
        },
        5_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.browserSignal).toBe("success");
      expect(result.stdout).toContain("Web end-to-end smoke test completed successfully.");
      expect(result.stderr).toContain("post-test cleanup failed");
      expect(result.stderr).not.toContain("validation timed out");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails after authoritative exit when browser output contains conflicting markers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-browser-conflicting-markers-"));
    const script = [
      "console.error('Web end-to-end smoke test failed: AssertionError');",
      "console.log('Web end-to-end smoke test completed successfully.');",
      "setTimeout(() => process.exit(0), 500);",
    ].join("\n");

    try {
      const result = await runValidationArgv(
        root,
        "bun run web:e2e",
        [process.execPath, "-e", script],
        process.env as Record<string, string>,
        5_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.browserSignal).toBe("failure_and_success");
      expect(result.terminalStatusSource).toBe("process_exit");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(350);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects repo Playwright browser runtime needs for web smoke commands", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-browser-"));
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          scripts: {
            "web:e2e": "node scripts/test-web-e2e.js",
          },
          devDependencies: {
            playwright: "^1.0.0",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(scriptsDir, "test-web-e2e.js"),
      "const { chromium } = require('playwright');\n",
    );

    try {
      expect(shouldEnsurePlaywrightBrowserRuntime(root, "bun run web:e2e")).toBe(true);
      expect(shouldEnsurePlaywrightBrowserRuntime(root, "bun test")).toBe(false);
      expect(playwrightBrowserInstallArgv()).toEqual(["bunx", "playwright", "install", "chromium"]);
      expect(inferPlaywrightBrowserInstallTargets(root, "bun run web:e2e")).toEqual(["chromium"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies only fast non-browser Bun validation as parallel-safe", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-parallel-safe-"));
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          scripts: {
            lint: "eslint .",
            "web:e2e": "node scripts/test-web-e2e.js",
          },
          devDependencies: {
            playwright: "^1.0.0",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(scriptsDir, "test-web-e2e.js"), "require('playwright');\n");

    try {
      expect(isParallelSafeFastValidationCommand(root, "bun test")).toBe(true);
      expect(isParallelSafeFastValidationCommand(root, "bun x tsc --noEmit")).toBe(true);
      expect(isParallelSafeFastValidationCommand(root, "bun run lint")).toBe(true);
      expect(isParallelSafeFastValidationCommand(root, "bun run web:e2e")).toBe(false);
      expect(isParallelSafeFastValidationCommand(root, "bun test && bun run lint")).toBe(false);
      expect(isParallelSafeFastValidationCommand(root, "git status --short")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("infers Playwright channel installs from repo browser smoke scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-browser-channel-"));
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          scripts: {
            "web:e2e": "node scripts/test-web-e2e.js",
          },
          devDependencies: {
            playwright: "^1.0.0",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(scriptsDir, "test-web-e2e.js"),
      [
        "const { chromium } = require('playwright');",
        "await chromium.launch({ channel: 'msedge' });",
      ].join("\n"),
    );

    try {
      expect(inferPlaywrightBrowserInstallTargets(root, "bun run web:e2e")).toEqual([
        "chromium",
        "msedge",
      ]);
      expect(playwrightBrowserInstallArgv(["chromium", "msedge"])).toEqual([
        "bunx",
        "playwright",
        "install",
        "chromium",
        "msedge",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("infers non-default Playwright browsers from direct commands", () => {
    expect(
      inferPlaywrightBrowserInstallTargets(
        process.cwd(),
        "bunx playwright test --browser=firefox --project=webkit",
      ),
    ).toEqual(["chromium", "firefox"]);
  });

  test("does not classify ordinary UI work with validation criteria as test-focused", () => {
    expect(
      isTestFocusedTask(
        "Modify only app/game.tsx. Deliver one small, observable battlefield readability improvement. Validate with the required repo checks.",
        planningFixture({
          acceptanceCriteria: [
            "Improve battlefield readability",
            "Run the required validation checks",
          ],
          validationSteps: ["bun test", "bun run web:e2e"],
        }) as any,
        "app/game.tsx",
      ),
    ).toBe(false);

    expect(
      isTestFocusedTask(
        "Add regression tests for the worker validation runner",
        planningFixture({
          acceptanceCriteria: ["Add coverage for validation command handling"],
        }) as any,
        "tests/workerpals.validation-command-safety.test.ts",
      ),
    ).toBe(true);
  });

  test("does not classify explicit docs-only work as test-focused from inspection language", () => {
    const teardownDocsInstruction =
      "Update `docs/codebase_context.md` to codify the repository's supported Bun test teardown contract. Read `vision.md` and verify relevant unit tests/configuration before documenting anything. Specify the supported teardown API and import/registration pattern, require deterministic cleanup of timers, listeners, servers, sockets, subscriptions, and pending async work, and describe assertions that expose lifecycle leaks instead of masking them. Include concise guidance for diagnosing suite-wide teardown failures and avoiding unsupported Bun APIs. Keep the guidance aligned with current implementation and tests; update other directly relevant documentation only if necessary. Run `bun run validate` and report the result, distinguishing any pre-existing failures from changes introduced by this work.";
    const teardownDocsPlanning = planningFixture({
      targetPaths: ["docs/codebase_context.md"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["docs/codebase_context.md"],
      },
      discovery: {
        ripgrepQueries: ["afterEach|teardown|Bun test"],
        likelyDirs: ["docs", "account/__tests__", "tests"],
      },
      acceptanceCriteria: [
        "Read vision.md and inspect relevant tests, imports, and Bun configuration before editing documentation.",
        "Only directly relevant documentation is changed.",
      ],
    }) as any;
    expect(
      isTestFocusedTask(teardownDocsInstruction, teardownDocsPlanning, "docs/codebase_context.md"),
    ).toBe(false);

    const accountDocsInstruction =
      "Update `docs/account_testing.md` to define the missing account/economy rejection contract and its required review evidence. First read `docs/codebase_context.md`, `vision.md`, and the relevant existing implementation/tests; treat current behavior as authoritative. Add a concise acceptance matrix covering HTTP status, stable error code, sanitized response body, and request-ID behavior for rejected account restoration and rejected Sector Coin or entitlement mutations. Explicitly require evidence that failures do not mutate authoritative server state. Distinguish checks requiring web review from those established by Worker dry-run validation, and avoid expanding into recently completed or explicitly excluded test targets. Update other directly relevant documentation only if needed for consistency. Validate with `bun run validate` and `bun run worker:deploy:dry-run`; report changed files, results, and any behavior/documentation mismatch discovered.";
    const accountDocsPlanning = planningFixture({
      targetPaths: ["docs/account_testing.md"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["docs/account_testing.md"],
      },
      discovery: {
        ripgrepQueries: ["account restoration|Sector Coin|entitlement"],
        likelyDirs: ["docs", "account", "cloudflare", "multiplayer", "engine"],
      },
      acceptanceCriteria: [
        "Existing behavior, implementation, tests, and unrelated test targets remain unchanged.",
      ],
    }) as any;
    expect(
      isTestFocusedTask(accountDocsInstruction, accountDocsPlanning, "docs/account_testing.md"),
    ).toBe(false);

    const writeGlobsOnlyPlanning = planningFixture({
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["docs/**"],
      },
      discovery: {
        ripgrepQueries: ["test teardown|shared mock"],
        likelyDirs: ["docs", "tests"],
      },
      acceptanceCriteria: ["Inspect relevant tests before updating the documentation."],
    }) as any;
    expect(
      isTestFocusedTask(
        "Update the documentation after inspecting the test teardown harness.",
        writeGlobsOnlyPlanning,
      ),
    ).toBe(false);

    const escapingDocsPlanning = planningFixture({
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["docs/**/../../src/**"],
      },
    }) as any;
    expect(
      isTestFocusedTask("Update tests for the affected source behavior.", escapingDocsPlanning),
    ).toBe(true);
  });
});
