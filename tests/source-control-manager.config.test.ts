import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { applyCliOverrides, loadConfig, validateConfig } from "../apps/source_control_manager/src/config";

describe("source_control_manager config", () => {
  test("loadConfig reads defaults from shared PushPals config", () => {
    const config = loadConfig();

    expect(config.repoPath.length).toBeGreaterThan(0);
    expect(config.remote.length).toBeGreaterThan(0);
    expect(config.mainBranch.length).toBeGreaterThan(0);
    expect(config.reviewAgent.pollIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(config.reviewAgent.passThreshold).toBeGreaterThanOrEqual(1);
    expect(config.reviewAgent.maxPrCommentsBeforeGiveUp).toBeGreaterThanOrEqual(1);
    expect(config.reviewAgent.codexBin.length).toBeGreaterThan(0);
  });

  test("applyCliOverrides applies explicit runtime overrides", () => {
    const config = loadConfig();
    const merged = applyCliOverrides(config, { port: 3999, pollIntervalSeconds: 42 });
    expect(merged.port).toBe(3999);
    expect(merged.pollIntervalSeconds).toBe(42);
  });

  test("applyCliOverrides coerces server overrides back to loopback and strips auth tokens", () => {
    const config = loadConfig();
    const merged = applyCliOverrides(config, {
      serverUrl: "https://pushpals.example:4551",
      authToken: "secret-token",
    });
    expect(merged.serverUrl).toBe("http://127.0.0.1:4551");
    expect(merged.authToken).toBeUndefined();
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

  test("loadConfig reloads updated shared runtime config", () => {
    const originalConfigDir = process.env.PUSHPALS_CONFIG_DIR_OVERRIDE;
    const tempRoot = mkdtempSync(join(tmpdir(), "pushpals-scm-config-"));
    const configDir = join(tempRoot, "configs");
    mkdirSync(configDir, { recursive: true });
    cpSync(resolve(import.meta.dir, "..", "configs", "default.toml"), join(configDir, "default.toml"));
    cpSync(
      resolve(import.meta.dir, "..", "configs", "local.example.toml"),
      join(configDir, "local.example.toml"),
    );
    writeFileSync(
      join(configDir, "local.toml"),
      "[source_control_manager.review_agent]\nenabled = false\n",
      "utf8",
    );
    process.env.PUSHPALS_CONFIG_DIR_OVERRIDE = configDir;

    try {
      expect(loadConfig({ reload: true }).reviewAgent.enabled).toBe(false);

      writeFileSync(
        join(configDir, "local.toml"),
        "[source_control_manager.review_agent]\nenabled = true\n",
        "utf8",
      );

      expect(loadConfig({ reload: true }).reviewAgent.enabled).toBe(true);
    } finally {
      if (originalConfigDir === undefined) delete process.env.PUSHPALS_CONFIG_DIR_OVERRIDE;
      else process.env.PUSHPALS_CONFIG_DIR_OVERRIDE = originalConfigDir;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
