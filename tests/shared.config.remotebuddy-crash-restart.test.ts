import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config remotebuddy crash restart parsing", () => {
  test("defaults to enabled with bounded restart values when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "poll_ms = 2000",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.crashRestartEnabled).toBe(true);
      expect(cfg.remotebuddy.crashRestartMaxRestarts).toBe(3);
      expect(cfg.remotebuddy.crashRestartBackoffMs).toBe(3000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports TOML and env overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "crash_restart_enabled = true",
        "crash_restart_max_restarts = 2",
        "crash_restart_backoff_ms = 1500",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const envChanges: Record<string, string> = {
      REMOTEBUDDY_CRASH_RESTART_ENABLED: "false",
      REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS: "5",
      REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS: "2500",
    };
    const prior = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envChanges)) {
      prior.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.crashRestartEnabled).toBe(false);
      expect(cfg.remotebuddy.crashRestartMaxRestarts).toBe(5);
      expect(cfg.remotebuddy.crashRestartBackoffMs).toBe(2500);
    } finally {
      for (const key of Object.keys(envChanges)) {
        const value = prior.get(key);
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
