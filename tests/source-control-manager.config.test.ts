import { describe, expect, test } from "bun:test";
import { applyCliOverrides, loadConfig, validateConfig } from "../apps/source_control_manager/src/config";

describe("source_control_manager config", () => {
  test("loadConfig reads defaults from shared PushPals config", () => {
    const config = loadConfig();

    expect(config.repoPath.length).toBeGreaterThan(0);
    expect(config.remote.length).toBeGreaterThan(0);
    expect(config.mainBranch.length).toBeGreaterThan(0);
    expect(config.reviewAgent.pollIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(config.reviewAgent.passThreshold).toBeGreaterThanOrEqual(1);
    expect(config.reviewAgent.codexBin.length).toBeGreaterThan(0);
  });

  test("applyCliOverrides applies explicit runtime overrides", () => {
    const config = loadConfig();
    const merged = applyCliOverrides(config, { port: 3999, pollIntervalSeconds: 42 });
    expect(merged.port).toBe(3999);
    expect(merged.pollIntervalSeconds).toBe(42);
  });

  test("loadConfig returns independent checks arrays", () => {
    const first = loadConfig();
    first.checks.push({ name: "temp", command: "echo temp", timeoutMs: 1000 });

    const second = loadConfig();
    expect(second.checks.some((check) => check.name === "temp")).toBe(false);
  });

  test("validateConfig rejects invalid reviewAgent values", () => {
    const config = loadConfig();
    config.reviewAgent.pollIntervalMs = 100;

    expect(() => validateConfig(config)).toThrow("reviewAgent.pollIntervalMs");
  });
});
