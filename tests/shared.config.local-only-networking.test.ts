import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "../packages/shared/src/config";

const envKeys = ["PUSHPALS_SERVER_URL", "PUSHPALS_HOST", "EXPO_PUBLIC_LOCAL_AGENT_URL"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
  (typeof envKeys)[number],
  string | undefined
>;

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function createConfigRoot(defaultToml: string): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-local-only-config-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "default.toml"), defaultToml, "utf8");
  writeFileSync(join(configDir, "local.example.toml"), "", "utf8");
  return root;
}

describe("shared config local-only networking", () => {
  test("coerces server and local agent endpoints to loopback", () => {
    const root = createConfigRoot(
      [
        'profile = "dev"',
        "",
        "[server]",
        'url = "http://10.0.0.8:3001"',
        'host = "0.0.0.0"',
        "port = 3001",
        "",
        "[client]",
        'local_agent_url = "http://example.com:3003"',
      ].join("\n"),
    );

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.server.host).toBe("127.0.0.1");
      expect(cfg.server.url).toBe("http://127.0.0.1:3001");
      expect(cfg.client.localAgentUrl).toBe("http://127.0.0.1:3003");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("coerces env overrides for server and local agent endpoints to loopback", () => {
    const root = createConfigRoot(['profile = "dev"', "", "[server]", "port = 3551"].join("\n"));
    process.env.PUSHPALS_SERVER_URL = "http://192.168.1.80:4551";
    process.env.PUSHPALS_HOST = "0.0.0.0";
    process.env.EXPO_PUBLIC_LOCAL_AGENT_URL = "http://pushpals.example:4999";

    try {
      const cfg = loadPushPalsConfig({ projectRoot: root, reload: true });
      expect(cfg.server.host).toBe("127.0.0.1");
      expect(cfg.server.url).toBe("http://127.0.0.1:4551");
      expect(cfg.client.localAgentUrl).toBe("http://127.0.0.1:4999");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
