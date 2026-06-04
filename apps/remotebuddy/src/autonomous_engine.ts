import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import type { CommunicationManager } from "shared";
import {
  extractVisionKeyItems,
  loadRepoDocText,
  loadPromptTemplate,
  makePatternKey,
  normalizeAutonomyComponentArea,
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
  trigger_type:
    | "test_failure"
    | "lint_failure"
    | "typecheck_failure"
    | "queue_health"
    | "regret_signal";
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
    source_key?: string;
    source_type?: string;
    source_label?: string;
    source_url?: string;
    source_fingerprint?: string;
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
  engine_source_priors?: Array<{
    source_key: string;
    source_type: string;
    source_label?: string | null;
    source_url?: string | null;
    source_fingerprint?: string | null;
    source_algorithm: string;
    curation_status?: string;
    curation_reason?: string | null;
    trust_score?: number;
    freshness_score?: number;
    last_reinforced_at?: string | null;
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
    by_component_count_last_hour?: Record<string, number>;
  };
  resource_budget?: {
    token_usage_last_hour?: number;
    runtime_ms_last_hour?: number;
    token_budget_per_hour?: number;
    runtime_budget_ms_per_hour?: number;
    token_budget_exhausted?: boolean;
    runtime_budget_exhausted?: boolean;
  };
  safety_state?: {
    kill_switch_enabled?: boolean;
    freeze_until?: string | null;
    freeze_reason?: string | null;
    is_frozen?: boolean;
  };
  evaluator?: {
    recommendation?: string;
    sample_count?: number;
    success_rate?: number | null;
    regret_rate?: number | null;
    created_at?: string | null;
  };
};

type WorkerLoadSnapshot = {
  workers: {
    total: number;
    online: number;
    busy: number;
    idle: number;
  };
  jobs: {
    pending: number;
    claimed: number;
    autoscalablePending: number;
  };
  prs: {
    openUnmerged: number;
  };
};

type IdeationTimeoutRecovery = {
  previousRunId: string;
  timedOutAt: string;
  timeoutMs: number;
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
const IDEATION_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_ideation_system_prompt.md",
).trim();

const SCORING_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_scoring_system_prompt.md",
).trim();

const PLANNING_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/autonomy_planning_system_prompt.md",
).trim();
const IDEATION_TIMEOUT_RECOVERY_INSTRUCTION =
  "Previous ideation timed out before you returned JSON. For this round only, stay within the time budget: prioritize the top 1-3 highest-confidence candidates, keep reasoning brief, avoid exhaustive exploration, and return valid JSON as soon as possible.";
const IDEATION_NORMAL_MAX_TOKENS = 1_800;
const IDEATION_RETRY_MAX_TOKENS = 900;
const IDEATION_NORMAL_MAX_CANDIDATES = 5;
const STARTUP_FAST_TICK_MAX_ATTEMPTS = 4;
const STARTUP_FAST_TICK_MAX_DELAY_MS = 15_000;
const STARTUP_STALE_LOCK_AFTER_MS = 30_000;
const VISION_DOC_FNAME = "vision.md";
const MAX_VISION_SECTION_CHARS = 1_200;
const DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY = 0.45;
const DOCS_WEAK_EVIDENCE_MAX_PENALTY = 0.12;
const ENGINE_EXPLORE_RATE_DEFAULT = 0.3;
const ENGINE_EXPLORE_RATE_MIN = 0.1;
const ENGINE_EXPLORE_RATE_MAX = 0.6;
const ENGINE_NOVELTY_SAMPLE_SATURATION = 12;
const ENGINE_EXPLORE_POOL_MAX = 3;
const ADJACENT_POSSIBLE_DEFAULT_MAX_IDEAS = 3;
const ADJACENT_POSSIBLE_MAX_IDEAS = 5;
const ADJACENT_POSSIBLE_MIN_SIGNAL = 0.2;
const ADJACENT_POSSIBLE_MIN_GAP_SCORE = 0.25;
const ADJACENT_POSSIBLE_NOVELTY_DIVISOR = ENGINE_NOVELTY_SAMPLE_SATURATION;
const ADJACENT_POSSIBLE_GAP_WEIGHT = 0.5;
const ADJACENT_POSSIBLE_SIGNAL_WEIGHT = 0.3;
const ADJACENT_POSSIBLE_NOVELTY_WEIGHT = 0.12;
const ADJACENT_POSSIBLE_COVERAGE_BOOST = 0.08;
const AUTO_INGEST_SEED_PATTERNS: Array<{
  algorithm: string;
  whenToUse: string;
  summary: string;
  tags: string[];
  risks: string[];
  validation: string[];
  qualityScore: number;
  freshnessScore: number;
}> = [
  {
    algorithm: "autonomy_dispatch_backpressure_guard",
    whenToUse: "when worker saturation and queue latency rise together",
    summary:
      "Throttle autonomous dispatch based on queue pressure and available idle worker capacity to reduce thrash.",
    tags: ["queue", "backpressure", "scheduling", "autonomy"],
    risks: ["Over-throttling can starve high-value opportunities."],
    validation: [
      "Replay queue snapshots and confirm p95 latency improves without collapsing throughput.",
    ],
    qualityScore: 0.78,
    freshnessScore: 0.82,
  },
  {
    algorithm: "objective_scope_guardrail_feedback_loop",
    whenToUse: "when autonomous outcomes show repeated rework or scope drift",
    summary:
      "Use outcome feedback to tighten candidate scope defaults and reduce broad write targets for risky components.",
    tags: ["scope", "safety", "guardrails", "regret"],
    risks: ["Can become too conservative and suppress beneficial fixes."],
    validation: ["Compare regret/reopen rate before and after scope guardrail adjustments."],
    qualityScore: 0.74,
    freshnessScore: 0.8,
  },
  {
    algorithm: "engine_novelty_explore_exploit_tuner",
    whenToUse: "when engine ideas overfit a small set of previously successful patterns",
    summary:
      "Adapt exploration rate using recent regret pressure and prior diversity to balance reliability with novelty.",
    tags: ["bandit", "explore-exploit", "novelty", "engine"],
    risks: ["Too much exploration can increase failed dispatches."],
    validation: [
      "Track novelty diversity and successful dispatch rate across rolling 24h windows.",
    ],
    qualityScore: 0.76,
    freshnessScore: 0.79,
  },
];

type SourceCurationStatus = "candidate" | "trusted" | "watchlist" | "archived";

type FeedbackPriorForScoring =
  | {
      ema_success?: unknown;
      ema_user_accept?: unknown;
      ema_latency?: unknown;
      ema_regret?: unknown;
    }
  | null
  | undefined;

type EngineIdeaPriorForScoring =
  | {
      ema_success?: unknown;
      ema_user_accept?: unknown;
      ema_latency?: unknown;
      ema_regret?: unknown;
      sample_count?: unknown;
    }
  | null
  | undefined;

type EngineSourcePriorForScoring =
  | {
      ema_success?: unknown;
      ema_user_accept?: unknown;
      ema_latency?: unknown;
      ema_regret?: unknown;
      sample_count?: unknown;
      curation_status?: unknown;
      curation_reason?: unknown;
      trust_score?: unknown;
      freshness_score?: unknown;
    }
  | null
  | undefined;

type AdaptiveExploreRateSnapshot = {
  top_signals?: Array<{ type?: unknown; value?: unknown }>;
  feedback_priors?: Array<{
    ema_success?: unknown;
    ema_user_accept?: unknown;
    ema_regret?: unknown;
    sample_count?: unknown;
  }>;
  engine_idea_priors?: Array<{ sample_count?: unknown }>;
  engine_source_priors?: Array<{ sample_count?: unknown }>;
};

export function docsWeakEvidencePenaltyForImpact(
  objectiveType: string,
  impactSignal: number,
): number {
  if (objectiveType !== "docs") return 0;
  const normalizedImpact = clamp01(impactSignal);
  if (normalizedImpact >= DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY) return 0;
  const gapRatio =
    (DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY - normalizedImpact) /
    DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY;
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
    0.12 * emaSuccess + 0.08 * emaUserAccept + 0.06 * emaLatency + 0.04 * (1 - emaRegret);
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
    0.08 * emaSuccess + 0.05 * emaUserAccept + 0.03 * emaLatency + 0.02 * (1 - emaRegret);
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

export function engineSourcePriorSignalForScoring(prior: EngineSourcePriorForScoring): {
  emaSuccess: number;
  emaUserAccept: number;
  emaLatency: number;
  emaRegret: number;
  sampleCount: number;
  noveltyScore: number;
  priorScore: number;
  noveltyBonus: number;
  curationStatus: SourceCurationStatus;
  curationReason: string;
  trustScore: number;
  freshnessScore: number;
  trustBoost: number;
  curationPenalty: number;
} {
  const sampleCount = Math.max(0, Math.floor(asNumber(prior?.sample_count, 0)));
  const curationStatus = normalizeSourceCurationStatus(prior?.curation_status);
  const curationReason = asString(prior?.curation_reason);
  const trustScore = clamp01(asNumber(prior?.trust_score, 0));
  const freshnessScore = clamp01(asNumber(prior?.freshness_score, sampleCount > 0 ? 0.7 : 0.5));
  if (sampleCount === 0) {
    return {
      emaSuccess: 0,
      emaUserAccept: 0,
      emaLatency: 0,
      emaRegret: 0,
      sampleCount: 0,
      noveltyScore: 1,
      priorScore: 0,
      noveltyBonus: 0.03,
      curationStatus,
      curationReason,
      trustScore,
      freshnessScore,
      trustBoost: 0,
      curationPenalty:
        curationStatus === "archived" ? 0.14 : curationStatus === "watchlist" ? 0.05 : 0,
    };
  }
  const emaSuccess = clamp01(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp01(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp01(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp01(asNumber(prior?.ema_regret, 0));
  const noveltyScore = 1 - clamp01(sampleCount / ENGINE_NOVELTY_SAMPLE_SATURATION);
  const rawPriorScore =
    0.06 * emaSuccess + 0.04 * emaUserAccept + 0.03 * emaLatency + 0.02 * (1 - emaRegret);
  const priorScore = rawPriorScore * (0.45 + 0.55 * freshnessScore);
  const trustBoost = curationStatus === "trusted" ? 0.04 * Math.max(trustScore, 0.6) : 0;
  const curationPenalty =
    curationStatus === "archived" ? 0.14 : curationStatus === "watchlist" ? 0.05 : 0;
  const noveltyBonus = curationStatus === "archived" ? 0 : 0.03 * noveltyScore;
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    sampleCount,
    noveltyScore,
    priorScore,
    noveltyBonus,
    curationStatus,
    curationReason,
    trustScore,
    freshnessScore,
    trustBoost,
    curationPenalty,
  };
}

function normalizeSourceCurationStatus(value: unknown): SourceCurationStatus {
  const raw = asString(value).toLowerCase();
  if (raw === "trusted") return "trusted";
  if (raw === "watchlist") return "watchlist";
  if (raw === "archived") return "archived";
  return "candidate";
}

function deriveInspirationSourceKey(params: {
  sourceFingerprint?: string | null;
  sourceType?: string | null;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
}): string {
  const fingerprint = asString(params.sourceFingerprint);
  if (fingerprint) return `fingerprint:${fingerprint.toLowerCase()}`;
  const sourceType = asString(params.sourceType).toLowerCase();
  const sourceLabel = asString(params.sourceLabel).toLowerCase();
  const sourceUrl = asString(params.sourceUrl).toLowerCase();
  if (!sourceType && !sourceLabel && !sourceUrl) return "";
  return `source:${createHash("sha256")
    .update([sourceType, sourceLabel, sourceUrl].join("|"))
    .digest("hex")}`;
}

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value <= min) return min;
  if (value >= max) return max;
  return value;
}

export function computeAdaptiveExploreRate(params: {
  baseRate?: number;
  minRate?: number;
  maxRate?: number;
  snapshot: AdaptiveExploreRateSnapshot;
}): {
  baseRate: number;
  effectiveRate: number;
  adjustment: number;
  regretSignal: number;
  revisionPressure: number;
  stability: number;
  diversityDeficit: number;
} {
  const baseRate = clamp01(asNumber(params.baseRate, ENGINE_EXPLORE_RATE_DEFAULT));
  const minRate = clamp01(asNumber(params.minRate, ENGINE_EXPLORE_RATE_MIN));
  const maxRate = clamp01(asNumber(params.maxRate, ENGINE_EXPLORE_RATE_MAX));
  const lowerBound = Math.min(minRate, maxRate);
  const upperBound = Math.max(minRate, maxRate);

  const topSignals = Array.isArray(params.snapshot.top_signals) ? params.snapshot.top_signals : [];
  const regretSignal = clamp01(
    Math.max(
      0,
      ...topSignals
        .filter((entry) => asString(entry.type).toLowerCase() === "regret_signal")
        .map((entry) => asNumber(entry.value, 0)),
    ),
  );
  const queuePressure = clamp01(
    Math.max(
      0,
      ...topSignals
        .filter((entry) => asString(entry.type).toLowerCase() === "queue_health")
        .map((entry) => asNumber(entry.value, 0)),
    ),
  );

  const feedback = Array.isArray(params.snapshot.feedback_priors)
    ? params.snapshot.feedback_priors
    : [];
  let weightedTotal = 0;
  let weightedSuccess = 0;
  let weightedUserAccept = 0;
  let weightedRegret = 0;
  for (const prior of feedback) {
    const weight = Math.max(1, Math.floor(asNumber(prior.sample_count, 1)));
    weightedTotal += weight;
    weightedSuccess += weight * clamp01(asNumber(prior.ema_success, 0));
    weightedUserAccept += weight * clamp01(asNumber(prior.ema_user_accept, 0));
    weightedRegret += weight * clamp01(asNumber(prior.ema_regret, 0));
  }
  const avgSuccess = weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
  const avgUserAccept = weightedTotal > 0 ? weightedUserAccept / weightedTotal : 0;
  const avgRegret = weightedTotal > 0 ? weightedRegret / weightedTotal : 0;
  const revisionPressure = clamp01(1 - avgUserAccept);
  const stability = clamp01(0.65 * avgSuccess + 0.35 * (1 - avgRegret));

  const engineRows = Array.isArray(params.snapshot.engine_idea_priors)
    ? params.snapshot.engine_idea_priors
    : [];
  const sourceRows = Array.isArray(params.snapshot.engine_source_priors)
    ? params.snapshot.engine_source_priors
    : [];
  const sampleCounts = [...engineRows, ...sourceRows]
    .map((row) => Math.max(0, Math.floor(asNumber(row.sample_count, 0))))
    .filter((count) => count > 0);
  const engineSampleTotal = sampleCounts.reduce((sum, count) => sum + count, 0);
  const topShare = engineSampleTotal > 0 ? Math.max(...sampleCounts) / engineSampleTotal : 1;
  const activeBlocks = sampleCounts.length;
  const scarcity = clamp01(1 - Math.min(activeBlocks, 5) / 5);
  const diversityDeficit =
    engineSampleTotal <= 0 ? 1 : clamp01(0.65 * clamp01(topShare) + 0.35 * scarcity);
  const coldStartBoost = engineSampleTotal < 6 ? 0.05 : 0;

  const upwardPressure =
    0.16 * regretSignal + 0.1 * revisionPressure + 0.08 * diversityDeficit + 0.05 * queuePressure;
  const downwardPressure = 0.18 * stability + 0.08 * (1 - regretSignal);
  const rawRate = baseRate + upwardPressure - downwardPressure + coldStartBoost;
  const effectiveRate = clampToRange(rawRate, lowerBound, upperBound);
  const adjustment = effectiveRate - baseRate;
  return {
    baseRate,
    effectiveRate,
    adjustment,
    regretSignal,
    revisionPressure,
    stability,
    diversityDeficit,
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
    testing_criteria: string[];
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

export type AutonomyObjectiveCategory =
  | "product_core"
  | "user_experience"
  | "onboarding"
  | "reliability"
  | "validation"
  | "performance"
  | "maintainability"
  | "delivery_loop"
  | "governance"
  | "growth"
  | "content"
  | "unknown";

export interface CompiledRepoObjective {
  id: string;
  title: string;
  category: AutonomyObjectiveCategory;
  secondary_categories: AutonomyObjectiveCategory[];
  priority_rank: number | null;
  source_bucket: keyof VisionKeyItems | "section";
  section_ref: string;
  weight: number;
  keywords: string[];
  success_criteria: string[];
  constraints: string[];
  validation_expectations: string[];
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
  trigger_type:
    | "test_failure"
    | "lint_failure"
    | "typecheck_failure"
    | "queue_health"
    | "regret_signal";
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
  source_type?: string;
  source_label?: string | null;
  source_url?: string | null;
  source_refs?: string[];
  source_fingerprint?: string;
  source_curation_status?: "candidate" | "trusted" | "watchlist" | "archived";
  source_curation_reason?: string | null;
  source_trust_score?: number;
  source_freshness_score?: number;
}

export interface EngineCommitHistoryHint {
  motif_id: string;
  label: string;
  count: number;
  signal: number;
  objective_ids: string[];
  gap_ids: string[];
  sample_subjects: string[];
}

export interface AdjacentPossibleIdea {
  id: string;
  motif_id: string;
  gap_id: string;
  motif_label: string;
  gap_label: string;
  score: number;
  summary: string;
  hypothesis: string;
  evidence: string[];
  candidate_shape: EngineCandidateShape;
}

export interface AdjacentPossibleTelemetryEvent {
  step:
    | "motif_screen"
    | "gap_screen"
    | "pair_attempt"
    | "guardrail_drop"
    | "idea_emitted"
    | "idea_truncated";
  motif_id?: string;
  gap_id?: string;
  attempt_id?: string;
  accepted: boolean;
  reason?: string;
  metrics?: Record<string, number>;
}

export interface EngineInspirationSourcePattern {
  id: string;
  source_type: string;
  source_label: string | null;
  source_url: string | null;
  source_refs: string[];
  algorithm: string;
  when_to_use: string;
  summary: string;
  tags: string[];
  quality_score: number;
  freshness_score: number;
  seen_count: number;
  source_curation_status: "candidate" | "trusted" | "watchlist" | "archived";
  source_curation_reason: string | null;
  source_trust_score: number;
}

export interface EngineInspirationContext {
  compiled_repo_objectives: CompiledRepoObjective[];
  compiled_objectives: CompiledVisionObjective[];
  opportunity_gaps: EngineOpportunityGap[];
  building_blocks: EngineIdeaBuildingBlock[];
  source_patterns: EngineInspirationSourcePattern[];
  commit_history_hints: EngineCommitHistoryHint[];
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

function compactStatusDetail(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function uniqueLowercaseTokens(values: string[], max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = asString(value).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

const CATEGORY_KEYWORD_RULES: Array<{
  category: AutonomyObjectiveCategory;
  pattern: RegExp;
}> = [
  {
    category: "product_core",
    pattern:
      /\b(core|primary|match|game|gameplay|battle|battlefield|player|decision|territor|combat|strategy|mission|workflow|editor|dashboard|api)\b/i,
  },
  {
    category: "user_experience",
    pattern:
      /\b(user experience|ux|ui|readab|legib|clarity|clear|shell|screen|navigation|control|input|touch|mobile|visual|presentation|feedback|discoverable|usable)\b/i,
  },
  {
    category: "onboarding",
    pattern: /\b(onboard|new user|first[- ]?time|tutorial|learn|help|guide|activation|setup)\b/i,
  },
  {
    category: "reliability",
    pattern:
      /\b(reliab|stable|stability|startup|trust|regression|failure|resilien|recover|fallback|safe|crash|broken|blocker)\b/i,
  },
  {
    category: "validation",
    pattern:
      /\b(validation|validate|test|smoke|coverage|browser|e2e|end[- ]?to[- ]?end|ci|check|quality)\b/i,
  },
  {
    category: "performance",
    pattern:
      /\b(performance|latency|smooth|jitter|lag|throughput|fps|render|memory|speed|fast|responsive)\b/i,
  },
  {
    category: "maintainability",
    pattern:
      /\b(maintain|refactor|cleanup|architecture|structure|modular|debt|simplify|consistency|coherent)\b/i,
  },
  {
    category: "delivery_loop",
    pattern:
      /\b(autonom|agent|worker|delivery loop|reliable autonomous delivery|merge|review|pr|pull request|dispatch|orchestrat|planner|compiler|ideation)\b/i,
  },
  {
    category: "governance",
    pattern:
      /\b(policy|permission|scope|guardrail|risk|constraint|governance|approval|audit|security|non[- ]?goal)\b/i,
  },
  {
    category: "growth",
    pattern:
      /\b(growth|retention|conversion|activation|adoption|audience|returning|replay|engagement)\b/i,
  },
  {
    category: "content",
    pattern:
      /\b(content|variety|skin|cosmetic|faction|map|ship|projectile|enemy|level|mode|character)\b/i,
  },
];

const META_OBJECTIVE_CATEGORIES = new Set<AutonomyObjectiveCategory>([
  "delivery_loop",
  "governance",
  "maintainability",
]);

function slugifyObjectiveId(value: string, fallback: string): string {
  const slug = asString(value)
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function categorizeVisionText(text: string): {
  primary: AutonomyObjectiveCategory;
  secondary: AutonomyObjectiveCategory[];
} {
  const matched: AutonomyObjectiveCategory[] = [];
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.pattern.test(text)) matched.push(rule.category);
  }
  if (matched.length === 0) {
    return { primary: "unknown", secondary: [] };
  }
  const [primary, ...secondary] = matched;
  return {
    primary,
    secondary: [...new Set(secondary)].slice(0, 4),
  };
}

function sourceBucketSectionRef(
  sourceBucket: keyof VisionKeyItems | "section",
  sectionNumbers: string[],
): string {
  const preferredByBucket: Partial<Record<keyof VisionKeyItems | "section", string[]>> = {
    priorities: ["6", "5", "4"],
    objectives: ["7", "6", "5"],
    metrics: ["4", "6"],
    testing_criteria: ["12", "9", "4"],
    guardrails: ["9", "10", "3"],
    constraints: ["9", "5"],
    risk_policy: ["9", "10"],
    operating_model: ["11", "7"],
    governance: ["10", "9"],
    target_users: ["1"],
    non_goals: ["5", "9"],
    section: ["6", "7", "4", "3"],
  };
  const available = new Set(sectionNumbers);
  for (const ref of preferredByBucket[sourceBucket] ?? []) {
    if (available.has(ref)) return ref;
  }
  return sectionNumbers[0] ?? "";
}

function categoryObjectiveType(category: AutonomyObjectiveCategory): AutonomyObjectiveType {
  switch (category) {
    case "product_core":
    case "user_experience":
    case "onboarding":
    case "content":
    case "growth":
      return "feature_small";
    case "performance":
    case "reliability":
    case "maintainability":
    case "delivery_loop":
    case "governance":
      return "small_refactor";
    case "validation":
      return "flaky_test";
    default:
      return "small_refactor";
  }
}

function categoryTriggerType(
  category: AutonomyObjectiveCategory,
  topSignals: EngineIdeaInputSnapshot["top_signals"],
): EngineCandidateShape["trigger_type"] {
  const allowed: EngineCandidateShape["trigger_type"][] = [
    "test_failure",
    "lint_failure",
    "typecheck_failure",
    "queue_health",
    "regret_signal",
  ];
  const strongestSignal = topSignals
    .map((signal) => ({
      type: asString(signal.type) as EngineCandidateShape["trigger_type"],
      value: clamp01(asNumber(signal.value, 0)),
    }))
    .filter((signal) => allowed.includes(signal.type))
    .sort((a, b) => b.value - a.value)[0];
  if (category === "validation") {
    return strongestSignal?.type === "test_failure" ? "test_failure" : "queue_health";
  }
  if (category === "performance" || category === "reliability") {
    return strongestSignal?.type ?? "queue_health";
  }
  if (category === "delivery_loop" || category === "governance" || category === "maintainability") {
    return strongestSignal?.type === "regret_signal" ? "regret_signal" : "queue_health";
  }
  return "queue_health";
}

function isMetaRepoObjective(objective: CompiledRepoObjective): boolean {
  return META_OBJECTIVE_CATEGORIES.has(objective.category);
}

const OBJECTIVE_TYPES = new Set<AutonomyObjectiveType>([
  "flaky_test",
  "lint_fix",
  "type_fix",
  "small_refactor",
  "feature_small",
  "feature_medium",
  "feature_large",
  "docs",
  "dep_bump",
]);

type RepoTargetProfile = {
  component_area: AutonomyComponentArea;
  target_paths: string[];
  write_globs: string[];
  label: string;
  keywords: string[];
};

const COMMON_REPO_TARGET_DIRS = [
  "src",
  "app",
  "apps",
  "server",
  "client",
  "frontend",
  "backend",
  "web",
  "api",
  "lib",
  "services",
  "packages",
  "cmd",
  "internal",
  "tests",
  "test",
  "docs",
  "scripts",
] as const;

const COMMON_REPO_TARGET_FILES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "vision.md",
] as const;

const REPO_TARGET_SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".cs",
  ".rb",
  ".php",
  ".cpp",
  ".c",
  ".h",
  ".md",
  ".toml",
  ".json",
  ".yaml",
  ".yml",
]);

const IGNORED_REPO_TARGET_DIRS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "outputs",
  ".next",
  ".turbo",
  ".idea",
  ".vscode",
  ".venv",
  "venv",
  "__pycache__",
  "target",
]);

