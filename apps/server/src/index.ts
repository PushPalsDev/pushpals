import { EventEnvelope, PROTOCOL_VERSION } from "protocol";
import { SessionManager } from "./events.js";
import { JobQueue } from "./jobs.js";
import { RequestQueue } from "./requests.js";
import { CompletionQueue } from "./completions.js";
import { randomUUID } from "crypto";
import { resolve, join } from "path";
import { mkdirSync } from "fs";

// ─── Data directory ─────────────────────────────────────────────────────────
const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
const dataDir = process.env.PUSHPALS_DATA_DIR ?? join(PROJECT_ROOT, "outputs", "data");
mkdirSync(dataDir, { recursive: true });

const sessionManager = new SessionManager(
  process.env.PUSHPALS_DB_PATH ?? join(dataDir, "pushpals.db"),
);
const jobQueue = new JobQueue();
const requestQueue = new RequestQueue(join(dataDir, "pushpals.db"));
const completionQueue = new CompletionQueue(join(dataDir, "pushpals.db"));

/**
 * HTTP Middleware & Routes
 */

export function createRequestHandler() {
  const envPort = parseInt(process.env.PUSHPALS_PORT ?? "", 10);
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : 3001;
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 180, // 3 minutes — SSE/WS connections are long-lived

    async fetch(req: Request, server): Promise<Response> {
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

      // Noisy poll endpoints — only log at debug level
      const isNoisyPoll = pathname === "/jobs/claim";
      if (isNoisyPoll) {
        if (process.env.DEBUG) console.log(`[${method}] ${pathname}`);
      } else {
        console.log(`[${method}] ${pathname}`);
      }

      // ── Auth helper ──────────────────────────────────────────────────────
      const requireAuth = (): Response | null => {
        const authHeader = req.headers.get("authorization");
        if (!sessionManager.validateAuth(authHeader)) {
          return makeJson({ ok: false, message: "Unauthorized" }, 401);
        }
        return null;
      };

      // GET /healthz
      if (pathname === "/healthz" && method === "GET") {
        return makeJson({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }

      // POST /sessions - Create (or join) a session
      if (pathname === "/sessions" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const raw = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        const requestedId = raw.length > 0 ? raw : undefined;
        const result = sessionManager.createSession(requestedId);
        if (result.id === null) {
          return makeJson(
            {
              ok: false,
              message: "Invalid sessionId: must contain only [a-zA-Z0-9._-] and be 1\u201364 chars",
            },
            400,
          );
        }
        return makeJson(
          { sessionId: result.id, protocolVersion: PROTOCOL_VERSION },
          result.created ? 201 : 200,
        );
      }

      // GET /sessions/:id/events - SSE endpoint (supports ?after=<cursor> for replay)
      const sseMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (sseMatch && method === "GET") {
        const sessionId = sseMatch[1];
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return makeJson({ ok: false, message: "Session not found" }, 404);
        }

        // Parse cursor from query string
        const afterParam = url.searchParams.get("after");
        const afterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let pingInterval: NodeJS.Timeout | null = null;

        const readableStream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Send initial keepalive
            controller.enqueue(encoder.encode(": keepalive\n\n"));

            // Replay history from SQLite (cursor-based)
            session.replayHistory((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
              } catch (_e) {}
            }, afterEventId);

            // Subscribe to live events
            unsubscribe = session.subscribe((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
              } catch (err) {
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
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "content-type, authorization",
          },
        });
      }

      // GET /sessions/:id/ws - WebSocket endpoint (supports ?after=<cursor>)
      const wsMatch = pathname.match(/^\/sessions\/([^/]+)\/ws$/);
      if (wsMatch && method === "GET") {
        const sessionId = wsMatch[1];

        // Parse cursor from query string
        const afterParam = url.searchParams.get("after");
        const afterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;

        const success = server.upgrade(req, {
          data: { sessionId, afterEventId } as any,
        });

        if (success) {
          return new Response(null);
        }

        return makeJson({ ok: false, message: "WebSocket upgrade failed" }, 400);
      }

      // POST /sessions/:id/message  (UI convenience)
      const msgMatch = pathname.match(/^\/sessions\/([^/]+)\/message$/);
      if (msgMatch && method === "POST") {
        const sessionId = msgMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        sessionManager.handleMessage(sessionId, body);
        return makeJson({ ok: true });
      }

      // POST /sessions/:id/command  (agent-friendly ingest — auth protected)
      const cmdMatch = pathname.match(/^\/sessions\/([^/]+)\/command$/);
      if (cmdMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const sessionId = cmdMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = sessionManager.handleCommand(sessionId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /approvals/:approvalId  (auth protected)
      const approvalMatch = pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const approvalId = approvalMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const decision = body.decision as string;

        if (decision !== "approve" && decision !== "deny") {
          return makeJson({ ok: false, message: "Invalid decision value" }, 400);
        }

        const result = sessionManager.handleApprovalDecision(
          approvalId,
          decision as "approve" | "deny",
        );
        return makeJson(result, result.ok ? 200 : 400);
      }

      // ── Job queue endpoints (auth protected) ────────────────────────────

      // POST /jobs/enqueue
      if (pathname === "/jobs/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }

      // POST /jobs/claim
      if (pathname === "/jobs/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const workerId = (body.workerId as string) || "unknown";
        const result = jobQueue.claim(workerId);
        return makeJson(result, result.ok ? 200 : 404);
      }

      // POST /jobs/:id/complete
      const jobCompleteMatch = pathname.match(/^\/jobs\/([^/]+)\/complete$/);
      if (jobCompleteMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobCompleteMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.complete(jobId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /jobs/:id/fail
      const jobFailMatch = pathname.match(/^\/jobs\/([^/]+)\/fail$/);
      if (jobFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobFailMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.fail(jobId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // ── Request queue endpoints (auth protected) ────────────────────────────

      // POST /requests/enqueue
      if (pathname === "/requests/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = requestQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }

      // POST /requests/claim
      if (pathname === "/requests/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const agentId = (body.agentId as string) || "unknown";
        const result = requestQueue.claim(agentId);
        return makeJson(result, result.ok ? 200 : 404);
      }

      // POST /requests/:id/complete
      const reqCompleteMatch = pathname.match(/^\/requests\/([^/]+)\/complete$/);
      if (reqCompleteMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const requestId = reqCompleteMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = requestQueue.complete(requestId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /requests/:id/fail
      const reqFailMatch = pathname.match(/^\/requests\/([^/]+)\/fail$/);
      if (reqFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const requestId = reqFailMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = requestQueue.fail(requestId, body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // ── Completion queue endpoints (auth protected) ─────────────────────────

      // POST /completions/enqueue
      if (pathname === "/completions/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = completionQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }

      // POST /completions/claim
      if (pathname === "/completions/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const pusherId = (body.pusherId as string) || "unknown";
        const result = completionQueue.claim(pusherId);
        return makeJson(result, result.ok ? 200 : 404);
      }

      // POST /completions/:id/processed
      const compProcMatch = pathname.match(/^\/completions\/([^/]+)\/processed$/);
      if (compProcMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const completionId = compProcMatch[1];
        const result = completionQueue.markProcessed(completionId);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /completions/:id/fail
      const compFailMatch = pathname.match(/^\/completions\/([^/]+)\/fail$/);
      if (compFailMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const completionId = compFailMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const error = (body.error as string) ?? "Unknown error";
        const result = completionQueue.markFailed(completionId, error);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // 404
      return makeJson({ ok: false, message: "Not found" }, 404);
    },

    websocket: {
      open(ws: any) {
        const { sessionId, afterEventId = 0 } = ws.data || {};
        console.log(`[WS] Session ${sessionId} connected (after=${afterEventId})`);

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          try {
            const envelope: EventEnvelope<"error"> = {
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId: sessionId,
              type: "error",
              payload: { message: "Session not found" },
            };
            ws.send(JSON.stringify(envelope));
          } catch (_e) {}
          try {
            ws.close();
          } catch (_e) {}
          return;
        }

        // Replay history from SQLite (cursor-based)
        session.replayHistory((envelope: EventEnvelope, eventId: number) => {
          try {
            ws.send(JSON.stringify({ envelope, cursor: eventId }));
          } catch (_e) {}
        }, afterEventId);

        // Subscribe to live events and send to this WebSocket
        const unsubscribe = session.subscribe((envelope: EventEnvelope, eventId: number) => {
          try {
            ws.send(JSON.stringify({ envelope, cursor: eventId }));
          } catch (_err) {
            try {
              unsubscribe();
            } catch (_e) {}
          }
        });

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
        console.log(`[WS] Session ${sessionId} message:`, message);
      },
    },
  });
}

export { sessionManager, jobQueue };

// If this file is executed directly, start the server.
if (import.meta.main) {
  const server = createRequestHandler();
  console.log(`[Server] PushPals listening on ${server.url}`);
}
