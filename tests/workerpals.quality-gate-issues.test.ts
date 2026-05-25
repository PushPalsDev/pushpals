import { describe, expect, test } from "bun:test";
import {
  buildBrowserValidationRepairPacket,
  buildQualityRevisionHint,
  buildCriticRevisionIssues,
  buildQualityGateRevisionIssues,
  isBrowserValidationInfrastructureDigest,
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
    expect(hint).toContain("- Failure type: browser assertion");
    expect(hint).toContain("- Stage: in-game UI");
    expect(hint).toContain("inspect the captured browser output/artifacts");
    expect(hint).toContain("If the expected text/role/test id is not present in the screenshot");
    expect(hint).toContain("prefer existing data-testid/accessibility labels/roles");
    expect(hint).toContain("Do not invent a combined phrase for split text");
    expect(hint).toContain("preserve stages that already passed");
    expect(hint).toContain("Do not change browser startup, port selection");
    expect(hint).toContain("PushPals ValidationGate will rerun \"bun run web:e2e\"");
    expect(hint).toContain("Suppressed 1 lower-priority ScopeGate/CriticGate note");
    expect(hint).toContain("CriticGate notes deferred");
    expect(hint).not.toContain("Critic score: 7.0 / 10");
    expect(hint).not.toContain("Rename helper for clarity.");
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
          digest: "Browser validation failed during shell stage",
          previousDigest: null,
          previousStage: null,
          previousSelector: null,
          previousExpected: null,
          progress: "first_failure",
          artifacts: [],
          output: "Web end-to-end smoke test failed",
        },
      }),
    ).toBe(5);
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
