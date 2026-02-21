import { describe, expect, test } from "bun:test";
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

const fixedTime = () => "10:00 PM";

const baseJob = (overrides: Partial<JobApiRow>): JobApiRow => ({
  id: "00000000-0000-4000-8000-000000000000",
  taskId: "task-1",
  sessionId: "dev",
  status: "pending",
  workerId: null,
  params: "{}",
  error: null,
  createdAt: "2026-02-13T00:00:00.000Z",
  updatedAt: "2026-02-13T00:00:00.000Z",
  ...overrides,
});

const baseRequest = (overrides: Partial<RequestApiRow>): RequestApiRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "dev",
  prompt: "diagnose queue lag",
  status: "pending",
  agentId: null,
  error: null,
  createdAt: "2026-02-13T01:00:00.000Z",
  updatedAt: "2026-02-13T01:00:00.000Z",
  ...overrides,
});

describe("LocalBuddy request status behaviors", () => {
  test("buildJobStatusReply ignores jobs outside the active session", () => {
    const jobFromOtherSession = baseJob({
      id: "a4c2f397-3333-4333-8333-333333333333",
      sessionId: "prod",
      status: "claimed",
      workerId: "workerpal-53d9b7fd",
      updatedAt: "2026-02-13T02:10:00.000Z",
    });

    const reply = buildJobStatusReply({
      userPrompt: "status for job a4c2f397",
      sessionId: "dev",
      jobs: [jobFromOtherSession],
      logs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toBe("I don't see any jobs in this session yet.");
  });

  test("buildRequestStatusReply summarizes multi-job history with counts", () => {
    const request = baseRequest({
      id: "cd2711b6-8888-4888-8888-888888888888",
      status: "claimed",
      agentId: "remotebuddy-orchestrator",
      priority: "interactive",
      updatedAt: "2026-02-13T03:00:00.000Z",
    });

    const jobs: JobApiRow[] = [
      baseJob({
        id: "90123456-0000-4000-8000-000000000000",
        status: "pending",
        params: JSON.stringify({ requestId: request.id }),
        updatedAt: "2026-02-13T03:05:00.000Z",
      }),
      baseJob({
        id: "9f4c5130-0000-4000-8000-000000000001",
        status: "claimed",
        workerId: "workerpal-1111",
        params: JSON.stringify({ requestId: request.id }),
        updatedAt: "2026-02-13T03:06:00.000Z",
      }),
      baseJob({
        id: "8d811082-0000-4000-8000-000000000002",
        status: "completed",
        workerId: "workerpal-2222",
        params: JSON.stringify({ requestId: request.id }),
        updatedAt: "2026-02-13T03:07:00.000Z",
      }),
      baseJob({
        id: "7b91773f-0000-4000-8000-000000000003",
        status: "failed",
        workerId: "workerpal-3333",
        params: JSON.stringify({ requestId: request.id }),
        error: JSON.stringify({ message: "Worker timed out", detail: "task.execute" }),
        updatedAt: "2026-02-13T03:08:00.000Z",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request cd2711b6",
      sessionId: "dev",
      requests: [request],
      jobs,
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toContain("Request cd2711b6 is claimed by remotebuddy-orchestrator");
    expect(reply).toContain("Priority: interactive.");
    expect(reply).toContain("Latest WorkerPal job 7b91773f is failed");
    expect(reply).toContain("Failure: Worker timed out | task.execute");
    expect(reply).toContain("Jobs: 4 total (1 pending, 1 claimed, 1 completed, 1 failed).");
  });

  test("buildJobStatusReply surfaces structured failure details with job logs", () => {
    const failedJob = baseJob({
      id: "abcdef12-aaaa-4bbb-8ccc-ddddeeeeffff",
      status: "failed",
      workerId: "workerpal-9898",
      durationMs: 4200,
      updatedAt: "2026-02-13T04:00:00.000Z",
      error: JSON.stringify({ message: "Tool call failed", detail: "safety.check" }),
    });

    const logs: JobLogApiRow[] = [
      {
        id: 1,
        jobId: failedJob.id,
        ts: "2026-02-13T04:05:00.000Z",
        message: "Starting action sequence",
      },
      {
        id: 2,
        jobId: failedJob.id,
        ts: "2026-02-13T04:06:00.000Z",
        message: "Thinking: try fallback plan",
      },
    ];

    const reply = buildJobStatusReply({
      userPrompt: "status for job abcdef12",
      sessionId: "dev",
      jobs: [failedJob],
      logs,
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toContain("Job abcdef12 is failed (updated 10:00 PM) on workerpal-9898.");
    expect(reply).toContain("Runtime: 4s.");
    expect(reply).toContain("Failure: Tool call failed | safety.check");
    expect(reply).toContain(
      "Latest logs:\n```\nStarting action sequence\nThinking: try fallback plan\n```",
    );
    expect(reply).toContain("Model hint: Thinking: try fallback plan");
  });

  test("buildJobStatusReply reports elapsed time and timeout target for claimed jobs", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-02-13T04:01:30.000Z");

    try {
      const claimedJob = baseJob({
        id: "ce03d8a5-1234-4e56-8f78-90ab12cd34ef",
        status: "claimed",
        workerId: "workerpal-4242",
        startedAt: "2026-02-13T04:00:00.000Z",
        updatedAt: "2026-02-13T04:01:00.000Z",
        params: JSON.stringify({
          planning: { executionBudgetMs: 300000 },
        }),
      });

      const reply = buildJobStatusReply({
        userPrompt: "status for job ce03d8a5",
        sessionId: "dev",
        jobs: [claimedJob],
        logs: [],
        summarizeFailure,
        formatTime: fixedTime,
      });

      expect(reply).toContain("It is currently in progress.");
      expect(reply).toContain("Elapsed: 1m 30s.");
      expect(reply).toContain("Timeout target: 10:00 PM.");
    } finally {
      Date.now = originalNow;
    }
  });

  test("buildJobStatusReply explains queued jobs and reports queue wait when no token is provided", () => {
    const originalNow = Date.now;
    Date.now = () => Date.parse("2026-02-13T06:00:30.000Z");

    try {
      const queuedJob = baseJob({
        id: "55c5dcb6-eeee-4fff-8aaa-123456789abc",
        status: "pending",
        enqueuedAt: "2026-02-13T06:00:00.000Z",
        updatedAt: "2026-02-13T06:00:00.000Z",
      });

      const reply = buildJobStatusReply({
        userPrompt: "can you give me a workerpal job status update?",
        sessionId: "dev",
        jobs: [queuedJob],
        logs: [],
        summarizeFailure,
        formatTime: fixedTime,
      });

      expect(reply).toContain("Job 55c5dcb6 is pending (updated 10:00 PM).");
      expect(reply).toContain("It is queued and waiting for a WorkerPal.");
      expect(reply).toContain("Queue wait so far: 30s.");
    } finally {
      Date.now = originalNow;
    }
  });

  test("buildRequestStatusReply explains claimed request without WorkerPal job", () => {
    const request = baseRequest({
      id: "22223333-4444-4444-8444-555566667777",
      status: "claimed",
      agentId: "remotebuddy-alpha",
      priority: "interactive",
      updatedAt: "2026-02-13T05:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "what's the status of my request?",
      sessionId: "dev",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toContain(
      "Request 22223333 is claimed by remotebuddy-alpha (updated 10:00 PM). Priority: interactive.",
    );
    expect(reply).toContain(
      "RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
  });

  test("buildJobStatusReply lists recent job IDs when requested token is missing", () => {
    const jobs: JobApiRow[] = [
      baseJob({
        id: "12345678-0000-4000-8000-aaaaaaaaaaaa",
        status: "completed",
        updatedAt: "2026-02-13T06:00:00.000Z",
      }),
      baseJob({
        id: "23456789-0000-4000-8000-bbbbbbbbbbbb",
        status: "failed",
        updatedAt: "2026-02-13T06:05:00.000Z",
      }),
      baseJob({
        id: "3456789a-0000-4000-8000-cccccccccccc",
        status: "pending",
        updatedAt: "2026-02-13T06:10:00.000Z",
      }),
    ];

    const reply = buildJobStatusReply({
      userPrompt: "status for job DEADBEEF",
      sessionId: "dev",
      jobs,
      logs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toBe(
      "I couldn't find job deadbeef. Recent job IDs: 12345678, 23456789, 3456789a.",
    );
  });

  test("buildRequestStatusReply resolves short request tokens for pending requests", () => {
    const otherRequest = baseRequest({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: "pending",
      priority: "background",
      updatedAt: "2026-02-13T07:00:00.000Z",
    });

    const pendingRequest = baseRequest({
      id: "33333333-4444-4555-8666-777788889999",
      status: "pending",
      priority: "normal",
      updatedAt: "2026-02-13T07:05:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "can you check req id 33333333?",
      sessionId: "dev",
      requests: [otherRequest, pendingRequest],
      jobs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toBe(
      "Request 33333333 is pending (updated 10:00 PM). Priority: normal. It is waiting for RemoteBuddy to claim it.",
    );
  });

  test("buildRequestStatusReply reports failure summaries when no jobs are linked", () => {
    const failedRequest = baseRequest({
      id: "44445555-6666-4777-8888-9999aaaabbbb",
      status: "failed",
      priority: "interactive",
      error: JSON.stringify({ message: "Planner crashed", detail: "Out of tokens" }),
      updatedAt: "2026-02-13T08:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "what's the status of my request?",
      sessionId: "dev",
      requests: [failedRequest],
      jobs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toContain("Request 44445555 is failed (updated 10:00 PM). Priority: interactive.");
    expect(reply).toContain("Failure: Planner crashed | Out of tokens");
  });

  test("buildRequestStatusReply explains completed request without a WorkerPal job", () => {
    const completedRequest = baseRequest({
      id: "eeeeffff-aaaa-4bbb-8ccc-ddddeeeeffff",
      status: "completed",
      priority: "normal",
      updatedAt: "2026-02-13T09:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "can you give me a request status update?",
      sessionId: "dev",
      requests: [completedRequest],
      jobs: [],
      summarizeFailure,
      formatTime: fixedTime,
    });

    expect(reply).toBe(
      "Request eeeeffff is completed (updated 10:00 PM). Priority: normal. RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
  });
});
