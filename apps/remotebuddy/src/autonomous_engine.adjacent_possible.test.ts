import { describe, expect, test } from "bun:test";
import {
  adjacent_possible,
  isSafeGitBranchName,
  normalizeConfiguredGitBranchName,
  type EngineCommitHistoryHint,
  type EngineOpportunityGap,
} from "./autonomous_engine";

const queueMotif: EngineCommitHistoryHint = {
  motif_id: "queue_backpressure",
  label: "Queue backpressure and throughput",
  count: 4,
  signal: 0.82,
  objective_ids: ["workforce_scaling", "reliable_autonomous_delivery"],
  gap_ids: ["workforce_throughput_gap", "delivery_reliability_gap"],
  sample_subjects: ["queue saturation fix"],
};

const throughputGap: EngineOpportunityGap = {
  id: "workforce_throughput_gap",
  label: "Workforce throughput gap",
  score: 0.76,
  evidence: [],
};

const deliveryReliabilityGap: EngineOpportunityGap = {
  id: "delivery_reliability_gap",
  label: "Delivery reliability gap",
  score: 0.6,
  evidence: [],
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

describe("autonomy git ref guards", () => {
  test("accepts normal branch names used by autonomy worktrees", () => {
    expect(isSafeGitBranchName("main")).toBe(true);
    expect(isSafeGitBranchName("main_agents")).toBe(true);
    expect(isSafeGitBranchName("feature/review-fix-123")).toBe(true);
  });

  test("rejects corrupted or refspec-like branch names before git fetch", () => {
    expect(isSafeGitBranchName("mai ?{d??")).toBe(false);
    expect(isSafeGitBranchName("origin main")).toBe(false);
    expect(isSafeGitBranchName("feature..bad")).toBe(false);
    expect(isSafeGitBranchName("topic:refs/heads/main")).toBe(false);

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message ?? ""));
    };
    try {
      expect(normalizeConfiguredGitBranchName("mai ?{d??", "main_agents")).toBe("main_agents");
    } finally {
      console.warn = warn;
    }
    expect(warnings.some((message) => message.includes("unsafe branch ref"))).toBe(true);
  });
});

