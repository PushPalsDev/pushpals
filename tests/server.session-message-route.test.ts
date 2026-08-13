import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
  const dir = mkdtempSync(join(tmpdir(), "pushpals-session-message-route-"));
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

function writeServerConfig(root: string, port: number, serverExtras: string[] = []): void {
  const configDir = join(root, "configs");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "default.toml"),
    [
      'profile = "dev"',
      'session_id = "dev"',
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
      ...serverExtras,
      "",
      "[localbuddy]",
      "enabled = false",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(configDir, "local.example.toml"), "", "utf8");
  writeFileSync(join(configDir, "local.toml"), "", "utf8");
  writeFileSync(join(root, ".env"), "", "utf8");
}

function spawnServer(root: string, port: number): SpawnedServer {
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

  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

describe("server session message route", () => {
  test("returns non-2xx for missing sessions and invalid messages", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const missing = await fetch(`http://127.0.0.1:${port}/sessions/missing/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      code: "session_not_found",
    });

    const created = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "dev" }),
    });
    expect(created.status).toBe(201);

    const invalid = await fetch(`http://127.0.0.1:${port}/sessions/dev/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/ask_remote_buddy" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      ok: false,
      code: "invalid",
    });

    const accepted = await fetch(`http://127.0.0.1:${port}/sessions/dev/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      code: "accepted",
      requestId: expect.any(String),
    });

    const claimed = await fetch(`http://127.0.0.1:${port}/requests/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "remotebuddy-orchestrator" }),
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      ok: true,
      request: {
        sessionId: "dev",
        prompt: "hello",
      },
    });
  }, 15_000);

  test("requires a matching durable autonomy reservation before request enqueue", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    const postJson = (path: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const snapshotResponse = await fetch(
      `http://127.0.0.1:${port}/autonomy/snapshot?sessionId=s_reservation&runId=run_reservation`,
    );
    expect(snapshotResponse.status).toBe(200);
    const snapshotPayload = (await snapshotResponse.json()) as Record<string, unknown>;
    const snapshot = snapshotPayload.snapshot as Record<string, unknown>;
    const snapshotId = String(snapshot.snapshot_id ?? "");
    expect(snapshotId).not.toBe("");

    const objectiveResponse = await postJson("/autonomy/objectives", {
      runId: "run_reservation",
      snapshotId,
      sessionId: "s_reservation",
      objective: {
        id: "obj_route_reservation",
        title: "Reserve route dispatch",
        instruction: "Persist this objective before enqueueing its worker request.",
        objective_type: "small_refactor",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/requests.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test tests/server.requests-queue.test.ts"],
        status: "gated",
      },
    });
    expect(objectiveResponse.status).toBe(200);

    const requestBody = {
      sessionId: "s_reservation",
      prompt: "Execute the durably reserved autonomy objective.",
      priority: "background",
      forceWorker: true,
      forceLane: "worker",
      metadata: {
        origin: "autonomy",
        autonomy: {
          objectiveId: "obj_route_reservation",
          runId: "run_reservation",
          snapshotId,
          patternKey: "route-reservation-pattern",
          componentArea: "apps/server",
          targetPaths: ["apps/server/src/requests.ts"],
          writeGlobs: ["apps/server/src/*.ts"],
          reservationRequired: true,
        },
      },
    };

    const wrongKey = await postJson("/requests/enqueue", {
      ...requestBody,
      idempotencyKey: "autonomy:wrong-objective",
    });
    expect(wrongKey.status).toBe(409);
    expect(await wrongKey.json()).toMatchObject({
      ok: false,
      code: "autonomy_reservation_required",
    });

    const wrongIdentity = await postJson("/requests/enqueue", {
      ...requestBody,
      idempotencyKey: "autonomy:obj_route_reservation",
      metadata: {
        ...requestBody.metadata,
        autonomy: {
          ...requestBody.metadata.autonomy,
          snapshotId: "wrong-snapshot",
        },
      },
    });
    expect(wrongIdentity.status).toBe(409);
    expect(await wrongIdentity.json()).toMatchObject({
      ok: false,
      code: "autonomy_reservation_invalid",
    });

    const accepted = await postJson("/requests/enqueue", {
      ...requestBody,
      idempotencyKey: "autonomy:obj_route_reservation",
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ ok: true, requestId: expect.any(String) });

    const claimed = await postJson("/requests/claim", {
      agentId: "remotebuddy-orchestrator",
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      ok: true,
      request: {
        metadata: {
          origin: "autonomy",
          autonomy: {
            objectiveId: "obj_route_reservation",
            reservationRequired: true,
          },
        },
      },
    });
  }, 15_000);

  test("blocks new session work after the token budget is exceeded", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port, ["session_token_budget = 100"]);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const created = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "dev" }),
    });
    expect(created.status).toBe(201);

    const usage = await fetch(`http://127.0.0.1:${port}/telemetry/llm-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 70,
        completionTokens: 40,
      }),
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      ok: true,
      crossedLimit: true,
      sessionBudget: {
        sessionId: "dev",
        totalTokens: 110,
        exceeded: true,
      },
    });

    const blockedMessage = await fetch(`http://127.0.0.1:${port}/sessions/dev/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "please keep going" }),
    });
    expect(blockedMessage.status).toBe(400);
    expect(await blockedMessage.json()).toMatchObject({
      ok: false,
      code: "enqueue_failed",
      message: expect.stringContaining("Session token budget exceeded"),
    });

    const blockedEnqueue = await fetch(`http://127.0.0.1:${port}/requests/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "dev",
        prompt: "please keep going",
      }),
    });
    expect(blockedEnqueue.status).toBe(429);
    expect(await blockedEnqueue.json()).toMatchObject({
      ok: false,
      code: "session_token_budget_exceeded",
    });
  }, 15_000);

  test("does not pause session work when the session token budget is disabled", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const created = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "dev" }),
    });
    expect(created.status).toBe(201);

    const usage = await fetch(`http://127.0.0.1:${port}/telemetry/llm-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 2_400_000,
        completionTokens: 100_000,
      }),
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      ok: true,
      crossedLimit: false,
      sessionBudget: null,
    });

    const accepted = await fetch(`http://127.0.0.1:${port}/sessions/dev/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "please keep going" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      code: "accepted",
    });
  }, 15_000);
});
