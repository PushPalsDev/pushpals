import { PROTOCOL_VERSION } from "./version.js";

/**
 * Payload types for each event type - enables type narrowing
 */
export interface EventTypePayloadMap {
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
}

/**
 * Discriminated union of all event payload types
 */
export type EventPayload = EventTypePayloadMap[keyof EventTypePayloadMap];

export type EventType = keyof EventTypePayloadMap;

/**
 * EventEnvelope parameterized by event type for type-safe access to payload
 */
export interface EventEnvelope<T extends EventType = EventType> {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: string;
  ts: string; // ISO-8601
  sessionId: string;
  type: T;
  traceId?: string;
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
