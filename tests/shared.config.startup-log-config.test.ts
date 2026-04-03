import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config startup log_config_on_start parsing", () => {
  test("defaults startup.logConfigOnStart to true when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.startup.logConfigOnStart).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads startup.log_config_on_start from local.example.toml when local.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      'profile = "dev"\n[startup]\nlog_config_on_start = true\n',
      "utf8",
    );
    writeFileSync(
      join(configDir, "local.example.toml"),
      "[startup]\nlog_config_on_start = false\n",
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.startup.logConfigOnStart).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PUSHPALS_LOG_CONFIG_ON_START overrides TOML values", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      'profile = "dev"\n[startup]\nlog_config_on_start = false\n',
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const prior = process.env.PUSHPALS_LOG_CONFIG_ON_START;
    process.env.PUSHPALS_LOG_CONFIG_ON_START = "1";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.startup.logConfigOnStart).toBe(true);
    } finally {
      if (prior == null) delete process.env.PUSHPALS_LOG_CONFIG_ON_START;
      else process.env.PUSHPALS_LOG_CONFIG_ON_START = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
