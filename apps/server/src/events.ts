import {
  EventEnvelope,
  EventType,
  validateEventEnvelope,
  validateMessageRequest,
  validateApprovalDecisionRequest,
  validateCommandRequest,
  PROTOCOL_VERSION,
} from "protocol";
import type { CommandRequest } from "protocol";
import { randomUUID } from "crypto";

// ─── Ring buffer for bounded history ────────────────────────────────────────

class RingBuffer<T> {
  private buf: T[] = [];
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    if (this.buf.length >= this.maxSize) this.buf.shift();
    this.buf.push(item);
  }

  toArray(): T[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }
}

// ─── Task record stored per session ─────────────────────────────────────────

export interface TaskRecord {
  taskId: string;
  title: string;
  description: string;
  createdBy: string;
  status: "created" | "started" | "in_progress" | "completed" | "failed";
  priority?: string;
  tags?: string[];
  summary?: string;
  failMessage?: string;
}

// ─── Pending approval record ────────────────────────────────────────────────

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  toolCallId?: string; // links back to tool_call event
  action: string;
  summary: string;
  details: Record<string, unknown>;
}

/**
 * Internal event bus for a session.
 * Both SSE and WebSocket subscribers share the same stream.
 * Now also stores event history, tasks, and approvals.
 */
export class SessionEventBus {
  sessionId: string;
  private subscribers: Set<(envelope: EventEnvelope) => void> = new Set();

  /** Bounded event history (ring buffer, last N events) */
  readonly history: RingBuffer<EventEnvelope>;

  /** Active tasks map: taskId → TaskRecord */
  readonly tasks: Map<string, TaskRecord> = new Map();

  constructor(sessionId: string, historySize = 200) {
    this.sessionId = sessionId;
    this.history = new RingBuffer<EventEnvelope>(historySize);
  }

  subscribe(callback: (envelope: EventEnvelope) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  emit(envelope: EventEnvelope): void {
    // Validate before emitting
    const validation = validateEventEnvelope(envelope);
    if (!validation.ok) {
      // Emit error event instead
      const errorEnvelope: EventEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        type: "error",
        payload: {
          message: "Failed to validate event",
          detail: validation.errors?.join("; "),
        },
      };
      this.history.push(errorEnvelope);
      this.subscribers.forEach((cb) => cb(errorEnvelope));
      return;
    }

    // Track task lifecycle in the tasks map
    this._trackTask(envelope);

    this.history.push(envelope);
    this.subscribers.forEach((cb) => cb(envelope));
  }

  /** Replay stored history to a subscriber */
  replayHistory(callback: (envelope: EventEnvelope) => void): void {
    for (const envelope of this.history.toArray()) {
      callback(envelope);
    }
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  private _trackTask(envelope: EventEnvelope): void {
    const p = envelope.payload as any;
    switch (envelope.type) {
      case "task_created":
        this.tasks.set(p.taskId, {
          taskId: p.taskId,
          title: p.title,
          description: p.description,
          createdBy: p.createdBy,
          status: "created",
          priority: p.priority,
          tags: p.tags,
        });
        break;
      case "task_started": {
        const t = this.tasks.get(p.taskId);
        if (t) t.status = "started";
        break;
      }
      case "task_progress": {
        const t = this.tasks.get(p.taskId);
        if (t) t.status = "in_progress";
        break;
      }
      case "task_completed": {
        const t = this.tasks.get(p.taskId);
        if (t) {
          t.status = "completed";
          t.summary = p.summary;
        }
        break;
      }
      case "task_failed": {
        const t = this.tasks.get(p.taskId);
        if (t) {
          t.status = "failed";
          t.failMessage = p.message;
        }
        break;
      }
    }
  }
}

/**
 * Global session manager with full state management
 */
export class SessionManager {
  private sessions: Map<string, SessionEventBus> = new Map();

  /** Pending approvals: approvalId → PendingApproval */
  readonly pendingApprovals: Map<string, PendingApproval> = new Map();

  /** Static auth token for agent endpoints (configurable) */
  authToken: string | null = process.env.PUSHPALS_AUTH_TOKEN ?? null;

