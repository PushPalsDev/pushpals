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
  requires_user_input?: boolean;
  question_if_blocked?: string;
  candidate_created_at: string;
};

type Snapshot = {
  snapshot_id: string;
  snapshot_created_at: string;
  snapshot_ttl_ms: number;
  impact_model_version: string;
  top_signals: Array<{ signal_id: string; type: string; value: number; evidence: string }>;
  feedback_priors: Array<{
    pattern_key: string;
    ema_success: number;
    ema_user_accept: number;
    fail_streak: number;
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
const MAX_VISION_CONTEXT_CHARS = 12_000;
const MAX_VISION_SECTION_CHARS = 1_200;
const DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY = 0.45;
const DOCS_WEAK_EVIDENCE_MAX_PENALTY = 0.12;

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

    const truncated = trimmed.length > MAX_VISION_CONTEXT_CHARS;
    if (truncated) {
      console.log(
        `[RemoteBuddyAutonomousEngine] tick ${runId}: ${VISION_DOC_FNAME} exceeded ${MAX_VISION_CONTEXT_CHARS} chars; using first ${MAX_VISION_CONTEXT_CHARS} chars for ideation.`,
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
      markdown: truncated ? trimmed.slice(0, MAX_VISION_CONTEXT_CHARS) : trimmed,
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
      0.55 * clamp01(llmScore) +
      0.2 * clamp01(impactSignal) +
      0.15 * clamp01(asNumber(prior?.ema_success, 0)) +
      0.1 * clamp01(asNumber(prior?.ema_user_accept, 0)) -
      penaltyTotal(normalizedPenalties);
    return {
      patternKey,
      impactSignal,
      penalties: normalizedPenalties,
      finalScore,
      emaSuccess: clamp01(asNumber(prior?.ema_success, 0)),
      emaUserAccept: clamp01(asNumber(prior?.ema_user_accept, 0)),
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
                  feedback_priors: snapshot.feedback_priors.slice(0, 20),
                  open_objectives: snapshot.open_objectives.slice(0, 20),
                  active_cooldowns: snapshot.active_cooldowns.slice(0, 20),
                },
                vision: visionContext,
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
      const rawCandidates = Array.isArray(ideationJson.candidates) ? ideationJson.candidates : [];
      const normalizedCandidates: AutonomyCandidate[] = [];
      const dropReasonCounts = new Map<string, number>();
      const recordDropReason = (reason: string): void => {
        dropReasonCounts.set(reason, (dropReasonCounts.get(reason) ?? 0) + 1);
      };
      const candidateCreatedBaseMs = Date.now();
      for (const [candidateIndex, rawCandidate] of rawCandidates
        .slice(0, this.cfg.ideationMaxCandidates)
        .entries()) {
        const c = asObject(rawCandidate);
        const triggerType = asString(c.trigger_type);
        if (!isTriggerType(triggerType)) {
          recordDropReason("invalid_trigger_type");
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
          requires_user_input: asBoolean(c.requires_user_input, false),
          question_if_blocked: asString(c.question_if_blocked),
          candidate_created_at: new Date(candidateCreatedBaseMs + candidateIndex).toISOString(),
        };
        const policy = POLICY[candidate.objective_type];
        if (!policy || !policy.autonomousAllowed) {
          recordDropReason("objective_type_not_allowed");
          continue;
        }
        if (!isRiskLevel(candidate.risk_level)) {
          recordDropReason("invalid_risk_level");
          continue;
        }
        if (RISK_ORDER[candidate.risk_level] > RISK_ORDER[policy.maxRisk]) {
          recordDropReason("risk_exceeds_policy");
          continue;
        }
        const scopeValidation = validateScopeInvariants(
          candidate.component_area,
          candidate.target_paths,
          candidate.scope.write_globs,
          { requireWriteGlobs: true },
        );
        if (!scopeValidation.ok) {
          recordDropReason("scope_validation_failed");
          continue;
        }
        if (BREADTH_ORDER[scopeValidation.breadth] > BREADTH_ORDER[policy.maxBreadth]) {
          recordDropReason("scope_breadth_exceeds_policy");
          continue;
        }
        if (candidate.scope.read_anywhere && !this.cfg.allowReadAnywhere) {
          recordDropReason("read_anywhere_not_allowed");
          continue;
        }
        if (policy.requireValidation && candidate.expected_validation.length === 0) {
          recordDropReason("missing_validation_steps");
          continue;
        }
        if (!candidate.vision_alignment_reason) {
          recordDropReason("missing_vision_alignment_reason");
          continue;
        }
        if (requireVisionSectionRefs && candidate.vision_section_refs.length === 0) {
          recordDropReason("missing_vision_section_refs");
          continue;
        }
        candidate.target_paths = scopeValidation.normalizedTargetPaths;
        candidate.scope.write_globs = scopeValidation.normalizedWriteGlobs;
        normalizedCandidates.push(candidate);
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
        llm_score: row.llmScore,
        impact_signal: row.impactSignal,
        ema_success: row.emaSuccess,
        ema_user_accept: row.emaUserAccept,
        penalties: row.penalties,
        final_score: row.finalScore,
        gate_decision: row.eligibility.ok ? "approved" : "rejected",
        gate_reasons: row.eligibility.ok ? [] : [row.eligibility.reason],
        selected: false,
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
      const selected = rankedWithEligibility.find((row) => row.eligibility.ok);
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
          };
      for (const row of candidatesPayload) {
        row.selected = Boolean(row.id === selectedCandidatePayload.id);
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
              final_score: top.finalScore,
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
              final_score: selected.finalScore,
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
            final_score: selected.finalScore,
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
