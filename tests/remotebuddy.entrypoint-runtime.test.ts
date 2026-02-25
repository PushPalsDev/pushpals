import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bootstrapRuntime, resolveRuntimeArgs } from "../packages/shared/src/runtime";
import { loadPushPalsConfig, type PushPalsConfig } from "../packages/shared/src/config";

const REPO_ROOT = process.cwd();
const APPS_REMOTEBUDDY_DIR = join(REPO_ROOT, "apps", "remotebuddy");
const SUPERVISOR_CHILD = join(REPO_ROOT, "tests", "fixtures", "remotebuddy_supervisor_child.ts");
const BUN_BIN = process.execPath || "bun";

async function runRemoteBuddyEntrypointDump({
  forwardedArgs = [],
  env = {},
}: {
  forwardedArgs?: string[];
  env?: Record<string, string | undefined>;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), "remotebuddy-runtime-dump-"));
  const dumpPath = join(tempDir, "runtime.json");
  const proc = Bun.spawn([BUN_BIN, "run", "src/remotebuddy_main.ts", "--", ...forwardedArgs], {
    cwd: APPS_REMOTEBUDDY_DIR,
    env: {
      ...process.env,
      REMOTEBUDDY_RUNTIME_DUMP_PATH: dumpPath,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    if (!proc.stdout || !proc.stderr) {
      throw new Error("Entrypoint stdout/stderr not piped");
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `RemoteBuddy entrypoint exited with ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
      );
    }
    const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
    return dump;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (!proc.killed) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }
}

function cloneConfig(): PushPalsConfig {
  return JSON.parse(JSON.stringify(loadPushPalsConfig({ reload: true }))) as PushPalsConfig;
}

describe("RemoteBuddy runtime bootstrap", () => {
  test("CLI args override env/config defaults", () => {
    const env = {
      REMOTEBUDDY_SERVER_URL: "http://env-server:3100",
      REMOTEBUDDY_SESSION_ID: "env-session",
      REMOTEBUDDY_AUTH_TOKEN: "env-token",
    } as Record<string, string | undefined>;

    const result = resolveRuntimeArgs({
      argv: [
        "--server",
        " https://cli.example:3001 ",
        "--sessionId",
        " cli-session ",
        "--token",
        "cli-token",
      ],
      env,
      defaults: {
        server: "http://config-server:1234",
        sessionId: "config-session",
        authToken: "config-token",
      },
    });

    expect(result.server).toBe("https://cli.example:3001");
    expect(result.sessionId).toBe("cli-session");
    expect(result.authToken).toBe("cli-token");
    expect(result.rest).toEqual([]);
  });

  test("env fallbacks apply when CLI is absent and blank tokens normalize to null", () => {
    const env = {
      REMOTEBUDDY_SERVER_URL: " https://env-only.example:9999/ ",
      REMOTEBUDDY_SESSION_ID: " env-session ",
      REMOTEBUDDY_AUTH_TOKEN: "   ",
    } as Record<string, string | undefined>;

    const result = resolveRuntimeArgs({
      argv: [],
      env,
      defaults: {
        server: "http://config-server:8000",
        sessionId: "config-session",
        authToken: "config-token",
      },
    });

    expect(result.server).toBe("https://env-only.example:9999/");
    expect(result.sessionId).toBe("env-session");
    expect(result.authToken).toBeNull();
  });

  test("blank CLI overrides clear token and session ids", () => {
    const result = resolveRuntimeArgs({
      argv: ["--token", " ", "--sessionId", ""],
      defaults: {
        server: "http://config-server:7000",
        sessionId: "config-session",
        authToken: "config-token",
      },
    });

    expect(result.sessionId).toBeNull();
    expect(result.authToken).toBeNull();
    expect(result.server).toBe("http://config-server:7000");
  });

  test("bootstrapRuntime enforces session requirement when configured", async () => {
    const config = cloneConfig();
    config.sessionId = "";

    await expect(
      bootstrapRuntime({
        config,
        requireSessionInput: true,
        ensureSession: false,
      }),
    ).rejects.toThrow(/Session ID is required/);
  });

  test("bootstrapRuntime invokes ensureSessionImpl when enabled", async () => {
    const config = cloneConfig();
    config.sessionId = "config-session";
    const calls: Array<{ server: string; sessionId: string | null }> = [];

    const result = await bootstrapRuntime({
      config,
      argv: ["--sessionId", " cli-session "],
      ensureSession: {
        enabled: true,
        logLabel: "RuntimeTest",
      },
      ensureSessionImpl: async (serverUrl, options) => {
        calls.push({ server: serverUrl, sessionId: options.sessionId ?? null });
        return "ensured-session";
      },
    });

    expect(result.sessionId).toBe("ensured-session");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      server: config.server.url,
      sessionId: "cli-session",
    });
  });

  test("bootstrapRuntime prefers CLI over env and config for server/token", async () => {
    const config = cloneConfig();
    config.server.url = "http://config-server:8100";
    config.authToken = "config-token";

    const result = await bootstrapRuntime({
      config,
      argv: ["--server", " https://cli-override:9999 ", "--token", " cli-token "],
      env: {
        REMOTEBUDDY_SERVER_URL: "http://env-server:3100",
        REMOTEBUDDY_AUTH_TOKEN: "env-token",
      },
      ensureSession: false,
    });

    expect(result.runtime.server).toBe("https://cli-override:9999");
    expect(result.runtime.authToken).toBe("cli-token");
    expect(result.runtime.rest).toEqual([]);
  });
});

describe("RemoteBuddy supervisor", () => {
  test("propagates runtime args and restarts consistently", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remotebuddy-supervisor-"));
    const logPath = join(tempDir, "invocations.log");
    const counterPath = join(tempDir, "counter.txt");
    writeFileSync(logPath, "", "utf8");
    writeFileSync(counterPath, "0", "utf8");
    const tempNodeModules = join(tempDir, "node_modules");
    mkdirSync(tempNodeModules, { recursive: true });
    const sharedLink = join(tempNodeModules, "shared");
    try {
      symlinkSync(join(REPO_ROOT, "packages", "shared"), sharedLink, "dir");
    } catch {
      // ignore if it already exists
    }
    const repoNodeModules = join(REPO_ROOT, "node_modules");
    mkdirSync(repoNodeModules, { recursive: true });
    const createdRepoLinks: string[] = [];
    for (const pkg of ["shared", "protocol"]) {
      const target = join(REPO_ROOT, "packages", pkg);
      const link = join(repoNodeModules, pkg);
      if (!existsSync(link)) {
        try {
          symlinkSync(target, link, "dir");
          createdRepoLinks.push(link);
        } catch {
          // ignore inability to create link
        }
      }
    }

    const forwardedArgs = [
      "--server",
      " https://cli-forward.example:3101 ",
      "--sessionId",
      " test-session ",
      "--token",
      " test-token ",
      "--",
      "--raw-flag",
      "value",
    ];

    const nodePathEntries = [process.env.NODE_PATH?.trim(), tempNodeModules].filter(Boolean);
    const proc = Bun.spawn(
      [BUN_BIN, "run", "src/remotebuddy_supervisor.ts", "--", ...forwardedArgs],
      {
        cwd: APPS_REMOTEBUDDY_DIR,
        env: {
          ...process.env,
          NODE_PATH: nodePathEntries.join(":"),
          REMOTEBUDDY_SUPERVISOR_CHILD: SUPERVISOR_CHILD,
          REMOTEBUDDY_SUPERVISOR_CHILD_LOG: logPath,
          REMOTEBUDDY_SUPERVISOR_CHILD_COUNTER: counterPath,
          REMOTEBUDDY_SUPERVISOR_CHILD_FAILS: "1",
          REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS: "5",
          REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS: "3",
          REMOTEBUDDY_SERVER_URL: "http://env-server:3200",
          REMOTEBUDDY_SESSION_ID: "env-session",
          REMOTEBUDDY_AUTH_TOKEN: "env-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    try {
      if (!proc.stdout || !proc.stderr) {
        throw new Error("Supervisor stdout/stderr not piped");
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`Supervisor failed: ${exitCode}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
      }

      const lines = readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      expect(lines.length).toBe(2);

      const entries = lines.map(
        (line) => JSON.parse(line) as { args: string[]; attempt: number; runtime: any },
      );
      expect(entries.map((entry) => entry.attempt)).toEqual([1, 2]);
      for (const entry of entries) {
        expect(entry.args).toEqual(forwardedArgs);
        expect(entry.runtime.server).toBe("https://cli-forward.example:3101");
        expect(entry.runtime.sessionId).toBe("test-session");
        expect(entry.runtime.authToken).toBe("test-token");
        expect(entry.runtime.rest).toEqual(["--raw-flag", "value"]);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (!proc.killed) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
      for (const link of createdRepoLinks) {
        try {
          rmSync(link);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  });
});
describe("RemoteBuddy entrypoint integration", () => {
  test("records CLI overrides and rest args", async () => {
    const dump = await runRemoteBuddyEntrypointDump({
      forwardedArgs: [
        "--server",
        " https://cli.test:3001 ",
        "--sessionId",
        " cli-session ",
        "--token",
        " cli-token ",
        "--",
        "--raw-flag",
        "value",
      ],
    });
    expect(dump.server).toBe("https://cli.test:3001");
    expect(dump.sessionId).toBe("cli-session");
    expect(dump.authToken).toBe("cli-token");
    expect(dump.rest).toEqual(["--raw-flag", "value"]);
  });

  test("falls back to env values when CLI args are absent", async () => {
    const dump = await runRemoteBuddyEntrypointDump({
      env: {
        REMOTEBUDDY_SERVER_URL: " http://env-only:3100 ",
        REMOTEBUDDY_SESSION_ID: " env-session ",
        REMOTEBUDDY_AUTH_TOKEN: " env-token ",
      },
    });
    expect(dump.server).toBe("http://env-only:3100");
    expect(dump.sessionId).toBe("env-session");
    expect(dump.authToken).toBe("env-token");
    expect(dump.rest).toEqual([]);
  });

  test("blank CLI overrides clear session/token inputs", async () => {
    const dump = await runRemoteBuddyEntrypointDump({
      forwardedArgs: ["--server", "http://cli-blank:3200", "--token", " ", "--sessionId", ""],
    });
    expect(dump.server).toBe("http://cli-blank:3200");
    expect(dump.authToken).toBeNull();
    expect(dump.sessionId).toBe("stub-session");
    expect(dump.rest).toEqual([]);
  });
});
