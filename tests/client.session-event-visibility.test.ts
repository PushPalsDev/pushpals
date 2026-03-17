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
});
