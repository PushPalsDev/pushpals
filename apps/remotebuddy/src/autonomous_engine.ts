import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import type { CommunicationManager } from "shared";
import {
  extractVisionKeyItems,
  loadRepoDocText,
  loadPromptTemplate,
  makePatternKey,
  normalizePenalties,
  normalizeVisionSectionRefs,
  penaltyTotal,
  parseVisionDoc,
  validateScopeInvariants,
  type AutonomyComponentArea,
  type AutonomyObjectiveType,
} from "shared";
import type { PushPalsConfig } from "shared";
import type { LLMClient } from "./llm.js";
import {
  canonicalizeInstructionTextForBun,
  canonicalizeValidationCommandForBun,
} from "./command_policy.js";

type AutonomyCandidate = {
  id: string;
  title: string;
  objective_type: AutonomyObjectiveType;
  problem_statement: string;
  trigger_type: "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal";
  component_area: AutonomyComponentArea;
  target_paths: string[];
  scope: {
    read_anywhere: boolean;
    write_globs: string[];
  };
  risk_level: "low" | "medium" | "high";
  expected_validation: string[];
  estimated_effort: "small" | "medium" | "large";
  why_now_signal_ids: string[];
  confidence: number;
  vision_alignment_reason: string;
  vision_section_refs: string[];
  feature_hypotheses: string[];
  requires_user_input?: boolean;
  question_if_blocked?: string;
  candidate_created_at: string;
  engine_trial?: {
    building_block_id: string;
    algorithm: string;
    source: "llm" | "engine_fallback" | "engine_mapped";
    score?: number;
    objective_ids: string[];
    gap_ids: string[];
    summary?: string;
    hypothesis?: string;
  };
};

type Snapshot = {
  snapshot_id: string;
  snapshot_created_at: string;
  snapshot_ttl_ms: number;
  impact_model_version: string;
  top_signals: Array<{ signal_id: string; type: string; value: number; evidence: string }>;
  state_traits: Array<{
    trait_id: string;
    category: "strength" | "weakness" | "opportunity" | "risk";
    focus: string;
    score: number;
    evidence: string;
  }>;
  feedback_priors: Array<{
    pattern_key: string;
    ema_success: number;
    ema_user_accept: number;
    ema_latency: number;
    ema_regret: number;
    fail_streak: number;
  }>;
  engine_idea_priors?: Array<{
    engine_building_block_id: string;
    engine_algorithm: string;
    ema_success: number;
    ema_user_accept: number;
    ema_latency: number;
    ema_regret: number;
    sample_count: number;
    updated_at: string;
  }>;
  active_cooldowns: Array<{ pattern_key: string; cooldown_until: string }>;
  open_objectives: Array<{ objective_id: string; pattern_key: string; status: string }>;
  repo_health_flags: {
    is_worktree_dirty: boolean;
    is_merge_in_progress: boolean;
    dispatch_lock_held: boolean;
  };
  dispatch_budget: {
    global_count_last_hour: number;
    by_type_count_last_hour: Record<string, number>;
  };
};

type PolicyRule = {
  maxRisk: "low" | "medium" | "high";
  maxBreadth: "narrow" | "medium" | "broad";
  autonomousAllowed: boolean;
  requireValidation: boolean;
};

const POLICY: Record<AutonomyObjectiveType, PolicyRule> = {
  flaky_test: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
  },
  lint_fix: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
  },
  type_fix: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  small_refactor: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_small: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_medium: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_large: {
    maxRisk: "high",
    maxBreadth: "broad",
    autonomousAllowed: false,
    requireValidation: true,
  },
  docs: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: false,
  },
  dep_bump: {
    maxRisk: "medium",
    maxBreadth: "narrow",
    autonomousAllowed: false,
    requireValidation: true,
  },
};

const RISK_ORDER: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };
const BREADTH_ORDER: Record<"narrow" | "medium" | "broad", number> = {
  narrow: 0,
  medium: 1,
  broad: 2,
};

const IDEATION_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_ideation_system_prompt.md",
).trim();

const SCORING_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_scoring_system_prompt.md",
).trim();

const PLANNING_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_planning_system_prompt.md",
).trim();
const VISION_DOC_FNAME = "vision.md";
const MAX_VISION_SECTION_CHARS = 1_200;
const DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY = 0.45;
const DOCS_WEAK_EVIDENCE_MAX_PENALTY = 0.12;
const ENGINE_EXPLORE_RATE_DEFAULT = 0.3;
const ENGINE_NOVELTY_SAMPLE_SATURATION = 12;
const ENGINE_EXPLORE_POOL_MAX = 3;

type FeedbackPriorForScoring = {
  ema_success?: unknown;
  ema_user_accept?: unknown;
  ema_latency?: unknown;
  ema_regret?: unknown;
} | null;

type EngineIdeaPriorForScoring = {
  ema_success?: unknown;
  ema_user_accept?: unknown;
  ema_latency?: unknown;
  ema_regret?: unknown;
  sample_count?: unknown;
} | null;

export function docsWeakEvidencePenaltyForImpact(
  objectiveType: string,
  impactSignal: number,
): number {
  if (objectiveType !== "docs") return 0;
  const normalizedImpact = clamp01(impactSignal);
  if (normalizedImpact >= DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY) return 0;
  const gapRatio =
    (DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY - normalizedImpact) / DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY;
  const penalty = DOCS_WEAK_EVIDENCE_MAX_PENALTY * clamp01(gapRatio);
  return Math.round(penalty * 1_000_000) / 1_000_000;
}

