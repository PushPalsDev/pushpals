import { describe, expect, it } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "./request_status";

describe("buildJobStatusReply", () => {
  it("returns log context and summarized failure for an explicitly requested job", () => {
    const jobId = "12345678-9abc-def0-1234-56789abcdef0";
    const sessionId = "session-1";
    const jobs: JobApiRow[] = [
      {
        id: jobId,
        taskId: "task-1",
        sessionId,
        kind: "deploy",
        priority: "interactive",
        status: "failed",
        workerId: "worker-a",
        params: "{}",
        error: '{"message":"context blew up"}',
        queueWaitBudgetMs: null,
        executionBudgetMs: null,
        finalizationBudgetMs: null,
        enqueuedAt: "2024-05-01T10:00:00Z",
        durationMs: 55000,
        claimedAt: "2024-05-01T10:01:00Z",
        startedAt: "2024-05-01T10:01:30Z",
        firstLogAt: "2024-05-01T10:02:00Z",
        failedAt: "2024-05-01T10:03:05Z",
        completedAt: null,
        createdAt: "2024-05-01T09:59:00Z",
        updatedAt: "2024-05-01T10:03:05Z",
      },
    ];

    const logs: JobLogApiRow[] = [
      { id: 1, jobId, ts: "2024-05-01T10:02:10Z", message: "Started checkout" },
      {
        id: 2,
        jobId,
        ts: "2024-05-01T10:02:40Z",
        message: "Thinking: analyzing repo structure before patch",
      },
    ];

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `summary:${String(value)}`;

    const reply = buildJobStatusReply({
      userPrompt: "what's the status of job 12345678?",
      sessionId,
      jobs,
      logs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Job 12345678 is failed (updated time(2024-05-01T10:03:05Z)) on worker-a.",
    );
    expect(reply).toContain("Runtime: 55s.");
    expect(reply).toContain("Failure: summary:context blew up");
    expect(reply).toContain("Latest logs:");
    expect(reply).toContain("Started checkout\nThinking: analyzing repo structure before patch");
    expect(reply).toContain("Model hint: Thinking: analyzing repo structure before patch");
  });

  it("explains when a job status query occurs before any jobs exist", () => {
    const sessionId = "session-empty";
    const summarizeFailure = (value: unknown) => `summary:${String(value)}`;

    const reply = buildJobStatusReply({
      userPrompt: "job status please",
      sessionId,
      jobs: [],
      summarizeFailure,
    });

    expect(reply).toBe("I don't see any jobs in this session yet.");
    expect(reply).not.toContain("Recent job IDs");
    expect(reply).not.toContain("Latest logs");
  });

  it("reports elapsed time and timeout budget for a claimed job with an execution budget", () => {
    const sessionId = "session-3";
    const jobId = "ccccdddd-eeee-ffff-0000-111122223333";
    const job: JobApiRow = {
      id: jobId,
      taskId: "task-gamma",
      sessionId,
      kind: "deploy",
      priority: "interactive",
      status: "claimed",
      workerId: "worker-2",
      params: JSON.stringify({ planning: { executionBudgetMs: 600000 } }),
      error: null,
      queueWaitBudgetMs: null,
      executionBudgetMs: null,
      finalizationBudgetMs: null,
      enqueuedAt: "2024-05-03T12:00:00Z",
      durationMs: null,
      claimedAt: "2024-05-03T12:04:00Z",
      startedAt: "2024-05-03T12:05:00Z",
      firstLogAt: null,
      failedAt: null,
      completedAt: null,
      createdAt: "2024-05-03T11:59:00Z",
      updatedAt: "2024-05-03T12:07:00Z",
    };

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `oops:${String(value)}`;

    const now = Date.parse("2024-05-03T12:10:00Z");
    const originalNow = Date.now;
    Date.now = () => now;
    const reply = buildJobStatusReply({
      userPrompt: `status of job ${jobId}`,
      sessionId,
      jobs: [job],
      summarizeFailure,
      formatTime,
    });
    Date.now = originalNow;

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Job ccccdddd is claimed (updated time(2024-05-03T12:07:00Z)) on worker-2. It is currently in progress.",
    );
    expect(reply).toContain("Elapsed: 5m 0s.");
    expect(reply).toContain("Timeout target: time(2024-05-03T12:15:00.000Z).");
    expect(reply).not.toContain("Queue wait so far");
  });

  it("surfaces queue wait time for a pending job when no id is specified", () => {
    const sessionId = "session-pending";
    const job: JobApiRow = {
      id: "dddd1111-2222-3333-4444-555566667777",
      taskId: "task-wait",
      sessionId,
      kind: "deploy",
      priority: "interactive",
      status: "pending",
      workerId: null,
      params: "{}",
      error: null,
      queueWaitBudgetMs: null,
      executionBudgetMs: null,
      finalizationBudgetMs: null,
      enqueuedAt: "2024-05-07T15:00:00Z",
      durationMs: null,
      claimedAt: null,
      startedAt: null,
      firstLogAt: null,
      failedAt: null,
      completedAt: null,
      createdAt: "2024-05-07T14:59:00Z",
      updatedAt: "2024-05-07T15:01:00Z",
    };

    const summarizeFailure = (value: unknown) => `sum:${String(value)}`;
    const formatTime = (iso: string) => `time(${iso})`;

    const originalNow = Date.now;
    Date.now = () => Date.parse("2024-05-07T15:05:30Z");
    const reply = buildJobStatusReply({
      userPrompt: "can you check the workerpal job status?",
      sessionId,
      jobs: [job],
      summarizeFailure,
      formatTime,
    });
    Date.now = originalNow;

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Job dddd1111 is pending (updated time(2024-05-07T15:01:00Z)). It is queued and waiting for a WorkerPal.",
    );
    expect(reply).toContain("Queue wait so far: 5m 30s.");
    expect(reply).not.toContain("Elapsed:");
    expect(reply).not.toContain("Runtime:");
  });

  it("lists recent job ids when a referenced token does not match any jobs", () => {
    const sessionId = "session-4";
    const jobs: JobApiRow[] = [
      {
        id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
        taskId: "task-1",
        sessionId,
        kind: "deploy",
        priority: "interactive",
        status: "pending",
        workerId: null,
        params: "{}",
        error: null,
        queueWaitBudgetMs: null,
        executionBudgetMs: null,
        finalizationBudgetMs: null,
        enqueuedAt: "2024-05-05T10:00:00Z",
        durationMs: null,
        claimedAt: null,
        startedAt: null,
        firstLogAt: null,
        failedAt: null,
        completedAt: null,
        createdAt: "2024-05-05T09:59:00Z",
        updatedAt: "2024-05-05T10:02:00Z",
      },
      {
        id: "bbbbcccc-dddd-eeee-ffff-000011112222",
        taskId: "task-2",
        sessionId,
        kind: "deploy",
        priority: "interactive",
        status: "claimed",
        workerId: "worker-3",
        params: "{}",
        error: null,
        queueWaitBudgetMs: null,
        executionBudgetMs: null,
        finalizationBudgetMs: null,
        enqueuedAt: "2024-05-05T10:05:00Z",
        durationMs: null,
        claimedAt: "2024-05-05T10:06:00Z",
        startedAt: "2024-05-05T10:06:30Z",
        firstLogAt: null,
        failedAt: null,
        completedAt: null,
        createdAt: "2024-05-05T10:04:00Z",
        updatedAt: "2024-05-05T10:07:00Z",
      },
      {
        id: "ccccdddd-eeee-ffff-0000-111122223333",
        taskId: "task-3",
        sessionId,
        kind: "deploy",
        priority: "interactive",
        status: "completed",
        workerId: "worker-4",
        params: "{}",
        error: null,
        queueWaitBudgetMs: null,
        executionBudgetMs: null,
        finalizationBudgetMs: null,
        enqueuedAt: "2024-05-05T09:45:00Z",
        durationMs: 120000,
        claimedAt: "2024-05-05T09:46:00Z",
        startedAt: "2024-05-05T09:46:30Z",
        firstLogAt: "2024-05-05T09:46:40Z",
        failedAt: null,
        completedAt: "2024-05-05T09:48:30Z",
        createdAt: "2024-05-05T09:44:00Z",
        updatedAt: "2024-05-05T09:48:30Z",
      },
    ];

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `summary:${String(value)}`;

    const reply = buildJobStatusReply({
      userPrompt: "status of job deadbeef",
      sessionId,
      jobs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "I couldn't find job deadbeef. Recent job IDs: aaaabbbb, bbbbcccc, ccccdddd.",
    );
    expect(reply).not.toContain("Latest logs:");
  });
});

