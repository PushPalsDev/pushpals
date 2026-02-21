import { describe, expect, test } from "bun:test";
import {
  buildRequestStatusReply,
  type JobApiRow,
  type RequestApiRow,
} from "../src/request_status";

const summarizeFailure = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const formatTime = (iso: string): string => iso;

describe("buildRequestStatusReply", () => {
  test("summarizes multiple related WorkerPal jobs", () => {
    const request: RequestApiRow = {
      id: "0b8a0e88-aaaa-4bbb-8ccc-123456789abc",
      sessionId: "dev",
      prompt: "backfill LocalBuddy coverage",
      priority: "interactive",
      status: "claimed",
      agentId: "remotebuddy-orchestrator",
      error: null,
      createdAt: "2026-02-14T03:00:00.000Z",
      updatedAt: "2026-02-14T03:15:00.000Z",
    };

    const jobs: JobApiRow[] = [
      {
        id: "55555555-1111-4222-8333-111111111111",
        taskId: "task-1",
        sessionId: "dev",
        status: "pending",
        workerId: null,
        params: JSON.stringify({ requestId: request.id }),
        error: null,
        createdAt: "2026-02-14T03:05:00.000Z",
        updatedAt: "2026-02-14T03:05:00.000Z",
      },
      {
        id: "66666666-1111-4222-8333-111111111111",
        taskId: "task-2",
        sessionId: "dev",
        status: "completed",
        workerId: "workerpal-alpha",
        params: JSON.stringify({ requestId: request.id }),
        error: null,
        durationMs: 120000,
        createdAt: "2026-02-14T03:06:00.000Z",
        updatedAt: "2026-02-14T03:10:00.000Z",
      },
      {
        id: "77777777-1111-4222-8333-111111111111",
        taskId: "task-3",
        sessionId: "dev",
        status: "claimed",
        workerId: "workerpal-beta",
        params: JSON.stringify({ requestId: request.id }),
        error: null,
        createdAt: "2026-02-14T03:11:00.000Z",
        updatedAt: "2026-02-14T03:20:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status update for request 0b8a0e88",
      sessionId: "dev",
      requests: [request],
      jobs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain(
      "Request 0b8a0e88 is claimed by remotebuddy-orchestrator (updated 2026-02-14T03:15:00.000Z). Priority: interactive.",
    );
    expect(reply).toContain(
      "Latest WorkerPal job 77777777 is claimed (updated 2026-02-14T03:20:00.000Z) on workerpal-beta.",
    );
    expect(reply).toContain(
      "Jobs: 3 total (1 pending, 1 claimed, 1 completed, 0 failed).",
    );
  });

  test("informs pending request is still waiting when no WorkerPal job exists", () => {
    const request: RequestApiRow = {
      id: "cb7b9cdd-1111-4f62-aaaa-222222222222",
      sessionId: "dev",
      prompt: "draft release email",
      priority: "interactive",
      status: "pending",
      agentId: null,
      error: null,
      createdAt: "2026-02-15T17:00:00.000Z",
      updatedAt: "2026-02-15T17:05:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "what's the status of request cb7b9cdd?",
      sessionId: "dev",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain(
      "Request cb7b9cdd is pending (updated 2026-02-15T17:05:00.000Z). Priority: interactive.",
    );
    expect(reply).toContain("It is waiting for RemoteBuddy to claim it.");
    expect(reply).not.toContain("Latest WorkerPal job");
  });

  test("notes claimed request is still planning without WorkerPal job", () => {
    const request: RequestApiRow = {
      id: "deafbeef-2222-4dd8-9999-aaaaaaaaaaaa",
      sessionId: "dev",
      prompt: "map new feature rollout",
      priority: "normal",
      status: "claimed",
      agentId: "remotebuddy-orchestrator",
      error: null,
      createdAt: "2026-02-16T12:00:00.000Z",
      updatedAt: "2026-02-16T12:10:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "status on request deafbeef?",
      sessionId: "dev",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain(
      "Request deafbeef is claimed by remotebuddy-orchestrator (updated 2026-02-16T12:10:00.000Z). Priority: normal.",
    );
    expect(reply).toContain(
      "RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
    expect(reply).not.toContain("Latest WorkerPal job");
  });

  test("explains completed request without WorkerPal job", () => {
    const request: RequestApiRow = {
      id: "feedfeed-9999-4a4a-bbbb-333333333333",
      sessionId: "dev",
      prompt: "track background cleanup",
      priority: "background",
      status: "completed",
      agentId: "remotebuddy-orchestrator",
      error: null,
      createdAt: "2026-02-12T09:00:00.000Z",
      updatedAt: "2026-02-12T09:30:00.000Z",
    };

    const reply = buildRequestStatusReply({
      userPrompt: "status on request feedfeed",
      sessionId: "dev",
      requests: [request],
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain(
      "Request feedfeed is completed (updated 2026-02-12T09:30:00.000Z). Priority: background.",
    );
    expect(reply).toContain(
      "RemoteBuddy finished orchestration; no WorkerPal job is linked yet.",
    );
    expect(reply).not.toContain("Latest WorkerPal job");
    expect(reply).not.toContain("RemoteBuddy is still planning");
  });

  test("surfaces failure details from the request and its WorkerPal job", () => {
    const request: RequestApiRow = {
      id: "11112222-3333-4444-8888-999999999999",
      sessionId: "dev",
      prompt: "triage outage",
      priority: "normal",
      status: "failed",
      agentId: "remotebuddy-orchestrator",
      error: JSON.stringify({
        message: "Workflow aborted",
        detail: "Timed out waiting on WorkerPal",
      }),
      createdAt: "2026-02-13T07:00:00.000Z",
      updatedAt: "2026-02-13T07:30:00.000Z",
    };

    const jobs: JobApiRow[] = [
      {
        id: "ab00eeff-aaaa-bbbb-cccc-121212121212",
        taskId: "triage",
        sessionId: "dev",
        status: "failed",
        workerId: "workerpal-gamma",
        params: JSON.stringify({ requestId: request.id }),
        error: JSON.stringify({
          message: "Worker crashed",
          detail: "Out of memory after 5m",
        }),
        createdAt: "2026-02-13T07:05:00.000Z",
        updatedAt: "2026-02-13T07:20:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status of request 11112222",
      sessionId: "dev",
      requests: [request],
      jobs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    expect(reply).toContain(
      "Request 11112222 is failed (updated 2026-02-13T07:30:00.000Z). Priority: normal. Failure: Workflow aborted | Timed out waiting on WorkerPal",
    );
    expect(reply).toContain(
      "Latest WorkerPal job ab00eeff is failed (updated 2026-02-13T07:20:00.000Z) on workerpal-gamma. Failure: Worker crashed | Out of memory after 5m",
    );
    expect(reply).not.toContain("RemoteBuddy is still planning");
  });
});
