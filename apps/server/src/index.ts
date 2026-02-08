import { EventEnvelope, PROTOCOL_VERSION } from "protocol";
import { SessionManager } from "./events.js";
import { randomUUID } from "crypto";

const sessionManager = new SessionManager();

/**
 * HTTP Middleware & Routes
 */

export function createRequestHandler() {
  return Bun.serve({
    port: 3001,
    hostname: "0.0.0.0",

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;

      // Common JSON headers (CORS + no-store cache)
      const jsonHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Cache-Control": "no-store",
      };

      const makeJson = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: jsonHeaders });

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: jsonHeaders,
        });
      }

      console.log(`[${method}] ${pathname}`);

      // GET /healthz
      if (pathname === "/healthz" && method === "GET") {
        return makeJson({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }

      // POST /sessions - Create a new session
      if (pathname === "/sessions" && method === "POST") {
        const sessionId = sessionManager.createSession();
        return makeJson({ sessionId, protocolVersion: PROTOCOL_VERSION }, 201);
      }

      // GET /sessions/:id/events - SSE endpoint
      const sseMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (sseMatch && method === "GET") {
        const sessionId = sseMatch[1];
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return makeJson({ ok: false, message: "Session not found" }, 404);
        }

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let pingInterval: NodeJS.Timeout | null = null;

        const readableStream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Send initial keepalive
            controller.enqueue(encoder.encode(": keepalive\n\n"));

            // Subscribe to events
            unsubscribe = session.subscribe((envelope: EventEnvelope) => {
              const eventData = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
              } catch (err) {
                // On enqueue failure, clear interval, unsubscribe, and close stream
                if (pingInterval) clearInterval(pingInterval);
                if (unsubscribe) unsubscribe();
                try {
                  controller.close();
                } catch (_e) {}
              }
            });

            // Keepalive ping every 15 seconds
            pingInterval = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch (_err) {
                // Stream closed or enqueue failed: clear interval and unsubscribe
                if (pingInterval) clearInterval(pingInterval);
                if (unsubscribe) unsubscribe();
              }
            }, 15000);
          },
          cancel() {
            if (pingInterval) clearInterval(pingInterval);
            if (unsubscribe) unsubscribe();
          },
        });

        return new Response(readableStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "content-type, authorization",
          },
        });
      }

      // GET /sessions/:id/ws - WebSocket endpoint
      const wsMatch = pathname.match(/^\/sessions\/([^/]+)\/ws$/);
      if (wsMatch && method === "GET") {
        const sessionId = wsMatch[1];

        // Bun.upgrade upgrades the request to WebSocket
        // Only pass the sessionId in ws.data to avoid sharing session object
        // @ts-ignore - Bun.upgrade is available at runtime
        const success = Bun.upgrade(req, {
          data: { sessionId },
        });

        if (success) {
          return new Response(null);
        }

        return makeJson({ ok: false, message: "WebSocket upgrade failed" }, 400);
      }

      // POST /sessions/:id/message
      const msgMatch = pathname.match(/^\/sessions\/([^/]+)\/message$/);
      if (msgMatch && method === "POST") {
        const sessionId = msgMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        sessionManager.handleMessage(sessionId, (body.text as string) || "");
        return makeJson({ ok: true });
      }

      // POST /approvals/:approvalId
      const approvalMatch = pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "POST") {
        const approvalId = approvalMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const decision = body.decision as string;

        // Validate decision is one of the allowed values
        if (decision !== "approve" && decision !== "deny") {
          return makeJson({ ok: false, message: "Invalid decision value" }, 400);
        }

        const result = sessionManager.handleApprovalDecision(
          approvalId,
          decision as "approve" | "deny"
        );
        return makeJson(result, result.ok ? 200 : 400);
      }

      // 404
      return makeJson({ ok: false, message: "Not found" }, 404);
    },

    websocket: {
      open(ws: any) {
        const { sessionId } = ws.data || {};
        console.log(`[WS] Session ${sessionId} connected`);

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          try {
            const envelope: EventEnvelope = {
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId: sessionId,
              type: "error",
              payload: { message: "Session not found" },
            } as unknown as EventEnvelope;
            ws.send(JSON.stringify(envelope));
          } catch (_e) {}
          try {
            ws.close();
          } catch (_e) {}
          return;
        }

        // Subscribe to session events and send to this WebSocket
        const unsubscribe = session.subscribe((envelope: EventEnvelope) => {
          try {
            ws.send(JSON.stringify(envelope));
          } catch (_err) {
            // WebSocket closed
            try {
              unsubscribe();
            } catch (_e) {}
          }
        });

        // Store unsubscribe function for cleanup
        ws.data = { sessionId, unsubscribe };
      },
      close(ws: any) {
        const { sessionId, unsubscribe } = ws.data || {};
        console.log(`[WS] Session ${sessionId} disconnected`);
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (_e) {}
        }
      },
      message(ws: any, message: any) {
        const { sessionId } = ws.data || {};
        // Handle incoming messages (optional for MVP)
        console.log(`[WS] Session ${sessionId} message:`, message);
      },
    },
  });
}

export { sessionManager };

// If this file is executed directly, start the server.
if (import.meta.main) {
  // Start the Bun server
  createRequestHandler();
}
