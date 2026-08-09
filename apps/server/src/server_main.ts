import { EventEnvelope, PROTOCOL_VERSION } from "protocol";
import { SessionManager, type SessionMessageResult } from "./events.js";
import { JobQueue } from "./jobs.js";
import { RequestQueue } from "./requests.js";
import { CompletionQueue } from "./completions.js";
import { AutonomyStore } from "./autonomy.js";
import {
  ClientPresenceRegistry,
  readClientPresenceFromSessionBody,
  readClientPresenceFromTransportRequest,
} from "./client_presence.js";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import {
  buildLocalCorsHeaders,
  invalidatePushPalsConfigCache,
  inferGitBackendFromRemote,
  isLoopbackOrigin,
  loadPushPalsConfig,
  sanitizePushPalsConfigForLogging,
  sanitizeGitRemoteUrl,
  toGitHubRepoWebUrl,
} from "shared";
import {
  applyRuntimeConfigMutations,
  describeRuntimeConfigFiles,
  getRuntimeConfigFiles,
  type RuntimeConfigMutation,
} from "./runtime_config.js";
import { deriveRuntimeConfigImpact } from "./runtime_config_policy.js";
import { resolveRequestAuthHeader } from "./request_auth.js";
import { extractAutonomyPayloadDetails } from "./autonomy_payload.js";

// ─── Data directory ─────────────────────────────────────────────────────────
const STARTUP_CONFIG = loadPushPalsConfig();
const dataDir = STARTUP_CONFIG.paths.dataDir;
mkdirSync(dataDir, { recursive: true });

const sharedDbPath = STARTUP_CONFIG.paths.sharedDbPath;
const sessionManager = new SessionManager(sharedDbPath);
const jobQueue = new JobQueue(sharedDbPath);
const requestQueue = new RequestQueue(sharedDbPath);
const completionQueue = new CompletionQueue(sharedDbPath);
const autonomyStore = new AutonomyStore(sharedDbPath);
const lifecycleReconciliation = autonomyStore.reconcileJobLinkedOutcomeLifecycle();
if (
  lifecycleReconciliation.correctedFailures > 0 ||
  lifecycleReconciliation.removedPrematureSuccesses > 0 ||
  lifecycleReconciliation.correctedObjectives > 0
) {
  console.warn(
    `[Server] Reconciled legacy completion lifecycle state: ${JSON.stringify(lifecycleReconciliation)}`,
  );
}
const clientPresence = new ClientPresenceRegistry();
const clientPresencePruneTimer = setInterval(() => {
  const removed = clientPresence.pruneExpired();
  if (removed > 0) {
    console.log(`[Client] pruned ${removed} stale presence record(s)`);
  }
}, 60_000);
clientPresencePruneTimer.unref?.();
sessionManager.authToken = null;
sessionManager.setClientMessageIngress((sessionId, accepted) => {
  const budgetStatus = getSessionTokenBudgetStatus(sessionId);
  if (budgetStatus?.exceeded) {
    return {
      ok: false,
      message: sessionTokenBudgetMessage(budgetStatus),
    };
  }
  const enqueueResult = requestQueue.enqueue({
    sessionId,
    prompt: accepted.text,
    priority: "interactive",
  });
  if (!enqueueResult.ok) {
    return {
      ok: false,
      message: enqueueResult.message || "Failed to enqueue request",
    };
  }
  return {
    ok: true,
    requestId: enqueueResult.requestId,
    queuePosition: enqueueResult.queuePosition,
    etaMs: enqueueResult.etaMs,
  };
});
const REPO_STATUS_CACHE_TTL_MS = 60_000;
const SERVER_STARTED_AT_MS = Date.now();
const SERVER_STARTED_AT_ISO = new Date(SERVER_STARTED_AT_MS).toISOString();
const AUTONOMY_BUSY_QUEUE_MAX_REQUESTS = 5;
const AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS = 10;
const AUTONOMY_WORKER_TTL_MS = 15_000;
const AUTONOMY_WORKER_FAILURE_CIRCUIT_WINDOW_MS = 60 * 60 * 1000;
const AUTONOMY_WORKER_FAILURE_CIRCUIT_THRESHOLD = 3;
const AUTONOMY_WORKER_FAILURE_CIRCUIT_RATE = 0.5;
const AUTONOMY_WORKER_FAILURE_DEFER_MS = 30 * 60 * 1000;
const AUTONOMY_SIMILAR_FAILURE_WINDOW_MS = 6 * 60 * 60 * 1000;
const AUTONOMY_SIMILAR_FAILURE_THRESHOLD = 2;
const AUTONOMY_SIMILAR_FAILURE_DEFER_MS = 30 * 60 * 1000;
const CLIENT_TRANSPORT_HEARTBEAT_MS = 15_000;
const SESSION_TOKEN_BUDGET = Math.max(0, STARTUP_CONFIG.server.sessionTokenBudget);

function getSessionTokenBudgetStatus(sessionIdRaw: unknown) {
  const sessionId = String(sessionIdRaw ?? "").trim();
  if (!sessionId || SESSION_TOKEN_BUDGET <= 0) return null;
  return autonomyStore.getSessionTokenBudgetStatus(
    sessionId,
    SESSION_TOKEN_BUDGET,
    STARTUP_CONFIG.server.sessionTokenBudgetAction,
  );
}

function sessionTokenBudgetMessage(
  status: NonNullable<ReturnType<typeof getSessionTokenBudgetStatus>>,
): string {
  return (
    `Session token budget exceeded for ${status.sessionId}: ` +
    `${status.totalTokens}/${status.limit} tokens used. ` +
    "PushPals is pausing new work for this session."
  );
}

function emitSessionBudgetPauseNotice(
  sessionIdRaw: unknown,
  status: NonNullable<ReturnType<typeof getSessionTokenBudgetStatus>>,
): void {
  const sessionId = String(sessionIdRaw ?? "").trim();
  if (!sessionId) return;
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  const message = sessionTokenBudgetMessage(status);
  session.emit({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId,
    type: "assistant_message",
    from: "system",
    payload: { text: message },
  });
  session.emit({
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId,
    type: "status",
    from: "system",
    payload: {
      agentId: "pushpals-budget",
      state: "idle",
      detail: message,
    },
  });
}

export function sessionMessageResultStatus(result: SessionMessageResult): number {
  if (result.ok) return 200;
  if (result.code === "session_not_found") return 404;
  return 400;
}

interface RepoStatusSummary {
  root: string;
  remote: string;
  remoteUrl: string | null;
  browserUrl: string | null;
  provider: "github" | "gitlab" | "unknown";
  refreshedAt: string;
}

let repoStatusCache: {
  value: RepoStatusSummary;
  fetchedAtMs: number;
} | null = null;

async function resolveRemoteUrl(repoPath: string, remote: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "remote", "get-url", remote], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    console.warn(`[Server] Failed to resolve git remote URL (${remote}): ${detail}`);
    return "";
  }
  return stdout.trim();
}

async function getRepoStatusSummary(repoPath: string, remote: string): Promise<RepoStatusSummary> {
  const now = Date.now();
  if (
    repoStatusCache &&
    repoStatusCache.value.remote === remote &&
    now - repoStatusCache.fetchedAtMs < REPO_STATUS_CACHE_TTL_MS
  ) {
    return repoStatusCache.value;
  }

  const remoteUrlRaw = await resolveRemoteUrl(repoPath, remote);
  const remoteUrl = remoteUrlRaw ? sanitizeGitRemoteUrl(remoteUrlRaw) : null;
  const provider = inferGitBackendFromRemote(remoteUrl ?? "");
  const browserUrl = provider === "github" ? toGitHubRepoWebUrl(remoteUrl ?? "") : null;

  const value: RepoStatusSummary = {
    root: repoPath,
    remote,
    remoteUrl,
    browserUrl,
    provider,
    refreshedAt: new Date().toISOString(),
  };
  repoStatusCache = { value, fetchedAtMs: now };
  return value;
}

/**
 * HTTP Middleware & Routes
 */

