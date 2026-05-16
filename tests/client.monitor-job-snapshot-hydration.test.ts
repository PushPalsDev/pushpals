import { describe, expect, test } from "bun:test";
import {
  initialState,
  type Job,
  type LogLine,
  type SessionState,
} from "../apps/client/src/lib/eventReducer";
import { hydrateMonitorTraceState } from "../apps/client/src/lib/monitorTraceHydration";
import type { JobLogSnapshotRow, JobSnapshotRow } from "../apps/client/src/lib/pushpalsApi";

function jobSnapshot(overrides: Partial<JobSnapshotRow> = {}): JobSnapshotRow {
  return {
    id: "job-1",
    taskId: "task-1",
    sessionId: "dev",
    kind: "task.execute",
    params: JSON.stringify({ requestId: "request-1", instruction: "Improve the thing" }),
    priority: "normal",
    queueWaitBudgetMs: 90_000,
    executionBudgetMs: 1_800_000,
    finalizationBudgetMs: 120_000,
    status: "claimed",
    workerId: "workerpal-1",
    targetWorkerId: null,
    result: null,
    error: null,
    enqueuedAt: "2026-05-16T09:00:00.000Z",
    claimedAt: "2026-05-16T09:00:01.000Z",
    startedAt: "2026-05-16T09:00:02.000Z",
    firstLogAt: "2026-05-16T09:00:03.000Z",
    failedAt: null,
    abandonedAt: null,
    publishBlockedAt: null,
    completedAt: null,
    durationMs: null,
    resumeOfJobId: null,
    attempt: 1,
    createdAt: "2026-05-16T09:00:00.000Z",
    updatedAt: "2026-05-16T09:00:04.000Z",
    ...overrides,
  };
}

function withLiveJob(job: Job, logs: LogLine[] = []): SessionState {
  const state = initialState();
  state.jobs.set(job.jobId, job);
  if (logs.length > 0) {
    state.logs.set(job.jobId, logs);
  }
  return state;
}

describe("monitor trace hydration", () => {
  test("hydrates claimed snapshot jobs when live session state is empty", () => {
    const state = hydrateMonitorTraceState(initialState(), [jobSnapshot()]);
    const job = state.jobs.get("job-1");

    expect(state.jobs.size).toBe(1);
    expect(job?.status).toBe("claimed");
    expect(job?.workerId).toBe("workerpal-1");
    expect(job?.params?.requestId).toBe("request-1");
  });

  test("preserves live jobs and dedupes persisted logs by timestamp and message", () => {
    const liveJob: Job = {
      jobId: "job-1",
      taskId: "task-1",
      kind: "task.execute",
      status: "claimed",
      workerId: "workerpal-live",
      ts: "2026-05-16T09:00:01.000Z",
    };
    const liveLog: LogLine = {
      jobId: "job-1",
      stream: "stdout",
      seq: 1,
      line: "same line",
      ts: "2026-05-16T09:00:02.000Z",
    };
    const persistedLogs: JobLogSnapshotRow[] = [
      { id: 10, jobId: "job-1", message: "same line", ts: "2026-05-16T09:00:02.000Z" },
      { id: 11, jobId: "job-1", message: "new durable line", ts: "2026-05-16T09:00:03.000Z" },
    ];

    const state = hydrateMonitorTraceState(
      withLiveJob(liveJob, [liveLog]),
      [jobSnapshot({ status: "completed", result: JSON.stringify({ summary: "snapshot done" }) })],
      { "job-1": persistedLogs },
    );

    expect(state.jobs.get("job-1")?.status).toBe("claimed");
    expect(state.jobs.get("job-1")?.workerId).toBe("workerpal-live");
    expect(state.logs.get("job-1")?.map((log) => log.line)).toEqual([
      "same line",
      "new durable line",
    ]);
  });

  test("converts persisted job logs into trace log lines", () => {
    const state = hydrateMonitorTraceState(initialState(), [jobSnapshot()], {
      "job-1": [
        { id: 42, jobId: "job-1", message: "persisted output", ts: "2026-05-16T09:00:05.000Z" },
      ],
    });

    expect(state.logs.get("job-1")).toEqual([
      {
        jobId: "job-1",
        stream: "stdout",
        seq: 42,
        line: "persisted output",
        ts: "2026-05-16T09:00:05.000Z",
      },
    ]);
  });

  test("does not seed live event dedupe keys from persisted database log ids", () => {
    const state = hydrateMonitorTraceState(initialState(), [jobSnapshot()], {
      "job-1": [
        { id: 42, jobId: "job-1", message: "persisted output", ts: "2026-05-16T09:00:05.000Z" },
      ],
    });

    expect(state.logSeenKeys.has("job-1")).toBe(false);
  });

  test("hydrates failed, abandoned, and publish-blocked snapshots with diagnostics", () => {
    const state = hydrateMonitorTraceState(initialState(), [
      jobSnapshot({
        id: "failed-job",
        status: "failed",
        error: JSON.stringify({ message: "failed message", detail: "failed detail" }),
      }),
      jobSnapshot({
        id: "abandoned-job",
        status: "abandoned",
        error: JSON.stringify({ message: "abandoned message", detail: "abandoned detail" }),
      }),
      jobSnapshot({
        id: "blocked-job",
        status: "publish_blocked",
        error: JSON.stringify({ message: "blocked message", detail: "blocked detail" }),
      }),
    ]);

    expect(state.jobs.get("failed-job")).toMatchObject({
      status: "failed",
      message: "failed message",
      detail: "failed detail",
    });
    expect(state.jobs.get("abandoned-job")).toMatchObject({
      status: "abandoned",
      message: "abandoned message",
      detail: "abandoned detail",
    });
    expect(state.jobs.get("blocked-job")).toMatchObject({
      status: "publish_blocked",
      message: "blocked message",
      detail: "blocked detail",
    });
  });

  test("parses job result summaries and artifact text", () => {
    const state = hydrateMonitorTraceState(initialState(), [
      jobSnapshot({
        status: "completed",
        result: JSON.stringify({
          summary: "completed summary",
          artifacts: JSON.stringify([{ kind: "stdout", text: "durable stdout" }]),
        }),
      }),
    ]);

    expect(state.jobs.get("job-1")).toMatchObject({
      status: "completed",
      summary: "completed summary",
      artifacts: [{ kind: "stdout", text: "durable stdout" }],
    });
  });
});
