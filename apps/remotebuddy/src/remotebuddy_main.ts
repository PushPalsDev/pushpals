#!/usr/bin/env bun
/**
 * PushPals RemoteBuddy Orchestrator
 *
 * AI-powered orchestrator that:
 *   1) Listens for user `message` events via cursor-based WS stream
 *   2) Runs them through an LLM brain (LM Studio / Ollama)
 *   3) Emits assistant_message and optionally creates tasks + enqueues jobs
 *   4) Tracks job lifecycle and closes out tasks when all jobs complete
 *
 * Replay-safe: uses IdempotencyStore to avoid re-processing messages on reconnect.
 *
 * Usage:
 *   bun run src/remotebuddy_main.ts --server http://localhost:3001 [--sessionId <id>] [--token <auth>]
 *   Defaults resolve from config/*.toml via shared config loader.
 */

import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { createLLMClient } from "./llm.js";
import { AgentBrain } from "./brain.js";
import { IdempotencyStore } from "./idempotency.js";
import { CommunicationManager, detectRepoRoot, loadPushPalsConfig } from "shared";
import { mkdirSync } from "fs";

// ─── CLI args ───────────────────────────────────────────────────────────────

const CONFIG = loadPushPalsConfig();

function parseArgs(): {
  server: string;
  sessionId: string | null;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = CONFIG.server.url;
  let sessionId: string | null = CONFIG.sessionId;
  let authToken = CONFIG.authToken;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
    }
  }

  return { server, sessionId, authToken };
}

// ─── RemoteBuddy Orchestrator ───────────────────────────────────────────────

function isLikelyChitChat(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  const short = t.length <= 64;
  return (
    short &&
    /^(hi|hello|hey|hi there|hello there|thanks|thank you|ok|okay|cool|nice|yo|sup|what's up|whats up)[!. ]*$/.test(
      t,
    )
  );
}

function isQuestionLike(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(is|are|can|could|should|would|what|why|how|when|where|which|does|do)\b/.test(t);
}

function extractTargetPath(text: string): string | null {
  const stopWords = new Set(["a", "an", "the", "it", "this", "that", "there", "here", "file"]);
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!value) continue;
    if (!/^[A-Za-z0-9._/\-\\]+$/.test(value)) continue;
    if (stopWords.has(value.toLowerCase())) continue;
    return value;
  }
  return null;
}

function isExecutionIntent(text: string, targetPath: string | null): boolean {
  const t = text.trim().toLowerCase();
  if (!t || isLikelyChitChat(t)) return false;
  if (targetPath) return true;

  if (isArchitectureIntent(t)) return true;

  const mutatingVerb =
    /\b(create|write|add|append|edit|update|modify|delete|remove|rename|implement|fix|refactor|generate)\b/.test(
      t,
    );
  const operationalVerb =
    /\b(run|test|lint|build|compile|search|find|inspect|check|validate|trace|debug)\b/.test(t);
  const repoHint =
    /\b(repo|repository|project|architecture|structure|module|component|workflow|pipeline|branch|worker|orchestrator|server|client|docker|git|code|file|readme)\b/.test(
      t,
    );

  if (mutatingVerb && (repoHint || t.length >= 12)) return true;
  if (operationalVerb && repoHint) return true;

  // Keep question-style prompts in chat unless there is a clear execution signal.
  if (isQuestionLike(t)) return false;

  // Long, imperative prompts without explicit verbs are still likely execution intents.
  return t.length > 220;
}

function isArchitectureIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const architectureCue =
    /\b(architecture|repo architecture|repository architecture|system design|high[- ]level|overview|describe the architecture|how .* works|explain .* architecture)\b/.test(
      t,
    );
  const codeChangeCue =
    /\b(refactor|rename|change|modify|edit|update|implement|fix|add|remove|delete|create|write|patch)\b/.test(
      t,
    );
  return architectureCue && !codeChangeCue;
}

type TaskExecutionLane = "deterministic" | "openhands";
type RequestPriority = "interactive" | "normal" | "background";
type PlannerIntent = "chat" | "status" | "code_change" | "analysis" | "other";
type PlannerRisk = "low" | "medium" | "high";

interface TaskExecuteJobParams {
  schemaVersion: 2;
  requestId: string;
  sessionId: string;
  instruction: string;
  lane: TaskExecutionLane;
  planning: {
    intent: PlannerIntent;
    riskLevel: PlannerRisk;
    targetPaths: string[];
    validationSteps: string[];
    queuePriority: RequestPriority;
    queueWaitBudgetMs: number;
    executionBudgetMs: number;
    finalizationBudgetMs: number;
  };
  targetPath?: string;
  recentContext: string[];
  recentJobs: Array<Record<string, unknown>>;
}

function normalizeRequestPriority(value: unknown): RequestPriority {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "interactive" || text === "background") return text;
  return "normal";
}

function toSingleLine(value: unknown, max = 220): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

