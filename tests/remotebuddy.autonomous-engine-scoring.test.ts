import { describe, expect, test } from "bun:test";
import {
  computeAdaptiveExploreRate,
  docsWeakEvidencePenaltyForImpact,
  engineIdeaPriorSignalForScoring,
  engineSourcePriorSignalForScoring,
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

  test("engine source prior scoring gives novelty bonus for unseen sources", () => {
    const unseen = engineSourcePriorSignalForScoring(null);
    const learned = engineSourcePriorSignalForScoring({
      ema_success: 0.95,
      ema_user_accept: 0.9,
      ema_latency: 0.8,
      ema_regret: 0.05,
      sample_count: 14,
    });
    expect(unseen.sampleCount).toBe(0);
    expect(unseen.noveltyScore).toBe(1);
    expect(unseen.noveltyBonus).toBeGreaterThan(0);
    expect(learned.sampleCount).toBe(14);
    expect(learned.noveltyScore).toBe(0);
    expect(learned.priorScore).toBeGreaterThan(0);
  });

  test("engine source prior scoring boosts trusted sources and penalizes archived sources", () => {
    const trusted = engineSourcePriorSignalForScoring({
      ema_success: 0.9,
      ema_user_accept: 0.85,
      ema_latency: 0.8,
      ema_regret: 0.1,
      sample_count: 12,
      curation_status: "trusted",
      trust_score: 0.88,
      freshness_score: 0.92,
    });
    const archived = engineSourcePriorSignalForScoring({
      ema_success: 0.2,
      ema_user_accept: 0.25,
      ema_latency: 0.4,
      ema_regret: 0.8,
      sample_count: 16,
      curation_status: "archived",
      trust_score: 0.2,
      freshness_score: 0.35,
    });
    expect(trusted.curationStatus).toBe("trusted");
    expect(trusted.trustBoost).toBeGreaterThan(0);
    expect(trusted.curationPenalty).toBe(0);
    expect(archived.curationStatus).toBe("archived");
    expect(archived.curationPenalty).toBeGreaterThan(0);
    expect(archived.noveltyBonus).toBe(0);
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

  test("adaptive explore rate increases under regret pressure and low idea diversity", () => {
    const adaptive = computeAdaptiveExploreRate({
      baseRate: 0.3,
      snapshot: {
        top_signals: [
          { type: "regret_signal", value: 0.9 },
          { type: "queue_health", value: 0.6 },
        ],
        feedback_priors: [
          {
            ema_success: 0.35,
            ema_user_accept: 0.3,
            ema_regret: 0.75,
            sample_count: 24,
          },
        ],
        engine_idea_priors: [{ sample_count: 20 }, { sample_count: 1 }],
        engine_source_priors: [{ sample_count: 24 }],
      },
    });
    expect(adaptive.effectiveRate).toBeGreaterThan(0.3);
    expect(adaptive.adjustment).toBeGreaterThan(0);
  });

  test("adaptive explore rate decreases under stable high-success signals", () => {
    const adaptive = computeAdaptiveExploreRate({
      baseRate: 0.4,
      snapshot: {
        top_signals: [
          { type: "regret_signal", value: 0.05 },
          { type: "queue_health", value: 0.1 },
        ],
        feedback_priors: [
          {
            ema_success: 0.95,
            ema_user_accept: 0.9,
            ema_regret: 0.05,
            sample_count: 40,
          },
        ],
        engine_idea_priors: [
          { sample_count: 8 },
          { sample_count: 7 },
          { sample_count: 6 },
          { sample_count: 5 },
        ],
      },
    });
    expect(adaptive.effectiveRate).toBeLessThan(0.4);
    expect(adaptive.adjustment).toBeLessThan(0);
  });

  test("adaptive explore rate respects configured min/max bounds", () => {
    const high = computeAdaptiveExploreRate({
      baseRate: 0.9,
      minRate: 0.1,
      maxRate: 0.6,
      snapshot: {
        top_signals: [{ type: "regret_signal", value: 1 }],
        feedback_priors: [],
        engine_idea_priors: [],
      },
    });
    const low = computeAdaptiveExploreRate({
      baseRate: 0,
      minRate: 0.1,
      maxRate: 0.6,
      snapshot: {
        top_signals: [{ type: "regret_signal", value: 0 }],
        feedback_priors: [
          {
            ema_success: 1,
            ema_user_accept: 1,
            ema_regret: 0,
            sample_count: 100,
          },
        ],
        engine_idea_priors: [{ sample_count: 100 }],
      },
    });
    expect(high.effectiveRate).toBe(0.6);
    expect(low.effectiveRate).toBe(0.1);
  });
});
