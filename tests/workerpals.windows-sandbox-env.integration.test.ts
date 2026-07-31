import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, relative, sep } from "path";

import { resolveDirectWorktreePath } from "../apps/workerpals/src/common/direct_worktree";
import {
  buildWorkerSandboxWritableEnv,
  WINDOWS_WORKER_SANDBOX_ROOT_NAME,
} from "../apps/workerpals/src/common/sandbox_env";

const windowsTest = process.platform === "win32" ? test : test.skip;

const WRITABLE_DIRECTORY_KEYS = [
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "EXPO_HOME",
  "npm_config_cache",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PSModuleAnalysisCachePath",
] as const;

function createExpoRepo(repo: string): void {
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "windows-sandbox-path-probe",
      main: "expo-router/entry",
      dependencies: { "expo-router": "6.0.0" },
    }),
    "utf8",
  );
}

function writeEnvironmentProbe(root: string): string {
  const probePath = join(root, "probe.cjs");
  writeFileSync(
    probePath,
    [
      'const { mkdirSync, writeFileSync } = require("fs");',
      `const keys = ${JSON.stringify(WRITABLE_DIRECTORY_KEYS)};`,
      'const label = process.argv[2] || "probe";',
      "const observed = {};",
      "for (const key of keys) {",
      "  const value = process.env[key];",
      '  if (!value || value === "0") continue;',
      "  mkdirSync(value, { recursive: true });",
      '  writeFileSync(require("path").join(value, `${label}-${key}.txt`), key, "utf8");',
      "  observed[key] = value;",
      "}",
      "process.stdout.write(JSON.stringify(observed));",
      "",
    ].join("\n"),
    "utf8",
  );
  return probePath;
}