export function feedbackPriorSignalForScoring(prior: FeedbackPriorForScoring): {
  emaSuccess: number;
  emaUserAccept: number;
  emaLatency: number;
  emaRegret: number;
  priorScore: number;
} {
  const emaSuccess = clamp01(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp01(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp01(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp01(asNumber(prior?.ema_regret, 0));
  const priorScore =
    0.12 * emaSuccess +
    0.08 * emaUserAccept +
    0.06 * emaLatency +
    0.04 * (1 - emaRegret);
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    priorScore,
  };
}

export function engineIdeaPriorSignalForScoring(prior: EngineIdeaPriorForScoring): {
  emaSuccess: number;
  emaUserAccept: number;
  emaLatency: number;
  emaRegret: number;
  sampleCount: number;
  noveltyScore: number;
  priorScore: number;
  noveltyBonus: number;
} {
  const sampleCount = Math.max(0, Math.floor(asNumber(prior?.sample_count, 0)));
  if (sampleCount === 0) {
    return {
      emaSuccess: 0,
      emaUserAccept: 0,
      emaLatency: 0,
      emaRegret: 0,
      sampleCount: 0,
      noveltyScore: 1,
      priorScore: 0,
      noveltyBonus: 0.06,
    };
  }
  const emaSuccess = clamp01(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp01(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp01(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp01(asNumber(prior?.ema_regret, 0));
  const noveltyScore = 1 - clamp01(sampleCount / ENGINE_NOVELTY_SAMPLE_SATURATION);
  const priorScore =
    0.08 * emaSuccess +
    0.05 * emaUserAccept +
    0.03 * emaLatency +
    0.02 * (1 - emaRegret);
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    sampleCount,
    noveltyScore,
    priorScore,
    noveltyBonus: 0.06 * noveltyScore,
  };
}

function deterministicUnitInterval(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0);
  return value / 0x1_0000_0000;
}

type ExploreExploitRow = {
  id: string;
  finalScore: number;
  noveltyScore: number;
};

export function pickCandidateWithExploreExploit<T extends ExploreExploitRow>(params: {
  rows: T[];
  seed: string;
  exploreRate?: number;
}): { selected: T | null; strategy: "exploit" | "explore"; roll: number } {
  const exploreRate = clamp01(asNumber(params.exploreRate, ENGINE_EXPLORE_RATE_DEFAULT));
  if (params.rows.length === 0) {
    return { selected: null, strategy: "exploit", roll: 1 };
  }
  const exploitOrdered = [...params.rows].sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.id.localeCompare(b.id);
  });
  const exploitTop = exploitOrdered[0];
  const modeRoll = deterministicUnitInterval(`${params.seed}:mode`);
  const shouldExplore = exploitOrdered.length > 1 && modeRoll < exploreRate;
  if (!shouldExplore) {
    return { selected: exploitTop, strategy: "exploit", roll: modeRoll };
  }
  const noveltyOrdered = [...params.rows]
    .filter((row) => row.noveltyScore > 0)
    .sort((a, b) => {
      if (b.noveltyScore !== a.noveltyScore) return b.noveltyScore - a.noveltyScore;
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      return a.id.localeCompare(b.id);
    });
  if (noveltyOrdered.length === 0) {
    return { selected: exploitTop, strategy: "exploit", roll: modeRoll };
  }
  const pool = noveltyOrdered.slice(0, Math.min(ENGINE_EXPLORE_POOL_MAX, noveltyOrdered.length));
  const pickRoll = deterministicUnitInterval(`${params.seed}:pick`);
  const index = Math.min(pool.length - 1, Math.floor(pickRoll * pool.length));
  let selected = pool[index];
  if (selected.id === exploitTop.id && pool.length > 1) {
    selected = pool[(index + 1) % pool.length];
  }
  return { selected, strategy: "explore", roll: modeRoll };
}

type VisionContext = {
  path: string;
  markdown: string;
  one_sentence: string;
  sections: Array<{
    number: string;
    title: string;
    markdown: string;
    truncated: boolean;
  }>;
  key_items: {
    target_users: string[];
    priorities: string[];
    objectives: string[];
    guardrails: string[];
    constraints: string[];
    non_goals: string[];
    metrics: string[];
    risk_policy: string[];
    operating_model: string[];
    governance: string[];
  };
  section_numbers: string[];
  sha256: string;
  truncated: boolean;
};

type VisionKeyItems = VisionContext["key_items"];

export interface CompiledVisionObjective {
  id: string;
  title: string;
  weight: number;
  evidence: string[];
}

export interface EngineOpportunityGap {
  id: string;
  label: string;
  score: number;
  evidence: string[];
}

export interface EngineCandidateShape {
  objective_type: AutonomyObjectiveType;
  trigger_type: "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal";
  component_area: AutonomyComponentArea;
  target_paths: string[];
  write_globs: string[];
  risk_level: "low" | "medium" | "high";
  expected_validation: string[];
}

export interface EngineIdeaBuildingBlock {
  id: string;
  algorithm: string;
  summary: string;
  hypothesis: string;
  objective_ids: string[];
  gap_ids: string[];
  score: number;
  evidence: string[];
  candidate_shape: EngineCandidateShape;
}

export interface EngineInspirationContext {
  compiled_objectives: CompiledVisionObjective[];
  opportunity_gaps: EngineOpportunityGap[];
  building_blocks: EngineIdeaBuildingBlock[];
}

type EngineIdeaInputSnapshot = Pick<
  Snapshot,
  "top_signals" | "state_traits" | "open_objectives" | "dispatch_budget"
>;

type EngineIdeaBlueprint = {
  id: string;
  algorithm: string;
  summary: string;
  hypothesis: string;
  objective_ids: string[];
  gap_ids: string[];
  candidate_shape: EngineCandidateShape;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter(Boolean);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const ENGINE_OBJECTIVE_BLUEPRINTS: Array<{
  id: string;
  title: string;
  baseWeight: number;
  keywordPattern: RegExp;
  buckets: Array<keyof VisionKeyItems>;
}> = [
  {
    id: "reliable_autonomous_delivery",
    title: "Reliable Autonomous Delivery Loop",
    baseWeight: 0.62,
    keywordPattern:
      /\b(reliab|stable|stability|startup|failure|flake|retry|incident|deterministic|preflight|runtime)\b/i,
    buckets: ["priorities", "objectives", "metrics", "constraints"],
  },
  {
    id: "merge_conversion_and_rework",
    title: "High-Confidence Review + Merge Conversion",
    baseWeight: 0.58,
    keywordPattern:
      /\b(merge|review|pr|pull request|rework|conflict|approved|conversion|comment cap|unmergeable)\b/i,
    buckets: ["priorities", "objectives", "metrics", "operating_model"],
  },
  {
    id: "mass_audience_activation",
    title: "Activation: First Autonomous PR Fast",
    baseWeight: 0.5,
    keywordPattern:
      /\b(activation|first pr|onboard|onboarding|quickstart|time-to-first-value|30 minutes|retention)\b/i,
    buckets: ["priorities", "objectives", "metrics", "target_users"],
  },
  {
    id: "policy_and_governance",
    title: "Policy + Permission Governance",
    baseWeight: 0.55,
    keywordPattern:
      /\b(policy|permission|scope|guardrail|audit|risk|security|approval|governance|least privilege)\b/i,
    buckets: ["guardrails", "constraints", "risk_policy", "governance"],
  },
  {
    id: "workforce_scaling",
    title: "Workforce-Grade Delegation",
    baseWeight: 0.6,
    keywordPattern:
      /\b(workforce|worker|delegation|specialist|dispatch|throughput|task schema|capability|taxonomy)\b/i,
    buckets: ["priorities", "objectives", "operating_model"],
  },
];

const ENGINE_IDEA_BLUEPRINTS: EngineIdeaBlueprint[] = [
  {
    id: "vision_compiler_refresh",
    algorithm: "vision_compiler",
    summary: "Continuously compile vision signals into weighted autonomous objectives.",
    hypothesis:
      "Objective-weighted planning reduces drift and increases accepted autonomous PR quality.",
    objective_ids: ["reliable_autonomous_delivery", "policy_and_governance"],
    gap_ids: ["delivery_reliability_gap", "governance_gap"],
    candidate_shape: {
      objective_type: "small_refactor",
      trigger_type: "regret_signal",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "opportunity_graph_pipeline",
    algorithm: "opportunity_graph",
    summary: "Model queue/review/runtime friction as an opportunity graph and prioritize highest leverage edges.",
    hypothesis:
      "Graph-ranked bottlenecks improve throughput without increasing risk by focusing on high-friction links.",
    objective_ids: ["reliable_autonomous_delivery", "workforce_scaling"],
    gap_ids: ["delivery_reliability_gap", "workforce_throughput_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "queue_health",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "motif_miner_learning_loop",
    algorithm: "motif_miner",
    summary: "Mine successful local commit/PR motifs and bias candidate generation toward those patterns.",
    hypothesis:
      "Learning from accepted local motifs lowers review churn and improves merge conversion.",
    objective_ids: ["merge_conversion_and_rework", "workforce_scaling"],
    gap_ids: ["merge_rework_gap", "workforce_throughput_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "regret_signal",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "regret_miner_guard",
    algorithm: "regret_miner",
    summary: "Convert rejected/unmergeable feedback into deterministic preventive heuristics.",
    hypothesis:
      "Explicit regret-mined heuristics reduce repeated PR rejection modes across workers.",
    objective_ids: ["merge_conversion_and_rework", "policy_and_governance"],
    gap_ids: ["merge_rework_gap", "governance_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "regret_signal",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "adjacent_possible_generator",
    algorithm: "adjacent_possible",
    summary: "Generate new ideas by recombining proven motifs with active bottlenecks.",
    hypothesis:
      "Adjacent-possible idea generation increases novelty while staying inside proven safety boundaries.",
    objective_ids: ["workforce_scaling", "reliable_autonomous_delivery"],
    gap_ids: ["workforce_throughput_gap", "delivery_reliability_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "queue_health",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "portfolio_bandit_dispatch",
    algorithm: "portfolio_bandit",
    summary: "Allocate dispatch budget across reliability, mergeability, activation, and governance idea portfolios.",
    hypothesis:
      "Portfolio-based dispatch improves aggregate repo outcomes versus single-metric greedy selection.",
    objective_ids: [
      "reliable_autonomous_delivery",
      "merge_conversion_and_rework",
      "mass_audience_activation",
      "policy_and_governance",
    ],
    gap_ids: ["delivery_reliability_gap", "merge_rework_gap", "activation_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "queue_health",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "counterfactual_impact_estimator",
    algorithm: "counterfactual_impact",
    summary: "Estimate prevented incidents/rework if a proposed feature had existed over recent runs.",
    hypothesis:
      "Counterfactual scoring improves prioritization of ideas with measurable practical payoff.",
    objective_ids: ["reliable_autonomous_delivery", "merge_conversion_and_rework"],
    gap_ids: ["delivery_reliability_gap", "merge_rework_gap"],
    candidate_shape: {
      objective_type: "small_refactor",
      trigger_type: "typecheck_failure",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    id: "workforce_capability_planner",
    algorithm: "capability_planner",
    summary: "Propose and score new worker specializations from recurring task clusters.",
    hypothesis:
      "Capability-aware routing raises throughput and lowers fix-loop churn for autonomous execution.",
    objective_ids: ["workforce_scaling", "mass_audience_activation"],
    gap_ids: ["workforce_throughput_gap", "activation_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "queue_health",
      component_area: "apps/workerpals",
      target_paths: ["apps/workerpals/src/workerpals_main.ts"],
      write_globs: ["apps/workerpals/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"],
    },
  },
];

function bucketLines(items: VisionKeyItems, keys: Array<keyof VisionKeyItems>): string[] {
  return keys.flatMap((key) => (Array.isArray(items[key]) ? items[key] : [])).filter(Boolean);
}

function keywordEvidence(lines: string[], pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line)).slice(0, 6);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxSignalScore(
  snapshot: EngineIdeaInputSnapshot,
  types: Array<"test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal">,
): number {
  return clamp01(
    Math.max(
      0,
      ...snapshot.top_signals
        .filter((signal) =>
          types.includes(
            String(signal.type ?? "").trim() as
              | "test_failure"
              | "lint_failure"
              | "typecheck_failure"
              | "queue_health"
              | "regret_signal",
          ),
        )
        .map((signal) => asNumber(signal.value, 0)),
    ),
  );
}

function maxTraitScore(snapshot: EngineIdeaInputSnapshot, pattern: RegExp): number {
  return clamp01(
    Math.max(
      0,
      ...snapshot.state_traits
        .filter(
          (trait) =>
            pattern.test(String(trait.focus ?? "")) ||
            pattern.test(String(trait.evidence ?? "")) ||
            pattern.test(String(trait.trait_id ?? "")),
        )
        .map((trait) => asNumber(trait.score, 0)),
    ),
  );
}

export function buildEngineInspirationContext(params: {
  vision: Pick<VisionContext, "one_sentence" | "key_items" | "section_numbers">;
  snapshot: EngineIdeaInputSnapshot;
}): EngineInspirationContext {
  const oneSentence = asString(params.vision.one_sentence);
  const keyItems = params.vision.key_items;
  const compiledObjectives = ENGINE_OBJECTIVE_BLUEPRINTS.map((blueprint) => {
    const lines = bucketLines(keyItems, blueprint.buckets);
    const evidence = keywordEvidence(lines, blueprint.keywordPattern);
    const lineHitSignal = clamp01(evidence.length / 4);
    const oneSentenceBoost = blueprint.keywordPattern.test(oneSentence) ? 0.08 : 0;
    const weight = clamp01(blueprint.baseWeight + lineHitSignal * 0.3 + oneSentenceBoost);
    return {
      id: blueprint.id,
      title: blueprint.title,
      weight,
      evidence,
    } satisfies CompiledVisionObjective;
  }).sort((a, b) => b.weight - a.weight);

  const failureSignal = maxSignalScore(params.snapshot, ["test_failure", "lint_failure", "typecheck_failure"]);
  const queueSignal = maxSignalScore(params.snapshot, ["queue_health"]);
  const regretSignal = maxSignalScore(params.snapshot, ["regret_signal"]);
  const reliabilityTrait = maxTraitScore(
    params.snapshot,
    /\b(reliab|stability|startup|failure|flake|retry|incident|runtime|preflight)\b/i,
  );
  const mergeTrait = maxTraitScore(
    params.snapshot,
    /\b(merge|review|pr|pull request|conflict|rework|comment)\b/i,
  );
  const activationTrait = maxTraitScore(
    params.snapshot,
    /\b(activation|onboard|first pr|quickstart|setup|time-to-first)\b/i,
  );
  const governanceTrait = maxTraitScore(
    params.snapshot,
    /\b(policy|permission|scope|guardrail|audit|security|compliance|risk)\b/i,
  );
  const workforceTrait = maxTraitScore(
    params.snapshot,
    /\b(worker|delegation|dispatch|specialist|capability|throughput|queue)\b/i,
  );
  const openObjectivePressure = clamp01(params.snapshot.open_objectives.length / 10);
  const dispatchSaturation = clamp01(params.snapshot.dispatch_budget.global_count_last_hour / 10);

  const opportunityGaps: EngineOpportunityGap[] = [
    {
      id: "delivery_reliability_gap",
      label: "Delivery reliability gap",
      score: clamp01(0.5 * failureSignal + 0.25 * reliabilityTrait + 0.15 * queueSignal + 0.1 * regretSignal),
      evidence: [
        `failure_signal=${failureSignal.toFixed(2)}`,
        `reliability_trait=${reliabilityTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`,
      ],
    },
    {
      id: "merge_rework_gap",
      label: "Merge/rework gap",
      score: clamp01(0.45 * regretSignal + 0.35 * mergeTrait + 0.2 * openObjectivePressure),
      evidence: [
        `regret_signal=${regretSignal.toFixed(2)}`,
        `merge_trait=${mergeTrait.toFixed(2)}`,
        `open_objective_pressure=${openObjectivePressure.toFixed(2)}`,
      ],
    },
    {
      id: "activation_gap",
      label: "Activation/onboarding gap",
      score: clamp01(0.5 * activationTrait + 0.3 * queueSignal + 0.2 * dispatchSaturation),
      evidence: [
        `activation_trait=${activationTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`,
      ],
    },
    {
      id: "governance_gap",
      label: "Governance guardrail gap",
      score: clamp01(0.6 * governanceTrait + 0.2 * regretSignal + 0.2 * dispatchSaturation),
      evidence: [
        `governance_trait=${governanceTrait.toFixed(2)}`,
        `regret_signal=${regretSignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`,
      ],
    },
    {
      id: "workforce_throughput_gap",
      label: "Workforce throughput gap",
      score: clamp01(0.35 * workforceTrait + 0.35 * queueSignal + 0.3 * openObjectivePressure),
      evidence: [
        `workforce_trait=${workforceTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`,
        `open_objective_pressure=${openObjectivePressure.toFixed(2)}`,
      ],
    },
  ].sort((a, b) => b.score - a.score);

  const objectiveWeightById = new Map(compiledObjectives.map((entry) => [entry.id, entry.weight]));
  const gapScoreById = new Map(opportunityGaps.map((entry) => [entry.id, entry.score]));
  const dispatchByType = params.snapshot.dispatch_budget.by_type_count_last_hour ?? {};

  const buildingBlocks: EngineIdeaBuildingBlock[] = ENGINE_IDEA_BLUEPRINTS.map((blueprint) => {
    const objectiveWeights = blueprint.objective_ids
      .map((id) => objectiveWeightById.get(id) ?? 0)
      .filter((value) => Number.isFinite(value));
    const gapScores = blueprint.gap_ids
      .map((id) => gapScoreById.get(id) ?? 0)
      .filter((value) => Number.isFinite(value));
    const objectiveSignal = clamp01(average(objectiveWeights));
    const gapSignal = clamp01(Math.max(0, ...gapScores));
    const recentTypeCount = Math.max(
      0,
      Math.floor(asNumber(dispatchByType[blueprint.candidate_shape.objective_type], 0)),
    );
    const noveltySignal = clamp01(1 - recentTypeCount / 6);
    const score = clamp01(
      0.52 * objectiveSignal +
        0.33 * gapSignal +
        0.2 * noveltySignal -
        0.08 * dispatchSaturation,
    );
    return {
      ...blueprint,
      score,
      evidence: [
        `objective_signal=${objectiveSignal.toFixed(2)}`,
        `gap_signal=${gapSignal.toFixed(2)}`,
        `novelty_signal=${noveltySignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`,
      ],
    };
  }).sort((a, b) => b.score - a.score);

  return {
    compiled_objectives: compiledObjectives,
    opportunity_gaps: opportunityGaps,
    building_blocks: buildingBlocks,
  };
}

function selectVisionSectionRefs(sectionRefs: string[]): string[] {
  const preferred = ["6", "7", "8", "4", "3", "0", "5"];
  const normalized = sectionRefs.map((value) => asString(value)).filter(Boolean);
  const selected = preferred.filter((value) => normalized.includes(value)).slice(0, 2);
  if (selected.length > 0) return selected;
  return normalized.slice(0, 2);
}

function pickSignalIdsForTrigger(
  topSignals: EngineIdeaInputSnapshot["top_signals"],
  triggerType: EngineCandidateShape["trigger_type"],
): string[] {
  const exact = topSignals
    .filter((signal) => asString(signal.type) === triggerType)
    .map((signal) => asString(signal.signal_id))
    .filter(Boolean);
  if (exact.length > 0) return exact.slice(0, 3);
  const fallback = topSignals
    .filter((signal) => {
      const type = asString(signal.type);
      return type === "queue_health" || type === "regret_signal" || type === "test_failure";
    })
    .map((signal) => asString(signal.signal_id))
    .filter(Boolean);
  return fallback.slice(0, 3);
}

function normalizeEngineTrialMetadata(
  value: unknown,
): NonNullable<AutonomyCandidate["engine_trial"]> | undefined {
  const raw = asObject(value);
  const buildingBlockId = asString(
    raw.building_block_id ??
      raw.buildingBlockId ??
      raw.block_id ??
      raw.blockId ??
      raw.engine_building_block_id,
  );
  if (!buildingBlockId) return undefined;
  const sourceRaw = asString(raw.source).toLowerCase();
  const source =
    sourceRaw === "engine_fallback" || sourceRaw === "engine_mapped" ? sourceRaw : "llm";
  const score = Number.isFinite(asNumber(raw.score, Number.NaN)) ? asNumber(raw.score, 0) : undefined;
  return {
    building_block_id: buildingBlockId,
    algorithm: asString(raw.algorithm) || "engine_building_block",
    source,
    ...(typeof score === "number" ? { score } : {}),
    objective_ids: asStringArray(raw.objective_ids ?? raw.objectiveIds),
    gap_ids: asStringArray(raw.gap_ids ?? raw.gapIds ?? raw.opportunity_gap_ids),
    summary: asString(raw.summary) || undefined,
    hypothesis: asString(raw.hypothesis) || undefined,
  };
}

function inferEngineTrialFromCandidate(
  candidate: Pick<AutonomyCandidate, "objective_type" | "trigger_type" | "component_area">,
  engineInspiration: EngineInspirationContext,
): NonNullable<AutonomyCandidate["engine_trial"]> | undefined {
  const exact = engineInspiration.building_blocks.find(
    (block) =>
      block.candidate_shape.objective_type === candidate.objective_type &&
      block.candidate_shape.trigger_type === candidate.trigger_type &&
      block.candidate_shape.component_area === candidate.component_area,
  );
  const fallback =
    exact ??
    engineInspiration.building_blocks.find(
      (block) =>
        block.candidate_shape.objective_type === candidate.objective_type &&
        block.candidate_shape.component_area === candidate.component_area,
    ) ??
    engineInspiration.building_blocks.find(
      (block) => block.candidate_shape.objective_type === candidate.objective_type,
    );
  if (!fallback) return undefined;
  return {
    building_block_id: fallback.id,
    algorithm: fallback.algorithm,
    source: "engine_mapped",
    score: fallback.score,
    objective_ids: fallback.objective_ids,
    gap_ids: fallback.gap_ids,
    summary: fallback.summary,
    hypothesis: fallback.hypothesis,
  };
}

export function buildEngineFallbackCandidates(params: {
  engineInspiration: EngineInspirationContext;
  snapshotTopSignals: EngineIdeaInputSnapshot["top_signals"];
  visionSectionRefs: string[];
  maxCandidates?: number;
}): Array<Record<string, unknown>> {
  const maxCandidates = Number.isFinite(params.maxCandidates)
    ? Math.max(1, Math.min(6, Math.floor(params.maxCandidates as number)))
    : 3;
  const objectiveTitleById = new Map(
    params.engineInspiration.compiled_objectives.map((objective) => [objective.id, objective.title]),
  );
  const sectionRefs = selectVisionSectionRefs(params.visionSectionRefs);

  return params.engineInspiration.building_blocks
    .filter((block) => block.score >= 0.42)
    .slice(0, maxCandidates)
    .map((block, idx) => {
      const signalIds = pickSignalIdsForTrigger(params.snapshotTopSignals, block.candidate_shape.trigger_type);
      const objectiveTitles = block.objective_ids
        .map((id) => objectiveTitleById.get(id))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, 3);
      const primaryObjectiveTitle = objectiveTitles[0] ?? "vision priorities";
      return {
        id: `cand_engine_${block.id}_${randomUUID().slice(0, 8)}`,
        title: `Engine building block: ${block.algorithm}`,
        objective_type: block.candidate_shape.objective_type,
        problem_statement:
          `Implement ${block.algorithm} in PushPals autonomy to improve ${primaryObjectiveTitle}. ` +
          `Deliver a small, test-backed change with clear operational telemetry.`,
        trigger_type: block.candidate_shape.trigger_type,
        component_area: block.candidate_shape.component_area,
        target_paths: block.candidate_shape.target_paths,
        scope: {
          read_anywhere: false,
          write_globs: block.candidate_shape.write_globs,
        },
        risk_level: block.candidate_shape.risk_level,
        expected_validation: block.candidate_shape.expected_validation,
        estimated_effort: idx === 0 ? "small" : "medium",
        why_now_signal_ids: signalIds,
        confidence: clamp01(0.45 + block.score * 0.5),
        vision_alignment_reason:
          `Prioritize ${primaryObjectiveTitle} using ${block.algorithm}; score=${block.score.toFixed(2)}.`,
        vision_section_refs: sectionRefs,
        feature_hypotheses: [
          block.summary,
          block.hypothesis,
          `Add measurable telemetry and guardrails for ${block.algorithm}.`,
        ].slice(0, 3),
        engine_trial: {
          building_block_id: block.id,
          algorithm: block.algorithm,
          source: "engine_fallback",
          score: block.score,
          objective_ids: block.objective_ids,
          gap_ids: block.gap_ids,
          summary: block.summary,
          hypothesis: block.hypothesis,
        },
        requires_user_input: false,
        question_if_blocked: "",
      } as Record<string, unknown>;
    });
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const raw = text.trim();
  if (!raw) return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
      try {
        return asObject(JSON.parse(fenced));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRiskLevel(value: string): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isTriggerType(
  value: string,
): value is "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal" {
  return (
    value === "test_failure" ||
    value === "lint_failure" ||
    value === "typecheck_failure" ||
    value === "queue_health" ||
    value === "regret_signal"
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  const timeout = Math.max(1_000, timeoutMs);
  const timeoutError = new Error(reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeout);
  });
  try {
    return await Promise.race([promise, timed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return "";
  return stdout.trim();
}

type GitRunResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

function sanitizeForGitRef(value: string): string {
  const text = value.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return text || "default";
}

async function repoPreflight(repo: string): Promise<{
  isWorktreeDirty: boolean;
  isMergeInProgress: boolean;
}> {
  const porcelain = await gitOutput(repo, ["status", "--porcelain"]);
  const mergeHead = await gitOutput(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  return {
    isWorktreeDirty: Boolean(porcelain),
    isMergeInProgress: Boolean(mergeHead),
  };
}

export class RemoteBuddyAutonomousEngine {
  private readonly server: string;
  private readonly sessionId: string;
  private readonly authToken: string | null;
  private readonly repoRoot: string;
  private readonly autonomyRepo: string;
  private readonly autonomyBranch: string;
  private readonly gitRemote: string;
  private readonly integrationBranch: string;
  private readonly baseBranch: string;
  private readonly llm: LLMClient;
  private readonly comm: CommunicationManager;
  private readonly cfg: PushPalsConfig["remotebuddy"]["autonomy"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private nextTickAtMs = 0;
  private currentRunId: string | null = null;
  private currentPhase = "idle";
  private currentPhaseStartedAtMs = 0;
  private currentRunStartedAtMs = 0;
  private lastOutcome: "none" | "success" | "skipped" | "failed" = "none";
  private lastDetail = "not_started";
  private lastCompletedAtMs = 0;

  constructor(opts: {
    server: string;
    sessionId: string;
    authToken: string | null;
    repo: string;
    llm: LLMClient;
    comm: CommunicationManager;
    config: PushPalsConfig;
  }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.repoRoot = opts.repo;
    const safeSession = sanitizeForGitRef(this.sessionId).slice(0, 40);
    this.autonomyRepo = resolve(this.repoRoot, ".worktrees", `remotebuddy-autonomy-${safeSession}`);
    this.autonomyBranch = `_remotebuddy/autonomy-${safeSession}`;
    this.gitRemote = String(opts.config.sourceControlManager.remote || "origin").trim() || "origin";
    this.integrationBranch =
      String(opts.config.sourceControlManager.mainBranch || "main_agents").trim() || "main_agents";
    this.baseBranch = String(opts.config.sourceControlManager.baseBranch || "main").trim() || "main";
    this.llm = opts.llm;
    this.comm = opts.comm;
    this.cfg = opts.config.remotebuddy.autonomy;
  }

  private setPhase(phase: string): void {
    this.currentPhase = phase;
    this.currentPhaseStartedAtMs = Date.now();
  }

  private markTickStart(runId: string): void {
    const now = Date.now();
    this.currentRunId = runId;
    this.currentRunStartedAtMs = now;
    this.setPhase("acquire_lock");
  }

  private markTickDone(
    outcome: "success" | "skipped" | "failed",
    detail: string,
  ): void {
    this.currentRunId = null;
    this.currentRunStartedAtMs = 0;
    this.lastOutcome = outcome;
    this.lastDetail = detail || "unspecified";
    this.lastCompletedAtMs = Date.now();
    this.setPhase("idle");
  }

  private logHeartbeat(): void {
    if (!this.cfg.enabled) return;
    const now = Date.now();
    if (this.currentRunId) {
      const runElapsedMs = Math.max(0, now - this.currentRunStartedAtMs);
      const phaseElapsedMs = Math.max(0, now - this.currentPhaseStartedAtMs);
      console.log(
        `[RemoteBuddyAutonomousEngine] heartbeat: status=running run=${this.currentRunId} phase=${this.currentPhase} run_elapsed_ms=${runElapsedMs} phase_elapsed_ms=${phaseElapsedMs}`,
      );
      return;
    }

    const nextTickInMs =
      this.timer && this.nextTickAtMs > 0 ? Math.max(0, this.nextTickAtMs - now) : 0;
    const lastAgeMs =
      this.lastCompletedAtMs > 0 ? Math.max(0, now - this.lastCompletedAtMs) : -1;
    console.log(
      `[RemoteBuddyAutonomousEngine] heartbeat: status=idle last_outcome=${this.lastOutcome} detail=${this.lastDetail} last_tick_age_ms=${lastAgeMs} next_tick_in_ms=${nextTickInMs}`,
    );
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    return headers;
  }

  private lockTtlMs(): number {
    return Math.max(
      this.cfg.tickIntervalMs * 3,
      this.cfg.ideationBudgetMs * 2 + this.cfg.llmTimeoutMs * 6,
      30_000,
    );
  }

  private cycleBudgetMs(): number {
    // One cycle includes ideation + scoring + planning LLM phases plus dispatch work.
    return Math.max(
      this.cfg.ideationBudgetMs + this.cfg.llmTimeoutMs * 3,
      this.cfg.llmTimeoutMs * 4,
      20_000,
    );
  }

  private loadVisionContext(runId: string): VisionContext | null {
    const maxVisionContextChars = this.cfg.visionContextMaxChars;
    let raw = "";
    try {
      raw = loadRepoDocText(VISION_DOC_FNAME);
    } catch (error) {
      console.error(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: failed to read ${VISION_DOC_FNAME}: ${String(error)}`,
      );
      return null;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      console.error(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: ${VISION_DOC_FNAME} is empty; autonomy ideation requires non-empty vision context.`,
      );
      return null;
    }

    const truncated = trimmed.length > maxVisionContextChars;
    if (truncated) {
      console.log(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: ${VISION_DOC_FNAME} exceeded ${maxVisionContextChars} chars; using first ${maxVisionContextChars} chars for ideation.`,
      );
    }

    const parsed = parseVisionDoc(trimmed);
    const keyItems = extractVisionKeyItems(trimmed);
    const section_numbers = parsed.sections.map((section) => section.number);
    const sections = parsed.sections.map((section) => {
      const sectionMarkdown = section.markdown.trim();
      const sectionTruncated = sectionMarkdown.length > MAX_VISION_SECTION_CHARS;
      return {
        number: section.number,
        title: section.title,
        markdown: sectionTruncated
          ? sectionMarkdown.slice(0, MAX_VISION_SECTION_CHARS)
          : sectionMarkdown,
        truncated: sectionTruncated,
      };
    });

    return {
      path: VISION_DOC_FNAME,
      markdown: truncated ? trimmed.slice(0, maxVisionContextChars) : trimmed,
      one_sentence: parsed.oneSentence,
      sections,
      key_items: {
        target_users: keyItems.targetUsers,
        priorities: keyItems.priorities,
        objectives: keyItems.objectives,
        guardrails: keyItems.guardrails,
        constraints: keyItems.constraints,
        non_goals: keyItems.nonGoals,
        metrics: keyItems.metrics,
        risk_policy: keyItems.riskPolicy,
        operating_model: keyItems.operatingModel,
        governance: keyItems.governance,
      },
      section_numbers,
      sha256: sha256(trimmed),
      truncated,
    };
  }

  private async runGit(cwd: string, args: string[]): Promise<GitRunResult> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  }

  private async ensureAutonomyRepoReady(runId: string): Promise<boolean> {
    const integrationRef = `${this.gitRemote}/${this.integrationBranch}`;
    const baseRef = `${this.gitRemote}/${this.baseBranch}`;

    const fetch = await this.runGit(this.repoRoot, [
      "fetch",
      this.gitRemote,
      this.integrationBranch,
      this.baseBranch,
    ]);
    if (!fetch.ok) {
      console.error(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: failed to fetch refs for autonomy worktree (${this.gitRemote} ${this.integrationBranch}/${this.baseBranch}): ${fetch.stderr || fetch.stdout || `exit ${fetch.exitCode}`}`,
      );
      return false;
    }

    if (existsSync(this.autonomyRepo)) {
      await this.runGit(this.repoRoot, ["worktree", "remove", "--force", this.autonomyRepo]);
      try {
        rmSync(this.autonomyRepo, { recursive: true, force: true });
      } catch (error) {
        console.error(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: failed to delete previous autonomy worktree ${this.autonomyRepo}: ${String(error)}`,
        );
        return false;
      }
    }
    await this.runGit(this.repoRoot, ["worktree", "prune"]);
    await this.runGit(this.repoRoot, ["branch", "-D", this.autonomyBranch]);

    const parentDir = resolve(this.autonomyRepo, "..");
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    const add = await this.runGit(this.repoRoot, [
      "worktree",
      "add",
      "-B",
      this.autonomyBranch,
      this.autonomyRepo,
      integrationRef,
    ]);
    if (!add.ok) {
      console.error(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: failed to create autonomy worktree at ${this.autonomyRepo}: ${add.stderr || add.stdout || `exit ${add.exitCode}`}`,
      );
      return false;
    }

    const mergeMain = await this.runGit(this.autonomyRepo, ["merge", "--ff-only", baseRef]);
    if (!mergeMain.ok) {
      // Keep this non-interactive and deterministic: fall back to the latest base branch when ff-only is impossible.
      const resetBase = await this.runGit(this.autonomyRepo, ["reset", "--hard", baseRef]);
      if (!resetBase.ok) {
        console.error(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: failed to sync autonomy worktree with ${baseRef}: ${mergeMain.stderr || mergeMain.stdout || `merge exit ${mergeMain.exitCode}`}; reset failed: ${resetBase.stderr || resetBase.stdout || `exit ${resetBase.exitCode}`}`,
        );
        return false;
      }
      console.log(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: ff-only merge ${baseRef} into ${integrationRef} was not possible; reset autonomy worktree to ${baseRef}.`,
      );
    }

    return true;
  }

  private async fetchSnapshot(
    runId: string,
    preflight: {
      isWorktreeDirty: boolean;
      isMergeInProgress: boolean;
    },
  ): Promise<Snapshot | null> {
    const qs = new URLSearchParams({
      sessionId: this.sessionId,
      runId,
      isWorktreeDirty: preflight.isWorktreeDirty ? "true" : "false",
      isMergeInProgress: preflight.isMergeInProgress ? "true" : "false",
    });
    const res = await fetch(`${this.server}/autonomy/snapshot?${qs.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; snapshot?: Snapshot };
    return data.ok ? data.snapshot ?? null : null;
  }

  private async postObjective(payload: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`${this.server}/autonomy/objectives`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    return res.ok;
  }

  private async acquireDispatchLock(runId: string): Promise<boolean> {
    const ttlMs = this.lockTtlMs();
    const res = await fetch(`${this.server}/autonomy/lock/acquire`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        ttlMs,
      }),
    });
    return res.ok;
  }

  private async renewDispatchLock(runId: string): Promise<boolean> {
    const res = await fetch(`${this.server}/autonomy/lock/renew`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        ttlMs: this.lockTtlMs(),
      }),
    });
    return res.ok;
  }

  private async releaseDispatchLock(runId: string): Promise<void> {
    await fetch(`${this.server}/autonomy/lock/release`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
      }),
    }).catch(() => {});
  }

  private async llmPhase(
    phase: "ideation" | "scoring" | "planning",
    runId: string,
    snapshotId: string,
    input: Parameters<LLMClient["generate"]>[0],
    objectiveId?: string,
  ): Promise<{
    json: Record<string, unknown>;
    llmCall: Record<string, unknown>;
  }> {
    const requestPayload = {
      phase,
      system: input.system,
      messages: input.messages,
      json: Boolean(input.json),
      maxTokens: input.maxTokens ?? null,
      temperature: input.temperature ?? null,
    };
    const startedAt = Date.now();
    const output = await withTimeout(
      this.llm.generate(input),
      this.cfg.llmTimeoutMs,
      `autonomy ${phase} phase timeout`,
    );
    const responseJson = parseJsonObject(output.text);
    const tokenUsage = output.usage ?? null;
    return {
      json: responseJson,
      llmCall: {
        id: randomUUID(),
        runId,
        snapshotId,
        ...(objectiveId ? { objectiveId } : {}),
        phase,
        promptTemplateVersion: "autonomy-v3.3",
        promptHash: sha256(`${input.system}\n${JSON.stringify(input.messages ?? [])}`),
        requestPayloadHash: sha256(JSON.stringify(requestPayload)),
        requestPayload,
        promptInputs: {
          system: input.system,
          messages: input.messages ?? [],
        },
        modelId: "configured",
        temperature: input.temperature ?? null,
        timeoutMs: this.cfg.llmTimeoutMs,
        response: responseJson,
        responseHash: sha256(output.text),
        tokenUsage,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  private async enqueueSyntheticRequest(
    instruction: string,
    autonomy: {
      objectiveId: string;
      runId: string;
      snapshotId: string;
      patternKey: string;
      componentArea: AutonomyComponentArea;
      targetPaths: string[];
      writeGlobs: string[];
    },
  ): Promise<string | null> {
    const canonicalInstruction = canonicalizeInstructionTextForBun(instruction);
    const res = await fetch(`${this.server}/requests/enqueue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        prompt: canonicalInstruction,
        priority: "background",
        forceWorker: true,
        forceLane: "worker",
        metadata: {
          origin: "autonomy",
          autonomy: {
            objectiveId: autonomy.objectiveId,
            runId: autonomy.runId,
            snapshotId: autonomy.snapshotId,
            patternKey: autonomy.patternKey,
            componentArea: autonomy.componentArea,
            targetPaths: autonomy.targetPaths,
            writeGlobs: autonomy.writeGlobs,
          },
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; requestId?: string };
    return data.ok && data.requestId ? data.requestId : null;
  }

  private isSnapshotExpired(snapshot: Snapshot): boolean {
    const createdAt = Date.parse(snapshot.snapshot_created_at);
    if (!Number.isFinite(createdAt)) return true;
    return Date.now() > createdAt + snapshot.snapshot_ttl_ms;
  }

  private impactSignalV1(snapshot: Snapshot, candidate: AutonomyCandidate): number {
    const signalsById = new Map(snapshot.top_signals.map((entry) => [entry.signal_id, entry]));
    const signalPool =
      candidate.why_now_signal_ids
        .map((id) => signalsById.get(id))
        .filter((entry): entry is { signal_id: string; type: string; value: number; evidence: string } => Boolean(entry))
        .slice(0, 16) || [];
    const signals = signalPool.length > 0 ? signalPool : snapshot.top_signals.slice(0, 20);
    const maxType = (types: string[]) =>
      clamp01(
        Math.max(
          0,
          ...signals
            .filter((entry) => types.includes(entry.type))
            .map((entry) => asNumber(entry.value, 0)),
        ),
      );
    const fTestFailRecurrence = maxType(["test_failure"]);
    const fLintTypeErrorDensity = maxType(["lint_failure", "typecheck_failure"]);
    const fFlakeRate = clamp01(
      Math.max(
        0,
        ...signals
          .filter((entry) => entry.type === "test_failure")
          .map((entry) => (/flake|flaky/i.test(entry.evidence) ? asNumber(entry.value, 0) : 0)),
      ),
    );
    const fQueueHealthDegradation = maxType(["queue_health"]);
    const fRegretRate24h = maxType(["regret_signal"]);
    return clamp01(
      0.3 * fTestFailRecurrence +
        0.2 * fLintTypeErrorDensity +
        0.2 * fFlakeRate +
        0.15 * fQueueHealthDegradation +
        0.15 * fRegretRate24h,
    );
  }

  private scoreCandidate(snapshot: Snapshot, candidate: AutonomyCandidate, llmScore: number) {
    const patternKey = makePatternKey(
      candidate.objective_type,
      candidate.target_paths,
      candidate.trigger_type,
      candidate.component_area,
    );
    const prior = snapshot.feedback_priors.find((entry) => entry.pattern_key === patternKey);
    const enginePrior = candidate.engine_trial
      ? (snapshot.engine_idea_priors ?? []).find(
          (entry) =>
            asString(entry.engine_building_block_id) ===
            asString(candidate.engine_trial?.building_block_id),
        )
      : null;
    const penalties: Array<{ kind: any; weight: number; reason: string; evidence_ids: string[] }> = [];
    if (candidate.confidence < this.cfg.minConfidence) {
      penalties.push({
        kind: "low_confidence",
        weight: 0.15,
        reason: `candidate confidence ${candidate.confidence.toFixed(2)} < ${this.cfg.minConfidence}`,
        evidence_ids: candidate.why_now_signal_ids,
      });
    }
    const impactSignal = this.impactSignalV1(snapshot, candidate);
    const priorSignal = feedbackPriorSignalForScoring(prior);
    const enginePriorSignal = engineIdeaPriorSignalForScoring(enginePrior);
    const docsWeakEvidencePenalty = docsWeakEvidencePenaltyForImpact(
      candidate.objective_type,
      impactSignal,
    );
    if (docsWeakEvidencePenalty > 0) {
      penalties.push({
        kind: "docs_weak_evidence",
        weight: docsWeakEvidencePenalty,
        reason: `docs candidate impact_signal ${impactSignal.toFixed(2)} below ${DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY.toFixed(2)}`,
        evidence_ids: candidate.why_now_signal_ids,
      });
    }
    const normalizedPenalties = normalizePenalties(penalties);
    const finalScore =
      0.46 * clamp01(llmScore) +
      0.2 * clamp01(impactSignal) +
      priorSignal.priorScore +
      enginePriorSignal.priorScore +
      enginePriorSignal.noveltyBonus -
      penaltyTotal(normalizedPenalties);
    return {
      patternKey,
      impactSignal,
      penalties: normalizedPenalties,
      finalScore,
      emaSuccess: priorSignal.emaSuccess,
      emaUserAccept: priorSignal.emaUserAccept,
      emaLatency: priorSignal.emaLatency,
      emaRegret: priorSignal.emaRegret,
      engineIdeaPriorScore: enginePriorSignal.priorScore,
      engineIdeaNoveltyScore: enginePriorSignal.noveltyScore,
      engineIdeaNoveltyBonus: enginePriorSignal.noveltyBonus,
      engineIdeaSampleCount: enginePriorSignal.sampleCount,
    };
  }

  private async fetchEligibility(
    runId: string,
    snapshotId: string,
    candidates: Array<{
      id: string;
      objective_type: AutonomyObjectiveType;
      component_area: AutonomyComponentArea;
      pattern_key: string;
      confidence: number;
    }>,
  ): Promise<Map<string, { ok: boolean; reason?: string }>> {
    const out = new Map<string, { ok: boolean; reason?: string }>();
    const res = await fetch(`${this.server}/autonomy/eligibility`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        snapshotId,
        candidates,
      }),
    });
    if (!res.ok) {
      for (const candidate of candidates) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
      return out;
    }
    const data = (await res.json()) as {
      ok?: boolean;
      results?: Array<{ candidate_id?: string; candidateId?: string; ok?: boolean; reason?: string }>;
    };
    if (!data.ok || !Array.isArray(data.results)) {
      for (const candidate of candidates) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
      return out;
    }
    for (const row of data.results) {
      const candidateId = asString(row.candidate_id ?? row.candidateId);
      if (!candidateId) continue;
      out.set(candidateId, {
        ok: Boolean(row.ok),
        ...(row.reason ? { reason: asString(row.reason) } : {}),
      });
    }
    for (const candidate of candidates) {
      if (!out.has(candidate.id)) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
    }
    return out;
  }

  private async recordSnapshotExpired(
    runId: string,
    snapshotId: string,
    llmCalls: Record<string, unknown>[],
    candidates: Array<Record<string, unknown>>,
    topCandidate?: Record<string, unknown>,
  ): Promise<void> {
    await this.postObjective({
      runId,
      snapshotId,
      sessionId: this.sessionId,
      candidates: candidates.map((entry) => ({
        ...entry,
        selected: Boolean(topCandidate && entry.id === topCandidate.id),
        rejection_reason: "snapshot_expired",
        gate_decision: "rejected",
        gate_reasons: ["snapshot_expired"],
      })),
      ...(topCandidate
        ? {
            objective: {
              id: `obj_${randomUUID().slice(0, 8)}`,
              candidate_id: topCandidate.id,
              title: topCandidate.title,
              instruction: topCandidate.problem_statement ?? topCandidate.title,
              objective_type: topCandidate.objective_type,
              component_area: topCandidate.component_area,
              trigger_type: topCandidate.trigger_type,
              target_paths: topCandidate.target_paths,
              scope: topCandidate.scope,
              confidence: topCandidate.confidence,
              risk_level: topCandidate.risk_level,
              status: "stale",
              block_reason: "snapshot_expired",
            },
          }
        : {}),
      llmCalls,
    });
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled || this.inFlight) return;
    this.inFlight = true;
    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
    this.markTickStart(runId);
    const cycleDeadline = Date.now() + this.cycleBudgetMs();
    let lockAcquired = false;
    let outcome: "success" | "skipped" | "failed" = "skipped";
    let outcomeDetail = "not_dispatched";
    try {
      this.setPhase("acquire_lock");
      lockAcquired = await this.acquireDispatchLock(runId);
      if (!lockAcquired) {
        outcomeDetail = "lock_not_acquired";
        return;
      }

      this.setPhase("prepare_worktree");
      const ready = await this.ensureAutonomyRepoReady(runId);
      if (!ready) {
        outcomeDetail = "autonomy_repo_not_ready";
        return;
      }

      this.setPhase("repo_preflight");
      const preflight = await repoPreflight(this.autonomyRepo);
      if (preflight.isMergeInProgress) {
        console.log(
          "[RemoteBuddyAutonomousEngine] tick skipped: repo preflight blocked (merge/rebase in progress).",
        );
        outcomeDetail = "repo_preflight_merge_in_progress";
        return;
      }
      if (preflight.isWorktreeDirty && !this.cfg.allowDirtyWorktree) {
        console.log(
          "[RemoteBuddyAutonomousEngine] tick skipped: repo preflight blocked (worktree is dirty and allow_dirty_worktree=false).",
        );
        outcomeDetail = "repo_preflight_dirty_worktree";
        return;
      }

      this.setPhase("fetch_snapshot");
      const snapshot = await this.fetchSnapshot(runId, preflight);
      if (!snapshot) {
        outcomeDetail = "snapshot_unavailable";
        return;
      }

      this.setPhase("load_vision_context");
      const visionContext = this.loadVisionContext(runId);
      if (!visionContext) {
        outcomeDetail = "vision_unavailable";
        return;
      }
      const engineInspiration = buildEngineInspirationContext({
        vision: {
          one_sentence: visionContext.one_sentence,
          key_items: visionContext.key_items,
          section_numbers: visionContext.section_numbers,
        },
        snapshot: {
          top_signals: snapshot.top_signals,
          state_traits: snapshot.state_traits,
          open_objectives: snapshot.open_objectives,
          dispatch_budget: snapshot.dispatch_budget,
        },
      });
      const visionSectionNumberSet = new Set(visionContext.section_numbers);
      const requireVisionSectionRefs = visionSectionNumberSet.size > 0;

      const llmCalls: Record<string, unknown>[] = [];
      let candidatesPayload: Array<Record<string, unknown>> = [];
      let selectedCandidatePayload: Record<string, unknown> | undefined;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired";
        return;
      }

      await this.comm.emit("autonomy_cycle_started", {
        runId,
        snapshotId: snapshot.snapshot_id,
        phase: "ideation",
      });
      this.setPhase("renew_lock_before_ideation");
      if (!(await this.renewDispatchLock(runId))) {
        outcomeDetail = "lock_renew_failed_before_ideation";
        return;
      }

      this.setPhase("ideation");
      const ideationPhase = await this.llmPhase("ideation", runId, snapshot.snapshot_id, {
        system: IDEATION_SYSTEM_PROMPT,
        json: true,
        maxTokens: 2800,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                snapshot: {
                  snapshot_id: snapshot.snapshot_id,
                  top_signals: snapshot.top_signals.slice(0, 16),
                  state_traits: snapshot.state_traits.slice(0, 24),
                  feedback_priors: snapshot.feedback_priors.slice(0, 20),
                  engine_idea_priors: (snapshot.engine_idea_priors ?? []).slice(0, 20),
                  open_objectives: snapshot.open_objectives.slice(0, 20),
                  active_cooldowns: snapshot.active_cooldowns.slice(0, 20),
                },
                vision: visionContext,
                engine_inspiration: engineInspiration,
                limits: {
                  ideation_max_candidates: this.cfg.ideationMaxCandidates,
                  min_confidence: this.cfg.minConfidence,
                },
              },
              null,
              2,
            ),
          },
        ],
      });
      llmCalls.push(ideationPhase.llmCall);
      const ideationJson = ideationPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_ideation";
        return;
      }
      let rawCandidates = Array.isArray(ideationJson.candidates) ? ideationJson.candidates : [];
      if (rawCandidates.length === 0) {
        const synthesized = buildEngineFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
        });
        if (synthesized.length > 0) {
          console.log(
            `[RemoteBuddyAutonomousEngine] tick ${runId}: ideation returned no candidates; using ${synthesized.length} deterministic engine-inspiration fallback candidates.`,
          );
          rawCandidates = synthesized;
        }
      }
      const normalizedCandidates: AutonomyCandidate[] = [];
      const dropReasonCounts = new Map<string, number>();
      const recordDropReason = (reason: string): void => {
        dropReasonCounts.set(reason, (dropReasonCounts.get(reason) ?? 0) + 1);
      };
      const ingestRawCandidates = (
        rawList: unknown[],
        source: "llm" | "engine_fallback",
      ): void => {
        const candidateCreatedBaseMs = Date.now();
        for (const [candidateIndex, rawCandidate] of rawList
          .slice(0, this.cfg.ideationMaxCandidates)
          .entries()) {
          const c = asObject(rawCandidate);
          const triggerType = asString(c.trigger_type);
          if (!isTriggerType(triggerType)) {
            recordDropReason(`${source}_invalid_trigger_type`);
            continue;
          }
          const candidate: AutonomyCandidate = {
            id: asString(c.id) || `cand_${randomUUID().slice(0, 8)}`,
            title: asString(c.title),
            objective_type: asString(c.objective_type) as AutonomyObjectiveType,
            problem_statement: asString(c.problem_statement),
            trigger_type: triggerType,
            component_area: asString(c.component_area) as AutonomyComponentArea,
            target_paths: asStringArray(c.target_paths),
            scope: {
              read_anywhere: asBoolean(asObject(c.scope).read_anywhere, false),
              write_globs: asStringArray(asObject(c.scope).write_globs),
            },
            risk_level: asString(c.risk_level) as "low" | "medium" | "high",
            expected_validation: asStringArray(c.expected_validation)
              .map((command) => canonicalizeValidationCommandForBun(command))
              .filter(Boolean),
            estimated_effort: asString(c.estimated_effort) as "small" | "medium" | "large",
            why_now_signal_ids: asStringArray(c.why_now_signal_ids),
            confidence: clamp01(asNumber(c.confidence, 0)),
            vision_alignment_reason: asString(c.vision_alignment_reason),
            vision_section_refs: normalizeVisionSectionRefs(
              asStringArray(c.vision_section_refs),
              visionSectionNumberSet,
            ),
            feature_hypotheses: asStringArray(c.feature_hypotheses).slice(0, 24),
            requires_user_input: asBoolean(c.requires_user_input, false),
            question_if_blocked: asString(c.question_if_blocked),
            candidate_created_at: new Date(candidateCreatedBaseMs + candidateIndex).toISOString(),
            engine_trial:
              normalizeEngineTrialMetadata(c.engine_trial ?? c.engineTrial ?? asObject(c.debug).engine_trial) ??
              undefined,
          };
          const policy = POLICY[candidate.objective_type];
          if (!policy || !policy.autonomousAllowed) {
            recordDropReason(`${source}_objective_type_not_allowed`);
            continue;
          }
          if (!isRiskLevel(candidate.risk_level)) {
            recordDropReason(`${source}_invalid_risk_level`);
            continue;
          }
          if (RISK_ORDER[candidate.risk_level] > RISK_ORDER[policy.maxRisk]) {
            recordDropReason(`${source}_risk_exceeds_policy`);
            continue;
          }
          const scopeValidation = validateScopeInvariants(
            candidate.component_area,
            candidate.target_paths,
            candidate.scope.write_globs,
            { requireWriteGlobs: true },
          );
          if (!scopeValidation.ok) {
            recordDropReason(`${source}_scope_validation_failed`);
            continue;
          }
          if (BREADTH_ORDER[scopeValidation.breadth] > BREADTH_ORDER[policy.maxBreadth]) {
            recordDropReason(`${source}_scope_breadth_exceeds_policy`);
            continue;
          }
          if (candidate.scope.read_anywhere && !this.cfg.allowReadAnywhere) {
            recordDropReason(`${source}_read_anywhere_not_allowed`);
            continue;
          }
          if (policy.requireValidation && candidate.expected_validation.length === 0) {
            recordDropReason(`${source}_missing_validation_steps`);
            continue;
          }
          if (!candidate.vision_alignment_reason) {
            recordDropReason(`${source}_missing_vision_alignment_reason`);
            continue;
          }
          if (requireVisionSectionRefs && candidate.vision_section_refs.length === 0) {
            recordDropReason(`${source}_missing_vision_section_refs`);
            continue;
          }
          candidate.target_paths = scopeValidation.normalizedTargetPaths;
          candidate.scope.write_globs = scopeValidation.normalizedWriteGlobs;
          if (!candidate.engine_trial) {
            const inferred = inferEngineTrialFromCandidate(candidate, engineInspiration);
            if (inferred) {
              candidate.engine_trial = {
                ...inferred,
                source: source === "engine_fallback" ? "engine_fallback" : inferred.source,
              };
            }
          }
          normalizedCandidates.push(candidate);
        }
      };
      ingestRawCandidates(rawCandidates, "llm");
      if (normalizedCandidates.length === 0) {
        const synthesizedFallback = buildEngineFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
        });
        if (synthesizedFallback.length > 0) {
          ingestRawCandidates(synthesizedFallback, "engine_fallback");
        }
      }
      candidatesPayload = normalizedCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        objective_type: candidate.objective_type,
        problem_statement: candidate.problem_statement,
        trigger_type: candidate.trigger_type,
        component_area: candidate.component_area,
        target_paths: candidate.target_paths,
        scope: candidate.scope,
        risk_level: candidate.risk_level,
        expected_validation: candidate.expected_validation,
        estimated_effort: candidate.estimated_effort,
        why_now_signal_ids: candidate.why_now_signal_ids,
        confidence: candidate.confidence,
        vision_alignment_reason: candidate.vision_alignment_reason,
        vision_section_refs: candidate.vision_section_refs,
        feature_hypotheses: candidate.feature_hypotheses,
        ...(candidate.engine_trial ? { engine_trial: candidate.engine_trial } : {}),
        gate_decision: "proposed",
        gate_reasons: [],
        candidate_created_at: candidate.candidate_created_at,
      }));
      if (normalizedCandidates.length === 0) {
        const dropReasons = Object.fromEntries(
          [...dropReasonCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
        );
        const topSignals = snapshot.top_signals
          .slice(0, 3)
          .map((signal) => `${signal.signal_id}:${Number(signal.value ?? 0).toFixed(2)}`)
          .join(", ");
        const parseHint =
          rawCandidates.length === 0 && Object.keys(ideationJson).length === 0
            ? " (ideation returned empty or non-parseable JSON)"
            : "";
        console.log(
          `[RemoteBuddyAutonomousEngine] tick produced no eligible candidates: raw=${rawCandidates.length} normalized=0 drop_reasons=${JSON.stringify(dropReasons)} top_signals=${topSignals || "none"}${parseHint}`,
        );
        this.setPhase("record_no_candidate_objective");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          llmCalls,
        });
        outcomeDetail = "no_eligible_candidates";
        return;
      }
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_post_ideation_filter";
        return;
      }
      this.setPhase("renew_lock_before_scoring");
      if (!(await this.renewDispatchLock(runId))) {
        outcomeDetail = "lock_renew_failed_before_scoring";
        return;
      }

      this.setPhase("scoring");
      const scoringPhase = await this.llmPhase("scoring", runId, snapshot.snapshot_id, {
        system: SCORING_SYSTEM_PROMPT,
        json: true,
        maxTokens: 1400,
        temperature: 0.1,
        messages: [
          {
            role: "user",
            content: JSON.stringify({ candidates: normalizedCandidates, top_k: this.cfg.topK }),
          },
        ],
      });
      llmCalls.push(scoringPhase.llmCall);
      const scoringJson = scoringPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_scoring";
        return;
      }
      const scoreById = new Map<string, number>();
      for (const rawScore of Array.isArray(scoringJson.scores) ? scoringJson.scores : []) {
        const s = asObject(rawScore);
        const id = asString(s.id);
        if (!id) continue;
        scoreById.set(id, clamp01(asNumber(s.llm_score, 0)));
      }

      const scored = normalizedCandidates.map((candidate) => {
        const llmScore = scoreById.get(candidate.id) ?? 0;
        const scoredCandidate = this.scoreCandidate(snapshot, candidate, llmScore);
        return { candidate, llmScore, ...scoredCandidate };
      });
      scored.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        if (a.candidate.candidate_created_at !== b.candidate.candidate_created_at) {
          return a.candidate.candidate_created_at.localeCompare(b.candidate.candidate_created_at);
        }
        return a.candidate.id.localeCompare(b.candidate.id);
      });

      const eligibilityById = await this.fetchEligibility(
        runId,
        snapshot.snapshot_id,
        scored.map((row) => ({
          id: row.candidate.id,
          objective_type: row.candidate.objective_type,
          component_area: row.candidate.component_area,
          pattern_key: row.patternKey,
          confidence: row.candidate.confidence,
        })),
      );
      const rankedWithEligibility = scored.map((row) => ({
        ...row,
        eligibility: eligibilityById.get(row.candidate.id) ?? {
          ok: false,
          reason: "eligibility_unavailable",
        },
      }));
      candidatesPayload = rankedWithEligibility.map((row) => ({
        id: row.candidate.id,
        title: row.candidate.title,
        objective_type: row.candidate.objective_type,
        problem_statement: row.candidate.problem_statement,
        trigger_type: row.candidate.trigger_type,
        component_area: row.candidate.component_area,
        target_paths: row.candidate.target_paths,
        scope: row.candidate.scope,
        risk_level: row.candidate.risk_level,
        expected_validation: row.candidate.expected_validation,
        estimated_effort: row.candidate.estimated_effort,
        why_now_signal_ids: row.candidate.why_now_signal_ids,
        confidence: row.candidate.confidence,
        vision_alignment_reason: row.candidate.vision_alignment_reason,
        vision_section_refs: row.candidate.vision_section_refs,
        feature_hypotheses: row.candidate.feature_hypotheses,
        ...(row.candidate.engine_trial ? { engine_trial: row.candidate.engine_trial } : {}),
        llm_score: row.llmScore,
        impact_signal: row.impactSignal,
        ema_success: row.emaSuccess,
        ema_user_accept: row.emaUserAccept,
        engine_idea_prior_score: row.engineIdeaPriorScore,
        engine_idea_novelty_score: row.engineIdeaNoveltyScore,
        engine_idea_novelty_bonus: row.engineIdeaNoveltyBonus,
        engine_idea_sample_count: row.engineIdeaSampleCount,
        penalties: row.penalties,
        final_score: row.finalScore,
        gate_decision: row.eligibility.ok ? "approved" : "rejected",
        gate_reasons: row.eligibility.ok ? [] : [row.eligibility.reason],
        selected: false,
        selection_strategy: "not_selected",
        candidate_created_at: row.candidate.candidate_created_at,
      }));
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_eligibility";
        return;
      }
      this.setPhase("renew_lock_before_selection");
      if (!(await this.renewDispatchLock(runId))) {
        outcomeDetail = "lock_renew_failed_before_selection";
        return;
      }
      const top = rankedWithEligibility[0];
      if (!top) {
        outcomeDetail = "no_ranked_candidate";
        return;
      }
      const eligibleRows = rankedWithEligibility.filter((row) => row.eligibility.ok);
      const selection = pickCandidateWithExploreExploit({
        rows: eligibleRows.map((row) => ({
          id: row.candidate.id,
          finalScore: row.finalScore,
          noveltyScore: row.engineIdeaNoveltyScore,
        })),
        seed: `${runId}:${snapshot.snapshot_id}:${snapshot.snapshot_created_at}`,
        exploreRate: this.cfg.exploreRate,
      });
      const selected = selection.selected
        ? eligibleRows.find((row) => row.candidate.id === selection.selected?.id)
        : undefined;
      const selectedStrategy = selected ? selection.strategy : "exploit";
      const objectiveId = `obj_${randomUUID().slice(0, 8)}`;
      selectedCandidatePayload = selected
        ? {
            id: selected.candidate.id,
            title: selected.candidate.title,
            objective_type: selected.candidate.objective_type,
            problem_statement: selected.candidate.problem_statement,
            trigger_type: selected.candidate.trigger_type,
            component_area: selected.candidate.component_area,
            target_paths: selected.candidate.target_paths,
            scope: selected.candidate.scope,
            risk_level: selected.candidate.risk_level,
            confidence: selected.candidate.confidence,
            vision_alignment_reason: selected.candidate.vision_alignment_reason,
            vision_section_refs: selected.candidate.vision_section_refs,
            feature_hypotheses: selected.candidate.feature_hypotheses,
            ...(selected.candidate.engine_trial ? { engine_trial: selected.candidate.engine_trial } : {}),
            selection_strategy: selectedStrategy,
          }
        : {
            id: top.candidate.id,
            title: top.candidate.title,
            objective_type: top.candidate.objective_type,
            problem_statement: top.candidate.problem_statement,
            trigger_type: top.candidate.trigger_type,
            component_area: top.candidate.component_area,
            target_paths: top.candidate.target_paths,
            scope: top.candidate.scope,
            risk_level: top.candidate.risk_level,
            confidence: top.candidate.confidence,
            vision_alignment_reason: top.candidate.vision_alignment_reason,
            vision_section_refs: top.candidate.vision_section_refs,
            feature_hypotheses: top.candidate.feature_hypotheses,
            ...(top.candidate.engine_trial ? { engine_trial: top.candidate.engine_trial } : {}),
            selection_strategy: "none",
          };
      for (const row of candidatesPayload) {
        const isSelected = Boolean(row.id === selectedCandidatePayload.id);
        row.selected = isSelected;
        row.selection_strategy = isSelected && selected ? selectedStrategy : "not_selected";
      }

      if (!selected) {
        this.setPhase("record_rejected_objective");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: top.candidate.id,
            title: top.candidate.title,
            instruction: top.candidate.problem_statement,
            objective_type: top.candidate.objective_type,
            component_area: top.candidate.component_area,
            trigger_type: top.candidate.trigger_type,
            target_paths: top.candidate.target_paths,
            scope: top.candidate.scope,
            confidence: top.candidate.confidence,
            risk_level: top.candidate.risk_level,
            status: "rejected",
            block_reason: top.eligibility.reason ?? "no eligible candidate",
            score_breakdown: {
              llm_score: top.llmScore,
              impact_signal: top.impactSignal,
              penalties: top.penalties,
              ema_success: top.emaSuccess,
              ema_user_accept: top.emaUserAccept,
              engine_idea_prior_score: top.engineIdeaPriorScore,
              engine_idea_novelty_score: top.engineIdeaNoveltyScore,
              engine_idea_novelty_bonus: top.engineIdeaNoveltyBonus,
              engine_idea_sample_count: top.engineIdeaSampleCount,
              final_score: top.finalScore,
              selection_strategy: "none",
            },
          },
          llmCalls,
        });
        outcomeDetail = "no_eligible_candidate";
        return;
      }

      if (selected.candidate.requires_user_input) {
        this.setPhase("record_blocked_requires_input");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: selected.candidate.id,
            title: selected.candidate.title,
            instruction: selected.candidate.problem_statement,
            objective_type: selected.candidate.objective_type,
            component_area: selected.candidate.component_area,
            trigger_type: selected.candidate.trigger_type,
            target_paths: selected.candidate.target_paths,
            scope: selected.candidate.scope,
            confidence: selected.candidate.confidence,
            risk_level: selected.candidate.risk_level,
            status: "blocked",
            block_reason: "requires_user_input",
            score_breakdown: {
              llm_score: selected.llmScore,
              impact_signal: selected.impactSignal,
              penalties: selected.penalties,
              ema_success: selected.emaSuccess,
              ema_user_accept: selected.emaUserAccept,
              engine_idea_prior_score: selected.engineIdeaPriorScore,
              engine_idea_novelty_score: selected.engineIdeaNoveltyScore,
              engine_idea_novelty_bonus: selected.engineIdeaNoveltyBonus,
              engine_idea_sample_count: selected.engineIdeaSampleCount,
              final_score: selected.finalScore,
              selection_strategy: selectedStrategy,
            },
          },
          question: {
            question:
              selected.candidate.question_if_blocked ||
              "Please confirm objective scope and constraints.",
            question_type: "bounded_text",
            expected_answer_schema: { min_length: 3, max_length: 1000 },
          },
          llmCalls,
        });
        outcomeDetail = "requires_user_input";
        return;
      }
      this.setPhase("renew_lock_before_planning");
      if (!(await this.renewDispatchLock(runId))) {
        outcomeDetail = "lock_renew_failed_before_planning";
        return;
      }

      this.setPhase("planning");
      const planningPhase = await this.llmPhase(
        "planning",
        runId,
        snapshot.snapshot_id,
        {
          system: PLANNING_SYSTEM_PROMPT,
          json: true,
          maxTokens: 800,
          temperature: 0.1,
          messages: [
            {
              role: "user",
              content: JSON.stringify({ candidate: selected.candidate }),
            },
          ],
        },
        objectiveId,
      );
      llmCalls.push(planningPhase.llmCall);
      const planningJson = planningPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(
          runId,
          snapshot.snapshot_id,
          llmCalls,
          candidatesPayload,
          selectedCandidatePayload,
        );
        outcomeDetail = "snapshot_expired_after_planning";
        return;
      }
      this.setPhase("renew_lock_before_enqueue");
      if (!(await this.renewDispatchLock(runId))) {
        outcomeDetail = "lock_renew_failed_before_enqueue";
        return;
      }
      const instruction = canonicalizeInstructionTextForBun(
        asString(planningJson.instruction) ||
          `${selected.candidate.title}\n\n${selected.candidate.problem_statement}\n\nScope:\n- target_paths: ${selected.candidate.target_paths.join(
            ", ",
          )}\n- write_globs: ${selected.candidate.scope.write_globs.join(", ")}`,
      );

      this.setPhase("enqueue_request");
      const requestId = await this.enqueueSyntheticRequest(instruction, {
        objectiveId,
        runId,
        snapshotId: snapshot.snapshot_id,
        patternKey: selected.patternKey,
        componentArea: selected.candidate.component_area,
        targetPaths: selected.candidate.target_paths,
        writeGlobs: selected.candidate.scope.write_globs,
      });
      if (!requestId) {
        this.setPhase("record_failed_enqueue");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: selected.candidate.id,
            title: selected.candidate.title,
            instruction,
            objective_type: selected.candidate.objective_type,
            component_area: selected.candidate.component_area,
            trigger_type: selected.candidate.trigger_type,
            target_paths: selected.candidate.target_paths,
            scope: selected.candidate.scope,
            confidence: selected.candidate.confidence,
            risk_level: selected.candidate.risk_level,
            status: "failed",
            block_reason: "request_enqueue_failed",
          },
          llmCalls,
        });
        outcomeDetail = "request_enqueue_failed";
        return;
      }

      this.setPhase("record_dispatched_objective");
      await this.postObjective({
        runId,
        snapshotId: snapshot.snapshot_id,
        sessionId: this.sessionId,
        candidates: candidatesPayload,
        objective: {
          id: objectiveId,
          candidate_id: selected.candidate.id,
          title: selected.candidate.title,
          instruction,
          objective_type: selected.candidate.objective_type,
          component_area: selected.candidate.component_area,
          trigger_type: selected.candidate.trigger_type,
          target_paths: selected.candidate.target_paths,
          scope: selected.candidate.scope,
          confidence: selected.candidate.confidence,
          risk_level: selected.candidate.risk_level,
          status: "dispatched",
          request_id: requestId,
          score_breakdown: {
            llm_score: selected.llmScore,
            impact_signal: selected.impactSignal,
            penalties: selected.penalties,
            ema_success: selected.emaSuccess,
            ema_user_accept: selected.emaUserAccept,
            engine_idea_prior_score: selected.engineIdeaPriorScore,
            engine_idea_novelty_score: selected.engineIdeaNoveltyScore,
            engine_idea_novelty_bonus: selected.engineIdeaNoveltyBonus,
            engine_idea_sample_count: selected.engineIdeaSampleCount,
            final_score: selected.finalScore,
            selection_strategy: selectedStrategy,
          },
        },
        llmCalls,
      });
      outcome = "success";
      outcomeDetail = `dispatched_request_${requestId.slice(0, 8)}`;
    } catch (error) {
      console.error("[RemoteBuddyAutonomousEngine] tick failed:", error);
      outcome = "failed";
      outcomeDetail = `error:${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (lockAcquired) await this.releaseDispatchLock(runId);
      this.inFlight = false;
      this.markTickDone(outcome, outcomeDetail);
    }
  }

  /**
   * Re-enqueue a synthetic worker request based on an analysis result from the orchestrator.
   * Called by the orchestrator when a user/engine request was classified as `analysis` intent
   * and the autonomous engine should decide the next step.
   */
  async enqueueFromAnalysis(
    instruction: string,
    autonomyCtx: {
      objectiveId?: string;
      runId?: string;
      snapshotId?: string;
      patternKey?: string;
      componentArea?: string;
      targetPaths: string[];
      writeGlobs: string[];
    },
    originRequestId: string,
  ): Promise<string | null> {
    if (!this.cfg.enabled) return null;
    const objectiveId = autonomyCtx.objectiveId ?? `obj_${originRequestId.slice(0, 8)}`;
    const runId = autonomyCtx.runId ?? `run_${Date.now()}_${originRequestId.slice(0, 8)}`;
    const snapshotId = autonomyCtx.snapshotId ?? `snap_analysis_${originRequestId.slice(0, 8)}`;
    const patternKey = autonomyCtx.patternKey ?? "analysis_followup";
    console.log(
      `[RemoteBuddyAutonomousEngine] Enqueuing analysis follow-up (objective ${objectiveId})`,
    );
    return this.enqueueSyntheticRequest(instruction, {
      objectiveId,
      runId,
      snapshotId,
      patternKey,
      componentArea: (autonomyCtx.componentArea ?? "shared") as AutonomyComponentArea,
      targetPaths: autonomyCtx.targetPaths,
      writeGlobs: autonomyCtx.writeGlobs,
    });
  }

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    console.log(
      `[RemoteBuddyAutonomousEngine] Using dedicated autonomy worktree ${this.autonomyRepo} (remote=${this.gitRemote} integration=${this.integrationBranch} base=${this.baseBranch}).`,
    );
    this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
    this.timer = setInterval(() => {
      this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
      void this.tick();
    }, this.cfg.tickIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      this.logHeartbeat();
    }, this.cfg.heartbeatLogMs);
    this.logHeartbeat();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.nextTickAtMs = 0;
  }
}
