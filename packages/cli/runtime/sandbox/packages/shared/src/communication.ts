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
  onOpen?: () => void;
};

function stripPresenceSourcePrefix(value: string): string {
  return value.replace(/^(agent|client)(?:[\s:./_-]+)+/i, "");
}

export function normalizePresenceClientId(value: unknown): string {
  const raw = stripPresenceSourcePrefix(String(value ?? "").trim());
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").trim();
}

export function normalizePresenceClientLabel(value: unknown): string {
  return stripPresenceSourcePrefix(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePresenceLookupToken(value: unknown): string {
  return normalizePresenceClientLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type SessionTransportPresence = {
  clientId: string;
  kind: string;
  label: string;
  version: string;
  platform: string;
  repoRoot: string;
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

  private commandUrl(sessionId: string): string {
    return `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/command`;
  }

  private buildSessionTransportPresence(sessionId: string): SessionTransportPresence {
    const normalizedFrom = normalizePresenceClientId(this.from);
    const labelFrom = normalizePresenceClientLabel(this.from);
    const normalizedSessionId = normalizePresenceClientId(sessionId);
    const isDefaultSession = sessionId === this.sessionId;
    const repoRoot = String(
      process.env.PUSHPALS_REPO_ROOT_OVERRIDE ??
        process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE ??
        process.cwd(),
    ).trim();
    return {
      clientId: isDefaultSession
        ? normalizedFrom || "agent"
        : `${normalizedFrom || "agent"}__${normalizedSessionId || "session"}`,
      kind: "agent",
      label: labelFrom || normalizedFrom || "Agent",
      version: String(process.env.PUSHPALS_RUNTIME_TAG ?? process.env.npm_package_version ?? "")
        .trim(),
      platform: `${process.platform}/${process.arch}`,
      repoRoot,
    };
  }

  async emitToSession<T extends EventType>(
    sessionId: string,
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

      const response = await fetch(this.commandUrl(sessionId), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async emit<T extends EventType>(
    type: T,
    payload: EventTypePayloadMap[T],
    meta: EventMeta = {},
  ): Promise<boolean> {
    return this.emitToSession(this.sessionId, type, payload, meta);
  }

  async assistantMessageToSession(
    sessionId: string,
    text: string,
    meta: EventMeta = {},
  ): Promise<boolean> {
    return this.emitToSession(sessionId, "assistant_message", { text }, meta);
  }

  async assistantMessage(text: string, meta: EventMeta = {}): Promise<boolean> {
    return this.assistantMessageToSession(this.sessionId, text, meta);
  }

  async userMessageToSession(
    sessionId: string,
    text: string,
    meta: EventMeta = {},
  ): Promise<boolean> {
    return this.emitToSession(sessionId, "message", { text }, {
      ...meta,
      from: meta.from ?? "client",
    });
  }

  async userMessage(text: string, meta: EventMeta = {}): Promise<boolean> {
    return this.userMessageToSession(this.sessionId, text, meta);
  }

  async taskProgressToSession(
    sessionId: string,
    taskId: string,
    message: string,
    percent?: number,
    meta: EventMeta = {},
  ): Promise<boolean> {
    const payload: EventTypePayloadMap["task_progress"] =
      percent == null ? { taskId, message } : { taskId, message, percent };
    return this.emitToSession(sessionId, "task_progress", payload, meta);
  }

  async taskProgress(
    taskId: string,
    message: string,
    percent?: number,
    meta: EventMeta = {},
  ): Promise<boolean> {
    return this.taskProgressToSession(this.sessionId, taskId, message, percent, meta);
  }

  async statusToSession(
    sessionId: string,
    agentId: string,
    state: EventTypePayloadMap["status"]["state"],
    detail?: string,
    meta: EventMeta = {},
  ): Promise<boolean> {
    const payload: EventTypePayloadMap["status"] =
      detail == null ? { agentId, state } : { agentId, state, detail };
    return this.emitToSession(sessionId, "status", payload, meta);
  }

  async status(
    agentId: string,
    state: EventTypePayloadMap["status"]["state"],
    detail?: string,
    meta: EventMeta = {},
  ): Promise<boolean> {
    return this.statusToSession(this.sessionId, agentId, state, detail, meta);
  }

  subscribeSessionEventsForSession(
    sessionId: string,
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
    const onOpen =
      options.onOpen ??
      (() => {
        // no-op
      });

    const connect = () => {
      if (disposed) return;
      try {
        const url = new URL(this.serverUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `/sessions/${encodeURIComponent(sessionId)}/ws`;
        const presence = this.buildSessionTransportPresence(sessionId);
        if (latestCursor > 0) {
          url.searchParams.set("after", String(latestCursor));
        }
        url.searchParams.set("clientId", presence.clientId);
        url.searchParams.set("clientKind", presence.kind);
        url.searchParams.set("clientLabel", presence.label);
        if (presence.version) {
          url.searchParams.set("clientVersion", presence.version);
        }
        if (presence.platform) {
          url.searchParams.set("clientPlatform", presence.platform);
        }
        if (presence.repoRoot) {
          url.searchParams.set("clientRepoRoot", presence.repoRoot);
        }
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

      ws.onopen = () => {
        onOpen();
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

  subscribeSessionEvents(
    onEvent: (envelope: EventEnvelope, cursor: number) => void,
    options: SessionEventsOptions = {},
  ): () => void {
    return this.subscribeSessionEventsForSession(this.sessionId, onEvent, options);
  }
}
