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

import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { createLLMClient } from "./llm.js";
import { AgentBrain } from "./brain.js";
import { IdempotencyStore } from "./idempotency.js";
import { detectRepoRoot } from "shared";
import { resolve, join } from "path";
import { mkdirSync } from "fs";

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
  private readonly repo: string;
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

    // Detect repo root from current working directory
    this.repo = detectRepoRoot(process.cwd());
    console.log(`[Orchestrator] Detected repo root: ${this.repo}`);
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

  // In this architecture, Remote Agent only creates tasks/jobs via polling
  // Job completion tracking is no longer part of Remote Agent responsibility
  // ── Dispatch, Polling for Request Queue ────────────────────────────────────────

  /** Process a request from the Request Queue (replaces handleMessage) */
  private async processRequest(request: any): Promise<void> {
    const requestId = request.id;

    // Idempotency check
    if (this.idempotency.hasHandled(this.sessionId, requestId)) {
      console.log(`[Orchestrator] Skipping already-handled request ${requestId}`);
      return;
    }

    this.idempotency.markHandled(this.sessionId, requestId);

    const enhancedPrompt = request.enhancedPrompt;
    const turnId = randomUUID();

    this.pushContext(`[user] ${request.originalPrompt}`);
    this.pushContext(`[enhanced] ${enhancedPrompt}`);

    // Call brain with enhanced prompt
    console.log(`[Orchestrator] Thinking about: "${enhancedPrompt.substring(0, 80)}"`);
    const output = await this.brain.think(enhancedPrompt, this.recentContext);

    this.pushContext(`[assistant] ${output.assistantMessage}`);

    // Emit assistant message
    await this.sendCommand({
      type: "assistant_message",
      payload: { text: output.assistantMessage },
      turnId,
    });

    // Create tasks and enqueue jobs if actions are present
    if (output.tasks && output.tasks.length > 0) {
      for (const task of output.tasks) {
        const taskId = randomUUID();

        await this.sendCommand({
          type: "task_created",
          payload: {
            taskId,
            title: task.title,
            description: task.description,
            createdBy: `agent:${this.agentId}`,
          },
          turnId,
        });

        await this.sendCommand({
          type: "task_started",
          payload: { taskId },
          turnId,
        });

        // Enqueue jobs for this task
        for (const job of task.jobs) {
          const jobId = await this.enqueueJob(taskId, job.kind, job.params ?? {});
          if (jobId) {
            await this.sendCommand({
              type: "job_enqueued",
              payload: { jobId, taskId, kind: job.kind, params: job.params ?? {} },
              turnId,
            });
          }
        }
      }
    }

    // Mark request complete
    try {
      await fetch(`${this.server}/requests/${requestId}/complete`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ result: { tasksCreated: output.tasks?.length ?? 0 } }),
      });
    } catch (err) {
      console.error(`[Orchestrator] Failed to mark request complete:`, err);
    }
  }

  /** Start polling the Request Queue */
  async startPolling(pollMs: number = 2000): Promise<void> {
    console.log(`[Orchestrator] Starting polling loop (every ${pollMs}ms)`);

    while (!this.disposed) {
      try {
        const res = await fetch(`${this.server}/requests/claim`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ agentId: this.agentId }),
        });

        if (res.ok) {
          const data = (await res.json()) as { ok: boolean; request?: any };

          if (data.ok && data.request) {
            console.log(`[Orchestrator] Claimed request ${data.request.id}`);
            // Serialize processing
            this.chain = this.chain
              .then(() => this.processRequest(data.request))
              .catch((err) => console.error("[Orchestrator] Process error:", err));
          }
        }
      } catch (err) {
        console.error(`[Orchestrator] Poll error:`, err);
      }

      await Bun.sleep(pollMs);
    }
  }

  dispose(): void {
    this.disposed = true;
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

  // Start polling for requests from the Request Queue
  const pollMs = parseInt(process.env.REMOTE_AGENT_POLL_MS ?? "2000", 10);
  orchestrator.startPolling(pollMs);
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal:", err);
  process.exit(1);
});