function runEnvironmentProbe(
  probePath: string,
  label: string,
  env: Record<string, string>,
): Record<string, string> {
  const result = Bun.spawnSync([process.execPath, probePath, label], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(result.stderr ?? []).toString("utf8");
  expect(result.exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as Record<string, string>;
}

function expectCompactWindowsEnvironment(
  env: Record<string, string>,
  profile: string,
  repo: string,
): void {
  const sandboxRoot = dirname(env.HOME);
  expect(relative(profile, sandboxRoot).split(sep)).toEqual([
    WINDOWS_WORKER_SANDBOX_ROOT_NAME,
    expect.stringMatching(/^[a-f0-9]{12}$/),
  ]);
  expect(relative(profile, sandboxRoot).length).toBeLessThan(20);
  expect(env.HOME).not.toContain("pushpals-worker-env");
  expect(env.HOME.toLowerCase()).not.toContain(repo.toLowerCase());

  for (const key of WRITABLE_DIRECTORY_KEYS) {
    const value = env[key];
    expect(value, key).toBeTruthy();
    expect(isAbsolute(value), `${key}=${value}`).toBe(true);
    expect(relative(profile, value).split(sep)[0], `${key}=${value}`).toBe(
      WINDOWS_WORKER_SANDBOX_ROOT_NAME,
    );
    expect(relative(profile, value).length, `${key}=${value}`).toBeLessThan(90);
  }
}

describe("Windows WorkerPal sandbox environment integration", () => {
  windowsTest(
    "propagates compact writable paths into a real Bun child process",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-windows-env-child-"));
      const profile = join(root, "profile");
      const repo = join(
        root,
        "repository-parent-with-an-intentionally-long-name",
        "another-intentionally-long-parent-for-max-path-pressure",
        "SectorCommand",
      );
      const inheritedTemp = join(root, "legacy", "pushpals-worker-env", "job-with-a-long-id");
      createExpoRepo(repo);
      const probePath = writeEnvironmentProbe(root);

      try {
        const env = buildWorkerSandboxWritableEnv(
          repo,
          {
            ...process.env,
            HOME: join(root, "legacy-home-with-an-intentionally-long-name"),
            USERPROFILE: profile,
            TEMP: inheritedTemp,
            TMP: inheritedTemp,
            TMPDIR: inheritedTemp,
          },
          "win32",
        );
        const observed = runEnvironmentProbe(probePath, "child", env);

        expectCompactWindowsEnvironment(env, profile, repo);
        expect(observed).toEqual(
          Object.fromEntries(WRITABLE_DIRECTORY_KEYS.map((key) => [key, env[key]])),
        );
        expect(env.TEMP).toBe(env.TMP);
        expect(env.TEMP).toBe(env.TMPDIR);
        expect(env.TEMP).not.toBe(inheritedTemp);
        for (const [key, value] of Object.entries(observed)) {
          expect(readFileSync(join(value, `child-${key}.txt`), "utf8")).toBe(key);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  windowsTest(
    "isolates three direct worker jobs while sharing only the repository browser cache",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-windows-env-jobs-"));
      const profile = join(root, "profile");
      const repo = join(root, "SectorCommand");
      const probePath = writeEnvironmentProbe(root);
      const envs: Record<string, string>[] = [];

      try {
        for (let index = 0; index < 3; index += 1) {
          const worktree = resolveDirectWorktreePath(
            repo,
            `12345678-aaaa-bbbb-cccc-${String(index).padStart(12, "0")}`,
            `long-nonce-${index}-with-extra-characters`,
            "win32",
            profile,
          );
          createExpoRepo(worktree);
          const env = buildWorkerSandboxWritableEnv(
            worktree,
            {
              ...process.env,
              HOME: join(root, "legacy-home"),
              USERPROFILE: profile,
              TEMP: join(root, "legacy-temp", `job-${index}`),
            },
            "win32",
          );
          envs.push(env);
          runEnvironmentProbe(probePath, `job-${index}`, env);

          expect(relative(profile, worktree).split(sep)[0]).toBe(".ppw");
          expect(relative(profile, worktree).length).toBeLessThan(50);
          expectCompactWindowsEnvironment(env, profile, worktree);
        }

        expect(new Set(envs.map((env) => env.HOME)).size).toBe(3);
        expect(new Set(envs.map((env) => env.TEMP)).size).toBe(3);
        expect(new Set(envs.map((env) => env.PLAYWRIGHT_BROWSERS_PATH)).size).toBe(1);
        for (let index = 0; index < envs.length; index += 1) {
          expect(existsSync(join(envs[index].TEMP, `job-${index}-TEMP.txt`))).toBe(true);
          for (let other = 0; other < envs.length; other += 1) {
            if (other === index) continue;
            expect(existsSync(join(envs[index].TEMP, `job-${other}-TEMP.txt`))).toBe(false);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  windowsTest(
    "keeps worst-case worktree and hot-cache paths bounded across repeated jobs",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-windows-env-stress-"));
      const profile = join(root, "profile");
      const repo = join(
        root,
        "very-long-repository-parent".repeat(3),
        "SectorCommand-with-a-long-repository-name",
      );
      const sandboxHomes = new Set<string>();
      const browserCaches = new Set<string>();

      try {
        for (let index = 0; index < 24; index += 1) {
          const worktree = resolveDirectWorktreePath(
            repo,
            `${index.toString(16).padStart(8, "f")}-7986-46b1-891f-e66983cac5b7`,
            `nonce-${index}-abcdefghijklmnopqrstuvwxyz`,
            "win32",
            profile,
          );
          createExpoRepo(worktree);
          const env = buildWorkerSandboxWritableEnv(
            worktree,
            {
              ...process.env,
              HOME: join(root, "legacy-home".repeat(12)),
              USERPROFILE: profile,
              TEMP: join(root, "legacy-temp".repeat(12), `job-${index}`),
            },
            "win32",
          );

          expectCompactWindowsEnvironment(env, profile, worktree);
          expect(relative(profile, env.TEMP).length).toBeLessThan(25);
          expect(relative(profile, env.PLAYWRIGHT_BROWSERS_PATH).length).toBeLessThan(25);
          sandboxHomes.add(env.HOME);
          browserCaches.add(env.PLAYWRIGHT_BROWSERS_PATH);
        }

        expect(sandboxHomes.size).toBe(24);
        expect(browserCaches.size).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  windowsTest(
    "recreates the same complete sandbox after job cleanup without retaining stale files",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-windows-env-recreate-"));
      const profile = join(root, "profile");
      const repo = join(root, "SectorCommand");
      const probePath = writeEnvironmentProbe(root);
      createExpoRepo(repo);

      try {
        const sourceEnv = {
          ...process.env,
          HOME: join(root, "legacy-home"),
          USERPROFILE: profile,
          TEMP: join(root, "legacy-temp"),
        };
        const first = buildWorkerSandboxWritableEnv(repo, sourceEnv, "win32");
        runEnvironmentProbe(probePath, "first", first);
        const sandboxRoot = dirname(first.HOME);
        const staleMarker = join(first.TEMP, "first-TEMP.txt");
        expect(existsSync(staleMarker)).toBe(true);

        rmSync(sandboxRoot, { recursive: true, force: true });
        expect(existsSync(staleMarker)).toBe(false);

        const second = buildWorkerSandboxWritableEnv(repo, sourceEnv, "win32");
        const observed = runEnvironmentProbe(probePath, "second", second);
        expectCompactWindowsEnvironment(second, profile, repo);
        expect(
          Object.fromEntries(WRITABLE_DIRECTORY_KEYS.map((key) => [key, second[key]])),
        ).toEqual(Object.fromEntries(WRITABLE_DIRECTORY_KEYS.map((key) => [key, first[key]])));
        expect(observed).toEqual(
          Object.fromEntries(WRITABLE_DIRECTORY_KEYS.map((key) => [key, second[key]])),
        );
        expect(existsSync(staleMarker)).toBe(false);
        expect(
          readFileSync(join(second.HOME, ".gitconfig"), "utf8").match(/directory\s*=\s*\*/g),
        ).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  windowsTest(
    "keeps many repositories collision-free even with long and unusual names",
    () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-windows-env-repos-"));
      const profile = join(root, "profile");
      const sandboxHomes = new Set<string>();
      const browserCaches = new Set<string>();

      try {
        for (let index = 0; index < 48; index += 1) {
          const repo = join(
            root,
            `${index.toString().padStart(2, "0")}-Sector Command-${"long parent ".repeat(4)}-测试`,
          );
          createExpoRepo(repo);
          const env = buildWorkerSandboxWritableEnv(
            repo,
            {
              ...process.env,
              HOME: join(root, "legacy-home"),
              USERPROFILE: profile,
              TEMP: join(root, "legacy-temp", String(index)),
            },
            "win32",
          );

          expectCompactWindowsEnvironment(env, profile, repo);
          sandboxHomes.add(env.HOME.toLowerCase());
          browserCaches.add(env.PLAYWRIGHT_BROWSERS_PATH.toLowerCase());
        }

        expect(sandboxHomes.size).toBe(48);
        expect(browserCaches.size).toBe(48);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
