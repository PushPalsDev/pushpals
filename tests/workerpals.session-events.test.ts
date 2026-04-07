import { describe, expect, test } from "bun:test";
import {
  shouldEmitDirectSessionJobEvent,
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
});
