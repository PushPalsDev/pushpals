import { describe, expect, test } from "bun:test";
import { buildCriticRevisionIssues } from "../apps/workerpals/src/execute_job";

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

    expect(issues).toEqual(["Critic score 7.9 is below required threshold 8."]);
  });
});
