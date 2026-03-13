import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import {
  buildEmbeddedMonitoringHubHtml,
  buildEmbeddedRuntimeEnv,
  startEmbeddedMonitoringHub,
} from "../scripts/pushpals-cli.ts";

describe("pushpals CLI runtime bootstrap helpers", () => {
  test("buildEmbeddedRuntimeEnv injects repo/config/schema overrides and disables autonomy by default", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "C:/repo/example",
        runtimeRoot: "C:/runtime/pushpals",
      },
    );

    expect(env.PUSHPALS_PROJECT_ROOT_OVERRIDE).toBe("C:/repo/example");
    expect(env.PUSHPALS_REPO_ROOT_OVERRIDE).toBe("C:/repo/example");
    expect(env.PUSHPALS_CONFIG_DIR_OVERRIDE).toBe(resolve("C:/runtime/pushpals", "configs"));
    expect(env.PUSHPALS_PROMPTS_ROOT_OVERRIDE).toBe("C:/runtime/pushpals");
    expect(env.PUSHPALS_PROTOCOL_SCHEMAS_DIR).toBe(
      join(resolve("C:/runtime/pushpals"), "protocol", "schemas"),
    );
    expect(env.REMOTEBUDDY_AUTONOMY_ENABLED).toBe("false");
  });

  test("buildEmbeddedRuntimeEnv preserves explicit autonomy override", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        REMOTEBUDDY_AUTONOMY_ENABLED: "true",
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
      },
    );

    expect(env.REMOTEBUDDY_AUTONOMY_ENABLED).toBe("true");
  });

  test("buildEmbeddedMonitoringHubHtml renders monitor shell with server/session bootstrap", () => {
    const html = buildEmbeddedMonitoringHubHtml({
      serverUrl: "http://localhost:3001",
      localAgentUrl: "http://localhost:3003",
      sessionId: "dev",
    });

    expect(html).toContain("PushPals CLI Monitor");
    expect(html).toContain("Lightweight embedded monitor for CLI-managed runtimes.");
    expect(html).toContain("http://localhost:3001");
    expect(html).toContain("http://localhost:3003");
    expect(html).toContain("\"sessionId\":\"dev\"");
    expect(html).toContain("/api/status");
    expect(html).toContain("/api/jobs");
  });

  test("startEmbeddedMonitoringHub serves the monitor shell and health endpoint", async () => {
    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      localAgentUrl: "http://127.0.0.1:3003",
      sessionId: "dev",
      authToken: null,
      preferredPort: 18981,
    });

    expect(hub).not.toBeNull();
    if (!hub) return;

    try {
      const [rootResponse, healthResponse] = await Promise.all([
        fetch(`${hub.url}/`),
        fetch(`${hub.url}/healthz`),
      ]);

      expect(rootResponse.ok).toBe(true);
      expect(await rootResponse.text()).toContain("PushPals CLI Monitor");
      expect(healthResponse.ok).toBe(true);
      expect(await healthResponse.json()).toMatchObject({ ok: true, sessionId: "dev" });
    } finally {
      hub.stop();
    }
  });

  test("startEmbeddedMonitoringHub falls back when the preferred port is occupied", async () => {
    const blocker = Bun.serve({
      port: 18982,
      fetch: () => new Response("blocked"),
    });

    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      localAgentUrl: "http://127.0.0.1:3003",
      sessionId: "dev",
      authToken: null,
      preferredPort: 18982,
    });

    try {
      expect(hub).not.toBeNull();
      if (!hub) return;
      expect(hub.port).not.toBe(18982);
      const healthResponse = await fetch(`${hub.url}/healthz`);
      expect(healthResponse.ok).toBe(true);
    } finally {
      hub?.stop();
      blocker.stop(true);
    }
  });
});
