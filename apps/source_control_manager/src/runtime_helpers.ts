import { fetchBufferedWithHardDeadline, type FetchLike } from "shared";
import type { SourceControlManagerConfig } from "./config";

export type SourceControlManagerStartupStatusPhase = "startup" | "online" | "shutdown";
export type ReviewAgentRuntimeReadiness = {
  ready: boolean;
  detail: string;
};

export function buildReviewAgentRuntimeFingerprint(params: {
  serverUrl: string;
  remoteUrl: string;
  prBaseBranch: string;
  branchPrefix: string;
  reviewAgent: SourceControlManagerConfig["reviewAgent"];
  gitProviderToken: string;
  serverAuthToken?: string;
}): string {
  // Runtime readiness and mutable review policy deliberately are not
  // structural identity. Recreating the agent for a threshold, merge policy,
  // reviewer prompt, or readiness change loses provider cursors and retry
  // state. The timer cadence is structural because changing it requires a new
  // interval.
  return JSON.stringify({
    serverUrl: params.serverUrl,
    remoteUrl: params.remoteUrl,
    prBaseBranch: params.prBaseBranch,
    branchPrefix: params.branchPrefix,
    pollIntervalMs: params.reviewAgent.pollIntervalMs,
    gitProviderToken: params.gitProviderToken,
    serverAuthToken: params.serverAuthToken ?? "",
  });
}

export type SourceControlManagerPublicationHealth = {
  backlog: number;
  pending: number;
  claimed: number;
  finalizing: number;
  oldestPendingAgeMs: number;
  oldestFinalizingAgeMs: number;
  unhealthy: boolean;
  observedAt?: string;
};

export type SourceControlManagerReviewProviderHealth = {
  status: "idle" | "running" | "ok" | "degraded" | "stalled";
  inFlight: boolean;
  pollAgeMs: number;
  stalled: boolean;
  lastPollStartedAt: string | null;
  lastPollCompletedAt: string | null;
  lastSuccessfulPollAt: string | null;
  consecutiveFailedPolls: number;
  failureEvents: number;
  lastError: string | null;
  persistedLinkRetryCount: number;
  persistedLinkCursor: string | null;
};

export function createBlockedReviewProviderHealth(
  reason: string,
): SourceControlManagerReviewProviderHealth {
  return {
    status: "degraded",
    inFlight: false,
    pollAgeMs: 0,
    stalled: false,
    lastPollStartedAt: null,
    lastPollCompletedAt: null,
    lastSuccessfulPollAt: null,
    consecutiveFailedPolls: 1,
    failureEvents: 1,
    lastError: String(reason || "review provider reconciliation is blocked").slice(0, 600),
    persistedLinkRetryCount: 0,
    persistedLinkCursor: null,
  };
}

export type SourceControlManagerHealthSnapshot = {
  healthy: boolean;
  status: "ok" | "unhealthy";
  reason: string | null;
  startedAt: string;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastProgressAt: string;
  activeTick: boolean;
  activeCompletionId: string | null;
  phase: string;
  publication: SourceControlManagerPublicationHealth | null;
  reviewProvider: SourceControlManagerReviewProviderHealth | null;
  degradedComponents?: string[];
};

export function withReviewProviderHealth(
  snapshot: SourceControlManagerHealthSnapshot,
  reviewProvider: SourceControlManagerReviewProviderHealth | null,
): SourceControlManagerHealthSnapshot {
  const providerStalled = reviewProvider?.stalled === true;
  const degradedComponents = new Set(snapshot.degradedComponents ?? []);
  if (
    reviewProvider &&
    (reviewProvider.status === "degraded" ||
      reviewProvider.status === "stalled" ||
      reviewProvider.consecutiveFailedPolls > 0)
  ) {
    degradedComponents.add("review_provider");
  } else {
    degradedComponents.delete("review_provider");
  }
  return {
    ...snapshot,
    healthy: snapshot.healthy && !providerStalled,
    status: snapshot.healthy && providerStalled ? "unhealthy" : snapshot.status,
    reason:
      snapshot.reason ??
      (providerStalled
        ? `review_provider_reconciliation_stalled_${reviewProvider.pollAgeMs}ms`
        : null),
    reviewProvider: reviewProvider ? { ...reviewProvider } : null,
    degradedComponents: [...degradedComponents],
  };
}

