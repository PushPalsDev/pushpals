import { describe, expect, test } from "bun:test";
import {
  docsWeakEvidencePenaltyForImpact,
  engineIdeaPriorSignalForScoring,
  feedbackPriorSignalForScoring,
  pickCandidateWithExploreExploit,
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

  test("engine idea prior scoring gives novelty bonus for unseen building blocks", () => {
    const unseen = engineIdeaPriorSignalForScoring(null);
    const learned = engineIdeaPriorSignalForScoring({
      ema_success: 0.9,
      ema_user_accept: 0.8,
      ema_latency: 0.9,
      ema_regret: 0.1,
      sample_count: 24,
    });
    expect(unseen.sampleCount).toBe(0);
    expect(unseen.noveltyScore).toBe(1);
    expect(unseen.noveltyBonus).toBeGreaterThan(0);
    expect(learned.sampleCount).toBe(24);
    expect(learned.noveltyScore).toBe(0);
    expect(learned.priorScore).toBeGreaterThan(0);
  });

  test("explore/exploit selector explores novelty when forced", () => {
    const rows = [
      { id: "cand_top", finalScore: 0.8, noveltyScore: 0.1 },
      { id: "cand_novel", finalScore: 0.6, noveltyScore: 1.0 },
      { id: "cand_mid", finalScore: 0.7, noveltyScore: 0.4 },
    ];
    const picked = pickCandidateWithExploreExploit({
      rows,
      seed: "run_a:snap_a",
      exploreRate: 1,
    });
    expect(picked.strategy).toBe("explore");
    expect(picked.selected?.id).toBe("cand_novel");
  });

  test("explore/exploit selector is deterministic and can force exploit", () => {
    const rows = [
      { id: "cand_top", finalScore: 0.9, noveltyScore: 0.2 },
      { id: "cand_alt", finalScore: 0.6, noveltyScore: 1.0 },
    ];
    const first = pickCandidateWithExploreExploit({
      rows,
      seed: "run_b:snap_b",
      exploreRate: 0,
    });
    const second = pickCandidateWithExploreExploit({
      rows,
      seed: "run_b:snap_b",
      exploreRate: 0,
    });
    expect(first.strategy).toBe("exploit");
    expect(first.selected?.id).toBe("cand_top");
    expect(second.selected?.id).toBe(first.selected?.id);
  });
});

