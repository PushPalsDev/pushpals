import { describe, expect, test } from "bun:test";
import { shouldEmitDirectSessionJobEvent } from "../apps/workerpals/src/workerpals_main";

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
});
