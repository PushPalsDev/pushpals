import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { createServer } from "net";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = resolve(__dirname, "..", "..");
const sessionId = "dev";

function decodeOutput(data: string | Uint8Array | null | undefined): string {
  if (typeof data === "string") return data;
  if (!data) return "";
  return Buffer.from(data).toString("utf8");
}

function runChecked(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return;
  throw new Error(
    `Command failed (${proc.exitCode}): ${cmd.join(" ")}\nstdout:\n${decodeOutput(
      proc.stdout,
    )}\nstderr:\n${decodeOutput(proc.stderr)}`,
  );
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 26000 + Math.floor(Math.random() * 20000);
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("Failed to find available port for CLI session stream visibility e2e.");
}

function initializeTempRepo(root: string): string {
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(join(repoRoot, "configs"), { recursive: true });

  writeFileSync(join(repoRoot, "README.md"), "# PushPals CLI stream visibility E2E\n");
  cpSync(join(sourceRepoRoot, ".env.example"), join(repoRoot, ".env"), { force: true });
  cpSync(join(sourceRepoRoot, "vision.example.md"), join(repoRoot, "vision.md"), { force: true });
  cpSync(join(sourceRepoRoot, "configs", "default.toml"), join(repoRoot, "configs", "default.toml"), {
    force: true,
  });
  cpSync(
    join(sourceRepoRoot, "configs", "local.example.toml"),
    join(repoRoot, "configs", "local.example.toml"),
    { force: true },
  );
  cpSync(
    join(sourceRepoRoot, "configs", "local.example.toml"),
    join(repoRoot, "configs", "local.toml"),
    { force: true },
  );

  runChecked(["git", "init"], repoRoot);
  runChecked(["git", "branch", "-M", "main"], repoRoot);
  runChecked(["git", "config", "user.name", "PushPals E2E"], repoRoot);
  runChecked(["git", "config", "user.email", "pushpals-e2e@example.com"], repoRoot);
  runChecked(["git", "add", "."], repoRoot);
  runChecked(["git", "commit", "-m", "chore: seed cli stream visibility e2e"], repoRoot);

  return repoRoot;
}

function captureProcessStream(stream: ReadableStream<Uint8Array> | null): () => string {
  let output = "";
  if (!stream) return () => output;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();
    } catch {
      // Process cleanup can close streams while the test is shutting down.
    }
  })();
  return () => output;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
  detail?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(50);
  }
  const extra = detail ? `\n${detail()}` : "";
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError}` : ""}${extra}`);
}

