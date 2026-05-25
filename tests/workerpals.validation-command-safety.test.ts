import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyValidationFailureScope,
  collectWriteScopeIssuesFromChangedPaths,
  collectRequiredValidationFailures,
  collectQualityGateValidationCommands,
  extractRequiredValidationStepsFromVisionMarkdown,
  extractValidationFailureDigest,
  inferPlaywrightBrowserInstallTargets,
  inferFallbackValidationCommandsForTestTask,
  isAssertionCoverageTestPath,
  isBrowserSmokeHarnessPath,
  isLikelyTestPath,
  isLongRunningBrowserValidationCommand,
  isTestFocusedTask,
  isTestLikeValidationStep,
  playwrightBrowserInstallArgv,
  prepareValidationCommandArgv,
  resolveValidationCommandTimeoutMs,
  runValidationArgv,
  shouldEnsurePlaywrightBrowserRuntime,
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
      "tests/localbuddy.request-status.test.ts",
    );
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

  test("injects the sandbox Expo port into browser script validation commands", () => {
    expect(
      prepareValidationCommandArgv("bun run web:e2e", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual(["bun", "run", "web:e2e", "--", "--port", "19444"]);

    expect(
      prepareValidationCommandArgv("bun run web:e2e -- --port 19111", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual(["bun", "run", "web:e2e", "--", "--port", "19111"]);

    expect(
      prepareValidationCommandArgv("bunx playwright test", {
        EXPO_DEV_SERVER_PORT: "19444",
      }),
    ).toEqual(["bunx", "playwright", "test"]);
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
