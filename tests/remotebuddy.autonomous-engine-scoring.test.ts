import { describe, expect, test } from "bun:test";
import {
  docsWeakEvidencePenaltyForImpact,
  feedbackPriorSignalForScoring,
} from "../apps/remotebuddy/src/autonomous_engine";

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

  test("feedback prior scoring rewards strong latency and low regret", () => {
    const stronger = feedbackPriorSignalForScoring({
      ema_success: 0.9,
      ema_user_accept: 0.8,
      ema_latency: 0.9,
      ema_regret: 0.1,
    });
    const weaker = feedbackPriorSignalForScoring({
      ema_success: 0.9,
      ema_user_accept: 0.8,
      ema_latency: 0.1,
      ema_regret: 0.9,
    });

    expect(stronger.priorScore).toBeGreaterThan(weaker.priorScore);
    expect(stronger.emaLatency).toBeGreaterThan(weaker.emaLatency);
    expect(stronger.emaRegret).toBeLessThan(weaker.emaRegret);
  });

  test("feedback prior scoring clamps invalid values safely", () => {
    const result = feedbackPriorSignalForScoring({
      ema_success: 10,
      ema_user_accept: -2,
      ema_latency: Number.NaN,
      ema_regret: 5,
    });
    expect(result.emaSuccess).toBe(1);
    expect(result.emaUserAccept).toBe(0);
    expect(result.emaLatency).toBe(0);
    expect(result.emaRegret).toBe(1);
  });
});

