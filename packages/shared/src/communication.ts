import type { EventType, EventTypePayloadMap } from "protocol";

type EventMeta = {
  from?: string;
  to?: string;
  correlationId?: string;
  turnId?: string;
  parentId?: string;
};

export interface CommunicationManagerOptions {
  serverUrl: string;
  sessionId: string;
  from: string;
  authToken?: string | null;
}

export class CommunicationManager {
  private readonly serverUrl: string;
  private readonly sessionId: string;
  private readonly from: string;
  private readonly authToken: string | null;

  constructor(opts: CommunicationManagerOptions) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.from = opts.from;
    this.authToken = opts.authToken ?? null;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  async emit<T extends EventType>(
    type: T,
    payload: EventTypePayloadMap[T],
    meta: EventMeta = {},
  ): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        type,
        payload: payload as unknown as Record<string, unknown>,
        from: meta.from ?? this.from,
      };
      if (meta.to) body.to = meta.to;
      if (meta.correlationId) body.correlationId = meta.correlationId;
      if (meta.turnId) body.turnId = meta.turnId;
      if (meta.parentId) body.parentId = meta.parentId;

      const response = await fetch(`${this.serverUrl}/sessions/${this.sessionId}/command`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async assistantMessage(text: string, meta: EventMeta = {}): Promise<boolean> {
    return this.emit("assistant_message", { text }, meta);
  }

  async userMessage(text: string, meta: EventMeta = {}): Promise<boolean> {
    return this.emit("message", { text }, { ...meta, from: meta.from ?? "client" });
  }

  async taskProgress(
    taskId: string,
    message: string,
    percent?: number,
    meta: EventMeta = {},
  ): Promise<boolean> {
    const payload: EventTypePayloadMap["task_progress"] =
      percent == null ? { taskId, message } : { taskId, message, percent };
    return this.emit("task_progress", payload, meta);
  }

  async status(
    agentId: string,
    state: EventTypePayloadMap["status"]["state"],
    detail?: string,
    meta: EventMeta = {},
  ): Promise<boolean> {
    const payload: EventTypePayloadMap["status"] =
      detail == null ? { agentId, state } : { agentId, state, detail };
    return this.emit("status", payload, meta);
  }
}
