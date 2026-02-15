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
import { EventStore } from "./db.js";

type StartupReadyKey = "localbuddy" | "remotebuddy" | "source_control_manager";

const STARTUP_READY_MESSAGE = "All systems online, feel free to send messages!";

const STARTUP_READY_KEYS: ReadonlyArray<StartupReadyKey> = [
  "localbuddy",
  "remotebuddy",
  "source_control_manager",
];

const STARTUP_READY_DETAIL_RE = /\bonline\b/i;

const startupReadyKeyForAgent = (agentId: string): StartupReadyKey | null => {
  if (agentId === "source_control_manager") return "source_control_manager";
  if (agentId.startsWith("localbuddy")) return "localbuddy";
  if (agentId.startsWith("remotebuddy")) return "remotebuddy";
  return null;
};

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
 *
 * Persist-first architecture:
 *   emit() → insertEvent (SQLite) → broadcast to subscribers
 *
 * Replay uses cursor-based queries instead of in-memory ring buffer.
 */
export class SessionEventBus {
  sessionId: string;
  private subscribers: Set<(envelope: EventEnvelope, eventId: number) => void> = new Set();

  /** Shared event store (injected from SessionManager) */
  private store: EventStore;

  /** Active tasks map: taskId → TaskRecord */
  readonly tasks: Map<string, TaskRecord> = new Map();

  constructor(sessionId: string, store: EventStore) {
    this.sessionId = sessionId;
    this.store = store;
  }

  subscribe(callback: (envelope: EventEnvelope, eventId: number) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Persist THEN broadcast.
   * Returns the cursor (event_id) of the persisted event.
   */
  emit(envelope: EventEnvelope): number {
    // Validate before persisting
    const validation = validateEventEnvelope(envelope);
    if (!validation.ok) {
      // Persist + broadcast error event instead
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
      const cursor = this.store.insertEvent(errorEnvelope);
      this.subscribers.forEach((cb) => cb(errorEnvelope, cursor));
      return cursor;
    }

    // Track task lifecycle in the tasks map
    this._trackTask(envelope);

    // 1. Persist to SQLite (crash-safe)
    const cursor = this.store.insertEvent(envelope);

    // 2. Broadcast to live subscribers
    this.subscribers.forEach((cb) => cb(envelope, cursor));

    return cursor;
  }

  /**
   * Replay stored history to a subscriber.
   * @param callback  receives each envelope + its cursor
   * @param afterEventId  only replay events with event_id > afterEventId (0 = full replay)
   */
  replayHistory(
    callback: (envelope: EventEnvelope, eventId: number) => void,
    afterEventId: number = 0,
  ): void {
    const rows = this.store.getEventsAfter(this.sessionId, afterEventId);
    for (const row of rows) {
      try {
        const envelope = JSON.parse(row.envelope) as EventEnvelope;
        callback(envelope, row.eventId);
      } catch (err) {
        // Skip corrupted rows — log but don't break the entire replay
        console.error(
          `[replay] Failed to parse event ${row.eventId} in session ${this.sessionId}:`,
          err,
        );
      }
    }
  }

  /** Get the latest cursor for this session */
  getLatestCursor(): number {
    return this.store.getLatestCursor(this.sessionId);
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
 * Global session manager with full state management.
 *
 * Owns a shared EventStore instance that all SessionEventBus instances write to.
 */
export class SessionManager {
  private sessions: Map<string, SessionEventBus> = new Map();
  private startupReadyBySession: Map<
    string,
    { readyKeys: Set<StartupReadyKey>; announced: boolean }
  > = new Map();

  /** Pending approvals: approvalId → PendingApproval */
  readonly pendingApprovals: Map<string, PendingApproval> = new Map();

  /** Static auth token for agent endpoints (configurable) */
  authToken: string | null = process.env.PUSHPALS_AUTH_TOKEN ?? null;

  /** Shared durable event store */
  readonly store: EventStore;

  constructor(dbPath?: string) {
    this.store = new EventStore(dbPath);
  }

  private static readonly SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

  /**
   * Create or join a session.
   * Returns `{ id, created }` so callers can distinguish 201 vs 200.
   * Returns `null` id when the caller-supplied sessionId fails validation.
   */
  createSession(sessionId?: string): { id: string | null; created: boolean } {
    if (sessionId && !SessionManager.SESSION_ID_RE.test(sessionId)) {
      return { id: null, created: false };
    }
    const id = sessionId ?? randomUUID();
    const created = this.store.createSession(id);
    if (!this.sessions.has(id)) {
      this.sessions.set(id, new SessionEventBus(id, this.store));
    }
    return { id, created };
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
    const intent = (body as Record<string, unknown>).intent as Record<string, unknown> | undefined;
    const turnId = randomUUID();

    // Emit a `message` event — agents (remote / local) handle orchestration
    const messageEnv: EventEnvelope<"message"> = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "message",
      from: "client",
      turnId,
      payload: {
        text,
        ...(intent ? { intent } : {}),
      },
    };
    session.emit(messageEnv);
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
    this._maybeEmitStartupReady(sessionId, envelope);
    return { ok: true, eventId };
  }

  private _maybeEmitStartupReady(sessionId: string, envelope: EventEnvelope): void {
    if (envelope.type !== "status") return;
    const payload = envelope.payload as { agentId?: unknown; detail?: unknown };
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    if (!agentId) return;
    const readyKey = startupReadyKeyForAgent(agentId);
    if (!readyKey) return;
    const detail = typeof payload.detail === "string" ? payload.detail : "";
    if (!STARTUP_READY_DETAIL_RE.test(detail)) return;

    const state =
      this.startupReadyBySession.get(sessionId) ??
      { readyKeys: new Set<StartupReadyKey>(), announced: false };
    if (state.announced) return;

    state.readyKeys.add(readyKey);
    this.startupReadyBySession.set(sessionId, state);

    const allReady = STARTUP_READY_KEYS.every((key) => state.readyKeys.has(key));
    if (!allReady) return;

    state.announced = true;
    const session = this.getSession(sessionId);
    if (!session) return;
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "assistant_message",
      from: "system",
      payload: { text: STARTUP_READY_MESSAGE },
    });
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
