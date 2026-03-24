import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseRequiredBackendToml,
  resolveBackendTomlPath,
} from "../apps/workerpals/src/backends/backend_config";

describe("workerpals backend config", () => {
  test("requires configs/backend.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-backend-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });

    try {
      expect(() => parseRequiredBackendToml(join(configDir, "backend.toml"))).toThrow(
        `Missing required runtime backend config file: ${join(configDir, "backend.toml")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses backend metadata when present", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-backend-config-"));
    const configDir = join(root, "configs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "backend.toml"),
      [
        'default_backend = "openai_codex"',
        "",
        "[backends.openai_codex]",
        'script_segments = ["backends", "openai_codex", "openai_codex_executor.py"]',
      ].join("\n"),
      "utf8",
    );

    try {
      const parsed = parseRequiredBackendToml(join(configDir, "backend.toml"));
      expect(parsed.default_backend).toBe("openai_codex");
      expect(parsed.backends?.openai_codex).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves backend metadata from the effective runtime config dir", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-backend-config-"));
    const repoRoot = join(root, "repo");
    const runtimeConfigDir = join(root, "runtime", "configs");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(runtimeConfigDir, { recursive: true });

    try {
      expect(resolveBackendTomlPath(runtimeConfigDir)).toBe(join(runtimeConfigDir, "backend.toml"));
      expect(resolveBackendTomlPath(join(repoRoot, "configs"))).not.toBe(
        join(runtimeConfigDir, "backend.toml"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
