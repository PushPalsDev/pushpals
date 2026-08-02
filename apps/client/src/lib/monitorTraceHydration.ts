import type { Job, JobStatus, LogLine, SessionState } from "./eventReducer";
import type { JobLogSnapshotRow, JobSnapshotRow } from "./pushpalsApi";

export type JobLogsById = Map<string, JobLogSnapshotRow[]> | Record<string, JobLogSnapshotRow[]>;

const TERMINAL_JOB_STATUSES = new Set<JobStatus>([
  "completed",
  "failed",
  "abandoned",
  "publish_blocked",
]);

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
    case "finalizing":
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

function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

function isNewerOrSame(snapshotTs: string, existingTs: string): boolean {
  const snapshotTime = Date.parse(snapshotTs);
  const existingTime = Date.parse(existingTs);
  if (!Number.isFinite(snapshotTime) || !Number.isFinite(existingTime)) {
    return snapshotTs >= existingTs;
  }
  return snapshotTime >= existingTime;
}

function shouldPromoteSnapshotJob(existing: Job, snapshot: Job): boolean {
  if (!isNewerOrSame(snapshot.ts, existing.ts)) return false;
  if (isTerminalJobStatus(snapshot.status)) return true;
  return snapshot.status === "finalizing" && existing.status !== "finalizing";
}

function mergeSnapshotJob(existing: Job, snapshot: Job): Job {
  return {
    ...existing,
    status: snapshot.status,
    workerId: snapshot.workerId ?? existing.workerId,
    summary: snapshot.summary ?? existing.summary,
    message: snapshot.message ?? existing.message,
    detail: snapshot.detail ?? existing.detail,
    artifacts: snapshot.artifacts ?? existing.artifacts,
    ts: snapshot.ts || existing.ts,
  };
}

function reconcileTaskStatusFromJob(state: SessionState, job: Job): void {
  const task = state.tasks.get(job.taskId);
  if (!task) return;

  const jobIds = task.jobIds.includes(job.jobId) ? task.jobIds : [...task.jobIds, job.jobId];
  const taskJobs = jobIds.map((jobId) => state.jobs.get(jobId)).filter(Boolean) as Job[];
  const hasActiveJob = taskJobs.some((item) => !isTerminalJobStatus(item.status));
  const hasFailedJob = taskJobs.some(
    (item) =>
      item.status === "failed" || item.status === "abandoned" || item.status === "publish_blocked",
  );

  if (job.status === "completed" && task.status !== "failed" && !hasActiveJob && !hasFailedJob) {
    state.tasks.set(job.taskId, {
      ...task,
      status: "completed",
      summary: task.summary ?? job.summary,
      jobIds,
    });
    return;
  }

  if (hasFailedJob && task.status !== "completed" && !hasActiveJob) {
    state.tasks.set(job.taskId, {
      ...task,
      status: "failed",
      message: task.message ?? job.message,
      jobIds,
    });
    return;
  }

  if (jobIds !== task.jobIds) {
    state.tasks.set(job.taskId, { ...task, jobIds });
  }
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
  const tasks = new Map(liveState.tasks);
  const logs = new Map(liveState.logs);
  const logSeenKeys = new Map(liveState.logSeenKeys);

  for (const snapshot of jobSnapshots) {
    const snapshotJob = snapshotToTraceJob(snapshot);
    const existingJob = jobs.get(snapshot.id);
    if (!existingJob) {
      jobs.set(snapshot.id, snapshotJob);
    } else if (shouldPromoteSnapshotJob(existingJob, snapshotJob)) {
      jobs.set(snapshot.id, mergeSnapshotJob(existingJob, snapshotJob));
    }

    const mergedLogs = mergePersistedLogs(
      logs.get(snapshot.id) ?? [],
      logsForJob(logsByJobId, snapshot.id),
    );
    if (mergedLogs.length > 0) {
      logs.set(snapshot.id, mergedLogs);
    }
  }

  const nextState = {
    ...liveState,
    tasks,
    jobs,
    logs,
    logSeenKeys,
    seenIds: new Set(liveState.seenIds),
  };

  for (const job of jobs.values()) {
    if (isTerminalJobStatus(job.status)) {
      reconcileTaskStatusFromJob(nextState, job);
    }
  }

  return nextState;
}
