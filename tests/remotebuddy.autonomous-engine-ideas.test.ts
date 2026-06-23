import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildEngineFallbackCandidates,
  buildEngineInspirationContext,
  buildRepoVisionFallbackCandidates,
  containsPushPalsInternalUserRepoText,
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
      constraints: [
        "Predictable runtime behavior",
        "Audit trails",
        "Avoid operational toil expansion",
      ],
      non_goals: ["Unbounded autonomous architecture redesign"],
      metrics: ["Autonomous merge rate", "Rework rate", "Queue health", "Time-to-first-value"],
      testing_criteria: ["bun run test:root"],
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
      {
        signal_id: "sig_test",
        type: "test_failure",
        value: 0.45,
        evidence: "flaky tests recurring",
      },
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

  test("detects internal PushPals failure labels before user-repo dispatch", () => {
    expect(
      containsPushPalsInternalUserRepoText(
        "Treat artifact_only_no_publishable_patch as explicit delivery evidence.",
      ),
    ).toBe(true);
    expect(
      containsPushPalsInternalUserRepoText(
        "Add no-reviewable-patch coverage for QualityGate failures.",
      ),
    ).toBe(true);
    expect(
      containsPushPalsInternalUserRepoText(
        "Make the app review path expose selected player actions clearly.",
      ),
    ).toBe(false);
  });

  test("buildEngineInspirationContext compiles weighted objectives, gaps, and sorted building blocks", () => {
    const context = buildEngineInspirationContext({ vision, snapshot });
    expect(context.compiled_objectives.length).toBeGreaterThan(0);
    expect(context.opportunity_gaps.length).toBeGreaterThan(0);
    expect(context.building_blocks.length).toBeGreaterThan(0);
    expect(
      context.compiled_objectives.some(
        (objective) => objective.id === "reliable_autonomous_delivery",
      ),
    ).toBe(true);
    expect(context.building_blocks.some((block) => block.algorithm === "portfolio_bandit")).toBe(
      true,
    );
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
        [
          "test_failure",
          "lint_failure",
          "typecheck_failure",
          "queue_health",
          "regret_signal",
        ].includes(triggerType),
      ).toBe(true);
      expect(targetPaths.length).toBeGreaterThan(0);
      expect(sectionRefs.length).toBeGreaterThan(0);
      expect(validation.length).toBeGreaterThan(0);
      expect(validation.every((command) => command.startsWith("bun "))).toBe(true);
    }
  });

  test("repo vision fallback preserves repo-native priority headings before meta engine work", () => {
    const sectorVision = {
      one_sentence:
        "The game is a fast, readable real-time planet conquest experience with short high-pressure matches.",
      key_items: {
        target_users: ["Players who want readable real-time strategy without RTS control burden"],
        priorities: [
          "Improve battlefield readability during heavier action",
          "Make the player control panel clearer, faster, and harder to misuse",
          "Strengthen onboarding for expand, defend, and win behavior",
          "Polish the game shell so it matches the in-match quality bar",
          "Make web delivery and navigation trustworthy",
          "Preserve performance while effects, units, and shell polish increase",
          "Add the vision_compiler building block to the active repo autonomy loop",
        ],
        objectives: [
          "Sharpen the core match presentation",
          "Tighten player decision surfaces",
          "Make the web review path easy to trust",
          "Use vision_compiler to keep autonomous delivery aligned",
        ],
        guardrails: [
          "Protect readability before adding spectacle",
          "Keep critical actions accessible in one click or tap",
        ],
        constraints: [
          "Desktop and smaller touch-device usability both matter",
          "Browser validation is required for UI-affecting work",
        ],
        non_goals: ["Bloated RTS systems that slow the core loop"],
        metrics: [
          "Battlefield remains readable during high-action moments",
          "Browser smoke coverage exercises the main shell path",
        ],
        testing_criteria: ["bun run test:root", "bun run smoke:web"],
        risk_policy: ["Do not ship visual changes that make the battlefield harder to parse"],
        operating_model: ["Worker agents should validate rendered UI for UI-affecting work"],
        governance: ["Source of truth is the match-quality north star"],
      },
      section_numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    };
    const repoTargets = [
      {
        component_area: "app",
        target_paths: ["app/autonomyGraph.ts"],
        write_globs: ["app/autonomyGraph.ts"],
        label: "app/autonomyGraph.ts",
        keywords: ["app", "autonomy", "graph"],
      },
      {
        component_area: "app",
        target_paths: ["app/game.tsx"],
        write_globs: ["app/game.tsx"],
        label: "app/game.tsx",
        keywords: ["app", "game", "tsx"],
      },
      {
        component_area: "app/__tests__",
        target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
        write_globs: ["app/__tests__/_layout.autonomy.test.ts"],
        label: "app/__tests__/_layout.autonomy.test.ts",
        keywords: ["app", "tests", "layout", "autonomy"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: sectorVision,
      snapshot,
      repoTargets,
    });
    const topRepoObjective = context.compiled_repo_objectives[0];
    expect(topRepoObjective.title).toBe("Improve battlefield readability during heavier action");
    expect(topRepoObjective.category).toBe("product_core");

    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: sectorVision.section_numbers,
      repoTargets,
      maxCandidates: 3,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("Improve battlefield readability");
    expect(candidates[0].target_paths).toEqual(["app/game.tsx"]);
    expect(candidates[0].component_area).toBe("app");
    expect(candidates[0].expected_validation).toContain("bun run test:root");
    expect(candidates[0].engine_trial).toBeUndefined();
    expect(String(candidates[0].vision_alignment_reason)).toContain("priority=1");
    expect(
      candidates.some((candidate) =>
        String(candidate.title).includes("vision_compiler building block"),
      ),
    ).toBe(false);
  });

  test("repo vision fallback uses generic heading categories without repo-specific blueprints", () => {
    const genericVision = {
      one_sentence:
        "DocPilot helps teams search, import, and validate shared knowledge with predictable workflows.",
      key_items: {
        target_users: ["Support teams", "Operations leads"],
        priorities: [
          "Improve query answer accuracy for imported documents",
          "Reduce onboarding mistakes in the first workspace setup",
          "Preserve performance during large document imports",
          "Strengthen validation for parser regressions",
        ],
        objectives: [
          "Make search results easier to trust",
          "Keep imports reversible and observable",
        ],
        guardrails: ["Do not hide source citations", "Avoid broad rewrites of parser behavior"],
        constraints: ["Validation must cover import and search flows"],
        non_goals: ["Do not add a new collaboration surface"],
        metrics: ["Answer accuracy improves", "Import validation catches malformed files"],
        testing_criteria: ["bun test tests/parser-regressions.test.ts"],
        risk_policy: ["Parser regressions are release blockers"],
        operating_model: ["Prefer small, test-backed changes"],
        governance: ["Document high-risk parser changes"],
      },
      section_numbers: ["1", "4", "6", "7", "9"],
    };
    const repoTargets = [
      {
        component_area: "src/search",
        target_paths: ["src/search/rankAnswers.ts"],
        write_globs: ["src/search/rankAnswers.ts"],
        label: "src/search/rankAnswers.ts",
        keywords: ["src", "search", "rank", "answers", "query", "accuracy", "documents"],
      },
      {
        component_area: "src/import",
        target_paths: ["src/import/parser.ts"],
        write_globs: ["src/import/parser.ts"],
        label: "src/import/parser.ts",
        keywords: ["src", "import", "parser", "documents", "large"],
      },
      {
        component_area: "tests",
        target_paths: ["tests/parser-regressions.test.ts"],
        write_globs: ["tests/parser-regressions.test.ts"],
        label: "tests/parser-regressions.test.ts",
        keywords: ["tests", "parser", "regressions", "validation"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: genericVision,
      snapshot,
      repoTargets,
    });
    const topRepoObjective = context.compiled_repo_objectives[0];
    expect(topRepoObjective.title).toBe("Improve query answer accuracy for imported documents");
    expect(topRepoObjective.category).toBe("product_core");

    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: genericVision.section_numbers,
      repoTargets,
      maxCandidates: 3,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("Improve query answer accuracy");
    expect(candidates[0].target_paths).toEqual(["src/search/rankAnswers.ts"]);
    expect(candidates[0].expected_validation).toContain(
      "bun test tests/parser-regressions.test.ts",
    );
    expect(String(candidates[0].problem_statement)).toContain("repo's own product/domain language");
    expect(candidates[0].engine_trial).toBeUndefined();
  });

  test("repo vision fallback keeps web review work on repo-native web targets", () => {
    const webVision = {
      one_sentence: "The app ships a trustworthy browser-playable product shell.",
      key_items: {
        target_users: ["Players using the web build"],
        priorities: ["Make web delivery and navigation trustworthy"],
        objectives: ["Make the web review path easy to trust"],
        guardrails: ["Keep user-repo work focused on app behavior"],
        constraints: ["Browser validation is required for UI-affecting work"],
        non_goals: ["Do not add PushPals-internal autonomy concepts to the app"],
        metrics: ["Browser smoke coverage exercises the main shell path"],
        testing_criteria: ["bun run web:e2e"],
        risk_policy: ["Low-risk shell validation changes can ship autonomously"],
        operating_model: ["Workers should use repo-native validation"],
        governance: ["Review coverage should describe product behavior"],
      },
      section_numbers: ["4", "6", "9"],
    };
    const repoTargets = [
      {
        component_area: "app/__tests__",
        target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
        write_globs: ["app/__tests__/_layout.autonomy.test.ts"],
        label: "app/__tests__/_layout.autonomy.test.ts",
        keywords: ["app", "tests", "layout", "autonomy"],
      },
      {
        component_area: "scripts",
        target_paths: ["scripts/test-web-e2e.js"],
        write_globs: ["scripts/test-web-e2e.js"],
        label: "scripts/test-web-e2e.js",
        keywords: ["scripts", "test", "web", "e2e", "browser", "smoke"],
      },
      {
        component_area: "app",
        target_paths: ["app/_layout.tsx"],
        write_globs: ["app/_layout.tsx"],
        label: "app/_layout.tsx",
        keywords: ["app", "layout", "navigation", "shell"],
      },
    ];

    const context = buildEngineInspirationContext({
      vision: webVision,
      snapshot,
      repoTargets,
    });
    const candidates = buildRepoVisionFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: webVision.section_numbers,
      repoTargets,
      maxCandidates: 2,
    });

    expect(candidates.length).toBeGreaterThan(0);
    expect(String(candidates[0].title)).toContain("web delivery");
    expect(candidates[0].target_paths).toEqual(["scripts/test-web-e2e.js"]);
    expect(candidates[0].expected_validation).toContain("bun run web:e2e");
    expect(JSON.stringify(candidates)).not.toContain("_layout.autonomy.test");
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

  test("buildEngineInspirationContext adapts building blocks to generic repo targets", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-ideas-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "autonomy.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "src", "queue.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "tests", "autonomy.test.ts"), "// fixture\n", "utf8");
    writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");

    try {
      const repoTargets = [
        {
          component_area: "src",
          target_paths: ["src/autonomy.ts"],
          write_globs: ["src/autonomy.ts"],
          label: "src/autonomy.ts",
          keywords: ["src", "autonomy", "queue"],
        },
        {
          component_area: "src",
          target_paths: ["src/queue.ts"],
          write_globs: ["src/queue.ts"],
          label: "src/queue.ts",
          keywords: ["src", "queue"],
        },
        {
          component_area: "tests",
          target_paths: ["tests/autonomy.test.ts"],
          write_globs: ["tests/autonomy.test.ts"],
          label: "tests/autonomy.test.ts",
          keywords: ["tests", "autonomy"],
        },
      ];
      const context = buildEngineInspirationContext({
        vision,
        snapshot,
        repoRoot: root,
        repoTargets,
        inspirationPatterns: [
          {
            id: "ext_repo_generic_1",
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

      const opportunityGraphBlock = context.building_blocks.find(
        (entry) => entry.id === "opportunity_graph_pipeline",
      );
      expect(opportunityGraphBlock?.candidate_shape.component_area).toBe("src");
      expect(opportunityGraphBlock?.candidate_shape.target_paths[0]).toContain("src/");
      expect(opportunityGraphBlock?.candidate_shape.target_paths[0]).not.toContain("apps/server");

      const externalBlock = context.building_blocks.find((entry) => entry.id.startsWith("insp_"));
      expect(externalBlock?.candidate_shape.component_area).toBe("src");
      expect(externalBlock?.candidate_shape.target_paths[0]).toContain("src/");
      expect(externalBlock?.candidate_shape.target_paths[0]).not.toContain("apps/server");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filters archived inspiration sources and boosts trusted sources into fallback objective seeds", () => {
    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      inspirationPatterns: [
        {
          id: "ext_trusted_1",
          fingerprint: "fp_trusted_queue_strategy",
          sourceType: "external_repo",
          sourceLabel: "trusted/workforce-lab",
          sourceUrl: "https://example.com/trusted/workforce-lab",
          sourceRefs: ["README#adaptive-queue-scheduler"],
          algorithm: "trusted_queue_scheduler",
          whenToUse: "queue backpressure and worker throughput are unstable",
          summary:
            "Prioritize autonomous work by trust-weighted queue pressure and regret feedback.",
          tags: ["queue", "backpressure", "worker", "regret"],
          qualityScore: 0.56,
          freshnessScore: 0.48,
          seenCount: 4,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
        {
          id: "ext_archived_1",
          fingerprint: "fp_archived_retry_loop",
          sourceType: "external_doc",
          sourceLabel: "archived/retry-notes",
          sourceUrl: "https://example.com/archived/retry-notes",
          sourceRefs: ["docs#retry-loop"],
          algorithm: "archived_retry_loop",
          whenToUse: "retry storms and queue retries keep cascading",
          summary: "A retry loop idea that previously caused churn and should be retired.",
          tags: ["retry", "queue", "storm"],
          qualityScore: 0.95,
          freshnessScore: 0.92,
          seenCount: 9,
          validationIdeas: ["bun run test:root"],
          metadata: {
            component_area: "apps/server",
            target_paths: ["apps/server/src/autonomy.ts"],
            write_globs: ["apps/server/src/*"],
          },
        },
      ],
      sourceInsights: [
        {
          sourceFingerprint: "fp_trusted_queue_strategy",
          sourceType: "external_repo",
          curationStatus: "trusted",
          curationReason: "strong real-world outcomes",
          trustScore: 0.93,
          freshnessScore: 0.86,
          sampleCount: 9,
        },
        {
          sourceFingerprint: "fp_archived_retry_loop",
          sourceType: "external_doc",
          curationStatus: "archived",
          curationReason: "low-performing source",
          trustScore: 0.14,
          freshnessScore: 0.22,
          sampleCount: 11,
        },
      ],
    });

    expect(
      context.source_patterns.some((pattern) => pattern.algorithm === "archived_retry_loop"),
    ).toBe(false);
    const trustedSourcePattern = context.source_patterns.find(
      (pattern) => pattern.algorithm === "trusted_queue_scheduler",
    );
    expect(trustedSourcePattern).toBeDefined();
    expect(trustedSourcePattern?.source_curation_status).toBe("trusted");
    const trustedBlock = context.building_blocks.find(
      (block) => block.algorithm === "trusted_queue_scheduler",
    );
    expect(trustedBlock).toBeDefined();
    expect(trustedBlock?.source_curation_status).toBe("trusted");
    expect(context.building_blocks.some((block) => block.algorithm === "archived_retry_loop")).toBe(
      false,
    );

    const fallback = buildEngineFallbackCandidates({
      engineInspiration: context,
      snapshotTopSignals: snapshot.top_signals,
      visionSectionRefs: vision.section_numbers,
      maxCandidates: 6,
    });
    expect(
      fallback.some((candidate) => {
        const trial = (candidate as Record<string, unknown>).engine_trial as
          | Record<string, unknown>
          | undefined;
        return (
          String(candidate.title ?? "")
            .toLowerCase()
            .includes("trusted_queue_scheduler") ||
          String(trial?.algorithm ?? "")
            .toLowerCase()
            .includes("trusted_queue_scheduler")
        );
      }),
    ).toBe(true);
    expect(
      fallback.some((candidate) =>
        String(candidate.title ?? "")
          .toLowerCase()
          .includes("archived_retry_loop"),
      ),
    ).toBe(false);
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

  test("saturated test-only commit history does not emit another history test block", () => {
    const hints = summarizeCommitHistoryHints(
      Array.from({ length: 24 }, (_, index) => `feat(worker): expand app test coverage ${index}`),
    );
    const testHint = hints.find((entry) => entry.motif_id === "test_flake_reliability");
    expect(testHint?.count).toBe(24);
    expect(testHint?.signal).toBe(1);

    const context = buildEngineInspirationContext({
      vision,
      snapshot,
      commitHistoryHints: hints,
    });

    expect(
      context.building_blocks.some((block) => block.id === "history_test_flake_reliability"),
    ).toBe(false);
  });
});
