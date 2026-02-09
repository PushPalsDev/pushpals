import { PROTOCOL_VERSION } from "./version.js";

// ─── Artifact type (reused across several payloads) ─────────────────────────
export interface Artifact {
  kind: string;
  uri?: string;
  text?: string;
}

/**
 * Payload types for each event type - enables type narrowing
 */
export interface EventTypePayloadMap {
  // ── Existing events ───────────────────────────────────────────────────────
  log: { level: "debug" | "info" | "warn" | "error"; message: string };
  scan_result: {
    summary: string;
    filesRead: string[];
    gitStatusPorcelain: string;
    gitDiff: string;
  };
  suggestions: {
    items: Array<{ id: string; title: string; detail: string; effort: "S" | "M" | "L" }>;
  };
  diff_ready: { unifiedDiff: string; diffStat: string; branch: string };
  approval_required: {
    approvalId: string;
    action: "git.commit" | "git.push" | "other";
    summary: string;
    details: Record<string, unknown>;
  };
  approved: { approvalId: string };
  denied: { approvalId: string };
  committed: { branch: string; commitHash: string; message: string };
  assistant_message: { text: string };
  error: { message: string; detail?: string };
  done: { ok: boolean };

  // ── Multi-agent events ────────────────────────────────────────────────────
  agent_status: {
    agentId: string;
    status: "idle" | "busy" | "error";
    message?: string;
  };

  // ── Task lifecycle events ─────────────────────────────────────────────────
  task_created: {
    taskId: string;
    title: string;
    description: string;
    createdBy: string;
    priority?: string;
    tags?: string[];
  };
  task_started: { taskId: string };
  task_progress: { taskId: string; message: string; percent?: number };
  task_completed: {
    taskId: string;
    summary: string;
    artifacts?: Artifact[];
  };
  task_failed: { taskId: string; message: string; detail?: string };

  // ── Tool call/result events ───────────────────────────────────────────────
  tool_call: {
    toolCallId: string;
    taskId?: string;
    tool: string;
    args: Record<string, unknown>;
    requiresApproval?: boolean;
  };
  tool_result: {
    toolCallId: string;
    taskId?: string;
    ok: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    artifacts?: Artifact[];
  };

  // ── Delegation events ─────────────────────────────────────────────────────
  delegate_request: {
    requestId: string;
    toAgentId: string;
    input: Record<string, unknown>;
  };
  delegate_response: {
    requestId: string;
    ok: boolean;
    output?: Record<string, unknown>;
    error?: string;
  };

  // ── Job queue events ──────────────────────────────────────────────────────
  job_enqueued: {
    jobId: string;
    taskId: string;
    kind: string;
    params: Record<string, unknown>;
  };
  job_claimed: { jobId: string; workerId: string };
  job_completed: {
    jobId: string;
    summary?: string;
    artifacts?: Artifact[];
  };
  job_failed: { jobId: string; message: string; detail?: string };
}

/**
 * Discriminated union of all event payload types
 */
export type EventPayload = EventTypePayloadMap[keyof EventTypePayloadMap];

export type EventType = keyof EventTypePayloadMap;

/**
 * EventEnvelope parameterized by event type for type-safe access to payload
 *
 * Routing / meta fields (all optional):
 * - from:          originator identifier (e.g. "client", "agent:local1")
 * - to:            destination identifier (e.g. "broadcast", "worker:queue:default")
 * - correlationId: threads a whole conversation turn together
 * - parentId:      links tool calls/results under their parent task event
 * - turnId:        one per user message; groups all downstream events
 */
export interface EventEnvelope<T extends EventType = EventType> {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  ts: string; // ISO-8601
  sessionId: string;
  type: T;
  traceId?: string;

  // Routing / meta
  from?: string;
  to?: string;
  correlationId?: string;
  parentId?: string;
  turnId?: string;

  payload: EventTypePayloadMap[T];
}

/**
 * Any EventEnvelope - for cases where type is not known at compile time
 */
export type AnyEventEnvelope = EventEnvelope<EventType>;

/**
 * HTTP Request/Response types
 */
export interface CreateSessionResponse {
  sessionId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface MessageRequest {
  text: string;
  intent?: Record<string, unknown>;
}

export interface MessageResponse {
  ok: boolean;
}

export interface ApprovalDecisionRequest {
  decision: "approve" | "deny";
}

export interface ApprovalDecisionResponse {
  ok: boolean;
}

/**
 * Command request (agent-friendly ingest)
 */
export interface CommandRequest {
  type: EventType;
  payload: Record<string, unknown>;
  from?: string;
  to?: string;
  correlationId?: string;
  turnId?: string;
  parentId?: string;
}

export interface CommandResponse {
  ok: boolean;
  eventId?: string;
}
