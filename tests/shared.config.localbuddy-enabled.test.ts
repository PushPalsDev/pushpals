import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config localbuddy enabled parsing", () => {
  test("defaults localbuddy.enabled to false when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.localbuddy.enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads localbuddy.enabled from TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = true"].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.localbuddy.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LOCALBUDDY_ENABLED overrides TOML", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      ['profile = "dev"', "", "[localbuddy]", "enabled = false"].join("\n"),
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const prior = process.env.LOCALBUDDY_ENABLED;
    process.env.LOCALBUDDY_ENABLED = "true";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.localbuddy.enabled).toBe(true);
    } finally {
      if (prior == null) delete process.env.LOCALBUDDY_ENABLED;
      else process.env.LOCALBUDDY_ENABLED = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
