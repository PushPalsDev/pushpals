import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectDotEnvKeys,
  collectTomlLeafKeys,
  extraLocalKeys,
  missingTemplateKeys,
  readDotEnvKeys,
  readTomlLeafKeys,
} from "../packages/shared/src/config_template_parity";

describe("config template key parity helpers", () => {
  test("collectDotEnvKeys extracts assignment keys and ignores comments", () => {
    const raw = [
      "# comment",
      "PUSHPALS_PROFILE=dev",
      " export OPENAI_API_KEY = secret",
      "INVALID LINE",
      "LOCALBUDDY_LLM_MODEL=gpt-5-codex",
    ].join("\n");
    const keys = collectDotEnvKeys(raw);
    expect([...keys].sort()).toEqual([
      "LOCALBUDDY_LLM_MODEL",
      "OPENAI_API_KEY",
      "PUSHPALS_PROFILE",
    ]);
  });

  test("collectTomlLeafKeys flattens dotted leaf paths", () => {
    const raw = [
      'profile = "dev"',
      "",
      "[server]",
      "port = 3001",
      "",
      "[remotebuddy.autonomy]",
      "enabled = true",
      "max_dispatch_per_hour = 6",
      "",
      "[workerpals]",
      'executor = "openai_codex"',
    ].join("\n");
    const keys = collectTomlLeafKeys(raw);
    expect([...keys].sort()).toEqual([
      "profile",
      "remotebuddy.autonomy.enabled",
      "remotebuddy.autonomy.max_dispatch_per_hour",
      "server.port",
      "workerpals.executor",
    ]);
  });

  test("missingTemplateKeys returns sorted missing keys", () => {
    const template = new Set(["B_KEY", "A_KEY", "C_KEY"]);
    const local = new Set(["A_KEY"]);
    expect(missingTemplateKeys(template, local)).toEqual(["B_KEY", "C_KEY"]);
  });

  test("extraLocalKeys returns sorted local-only keys", () => {
    const template = new Set(["A_KEY"]);
    const local = new Set(["Z_KEY", "A_KEY", "B_KEY"]);
    expect(extraLocalKeys(template, local)).toEqual(["B_KEY", "Z_KEY"]);
  });

  test("read key helpers load keys from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-parity-"));
    const envPath = join(root, ".env");
    const tomlPath = join(root, "local.toml");
    writeFileSync(envPath, "A=1\nB=2\n", "utf8");
    writeFileSync(tomlPath, "[section]\nvalue=1\n", "utf8");

    try {
      expect([...readDotEnvKeys(envPath)].sort()).toEqual(["A", "B"]);
      expect([...readTomlLeafKeys(tomlPath)].sort()).toEqual(["section.value"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
