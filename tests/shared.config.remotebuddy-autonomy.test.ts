import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config remotebuddy autonomy parsing", () => {
  test("defaults autonomy.enabled to true when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults autonomy timing, safety, and PR-feedback limits when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.tickIntervalMs).toBe(120_000);
      expect(cfg.remotebuddy.autonomy.killSwitchEnabled).toBe(false);
      expect(cfg.remotebuddy.autonomy.allowDirtyWorktree).toBe(false);
      expect(cfg.remotebuddy.autonomy.heartbeatLogMs).toBe(30_000);
      expect(cfg.remotebuddy.autonomy.visionContextMaxChars).toBe(65_536);
      expect(cfg.remotebuddy.autonomy.exploreRate).toBe(0.3);
      expect(cfg.remotebuddy.autonomy.staleObjectiveTtlMs).toBe(2_700_000);
      expect(cfg.remotebuddy.autonomy.autoFreezeFailStreakThreshold).toBe(3);
      expect(cfg.remotebuddy.autonomy.maxTokenUsagePerHour).toBe(120_000);
      expect(cfg.remotebuddy.autonomy.maxRuntimeMsPerHour).toBe(5_400_000);
      expect(cfg.remotebuddy.autonomy.evaluatorWindowHours).toBe(24);
      expect(cfg.remotebuddy.autonomy.prFeedbackCommentRows).toBe(16);
      expect(cfg.remotebuddy.autonomy.prFeedbackCommentChars).toBe(600);
      expect(cfg.remotebuddy.autonomy.prFeedbackSummaryChars).toBe(600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "allow_dirty_worktree = false",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE";
    const prior = process.env[key];
    process.env[key] = "true";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.allowDirtyWorktree).toBe(true);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "heartbeat_log_ms = 30000",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS";
    const prior = process.env[key];
    process.env[key] = "45000";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.heartbeatLogMs).toBe(45_000);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "vision_context_max_chars = 65536",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS";
    const prior = process.env[key];
    process.env[key] = "96000";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.visionContextMaxChars).toBe(96_000);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_EXPLORE_RATE overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "explore_rate = 0.3",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_EXPLORE_RATE";
    const prior = process.env[key];
    process.env[key] = "0.45";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.exploreRate).toBe(0.45);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults per-type autonomy dispatch budgets when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByType.docs).toBe(1);
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByType.feature_small).toBe(2);
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByType.feature_medium).toBe(1);
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByType.feature_large).toBe(0);
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByComponent["apps/server"]).toBe(3);
      expect(cfg.remotebuddy.autonomy.maxDispatchPerHourByComponent["apps/client"]).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "kill_switch_enabled = false",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED";
    const prior = process.env[key];
    process.env[key] = "1";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.killSwitchEnabled).toBe(true);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy.autonomy]",
        "enabled = true",
        "max_token_usage_per_hour = 120000",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const key = "REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR";
    const prior = process.env[key];
    process.env[key] = "9000";
    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.autonomy.maxTokenUsagePerHour).toBe(9_000);
    } finally {
      if (prior == null) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
