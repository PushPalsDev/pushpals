import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = resolve(__dirname, "..", "..");
const workerMainPath = resolve(sourceRepoRoot, "apps", "workerpals", "src", "workerpals_main.ts");

function decodeOutput(data: string | Uint8Array | null | undefined): string {
  if (typeof data === "string") return data;
  if (!data) return "";
  return Buffer.from(data).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function startJsonServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => Promise<void> | void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      await handler(req, res, body);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind integration HTTP server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function initializeMinimalRepo(root: string): string {
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(repoPath, "configs"), { recursive: true });
  cpSync(join(sourceRepoRoot, "configs", "default.toml"), join(repoPath, "configs", "default.toml"), {
    force: true,
  });
  if (existsSync(join(sourceRepoRoot, "configs", "local.example.toml"))) {
    cpSync(
      join(sourceRepoRoot, "configs", "local.example.toml"),
      join(repoPath, "configs", "local.example.toml"),
      { force: true },
    );
  }
  if (existsSync(join(sourceRepoRoot, ".env.example"))) {
    cpSync(join(sourceRepoRoot, ".env.example"), join(repoPath, ".env.example"), { force: true });
  }
  writeFileSync(join(repoPath, "README.md"), "# workerpals control-plane integration\n", "utf8");

  const gitInit = Bun.spawnSync(["git", "init"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gitInit.exitCode !== 0) {
    throw new Error(`git init failed: ${decodeOutput(gitInit.stderr)}`);
  }
  Bun.spawnSync(["git", "branch", "-M", "main"], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(["git", "config", "user.name", "PushPals Control Plane E2E"], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(["git", "config", "user.email", "pushpals-control-plane@example.com"], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(["git", "add", "."], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  Bun.spawnSync(["git", "commit", "-m", "chore: seed control plane integration repo"], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  return repoPath;
}

function createTaskExecuteParams(instruction: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    lane: "worker",
    instruction,
    planning: {
      intent: "code_change",
      riskLevel: "medium",
      targetPaths: ["README.md"],
      scope: {
        readAnywhere: true,
        writeAllowed: true,
        writeGlobs: ["README.md"],
        maxFilesToEdit: 1,
      },
      discovery: {
        ripgrepQueries: ["README"],
        likelyDirs: ["."],
        keywords: ["readme"],
      },
      acceptanceCriteria: ["Update the requested repository file and report the result."],
      validationSteps: ["git status --short"],
      queuePriority: "normal",
      queueWaitBudgetMs: 60_000,
      executionBudgetMs: 120_000,
      finalizationBudgetMs: 60_000,
    },
  };
}

function writeCodexWorkaroundStub(repoPath: string): string {
  const helperDir = join(repoPath, ".pushpals-e2e");
  mkdirSync(helperDir, { recursive: true });
  const scriptPath = join(helperDir, "fake-codex-workaround.py");
  const script = [
    "from pathlib import Path",
    "import sys",
    "import time",
    "",
    "last_message_path = None",
    "argv = sys.argv[1:]",
    "for index, arg in enumerate(argv):",
    '    if arg == "--output-last-message" and index + 1 < len(argv):',
    "        last_message_path = argv[index + 1]",
    "        break",
    "",
    'message = "Codex CLI isn\'t available here, so I\'m using a workaround instead."',
    "if last_message_path:",
    '    Path(last_message_path).write_text(message, encoding="utf-8")',
    "time.sleep(1)",
    "",
  ].join("\n");
  writeFileSync(
    scriptPath,
    script,
    "utf8",
  );
  return scriptPath;
}

function dockerAvailable(): boolean {
  const proc = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], {
    cwd: sourceRepoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

function cleanupDockerArtifacts(imageName: string, workerId: string): void {
  try {
    Bun.spawnSync(["docker", "rm", "-f", `pushpals-${workerId}-warm`], {
      cwd: sourceRepoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}
  try {
    Bun.spawnSync(["docker", "image", "rm", "-f", imageName], {
      cwd: sourceRepoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}
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

async function expectProcessRunning(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<void> {
  const outcome = await Promise.race([
    proc.exited.then((code) => ({ exited: true as const, code })),
    Bun.sleep(timeoutMs).then(() => ({ exited: false as const, code: null })),
  ]);
  if (outcome.exited) {
    throw new Error(`Worker exited unexpectedly with code ${outcome.code}`);
  }
}

async function waitForProcessExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  return await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => Number.NaN),
  ]);
}

async function stopWorker(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  try {
    proc.kill();
  } catch {}
  await Promise.race([proc.exited, Bun.sleep(5_000)]);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return `${stdout}\n${stderr}`;
}

test(
  "worker keeps heartbeating while a claimed-job session command is blocked",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-worker-control-plane-"));
    let serverHandle: Awaited<ReturnType<typeof startJsonServer>> | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const repoPath = initializeMinimalRepo(root);
      const jobId = "job-heartbeat-survives";
      let claimCount = 0;
      let busyHeartbeatsWhileBlocked = 0;
      let completionSeen = false;
      let failureSeen = false;
      let releaseBlockedCommand: (() => void) | null = null;
      let blockedCommandReleased = false;
      const requestTrace: string[] = [];

      serverHandle = await startJsonServer(async (req, res, body) => {
        const url = req.url ?? "/";
        requestTrace.push(`${req.method ?? "GET"} ${url} ${JSON.stringify(body)}`);
        if (req.method !== "POST") {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        if (url === "/jobs/claim") {
          claimCount += 1;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              job:
                claimCount === 1
                  ? {
                      id: jobId,
                      taskId: "warmup-heartbeat-survives",
                      kind: "warmup.execute",
                      params: {},
                      sessionId: "session-blocked",
                    }
                  : null,
            }),
          );
          return;
        }
        if (url === "/workers/heartbeat") {
          if (body.currentJobId === jobId && !blockedCommandReleased) {
            busyHeartbeatsWhileBlocked += 1;
            if (busyHeartbeatsWhileBlocked >= 2) {
              blockedCommandReleased = true;
              releaseBlockedCommand?.();
            }
          }
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === "/sessions/session-blocked/command") {
          if (!blockedCommandReleased && body?.type === "job_claimed") {
            await new Promise<void>((resolveBlocked) => {
              releaseBlockedCommand = resolveBlocked;
            });
          }
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/complete`) {
          completionSeen = true;
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/fail`) {
          failureSeen = true;
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url.startsWith(`/jobs/${jobId}/log`)) {
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        res.statusCode = 200;
        res.end("{}");
      });

      proc = Bun.spawn(
        [
          process.execPath,
          "run",
          workerMainPath,
          "--server",
          serverHandle.baseUrl,
          "--poll",
          "250",
          "--heartbeat",
          "500",
          "--repo",
          repoPath,
          "--base-ref",
          "HEAD",
          "--workerId",
          "workerpal-control-plane-it-1",
        ],
        {
          cwd: repoPath,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        },
      );

      await waitForCondition(
        () => blockedCommandReleased,
        10_000,
        "Timed out waiting for blocked command release via busy heartbeats",
      );
      expect(busyHeartbeatsWhileBlocked).toBeGreaterThanOrEqual(2);

      try {
        await waitForCondition(() => completionSeen, 10_000, "Timed out waiting for warmup completion");
      } catch (error) {
        const output = proc ? await stopWorker(proc) : "";
        proc = null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `failureSeen=${failureSeen}\n` +
            `requestTrace=\n${requestTrace.join("\n")}\n` +
            `workerOutput=\n${output}`,
        );
      }
      await expectProcessRunning(proc, 500);

      const output = await stopWorker(proc);
      proc = null;
      expect(output).not.toContain("Control plane unhealthy");
    } finally {
      if (proc) {
        await stopWorker(proc);
      }
      if (serverHandle) {
        await serverHandle.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "worker does not recycle during finalization when heartbeats fail after execution completes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-worker-control-plane-"));
    let serverHandle: Awaited<ReturnType<typeof startJsonServer>> | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const repoPath = initializeMinimalRepo(root);
      const jobId = "job-finalization-survives";
      let claimCount = 0;
      let finalizationBlocked = false;
      let releaseCompletion: (() => void) | null = null;
      let completionSeen = false;
      let failingHeartbeatsDuringFinalization = 0;

      serverHandle = await startJsonServer(async (req, res, body) => {
        const url = req.url ?? "/";
        if (req.method !== "POST") {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        if (url === "/jobs/claim") {
          claimCount += 1;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              job:
                claimCount === 1
                  ? {
                      id: jobId,
                      taskId: "warmup-finalization-survives",
                      kind: "warmup.execute",
                      params: {},
                      sessionId: null,
                    }
                  : null,
            }),
          );
          return;
        }
        if (url === "/workers/heartbeat") {
          if (finalizationBlocked && body.currentJobId === jobId) {
            failingHeartbeatsDuringFinalization += 1;
            res.statusCode = 503;
            res.end('{"error":"heartbeat degraded during finalization"}');
            return;
          }
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/complete`) {
          finalizationBlocked = true;
          await new Promise<void>((resolveBlocked) => {
            releaseCompletion = resolveBlocked;
          });
          completionSeen = true;
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/fail`) {
          res.statusCode = 500;
          res.end('{"error":"unexpected fail"}');
          return;
        }
        res.statusCode = 200;
        res.end("{}");
      });

      proc = Bun.spawn(
        [
          process.execPath,
          "run",
          workerMainPath,
          "--server",
          serverHandle.baseUrl,
          "--poll",
          "250",
          "--heartbeat",
          "500",
          "--repo",
          repoPath,
          "--base-ref",
          "HEAD",
          "--workerId",
          "workerpal-control-plane-it-2",
        ],
        {
          cwd: repoPath,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PUSHPALS_STALE_CLAIM_TTL_MS: "4000",
          },
        },
      );

      await waitForCondition(
        () => finalizationBlocked && failingHeartbeatsDuringFinalization >= 3,
        10_000,
        "Timed out waiting for failing finalization heartbeats",
      );
      await expectProcessRunning(proc, 1_000);

      releaseCompletion?.();
      await waitForCondition(() => completionSeen, 10_000, "Timed out waiting for completion after release");
      await expectProcessRunning(proc, 500);

      const output = await stopWorker(proc);
      proc = null;
      expect(output).not.toContain("Control plane unhealthy");
      expect(output).not.toContain("Fatal:");
    } finally {
      if (proc) {
        await stopWorker(proc);
      }
      if (serverHandle) {
        await serverHandle.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "worker defers merge-conflict jobs, rebuilds the Docker image, reclaims, and completes execution",
  async () => {
    if (!dockerAvailable()) {
      console.warn("[workerpals.control-plane.e2e] Skipping real-Docker merge-conflict test because Docker is unavailable.");
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "pushpals-worker-merge-conflict-"));
    let serverHandle: Awaited<ReturnType<typeof startJsonServer>> | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    const workerId = `workerpal-merge-conflict-it-${Date.now()}`;
    const dockerImage = `pushpals-worker-sandbox:merge-conflict-e2e-${Date.now()}`;
    try {
      const repoPath = initializeMinimalRepo(root);
      const jobId = "job-merge-conflict-docker";
      const requestTrace: string[] = [];
      const sessionCommands: string[] = [];
      let servedClaimCount = 0;
      let deferCount = 0;
      let completionSeen = false;
      let failureSeen = false;
      let deferredFailureSeen = false;
      let maintenanceHeartbeatCount = 0;

      serverHandle = await startJsonServer(async (req, res, body) => {
        const url = req.url ?? "/";
        requestTrace.push(`${req.method ?? "GET"} ${url} ${JSON.stringify(body)}`);
        if (req.method !== "POST") {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        if (url === "/jobs/claim") {
          const shouldServeJob =
            servedClaimCount === 0 || (servedClaimCount === 1 && deferCount > 0);
          if (shouldServeJob) {
            servedClaimCount += 1;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              job: shouldServeJob
                ? {
                    id: jobId,
                    taskId: "merge-conflict-docker-warmup",
                    kind: "warmup.execute",
                    params: {
                      reviewAgent: {
                        resolutionType: "merge_conflict",
                      },
                    },
                    sessionId: "session-merge-conflict",
                  }
                : null,
            }),
          );
          return;
        }
        if (url === `/jobs/${jobId}/defer`) {
          deferCount += 1;
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: true,
              availableAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
          return;
        }
        if (url === "/workers/heartbeat") {
          if (body?.details?.maintenance === "merge_conflict_image_refresh") {
            maintenanceHeartbeatCount += 1;
          }
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/complete`) {
          completionSeen = true;
          res.statusCode = 200;
          res.end('{"ok":true}');
          return;
        }
        if (url === `/jobs/${jobId}/fail`) {
          failureSeen = true;
          res.statusCode = 200;
          res.end('{"ok":true}');
          return;
        }
        if (url === `/jobs/${jobId}/fail-deferred`) {
          deferredFailureSeen = true;
          res.statusCode = 200;
          res.end('{"ok":true}');
          return;
        }
        if (url.startsWith(`/jobs/${jobId}/log`)) {
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === "/sessions/session-merge-conflict/command") {
          if (typeof body?.type === "string") {
            sessionCommands.push(body.type);
          }
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        res.statusCode = 200;
        res.end("{}");
      });

      proc = Bun.spawn(
        [
          process.execPath,
          "run",
          workerMainPath,
          "--server",
          serverHandle.baseUrl,
          "--poll",
          "250",
          "--heartbeat",
          "500",
          "--repo",
          repoPath,
          "--base-ref",
          "HEAD",
          "--workerId",
          workerId,
          "--docker",
          "--docker-image",
          dockerImage,
        ],
        {
          cwd: repoPath,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            OPENAI_API_KEY: "pushpals-e2e-openai-key",
            PUSHPALS_OPENAI_CODEX_AUTH_MODE: "api_key",
            PUSHPALS_WORKERPALS_SANDBOX_ROOT: sourceRepoRoot,
          },
        },
      );

      try {
        await waitForCondition(
          () => completionSeen,
          10 * 60_000,
          "Timed out waiting for merge-conflict Docker job completion",
        );
      } catch (error) {
        const output = proc ? await stopWorker(proc) : "";
        proc = null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `servedClaimCount=${servedClaimCount}\n` +
            `deferCount=${deferCount}\n` +
            `maintenanceHeartbeatCount=${maintenanceHeartbeatCount}\n` +
            `failureSeen=${failureSeen}\n` +
            `deferredFailureSeen=${deferredFailureSeen}\n` +
            `sessionCommands=${JSON.stringify(sessionCommands)}\n` +
            `requestTrace=\n${requestTrace.join("\n")}\n` +
            `workerOutput=\n${output}`,
        );
      }

      await expectProcessRunning(proc, 1_000);
      const output = await stopWorker(proc);
      proc = null;

      expect(servedClaimCount).toBe(2);
      expect(deferCount).toBe(1);
      expect(maintenanceHeartbeatCount).toBeGreaterThan(0);
      expect(failureSeen).toBe(false);
      expect(deferredFailureSeen).toBe(false);
      expect(sessionCommands).toContain("job_claimed");
      expect(output).toContain("rebuilding");
      expect(output).toContain("Docker image refresh complete");
      expect(output).toContain(`Claimed job ${jobId}`);
    } finally {
      if (proc) {
        await stopWorker(proc);
      }
      if (serverHandle) {
        await serverHandle.close();
      }
      cleanupDockerArtifacts(dockerImage, workerId);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);

test(
  "worker reports a codex policy violation for docker task.execute jobs",
  async () => {
    if (!dockerAvailable()) {
      console.warn(
        "[workerpals.control-plane.e2e] Skipping codex rejection-loop test because Docker is unavailable.",
      );
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "pushpals-worker-codex-rejection-"));
    let serverHandle: Awaited<ReturnType<typeof startJsonServer>> | null = null;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    const workerId = `workerpal-codex-loop-it-${Date.now()}`;
    const dockerImage = `pushpals-worker-sandbox:codex-loop-e2e-${Date.now()}`;
    try {
      const repoPath = initializeMinimalRepo(root);
      writeCodexWorkaroundStub(repoPath);
      const containerStubPath = "/repo/.pushpals-e2e/fake-codex-workaround.py";
      const jobId = "job-codex-command-policy-loop";
      const requestTrace: string[] = [];
      let claimCount = 0;
      let completionSeen = false;
      let failurePayload: { message?: string; detail?: string } | null = null;

      serverHandle = await startJsonServer(async (req, res, body) => {
        const url = req.url ?? "/";
        requestTrace.push(`${req.method ?? "GET"} ${url} ${JSON.stringify(body)}`);
        if (req.method !== "POST") {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        if (url === "/jobs/claim") {
          claimCount += 1;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              job:
                claimCount === 1
                  ? {
                      id: jobId,
                      taskId: "codex-command-policy-loop",
                      kind: "task.execute",
                      params: createTaskExecuteParams(
                        "Update the README with a short note about adjacent possible hooks.",
                      ),
                      sessionId: null,
                    }
                  : null,
            }),
          );
          return;
        }
        if (url === "/workers/heartbeat") {
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/complete`) {
          completionSeen = true;
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url === `/jobs/${jobId}/fail`) {
          failurePayload = {
            message: typeof body?.message === "string" ? body.message : "",
            detail: typeof body?.detail === "string" ? body.detail : "",
          };
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        if (url.startsWith(`/jobs/${jobId}/log`)) {
          res.statusCode = 200;
          res.end("{}");
          return;
        }
        res.statusCode = 200;
        res.end("{}");
      });

      proc = Bun.spawn(
        [
          process.execPath,
          "run",
          workerMainPath,
          "--server",
          serverHandle.baseUrl,
          "--poll",
          "250",
          "--heartbeat",
          "500",
          "--repo",
          repoPath,
          "--base-ref",
          "HEAD",
          "--workerId",
          workerId,
          "--docker",
          "--docker-image",
          dockerImage,
        ],
        {
          cwd: repoPath,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            OPENAI_API_KEY: "pushpals-e2e-openai-key",
            PUSHPALS_OPENAI_CODEX_AUTH_MODE: "api_key",
            PUSHPALS_OPENAI_CODEX_BIN_JSON: JSON.stringify([
              "/workspace/.venv/bin/python",
              containerStubPath,
            ]),
            PUSHPALS_WORKERPALS_SANDBOX_ROOT: sourceRepoRoot,
          },
        },
      );

      try {
        await waitForCondition(
          () => failurePayload !== null,
          2 * 60_000,
          "Timed out waiting for codex policy-violation failure",
        );
      } catch (error) {
        const output = proc ? await stopWorker(proc) : "";
        proc = null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `claimCount=${claimCount}\n` +
            `completionSeen=${completionSeen}\n` +
            `failurePayload=${JSON.stringify(failurePayload)}\n` +
            `requestTrace=\n${requestTrace.join("\n")}\n` +
            `workerOutput=\n${output}`,
        );
      }

      const expectedFailureMessage =
        "openai_codex policy violation: Codex CLI workaround detected";
      const failureDetail = String(failurePayload?.detail ?? "");
      if (
        failurePayload?.message !== expectedFailureMessage ||
        !failureDetail.includes("Codex CLI is mandatory in this backend")
      ) {
        const output = await stopWorker(proc);
        proc = null;
        throw new Error(
          "Unexpected codex policy-violation failure payload\n" +
            `expectedMessage=${expectedFailureMessage}\n` +
            `failurePayload=${JSON.stringify(failurePayload)}\n` +
            `claimCount=${claimCount}\n` +
            `completionSeen=${completionSeen}\n` +
            `requestTrace=\n${requestTrace.join("\n")}\n` +
            `workerOutput=\n${output}`,
        );
      }
      expect(failurePayload?.message).toBe(expectedFailureMessage);
      expect(failureDetail).toContain("Codex CLI is mandatory in this backend");

      const exitCode = await waitForProcessExit(proc, 45_000);
      if (!Number.isFinite(exitCode)) {
        const output = await stopWorker(proc);
        proc = null;
        throw new Error(
          "Timed out waiting for worker recycle after codex policy violation\n" +
            `claimCount=${claimCount}\n` +
            `completionSeen=${completionSeen}\n` +
            `failurePayload=${JSON.stringify(failurePayload)}\n` +
            `requestTrace=\n${requestTrace.join("\n")}\n` +
            `workerOutput=\n${output}`,
        );
      }
      const output = await stopWorker(proc);
      proc = null;

      expect(claimCount).toBeGreaterThanOrEqual(1);
      expect(completionSeen).toBe(false);
      expect(exitCode).toBe(86);
      expect(output).toContain("Codex backend unavailable");
    } finally {
      if (proc) {
        await stopWorker(proc);
      }
      if (serverHandle) {
        await serverHandle.close();
      }
      cleanupDockerArtifacts(dockerImage, workerId);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);
