import { afterEach, describe, expect, test } from "bun:test";
import type { PlannerOutput } from "../apps/remotebuddy/src/brain";
import { IdempotencyStore } from "../apps/remotebuddy/src/idempotency";
import { NoopSessionMemory } from "../apps/remotebuddy/src/memory";
import { RemoteBuddyOrchestrator } from "../apps/remotebuddy/src/remotebuddy_main";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import type { EventEnvelope } from "protocol";

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
const openSockets = new Set<WebSocket>();
const openStores: IdempotencyStore[] = [];

afterEach(async () => {
  for (const socket of openSockets) {
    try {
      socket.close();
    } catch {
      // best effort
    }
  }
  openSockets.clear();

  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // best effort
    }
  }

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
    await removeDirWithRetry(dir);
  }
});

async function removeDirWithRetry(dir: string, attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(50 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-remotebuddy-session-routing-"));
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
  const proc = Bun.spawn([bunExecPath, "run", resolve(repoRoot, "apps/server/src/server_main.ts")], {
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

async function createSession(port: number, sessionId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  expect(response.status).toBe(201);
}

async function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("websocket open timed out")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolveOpen();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      rejectOpen(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function connectSessionSocket(port: number, sessionId: string, clientId: string): {
  ws: WebSocket;
  events: EventEnvelope[];
} {
  const query = new URLSearchParams({
    after: "0",
    clientId,
    clientKind: "test",
    clientLabel: "Test Client",
    clientPlatform: `${process.platform}/${process.arch}`,
    clientRepoRoot: repoRoot,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sessions/${sessionId}/ws?${query.toString()}`);
  const events: EventEnvelope[] = [];
  openSockets.add(ws);
  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as {
        envelope?: EventEnvelope;
      };
      const envelope = parsed.envelope ?? (parsed as unknown as EventEnvelope);
      events.push(envelope);
    } catch {
      // ignore malformed frames in tests
    }
  });
  return { ws, events };
}

async function waitForEvent(
  events: EventEnvelope[],
  predicate: (event: EventEnvelope) => boolean,
  timeoutMs = 5_000,
): Promise<EventEnvelope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) return match;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for matching event after ${timeoutMs}ms`);
}

function createDirectReplyPlan(text: string): PlannerOutput {
  return {
    intent: "chat",
    requires_worker: false,
    job_kind: "none",
    lane: "deterministic",
    scope: {
      read_anywhere: true,
      write_allowed: false,
    },
    discovery: {
      ripgrep_queries: [],
    },
    acceptance_criteria: ["Provide a direct answer."],
    validation_steps: ["No-op"],
    risk_level: "low",
    assistant_message: text,
    worker_instruction: "",
    user_message: text,
  };
}

describe("RemoteBuddy session routing", () => {
  test("claimed requests reply on the request session instead of the runtime default session", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    await createSession(port, "dev");
    await createSession(port, "session-a");

    const defaultSocket = connectSessionSocket(port, "dev", "test-default");
    const requestSocket = connectSessionSocket(port, "session-a", "test-session-a");
    await Promise.all([waitForOpen(defaultSocket.ws), waitForOpen(requestSocket.ws)]);

    const accepted = await fetch(`http://127.0.0.1:${port}/sessions/session-a/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from session a" }),
    });
    expect(accepted.status).toBe(200);

    const claimed = await fetch(`http://127.0.0.1:${port}/requests/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "remotebuddy-orchestrator" }),
    });
    const claimedBody = (await claimed.json()) as {
      ok: boolean;
      request?: {
        id: string;
        sessionId?: string;
        prompt: string;
      };
      queueWaitMs?: number;
    };
    expect(claimed.status).toBe(200);
    expect(claimedBody).toMatchObject({
      ok: true,
      request: {
        sessionId: "session-a",
        prompt: "hello from session a",
      },
    });

    const idempotency = new IdempotencyStore(join(root, "outputs", "data", "remotebuddy-test.db"));
    openStores.push(idempotency);
    const orchestrator = new RemoteBuddyOrchestrator({
      server: `http://127.0.0.1:${port}`,
      sessionId: "dev",
      authToken: null,
      brain: {
        think: async () => createDirectReplyPlan("reply routed to session a"),
      } as any,
      llm: {} as any,
      idempotency,
      persistentMemory: new NoopSessionMemory(),
      jobsDbPath: join(root, "outputs", "data", "pushpals.db"),
    });

    try {
      await (orchestrator as any).processRequest(claimedBody.request, Number(claimedBody.queueWaitMs ?? 0));
      const replyEvent = await waitForEvent(
        requestSocket.events,
        (event) =>
          event.type === "assistant_message" &&
          String((event.payload as { text?: unknown })?.text ?? "") === "reply routed to session a",
      );
      expect(replyEvent.sessionId).toBe("session-a");

      await Bun.sleep(250);
      expect(
        defaultSocket.events.some(
          (event) =>
            event.type === "assistant_message" &&
            String((event.payload as { text?: unknown })?.text ?? "") === "reply routed to session a",
        ),
      ).toBe(false);
    } finally {
      orchestrator.dispose();
    }
  }, 20_000);
});
