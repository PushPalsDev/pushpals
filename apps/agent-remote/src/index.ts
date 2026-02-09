#!/usr/bin/env bun
/**
 * PushPals Remote Orchestrator
 *
 * Lightweight orchestrator (no DB) that maintains in-memory task/job state
 * and uses cursor replay for reconnects. Listens for user `message` events,
 * creates tasks, enqueues jobs (`bun.test`, `bun.lint`) for workers, and
 * closes out tasks when job results arrive.
 *
 * Usage:
 *   bun run src/index.ts --server http://localhost:3001 [--sessionId <id>] [--token <auth>]
 */

import type { EventEnvelope, CommandRequest } from "protocol";
import { randomUUID } from "crypto";

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  sessionId: string | null;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let sessionId: string | null = null;
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

// ─── Job-kind descriptor ────────────────────────────────────────────────────

interface JobSpec {
  kind: string;
  params: Record<string, unknown>;
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

  constructor(opts: { server: string; sessionId: string; authToken: string | null }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
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

  // ── Keyword parser ────────────────────────────────────────────────────

  private parseJobSpecs(text: string): JobSpec[] {
    const lower = text.toLowerCase();
    const specs: JobSpec[] = [];

    if (lower.includes("test") || lower.includes("spec")) {
      specs.push({ kind: "bun.test", params: {} });
    }
    if (lower.includes("lint") || lower.includes("format") || lower.includes("check")) {
      specs.push({ kind: "bun.lint", params: {} });
    }

    return specs;
  }

  // ── Event handlers ────────────────────────────────────────────────────

  /** React to a user message: create task, enqueue jobs */
  private async handleMessage(envelope: EventEnvelope): Promise<void> {
    const { text } = envelope.payload as { text: string };
    const turnId = envelope.turnId ?? randomUUID();

    const specs = this.parseJobSpecs(text);

    if (specs.length === 0) {
      await this.sendCommand({
        type: "assistant_message",
        payload: {
          text: `I didn't recognise a command in "${text}". Try "run tests" or "lint the code".`,
        },
        turnId,
      });
      return;
    }

    // 1. Acknowledge
    await this.sendCommand({
      type: "assistant_message",
      payload: { text: `Got it — planning ${specs.map((s) => s.kind).join(", ")}...` },
      turnId,
    });

    // 2. Create task
    const taskId = randomUUID();
    await this.sendCommand({
      type: "task_created",
      payload: {
        taskId,
        title: text.length > 80 ? text.substring(0, 80) + "..." : text,
        description: text,
        createdBy: `agent:${this.agentId}`,
      },
      turnId,
    });

    // 3. Mark running
    await this.sendCommand({
      type: "task_started",
      payload: { taskId },
      turnId,
    });

    // 4. Enqueue jobs — use server-returned jobId for tracking
    const jobIds = new Set<string>();

    for (const spec of specs) {
      const jobId = await this.enqueueJob(taskId, spec.kind, spec.params);
      if (!jobId) {
        console.error(`[Orchestrator] Failed to enqueue ${spec.kind}, skipping`);
        continue;
      }

      jobIds.add(jobId);
      this.jobToTask.set(jobId, taskId);

      await this.sendCommand({
        type: "job_enqueued",
        payload: { jobId, taskId, kind: spec.kind, params: spec.params },
        turnId,
      });
    }

    if (jobIds.size === 0) {
      await this.sendCommand({
        type: "task_failed",
        payload: { taskId, message: "All job enqueues failed" },
        turnId,
      });
      return;
    }

    this.taskJobs.set(taskId, jobIds);
    console.log(
      `[Orchestrator] Task ${taskId}: enqueued ${jobIds.size} job(s) — ${specs.map((s) => s.kind).join(", ")}`,
    );
  }

  /** A job finished successfully */
  private async handleJobCompleted(envelope: EventEnvelope): Promise<void> {
    const { jobId, summary } = envelope.payload as { jobId: string; summary?: string };
    const taskId = this.jobToTask.get(jobId);
    if (!taskId) return; // not our job

    this.jobToTask.delete(jobId);
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

    // All jobs for this task are done
    this.taskJobs.delete(taskId);
    await this.sendCommand({
      type: "task_completed",
      payload: {
        taskId,
        summary: summary ?? "All jobs completed successfully.",
      },
    });
    console.log(`[Orchestrator] Task ${taskId} completed.`);
  }

  /** A job failed */
  private async handleJobFailed(envelope: EventEnvelope): Promise<void> {
    const { jobId, message: errMsg } = envelope.payload as {
      jobId: string;
      message: string;
    };
    const taskId = this.jobToTask.get(jobId);
    if (!taskId) return;

    // Clean up all remaining jobs for this task
    const pending = this.taskJobs.get(taskId);
    if (pending) {
      for (const jid of pending) this.jobToTask.delete(jid);
      this.taskJobs.delete(taskId);
    }

    await this.sendCommand({
      type: "task_failed",
      payload: {
        taskId,
        message: errMsg ?? `Job ${jobId} failed`,
      },
    });
    console.log(`[Orchestrator] Task ${taskId} failed (job ${jobId}).`);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async onEvent(envelope: EventEnvelope): Promise<void> {
    // Ignore own events to avoid loops
    if (envelope.from === `agent:${this.agentId}`) return;

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
          .then(() => this.onEvent(data.envelope))
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
  maxRetries = Infinity,
  baseDelay = 2000,
  maxDelay = 30000,
): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${server}/sessions`, { method: "POST" });
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

  let sessionId = opts.sessionId;
  if (!sessionId) {
    console.log("[Orchestrator] No sessionId provided — creating new session...");
    sessionId = await connectWithRetry(opts.server);
    console.log(`[Orchestrator] Created session: ${sessionId}`);
  }

  const orchestrator = new RemoteOrchestrator({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
  });

  orchestrator.connect();
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal:", err);
  process.exit(1);
});
