import type { EventEnvelope } from "protocol/browser";
import { PROTOCOL_VERSION, validateEventEnvelope } from "protocol/browser";
import { fetchClientResponseWithDeadline } from "./httpDeadline";

type TransportType = "auto" | "sse" | "ws";

/** Extended callback that also receives the server cursor for each event */
export type CursorEventCallback = (event: EventEnvelope, cursor: number) => void;

export interface ClientRegistration {
  clientId: string;
  kind: string;
  label?: string;
  version?: string;
  platform?: string;
  repoRoot?: string;
}

export interface SystemClientSummary {
  clientId: string;
  kind: string;
  label?: string;
  version?: string;
  platform?: string;
  repoRoot?: string;
  userAgent?: string;
  sessionId: string;
  status: "connected" | "announced";
  connectedTransports: ("session" | "sse" | "ws")[];
  announcedAt: string;
  lastSeenAt: string;
}

export interface SystemClientsSummary {
  total: number;
  connected: number;
  byKind: Record<string, number>;
  items: SystemClientSummary[];
}

function buildSessionTransportQuery(
  afterCursor = 0,
  _authToken?: string,
  client?: ClientRegistration,
): string {
  const params = new URLSearchParams();
  if (afterCursor > 0) {
    params.set("after", String(afterCursor));
  }
  if (client) {
    params.set("clientId", client.clientId);
    params.set("clientKind", client.kind);
    if (client.label) params.set("clientLabel", client.label);
    if (client.version) params.set("clientVersion", client.version);
    if (client.platform) params.set("clientPlatform", client.platform);
    if (client.repoRoot) params.set("clientRepoRoot", client.repoRoot);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function buildSessionEventsUrl(
  baseUrl: string,
  sessionId: string,
  afterCursor: number = 0,
  authToken?: string,
  client?: ClientRegistration,
): string {
  return `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events${buildSessionTransportQuery(afterCursor, authToken, client)}`;
}

export function buildSessionWebSocketUrl(
  baseUrl: string,
  sessionId: string,
  afterCursor: number = 0,
  authToken?: string,
  client?: ClientRegistration,
): string {
  const protocol = baseUrl.startsWith("https") ? "wss" : "ws";
  const host = baseUrl.replace(/^https?:\/\//, "");
  return `${protocol}://${host}/sessions/${encodeURIComponent(sessionId)}/ws${buildSessionTransportQuery(afterCursor, authToken, client)}`;
}

export function buildSessionMessageUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/message`;
}

function randomEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function transportErrorEvent(sessionId: string, message: string): EventEnvelope<"error"> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: randomEventId(),
    ts: new Date().toISOString(),
    sessionId,
    type: "error",
    from: "client:transport",
    payload: { message },
  };
}

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
  authToken?: string,
  client?: ClientRegistration,
): () => void {
  let disposed = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCursor = afterCursor;

  function connect() {
    if (disposed) return;
    es = new EventSource(
      buildSessionEventsUrl(baseUrl, sessionId, latestCursor, authToken, client),
    );

    es.addEventListener("message", (event) => {
      try {
        const raw = JSON.parse(event.data) as { envelope?: unknown; cursor?: unknown };
        const envelope = raw?.envelope;
        const validation = validateEventEnvelope(envelope);

        if (!validation.ok) {
          onEvent(
            transportErrorEvent(sessionId, `[Protocol error] ${validation.errors?.join("; ")}`),
            latestCursor,
          );
          return;
        }

        // SSE sends `id: <cursor>` — available via event.lastEventId
        const cursor =
          typeof raw?.cursor === "number" ? raw.cursor : parseInt(event.lastEventId, 10) || 0;
        if (cursor > latestCursor) latestCursor = cursor;
        onEvent(envelope as EventEnvelope, cursor);
      } catch (err) {
        onEvent(
          transportErrorEvent(sessionId, `[Parse error] Failed to parse event: ${String(err)}`),
          latestCursor,
        );
      }
    });

    es.onerror = () => {
      onEvent(
        transportErrorEvent(sessionId, "[SSE] Connection lost, reconnecting..."),
        latestCursor,
      );
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
  authToken?: string,
  client?: ClientRegistration,
): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCursor = afterCursor;

  function connect() {
    if (disposed) return;
    ws = new WebSocket(
      buildSessionWebSocketUrl(baseUrl, sessionId, latestCursor, authToken, client),
    );

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data) as { envelope?: unknown; cursor?: unknown };
        const envelope = raw?.envelope;
        const cursor: number = typeof raw.cursor === "number" ? raw.cursor : 0;

        const validation = validateEventEnvelope(envelope);
        if (!validation.ok) {
          onEvent(
            transportErrorEvent(sessionId, `[Protocol error] ${validation.errors?.join("; ")}`),
            latestCursor,
          );
          return;
        }

        if (cursor > latestCursor) latestCursor = cursor;
        onEvent(envelope as EventEnvelope, cursor);
      } catch (err) {
        onEvent(
          transportErrorEvent(sessionId, `[Parse error] Failed to parse event: ${String(err)}`),
          latestCursor,
        );
      }
    };

    ws.onerror = () => {
      onEvent(transportErrorEvent(sessionId, "[WebSocket] Connection error"), latestCursor);
    };

    ws.onclose = () => {
      ws = null;
      if (!disposed) {
        onEvent(
          transportErrorEvent(sessionId, "[WebSocket] Connection lost, reconnecting..."),
          latestCursor,
        );
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
 * @param onEvent Callback for each event + cursor
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
  authToken?: string,
  client?: ClientRegistration,
): () => void {
  const selectedTransport = selectTransport(transport);

  console.log(
    `[PushPals] Subscribing to session ${sessionId} via ${selectedTransport} (after=${afterCursor})`,
  );

  if (selectedTransport === "sse") {
    return subscribeSSE(baseUrl, sessionId, onEvent, afterCursor, authToken, client);
  } else {
    return subscribeWebSocket(baseUrl, sessionId, onEvent, afterCursor, authToken, client);
  }
}

/**
 * Create a new session on the server
 */
export async function createSession(
  baseUrl: string,
  sessionId?: string,
  authToken?: string,
  client?: ClientRegistration,
): Promise<{ sessionId: string; created: boolean } | null> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        ...(client ? { client } : {}),
      }),
    });

    if (!response.ok) {
      console.error("Failed to create session:", response.status);
      return null;
    }

    const data = (await response.json()) as { sessionId?: string };
    const created = response.status === 201;
    if (!data.sessionId || typeof data.sessionId !== "string") {
      return null;
    }
    return { sessionId: data.sessionId, created };
  } catch (err) {
    console.error("Error creating session:", err);
    return null;
  }
}

/**
 * Send a message directly to the local PushPals server session.
 * The server emits a `message` event onto the session stream and RemoteBuddy/other
 * agents react from there.
 */
export async function sendSessionMessage(
  baseUrl: string,
  sessionId: string,
  text: string,
): Promise<boolean> {
  try {
    const response = await fetchClientResponseWithDeadline(
      buildSessionMessageUrl(baseUrl, sessionId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `Error sending message: ${response.status} ${response.statusText}${detail ? ` ${detail}` : ""}`,
      );
      return false;
    }
    return true;
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
  authToken?: string,
): Promise<boolean> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(authToken) },
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
  prompt: string;
  priority?: "interactive" | "normal" | "background";
  queueWaitBudgetMs?: number | null;
  status: "pending" | "claimed" | "completed" | "failed";
  agentId: string | null;
  result: string | null;
  error: string | null;
  enqueuedAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  durationMs?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSnapshotRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: string;
  params: string;
  priority?: "interactive" | "normal" | "background";
  queueWaitBudgetMs?: number | null;
  executionBudgetMs?: number | null;
  finalizationBudgetMs?: number | null;
  status:
    | "pending"
    | "claimed"
    | "finalizing"
    | "completed"
    | "failed"
    | "abandoned"
    | "publish_blocked";
  workerId: string | null;
  targetWorkerId: string | null;
  result: string | null;
  prUrl?: string | null;
  error: string | null;
  enqueuedAt?: string | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  firstLogAt?: string | null;
  failedAt?: string | null;
  abandonedAt?: string | null;
  publishBlockedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  resumeOfJobId?: string | null;
  attempt?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobLogSnapshotRow {
  id: number;
  jobId: string;
  ts: string;
  message: string;
}

export interface CompletionSnapshotRow {
  id: string;
  jobId: string;
  sessionId: string;
  commitSha: string | null;
  branch: string | null;
  message: string;
  prUrl?: string | null;
  prTitle?: string | null;
  prBody?: string | null;
  status: "pending" | "claimed" | "processed" | "failed";
  pusherId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueCounts {
  [key: string]: number;
}

export interface PendingQueueSnapshot {
  id: string;
  priority: "interactive" | "normal" | "background";
  position: number;
  etaMs: number;
}

export interface SloMetricSummary {
  p50: number | null;
  p95: number | null;
  avg: number | null;
  sampleSize: number;
}

export interface RequestSloSummary {
  windowHours: number;
  terminal: number;
  completed: number;
  failed: number;
  successRate: number | null;
  durationMs: SloMetricSummary;
  queueWaitMs: SloMetricSummary;
}

export interface JobSloSummary {
  windowHours: number;
  terminal: number;
  completed: number;
  failed: number;
  abandoned: number;
  publishBlocked: number;
  timeoutFailures: number;
  successRate: number | null;
  timeoutRate: number | null;
  durationMs: SloMetricSummary;
  queueWaitMs: SloMetricSummary;
}

export interface SystemRepoSummary {
  root?: string;
  remote: string;
  remoteUrl: string | null;
  browserUrl: string | null;
  provider: "github" | "gitlab" | "unknown";
  refreshedAt?: string;
}

export interface LlmUsageServiceSummary {
  service: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  avgTokensPerHour: number;
  avgTokensPerCall: number | null;
  estimatedCallCount: number;
  lastCallAt: string | null;
}

export interface LlmUsageSummary {
  windowHours: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  avgTokensPerHour: number;
  avgTokensPerCall: number | null;
  estimatedCallCount: number;
  services: LlmUsageServiceSummary[];
}

export interface SystemRuntimeSummary {
  startedAt: string;
  uptimeMs: number;
}

export interface SystemStatusSummary {
  workers?: { total: number; online: number; busy: number; idle: number };
  queues?: {
    requests?: QueueCounts;
    jobs?: QueueCounts;
    completions?: QueueCounts;
  };
  slo?: {
    requests?: RequestSloSummary;
    jobs?: JobSloSummary;
  };
  llmUsage?: LlmUsageSummary;
  repo?: SystemRepoSummary;
  autonomy?: AutonomyOpsSummary;
  runtime?: SystemRuntimeSummary;
  clients?: SystemClientsSummary;
  ts?: string;
}

export interface AutonomyEvaluatorScorecard {
  id: string;
  windowHours: number;
  sampleCount: number;
  successRate: number | null;
  regretRate: number | null;
  avgLatencyMs: number | null;
  dispatchCount: number;
  recommendation: "healthy" | "constrain" | "pause";
  createdAt: string;
}

export interface AutonomyOpsAlert {
  id: string;
  alertType: string;
  severity: "info" | "warning" | "critical";
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AutonomySafetyState {
  killSwitchEnabled: boolean;
  freezeUntil: string | null;
  freezeReason: string | null;
  isFrozen: boolean;
  updatedAt: string | null;
}

export interface AutonomyOpsSummary {
  safetyState: AutonomySafetyState;
  latestEvaluatorScorecard: AutonomyEvaluatorScorecard | null;
  recentAlerts: AutonomyOpsAlert[];
  staleDeadLetterCount24h: number;
  lastStaleSweepAt: string | null;
  reliability?: {
    windowHours: number;
    attemptsTotal: number;
    outcomeCounts: Record<string, number>;
    attemptSuccessRate: number | null;
    objectiveTerminalCount: number;
    objectiveSuccessRate: number | null;
    nonTerminalRevisionCount: number;
    nonTerminalRevisionObjectiveCount: number;
    revisedTerminalObjectiveCount: number;
    objectiveRevisionRate: number | null;
    objectiveFirstPassRate: number | null;
    durationMs: { average: number | null; p50: number | null; p95: number | null };
    validationFailureRuns: number;
    validationEvidenceCoverageRate: number | null;
    validationFingerprintCollisionCount: number;
    transientValidationRetries: number;
    activeIncidentCount: number;
    workerHandoffFailureCount: number;
    stalledWorkerHandoffCount: number;
  };
}

export interface AutonomyEngineSourceInsightRow {
  sourceKey: string;
  sourceType: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceFingerprint: string | null;
  sourceAlgorithm: string;
  curationStatus: "candidate" | "trusted" | "watchlist" | "archived";
  curationReason: string | null;
  trustScore: number;
  freshnessScore: number;
  sampleCount: number;
  emaSuccess: number;
  emaUserAccept: number;
  emaLatency: number;
  emaRegret: number;
  lastReinforcedAt: string | null;
  updatedAt: string;
}

export interface AutonomyTrustedInspirationInsightRow {
  sourceKey: string;
  sourceType: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceFingerprint: string | null;
  algorithm: string;
  summary: string | null;
  trustScore: number;
  freshnessScore: number;
  sampleCount: number;
  curationReason: string | null;
}

export interface AutonomyInspirationPatternRow {
  id: number;
  fingerprint: string;
  sourceType: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  sourceRefs: string[];
  algorithm: string;
  whenToUse: string | null;
  summary: string | null;
  risks: string[];
  validationIdeas: string[];
  tags: string[];
  qualityScore: number;
  freshnessScore: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface AutonomyInsightsSummary {
  engineSourceStats: AutonomyEngineSourceInsightRow[];
  trustedInspirationShortlist: AutonomyTrustedInspirationInsightRow[];
  archivedInspirationSources: AutonomyTrustedInspirationInsightRow[];
  latestEvaluatorScorecard: AutonomyEvaluatorScorecard | null;
  opsSummary: AutonomyOpsSummary | null;
}

export interface AutonomyQuestionRow {
  id: string;
  objectiveId: string;
  sessionId: string;
  question: string;
  questionType: string;
  expectedAnswerSchema: Record<string, unknown>;
  context: Record<string, unknown>;
  status: "open" | "answered" | "invalid" | "closed";
  answer: unknown;
  answerValidationStatus: string;
  validationError: string;
  createdAt: string;
  answeredAt: string;
  expiresAt: string;
  expiresInMs?: number | null;
  isExpired?: boolean;
  closedReason?: string;
}

export interface AnswerAutonomyQuestionResult {
  ok: boolean;
  status?: "valid" | "invalid";
  reason?: string;
  objectiveId?: string;
  resumedRequestId?: string;
  resumeError?: string;
}

export interface ActOnAutonomyQuestionResult {
  ok: boolean;
  action?: "skip" | "close" | "escalate";
  objectiveId?: string;
  reason?: string;
}

export interface RuntimeConfigMutation {
  scope: "env" | "toml";
  key: string;
  value: unknown;
}

export interface RuntimeConfigSnapshot {
  config: Record<string, unknown>;
  files?: {
    envPath?: string;
    localTomlPath?: string;
  };
}

export interface RuntimeConfigUpdateResult extends RuntimeConfigSnapshot {
  applied: RuntimeConfigMutation[];
  warnings: string[];
  touchedFiles: string[];
  restartRequired: boolean;
  restartRequiredKeys: string[];
}

function authHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").map(String) : [];
}

export async function fetchWorkers(
  baseUrl: string,
  authToken?: string,
): Promise<WorkerStatusRow[]> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/workers`, {
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
): Promise<{
  requests: RequestSnapshotRow[];
  counts: QueueCounts;
  priorityCounts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
  slo?: RequestSloSummary;
}> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/requests?limit=250`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return { requests: [], counts: {}, priorityCounts: {}, pendingSnapshot: [] };
    const payload = (await response.json()) as {
      ok: boolean;
      requests?: RequestSnapshotRow[];
      counts?: QueueCounts;
      priorityCounts?: QueueCounts;
      pendingSnapshot?: PendingQueueSnapshot[];
      slo?: RequestSloSummary;
    };
    return {
      requests: Array.isArray(payload.requests) ? payload.requests : [],
      counts: payload.counts ?? {},
      priorityCounts: payload.priorityCounts ?? {},
      pendingSnapshot: Array.isArray(payload.pendingSnapshot) ? payload.pendingSnapshot : [],
      slo: payload.slo,
    };
  } catch (err) {
    console.error("Error fetching requests snapshot:", err);
    return { requests: [], counts: {}, priorityCounts: {}, pendingSnapshot: [] };
  }
}

export async function fetchJobsSnapshot(
  baseUrl: string,
  authToken?: string,
): Promise<{
  jobs: JobSnapshotRow[];
  counts: QueueCounts;
  priorityCounts: QueueCounts;
  pendingSnapshot: PendingQueueSnapshot[];
  slo?: JobSloSummary;
}> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/jobs?limit=250`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return { jobs: [], counts: {}, priorityCounts: {}, pendingSnapshot: [] };
    const payload = (await response.json()) as {
      ok: boolean;
      jobs?: JobSnapshotRow[];
      counts?: QueueCounts;
      priorityCounts?: QueueCounts;
      pendingSnapshot?: PendingQueueSnapshot[];
      slo?: JobSloSummary;
    };
    return {
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      counts: payload.counts ?? {},
      priorityCounts: payload.priorityCounts ?? {},
      pendingSnapshot: Array.isArray(payload.pendingSnapshot) ? payload.pendingSnapshot : [],
      slo: payload.slo,
    };
  } catch (err) {
    console.error("Error fetching jobs snapshot:", err);
    return { jobs: [], counts: {}, priorityCounts: {}, pendingSnapshot: [] };
  }
}

export async function fetchJobLogsSnapshot(
  baseUrl: string,
  jobId: string,
  authToken?: string,
  limit = 100,
): Promise<JobLogSnapshotRow[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  try {
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/jobs/${encodeURIComponent(jobId)}/logs?limit=${safeLimit}`,
      {
        headers: authHeaders(authToken),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      ok?: boolean;
      logs?: unknown;
    };
    if (payload.ok !== true || !Array.isArray(payload.logs)) return [];
    return payload.logs
      .filter((entry): entry is Record<string, unknown> => {
        return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
      })
      .map((entry) => ({
        id: Number(entry.id),
        jobId: String(entry.jobId ?? jobId),
        ts: String(entry.ts ?? ""),
        message: String(entry.message ?? ""),
      }))
      .filter((entry) => Number.isFinite(entry.id) && entry.message.trim().length > 0);
  } catch (err) {
    console.error("Error fetching job logs snapshot:", err);
    return [];
  }
}

export async function fetchCompletionsSnapshot(
  baseUrl: string,
  authToken?: string,
): Promise<{ completions: CompletionSnapshotRow[]; counts: QueueCounts }> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/completions?limit=250`, {
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
): Promise<SystemStatusSummary> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/system/status`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as { ok: boolean } & SystemStatusSummary;
    return {
      workers: payload.workers,
      queues: payload.queues,
      slo: payload.slo,
      llmUsage: payload.llmUsage,
      autonomy: payload.autonomy,
      repo: payload.repo,
      runtime: payload.runtime,
      clients: payload.clients,
      ts: payload.ts,
    };
  } catch (err) {
    console.error("Error fetching system status:", err);
    return {};
  }
}

export async function fetchAutonomyInsights(
  baseUrl: string,
  authToken?: string,
  limit = 40,
): Promise<AutonomyInsightsSummary> {
  const empty: AutonomyInsightsSummary = {
    engineSourceStats: [],
    trustedInspirationShortlist: [],
    archivedInspirationSources: [],
    latestEvaluatorScorecard: null,
    opsSummary: null,
  };
  try {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(200, Math.floor(limit)))),
      feedbackLimit: "10",
    });
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/autonomy/insights?${qs.toString()}`,
      {
        headers: authHeaders(authToken),
      },
    );
    if (!response.ok) return empty;
    const payload = (await response.json()) as {
      ok?: boolean;
      engineSourceStats?: AutonomyEngineSourceInsightRow[];
      trustedInspirationShortlist?: AutonomyTrustedInspirationInsightRow[];
      archivedInspirationSources?: AutonomyTrustedInspirationInsightRow[];
      latestEvaluatorScorecard?: Record<string, unknown> | null;
      opsSummary?: Record<string, unknown> | null;
    };
    if (!payload.ok) return empty;
    const scorecardRaw =
      payload.latestEvaluatorScorecard &&
      typeof payload.latestEvaluatorScorecard === "object" &&
      !Array.isArray(payload.latestEvaluatorScorecard)
        ? payload.latestEvaluatorScorecard
        : null;
    const nullableNumber = (value: unknown): number | null =>
      value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const finiteNumber = (value: unknown, fallback = 0): number =>
      value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);
    const scorecard: AutonomyEvaluatorScorecard | null = scorecardRaw
      ? {
          id: String(scorecardRaw.id ?? ""),
          windowHours: finiteNumber(scorecardRaw.windowHours, 24),
          sampleCount: finiteNumber(scorecardRaw.sampleCount),
          successRate: nullableNumber(scorecardRaw.successRate),
          regretRate: nullableNumber(scorecardRaw.regretRate),
          avgLatencyMs: nullableNumber(scorecardRaw.avgLatencyMs),
          dispatchCount: finiteNumber(scorecardRaw.dispatchCount),
          recommendation:
            String(scorecardRaw.recommendation ?? "").toLowerCase() === "pause"
              ? "pause"
              : String(scorecardRaw.recommendation ?? "").toLowerCase() === "constrain"
                ? "constrain"
                : "healthy",
          createdAt: String(scorecardRaw.createdAt ?? ""),
        }
      : null;
    const opsRaw =
      payload.opsSummary && typeof payload.opsSummary === "object" ? payload.opsSummary : null;
    const opsSummary: AutonomyOpsSummary | null = opsRaw
      ? {
          safetyState: {
            killSwitchEnabled: Boolean(
              (opsRaw.safetyState as Record<string, unknown> | undefined)?.killSwitchEnabled,
            ),
            freezeUntil:
              typeof (opsRaw.safetyState as Record<string, unknown> | undefined)?.freezeUntil ===
              "string"
                ? String((opsRaw.safetyState as Record<string, unknown>).freezeUntil)
                : null,
            freezeReason:
              typeof (opsRaw.safetyState as Record<string, unknown> | undefined)?.freezeReason ===
              "string"
                ? String((opsRaw.safetyState as Record<string, unknown>).freezeReason)
                : null,
            isFrozen: Boolean(
              (opsRaw.safetyState as Record<string, unknown> | undefined)?.isFrozen,
            ),
            updatedAt:
              typeof (opsRaw.safetyState as Record<string, unknown> | undefined)?.updatedAt ===
              "string"
                ? String((opsRaw.safetyState as Record<string, unknown>).updatedAt)
                : null,
          },
          latestEvaluatorScorecard: scorecard,
          recentAlerts: Array.isArray(opsRaw.recentAlerts)
            ? opsRaw.recentAlerts
                .filter((entry) => entry && typeof entry === "object")
                .map((entry) => {
                  const row = entry as Record<string, unknown>;
                  const sev = String(row.severity ?? "").toLowerCase();
                  return {
                    id: String(row.id ?? ""),
                    alertType: String(row.alertType ?? row.alert_type ?? "generic"),
                    severity:
                      sev === "critical" ? "critical" : sev === "warning" ? "warning" : "info",
                    message: String(row.message ?? ""),
                    details:
                      row.details && typeof row.details === "object" && !Array.isArray(row.details)
                        ? (row.details as Record<string, unknown>)
                        : {},
                    createdAt: String(row.createdAt ?? row.created_at ?? ""),
                  } satisfies AutonomyOpsAlert;
                })
            : [],
          staleDeadLetterCount24h: finiteNumber(opsRaw.staleDeadLetterCount24h),
          lastStaleSweepAt:
            typeof opsRaw.lastStaleSweepAt === "string" ? String(opsRaw.lastStaleSweepAt) : null,
          reliability: (() => {
            const reliability =
              opsRaw.reliability &&
              typeof opsRaw.reliability === "object" &&
              !Array.isArray(opsRaw.reliability)
                ? (opsRaw.reliability as Record<string, unknown>)
                : {};
            const duration =
              reliability.durationMs &&
              typeof reliability.durationMs === "object" &&
              !Array.isArray(reliability.durationMs)
                ? (reliability.durationMs as Record<string, unknown>)
                : {};
            const outcomeCounts =
              reliability.outcomeCounts &&
              typeof reliability.outcomeCounts === "object" &&
              !Array.isArray(reliability.outcomeCounts)
                ? Object.fromEntries(
                    Object.entries(reliability.outcomeCounts as Record<string, unknown>).map(
                      ([key, value]) => [key, finiteNumber(value)],
                    ),
                  )
                : {};
            return {
              windowHours: finiteNumber(reliability.windowHours, 24),
              attemptsTotal: finiteNumber(reliability.attemptsTotal),
              outcomeCounts,
              attemptSuccessRate: nullableNumber(reliability.attemptSuccessRate),
              objectiveTerminalCount: finiteNumber(reliability.objectiveTerminalCount),
              objectiveSuccessRate: nullableNumber(reliability.objectiveSuccessRate),
              nonTerminalRevisionCount: finiteNumber(reliability.nonTerminalRevisionCount),
              nonTerminalRevisionObjectiveCount: finiteNumber(
                reliability.nonTerminalRevisionObjectiveCount,
              ),
              revisedTerminalObjectiveCount: finiteNumber(
                reliability.revisedTerminalObjectiveCount,
              ),
              objectiveRevisionRate: nullableNumber(reliability.objectiveRevisionRate),
              objectiveFirstPassRate: nullableNumber(reliability.objectiveFirstPassRate),
              durationMs: {
                average: nullableNumber(duration.average),
                p50: nullableNumber(duration.p50),
                p95: nullableNumber(duration.p95),
              },
              validationFailureRuns: finiteNumber(reliability.validationFailureRuns),
              validationEvidenceCoverageRate: nullableNumber(
                reliability.validationEvidenceCoverageRate,
              ),
              validationFingerprintCollisionCount: finiteNumber(
                reliability.validationFingerprintCollisionCount,
              ),
              transientValidationRetries: finiteNumber(reliability.transientValidationRetries),
              activeIncidentCount: finiteNumber(reliability.activeIncidentCount),
              workerHandoffFailureCount: finiteNumber(reliability.workerHandoffFailureCount),
              stalledWorkerHandoffCount: finiteNumber(reliability.stalledWorkerHandoffCount),
            };
          })(),
        }
      : null;
    return {
      engineSourceStats: Array.isArray(payload.engineSourceStats) ? payload.engineSourceStats : [],
      trustedInspirationShortlist: Array.isArray(payload.trustedInspirationShortlist)
        ? payload.trustedInspirationShortlist
        : [],
      archivedInspirationSources: Array.isArray(payload.archivedInspirationSources)
        ? payload.archivedInspirationSources
        : [],
      latestEvaluatorScorecard: scorecard,
      opsSummary,
    };
  } catch (err) {
    console.error("Error fetching autonomy insights:", err);
    return empty;
  }
}

