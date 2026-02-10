#!/usr/bin/env bun
/**
 * PushPals Remote Orchestrator
 *
 * AI-powered orchestrator that:
 *   1) Listens for user `message` events via cursor-based WS stream
 *   2) Runs them through an LLM brain (OpenAI / Anthropic / Ollama)
 *   3) Emits assistant_message and optionally creates tasks + enqueues jobs
 *   4) Tracks job lifecycle and closes out tasks when all jobs complete
 *
 * Replay-safe: uses IdempotencyStore to avoid re-processing messages on reconnect.
 *
 * Usage:
 *   bun run src/index.ts --server http://localhost:3001 [--sessionId <id>] [--token <auth>]
 *   Environment: OPENAI_API_KEY | ANTHROPIC_API_KEY | LLM_ENDPOINT (see llm.ts)
 */

import type { EventEnvelope, CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { createLLMClient } from "./llm.js";
import { AgentBrain } from "./brain.js";
import { IdempotencyStore } from "./idempotency.js";
import { resolve, join } from "path";
import { mkdirSync } from "fs";

// ─── Job result formatting ──────────────────────────────────────────────────

/**
 * Produce a structured result string from a job's raw output.
 * Returns a one-line summary header followed by `\n---\n` and the full output.
 * The client splits on the `---` separator to power "Show more".
 */
function formatJobResult(kind: string, output: string, ok: boolean): string {
  const trimmed = output.trim();
  if (!ok) return `**${kind}** — failed\n---\n${trimmed}`;
  if (!trimmed) return `**${kind}** — completed (no output)`;

  const lines = trimmed.split("\n");

  let summaryLine: string;
  switch (kind) {
    case "git.status": {
      const modified = lines.filter((l) => /^\s*M\s/.test(l)).length;
      const untracked = lines.filter((l) => /^\s*\?\?/.test(l)).length;
      const added = lines.filter((l) => /^\s*A\s/.test(l)).length;
      const parts: string[] = [];
      if (modified) parts.push(`${modified} modified`);
      if (added) parts.push(`${added} added`);
      if (untracked) parts.push(`${untracked} untracked`);
      summaryLine = parts.length ? parts.join(", ") : `${lines.length} entries`;
      break;
    }
    case "git.diff": {
      const statLine = lines.find((l) => /files? changed/.test(l));
      summaryLine = statLine?.trim() ?? `${lines.length} lines of diff`;
      break;
    }
    case "git.log":
      summaryLine = `${lines.filter((l) => l.trim().length > 0).length} log lines`;
      break;
    case "git.branch": {
      const branches = lines.filter((l) => l.trim().length > 0);
      const current = branches
        .find((l) => l.startsWith("*"))
        ?.replace(/^\*\s*/, "")
        .trim();
      summaryLine = `${branches.length} branch(es)${current ? ` — current: ${current}` : ""}`;
      break;
    }
    case "bun.test": {
      // Last non-empty line often has pass/fail summary
      const last = lines.filter((l) => l.trim()).pop();
      summaryLine = last ?? "tests complete";
      break;
    }
    case "bun.lint": {
      const issueCount = lines.filter((l) => l.trim().length > 0).length;
      summaryLine = issueCount <= 1 ? "No lint issues" : `${issueCount} lines of output`;
      break;
    }
    case "file.list":
      summaryLine = `${lines.length} entries`;
      break;
    case "file.read":
      summaryLine = `${lines.length} lines`;
      break;
    case "ci.status":
      summaryLine = lines[0] ?? "CI status retrieved";
      break;
    case "project.summary":
      summaryLine = "Project overview";
      break;
    case "shell.exec":
      summaryLine = `${lines.length} lines of output`;
      break;
    case "file.write":
      summaryLine = lines[0] ?? "File written";
      break;
    case "file.patch":
      summaryLine = lines[0] ?? "File patched";
      break;
    case "file.rename":
      summaryLine = lines[0] ?? "File renamed";
      break;
    case "file.delete":
      summaryLine = lines[0] ?? "File deleted";
      break;
    case "file.copy":
      summaryLine = lines[0] ?? "File copied";
      break;
    case "file.append":
      summaryLine = lines[0] ?? "Text appended";
      break;
    case "file.mkdir":
      summaryLine = lines[0] ?? "Directory created";
      break;
    case "web.fetch":
      summaryLine = `Fetched (${trimmed.length} chars)`;
      break;
    case "web.search": {
      const resultCount = lines.filter((l) => /^\d+\./.test(l.trim())).length;
      summaryLine = resultCount > 0 ? `${resultCount} results` : "Search complete";
      break;
    }
    default:
      summaryLine = `${kind} completed`;
      break;
  }

  return `**${kind}** — ${summaryLine}\n---\n${trimmed}`;
}

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  sessionId: string | null;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let sessionId: string | null = process.env.PUSHPALS_SESSION_ID ?? "dev";
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;

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

// ─── Remote Orchestrator ────────────────────────────────────────────────────

class RemoteOrchestrator {
  private readonly agentId = "remote-orchestrator";
  private readonly server: string;
  private readonly sessionId: string;
  private readonly authToken: string | null;
  private ws: WebSocket | null = null;
  private disposed = false;

  /** Highest cursor seen — used for ?after= on reconnect */
  private lastCursor = 0;

  /** Serialises async event handling to preserve ordering */
  private chain: Promise<void> = Promise.resolve();

  /** taskId → set of pending jobIds */
  private taskJobs = new Map<string, Set<string>>();
  /** jobId → taskId */
  private jobToTask = new Map<string, string>();
  /** taskId → turnId (for sending assistant_message on completion) */
  private taskTurnId = new Map<string, string>();
  /** taskId → collected job results */
  private taskResults = new Map<string, Array<{ kind: string; ok: boolean; output: string }>>();
  /** jobId → job kind */
  private jobKind = new Map<string, string>();

  /** AI brain — produces assistant messages + optional action plans */
  private brain: AgentBrain;
  /** Durable idempotency store — prevents replay-induced duplicates */
  private idempotency: IdempotencyStore;
  /** Recent session context for LLM (bounded ring buffer) */
  private recentContext: string[] = [];
  private static readonly MAX_CONTEXT = 20;

  constructor(opts: {
    server: string;
    sessionId: string;
    authToken: string | null;
    brain: AgentBrain;
    idempotency: IdempotencyStore;
  }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.brain = opts.brain;
    this.idempotency = opts.idempotency;

    // Restore cursor from durable store
    this.lastCursor = this.idempotency.getLastCursor(this.sessionId);
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  /** Send a command event through the server */
  private async sendCommand(cmd: Omit<CommandRequest, "from">): Promise<void> {
    const body: CommandRequest = { ...cmd, from: `agent:${this.agentId}` };
    try {
      const res = await fetch(`${this.server}/sessions/${this.sessionId}/command`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[Orchestrator] Command ${cmd.type} failed: ${res.status} ${err}`);
      }
    } catch (err) {
      console.error(`[Orchestrator] Command ${cmd.type} error:`, err);
    }
  }

  /**
   * Enqueue a job via the server job queue.
   * Returns the server-assigned jobId on success, or null on failure.
   */
  private async enqueueJob(
    taskId: string,
    kind: string,
    params: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${this.server}/jobs/enqueue`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ taskId, sessionId: this.sessionId, kind, params }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[Orchestrator] Enqueue failed: ${res.status} ${err}`);
        return null;
      }
      const data = (await res.json()) as { ok: boolean; jobId?: string };
      if (!data.ok || !data.jobId) {
        console.error(`[Orchestrator] Enqueue response missing jobId:`, data);
        return null;
      }
      return data.jobId;
    } catch (err) {
      console.error(`[Orchestrator] Enqueue error:`, err);
      return null;
    }
  }

  // ── Context tracking ───────────────────────────────────────────────────

  private pushContext(text: string): void {
    this.recentContext.push(text);
    if (this.recentContext.length > RemoteOrchestrator.MAX_CONTEXT) {
      this.recentContext.shift();
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────

  /** React to a user message: call brain, emit response + optional tasks/jobs */
  private async handleMessage(envelope: EventEnvelope): Promise<void> {
    const eventId = envelope.id;

    // ── Idempotency check: skip already-processed messages ──
    if (this.idempotency.hasHandled(this.sessionId, eventId)) {
      console.log(`[Orchestrator] Skipping already-handled message ${eventId}`);
      return;
    }

    // ── Mark handled immediately — prefer lost work over duplicated jobs ──
    this.idempotency.markHandled(this.sessionId, eventId);

    const { text } = envelope.payload as { text: string };
    const turnId = envelope.turnId ?? randomUUID();

    this.pushContext(`[user] ${text}`);

    // ── Call the AI brain ──
    console.log(`[Orchestrator] Thinking about: "${text.substring(0, 80)}"`);
    const output = await this.brain.think(text, this.recentContext);

    // 1. Always emit assistant message
    await this.sendCommand({
      type: "assistant_message",
      payload: { text: output.assistantMessage },
      turnId,
    });
    this.pushContext(`[assistant] ${output.assistantMessage}`);

    // 2. If brain produced tasks, create them + enqueue their jobs
    if (output.tasks && output.tasks.length > 0) {
      for (const actionTask of output.tasks) {
        const taskId = actionTask.taskId || randomUUID();

        await this.sendCommand({
          type: "task_created",
          payload: {
            taskId,
            title: actionTask.title,
            description: actionTask.description,
            createdBy: `agent:${this.agentId}`,
          },
          turnId,
        });

        await this.sendCommand({
          type: "task_started",
          payload: { taskId },
          turnId,
        });

        // Enqueue each job
        const jobIds = new Set<string>();

        for (const jobSpec of actionTask.jobs) {
          const jobId = await this.enqueueJob(taskId, jobSpec.kind, jobSpec.params);
          if (!jobId) {
            console.error(`[Orchestrator] Failed to enqueue ${jobSpec.kind}, skipping`);
            continue;
          }

          jobIds.add(jobId);
          this.jobToTask.set(jobId, taskId);
          this.jobKind.set(jobId, jobSpec.kind);

          await this.sendCommand({
            type: "job_enqueued",
            payload: { jobId, taskId, kind: jobSpec.kind, params: jobSpec.params },
            turnId,
          });
        }

        if (jobIds.size === 0) {
          await this.sendCommand({
            type: "task_failed",
            payload: { taskId, message: "All job enqueues failed" },
            turnId,
          });
        } else {
          this.taskJobs.set(taskId, jobIds);
          this.taskTurnId.set(taskId, turnId);
          this.taskResults.set(taskId, []);
          console.log(
            `[Orchestrator] Task ${taskId}: enqueued ${jobIds.size} job(s) — ${actionTask.jobs.map((j) => j.kind).join(", ")}`,
          );
        }
      }
    }

    console.log(`[Orchestrator] Handled message ${eventId}`);
  }

  /** A job finished successfully */
  private async handleJobCompleted(envelope: EventEnvelope): Promise<void> {
    const { jobId, summary, artifacts } = envelope.payload as {
      jobId: string;
      summary?: string;
      artifacts?: Array<{ kind: string; text?: string }>;
    };
    const taskId = this.jobToTask.get(jobId);
    if (!taskId) return; // not our job

    const kind = this.jobKind.get(jobId) ?? "unknown";
    this.jobToTask.delete(jobId);
    this.jobKind.delete(jobId);

    // Collect result output — format with summary header
    const rawOutput = artifacts?.find((a) => a.kind === "log")?.text ?? summary ?? "";
    const formatted = formatJobResult(kind, rawOutput, true);
    this.taskResults.get(taskId)?.push({ kind, ok: true, output: formatted });

    const pending = this.taskJobs.get(taskId);
    if (!pending) return;

    pending.delete(jobId);

    // Progress update if more jobs remain
    if (pending.size > 0) {
      await this.sendCommand({
        type: "task_progress",
        payload: {
          taskId,
          message: `Job ${jobId} done. ${pending.size} job(s) remaining.`,
        },
      });
      return;
    }

    // All jobs for this task are done — send results back to user
    this.taskJobs.delete(taskId);
    const turnId = this.taskTurnId.get(taskId);
    this.taskTurnId.delete(taskId);
    const results = this.taskResults.get(taskId) ?? [];
    this.taskResults.delete(taskId);

    await this.sendCommand({
      type: "task_completed",
      payload: {
        taskId,
        summary: summary ?? "All jobs completed successfully.",
      },
    });

    // Compose an assistant_message with the collected formatted output
    const resultText = results
      .map((r) => r.output.trim() || `**${r.kind}** — (no output)`)
      .join("\n\n");

    const msg = resultText || "Tasks completed with no output.";
    await this.sendCommand({
      type: "assistant_message",
      payload: { text: msg },
      turnId,
    });
    this.pushContext(`[assistant] ${msg}`);

    console.log(`[Orchestrator] Task ${taskId} completed — results sent to user.`);
  }

  /** A job failed */
  private async handleJobFailed(envelope: EventEnvelope): Promise<void> {
    const {
      jobId,
      message: errMsg,
      detail,
    } = envelope.payload as {
      jobId: string;
      message: string;
      detail?: string;
    };
    const taskId = this.jobToTask.get(jobId);
    if (!taskId) return;

    const kind = this.jobKind.get(jobId) ?? "unknown";
    const turnId = this.taskTurnId.get(taskId);

    // Clean up all remaining jobs for this task
    const pending = this.taskJobs.get(taskId);
    if (pending) {
      for (const jid of pending) {
        this.jobToTask.delete(jid);
        this.jobKind.delete(jid);
      }
      this.taskJobs.delete(taskId);
    }
    this.taskTurnId.delete(taskId);
    this.taskResults.delete(taskId);

    await this.sendCommand({
      type: "task_failed",
      payload: {
        taskId,
        message: errMsg ?? `Job ${jobId} failed`,
      },
    });

    // Send failure as assistant_message so the user sees it
    const failMsg = formatJobResult(kind, `${errMsg}${detail ? `\n${detail}` : ""}`, false);
    await this.sendCommand({
      type: "assistant_message",
      payload: { text: failMsg },
      turnId,
    });
    this.pushContext(`[assistant] ${failMsg}`);

    console.log(`[Orchestrator] Task ${taskId} failed (job ${jobId}).`);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async onEvent(envelope: EventEnvelope, cursor: number): Promise<void> {
    // Ignore own events to avoid loops
    if (envelope.from === `agent:${this.agentId}`) return;

    // Persist cursor (max-wins) — in-memory + durable store
    this.lastCursor = Math.max(this.lastCursor, cursor);
    this.idempotency.updateCursor(this.sessionId, cursor);

    switch (envelope.type) {
      case "message":
        // Only react to messages originating from a client
        if (envelope.from === "client") {
          await this.handleMessage(envelope);
        }
        break;
      case "job_completed":
        await this.handleJobCompleted(envelope);
        break;
      case "job_failed":
        await this.handleJobFailed(envelope);
        break;
    }
  }

  // ── WebSocket connection ──────────────────────────────────────────────

  connect(): void {
    if (this.disposed) return;

    const protocol = this.server.startsWith("https") ? "wss" : "ws";
    const host = this.server.replace(/^https?:\/\//, "");
    const wsUrl = `${protocol}://${host}/sessions/${this.sessionId}/ws?after=${this.lastCursor}`;

    console.log(`[Orchestrator] Connecting to ${wsUrl} (cursor=${this.lastCursor})`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[Orchestrator] Connected — session ${this.sessionId}`);
      this.sendCommand({
        type: "agent_status",
        payload: { agentId: this.agentId, status: "idle", message: "Orchestrator online" },
      });
    };

    this.ws.onmessage = (event) => {
      try {
        // Server sends { envelope, cursor } per PR1 wire format
        const data = JSON.parse(event.data as string) as {
          envelope: EventEnvelope;
          cursor: number;
        };
        this.lastCursor = Math.max(this.lastCursor, data.cursor);
        // Serialise handling to preserve event ordering
        this.chain = this.chain
          .then(() => this.onEvent(data.envelope, data.cursor))
          .catch((err) => console.error("[Orchestrator] Handler error:", err));
      } catch (err) {
        console.error("[Orchestrator] Failed to parse WS message:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.disposed) return;
      console.log("[Orchestrator] WS closed, reconnecting in 3 s...");
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error("[Orchestrator] WS error:", err);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_e) {}
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
        `[Orchestrator] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log("[Orchestrator] PushPals Remote Orchestrator");
  console.log(`[Orchestrator] Server: ${opts.server}`);

  // ── Initialise LLM + brain ──
  const llm = createLLMClient();
  const brain = new AgentBrain(llm, { actionsEnabled: true });

  // ── Initialise idempotency store ──
  const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
  const dataDir = process.env.PUSHPALS_DATA_DIR ?? join(PROJECT_ROOT, "outputs", "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.AGENT_REMOTE_DB_PATH ?? join(dataDir, "agent-remote-state.db");
  const idempotency = new IdempotencyStore(dbPath);
  console.log(`[Orchestrator] Idempotency store: ${dbPath}`);

  let sessionId = opts.sessionId;
  console.log(`[Orchestrator] Ensuring session "${sessionId}" exists on server...`);
  sessionId = await connectWithRetry(opts.server, sessionId ?? undefined);
  console.log(`[Orchestrator] Using session: ${sessionId}`);

  const orchestrator = new RemoteOrchestrator({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
    brain,
    idempotency,
  });

  orchestrator.connect();
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal:", err);
  process.exit(1);
});
