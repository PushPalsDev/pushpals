import {
  EventEnvelope,
  EventType,
  validateEventEnvelope,
  validateMessageRequest,
  validateApprovalDecisionRequest,
  PROTOCOL_VERSION,
} from "protocol";
import { randomUUID } from "crypto";

/**
 * Internal event bus for a session.
 * Both SSE and WebSocket subscribers share the same stream.
 */
export class SessionEventBus {
  sessionId: string;
  private subscribers: Set<(envelope: EventEnvelope) => void> = new Set();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
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
      this.subscribers.forEach((cb) => cb(errorEnvelope));
      return;
    }

    this.subscribers.forEach((cb) => cb(envelope));
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}

/**
 * Global session manager
 */
export class SessionManager {
  private sessions: Map<string, SessionEventBus> = new Map();
  private approvals: Map<
    string,
    {
      sessionId: string;
      action: string;
      summary: string;
      details: Record<string, unknown>;
    }
  > = new Map();

  createSession(): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, new SessionEventBus(sessionId));
    return sessionId;
  }

  getSession(sessionId: string): SessionEventBus | null {
    return this.sessions.get(sessionId) || null;
  }

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

    // Emit a log event
    session.emit({
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "log",
      payload: {
        level: "info",
        message: `Received message: ${text}`,
      },
    });

    // Emit an assistant_message to acknowledge receipt and indicate planning
    const assistantEnv: EventEnvelope<"assistant_message"> = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "assistant_message",
      payload: {
        text: "Got it — I'm going to plan tasks...",
      },
    };
    session.emit(assistantEnv);

    // Emit a suggestions event stub (simple single suggestion) to simulate planning
    const suggestionsEnv: EventEnvelope<"suggestions"> = {
      protocolVersion: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      sessionId,
      type: "suggestions",
      payload: {
        items: [
          {
            id: randomUUID(),
            title: "Create unit tests",
            detail: "Add unit tests for the new companion flow",
            effort: "M",
          },
        ],
      },
    };
    session.emit(suggestionsEnv);
  }

  createApproval(
    sessionId: string,
    action: string,
    summary: string,
    details: Record<string, unknown>,
  ): string {
    const approvalId = randomUUID();
    this.approvals.set(approvalId, { sessionId, action, summary, details });

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

  handleApprovalDecision(
    approvalId: string,
    decision: "approve" | "deny",
  ): { ok: boolean; message?: string } {
    const approval = this.approvals.get(approvalId);
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

    this.approvals.delete(approvalId);
    return { ok: true };
  }
}
