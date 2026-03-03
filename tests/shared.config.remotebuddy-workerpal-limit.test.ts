import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config remotebuddy maxWorkerpals", () => {
  test("defaults to 20 workerpals when unset", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-default-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "poll_ms = 2000",
        "status_heartbeat_ms = 120000",
        "workerpal_online_ttl_ms = 15000",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.maxWorkerpals).toBe(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configs/local.example.toml keeps maxWorkerpals at 20", () => {
    const localExamplePath = join(import.meta.dir, "..", "configs", "local.example.toml");
    const contents = readFileSync(localExamplePath, "utf8");
    expect(contents).toMatch(/^\s*max_workerpals\s*=\s*20\s*$/m);
  });

  test("applies local overrides for maxWorkerpals", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-override-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "max_workerpals = 20",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.example.toml"),
      [
        "[remotebuddy]",
        "max_workerpals = 18",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(configDir, "local.toml"),
      [
        "[remotebuddy]",
        "max_workerpals = 6",
      ].join("\n"),
      "utf8",
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.maxWorkerpals).toBe(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only lowers maxWorkerpals when configuration explicitly sets it", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-explicit-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "max_workerpals = 10",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.remotebuddy.maxWorkerpals).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
