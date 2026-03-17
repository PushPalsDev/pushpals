import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CommunicationManager } from "../packages/shared/src/communication";

const repoRoot = resolve(import.meta.dir, "..");
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
  const dir = mkdtempSync(join(tmpdir(), "pushpals-client-presence-"));
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
  const proc = Bun.spawn([bunExecPath, "run", resolve(repoRoot, "apps/server/src/server_main.ts")], {
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
  });

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

async function waitForHealth(server: SpawnedServer, port: number, timeoutMs = 10_000): Promise<void> {
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

  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function fetchSystemStatus(port: number, authToken: string): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/system/status`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(response.status).toBe(200);
  return await response.json();
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("websocket open timeout")), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("websocket error"));
    });
  });
}

async function waitForClose(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolveClose) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolveClose();
      return;
    }
    ws.addEventListener("close", () => resolveClose(), { once: true });
  });
}

async function waitForConnectedClientCount(
  port: number,
  authToken: string,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchSystemStatus(port, authToken);
    if (Number(status?.clients?.connected ?? -1) === expectedCount) {
      return status;
    }
    await Bun.sleep(100);
  }
  return await fetchSystemStatus(port, authToken);
}

async function openSseStream(url: string, authToken: string): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  const reader = response.body!.getReader();
  await reader.read();
  return {
    reader,
    abort: () => controller.abort(),
  };
}

describe("server client presence route integration", () => {
  test(
    "system status exposes unified client presence across SSE connect and disconnect",
    async () => {
    const root = makeTempDir();
    const authToken = "presence-token-sse";
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port, authToken);
    await waitForHealth(server, port);

    const createResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sessionId: "demo",
        client: {
          clientId: "web-1",
          kind: "web",
          label: "Web Client",
        },
      }),
    });
    expect(createResponse.status).toBe(201);

    const sseQuery = new URLSearchParams({
      clientId: "web-stream-1",
      clientKind: "web",
      clientLabel: "Web Client",
      clientVersion: "1.0.0",
      clientPlatform: "web",
    });
    const { reader, abort } = await openSseStream(
      `http://127.0.0.1:${port}/sessions/demo/events?${sseQuery.toString()}`,
      authToken,
    );

    const duringSse = await waitForConnectedClientCount(port, authToken, 1);
    expect(duringSse.clients.items.find((item: any) => item.clientId === "web-stream-1")).toMatchObject({
      clientId: "web-stream-1",
      kind: "web",
      status: "connected",
      connectedTransports: ["sse"],
    });

    await reader.cancel();
    abort();
    const afterClose = await waitForConnectedClientCount(port, authToken, 0);
    expect(afterClose.clients.items.find((item: any) => item.clientId === "web-stream-1")).toMatchObject({
      clientId: "web-stream-1",
      status: "announced",
      connectedTransports: [],
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
    },
    15_000,
  );

  test(
    "system status exposes unified client presence across session announce and websocket connect",
    async () => {
    const root = makeTempDir();
    const authToken = "presence-token";
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port, authToken);
    await waitForHealth(server, port);

    const createResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sessionId: "demo",
        client: {
          clientId: "web-1",
          kind: "web",
          label: "Web Client",
          version: "1.0.0",
          platform: "web",
        },
      }),
    });
    expect(createResponse.status).toBe(201);

    const afterCreate = await fetchSystemStatus(port, authToken);
    expect(afterCreate.clients.total).toBe(1);
    expect(afterCreate.clients.connected).toBe(0);
    expect(afterCreate.clients.byKind).toEqual({ web: 1 });
    expect(afterCreate.clients.items[0]).toMatchObject({
      clientId: "web-1",
      kind: "web",
      status: "announced",
      sessionId: "demo",
      connectedTransports: [],
    });

    const query = new URLSearchParams({
      after: "0",
      authToken,
      clientId: "vscode-demo",
      clientKind: "vscode",
      clientLabel: "VS Code",
      clientVersion: "0.2.0",
      clientPlatform: "win32/x64",
      clientRepoRoot: "C:/repo/demo",
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/demo/ws?${query.toString()}`);
    await waitForOpen(ws);
    await Bun.sleep(150);

    const duringWs = await waitForConnectedClientCount(port, authToken, 1);
    expect(duringWs.clients.total).toBe(2);
    expect(duringWs.clients.connected).toBe(1);
    expect(duringWs.clients.byKind).toEqual({ vscode: 1, web: 1 });
    expect(duringWs.clients.items.find((item: any) => item.clientId === "vscode-demo")).toMatchObject({
      clientId: "vscode-demo",
      kind: "vscode",
      status: "connected",
      sessionId: "demo",
      connectedTransports: ["ws"],
      repoRoot: "C:/repo/demo",
    });

    ws.close();
    await waitForClose(ws);
    const afterClose = await waitForConnectedClientCount(port, authToken, 0);
    expect(afterClose.clients.total).toBe(2);
    expect(afterClose.clients.connected).toBe(0);
    expect(afterClose.clients.items.find((item: any) => item.clientId === "vscode-demo")).toMatchObject({
      clientId: "vscode-demo",
      status: "announced",
      connectedTransports: [],
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
    },
    15_000,
  );

  test(
    "system status tracks agent websocket presence from CommunicationManager subscribers",
    async () => {
      const root = makeTempDir();
      const authToken = "presence-token-agent";
      const port = await getFreePort();
      writeServerConfig(root, port);

      const server = spawnServer(root, port, authToken);
      await waitForHealth(server, port);

      const createResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ sessionId: "dev" }),
      });
      expect(createResponse.status).toBe(201);

      const comm = new CommunicationManager({
        serverUrl: `http://127.0.0.1:${port}`,
        sessionId: "dev",
        from: "agent:remotebuddy-orchestrator",
      });
      const stop = comm.subscribeSessionEvents(() => {});

      const duringWs = await waitForConnectedClientCount(port, authToken, 1);
      expect(
        duringWs.clients.items.find((item: any) => item.clientId === "remotebuddy-orchestrator"),
      ).toMatchObject({
        clientId: "remotebuddy-orchestrator",
        kind: "agent",
        status: "connected",
        sessionId: "dev",
        connectedTransports: ["ws"],
      });

      stop();
      const afterClose = await waitForConnectedClientCount(port, authToken, 0);
      expect(
        afterClose.clients.items.find((item: any) => item.clientId === "remotebuddy-orchestrator"),
      ).toMatchObject({
        clientId: "remotebuddy-orchestrator",
        status: "announced",
        connectedTransports: [],
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
    },
    15_000,
  );
});
