import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  MemoryHttpClient,
  MemoryHttpError,
  REPOSITORY_AGENT_SCHEMA_VERSION,
  RepositoryAgentClient,
  RepositoryAgentClientError,
  RepositoryAgentWorkerClient,
  resolveRepositoryIdentity,
  type RepositoryAgentResult,
  type RepositoryAgentSubmitInput,
} from "shared";
import { resolveRepositoryAgentContext } from "../apps/server/src/repository_agent_context";

const pushPalsRoot = resolve(import.meta.dir, "..");
const bunExecPath = (process.execPath ?? "").trim() || "bun";

type SpawnedServer = {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
  exitCode: number | null;
};

const tempDirs: string[] = [];
const spawnedServers: SpawnedServer[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-memory-repository-routes-"));
  tempDirs.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "pushpals-tests@example.invalid"]);
  git(root, ["config", "user.name", "PushPals Tests"]);
  writeFileSync(join(root, "README.md"), "# Repository Agent route fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)));
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

function commitFixtureConfig(root: string): void {
  writeFileSync(join(root, ".gitignore"), "outputs/\n", "utf8");
  git(root, ["add", "configs", ".env", ".gitignore"]);
  git(root, ["commit", "-m", "server fixture config"]);
}

function spawnServer(root: string, port: number): SpawnedServer {
  const proc = Bun.spawn(
    [bunExecPath, "run", resolve(pushPalsRoot, "apps/server/src/server_main.ts")],
    {
      cwd: pushPalsRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PUSHPALS_PROJECT_ROOT_OVERRIDE: root,
        PUSHPALS_REPO_ROOT_OVERRIDE: root,
        PUSHPALS_CONFIG_DIR_OVERRIDE: join(root, "configs"),
        PUSHPALS_PORT: String(port),
      },
    },
  );
  const spawned: SpawnedServer = {
    proc,
    stdout: new Response(proc.stdout).text(),
    stderr: new Response(proc.stderr).text(),
    exitCode: null,
  };
  void proc.exited.then((code) => {
    spawned.exitCode = code;
  });
  spawnedServers.push(spawned);
  return spawned;
}

