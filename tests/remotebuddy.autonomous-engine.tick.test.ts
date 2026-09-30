import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  autonomyIntegrationBaselineDecision,
  AUTONOMY_EXHAUSTED_DISCOVERY_RECHECK_MS,
  exhaustedDiscoveryKey,
  filterCandidatesForWorkDiversity,
  isExecutedAutonomyImplementationOutcome,
  RemoteBuddyAutonomousEngine,
  resolveAutonomyGitCommandTimeoutMs,
  workDiversityPenaltyForCandidate,
} from "../apps/remotebuddy/src/autonomous_engine";
import {
  REPOSITORY_AGENT_SCHEMA_VERSION,
  resolveRepositorySnapshot,
  type RepositoryAgentAskOptions,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RepositoryAgentSubmitInput,
  type RepositoryAgentWorkerControl,
} from "../packages/shared/src";
import { RepositoryAgentWorker } from "../apps/remotebuddy/src/repository_agent";
import type { LLMGenerateInput } from "../apps/remotebuddy/src/llm";
import { AutonomyStore } from "../apps/server/src/autonomy";
import { JobQueue } from "../apps/server/src/jobs";
import { CompletionQueue } from "../apps/server/src/completions";
import { RequestQueue } from "../apps/server/src/requests";
import { SqliteMemoryStore } from "../apps/server/src/memory_store";

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

const tempDirs: string[] = [];
let originalFetch: typeof globalThis.fetch;
let originalSpawn: typeof Bun.spawn;

describe("autonomy integration baseline", () => {
  test("gives network Git a longer deadline than local worktree inspection", () => {
    expect(resolveAutonomyGitCommandTimeoutMs(["status", "--porcelain"])).toBe(30_000);
    expect(resolveAutonomyGitCommandTimeoutMs(["fetch", "origin", "main"])).toBe(120_000);
  });

  test("terminates and returns from a stalled autonomy Git command", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-git-deadline-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_git_deadline",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    let resolveExit: (code: number) => void = () => undefined;
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let finished = false;
    const finishTarget = () => {
      if (finished) return;
      finished = true;
      stdoutController?.close();
      stderrController?.close();
      resolveExit(137);
    };
    const target = {
      pid: 2_147_480_000,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill: finishTarget,
    };
    originalSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[]) => {
      if (cmd[0] === "git") return target;
      if (cmd[0] === "taskkill") {
        finishTarget();
        return {
          pid: 2_147_480_001,
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          kill() {},
        };
      }
      return originalSpawn(cmd as any);
    };
    const startedAt = Date.now();

    const result = await (engine as any).runGit(root, ["status", "--porcelain"], 20);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out after 20ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("keeps integration context both when it contains main and while SCM reconciles divergence", () => {
    expect(
      autonomyIntegrationBaselineDecision({
        fastForwardSucceeded: false,
        integrationContainsBase: true,
      }),
    ).toBe("use_integration_head");
    expect(
      autonomyIntegrationBaselineDecision({
        fastForwardSucceeded: false,
        integrationContainsBase: false,
      }),
    ).toBe("use_integration_head");
  });

  test("prepares the integration-head worktree and continues when integration truly diverges", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-divergence-"));
    tempDirs.push(root);
    const commands: string[][] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message ?? ""));

    try {
      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "s_diverged",
        authToken: "tok",
        repo: root,
        llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
        comm: { async emit() {} } as any,
        config: makeConfig(),
      });
      (engine as any).runGit = async (_cwd: string, args: string[]) => {
        commands.push([...args]);
        if (args[0] === "merge" && args[1] === "--ff-only") {
          return { ok: false, exitCode: 1, stdout: "", stderr: "not possible to fast-forward" };
        }
        if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
          return { ok: false, exitCode: 1, stdout: "", stderr: "" };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      };

      const ready = await (engine as any).ensureAutonomyRepoReady("run_diverged");

      expect(ready).toBe(true);
      expect(
        commands.some(
          (args) =>
            args[0] === "worktree" && args[1] === "add" && args.at(-1) === "origin/main_agents",
        ),
      ).toBe(true);
      expect(
        commands.some(
          (args) =>
            args[0] === "merge-base" &&
            args.includes("origin/main") &&
            args.includes("origin/main_agents"),
        ),
      ).toBe(true);
      expect(commands.some((args) => args[0] === "reset")).toBe(false);
      expect(
        warnings.some((message) => message.includes("Continuing from the integration head")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("reads fresh vision priorities from the prepared autonomy worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-vision-worktree-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_vision_worktree",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const autonomyRepo = String((engine as any).autonomyRepo);
    mkdirSync(autonomyRepo, { recursive: true });
    writeFileSync(
      join(autonomyRepo, "vision.md"),
      "# Vision\n\n## Priorities\n- Improve import recovery\n",
      "utf8",
    );
    const initial = (engine as any).loadVisionContext("run_vision_initial");

    writeFileSync(
      join(autonomyRepo, "vision.md"),
      "# Vision\n\n## Priorities\n- Improve semantic search ranking\n",
      "utf8",
    );
    const refreshed = (engine as any).loadVisionContext("run_vision_refreshed");

    expect(initial?.key_items?.priorities).toEqual(["Improve import recovery"]);
    expect(refreshed?.key_items?.priorities).toEqual(["Improve semantic search ranking"]);
    expect(refreshed?.sha256).not.toBe(initial?.sha256);
  });
});

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfig(): any {
  return {
    workerpals: {
      executionPlatform: "auto",
    },
    sourceControlManager: {
      remote: "origin",
      mainBranch: "main_agents",
      baseBranch: "main",
    },
    remotebuddy: {
      workerpalDocker: true,
      llm: {
        backend: "openai_codex",
        endpoint: "http://127.0.0.1:1234",
        model: "gpt-6-astra",
        sessionId: "remotebuddy-dev",
        apiKey: "",
        reasoningEffort: "xhigh",
        codexAuthMode: "chatgpt",
        codexBin: "bun x --yes @openai/codex",
        codexTimeoutMs: 120_000,
      },
      autonomy: {
        enabled: true,
        tickIntervalMs: 120_000,
        heartbeatLogMs: 30_000,
        visionContextMaxChars: 65_536,
        ideationBudgetMs: 20_000,
        llmTimeoutMs: 12_000,
        allowDirtyWorktree: true,
        ideationMaxCandidates: 12,
        topK: 1,
        exploreRate: 0,
        minConfidence: 0.6,
        maxConcurrentObjectives: 2,
        maxDispatchPerHour: 6,
        maxDispatchPerHourByType: {
          flaky_test: 4,
          lint_fix: 3,
          type_fix: 3,
          small_refactor: 2,
          feature_small: 2,
          feature_medium: 1,
          feature_large: 0,
          docs: 1,
          dep_bump: 0,
        },
        cooldownFailStreakThreshold: 2,
        cooldownMs: 1_800_000,
        allowReadAnywhere: true,
        prFeedbackCommentRows: 16,
        prFeedbackCommentChars: 600,
        prFeedbackSummaryChars: 600,
        questionTtlMs: 259_200_000,
        policyVersion: "policy-v3.3",
        impactModelVersion: "impact-v1",
        replay: {
          storePromptPayloads: false,
          maxRunsWithPayloads: 50,
          maxPayloadBytes: 262_144,
        },
      },
    },
  };
}

function makeSnapshot() {
  return {
    snapshot_id: "snap_tick_1",
    snapshot_created_at: new Date().toISOString(),
    snapshot_ttl_ms: 120_000,
    impact_model_version: "impact-v1",
    top_signals: [
      { signal_id: "sig_queue", type: "queue_health", value: 0.8, evidence: "p95 high" },
    ],
    state_traits: [
      {
        trait_id: "queue_latency_high",
        category: "weakness",
        focus: "queue",
        score: 0.7,
        evidence: "p95 high",
      },
    ],
    feedback_priors: [],
    engine_idea_priors: [],
    engine_source_priors: [],
    active_cooldowns: [],
    open_objectives: [],
    repo_health_flags: {
      is_worktree_dirty: false,
      is_merge_in_progress: false,
      dispatch_lock_held: false,
    },
    dispatch_budget: {
      global_count_last_hour: 0,
      by_type_count_last_hour: {},
    },
  };
}

describe("autonomy two-phase dispatch fencing", () => {
  const dispatchInput = (snapshot: ReturnType<typeof makeSnapshot>, signal?: AbortSignal) => ({
    objectiveId: "obj-two-phase",
    runId: "run-two-phase",
    snapshotId: snapshot.snapshot_id,
    patternKey: "two-phase",
    componentArea: "apps/server",
    targetPaths: ["apps/server/src/requests.ts"],
    writeGlobs: ["apps/server/src/*.ts"],
    dispatchFence: {
      snapshot,
      cycleDeadline: Date.now() + 30_000,
      signal,
    },
  });

  test("does not confirm a provisional request when autonomy is disabled after enqueue", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dispatch-disable-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dispatch_disable",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const calls: string[] = [];
    (engine as any).fetchControl = async (url: string) => {
      calls.push(url);
      engine.setRuntimeEnabled(false);
      return jsonResponse(201, {
        ok: true,
        requestId: "request-provisional-disabled",
        dispatchConfirmationRequired: true,
        dispatchConfirmationToken: "confirmation-disabled",
      });
    };

    const requestId = await (engine as any).enqueueSyntheticRequest(
      "Fix the queue race.",
      dispatchInput(makeSnapshot()),
    );

    expect(requestId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEndWith("/requests/enqueue");
  });

  test("does not confirm a provisional request after its snapshot expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dispatch-expiry-"));
    tempDirs.push(root);
    const snapshot = makeSnapshot();
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dispatch_expiry",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const calls: string[] = [];
    (engine as any).fetchControl = async (url: string) => {
      calls.push(url);
      snapshot.snapshot_ttl_ms = 0;
      snapshot.snapshot_created_at = new Date(Date.now() - 1_000).toISOString();
      return jsonResponse(201, {
        ok: true,
        requestId: "request-provisional-expired",
        dispatchConfirmationRequired: true,
        dispatchConfirmationToken: "confirmation-expired",
      });
    };

    const requestId = await (engine as any).enqueueSyntheticRequest(
      "Fix the snapshot race.",
      dispatchInput(snapshot),
    );

    expect(requestId).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("fails closed when a stale server omits dispatch confirmation attestation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dispatch-stale-server-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dispatch_stale_server",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const calls: string[] = [];
    (engine as any).fetchControl = async (url: string) => {
      calls.push(url);
      return jsonResponse(201, {
        ok: true,
        requestId: "request-from-stale-server",
      });
    };

    const requestId = await (engine as any).enqueueSyntheticRequest(
      "Do not trust a mixed-version server.",
      dispatchInput(makeSnapshot()),
    );

    expect(requestId).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("accepts an explicit attestation for an already-confirmed idempotent replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dispatch-replay-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dispatch_replay",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const calls: string[] = [];
    (engine as any).fetchControl = async (url: string) => {
      calls.push(url);
      return jsonResponse(201, {
        ok: true,
        requestId: "request-confirmed-replay",
        dispatchConfirmed: true,
      });
    };

    const requestId = await (engine as any).enqueueSyntheticRequest(
      "Reuse the exact confirmed dispatch.",
      dispatchInput(makeSnapshot()),
    );

    expect(requestId).toBe("request-confirmed-replay");
    expect(calls).toHaveLength(1);
  });

  test.each(["transport", "invalid_json", "ok_false", "confirm_http", "confirm_invalid"])(
    "backs off failed two-phase handoffs without exposing payloads: %s",
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-handoff-failure-"));
      tempDirs.push(root);
      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "s_handoff",
        authToken: "tok",
        repo: root,
        llm: {} as any,
        comm: { async emit() {} } as any,
        config: makeConfig(),
      });
      (engine as any).fetchControl = async (url: string) => {
        if (failure === "transport") throw new Error("secret=DO_NOT_LOG");
        if (failure === "invalid_json") return new Response("DO_NOT_LOG", { status: 200 });
        if (failure === "ok_false") return jsonResponse(200, { ok: false });
        if (url.endsWith("/requests/enqueue"))
          return jsonResponse(201, {
            ok: true,
            requestId: "provisional-request",
            dispatchConfirmationRequired: true,
            dispatchConfirmationToken: "DO_NOT_LOG",
          });
        return failure === "confirm_http"
          ? new Response("DO_NOT_LOG", { status: 503 })
          : jsonResponse(200, { ok: true, confirmed: false });
      };
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        const input = dispatchInput(makeSnapshot());
        (input as any).privateData = "DO_NOT_LOG";
        const started = Date.now();
        expect(await (engine as any).enqueueSyntheticRequest("DO_NOT_LOG", input)).toBeNull();
        expect((engine as any).dispatchBackoffUntilMs).toBeGreaterThanOrEqual(started + 300_000);
        const expected =
          failure === "transport"
            ? "enqueue_transport_error"
            : failure === "confirm_http"
              ? "dispatch_confirmation_rejected"
              : failure === "confirm_invalid"
                ? "dispatch_confirmation_invalid"
                : "enqueue_response_invalid";
        expect((engine as any).lastEnqueueRejectionReason).toEndWith(`:${expected}`);
        expect(warnings.join("\n")).not.toContain("DO_NOT_LOG");
      } finally {
        console.warn = originalWarn;
        engine.stop();
      }
    },
  );

  test("confirms and returns a provisional request while the cycle fence remains live", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dispatch-confirm-"));
    tempDirs.push(root);
    const snapshot = makeSnapshot();
    const controller = new AbortController();
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dispatch_confirm",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (engine as any).fetchControl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/requests/enqueue")) {
        return jsonResponse(201, {
          ok: true,
          requestId: "request-provisional-live",
          dispatchConfirmationRequired: true,
          dispatchConfirmationToken: "confirmation-live",
        });
      }
      return jsonResponse(200, {
        ok: true,
        requestId: "request-provisional-live",
        confirmed: true,
      });
    };

    const requestId = await (engine as any).enqueueSyntheticRequest(
      "Fix the live dispatch.",
      dispatchInput(snapshot, controller.signal),
    );

    expect(requestId).toBe("request-provisional-live");
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:3001/requests/enqueue",
      "http://localhost:3001/requests/request-provisional-live/dispatch/confirm",
    ]);
    expect(calls.every((call) => call.init?.signal === controller.signal)).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      dispatchConfirmationRequired: true,
      dispatchConfirmationTtlMs: expect.any(Number),
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      dispatchConfirmationToken: "confirmation-live",
    });
  });
});

