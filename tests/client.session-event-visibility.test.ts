import { describe, expect, test } from "bun:test";
import { shouldDisplayInteractiveSessionEvent } from "../apps/client/src/lib/sessionEventVisibility";

describe("client session event visibility", () => {
  test("suppresses repetitive status heartbeat events from interactive timelines", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        id: "evt-1",
        ts: new Date().toISOString(),
        type: "status",
        from: "agent:localbuddy-1",
        payload: {
          state: "idle",
          detail: "LocalBuddy heartbeat",
        },
        sessionId: "dev",
        protocolVersion: "0.1",
      } as any),
    ).toBe(false);
  });

  test("keeps non-heartbeat status updates visible", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        id: "evt-2",
        ts: new Date().toISOString(),
        type: "status",
        from: "agent:remotebuddy-orchestrator",
        payload: {
          state: "busy",
          detail: "RemoteBuddy processing request",
        },
        sessionId: "dev",
        protocolVersion: "0.1",
      } as any),
    ).toBe(true);
  });

  test("suppresses autonomy-origin internal progress events", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        id: "evt-3",
        ts: new Date().toISOString(),
        type: "assistant_message",
        from: "agent:source_control_manager/autonomy",
        payload: {
          text: "ReviewAgent mode: local apply conflicted",
        },
        sessionId: "dev",
        protocolVersion: "0.1",
      } as any),
    ).toBe(false);

    expect(
      shouldDisplayInteractiveSessionEvent({
        id: "evt-4",
        ts: new Date().toISOString(),
        type: "job_completed",
        from: "worker:workerpal-1",
        payload: {
          jobId: "job-1",
          summary: "Executed task",
          origin: "autonomy",
        },
        sessionId: "dev",
        protocolVersion: "0.1",
      } as any),
    ).toBe(false);
  });

  test("keeps autonomy clarification questions visible", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        id: "evt-5",
        ts: new Date().toISOString(),
        type: "question_asked",
        from: "agent:remotebuddy-orchestrator/autonomy",
        payload: {
          questionId: "q-1",
          question: "Which target should I use?",
          origin: "autonomy",
        },
        sessionId: "dev",
        protocolVersion: "0.1",
      } as any),
    ).toBe(true);
  });
});
