import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import { loadPushPalsConfig, type PushPalsConfig } from "shared";
import {
  makePatternKey,
  normalizePenalties,
  penaltyTotal,
  validateScopeInvariants,
  type AutonomyComponentArea,
  type AutonomyGlobBreadth,
  type AutonomyObjectiveType,
  type AutonomyRiskLevel,
} from "shared";

type QueueSloSummary = {
  queueWaitMs?: { p95: number | null };
  failed?: number;
  completed?: number;
};

interface SignalValue {
  signal_id: string;
  type: "test_failure" | "lint_failure" | "typecheck_failure" | "queue_health" | "regret_signal";
  value: number;
  evidence: string;
}

interface StateTrait {
  trait_id: string;
  category: "strength" | "weakness" | "opportunity" | "risk";
  focus: string;
  score: number;
  evidence: string;
}

interface FeedbackPrior {
  pattern_key: string;
  ema_success: number;
  ema_user_accept: number;
  ema_latency: number;
  ema_regret: number;
  fail_streak: number;
  sample_count: number;
  cooldown_until: string | null;
  updated_at: string;
}

interface EngineIdeaPrior {
  engine_building_block_id: string;
  engine_algorithm: string;
  ema_success: number;
  ema_user_accept: number;
  ema_latency: number;
  ema_regret: number;
  sample_count: number;
  updated_at: string;
}

interface PrFeedbackSignalRow {
  verdict: string | null;
  summary: string | null;
  comment_count: number | null;
}

interface PrFeedbackComment {
  body: string;
  user_login: string;
  created_at: string;
  html_url: string;
}

interface OpenObjective {
  objective_id: string;
  status: string;
  objective_type: string;
  pattern_key: string;
  updated_at: string;
}

interface ObjectivePolicy {
  maxRisk: AutonomyRiskLevel;
  maxGlobBreadth: AutonomyGlobBreadth;
  autonomousAllowed: boolean;
  requireValidation: boolean;
  dependencyChanges: boolean;
}