describe("RepositoryAgent autonomy ideation", () => {
  test("asks the shared RepositoryAgent to inspect the exact repo before legacy ideation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-repository-agent-"));
    tempDirs.push(root);
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "PushPals Test"], { cwd: root });
    writeFileSync(join(root, "vision.md"), "# Vision\n\n## Priorities\n- Improve startup\n");
    writeFileSync(join(root, "service.ts"), "export const ready = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
    writeFileSync(join(root, "service.ts"), "export const ready = false;\n");
    const expectedRepository = await resolveRepositorySnapshot(root);

    let submitted: Record<string, unknown> | null = null;
    let returnEmpty = false;
    let exhausted = false;
    let nextWindowAvailable = false;
    let askCalls = 0;
    const repositoryAgent = {
      async ask(input: Record<string, unknown>) {
        askCalls++;
        submitted = input;
        const repository = input.repository as Record<string, unknown>;
        return {
          schemaVersion: 1,
          requestId: "repo-request-1",
          analyzedRepository: {
            identity: repository.identity,
            revision: repository.revision,
            tree: repository.tree,
          },
          answer: "One grounded candidate",
          summary: "Startup is the highest vision priority.",
          data: {
            candidates: returnEmpty
              ? []
              : [
                  {
                    id: "candidate-startup",
                    title: "Improve startup readiness",
                    objective_type: "feature_small",
                    problem_statement: "Make startup readiness explicit.",
                    trigger_type: "queue_health",
                    component_area: "service.ts",
                    target_paths: ["service.ts"],
                    scope: { read_anywhere: true, write_globs: ["service.ts"] },
                    risk_level: "low",
                    expected_validation: ["git diff --check"],
                    estimated_effort: "small",
                    why_now_signal_ids: ["sig_queue"],
                    confidence: 0.9,
                    vision_alignment_reason: "Directly supports the top priority.",
                    vision_section_refs: ["1"],
                    feature_hypotheses: ["Explicit readiness reduces startup failures."],
                  },
                ],
          },
          confidence: 0.9,
          discoveryProgress: {
            page: 1,
            pageCount: 3,
            advanced: true,
            boundedCoverageExhausted: exhausted,
            ...(nextWindowAvailable ? { nextWindowAvailable: true } : {}),
            retryEligible: true,
            excludedCandidateCount: 1,
          },
          evidence: [
            { path: "service.ts", revision: repository.revision, rationale: "startup owner" },
          ],
          recommendations: [],
          validationProposals: [],
          cache: { hit: false, key: "cache-1" },
          memoryRefs: [{ id: "memory-1", namespace: "repository_fact", role: "analysis_cache" }],
          completedAt: new Date().toISOString(),
        };
      },
    };
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_repository_agent",
      authToken: "tok",
      repo: root,
      llm: { generate: async () => ({ text: "{}" }) },
      repositoryAgent: repositoryAgent as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).autonomyRepo = root;
    const ideationInput = {
      runId: "run-repository-agent",
      snapshot: makeSnapshot(),
      visionContext: {
        path: "vision.md",
        markdown: "# Vision",
        one_sentence: "Improve startup",
        sections: [{ number: "1", title: "Priorities", markdown: "Improve startup" }],
        key_items: {
          target_users: [],
          priorities: ["Improve startup"],
          objectives: [],
          guardrails: [],
          constraints: [],
          non_goals: [],
          metrics: [],
          testing_criteria: [],
          risk_policy: [],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["1"],
        sha256: "vision-hash",
        truncated: false,
      },
      cycleDeadline: Date.now() + 30_000,
    };
    const result = await (engine as any).repositoryAgentIdeation(ideationInput);

    expect(result?.json.candidates).toHaveLength(1);
    expect(result?.llmCall.provider).toBe("repository_agent");
    expect((submitted?.repository as Record<string, unknown>).root).toBe(root);
    expect((submitted?.repository as Record<string, unknown>).dirty).toBe(true);
    expect((submitted?.repository as Record<string, unknown>).tree).toBe(expectedRepository.tree);
    expect((submitted?.context as Record<string, unknown>).operation).toBe(
      "analyze_autonomy_opportunities",
    );
    expect((submitted?.context as Record<string, unknown>).runtimeSignals).toMatchObject({
      recentObjectives: [],
      openObjectives: [],
    });
    const policy = (submitted?.context as Record<string, unknown>).deterministicPolicy as {
      notes: string[];
    };
    expect(policy.notes).toHaveLength(8);
    expect(policy.notes[6]).toContain("non-goals and excluded scope are prohibitions");
    expect(policy.notes[7]).toContain("data.candidates=[]");
    expect(String(submitted?.idempotencyKey)).toContain("snap_tick_1");
    expect(JSON.stringify(submitted)).not.toContain("repo_targets");

    returnEmpty = true;
    const empty = await (engine as any).repositoryAgentIdeation({
      ...ideationInput,
      snapshot: {
        ...makeSnapshot(),
        open_objectives: [
          {
            status: "running",
            target_paths: ["src/active.ts", "src/**"],
            scope: { write_globs: ["**"], targetPaths: ["src/scoped.ts"] },
          },
        ],
        recent_objectives: [
          {
            job_id: "setup-only",
            status: "failed",
            execution_started: false,
            failure_class: "docker_engine",
            target_paths: ["src/setup-only.ts"],
            updated_at: new Date().toISOString(),
          },
          {
            status: "completed",
            target_paths: ["src/recent.ts"],
            updated_at: new Date().toISOString(),
          },
          {
            status: "completed",
            target_paths: ["src/old.ts"],
            updated_at: "2000-01-01T00:00:00.000Z",
          },
        ],
        executed_objectives: [
          {
            job_id: "setup-only",
            status: "failed",
            execution_started: false,
            failure_class: "docker_engine",
          },
          {
            job_id: "code-started",
            status: "failed",
            execution_started: true,
            failure_class: "docker_engine",
          },
          { job_id: "legacy", status: "failed" },
        ],
      },
    });
    expect((submitted?.context as Record<string, unknown>).discoveryExclusions).toEqual({
      targetPaths: ["src/active.ts", "src/scoped.ts", "src/recent.ts"],
    });
    expect(empty.result).toBeNull();
    expect(empty.llmCall.memoryRefs).toEqual([]);
    expect(empty.discoveryProgress).toEqual({
      page: 1,
      pageCount: 3,
      advanced: true,
      boundedCoverageExhausted: false,
      retryEligible: true,
      excludedCandidateCount: 1,
    });
    expect(
      ((submitted?.context as any).runtimeSignals.recentObjectives as any[]).map(
        (row) => row.job_id,
      ),
    ).toEqual(["code-started", "legacy"]);

    exhausted = true;
    nextWindowAvailable = true;
    await (engine as any).repositoryAgentIdeation(ideationInput);
    expect((engine as any).exhaustedDiscovery).toBeNull();
    nextWindowAvailable = false;
    await (engine as any).repositoryAgentIdeation(ideationInput);
    const firstRecheckAt = (engine as any).exhaustedDiscovery.recheckAtMs;
    expect(firstRecheckAt - Date.now()).toBeGreaterThan(
      AUTONOMY_EXHAUSTED_DISCOVERY_RECHECK_MS - 1_000,
    );
    const callsAtExhaustion = askCalls;
    const paused = await (engine as any).repositoryAgentIdeation({
      ...ideationInput,
      snapshot: { ...ideationInput.snapshot, snapshot_id: "new-observation" },
    });
    expect(paused.deferred).toBe(true);
    expect(askCalls).toBe(callsAtExhaustion);
    expect((engine as any).exhaustedDiscovery.recheckAtMs).toBe(firstRecheckAt);

    (engine as any).exhaustedDiscovery.recheckAtMs = Date.now();
    expect((await (engine as any).repositoryAgentIdeation(ideationInput)).deferred).toBeUndefined();
    expect(askCalls).toBe(callsAtExhaustion + 1);
    writeFileSync(join(root, "service.ts"), "export const ready = 'changed evidence';\n");
    expect((await (engine as any).repositoryAgentIdeation(ideationInput)).deferred).toBeUndefined();
    expect(askCalls).toBe(callsAtExhaustion + 2);
    engine.stop();
  }, 30_000);

  test("cancels in-flight repository ideation when autonomy is disabled and returns deterministic fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-repository-agent-abort-"));
    tempDirs.push(root);
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "PushPals Test"], { cwd: root });
    writeFileSync(join(root, "vision.md"), "# Vision\n\n## Priorities\n- Stay responsive\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });

    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let legacyCalls = 0;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_repository_agent_abort",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          legacyCalls++;
          return { text: "{}" };
        },
      },
      repositoryAgent: {
        async ask(_input: unknown, options: { signal?: AbortSignal }) {
          observedSignal = options.signal;
          markStarted?.();
          return await new Promise((_resolve, reject) => {
            const onAbort = () => reject(options.signal?.reason ?? new Error("aborted"));
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted) onAbort();
          });
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).autonomyRepo = root;
    const pending = (engine as any).repositoryAgentIdeation({
      runId: "run-repository-agent-abort",
      snapshot: makeSnapshot(),
      visionContext: {
        path: "vision.md",
        markdown: "# Vision",
        one_sentence: "Stay responsive",
        sections: [{ number: "1", title: "Priorities", markdown: "Stay responsive" }],
        key_items: {
          target_users: [],
          priorities: ["Stay responsive"],
          objectives: [],
          guardrails: [],
          constraints: [],
          non_goals: [],
          metrics: [],
          testing_criteria: [],
          risk_policy: [],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["1"],
        sha256: "vision-abort-hash",
        truncated: false,
      },
      cycleDeadline: Date.now() + 30_000,
    });
    await started;
    engine.setRuntimeEnabled(false);
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result).not.toBeNull();
    expect(result?.json.candidates).toEqual([]);
    expect(result?.llmCall.provider).toBe("repository_agent_deterministic_fallback");
    expect(legacyCalls).toBe(0);
  });

  test("installs repository ideation cancellation before snapshot discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-repository-snapshot-abort-"));
    tempDirs.push(root);
    let markGitStarted: (() => void) | null = null;
    const gitStarted = new Promise<void>((resolveStarted) => {
      markGitStarted = resolveStarted;
    });
    let resolveExit: (code: number) => void = () => undefined;
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let killed = false;
    const finish = () => {
      if (killed) return;
      killed = true;
      stdoutController?.close();
      stderrController?.close();
      resolveExit(137);
    };
    const stalledGit = {
      pid: 2_147_480_100,
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill: finish,
    };
    originalSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[]) => {
      if (cmd[0] === "git") {
        markGitStarted?.();
        return stalledGit;
      }
      if (cmd[0] === "taskkill") {
        finish();
        return {
          pid: 2_147_480_101,
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          kill() {},
        };
      }
      return originalSpawn(cmd as any);
    };
    let askCalls = 0;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_repository_snapshot_abort",
      authToken: "tok",
      repo: root,
      llm: { generate: async () => ({ text: "{}" }) },
      repositoryAgent: {
        async ask() {
          askCalls++;
          throw new Error("ask must not start after snapshot cancellation");
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).autonomyRepo = root;
    const pending = (engine as any).repositoryAgentIdeation({
      runId: "run-repository-snapshot-abort",
      snapshot: makeSnapshot(),
      visionContext: {
        path: "vision.md",
        markdown: "# Vision",
        one_sentence: "Stay responsive",
        sections: [{ number: "1", title: "Priorities", markdown: "Stay responsive" }],
        key_items: {
          target_users: [],
          priorities: ["Stay responsive"],
          objectives: [],
          guardrails: [],
          constraints: [],
          non_goals: [],
          metrics: [],
          testing_criteria: [],
          risk_policy: [],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["1"],
        sha256: "vision-snapshot-abort-hash",
        truncated: false,
      },
      cycleDeadline: Date.now() + 30_000,
    });
    await gitStarted;

    engine.setRuntimeEnabled(false);
    const result = await pending;

    expect(killed).toBe(true);
    expect(askCalls).toBe(0);
    expect(result?.llmCall.provider).toBe("repository_agent_deterministic_fallback");
  });
});

function mockGitSpawnForTest(): void {
  originalSpawn = Bun.spawn;
  (Bun as any).spawn = (cmd: string[], opts?: unknown) => {
    if (Array.isArray(cmd) && cmd[0] === "git") {
      const args = cmd.slice(1).join(" ");
      const exitCode = /rev-parse -q --verify MERGE_HEAD/.test(args) ? 1 : 0;
      const stdoutText = "";
      const stderrText = "";
      return {
        stdout: new Response(stdoutText).body,
        stderr: new Response(stderrText).body,
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    }
    return originalSpawn(cmd as any, opts as any);
  };
}

function mockGitSpawnWithDirtyWorktree(): void {
  originalSpawn = Bun.spawn;
  (Bun as any).spawn = (cmd: string[], opts?: unknown) => {
    if (Array.isArray(cmd) && cmd[0] === "git") {
      const args = cmd.slice(1).join(" ");
      if (/status --porcelain/.test(args)) {
        return {
          stdout: new Response(" M apps/server/src/autonomy.ts\n").body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
          kill() {},
        };
      }
      const exitCode = /rev-parse -q --verify MERGE_HEAD/.test(args) ? 1 : 0;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(exitCode),
        kill() {},
      };
    }
    return originalSpawn(cmd as any, opts as any);
  };
}

function seedPushpalsAutonomyRepoLayout(root: string): void {
  const markers = [
    "apps/server/src/autonomy.ts",
    "apps/remotebuddy/src/autonomous_engine.ts",
    "apps/workerpals/src/workerpals_main.ts",
    "packages/shared/src/autonomy_policy.ts",
  ];
  for (const marker of markers) {
    const fullPath = join(root, marker);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, "// test fixture\n", "utf8");
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.14", scripts: { "test:root": "bun test" } }),
    "utf8",
  );
  writeFileSync(join(root, "bun.lock"), "", "utf8");
}

