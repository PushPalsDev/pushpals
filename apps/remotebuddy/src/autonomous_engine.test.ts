import { describe, expect, test } from "bun:test";
import {
  ENGINE_DIVERSITY_MAX_ADJACENCY_ROWS,
  ENGINE_DIVERSITY_MAX_MOTIF_ROWS,
  ensureEngineDiversityMetrics,
} from "./autonomous_engine";

const KNOWN_MOTIFS = [
  "queue_backpressure",
  "merge_rework_loop",
  "startup_stability",
  "policy_guardrails",
  "test_flake_reliability",
];
const UPDATED_AT_SENTINEL = "1970-01-01T00:00:00.000Z";

describe("ensureEngineDiversityMetrics", () => {
  test("returns safe defaults for empty inputs", () => {
    const metrics = ensureEngineDiversityMetrics(null);
    expect(metrics.window_minutes).toBe(0);
    expect(metrics.motif_metrics).toHaveLength(0);
    expect(metrics.adjacency_pool).toHaveLength(0);
    expect(metrics.truncated).toBe(false);
    expect(metrics.updated_at).toBe(UPDATED_AT_SENTINEL);
  });

  test("falls back to deterministic sentinel when upstream timestamp is invalid", () => {
    const metrics = ensureEngineDiversityMetrics({ updated_at: "not-a-date" });
    expect(metrics.updated_at).toBe(UPDATED_AT_SENTINEL);
  });

  test("clamps invalid numeric values to safe ranges", () => {
    const metrics = ensureEngineDiversityMetrics({
      window_minutes: 999_999,
      updated_at: "2025-12-31T12:34:56Z",
      motif_metrics: [
        {
          motif_id: "queue_backpressure",
          sample_count: -12,
          novelty_ratio: 99,
          regret_ratio: -10,
          tuning_weight: Number.POSITIVE_INFINITY,
        },
      ],
      adjacency_pool: [
        {
          motif_id: "queue_backpressure",
          neighbor_motif_id: "merge_rework_loop",
          sample_overlap: Number.POSITIVE_INFINITY,
          novelty_delta: 5,
          regret_delta: -9,
          tuning_weight: Number.NaN,
        },
      ],
    });

    expect(metrics.window_minutes).toBe(14 * 24 * 60);
    expect(metrics.updated_at).toBe("2025-12-31T12:34:56.000Z");
    expect(metrics.motif_metrics).toHaveLength(1);
    expect(metrics.adjacency_pool).toHaveLength(1);

    const motif = metrics.motif_metrics[0];
    expect(motif.sample_count).toBe(0);
    expect(motif.novelty_ratio).toBe(1);
    expect(motif.regret_ratio).toBe(0);
    expect(motif.tuning_weight).toBe(1);

    const adjacency = metrics.adjacency_pool[0];
    expect(adjacency.sample_overlap).toBe(50_000);
    expect(adjacency.novelty_delta).toBe(1);
    expect(adjacency.regret_delta).toBe(-1);
    expect(adjacency.tuning_weight).toBe(1);
  });

  test("rejects non-numeric primitive coercions in motifs and adjacency entries", () => {
    const metrics = ensureEngineDiversityMetrics({
      window_minutes: true,
      motif_metrics: [
        {
          motif_id: "queue_backpressure",
          sample_count: true,
          novelty_ratio: "",
          regret_ratio: {},
          tuning_weight: [],
        },
      ],
      adjacency_pool: [
        {
          motif_id: "queue_backpressure",
          neighbor_motif_id: "merge_rework_loop",
          sample_overlap: true,
          novelty_delta: "",
          regret_delta: {},
          tuning_weight: true,
        },
        {
          motif_id: "merge_rework_loop",
          neighbor_motif_id: "startup_stability",
          sample_overlap: "12.8",
          novelty_delta: "-2.5",
          regret_delta: "3.5",
          tuning_weight: "0.25",
        },
      ],
    });

    expect(metrics.window_minutes).toBe(0);

    const motif = metrics.motif_metrics[0];
    expect(motif.sample_count).toBe(0);
    expect(motif.novelty_ratio).toBe(0);
    expect(motif.regret_ratio).toBe(0);
    expect(motif.tuning_weight).toBe(0);

    const invalidAdjacency = metrics.adjacency_pool.find(
      (entry) => entry.motif_id === "queue_backpressure",
    );
    const validAdjacency = metrics.adjacency_pool.find(
      (entry) => entry.motif_id === "merge_rework_loop",
    );
    expect(invalidAdjacency?.sample_overlap).toBe(0);
    expect(invalidAdjacency?.novelty_delta).toBe(0);
    expect(invalidAdjacency?.regret_delta).toBe(0);
    expect(invalidAdjacency?.tuning_weight).toBe(0);

    expect(validAdjacency?.sample_overlap).toBe(12);
    expect(validAdjacency?.novelty_delta).toBe(-1);
    expect(validAdjacency?.regret_delta).toBe(1);
    expect(validAdjacency?.tuning_weight).toBe(1);
  });

  test("drops motif and adjacency entries without matching rules", () => {
    const metrics = ensureEngineDiversityMetrics({
      motif_metrics: [
        {
          motif_id: "unknown_motif",
          sample_count: 100,
          novelty_ratio: 0.5,
          regret_ratio: 0.5,
        },
        {
          motif_id: "queue_backpressure",
          sample_count: 7,
          novelty_ratio: 0.4,
          regret_ratio: 0.3,
          tuning_weight: 0.2,
        },
      ],
      adjacency_pool: [
        {
          motif_id: "unknown_motif",
          neighbor_motif_id: "queue_backpressure",
          sample_overlap: 3,
          tuning_weight: 1,
        },
        {
          motif_id: "queue_backpressure",
          neighbor_motif_id: "merge_rework_loop",
          sample_overlap: 2,
          tuning_weight: 1,
        },
      ],
    });

    expect(metrics.motif_metrics).toHaveLength(1);
    expect(metrics.motif_metrics[0].motif_id).toBe("queue_backpressure");
    expect(metrics.adjacency_pool).toHaveLength(1);
    expect(metrics.adjacency_pool[0].motif_id).toBe("queue_backpressure");
    expect(metrics.truncated).toBe(false);
    expect(metrics.adjacency_pool[0].tuning_weight).toBe(1);
  });

  test("enforces truncation limits and normalizes adjacency weights", () => {
    const motifMetrics = Array.from({ length: ENGINE_DIVERSITY_MAX_MOTIF_ROWS + 8 }, (_, idx) => ({
      motif_id: KNOWN_MOTIFS[idx % KNOWN_MOTIFS.length],
      sample_count: 200 - idx,
      novelty_ratio: (idx % 10) / 10,
      regret_ratio: ((idx + 3) % 10) / 10,
      tuning_weight: idx + 1,
    }));
    const adjacencyPool = Array.from({ length: ENGINE_DIVERSITY_MAX_ADJACENCY_ROWS + 12 }, (_, idx) => ({
      motif_id: KNOWN_MOTIFS[idx % KNOWN_MOTIFS.length],
      neighbor_motif_id: KNOWN_MOTIFS[(idx + 1) % KNOWN_MOTIFS.length],
      sample_overlap: 100 + idx,
      novelty_delta: 0.25,
      regret_delta: -0.2,
      tuning_weight: idx + 1,
    }));

    const metrics = ensureEngineDiversityMetrics({
      motif_metrics: motifMetrics,
      adjacency_pool: adjacencyPool,
    });

    expect(metrics.motif_metrics.length).toBe(ENGINE_DIVERSITY_MAX_MOTIF_ROWS);
    expect(metrics.adjacency_pool.length).toBe(ENGINE_DIVERSITY_MAX_ADJACENCY_ROWS);
    expect(metrics.truncated).toBe(true);
    expect(metrics.motif_metrics[0].sample_count).toBeGreaterThan(
      metrics.motif_metrics[metrics.motif_metrics.length - 1].sample_count,
    );
    const weightSum = metrics.adjacency_pool.reduce((sum, row) => sum + row.tuning_weight, 0);
    expect(weightSum).toBeCloseTo(1, 6);
  });

  test("normalizes adjacency weights deterministically even when order changes", () => {
    const adjacencyPool = [
      {
        motif_id: "queue_backpressure",
        neighbor_motif_id: "merge_rework_loop",
        sample_overlap: 20,
        novelty_delta: 0.2,
        regret_delta: -0.2,
        tuning_weight: 1,
      },
      {
        motif_id: "merge_rework_loop",
        neighbor_motif_id: "startup_stability",
        sample_overlap: 20,
        novelty_delta: 0.2,
        regret_delta: -0.2,
        tuning_weight: 1,
      },
      {
        motif_id: "startup_stability",
        neighbor_motif_id: "policy_guardrails",
        sample_overlap: 20,
        novelty_delta: 0.2,
        regret_delta: -0.2,
        tuning_weight: 1,
      },
    ];

    const metricsA = ensureEngineDiversityMetrics({ adjacency_pool: adjacencyPool });
    const metricsB = ensureEngineDiversityMetrics({ adjacency_pool: [...adjacencyPool].reverse() });

    const toMap = (metrics: typeof metricsA) =>
      new Map(metrics.adjacency_pool.map((entry) => [`${entry.motif_id}->${entry.neighbor_motif_id}`, entry.tuning_weight]));

    const mapA = toMap(metricsA);
    const mapB = toMap(metricsB);

    expect([...mapA.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);
    expect([...mapB.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 6);

    for (const [key, weight] of mapA.entries()) {
      expect(mapB.get(key)).toBe(weight);
      expect(weight).toBeCloseTo(1 / 3, 5);
    }
  });
});
