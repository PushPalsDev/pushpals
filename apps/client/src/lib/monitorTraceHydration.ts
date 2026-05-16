import type { Job, JobStatus, LogLine, SessionState } from "./eventReducer";
import type { JobLogSnapshotRow, JobSnapshotRow } from "./pushpalsApi";

export type JobLogsById = Map<string, JobLogSnapshotRow[]> | Record<string, JobLogSnapshotRow[]>;

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseArtifacts(value: unknown): Job["artifacts"] {
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return undefined;
  const artifacts = raw
    .filter((entry): entry is Record<string, unknown> => {
      return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
    })
    .map((entry) => ({
      kind: String(entry.kind ?? "artifact"),
      uri: typeof entry.uri === "string" ? entry.uri : undefined,
      text: typeof entry.text === "string" ? entry.text : undefined,
    }))
    .filter((entry) => entry.uri || entry.text);
  return artifacts.length > 0 ? artifacts : undefined;
}

function toTraceJobStatus(status: JobSnapshotRow["status"]): JobStatus {
  switch (status) {
    case "pending":
    case "claimed":
    case "completed":
    case "failed":
    case "abandoned":
    case "publish_blocked":
      return status;
    default:
      return "enqueued";
  }
}

function snapshotToTraceJob(row: JobSnapshotRow): Job {
  const result = parseJsonRecord(row.result);
  const error = parseJsonRecord(row.error);
  const fallbackError = row.error && !error ? row.error : undefined;
  const message =
    typeof error?.message === "string"
      ? error.message
      : row.status === "failed" || row.status === "abandoned" || row.status === "publish_blocked"
        ? fallbackError
        : undefined;
  const detail = typeof error?.detail === "string" ? error.detail : undefined;

  return {
    jobId: row.id,
    taskId: row.taskId,
    kind: row.kind,
    params: parseJsonRecord(row.params) ?? undefined,
    status: toTraceJobStatus(row.status),
    workerId: row.workerId ?? undefined,
    summary: typeof result?.summary === "string" ? result.summary : undefined,
    message,
    detail,
    artifacts: parseArtifacts(result?.artifacts),
    ts: row.updatedAt || row.createdAt,
  };
}

function logsForJob(logsByJobId: JobLogsById | undefined, jobId: string): JobLogSnapshotRow[] {
  if (!logsByJobId) return [];
  if (logsByJobId instanceof Map) return logsByJobId.get(jobId) ?? [];
  return logsByJobId[jobId] ?? [];
}

function mergePersistedLogs(
  existingLogs: LogLine[],
  persistedLogs: JobLogSnapshotRow[],
): LogLine[] {
  if (persistedLogs.length === 0) return existingLogs;
  const merged = [...existingLogs];
  const seen = new Set(merged.map((line) => `${line.ts}|${line.line}`));
  for (const row of [...persistedLogs].sort((a, b) => a.id - b.id)) {
    const line = row.message.trim();
    if (!line) continue;
    const key = `${row.ts}|${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      jobId: row.jobId,
      stream: "stdout",
      seq: row.id,
      line,
      ts: row.ts,
    });
  }
  return merged.sort((a, b) => {
    const tsOrder = a.ts.localeCompare(b.ts);
    return tsOrder !== 0 ? tsOrder : a.seq - b.seq;
  });
}

export function hydrateMonitorTraceState(
  liveState: SessionState,
  jobSnapshots: JobSnapshotRow[],
  logsByJobId?: JobLogsById,
): SessionState {
  const jobs = new Map(liveState.jobs);
  const logs = new Map(liveState.logs);
  const logSeenKeys = new Map(liveState.logSeenKeys);

  for (const snapshot of jobSnapshots) {
    if (!jobs.has(snapshot.id)) {
      jobs.set(snapshot.id, snapshotToTraceJob(snapshot));
    }

    const mergedLogs = mergePersistedLogs(
      logs.get(snapshot.id) ?? [],
      logsForJob(logsByJobId, snapshot.id),
    );
    if (mergedLogs.length > 0) {
      logs.set(snapshot.id, mergedLogs);
    }
  }

  return {
    ...liveState,
    jobs,
    logs,
    logSeenKeys,
    seenIds: new Set(liveState.seenIds),
  };
}
