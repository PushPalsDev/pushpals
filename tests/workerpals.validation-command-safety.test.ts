import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyValidationFailureScope,
  collectPrePublishHygieneIssues,
  collectWriteScopeIssuesFromChangedPaths,
  collectRequiredValidationFailures,
  collectQualityGateValidationCommands,
  extractRequiredValidationStepsFromVisionMarkdown,
  extractValidationFailureDigest,
  formatBunTestPathArg,
  inferPlaywrightBrowserInstallTargets,
  inferFallbackValidationCommandsForTestTask,
  inferRepoNativeValidationCommands,
  isAssertionCoverageTestPath,
  isBrowserSmokeHarnessPath,
  isLikelyTestPath,
  isLongRunningBrowserValidationCommand,
  isParallelSafeFastValidationCommand,
  isTestFocusedTask,
  isTestLikeValidationStep,
  playwrightBrowserInstallArgv,
  prepareValidationCommandArgv,
  prepareValidationSpawnArgv,
  resolveBunDependencyLayoutPreflight,
  resolveValidationCommandTimeoutMs,
  runValidationArgv,
  sanitizePlannerWorkerInstructionPathHints,
  sanitizeTaskExecutePlanningPathHints,
  shouldEnsurePlaywrightBrowserRuntime,
  shouldDeferLongValidationAfterFastFailures,
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

  test("treats browser smoke scripts as test validation harnesses without assertion coverage requirements", () => {
    expect(isBrowserSmokeHarnessPath("scripts/test-web-e2e.js")).toBe(true);
    expect(isBrowserSmokeHarnessPath("scripts/run-browser-smoke.ts")).toBe(true);
    expect(isLikelyTestPath("scripts/test-web-e2e.js")).toBe(true);
    expect(isAssertionCoverageTestPath("scripts/test-web-e2e.js")).toBe(false);
    expect(isAssertionCoverageTestPath("app/__tests__/route.test.ts")).toBe(true);
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
    expect(formatBunTestPathArg("tests/my smoke.test.ts")).toBe(
      '"./tests/my smoke.test.ts"',
    );
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
      writeFileSync(join(root, "app", "_layout.tsx"), "export default function Layout() { return null; }\n");
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
        resolveBunDependencyLayoutPreflight(root, [
          "bun x tsc --noEmit",
          "bun run lint",
        ])?.reason,
      ).toContain("node_modules/.bin is missing");

      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      for (const binName of ["expo", "eslint", "tsc"]) {
        writeFileSync(join(root, "node_modules", ".bin", binName), "", "utf8");
      }
      expect(
        resolveBunDependencyLayoutPreflight(root, [
          "bun x tsc --noEmit",
          "bun run lint",
        ]),
      ).toBeNull();

      rmSync(join(root, "node_modules", ".bin", "eslint"), { force: true });
      expect(
        resolveBunDependencyLayoutPreflight(root, [
          "bun x tsc --noEmit",
          "bun run lint",
        ])?.reason,
      ).toContain("eslint");

      rmSync(join(root, "node_modules", "typescript"), { recursive: true, force: true });
      expect(
        resolveBunDependencyLayoutPreflight(root, [
          "bun x tsc --noEmit",
          "bun run lint",
        ])?.reason,
      ).toContain("typescript");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("terminates idle browser validations after a captured assertion failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-validation-idle-browser-failure-"));
    const script = [
      "console.error('Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.');",
      "console.error('Call log:');",
      "console.error(\" - waiting for getByTestId('home-screen').last() to be visible\");",
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
          PUSHPALS_VALIDATION_FAILURE_IDLE_MS: "500",
        },
        10_000,
        {},
        "validation timed out",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
      );
      expect(result.stderr).toContain("waiting for getByTestId('home-screen')");
      expect(result.stderr).toContain("browser/e2e failure signal");
      expect(result.stderr).not.toContain("validation timed out");
      expect(result.elapsedMs).toBeLessThan(3_500);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminates idle browser validations after a captured success signal", async () => {
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
          PUSHPALS_VALIDATION_SUCCESS_IDLE_MS: "500",
        },
        10_000,
        {},
        "validation timed out",
      );

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Web end-to-end smoke test completed successfully.");
      expect(result.stderr).not.toContain("validation timed out");
      expect(result.elapsedMs).toBeLessThan(3_500);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
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
      expect(inferPlaywrightBrowserInstallTargets(root, "bun run web:e2e")).toEqual([
        "chromium",
      ]);
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
});
