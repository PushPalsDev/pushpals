import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildBrowserValidationRepairPacket,
  buildQualityRevisionHint,
  buildCriticRevisionIssues,
  buildQualityGateRevisionIssues,
  buildTaskFailureJobFamily,
  extractValidationFailureRetryDigest,
  isBrowserValidationInfrastructureDigest,
  knownFailureHintsForPacket,
  qualityRevisionLoopUpperBound,
  recordBrowserFailureMemory,
  shouldReviseRequiredValidationBlocker,
  revisionLimitForQualityGateFailures,
  relaxAdvisoryQualityIssues,
} from "../apps/workerpals/src/execute_job";

describe("workerpals quality gate critic issue formatting", () => {
  test("returns no issues when score is at/above threshold, regardless of must-fix entries", () => {
    const issues = buildCriticRevisionIssues(
      {
        score: 8.8,
        mustFix: ["Fix validation command scope"],
      },
      8,
    );

    expect(issues).toEqual([]);
  });

  test("emits only score-threshold issue when score is below threshold", () => {
    const mustFix = Array.from({ length: 10 }, (_, idx) => `issue-${idx + 1}`);
    const issues = buildCriticRevisionIssues(
      {
        score: 7.9,
        mustFix,
      },
      8,
    );

    expect(issues).toEqual([
      "Critic score 7.9 is below required threshold 8.",
      "Critic must-fix: issue-1",
      "Critic must-fix: issue-2",
      "Critic must-fix: issue-3",
    ]);
  });

  test("includes revision guidance and findings fallback when must-fix entries are missing", () => {
    const issues = buildCriticRevisionIssues(
      {
        score: 2,
        findings: [
          "Validation output shows bun run test:root failing before completion.",
          "The worker did not update the baseline browser tuple metadata checks.",
        ],
        mustFix: [],
        revisionGuidance:
          "Fix the failing root test first, then update the tuple metadata validation so every browser tuple carries the required fields.",
      },
      8,
    );

    expect(issues).toEqual([
      "Critic score 2.0 is below required threshold 8.",
      "Critic finding: Validation output shows bun run test:root failing before completion.",
      "Critic finding: The worker did not update the baseline browser tuple metadata checks.",
      "Critic revision guidance: Fix the failing root test first, then update the tuple metadata validation so every browser tuple carries the required fields.",
    ]);
  });

  test("merges deterministic quality failures with critic guidance", () => {
    const issues = buildQualityGateRevisionIssues(
      [
        "Validation commands were executed but none passed.",
        "Validation steps did not execute a recognizable test command.",
      ],
      {
        score: 6.5,
        findings: ["The updated tests still do not cover the negative assertion path."],
        mustFix: ["Add negative-path assertions for the updated behavior."],
        revisionGuidance:
          "Fix the failing test command, then add the missing negative-path assertion coverage.",
        raw: "{}",
      },
      8,
    );

    expect(issues).toEqual([
      "Validation commands were executed but none passed.",
      "Validation steps did not execute a recognizable test command.",
      "Critic score 6.5 is below required threshold 8.",
      "Critic must-fix: Add negative-path assertions for the updated behavior.",
      "Critic revision guidance: Fix the failing test command, then add the missing negative-path assertion coverage.",
    ]);
  });

  test("includes prior review-fix requirements in quality revision hints", () => {
    const hint = buildQualityRevisionHint(
      ["Validation commands were executed but none passed."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: ["Reviewer scores >= 8.5/10", "All relevant tests pass"],
        validationSteps: ["bun test tests/api/review.test.ts"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      {
        resolutionType: "review_fix",
        prHeadRef: "agent/workerpal-1/job-xyz",
        prBaseRef: "main",
        previousReviewScore: 7.8,
        reviewThreshold: 8.5,
        previousReviewSummary: "Tests need stronger failure-path coverage",
        reviewerFindings: ["Add negative-path assertions"],
      },
    );

    expect(hint).toContain("Rejected PR retry requirements:");
    expect(hint).toContain("Previous ReviewAgent score: 7.8 / 10");
    expect(hint).toContain("Required approval threshold: 8.5 / 10");
    expect(hint).toContain("Previous reviewer must-fix items:");
    expect(hint).toContain("- Add negative-path assertions");
  });

  test("includes failed validation output in quality revision hints", () => {
    const hint = buildQualityRevisionHint(
      ["Required vision.md validation failed: bun test exited 1."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: [],
        requiredValidationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun test",
          command: "bun test",
          ok: false,
          exitCode: 1,
          stdout: "1 tests failed",
          stderr: "Cannot find module '../../tests/reactNativeMock'",
          elapsedMs: 123,
        },
      ],
      {
        category: "repo",
        detail: "Validation is blocked by missing repo dependencies or imported files.",
      },
    );

    expect(hint).toContain("Validation blocker: repo");
    expect(hint).toContain("Validation failure diagnostics:");
    expect(hint).toContain("- bun test failed with exit 1 after 123ms.");
    expect(hint).toContain("Cannot find module '../../tests/reactNativeMock'");
  });

  test("freezes the validated patch when requesting post-validation cleanup", () => {
    const hint = buildQualityRevisionHint(
      ["Critic score 7.0 is below required threshold 8."],
      {
        score: 7,
        findings: ["Clean up an accidental artifact."],
        mustFix: ["Remove generated node_modules changes."],
        revisionGuidance: "Keep the implementation unchanged.",
        raw: "{}",
      },
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun test", "bun run web:e2e"],
        requiredValidationSteps: ["bun test", "bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun test",
          command: "bun test",
          ok: true,
          exitCode: 0,
          stdout: "tests passed",
          stderr: "",
          elapsedMs: 120,
        },
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: true,
          exitCode: 0,
          stdout: "Web end-to-end smoke test completed successfully.",
          stderr: "",
          elapsedMs: 80_000,
        },
      ],
    );

    expect(hint).toContain("Validation-preserving cleanup mode");
    expect(hint).toContain("Treat the validated patch and browser path as frozen");
    expect(hint).toContain("Do not rewrite app behavior, route flow, browser smoke selectors");
    expect(hint).toContain("Remove generated node_modules changes.");
  });

  test("builds focused browser validation repair packets with progress breadcrumbs", () => {
    const previous = new Map<string, string>([
      [
        "bun run web:e2e",
        "Browser validation failed during shell stage: Expected home screen to be visible",
      ],
    ]);

    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
            "Call log:",
            " - waiting for getByTestId('help-primary-action').last() to be visible",
          ].join("\n"),
          elapsedMs: 127_732,
        },
      ],
      previous,
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "in-game UI",
      expected: "help menu primary action to be visible",
      selector: "getByTestId('help-primary-action')",
      previousStage: "shell",
      previousExpected: "home screen to be visible",
      progress: "new_failure",
      mustReadArtifactsBeforeEdit: true,
    });
    expect(packet?.previousDigest).toContain("shell stage");
    expect(packet?.output).toContain("help menu primary action");
  });

  test("extracts browser failure artifacts and exact assertion details for repair guidance", () => {
    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected resource allocation control to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
            "Saved screenshot: /repo/outputs/web-e2e/failure-in-game-ui.png",
            "Saved trace: /repo/outputs/web-e2e/failure-in-game-ui-trace.zip",
            "Call log:",
            " - waiting for getByText('Keep (Resource)') to be visible",
          ].join("\n"),
          elapsedMs: 127_732,
        },
      ],
      new Map([
        [
          "bun run web:e2e",
          "Browser validation failed during shell stage: Expected home Play action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded. waiting for getByRole('button', { name: 'Play' })",
        ],
      ]),
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "in-game UI",
      expected: "resource allocation control to be visible",
      selector: "getByText('Keep (Resource)')",
      previousStage: "shell",
      previousExpected: "home Play action to be visible",
      previousSelector: "getByRole('button', { name: 'Play' })",
      progress: "new_failure",
    });
    expect(packet?.artifacts).toEqual([
      "/repo/outputs/web-e2e/failure-in-game-ui.png",
      "/repo/outputs/web-e2e/failure-in-game-ui-trace.zip",
    ]);
    expect(packet?.artifactSummaries?.[0]).toContain("stage=in game ui");
  });

  test("hydrates browser repair packets from recent e2e artifact logs when command output is generic", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-artifacts-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "03-settings.png");
      const logPath = join(artifactDir, "expo-web.log");
      writeFileSync(screenshotPath, "not a real image");
      writeFileSync(
        logPath,
        [
          "Verified: settings screen",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('settings-home-button').last() to be visible",
        ].join("\n"),
      );

      const packet = buildBrowserValidationRepairPacket(
        [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
            elapsedMs: 111_031,
          },
        ],
        new Map(),
        repo,
      );

      expect(packet?.selector).toBe("getByTestId('settings-home-button')");
      expect(packet?.lastVerifiedStage).toBe("settings screen");
      expect(packet?.artifacts).toContain(screenshotPath);
      expect(packet?.artifacts).toContain(logPath);
      expect(packet?.artifactSummaries?.join("\n")).toContain("selector=getByTestId('settings-home-button')");
      expect(packet?.output).toContain("Verified: settings screen");
      expect(packet?.output).toContain("settings-home-button");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("keeps selector and last verified stage in browser retry digests", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-retry-digest-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "expo-web.log"),
        [
          "Verified: game screen",
          "Verified: owned planet",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('game-control-panel') to be visible",
        ].join("\n"),
      );

      const digest = extractValidationFailureRetryDigest(
        {
          command: "bun run web:e2e",
          exitCode: 1,
          stdout: "",
          stderr:
            "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          elapsedMs: 145_252,
        },
        repo,
      );

      expect(digest).toContain("stage=planet control panel");
      expect(digest).toContain("selector=getByTestId('game-control-panel')");
      expect(digest).toContain("last verified=owned planet");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("persists known browser failure fingerprints for repo job families", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-failure-memory-"));
    try {
      const params = {
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          scope: {
            readAnywhere: true,
            writeAllowed: true,
            writeGlobs: ["app/**", "scripts/**"],
          },
          targetPaths: ["app/__tests__/_layout.autonomy.test.ts"],
          acceptanceCriteria: ["web smoke catches shell startup"],
          validationSteps: ["bun run web:e2e"],
          requiredValidationSteps: ["bun run web:e2e"],
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      };
      const packet = buildBrowserValidationRepairPacket([
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Browser validation failed during shell stage: Expected home screen to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded. page url: http://127.0.0.1:19006/",
          elapsedMs: 30_000,
        },
      ]);
      expect(packet).not.toBeNull();

      const jobFamily = buildTaskFailureJobFamily(params);
      recordBrowserFailureMemory(repo, jobFamily, packet!);
      recordBrowserFailureMemory(repo, jobFamily, packet!);

      const hints = knownFailureHintsForPacket(repo, jobFamily, packet!);
      expect(hints.join("\n")).toContain("seen 2x before");
      expect(hints.join("\n")).toContain("Read the latest artifact/log/DOM state before editing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("treats repeated generic browser timeouts as same selector failures once logs hydrate them", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-same-selector-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "expo-web.log"),
        [
          "Verified: game screen",
          "Verified: owned planet",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('game-control-panel') to be visible",
        ].join("\n"),
      );

      const previousDigest =
        "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded. | stage=planet control panel | selector=getByTestId('game-control-panel') | last verified=owned planet";
      const packet = buildBrowserValidationRepairPacket(
        [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
            elapsedMs: 144_591,
          },
        ],
        new Map([["bun run web:e2e", previousDigest]]),
        repo,
      );

      expect(packet).toMatchObject({
        stage: "planet control panel",
        selector: "getByTestId('game-control-panel')",
        previousStage: "planet control panel",
        previousSelector: "getByTestId('game-control-panel')",
        progress: "same_failure",
        needsDiagnosticProbe: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("switches repeated browser assertion failures to diagnostic-first guidance", () => {
    const previous = new Map<string, string>([
      [
        "bun run web:e2e",
        'Web end-to-end smoke test failed: Error: Expected selected large UI option to include [x], found "Large (Game UI Style)[ ]".',
      ],
    ]);
    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            'Web end-to-end smoke test failed: Error: Expected selected large UI option marker to include "[x]", found "[ ]".',
            "Verified: settings screen",
            "Verified: settings UI size section",
            "Saved screenshot: /repo/outputs/web-e2e/02-settings.png",
          ].join("\n"),
          elapsedMs: 133_942,
        },
      ],
      previous,
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "settings UI size section",
      failureFocus: "settings UI size",
      previousFailureFocus: "settings UI size",
      needsDiagnosticProbe: true,
    });

    const hint = buildQualityRevisionHint(
      ["ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun run web:e2e"],
        requiredValidationSteps: ["bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [],
      null,
      packet,
    );

    expect(hint).toContain("Convergence mode: diagnostic-first repair");
    expect(hint).toContain("Worker phase contract");
    expect(hint).toContain("Diagnostic artifact read requirement");
    expect(hint).toContain("do not guess another selector");
    expect(hint).toContain("locator counts");
    expect(hint).toContain("bounding boxes");
    expect(hint).toContain("Artifact freshness rule");
    expect(hint).toContain("nearby DOM snippet");
    expect(hint).toContain("React Native Web note");
    expect(hint).toContain("Do not stop after fast checks only");
    expect(hint).toContain("Do not hand off another unverified selector guess.");
  });

  test("classifies killed browser smoke commands as runtime repair packets", () => {
    const packet = buildBrowserValidationRepairPacket([
      {
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 124,
        elapsedMs: 602_015,
        stdout: "",
        stderr:
          'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
      },
    ]);

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "runtime",
      digest: 'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
      output: 'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
    });
  });

  test("does not treat Playwright locator assertion timeouts as infrastructure blockers", () => {
    expect(
      isBrowserValidationInfrastructureDigest(
        "locator.waitFor: Timeout 30000ms exceeded waiting for getByTestId('help-primary-action')",
      ),
    ).toBe(false);

    expect(isBrowserValidationInfrastructureDigest("ERR_SOCKET_BAD_PORT at port 65536")).toBe(
      true,
    );
  });

  test("prioritizes browser validation repair guidance over lower-priority gate chatter", () => {
    const packet = buildBrowserValidationRepairPacket([
      {
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr:
          "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
        elapsedMs: 127_732,
      },
    ]);

    const hint = buildQualityRevisionHint(
      [
        "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).",
        "ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1.",
      ],
      {
        score: 7,
        findings: ["Generic code quality could be improved later."],
        mustFix: ["Rename helper for clarity."],
        revisionGuidance: "Polish naming.",
        raw: "{}",
      },
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun run web:e2e"],
        requiredValidationSteps: ["bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
          elapsedMs: 127_732,
        },
      ],
      null,
      packet,
    );

    expect(hint).toContain("Primary ValidationGate repair objective:");
    expect(hint).toContain("Worker phase contract");
    expect(hint).toContain("Diagnostic artifact read requirement");
    expect(hint).toContain("- Failure type: browser assertion");
    expect(hint).toContain("- Stage: in-game UI");
    expect(hint).toContain("inspect the captured browser output/artifacts");
    expect(hint).toContain("If the expected text/role/test id is not present in the screenshot");
    expect(hint).toContain("prefer existing data-testid/accessibility labels/roles");
    expect(hint).toContain("Do not invent a combined phrase for split text");
    expect(hint).toContain("preserve stages that already passed");
    expect(hint).toContain("Do not change browser startup, port selection");
    expect(hint).toContain("PushPals ValidationGate will rerun \"bun run web:e2e\"");
    expect(hint).toContain("Executor sandbox rule:");
    expect(hint).toContain("treat that as a Codex executor verification limitation");
    expect(hint).toContain("do not run the full browser command from the Codex executor by default");
    expect(hint).toContain("fast non-browser checks");
    expect(hint).toContain("let ValidationGate perform the authoritative browser run");
    expect(hint).toContain("Suppressed 1 lower-priority ScopeGate/CriticGate note");
    expect(hint).toContain("CriticGate notes deferred");
    expect(hint).not.toContain("Critic score: 7.0 / 10");
    expect(hint).not.toContain("Rename helper for clarity.");
  });

  test("warns when a small repair drifts beyond the diff budget", () => {
    const hint = buildQualityRevisionHint(
      ["ScopeGate: review changed files carefully."],
      null,
      {
        intent: "code_change",
        riskLevel: "low",
        scope: { readAnywhere: true, writeAllowed: true, maxFilesToEdit: 2 },
        targetPaths: ["app/game.tsx"],
        acceptanceCriteria: ["game control stays visible"],
        validationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [],
      null,
      null,
      ["app/game.tsx", "components/GameControlPanel.tsx", "scripts/test-web-e2e.js"],
    );

    expect(hint).toContain("Diff budget warning");
    expect(hint).toContain("above the 2-file planning.scope.maxFilesToEdit");
    expect(hint).toContain("remove unrelated churn");
  });

  test("revises required validation repo blockers until the auto-revision budget is exhausted", () => {
    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(true);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 3,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
        outsideTaskScope: true,
      }),
    ).toBe(false);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun run web:e2e exited 124"],
        blocker: { category: "environment", detail: "missing browser runtime" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);
  });

  test("uses the ValidationGate retry budget for validation failures", () => {
    const policy = {
      maxAutoRevisions: 1,
      validationMaxAutoRevisions: 3,
    };

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: ["ValidationGate: executed validation commands, but none passed."],
        requiredValidationFailures: [],
        blocker: null,
      }),
    ).toBe(3);

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: ["ScopeGate: target_path outside component root"],
        requiredValidationFailures: [],
        blocker: null,
      }),
    ).toBe(1);
  });

  test("extends the retry budget for browser validation convergence", () => {
    const policy = {
      maxAutoRevisions: 1,
      validationMaxAutoRevisions: 3,
    };

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: [
          "ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1",
        ],
        requiredValidationFailures: ["bun run web:e2e exited 1"],
        blocker: null,
        browserRepairPacket: {
          command: "bun run web:e2e",
          failureKind: "assertion",
          stage: "shell",
          selector: "getByTestId('home-screen')",
          expected: "home screen",
          failureFocus: "home shell",
          digest: "Browser validation failed during shell stage",
          previousDigest: null,
          previousStage: null,
          previousSelector: null,
          previousExpected: null,
          previousFailureFocus: null,
          progress: "first_failure",
          needsDiagnosticProbe: false,
          artifacts: [],
          output: "Web end-to-end smoke test failed",
        },
      }),
    ).toBe(8);
  });

  test("keeps the outer revision loop at the configured limit for non-browser work", () => {
    expect(
      qualityRevisionLoopUpperBound({
        maxAutoRevisions: 1,
        validationMaxAutoRevisions: 3,
      }),
    ).toBe(3);
  });

  test("extends the outer revision loop only for browser validation convergence", () => {
    expect(
      qualityRevisionLoopUpperBound(
        {
          maxAutoRevisions: 1,
          validationMaxAutoRevisions: 3,
        },
        { browserValidation: true },
      ),
    ).toBe(8);
  });

  test("downgrades assertion-balance failures when validation passed and critic score meets threshold", () => {
    const issues = relaxAdvisoryQualityIssues(
        [
          "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).",
          "Validation steps did not execute a recognizable test command.",
        ],
      [{ ok: false }, { ok: true }],
      {
        score: 8.8,
        findings: [],
        mustFix: [],
        revisionGuidance: "",
        raw: "{}",
      },
      8,
    );

    expect(issues).toEqual(["Validation steps did not execute a recognizable test command."]);
  });

  test("keeps assertion-balance failures blocking when validation did not pass or critic score is low", () => {
    const issue =
      "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).";

    expect(
      relaxAdvisoryQualityIssues(
        [issue],
        [{ ok: false }],
        {
          score: 8.8,
          findings: [],
          mustFix: [],
          revisionGuidance: "",
          raw: "{}",
        },
        8,
      ),
    ).toEqual([issue]);

    expect(
      relaxAdvisoryQualityIssues(
        [issue],
        [{ ok: true }],
        {
          score: 7.9,
          findings: [],
          mustFix: [],
          revisionGuidance: "",
          raw: "{}",
        },
        8,
      ),
    ).toEqual([issue]);
  });
});
