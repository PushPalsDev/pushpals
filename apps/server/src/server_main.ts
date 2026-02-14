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

const sharedDbPath = process.env.PUSHPALS_DB_PATH ?? join(dataDir, "pushpals.db");
const sessionManager = new SessionManager(sharedDbPath);
const jobQueue = new JobQueue(sharedDbPath);
const requestQueue = new RequestQueue(sharedDbPath);
const completionQueue = new CompletionQueue(sharedDbPath);

/**
 * HTTP Middleware & Routes
 */

export function createRequestHandler() {
  const isDebugEnabled = (value: string | undefined): boolean => {
    const normalized = (value ?? "").trim().toLowerCase();
    return (
      normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
    );
  };
  // Only explicit PushPals flag enables noisy poll/log endpoint printing.
  // Avoid inheriting generic DEBUG from shells/tooling, which can spam logs.
  const debugHttpLogs = isDebugEnabled(process.env.PUSHPALS_DEBUG_HTTP);

  const envPort = parseInt(process.env.PUSHPALS_PORT ?? "", 10);
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : 3001;
  const staleClaimTtlMsRaw = parseInt(process.env.PUSHPALS_STALE_CLAIM_TTL_MS ?? "", 10);
  const staleClaimTtlMs =
    Number.isFinite(staleClaimTtlMsRaw) && staleClaimTtlMsRaw > 0
      ? Math.max(5_000, staleClaimTtlMsRaw)
      : 120_000;
  const staleClaimSweepIntervalMsRaw = parseInt(
    process.env.PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS ?? "",
    10,
  );
  const staleClaimSweepIntervalMs =
    Number.isFinite(staleClaimSweepIntervalMsRaw) && staleClaimSweepIntervalMsRaw > 0
      ? Math.max(1_000, staleClaimSweepIntervalMsRaw)
      : 5_000;
  let lastStaleRecoverySweepAt = 0;
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
      const parseLimit = (raw: string | null, fallback = 200): number => {
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(1, Math.min(500, parsed));
      };
      const parseCursor = (raw: string | null): number | null => {
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed;
      };
      const compactText = (value: unknown, maxChars = 500): string => {
        const text = String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return "";
        if (text.length <= maxChars) return text;
        return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
      };
      const maybeRecoverStaleClaims = (): void => {
        const nowMs = Date.now();
        if (nowMs - lastStaleRecoverySweepAt < staleClaimSweepIntervalMs) return;
        lastStaleRecoverySweepAt = nowMs;

        const recovered = jobQueue.recoverStaleClaimedJobs(staleClaimTtlMs);
        if (recovered.length === 0) return;

        for (const item of recovered) {
          console.warn(
            `[Server] Recovered stale claimed job ${item.jobId} (worker=${item.workerId ?? "unknown"})`,
          );
          const session = sessionManager.getSession(item.sessionId);
          if (!session) continue;

          const envelope: EventEnvelope<"job_failed"> = {
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: item.recoveredAt,
            sessionId: item.sessionId,
            type: "job_failed",
            from: "server:stale-claim-recovery",
            payload: {
              jobId: item.jobId,
              message: item.message,
              detail: item.detail,
            },
          };
          session.emit(envelope);
        }
      };

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: jsonHeaders,
        });
      }

      // Noisy poll endpoints: only log these at debug level.
      const isNoisyPoll =
        (method === "POST" &&
          /^\/+((jobs|requests|completions)\/claim|workers\/heartbeat|sessions\/[^/]+\/command|jobs\/[^/]+\/log)\/?$/.test(
            pathname,
          )) ||
        (method === "GET" &&
          /^\/+(workers|system\/status|requests|jobs|completions|jobs\/[^/]+\/logs)(\/)?$/.test(
            pathname,
          ));
      if (isNoisyPoll) {
        if (debugHttpLogs) console.log(`[${method}] ${pathname}`);
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

        // Parse cursor from query string. If the client cursor is ahead of the
        // server cursor (for example after local storage survives a DB reset),
        // reset replay to full history so status cards do not get stuck.
        const afterParam = url.searchParams.get("after");
        const requestedAfterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;
        const latestCursor = session.getLatestCursor();
        const afterEventId =
          requestedAfterEventId > latestCursor ? 0 : Math.max(0, requestedAfterEventId);
        if (requestedAfterEventId > latestCursor) {
          console.warn(
            `[SSE] Session ${sessionId} requested cursor ${requestedAfterEventId} > latest ${latestCursor}; resetting replay to 0`,
          );
        }

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let pingInterval: NodeJS.Timeout | null = null;

        const readableStream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Send initial keepalive
            controller.enqueue(encoder.encode(": keepalive\n\n"));

            // Replay history from SQLite (cursor-based)
            session.replayHistory((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify({ envelope, cursor: eventId })}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
              } catch (_e) {}
            }, afterEventId);

            // Subscribe to live events
            unsubscribe = session.subscribe((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify({ envelope, cursor: eventId })}\n\n`;
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
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return makeJson({ ok: false, message: "Session not found" }, 404);
        }

        // Same cursor reset behavior as SSE path.
        const afterParam = url.searchParams.get("after");
        const requestedAfterEventId = afterParam ? parseInt(afterParam, 10) || 0 : 0;
        const latestCursor = session.getLatestCursor();
        const afterEventId =
          requestedAfterEventId > latestCursor ? 0 : Math.max(0, requestedAfterEventId);
        if (requestedAfterEventId > latestCursor) {
          console.warn(
            `[WS] Session ${sessionId} requested cursor ${requestedAfterEventId} > latest ${latestCursor}; resetting replay to 0`,
          );
        }

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
        maybeRecoverStaleClaims();

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const workerId = (body.workerId as string) || "unknown";
        const result = jobQueue.claim(workerId);
        return makeJson(result, result.ok ? 200 : 404);
      }

      // POST /workers/heartbeat
      if (pathname === "/workers/heartbeat" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.heartbeat(body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // GET /workers
      if (pathname === "/workers" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        return makeJson({ ok: true, workers });
      }

      // GET /system/status
      if (pathname === "/system/status" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        const onlineWorkers = workers.filter((w) => w.isOnline);
        const busyWorkers = workers.filter((w) => w.status === "busy").length;

        return makeJson({
          ok: true,
          ts: new Date().toISOString(),
          workers: {
            total: workers.length,
            online: onlineWorkers.length,
            busy: busyWorkers,
            idle: Math.max(0, onlineWorkers.length - busyWorkers),
          },
          queues: {
            requests: requestQueue.countByStatus(),
            requestPriorities: requestQueue.countByPriority(),
            requestPendingSnapshot: requestQueue.nextPendingSnapshot(10),
            jobs: jobQueue.countByStatus(),
            jobPriorities: jobQueue.countByPriority(),
            jobPendingSnapshot: jobQueue.nextPendingSnapshot(10),
            completions: completionQueue.countByStatus(),
          },
          slo: {
            requests: requestQueue.sloSummary(24),
            jobs: jobQueue.sloSummary(24),
          },
        });
      }

      // GET /requests
      if (pathname === "/requests" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (!["all", "pending", "claimed", "completed", "failed"].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }

        const requests = requestQueue.listRequests({
          status: status as "all" | "pending" | "claimed" | "completed" | "failed",
          limit,
        });

        return makeJson({
          ok: true,
          requests,
          counts: requestQueue.countByStatus(),
          priorityCounts: requestQueue.countByPriority(),
          pendingSnapshot: requestQueue.nextPendingSnapshot(10),
          slo: requestQueue.sloSummary(24),
        });
      }

      // GET /jobs
      if (pathname === "/jobs" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (!["all", "pending", "claimed", "completed", "failed"].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }

        const jobs = jobQueue.listJobs({
          status: status as "all" | "pending" | "claimed" | "completed" | "failed",
          limit,
        });

        return makeJson({
          ok: true,
          jobs,
          counts: jobQueue.countByStatus(),
          priorityCounts: jobQueue.countByPriority(),
          pendingSnapshot: jobQueue.nextPendingSnapshot(10),
          slo: jobQueue.sloSummary(24),
        });
      }

      // GET /jobs/:id/logs
      const jobLogsMatch = pathname.match(/^\/jobs\/([^/]+)\/logs$/);
      if (jobLogsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const jobId = jobLogsMatch[1];
        const limit = parseLimit(url.searchParams.get("limit"), 50);
        const afterId = parseCursor(url.searchParams.get("afterId"));
        const logs = jobQueue.listJobLogs(jobId, limit, afterId ?? undefined);
        const nextCursor = logs.length > 0 ? logs[logs.length - 1]?.id ?? null : afterId;
        return makeJson({ ok: true, jobId, logs, cursor: nextCursor });
      }

      // GET /completions
      if (pathname === "/completions" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (!["all", "pending", "claimed", "processed", "failed"].includes(status)) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }

        const completions = completionQueue.listCompletions({
          status: status as "all" | "pending" | "claimed" | "processed" | "failed",
          limit,
        });

        return makeJson({
          ok: true,
          completions,
          counts: completionQueue.countByStatus(),
        });
      }

      // POST /jobs/:id/complete
      const jobCompleteMatch = pathname.match(/^\/jobs\/([^/]+)\/complete$/);
      if (jobCompleteMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobCompleteMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.complete(jobId, body);
        if (result.ok) {
          const durationText =
            typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} completed (${durationText})`);
        }
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
        if (result.ok) {
          const durationText =
            typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} failed (${durationText})`);

          const job = jobQueue.getJob(jobId);
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            if (session) {
              const message = compactText(body.message, 240) || "WorkerPal job failed";
              const detail = compactText(body.detail, 600);
              const envelope: EventEnvelope<"job_failed"> = {
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID(),
                ts: new Date().toISOString(),
                sessionId: job.sessionId,
                type: "job_failed",
                from: "server:job-fail-hook",
                payload: {
                  jobId,
                  message,
                  ...(detail ? { detail } : {}),
                },
              };
              session.emit(envelope);
            }
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /jobs/:id/log
      const jobLogMatch = pathname.match(/^\/jobs\/([^/]+)\/log$/);
      if (jobLogMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobLogMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const message =
          typeof body.message === "string"
            ? body.message
            : typeof body.line === "string"
              ? body.line
              : "";
        const trimmed = message.trim();
        if (!trimmed) {
          return makeJson({ ok: false, message: "message is required" }, 400);
        }
        const logId = jobQueue.addLog(jobId, trimmed);
        return makeJson({ ok: true, jobId, logId }, 200);
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
            ws.send(JSON.stringify({ envelope, cursor: 0 }));
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
