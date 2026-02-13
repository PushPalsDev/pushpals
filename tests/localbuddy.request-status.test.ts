import { describe, expect, test } from "bun:test";
import {
  buildRequestStatusReply,
  extractReferencedRequestToken,
  isStatusLookupPrompt,
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
  originalPrompt: "fix bug",
  status: "claimed",
  agentId: "remotebuddy-orchestrator",
  error: null,
  createdAt: "2026-02-13T01:00:00.000Z",
  updatedAt: "2026-02-13T01:10:00.000Z",
};

const requestB: RequestApiRow = {
  id: "a6f87819-2222-4222-8222-222222222222",
  sessionId: "dev",
  originalPrompt: "hello",
  status: "pending",
  agentId: null,
  error: null,
  createdAt: "2026-02-13T01:12:00.000Z",
  updatedAt: "2026-02-13T01:13:00.000Z",
};

describe("localbuddy request status intent", () => {
  test("extracts short and full request IDs", () => {
    expect(extractReferencedRequestToken("my request is e11225b1")).toBe("e11225b1");
    expect(
      extractReferencedRequestToken("check e11225b1-1111-4111-8111-111111111111"),
    ).toBe("e11225b1-1111-4111-8111-111111111111");
  });

  test("detects status-like prompts", () => {
    expect(isStatusLookupPrompt("how my request is doing")).toBe(true);
    expect(isStatusLookupPrompt("my request is e11225b1, check it")).toBe(true);
    expect(isStatusLookupPrompt("hello there")).toBe(false);
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
});
