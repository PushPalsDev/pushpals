export type ClientTransport = "session" | "sse" | "ws";

export interface ClientPresenceMetadata {
  clientId: string;
  kind: string;
  label?: string;
  version?: string;
  platform?: string;
  repoRoot?: string;
  userAgent?: string;
}

export interface ClientPresenceSnapshotRow extends ClientPresenceMetadata {
  sessionId: string;
  status: "connected" | "announced";
  connectedTransports: ClientTransport[];
  announcedAt: string;
  lastSeenAt: string;
}

export interface ClientPresenceSnapshot {
  total: number;
  connected: number;
  byKind: Record<string, number>;
  items: ClientPresenceSnapshotRow[];
}

export interface ClientPresenceRegistryOptions {
  retentionMs?: number;
  connectedRetentionMs?: number;
  now?: () => number;
}

type ClientPresenceRecord = ClientPresenceMetadata & {
  sessionId: string;
  announcedAtMs: number;
  lastSeenAtMs: number;
  transportConnections: Map<ClientTransport, Set<string>>;
};

const DISCONNECTED_RETENTION_MS = 10 * 60 * 1000;
const CONNECTED_RETENTION_MS = 90 * 1000;

function compactText(value: unknown, maxChars: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeKind(value: unknown): string {
  const text = compactText(value, 48).toLowerCase();
  if (!text) return "";
  return text.replace(/[^a-z0-9._-]+/g, "_");
}

function defaultLabelForKind(kind: string): string {
  switch (kind) {
    case "cli":
      return "CLI";
    case "cli_monitor":
      return "CLI Monitor";
    case "vscode":
      return "VS Code";
    case "web":
      return "Web Client";
    default:
      return kind || "Unknown Client";
  }
}

function readHeader(headers: Headers, name: string): string {
  return compactText(headers.get(name), 512);
}

function readParam(url: URL, name: string): string {
  return compactText(url.searchParams.get(name), 512);
}

function normalizeMetadata(value: unknown, userAgent: string): ClientPresenceMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const clientId = compactText(record.clientId, 128);
  const kind = normalizeKind(record.kind);
  if (!clientId || !kind) return null;
  const label = compactText(record.label, 120) || defaultLabelForKind(kind);
  const version = compactText(record.version, 64);
  const platform = compactText(record.platform, 120);
  const repoRoot = compactText(record.repoRoot, 400);
  return {
    clientId,
    kind,
    label,
    ...(version ? { version } : {}),
    ...(platform ? { platform } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

export function readClientPresenceFromSessionBody(
  body: unknown,
  headers: Headers,
): ClientPresenceMetadata | null {
  const userAgent = readHeader(headers, "user-agent");
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return normalizeMetadata((body as Record<string, unknown>).client, userAgent);
}

export function readClientPresenceFromTransportRequest(
  url: URL,
  headers: Headers,
): ClientPresenceMetadata | null {
  const userAgent = readHeader(headers, "user-agent");
  return normalizeMetadata(
    {
      clientId: readParam(url, "clientId") || readHeader(headers, "x-pushpals-client-id"),
      kind: readParam(url, "clientKind") || readHeader(headers, "x-pushpals-client-kind"),
      label: readParam(url, "clientLabel") || readHeader(headers, "x-pushpals-client-label"),
      version: readParam(url, "clientVersion") || readHeader(headers, "x-pushpals-client-version"),
      platform:
        readParam(url, "clientPlatform") || readHeader(headers, "x-pushpals-client-platform"),
      repoRoot:
        readParam(url, "clientRepoRoot") || readHeader(headers, "x-pushpals-client-repo-root"),
    },
    userAgent,
  );
}

export class ClientPresenceRegistry {
  private records: Map<string, ClientPresenceRecord> = new Map();
  private readonly retentionMs: number;
  private readonly connectedRetentionMs: number;
  private readonly now: () => number;

  constructor(options: ClientPresenceRegistryOptions = {}) {
    this.retentionMs = Math.max(1, options.retentionMs ?? DISCONNECTED_RETENTION_MS);
    this.connectedRetentionMs = Math.max(1, options.connectedRetentionMs ?? CONNECTED_RETENTION_MS);
    this.now = options.now ?? Date.now;
  }

  announce(sessionId: string, metadata: ClientPresenceMetadata, source: ClientTransport): void {
    const now = this.now();
    this.pruneExpired(now);
    const record = this.upsertRecord(sessionId, metadata, now);
    record.lastSeenAtMs = now;
    if (source !== "session") {
      this.connectionSet(record, source).add(`${source}-announced`);
    }
    console.log(
      `[Client] announced kind=${record.kind} clientId=${record.clientId} session=${sessionId} source=${source}`,
    );
  }

  connect(
    sessionId: string,
    metadata: ClientPresenceMetadata,
    transport: "sse" | "ws",
    connectionId: string,
  ): void {
    const now = this.now();
    this.pruneExpired(now);
    const record = this.upsertRecord(sessionId, metadata, now);
    const connections = this.connectionSet(record, transport);
    const alreadyConnected = connections.size > 0;
    connections.add(connectionId);
    record.lastSeenAtMs = now;
    if (!alreadyConnected) {
      console.log(
        `[Client] connected kind=${record.kind} clientId=${record.clientId} session=${sessionId} transport=${transport}`,
      );
    }
  }

  disconnect(clientId: string, transport: "sse" | "ws", connectionId: string): void {
    this.pruneExpired();
    const record = this.records.get(clientId);
    if (!record) return;
    const connections = record.transportConnections.get(transport);
    if (!connections) return;
    if (!connections.delete(connectionId)) return;
    if (connections.size === 0) {
      record.transportConnections.delete(transport);
    }
    record.lastSeenAtMs = this.now();
    console.log(
      `[Client] disconnected kind=${record.kind} clientId=${record.clientId} session=${record.sessionId} transport=${transport}`,
    );
  }

  touch(clientId: string, transport: "sse" | "ws", connectionId?: string): void {
    const record = this.records.get(clientId);
    if (!record) return;
    const connections = record.transportConnections.get(transport);
    if (!connections || connections.size === 0) return;
    if (connectionId && !connections.has(connectionId)) return;
    record.lastSeenAtMs = this.now();
  }

  snapshot(): ClientPresenceSnapshot {
    this.pruneExpired();
    const rows = [...this.records.values()]
      .map(
        (record): ClientPresenceSnapshotRow => ({
          clientId: record.clientId,
          kind: record.kind,
          ...(record.label ? { label: record.label } : {}),
          ...(record.version ? { version: record.version } : {}),
          ...(record.platform ? { platform: record.platform } : {}),
          ...(record.repoRoot ? { repoRoot: record.repoRoot } : {}),
          ...(record.userAgent ? { userAgent: record.userAgent } : {}),
          sessionId: record.sessionId,
          status: this.connectedTransportKeys(record).length > 0 ? "connected" : "announced",
          connectedTransports: this.connectedTransportKeys(record),
          announcedAt: new Date(record.announcedAtMs).toISOString(),
          lastSeenAt: new Date(record.lastSeenAtMs).toISOString(),
        }),
      )
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "connected" ? -1 : 1;
        return b.lastSeenAt.localeCompare(a.lastSeenAt);
      });

    const byKind: Record<string, number> = {};
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }

    return {
      total: rows.length,
      connected: rows.filter((row) => row.status === "connected").length,
      byKind,
      items: rows,
    };
  }

  private upsertRecord(
    sessionId: string,
    metadata: ClientPresenceMetadata,
    now: number,
  ): ClientPresenceRecord {
    const existing = this.records.get(metadata.clientId);
    if (existing) {
      existing.sessionId = sessionId;
      existing.kind = metadata.kind;
      existing.label = metadata.label;
      existing.version = metadata.version;
      existing.platform = metadata.platform;
      existing.repoRoot = metadata.repoRoot;
      existing.userAgent = metadata.userAgent;
      existing.lastSeenAtMs = now;
      return existing;
    }

    const created: ClientPresenceRecord = {
      ...metadata,
      sessionId,
      announcedAtMs: now,
      lastSeenAtMs: now,
      transportConnections: new Map(),
    };
    this.records.set(metadata.clientId, created);
    return created;
  }

  private connectionSet(record: ClientPresenceRecord, transport: ClientTransport): Set<string> {
    let connections = record.transportConnections.get(transport);
    if (!connections) {
      connections = new Set<string>();
      record.transportConnections.set(transport, connections);
    }
    return connections;
  }

  private connectedTransportKeys(record: ClientPresenceRecord): ClientTransport[] {
    return [...record.transportConnections.entries()]
      .filter(([, connections]) => connections.size > 0)
      .map(([transport]) => transport)
      .sort();
  }

  pruneExpired(now = this.now()): number {
    let removed = 0;
    for (const [clientId, record] of this.records.entries()) {
      const connected = this.connectedTransportKeys(record).length > 0;
      const maxAgeMs = connected ? this.connectedRetentionMs : this.retentionMs;
      if (now - record.lastSeenAtMs <= maxAgeMs) continue;
      this.records.delete(clientId);
      removed++;
    }
    return removed;
  }
}
