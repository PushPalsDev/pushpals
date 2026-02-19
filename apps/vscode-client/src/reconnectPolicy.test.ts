import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconnectDelayMs } from "./reconnectPolicy";

describe("reconnectDelayMs", () => {
  it("starts at base delay", () => {
    assert.equal(reconnectDelayMs(0), 2_000);
  });

  it("grows exponentially with attempts", () => {
    assert.equal(reconnectDelayMs(1), 4_000);
    assert.equal(reconnectDelayMs(2), 8_000);
    assert.equal(reconnectDelayMs(3), 16_000);
  });

  it("caps at max delay", () => {
    assert.equal(reconnectDelayMs(4), 30_000);
    assert.equal(reconnectDelayMs(10), 30_000);
  });

  it("handles invalid attempt values safely", () => {
    assert.equal(reconnectDelayMs(-1), 2_000);
    assert.equal(reconnectDelayMs(Number.NaN), 2_000);
  });
});
