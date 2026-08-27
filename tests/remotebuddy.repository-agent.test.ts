import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  InMemoryMemoryStore,
  REPOSITORY_AGENT_SCHEMA_VERSION,
  RepositoryAgentClientError,
  resolveRepositorySnapshot,
  type RepositoryAgentClaim,
  type RepositoryAgentClaimInput,
  type RepositoryAgentClaimResult,
  type RepositoryAgentCompleteInput,
  type RepositoryAgentFailInput,
  type RepositoryAgentLeaseInput,
  type RepositoryAgentLeaseResult,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RepositoryAgentWorkerControl,
} from "../packages/shared/src";
import type { LLMClient, LLMGenerateInput, LLMGenerateOutput } from "../apps/remotebuddy/src/llm";
import {
  RepositoryAgentWorker,
  assertRepositoryGitInspectionResult,
} from "../apps/remotebuddy/src/repository_agent";
import { SqliteMemoryStore } from "../apps/server/src/memory_store";

const tempDirs: string[] = [];
setDefaultTimeout(30_000);

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function createRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "pushpals-repository-agent-"));
  tempDirs.push(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, "vision.md"),
    "# Vision\n\n## Priorities\n\nShip reliable repository-native improvements.\n",
  );
  writeFileSync(join(repo, "README.md"), "# Example\n\nA portable test repository.\n");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "portable-example", scripts: { test: "bun test" } }, null, 2),
  );
  writeFileSync(join(repo, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\njobs: {}\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "initial fixture",
    ],
    { cwd: repo, stdio: "ignore" },
  );
  return repo;
}

async function requestFor(
  repo: string,
  overrides: Partial<RepositoryAgentRequest> = {},
): Promise<RepositoryAgentRequest> {
  const snapshot = await resolveRepositorySnapshot(repo);
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    caller: { service: "remotebuddy", sessionId: "test-session" },
    purpose: "priority",
    repository: snapshot,
    question: "Which vision priority should the next change advance?",
    context: { targetPaths: ["src/index.ts"] },
    priority: "normal",
    deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    freshness: "cache_preferred",
    idempotencyKey: `test-${Math.random()}`,
    ...overrides,
  };
}

function modelResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answer: "Advance the repository's documented reliability priority.",
    summary: "The vision prioritizes reliable repository-native improvements.",
    data: {
      candidates: [
        {
          title: "Improve repository reliability",
          target_paths: ["src/index.ts"],
        },
      ],
    },
    confidence: 0.9,
    evidence: [{ path: "vision.md", startLine: 3, endLine: 5, rationale: "Priority text" }],
    recommendations: [
      {
        title: "Follow the documented priority",
        rationale: "The repository explicitly names it.",
        priority: "high",
        paths: ["vision.md", "src/index.ts"],
      },
    ],
    validationProposals: [
      {
        label: "Run repository tests",
        cwd: ".",
        argv: ["bun", "test"],
        rationale: "Suggested by the manifest; host validation remains authoritative.",
      },
    ],
    ...overrides,
  };
}

class FakeLlm implements LLMClient {
  calls: LLMGenerateInput[] = [];
  discoveryCalls: LLMGenerateInput[] = [];
  analysisCalls: LLMGenerateInput[] = [];

  constructor(
    private readonly response: () => Record<string, unknown> = () => modelResponse(),
    private readonly delayMs = 0,
    private readonly discoveryResponse: () => Record<string, unknown> | string = () => ({
      paths: [],
    }),
    private readonly attribution: Pick<LLMGenerateOutput, "provider" | "modelId"> = {},
  ) {}

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    this.calls.push(input);
    const schemaProperties = input.jsonSchema?.properties;
    const discovery =
      schemaProperties != null &&
      typeof schemaProperties === "object" &&
      "paths" in schemaProperties &&
      !("answer" in schemaProperties);
    (discovery ? this.discoveryCalls : this.analysisCalls).push(input);
    if (this.delayMs > 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.delayMs));
    const output = discovery ? this.discoveryResponse() : this.response();
    return {
      text: typeof output === "string" ? output : JSON.stringify(output),
      ...this.attribution,
    };
  }
}

class FakeWorkerControl implements RepositoryAgentWorkerControl {
  claimValue: RepositoryAgentClaim | null;
  renewals = 0;
  completed: RepositoryAgentResult | null = null;
  failed: RepositoryAgentFailInput["error"] | null = null;

  constructor(claim: RepositoryAgentClaim | null) {
    this.claimValue = claim;
  }

  async claim(_input: RepositoryAgentClaimInput): Promise<RepositoryAgentClaimResult> {
    const claim = this.claimValue;
    this.claimValue = null;
    return { claim, pollAfterMs: 5 };
  }

