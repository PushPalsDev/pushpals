import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import {
  buildWorkerSandboxWritableEnv,
  resolveBunExecutableFromEnv,
  resolveWorkerSandboxRoot,
  WINDOWS_WORKER_SANDBOX_ROOT_NAME,
  withResolvedBunOnPath,
} from "../apps/workerpals/src/common/sandbox_env";

describe("workerpals sandbox writable env", () => {
  test("redirects HOME and Expo caches to writable temp paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const originalHome = join(root, "original-home");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: originalHome,
        PATH: "test-path",
      });

      expect(env.PATH.endsWith("test-path")).toBe(true);
      expect(env.HOME).not.toBe(originalHome);
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.EXPO_HOME).toContain(
        process.platform === "win32" ? WINDOWS_WORKER_SANDBOX_ROOT_NAME : "pushpals-worker-env",
      );
      expect(env.XDG_CACHE_HOME).toContain(
        process.platform === "win32" ? WINDOWS_WORKER_SANDBOX_ROOT_NAME : "pushpals-worker-env",
      );
      expect(env.npm_config_cache).toContain("npm");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toContain(
        process.platform === "win32" ? `${sep}pw` : "playwright-browsers",
      );
      expect(env.PLAYWRIGHT_BROWSERS_PATH).not.toBe(env.XDG_CACHE_HOME);
      expect(env.EXPO_NO_TELEMETRY).toBe("1");
      expect(env.EXPO_NO_INTERACTIVE).toBe("1");
      expect(env.CI).toBe("1");
      expect(env.BROWSER).toBe("none");
      expect(env.NODE_OPTIONS).toContain("--dns-result-order=ipv4first");
      expect(env.NODE_OPTIONS).not.toContain("--preserve-symlinks");
      expect(env.BUN_OPTIONS).toBeUndefined();
      expect(env.NODE_PATH.split(process.platform === "win32" ? ";" : ":")[0]).toBe(
        resolve(repo, "node_modules"),
      );
      expect(env.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("127.0.0.1");
      expect(Number(env.EXPO_DEV_SERVER_PORT)).toBeGreaterThanOrEqual(19006);
      expect(Number(env.EXPO_DEV_SERVER_PORT)).toBeLessThan(20006);
      expect(env.RCT_METRO_PORT).toBe(env.EXPO_DEV_SERVER_PORT);
      expect(env.PUSHPALS_VALIDATION_REPO).toBe(repo);
      expect(existsSync(env.HOME)).toBe(true);
      expect(existsSync(env.EXPO_HOME)).toBe(true);
      expect(existsSync(env.npm_config_cache)).toBe(true);
      expect(existsSync(env.PLAYWRIGHT_BROWSERS_PATH)).toBe(true);
      expect(readFileSync(join(env.HOME, ".gitconfig"), "utf8")).toContain("directory = *");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redirects Windows roaming and local application data to writable paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-windows-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    let sandboxRoot = "";

    try {
      const env = buildWorkerSandboxWritableEnv(
        repo,
        {
          HOME: join(root, "original-home"),
          APPDATA: join(root, "read-only-roaming"),
          LOCALAPPDATA: join(root, "read-only-local"),
        },
        "win32",
      );
      sandboxRoot = dirname(env.HOME);

      expect(env.APPDATA).toBe(join(sandboxRoot, "roaming"));
      expect(env.LOCALAPPDATA).toBe(join(sandboxRoot, "local"));
      expect(env.XDG_CONFIG_HOME).toBe(join(sandboxRoot, "config"));
      expect(sandboxRoot).toBe(
        resolveWorkerSandboxRoot(repo, "win32", join(root, "original-home")),
      );
      expect(sandboxRoot).toContain(WINDOWS_WORKER_SANDBOX_ROOT_NAME);
      expect(basename(sandboxRoot)).toMatch(/^[a-f0-9]{12}$/);
      expect(sandboxRoot.length - join(root, "original-home").length).toBeLessThan(20);
      expect(env.PSModuleAnalysisCachePath).toBe(
        join(sandboxRoot, "local", "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache"),
      );
      expect(existsSync(env.APPDATA)).toBe(true);
      expect(existsSync(env.LOCALAPPDATA)).toBe(true);
      expect(existsSync(env.XDG_CONFIG_HOME)).toBe(true);
      expect(existsSync(dirname(env.PSModuleAnalysisCachePath))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("keeps Windows Expo and Workerd writable paths under a bounded profile root", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-windows-short-"));
    const profile = join(root, "profile");
    const repo = join(
      root,
      "an-intentionally-long-repository-parent",
      "another-long-parent",
      "job-12345678-longnonce-run",
    );
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        main: "expo-router/entry",
        dependencies: { "expo-router": "6.0.0" },
      }),
      "utf8",
    );

    try {
      const env = buildWorkerSandboxWritableEnv(
        repo,
        {
          HOME: join(root, "an-intentionally-long-home-override"),
          USERPROFILE: profile,
          TEMP: join(root, "a-much-longer-host-temp-path"),
        },
        "win32",
      );
      const boundedPaths = [
        env.HOME,
        env.TEMP,
        env.TMP,
        env.TMPDIR,
        env.XDG_CACHE_HOME,
        env.XDG_CONFIG_HOME,
        env.APPDATA,
        env.LOCALAPPDATA,
        env.EXPO_HOME,
        env.PLAYWRIGHT_BROWSERS_PATH,
      ];

      for (const path of boundedPaths) {
        expect(relative(profile, path).split(sep)[0]).toBe(WINDOWS_WORKER_SANDBOX_ROOT_NAME);
        expect(path.length - profile.length).toBeLessThan(30);
      }
      expect(env.TEMP).not.toContain("pushpals-worker-env");
      expect(env.TEMP).not.toContain(basename(repo));
      expect(existsSync(env.TEMP)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes Windows Path casing and prepends explicit Bun executable", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-bun-path-"));
    const bunBin = join(root, "runtime", "bin", "bun.exe");

    try {
      const env = withResolvedBunOnPath(
        {
          Path: "C:\\tools",
          PUSHPALS_BUN_BIN: bunBin,
        },
        "win32",
        "C:\\runtime\\pushpals-runtime-workerpals-windows-x64.exe",
      );

      expect(env.PUSHPALS_BUN_BIN).toBe(bunBin);
      expect(env.PATH.split(";")[0]).toBe(dirname(bunBin));
      expect(env.Path).toBe(env.PATH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers Bun from Windows Path when no explicit override is present", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-bun-discovery-"));
    const binDir = join(root, "bin");
    const bunBin = join(binDir, "bun.exe");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(bunBin, "not a real bun\n", "utf8");

    try {
      expect(
        resolveBunExecutableFromEnv(
          {
            Path: binDir,
          },
          "win32",
          "C:\\runtime\\pushpals-runtime-workerpals-windows-x64.exe",
        ),
      ).toBe(bunBin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves Codex auth before redirecting HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const originalHome = join(root, "home");
    const codexHome = join(originalHome, ".codex");
    mkdirSync(repo, { recursive: true });
    mkdirSync(codexHome, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: originalHome,
      });

      expect(env.HOME).not.toBe(originalHome);
      expect(resolve(env.CODEX_HOME ?? "")).toBe(resolve(codexHome));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not override an explicit CODEX_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const explicitCodexHome = join(root, "codex-auth");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        CODEX_HOME: explicitCodexHome,
      });

      expect(env.CODEX_HOME).toBe(explicitCodexHome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves explicit Expo validation ports", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        EXPO_DEV_SERVER_PORT: "23001",
        RCT_METRO_PORT: "23002",
      });

      expect(env.EXPO_DEV_SERVER_PORT).toBe("23001");
      expect(env.RCT_METRO_PORT).toBe("23002");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins Expo Router route discovery to the isolated worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-expo-router-"));
    const repo = join(root, "repo", ".worktrees", "job-one");
    const appRoot = join(repo, "app");
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        main: "expo-router/entry",
        dependencies: { "expo-router": "6.0.0" },
      }),
      "utf8",
    );

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        EXPO_ROUTER_APP_ROOT: join(root, "repo", "app"),
        TEMP: join(root, "shared-temp"),
        TMP: join(root, "shared-temp"),
        TMPDIR: join(root, "shared-temp"),
        NODE_OPTIONS: "--max-old-space-size=4096 --preserve-symlinks --dns-result-order=verbatim",
      });

      expect(env.EXPO_ROUTER_APP_ROOT).toBe(appRoot);
      expect(env.TEMP).toContain(
        process.platform === "win32" ? WINDOWS_WORKER_SANDBOX_ROOT_NAME : "pushpals-worker-env",
      );
      expect(env.TMP).toBe(env.TEMP);
      expect(env.TMPDIR).toBe(env.TEMP);
      expect(existsSync(env.TEMP)).toBe(true);
      expect(env.NODE_OPTIONS).toBe(
        "--max-old-space-size=4096 --preserve-symlinks --dns-result-order=verbatim",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers src/app and leaves unrelated app directories alone", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-expo-router-"));
    const expoRepo = join(root, "expo-repo");
    const srcAppRoot = join(expoRepo, "src", "app");
    const otherRepo = join(root, "other-repo");
    mkdirSync(srcAppRoot, { recursive: true });
    mkdirSync(join(expoRepo, "app"), { recursive: true });
    mkdirSync(join(otherRepo, "app"), { recursive: true });
    writeFileSync(
      join(expoRepo, "package.json"),
      JSON.stringify({ devDependencies: { "expo-router": "6.0.0" } }),
      "utf8",
    );
    writeFileSync(join(otherRepo, "package.json"), JSON.stringify({ name: "other" }), "utf8");

    try {
      expect(
        buildWorkerSandboxWritableEnv(expoRepo, {
          HOME: join(root, "home"),
        }).EXPO_ROUTER_APP_ROOT,
      ).toBe(srcAppRoot);
      expect(
        buildWorkerSandboxWritableEnv(otherRepo, {
          HOME: join(root, "home"),
        }).EXPO_ROUTER_APP_ROOT,
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves explicit Node DNS and Expo hostname overrides while keeping projected paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        NODE_OPTIONS: "--max-old-space-size=4096 --dns-result-order=verbatim",
        REACT_NATIVE_PACKAGER_HOSTNAME: "localhost",
      });

      expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --dns-result-order=verbatim");
      expect(env.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("localhost");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves explicitly configured Node symlink options without injecting them", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main --dns-result-order=ipv4first",
      });

      expect(env.NODE_OPTIONS).toBe(
        "--preserve-symlinks --preserve-symlinks-main --dns-result-order=ipv4first",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves existing Bun options without injecting global resolver flags", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        BUN_OPTIONS: "--smol",
      });

      expect(env.BUN_OPTIONS).toBe("--smol");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepends job-local node_modules once while preserving existing NODE_PATH entries", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-node-path-"));
    const repo = join(root, "repo");
    const jobNodeModules = join(repo, "node_modules");
    const sharedNodeModules = join(root, "shared-node-modules");
    const otherNodeModules = join(root, "other-node-modules");
    const delimiter = process.platform === "win32" ? ";" : ":";
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        NODE_PATH: [sharedNodeModules, jobNodeModules, otherNodeModules].join(delimiter),
      });

      expect(env.NODE_PATH.split(delimiter)).toEqual([
        jobNodeModules,
        sharedNodeModules,
        otherNodeModules,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves an explicit Playwright browser cache path", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const browserPath = join(root, "browser-cache");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        PLAYWRIGHT_BROWSERS_PATH: browserPath,
      });

      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(browserPath);
      expect(existsSync(browserPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves the Playwright sentinel that disables managed browser downloads", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-playwright-disabled-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(
        repo,
        {
          HOME: join(root, "home"),
          USERPROFILE: join(root, "profile"),
          PLAYWRIGHT_BROWSERS_PATH: "0",
        },
        "win32",
      );

      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("0");
      expect(existsSync(join(repo, "0"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers the bounded Windows profile even when HOME and TEMP are deeply nested", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-profile-priority-"));
    const profile = join(root, "profile");
    const repo = join(root, "repo");
    const longHome = join(root, "legacy-home", "nested".repeat(20));
    const longTemp = join(root, "legacy-temp", "nested".repeat(20));
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(
        repo,
        {
          HOME: longHome,
          USERPROFILE: profile,
          TEMP: longTemp,
          TMP: longTemp,
          TMPDIR: longTemp,
        },
        "win32",
      );
      const sandboxRoot = dirname(env.HOME);

      expect(relative(profile, sandboxRoot).split(sep)[0]).toBe(WINDOWS_WORKER_SANDBOX_ROOT_NAME);
      expect(sandboxRoot).not.toContain("legacy-home");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).not.toContain("legacy-temp");
      expect(sandboxRoot.length - profile.length).toBeLessThan(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to HOME for Windows when USERPROFILE is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-home-fallback-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(
        repo,
        {
          HOME: home,
        },
        "win32",
      );

      expect(relative(home, env.HOME).split(sep)[0]).toBe(WINDOWS_WORKER_SANDBOX_ROOT_NAME);
      expect(env.USERPROFILE).toBe(env.HOME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps Windows roots stable across equivalent path casing and separators", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-casefold-"));
    const profile = join(root, "Profile");
    const repo = join(root, "SectorCommand");
    mkdirSync(repo, { recursive: true });

    try {
      const canonical = resolveWorkerSandboxRoot(repo, "win32", profile);
      const equivalent = resolveWorkerSandboxRoot(
        repo.replace(/\\/g, "/").toUpperCase(),
        "win32",
        profile,
      );

      expect(canonical.toLowerCase()).toBe(equivalent.toLowerCase());
      expect(basename(canonical)).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isolates default Playwright caches between repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-browser-repos-"));
    const profile = join(root, "profile");
    const firstRepo = join(root, "first-repo");
    const secondRepo = join(root, "second-repo");
    mkdirSync(firstRepo, { recursive: true });
    mkdirSync(secondRepo, { recursive: true });

    try {
      const firstEnv = buildWorkerSandboxWritableEnv(
        firstRepo,
        { HOME: profile, USERPROFILE: profile },
        "win32",
      );
      const secondEnv = buildWorkerSandboxWritableEnv(
        secondRepo,
        { HOME: profile, USERPROFILE: profile },
        "win32",
      );

      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).not.toBe(secondEnv.PLAYWRIGHT_BROWSERS_PATH);
      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).toEndWith(`${sep}pw`);
      expect(secondEnv.PLAYWRIGHT_BROWSERS_PATH).toEndWith(`${sep}pw`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves inherited execution flags while replacing writable locations", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-flags-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        EXPO_NO_TELEMETRY: "0",
        EXPO_NO_INTERACTIVE: "0",
        CI: "false",
        BROWSER: "custom-browser",
      });

      expect(env.EXPO_NO_TELEMETRY).toBe("0");
      expect(env.EXPO_NO_INTERACTIVE).toBe("0");
      expect(env.CI).toBe("false");
      expect(env.BROWSER).toBe("custom-browser");
      expect(env.HOME).not.toBe(join(root, "home"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds the sandbox Git safe-directory rule once without erasing existing config", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-gitconfig-"));
    const repo = join(root, "repo");
    const profile = join(root, "profile");
    mkdirSync(repo, { recursive: true });

    try {
      const firstEnv = buildWorkerSandboxWritableEnv(
        repo,
        { HOME: profile, USERPROFILE: profile },
        "win32",
      );
      const gitConfigPath = join(firstEnv.HOME, ".gitconfig");
      writeFileSync(
        gitConfigPath,
        `${readFileSync(gitConfigPath, "utf8")}\n[user]\n\tname = Worker Test\n`,
        "utf8",
      );

      const secondEnv = buildWorkerSandboxWritableEnv(
        repo,
        { HOME: profile, USERPROFILE: profile },
        "win32",
      );
      const gitConfig = readFileSync(join(secondEnv.HOME, ".gitconfig"), "utf8");

      expect(secondEnv.HOME).toBe(firstEnv.HOME);
      expect(gitConfig.match(/directory\s*=\s*\*/g)?.length).toBe(1);
      expect(gitConfig).toContain("name = Worker Test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps Playwright browser cache stable across ephemeral worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const firstWorktree = join(repo, ".worktrees", "job-one");
    const secondWorktree = join(repo, ".worktrees", "job-two");
    mkdirSync(firstWorktree, { recursive: true });
    mkdirSync(secondWorktree, { recursive: true });

    try {
      const firstEnv = buildWorkerSandboxWritableEnv(
        firstWorktree,
        {
          HOME: join(root, "home"),
        },
        "win32",
      );
      const secondEnv = buildWorkerSandboxWritableEnv(
        secondWorktree,
        {
          HOME: join(root, "home"),
        },
        "win32",
      );

      expect(firstEnv.HOME).not.toBe(secondEnv.HOME);
      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(secondEnv.PLAYWRIGHT_BROWSERS_PATH);
      expect(firstEnv.HOME).toContain(WINDOWS_WORKER_SANDBOX_ROOT_NAME);
      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).toEndWith(`${sep}pw`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps Playwright browser cache stable across short Windows worktree pools", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-short-worktree-"));
    const pool = join(root, "ppw", "abcdef123456");
    const firstWorktree = join(pool, "job-one");
    const secondWorktree = join(pool, "job-two");
    mkdirSync(firstWorktree, { recursive: true });
    mkdirSync(secondWorktree, { recursive: true });

    try {
      const firstEnv = buildWorkerSandboxWritableEnv(firstWorktree, {
        HOME: join(root, "home"),
      });
      const secondEnv = buildWorkerSandboxWritableEnv(secondWorktree, {
        HOME: join(root, "home"),
      });

      expect(firstEnv.HOME).not.toBe(secondEnv.HOME);
      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(secondEnv.PLAYWRIGHT_BROWSERS_PATH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isolates Metro temp caches across Expo Router worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-expo-cache-"));
    const repo = join(root, "repo");
    const firstWorktree = join(repo, ".worktrees", "job-one");
    const secondWorktree = join(repo, ".worktrees", "job-two");
    const sharedTemp = join(root, "shared-temp");
    for (const worktree of [firstWorktree, secondWorktree]) {
      mkdirSync(join(worktree, "app"), { recursive: true });
      writeFileSync(
        join(worktree, "package.json"),
        JSON.stringify({
          main: "expo-router/entry",
          dependencies: { "expo-router": "6.0.0" },
        }),
        "utf8",
      );
    }

    try {
      const firstEnv = buildWorkerSandboxWritableEnv(firstWorktree, {
        HOME: join(root, "home"),
        TEMP: sharedTemp,
        TMP: sharedTemp,
        TMPDIR: sharedTemp,
      });
      const secondEnv = buildWorkerSandboxWritableEnv(secondWorktree, {
        HOME: join(root, "home"),
        TEMP: sharedTemp,
        TMP: sharedTemp,
        TMPDIR: sharedTemp,
      });

      expect(firstEnv.TEMP).not.toBe(sharedTemp);
      expect(firstEnv.TEMP).not.toBe(secondEnv.TEMP);
      expect(firstEnv.TMP).toBe(firstEnv.TEMP);
      expect(firstEnv.TMPDIR).toBe(firstEnv.TEMP);
      expect(secondEnv.TMP).toBe(secondEnv.TEMP);
      expect(secondEnv.TMPDIR).toBe(secondEnv.TEMP);
      expect(firstEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(secondEnv.PLAYWRIGHT_BROWSERS_PATH);
      expect(existsSync(firstEnv.TEMP)).toBe(true);
      expect(existsSync(secondEnv.TEMP)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves job-local dependencies without duplicating junctioned Node or Bun modules", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-junction-resolution-"));
    const repo = join(root, "repo");
    const worktree = join(repo, ".worktrees", "job-one");
    const parentPackage = join(repo, "node_modules", "expo");
    const logicalPackage = join(worktree, "node_modules", "expo");
    const jobLocalDependency = join(worktree, "node_modules", "@expo", "cli");
    mkdirSync(join(worktree, "app"), { recursive: true });
    mkdirSync(join(parentPackage, "bin"), { recursive: true });
    mkdirSync(jobLocalDependency, { recursive: true });
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({
        main: "expo-router/entry",
        dependencies: { "expo-router": "6.0.0" },
      }),
      "utf8",
    );
    writeFileSync(
      join(parentPackage, "bin", "resolve-job-local.cjs"),
      'process.stdout.write(require("@expo/cli"));\n',
      "utf8",
    );
    writeFileSync(
      join(worktree, "run-junctioned-package.cjs"),
      'require("./node_modules/expo/bin/resolve-job-local.cjs");\n',
      "utf8",
    );
    writeFileSync(join(jobLocalDependency, "index.js"), 'module.exports = "job-local";\n', "utf8");
    symlinkSync(parentPackage, logicalPackage, process.platform === "win32" ? "junction" : "dir");

    try {
      const env = buildWorkerSandboxWritableEnv(worktree, process.env);
      const result = spawnSync("node", [join(worktree, "run-junctioned-package.cjs")], {
        cwd: worktree,
        env,
        encoding: "utf8",
      });
      const cliResult = spawnSync("node", [join(logicalPackage, "bin", "resolve-job-local.cjs")], {
        cwd: worktree,
        env,
        encoding: "utf8",
      });

      const bunResult = spawnSync(
        process.execPath,
        [join(worktree, "run-junctioned-package.cjs")],
        {
          cwd: worktree,
          env,
          encoding: "utf8",
        },
      );
      const bunCliResult = spawnSync(
        process.execPath,
        [join(logicalPackage, "bin", "resolve-job-local.cjs")],
        {
          cwd: worktree,
          env,
          encoding: "utf8",
        },
      );

      expect(env.NODE_OPTIONS).not.toContain("--preserve-symlinks");
      expect(env.BUN_OPTIONS).toBeUndefined();
      expect(env.NODE_PATH.split(process.platform === "win32" ? ";" : ":")[0]).toBe(
        join(worktree, "node_modules"),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("job-local");
      expect(result.stderr).toBe("");
      expect(cliResult.status).toBe(0);
      expect(cliResult.stdout).toBe("job-local");
      expect(cliResult.stderr).toBe("");
      expect(bunResult.status).toBe(0);
      expect(bunResult.stdout).toBe("job-local");
      expect(bunResult.stderr).toBe("");
      expect(bunCliResult.status).toBe(0);
      expect(bunCliResult.stdout).toBe("job-local");
      expect(bunCliResult.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps one Node module instance across worktree junction and canonical host imports", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-singleton-"));
    const repo = join(root, "repo");
    const worktree = join(repo, ".worktrees", "job-one");
    const hostPackage = join(repo, "node_modules", "vitest");
    const logicalPackage = join(worktree, "node_modules", "vitest");
    mkdirSync(hostPackage, { recursive: true });
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    writeFileSync(join(hostPackage, "index.js"), "module.exports = {};\n", "utf8");
    writeFileSync(
      join(worktree, "compare-module-identity.cjs"),
      [
        'const logical = require("./node_modules/vitest/index.js");',
        `const canonical = require(${JSON.stringify(join(hostPackage, "index.js"))});`,
        'process.stdout.write(logical === canonical ? "same" : "different");',
        "if (logical !== canonical) process.exitCode = 1;",
        "",
      ].join("\n"),
      "utf8",
    );
    symlinkSync(hostPackage, logicalPackage, process.platform === "win32" ? "junction" : "dir");

    try {
      const env = buildWorkerSandboxWritableEnv(worktree, process.env);
      const nodeResult = spawnSync("node", [join(worktree, "compare-module-identity.cjs")], {
        cwd: worktree,
        env,
        encoding: "utf8",
      });
      expect(nodeResult.status).toBe(0);
      expect(nodeResult.stdout).toBe("same");
      expect(nodeResult.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
