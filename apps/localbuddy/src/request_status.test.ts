import { describe, expect, test } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "./request_status";

const summarizeFailure = (value: unknown) => String(value ?? "");
const stableFormatTime = (iso: string) => iso;

function makeJob(overrides: Partial<JobApiRow>): JobApiRow {
  const baseIso = "2025-02-01T00:00:00.000Z";
  return {
    id: "00000000-0000-0000-0000-000000000000",
    taskId: "task-default",
    sessionId: "session-default",
    status: "pending",
    workerId: null,
    params: "{}",
    error: null,
    enqueuedAt: baseIso,
    createdAt: baseIso,
    updatedAt: baseIso,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RequestApiRow>): RequestApiRow {
  const baseIso = "2025-02-01T00:00:00.000Z";
  return {
    id: "11111111-1111-1111-1111-111111111111",
    sessionId: "session-default",
    prompt: "default",
    priority: undefined,
    queueWaitBudgetMs: null,
    status: "pending",
    agentId: null,
    error: null,
    createdAt: baseIso,
    updatedAt: baseIso,
    ...overrides,
  };
}

describe("buildJobStatusReply", () => {
  test("surface failure details, log tail, and thinking hints when a job id is referenced", () => {
    const sessionId = "session-a";
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    const failedJob = makeJob({
      id: "abcd1234-8888-4444-9999-abcdefabcdef",
      taskId: "task-fail",
      sessionId,
      status: "failed",
      workerId: "worker-7",
      params: JSON.stringify({ requestId }),
      error: JSON.stringify({ message: "context limit hit", detail: "trace" }),
      updatedAt: "2025-02-01T12:00:00.000Z",
    });
    const completedJob = makeJob({
      id: "ffff1111-2222-3333-4444-feedfeedfeed",
      taskId: "task-other",
      sessionId,
      status: "completed",
      workerId: "worker-3",
      updatedAt: "2025-02-01T10:00:00.000Z",
    });
    const logs: JobLogApiRow[] = [
      { id: 1, jobId: failedJob.id, ts: failedJob.updatedAt, message: "Processed chunk" },
      {
        id: 2,
        jobId: failedJob.id,
        ts: failedJob.updatedAt,
        message: "Thinking: re-evaluating fix",
      },
      { id: 3, jobId: completedJob.id, ts: completedJob.updatedAt, message: "Completed work" },
    ];

    const reply = buildJobStatusReply({
      userPrompt: `status job ${failedJob.id.slice(0, 8)}`,
      sessionId,
      jobs: [failedJob, completedJob],
      logs,
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain(
      `Job ${failedJob.id.slice(0, 8)} is failed (updated ${failedJob.updatedAt}) on ${failedJob.workerId}.`,
    );
    expect(message).toContain("Failure: context limit hit | trace");
    expect(message).toContain("Latest logs:");
    expect(message).toContain("Thinking: re-evaluating fix");
    expect(message).toContain("Model hint: Thinking: re-evaluating fix");
    expect(message).not.toContain("Completed work");
  });

  test("lists recent job ids when the referenced token is missing", () => {
    const sessionId = "session-c";
    const jobs = [
      makeJob({
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        sessionId,
        updatedAt: "2025-02-02T08:00:00.000Z",
      }),
      makeJob({
        id: "bbbbbbbb-1111-2222-3333-555555555555",
        sessionId,
        updatedAt: "2025-02-02T09:00:00.000Z",
      }),
      makeJob({
        id: "cccccccc-1111-2222-3333-666666666666",
        sessionId,
        updatedAt: "2025-02-02T10:00:00.000Z",
      }),
    ];

    const reply = buildJobStatusReply({
      userPrompt: "status job deadbeef",
      sessionId,
      jobs,
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain("I couldn't find job deadbeef.");
    expect(message).toContain("Recent job IDs: aaaaaaaa, bbbbbbbb, cccccccc.");
  });

  test("claimed job response includes elapsed time and timeout target", () => {
    const sessionId = "session-e";
    const claimedJob = makeJob({
      id: "eeeeeeee-1111-2222-3333-777777777777",
      sessionId,
      status: "claimed",
      workerId: "worker-55",
      startedAt: "2025-02-02T10:00:00.000Z",
      updatedAt: "2025-02-02T10:02:00.000Z",
      executionBudgetMs: 5 * 60 * 1000,
    });
    const pendingJob = makeJob({
      id: "ffffffff-1111-2222-3333-777777777777",
      sessionId,
      status: "pending",
      updatedAt: "2025-02-02T09:59:00.000Z",
    });

    const originalNow = Date.now;
    Date.now = () => Date.parse("2025-02-02T10:01:30.000Z");
    try {
      const reply = buildJobStatusReply({
        userPrompt: "status job",
        sessionId,
        jobs: [pendingJob, claimedJob],
        summarizeFailure,
        formatTime: stableFormatTime,
      });

      expect(reply).toBeTruthy();
      const message = reply ?? "";
      expect(message).toContain(
        `Job ${claimedJob.id.slice(0, 8)} is claimed (updated ${claimedJob.updatedAt}) on ${claimedJob.workerId}.`,
      );
      expect(message).toContain("It is currently in progress.");
      expect(message).toContain("Elapsed: 1m 30s.");
      expect(message).toContain("Timeout target: 2025-02-02T10:05:00.000Z.");
    } finally {
      Date.now = originalNow;
    }
  });

  test("pending job response reports queue wait time", () => {
    const sessionId = "session-g";
    const pendingJob = makeJob({
      id: "99999999-1111-2222-3333-aaaaaaaaaaaa",
      sessionId,
      status: "pending",
      enqueuedAt: "2025-02-02T10:00:00.000Z",
      updatedAt: "2025-02-02T10:05:00.000Z",
    });

    const originalNow = Date.now;
    Date.now = () => Date.parse("2025-02-02T10:07:30.000Z");
    try {
      const reply = buildJobStatusReply({
        userPrompt: "status job queue",
        sessionId,
        jobs: [pendingJob],
        summarizeFailure,
        formatTime: stableFormatTime,
      });

      expect(reply).toBeTruthy();
      const message = reply ?? "";
      expect(message).toContain(
        `Job ${pendingJob.id.slice(0, 8)} is pending (updated ${pendingJob.updatedAt}).`,
      );
      expect(message).toContain("It is queued and waiting for a WorkerPal.");
      expect(message).toContain("Queue wait so far: 7m 30s.");
    } finally {
      Date.now = originalNow;
    }
  });

  test("claimed job pulls execution budget from planning params when missing direct field", () => {
    const sessionId = "session-h";
    const claimedJob = makeJob({
      id: "12341234-5678-9abc-def0-123456789abc",
      sessionId,
      status: "claimed",
      workerId: "worker-88",
      startedAt: "2025-02-03T10:00:00.000Z",
      updatedAt: "2025-02-03T10:00:30.000Z",
      params: JSON.stringify({
        requestId: "req-1",
        planning: { executionBudgetMs: 2 * 60 * 1000 },
      }),
    });

    const originalNow = Date.now;
    Date.now = () => Date.parse("2025-02-03T10:00:45.000Z");
    try {
      const reply = buildJobStatusReply({
        userPrompt: "status job 12341234",
        sessionId,
        jobs: [claimedJob],
        summarizeFailure,
        formatTime: stableFormatTime,
      });

      expect(reply).toBeTruthy();
      const message = reply ?? "";
      expect(message).toContain("Elapsed: 45s.");
      expect(message).toContain("Timeout target: 2025-02-03T10:02:00.000Z.");
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("buildRequestStatusReply", () => {
  test("summarizes failed request plus related job counts", () => {
    const sessionId = "session-b";
    const requestId = "999e4567-e89b-12d3-a456-426655440000";
    const request = makeRequest({
      id: requestId,
      sessionId,
      status: "failed",
      priority: "background",
      agentId: "remote-buddy",
      error: JSON.stringify({ message: "planner crashed", detail: "timeout" }),
      updatedAt: "2025-02-02T14:30:00.000Z",
    });

    const relatedJobs: JobApiRow[] = [
      makeJob({
        id: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
        sessionId,
        status: "pending",
        params: JSON.stringify({ requestId }),
        updatedAt: "2025-02-02T12:00:00.000Z",
      }),
      makeJob({
        id: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
        sessionId,
        status: "completed",
        workerId: "worker-1",
        params: JSON.stringify({ requestId }),
        updatedAt: "2025-02-02T13:30:00.000Z",
      }),
      makeJob({
        id: "aaaaaaaa-bbbb-cccc-dddd-000000000003",
        sessionId,
        status: "failed",
        workerId: "worker-2",
        params: JSON.stringify({ requestId }),
        error: JSON.stringify({ message: "timeout" }),
        updatedAt: "2025-02-02T14:29:00.000Z",
      }),
    ];

    const otherJob = makeJob({
      id: "bbbbbbbb-cccc-dddd-eeee-111111111111",
      sessionId,
      status: "completed",
      params: JSON.stringify({ requestId: "other" }),
      updatedAt: "2025-02-02T15:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: `what's the status of request ${requestId.slice(0, 8)}?`,
      sessionId,
      requests: [request],
      jobs: [...relatedJobs, otherJob],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain(
      `Request ${request.id.slice(0, 8)} is failed (updated ${request.updatedAt}). Priority: background.`,
    );
    expect(message).toContain("Failure: planner crashed | timeout");
    expect(message).toContain(
      `Latest WorkerPal job ${relatedJobs[2].id.slice(0, 8)} is failed (updated ${relatedJobs[2].updatedAt}) on ${relatedJobs[2].workerId}.`,
    );
    expect(message).toContain("Failure: timeout");
    expect(message).toContain("Jobs: 3 total (1 pending, 0 claimed, 1 completed, 1 failed).");
  });

  test("pending request without related jobs reports waiting message", () => {
    const sessionId = "session-d";
    const request = makeRequest({
      id: "dddddddd-eeee-ffff-0000-111111111111",
      sessionId,
      status: "pending",
      updatedAt: "2025-02-03T09:45:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "check status of my request",
      sessionId,
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain(
      `Request ${request.id.slice(0, 8)} is pending (updated ${request.updatedAt}).`,
    );
    expect(message).toContain("It is waiting for RemoteBuddy to claim it.");
  });

  test("claimed request without WorkerPal jobs explains planning state", () => {
    const sessionId = "session-f";
    const request = makeRequest({
      id: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
      sessionId,
      status: "claimed",
      agentId: "remote-buddy",
      priority: "interactive",
      updatedAt: "2025-02-04T12:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status on my request",
      sessionId,
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain(
      `Request ${request.id.slice(0, 8)} is claimed by ${request.agentId} (updated ${request.updatedAt}). Priority: ${request.priority}.`,
    );
    expect(message).toContain(
      "RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
  });

  test("lists recent request ids when the referenced token is missing", () => {
    const sessionId = "session-h";
    const requests = [
      makeRequest({
        id: "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
        sessionId,
        updatedAt: "2025-02-05T09:00:00.000Z",
      }),
      makeRequest({
        id: "bbbb2222-cccc-dddd-eeee-ffffffffffff",
        sessionId,
        updatedAt: "2025-02-05T10:00:00.000Z",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status request deadbeef",
      sessionId,
      requests,
      jobs: [],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain("I couldn't find request deadbeef.");
    expect(message).toContain("Recent request IDs: aaaa1111, bbbb2222.");
  });

  test("completed request with no WorkerPal jobs explains orchestration completion", () => {
    const sessionId = "session-i";
    const request = makeRequest({
      id: "cccc3333-dddd-eeee-ffff-000000000000",
      sessionId,
      status: "completed",
      updatedAt: "2025-02-06T11:15:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status request please",
      sessionId,
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toBeTruthy();
    const message = reply ?? "";
    expect(message).toContain(
      `Request ${request.id.slice(0, 8)} is completed (updated ${request.updatedAt}).`,
    );
    expect(message).toContain(
      "RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
  });

  test("reports a planner-completed worker handoff as delegated until its job terminates", () => {
    const sessionId = "session-delegated";
    const requestId = "dddd4444-eeee-ffff-aaaa-111111111111";
    const jobId = "eeee5555-ffff-aaaa-bbbb-222222222222";
    const request = makeRequest({
      id: requestId,
      sessionId,
      status: "completed",
      workerRequired: 1,
      handoffJobId: jobId,
      outcomeStatus: "delegated",
      updatedAt: "2025-02-07T10:00:00.000Z",
    });
    const job = makeJob({
      id: jobId,
      sessionId,
      status: "claimed",
      workerId: "worker-delegated",
      params: JSON.stringify({ requestId }),
      updatedAt: "2025-02-07T10:02:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: `status request ${requestId.slice(0, 8)}`,
      sessionId,
      requests: [request],
      jobs: [job],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toContain(`Request ${requestId.slice(0, 8)} is delegated`);
    expect(reply).not.toContain(`Request ${requestId.slice(0, 8)} is completed`);
    expect(reply).toContain(`WorkerPal job ${jobId.slice(0, 8)} is claimed`);
  });

  test("reports the linked worker failure as the request outcome", () => {
    const sessionId = "session-delegated-failure";
    const requestId = "ffff6666-aaaa-bbbb-cccc-333333333333";
    const jobId = "aaaa7777-bbbb-cccc-dddd-444444444444";
    const request = makeRequest({
      id: requestId,
      sessionId,
      status: "completed",
      workerRequired: 1,
      handoffJobId: jobId,
      outcomeStatus: "failed",
      outcomeUpdatedAt: "2025-02-07T11:05:00.000Z",
      outcomeDurationMs: 305_000,
      updatedAt: "2025-02-07T11:00:00.000Z",
    });
    const job = makeJob({
      id: jobId,
      sessionId,
      status: "failed",
      workerId: "worker-failed",
      params: JSON.stringify({ requestId }),
      error: JSON.stringify({ message: "worker runtime crashed" }),
      updatedAt: "2025-02-07T11:05:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: `status request ${requestId.slice(0, 8)}`,
      sessionId,
      requests: [request],
      jobs: [job],
      summarizeFailure,
      formatTime: stableFormatTime,
    });

    expect(reply).toContain(`Request ${requestId.slice(0, 8)} is failed`);
    expect(reply).not.toContain(`Request ${requestId.slice(0, 8)} is completed`);
    expect(reply).toContain("End-to-end: 5m 5s.");
    expect(reply).toContain("Failure: worker runtime crashed");
  });
});
