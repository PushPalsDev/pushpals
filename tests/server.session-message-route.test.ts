import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

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
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(25 * attempt);
      }
    }
    if (lastError) throw lastError;
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

function spawnServer(
  root: string,
  port: number,
  runtimeGeneration = "session-route-runtime-v1",
): SpawnedServer {
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
        PUSHPALS_WORKER_RUNTIME_GENERATION: runtimeGeneration,
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

function postServerJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedPendingPublication(
  port: number,
  label: string,
): Promise<{ jobId: string; completionId: string }> {
  const enqueued = await postServerJson(port, "/jobs/enqueue", {
    taskId: `publication-seed-task-${label}`,
    sessionId: "publication-seed",
    kind: "task.execute",
    params: { origin: "user" },
  });
  expect(enqueued.status).toBe(201);
  const jobId = String(((await enqueued.json()) as Record<string, unknown>).jobId ?? "");
  expect(jobId).not.toBe("");

  const claimed = await postServerJson(port, "/jobs/claim", {
    workerId: "publication-seed-worker",
  });
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toMatchObject({ job: { id: jobId } });

  const completion = await postServerJson(port, "/completions/enqueue", {
    jobId,
    sessionId: "publication-seed",
    origin: "user",
    commitSha: `candidate-${label}`,
    branch: `refs/pushpals/publication-seed-${label}`,
    message: `Pending publication ${label}`,
  });
  expect(completion.status).toBe(201);
  const completionPayload = (await completion.json()) as Record<string, unknown>;
  const completionId = String(completionPayload.completionId ?? "");
  expect(completionPayload).toMatchObject({ ok: true });
  expect(completionId).not.toBe("");
  return { jobId, completionId };
}

function autonomyRequestMetadata(label: string): Record<string, unknown> {
  return {
    origin: "autonomy",
    autonomy: {
      objectiveId: `publication-pressure-${label}`,
      runId: `publication-pressure-run-${label}`,
      snapshotId: `publication-pressure-snapshot-${label}`,
      patternKey: `publication-pressure-pattern-${label}`,
      componentArea: "apps/server",
      targetPaths: ["apps/server/src/server_main.ts"],
      writeGlobs: ["apps/server/src/*.ts"],
    },
  };
}

async function seedWorkerRuntimeCircuit(
  port: number,
  label: string,
  beforeCircuitOpens?: () => Promise<void>,
): Promise<string[]> {
  const jobIds: string[] = [];
  for (let index = 1; index <= 2; index += 1) {
    const enqueued = await postServerJson(port, "/jobs/enqueue", {
      taskId: `runtime-circuit-${label}-${index}`,
      sessionId: `runtime-circuit-${label}`,
      kind: "task.execute",
      params: {
        origin: "autonomy",
        autonomy: { patternKey: `runtime-circuit-${label}-${index}` },
      },
    });
    expect(enqueued.status).toBe(201);
    const jobId = String(((await enqueued.json()) as Record<string, unknown>).jobId ?? "");
    jobIds.push(jobId);

    const claimed = await postServerJson(port, "/jobs/claim", {
      workerId: `runtime-circuit-worker-${index}`,
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ job: { id: jobId } });

    const runtimeDetail =
      `ReferenceError: Cannot access 'timedOut' before initialization.\n` +
      `    at <anonymous> (/workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13)`;
    if (index === 2 && beforeCircuitOpens) await beforeCircuitOpens();
    const failed = await postServerJson(port, `/jobs/${jobId}/fail`, {
      message: "WorkerPal job execution failed",
      detail: runtimeDetail,
      diagnostics: {
        attempts: [
          {
            attempt: 1,
            workerId: `runtime-circuit-worker-${index}`,
            backend: "openai_codex",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 15_000,
            terminalReason: runtimeDetail,
            exitCode: 1,
          },
        ],
        terminal: {
          status: "failed",
          failureClass: "worker_runtime_failure",
          terminalStage: "executor",
          executorBackend: "openai_codex",
          summary: "Job failed before returning a structured result",
          publishableFileCount: 0,
          artifactOnlyPathCount: 0,
          changedPathSample: [],
        },
      },
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ok: true });
  }
  return jobIds;
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

  test("authoritatively rejects new autonomy admission at publication capacity", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    const firstPublication = await seedPendingPublication(port, "one");
    const firstPublicationStatus = await fetch(
      `http://127.0.0.1:${port}/completions/${firstPublication.completionId}/status`,
    );
    const firstPublicationStatusPayload = await firstPublicationStatus.json();
    expect({
      status: firstPublicationStatus.status,
      payload: firstPublicationStatusPayload,
    }).toEqual({
      status: 200,
      payload: {
        ok: true,
        completion: {
          id: firstPublication.completionId,
          status: "pending",
          commitSha: "candidate-one",
          branch: "refs/pushpals/publication-seed-one",
          claimGeneration: 0,
        },
      },
    });

    const belowThreshold = await postServerJson(port, "/requests/enqueue", {
      sessionId: "autonomy-publication-pressure",
      prompt: "Use the remaining safe publication capacity.",
      priority: "background",
      metadata: autonomyRequestMetadata("below-threshold"),
    });
    expect(belowThreshold.status).toBe(201);

    await seedPendingPublication(port, "two");
    const blockedRequest = await postServerJson(port, "/requests/enqueue", {
      sessionId: "autonomy-publication-pressure",
      prompt: "Do not add more publication work yet.",
      priority: "background",
      metadata: autonomyRequestMetadata("blocked"),
    });
    expect(blockedRequest.status).toBe(429);
    expect(await blockedRequest.json()).toMatchObject({
      ok: false,
      code: "autonomy_publication_backpressure",
      publication: { backlog: 2 },
      onlineWorkers: 1,
      threshold: 2,
    });

    const blockedDirectJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "direct-autonomy-under-publication-pressure",
      sessionId: "autonomy-publication-pressure",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(blockedDirectJob.status).toBe(429);
    expect(await blockedDirectJob.json()).toMatchObject({
      ok: false,
      code: "autonomy_publication_backpressure",
    });

    const userRequest = await postServerJson(port, "/requests/enqueue", {
      sessionId: "user-publication-pressure",
      prompt: "User work must remain admitted.",
    });
    expect(userRequest.status).toBe(201);
  }, 15_000);

  test("allows an accepted autonomy request to hand off after publication pressure rises", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    await seedPendingPublication(port, "before-admission");

    const accepted = await postServerJson(port, "/requests/enqueue", {
      sessionId: "autonomy-handoff-pressure",
      prompt: "Plan this work while publication capacity remains.",
      priority: "background",
      forceWorker: true,
      forceLane: "worker",
      metadata: autonomyRequestMetadata("accepted-handoff"),
    });
    expect(accepted.status).toBe(201);
    const requestId = String(((await accepted.json()) as Record<string, unknown>).requestId ?? "");

    const claimed = await postServerJson(port, "/requests/claim", {
      agentId: "remotebuddy-publication-pressure",
      leaseMs: 60_000,
    });
    expect(claimed.status).toBe(200);
    const claimPayload = (await claimed.json()) as {
      request?: { id?: string; claimToken?: string };
    };
    expect(claimPayload.request?.id).toBe(requestId);
    const claimToken = String(claimPayload.request?.claimToken ?? "");

    await seedPendingPublication(port, "after-admission");
    const handoff = await postServerJson(port, "/jobs/enqueue", {
      taskId: "accepted-autonomy-handoff-under-pressure",
      sessionId: "autonomy-handoff-pressure",
      kind: "task.execute",
      params: { origin: "autonomy", requestId },
      requestAgentId: "remotebuddy-publication-pressure",
      requestClaimToken: claimToken,
      dedupeKey: `task.execute:autonomy:autonomy-handoff-pressure:request:${requestId}:idempotent`,
      dedupeCooldownMs: 24 * 60 * 60 * 1000,
    });
    expect(handoff.status).toBe(201);
    expect(await handoff.json()).toMatchObject({ ok: true, jobId: expect.any(String) });
  }, 15_000);

  test("defers every queued task.execute nonterminal while the worker-runtime circuit is open", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const acceptedAutonomy = await postServerJson(port, "/requests/enqueue", {
      sessionId: "runtime-circuit-request",
      prompt: "Keep this accepted autonomy request for a canary retry.",
      priority: "background",
      forceWorker: true,
      forceLane: "worker",
      metadata: autonomyRequestMetadata("runtime-circuit-deferred"),
    });
    expect(acceptedAutonomy.status).toBe(201);
    const autonomyRequestId = String(
      ((await acceptedAutonomy.json()) as Record<string, unknown>).requestId ?? "",
    );
    await Bun.sleep(10);
    const acceptedUser = await postServerJson(port, "/requests/enqueue", {
      sessionId: "runtime-circuit-user",
      prompt: "Keep planning user work while execution waits for WorkerPal recovery.",
      priority: "background",
    });
    expect(acceptedUser.status).toBe(201);
    const userRequestId = String(
      ((await acceptedUser.json()) as Record<string, unknown>).requestId ?? "",
    );

    let queuedAutonomyJobId = "";
    await seedWorkerRuntimeCircuit(port, "request-deferral", async () => {
      const queuedJob = await postServerJson(port, "/jobs/enqueue", {
        taskId: "accepted-autonomy-job-before-runtime-circuit",
        sessionId: "runtime-circuit-job",
        kind: "task.execute",
        params: { origin: "autonomy" },
      });
      expect(queuedJob.status).toBe(201);
      queuedAutonomyJobId = String(
        ((await queuedJob.json()) as Record<string, unknown>).jobId ?? "",
      );
    });

    const blockedRequest = await postServerJson(port, "/requests/enqueue", {
      sessionId: "runtime-circuit-blocked-request",
      prompt: "Do not admit new autonomy while the runtime circuit is open.",
      priority: "background",
      metadata: autonomyRequestMetadata("runtime-circuit-blocked"),
    });
    expect(blockedRequest.status).toBe(429);
    expect(await blockedRequest.json()).toMatchObject({
      ok: false,
      code: "autonomy_worker_runtime_circuit_open",
      retryAfterMs: expect.any(Number),
    });

    const blockedJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "blocked-autonomy-job-after-runtime-circuit",
      sessionId: "runtime-circuit-job",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(blockedJob.status).toBe(429);
    expect(await blockedJob.json()).toMatchObject({
      ok: false,
      code: "autonomy_worker_runtime_circuit_open",
      retryAfterMs: expect.any(Number),
    });

    const eligibleUserJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "eligible-user-job-during-runtime-circuit",
      sessionId: "runtime-circuit-user-job",
      kind: "task.execute",
      params: { origin: "user" },
    });
    expect(eligibleUserJob.status).toBe(201);
    const eligibleUserJobId = String(
      ((await eligibleUserJob.json()) as Record<string, unknown>).jobId ?? "",
    );

    const targetedUserJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "targeted-user-job-during-runtime-circuit",
      sessionId: "runtime-circuit-user-job",
      kind: "task.execute",
      targetWorkerId: "runtime-circuit-preferred-worker",
      params: { origin: "user" },
    });
    expect(targetedUserJob.status).toBe(201);
    const targetedUserJobId = String(
      ((await targetedUserJob.json()) as Record<string, unknown>).jobId ?? "",
    );

    const claimedJob = await postServerJson(port, "/jobs/claim", {
      workerId: "runtime-circuit-canary-worker",
    });
    expect(claimedJob.status).toBe(200);
    expect(await claimedJob.json()).toMatchObject({
      job: null,
      skippedCount: 3,
    });
    const deferredJobsSnapshot = await fetch(`http://127.0.0.1:${port}/jobs?limit=20`);
    const deferredJobsPayload = (await deferredJobsSnapshot.json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(deferredJobsPayload.jobs).toContainEqual(
      expect.objectContaining({
        id: queuedAutonomyJobId,
        status: "pending",
        failedAt: null,
        availableAt: expect.any(String),
      }),
    );
    expect(deferredJobsPayload.jobs).toContainEqual(
      expect.objectContaining({
        id: eligibleUserJobId,
        status: "pending",
        failedAt: null,
        availableAt: expect.any(String),
        targetWorkerId: null,
      }),
    );
    expect(deferredJobsPayload.jobs).toContainEqual(
      expect.objectContaining({
        id: targetedUserJobId,
        status: "pending",
        failedAt: null,
        availableAt: expect.any(String),
        targetWorkerId: "runtime-circuit-preferred-worker",
      }),
    );

    const deferredUserLogs = await fetch(
      `http://127.0.0.1:${port}/jobs/${eligibleUserJobId}/logs?limit=10`,
    );
    expect(deferredUserLogs.status).toBe(200);
    const deferredUserLogsPayload = (await deferredUserLogs.json()) as {
      logs: Array<{ message: string }>;
    };
    expect(
      deferredUserLogsPayload.logs.some((log) =>
        log.message.includes('"code":"worker_runtime_circuit_open"'),
      ),
    ).toBe(true);
    expect(Math.max(...deferredUserLogsPayload.logs.map((log) => log.message.length))).toBeLessThan(
      2_100,
    );

    const claimedRequest = await postServerJson(port, "/requests/claim", {
      agentId: "remotebuddy-runtime-circuit",
      leaseMs: 60_000,
    });
    expect(claimedRequest.status).toBe(200);
    expect(await claimedRequest.json()).toMatchObject({
      request: { id: userRequestId, sessionId: "runtime-circuit-user" },
    });

    const deferredRequestStatus = await fetch(
      `http://127.0.0.1:${port}/requests/${autonomyRequestId}`,
    );
    const deferredRequestPayload = (await deferredRequestStatus.json()) as {
      request: Record<string, unknown>;
    };
    const deferredClaimToken = String(deferredRequestPayload.request.claimToken ?? "");
    const deferredUntil = String(deferredRequestPayload.request.leaseExpiresAt ?? "");
    expect(deferredClaimToken).not.toBe("");
    expect(Date.parse(deferredUntil)).toBeGreaterThan(Date.now() + 10_000);
    expect(Date.parse(deferredUntil)).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(deferredRequestPayload).toMatchObject({
      request: {
        id: autonomyRequestId,
        status: "claimed",
        failedAt: null,
        error: null,
        leaseExpiresAt: deferredUntil,
      },
    });

    const requestsSnapshot = await fetch(`http://127.0.0.1:${port}/requests?limit=20`);
    expect(await requestsSnapshot.json()).toMatchObject({
      counts: { failed: 0 },
      slo: { terminal: 0, failed: 0 },
    });

    // Make the durable circuit due and prove one successful execution canary
    // releases the already-admitted request immediately.
    const db = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      const dueAt = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE worker_runtime_circuits SET retryAt = ?, updatedAt = ?`).run(dueAt, dueAt);
      db.prepare(
        `UPDATE jobs SET availableAt = ? WHERE id IN (?, ?, ?) AND status = 'pending'`,
      ).run(dueAt, queuedAutonomyJobId, eligibleUserJobId, targetedUserJobId);
    } finally {
      db.close();
    }

    const canaryClaim = await postServerJson(port, "/jobs/claim", {
      workerId: "runtime-circuit-recovery-canary",
    });
    expect(canaryClaim.status).toBe(200);
    const canaryPayload = (await canaryClaim.json()) as {
      runtimeCanary?: boolean;
      job?: { id?: string };
    };
    expect(canaryPayload.runtimeCanary).toBe(true);
    const canaryJobId = String(canaryPayload.job?.id ?? "");
    expect([queuedAutonomyJobId, eligibleUserJobId, targetedUserJobId]).toContain(canaryJobId);
    const canaryCompleted = await postServerJson(port, `/jobs/${canaryJobId}/complete`, {
      summary: "WorkerPal runtime canary completed",
      diagnostics: {
        terminal: {
          failureClass: "success",
          terminalStage: "completed",
          executorBackend: "openai_codex",
        },
      },
    });
    expect(canaryCompleted.status).toBe(200);

    const retriedRequest = await postServerJson(port, "/requests/claim", {
      agentId: "remotebuddy-runtime-canary",
    });
    expect(retriedRequest.status).toBe(200);
    const retriedPayload = (await retriedRequest.json()) as {
      request: Record<string, unknown>;
    };
    expect(retriedPayload).toMatchObject({
      request: {
        id: autonomyRequestId,
        status: "claimed",
        claimAttempts: 2,
      },
    });
    expect(retriedPayload.request.claimToken).not.toBe(deferredClaimToken);
  }, 20_000);

  test("preserves the runtime circuit and bounds already-deferred work across restart", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    await seedWorkerRuntimeCircuit(port, "before-server-restart");

    const blockedBeforeRestart = await postServerJson(port, "/jobs/enqueue", {
      taskId: "blocked-before-server-restart",
      sessionId: "runtime-circuit-restart",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(blockedBeforeRestart.status).toBe(429);
    expect(await blockedBeforeRestart.json()).toMatchObject({
      code: "autonomy_worker_runtime_circuit_open",
    });

    const queuedUserJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "user-canary-after-server-restart",
      sessionId: "runtime-circuit-restart",
      kind: "task.execute",
      params: { origin: "user" },
    });
    expect(queuedUserJob.status).toBe(201);
    const queuedUserJobId = String(
      ((await queuedUserJob.json()) as Record<string, unknown>).jobId ?? "",
    );

    const deferredBeforeRestart = await postServerJson(port, "/jobs/claim", {
      workerId: "runtime-circuit-before-restart",
    });
    expect(deferredBeforeRestart.status).toBe(200);
    expect(await deferredBeforeRestart.json()).toMatchObject({ job: null, skippedCount: 1 });
    const dbBeforeRestart = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      dbBeforeRestart
        .prepare(`UPDATE jobs SET availableAt = ? WHERE id = ?`)
        .run(new Date(Date.now() + 30 * 60_000).toISOString(), queuedUserJobId);
    } finally {
      dbBeforeRestart.close();
    }

    server.proc.kill();
    await server.proc.exited;
    await Promise.allSettled([server.stdout, server.stderr]);

    const restartedServer = spawnServer(root, port);
    await waitForHealth(restartedServer, port);

    const stillBlocked = await postServerJson(port, "/jobs/enqueue", {
      taskId: "still-blocked-after-same-runtime-restart",
      sessionId: "runtime-circuit-restart",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(stillBlocked.status).toBe(429);
    expect(await stillBlocked.json()).toMatchObject({
      code: "autonomy_worker_runtime_circuit_open",
      phase: "open",
      runtimeGeneration: "session-route-runtime-v1",
    });

    const restartedJobs = await fetch(`http://127.0.0.1:${port}/jobs?limit=20`);
    const restartedPayload = (await restartedJobs.json()) as {
      jobs: Array<{ id: string; availableAt?: string; deferReason?: string }>;
    };
    const restartedDeferred = restartedPayload.jobs.find((job) => job.id === queuedUserJobId);
    expect(restartedDeferred?.deferReason).toBe("worker_runtime_circuit_open");
    expect(Date.parse(String(restartedDeferred?.availableAt))).toBeLessThanOrEqual(
      Date.now() + 30_000,
    );

    const dbAfterRestart = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      const dueAt = new Date(Date.now() - 1_000).toISOString();
      dbAfterRestart
        .prepare(`UPDATE worker_runtime_circuits SET retryAt = ?, updatedAt = ?`)
        .run(dueAt, dueAt);
      dbAfterRestart
        .prepare(`UPDATE jobs SET availableAt = ? WHERE id = ?`)
        .run(dueAt, queuedUserJobId);
    } finally {
      dbAfterRestart.close();
    }

    const canaryClaim = await postServerJson(port, "/jobs/claim", {
      workerId: "runtime-circuit-restarted-worker",
    });
    expect(canaryClaim.status).toBe(200);
    expect(await canaryClaim.json()).toMatchObject({
      runtimeCanary: true,
      runtimeGeneration: "session-route-runtime-v1",
      job: { id: queuedUserJobId },
    });

    const canaryCompleted = await postServerJson(port, `/jobs/${queuedUserJobId}/complete`, {
      summary: "The restarted WorkerPal generation completed its canary.",
      diagnostics: {
        terminal: {
          status: "completed",
          failureClass: "success",
          terminalStage: "completed",
          executorBackend: "openai_codex",
          summary: "Restart canary completed",
        },
      },
    });
    expect(canaryCompleted.status).toBe(200);
    expect(await canaryCompleted.json()).toMatchObject({ ok: true });

    const admittedAfterRecovery = await postServerJson(port, "/jobs/enqueue", {
      taskId: "admitted-after-canary-recovery",
      sessionId: "runtime-circuit-restart",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(admittedAfterRecovery.status).toBe(201);
    expect(await admittedAfterRecovery.json()).toMatchObject({ ok: true });
  }, 20_000);

  test("starts a clean circuit only when the packaged runtime generation changes", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port, "session-route-runtime-v1");
    await waitForHealth(server, port);
    await seedWorkerRuntimeCircuit(port, "before-runtime-upgrade");
    server.proc.kill();
    await server.proc.exited;
    await Promise.allSettled([server.stdout, server.stderr]);

    const upgradedServer = spawnServer(root, port, "session-route-runtime-v2");
    await waitForHealth(upgradedServer, port);
    const admitted = await postServerJson(port, "/jobs/enqueue", {
      taskId: "admitted-after-runtime-upgrade",
      sessionId: "runtime-circuit-upgrade",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(admitted.status).toBe(201);
    expect(await admitted.json()).toMatchObject({ ok: true });
  }, 20_000);

  test("rejects a WorkerPal from a different packaged runtime generation", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);
    const server = spawnServer(root, port, "session-route-runtime-v1");
    await waitForHealth(server, port);

    const job = await postServerJson(port, "/jobs/enqueue", {
      taskId: "runtime-generation-fence",
      sessionId: "runtime-generation-fence",
      kind: "task.execute",
      params: { origin: "user" },
    });
    expect(job.status).toBe(201);
    const rejected = await postServerJson(port, "/jobs/claim", {
      workerId: "stale-runtime-worker",
      runtimeGeneration: "session-route-runtime-v0",
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      code: "worker_runtime_generation_mismatch",
      runtimeGeneration: "session-route-runtime-v1",
    });

    const accepted = await postServerJson(port, "/jobs/claim", {
      workerId: "current-runtime-worker",
      runtimeGeneration: "session-route-runtime-v1",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      job: { runtimeGeneration: "session-route-runtime-v1" },
    });
  }, 15_000);

  test("allows only one concurrent half-open canary", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    await seedWorkerRuntimeCircuit(port, "concurrent-canary");
    const blocked = await postServerJson(port, "/jobs/enqueue", {
      taskId: "force-runtime-circuit-materialization",
      sessionId: "concurrent-canary",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(blocked.status).toBe(429);

    const jobIds: string[] = [];
    for (const label of ["first", "second"]) {
      const enqueued = await postServerJson(port, "/jobs/enqueue", {
        taskId: `concurrent-canary-${label}`,
        sessionId: "concurrent-canary",
        kind: "task.execute",
        params: { origin: "user" },
      });
      expect(enqueued.status).toBe(201);
      jobIds.push(String(((await enqueued.json()) as Record<string, unknown>).jobId ?? ""));
    }
    const db = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      const dueAt = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE worker_runtime_circuits SET retryAt = ?, updatedAt = ?`).run(dueAt, dueAt);
    } finally {
      db.close();
    }

    const responses = await Promise.all([
      postServerJson(port, "/jobs/claim", { workerId: "concurrent-canary-a" }),
      postServerJson(port, "/jobs/claim", { workerId: "concurrent-canary-b" }),
    ]);
    const payloads = await Promise.all(
      responses.map(
        async (response) =>
          (await response.json()) as {
            runtimeCanary?: boolean;
            job?: { id?: string } | null;
          },
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const admittedCanaries = payloads.filter(
      (payload) => payload.runtimeCanary === true && payload.job?.id,
    );
    expect(admittedCanaries).toHaveLength(1);
    expect(jobIds).toContain(String(admittedCanaries[0]?.job?.id));
    expect(payloads.filter((payload) => payload.job == null)).toHaveLength(1);

    const circuitDb = new Database(join(root, "outputs", "data", "pushpals.db"), {
      readonly: true,
    });
    try {
      const circuit = circuitDb
        .prepare(
          `SELECT state, canaryJobId, canaryWorkerId FROM worker_runtime_circuits
           WHERE runtimeGeneration = ?`,
        )
        .get("session-route-runtime-v1") as Record<string, unknown>;
      expect(circuit).toMatchObject({
        state: "half_open",
        canaryJobId: admittedCanaries[0]?.job?.id,
      });
      expect(String(circuit.canaryWorkerId ?? "")).toMatch(/^concurrent-canary-/);
    } finally {
      circuitDb.close();
    }
  }, 20_000);

  test("returns an observable error when a circuit deferral cannot persist", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    await seedWorkerRuntimeCircuit(port, "deferral-write-failure");
    const blocked = await postServerJson(port, "/jobs/enqueue", {
      taskId: "force-deferral-circuit-materialization",
      sessionId: "deferral-write-failure",
      kind: "task.execute",
      params: { origin: "autonomy" },
    });
    expect(blocked.status).toBe(429);

    const enqueued = await postServerJson(port, "/jobs/enqueue", {
      taskId: "deferral-write-failure-user-job",
      sessionId: "deferral-write-failure",
      kind: "task.execute",
      params: { origin: "user" },
    });
    const jobId = String(((await enqueued.json()) as Record<string, unknown>).jobId ?? "");
    const db = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      db.exec(`
        CREATE TRIGGER reject_test_runtime_deferral
        BEFORE UPDATE OF status ON jobs
        WHEN OLD.id = '${jobId}' AND OLD.status = 'claimed' AND NEW.status = 'pending'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
    } finally {
      db.close();
    }

    const claim = await postServerJson(port, "/jobs/claim", {
      workerId: "deferral-write-failure-worker",
    });
    expect(claim.status).toBe(409);
    expect(await claim.json()).toMatchObject({
      ok: false,
      code: "job_circuit_deferral_failed",
      jobId,
    });
    const jobSnapshot = await fetch(`http://127.0.0.1:${port}/jobs?limit=20`);
    const jobSnapshotPayload = (await jobSnapshot.json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(jobSnapshotPayload.jobs).toContainEqual(
      expect.objectContaining({
        id: jobId,
        status: "claimed",
        workerId: "deferral-write-failure-worker",
      }),
    );
  }, 20_000);

  test("bounds circuit scans while deferring execution and advancing user planning", async () => {
    const root = makeTempDir();
    const port = await getFreePort();
    writeServerConfig(root, port);

    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const autonomyJobIds: string[] = [];
    const autonomyRequestIds: string[] = [];
    await seedWorkerRuntimeCircuit(port, "bounded-claim-scan", async () => {
      for (let index = 0; index < 65; index += 1) {
        const job = await postServerJson(port, "/jobs/enqueue", {
          taskId: `bounded-autonomy-job-${index}`,
          sessionId: "bounded-claim-jobs",
          kind: "task.execute",
          priority: "normal",
          params: { origin: "autonomy" },
        });
        expect(job.status).toBe(201);
        autonomyJobIds.push(String(((await job.json()) as Record<string, unknown>).jobId ?? ""));

        const request = await postServerJson(port, "/requests/enqueue", {
          sessionId: `bounded-claim-request-${index}`,
          prompt: `Deferred autonomy request ${index}`,
          priority: "normal",
          forceWorker: true,
          forceLane: "worker",
          metadata: autonomyRequestMetadata(`bounded-claim-${index}`),
        });
        expect(request.status).toBe(201);
        autonomyRequestIds.push(
          String(((await request.json()) as Record<string, unknown>).requestId ?? ""),
        );
      }
    });
    expect(autonomyJobIds).toHaveLength(65);
    expect(autonomyRequestIds).toHaveLength(65);

    // Keep the eligible user work behind every autonomy row even when many
    // inserts share the same millisecond timestamp.
    await Bun.sleep(10);
    const userJob = await postServerJson(port, "/jobs/enqueue", {
      taskId: "bounded-user-job",
      sessionId: "bounded-claim-user-job",
      kind: "task.execute",
      priority: "background",
      params: { origin: "user" },
    });
    expect(userJob.status).toBe(201);
    const userJobId = String(((await userJob.json()) as Record<string, unknown>).jobId ?? "");

    const userRequest = await postServerJson(port, "/requests/enqueue", {
      sessionId: "bounded-claim-user-request",
      prompt: "Eligible user request after a bounded autonomy scan.",
      priority: "background",
    });
    expect(userRequest.status).toBe(201);
    const userRequestId = String(
      ((await userRequest.json()) as Record<string, unknown>).requestId ?? "",
    );

    const firstJobPoll = await postServerJson(port, "/jobs/claim", {
      workerId: "bounded-claim-worker",
    });
    expect(firstJobPoll.status).toBe(200);
    expect(await firstJobPoll.json()).toMatchObject({
      ok: true,
      job: null,
      skippedCount: 64,
      scanLimitReached: true,
    });

    const firstRequestPoll = await postServerJson(port, "/requests/claim", {
      agentId: "bounded-claim-remotebuddy",
    });
    expect(firstRequestPoll.status).toBe(200);
    expect(await firstRequestPoll.json()).toMatchObject({
      ok: true,
      request: null,
      skippedCount: 64,
      scanLimitReached: true,
    });

    const jobsAfterFirstPoll = await fetch(`http://127.0.0.1:${port}/jobs?limit=200`);
    const jobsAfterFirstPayload = (await jobsAfterFirstPoll.json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    const autonomyJobsAfterFirst = jobsAfterFirstPayload.jobs.filter((job) =>
      autonomyJobIds.includes(String(job.id ?? "")),
    );
    expect(autonomyJobsAfterFirst).toHaveLength(65);
    expect(
      autonomyJobsAfterFirst.filter((job) => job.status === "pending" && job.availableAt == null),
    ).toHaveLength(1);
    expect(
      autonomyJobsAfterFirst.filter(
        (job) => job.status === "pending" && typeof job.availableAt === "string",
      ),
    ).toHaveLength(64);
    expect(autonomyJobsAfterFirst.some((job) => job.status === "claimed")).toBe(false);

    const requestsAfterFirstPoll = await fetch(`http://127.0.0.1:${port}/requests?limit=200`);
    const requestsAfterFirstPayload = (await requestsAfterFirstPoll.json()) as {
      requests: Array<Record<string, unknown>>;
    };
    const autonomyRequestsAfterFirst = requestsAfterFirstPayload.requests.filter((request) =>
      autonomyRequestIds.includes(String(request.id ?? "")),
    );
    expect(autonomyRequestsAfterFirst).toHaveLength(65);
    expect(
      autonomyRequestsAfterFirst.filter((request) => request.status === "claimed"),
    ).toHaveLength(64);
    expect(
      autonomyRequestsAfterFirst.filter((request) => request.status === "pending"),
    ).toHaveLength(1);

    const secondJobPoll = await postServerJson(port, "/jobs/claim", {
      workerId: "bounded-claim-worker",
    });
    expect(secondJobPoll.status).toBe(200);
    expect(await secondJobPoll.json()).toMatchObject({
      ok: true,
      job: null,
      skippedCount: 2,
    });

    const userJobStatus = await fetch(`http://127.0.0.1:${port}/jobs?limit=200`);
    expect(userJobStatus.status).toBe(200);
    expect(await userJobStatus.json()).toMatchObject({
      jobs: expect.arrayContaining([
        expect.objectContaining({
          id: userJobId,
          status: "pending",
          failedAt: null,
          availableAt: expect.any(String),
          targetWorkerId: null,
        }),
      ]),
    });

    const secondRequestPoll = await postServerJson(port, "/requests/claim", {
      agentId: "bounded-claim-remotebuddy",
    });
    expect(secondRequestPoll.status).toBe(200);
    expect(await secondRequestPoll.json()).toMatchObject({
      request: { id: userRequestId, sessionId: "bounded-claim-user-request" },
    });
  }, 30_000);

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

  test("enforces durable request leases and worker handoffs through the real HTTP routes", async () => {
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

    const forced = await postJson("/requests/enqueue", {
      sessionId: "handoff-session",
      prompt: "This request must reach a worker.",
      forceWorker: true,
      forceLane: "worker",
    });
    const forcedId = String(((await forced.json()) as Record<string, unknown>).requestId ?? "");
    expect(forcedId).not.toBe("");
    const forcedClaim = await postJson("/requests/claim", {
      agentId: "remotebuddy-route-test",
      leaseMs: 60_000,
    });
    expect(forcedClaim.status).toBe(200);
    const forcedClaimPayload = (await forcedClaim.json()) as {
      request: { claimToken: string };
    };
    const forcedClaimToken = forcedClaimPayload.request.claimToken;

    // The callback cannot downgrade the durable forceWorker requirement.
    const missingHandoff = await postJson(`/requests/${forcedId}/complete`, {
      agentId: "remotebuddy-route-test",
      claimToken: forcedClaimToken,
      result: { requiresWorker: false },
    });
    expect(missingHandoff.status).toBe(409);
    expect(await missingHandoff.json()).toMatchObject({
      ok: false,
      code: "worker_handoff_missing",
    });

    const delegated = await postJson("/requests/enqueue", {
      sessionId: "handoff-session",
      prompt: "The planner will delegate this request.",
    });
    const delegatedId = String(
      ((await delegated.json()) as Record<string, unknown>).requestId ?? "",
    );
    const delegatedClaim = await postJson("/requests/claim", {
      agentId: "remotebuddy-route-test",
      leaseMs: 60_000,
    });
    expect(delegatedClaim.status).toBe(200);
    const delegatedClaimPayload = (await delegatedClaim.json()) as {
      request: { id: string; workerRequired: number; claimToken: string };
    };
    expect(delegatedClaimPayload).toMatchObject({
      request: { id: delegatedId, workerRequired: 0 },
    });
    const delegatedClaimToken = delegatedClaimPayload.request.claimToken;

    const staleOwnerJob = await postJson("/jobs/enqueue", {
      taskId: "task-route-stale-owner",
      sessionId: "handoff-session",
      kind: "task.execute",
      params: { requestId: delegatedId },
      requestAgentId: "remotebuddy-stale",
      requestClaimToken: delegatedClaimToken,
    });
    expect(staleOwnerJob.status).toBe(409);
    expect(await staleOwnerJob.json()).toMatchObject({
      ok: false,
      code: "request_lease_invalid",
    });

    const unknownRequestJob = await postJson("/jobs/enqueue", {
      taskId: "task-route-unknown-request",
      sessionId: "handoff-session",
      kind: "task.execute",
      params: { requestId: "request-does-not-exist" },
      requestAgentId: "remotebuddy-route-test",
    });
    expect(unknownRequestJob.status).toBe(409);
    expect(await unknownRequestJob.json()).toMatchObject({
      ok: false,
      code: "request_not_found",
    });

    const ownerlessCompletion = await postJson(`/requests/${delegatedId}/complete`, {
      result: { requiresWorker: false },
    });
    expect(ownerlessCompletion.status).toBe(409);
    expect(await ownerlessCompletion.json()).toMatchObject({
      ok: false,
      code: "request_lease_invalid",
    });

    const jobResponse = await postJson("/jobs/enqueue", {
      taskId: "task-route-handoff",
      sessionId: "handoff-session",
      kind: "task.execute",
      params: { requestId: delegatedId },
      requestAgentId: "remotebuddy-route-test",
      requestClaimToken: delegatedClaimToken,
      dedupeKey: `task.execute:user:handoff-session:request:${delegatedId}:tests/route.test.ts`,
    });
    expect(jobResponse.status).toBe(201);
    const jobId = String(((await jobResponse.json()) as Record<string, unknown>).jobId ?? "");
    expect(jobId).not.toBe("");

    const renewed = await postJson(`/requests/${delegatedId}/lease/renew`, {
      agentId: "remotebuddy-route-test",
      claimToken: delegatedClaimToken,
      leaseMs: 120_000,
    });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ ok: true, leaseExpiresAt: expect.any(String) });

    const handoff = await postJson(`/requests/${delegatedId}/worker-handoff`, {
      agentId: "remotebuddy-route-test",
      claimToken: delegatedClaimToken,
      jobId,
    });
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ ok: true });

    // The server now infers delegation from its stored handoff, even if the
    // completion payload omits/reports a false requiresWorker value.
    const completed = await postJson(`/requests/${delegatedId}/complete`, {
      agentId: "remotebuddy-route-test",
      claimToken: delegatedClaimToken,
      result: { requiresWorker: false, jobId },
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ ok: true });

    const replayedCompletion = await postJson(`/requests/${delegatedId}/complete`, {
      agentId: "remotebuddy-route-test",
      claimToken: delegatedClaimToken,
      result: { requiresWorker: false, jobId },
    });
    expect(replayedCompletion.status).toBe(200);
    expect(await replayedCompletion.json()).toMatchObject({
      ok: true,
      idempotent: true,
      transitioned: false,
    });
    const staleReplay = await postJson(`/requests/${delegatedId}/complete`, {
      agentId: "remotebuddy-route-test",
      claimToken: "stale-route-token",
      result: { requiresWorker: false, jobId },
    });
    expect(staleReplay.status).toBe(409);

    const requestDetail = await fetch(`http://127.0.0.1:${port}/requests/${delegatedId}`);
    expect(requestDetail.status).toBe(200);
    expect(await requestDetail.json()).toMatchObject({
      ok: true,
      request: {
        id: delegatedId,
        status: "completed",
        agentId: "remotebuddy-route-test",
        claimToken: delegatedClaimToken,
      },
    });

    const listed = await fetch(`http://127.0.0.1:${port}/requests?status=completed&limit=20`);
    const listedPayload = (await listed.json()) as {
      requests: Array<Record<string, unknown>>;
    };
    expect(listedPayload.requests).toContainEqual(
      expect.objectContaining({
        id: delegatedId,
        status: "completed",
        workerRequired: 1,
        handoffJobId: jobId,
        leaseExpiresAt: null,
      }),
    );

    // Simulate a process crash after /jobs/enqueue returned but before the
    // separate handoff callback. On the next claim, the generic request/job
    // reconciler must close the request instead of dispatching it again.
    const crashWindow = await postJson("/requests/enqueue", {
      sessionId: "handoff-session",
      prompt: "Recover my ordinary user handoff after a crash.",
    });
    const crashRequestId = String(
      ((await crashWindow.json()) as Record<string, unknown>).requestId ?? "",
    );
    const crashClaim = await postJson("/requests/claim", {
      agentId: "remotebuddy-crash-window",
      leaseMs: 60_000,
    });
    const crashClaimPayload = (await crashClaim.json()) as {
      request: { claimToken: string };
    };
    const crashJob = await postJson("/jobs/enqueue", {
      taskId: "task-route-crash-window",
      sessionId: "handoff-session",
      kind: "task.execute",
      params: { requestId: crashRequestId },
      requestAgentId: "remotebuddy-crash-window",
      requestClaimToken: crashClaimPayload.request.claimToken,
      dedupeKey: `task.execute:user:handoff-session:request:${crashRequestId}:tests/crash.test.ts`,
    });
    const crashJobId = String(((await crashJob.json()) as Record<string, unknown>).jobId ?? "");
    const db = new Database(join(root, "outputs", "data", "pushpals.db"));
    try {
      db.prepare(`UPDATE requests SET leaseExpiresAt = ? WHERE id = ?`).run(
        new Date(Date.now() - 1_000).toISOString(),
        crashRequestId,
      );
    } finally {
      db.close();
    }
    const replacementClaim = await postJson("/requests/claim", {
      agentId: "remotebuddy-replacement",
    });
    expect(replacementClaim.status).toBe(404);
    const reconciledDetail = await fetch(`http://127.0.0.1:${port}/requests/${crashRequestId}`);
    expect(await reconciledDetail.json()).toMatchObject({
      ok: true,
      request: {
        status: "completed",
        workerRequired: 1,
        handoffJobId: crashJobId,
      },
    });

    const spoofed = await postJson("/requests/enqueue", {
      sessionId: "handoff-session",
      prompt: "Do not trust my completion payload.",
    });
    const spoofedId = String(((await spoofed.json()) as Record<string, unknown>).requestId ?? "");
    const spoofedClaim = await postJson("/requests/claim", {
      agentId: "remotebuddy-route-test",
    });
    expect(spoofedClaim.status).toBe(200);
    const spoofedClaimToken = String(
      ((await spoofedClaim.json()) as { request?: { claimToken?: string } }).request?.claimToken ??
        "",
    );
    const spoofedCompletion = await postJson(`/requests/${spoofedId}/complete`, {
      agentId: "remotebuddy-route-test",
      claimToken: spoofedClaimToken,
      result: { requiresWorker: true, jobId: "job-does-not-exist" },
    });
    expect(spoofedCompletion.status).toBe(409);
    expect(await spoofedCompletion.json()).toMatchObject({
      ok: false,
      code: "worker_handoff_not_recorded",
    });

    expect((await postJson("/completions/claim", {})).status).toBe(400);
    expect((await postJson("/completions/missing/processed", {})).status).toBe(400);
    expect(
      (
        await postJson("/completions/missing/fail", {
          pusherId: "scm-route-test",
          error: "must still carry the claim token",
        })
      ).status,
    ).toBe(400);

    const systemStatus = (await (await fetch(`http://127.0.0.1:${port}/system/status`)).json()) as {
      runtime?: { reconciliation?: Record<string, unknown> };
    };
    expect(Object.keys(systemStatus.runtime?.reconciliation ?? {}).sort()).toEqual([
      "autonomy reservation",
      "completion lease",
      "completion lifecycle",
      "request handoff",
      "request lease",
      "request retry chain",
      "worker handoff",
    ]);
  }, 20_000);
});
