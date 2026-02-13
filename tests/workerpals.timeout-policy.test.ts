import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCKER_TIMEOUT_MS,
  DEFAULT_OPENHANDS_TIMEOUT_MS,
  computeTimeoutWarningWindow,
  parseDockerTimeoutMs,
  parseOpenHandsTimeoutMs,
} from "../apps/workerpals/src/timeout_policy";

describe("workerpals timeout policy", () => {
  test("uses expected defaults", () => {
    expect(DEFAULT_OPENHANDS_TIMEOUT_MS).toBe(1800000);
    expect(DEFAULT_DOCKER_TIMEOUT_MS).toBe(1860000);
  });

  test("parses and normalizes openhands timeout values", () => {
    expect(parseOpenHandsTimeoutMs(undefined)).toBe(DEFAULT_OPENHANDS_TIMEOUT_MS);
    expect(parseOpenHandsTimeoutMs("abc")).toBe(DEFAULT_OPENHANDS_TIMEOUT_MS);
    expect(parseOpenHandsTimeoutMs("0")).toBe(DEFAULT_OPENHANDS_TIMEOUT_MS);
    expect(parseOpenHandsTimeoutMs("5000")).toBe(10000);
    expect(parseOpenHandsTimeoutMs("720000")).toBe(720000);
  });

  test("parses and normalizes docker timeout values", () => {
    expect(parseDockerTimeoutMs(undefined)).toBe(DEFAULT_DOCKER_TIMEOUT_MS);
    expect(parseDockerTimeoutMs("")).toBe(DEFAULT_DOCKER_TIMEOUT_MS);
    expect(parseDockerTimeoutMs("-1")).toBe(DEFAULT_DOCKER_TIMEOUT_MS);
    expect(parseDockerTimeoutMs("3000")).toBe(10000);
    expect(parseDockerTimeoutMs("900000")).toBe(900000);
  });

  test("computes warning window with 60s lead for normal timeouts", () => {
    const result = computeTimeoutWarningWindow(1800000);
    expect(result.leadMs).toBe(60000);
    expect(result.delayMs).toBe(1740000);
  });

  test("computes warning window for very small timeouts", () => {
    const result = computeTimeoutWarningWindow(15000);
    expect(result.leadMs).toBe(10000);
    expect(result.delayMs).toBe(5000);
  });
});
