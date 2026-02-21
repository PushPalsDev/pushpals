import { describe, it, expect } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type RequestApiRow,
} from "./request_status";

const SESSION_ID = "session-1";
const BASE_TIME = "2025-01-01T00:00:00.000Z";
const summarizeFailure = (value: unknown) => String(value ?? "");
const constantTimeFormatter = () => "1:23 PM";

function makeRequest(overrides: Partial<RequestApiRow> = {}): RequestApiRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    sessionId: SESSION_ID,
    prompt: "tell me the status",
    status: "pending",
    agentId: null,
    error: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobApiRow> = {}): JobApiRow {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    taskId: "task-1",
    sessionId: SESSION_ID,
    status: "pending",
    workerId: null,
    params: "{}",
    error: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

describe("request_status helpers", () => {
  it("summarizes a request with linked WorkerPal jobs and counts", () => {
    const request = makeRequest({ id: "11111111-1111-1111-1111-111111111111", status: "pending" });
    const firstJob = makeJob({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "pending",
      params: JSON.stringify({ requestId: request.id }),
      updatedAt: "2025-02-01T00:00:00.000Z",
    });
    const latestJob = makeJob({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      status: "claimed",
      workerId: "worker-7",
      params: JSON.stringify({ requestId: request.id }),
      updatedAt: "2025-02-01T01:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "what's the status of my request?",
      sessionId: SESSION_ID,
      requests: [request],
      jobs: [firstJob, latestJob],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain("Request 11111111 is pending (updated 1:23 PM).");
    expect(reply).toContain(
      "Latest WorkerPal job bbbbbbbb is claimed (updated 1:23 PM) on worker-7.",
    );
    expect(reply).toContain("Jobs: 2 total (1 pending, 1 claimed, 0 completed, 0 failed).");
  });

  it("surfaces failure context for both the request and latest WorkerPal job", () => {
    const request = makeRequest({
      id: "22222222-2222-2222-2222-222222222222",
      status: "failed",
      error: JSON.stringify({ message: "Planner crashed", detail: "Plan missing" }),
      updatedAt: "2025-02-02T00:00:00.000Z",
    });
    const failedJob = makeJob({
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      status: "failed",
      params: JSON.stringify({ requestId: request.id }),
      error: JSON.stringify({ message: "Worker timed out", detail: "No output" }),
      updatedAt: "2025-02-02T01:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 22222222",
      sessionId: SESSION_ID,
      requests: [request],
      jobs: [failedJob],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain(
      "Request 22222222 is failed (updated 1:23 PM). Failure: Planner crashed | Plan missing",
    );
    expect(reply).toContain(
      "Latest WorkerPal job cccccccc is failed (updated 1:23 PM). Failure: Worker timed out | No output",
    );
  });

  it("explains that pending requests without WorkerPal jobs are still waiting to be claimed", () => {
    const pendingRequest = makeRequest({
      id: "33333333-3333-3333-3333-333333333333",
      status: "pending",
      updatedAt: "2025-02-03T00:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 33333333",
      sessionId: SESSION_ID,
      requests: [pendingRequest],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe(
      "Request 33333333 is pending (updated 1:23 PM). It is waiting for RemoteBuddy to claim it.",
    );
  });

  it("informs the user when no requests exist in the session", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "status update on my request",
      sessionId: SESSION_ID,
      requests: [],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe("I don't see any requests in this session yet.");
  });

  it("mentions the claiming agent and planning state when no WorkerPal job exists yet", () => {
    const claimedRequest = makeRequest({
      id: "44444444-4444-4444-4444-444444444444",
      status: "claimed",
      agentId: "remote-agent-9",
      priority: "interactive",
      updatedAt: "2025-02-04T00:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 44444444",
      sessionId: SESSION_ID,
      requests: [claimedRequest],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe(
      "Request 44444444 is claimed by remote-agent-9 (updated 1:23 PM). Priority: interactive. RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
  });

  it("notes when a completed request has not yet been linked to a WorkerPal job", () => {
    const completedRequest = makeRequest({
      id: "55555555-5555-5555-5555-555555555555",
      status: "completed",
      updatedAt: "2025-02-05T00:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status for my last request",
      sessionId: SESSION_ID,
      requests: [completedRequest],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe(
      "Request 55555555 is completed (updated 1:23 PM). RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
  });

  it("suggests recent request ids when the referenced token is missing", () => {
    const requestA = makeRequest({ id: "aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa" });
    const requestB = makeRequest({ id: "bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb" });

    const reply = buildRequestStatusReply({
      userPrompt: "status for request cccccccc",
      sessionId: SESSION_ID,
      requests: [requestA, requestB],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe("I couldn't find request cccccccc. Recent request IDs: aaaaaaaa, bbbbbbbb.");
  });

  it("resolves short request tokens from the user prompt", () => {
    const otherRequest = makeRequest({
      id: "aaaaaaaa-2222-3333-4444-aaaaaaaaaaaa",
      status: "pending",
      updatedAt: "2025-02-06T00:00:00.000Z",
    });
    const targetedRequest = makeRequest({
      id: "99999999-2222-3333-4444-999999999999",
      status: "completed",
      updatedAt: "2025-02-07T00:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 99999999",
      sessionId: SESSION_ID,
      requests: [otherRequest, targetedRequest],
      jobs: [],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe(
      "Request 99999999 is completed (updated 1:23 PM). RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
  });

  it("ignores WorkerPal jobs linked to other requests when summarizing", () => {
    const pendingRequest = makeRequest({
      id: "77777777-2222-3333-4444-777777777777",
      status: "pending",
      updatedAt: "2025-02-08T00:00:00.000Z",
    });
    const matchingJob = makeJob({
      id: "dddddddd-eeee-ffff-0000-dddddddddddd",
      status: "completed",
      params: JSON.stringify({ requestId: pendingRequest.id }),
      updatedAt: "2025-02-09T00:00:00.000Z",
    });
    const unrelatedJob = makeJob({
      id: "eeeeeeee-ffff-0000-1111-eeeeeeeeeeee",
      status: "failed",
      params: JSON.stringify({ requestId: "different-request" }),
      updatedAt: "2025-02-09T00:00:00.000Z",
    });

    const reply = buildRequestStatusReply({
      userPrompt: "request status update please",
      sessionId: SESSION_ID,
      requests: [pendingRequest],
      jobs: [matchingJob, unrelatedJob],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toContain("Request 77777777 is pending (updated 1:23 PM).");
    expect(reply).toContain(
      "Latest WorkerPal job dddddddd is completed (updated 1:23 PM).",
    );
    expect(reply).not.toContain("eeeeeeee");
    expect(reply).not.toContain("Jobs: 2 total");
  });

  it("lists recent job ids when a referenced job token does not exist", () => {
    const jobA = makeJob({ id: "aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa" });
    const jobB = makeJob({ id: "bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb" });

    const reply = buildJobStatusReply({
      userPrompt: "status update for job cccccccc",
      sessionId: SESSION_ID,
      jobs: [jobA, jobB],
      summarizeFailure,
      formatTime: constantTimeFormatter,
    });

    expect(reply).toBe("I couldn't find job cccccccc. Recent job IDs: aaaaaaaa, bbbbbbbb.");
  });
});