export async function fetchAutonomyInspiration(
  baseUrl: string,
  authToken?: string,
  limit = 12,
): Promise<AutonomyInspirationPatternRow[]> {
  try {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
    });
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/autonomy/inspiration?${qs.toString()}`,
      {
        headers: authHeaders(authToken),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      ok?: boolean;
      patterns?: Record<string, unknown>[];
    };
    if (!payload.ok || !Array.isArray(payload.patterns)) return [];
    return payload.patterns
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((row) => {
        const record = row as Record<string, unknown>;
        const metadata =
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : {};
        return {
          id: Number.isFinite(Number(record.id)) ? Number(record.id) : 0,
          fingerprint: String(record.fingerprint ?? ""),
          sourceType: String(record.sourceType ?? record.source_type ?? "unknown"),
          sourceLabel:
            typeof (record.sourceLabel ?? record.source_label) === "string"
              ? String(record.sourceLabel ?? record.source_label)
              : null,
          sourceUrl:
            typeof (record.sourceUrl ?? record.source_url) === "string"
              ? String(record.sourceUrl ?? record.source_url)
              : null,
          sourceRefs: stringArray(record.sourceRefs ?? record.source_refs),
          algorithm: String(record.algorithm ?? ""),
          whenToUse:
            typeof (record.whenToUse ?? record.when_to_use) === "string"
              ? String(record.whenToUse ?? record.when_to_use)
              : null,
          summary:
            typeof record.summary === "string" && record.summary.trim()
              ? String(record.summary)
              : null,
          risks: stringArray(record.risks),
          validationIdeas: stringArray(record.validationIdeas ?? record.validation_ideas),
          tags: stringArray(record.tags),
          qualityScore: Number.isFinite(Number(record.qualityScore ?? record.quality_score))
            ? Number(record.qualityScore ?? record.quality_score)
            : 0,
          freshnessScore: Number.isFinite(Number(record.freshnessScore ?? record.freshness_score))
            ? Number(record.freshnessScore ?? record.freshness_score)
            : 0,
          seenCount: Number.isFinite(Number(record.seenCount ?? record.seen_count))
            ? Number(record.seenCount ?? record.seen_count)
            : 0,
          firstSeenAt: String(record.firstSeenAt ?? record.first_seen_at ?? ""),
          lastSeenAt: String(record.lastSeenAt ?? record.last_seen_at ?? ""),
          updatedAt: String(record.updatedAt ?? record.updated_at ?? ""),
          metadata,
        } satisfies AutonomyInspirationPatternRow;
      });
  } catch (err) {
    console.error("Error fetching autonomy inspiration:", err);
    return [];
  }
}

export async function fetchAutonomyQuestions(
  baseUrl: string,
  authToken?: string,
  params?: {
    sessionId?: string;
    status?: "open" | "answered" | "invalid" | "closed";
    limit?: number;
  },
): Promise<AutonomyQuestionRow[]> {
  try {
    const qs = new URLSearchParams();
    if (params?.sessionId) qs.set("sessionId", params.sessionId);
    if (params?.status) qs.set("status", params.status);
    if (typeof params?.limit === "number" && Number.isFinite(params.limit)) {
      qs.set("limit", String(Math.max(1, Math.min(500, Math.floor(params.limit)))));
    }
    const suffix = qs.toString();
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/questions${suffix ? `?${suffix}` : ""}`,
      {
        headers: authHeaders(authToken),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      ok?: boolean;
      questions?: Record<string, unknown>[];
    };
    if (!payload.ok || !Array.isArray(payload.questions)) return [];
    return payload.questions
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((row) => {
        const record = row as Record<string, unknown>;
        const statusRaw = String(record.status ?? "").toLowerCase();
        const status: AutonomyQuestionRow["status"] =
          statusRaw === "answered" || statusRaw === "invalid" || statusRaw === "closed"
            ? statusRaw
            : "open";
        const expectedAnswerSchema =
          record.expected_answer_schema &&
          typeof record.expected_answer_schema === "object" &&
          !Array.isArray(record.expected_answer_schema)
            ? (record.expected_answer_schema as Record<string, unknown>)
            : {};
        const context =
          record.context && typeof record.context === "object" && !Array.isArray(record.context)
            ? (record.context as Record<string, unknown>)
            : {};
        return {
          id: String(record.id ?? ""),
          objectiveId: String(record.objective_id ?? record.objectiveId ?? ""),
          sessionId: String(record.session_id ?? record.sessionId ?? ""),
          question: String(record.question ?? ""),
          questionType: String(record.question_type ?? record.questionType ?? ""),
          expectedAnswerSchema,
          context,
          status,
          answer: record.answer ?? null,
          answerValidationStatus: String(record.answer_validation_status ?? ""),
          validationError: String(record.validation_error ?? ""),
          createdAt: String(record.created_at ?? ""),
          answeredAt: String(record.answered_at ?? ""),
          expiresAt: String(record.expires_at ?? ""),
          expiresInMs: Number.isFinite(Number(record.expires_in_ms))
            ? Number(record.expires_in_ms)
            : null,
          isExpired: Boolean(record.is_expired),
          closedReason: String(record.closed_reason ?? ""),
        } satisfies AutonomyQuestionRow;
      });
  } catch (err) {
    console.error("Error fetching autonomy questions:", err);
    return [];
  }
}