interface WorkerSnapshot {
  workerId: string;
  status: "idle" | "busy" | "error" | "offline";
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: Record<string, unknown>;
  details: Record<string, unknown>;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
  isOnline: boolean;
}

interface JobLogEntry {
  id: number;
  jobId: string;
  ts: string;
  message: string;
}

function explainJobFailureFromLogs(
  logs: JobLogEntry[],
  fallbackMessage: string,
  fallbackDetail: string,
): string {
  const lines = logs.map((row) => toSingleLine(row.message, 420)).filter(Boolean);
  const joined = lines.join("\n").toLowerCase();

  if (joined.includes("model preflight failed") && joined.includes("timed out")) {
    return "The worker could not reach the local LLM endpoint from Docker in time (model preflight timeout). This is usually LM Studio not responding quickly enough at host.docker.internal:1234.";
  }
  if (joined.includes("model selection exhausted")) {
    return "All candidate models failed preflight/execution, so OpenHands stopped before running the task.";
  }
  if (
    joined.includes("failed to load model") ||
    joined.includes("insufficient system resources") ||
    joined.includes("model loading was stopped")
  ) {
    return "The selected model could not be loaded due to local resource constraints, and no fallback model succeeded.";
  }
  if (joined.includes("cannot truncate prompt with n_keep")) {
    return "The prompt exceeded the LM Studio/llama.cpp context constraints (n_keep >= n_ctx), so the request was rejected before execution.";
  }
  if (joined.includes("context size has been exceeded")) {
    return "The model context window was exceeded before execution could start.";
  }
  if (joined.includes("connection refused") || joined.includes("connection error")) {
    return "The worker could not connect to the configured LLM endpoint from the container.";
  }
  if (joined.includes("timeout reached for task.execute") || joined.includes("wrapper timed out")) {
    return "The wrapper hit its execution timeout before OpenHands returned a structured result.";
  }
  if (
    joined.includes("tool preflight returned non-json response") ||
    joined.includes("preflight must return one valid json object in a single response")
  ) {
    return "The worker stopped before running tools because strict tool preflight expected exactly one JSON object and the model returned non-JSON output.";
  }

  const lastLine = lines[lines.length - 1] ?? "";
  const fallback = [fallbackMessage, fallbackDetail].filter(Boolean).join(" | ");
  if (lastLine) return `Latest failure signal: ${lastLine}`;
  if (fallback) return `Failure signal: ${fallback}`;
  return "No additional diagnostic signal was found in the current log tail.";
}

function isStrictPreflightJsonFailure(message: string, detail: string): boolean {
  const combined = `${message}\n${detail}`.toLowerCase();
  return (
    combined.includes("tool preflight returned non-json response") ||
    combined.includes("preflight must return one valid json object in a single response")
  );
}

function isNoChangeCompletionSummary(summary: string): boolean {
  const text = summary.toLowerCase();
  return (
    text.includes("no targetpath provided") ||
    text.includes("no target path provided") ||
    text.includes("no changes to commit") ||
    text.includes("no file changes detected") ||
    text.includes("no modified files were detected")
  );
}

class RemoteBuddyOrchestrator {
  private readonly agentId = "remotebuddy-orchestrator";
  private readonly server: string;
  private readonly sessionId: string;
  private readonly authToken: string | null;
  private readonly repo: string;
  private readonly jobsDbPath: string;
  private readonly workerOnlineTtlMs: number;
  private readonly waitForWorkerMs: number;
  private readonly autoSpawnWorkers: boolean;
  private readonly maxWorkers: number;
  private readonly workerStartupTimeoutMs: number;
  private readonly spawnWorkerDocker: boolean;
  private readonly spawnWorkerRequireDocker: boolean;
  private readonly spawnWorkerImage: string | null;
  private readonly spawnWorkerPollMs: number | null;
  private readonly spawnWorkerHeartbeatMs: number | null;
  private readonly spawnWorkerLabels: string[];
  private readonly statusHeartbeatMs: number;
  private readonly executionBudgetInteractiveMs: number;
  private readonly executionBudgetNormalMs: number;
  private readonly executionBudgetBackgroundMs: number;
  private readonly finalizationBudgetMs: number;
  private readonly managedWorkers = new Map<string, ReturnType<typeof Bun.spawn>>();
  private readonly comm: CommunicationManager;
  private statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusSessionReady = false;
  private stopSessionEvents: (() => void) | null = null;
  private readonly seenJobFailures = new Set<string>();
  private readonly seenJobCompletions = new Set<string>();
  private readonly eventMonitorStartedAt = Date.now();
  private jobsDb: Database | null = null;
  private disposed = false;

  /** Serialises async request handling to preserve ordering */
  private chain: Promise<void> = Promise.resolve();

