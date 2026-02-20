import { describe, expect, it } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  extractReferencedRequestToken,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "./request_status";

const baseIso = new Date("2024-01-01T00:00:00Z").toISOString();

function makeJob(overrides: Partial<JobApiRow>): JobApiRow {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    taskId: "task-0",
    sessionId: "session-default",
    status: "pending",
    workerId: null,
    params: "{}",
    error: null,
    queueWaitBudgetMs: null,
    executionBudgetMs: null,
    finalizationBudgetMs: null,
    enqueuedAt: baseIso,
    durationMs: null,
    claimedAt: null,
    startedAt: null,
    firstLogAt: null,
    failedAt: null,
    completedAt: null,
    createdAt: baseIso,
    updatedAt: baseIso,
    priority: "normal",
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RequestApiRow>): RequestApiRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-default",
    prompt: "status?",
    status: "pending",
    agentId: null,
    error: null,
    priority: "normal",
    queueWaitBudgetMs: null,
    durationMs: null,
    enqueuedAt: baseIso,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: baseIso,
    updatedAt: baseIso,
    ...overrides,
  };
}

describe("buildJobStatusReply", () => {
  it("summarizes failed jobs with logs and hints", () => {
    const sessionId = "session-a";
    const job = makeJob({
      id: "abcd1234-5678-4000-8000-aaaaaaaaaaaa",
      sessionId,
      status: "failed",
      workerId: "worker-9",
      params: JSON.stringify({ requestId: "req-1" }),
      error: JSON.stringify({ message: "LLM panic", detail: "context overflow" }),
      durationMs: 90_000,
      updatedAt: "2024-01-01T00:05:00.000Z",
      failedAt: "2024-01-01T00:05:00.000Z",
    });
    const logs: JobLogApiRow[] = [
      { id: 1, jobId: job.id, ts: "2024-01-01T00:04:00.000Z", message: "setup complete" },
      { id: 2, jobId: job.id, ts: "2024-01-01T00:04:30.000Z", message: "thinking: dig deeper" },
      { id: 3, jobId: job.id, ts: "2024-01-01T00:04:50.000Z", message: "final line" },
    ];

    const result = buildJobStatusReply({
      userPrompt: "status for job abcd1234",
      sessionId,
      jobs: [job],
      logs,
      summarizeFailure: (value) => String(value),
      formatTime: () => "12:00",
    });

    expect(result).toBeTruthy();
    expect(result).toContain("Job abcd1234 is failed (updated 12:00)");
    expect(result).toContain("Runtime: 1m 30s.");
    expect(result).toContain("Failure: LLM panic | context overflow");
    expect(result).toContain("Latest logs:\n```");
    expect(result).toContain("setup complete\nthinking: dig deeper\nfinal line");
    expect(result).toContain("Model hint: thinking: dig deeper");
  });
});

describe("buildJobStatusReply for claimed jobs", () => {
  it("reports planning execution budgets when WorkerPal is still running", () => {
    const sessionId = "session-claimed";
    const job = makeJob({
      id: "deadbeef-2222-4333-8eee-ffffffffffff",
      sessionId,
      status: "claimed",
      workerId: "worker-z",
      startedAt: "2024-01-01T12:00:00.000Z",
      claimedAt: "2024-01-01T11:59:30.000Z",
      executionBudgetMs: null,
      params: JSON.stringify({
        requestId: "request-123",
        planning: { executionBudgetMs: 300_000 },
      }),
      updatedAt: "2024-01-01T12:02:00.000Z",
    });

    const result = buildJobStatusReply({
      userPrompt: "status for job deadbeef",
      sessionId,
      jobs: [job],
      summarizeFailure: (value) => String(value ?? ""),
      formatTime: (iso) => `t:${iso}`,
    });

    expect(result).toBeTruthy();
    expect(result).toContain(
      "Job deadbeef is claimed (updated t:2024-01-01T12:02:00.000Z) on worker-z.",
    );
    expect(result).toContain("It is currently in progress.");
    expect(result).toContain("Timeout target: t:2024-01-01T12:05:00.000Z.");
  });
});