export async function answerAutonomyQuestion(
  baseUrl: string,
  questionId: string,
  answer: unknown,
  authToken?: string,
  sessionId?: string,
): Promise<AnswerAutonomyQuestionResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/questions/${encodeURIComponent(questionId)}/answer`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          answer,
          ...(sessionId ? { sessionId } : {}),
        }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ok: false,
        reason: typeof payload.reason === "string" ? payload.reason : "Failed to answer question",
      };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const statusRaw = String(payload.status ?? "").toLowerCase();
    return {
      ok: Boolean(payload.ok),
      status: statusRaw === "valid" || statusRaw === "invalid" ? statusRaw : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      objectiveId:
        typeof payload.objectiveId === "string"
          ? payload.objectiveId
          : typeof payload.objective_id === "string"
            ? payload.objective_id
            : undefined,
      resumedRequestId:
        typeof payload.resumedRequestId === "string" ? payload.resumedRequestId : undefined,
      resumeError: typeof payload.resumeError === "string" ? payload.resumeError : undefined,
    };
  } catch (err) {
    console.error("Error answering autonomy question:", err);
    return { ok: false, reason: String(err) };
  }
}

export async function actOnAutonomyQuestion(
  baseUrl: string,
  questionId: string,
  action: "skip" | "close" | "escalate",
  authToken?: string,
  note?: string,
  sessionId?: string,
): Promise<ActOnAutonomyQuestionResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/questions/${encodeURIComponent(questionId)}/action`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          ...(note ? { note } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: Boolean(payload.ok),
      action:
        String(payload.action ?? "").toLowerCase() === "skip" ||
        String(payload.action ?? "").toLowerCase() === "close" ||
        String(payload.action ?? "").toLowerCase() === "escalate"
          ? (String(payload.action).toLowerCase() as "skip" | "close" | "escalate")
          : undefined,
      objectiveId:
        typeof payload.objectiveId === "string"
          ? payload.objectiveId
          : typeof payload.objective_id === "string"
            ? payload.objective_id
            : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    };
  } catch (err) {
    console.error("Error applying autonomy question action:", err);
    return { ok: false, reason: String(err) };
  }
}

