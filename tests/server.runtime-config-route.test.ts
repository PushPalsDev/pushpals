import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalBuddyRuntimeSnapshotFromFiles } from "../packages/shared/src/localbuddy_runtime";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "..");
const bunExecPath = (process.execPath ?? "").trim() || "bun";

type SpawnedServer = {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
  exitCode: number | null;
};

const tempDirs: string[] = [];
const spawnedServers: SpawnedServer[] = [];

afterEach(async () => {
  while (spawnedServers.length > 0) {
    const server = spawnedServers.pop();
    if (!server) continue;
    if (server.exitCode == null) {
      try {
        server.proc.kill();
      } catch {
        // best effort
      }
    }
    try {
      await server.proc.exited;
    } catch {
      // best effort
    }
    await Promise.allSettled([server.stdout, server.stderr]);
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-runtime-route-"));
  tempDirs.push(dir);
  return dir;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function writeServerConfig(root: string, port: number): void {
  const configDir = join(root, "configs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "default.toml"),
    [
      'profile = "dev"',
      "",
      "[paths]",
      'data_dir = "outputs/data"',
      'shared_db_path = "outputs/data/pushpals.db"',
      'remotebuddy_db_path = "outputs/data/remotebuddy-state.db"',
      "",
      "[server]",
      'host = "127.0.0.1"',
      `port = ${port}`,
      `url = "http://127.0.0.1:${port}"`,
      "",
      "[localbuddy]",
      "enabled = false",
      "port = 3003",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(configDir, "local.example.toml"), "", "utf8");
  writeFileSync(join(configDir, "local.toml"), "", "utf8");
  writeFileSync(join(root, ".env"), "", "utf8");
}

function spawnServer(root: string, port: number, authToken: string): SpawnedServer {
  const proc = Bun.spawn(
    [bunExecPath, "run", resolve(repoRoot, "apps/server/src/server_main.ts")],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PUSHPALS_PROJECT_ROOT_OVERRIDE: root,
        PUSHPALS_CONFIG_DIR_OVERRIDE: join(root, "configs"),
        PUSHPALS_PORT: String(port),
        PUSHPALS_AUTH_TOKEN: authToken,
      },
    },
  );

  const server: SpawnedServer = {
    proc,
    stdout: new Response(proc.stdout).text(),
    stderr: new Response(proc.stderr).text(),
    exitCode: null,
  };
  void proc.exited.then((code) => {
    server.exitCode = code;
  });
  spawnedServers.push(server);
  return server;
}

async function waitForHealth(
  server: SpawnedServer,
  port: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      const [stdout, stderr] = await Promise.all([server.stdout, server.stderr]);
      throw new Error(
        `server exited before health check passed (code=${server.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }

  const stdout = server.exitCode != null ? await server.stdout : "";
  const stderr = server.exitCode != null ? await server.stderr : "";
  throw new Error(
    `server did not become healthy within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}

describe("server runtime config route integration", () => {
  test("health bypasses logging and every SQLite operation while retaining origin checks", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);
    const entry = pathToFileURL(resolve(repoRoot, "apps/server/src/server_main.ts")).href;
    const script = `
      const { Database } = await import("bun:sqlite");
      // Isolate the liveness route from unrelated maintenance timer callbacks.
      const timers = [];
      const scheduleInterval = globalThis.setInterval;
      globalThis.setInterval = (...args) => { const timer = scheduleInterval(...args); timers.push(timer); return timer; };
      const { createRequestHandler } = await import(${JSON.stringify(entry)});
      globalThis.setInterval = scheduleInterval;
      for (const timer of timers) clearInterval(timer);
      const server = createRequestHandler();
      let logs = 0, stores = 0;
      for (const method of ["log", "warn", "error"]) console[method] = () => { logs++; throw new Error("logger forbidden in health"); };
      for (const method of ["query", "prepare", "exec", "run", "transaction"]) Database.prototype[method] = () => { stores++; throw new Error("database forbidden in health"); };
      try {
        const response = await fetch("http://127.0.0.1:${port}/healthz", { signal: AbortSignal.timeout(2000) });
        const body = await response.json();
        const denied = await fetch("http://127.0.0.1:${port}/healthz", { headers: { origin: "https://untrusted.example" }, signal: AbortSignal.timeout(2000) });
        const ok = response.status === 200 && body.ok === true && body.diagnostics.service === "server" && denied.status === 403 && logs === 0 && stores === 0;
        process.stdout.write(JSON.stringify({ testHealth: true, ok, logs, stores, status: response.status }) + "\\n");
        await server.stop(true);
        process.exit(ok ? 0 : 1);
      } catch (error) { process.stderr.write(String(error)); process.exit(1); }
    `;
    const proc = Bun.spawn([bunExecPath, "--eval", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PUSHPALS_PROJECT_ROOT_OVERRIDE: root,
        PUSHPALS_CONFIG_DIR_OVERRIDE: join(root, "configs"),
        PUSHPALS_PORT: String(port),
      },
    });
    const server: SpawnedServer = {
      proc,
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
      exitCode: null,
    };
    spawnedServers.push(server);
    const killTimer = setTimeout(() => proc.kill(), 10_000);
    try {
      server.exitCode = await proc.exited;
      const output = await server.stdout;
      expect({ exitCode: server.exitCode, stderr: await server.stderr }).toMatchObject({
        exitCode: 0,
      });
      expect(output).toContain('"testHealth":true,"ok":true,"logs":0,"stores":0,"status":200');
    } finally {
      clearTimeout(killTimer);
    }
  }, 15_000);

  test("POST /config/runtime applies LocalBuddy env aliases and exposes correct restart warnings", async () => {
    const root = makeTempDir();
    const authToken = "runtime-route-token";
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port, authToken);
    await waitForHealth(server, port);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      diagnostics: {
        running: true,
        sampleIntervalMs: 1_000,
        slowThresholdMs: 1_000,
        recentSlowEvents: expect.any(Array),
      },
    });
    expect(JSON.stringify(healthBody)).not.toContain(authToken);

    const response = await fetch(`http://127.0.0.1:${port}/config/runtime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        updates: [
          { scope: "env", key: "LOCALBUDDY_ENABLED", value: true },
          { scope: "env", key: "LOCAL_AGENT_PORT", value: 4111 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      restartRequired: boolean;
      restartRequiredKeys: string[];
      warnings: string[];
    };

    expect(payload.ok).toBe(true);
    expect(payload.restartRequired).toBe(true);
    expect(payload.restartRequiredKeys).toEqual(["LOCAL_AGENT_PORT"]);
    expect(payload.warnings).toContain(
      "localbuddy.enabled applies live when the stack is managed by bun run start or the VS Code stack manager; other supervisors may require restart.",
    );
    expect(payload.warnings).toContain(
      "LocalBuddy config changes other than localbuddy.enabled require a LocalBuddy restart to take effect.",
    );

    expect(readFileSync(join(root, ".env"), "utf8")).toContain("LOCALBUDDY_ENABLED=true");
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("LOCAL_AGENT_PORT=4111");

    const snapshot = loadLocalBuddyRuntimeSnapshotFromFiles(root, {
      LOCALBUDDY_ENABLED: "false",
      LOCAL_AGENT_PORT: "3003",
    });
    expect(snapshot).toEqual({
      localbuddy: {
        enabled: true,
        port: 4111,
      },
    });

    const shutdown = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ reason: "test shutdown" }),
    });
    expect(shutdown.status).toBe(202);
    await server.proc.exited;
  });
});