export function createRequestHandler() {
  const startupConfig = loadPushPalsConfig();
  if (startupConfig.authToken) {
    console.warn("[Server] Ignoring configured auth token; PushPals runs in local-only mode.");
  }
  const port = startupConfig.server.port;
  const hostname = startupConfig.server.host;
  const isDebugHttpLogsEnabled = (): boolean => loadPushPalsConfig().server.debugHttp;
  let lastStaleRecoverySweepAt = 0;
  let isShuttingDown = false;
  return Bun.serve({
    port,
    hostname,
    idleTimeout: 180, // 3 minutes — SSE/WS connections are long-lived

    async fetch(req: Request, server): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method;
      const originHeader = req.headers.get("origin");
      if (originHeader && !isLoopbackOrigin(originHeader)) {
        return new Response(JSON.stringify({ ok: false, message: "Forbidden origin" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      const corsHeaders = buildLocalCorsHeaders({
        origin: originHeader,
        allowAuthorizationHeader: true,
      });

      // Common JSON headers (CORS + no-store cache)
      const jsonHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...corsHeaders,
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
      const parseBool = (raw: string | null, fallback = false): boolean => {
        const text = String(raw ?? "")
          .trim()
          .toLowerCase();
        if (!text) return fallback;
        if (["1", "true", "yes", "on"].includes(text)) return true;
        if (["0", "false", "no", "off"].includes(text)) return false;
        return fallback;
      };
      const compactText = (value: unknown, maxChars = 500): string => {
        const text = String(value ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return "";
        if (text.length <= maxChars) return text;
        return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
      };
      const parseJsonRecord = (value: unknown): Record<string, unknown> => {
        if (typeof value !== "string" || !value.trim()) return {};
        try {
          const parsed = JSON.parse(value) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // ignore malformed JSON payload
        }
        return {};
      };
      const deriveJobOrigin = (params: Record<string, unknown>): "user" | "autonomy" => {
        if (params.origin === "autonomy") return "autonomy";
        const autonomy = params.autonomy;
        return autonomy && typeof autonomy === "object" && !Array.isArray(autonomy)
          ? "autonomy"
          : "user";
      };
      const hasClarificationSignal = (value: string): boolean => {
        const text = value.toLowerCase();
        return (
          text.includes("clarification") ||
          text.includes("clarify") ||
          text.includes("follow-up question") ||
          text.includes("requested clarification")
        );
      };
      const hasNoChangeSignal = (value: string): boolean => {
        const text = value.toLowerCase();
        return (
          text.includes("no file changes") ||
          text.includes("no changes to commit") ||
          text.includes("no changes made") ||
          text.includes("nothing to commit") ||
          text.includes("modified 0 file") ||
          text.includes("no modified files were detected") ||
          text.includes("no file changes detected")
        );
      };
      const classifyAutonomyJobCompletion = (
        body: Record<string, unknown>,
      ): {
        success: boolean;
        userAction: "applied" | "no_change" | "needs_clarification";
        reopenedWithin24h: boolean;
        regressionFlag: boolean;
      } => {
        const parts: string[] = [];
        const summary = compactText(body.summary, 1400);
        if (summary) parts.push(summary);
        const detail = compactText(body.detail, 1400);
        if (detail) parts.push(detail);
        if (typeof body.result === "string") {
          parts.push(compactText(body.result, 1400));
        } else if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
          parts.push(compactText(JSON.stringify(body.result), 1800));
        }
        const artifacts = Array.isArray(body.artifacts)
          ? (body.artifacts.filter((entry) => entry && typeof entry === "object") as Array<
              Record<string, unknown>
            >)
          : [];
        for (const artifact of artifacts.slice(0, 8)) {
          const artifactText = compactText(artifact.text ?? artifact.message, 400);
          if (artifactText) parts.push(artifactText);
        }
        const combined = parts.join("\n");
        if (hasClarificationSignal(combined)) {
          return {
            success: false,
            userAction: "needs_clarification",
            reopenedWithin24h: true,
            regressionFlag: false,
          };
        }
        if (hasNoChangeSignal(combined)) {
          return {
            success: false,
            userAction: "no_change",
            reopenedWithin24h: true,
            regressionFlag: false,
          };
        }
        return {
          success: true,
          userAction: "applied",
          reopenedWithin24h: false,
          regressionFlag: false,
        };
      };
      const recordHasAutonomyOrigin = (value: unknown): boolean => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        const origin = String(record.origin ?? "")
          .trim()
          .toLowerCase();
        return origin === "autonomy";
      };
      const isAutonomyRequestPayload = (value: Record<string, unknown>): boolean =>
        [value.metadata, value.meta, value.params, value].some(recordHasAutonomyOrigin);
      const autonomyFailureCircuitSummary = () =>
        jobQueue.noPublishableFailureCircuitSummary({
          windowMs: AUTONOMY_WORKER_FAILURE_CIRCUIT_WINDOW_MS,
          threshold: AUTONOMY_WORKER_FAILURE_CIRCUIT_THRESHOLD,
          failureRateThreshold: AUTONOMY_WORKER_FAILURE_CIRCUIT_RATE,
        });
      const autonomyFailureCircuitMessage = (
        failureCircuit: ReturnType<typeof autonomyFailureCircuitSummary>,
      ): string =>
        `Autonomy enqueue blocked: WorkerPal produced ` +
        `${failureCircuit.noPublishableFailureCount} no-publishable/no-edit failure(s) ` +
        `across ${failureCircuit.terminalCount} recent terminal task(s).`;
      const makeAutonomyFailureCircuitResponse = (): Response | null => {
        const failureCircuit = autonomyFailureCircuitSummary();
        if (!failureCircuit.blocked) return null;
        return makeJson(
          {
            ok: false,
            code: "autonomy_worker_failure_circuit_open",
            message: autonomyFailureCircuitMessage(failureCircuit),
            retryAfterMs: AUTONOMY_WORKER_FAILURE_DEFER_MS,
            ...failureCircuit,
          },
          429,
        );
      };
      const autonomySimilarFailureSummary = (value: Record<string, unknown>) => {
        const details = extractAutonomyPayloadDetails(value);
        return jobQueue.similarFailureFingerprintSummary({
          targetPaths: details.targetPaths,
          windowMs: AUTONOMY_SIMILAR_FAILURE_WINDOW_MS,
          threshold: AUTONOMY_SIMILAR_FAILURE_THRESHOLD,
        });
      };
      const makeAutonomySimilarFailureResponse = (
        value: Record<string, unknown>,
      ): Response | null => {
        const similarFailure = autonomySimilarFailureSummary(value);
        if (!similarFailure.blocked) return null;
        return makeJson(
          {
            ok: false,
            code: "autonomy_similar_failure_suppressed",
            message:
              `Autonomy enqueue blocked: ${similarFailure.recentSimilarFailureCount} ` +
              `unchanged target-and-failure fingerprint occurrence(s) were observed recently. ` +
              `Dispatch one root-cause repair for this cluster or select another component.`,
            retryAfterMs: AUTONOMY_SIMILAR_FAILURE_DEFER_MS,
            ...similarFailure,
          },
          429,
        );
      };
      const parseRuntimeMutations = (value: unknown): RuntimeConfigMutation[] => {
        if (!Array.isArray(value)) return [];
        const out: RuntimeConfigMutation[] = [];
        for (const entry of value) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          const scope = String(record.scope ?? "")
            .trim()
            .toLowerCase();
          const key = String(record.key ?? "").trim();
          if ((scope !== "env" && scope !== "toml") || !key) continue;
          out.push({
            scope: scope as "env" | "toml",
            key,
            value: record.value,
          });
        }
        return out;
      };
      const maybeRecoverStaleClaims = (): void => {
        const runtimeConfig = loadPushPalsConfig();
        const staleClaimTtlMs = runtimeConfig.server.staleClaimTtlMs;
        const staleClaimSweepIntervalMs = runtimeConfig.server.staleClaimSweepIntervalMs;
        const nowMs = Date.now();
        if (nowMs - lastStaleRecoverySweepAt < staleClaimSweepIntervalMs) return;
        lastStaleRecoverySweepAt = nowMs;
        autonomyStore.maybeSweepStaleObjectives();

        const recovered = jobQueue.recoverStaleClaimedJobs(staleClaimTtlMs);
        if (recovered.length === 0) return;

        for (const item of recovered) {
          if (item.action === "requeued") {
            console.warn(
              `[Server] Requeued retry-safe stale claimed job ${item.jobId} as ${item.replacementJobId ?? "unknown"} (worker=${item.workerId ?? "unknown"})`,
            );
          } else {
            console.warn(
              `[Server] Recovered stale claimed job ${item.jobId} (worker=${item.workerId ?? "unknown"})`,
            );
          }
          const session = sessionManager.getSession(item.sessionId);
          if (!session) continue;

          if (item.action === "requeued") {
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: item.recoveredAt,
              sessionId: item.sessionId,
              type: "log",
              from: "server:stale-claim-recovery",
              payload: {
                level: "warn",
                message: `job ${item.jobId} was abandoned after a stale claim and requeued as ${item.replacementJobId ?? "unknown"} (${item.detail})`,
              },
            });
          } else {
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
        }
      };
      const initiateShutdown = (reason: string): void => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.warn(`[Server] Shutdown requested: ${reason}`);
        setTimeout(() => {
          try {
            requestQueue.close();
          } catch (_e) {}
          try {
            jobQueue.close();
          } catch (_e) {}
          try {
            completionQueue.close();
          } catch (_e) {}
          try {
            autonomyStore.close();
          } catch (_e) {}
          try {
            server.stop(true);
          } catch (_e) {}
        }, 25);
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
          /^\/+((jobs|requests|completions)\/claim|workers\/heartbeat|sessions\/[^/]+\/command|jobs\/[^/]+\/log|telemetry\/llm-usage)\/?$/.test(
            pathname,
          )) ||
        (method === "GET" &&
          /^\/+(workers|workers\/autoscale|system\/status|requests|jobs|completions|questions|autonomy\/insights|requests\/[^/]+|jobs\/[^/]+|completions\/[^/]+|jobs\/[^/]+\/logs)(\/)?$/.test(
            pathname,
          ));
      if (isNoisyPoll) {
        if (isDebugHttpLogsEnabled()) console.log(`[${method}] ${pathname}`);
      } else {
        console.log(`[${method}] ${pathname}`);
      }

      // ── Auth helper ──────────────────────────────────────────────────────
      const requestAuthHeader = (): string | null =>
        resolveRequestAuthHeader(req.headers.get("authorization"));

      const requireAuth = (): Response | null => {
        const authHeader = requestAuthHeader();
        if (!sessionManager.validateAuth(authHeader)) {
          return makeJson({ ok: false, message: "Unauthorized" }, 401);
        }
        return null;
      };

      // GET /healthz
      if (pathname === "/healthz" && method === "GET") {
        return makeJson({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }

      // POST /admin/shutdown (auth protected)
      if (pathname === "/admin/shutdown" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const reason = compactText(body.reason, 180) || "remote shutdown request";
        initiateShutdown(reason);
        return makeJson({ ok: true, shuttingDown: true, reason }, 202);
      }

      // GET /config/runtime (auth protected)
      if (pathname === "/config/runtime" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

        const runtimeConfig = loadPushPalsConfig({ reload: true });
        const files = describeRuntimeConfigFiles(getRuntimeConfigFiles(runtimeConfig));
        return makeJson(
          {
            ok: true,
            config: sanitizePushPalsConfigForLogging(runtimeConfig),
            files,
          },
          200,
        );
      }

      // POST /config/runtime (auth protected)
      if (pathname === "/config/runtime" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const updates = parseRuntimeMutations(body.updates);
        if (updates.length === 0) {
          return makeJson(
            {
              ok: false,
              message: "updates must include at least one valid { scope, key, value } entry",
            },
            400,
          );
        }

        const runtimeConfig = loadPushPalsConfig();
        const files = getRuntimeConfigFiles(runtimeConfig);
        const applyResult = applyRuntimeConfigMutations(files, updates);

        // Invalidate + reload so runtime reads pick up file/env changes immediately.
        invalidatePushPalsConfigCache();
        const nextConfig = loadPushPalsConfig({ reload: true });
        sessionManager.authToken = null;
        repoStatusCache = null;

        const impact = deriveRuntimeConfigImpact(applyResult.applied.map((change) => change.key));
        const warnings = [...applyResult.warnings, ...impact.warnings];
        if (nextConfig.authToken) {
          warnings.push("Server auth tokens are ignored because PushPals runs in local-only mode.");
        }

        return makeJson(
          {
            ok: true,
            applied: applyResult.applied,
            warnings,
            touchedFiles: applyResult.touchedFiles.map((entry) => entry.replace(/\\/g, "/")),
            restartRequired: impact.restartRequiredKeys.length > 0,
            restartRequiredKeys: impact.restartRequiredKeys,
            config: sanitizePushPalsConfigForLogging(nextConfig),
            files: describeRuntimeConfigFiles(files),
          },
          200,
        );
      }

      // POST /sessions - Create (or join) a session
      if (pathname === "/sessions" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

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
        const client = readClientPresenceFromSessionBody(body, req.headers);
        if (client && result.id) {
          clientPresence.announce(result.id, client, "session");
        }
        return makeJson(
          { sessionId: result.id, protocolVersion: PROTOCOL_VERSION },
          result.created ? 201 : 200,
        );
      }

      // GET /sessions/:id/events - SSE endpoint (supports ?after=<cursor> for replay)
      const sseMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/);
      if (sseMatch && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

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
        const client = readClientPresenceFromTransportRequest(url, req.headers);
        const clientConnectionId = client ? randomUUID() : null;
        if (client) {
          clientPresence.connect(sessionId, client, "sse", clientConnectionId!);
        }
        let unsubscribe: (() => void) | null = null;
        let pingInterval: NodeJS.Timeout | null = null;
        let cleanedUp = false;
        const cleanupSse = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          if (unsubscribe) {
            const fn = unsubscribe;
            unsubscribe = null;
            fn();
          }
          if (client) {
            clientPresence.disconnect(client.clientId, "sse", clientConnectionId!);
          }
        };

        const readableStream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Send initial keepalive
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              if (client) {
                clientPresence.touch(client.clientId, "sse", clientConnectionId!);
              }
            } catch {
              cleanupSse();
              try {
                controller.close();
              } catch {
                // best effort
              }
              return;
            }

            // Replay history from SQLite (cursor-based)
            session.replayHistory((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify({ envelope, cursor: eventId })}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId!);
                }
              } catch (_e) {
                cleanupSse();
                try {
                  controller.close();
                } catch {
                  // best effort
                }
              }
            }, afterEventId);

            // Subscribe to live events
            unsubscribe = session.subscribe((envelope: EventEnvelope, eventId: number) => {
              const eventData = `id: ${eventId}\ndata: ${JSON.stringify({ envelope, cursor: eventId })}\n\n`;
              try {
                controller.enqueue(encoder.encode(eventData));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId!);
                }
              } catch (_err) {
                cleanupSse();
                try {
                  controller.close();
                } catch {
                  // best effort
                }
              }
            });

            // Keepalive ping keeps SSE connections observable for stale-client pruning.
            pingInterval = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
                if (client) {
                  clientPresence.touch(client.clientId, "sse", clientConnectionId!);
                }
              } catch (_err) {
                cleanupSse();
                try {
                  controller.close();
                } catch {
                  // best effort
                }
              }
            }, CLIENT_TRANSPORT_HEARTBEAT_MS);
          },
          cancel() {
            cleanupSse();
          },
        });

        return new Response(readableStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders,
          },
        });
      }

      // GET /sessions/:id/ws - WebSocket endpoint (supports ?after=<cursor>)
      const wsMatch = pathname.match(/^\/sessions\/([^/]+)\/ws$/);
      if (wsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

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

        const client = readClientPresenceFromTransportRequest(url, req.headers);
        const clientConnectionId = client ? randomUUID() : null;
        const success = server.upgrade(req, {
          data: {
            sessionId,
            afterEventId,
            client,
            clientConnectionId,
          } as any,
        });

        if (success) {
          return new Response(null);
        }

        return makeJson({ ok: false, message: "WebSocket upgrade failed" }, 400);
      }

      // POST /sessions/:id/message  (UI convenience)
      const msgMatch = pathname.match(/^\/sessions\/([^/]+)\/message$/);
      if (msgMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const sessionId = msgMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result: SessionMessageResult = sessionManager.handleMessage(sessionId, body);
        return makeJson(result, sessionMessageResultStatus(result));
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
        const budgetStatus = getSessionTokenBudgetStatus(body.sessionId);
        if (budgetStatus?.exceeded) {
          return makeJson(
            {
              ok: false,
              code: "session_token_budget_exceeded",
              message: sessionTokenBudgetMessage(budgetStatus),
              sessionBudget: budgetStatus,
            },
            429,
          );
        }
        if (isAutonomyRequestPayload(body)) {
          const failureCircuitResponse = makeAutonomyFailureCircuitResponse();
          if (failureCircuitResponse) return failureCircuitResponse;
          const similarFailureResponse = makeAutonomySimilarFailureResponse(body);
          if (similarFailureResponse) return similarFailureResponse;
        }
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
        let result = jobQueue.claim(workerId);
        let skipped = 0;
        while (result.ok && result.job?.id && skipped < 64) {
          const budgetStatus = getSessionTokenBudgetStatus(result.job.sessionId);
          if (budgetStatus?.exceeded) {
            emitSessionBudgetPauseNotice(result.job.sessionId, budgetStatus);
            jobQueue.fail(result.job.id, {
              message: "Session token budget exceeded",
              detail: sessionTokenBudgetMessage(budgetStatus),
            });
            skipped += 1;
            result = jobQueue.claim(workerId);
            continue;
          }
          if (
            isAutonomyRequestPayload({
              ...result.job,
              params: parseJsonRecord(result.job.params),
            })
          ) {
            const jobPayload = {
              ...result.job,
              params: parseJsonRecord(result.job.params),
            };
            const failureCircuit = autonomyFailureCircuitSummary();
            if (failureCircuit.blocked) {
              jobQueue.defer(result.job.id, {
                workerId,
                deferMs: AUTONOMY_WORKER_FAILURE_DEFER_MS,
                detail: JSON.stringify({
                  code: "autonomy_worker_failure_circuit_open",
                  ...failureCircuit,
                }),
              });
              skipped += 1;
              result = jobQueue.claim(workerId);
              continue;
            }
            const similarFailure = autonomySimilarFailureSummary(jobPayload);
            if (similarFailure.blocked) {
              jobQueue.defer(result.job.id, {
                workerId,
                deferMs: AUTONOMY_SIMILAR_FAILURE_DEFER_MS,
                detail: JSON.stringify({
                  code: "autonomy_similar_failure_suppressed",
                  ...similarFailure,
                }),
              });
              skipped += 1;
              result = jobQueue.claim(workerId);
              continue;
            }
          }
          break;
        }
        if (result.ok && result.job?.id) {
          const params = parseJsonRecord(result.job.params ?? "");
          const requestId = compactText(params.requestId, 128);
          if (requestId) autonomyStore.linkJobToObjectiveByRequest(requestId, result.job.id);
          autonomyStore.markObjectiveRunningByJobId(result.job.id);
        }
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

      // GET /workers/autoscale
      if (pathname === "/workers/autoscale" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        const onlineWorkers = workers.filter((worker) => worker.isOnline);
        const busyWorkers = onlineWorkers.filter((worker) => worker.activeJobCount > 0).length;
        const taskExecutePending = jobQueue.countByKindAndStatus("task.execute", "pending");
        const taskExecuteClaimed = jobQueue.countByKindAndStatus("task.execute", "claimed");
        const autoscalableTaskExecutePending =
          jobQueue.countAutoscalablePendingByKind("task.execute");
        const openUnmergedWorkerPrs = jobQueue.countOpenUnmergedWorkerPrs();
        return makeJson({
          ok: true,
          workers: {
            total: workers.length,
            online: onlineWorkers.length,
            busy: busyWorkers,
            idle: Math.max(0, onlineWorkers.length - busyWorkers),
          },
          jobs: {
            pending: taskExecutePending,
            claimed: taskExecuteClaimed,
            autoscalablePending: autoscalableTaskExecutePending,
          },
          prs: {
            openUnmerged: openUnmergedWorkerPrs,
          },
        });
      }

      // GET /system/status
      if (pathname === "/system/status" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();
        const runtimeConfig = loadPushPalsConfig();
        const repo = await getRepoStatusSummary(
          runtimeConfig.projectRoot,
          runtimeConfig.sourceControlManager.remote,
        );

        const ttlMsRaw = parseInt(url.searchParams.get("ttlMs") ?? "", 10);
        const ttlMs = Number.isFinite(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 15000;
        const workers = jobQueue.listWorkers(ttlMs);
        const onlineWorkers = workers.filter((w) => w.isOnline);
        const busyWorkers = onlineWorkers.filter((w) => w.status === "busy").length;
        const workerPrBacklog = jobQueue.listWorkerPrBacklog(200);
        const openUnmergedWorkerPrs = workerPrBacklog.filter(
          (entry) => entry.mergeState === "open_unmerged",
        );
        const mergedWorkerPrs = workerPrBacklog.filter((entry) => entry.mergeState === "merged");
        const closedUnmergedWorkerPrs = workerPrBacklog.filter(
          (entry) => entry.mergeState === "closed_unmerged",
        );
        const requestCounts = requestQueue.countByStatus();
        const requestPriorityCounts = requestQueue.countByPriority();
        const requestPendingSnapshot = requestQueue.nextPendingSnapshot(10);
        const requestSlo = requestQueue.sloSummary(24);
        const jobCounts = jobQueue.countByStatus();
        const jobPriorityCounts = jobQueue.countByPriority();
        const jobPendingSnapshot = jobQueue.nextPendingSnapshot(10);
        const jobSlo = jobQueue.sloSummary(24);
        const completionCounts = completionQueue.countByStatus();
        const abandonedJobs = Math.max(0, Number(jobSlo.abandoned ?? 0));
        const failedJobs = Math.max(0, Number(jobSlo.failed ?? 0));
        const publishBlockedJobs = Math.max(0, Number(jobSlo.publishBlocked ?? 0));
        const jobTerminal = Math.max(
          0,
          Number(jobSlo.completed ?? 0) + failedJobs + abandonedJobs + publishBlockedJobs,
        );
        const jobFailureRate =
          jobTerminal > 0 ? (failedJobs + abandonedJobs + publishBlockedJobs) / jobTerminal : 0;
        const autonomyOps = autonomyStore.getOpsSummary({
          requestPending: Math.max(0, Number(requestCounts.pending ?? 0)),
          jobFailureRate,
        });
        const llmUsage = autonomyStore.getLlmUsageSummary({ windowHours: 24 });
        const clients = clientPresence.snapshot();

        return makeJson({
          ok: true,
          ts: new Date().toISOString(),
          runtime: {
            startedAt: SERVER_STARTED_AT_ISO,
            uptimeMs: Math.max(0, Date.now() - SERVER_STARTED_AT_MS),
          },
          workers: {
            total: workers.length,
            online: onlineWorkers.length,
            busy: busyWorkers,
            idle: Math.max(0, onlineWorkers.length - busyWorkers),
          },
          queues: {
            requests: requestCounts,
            requestPriorities: requestPriorityCounts,
            requestPendingSnapshot,
            jobs: jobCounts,
            jobPriorities: jobPriorityCounts,
            jobPendingSnapshot,
            workerPrBacklog: {
              openUnmergedCount: openUnmergedWorkerPrs.length,
              mergedCount: mergedWorkerPrs.length,
              closedUnmergedCount: closedUnmergedWorkerPrs.length,
              openUnmergedSnapshot: openUnmergedWorkerPrs.slice(0, 10).map((entry) => ({
                prUrl: entry.prUrl,
                latestJobId: entry.latestJobId,
                latestJobStatus: entry.latestJobStatus,
                latestJobAt: entry.latestJobAt,
                latestFeedbackVerdict: entry.latestFeedbackVerdict,
                latestFeedbackAt: entry.latestFeedbackAt,
              })),
            },
            completions: completionCounts,
          },
          slo: {
            requests: requestSlo,
            jobs: jobSlo,
          },
          llmUsage,
          autonomy: autonomyOps,
          repo,
          clients,
        });
      }

      // POST /telemetry/llm-usage
      if (pathname === "/telemetry/llm-usage" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.recordLlmUsage(body, {
          sessionTokenBudget: SESSION_TOKEN_BUDGET,
          sessionTokenBudgetAction: STARTUP_CONFIG.server.sessionTokenBudgetAction,
        });
        if (result.ok && result.crossedLimit && result.sessionBudget?.sessionId) {
          emitSessionBudgetPauseNotice(result.sessionBudget.sessionId, result.sessionBudget);
        }
        return makeJson(result, result.ok ? 200 : 400);
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

      // POST /autonomy/lock/acquire
      if (pathname === "/autonomy/lock/acquire" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const sessionId = compactText(body.sessionId, 128);
        const runId = compactText(body.runId, 128);
        const ttlMs = Number(body.ttlMs);
        const staleAfterMs = Number(body.staleAfterMs);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        const result = autonomyStore.acquireDispatchLock({
          sessionId,
          runId,
          ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined,
          staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : undefined,
        });
        if (!result.ok) return makeJson(result, 409);
        return makeJson(result, 200);
      }

      // POST /autonomy/lock/release
      if (pathname === "/autonomy/lock/release" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const sessionId = compactText(body.sessionId, 128);
        const runId = compactText(body.runId, 128);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        return makeJson(autonomyStore.releaseDispatchLock({ sessionId, runId }), 200);
      }

      // POST /autonomy/lock/renew
      if (pathname === "/autonomy/lock/renew" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const sessionId = compactText(body.sessionId, 128);
        const runId = compactText(body.runId, 128);
        const ttlMs = Number(body.ttlMs);
        if (!sessionId || !runId) {
          return makeJson({ ok: false, message: "sessionId and runId are required" }, 400);
        }
        const result = autonomyStore.renewDispatchLock({
          sessionId,
          runId,
          ttlMs: Number.isFinite(ttlMs) ? ttlMs : undefined,
        });
        if (!result.ok) return makeJson(result, 409);
        return makeJson(result, 200);
      }

      // GET /autonomy/snapshot
      if (pathname === "/autonomy/snapshot" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
        const runId = (url.searchParams.get("runId") ?? "").trim();
        if (!sessionId) {
          return makeJson({ ok: false, message: "sessionId is required" }, 400);
        }
        const snapshot = autonomyStore.createSnapshot({
          sessionId,
          runId,
          requestSlo: requestQueue.sloSummary(24),
          jobSlo: jobQueue.sloSummary(24),
          repoHealthFlags: {
            is_worktree_dirty: parseBool(url.searchParams.get("isWorktreeDirty"), false),
            is_merge_in_progress: parseBool(url.searchParams.get("isMergeInProgress"), false),
          },
        });
        return makeJson({ ok: true, snapshot }, 200);
      }

      // GET /autonomy/insights
      if (pathname === "/autonomy/insights" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        const patternKey = compactText(url.searchParams.get("patternKey"), 256) || undefined;
        const objectiveId = compactText(url.searchParams.get("objectiveId"), 256) || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        const feedbackLimit = parseLimit(url.searchParams.get("feedbackLimit"), 30);
        const insights = autonomyStore.listInsights({
          patternKey,
          objectiveId,
          limit,
          feedbackLimit,
        });
        return makeJson({ ok: true, ...insights }, 200);
      }

      // GET /autonomy/safety
      if (pathname === "/autonomy/safety" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        return makeJson({ ok: true, state: autonomyStore.getSafetyState() }, 200);
      }

      // POST /autonomy/safety
      if (pathname === "/autonomy/safety" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.updateSafetyState(body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /autonomy/inspiration/ingest
      if (pathname === "/autonomy/inspiration/ingest" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.ingestInspirationPatterns(body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // GET /autonomy/inspiration
      if (pathname === "/autonomy/inspiration" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        const sourceType = compactText(url.searchParams.get("sourceType"), 64) || undefined;
        const tag = compactText(url.searchParams.get("tag"), 64).toLowerCase() || undefined;
        const q = compactText(url.searchParams.get("q"), 240) || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 40);
        const patterns = autonomyStore.listInspirationPatterns({
          sourceType,
          tag,
          q,
          limit,
        });
        return makeJson({ ok: true, count: patterns.length, patterns }, 200);
      }

      // POST /autonomy/eligibility
      if (pathname === "/autonomy/eligibility" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.evaluateEligibility(body);
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /autonomy/objectives
      if (pathname === "/autonomy/objectives" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.recordObjectiveDecision(body);
        if (!result.ok) {
          return makeJson(result, 400);
        }

        const objective =
          body.objective && typeof body.objective === "object" ? body.objective : null;
        const sessionId = compactText(body.sessionId, 128);
        const runId = compactText(body.runId, 128);
        const snapshotId = compactText(body.snapshotId, 128);
        const candidateRows = Array.isArray(body.candidates)
          ? (body.candidates.filter((entry) => entry && typeof entry === "object") as Array<
              Record<string, unknown>
            >)
          : [];
        if (objective && sessionId) {
          const objectiveRecord = objective as Record<string, unknown>;
          const objectiveId = compactText(objectiveRecord.id ?? result.objectiveId, 128);
          const status = compactText(objectiveRecord.status, 64);
          const requestId = compactText(
            objectiveRecord.requestId ?? objectiveRecord.request_id,
            128,
          );
          const patternKey = compactText(
            result.patternKey ??
              (objectiveRecord as Record<string, unknown>).patternKey ??
              (objectiveRecord as Record<string, unknown>).pattern_key,
            128,
          );
          const session = sessionManager.getSession(sessionId);
          if (session && objectiveId && runId && snapshotId) {
            if (status === "dispatched" && requestId) {
              session.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID(),
                ts: new Date().toISOString(),
                sessionId,
                type: "autonomy_objective_dispatched",
                from: "server:autonomy",
                payload: {
                  runId,
                  snapshotId,
                  objectiveId,
                  requestId,
                  patternKey: patternKey || "unknown",
                  origin: "autonomy",
                },
              });
            } else if (status === "blocked") {
              session.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID(),
                ts: new Date().toISOString(),
                sessionId,
                type: "autonomy_objective_blocked",
                from: "server:autonomy",
                payload: {
                  runId,
                  snapshotId,
                  objectiveId,
                  reason: compactText(
                    objectiveRecord.blockReason ?? objectiveRecord.block_reason ?? "blocked",
                    300,
                  ),
                  origin: "autonomy",
                  ...(result.questionId ? { questionId: result.questionId } : {}),
                  ...(patternKey ? { patternKey } : {}),
                },
              });
            }
          }
          if (session && result.questionId) {
            const q =
              body.question && typeof body.question === "object"
                ? (body.question as Record<string, unknown>)
                : {};
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId,
              type: "question_asked",
              from: "server:autonomy",
              payload: {
                questionId: result.questionId,
                objectiveId: objectiveId || "unknown",
                question: compactText(q.question, 500),
                questionType: compactText(q.questionType ?? q.question_type, 120) || "unknown",
              },
            });
          }
        }
        if (sessionId && runId && snapshotId && candidateRows.length > 0) {
          const session = sessionManager.getSession(sessionId);
          if (session) {
            const topCandidateIds = candidateRows
              .map((entry) => ({
                id: compactText(entry.id, 128),
                selected: Boolean(entry.selected),
                score: Number(entry.final_score ?? entry.finalScore ?? Number.NEGATIVE_INFINITY),
              }))
              .sort((a, b) => {
                if (a.selected !== b.selected) return a.selected ? -1 : 1;
                if (a.score !== b.score) return b.score - a.score;
                return a.id.localeCompare(b.id);
              })
              .map((entry) => entry.id)
              .filter(Boolean)
              .slice(0, 3);
            session.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId,
              type: "autonomy_candidates_generated",
              from: "server:autonomy",
              payload: {
                runId,
                snapshotId,
                candidateCount: candidateRows.length,
                ...(topCandidateIds.length > 0 ? { topCandidateIds } : {}),
              },
            });
          }
        }
        return makeJson(result, 200);
      }

      // POST /autonomy/outcomes
      if (pathname === "/autonomy/outcomes" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.recordOutcome(body);
        if (!result.ok) return makeJson(result, 400);

        const sessionId = compactText(body.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: new Date().toISOString(),
            sessionId,
            type: "autonomy_feedback_recorded",
            from: "server:autonomy",
            payload: {
              objectiveId: compactText(body.objectiveId ?? body.objective_id, 128) || "unknown",
              patternKey: compactText(body.patternKey ?? body.pattern_key, 128) || "unknown",
              outcome: compactText(body.userAction ?? body.user_action ?? "recorded", 120),
              success: Boolean(body.success),
            },
          });
        }
        return makeJson(result, 200);
      }

      // POST /autonomy/pr-feedback
      if (pathname === "/autonomy/pr-feedback" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.recordPrFeedback(body);
        if (!result.ok) return makeJson(result, 400);

        const sessionId = compactText(body.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session && !result.ignored) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: new Date().toISOString(),
            sessionId,
            type: "autonomy_feedback_recorded",
            from: "server:autonomy",
            payload: {
              objectiveId:
                compactText(body.objectiveId ?? body.objective_id ?? result.objectiveId, 128) ||
                "unknown",
              patternKey:
                compactText(body.patternKey ?? body.pattern_key ?? result.patternKey, 128) ||
                "unknown",
              outcome:
                compactText(
                  body.verdict ?? body.userAction ?? body.user_action ?? "pr_feedback",
                  120,
                ) || "pr_feedback",
              success: typeof result.success === "boolean" ? result.success : Boolean(body.success),
            },
          });
        }
        return makeJson(result, 200);
      }

      // GET /questions
      if (pathname === "/questions" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        const sessionId = (url.searchParams.get("sessionId") ?? "").trim() || undefined;
        const status = (url.searchParams.get("status") ?? "").trim() || undefined;
        const limit = parseLimit(url.searchParams.get("limit"), 100);
        const questions = autonomyStore.listQuestions({
          sessionId,
          status: status as "open" | "answered" | "invalid" | "closed" | undefined,
          limit,
        });
        return makeJson({ ok: true, questions }, 200);
      }

      // POST /questions/:id/answer
      const qAnswerMatch = pathname.match(/^\/questions\/([^/]+)\/answer$/);
      if (qAnswerMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const questionId = qAnswerMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.answerQuestion(questionId, body.answer);
        if (!result.ok) return makeJson(result, 400);

        const sessionId = compactText(body.sessionId, 128) || compactText(result.sessionId, 128);
        let resumeError = "";
        let resumedRequestId = "";
        if (result.status === "valid" && result.resume) {
          const enqueueResult = requestQueue.enqueue({
            sessionId: result.resume.sessionId,
            prompt: result.resume.instruction,
            priority: "background",
            idempotencyKey: result.resume.idempotencyKey,
            forceWorker: true,
            forceLane: "worker",
            metadata: {
              origin: "autonomy",
              autonomy: {
                objectiveId: result.resume.objectiveId,
                runId: result.resume.runId,
                snapshotId: result.resume.snapshotId,
                patternKey: result.resume.patternKey,
                componentArea: result.resume.componentArea,
                targetPaths: result.resume.targetPaths,
                writeGlobs: result.resume.writeGlobs,
              },
            },
          });
          if (enqueueResult.ok && enqueueResult.requestId) {
            resumedRequestId = enqueueResult.requestId;
            autonomyStore.markObjectiveDispatched(
              result.resume.objectiveId,
              enqueueResult.requestId,
            );
            const dispatchSession = sessionManager.getSession(result.resume.sessionId);
            if (dispatchSession) {
              dispatchSession.emit({
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID(),
                ts: new Date().toISOString(),
                sessionId: result.resume.sessionId,
                type: "autonomy_objective_dispatched",
                from: "server:autonomy",
                payload: {
                  runId: result.resume.runId,
                  snapshotId: result.resume.snapshotId,
                  objectiveId: result.resume.objectiveId,
                  requestId: enqueueResult.requestId,
                  patternKey: result.resume.patternKey || "unknown",
                  origin: "autonomy",
                },
              });
            }
          } else {
            resumeError =
              compactText(enqueueResult.message, 300) ||
              "failed to enqueue autonomy resume request";
          }
        }
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: new Date().toISOString(),
            sessionId,
            type: "question_answered",
            from: "server:autonomy",
            payload: {
              questionId,
              objectiveId: result.objectiveId || "unknown",
              status: result.status === "valid" ? "valid" : "invalid",
              ...(result.reason || resumeError
                ? { answerSummary: compactText(result.reason || resumeError, 240) }
                : {}),
            },
          });
        }
        return makeJson(
          {
            ...result,
            ...(resumedRequestId ? { resumedRequestId } : {}),
            ...(resumeError ? { resumeError } : {}),
          },
          200,
        );
      }

      // POST /questions/:id/action
      const qActionMatch = pathname.match(/^\/questions\/([^/]+)\/action$/);
      if (qActionMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;
        const questionId = qActionMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = autonomyStore.actOnQuestion(questionId, body.action, body.note);
        if (!result.ok) return makeJson(result, 400);
        const sessionId = compactText(body.sessionId, 128) || compactText(result.sessionId, 128);
        const session = sessionId ? sessionManager.getSession(sessionId) : null;
        if (session) {
          session.emit({
            protocolVersion: PROTOCOL_VERSION,
            id: randomUUID(),
            ts: new Date().toISOString(),
            sessionId,
            type: "log",
            from: "server:autonomy",
            payload: {
              level: "info",
              message: compactText(
                `question ${questionId} action=${result.action || "closed"} objective=${result.objectiveId || "unknown"}${
                  body.note ? ` note=${String(body.note)}` : ""
                }`,
                240,
              ),
            },
          });
        }
        return makeJson(result, 200);
      }

      // GET /jobs
      if (pathname === "/jobs" && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;
        maybeRecoverStaleClaims();

        const status = (url.searchParams.get("status") ?? "all").trim().toLowerCase();
        const limit = parseLimit(url.searchParams.get("limit"));
        if (
          ![
            "all",
            "pending",
            "claimed",
            "finalizing",
            "completed",
            "failed",
            "abandoned",
            "publish_blocked",
          ].includes(status)
        ) {
          return makeJson({ ok: false, message: "Invalid status filter" }, 400);
        }

        const jobs = jobQueue.listJobs({
          status: status as
            | "all"
            | "pending"
            | "claimed"
            | "finalizing"
            | "completed"
            | "failed"
            | "abandoned"
            | "publish_blocked",
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

      // POST /tool-runs
      if (pathname === "/tool-runs" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.recordToolRun(body);
        return makeJson(result, result.ok ? 201 : 400);
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
        const nextCursor = logs.length > 0 ? (logs[logs.length - 1]?.id ?? null) : afterId;
        return makeJson({ ok: true, jobId, logs, cursor: nextCursor });
      }

      // GET /jobs/:id/tool-runs
      const jobToolRunsMatch = pathname.match(/^\/jobs\/([^/]+)\/tool-runs$/);
      if (jobToolRunsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobToolRunsMatch[1];
        const limit = parseLimit(url.searchParams.get("limit"), 50);
        const toolRuns = jobQueue.listJobToolRuns(jobId, limit);
        return makeJson({ ok: true, jobId, toolRuns });
      }

      // GET /jobs/:id/diagnostics
      const jobDiagnosticsMatch = pathname.match(/^\/jobs\/([^/]+)\/diagnostics$/);
      if (jobDiagnosticsMatch && method === "GET") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobDiagnosticsMatch[1];
        return makeJson({ ok: true, jobId, diagnostics: jobQueue.getJobDiagnostics(jobId) });
      }
      if (jobDiagnosticsMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobDiagnosticsMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
          const result = jobQueue.saveJobDiagnostics(jobId, body);
          return makeJson(result, result.ok ? 200 : 404);
        } catch (error) {
          console.error(
            `[Server] Failed to persist diagnostics for job ${jobId}: ${
              error instanceof Error ? error.stack || error.message : String(error)
            }`,
          );
          return makeJson({ ok: false, message: "Failed to persist job diagnostics" }, 500);
        }
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
          const job = jobQueue.getJob(jobId);
          const params = parseJsonRecord(job?.params ?? "");
          const requestId = compactText(params.requestId, 128);
          if (requestId) autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          autonomyStore.markObjectiveRunningByJobId(jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            const outcome = classifyAutonomyJobCompletion(body);
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: outcome.success,
              latencyMs: result.durationMs ?? null,
              userAction: outcome.userAction,
              reopenedWithin24h: outcome.reopenedWithin24h,
              regressionFlag: outcome.regressionFlag,
            });
          }
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
          const params = parseJsonRecord(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText(params.requestId, 128);
          if (requestId) autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true,
            });
          }

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
                  origin,
                  ...(detail ? { detail } : {}),
                },
              };
              session.emit(envelope);
            }
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /jobs/:id/publish-blocked
      const jobPublishBlockedMatch = pathname.match(/^\/jobs\/([^/]+)\/publish-blocked$/);
      if (jobPublishBlockedMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobPublishBlockedMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.publishBlocked(jobId, body);
        if (result.ok) {
          const durationText =
            typeof result.durationMs === "number" ? `${result.durationMs}ms` : "unknown duration";
          console.log(`[Server] Job ${jobId} publish-blocked (${durationText})`);

          const job = jobQueue.getJob(jobId);
          const params = parseJsonRecord(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText(params.requestId, 128);
          if (requestId) autonomyStore.linkJobToObjectiveByRequest(requestId, jobId);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true,
            });
          }

          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            if (session) {
              const message = compactText(body.message, 240) || "WorkerPal job publish-blocked";
              const detail = compactText(body.detail, 600);
              const envelope: EventEnvelope<"job_failed"> = {
                protocolVersion: PROTOCOL_VERSION,
                id: randomUUID(),
                ts: new Date().toISOString(),
                sessionId: job.sessionId,
                type: "job_failed",
                from: "server:job-publish-blocked",
                payload: {
                  jobId,
                  message,
                  origin,
                  ...(detail ? { detail } : {}),
                },
              };
              session.emit(envelope);
            }
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /jobs/:id/fail-deferred
      const jobFailDeferredMatch = pathname.match(/^\/jobs\/([^/]+)\/fail-deferred$/);
      if (jobFailDeferredMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobFailDeferredMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.failDeferred(jobId, body);
        if (result.ok) {
          console.log(`[Server] Deferred job ${jobId} failed during pre-execution maintenance`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // POST /jobs/:id/defer
      const jobDeferMatch = pathname.match(/^\/jobs\/([^/]+)\/defer$/);
      if (jobDeferMatch && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const jobId = jobDeferMatch[1];
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = jobQueue.defer(jobId, body);
        if (result.ok) {
          console.log(
            `[Server] Job ${jobId} deferred until ${result.availableAt ?? "unknown"} by worker ${String(body.workerId ?? "unknown")}`,
          );
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
        const logTs = typeof body.ts === "string" ? body.ts.trim() : "";
        const trimmed = message.trim();
        if (!trimmed) {
          return makeJson({ ok: false, message: "message is required" }, 400);
        }
        const logId = jobQueue.addLog(jobId, trimmed, logTs || undefined);
        return makeJson({ ok: true, jobId, logId }, 200);
      }

      // ── Request queue endpoints (auth protected) ────────────────────────────

      // POST /requests/enqueue
      if (pathname === "/requests/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const budgetStatus = getSessionTokenBudgetStatus(body.sessionId);
        if (budgetStatus?.exceeded) {
          return makeJson(
            {
              ok: false,
              code: "session_token_budget_exceeded",
              message: sessionTokenBudgetMessage(budgetStatus),
              sessionBudget: budgetStatus,
            },
            429,
          );
        }
        if (isAutonomyRequestPayload(body)) {
          const failureCircuitResponse = makeAutonomyFailureCircuitResponse();
          if (failureCircuitResponse) return failureCircuitResponse;
          const similarFailureResponse = makeAutonomySimilarFailureResponse(body);
          if (similarFailureResponse) return similarFailureResponse;

          const workers = jobQueue.listWorkers(AUTONOMY_WORKER_TTL_MS);
          const schedulableWorkers = workers.filter(
            (worker) => worker.isOnline && worker.status !== "offline",
          );
          const idleWorkers = schedulableWorkers.filter(
            (worker) => worker.status === "idle" && worker.activeJobCount === 0,
          );
          const workersAllBusy = schedulableWorkers.length > 0 && idleWorkers.length === 0;
          if (workersAllBusy) {
            const autonomyQueued = requestQueue.countAutonomyRequests(["pending", "claimed"]);
            if (autonomyQueued >= AUTONOMY_BUSY_QUEUE_MAX_REQUESTS) {
              return makeJson(
                {
                  ok: false,
                  code: "autonomy_queue_backpressure",
                  message:
                    `Autonomy enqueue blocked: workers are saturated and autonomy queue depth reached ` +
                    `${AUTONOMY_BUSY_QUEUE_MAX_REQUESTS}.`,
                  currentQueued: autonomyQueued,
                  limit: AUTONOMY_BUSY_QUEUE_MAX_REQUESTS,
                },
                429,
              );
            }
          }

          const workerPrBacklog = jobQueue.listWorkerPrBacklog(500);
          const openUnmergedWorkerPrs = workerPrBacklog.filter(
            (entry) => entry.mergeState === "open_unmerged",
          );
          if (openUnmergedWorkerPrs.length >= AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS) {
            return makeJson(
              {
                ok: false,
                code: "autonomy_open_pr_limit",
                message:
                  `Autonomy enqueue blocked: open unmerged worker PR backlog reached ` +
                  `${AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS}.`,
                currentOpenUnmergedWorkerPrs: openUnmergedWorkerPrs.length,
                limit: AUTONOMY_MAX_OPEN_UNMERGED_WORKER_PRS,
                openUnmergedPrs: openUnmergedWorkerPrs.slice(0, 10).map((entry) => entry.prUrl),
              },
              429,
            );
          }
        }
        const result = requestQueue.enqueue(body);
        return makeJson(result, result.ok ? 201 : 400);
      }

      // POST /requests/claim
      if (pathname === "/requests/claim" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const agentId = (body.agentId as string) || "unknown";
        let result = requestQueue.claim(agentId);
        let skipped = 0;
        while (result.ok && result.request?.id && skipped < 64) {
          const budgetStatus = getSessionTokenBudgetStatus(result.request.sessionId);
          if (budgetStatus?.exceeded) {
            emitSessionBudgetPauseNotice(result.request.sessionId, budgetStatus);
            requestQueue.fail(result.request.id, {
              message: "Session token budget exceeded",
              detail: sessionTokenBudgetMessage(budgetStatus),
            });
            skipped += 1;
            result = requestQueue.claim(agentId);
            continue;
          }
          if (isAutonomyRequestPayload(result.request as unknown as Record<string, unknown>)) {
            const failureCircuit = autonomyFailureCircuitSummary();
            if (failureCircuit.blocked) {
              requestQueue.fail(result.request.id, {
                message: autonomyFailureCircuitMessage(failureCircuit),
                detail: JSON.stringify({
                  code: "autonomy_worker_failure_circuit_open",
                  ...failureCircuit,
                }),
              });
              skipped += 1;
              result = requestQueue.claim(agentId);
              continue;
            }
            const similarFailure = autonomySimilarFailureSummary(
              result.request as unknown as Record<string, unknown>,
            );
            if (similarFailure.blocked) {
              requestQueue.fail(result.request.id, {
                message:
                  `Autonomy request suppressed after ` +
                  `${similarFailure.recentSimilarFailureCount} unchanged target-and-failure fingerprint occurrence(s).`,
                detail: JSON.stringify({
                  code: "autonomy_similar_failure_suppressed",
                  ...similarFailure,
                }),
              });
              skipped += 1;
              result = requestQueue.claim(agentId);
              continue;
            }
          }
          break;
        }
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
        if (result.ok) {
          const resultPayload =
            body.result && typeof body.result === "object" && !Array.isArray(body.result)
              ? (body.result as Record<string, unknown>)
              : null;
          const wasDelegatedToWorker = Boolean(resultPayload?.requiresWorker);
          const matched = autonomyStore.findObjectiveByRequestId(requestId);
          if (matched && !wasDelegatedToWorker) {
            autonomyStore.recordOutcome({
              objectiveId: matched.objectiveId,
              requestId,
              patternKey: matched.patternKey,
              success: true,
              userAction: "accepted",
              reopenedWithin24h: false,
              regressionFlag: false,
            });
          }
        }
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
        if (result.ok) {
          const matched = autonomyStore.findObjectiveByRequestId(requestId);
          if (matched) {
            autonomyStore.recordOutcome({
              objectiveId: matched.objectiveId,
              requestId,
              patternKey: matched.patternKey,
              success: false,
              userAction: "rejected",
              reopenedWithin24h: true,
              regressionFlag: true,
            });
          }
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // ── Completion queue endpoints (auth protected) ─────────────────────────

      // POST /completions/enqueue
      if (pathname === "/completions/enqueue" && method === "POST") {
        const denied = requireAuth();
        if (denied) return denied;

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const result = completionQueue.enqueue(body, { beginJobFinalization: true });
        if (result.ok) {
          const jobId = compactText(body.jobId, 128);
          if (jobId) {
            autonomyStore.markObjectiveRunningByJobId(jobId);
            console.log(
              `[Server] Job ${jobId} is finalizing via completion ${result.completionId ?? "unknown"}`,
            );
          }
        }
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
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const prUrl = typeof body.prUrl === "string" ? body.prUrl : null;
        const trustedInstallDurationMs =
          typeof body.trustedInstallDurationMs === "number" ? body.trustedInstallDurationMs : null;
        const trustedValidationDurationMs =
          typeof body.trustedValidationDurationMs === "number"
            ? body.trustedValidationDurationMs
            : null;
        const trustedValidationCacheHit =
          typeof body.trustedValidationCacheHit === "boolean"
            ? body.trustedValidationCacheHit
            : null;
        const result = completionQueue.markProcessedAndFinalizeJob(
          completionId,
          prUrl,
          {
            installDurationMs: trustedInstallDurationMs,
            validationDurationMs: trustedValidationDurationMs,
            installCacheHit: trustedValidationCacheHit,
          },
          body.trustedValidationReport,
        );
        if (result.ok && result.jobTransitioned && result.jobId) {
          const job = jobQueue.getJob(result.jobId);
          const params = parseJsonRecord(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText(params.requestId, 128);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(result.jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId: result.jobId,
              patternKey: outcomeContext.patternKey,
              success: true,
              latencyMs: result.durationMs ?? null,
              userAction: "applied",
              reopenedWithin24h: false,
              regressionFlag: false,
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            const savedResult = parseJsonRecord(job.result ?? "");
            session?.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId: job.sessionId,
              type: "job_completed",
              from: "server:completion-processed",
              payload: {
                jobId: result.jobId,
                summary:
                  compactText(savedResult.summary, 1200) || "Candidate published successfully",
                origin,
              },
            });
          }
          console.log(
            `[Server] Job ${result.jobId} completed after publication confirmation (${result.durationMs ?? "unknown"}ms)`,
          );
        }
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
        const result = completionQueue.markFailedAndBlockJob(
          completionId,
          error,
          {
            installDurationMs:
              typeof body.trustedInstallDurationMs === "number"
                ? body.trustedInstallDurationMs
                : null,
            validationDurationMs:
              typeof body.trustedValidationDurationMs === "number"
                ? body.trustedValidationDurationMs
                : null,
            installCacheHit:
              typeof body.trustedValidationCacheHit === "boolean"
                ? body.trustedValidationCacheHit
                : null,
          },
          body.trustedValidationReport,
        );
        if (result.ok && result.jobTransitioned && result.jobId) {
          const job = jobQueue.getJob(result.jobId);
          const params = parseJsonRecord(job?.params ?? "");
          const origin = deriveJobOrigin(params);
          const requestId = compactText(params.requestId, 128);
          const outcomeContext = autonomyStore.resolveJobOutcomeContext(result.jobId, params);
          if (outcomeContext) {
            autonomyStore.recordOutcome({
              objectiveId: outcomeContext.objectiveId,
              requestId: outcomeContext.requestId ?? requestId,
              jobId: result.jobId,
              patternKey: outcomeContext.patternKey,
              success: false,
              latencyMs: result.durationMs ?? null,
              userAction: "failed",
              reopenedWithin24h: false,
              regressionFlag: true,
            });
          }
          if (job?.sessionId) {
            const session = sessionManager.getSession(job.sessionId);
            session?.emit({
              protocolVersion: PROTOCOL_VERSION,
              id: randomUUID(),
              ts: new Date().toISOString(),
              sessionId: job.sessionId,
              type: "job_failed",
              from: "server:completion-fail-hook",
              payload: {
                jobId: result.jobId,
                message: "Candidate publication failed",
                origin,
                detail: compactText(error, 600),
              },
            });
          }
          console.warn(`[Server] Job ${result.jobId} publish-blocked: ${error}`);
        }
        return makeJson(result, result.ok ? 200 : 400);
      }

      // 404
      return makeJson({ ok: false, message: "Not found" }, 404);
    },

    websocket: {
      open(ws: any) {
        const { sessionId, afterEventId = 0, client, clientConnectionId } = ws.data || {};
        console.log(`[WS] Session ${sessionId} connected (after=${afterEventId})`);
        if (client) {
          clientPresence.connect(sessionId, client, "ws", clientConnectionId);
        }
        const heartbeatTimer = setInterval(() => {
          try {
            ws.ping("pushpals");
          } catch {
            try {
              clearInterval(heartbeatTimer);
            } catch {
              // best effort
            }
          }
        }, CLIENT_TRANSPORT_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
        ws.data = { ...(ws.data || {}), heartbeatTimer };

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

        ws.data = { sessionId, unsubscribe, client, clientConnectionId };
      },
      close(ws: any) {
        const { sessionId, unsubscribe, client, clientConnectionId, heartbeatTimer } =
          ws.data || {};
        console.log(`[WS] Session ${sessionId} disconnected`);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (client) {
          clientPresence.disconnect(client.clientId, "ws", clientConnectionId);
        }
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (_e) {}
        }
      },
      message(ws: any, message: any) {
        const { sessionId, client, clientConnectionId } = ws.data || {};
        console.log(`[WS] Session ${sessionId} message:`, message);
        if (client) {
          clientPresence.touch(client.clientId, "ws", clientConnectionId);
        }
      },
      pong(ws: any) {
        const { client, clientConnectionId } = ws.data || {};
        if (client) {
          clientPresence.touch(client.clientId, "ws", clientConnectionId);
        }
      },
    },
  });
}

export { sessionManager, jobQueue, autonomyStore };

// If this file is executed directly, start the server.
if (import.meta.main) {
  const server = createRequestHandler();
  console.log(`[Server] PushPals listening on ${server.url}`);
}
