import { describe, expect, test } from "bun:test";

import {
  adjacent_possible,
  extractQueueTelemetryFromSignals,
  type EngineCommitHistoryHint,
  type EngineOpportunityGap,
} from "./autonomous_engine";

function makeBaseMotifs(): EngineCommitHistoryHint[] {
  return [
    {
      motif_id: "queue_backpressure",
      label: "Queue backpressure and throughput",
      count: 6,
      signal: 0.82,
      objective_ids: ["workforce_scaling"],
      gap_ids: ["workforce_throughput_gap", "delivery_reliability_gap"],
      sample_subjects: ["autonomy: queue guardrail tuning"],
    },
    {
      motif_id: "merge_rework_loop",
      label: "Merge/rework loop hardening",
      count: 4,
      signal: 0.58,
      objective_ids: ["merge_conversion_and_rework"],
      gap_ids: ["merge_rework_gap"],
      sample_subjects: ["server: PR review conflict handling"],
    },
  ];
}

function makeBaseGaps(): EngineOpportunityGap[] {
  return [
    {
      id: "workforce_throughput_gap",
      label: "Workforce throughput gap",
      score: 0.74,
      evidence: ["queue_signal=0.8"],
    },
    {
      id: "merge_rework_gap",
      label: "Merge/rework gap",
      score: 0.61,
      evidence: ["regret_signal=0.6"],
    },
    {
      id: "activation_gap",
      label: "Activation/onboarding gap",
      score: 0.52,
      evidence: ["dispatch_saturation=0.5"],
    },
  ];
}

function makeExploreMotifs(): EngineCommitHistoryHint[] {
  return [
    {
      motif_id: "steady_merge",
      label: "High-signal merge hardening",
      count: 5,
      signal: 0.91,
      objective_ids: ["merge_conversion_and_rework"],
      gap_ids: ["merge_rework_gap"],
      sample_subjects: ["server: deterministic merge plans"],
    },
    {
      motif_id: "activation_push",
      label: "Activation fast start",
      count: 2,
      signal: 0.34,
      objective_ids: ["activation_goals"],
      gap_ids: ["activation_gap"],
      sample_subjects: ["activation: workerpal onboarding boosts"],
    },
  ];
}

function makeExploreGaps(): EngineOpportunityGap[] {
  return [
    {
      id: "activation_gap",
      label: "Activation/onboarding gap",
      score: 0.92,
      evidence: ["activation_trait=0.9"],
    },
    {
      id: "merge_rework_gap",
      label: "Merge/rework gap",
      score: 0.38,
      evidence: ["merge_trait=0.4"],
    },
  ];
}

function makeGuardrailMotifs(): EngineCommitHistoryHint[] {
  return [
    {
      motif_id: "queue_backpressure",
      label: "Queue backpressure and throughput",
      count: 6,
      signal: 0.76,
      objective_ids: ["workforce_scaling"],
      gap_ids: ["workforce_throughput_gap", "delivery_reliability_gap"],
      sample_subjects: ["workerpal queue triage"],
    },
    {
      motif_id: "risk_cleanup",
      label: "Governance/risk cleanup",
      count: 3,
      signal: 0.51,
      objective_ids: ["policy_guardrails"],
      gap_ids: ["governance_gap"],
      sample_subjects: ["policy: scope guardrails"],
    },
  ];
}

function makeGuardrailGaps(): EngineOpportunityGap[] {
  return [
    {
      id: "governance_gap",
      label: "Governance guardrail gap",
      score: 0.58,
      evidence: ["governance_trait=0.6"],
    },
    {
      id: "merge_rework_gap",
      label: "Merge/rework gap",
      score: 0.54,
      evidence: ["regret_signal=0.55"],
    },
  ];
}