  createSession(): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, new SessionEventBus(sessionId));
    return sessionId;
  }

  getSession(sessionId: string): SessionEventBus | null {
    return this.sessions.get(sessionId) || null;
  }

  /** Validate a bearer token against the configured auth token */
  validateAuth(headerValue: string | null): boolean {
    if (!this.authToken) return true; // No token configured → open access
    if (!headerValue) return false;
    const token = headerValue.replace(/^Bearer\s+/i, "");
    return token === this.authToken;
  }

  // ── handleMessage (UI convenience) ──────────────────────────────────────

  handleMessage(sessionId: string, body: unknown): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const validation = validateMessageRequest(body);
    if (!validation.ok) {
      session.emit({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId,
        type: "error",
        payload: {
          message: "Invalid message request",
          detail: validation.errors?.join("; "),
        },
      } as unknown as EventEnvelope);
      return;
    }

    const text = (body as Record<string, unknown>).text as string;
    const turnId = randomUUID();

    // Emit assistant_message to acknowledge receipt and indicate planning
    const assistantEnv: EventEnvelope<"assistant_message"> = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "assistant_message",
      from: "server",
      turnId,
      payload: {
        text: "Got it — I'm going to plan tasks...",
      },
    };
    session.emit(assistantEnv);

    // Translate incoming message to a task_created event
    const taskId = randomUUID();
    const taskEnv: EventEnvelope<"task_created"> = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "task_created",
      from: "client",
      turnId,
      payload: {
        taskId,
        title: text.length > 80 ? text.substring(0, 80) + "…" : text,
        description: text,
        createdBy: "client",
      },
    };
    session.emit(taskEnv);
  }

  // ── handleCommand (agent-friendly ingest) ───────────────────────────────

  handleCommand(
    sessionId: string,
    body: unknown,
  ): { ok: boolean; eventId?: string; message?: string } {
    const session = this.getSession(sessionId);
    if (!session) return { ok: false, message: "Session not found" };

    const validation = validateCommandRequest(body);
    if (!validation.ok) {
      return { ok: false, message: validation.errors?.join("; ") };
    }

    const cmd = body as CommandRequest;
    const eventId = randomUUID();

    const envelope: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      id: eventId,
      ts: new Date().toISOString(),
      sessionId,
      type: cmd.type as EventType,
      from: cmd.from,
      to: cmd.to,
      correlationId: cmd.correlationId,
      turnId: cmd.turnId,
      parentId: cmd.parentId,
      payload: cmd.payload as any,
    };

    // If it's a tool_call with requiresApproval, auto-create pending approval
    if (cmd.type === "tool_call" && (cmd.payload as any).requiresApproval === true) {
      const toolCallId = (cmd.payload as any).toolCallId as string;
      this._createApprovalFromToolCall(sessionId, toolCallId, cmd.payload);
    }

    session.emit(envelope);
    return { ok: true, eventId };
  }

  // ── Approvals ───────────────────────────────────────────────────────────

  createApproval(
    sessionId: string,
    action: string,
    summary: string,
    details: Record<string, unknown>,
  ): string {
    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, {
      approvalId,
      sessionId,
      action,
      summary,
      details,
    });

    const session = this.getSession(sessionId);
    if (session) {
      session.emit({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId,
        type: "approval_required",
        payload: {
          approvalId,
          action: action as "git.commit" | "git.push" | "other",
          summary,
          details,
        },
      });
    }

    return approvalId;
  }

  /** Auto-create an approval from an incoming tool_call with requiresApproval */
  private _createApprovalFromToolCall(
    sessionId: string,
    toolCallId: string,
    payload: Record<string, unknown>,
  ): void {
    this.pendingApprovals.set(toolCallId, {
      approvalId: toolCallId,
      sessionId,
      toolCallId,
      action: (payload.tool as string) ?? "other",
      summary: `Tool call: ${payload.tool}`,
      details: payload,
    });

    const session = this.getSession(sessionId);
    if (session) {
      session.emit({
        protocolVersion: PROTOCOL_VERSION,
        id: randomUUID(),
        ts: new Date().toISOString(),
        sessionId,
        type: "approval_required",
        payload: {
          approvalId: toolCallId,
          action: "other" as const,
          summary: `Tool call: ${payload.tool}`,
          details: payload,
        },
      });
    }
  }

  handleApprovalDecision(
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; message?: string } {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      return { ok: false, message: "Approval not found" };
    }

    const validation = validateApprovalDecisionRequest({ decision });
    if (!validation.ok) {
      return { ok: false, message: validation.errors?.join("; ") };
    }

    const session = this.getSession(approval.sessionId);
    if (!session) {
      return { ok: false, message: "Session not found" };
    }

    const eventType = decision === "approve" ? "approved" : "denied";
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId: approval.sessionId,
      type: eventType as EventType,
      payload: {
        approvalId,
      },
    });

    this.pendingApprovals.delete(approvalId);
    return { ok: true };
  }
}
