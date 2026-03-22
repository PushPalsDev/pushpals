import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  buildCliClearTargets,
  applyResolvedDockerBinaryToRuntimeEnv,
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
  precheckWorkerpalDockerAvailability,
  precheckSourceControlManagerGitAvailability,
  prepareCliRuntime,
  resolveRuntimeDockerExecutableCandidates,
  resolveRuntimeGitExecutableCandidates,
  resolveCliLocalBuddyAutostart,
  resolveCliStatePath,
  resolveCommandPath,
  resolvePreferredRuntimeReleaseTag,
  resolveWindowsShellExecutableCandidatesForEnv,
  startEmbeddedMonitoringHub,
  waitForWorkerpalCapacity,
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

  test("buildEmbeddedRuntimeEnv preserves explicit docker overrides", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PUSHPALS_DOCKER_BIN: "docker.exe",
        PUSHPALS_DOCKER_BIN_ABSOLUTE:
          "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      },
      {
        repoRoot: "C:/repo/example",
        runtimeRoot: "C:/runtime/pushpals",
      },
    );

    expect(env.PUSHPALS_DOCKER_BIN).toBe("docker.exe");
    expect(env.PUSHPALS_DOCKER_BIN_ABSOLUTE).toBe(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    );
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

  test("applyResolvedDockerBinaryToRuntimeEnv rewrites Windows absolute docker paths into PATH + basename", () => {
    const env = applyResolvedDockerBinaryToRuntimeEnv(
      {
        PATH: "C:\\Windows\\System32",
        Path: "C:\\Windows\\System32",
      },
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "win32",
    );

    expect(env.PUSHPALS_DOCKER_BIN).toBe("docker.exe");
    expect(env.PUSHPALS_DOCKER_BIN_ABSOLUTE).toBe(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    );
    expect(env.PATH).toContain("C:\\Program Files\\Docker\\Docker\\resources\\bin");
    expect(env.Path).toContain("C:\\Program Files\\Docker\\Docker\\resources\\bin");
  });

  test("applyResolvedDockerBinaryToRuntimeEnv clears absolute override when docker is configured by command name", () => {
    const env = applyResolvedDockerBinaryToRuntimeEnv(
      {
        PATH: "/usr/local/bin:/usr/bin",
        PUSHPALS_DOCKER_BIN_ABSOLUTE: "/tmp/old/docker",
      },
      "docker",
      "linux",
    );

    expect(env.PUSHPALS_DOCKER_BIN).toBe("docker");
    expect(env.PUSHPALS_DOCKER_BIN_ABSOLUTE).toBeUndefined();
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  test("resolveRuntimeGitExecutableCandidates keeps basename and absolute fallback for SCM probing", () => {
    expect(
      resolveRuntimeGitExecutableCandidates(
        {
          PUSHPALS_GIT_BIN: "git.exe",
          PUSHPALS_GIT_BIN_ABSOLUTE: "C:\\Program Files\\Git\\cmd\\git.exe",
        },
        "win32",
      ),
    ).toEqual(["git.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "git"]);

    expect(
      resolveRuntimeGitExecutableCandidates(
        {
          PUSHPALS_GIT_BIN: "git",
          PUSHPALS_GIT_BIN_ABSOLUTE: "/usr/local/bin/git",
        },
        "linux",
      ),
    ).toEqual(["git", "/usr/local/bin/git"]);
  });

  test("resolveRuntimeDockerExecutableCandidates keeps basename and absolute fallback for docker probing", () => {
    expect(
      resolveRuntimeDockerExecutableCandidates(
        {
          PUSHPALS_DOCKER_BIN: "docker.exe",
          PUSHPALS_DOCKER_BIN_ABSOLUTE: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        },
        "win32",
      ),
    ).toEqual([
      "docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "docker",
    ]);

    expect(
      resolveRuntimeDockerExecutableCandidates(
        {
          PUSHPALS_DOCKER_BIN: "docker",
          PUSHPALS_DOCKER_BIN_ABSOLUTE: "/usr/local/bin/docker",
        },
        "linux",
      ),
    ).toEqual(["docker", "/usr/local/bin/docker"]);
  });

  test("resolveWindowsShellExecutableCandidatesForEnv prefers ComSpec and SystemRoot fallbacks", () => {
    expect(
      resolveWindowsShellExecutableCandidatesForEnv(
        {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          SYSTEMROOT: "C:\\Windows",
        },
        "win32",
      ),
    ).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\Sysnative\\cmd.exe",
      "cmd.exe",
    ]);
  });

  test("precheckSourceControlManagerGitAvailability skips cleanly when the SCM remote is not configured", async () => {
    const result = await precheckSourceControlManagerGitAvailability({
      repoRoot: "/repo/example",
      remote: "origin",
      runtimeRoot: "/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      baseEnv: {
        PATH: "/usr/bin",
      },
      gitRemoteCheckFn: async () => ({ status: "missing_remote", remote: "origin" }),
      resolveCommandPathFn: async () => {
        throw new Error("resolveCommandPath should not run when remote is missing");
      },
      gitProbeFn: async () => {
        throw new Error("git probe should not run when remote is missing");
      },
      platform: "linux",
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toBe('git remote "origin" is not configured');
  });

  test("precheckSourceControlManagerGitAvailability fails when the SCM remote cannot be inspected", async () => {
    const result = await precheckSourceControlManagerGitAvailability({
      repoRoot: "/repo/example",
      remote: "origin",
      runtimeRoot: "/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      baseEnv: {
        PATH: "/usr/bin",
      },
      gitRemoteCheckFn: async () => ({
        status: "error",
        remote: "origin",
        detail: "spawn git failed: ENOENT",
      }),
      resolveCommandPathFn: async () => {
        throw new Error("resolveCommandPath should not run when remote inspection fails");
      },
      gitProbeFn: async () => {
        throw new Error("git probe should not run when remote inspection fails");
      },
      platform: "linux",
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain('git remote "origin" could not be inspected');
    expect(result.detail).toContain("spawn git failed: ENOENT");
  });

  test("precheckSourceControlManagerGitAvailability fails before startup when SCM git probing fails", async () => {
    const result = await precheckSourceControlManagerGitAvailability({
      repoRoot: "C:\\repo\\example",
      remote: "origin",
      runtimeRoot: "C:\\runtime\\pushpals",
      preflightUsesEmbeddedRuntime: true,
      baseEnv: {
        PATH: "C:\\Windows\\System32",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        SYSTEMROOT: "C:\\Windows",
      },
      gitRemoteCheckFn: async () => ({ status: "ok", remote: "origin" }),
      resolveCommandPathFn: async () => null,
      gitProbeFn: async () => ({
        ok: false,
        detail: "git.exe, C:\\Program Files\\Git\\cmd\\git.exe",
      }),
      platform: "win32",
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toBe("git.exe, C:\\Program Files\\Git\\cmd\\git.exe");
    expect(result.env.PUSHPALS_REPO_ROOT_OVERRIDE).toBe("C:\\repo\\example");
  });

  test("precheckWorkerpalDockerAvailability skips when Docker-backed auto-spawn is not required", async () => {
    const result = await precheckWorkerpalDockerAvailability({
      repoRoot: "/repo/example",
      runtimeRoot: "/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      autoSpawnWorkerpals: false,
      dockerEnabled: true,
      requireDocker: true,
      baseEnv: {
        PATH: "/usr/bin",
      },
      dockerProbeFn: async () => {
        throw new Error("docker probe should not run when auto-spawn is disabled");
      },
      platform: "linux",
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("WorkerPal auto-spawn is disabled");
  });

  test("precheckWorkerpalDockerAvailability fails when required Docker-backed WorkerPal capacity is unavailable", async () => {
    const result = await precheckWorkerpalDockerAvailability({
      repoRoot: "/repo/example",
      runtimeRoot: "/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      baseEnv: {
        PATH: "/usr/bin",
      },
      dockerProbeFn: async () => ({
        ok: false,
        detail: "docker: Cannot connect to the Docker daemon",
      }),
      platform: "linux",
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("Cannot connect to the Docker daemon");
  });

  test("precheckWorkerpalDockerAvailability reports resolved Docker version when available", async () => {
    const result = await precheckWorkerpalDockerAvailability({
      repoRoot: "/repo/example",
      runtimeRoot: "/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      baseEnv: {
        PATH: "/usr/bin",
      },
      dockerProbeFn: async () => ({
        ok: true,
        detail: "docker (26.1.1)",
      }),
      platform: "linux",
    });

    expect(result.status).toBe("ok");
    expect(result.detail).toBe("docker (26.1.1)");
  });

  test("precheckWorkerpalDockerAvailability preserves a resolved docker binary in the returned env", async () => {
    const result = await precheckWorkerpalDockerAvailability({
      repoRoot: "C:\\repo\\example",
      runtimeRoot: "C:\\runtime\\pushpals",
      preflightUsesEmbeddedRuntime: true,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      baseEnv: {
        PATH: "C:\\Windows\\System32",
        Path: "C:\\Windows\\System32",
        PUSHPALS_DOCKER_BIN: "docker.exe",
        PUSHPALS_DOCKER_BIN_ABSOLUTE:
          "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      },
      dockerProbeFn: async (_cwd, env) => ({
        ok: true,
        detail: String(env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? env.PUSHPALS_DOCKER_BIN ?? ""),
      }),
      platform: "win32",
    });

    expect(result.status).toBe("ok");
    expect(result.detail).toBe("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe");
    expect(result.env.PUSHPALS_DOCKER_BIN).toBe("docker.exe");
    expect(result.env.PUSHPALS_DOCKER_BIN_ABSOLUTE).toBe(
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    );
    expect(result.env.PATH).toContain("C:\\Program Files\\Docker\\Docker\\resources\\bin");
  });

  test("waitForWorkerpalCapacity only succeeds when an idle worker is available", async () => {
    let polls = 0;
    const result = await waitForWorkerpalCapacity({
      serverUrl: "http://127.0.0.1:3001",
      timeoutMs: 1_000,
      ttlMs: 60_000,
      fetchWorkersFn: async () => {
        polls += 1;
        if (polls === 1) {
          return [
            {
              workerId: "workerpal-1",
              isOnline: true,
              activeJobCount: 1,
              status: "online",
              lastSeenAt: new Date().toISOString(),
            },
          ];
        }
        return [
          {
            workerId: "workerpal-1",
            isOnline: true,
            activeJobCount: 0,
            status: "online",
            lastSeenAt: new Date().toISOString(),
          },
        ];
      },
      sleepFn: async () => {},
    });

    expect(result).toEqual({
      ok: true,
      detail: "1 idle / 1 online",
    });
  });

  test("waitForWorkerpalCapacity fails when workers stay online but busy", async () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const result = await waitForWorkerpalCapacity({
        serverUrl: "http://127.0.0.1:3001",
        timeoutMs: 1_000,
        ttlMs: 60_000,
        fetchWorkersFn: async () => [
          {
            workerId: "workerpal-1",
            isOnline: true,
            activeJobCount: 2,
            status: "online",
            lastSeenAt: new Date().toISOString(),
          },
        ],
        sleepFn: async () => {
          now += 1_000;
        },
      });

      expect(result).toEqual({
        ok: false,
        detail: "1 online WorkerPal(s) reported but none became idle within 1000ms",
      });
    } finally {
      Date.now = originalNow;
    }
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

  test("resolvePreferredRuntimeReleaseTag prefers the installed CLI package version before GitHub latest", () => {
    expect(
      resolvePreferredRuntimeReleaseTag(undefined, {
        PUSHPALS_CLI_PACKAGE_VERSION: "1.0.16",
      }),
    ).toBe("v1.0.16");
    expect(
      resolvePreferredRuntimeReleaseTag(undefined, {
        PUSHPALS_RUNTIME_TAG: "vcustom-runtime",
        PUSHPALS_CLI_PACKAGE_VERSION: "1.0.16",
      }),
    ).toBe("vcustom-runtime");
    expect(
      resolvePreferredRuntimeReleaseTag("vexplicit", {
        PUSHPALS_RUNTIME_TAG: "vignored",
        PUSHPALS_CLI_PACKAGE_VERSION: "1.0.16",
      }),
    ).toBe("vexplicit");
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

  test("buildCliClearTargets removes repo-local runtime state without targeting the repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-clear-targets-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");
    const gitDir = join(repoRoot, ".git");

    try {
      mkdirSync(join(repoRoot, "outputs", "data"), { recursive: true });
      mkdirSync(join(repoRoot, ".worktrees", "source_control_manager"), { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "pushpals-cli-state.json"), "{}\n", "utf8");
      writeFileSync(join(gitDir, "pushpals-client-state.json"), "{}\n", "utf8");

      const targets = buildCliClearTargets({
        repoRoot,
        runtimeRoot,
        cliStatePath: join(gitDir, "pushpals-cli-state.json"),
        config: {
          paths: {
            dataDir: join(repoRoot, "outputs", "data"),
          },
          sourceControlManager: {
            repoPath: join(repoRoot, ".worktrees", "source_control_manager"),
            stateDir: join(repoRoot, "outputs", "data", "source_control_manager"),
          },
        } as any,
      });

      expect(targets).toEqual([
        { label: "runtime data", path: join(repoRoot, "outputs", "data") },
        {
          label: "SourceControlManager worktree",
          path: join(repoRoot, ".worktrees", "source_control_manager"),
        },
        { label: "CLI state file", path: join(gitDir, "pushpals-cli-state.json") },
        {
          label: "client monitor state file",
          path: join(gitDir, "pushpals-client-state.json"),
        },
        {
          label: "runtime bootstrap logs",
          path: join(runtimeRoot, "logs", "bootstrap"),
        },
      ]);
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
