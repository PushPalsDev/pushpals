import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  buildOpenMonitoringHubCommand,
  buildEmbeddedMonitoringHubHtml,
  buildEmbeddedRuntimeEnv,
  buildServiceStopCommand,
  normalizeChildProcessEnv,
  prepareCliRuntime,
  resolveCommandPath,
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
        PUSHPALS_GIT_BIN: "/custom/tools/git",
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
      },
    );

    expect(env.REMOTEBUDDY_AUTONOMY_ENABLED).toBe("true");
    expect(env.PUSHPALS_GIT_BIN).toBe("/custom/tools/git");
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

  test("normalizeChildProcessEnv keeps Windows path and shell variables in both casings", () => {
    const env = normalizeChildProcessEnv(
      {
        Path: "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      "win32",
    );

    expect(env.Path).toBe("C:\\Program Files\\Git\\cmd;C:\\Windows\\System32");
    expect(env.PATH).toBe("C:\\Program Files\\Git\\cmd;C:\\Windows\\System32");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(env.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("resolveCommandPath finds git in the effective runtime environment", async () => {
    const env = normalizeChildProcessEnv(process.env as Record<string, string | undefined>);
    const resolved = await resolveCommandPath("git", process.cwd(), env);
    expect(resolved).not.toBeNull();
    expect(String(resolved).toLowerCase()).toContain("git");
  });

  test("buildOpenMonitoringHubCommand selects the right launcher per platform", () => {
    expect(buildOpenMonitoringHubCommand("http://localhost:8081", "win32")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "http://localhost:8081",
    ]);
    expect(buildOpenMonitoringHubCommand("http://localhost:8081", "darwin")).toEqual([
      "open",
      "http://localhost:8081",
    ]);
    expect(buildOpenMonitoringHubCommand("http://localhost:8081", "linux")).toEqual([
      "xdg-open",
      "http://localhost:8081",
    ]);
  });

  test("buildServiceStopCommand uses taskkill only on Windows", () => {
    expect(buildServiceStopCommand(4321, "win32")).toEqual([
      "taskkill",
      "/PID",
      "4321",
      "/T",
      "/F",
    ]);
    expect(buildServiceStopCommand(4321, "linux")).toBeNull();
    expect(buildServiceStopCommand(undefined, "win32")).toBeNull();
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