export function createSourceControlManagerHealthTracker(options: {
  tickStallMs: number;
  idleBacklogGraceMs: number;
  now?: () => number;
}): {
  beginTick: (phase?: string) => void;
  progress: (phase: string, completionId?: string | null) => void;
  completeTick: () => void;
  updatePublication: (publication: SourceControlManagerPublicationHealth | null) => void;
  snapshot: () => SourceControlManagerHealthSnapshot;
} {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  let lastTickStartedAtMs: number | null = null;
  let lastTickCompletedAtMs: number | null = null;
  let lastProgressAtMs = startedAtMs;
  let activeTick = false;
  let activeCompletionId: string | null = null;
  let phase = "startup";
  let publication: SourceControlManagerPublicationHealth | null = null;
  const toIso = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString();

  return {
    beginTick(nextPhase = "polling") {
      const at = now();
      activeTick = true;
      activeCompletionId = null;
      phase = nextPhase;
      lastTickStartedAtMs = at;
      lastProgressAtMs = at;
    },
    progress(nextPhase, completionId) {
      phase = String(nextPhase || phase);
      if (completionId !== undefined) activeCompletionId = completionId;
      lastProgressAtMs = now();
    },
    completeTick() {
      const at = now();
      activeTick = false;
      activeCompletionId = null;
      phase = "idle";
      lastTickCompletedAtMs = at;
      lastProgressAtMs = at;
    },
    updatePublication(nextPublication) {
      publication = nextPublication ? { ...nextPublication } : null;
    },
    snapshot() {
      const at = now();
      const progressAgeMs = Math.max(0, at - lastProgressAtMs);
      let reason: string | null = null;
      if (activeTick && progressAgeMs >= Math.max(1_000, options.tickStallMs)) {
        reason = `tick_stalled_${progressAgeMs}ms_phase_${phase}`;
      } else if (publication?.unhealthy && !activeTick) {
        const idleSince = lastTickCompletedAtMs ?? startedAtMs;
        const idleAgeMs = Math.max(0, at - idleSince);
        if (idleAgeMs >= Math.max(1_000, options.idleBacklogGraceMs)) {
          reason = `publication_backlog_stalled_${publication.backlog}_oldest_${Math.max(
            publication.oldestPendingAgeMs,
            publication.oldestFinalizingAgeMs,
          )}ms`;
        }
      }
      return {
        healthy: reason === null,
        status: reason === null ? "ok" : "unhealthy",
        reason,
        startedAt: new Date(startedAtMs).toISOString(),
        lastTickStartedAt: toIso(lastTickStartedAtMs),
        lastTickCompletedAt: toIso(lastTickCompletedAtMs),
        lastProgressAt: new Date(lastProgressAtMs).toISOString(),
        activeTick,
        activeCompletionId,
        phase,
        publication: publication ? { ...publication } : null,
        reviewProvider: null,
      };
    },
  };
}

type SystemStatusClientRow = {
  clientId?: unknown;
  label?: unknown;
  sessionId?: unknown;
  status?: unknown;
};

export function cloneSourceControlManagerConfigSnapshot(
  config: SourceControlManagerConfig,
): SourceControlManagerConfig {
  return {
    ...config,
    checks: config.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...config.reviewAgent,
    },
  };
}

