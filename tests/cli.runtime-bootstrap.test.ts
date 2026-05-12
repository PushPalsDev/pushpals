import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  buildCliClearTargets,
  applyResolvedDockerBinaryToRuntimeEnv,
  applyResolvedGitBinaryToRuntimeEnv,
  buildOpenMonitoringHubCommand,
  cleanupLocalWorkerpalSandboxImage,
  createSessionEventReplayFilter,
  cleanupLingeringPushPalsGitWorktrees,
  cleanupLingeringWorkerpalWarmContainers,
  buildEmbeddedRuntimeEnv,
  copyTrackedRepoPath,
  buildWorkerpalSandboxPaths,
  buildRuntimeServiceLogPaths,
  bundledMonitoringHubNeedsRefresh,
  buildServiceStopCommand,
  downloadRuntimeAssetsFromSourceTag,
  ensureRuntimeBinaries,
  ensureWorkerpalDockerImageReady,
  extractRemoteBuddyAutonomousEngineState,
  extractRemoteBuddySessionConsumerHealth,
  formatRuntimeStartupTimingSummary,
  formatWorkerExecutionReadinessLines,
  formatTimestampedCliLine,
  formatSessionEventLine,
  injectMonitoringHubBootstrap,
  isDockerCleanupTimeoutDetail,
  isDockerUnavailableDetail,
  isCliExitCommand,
  normalizeCliInteractiveMessage,
  normalizeChildProcessEnv,
  normalizeRepoPathForComparison,
  prepareEmbeddedWorkerpalDockerImageIfNeeded,
  precheckWorkerpalDockerAvailability,
  precheckSourceControlManagerGitAvailability,
  prepareCliRuntime,
  resolveEmbeddedBunExecutableFromEnv,
  resolveRuntimeDockerExecutableCandidates,
  resolveRuntimeGitExecutableCandidates,
  resolveCliLocalBuddyAutostart,
  resolveWorkerExecutionReadiness,
  resolveCliStatePath,
  resolveCommandPath,
  repoLooksLikePushPalsSourceCheckout,
  shutdownEmbeddedServiceManagerGracefully,
  shouldRunEmbeddedRuntimeStartupPrechecks,
  resolvePreferredRuntimeReleaseTag,
  resolveWindowsShellExecutableCandidatesForEnv,
  resolveWorkerpalDockerProbe,
  startEmbeddedMonitoringHub,
  waitForWorkerpalCapacity,
} from "../scripts/pushpals-cli.ts";
import {
  ServiceManager,
  computeServiceRestartBackoffMs,
  formatEmbeddedRuntimeHealthLines,
  shouldRestartService,
} from "../scripts/start_runtime_services.ts";

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

const testOnUnix = process.platform === "win32" ? test.skip : test;

