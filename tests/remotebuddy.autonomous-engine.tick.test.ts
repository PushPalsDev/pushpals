import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  autonomyIntegrationBaselineDecision,
  RemoteBuddyAutonomousEngine,
  resolveAutonomyGitCommandTimeoutMs,
} from "../apps/remotebuddy/src/autonomous_engine";

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
});

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
        model: "gpt-5.6-sol",
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
        return jsonResponse(201, { ok: true, requestId: "req_validation_repair" });
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
    expect(outcome.handled).toBe(true);
    expect(outcome.detail).toContain("validation_repair_not_eligible");
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
        return jsonResponse(201, { ok: true, requestId: "req_scoring_timeout_1" });
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
          target_paths: ["src"],
          scope: { write_globs: ["src/**"] },
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