  /** AI brain — produces assistant messages + optional action plans */
  private brain: AgentBrain;
  /** Durable idempotency store — prevents replay-induced duplicates */
  private idempotency: IdempotencyStore;
  /** Recent session context for LLM (bounded ring buffer) */
  private recentContext: string[] = [];
  private static readonly MAX_CONTEXT = 20;
  private static readonly MAX_CONTEXT_ENTRY_CHARS = 1200;
  private static readonly CHAT_CONTEXT_MAX = 8;
  private static readonly CHAT_CONTEXT_ENTRY_CHARS = 420;

  constructor(opts: {
    server: string;
    sessionId: string;
    authToken: string | null;
    brain: AgentBrain;
    idempotency: IdempotencyStore;
    jobsDbPath: string;
  }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.brain = opts.brain;
    this.idempotency = opts.idempotency;
    this.jobsDbPath = opts.jobsDbPath;
    const remoteCfg = CONFIG.remotebuddy;
    this.workerOnlineTtlMs = Math.max(1_000, remoteCfg.workerpalOnlineTtlMs);
    this.waitForWorkerMs = Math.max(0, remoteCfg.waitForWorkerpalMs);
    this.autoSpawnWorkers = remoteCfg.autoSpawnWorkerpals;
    this.maxWorkers = Math.max(1, remoteCfg.maxWorkerpals);
    this.workerStartupTimeoutMs = Math.max(1_000, remoteCfg.workerpalStartupTimeoutMs);
    this.spawnWorkerDocker = remoteCfg.workerpalDocker;
    this.spawnWorkerRequireDocker = remoteCfg.workerpalRequireDocker;
    this.spawnWorkerImage = remoteCfg.workerpalImage;
    this.spawnWorkerPollMs =
      typeof remoteCfg.workerpalPollMs === "number" && remoteCfg.workerpalPollMs > 0
        ? remoteCfg.workerpalPollMs
        : null;
    this.spawnWorkerHeartbeatMs =
      typeof remoteCfg.workerpalHeartbeatMs === "number" && remoteCfg.workerpalHeartbeatMs > 0
        ? remoteCfg.workerpalHeartbeatMs
        : null;
    this.spawnWorkerLabels = remoteCfg.workerpalLabels;
    this.statusHeartbeatMs = Math.max(0, remoteCfg.statusHeartbeatMs);
    this.executionBudgetInteractiveMs = Math.max(60_000, remoteCfg.executionBudgetInteractiveMs);
    this.executionBudgetNormalMs = Math.max(120_000, remoteCfg.executionBudgetNormalMs);
    this.executionBudgetBackgroundMs = Math.max(180_000, remoteCfg.executionBudgetBackgroundMs);
    this.finalizationBudgetMs = Math.max(30_000, remoteCfg.finalizationBudgetMs);

    // Detect repo root from current working directory
    this.repo = detectRepoRoot(process.cwd());
    this.comm = new CommunicationManager({
      serverUrl: this.server,
      sessionId: this.sessionId,
      authToken: this.authToken,
      from: `agent:${this.agentId}`,
    });
    console.log(`[RemoteBuddy] Detected repo root: ${this.repo}`);
    console.log(
      `[RemoteBuddy] Worker scheduler: max=${this.maxWorkers} autoSpawn=${this.autoSpawnWorkers ? "on" : "off"} wait=${this.waitForWorkerMs}ms`,
    );
    console.log(
      `[RemoteBuddy] Budgets: interactive=${this.executionBudgetInteractiveMs}ms normal=${this.executionBudgetNormalMs}ms background=${this.executionBudgetBackgroundMs}ms finalization=${this.finalizationBudgetMs}ms`,
    );
  }

  async emitStartupStatus(): Promise<void> {
    this.statusSessionReady = await this.ensureSessionWithRetry();
    if (!this.statusSessionReady) {
      console.warn("[RemoteBuddy] Could not ensure session for startup presence events");
      return;
    }
    const startupDeadlineMs = Date.now() + 15_000;
    let startupStatusOk = false;
    while (!this.disposed) {
      startupStatusOk = await this.comm.status(
        this.agentId,
        "idle",
        "RemoteBuddy online and waiting for requests",
      );
      if (startupStatusOk) break;
      this.statusSessionReady = false;
      if (Date.now() >= startupDeadlineMs) break;
      await Bun.sleep(1_000);
      this.statusSessionReady = await this.ensureSessionWithRetry(3, 400, 2_500);
    }
    if (!startupStatusOk) {
      console.warn("[RemoteBuddy] Failed to emit startup status event");
    }
    const msgOk = await this.comm.assistantMessage("RemoteBuddy online and waiting for requests.");
    if (!msgOk) {
      console.warn("[RemoteBuddy] Failed to emit startup welcome message");
    }
  }

  startStatusHeartbeat(): void {
    if (this.statusHeartbeatMs <= 0 || this.statusHeartbeatTimer) return;
    this.statusHeartbeatTimer = setInterval(() => {
      if (this.disposed) return;
      void (async () => {
        if (!this.statusSessionReady) {
          this.statusSessionReady = await this.ensureSessionWithRetry(3, 400, 2500);
        }
        const ok = await this.comm.status(this.agentId, "idle", "RemoteBuddy heartbeat");
        if (!ok) {
          this.statusSessionReady = false;
        }
      })();
    }, this.statusHeartbeatMs);
  }

