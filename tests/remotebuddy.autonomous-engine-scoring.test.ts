import { describe, expect, test } from "bun:test";
import { docsWeakEvidencePenaltyForImpact } from "../apps/remotebuddy/src/autonomous_engine";

describe("RemoteBuddy autonomy scoring: docs weak-evidence penalty", () => {
  test("does not penalize non-doc objective types", () => {
    expect(docsWeakEvidencePenaltyForImpact("lint_fix", 0)).toBe(0);
    expect(docsWeakEvidencePenaltyForImpact("small_refactor", 0.2)).toBe(0);
  });

  test("does not penalize docs when impact signal is strong", () => {
    expect(docsWeakEvidencePenaltyForImpact("docs", 0.45)).toBe(0);
    expect(docsWeakEvidencePenaltyForImpact("docs", 0.9)).toBe(0);
  });

  test("penalizes docs when impact signal is weak", () => {
    expect(docsWeakEvidencePenaltyForImpact("docs", 0)).toBeCloseTo(0.12, 6);
    expect(docsWeakEvidencePenaltyForImpact("docs", 0.225)).toBeCloseTo(0.06, 6);
  });
});

