import { describe, expect, test } from "bun:test";
import { loadRuntimeOptions } from "../../packages/shared/src/runtime_options";
import { loadPushPalsConfig, type PushPalsConfig } from "../../packages/shared/src/config";

const BASE_CONFIG = loadPushPalsConfig();

function cloneConfig(): PushPalsConfig {
  return JSON.parse(JSON.stringify(BASE_CONFIG)) as PushPalsConfig;
}

describe("loadRuntimeOptions", () => {
  test("CLI flags override env and config values", () => {
    const config = cloneConfig();
    config.server.url = "https://config";
    config.sessionId = "config-session";
    config.authToken = "config-token";

    const env = {
      PUSHPALS_SERVER_URL: "https://env",
      PUSHPALS_SESSION_ID: "env-session",
      PUSHPALS_AUTH_TOKEN: "env-token",
    } satisfies Record<string, string>;

    const options = loadRuntimeOptions({
      argv: ["--server", "https://cli", "--sessionId", "cli-session", "--token", "cli-token"],
      env,
      config,
    });

    expect(options.server).toBe("https://cli");
    expect(options.sessionId).toBe("cli-session");
    expect(options.authToken).toBe("cli-token");
  });

  test("env variables override config defaults when CLI flags are absent", () => {
    const config = cloneConfig();
    config.server.url = "https://config";
    config.sessionId = "config-session";
    config.authToken = "config-token";

    const env = {
      PUSHPALS_SERVER_URL: "https://env",
      PUSHPALS_SESSION_ID: "env-session",
      PUSHPALS_AUTH_TOKEN: " env-token ",
    } satisfies Record<string, string>;

    const options = loadRuntimeOptions({ argv: [], env, config });

    expect(options.server).toBe("https://env");
    expect(options.sessionId).toBe("env-session");
    expect(options.authToken).toBe("env-token");
  });

  test("blank values are ignored for required fields and clear optional ones", () => {
    const config = cloneConfig();
    config.server.url = "https://config";
    config.sessionId = "config-session";
    config.authToken = "config-token";

    const env = {
      PUSHPALS_SERVER_URL: "   ",
      PUSHPALS_SESSION_ID: " ",
      PUSHPALS_AUTH_TOKEN: "\t",
    } satisfies Record<string, string>;

    const options = loadRuntimeOptions({ argv: ["--token", ""], env, config });

    expect(options.server).toBe("https://config");
    expect(options.sessionId).toBeNull();
    expect(options.authToken).toBeNull();
  });

  test("throws on unknown CLI flags", () => {
    const config = cloneConfig();
    expect(() => loadRuntimeOptions({ argv: ["--unknown"], config })).toThrow("Unknown CLI flag");
  });

  test("captures passthrough args following the delimiter", () => {
    const config = cloneConfig();
    config.server.url = "https://config";
    config.sessionId = "config-session";

    const options = loadRuntimeOptions({
      argv: ["--server", "https://cli", "--", "--inspect", "--foo", "bar"],
      config,
    });

    expect(options.server).toBe("https://cli");
    expect(options.passthroughArgs).toEqual(["--inspect", "--foo", "bar"]);
  });

  test("ignored CLI flags can be skipped before validation", () => {
    const config = cloneConfig();

    const options = loadRuntimeOptions({
      argv: ["--inspect", "--foo", "bar", "--server", "https://cli"],
      config,
      ignoredCliFlags: [
        { name: "--inspect" },
        { name: "--foo", valueCount: 1 },
      ],
    });

    expect(options.server).toBe("https://cli");
    expect(options.sessionId).toBe(config.sessionId);
  });
});
