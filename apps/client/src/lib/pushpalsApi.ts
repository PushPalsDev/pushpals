import { EventEnvelope, validateEventEnvelope } from "protocol";

type TransportType = "auto" | "sse" | "ws";
type EventCallback = (event: EventEnvelope | { type: "_error"; message: string }) => void;

/**
 * Determine which transport to use based on platform
 */
function selectTransport(transport: TransportType): "sse" | "ws" {
  if (transport !== "auto") return transport;

  // Check if we're in a browser with EventSource support
  const isBrowser =
    typeof window !== "undefined" && typeof EventSource !== "undefined";

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
  onEvent: EventCallback
): () => void {
  const eventSource = new EventSource(
    `${baseUrl}/sessions/${sessionId}/events`
  );

  eventSource.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      const validation = validateEventEnvelope(data);

      if (!validation.ok) {
        onEvent({
          type: "_error",
          message: `[Protocol error] ${validation.errors?.join("; ")}`,
        });
        return;
      }

      onEvent(data);
    } catch (err) {
      onEvent({
        type: "_error",
        message: `[Parse error] Failed to parse event: ${String(err)}`,
      });
    }
  });

  eventSource.onerror = () => {
    onEvent({
      type: "_error",
      message: "[SSE error] Connection lost",
    });
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}

/**
 * Subscribe to session events over WebSocket
 */
function subscribeWebSocket(
  baseUrl: string,
  sessionId: string,
  onEvent: EventCallback
): () => void {
  const protocol = baseUrl.startsWith("https") ? "wss" : "ws";
  const host = baseUrl.replace(/^https?:\/\//, "");
  const wsUrl = `${protocol}://${host}/sessions/${sessionId}/ws`;

  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const validation = validateEventEnvelope(data);

      if (!validation.ok) {
        onEvent({
          type: "_error",
          message: `[Protocol error] ${validation.errors?.join("; ")}`,
        });
        return;
      }

      onEvent(data);
    } catch (err) {
      onEvent({
        type: "_error",
        message: `[Parse error] Failed to parse event: ${String(err)}`,
      });
    }
  };

  ws.onerror = () => {
    onEvent({
      type: "_error",
      message: "[WebSocket error] Connection failed",
    });
  };

  ws.onclose = () => {
    onEvent({
      type: "_error",
      message: "[WebSocket] Connection closed",
    });
  };

  return () => {
    if (ws.readyState === WebSocket.OPEN) {
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
 * @param onEvent Callback for each event (or error)
 * @param transport Transport selection: "auto", "sse", or "ws" (default: "auto")
 * @returns Unsubscribe function
 */
export function subscribeEvents(
  baseUrl: string,
  sessionId: string,
  onEvent: EventCallback,
  transport: TransportType = "auto"
): () => void {
  const selectedTransport = selectTransport(transport);

  console.log(`[PushPals] Subscribing to session ${sessionId} via ${selectedTransport}`);

  if (selectedTransport === "sse") {
    return subscribeSSE(baseUrl, sessionId, onEvent);
  } else {
    return subscribeWebSocket(baseUrl, sessionId, onEvent);
  }
}

/**
 * Create a new session on the server
 */
export async function createSession(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
 * Send a message to a session
 */
export async function sendMessage(
  baseUrl: string,
  sessionId: string,
  text: string
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    return response.ok;
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
  decision: "approve" | "deny"
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
