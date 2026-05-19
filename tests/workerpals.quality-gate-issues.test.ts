import { describe, expect, test } from "bun:test";
import {
  buildQualityRevisionHint,
  buildCriticRevisionIssues,
  buildQualityGateRevisionIssues,
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
