#!/usr/bin/env bun
/**
 * PushPals Local Agent Daemon
 *
 * Usage:
 *   bun run agent-local --server http://localhost:3001 [--sessionId <id>] [--repo <path>] [--planner local|remote]
 *
 * Connects to the PushPals server via WebSocket, listens for user messages /
 * task events, plans work via the planner, executes tools, and emits lifecycle
 * events back through the protocol.
 */

import { EventEnvelope, PROTOCOL_VERSION } from "protocol";
import type { EventType, CommandRequest } from "protocol";
import { randomUUID } from "crypto";
import { ToolRegistry, type ToolOutput } from "./tools.js";
import {
  LocalHeuristicPlanner,
  RemotePlanner,
  type PlannerModel,
  type PlannerTask,
} from "./planner.js";

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  sessionId: string | null;
  repo: string;
  planner: "local" | "remote";
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let sessionId: string | null = process.env.PUSHPALS_SESSION_ID ?? "dev";
  let repo = process.cwd();
  let planner: "local" | "remote" = "local";
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--repo":
        repo = args[++i];
        break;
      case "--planner":
        planner = args[++i] as "local" | "remote";
        break;
      case "--token":
        authToken = args[++i];
        break;
    }
  }

  return { server, sessionId, repo, planner, authToken };
}

// ─── Agent class ────────────────────────────────────────────────────────────

class LocalAgent {
  private agentId = "local1";
  private server: string;
  private sessionId: string;
  private repo: string;
  private authToken: string | null;
  private tools: ToolRegistry;
  private planner: PlannerModel;
  private ws: WebSocket | null = null;
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  /** Highest cursor seen — for ?after= reconnect */
  private lastCursor = 0;
  /** Serialise event handling for ordering */
  private chain: Promise<void> = Promise.resolve();
  /** Periodic repo awareness timer */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Last snapshot of git status for change-detection */
  private lastStatusSnapshot = "";

  constructor(opts: {
    server: string;
    sessionId: string;
    repo: string;
    planner: PlannerModel;
    authToken: string | null;
  }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.repo = opts.repo;
    this.planner = opts.planner;
    this.authToken = opts.authToken;
    this.tools = new ToolRegistry();
  }

  // ── Send a command to the server via HTTP ──────────────────────────────

  private async sendCommand(cmd: Omit<CommandRequest, "from">): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;

    const body: CommandRequest = {
      ...cmd,
      from: `agent:${this.agentId}`,
    };