describe("buildRequestStatusReply", () => {
  it("summarizes the owning RemoteBuddy request and related WorkerPal jobs", () => {
    const sessionId = "session-2";
    const requestId = "9999aaaa-bbbb-cccc-dddd-eeeeffff0000";
    const requests: RequestApiRow[] = [
      {
        id: requestId,
        sessionId,
        prompt: "Check deployment",
        priority: "interactive",
        queueWaitBudgetMs: null,
        status: "claimed",
        agentId: "RemoteBuddy",
        error: null,
        enqueuedAt: "2024-05-02T11:00:00Z",
        claimedAt: "2024-05-02T11:00:10Z",
        completedAt: null,
        failedAt: null,
        durationMs: null,
        createdAt: "2024-05-02T10:59:00Z",
        updatedAt: "2024-05-02T11:05:00Z",
      },
    ];

    const jobA: JobApiRow = {
      id: "aaaa1111-bbbb-2222-cccc-3333dddd4444",
      taskId: "task-alpha",
      sessionId,
      kind: "deploy",
      priority: "interactive",
      status: "failed",
      workerId: "worker-9",
      params: JSON.stringify({ requestId }),
      error: '{"detail":"timeout"}',
      queueWaitBudgetMs: null,
      executionBudgetMs: null,
      finalizationBudgetMs: null,
      enqueuedAt: "2024-05-02T11:01:00Z",
      durationMs: 120000,
      claimedAt: "2024-05-02T11:01:05Z",
      startedAt: "2024-05-02T11:01:06Z",
      firstLogAt: "2024-05-02T11:01:50Z",
      failedAt: "2024-05-02T11:03:05Z",
      completedAt: null,
      createdAt: "2024-05-02T11:00:30Z",
      updatedAt: "2024-05-02T11:06:05Z",
    };

    const jobB: JobApiRow = {
      id: "bbbb2222-cccc-3333-dddd-4444eeee5555",
      taskId: "task-beta",
      sessionId,
      kind: "deploy",
      priority: "interactive",
      status: "pending",
      workerId: null,
      params: JSON.stringify({ requestId }),
      error: null,
      queueWaitBudgetMs: null,
      executionBudgetMs: null,
      finalizationBudgetMs: null,
      enqueuedAt: "2024-05-02T11:04:00Z",
      durationMs: null,
      claimedAt: null,
      startedAt: null,
      firstLogAt: null,
      failedAt: null,
      completedAt: null,
      createdAt: "2024-05-02T11:02:30Z",
      updatedAt: "2024-05-02T11:02:00Z",
    };

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `oops:${String(value)}`;

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 9999aaaa",
      sessionId,
      requests,
      jobs: [jobA, jobB],
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Request 9999aaaa is claimed by RemoteBuddy (updated time(2024-05-02T11:05:00Z)). Priority: interactive.",
    );
    expect(reply).toContain(
      "Latest WorkerPal job aaaa1111 is failed (updated time(2024-05-02T11:06:05Z)) on worker-9. Failure: oops:timeout",
    );
    expect(reply).toContain("Jobs: 2 total (1 pending, 0 claimed, 0 completed, 1 failed).");
  });

  it("explains when a pending request has not yet launched any WorkerPal jobs", () => {
    const sessionId = "session-9";
    const requestId = "1111aaaa-bbbb-cccc-dddd-eeeeffff1111";
    const requests: RequestApiRow[] = [
      {
        id: requestId,
        sessionId,
        prompt: "Investigate flaky integration test",
        priority: "normal",
        queueWaitBudgetMs: null,
        status: "pending",
        agentId: null,
        error: null,
        enqueuedAt: "2024-05-04T08:00:00Z",
        claimedAt: null,
        completedAt: null,
        failedAt: null,
        durationMs: null,
        createdAt: "2024-05-04T07:59:00Z",
        updatedAt: "2024-05-04T08:05:00Z",
      },
    ];

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `oops:${String(value)}`;

    const reply = buildRequestStatusReply({
      userPrompt: "status update for request 1111aaaa",
      sessionId,
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Request 1111aaaa is pending (updated time(2024-05-04T08:05:00Z)). Priority: normal.",
    );
    expect(reply).toContain("It is waiting for RemoteBuddy to claim it.");
    expect(reply).not.toContain("Latest WorkerPal job");
    expect(reply).not.toContain("RemoteBuddy is still planning");
  });

  it("lists recent request ids when a referenced token does not match", () => {
    const sessionId = "session-11";
    const requests: RequestApiRow[] = [
      {
        id: "aaaa1111-bbbb-cccc-dddd-eeeeffff1111",
        sessionId,
        prompt: "Deploy staging",
        priority: "interactive",
        queueWaitBudgetMs: null,
        status: "completed",
        agentId: "RemoteBuddy",
        error: null,
        enqueuedAt: "2024-05-06T10:00:00Z",
        claimedAt: "2024-05-06T10:00:10Z",
        completedAt: "2024-05-06T10:05:00Z",
        failedAt: null,
        durationMs: 300000,
        createdAt: "2024-05-06T09:59:00Z",
        updatedAt: "2024-05-06T10:05:00Z",
      },
      {
        id: "bbbb2222-cccc-dddd-eeee-ffff11112222",
        sessionId,
        prompt: "Verify migrations",
        priority: "normal",
        queueWaitBudgetMs: null,
        status: "pending",
        agentId: null,
        error: null,
        enqueuedAt: "2024-05-06T11:00:00Z",
        claimedAt: null,
        completedAt: null,
        failedAt: null,
        durationMs: null,
        createdAt: "2024-05-06T10:59:00Z",
        updatedAt: "2024-05-06T11:01:00Z",
      },
      {
        id: "cccc3333-dddd-eeee-ffff-000011112222",
        sessionId,
        prompt: "Scale production",
        priority: "background",
        queueWaitBudgetMs: null,
        status: "failed",
        agentId: "RemoteBuddy",
        error: "{\"message\":\"quota exceeded\"}",
        enqueuedAt: "2024-05-06T12:00:00Z",
        claimedAt: "2024-05-06T12:00:30Z",
        completedAt: null,
        failedAt: "2024-05-06T12:10:00Z",
        durationMs: 600000,
        createdAt: "2024-05-06T11:59:00Z",
        updatedAt: "2024-05-06T12:10:00Z",
      },
    ];

    const summarizeFailure = (value: unknown) => `fail:${String(value)}`;

    const reply = buildRequestStatusReply({
      userPrompt: "status for request deadbeef",
      sessionId,
      requests,
      jobs: [],
      summarizeFailure,
    });

    expect(reply).toBe(
      "I couldn't find request deadbeef. Recent request IDs: aaaa1111, bbbb2222, cccc3333.",
    );
    expect(reply).not.toContain("WorkerPal job");
    expect(reply).not.toContain("Failure:");
  });

  it("summarizes request failure details when no WorkerPal jobs exist", () => {
    const sessionId = "session-12";
    const requestId = "4444aaaa-bbbb-cccc-dddd-eeeeffff4444";
    const requests: RequestApiRow[] = [
      {
        id: requestId,
        sessionId,
        prompt: "Scale production",
        priority: "interactive",
        queueWaitBudgetMs: null,
        status: "failed",
        agentId: "RemoteBuddy",
        error: '{"message":"quota exceeded","detail":"concurrency limit"}',
        enqueuedAt: "2024-05-07T09:00:00Z",
        claimedAt: "2024-05-07T09:00:30Z",
        completedAt: null,
        failedAt: "2024-05-07T09:05:00Z",
        durationMs: 300000,
        createdAt: "2024-05-07T08:59:00Z",
        updatedAt: "2024-05-07T09:05:00Z",
      },
    ];

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `fail:${String(value)}`;

    const reply = buildRequestStatusReply({
      userPrompt: "what happened to my request 4444aaaa?",
      sessionId,
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Request 4444aaaa is failed (updated time(2024-05-07T09:05:00Z)). Priority: interactive.",
    );
    expect(reply).toContain("Failure: fail:quota exceeded | concurrency limit");
    expect(reply).not.toContain("RemoteBuddy is still planning");
    expect(reply).not.toContain("WorkerPal job");
  });

  it("clarifies when a claimed request is still planning without WorkerPal jobs", () => {
    const sessionId = "session-10";
    const requestId = "2222aaaa-bbbb-cccc-dddd-eeeeffff2222";
    const requests: RequestApiRow[] = [
      {
        id: requestId,
        sessionId,
        prompt: "Deploy staging",
        priority: "interactive",
        queueWaitBudgetMs: null,
        status: "claimed",
        agentId: "RemoteBuddy",
        error: null,
        enqueuedAt: "2024-05-05T12:00:00Z",
        claimedAt: "2024-05-05T12:00:30Z",
        completedAt: null,
        failedAt: null,
        durationMs: null,
        createdAt: "2024-05-05T11:59:00Z",
        updatedAt: "2024-05-05T12:05:00Z",
      },
    ];

    const formatTime = (iso: string) => `time(${iso})`;
    const summarizeFailure = (value: unknown) => `oops:${String(value)}`;

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 2222aaaa",
      sessionId,
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Request 2222aaaa is claimed by RemoteBuddy (updated time(2024-05-05T12:05:00Z)). Priority: interactive.",
    );
    expect(reply).toContain("RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.");
    expect(reply).not.toContain("Latest WorkerPal job");
  });
});