export async function fetchAutonomySafety(
  baseUrl: string,
  authToken?: string,
): Promise<AutonomySafetyState | null> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/autonomy/safety`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    if (!payload.ok || !payload.state || typeof payload.state !== "object") return null;
    const state = payload.state as Record<string, unknown>;
    return {
      killSwitchEnabled: Boolean(state.killSwitchEnabled),
      freezeUntil: typeof state.freezeUntil === "string" ? state.freezeUntil : null,
      freezeReason: typeof state.freezeReason === "string" ? state.freezeReason : null,
      isFrozen: Boolean(state.isFrozen),
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    };
  } catch (err) {
    console.error("Error fetching autonomy safety:", err);
    return null;
  }
}

export async function updateAutonomySafety(
  baseUrl: string,
  update: {
    killSwitchEnabled?: boolean;
    freezeForMs?: number;
    freezeUntil?: string;
    freezeReason?: string;
    unfreeze?: boolean;
  },
  authToken?: string,
): Promise<{ ok: boolean; reason?: string; state?: AutonomySafetyState }> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/autonomy/safety`, {
      method: "POST",
      headers,
      body: JSON.stringify(update),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const stateRaw = payload.state && typeof payload.state === "object" ? payload.state : null;
    return {
      ok: Boolean(payload.ok),
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      state: stateRaw
        ? {
            killSwitchEnabled: Boolean((stateRaw as Record<string, unknown>).killSwitchEnabled),
            freezeUntil:
              typeof (stateRaw as Record<string, unknown>).freezeUntil === "string"
                ? String((stateRaw as Record<string, unknown>).freezeUntil)
                : null,
            freezeReason:
              typeof (stateRaw as Record<string, unknown>).freezeReason === "string"
                ? String((stateRaw as Record<string, unknown>).freezeReason)
                : null,
            isFrozen: Boolean((stateRaw as Record<string, unknown>).isFrozen),
            updatedAt:
              typeof (stateRaw as Record<string, unknown>).updatedAt === "string"
                ? String((stateRaw as Record<string, unknown>).updatedAt)
                : null,
          }
        : undefined,
    };
  } catch (err) {
    console.error("Error updating autonomy safety:", err);
    return { ok: false, reason: String(err) };
  }
}

