import { describe, expect, test } from "bun:test";
import {
  loadRemoteBuddyRuntime,
  type RemoteBuddyRuntimeOptions,
} from "./runtime";

type RuntimeConfig = NonNullable<RemoteBuddyRuntimeOptions["config"]>;

function buildConfig(overrides: {
  server?: string;
  sessionId?: string;
  authToken?: string | null;
} = {}): RuntimeConfig {
  return {
    server: {
      url: overrides.server ?? "http://config-default",
      host: "localhost",
      port: 3001,
      debugHttp: false,
      staleClaimTtlMs: 0,
      staleClaimSweepIntervalMs: 0,
    },
    sessionId: overrides.sessionId ?? "config-session",
    authToken:
      overrides.authToken !== undefined ? overrides.authToken : "config-token",
  } as RuntimeConfig;
}

describe("loadRemoteBuddyRuntime", () => {
  test("uses config defaults when no overrides are supplied", () => {
    const config = buildConfig({
      server: "http://config-default",
      sessionId: "config-session",
      authToken: "config-token",
    });

    const runtime = loadRemoteBuddyRuntime({
      config,
      args: [],
      env: {},
    });

    expect(runtime.config).toBe(config);
    expect(runtime.serverUrl).toBe("http://config-default");
    expect(runtime.sessionId).toBe("config-session");
    expect(runtime.authToken).toBe("config-token");
  });

  test("prefers CLI overrides over env and config", () => {
    const config = buildConfig({
      server: "http://config-default",
      sessionId: "config-session",
      authToken: "config-token",
    });

    const runtime = loadRemoteBuddyRuntime({
      config,
      args: [
        "--server",
        "http://cli-server",
        "--sessionId",
        "cli-session",
        "--token",
        "cli-token",
      ],
      env: {
        PUSHPALS_SERVER_URL: "http://env-server",
        PUSHPALS_SESSION_ID: "env-session",
        PUSHPALS_AUTH_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(runtime.serverUrl).toBe("http://cli-server");
    expect(runtime.sessionId).toBe("cli-session");
    expect(runtime.authToken).toBe("cli-token");
  });

  test("falls back to env values when CLI overrides are missing", () => {
    const config = buildConfig({
      server: "http://config-default",
      sessionId: "config-session",
      authToken: null,
    });

    const runtime = loadRemoteBuddyRuntime({
      config,
      args: [],
      env: {
        PUSHPALS_SERVER_URL: " http://env-server ",
        PUSHPALS_SESSION_ID: " env-session ",
        PUSHPALS_AUTH_TOKEN: " env-token ",
      } as NodeJS.ProcessEnv,
    });

    expect(runtime.serverUrl).toBe("http://env-server");
    expect(runtime.sessionId).toBe("env-session");
    expect(runtime.authToken).toBe("env-token");
  });

  test("ignores blank env values and keeps config defaults", () => {
    const config = buildConfig({
      server: "http://config-default",
      sessionId: "config-session",
      authToken: null,
    });

    const runtime = loadRemoteBuddyRuntime({
      config,
      args: [],
      env: {
        PUSHPALS_SERVER_URL: "   ",
        PUSHPALS_SESSION_ID: "",
        PUSHPALS_AUTH_TOKEN: "",
      } as NodeJS.ProcessEnv,
    });

    expect(runtime.serverUrl).toBe("http://config-default");
    expect(runtime.sessionId).toBe("config-session");
    expect(runtime.authToken).toBeNull();
  });
});
