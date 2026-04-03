import { describe, expect, test } from "bun:test";
import {
  buildCriticRevisionIssues,
  buildQualityGateRevisionIssues,
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
});
