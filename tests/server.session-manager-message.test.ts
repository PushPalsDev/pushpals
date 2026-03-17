import { afterEach, describe, expect, test } from "bun:test";
import type { EventEnvelope } from "protocol";
import { SessionManager } from "../apps/server/src/events";

const managers: SessionManager[] = [];

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()?.close();
  }
});

function createSessionManager(): SessionManager {
  const manager = new SessionManager();
  managers.push(manager);
  return manager;
}

function captureSessionEvents(manager: SessionManager, sessionId: string): EventEnvelope[] {
  const session = manager.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const events: EventEnvelope[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  return events;
}

describe("server session manager client message ingress", () => {
  test("normalizes /ask_remote_buddy into a plain client message event", () => {
    const manager = createSessionManager();
    expect(manager.createSession("dev").id).toBe("dev");
    const events = captureSessionEvents(manager, "dev");

    const result = manager.handleMessage("dev", { text: "/ask_remote_buddy fix the dashboard" });

    expect(result).toMatchObject({ ok: true, code: "accepted" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      from: "client",
      payload: {
        text: "fix the dashboard",
      },
    });
  });

  test("emits a usage error when /ask_remote_buddy is missing a request body", () => {
    const manager = createSessionManager();
    expect(manager.createSession("dev").id).toBe("dev");
    const events = captureSessionEvents(manager, "dev");

    const result = manager.handleMessage("dev", { text: "/ask_remote_buddy" });

    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      message:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      payload: {
        message:
          "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
      },
    });
  });

  test("rejects messages for missing sessions instead of silently succeeding", () => {
    const manager = createSessionManager();

    expect(manager.handleMessage("missing", { text: "hello" })).toMatchObject({
      ok: false,
      code: "session_not_found",
      message: "Session not found",
    });
  });

  test("uses the configured ingress handler so in-process and HTTP message ingress stay aligned", () => {
    const manager = createSessionManager();
    expect(manager.createSession("dev").id).toBe("dev");
    const events = captureSessionEvents(manager, "dev");
    manager.setClientMessageIngress((sessionId, accepted) => {
      expect(sessionId).toBe("dev");
      expect(accepted.text).toBe("hello");
      return {
        ok: true,
        requestId: "req-123",
        queuePosition: 1,
        etaMs: 0,
      };
    });

    const result = manager.handleMessage("dev", { text: "hello" });

    expect(result).toMatchObject({
      ok: true,
      code: "accepted",
      requestId: "req-123",
      queuePosition: 1,
      etaMs: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      from: "client",
      payload: {
        text: "hello",
      },
    });
  });

  test("emits an error when the configured ingress handler cannot enqueue the request", () => {
    const manager = createSessionManager();
    expect(manager.createSession("dev").id).toBe("dev");
    const events = captureSessionEvents(manager, "dev");
    manager.setClientMessageIngress(() => ({
      ok: false,
      message: "queue unavailable",
    }));

    const result = manager.handleMessage("dev", { text: "hello" });

    expect(result).toMatchObject({
      ok: false,
      code: "enqueue_failed",
      message: "queue unavailable",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      payload: {
        message: "queue unavailable",
      },
    });
  });

  test("announces startup readiness once RemoteBuddy reports online without requiring LocalBuddy or SCM", () => {
    const manager = createSessionManager();
    expect(manager.createSession("dev").id).toBe("dev");
    const events = captureSessionEvents(manager, "dev");

    const result = manager.handleCommand("dev", {
      type: "status",
      from: "agent:remotebuddy-orchestrator",
      payload: {
        agentId: "remotebuddy-orchestrator",
        state: "idle",
        detail: "RemoteBuddy online and waiting for requests",
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "status",
      from: "agent:remotebuddy-orchestrator",
    });
    expect(events[1]).toMatchObject({
      type: "assistant_message",
      from: "system",
      payload: {
        text: "All systems online, feel free to send messages!",
      },
    });
  });
});
