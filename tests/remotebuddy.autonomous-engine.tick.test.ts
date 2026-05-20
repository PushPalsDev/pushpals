import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RemoteBuddyAutonomousEngine } from "../apps/remotebuddy/src/autonomous_engine";

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

const tempDirs: string[] = [];
let originalFetch: typeof globalThis.fetch;
let originalSpawn: typeof Bun.spawn;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfig(): any {
  return {
    sourceControlManager: {
      remote: "origin",
      mainBranch: "main_agents",
      baseBranch: "main",
    },
    remotebuddy: {
      llm: {
        backend: "openai_codex",
        endpoint: "http://127.0.0.1:1234",
        model: "gpt-5.5",
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
}

function seedGenericAutonomyRepoLayout(root: string): void {
  const markers = ["src/autonomy.ts", "src/queue.ts", "tests/autonomy.test.ts", "README.md"];
  for (const marker of markers) {
    const fullPath = join(root, marker);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, "// generic repo fixture\n", "utf8");
  }
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

describe("RemoteBuddyAutonomousEngine tick orchestration", () => {
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
        return jsonResponse(201, { ok: true, requestId: "req_tick_1" });
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

    expect(objectivePosts.length).toBeGreaterThan(0);
    const lastObjective = objectivePosts[objectivePosts.length - 1] ?? {};
    const objective = (lastObjective.objective ?? {}) as Record<string, unknown>;
    expect(String(objective.status ?? "")).toBe("dispatched");
    expect(String(objective.request_id ?? "")).toBe("req_tick_1");
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

  test("tick defers ideation while worker load is active", async () => {
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
          workers: { total: 2, online: 2, busy: 1, idle: 1 },
          jobs: { pending: 2, claimed: 1, autoscalablePending: 1 },
          prs: { openUnmerged: 2 },
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
    expect((engine as any).lastDetail).toBe("worker_load_busy_1_pending_2_autoscalable_1");
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

  test("ideation timeout schedules one-shot recovery guidance for the next ideation round", async () => {
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
        return jsonResponse(201, { ok: true, requestId: "req_timeout_recovery_1" });
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
          expect(input.maxTokens).toBe(1400);
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
                  expected_validation: ["bun test tests/remotebuddy.autonomous-engine.tick.test.ts"],
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
    expect((engine as any).lastOutcome).toBe("failed");
    expect((engine as any).lastDetail).toContain("autonomy ideation phase timeout");
    expect((engine as any).pendingIdeationTimeoutRecovery).not.toBeNull();

    await engine.tick();
    expect((engine as any).lastOutcome).toBe("success");
    expect((engine as any).pendingIdeationTimeoutRecovery).toBeNull();
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
    expect((engine as any).phaseTimeoutMs("scoring")).toBe(60_000);
    expect((engine as any).phaseTimeoutMs("planning")).toBe(60_000);
  });

  test("tick can dispatch generic repo autonomy work when vision.md is present", async () => {
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
        return jsonResponse(201, { ok: true, requestId: "req_generic_1" });
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
    expect((engine as any).lastOutcome).toBe("success");
  });
});
