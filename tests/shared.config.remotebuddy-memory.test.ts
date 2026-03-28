import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config remotebuddy memory parsing", () => {
  test("uses [remotebuddy.memory] from local.example.toml when local.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.memory]",
        "enabled = true",
        "include_cross_session = true",
        "max_recall_items = 12",
        "max_recall_chars = 2400",
        "max_summary_chars = 420",
        "retention_days = 30",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[remotebuddy.memory]",
        "enabled = false",
        "include_cross_session = false",
        "max_recall_items = 9",
        "max_recall_chars = 1800",
        "max_summary_chars = 300",
        "retention_days = 14",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.memory.enabled).toBe(false);
      expect(cfg.remotebuddy.memory.includeCrossSession).toBe(false);
      expect(cfg.remotebuddy.memory.maxRecallItems).toBe(9);
      expect(cfg.remotebuddy.memory.maxRecallChars).toBe(1800);
      expect(cfg.remotebuddy.memory.maxSummaryChars).toBe(300);
      expect(cfg.remotebuddy.memory.retentionDays).toBe(14);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_MEMORY_* env overrides TOML values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.memory]",
        "enabled = true",
        "include_cross_session = true",
        "max_recall_items = 12",
        "max_recall_chars = 2400",
        "max_summary_chars = 420",
        "retention_days = 30",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const envChanges: Record<string, string> = {
      REMOTEBUDDY_MEMORY_ENABLED: "false",
      REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION: "false",
      REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS: "7",
      REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS: "1700",
      REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS: "280",
      REMOTEBUDDY_MEMORY_RETENTION_DAYS: "10",
    };
    const prior = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envChanges)) {
      prior.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.memory.enabled).toBe(false);
      expect(cfg.remotebuddy.memory.includeCrossSession).toBe(false);
      expect(cfg.remotebuddy.memory.maxRecallItems).toBe(7);
      expect(cfg.remotebuddy.memory.maxRecallChars).toBe(1700);
      expect(cfg.remotebuddy.memory.maxSummaryChars).toBe(280);
      expect(cfg.remotebuddy.memory.retentionDays).toBe(10);
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
