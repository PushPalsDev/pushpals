import { describe, expect, test } from "bun:test";
import {
  buildRequestStatusReply,
  type JobApiRow,
  type RequestApiRow,
} from "./request_status";

const summarizeFailure = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const formatTime = () => "10:00 PM";

describe("buildRequestStatusReply", () => {
  test("summarizes WorkerPal job counts when multiple jobs reference the request", () => {
    const request: RequestApiRow = {
      id: "e11225b1-1111-4111-8111-111111111111",
      sessionId: "dev",
      prompt: "status?",
      status: "claimed",
      agentId: "remotebuddy-orchestrator",
      error: null,
      priority: "interactive",
      createdAt: "2026-02-13T01:00:00.000Z",
      updatedAt: "2026-02-13T01:05:00.000Z",
    };

    const jobParams = JSON.stringify({ requestId: request.id });
    const jobs: JobApiRow[] = [
      {
        id: "af90f9c0-0001-4000-8000-000000000001",
        taskId: "task-1",
        sessionId: "dev",
        status: "failed",
        workerId: "workerpal-1",
        params: jobParams,
        error: JSON.stringify({ message: "LLM refused" }),
        createdAt: "2026-02-13T01:06:00.000Z",
        updatedAt: "2026-02-13T01:07:00.000Z",
      },
      {
        id: "af90f9c0-0002-4000-8000-000000000002",
        taskId: "task-1",
        sessionId: "dev",
        status: "completed",
        workerId: "workerpal-2",
        params: jobParams,
        error: null,
        createdAt: "2026-02-13T01:07:00.000Z",
        updatedAt: "2026-02-13T01:08:00.000Z",
      },
      {
        id: "af90f9c0-0003-4000-8000-000000000003",
        taskId: "task-1",
        sessionId: "dev",
        status: "pending",
        workerId: null,
        params: jobParams,
        error: null,
        createdAt: "2026-02-13T01:08:00.000Z",
        updatedAt: "2026-02-13T01:09:00.000Z",
      },
      {
        id: "af90f9c0-0004-4000-8000-000000000004",
        taskId: "task-1",
        sessionId: "dev",
        status: "claimed",
        workerId: "workerpal-4",
        params: jobParams,
        error: null,
        createdAt: "2026-02-13T01:09:00.000Z",
        updatedAt: "2026-02-13T01:10:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request e11225b1",
      sessionId: "dev",
      requests: [request],
      jobs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    const summary = reply as string;
    expect(summary).toContain("Request e11225b1 is claimed by remotebuddy-orchestrator");
    expect(summary).toContain("Priority: interactive.");
    expect(summary).toContain("Latest WorkerPal job af90f9c0 is claimed");
    expect(summary).toContain("Jobs: 4 total (1 pending, 1 claimed, 1 completed, 1 failed).");
  });

  test("includes request and WorkerPal failure details when both fail", () => {
    const request: RequestApiRow = {
      id: "e11225b1-2222-4222-8222-222222222222",
      sessionId: "dev",
      prompt: "status?",
      status: "failed",
      agentId: "remotebuddy-orchestrator",
      error: JSON.stringify({ message: "Planning failed", detail: "Missing tool" }),
      priority: "interactive",
      createdAt: "2026-02-13T02:00:00.000Z",
      updatedAt: "2026-02-13T02:05:00.000Z",
    };

    const jobs: JobApiRow[] = [
      {
        id: "af90f9c0-00ff-4000-9000-ffffffff0001",
        taskId: "task-2",
        sessionId: "dev",
        status: "failed",
        workerId: "workerpal-9",
        params: JSON.stringify({ requestId: request.id }),
        error: JSON.stringify({ message: "LLM refused", detail: "Policy violation" }),
        createdAt: "2026-02-13T02:06:00.000Z",
        updatedAt: "2026-02-13T02:07:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for request e11225b1",
      sessionId: "dev",
      requests: [request],
      jobs,
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    const summary = reply as string;
    expect(summary).toContain(
      "Request e11225b1 is failed (updated 10:00 PM). Priority: interactive. Failure: Planning failed | Missing tool",
    );
    expect(summary).toContain(
      "Latest WorkerPal job af90f9c0 is failed (updated 10:00 PM) on workerpal-9. Failure: LLM refused | Policy violation",
    );
  });

  test("describes pending requests without WorkerPal jobs as waiting for a claim", () => {
    const requests: RequestApiRow[] = [
      {
        id: "8e8aa8d1-0000-4000-9000-000000000111",
        sessionId: "dev",
        prompt: "status?",
        status: "completed",
        agentId: "remotebuddy-orchestrator",
        error: null,
        priority: "normal",
        createdAt: "2026-02-12T00:00:00.000Z",
        updatedAt: "2026-02-12T00:05:00.000Z",
      },
      {
        id: "9f9bb9e2-0000-4000-9000-000000000222",
        sessionId: "dev",
        prompt: "status?",
        status: "pending",
        agentId: null,
        error: null,
        priority: "interactive",
        createdAt: "2026-02-13T00:00:00.000Z",
        updatedAt: "2026-02-13T00:05:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "request status update, please",
      sessionId: "dev",
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    const summary = reply as string;
    expect(summary).toContain(
      "Request 9f9bb9e2 is pending (updated 10:00 PM). Priority: interactive.",
    );
    expect(summary).toContain("It is waiting for RemoteBuddy to claim it.");
  });

  test("mentions when RemoteBuddy is still planning and no WorkerPal job exists", () => {
    const requests: RequestApiRow[] = [
      {
        id: "abcd1234-5678-4000-9000-abcdefabcdef",
        sessionId: "dev",
        prompt: "status?",
        status: "claimed",
        agentId: "remotebuddy-orchestrator",
        error: null,
        priority: "interactive",
        createdAt: "2026-02-13T03:00:00.000Z",
        updatedAt: "2026-02-13T03:05:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status for my claimed request",
      sessionId: "dev",
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    const summary = reply as string;
    expect(summary).toContain(
      "Request abcd1234 is claimed by remotebuddy-orchestrator (updated 10:00 PM). Priority: interactive.",
    );
    expect(summary).toContain(
      "RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.",
    );
  });

  test("notes when RemoteBuddy completed orchestration but no WorkerPal job exists", () => {
    const requests: RequestApiRow[] = [
      {
        id: "deadbeef-0000-4000-9000-000000000000",
        sessionId: "dev",
        prompt: "status?",
        status: "completed",
        agentId: "remotebuddy-orchestrator",
        error: null,
        priority: "normal",
        createdAt: "2026-02-14T04:00:00.000Z",
        updatedAt: "2026-02-14T04:05:00.000Z",
      },
    ];

    const reply = buildRequestStatusReply({
      userPrompt: "status update for request deadbeef",
      sessionId: "dev",
      requests,
      jobs: [],
      summarizeFailure,
      formatTime,
    });

    expect(reply).not.toBeNull();
    const summary = reply as string;
    expect(summary).toContain(
      "Request deadbeef is completed (updated 10:00 PM). Priority: normal.",
    );
    expect(summary).toContain("RemoteBuddy finished orchestration; no WorkerPal job is linked yet.");
  });
});