function seedGenericAutonomyRepoLayout(root: string): void {
  const markers = ["src/autonomy.ts", "src/queue.ts", "tests/autonomy.test.ts", "README.md"];
  for (const marker of markers) {
    const fullPath = join(root, marker);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, "// generic repo fixture\n", "utf8");
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  if (originalSpawn) {
    (Bun as any).spawn = originalSpawn;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const durableDiscoveryProgress = {
  page: 1,
  pageCount: 3,
  advanced: true,
  boundedCoverageExhausted: false,
  retryEligible: true,
  excludedCandidateCount: 0,
};

describe("exhausted discovery evidence and eligibility key", () => {
  const nowMs = Date.parse("2026-09-30T12:00:00.000Z");
  function input(): Parameters<typeof exhaustedDiscoveryKey>[0] {
    return {
      repository: { identity: "repo", revision: "revision", tree: "tree" },
      context: {
        vision: { sha256: "vision" },
        deterministicPolicy: { maxCandidates: 3 },
        discoveryExclusions: { targetPaths: ["src/a.ts", "src/b.ts"] },
        runtimeSignals: { recentObjectives: [], executedOutcomeWatermark: "outcomes" },
      },
      snapshot: makeSnapshot() as any,
      config: makeConfig().remotebuddy.autonomy,
      nowMs,
    };
  }

  test("ignores observation timestamps, ordering and transient health noise", () => {
    const before = input();
    const after = input();
    after.snapshot.snapshot_id = "another-snapshot";
    after.snapshot.snapshot_created_at = new Date(nowMs + 60_000).toISOString();
    after.snapshot.top_signals = [
      { signal_id: "queue", type: "queue", value: 2, evidence: "noise" },
    ];
    after.context.discoveryExclusions = { targetPaths: ["src/b.ts", "src/a.ts", "src/a.ts"] };
    expect(exhaustedDiscoveryKey(after)).toBe(exhaustedDiscoveryKey(before));
  });

  test.each([
    "tree",
    "revision",
    "vision",
    "policy",
    "exclusion_added",
    "exclusion_removed",
    "outcome",
    "cooldown",
    "budget",
  ])("resumes on a relevant %s change", (change) => {
    const before = input();
    const after = input();
    if (change === "tree" || change === "revision") after.repository[change] = "changed";
    if (change === "vision") after.context.vision = { sha256: "changed" };
    if (change === "policy") after.context.deterministicPolicy = { maxCandidates: 1 };
    if (change === "exclusion_added")
      after.context.discoveryExclusions = { targetPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] };
    if (change === "exclusion_removed")
      after.context.discoveryExclusions = { targetPaths: ["src/a.ts"] };
    if (change === "outcome")
      after.context.runtimeSignals = { executedOutcomeWatermark: "changed" };
    if (change === "cooldown")
      after.snapshot.active_cooldowns = [
        { pattern_key: "candidate", cooldown_until: new Date(nowMs + 1).toISOString() },
      ];
    if (change === "budget") {
      before.config.maxDispatchPerHourByType = { small_refactor: 2 };
      after.config.maxDispatchPerHourByType = { small_refactor: 2 };
      after.snapshot.dispatch_budget.by_type_count_last_hour = { small_refactor: 2 };
    }
    expect(exhaustedDiscoveryKey(after)).not.toBe(exhaustedDiscoveryKey(before));
  });

  test("cooldown expiry resumes without a new server event", () => {
    const before = input();
    before.snapshot.active_cooldowns = [
      { pattern_key: "candidate", cooldown_until: new Date(nowMs + 1).toISOString() },
    ];
    expect(exhaustedDiscoveryKey({ ...before, nowMs: nowMs + 1 })).not.toBe(
      exhaustedDiscoveryKey(before),
    );
  });

  test("excludes only explicitly unstarted infrastructure failures from implementation evidence", () => {
    for (const failure_class of [
      "infra",
      "docker_engine",
      "docker_infrastructure",
      "environment.missing_tool",
    ]) {
      const outcome = {
        job_id: "failed-job",
        status: "failed",
        execution_started: false,
        failure_class,
      };
      expect(isExecutedAutonomyImplementationOutcome(outcome)).toBe(false);
      expect(isExecutedAutonomyImplementationOutcome({ ...outcome, execution_started: true })).toBe(
        true,
      );
      expect(
        isExecutedAutonomyImplementationOutcome({ ...outcome, execution_started: undefined }),
      ).toBe(true);
    }
    expect(isExecutedAutonomyImplementationOutcome({ job_id: "legacy", status: "failed" })).toBe(
      true,
    );
    expect(
      isExecutedAutonomyImplementationOutcome({
        job_id: "code",
        status: "failed",
        execution_started: false,
        failure_class: "code",
      }),
    ).toBe(true);
    expect(isExecutedAutonomyImplementationOutcome({ status: "failed" })).toBe(false);
    expect(isExecutedAutonomyImplementationOutcome({ job_id: "running", status: "running" })).toBe(
      false,
    );
  });
});

describe("setup-only infrastructure work diversity", () => {
  test("recovered capacity can retry untouched targets without a six-hour penalty", () => {
    const candidate = {
      id: "candidate",
      objective_type: "small_refactor",
      component_area: "src",
      target_paths: ["src/a.ts"],
    };
    const objective = {
      objective_id: "objective",
      pattern_key: "pattern",
      job_id: "job",
      status: "failed",
      execution_started: false,
      failure_class: "docker_engine",
      target_paths: ["src/a.ts"],
      updated_at: new Date().toISOString(),
    };
    const options = { rows: [{ candidate }], recentObjectives: [objective] };
    expect(filterCandidatesForWorkDiversity(options).rows).toHaveLength(1);
    expect(
      workDiversityPenaltyForCandidate({ candidate, recentObjectives: [objective] }),
    ).toBeNull();
    for (const retained of [
      { ...objective, execution_started: true },
      { ...objective, execution_started: undefined },
      { ...objective, failure_class: "code" },
    ]) {
      expect(
        filterCandidatesForWorkDiversity({ ...options, recentObjectives: [retained] }).rows,
      ).toHaveLength(0);
      expect(
        workDiversityPenaltyForCandidate({ candidate, recentObjectives: [retained] }),
      ).not.toBeNull();
    }
  });
});

function healthyDiscoveryLoad(): any {
  return {
    discoveryCapacityVerified: true,
    autonomyAdmission: { allowed: true },
    workers: { total: 1, online: 1, busy: 0, idle: 1 },
    jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
    publication: {
      backlog: 0,
      oldestPendingAgeMs: 0,
      oldestFinalizingAgeMs: 0,
      expiredClaims: 0,
      unhealthy: false,
    },
    completions: { pending: 0, claimed: 0 },
    prs: { openUnmerged: 0 },
  };
}

async function withCapturedAutonomyTimers(
  run: (clock: {
    timers: Map<any, { callback: () => void; delay: number; interval: boolean }>;
    fire: (id: any) => void;
  }) => Promise<void> | void,
): Promise<void> {
  const saved = { setTimeout, clearTimeout, setInterval, clearInterval };
  const timers = new Map<any, { callback: () => void; delay: number; interval: boolean }>();
  let next = 1;
  const install = (interval: boolean) =>
    ((callback: () => void, delay: number) => {
      const id = next++;
      timers.set(id, { callback, delay, interval });
      return id;
    }) as any;
  globalThis.setTimeout = install(false);
  globalThis.setInterval = install(true);
  globalThis.clearTimeout = ((id: any) => {
    timers.delete(id);
  }) as any;
  globalThis.clearInterval = ((id: any) => {
    timers.delete(id);
  }) as any;
  try {
    await run({
      timers,
      fire(id) {
        const timer = timers.get(id);
        if (!timer) throw new Error("Expected scheduled timer");
        if (!timer.interval) timers.delete(id);
        timer.callback();
      },
    });
  } finally {
    Object.assign(globalThis, saved);
  }
}

function discoveryTestEngine(): RemoteBuddyAutonomousEngine {
  const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-discovery-scheduler-"));
  tempDirs.push(root);
  seedGenericAutonomyRepoLayout(root);
  writeFileSync(
    join(root, "vision.md"),
    "# Vision\n\n## Priorities\n- Improve application reliability\n",
  );
  const engine = new RemoteBuddyAutonomousEngine({
    server: "http://localhost:3001",
    sessionId: "s_discovery_scheduler",
    authToken: "tok",
    repo: root,
    llm: {
      async generate() {
        throw new Error("Empty discovery must not score or plan");
      },
    } as any,
    comm: { async emit() {} } as any,
    config: makeConfig(),
  });
  Object.assign(engine as any, {
    autonomyRepo: root,
    acquireDispatchLock: async () => ({ ok: true }),
    renewDispatchLock: async () => true,
    releaseDispatchLock: async () => undefined,
    ensureAutonomyRepoReady: async () => true,
    fetchSnapshot: async () => makeSnapshot(),
    fetchWorkerLoadSnapshot: async () => healthyDiscoveryLoad(),
    loadCommitHistoryHints: async () => [],
    ingestAutoInspirationPatterns: async () => undefined,
    fetchInspirationPatterns: async () => [],
    fetchInspirationSourceInsights: async () => [],
    repositoryAgentIdeation: async () => ({
      json: { candidates: [] },
      llmCall: {},
      result: null,
      discoveryProgress: durableDiscoveryProgress,
    }),
    postObjective: async () => true,
  });
  return engine;
}

describe("bounded autonomy discovery followups", () => {
  test("blocked execution capability stops normal discovery and a fresh ready snapshot resumes it", async () => {
    mockGitSpawnForTest();
    const engine = discoveryTestEngine() as any;
    const snapshot: any = makeSnapshot();
    let analyses = 0;
    const ideation = engine.repositoryAgentIdeation;
    engine.repositoryAgentIdeation = async (...args: unknown[]) => {
      analyses++;
      return ideation(...args);
    };
    engine.fetchSnapshot = async () => snapshot;
    snapshot.execution_capability = { state: "blocked", reason: "docker_engine" };
    await engine.tick();
    expect(analyses).toBe(0);
    expect(engine.lastDetail).toBe("execution_capability_blocked:docker_engine");
    expect(engine.discoveryFollowupTimer).toBeNull();
    snapshot.execution_capability = { state: "ready" };
    await engine.tick();
    expect(analyses).toBe(1);
    expect(engine.lastDetail).toBe("no_eligible_candidates");
    engine.stop();
  });

  test("a deferred exhausted discovery does not manufacture another empty objective", async () => {
    mockGitSpawnForTest();
    const engine = discoveryTestEngine() as any;
    let objectives = 0;
    engine.postObjective = async () => {
      objectives++;
      return true;
    };
    engine.repositoryAgentIdeation = async () => ({
      json: { candidates: [] },
      llmCall: {},
      result: null,
      discoveryProgress: null,
      deferred: true,
    });
    await engine.tick();
    expect(objectives).toBe(0);
    expect(engine.lastDetail).toBe("repository_discovery_exhausted_backoff");
    expect(engine.discoveryFollowupTimer).toBeNull();
    engine.stop();
  });

  test("continues at a durable discovery-window boundary without bypassing followup budgets", async () => {
    await withCapturedAutonomyTimers(({ timers, fire }) => {
      const engine = discoveryTestEngine() as any;
      engine.tick = async () => undefined;
      engine.start();
      const progress = { ...durableDiscoveryProgress, page: 16, pageCount: 16 };
      engine.scheduleDiscoveryFollowup(progress, engine.schedulingGeneration);
      expect(engine.discoveryFollowupTimer).toBeNull();
      const nextWindow = { ...progress, nextWindowAvailable: true };
      engine.scheduleDiscoveryFollowup(nextWindow, engine.schedulingGeneration);
      expect(timers.get(engine.discoveryFollowupTimer)?.delay).toBe(5_000);
      expect(engine.discoveryFollowupAttemptsRemaining).toBe(15);
      fire(engine.discoveryFollowupTimer);
      for (const override of [
        { advanced: false },
        { boundedCoverageExhausted: true },
        { retryEligible: false },
      ]) {
        engine.scheduleDiscoveryFollowup(
          { ...nextWindow, ...override },
          engine.schedulingGeneration,
        );
        expect(engine.discoveryFollowupTimer).toBeNull();
      }
      engine.discoveryFollowupAttemptsRemaining = 0;
      engine.scheduleDiscoveryFollowup(nextWindow, engine.schedulingGeneration);
      expect(engine.discoveryFollowupTimer).toBeNull();
      engine.stop();
      expect(timers.size).toBe(0);
    });
  });

  test("schedules one 5s idle followup with earliest-next-tick telemetry and unchanged bounded attempts", async () => {
    await withCapturedAutonomyTimers(({ timers, fire }) => {
      const engine = discoveryTestEngine() as any;
      const calls: unknown[][] = [];
      engine.tick = async (...args: unknown[]) => {
        calls.push(args);
      };
      engine.start();
      const generation = engine.schedulingGeneration;
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, generation);
      const first = engine.discoveryFollowupTimer;
      expect(timers.get(first)?.delay).toBe(5_000);
      expect(engine.nextTickAtMs).toBe(engine.discoveryFollowupAtMs);
      expect(engine.nextTickAtMs).toBeLessThan(engine.baselineNextTickAtMs);
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, generation);
      expect(engine.discoveryFollowupTimer).toBe(first);
      expect(engine.discoveryFollowupAttemptsRemaining).toBe(15);
      fire(first);
      expect(calls.at(-1)).toEqual([true, generation]);
      expect(engine.nextTickAtMs).toBe(engine.baselineNextTickAtMs);
      for (let index = 0; index < 15; index++) {
        engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, generation);
        expect(engine.discoveryFollowupTimer).not.toBeNull();
        fire(engine.discoveryFollowupTimer);
      }
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, generation);
      expect(engine.discoveryFollowupTimer).toBeNull();
      expect(engine.discoveryFollowupAttemptsRemaining).toBe(0);
      fire(engine.timer);
      expect(engine.discoveryFollowupAttemptsRemaining).toBe(16);
      engine.stop();
      expect(timers.size).toBe(0);
    });
  });

  test("baseline collision and pause/stop discard late followup callbacks", async () => {
    await withCapturedAutonomyTimers(({ timers, fire }) => {
      const engine = discoveryTestEngine() as any;
      let ticks = 0;
      engine.tick = async () => {
        ticks++;
      };
      engine.start();
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, engine.schedulingGeneration);
      const collision = timers.get(engine.discoveryFollowupTimer)!.callback;
      fire(engine.timer);
      const afterBaseline = ticks;
      collision();
      expect(ticks).toBe(afterBaseline);
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, engine.schedulingGeneration);
      const paused = timers.get(engine.discoveryFollowupTimer)!.callback;
      engine.setRuntimeEnabled(false);
      expect(engine.nextTickAtMs).toBe(0);
      engine.setRuntimeEnabled(true);
      const afterResume = ticks;
      paused();
      expect(ticks).toBe(afterResume);
      engine.scheduleDiscoveryFollowup(durableDiscoveryProgress, engine.schedulingGeneration);
      const stopped = timers.get(engine.discoveryFollowupTimer)!.callback;
      engine.stop();
      stopped();
      engine.start();
      expect(ticks).toBe(afterResume);
      expect(timers.size).toBe(0);
    });
  });

  test.each(["unadvanced", "exhausted", "ineligible", "backoff", "earlier_baseline", "manual"])(
    "does not accelerate %s discovery",
    async (scenario) => {
      await withCapturedAutonomyTimers(() => {
        const engine = discoveryTestEngine() as any;
        engine.tick = async () => undefined;
        if (scenario !== "manual") engine.start();
        const progress = {
          ...durableDiscoveryProgress,
          ...(scenario === "unadvanced" ? { advanced: false } : {}),
          ...(scenario === "exhausted" ? { boundedCoverageExhausted: true } : {}),
          ...(scenario === "ineligible" ? { retryEligible: false } : {}),
        };
        if (scenario === "backoff") engine.dispatchBackoffUntilMs = Date.now() + 60_000;
        if (scenario === "earlier_baseline") engine.baselineNextTickAtMs = Date.now() + 2_000;
        engine.scheduleDiscoveryFollowup(progress, engine.schedulingGeneration);
        expect(engine.discoveryFollowupTimer).toBeNull();
        engine.stop();
      });
    },
  );

  test("real empty tick schedules only after lock release and fresh followup capacity can stop it", async () => {
    mockGitSpawnForTest();
    await withCapturedAutonomyTimers(async () => {
      const engine = discoveryTestEngine() as any;
      const actualTick = engine.tick.bind(engine);
      engine.tick = async () => undefined;
      engine.start();
      engine.tick = actualTick;
      let finishRelease!: () => void;
      let releaseStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      engine.releaseDispatchLock = async () => {
        releaseStarted();
        await new Promise<void>((resolve) => {
          finishRelease = resolve;
        });
      };
      const pending = engine.tick();
      await started;
      expect(engine.inFlight).toBe(true);
      expect(engine.discoveryFollowupTimer).toBeNull();
      await engine.tick(true);
      finishRelease();
      await pending;
      expect(engine.inFlight).toBe(false);
      expect(engine.discoveryFollowupTimer).not.toBeNull();
      engine.releaseDispatchLock = async () => undefined;
      engine.fetchWorkerLoadSnapshot = async () => ({
        ...healthyDiscoveryLoad(),
        workers: { total: 1, online: 1, busy: 1, idle: 0 },
      });
      engine.repositoryAgentIdeation = async () => {
        throw new Error("Busy followup must not analyze");
      };
      await engine.tick(true);
      expect(engine.discoveryFollowupTimer).toBeNull();
      expect(engine.lastDetail).toContain("worker_load_busy");
      engine.stop();
    });
  });

  test.each([
    "unknown_load",
    "offline",
    "missing_publication",
    "publication_backlog",
    "pending_job",
    "busy_workers",
    "expired_claim",
    "global_budget",
    "max_concurrent",
    "resource_budget",
    "dispatch_backoff",
  ])("fresh accelerated tick preserves %s gate", async (scenario) => {
    mockGitSpawnForTest();
    const engine = discoveryTestEngine() as any;
    let analyses = 0;
    engine.repositoryAgentIdeation = async () => {
      analyses++;
      throw new Error("Must not analyze");
    };
    const load = healthyDiscoveryLoad();
    if (scenario === "offline") load.workers = { total: 1, online: 0, idle: 0, busy: 0 };
    if (scenario === "missing_publication") load.discoveryCapacityVerified = false;
    if (scenario === "publication_backlog") load.publication.backlog = 2;
    if (scenario === "pending_job") load.jobs.pending = 1;
    if (scenario === "busy_workers") load.workers = { total: 1, online: 1, idle: 0, busy: 1 };
    if (scenario === "expired_claim") load.publication.expiredClaims = 1;
    engine.fetchWorkerLoadSnapshot = async () => (scenario === "unknown_load" ? null : load);
    const snapshot: any = makeSnapshot();
    if (scenario === "global_budget") snapshot.dispatch_budget.global_count_last_hour = 6;
    if (scenario === "max_concurrent")
      snapshot.open_objectives = [{ status: "running" }, { status: "dispatched" }];
    if (scenario === "resource_budget") snapshot.resource_budget = { token_budget_exhausted: true };
    if (scenario === "dispatch_backoff") engine.dispatchBackoffUntilMs = Date.now() + 60_000;
    engine.fetchSnapshot = async () => snapshot;
    await engine.tick(true);
    expect(analyses).toBe(0);
    expect(engine.discoveryFollowupTimer).toBeNull();
    engine.stop();
  });

  test("raw missing or malformed capacity/publication fields never authorize fast discovery", async () => {
    const engine = discoveryTestEngine() as any;
    engine.fetchWorkerLoadSnapshot = (
      RemoteBuddyAutonomousEngine.prototype as any
    ).fetchWorkerLoadSnapshot.bind(engine);
    const healthy = healthyDiscoveryLoad();
    for (const payload of [
      { ...healthy, publication: undefined },
      { ...healthy, publication: { ...healthy.publication, backlog: "0" } },
      { ...healthy, workers: { ...healthy.workers, idle: Number.NaN } },
      { ...healthy, autonomyAdmission: undefined },
    ]) {
      engine.fetchControl = async () => jsonResponse(200, { ok: true, ...payload });
      const snapshot = await engine.fetchWorkerLoadSnapshot();
      expect(engine.hasIdleDiscoveryCapacity(snapshot)).toBe(false);
    }
    engine.fetchControl = async () => jsonResponse(200, { ok: true, ...healthy });
    expect(engine.hasIdleDiscoveryCapacity(await engine.fetchWorkerLoadSnapshot())).toBe(true);
    engine.stop();
  });
});

