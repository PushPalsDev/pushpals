import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import Ajv from "ajv";
import {
  AUTONOMY_CANDIDATES_DATA_SCHEMA,
  autonomyCandidateContractErrors,
} from "../apps/remotebuddy/src/autonomy_candidate_contract";
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
  sanitizeRepositoryAgentResult,
  type MemoryStore,
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
          id: "reliability-candidate",
          title: "Improve repository reliability",
          objective_type: "feature_small",
          problem_statement:
            "Add one bounded reliability improvement with focused regression coverage.",
          trigger_type: "regret_signal",
          component_area: "src",
          target_paths: ["src/index.ts"],
          scope: { read_anywhere: true, write_globs: ["src/index.ts"] },
          risk_level: "low",
          expected_validation: ["bun test"],
          estimated_effort: "small",
          why_now_signal_ids: [],
          confidence: 0.9,
          vision_alignment_reason: "Advance the documented reliability priority.",
          vision_section_refs: ["1"],
          feature_hypotheses: ["A bounded fix improves reliability."],
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

const coverageKind = "repository_autonomy_evidence_coverage";
const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function createCoverageRepository(count = 13): string {
  const repo = createRepository();
  for (let index = 0; index < count; index++) {
    writeFileSync(
      join(repo, "src", `coverage-${String(index).padStart(3, "0")}.ts`),
      `export const coverage${index} = ${index};\n`,
    );
  }
  git(repo, ["add", "src"]);
  git(repo, [
    "-c",
    "user.name=PushPals Test",
    "-c",
    "user.email=pushpals@example.invalid",
    "commit",
    "-m",
    "bounded coverage fixture",
  ]);
  return repo;
}

async function coverageRequest(repo: string): Promise<RepositoryAgentRequest> {
  return requestFor(repo, {
    question: "Inspect the coverage implementation for grounded improvements.",
    context: {
      operation: "analyze_autonomy_opportunities",
      vision: { path: "vision.md", sha256: "c".repeat(64), priorities: ["Improve coverage"] },
    },
  });
}

function coverageRecords(memory: MemoryStore, request: RepositoryAgentRequest) {
  return memory.search({
    scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
    kinds: [coverageKind],
    maxItems: 32,
    maxChars: 100_000,
  });
}

