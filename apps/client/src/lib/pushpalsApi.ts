import type { EventEnvelope } from "protocol/browser";
import { validateEventEnvelope } from "protocol/browser";

type TransportType = "auto" | "sse" | "ws";

/** Extended callback that also receives the server cursor for each event */
export type CursorEventCallback = (
  event: EventEnvelope | { type: "_error"; message: string },
  cursor: number,
) => void;

/**
 * Determine which transport to use based on platform
 */
function selectTransport(transport: TransportType): "sse" | "ws" {
  if (transport !== "auto") return transport;

  // Check if we're in a browser with EventSource support
  const isBrowser = typeof window !== "undefined" && typeof EventSource !== "undefined";

  // For Expo web, prefer SSE
  if (isBrowser) {
    return "sse";
  }

  // For native/desktop, use WebSocket
  return "ws";
}

/**
 * Subscribe to session events over SSE
 */
function subscribeSSE(
  baseUrl: string,
  sessionId: string,
  onEvent: CursorEventCallback,
  afterCursor: number = 0,
): () => void {
  let disposed = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCursor = afterCursor;

  function connect() {
    if (disposed) return;
    const afterParam = latestCursor > 0 ? `?after=${latestCursor}` : "";
    es = new EventSource(`${baseUrl}/sessions/${sessionId}/events${afterParam}`);

    es.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        const validation = validateEventEnvelope(data);

        if (!validation.ok) {
          onEvent(
            { type: "_error", message: `[Protocol error] ${validation.errors?.join("; ")}` },
            0,
          );
          return;
        }

        // SSE sends `id: <cursor>` — available via event.lastEventId
        const cursor = parseInt(event.lastEventId, 10) || 0;
        if (cursor > latestCursor) latestCursor = cursor;
        onEvent(data, cursor);
      } catch (err) {
        onEvent(
          { type: "_error", message: `[Parse error] Failed to parse event: ${String(err)}` },
          0,
        );
      }
    });

    es.onerror = () => {
      onEvent({ type: "_error", message: "[SSE] Connection lost, reconnecting\u2026" }, 0);
      es?.close();
      es = null;
      if (!disposed) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    es?.close();
  };
}

/**
 * Subscribe to session events over WebSocket
 */
function subscribeWebSocket(
  baseUrl: string,
  sessionId: string,
  onEvent: CursorEventCallback,
  afterCursor: number = 0,
): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCursor = afterCursor;

  function connect() {
    if (disposed) return;
    const protocol = baseUrl.startsWith("https") ? "wss" : "ws";
    const host = baseUrl.replace(/^https?:\/\//, "");
    const afterParam = latestCursor > 0 ? `?after=${latestCursor}` : "";
    const wsUrl = `${protocol}://${host}/sessions/${sessionId}/ws${afterParam}`;

    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);

        // Server sends { envelope, cursor } wrapper
        const envelope = raw.envelope ?? raw;
        const cursor: number = typeof raw.cursor === "number" ? raw.cursor : 0;

        const validation = validateEventEnvelope(envelope);
        if (!validation.ok) {
          onEvent(
            { type: "_error", message: `[Protocol error] ${validation.errors?.join("; ")}` },
            0,
          );
          return;
        }

        if (cursor > latestCursor) latestCursor = cursor;
        onEvent(envelope, cursor);
      } catch (err) {
        onEvent(
          { type: "_error", message: `[Parse error] Failed to parse event: ${String(err)}` },
          0,
        );
      }
    };

    ws.onerror = () => {
      onEvent({ type: "_error", message: "[WebSocket] Connection error" }, 0);
    };

    ws.onclose = () => {
      ws = null;
      if (!disposed) {
        onEvent({ type: "_error", message: "[WebSocket] Connection lost, reconnecting\u2026" }, 0);
        reconnectTimer = setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
}

/**
 * Subscribe to events from a session.
 * Automatically selects transport based on platform.
 *
 * @param baseUrl Base URL of the server (e.g., http://localhost:3001)
 * @param sessionId Session ID
 * @param onEvent Callback for each event + cursor (or error with cursor=0)
 * @param transport Transport selection: "auto", "sse", or "ws" (default: "auto")
 * @param afterCursor Resume from this cursor (default: 0 = from beginning)
 * @returns Unsubscribe function
 */
export function subscribeEvents(
  baseUrl: string,
  sessionId: string,
  onEvent: CursorEventCallback,
  transport: TransportType = "auto",
  afterCursor: number = 0,
): () => void {
  const selectedTransport = selectTransport(transport);

  console.log(
    `[PushPals] Subscribing to session ${sessionId} via ${selectedTransport} (after=${afterCursor})`,
  );

  if (selectedTransport === "sse") {
    return subscribeSSE(baseUrl, sessionId, onEvent, afterCursor);
  } else {
    return subscribeWebSocket(baseUrl, sessionId, onEvent, afterCursor);
  }
}

/**
 * Create a new session on the server
 */
export async function createSession(baseUrl: string, sessionId?: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });

    if (!response.ok) {
      console.error("Failed to create session:", response.status);
      return null;
    }

    const data = await response.json();
    return data.sessionId;
  } catch (err) {
    console.error("Error creating session:", err);
    return null;
  }
}

/**
 * Send a message to LocalBuddy with streaming status updates
 *
 * In the new architecture, messages are sent to LocalBuddy (not directly to server).
 * LocalBuddy enhances the prompt with repo context and enqueues it to the Request Queue,
 * streaming status updates back to the client via SSE.
 */
