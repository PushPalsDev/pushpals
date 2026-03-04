import { describe, expect, test } from "bun:test";
import {
  buildEngineFallbackCandidates,
  buildEngineInspirationContext,
  summarizeCommitHistoryHints,
} from "../apps/remotebuddy/src/autonomous_engine";

describe("RemoteBuddy autonomous engine idea generation", () => {
  const vision = {
    one_sentence:
      "Continuously improve autonomous repo delivery with safe, auditable, and high-confidence workflows.",
    key_items: {
      target_users: ["Engineering leads", "OSS maintainers"],
      priorities: [
        "Startup and environment stability",
        "Worker reliability under conflict/retry scenarios",
        "Activation: first PR in under 30 minutes",
      ],
      objectives: [
        "Reliable autonomous delivery loop",
        "High-confidence review and merge automation",
        "Workforce-grade delegation",
      ],
      guardrails: ["Safe by default", "Small reversible steps", "No silent scope escalation"],
      constraints: ["Predictable runtime behavior", "Audit trails", "Avoid operational toil expansion"],
      non_goals: ["Unbounded autonomous architecture redesign"],
      metrics: [
        "Autonomous merge rate",
        "Rework rate",
        "Queue health",
        "Time-to-first-value",
      ],
      risk_policy: ["Low risk can ship autonomously", "High risk requires explicit approval"],
      operating_model: ["RemoteAgent delegates to specialized WorkerPals"],
      governance: ["RFC for high-risk architecture changes"],
    },
    section_numbers: ["0", "4", "6", "7", "8"],
  };

  const snapshot = {
    top_signals: [
      { signal_id: "sig_queue", type: "queue_health", value: 0.82, evidence: "queue_p95=210000" },
      { signal_id: "sig_regret", type: "regret_signal", value: 0.7, evidence: "reopened=4" },
      { signal_id: "sig_test", type: "test_failure", value: 0.45, evidence: "flaky tests recurring" },
    ],
    state_traits: [
      {
        trait_id: "queue_latency_high",
        category: "weakness",
        focus: "queue",
        score: 0.78,
        evidence: "request queue p95 above SLO",
      },
      {
        trait_id: "merge_rework_high",
        category: "risk",
        focus: "merge",
        score: 0.71,
        evidence: "review churn and conflict loops",
      },
      {
        trait_id: "policy_scope_ambiguity",
        category: "risk",
        focus: "policy",
        score: 0.62,
        evidence: "scope ambiguity across worker tasks",
      },
    ],
    open_objectives: Array.from({ length: 6 }).map((_, i) => ({
      objective_id: `obj_${i}`,
      pattern_key: `pattern_${i}`,
      status: "dispatched",
    })),
    dispatch_budget: {
      global_count_last_hour: 4,
      by_type_count_last_hour: {
        feature_small: 1,
        feature_medium: 0,
      },
    },
  };

  test("buildEngineInspirationContext compiles weighted objectives, gaps, and sorted building blocks", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    expect(context.compiled_objectives.length).toBeGreaterThan(0);
    expect(context.opportunity_gaps.length).toBeGreaterThan(0);
    expect(context.building_blocks.length).toBeGreaterThan(0);
    expect(
      context.compiled_objectives.some((objective) => objective.id === "reliable_autonomous_delivery"),
    ).toBe(true);
    expect(
      context.building_blocks.some((block) => block.algorithm === "portfolio_bandit"),
    ).toBe(true);
    expect(context.building_blocks[0].score).toBeGreaterThanOrEqual(
      context.building_blocks[context.building_blocks.length - 1].score,
    );
  });

  test("buildEngineFallbackCandidates produces scoped actionable candidate seeds", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    const candidates = buildEngineFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: vision.section_numbers,
      maxCandidates: 3,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(3);

    for (const candidate of candidates) {
      const objectiveType = String(candidate.objective_type ?? "");
      const triggerType = String(candidate.trigger_type ?? "");
      const validation = Array.isArray(candidate.expected_validation)
        ? candidate.expected_validation.map((value) => String(value))
        : [];
      const targetPaths = Array.isArray(candidate.target_paths) ? candidate.target_paths : [];
      const sectionRefs = Array.isArray(candidate.vision_section_refs)
        ? candidate.vision_section_refs
        : [];
      expect(
        [
          "flaky_test",
          "lint_fix",
          "type_fix",
          "small_refactor",
          "feature_small",
          "feature_medium",
          "feature_large",
          "docs",
          "dep_bump",
        ].includes(objectiveType),
      ).toBe(true);
      expect(
        ["test_failure", "lint_failure", "typecheck_failure", "queue_health", "regret_signal"].includes(
          triggerType,
        ),
      ).toBe(true);
      expect(targetPaths.length).toBeGreaterThan(0);
      expect(sectionRefs.length).toBeGreaterThan(0);
      expect(validation.length).toBeGreaterThan(0);
      expect(validation.every((command) => command.startsWith("bun "))).toBe(true);
    }
  });

  test("buildEngineInspirationContext merges external inspiration patterns with source attribution", () => {
    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      inspirationPatterns: [
        {
          id: "ext_repo_1",
          sourceType: "external_repo",
          sourceLabel: "acme/autonomy-lab",
          sourceUrl: "https://example.com/acme/autonomy-lab",
          sourceRefs: ["README#queue-bandit"],
          algorithm: "queue_portfolio_bandit",
          whenToUse: "queue backpressure and worker saturation are recurring",
          summary: "Allocate autonomous work across lanes using queue pressure + regret loops.",
          tags: ["queue", "backpressure", "worker", "portfolio"],
          qualityScore: 0.92,
          freshnessScore: 0.81,
          seenCount: 7,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
      ],
    });
    expect(context.source_patterns.length).toBe(1);
    const externalBlock = context.building_blocks.find((entry) => entry.id.startsWith("insp_"));
    expect(externalBlock).toBeDefined();
    expect(externalBlock?.algorithm).toBe("queue_portfolio_bandit");
    expect(externalBlock?.source_type).toBe("external_repo");
    expect(externalBlock?.candidate_shape.component_area).toBe("apps/server");
    expect(externalBlock?.score ?? 0).toBeGreaterThan(0.2);
  });

  test("summarizeCommitHistoryHints extracts recurring local motifs", () => {
    const hints = summarizeCommitHistoryHints([
      "autonomy: queue backpressure guardrail for worker saturation",
      "server: queue p95 telemetry + dispatch throttling",
      "merge conflict retry handling for autonomous PRs",
      "policy: scope guardrail validation hardening",
      "tests: flaky retry stabilization for integration jobs",
    ]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((entry) => entry.motif_id === "queue_backpressure")).toBe(true);
    const queue = hints.find((entry) => entry.motif_id === "queue_backpressure");
    expect(queue?.count).toBe(2);
    expect((queue?.sample_subjects ?? []).length).toBeGreaterThan(0);
  });
});