async function waitForHealth(
  server: SpawnedServer,
  port: number,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      const [stdout, stderr] = await Promise.all([server.stdout, server.stderr]);
      throw new Error(
        `server exited before health check (code=${server.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await Bun.sleep(75);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function stopServer(server: SpawnedServer, port: number): Promise<void> {
  if (server.exitCode != null) return;
  try {
    await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "route integration test restart" }),
    });
  } catch {
    // Fall through to the bounded process wait/kill below.
  }
  const exited = await Promise.race([
    server.proc.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) {
    try {
      server.proc.kill();
    } catch {
      // Best effort cleanup.
    }
    await server.proc.exited.catch(() => undefined);
  }
}

async function expectMemoryForbidden(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("expected memory operation to be forbidden");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryHttpError);
    expect((error as MemoryHttpError).status).toBe(403);
  }
}

afterEach(async () => {
  while (spawnedServers.length > 0) {
    const server = spawnedServers.pop();
    if (!server) continue;
    if (server.exitCode == null) {
      try {
        server.proc.kill();
      } catch {
        // Best effort cleanup.
      }
    }
    await server.proc.exited.catch(() => undefined);
    await Promise.allSettled([server.stdout, server.stderr]);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await Bun.sleep(attempt * 25);
      }
    }
    if (lastError) throw lastError;
  }
});

describe("server memory routes", () => {
  test("MemoryHttpClient persists records across restart and isolates repositories", async () => {
    const root = initializeFixtureRepo();
    const firstPort = await getFreePort();
    writeServerConfig(root, firstPort);
    commitFixtureConfig(root);
    const firstServer = spawnServer(root, firstPort);
    await waitForHealth(firstServer, firstPort);
    const firstClient = new MemoryHttpClient({ serverUrl: `http://127.0.0.1:${firstPort}` });

    await expect(
      firstClient.put(
        {
          scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
          key: "expired-http-write",
          kind: "ownership",
          summary: "This delayed HTTP write must not commit.",
          provenance: { service: "repository_agent", runId: "expired-http-write" },
        },
        { validUntil: new Date(Date.now() - 1).toISOString() },
      ),
    ).rejects.toThrow("commit fence expired");
    expect(
      await firstClient.get({
        scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
        key: "expired-http-write",
      }),
    ).toBeNull();

    const first = await firstClient.put({
      scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
      key: "routing-owner",
      kind: "ownership",
      subjectKey: "src/router.ts",
      summary: "Repository A routes requests through src/router.ts.",
      value: { owner: "router-a" },
      evidence: [{ path: "README.md", blobOid: "blob-a" }],
      provenance: { service: "repository_agent", runId: "analysis-a" },
      confidence: 0.8,
    });
    await firstClient.put({
      scope: { namespace: "repository.semantic", repositoryId: "repo-b" },
      key: "routing-owner",
      kind: "ownership",
      subjectKey: "src/gateway.ts",
      summary: "Repository B routes requests through src/gateway.ts.",
      value: { owner: "gateway-b" },
      provenance: { service: "repository_agent", runId: "analysis-b" },
    });

    expect(first.revision).toBe(1);
    expect(
      await firstClient.search({
        scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
      }),
    ).toHaveLength(1);
    expect(
      await firstClient.search({
        scope: { namespace: "repository.semantic", repositoryId: "repo-b" },
      }),
    ).toHaveLength(1);
    expect(
      await firstClient.get({
        scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
        key: "routing-owner",
      }),
    ).toMatchObject({ value: { owner: "router-a" } });

    await firstClient.close();
    await stopServer(firstServer, firstPort);

    const secondPort = await getFreePort();
    writeServerConfig(root, secondPort);
    const secondServer = spawnServer(root, secondPort);
    await waitForHealth(secondServer, secondPort);
    const restartedClient = new MemoryHttpClient({ serverUrl: `http://127.0.0.1:${secondPort}` });
    const persisted = await restartedClient.get({
      scope: { namespace: "repository.semantic", repositoryId: "repo-a" },
      key: "routing-owner",
    });
    expect(persisted).toMatchObject({
      id: first.id,
      revision: 1,
      value: { owner: "router-a" },
      provenance: { service: "repository_agent", runId: "analysis-a" },
    });
    expect(
      await restartedClient.get({
        scope: { namespace: "repository.semantic", repositoryId: "repo-c" },
        key: "routing-owner",
      }),
    ).toBeNull();
  });

  test("rejects malformed reinforcement outcomes with a typed 400 and no mutation", async () => {
    const root = initializeFixtureRepo();
    const port = await getFreePort();
    writeServerConfig(root, port);
    commitFixtureConfig(root);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    const serverUrl = `http://127.0.0.1:${port}`;
    const client = new MemoryHttpClient({ serverUrl, callerService: "workerpals" });
    const original = await client.put({
      scope: { namespace: "worker_notes", repositoryId: "repo-a" },
      key: "outcome-integrity",
      kind: "diagnostic",
      summary: "This record must not learn from malformed outcomes.",
      provenance: { service: "workerpals", jobId: "job-integrity" },
      confidence: 0.7,
      usefulness: 0.6,
    });

    const response = await fetch(`${serverUrl}/memory/reinforce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pushpals-memory-caller": "workerpals",
      },
      body: JSON.stringify({
        input: {
          scope: original.scope,
          key: original.key,
          expectedId: original.id,
          observationId: "malformed-outcome-event",
          outcome: "succeeded",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "invalid_reinforcement_outcome",
    });
    expect(await client.get({ scope: original.scope, key: original.key })).toEqual(original);
  });

  test("enforces service-scoped RepositoryAgent namespaces and lifecycle authority", async () => {
    const root = initializeFixtureRepo();
    const port = await getFreePort();
    writeServerConfig(root, port);
    commitFixtureConfig(root);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);
    const serverUrl = `http://127.0.0.1:${port}`;

    const preflight = await fetch(`${serverUrl}/memory/search`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:4173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,x-pushpals-memory-caller,x-pushpals-memory-authority",
      },
    });
    expect(preflight.status).toBe(204);
    const allowedHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("x-pushpals-memory-caller");
    expect(allowedHeaders).toContain("x-pushpals-memory-authority");

    const ordinary = new MemoryHttpClient({
      serverUrl,
      callerService: "workerpals",
    });
    const general = await ordinary.put({
      scope: { namespace: "worker_notes", repositoryId: "repo-a" },
      key: "note-1",
      kind: "diagnostic",
      summary: "Worker-owned diagnostic memory remains generally useful.",
      provenance: { service: "workerpals", jobId: "job-1" },
    });
    expect(
      await ordinary.reinforce({
        scope: general.scope,
        key: general.key,
        expectedId: general.id,
        outcome: "confirmed",
      }),
    ).toMatchObject({ id: general.id, revision: 2 });
    expect(await ordinary.prune({ scope: general.scope })).toBe(0);

    const unprivilegedRemoteBuddy = new MemoryHttpClient({
      serverUrl,
      callerService: "remotebuddy",
    });
    const internalInput = {
      scope: { namespace: "repository_agent_cache", repositoryId: "repo-a" },
      key: "analysis-1",
      kind: "exact_result",
      summary: "Validated RepositoryAgent analysis.",
      provenance: { service: "repository_agent", requestId: "request-1" },
    } as const;
    await expectMemoryForbidden(unprivilegedRemoteBuddy.put(internalInput));
    const capabilityCircuitInput = {
      ...internalInput,
      scope: { namespace: "repository_agent_capabilities", repositoryId: "repo-a" },
      key: "synthesis-model-purpose",
      kind: "repository_agent_capability_circuit",
      summary: "Bounded synthesis circuit state.",
    } as const;
    await expectMemoryForbidden(unprivilegedRemoteBuddy.put(capabilityCircuitInput));

    const invalidAuthorityOwner = new MemoryHttpClient({
      serverUrl,
      callerService: "workerpals",
      authority: "repository_agent",
    });
    await expectMemoryForbidden(invalidAuthorityOwner.put(internalInput));

    const repositoryAgent = new MemoryHttpClient({
      serverUrl,
      callerService: "repository_agent",
      authority: "repository_agent",
    });
    const internal = await repositoryAgent.put(internalInput);
    const capabilityCircuit = await repositoryAgent.put(capabilityCircuitInput);
    expect(capabilityCircuit.scope.namespace).toBe("repository_agent_capabilities");
    expect(
      await repositoryAgent.search({
        scope: internal.scope,
        text: "validated",
      }),
    ).toHaveLength(1);
    expect(
      await repositoryAgent.reinforce({
        scope: internal.scope,
        key: internal.key,
        expectedId: internal.id,
        outcome: "confirmed",
      }),
    ).toMatchObject({ id: internal.id, revision: 2 });
    await expectMemoryForbidden(
      repositoryAgent.reinforce({
        scope: internal.scope,
        key: internal.key,
        expectedId: internal.id,
        outcome: "failed",
      }),
    );
    await expectMemoryForbidden(repositoryAgent.prune());

    const serverAuthority = new MemoryHttpClient({
      serverUrl,
      callerService: "server",
      authority: "server",
    });
    expect(
      await serverAuthority.reinforce({
        scope: internal.scope,
        key: internal.key,
        expectedId: internal.id,
        outcome: "failed",
      }),
    ).toMatchObject({ id: internal.id, revision: 3 });
    expect(await serverAuthority.prune()).toBe(0);

    const missingIdentity = await fetch(`${serverUrl}/memory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { scope: general.scope } }),
    });
    expect(missingIdentity.status).toBe(403);
    const spoofedAuthority = await fetch(`${serverUrl}/memory/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pushpals-memory-caller": "workerpals",
        "x-pushpals-memory-authority": "repository_agent",
      },
      body: JSON.stringify({ query: { scope: internal.scope } }),
    });
    expect(spoofedAuthority.status).toBe(403);
  });
});