function isPushPalsRepository(repoRoot: string): boolean {
  return (
    existsSync(resolve(repoRoot, "apps", "remotebuddy", "src", "autonomous_engine.ts")) &&
    existsSync(resolve(repoRoot, "apps", "workerpals", "src", "workerpals_main.ts")) &&
    existsSync(resolve(repoRoot, "packages", "shared", "src", "autonomy_policy.ts"))
  );
}

function isPushPalsInternalUserRepoPath(path: string): boolean {
  const normalized = asString(path).replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  return /(^|\/)_layout\.autonomy\.test\.[cm]?[jt]sx?$/.test(normalized);
}

function containsPushPalsInternalUserRepoText(text: string): boolean {
  return /\b(queue_health|workerpal|remotebuddy|sourcecontrolmanager|source_control_manager|reviewagent|pushpals)\b/i.test(
    text,
  );
}

function candidateLeaksPushPalsInternals(candidate: Pick<
  AutonomyCandidate,
  | "title"
  | "problem_statement"
  | "vision_alignment_reason"
  | "feature_hypotheses"
  | "target_paths"
  | "component_area"
>): boolean {
  if (
    [candidate.component_area, ...candidate.target_paths].some((path) =>
      isPushPalsInternalUserRepoPath(path),
    )
  ) {
    return true;
  }
  const publicText = [
    candidate.title,
    candidate.problem_statement,
    candidate.vision_alignment_reason,
    ...candidate.feature_hypotheses,
    ...candidate.target_paths,
  ].join("\n");
  return containsPushPalsInternalUserRepoText(publicText);
}

function buildRepoNativeFallbackInstruction(candidate: AutonomyCandidate): string {
  return [
    candidate.title,
    "",
    candidate.problem_statement,
    "",
    "Keep the change scoped to the repo's own product/runtime behavior. Do not add PushPals, WorkerPal, RemoteBuddy, queue-health, or autonomy-internal concepts to user-facing code or tests.",
    "",
    "Scope:",
    `- target_paths: ${candidate.target_paths.join(", ")}`,
    `- write_globs: ${candidate.scope.write_globs.join(", ")}`,
  ].join("\n");
}

function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function pathDirname(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

function pathExtname(path: string): string {
  const base = pathBasename(path);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}

function tokenizePath(value: string): string[] {
  return value
    .replace(/\\/g, "/")
    .split(/[^A-Za-z0-9]+/g)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function buildRepoTargetProfile(targetPath: string): RepoTargetProfile {
  const normalized = asString(targetPath).replace(/\\/g, "/");
  const componentArea =
    normalizeAutonomyComponentArea(pathDirname(normalized) || normalized) ?? normalized;
  const keywords = [...new Set([...tokenizePath(componentArea), ...tokenizePath(normalized)])];
  return {
    component_area: componentArea,
    target_paths: [normalized],
    write_globs: [normalized],
    label: normalized,
    keywords,
  };
}

function collectRepoTargetFiles(
  repoRoot: string,
  startRelativePath: string,
  maxResults: number,
  maxDepth = 3,
): string[] {
  const startPath = resolve(repoRoot, startRelativePath);
  if (!existsSync(startPath)) return [];
  const out: string[] = [];
  const walk = (absolutePath: string, relativePath: string, depth: number): void => {
    if (out.length >= maxResults) return;
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(absolutePath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && IGNORED_REPO_TARGET_DIRS.has(entry.name)) continue;
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const childAbsolute = resolve(absolutePath, entry.name);
        if (entry.isDirectory()) {
          walk(childAbsolute, childRelative, depth + 1);
        } else if (REPO_TARGET_SCAN_EXTENSIONS.has(pathExtname(entry.name))) {
          out.push(childRelative);
          if (out.length >= maxResults) return;
        }
      }
      return;
    }
    if (REPO_TARGET_SCAN_EXTENSIONS.has(pathExtname(relativePath))) {
      out.push(relativePath);
    }
  };
  walk(startPath, startRelativePath, 0);
  return out;
}

function discoverRepoTargetProfiles(repoRoot: string, maxProfiles = 16): RepoTargetProfile[] {
  const profiles: RepoTargetProfile[] = [];
  const seen = new Set<string>();
  const allowPushPalsInternalTargets = isPushPalsRepository(repoRoot);
  const add = (targetPath: string | null | undefined): void => {
    const finalPath = normalizeAutonomyComponentArea(targetPath);
    if (!finalPath) return;
    if (!allowPushPalsInternalTargets && isPushPalsInternalUserRepoPath(finalPath)) return;
    if (seen.has(finalPath)) return;
    seen.add(finalPath);
    profiles.push(buildRepoTargetProfile(finalPath));
  };

  for (const file of COMMON_REPO_TARGET_FILES) {
    const absolutePath = resolve(repoRoot, file);
    if (existsSync(absolutePath)) add(file);
    if (profiles.length >= maxProfiles) return profiles;
  }
  for (const dir of COMMON_REPO_TARGET_DIRS) {
    const files = collectRepoTargetFiles(repoRoot, dir, 2, 3);
    for (const file of files) {
      add(file);
      if (profiles.length >= maxProfiles) return profiles;
    }
  }
  if (profiles.length < maxProfiles) {
    const rootFiles = collectRepoTargetFiles(
      repoRoot,
      "",
      Math.max(4, maxProfiles - profiles.length),
      2,
    );
    for (const file of rootFiles) {
      add(file);
      if (profiles.length >= maxProfiles) return profiles;
    }
  }
  return profiles;
}

