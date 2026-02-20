import { describe, expect, test } from "bun:test";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "../request_status";

const sessionId = "session-1";
const iso = "2024-01-01T00:00:00.000Z";
const summarizeFailure = (value: unknown): string => `summary:${String(value)}`;
const stubFormatTime = (value: string): string => `@${value}`;

function makeRequest(overrides: Partial<RequestApiRow>): RequestApiRow {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    sessionId,
    prompt: "run tests",
    status: "pending",
    agentId: null,
    error: null,
    enqueuedAt: iso,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
    queueWaitBudgetMs: null,
    priority: "normal",
    durationMs: null,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobApiRow>): JobApiRow {
  return {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    taskId: "task-1",
    sessionId,
    kind: "worker",
    priority: "normal",
    status: "pending",
    workerId: null,
    params: "{}",
    error: null,
    queueWaitBudgetMs: null,
    executionBudgetMs: null,
    finalizationBudgetMs: null,
    enqueuedAt: iso,
    claimedAt: null,
    startedAt: null,
    firstLogAt: null,
    failedAt: null,
    completedAt: null,
    durationMs: null,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

describe("buildRequestStatusReply", () => {
  test("pending request without jobs highlights waiting state", () => {
    const reply = buildRequestStatusReply({
      userPrompt: "request status please",
      sessionId,
      requests: [
        makeRequest({
          id: "deadbeef-dead-dead-dead-deadbeef0001",
          status: "pending",
        }),
      ],
      jobs: [],
      summarizeFailure,
      formatTime: stubFormatTime,
    });

    expect(reply).toBeTruthy();
    const text = reply ?? "";
    expect(text).toMatch(/Request deadbeef is pending/);
    expect(text).toMatch(/waiting for RemoteBuddy to claim it\./);
  });

  test("failed request reports structured failure and related job counts", () => {
    const requestId = "ffff0000-0000-0000-0000-ffff00000000";
    const reply = buildRequestStatusReply({
      userPrompt: `status of request ${requestId.slice(0, 8)}`,
      sessionId,
      requests: [
        makeRequest({
          id: requestId,
          status: "failed",
          error: '{"message":"Plan failed","detail":"timeout"}',
        }),
      ],
      jobs: [
        makeJob({
          id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          status: "failed",
          params: JSON.stringify({ requestId }),
          error: '{"message":"Timeout","detail":"please inspect"}',
          workerId: "worker-9",
          updatedAt: "2024-01-01T00:10:00.000Z",
        }),
        makeJob({
          id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          status: "pending",
          params: JSON.stringify({ requestId }),
          updatedAt: "2024-01-01T00:05:00.000Z",
        }),
        makeJob({
          id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          sessionId: "session-2",
          params: JSON.stringify({ requestId }),
        }),
      ],
      summarizeFailure,
      formatTime: stubFormatTime,
    });

    expect(reply).toContain(
      "Failure: summary:Plan failed | timeout",
    );
    expect(reply).toContain(
      "Failure: summary:Timeout | please inspect",
    );
    expect(reply).toContain(
      "Jobs: 2 total (1 pending, 0 claimed, 0 completed, 1 failed).",
    );
  });
});

describe("buildJobStatusReply", () => {
  test("missing referenced job includes recent IDs", () => {
    const reply = buildJobStatusReply({
      userPrompt: "status job deadbeef",
      sessionId,
      jobs: [
        makeJob({ id: "11111111-1111-1111-1111-111111111111" }),
        makeJob({ id: "22222222-2222-2222-2222-222222222222" }),
      ],
      logs: [],
      summarizeFailure,
      formatTime: stubFormatTime,
    });

    expect(reply).toBe(
      "I couldn't find job deadbeef. Recent job IDs: 11111111, 22222222.",
    );
  });

  test("claimed job summary includes elapsed time, timeout, logs, and thinking hint", () => {
    const job = makeJob({
      id: "99999999-8888-7777-6666-555555555555",
      status: "claimed",
      workerId: "worker-42",
      startedAt: "2024-01-02T00:01:30.000Z",
      updatedAt: "2024-01-02T00:02:00.000Z",
      executionBudgetMs: 120_000,
    });
    const logs: JobLogApiRow[] = [
      { id: 1, jobId: job.id, ts: "2024-01-02T00:02:10.000Z", message: "working..." },
      {
        id: 2,
        jobId: job.id,
        ts: "2024-01-02T00:02:20.000Z",
        message: "Thinking: analyzing follow-up request",
      },
      { id: 3, jobId: "other", ts: iso, message: "ignored" },
    ];

    const realNow = Date.now;
    Date.now = () => Date.parse("2024-01-02T00:03:00.000Z");

    const reply = buildJobStatusReply({
      userPrompt: `status job ${job.id.slice(0, 8)}`,
      sessionId,
      jobs: [job],
      logs,
      summarizeFailure,
      formatTime: stubFormatTime,
    });

    Date.now = realNow;

    expect(reply).toContain("Job 99999999 is claimed (updated @2024-01-02T00:02:00.000Z) on worker-42.");
    expect(reply).toContain("Elapsed: 1m 30s.");
    expect(reply).toContain("Timeout target: @2024-01-02T00:03:30.000Z.");
    expect(reply).toContain("Latest logs:\n```\nworking...\nThinking: analyzing follow-up request\n```");
    expect(reply).toContain("Model hint: Thinking: analyzing follow-up request");
  });
});