describe("RemoteBuddyAutonomousEngine tick orchestration", () => {
  test("bounds a control-plane response body that never finishes", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-http-deadline-"));
    tempDirs.push(root);
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // The endpoint sent headers but never completed its response body.
          },
        }),
        { status: 200 },
      )) as typeof globalThis.fetch;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_http_deadline",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });

    const startedAt = Date.now();
    await expect(
      (engine as any).fetchControl("http://localhost:3001/autonomy/snapshot", {}, 20),
    ).rejects.toThrow("RemoteBuddy autonomy control request timed out after 20ms");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("similar-failure enqueue suppression cools only the failed target cluster", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-backoff-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse(429, {
        ok: false,
        code: "autonomy_similar_failure_suppressed",
        message: "unchanged target-and-failure fingerprint",
        retryAfterMs: 120_000,
        targetPathSample: ["src/example.ts"],
      });
    }) as typeof fetch;

    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_backoff",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });

    const requestId = await (engine as any).enqueueSyntheticRequest("Background task", {
      objectiveId: "objective_backoff",
      runId: "run_backoff",
      snapshotId: "snapshot_backoff",
      patternKey: "pattern.backoff",
      componentArea: "tests",
      targetPaths: ["src/example.ts"],
      writeGlobs: ["src/**"],
    });

    expect(requestId).toBeNull();
    expect(calls).toHaveLength(1);
    expect((engine as any).dispatchBackoffUntilMs).toBe(0);
    expect((engine as any).dispatchBackoffReason).toBe("");
    expect((engine as any).suppressedFailureTargetReason(["src/example.ts"])).toContain(
      "similar_failure_cluster_cooldown",
    );
    expect((engine as any).suppressedFailureTargetReason(["src/other.ts"])).toBeNull();
  });

  test("backs off when the worker-runtime admission circuit is open", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-runtime-circuit-"));
    tempDirs.push(root);
    globalThis.fetch = (async () =>
      jsonResponse(429, {
        ok: false,
        code: "autonomy_worker_runtime_circuit_open",
        message: "WorkerPal repeated the same internal runtime failure",
        retryAfterMs: 120_000,
        recentMatchingFailureCount: 2,
      })) as typeof fetch;

    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_runtime_circuit",
      authToken: "tok",
      repo: root,
      llm: { complete: async () => ({ text: "{}", usage: {} }) } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const beforeEnqueueMs = Date.now();
    const requestId = await (engine as any).enqueueSyntheticRequest("Background task", {
      objectiveId: "objective_runtime_circuit",
      runId: "run_runtime_circuit",
      snapshotId: "snapshot_runtime_circuit",
      patternKey: "runtime.circuit",
      componentArea: "workerpals",
      targetPaths: ["apps/workerpals/src/common/generic_python_executor.ts"],
      writeGlobs: ["apps/workerpals/src/**"],
    });

    expect(requestId).toBeNull();
    expect((engine as any).dispatchBackoffReason).toBe("autonomy_worker_runtime_circuit_open");
    expect((engine as any).dispatchBackoffUntilMs).toBeGreaterThanOrEqual(
      beforeEnqueueMs + 120_000,
    );
    expect((engine as any).dispatchBackoffUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  test.each([
    { status: 429, code: "autonomy_recovery_backpressure", retry: 30_000, expected: 60_000 },
    { status: 429, code: "future_admission_gate", retry: 120_000, expected: 120_000 },
    { status: 429, code: "session_token_budget_exceeded", retry: null, expected: 300_000 },
    { status: 409, code: "autonomy_reservation_invalid", retry: undefined, expected: 300_000 },
    { status: 503, code: "service_unavailable", retry: "", expected: 300_000 },
    { status: 429, code: "rate_limited", retry: 86_400_000, expected: 1_800_000 },
    { status: 401, code: "credential=DO_NOT_LOG", retry: -1, expected: 300_000 },
    { status: 502, code: null, retry: "invalid", expected: 300_000 },
  ])("enqueue rejection backs off and preserves bounded diagnostics: %j", async (scenario) => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-enqueue-diagnostics-"));
    tempDirs.push(root);
    let accepted = false;
    globalThis.fetch = (async () =>
      accepted
        ? jsonResponse(201, { ok: true, requestId: "recovered-request" })
        : scenario.status === 502
          ? new Response("<html>DO_NOT_LOG</html>", { status: 502 })
          : jsonResponse(scenario.status, {
              code: scenario.code,
              retryAfterMs: scenario.retry,
              message: "DO_NOT_LOG",
            })) as typeof fetch;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_rejection",
      authToken: "tok",
      repo: root,
      llm: {
        generate: async () => {
          throw new Error("must not plan during backoff");
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const identity = {
      objectiveId: "objective_rejection",
      runId: "run_rejection",
      snapshotId: "snap_rejection",
      patternKey: "rejection",
      componentArea: "src",
      targetPaths: ["src/example.ts"],
      writeGlobs: ["src/example.ts"],
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const started = Date.now();
      expect(await (engine as any).enqueueSyntheticRequest("task", identity)).toBeNull();
      const code =
        scenario.code && /^[a-z][a-z0-9_]*$/.test(scenario.code)
          ? scenario.code
          : "autonomy_enqueue_rejected";
      expect((engine as any).lastEnqueueRejectionReason).toBe(
        `request_enqueue_rejected:http_${scenario.status}:${code}`,
      );
      expect((engine as any).dispatchBackoffUntilMs).toBeGreaterThanOrEqual(
        started + scenario.expected,
      );
      expect((engine as any).dispatchBackoffUntilMs).toBeLessThanOrEqual(
        Date.now() + scenario.expected,
      );
      expect(warnings.join("\n")).toContain('"event":"autonomy_enqueue_rejected"');
      expect(warnings.join("\n")).toContain('"objectiveId":"objective_rejection"');
      expect(warnings.join("\n")).not.toContain("DO_NOT_LOG");
      (engine as any).acquireDispatchLock = async () => {
        throw new Error("must not leave backoff");
      };
      await engine.tick();
      expect((engine as any).lastDetail).toStartWith(`dispatch_backoff:${code}:`);
      accepted = true;
      expect(await (engine as any).enqueueSyntheticRequest("task", identity)).toBe(
        "recovered-request",
      );
      expect((engine as any).lastEnqueueRejectionReason).toBeNull();
      expect((engine as any).dispatchBackoffUntilMs).toBe(0);
    } finally {
      console.warn = originalWarn;
      engine.stop();
    }
  });

  test.each(["empty", "cached_empty", "unavailable", "malformed"])(
    "does not invent implementation work after %s RepositoryAgent analysis",
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-repository-fallback-"));
      tempDirs.push(root);
      seedGenericAutonomyRepoLayout(root);
      writeFileSync(
        join(root, "vision.md"),
        "# Vision\n\n## Priorities\n- Make queue processing reliable for users\n",
        "utf8",
      );
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: root,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "PushPals Test"], {
        cwd: root,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });

      const repositoryRequestId = "repo-request-without-candidates";
      const repositoryMemoryId = "repository-memory-must-not-be-attributed";
      let repositoryAgentCalls = 0;
      const repositoryAgent = {
        async ask(input: Record<string, unknown>) {
          repositoryAgentCalls += 1;
          if (scenario === "unavailable") throw new Error("Repository analysis unavailable");
          const repository = input.repository as Record<string, unknown>;
          return {
            schemaVersion: 1,
            requestId: repositoryRequestId,
            analyzedRepository: {
              identity: repository.identity,
              revision: repository.revision,
              tree: repository.tree,
            },
            answer: "No grounded candidate was available.",
            summary: "Repository analysis completed without a usable candidate.",
            data: scenario === "malformed" ? {} : { candidates: [] },
            confidence: 0.2,
            evidence: [],
            recommendations: [],
            validationProposals: [],
            cache: { hit: scenario === "cached_empty", key: "empty-repository-result" },
            memoryRefs: [
              {
                id: repositoryMemoryId,
                namespace: "repository_agent_cache",
                role: "analysis_cache",
              },
            ],
            completedAt: new Date().toISOString(),
          };
        },
      };
      let llmCall = 0;
      const llm = {
        async generate() {
          llmCall += 1;
          throw new Error("Empty analysis must not spend model time on scoring or planning");
        },
      };
      const objectivePosts: Array<Record<string, unknown>> = [];
      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "s_repository_fallback",
        authToken: "tok",
        repo: root,
        llm: llm as any,
        repositoryAgent: repositoryAgent as any,
        comm: { async emit() {} } as any,
        config: makeConfig(),
      });
      (engine as any).autonomyRepo = root;
      (engine as any).acquireDispatchLock = async () => ({ ok: true });
      (engine as any).renewDispatchLock = async () => true;
      (engine as any).releaseDispatchLock = async () => undefined;
      (engine as any).ensureAutonomyRepoReady = async () => true;
      (engine as any).fetchSnapshot = async () => makeSnapshot();
      (engine as any).fetchWorkerLoadSnapshot = async () => null;
      (engine as any).loadVisionContext = () => ({
        path: "vision.md",
        markdown: "# Vision\n\n## Priorities\n- Make queue processing reliable for users\n",
        one_sentence: "Make queue processing reliable for users.",
        sections: [
          {
            number: "1",
            title: "Priorities",
            markdown: "Make queue processing reliable for users.",
            truncated: false,
          },
        ],
        key_items: {
          target_users: ["application users"],
          priorities: ["Make queue processing reliable for users"],
          objectives: ["Reduce stalled background work"],
          guardrails: ["Keep changes narrowly scoped"],
          constraints: [],
          non_goals: [],
          metrics: ["Fewer stalled jobs"],
          testing_criteria: ["Run repository-native tests"],
          risk_policy: ["Low-risk autonomous changes"],
          operating_model: [],
          governance: [],
        },
        section_numbers: ["1"],
        sha256: "fallback-vision-hash",
        truncated: false,
      });
      (engine as any).loadCommitHistoryHints = async () => [];
      (engine as any).ingestAutoInspirationPatterns = async () => undefined;
      (engine as any).fetchInspirationPatterns = async () => [];
      (engine as any).fetchInspirationSourceInsights = async () => [];
      (engine as any).fetchEligibility = async (
        _runId: string,
        _snapshotId: string,
        candidates: Array<{ id: string }>,
      ) => new Map(candidates.map((candidate) => [candidate.id, { ok: true }]));
      (engine as any).postObjective = async (payload: Record<string, unknown>) => {
        objectivePosts.push(payload);
        return true;
      };
      let enqueueCalls = 0;
      (engine as any).enqueueSyntheticRequest = async () => {
        enqueueCalls += 1;
        return "req_repository_fallback";
      };

      await engine.tick();

      expect(repositoryAgentCalls).toBe(1);
      expect(llmCall).toBe(0);
      expect(enqueueCalls).toBe(0);
      expect(objectivePosts).toHaveLength(1);
      const reservation = objectivePosts[0] ?? {};
      expect(reservation.objective).toBeUndefined();
      expect(reservation.candidates).toEqual([]);
      expect((engine as any).lastDetail).toBe("no_eligible_candidates");
      expect(reservation).not.toHaveProperty("repositoryAgentMemory");
      expect(JSON.stringify(reservation)).not.toContain(repositoryRequestId);
      expect(JSON.stringify(reservation)).not.toContain(repositoryMemoryId);
    },
  );

  test("stop during repository ideation prevents scoring, reservation, and enqueue", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-stop-during-ideation-"));
    tempDirs.push(root);
    seedGenericAutonomyRepoLayout(root);
    writeFileSync(join(root, "vision.md"), "# Vision\n\n## Priorities\n- Stay responsive\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "PushPals Test"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });

    let scoringCalls = 0;
    let objectivePosts = 0;
    let enqueueCalls = 0;
    let markIdeationStarted: (() => void) | null = null;
    const ideationStarted = new Promise<void>((resolveStarted) => {
      markIdeationStarted = resolveStarted;
    });
    let finishIdeation: (() => void) | null = null;
    const ideationFinished = new Promise<void>((resolveFinished) => {
      finishIdeation = resolveFinished;
    });
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_stop_during_ideation",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          scoringCalls++;
          return { text: "{}" };
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).autonomyRepo = root;
    (engine as any).acquireDispatchLock = async () => ({ ok: true });
    (engine as any).renewDispatchLock = async () => true;
    (engine as any).releaseDispatchLock = async () => undefined;
    (engine as any).ensureAutonomyRepoReady = async () => true;
    (engine as any).fetchSnapshot = async () => makeSnapshot();
    (engine as any).fetchWorkerLoadSnapshot = async () => null;
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n\n## Priorities\n- Stay responsive\n",
      one_sentence: "Stay responsive.",
      sections: [{ number: "1", title: "Priorities", markdown: "Stay responsive." }],
      key_items: {
        target_users: [],
        priorities: ["Stay responsive"],
        objectives: [],
        guardrails: [],
        constraints: [],
        non_goals: [],
        metrics: [],
        testing_criteria: [],
        risk_policy: [],
        operating_model: [],
        governance: [],
      },
      section_numbers: ["1"],
      sha256: "stop-during-ideation-vision",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];
    (engine as any).ingestAutoInspirationPatterns = async () => undefined;
    (engine as any).fetchInspirationPatterns = async () => [];
    (engine as any).fetchInspirationSourceInsights = async () => [];
    (engine as any).repositoryAgentIdeation = async () => {
      markIdeationStarted?.();
      await ideationFinished;
      return {
        json: { candidates: [] },
        llmCall: { phase: "ideation" },
        result: null,
      };
    };
    (engine as any).postObjective = async () => {
      objectivePosts++;
      return true;
    };
    (engine as any).enqueueSyntheticRequest = async () => {
      enqueueCalls++;
      return "must-not-enqueue";
    };

    const tick = engine.tick();
    await ideationStarted;
    engine.stop();
    finishIdeation?.();
    await tick;

    expect(scoringCalls).toBe(0);
    expect(objectivePosts).toBe(0);
    expect(enqueueCalls).toBe(0);
    expect((engine as any).lastDetail).toBe("disabled_during_repository_agent_ideation");
  });

  test.each([0, 2])(
    "dispatches a source-grounded naming repair through real worker and server admission after %i rejected evidence pages",
    async (rejectedPages) => {
      originalFetch = globalThis.fetch;
      const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-grounded-dispatch-"));
      const stateRoot = mkdtempSync(join(tmpdir(), "pushpals-autonomy-grounded-state-"));
      tempDirs.push(root, stateRoot);
      mkdirSync(join(root, "src"));
      writeFileSync(
        join(root, "vision.md"),
        "# Vision\n\n## Priorities\n- Make catalog empty-state labels clear to application users.\n",
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "catalog-fixture", scripts: { test: "node --test" } }),
      );
      writeFileSync(join(root, "README.md"), "# Catalog\n\nBrowse a local catalog.\n");
      // Enough ordinary product files for several independent six-file evidence pages.
      for (let index = 0; index < 18; index++) {
        writeFileSync(
          join(root, "src", `catalog-${String(index).padStart(2, "0")}.js`),
          '// Catalog empty-state copy.\nexport const emptyLabel = "WorkerPal workspace unavailable";\n',
        );
      }
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "catalog fixture",
        ],
        { cwd: root, stdio: "ignore" },
      );
      const repository = await resolveRepositorySnapshot(root);
      const dbPath = join(stateRoot, "control.sqlite");
      const store = new AutonomyStore(dbPath);
      const requests = new RequestQueue(dbPath);
      const memory = new SqliteMemoryStore(join(stateRoot, "memory.sqlite"));
      const workerResults: RepositoryAgentResult[] = [];
      const coveragePages: number[] = [];
      const workerWarnings: string[] = [];
      const objectivePosts: Array<Record<string, any>> = [];
      const serverDecisions: Array<{ ok: boolean; reason?: string }> = [];
      let modelCalls = 0;
      let planningCalls = 0;
      let enqueuedRequestId = "";
      let selectedTarget = "";
      const control: RepositoryAgentWorkerControl = {
        claim: async () => ({ claim: null, pollAfterMs: 1 }),
        renewLease: async () => {
          throw new Error("Direct analysis must not renew a queue lease");
        },
        complete: async () => {
          throw new Error("Direct analysis must not complete a queue claim");
        },
        fail: async () => {
          throw new Error("Direct analysis must not fail a queue claim");
        },
      };
      const repositoryLlm = {
        async generate(input: LLMGenerateInput) {
          modelCalls += 1;
          const payload = JSON.parse(input.messages[0]!.content);
          const packet = payload.evidencePacket;
          coveragePages.push(packet.discoveryCoverage.page);
          const target = (packet.selectedPaths as string[]).find((path) => path.startsWith("src/"));
          expect(target).toBeDefined();
          expect(
            (packet.files as Array<{ path: string }>).some((file) => file.path === target),
          ).toBe(true);
          selectedTarget = target!;
          const invalidInternalProposal = modelCalls <= rejectedPages;
          const candidate = {
            id: "catalog-label-repair",
            title: invalidInternalProposal
              ? "Add catalog recovery diagnostics"
              : "Correct the catalog empty-state label",
            objective_type: "small_refactor",
            problem_statement: invalidInternalProposal
              ? "Add WorkerPal orchestration retry diagnostics to catalog recovery behavior."
              : `${target}:2 contains the user-visible string "WorkerPal workspace unavailable"; replace it with repository-native wording and add a regression.`,
            trigger_type: "regret_signal",
            component_area: "src",
            target_paths: [target!],
            scope: { read_anywhere: false, write_globs: [target!] },
            risk_level: "low",
            expected_validation: ["npm test"],
            estimated_effort: "small",
            why_now_signal_ids: [],
            confidence: 0.95,
            vision_alignment_reason: "Make catalog empty-state labels clear to application users.",
            vision_section_refs: [String(payload.request.context.vision.sections[0].number)],
            feature_hypotheses: ["Clear empty-state copy helps application users recover."],
          };
          return {
            text: JSON.stringify({
              answer: "Inspect the catalog empty-state label.",
              summary: "A tracked catalog label needs a bounded repair.",
              data: { candidates: [candidate] },
              confidence: 0.95,
              evidence: [
                { path: target, startLine: 2, endLine: 2, rationale: "Observed catalog label" },
              ],
              recommendations: [],
              validationProposals: [],
            }),
          };
        },
      };
      const repositoryAgent = {
        async ask(input: RepositoryAgentSubmitInput, options?: RepositoryAgentAskOptions) {
          const request: RepositoryAgentRequest = {
            ...input,
            schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
            caller: { ...input.caller, service: "remotebuddy" },
          };
          // Reconstruct the worker each cycle: coverage/cache progress must be durable.
          const worker = new RepositoryAgentWorker({
            control,
            memory,
            llm: repositoryLlm,
            logger: {
              log() {},
              warn: (message) => workerWarnings.push(String(message)),
              error() {},
            },
          });
          const result = await worker.analyze(
            `catalog-analysis-${workerResults.length + 1}`,
            request,
            options?.signal,
          );
          workerResults.push(result);
          return result;
        },
      };
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        if (url.pathname === "/autonomy/lock/acquire") {
          const result = store.acquireDispatchLock(body);
          return jsonResponse(result.ok ? 200 : 409, result);
        }
        if (url.pathname === "/autonomy/lock/renew") {
          const result = store.renewDispatchLock(body);
          return jsonResponse(result.ok ? 200 : 409, result);
        }
        if (url.pathname === "/autonomy/lock/release") {
          return jsonResponse(200, store.releaseDispatchLock(body));
        }
        if (url.pathname === "/autonomy/snapshot") {
          return jsonResponse(200, {
            ok: true,
            snapshot: store.createSnapshot({
              sessionId: url.searchParams.get("sessionId")!,
              runId: url.searchParams.get("runId")!,
              repoHealthFlags: { is_worktree_dirty: false, is_merge_in_progress: false },
            }),
          });
        }
        if (url.pathname === "/autonomy/eligibility") {
          return jsonResponse(200, store.evaluateEligibility(body));
        }
        if (url.pathname === "/autonomy/objectives") {
          objectivePosts.push(body);
          const result = store.recordObjectiveDecision(body);
          serverDecisions.push(result);
          return jsonResponse(result.ok ? 200 : 400, result);
        }
        if (url.pathname === "/requests/enqueue") {
          const autonomy = body.metadata.autonomy;
          const reservation = store.validateObjectiveReservation({
            objectiveId: autonomy.objectiveId,
            sessionId: body.sessionId,
            runId: autonomy.runId,
            snapshotId: autonomy.snapshotId,
          });
          if (!reservation.ok) return jsonResponse(409, reservation);
          const result = requests.enqueue(body);
          enqueuedRequestId = result.requestId ?? "";
          return jsonResponse(result.ok ? 201 : 400, result);
        }
        const confirmation = url.pathname.match(/^\/requests\/([^/]+)\/dispatch\/confirm$/);
        if (confirmation) {
          const result = requests.confirmDispatch(confirmation[1]!, body.dispatchConfirmationToken);
          if (result.ok) {
            const request = requests.getRequest(confirmation[1]!)!;
            const metadata = JSON.parse(request.metadataJson!);
            expect(store.markObjectiveDispatched(metadata.autonomy.objectiveId, request.id)).toBe(
              true,
            );
          }
          return jsonResponse(result.ok ? 200 : 409, result);
        }
        throw new Error(`Unexpected composed autonomy request: ${url.pathname}`);
      }) as typeof globalThis.fetch;
      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://composed-autonomy.invalid",
        sessionId: "catalog-session",
        repo: root,
        config: makeConfig(),
        repositoryAgent: repositoryAgent as any,
        llm: {
          async generate(input: LLMGenerateInput) {
            const payload = JSON.parse(input.messages[0]!.content);
            if (payload.candidate) {
              planningCalls += 1;
              // Preserve engine-rendered evidence all the way through server instruction gates.
              return { text: JSON.stringify({ instruction: payload.candidate.problem_statement }) };
            }
            return {
              text: JSON.stringify({ scores: [{ id: "catalog-label-repair", llm_score: 0.99 }] }),
            };
          },
        },
        comm: { async emit() {} } as any,
      });
      (engine as any).autonomyRepo = root;
      (engine as any).ensureAutonomyRepoReady = async () => true;
      (engine as any).fetchWorkerLoadSnapshot = async () => null;
      (engine as any).loadCommitHistoryHints = async () => [];
      (engine as any).ingestAutoInspirationPatterns = async () => undefined;
      (engine as any).fetchInspirationPatterns = async () => [];
      (engine as any).fetchInspirationSourceInsights = async () => [];
      try {
        for (let page = 0; page <= rejectedPages; page++) {
          await engine.tick();
          if (page < rejectedPages) {
            expect((engine as any).lastDetail).toBe("no_eligible_candidates");
            expect(workerResults[page]!.data).toEqual({ candidates: [] });
            expect(requests.countByStatus().pending).toBe(0);
            expect(planningCalls).toBe(0);
            const records = await memory.search({
              scope: { namespace: "repository_agent_cache", repositoryId: repository.identity },
              kinds: ["repository_autonomy_evidence_coverage"],
              maxItems: 8,
              maxChars: 100_000,
            });
            expect(records).toHaveLength(1);
            expect((records[0]!.value as Record<string, unknown>).nextPage).toBe(page + 1);
          }
        }
        expect(modelCalls).toBe(rejectedPages + 1);
        expect(coveragePages).toEqual(
          Array.from({ length: rejectedPages + 1 }, (_, index) => index + 1),
        );
        expect(workerResults.every((result) => !result.cache.hit)).toBe(true);
        expect(JSON.stringify(workerResults.at(-1)!.data)).toContain(
          "WorkerPal workspace unavailable",
        );
        expect(planningCalls).toBe(1);
        expect((engine as any).lastOutcome).toBe("success");
        expect(serverDecisions.every((result) => result.ok)).toBe(true);
        const reservation = objectivePosts.find((body) => body.objective);
        expect(reservation?.objective.instruction).toContain(`${selectedTarget}:2`);
        expect(reservation?.objective.instruction).toContain(
          "[existing source literal; see cited location]",
        );
        expect(reservation?.objective.instruction).not.toMatch(/workerpal|pushpals|remotebuddy/i);
        const request = requests.getRequest(enqueuedRequestId);
        expect(request?.dispatchConfirmedAt).toBeTruthy();
        expect(request?.prompt).toBe(reservation?.objective.instruction);
        expect(requests.countByStatus().pending).toBe(1);
        const objective = (store as any).db
          .prepare("SELECT status, request_id FROM autonomy_objectives WHERE id = ?")
          .get(reservation?.objective.id);
        expect(objective).toMatchObject({ status: "dispatched", request_id: enqueuedRequestId });
        const persistedCandidates = (store as any).db
          .prepare("SELECT gate_decision, gate_reasons_json FROM autonomy_candidates")
          .all();
        expect(persistedCandidates).toHaveLength(1);
        expect(persistedCandidates[0].gate_decision).not.toBe("rejected");
        expect(JSON.parse(persistedCandidates[0].gate_reasons_json)).toEqual([]);
        expect(
          workerWarnings.some((warning) =>
            /invalid_autonomy_candidates|capability circuit/i.test(warning),
          ),
        ).toBe(false);
      } finally {
        engine.stop();
        requests.close();
        store.close();
        await memory.close();
      }
    },
    30_000,
  );

  test("tick auto-ingests inspiration and dispatches an objective end-to-end", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-tick-"));
    tempDirs.push(root);
    seedPushpalsAutonomyRepoLayout(root);
    const calls: FetchCall[] = [];
    const objectivePosts: Array<Record<string, unknown>> = [];
    let llmCall = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot"))
        return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 2, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/requests/enqueue"))
        return jsonResponse(201, {
          ok: true,
          requestId: "req_tick_1",
          dispatchConfirmed: true,
        });
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_tick_1",
          patternKey: "lint_fix::apps/server::lint_failure",
        });
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCall += 1;
        if (llmCall === 1) {
          return {
            text: JSON.stringify({
              candidates: [
                {
                  id: "cand_tick_1",
                  title: "Stabilize autonomy queue guardrails",
                  objective_type: "lint_fix",
                  problem_statement: "Harden queue guardrail branch in server autonomy path.",
                  trigger_type: "lint_failure",
                  component_area: "apps/server",
                  target_paths: ["apps/server/src/autonomy.ts"],
                  scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
                  risk_level: "low",
                  expected_validation: ["bun run test:root"],
                  estimated_effort: "small",
                  why_now_signal_ids: ["sig_queue"],
                  confidence: 0.92,
                  vision_alignment_reason: "Matches reliability and throughput priorities.",
                  vision_section_refs: ["1"],
                  feature_hypotheses: ["Queue guardrail tuning reduces backlog churn."],
                  requires_user_input: false,
                },
              ],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        if (llmCall === 2) {
          return {
            text: JSON.stringify({
              scores: [{ id: "cand_tick_1", llm_score: 0.95 }],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({
            instruction:
              "Tighten queue guardrail scoring in apps/server/src/autonomy.ts and verify with tests.",
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const comm = {
      async emit() {
        return true;
      },
    };

    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_tick",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: makeConfig(),
    });

    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Improve autonomous throughput safely.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Focus queue and reliability",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: ["reliability"],
        objectives: ["reliable autonomous delivery"],
        guardrails: ["small scoped changes"],
        constraints: ["safe defaults"],
        non_goals: [],
        metrics: ["queue p95"],
        risk_policy: ["low risk autonomous"],
        operating_model: ["remotebuddy + workerpals"],
        governance: ["review high risk manually"],
      },
      section_numbers: ["1"],
      sha256: "visionhash",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [
      {
        motif_id: "queue_backpressure",
        label: "Queue Backpressure",
        count: 3,
        signal: 0.7,
        objective_ids: ["reliable_autonomous_delivery"],
        gap_ids: ["queue_pressure_control_gap"],
        sample_subjects: ["autonomy: queue backpressure guard"],
      },
    ];

    await engine.tick();

    const acquireCall = calls.find((entry) => entry.url.includes("/autonomy/lock/acquire"));
    expect(Number((acquireCall?.body as Record<string, unknown> | undefined)?.staleAfterMs)).toBe(
      120_000,
    );

    const ingestCall = calls.find((entry) => entry.url.includes("/autonomy/inspiration/ingest"));
    expect(ingestCall).toBeDefined();
    const ingestBody = ingestCall?.body as Record<string, unknown>;
    expect(Array.isArray(ingestBody.entries)).toBe(true);
    expect((ingestBody.entries as unknown[]).length).toBeGreaterThan(0);

    const enqueueCall = calls.find((entry) => entry.url.endsWith("/requests/enqueue"));
    expect(enqueueCall).toBeDefined();
    const enqueueMetadata = (enqueueCall?.body as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(String(enqueueMetadata.origin ?? "")).toBe("autonomy");
    const enqueueAutonomy = enqueueMetadata.autonomy as Record<string, unknown>;
    expect(enqueueAutonomy.reservationRequired).toBe(true);
    expect(String((enqueueCall?.body as Record<string, unknown>).idempotencyKey)).toStartWith(
      "autonomy:",
    );

    expect(objectivePosts.length).toBe(1);
    const lastObjective = objectivePosts[objectivePosts.length - 1] ?? {};
    const objective = (lastObjective.objective ?? {}) as Record<string, unknown>;
    expect(String(objective.status ?? "")).toBe("gated");
    expect(objective.expected_validation).toEqual(["bun run test:root"]);
  });

  test("tick replaces an LLM-proposed Bun command with Python-native validation", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-generic-python-tick-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    const objectivePosts: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    let ideationInput: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot"))
        return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 0, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/requests/enqueue"))
        return jsonResponse(201, {
          ok: true,
          requestId: "req_python_native_validation",
          dispatchConfirmed: true,
        });
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_python_native_validation",
          patternKey: "small_refactor::src::queue_health",
        });
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate(input: { messages?: Array<{ content?: unknown }> }) {
        llmCall += 1;
        if (llmCall === 1) {
          const content = String(input.messages?.at(-1)?.content ?? "{}");
          ideationInput = JSON.parse(content) as Record<string, unknown>;
          return {
            text: JSON.stringify({
              candidates: [
                {
                  id: "cand_python_native_validation",
                  title: "Improve Python recovery safety",
                  objective_type: "small_refactor",
                  problem_statement: "Make the Python recovery handler safer and easier to verify.",
                  trigger_type: "queue_health",
                  component_area: "src",
                  target_paths: ["src/recovery.py"],
                  scope: { read_anywhere: false, write_globs: ["src/*.py"] },
                  risk_level: "low",
                  expected_validation: ["bun run test:root"],
                  estimated_effort: "small",
                  why_now_signal_ids: ["sig_queue"],
                  confidence: 0.92,
                  vision_alignment_reason: "Advances the recovery safety priority.",
                  vision_section_refs: ["1"],
                  feature_hypotheses: ["A focused recovery guard reduces failed user operations."],
                  requires_user_input: false,
                },
              ],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        if (llmCall === 2) {
          return {
            text: JSON.stringify({
              scores: [{ id: "cand_python_native_validation", llm_score: 0.95 }],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({
            instruction:
              "Improve recovery safety in src/recovery.py and verify the focused Python tests.",
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_python_native_validation",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(join(autonomyRepo, "src"), { recursive: true });
      mkdirSync(join(autonomyRepo, "tests"), { recursive: true });
      writeFileSync(
        join(autonomyRepo, "src", "recovery.py"),
        "def recover(): return True\n",
        "utf8",
      );
      writeFileSync(
        join(autonomyRepo, "tests", "test_recovery.py"),
        "from src.recovery import recover\n\ndef test_recover(): assert recover()\n",
        "utf8",
      );
      writeFileSync(
        join(autonomyRepo, "pyproject.toml"),
        '[project]\nname = "generic-recovery"\nversion = "0.1.0"\n[project.optional-dependencies]\ntest = ["pytest"]\n',
        "utf8",
      );
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Help users recover interrupted work safely.",
      sections: [
        {
          number: "1",
          title: "Improve recovery safety",
          markdown: "Keep recovery deterministic.",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["application users"],
        priorities: ["Improve recovery safety"],
        objectives: [],
        guardrails: ["small scoped changes"],
        constraints: ["preserve compatibility"],
        non_goals: [],
        metrics: ["fewer failed recovery attempts"],
        testing_criteria: [],
        risk_policy: ["low risk autonomous"],
        operating_model: [],
        governance: [],
      },
      section_numbers: ["1"],
      sha256: "generic-python-vision",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];

    await engine.tick();

    expect(objectivePosts).toHaveLength(1);
    const objective = (objectivePosts[0]?.objective ?? {}) as Record<string, unknown>;
    expect(objective.expected_validation).toEqual(["python -m pytest"]);
    expect(JSON.stringify(objective)).not.toContain("bun run test:root");
    expect(calls.some((entry) => entry.url.includes("/autonomy/inspiration/ingest"))).toBe(false);
    const ideationSnapshot = (ideationInput?.snapshot ?? {}) as Record<string, unknown>;
    expect(ideationSnapshot.top_signals).toEqual([]);
    expect(ideationSnapshot.state_traits).toEqual([]);
  });

  test("one terminal trusted failure becomes an exact-candidate repair with one durable reservation under concurrent dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-composed-repair-"));
    tempDirs.push(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "boundary.test.ts"), "// repair target fixture\n");
    const dbPath = join(root, "control.sqlite");
    const store = new AutonomyStore(dbPath);
    const jobs = new JobQueue(dbPath);
    const completions = new CompletionQueue(dbPath);
    const requests = new RequestQueue(dbPath);
    try {
      const jobId = jobs.enqueue({
        taskId: "candidate",
        sessionId: "repair-session",
        kind: "task.execute",
        params: {},
      }).jobId!;
      const claim = jobs.claim("repair-source-worker").job!;
      const candidateSha = "c".repeat(40);
      const candidateRef = `refs/pushpals/validation/${"a".repeat(32)}/1/candidate`;
      const completionId = completions.enqueue(
        {
          jobId,
          sessionId: "repair-session",
          origin: "worker",
          commitSha: candidateSha,
          branch: "candidate-branch",
          message: "retained candidate requires trusted validation",
          trustedValidationCommands: ["bun test tests/boundary.test.ts"],
        },
        {
          beginJobFinalization: true,
          jobClaimAuthority: { workerId: claim.workerId!, claimGeneration: claim.claimGeneration },
        },
      ).completionId!;
      const completion = completions.claim("repair-scm").completion!;
      expect(
        completions.markFailedAndBlockJob(
          completionId,
          "Required validation failed",
          undefined,
          {
            version: 1,
            baselineSha: "b".repeat(40),
            candidateSha,
            candidateRef,
            results: [
              {
                ok: false,
                command: "bun test tests/boundary.test.ts",
                output:
                  "FAIL tests/boundary.test.ts > boundary rejects invalid input\nError: Test timed out in 5000ms.",
                exitCode: 1,
                durationMs: 5_000,
                phase: "validation",
                failureClass: "test_failure",
                failedTests: ["boundary rejects invalid input"],
                targetPathHints: ["tests/boundary.test.ts"],
              },
            ],
          },
          "repair-scm",
          completion.claimToken,
        ).ok,
      ).toBe(true);
      const snapshot = store.createSnapshot({ sessionId: "repair-session", runId: "repair-run" });
      expect(snapshot.validation_incident).toMatchObject({
        active: true,
        failure_count: 1,
        cross_job_circuit_open: false,
        candidate_sha: candidateSha,
        candidate_ref: candidateRef,
      });
      let modelCalls = 0;
      const constructEngine = () => {
        const engine = new RemoteBuddyAutonomousEngine({
          server: "http://unused",
          sessionId: "repair-session",
          repo: root,
          llm: {
            generate: async () => {
              modelCalls++;
              throw new Error("repair must precede ideation");
            },
          },
          comm: { async emit() {} } as any,
          config: makeConfig(),
        });
        (engine as any).autonomyRepo = root;
        (engine as any).fetchEligibility = async (
          runId: string,
          snapshotId: string,
          candidates: unknown[],
        ) =>
          new Map(
            (store.evaluateEligibility({ runId, snapshotId, candidates }).results ?? []).map(
              (entry) => [entry.candidate_id, entry],
            ),
          );
        (engine as any).renewDispatchLock = async () => true;
        (engine as any).postObjective = async (body: Record<string, unknown>) =>
          store.recordObjectiveDecision(body).ok;
        (engine as any).enqueueSyntheticRequest = async (instruction: string, autonomy: any) => {
          expect(
            store.authorizesValidationIncidentRepair({
              objectiveId: autonomy.objectiveId,
              incidentId: autonomy.validationIncident.incidentId,
              snapshotId: autonomy.snapshotId,
            }),
          ).toBe(true);
          expect(autonomy.validationIncident.candidateSha).toBe(candidateSha);
          expect(instruction).toContain("candidate-specific");
          return (
            requests.enqueue({
              sessionId: "repair-session",
              prompt: instruction,
              metadata: { origin: "autonomy", autonomy },
            }).requestId ?? null
          );
        };
        return engine;
      };
      const params = { runId: "repair-run", snapshot, repoTargets: [], visionSectionRefs: ["1"] };
      const results = await Promise.all(
        [constructEngine(), constructEngine()].map((engine) =>
          (engine as any).dispatchValidationIncidentRepair(params),
        ),
      );
      expect(results.filter((result) => result.outcome === "success")).toHaveLength(1);
      expect(requests.countByStatus().pending).toBe(1);
      expect(modelCalls).toBe(0);
    } finally {
      requests.close();
      completions.close();
      jobs.close();
      store.close();
    }
  });

  test("tick dispatches validation repair before normal ideation when required validation is red", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-red-"));
    tempDirs.push(root);
    const scriptPath = join(root, "scripts", "test-web-e2e.js");
    mkdirSync(join(scriptPath, ".."), { recursive: true });
    writeFileSync(scriptPath, "// web e2e fixture\n", "utf8");

    const calls: FetchCall[] = [];
    const objectivePosts: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const snapshot = {
      ...makeSnapshot(),
      top_signals: [
        {
          signal_id: "sig_validation_incident",
          type: "test_failure",
          value: 0.95,
          evidence: "required validation failing: bun run web:e2e failures=4 jobs=4",
        },
      ],
      state_traits: [
        {
          trait_id: "repo_validation_red",
          category: "risk",
          focus: "repo_validation",
          score: 0.95,
          evidence: "required validation failing: bun run web:e2e",
        },
      ],
      repo_health_flags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
        dispatch_lock_held: false,
        required_validation_red: true,
      },
      validation_incident: {
        active: true,
        incident_id: "valid_inc_web_e2e",
        command: "bun run web:e2e",
        signal_type: "test_failure",
        failure_class: "browser_smoke_failed",
        failure_count: 4,
        total_runs: 5,
        failed_job_ids: ["job_a", "job_b", "job_c", "job_d"],
        last_failed_job_id: "job_d",
        first_failed_at: "2026-06-14T20:00:00.000Z",
        last_failed_at: "2026-06-14T20:05:00.000Z",
        digest: "web_e2e_digest",
        sample_error: "scripts/test-web-e2e.js:12 browser smoke assertion failed",
        required_commands: ["bun test", "bun run web:e2e"],
        target_path_hints: ["scripts/test-web-e2e.js"],
        failed_tests: ["route shell > renders account navigation without startup failure"],
        failure_fingerprint: "fp_web_e2e",
        baseline_sha: "b".repeat(40),
        candidate_sha: "c".repeat(40),
        candidate_ref: "refs/pushpals/review/pr-626",
        candidate_shas: ["c".repeat(40)],
        validation_scope: "candidate_specific" as const,
        evidence_quality: "high" as const,
        failure_lines: ["FAIL scripts/test-web-e2e.js > route shell teardown"],
        source: "trusted_host" as const,
        cross_job_circuit_open: true,
      },
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot")) return jsonResponse(200, { ok: true, snapshot });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/requests/enqueue"))
        return jsonResponse(201, {
          ok: true,
          requestId: "req_validation_repair",
          dispatchConfirmed: true,
        });
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_validation_repair",
          patternKey: "pk_validation_repair",
        });
      }
      if (url.includes("/autonomy/inspiration")) {
        throw new Error("inspiration should not run during validation repair mode");
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCall += 1;
        throw new Error("LLM should not run during validation repair mode");
      },
    };
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_red",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).ensureAutonomyRepoReady = async () => true;
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Keep required validation trustworthy.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Restore failing validation baselines.",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: ["reliability"],
        objectives: ["trustworthy validation"],
        guardrails: ["small scoped changes"],
        constraints: ["safe defaults"],
        non_goals: [],
        metrics: ["green required validation"],
        risk_policy: ["low risk repairs"],
        operating_model: ["repair failing baselines"],
        governance: ["report environment blockers"],
      },
      section_numbers: ["1"],
      sha256: "visionhash",
      truncated: false,
    });

    await engine.tick();

    expect(llmCall).toBe(0);
    expect(calls.some((entry) => entry.url.includes("/autonomy/inspiration"))).toBe(false);
    const enqueueCall = calls.find((entry) => entry.url.endsWith("/requests/enqueue"));
    expect(enqueueCall).toBeDefined();
    expect(JSON.stringify(enqueueCall?.body ?? {})).toContain("bun run web:e2e");
    expect(JSON.stringify(enqueueCall?.body ?? {})).toContain(
      "route shell > renders account navigation without startup failure",
    );
    expect(JSON.stringify(enqueueCall?.body ?? {})).toContain(
      "same deterministic publication failure",
    );
    expect(JSON.stringify(enqueueCall?.body ?? {})).toContain("c".repeat(40));
    expect(
      ((enqueueCall?.body as Record<string, any>)?.metadata?.autonomy?.validationIncident ?? {})
        .candidateSha,
    ).toBe("c".repeat(40));
    const eligibilityCall = calls.find((entry) => entry.url.endsWith("/autonomy/eligibility"));
    const eligibilityCandidates = ((eligibilityCall?.body as Record<string, unknown> | undefined)
      ?.candidates ?? []) as Array<Record<string, unknown>>;
    expect(eligibilityCandidates[0]?.required_validation_repair).toBe(true);
    expect(objectivePosts.length).toBe(1);
    const postedCandidates = (objectivePosts[0]?.candidates ?? []) as Array<
      Record<string, unknown>
    >;
    expect(postedCandidates[0]?.required_validation_repair).toBe(true);
    const objective = (objectivePosts[0]?.objective ?? {}) as Record<string, unknown>;
    expect(String(objective.status ?? "")).toBe("gated");
    expect(String(objective.objective_type ?? "")).toBe("flaky_test");
    expect(String(objective.trigger_type ?? "")).toBe("test_failure");
    expect(objective.target_paths).toEqual(["scripts/test-web-e2e.js"]);
    expect(objective.expected_validation).toEqual(["bun run web:e2e", "bun test"]);
    expect(objective.required_validation_repair).toBe(true);
    expect(objective.incident_key).toBe("valid_inc_web_e2e");
  });

  test("rechecks active snapshot authority after validation-repair lock renewal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-renew-fence-"));
    tempDirs.push(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "account.test.ts"), "// repair target\n", "utf8");
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_renew_fence",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).autonomyRepo = root;
    (engine as any).fetchEligibility = async (
      _runId: string,
      _snapshotId: string,
      candidates: any[],
    ) => new Map(candidates.map((candidate) => [candidate.id, { ok: true }]));
    let markRenewStarted: (() => void) | null = null;
    const renewStarted = new Promise<void>((resolveStarted) => {
      markRenewStarted = resolveStarted;
    });
    let finishRenew: ((value: boolean) => void) | null = null;
    const delayedRenew = new Promise<boolean>((resolveRenew) => {
      finishRenew = resolveRenew;
    });
    (engine as any).renewDispatchLock = async () => {
      markRenewStarted?.();
      return await delayedRenew;
    };
    let reservations = 0;
    let enqueues = 0;
    (engine as any).postObjective = async () => {
      reservations++;
      return true;
    };
    (engine as any).enqueueSyntheticRequest = async () => {
      enqueues++;
      return "must-not-enqueue";
    };
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: {
        active: true,
        incident_id: "valid_inc_renew_fence",
        command: "bun test tests/account.test.ts",
        signal_type: "test_failure",
        failure_class: "test_failure",
        failure_count: 2,
        total_runs: 2,
        failed_job_ids: ["job-a", "job-b"],
        last_failed_job_id: "job-b",
        first_failed_at: new Date(Date.now() - 2_000).toISOString(),
        last_failed_at: new Date(Date.now() - 1_000).toISOString(),
        digest: "renew-fence",
        sample_error: "account assertion failed",
        required_commands: ["bun test tests/account.test.ts"],
        target_path_hints: ["tests/account.test.ts"],
        failed_tests: ["account state remains stable"],
        failure_fingerprint: "fp-renew-fence",
        candidate_sha: "c".repeat(40),
        candidate_shas: ["c".repeat(40)],
        validation_scope: "candidate_specific" as const,
        evidence_quality: "high" as const,
        failure_lines: ["(fail) account state remains stable"],
        source: "trusted_host" as const,
        cross_job_circuit_open: true,
      },
    };
    const cycleController = new AbortController();
    const pending = (engine as any).dispatchValidationIncidentRepair({
      runId: "run-validation-renew-fence",
      snapshot,
      repoTargets: [],
      visionSectionRefs: ["1"],
      cycleDeadline: Date.now() + 30_000,
      cycleSignal: cycleController.signal,
    });
    await renewStarted;

    engine.setRuntimeEnabled(false);
    cycleController.abort(new Error("runtime disabled"));
    finishRenew?.(true);
    const result = await pending;

    expect(result).toEqual({
      handled: true,
      outcome: "skipped",
      detail: "disabled_after_validation_repair_lock_renew",
    });
    expect(reservations).toBe(0);
    expect(enqueues).toBe(0);
  });

  test("repair circuit counts only executed same-fingerprint failures and continues ideation", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-circuit-"));
    tempDirs.push(root);
    const targetPath = join(root, "tests", "account.test.ts");
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, "// validation target\n", "utf8");
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_circuit",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const incident = {
      active: true,
      incident_id: "valid_inc_account_stable",
      command: "bun test tests/account.test.ts",
      signal_type: "test_failure",
      failure_class: "test_failure",
      failure_count: 4,
      total_runs: 4,
      failed_job_ids: ["job_a", "job_b"],
      last_failed_job_id: "job_b",
      first_failed_at: "2026-08-17T01:00:00.000Z",
      last_failed_at: "2026-08-17T01:05:00.000Z",
      digest: "account_stable",
      sample_error: "(fail) account state remains stale",
      required_commands: ["bun test tests/account.test.ts"],
      target_path_hints: ["tests/account.test.ts"],
      failed_tests: ["account state remains stale"],
      failure_fingerprint: "fp_account_stable",
      candidate_sha: "c".repeat(40),
      candidate_shas: ["c".repeat(40)],
      validation_scope: "candidate_specific" as const,
      baseline_failure_proven: false,
      evidence_quality: "high" as const,
      failure_lines: ["(fail) account state remains stale"],
      source: "trusted_host" as const,
      cross_job_circuit_open: true,
    };
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: incident,
      recent_objectives: [
        {
          objective_id: "obj_never_executed",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          status: "failed",
        },
        {
          objective_id: "obj_rejected",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          job_id: "job_rejected",
          status: "rejected",
        },
        {
          objective_id: "obj_executed_a",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          job_id: "job_repair_a",
          attempt_outcome: "validation_blocked",
          deterministic_repair_failure: true,
          attempt_failure_fingerprint: "fp_account_stable",
          status: "failed",
        },
        {
          objective_id: "obj_executed_b",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          job_id: "job_repair_b",
          attempt_outcome: "quality_rejected",
          deterministic_repair_failure: true,
          attempt_failure_fingerprint: "fp_account_stable",
          status: "dead_letter",
        },
      ],
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("circuit-open repair must not call eligibility or enqueue");
    }) as typeof globalThis.fetch;

    const outcome = await (engine as any).dispatchValidationIncidentRepair({
      runId: "run_validation_circuit",
      snapshot,
      repoTargets: [],
      visionSectionRefs: ["1"],
    });

    expect(outcome).toEqual({
      handled: false,
      outcome: "skipped",
      detail: "validation_repair_circuit_open_continue_ideation",
    });
    expect(fetchCalls).toBe(0);
  });

  test("two different deterministic repair failures do not open the incident circuit", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-changed-failure-"));
    tempDirs.push(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "account.test.ts"), "// target\n", "utf8");
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_changed_failure",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const incident = {
      active: true,
      incident_id: "valid_inc_account_changed_failure",
      command: "bun test tests/account.test.ts",
      signal_type: "test_failure",
      failure_class: "test_failure",
      failure_count: 2,
      total_runs: 2,
      failed_job_ids: ["job_a", "job_b"],
      last_failed_job_id: "job_b",
      first_failed_at: "2026-08-17T01:00:00.000Z",
      last_failed_at: "2026-08-17T01:05:00.000Z",
      digest: "account_changed_failure",
      sample_error: "(fail) account state remains stale",
      required_commands: ["bun test tests/account.test.ts"],
      target_path_hints: ["tests/account.test.ts"],
      failed_tests: ["account state remains stale"],
      failure_fingerprint: "fp_account_current",
      candidate_sha: "c".repeat(40),
      candidate_shas: ["c".repeat(40)],
      validation_scope: "candidate_specific" as const,
      baseline_failure_proven: false,
      evidence_quality: "high" as const,
      failure_lines: ["(fail) account state remains stale"],
      source: "trusted_host" as const,
      cross_job_circuit_open: true,
    };
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: incident,
      recent_objectives: [
        {
          objective_id: "obj_different_a",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          job_id: "job_different_a",
          attempt_outcome: "validation_blocked",
          deterministic_repair_failure: true,
          attempt_failure_fingerprint: "fp_different_a",
          status: "failed",
        },
        {
          objective_id: "obj_different_b",
          pattern_key: "pk_validation",
          incident_key: incident.incident_id,
          job_id: "job_different_b",
          attempt_outcome: "quality_rejected",
          deterministic_repair_failure: true,
          attempt_failure_fingerprint: "fp_different_b",
          status: "dead_letter",
        },
      ],
    };
    let eligibilityCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (url.endsWith("/autonomy/eligibility")) {
        eligibilityCalls += 1;
        const candidates = Array.isArray(body.candidates) ? body.candidates : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((candidate: Record<string, unknown>) => ({
            candidate_id: candidate.id,
            ok: false,
            reason: "changed_failure_test_gate",
          })),
        });
      }
      if (url.endsWith("/autonomy/objectives")) return jsonResponse(201, { ok: true });
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof globalThis.fetch;

    const outcome = await (engine as any).dispatchValidationIncidentRepair({
      runId: "run_validation_changed_failure",
      snapshot,
      repoTargets: [],
      visionSectionRefs: ["1"],
    });

    expect(eligibilityCalls).toBe(1);
    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("validation_repair_not_eligible");
    expect(outcome.detail).toContain("continue_ideation");
    expect(outcome.detail).not.toContain("circuit_open");
  });

  test("candidate-specific repairs preserve a failing file added only by the candidate", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-candidate-only-path-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_candidate_only_path",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const candidateOnlyPath = "src/new-candidate-only.test.ts";
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: {
        active: true,
        incident_id: "valid_inc_candidate_only_path",
        command: `bun test ${candidateOnlyPath}`,
        signal_type: "test_failure",
        failure_class: "test_failure",
        failure_count: 2,
        total_runs: 2,
        failed_job_ids: ["job_a", "job_b"],
        last_failed_job_id: "job_b",
        first_failed_at: "2026-08-17T01:00:00.000Z",
        last_failed_at: "2026-08-17T01:05:00.000Z",
        digest: "candidate_only_path",
        sample_error: `(fail) ${candidateOnlyPath} remains broken`,
        required_commands: [`bun test ${candidateOnlyPath}`],
        target_path_hints: [candidateOnlyPath],
        failed_tests: ["candidate-only file remains broken"],
        failure_fingerprint: "fp_candidate_only_path",
        candidate_sha: "c".repeat(40),
        candidate_shas: ["c".repeat(40)],
        validation_scope: "candidate_specific" as const,
        baseline_failure_proven: false,
        evidence_quality: "high" as const,
        failure_lines: [`(fail) ${candidateOnlyPath} remains broken`],
        source: "trusted_host" as const,
        cross_job_circuit_open: true,
      },
    };
    let eligibilityCandidates: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (url.endsWith("/autonomy/eligibility")) {
        eligibilityCandidates = Array.isArray(body.candidates) ? body.candidates : [];
        return jsonResponse(200, {
          ok: true,
          results: eligibilityCandidates.map((candidate) => ({
            candidate_id: candidate.id,
            ok: false,
            reason: "candidate_path_test_gate",
          })),
        });
      }
      if (url.endsWith("/autonomy/objectives")) return jsonResponse(201, { ok: true });
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof globalThis.fetch;

    await (engine as any).dispatchValidationIncidentRepair({
      runId: "run_candidate_only_path",
      snapshot,
      repoTargets: [],
      visionSectionRefs: ["1"],
    });

    expect(existsSync(join(root, candidateOnlyPath))).toBe(false);
    expect(eligibilityCandidates[0]?.target_paths).toEqual([candidateOnlyPath]);
  });

  test("an active exact-incident repair leaves the tick free to ideate elsewhere", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-active-"));
    tempDirs.push(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "account.test.ts"), "// target\n", "utf8");
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_active",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const incident = {
      active: true,
      incident_id: "valid_inc_account_active",
      command: "bun test tests/account.test.ts",
      signal_type: "test_failure",
      failure_class: "test_failure",
      failure_count: 2,
      total_runs: 2,
      failed_job_ids: ["job_a", "job_b"],
      last_failed_job_id: "job_b",
      first_failed_at: "2026-08-17T01:00:00.000Z",
      last_failed_at: "2026-08-17T01:05:00.000Z",
      digest: "account_active",
      sample_error: "(fail) account state remains stale",
      required_commands: ["bun test tests/account.test.ts"],
      target_path_hints: ["tests/account.test.ts"],
      failed_tests: ["account state remains stale"],
      failure_fingerprint: "fp_account_active",
      candidate_sha: "c".repeat(40),
      candidate_shas: ["c".repeat(40)],
      validation_scope: "candidate_specific" as const,
      baseline_failure_proven: false,
      evidence_quality: "high" as const,
      failure_lines: ["(fail) account state remains stale"],
      source: "trusted_host" as const,
      cross_job_circuit_open: true,
    };
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: incident,
      open_objectives: [
        {
          objective_id: "obj_active_repair",
          status: "running",
          objective_type: "flaky_test",
          pattern_key: "pk_validation_active",
          incident_key: incident.incident_id,
          job_id: "job_active_repair",
          updated_at: "2026-08-17T01:06:00.000Z",
        },
      ],
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("active repair path must not enqueue a duplicate");
    }) as typeof globalThis.fetch;

    expect(
      await (engine as any).dispatchValidationIncidentRepair({
        runId: "run_validation_active",
        snapshot,
        repoTargets: [],
        visionSectionRefs: ["1"],
      }),
    ).toEqual({
      handled: false,
      outcome: "skipped",
      detail: "validation_repair_already_active_continue_ideation",
    });
    expect(fetchCalls).toBe(0);
  });

  test("a completed repair waits for validation evidence newer than the repaired incident", async () => {
    originalFetch = globalThis.fetch;
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-completed-"));
    tempDirs.push(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "catalog.test.ts"), "// target\n", "utf8");
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_completed",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const incident = {
      active: true,
      incident_id: "valid_inc_catalog_completed",
      command: "bun test tests/catalog.test.ts",
      signal_type: "test_failure",
      failure_class: "test_failure",
      failure_count: 2,
      total_runs: 2,
      failed_job_ids: ["job_a", "job_b"],
      last_failed_job_id: "job_b",
      first_failed_at: "2026-08-17T01:00:00.000Z",
      last_failed_at: "2026-08-17T01:05:00.000Z",
      digest: "catalog_completed",
      sample_error: "(fail) catalog ranking remains stale",
      required_commands: ["bun test tests/catalog.test.ts"],
      target_path_hints: ["tests/catalog.test.ts"],
      failed_tests: ["catalog ranking remains stale"],
      failure_fingerprint: "fp_catalog_completed",
      candidate_sha: "c".repeat(40),
      candidate_shas: ["c".repeat(40)],
      validation_scope: "candidate_specific" as const,
      baseline_failure_proven: false,
      evidence_quality: "high" as const,
      failure_lines: ["(fail) catalog ranking remains stale"],
      source: "trusted_host" as const,
      cross_job_circuit_open: true,
    };
    const snapshot = {
      ...makeSnapshot(),
      validation_incident: incident,
      recent_objectives: [
        {
          objective_id: "obj_completed_repair",
          status: "completed",
          objective_type: "flaky_test",
          pattern_key: "pk_validation_completed",
          incident_key: incident.incident_id,
          job_id: "job_completed_repair",
          updated_at: "2026-08-17T01:06:00.000Z",
        },
      ],
    };
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("completed repair must await fresh incident evidence");
    }) as typeof globalThis.fetch;

    expect(
      await (engine as any).dispatchValidationIncidentRepair({
        runId: "run_validation_completed",
        snapshot,
        repoTargets: [],
        visionSectionRefs: ["1"],
      }),
    ).toEqual({
      handled: false,
      outcome: "skipped",
      detail: "validation_repair_completed_awaiting_fresh_evidence_continue_ideation",
    });
    expect(fetchCalls).toBe(0);
  });

  test("validation repair ignores trusted-environment incidents from older server snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-validation-environment-"));
    tempDirs.push(root);
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_validation_environment",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          throw new Error("LLM should not run");
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    const snapshot = {
      ...makeSnapshot(),
      repo_health_flags: {
        ...makeSnapshot().repo_health_flags,
        required_validation_red: true,
      },
      validation_incident: {
        active: true,
        incident_id: "valid_inc_environment",
        command: "bun run validate",
        signal_type: "test_failure",
        failure_class: "environment",
        failure_count: 4,
        total_runs: 4,
        failed_job_ids: ["job_a", "job_b", "job_c", "job_d"],
        last_failed_job_id: "job_d",
        first_failed_at: "2026-08-06T01:00:00.000Z",
        last_failed_at: "2026-08-06T02:00:00.000Z",
        digest: "environment_digest",
        sample_error:
          "Trusted-environment validation deferred before execution because the worker sandbox intentionally has no Docker socket. Run this command on the trusted host.",
        required_commands: ["bun run validate"],
        target_path_hints: ["package.json"],
      },
    };

    const outcome = await (engine as any).dispatchValidationIncidentRepair({
      runId: "run_validation_environment",
      snapshot,
      repoTargets: [],
      visionSectionRefs: ["1"],
    });

    expect(outcome).toEqual({
      handled: false,
      outcome: "skipped",
      detail: "no_validation_incident",
    });
  });

  test("tick records blocked objective with question when candidate requires user input", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-tick-blocked-"));
    tempDirs.push(root);
    seedPushpalsAutonomyRepoLayout(root);
    const calls: FetchCall[] = [];
    const objectivePosts: Array<Record<string, unknown>> = [];
    let llmCall = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot"))
        return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 1, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_tick_blocked",
          questionId: "q_tick_1",
          patternKey: "pk_blocked",
        });
      }
      if (url.endsWith("/requests/enqueue")) {
        throw new Error("requests/enqueue should not be called for requires_user_input candidates");
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCall += 1;
        if (llmCall === 1) {
          return {
            text: JSON.stringify({
              candidates: [
                {
                  id: "cand_tick_blocked",
                  title: "Need clarification",
                  objective_type: "lint_fix",
                  problem_statement: "Clarify exact scope before edits.",
                  trigger_type: "lint_failure",
                  component_area: "apps/server",
                  target_paths: ["apps/server/src/autonomy.ts"],
                  scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
                  risk_level: "low",
                  expected_validation: ["bun run test:root"],
                  estimated_effort: "small",
                  why_now_signal_ids: ["sig_queue"],
                  confidence: 0.9,
                  vision_alignment_reason: "Need clear scope first.",
                  vision_section_refs: ["1"],
                  feature_hypotheses: ["Clarified scope will reduce rework."],
                  requires_user_input: true,
                  question_if_blocked: "Which server module should be prioritized first?",
                },
              ],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({
            scores: [{ id: "cand_tick_blocked", llm_score: 0.9 }],
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const comm = {
      async emit() {
        return true;
      },
    };

    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_tick_blocked",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: makeConfig(),
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Improve autonomous throughput safely.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Focus queue and reliability",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: [],
        objectives: [],
        guardrails: ["small scoped changes"],
        constraints: ["safe defaults"],
        non_goals: [],
        metrics: ["queue p95"],
        risk_policy: ["low risk autonomous"],
        operating_model: ["remotebuddy + workerpals"],
        governance: ["review high risk manually"],
      },
      section_numbers: ["1"],
      sha256: "visionhash",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];

    await engine.tick();

    expect(objectivePosts.length).toBeGreaterThan(0);
    const objective = (objectivePosts[objectivePosts.length - 1]?.objective ?? {}) as Record<
      string,
      unknown
    >;
    expect(String(objective.status ?? "")).toBe("blocked");
    const question = (objectivePosts[objectivePosts.length - 1]?.question ?? {}) as Record<
      string,
      unknown
    >;
    expect(String(question.question ?? "")).toContain(
      "Which server module should be prioritized first?",
    );
    expect(calls.some((entry) => entry.url.endsWith("/requests/enqueue"))).toBe(false);
  });

  test("runtime disable short-circuits tick and start", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-disabled-"));
    tempDirs.push(root);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse(200, { ok: true });
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        return {
          text: JSON.stringify({ candidates: [] }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const comm = {
      async emit() {
        return true;
      },
    };

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.tickIntervalMs = 25;
    cfg.remotebuddy.autonomy.heartbeatLogMs = 25;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_disabled",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: cfg,
    });

    engine.setRuntimeEnabled(false);
    await engine.tick();
    expect(fetchCalls).toBe(0);

    engine.start();
    await Bun.sleep(80);
    expect(fetchCalls).toBe(0);

    engine.stop();
    engine.setRuntimeEnabled(true);
    engine.start();
    await engine.tick();
    await Bun.sleep(40);
    expect((engine as any).runtimeEnabled).toBe(false);
    expect((engine as any).stopped).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  test("runtime disable is a resumable pause while stop remains terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-resumable-pause-"));
    tempDirs.push(root);
    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.tickIntervalMs = 20;
    cfg.remotebuddy.autonomy.heartbeatLogMs = 10_000;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_resumable_pause",
      authToken: "tok",
      repo: root,
      llm: { async generate() {} } as any,
      comm: { async emit() {} } as any,
      config: cfg,
    });
    let ticks = 0;
    (engine as any).tick = async () => {
      ticks++;
    };

    engine.setRuntimeEnabled(false);
    engine.start();
    await Bun.sleep(50);
    expect(ticks).toBe(0);

    engine.setRuntimeEnabled(true);
    await Bun.sleep(50);
    expect(ticks).toBeGreaterThan(0);
    engine.setRuntimeEnabled(false);
    const pausedAt = ticks;
    await Bun.sleep(50);
    expect(ticks).toBe(pausedAt);

    engine.setRuntimeEnabled(true);
    await Bun.sleep(50);
    expect(ticks).toBeGreaterThan(pausedAt);
    engine.stop();
    const stoppedAt = ticks;
    engine.setRuntimeEnabled(true);
    engine.start();
    await Bun.sleep(50);
    expect(ticks).toBe(stoppedAt);
    expect((engine as any).stopped).toBe(true);
  });

  test("startup lock contention retries quickly with aggressive stale lock threshold", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-startup-lock-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });
      if (url.includes("/autonomy/lock/acquire")) {
        return jsonResponse(409, {
          ok: false,
          reason: "dispatch lock held by run_previous until 2099-01-01T00:00:00.000Z",
        });
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.tickIntervalMs = 10_000;
    cfg.remotebuddy.autonomy.heartbeatLogMs = 10_000;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_startup_lock",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({ candidates: [] }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      } as any,
      comm: {
        async emit() {
          return true;
        },
      } as any,
      config: cfg,
    });

    engine.start();
    await Bun.sleep(2_400);
    engine.stop();

    const acquireCalls = calls.filter((entry) => entry.url.includes("/autonomy/lock/acquire"));
    expect(acquireCalls.length).toBeGreaterThanOrEqual(2);
    expect(Number((acquireCalls[0].body as Record<string, unknown>).staleAfterMs)).toBe(5_000);
  });

  test("startup grace delays first autonomy tick so cold-start capacity stays available", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-startup-grace-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });
      if (url.includes("/autonomy/lock/acquire")) {
        return jsonResponse(409, {
          ok: false,
          reason: "dispatch lock held by run_previous until 2099-01-01T00:00:00.000Z",
        });
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.tickIntervalMs = 10_000;
    cfg.remotebuddy.autonomy.heartbeatLogMs = 1_000;
    cfg.remotebuddy.autonomy.startupGraceMs = 80;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_startup_grace",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({ candidates: [] }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      } as any,
      comm: {
        async emit() {
          return true;
        },
      } as any,
      config: cfg,
    });

    engine.start();
    await Bun.sleep(35);
    expect(calls.filter((entry) => entry.url.includes("/autonomy/lock/acquire")).length).toBe(0);

    await Bun.sleep(90);
    engine.stop();

    expect(calls.filter((entry) => entry.url.includes("/autonomy/lock/acquire")).length).toBe(1);
  });

  test("tick short-circuits when snapshot kill switch is enabled", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-killswitch-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    let llmCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot")) {
        const snapshot = makeSnapshot();
        return jsonResponse(200, {
          ok: true,
          snapshot: {
            ...snapshot,
            safety_state: { kill_switch_enabled: true },
          },
        });
      }
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCalls += 1;
        return {
          text: JSON.stringify({ candidates: [] }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const comm = {
      async emit() {
        return true;
      },
    };

    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_killswitch",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: makeConfig(),
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };

    await engine.tick();

    expect(llmCalls).toBe(0);
    expect(calls.some((entry) => entry.url.includes("/autonomy/snapshot"))).toBe(true);
    expect(calls.some((entry) => entry.url.includes("/autonomy/lock/release"))).toBe(true);
    expect((engine as any).lastOutcome).toBe("skipped");
    expect((engine as any).lastDetail).toBe("kill_switch_enabled");
  });

  test.each([false, true])(
    "tick defers ideation for busy workers or runtime admission (circuit=%s)",
    async (circuit) => {
      originalFetch = globalThis.fetch;
      mockGitSpawnForTest();
      const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-worker-load-"));
      tempDirs.push(root);
      const calls: FetchCall[] = [];
      let llmCalls = 0;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = String(init?.method ?? "GET").toUpperCase();
        const bodyRaw = typeof init?.body === "string" ? init.body : "";
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        calls.push({ url, method, body });

        if (url.includes("/autonomy/lock/acquire"))
          return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
        if (url.includes("/autonomy/lock/release"))
          return jsonResponse(200, { ok: true, released: true });
        if (url.includes("/autonomy/snapshot"))
          return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
        if (url.includes("/workers/autoscale"))
          return jsonResponse(200, {
            ok: true,
            workers: { total: 2, online: 2, busy: circuit ? 0 : 1, idle: circuit ? 2 : 1 },
            jobs: {
              pending: circuit ? 0 : 2,
              claimed: circuit ? 0 : 1,
              autoscalablePending: circuit ? 0 : 1,
            },
            prs: { openUnmerged: 2 },
            ...(circuit
              ? {
                  autonomyAdmission: {
                    allowed: false,
                    code: "autonomy_worker_runtime_circuit_open",
                    retryAfterMs: 60_000,
                  },
                }
              : {}),
          });
        throw new Error(`Unhandled fetch in test: ${method} ${url}`);
      }) as typeof globalThis.fetch;

      const llm = {
        async generate() {
          llmCalls += 1;
          return {
            text: JSON.stringify({ candidates: [] }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      };
      const comm = {
        async emit() {
          return true;
        },
      };

      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "s_worker_load",
        authToken: "tok",
        repo: root,
        llm: llm as any,
        comm: comm as any,
        config: makeConfig(),
        repositoryAgent: {
          ask: async () => {
            throw new Error("must not spend repository-agent tokens");
          },
        } as any,
      });
      (engine as any).ensureAutonomyRepoReady = async () => {
        const autonomyRepo = String((engine as any).autonomyRepo ?? "");
        mkdirSync(autonomyRepo, { recursive: true });
        seedPushpalsAutonomyRepoLayout(autonomyRepo);
        return true;
      };

      await engine.tick();

      expect(llmCalls).toBe(0);
      expect(calls.some((entry) => entry.url.includes("/workers/autoscale"))).toBe(true);
      expect(calls.some((entry) => entry.url.includes("/autonomy/inspiration"))).toBe(false);
      expect((engine as any).lastOutcome).toBe("skipped");
      expect((engine as any).lastDetail).toBe(
        circuit
          ? "autonomy_admission:autonomy_worker_runtime_circuit_open"
          : "worker_load_busy_1_pending_2_autoscalable_1",
      );
    },
  );

  test("worker-load backpressure drains publication first, then uses safe idle capacity", () => {
    const engine = Object.create(RemoteBuddyAutonomousEngine.prototype) as {
      deferReasonForWorkerLoad: (snapshot: unknown) => string | null;
    };
    const healthyCapacity = {
      workers: { total: 3, online: 3, busy: 1, idle: 2 },
      jobs: { pending: 0, claimed: 1, autoscalablePending: 0, finalizing: 1 },
      completions: { pending: 0, claimed: 1 },
      publication: {
        backlog: 1,
        oldestPendingAgeMs: 20_000,
        oldestFinalizingAgeMs: 20_000,
        expiredClaims: 0,
        unhealthy: false,
      },
      prs: { openUnmerged: 1 },
    };
    expect(engine.deferReasonForWorkerLoad(healthyCapacity)).toBeNull();
    expect(
      engine.deferReasonForWorkerLoad({
        ...healthyCapacity,
        autonomyAdmission: { allowed: true },
      }),
    ).toBeNull();

    expect(
      engine.deferReasonForWorkerLoad({
        ...healthyCapacity,
        completions: { pending: 5, claimed: 1 },
        publication: {
          ...healthyCapacity.publication,
          backlog: 6,
          oldestPendingAgeMs: 20 * 60_000,
          unhealthy: true,
        },
      }),
    ).toBe("publication_backpressure_backlog_6_oldest_1200000");
  });

  test("tick stops at repo preflight when worktree is dirty and allowDirtyWorktree is false", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnWithDirtyWorktree();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-dirty-preflight-"));
    tempDirs.push(root);
    const calls: FetchCall[] = [];
    let llmCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCalls += 1;
        return {
          text: JSON.stringify({ candidates: [] }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const comm = {
      async emit() {
        return true;
      },
    };

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.allowDirtyWorktree = false;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_dirty_preflight",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: cfg,
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };

    await engine.tick();

    expect(llmCalls).toBe(0);
    expect(calls.some((entry) => entry.url.includes("/autonomy/snapshot"))).toBe(false);
    expect(calls.some((entry) => entry.url.includes("/autonomy/lock/release"))).toBe(true);
    expect((engine as any).lastOutcome).toBe("skipped");
    expect((engine as any).lastDetail).toBe("repo_preflight_dirty_worktree");
  });

  test("ideation timeout retries once immediately with reduced recovery guidance", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-timeout-recovery-"));
    tempDirs.push(root);
    seedPushpalsAutonomyRepoLayout(root);
    const objectivePosts: Array<Record<string, unknown>> = [];
    const llmInputs: Array<Record<string, unknown>> = [];
    let llmCall = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot"))
        return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 1, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/requests/enqueue"))
        return jsonResponse(201, {
          ok: true,
          requestId: "req_timeout_recovery_1",
          dispatchConfirmed: true,
        });
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_timeout_recovery_1",
          patternKey: "pk_timeout_recovery_1",
        });
      }
      throw new Error(`Unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate(input: Record<string, unknown>) {
        llmInputs.push(input);
        llmCall += 1;
        if (llmCall === 1) {
          expect(input.maxTokens).toBe(1800);
          const initialPayload = JSON.parse(
            String(
              ((input.messages as Array<Record<string, unknown>>)?.[0]?.content ?? "") as string,
            ),
          ) as Record<string, unknown>;
          expect(JSON.stringify(initialPayload).length).toBeLessThan(12_000);
          expect(
            Number((initialPayload.limits as Record<string, unknown>).ideation_max_candidates),
          ).toBeLessThanOrEqual(5);
          await Bun.sleep(1_100);
          return {
            text: JSON.stringify({ candidates: [] }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        if (llmCall === 2) {
          const recoveryMessage = String(
            ((input.messages as Array<Record<string, unknown>>)?.[0]?.content ?? "") as string,
          );
          expect(recoveryMessage).toContain(
            "Previous ideation timed out before you returned JSON.",
          );
          expect(recoveryMessage).toContain("Timeout budget for this round: 1000ms.");
          expect(input.maxTokens).toBe(900);
          const retryPayload = JSON.parse(
            String(
              ((input.messages as Array<Record<string, unknown>>)?.[1]?.content ?? "") as string,
            ),
          ) as Record<string, unknown>;
          expect(JSON.stringify(retryPayload).length).toBeLessThan(12_000);
          expect(
            Number((retryPayload.limits as Record<string, unknown>).ideation_max_candidates),
          ).toBeLessThanOrEqual(3);
          return {
            text: JSON.stringify({
              candidates: [
                {
                  id: "cand_timeout_recovery_1",
                  title: "Recover from ideation timeout",
                  objective_type: "lint_fix",
                  problem_statement: "Keep ideation responsive under codex latency.",
                  trigger_type: "queue_health",
                  component_area: "apps/remotebuddy",
                  target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
                  scope: {
                    read_anywhere: false,
                    write_globs: ["apps/remotebuddy/src/autonomous_engine.ts"],
                  },
                  risk_level: "low",
                  expected_validation: [
                    "bun test tests/remotebuddy.autonomous-engine.tick.test.ts",
                  ],
                  estimated_effort: "small",
                  why_now_signal_ids: ["sig_queue"],
                  confidence: 0.9,
                  vision_alignment_reason: "Improve autonomy reliability under timeout pressure.",
                  vision_section_refs: ["1"],
                  feature_hypotheses: ["One-shot recovery reduces repeated empty autonomy cycles."],
                  requires_user_input: false,
                },
              ],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        if (llmCall === 3) {
          return {
            text: JSON.stringify({
              scores: [{ id: "cand_timeout_recovery_1", llm_score: 0.92 }],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({
            instruction: "Keep autonomy ideation responsive and well-instrumented.",
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const comm = {
      async emit() {
        return true;
      },
    };

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.llmTimeoutMs = 15;
    cfg.remotebuddy.llm.codexTimeoutMs = 15;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_timeout_recovery",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: comm as any,
      config: cfg,
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Keep autonomy responsive.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Favor reliable small fixes.",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: ["reliability"],
        objectives: ["avoid repeated autonomy stalls"],
        guardrails: ["small scoped changes"],
        constraints: ["stay within time budgets"],
        non_goals: [],
        metrics: ["autonomy completion rate"],
        risk_policy: ["low risk autonomous"],
        operating_model: ["remotebuddy + workerpals"],
        governance: ["review high risk manually"],
      },
      section_numbers: ["1"],
      sha256: "visionhash",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];

    await engine.tick();
    expect((engine as any).lastOutcome).toBe("success");
    expect((engine as any).pendingIdeationTimeoutRecovery).toBeNull();
    expect(llmCall).toBe(4);
    expect(objectivePosts.length).toBeGreaterThan(0);
  });

  test("ideation timeout budget expands to match Codex-backed autonomy needs", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-timeout-budget-"));
    tempDirs.push(root);
    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.llmTimeoutMs = 60_000;
    cfg.remotebuddy.llm.codexTimeoutMs = 120_000;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_timeout_budget",
      authToken: "tok",
      repo: root,
      llm: {
        async generate() {
          return {
            text: JSON.stringify({ candidates: [] }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      } as any,
      comm: {
        async emit() {
          return true;
        },
      } as any,
      config: cfg,
    });

    expect((engine as any).phaseTimeoutMs("ideation")).toBe(90_000);
    expect((engine as any).ideationRetryTimeoutMs()).toBe(30_000);
    expect((engine as any).phaseTimeoutMs("scoring")).toBe(60_000);
    expect((engine as any).phaseTimeoutMs("planning")).toBe(60_000);
  });

  test("scoring timeout falls back to deterministic scoring and still dispatches", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-scoring-timeout-"));
    tempDirs.push(root);
    seedPushpalsAutonomyRepoLayout(root);
    const objectivePosts: Array<Record<string, unknown>> = [];
    const requestPosts: Array<Record<string, unknown>> = [];
    let llmCall = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};

      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot"))
        return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 1, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/eligibility")) {
        const candidates = Array.isArray((body as Record<string, unknown>).candidates)
          ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
          : [];
        return jsonResponse(200, {
          ok: true,
          results: candidates.map((entry) => ({
            candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
            ok: true,
          })),
        });
      }
      if (url.endsWith("/requests/enqueue")) {
        requestPosts.push(body as Record<string, unknown>);
        return jsonResponse(201, {
          ok: true,
          requestId: "req_scoring_timeout_1",
          dispatchConfirmed: true,
        });
      }
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, {
          ok: true,
          objectiveId: "obj_scoring_timeout_1",
          patternKey: "pk_scoring_timeout_1",
        });
      }
      throw new Error(`Unhandled fetch in scoring timeout test: ${url}`);
    }) as typeof globalThis.fetch;

    const llm = {
      async generate() {
        llmCall += 1;
        if (llmCall === 1) {
          return {
            text: JSON.stringify({
              candidates: [
                {
                  id: "cand_scoring_timeout_1",
                  title: "Recover from scoring timeout",
                  objective_type: "lint_fix",
                  problem_statement: "Keep autonomy dispatch moving when scoring stalls.",
                  trigger_type: "queue_health",
                  component_area: "apps/remotebuddy",
                  target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
                  scope: {
                    read_anywhere: false,
                    write_globs: ["apps/remotebuddy/src/autonomous_engine.ts"],
                  },
                  risk_level: "low",
                  expected_validation: [
                    "bun test tests/remotebuddy.autonomous-engine.tick.test.ts",
                  ],
                  estimated_effort: "small",
                  why_now_signal_ids: ["sig_queue"],
                  confidence: 0.9,
                  vision_alignment_reason: "Improve autonomy reliability under timeout pressure.",
                  vision_section_refs: ["1"],
                  feature_hypotheses: ["Deterministic scoring can rescue a stalled LLM scorer."],
                  requires_user_input: false,
                },
              ],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        if (llmCall === 2) {
          await Bun.sleep(1_100);
          return {
            text: JSON.stringify({
              scores: [{ id: "cand_scoring_timeout_1", llm_score: 0.95 }],
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({
            instruction: "Keep autonomy scoring resilient under transient Codex stalls.",
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };

    const cfg = makeConfig();
    cfg.remotebuddy.autonomy.llmTimeoutMs = 15;
    cfg.remotebuddy.llm.codexTimeoutMs = 15;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_scoring_timeout",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: {
        async emit() {
          return true;
        },
      } as any,
      config: cfg,
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      mkdirSync(autonomyRepo, { recursive: true });
      seedPushpalsAutonomyRepoLayout(autonomyRepo);
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Keep autonomy responsive.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Favor reliable small fixes.",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: ["reliability"],
        objectives: ["avoid repeated autonomy stalls"],
        guardrails: ["small scoped changes"],
        constraints: ["stay within time budgets"],
        non_goals: [],
        metrics: ["autonomy completion rate"],
        risk_policy: ["low risk autonomous"],
        operating_model: ["remotebuddy + workerpals"],
        governance: ["review high risk manually"],
      },
      section_numbers: ["1"],
      sha256: "visionhash",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];

    await engine.tick();

    expect((engine as any).lastOutcome).toBe("success");
    expect(llmCall).toBe(3);
    expect(objectivePosts.length).toBeGreaterThan(0);
    expect(requestPosts.length).toBe(1);
  });

  test("cancels and drains active scoring and planning phases on cycle abort", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-phase-abort-"));
    tempDirs.push(root);
    let markStarted: (() => void) | null = null;
    let started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let providerActive = false;
    let observedSignal: AbortSignal | undefined;
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_phase_abort",
      authToken: "tok",
      repo: root,
      llm: {
        async generate(input: { signal?: AbortSignal }) {
          observedSignal = input.signal;
          providerActive = true;
          markStarted?.();
          return await new Promise((_resolve, reject) => {
            const onAbort = () => {
              setTimeout(() => {
                providerActive = false;
                reject(input.signal?.reason ?? new Error("phase cancelled"));
              }, 25);
            };
            input.signal?.addEventListener("abort", onAbort, { once: true });
            if (input.signal?.aborted) onAbort();
          });
        },
      } as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });

    for (const phase of ["scoring", "planning"] as const) {
      const controller = new AbortController();
      const pending = (engine as any).llmPhase(
        phase,
        `run-${phase}`,
        `snapshot-${phase}`,
        {
          system: "Return JSON.",
          json: true,
          messages: [{ role: "user", content: "{}" }],
        },
        undefined,
        undefined,
        controller.signal,
      );
      await started;
      const abortedAt = Date.now();
      controller.abort(new Error(`cycle disabled during ${phase}`));

      await expect(pending).rejects.toThrow(`cycle disabled during ${phase}`);
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(20);
      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(observedSignal?.aborted).toBe(true);
      expect(providerActive).toBe(false);
      started = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
    }
    engine.stop();
  });

  test("filters recently completed targets before scoring and records every rejection as unselected", async () => {
    originalFetch = globalThis.fetch;
    mockGitSpawnForTest();
    const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-prescore-diversity-"));
    tempDirs.push(root);
    const objectivePosts: Array<Record<string, unknown>> = [];
    const calls: FetchCall[] = [];
    const now = new Date().toISOString();
    const snapshot = {
      ...makeSnapshot(),
      recent_objectives: [
        {
          id: "obj_recent_src",
          status: "completed",
          objective_type: "small_refactor",
          component_area: "src",
          target_paths: ["src", "package.json", "package-lock.json"],
          scope: { write_globs: ["src/**", "package.json", "package-lock.json"] },
          updated_at: now,
        },
        {
          id: "obj_recent_vision",
          status: "completed",
          objective_type: "docs",
          component_area: "docs",
          target_paths: ["vision.md"],
          scope: { write_globs: ["vision.md"] },
          updated_at: now,
        },
      ],
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      const bodyRaw = typeof init?.body === "string" ? init.body : "";
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      calls.push({ url, method, body });
      if (url.includes("/autonomy/lock/acquire"))
        return jsonResponse(200, { ok: true, lockUntil: now });
      if (url.includes("/autonomy/lock/renew"))
        return jsonResponse(200, { ok: true, lockUntil: now });
      if (url.includes("/autonomy/lock/release"))
        return jsonResponse(200, { ok: true, released: true });
      if (url.includes("/autonomy/snapshot")) return jsonResponse(200, { ok: true, snapshot });
      if (url.includes("/workers/autoscale"))
        return jsonResponse(200, {
          ok: true,
          workers: { total: 1, online: 1, busy: 0, idle: 1 },
          jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
          prs: { openUnmerged: 0 },
        });
      if (url.includes("/autonomy/inspiration/ingest"))
        return jsonResponse(200, { ok: true, inserted: 0, updated: 0, skipped: 0 });
      if (url.includes("/autonomy/inspiration?"))
        return jsonResponse(200, { ok: true, patterns: [] });
      if (url.includes("/autonomy/insights?"))
        return jsonResponse(200, { ok: true, engineSourceStats: [] });
      if (url.endsWith("/autonomy/objectives")) {
        objectivePosts.push(body as Record<string, unknown>);
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`Unexpected post-diversity request: ${method} ${url}`);
    }) as typeof globalThis.fetch;

    const llmInputs: Array<Record<string, unknown>> = [];
    const llm = {
      async generate(input: Record<string, unknown>) {
        llmInputs.push(input);
        if (llmInputs.length > 1) {
          throw new Error("recent targets must be rejected before the scoring LLM call");
        }
        return {
          text: JSON.stringify({
            candidates: [
              {
                id: "cand_recent_target",
                title: "Repeat the recent autonomy target",
                objective_type: "small_refactor",
                problem_statement: "Repeat work that has already completed on this target.",
                trigger_type: "queue_health",
                component_area: "src",
                target_paths: ["src/autonomy.ts"],
                scope: { read_anywhere: false, write_globs: ["src/autonomy.ts"] },
                risk_level: "low",
                expected_validation: ["bun test"],
                estimated_effort: "small",
                why_now_signal_ids: ["sig_queue"],
                confidence: 0.95,
                vision_alignment_reason: "Claims to improve reliability.",
                vision_section_refs: ["1"],
                feature_hypotheses: ["Repeating the same target would not add diversity."],
                requires_user_input: false,
              },
            ],
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const engine = new RemoteBuddyAutonomousEngine({
      server: "http://localhost:3001",
      sessionId: "s_prescore_diversity",
      authToken: "tok",
      repo: root,
      llm: llm as any,
      comm: { async emit() {} } as any,
      config: makeConfig(),
    });
    (engine as any).ensureAutonomyRepoReady = async () => {
      const autonomyRepo = String((engine as any).autonomyRepo ?? "");
      const targetPath = join(autonomyRepo, "src", "autonomy.ts");
      mkdirSync(join(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, "// recent target fixture\n", "utf8");
      writeFileSync(join(autonomyRepo, "vision.md"), "# Vision\n", "utf8");
      writeFileSync(
        join(autonomyRepo, "package.json"),
        JSON.stringify({ scripts: { test: "node --test" } }),
        "utf8",
      );
      writeFileSync(join(autonomyRepo, "package-lock.json"), "{}\n", "utf8");
      return true;
    };
    (engine as any).loadVisionContext = () => ({
      path: "vision.md",
      markdown: "# Vision\n",
      one_sentence: "Improve reliability without repeating completed targets.",
      sections: [
        {
          number: "1",
          title: "Reliability",
          markdown: "Diversify work across product surfaces.",
          truncated: false,
        },
      ],
      key_items: {
        target_users: ["maintainers"],
        priorities: ["reliability"],
        objectives: ["avoid repeated work"],
        guardrails: ["do not repeat recent targets"],
        constraints: [],
        non_goals: [],
        metrics: ["first-pass completion"],
        risk_policy: ["low risk autonomous"],
        operating_model: ["autonomous maintenance"],
        governance: ["review changes"],
      },
      section_numbers: ["1"],
      sha256: "visionhash-prescore",
      truncated: false,
    });
    (engine as any).loadCommitHistoryHints = async () => [];

    await engine.tick();

    expect(llmInputs.length).toBe(1);
    const ideationContent = String(
      ((llmInputs[0]?.messages as Array<Record<string, unknown>>)?.[0]?.content ?? "") as string,
    );
    const ideationPayload = JSON.parse(ideationContent) as Record<string, unknown>;
    const ideationSnapshot = ideationPayload.snapshot as Record<string, unknown>;
    expect(ideationSnapshot.excluded_target_paths).toEqual(
      expect.arrayContaining(["src", "vision.md"]),
    );
    expect(Array.isArray(ideationSnapshot.recent_objectives)).toBe(true);
    expect(calls.some((entry) => entry.url.endsWith("/autonomy/eligibility"))).toBe(false);
    expect(calls.some((entry) => entry.url.endsWith("/requests/enqueue"))).toBe(false);
    expect(objectivePosts).toHaveLength(1);
    const candidates = objectivePosts[0]?.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.selected === false)).toBe(true);
    expect(
      candidates.every((candidate) =>
        String(candidate.rejection_reason ?? "").startsWith("work_diversity_target_recent:"),
      ),
    ).toBe(true);
    expect((engine as any).lastDetail).toBe("no_eligible_candidates");
  });

  test.each([false, true])(
    "generic repo tick dispatches or records the admission rejection (rejected=%s)",
    async (rejected) => {
      originalFetch = globalThis.fetch;
      mockGitSpawnForTest();
      const root = mkdtempSync(join(tmpdir(), "pushpals-autonomy-generic-repo-"));
      tempDirs.push(root);
      const calls: FetchCall[] = [];
      const objectivePosts: Array<Record<string, unknown>> = [];
      let llmCall = 0;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = String(init?.method ?? "GET").toUpperCase();
        const bodyRaw = typeof init?.body === "string" ? init.body : "";
        const body = bodyRaw ? JSON.parse(bodyRaw) : {};
        calls.push({ url, method, body });

        if (url.includes("/autonomy/lock/acquire"))
          return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
        if (url.includes("/autonomy/lock/renew"))
          return jsonResponse(200, { ok: true, lockUntil: new Date().toISOString() });
        if (url.includes("/autonomy/lock/release"))
          return jsonResponse(200, { ok: true, released: true });
        if (url.includes("/autonomy/snapshot"))
          return jsonResponse(200, { ok: true, snapshot: makeSnapshot() });
        if (url.includes("/workers/autoscale"))
          return jsonResponse(200, {
            ok: true,
            workers: { total: 1, online: 1, busy: 0, idle: 1 },
            jobs: { pending: 0, claimed: 0, autoscalablePending: 0 },
            prs: { openUnmerged: 0 },
          });
        if (url.includes("/autonomy/inspiration/ingest"))
          return jsonResponse(200, { ok: true, inserted: 1, updated: 0, skipped: 0 });
        if (url.includes("/autonomy/inspiration?"))
          return jsonResponse(200, { ok: true, patterns: [] });
        if (url.includes("/autonomy/insights?"))
          return jsonResponse(200, { ok: true, engineSourceStats: [] });
        if (url.endsWith("/autonomy/eligibility")) {
          const candidates = Array.isArray((body as Record<string, unknown>).candidates)
            ? ((body as Record<string, unknown>).candidates as Array<Record<string, unknown>>)
            : [];
          return jsonResponse(200, {
            ok: true,
            results: candidates.map((entry) => ({
              candidate_id: String(entry.id ?? entry.candidate_id ?? ""),
              ok: true,
            })),
          });
        }
        if (url.endsWith("/requests/enqueue"))
          return rejected
            ? jsonResponse(429, {
                ok: false,
                code: "autonomy_worker_runtime_circuit_open",
                retryAfterMs: 60_000,
              })
            : jsonResponse(201, {
                ok: true,
                requestId: "req_generic_1",
                dispatchConfirmed: true,
              });
        if (url.endsWith("/autonomy/objectives")) {
          objectivePosts.push(body as Record<string, unknown>);
          return jsonResponse(200, {
            ok: true,
            objectiveId: "obj_generic_1",
            patternKey: "pk_generic_1",
          });
        }
        throw new Error(`Unhandled fetch in test: ${method} ${url}`);
      }) as typeof globalThis.fetch;

      const llm = {
        async generate() {
          llmCall += 1;
          if (llmCall === 1) {
            return {
              text: JSON.stringify({ candidates: [] }),
              usage: { promptTokens: 1, completionTokens: 1 },
            };
          }
          if (llmCall === 2) {
            return {
              text: JSON.stringify({ scores: [] }),
              usage: { promptTokens: 1, completionTokens: 1 },
            };
          }
          return {
            text: JSON.stringify({
              instruction:
                "Improve src/autonomy.ts using the queue health signal and keep the change narrow.",
            }),
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      };
      const comm = {
        async emit() {
          return true;
        },
      };

      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "s_generic_repo",
        authToken: "tok",
        repo: root,
        llm: llm as any,
        comm: comm as any,
        config: makeConfig(),
      });
      (engine as any).ensureAutonomyRepoReady = async () => {
        const autonomyRepo = String((engine as any).autonomyRepo ?? "");
        mkdirSync(autonomyRepo, { recursive: true });
        seedGenericAutonomyRepoLayout(autonomyRepo);
        return true;
      };
      (engine as any).loadVisionContext = () => ({
        path: "vision.md",
        markdown: "# Vision\n",
        one_sentence: "Improve queue throughput safely for this repo.",
        sections: [
          {
            number: "1",
            title: "Reliability",
            markdown: "Favor narrow, deterministic fixes.",
            truncated: false,
          },
        ],
        key_items: {
          target_users: ["maintainers"],
          priorities: ["queue reliability"],
          objectives: ["reduce queue latency"],
          guardrails: ["small scoped changes"],
          constraints: ["only repo-relative targets"],
          non_goals: [],
          metrics: ["queue p95"],
          risk_policy: ["low risk autonomous"],
          operating_model: ["remotebuddy + workerpals"],
          governance: ["review high risk manually"],
        },
        section_numbers: ["1"],
        sha256: "visionhash",
        truncated: false,
      });
      (engine as any).loadCommitHistoryHints = async () => [];

      await engine.tick();

      const enqueueCall = calls.find((entry) => entry.url.endsWith("/requests/enqueue"));
      expect(enqueueCall).toBeDefined();
      const autonomy = (
        ((enqueueCall?.body as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>
      ).autonomy as Record<string, unknown>;
      expect(Array.isArray(autonomy.targetPaths)).toBe(true);
      expect(String((autonomy.targetPaths as string[])[0] ?? "")).toContain("src/");
      expect(String((autonomy.targetPaths as string[])[0] ?? "")).not.toContain("apps/server");
      expect(objectivePosts.length).toBeGreaterThan(0);
      expect((engine as any).lastOutcome).toBe(rejected ? "skipped" : "success");
      if (rejected) {
        expect(objectivePosts.at(-1)?.objective).toMatchObject({
          status: "rejected",
          block_reason: "request_enqueue_rejected:http_429:autonomy_worker_runtime_circuit_open",
        });
        expect((engine as any).lastDetail).toBe(
          "request_enqueue_rejected:http_429:autonomy_worker_runtime_circuit_open",
        );
        const callsBeforeBackoff = llmCall;
        await engine.tick();
        expect(llmCall).toBe(callsBeforeBackoff);
      }
    },
  );
});