export async function fetchRuntimeConfig(
  baseUrl: string,
  authToken?: string,
): Promise<RuntimeConfigSnapshot | null> {
  try {
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/config/runtime`, {
      headers: authHeaders(authToken),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      config?: Record<string, unknown>;
      files?: { envPath?: string; localTomlPath?: string };
    };
    if (!payload || typeof payload !== "object" || !payload.config) return null;
    return {
      config: payload.config,
      files: payload.files,
    };
  } catch (err) {
    console.error("Error fetching runtime config:", err);
    return null;
  }
}

export async function updateRuntimeConfig(
  baseUrl: string,
  updates: RuntimeConfigMutation[],
  authToken?: string,
): Promise<RuntimeConfigUpdateResult | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const response = await fetchClientResponseWithDeadline(`${baseUrl}/config/runtime`, {
      method: "POST",
      headers,
      body: JSON.stringify({ updates }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      config?: Record<string, unknown>;
      files?: { envPath?: string; localTomlPath?: string };
      applied?: RuntimeConfigMutation[];
      warnings?: string[];
      touchedFiles?: string[];
      restartRequired?: boolean;
      restartRequiredKeys?: string[];
    };
    if (!payload || typeof payload !== "object" || !payload.config) return null;
    return {
      config: payload.config,
      files: payload.files,
      applied: Array.isArray(payload.applied) ? payload.applied : [],
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      touchedFiles: Array.isArray(payload.touchedFiles) ? payload.touchedFiles : [],
      restartRequired: Boolean(payload.restartRequired),
      restartRequiredKeys: Array.isArray(payload.restartRequiredKeys)
        ? payload.restartRequiredKeys.map((entry) => String(entry))
        : [],
    };
  } catch (err) {
    console.error("Error updating runtime config:", err);
    return null;
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

    const response = await fetchClientResponseWithDeadline(
      `${baseUrl}/sessions/${sessionId}/command`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      },
    );

    if (!response.ok) return { ok: false };
    return await response.json();
  } catch (err) {
    console.error("Error sending command:", err);
    return { ok: false };
  }
}
