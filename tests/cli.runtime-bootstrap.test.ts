import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  applyResolvedGitBinaryToRuntimeEnv,
  buildOpenMonitoringHubCommand,
  buildEmbeddedRuntimeEnv,
  buildRuntimeServiceLogPaths,
  bundledMonitoringHubNeedsRefresh,
  buildServiceStopCommand,
  extractRemoteBuddyAutonomousEngineState,
  extractRemoteBuddySessionConsumerHealth,
  formatTimestampedCliLine,
  formatSessionEventLine,
  injectMonitoringHubBootstrap,
  isCliExitCommand,
  normalizeCliInteractiveMessage,
  normalizeChildProcessEnv,
  normalizeRepoPathForComparison,
  prepareCliRuntime,
  resolveCliLocalBuddyAutostart,
  resolveCliStatePath,
  resolveCommandPath,
  startEmbeddedMonitoringHub,
} from "../scripts/pushpals-cli.ts";

function createMonitorAssetFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const assetRoot = join(root, "monitor-ui");
  mkdirSync(join(assetRoot, "_expo", "static", "js", "web"), { recursive: true });
  writeFileSync(
    join(assetRoot, "index.html"),
    '<!doctype html><html><head><title>Client Hub</title></head><body><div id="root"></div><script src="/_expo/static/js/web/app.js" defer></script></body></html>',
    "utf8",
  );
  writeFileSync(
    join(assetRoot, "_expo", "static", "js", "web", "app.js"),
    "globalThis.__TEST_MONITOR__ = true;\n",
    "utf8",
  );
  return { root, assetRoot };
}

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
    expect("LOCALBUDDY_ENABLED" in env).toBe(false);
  });

  test("buildEmbeddedRuntimeEnv can force a shared runtime session id for embedded services", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
        sessionId: "cli-dev",
      },
    );

    expect(env.PUSHPALS_SESSION_ID).toBe("cli-dev");
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

  test("buildEmbeddedRuntimeEnv preserves explicit LocalBuddy env overrides without forcing them", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
        LOCALBUDDY_ENABLED: "1",
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
      },
    );

    expect(env.LOCALBUDDY_ENABLED).toBe("1");
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
    expect(env.PUSHPALS_PROTOCOL_SCHEMAS_DIR).toBe(
      join("/runtime/pushpals", "protocol", "schemas"),
    );
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

  test("applyResolvedGitBinaryToRuntimeEnv rewrites Windows absolute git paths into PATH + basename", () => {
    const env = applyResolvedGitBinaryToRuntimeEnv(
      {
        PATH: "C:\\Windows\\System32",
        Path: "C:\\Windows\\System32",
      },
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "win32",
    );

    expect(env.PUSHPALS_GIT_BIN).toBe("git.exe");
    expect(env.PUSHPALS_GIT_BIN_ABSOLUTE).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(env.PATH).toContain("C:\\Program Files\\Git\\cmd");
    expect(env.Path).toContain("C:\\Program Files\\Git\\cmd");
  });

  test("applyResolvedGitBinaryToRuntimeEnv rewrites Unix absolute git paths into PATH + basename", () => {
    const env = applyResolvedGitBinaryToRuntimeEnv(
      {
        PATH: "/usr/local/bin:/usr/bin",
      },
      "/opt/homebrew/bin/git",
      "darwin",
    );

    expect(env.PUSHPALS_GIT_BIN).toBe("git");
    expect(env.PUSHPALS_GIT_BIN_ABSOLUTE).toBe("/opt/homebrew/bin/git");
    expect(env.PATH).toContain("/opt/homebrew/bin");
    expect(env.Path).toBeUndefined();
  });

  test("applyResolvedGitBinaryToRuntimeEnv clears absolute override when git is configured by command name", () => {
    const env = applyResolvedGitBinaryToRuntimeEnv(
      {
        PATH: "/usr/local/bin:/usr/bin",
        PUSHPALS_GIT_BIN_ABSOLUTE: "/tmp/old/git",
      },
      "git",
      "linux",
    );

    expect(env.PUSHPALS_GIT_BIN).toBe("git");
    expect(env.PUSHPALS_GIT_BIN_ABSOLUTE).toBeUndefined();
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  test("buildRuntimeServiceLogPaths returns deterministic per-service paths", () => {
    const logDir = join(tmpdir(), "pushpals-cli-runtime-logs");
    const paths = buildRuntimeServiceLogPaths(logDir, "2026-03-17T00-00-00-000Z");
    expect(paths.server).toBe(join(logDir, "2026-03-17T00-00-00-000Z-server.log"));
    expect(paths.localbuddy).toBe(join(logDir, "2026-03-17T00-00-00-000Z-localbuddy.log"));
    expect(paths.remotebuddy).toBe(join(logDir, "2026-03-17T00-00-00-000Z-remotebuddy.log"));
    expect(paths.source_control_manager).toBe(
      join(logDir, "2026-03-17T00-00-00-000Z-source_control_manager.log"),
    );
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

  test("isCliExitCommand treats bare exit aliases as local shutdown commands", () => {
    expect(isCliExitCommand("/exit")).toBe(true);
    expect(isCliExitCommand("/quit")).toBe(true);
    expect(isCliExitCommand("exit")).toBe(true);
    expect(isCliExitCommand(" Quit ")).toBe(true);
    expect(isCliExitCommand("please exit this task")).toBe(false);
    expect(isCliExitCommand("/status")).toBe(false);
  });

  test("formatTimestampedCliLine prepends an ISO timestamp for CLI-scoped logs only", () => {
    const at = new Date("2026-03-14T05:13:05.835Z");
    expect(formatTimestampedCliLine("[pushpals] runtimeTag=v1.0.9", at)).toBe(
      "[2026-03-14T05:13:05.835Z][pushpals] runtimeTag=v1.0.9",
    );
    expect(formatTimestampedCliLine("[localbuddy] Responded locally", at)).toBe(
      "[2026-03-14T05:13:05.835Z][localbuddy] Responded locally",
    );
    expect(formatTimestampedCliLine("PushPals CLI", at)).toBe("PushPals CLI");
  });

  test("formatSessionEventLine suppresses repetitive heartbeat status events", () => {
    expect(
      formatSessionEventLine({
        id: "evt-heartbeat",
        type: "status",
        from: "agent:localbuddy-1",
        ts: new Date().toISOString(),
        payload: {
          state: "idle",
          detail: "LocalBuddy heartbeat",
        },
      }),
    ).toBeNull();

    expect(
      formatSessionEventLine({
        id: "evt-status",
        type: "status",
        from: "agent:localbuddy-1",
        ts: new Date().toISOString(),
        payload: {
          state: "busy",
          detail: "LocalBuddy evaluating request",
        },
      }),
    ).toBe("[status agent:localbuddy-1] busy - LocalBuddy evaluating request");
  });

  test("normalizeCliInteractiveMessage treats /ask_remote_buddy as a compatibility alias", () => {
    expect(normalizeCliInteractiveMessage("fix the dashboard")).toEqual({
      text: "fix the dashboard",
    });
    expect(normalizeCliInteractiveMessage("/ask_remote_buddy fix the dashboard")).toEqual({
      text: "fix the dashboard",
    });
    expect(normalizeCliInteractiveMessage("/ask_remote_buddy: fix the dashboard")).toEqual({
      text: "fix the dashboard",
    });
    expect(normalizeCliInteractiveMessage("/ask_remote_buddy")).toEqual({
      text: "",
      usageMessage:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    });
  });

  test("resolveCliLocalBuddyAutostart disables LocalBuddy for interactive CLI but honors runtime-only config", () => {
    expect(resolveCliLocalBuddyAutostart(false, false)).toBe(false);
    expect(resolveCliLocalBuddyAutostart(false, true)).toBe(false);
    expect(resolveCliLocalBuddyAutostart(true, false)).toBe(false);
    expect(resolveCliLocalBuddyAutostart(true, true)).toBe(true);
  });

  test("normalizeRepoPathForComparison compares repo roots safely across path casings and separators", () => {
    expect(normalizeRepoPathForComparison("C:\\Repo\\Demo\\")).toBe(
      normalizeRepoPathForComparison("C:/Repo/Demo"),
    );
  });

  test("resolveCliStatePath follows worktree gitdir metadata instead of assuming .git is a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-worktree-state-"));
    const metadataDir = join(root, "gitdir-store", "worktrees", "demo");
    mkdirSync(metadataDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadataDir}\n`, "utf8");

    try {
      expect(resolveCliStatePath(root)).toBe(join(metadataDir, "pushpals-cli-state.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("extractRemoteBuddySessionConsumerHealth recognizes the production RemoteBuddy agent identity", () => {
    expect(
      extractRemoteBuddySessionConsumerHealth(
        {
          clients: {
            items: [
              {
                clientId: "remotebuddy-orchestrator",
                label: "agent:remotebuddy-orchestrator",
                sessionId: "dev",
                status: "connected",
              },
            ],
          },
        },
        "dev",
      ),
    ).toMatchObject({
      ok: true,
      clientId: "remotebuddy-orchestrator",
    });

    expect(
      extractRemoteBuddySessionConsumerHealth(
        {
          clients: {
            items: [
              {
                clientId: "remotebuddy-orchestrator",
                label: "agent:remotebuddy-orchestrator",
                sessionId: "dev",
                status: "announced",
              },
            ],
          },
        },
        "dev",
      ),
    ).toMatchObject({
      ok: false,
    });
  });

  test("extractRemoteBuddyAutonomousEngineState parses enabled/disabled markers from runtime logs", () => {
    expect(
      extractRemoteBuddyAutonomousEngineState(
        "[stdout] [RemoteBuddy] Autonomous engine: enabled tick=300000ms",
      ),
    ).toBe("enabled");
    expect(
      extractRemoteBuddyAutonomousEngineState(
        "[stdout] [RemoteBuddy] Autonomous engine: disabled tick=300000ms",
      ),
    ).toBe("disabled");
    expect(extractRemoteBuddyAutonomousEngineState("")).toBe("unknown");
  });

  test("bundledMonitoringHubNeedsRefresh detects stale exported monitor assets", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-monitor-refresh-"));
    const sourceRoot = join(root, "repo");
    const bundleRoot = join(sourceRoot, "packages", "cli", "monitor-ui");
    const sourceFile = join(sourceRoot, "apps", "client", "src", "index.ts");
    const sharedFile = join(sourceRoot, "packages", "shared", "src", "index.ts");
    const exportScript = join(sourceRoot, "scripts", "sync-cli-monitor-ui.ts");
    const bundleFile = join(bundleRoot, "index.html");

    try {
      mkdirSync(join(bundleRoot, "_expo"), { recursive: true });
      mkdirSync(dirname(sourceFile), { recursive: true });
      mkdirSync(dirname(sharedFile), { recursive: true });
      mkdirSync(dirname(exportScript), { recursive: true });
      writeFileSync(sourceFile, "export {};\n", "utf8");
      writeFileSync(sharedFile, "export {};\n", "utf8");
      writeFileSync(exportScript, "// export monitor\n", "utf8");
      writeFileSync(bundleFile, "<!doctype html><html></html>\n", "utf8");

      const now = new Date();
      const stale = new Date(now.getTime() - 60_000);
      const fresh = new Date(now.getTime() + 60_000);
      utimesSync(bundleRoot, stale, stale);
      utimesSync(bundleFile, stale, stale);
      utimesSync(sourceFile, fresh, fresh);

      expect(bundledMonitoringHubNeedsRefresh(bundleRoot, sourceRoot)).toBe(true);

      utimesSync(bundleRoot, fresh, fresh);
      utimesSync(bundleFile, fresh, fresh);
      expect(bundledMonitoringHubNeedsRefresh(bundleRoot, sourceRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("injectMonitoringHubBootstrap writes runtime config into exported client html", () => {
    const html = injectMonitoringHubBootstrap(
      '<html><head></head><body><div id="root"></div></body></html>',
      {
        serverUrl: "http://localhost:3001",
        sessionId: "dev",
        clientId: "cli-monitor-dev",
        clientKind: "cli_monitor",
        clientLabel: "CLI Monitor",
      },
    );

    expect(html).toContain("__PUSHPALS_WEB_BOOTSTRAP__");
    expect(html).toContain('"serverUrl":"http://localhost:3001"');
    expect(html).toContain('"sessionId":"dev"');
    expect(html).toContain('"clientId":"cli-monitor-dev"');
    expect(html).toContain('"clientKind":"cli_monitor"');
    expect(html).toContain('"clientLabel":"CLI Monitor"');
  });

  test("startEmbeddedMonitoringHub returns null when packaged monitor assets are unavailable", async () => {
    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      sessionId: "dev",
      preferredPort: 18981,
      assetRoot: join(resolve(process.cwd(), "tmp-cli-monitor-missing"), "missing"),
    });

    expect(hub).toBeNull();
  });

  test("startEmbeddedMonitoringHub serves the exported client monitor when packaged assets exist", async () => {
    const { root, assetRoot } = createMonitorAssetFixture("pushpals-cli-monitor-ui-");

    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      sessionId: "dev",
      preferredPort: 18982,
      assetRoot,
    });

    try {
      expect(hub).not.toBeNull();
      if (!hub) return;

      const [rootResponse, assetResponse, routeResponse] = await Promise.all([
        fetch(`${hub.url}/`),
        fetch(`${hub.url}/_expo/static/js/web/app.js`),
        fetch(`${hub.url}/jobs/traces`),
      ]);

      const rootHtml = await rootResponse.text();
      expect(rootResponse.ok).toBe(true);
      expect(rootHtml).toContain("Client Hub");
      expect(rootHtml).toContain("__PUSHPALS_WEB_BOOTSTRAP__");
      expect(assetResponse.ok).toBe(true);
      expect(await assetResponse.text()).toContain("__TEST_MONITOR__");
      expect(routeResponse.ok).toBe(true);
      expect(await routeResponse.text()).toContain("Client Hub");
    } finally {
      hub?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startEmbeddedMonitoringHub falls back when the preferred port is occupied", async () => {
    const { root, assetRoot } = createMonitorAssetFixture("pushpals-cli-monitor-port-fallback-");
    const blocker = Bun.serve({
      port: 18983,
      fetch: () => new Response("blocked"),
    });
    const blockedPort = Number(blocker.port);

    const hub = await startEmbeddedMonitoringHub({
      serverUrl: "http://127.0.0.1:3001",
      sessionId: "dev",
      preferredPort: blockedPort,
      assetRoot,
    });

    try {
      expect(hub).not.toBeNull();
      if (!hub) return;
      expect(hub.port).not.toBe(blockedPort);
    } finally {
      hub?.stop();
      blocker.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(
    "prepareCliRuntime seeds external runtime locally without network fetch",
    async () => {
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
    },
    15000,
  );
});
