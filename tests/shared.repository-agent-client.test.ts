import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPOSITORY_AGENT_LIMITS,
  REPOSITORY_AGENT_SCHEMA_VERSION,
  createRepositoryAgentServiceClients,
  RepositoryAgentClient,
  RepositoryAgentClientError,
  RepositoryAgentWorkerClient,
  reinforceRepositoryAgentMemory,
  type RepositoryAgent,
  type RepositoryAgentResult,
  type RepositoryAgentSubmitInput,
} from "../packages/shared/src/repository_agent";
import { InMemoryMemoryStore, MemoryStoreClosedError } from "../packages/shared/src/memory";

const nowIso = () => new Date().toISOString();
const futureIso = (offsetMs = 60_000) => new Date(Date.now() + offsetMs).toISOString();

const BACKEND_SERVICE_PACKAGES = [
  "server",
  "localbuddy",
  "remotebuddy",
  "workerpals",
  "source_control_manager",
] as const;

const BACKEND_SERVICE_ENTRYPOINTS = {
  server: "server_main.ts",
  localbuddy: "localbuddy_main.ts",
  remotebuddy: "remotebuddy_main.ts",
  workerpals: "workerpals_main.ts",
  source_control_manager: "source_control_manager_main.ts",
} as const;

function requestInput(
  overrides: Partial<RepositoryAgentSubmitInput> = {},
): RepositoryAgentSubmitInput {
  return {
    purpose: "architecture",
    repository: {
      identity: "github.com/example/project",
      root: "C:/work/project",
      revision: "abc123",
      tree: "tree123",
      dirty: false,
    },
    question: "Which component owns request routing?",
    context: { paths: ["src/router.ts"], reason: "planning" },
    priority: "normal",
    deadlineAt: futureIso(),
    freshness: "cache_preferred",
    idempotencyKey: "architecture:abc123:router",
    ...overrides,
  };
}