  private async ensureSessionWithRetry(
    maxRetries = 20,
    baseDelayMs = 500,
    maxDelayMs = 5000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries && !this.disposed; attempt++) {
      try {
        const res = await fetch(`${this.server}/sessions`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ sessionId: this.sessionId }),
        });
        if (res.ok) return true;
      } catch {
        // retry
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await Bun.sleep(delayMs);
    }
    return false;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  /** Send a command event through the server */
  private async sendCommand(cmd: Omit<CommandRequest, "from">): Promise<void> {
    try {
      const ok = await this.comm.emit(cmd.type, cmd.payload as any, {
        to: cmd.to,
        correlationId: cmd.correlationId,
        turnId: cmd.turnId,
        parentId: cmd.parentId,
      });
      if (!ok) console.error(`[RemoteBuddy] Command ${cmd.type} failed`);
    } catch (err) {
      console.error(`[RemoteBuddy] Command ${cmd.type} error:`, err);
    }
  }

  private async fetchJobLogs(jobId: string, limit = 80): Promise<JobLogEntry[]> {
    try {
      const res = await fetch(
        `${this.server}/jobs/${jobId}/logs?limit=${Math.max(1, Math.min(500, limit))}`,
        {
          method: "GET",
          headers: this.authHeaders(),
        },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { ok?: boolean; logs?: JobLogEntry[] };
      if (!data.ok || !Array.isArray(data.logs)) return [];
      return data.logs.filter((row) => row && typeof row.message === "string").slice(-80);
    } catch {
      return [];
    }
  }

  private async handleObservedJobFailure(
    envelope: {
      id?: string;
      correlationId?: string;
      turnId?: string;
    },
    jobId: string,
    message: string,
    detail: string,
  ): Promise<void> {
    const shortJob = jobId.slice(0, 8);
    const fetchMsg = isStrictPreflightJsonFailure(message, detail)
      ? `WorkerPal job ${shortJob} stopped before tool execution because strict preflight expected one JSON response and got non-JSON output. I'm fetching logs now to diagnose what happened.`
      : `WorkerPal job ${shortJob} failed: ${message}${detail ? ` (${detail})` : ""} I got an error and I'm fetching logs now to diagnose what happened.`;
    await this.comm.assistantMessage(fetchMsg, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id,
    });

    console.warn(`[RemoteBuddy] Fetching failure logs for job ${jobId}...`);
    const logs = await this.fetchJobLogs(jobId, 80);
    const explanation = explainJobFailureFromLogs(logs, message, detail);

    const tail = logs
      .slice(-6)
      .map((row) => toSingleLine(row.message, 220))
      .filter(Boolean);
    const tailText = tail.length ? `\nRecent logs:\n\`\`\`\n${tail.join("\n")}\n\`\`\`` : "";

    await this.comm.assistantMessage(`Diagnosis for job ${shortJob}: ${explanation}${tailText}`, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id,
    });
  }

  startSessionEventMonitor(): void {
    this.stopSessionEvents = this.comm.subscribeSessionEvents(
      (envelope) => {
        if (envelope.type !== "job_failed" && envelope.type !== "job_completed") return;
        const tsMs = Date.parse(envelope.ts);
        if (Number.isFinite(tsMs) && tsMs + 2000 < this.eventMonitorStartedAt) return;
        if (envelope.type === "job_failed") {
          const payload = envelope.payload as {
            jobId?: unknown;
            message?: unknown;
            detail?: unknown;
          };
          const jobId = String(payload.jobId ?? "").trim();
          const message = toSingleLine(payload.message, 220);
          const detail = toSingleLine(payload.detail, 220);
          if (!jobId || !message) return;

          const dedupeKey = `${jobId}:${message}`;
          if (this.seenJobFailures.has(dedupeKey)) return;
          this.seenJobFailures.add(dedupeKey);

          const failureLine = `[job_failed ${jobId}] ${message}${detail ? ` | ${detail}` : ""}`;
          this.pushContext(failureLine);
          console.warn(`[RemoteBuddy] Observed WorkerPal failure ${jobId}: ${message}`);
          void this.handleObservedJobFailure(envelope, jobId, message, detail);
          return;
        }

        const payload = envelope.payload as {
          jobId?: unknown;
          summary?: unknown;
        };
        const jobId = String(payload.jobId ?? "").trim();
        const summary = toSingleLine(payload.summary, 240) || "Job completed";
        if (!jobId) return;
        if (/startup warmup completed/i.test(summary)) return;
        if (this.seenJobCompletions.has(jobId)) return;
        this.seenJobCompletions.add(jobId);

        this.pushContext(`[job_completed ${jobId}] ${summary}`);
        const shortJob = jobId.slice(0, 8);
        const note = isNoChangeCompletionSummary(summary)
          ? `WorkerPal job ${shortJob} completed: ${summary}. No files were changed, so no commit was created.`
          : `WorkerPal job ${shortJob} completed: ${summary}.`;
        void this.comm.assistantMessage(note, {
          correlationId: envelope.correlationId,
          turnId: envelope.turnId,
          parentId: envelope.id,
        });
      },
      {
        onError: (message) => console.warn(`[RemoteBuddy] Session monitor: ${message}`),
      },
    );
  }

  /**
   * Enqueue a job via the server job queue.
   * Returns the server-assigned jobId on success, or null on failure.
   */
  private async enqueueJob(
    taskId: string,
    kind: "task.execute",
    params: TaskExecuteJobParams,
    targetWorkerId: string | null = null,
  ): Promise<string | null> {
    try {
      const payload: Record<string, unknown> = {
        taskId,
        sessionId: this.sessionId,
        kind,
        params,
      };
      if (targetWorkerId) payload.targetWorkerId = targetWorkerId;

      const res = await fetch(`${this.server}/jobs/enqueue`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[RemoteBuddy] Enqueue failed: ${res.status} ${err}`);
        return null;
      }
      const data = (await res.json()) as { ok: boolean; jobId?: string };
      if (!data.ok || !data.jobId) {
        console.error(`[RemoteBuddy] Enqueue response missing jobId:`, data);
        return null;
      }
      return data.jobId;
    } catch (err) {
      console.error(`[RemoteBuddy] Enqueue error:`, err);
      return null;
    }
  }

  // ── Context tracking ───────────────────────────────────────────────────

  private pushContext(text: string): void {
    const normalized = String(text ?? "").trim();
    if (!normalized) return;
    const capped =
      normalized.length <= RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS
        ? normalized
        : `${normalized.slice(0, RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS - 16)}\n...[truncated]`;
    this.recentContext.push(capped);
    if (this.recentContext.length > RemoteBuddyOrchestrator.MAX_CONTEXT) {
      this.recentContext.shift();
    }
  }

  private getChatContextSnapshot(): string[] {
    const filtered = this.recentContext.filter((entry) => !entry.startsWith("[enhanced]"));
    return filtered
      .slice(-RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX)
      .map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }

  private planningContextSnapshot(priority: RequestPriority): string[] {
    const filtered = this.recentContext.filter((entry) => !entry.startsWith("[enhanced]"));
    const limit = priority === "interactive" ? 6 : RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX;
    return filtered
      .slice(-limit)
      .map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }

  private executionBudgetForPriority(priority: RequestPriority): number {
    switch (priority) {
      case "interactive":
        return this.executionBudgetInteractiveMs;
      case "background":
        return this.executionBudgetBackgroundMs;
      default:
        return this.executionBudgetNormalMs;
    }
  }

  private chooseExecutionLane(
    prompt: string,
    plan: {
      lane: TaskExecutionLane;
      intent: PlannerIntent;
      risk_level: PlannerRisk;
      target_paths: string[];
      validation_steps: string[];
    },
  ): TaskExecutionLane {
    if (plan.intent === "status") return "deterministic";
    if (
      plan.risk_level === "low" &&
      plan.target_paths.length <= 3 &&
      plan.validation_steps.length <= 4
    ) {
      if (prompt.trim().length <= 800) return "deterministic";
    }
    return plan.lane;
  }

  private shouldForceDirectReply(prompt: string, intent: PlannerIntent): boolean {
    if (intent !== "chat" && intent !== "status") return false;
    return !isExecutionIntent(prompt, extractTargetPath(prompt));
  }

  private getRecentJobContext(limit: number = 12): Array<Record<string, unknown>> {
    try {
      if (!this.jobsDb) {
        this.jobsDb = new Database(this.jobsDbPath);
      }
      const rows = this.jobsDb
        .prepare(
          `SELECT id, taskId, kind, status, workerId, result, error, updatedAt
           FROM jobs
           WHERE sessionId = ?
           ORDER BY updatedAt DESC
           LIMIT ?`,
        )
        .all(this.sessionId, Math.max(1, Math.min(limit, 50))) as Array<{
        id: string;
        taskId: string;
        kind: string;
        status: string;
        workerId: string | null;
        result: string | null;
        error: string | null;
        updatedAt: string;
      }>;

      return rows.map((row) => {
        let summary = "";
        let errorMessage = "";
        try {
          if (row.result) {
            const parsed = JSON.parse(row.result) as { summary?: string };
            summary = toSingleLine(parsed.summary ?? "");
          }
        } catch {
          summary = "";
        }
        try {
          if (row.error) {
            const parsed = JSON.parse(row.error) as { message?: string; detail?: string };
            errorMessage = toSingleLine(parsed.message ?? parsed.detail ?? "");
          }
        } catch {
          errorMessage = toSingleLine(row.error ?? "");
        }
        return {
          jobId: row.id,
          taskId: row.taskId,
          kind: row.kind,
          status: row.status,
          workerId: row.workerId,
          summary,
          error: errorMessage,
          updatedAt: row.updatedAt,
        };
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not read recent job context:", err);
      return [];
    }
  }

  private async fetchWorkers(): Promise<WorkerSnapshot[]> {
    try {
      const res = await fetch(`${this.server}/workers?ttlMs=${this.workerOnlineTtlMs}`, {
        method: "GET",
        headers: this.authHeaders(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { ok: boolean; workers?: WorkerSnapshot[] };
      return data.ok ? (data.workers ?? []) : [];
    } catch {
      return [];
    }
  }

  private pickIdleWorker(workers: WorkerSnapshot[]): WorkerSnapshot | null {
    const idle = workers
      .filter(
        (worker) => worker.isOnline && worker.status !== "offline" && worker.activeJobCount === 0,
      )
      .sort((a, b) => Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat));
    return idle[0] ?? null;
  }

  private async waitForIdleWorker(
    timeoutMs: number,
    preferredWorkerId?: string,
  ): Promise<WorkerSnapshot | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const workers = await this.fetchWorkers();
      if (preferredWorkerId) {
        const preferred = workers.find(
          (worker) =>
            worker.workerId === preferredWorkerId &&
            worker.isOnline &&
            worker.status !== "offline" &&
            worker.activeJobCount === 0,
        );
        if (preferred) return preferred;
      }

      const idle = this.pickIdleWorker(workers);
      if (idle) return idle;
      if (Date.now() >= deadline) return null;
      await Bun.sleep(500);
    }
  }

  private buildWorkerSpawnCommand(workerId: string): string[] {
    const args = [
      "bun",
      "--cwd",
      "apps/workerpals",
      "--env-file",
      "../../.env",
      "run",
      "src/workerpals_main.ts",
      "--server",
      this.server,
      "--workerId",
      workerId,
    ];
    if (this.spawnWorkerPollMs) {
      args.push("--poll", String(this.spawnWorkerPollMs));
    }
    if (this.spawnWorkerHeartbeatMs) {
      args.push("--heartbeat", String(this.spawnWorkerHeartbeatMs));
    }
    if (this.spawnWorkerLabels.length > 0) {
      args.push("--labels", this.spawnWorkerLabels.join(","));
    }
    if (this.spawnWorkerDocker) {
      args.push("--docker");
      if (this.spawnWorkerRequireDocker) args.push("--require-docker");
      if (this.spawnWorkerImage) {
        args.push("--docker-image", this.spawnWorkerImage);
      }
    }
    return args;
  }

  private async spawnWorker(): Promise<string | null> {
    if (this.managedWorkers.size >= this.maxWorkers) {
      return null;
    }
    const workerId = `workerpal-${randomUUID().substring(0, 8)}`;
    const cmd = this.buildWorkerSpawnCommand(workerId);
    console.log(
      `[RemoteBuddy] Spawning WorkerPal ${workerId} (${this.managedWorkers.size + 1}/${this.maxWorkers})`,
    );
    try {
      const child = Bun.spawn(cmd, {
        cwd: this.repo,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      this.managedWorkers.set(workerId, child);
      child.exited.then((code) => {
        this.managedWorkers.delete(workerId);
        console.warn(`[RemoteBuddy] WorkerPal process ${workerId} exited with code ${code}`);
      });

      const ready = await this.waitForIdleWorker(this.workerStartupTimeoutMs, workerId);
      if (ready) return ready.workerId;
      console.warn(`[RemoteBuddy] WorkerPal ${workerId} did not report ready within timeout`);
      return null;
    } catch (err) {
      console.error(`[RemoteBuddy] Failed to spawn WorkerPal ${workerId}:`, err);
      return null;
    }
  }

  private async selectTargetWorkerForJob(): Promise<string | null> {
    const workers = await this.fetchWorkers();
    const idleNow = this.pickIdleWorker(workers);
    if (idleNow) {
      return idleNow.workerId;
    }

    const onlineWorkers = workers.filter(
      (worker) => worker.isOnline && worker.status !== "offline",
    );
    if (this.autoSpawnWorkers && onlineWorkers.length < this.maxWorkers) {
      const spawned = await this.spawnWorker();
      if (spawned) return spawned;
    }

    const waited = await this.waitForIdleWorker(this.waitForWorkerMs);
    return waited?.workerId ?? null;
  }

  // In this architecture, RemoteBuddy only creates tasks/jobs via polling.
  // Job completion tracking is handled by the server event stream and workers.
  // ── Dispatch, Polling for Request Queue ────────────────────────────────────────

  /** Process a request from the Request Queue (replaces handleMessage) */
  private async processRequest(
    request: {
      id: string;
      prompt: string;
      priority?: string;
      queueWaitBudgetMs?: number;
    },
    queueWaitMs = 0,
  ): Promise<void> {
    const requestId = String(request.id ?? "").trim();
    if (!requestId) return;

    if (this.idempotency.hasHandled(this.sessionId, requestId)) {
      console.log(`[RemoteBuddy] Skipping already-handled request ${requestId}`);
      return;
    }
    this.idempotency.markHandled(this.sessionId, requestId);

    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) {
      console.warn(`[RemoteBuddy] Request ${requestId} missing prompt; marking failed`);
      await fetch(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ message: "Request missing prompt" }),
      }).catch(() => {});
      return;
    }

    const priority = normalizeRequestPriority(request.priority);
    const queueWaitBudgetMs = Math.max(
      5_000,
      Number.isFinite(Number(request.queueWaitBudgetMs))
        ? Number(request.queueWaitBudgetMs)
        : priority === "interactive"
          ? 20_000
          : priority === "background"
            ? 240_000
            : 90_000,
    );
    const turnId = randomUUID();
    const planningContext = this.planningContextSnapshot(priority);

    try {
      console.log(
        `[RemoteBuddy] Planning request ${requestId.slice(0, 8)} priority=${priority} queueWait=${Math.max(
          0,
          Math.floor(queueWaitMs),
        )}ms`,
      );
      const plan = await this.brain.think(prompt, planningContext);
      this.pushContext(`[user] ${toSingleLine(prompt, 700)}`);
      this.pushContext(`[plan] ${toSingleLine(JSON.stringify(plan), 900)}`);
      const requiresWorker = this.shouldForceDirectReply(prompt, plan.intent)
        ? false
        : plan.requires_worker;
      const targetPath = plan.target_paths[0] ?? extractTargetPath(prompt) ?? undefined;
      let lane = requiresWorker ? this.chooseExecutionLane(prompt, plan) : "deterministic";
      if (requiresWorker && lane === "deterministic" && plan.intent === "code_change" && !targetPath) {
        lane = "openhands";
      }

      if (queueWaitMs > queueWaitBudgetMs) {
        await this.comm.assistantMessage(
          `Request ${requestId.slice(0, 8)} waited ${Math.floor(
            queueWaitMs / 1000,
          )}s in queue (budget ${Math.floor(queueWaitBudgetMs / 1000)}s). Prioritizing execution now.`,
          { turnId, correlationId: requestId },
        );
      }

      if (!requiresWorker) {
        await this.sendCommand({
          type: "assistant_message",
          payload: { text: plan.assistant_message },
          turnId,
        });
        await fetch(`${this.server}/requests/${requestId}/complete`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({
            result: {
              requiresWorker: false,
              intent: plan.intent,
              lane: "deterministic",
              priority,
              queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
            },
          }),
        }).catch(() => {});
        return;
      }

      await this.comm.assistantMessage("Understood. I am delegating this to a WorkerPal now.", {
        turnId,
        correlationId: requestId,
      });

      const taskId = randomUUID();
      const targetWorkerId = await this.selectTargetWorkerForJob();
      const executionBudgetMs = this.executionBudgetForPriority(priority);
      const params: TaskExecuteJobParams = {
        schemaVersion: 2,
        requestId,
        sessionId: this.sessionId,
        instruction: plan.worker_instruction || prompt,
        lane,
        planning: {
          intent: plan.intent,
          riskLevel: plan.risk_level,
          targetPaths: plan.target_paths,
          validationSteps: plan.validation_steps,
          queuePriority: priority,
          queueWaitBudgetMs,
          executionBudgetMs,
          finalizationBudgetMs: this.finalizationBudgetMs,
        },
        targetPath,
        recentContext: this.recentContext.slice(-RemoteBuddyOrchestrator.MAX_CONTEXT),
        recentJobs: this.getRecentJobContext(),
      };

      await this.sendCommand({
        type: "task_created",
        payload: {
          taskId,
          title: `Execute request: ${toSingleLine(prompt, 64) || "user request"}`,
          description:
            lane === "deterministic"
              ? "Deterministic execution lane (fast path)"
              : "Agentic OpenHands execution lane",
          createdBy: `agent:${this.agentId}`,
          priority,
        },
        turnId,
      });
      await this.sendCommand({ type: "task_started", payload: { taskId }, turnId });
      await this.sendCommand({
        type: "task_progress",
        payload: {
          taskId,
          message: targetWorkerId
            ? `Assigned to WorkerPal ${targetWorkerId} (${lane} lane)`
            : "No idle WorkerPal available; queued for first available WorkerPal",
        },
        turnId,
      });

      await this.comm.assistantMessage(
        targetWorkerId
          ? `Assigned this request to WorkerPal ${targetWorkerId} (${lane} lane).`
          : "No idle WorkerPal right now; request is queued and waiting for the next available WorkerPal.",
        { turnId, correlationId: requestId },
      );

      const jobId = await this.enqueueJob(taskId, "task.execute", params, targetWorkerId);
      if (jobId) {
        await this.sendCommand({
          type: "job_enqueued",
          payload: { jobId, taskId, kind: "task.execute", params },
          turnId,
        });
      }

      await fetch(`${this.server}/requests/${requestId}/complete`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          result: {
            requiresWorker: true,
            intent: plan.intent,
            lane,
            priority,
            riskLevel: plan.risk_level,
            queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
            executionBudgetMs,
            finalizationBudgetMs: this.finalizationBudgetMs,
            targetPaths: plan.target_paths,
            validationSteps: plan.validation_steps,
          },
        }),
      }).catch(() => {});
    } catch (err) {
      const message = `RemoteBuddy planning failed: ${toSingleLine(err, 220) || "unknown error"}`;
      console.error(`[RemoteBuddy] ${message}`);
      await this.comm.assistantMessage(message, { turnId, correlationId: requestId });
      await fetch(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          message: "RemoteBuddy planning failed",
          detail: String(err),
        }),
      }).catch(() => {});
    }
  }

  /** Start polling the Request Queue */
  async startPolling(pollMs: number = 2000): Promise<void> {
    console.log(`[RemoteBuddy] Starting polling loop (every ${pollMs}ms)`);

    while (!this.disposed) {
      try {
        const res = await fetch(`${this.server}/requests/claim`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ agentId: this.agentId }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            ok: boolean;
            request?: {
              id: string;
              prompt: string;
              priority?: string;
              queueWaitBudgetMs?: number;
            };
            queueWaitMs?: number;
          };

          if (data.ok && data.request) {
            console.log(`[RemoteBuddy] Claimed request ${data.request.id}`);
            // Serialize processing
            this.chain = this.chain
              .then(() => this.processRequest(data.request!, Number(data.queueWaitMs ?? 0)))
              .catch((err) => console.error("[RemoteBuddy] Process error:", err));
          }
        }
      } catch (err) {
        console.error(`[RemoteBuddy] Poll error:`, err);
      }

      await Bun.sleep(pollMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.statusHeartbeatTimer) {
      clearInterval(this.statusHeartbeatTimer);
      this.statusHeartbeatTimer = null;
    }
    void this.comm.status(this.agentId, "shutting_down", "RemoteBuddy shutting down");
    if (this.stopSessionEvents) {
      try {
        this.stopSessionEvents();
      } catch {
        // ignore unsubscribe errors on shutdown
      }
      this.stopSessionEvents = null;
    }
    for (const [workerId, proc] of this.managedWorkers.entries()) {
      try {
        proc.kill();
      } catch {
        // ignore process kill failures during shutdown
      }
      this.managedWorkers.delete(workerId);
    }
    if (this.jobsDb) {
      try {
        this.jobsDb.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.jobsDb = null;
    }
  }
}

// ─── Bootstrap: connect with retry ──────────────────────────────────────────

async function connectWithRetry(
  server: string,
  sessionId?: string,
  maxRetries = Infinity,
  baseDelay = 2000,
  maxDelay = 30000,
): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(
        `[RemoteBuddy] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log("[RemoteBuddy] PushPals RemoteBuddy Orchestrator");
  console.log(`[RemoteBuddy] Server: ${opts.server}`);

  // ── Initialise LLM + brain ──
  let brain: AgentBrain;

  // ── Initialise idempotency store ──
  const dataDir = CONFIG.paths.dataDir;
  mkdirSync(dataDir, { recursive: true });
  const sharedDbPath = CONFIG.paths.sharedDbPath;
  const dbPath = CONFIG.paths.remotebuddyDbPath;
  const idempotency = new IdempotencyStore(dbPath);
  console.log(`[RemoteBuddy] Idempotency store: ${dbPath}`);

  let sessionId = opts.sessionId;
  console.log(`[RemoteBuddy] Ensuring session "${sessionId}" exists on server...`);
  sessionId = await connectWithRetry(opts.server, sessionId ?? undefined);
  console.log(`[RemoteBuddy] Using session: ${sessionId}`);

  const llmCfg = CONFIG.remotebuddy.llm;
  const llm = createLLMClient({
    service: "remotebuddy",
    sessionId,
    backend: llmCfg.backend,
    endpoint: llmCfg.endpoint,
    model: llmCfg.model,
    apiKey: llmCfg.apiKey,
  });
  brain = new AgentBrain(llm);

  const orchestrator = new RemoteBuddyOrchestrator({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
    brain,
    idempotency,
    jobsDbPath: sharedDbPath,
  });

  await orchestrator.emitStartupStatus();
  orchestrator.startStatusHeartbeat();
  orchestrator.startSessionEventMonitor();

  // Start polling for requests from the Request Queue
  const pollMs = CONFIG.remotebuddy.pollMs;
  orchestrator.startPolling(pollMs);
}

main().catch((err) => {
  console.error("[RemoteBuddy] Fatal:", err);
  process.exit(1);
});