async function seedLastCoveragePage(
  worker: RepositoryAgentWorker,
  memory: MemoryStore,
  request: RepositoryAgentRequest,
) {
  await worker.analyze("window-fixture-first", request);
  const [first] = await coverageRecords(memory, request);
  const paths = git(request.repository.root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const coverage = await (worker as any).readEvidenceCoverage(
    request,
    { paths, pathByComparable: new Map(paths.map((path) => [path, path])) },
    "fixture-analysis",
    new AbortController().signal,
    Date.parse(request.deadlineAt),
    [],
  );
  expect(coverage.pageCount).toBe(16);
  await memory.put(
    {
      ...first!,
      value: {
        ...(first!.value as any),
        nextPage: 15,
        reviewedPageFingerprints: coverage.pageFingerprints.slice(0, 15),
      },
    },
    { expectedRevision: first!.revision },
  );
}

function emptyAutonomyResponse(): Record<string, unknown> {
  return modelResponse({ data: { candidates: [] } });
}

function memoryWithHooks(
  memory: MemoryStore,
  hooks: {
    put?: (input: any, options: any) => Promise<void>;
    get?: (address: any, options: any) => Promise<void>;
  },
): MemoryStore {
  return new Proxy(memory, {
    get(target, property) {
      if (property === "put")
        return async (input: any, options: any) => {
          await hooks.put?.(input, options);
          return target.put(input, options);
        };
      if (property === "get")
        return async (address: any, options: any) => {
          await hooks.get?.(address, options);
          return target.get(address, options);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("autonomy candidate deterministic contract agrees with the provider schema on optional and unknown fields", () => {
  const validate = new Ajv().compile(AUTONOMY_CANDIDATES_DATA_SCHEMA);
  const cases: Array<(data: any) => void> = [
    () => {},
    (data) => {
      data.extra = true;
    },
    (data) => {
      data.candidates[0].extra = true;
    },
    (data) => {
      data.candidates[0].requires_user_input = "false";
    },
    (data) => {
      data.candidates[0].question_if_blocked = null;
    },
    (data) => {
      data.candidates[0].vision_objective_id = {};
    },
    (data) => {
      data.candidates[0].scope.extra = true;
    },
    (data) => {
      delete data.candidates[0].confidence;
    },
    (data) => {
      data.candidates[0].target_paths = [42];
    },
    (data) => {
      data.candidates[0].trigger_type = "vision_priority";
    },
    (data) => {
      data.candidates[0].risk_level = "normal";
    },
    (data) => {
      data.candidates[0].estimated_effort = "1-2 days";
    },
  ];
  for (const mutate of cases) {
    const data = structuredClone(modelResponse().data) as any;
    mutate(data);
    expect(autonomyCandidateContractErrors(data).length === 0).toBe(validate(data));
  }
});

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

  test("advances grounded empty pages across restart and preserves an exact positive cache", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const stateRoot = mkdtempSync(join(tmpdir(), "pushpals-coverage-memory-"));
    tempDirs.push(stateRoot);
    const dbPath = join(stateRoot, "memory.sqlite");
    let memory = new SqliteMemoryStore(dbPath);
    let calls = 0;
    const llm = new FakeLlm(() => (++calls < 3 ? emptyAutonomyResponse() : modelResponse()));
    const worker = () =>
      new RepositoryAgentWorker({ control: unusedControl(), memory, llm, logger: quietLogger });
    const first = await worker().analyze("coverage-first", request);
    await memory.close();
    memory = new SqliteMemoryStore(dbPath);
    try {
      const second = await worker().analyze("coverage-second", request);
      const third = await worker().analyze("coverage-third-positive", request);
      const fourth = await worker().analyze("coverage-fourth-cache", request);
      expect([first.cache.hit, second.cache.hit, third.cache.hit, fourth.cache.hit]).toEqual([
        false,
        false,
        false,
        true,
      ]);
      expect(llm.analysisCalls).toHaveLength(3);
      const packets = llm.analysisCalls.map(
        (input) => JSON.parse(input.messages[0]!.content).evidencePacket,
      );
      expect(packets.map((packet) => packet.discoveryCoverage.page)).toEqual([1, 2, 3]);
      expect(packets.every((packet) => packet.seedPaths.includes("vision.md"))).toBe(true);
      const selected = packets.flatMap((packet) => packet.selectedPaths as string[]);
      expect(new Set(selected).size).toBe(selected.length);
      expect(
        packets.every((packet) => packet.selectedPaths.length <= 6 && packet.files.length <= 12),
      ).toBe(true);
      expect(
        packets.every(
          (packet) =>
            packet.files.reduce(
              (total: number, file: any) => total + Buffer.byteLength(file.content),
              0,
            ) <= 64_000,
        ),
      ).toBe(true);
      const [cursor] = await coverageRecords(memory, request);
      expect((cursor!.value as any).nextPage).toBe(2);
      expect(cursor!.revision).toBe(2);
      expect(first.discoveryProgress).toMatchObject({
        page: 1,
        pageCount: 3,
        advanced: true,
        retryEligible: true,
      });
      expect(second.discoveryProgress).toMatchObject({
        page: 2,
        advanced: true,
        retryEligible: true,
      });
      expect(third.discoveryProgress).toMatchObject({
        page: 3,
        advanced: false,
        retryEligible: false,
      });
      expect(fourth.discoveryProgress).toEqual(third.discoveryProgress);
    } finally {
      await memory.close();
    }
  }, 30_000);

  test("resumes reviewed blobs across revisions and unrelated executed-outcome changes without reusing answer facts", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let calls = 0;
    const llm = new FakeLlm(() => (++calls === 1 ? emptyAutonomyResponse() : modelResponse()));
    const worker = () =>
      new RepositoryAgentWorker({ control: unusedControl(), memory, llm, logger: quietLogger });
    await worker().analyze("resume-initial-empty", request);
    const positive = await worker().analyze("resume-positive", request);
    const reviewedPacket = JSON.parse(llm.analysisCalls[0]!.messages[0]!.content).evidencePacket;
    expect([...reviewedPacket.seedPaths, ...reviewedPacket.selectedPaths]).not.toContain(
      "src/coverage-012.ts",
    );
    writeFileSync(join(repo, "src", "coverage-012.ts"), "export const unrelatedChange = true;\n");
    git(repo, ["add", "--", "src/coverage-012.ts"]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "change unrelated evidence page",
    ]);
    const changedOutcomes = {
      ...request,
      repository: await resolveRepositorySnapshot(repo),
      context: {
        ...request.context,
        runtimeSignals: {
          executedOutcomeWatermark: "new-executed-outcome",
          recentObjectives: [
            {
              job_id: "unrelated-completion",
              status: "completed",
              target_paths: ["src/index.ts", "src/coverage-012.ts"],
            },
          ],
        },
      },
    };
    const refreshed = await worker().analyze("resume-outcomes-changed", changedOutcomes);
    expect(changedOutcomes.repository.tree).not.toBe(request.repository.tree);
    expect(refreshed.cache.hit).toBe(false);
    const positiveCacheKey = positive.memoryRefs.find((ref) => ref.role === "analysis_cache")?.key;
    const refreshedCacheKey = refreshed.memoryRefs.find(
      (ref) => ref.role === "analysis_cache",
    )?.key;
    expect(positiveCacheKey).toBeTruthy();
    expect(refreshedCacheKey).toBeTruthy();
    expect(refreshedCacheKey).not.toBe(positiveCacheKey);
    expect(
      refreshed.evidence.every((entry) => entry.revision === changedOutcomes.repository.revision),
    ).toBe(true);
    const packets = llm.analysisCalls.map(
      (input) => JSON.parse(input.messages[0]!.content).evidencePacket,
    );
    expect(packets.map((packet) => packet.discoveryCoverage.page)).toEqual([1, 2, 2]);
    expect(packets[2].seedPaths).toEqual(packets[0].seedPaths);
    expect(packets[2].selectedPaths).toEqual(packets[1].selectedPaths);
    const payload = JSON.parse(llm.analysisCalls[2]!.messages[0]!.content);
    expect(payload.request.context.runtimeSignals.recentObjectives[0].job_id).toBe(
      "unrelated-completion",
    );
    expect(await coverageRecords(memory, request)).toHaveLength(1);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(1);
  });

  test("revisits a changed blob but preserves unchanged reviewed pages and reports exhaustion with holes", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const logs: string[] = [];
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: { ...quietLogger, log: (line) => logs.push(String(line)) },
    });
    for (let page = 1; page <= 3; page++) await worker.analyze(`blob-before-${page}`, request);
    const firstPacket = JSON.parse(llm.analysisCalls[0]!.messages[0]!.content).evidencePacket;
    const changedPath = firstPacket.selectedPaths[0] as string;
    writeFileSync(join(repo, changedPath), "export const changedCoverage = true;\n");
    git(repo, ["add", "--", changedPath]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "change one reviewed blob",
    ]);
    const changed = await worker.analyze("blob-after-change", {
      ...request,
      repository: await resolveRepositorySnapshot(repo),
    });
    expect(changed.cache.hit).toBe(false);
    expect(changed.discoveryProgress).toMatchObject({
      page: 1,
      pageCount: 3,
      advanced: true,
      boundedCoverageExhausted: true,
      retryEligible: false,
    });
    expect(
      llm.analysisCalls.map(
        (input) => JSON.parse(input.messages[0]!.content).evidencePacket.discoveryCoverage.page,
      ),
    ).toEqual([1, 2, 3, 1]);
    expect(
      JSON.parse(
        logs
          .filter((line) => line.includes("evidenceCoverage="))
          .at(-1)!
          .split("evidenceCoverage=")[1]!,
      ),
    ).toMatchObject({ page: 1, boundedCoverageExhausted: true });
    expect(await coverageRecords(memory, request)).toHaveLength(1);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(4);
  });

  test.each(["vision", "policy"])(
    "starts a new bounded pass after changed %s",
    async (changedField) => {
      const repo = createCoverageRepository();
      const request = await coverageRequest(repo);
      const memory = new InMemoryMemoryStore();
      const llm = new FakeLlm(emptyAutonomyResponse);
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        logger: quietLogger,
      });
      await worker.analyze("qualification-original", request);
      const context = { ...request.context };
      if (changedField === "vision")
        context.vision = {
          ...(context.vision as any),
          priorities: ["Improve a different priority"],
        };
      else context.deterministicPolicy = { minimumConfidence: 0.8 };
      const changed = await worker.analyze("qualification-changed", { ...request, context });
      expect(changed.cache.hit).toBe(false);
      expect(changed.discoveryProgress).toMatchObject({ page: 1, advanced: true });
      expect(
        llm.analysisCalls.map(
          (input) => JSON.parse(input.messages[0]!.content).evidencePacket.discoveryCoverage.page,
        ),
      ).toEqual([1, 1]);
      expect(await coverageRecords(memory, request)).toHaveLength(2);
    },
  );

  test("defers an excluded cached positive across workers without poisoning its reusable answer", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let failCoverageWrite = true;
    const hooked = memoryWithHooks(memory, {
      put: async (input) => {
        if (input.kind === coverageKind && failCoverageWrite)
          throw new Error("coverage temporarily unavailable");
      },
    });
    let calls = 0;
    const llm = new FakeLlm(() => {
      const response = modelResponse() as any;
      if (++calls > 1) {
        response.data.candidates[0].id = "other-candidate";
        response.data.candidates[0].target_paths = ["src/coverage-006.ts"];
        response.data.candidates[0].scope.write_globs = ["src/coverage-006.ts"];
      }
      return response;
    });
    const worker = () =>
      new RepositoryAgentWorker({
        control: unusedControl(),
        memory: hooked,
        llm,
        logger: quietLogger,
      });
    const original = await worker().analyze("exclusion-original", request);
    const excludedRequest = {
      ...request,
      context: { ...request.context, discoveryExclusions: { targetPaths: ["src/index.ts"] } },
    };
    const failed = await worker().analyze("exclusion-write-failed", excludedRequest);
    expect(failed.cache.hit).toBe(true);
    expect(failed.discoveryProgress).toMatchObject({
      advanced: false,
      retryEligible: false,
      excludedCandidateCount: 1,
    });
    expect(await coverageRecords(memory, request)).toHaveLength(0);
    failCoverageWrite = false;
    const excluded = await worker().analyze("exclusion-cached", excludedRequest);
    expect(excluded.cache.hit).toBe(true);
    expect((excluded.data as any).candidates).toEqual([]);
    expect(excluded.discoveryProgress).toMatchObject({
      page: 1,
      advanced: true,
      retryEligible: true,
      excludedCandidateCount: 1,
    });
    expect(sanitizeRepositoryAgentResult(excluded).discoveryProgress).toEqual(
      excluded.discoveryProgress,
    );
    const [cursor] = await coverageRecords(memory, request);
    expect((cursor!.value as any).reviewedPageFingerprints).toEqual([]);
    expect((cursor!.value as any).deferredPageFingerprints).toHaveLength(1);
    const next = await worker().analyze("exclusion-next-page", excludedRequest);
    expect((next.data as any).candidates[0].id).toBe("other-candidate");
    expect(next.discoveryProgress).toMatchObject({
      page: 2,
      advanced: false,
      retryEligible: false,
      excludedCandidateCount: 0,
    });
    const restored = await worker().analyze("exclusion-removed", request);
    expect(restored.cache.hit).toBe(true);
    const originalCacheKey = original.memoryRefs.find((ref) => ref.role === "analysis_cache")?.key;
    expect(originalCacheKey).toBeTruthy();
    expect(restored.cache.key).toBe(originalCacheKey);
    expect(restored.data).toEqual(original.data);
    expect(restored.discoveryProgress).toMatchObject({
      page: 1,
      advanced: false,
      retryEligible: false,
      excludedCandidateCount: 0,
    });
    expect(llm.analysisCalls).toHaveLength(2);
    expect(
      llm.analysisCalls.every(
        (input) => !input.messages[0]!.content.includes("discoveryExclusions"),
      ),
    ).toBe(true);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(cursor!.revision);
  });

  test("filters only overlapping siblings at delivery and never stores filtered positive facts", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const response = modelResponse() as any;
    const sibling = structuredClone(response.data.candidates[0]);
    Object.assign(sibling, {
      id: "sibling",
      target_paths: ["src/coverage-000.ts"],
      scope: { read_anywhere: true, write_globs: ["src/coverage-000.ts"] },
    });
    response.data.candidates.push(sibling);
    const llm = new FakeLlm(() => response);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const filtered = await worker.analyze("mixed-exclusion", {
      ...request,
      context: { ...request.context, discoveryExclusions: { targetPaths: ["src/index.ts/child"] } },
    });
    expect((filtered.data as any).candidates.map((candidate: any) => candidate.id)).toEqual([
      "sibling",
    ]);
    expect(filtered.discoveryProgress).toMatchObject({
      advanced: false,
      retryEligible: false,
      excludedCandidateCount: 1,
    });
    expect(await coverageRecords(memory, request)).toHaveLength(0);
    const restored = await worker.analyze("mixed-restored", request);
    expect(restored.cache.hit).toBe(true);
    expect(restored.data).toEqual(response.data);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(
      sanitizeRepositoryAgentResult({
        ...filtered,
        discoveryProgress: { ...filtered.discoveryProgress, advanced: true, retryEligible: true },
      }).discoveryProgress!.retryEligible,
    ).toBe(false);
    expect(() =>
      sanitizeRepositoryAgentResult({
        ...filtered,
        discoveryProgress: { ...filtered.discoveryProgress, pageCount: 17 },
      }),
    ).toThrow("pageCount");
    expect(() =>
      sanitizeRepositoryAgentResult({
        ...filtered,
        discoveryProgress: { ...filtered.discoveryProgress, advanced: "true" },
      }),
    ).toThrow("advanced");
  });

  test.each([
    ["objective_type_not_allowed", { objective_type: "feature_large" }],
    ["risk_exceeds_policy", { risk_level: "high" }],
    ["scope_validation_failed", { target_paths: [] }],
    ["scope_validation_failed", { scope: { read_anywhere: true, write_globs: ["../outside"] } }],
    ["missing_vision_section_refs", { vision_section_refs: ["99"] }],
    [
      "target_paths_missing_in_repo",
      {
        target_paths: ["src/missing.ts"],
        scope: { read_anywhere: true, write_globs: ["src/missing.ts"] },
      },
    ],
    ["pushpals_internal_leak", { title: "Add WorkerPal runtime telemetry" }],
    ["pushpals_internal_leak", { title: "Add LocalBuddy runtime telemetry" }],
    ["pushpals_internal_leak", { title: "Add PushPal runtime telemetry" }],
    ["confidence_below_threshold", { confidence: 0.4 }],
  ] as Array<[string, Record<string, unknown>]>)(
    "advances discovery instead of replaying a positive rejected for %s",
    async (reason, overrides) => {
      const repo = createCoverageRepository();
      const request = await coverageRequest(repo);
      request.context!.vision = {
        ...(request.context!.vision as any),
        sections: [{ number: "1", title: "Priorities" }],
      };
      request.context!.deterministicPolicy = { minimumConfidence: 0.6 };
      const memory = new InMemoryMemoryStore();
      const warnings: string[] = [];
      let calls = 0;
      const llm = new FakeLlm(() => {
        const response = modelResponse() as any;
        if (++calls === 1) Object.assign(response.data.candidates[0], overrides);
        return response;
      });
      const worker = () =>
        new RepositoryAgentWorker({
          control: unusedControl(),
          memory,
          llm,
          logger: { ...quietLogger, warn: (line) => warnings.push(String(line)) },
        });
      const rejected = await worker().analyze("rejected-positive", request);
      expect((rejected.data as any).candidates).toEqual([]);
      expect(rejected.summary).toContain(reason);
      expect(warnings.join("\n")).toContain('"outcome":"no_structurally_admissible_candidates"');
      const next = await worker().analyze("next-page-positive", request);
      expect((next.data as any).candidates).toHaveLength(1);
      expect(next.cache.hit).toBe(false);
      const cached = await worker().analyze("next-page-cache", request);
      expect(cached.cache.hit).toBe(true);
      expect((cached.data as any).candidates).toHaveLength(1);
      expect(
        llm.analysisCalls.map(
          (input) => JSON.parse(input.messages[0]!.content).evidencePacket.discoveryCoverage.page,
        ),
      ).toEqual([1, 2]);
      const [cursor] = await coverageRecords(memory, request);
      expect((cursor!.value as any).nextPage).toBe(1);
    },
  );

  test("cache identity fences read-anywhere policy without caching transient cooldown rejection", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const allowed = await worker.analyze("policy-allowed", request);
    expect((allowed.data as any).candidates).toHaveLength(1);
    const blocked = await worker.analyze("policy-denied", {
      ...request,
      context: { ...request.context, deterministicPolicy: { allowReadAnywhere: false } },
    });
    expect(blocked.cache.hit).toBe(false);
    expect((blocked.data as any).candidates).toEqual([]);
    expect(blocked.summary).toContain("read_anywhere_not_allowed");
    const transient = await worker.analyze("policy-transient", {
      ...request,
      context: {
        ...request.context,
        runtimeSignals: {
          activeCooldowns: [{ path: "src/index.ts", until: "2099-01-01" }],
          openObjectives: [{ target_paths: ["src/index.ts"] }],
        },
      },
    });
    expect(transient.cache.hit).toBe(true);
    expect((transient.data as any).candidates).toHaveLength(1);
    expect(llm.analysisCalls).toHaveLength(2);
  });

  test("keeps admitted siblings in a mixed batch without replaying rejected proposals", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() => {
      const response = modelResponse() as any;
      response.data.candidates.push({
        ...response.data.candidates[0],
        id: "internal",
        title: "Add WorkerPal orchestration",
      });
      return response;
    });
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const first = await worker.analyze("mixed-first", request);
    const second = await worker.analyze("mixed-cache", request);
    expect((first.data as any).candidates.map((entry: any) => entry.id)).toEqual([
      "reliability-candidate",
    ]);
    expect(second.data).toEqual(first.data);
    expect(second.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(await coverageRecords(memory, request)).toHaveLength(0);
  });

  test.each([
    [{ disabledObjectiveTypes: ["feature_small"] }, "objective_type_not_allowed"],
    [{ disabledComponents: ["src"] }, "component_disabled_by_policy"],
  ])(
    "fences explicitly disabled configuration %j from reusable allowed proposals",
    async (policy, reason) => {
      const repo = createCoverageRepository();
      const request = await coverageRequest(repo);
      const memory = new InMemoryMemoryStore();
      const llm = new FakeLlm();
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        logger: quietLogger,
      });
      expect((await worker.analyze("before-disable", request)).cache.hit).toBe(false);
      const disabled = await worker.analyze("disabled", {
        ...request,
        context: { ...request.context, deterministicPolicy: policy },
      });
      expect(disabled.cache.hit).toBe(false);
      expect((disabled.data as any).candidates).toEqual([]);
      expect(disabled.summary).toContain(reason as string);
      const restored = await worker.analyze("restored", request);
      expect(restored.cache.hit).toBe(true);
      expect((restored.data as any).candidates).toHaveLength(1);
      expect(llm.analysisCalls).toHaveLength(2);
    },
  );

  test("advances a proposal without inferable validation but keeps inferred validation for another target", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-unknown-validation-"));
    tempDirs.push(repo);
    git(repo, ["init"]);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "vision.md"), "# Vision\n\n## Priorities\n\nKeep formats correct.\n");
    for (let index = 0; index < 9; index++)
      writeFileSync(join(repo, "src", `format-${index}.wat`), "(module)\n");
    writeFileSync(join(repo, "src", "valid.js"), "export const ready = true;\n");
    git(repo, ["add", "."]);
    git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let calls = 0;
    const llm = new FakeLlm(() => {
      const response = modelResponse() as any;
      const target = ++calls === 1 ? "src/format-0.wat" : "src/valid.js";
      Object.assign(response.data.candidates[0], {
        target_paths: [target],
        scope: { read_anywhere: true, write_globs: [target] },
        expected_validation: calls === 1 ? ["bun test"] : [],
      });
      return response;
    });
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const rejected = await worker.analyze("unvalidated", request);
    expect((rejected.data as any).candidates).toEqual([]);
    expect(rejected.summary).toContain("missing_validation_steps");
    const accepted = await worker.analyze("inferable", request);
    expect((accepted.data as any).candidates).toHaveLength(1);
    expect((accepted.data as any).candidates[0].expected_validation).toEqual([]);
    expect(accepted.cache.hit).toBe(false);
    expect((await worker.analyze("inferable-cached", request)).cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(2);
  });

  test("revalidates a cached positive before delivery and advances only after an actual cache read", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const first = await worker.analyze("before-invalid-cache", request);
    const scope = {
      namespace: "repository_agent_cache",
      repositoryId: request.repository.identity,
    };
    const key = first.memoryRefs.find((ref) => ref.role === "analysis_cache")?.key;
    expect(key).toBeTruthy();
    const record = await memory.get({ scope, key: key! });
    expect(record).not.toBeNull();
    const value = structuredClone(record!.value) as any;
    value.result.data.candidates[0].title = "Add RemoteBuddy internal telemetry";
    await memory.put({
      scope,
      key: record!.key,
      kind: record!.kind,
      summary: record!.summary,
      value,
      provenance: record!.provenance,
      confidence: record!.confidence,
    });
    const readOnly = await worker.analyze("invalid-cache-readonly", {
      ...request,
      freshness: "cache_only",
    });
    expect(readOnly.cache.hit).toBe(true);
    expect((readOnly.data as any).candidates).toEqual([]);
    expect(await coverageRecords(memory, request)).toHaveLength(0);
    const rejected = await worker.analyze("invalid-cache-rejected", request);
    expect(rejected.cache.hit).toBe(true);
    expect((rejected.data as any).candidates).toEqual([]);
    const next = await worker.analyze("after-invalid-cache", request);
    expect(next.cache.hit).toBe(false);
    expect((next.data as any).candidates).toHaveLength(1);
    expect(llm.analysisCalls).toHaveLength(2);
  });

  test.skipIf(process.platform === "win32")(
    "never uses a linked external manifest to admit or invalidate a same-tree candidate",
    async () => {
      const repo = createRepository();
      const outside = mkdtempSync(join(tmpdir(), "pushpals-validation-outside-"));
      tempDirs.push(outside);
      const manifest = join(outside, "package.json");
      writeFileSync(manifest, JSON.stringify({ scripts: { test: "bun test" } }));
      rmSync(join(repo, "package.json"));
      symlinkSync(manifest, join(repo, "package.json"));
      git(repo, ["add", "package.json"]);
      git(repo, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "linked manifest",
      ]);
      const request = await coverageRequest(repo);
      const memory = new InMemoryMemoryStore();
      const llm = new FakeLlm();
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        logger: quietLogger,
      });
      const first = await worker.analyze("linked-validation", request);
      expect((first.data as any).candidates).toEqual([]);
      expect(first.summary).toContain("missing_validation_steps");
      writeFileSync(manifest, JSON.stringify({ scripts: { check: "node outside-host-only.js" } }));
      const second = await worker.analyze("linked-validation-cache", request);
      expect(second.cache.hit).toBe(true);
      expect((second.data as any).candidates).toEqual([]);
      expect(llm.analysisCalls).toHaveLength(1);
    },
  );

  test("does not cache missing validation when manifest inspection exceeds its bounded evidence budget", async () => {
    const repo = createRepository();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        padding: "x".repeat(600_000),
        scripts: { test: "bun test" },
      }),
    );
    git(repo, ["add", "package.json"]);
    git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "large manifest",
    ]);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm: new FakeLlm(),
      logger: quietLogger,
    });
    await expect(worker.analyze("bounded-validation", request)).rejects.toThrow(
      "Bounded validation snapshot unavailable",
    );
    expect(await coverageRecords(memory, request)).toEqual([]);
    expect(
      await memory.search({
        scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
        kinds: ["exact_repository_analysis"],
      }),
    ).toEqual([]);
  });

  test("incomplete tracked inventory cannot establish validation-manifest absence", async () => {
    const repo = createRepository();
    const request = await coverageRequest(repo);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm: new FakeLlm(),
      logger: quietLogger,
    });
    await expect(
      (worker as any).validationSnapshotFileSystem(
        repo,
        request,
        {
          paths: ["src/index.ts"],
          pathByComparable: new Map([["src/index.ts", "src/index.ts"]]),
        },
        ["src/index.ts"],
        new AbortController().signal,
      ),
    ).rejects.toThrow("tracked inventory is incomplete");
  });

  test("continues beyond the first 96 paths across restart with bounded evidence windows", async () => {
    const repo = createCoverageRepository(100);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const logs: string[] = [];
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: { ...quietLogger, log: (line) => logs.push(String(line)) },
    });
    await seedLastCoveragePage(worker, memory, request);
    const boundary = await worker.analyze("coverage-cap-last", request);
    expect(boundary.discoveryProgress).toMatchObject({
      page: 16,
      pageCount: 16,
      advanced: true,
      boundedCoverageExhausted: false,
      nextWindowAvailable: true,
      retryEligible: true,
    });
    expect(sanitizeRepositoryAgentResult(boundary).discoveryProgress).toEqual(
      boundary.discoveryProgress,
    );
    const [last] = await coverageRecords(memory, request);
    expect((last!.value as any).windowStartPage).toBe(16);
    expect((last!.value as any).nextPage).toBe(0);
    const restarted = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: { ...quietLogger, log: (line) => logs.push(String(line)) },
    });
    const tail = await restarted.analyze("coverage-next-window", request);
    expect(tail.cache.hit).toBe(false);
    const packets = llm.analysisCalls.map(
      (input) => JSON.parse(input.messages[0]!.content).evidencePacket,
    );
    expect(packets.at(-1).discoveryCoverage).toMatchObject({ window: 2, page: 1 });
    expect(packets.at(-1).selectedPaths).toContain("src/coverage-099.ts");
    expect(
      packets.every((packet) => packet.selectedPaths.length <= 6 && packet.files.length <= 12),
    ).toBe(true);
    expect(packets.every((packet) => packet.seedPaths.includes("vision.md"))).toBe(true);
    expect(tail.discoveryProgress).toMatchObject({
      advanced: true,
      boundedCoverageExhausted: true,
      retryEligible: false,
    });
    const [exhausted] = await coverageRecords(memory, request);
    const cached = await restarted.analyze("coverage-cap-exhausted", request);
    expect(cached.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(3);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(exhausted!.revision);
    const reports = logs
      .filter((line) => line.includes("evidenceCoverage="))
      .map((line) => JSON.parse(line.split("evidenceCoverage=")[1]!));
    expect(reports.at(-1)).toMatchObject({
      page: 1,
      pageCount: 1,
      window: 2,
      windowCount: 2,
      additionalPathsCapped: true,
      boundedCoverageExhausted: true,
      repositoryExhaustivenessEstablished: false,
      cacheHit: true,
      advanced: false,
    });
  }, 30_000);

  test("after final-window exhaustion changed earlier evidence is revisited without resetting unchanged pages", async () => {
    const repo = createCoverageRepository(100);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    await seedLastCoveragePage(worker, memory, request);
    await worker.analyze("rewind-window-boundary", request);
    await worker.analyze("rewind-final-window", request);
    const [exhausted] = await coverageRecords(memory, request);
    expect((exhausted!.value as any).windowStartPage).toBe(16);
    expect((exhausted!.value as any).reviewedPageFingerprints).toHaveLength(17);
    writeFileSync(
      join(repo, "src", "coverage-000.ts"),
      "export const changedEarlierEvidence = true;\n",
    );
    git(repo, ["add", "src/coverage-000.ts"]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "change previously reviewed early evidence",
    ]);
    const changedRequest = { ...request, repository: await resolveRepositorySnapshot(repo) };
    const changed = await worker.analyze("rewind-earlier-window", changedRequest);
    expect(changed.cache.hit).toBe(false);
    expect(changed.discoveryProgress).toMatchObject({
      page: 1,
      advanced: true,
      retryEligible: true,
      boundedCoverageExhausted: false,
    });
    const packet = JSON.parse(llm.analysisCalls.at(-1)!.messages[0]!.content).evidencePacket;
    expect(packet.discoveryCoverage).toMatchObject({ window: 1, page: 1 });
    expect(packet.selectedPaths).toContain("src/coverage-000.ts");
    expect(llm.analysisCalls).toHaveLength(4);
    const [reconciled] = await coverageRecords(memory, changedRequest);
    // All unchanged earlier pages stay visited, so this single changed page
    // advances directly back to the tail window, not sixteen new model calls.
    expect((reconciled!.value as any).windowStartPage).toBe(16);
    expect((reconciled!.value as any).reviewedPageFingerprints).toHaveLength(18);
    expect((reconciled!.value as any).repositoryRevision).toBe(changedRequest.repository.revision);
  });

  test("legacy exhausted first-window memory resumes from its cached final page without clearing state", async () => {
    const repo = createCoverageRepository(100);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    await seedLastCoveragePage(worker, memory, request);
    await worker.analyze("legacy-cache-final-page", request);
    const [current] = await coverageRecords(memory, request);
    const {
      windowStartPage: _windowStartPage,
      rankedPlanHash: _rankedPlanHash,
      repositoryRevision: _repositoryRevision,
      ...legacyValue
    } = current!.value as Record<string, any>;
    const legacy = await memory.put(
      {
        ...current!,
        value: { ...legacyValue, nextPage: 16, pageCount: 16 },
      },
      { expectedRevision: current!.revision },
    );
    const restarted = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });

    const migrated = await restarted.analyze("legacy-exhausted-resume", request);

    expect(migrated.cache.hit).toBe(true);
    expect(migrated.discoveryProgress).toMatchObject({
      page: 16,
      pageCount: 16,
      advanced: true,
      boundedCoverageExhausted: false,
      nextWindowAvailable: true,
      retryEligible: true,
    });
    expect(llm.analysisCalls).toHaveLength(2);
    const [advanced] = await coverageRecords(memory, request);
    expect(advanced!.revision).toBe(legacy.revision + 1);
    expect(advanced!.value).toMatchObject({ windowStartPage: 16, nextPage: 0 });
    await restarted.analyze("legacy-unseen-tail", request);
    const packet = JSON.parse(llm.analysisCalls.at(-1)!.messages[0]!.content).evidencePacket;
    expect(packet.discoveryCoverage).toMatchObject({ window: 2, page: 1 });
    expect(packet.selectedPaths).toContain("src/coverage-099.ts");
    expect(llm.analysisCalls).toHaveLength(3);
  });

  test("window-boundary CAS failure retries the cached page but cache_only cannot rotate", async () => {
    const repo = createCoverageRepository(100);
    const request = await coverageRequest(repo);
    const store = new InMemoryMemoryStore();
    let rejectBoundary = true;
    const memory = memoryWithHooks(store, {
      put: async (input) => {
        if (input.kind === coverageKind && input.value.windowStartPage === 16 && rejectBoundary)
          throw new Error("window cursor persistence unavailable");
      },
    });
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    await seedLastCoveragePage(worker, memory, request);
    const failed = await worker.analyze("boundary-cas-failed", request);
    expect(failed.discoveryProgress).toMatchObject({ advanced: false, retryEligible: false });
    expect(failed.discoveryProgress?.nextWindowAvailable).not.toBe(true);
    expect((await coverageRecords(memory, request))[0]!.value).toMatchObject({
      windowStartPage: 0,
      nextPage: 15,
    });
    rejectBoundary = false;
    const only = await worker.analyze("boundary-cache-only", {
      ...request,
      freshness: "cache_only",
    });
    expect(only.cache.hit).toBe(true);
    expect(only.discoveryProgress).toMatchObject({ advanced: false, retryEligible: false });
    expect((await coverageRecords(memory, request))[0]!.value).toMatchObject({
      windowStartPage: 0,
      nextPage: 15,
    });
    const retry = await worker.analyze("boundary-cas-retry", request);
    expect(retry.cache.hit).toBe(true);
    expect(retry.discoveryProgress).toMatchObject({
      advanced: true,
      nextWindowAvailable: true,
      retryEligible: true,
    });
    expect(llm.analysisCalls).toHaveLength(2);
    expect((await coverageRecords(memory, request))[0]!.value).toMatchObject({
      windowStartPage: 16,
      nextPage: 0,
    });
  });

  test("removing an exclusion restores an earlier-window positive without another model call", async () => {
    const repo = createCoverageRepository(100);
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let calls = 0;
    const llm = new FakeLlm(() => (++calls === 1 ? emptyAutonomyResponse() : modelResponse()));
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    await seedLastCoveragePage(worker, memory, request);
    const positive = await worker.analyze("boundary-positive", request);
    expect((positive.data as any).candidates).toHaveLength(1);
    const excluded = await worker.analyze("boundary-positive-excluded", {
      ...request,
      context: { ...request.context, discoveryExclusions: { targetPaths: ["src/index.ts"] } },
    });
    expect(excluded.cache.hit).toBe(true);
    expect(excluded.discoveryProgress).toMatchObject({
      page: 16,
      advanced: true,
      nextWindowAvailable: true,
      excludedCandidateCount: 1,
    });
    expect((await coverageRecords(memory, request))[0]!.value).toMatchObject({
      windowStartPage: 16,
    });
    const restored = await worker.analyze("boundary-exclusion-removed", request);
    expect(restored.cache.hit).toBe(true);
    expect((restored.data as any).candidates).toHaveLength(1);
    expect(restored.discoveryProgress).toMatchObject({
      page: 16,
      advanced: false,
      retryEligible: false,
    });
    expect(llm.analysisCalls).toHaveLength(2);
  });

  test("retries failed cursor writes from cached empty pages but cache_only never advances", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let failWrite = true;
    const fences: any[] = [];
    const hooked = memoryWithHooks(memory, {
      put: async (input, options) => {
        if (input.kind !== coverageKind) return;
        fences.push(options);
        if (failWrite) throw new Error("temporary coverage store outage");
      },
    });
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: hooked,
      llm,
      logger: quietLogger,
    });
    const failed = await worker.analyze("coverage-write-failed", request);
    expect(failed.discoveryProgress).toMatchObject({ advanced: false, retryEligible: false });
    expect(await coverageRecords(memory, request)).toHaveLength(0);
    failWrite = false;
    const only = await worker.analyze("coverage-cache-only", {
      ...request,
      freshness: "cache_only",
    });
    expect(only.cache.hit).toBe(true);
    expect(only.discoveryProgress).toMatchObject({ advanced: false, retryEligible: false });
    expect(fences).toHaveLength(1);
    const retry = await worker.analyze("coverage-write-retry", request);
    expect(retry.cache.hit).toBe(true);
    expect(retry.discoveryProgress).toMatchObject({ advanced: true, retryEligible: true });
    expect(llm.analysisCalls).toHaveLength(1);
    const [cursor] = await coverageRecords(memory, request);
    expect((cursor!.value as any).nextPage).toBe(1);
    expect(fences).toHaveLength(2);
    expect(
      fences.every(
        (entry) =>
          entry.expectedRevision === 0 &&
          entry.signal instanceof AbortSignal &&
          Date.parse(entry.validUntil) <= Date.parse(request.deadlineAt),
      ),
    ).toBe(true);
    await expect(
      worker.analyze("coverage-unseen-cache-only", { ...request, freshness: "cache_only" }),
    ).rejects.toThrow("does not contain this request");
    expect(llm.analysisCalls).toHaveLength(1);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(cursor!.revision);
  }, 30_000);

  test("concurrent empty analyses advance only once and a stale completion cannot regress coverage", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let release!: () => void;
    let reachedBoth!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = new Promise<void>((resolve) => {
      reachedBoth = resolve;
    });
    let calls = 0;
    const llm: LLMClient = {
      async generate() {
        if (++calls === 2) reachedBoth();
        await barrier;
        return { text: JSON.stringify(emptyAutonomyResponse()) };
      },
    };
    const workers = [1, 2].map(
      () =>
        new RepositoryAgentWorker({ control: unusedControl(), memory, llm, logger: quietLogger }),
    );
    const pending = workers.map((worker, index) =>
      worker.analyze(`coverage-race-${index}`, request),
    );
    await both;
    release();
    const results = await Promise.all(pending);
    expect(results.filter((result) => result.discoveryProgress?.retryEligible)).toHaveLength(1);
    expect(results.filter((result) => result.discoveryProgress?.advanced)).toHaveLength(1);
    const [cursor] = await coverageRecords(memory, request);
    expect((cursor!.value as any).nextPage).toBe(1);
    expect(cursor!.revision).toBe(1);
    await workers[0]!.analyze("coverage-race-next", request);
    const [next] = await coverageRecords(memory, request);
    expect((next!.value as any).nextPage).toBe(2);
    expect(next!.revision).toBe(2);
    expect(calls).toBe(3);
  }, 30_000);

  test.each(["expired", "invalid", "malformed"])(
    "resets %s coverage while retaining the occupied CAS revision",
    async (mode) => {
      const repo = createCoverageRepository();
      const request = await coverageRequest(repo);
      const memory = new InMemoryMemoryStore();
      const llm = new FakeLlm(emptyAutonomyResponse);
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        logger: quietLogger,
      });
      await worker.analyze("coverage-reset-seed", request);
      const [first] = await coverageRecords(memory, request);
      const broken = await memory.put(
        {
          ...first!,
          ...(mode === "expired" ? { expiresAt: new Date(Date.now() - 1_000).toISOString() } : {}),
          ...(mode === "invalid" ? { status: "invalid" as const } : {}),
          ...(mode === "malformed" ? { value: { ...(first!.value as any), nextPage: -1 } } : {}),
        },
        { expectedRevision: first!.revision },
      );
      const recovered = await worker.analyze("coverage-reset-recovered", request);
      expect(recovered.cache.hit).toBe(true);
      const [next] = await coverageRecords(memory, request);
      expect(next!.revision).toBe(broken.revision + 1);
      expect(next!.status).toBe("active");
      expect((next!.value as any).nextPage).toBe(1);
    },
  );

  test("does not invent a cursor revision when coverage memory cannot be read", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    let failRead = true;
    const hooked = memoryWithHooks(memory, {
      get: async (address) => {
        if (failRead && address.key.startsWith("coverage:"))
          throw new Error("coverage read unavailable");
      },
    });
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: hooked,
      llm,
      logger: quietLogger,
    });
    await worker.analyze("coverage-read-unavailable", request);
    expect(await coverageRecords(memory, request)).toHaveLength(0);
    failRead = false;
    const cached = await worker.analyze("coverage-read-restored", request);
    expect(cached.cache.hit).toBe(true);
    expect((await coverageRecords(memory, request))[0]!.revision).toBe(1);
    expect(llm.analysisCalls).toHaveLength(1);
  });

  test.each(["dirty", "provider_failure", "cancelled", "stale", "deadline"])(
    "does not advance coverage after %s analysis",
    async (mode) => {
      const repo = createCoverageRepository();
      let request = await coverageRequest(repo);
      const memory = new InMemoryMemoryStore();
      const controller = new AbortController();
      const llm: LLMClient = {
        async generate() {
          if (mode === "provider_failure") throw new Error("provider unavailable");
          if (mode === "cancelled") controller.abort(new Error("cancel coverage test"));
          if (mode === "stale")
            writeFileSync(join(repo, "README.md"), "changed during synthesis\n");
          return { text: JSON.stringify(emptyAutonomyResponse()) };
        },
      };
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory,
        llm,
        logger: quietLogger,
      });
      if (mode === "dirty") {
        writeFileSync(join(repo, "README.md"), "dirty before analysis\n");
        request = { ...request, repository: await resolveRepositorySnapshot(repo) };
      }
      if (mode === "deadline")
        request = { ...request, deadlineAt: new Date(Date.now() - 1).toISOString() };
      const result = worker.analyze(`coverage-no-advance-${mode}`, request, controller.signal);
      if (["cancelled", "stale", "deadline"].includes(mode)) await expect(result).rejects.toThrow();
      else await result;
      expect(await coverageRecords(memory, request)).toHaveLength(0);
    },
  );

  test("rechecks snapshot after a coverage-write await before returning success", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = memoryWithHooks(new InMemoryMemoryStore(), {
      put: async (input) => {
        if (input.kind === coverageKind)
          writeFileSync(join(repo, "README.md"), "changed during coverage write\n");
      },
    });
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm: new FakeLlm(emptyAutonomyResponse),
      logger: quietLogger,
    });
    await expect(worker.analyze("coverage-write-stale", request)).rejects.toThrow(
      "Repository changed",
    );
  });

  test("preserves non-goals and excludes unkeyed transient eligibility from synthesis and retrieval", async () => {
    const repo = createCoverageRepository();
    const request = await coverageRequest(repo);
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      logger: quietLogger,
    });
    const context = {
      ...request.context,
      vision: { ...(request.context!.vision as any), non_goals: ["Never add account collection."] },
      targetPaths: ["src/coverage-012.ts"],
      runtimeSignals: {
        topSignals: [{ evidence: "src/coverage-012.ts" }],
        openObjectives: [{ target_paths: ["src/coverage-012.ts"] }],
        activeCooldowns: [{ path: "src/coverage-012.ts" }],
      },
    };
    await worker.analyze("structural-context-first", { ...request, context });
    const payload = JSON.parse(llm.analysisCalls[0]!.messages[0]!.content);
    expect(payload.request.context.vision.non_goals).toEqual(["Never add account collection."]);
    expect(payload.request.context.runtimeSignals).toEqual({
      executedOutcomeWatermark: null,
      recentObjectives: [],
    });
    expect(payload.request.context.targetPaths).toBeUndefined();
    expect(payload.evidencePacket.seedPaths).not.toContain("src/coverage-012.ts");
    expect(payload.evidencePacket.selectedPaths).not.toContain("src/coverage-012.ts");
    const repeated = await worker.analyze("structural-context-transient-change", {
      ...request,
      context: {
        ...context,
        targetPaths: ["src/coverage-011.ts"],
        runtimeSignals: { activeCooldowns: [] },
      },
    });
    expect(repeated.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(1);
  });

  test("normalizes structural context idempotently before retrieval, keying and synthesis", async () => {
    const repo = createRepository();
    const request = await coverageRequest(repo);
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      logger: quietLogger,
    });
    const raw = {
      ...request,
      context: {
        ...request.context,
        vision: {
          ...(request.context!.vision as any),
          sha256: "\u0130".repeat(256),
          non_goals: ["\uFB03".repeat(1_000)],
          sections: [null, "invalid", {}, { number: "1", title: "Scope" }],
        },
        deterministicPolicy: { notes: ["\uFB03".repeat(1_000)] },
        runtimeSignals: {
          recentObjectives: [{ job_id: "   ", status: "failed", target_paths: ["src/index.ts"] }],
        },
      },
    };
    const canonical = (worker as any).compactSynthesisContext(raw);
    expect((worker as any).compactSynthesisContext({ ...raw, context: canonical })).toEqual(
      canonical,
    );
    expect(canonical.vision.non_goals[0].length).toBeLessThanOrEqual(2_000);
    expect(canonical.deterministicPolicy.notes[0].length).toBeLessThanOrEqual(1_000);
    expect(canonical.runtimeSignals.recentObjectives).toEqual([]);
    await worker.analyze("canonical-raw", raw);
    const payload = JSON.parse(llm.analysisCalls[0]!.messages[0]!.content);
    expect(payload.request.context).toEqual(canonical);
    const cached = await worker.analyze("canonical-normalized", { ...raw, context: canonical });
    expect(cached.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(1);
  });

  test("paged exploration never turns untracked, binary or symlink paths into supplied evidence", async () => {
    const repo = createCoverageRepository(7);
    writeFileSync(join(repo, "untracked.txt"), "untracked private content\n");
    writeFileSync(join(repo, "src", "coverage-binary.ts"), Buffer.from([0, 0xff, 0xfe, 0]));
    const outside = mkdtempSync(join(tmpdir(), "pushpals-coverage-outside-"));
    tempDirs.push(outside);
    writeFileSync(join(outside, "secret.txt"), "outside content must never be supplied\n");
    let linked = false;
    try {
      symlinkSync(join(outside, "secret.txt"), join(repo, "src", "coverage-link.ts"));
      linked = true;
    } catch {
      /* Windows hosts may not grant symlink creation; binary/untracked assertions still run. */
    }
    git(repo, ["add", "src"]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "unsafe coverage fixtures",
    ]);
    const base = await coverageRequest(repo);
    // Untracked files make a normal worktree dirty. Ignore the fixture without
    // staging it so the clean-snapshot paging policy is exercised explicitly.
    writeFileSync(join(repo, ".git", "info", "exclude"), "untracked.txt\n");
    const request = {
      ...base,
      repository: await resolveRepositorySnapshot(repo),
      context: {
        ...base.context,
        targetPaths: ["untracked.txt", "../outside", join(outside, "secret.txt")],
      },
    };
    const llm = new FakeLlm(emptyAutonomyResponse);
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      logger: quietLogger,
    });
    await worker.analyze("unsafe-coverage-first", request);
    await worker.analyze("unsafe-coverage-second", request);
    const packets = llm.analysisCalls.map(
      (input) => JSON.parse(input.messages[0]!.content).evidencePacket,
    );
    const files = packets.flatMap((packet) => packet.files as Array<{ path: string }>);
    expect(files.map((entry) => entry.path)).not.toContain("untracked.txt");
    expect(files.map((entry) => entry.path)).not.toContain("src/coverage-binary.ts");
    if (linked) expect(files.map((entry) => entry.path)).not.toContain("src/coverage-link.ts");
    expect(JSON.stringify(packets)).not.toContain("outside content must never be supplied");
    expect(JSON.stringify(packets)).not.toContain("untracked private content");
  });

  test.each([
    "one_sentence",
    "priorities",
    "objectives",
    "guardrails",
    "constraints",
    "non_goals",
    "testing_criteria",
    "sections",
  ])(
    "keys supplied normalized vision %s even when its claimed file hash is unchanged",
    async (field) => {
      const repo = createRepository();
      const request = await coverageRequest(repo);
      const llm = new FakeLlm();
      const worker = new RepositoryAgentWorker({
        control: unusedControl(),
        memory: new InMemoryMemoryStore(),
        llm,
        logger: quietLogger,
      });
      await worker.analyze(`vision-${field}-before`, request);
      const changed = await worker.analyze(`vision-${field}-after`, {
        ...request,
        context: {
          ...request.context,
          vision: {
            ...(request.context!.vision as any),
            [field]:
              field === "one_sentence"
                ? "Different required scope"
                : field === "sections"
                  ? [{ number: "1", title: "Different scope" }]
                  : ["Different required scope"],
          },
        },
      });
      expect(changed.cache.hit).toBe(false);
      expect(llm.analysisCalls).toHaveLength(2);
    },
  );

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
    const afterFailure = await worker.analyze("structural-after-failure", {
      ...base,
      repository: sameTreeSnapshot,
      context: {
        ...base.context,
        runtimeSignals: {
          recentObjectives: [
            {
              job_id: "failed-execution-1",
              status: "failed",
              target_paths: ["src/index.ts"],
            },
          ],
        },
      },
    });
    expect(afterFailure.cache.hit).toBe(false);
    expect(llm.analysisCalls).toHaveLength(5);
    const terminalPayload = JSON.parse(llm.analysisCalls[4]!.messages[0]!.content);
    expect(terminalPayload.request.context.runtimeSignals.recentObjectives).toEqual([
      {
        job_id: "failed-execution-1",
        status: "failed",
        target_paths: ["src/index.ts"],
        vision_objective_id: null,
        attempt_failure_fingerprint: null,
      },
    ]);
  }, 20_000);

  test("an outcome watermark prevents reuse after executed details age out of a long-lived cache", async () => {
    const repo = createRepository();
    const llm = new FakeLlm();
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
      cacheTtlMs: 7 * 24 * 60 * 60_000,
    });
    const base = await requestFor(repo, {
      context: {
        operation: "analyze_autonomy_opportunities",
        vision: { path: "vision.md", sha256: "d".repeat(64) },
        runtimeSignals: { recentObjectives: [], executedOutcomeWatermark: "a".repeat(64) },
      },
    });
    const before = await worker.analyze("watermark-before", base);
    const agedRequest = {
      ...base,
      context: {
        ...base.context,
        runtimeSignals: { recentObjectives: [], executedOutcomeWatermark: "b".repeat(64) },
      },
    };
    const aged = await worker.analyze("watermark-aged", agedRequest);
    expect(aged.cache.hit).toBe(false);
    expect(aged.memoryRefs.find((ref) => ref.role === "analysis_cache")?.key).not.toBe(
      before.memoryRefs.find((ref) => ref.role === "analysis_cache")?.key,
    );
    expect(llm.analysisCalls).toHaveLength(2);
    const repeated = await worker.analyze("watermark-repeat", agedRequest);
    expect(repeated.cache.hit).toBe(true);
    expect(llm.analysisCalls).toHaveLength(2);
  });

  test("repairs an invalid autonomy candidate contract once and never reinforces a cached analysis merely for being read", async () => {
    const repo = createRepository();
    const request = await requestFor(repo, {
      context: {
        operation: "analyze_autonomy_opportunities",
        vision: { path: "vision.md", sha256: "c".repeat(64) },
      },
    });
    const memory = new InMemoryMemoryStore();
    let generated = 0;
    const llm = new FakeLlm(() => {
      const response = modelResponse();
      if (++generated === 1) (response.data as any).candidates[0].trigger_type = "vision_priority";
      return response;
    });
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory,
      llm,
      modelId: "contract-model",
    });
    const first = await worker.analyze("contract-first", request);
    expect(generated).toBe(2);
    expect((first.data as any).candidates[0].trigger_type).toBe("regret_signal");
    expect(llm.analysisCalls[1]!.messages.at(-1)!.content).toContain("trigger_type must be one of");
    const schema = llm.analysisCalls[0]!.jsonSchema as any;
    expect(
      schema.properties.data.properties.candidates.items.properties.trigger_type.enum,
    ).not.toContain("vision_priority");
    const ref = first.memoryRefs.find((entry) => entry.role === "analysis_cache")!;
    const scope = { namespace: ref.namespace, repositoryId: request.repository.identity };
    const beforeRead = await memory.get({ scope, key: ref.key });
    const hit = await worker.analyze("contract-hit", request);
    expect(hit.cache.hit).toBe(true);
    const afterRead = await memory.get({ scope, key: ref.key });
    expect(afterRead?.confidence).toBe(beforeRead?.confidence);
    expect(afterRead?.usefulness).toBe(beforeRead?.usefulness);

    // Simulate a pre-upgrade or corrupted cached provider answer. It must be
    // rejected before cache reinforcement, then replaced by fresh valid output.
    const invalid = structuredClone(beforeRead!.value) as any;
    invalid.result.data.candidates[0].risk_level = "normal";
    await memory.put({
      scope,
      key: ref.key,
      kind: beforeRead!.kind,
      summary: beforeRead!.summary,
      value: invalid,
      confidence: beforeRead!.confidence,
      usefulness: beforeRead!.usefulness,
    });
    const repaired = await worker.analyze("contract-corrupt-cache", request);
    expect(repaired.cache.hit).toBe(false);
    expect(generated).toBe(3);
    expect((repaired.data as any).candidates[0].risk_level).toBe("low");
  }, 20_000);

  test("does not cache repeatedly invalid autonomy candidates or retry beyond the one schema repair", async () => {
    const repo = createRepository();
    const memory = new InMemoryMemoryStore();
    const llm = new FakeLlm(() => {
      const response = modelResponse();
      (response.data as any).candidates[0].objective_type = "invented_large_change";
      return response;
    });
    const worker = new RepositoryAgentWorker({ control: unusedControl(), memory, llm });
    const request = await requestFor(repo, {
      context: {
        operation: "analyze_autonomy_opportunities",
        vision: { path: "vision.md", sha256: "d".repeat(64) },
      },
    });
    const result = await worker.analyze("invalid-contract", request);
    expect(llm.analysisCalls).toHaveLength(2);
    expect(result.data).toMatchObject({ repositoryAgentMode: "deterministic_evidence_fallback" });
    expect((result.data as any).candidates).toBeUndefined();
    expect(result.cache.hit).toBe(false);
    expect(result.memoryRefs.every((ref) => ref.role === "evidence_fact")).toBe(true);
    expect(
      await memory.search({
        scope: { namespace: "repository_agent_cache", repositoryId: request.repository.identity },
      }),
    ).toEqual([]);
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

  test("shares packet capacity across large files and a later small implementation", async () => {
    const repo = createRepository();
    const largePaths = ["a", "b", "c", "d", "e", "f"].map((name) => `src/large-${name}.ts`);
    for (const path of largePaths) {
      writeFileSync(
        join(repo, path),
        Array.from(
          { length: 900 },
          (_, index) => `// row ${index}: ${"neutral data ".repeat(8)}`,
        ).join("\n"),
      );
    }
    const implementationPath = "src/z-implementation.ts";
    writeFileSync(join(repo, implementationPath), "export const verifiedImplementation = true;\n");
    git(repo, ["add", "."]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "large evidence fixture",
    ]);
    const llm = new FakeLlm(() =>
      modelResponse({ evidence: [{ path: implementationPath, startLine: 1, endLine: 1 }] }),
    );
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
    });
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Inspect the supplied exact source coordinates.",
      context: { targetPaths: [...largePaths, implementationPath] },
    });
    const result = await worker.analyze("fair-evidence", request);
    const packet = JSON.parse(llm.analysisCalls[0]!.messages[0]!.content).evidencePacket;
    expect(packet.files.map((entry: { path: string }) => entry.path)).toContain(implementationPath);
    expect(
      packet.files.find((entry: { path: string }) => entry.path === implementationPath).content,
    ).toContain("verifiedImplementation");
    expect(
      packet.files.reduce(
        (bytes: number, entry: { content: string }) =>
          bytes + Buffer.byteLength(entry.content, "utf8"),
        0,
      ),
    ).toBeLessThanOrEqual(64_000);
    expect(
      packet.files.every(
        (entry: { content: string }) => Buffer.byteLength(entry.content, "utf8") <= 16 * 1024,
      ),
    ).toBe(true);
    expect(result.evidence[0]?.path).toBe(implementationPath);
    expect(llm.analysisCalls).toHaveLength(1);
    expect(llm.discoveryCalls).toHaveLength(0);
  });

  test("validates original-line window citations and rejects gaps or a truncated scan suffix", async () => {
    const repo = createRepository();
    const path = "src/scheduler.ts";
    const lines = Array.from(
      { length: 1_600 },
      (_, index) => `// row ${index + 1}: ${"neutral data ".repeat(9)}`,
    );
    lines[611] = "export function reconcileSchedulingLease() { return recoverLostClaim(); }";
    writeFileSync(join(repo, path), lines.join("\r\n"));
    git(repo, ["add", path]);
    git(repo, [
      "-c",
      "user.name=PushPals Test",
      "-c",
      "user.email=pushpals@example.invalid",
      "commit",
      "-m",
      "window citation fixture",
    ]);
    const request = await requestFor(repo, {
      freshness: "fresh_required",
      question: "Inspect reconcileSchedulingLease and recoverLostClaim in src/scheduler.ts.",
      context: { targetPaths: [path] },
    });
    let citedStart = 612;
    let citedEnd = 612;
    let packetFile:
      | {
          content: string;
          scanTruncated: boolean;
          lineRanges: Array<{ startLine: number; endLine: number }>;
        }
      | undefined;
    const llm: LLMClient = {
      async generate(input) {
        packetFile = JSON.parse(input.messages[0]!.content).evidencePacket.files.find(
          (entry: { path: string }) => entry.path === path,
        );
        return {
          text: JSON.stringify(
            modelResponse({ evidence: [{ path, startLine: citedStart, endLine: citedEnd }] }),
          ),
        };
      },
    };
    const worker = new RepositoryAgentWorker({
      control: unusedControl(),
      memory: new InMemoryMemoryStore(),
      llm,
    });
    const valid = await worker.analyze("valid-window", request);
    expect(valid.evidence[0]?.excerpt).toBe(lines[611]);
    expect(packetFile?.content).toContain(lines[611]!);
    expect(packetFile?.scanTruncated).toBe(true);
    const ranges = packetFile!.lineRanges;
    const gap = ranges.find(
      (range, index) => index > 0 && range.startLine > ranges[index - 1]!.endLine + 1,
    )!;
    expect(gap).toBeDefined();
    citedStart = gap.startLine - 1;
    citedEnd = gap.startLine;
    await expect(worker.analyze("gap-window", request)).rejects.toThrow(
      "did not contain any current, tracked repository evidence",
    );
    citedStart = 1_600;
    citedEnd = 1_600;
    await expect(worker.analyze("unscanned-window", request)).rejects.toThrow(
      "did not contain any current, tracked repository evidence",
    );
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