function result(requestId = "repo-request-1", memoryId = "memory-1"): RepositoryAgentResult {
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    requestId,
    analyzedRepository: {
      identity: "github.com/example/project",
      revision: "abc123",
      tree: "tree123",
    },
    answer: "The router module owns request routing.",
    summary: "Routing is owned by src/router.ts.",
    confidence: 0.91,
    evidence: [
      {
        path: "src/router.ts",
        revision: "abc123",
        blobHash: "blob123",
        startLine: 10,
        endLine: 24,
      },
    ],
    recommendations: [
      {
        title: "Keep changes in the router",
        rationale: "It owns the relevant boundary.",
        priority: "normal",
        paths: ["src/router.ts"],
      },
    ],
    validationProposals: [
      {
        label: "Router tests",
        cwd: ".",
        argv: ["bun", "test", "tests/router.test.ts"],
        rationale: "Exercises request routing directly.",
      },
    ],
    cache: { hit: false, key: "repo-analysis:abc123:router" },
    memoryRefs: [
      {
        id: memoryId,
        namespace: "repository-facts",
        key: "routing-owner",
        role: "analysis_cache",
        relevance: 0.93,
        sourceRevision: "abc123",
      },
    ],
    completedAt: nowIso(),
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("RepositoryAgentClient", () => {
  test("submits a versioned, caller-attributed request with auth and bounded fields", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new RepositoryAgentClient({
      serverUrl: "http://127.0.0.1:3001/",
      callerService: "source_control_manager",
      callerInstanceId: "scm-1",
      authToken: "secret-token",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({
          ok: true,
          requestId: "repo-request-1",
          status: "queued",
          deduplicated: false,
          pollAfterMs: 750,
        });
      },
    });

    const submitted = await client.submit(
      requestInput({
        caller: {
          sessionId: "dev",
          correlationId: "trace-1",
          service: "workerpals",
          instanceId: "spoofed-worker",
        } as never,
      }),
    );

    expect(submitted).toEqual({
      requestId: "repo-request-1",
      status: "queued",
      deduplicated: false,
      pollAfterMs: 750,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3001/repository-agent/requests");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, any>;
    expect(body).toMatchObject({
      schemaVersion: 1,
      caller: {
        service: "source_control_manager",
        instanceId: "scm-1",
        sessionId: "dev",
        correlationId: "trace-1",
      },
      purpose: "architecture",
      repository: {
        identity: "github.com/example/project",
        root: "C:/work/project",
        revision: "abc123",
        tree: "tree123",
        dirty: false,
      },
      priority: "normal",
      freshness: "cache_preferred",
      idempotencyKey: "architecture:abc123:router",
    });
  });

  test("offers the same typed repository capability to every PushPals service", async () => {
    const services = [
      "server",
      "localbuddy",
      "remotebuddy",
      "workerpals",
      "source_control_manager",
      "repository_agent",
      "cli",
      "client",
    ] as const;

    for (const callerService of services) {
      let submittedCaller = "";
      const client = new RepositoryAgentClient({
        serverUrl: "http://server.test",
        callerService,
        callerInstanceId: `${callerService}-test`,
        fetchImpl: async (_input, init) => {
          submittedCaller = String(
            (JSON.parse(String(init?.body)) as { caller?: { service?: string } }).caller?.service,
          );
          return jsonResponse({
            ok: true,
            requestId: `request-${callerService}`,
            status: "queued",
            deduplicated: false,
            pollAfterMs: 100,
          });
        },
      });

      const submitted = await client.submit(
        requestInput({ idempotencyKey: `service-contract:${callerService}` }),
      );
      expect(submitted.requestId).toBe(`request-${callerService}`);
      expect(submittedCaller).toBe(callerService);
    }
  });

  test("creates inert RepositoryAgent and memory clients for every caller service", async () => {
    const services = [
      "server",
      "localbuddy",
      "remotebuddy",
      "workerpals",
      "source_control_manager",
      "repository_agent",
      "cli",
      "client",
    ] as const;

    for (const callerService of services) {
      let fetches = 0;
      const clients = createRepositoryAgentServiceClients({
        serverUrl: "http://server.test",
        callerService,
        callerInstanceId: `${callerService}-test`,
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("construction must not perform HTTP I/O");
        },
      });

      expect(fetches).toBe(0);
      await clients.close();
      expect(fetches).toBe(0);
    }
  });

  test("pins caller identity and keeps RepositoryAgent and memory endpoints distinct", async () => {
    const paths: string[] = [];
    let submittedCaller = "";
    const clients = createRepositoryAgentServiceClients({
      serverUrl: "http://server.test",
      callerService: "source_control_manager",
      callerInstanceId: "scm-runtime-1",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/repository-agent/requests") {
          const body = JSON.parse(String(init?.body)) as {
            caller?: { service?: string; instanceId?: string };
          };
          submittedCaller = `${body.caller?.service}:${body.caller?.instanceId}`;
          return jsonResponse({
            ok: true,
            requestId: "request-service-clients",
            status: "queued",
            deduplicated: false,
            pollAfterMs: 100,
          });
        }
        if (path === "/memory/prune") {
          return jsonResponse({ ok: true, count: 0 });
        }
        throw new Error(`unexpected endpoint: ${path}`);
      },
    });

    const spoofedInput = requestInput({
      idempotencyKey: "service-clients:pinned-caller",
      caller: { service: "workerpals" },
    } as Partial<RepositoryAgentSubmitInput>);
    await clients.repositoryAgent.submit(spoofedInput);
    await clients.memoryStore.prune();

    expect(submittedCaller).toBe("source_control_manager:scm-runtime-1");
    expect(paths).toEqual(["/repository-agent/requests", "/memory/prune"]);
    await clients.close();
    await expect(clients.memoryStore.prune()).rejects.toBeInstanceOf(MemoryStoreClosedError);
  });

  test("does not close injected RepositoryAgent or memory ownership", async () => {
    const repositoryAgent: RepositoryAgent = {
      submit: async () => {
        throw new Error("not called");
      },
      get: async () => {
        throw new Error("not called");
      },
      ask: async () => {
        throw new Error("not called");
      },
    };
    class TrackingMemoryStore extends InMemoryMemoryStore {
      closeCalls = 0;

      override async close(): Promise<void> {
        this.closeCalls += 1;
        await super.close();
      }
    }
    const memoryStore = new TrackingMemoryStore();
    const clients = createRepositoryAgentServiceClients({
      serverUrl: "http://server.test",
      callerService: "server",
      repositoryAgent,
      memoryStore,
      fetchImpl: async () => {
        throw new Error("injected capabilities must not use the factory transport");
      },
    });

    expect(clients.repositoryAgent).toBe(repositoryAgent);
    expect(clients.memoryStore).toBe(memoryStore);
    await clients.close();
    await clients.close();
    expect(memoryStore.closeCalls).toBe(0);
    expect(await memoryStore.prune()).toBe(0);
    await memoryStore.close();
  });

  test("makes the shared capability importable by every backend service package", () => {
    for (const service of BACKEND_SERVICE_PACKAGES) {
      const manifest = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "apps", service, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };

      expect(manifest.dependencies?.shared).toBe("workspace:*");
    }
  });

  test("wires one shared capability bundle at every backend service composition root", () => {
    for (const service of BACKEND_SERVICE_PACKAGES) {
      const source = readFileSync(
        join(import.meta.dir, "..", "apps", service, "src", BACKEND_SERVICE_ENTRYPOINTS[service]),
        "utf8",
      );

      expect(source).toContain("createRepositoryAgentServiceClients({");
      expect(source).toContain(`callerService: "${service}"`);
      expect(source).toContain("repositoryServices");
    }
  });

  test("reinforces addressable learned memory through the separate memory interface", async () => {
    const memory = new InMemoryMemoryStore();
    const stored = await memory.put({
      scope: {
        namespace: "repository-facts",
        repositoryId: "github.com/example/project",
      },
      key: "routing-owner",
      kind: "ownership",
      summary: "Routing is owned by src/router.ts.",
      evidence: [{ path: "src/router.ts", blobOid: "blob123" }],
      provenance: { service: "repository_agent", requestId: "repo-request-1" },
      confidence: 0.6,
      usefulness: 0.5,
    });

    const reinforced = await reinforceRepositoryAgentMemory({
      memory,
      repositoryId: "github.com/example/project",
      result: result("repo-request-1", stored.id),
      outcome: "successful",
      provenance: { service: "source_control_manager", jobId: "job-1" },
    });

    expect(reinforced.attempted).toBe(1);
    expect(reinforced.missing).toEqual([]);
    expect(reinforced.failed).toEqual([]);
    expect(reinforced.updated[0]?.revision).toBe(stored.revision + 1);
    expect(reinforced.updated[0]?.usefulness).toBeGreaterThan(stored.usefulness);
    expect(reinforced.updated[0]?.observations).toHaveLength(1);
    const repeated = await reinforceRepositoryAgentMemory({
      memory,
      repositoryId: "github.com/example/project",
      result: result("repo-request-1", stored.id),
      outcome: "successful",
      provenance: { service: "source_control_manager", jobId: "job-1" },
    });
    expect(repeated.updated[0]?.revision).toBe(reinforced.updated[0]?.revision);
    expect(repeated.updated[0]?.observations).toHaveLength(1);

    const staleReference = await reinforceRepositoryAgentMemory({
      memory,
      repositoryId: "github.com/example/project",
      result: result("repo-request-stale", "replaced-memory-record"),
      outcome: "failed",
      observationId: "stale-publication-outcome",
    });
    expect(staleReference.updated).toEqual([]);
    expect(staleReference.failed).toHaveLength(1);
    expect(staleReference.failed[0]?.code).toBe("record_conflict");
    expect(staleReference.failed[0]?.message).toContain("Memory record conflict");
    expect(
      (
        await memory.get({
          scope: stored.scope,
          key: stored.key,
        })
      )?.revision,
    ).toBe(reinforced.updated[0]?.revision);
    await expect(
      reinforceRepositoryAgentMemory({
        memory,
        repositoryId: "github.com/another/project",
        result: result(),
        outcome: "successful",
      }),
    ).rejects.toThrow("identity does not match");
  });

  test("rejects expired, oversized, non-JSON, and unsafe request data before transport", async () => {
    let calls = 0;
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "remotebuddy",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });

    const cases: RepositoryAgentSubmitInput[] = [
      requestInput({ deadlineAt: new Date(Date.now() - 1_000).toISOString() }),
      requestInput({
        deadlineAt: new Date(
          Date.now() + REPOSITORY_AGENT_LIMITS.deadlineHorizonMs + 60_000,
        ).toISOString(),
      }),
      requestInput({ question: "x".repeat(REPOSITORY_AGENT_LIMITS.questionChars + 1) }),
      requestInput({ context: { score: Number.POSITIVE_INFINITY } }),
      requestInput({ context: JSON.parse('{"__proto__":{"polluted":true}}') }),
    ];

    for (const input of cases) {
      try {
        await client.submit(input);
        throw new Error("expected submit to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryAgentClientError);
        expect((error as RepositoryAgentClientError).code).toBe("invalid_request");
      }
    }
    expect(calls).toBe(0);
  });

  test("sanitizes bounded structured results and discards unsafe evidence", async () => {
    const oversized = {
      ...result(),
      answer: "a".repeat(REPOSITORY_AGENT_LIMITS.answerChars + 500),
      confidence: 5,
      evidence: [
        ...result().evidence,
        { path: "C:/outside/secret.ts", revision: "abc123" },
        { path: "../outside.ts", revision: "abc123" },
      ],
      validationProposals: [
        ...result().validationProposals,
        {
          label: "unsafe cwd",
          cwd: "../outside",
          argv: ["run-tests"],
          rationale: "must be dropped",
        },
      ],
    };
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "workerpals",
      fetchImpl: async () =>
        jsonResponse({
          ok: true,
          request: {
            requestId: "repo-request-1",
            status: "completed",
            submittedAt: nowIso(),
            updatedAt: nowIso(),
            result: oversized,
          },
        }),
    });

    const snapshot = await client.get("repo-request-1");
    expect(snapshot.result?.confidence).toBe(1);
    expect(snapshot.result?.answer.length).toBeLessThanOrEqual(REPOSITORY_AGENT_LIMITS.answerChars);
    expect(snapshot.result?.evidence).toHaveLength(1);
    expect(snapshot.result?.evidence[0]?.path).toBe("src/router.ts");
    expect(snapshot.result?.validationProposals).toHaveLength(1);
    expect(snapshot.result?.validationProposals[0]?.argv).toEqual([
      "bun",
      "test",
      "tests/router.test.ts",
    ]);
  });

  test("submits and polls to completion within one overall ask deadline", async () => {
    let call = 0;
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "remotebuddy",
      pollIntervalMs: 1,
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse({
            ok: true,
            requestId: "repo-request-1",
            status: "queued",
            pollAfterMs: 1,
          });
        }
        if (call === 2) {
          return jsonResponse({
            ok: true,
            request: {
              requestId: "repo-request-1",
              status: "running",
              submittedAt: nowIso(),
              updatedAt: nowIso(),
              pollAfterMs: 1,
            },
          });
        }
        return jsonResponse({
          ok: true,
          request: {
            requestId: "repo-request-1",
            status: "completed",
            submittedAt: nowIso(),
            updatedAt: nowIso(),
            result: result(),
          },
        });
      },
    });

    const completed = await client.ask(requestInput(), { timeoutMs: 2_000, pollIntervalMs: 1 });
    expect(completed.summary).toContain("src/router.ts");
    expect(call).toBe(3);
  });

  test("surfaces remote terminal failures with stable typed error codes", async () => {
    let call = 0;
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "localbuddy",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse({
            ok: true,
            requestId: "repo-request-failed",
            status: "queued",
            pollAfterMs: 1,
          });
        }
        return jsonResponse({
          ok: true,
          request: {
            requestId: "repo-request-failed",
            status: "failed",
            submittedAt: nowIso(),
            updatedAt: nowIso(),
            error: {
              code: "model_unavailable",
              message: "Assigned model is unavailable",
              retryable: true,
            },
          },
        });
      },
    });

    try {
      await client.ask(requestInput(), { timeoutMs: 2_000, pollIntervalMs: 1 });
      throw new Error("expected ask to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAgentClientError);
      expect((error as RepositoryAgentClientError).code).toBe("remote_failed");
      expect((error as RepositoryAgentClientError).requestId).toBe("repo-request-failed");
      expect((error as RepositoryAgentClientError).remoteCode).toBe("model_unavailable");
      expect((error as RepositoryAgentClientError).retryable).toBe(true);
      expect((error as Error).message).toContain("Assigned model");
    }
  });

  test("bounds a transport that never settles and aborts the underlying signal", async () => {
    let signal: AbortSignal | undefined;
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "server",
      requestTimeoutMs: 20,
      fetchImpl: (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });

    try {
      await client.submit(requestInput());
      throw new Error("expected submit to time out");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAgentClientError);
      expect((error as RepositoryAgentClientError).code).toBe("timeout");
      expect(signal?.aborted).toBe(true);
    }
  });

  test("preserves caller abort separately from timeout", async () => {
    const controller = new AbortController();
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "client",
      requestTimeoutMs: 1_000,
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    setTimeout(() => controller.abort(), 10);

    try {
      await client.submit(requestInput(), { signal: controller.signal });
      throw new Error("expected submit to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAgentClientError);
      expect((error as RepositoryAgentClientError).code).toBe("aborted");
    }
  });

  test("reports HTTP status, request identity, and retry timing", async () => {
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "cli",
      fetchImpl: async () =>
        jsonResponse(
          {
            ok: false,
            requestId: "repo-request-rate-limited",
            code: "capacity_exhausted",
            message: "Repository Agent is at capacity",
            retryAfterMs: 4_500,
            retryable: true,
          },
          { status: 429 },
        ),
    });

    try {
      await client.submit(requestInput());
      throw new Error("expected submit to fail");
    } catch (error) {
      const typed = error as RepositoryAgentClientError;
      expect(typed.code).toBe("http_error");
      expect(typed.status).toBe(429);
      expect(typed.requestId).toBe("repo-request-rate-limited");
      expect(typed.retryAfterMs).toBe(4_500);
      expect(typed.remoteCode).toBe("capacity_exhausted");
      expect(typed.retryable).toBe(true);
    }
  });

  test("worker client implements claim, lease renewal, completion, and failure contracts", async () => {
    const paths: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const wireRequest = {
      schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
      caller: { service: "remotebuddy" },
      ...requestInput(),
    };

    let call = 0;
    const client = new RepositoryAgentWorkerClient({
      serverUrl: "http://server.test",
      fetchImpl: async (input, init) => {
        paths.push(new URL(String(input)).pathname);
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        call += 1;
        if (call === 1) {
          return jsonResponse({
            ok: true,
            pollAfterMs: 1_000,
            claim: {
              requestId: "repo-request-1",
              claimToken: "claim-token-1",
              claimGeneration: 2,
              leaseExpiresAt: futureIso(),
              request: wireRequest,
            },
          });
        }
        return jsonResponse({
          ok: true,
          requestId: "repo-request-1",
          status: call === 2 ? "claimed" : call === 3 ? "completed" : "failed",
          ...(call === 2 ? { leaseExpiresAt: futureIso() } : {}),
        });
      },
    });

    const authority = {
      agentId: "repository-agent-1",
      claimToken: "claim-token-1",
      claimGeneration: 2,
    };
    const claim = await client.claim({
      agentId: authority.agentId,
      leaseMs: 30_000,
      repositoryIdentities: ["github.com/example/project"],
      capabilities: { backends: ["openai_codex"] },
    });
    expect(claim.claim?.request.purpose).toBe("architecture");
    expect(claim.claim?.claimGeneration).toBe(2);

    await client.renewLease("repo-request-1", { ...authority, leaseMs: 30_000 });
    await client.complete("repo-request-1", { ...authority, result: result() });
    await client.fail("repo-request-1", {
      ...authority,
      error: { code: "analysis_failed", message: "Analysis failed", retryable: true },
    });

    expect(paths).toEqual([
      "/repository-agent/requests/claim",
      "/repository-agent/requests/repo-request-1/lease/renew",
      "/repository-agent/requests/repo-request-1/complete",
      "/repository-agent/requests/repo-request-1/fail",
    ]);
    expect(bodies[0]).toMatchObject({
      agentId: "repository-agent-1",
      leaseMs: 30_000,
      repositoryIdentities: ["github.com/example/project"],
    });
    expect(bodies[2]).toMatchObject({
      agentId: "repository-agent-1",
      claimToken: "claim-token-1",
      claimGeneration: 2,
      result: { requestId: "repo-request-1", schemaVersion: 1 },
    });
    expect(bodies[3]).toMatchObject({
      error: { code: "analysis_failed", message: "Analysis failed", retryable: true },
    });
  });

  test("keeps caller and worker authority on separate client surfaces", () => {
    const caller = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "workerpals",
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    const worker = new RepositoryAgentWorkerClient({
      serverUrl: "http://server.test",
      fetchImpl: async () => jsonResponse({ ok: true }),
    });

    expect("claim" in caller).toBe(false);
    expect("renewLease" in caller).toBe(false);
    expect("complete" in caller).toBe(false);
    expect("fail" in caller).toBe(false);
    expect("submit" in worker).toBe(false);
    expect("get" in worker).toBe(false);
    expect("ask" in worker).toBe(false);
  });

  test("rejects malformed success acknowledgements and mismatched result identities", async () => {
    const responses = [
      jsonResponse({ ok: "true", requestId: "repo-request-1", status: "queued" }),
      jsonResponse({
        ok: true,
        requestId: "repo-request-1",
        status: "completed",
        result: result("another-request"),
      }),
    ];
    const client = new RepositoryAgentClient({
      serverUrl: "http://server.test",
      callerService: "server",
      fetchImpl: async () => responses.shift()!,
    });

    for (let index = 0; index < 2; index += 1) {
      try {
        await client.submit(requestInput());
        throw new Error("expected malformed acknowledgement to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(RepositoryAgentClientError);
        expect((error as RepositoryAgentClientError).code).toBe("invalid_response");
      }
    }
  });
});
