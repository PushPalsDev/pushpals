import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, validateConfig } from "../apps/source_control_manager/src/config";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

function makeTempConfigFile(contents: Record<string, unknown>): string {
  const dir = join(tmpdir(), `pushpals-scm-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "source_control_manager.config.json");
  writeFileSync(path, JSON.stringify(contents), "utf-8");
  tempPaths.push(dir);
  return path;
}

describe("source_control_manager config", () => {
  test("loadConfig deep-merges reviewAgent with defaults", () => {
    const path = makeTempConfigFile({
      reviewAgent: {
        enabled: true,
      },
    });

    const config = loadConfig(path);

    expect(config.reviewAgent.enabled).toBe(true);
    expect(config.reviewAgent.pollIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(config.reviewAgent.passThreshold).toBeGreaterThanOrEqual(1);
    expect(config.reviewAgent.codexBin.length).toBeGreaterThan(0);
  });

  test("validateConfig rejects invalid reviewAgent values", () => {
    const config = loadConfig();
    config.reviewAgent.pollIntervalMs = 100;

    expect(() => validateConfig(config)).toThrow("reviewAgent.pollIntervalMs");
  });
});
