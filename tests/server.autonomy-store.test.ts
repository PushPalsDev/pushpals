import { afterEach, describe, expect, test } from "bun:test";
import { AutonomyStore } from "../apps/server/src/autonomy";

const stores: AutonomyStore[] = [];

function makeStore(): AutonomyStore {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  return store;
}

function seedObjectiveWithContext(store: AutonomyStore, overrides?: { requestId?: string; jobId?: string; objectiveId?: string; prUrl?: string }): {
  objectiveId: string;
  requestId: string;
  jobId: string;
  patternKey: string;
  prUrl: string;
} {
  const sessionId = "session_ctx";
  const runId = "run_ctx";
  const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;
  const objectiveId = overrides?.objectiveId ?? "obj_ctx";
  const requestId = overrides?.requestId ?? "req_ctx";
  const jobId = overrides?.jobId ?? "job_ctx";
  const prUrl = overrides?.prUrl ?? "https://example.com/pr/ctx";
  const decision = store.recordObjectiveDecision({
    runId,
    snapshotId,
    sessionId,
    objective: {
      id: objectiveId,
      title: "Context resolution objective",
      instruction: "Exercise PR feedback routing",
      objective_type: "lint_fix",
      component_area: "apps/server",
      trigger_type: "lint_failure",
      target_paths: ["apps/server/src/server_main.ts"],
      scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
      confidence: 0.9,
      risk_level: "low",
      expected_validation: ["bun test"],
      status: "dispatched",
      request_id: requestId,
      job_id: jobId,
    },
  });
  expect(decision.ok).toBe(true);
  expect(decision.patternKey).toBeTruthy();
  const rawDb = (store as unknown as { db?: { exec: (sql: string) => void; prepare: (sql: string) => any } }).db;
  if (rawDb) {
    rawDb.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        prUrl TEXT
      )`,
    );
    rawDb.prepare(`INSERT OR REPLACE INTO jobs (id, prUrl) VALUES (?, ?)`).run(jobId, prUrl);
  }
  return {
    objectiveId,
    requestId,
    jobId,
    patternKey: String(decision.patternKey ?? ""),
    prUrl,
  };
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("server AutonomyStore policy gates", () => {
  test("createSnapshot builds multi-source state traits", () => {
    const store = makeStore();
    const snapshot = store.createSnapshot({
      sessionId: "s1",
      runId: "run_traits",
      requestSlo: { queueWaitMs: { p95: 210_000 } },
      jobSlo: { completed: 6, failed: 4 },
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    });

    expect(snapshot.top_signals.length).toBeGreaterThan(0);
    expect(snapshot.state_traits.length).toBeGreaterThan(0);
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "queue_latency_high")).toBe(true);
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "job_failure_rate_high")).toBe(true);
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_dirty_worktree")).toBe(true);
  });

  test("createSnapshot derives component strength traits from outcomes", () => {
    const store = makeStore();
    const sessionId = "s1";
    const runId = "run_component_traits";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    for (let i = 0; i < 2; i++) {
      const objectiveId = `obj_component_${i + 1}`;
      const decision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: objectiveId,
          title: `Component trait seed ${i + 1}`,
          instruction: "Seed outcome for component area strength trait",
          objective_type: "lint_fix",
          component_area: "apps/client",
          trigger_type: "lint_failure",
          target_paths: ["apps/client/src/app.tsx"],
          scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run lint"],
          status: "rejected",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId,
        patternKey: decision.patternKey,
        success: true,
        userAction: "manual_fix",
      });
      expect(outcome.ok).toBe(true);
    }

    const enriched = store.createSnapshot({ sessionId, runId });
    expect(
      enriched.state_traits.some((trait) => trait.trait_id === "component_strong_apps/client"),
    ).toBe(true);
  });

  test("rejects objective risk above policy ceiling", () => {
    const store = makeStore();
    store.createSnapshot({ sessionId: "s1" });

    const result = store.recordObjectiveDecision({
      runId: "run_1",
      snapshotId: store.createSnapshot({ sessionId: "s1" }).snapshot_id,
      sessionId: "s1",
      objective: {
        id: "obj_1",
        title: "Too risky flaky test objective",
        instruction: "Fix flaky test",
        objective_type: "flaky_test",
        component_area: "tests/integration",
        trigger_type: "test_failure",
        target_paths: ["tests/integration/test_workerpals_e2e.py"],
        scope: { read_anywhere: false, write_globs: ["tests/integration/*.py"] },
        confidence: 0.8,
        risk_level: "high",
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("exceeds policy");
  });

  test("rejects non-autonomous feature_large objectives", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_feature_large_block",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_feature_large",
        title: "Build broad feature autonomously",
        instruction: "Implement a large feature touching many areas.",
        objective_type: "feature_large",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "medium",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("autonomous_allowed");
  });

  test("applies read_anywhere policy gate based on config allowlist", () => {
    const store = makeStore();
    const allowReadAnywhere = (store as unknown as { config?: { remotebuddy?: { autonomy?: { allowReadAnywhere?: boolean } } } }).config?.remotebuddy?.autonomy?.allowReadAnywhere ?? false;
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_2",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_2",
        title: "Invalid broad read",
        instruction: "Do scoped lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: true, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.requests-queue.test.ts"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(allowReadAnywhere);
    if (!allowReadAnywhere) {
      expect(String(result.reason ?? "")).toContain("read_anywhere");
    }
  });

  test("dispatch lock is visible only to other runs", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 60_000 });
    expect(acquired.ok).toBe(true);

    const ownSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_1" });
    expect(ownSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);

    const otherSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(otherSnapshot.repo_health_flags.dispatch_lock_held).toBe(true);

    const released = store.releaseDispatchLock({ sessionId: "s1", runId: "run_1" });
    expect(released.ok).toBe(true);
    expect(released.released).toBe(true);

    const postReleaseSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(postReleaseSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);
  });

  test("renewDispatchLock extends lock for the same owner", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 30_000 });
    expect(acquired.ok).toBe(true);
    const firstUntil = String(acquired.lockUntil ?? "");
    expect(firstUntil.length).toBeGreaterThan(0);

    const renewed = store.renewDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 90_000 });
    expect(renewed.ok).toBe(true);
    const renewedUntil = String(renewed.lockUntil ?? "");
    expect(renewedUntil.length).toBeGreaterThan(0);
    expect(Date.parse(renewedUntil)).toBeGreaterThan(Date.parse(firstUntil));
  });

  test("rejects invalid objective enums before persistence", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const invalidObjectiveType = store.recordObjectiveDecision({
      runId: "run_invalid_type",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_invalid_type",
        title: "Invalid objective type",
        instruction: "noop",
        objective_type: "bad_type",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "rejected",
      },
    });
    expect(invalidObjectiveType.ok).toBe(false);
    expect(String(invalidObjectiveType.reason ?? "")).toContain("invalid objective_type");

    const invalidTriggerType = store.recordObjectiveDecision({
      runId: "run_invalid_trigger",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_invalid_trigger",
        title: "Invalid trigger type",
        instruction: "noop",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "bad_trigger",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.8,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "rejected",
      },
    });
    expect(invalidTriggerType.ok).toBe(false);
    expect(String(invalidTriggerType.reason ?? "")).toContain("invalid trigger_type");
  });

  test("evaluateEligibility returns canonical server-side gate decisions", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_elig",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_elig",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_low_conf",
          objective_type: "lint_fix",
          pattern_key: "pk_lint_fix",
          confidence: 0.1,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("confidence");
  });

  test("evaluateEligibility suppresses dispatch when same pattern succeeded within 24h", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_recent_exact",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_recent_exact",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_recent_exact",
        candidate_id: "cand_recent_exact",
        title: "Seed exact pattern success",
        instruction: "Apply a stable lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "rejected",
      },
    });
    expect(seeded.ok).toBe(true);
    expect(typeof seeded.patternKey).toBe("string");

    const seededOutcome = store.recordOutcome({
      objectiveId: "obj_recent_exact",
      patternKey: seeded.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(seededOutcome.ok).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_recent_exact",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_again_exact",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain(
      "recent_success_same_pattern_within_24h",
    );
  });

  test("evaluateEligibility suppresses near-same docs candidate in same component after recent success", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_recent_docs_near",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_recent_docs_near",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_recent_docs",
        candidate_id: "cand_recent_docs",
        title: "Seed docs success",
        instruction: "Refresh docs guidance",
        objective_type: "docs",
        component_area: "apps/remotebuddy",
        trigger_type: "queue_health",
        target_paths: ["apps/remotebuddy/docs/queue.md"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/docs/*.md"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "rejected",
      },
    });
    expect(seeded.ok).toBe(true);

    const seededOutcome = store.recordOutcome({
      objectiveId: "obj_recent_docs",
      patternKey: seeded.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(seededOutcome.ok).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_recent_docs_near",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_docs_again",
          objective_type: "docs",
          component_area: "apps/remotebuddy",
          pattern_key: "pk_docs_other_scope",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain(
      "recent_success_near_pattern_within_24h",
    );
  });

  test("evaluateEligibility allows dirty worktree when allowDirtyWorktree is enabled", () => {
    const store = makeStore();
    (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { allowDirtyWorktree?: boolean } } };
      }
    ).config!.remotebuddy!.autonomy!.allowDirtyWorktree = true;
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_dirty_allowed",
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_dirty_allowed",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_dirty_allowed",
          objective_type: "lint_fix",
          pattern_key: "pk_dirty_allowed",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(true);
  });

  test("evaluateEligibility blocks dirty worktree when allowDirtyWorktree is disabled", () => {
    const store = makeStore();
    (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { allowDirtyWorktree?: boolean } } };
      }
    ).config!.remotebuddy!.autonomy!.allowDirtyWorktree = false;

    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_dirty_blocked",
      repoHealthFlags: {
        is_worktree_dirty: true,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_dirty_blocked",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_dirty_blocked",
          objective_type: "lint_fix",
          pattern_key: "pk_dirty_blocked",
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.length).toBe(1);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("worktree is dirty");
  });

  test("evaluateEligibility applies sequential accounting for batch candidates", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_seq",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const candidates = Array.from({ length: 8 }).map((_, i) => ({
      candidate_id: `cand_${i + 1}`,
      objective_type: "lint_fix",
      pattern_key: `pk_seq_${i + 1}`,
      confidence: 0.95,
    }));
    const result = store.evaluateEligibility({
      runId: "run_seq",
      snapshotId,
      applySequentialAccounting: true,
      candidates,
    });
    expect(result.ok).toBe(true);
    const rejected = (result.results ?? []).filter((row) => !row.ok);
    expect(rejected.length).toBeGreaterThan(0);
    const firstRejection = String(rejected[0]?.reason ?? "");
    expect(
      firstRejection.includes("max concurrent objectives reached") ||
        firstRejection.includes("budget exceeded"),
    ).toBe(true);
  });

  test("persists candidates with run-scoped ids to prevent cross-run overwrites", () => {
    const store = makeStore();
    const snapshotA = store.createSnapshot({ sessionId: "s1", runId: "run_a" }).snapshot_id;
    const snapshotB = store.createSnapshot({ sessionId: "s1", runId: "run_b" }).snapshot_id;

    const baseCandidate = {
      id: "cand_shared",
      title: "Stabilize lint failures",
      objective_type: "lint_fix",
      problem_statement: "Fix recurring lint failure in server route.",
      trigger_type: "lint_failure",
      component_area: "apps/server",
      target_paths: ["apps/server/src/server_main.ts"],
      scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
      risk_level: "low",
      expected_validation: ["bun run lint"],
      estimated_effort: "small",
      why_now_signal_ids: ["sig_lint"],
      confidence: 0.9,
    };

    const runA = store.recordObjectiveDecision({
      runId: "run_a",
      snapshotId: snapshotA,
      sessionId: "s1",
      candidates: [baseCandidate],
    });
    const runB = store.recordObjectiveDecision({
      runId: "run_b",
      snapshotId: snapshotB,
      sessionId: "s1",
      candidates: [baseCandidate],
    });
    expect(runA.ok).toBe(true);
    expect(runB.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const rows = db
      .prepare(
        `SELECT id, run_id
         FROM autonomy_candidates
         WHERE id LIKE ?
         ORDER BY run_id ASC`,
      )
      .all("%:cand_shared") as Array<{ id: string; run_id: string }>;

    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe("run_a:cand_shared");
    expect(rows[1]?.id).toBe("run_b:cand_shared");
  });

  test("recordPrFeedback marks unknown verdicts with structured status", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_verdict_unknown",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_verdict_unknown",
        title: "Seed objective for verdict test",
        instruction: "noop",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const result = store.recordPrFeedback({
      patternKey: decision.patternKey,
      verdict: "mysterious_signal",
      summary: "New verdict not yet mapped",
      commentCount: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.verdictStatus).toBe("unknown");
    expect(result.metrics?.prFeedbackUnknownVerdict).toBe(1);

    const db = (store as unknown as { db: any }).db;
    const row = db
      .prepare(
        `SELECT verdict_status
         FROM autonomy_pr_feedback
         WHERE pattern_key = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(decision.patternKey) as { verdict_status: string } | undefined;
    expect(row?.verdict_status).toBe("unknown");
  });

  test("recordPrFeedback tolerates missing jobs table when only prUrl is provided", () => {
    const store = makeStore();
    const result = store.recordPrFeedback({
      verdict: "rejected_due_to_signal",
      prUrl: "https://github.com/org/repo/pull/123",
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("patternKey");
  });

  test("recordPrFeedback tolerates missing jobs.prUrl column when jobs table exists", () => {
    const store = makeStore();
    const db = (store as unknown as { db: any }).db;
    db.exec(`DROP TABLE IF EXISTS jobs; CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT);`);
    const result = store.recordPrFeedback({
      verdict: "rejected_due_to_signal",
      prUrl: "https://github.com/org/repo/pull/456",
    });

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("patternKey");
  });

  test("ignores autonomy accepted outcomes before any worker job is linked", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_guard" }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId: "run_guard",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_guard",
        candidate_id: "cand_guard",
        title: "Guard against premature accepted outcome",
        instruction: "Run worker fix and validate",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
        request_id: "req_guard",
      },
    });
    expect(decision.ok).toBe(true);

    const premature = store.recordOutcome({
      objectiveId: "obj_guard",
      requestId: "req_guard",
      patternKey: decision.patternKey,
      success: true,
      userAction: "accepted",
    });
    expect(premature.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const before = db
      .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
      .get("obj_guard") as { count: number };
    expect(before.count).toBe(0);

    const applied = store.recordOutcome({
      objectiveId: "obj_guard",
      requestId: "req_guard",
      jobId: "job_guard",
      patternKey: decision.patternKey,
      success: true,
      userAction: "applied",
    });
    expect(applied.ok).toBe(true);

    const after = db
      .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
      .get("obj_guard") as { count: number };
    expect(after.count).toBe(1);
  });

  test("recordPrFeedback resolves pattern context via request, job, and prUrl hints", () => {
    const store = makeStore();
    const seeded = seedObjectiveWithContext(store, {
      prUrl: "https://example.com/pr/ctx-resolution",
    });

    const byRequest = store.recordPrFeedback({
      verdict: "rejected",
      feedbackKey: "ctx-request",
      summary: "Needs more unit tests",
      requestId: seeded.requestId,
    });
    expect(byRequest.ok).toBe(true);
    expect(byRequest.patternKey).toBe(seeded.patternKey);
    expect(byRequest.objectiveId).toBe(seeded.objectiveId);

    const byJob = store.recordPrFeedback({
      verdict: "rejected",
      feedbackKey: "ctx-job",
      summary: "Still failing integration",
      jobId: seeded.jobId,
    });
    expect(byJob.ok).toBe(true);
    expect(byJob.patternKey).toBe(seeded.patternKey);
    expect(byJob.objectiveId).toBe(seeded.objectiveId);

    const byPrUrl = store.recordPrFeedback({
      verdict: "rejected_comment_cap_closed",
      feedbackKey: "ctx-pr-url",
      summary: "Closed after repeated failures",
      prUrl: seeded.prUrl,
    });
    expect(byPrUrl.ok).toBe(true);
    expect(byPrUrl.patternKey).toBe(seeded.patternKey);
    expect(byPrUrl.objectiveId).toBe(seeded.objectiveId);

    const byObjective = store.recordPrFeedback({
      verdict: "approved_unmergeable",
      feedbackKey: "ctx-objective",
      summary: "Approved but merge blocked",
      objectiveId: seeded.objectiveId,
    });
    expect(byObjective.ok).toBe(true);
    expect(byObjective.patternKey).toBe(seeded.patternKey);
    expect(byObjective.objectiveId).toBe(seeded.objectiveId);
  });

  test("recordPrFeedback dedupes repeated feedback_key submissions", () => {
    const store = makeStore();
    const seeded = seedObjectiveWithContext(store);
    const db = (store as unknown as { db: any }).db;
    const rowCount = (table: string): number =>
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as {
          count: number;
        }
      ).count;

    const first = store.recordPrFeedback({
      verdict: "approved_merged",
      feedbackKey: "dup-key",
      summary: "Merged successfully",
      objectiveId: seeded.objectiveId,
    });
    expect(first.ok).toBe(true);
    expect(first.success).toBe(true);
    expect(first.normalizedVerdict).toBe("approved_merged");
    expect(first.rawVerdict).toBe("approved_merged");
    expect(rowCount("autonomy_pr_feedback")).toBe(1);
    expect(rowCount("autonomy_outcomes")).toBe(1);

    const second = store.recordPrFeedback({
      verdict: "approved_merged",
      feedbackKey: "dup-key",
      summary: "Duplicate signal",
      objectiveId: seeded.objectiveId,
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.normalizedVerdict).toBe("approved_merged");
    expect(second.success).toBeUndefined();
    expect(rowCount("autonomy_pr_feedback")).toBe(1);
    expect(rowCount("autonomy_outcomes")).toBe(1);
  });

  test("recordPrFeedback maps verdicts to deterministic outcomes", () => {
    const store = makeStore();
    const seeded = seedObjectiveWithContext(store);
    const accepted = store.recordPrFeedback({
      verdict: "approved_merged",
      feedbackKey: "outcome-accepted",
      summary: "Merged cleanly",
      objectiveId: seeded.objectiveId,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.success).toBe(true);
    expect(accepted.userAction).toBe("accepted");
    expect(accepted.normalizedVerdict).toBe("approved_merged");

    const blocked = store.recordPrFeedback({
      verdict: "approved_unmergeable",
      feedbackKey: "outcome-blocked",
      summary: "Approved but merge conflict",
      objectiveId: seeded.objectiveId,
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.success).toBe(false);
    expect(blocked.userAction).toBe("merge_conflict");
    expect(blocked.normalizedVerdict).toBe("approved_unmergeable");

    const rows = (
      (store as unknown as { db: any }).db
        .prepare(
          `SELECT user_action AS userAction, success
           FROM autonomy_outcomes
           ORDER BY id ASC`,
        )
        .all() as Array<{ userAction: string | null; success: number }>
    ).map((row) => ({ userAction: row.userAction, success: row.success }));

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toEqual({ userAction: "accepted", success: 1 });
    expect(rows[1]).toEqual({ userAction: "merge_conflict", success: 0 });
  });

  test("recordPrFeedback ignores unknown verdict strings for outcomes", () => {
    const store = makeStore();
    const seeded = seedObjectiveWithContext(store);
    const result = store.recordPrFeedback({
      verdict: "custom_notice",
      feedbackKey: "unknown-outcome",
      summary: "Just FYI",
      objectiveId: seeded.objectiveId,
    });
    expect(result.ok).toBe(true);
    expect(result.success).toBeUndefined();
    expect(result.userAction).toBeUndefined();
    expect(result.normalizedVerdict).toBeNull();
    expect(result.rawVerdict).toBe("custom_notice");

    const rows = (
      (store as unknown as { db: any }).db
        .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes`)
        .get() as { count: number }
    ).count;
    expect(rows).toBe(0);
  });
});