export function registerAdjacentPossibleTestSuite() {
  describe("adjacent_possible", () => {
    test("recombines proven motifs with bottlenecks and emits structured telemetry", () => {
      const result = adjacent_possible({
        motifs: makeBaseMotifs(),
        opportunityGaps: makeBaseGaps(),
        queueTelemetry: { signal: 0.48, p95Ms: 140_000, pending: 64 },
        guardrails: { maxQueueSignal: 0.9, maxQueueP95Ms: 240_000, maxPending: 180 },
        exploration: { baseWeight: 0.36, minWeight: 0.2, maxWeight: 0.6 },
      });
      expect(result.guardrailEngaged).toBe(false);
      expect(result.mixes.length).toBeGreaterThan(0);
      const queueMix = result.mixes.find((mix) => mix.motif_id === "queue_backpressure");
      expect(queueMix?.gap_id).toBe("workforce_throughput_gap");
      expect(queueMix?.guardrail_blocked).toBe(false);
      expect(queueMix?.guardrail_state).toBe("ready");
      const telemetryEvent = result.telemetry.find((event) => event.stage === "mix");
      expect(telemetryEvent).toBeDefined();
      if (telemetryEvent) {
        const data = telemetryEvent.data as Record<string, unknown>;
        expect(typeof data.exploration_weight).toBe("number");
        expect(Number(data.exploration_weight)).toBeCloseTo(result.explorationWeight, 2);
        expect(typeof data.queue_pressure).toBe("number");
      }
      expect(
        result.telemetry.some(
          (event) => event.stage === "guardrail" && event.message === "queue_guardrail_clear",
        ),
      ).toBe(true);
    });

    test("exploration weight reranks mixes between exploitation and exploration", () => {
      const exploitationFirst = adjacent_possible({
        motifs: makeExploreMotifs(),
        opportunityGaps: makeExploreGaps(),
        queueTelemetry: { signal: 0.12, p95Ms: 90_000, pending: 22 },
        guardrails: { maxQueueSignal: 0.9, maxQueueP95Ms: 240_000, maxPending: 180 },
        exploration: { baseWeight: 0.2, minWeight: 0.15, maxWeight: 0.3 },
      });
      const explorationFirst = adjacent_possible({
        motifs: makeExploreMotifs(),
        opportunityGaps: makeExploreGaps(),
        queueTelemetry: { signal: 0.12, p95Ms: 90_000, pending: 22 },
        guardrails: { maxQueueSignal: 0.9, maxQueueP95Ms: 240_000, maxPending: 180 },
        exploration: { baseWeight: 0.78, minWeight: 0.6, maxWeight: 0.85 },
      });
      expect(exploitationFirst.explorationWeight).toBeLessThan(explorationFirst.explorationWeight);
      expect(exploitationFirst.mixes[0]?.motif_id).toBe("steady_merge");
      expect(explorationFirst.mixes[0]?.motif_id).toBe("activation_push");
    });

    test("engages queue guardrails and blocks mixes ignoring queue relief", () => {
      const result = adjacent_possible({
        motifs: makeGuardrailMotifs(),
        opportunityGaps: makeGuardrailGaps(),
        queueTelemetry: { signal: 0.95, p95Ms: 260_000, pending: 220 },
        guardrails: { maxQueueSignal: 0.8, maxQueueP95Ms: 200_000, maxPending: 180 },
        exploration: { baseWeight: 0.44, guardrailPenalty: 0.22 },
      });
      expect(result.guardrailEngaged).toBe(true);
      expect(result.explorationWeight).toBeLessThan(0.3);
      expect(result.mixes.length).toBe(0);
      expect(
        result.telemetry.some(
          (event) => event.stage === "guardrail" && event.message === "queue_guardrail_engaged",
        ),
      ).toBe(true);
      expect(
        result.telemetry.some(
          (event) => event.stage === "mix" && event.message === "mix_guardrailed",
        ),
      ).toBe(true);
      expect(
        result.telemetry.some(
          (event) =>
            event.stage === "guardrail" && event.message === "guardrail_blocked_candidates_dropped",
        ),
      ).toBe(true);
      const dropEvent = result.telemetry.find(
        (event) =>
          event.stage === "guardrail" && event.message === "guardrail_blocked_candidates_dropped",
      );
      expect(dropEvent).toBeDefined();
      if (dropEvent) {
        const data = dropEvent.data as Record<string, unknown>;
        expect(Number(data.blocked)).toBeGreaterThan(0);
      }
    });

    test("prioritizes queue relief mixes when guardrail engaged despite other strong signals", () => {
      const result = adjacent_possible({
        motifs: [
          ...makeGuardrailMotifs(),
          {
            motif_id: "merge_hardening_peak",
            label: "Merge hardening peak signal",
            count: 7,
            signal: 0.93,
            objective_ids: ["merge_conversion_and_rework"],
            gap_ids: ["merge_rework_gap"],
            sample_subjects: ["merge: bugsnag + preflight hardening"],
          },
        ],
        opportunityGaps: [
          {
            id: "governance_gap",
            label: "Governance guardrail gap",
            score: 0.88,
            evidence: ["governance_trait=0.88"],
          },
          {
            id: "merge_rework_gap",
            label: "Merge/rework gap",
            score: 0.81,
            evidence: ["regret_signal=0.82"],
          },
          {
            id: "risk_surface_gap",
            label: "Risk surface gap",
            score: 0.79,
            evidence: ["risk_trait=0.8"],
          },
          {
            id: "workforce_throughput_gap",
            label: "Workforce throughput gap",
            score: 0.52,
            evidence: ["queue_signal=0.9"],
          },
        ],
        queueTelemetry: { signal: 0.96, p95Ms: 280_000, pending: 260 },
        guardrails: { maxQueueSignal: 0.75, maxQueueP95Ms: 200_000, maxPending: 180 },
        exploration: { baseWeight: 0.52, guardrailPenalty: 0.21 },
      });
      expect(result.guardrailEngaged).toBe(true);
      expect(result.mixes.length).toBeGreaterThan(0);
      const queueMix = result.mixes[0];
      expect(queueMix?.gap_id).toBe("workforce_throughput_gap");
      expect(queueMix?.guardrail_blocked).toBe(false);
      expect(result.mixes.every((mix) => mix.guardrail_blocked === false)).toBe(true);
      expect(result.mixes.every((mix) => mix.guardrail_state === "ready")).toBe(true);
      expect(
        result.telemetry.some(
          (event) =>
            event.stage === "guardrail" && event.message === "guardrail_blocked_candidates_dropped",
        ),
      ).toBe(true);
    });

    test("allows blocked fallback only when explicitly overridden", () => {
      const result = adjacent_possible({
        motifs: makeGuardrailMotifs(),
        opportunityGaps: makeGuardrailGaps(),
        queueTelemetry: { signal: 0.95, p95Ms: 260_000, pending: 220 },
        guardrails: {
          maxQueueSignal: 0.8,
          maxQueueP95Ms: 200_000,
          maxPending: 180,
          allowBlockedFallback: true,
        },
        exploration: { baseWeight: 0.44, guardrailPenalty: 0.22 },
      });
      expect(result.guardrailEngaged).toBe(true);
      expect(result.mixes.length).toBeGreaterThan(0);
      expect(result.mixes.every((mix) => mix.guardrail_state === "demoted_allowed")).toBe(true);
      expect(result.mixes.every((mix) => mix.guardrail_blocked === false)).toBe(true);
      expect(
        result.mixes.every((mix) =>
          mix.evidence.some((entry) => entry.startsWith("guardrail_demoted=")),
        ),
      ).toBe(true);
      expect(
        result.telemetry.some(
          (event) =>
            event.stage === "guardrail" &&
            event.message === "guardrail_demoted_blocked_candidates",
        ),
      ).toBe(true);
    });

    test("enforces gap diversity before filling duplicate mixes", () => {
      const motifs: EngineCommitHistoryHint[] = [
        {
          motif_id: "queue_load_a",
          label: "Queue load motif A",
          count: 6,
          signal: 0.92,
          objective_ids: ["workforce_scaling"],
          gap_ids: ["workforce_throughput_gap"],
          sample_subjects: ["queue: load shedding burst"],
        },
        {
          motif_id: "queue_load_b",
          label: "Queue load motif B",
          count: 5,
          signal: 0.88,
          objective_ids: ["workforce_scaling"],
          gap_ids: ["workforce_throughput_gap"],
          sample_subjects: ["queue: latency burst"],
        },
        {
          motif_id: "merge_precision",
          label: "Merge precision motif",
          count: 5,
          signal: 0.81,
          objective_ids: ["merge_conversion_and_rework"],
          gap_ids: ["merge_rework_gap"],
          sample_subjects: ["merge: deterministic preflight"],
        },
        {
          motif_id: "activation_jump",
          label: "Activation jumpstart motif",
          count: 4,
          signal: 0.77,
          objective_ids: ["mass_audience_activation"],
          gap_ids: ["activation_gap"],
          sample_subjects: ["activation: onboarding fast track"],
        },
        {
          motif_id: "governance_watch",
          label: "Governance watch motif",
          count: 3,
          signal: 0.7,
          objective_ids: ["policy_and_governance"],
          gap_ids: ["governance_gap"],
          sample_subjects: ["governance: policy audit"],
        },
      ];
      const opportunityGaps: EngineOpportunityGap[] = [
        {
          id: "workforce_throughput_gap",
          label: "Workforce throughput gap",
          score: 0.9,
          evidence: ["queue_signal=0.9"],
        },
        {
          id: "merge_rework_gap",
          label: "Merge/rework gap",
          score: 0.82,
          evidence: ["regret_signal=0.82"],
        },
        {
          id: "activation_gap",
          label: "Activation/onboarding gap",
          score: 0.78,
          evidence: ["activation_trait=0.8"],
        },
        {
          id: "governance_gap",
          label: "Governance guardrail gap",
          score: 0.71,
          evidence: ["governance_trait=0.72"],
        },
        {
          id: "delivery_reliability_gap",
          label: "Delivery reliability gap",
          score: 0.65,
          evidence: ["failure_signal=0.6"],
        },
      ];
      const result = adjacent_possible({
        motifs,
        opportunityGaps,
        queueTelemetry: { signal: 0.3, p95Ms: 90_000, pending: 34 },
        guardrails: { maxQueueSignal: 0.95, maxQueueP95Ms: 260_000, maxPending: 280 },
        exploration: { baseWeight: 0.28, minWeight: 0.2, maxWeight: 0.4 },
      });
      expect(result.mixes.length).toBe(4);
      const gapIds = result.mixes.map((mix) => mix.gap_id);
      expect(new Set(gapIds).size).toBe(gapIds.length);
      expect(gapIds).toContain("governance_gap");
      expect(gapIds).toContain("activation_gap");
      expect(
        result.telemetry.some(
          (event) => event.stage === "mix" && event.message === "mix_gap_diversity_enforced",
        ),
      ).toBe(true);
    });

    test("repairs exploration bounds and emits telemetry when config invalid", () => {
      const result = adjacent_possible({
        motifs: makeBaseMotifs(),
        opportunityGaps: makeBaseGaps(),
        queueTelemetry: { signal: 0.34, p95Ms: 120_000, pending: 32 },
        guardrails: { maxQueueSignal: 0.95, maxQueueP95Ms: 250_000, maxPending: 200 },
        exploration: { baseWeight: 0.95, minWeight: 0.82, maxWeight: 0.18 },
      });
      const repairEvent = result.telemetry.find(
        (event) => event.stage === "input" && event.message === "exploration_config_repaired",
      );
      expect(repairEvent).toBeDefined();
      if (repairEvent) {
        const data = repairEvent.data as Record<string, any>;
        const normalized = data.normalized as Record<string, number>;
        expect(normalized.minWeight).toBeLessThanOrEqual(normalized.maxWeight);
        expect(result.explorationWeight).toBeGreaterThanOrEqual(normalized.minWeight);
        expect(result.explorationWeight).toBeLessThanOrEqual(normalized.maxWeight);
      }
    });

    test("emits queue telemetry warning events when warnings supplied", () => {
      const result = adjacent_possible({
        motifs: makeBaseMotifs(),
        opportunityGaps: makeBaseGaps(),
        queueTelemetry: {
          signal: 0.44,
          p95Ms: 150_000,
          pending: 48,
          warnings: ["queue_p95_ms parsed from evidence"],
          source: "evidence",
        },
        guardrails: { maxQueueSignal: 0.9, maxQueueP95Ms: 250_000, maxPending: 200 },
        exploration: { baseWeight: 0.35 },
      });
      expect(
        result.telemetry.some(
          (event) => event.stage === "input" && event.message === "queue_telemetry_warning",
        ),
      ).toBe(true);
    });
  });

  describe("extractQueueTelemetryFromSignals", () => {
    test("prefers schema provided queue telemetry when metadata exists", () => {
      const telemetry = extractQueueTelemetryFromSignals([
        {
          signal_id: "sig_queue",
          type: "queue_health",
          value: 0.7,
          evidence: "queue_p95=210000 queue_pending=60",
          metadata: { queue_p95_ms: 190_000, queue_pending: 36 },
        } as any,
      ]);
      expect(telemetry.p95Ms).toBe(190_000);
      expect(telemetry.pending).toBe(36);
      expect(telemetry.source).toBe("schema");
      expect(telemetry.warnings ?? []).toHaveLength(0);
    });

    test("falls back to evidence parsing and emits warnings when schema missing", () => {
      const telemetry = extractQueueTelemetryFromSignals([
        {
          signal_id: "sig_queue",
          type: "queue_health",
          value: 0.65,
          evidence: "queue_p95=210000 queue_pending=80",
        } as any,
      ]);
      expect(telemetry.p95Ms).toBe(210_000);
      expect(telemetry.pending).toBe(80);
      expect(telemetry.source).toBe("evidence");
      expect(telemetry.warnings?.length).toBeGreaterThanOrEqual(1);
    });
  });
}

if (import.meta.main) {
  registerAdjacentPossibleTestSuite();
}