describe("adjacent_possible", () => {
  test("recombines motifs with bottlenecks and emits telemetry", () => {
    const result = adjacent_possible({
      hints: [queueMotif],
      gaps: [throughputGap],
    });

    expect(result.ideas).toHaveLength(1);
    const idea = result.ideas[0];
    expect(idea.id).toBe("adjacent_possible_queue_backpressure_workforce_throughput_gap");
    expect(idea.motif_label).toContain("Queue backpressure");
    expect(idea.gap_label).toContain("Workforce throughput");
    expect(idea.candidate_shape.component_area).toBe("apps/server");
    expect(idea.evidence.some((entry) => entry.startsWith("gap_score="))).toBe(true);
    const pairTelemetry = result.telemetry.find(
      (event) =>
        event.step === "pair_attempt" &&
        event.motif_id === queueMotif.motif_id &&
        event.gap_id === throughputGap.id,
    );
    expect(pairTelemetry?.accepted).toBe(true);
    expect(pairTelemetry?.metrics?.score).toBeGreaterThan(0.5);
    expect(pairTelemetry?.attempt_id).toBe(`${queueMotif.motif_id}::${throughputGap.id}`);
    const emissionTelemetry = result.telemetry.find(
      (event) =>
        event.step === "idea_emitted" &&
        event.motif_id === queueMotif.motif_id &&
        event.gap_id === throughputGap.id,
    );
    expect(emissionTelemetry?.metrics?.rank).toBe(1);
    expect(emissionTelemetry?.attempt_id).toBe(pairTelemetry?.attempt_id);
  });

  test("guardrails drop unsupported motif-gap combinations", () => {
    const governanceGap: EngineOpportunityGap = {
      id: "governance_gap",
      label: "Governance gap",
      score: 0.7,
      evidence: [],
    };
    const result = adjacent_possible({
      hints: [queueMotif],
      gaps: [governanceGap],
    });

    expect(result.ideas).toHaveLength(0);
    const rejectionTelemetry = result.telemetry.find(
      (event) =>
        event.step === "pair_attempt" &&
        event.reason === "gap_not_supported" &&
        event.gap_id === governanceGap.id,
    );
    expect(rejectionTelemetry?.accepted).toBe(false);
    expect(rejectionTelemetry?.attempt_id).toBe(`${queueMotif.motif_id}::${governanceGap.id}`);
    const guardrailEvent = result.telemetry.find(
      (event) => event.step === "guardrail_drop" && event.reason === "gap_not_supported",
    );
    expect(guardrailEvent).toBeTruthy();
    expect(guardrailEvent?.accepted).toBe(false);
    expect(guardrailEvent?.attempt_id).toBe(rejectionTelemetry?.attempt_id);
  });

  test("enforces motif and gap thresholds before pairing", () => {
    const weakMotif: EngineCommitHistoryHint = {
      ...queueMotif,
      signal: 0.05,
    };
    const weakGap: EngineOpportunityGap = {
      id: "activation_gap",
      label: "Activation gap",
      score: 0.1,
      evidence: [],
    };
    const result = adjacent_possible({
      hints: [weakMotif],
      gaps: [throughputGap, weakGap],
      minMotifSignal: 0.25,
      minGapScore: 0.5,
    });

    expect(result.ideas).toHaveLength(0);
    expect(result.telemetry.some((event) => event.reason === "motif_signal_below_threshold")).toBe(
      true,
    );
    expect(result.telemetry.some((event) => event.reason === "gap_score_below_threshold")).toBe(
      true,
    );
    expect(result.telemetry.filter((event) => event.step === "pair_attempt")).toHaveLength(0);
  });

  test("rejects malformed motif and gap metadata with telemetry reasons", () => {
    const invalidMotifId: EngineCommitHistoryHint = {
      ...queueMotif,
      motif_id: "   ",
      label: queueMotif.label,
    };
    const invalidMotifLabel: EngineCommitHistoryHint = {
      ...queueMotif,
      motif_id: "queue_backpressure_label_missing",
      label: " ",
    };
    const invalidGapId: EngineOpportunityGap = {
      ...throughputGap,
      id: " ",
      label: "Throughput gap missing id",
    };
    const invalidGapLabel: EngineOpportunityGap = {
      ...throughputGap,
      id: "activation_gap_with_invalid_label",
      label: " ",
    };
    const result = adjacent_possible({
      hints: [invalidMotifId, invalidMotifLabel],
      gaps: [invalidGapId, invalidGapLabel],
    });

    expect(result.ideas).toHaveLength(0);
    const reasons = result.telemetry
      .filter((event) => Boolean(event.reason))
      .map((event) => event.reason);
    expect(reasons).toContain("invalid_motif_id");
    expect(reasons).toContain("invalid_motif_label");
    expect(reasons).toContain("invalid_gap_id");
    expect(reasons).toContain("invalid_gap_label");
  });

  test("deduplicates gap inputs before pairing and still emits truncation telemetry", () => {
    const duplicateGap: EngineOpportunityGap = {
      ...throughputGap,
      label: throughputGap.label,
      score: throughputGap.score - 0.1,
    };
    const result = adjacent_possible({
      hints: [queueMotif],
      gaps: [throughputGap, deliveryReliabilityGap, duplicateGap],
      maxIdeas: 1,
    });

    expect(result.ideas).toHaveLength(1);
    const pairAttempts = result.telemetry.filter((event) => event.step === "pair_attempt");
    expect(pairAttempts).toHaveLength(2);
    expect(result.telemetry.some((event) => event.reason === "duplicate_pair")).toBe(false);
    const truncationTelemetry = result.telemetry.find(
      (event) =>
        event.step === "idea_truncated" &&
        event.gap_id === deliveryReliabilityGap.id &&
        event.reason === "max_ideas_limit",
    );
    expect(truncationTelemetry).toBeTruthy();
  });

  test("deduplicates motif hints and preserves strongest signal plus coverage", () => {
    const weakHint: EngineCommitHistoryHint = {
      ...queueMotif,
      signal: 0.31,
      count: 8,
      gap_ids: ["workforce_throughput_gap"],
    };
    const strongHint: EngineCommitHistoryHint = {
      ...queueMotif,
      signal: 0.9,
      count: 2,
      gap_ids: ["delivery_reliability_gap"],
    };
    const result = adjacent_possible({
      hints: [weakHint, strongHint],
      gaps: [throughputGap],
    });

    expect(result.ideas).toHaveLength(1);
    const motifEvents = result.telemetry.filter(
      (event) => event.step === "motif_screen" && event.motif_id === queueMotif.motif_id,
    );
    expect(motifEvents).toHaveLength(1);
    expect(motifEvents[0]?.metrics?.signal).toBeCloseTo(0.9, 2);
    const idea = result.ideas[0];
    expect(idea.evidence).toContain("coverage_boost=0.08");
  });

  test("scores omit motif objective boosts for unrelated gaps", () => {
    const lowReliabilityGap: EngineOpportunityGap = {
      ...deliveryReliabilityGap,
      score: 0.31,
      label: "Delivery reliability bottleneck",
    };
    const result = adjacent_possible({
      hints: [queueMotif],
      gaps: [lowReliabilityGap],
    });

    expect(result.ideas).toHaveLength(1);
    const idea = result.ideas[0];
    const evidenceMap = idea.evidence.reduce<Record<string, number>>((acc, entry) => {
      const [key, raw] = entry.split("=");
      if (!key || typeof raw === "undefined") return acc;
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) acc[key] = parsed;
      return acc;
    }, {});
    expect(evidenceMap.objective_boost).toBeUndefined();
    expect(evidenceMap.gap_score).toBe(0.31);
    expect(evidenceMap.motif_signal).toBe(0.82);
    expect(evidenceMap.motif_novelty).toBe(0.67);
    expect(evidenceMap.coverage_boost).toBe(0.08);
    const motifNovelty = clamp01(1 - clamp01(queueMotif.count / 12));
    const expectedScore = clamp01(
      0.5 * lowReliabilityGap.score +
        0.3 * queueMotif.signal +
        0.12 * motifNovelty +
        (evidenceMap.coverage_boost ?? 0),
    );
    expect(idea.score).toBeCloseTo(expectedScore, 5);
  });
});