  async renewLease(
    requestId: string,
    _input: RepositoryAgentLeaseInput,
  ): Promise<RepositoryAgentLeaseResult> {
    this.renewals++;
    return {
      requestId,
      status: "claimed",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async complete(
    requestId: string,
    input: RepositoryAgentCompleteInput,
  ): Promise<RepositoryAgentLeaseResult> {
    this.completed = input.result;
    return { requestId, status: "completed" };
  }

  async fail(
    requestId: string,
    input: RepositoryAgentFailInput,
  ): Promise<RepositoryAgentLeaseResult> {
    this.failed = input.error;
    return { requestId, status: "failed" };
  }
}

function unusedControl(): RepositoryAgentWorkerControl {
  return new FakeWorkerControl(null);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("RemoteBuddy-hosted Repository Agent", () => {
  test("fails closed when Git exits successfully but bounded output draining times out", () => {
    expect(() =>
      assertRepositoryGitInspectionResult(["ls-files"], {
        stdout: "vision.md\0",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutDecodeError: false,
        stderrDecodeError: false,
        exitCode: 0,
        timedOut: false,
        drainTimedOut: true,
      }),
    ).toThrow("Repository Git inspection failed: git ls-files");
  });

  test("uses isolated bounded evidence, preserves candidates, caches, recalls, and reinforces", async () => {
    const repo = createRepository();
    const request = await requestFor(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      agentId: "repository-agent-test",
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
      modelId: "assigned-test-model",
    });

    const first = await worker.analyze("request-1", request);
    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(llm.analysisCalls[0]?.executionContext).toEqual({
      repositoryMode: "isolated-evidence",
    });
    const firstPayload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket?: { files?: Array<{ path: string }> };
    };
    expect(firstPayload.evidencePacket?.files?.map((entry) => entry.path)).toContain("vision.md");
    expect(first.cache.hit).toBe(false);
    expect(first.data).toEqual(modelResponse().data);
    expect(first.evidence[0]?.path).toBe("vision.md");
    expect(first.evidence[0]?.revision).toBe(request.repository.revision);
    expect(first.evidence[0]?.blobHash).toBe(git(repo, ["rev-parse", "HEAD:vision.md"]));
    expect(first.memoryRefs.map((ref) => ref.namespace).sort()).toEqual([
      "repository_agent_cache",
      "repository_facts",
    ]);
    expect(first.memoryRefs.every((ref) => Boolean(ref.id && ref.key))).toBe(true);

    const second = await worker.analyze("request-2", {
      ...request,
      idempotencyKey: "second-request",
    });
    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(second.requestId).toBe("request-2");
    expect(second.cache.hit).toBe(true);
    expect(second.memoryRefs.map((ref) => ref.namespace)).toContain("repository_agent_cache");
    const exactRecords = await memory.search({
      scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect(exactRecords).toHaveLength(1);
    expect(exactRecords[0]?.usefulness).toBeGreaterThan(0.5);

    const fresh = await worker.analyze("request-3", {
      ...request,
      freshness: "fresh_required",
      idempotencyKey: "fresh-request",
    });
    expect(fresh.cache.hit).toBe(false);
    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(2);
    const freshPayload = JSON.parse(llm.analysisCalls[1]?.messages[0]?.content ?? "{}") as {
      advisoryMemory?: unknown[];
    };
    expect(freshPayload.advisoryMemory?.length).toBeGreaterThan(0);
  }, 20_000);

  test("reuses a structural autonomy cache across volatile snapshots and invalidates on vision change", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      modelId: "structural-cache-model",
    });
    const base = await requestFor(repo, {
      question: "Identify grounded autonomy candidates.",
      context: {
        operation: "analyze_autonomy_opportunities",
        vision: {
          path: "vision.md",
          sha256: "a".repeat(64),
          one_sentence: "Ship reliable improvements.",
          priorities: ["Reliability"],
          sections: [{ number: "1", title: "Priorities", markdown: "volatile-full-markdown" }],
        },
        runtimeSignals: {
          snapshotId: "snapshot-one",
          topSignals: [{ signal_id: "first", evidence: "first transient signal" }],
        },
      },
    });

    const first = await worker.analyze("structural-first", base);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "same-tree history only",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const sameTreeSnapshot = await resolveRepositorySnapshot(repo);
    expect(sameTreeSnapshot.tree).toBe(base.repository.tree);
    expect(sameTreeSnapshot.revision).not.toBe(base.repository.revision);
    const second = await worker.analyze("structural-second", {
      ...base,
      repository: sameTreeSnapshot,
      idempotencyKey: "structural-second-key",
      context: {
        ...(base.context ?? {}),
        runtimeSignals: {
          snapshotId: "snapshot-two",
          topSignals: [{ signal_id: "second", evidence: "different transient signal" }],
        },
      },
    });

    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(second.cache.key).toBeTruthy();
    expect(second.evidence.every((entry) => entry.revision === sameTreeSnapshot.revision)).toBe(
      true,
    );
    const structuralPayload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      advisoryMemory?: unknown[];
      evidencePacket?: { recentGitHistory?: string[] };
      request?: { repository?: Record<string, unknown> };
    };
    expect(structuralPayload.advisoryMemory).toEqual([]);
    expect(structuralPayload.evidencePacket?.recentGitHistory).toEqual([]);
    expect(structuralPayload.request?.repository?.revision).toBeUndefined();

    const changedVision = await worker.analyze("structural-third", {
      ...base,
      repository: sameTreeSnapshot,
      idempotencyKey: "structural-third-key",
      context: {
        ...(base.context ?? {}),
        vision: {
          ...((base.context?.vision as Record<string, unknown>) ?? {}),
          sha256: "b".repeat(64),
        },
      },
    });
    expect(changedVision.cache.hit).toBe(false);
    expect(llm.analysisCalls).toHaveLength(2);

    const changedProtocol = await worker.analyze("structural-fourth", {
      ...base,
      repository: sameTreeSnapshot,
      question: "Identify grounded architecture candidates instead.",
      idempotencyKey: "structural-fourth-key",
    });
    expect(changedProtocol.cache.hit).toBe(false);
    expect(llm.analysisCalls).toHaveLength(3);

    const changedPolicy = await worker.analyze("structural-fifth", {
      ...base,
      repository: sameTreeSnapshot,
      idempotencyKey: "structural-fifth-key",
      context: {
        ...(base.context ?? {}),
        deterministicPolicy: {
          maxCandidates: 7,
          minimumConfidence: 0.75,
          allowedObjectiveTypes: ["docs"],
          requiredCandidateFields: ["id", "target_paths"],
          notes: ["Return only documentation candidates."],
        },
      },
    });
    expect(changedPolicy.cache.hit).toBe(false);
    expect(llm.analysisCalls).toHaveLength(4);
    const policyPayload = JSON.parse(llm.analysisCalls[3]?.messages[0]?.content ?? "{}") as {
      request?: { context?: { deterministicPolicy?: Record<string, unknown> } };
    };
    expect(policyPayload.request?.context?.deterministicPolicy).toMatchObject({
      maxCandidates: 7,
      minimumConfidence: 0.75,
      allowedObjectiveTypes: ["docs"],
    });
  }, 20_000);

