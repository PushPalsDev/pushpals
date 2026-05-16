import type { SourceControlManagerConfig } from "./config";

export type SourceControlManagerStartupStatusPhase = "startup" | "online" | "shutdown";
export type ReviewAgentRuntimeReadiness = {
  ready: boolean;
  detail: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;
    const response = await fetchImpl(`${options.serverUrl.replace(/\/+$/, "")}/system/status`, {
      headers,
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}