describe("server RepositoryAgent routes", () => {
  test("rejects oversized chunked control bodies without destabilizing Server", async () => {
    const root = initializeFixtureRepo();
    const port = await getFreePort();
    writeServerConfig(root, port);
    commitFixtureConfig(root);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const encoder = new TextEncoder();
    const parts = [
      '{"agentId":"oversized","padding":"',
      ...Array.from({ length: 5 }, () => "x".repeat(16 * 1024)),
      '"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/repository-agent/requests/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("too large");

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
  });

  test("maps repository roots and fences submit, claim, renew, complete, get, and ask", async () => {
    const root = initializeFixtureRepo();
    const port = await getFreePort();
    writeServerConfig(root, port);
    commitFixtureConfig(root);
    const server = spawnServer(root, port);
    await waitForHealth(server, port);

    const identity = await resolveRepositoryIdentity(root);
    const canonical = await resolveRepositoryAgentContext({ canonicalRepoRoot: root });
    const input: RepositoryAgentSubmitInput = {
      caller: { sessionId: "route-test", correlationId: "correlation-1" },
      purpose: "architecture",
      repository: {
        ...canonical.repository,
        identity: identity.repositoryId,
        root: "/workspace/container-only/repository",
      },
      question: "Which file establishes the repository fixture?",
      context: { targetPaths: ["README.md"] },
      priority: "normal",
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      freshness: "cache_preferred",
      idempotencyKey: `route-test:${canonical.repository.revision}`,
    };
    const caller = new RepositoryAgentClient({
      serverUrl: `http://127.0.0.1:${port}`,
      callerService: "source_control_manager",
      callerInstanceId: "scm-route-test",
      pollIntervalMs: 100,
    });
    const worker = new RepositoryAgentWorkerClient({
      serverUrl: `http://127.0.0.1:${port}`,
    });

    const submitted = await caller.submit(input);
    expect(submitted).toMatchObject({ status: "queued", deduplicated: false });
    try {
      await caller.submit({
        ...input,
        question: "A different question must not reuse the first request result.",
      });
      throw new Error("conflicting RepositoryAgent idempotency payload was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAgentClientError);
      expect((error as RepositoryAgentClientError).status).toBe(409);
      expect((error as RepositoryAgentClientError).remoteCode).toBe("idempotency_conflict");
      expect((error as RepositoryAgentClientError).requestId).toBe(submitted.requestId);
    }
    const claim = await worker.claim({
      agentId: "repository-agent-route-test",
      leaseMs: 30_000,
      repositoryIdentities: [identity.repositoryId],
    });
    expect(claim.claim).not.toBeNull();
    const authority = {
      agentId: "repository-agent-route-test",
      claimToken: claim.claim!.claimToken,
      claimGeneration: claim.claim!.claimGeneration,
    };
    expect(claim.claim?.request.repository).toMatchObject({
      identity: identity.repositoryId,
      root: canonical.repository.root,
      revision: canonical.repository.revision,
      tree: canonical.repository.tree,
    });
    expect(claim.claim?.request.context).toMatchObject({ callerRootMappedToHost: true });

    for (const staleAuthority of [
      { ...authority, claimToken: "stale-token" },
      { ...authority, claimGeneration: authority.claimGeneration + 1 },
    ]) {
      try {
        await worker.renewLease(submitted.requestId, { ...staleAuthority, leaseMs: 30_000 });
        throw new Error("stale RepositoryAgent authority was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryAgentClientError);
        expect((error as RepositoryAgentClientError).status).toBe(409);
      }
    }

    const renewed = await worker.renewLease(submitted.requestId, {
      ...authority,
      leaseMs: 30_000,
    });
    expect(renewed.status).toBe("claimed");
    expect(Date.parse(renewed.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());

    const result: RepositoryAgentResult = {
      schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
      requestId: submitted.requestId,
      analyzedRepository: {
        identity: claim.claim!.request.repository.identity,
        revision: claim.claim!.request.repository.revision,
        tree: claim.claim!.request.repository.tree,
      },
      answer: "README.md establishes the route-test repository fixture.",
      summary: "README.md is the fixture evidence.",
      confidence: 0.98,
      evidence: [
        {
          path: "README.md",
          revision: claim.claim!.request.repository.revision,
          startLine: 1,
          endLine: 1,
          rationale: "The committed fixture marker is defined here.",
        },
      ],
      recommendations: [],
      validationProposals: [],
      cache: { hit: false, key: `route-test:${submitted.requestId}` },
      memoryRefs: [],
      completedAt: new Date().toISOString(),
    };
    const completed = await worker.complete(submitted.requestId, { ...authority, result });
    expect(completed.status).toBe("completed");

    const snapshot = await caller.get(submitted.requestId);
    expect(snapshot).toMatchObject({
      status: "completed",
      result: {
        requestId: submitted.requestId,
        answer: result.answer,
        analyzedRepository: result.analyzedRepository,
      },
    });
    const asked = await caller.ask(input, { timeoutMs: 5_000, pollIntervalMs: 100 });
    expect(asked.requestId).toBe(submitted.requestId);
    expect(asked.answer).toBe(result.answer);

    try {
      await worker.complete(submitted.requestId, { ...authority, result });
      throw new Error("completed RepositoryAgent lease was reused");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAgentClientError);
      expect((error as RepositoryAgentClientError).status).toBe(409);
    }

    const retrySubmitted = await caller.submit({
      ...input,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      idempotencyKey: `${input.idempotencyKey}:retryable-failure`,
    });
    const retryClaim = await worker.claim({
      agentId: "repository-agent-route-test",
      leaseMs: 30_000,
      repositoryIdentities: [identity.repositoryId],
    });
    expect(retryClaim.claim?.requestId).toBe(retrySubmitted.requestId);
    const retryAck = await worker.fail(retrySubmitted.requestId, {
      agentId: "repository-agent-route-test",
      claimToken: retryClaim.claim!.claimToken,
      claimGeneration: retryClaim.claim!.claimGeneration,
      error: {
        code: "temporary_model_failure",
        message: "temporary failure",
        retryable: true,
      },
    });
    expect(retryAck.status).toBe("queued");
    expect((await caller.get(retrySubmitted.requestId)).status).toBe("queued");
    const systemStatus = (await (await fetch(`http://127.0.0.1:${port}/system/status`)).json()) as {
      queues?: {
        repositoryAgentHealth?: {
          delayedRetryCount?: number;
          maxClaimAttempts?: number;
          unhealthy?: boolean;
        };
      };
    };
    expect(systemStatus.queues?.repositoryAgentHealth).toMatchObject({
      maxClaimAttempts: 3,
      unhealthy: false,
    });
    expect(typeof systemStatus.queues?.repositoryAgentHealth?.delayedRetryCount).toBe("number");
  });
});
