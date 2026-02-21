import { describe, it, expect } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "./request_status.js";

const summarize = (value: unknown) => String(value ?? "").trim();
const staticTime = () => "10:00 AM";
const baseIso = "2024-01-01T00:00:00.000Z";

function job(overrides: Partial<JobApiRow>): JobApiRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    taskId: "task-1",
    sessionId: "session-1",
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
    kind: "run",
    ...overrides,
  };
}

function request(overrides: Partial<RequestApiRow>): RequestApiRow {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sessionId: "session-1",
    prompt: "test",
    status: "pending",
    agentId: null,
    error: null,
    createdAt: baseIso,
    updatedAt: baseIso,
    ...overrides,
  };
}

describe("buildJobStatusReply", () => {
  it("surfaces latest logs and thinking hint for failing jobs", () => {
    const failingJob = job({
      id: "12345678-1111-2222-3333-444444444444",
      sessionId: "session-a",
      status: "failed",
      workerId: "worker-1",
      params: "{}",
      error: JSON.stringify({ message: "context exceeded" }),
    });
    const logs: JobLogApiRow[] = [
      { id: 1, jobId: failingJob.id, ts: baseIso, message: "First chunk" },
      {
        id: 2,
        jobId: failingJob.id,
        ts: baseIso,
        message: "Thinking: analyzing plan",
      },
    ];

    const reply = buildJobStatusReply({
      userPrompt: "check job 12345678 status",
      sessionId: "session-a",
      jobs: [failingJob],
      logs,
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain("Job 12345678 is failed (updated 10:00 AM) on worker-1.");
    expect(reply).toContain("Failure: context exceeded");
    expect(reply).toContain("Latest logs:");
    expect(reply).toContain("First chunk");
    expect(reply).toContain("Thinking: analyzing plan");
    expect(reply).toContain("Model hint: Thinking: analyzing plan");
  });

  it("tells the user when a requested job id cannot be found", () => {
    const jobs = [
      job({ id: "12345678-aaaa-bbbb-cccc-dddddddddddd", sessionId: "session-q" }),
      job({ id: "abcdefab-aaaa-bbbb-cccc-eeeeeeeeeeee", sessionId: "session-q" }),
    ];

    const reply = buildJobStatusReply({
      userPrompt: "check job deadbeef status",
      sessionId: "session-q",
      jobs,
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toBe("I couldn't find job deadbeef. Recent job IDs: 12345678, abcdefab.");
    expect(reply).not.toContain("Job deadbeef is");
  });

  it("reports elapsed time and timeout target for claimed jobs", () => {
    const previousNow = Date.now;
    Date.now = () => Date.parse(baseIso) + 45_000;
    try {
      const claimedJob = job({
        id: "bbbbbbbb-0000-0000-0000-111111111111",
        sessionId: "session-b",
        status: "claimed",
        workerId: "worker-77",
        claimedAt: baseIso,
        params: JSON.stringify({ planning: { executionBudgetMs: 120_000 } }),
      });

      const reply = buildJobStatusReply({
        userPrompt: "status of job bbbbbbbb",
        sessionId: "session-b",
        jobs: [claimedJob],
        summarizeFailure: summarize,
        formatTime: staticTime,
      });

      expect(reply).toContain("Job bbbbbbbb is claimed (updated 10:00 AM) on worker-77.");
      expect(reply).toContain("Elapsed: 45s.");
      expect(reply).toContain("Timeout target: 10:00 AM.");
      expect(reply).not.toContain("Latest logs:");
    } finally {
      Date.now = previousNow;
    }
  });
});

describe("buildRequestStatusReply", () => {
  it("helps the user when a referenced request cannot be found", () => {
    const requests: RequestApiRow[] = [
      request({ id: "12345678-0000-0000-0000-111111111111", sessionId: "session-z" }),
      request({ id: "9abcdef0-0000-0000-0000-222222222222", sessionId: "session-z" }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "what's the status of request deadbeef?",
      sessionId: "session-z",
      requests,
      jobs: [],
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toBe("I couldn't find request deadbeef. Recent request IDs: 12345678, 9abcdef0.");
  });

  it("summarizes the latest WorkerPal job and job counts for a claimed request", () => {
    const requestId = "deadbeef-dead-beef-dead-beefdeadbeef";
    const requests: RequestApiRow[] = [
      request({
        id: requestId,
        sessionId: "session-y",
        status: "claimed",
        agentId: "remote-1",
        priority: "background",
      }),
    ];
    const jobs: JobApiRow[] = [
      job({
        id: "aaaaaaaa-bbbb-cccc-dddd-999999999999",
        sessionId: "session-y",
        status: "pending",
        params: JSON.stringify({ requestId }),
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
      job({
        id: "cafebabe-0000-0000-0000-111111111111",
        sessionId: "session-y",
        status: "failed",
        workerId: "worker-9",
        params: JSON.stringify({ requestId }),
        error: JSON.stringify({ message: "worker crashed" }),
        updatedAt: "2024-01-03T00:00:00.000Z",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request deadbeef",
      sessionId: "session-y",
      requests,
      jobs,
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toContain(
      "Request deadbeef is claimed by remote-1 (updated 10:00 AM). Priority: background.",
    );
    expect(reply).toContain(
      "Latest WorkerPal job cafebabe is failed (updated 10:00 AM) on worker-9.",
    );
    expect(reply).toContain("Failure: worker crashed");
    expect(reply).toContain("Jobs: 2 total (1 pending, 0 claimed, 0 completed, 1 failed).");
  });

  it("tells the user a pending request has not been claimed or enqueued", () => {
    const requests: RequestApiRow[] = [
      request({
        id: "feedface-aaaa-bbbb-cccc-dddddddddddd",
        sessionId: "session-p",
        status: "pending",
        priority: "normal",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request feedface",
      sessionId: "session-p",
      requests,
      jobs: [],
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toContain(
      "Request feedface is pending (updated 10:00 AM). Priority: normal. It is waiting for RemoteBuddy to claim it.",
    );
    expect(reply).not.toContain("Latest WorkerPal job");
  });

  it("explains when a claimed request has no WorkerPal jobs yet", () => {
    const requests: RequestApiRow[] = [
      request({
        id: "11111111-2222-3333-4444-555555555555",
        sessionId: "session-c",
        status: "claimed",
        agentId: "remote-42",
        priority: "interactive",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 11111111",
      sessionId: "session-c",
      requests,
      jobs: [],
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toContain(
      "Request 11111111 is claimed by remote-42 (updated 10:00 AM). Priority: interactive.",
    );
    expect(reply).toContain("RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.");
    expect(reply).not.toContain("Latest WorkerPal job");
  });

  it("ignores WorkerPal jobs without a matching request id for a completed request", () => {
    const requestId = "faceb00c-2222-3333-4444-555555555555";
    const requests: RequestApiRow[] = [
      request({
        id: requestId,
        sessionId: "session-q",
        status: "completed",
        priority: "background",
      }),
    ];

    const unrelatedJobs: JobApiRow[] = [
      job({
        id: "baadf00d-0000-0000-0000-111111111111",
        sessionId: "session-q",
        status: "completed",
        params: JSON.stringify({ requestId: "different-request" }),
        workerId: "worker-alpha",
      }),
      job({
        id: "decafbad-0000-0000-0000-222222222222",
        sessionId: "session-q",
        status: "failed",
        params: "{}",
        workerId: "worker-beta",
      }),
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for my last request",
      sessionId: "session-q",
      requests,
      jobs: unrelatedJobs,
      summarizeFailure: summarize,
      formatTime: staticTime,
    });

    expect(reply).toContain(
      "Request faceb00c is completed (updated 10:00 AM). Priority: background. RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
    expect(reply).not.toContain("Latest WorkerPal job");
    expect(reply).not.toContain("worker-alpha");
  });
});
