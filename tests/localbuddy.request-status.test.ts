import { describe, expect, test } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  extractReferencedJobToken,
  extractReferencedRequestToken,
  isStatusLookupPrompt,
  type JobLogApiRow,
  type JobApiRow,
  type RequestApiRow,
} from "../apps/localbuddy/src/request_status";

const summarizeFailure = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const formatTime = () => "10:00 PM";

const requestA: RequestApiRow = {
  id: "e11225b1-1111-4111-8111-111111111111",
  sessionId: "dev",
  prompt: "fix bug",
  status: "claimed",
  agentId: "remotebuddy-orchestrator",
  error: null,
  createdAt: "2026-02-13T01:00:00.000Z",
  updatedAt: "2026-02-13T01:10:00.000Z",
};

const requestB: RequestApiRow = {
  id: "a6f87819-2222-4222-8222-222222222222",
  sessionId: "dev",
  prompt: "hello",
  status: "pending",
  agentId: null,
  error: null,
  createdAt: "2026-02-13T01:12:00.000Z",
  updatedAt: "2026-02-13T01:13:00.000Z",
};

describe("localbuddy request status intent", () => {
  test("extracts short and full request IDs", () => {
    expect(extractReferencedRequestToken("my request is e11225b1")).toBe("e11225b1");
    expect(extractReferencedRequestToken("check e11225b1-1111-4111-8111-111111111111")).toBe(
      "e11225b1-1111-4111-8111-111111111111",
    );
  });

  test("extracts short and full job IDs", () => {
    expect(extractReferencedJobToken("status of job 7c7683fa")).toBe("7c7683fa");
    expect(extractReferencedJobToken("status of job 7c7683fa-3333-4333-8333-333333333333")).toBe(
      "7c7683fa-3333-4333-8333-333333333333",
    );
  });

  test("detects status-like prompts", () => {
    expect(isStatusLookupPrompt("how my request is doing")).toBe(true);
    expect(isStatusLookupPrompt("my request is e11225b1, check it")).toBe(true);
    expect(isStatusLookupPrompt("what happened to the job?")).toBe(true);
    expect(isStatusLookupPrompt("why was job 7c7683fa terminated?")).toBe(true);
    expect(isStatusLookupPrompt("hello there")).toBe(false);
  });
});

