import { describe, expect, test } from "bun:test";
import { shouldDisplayInteractiveSessionEvent } from "../apps/vscode-client/src/sessionEventVisibility";

describe("vscode session event visibility", () => {
  test("suppresses repetitive status heartbeat events from the webview timeline", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        type: "status",
        from: "agent:remotebuddy-orchestrator",
        payload: {
          state: "idle",
          detail: "RemoteBuddy heartbeat",
        },
      }),
    ).toBe(false);
  });

  test("keeps meaningful status updates visible in the webview timeline", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        type: "status",
        from: "agent:source_control_manager",
        payload: {
          state: "online",
          detail: "SourceControlManager online",
        },
      }),
    ).toBe(true);
  });
});
