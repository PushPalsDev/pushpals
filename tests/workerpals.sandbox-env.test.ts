import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildWorkerSandboxWritableEnv } from "../apps/workerpals/src/common/sandbox_env";

describe("workerpals sandbox writable env", () => {
  test("redirects HOME and Expo caches to writable temp paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: "/root",
        PATH: "test-path",
      });

      expect(env.PATH).toBe("test-path");
      expect(env.HOME).not.toBe("/root");
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.EXPO_HOME).toContain("pushpals-worker-env");
      expect(env.XDG_CACHE_HOME).toContain("pushpals-worker-env");
      expect(env.npm_config_cache).toContain("npm");
      expect(env.EXPO_NO_TELEMETRY).toBe("1");
      expect(env.EXPO_NO_INTERACTIVE).toBe("1");
      expect(env.CI).toBe("1");
      expect(env.BROWSER).toBe("none");
      expect(Number(env.EXPO_DEV_SERVER_PORT)).toBeGreaterThanOrEqual(19006);
      expect(Number(env.EXPO_DEV_SERVER_PORT)).toBeLessThan(20006);
      expect(env.RCT_METRO_PORT).toBe(env.EXPO_DEV_SERVER_PORT);
      expect(env.PUSHPALS_VALIDATION_REPO).toBe(repo);
      expect(existsSync(env.HOME)).toBe(true);
      expect(existsSync(env.EXPO_HOME)).toBe(true);
      expect(existsSync(env.npm_config_cache)).toBe(true);
      expect(readFileSync(join(env.HOME, ".gitconfig"), "utf8")).toContain("directory = *");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves Codex auth before redirecting HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const originalHome = join(root, "home");
    const codexHome = join(originalHome, ".codex");
    mkdirSync(repo, { recursive: true });
    mkdirSync(codexHome, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: originalHome,
      });

      expect(env.HOME).not.toBe(originalHome);
      expect(resolve(env.CODEX_HOME ?? "")).toBe(resolve(codexHome));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not override an explicit CODEX_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const explicitCodexHome = join(root, "codex-auth");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        CODEX_HOME: explicitCodexHome,
      });

      expect(env.CODEX_HOME).toBe(explicitCodexHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves explicit Expo validation ports", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        EXPO_DEV_SERVER_PORT: "23001",
        RCT_METRO_PORT: "23002",
      });

      expect(env.EXPO_DEV_SERVER_PORT).toBe("23001");
      expect(env.RCT_METRO_PORT).toBe("23002");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
