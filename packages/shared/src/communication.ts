import type { EventEnvelope, EventType, EventTypePayloadMap } from "protocol";

type EventMeta = {
  from?: string;
  to?: string;
  correlationId?: string;
  turnId?: string;
  parentId?: string;
};

type SessionEventsOptions = {
  afterCursor?: number;
  reconnectMs?: number;
  onError?: (message: string) => void;
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

  subscribeSessionEvents(
    onEvent: (envelope: EventEnvelope, cursor: number) => void,
    options: SessionEventsOptions = {},
  ): () => void {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let latestCursor = Math.max(0, options.afterCursor ?? 0);
    const reconnectMs = Math.max(500, options.reconnectMs ?? 3000);
    const onError =
      options.onError ??
      (() => {
        // no-op
      });

    const connect = () => {
      if (disposed) return;
      try {
        const url = new URL(this.serverUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `/sessions/${this.sessionId}/ws`;
        url.search = latestCursor > 0 ? `after=${latestCursor}` : "";
        ws = new WebSocket(url.toString());
      } catch (err) {
        onError(`[SessionEvents] Failed to connect: ${String(err)}`);
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
        return;
      }

      ws.onmessage = (event: MessageEvent) => {
        try {
          const raw =
            typeof event.data === "string"
              ? (JSON.parse(event.data) as Record<string, unknown>)
              : null;
          if (!raw) return;
          const envelope = (raw.envelope ?? raw) as EventEnvelope;
          const cursor = typeof raw.cursor === "number" ? raw.cursor : 0;
          if (cursor > latestCursor) latestCursor = cursor;
          onEvent(envelope, cursor);
        } catch (err) {
          onError(`[SessionEvents] Parse error: ${String(err)}`);
        }
      };

      ws.onerror = () => {
        onError("[SessionEvents] WebSocket error");
      };

      ws.onclose = () => {
        ws = null;
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
      }
      ws = null;
    };
  }
}