    try {
      const res = await fetch(`${this.server}/sessions/${this.sessionId}/command`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[Agent] Command failed: ${res.status} ${err}`);
      }
    } catch (err) {
      console.error(`[Agent] Command error:`, err);
    }
  }

  // ── Convenience emitters ───────────────────────────────────────────────

  private async emitAgentStatus(status: "idle" | "busy" | "error", message?: string) {
    await this.sendCommand({
      type: "agent_status",
      payload: { agentId: this.agentId, status, message },
    });
  }

  private async emitTaskCreated(task: PlannerTask, turnId?: string): Promise<string> {
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
    return taskId;
  }

  private async emitTaskStarted(taskId: string, turnId?: string) {
    await this.sendCommand({ type: "task_started", payload: { taskId }, turnId });
  }

  private async emitTaskProgress(taskId: string, message: string, percent?: number) {
    await this.sendCommand({
      type: "task_progress",
      payload: { taskId, message, ...(percent !== undefined ? { percent } : {}) },
    });
  }

  private async emitTaskCompleted(taskId: string, summary: string, artifacts?: any[]) {
    await this.sendCommand({
      type: "task_completed",
      payload: { taskId, summary, ...(artifacts ? { artifacts } : {}) },
    });
  }

  private async emitTaskFailed(taskId: string, message: string, detail?: string) {
    await this.sendCommand({
      type: "task_failed",
      payload: { taskId, message, ...(detail ? { detail } : {}) },
    });
  }

  private async emitToolCall(
    toolCallId: string,
    tool: string,
    args: Record<string, unknown>,
    taskId?: string,
    requiresApproval?: boolean,
  ) {
    await this.sendCommand({
      type: "tool_call",
      payload: {
        toolCallId,
        tool,
        args,
        ...(taskId ? { taskId } : {}),
        ...(requiresApproval ? { requiresApproval } : {}),
      },
    });
  }

  private async emitToolResult(toolCallId: string, output: ToolOutput, taskId?: string) {
    await this.sendCommand({
      type: "tool_result",
      payload: {
        toolCallId,
        ok: output.ok,
        ...(taskId ? { taskId } : {}),
        ...(output.stdout ? { stdout: output.stdout } : {}),
        ...(output.stderr ? { stderr: output.stderr } : {}),
        ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
        ...(output.artifacts ? { artifacts: output.artifacts } : {}),
      },
    });
  }

  private async emitJobEnqueued(
    jobId: string,
    taskId: string,
    kind: string,
    params: Record<string, unknown>,
  ) {
    await this.sendCommand({
      type: "job_enqueued",
      payload: { jobId, taskId, kind, params },
    });
  }

  // ── Execute a single tool (with approval gating) ──────────────────────

  private async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    taskId: string,
  ): Promise<ToolOutput> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { ok: false, stderr: `Unknown tool: ${toolName}`, exitCode: 127 };
    }

    const toolCallId = randomUUID();

    // Heavy tools → enqueue to worker queue instead of running locally
    if (this.tools.isHeavy(toolName)) {
      const jobId = randomUUID();
      await this.emitToolCall(toolCallId, toolName, args, taskId, false);
      await this.emitJobEnqueued(jobId, taskId, toolName, args);
      // Return a placeholder — the worker will emit the real result
      return { ok: true, stdout: `Job ${jobId} enqueued for ${toolName}` };
    }

    // Approval gating
    if (tool.requiresApproval) {
      await this.emitToolCall(toolCallId, toolName, args, taskId, true);

      const approved = await this.waitForApproval(toolCallId);
      if (!approved) {
        const output: ToolOutput = { ok: false, stderr: "Denied by user", exitCode: 1 };
        await this.emitToolResult(toolCallId, output, taskId);
        return output;
      }
    } else {
      await this.emitToolCall(toolCallId, toolName, args, taskId, false);
    }

    // Execute
    try {
      const output = await tool.execute(args, { repoRoot: this.repo });
      await this.emitToolResult(toolCallId, output, taskId);
      return output;
    } catch (err) {
      const output: ToolOutput = { ok: false, stderr: String(err), exitCode: 1 };
      await this.emitToolResult(toolCallId, output, taskId);
      return output;
    }
  }

  // ── Approval wait ─────────────────────────────────────────────────────

  private waitForApproval(toolCallId: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Store resolver; onEvent will call it when approved/denied arrives
      this.pendingApprovals.set(toolCallId, resolve);

      // Timeout after 5 minutes
      setTimeout(
        () => {
          if (this.pendingApprovals.has(toolCallId)) {
            this.pendingApprovals.delete(toolCallId);
            resolve(false);
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  // ── Handle an incoming event ──────────────────────────────────────────

  private async onEvent(envelope: EventEnvelope): Promise<void> {
    // Ignore events from ourselves to avoid loops
    if (envelope.from === `agent:${this.agentId}`) return;

    switch (envelope.type) {
      case "task_created": {
        const payload = envelope.payload as any;
        // Only act on tasks created by the client (user messages).
        // Remote agent tasks already have jobs enqueued for the worker —
        // remote→local delegation uses delegate_request instead.
        if (payload.createdBy !== "client") return;
        await this.handleNewTask(payload, envelope.turnId);
        break;
      }

      case "delegate_request": {
        // Remote agent explicitly delegates work to us
        const payload = envelope.payload as any;
        await this.handleDelegateRequest(payload, envelope);
        break;
      }

      case "approved": {
        const { approvalId } = envelope.payload as any;
        const resolver = this.pendingApprovals.get(approvalId);
        if (resolver) {
          this.pendingApprovals.delete(approvalId);
          resolver(true);
        }
        break;
      }

      case "denied": {
        const { approvalId } = envelope.payload as any;
        const resolver = this.pendingApprovals.get(approvalId);
        if (resolver) {
          this.pendingApprovals.delete(approvalId);
          resolver(false);
        }
        break;
      }
    }
  }

  // ── Main task handler ─────────────────────────────────────────────────

  private async handleNewTask(
    payload: { taskId: string; title: string; description: string },
    turnId?: string,
  ): Promise<void> {
    await this.emitAgentStatus("busy", `Processing: ${payload.title}`);

    try {
      // 1) Emit assistant_message to tell the user we're planning
      await this.sendCommand({
        type: "assistant_message",
        payload: { text: "Planning tasks…" },
        turnId,
      });

      // 2) Call planner
      const planOutput = await this.planner.plan({
        userText: payload.description,
        history: [],
      });

      // 3) Create tasks from planner output
      for (const task of planOutput.tasks) {
        const taskId = await this.emitTaskCreated(task, turnId);
        await this.emitTaskStarted(taskId, turnId);

        // Execute each tool the task needs
        const toolsNeeded = task.toolsNeeded ?? [];
        let allOk = true;

        for (let i = 0; i < toolsNeeded.length; i++) {
          const toolName = toolsNeeded[i];
          await this.emitTaskProgress(
            taskId,
            `Running ${toolName}…`,
            Math.round(((i + 1) / toolsNeeded.length) * 100),
          );

          const result = await this.executeTool(toolName, {}, taskId);
          if (!result.ok) {
            allOk = false;
            await this.emitTaskFailed(taskId, `Tool ${toolName} failed`, result.stderr);
            break;
          }
        }

        if (allOk) {
          await this.emitTaskCompleted(taskId, `Completed: ${task.title}`);
        }
      }
    } catch (err) {
      console.error(`[Agent] Error handling task:`, err);
      await this.emitAgentStatus("error", String(err));
      return;
    }

    await this.emitAgentStatus("idle");
  }

  // ── Delegate request handler ──────────────────────────────────────────

  /**
   * Handle an explicit delegate_request from the remote agent.
   * Executes the requested tool(s) directly and responds with delegate_response.
   */
  private async handleDelegateRequest(
    payload: {
      delegateId: string;
      tool?: string;
      tools?: string[];
      args?: Record<string, unknown>;
      description?: string;
    },
    envelope: EventEnvelope,
  ): Promise<void> {
    const { delegateId } = payload;
    const toolNames = payload.tools ?? (payload.tool ? [payload.tool] : []);

    if (toolNames.length === 0) {
      // No specific tools — try the planner
      console.log(`[Agent] Delegate ${delegateId}: no tools specified, using planner`);
      await this.handleNewTask(
        {
          taskId: delegateId,
          title: payload.description ?? "Delegated work",
          description: payload.description ?? "",
        },
        envelope.turnId,
      );
      return;
    }

    await this.emitAgentStatus("busy", `Delegate: ${toolNames.join(", ")}`);

    const results: Array<{ tool: string; ok: boolean; stdout?: string; stderr?: string }> = [];

    for (const toolName of toolNames) {
      const result = await this.executeTool(toolName, payload.args ?? {}, delegateId);
      results.push({ tool: toolName, ok: result.ok, stdout: result.stdout, stderr: result.stderr });
    }

    // Respond with delegate_response
    const allOk = results.every((r) => r.ok);
    await this.sendCommand({
      type: "delegate_response",
      payload: {
        delegateId,
        ok: allOk,
        results,
      },
      turnId: envelope.turnId,
    });

    await this.emitAgentStatus("idle");
  }

  // ── Periodic repo awareness ────────────────────────────────────────────

  /** Poll git status every interval and emit a summary if changes detected */
  startRepoHeartbeat(intervalMs = 30_000): void {
    if (this.heartbeatTimer) return; // already running

    console.log(`[Agent] Repo heartbeat every ${intervalMs / 1000}s`);

    const tick = async () => {
      try {
        const statusTool = this.tools.get("git.status");
        if (!statusTool) return;

        const statusResult = await statusTool.execute({}, { repoRoot: this.repo });
        const snapshot = statusResult.stdout?.trim() ?? "";

        // Only emit if something changed since last check
        if (snapshot === this.lastStatusSnapshot) return;
        this.lastStatusSnapshot = snapshot;

        // Compose a short awareness context
        const branchTool = this.tools.get("git.branch");
        let branch = "";
        if (branchTool) {
          const br = await branchTool.execute({}, { repoRoot: this.repo });
          // Extract current branch (line starting with *)
          const currentLine = br.stdout?.split("\n").find((l: string) => l.startsWith("*"));
          branch = currentLine?.replace(/^\*\s*/, "").trim() ?? "";
        }

        const lines = snapshot.split("\n").filter(Boolean);
        const summary =
          lines.length === 0
            ? "Working tree is clean"
            : `${lines.length} change(s) on ${branch || "unknown branch"}`;

        await this.emitAgentStatus("idle", `[heartbeat] ${summary}`);
      } catch (err) {
        // Heartbeat errors are non-fatal
        console.error("[Agent] Heartbeat error:", err);
      }
    };

    // Initial tick after a short delay (let WS connect first)
    setTimeout(() => tick(), 5000);
    this.heartbeatTimer = setInterval(tick, intervalMs);
  }

  // ── Connect to server via WebSocket ───────────────────────────────────

  connect(): void {
    const protocol = this.server.startsWith("https") ? "wss" : "ws";
    const host = this.server.replace(/^https?:\/\//, "");
    const afterParam = this.lastCursor > 0 ? `?after=${this.lastCursor}` : "";
    const wsUrl = `${protocol}://${host}/sessions/${this.sessionId}/ws${afterParam}`;

    console.log(`[Agent] Connecting to ${wsUrl} (cursor=${this.lastCursor})`);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[Agent] Connected to session ${this.sessionId}`);
      this.emitAgentStatus("idle", "Agent started");
      this.startRepoHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        // Server sends { envelope, cursor } per PR1 wire format
        const raw = JSON.parse(event.data as string) as {
          envelope: EventEnvelope;
          cursor: number;
        };
        this.lastCursor = Math.max(this.lastCursor, raw.cursor);
        this.chain = this.chain
          .then(() => this.onEvent(raw.envelope))
          .catch((err) => console.error("[Agent] Handler error:", err));
      } catch (err) {
        console.error("[Agent] Failed to parse event:", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[Agent] WebSocket closed, reconnecting in 3s…");
      setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error("[Agent] WebSocket error:", err);
    };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

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
        `[Agent] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

async function main() {
  const opts = parseArgs();

  console.log(`[Agent] PushPals Local Agent Daemon`);
  console.log(`[Agent] Server: ${opts.server}`);
  console.log(`[Agent] Repo: ${opts.repo}`);
  console.log(`[Agent] Planner: ${opts.planner}`);

  // Create or join a session (with retry — server may not be up yet)
  let sessionId = opts.sessionId;
  console.log(`[Agent] Ensuring session "${sessionId}" exists on server…`);
  sessionId = await connectWithRetry(opts.server, sessionId ?? undefined);
  console.log(`[Agent] Using session: ${sessionId}`);

  // Choose planner
  const planner: PlannerModel =
    opts.planner === "remote" ? new RemotePlanner() : new LocalHeuristicPlanner();

  // Start agent
  const agent = new LocalAgent({
    server: opts.server,
    sessionId,
    repo: opts.repo,
    planner,
    authToken: opts.authToken,
  });

  agent.connect();
}

main().catch((err) => {
  console.error("[Agent] Fatal:", err);
  process.exit(1);
});
