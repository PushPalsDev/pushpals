import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("shared config env path overrides", () => {
  test("bounds the dependency preparation timeout override", () => {
    const previous = process.env.WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS;
    try {
      process.env.WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS = "45000";
      expect(loadPushPalsConfig({ reload: true }).workerpals.dependencyPreparationTimeoutMs).toBe(
        45_000,
      );
      process.env.WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS = "99999999";
      expect(loadPushPalsConfig({ reload: true }).workerpals.dependencyPreparationTimeoutMs).toBe(
        20 * 60_000,
      );
    } finally {
      if (previous == null) delete process.env.WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS;
      else process.env.WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS = previous;
      loadPushPalsConfig({ reload: true });
    }
  });

  test("respects PUSHPALS_PROJECT_ROOT_OVERRIDE and PUSHPALS_CONFIG_DIR_OVERRIDE", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-config-env-"));
    const projectRoot = join(root, "project-repo");
    const configDir = join(root, "runtime-configs");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, "default.toml"),
      'profile = "dev"\n[server]\nport = 4123\n',
      "utf8",
    );
    writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

    const previousProjectRoot = process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE;
    const previousConfigDir = process.env.PUSHPALS_CONFIG_DIR_OVERRIDE;
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE = projectRoot;
    process.env.PUSHPALS_CONFIG_DIR_OVERRIDE = configDir;

    try {
      const cfg = loadPushPalsConfig({ reload: true });
      expect(cfg.projectRoot).toBe(resolve(projectRoot));
      expect(cfg.configDir).toBe(resolve(configDir));
      expect(cfg.server.port).toBe(4123);
      expect(cfg.paths.dataDir.startsWith(resolve(projectRoot))).toBe(true);
    } finally {
      if (previousProjectRoot == null) delete process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE;
      else process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE = previousProjectRoot;
      if (previousConfigDir == null) delete process.env.PUSHPALS_CONFIG_DIR_OVERRIDE;
      else process.env.PUSHPALS_CONFIG_DIR_OVERRIDE = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
