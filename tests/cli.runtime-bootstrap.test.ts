import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  buildEmbeddedMonitoringHubHtml,
  buildEmbeddedRuntimeEnv,
  prepareCliRuntime,
  startEmbeddedMonitoringHub,
} from "../scripts/pushpals-cli.ts";

describe("pushpals CLI runtime bootstrap helpers", () => {
  test("buildEmbeddedRuntimeEnv injects repo/config/schema overrides without forcing autonomy off", () => {
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
    expect("REMOTEBUDDY_AUTONOMY_ENABLED" in env).toBe(false);
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

  test("buildEmbeddedRuntimeEnv can target repo config instead of embedded runtime config", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
        useRuntimeConfig: false,
      },
    );

    expect(env.PUSHPALS_PROJECT_ROOT_OVERRIDE).toBe("/repo/example");
    expect(env.PUSHPALS_PROMPTS_ROOT_OVERRIDE).toBe("/repo/example");
    expect("PUSHPALS_CONFIG_DIR_OVERRIDE" in env).toBe(false);
    expect(env.PUSHPALS_PROTOCOL_SCHEMAS_DIR).toBe(join("/runtime/pushpals", "protocol", "schemas"));
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
      port: 0,
      fetch: () => new Response("blocked"),
    });
    const blockedPort = Number(blocker.port);

    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      localAgentUrl: "http://127.0.0.1:3003",
      sessionId: "dev",
      authToken: null,
      preferredPort: blockedPort,
    });

    try {
      expect(hub).not.toBeNull();
      if (!hub) return;
      expect(hub.port).not.toBe(blockedPort);
      const healthResponse = await fetch(`${hub.url}/healthz`);
      expect(healthResponse.ok).toBe(true);
    } finally {
      hub?.stop();
      blocker.stop(true);
    }
  });

  test("prepareCliRuntime seeds external runtime locally without network fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-runtime-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      throw new Error(`unexpected fetch: ${String(args[0])}`);
    }) as typeof fetch;

    try {
      const prepared = await prepareCliRuntime({ repoRoot, runtimeRoot });

      expect(fetchCalls).toBe(0);
      expect(prepared.preflightUsesEmbeddedRuntime).toBe(true);
      expect(prepared.runtimeTag).toBe("");
      expect(prepared.runtimePreflight.issues.map((issue) => issue.code)).toEqual([
        "missing_vision_doc",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
