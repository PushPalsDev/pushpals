import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadPushPalsConfig,
  normalizeWorkerPalsExecutionPlatform,
} from "../packages/shared/src/config";

function withRuntimeConfig<T>(toml: string, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pushpals-execution-platform-"));
  const configDir = join(root, "configs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "default.toml"), toml, "utf8");
  writeFileSync(join(configDir, "local.example.toml"), "", "utf8");

  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("shared config WorkerPal execution platform", () => {
  test("normalizes execution platform aliases and invalid values", () => {
    expect(normalizeWorkerPalsExecutionPlatform("auto")).toBe("auto");
    expect(normalizeWorkerPalsExecutionPlatform("windows")).toBe("windows");
    expect(normalizeWorkerPalsExecutionPlatform("linux-docker")).toBe("linux_docker");
    expect(normalizeWorkerPalsExecutionPlatform("unknown", "windows")).toBe("windows");
  });

  test("auto preserves legacy Docker toggles", () => {
    withRuntimeConfig(
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "workerpal_docker = false",
        "workerpal_require_docker = false",
        "",
        "[workerpals]",
        'execution_platform = "auto"',
        "require_docker = true",
      ].join("\n"),
      (root) => {
        const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });

        expect(cfg.workerpals.executionPlatform).toBe("auto");
        expect(cfg.remotebuddy.workerpalDocker).toBe(false);
        expect(cfg.remotebuddy.workerpalRequireDocker).toBe(false);
        expect(cfg.workerpals.requireDocker).toBe(true);
      },
    );
  });

  test("windows execution platform forces direct host WorkerPals", () => {
    withRuntimeConfig(
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "workerpal_docker = true",
        "workerpal_require_docker = true",
        "",
        "[workerpals]",
        'execution_platform = "windows"',
        "require_docker = true",
      ].join("\n"),
      (root) => {
        const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });

        expect(cfg.workerpals.executionPlatform).toBe("windows");
        expect(cfg.remotebuddy.workerpalDocker).toBe(false);
        expect(cfg.remotebuddy.workerpalRequireDocker).toBe(false);
        expect(cfg.workerpals.requireDocker).toBe(false);
      },
    );
  });

  test("linux_docker execution platform forces Docker-backed WorkerPals", () => {
    withRuntimeConfig(
      [
        'profile = "dev"',
        "",
        "[remotebuddy]",
        "workerpal_docker = false",
        "workerpal_require_docker = false",
        "",
        "[workerpals]",
        'execution_platform = "linux_docker"',
        "require_docker = false",
      ].join("\n"),
      (root) => {
        const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });

        expect(cfg.workerpals.executionPlatform).toBe("linux_docker");
        expect(cfg.remotebuddy.workerpalDocker).toBe(true);
        expect(cfg.remotebuddy.workerpalRequireDocker).toBe(true);
        expect(cfg.workerpals.requireDocker).toBe(true);
      },
    );
  });

  test("environment execution platform override wins over TOML", () => {
    const previous = process.env.WORKERPALS_EXECUTION_PLATFORM;
    process.env.WORKERPALS_EXECUTION_PLATFORM = "windows";

    try {
      withRuntimeConfig(
        [
          'profile = "dev"',
          "",
          "[workerpals]",
          'execution_platform = "linux_docker"',
          "require_docker = true",
        ].join("\n"),
        (root) => {
          const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });

          expect(cfg.workerpals.executionPlatform).toBe("windows");
          expect(cfg.remotebuddy.workerpalDocker).toBe(false);
          expect(cfg.remotebuddy.workerpalRequireDocker).toBe(false);
          expect(cfg.workerpals.requireDocker).toBe(false);
        },
      );
    } finally {
      if (previous == null) delete process.env.WORKERPALS_EXECUTION_PLATFORM;
      else process.env.WORKERPALS_EXECUTION_PLATFORM = previous;
    }
  });
});