function chooseRepoTargetProfile(
  profiles: RepoTargetProfile[],
  hints: string[],
  triggerType?: EngineCandidateShape["trigger_type"],
): RepoTargetProfile | null {
  if (profiles.length === 0) return null;
  const hintTokens = [...new Set(hints.flatMap((hint) => tokenizePath(hint)))];
  let best: { profile: RepoTargetProfile; score: number } | null = null;
  for (const profile of profiles) {
    let score = 0;
    for (const token of hintTokens) {
      if (profile.keywords.includes(token)) score += 2;
      if (profile.label.toLowerCase().includes(token)) score += 1;
    }
    if (triggerType === "test_failure" && /(^|\/)(test|tests)\//.test(profile.label)) score += 3;
    if (triggerType === "queue_health" && /(server|api|queue|worker|job|task)/i.test(profile.label))
      score += 2;
    if (
      triggerType === "regret_signal" &&
      /(src|app|lib|server|client|docs|readme)/i.test(profile.label)
    )
      score += 1;
    if (!best || score > best.score) best = { profile, score };
  }
  return best?.profile ?? profiles[0] ?? null;
}

function chooseRepoObjectiveTargetProfile(
  profiles: RepoTargetProfile[],
  objective: CompiledRepoObjective,
): RepoTargetProfile | null {
  if (profiles.length === 0) return null;
  const hintTokens = [...new Set([...objective.keywords, ...tokenizePath(objective.title)])];
  const categories = new Set<AutonomyObjectiveCategory>([
    objective.category,
    ...objective.secondary_categories,
  ]);
  let best: { profile: RepoTargetProfile; score: number } | null = null;
  for (const profile of profiles) {
    const label = profile.label.toLowerCase();
    if (isPushPalsInternalUserRepoPath(label)) continue;
    const profileTokens = new Set(profile.keywords);
    let score = 0;
    for (const token of hintTokens) {
      if (profileTokens.has(token)) score += 3;
      if (label.includes(token)) score += 1;
    }

    const productSurface =
      /(^|\/)(app|src|components|component|screens|pages|routes|styles|assets)\b/i.test(label) ||
      /\b(client|frontend|web|ui|ux|game|screen|view|layout)\b/i.test(label);
    const validationSurface =
      /(^|\/)(__tests__|tests?|e2e|smoke|specs?)\b/i.test(label) ||
      /\b(test|smoke|spec)\b/i.test(label);
    const docsSurface = /\b(readme|vision|docs?)\b/i.test(label);
    const scriptSurface = /(^|\/)(scripts?|tools?)\b/i.test(label);
    const packageSurface = /\b(package\.json|tsconfig|eslint|prettier|config)\b/i.test(label);

    if (
      categories.has("product_core") ||
      categories.has("user_experience") ||
      categories.has("onboarding") ||
      categories.has("content") ||
      categories.has("growth")
    ) {
      if (productSurface) score += 5;
      if (/\b(game|play|screen|route|layout|index|style|component)\b/i.test(label)) score += 3;
      if (validationSurface) score -= 7;
      if (docsSurface || packageSurface || scriptSurface) score -= 4;
    }
    if (categories.has("validation")) {
      if (validationSurface || scriptSurface) score += 5;
      if (productSurface) score += 1;
    }
    if (/\b(web|browser|smoke|e2e|review path|review|navigation|delivery|trust)\b/i.test(objective.title)) {
      if (/(^|\/)(scripts?|tools?)\/.*(web|browser|smoke|e2e|playwright)/i.test(label)) {
        score += 8;
      }
      if (/\b(app\/(_layout|index)|route|navigation|shell|home|screen)\b/i.test(label)) {
        score += 4;
      }
      if (validationSurface && !/(web|browser|smoke|e2e|playwright)/i.test(label)) {
        score -= 3;
      }
    }
    if (categories.has("performance")) {
      if (productSurface || /\b(perf|render|animation|worker|server)\b/i.test(label)) score += 4;
      if (docsSurface) score -= 3;
    }
    if (categories.has("reliability")) {
      if (
        productSurface ||
        scriptSurface ||
        packageSurface ||
        /\b(config|startup|server)\b/i.test(label)
      ) {
        score += 3;
      }
    }
    if (
      categories.has("delivery_loop") ||
      categories.has("governance") ||
      categories.has("maintainability")
    ) {
      if (
        scriptSurface ||
        packageSurface ||
        /\b(src|utils?|lib|server|shared|policy)\b/i.test(label)
      ) {
        score += 3;
      }
    }

    if (!best || score > best.score) best = { profile, score };
  }
  return best?.profile ?? chooseRepoTargetProfile(profiles, [objective.title], "queue_health");
}

function adaptCandidateShapeToRepo(params: {
  shape: EngineCandidateShape;
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
  hints?: string[];
}): EngineCandidateShape {
  const shape = params.shape;
  const scopeValidation = validateScopeInvariants(
    shape.component_area,
    shape.target_paths,
    shape.write_globs,
    {
      requireWriteGlobs: true,
      hintsOnly: true,
    },
  );
  const pathsExist =
    params.repoRoot && scopeValidation.ok
      ? findMissingRepoTargetPaths(params.repoRoot, scopeValidation.normalizedTargetPaths)
          .length === 0
      : scopeValidation.ok;
  if (scopeValidation.ok && pathsExist) {
    return {
      ...shape,
      component_area: scopeValidation.componentArea ?? shape.component_area,
      target_paths: scopeValidation.normalizedTargetPaths,
      write_globs: scopeValidation.normalizedWriteGlobs,
    };
  }
  const selected = chooseRepoTargetProfile(
    params.repoTargets ?? [],
    [shape.component_area, ...shape.target_paths, ...shape.write_globs, ...(params.hints ?? [])],
    shape.trigger_type,
  );
  if (!selected) return shape;
  return {
    ...shape,
    component_area: selected.component_area,
    target_paths: selected.target_paths,
    write_globs: selected.write_globs,
  };
}

function findMissingRepoTargetPaths(repoRoot: string, targetPaths: string[]): string[] {
  return targetPaths
    .map((targetPath) => asString(targetPath))
    .filter(Boolean)
    .filter((targetPath) => !existsSync(resolve(repoRoot, targetPath)));
}

function asAutonomyObjectiveType(value: unknown): AutonomyObjectiveType | null {
  const normalized = asString(value) as AutonomyObjectiveType;
  return OBJECTIVE_TYPES.has(normalized) ? normalized : null;
}

function asAutonomyComponentArea(value: unknown): AutonomyComponentArea | null {
  return normalizeAutonomyComponentArea(value);
}

function defaultCandidateShapeForArea(area: AutonomyComponentArea): EngineCandidateShape {
  switch (area) {
    case "apps/server":
      return {
        objective_type: "feature_small",
        trigger_type: "queue_health",
        component_area: "apps/server",
        target_paths: ["apps/server/src/autonomy.ts"],
        write_globs: ["apps/server/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "apps/remotebuddy":
      return {
        objective_type: "feature_small",
        trigger_type: "regret_signal",
        component_area: "apps/remotebuddy",
        target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
        write_globs: ["apps/remotebuddy/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "apps/workerpals":
      return {
        objective_type: "feature_small",
        trigger_type: "queue_health",
        component_area: "apps/workerpals",
        target_paths: ["apps/workerpals/src/workerpals_main.ts"],
        write_globs: ["apps/workerpals/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "apps/client":
      return {
        objective_type: "small_refactor",
        trigger_type: "regret_signal",
        component_area: "apps/client",
        target_paths: ["apps/client/src"],
        write_globs: ["apps/client/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "packages/protocol":
      return {
        objective_type: "small_refactor",
        trigger_type: "typecheck_failure",
        component_area: "packages/protocol",
        target_paths: ["packages/protocol/src"],
        write_globs: ["packages/protocol/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "packages/shared":
      return {
        objective_type: "small_refactor",
        trigger_type: "typecheck_failure",
        component_area: "packages/shared",
        target_paths: ["packages/shared/src/autonomy_policy.ts"],
        write_globs: ["packages/shared/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "tests/integration":
      return {
        objective_type: "flaky_test",
        trigger_type: "test_failure",
        component_area: "tests/integration",
        target_paths: ["tests/integration"],
        write_globs: ["tests/integration/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    case "tests/unit":
      return {
        objective_type: "flaky_test",
        trigger_type: "test_failure",
        component_area: "tests/unit",
        target_paths: ["tests/unit"],
        write_globs: ["tests/unit/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"],
      };
    default:
      return {
        objective_type: "small_refactor",
        trigger_type: "regret_signal",
        component_area: area,
        target_paths: [area],
        write_globs: [area],
        risk_level: "low",
        expected_validation: ["git status --porcelain"],
      };
  }
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
    summary:
      "Model queue/review/runtime friction as an opportunity graph and prioritize highest leverage edges.",
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
    summary:
      "Mine successful local commit/PR motifs and bias candidate generation toward those patterns.",
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
    summary:
      "Allocate dispatch budget across reliability, mergeability, activation, and governance idea portfolios.",
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
    summary:
      "Estimate prevented incidents/rework if a proposed feature had existed over recent runs.",
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

type InspirationPatternInput = {
  id: string;
  fingerprint: string;
  sourceKey: string;
  sourceType: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceRefs: string[];
  algorithm: string;
  whenToUse: string;
  summary: string;
  risks: string[];
  validationIdeas: string[];
  tags: string[];
  qualityScore: number;
  freshnessScore: number;
  seenCount: number;
  sourceCurationStatus: "candidate" | "trusted" | "watchlist" | "archived";
  sourceCurationReason: string | null;
  sourceTrustScore: number;
  metadata: Record<string, unknown>;
};

type SourceCurationInsightInput = {
  sourceKey: string;
  sourceType: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceFingerprint: string | null;
  curationStatus: "candidate" | "trusted" | "watchlist" | "archived";
  curationReason: string | null;
  trustScore: number;
  freshnessScore: number;
  sampleCount: number;
};

const INSPIRATION_COMPONENT_HINTS: Array<{ area: AutonomyComponentArea; pattern: RegExp }> = [
  {
    area: "apps/server",
    pattern: /\b(server|queue|backpressure|dispatch|snapshot|lock|db|sqlite|status)\b/i,
  },
  {
    area: "apps/remotebuddy",
    pattern: /\b(remotebuddy|autonomous engine|ideation|planner|scoring)\b/i,
  },
  { area: "apps/workerpals", pattern: /\b(worker|workerpal|sandbox|executor|task\.execute)\b/i },
  { area: "apps/client", pattern: /\b(client|ui|frontend|dashboard|react)\b/i },
  { area: "packages/protocol", pattern: /\b(protocol|schema|contract|wire format)\b/i },
  { area: "packages/shared", pattern: /\b(shared|guardrail|scope invariant|policy helper)\b/i },
  { area: "tests/integration", pattern: /\b(integration test|e2e|end-to-end)\b/i },
  { area: "tests/unit", pattern: /\b(unit test)\b/i },
];

const GAP_TEXT_RULES: Array<{ gapId: string; pattern: RegExp }> = [
  {
    gapId: "delivery_reliability_gap",
    pattern:
      /\b(reliab|stability|startup|failure|flake|retry|incident|runtime|preflight|timeout)\b/i,
  },
  {
    gapId: "merge_rework_gap",
    pattern: /\b(merge|review|pr|pull request|conflict|rework|regret|reject|revision)\b/i,
  },
  { gapId: "activation_gap", pattern: /\b(activation|onboard|first pr|quickstart|setup)\b/i },
  {
    gapId: "governance_gap",
    pattern: /\b(policy|permission|scope|guardrail|audit|security|compliance|risk)\b/i,
  },
  {
    gapId: "workforce_throughput_gap",
    pattern: /\b(worker|delegation|dispatch|throughput|queue|backpressure|capacity)\b/i,
  },
];

type CommitMotifRule = {
  motifId: string;
  label: string;
  pattern: RegExp;
  objectiveIds: string[];
  gapIds: string[];
  shape: EngineCandidateShape;
};

const COMMIT_MOTIF_RULES: CommitMotifRule[] = [
  {
    motifId: "queue_backpressure",
    label: "Queue backpressure and throughput",
    pattern: /\b(queue|backpressure|throughput|latency|pending|saturation|dispatch)\b/i,
    objectiveIds: ["workforce_scaling", "reliable_autonomous_delivery"],
    gapIds: ["workforce_throughput_gap", "delivery_reliability_gap"],
    shape: {
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
    motifId: "merge_rework_loop",
    label: "Merge/rework loop hardening",
    pattern: /\b(merge|conflict|rebase|review|pr|churn|rework|unmergeable)\b/i,
    objectiveIds: ["merge_conversion_and_rework", "reliable_autonomous_delivery"],
    gapIds: ["merge_rework_gap", "delivery_reliability_gap"],
    shape: {
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
    motifId: "startup_stability",
    label: "Startup/environment stability",
    pattern: /\b(startup|preflight|boot|config|environment|timeout|offline|deterministic)\b/i,
    objectiveIds: ["reliable_autonomous_delivery", "mass_audience_activation"],
    gapIds: ["delivery_reliability_gap", "activation_gap"],
    shape: {
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
    motifId: "policy_guardrails",
    label: "Policy/scope guardrails",
    pattern: /\b(policy|permission|scope|guardrail|audit|security|risk)\b/i,
    objectiveIds: ["policy_and_governance", "reliable_autonomous_delivery"],
    gapIds: ["governance_gap", "delivery_reliability_gap"],
    shape: {
      objective_type: "small_refactor",
      trigger_type: "regret_signal",
      component_area: "packages/shared",
      target_paths: ["packages/shared/src/autonomy_policy.ts"],
      write_globs: ["packages/shared/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"],
    },
  },
  {
    motifId: "test_flake_reliability",
    label: "Test flake reliability",
    pattern: /\b(test|flaky|flake|retry|stabilize|deterministic)\b/i,
    objectiveIds: ["reliable_autonomous_delivery"],
    gapIds: ["delivery_reliability_gap"],
    shape: {
      objective_type: "flaky_test",
      trigger_type: "test_failure",
      component_area: "tests/integration",
      target_paths: ["tests/integration"],
      write_globs: ["tests/integration/*"],
      risk_level: "low",
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
  types: Array<
    "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal"
  >,
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

function repoObjectiveWeight(params: {
  sourceBucket: keyof VisionKeyItems | "section";
  priorityRank: number | null;
  category: AutonomyObjectiveCategory;
  text: string;
}): number {
  const rank = params.priorityRank ?? 12;
  const sourceBase =
    params.sourceBucket === "priorities"
      ? 0.86
      : params.sourceBucket === "objectives"
        ? 0.78
        : params.sourceBucket === "metrics"
          ? 0.58
          : params.sourceBucket === "section"
            ? 0.5
            : 0.42;
  const rankPenalty = Math.min(0.28, Math.max(0, rank - 1) * 0.045);
  const metaPenalty = META_OBJECTIVE_CATEGORIES.has(params.category) ? 0.08 : 0;
  const explicitValidationBoost =
    params.category === "validation" || /\b(smoke|browser|validation|test)\b/i.test(params.text)
      ? 0.04
      : 0;
  return clamp01(sourceBase - rankPenalty - metaPenalty + explicitValidationBoost);
}

function compileRepoVisionObjectives(params: {
  vision: Pick<VisionContext, "key_items" | "section_numbers"> & {
    sections?: VisionContext["sections"];
  };
}): CompiledRepoObjective[] {
  const sectionNumbers = params.vision.section_numbers ?? [];
  const keyItems = params.vision.key_items;
  const constraints = bucketLines(keyItems, [
    "guardrails",
    "constraints",
    "risk_policy",
    "non_goals",
  ]).slice(0, 12);
  const validationExpectations = [
    ...bucketLines(keyItems, ["testing_criteria"]),
    ...bucketLines(keyItems, ["metrics", "constraints", "risk_policy"]).filter((line) =>
      /\b(validation|validate|test|smoke|browser|ci|check)\b/i.test(line),
    ),
  ].slice(0, 8);
  const successCriteria = bucketLines(keyItems, ["metrics", "objectives", "priorities"]).slice(
    0,
    8,
  );
  const entries: CompiledRepoObjective[] = [];
  const seen = new Set<string>();

  const addEntry = (
    rawTitle: string,
    sourceBucket: keyof VisionKeyItems | "section",
    priorityRank: number | null,
    explicitSectionRef?: string,
  ): void => {
    const title = asString(rawTitle);
    if (!title) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const titleCategory = categorizeVisionText(title);
    const contextCategory = categorizeVisionText(
      [constraints.join(" "), validationExpectations.join(" ")].join("\n"),
    );
    const secondaryCategories = [
      ...titleCategory.secondary,
      contextCategory.primary,
      ...contextCategory.secondary,
    ].filter(
      (category): category is AutonomyObjectiveCategory =>
        category !== "unknown" && category !== titleCategory.primary,
    );
    const primaryCategory =
      titleCategory.primary === "unknown" &&
      (sourceBucket === "priorities" || sourceBucket === "objectives")
        ? "product_core"
        : titleCategory.primary;
    const categorized = {
      primary: primaryCategory,
      secondary: [
        ...new Set(secondaryCategories.filter((category) => category !== primaryCategory)),
      ].slice(0, 4),
    };
    const id = slugifyObjectiveId(title, `vision_objective_${entries.length + 1}`);
    const sectionRef =
      explicitSectionRef || sourceBucketSectionRef(sourceBucket, sectionNumbers) || "";
    const keywords = uniqueLowercaseTokens([
      ...tokenizePath(title),
      categorized.primary,
      ...categorized.secondary,
    ]);
    const weight = repoObjectiveWeight({
      sourceBucket,
      priorityRank,
      category: categorized.primary,
      text: title,
    });
    entries.push({
      id,
      title,
      category: categorized.primary,
      secondary_categories: categorized.secondary,
      priority_rank: priorityRank,
      source_bucket: sourceBucket,
      section_ref: sectionRef,
      weight,
      keywords,
      success_criteria: successCriteria,
      constraints,
      validation_expectations: validationExpectations,
      evidence: [
        `source_bucket=${sourceBucket}`,
        priorityRank != null ? `priority_rank=${priorityRank}` : "priority_rank=none",
        `category=${categorized.primary}`,
        `section_ref=${sectionRef || "none"}`,
      ],
    });
  };

  keyItems.priorities.forEach((title, index) => addEntry(title, "priorities", index + 1));
  keyItems.objectives.forEach((title, index) => addEntry(title, "objectives", index + 1));
  keyItems.metrics
    .filter((title) => /\b(validation|smoke|browser|performance|reliab|startup)\b/i.test(title))
    .forEach((title, index) => addEntry(title, "metrics", index + 1));

  for (const section of params.vision.sections ?? []) {
    const sectionTitle = asString(section.title);
    if (!sectionTitle) continue;
    if (
      /^(who this is for|the problem|scope|long-term|how decisions|get made)$/i.test(sectionTitle)
    ) {
      continue;
    }
    const sectionNumber = asString(section.number);
    const priorityRank = Number.isFinite(Number(sectionNumber)) ? Number(sectionNumber) : null;
    addEntry(sectionTitle, "section", priorityRank, sectionNumber);
  }

  return entries.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    const aRank = a.priority_rank ?? Number.MAX_SAFE_INTEGER;
    const bRank = b.priority_rank ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.id.localeCompare(b.id);
  });
}

function normalizeValidationIdeas(ideas: string[]): string[] {
  const out: string[] = [];
  for (const idea of ideas) {
    const command = extractValidationCommandFromIdea(idea);
    if (isRepoNativeValidationCommand(command)) {
      out.push(command);
      continue;
    }
    const lower = idea.toLowerCase();
    if (lower.includes("test")) out.push("bun run test:root");
    else if (lower.includes("lint")) out.push("bun run test:root");
    else if (lower.includes("type")) out.push("bun run test:root");
  }
  if (out.length === 0) out.push("bun run test:root");
  return [...new Set(out)].slice(0, 5);
}

function extractValidationCommandFromIdea(value: string): string {
  const raw = asString(value);
  if (!raw) return "";
  const fenced = raw.match(/`([^`]+)`/)?.[1]?.trim();
  return (fenced || raw.replace(/^(run|execute|verify|validate|check)\s+/i, "")).trim();
}

function isRepoNativeValidationCommand(value: string): boolean {
  return /^(bun|bunx|npm|npx|pnpm|yarn|node|python|python3|uv|pytest|vitest|jest|tsc|eslint|ruff|mypy|go|cargo|make|docker|pwsh|powershell|sh|bash)\b/i.test(
    value,
  );
}

function inferComponentAreaFromText(
  text: string,
  repoTargets?: RepoTargetProfile[],
  triggerType?: EngineCandidateShape["trigger_type"],
): AutonomyComponentArea {
  const repoTargetMatch = chooseRepoTargetProfile(repoTargets ?? [], [text], triggerType);
  if (repoTargetMatch) return repoTargetMatch.component_area;
  for (const rule of INSPIRATION_COMPONENT_HINTS) {
    if (rule.pattern.test(text)) return rule.area;
  }
  return "src";
}

function inferObjectiveTypeFromText(text: string, tags: string[]): AutonomyObjectiveType {
  const tagSet = new Set(tags);
  if (tagSet.has("flaky_test") || tagSet.has("flake") || /\b(flaky|flake)\b/i.test(text))
    return "flaky_test";
  if (tagSet.has("lint_fix") || /\b(lint|format)\b/i.test(text)) return "lint_fix";
  if (tagSet.has("type_fix") || /\b(typecheck|typing|typescript|type error)\b/i.test(text))
    return "type_fix";
  if (tagSet.has("docs") || /\b(doc|readme|onboarding guide)\b/i.test(text)) return "docs";
  if (tagSet.has("small_refactor") || /\b(refactor|cleanup|simplify|hardening)\b/i.test(text)) {
    return "small_refactor";
  }
  if (
    tagSet.has("feature_medium") ||
    /\b(portfolio|planner|bandit|framework|capability)\b/i.test(text)
  ) {
    return "feature_medium";
  }
  return "feature_small";
}

function inferTriggerTypeFromText(
  text: string,
): "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal" {
  if (/\b(queue|backpressure|throughput|latency|pending|capacity)\b/i.test(text))
    return "queue_health";
  if (/\b(lint|format)\b/i.test(text)) return "lint_failure";
  if (/\b(typecheck|type error|typing|typescript)\b/i.test(text)) return "typecheck_failure";
  if (/\b(test|flake|flaky|failing test)\b/i.test(text)) return "test_failure";
  return "regret_signal";
}

function inferRiskLevelFromText(text: string, tags: string[]): "low" | "medium" | "high" {
  const joined = `${text} ${tags.join(" ")}`;
  if (/\b(auth|permission|security|credential|secret|encryption)\b/i.test(joined)) return "medium";
  if (/\b(migration|schema rewrite|large rewrite|breaking change)\b/i.test(joined)) return "high";
  return "low";
}

function matchObjectiveIdsFromText(text: string, fallback: CompiledVisionObjective[]): string[] {
  const matched = ENGINE_OBJECTIVE_BLUEPRINTS.filter((entry) =>
    entry.keywordPattern.test(text),
  ).map((entry) => entry.id);
  if (matched.length > 0) return matched.slice(0, 4);
  return fallback.slice(0, 2).map((entry) => entry.id);
}

function matchGapIdsFromText(text: string, fallback: EngineOpportunityGap[]): string[] {
  const out: string[] = [];
  for (const rule of GAP_TEXT_RULES) {
    if (rule.pattern.test(text)) out.push(rule.gapId);
  }
  if (out.length > 0) return [...new Set(out)].slice(0, 4);
  return fallback.slice(0, 2).map((entry) => entry.id);
}

function normalizeInspirationPattern(value: unknown): InspirationPatternInput | null {
  const raw = asObject(value);
  const algorithm = asString(raw.algorithm);
  const whenToUse = asString(raw.whenToUse ?? raw.when_to_use);
  const summary = asString(raw.summary);
  if (!algorithm || !whenToUse || !summary) return null;
  const sourceType = asString(raw.sourceType ?? raw.source_type).toLowerCase() || "external_doc";
  const tags = uniqueLowercaseTokens(asStringArray(raw.tags), 24);
  const sourceRefs = asStringArray(raw.sourceRefs ?? raw.source_refs).slice(0, 12);
  const metadata = asObject(raw.metadata);
  const fingerprintSeed = `${algorithm.toLowerCase()}|${whenToUse.toLowerCase()}`;
  const fingerprint = asString(raw.fingerprint) || sha256(fingerprintSeed);
  const sourceLabel = asString(raw.sourceLabel ?? raw.source_label) || null;
  const sourceUrl = asString(raw.sourceUrl ?? raw.source_url) || null;
  const sourceKey =
    asString(raw.sourceKey ?? raw.source_key) ||
    asString(metadata.source_key) ||
    deriveInspirationSourceKey({
      sourceFingerprint: fingerprint,
      sourceType,
      sourceLabel,
      sourceUrl,
    });
  const sourceCurationStatus = normalizeSourceCurationStatus(
    raw.sourceCurationStatus ?? raw.source_curation_status ?? metadata.source_curation_status,
  );
  const sourceCurationReason =
    asString(
      raw.sourceCurationReason ?? raw.source_curation_reason ?? metadata.source_curation_reason,
    ) || null;
  const sourceTrustScore = clamp01(
    asNumber(raw.sourceTrustScore ?? raw.source_trust_score ?? metadata.source_trust_score, 0),
  );
  return {
    id: asString(raw.id) || `insp_${fingerprint.slice(0, 10)}`,
    fingerprint,
    sourceKey,
    sourceType,
    sourceLabel,
    sourceUrl,
    sourceRefs,
    algorithm,
    whenToUse,
    summary,
    risks: asStringArray(raw.risks).slice(0, 12),
    validationIdeas: asStringArray(raw.validationIdeas ?? raw.validation_ideas).slice(0, 12),
    tags,
    qualityScore: clamp01(asNumber(raw.qualityScore ?? raw.quality_score, 0.5)),
    freshnessScore: clamp01(asNumber(raw.freshnessScore ?? raw.freshness_score, 0.5)),
    seenCount: Math.max(0, Math.floor(asNumber(raw.seenCount ?? raw.seen_count, 0))),
    sourceCurationStatus,
    sourceCurationReason,
    sourceTrustScore,
    metadata,
  };
}

function normalizeSourceCurationInsight(value: unknown): SourceCurationInsightInput | null {
  const raw = asObject(value);
  const sourceType = asString(raw.sourceType ?? raw.source_type).toLowerCase() || "unknown";
  const sourceLabel = asString(raw.sourceLabel ?? raw.source_label) || null;
  const sourceUrl = asString(raw.sourceUrl ?? raw.source_url) || null;
  const sourceFingerprint = asString(raw.sourceFingerprint ?? raw.source_fingerprint) || null;
  const sourceKey =
    asString(raw.sourceKey ?? raw.source_key) ||
    deriveInspirationSourceKey({
      sourceFingerprint,
      sourceType,
      sourceLabel,
      sourceUrl,
    });
  if (!sourceKey && !sourceFingerprint) return null;
  return {
    sourceKey,
    sourceType,
    sourceLabel,
    sourceUrl,
    sourceFingerprint,
    curationStatus: normalizeSourceCurationStatus(raw.curationStatus ?? raw.curation_status),
    curationReason: asString(raw.curationReason ?? raw.curation_reason) || null,
    trustScore: clamp01(asNumber(raw.trustScore ?? raw.trust_score, 0)),
    freshnessScore: clamp01(asNumber(raw.freshnessScore ?? raw.freshness_score, 0.5)),
    sampleCount: Math.max(0, Math.floor(asNumber(raw.sampleCount ?? raw.sample_count, 0))),
  };
}

function applySourceCurationToPatterns(
  patterns: InspirationPatternInput[],
  sourceInsights: unknown[],
): InspirationPatternInput[] {
  const normalizedInsights = sourceInsights
    .map((entry) => normalizeSourceCurationInsight(entry))
    .filter((entry): entry is SourceCurationInsightInput => Boolean(entry));
  const insightBySourceKey = new Map<string, SourceCurationInsightInput>();
  const insightByFingerprint = new Map<string, SourceCurationInsightInput>();
  for (const insight of normalizedInsights) {
    if (insight.sourceKey) insightBySourceKey.set(insight.sourceKey, insight);
    if (insight.sourceFingerprint) insightByFingerprint.set(insight.sourceFingerprint, insight);
  }

  const curated = patterns
    .map((pattern) => {
      const insight =
        insightBySourceKey.get(pattern.sourceKey) ?? insightByFingerprint.get(pattern.fingerprint);
      if (!insight) {
        if (pattern.sourceCurationStatus === "archived") return null;
        return pattern;
      }
      const trustScore = clamp01(asNumber(insight.trustScore, pattern.sourceTrustScore));
      const freshnessScore = clamp01(asNumber(insight.freshnessScore, pattern.freshnessScore));
      const nextStatus = insight.curationStatus;
      if (nextStatus === "archived") return null;
      const nextMetadata: Record<string, unknown> = {
        ...pattern.metadata,
        source_key: pattern.sourceKey,
        source_curation_status: nextStatus,
        source_curation_reason: insight.curationReason,
        source_trust_score: trustScore,
      };
      const qualityScore =
        nextStatus === "trusted"
          ? clamp01(Math.max(pattern.qualityScore, 0.68 + 0.24 * trustScore))
          : nextStatus === "watchlist"
            ? clamp01(Math.min(pattern.qualityScore, 0.6 * pattern.qualityScore + 0.4 * trustScore))
            : clamp01(0.72 * pattern.qualityScore + 0.28 * trustScore);
      return {
        ...pattern,
        qualityScore,
        freshnessScore: Math.max(pattern.freshnessScore, freshnessScore),
        sourceCurationStatus: nextStatus,
        sourceCurationReason: insight.curationReason,
        sourceTrustScore: trustScore,
        metadata: nextMetadata,
      } satisfies InspirationPatternInput;
    })
    .filter((entry): entry is InspirationPatternInput => Boolean(entry));

  const statusPriority: Record<SourceCurationStatus, number> = {
    trusted: 0,
    candidate: 1,
    watchlist: 2,
    archived: 3,
  };
  return curated.sort((a, b) => {
    const pA = statusPriority[a.sourceCurationStatus];
    const pB = statusPriority[b.sourceCurationStatus];
    if (pA !== pB) return pA - pB;
    const signalA = 0.52 * a.qualityScore + 0.28 * a.freshnessScore + 0.2 * a.sourceTrustScore;
    const signalB = 0.52 * b.qualityScore + 0.28 * b.freshnessScore + 0.2 * b.sourceTrustScore;
    return signalB - signalA;
  });
}

function buildCandidateShapeFromPattern(params: {
  pattern: InspirationPatternInput;
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
}): EngineCandidateShape {
  const pattern = params.pattern;
  const text =
    `${pattern.algorithm}\n${pattern.whenToUse}\n${pattern.summary}\n${pattern.tags.join(" ")}`.toLowerCase();
  const metadata = pattern.metadata;
  const metadataShape = asObject(metadata.candidate_shape ?? metadata.candidateShape);
  const metadataArea =
    asAutonomyComponentArea(
      metadataShape.component_area ??
        metadataShape.componentArea ??
        metadata.component_area ??
        metadata.componentArea,
    ) ?? null;
  const triggerTypeRaw = asString(
    metadataShape.trigger_type ?? metadataShape.triggerType ?? metadata.trigger_type,
  );
  const triggerType = isTriggerType(triggerTypeRaw)
    ? triggerTypeRaw
    : inferTriggerTypeFromText(text);
  const componentArea =
    metadataArea ?? inferComponentAreaFromText(text, params.repoTargets, triggerType);
  const defaults = defaultCandidateShapeForArea(componentArea);
  const objectiveType =
    asAutonomyObjectiveType(
      metadataShape.objective_type ?? metadataShape.objectiveType ?? metadata.objective_type,
    ) ??
    inferObjectiveTypeFromText(text, pattern.tags) ??
    defaults.objective_type;
  const riskRaw = asString(
    metadataShape.risk_level ?? metadataShape.riskLevel ?? metadata.risk_level,
  );
  const riskLevel = isRiskLevel(riskRaw) ? riskRaw : inferRiskLevelFromText(text, pattern.tags);
  const targetPaths = asStringArray(
    metadataShape.target_paths ?? metadataShape.targetPaths ?? metadata.target_paths,
  );
  const writeGlobs = asStringArray(
    metadataShape.write_globs ?? metadataShape.writeGlobs ?? metadata.write_globs,
  );
  const validationIdeas = asStringArray(
    metadataShape.expected_validation ??
      metadataShape.expectedValidation ??
      metadata.expected_validation ??
      pattern.validationIdeas,
  );
  const scopeCheck = validateScopeInvariants(
    componentArea,
    targetPaths.length > 0 ? targetPaths : defaults.target_paths,
    writeGlobs.length > 0 ? writeGlobs : defaults.write_globs,
    { requireWriteGlobs: true, hintsOnly: true },
  );
  return adaptCandidateShapeToRepo({
    shape: {
      objective_type: objectiveType,
      trigger_type: triggerType,
      component_area: scopeCheck.componentArea ?? componentArea,
      target_paths: scopeCheck.ok ? scopeCheck.normalizedTargetPaths : defaults.target_paths,
      write_globs: scopeCheck.ok ? scopeCheck.normalizedWriteGlobs : defaults.write_globs,
      risk_level: riskLevel,
      expected_validation: normalizeValidationIdeas(validationIdeas),
    },
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets,
    hints: [
      pattern.algorithm,
      pattern.whenToUse,
      pattern.summary,
      pattern.sourceLabel ?? "",
      pattern.sourceType,
      ...pattern.tags,
      ...pattern.sourceRefs,
    ],
  });
}

function buildExternalInspirationBlocks(params: {
  patterns: InspirationPatternInput[];
  compiledObjectives: CompiledVisionObjective[];
  opportunityGaps: EngineOpportunityGap[];
  dispatchByType: Record<string, number>;
  dispatchSaturation: number;
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
}): EngineIdeaBuildingBlock[] {
  const objectiveWeightById = new Map(
    params.compiledObjectives.map((entry) => [entry.id, entry.weight]),
  );
  const gapScoreById = new Map(params.opportunityGaps.map((entry) => [entry.id, entry.score]));
  return params.patterns
    .map((pattern) => {
      const text = `${pattern.algorithm}\n${pattern.whenToUse}\n${pattern.summary}\n${pattern.tags.join(" ")}`;
      const objectiveIds = matchObjectiveIdsFromText(text, params.compiledObjectives);
      const gapIds = matchGapIdsFromText(text, params.opportunityGaps);
      const candidateShape = buildCandidateShapeFromPattern({
        pattern,
        repoRoot: params.repoRoot,
        repoTargets: params.repoTargets,
      });
      const objectiveSignal = clamp01(
        average(
          objectiveIds
            .map((id) => objectiveWeightById.get(id) ?? 0)
            .filter((value) => Number.isFinite(value)),
        ),
      );
      const gapSignal = clamp01(
        Math.max(
          0,
          ...gapIds
            .map((id) => gapScoreById.get(id) ?? 0)
            .filter((value) => Number.isFinite(value)),
        ),
      );
      const sourceSignal = clamp01(
        0.42 * pattern.qualityScore +
          0.3 * pattern.freshnessScore +
          0.12 * pattern.sourceTrustScore +
          0.16 * clamp01(Math.log1p(pattern.seenCount) / Math.log1p(12)),
      );
      const curationAdjustment =
        pattern.sourceCurationStatus === "trusted"
          ? 0.12 + 0.06 * pattern.sourceTrustScore
          : pattern.sourceCurationStatus === "watchlist"
            ? -0.08
            : 0;
      const recentTypeCount = Math.max(
        0,
        Math.floor(asNumber(params.dispatchByType[candidateShape.objective_type], 0)),
      );
      const noveltySignal = clamp01(1 - recentTypeCount / 6);
      const score = clamp01(
        0.42 * objectiveSignal +
          0.28 * gapSignal +
          0.22 * sourceSignal +
          curationAdjustment +
          0.16 * noveltySignal -
          0.08 * params.dispatchSaturation,
      );
      const sourceLabel = pattern.sourceLabel
        ? `source=${pattern.sourceLabel}`
        : `source=${pattern.sourceType}`;
      return {
        id: `insp_${pattern.fingerprint.slice(0, 12)}`,
        algorithm: pattern.algorithm,
        summary: pattern.summary,
        hypothesis:
          `Apply ${pattern.algorithm} when ${pattern.whenToUse}. ` +
          `Adapt the idea to the active repo constraints; avoid direct code copying.`,
        objective_ids: objectiveIds,
        gap_ids: gapIds,
        score,
        evidence: [
          `objective_signal=${objectiveSignal.toFixed(2)}`,
          `gap_signal=${gapSignal.toFixed(2)}`,
          `source_signal=${sourceSignal.toFixed(2)}`,
          `source_curation=${pattern.sourceCurationStatus}`,
          `source_trust=${pattern.sourceTrustScore.toFixed(2)}`,
          `novelty_signal=${noveltySignal.toFixed(2)}`,
          sourceLabel,
          ...(pattern.sourceRefs.slice(0, 2).map((ref) => `ref=${ref}`) ?? []),
        ],
        candidate_shape: candidateShape,
        source_type: pattern.sourceType,
        source_label: pattern.sourceLabel,
        source_url: pattern.sourceUrl,
        source_refs: pattern.sourceRefs,
        source_fingerprint: pattern.fingerprint,
        source_curation_status: pattern.sourceCurationStatus,
        source_curation_reason: pattern.sourceCurationReason,
        source_trust_score: pattern.sourceTrustScore,
        source_freshness_score: pattern.freshnessScore,
      } satisfies EngineIdeaBuildingBlock;
    })
    .sort((a, b) => b.score - a.score);
}

export function summarizeCommitHistoryHints(subjects: string[]): EngineCommitHistoryHint[] {
  const normalizedSubjects = subjects
    .map((entry) => asString(entry))
    .filter(Boolean)
    .slice(0, 240);
  if (normalizedSubjects.length === 0) return [];
  const denominator = Math.max(6, Math.min(24, normalizedSubjects.length));
  const hints: EngineCommitHistoryHint[] = [];
  for (const rule of COMMIT_MOTIF_RULES) {
    const matches = normalizedSubjects.filter((subject) => rule.pattern.test(subject));
    if (matches.length === 0) continue;
    hints.push({
      motif_id: rule.motifId,
      label: rule.label,
      count: matches.length,
      signal: clamp01(matches.length / denominator),
      objective_ids: [...rule.objectiveIds],
      gap_ids: [...rule.gapIds],
      sample_subjects: matches.slice(0, 3),
    });
  }
  return hints.sort((a, b) => {
    if (b.signal !== a.signal) return b.signal - a.signal;
    return b.count - a.count;
  });
}

function buildCommitHistoryBlocks(params: {
  hints: EngineCommitHistoryHint[];
  compiledObjectives: CompiledVisionObjective[];
  opportunityGaps: EngineOpportunityGap[];
  dispatchByType: Record<string, number>;
  dispatchSaturation: number;
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
}): EngineIdeaBuildingBlock[] {
  const objectiveWeightById = new Map(
    params.compiledObjectives.map((entry) => [entry.id, entry.weight]),
  );
  const gapScoreById = new Map(params.opportunityGaps.map((entry) => [entry.id, entry.score]));
  return params.hints
    .slice(0, 6)
    .map((hint) => {
      const rule = COMMIT_MOTIF_RULES.find((entry) => entry.motifId === hint.motif_id);
      if (!rule) return null;
      const candidateShape = adaptCandidateShapeToRepo({
        shape: rule.shape,
        repoRoot: params.repoRoot,
        repoTargets: params.repoTargets,
        hints: [hint.label, ...hint.sample_subjects],
      });
      const objectiveSignal = clamp01(
        average(
          hint.objective_ids
            .map((id) => objectiveWeightById.get(id) ?? 0)
            .filter((value) => Number.isFinite(value)),
        ),
      );
      const gapSignal = clamp01(
        Math.max(
          0,
          ...hint.gap_ids
            .map((id) => gapScoreById.get(id) ?? 0)
            .filter((value) => Number.isFinite(value)),
        ),
      );
      const recentTypeCount = Math.max(
        0,
        Math.floor(asNumber(params.dispatchByType[candidateShape.objective_type], 0)),
      );
      const noveltySignal = clamp01(1 - recentTypeCount / 6);
      const score = clamp01(
        0.4 * objectiveSignal +
          0.28 * gapSignal +
          0.22 * hint.signal +
          0.16 * noveltySignal -
          0.08 * params.dispatchSaturation,
      );
      return {
        id: `history_${hint.motif_id}`,
        algorithm: `commit_history_${hint.motif_id}`,
        summary: `Local commit history repeatedly touches: ${hint.label.toLowerCase()}.`,
        hypothesis:
          `Bias autonomous idea generation toward ${hint.label.toLowerCase()} motifs seen locally ` +
          `to improve merge conversion and delivery reliability.`,
        objective_ids: hint.objective_ids,
        gap_ids: hint.gap_ids,
        score,
        evidence: [
          `motif_count=${hint.count}`,
          `motif_signal=${hint.signal.toFixed(2)}`,
          `objective_signal=${objectiveSignal.toFixed(2)}`,
          `gap_signal=${gapSignal.toFixed(2)}`,
          ...hint.sample_subjects.map((subject) => `commit=${subject}`),
        ],
        candidate_shape: candidateShape,
      } satisfies EngineIdeaBuildingBlock;
    })
    .filter((entry): entry is EngineIdeaBuildingBlock => Boolean(entry))
    .sort((a, b) => b.score - a.score);
}

function cloneCandidateShape(shape: EngineCandidateShape): EngineCandidateShape {
  return {
    ...shape,
    target_paths: [...shape.target_paths],
    write_globs: [...shape.write_globs],
    expected_validation: [...shape.expected_validation],
  };
}

function isCandidateShapeComplete(shape: EngineCandidateShape): boolean {
  return (
    Array.isArray(shape.target_paths) &&
    shape.target_paths.length > 0 &&
    Array.isArray(shape.write_globs) &&
    shape.write_globs.length > 0 &&
    Array.isArray(shape.expected_validation) &&
    shape.expected_validation.length > 0
  );
}

export function adjacent_possible(params: {
  hints?: EngineCommitHistoryHint[];
  gaps?: EngineOpportunityGap[];
  maxIdeas?: number;
  minMotifSignal?: number;
  minGapScore?: number;
}): { ideas: AdjacentPossibleIdea[]; telemetry: AdjacentPossibleTelemetryEvent[] } {
  const hints = Array.isArray(params.hints) ? params.hints : [];
  const gaps = Array.isArray(params.gaps) ? params.gaps : [];
  const configuredMax = Number.isFinite(params.maxIdeas)
    ? Math.max(0, Math.min(ADJACENT_POSSIBLE_MAX_IDEAS, Math.floor(Number(params.maxIdeas))))
    : ADJACENT_POSSIBLE_DEFAULT_MAX_IDEAS;
  const maxIdeas = configuredMax;
  const minSignal = clamp01(
    Number.isFinite(params.minMotifSignal)
      ? Number(params.minMotifSignal)
      : ADJACENT_POSSIBLE_MIN_SIGNAL,
  );
  const minGapScore = clamp01(
    Number.isFinite(params.minGapScore)
      ? Number(params.minGapScore)
      : ADJACENT_POSSIBLE_MIN_GAP_SCORE,
  );
  const telemetry: AdjacentPossibleTelemetryEvent[] = [];
  const recordTelemetry = (event: AdjacentPossibleTelemetryEvent): void => {
    telemetry.push(event);
  };
  const sanitizeIdList = (value: unknown): string[] => [...new Set(asStringArray(value))];
  const mergeUniqueStrings = (existing: string[], additions: string[]): string[] => {
    if (additions.length === 0) return existing;
    const seen = new Set(existing);
    for (const value of additions) {
      if (!seen.has(value)) seen.add(value);
    }
    return [...seen];
  };
  const buildAttemptId = (pair: { motifId: string; gapId: string }): string =>
    `${pair.motifId}::${pair.gapId}`;
  const recordPairOutcome = (
    pair: { motifId: string; gapId: string },
    accepted: boolean,
    details?: { reason?: string; metrics?: Record<string, number> },
  ): string => {
    const attemptId = buildAttemptId(pair);
    recordTelemetry({
      step: "pair_attempt",
      motif_id: pair.motifId,
      gap_id: pair.gapId,
      attempt_id: attemptId,
      accepted,
      ...(details?.reason ? { reason: details.reason } : {}),
      ...(details?.metrics ? { metrics: details.metrics } : {}),
    });
    return attemptId;
  };
  const rejectPair = (
    pair: { motifId: string; gapId: string },
    reason: string,
    metrics?: Record<string, number>,
  ): void => {
    const attemptId = recordPairOutcome(pair, false, { reason, ...(metrics ? { metrics } : {}) });
    recordTelemetry({
      step: "guardrail_drop",
      motif_id: pair.motifId,
      gap_id: pair.gapId,
      attempt_id: attemptId,
      accepted: false,
      reason,
    });
  };

  const ruleByMotifId = new Map(COMMIT_MOTIF_RULES.map((rule) => [rule.motifId, rule]));
  type AggregatedMotifInput = {
    motifId: string;
    motifLabel: string;
    signal: number;
    count: number;
    observedGapIds: string[];
    sourceIndex: number;
  };
  const aggregatedMotifMap = new Map<string, AggregatedMotifInput>();
  hints.forEach((hint, index) => {
    const motifId = asString(hint.motif_id);
    if (!motifId) {
      recordTelemetry({
        step: "motif_screen",
        accepted: false,
        reason: "invalid_motif_id",
      });
      return;
    }
    const motifLabel = asString(hint.label);
    if (!motifLabel) {
      recordTelemetry({
        step: "motif_screen",
        motif_id: motifId,
        accepted: false,
        reason: "invalid_motif_label",
      });
      return;
    }
    const signal = clamp01(asNumber(hint.signal, 0));
    const count = Math.max(0, Math.floor(asNumber(hint.count, 0)));
    const observedGapIds = sanitizeIdList(hint.gap_ids);
    const aggregated = aggregatedMotifMap.get(motifId);
    if (!aggregated) {
      aggregatedMotifMap.set(motifId, {
        motifId,
        motifLabel,
        signal,
        count,
        observedGapIds,
        sourceIndex: index,
      });
      return;
    }
    const mergedGapIds = mergeUniqueStrings(aggregated.observedGapIds, observedGapIds);
    const shouldReplace =
      signal > aggregated.signal ||
      (signal === aggregated.signal && count > aggregated.count) ||
      (signal === aggregated.signal &&
        count === aggregated.count &&
        index > aggregated.sourceIndex);
    if (shouldReplace) {
      aggregatedMotifMap.set(motifId, {
        motifId,
        motifLabel,
        signal,
        count,
        observedGapIds: mergedGapIds,
        sourceIndex: index,
      });
      return;
    }
    aggregatedMotifMap.set(motifId, {
      ...aggregated,
      observedGapIds: mergedGapIds,
    });
  });
  const aggregatedMotifs = [...aggregatedMotifMap.values()].sort((a, b) =>
    a.motifId.localeCompare(b.motifId),
  );

  type AggregatedGapInput = { gapId: string; gapLabel: string; score: number; sourceIndex: number };
  const aggregatedGapMap = new Map<string, AggregatedGapInput>();
  gaps.forEach((gap, index) => {
    const gapId = asString(gap.id);
    if (!gapId) {
      recordTelemetry({
        step: "gap_screen",
        accepted: false,
        reason: "invalid_gap_id",
      });
      return;
    }
    const gapLabel = asString(gap.label);
    if (!gapLabel) {
      recordTelemetry({
        step: "gap_screen",
        gap_id: gapId,
        accepted: false,
        reason: "invalid_gap_label",
      });
      return;
    }
    const score = clamp01(asNumber(gap.score, 0));
    const existing = aggregatedGapMap.get(gapId);
    if (
      !existing ||
      score > existing.score ||
      (score === existing.score && index > existing.sourceIndex)
    ) {
      aggregatedGapMap.set(gapId, { gapId, gapLabel, score, sourceIndex: index });
    }
  });
  const aggregatedGaps = [...aggregatedGapMap.values()].sort((a, b) =>
    a.gapId.localeCompare(b.gapId),
  );

  type EligibleMotif = {
    rule: CommitMotifRule;
    motifId: string;
    motifLabel: string;
    observedGapIds: string[];
    signal: number;
    novelty: number;
    candidateShape: EngineCandidateShape;
  };
  const eligibleMotifs: EligibleMotif[] = [];
  for (const hint of aggregatedMotifs) {
    const motifId = hint.motifId;
    const motifLabel = hint.motifLabel;
    const rule = ruleByMotifId.get(motifId);
    if (!rule) {
      recordTelemetry({
        step: "motif_screen",
        motif_id: motifId,
        accepted: false,
        reason: "unknown_motif",
      });
      continue;
    }
    const signal = clamp01(hint.signal);
    if (signal < minSignal) {
      recordTelemetry({
        step: "motif_screen",
        motif_id: motifId,
        accepted: false,
        reason: "motif_signal_below_threshold",
        metrics: { signal },
      });
      continue;
    }
    const candidateShape = cloneCandidateShape(rule.shape);
    if (!isCandidateShapeComplete(candidateShape)) {
      recordTelemetry({
        step: "motif_screen",
        motif_id: motifId,
        accepted: false,
        reason: "candidate_shape_incomplete",
      });
      continue;
    }
    const novelty = clamp01(1 - clamp01(hint.count / ADJACENT_POSSIBLE_NOVELTY_DIVISOR));
    eligibleMotifs.push({
      rule,
      motifId,
      motifLabel,
      observedGapIds: [...hint.observedGapIds],
      signal,
      novelty,
      candidateShape,
    });
    recordTelemetry({
      step: "motif_screen",
      motif_id: motifId,
      accepted: true,
      metrics: { signal, novelty },
    });
  }

  type EligibleGap = { gapId: string; gapLabel: string; score: number };
  const eligibleGaps: EligibleGap[] = [];
  for (const gap of aggregatedGaps) {
    const gapId = gap.gapId;
    const gapLabel = gap.gapLabel;
    const score = clamp01(gap.score);
    const accepted = score >= minGapScore;
    recordTelemetry({
      step: "gap_screen",
      gap_id: gapId,
      accepted,
      metrics: { score },
      ...(accepted ? {} : { reason: "gap_score_below_threshold" }),
    });
    if (!accepted) continue;
    eligibleGaps.push({ gapId, gapLabel, score });
  }

  const seenPairs = new Set<string>();
  const generatedIdeas: AdjacentPossibleIdea[] = [];
  for (const motif of eligibleMotifs) {
    for (const gap of eligibleGaps) {
      const pairKey = `${motif.motifId}:${gap.gapId}`;
      const pairContext = { motifId: motif.motifId, gapId: gap.gapId };
      if (seenPairs.has(pairKey)) {
        rejectPair(pairContext, "duplicate_pair");
        continue;
      }
      seenPairs.add(pairKey);
      const supportsGap =
        motif.rule.gapIds.includes(gap.gapId) || motif.observedGapIds.includes(gap.gapId);
      if (!supportsGap) {
        rejectPair(pairContext, "gap_not_supported");
        continue;
      }
      if (!isCandidateShapeComplete(motif.candidateShape)) {
        rejectPair(pairContext, "candidate_shape_incomplete");
        continue;
      }
      const coverageBoost = motif.observedGapIds.includes(gap.gapId)
        ? ADJACENT_POSSIBLE_COVERAGE_BOOST
        : 0;
      const score = clamp01(
        ADJACENT_POSSIBLE_GAP_WEIGHT * gap.score +
          ADJACENT_POSSIBLE_SIGNAL_WEIGHT * motif.signal +
          ADJACENT_POSSIBLE_NOVELTY_WEIGHT * motif.novelty +
          coverageBoost,
      );
      const idea: AdjacentPossibleIdea = {
        id: `adjacent_possible_${motif.motifId}_${gap.gapId}`,
        motif_id: motif.motifId,
        gap_id: gap.gapId,
        motif_label: motif.motifLabel,
        gap_label: gap.gapLabel,
        score,
        summary: `Adjacent possible: ${motif.motifLabel} targeting ${gap.gapLabel}`,
        hypothesis:
          `Blend the ${motif.motifLabel.toLowerCase()} motif with ${gap.gapLabel.toLowerCase()} telemetry ` +
          "to relieve the active bottleneck without widening scope.",
        evidence: [
          `motif_signal=${motif.signal.toFixed(2)}`,
          `motif_novelty=${motif.novelty.toFixed(2)}`,
          `gap_score=${gap.score.toFixed(2)}`,
          `coverage_boost=${coverageBoost.toFixed(2)}`,
        ],
        candidate_shape: cloneCandidateShape(motif.candidateShape),
      };
      recordPairOutcome(pairContext, true, { metrics: { score } });
      generatedIdeas.push(idea);
    }
  }

  generatedIdeas.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  const allowedIdeaCount = maxIdeas > 0 ? Math.min(maxIdeas, generatedIdeas.length) : 0;
  const selectedIdeas = generatedIdeas.slice(0, allowedIdeaCount);
  const truncationReason = maxIdeas <= 0 ? "max_ideas_disabled" : "max_ideas_limit";
  generatedIdeas.forEach((idea, index) => {
    const attemptId = buildAttemptId({ motifId: idea.motif_id, gapId: idea.gap_id });
    if (index < allowedIdeaCount) {
      recordTelemetry({
        step: "idea_emitted",
        motif_id: idea.motif_id,
        gap_id: idea.gap_id,
        attempt_id: attemptId,
        accepted: true,
        metrics: { score: idea.score, rank: index + 1 },
      });
    } else {
      recordTelemetry({
        step: "idea_truncated",
        motif_id: idea.motif_id,
        gap_id: idea.gap_id,
        attempt_id: attemptId,
        accepted: false,
        reason: truncationReason,
        metrics: { score: idea.score, rank: index + 1 },
      });
    }
  });

  return { ideas: selectedIdeas, telemetry };
}

export function buildEngineInspirationContext(params: {
  vision: Pick<VisionContext, "one_sentence" | "key_items" | "section_numbers"> & {
    sections?: VisionContext["sections"];
  };
  snapshot: EngineIdeaInputSnapshot;
  inspirationPatterns?: unknown[];
  sourceInsights?: unknown[];
  commitHistoryHints?: EngineCommitHistoryHint[];
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
}): EngineInspirationContext {
  const oneSentence = asString(params.vision.one_sentence);
  const keyItems = params.vision.key_items;
  const compiledRepoObjectives = compileRepoVisionObjectives({ vision: params.vision });
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

  const failureSignal = maxSignalScore(params.snapshot, [
    "test_failure",
    "lint_failure",
    "typecheck_failure",
  ]);
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
      score: clamp01(
        0.5 * failureSignal + 0.25 * reliabilityTrait + 0.15 * queueSignal + 0.1 * regretSignal,
      ),
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

  const staticBuildingBlocks: EngineIdeaBuildingBlock[] = ENGINE_IDEA_BLUEPRINTS.map(
    (blueprint) => {
      const candidateShape = adaptCandidateShapeToRepo({
        shape: blueprint.candidate_shape,
        repoRoot: params.repoRoot,
        repoTargets: params.repoTargets,
        hints: [
          blueprint.algorithm,
          blueprint.summary,
          blueprint.hypothesis,
          ...blueprint.objective_ids,
          ...blueprint.gap_ids,
        ],
      });
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
        Math.floor(asNumber(dispatchByType[candidateShape.objective_type], 0)),
      );
      const noveltySignal = clamp01(1 - recentTypeCount / 6);
      const score = clamp01(
        0.52 * objectiveSignal + 0.33 * gapSignal + 0.2 * noveltySignal - 0.08 * dispatchSaturation,
      );
      return {
        ...blueprint,
        candidate_shape: candidateShape,
        score,
        evidence: [
          `objective_signal=${objectiveSignal.toFixed(2)}`,
          `gap_signal=${gapSignal.toFixed(2)}`,
          `novelty_signal=${noveltySignal.toFixed(2)}`,
          `dispatch_saturation=${dispatchSaturation.toFixed(2)}`,
        ],
      };
    },
  );

  const normalizedPatterns = (
    Array.isArray(params.inspirationPatterns) ? params.inspirationPatterns : []
  )
    .map((entry) => normalizeInspirationPattern(entry))
    .filter((entry): entry is InspirationPatternInput => Boolean(entry));
  const sourceInsights = Array.isArray(params.sourceInsights) ? params.sourceInsights : [];
  const curatedPatterns = applySourceCurationToPatterns(normalizedPatterns, sourceInsights).slice(
    0,
    80,
  );
  const sourcePatterns: EngineInspirationSourcePattern[] = curatedPatterns.map((pattern) => ({
    id: pattern.id,
    source_type: pattern.sourceType,
    source_label: pattern.sourceLabel,
    source_url: pattern.sourceUrl,
    source_refs: pattern.sourceRefs,
    algorithm: pattern.algorithm,
    when_to_use: pattern.whenToUse,
    summary: pattern.summary,
    tags: pattern.tags,
    quality_score: pattern.qualityScore,
    freshness_score: pattern.freshnessScore,
    seen_count: pattern.seenCount,
    source_curation_status: pattern.sourceCurationStatus,
    source_curation_reason: pattern.sourceCurationReason,
    source_trust_score: pattern.sourceTrustScore,
  }));
  const externalBlocks = buildExternalInspirationBlocks({
    patterns: curatedPatterns,
    compiledObjectives,
    opportunityGaps,
    dispatchByType,
    dispatchSaturation,
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets,
  });
  const commitHistoryHints = Array.isArray(params.commitHistoryHints)
    ? params.commitHistoryHints.slice(0, 10)
    : [];
  const historyBlocks = buildCommitHistoryBlocks({
    hints: commitHistoryHints,
    compiledObjectives,
    opportunityGaps,
    dispatchByType,
    dispatchSaturation,
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets,
  });
  const buildingBlockMap = new Map<string, EngineIdeaBuildingBlock>();
  for (const block of [...staticBuildingBlocks, ...externalBlocks, ...historyBlocks]) {
    if (!buildingBlockMap.has(block.id)) {
      buildingBlockMap.set(block.id, block);
      continue;
    }
    const existing = buildingBlockMap.get(block.id);
    if (!existing || block.score > existing.score) {
      buildingBlockMap.set(block.id, block);
    }
  }
  const buildingBlocks = [...buildingBlockMap.values()].sort((a, b) => b.score - a.score);

  return {
    compiled_repo_objectives: compiledRepoObjectives,
    compiled_objectives: compiledObjectives,
    opportunity_gaps: opportunityGaps,
    building_blocks: buildingBlocks,
    source_patterns: sourcePatterns,
    commit_history_hints: commitHistoryHints,
  };
}

function compactIdeationText(value: unknown, maxChars: number): string {
  const text = asString(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function compactIdeationTextList(values: unknown[], maxItems: number, maxChars: number): string[] {
  return values
    .slice(0, maxItems)
    .map((value) => compactIdeationText(value, maxChars))
    .filter(Boolean);
}

function compactVisionContextForIdeationRetry(vision: VisionContext): Record<string, unknown> {
  const compactKeyItems = Object.fromEntries(
    Object.entries(vision.key_items).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? compactIdeationTextList(value, 6, 260)
        : compactIdeationText(value, 260),
    ]),
  );
  return {
    one_sentence: compactIdeationText(vision.one_sentence, 360),
    sections: vision.sections.slice(0, 4).map((section) => ({
      number: section.number,
      title: compactIdeationText(section.title, 160),
      markdown: compactIdeationText(section.markdown, 500),
      truncated: section.truncated || section.markdown.length > 500,
    })),
    key_items: compactKeyItems,
    section_numbers: vision.section_numbers.slice(0, 8),
    truncated: vision.truncated,
  };
}

function compactEngineInspirationForIdeationRetry(
  context: EngineInspirationContext,
): Record<string, unknown> {
  return {
    compiled_repo_objectives: context.compiled_repo_objectives.slice(0, 4).map((objective) => ({
      id: objective.id,
      title: objective.title,
      weight: objective.weight,
      section_ref: objective.section_ref,
      category: objective.category,
      success_criteria: compactIdeationTextList(objective.success_criteria, 3, 220),
      validation_expectations: compactIdeationTextList(objective.validation_expectations, 3, 220),
    })),
    compiled_objectives: context.compiled_objectives.slice(0, 4).map((objective) => ({
      id: objective.id,
      title: compactIdeationText(objective.title, 220),
      weight: objective.weight,
      evidence: compactIdeationTextList(objective.evidence, 3, 220),
    })),
    opportunity_gaps: context.opportunity_gaps.slice(0, 4).map((gap) => ({
      id: gap.id,
      label: compactIdeationText(gap.label, 220),
      score: gap.score,
      evidence: compactIdeationTextList(gap.evidence, 3, 220),
    })),
    building_blocks: context.building_blocks.slice(0, 6).map((block) => ({
      id: block.id,
      algorithm: block.algorithm,
      summary: compactIdeationText(block.summary, 260),
      hypothesis: compactIdeationText(block.hypothesis, 260),
      score: block.score,
      objective_ids: block.objective_ids.slice(0, 3),
      gap_ids: block.gap_ids.slice(0, 3),
      candidate_shape: {
        objective_type: block.candidate_shape.objective_type,
        trigger_type: block.candidate_shape.trigger_type,
        component_area: block.candidate_shape.component_area,
        target_paths: block.candidate_shape.target_paths.slice(0, 4),
        write_globs: block.candidate_shape.write_globs.slice(0, 4),
      },
    })),
    source_patterns: context.source_patterns.slice(0, 4).map((pattern) => ({
      id: pattern.id,
      algorithm: pattern.algorithm,
      summary: compactIdeationText(pattern.summary, 260),
      tags: compactIdeationTextList(pattern.tags, 5, 80),
      quality_score: pattern.quality_score,
      freshness_score: pattern.freshness_score,
      source_trust_score: pattern.source_trust_score,
    })),
    commit_history_hints: context.commit_history_hints.slice(0, 4).map((hint) => ({
      motif_id: hint.motif_id,
      label: compactIdeationText(hint.label, 220),
      count: hint.count,
      signal: hint.signal,
      objective_ids: hint.objective_ids.slice(0, 3),
      gap_ids: hint.gap_ids.slice(0, 3),
      sample_subjects: compactIdeationTextList(hint.sample_subjects, 3, 180),
    })),
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
  const score = Number.isFinite(asNumber(raw.score, Number.NaN))
    ? asNumber(raw.score, 0)
    : undefined;
  const sourceType = asString(raw.source_type ?? raw.sourceType);
  const sourceLabel = asString(raw.source_label ?? raw.sourceLabel);
  const sourceUrl = asString(raw.source_url ?? raw.sourceUrl);
  const sourceFingerprint = asString(raw.source_fingerprint ?? raw.sourceFingerprint);
  const sourceKey =
    asString(raw.source_key ?? raw.sourceKey) ||
    deriveInspirationSourceKey({
      sourceFingerprint,
      sourceType,
      sourceLabel,
      sourceUrl,
    });
  return {
    building_block_id: buildingBlockId,
    algorithm: asString(raw.algorithm) || "engine_building_block",
    source,
    ...(typeof score === "number" ? { score } : {}),
    objective_ids: asStringArray(raw.objective_ids ?? raw.objectiveIds),
    gap_ids: asStringArray(raw.gap_ids ?? raw.gapIds ?? raw.opportunity_gap_ids),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(sourceType ? { source_type: sourceType } : {}),
    ...(sourceLabel ? { source_label: sourceLabel } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(sourceFingerprint ? { source_fingerprint: sourceFingerprint } : {}),
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
  const sourceKey = deriveInspirationSourceKey({
    sourceFingerprint: fallback.source_fingerprint,
    sourceType: fallback.source_type,
    sourceLabel: fallback.source_label,
    sourceUrl: fallback.source_url,
  });
  return {
    building_block_id: fallback.id,
    algorithm: fallback.algorithm,
    source: "engine_mapped",
    score: fallback.score,
    objective_ids: fallback.objective_ids,
    gap_ids: fallback.gap_ids,
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(fallback.source_type ? { source_type: fallback.source_type } : {}),
    ...(fallback.source_label ? { source_label: fallback.source_label } : {}),
    ...(fallback.source_url ? { source_url: fallback.source_url } : {}),
    ...(fallback.source_fingerprint ? { source_fingerprint: fallback.source_fingerprint } : {}),
    summary: fallback.summary,
    hypothesis: fallback.hypothesis,
  };
}

export function buildRepoVisionFallbackCandidates(params: {
  engineInspiration: EngineInspirationContext;
  snapshotTopSignals: EngineIdeaInputSnapshot["top_signals"];
  visionSectionRefs: string[];
  maxCandidates?: number;
  repoTargets?: RepoTargetProfile[];
}): Array<Record<string, unknown>> {
  const maxCandidates = Number.isFinite(params.maxCandidates)
    ? Math.max(1, Math.min(6, Math.floor(params.maxCandidates as number)))
    : 3;
  const sectionRefs = selectVisionSectionRefs(params.visionSectionRefs);
  const objectives = params.engineInspiration.compiled_repo_objectives
    .filter((objective) => objective.weight >= 0.42)
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const aRank = a.priority_rank ?? Number.MAX_SAFE_INTEGER;
      const bRank = b.priority_rank ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      const aMeta = isMetaRepoObjective(a) ? 1 : 0;
      const bMeta = isMetaRepoObjective(b) ? 1 : 0;
      if (aMeta !== bMeta) return aMeta - bMeta;
      return a.id.localeCompare(b.id);
    })
    .slice(0, maxCandidates);

  return objectives.map((objective, idx) => {
    const target = chooseRepoObjectiveTargetProfile(params.repoTargets ?? [], objective);
    const targetPaths = target?.target_paths ?? [objective.section_ref ? `vision.md` : "README.md"];
    const writeGlobs = target?.write_globs ?? targetPaths;
    const componentArea =
      target?.component_area ??
      normalizeAutonomyComponentArea(pathDirname(targetPaths[0]) || targetPaths[0]) ??
      "docs";
    const triggerType = categoryTriggerType(objective.category, params.snapshotTopSignals);
    const signalIds = pickSignalIdsForTrigger(params.snapshotTopSignals, triggerType);
    const sectionRef = objective.section_ref || sectionRefs[0] || "";
    const categorySummary = [
      objective.category,
      ...objective.secondary_categories.slice(0, 2),
    ].join(", ");
    return {
      id: `cand_repo_${objective.id}_${randomUUID().slice(0, 8)}`,
      title: `Vision objective: ${objective.title}`,
      objective_type: categoryObjectiveType(objective.category),
      problem_statement:
        `Advance the repo vision objective "${objective.title}" (${categorySummary}). ` +
        "Deliver one small, observable improvement using the repo's own product/domain language.",
      trigger_type: triggerType,
      component_area: componentArea,
      target_paths: targetPaths,
      scope: {
        read_anywhere: true,
        write_globs: writeGlobs,
      },
      risk_level: "low",
      expected_validation: normalizeValidationIdeas(
        objective.validation_expectations.length > 0
          ? objective.validation_expectations
          : ["bun run test:root"],
      ),
      estimated_effort: idx === 0 ? "small" : "medium",
      why_now_signal_ids: signalIds,
      confidence: clamp01(0.5 + objective.weight * 0.45),
      vision_alignment_reason:
        `Highest repo vision category ${objective.category}; source=${objective.source_bucket}; ` +
        `priority=${objective.priority_rank ?? "n/a"}; section=${sectionRef || "n/a"}.`,
      vision_section_refs: sectionRef ? [sectionRef] : sectionRefs,
      feature_hypotheses: [
        objective.success_criteria[0]
          ? `Success signal: ${objective.success_criteria[0]}`
          : `Improve ${objective.title} without widening scope.`,
        objective.constraints[0] ? `Guardrail: ${objective.constraints[0]}` : "",
        objective.validation_expectations[0]
          ? `Validation expectation: ${objective.validation_expectations[0]}`
          : "Validate through the smallest repo-supported check.",
      ].filter(Boolean),
      requires_user_input: false,
      question_if_blocked: "",
    } as Record<string, unknown>;
  });
}

export function buildEngineFallbackCandidates(params: {
  engineInspiration: EngineInspirationContext;
  snapshotTopSignals: EngineIdeaInputSnapshot["top_signals"];
  visionSectionRefs: string[];
  maxCandidates?: number;
  repoRoot?: string;
  repoTargets?: RepoTargetProfile[];
}): Array<Record<string, unknown>> {
  const maxCandidates = Number.isFinite(params.maxCandidates)
    ? Math.max(1, Math.min(6, Math.floor(params.maxCandidates as number)))
    : 3;
  const objectiveTitleById = new Map(
    params.engineInspiration.compiled_objectives.map((objective) => [
      objective.id,
      objective.title,
    ]),
  );
  const sectionRefs = selectVisionSectionRefs(params.visionSectionRefs);

  return params.engineInspiration.building_blocks
    .filter((block) => block.score >= 0.42)
    .slice(0, maxCandidates)
    .map((block, idx) => {
      const candidateShape = adaptCandidateShapeToRepo({
        shape: block.candidate_shape,
        repoRoot: params.repoRoot,
        repoTargets: params.repoTargets,
        hints: [block.algorithm, block.summary, block.hypothesis, ...block.evidence],
      });
      const signalIds = pickSignalIdsForTrigger(
        params.snapshotTopSignals,
        block.candidate_shape.trigger_type,
      );
      const objectiveTitles = block.objective_ids
        .map((id) => objectiveTitleById.get(id))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, 3);
      const primaryObjectiveTitle = objectiveTitles[0] ?? "vision priorities";
      const sourceAttribution =
        block.source_label || block.source_type
          ? `Source inspiration: ${block.source_label ?? block.source_type}.`
          : "";
      const sourceCurationNote =
        block.source_curation_status && block.source_curation_status !== "candidate"
          ? `Source curation: ${block.source_curation_status}${block.source_curation_reason ? ` (${block.source_curation_reason})` : ""}.`
          : "";
      const sourceKey = deriveInspirationSourceKey({
        sourceFingerprint: block.source_fingerprint,
        sourceType: block.source_type,
        sourceLabel: block.source_label,
        sourceUrl: block.source_url,
      });
      return {
        id: `cand_engine_${block.id}_${randomUUID().slice(0, 8)}`,
        title: `Engine building block: ${block.algorithm}`,
        objective_type: candidateShape.objective_type,
        problem_statement:
          `Implement ${block.algorithm} in the active repo autonomy loop to improve ${primaryObjectiveTitle}. ` +
          `Deliver a small, test-backed change with clear operational telemetry.`,
        trigger_type: candidateShape.trigger_type,
        component_area: candidateShape.component_area,
        target_paths: candidateShape.target_paths,
        scope: {
          read_anywhere: true,
          write_globs: candidateShape.write_globs,
        },
        risk_level: candidateShape.risk_level,
        expected_validation: candidateShape.expected_validation,
        estimated_effort: idx === 0 ? "small" : "medium",
        why_now_signal_ids: signalIds,
        confidence: clamp01(0.45 + block.score * 0.5),
        vision_alignment_reason: `Prioritize ${primaryObjectiveTitle} using ${block.algorithm}; score=${block.score.toFixed(2)}.`,
        vision_section_refs: sectionRefs,
        feature_hypotheses: [
          block.summary,
          block.hypothesis,
          ...(sourceAttribution ? [sourceAttribution] : []),
          ...(sourceCurationNote ? [sourceCurationNote] : []),
          `Add measurable telemetry and guardrails for ${block.algorithm}.`,
        ].slice(0, 3),
        engine_trial: {
          building_block_id: block.id,
          algorithm: block.algorithm,
          source: "engine_fallback",
          score: block.score,
          objective_ids: block.objective_ids,
          gap_ids: block.gap_ids,
          ...(sourceKey ? { source_key: sourceKey } : {}),
          ...(block.source_type ? { source_type: block.source_type } : {}),
          ...(block.source_label ? { source_label: block.source_label } : {}),
          ...(block.source_url ? { source_url: block.source_url } : {}),
          ...(block.source_fingerprint ? { source_fingerprint: block.source_fingerprint } : {}),
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
): value is
  | "test_failure"
  | "lint_failure"
  | "typecheck_failure"
  | "queue_health"
  | "regret_signal" {
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
  private readonly llmCfg: PushPalsConfig["remotebuddy"]["llm"];
  private readonly cfg: PushPalsConfig["remotebuddy"]["autonomy"];
  private runtimeEnabled = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private startupFastTickTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private nextTickAtMs = 0;
  private startupFastTickAttemptsRemaining = 0;
  private currentRunId: string | null = null;
  private currentPhase = "idle";
  private currentPhaseStartedAtMs = 0;
  private currentRunStartedAtMs = 0;
  private lastOutcome: "none" | "success" | "skipped" | "failed" = "none";
  private lastDetail = "not_started";
  private lastCompletedAtMs = 0;
  private pendingIdeationTimeoutRecovery: IdeationTimeoutRecovery | null = null;

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
    this.baseBranch =
      String(opts.config.sourceControlManager.baseBranch || "main").trim() || "main";
    this.llm = opts.llm;
    this.comm = opts.comm;
    this.llmCfg = opts.config.remotebuddy.llm;
    this.cfg = opts.config.remotebuddy.autonomy;
    this.runtimeEnabled = this.cfg.enabled;
  }

  setRuntimeEnabled(enabled: boolean): void {
    this.runtimeEnabled = Boolean(enabled);
    if (!this.runtimeEnabled) {
      this.nextTickAtMs = 0;
      this.startupFastTickAttemptsRemaining = 0;
      this.clearStartupFastTickTimer();
      if (!this.currentRunId) {
        this.lastOutcome = "skipped";
        this.lastDetail = "disabled_by_runtime_config";
        this.lastCompletedAtMs = Date.now();
        this.setPhase("idle");
      }
    }
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

  private markTickDone(outcome: "success" | "skipped" | "failed", detail: string): void {
    this.currentRunId = null;
    this.currentRunStartedAtMs = 0;
    this.lastOutcome = outcome;
    this.lastDetail = detail || "unspecified";
    this.lastCompletedAtMs = Date.now();
    this.setPhase("idle");
  }

  private logHeartbeat(): void {
    if (!this.runtimeEnabled) return;
    const now = Date.now();
    if (this.currentRunId) {
      const runElapsedMs = Math.max(0, now - this.currentRunStartedAtMs);
      const phaseElapsedMs = Math.max(0, now - this.currentPhaseStartedAtMs);
      console.log(
        `[RemoteBuddyAutonomousEngine] heartbeat: status=running run=${this.currentRunId} phase=${this.currentPhase} run_elapsed_ms=${runElapsedMs} phase_elapsed_ms=${phaseElapsedMs}`,
      );
      return;
    }

    const hasScheduledTick = Boolean(
      this.timer || this.startupGraceTimer || this.startupFastTickTimer,
    );
    const nextTickInMs =
      hasScheduledTick && this.nextTickAtMs > 0 ? Math.max(0, this.nextTickAtMs - now) : 0;
    const lastAgeMs = this.lastCompletedAtMs > 0 ? Math.max(0, now - this.lastCompletedAtMs) : -1;
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
    const maxPhaseTimeoutMs = Math.max(
      this.phaseTimeoutMs("ideation"),
      this.phaseTimeoutMs("scoring"),
      this.phaseTimeoutMs("planning"),
    );
    return Math.max(
      this.cfg.tickIntervalMs * 3,
      this.cfg.ideationBudgetMs * 2 + maxPhaseTimeoutMs * 6,
      30_000,
    );
  }

  private lockStaleAfterMs(): number {
    // Same-session retries are safe to recover sooner: a healthy in-process cycle is guarded
    // by `inFlight`, while a restarted process needs a bounded way past an orphaned lease.
    return Math.max(this.phaseTimeoutMs("ideation") + 30_000, this.cfg.heartbeatLogMs * 2, 120_000);
  }

  private startupLockStaleAfterMs(): number {
    return Math.min(
      this.lockStaleAfterMs(),
      Math.max(
        5_000,
        Math.min(STARTUP_STALE_LOCK_AFTER_MS, Math.floor(this.cfg.tickIntervalMs / 4)),
      ),
    );
  }

  private lockStaleAfterMsForAcquire(): number {
    return this.startupFastTickAttemptsRemaining > 0
      ? this.startupLockStaleAfterMs()
      : this.lockStaleAfterMs();
  }

  private startupFastTickDelayMs(): number {
    return Math.max(
      1_000,
      Math.min(STARTUP_FAST_TICK_MAX_DELAY_MS, Math.floor(this.cfg.tickIntervalMs / 10)),
    );
  }

  private startupGraceMs(): number {
    return Math.max(0, this.cfg.startupGraceMs ?? 0);
  }

  private clearStartupGraceTimer(): void {
    if (this.startupGraceTimer) {
      clearTimeout(this.startupGraceTimer);
      this.startupGraceTimer = null;
    }
  }

  private clearStartupFastTickTimer(): void {
    if (this.startupFastTickTimer) {
      clearTimeout(this.startupFastTickTimer);
      this.startupFastTickTimer = null;
    }
  }

  private scheduleStartupFastTick(reason: string): void {
    if (!this.runtimeEnabled || !this.timer || this.startupFastTickTimer) return;
    if (this.startupFastTickAttemptsRemaining <= 0) return;
    const delayMs = this.startupFastTickDelayMs();
    this.startupFastTickAttemptsRemaining -= 1;
    this.nextTickAtMs = Date.now() + delayMs;
    console.log(
      `[RemoteBuddyAutonomousEngine] startup fast tick scheduled in ${delayMs}ms after ${reason} (remaining=${this.startupFastTickAttemptsRemaining}).`,
    );
    this.startupFastTickTimer = setTimeout(() => {
      this.startupFastTickTimer = null;
      if (!this.runtimeEnabled || !this.timer) return;
      this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
      void this.tick();
    }, delayMs);
  }

  private cycleBudgetMs(): number {
    const ideationTimeoutMs = this.phaseTimeoutMs("ideation");
    const scoringTimeoutMs = this.phaseTimeoutMs("scoring");
    const planningTimeoutMs = this.phaseTimeoutMs("planning");
    const maxPhaseTimeoutMs = Math.max(ideationTimeoutMs, scoringTimeoutMs, planningTimeoutMs);
    // One cycle includes ideation + scoring + planning LLM phases plus dispatch work.
    return Math.max(
      this.cfg.ideationBudgetMs + ideationTimeoutMs + scoringTimeoutMs + planningTimeoutMs,
      maxPhaseTimeoutMs * 4,
      20_000,
    );
  }

  private phaseTimeoutMs(phase: "ideation" | "scoring" | "planning"): number {
    const configuredTimeoutMs = Math.max(1_000, this.cfg.llmTimeoutMs);
    if (phase !== "ideation") return configuredTimeoutMs;
    if (
      String(this.llmCfg.backend || "")
        .trim()
        .toLowerCase() !== "openai_codex"
    ) {
      return configuredTimeoutMs;
    }
    const codexTimeoutMs = Math.max(configuredTimeoutMs, this.llmCfg.codexTimeoutMs || 0);
    return Math.min(codexTimeoutMs, Math.max(configuredTimeoutMs, 90_000));
  }

  private consumeIdeationTimeoutRecovery(): IdeationTimeoutRecovery | null {
    const recovery = this.pendingIdeationTimeoutRecovery;
    this.pendingIdeationTimeoutRecovery = null;
    return recovery;
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
        testing_criteria: keyItems.testingCriteria,
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
    return data.ok ? (data.snapshot ?? null) : null;
  }

  private async fetchWorkerLoadSnapshot(): Promise<WorkerLoadSnapshot | null> {
    try {
      const res = await fetch(`${this.server}/workers/autoscale?ttlMs=15000`, {
        method: "GET",
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        ok?: boolean;
        workers?: WorkerLoadSnapshot["workers"];
        jobs?: WorkerLoadSnapshot["jobs"];
        prs?: Partial<WorkerLoadSnapshot["prs"]>;
      };
      if (!data.ok || !data.workers || !data.jobs) return null;
      return {
        workers: data.workers,
        jobs: data.jobs,
        prs: {
          openUnmerged: Math.max(0, Math.floor(asNumber(asObject(data.prs).openUnmerged, 0))),
        },
      };
    } catch {
      return null;
    }
  }

  private deferReasonForWorkerLoad(snapshot: WorkerLoadSnapshot): string | null {
    const busyWorkers = Math.max(0, Math.floor(asNumber(snapshot.workers.busy, 0)));
    const pendingJobs = Math.max(0, Math.floor(asNumber(snapshot.jobs.pending, 0)));
    const autoscalablePending = Math.max(
      0,
      Math.floor(asNumber(snapshot.jobs.autoscalablePending, 0)),
    );
    if (busyWorkers <= 0 && pendingJobs <= 0 && autoscalablePending <= 0) {
      return null;
    }
    return `worker_load_busy_${busyWorkers}_pending_${pendingJobs}_autoscalable_${autoscalablePending}`;
  }

  private async fetchInspirationPatterns(limit = 60): Promise<unknown[]> {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(400, Math.floor(limit)))),
    });
    const res = await fetch(`${this.server}/autonomy/inspiration?${qs.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { ok?: boolean; patterns?: unknown[] };
    return data.ok && Array.isArray(data.patterns) ? data.patterns : [];
  }

  private async fetchInspirationSourceInsights(limit = 120): Promise<unknown[]> {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(400, Math.floor(limit)))),
      feedbackLimit: "1",
    });
    const res = await fetch(`${this.server}/autonomy/insights?${qs.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      ok?: boolean;
      engineSourceStats?: unknown[];
      trustedInspirationShortlist?: unknown[];
      archivedInspirationSources?: unknown[];
    };
    if (!data.ok) return [];
    const rows = Array.isArray(data.engineSourceStats) ? data.engineSourceStats : [];
    if (rows.length > 0) return rows;
    const trusted = Array.isArray(data.trustedInspirationShortlist)
      ? data.trustedInspirationShortlist
      : [];
    const archived = Array.isArray(data.archivedInspirationSources)
      ? data.archivedInspirationSources
      : [];
    return [...trusted, ...archived];
  }

  private buildAutoInspirationEntries(
    commitHistoryHints: EngineCommitHistoryHint[],
  ): Array<Record<string, unknown>> {
    const staticEntries = AUTO_INGEST_SEED_PATTERNS.map((seed) => ({
      source_type: "internal_doc",
      source_label: "pushpals:autonomy-engine",
      source_url: "",
      algorithm: seed.algorithm,
      when_to_use: seed.whenToUse,
      summary: seed.summary,
      risks: seed.risks,
      validation: seed.validation,
      tags: seed.tags,
      quality_score: seed.qualityScore,
      freshness_score: seed.freshnessScore,
      metadata: {
        origin: "autonomy_engine_seed",
      },
    }));
    const commitEntries = commitHistoryHints.slice(0, 8).map((hint) => ({
      source_type: "internal_doc",
      source_label: "pushpals:commit-history",
      source_url: "",
      algorithm: `commit_history_${hint.motif_id}`,
      when_to_use: `when local history repeatedly indicates ${hint.label.toLowerCase()}`,
      summary:
        `Local commit history shows recurring ${hint.label.toLowerCase()} motifs (${hint.count} hits). ` +
        "Bias ideas toward this motif while keeping scope small and testable.",
      risks: ["Historical bias can overweight past patterns over current needs."],
      validation: ["Verify motif-driven objectives improve acceptance and reduce reopen rate."],
      tags: ["local_history", "motif", "autonomy", hint.motif_id],
      quality_score: clamp01(0.52 + 0.35 * clamp01(hint.signal)),
      freshness_score: 0.7,
      metadata: {
        origin: "autonomy_engine_commit_history",
        motif_id: hint.motif_id,
        motif_count: hint.count,
        objective_ids: hint.objective_ids,
        gap_ids: hint.gap_ids,
        sample_subjects: hint.sample_subjects.slice(0, 3),
      },
    }));
    return [...staticEntries, ...commitEntries];
  }

  private async ingestAutoInspirationPatterns(
    runId: string,
    commitHistoryHints: EngineCommitHistoryHint[],
  ): Promise<void> {
    const entries = this.buildAutoInspirationEntries(commitHistoryHints);
    if (entries.length === 0) return;
    try {
      const res = await fetch(`${this.server}/autonomy/inspiration/ingest`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) {
        console.warn(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest failed with HTTP ${res.status}.`,
        );
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        inserted?: unknown;
        updated?: unknown;
        skipped?: unknown;
      };
      if (data.ok === false) {
        console.warn(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest returned ok=false.`,
        );
        return;
      }
      const inserted = Math.max(0, Math.floor(asNumber(data.inserted, 0)));
      const updated = Math.max(0, Math.floor(asNumber(data.updated, 0)));
      const skipped = Math.max(0, Math.floor(asNumber(data.skipped, 0)));
      console.log(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: ingested inspiration seeds (inserted=${inserted} updated=${updated} skipped=${skipped}).`,
      );
    } catch (error) {
      console.warn(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest errored: ${String(error)}`,
      );
    }
  }

  private async loadCommitHistoryHints(): Promise<EngineCommitHistoryHint[]> {
    const raw = await gitOutput(this.autonomyRepo, ["log", "--pretty=format:%s", "-n", "180"]);
    if (!raw) return [];
    const subjects = raw
      .split(/\r?\n/g)
      .map((line) => asString(line))
      .filter(Boolean);
    return summarizeCommitHistoryHints(subjects).slice(0, 8);
  }

  private async postObjective(payload: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`${this.server}/autonomy/objectives`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    return res.ok;
  }

  private async acquireDispatchLock(runId: string): Promise<{ ok: boolean; reason?: string }> {
    const ttlMs = this.lockTtlMs();
    const res = await fetch(`${this.server}/autonomy/lock/acquire`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        ttlMs,
        staleAfterMs: this.lockStaleAfterMsForAcquire(),
      }),
    });
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = asString(payload.reason ?? payload.message);
    return { ok: false, reason };
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
    const timeoutMs = this.phaseTimeoutMs(phase);
    const requestPayload = {
      phase,
      system: input.system,
      messages: input.messages,
      json: Boolean(input.json),
      maxTokens: input.maxTokens ?? null,
      temperature: input.temperature ?? null,
    };
    const systemChars = input.system.length;
    const messageChars = (input.messages ?? []).reduce(
      (sum, message) => sum + (message.content?.length ?? 0),
      0,
    );
    const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload), "utf8");
    const startedAt = Date.now();
    console.log(
      `[RemoteBuddyAutonomousEngine] ${phase} phase start: timeout_ms=${timeoutMs} system_chars=${systemChars} message_chars=${messageChars} request_bytes=${requestBytes} max_tokens=${input.maxTokens ?? "default"} temperature=${input.temperature ?? "default"}`,
    );
    let output: Awaited<ReturnType<LLMClient["generate"]>>;
    try {
      output = await withTimeout(
        this.llm.generate(input),
        timeoutMs,
        `autonomy ${phase} phase timeout`,
      );
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (
        phase === "ideation" &&
        error instanceof Error &&
        error.message === "autonomy ideation phase timeout"
      ) {
        this.pendingIdeationTimeoutRecovery = {
          previousRunId: runId,
          timedOutAt: new Date().toISOString(),
          timeoutMs,
        };
      }
      console.warn(
        `[RemoteBuddyAutonomousEngine] ${phase} phase failed: elapsed_ms=${elapsedMs} timeout_ms=${timeoutMs} system_chars=${systemChars} message_chars=${messageChars} request_bytes=${requestBytes} error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    const responseJson = parseJsonObject(output.text);
    const tokenUsage = output.usage ?? null;
    const latencyMs = Date.now() - startedAt;
    console.log(
      `[RemoteBuddyAutonomousEngine] ${phase} phase completed: elapsed_ms=${latencyMs} timeout_ms=${timeoutMs} response_chars=${output.text.length} prompt_tokens=${tokenUsage?.promptTokens ?? "unknown"} completion_tokens=${tokenUsage?.completionTokens ?? "unknown"}`,
    );
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
        timeoutMs,
        response: responseJson,
        responseHash: sha256(output.text),
        tokenUsage,
        latencyMs,
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
    if (!this.runtimeEnabled) return null;
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
        .filter(
          (entry): entry is { signal_id: string; type: string; value: number; evidence: string } =>
            Boolean(entry),
        )
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
    const sourceKey = candidate.engine_trial
      ? asString(candidate.engine_trial.source_key) ||
        deriveInspirationSourceKey({
          sourceFingerprint: candidate.engine_trial.source_fingerprint,
          sourceType: candidate.engine_trial.source_type,
          sourceLabel: candidate.engine_trial.source_label,
          sourceUrl: candidate.engine_trial.source_url,
        })
      : "";
    const sourcePrior = candidate.engine_trial
      ? (snapshot.engine_source_priors ?? []).find((entry) => {
          const entryKey = asString(entry.source_key);
          if (sourceKey && entryKey === sourceKey) return true;
          const candidateFingerprint = asString(candidate.engine_trial?.source_fingerprint);
          const entryFingerprint = asString(entry.source_fingerprint);
          if (candidateFingerprint && entryFingerprint && candidateFingerprint === entryFingerprint)
            return true;
          return false;
        })
      : null;
    const penalties: Array<{ kind: any; weight: number; reason: string; evidence_ids: string[] }> =
      [];
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
    const sourcePriorSignal = engineSourcePriorSignalForScoring(sourcePrior);
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
    if (sourcePriorSignal.curationStatus === "archived") {
      penalties.push({
        kind: "source_archived",
        weight: sourcePriorSignal.curationPenalty,
        reason:
          sourcePriorSignal.curationReason ||
          "inspiration source is archived due to low-performing outcomes",
        evidence_ids: candidate.why_now_signal_ids,
      });
    } else if (sourcePriorSignal.curationStatus === "watchlist") {
      penalties.push({
        kind: "source_watchlist",
        weight: sourcePriorSignal.curationPenalty,
        reason:
          sourcePriorSignal.curationReason ||
          "inspiration source on watchlist due to mixed outcomes",
        evidence_ids: candidate.why_now_signal_ids,
      });
    }
    const normalizedPenalties = normalizePenalties(penalties);
    const finalScore =
      0.46 * clamp01(llmScore) +
      0.2 * clamp01(impactSignal) +
      priorSignal.priorScore +
      enginePriorSignal.priorScore +
      sourcePriorSignal.priorScore +
      enginePriorSignal.noveltyBonus +
      sourcePriorSignal.noveltyBonus +
      sourcePriorSignal.trustBoost -
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
      engineSourcePriorScore: sourcePriorSignal.priorScore,
      engineSourceNoveltyScore: sourcePriorSignal.noveltyScore,
      engineSourceNoveltyBonus: sourcePriorSignal.noveltyBonus,
      engineSourceSampleCount: sourcePriorSignal.sampleCount,
      engineSourceTrustScore: sourcePriorSignal.trustScore,
      engineSourceFreshnessScore: sourcePriorSignal.freshnessScore,
      engineSourceCurationStatus: sourcePriorSignal.curationStatus,
      engineSourceCurationReason: sourcePriorSignal.curationReason,
      engineSourceTrustBoost: sourcePriorSignal.trustBoost,
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
      results?: Array<{
        candidate_id?: string;
        candidateId?: string;
        ok?: boolean;
        reason?: string;
      }>;
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
    if (!this.runtimeEnabled || this.cfg.killSwitchEnabled || this.inFlight) return;
    this.inFlight = true;
    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
    this.markTickStart(runId);
    const cycleDeadline = Date.now() + this.cycleBudgetMs();
    let lockAcquired = false;
    let outcome: "success" | "skipped" | "failed" = "skipped";
    let outcomeDetail = "not_dispatched";
    try {
      this.setPhase("acquire_lock");
      const lockResult = await this.acquireDispatchLock(runId);
      lockAcquired = lockResult.ok;
      if (!lockAcquired) {
        outcomeDetail = lockResult.reason
          ? compactStatusDetail(`lock_not_acquired:${lockResult.reason}`)
          : "lock_not_acquired";
        return;
      }
      this.startupFastTickAttemptsRemaining = 0;
      this.clearStartupFastTickTimer();

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

      this.setPhase("discover_repo_targets");
      const repoTargets = discoverRepoTargetProfiles(this.autonomyRepo, 16);

      this.setPhase("fetch_snapshot");
      const snapshot = await this.fetchSnapshot(runId, preflight);
      if (!snapshot) {
        outcomeDetail = "snapshot_unavailable";
        return;
      }
      const snapshotSafety = asObject(snapshot.safety_state);
      if (asBoolean(snapshotSafety.kill_switch_enabled, false)) {
        outcomeDetail = "kill_switch_enabled";
        return;
      }
      if (asBoolean(snapshotSafety.is_frozen, false)) {
        const freezeUntil = asString(snapshotSafety.freeze_until);
        outcomeDetail = freezeUntil ? `frozen_until_${freezeUntil}` : "frozen";
        return;
      }
      const snapshotResourceBudget = asObject(snapshot.resource_budget);
      if (asBoolean(snapshotResourceBudget.token_budget_exhausted, false)) {
        outcomeDetail = "resource_budget_token_exhausted";
        return;
      }
      if (asBoolean(snapshotResourceBudget.runtime_budget_exhausted, false)) {
        outcomeDetail = "resource_budget_runtime_exhausted";
        return;
      }

      this.setPhase("check_worker_load");
      const workerLoad = await this.fetchWorkerLoadSnapshot();
      const workerLoadDeferReason = workerLoad ? this.deferReasonForWorkerLoad(workerLoad) : null;
      if (workerLoad && workerLoadDeferReason) {
        console.log(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: deferring ideation due to active worker load (busy=${workerLoad.workers.busy} pending=${workerLoad.jobs.pending} autoscalablePending=${workerLoad.jobs.autoscalablePending}).`,
        );
        outcomeDetail = workerLoadDeferReason;
        return;
      }

      this.setPhase("load_vision_context");
      const visionContext = this.loadVisionContext(runId);
      if (!visionContext) {
        outcomeDetail = "vision_unavailable";
        return;
      }
      this.setPhase("collect_engine_inspiration");
      const commitHistoryHints = await this.loadCommitHistoryHints();
      this.setPhase("ingest_engine_inspiration");
      await this.ingestAutoInspirationPatterns(runId, commitHistoryHints);
      this.setPhase("collect_engine_inspiration");
      const [inspirationPatterns, sourceInsights] = await Promise.all([
        this.fetchInspirationPatterns(80),
        this.fetchInspirationSourceInsights(160),
      ]);
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
        inspirationPatterns,
        sourceInsights,
        commitHistoryHints,
        repoRoot: this.autonomyRepo,
        repoTargets,
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
      const buildIdeationInput = (
        ideationRecovery: IdeationTimeoutRecovery | null,
        compactRetry: boolean,
      ): Parameters<LLMClient["generate"]>[0] => {
        const reduced = compactRetry || Boolean(ideationRecovery);
        const ideationTopSignals = snapshot.top_signals.slice(0, reduced ? 5 : 10);
        const ideationStateTraits = snapshot.state_traits.slice(0, reduced ? 6 : 12);
        const ideationFeedbackPriors = snapshot.feedback_priors.slice(0, reduced ? 4 : 8);
        const ideationEngineIdeaPriors = (snapshot.engine_idea_priors ?? []).slice(
          0,
          reduced ? 4 : 8,
        );
        const ideationOpenObjectives = snapshot.open_objectives.slice(0, reduced ? 4 : 8);
        const ideationActiveCooldowns = snapshot.active_cooldowns.slice(0, reduced ? 4 : 8);
        const ideationRepoTargets = repoTargets.slice(0, reduced ? 4 : 8);
        return {
          system: IDEATION_SYSTEM_PROMPT,
          json: true,
          maxTokens: reduced ? IDEATION_RETRY_MAX_TOKENS : IDEATION_NORMAL_MAX_TOKENS,
          temperature: 0.2,
          messages: [
            ...(ideationRecovery
              ? [
                  {
                    role: "user" as const,
                    content: `${IDEATION_TIMEOUT_RECOVERY_INSTRUCTION} Previous timed-out run: ${ideationRecovery.previousRunId}. Timeout budget for this round: ${this.phaseTimeoutMs("ideation")}ms.`,
                  },
                ]
              : []),
            {
              role: "user",
              content: JSON.stringify(
                {
                  snapshot: {
                    snapshot_id: snapshot.snapshot_id,
                    top_signals: ideationTopSignals,
                    state_traits: ideationStateTraits,
                    feedback_priors: ideationFeedbackPriors,
                    engine_idea_priors: ideationEngineIdeaPriors,
                    open_objectives: ideationOpenObjectives,
                    active_cooldowns: ideationActiveCooldowns,
                  },
                  vision: compactVisionContextForIdeationRetry(visionContext),
                  repo_targets: ideationRepoTargets.map((target) => ({
                    component_area: target.component_area,
                    target_paths: target.target_paths,
                    write_globs: target.write_globs,
                    label: target.label,
                    keywords: target.keywords.slice(0, reduced ? 4 : 8),
                  })),
                  engine_inspiration: compactEngineInspirationForIdeationRetry(engineInspiration),
                  limits: {
                    ideation_max_candidates: reduced
                      ? Math.max(1, Math.min(3, this.cfg.ideationMaxCandidates))
                      : Math.max(
                          1,
                          Math.min(IDEATION_NORMAL_MAX_CANDIDATES, this.cfg.ideationMaxCandidates),
                        ),
                    min_confidence: this.cfg.minConfidence,
                  },
                },
                null,
                0,
              ),
            },
          ],
        };
      };
      let ideationRecovery = this.consumeIdeationTimeoutRecovery();
      if (ideationRecovery) {
        console.warn(
          `[RemoteBuddyAutonomousEngine] tick ${runId}: applying one-shot ideation timeout recovery from ${ideationRecovery.previousRunId} after ${ideationRecovery.timeoutMs}ms timeout.`,
        );
      }
      let ideationPhase: { json: Record<string, unknown>; llmCall: Record<string, unknown> };
      try {
        ideationPhase = await this.llmPhase(
          "ideation",
          runId,
          snapshot.snapshot_id,
          buildIdeationInput(ideationRecovery, Boolean(ideationRecovery)),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "autonomy ideation phase timeout" &&
          !ideationRecovery
        ) {
          ideationRecovery = {
            previousRunId: runId,
            timedOutAt: new Date().toISOString(),
            timeoutMs: this.phaseTimeoutMs("ideation"),
          };
          this.pendingIdeationTimeoutRecovery = null;
          console.warn(
            `[RemoteBuddyAutonomousEngine] tick ${runId}: ideation timed out; retrying once immediately with reduced context and budget-focused guidance.`,
          );
          ideationPhase = await this.llmPhase(
            "ideation",
            runId,
            snapshot.snapshot_id,
            buildIdeationInput(ideationRecovery, true),
          );
          this.pendingIdeationTimeoutRecovery = null;
        } else {
          throw error;
        }
      }
      llmCalls.push(ideationPhase.llmCall);
      const ideationJson = ideationPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_ideation";
        return;
      }
      let rawCandidates = Array.isArray(ideationJson.candidates) ? ideationJson.candidates : [];
      let rawCandidatesSource: "llm" | "repo_vision_fallback" | "engine_fallback" = "llm";
      if (rawCandidates.length === 0) {
        const repoSynthesized = buildRepoVisionFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
          repoTargets,
        });
        const synthesized =
          repoSynthesized.length > 0
            ? repoSynthesized
            : buildEngineFallbackCandidates({
                engineInspiration,
                snapshotTopSignals: snapshot.top_signals,
                visionSectionRefs: visionContext.section_numbers,
                maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
                repoRoot: this.autonomyRepo,
                repoTargets,
              });
        if (synthesized.length > 0) {
          console.log(
            `[RemoteBuddyAutonomousEngine] tick ${runId}: ideation returned no candidates; using ${synthesized.length} deterministic ${
              repoSynthesized.length > 0 ? "repo-vision" : "engine-inspiration"
            } fallback candidates.`,
          );
          rawCandidates = synthesized;
          rawCandidatesSource =
            repoSynthesized.length > 0 ? "repo_vision_fallback" : "engine_fallback";
        }
      }
      const normalizedCandidates: AutonomyCandidate[] = [];
      const dropReasonCounts = new Map<string, number>();
      const allowPushPalsInternalCandidates = isPushPalsRepository(this.autonomyRepo);
      const recordDropReason = (reason: string): void => {
        dropReasonCounts.set(reason, (dropReasonCounts.get(reason) ?? 0) + 1);
      };
      const ingestRawCandidates = (
        rawList: unknown[],
        source: "llm" | "repo_vision_fallback" | "engine_fallback",
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
            component_area: (normalizeAutonomyComponentArea(c.component_area ?? c.componentArea) ??
              "") as AutonomyComponentArea,
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
              normalizeEngineTrialMetadata(
                c.engine_trial ?? c.engineTrial ?? asObject(c.debug).engine_trial,
              ) ?? undefined,
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
            { requireWriteGlobs: true, hintsOnly: true },
          );
          if (!scopeValidation.ok) {
            recordDropReason(`${source}_scope_validation_failed`);
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
          candidate.component_area = (scopeValidation.componentArea ??
            candidate.component_area) as AutonomyComponentArea;
          candidate.target_paths = scopeValidation.normalizedTargetPaths;
          candidate.scope.write_globs = scopeValidation.normalizedWriteGlobs;
          if (
            !allowPushPalsInternalCandidates &&
            candidateLeaksPushPalsInternals(candidate)
          ) {
            recordDropReason(`${source}_pushpals_internal_leak`);
            console.warn(
              `[RemoteBuddyAutonomousEngine] dropping candidate ${candidate.id}: PushPals-internal concepts do not belong in user-repo autonomy work.`,
            );
            continue;
          }
          const missingTargetPaths = findMissingRepoTargetPaths(
            this.autonomyRepo,
            candidate.target_paths,
          );
          if (missingTargetPaths.length > 0) {
            recordDropReason(`${source}_target_paths_missing_in_repo`);
            console.warn(
              `[RemoteBuddyAutonomousEngine] dropping candidate ${candidate.id}: target_paths missing in repo ${missingTargetPaths.join(
                ", ",
              )}`,
            );
            continue;
          }
          if (!candidate.engine_trial && source !== "repo_vision_fallback") {
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
      ingestRawCandidates(rawCandidates, rawCandidatesSource);
      if (normalizedCandidates.length === 0) {
        const repoSynthesizedFallback = buildRepoVisionFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
          repoTargets,
        });
        const synthesizedFallback =
          repoSynthesizedFallback.length > 0
            ? repoSynthesizedFallback
            : buildEngineFallbackCandidates({
                engineInspiration,
                snapshotTopSignals: snapshot.top_signals,
                visionSectionRefs: visionContext.section_numbers,
                maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
                repoRoot: this.autonomyRepo,
                repoTargets,
              });
        if (synthesizedFallback.length > 0) {
          ingestRawCandidates(
            synthesizedFallback,
            repoSynthesizedFallback.length > 0 ? "repo_vision_fallback" : "engine_fallback",
          );
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
      const evaluatorRecommendation = asString(snapshot.evaluator?.recommendation).toLowerCase();
      const exploreBaseRate =
        evaluatorRecommendation === "pause"
          ? 0
          : evaluatorRecommendation === "constrain"
            ? Math.min(this.cfg.exploreRate, 0.15)
            : this.cfg.exploreRate;
      const adaptiveExplore = computeAdaptiveExploreRate({
        baseRate: exploreBaseRate,
        minRate: evaluatorRecommendation === "pause" ? 0 : ENGINE_EXPLORE_RATE_MIN,
        maxRate: evaluatorRecommendation === "pause" ? 0 : ENGINE_EXPLORE_RATE_MAX,
        snapshot,
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
        engine_source_prior_score: row.engineSourcePriorScore,
        engine_source_novelty_score: row.engineSourceNoveltyScore,
        engine_source_novelty_bonus: row.engineSourceNoveltyBonus,
        engine_source_sample_count: row.engineSourceSampleCount,
        engine_source_trust_score: row.engineSourceTrustScore,
        engine_source_freshness_score: row.engineSourceFreshnessScore,
        engine_source_curation_status: row.engineSourceCurationStatus,
        engine_source_curation_reason: row.engineSourceCurationReason,
        engine_source_trust_boost: row.engineSourceTrustBoost,
        explore_rate_configured: adaptiveExplore.baseRate,
        effective_explore_rate: adaptiveExplore.effectiveRate,
        explore_rate_adjustment: adaptiveExplore.adjustment,
        penalties: row.penalties,
        final_score: row.finalScore,
        gate_decision: row.eligibility.ok ? "approved" : "rejected",
        gate_reasons: row.eligibility.ok ? [] : [row.eligibility.reason],
        selected: false,
        selection_strategy: "not_selected",
        selection_roll: null,
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
        exploreRate: adaptiveExplore.effectiveRate,
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
            ...(selected.candidate.engine_trial
              ? { engine_trial: selected.candidate.engine_trial }
              : {}),
            selection_strategy: selectedStrategy,
            selection_roll: selection.roll,
            effective_explore_rate: adaptiveExplore.effectiveRate,
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
            selection_roll: null,
            effective_explore_rate: adaptiveExplore.effectiveRate,
          };
      for (const row of candidatesPayload) {
        const isSelected = Boolean(row.id === selectedCandidatePayload.id);
        row.selected = isSelected;
        row.selection_strategy = isSelected && selected ? selectedStrategy : "not_selected";
        row.selection_roll = isSelected ? selection.roll : null;
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
              engine_source_prior_score: top.engineSourcePriorScore,
              engine_source_novelty_score: top.engineSourceNoveltyScore,
              engine_source_novelty_bonus: top.engineSourceNoveltyBonus,
              engine_source_sample_count: top.engineSourceSampleCount,
              engine_source_trust_score: top.engineSourceTrustScore,
              engine_source_freshness_score: top.engineSourceFreshnessScore,
              engine_source_curation_status: top.engineSourceCurationStatus,
              engine_source_curation_reason: top.engineSourceCurationReason,
              engine_source_trust_boost: top.engineSourceTrustBoost,
              explore_rate_configured: adaptiveExplore.baseRate,
              effective_explore_rate: adaptiveExplore.effectiveRate,
              explore_rate_adjustment: adaptiveExplore.adjustment,
              final_score: top.finalScore,
              selection_strategy: "none",
              selection_roll: null,
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
              engine_source_prior_score: selected.engineSourcePriorScore,
              engine_source_novelty_score: selected.engineSourceNoveltyScore,
              engine_source_novelty_bonus: selected.engineSourceNoveltyBonus,
              engine_source_sample_count: selected.engineSourceSampleCount,
              engine_source_trust_score: selected.engineSourceTrustScore,
              engine_source_freshness_score: selected.engineSourceFreshnessScore,
              engine_source_curation_status: selected.engineSourceCurationStatus,
              engine_source_curation_reason: selected.engineSourceCurationReason,
              engine_source_trust_boost: selected.engineSourceTrustBoost,
              explore_rate_configured: adaptiveExplore.baseRate,
              effective_explore_rate: adaptiveExplore.effectiveRate,
              explore_rate_adjustment: adaptiveExplore.adjustment,
              final_score: selected.finalScore,
              selection_strategy: selectedStrategy,
              selection_roll: selection.roll,
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
      let instruction = canonicalizeInstructionTextForBun(
        asString(planningJson.instruction) ||
          `${selected.candidate.title}\n\n${selected.candidate.problem_statement}\n\nScope:\n- target_paths: ${selected.candidate.target_paths.join(
            ", ",
          )}\n- write_globs: ${selected.candidate.scope.write_globs.join(", ")}`,
      );
      if (
        !isPushPalsRepository(this.autonomyRepo) &&
        containsPushPalsInternalUserRepoText(instruction)
      ) {
        console.warn(
          `[RemoteBuddyAutonomousEngine] replacing autonomy instruction for ${selected.candidate.id}: planner output contained PushPals-internal wording.`,
        );
        instruction = canonicalizeInstructionTextForBun(
          buildRepoNativeFallbackInstruction(selected.candidate),
        );
      }

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
            engine_source_prior_score: selected.engineSourcePriorScore,
            engine_source_novelty_score: selected.engineSourceNoveltyScore,
            engine_source_novelty_bonus: selected.engineSourceNoveltyBonus,
            engine_source_sample_count: selected.engineSourceSampleCount,
            engine_source_trust_score: selected.engineSourceTrustScore,
            engine_source_freshness_score: selected.engineSourceFreshnessScore,
            engine_source_curation_status: selected.engineSourceCurationStatus,
            engine_source_curation_reason: selected.engineSourceCurationReason,
            engine_source_trust_boost: selected.engineSourceTrustBoost,
            explore_rate_configured: adaptiveExplore.baseRate,
            effective_explore_rate: adaptiveExplore.effectiveRate,
            explore_rate_adjustment: adaptiveExplore.adjustment,
            final_score: selected.finalScore,
            selection_strategy: selectedStrategy,
            selection_roll: selection.roll,
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
      if (!lockAcquired && outcomeDetail.startsWith("lock_not_acquired")) {
        this.scheduleStartupFastTick("dispatch lock contention");
      }
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
    if (!this.runtimeEnabled) return null;
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
    if (!this.runtimeEnabled || this.timer || this.startupGraceTimer) return;
    console.log(
      `[RemoteBuddyAutonomousEngine] Using dedicated autonomy worktree ${this.autonomyRepo} (remote=${this.gitRemote} integration=${this.integrationBranch} base=${this.baseBranch}).`,
    );
    this.startupFastTickAttemptsRemaining = STARTUP_FAST_TICK_MAX_ATTEMPTS;
    const startInterval = () => {
      if (this.timer) return;
      this.timer = setInterval(() => {
        this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
        void this.tick();
      }, this.cfg.tickIntervalMs);
    };
    const firstTickDelayMs = this.startupGraceMs();
    this.nextTickAtMs = Date.now() + firstTickDelayMs;
    this.heartbeatTimer = setInterval(() => {
      this.logHeartbeat();
    }, this.cfg.heartbeatLogMs);
    this.logHeartbeat();
    if (firstTickDelayMs > 0) {
      console.log(
        `[RemoteBuddyAutonomousEngine] startup autonomy tick delayed by ${firstTickDelayMs}ms to leave cold-start capacity available for user work.`,
      );
      this.startupGraceTimer = setTimeout(() => {
        this.startupGraceTimer = null;
        if (!this.runtimeEnabled) return;
        startInterval();
        this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
        void this.tick();
      }, firstTickDelayMs);
      return;
    }
    startInterval();
    this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
    void this.tick();
  }

  stop(): void {
    this.clearStartupGraceTimer();
    this.clearStartupFastTickTimer();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.startupFastTickAttemptsRemaining = 0;
    this.nextTickAtMs = 0;
  }
}
