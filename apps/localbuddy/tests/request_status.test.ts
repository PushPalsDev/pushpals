import { afterEach, describe, expect, test } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "../src/request_status";

const summarizeFailure = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const fixedFormatTime = () => "10:00 PM";

describe("buildJobStatusReply (apps/localbuddy)", () => {
  const originalNow = Date.now;

  afterEach(() => {
    Date.now = originalNow;
  });

  // Success path: regression guard to ensure completed jobs surface runtime, logs, and thinking hints.
  test("includes runtime and latest WorkerPal logs when a job completed successfully", () => {
    const job: JobApiRow = {
      id: "ff112233-4444-4555-8666-777788889999",
      taskId: "task-completed",
      sessionId: "demo",
      status: "completed",
      workerId: "workerpal-omega",
      params: "{}",
      error: null,
      durationMs: 45000,
      createdAt: "2026-02-15T04:00:00.000Z",
      claimedAt: "2026-02-15T04:00:05.000Z",
      startedAt: "2026-02-15T04:00:10.000Z",
      completedAt: "2026-02-15T04:00:55.000Z",
      updatedAt: "2026-02-15T04:00:56.000Z",
    };

    const logs: JobLogApiRow[] = [
      {
        id: 1,
        jobId: job.id,
        ts: "2026-02-15T04:00:20.000Z",
        message: "Fetched context chunks",
      },
      {
        id: 2,
        jobId: job.id,
        ts: "2026-02-15T04:00:30.000Z",
        message: "Thinking: evaluating fallback strategy",
      },
      {
        id: 3,
        jobId: job.id,
        ts: "2026-02-15T04:00:50.000Z",
        message: "Finalized user reply",
      },
    ];

    const reply = buildJobStatusReply({
      userPrompt: "status for the latest job?",
      sessionId: "demo",
      jobs: [job],
      logs,
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain("Job ff112233 is completed");
    expect(reply).toContain("Runtime: 45s.");
    expect(reply).toContain("Latest logs:");
    expect(reply).toContain("Finalized user reply");
    expect(reply).toContain("Model hint: Thinking: evaluating fallback strategy");
  });

  // Covers the implicit selection path plus elapsed/budget metadata.
  test("auto-selects the most actionable job and surfaces elapsed/budget metadata", () => {
    const claimedJob: JobApiRow = {
      id: "e6ad8a0b-aaaa-4bbb-8ccc-dddddddddddd",
      taskId: "task-claimed",
      sessionId: "demo",
      status: "claimed",
      workerId: "workerpal-abc123",
      params: JSON.stringify({ planning: { executionBudgetMs: 600000 } }),
      error: null,
      createdAt: "2026-02-13T03:00:00.000Z",
      claimedAt: "2026-02-13T03:05:00.000Z",
      startedAt: "2026-02-13T03:05:15.000Z",
      updatedAt: "2026-02-13T03:07:00.000Z",
    };
    const pendingJob: JobApiRow = {
      id: "7f4a1f98-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      taskId: "task-pending",
      sessionId: "demo",
      status: "pending",
      workerId: null,
      params: "{}",
      error: null,
      createdAt: "2026-02-13T02:50:00.000Z",
      updatedAt: "2026-02-13T02:50:01.000Z",
    };

    const elapsedNow = Date.parse("2026-02-13T03:10:15.000Z");
    Date.now = () => elapsedNow;

    const timeoutIso = new Date(Date.parse(claimedJob.startedAt!) + 600000).toISOString();
    const formatTime = (iso: string): string => {
      if (iso === claimedJob.updatedAt) return "updated-time";
      if (iso === timeoutIso) return "timeout-deadline";
      return "formatted";
    };

    const reply = buildJobStatusReply({
      userPrompt: "what's the job status right now?",
      sessionId: "demo",
      jobs: [pendingJob, claimedJob],
      logs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain("Job e6ad8a0b is claimed");
    expect(reply).toContain("updated updated-time");
    expect(reply).toContain("Elapsed: 5m 0s.");
    expect(reply).toContain("Timeout target: timeout-deadline.");
  });

  // Edge case: user asks for a job status before any jobs exist.
  test("explains when a job lookup is requested but no jobs exist yet", () => {
    const reply = buildJobStatusReply({
      userPrompt: "can you check the job status?",
      sessionId: "demo",
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toBe("I don't see any jobs in this session yet.");
  });

  // Rationale: pending jobs often stall first; ensure we communicate queue wait time as a success-path UX hint.
  test("surfaces queue wait duration when a job is still pending", () => {
    const now = Date.parse("2026-02-16T12:00:00.000Z");
    Date.now = () => now;

    const job: JobApiRow = {
      id: "9abc9abc-0000-4000-8000-111122223333",
      taskId: "task-pending-queue",
      sessionId: "demo",
      status: "pending",
      workerId: null,
      params: "{}",
      error: null,
      enqueuedAt: "2026-02-16T11:58:30.000Z",
      createdAt: "2026-02-16T11:58:00.000Z",
      updatedAt: "2026-02-16T11:59:00.000Z",
    };

    const reply = buildJobStatusReply({
      userPrompt: "status update: how long has the WorkerPal job waited?",
      sessionId: "demo",
      jobs: [job],
      summarizeFailure,
      formatTime: () => "formatted-time",
    });

    expect(reply).toContain("Job 9abc9abc is pending");
    expect(reply).toContain("It is queued and waiting for a WorkerPal.");
    expect(reply).toContain("Queue wait so far: 1m 30s.");
  });

  // Rationale: users escalate failed WorkerPal runs; ensure structured errors surface verbatim for debugging.
  test("surfaces structured failure metadata when the selected job failed", () => {
    const job: JobApiRow = {
      id: "4def4def-2222-4333-8444-abcdefabcdef",
      taskId: "task-failed",
      sessionId: "demo",
      status: "failed",
      workerId: "workerpal-gamma",
      params: "{}",
      error: JSON.stringify({ message: "timed out", detail: "workerpal" }),
      durationMs: 30000,
      createdAt: "2026-02-16T10:00:00.000Z",
      claimedAt: "2026-02-16T10:00:05.000Z",
      startedAt: "2026-02-16T10:00:10.000Z",
      failedAt: "2026-02-16T10:00:40.000Z",
      updatedAt: "2026-02-16T10:00:41.000Z",
    };

    const reply = buildJobStatusReply({
      userPrompt: "status for job 4def4def?",
      sessionId: "demo",
      jobs: [job],
      summarizeFailure,
      formatTime: () => "formatted-time",
    });

    expect(reply).toContain("Job 4def4def is failed");
    expect(reply).toContain("Runtime: 30s.");
    expect(reply).toContain("Failure: timed out | workerpal");
  });

  // Regression guard: when a user references a job ID that doesn't exist we should surface recent IDs.
  test("guides job lookups that reference unknown IDs by listing recent jobs", () => {
    const jobs: JobApiRow[] = [
      {
        id: "12345678-aaaa-4bbb-8ccc-111111111111",
        taskId: "task-one",
        sessionId: "demo",
        status: "pending",
        workerId: null,
        params: "{}",
        error: null,
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:05:00.000Z",
      },
      {
        id: "90abcdef-bbbb-4ccc-8ddd-222222222222",
        taskId: "task-two",
        sessionId: "demo",
        status: "claimed",
        workerId: "workerpal-55",
        params: "{}",
        error: null,
        createdAt: "2026-02-10T00:10:00.000Z",
        claimedAt: "2026-02-10T00:12:00.000Z",
        updatedAt: "2026-02-10T00:15:00.000Z",
      },
    ];

    const reply = buildJobStatusReply({
      userPrompt: "status for job deadbeef",
      sessionId: "demo",
      jobs,
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toBe("I couldn't find job deadbeef. Recent job IDs: 12345678, 90abcdef.");
  });
});

describe("buildRequestStatusReply (apps/localbuddy)", () => {
  // Edge case: ensure we explain when a status lookup happens before any requests exist.
  test("tells the user when no requests exist in the session", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "request status please",
      sessionId: "demo",
      requests: [],
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toBe("I don't see any requests in this session yet.");
  });

  // Success UX: completed RemoteBuddy orchestration without WorkerPal jobs should still reassure the user.
  test("confirms completed requests even when no WorkerPal job has been linked", () => {
    const request: RequestApiRow = {
      id: "eeff0011-2345-4f00-9abc-aa11bb22cc33",
      sessionId: "demo",
      prompt: "status?",
      status: "completed",
      agentId: "remotebuddy-orchestrator",
      priority: "normal",
      error: null,
      createdAt: "2026-02-15T05:00:00.000Z",
      updatedAt: "2026-02-15T05:05:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "how did request eeff0011 finish?",
      sessionId: "demo",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toContain("Request eeff0011 is completed (updated 10:00 PM).");
    expect(reply).toContain("Priority: normal.");
    expect(reply).toContain("RemoteBuddy finished orchestration; no WorkerPal job is linked yet.");
  });

  // Success path: completed request aggregates multiple WorkerPal job outcomes.
  test("summarizes completed requests that have multiple related WorkerPal jobs", () => {
    const request: RequestApiRow = {
      id: "af8fb7eb-cccc-4ddd-8eee-ffffffffffff",
      sessionId: "demo",
      prompt: "help me debug",
      status: "completed",
      agentId: "remotebuddy-orchestrator",
      priority: "interactive",
      error: null,
      createdAt: "2026-02-13T01:00:00.000Z",
      updatedAt: "2026-02-13T01:30:00.000Z",
    };

    const relatedJobs: JobApiRow[] = [
      {
        id: "b2211f02-1111-4111-8111-aaaaaaaaaaaa",
        taskId: "task-1",
        sessionId: "demo",
        status: "pending",
        workerId: null,
        params: JSON.stringify({ requestId: request.id }),
        error: null,
        createdAt: "2026-02-13T01:05:00.000Z",
        updatedAt: "2026-02-13T01:05:30.000Z",
      },
      {
        id: "cdf107be-2222-4222-8222-bbbbbbbbbbbb",
        taskId: "task-2",
        sessionId: "demo",
        status: "completed",
        workerId: "workerpal-alpha",
        params: JSON.stringify({ requestId: request.id }),
        error: null,
        durationMs: 180000,
        createdAt: "2026-02-13T01:15:00.000Z",
        updatedAt: "2026-02-13T01:20:00.000Z",
      },
      {
        id: "e31467ce-3333-4333-8333-cccccccccccc",
        taskId: "task-3",
        sessionId: "demo",
        status: "failed",
        workerId: "workerpal-beta",
        params: JSON.stringify({ requestId: request.id }),
        error: JSON.stringify({ message: "context window exhausted", detail: "workerpal" }),
        createdAt: "2026-02-13T01:22:00.000Z",
        updatedAt: "2026-02-13T01:29:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request af8fb7eb",
      sessionId: "demo",
      requests: [request],
      jobs: relatedJobs,
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain("Request af8fb7eb is completed");
    expect(reply).toContain("Priority: interactive.");
    expect(reply).toContain("Latest WorkerPal job e31467ce is failed");
    expect(reply).toContain("Failure: context window exhausted | workerpal");
    expect(reply).toContain(
      "Jobs: 3 total (1 pending, 0 claimed, 1 completed, 1 failed).",
    );
  });

  // Coverage: ensure claimed requests without WorkerPal jobs explain RemoteBuddy is still planning.
  test("clarifies when a claimed request is still planning and has no WorkerPal jobs", () => {
    const request: RequestApiRow = {
      id: "7faba001-a012-4e45-99b1-123456789abc",
      sessionId: "demo",
      prompt: "status please",
      status: "claimed",
      agentId: "remotebuddy-alpha",
      priority: "interactive",
      error: null,
      createdAt: "2026-02-14T01:00:00.000Z",
      updatedAt: "2026-02-14T01:05:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "can you update me on request 7faba001?",
      sessionId: "demo",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toContain("Request 7faba001 is claimed by remotebuddy-alpha");
    expect(reply).toContain("Priority: interactive.");
    expect(reply).toContain("RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.");
  });

  // Failure regression: failed requests that never launched jobs should surface structured errors for debugging.
  test("surfaces structured failure context even when no WorkerPal job exists", () => {
    const request: RequestApiRow = {
      id: "fedcba09-8765-4321-0fed-cba987654321",
      sessionId: "demo",
      prompt: "diagnostics",
      status: "failed",
      agentId: "remotebuddy-alpha",
      priority: "interactive",
      error: JSON.stringify({ message: "orchestrator timed out", detail: "remote controller" }),
      createdAt: "2026-02-16T06:00:00.000Z",
      updatedAt: "2026-02-16T06:10:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "what happened to request fedcba09?",
      sessionId: "demo",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toContain("Request fedcba09 is failed (updated 10:00 PM).");
    expect(reply).toContain("Priority: interactive.");
    expect(reply).toContain("Failure: orchestrator timed out | remote controller");
  });

  // Edge case: an explicit request ID lookup should gracefully explain when the ID can't be found.
  test("lists recent request IDs when a referenced request token does not exist", () => {
    const requestA: RequestApiRow = {
      id: "1b2c3d4e-aaaa-4111-8111-aaaaaaaaaaaa",
      sessionId: "demo",
      prompt: "first",
      status: "pending",
      agentId: null,
      error: null,
      createdAt: "2026-02-14T02:00:00.000Z",
      updatedAt: "2026-02-14T02:00:01.000Z",
    };
    const requestB: RequestApiRow = {
      id: "5f6a7b8c-bbbb-4222-8222-bbbbbbbbbbbb",
      sessionId: "demo",
      prompt: "second",
      status: "claimed",
      agentId: "remotebuddy-beta",
      error: null,
      createdAt: "2026-02-14T02:05:00.000Z",
      updatedAt: "2026-02-14T02:06:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "status for request deadbeef",
      sessionId: "demo",
      requests: [requestA, requestB],
      jobs: [],
      summarizeFailure,
      formatTime: fixedFormatTime,
    });

    expect(reply).toBe("I couldn't find request deadbeef. Recent request IDs: 1b2c3d4e, 5f6a7b8c.");
  });
});