const OBJECTIVE_POLICY: Record<AutonomyObjectiveType, ObjectivePolicy> = {
  flaky_test: {
    maxRisk: "low",
    maxGlobBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  lint_fix: {
    maxRisk: "low",
    maxGlobBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  type_fix: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  small_refactor: {
    maxRisk: "medium",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  feature_small: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  feature_medium: {
    maxRisk: "medium",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
    dependencyChanges: false,
  },
  feature_large: {
    maxRisk: "high",
    maxGlobBreadth: "broad",
    autonomousAllowed: false,
    requireValidation: true,
    dependencyChanges: false,
  },
  docs: {
    maxRisk: "low",
    maxGlobBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: false,
    dependencyChanges: false,
  },
  dep_bump: {
    maxRisk: "medium",
    maxGlobBreadth: "narrow",
    autonomousAllowed: false,
    requireValidation: true,
    dependencyChanges: true,
  },
};

const RISK_ORDER: Record<AutonomyRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const BREADTH_ORDER: Record<AutonomyGlobBreadth, number> = { narrow: 0, medium: 1, broad: 2 };
const OBJECTIVE_TYPES = new Set<AutonomyObjectiveType>(Object.keys(OBJECTIVE_POLICY) as AutonomyObjectiveType[]);
const COMPONENT_AREAS = new Set<AutonomyComponentArea>([
  "apps/server",
  "apps/remotebuddy",
  "apps/workerpals",
  "apps/client",
  "packages/protocol",
  "packages/shared",
  "tests/integration",
  "tests/unit",
]);
const TRIGGER_TYPES = new Set<SignalValue["type"]>([
  "test_failure",
  "lint_failure",
  "typecheck_failure",
  "queue_health",
  "regret_signal",
]);
const RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS = 24;

function isNegativePrFeedbackVerdict(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes("reject") ||
    text.includes("unmergeable") ||
    text.includes("merge_conflict") ||
    text.includes("merge_failed") ||
    text.includes("failed")
  );
}

function deriveOutcomeFromPrFeedbackVerdict(
  verdict: string,
): { success: boolean; userAction: string; reopenedWithin24h: boolean; regressionFlag: boolean } | null {
  const text = verdict.toLowerCase();
  if (isNegativePrFeedbackVerdict(text)) {
    return {
      success: false,
      userAction: "rejected",
      reopenedWithin24h: true,
      regressionFlag: true,
    };
  }
  if (text.includes("approved") || text.includes("merged")) {
    return {
      success: true,
      userAction: "accepted",
      reopenedWithin24h: false,
      regressionFlag: false,
    };
  }
  return null;
}

export interface AutonomySnapshot {
  snapshot_id: string;
  snapshot_created_at: string;
  snapshot_ttl_ms: number;
  impact_model_version: string;
  top_signals: SignalValue[];
  state_traits: StateTrait[];
  feedback_priors: FeedbackPrior[];
  engine_idea_priors: EngineIdeaPrior[];
  active_cooldowns: Array<{ pattern_key: string; cooldown_until: string }>;
  open_objectives: OpenObjective[];
  repo_health_flags: {
    is_worktree_dirty: boolean;
    is_merge_in_progress: boolean;
    dispatch_lock_held: boolean;
  };
  dispatch_budget: {
    rolling_window_seconds: number;
    global_count_last_hour: number;
    by_type_count_last_hour: Record<string, number>;
  };
}

export interface AutonomyPatternStatsInsight {
  patternKey: string;
  emaSuccess: number;
  emaUserAccept: number;
  emaLatency: number;
  emaRegret: number;
  failStreak: number;
  sampleCount: number;
  cooldownUntil: string | null;
  updatedAt: string;
}

export interface AutonomyPrFeedbackInsight {
  id: number;
  createdAt: string;
  source: string;
  patternKey: string;
  objectiveId: string | null;
  requestId: string | null;
  jobId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  verdict: string;
  reviewScore: number | null;
  reviewThreshold: number | null;
  summary: string | null;
  commentCount: number;
  comments: PrFeedbackComment[];
}

export interface AutonomyInsights {
  patternStats: AutonomyPatternStatsInsight[];
  recentPrFeedback: AutonomyPrFeedbackInsight[];
}

function asIsoNow(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
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

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function norm(x: number, min: number, max: number): number {
  if (!Number.isFinite(x) || max <= min) return 0;
  return clamp01((x - min) / (max - min));
}

function normalizeSignalType(value: string): SignalValue["type"] {
  const text = value.toLowerCase();
  if (/\blint\b/.test(text)) return "lint_failure";
  if (/\btype(check)?\b/.test(text)) return "typecheck_failure";
  if (/\btest|pytest|vitest|jest\b/.test(text)) return "test_failure";
  if (/\bregret|reopen|re-open\b/.test(text)) return "regret_signal";
  return "queue_health";
}

function asRiskLevel(value: unknown): AutonomyRiskLevel | null {
  const text = asString(value).toLowerCase();
  if (text === "low" || text === "medium" || text === "high") return text;
  return null;
}

function asObjectiveType(value: unknown): AutonomyObjectiveType | null {
  const text = asString(value);
  if (!text) return null;
  return OBJECTIVE_TYPES.has(text as AutonomyObjectiveType) ? (text as AutonomyObjectiveType) : null;
}

function asComponentArea(value: unknown): AutonomyComponentArea | null {
  const text = asString(value);
  if (!text) return null;
  return COMPONENT_AREAS.has(text as AutonomyComponentArea) ? (text as AutonomyComponentArea) : null;
}

function asTriggerType(value: unknown): SignalValue["type"] | null {
  const text = asString(value);
  if (!text) return null;
  return TRIGGER_TYPES.has(text as SignalValue["type"]) ? (text as SignalValue["type"]) : null;
}

function scopedCandidateStorageId(runId: string, candidateId: string): string {
  const normalizedRunId = asString(runId);
  const normalizedCandidateId = asString(candidateId);
  if (!normalizedRunId) return normalizedCandidateId || randomUUID();
  if (!normalizedCandidateId) return `${normalizedRunId}:${randomUUID()}`;
  const prefix = `${normalizedRunId}:`;
  if (normalizedCandidateId.startsWith(prefix)) return normalizedCandidateId;
  return `${prefix}${normalizedCandidateId}`;
}

type EngineTrialCandidateMeta = {
  buildingBlockId: string;
  algorithm: string;
  source: string;
  score: number | null;
  objectiveIds: string[];
  gapIds: string[];
  metadata: Record<string, unknown>;
};

function parseEngineBuildingBlockIdFromCandidateId(candidateId: string): string {
  if (!candidateId.startsWith("cand_engine_")) return "";
  const suffix = candidateId.slice("cand_engine_".length);
  if (!suffix) return "";
  const pieces = suffix.split("_");
  if (pieces.length < 2) return "";
  pieces.pop();
  return pieces.join("_").trim();
}

function deriveEngineAlgorithmFromTitle(title: string): string {
  const prefix = "engine building block:";
  const text = title.trim();
  if (!text) return "";
  if (!text.toLowerCase().startsWith(prefix)) return "";
  return text.slice(prefix.length).trim();
}

function extractEngineTrialCandidateMeta(record: Record<string, unknown>): EngineTrialCandidateMeta | null {
  const candidateId = asString(record.id);
  const title = asString(record.title);
  const trial = asObject(
    record.engine_trial ??
      record.engineTrial ??
      record.engine_inspiration ??
      record.engineInspiration ??
      asObject(record.debug).engine_trial ??
      asObject(record.debug).engineTrial,
  );
  const explicitBlockId = asString(
    trial.building_block_id ??
      trial.buildingBlockId ??
      trial.block_id ??
      trial.blockId ??
      trial.engine_building_block_id ??
      trial.engineBuildingBlockId,
  );
  const fallbackBlockId = parseEngineBuildingBlockIdFromCandidateId(candidateId);
  const buildingBlockId = explicitBlockId || fallbackBlockId;
  if (!buildingBlockId) return null;

  const explicitAlgorithm = asString(trial.algorithm ?? trial.algo ?? trial.name);
  const algorithm = explicitAlgorithm || deriveEngineAlgorithmFromTitle(title) || "engine_building_block";
  const score = Number.isFinite(asNumber(trial.score, Number.NaN)) ? asNumber(trial.score, 0) : null;
  const source = asString(trial.source) || (fallbackBlockId ? "engine_fallback" : "llm");
  const objectiveIds = asStringArray(trial.objective_ids ?? trial.objectiveIds);
  const gapIds = asStringArray(trial.gap_ids ?? trial.gapIds ?? trial.opportunity_gap_ids);

  const metadata = asObject(trial.metadata);
  const summary = asString(trial.summary);
  if (summary) metadata.summary = summary;
  const hypothesis = asString(trial.hypothesis);
  if (hypothesis) metadata.hypothesis = hypothesis;
  if (candidateId) metadata.candidate_id = candidateId;
  if (title) metadata.candidate_title = title;

  return {
    buildingBlockId,
    algorithm,
    source,
    score,
    objectiveIds,
    gapIds,
    metadata,
  };
}

function policyViolations(params: {
  objectiveType: string;
  riskLevel: string;
  breadth: AutonomyGlobBreadth;
  readAnywhere: boolean;
  expectedValidation: string[];
  allowReadAnywhere: boolean;
}): string[] {
  const reasons: string[] = [];
  const objectiveType = params.objectiveType as AutonomyObjectiveType;
  const policy = OBJECTIVE_POLICY[objectiveType];
  if (!policy) {
    reasons.push(`unsupported objective_type "${params.objectiveType}"`);
    return reasons;
  }

  const riskLevel = asRiskLevel(params.riskLevel);
  if (!riskLevel) {
    reasons.push(`invalid risk_level "${params.riskLevel}"`);
  } else if (RISK_ORDER[riskLevel] > RISK_ORDER[policy.maxRisk]) {
    reasons.push(`risk_level "${riskLevel}" exceeds policy max "${policy.maxRisk}"`);
  }

  if (BREADTH_ORDER[params.breadth] > BREADTH_ORDER[policy.maxGlobBreadth]) {
    reasons.push(
      `write_glob breadth "${params.breadth}" exceeds policy max "${policy.maxGlobBreadth}"`,
    );
  }
  if (params.readAnywhere && !params.allowReadAnywhere) {
    reasons.push("read_anywhere=true is not allowlisted");
  }
  if (!policy.autonomousAllowed) {
    reasons.push(`objective_type "${objectiveType}" is not autonomous_allowed`);
  }
  if (policy.requireValidation && params.expectedValidation.length === 0) {
    reasons.push("expected_validation must contain at least one command");
  }
  return reasons;
}

function validateAnswerAgainstSchema(
  questionType: string,
  schema: Record<string, unknown>,
  answer: unknown,
): { valid: boolean; normalized: unknown; error?: string } {
  if (questionType === "yes_no") {
    if (typeof answer === "boolean") return { valid: true, normalized: answer };
    if (typeof answer === "string") {
      const text = answer.trim().toLowerCase();
      if (["yes", "true", "y", "1"].includes(text)) return { valid: true, normalized: true };
      if (["no", "false", "n", "0"].includes(text)) return { valid: true, normalized: false };
    }
    return { valid: false, normalized: answer, error: "Expected yes/no answer." };
  }
  if (questionType === "single_choice") {
    const choices = asStringArray(schema.choices);
    const selected = asString(answer);
    if (!selected) return { valid: false, normalized: answer, error: "Answer is required." };
    if (choices.length > 0 && !choices.includes(selected)) {
      return { valid: false, normalized: answer, error: "Answer is not one of the allowed choices." };
    }
    return { valid: true, normalized: selected };
  }
  if (questionType === "multi_choice") {
    const choices = asStringArray(schema.choices);
    const selected = Array.isArray(answer)
      ? answer.map((entry) => asString(entry)).filter(Boolean)
      : [];
    if (selected.length === 0) {
      return { valid: false, normalized: answer, error: "Expected one or more selected choices." };
    }
    if (choices.length > 0 && selected.some((entry) => !choices.includes(entry))) {
      return { valid: false, normalized: answer, error: "One or more selected choices are invalid." };
    }
    return { valid: true, normalized: selected };
  }
  if (questionType === "bounded_text") {
    const text = asString(answer);
    const minLength = Math.max(0, Math.floor(asNumber(schema.min_length, 0)));
    const maxLength = Math.max(minLength, Math.floor(asNumber(schema.max_length, 4000)));
    if (!text || text.length < minLength || text.length > maxLength) {
      return {
        valid: false,
        normalized: answer,
        error: `Text answer length must be between ${minLength} and ${maxLength} characters.`,
      };
    }
    return { valid: true, normalized: text };
  }
  if (questionType === "json_payload") {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return { valid: false, normalized: answer, error: "Expected a JSON object payload." };
    }
    const requiredKeys = asStringArray(schema.required_keys);
    const record = answer as Record<string, unknown>;
    for (const key of requiredKeys) {
      if (!(key in record)) {
        return { valid: false, normalized: answer, error: `Missing required key "${key}".` };
      }
    }
    return { valid: true, normalized: record };
  }
  return { valid: false, normalized: answer, error: `Unknown question_type "${questionType}"` };
}

export class AutonomyStore {
  private readonly db: Database;
  private get config(): PushPalsConfig {
    return loadPushPalsConfig();
  }
  private readonly alpha = 0.2;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ttl_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective_type TEXT NOT NULL,
        problem_statement TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        component_area TEXT NOT NULL,
        target_paths_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        expected_validation_json TEXT NOT NULL,
        estimated_effort TEXT NOT NULL,
        why_now_signal_ids_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        pattern_key TEXT NOT NULL,
        llm_score REAL,
        impact_signal REAL,
        ema_success REAL,
        ema_user_accept REAL,
        penalties_json TEXT,
        final_score REAL,
        selected INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        gate_decision TEXT,
        gate_reasons_json TEXT,
        debug_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_objectives (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        candidate_id TEXT,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        objective_type TEXT NOT NULL,
        component_area TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        pattern_key TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'autonomous',
        confidence REAL NOT NULL,
        priority TEXT,
        risk_level TEXT NOT NULL,
        request_id TEXT,
        job_id TEXT,
        question_id TEXT,
        block_reason TEXT,
        scope_json TEXT NOT NULL,
        evidence_json TEXT,
        score_breakdown_json TEXT,
        policy_version TEXT,
        impact_model_version TEXT,
        dispatched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id TEXT,
        request_id TEXT,
        job_id TEXT,
        pattern_key TEXT NOT NULL,
        success INTEGER NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        user_action TEXT,
        reopened_within_24h INTEGER NOT NULL DEFAULT 0,
        regression_flag INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_pattern_stats (
        pattern_key TEXT PRIMARY KEY,
        ema_success REAL NOT NULL DEFAULT 0,
        ema_user_accept REAL NOT NULL DEFAULT 0,
        ema_latency REAL NOT NULL DEFAULT 0,
        ema_regret REAL NOT NULL DEFAULT 0,
        fail_streak INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_engine_idea_trials (
        trial_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        objective_id TEXT,
        candidate_id TEXT,
        pattern_key TEXT NOT NULL,
        engine_building_block_id TEXT NOT NULL,
        engine_algorithm TEXT NOT NULL,
        engine_source TEXT NOT NULL DEFAULT 'llm',
        engine_score REAL,
        objective_ids_json TEXT NOT NULL,
        gap_ids_json TEXT NOT NULL,
        metadata_json TEXT,
        status TEXT NOT NULL,
        success INTEGER,
        user_action TEXT,
        latency_ms INTEGER,
        last_outcome_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_trials_objective
        ON autonomy_engine_idea_trials(objective_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_engine_trials_block
        ON autonomy_engine_idea_trials(engine_building_block_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS autonomy_engine_idea_stats (
        engine_building_block_id TEXT PRIMARY KEY,
        engine_algorithm TEXT NOT NULL,
        ema_success REAL NOT NULL DEFAULT 0,
        ema_user_accept REAL NOT NULL DEFAULT 0,
        ema_latency REAL NOT NULL DEFAULT 0,
        ema_regret REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_pr_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedback_key TEXT,
        objective_id TEXT,
        request_id TEXT,
        job_id TEXT,
        pattern_key TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        verdict TEXT NOT NULL,
        review_score REAL,
        review_threshold REAL,
        summary TEXT,
        comment_count INTEGER NOT NULL DEFAULT 0,
        comments_json TEXT,
        source TEXT NOT NULL DEFAULT 'review_agent',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_pattern_created
        ON autonomy_pr_feedback(pattern_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_created
        ON autonomy_pr_feedback(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_job
        ON autonomy_pr_feedback(job_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_pr_feedback_key
        ON autonomy_pr_feedback(feedback_key)
        WHERE feedback_key IS NOT NULL AND feedback_key <> '';
      CREATE TABLE IF NOT EXISTS questions_queue (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        question_type TEXT NOT NULL,
        expected_answer_schema_json TEXT,
        context_json TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        answer_json TEXT,
        answer_validation_status TEXT NOT NULL DEFAULT 'pending',
        validation_error TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS autonomy_llm_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        objective_id TEXT,
        phase TEXT NOT NULL,
        prompt_template_version TEXT,
        prompt_hash TEXT,
        request_payload_hash TEXT,
        model_id TEXT,
        temperature REAL,
        timeout_ms INTEGER,
        response_json TEXT,
        response_hash TEXT,
        token_usage_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_dispatch_lock (
        lock_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        owner_run_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private getDispatchCountsLastHour(nowIso: string): {
    globalCount: number;
    byType: Record<string, number>;
  } {
    const rows = this.db
      .prepare(
        `SELECT objective_type AS objectiveType, COUNT(*) AS count
         FROM autonomy_objectives
         WHERE dispatched_at IS NOT NULL
           AND datetime(dispatched_at) >= datetime(?, '-1 hour')
         GROUP BY objective_type`,
      )
      .all(nowIso) as Array<{ objectiveType: string; count: number }>;
    const byType: Record<string, number> = {};
    let globalCount = 0;
    for (const row of rows) {
      const key = asString(row.objectiveType);
      if (!key) continue;
      const count = Math.max(0, Math.floor(asNumber(row.count, 0)));
      byType[key] = count;
      globalCount += count;
    }
    return { globalCount, byType };
  }

  private buildTopSignals(requestSlo?: QueueSloSummary, jobSlo?: QueueSloSummary): SignalValue[] {
    const topSignals: SignalValue[] = [];
    let failedRows: Array<{ kind: string | null; error: string | null; count: number }> = [];
    try {
      failedRows = this.db
        .prepare(
          `SELECT kind, error, COUNT(*) AS count
           FROM jobs
           WHERE status = 'failed'
             AND datetime(COALESCE(failedAt, updatedAt, createdAt)) >= datetime('now', '-24 hours')
           GROUP BY kind, error
           ORDER BY count DESC
           LIMIT 12`,
        )
        .all() as Array<{ kind: string | null; error: string | null; count: number }>;
    } catch {
      failedRows = [];
    }

    for (let i = 0; i < failedRows.length; i++) {
      const row = failedRows[i];
      const text = `${asString(row.kind)} ${asString(row.error)}`.trim();
      const count = Math.max(1, Math.floor(asNumber(row.count, 1)));
      topSignals.push({
        signal_id: `sig_fail_${i + 1}`,
        type: normalizeSignalType(text),
        value: clamp01(count / 8),
        evidence: `${asString(row.kind) || "job"} failure count=${count}`,
      });
    }

    const requestP95 = Number(requestSlo?.queueWaitMs?.p95 ?? 0);
    const jobFailures = Number(jobSlo?.failed ?? 0);
    const jobTerminal = Number(jobSlo?.completed ?? 0) + jobFailures;
    const jobFailureRate = jobTerminal > 0 ? jobFailures / jobTerminal : 0;
    const queueHealthDegradation = clamp01(
      0.6 * norm(requestP95, 90_000, 180_000) + 0.4 * norm(jobFailureRate, 0.05, 0.15),
    );
    topSignals.push({
      signal_id: "sig_queue_health",
      type: "queue_health",
      value: queueHealthDegradation,
      evidence: `queue_p95=${Math.floor(requestP95)} job_failure_rate=${jobFailureRate.toFixed(3)}`,
    });

    const regretRows = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM autonomy_outcomes
         WHERE reopened_within_24h = 1
           AND datetime(created_at) >= datetime('now', '-24 hours')`,
      )
      .get() as { count: number } | null;
    const regretCount = Math.max(0, Math.floor(asNumber(regretRows?.count ?? 0, 0)));
    topSignals.push({
      signal_id: "sig_regret_24h",
      type: "regret_signal",
      value: clamp01(regretCount / 6),
      evidence: `reopened_within_24h=${regretCount}`,
    });

    let prFeedbackRows: PrFeedbackSignalRow[] = [];
    try {
      prFeedbackRows = this.db
        .prepare(
          `SELECT verdict, summary, comment_count
           FROM autonomy_pr_feedback
           WHERE datetime(created_at) >= datetime('now', '-24 hours')
           ORDER BY created_at DESC
           LIMIT 60`,
        )
        .all() as PrFeedbackSignalRow[];
    } catch {
      prFeedbackRows = [];
    }
    if (prFeedbackRows.length > 0) {
      const negativeRows = prFeedbackRows.filter((row) =>
        isNegativePrFeedbackVerdict(asString(row.verdict)),
      );
      if (negativeRows.length > 0) {
        const totalComments = negativeRows.reduce(
          (sum, row) => sum + Math.max(0, Math.floor(asNumber(row.comment_count, 0))),
          0,
        );
        const negativeRatio = negativeRows.length / Math.max(1, prFeedbackRows.length);
        topSignals.push({
          signal_id: "sig_pr_feedback_24h",
          type: "regret_signal",
          value: clamp01(
            0.55 * negativeRatio +
              0.3 * clamp01(negativeRows.length / 6) +
              0.15 * clamp01(totalComments / 20),
          ),
          evidence: `pr_feedback_negative=${negativeRows.length}/${prFeedbackRows.length} comments=${totalComments}`,
        });

        const byType = new Map<SignalValue["type"], number>();
        for (const row of negativeRows) {
          const text = `${asString(row.verdict)} ${asString(row.summary)}`.trim();
          const signalType = normalizeSignalType(text);
          byType.set(signalType, (byType.get(signalType) ?? 0) + 1);
        }
        const typed = [...byType.entries()]
          .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
          })
          .slice(0, 3);
        for (let i = 0; i < typed.length; i++) {
          const [type, count] = typed[i];
          topSignals.push({
            signal_id: `sig_pr_feedback_type_${i + 1}`,
            type,
            value: clamp01(count / 4),
            evidence: `pr feedback ${type} count=${count}`,
          });
        }
      }

      for (let i = 0; i < Math.min(prFeedbackRows.length, 3); i++) {
        const row = prFeedbackRows[i];
        const summary = truncateText(asString(row.summary), 180);
        if (!summary) continue;
        const verdict = asString(row.verdict) || "feedback";
        topSignals.push({
          signal_id: `sig_pr_comment_${i + 1}`,
          type: normalizeSignalType(`${verdict} ${summary}`),
          value: clamp01(0.38 + Math.min(0.28, summary.length / 500)),
          evidence: `pr ${verdict}: ${summary}`,
        });
      }
    }

    return topSignals
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);
  }

  private buildStateTraits(params: {
    nowIso: string;
    requestSlo?: QueueSloSummary;
    jobSlo?: QueueSloSummary;
    topSignals: SignalValue[];
    dispatchBudget: { globalCount: number; byType: Record<string, number> };
    openObjectives: OpenObjective[];
    repoHealthFlags?: { is_worktree_dirty?: boolean; is_merge_in_progress?: boolean };
  }): StateTrait[] {
    const traits: StateTrait[] = [];
    const pushTrait = (trait: StateTrait): void => {
      if (!trait.trait_id || !trait.evidence) return;
      traits.push({
        ...trait,
        score: clamp01(asNumber(trait.score, 0)),
      });
    };

    const queueP95 = asNumber(params.requestSlo?.queueWaitMs?.p95, 0);
    if (queueP95 >= 120_000) {
      pushTrait({
        trait_id: "queue_latency_high",
        category: "weakness",
        focus: "queue_latency",
        score: norm(queueP95, 120_000, 300_000),
        evidence: `request queue p95=${Math.floor(queueP95)}ms`,
      });
    } else {
      pushTrait({
        trait_id: "queue_latency_healthy",
        category: "strength",
        focus: "queue_latency",
        score: norm(120_000 - queueP95, 0, 120_000),
        evidence: `request queue p95=${Math.floor(queueP95)}ms`,
      });
    }

    const completed = Math.max(0, Math.floor(asNumber(params.jobSlo?.completed, 0)));
    const failed = Math.max(0, Math.floor(asNumber(params.jobSlo?.failed, 0)));
    const terminal = completed + failed;
    const failureRate = terminal > 0 ? failed / terminal : 0;
    if (terminal >= 5) {
      if (failureRate >= 0.12) {
        pushTrait({
          trait_id: "job_failure_rate_high",
          category: "weakness",
          focus: "worker_reliability",
          score: norm(failureRate, 0.12, 0.4),
          evidence: `job failure rate=${failureRate.toFixed(3)} (${failed}/${terminal})`,
        });
      } else {
        pushTrait({
          trait_id: "job_failure_rate_low",
          category: "strength",
          focus: "worker_reliability",
          score: norm(0.12 - failureRate, 0, 0.12),
          evidence: `job failure rate=${failureRate.toFixed(3)} (${failed}/${terminal})`,
        });
      }
    }

    for (const signal of params.topSignals.slice(0, 5)) {
      if (signal.value < 0.35) continue;
      const focus =
        signal.type === "test_failure"
          ? "test_reliability"
          : signal.type === "lint_failure"
            ? "lint_hygiene"
            : signal.type === "typecheck_failure"
              ? "type_hygiene"
              : signal.type === "regret_signal"
                ? "change_stability"
                : "queue_health";
      pushTrait({
        trait_id: `signal_${signal.signal_id}`,
        category: signal.type === "regret_signal" ? "risk" : "weakness",
        focus,
        score: clamp01(signal.value),
        evidence: signal.evidence,
      });
    }

    const componentRows = this.db
      .prepare(
        `SELECT obj.component_area AS componentArea,
                SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) AS successCount,
                COUNT(*) AS totalCount
         FROM autonomy_outcomes o
         JOIN autonomy_objectives obj ON obj.id = o.objective_id
         WHERE datetime(o.created_at) >= datetime(?, '-7 days')
         GROUP BY obj.component_area
         HAVING COUNT(*) >= 2
         ORDER BY totalCount DESC
         LIMIT 24`,
      )
      .all(params.nowIso) as Array<{
      componentArea: string | null;
      successCount: number;
      totalCount: number;
    }>;
    for (const row of componentRows) {
      const area = asString(row.componentArea);
      if (!area) continue;
      const totalCount = Math.max(0, Math.floor(asNumber(row.totalCount, 0)));
      if (totalCount < 2) continue;
      const successCount = Math.max(0, Math.floor(asNumber(row.successCount, 0)));
      const successRate = successCount / totalCount;
      if (successRate <= 0.45) {
        pushTrait({
          trait_id: `component_weak_${area}`,
          category: "weakness",
          focus: `component:${area}`,
          score: norm(0.45 - successRate, 0, 0.45),
          evidence: `${area} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`,
        });
      } else if (successRate >= 0.75) {
        pushTrait({
          trait_id: `component_strong_${area}`,
          category: "strength",
          focus: `component:${area}`,
          score: norm(successRate, 0.75, 1),
          evidence: `${area} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`,
        });
      }
    }

    const objectiveRows = this.db
      .prepare(
        `SELECT obj.objective_type AS objectiveType,
                SUM(CASE WHEN o.success = 1 THEN 1 ELSE 0 END) AS successCount,
                COUNT(*) AS totalCount
         FROM autonomy_outcomes o
         JOIN autonomy_objectives obj ON obj.id = o.objective_id
         WHERE datetime(o.created_at) >= datetime(?, '-7 days')
         GROUP BY obj.objective_type
         ORDER BY totalCount DESC
         LIMIT 24`,
      )
      .all(params.nowIso) as Array<{
      objectiveType: string | null;
      successCount: number;
      totalCount: number;
    }>;
    for (const row of objectiveRows) {
      const objectiveType = asString(row.objectiveType);
      if (!objectiveType) continue;
      const totalCount = Math.max(0, Math.floor(asNumber(row.totalCount, 0)));
      if (totalCount === 0) continue;
      const successCount = Math.max(0, Math.floor(asNumber(row.successCount, 0)));
      const successRate = successCount / totalCount;
      if (totalCount >= 3 && successRate <= 0.45) {
        pushTrait({
          trait_id: `objective_weak_${objectiveType}`,
          category: "weakness",
          focus: `objective_type:${objectiveType}`,
          score: norm(0.45 - successRate, 0, 0.45),
          evidence: `${objectiveType} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`,
        });
      } else if (totalCount >= 3 && successRate >= 0.75) {
        pushTrait({
          trait_id: `objective_strong_${objectiveType}`,
          category: "strength",
          focus: `objective_type:${objectiveType}`,
          score: norm(successRate, 0.75, 1),
          evidence: `${objectiveType} 7d success=${successRate.toFixed(2)} (${successCount}/${totalCount})`,
        });
      } else if (totalCount <= 1) {
        pushTrait({
          trait_id: `objective_opportunity_${objectiveType}`,
          category: "opportunity",
          focus: `objective_type:${objectiveType}`,
          score: norm(1 - totalCount, 0, 1),
          evidence: `${objectiveType} has sparse recent samples (${totalCount} in 7d)`,
        });
      }
    }

    const globalLimit = Math.max(1, this.config.remotebuddy.autonomy.maxDispatchPerHour);
    const dispatchPressure = clamp01(params.dispatchBudget.globalCount / globalLimit);
    if (dispatchPressure >= 0.8) {
      pushTrait({
        trait_id: "dispatch_pressure_high",
        category: "risk",
        focus: "dispatch_budget",
        score: dispatchPressure,
        evidence: `dispatch usage ${params.dispatchBudget.globalCount}/${globalLimit} in last hour`,
      });
    }

    const activeCount = params.openObjectives.length;
    const concurrentLimit = Math.max(1, this.config.remotebuddy.autonomy.maxConcurrentObjectives);
    const activePressure = clamp01(activeCount / concurrentLimit);
    if (activePressure >= 1) {
      pushTrait({
        trait_id: "active_objectives_saturated",
        category: "risk",
        focus: "objective_concurrency",
        score: activePressure,
        evidence: `active objectives ${activeCount}/${concurrentLimit}`,
      });
    }

    if (asBoolean(params.repoHealthFlags?.is_worktree_dirty, false)) {
      pushTrait({
        trait_id: "repo_dirty_worktree",
        category: "risk",
        focus: "repo_state",
        score: 0.9,
        evidence: "repo preflight reports dirty worktree",
      });
    }
    if (asBoolean(params.repoHealthFlags?.is_merge_in_progress, false)) {
      pushTrait({
        trait_id: "repo_merge_in_progress",
        category: "risk",
        focus: "repo_state",
        score: 1,
        evidence: "repo preflight reports merge/rebase in progress",
      });
    }

    if (traits.length === 0) {
      pushTrait({
        trait_id: "state_signal_sparse",
        category: "opportunity",
        focus: "exploration",
        score: 0.5,
        evidence: "insufficient recent signals; prioritize low-risk scoped improvements",
      });
    }

    const deduped = new Map<string, StateTrait>();
    for (const trait of traits) {
      const existing = deduped.get(trait.trait_id);
      if (!existing || trait.score > existing.score) deduped.set(trait.trait_id, trait);
    }
    return [...deduped.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.trait_id.localeCompare(b.trait_id);
      })
      .slice(0, 32);
  }

  private lockRow(nowIso: string): {
    lock_id: string;
    owner_session_id: string;
    owner_run_id: string;
    acquired_at: string;
    expires_at: string;
    updated_at: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT lock_id, owner_session_id, owner_run_id, acquired_at, expires_at, updated_at
         FROM autonomy_dispatch_lock
         WHERE lock_id = 'autonomy_dispatch'
         LIMIT 1`,
      )
      .get() as
      | {
          lock_id: string;
          owner_session_id: string;
          owner_run_id: string;
          acquired_at: string;
          expires_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    const expiresAtMs = Date.parse(asString(row.expires_at));
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs) {
      this.db.prepare(`DELETE FROM autonomy_dispatch_lock WHERE lock_id = 'autonomy_dispatch'`).run();
      return null;
    }
    return row;
  }

  isDispatchLockHeld(nowIso = asIsoNow()): boolean {
    return this.lockRow(nowIso) !== null;
  }

  isDispatchLockHeldByAnotherRun(runId: string | null | undefined, nowIso = asIsoNow()): boolean {
    const row = this.lockRow(nowIso);
    if (!row) return false;
    const normalizedRunId = asString(runId);
    return normalizedRunId.length === 0 || row.owner_run_id !== normalizedRunId;
  }

  acquireDispatchLock(params: {
    sessionId: string;
    runId: string;
    ttlMs?: number;
  }): { ok: boolean; reason?: string; lockUntil?: string } {
    const sessionId = asString(params.sessionId);
    const runId = asString(params.runId);
    if (!sessionId || !runId) return { ok: false, reason: "sessionId and runId are required" };
    const now = asIsoNow();
    const ttlMs = Math.max(
      5_000,
      Math.floor(
        asNumber(
          params.ttlMs,
          Math.max(
            this.config.remotebuddy.autonomy.llmTimeoutMs * 3,
            this.config.remotebuddy.autonomy.tickIntervalMs,
          ),
        ),
      ),
    );
    const lockUntil = new Date(Date.parse(now) + ttlMs).toISOString();
    try {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      const existing = this.lockRow(now);
      if (existing && existing.owner_run_id !== runId) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          reason: `dispatch lock held by ${existing.owner_run_id} until ${existing.expires_at}`,
        };
      }
      this.db
        .prepare(
          `INSERT INTO autonomy_dispatch_lock (
            lock_id, owner_session_id, owner_run_id, acquired_at, expires_at, updated_at
          ) VALUES ('autonomy_dispatch', ?, ?, ?, ?, ?)
          ON CONFLICT(lock_id) DO UPDATE SET
            owner_session_id = excluded.owner_session_id,
            owner_run_id = excluded.owner_run_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`,
        )
        .run(sessionId, runId, now, lockUntil, now);
      this.db.exec("COMMIT");
      return { ok: true, lockUntil };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // no-op
      }
      return { ok: false, reason: `failed to acquire dispatch lock: ${String(error)}` };
    }
  }

  renewDispatchLock(params: {
    sessionId: string;
    runId: string;
    ttlMs?: number;
  }): { ok: boolean; reason?: string; lockUntil?: string } {
    const sessionId = asString(params.sessionId);
    const runId = asString(params.runId);
    if (!sessionId || !runId) return { ok: false, reason: "sessionId and runId are required" };
    const now = asIsoNow();
    const current = this.lockRow(now);
    if (!current) return { ok: false, reason: "dispatch lock not held" };
    if (current.owner_session_id !== sessionId || current.owner_run_id !== runId) {
      return {
        ok: false,
        reason: `dispatch lock held by ${current.owner_run_id} until ${current.expires_at}`,
      };
    }
    return this.acquireDispatchLock(params);
  }

  releaseDispatchLock(params: { sessionId: string; runId: string }): { ok: boolean; released: boolean } {
    const sessionId = asString(params.sessionId);
    const runId = asString(params.runId);
    if (!sessionId || !runId) return { ok: true, released: false };
    const res = this.db
      .prepare(
        `DELETE FROM autonomy_dispatch_lock
         WHERE lock_id = 'autonomy_dispatch'
           AND owner_session_id = ?
           AND owner_run_id = ?`,
      )
      .run(sessionId, runId);
    return { ok: true, released: Number(res.changes ?? 0) > 0 };
  }

  private snapshotPayloadForStorage(snapshot: AutonomySnapshot): string {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    const fullPayload = JSON.stringify(snapshot);
    const payloadHash = sha256Hex(fullPayload);
    if (!replayCfg.storePromptPayloads) {
      return JSON.stringify({
        snapshot_id: snapshot.snapshot_id,
        snapshot_created_at: snapshot.snapshot_created_at,
        snapshot_ttl_ms: snapshot.snapshot_ttl_ms,
        impact_model_version: snapshot.impact_model_version,
        top_signals: snapshot.top_signals,
        state_traits: snapshot.state_traits,
        feedback_priors: snapshot.feedback_priors.slice(0, 40),
        engine_idea_priors: snapshot.engine_idea_priors.slice(0, 40),
        active_cooldowns: snapshot.active_cooldowns.slice(0, 40),
        open_objectives: snapshot.open_objectives.slice(0, 40),
        repo_health_flags: snapshot.repo_health_flags,
        dispatch_budget: snapshot.dispatch_budget,
        payload_hash: payloadHash,
      });
    }
    if (jsonByteLength(fullPayload) <= replayCfg.maxPayloadBytes) return fullPayload;
    return JSON.stringify({
      snapshot_id: snapshot.snapshot_id,
      snapshot_created_at: snapshot.snapshot_created_at,
      snapshot_ttl_ms: snapshot.snapshot_ttl_ms,
      impact_model_version: snapshot.impact_model_version,
      engine_idea_priors: snapshot.engine_idea_priors.slice(0, 20),
      repo_health_flags: snapshot.repo_health_flags,
      dispatch_budget: snapshot.dispatch_budget,
      payload_hash: payloadHash,
      truncated: true,
      truncated_reason: `payload exceeds max_payload_bytes=${replayCfg.maxPayloadBytes}`,
    });
  }

  private llmResponseJsonForStorage(call: Record<string, unknown>): string | null {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    if (!replayCfg.storePromptPayloads) return null;
    const responsePayload = {
      response: asObject(call.response),
      request_payload: asObject(call.requestPayload ?? call.request_payload),
      prompt_inputs: asObject(call.promptInputs ?? call.prompt_inputs),
    };
    const serialized = JSON.stringify(responsePayload);
    if (jsonByteLength(serialized) <= replayCfg.maxPayloadBytes) return serialized;
    return JSON.stringify({
      truncated: true,
      response_hash: asString(call.responseHash ?? call.response_hash) || sha256Hex(serialized),
      truncated_reason: `payload exceeds max_payload_bytes=${replayCfg.maxPayloadBytes}`,
    });
  }

  private enforceReplayRetention(): void {
    const replayCfg = this.config.remotebuddy.autonomy.replay;
    if (!replayCfg.storePromptPayloads) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const keepRuns = Math.max(0, Math.floor(replayCfg.maxRunsWithPayloads));
    if (keepRuns <= 0) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const keepRows = this.db
      .prepare(
        `SELECT run_id AS runId
         FROM autonomy_llm_calls
         WHERE response_json IS NOT NULL
         GROUP BY run_id
         ORDER BY MAX(datetime(created_at)) DESC
         LIMIT ?`,
      )
      .all(keepRuns) as Array<{ runId: string }>;
    const keepIds = keepRows.map((row) => asString(row.runId)).filter(Boolean);
    if (keepIds.length === 0) {
      this.db.prepare(`UPDATE autonomy_llm_calls SET response_json = NULL`).run();
      return;
    }
    const placeholders = keepIds.map(() => "?").join(", ");
    this.db
      .prepare(`UPDATE autonomy_llm_calls SET response_json = NULL WHERE run_id NOT IN (${placeholders})`)
      .run(...keepIds);
  }

  createSnapshot(params: {
    sessionId: string;
    runId?: string;
    requestSlo?: QueueSloSummary;
    jobSlo?: QueueSloSummary;
    repoHealthFlags?: {
      is_worktree_dirty?: boolean;
      is_merge_in_progress?: boolean;
    };
  }): AutonomySnapshot {
    const now = asIsoNow();
    const snapshotId = `snap_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const ttlMs = this.config.remotebuddy.autonomy.tickIntervalMs * 2;
    const topSignals = this.buildTopSignals(params.requestSlo, params.jobSlo);

    const feedbackPriors = this.db
      .prepare(
        `SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
         FROM autonomy_pattern_stats
         ORDER BY updated_at DESC
         LIMIT 80`,
      )
      .all() as FeedbackPrior[];
    const engineIdeaPriors = this.db
      .prepare(
        `SELECT engine_building_block_id, engine_algorithm, ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
         FROM autonomy_engine_idea_stats
         ORDER BY updated_at DESC
         LIMIT 80`,
      )
      .all() as EngineIdeaPrior[];
    const activeCooldowns = feedbackPriors
      .filter(
        (row) =>
          typeof row.cooldown_until === "string" &&
          row.cooldown_until.length > 0 &&
          Date.parse(row.cooldown_until) > Date.parse(now),
      )
      .map((row) => ({ pattern_key: row.pattern_key, cooldown_until: row.cooldown_until as string }));
    const openObjectives = this.db
      .prepare(
        `SELECT id AS objective_id, status, objective_type, pattern_key, updated_at
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all() as OpenObjective[];
    const dispatchBudget = this.getDispatchCountsLastHour(now);
    const stateTraits = this.buildStateTraits({
      nowIso: now,
      requestSlo: params.requestSlo,
      jobSlo: params.jobSlo,
      topSignals,
      dispatchBudget,
      openObjectives,
      repoHealthFlags: params.repoHealthFlags,
    });

    const snapshot: AutonomySnapshot = {
      snapshot_id: snapshotId,
      snapshot_created_at: now,
      snapshot_ttl_ms: ttlMs,
      impact_model_version: this.config.remotebuddy.autonomy.impactModelVersion,
      top_signals: topSignals,
      state_traits: stateTraits,
      feedback_priors: feedbackPriors,
      engine_idea_priors: engineIdeaPriors,
      active_cooldowns: activeCooldowns,
      open_objectives: openObjectives,
      repo_health_flags: {
        is_worktree_dirty: Boolean(params.repoHealthFlags?.is_worktree_dirty),
        is_merge_in_progress: Boolean(params.repoHealthFlags?.is_merge_in_progress),
        dispatch_lock_held: this.isDispatchLockHeldByAnotherRun(params.runId, now),
      },
      dispatch_budget: {
        rolling_window_seconds: 3600,
        global_count_last_hour: dispatchBudget.globalCount,
        by_type_count_last_hour: dispatchBudget.byType,
      },
    };

    this.db
      .prepare(
        `INSERT INTO autonomy_snapshots (snapshot_id, session_id, created_at, ttl_ms, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, params.sessionId, now, ttlMs, this.snapshotPayloadForStorage(snapshot));
    return snapshot;
  }

  private activeObjectiveCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`,
      )
      .get() as { count: number } | null;
    return Math.max(0, Math.floor(asNumber(row?.count ?? 0, 0)));
  }

  private cooldownReason(patternKey: string, nowIso: string): string | null {
    if (!patternKey) return null;
    const row = this.db
      .prepare(`SELECT cooldown_until FROM autonomy_pattern_stats WHERE pattern_key = ?`)
      .get(patternKey) as { cooldown_until: string | null } | null;
    const until = asString(row?.cooldown_until);
    if (!until) return null;
    const untilMs = Date.parse(until);
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return null;
    return untilMs > nowMs ? `cooldown_active until ${until}` : null;
  }

  private recentSuccessSuppressionReason(params: {
    patternKey: string;
    objectiveType: AutonomyObjectiveType;
    componentArea: AutonomyComponentArea | null;
    nowIso: string;
  }): string | null {
    const { patternKey, objectiveType, componentArea, nowIso } = params;
    if (patternKey) {
      const exactRow = this.db
        .prepare(
          `SELECT 1
           FROM autonomy_outcomes
           WHERE pattern_key = ?
             AND success = 1
             AND datetime(created_at) >= datetime(?, '-${RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS} hours')
           LIMIT 1`,
        )
        .get(patternKey, nowIso) as { 1: number } | null;
      if (exactRow) return "recent_success_same_pattern_within_24h";
    }

    // "Near-same" suppression for docs: if the same component area already had a
    // successful docs objective recently, block another docs dispatch burst.
    if (objectiveType === "docs" && componentArea) {
      const nearRow = this.db
        .prepare(
          `SELECT 1
           FROM autonomy_outcomes o
           JOIN autonomy_objectives obj ON obj.id = o.objective_id
           WHERE o.success = 1
             AND obj.objective_type = 'docs'
             AND obj.component_area = ?
             AND datetime(o.created_at) >= datetime(?, '-${RECENT_SUCCESS_SUPPRESSION_WINDOW_HOURS} hours')
           LIMIT 1`,
        )
        .get(componentArea, nowIso) as { 1: number } | null;
      if (nearRow) return "recent_success_near_pattern_within_24h";
    }
    return null;
  }

  private preflightReason(snapshotId: string, runId?: string): string | null {
    if (this.isDispatchLockHeldByAnotherRun(runId)) {
      return "repo preflight blocked: dispatch lock held";
    }
    const row = this.db
      .prepare(`SELECT payload_json FROM autonomy_snapshots WHERE snapshot_id = ?`)
      .get(snapshotId) as { payload_json: string } | null;
    if (!row?.payload_json) return null;
    const payload = parseJsonObject(row.payload_json);
    const flags = asObject(payload.repo_health_flags);
    if (
      asBoolean(flags.is_worktree_dirty, false) &&
      !this.config.remotebuddy.autonomy.allowDirtyWorktree
    ) {
      return "repo preflight blocked: worktree is dirty";
    }
    if (asBoolean(flags.is_merge_in_progress, false)) return "repo preflight blocked: merge/rebase in progress";
    if (asBoolean(flags.dispatch_lock_held, false)) return "repo preflight blocked: dispatch lock held";
    return null;
  }

  evaluateEligibility(body: Record<string, unknown>): {
    ok: boolean;
    results?: Array<{ candidate_id: string; ok: boolean; reason?: string }>;
    reason?: string;
  } {
    const runId = asString(body.runId);
    const snapshotId = asString(body.snapshotId);
    if (!runId || !snapshotId) {
      return { ok: false, reason: "runId and snapshotId are required" };
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const now = asIsoNow();
    const counts = this.getDispatchCountsLastHour(now);
    const limits = this.config.remotebuddy.autonomy;
    const maxConcurrent = limits.maxConcurrentObjectives;
    let activeCount = this.activeObjectiveCount();
    const byTypeCounts: Record<string, number> = { ...counts.byType };
    let globalCount = counts.globalCount;
    const applySequentialAccounting = asBoolean(
      body.applySequentialAccounting ?? body.apply_sequential_accounting,
      true,
    );
    const preflightErr = this.preflightReason(snapshotId, runId);
    const activePatternRows = this.db
      .prepare(
        `SELECT DISTINCT pattern_key AS patternKey
         FROM autonomy_objectives
         WHERE status IN ('proposed','gated','dispatched','running','blocked','needs_clarification')`,
      )
      .all() as Array<{ patternKey: string }>;
    const activePatternKeys = new Set(
      activePatternRows
        .map((row) => asString(row.patternKey))
        .filter(Boolean),
    );
    const results = candidates.map((raw) => {
      const record = asObject(raw);
      const candidateId = asString(record.id ?? record.candidateId ?? record.candidate_id) || randomUUID();
      const objectiveTypeRaw = asString(record.objectiveType ?? record.objective_type);
      const objectiveType = asObjectiveType(objectiveTypeRaw);
      if (!objectiveType) {
        return { candidate_id: candidateId, ok: false, reason: `invalid objective_type "${objectiveTypeRaw}"` };
      }
      const patternKey = asString(record.patternKey ?? record.pattern_key);
      const componentArea = asComponentArea(record.componentArea ?? record.component_area);
      const confidence = clamp01(asNumber(record.confidence, 0));

      const perTypeLimit = Math.max(
        0,
        Math.floor(limits.maxDispatchPerHourByType[objectiveType] ?? limits.maxDispatchPerHour),
      );
      const perTypeCount = Math.max(0, Math.floor(byTypeCounts[objectiveType] ?? 0));
      if (perTypeCount >= perTypeLimit) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: `per-type budget exceeded for ${objectiveType}`,
        };
      }
      if (globalCount >= limits.maxDispatchPerHour) {
        return { candidate_id: candidateId, ok: false, reason: "global dispatch budget exceeded" };
      }
      if (activeCount >= maxConcurrent) {
        return { candidate_id: candidateId, ok: false, reason: "max concurrent objectives reached" };
      }
      const cooldownErr = this.cooldownReason(patternKey, now);
      if (cooldownErr) {
        return { candidate_id: candidateId, ok: false, reason: cooldownErr };
      }
      const recentSuccessErr = this.recentSuccessSuppressionReason({
        patternKey,
        objectiveType,
        componentArea,
        nowIso: now,
      });
      if (recentSuccessErr) {
        return { candidate_id: candidateId, ok: false, reason: recentSuccessErr };
      }
      if (preflightErr) {
        return { candidate_id: candidateId, ok: false, reason: preflightErr };
      }
      if (patternKey && activePatternKeys.has(patternKey)) {
        return { candidate_id: candidateId, ok: false, reason: "pattern already has active objective" };
      }
      if (confidence < limits.minConfidence) {
        return {
          candidate_id: candidateId,
          ok: false,
          reason: `candidate confidence ${confidence.toFixed(2)} < ${limits.minConfidence}`,
        };
      }
      if (applySequentialAccounting) {
        byTypeCounts[objectiveType] = perTypeCount + 1;
        globalCount += 1;
        activeCount += 1;
        if (patternKey) activePatternKeys.add(patternKey);
      }
      return { candidate_id: candidateId, ok: true };
    });
    return { ok: true, results };
  }

  recordObjectiveDecision(body: Record<string, unknown>): {
    ok: boolean;
    objectiveId?: string;
    questionId?: string;
    patternKey?: string;
    reason?: string;
  } {
    const runId = asString(body.runId);
    const snapshotId = asString(body.snapshotId);
    const sessionId = asString(body.sessionId);
    if (!runId || !snapshotId || !sessionId) {
      return { ok: false, reason: "runId, snapshotId, and sessionId are required" };
    }

    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const candidateEngineTrialMetaById = new Map<string, EngineTrialCandidateMeta>();
    for (const raw of candidates) {
      const record = asObject(raw);
      const objectiveTypeRaw = asString(record.objectiveType ?? record.objective_type);
      const componentAreaRaw = asString(record.componentArea ?? record.component_area);
      const triggerTypeRaw = asString(record.triggerType ?? record.trigger_type);
      const objectiveType = asObjectiveType(objectiveTypeRaw);
      const componentArea = asComponentArea(componentAreaRaw);
      const triggerType = asTriggerType(triggerTypeRaw);
      const targetPaths = asStringArray(record.targetPaths ?? record.target_paths);
      const scopeRecord = asObject(record.scope);
      const riskLevel = asString(record.riskLevel ?? record.risk_level);
      const expectedValidation = asStringArray(record.expectedValidation ?? record.expected_validation);
      const readAnywhere = asBoolean(scopeRecord.readAnywhere ?? scopeRecord.read_anywhere, false);
      const writeGlobs = asStringArray(scopeRecord.writeGlobs ?? scopeRecord.write_globs);
      const scopeValidation = componentArea
        ? validateScopeInvariants(componentArea, targetPaths, writeGlobs, { requireWriteGlobs: true })
        : {
            ok: false,
            normalizedTargetPaths: targetPaths,
            normalizedWriteGlobs: writeGlobs,
            breadth: "broad" as AutonomyGlobBreadth,
            errors: [`invalid component_area "${componentAreaRaw}"`],
          };
      const enumErrors: string[] = [];
      if (!objectiveType) enumErrors.push(`invalid objective_type "${objectiveTypeRaw}"`);
      if (!triggerType) enumErrors.push(`invalid trigger_type "${triggerTypeRaw}"`);
      const policyErrors = policyViolations({
        objectiveType: objectiveType ?? objectiveTypeRaw,
        riskLevel,
        breadth: scopeValidation.breadth,
        readAnywhere,
        expectedValidation,
        allowReadAnywhere: this.config.remotebuddy.autonomy.allowReadAnywhere,
      });
      const gateReasons = [
        ...enumErrors,
        ...(scopeValidation.ok ? [] : scopeValidation.errors),
        ...policyErrors,
      ];
      const penalties = normalizePenalties(
        (Array.isArray(record.penalties) ? record.penalties : []).map((entry) => {
          const item = asObject(entry);
          return {
            kind: asString(item.kind) as any,
            weight: asNumber(item.weight, 0),
            reason: asString(item.reason),
            evidence_ids: asStringArray(item.evidence_ids),
          };
        }),
      );
      const llmScore = asNumber(record.llmScore ?? record.llm_score, 0);
      const impactSignal = asNumber(record.impactSignal ?? record.impact_signal, 0);
      const emaSuccess = asNumber(record.emaSuccess ?? record.ema_success, 0);
      const emaUserAccept = asNumber(record.emaUserAccept ?? record.ema_user_accept, 0);
      const finalScore =
        Number.isFinite(asNumber(record.finalScore ?? record.final_score, Number.NaN))
          ? asNumber(record.finalScore ?? record.final_score, 0)
          : 0.55 * llmScore + 0.2 * impactSignal + 0.15 * emaSuccess + 0.1 * emaUserAccept - penaltyTotal(penalties);
      const objectiveTypePersist = (objectiveType ?? objectiveTypeRaw) || "invalid";
      const triggerTypePersist = (triggerType ?? triggerTypeRaw) || "invalid";
      const componentAreaPersist = (componentArea ?? componentAreaRaw) || "invalid";
      const candidateExternalId = asString(record.id) || randomUUID();
      const candidateStorageId = scopedCandidateStorageId(runId, candidateExternalId);
      const engineTrialMeta = extractEngineTrialCandidateMeta(record);
      if (engineTrialMeta) {
        candidateEngineTrialMetaById.set(candidateStorageId, engineTrialMeta);
      }
      const debugRecord = {
        ...asObject(record.debug),
        candidate_external_id: candidateExternalId,
      };

      this.db
        .prepare(
          `INSERT OR REPLACE INTO autonomy_candidates (
            id, run_id, snapshot_id, session_id, title, objective_type, problem_statement, trigger_type,
            component_area, target_paths_json, scope_json, risk_level, expected_validation_json,
            estimated_effort, why_now_signal_ids_json, confidence, pattern_key, llm_score, impact_signal,
            ema_success, ema_user_accept, penalties_json, final_score, selected, rejection_reason,
            gate_decision, gate_reasons_json, debug_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateStorageId,
          runId,
          snapshotId,
          sessionId,
          asString(record.title),
          objectiveTypePersist,
          asString(record.problemStatement ?? record.problem_statement),
          triggerTypePersist,
          componentAreaPersist,
          JSON.stringify(scopeValidation.normalizedTargetPaths),
          JSON.stringify({
            readAnywhere,
            writeGlobs: scopeValidation.normalizedWriteGlobs,
          }),
          riskLevel,
          JSON.stringify(expectedValidation),
          asString(record.estimatedEffort ?? record.estimated_effort),
          JSON.stringify(asStringArray(record.whyNowSignalIds ?? record.why_now_signal_ids)),
          clamp01(asNumber(record.confidence, 0)),
          makePatternKey(
            objectiveTypePersist,
            scopeValidation.normalizedTargetPaths,
            triggerTypePersist,
            componentAreaPersist,
          ),
          llmScore,
          impactSignal,
          emaSuccess,
          emaUserAccept,
          JSON.stringify(penalties),
          finalScore,
          asBoolean(record.selected, false) ? 1 : 0,
          asString(record.rejectionReason ?? record.rejection_reason) || null,
          asString(record.gateDecision ?? record.gate_decision) ||
            (gateReasons.length === 0 ? "approved" : "rejected"),
          JSON.stringify(
            gateReasons.length === 0 ? asStringArray(record.gateReasons ?? record.gate_reasons) : gateReasons,
          ),
          JSON.stringify(debugRecord),
          asIsoNow(),
        );
    }

    const llmCalls = Array.isArray(body.llmCalls) ? body.llmCalls : [];
    for (const raw of llmCalls) {
      const call = asObject(raw);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO autonomy_llm_calls (
            id, run_id, snapshot_id, objective_id, phase, prompt_template_version, prompt_hash,
            request_payload_hash, model_id, temperature, timeout_ms, response_json, response_hash,
            token_usage_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asString(call.id) || randomUUID(),
          runId,
          snapshotId,
          asString(call.objectiveId ?? call.objective_id) || null,
          asString(call.phase),
          asString(call.promptTemplateVersion ?? call.prompt_template_version) || null,
          asString(call.promptHash ?? call.prompt_hash) || null,
          asString(call.requestPayloadHash ?? call.request_payload_hash) || null,
          asString(call.modelId ?? call.model_id) || null,
          Number.isFinite(asNumber(call.temperature, Number.NaN)) ? asNumber(call.temperature, 0) : null,
          Number.isFinite(asNumber(call.timeoutMs ?? call.timeout_ms, Number.NaN))
            ? Math.floor(asNumber(call.timeoutMs ?? call.timeout_ms, 0))
            : null,
          this.llmResponseJsonForStorage(call),
          asString(call.responseHash ?? call.response_hash) || null,
          JSON.stringify(asObject(call.tokenUsage ?? call.token_usage)),
          asIsoNow(),
        );
    }
    if (llmCalls.length > 0) this.enforceReplayRetention();

    const objective = asObject(body.objective);
    if (Object.keys(objective).length === 0) return { ok: true };

    const objectiveId = asString(objective.id) || randomUUID();
    const objectiveTypeRaw = asString(objective.objectiveType ?? objective.objective_type);
    const objectiveType = asObjectiveType(objectiveTypeRaw);
    const now = asIsoNow();
    const objectiveStatus = asString(objective.status);

    if (!objectiveType) {
      return { ok: false, objectiveId, reason: `invalid objective_type "${objectiveTypeRaw}"` };
    }
    const componentAreaRaw = asString(objective.componentArea ?? objective.component_area);
    const componentArea = asComponentArea(componentAreaRaw);
    if (!componentArea) {
      return { ok: false, objectiveId, reason: `invalid component_area "${componentAreaRaw}"` };
    }
    const triggerTypeRaw = asString(objective.triggerType ?? objective.trigger_type);
    const triggerType = asTriggerType(triggerTypeRaw);
    if (!triggerType) {
      return { ok: false, objectiveId, reason: `invalid trigger_type "${triggerTypeRaw}"` };
    }

    const targetPaths = asStringArray(objective.targetPaths ?? objective.target_paths);
    const scopeRecord = asObject(objective.scope);
    const riskLevel = asString(objective.riskLevel ?? objective.risk_level);
    const readAnywhere = asBoolean(scopeRecord.readAnywhere ?? scopeRecord.read_anywhere, false);
    const scopeValidation = validateScopeInvariants(
      componentArea,
      targetPaths,
      asStringArray(scopeRecord.writeGlobs ?? scopeRecord.write_globs),
      { requireWriteGlobs: true },
    );
    if (!scopeValidation.ok) return { ok: false, objectiveId, reason: scopeValidation.errors.join("; ") };
    const expectedValidation = asStringArray(
      objective.expectedValidation ??
        objective.expected_validation ??
        asObject(body.candidate).expectedValidation ??
        asObject(body.candidate).expected_validation,
    );
    const policyErrors = policyViolations({
      objectiveType,
      riskLevel,
      breadth: scopeValidation.breadth,
      readAnywhere,
      expectedValidation,
      allowReadAnywhere: this.config.remotebuddy.autonomy.allowReadAnywhere,
    });
    if (policyErrors.length > 0) {
      return { ok: false, objectiveId, reason: policyErrors.join("; ") };
    }

    const patternKey = makePatternKey(
      objectiveType,
      scopeValidation.normalizedTargetPaths,
      triggerType,
      componentArea,
    );
    const objectiveCandidateRaw = asString(objective.candidateId ?? objective.candidate_id);
    const objectiveCandidateId = objectiveCandidateRaw
      ? scopedCandidateStorageId(runId, objectiveCandidateRaw)
      : null;
    if (objectiveStatus === "dispatched") {
      const overrideCooldown = asBoolean(
        objective.overrideCooldown ?? objective.override_cooldown ?? body.overrideCooldown ?? body.override_cooldown,
        false,
      );
      const eligibility = this.evaluateEligibility({
        runId,
        snapshotId,
        candidates: [
          {
            candidate_id: objectiveId,
            objective_type: objectiveType,
            pattern_key: patternKey,
            confidence: clamp01(asNumber(objective.confidence, 0)),
          },
        ],
      });
      if (!eligibility.ok) {
        return { ok: false, objectiveId, reason: eligibility.reason ?? "eligibility evaluation failed" };
      }
      const decision = eligibility.results?.[0];
      if (!decision?.ok) {
        const reason = asString(decision?.reason) || "objective not eligible for dispatch";
        const isCooldownOnlyBlock = reason.startsWith("cooldown_active");
        if (!(overrideCooldown && isCooldownOnlyBlock)) {
          return {
            ok: false,
            objectiveId,
            reason,
          };
        }
      }
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO autonomy_objectives (
          id, run_id, snapshot_id, session_id, candidate_id, title, instruction, objective_type,
          component_area, trigger_type, pattern_key, status, source, confidence, priority, risk_level,
          request_id, job_id, question_id, block_reason, scope_json, evidence_json,
          score_breakdown_json, policy_version, impact_model_version, dispatched_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'autonomous', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        objectiveId,
        runId,
        snapshotId,
        sessionId,
        objectiveCandidateId,
        asString(objective.title),
        asString(objective.instruction),
        objectiveType,
        componentArea,
        triggerType,
        patternKey,
        objectiveStatus,
        clamp01(asNumber(objective.confidence, 0)),
        asString(objective.priority) || "background",
        riskLevel,
        asString(objective.requestId ?? objective.request_id) || null,
        asString(objective.jobId ?? objective.job_id) || null,
        asString(objective.questionId ?? objective.question_id) || null,
        asString(objective.blockReason ?? objective.block_reason) || null,
        JSON.stringify({
          readAnywhere,
          writeGlobs: scopeValidation.normalizedWriteGlobs,
          targetPaths: scopeValidation.normalizedTargetPaths,
        }),
        JSON.stringify(asObject(objective.evidence)),
        JSON.stringify(asObject(objective.scoreBreakdown ?? objective.score_breakdown)),
        asString(objective.policyVersion ?? objective.policy_version) ||
          this.config.remotebuddy.autonomy.policyVersion,
        asString(objective.impactModelVersion ?? objective.impact_model_version) ||
          this.config.remotebuddy.autonomy.impactModelVersion,
        objectiveStatus === "dispatched" ? now : null,
        now,
        now,
      );
    const trialMeta =
      (objectiveCandidateId ? candidateEngineTrialMetaById.get(objectiveCandidateId) : undefined) ?? null;
    if (trialMeta) {
      const trialId = `trial_${objectiveId}`;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO autonomy_engine_idea_trials (
            trial_id, run_id, snapshot_id, session_id, objective_id, candidate_id, pattern_key,
            engine_building_block_id, engine_algorithm, engine_source, engine_score,
            objective_ids_json, gap_ids_json, metadata_json, status, success, user_action, latency_ms,
            last_outcome_id, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          trialId,
          runId,
          snapshotId,
          sessionId,
          objectiveId,
          objectiveCandidateId,
          patternKey,
          trialMeta.buildingBlockId,
          trialMeta.algorithm,
          trialMeta.source || "llm",
          trialMeta.score,
          JSON.stringify(trialMeta.objectiveIds),
          JSON.stringify(trialMeta.gapIds),
          JSON.stringify(trialMeta.metadata),
          objectiveStatus || "proposed",
          now,
          now,
        );
    }

    let questionId: string | undefined;
    const question = asObject(body.question);
    if (Object.keys(question).length > 0) {
      questionId = asString(question.id) || randomUUID();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO questions_queue (
            id, objective_id, session_id, question, question_type, expected_answer_schema_json,
            context_json, status, answer_json, answer_validation_status, validation_error, created_at,
            answered_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'pending', NULL, ?, NULL, ?)`,
        )
        .run(
          questionId,
          objectiveId,
          sessionId,
          asString(question.question),
          asString(question.questionType ?? question.question_type),
          JSON.stringify(asObject(question.expectedAnswerSchema ?? question.expected_answer_schema)),
          JSON.stringify(asObject(question.context)),
          now,
          asString(question.expiresAt ?? question.expires_at) ||
            new Date(Date.parse(now) + this.config.remotebuddy.autonomy.questionTtlMs).toISOString(),
        );
      this.db
        .prepare(`UPDATE autonomy_objectives SET question_id = ?, updated_at = ? WHERE id = ?`)
        .run(questionId, now, objectiveId);
    }

    return { ok: true, objectiveId, questionId, patternKey };
  }

  private resolvePatternContext(params: {
    objectiveId?: string | null;
    requestId?: string | null;
    jobId?: string | null;
    prUrl?: string | null;
  }): { objectiveId: string | null; requestId: string | null; jobId: string | null; patternKey: string | null } | null {
    const objectiveId = asString(params.objectiveId);
    const requestId = asString(params.requestId);
    const jobId = asString(params.jobId);
    const prUrl = asString(params.prUrl);

    const readByObjective = (id: string) =>
      this.db
        .prepare(
          `SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE id = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(id) as
        | {
            objectiveId: string | null;
            requestId: string | null;
            jobId: string | null;
            patternKey: string | null;
          }
        | undefined;
    const readByRequest = (id: string) =>
      this.db
        .prepare(
          `SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE request_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(id) as
        | {
            objectiveId: string | null;
            requestId: string | null;
            jobId: string | null;
            patternKey: string | null;
          }
        | undefined;
    const readByJob = (id: string) =>
      this.db
        .prepare(
          `SELECT id AS objectiveId, request_id AS requestId, job_id AS jobId, pattern_key AS patternKey
           FROM autonomy_objectives
           WHERE job_id = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(id) as
        | {
            objectiveId: string | null;
            requestId: string | null;
            jobId: string | null;
            patternKey: string | null;
          }
        | undefined;

    const readByPrUrl = (url: string) =>
      this.db
        .prepare(
          `SELECT o.id AS objectiveId,
                  o.request_id AS requestId,
                  o.job_id AS jobId,
                  o.pattern_key AS patternKey
           FROM autonomy_objectives o
           JOIN jobs j ON j.id = o.job_id
           WHERE j.prUrl = ? OR LOWER(j.prUrl) = LOWER(?)
           ORDER BY o.updated_at DESC
           LIMIT 1`,
        )
        .get(url, url) as
        | {
            objectiveId: string | null;
            requestId: string | null;
            jobId: string | null;
            patternKey: string | null;
          }
        | undefined;

    const row =
      (objectiveId ? readByObjective(objectiveId) : undefined) ??
      (jobId ? readByJob(jobId) : undefined) ??
      (requestId ? readByRequest(requestId) : undefined) ??
      (prUrl ? readByPrUrl(prUrl) : undefined);

    if (!row) return null;
    return {
      objectiveId: asString(row.objectiveId) || null,
      requestId: asString(row.requestId) || null,
      jobId: asString(row.jobId) || null,
      patternKey: asString(row.patternKey) || null,
    };
  }

  recordPrFeedback(body: Record<string, unknown>): {
    ok: boolean;
    reason?: string;
    patternKey?: string;
    objectiveId?: string;
    deduped?: boolean;
    success?: boolean;
    userAction?: string;
  } {
    const now = asIsoNow();
    const verdict = asString(body.verdict).toLowerCase();
    if (!verdict) return { ok: false, reason: "verdict is required" };

    const feedbackKey = asString(body.feedbackKey ?? body.feedback_key) || null;
    const objectiveIdRaw = asString(body.objectiveId ?? body.objective_id) || null;
    const requestIdRaw = asString(body.requestId ?? body.request_id) || null;
    const jobIdRaw = asString(body.jobId ?? body.job_id) || null;
    const prUrl = asString(body.prUrl ?? body.pr_url) || null;

    let patternKey = asString(body.patternKey ?? body.pattern_key) || null;
    const resolved = this.resolvePatternContext({
      objectiveId: objectiveIdRaw,
      requestId: requestIdRaw,
      jobId: jobIdRaw,
      prUrl,
    });
    if (!patternKey) {
      patternKey = asString(resolved?.patternKey) || null;
    }
    if (!patternKey) {
      return {
        ok: false,
        reason: "unable to resolve patternKey from objectiveId/requestId/jobId/prUrl",
      };
    }

    const objectiveId = objectiveIdRaw ?? resolved?.objectiveId ?? null;
    const requestId = requestIdRaw ?? resolved?.requestId ?? null;
    const jobId = jobIdRaw ?? resolved?.jobId ?? null;

    const reviewScore = Number.isFinite(asNumber(body.reviewScore ?? body.review_score, Number.NaN))
      ? asNumber(body.reviewScore ?? body.review_score, 0)
      : null;
    const reviewThreshold = Number.isFinite(
      asNumber(body.reviewThreshold ?? body.review_threshold, Number.NaN),
    )
      ? asNumber(body.reviewThreshold ?? body.review_threshold, 0)
      : null;
    const prFeedbackCommentRows = Math.max(
      1,
      Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackCommentRows, 16)),
    );
    const prFeedbackCommentChars = Math.max(
      32,
      Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackCommentChars, 600)),
    );
    const prFeedbackSummaryChars = Math.max(
      32,
      Math.floor(asNumber(this.config.remotebuddy.autonomy.prFeedbackSummaryChars, 600)),
    );
    const summary = truncateText(
      asString(body.summary ?? body.verdictSummary ?? body.verdict_summary),
      prFeedbackSummaryChars,
    );
    const source = asString(body.source) || "review_agent";
    const prNumber = Number.isFinite(asNumber(body.prNumber ?? body.pr_number, Number.NaN))
      ? Math.max(0, Math.floor(asNumber(body.prNumber ?? body.pr_number, 0)))
      : null;

    const rawComments = Array.isArray(body.comments) ? body.comments : [];
    const comments = rawComments
      .map((entry) => {
        const row = asObject(entry);
        const text = truncateText(asString(row.body), prFeedbackCommentChars);
        if (!text) return null;
        return {
          body: text,
          user_login: asString(row.userLogin ?? row.user_login ?? row.author),
          created_at: asString(row.createdAt ?? row.created_at),
          html_url: asString(row.htmlUrl ?? row.html_url),
        };
      })
      .filter((entry): entry is { body: string; user_login: string; created_at: string; html_url: string } =>
        Boolean(entry),
      )
      .slice(0, prFeedbackCommentRows);
    const payloadCommentCount = Number.isFinite(asNumber(body.commentCount ?? body.comment_count, Number.NaN))
      ? Math.max(0, Math.floor(asNumber(body.commentCount ?? body.comment_count, 0)))
      : 0;
    const commentCount = Math.max(payloadCommentCount, comments.length);

    const insertInfo = this.db
      .prepare(
        `INSERT OR IGNORE INTO autonomy_pr_feedback (
          feedback_key, objective_id, request_id, job_id, pattern_key, pr_number, pr_url,
          verdict, review_score, review_threshold, summary, comment_count, comments_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedbackKey,
        objectiveId,
        requestId,
        jobId,
        patternKey,
        prNumber,
        prUrl,
        verdict,
        reviewScore,
        reviewThreshold,
        summary || null,
        commentCount,
        comments.length > 0 ? JSON.stringify(comments) : null,
        source,
        now,
      );
    const inserted = Number(insertInfo.changes ?? 0) > 0;
    if (!inserted) {
      return {
        ok: true,
        deduped: true,
        patternKey,
        ...(objectiveId ? { objectiveId } : {}),
      };
    }

    const mappedOutcome = deriveOutcomeFromPrFeedbackVerdict(verdict);
    if (!mappedOutcome) {
      return {
        ok: true,
        patternKey,
        ...(objectiveId ? { objectiveId } : {}),
      };
    }

    const outcome = this.recordOutcome({
      objectiveId,
      requestId,
      jobId,
      patternKey,
      success: mappedOutcome.success,
      retries: 0,
      latencyMs: null,
      userAction: mappedOutcome.userAction,
      reopenedWithin24h: mappedOutcome.reopenedWithin24h,
      regressionFlag: mappedOutcome.regressionFlag,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
      };
    }
    return {
      ok: true,
      patternKey,
      ...(objectiveId ? { objectiveId } : {}),
      success: mappedOutcome.success,
      userAction: mappedOutcome.userAction,
    };
  }

  recordOutcome(body: Record<string, unknown>): { ok: boolean; reason?: string } {
    let patternKey = asString(body.patternKey ?? body.pattern_key);
    const objectiveIdRaw = asString(body.objectiveId ?? body.objective_id) || null;
    const requestIdRaw = asString(body.requestId ?? body.request_id) || null;
    const jobIdRaw = asString(body.jobId ?? body.job_id) || null;
    const resolved =
      !patternKey || !objectiveIdRaw || !requestIdRaw || !jobIdRaw
        ? this.resolvePatternContext({
            objectiveId: objectiveIdRaw,
            requestId: requestIdRaw,
            jobId: jobIdRaw,
          })
        : null;
    if (!patternKey) {
      patternKey = asString(resolved?.patternKey);
    }
    if (!patternKey) return { ok: false, reason: "patternKey is required" };
    const objectiveId = objectiveIdRaw ?? resolved?.objectiveId ?? null;
    const requestId = requestIdRaw ?? resolved?.requestId ?? null;
    const jobId = jobIdRaw ?? resolved?.jobId ?? null;
    const now = asIsoNow();
    const success = asBoolean(body.success, false);
    const retries = Math.max(0, Math.floor(asNumber(body.retries, 0)));
    const latencyMs = Number.isFinite(asNumber(body.latencyMs ?? body.latency_ms, Number.NaN))
      ? Math.max(0, Math.floor(asNumber(body.latencyMs ?? body.latency_ms, 0)))
      : null;
    const userAction = asString(body.userAction ?? body.user_action) || null;
    const reopenedWithin24h = asBoolean(
      body.reopenedWithin24h ?? body.reopened_within_24h,
      false,
    );
    const regressionFlag = asBoolean(body.regressionFlag ?? body.regression_flag, false);
    const normalizedUserAction = userAction ? userAction.toLowerCase() : "";

    // RemoteBuddy marks delegated requests complete after enqueueing a worker job.
    // Ignore those pre-execution "accepted" signals for autonomy objectives until job-linked outcomes arrive.
    if (success && normalizedUserAction === "accepted" && !jobId && objectiveId) {
      const objectiveRow = this.db
        .prepare(`SELECT source, status, job_id FROM autonomy_objectives WHERE id = ? LIMIT 1`)
        .get(objectiveId) as
        | {
            source: string | null;
            status: string | null;
            job_id: string | null;
          }
        | undefined;
      if (objectiveRow) {
        const source = asString(objectiveRow.source).toLowerCase();
        const status = asString(objectiveRow.status).toLowerCase();
        const linkedJobId = asString(objectiveRow.job_id);
        const pendingStatuses = new Set(["proposed", "gated", "dispatched", "running"]);
        if (source === "autonomous" && !linkedJobId && pendingStatuses.has(status)) {
          return { ok: true };
        }
      }
    }

    const outcomeInsert = this.db
      .prepare(
        `INSERT INTO autonomy_outcomes (
          objective_id, request_id, job_id, pattern_key, success, retries, latency_ms, user_action,
          reopened_within_24h, regression_flag, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        objectiveId,
        requestId,
        jobId,
        patternKey,
        success ? 1 : 0,
        retries,
        latencyMs,
        userAction,
        reopenedWithin24h ? 1 : 0,
        regressionFlag ? 1 : 0,
        now,
      );
    const outcomeId = Math.max(0, Math.floor(asNumber(outcomeInsert.lastInsertRowid, 0)));

    if (objectiveId) {
      const terminalStatus = success ? "completed" : "failed";
      this.db
        .prepare(
          `UPDATE autonomy_objectives
           SET status = ?,
               request_id = COALESCE(?, request_id),
               job_id = COALESCE(?, job_id),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(terminalStatus, requestId, jobId, now, objectiveId);
    }
    const pendingIdeaTrials = objectiveId
      ? (this.db
          .prepare(
            `SELECT trial_id, engine_building_block_id, engine_algorithm
             FROM autonomy_engine_idea_trials
             WHERE objective_id = ?
               AND completed_at IS NULL
             ORDER BY created_at ASC`,
          )
          .all(objectiveId) as Array<{
          trial_id: string;
          engine_building_block_id: string;
          engine_algorithm: string;
        }>)
      : [];

    const existing = this.db
      .prepare(
        `SELECT ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count
         FROM autonomy_pattern_stats
         WHERE pattern_key = ?`,
      )
      .get(patternKey) as
      | {
          ema_success: number;
          ema_user_accept: number;
          ema_latency: number;
          ema_regret: number;
          fail_streak: number;
          sample_count: number;
        }
      | undefined;
    const prev = existing ?? {
      ema_success: 0,
      ema_user_accept: 0,
      ema_latency: 0,
      ema_regret: 0,
      fail_streak: 0,
      sample_count: 0,
    };
    const ema = (oldValue: number, currentValue: number) =>
      this.alpha * currentValue + (1 - this.alpha) * oldValue;
    const successValue = success ? 1 : 0;
    const userAcceptValue =
      userAction && ["accepted", "manual_fix", "override_dispatch", "applied"].includes(userAction)
        ? 1
        : 0;
    const latencyScore =
      typeof latencyMs === "number" ? clamp01(1 - latencyMs / 600_000) : prev.ema_latency;
    const regretValue =
      reopenedWithin24h || (userAction && ["rejected", "cancelled"].includes(userAction)) ? 1 : 0;
    const nextFailStreak = success ? 0 : prev.fail_streak + 1;
    const cooldownUntil =
      !success && nextFailStreak >= this.config.remotebuddy.autonomy.cooldownFailStreakThreshold
        ? new Date(Date.parse(now) + this.config.remotebuddy.autonomy.cooldownMs).toISOString()
        : null;
    if (pendingIdeaTrials.length > 0) {
      const terminalStatus = success ? "completed" : "failed";
      const outcomeRef = outcomeId > 0 ? outcomeId : null;
      const updateTrial = this.db.prepare(
        `UPDATE autonomy_engine_idea_trials
         SET status = ?,
             success = ?,
             user_action = ?,
             latency_ms = ?,
             last_outcome_id = ?,
             completed_at = ?,
             updated_at = ?
         WHERE trial_id = ?
           AND completed_at IS NULL`,
      );
      const readIdeaStat = this.db.prepare(
        `SELECT ema_success, ema_user_accept, ema_latency, ema_regret, sample_count
         FROM autonomy_engine_idea_stats
         WHERE engine_building_block_id = ?`,
      );
      const upsertIdeaStat = this.db.prepare(
        `INSERT INTO autonomy_engine_idea_stats (
          engine_building_block_id, engine_algorithm, ema_success, ema_user_accept, ema_latency, ema_regret, sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(engine_building_block_id) DO UPDATE SET
          engine_algorithm = excluded.engine_algorithm,
          ema_success = excluded.ema_success,
          ema_user_accept = excluded.ema_user_accept,
          ema_latency = excluded.ema_latency,
          ema_regret = excluded.ema_regret,
          sample_count = excluded.sample_count,
          updated_at = excluded.updated_at`,
      );
      for (const trial of pendingIdeaTrials) {
        updateTrial.run(
          terminalStatus,
          success ? 1 : 0,
          userAction,
          latencyMs,
          outcomeRef,
          now,
          now,
          trial.trial_id,
        );
        const blockId = asString(trial.engine_building_block_id);
        if (!blockId) continue;
        const stats = readIdeaStat.get(blockId) as
          | {
              ema_success: number;
              ema_user_accept: number;
              ema_latency: number;
              ema_regret: number;
              sample_count: number;
            }
          | undefined;
        const prevIdea = stats ?? {
          ema_success: 0,
          ema_user_accept: 0,
          ema_latency: 0,
          ema_regret: 0,
          sample_count: 0,
        };
        const ideaLatencyScore =
          typeof latencyMs === "number" ? clamp01(1 - latencyMs / 600_000) : prevIdea.ema_latency;
        upsertIdeaStat.run(
          blockId,
          asString(trial.engine_algorithm) || "engine_building_block",
          ema(prevIdea.ema_success, successValue),
          ema(prevIdea.ema_user_accept, userAcceptValue),
          ema(prevIdea.ema_latency, ideaLatencyScore),
          ema(prevIdea.ema_regret, regretValue),
          prevIdea.sample_count + 1,
          now,
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO autonomy_pattern_stats (
          pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak,
          cooldown_until, sample_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pattern_key) DO UPDATE SET
          ema_success = excluded.ema_success,
          ema_user_accept = excluded.ema_user_accept,
          ema_latency = excluded.ema_latency,
          ema_regret = excluded.ema_regret,
          fail_streak = excluded.fail_streak,
          cooldown_until = excluded.cooldown_until,
          sample_count = excluded.sample_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        patternKey,
        ema(prev.ema_success, successValue),
        ema(prev.ema_user_accept, userAcceptValue),
        ema(prev.ema_latency, latencyScore),
        ema(prev.ema_regret, regretValue),
        nextFailStreak,
        cooldownUntil,
        prev.sample_count + 1,
        now,
      );
    return { ok: true };
  }

  listInsights(params?: {
    patternKey?: string;
    objectiveId?: string;
    limit?: number;
    feedbackLimit?: number;
  }): AutonomyInsights {
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(params?.limit, 20))));
    const feedbackLimit = Math.max(
      1,
      Math.min(200, Math.floor(asNumber(params?.feedbackLimit, 30))),
    );
    const patternKey = asString(params?.patternKey);
    const objectiveId = asString(params?.objectiveId);

    const patternStatsRows = patternKey
      ? (this.db
          .prepare(
            `SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
             FROM autonomy_pattern_stats
             WHERE pattern_key = ?
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(patternKey, limit) as Array<{
          pattern_key: string;
          ema_success: number;
          ema_user_accept: number;
          ema_latency: number;
          ema_regret: number;
          fail_streak: number;
          sample_count: number;
          cooldown_until: string | null;
          updated_at: string;
        }>)
      : (this.db
          .prepare(
            `SELECT pattern_key, ema_success, ema_user_accept, ema_latency, ema_regret, fail_streak, sample_count, cooldown_until, updated_at
             FROM autonomy_pattern_stats
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(limit) as Array<{
          pattern_key: string;
          ema_success: number;
          ema_user_accept: number;
          ema_latency: number;
          ema_regret: number;
          fail_streak: number;
          sample_count: number;
          cooldown_until: string | null;
          updated_at: string;
        }>);

    const prFeedbackWhere: string[] = [];
    const prFeedbackArgs: Array<string | number> = [];
    if (patternKey) {
      prFeedbackWhere.push("pattern_key = ?");
      prFeedbackArgs.push(patternKey);
    }
    if (objectiveId) {
      prFeedbackWhere.push("objective_id = ?");
      prFeedbackArgs.push(objectiveId);
    }
    const prFeedbackRows = this.db
      .prepare(
        `SELECT id, created_at, source, pattern_key, objective_id, request_id, job_id, pr_number, pr_url,
                verdict, review_score, review_threshold, summary, comment_count, comments_json
         FROM autonomy_pr_feedback
         ${prFeedbackWhere.length > 0 ? `WHERE ${prFeedbackWhere.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...prFeedbackArgs, feedbackLimit) as Array<{
      id: number;
      created_at: string;
      source: string | null;
      pattern_key: string | null;
      objective_id: string | null;
      request_id: string | null;
      job_id: string | null;
      pr_number: number | null;
      pr_url: string | null;
      verdict: string | null;
      review_score: number | null;
      review_threshold: number | null;
      summary: string | null;
      comment_count: number | null;
      comments_json: string | null;
    }>;

    return {
      patternStats: patternStatsRows.map((row) => ({
        patternKey: asString(row.pattern_key),
        emaSuccess: clamp01(asNumber(row.ema_success, 0)),
        emaUserAccept: clamp01(asNumber(row.ema_user_accept, 0)),
        emaLatency: clamp01(asNumber(row.ema_latency, 0)),
        emaRegret: clamp01(asNumber(row.ema_regret, 0)),
        failStreak: Math.max(0, Math.floor(asNumber(row.fail_streak, 0))),
        sampleCount: Math.max(0, Math.floor(asNumber(row.sample_count, 0))),
        cooldownUntil: asString(row.cooldown_until) || null,
        updatedAt: asString(row.updated_at),
      })),
      recentPrFeedback: prFeedbackRows.map((row) => {
        const comments = parseJsonArray(row.comments_json)
          .map((entry) => {
            const parsed = asObject(entry);
            const body = asString(parsed.body);
            if (!body) return null;
            return {
              body,
              user_login: asString(parsed.user_login ?? parsed.userLogin ?? parsed.author),
              created_at: asString(parsed.created_at ?? parsed.createdAt),
              html_url: asString(parsed.html_url ?? parsed.htmlUrl),
            };
          })
          .filter((entry): entry is PrFeedbackComment => Boolean(entry));
        return {
          id: Math.max(0, Math.floor(asNumber(row.id, 0))),
          createdAt: asString(row.created_at),
          source: asString(row.source) || "review_agent",
          patternKey: asString(row.pattern_key),
          objectiveId: asString(row.objective_id) || null,
          requestId: asString(row.request_id) || null,
          jobId: asString(row.job_id) || null,
          prNumber: Number.isFinite(asNumber(row.pr_number, Number.NaN))
            ? Math.max(0, Math.floor(asNumber(row.pr_number, 0)))
            : null,
          prUrl: asString(row.pr_url) || null,
          verdict: asString(row.verdict),
          reviewScore: Number.isFinite(asNumber(row.review_score, Number.NaN))
            ? asNumber(row.review_score, 0)
            : null,
          reviewThreshold: Number.isFinite(asNumber(row.review_threshold, Number.NaN))
            ? asNumber(row.review_threshold, 0)
            : null,
          summary: asString(row.summary) || null,
          commentCount: Math.max(0, Math.floor(asNumber(row.comment_count, comments.length))),
          comments,
        };
      }),
    };
  }

  listQuestions(params?: {
    sessionId?: string;
    status?: "open" | "answered" | "invalid" | "closed";
    limit?: number;
  }): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, Math.floor(asNumber(params?.limit, 100))));
    let rows: any[] = [];
    if (params?.sessionId && params?.status) {
      rows = this.db
        .prepare(
          `SELECT *
           FROM questions_queue
           WHERE session_id = ? AND status = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(params.sessionId, params.status, limit) as any[];
    } else if (params?.sessionId) {
      rows = this.db
        .prepare(
          `SELECT *
           FROM questions_queue
           WHERE session_id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(params.sessionId, limit) as any[];
    } else if (params?.status) {
      rows = this.db
        .prepare(
          `SELECT *
           FROM questions_queue
           WHERE status = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(params.status, limit) as any[];
    } else {
      rows = this.db
        .prepare(
          `SELECT *
           FROM questions_queue
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(limit) as any[];
    }
    return rows.map((row) => ({
      ...row,
      expected_answer_schema: parseJsonObject(row.expected_answer_schema_json),
      context: parseJsonObject(row.context_json),
      answer: row.answer_json ? JSON.parse(row.answer_json) : null,
    }));
  }

  answerQuestion(
    questionId: string,
    answer: unknown,
  ): { ok: boolean; status?: "valid" | "invalid"; reason?: string; objectiveId?: string } {
    const row = this.db
      .prepare(
        `SELECT id, objective_id, question_type, expected_answer_schema_json, status, expires_at
         FROM questions_queue
         WHERE id = ?`,
      )
      .get(questionId) as
      | {
          id: string;
          objective_id: string;
          question_type: string;
          expected_answer_schema_json: string | null;
          status: string;
          expires_at: string | null;
        }
      | undefined;
    if (!row) return { ok: false, reason: "Question not found" };
    const now = asIsoNow();
    if (row.status !== "open" && row.status !== "invalid") {
      return { ok: false, reason: `Question is not answerable in status "${row.status}"` };
    }
    const expiresAtMs = Date.parse(asString(row.expires_at));
    const nowMs = Date.parse(now);
    if (Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && nowMs > expiresAtMs) {
      this.db
        .prepare(`UPDATE questions_queue SET status = 'closed', validation_error = ? WHERE id = ?`)
        .run("Question expired before answer was provided", questionId);
      this.db
        .prepare(`UPDATE autonomy_objectives SET status = 'expired', updated_at = ? WHERE id = ?`)
        .run(now, row.objective_id);
      return { ok: false, reason: "Question has expired", objectiveId: row.objective_id };
    }

    const validation = validateAnswerAgainstSchema(
      row.question_type,
      parseJsonObject(row.expected_answer_schema_json),
      answer,
    );
    if (!validation.valid) {
      this.db
        .prepare(
          `UPDATE questions_queue
           SET status = 'invalid',
               answer_json = ?,
               answer_validation_status = 'invalid',
               validation_error = ?,
               answered_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(answer), validation.error ?? "Invalid answer", now, questionId);
      this.db
        .prepare(`UPDATE autonomy_objectives SET status = 'needs_clarification', updated_at = ? WHERE id = ?`)
        .run(now, row.objective_id);
      return { ok: true, status: "invalid", reason: validation.error, objectiveId: row.objective_id };
    }

    this.db
      .prepare(
        `UPDATE questions_queue
         SET status = 'answered',
             answer_json = ?,
             answer_validation_status = 'valid',
             validation_error = NULL,
             answered_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(validation.normalized), now, questionId);
    this.db
      .prepare(`UPDATE autonomy_objectives SET status = 'gated', updated_at = ? WHERE id = ?`)
      .run(now, row.objective_id);
    return { ok: true, status: "valid", objectiveId: row.objective_id };
  }

  findObjectiveByRequestId(requestId: string): {
    objectiveId: string;
    patternKey: string;
    sessionId: string;
    runId: string;
    snapshotId: string;
  } | null {
    if (!requestId) return null;
    const row = this.db
      .prepare(
        `SELECT id AS objectiveId, pattern_key AS patternKey, session_id AS sessionId, run_id AS runId, snapshot_id AS snapshotId
         FROM autonomy_objectives
         WHERE request_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(requestId) as
      | {
          objectiveId: string;
          patternKey: string;
          sessionId: string;
          runId: string;
          snapshotId: string;
        }
      | undefined;
    return row ?? null;
  }

  findObjectiveByJobId(jobId: string): {
    objectiveId: string;
    patternKey: string;
    sessionId: string;
    runId: string;
    snapshotId: string;
  } | null {
    if (!jobId) return null;
    const row = this.db
      .prepare(
        `SELECT id AS objectiveId, pattern_key AS patternKey, session_id AS sessionId, run_id AS runId, snapshot_id AS snapshotId
         FROM autonomy_objectives
         WHERE job_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(jobId) as
      | {
          objectiveId: string;
          patternKey: string;
          sessionId: string;
          runId: string;
          snapshotId: string;
        }
      | undefined;
    return row ?? null;
  }

  linkJobToObjectiveByRequest(requestId: string, jobId: string): void {
    if (!requestId || !jobId) return;
    this.db
      .prepare(
        `UPDATE autonomy_objectives
         SET job_id = ?, updated_at = ?
         WHERE request_id = ? AND (job_id IS NULL OR job_id = '')`,
      )
      .run(jobId, asIsoNow(), requestId);
  }

  close(): void {
    this.db.close();
  }
}
