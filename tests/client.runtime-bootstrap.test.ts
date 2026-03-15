import { afterEach, describe, expect, test } from "bun:test";
import { resolvePushPalsWebRuntimeConfig } from "../apps/client/src/lib/runtimeBootstrap";

const originalBootstrap = globalThis.__PUSHPALS_WEB_BOOTSTRAP__;
const originalEnv = {
  EXPO_PUBLIC_PUSHPALS_URL: process.env.EXPO_PUBLIC_PUSHPALS_URL,
  EXPO_PUBLIC_LOCAL_AGENT_URL: process.env.EXPO_PUBLIC_LOCAL_AGENT_URL,
  EXPO_PUBLIC_PUSHPALS_SESSION_ID: process.env.EXPO_PUBLIC_PUSHPALS_SESSION_ID,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  globalThis.__PUSHPALS_WEB_BOOTSTRAP__ = originalBootstrap;
  restoreEnv();
});

describe("client runtime bootstrap", () => {
  test("prefers injected runtime bootstrap over Expo public env", () => {
    process.env.EXPO_PUBLIC_PUSHPALS_URL = "http://localhost:3001";
    process.env.EXPO_PUBLIC_LOCAL_AGENT_URL = "http://localhost:3003";
    process.env.EXPO_PUBLIC_PUSHPALS_SESSION_ID = "env-session";
    globalThis.__PUSHPALS_WEB_BOOTSTRAP__ = {
      serverUrl: "http://127.0.0.1:3901/",
      localAgentUrl: "http://127.0.0.1:3903/",
      sessionId: "cli-session",
      clientId: "cli-monitor-dev",
      clientKind: "cli_monitor",
      clientLabel: "CLI Monitor",
    };

    expect(resolvePushPalsWebRuntimeConfig()).toEqual({
      serverUrl: "http://127.0.0.1:3901",
      localAgentUrl: "http://127.0.0.1:3903",
      sessionId: "cli-session",
      clientId: "cli-monitor-dev",
      clientKind: "cli_monitor",
      clientLabel: "CLI Monitor",
    });
  });

  test("falls back to Expo env and built-in defaults when no bootstrap is present", () => {
    delete process.env.EXPO_PUBLIC_PUSHPALS_URL;
    delete process.env.EXPO_PUBLIC_LOCAL_AGENT_URL;
    delete process.env.EXPO_PUBLIC_PUSHPALS_SESSION_ID;
    globalThis.__PUSHPALS_WEB_BOOTSTRAP__ = undefined;

    expect(resolvePushPalsWebRuntimeConfig()).toEqual({
      serverUrl: "http://127.0.0.1:3001",
      localAgentUrl: "http://127.0.0.1:3003",
      sessionId: "dev",
      clientId: null,
      clientKind: "web",
      clientLabel: "Web Client",
    });
  });

  test("normalizes bootstrap and env endpoints back to loopback", () => {
    process.env.EXPO_PUBLIC_PUSHPALS_URL = "http://192.168.1.40:3001/path";
    process.env.EXPO_PUBLIC_LOCAL_AGENT_URL = "http://pushpals.example:3003/path";
    globalThis.__PUSHPALS_WEB_BOOTSTRAP__ = {
      serverUrl: "http://10.0.0.2:3901/remote",
      localAgentUrl: "http://remote-host:3903/remote",
      sessionId: "cli-session",
    };

    expect(resolvePushPalsWebRuntimeConfig()).toEqual({
      serverUrl: "http://127.0.0.1:3901",
      localAgentUrl: "http://127.0.0.1:3903",
      sessionId: "cli-session",
      clientId: null,
      clientKind: "web",
      clientLabel: "Web Client",
    });
  });
});