export function createSingleFlightExecutor<T>(worker: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => worker())().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createStartupStatusTracker(
  initialPhase: SourceControlManagerStartupStatusPhase = "startup",
): {
  getPhase: () => SourceControlManagerStartupStatusPhase;
  canEmitInitializing: (running: boolean) => boolean;
  beginOnlineTransition: () => boolean;
  revertOnlineTransition: () => void;
  markShutdown: () => void;
} {
  let phase = initialPhase;

  return {
    getPhase: () => phase,
    canEmitInitializing: (running: boolean) => running && phase === "startup",
    beginOnlineTransition: () => {
      if (phase !== "startup") return false;
      phase = "online";
      return true;
    },
    revertOnlineTransition: () => {
      if (phase === "online") {
        phase = "startup";
      }
    },
    markShutdown: () => {
      phase = "shutdown";
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePresenceToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isRemoteBuddyClientRow(row: SystemStatusClientRow): boolean {
  const clientId = normalizePresenceToken(row.clientId);
  const label = normalizePresenceToken(row.label);
  return clientId.includes("remotebuddy") || label.includes("remotebuddy");
}

function getStatusClientRows(statusPayload: unknown): SystemStatusClientRow[] {
  if (!isRecord(statusPayload)) return [];
  const clients = statusPayload.clients;
  if (!isRecord(clients) || !Array.isArray(clients.items)) return [];
  return clients.items.filter((row): row is SystemStatusClientRow => isRecord(row));
}

function getFiniteNonNegativeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return null;
  return numberValue;
}

function getWorkerCapacity(statusPayload: unknown): {
  online: number | null;
  idle: number | null;
} {
  if (!isRecord(statusPayload) || !isRecord(statusPayload.workers)) {
    return { online: null, idle: null };
  }
  return {
    online: getFiniteNonNegativeNumber(statusPayload.workers.online),
    idle: getFiniteNonNegativeNumber(statusPayload.workers.idle),
  };
}

export function summarizeReviewAgentRuntimeReadiness(
  statusPayload: unknown,
  sessionId: string,
): ReviewAgentRuntimeReadiness {
  if (!isRecord(statusPayload) || statusPayload.ok !== true) {
    return { ready: false, detail: "server /system/status is not healthy" };
  }

  const expectedSessionId = sessionId.trim();
  const rows = getStatusClientRows(statusPayload);
  const sessionRows = rows.filter(
    (row) => String(row.sessionId ?? "").trim() === expectedSessionId,
  );
  const remoteBuddyRows = sessionRows.filter(isRemoteBuddyClientRow);
  const connectedRemoteBuddy = remoteBuddyRows.find(
    (row) => normalizePresenceToken(row.status) === "connected",
  );

  if (!connectedRemoteBuddy) {
    const anyRemoteBuddyRows = rows.filter(isRemoteBuddyClientRow);
    const connectedOtherSession = anyRemoteBuddyRows.find((row) => {
      const rowSessionId = String(row.sessionId ?? "").trim();
      return (
        rowSessionId &&
        rowSessionId !== expectedSessionId &&
        normalizePresenceToken(row.status) === "connected"
      );
    });
    if (connectedOtherSession) {
      const otherSession = String(connectedOtherSession.sessionId ?? "").trim() || "unknown";
      const otherClient = String(connectedOtherSession.clientId ?? "").trim() || "unknown client";
      return {
        ready: false,
        detail: `RemoteBuddy is connected to session ${otherSession} (${otherClient}), not ${expectedSessionId}`,
      };
    }
    if (remoteBuddyRows.length > 0) {
      return {
        ready: false,
        detail: `RemoteBuddy session consumer exists for ${expectedSessionId} but is not connected`,
      };
    }
    return {
      ready: false,
      detail: `No connected RemoteBuddy session consumer found for session ${expectedSessionId}`,
    };
  }

  const workers = getWorkerCapacity(statusPayload);
  if (workers.online === null || workers.online < 1) {
    return {
      ready: false,
      detail: "WorkerPal capacity is not online yet",
    };
  }

  const clientId = String(connectedRemoteBuddy.clientId ?? "").trim() || "unknown client";
  const idleDetail = workers.idle === null ? "unknown idle" : `${workers.idle} idle`;
  return {
    ready: true,
    detail: `RemoteBuddy session consumer connected (${clientId}); WorkerPals online=${workers.online}, ${idleDetail}`,
  };
}

export async function probeReviewAgentRuntimeReadiness(options: {
  serverUrl: string;
  sessionId: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ReviewAgentRuntimeReadiness> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 2_500);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = {};
    if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${options.serverUrl.replace(/\/+$/, "")}/system/status`,
      init: { headers },
      timeoutMs,
      fetchImpl,
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMessage: `system status probe timed out after ${timeoutMs}ms`,
    });
    if (!response.ok) {
      return {
        ready: false,
        detail: `system status probe failed with HTTP ${response.status}`,
      };
    }
    const payload = (await response.json().catch(() => ({}))) as unknown;
    return summarizeReviewAgentRuntimeReadiness(payload, options.sessionId);
  } catch (err) {
    return {
      ready: false,
      detail: `system status probe failed: ${String(err)}`,
    };
  }
}