async function postJson(serverUrl: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${text}`);
  }
  return json;
}

test(
  "packaged CLI suppresses autonomy-origin session events while showing user-directed events",
  async () => {
    const cliPath = join(sourceRepoRoot, "packages", "cli", "dist", "pushpals-cli.js");
    expect(existsSync(cliPath)).toBe(true);

    const tempRoot = mkdtempSync(join(tmpdir(), "pushpals-cli-stream-e2e-"));
    const repoRoot = initializeTempRepo(tempRoot);
    const port = await findAvailablePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const dataDir = join(tempRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    const env = {
      ...process.env,
      PUSHPALS_PORT: String(port),
      PUSHPALS_SERVER_URL: serverUrl,
      PUSHPALS_PROJECT_ROOT_OVERRIDE: repoRoot,
      PUSHPALS_CONFIG_DIR_OVERRIDE: join(repoRoot, "configs"),
      PUSHPALS_DATA_DIR: dataDir,
      PUSHPALS_DB_PATH: join(dataDir, "pushpals.db"),
      PUSHPALS_LOG_CONFIG_ON_START: "0",
      PUSHPALS_SESSION_ID: sessionId,
    } as Record<string, string>;

    const serverProc = Bun.spawn([process.execPath, "apps/server/src/server_main.ts"], {
      cwd: sourceRepoRoot,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const serverStdout = captureProcessStream(serverProc.stdout);
    const serverStderr = captureProcessStream(serverProc.stderr);

    let remoteBuddyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let cliProc: ReturnType<typeof Bun.spawn> | null = null;
    let cliStdout = "";
    let cliStderr = "";

    try {
      await waitFor(
        async () => {
          const response = await fetch(`${serverUrl}/healthz`).catch(() => null);
          return Boolean(response?.ok);
        },
        10_000,
        "server health",
        () => `server stdout:\n${serverStdout()}\nserver stderr:\n${serverStderr()}`,
      );

      await postJson(serverUrl, "/sessions", { sessionId });

      const remoteBuddyEventsUrl = new URL(
        `/sessions/${encodeURIComponent(sessionId)}/events`,
        serverUrl,
      );
      remoteBuddyEventsUrl.searchParams.set("clientId", "remotebuddy-e2e");
      remoteBuddyEventsUrl.searchParams.set("clientKind", "agent");
      remoteBuddyEventsUrl.searchParams.set("clientLabel", "RemoteBuddy");
      const remoteBuddyResponse = await fetch(remoteBuddyEventsUrl);
      expect(remoteBuddyResponse.ok).toBe(true);
      remoteBuddyReader = remoteBuddyResponse.body?.getReader() ?? null;
      if (remoteBuddyReader) {
        void (async () => {
          try {
            while (true) {
              const { done } = await remoteBuddyReader!.read();
              if (done) break;
            }
          } catch {
            // Closing the test intentionally cancels the fake RemoteBuddy stream.
          }
        })();
      }

      await postJson(serverUrl, "/workers/heartbeat", {
        workerId: "workerpal-e2e",
        status: "idle",
        currentJobId: null,
      });

      await waitFor(
        async () => {
          const response = await fetch(`${serverUrl}/system/status`);
          if (!response.ok) return false;
          const status = (await response.json()) as {
            clients?: { items?: Array<{ clientId?: string; status?: string; sessionId?: string }> };
          };
          return Boolean(
            status.clients?.items?.some(
              (client) =>
                client.clientId === "remotebuddy-e2e" &&
                client.sessionId === sessionId &&
                client.status === "connected",
            ),
          );
        },
        5_000,
        "fake RemoteBuddy presence",
      );

      cliProc = Bun.spawn(
        [
          process.execPath,
          cliPath,
          "--server-url",
          serverUrl,
          "--session-id",
          sessionId,
          "--runtime-root",
          join(tempRoot, "runtime"),
          "--no-auto-start",
        ],
        {
          cwd: repoRoot,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const cliStdoutReader = captureProcessStream(cliProc.stdout);
      const cliStderrReader = captureProcessStream(cliProc.stderr);
      cliStdout = cliStdoutReader();
      cliStderr = cliStderrReader();

      await waitFor(
        () => {
          cliStdout = cliStdoutReader();
          cliStderr = cliStderrReader();
          return cliStdout.includes("Type a message and press Enter");
        },
        15_000,
        "CLI interactive readiness",
        () => `stdout:\n${cliStdout}\nstderr:\n${cliStderr}`,
      );

      await postJson(serverUrl, `/sessions/${sessionId}/command`, {
        type: "assistant_message",
        from: "agent:remotebuddy-orchestrator/autonomy",
        payload: { text: "E2E_HIDDEN_AUTONOMY_ASSISTANT" },
      });
      await postJson(serverUrl, `/sessions/${sessionId}/command`, {
        type: "task_progress",
        from: "agent:remotebuddy-orchestrator/autonomy",
        payload: { taskId: "task-e2e", message: "E2E_HIDDEN_AUTONOMY_TASK" },
      });
      await postJson(serverUrl, `/sessions/${sessionId}/command`, {
        type: "job_completed",
        from: "worker:workerpal-e2e/autonomy",
        payload: {
          jobId: "job-e2e",
          summary: "E2E_HIDDEN_AUTONOMY_JOB",
          origin: "autonomy",
        },
      });
      await postJson(serverUrl, `/sessions/${sessionId}/command`, {
        type: "assistant_message",
        from: "agent:remotebuddy-orchestrator",
        payload: { text: "E2E_VISIBLE_USER_ASSISTANT" },
      });

      await waitFor(
        () => {
          cliStdout = cliStdoutReader();
          return cliStdout.includes("E2E_VISIBLE_USER_ASSISTANT");
        },
        5_000,
        "visible user-directed CLI event",
        () => `stdout:\n${cliStdout}\nstderr:\n${cliStderrReader()}`,
      );
      await Bun.sleep(400);
      cliStdout = cliStdoutReader();
      cliStderr = cliStderrReader();

      expect(cliStdout).toContain("E2E_VISIBLE_USER_ASSISTANT");
      expect(cliStdout).not.toContain("E2E_HIDDEN_AUTONOMY_ASSISTANT");
      expect(cliStdout).not.toContain("E2E_HIDDEN_AUTONOMY_TASK");
      expect(cliStdout).not.toContain("E2E_HIDDEN_AUTONOMY_JOB");

      cliProc.kill();
      await Promise.race([cliProc.exited.catch(() => null), Bun.sleep(2_000)]);
    } finally {
      try {
        await remoteBuddyReader?.cancel();
      } catch {}
      try {
        cliProc?.kill();
      } catch {}
      try {
        serverProc.kill();
      } catch {}
      await serverProc.exited.catch(() => null);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
  45_000,
);
