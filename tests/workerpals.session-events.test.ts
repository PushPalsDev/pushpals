import { describe, expect, test } from "bun:test";
import {
  inferWorkerTerminalFailureClass,
  shouldEmitDirectSessionJobEvent,
  shouldRecycleWorkerForCodexUnavailableFailure,
  shouldRecycleWorkerForHeartbeatDegradation,
} from "../apps/workerpals/src/workerpals_main";

describe("workerpals session event emission", () => {
  test("keeps direct completion events even when server status persistence succeeds", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: true,
        statusPersistedToServer: true,
      }),
    ).toBe(true);
  });

  test("suppresses duplicate direct failure events when server fail hook accepted the status", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: false,
        statusPersistedToServer: true,
      }),
    ).toBe(false);
  });

  test("falls back to a direct failure event when server fail persistence did not succeed", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: false,
        statusPersistedToServer: false,
      }),
    ).toBe(true);
  });

  test("does not recycle heartbeat transport once job execution has moved into finalization", () => {
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: false,
        allowHeartbeatRecycle: false,
        transportStale: true,
      }),
    ).toBe(false);
  });

  test("recycles heartbeat transport only while execution is still running and transport is stale", () => {
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: false,
        allowHeartbeatRecycle: true,
        transportStale: true,
      }),
    ).toBe(true);
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: true,
        allowHeartbeatRecycle: true,
        transportStale: true,
      }),
    ).toBe(false);
  });

  test("classifies codex startup stalls distinctly from no-publishable patch failures", () => {
    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "openai_codex stalled before first response",
        stderr: "Codex event trace:\n- thread.started\n- turn.started",
        exitCode: 124,
      }),
    ).toBe("codex_startup_stall");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "openai_codex made no publishable changes before the no-edit watchdog",
        stderr: "Codex produced reasoning but no patch",
        exitCode: 124,
      }),
    ).toBe("artifact_only_no_publishable_patch");
  });

  test("recycles a worker after a codex startup stall", () => {
    expect(
      shouldRecycleWorkerForCodexUnavailableFailure(
        "openai_codex stalled before first response",
        "startup stall after restart",
      ),
    ).toBe(true);
  });
});