describe("buildRequestStatusReply", () => {
  it("links requests to WorkerPal jobs and reports counts", () => {
    const sessionId = "session-b";
    const requestId = "feedface-0000-4000-8000-aaaaaaaaaaaa";
    const request = makeRequest({
      id: requestId,
      sessionId,
      status: "failed",
      error: JSON.stringify({ message: "planner failure", detail: "db offline" }),
      priority: "interactive",
      updatedAt: "2024-01-01T08:00:00.000Z",
    });

    const jobs: JobApiRow[] = [
      makeJob({
        id: "11111111-2222-4000-8000-aaaaaaaaaaaa",
        sessionId,
        status: "pending",
        params: JSON.stringify({ requestId }),
        updatedAt: "2024-01-01T06:00:00.000Z",
      }),
      makeJob({
        id: "22222222-3333-4000-8000-aaaaaaaaaaaa",
        sessionId,
        status: "claimed",
        params: JSON.stringify({ requestId }),
        workerId: "worker-1",
        updatedAt: "2024-01-01T07:00:00.000Z",
      }),
      makeJob({
        id: "33333333-4444-4000-8000-aaaaaaaaaaaa",
        sessionId,
        status: "failed",
        params: JSON.stringify({ requestId }),
        error: JSON.stringify({ message: "job failure", detail: "timeout" }),
        updatedAt: "2024-01-01T08:30:00.000Z",
      }),
    ];

    const result = buildRequestStatusReply({
      userPrompt: "status for request feedface",
      sessionId,
      requests: [request],
      jobs,
      summarizeFailure: (value) => String(value),
      formatTime: (iso) => `t:${iso}`,
    });

    expect(result).toBeTruthy();
    expect(result).toContain("Request feedface is failed (updated t:2024-01-01T08:00:00.000Z).");
    expect(result).toContain("Failure: planner failure | db offline");
    expect(result).toContain(
      "Latest WorkerPal job 33333333 is failed (updated t:2024-01-01T08:30:00.000Z)",
    );
    expect(result).toContain("Failure: job failure | timeout");
    expect(result).toContain("Jobs: 3 total (1 pending, 1 claimed, 0 completed, 1 failed).");
  });
});

describe("extractReferencedRequestToken", () => {
  it("prioritizes explicit request references and normalizes casing", () => {
    const token = extractReferencedRequestToken("Status for Request DEADbeef please");
    expect(token).toBe("deadbeef");
  });

  it("rejects bare hex strings without any status context", () => {
    const token = extractReferencedRequestToken("deadbeef");
    expect(token).toBeNull();
  });
});

describe("buildRequestStatusReply without WorkerPal jobs", () => {
  it("explains that a pending request is waiting to be claimed", () => {
    const sessionId = "session-c";
    const request = makeRequest({
      id: "deadbeef-cafe-4def-8000-aaaaaaaaaaaa",
      sessionId,
      status: "pending",
      priority: "interactive",
      updatedAt: "2024-01-02T10:00:00.000Z",
    });

    const result = buildRequestStatusReply({
      userPrompt: "request status check",
      sessionId,
      requests: [request],
      jobs: [],
      summarizeFailure: (value) => String(value ?? ""),
      formatTime: (iso) => `t:${iso}`,
    });

    expect(result).toContain(
      "Request deadbeef is pending (updated t:2024-01-02T10:00:00.000Z). Priority: interactive.",
    );
    expect(result).toContain("It is waiting for RemoteBuddy to claim it.");
    expect(result).not.toContain("WorkerPal job");
  });
});

describe("buildRequestStatusReply when RemoteBuddy is still planning", () => {
  it("notes claimed requests with no WorkerPal job yet", () => {
    const sessionId = "session-claimed-request";
    const requestId = "deadbeef-c001-4eed-8000-aaaaaaaaaaaa";
    const request = makeRequest({
      id: requestId,
      sessionId,
      status: "claimed",
      agentId: "remote-buddy",
      priority: "interactive",
      updatedAt: "2024-01-03T09:00:00.000Z",
    });

    const unrelatedJob = makeJob({
      id: "aaaa1111-bbbb-4222-8ccc-123456789abc",
      sessionId,
      status: "pending",
      params: JSON.stringify({ requestId: "some-other-request" }),
      updatedAt: "2024-01-03T09:01:00.000Z",
    });

    const result = buildRequestStatusReply({
      userPrompt: "status check for request deadbeef",
      sessionId,
      requests: [request],
      jobs: [unrelatedJob],
      summarizeFailure: (value) => String(value ?? ""),
      formatTime: (iso) => `t:${iso}`,
    });

    expect(result).toContain(
      "Request deadbeef is claimed by remote-buddy (updated t:2024-01-03T09:00:00.000Z). Priority: interactive.",
    );
    expect(result).toContain(
      "RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
  });
});