  test("keys ordinary history-sensitive analysis by revision even when the tree is unchanged", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      modelId: "history-cache-model",
    });
    const firstRequest = await requestFor(repo, {
      purpose: "general",
      question: "Summarize the latest repository history and its evidence.",
    });

    await worker.analyze("history-first", firstRequest);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "history changed without tree change",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const secondRequest = await requestFor(repo, {
      purpose: "general",
      question: firstRequest.question,
      context: firstRequest.context,
      idempotencyKey: "history-second",
    });
    expect(secondRequest.repository.tree).toBe(firstRequest.repository.tree);
    expect(secondRequest.repository.revision).not.toBe(firstRequest.repository.revision);

    const second = await worker.analyze("history-second", secondRequest);

    expect(second.cache.hit).toBe(false);
    expect(llm.analysisCalls).toHaveLength(2);
  }, 20_000);

  test("rechecks the repository snapshot before returning cached and newly learned results", async () => {
    const makeStore = (
      delegate: InMemoryMemoryStore,
      onGet: (address: any) => void,
      onPut: (input: any) => void,
    ) => ({
      put: async (input: any, options?: any) => {
        const record = await delegate.put(input, options);
        onPut(input);
        return record;
      },
      get: async (address: any, options?: any) => {
        const record = await delegate.get(address, options);
        onGet(address);
        return record;
      },
      search: (query: any) => delegate.search(query),
      invalidate: (selector: any) => delegate.invalidate(selector),
      reinforce: (input: any) => delegate.reinforce(input),
      prune: (options?: any) => delegate.prune(options),
      close: () => delegate.close(),
    });

    const cachedRepo = createRepository();
    const cachedMemory = new InMemoryMemoryStore();
    const cachedRequest = await requestFor(cachedRepo);
    await new RepositoryAgentWorker({
      control: unusedControl(),
      memory: cachedMemory,
      llm: new FakeLlm(),
    }).analyze("snapshot-cache-seed", cachedRequest);
    let cacheMutated = false;
    const cacheStore = makeStore(
      cachedMemory,
      (address) => {
        if (cacheMutated || address?.scope?.namespace !== "repository_agent_cache") return;
        cacheMutated = true;
        writeFileSync(join(cachedRepo, "src", "index.ts"), "export const value = 2;\n");
        execFileSync("git", ["add", "src/index.ts"], { cwd: cachedRepo, stdio: "ignore" });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=PushPals Test",
            "-c",
            "user.email=pushpals@example.invalid",
            "commit",
            "-m",
            "change during cache lookup",
          ],
          { cwd: cachedRepo, stdio: "ignore" },
        );
      },
      () => {},
    );
    await expect(
      new RepositoryAgentWorker({
        control: unusedControl(),
        memory: cacheStore as any,
        llm: new FakeLlm(),
      }).analyze("snapshot-cache-return", {
        ...cachedRequest,
        idempotencyKey: "snapshot-cache-return",
      }),
    ).rejects.toThrow();
    expect(cacheMutated).toBe(true);

    const generatedRepo = createRepository();
    const generatedMemory = new InMemoryMemoryStore();
    const generatedRequest = await requestFor(generatedRepo, { freshness: "fresh_required" });
    let writeMutated = false;
    const generatedStore = makeStore(
      generatedMemory,
      () => {},
      (input) => {
        if (writeMutated || input?.scope?.namespace !== "repository_facts") return;
        writeMutated = true;
        writeFileSync(join(generatedRepo, "src", "index.ts"), "export const value = 3;\n");
        execFileSync("git", ["add", "src/index.ts"], { cwd: generatedRepo, stdio: "ignore" });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=PushPals Test",
            "-c",
            "user.email=pushpals@example.invalid",
            "commit",
            "-m",
            "change during memory write",
          ],
          { cwd: generatedRepo, stdio: "ignore" },
        );
      },
    );
    await expect(
      new RepositoryAgentWorker({
        control: unusedControl(),
        memory: generatedStore as any,
        llm: new FakeLlm(),
      }).analyze("snapshot-generated-return", generatedRequest),
    ).rejects.toThrow();
    expect(writeMutated).toBe(true);
  }, 20_000);

  test("persists timeout evidence, opens after two matching failures, and recovers half-open", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    let providerCalls = 0;
    let providerHealthy = false;
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        providerCalls++;
        if (providerHealthy) return { text: JSON.stringify(modelResponse()) };
        return await new Promise<LLMGenerateOutput>((_resolve, reject) => {
          const onAbort = () => reject(input.signal?.reason ?? new Error("provider aborted"));
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      },
    };
    const makeWorker = () =>
      new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        modelId: "circuit-test-model",
        capabilityCircuitCooldownMs: 5_000,
        finalizationReserveMs: 3_000,
        providerDrainMs: 100,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      });
    const worker = makeWorker();
    const timedRequest = async (key: string) =>
      await requestFor(repo, {
        freshness: "fresh_required",
        idempotencyKey: key,
        deadlineAt: new Date(Date.now() + 7_000).toISOString(),
      });

    const firstStartedAt = Date.now();
    const first = await worker.analyze("circuit-first", await timedRequest("circuit-first"));
    expect(Date.now() - firstStartedAt).toBeLessThan(7_500);
    const second = await worker.analyze("circuit-second", await timedRequest("circuit-second"));
    expect((first.data as Record<string, unknown>).repositoryAgentMode).toBe(
      "deterministic_evidence_fallback",
    );
    expect(first.evidence.length).toBeGreaterThan(0);
    expect(first.memoryRefs.some((ref) => ref.namespace === "repository_facts")).toBe(true);
    expect((second.data as Record<string, unknown>).repositoryAgentMode).toBe(
      "deterministic_evidence_fallback",
    );
    expect(first.memoryRefs.some((ref) => ref.role === "recalled_fact")).toBe(false);
    expect(providerCalls).toBe(2);

    const fallbackFacts = await memory.search({
      scope: { namespace: "repository_facts", repositoryId: first.analyzedRepository.identity },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect(fallbackFacts).toHaveLength(1);
    expect(fallbackFacts[0]?.provenance.modelId).toBeUndefined();

    const openCircuit = await memory.search({
      scope: {
        namespace: "repository_agent_capabilities",
        repositoryId: first.analyzedRepository.identity,
      },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect(openCircuit).toHaveLength(1);
    expect((openCircuit[0]?.value as Record<string, unknown>).state).toBe("open");
    expect((openCircuit[0]?.value as Record<string, unknown>).consecutiveFailures).toBe(2);

    const blocked = await makeWorker().analyze(
      "circuit-blocked",
      await timedRequest("circuit-blocked"),
    );
    expect((blocked.data as Record<string, unknown>).synthesisStatus).toContain("circuit open");
    expect(providerCalls).toBe(2);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_100));
    providerHealthy = true;
    const recovered = await makeWorker().analyze(
      "circuit-recovered",
      await timedRequest("circuit-recovered"),
    );
    expect(recovered.answer).toContain("documented reliability priority");
    expect(providerCalls).toBe(3);
    const recoveredCircuit = await memory.search({
      scope: {
        namespace: "repository_agent_capabilities",
        repositoryId: recovered.analyzedRepository.identity,
      },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect((recoveredCircuit[0]?.value as Record<string, unknown>).state).toBe("closed");
    expect((recoveredCircuit[0]?.value as Record<string, unknown>).consecutiveFailures).toBe(0);
  }, 40_000);

  test("fences half-open outcomes to the exact probe owner and revision", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm: LLMClient = {
      async generate(): Promise<LLMGenerateOutput> {
        throw new TypeError("provider offline");
      },
    };
    const worker = new RepositoryAgentWorker({
      agentId: "probe-owner-one",
      control: unusedControl(),
      memory,
      llm,
      modelId: "probe-fence-model",
      capabilityCircuitCooldownMs: 100,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const request = await requestFor(repo, { freshness: "fresh_required" });
    await worker.analyze("probe-seed-one", { ...request, idempotencyKey: "probe-seed-one" });
    await worker.analyze("probe-seed-two", { ...request, idempotencyKey: "probe-seed-two" });
    await Bun.sleep(125);

    const signal = new AbortController().signal;
    const deadlineMs = Date.now() + 5_000;
    const permission = await (worker as any).capabilityCircuitPermission(
      request,
      signal,
      deadlineMs,
    );
    expect(permission.halfOpen).toBe(true);
    expect(permission.probe.owner).toBe("probe-owner-one");
    expect(Date.parse(permission.probe.until)).toBeGreaterThanOrEqual(deadlineMs);

    const records = await memory.search({
      scope: {
        namespace: "repository_agent_capabilities",
        repositoryId: request.repository.identity,
      },
      maxItems: 10,
      maxChars: 100_000,
    });
    const claimed = records[0]!;
    const newerRevision = claimed.revision + 1;
    const newerValue = {
      ...(claimed.value as Record<string, unknown>),
      state: "half_open",
      probeId: "newer-probe",
      probeOwner: "probe-owner-two",
      probeRevision: newerRevision,
      probeUntil: new Date(Date.now() + 20_000).toISOString(),
    };
    const newer = await memory.put(
      {
        scope: claimed.scope,
        key: claimed.key,
        kind: claimed.kind,
        subjectKey: claimed.subjectKey,
        summary: "newer half-open probe",
        value: newerValue,
        tags: claimed.tags,
        evidence: claimed.evidence,
        provenance: claimed.provenance,
        confidence: claimed.confidence,
        usefulness: claimed.usefulness,
        ttlMs: 60_000,
      },
      { expectedRevision: claimed.revision },
    );

    await (worker as any).recordCapabilitySuccess(request, permission, signal, deadlineMs);
    await (worker as any).recordCapabilityFailure(
      request,
      new TypeError("provider offline"),
      permission,
      signal,
      deadlineMs,
    );

    const after = await memory.get(
      { scope: newer.scope, key: newer.key },
      { includeExpired: true },
    );
    expect(after?.revision).toBe(newer.revision);
    expect((after?.value as Record<string, unknown>).state).toBe("half_open");
    expect((after?.value as Record<string, unknown>).probeId).toBe("newer-probe");
    expect((after?.value as Record<string, unknown>).probeOwner).toBe("probe-owner-two");

    const expiredProbeUntil = new Date(Date.now() - 1).toISOString();
    const expiredProbeRevision = after!.revision + 1;
    const expiredProbe = await memory.put(
      {
        scope: after!.scope,
        key: after!.key,
        kind: after!.kind,
        subjectKey: after!.subjectKey,
        summary: "expired half-open probe",
        value: {
          ...(after!.value as Record<string, unknown>),
          state: "half_open",
          probeId: "expired-probe",
          probeOwner: "probe-owner-one",
          probeRevision: expiredProbeRevision,
          probeUntil: expiredProbeUntil,
        },
        tags: after!.tags,
        evidence: after!.evidence,
        provenance: after!.provenance,
        confidence: after!.confidence,
        usefulness: after!.usefulness,
        ttlMs: 60_000,
      },
      { expectedRevision: after!.revision },
    );
    const expiredPermission = {
      allowed: true,
      halfOpen: true,
      observedRevision: expiredProbe.revision,
      probe: {
        id: "expired-probe",
        owner: "probe-owner-one",
        revision: expiredProbe.revision,
        until: expiredProbeUntil,
      },
    };

    await (worker as any).recordCapabilitySuccess(
      request,
      expiredPermission,
      signal,
      Date.now() + 5_000,
    );
    await (worker as any).recordCapabilityFailure(
      request,
      new TypeError("provider offline"),
      expiredPermission,
      signal,
      Date.now() + 5_000,
    );

    const afterExpiredOutcomes = await memory.get(
      { scope: expiredProbe.scope, key: expiredProbe.key },
      { includeExpired: true },
    );
    expect(afterExpiredOutcomes?.revision).toBe(expiredProbe.revision);
    expect((afterExpiredOutcomes?.value as Record<string, unknown>).state).toBe("half_open");
  }, 20_000);

  test("treats an expired capability row as reset while retaining its CAS revision", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    let healthy = false;
    let calls = 0;
    const llm: LLMClient = {
      async generate(): Promise<LLMGenerateOutput> {
        calls++;
        if (healthy) return { text: JSON.stringify(modelResponse()) };
        throw new Error("same provider failure");
      },
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      modelId: "expired-circuit-model",
      capabilityCircuitCooldownMs: 60_000,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const request = await requestFor(repo, { freshness: "fresh_required" });
    await worker.analyze("expired-seed-one", {
      ...request,
      idempotencyKey: "expired-seed-one",
    });
    await worker.analyze("expired-seed-two", {
      ...request,
      idempotencyKey: "expired-seed-two",
    });
    const [opened] = await memory.search({
      scope: {
        namespace: "repository_agent_capabilities",
        repositoryId: request.repository.identity,
      },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect((opened?.value as Record<string, unknown>).state).toBe("open");
    const expired = await memory.put(
      {
        scope: opened!.scope,
        key: opened!.key,
        kind: opened!.kind,
        subjectKey: opened!.subjectKey,
        summary: "expired open circuit",
        value: opened!.value,
        tags: opened!.tags,
        evidence: opened!.evidence,
        provenance: opened!.provenance,
        confidence: opened!.confidence,
        usefulness: opened!.usefulness,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      { expectedRevision: opened!.revision },
    );

    healthy = true;
    const recovered = await worker.analyze("expired-reset-success", {
      ...request,
      idempotencyKey: "expired-reset-success",
    });
    expect(recovered.answer).toContain("documented reliability priority");
    expect(calls).toBe(3);

    healthy = false;
    await worker.analyze("expired-reset-failure", {
      ...request,
      idempotencyKey: "expired-reset-failure",
    });
    expect(calls).toBe(4);
    const reset = await memory.get(
      { scope: expired.scope, key: expired.key },
      { includeExpired: true },
    );
    expect(reset?.revision).toBeGreaterThan(expired.revision);
    expect((reset?.value as Record<string, unknown>).state).toBe("closed");
    expect((reset?.value as Record<string, unknown>).consecutiveFailures).toBe(1);
  }, 20_000);

  test("does not attribute recalled memory or a model to deterministic fallback", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const calls: LLMGenerateInput[] = [];
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        calls.push(input);
        if (calls.length === 1) {
          return {
            text: JSON.stringify(modelResponse()),
            provider: "test-provider",
            modelId: "test-model",
          };
        }
        throw new Error("provider failed after recall");
      },
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      modelId: "fallback-provenance-model",
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const request = await requestFor(repo, {
      purpose: "general",
      freshness: "fresh_required",
    });
    await worker.analyze("model-backed-fact", {
      ...request,
      idempotencyKey: "model-backed-fact",
    });

    const fallback = await worker.analyze("fallback-after-recall", {
      ...request,
      idempotencyKey: "fallback-after-recall",
    });

    const fallbackPrompt = JSON.parse(calls[1]?.messages[0]?.content ?? "{}") as {
      advisoryMemory?: unknown[];
    };
    expect(fallbackPrompt.advisoryMemory?.length).toBeGreaterThan(0);
    expect(fallback.memoryRefs.some((ref) => ref.role === "recalled_fact")).toBe(false);
    const facts = await memory.search({
      scope: { namespace: "repository_facts", repositoryId: request.repository.identity },
      maxItems: 10,
      maxChars: 100_000,
    });
    const fallbackFact = facts.find(
      (record) => record.provenance.requestId === "fallback-after-recall",
    );
    expect(fallbackFact).toBeDefined();
    expect(fallbackFact?.provenance.modelId).toBeUndefined();
    expect(fallback.memoryRefs.some((ref) => ref.id === fallbackFact?.id)).toBe(true);
  });

  test("uses exact clean-snapshot Git blob content and citations across CRLF smudge", async () => {
    const repo = createRepository();
    writeFileSync(join(repo, ".gitattributes"), "*.md text eol=crlf\n");
    writeFileSync(
      join(repo, "vision.md"),
      `${readFileSync(join(repo, "vision.md"), "utf8")}\n[pushpals: process output truncated]`,
    );
    execFileSync("git", ["add", ".gitattributes", "vision.md"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "declare checkout line endings",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    rmSync(join(repo, "vision.md"));
    execFileSync("git", ["checkout", "--", "vision.md"], { cwd: repo, stdio: "ignore" });
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    const revisionBlob = git(repo, ["rev-parse", "HEAD:vision.md"]);
    const checkoutBytesBlob = git(repo, ["hash-object", "--no-filters", "--", "vision.md"]);
    expect(checkoutBytesBlob).not.toBe(revisionBlob);
    const checkoutText = readFileSync(join(repo, "vision.md"), "utf8");
    const committedText = execFileSync(
      "git",
      ["show", `${git(repo, ["rev-parse", "HEAD"])}:vision.md`],
      { cwd: repo, encoding: "utf8" },
    );
    expect(checkoutText).toContain("\r\n");
    expect(committedText).not.toContain("\r\n");
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
    });

    const result = await worker.analyze("platform-stable-blob", request);
    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { files: Array<{ path: string; content: string }> };
    };
    const packetVision = payload.evidencePacket.files.find((entry) => entry.path === "vision.md");

    expect(packetVision?.content).toBe(committedText);
    expect(packetVision?.content).not.toBe(checkoutText);
    expect(packetVision?.content.endsWith("[pushpals: process output truncated]")).toBe(true);
    expect(result.evidence[0]?.blobHash).toBe(revisionBlob);
    expect(result.evidence[0]?.revision).toBe(request.repository.revision);
    expect(result.evidence[0]?.excerpt).toBe(
      "## Priorities\n\nShip reliable repository-native improvements.",
    );
  });

  test("never reads or persists a tracked file symlink as ordinary blob evidence", async () => {
    const repo = createRepository();
    const targetPath = join(repo, "private-target.md");
    const linkPath = join(repo, "linked-priority.md");
    const targetContents = "PRIVATE TARGET CONTENT MUST NOT ENTER REPOSITORY AGENT EVIDENCE\n";
    writeFileSync(targetPath, targetContents);
    try {
      symlinkSync("private-target.md", linkPath, "file");
    } catch {
      // Windows hosts without Developer Mode cannot create file symlinks. Linux
      // CI exercises this regression, while the junction regression below covers
      // the corresponding Windows reparse-point boundary.
      return;
    }
    execFileSync("git", ["add", "private-target.md", "linked-priority.md"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add tracked file symlink fixture",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    if (!git(repo, ["ls-files", "--stage", "--", "linked-priority.md"]).startsWith("120000 ")) {
      return;
    }

    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Explain linked-priority.md.",
      context: { targetPaths: ["linked-priority.md"] },
    });
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [{ path: "linked-priority.md", startLine: 1, endLine: 1 }],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    await expect(worker.analyze("file-symlink-evidence", request)).rejects.toThrow(
      "did not contain any current, tracked repository evidence",
    );

    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { files: Array<{ path: string; content: string }> };
    };
    expect(payload.evidencePacket.files.map((entry) => entry.path)).not.toContain(
      "linked-priority.md",
    );
    expect(JSON.stringify(payload)).not.toContain(targetContents.trim());
    const persisted = (
      await Promise.all(
        ["repository_agent_cache", "repository_facts"].map((namespace) =>
          memory.search({
            scope: { namespace, repositoryId: request.repository.identity },
            maxItems: 10,
            maxChars: 100_000,
          }),
        ),
      )
    ).flat();
    expect(persisted).toHaveLength(0);
  });

  test("never follows a tracked path through a parent directory junction", async () => {
    const repo = createRepository();
    const lexicalDirectory = join(repo, "docs");
    const junctionTarget = join(repo, "docs-reparse-target");
    mkdirSync(lexicalDirectory);
    writeFileSync(
      join(lexicalDirectory, "priority.md"),
      "JUNCTION TARGET CONTENT MUST NOT ENTER REPOSITORY AGENT EVIDENCE\n",
    );
    execFileSync("git", ["add", "docs/priority.md"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add parent junction fixture",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    renameSync(lexicalDirectory, junctionTarget);
    try {
      symlinkSync(
        junctionTarget,
        lexicalDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return;
    }

    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Explain docs/priority.md.",
      context: { targetPaths: ["docs/priority.md"] },
    });
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() =>
      modelResponse({ evidence: [{ path: "docs/priority.md", startLine: 1, endLine: 1 }] }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    await expect(worker.analyze("parent-junction-evidence", request)).rejects.toThrow(
      "did not contain any current, tracked repository evidence",
    );

    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { files: Array<{ path: string; content: string }> };
    };
    expect(payload.evidencePacket.files.map((entry) => entry.path)).not.toContain(
      "docs/priority.md",
    );
    expect(JSON.stringify(payload)).not.toContain("JUNCTION TARGET CONTENT");
    const persisted = (
      await Promise.all(
        ["repository_agent_cache", "repository_facts"].map((namespace) =>
          memory.search({
            scope: { namespace, repositoryId: request.repository.identity },
            maxItems: 10,
            maxChars: 100_000,
          }),
        ),
      )
    ).flat();
    expect(persisted).toHaveLength(0);
  });

  test("provides a bounded generic evidence packet to non-agentic backends", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      purpose: "architecture",
      question: "Explain src/index.ts and the repository's validation entry points.",
      context: {},
    });
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [{ path: "README.md", startLine: 1, endLine: 3 }],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: false,
    });

    await worker.analyze("request-packet", request);

    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls[0]?.executionContext).toEqual({
      repositoryMode: "isolated-evidence",
    });
    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: {
        trackedPathCount: number;
        selectedPaths: string[];
        files: Array<{ path: string; content: string }>;
        recentGitHistory: string[];
      };
    };
    expect(payload.evidencePacket.trackedPathCount).toBe(5);
    expect(payload.evidencePacket.selectedPaths).toEqual([]);
    expect(payload.evidencePacket.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "vision.md",
        "README.md",
        "package.json",
        ".github/workflows/ci.yml",
        "src/index.ts",
      ]),
    );
    expect(payload.evidencePacket.files.every((entry) => entry.content.length <= 16 * 1024)).toBe(
      true,
    );
    expect(payload.evidencePacket.recentGitHistory[0]).toContain("initial fixture");
  });

  test("uses deterministic path-ranked retrieval to add a non-seed source file", async () => {
    const repo = createRepository();
    writeFileSync(
      join(repo, "src", "scheduler.ts"),
      "export function scheduleNextJob() { return 'next'; }\n",
    );
    execFileSync("git", ["add", "src/scheduler.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add scheduler source",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      purpose: "architecture",
      question: "Where is background work selected and scheduled?",
      context: {},
    });
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [{ path: "src/scheduler.ts", startLine: 1, endLine: 1 }],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
    });

    const result = await worker.analyze("guided-retrieval", request);

    expect(llm.discoveryCalls).toHaveLength(0);
    const analysisPayload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: {
        files: Array<{ path: string; content: string }>;
        selectedPaths: string[];
      };
    };
    expect(analysisPayload.evidencePacket.selectedPaths).toEqual(["src/scheduler.ts"]);
    expect(analysisPayload.evidencePacket.files.map((entry) => entry.path)).toContain(
      "src/scheduler.ts",
    );
    expect(
      analysisPayload.evidencePacket.files.find((entry) => entry.path === "src/scheduler.ts")
        ?.content,
    ).toContain("scheduleNextJob");
    expect(result.evidence[0]?.path).toBe("src/scheduler.ts");
  });

  test("reserves packet capacity for Unicode-ranked sources and prefers them in fallback evidence", async () => {
    const repo = createRepository();
    const relevantPath = "src/支付处理.ts";
    writeFileSync(join(repo, "vision.md"), `# Vision\n\n${"priority details ".repeat(2_000)}\n`);
    writeFileSync(join(repo, "README.md"), `# Example\n\n${"overview details ".repeat(2_000)}\n`);
    writeFileSync(join(repo, "package.json"), `${"manifest details ".repeat(2_000)}\n`);
    writeFileSync(join(repo, ...relevantPath.split("/")), "export const 支付处理 = 'bounded';\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add unicode payment source",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const calls: LLMGenerateInput[] = [];
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        calls.push(input);
        throw new Error("provider unavailable");
      },
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      purpose: "architecture",
      question: "检查支付处理的实现边界",
      context: {},
    });

    const result = await worker.analyze("unicode-ranked-fallback", request);

    const payload = JSON.parse(calls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: {
        selectedPaths: string[];
        files: Array<{ path: string; content: string }>;
      };
    };
    expect(payload.evidencePacket.selectedPaths).toContain(relevantPath);
    expect(payload.evidencePacket.files.map((entry) => entry.path)).toContain(relevantPath);
    expect(
      payload.evidencePacket.files.reduce((chars, entry) => chars + entry.content.length, 0),
    ).toBeLessThanOrEqual(64_000);
    expect(result.evidence[0]?.path).toBe(relevantPath);
    expect((result.data as Record<string, unknown>).repositoryAgentMode).toBe(
      "deterministic_evidence_fallback",
    );
  });

  test("deterministic retrieval never admits absolute or untracked context paths", async () => {
    const repo = createRepository();
    writeFileSync(join(repo, "untracked.txt"), "must not enter the evidence packet\n");
    const extraTrackedPaths = Array.from(
      { length: 14 },
      (_unused, index) => `src/candidate-${String(index).padStart(2, "0")}.ts`,
    );
    for (const path of extraTrackedPaths) {
      writeFileSync(join(repo, ...path.split("/")), `export const candidate = ${path.length};\n`);
    }
    execFileSync("git", ["add", ...extraTrackedPaths], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add retrieval candidates",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      purpose: "architecture",
      question: "Inspect the explicitly named source coordinate.",
      context: {
        targetPaths: [
          "src/index.ts",
          "../outside-secret.txt",
          join(repo, "src", "index.ts"),
          "untracked.txt",
        ],
      },
    });
    const llm = new FakeLlm(() => modelResponse());
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
    });

    await worker.analyze("malicious-retrieval", request);

    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: {
        files: Array<{ path: string }>;
        selectedPaths: string[];
      };
    };
    expect(llm.discoveryCalls).toHaveLength(0);
    expect(payload.evidencePacket.files.map((entry) => entry.path)).toContain("src/index.ts");
    expect(payload.evidencePacket.selectedPaths).not.toContain(extraTrackedPaths[11]);
    expect(payload.evidencePacket.files.map((entry) => entry.path)).not.toContain("untracked.txt");
    expect(payload.evidencePacket.files.map((entry) => entry.path)).not.toContain(
      "../outside-secret.txt",
    );
  });

  test("never invokes provider retrieval and sends one bounded synthesis packet", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Summarize the repository priorities.",
      context: {},
    });
    const llm = new FakeLlm(
      () => modelResponse(),
      0,
      () => "not-json",
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.analyze("retrieval-fallback", request);

    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(1);
    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { seedPaths: string[]; selectedPaths: string[] };
    };
    expect(payload.evidencePacket.seedPaths).toEqual(
      expect.arrayContaining(["vision.md", "README.md", "package.json"]),
    );
    expect(payload.evidencePacket.selectedPaths).toEqual([]);
  });

  test("starts exactly one provider stage after deterministic retrieval", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Summarize the repository priorities.",
      context: {},
      deadlineAt: new Date(Date.now() + 6_000).toISOString(),
    });
    const analysisCalls: LLMGenerateInput[] = [];
    let analysisStartedAt = 0;
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        const schemaProperties = input.jsonSchema?.properties;
        const discovery =
          schemaProperties != null &&
          typeof schemaProperties === "object" &&
          "paths" in schemaProperties &&
          !("answer" in schemaProperties);
        expect(discovery).toBe(false);
        analysisStartedAt = Date.now();
        analysisCalls.push(input);
        return { text: JSON.stringify(modelResponse()) };
      },
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const startedAt = Date.now();

    const result = await worker.analyze("retrieval-timeout-fallback", request);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(analysisCalls).toHaveLength(1);
    expect(analysisStartedAt).toBeGreaterThanOrEqual(startedAt);
    const payload = JSON.parse(analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { selectedPaths: string[] };
    };
    expect(payload.evidencePacket.selectedPaths).toEqual([]);
    expect(result.evidence[0]?.path).toBe("vision.md");
  });

  test("bounds hanging cache, recall, and fact-memory operations within the request deadline", async () => {
    const repo = createRepository();
    for (const hangingStage of ["get", "search", "put"] as const) {
      const delegate = new InMemoryMemoryStore();
      const never = () => new Promise<never>(() => {});
      const memory = {
        put: (input: any, options?: any) =>
          hangingStage === "put" && input?.scope?.namespace === "repository_facts"
            ? never()
            : delegate.put(input, options),
        get: (address: any, options?: any) =>
          hangingStage === "get" ? never() : delegate.get(address, options),
        search: (query: any) => (hangingStage === "search" ? never() : delegate.search(query)),
        invalidate: (selector: any) => delegate.invalidate(selector),
        reinforce: (input: any) => delegate.reinforce(input),
        prune: (options?: any) => delegate.prune(options),
        close: () => delegate.close(),
      };
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory: memory as any,
        llm: new FakeLlm(),
        repositoryTools: true,
        // Stable snapshot fencing now performs two worktree observations plus
        // a final HEAD check. Reserve enough real Windows Git time so this
        // fixture continues to isolate hanging memory stages, not SCM latency.
        finalizationReserveMs: 3_000,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      });
      const request = await requestFor(repo, {
        freshness: hangingStage === "get" ? "cache_preferred" : "fresh_required",
        idempotencyKey: `hanging-memory-${hangingStage}`,
        deadlineAt: new Date(Date.now() + 7_000).toISOString(),
      });
      const startedAt = Date.now();

      const result = await worker.analyze(`hanging-memory-${hangingStage}`, request);

      expect(Date.now() - startedAt).toBeLessThan(7_500);
      expect(result.evidence.length).toBeGreaterThan(0);
    }
  }, 35_000);

  test("fences a delayed staged put so it cannot ghost-write after timeout", async () => {
    const delegate = new InMemoryMemoryStore();
    let delayedSettled = false;
    const memory = {
      put: async (input: any, options?: any) => {
        await Bun.sleep(50);
        try {
          return await delegate.put(input, options);
        } finally {
          delayedSettled = true;
        }
      },
      get: (address: any, options?: any) => delegate.get(address, options),
      search: (query: any) => delegate.search(query),
      invalidate: (selector: any) => delegate.invalidate(selector),
      reinforce: (input: any) => delegate.reinforce(input),
      prune: (options?: any) => delegate.prune(options),
      close: () => delegate.close(),
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: memory as any,
      llm: new FakeLlm(),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const scope = { namespace: "repository_facts", repositoryId: "repo-delayed-write" };
    const signal = new AbortController().signal;

    await expect(
      (worker as any).memoryPutWithinDeadline("delayed test write", signal, Date.now() + 15, {
        scope,
        key: "delayed",
        kind: "test",
        summary: "This record must never become durable.",
        provenance: { service: "repository_agent" },
      }),
    ).rejects.toThrow("exceeded its stage deadline");
    await Bun.sleep(75);

    expect(delayedSettled).toBe(true);
    expect(await delegate.get({ scope, key: "delayed" }, { includeExpired: true })).toBeNull();
  });

  test("drops untracked evidence and path proposals, refreshes excerpts, and never executes validation", async () => {
    const repo = createRepository();
    writeFileSync(join(repo, "untracked.txt"), "not authoritative\n");
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [
          { path: "../outside.txt", startLine: 1, excerpt: "fabricated" },
          { path: "untracked.txt", startLine: 1, excerpt: "fabricated" },
          { path: "vision.md", startLine: 1, endLine: 2, excerpt: "fabricated" },
        ],
        recommendations: [
          {
            title: "Stay contained",
            rationale: "Only tracked paths are authoritative.",
            paths: ["src/index.ts", "../outside.txt", "untracked.txt"],
          },
        ],
        validationProposals: [
          { label: "proposal", cwd: "src", argv: ["bun", "test"], rationale: "proposal" },
          {
            label: "escaped",
            cwd: "../outside",
            argv: ["dangerous-command"],
            rationale: "must be dropped",
          },
        ],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
    });

    const result = await worker.analyze("request-evidence", request);

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.path).toBe("vision.md");
    expect(result.evidence[0]?.excerpt).toContain("# Vision");
    expect(result.evidence[0]?.excerpt).not.toContain("fabricated");
    expect(result.recommendations[0]?.paths).toEqual(["src/index.ts"]);
    expect(result.validationProposals).toHaveLength(1);
    expect(result.validationProposals[0]?.cwd).toBe("src");
    expect(result.validationProposals[0]?.argv).toEqual(["bun", "test"]);
  });

  test("drops tracked citations that were not included in the final evidence packet or memory", async () => {
    const repo = createRepository();
    const unselectedPath = "src/unselected-implementation.ts";
    writeFileSync(join(repo, ...unselectedPath.split("/")), "export const hiddenDetail = true;\n");
    execFileSync("git", ["add", unselectedPath], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add unselected tracked source",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const request = await requestFor(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [
          { path: "vision.md", startLine: 1, endLine: 2 },
          { path: unselectedPath, startLine: 1, endLine: 1 },
        ],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    const result = await worker.analyze("unselected-citation", request);
    const payload = JSON.parse(llm.analysisCalls[0]?.messages[0]?.content ?? "{}") as {
      evidencePacket: { files: Array<{ path: string }> };
    };

    expect(payload.evidencePacket.files.map((entry) => entry.path)).not.toContain(unselectedPath);
    expect(result.evidence.map((entry) => entry.path)).toEqual(["vision.md"]);
    const persisted = (
      await Promise.all(
        ["repository_facts", "repository_agent_cache"].map((namespace) =>
          memory.search({
            scope: { namespace, repositoryId: request.repository.identity },
            maxItems: 10,
            maxChars: 100_000,
          }),
        ),
      )
    ).flat();
    expect(persisted).toHaveLength(2);
    expect(JSON.stringify(persisted)).not.toContain(unselectedPath);
  });

  test("rejects an answer supported only by an unselected tracked citation without learning it", async () => {
    const repo = createRepository();
    const unselectedPath = "src/unselected-only.ts";
    writeFileSync(join(repo, ...unselectedPath.split("/")), "export const unselected = true;\n");
    execFileSync("git", ["add", unselectedPath], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=PushPals Test",
        "-c",
        "user.email=pushpals@example.invalid",
        "commit",
        "-m",
        "add citation outside evidence packet",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const request = await requestFor(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() =>
      modelResponse({ evidence: [{ path: unselectedPath, startLine: 1, endLine: 1 }] }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    await expect(worker.analyze("only-unselected-citation", request)).rejects.toThrow(
      "did not contain any current, tracked repository evidence",
    );
    for (const namespace of ["repository_facts", "repository_agent_cache"]) {
      expect(
        await memory.search({
          scope: { namespace, repositoryId: request.repository.identity },
          maxItems: 10,
          maxChars: 100_000,
        }),
      ).toHaveLength(0);
    }
  });

  test("fails a cache-only miss without invoking the assigned model", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "cache_only" });
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
    });

    await expect(worker.analyze("request-cache-only", request)).rejects.toThrow(
      "does not contain this request",
    );
    expect(llm.calls).toHaveLength(0);
  });

  test("returns but never exact-caches an evidence-free answer", async () => {
    const repo = createRepository();
    const request = await requestFor(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() => modelResponse({ evidence: [], confidence: 0.95 }));
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    const first = await worker.analyze("evidence-free-1", request);
    const second = await worker.analyze("evidence-free-2", {
      ...request,
      idempotencyKey: "evidence-free-repeat",
    });

    expect(first.confidence).toBe(0.25);
    expect(second.cache.hit).toBe(false);
    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(2);
    expect(
      await memory.search({
        scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
        maxItems: 10,
        maxChars: 100_000,
      }),
    ).toHaveLength(0);
  });

  test("never stores durable facts or exact results from a dirty snapshot", async () => {
    const repo = createRepository();
    writeFileSync(join(repo, "src", "index.ts"), "export const value = 2;\n");
    writeFileSync(join(repo, "dirty-untracked.txt"), "ephemeral worktree content\n");
    const request = await requestFor(repo, { freshness: "fresh_required" });
    expect(request.repository.dirty).toBe(true);
    const memory = new InMemoryMemoryStore();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm: new FakeLlm(),
      repositoryTools: true,
    });

    const result = await worker.analyze("dirty-request", request);

    expect(result.evidence).toHaveLength(1);
    expect(result.memoryRefs).toHaveLength(0);
    expect(
      await memory.search({
        scope: { namespace: "repository_facts", repositoryId: request.repository.identity },
        maxItems: 10,
        maxChars: 100_000,
      }),
    ).toHaveLength(0);
    expect(
      await memory.search({
        scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
        maxItems: 10,
        maxChars: 100_000,
      }),
    ).toHaveLength(0);
  });

  test("stores immutable verified evidence observations without promoting model advice to facts", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });
    const firstRequest = await requestFor(repo, {
      freshness: "fresh_required",
      context: { workflow: "first" },
    });
    const secondRequest = {
      ...firstRequest,
      context: { workflow: "second" },
      idempotencyKey: "second-context",
    };

    await worker.analyze("fact-context-1", firstRequest);
    await worker.analyze("fact-context-2", secondRequest);

    const observations = await memory.search({
      scope: { namespace: "repository_facts", repositoryId: firstRequest.repository.identity },
      maxItems: 10,
      maxChars: 100_000,
    });
    // Caller-context variations over the same verified coordinates coalesce;
    // otherwise private topic material would be required to distinguish them.
    expect(observations).toHaveLength(1);
    expect(observations.every((record) => record.kind === "repository_evidence_observation")).toBe(
      true,
    );
    for (const observation of observations) {
      const value = observation.value as Record<string, unknown>;
      expect(Array.isArray(value.evidence)).toBe(true);
      expect(value.answer).toBeUndefined();
      expect(value.data).toBeUndefined();
      expect(value.recommendations).toBeUndefined();
    }
  });

  test("keeps multi-evidence durable facts compact enough for bounded recall", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() =>
      modelResponse({
        evidence: [
          { path: "vision.md", startLine: 1, endLine: 5 },
          { path: "README.md", startLine: 1, endLine: 3 },
          { path: "package.json", startLine: 1, endLine: 6 },
        ],
      }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });
    const request = await requestFor(repo, { freshness: "fresh_required" });

    await worker.analyze("compact-fact-first", request);

    const boundedFacts = await memory.search({
      scope: { namespace: "repository_facts", repositoryId: request.repository.identity },
      text: request.purpose,
      maxItems: 8,
      maxChars: 8_000,
    });
    expect(boundedFacts).toHaveLength(1);
    expect(boundedFacts[0]?.evidence).toHaveLength(3);
    const value = boundedFacts[0]?.value as {
      evidence: Array<Record<string, unknown>>;
    };
    expect(value.evidence).toHaveLength(3);
    expect(value.evidence.every((entry) => entry.excerpt === undefined)).toBe(true);
    expect(value.evidence.every((entry) => typeof entry.excerptSha256 === "string")).toBe(true);
    expect(JSON.stringify(boundedFacts[0]).length).toBeLessThan(8_000);

    await worker.analyze("compact-fact-recall", {
      ...(await requestFor(repo, {
        freshness: "fresh_required",
        question: "What should another repository planning pass consider?",
        context: { workflow: "different-caller-context" },
      })),
    });
    const recallPayload = JSON.parse(llm.analysisCalls[1]?.messages[0]?.content ?? "{}") as {
      advisoryMemory: Array<{ evidence: unknown[] }>;
    };
    expect(recallPayload.advisoryMemory).toHaveLength(1);
    expect(recallPayload.advisoryMemory[0]?.evidence).toHaveLength(3);
  }, 15_000);

  test("ranks recall with repository-validated paths instead of arbitrary caller terms", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    let citedPath = "vision.md";
    const llm = new FakeLlm(() =>
      modelResponse({ evidence: [{ path: citedPath, startLine: 1, endLine: 1 }] }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
    });

    await worker.analyze(
      "path-ranked-vision",
      await requestFor(repo, {
        freshness: "fresh_required",
        context: { targetPaths: ["vision.md"] },
      }),
    );
    citedPath = "README.md";
    await worker.analyze(
      "path-ranked-readme",
      await requestFor(repo, {
        freshness: "fresh_required",
        context: { targetPaths: ["README.md"] },
      }),
    );
    await worker.analyze(
      "path-ranked-recall",
      await requestFor(repo, {
        freshness: "fresh_required",
        question: "Use README.md and ignore arbitrary-untrusted-ranking-term.",
        context: { targetPaths: ["README.md"] },
      }),
    );

    const payload = JSON.parse(llm.analysisCalls[2]?.messages[0]?.content ?? "{}") as {
      advisoryMemory: Array<{ evidence: Array<{ path?: string }> }>;
    };
    expect(payload.advisoryMemory).toHaveLength(2);
    expect(payload.advisoryMemory[0]?.evidence[0]?.path).toBe("README.md");
    expect(JSON.stringify(payload.advisoryMemory)).not.toContain(
      "arbitrary-untrusted-ranking-term",
    );
  });

  test("persists the provider and model actually reported by the final inference", async () => {
    const repo = createRepository();
    const request = await requestFor(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(
      () => modelResponse(),
      0,
      () => ({ paths: [] }),
      { provider: "openai_codex", modelId: "gpt-actual-fallback" },
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      repositoryTools: true,
      modelId: "configured-model",
    });

    await worker.analyze("actual-provider-model", request);

    for (const namespace of ["repository_facts", "repository_agent_cache"]) {
      const records = await memory.search({
        scope: { namespace, repositoryId: request.repository.identity },
        maxItems: 10,
        maxChars: 100_000,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.provenance.modelId).toBe("openai_codex/gpt-actual-fallback");
      expect(records[0]?.provenance.modelId).not.toContain("configured-model");
    }
  });

  test("persists only allowlisted purpose topics and never recalls caller secrets after restart", async () => {
    const repo = createRepository();
    const stateRoot = mkdtempSync(join(tmpdir(), "pushpals-repository-memory-privacy-"));
    const dbPath = join(stateRoot, "memory.sqlite");
    const secret = "ghp_CALLER_SECRET_4wV6uL0apZ91";
    const privateContext = "customer-private-workflow-marker";
    const firstRequest = await requestFor(repo, {
      freshness: "fresh_required",
      question: `Which reliability priority should advance? Authorization ${secret}`,
      context: {
        workflow: privateContext,
        authorization: `Bearer ${secret}`,
      },
    });

    const writer = new SqliteMemoryStore(dbPath);
    const firstWorker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: writer,
      llm: new FakeLlm(),
      repositoryTools: true,
    });
    await firstWorker.analyze("private-fact-first", firstRequest);
    await writer.close();

    const reader = new SqliteMemoryStore(dbPath);
    const persistedFacts = await reader.search({
      scope: { namespace: "repository_facts", repositoryId: firstRequest.repository.identity },
      maxItems: 10,
      maxChars: 100_000,
    });
    expect(persistedFacts).toHaveLength(1);
    const persistedText = JSON.stringify(persistedFacts);
    expect(persistedText).not.toContain(secret);
    expect(persistedText).not.toContain(privateContext);
    expect(persistedText).not.toContain("Authorization");
    for (const lowEntropyCallerTerm of ["authorization", "reliability", "workflow", "customer"]) {
      const legacyDigest = createHash("sha256")
        .update(`repository-agent-topic-v1\0${lowEntropyCallerTerm}`, "utf8")
        .digest("hex")
        .slice(0, 24);
      expect(persistedText).not.toContain(legacyDigest);
    }
    const persistedValue = persistedFacts[0]?.value as Record<string, unknown>;
    expect(persistedValue.question).toBeUndefined();
    expect(persistedValue.context).toBeUndefined();
    expect(persistedValue.topicDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persistedValue.topicKeywordDigests).toBeUndefined();

    const secondLlm = new FakeLlm();
    const secondWorker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: reader,
      llm: secondLlm,
      repositoryTools: true,
    });
    await secondWorker.analyze(
      "private-fact-second",
      await requestFor(repo, {
        freshness: "fresh_required",
        question: "Which reliability priority should advance next?",
        context: { workflow: "public-follow-up" },
      }),
    );
    const laterPrompt = secondLlm.analysisCalls[0]?.messages[0]?.content ?? "";
    expect(laterPrompt).not.toContain(secret);
    expect(laterPrompt).not.toContain(privateContext);
    const laterPayload = JSON.parse(laterPrompt) as { advisoryMemory?: unknown[] };
    expect(laterPayload.advisoryMemory?.length).toBeGreaterThan(0);
    await reader.close();
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // Bun SQLite can retain a transient Windows WAL handle after close.
    }
  });

  test("does not process a delayed claim that arrives after worker shutdown", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "delayed-after-stop",
      claimToken: "delayed-after-stop-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
    let markClaimStarted: (() => void) | null = null;
    const claimStarted = new Promise<void>((resolveStarted) => {
      markClaimStarted = resolveStarted;
    });
    let finishClaim: ((value: RepositoryAgentClaimResult) => void) | null = null;
    const delayedClaim = new Promise<RepositoryAgentClaimResult>((resolveClaim) => {
      finishClaim = resolveClaim;
    });
    const control = new FakeWorkerControl(null);
    control.claim = async () => {
      markClaimStarted?.();
      return await delayedClaim;
    };
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control,
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      stopDrainMs: 100,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    worker.start();
    await claimStarted;
    await worker.stop();
    finishClaim?.({ claim, pollAfterMs: 5 });
    await Bun.sleep(50);

    expect(llm.calls).toHaveLength(0);
    expect(control.completed).toBeNull();
    expect(control.failed).toBeNull();
    expect(control.renewals).toBe(0);
  });

  test("waits for provider cancellation cleanup while bounding worker shutdown", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "hung-request",
      claimToken: "hung-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
    const control = new FakeWorkerControl(claim);
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let observedSignal: AbortSignal | undefined;
    let providerActive = false;
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        observedSignal = input.signal;
        providerActive = true;
        markStarted?.();
        return await new Promise<LLMGenerateOutput>((_resolve, reject) => {
          const onAbort = () => {
            setTimeout(() => {
              providerActive = false;
              reject(input.signal?.reason ?? new Error("provider cancelled"));
            }, 25);
          };
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      },
    };
    const worker = new RepositoryAgentWorker({
      control,
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      stopDrainMs: 100,
    });

    worker.start();
    await started;
    const stopStartedAt = Date.now();
    await worker.stop();

    expect(Date.now() - stopStartedAt).toBeLessThan(1_000);
    expect(observedSignal?.aborted).toBe(true);
    expect(providerActive).toBe(false);
    expect(control.failed?.code).toBe("worker_stopping");
    expect(control.completed).toBeNull();
  });

  test("renews the fenced lease while processing and completes one claimed request", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "claimed-request",
      claimToken: "claim-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
    const control = new FakeWorkerControl(claim);
    const llm = new FakeLlm(() => modelResponse(), 180);
    const worker = new RepositoryAgentWorker({
      agentId: "repository-agent-worker",
      control,
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      leaseMs: 1_000,
      heartbeatMs: 100,
    });

    await worker.pollOnce();

    expect(llm.discoveryCalls).toHaveLength(0);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(control.renewals).toBeGreaterThan(0);
    expect(control.completed?.requestId).toBe("claimed-request");
    expect(control.failed).toBeNull();
  });

  test("aborts analysis and drains provider cleanup when lease renewal loses authority", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "lease-lost-request",
      claimToken: "lease-lost-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
    const control = new FakeWorkerControl(claim);
    let markProviderStarted: (() => void) | null = null;
    const providerStarted = new Promise<void>((resolveStarted) => {
      markProviderStarted = resolveStarted;
    });
    control.renewLease = async () => {
      control.renewals++;
      await providerStarted;
      throw new RepositoryAgentClientError(
        "http_error",
        "RepositoryAgent lease is stale, expired, or owned by another agent",
        { status: 409, retryable: false },
      );
    };
    let providerActive = false;
    let observedSignal: AbortSignal | undefined;
    let cleanupFinishedAt = 0;
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        observedSignal = input.signal;
        providerActive = true;
        markProviderStarted?.();
        return await new Promise<LLMGenerateOutput>((_resolve, reject) => {
          const onAbort = () => {
            setTimeout(() => {
              providerActive = false;
              cleanupFinishedAt = Date.now();
              reject(input.signal?.reason ?? new Error("provider cancelled"));
            }, 40);
          };
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
        });
      },
    };
    const warnings: string[] = [];
    const worker = new RepositoryAgentWorker({
      agentId: "repository-agent-lease-loss-test",
      control,
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      leaseMs: 1_000,
      heartbeatMs: 100,
      stopDrainMs: 500,
      logger: {
        log: () => {},
        warn: (message) => warnings.push(String(message)),
        error: () => {},
      },
    });

    await worker.pollOnce();
    const pollFinishedAt = Date.now();

    expect(control.renewals).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(String(observedSignal?.reason)).toContain("lease authority was lost");
    expect(providerActive).toBe(false);
    expect(cleanupFinishedAt).toBeGreaterThan(0);
    expect(pollFinishedAt).toBeGreaterThanOrEqual(cleanupFinishedAt);
    expect(control.completed).toBeNull();
    expect(control.failed).toBeNull();
    expect(warnings.some((message) => message.includes("definitively rejected"))).toBe(true);
  });

  test("retains a viable lease across one transient renewal error", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "transient-renewal-request",
      claimToken: "transient-renewal-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(),
      request,
    };
    const control = new FakeWorkerControl(claim);
    control.renewLease = async (requestId) => {
      control.renewals++;
      if (control.renewals === 1) {
        throw new RepositoryAgentClientError("transport_error", "temporary connection reset", {
          retryable: true,
        });
      }
      return {
        requestId,
        status: "claimed",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    };
    const warnings: string[] = [];
    const worker = new RepositoryAgentWorker({
      control,
      memory: new InMemoryMemoryStore(),
      llm: new FakeLlm(() => modelResponse(), 180),
      repositoryTools: true,
      leaseMs: 1_000,
      heartbeatMs: 100,
      logger: {
        log: () => {},
        warn: (message) => warnings.push(String(message)),
        error: () => {},
      },
    });

    await worker.pollOnce();

    expect(control.renewals).toBeGreaterThanOrEqual(2);
    expect(control.completed?.requestId).toBe("transient-renewal-request");
    expect(control.failed).toBeNull();
    expect(warnings.some((message) => message.includes("transient lease renewal error"))).toBe(
      true,
    );
  });

  test("bounds cleanup for an unresponsive provider after the last known lease expires", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, { freshness: "fresh_required" });
    const claim: RepositoryAgentClaim = {
      requestId: "lease-expiry-request",
      claimToken: "lease-expiry-token",
      claimGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
    const control = new FakeWorkerControl(claim);
    let markProviderStarted: (() => void) | null = null;
    const providerStarted = new Promise<void>((resolveStarted) => {
      markProviderStarted = resolveStarted;
    });
    control.renewLease = async (requestId) => {
      control.renewals++;
      if (control.renewals === 1) {
        await providerStarted;
        return {
          requestId,
          status: "claimed",
          leaseExpiresAt: new Date(Date.now() + 250).toISOString(),
        };
      }
      throw new RepositoryAgentClientError("transport_error", "server temporarily unreachable", {
        retryable: true,
      });
    };
    let observedSignal: AbortSignal | undefined;
    let leaseAbortedAt = 0;
    const llm: LLMClient = {
      async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
        observedSignal = input.signal;
        markProviderStarted?.();
        input.signal?.addEventListener(
          "abort",
          () => {
            leaseAbortedAt = Date.now();
          },
          { once: true },
        );
        return await new Promise<LLMGenerateOutput>(() => {});
      },
    };
    const worker = new RepositoryAgentWorker({
      control,
      memory: new InMemoryMemoryStore(),
      llm,
      repositoryTools: true,
      leaseMs: 1_000,
      heartbeatMs: 100,
      stopDrainMs: 100,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await worker.pollOnce();

    const cleanupWaitMs = Date.now() - leaseAbortedAt;
    expect(control.renewals).toBeGreaterThanOrEqual(2);
    expect(observedSignal?.aborted).toBe(true);
    expect(leaseAbortedAt).toBeGreaterThan(0);
    expect(cleanupWaitMs).toBeGreaterThanOrEqual(80);
    expect(cleanupWaitMs).toBeLessThan(750);
    expect(control.completed).toBeNull();
    expect(control.failed).toBeNull();
  });
});