function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isFinite(pid ?? Number.NaN) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
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
    expect(env.PUSHPALS_WORKERPALS_SANDBOX_ROOT).toBe(
      join(resolve("C:/runtime/pushpals"), "sandbox"),
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

  test("buildEmbeddedRuntimeEnv preserves the embedded runtime tag for child services", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
        runtimeTag: "v1.0.19",
      },
    );

    expect(env.PUSHPALS_RUNTIME_TAG).toBe("v1.0.19");
  });

  test("buildEmbeddedRuntimeEnv propagates the current Bun executable for embedded runtime services", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
      },
    );

    expect(env.PUSHPALS_BUN_BIN).toBe(process.execPath);
  });

  test("computeServiceRestartBackoffMs uses exponential backoff and clamps to max", () => {
    expect(computeServiceRestartBackoffMs(0)).toBe(2_000);
    expect(computeServiceRestartBackoffMs(-3)).toBe(2_000);
    expect(computeServiceRestartBackoffMs(1)).toBe(2_000);
    expect(computeServiceRestartBackoffMs(2)).toBe(4_000);
    expect(computeServiceRestartBackoffMs(3)).toBe(8_000);
    expect(computeServiceRestartBackoffMs(10)).toBe(30_000);
  });

  test("shouldRestartService enforces max restart attempts", () => {
    expect(shouldRestartService(0)).toBe(true);
    expect(shouldRestartService(3)).toBe(true);
    expect(shouldRestartService(4)).toBe(false);
    expect(shouldRestartService(1, 2)).toBe(true);
    expect(shouldRestartService(2, 2)).toBe(false);
    expect(shouldRestartService(-1, 2)).toBe(true);
    expect(shouldRestartService(1.9, 2)).toBe(true);
    expect(shouldRestartService(2.1, 2)).toBe(false);
  });

  test("formatEmbeddedRuntimeHealthLines renders degraded state with action", () => {
    expect(
      formatEmbeddedRuntimeHealthLines({
        state: "degraded",
        detail: "source_control_manager: reached restart limit",
        action: "Restart pushpals after fixing the runtime failure.",
      }),
    ).toEqual([
      "[pushpals] embeddedRuntime=degraded detail=source_control_manager: reached restart limit",
      "[pushpals] embeddedRuntimeAction=Restart pushpals after fixing the runtime failure.",
    ]);
  });

  test("ServiceManager reports degraded runtime health after restart exhaustion", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-supervisor-degraded-"));
    try {
      const runtimeServicesLogPath = join(root, "runtime-services.log");
      const serviceLogPath = join(root, "source-control-manager.log");
      writeFileSync(runtimeServicesLogPath, "", "utf8");
      writeFileSync(serviceLogPath, "", "utf8");

      let spawnCalls = 0;
      const supervisor = new ServiceManager({
        pollMs: 50,
        maxRestartAttempts: 1,
        computeRestartBackoffMs: () => 50,
        degradedAction: "Inspect the embedded service log or restart pushpals after fixing the runtime failure.",
        spawnService: (spec) => {
          spawnCalls += 1;
          return {
            name: spec.name,
            proc: {} as any,
            command: [...spec.command],
            cwd: spec.cwd,
            env: { ...(spec.env ?? {}) },
            logPath: serviceLogPath,
            exited: true,
            exitCode: spawnCalls === 1 ? 23 : 99,
            launchedAtMs: Date.now(),
          };
        },
        onEvent: (level, line) => {
          appendFileSync(runtimeServicesLogPath, `[${level}] ${line}\n`, "utf8");
        },
        onHealthChange: (health) => {
          for (const line of formatEmbeddedRuntimeHealthLines(health)) {
            appendFileSync(runtimeServicesLogPath, `${line}\n`, "utf8");
          }
        },
      });
      supervisor.startService({
        name: "source_control_manager",
        color: "",
        command: ["fake-scm"],
        cwd: root,
        env: {},
        logPath: serviceLogPath,
      });

      try {
        await Bun.sleep(220);
        const health = supervisor.getHealth();
        expect(spawnCalls).toBe(2);
        expect(health?.state).toBe("degraded");
        expect(health?.detail).toContain("source_control_manager");
        expect(health?.detail).toContain("reached restart limit");
        expect(health?.action).toContain("Inspect the embedded service log");
        const logText = readFileSync(runtimeServicesLogPath, "utf8");
        expect(logText).toContain("[pushpals] embeddedRuntime=degraded detail=");
      } finally {
        supervisor.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ServiceManager stop cancels pending restart timers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-supervisor-stop-"));
    try {
      const runtimeServicesLogPath = join(root, "runtime-services.log");
      const serviceLogPath = join(root, "source-control-manager.log");
      writeFileSync(runtimeServicesLogPath, "", "utf8");
      writeFileSync(serviceLogPath, "", "utf8");

      let spawnCalls = 0;
      const supervisor = new ServiceManager({
        pollMs: 50,
        computeRestartBackoffMs: () => 150,
        spawnService: (spec) => {
          spawnCalls += 1;
          return {
            name: spec.name,
            proc: {} as any,
            command: [...spec.command],
            cwd: spec.cwd,
            env: { ...(spec.env ?? {}) },
            logPath: serviceLogPath,
            exited: true,
            exitCode: 17,
            launchedAtMs: Date.now(),
          };
        },
      });
      supervisor.startService({
        name: "source_control_manager",
        color: "",
        command: ["fake-scm"],
        cwd: root,
        env: {},
        logPath: serviceLogPath,
      });

      await Bun.sleep(80);
      supervisor.stop();
      await Bun.sleep(220);
      expect(spawnCalls).toBe(1);
      expect(supervisor.getHealth()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  testOnUnix(
    "shutdownEmbeddedServiceManagerGracefully preserves SIGTERM cleanup for managed descendants",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-cli-shutdown-"));
      let supervisor: ServiceManager | null = null;
      let parentPid: number | null = null;
      let childPid: number | null = null;
      try {
        const childScriptPath = join(root, "worker-child.ts");
        const parentScriptPath = join(root, "remotebuddy-parent.ts");
        writeFileSync(
          childScriptPath,
          ["process.on('SIGTERM', () => process.exit(0));", "setInterval(() => {}, 1000);"].join(
            "\n",
          ),
          "utf8",
        );
        writeFileSync(
          parentScriptPath,
          [
            `const child = Bun.spawn([process.execPath, ${JSON.stringify(childScriptPath)}], {`,
            "  stdin: 'ignore',",
            "  stdout: 'inherit',",
            "  stderr: 'inherit',",
            "});",
            "console.log(`CHILD_PID=${child.pid ?? ''}`);",
            "process.on('SIGTERM', () => {",
            "  try {",
            "    child.kill('SIGTERM');",
            "  } catch {}",
            "  setTimeout(() => process.exit(0), 0);",
            "});",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );

        supervisor = new ServiceManager({
          pollMs: 50,
          maxRestartAttempts: 1,
        });
        const service = supervisor.startService({
          name: "remotebuddy",
          color: "",
          command: [process.execPath, parentScriptPath],
          cwd: root,
          env: { ...process.env } as Record<string, string>,
          onStdoutLine: (line) => {
            const match = /CHILD_PID=(\d+)/.exec(line);
            if (match) {
              childPid = Number.parseInt(match[1] ?? "", 10);
            }
          },
        });
        parentPid = service.proc.pid ?? null;

        await waitForCondition(
          () => isPidAlive(parentPid) && isPidAlive(childPid),
          5_000,
          "Expected managed parent and inherited child processes to start.",
        );

        await shutdownEmbeddedServiceManagerGracefully({
          serviceManager: supervisor,
          serverUrl: "http://127.0.0.1:0",
          repoRoot: root,
          reason: "unit test shutdown",
          requestShutdown: async () => ({ attempted: false, accepted: false }),
          shutdownAcceptedDelayMs: 0,
          onLog: () => {},
          onWarn: () => {},
        });

        await waitForCondition(
          () => !isPidAlive(parentPid) && !isPidAlive(childPid),
          5_000,
          "Expected graceful embedded shutdown to terminate managed descendants.",
        );
      } finally {
        if (isPidAlive(childPid)) {
          try {
            process.kill(childPid as number, "SIGKILL");
          } catch {
            // best-effort cleanup only
          }
        }
        if (isPidAlive(parentPid)) {
          try {
            process.kill(parentPid as number, "SIGKILL");
          } catch {
            // best-effort cleanup only
          }
        }
        supervisor?.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("resolveEmbeddedBunExecutableFromEnv finds bun on PATH for standalone CLI binaries", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-bun-path-"));
    try {
      const fakeBinDir = join(root, "bin");
      mkdirSync(fakeBinDir, { recursive: true });
      const bunPath = join(fakeBinDir, process.platform === "win32" ? "bun.exe" : "bun");
      writeFileSync(bunPath, "", "utf8");
      const resolved = resolveEmbeddedBunExecutableFromEnv(
        {
          PATH: fakeBinDir,
        },
        process.platform,
        join(root, process.platform === "win32" ? "pushpals.exe" : "pushpals"),
      );
      expect(resolved).toBe(bunPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveEmbeddedBunExecutableFromEnv prefers explicit PUSHPALS_BUN_BIN override", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-bun-explicit-"));
    try {
      const fakeBinDir = join(root, "bin");
      mkdirSync(fakeBinDir, { recursive: true });
      const discoveredBun = join(fakeBinDir, process.platform === "win32" ? "bun.exe" : "bun");
      writeFileSync(discoveredBun, "", "utf8");
      const explicitBun = join(
        root,
        process.platform === "win32" ? "embedded-bun.exe" : "embedded-bun",
      );
      const resolved = resolveEmbeddedBunExecutableFromEnv(
        {
          PUSHPALS_BUN_BIN: explicitBun,
          PATH: fakeBinDir,
        },
        process.platform,
        join(root, process.platform === "win32" ? "pushpals.exe" : "pushpals"),
      );
      expect(resolved).toBe(explicitBun);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveEmbeddedBunExecutableFromEnv supports Windows Path casing", () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "pushpals-bun-winpath-"));
    try {
      const fakeBinDir = join(root, "bin");
      mkdirSync(fakeBinDir, { recursive: true });
      const bunPath = join(fakeBinDir, "bun.exe");
      writeFileSync(bunPath, "", "utf8");
      const resolved = resolveEmbeddedBunExecutableFromEnv(
        {
          Path: fakeBinDir,
        },
        "win32",
        join(root, "pushpals.exe"),
      );
      expect(resolved).toBe(bunPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repoLooksLikePushPalsSourceCheckout only accepts configs/default.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-source-checkout-"));
    const configsDir = join(root, "configs");
    const legacyDir = join(root, "config");
    mkdirSync(configsDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });

    try {
      expect(repoLooksLikePushPalsSourceCheckout(root)).toBe(false);

      writeFileSync(join(legacyDir, "default.toml"), 'profile = "dev"\n', "utf8");
      expect(repoLooksLikePushPalsSourceCheckout(root)).toBe(false);

      writeFileSync(join(configsDir, "default.toml"), 'profile = "dev"\n', "utf8");
      expect(repoLooksLikePushPalsSourceCheckout(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("buildEmbeddedRuntimeEnv applies conservative embedded Windows worker caps by default", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
      },
      {
        repoRoot: "C:/repo/example",
        runtimeRoot: "C:/runtime/pushpals",
        platform: "win32",
      },
    );

    expect("REMOTEBUDDY_MAX_WORKERPALS" in env).toBe(false);
    expect(env.REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS).toBe("120000");
    expect(env.WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS).toBe("90000");
    expect(env.WORKERPALS_SKIP_DOCKER_SELF_CHECK).toBe("1");
    expect(env.WORKERPALS_DOCKER_WARM_MEMORY_MB).toBe("1024");
    expect(env.WORKERPALS_DOCKER_WARM_CPUS).toBe("1");
  });

  test("buildEmbeddedRuntimeEnv preserves explicit worker cap env overrides", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        REMOTEBUDDY_MAX_WORKERPALS: "8",
        WORKERPALS_SKIP_DOCKER_SELF_CHECK: "0",
        WORKERPALS_DOCKER_WARM_MEMORY_MB: "3072",
      },
      {
        repoRoot: "C:/repo/example",
        runtimeRoot: "C:/runtime/pushpals",
        platform: "win32",
      },
    );

    expect(env.REMOTEBUDDY_MAX_WORKERPALS).toBe("8");
    expect(env.WORKERPALS_SKIP_DOCKER_SELF_CHECK).toBe("0");
    expect(env.WORKERPALS_DOCKER_WARM_MEMORY_MB).toBe("3072");
    expect(env.WORKERPALS_DOCKER_WARM_CPUS).toBe("1");
  });

  test("buildEmbeddedRuntimeEnv can disable embedded Windows worker caps", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PUSHPALS_DISABLE_EMBEDDED_SAFETY_CAPS: "1",
      },
      {
        repoRoot: "C:/repo/example",
        runtimeRoot: "C:/runtime/pushpals",
        platform: "win32",
      },
    );

    expect("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS" in env).toBe(false);
    expect("WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS" in env).toBe(false);
    expect("WORKERPALS_SKIP_DOCKER_SELF_CHECK" in env).toBe(false);
    expect("WORKERPALS_DOCKER_WARM_MEMORY_MB" in env).toBe(false);
    expect("WORKERPALS_DOCKER_WARM_CPUS" in env).toBe(false);
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
    expect("PUSHPALS_WORKERPALS_SANDBOX_ROOT" in env).toBe(false);
    expect(env.PUSHPALS_PROTOCOL_SCHEMAS_DIR).toBe(
      join("/runtime/pushpals", "protocol", "schemas"),
    );
  });

  test("buildEmbeddedRuntimeEnv clears stale embedded config overrides when targeting repo config", () => {
    const env = buildEmbeddedRuntimeEnv(
      {
        PATH: process.env.PATH,
        PUSHPALS_CONFIG_DIR_OVERRIDE: "/runtime/stale/configs",
        PUSHPALS_WORKERPALS_SANDBOX_ROOT: "/runtime/stale/sandbox",
        PUSHPALS_RUNTIME_TAG: "vstale",
        PUSHPALS_PROMPTS_ROOT_OVERRIDE: "/runtime/stale",
      },
      {
        repoRoot: "/repo/example",
        runtimeRoot: "/runtime/pushpals",
        useRuntimeConfig: false,
      },
    );

    expect(env.PUSHPALS_PROMPTS_ROOT_OVERRIDE).toBe("/repo/example");
    expect("PUSHPALS_CONFIG_DIR_OVERRIDE" in env).toBe(false);
    expect("PUSHPALS_WORKERPALS_SANDBOX_ROOT" in env).toBe(false);
    expect("PUSHPALS_RUNTIME_TAG" in env).toBe(false);
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
          PUSHPALS_DOCKER_BIN_ABSOLUTE:
            "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
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
    ).toEqual(["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\Sysnative\\cmd.exe", "cmd.exe"]);
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

  test("resolveWorkerpalDockerProbe honors a configured absolute Docker binary first", async () => {
    const env: Record<string, string> = {
      PATH: "/usr/bin",
      PUSHPALS_DOCKER_BIN_ABSOLUTE: "/tmp/pushpals/fake-docker",
    };
    const calls: string[][] = [];

    const result = await resolveWorkerpalDockerProbe(
      "/repo/example",
      env,
      "linux",
      async (command) => {
        calls.push(command);
        return { ok: true, stdout: "fake-26.1.1\n", stderr: "", exitCode: 0 };
      },
    );

    expect(result).toEqual({
      ok: true,
      detail: "fake-docker (fake-26.1.1)",
    });
    expect(calls[0]?.[0]).toBe("fake-docker");
    expect(env.PUSHPALS_DOCKER_BIN).toBe("fake-docker");
    expect(env.PUSHPALS_DOCKER_BIN_ABSOLUTE).toBe("/tmp/pushpals/fake-docker");
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

  test("resolveWorkerExecutionReadiness reports blocked when required Docker-backed auto-spawn cannot start", async () => {
    const result = await resolveWorkerExecutionReadiness({
      serverUrl: "http://127.0.0.1:3001",
      ttlMs: 60_000,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      repoRoot: "C:/repo/example",
      runtimeRoot: "C:/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      sessionId: "dev",
      fetchWorkersFn: async () => [],
      precheckDockerAvailabilityFn: async () => ({
        status: "failed",
        detail: "docker daemon is not running",
        env: { PATH: process.env.PATH ?? "" },
      }),
    });

    expect(result).toEqual({
      state: "blocked",
      detail: "Docker-backed WorkerPal auto-spawn is unavailable: docker daemon is not running",
      action: "Start Docker Desktop or the Docker daemon, then retry startup or rerun /status.",
    });
    expect(formatWorkerExecutionReadinessLines(result)).toEqual([
      "[pushpals] workerExecution=blocked detail=Docker-backed WorkerPal auto-spawn is unavailable: docker daemon is not running",
      "[pushpals] workerExecutionAction=Start Docker Desktop or the Docker daemon, then retry startup or rerun /status.",
    ]);
  });

  test("resolveWorkerExecutionReadiness reports warming from live worker status without re-running Docker checks", async () => {
    let dockerChecks = 0;
    const result = await resolveWorkerExecutionReadiness({
      serverUrl: "http://127.0.0.1:3001",
      ttlMs: 60_000,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      repoRoot: "C:/repo/example",
      runtimeRoot: "C:/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      sessionId: "dev",
      fetchWorkersFn: async () => [
        {
          workerId: "workerpal-1",
          isOnline: true,
          activeJobCount: 2,
          status: "online",
        },
      ],
      precheckDockerAvailabilityFn: async () => {
        dockerChecks += 1;
        return {
          status: "ok",
          detail: "docker ok",
          env: { PATH: process.env.PATH ?? "" },
        };
      },
    });

    expect(result).toEqual({
      state: "warming",
      detail: "0 idle / 1 online",
      action:
        "Wait for WorkerPal warmup or active jobs to finish, then retry /status or send the request again.",
    });
    expect(dockerChecks).toBe(0);
  });

  test("resolveWorkerExecutionReadiness does not infer blocked Docker state from a skipped precheck", async () => {
    let dockerChecks = 0;
    const result = await resolveWorkerExecutionReadiness({
      serverUrl: "http://127.0.0.1:3001",
      ttlMs: 60_000,
      autoSpawnWorkerpals: true,
      dockerEnabled: true,
      requireDocker: true,
      repoRoot: "C:/repo/example",
      runtimeRoot: "C:/runtime/pushpals",
      preflightUsesEmbeddedRuntime: true,
      sessionId: "dev",
      dockerPrecheck: {
        status: "skipped",
        detail:
          "embedded WorkerPal Docker startup precheck skipped because runtime is already healthy",
        env: { PATH: process.env.PATH ?? "" },
      },
      fetchWorkersFn: async () => [],
      precheckDockerAvailabilityFn: async () => {
        dockerChecks += 1;
        return {
          status: "failed",
          detail: "docker daemon is not running",
          env: { PATH: process.env.PATH ?? "" },
        };
      },
    });

    expect(result).toEqual({
      state: "warming",
      detail: "No online WorkerPals are reported yet.",
      action: "Wait for WorkerPal auto-spawn/warmup to finish, then rerun /status.",
    });
    expect(dockerChecks).toBe(0);
  });

  test("shouldRunEmbeddedRuntimeStartupPrechecks only runs when auto-start is needed", () => {
    expect(
      shouldRunEmbeddedRuntimeStartupPrechecks({
        serverHealthy: false,
        noAutoStart: false,
      }),
    ).toBe(true);
    expect(
      shouldRunEmbeddedRuntimeStartupPrechecks({
        serverHealthy: true,
        noAutoStart: false,
      }),
    ).toBe(false);
    expect(
      shouldRunEmbeddedRuntimeStartupPrechecks({
        serverHealthy: false,
        noAutoStart: true,
      }),
    ).toBe(false);
  });

  test("shouldRunEmbeddedRuntimeStartupPrechecks stays false for already-healthy runtimes regardless of auto-start", () => {
    expect(
      shouldRunEmbeddedRuntimeStartupPrechecks({
        serverHealthy: true,
        noAutoStart: true,
      }),
    ).toBe(false);
  });

  test("copyTrackedRepoPath copies only tracked sandbox files from a repo subtree", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-tracked-copy-"));
    const repoRoot = join(root, "repo");
    const outRoot = join(root, "out");
    mkdirSync(join(repoRoot, "apps", "workerpals", "src", "__pycache__"), { recursive: true });
    writeFileSync(join(repoRoot, ".gitignore"), "__pycache__/\n", "utf8");
    writeFileSync(join(repoRoot, "apps", "workerpals", "src", "worker.ts"), "export {};\n", "utf8");
    writeFileSync(
      join(repoRoot, "apps", "workerpals", "src", "__pycache__", "junk.pyc"),
      "ignored",
      "utf8",
    );

    try {
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);
      const add = Bun.spawnSync(["git", "add", ".gitignore", "apps/workerpals/src/worker.ts"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(add.exitCode).toBe(0);

      copyTrackedRepoPath(repoRoot, "apps/workerpals", outRoot, true);

      expect(existsSync(join(outRoot, "src", "worker.ts"))).toBe(true);
      expect(existsSync(join(outRoot, "src", "__pycache__", "junk.pyc"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  test("buildWorkerpalSandboxPaths returns the packaged sandbox layout under the runtime root", () => {
    const paths = buildWorkerpalSandboxPaths("/runtime/pushpals");

    expect(paths.root).toBe(join("/runtime/pushpals", "sandbox"));
    expect(paths.dockerfilePath).toBe(
      join("/runtime/pushpals", "sandbox", "apps", "workerpals", "Dockerfile.sandbox"),
    );
    expect(paths.packageJsonPath).toBe(join("/runtime/pushpals", "sandbox", "package.json"));
    expect(paths.remotebuddyFallbackBundlePath).toBe(
      join("/runtime/pushpals", "sandbox", ".pushpals-remotebuddy-fallback.js"),
    );
    expect(paths.configsDir).toBe(join("/runtime/pushpals", "sandbox", "configs"));
    expect(paths.workerpalsPromptsDir).toBe(
      join("/runtime/pushpals", "sandbox", "prompts", "workerpals"),
    );
    expect(paths.protocolSchemasDir).toBe(
      join("/runtime/pushpals", "sandbox", "protocol", "schemas"),
    );
  });

  test("ensureWorkerpalDockerImageReady builds the local sandbox image when it is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-worker-image-"));
    const sandbox = buildWorkerpalSandboxPaths(root);
    mkdirSync(join(sandbox.workerpalsDir, "src"), { recursive: true });
    mkdirSync(sandbox.sharedDir, { recursive: true });
    mkdirSync(sandbox.protocolDir, { recursive: true });
    mkdirSync(sandbox.configsDir, { recursive: true });
    mkdirSync(sandbox.workerpalsPromptsDir, { recursive: true });
    mkdirSync(sandbox.protocolSchemasDir, { recursive: true });
    writeFileSync(sandbox.packageJsonPath, '{"name":"pushpals-sandbox"}\n', "utf8");
    writeFileSync(sandbox.dockerfilePath, "FROM oven/bun:1-debian\n", "utf8");
    writeFileSync(join(sandbox.sharedDir, "package.json"), '{"name":"shared"}\n', "utf8");
    writeFileSync(join(sandbox.protocolDir, "package.json"), '{"name":"protocol"}\n', "utf8");
    writeFileSync(join(sandbox.configsDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(
      join(sandbox.workerpalsPromptsDir, "workerpals_system_prompt.md"),
      "# workerpals\n",
      "utf8",
    );
    writeFileSync(join(sandbox.protocolSchemasDir, "envelope.schema.json"), "{}\n", "utf8");
    writeFileSync(join(sandbox.protocolSchemasDir, "events.schema.json"), "{}\n", "utf8");

    const calls: Array<{ command: string[]; cwd: string }> = [];
    try {
      const result = await ensureWorkerpalDockerImageReady({
        runtimeRoot: root,
        runtimeTag: "v1.0.19",
        dockerImage: "pushpals-worker-sandbox:latest",
        env: {
          PUSHPALS_DOCKER_BIN_ABSOLUTE: "/usr/local/bin/docker",
        },
        ensureRuntimeAssetsFn: async () => {},
        inspectImageRuntimeTagFn: async () => ({ status: "missing", runtimeTag: "" }),
        runCommandWithEnvFn: async (command, cwd) => {
          calls.push({ command, cwd });
          return { ok: true, stdout: "ok", stderr: "", exitCode: 0 };
        },
      });

      expect(result).toEqual({
        ok: true,
        detail:
          "built local WorkerPal sandbox image pushpals-worker-sandbox:latest for runtimeTag=v1.0.19",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cwd).toBe(sandbox.root);
      expect(calls[0]?.command).toEqual([
        "/usr/local/bin/docker",
        "build",
        "-f",
        "apps/workerpals/Dockerfile.sandbox",
        "--label",
        "pushpals.runtime_tag=v1.0.19",
        "--label",
        "pushpals.component=workerpals-sandbox",
        "-t",
        "pushpals-worker-sandbox:latest",
        ".",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensureWorkerpalDockerImageReady skips the build when the local sandbox image already matches the runtime tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-worker-image-ready-"));
    const sandbox = buildWorkerpalSandboxPaths(root);
    mkdirSync(join(sandbox.workerpalsDir, "src"), { recursive: true });
    mkdirSync(sandbox.sharedDir, { recursive: true });
    mkdirSync(sandbox.protocolDir, { recursive: true });
    mkdirSync(sandbox.configsDir, { recursive: true });
    mkdirSync(sandbox.workerpalsPromptsDir, { recursive: true });
    mkdirSync(sandbox.protocolSchemasDir, { recursive: true });
    writeFileSync(sandbox.packageJsonPath, '{"name":"pushpals-sandbox"}\n', "utf8");
    writeFileSync(sandbox.dockerfilePath, "FROM oven/bun:1-debian\n", "utf8");
    writeFileSync(join(sandbox.sharedDir, "package.json"), '{"name":"shared"}\n', "utf8");
    writeFileSync(join(sandbox.protocolDir, "package.json"), '{"name":"protocol"}\n', "utf8");
    writeFileSync(join(sandbox.configsDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(
      join(sandbox.workerpalsPromptsDir, "workerpals_system_prompt.md"),
      "# workerpals\n",
      "utf8",
    );
    writeFileSync(join(sandbox.protocolSchemasDir, "envelope.schema.json"), "{}\n", "utf8");
    writeFileSync(join(sandbox.protocolSchemasDir, "events.schema.json"), "{}\n", "utf8");

    try {
      const result = await ensureWorkerpalDockerImageReady({
        runtimeRoot: root,
        runtimeTag: "v1.0.19",
        dockerImage: "pushpals-worker-sandbox:latest",
        env: {
          PUSHPALS_DOCKER_BIN: "docker",
        },
        ensureRuntimeAssetsFn: async () => {},
        inspectImageRuntimeTagFn: async () => ({ status: "ok", runtimeTag: "v1.0.19" }),
        runCommandWithEnvFn: async () => {
          throw new Error("docker build should not run when the local image already matches");
        },
      });

      expect(result).toEqual({
        ok: true,
        detail:
          "WorkerPal sandbox image is ready locally (pushpals-worker-sandbox:latest, runtimeTag=v1.0.19)",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensureWorkerpalDockerImageReady rebuilds when inspecting the local sandbox image times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-worker-image-timeout-"));
    const sandbox = buildWorkerpalSandboxPaths(root);
    mkdirSync(join(sandbox.workerpalsDir, "src"), { recursive: true });
    mkdirSync(sandbox.sharedDir, { recursive: true });
    mkdirSync(sandbox.protocolDir, { recursive: true });
    mkdirSync(sandbox.configsDir, { recursive: true });
    mkdirSync(sandbox.workerpalsPromptsDir, { recursive: true });
    mkdirSync(sandbox.protocolSchemasDir, { recursive: true });
    writeFileSync(sandbox.packageJsonPath, '{"name":"pushpals-sandbox"}\n', "utf8");
    writeFileSync(sandbox.dockerfilePath, "FROM oven/bun:1-debian\n", "utf8");
    writeFileSync(join(sandbox.sharedDir, "package.json"), '{"name":"shared"}\n', "utf8");
    writeFileSync(join(sandbox.protocolDir, "package.json"), '{"name":"protocol"}\n', "utf8");
    writeFileSync(join(sandbox.configsDir, "default.toml"), 'profile = "dev"\n', "utf8");
    writeFileSync(
      join(sandbox.workerpalsPromptsDir, "workerpals_system_prompt.md"),
      "# workerpals\n",
      "utf8",
    );
    writeFileSync(join(sandbox.protocolSchemasDir, "envelope.schema.json"), "{}\n", "utf8");
    writeFileSync(join(sandbox.protocolSchemasDir, "events.schema.json"), "{}\n", "utf8");

    try {
      const result = await ensureWorkerpalDockerImageReady({
        runtimeRoot: root,
        runtimeTag: "v1.0.47",
        dockerImage: "pushpals-worker-sandbox:latest",
        env: {
          PUSHPALS_DOCKER_BIN: "docker",
        },
        ensureRuntimeAssetsFn: async () => {},
        inspectImageRuntimeTagFn: async () => ({
          status: "failed",
          runtimeTag: "",
          detail:
            "failed to inspect local WorkerPal sandbox image pushpals-worker-sandbox:latest: timed out after 15000ms",
        }),
        runCommandWithEnvFn: async (command) => {
          expect(command).toContain("build");
          return { ok: true, stdout: "ok", stderr: "", exitCode: 0 };
        },
      });

      expect(result).toEqual({
        ok: true,
        detail:
          "rebuilt local WorkerPal sandbox image pushpals-worker-sandbox:latest for runtimeTag=v1.0.47 after image inspection failed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareEmbeddedWorkerpalDockerImageIfNeeded resolves and prepares the embedded sandbox image", async () => {
    const result = await prepareEmbeddedWorkerpalDockerImageIfNeeded({
      preparedRuntime: {
        runtimeRoot: "/runtime/pushpals",
        runtimeTag: "",
        runtimePreflight: {} as Awaited<ReturnType<typeof prepareCliRuntime>>["runtimePreflight"],
        preflightUsesEmbeddedRuntime: true,
      },
      config: {
        remotebuddy: {
          autoSpawnWorkerpals: true,
          workerpalDocker: true,
          workerpalRequireDocker: true,
          workerpalImage: "pushpals-worker-sandbox:latest",
        },
        workerpals: {
          dockerImage: "pushpals-worker-sandbox:fallback",
        },
      } as Awaited<ReturnType<typeof prepareCliRuntime>>["runtimePreflight"]["config"],
      dockerPrecheck: {
        status: "ok",
        detail: "docker (26.1.1)",
        env: {
          PUSHPALS_DOCKER_BIN: "docker",
        },
      },
      runtimeTagHint: "v1.0.19",
      resolveRuntimeReleaseTagFn: async () => {
        throw new Error("runtime tag should come from the explicit hint");
      },
      ensureWorkerpalDockerImageReadyFn: async (opts) => {
        expect(opts.runtimeTag).toBe("v1.0.19");
        expect(opts.dockerImage).toBe("pushpals-worker-sandbox:latest");
        expect(opts.env.PUSHPALS_DOCKER_BIN).toBe("docker");
        return {
          ok: true,
          detail:
            "built local WorkerPal sandbox image pushpals-worker-sandbox:latest for runtimeTag=v1.0.19",
        };
      },
    });

    expect(result).toEqual({
      status: "ok",
      detail:
        "built local WorkerPal sandbox image pushpals-worker-sandbox:latest for runtimeTag=v1.0.19",
      runtimeTag: "v1.0.19",
    });
  });

  test("prepareEmbeddedWorkerpalDockerImageIfNeeded skips source-checkout runtimes", async () => {
    const result = await prepareEmbeddedWorkerpalDockerImageIfNeeded({
      preparedRuntime: {
        runtimeRoot: "/runtime/pushpals",
        runtimeTag: "",
        runtimePreflight: {} as Awaited<ReturnType<typeof prepareCliRuntime>>["runtimePreflight"],
        preflightUsesEmbeddedRuntime: false,
      },
      config: {
        remotebuddy: {
          autoSpawnWorkerpals: true,
          workerpalDocker: true,
          workerpalRequireDocker: true,
          workerpalImage: "pushpals-worker-sandbox:latest",
        },
        workerpals: {
          dockerImage: "pushpals-worker-sandbox:fallback",
        },
      } as Awaited<ReturnType<typeof prepareCliRuntime>>["runtimePreflight"]["config"],
      dockerPrecheck: {
        status: "ok",
        detail: "docker (26.1.1)",
        env: {},
      },
      ensureWorkerpalDockerImageReadyFn: async () => {
        throw new Error("embedded image precheck should be skipped for source-checkout runtimes");
      },
    });

    expect(result).toEqual({
      status: "skipped",
      detail: "repo is using source-checkout runtime assets",
      runtimeTag: "",
    });
  });

  test("prepareCliRuntime migrates stale embedded local autonomy overrides back to the default-on state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-autonomy-migrate-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      writeFileSync(
        join(runtimeRoot, "configs", "local.toml"),
        ["[remotebuddy.autonomy]", "enabled = false", "llm_timeout_ms = 60000", ""].join("\n"),
        "utf8",
      );

      const prepared = await prepareCliRuntime({
        repoRoot,
        runtimeRoot,
      });

      expect(prepared.preflightUsesEmbeddedRuntime).toBe(true);
      expect(prepared.runtimePreflight.config?.remotebuddy.autonomy.enabled).toBe(true);
      expect(readFileSync(join(runtimeRoot, "configs", "local.toml"), "utf8")).toContain(
        "enabled = true",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareCliRuntime ensures embedded local.toml exists for external runtimes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-local-seed-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      writeFileSync(
        join(runtimeRoot, "configs", "local.example.toml"),
        ["[startup]", "log_config_on_start = false", ""].join("\n"),
        "utf8",
      );

      const prepared = await prepareCliRuntime({
        repoRoot,
        runtimeRoot,
      });

      expect(prepared.preflightUsesEmbeddedRuntime).toBe(true);
      expect(existsSync(join(runtimeRoot, "configs", "local.toml"))).toBe(true);
      expect(
        readFileSync(join(runtimeRoot, "configs", "local.toml"), "utf8").trim().length,
      ).toBeGreaterThan(0);
      expect(prepared.runtimePreflight.config).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareCliRuntime preserves an existing embedded local.toml override", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-local-preserve-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(join(runtimeRoot, "configs"), { recursive: true });
      writeFileSync(
        join(runtimeRoot, "configs", "local.example.toml"),
        ["[startup]", "log_config_on_start = true", ""].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(runtimeRoot, "configs", "local.toml"),
        ["[startup]", "log_config_on_start = false", ""].join("\n"),
        "utf8",
      );

      const prepared = await prepareCliRuntime({
        repoRoot,
        runtimeRoot,
      });

      expect(prepared.preflightUsesEmbeddedRuntime).toBe(true);
      expect(readFileSync(join(runtimeRoot, "configs", "local.toml"), "utf8")).toBe(
        ["[startup]", "log_config_on_start = false", ""].join("\n"),
      );
      expect(prepared.runtimePreflight.config?.startup.logConfigOnStart).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareCliRuntime does not seed embedded runtime configs for source checkouts", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-source-checkout-"));
    const repoRoot = join(root, "repo");
    const runtimeRoot = join(root, "runtime");

    try {
      mkdirSync(join(repoRoot, "configs"), { recursive: true });
      mkdirSync(runtimeRoot, { recursive: true });
      writeFileSync(join(repoRoot, "configs", "default.toml"), 'profile = "dev"\n', "utf8");

      const prepared = await prepareCliRuntime({
        repoRoot,
        runtimeRoot,
        runtimeTag: "v1.2.3",
      });

      expect(prepared.preflightUsesEmbeddedRuntime).toBe(false);
      expect(prepared.runtimeTag).toBe("");
      expect(existsSync(join(runtimeRoot, "configs", "local.toml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupLingeringWorkerpalWarmContainers no-ops when no warm containers are present", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "no lingering WorkerPal warm containers found",
      removed: 0,
    });
    expect(calls).toEqual([
      {
        command: [
          "docker",
          "ps",
          "-aq",
          "--filter",
          "label=pushpals.component=workerpals-warm",
          "--filter",
          "label=pushpals.repo=/repo/example",
        ],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLingeringWorkerpalWarmContainers treats unavailable Docker as a no-op", async () => {
    const result = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      runCommandWithEnvFn: async () => ({
        ok: false,
        stdout: "",
        stderr:
          "failed to connect to the docker API at npipe:////./pipe/docker_engine; open //./pipe/docker_engine: The system cannot find the file specified.",
        exitCode: 1,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.detail).toContain("docker unavailable; skipped WorkerPal warm-container cleanup");
  });

  test("cleanupLingeringWorkerpalWarmContainers treats Docker inspect timeouts as a no-op", async () => {
    const result = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      runCommandWithEnvFn: async () => ({
        ok: false,
        stdout: "",
        stderr: "timed out after 5000ms",
        exitCode: null,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.detail).toContain(
      "docker cleanup timed out; skipped WorkerPal warm-container cleanup",
    );
  });

  test("cleanupLingeringWorkerpalWarmContainers treats Docker remove timeouts as a no-op", async () => {
    let phase = 0;
    const result = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      runCommandWithEnvFn: async () => {
        phase += 1;
        if (phase === 1) {
          return { ok: true, stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        return {
          ok: false,
          stdout: "",
          stderr: "timed out after 5000ms",
          exitCode: null,
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.detail).toContain(
      "docker cleanup timed out; skipped WorkerPal warm-container cleanup",
    );
  });

  test("cleanupLingeringWorkerpalWarmContainers removes matching warm containers", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    let phase = 0;
    const result = await cleanupLingeringWorkerpalWarmContainers({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        phase += 1;
        if (phase === 1) {
          return { ok: true, stdout: "abc123\ndef456\n", stderr: "", exitCode: 0 };
        }
        return { ok: true, stdout: "abc123\ndef456\n", stderr: "", exitCode: 0 };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "removed 2 lingering WorkerPal warm container(s)",
      removed: 2,
    });
    expect(calls).toEqual([
      {
        command: [
          "docker",
          "ps",
          "-aq",
          "--filter",
          "label=pushpals.component=workerpals-warm",
          "--filter",
          "label=pushpals.repo=/repo/example",
        ],
        cwd: "/repo/example",
      },
      {
        command: ["docker", "rm", "-f", "abc123", "def456"],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLocalWorkerpalSandboxImage no-ops when no image is configured", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      dockerImage: "",
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "no local WorkerPal sandbox image configured",
      removed: false,
      imageName: "",
    });
    expect(calls).toEqual([]);
  });

  test("cleanupLocalWorkerpalSandboxImage no-ops when the image is already missing", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      dockerImage: "pushpals-worker-sandbox:latest",
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        return {
          ok: false,
          stdout: "",
          stderr: "Error response from daemon: No such image: pushpals-worker-sandbox:latest",
          exitCode: 1,
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "no local WorkerPal sandbox image found for pushpals-worker-sandbox:latest",
      removed: false,
      imageName: "pushpals-worker-sandbox:latest",
    });
    expect(calls).toEqual([
      {
        command: ["docker", "image", "rm", "-f", "pushpals-worker-sandbox:latest"],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLocalWorkerpalSandboxImage treats unavailable Docker as a no-op", async () => {
    const result = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      dockerImage: "pushpals-worker-sandbox:latest",
      runCommandWithEnvFn: async () => ({
        ok: false,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
        exitCode: 1,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.detail).toContain("docker unavailable; skipped WorkerPal sandbox image cleanup");
  });

  test("cleanupLocalWorkerpalSandboxImage treats Docker timeouts as a no-op", async () => {
    const result = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      dockerImage: "pushpals-worker-sandbox:latest",
      runCommandWithEnvFn: async () => ({
        ok: false,
        stdout: "",
        stderr: "timed out after 5000ms",
        exitCode: null,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.detail).toContain(
      "docker cleanup timed out; skipped WorkerPal sandbox image cleanup",
    );
  });

  test("isDockerCleanupTimeoutDetail classifies Docker command timeout failures", () => {
    expect(isDockerCleanupTimeoutDetail("timed out after 5000ms")).toBe(true);
    expect(isDockerCleanupTimeoutDetail("Cannot connect to the Docker daemon")).toBe(false);
  });

  test("isDockerUnavailableDetail classifies common Docker daemon failures", () => {
    expect(isDockerUnavailableDetail("Cannot connect to the Docker daemon")).toBe(true);
    expect(
      isDockerUnavailableDetail("failed to connect to the docker API at npipe:////./pipe/docker_engine"),
    ).toBe(true);
    expect(isDockerUnavailableDetail("Error response from daemon: No such image")).toBe(false);
  });

  test("cleanupLocalWorkerpalSandboxImage removes the configured sandbox image", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLocalWorkerpalSandboxImage({
      repoRoot: "/repo/example",
      env: {
        PUSHPALS_DOCKER_BIN: "docker",
      },
      dockerImage: "pushpals-worker-sandbox:latest",
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        return {
          ok: true,
          stdout: "Untagged: pushpals-worker-sandbox:latest\nDeleted: sha256:deadbeef\n",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "removed local WorkerPal sandbox image pushpals-worker-sandbox:latest",
      removed: true,
      imageName: "pushpals-worker-sandbox:latest",
    });
    expect(calls).toEqual([
      {
        command: ["docker", "image", "rm", "-f", "pushpals-worker-sandbox:latest"],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLingeringPushPalsGitWorktrees no-ops when no stale git artifacts are present", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLingeringPushPalsGitWorktrees({
      repoRoot: "/repo/example",
      env: {},
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        if (command[2] === "list") {
          return {
            ok: true,
            stdout: [
              "worktree /repo/example",
              "HEAD abcdef1234567890",
              "branch refs/heads/main",
              "",
              "worktree /repo/example/.worktrees/source_control_manager",
              "HEAD feedface12345678",
              "branch refs/heads/main_agents",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command[2] === "prune") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command[1] === "for-each-ref") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "no lingering PushPals git artifacts found",
      removed: 0,
    });
    expect(calls).toEqual([
      {
        command: ["git", "worktree", "list", "--porcelain"],
        cwd: "/repo/example",
      },
      {
        command: ["git", "worktree", "prune"],
        cwd: "/repo/example",
      },
      {
        command: [
          "git",
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/_source_control_manager/",
        ],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLingeringPushPalsGitWorktrees removes stale workerpal worktrees and temp branches", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const result = await cleanupLingeringPushPalsGitWorktrees({
      repoRoot: "/repo/example",
      env: {},
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        if (command[2] === "list") {
          return {
            ok: true,
            stdout: [
              "worktree /repo/example",
              "HEAD abcdef1234567890",
              "branch refs/heads/main",
              "",
              "worktree /repo/example/.worktrees/job-123-workerpal-abcd-1",
              "HEAD feedface12345678",
              "detached",
              "",
              "worktree /repo/example/.worktrees/source_control_manager",
              "HEAD deadbeef12345678",
              "branch refs/heads/_source_control_manager/leftover",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command[2] === "remove") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command[2] === "prune") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command[1] === "for-each-ref") {
          return {
            ok: true,
            stdout: "_source_control_manager/leftover\n_source_control_manager/other\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (command[1] === "branch") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "removed 4 lingering PushPals git artifact(s)",
      removed: 4,
    });
    expect(calls).toEqual([
      {
        command: ["git", "worktree", "list", "--porcelain"],
        cwd: "/repo/example",
      },
      {
        command: [
          "git",
          "worktree",
          "remove",
          "--force",
          "--force",
          "/repo/example/.worktrees/job-123-workerpal-abcd-1",
        ],
        cwd: "/repo/example",
      },
      {
        command: [
          "git",
          "worktree",
          "remove",
          "--force",
          "--force",
          "/repo/example/.worktrees/source_control_manager",
        ],
        cwd: "/repo/example",
      },
      {
        command: ["git", "worktree", "prune"],
        cwd: "/repo/example",
      },
      {
        command: [
          "git",
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/_source_control_manager/",
        ],
        cwd: "/repo/example",
      },
      {
        command: ["git", "branch", "-D", "_source_control_manager/leftover"],
        cwd: "/repo/example",
      },
      {
        command: ["git", "branch", "-D", "_source_control_manager/other"],
        cwd: "/repo/example",
      },
    ]);
  });

  test("cleanupLingeringPushPalsGitWorktrees falls back to forced delete when git remove hits long paths", async () => {
    const calls: Array<{ command: string[]; cwd: string }> = [];
    const forcedDeletes: string[] = [];
    const result = await cleanupLingeringPushPalsGitWorktrees({
      repoRoot: "C:/repo/example",
      env: {},
      runCommandWithEnvFn: async (command, cwd) => {
        calls.push({ command, cwd });
        if (command[2] === "list") {
          return {
            ok: true,
            stdout: [
              "worktree C:/repo/example",
              "HEAD abcdef1234567890",
              "branch refs/heads/main",
              "",
              "worktree C:/repo/example/.worktrees/job-123-workerpal-abcd-1",
              "HEAD feedface12345678",
              "detached",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command[2] === "remove") {
          return {
            ok: false,
            stdout: "",
            stderr:
              "error: failed to delete 'C:/repo/example/.worktrees/job-123-workerpal-abcd-1': Filename too long",
            exitCode: 128,
          };
        }
        if (command[2] === "prune") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command[1] === "for-each-ref") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
      forceDeleteWorktreePathFn: async (worktreePath) => {
        forcedDeletes.push(worktreePath);
        return { removed: true };
      },
    });

    expect(result).toEqual({
      ok: true,
      detail: "removed 1 lingering PushPals git artifact(s)",
      removed: 1,
    });
    expect(forcedDeletes).toEqual(["C:/repo/example/.worktrees/job-123-workerpal-abcd-1"]);
    expect(calls).toEqual([
      {
        command: ["git", "worktree", "list", "--porcelain"],
        cwd: "C:/repo/example",
      },
      {
        command: [
          "git",
          "worktree",
          "remove",
          "--force",
          "--force",
          "C:/repo/example/.worktrees/job-123-workerpal-abcd-1",
        ],
        cwd: "C:/repo/example",
      },
      {
        command: ["git", "worktree", "prune"],
        cwd: "C:/repo/example",
      },
      {
        command: [
          "git",
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/_source_control_manager/",
        ],
        cwd: "C:/repo/example",
      },
    ]);
  });

  test("cleanupLingeringPushPalsGitWorktrees propagates bounded command timeouts", async () => {
    const calls: Array<{ command: string[]; cwd: string; timeoutMs?: number }> = [];
    const result = await cleanupLingeringPushPalsGitWorktrees({
      repoRoot: "/repo/example",
      env: {},
      commandTimeoutMs: 4321,
      runCommandWithEnvFn: async (command, cwd, _env, timeoutMs) => {
        calls.push({ command, cwd, timeoutMs });
        if (command[2] === "list") {
          return {
            ok: true,
            stdout: [
              "worktree /repo/example",
              "HEAD abcdef1234567890",
              "branch refs/heads/main",
              "",
              "worktree /repo/example/.worktrees/job-123-workerpal-abcd-1",
              "HEAD feedface12345678",
              "detached",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (command[2] === "remove") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        if (command[2] === "prune") {
          return {
            ok: false,
            stdout: "",
            stderr: "timed out after 4321ms",
            exitCode: 137,
          };
        }
        if (command[1] === "for-each-ref") {
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out after 4321ms");
    expect(calls).toEqual([
      {
        command: ["git", "worktree", "list", "--porcelain"],
        cwd: "/repo/example",
        timeoutMs: 4321,
      },
      {
        command: [
          "git",
          "worktree",
          "remove",
          "--force",
          "--force",
          "/repo/example/.worktrees/job-123-workerpal-abcd-1",
        ],
        cwd: "/repo/example",
        timeoutMs: 4321,
      },
      {
        command: ["git", "worktree", "prune"],
        cwd: "/repo/example",
        timeoutMs: 4321,
      },
      {
        command: [
          "git",
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/_source_control_manager/",
        ],
        cwd: "/repo/example",
        timeoutMs: 4321,
      },
    ]);
  });

  test("downloadRuntimeAssetsFromSourceTag skips bun.lockb and populates sandbox assets", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "pushpals-cli-runtime-download-"));
    const originalFetch = globalThis.fetch;
    const tag = "v1.0.19";
    const treeUrl = `https://api.github.com/repos/PushPalsDev/pushpals/git/trees/${encodeURIComponent(tag)}?recursive=1`;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === treeUrl) {
        return Response.json({
          tree: [
            { path: "package.json", type: "blob" },
            { path: "bun.lock", type: "blob" },
            { path: "bun.lockb", type: "blob" },
            { path: "configs/default.toml", type: "blob" },
            { path: "prompts/workerpals/workerpals_system_prompt.md", type: "blob" },
            { path: "apps/workerpals/Dockerfile.sandbox", type: "blob" },
            { path: "packages/shared/package.json", type: "blob" },
            { path: "packages/protocol/package.json", type: "blob" },
            { path: "packages/protocol/src/schemas/envelope.schema.json", type: "blob" },
            { path: "packages/protocol/src/schemas/events.schema.json", type: "blob" },
          ],
        });
      }
      if (url.endsWith("/package.json")) {
        return new Response('{"name":"pushpals"}\n');
      }
      if (url.endsWith("/bun.lock")) {
        return new Response("lockfileVersion = 1\n");
      }
      if (url.endsWith("/configs/default.toml")) {
        return new Response('profile = "dev"\n');
      }
      if (url.endsWith("/prompts/workerpals/workerpals_system_prompt.md")) {
        return new Response("# workerpals\n");
      }
      if (url.endsWith("/apps/workerpals/Dockerfile.sandbox")) {
        return new Response("FROM oven/bun:1-debian\n");
      }
      if (url.endsWith("/packages/shared/package.json")) {
        return new Response('{"name":"shared"}\n');
      }
      if (url.endsWith("/packages/protocol/package.json")) {
        return new Response('{"name":"protocol"}\n');
      }
      if (url.endsWith("/packages/protocol/src/schemas/envelope.schema.json")) {
        return new Response("{}\n");
      }
      if (url.endsWith("/packages/protocol/src/schemas/events.schema.json")) {
        return new Response("{}\n");
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      await downloadRuntimeAssetsFromSourceTag(runtimeRoot, tag);

      expect(readFileSync(join(runtimeRoot, "sandbox", "bun.lock"), "utf8")).toContain(
        "lockfileVersion",
      );
      expect(existsSync(join(runtimeRoot, "sandbox", "bun.lockb"))).toBe(false);
      expect(
        readFileSync(join(runtimeRoot, "protocol", "schemas", "events.schema.json"), "utf8"),
      ).toBe("{}\n");
      expect(fetchedUrls.some((url) => url.endsWith("/bun.lockb"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test("ensureRuntimeBinaries reuses a stable platform install directory and records the active tag", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "pushpals-cli-runtime-bin-layout-"));
    const platformKey =
      process.platform === "win32"
        ? "windows-x64"
        : process.platform === "darwin"
          ? process.arch === "arm64"
            ? "macos-arm64"
            : "macos-x64"
          : "linux-x64";
    const extension = platformKey.startsWith("windows-") ? ".exe" : "";
    const legacyDir = join(runtimeRoot, "bin", `v0.9.0-${platformKey}`);
    const stableDir = join(runtimeRoot, "bin", platformKey);
    const originalFetch = globalThis.fetch;
    const requestedAssets: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedAssets.push(url);
      return new Response(new Uint8Array([0x50, 0x4b]));
    }) as typeof fetch;

    try {
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "stale.txt"), "legacy\n", "utf8");

      const binaries = await ensureRuntimeBinaries(runtimeRoot, "v1.2.3");

      expect(binaries.server).toBe(
        join(stableDir, `pushpals-runtime-server-${platformKey}${extension}`),
      );
      expect(readFileSync(join(stableDir, ".runtime-tag"), "utf8")).toBe("v1.2.3\n");
      expect(existsSync(legacyDir)).toBe(false);
      expect(requestedAssets).toHaveLength(5);
      expect(existsSync(binaries.server)).toBe(true);
      expect(existsSync(binaries.workerpals)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
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
    expect(
      resolvePreferredRuntimeReleaseTag(undefined, {
        PUSHPALS_CLI_PACKAGE_VERSION: "0.0.0-dev",
      }),
    ).toBe("");
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

  test("formatRuntimeStartupTimingSummary emits compact per-phase timing details", () => {
    const summary = formatRuntimeStartupTimingSummary({
      outcome: "ready",
      totalDurationMs: 18432,
      phases: [
        { name: "server", durationMs: 912, status: "started" },
        { name: "workerpal", durationMs: 15000, status: "deferred" },
        { name: "readiness", durationMs: 2520, status: "ready" },
      ],
    });

    expect(summary).toBe(
      "[pushpals] startup timing summary: outcome=ready total=18432ms server=912ms(started) workerpal=15000ms(deferred) readiness=2520ms(ready)",
    );
  });

  test("formatRuntimeStartupTimingSummary includes failure detail when provided", () => {
    const summary = formatRuntimeStartupTimingSummary({
      outcome: "failed",
      totalDurationMs: 20001,
      detail: "server health timeout",
      phases: [{ name: "server", durationMs: 20000.9, status: "timeout" }],
    });

    expect(summary).toBe(
      "[pushpals] startup timing summary: outcome=failed total=20001ms detail=server health timeout server=20000ms(timeout)",
    );
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

  test("createSessionEventReplayFilter suppresses replayed status events with the same event id", () => {
    const filter = createSessionEventReplayFilter();
    const event = {
      id: "evt-status-1",
      type: "status",
      from: "agent:remotebuddy-orchestrator",
      ts: new Date().toISOString(),
      payload: {
        state: "idle",
        detail: "RemoteBuddy online and waiting for requests",
      },
    };

    expect(filter.shouldRender(event)).toBe(true);
    expect(filter.shouldRender(event)).toBe(false);
  });

  test("createSessionEventReplayFilter suppresses consecutive identical status updates by content", () => {
    const filter = createSessionEventReplayFilter();
    const baseTs = new Date().toISOString();

    expect(
      filter.shouldRender({
        id: "evt-status-1",
        type: "status",
        from: "agent:source_control_manager",
        ts: baseTs,
        payload: {
          state: "online",
          detail: "SourceControlManager online and monitoring completions",
        },
      }),
    ).toBe(true);
    expect(
      filter.shouldRender({
        id: "evt-status-2",
        type: "status",
        from: "agent:source_control_manager",
        ts: baseTs,
        payload: {
          state: "online",
          detail: "SourceControlManager online and monitoring completions",
        },
      }),
    ).toBe(false);
    expect(
      filter.shouldRender({
        id: "evt-status-3",
        type: "status",
        from: "agent:source_control_manager",
        ts: baseTs,
        payload: {
          state: "busy",
          detail: "SourceControlManager applying completion",
        },
      }),
    ).toBe(true);
    expect(
      filter.shouldRender({
        id: "evt-status-4",
        type: "status",
        from: "agent:source_control_manager",
        ts: baseTs,
        payload: {
          state: "online",
          detail: "SourceControlManager online and monitoring completions",
        },
      }),
    ).toBe(true);
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
  }, 15000);
});
