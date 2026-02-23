import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config remotebuddy autonomy parsing", () => {
  test("defaults allowDirtyWorktree to false when unset", () => {
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
      expect(cfg.remotebuddy.autonomy.allowDirtyWorktree).toBe(false);
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
});
