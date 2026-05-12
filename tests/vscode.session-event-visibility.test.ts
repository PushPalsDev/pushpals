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

  test("suppresses autonomy-origin internal progress events in the webview timeline", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        type: "task_progress",
        from: "agent:remotebuddy-orchestrator/autonomy",
        payload: {
          taskId: "task-1",
          message: "Assigned to WorkerPal workerpal-1",
        },
      }),
    ).toBe(false);

    expect(
      shouldDisplayInteractiveSessionEvent({
        type: "job_failed",
        from: "server:job-fail-hook",
        payload: {
          jobId: "job-1",
          message: "Worker failed",
          origin: "autonomy",
        },
      }),
    ).toBe(false);
  });

  test("keeps autonomy clarification questions visible in the webview timeline", () => {
    expect(
      shouldDisplayInteractiveSessionEvent({
        type: "question_asked",
        from: "agent:remotebuddy-orchestrator/autonomy",
        payload: {
          questionId: "q-1",
          question: "Which target should I use?",
          origin: "autonomy",
        },
      }),
    ).toBe(true);
  });
});
