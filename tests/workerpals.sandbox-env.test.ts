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
import { dirname, join, resolve } from "path";
import {
  buildWorkerSandboxWritableEnv,
  resolveBunExecutableFromEnv,
  withResolvedBunOnPath,
} from "../apps/workerpals/src/common/sandbox_env";

describe("workerpals sandbox writable env", () => {
  test("redirects HOME and Expo caches to writable temp paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: "/root",
        PATH: "test-path",
      });

      expect(env.PATH.endsWith("test-path")).toBe(true);
      expect(env.HOME).not.toBe("/root");
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.EXPO_HOME).toContain("pushpals-worker-env");
      expect(env.XDG_CACHE_HOME).toContain("pushpals-worker-env");
      expect(env.npm_config_cache).toContain("npm");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toContain("playwright-browsers");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).not.toBe(env.XDG_CACHE_HOME);
      expect(env.EXPO_NO_TELEMETRY).toBe("1");
      expect(env.EXPO_NO_INTERACTIVE).toBe("1");
      expect(env.CI).toBe("1");
      expect(env.BROWSER).toBe("none");
      expect(env.NODE_OPTIONS).toContain("--dns-result-order=ipv4first");
      expect(env.NODE_OPTIONS).toContain("--preserve-symlinks");
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
      expect(env.TEMP).toContain("pushpals-worker-env");
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

      expect(env.NODE_OPTIONS).toBe(
        "--max-old-space-size=4096 --dns-result-order=verbatim --preserve-symlinks",
      );
      expect(env.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("localhost");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not duplicate the required Node symlink option", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });

    try {
      const env = buildWorkerSandboxWritableEnv(repo, {
        HOME: join(root, "home"),
        NODE_OPTIONS: "--preserve-symlinks --dns-result-order=ipv4first",
      });

      expect(env.NODE_OPTIONS).toBe("--preserve-symlinks --dns-result-order=ipv4first");
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

  test("keeps Playwright browser cache stable across ephemeral worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-sandbox-env-"));
    const repo = join(root, "repo");
    const firstWorktree = join(repo, ".worktrees", "job-one");
    const secondWorktree = join(repo, ".worktrees", "job-two");
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

  test("resolves job-local dependencies through junctioned parent packages", () => {
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
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("job-local");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