describe("buildJobStatusReply", () => {
  test("reports direct job status with log tail", () => {
    const job: JobApiRow = {
      id: "7c7683fa-3333-4333-8333-333333333333",
      taskId: "task-2",
      sessionId: "dev",
      status: "claimed",
      workerId: "workerpal-5893e8e5",
      params: "{}",
      error: null,
      createdAt: "2026-02-13T03:20:00.000Z",
      updatedAt: "2026-02-13T03:31:00.000Z",
    };
    const logs: JobLogApiRow[] = [
      {
        id: 1,
        jobId: job.id,
        ts: "2026-02-13T03:30:01.000Z",
        message: "[JobRunner] Starting job",
      },
      {
        id: 2,
        jobId: job.id,
        ts: "2026-02-13T03:30:05.000Z",
        message: "Thinking: scanning apps/server/src/jobs.ts",
      },
      {
        id: 3,
        jobId: job.id,
        ts: "2026-02-13T03:30:08.000Z",
        message: "Action: file_editor view",
      },
    ];

    const reply = buildJobStatusReply({
      userPrompt: "whats the status of job 7c7683fa ?",
      sessionId: "dev",
      jobs: [job],
      logs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).toContain("Job 7c7683fa is claimed");
    expect(reply).toContain("currently in progress");
    expect(reply).toContain("Latest logs:");
    expect(reply).toContain("Thinking: scanning apps/server/src/jobs.ts");
  });

  test("returns helpful hint when job id is not found", () => {
    const job: JobApiRow = {
      id: "7c7683fa-3333-4333-8333-333333333333",
      taskId: "task-2",
      sessionId: "dev",
      status: "claimed",
      workerId: "workerpal-5893e8e5",
      params: "{}",
      error: null,
      createdAt: "2026-02-13T03:20:00.000Z",
      updatedAt: "2026-02-13T03:31:00.000Z",
    };

    const reply = buildJobStatusReply({
      userPrompt: "status of job deadbeef",
      sessionId: "dev",
      jobs: [job],
      logs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).toContain("I couldn't find job deadbeef");
    expect(reply).toContain("7c7683fa");
  });
});

describe("buildRequestStatusReply", () => {
  test("returns null for non-status prompts", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "hello",
      sessionId: "dev",
      requests: [requestA, requestB],
      jobs: [],
      summarizeFailure,
      formatTime,
    });
    expect(reply).toBeNull();
  });

  test("reports pending request waiting for claim", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "status for request a6f87819",
      sessionId: "dev",
      requests: [requestB],
      jobs: [],
      summarizeFailure,
      formatTime,
    });
    expect(reply).toContain("Request a6f87819 is pending");
    expect(reply).toContain("waiting for RemoteBuddy to claim it");
  });

  test("reports claimed request with active worker job", () => {
    const jobs: JobApiRow[] = [
      {
        id: "460aff19-3333-4333-8333-333333333333",
        taskId: "task-1",
        sessionId: "dev",
        status: "claimed",
        workerId: "workerpal-7cd42806",
        params: JSON.stringify({ requestId: requestA.id }),
        error: null,
        createdAt: "2026-02-13T01:11:00.000Z",
        updatedAt: "2026-02-13T01:12:00.000Z",
      },
    ];
    const reply = buildRequestStatusReply({
      userPrompt: "my request is e11225b1, can you check on it",
      sessionId: "dev",
      requests: [requestA, requestB],
      jobs,
      summarizeFailure,
      formatTime,
    });
    expect(reply).toContain("Request e11225b1 is claimed by remotebuddy-orchestrator");
    expect(reply).toContain("Latest WorkerPal job 460aff19 is claimed");
    expect(reply).toContain("workerpal-7cd42806");
  });

  test("reports failed worker job detail when available", () => {
    const jobs: JobApiRow[] = [
      {
        id: "e49e1b78-4444-4444-8444-444444444444",
        taskId: "task-1",
        sessionId: "dev",
        status: "failed",
        workerId: "workerpal-7cd42806",
        params: JSON.stringify({ requestId: requestA.id }),
        error: JSON.stringify({
          message: "OpenHands wrapper timed out after 600000ms",
          detail: "task.execute",
        }),
        createdAt: "2026-02-13T01:11:00.000Z",
        updatedAt: "2026-02-13T01:14:00.000Z",
      },
    ];
    const reply = buildRequestStatusReply({
      userPrompt: "how my status",
      sessionId: "dev",
      requests: [requestA],
      jobs,
      summarizeFailure,
      formatTime,
    });
    expect(reply).toContain("Latest WorkerPal job e49e1b78 is failed");
    expect(reply).toContain("Failure: OpenHands wrapper timed out after 600000ms | task.execute");
  });

  test("returns helpful hint when request id is not found", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "status for request deadbeef",
      sessionId: "dev",
      requests: [requestA, requestB],
      jobs: [],
      summarizeFailure,
      formatTime,
    });
    expect(reply).toContain("I couldn't find request deadbeef");
    expect(reply).toContain("e11225b1");
    expect(reply).toContain("a6f87819");
  });

  test("reports failed request with structured failure detail", () => {
    const failedRequest: RequestApiRow = {
      id: "70b0ab9c-5555-4555-8555-555555555555",
      sessionId: "dev",
      prompt: "status check",
      status: "failed",
      agentId: "remotebuddy-orchestrator",
      error: JSON.stringify({
        message: "RemoteBuddy orchestration timed out",
        detail: "planner stalled",
      }),
      createdAt: "2026-02-13T02:00:00.000Z",
      updatedAt: "2026-02-13T02:10:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "what happened to request 70b0ab9c?",
      sessionId: "dev",
      requests: [failedRequest],
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    if (!reply) {
      throw new Error("Expected reply to exist");
    }
    expect(reply).toMatch(/Request\s+70b0ab9c\s+is\s+failed/i);
    expect(reply).toMatch(/Failure:\s+RemoteBuddy orchestration timed out/i);
    expect(reply).toContain("planner stalled");
  });

  test("handles malformed failure payloads gracefully", () => {
    const failedRequest: RequestApiRow = {
      id: "5a77f8c1-7777-4777-8777-777777777777",
      sessionId: "dev",
      prompt: "status please",
      status: "failed",
      agentId: "remotebuddy-orchestrator",
      error: "RemoteBuddy aborted mid-flight <status::500>",
      createdAt: "2026-02-13T04:00:00.000Z",
      updatedAt: "2026-02-13T04:05:00.000Z",
    };
    const jobs: JobApiRow[] = [
      {
        id: "a1399aa4-eeee-4eee-8eee-eeeeeeeeeeee",
        taskId: "task-11",
        sessionId: "dev",
        status: "failed",
        workerId: "workerpal-delta",
        params: JSON.stringify({ requestId: failedRequest.id }),
        error: "Executor crashed >> non-json stacktrace <<",
        createdAt: "2026-02-13T04:01:00.000Z",
        updatedAt: "2026-02-13T04:04:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request 5a77f8c1",
      sessionId: "dev",
      requests: [failedRequest],
      jobs,
      summarizeFailure,
      formatTime,
    });

    if (!reply) {
      throw new Error("Expected reply to exist");
    }
    expect(reply).toMatch(/Request\s+5a77f8c1\s+is\s+failed/i);
    expect(reply).toMatch(/Failure:\s+RemoteBuddy aborted mid-flight <status::500>/i);
    expect(reply).toContain("Latest WorkerPal job a1399aa4");
    expect(reply).toMatch(/Executor crashed >> non-json stacktrace <<$/m);
  });
});