export async function sendMessage(localAgentUrl: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`${localAgentUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error(`Error sending message: ${response.status} ${response.statusText}`);
      return false;
    }

    // Handle SSE stream response
    const reader = response.body?.getReader();
    if (!reader) {
      console.error("No response body");
      return false;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let success = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || !line.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(line.slice(6));
          console.log(`[LocalBuddy] ${data.type}: ${data.message}`);

          if (data.type === "complete") {
            success = true;
          } else if (data.type === "error") {
            console.error(`[LocalBuddy] Error: ${data.message}`);
            success = false;
          }
        } catch (err) {
          console.error("Failed to parse SSE message:", line, err);
        }
      }
    }

    return success;
  } catch (err) {
    console.error("Error sending message:", err);
    return false;
  }
}

/**
 * Approve or deny an approval request
 */
export async function submitApprovalDecision(
  baseUrl: string,
  approvalId: string,
  decision: "approve" | "deny",
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });

    return response.ok;
  } catch (err) {
    console.error("Error submitting approval decision:", err);
    return false;
  }
}

export interface WorkerStatusRow {
  workerId: string;
  status: "idle" | "busy" | "error" | "offline";
  currentJobId: string | null;
  pollMs: number | null;
  capabilities: Record<string, unknown>;
  details: Record<string, unknown>;
  lastHeartbeat: string;
  createdAt: string;
  updatedAt: string;
  activeJobCount: number;
  isOnline: boolean;
}

export interface RequestSnapshotRow {
  id: string;
  sessionId: string;
  originalPrompt: string;
  enhancedPrompt: string;
  status: "pending" | "claimed" | "completed" | "failed";
  agentId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSnapshotRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  status: "pending" | "claimed" | "completed" | "failed";
  workerId: string | null;
  targetWorkerId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompletionSnapshotRow {
  id: string;
  jobId: string;
  sessionId: string;
  commitSha: string | null;
  branch: string | null;
  message: string;
  status: "pending" | "claimed" | "processed" | "failed";
  pusherId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueCounts {
  [key: string]: number;
}

function authHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

export async function fetchWorkers(
  baseUrl: string,
  authToken?: string,
): Promise<WorkerStatusRow[]> {
  try {
    const response = await fetch(`${baseUrl}/workers`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { ok: boolean; workers?: WorkerStatusRow[] };
    return Array.isArray(payload.workers) ? payload.workers : [];
  } catch (err) {
    console.error("Error fetching workers:", err);
    return [];
  }
}

export async function fetchRequestsSnapshot(
  baseUrl: string,
  authToken?: string,
): Promise<{ requests: RequestSnapshotRow[]; counts: QueueCounts }> {
  try {
    const response = await fetch(`${baseUrl}/requests?limit=250`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return { requests: [], counts: {} };
    const payload = (await response.json()) as {
      ok: boolean;
      requests?: RequestSnapshotRow[];
      counts?: QueueCounts;
    };
    return {
      requests: Array.isArray(payload.requests) ? payload.requests : [],
      counts: payload.counts ?? {},
    };
  } catch (err) {
    console.error("Error fetching requests snapshot:", err);
    return { requests: [], counts: {} };
  }
}

export async function fetchJobsSnapshot(
  baseUrl: string,
  authToken?: string,
): Promise<{ jobs: JobSnapshotRow[]; counts: QueueCounts }> {
  try {
    const response = await fetch(`${baseUrl}/jobs?limit=250`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return { jobs: [], counts: {} };
    const payload = (await response.json()) as {
      ok: boolean;
      jobs?: JobSnapshotRow[];
      counts?: QueueCounts;
    };
    return {
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      counts: payload.counts ?? {},
    };
  } catch (err) {
    console.error("Error fetching jobs snapshot:", err);
    return { jobs: [], counts: {} };
  }
}

export async function fetchCompletionsSnapshot(
  baseUrl: string,
  authToken?: string,
): Promise<{ completions: CompletionSnapshotRow[]; counts: QueueCounts }> {
  try {
    const response = await fetch(`${baseUrl}/completions?limit=250`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return { completions: [], counts: {} };
    const payload = (await response.json()) as {
      ok: boolean;
      completions?: CompletionSnapshotRow[];
      counts?: QueueCounts;
    };
    return {
      completions: Array.isArray(payload.completions) ? payload.completions : [],
      counts: payload.counts ?? {},
    };
  } catch (err) {
    console.error("Error fetching completions snapshot:", err);
    return { completions: [], counts: {} };
  }
}

export async function fetchSystemStatus(
  baseUrl: string,
  authToken?: string,
): Promise<{
  workers?: { total: number; online: number; busy: number; idle: number };
  queues?: {
    requests?: QueueCounts;
    jobs?: QueueCounts;
    completions?: QueueCounts;
  };
  ts?: string;
}> {
  try {
    const response = await fetch(`${baseUrl}/system/status`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as {
      ok: boolean;
      workers?: { total: number; online: number; busy: number; idle: number };
      queues?: {
        requests?: QueueCounts;
        jobs?: QueueCounts;
        completions?: QueueCounts;
      };
      ts?: string;
    };
    return {
      workers: payload.workers,
      queues: payload.queues,
      ts: payload.ts,
    };
  } catch (err) {
    console.error("Error fetching system status:", err);
    return {};
  }
}

/**
 * Send a command to the session (agent-friendly ingest endpoint).
 * Requires auth token.
 */
export async function sendCommand(
  baseUrl: string,
  sessionId: string,
  command: {
    type: string;
    payload: Record<string, unknown>;
    from?: string;
    to?: string;
    correlationId?: string;
    turnId?: string;
    parentId?: string;
  },
  authToken?: string,
): Promise<{ ok: boolean; eventId?: string }> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

    const response = await fetch(`${baseUrl}/sessions/${sessionId}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify(command),
    });

    if (!response.ok) return { ok: false };
    return await response.json();
  } catch (err) {
    console.error("Error sending command:", err);
    return { ok: false };
  }
}
