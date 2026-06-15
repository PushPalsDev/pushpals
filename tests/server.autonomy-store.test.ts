import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AutonomyStore, type AutonomyEvaluatorScorecard } from "../apps/server/src/autonomy";
import { JobQueue } from "../apps/server/src/jobs";

const stores: AutonomyStore[] = [];
const tempDirs: string[] = [];

function makeStore(): AutonomyStore {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  return store;
}

function makePersistentStore(prefix = "pushpals-autonomy-store-"): {
  store: AutonomyStore;
  dbPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(root, "autonomy.sqlite");
  tempDirs.push(root);
  const store = new AutonomyStore(dbPath);
  stores.push(store);
  return { store, dbPath };
}

function closeTrackedStore(store: AutonomyStore): void {
  const idx = stores.indexOf(store);
  if (idx >= 0) stores.splice(idx, 1);
  store.close();
}

function runEvaluatorNow(store: AutonomyStore): AutonomyEvaluatorScorecard {
  return (
    store as unknown as { runEvaluator: (nowIso?: string) => AutonomyEvaluatorScorecard }
  ).runEvaluator(new Date(Date.now() + 1000).toISOString());
}

function autonomyOutcomeCount(store: AutonomyStore, objectiveId: string): number {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM autonomy_outcomes WHERE objective_id = ?`)
    .get(objectiveId) as { count: number };
  return Math.max(0, Math.floor(Number(row.count ?? 0)));
}

function autonomyObjectiveStatus(store: AutonomyStore, objectiveId: string): string | null {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT status FROM autonomy_objectives WHERE id = ? LIMIT 1`)
    .get(objectiveId) as { status: string | null } | undefined;
  return typeof row?.status === "string" ? row.status : null;
}

function autonomyPatternSampleCount(store: AutonomyStore, patternKey: string): number {
  const db = (store as unknown as { db: any }).db;
  const row = db
    .prepare(`SELECT sample_count FROM autonomy_pattern_stats WHERE pattern_key = ? LIMIT 1`)
    .get(patternKey) as { sample_count: number | null } | undefined;
  return Math.max(0, Math.floor(Number(row?.sample_count ?? 0)));
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup for Windows file lock timing
    }
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
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "queue_latency_high")).toBe(
      true,
    );
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "job_failure_rate_high")).toBe(
      true,
    );
    expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_dirty_worktree")).toBe(
      true,
    );
  });

  test("createSnapshot marks repo validation red after repeated required command failures", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-validation-red-");
    const jobQueue = new JobQueue(dbPath);

    try {
      for (let i = 0; i < 2; i++) {
        const enqueued = jobQueue.enqueue({
          taskId: `task-validation-red-${i + 1}`,
          sessionId: "s1",
          kind: "task.execute",
          params: { instruction: "Repair the local web smoke baseline." },
        });
        expect(enqueued.ok).toBe(true);
        const claimed = jobQueue.claim(`worker-validation-red-${i + 1}`);
        expect(claimed.ok).toBe(true);
        const jobId = String(claimed.job?.id ?? "");
        expect(jobId.length).toBeGreaterThan(0);

        const failed = jobQueue.fail(jobId, {
          message: "Required validation failed",
          diagnostics: {
            terminal: {
              failureClass: "validation_failed",
              terminalStage: "focused_validation",
              executorBackend: "openai_codex",
              summary: "bun run web:e2e failed",
            },
            validationRuns: [
              {
                attempt: 1,
                command: "bun run web:e2e",
                exitCode: 1,
                durationMs: 1200,
                passed: false,
                failureClass: "browser_smoke_failed",
                stderrTail:
                  "scripts/__tests__/cleanup-harness.js:42 browser smoke assertion failed",
              },
            ],
          },
        });
        expect(failed.ok).toBe(true);
      }

      const snapshot = store.createSnapshot({ sessionId: "s1", runId: "run_validation_red" });
      expect(snapshot.repo_health_flags.required_validation_red).toBe(true);
      expect(snapshot.validation_incident?.command).toBe("bun run web:e2e");
      expect(snapshot.validation_incident?.signal_type).toBe("test_failure");
      expect(snapshot.validation_incident?.failure_count).toBe(2);
      expect(snapshot.validation_incident?.failed_job_ids).toHaveLength(2);
      expect(snapshot.validation_incident?.target_path_hints).toContain(
        "scripts/__tests__/cleanup-harness.js",
      );
      expect(
        snapshot.top_signals.some((signal) => signal.signal_id === "sig_validation_incident"),
      ).toBe(true);
      expect(snapshot.state_traits.some((trait) => trait.trait_id === "repo_validation_red")).toBe(
        true,
      );
    } finally {
      jobQueue.close();
    }
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

  test("createSnapshot emits execution-health signals for stalled, blocked, and failing autonomy work", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-execution-health-");
    const jobQueue = new JobQueue(dbPath);
    const sessionId = "s1";
    const runId = "run_execution_health";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    try {
      const stalledDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_stalled",
          title: "Stalled objective",
          instruction: "Seed stalled objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "running",
        },
      });
      expect(stalledDecision.ok).toBe(true);

      const blockedDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_blocked",
          title: "Blocked objective",
          instruction: "Seed blocked objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "regret_signal",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "blocked",
        },
      });
      expect(blockedDecision.ok).toBe(true);

      const failedDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_failed",
          title: "Failed objective",
          instruction: "Seed failed objective telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "rejected",
        },
      });
      expect(failedDecision.ok).toBe(true);
      expect(
        store.recordOutcome({
          objectiveId: "obj_failed",
          patternKey: failedDecision.patternKey,
          success: false,
          userAction: "no_change",
          regressionFlag: true,
        }).ok,
      ).toBe(true);

      const staleJobId = String(
        jobQueue.enqueue({
          taskId: "task_worker_stale",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(staleJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-a").ok).toBe(true);
      expect(
        jobQueue.fail(staleJobId, {
          message: "Job auto-failed after stale worker claim",
          detail: "worker=workerpal-a; lastHeartbeat=2026-03-29T22:36:28.894Z",
        }).ok,
      ).toBe(true);
      const staleWorkerDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_worker_stale",
          title: "Worker stale claim objective",
          instruction: "Seed worker stale claim telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "queue_health",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "failed",
          job_id: staleJobId,
        },
      });
      expect(staleWorkerDecision.ok).toBe(true);

      const softPassJobId = String(
        jobQueue.enqueue({
          taskId: "task_quality_softpass",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(softPassJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-b").ok).toBe(true);
      expect(
        jobQueue.complete(softPassJobId, {
          summary:
            "Executed task and modified 1 file(s) (quality gate soft-pass after 1 auto-revision attempt(s)).",
          artifacts: [],
        }).ok,
      ).toBe(true);
      const softPassDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_quality_softpass",
          title: "Quality gate soft-pass objective",
          instruction: "Seed quality gate soft-pass telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "completed",
          job_id: softPassJobId,
        },
      });
      expect(softPassDecision.ok).toBe(true);

      const failedRevisionJobId = String(
        jobQueue.enqueue({
          taskId: "task_quality_failed",
          sessionId,
          kind: "task.execute",
          params: {},
          priority: "background",
        }).jobId ?? "",
      );
      expect(failedRevisionJobId.length).toBeGreaterThan(0);
      expect(jobQueue.claim("workerpal-c").ok).toBe(true);
      expect(
        jobQueue.fail(failedRevisionJobId, {
          message:
            "Quality gate failed after 1 auto-revision attempt(s): Critic score 2.0 is below required threshold 8.",
          detail: "[QualityGate] Codex critic score: 2/10",
        }).ok,
      ).toBe(true);
      const failedRevisionDecision = store.recordObjectiveDecision({
        runId,
        snapshotId,
        sessionId,
        objective: {
          id: "obj_quality_failed",
          title: "Quality gate failed objective",
          instruction: "Seed quality gate failure telemetry",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test:root"],
          status: "failed",
          job_id: failedRevisionJobId,
        },
      });
      expect(failedRevisionDecision.ok).toBe(true);

      (store as any).db
        .prepare(
          `UPDATE autonomy_objectives
           SET updated_at = datetime('now', '-90 minutes')
           WHERE id IN ('obj_stalled', 'obj_blocked')`,
        )
        .run();

      const snapshot = store.createSnapshot({ sessionId, runId });

      expect(
        snapshot.top_signals.some(
          (signal) => signal.signal_id === "sig_objective_stall" && signal.type === "queue_health",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_objective_blocked" && signal.type === "regret_signal",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id.startsWith("sig_objective_failure_") && signal.type === "lint_failure",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_worker_stale_claims" && signal.type === "queue_health",
        ),
      ).toBe(true);
      expect(
        snapshot.top_signals.some(
          (signal) =>
            signal.signal_id === "sig_quality_revision_churn" && signal.type === "regret_signal",
        ),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "open_objectives_stalled"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "blocked_objectives_waiting"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "worker_stale_claim_pressure"),
      ).toBe(true);
      expect(
        snapshot.state_traits.some((trait) => trait.trait_id === "quality_revision_churn"),
      ).toBe(true);
    } finally {
      jobQueue.close();
      closeTrackedStore(store);
    }
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
    const allowReadAnywhere =
      (
        store as unknown as {
          config?: { remotebuddy?: { autonomy?: { allowReadAnywhere?: boolean } } };
        }
      ).config?.remotebuddy?.autonomy?.allowReadAnywhere ?? false;
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

  test("accepts broad repo scope hints without treating them as write permissions", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1" }).snapshot_id;

    const result = store.recordObjectiveDecision({
      runId: "run_broad_hints",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_broad_hints",
        title: "Improve repo behavior across owning files",
        instruction: "Use the target paths as starting points and edit the owning files.",
        objective_type: "small_refactor",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
        scope: { read_anywhere: true, write_globs: ["**/*"] },
        confidence: 0.8,
        risk_level: "medium",
        expected_validation: ["bun run test:root"],
        status: "dispatched",
      },
    });

    expect(result.ok).toBe(true);
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

  test("acquireDispatchLock can replace a stale same-session owner", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 900_000 });
    expect(acquired.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_dispatch_lock
       SET updated_at = ?
       WHERE lock_id = 'autonomy_dispatch'`,
    ).run(new Date(Date.now() - 300_000).toISOString());

    const replaced = store.acquireDispatchLock({
      sessionId: "s1",
      runId: "run_2",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.replacedStale).toBe(true);

    const ownSnapshot = store.createSnapshot({ sessionId: "s1", runId: "run_2" });
    expect(ownSnapshot.repo_health_flags.dispatch_lock_held).toBe(false);
  });

  test("acquireDispatchLock does not replace fresh or cross-session owners", () => {
    const store = makeStore();
    const acquired = store.acquireDispatchLock({ sessionId: "s1", runId: "run_1", ttlMs: 900_000 });
    expect(acquired.ok).toBe(true);

    const freshSameSession = store.acquireDispatchLock({
      sessionId: "s1",
      runId: "run_2",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(freshSameSession.ok).toBe(false);

    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_dispatch_lock
       SET updated_at = ?
       WHERE lock_id = 'autonomy_dispatch'`,
    ).run(new Date(Date.now() - 300_000).toISOString());

    const staleDifferentSession = store.acquireDispatchLock({
      sessionId: "s2",
      runId: "run_3",
      ttlMs: 60_000,
      staleAfterMs: 120_000,
    });
    expect(staleDifferentSession.ok).toBe(false);
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

  test("blocks PushPals-internal autonomy ideas from user-repo targets", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_meta_leak",
      repoHealthFlags: {
        is_worktree_dirty: false,
        is_merge_in_progress: false,
      },
    }).snapshot_id;

    const result = store.evaluateEligibility({
      runId: "run_meta_leak",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_queue_health_leak",
          objective_type: "small_refactor",
          component_area: "app",
          pattern_key: "queue_health_contract",
          title: "Add queue_health readability contract",
          instruction: "Expose WorkerPal queue_health diagnostics in the app layout tests.",
          target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
          scope: { read_anywhere: true, write_globs: ["app/**"] },
          confidence: 0.95,
        },
        {
          candidate_id: "cand_pushpals_runtime",
          objective_type: "small_refactor",
          component_area: "apps/workerpals",
          pattern_key: "workerpal_queue_health_runtime",
          title: "Add WorkerPal queue health coverage",
          instruction: "Strengthen WorkerPal queue health tests in PushPals runtime code.",
          target_paths: ["apps/workerpals/src/execute_job.ts"],
          scope: { read_anywhere: true, write_globs: ["apps/workerpals/**"] },
          confidence: 0.95,
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({
      candidate_id: "cand_queue_health_leak",
      ok: false,
    });
    expect(String(result.results?.[0]?.reason ?? "")).toContain("PushPals-internal");
    expect(result.results?.[1]).toMatchObject({
      candidate_id: "cand_pushpals_runtime",
      ok: true,
    });

    const directDecision = store.recordObjectiveDecision({
      runId: "run_meta_leak",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_queue_health_leak",
        title: "Add queue_health readability contract",
        instruction: "Expose WorkerPal queue_health diagnostics in the app layout tests.",
        objective_type: "small_refactor",
        component_area: "app",
        trigger_type: "test_failure",
        target_paths: ["app/__tests__/_layout.autonomy.test.ts"],
        scope: { read_anywhere: true, write_globs: ["app/**"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun test"],
        status: "proposed",
      },
    });
    expect(directDecision.ok).toBe(false);
    expect(String(directDecision.reason ?? "")).toContain("PushPals-internal");
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

  test("evaluateEligibility blocks dispatch when hourly token budget is exhausted", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { maxTokenUsagePerHour?: number } } };
      }
    ).config?.remotebuddy?.autonomy;
    const priorLimit = autonomyCfg?.maxTokenUsagePerHour;
    if (autonomyCfg) autonomyCfg.maxTokenUsagePerHour = 10;

    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s1",
        runId: "run_token_budget",
      }).snapshot_id;

      const logged = store.recordObjectiveDecision({
        runId: "run_token_budget",
        snapshotId,
        sessionId: "s1",
        llmCalls: [
          {
            id: "llm_token_budget_1",
            phase: "ideation",
            tokenUsage: { promptTokens: 7, completionTokens: 5 },
          },
        ],
      });
      expect(logged.ok).toBe(true);

      const result = store.evaluateEligibility({
        runId: "run_token_budget",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_token_budget",
            objective_type: "lint_fix",
            component_area: "apps/server",
            pattern_key: "pk_token_budget",
            confidence: 0.95,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.results?.[0]?.ok).toBe(false);
      expect(String(result.results?.[0]?.reason ?? "")).toContain("token budget exceeded");
    } finally {
      if (autonomyCfg && typeof priorLimit === "number")
        autonomyCfg.maxTokenUsagePerHour = priorLimit;
    }
  });

  test("evaluateEligibility blocks dispatch when hourly runtime budget is exhausted", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: { remotebuddy?: { autonomy?: { maxRuntimeMsPerHour?: number } } };
      }
    ).config?.remotebuddy?.autonomy;
    const priorLimit = autonomyCfg?.maxRuntimeMsPerHour;
    if (autonomyCfg) autonomyCfg.maxRuntimeMsPerHour = 1_000;

    try {
      const snapshotId = store.createSnapshot({
        sessionId: "s1",
        runId: "run_runtime_budget",
      }).snapshot_id;
      const decision = store.recordObjectiveDecision({
        runId: "run_runtime_budget",
        snapshotId,
        sessionId: "s1",
        objective: {
          id: "obj_runtime_budget_seed",
          title: "Runtime budget seed objective",
          instruction: "Seed runtime usage for budget test.",
          objective_type: "lint_fix",
          component_area: "apps/server",
          trigger_type: "lint_failure",
          target_paths: ["apps/server/src/autonomy.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
          confidence: 0.92,
          risk_level: "low",
          expected_validation: ["bun run lint"],
          status: "dispatched",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId: "obj_runtime_budget_seed",
        patternKey: decision.patternKey,
        success: true,
        userAction: "applied",
        latencyMs: 1_500,
      });
      expect(outcome.ok).toBe(true);

      const result = store.evaluateEligibility({
        runId: "run_runtime_budget",
        snapshotId,
        candidates: [
          {
            candidate_id: "cand_runtime_budget",
            objective_type: "lint_fix",
            component_area: "apps/server",
            pattern_key: "pk_runtime_budget",
            confidence: 0.95,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.results?.[0]?.ok).toBe(false);
      expect(String(result.results?.[0]?.reason ?? "")).toContain("runtime budget exceeded");
    } finally {
      if (autonomyCfg && typeof priorLimit === "number")
        autonomyCfg.maxRuntimeMsPerHour = priorLimit;
    }
  });

  test("aggregates llm usage by service with average tokens per call", () => {
    const store = makeStore();

    expect(
      store.recordLlmUsage({
        id: "usage_local_1",
        service: "localbuddy",
        promptTokens: 120,
        completionTokens: 30,
      }).ok,
    ).toBe(true);
    expect(
      store.recordLlmUsage({
        id: "usage_local_2",
        service: "localbuddy",
        promptTokens: 80,
        completionTokens: 20,
        estimated: true,
      }).ok,
    ).toBe(true);
    expect(
      store.recordLlmUsage({
        id: "usage_remote_1",
        service: "remotebuddy",
        promptTokens: 200,
        completionTokens: 50,
      }).ok,
    ).toBe(true);

    const summary = store.getLlmUsageSummary({ windowHours: 24 });

    expect(summary.callCount).toBe(3);
    expect(summary.totalTokens).toBe(500);
    expect(summary.avgTokensPerCall).toBeCloseTo(500 / 3, 5);
    expect(summary.avgTokensPerHour).toBeCloseTo(500 / 24, 5);
    expect(summary.estimatedCallCount).toBe(1);

    const localbuddy = summary.services.find((row) => row.service === "localbuddy");
    expect(localbuddy).toBeDefined();
    expect(localbuddy?.callCount).toBe(2);
    expect(localbuddy?.totalTokens).toBe(250);
    expect(localbuddy?.avgTokensPerHour).toBeCloseTo(250 / 24, 5);
    expect(localbuddy?.avgTokensPerCall).toBe(125);
    expect(localbuddy?.estimatedCallCount).toBe(1);

    const remotebuddy = summary.services.find((row) => row.service === "remotebuddy");
    expect(remotebuddy).toBeDefined();
    expect(remotebuddy?.callCount).toBe(1);
    expect(remotebuddy?.totalTokens).toBe(250);
    expect(remotebuddy?.avgTokensPerHour).toBeCloseTo(250 / 24, 5);
    expect(remotebuddy?.avgTokensPerCall).toBe(250);
  });

  test("tracks session token budget crossings from llm usage telemetry", () => {
    const store = makeStore();

    const first = store.recordLlmUsage(
      {
        id: "usage_worker_1",
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 40,
        completionTokens: 20,
      },
      { sessionTokenBudget: 100, sessionTokenBudgetAction: "pause" },
    );
    expect(first.ok).toBe(true);
    expect(first.crossedLimit).toBe(false);
    expect(first.sessionBudget?.exceeded).toBe(false);
    expect(first.sessionBudget?.remainingTokens).toBe(40);

    const second = store.recordLlmUsage(
      {
        id: "usage_worker_2",
        service: "workerpals",
        sessionId: "dev",
        promptTokens: 30,
        completionTokens: 20,
      },
      { sessionTokenBudget: 100, sessionTokenBudgetAction: "pause" },
    );
    expect(second.ok).toBe(true);
    expect(second.crossedLimit).toBe(true);
    expect(second.sessionBudget?.exceeded).toBe(true);
    expect(second.sessionBudget?.totalTokens).toBe(110);
    expect(second.sessionBudget?.remainingTokens).toBe(0);
    expect(second.sessionBudget?.action).toBe("pause");

    const sessionSummary = store.getSessionLlmUsageSummary("dev");
    expect(sessionSummary).toBeDefined();
    expect(sessionSummary?.totalTokens).toBe(110);
    expect(sessionSummary?.callCount).toBe(2);
    expect(sessionSummary?.sessionId).toBe("dev");
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

  test("persists engine idea trials and rolls outcome learning into snapshot priors", () => {
    const store = makeStore();
    const runId = "run_engine_idea_trials";
    const sessionId = "s1";
    const snapshotId = store.createSnapshot({ sessionId, runId }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId,
      snapshotId,
      sessionId,
      candidates: [
        {
          id: "cand_engine_trial_seed",
          title: "Engine building block: novelty curriculum scheduler",
          objective_type: "lint_fix",
          problem_statement:
            "Prototype novelty curriculum scheduling for autonomous objective selection.",
          trigger_type: "lint_failure",
          component_area: "apps/remotebuddy",
          target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
          scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
          risk_level: "low",
          expected_validation: ["bun run test"],
          estimated_effort: "small",
          why_now_signal_ids: ["sig_queue_health"],
          confidence: 0.92,
          engine_trial: {
            building_block_id: "novelty_curriculum_scheduler",
            algorithm: "novelty curriculum scheduler",
            source: "engine_mapped",
            score: 0.81,
            objective_ids: ["reliable_autonomous_delivery"],
            gap_ids: ["idea_stagnation"],
            source_type: "external_repo",
            source_label: "acme/autonomy-lab",
            source_url: "https://example.com/acme/autonomy-lab",
            source_fingerprint: "fp_autonomy_lab_novelty",
            summary: "Increase idea diversity while preserving safety constraints.",
            hypothesis: "A curriculum schedule improves outcome quality over repeated loops.",
          },
        },
      ],
      objective: {
        id: "obj_engine_trial_seed",
        candidate_id: "cand_engine_trial_seed",
        title: "Seed objective for engine trial persistence",
        instruction: "Implement small autonomous scheduler scaffolding with metrics.",
        objective_type: "lint_fix",
        component_area: "apps/remotebuddy",
        trigger_type: "lint_failure",
        target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run test"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const db = (store as unknown as { db: any }).db;
    const trialBefore = db
      .prepare(
        `SELECT engine_building_block_id, engine_algorithm, inspiration_source_key, inspiration_source_type,
                inspiration_source_label, inspiration_source_url, inspiration_source_fingerprint, status, success, completed_at
         FROM autonomy_engine_idea_trials
         WHERE objective_id = ?`,
      )
      .get("obj_engine_trial_seed") as {
      engine_building_block_id: string;
      engine_algorithm: string;
      inspiration_source_key: string | null;
      inspiration_source_type: string | null;
      inspiration_source_label: string | null;
      inspiration_source_url: string | null;
      inspiration_source_fingerprint: string | null;
      status: string;
      success: number | null;
      completed_at: string | null;
    };
    expect(trialBefore.engine_building_block_id).toBe("novelty_curriculum_scheduler");
    expect(trialBefore.engine_algorithm).toBe("novelty curriculum scheduler");
    expect(String(trialBefore.inspiration_source_key ?? "")).toContain("fingerprint:");
    expect(trialBefore.inspiration_source_type).toBe("external_repo");
    expect(trialBefore.inspiration_source_label).toBe("acme/autonomy-lab");
    expect(trialBefore.inspiration_source_url).toBe("https://example.com/acme/autonomy-lab");
    expect(trialBefore.inspiration_source_fingerprint).toBe("fp_autonomy_lab_novelty");
    expect(trialBefore.status).toBe("dispatched");
    expect(trialBefore.success).toBe(null);
    expect(trialBefore.completed_at).toBe(null);

    const outcome = store.recordOutcome({
      objectiveId: "obj_engine_trial_seed",
      patternKey: decision.patternKey,
      requestId: "req_engine_trial_seed",
      jobId: "job_engine_trial_seed",
      success: true,
      userAction: "applied",
      latencyMs: 12_000,
      reopenedWithin24h: false,
      regressionFlag: false,
    });
    expect(outcome.ok).toBe(true);

    const trialAfter = db
      .prepare(
        `SELECT status, success, user_action, latency_ms, completed_at
         FROM autonomy_engine_idea_trials
         WHERE objective_id = ?`,
      )
      .get("obj_engine_trial_seed") as {
      status: string;
      success: number;
      user_action: string | null;
      latency_ms: number | null;
      completed_at: string | null;
    };
    expect(trialAfter.status).toBe("completed");
    expect(trialAfter.success).toBe(1);
    expect(trialAfter.user_action).toBe("applied");
    expect(trialAfter.latency_ms).toBe(12_000);
    expect(String(trialAfter.completed_at ?? "")).toContain("T");

    const ideaStats = db
      .prepare(
        `SELECT sample_count, ema_success, ema_user_accept
         FROM autonomy_engine_idea_stats
         WHERE engine_building_block_id = ?`,
      )
      .get("novelty_curriculum_scheduler") as {
      sample_count: number;
      ema_success: number;
      ema_user_accept: number;
    };
    expect(ideaStats.sample_count).toBe(1);
    expect(ideaStats.ema_success).toBeGreaterThan(0);
    expect(ideaStats.ema_user_accept).toBeGreaterThan(0);
    const sourceStats = db
      .prepare(
        `SELECT source_type, source_label, source_fingerprint, sample_count, ema_success, ema_user_accept
         FROM autonomy_engine_source_stats
         WHERE source_fingerprint = ?`,
      )
      .get("fp_autonomy_lab_novelty") as {
      source_type: string;
      source_label: string | null;
      source_fingerprint: string | null;
      sample_count: number;
      ema_success: number;
      ema_user_accept: number;
    };
    expect(sourceStats.source_type).toBe("external_repo");
    expect(sourceStats.source_label).toBe("acme/autonomy-lab");
    expect(sourceStats.source_fingerprint).toBe("fp_autonomy_lab_novelty");
    expect(sourceStats.sample_count).toBe(1);
    expect(sourceStats.ema_success).toBeGreaterThan(0);
    expect(sourceStats.ema_user_accept).toBeGreaterThan(0);

    const enriched = store.createSnapshot({ sessionId, runId });
    expect(enriched.engine_idea_priors.length).toBeGreaterThan(0);
    expect(enriched.engine_idea_priors[0]?.engine_building_block_id).toBe(
      "novelty_curriculum_scheduler",
    );
    expect(enriched.engine_source_priors.length).toBeGreaterThan(0);
    expect(enriched.engine_source_priors[0]?.source_type).toBe("external_repo");
  });

  test("curates inspiration sources into trusted shortlist and archives low performers", () => {
    const store = makeStore();
    const autonomyCfg = (
      store as unknown as {
        config?: {
          remotebuddy?: {
            autonomy?: {
              maxDispatchPerHour?: number;
              maxDispatchPerHourByType?: Record<string, number>;
            };
          };
        };
      }
    ).config?.remotebuddy?.autonomy;
    if (autonomyCfg) {
      autonomyCfg.maxDispatchPerHour = 64;
      autonomyCfg.maxDispatchPerHourByType = {
        ...autonomyCfg.maxDispatchPerHourByType,
        lint_fix: 64,
      };
    }
    const sessionId = "s1";
    const snapshotId = store.createSnapshot({
      sessionId,
      runId: "run_source_curation_seed",
    }).snapshot_id;
    const seedObjective = (params: {
      n: number;
      sourceFingerprint: string;
      sourceType: string;
      sourceLabel: string;
      sourceUrl: string;
      success: boolean;
      userAction: string;
    }) => {
      const idSuffix = `${params.sourceFingerprint}_${params.n}`;
      const decision = store.recordObjectiveDecision({
        runId: "run_source_curation_seed",
        snapshotId,
        sessionId,
        candidates: [
          {
            id: `cand_${idSuffix}`,
            title: `Engine building block: source_${params.sourceFingerprint}`,
            objective_type: "lint_fix",
            problem_statement: `Exercise source curation path for ${params.sourceFingerprint}`,
            trigger_type: "lint_failure",
            component_area: "apps/remotebuddy",
            target_paths: [
              `apps/remotebuddy/src/source_${params.sourceFingerprint}_${params.n}.ts`,
            ],
            scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
            risk_level: "low",
            expected_validation: ["bun run test"],
            estimated_effort: "small",
            why_now_signal_ids: ["sig_queue_health"],
            confidence: 0.9,
            engine_trial: {
              building_block_id: `bb_${params.sourceFingerprint}`,
              algorithm: `algo_${params.sourceFingerprint}`,
              source: "engine_mapped",
              score: 0.8,
              objective_ids: ["reliable_autonomous_delivery"],
              gap_ids: ["delivery_reliability_gap"],
              source_type: params.sourceType,
              source_label: params.sourceLabel,
              source_url: params.sourceUrl,
              source_fingerprint: params.sourceFingerprint,
            },
          },
        ],
        objective: {
          id: `obj_${idSuffix}`,
          candidate_id: `cand_${idSuffix}`,
          title: `Objective ${idSuffix}`,
          instruction: `Apply inspiration ${params.sourceFingerprint}`,
          objective_type: "lint_fix",
          component_area: "apps/remotebuddy",
          trigger_type: "lint_failure",
          target_paths: [`apps/remotebuddy/src/source_${params.sourceFingerprint}_${params.n}.ts`],
          scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/src/*.ts"] },
          confidence: 0.9,
          risk_level: "low",
          expected_validation: ["bun run test"],
          status: "dispatched",
        },
      });
      expect(decision.ok).toBe(true);
      const outcome = store.recordOutcome({
        objectiveId: `obj_${idSuffix}`,
        requestId: `req_${idSuffix}`,
        jobId: `job_${idSuffix}`,
        patternKey: decision.patternKey,
        success: params.success,
        userAction: params.userAction,
        latencyMs: params.success ? 11_000 : 220_000,
        reopenedWithin24h: !params.success,
        regressionFlag: !params.success,
      });
      expect(outcome.ok).toBe(true);
    };
    for (let i = 0; i < 7; i += 1) {
      seedObjective({
        n: i,
        sourceFingerprint: "fp_trusted_source",
        sourceType: "external_repo",
        sourceLabel: "trusted/repo",
        sourceUrl: "https://example.com/trusted/repo",
        success: true,
        userAction: "applied",
      });
    }
    for (let i = 0; i < 9; i += 1) {
      seedObjective({
        n: i,
        sourceFingerprint: "fp_archived_source",
        sourceType: "external_doc",
        sourceLabel: "archived/doc",
        sourceUrl: "https://example.com/archived/doc",
        success: false,
        userAction: "rejected",
      });
    }
    const insights = store.listInsights({ limit: 100, feedbackLimit: 10 });
    const trusted = insights.engineSourceStats.find(
      (row) => row.sourceFingerprint === "fp_trusted_source",
    );
    const archived = insights.engineSourceStats.find(
      (row) => row.sourceFingerprint === "fp_archived_source",
    );
    expect(trusted).toBeDefined();
    expect(archived).toBeDefined();
    expect(trusted?.curationStatus).toBe("trusted");
    expect(archived?.curationStatus).toBe("archived");
    expect(trusted?.trustScore ?? 0).toBeGreaterThan(0.6);
    expect(archived?.trustScore ?? 1).toBeLessThan(0.5);
    expect(
      insights.trustedInspirationShortlist.some(
        (row) => row.sourceFingerprint === "fp_trusted_source",
      ),
    ).toBe(true);
    expect(
      insights.archivedInspirationSources.some(
        (row) => row.sourceFingerprint === "fp_archived_source",
      ),
    ).toBe(true);
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

  test("recordOutcome transitions objectives to terminal status and frees concurrency slots", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_terminal" }).snapshot_id;

    const first = store.recordObjectiveDecision({
      runId: "run_terminal",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_terminal_1",
        title: "Seed first active objective",
        instruction: "Fix lint issue in server",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    const second = store.recordObjectiveDecision({
      runId: "run_terminal",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_terminal_2",
        title: "Seed second active objective",
        instruction: "Refresh docs",
        objective_type: "docs",
        component_area: "apps/remotebuddy",
        trigger_type: "queue_health",
        target_paths: ["apps/remotebuddy/docs/queue.md"],
        scope: { read_anywhere: false, write_globs: ["apps/remotebuddy/docs/*.md"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const before = store.evaluateEligibility({
      runId: "run_terminal",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_before_terminal",
          objective_type: "type_fix",
          component_area: "apps/server",
          pattern_key: "pk_before_terminal",
          confidence: 0.95,
        },
      ],
    });
    expect(before.ok).toBe(true);
    expect(before.results?.[0]?.ok).toBe(false);
    expect(String(before.results?.[0]?.reason ?? "")).toContain(
      "max concurrent objectives reached",
    );

    const completed = store.recordOutcome({
      objectiveId: "obj_terminal_1",
      patternKey: first.patternKey,
      requestId: "req_terminal_1",
      jobId: "job_terminal_1",
      success: true,
      userAction: "applied",
      reopenedWithin24h: false,
      regressionFlag: false,
    });
    expect(completed.ok).toBe(true);

    const after = store.evaluateEligibility({
      runId: "run_terminal",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_after_terminal",
          objective_type: "type_fix",
          component_area: "apps/server",
          pattern_key: "pk_after_terminal",
          confidence: 0.95,
        },
      ],
    });
    expect(after.ok).toBe(true);
    expect(after.results?.[0]?.ok).toBe(true);
  });

  test("recordOutcome clears active pattern lock after terminal failure", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_pattern_release",
    }).snapshot_id;

    const seeded = store.recordObjectiveDecision({
      runId: "run_pattern_release",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_pattern_release",
        title: "Seed active pattern objective",
        instruction: "Fix lint issue",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(seeded.ok).toBe(true);

    const blocked = store.evaluateEligibility({
      runId: "run_pattern_release",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_same_pattern_blocked",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.results?.[0]?.ok).toBe(false);
    expect(String(blocked.results?.[0]?.reason ?? "")).toContain(
      "pattern already has active objective",
    );

    const failed = store.recordOutcome({
      objectiveId: "obj_pattern_release",
      patternKey: seeded.patternKey,
      requestId: "req_pattern_release",
      jobId: "job_pattern_release",
      success: false,
      userAction: "failed",
      reopenedWithin24h: false,
      regressionFlag: true,
    });
    expect(failed.ok).toBe(true);

    const unblocked = store.evaluateEligibility({
      runId: "run_pattern_release",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_same_pattern_unblocked",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: seeded.patternKey,
          confidence: 0.95,
        },
      ],
    });
    expect(unblocked.ok).toBe(true);
    expect(unblocked.results?.[0]?.ok).toBe(true);
  });

  test("listInsights returns pattern stats and structured PR feedback", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({ sessionId: "s1", runId: "run_insights" }).snapshot_id;

    const decision = store.recordObjectiveDecision({
      runId: "run_insights",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_insights",
        title: "Seed objective for insights",
        instruction: "Fix lint issue for insights query",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.95,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const outcome = store.recordOutcome({
      objectiveId: "obj_insights",
      patternKey: decision.patternKey,
      requestId: "req_insights",
      jobId: "job_insights",
      success: false,
      userAction: "failed",
      reopenedWithin24h: false,
      regressionFlag: true,
    });
    expect(outcome.ok).toBe(true);

    const feedback = store.recordPrFeedback({
      objectiveId: "obj_insights",
      patternKey: decision.patternKey,
      jobId: "job_insights",
      verdict: "rejected",
      summary: "Missing validation coverage for edge-case transitions.",
      reviewScore: 6.2,
      reviewThreshold: 8.1,
      comments: [
        {
          userLogin: "reviewer-alpha",
          body: "Please add tests for empty queue and stale-claim handoff.",
          createdAt: "2026-03-02T12:00:00.000Z",
          htmlUrl: "https://example.test/comment/1",
        },
      ],
    });
    expect(feedback.ok).toBe(true);

    const insights = store.listInsights({
      patternKey: decision.patternKey,
      objectiveId: "obj_insights",
      limit: 5,
      feedbackLimit: 5,
    });
    expect(insights.patternStats.length).toBeGreaterThan(0);
    expect(insights.patternStats[0]?.patternKey).toBe(decision.patternKey);
    expect(insights.recentPrFeedback.length).toBeGreaterThan(0);
    expect(insights.recentPrFeedback[0]?.objectiveId).toBe("obj_insights");
    expect(insights.recentPrFeedback[0]?.summary).toContain("Missing validation coverage");
    expect(insights.recentPrFeedback[0]?.comments.length).toBeGreaterThan(0);
  });

  test("recordPrFeedback resolves autonomy pattern context from queued job params", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-pr-feedback-context-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const enqueued = jobQueue.enqueue({
        taskId: "task_autonomy_feedback",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          requestId: "req_autonomy_feedback",
          instruction: "Fix the targeted queue assertions.",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj_autonomy_feedback",
            patternKey: "flaky_test::components::__tests__",
          },
        },
      });
      expect(enqueued.ok).toBe(true);
      expect(typeof enqueued.jobId).toBe("string");

      const feedback = store.recordPrFeedback({
        jobId: enqueued.jobId,
        prUrl: "https://github.com/example/repo/pull/123",
        verdict: "rejected",
        summary: "Still missing coverage for stale-claim recovery.",
        reviewScore: 7.4,
        reviewThreshold: 8.1,
      });

      expect(feedback.ok).toBe(true);
      expect(feedback.patternKey).toBe("flaky_test::components::__tests__");
      expect(feedback.objectiveId).toBe("obj_autonomy_feedback");

      const insights = store.listInsights({
        patternKey: "flaky_test::components::__tests__",
        objectiveId: "obj_autonomy_feedback",
        limit: 5,
        feedbackLimit: 5,
      });
      expect(insights.recentPrFeedback.length).toBeGreaterThan(0);
      expect(insights.recentPrFeedback[0]?.objectiveId).toBe("obj_autonomy_feedback");
      expect(insights.recentPrFeedback[0]?.summary).toContain("stale-claim recovery");
    } finally {
      jobQueue.close();
    }
  });

  test("recordPrFeedback resolves review-agent source job context", () => {
    const { store, dbPath } = makePersistentStore("pushpals-autonomy-pr-feedback-source-job-");
    const jobQueue = new JobQueue(dbPath);

    try {
      const source = jobQueue.enqueue({
        taskId: "task_autonomy_source_feedback",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          requestId: "req_autonomy_source_feedback",
          instruction: "Improve the smoke review path.",
          autonomy: {
            origin: "autonomy",
            objectiveId: "obj_autonomy_source_feedback",
            patternKey: "web_smoke::review_path",
          },
        },
      });
      expect(source.ok).toBe(true);
      expect(typeof source.jobId).toBe("string");

      const reviewFix = jobQueue.enqueue({
        taskId: "review-fix-pr123-1",
        kind: "task.execute",
        sessionId: "s1",
        params: {
          instruction: "Fix review feedback for PR #123.",
          reviewAgent: {
            prNumber: 123,
            sourceJobId: source.jobId,
            resolutionType: "review_fix",
          },
        },
      });
      expect(reviewFix.ok).toBe(true);
      expect(typeof reviewFix.jobId).toBe("string");

      const feedback = store.recordPrFeedback({
        jobId: reviewFix.jobId,
        prUrl: "https://github.com/example/repo/pull/123",
        verdict: "approved_unmergeable",
        summary: "Approved but branch needs conflict resolution.",
        reviewScore: 8.4,
        reviewThreshold: 8.1,
      });

      expect(feedback.ok).toBe(true);
      expect(feedback.patternKey).toBe("web_smoke::review_path");
      expect(feedback.objectiveId).toBe("obj_autonomy_source_feedback");
    } finally {
      jobQueue.close();
    }
  });

  test("recordPrFeedback ignores legacy PR feedback that cannot resolve autonomy context", () => {
    const store = makeStore();

    const feedback = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:987:head:legacy:verdict:rejected",
      prNumber: 987,
      prUrl: "https://github.com/example/repo/pull/987",
      verdict: "rejected",
      summary: "Legacy PR has no source job metadata to map back to autonomy.",
      reviewScore: 7.2,
      reviewThreshold: 8.1,
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.ignored).toBe(true);
    expect(feedback.reason).toContain("unable to resolve patternKey");

    const insights = store.listInsights({ limit: 5, feedbackLimit: 5 });
    expect(insights.recentPrFeedback).toHaveLength(0);
  });

  test("recordPrFeedback keeps approved_unmergeable feedback non-terminal", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_merge_conflict_feedback",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_merge_conflict_feedback",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_merge_conflict_feedback",
        title: "Seed merge-conflict PR feedback objective",
        instruction: "Exercise approved-unmergeable feedback handling.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    const feedback = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:42:head:abc123:verdict:approved_unmergeable",
      objectiveId: "obj_merge_conflict_feedback",
      requestId: "req_merge_conflict_feedback",
      jobId: "job_merge_conflict_feedback",
      patternKey: decision.patternKey,
      prNumber: 42,
      verdict: "approved_unmergeable",
      summary: "Approved by ReviewAgent, but GitHub reported a merge conflict.",
      reviewScore: 8.3,
      reviewThreshold: 8.1,
    });

    expect(feedback.ok).toBe(true);
    expect(feedback.success).toBeUndefined();
    expect(autonomyOutcomeCount(store, "obj_merge_conflict_feedback")).toBe(0);
  });

  test("evaluator scores iterative PR feedback as one latest objective sample", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_review_loop",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_review_loop",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_review_loop",
        title: "Seed iterative PR review objective",
        instruction: "Exercise iterative review feedback handling.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun test tests/server.autonomy-store.test.ts"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);

    for (let i = 0; i < 7; i += 1) {
      const feedback = store.recordPrFeedback({
        feedbackKey: `review_agent:pr:42:head:reject-${i}:verdict:rejected`,
        objectiveId: "obj_review_loop",
        requestId: "req_review_loop",
        jobId: "job_review_loop",
        patternKey: decision.patternKey,
        prNumber: 42,
        verdict: "rejected",
        summary: `Review iteration ${i + 1} still needs fixes.`,
        reviewScore: 7.5,
        reviewThreshold: 8.1,
      });
      expect(feedback.ok).toBe(true);
    }

    const rejectedCard = runEvaluatorNow(store);
    expect(rejectedCard.sampleCount).toBe(1);
    expect(rejectedCard.successRate).toBe(0);
    expect(rejectedCard.regretRate).toBe(1);
    expect(rejectedCard.recommendation).toBe("constrain");
    expect(autonomyObjectiveStatus(store, "obj_review_loop")).toBe("dispatched");
    expect(autonomyPatternSampleCount(store, decision.patternKey)).toBe(0);

    const frozen = store.updateSafetyState({
      freezeForMs: 600_000,
      freezeReason: "auto_freeze:evaluator_pause",
    });
    expect(frozen.ok).toBe(true);
    expect(frozen.state.isFrozen).toBe(true);

    const recheckedCard = runEvaluatorNow(store);
    expect(recheckedCard.sampleCount).toBe(1);
    expect(recheckedCard.recommendation).toBe("constrain");
    expect(store.getSafetyState().isFrozen).toBe(false);

    const merged = store.recordPrFeedback({
      feedbackKey: "review_agent:pr:42:head:merged:verdict:approved_merged",
      objectiveId: "obj_review_loop",
      requestId: "req_review_loop",
      jobId: "job_review_loop",
      patternKey: decision.patternKey,
      prNumber: 42,
      verdict: "approved_merged",
      summary: "ReviewAgent approved and merged the PR.",
      reviewScore: 8.4,
      reviewThreshold: 8.1,
    });
    expect(merged.ok).toBe(true);
    expect(merged.success).toBe(true);

    const mergedCard = runEvaluatorNow(store);
    expect(mergedCard.sampleCount).toBe(1);
    expect(mergedCard.successRate).toBe(1);
    expect(mergedCard.regretRate).toBe(0);
    expect(mergedCard.recommendation).toBe("constrain");
    expect(autonomyObjectiveStatus(store, "obj_review_loop")).toBe("completed");
    expect(autonomyPatternSampleCount(store, decision.patternKey)).toBe(1);
  });

  test("evaluator still pauses on independent failed objective samples", () => {
    const store = makeStore();

    for (let i = 0; i < 6; i += 1) {
      const outcome = store.recordOutcome({
        objectiveId: `obj_independent_failure_${i}`,
        requestId: `req_independent_failure_${i}`,
        jobId: `job_independent_failure_${i}`,
        patternKey: `pk_independent_failure_${i}`,
        success: false,
        userAction: "failed",
        reopenedWithin24h: false,
        regressionFlag: true,
      });
      expect(outcome.ok).toBe(true);
    }

    const card = runEvaluatorNow(store);
    expect(card.sampleCount).toBe(6);
    expect(card.successRate).toBe(0);
    expect(card.regretRate).toBe(1);
    expect(card.recommendation).toBe("pause");
    expect(store.getSafetyState().isFrozen).toBe(true);
    expect(store.getSafetyState().freezeReason).toBe("auto_freeze:evaluator_pause");
  });

  test("ingestInspirationPatterns dedupes fingerprints and tracks source attribution", () => {
    const store = makeStore();
    const firstIngest = store.ingestInspirationPatterns({
      entries: [
        {
          source_type: "external_repo",
          source_label: "github:org/autonomy-lab",
          source_url: "https://github.com/org/autonomy-lab",
          algorithm: "queue pressure governor",
          when_to_use: "when workers are saturated and queue latency increases",
          summary: "Throttle autonomous dispatch based on queue pressure and worker occupancy.",
          risks: ["Over-throttling can starve useful work."],
          validation: ["Replay historical queue windows to verify throughput/latency tradeoff."],
          tags: ["backpressure", "scheduling"],
          quality_score: 0.82,
          freshness_score: 0.7,
          metadata: { license: "MIT" },
        },
      ],
    });
    expect(firstIngest.ok).toBe(true);
    expect(firstIngest.inserted).toBe(1);
    expect(firstIngest.updated).toBe(0);

    const secondIngest = store.ingestInspirationPatterns({
      entries: [
        {
          source_type: "external_doc",
          source_label: "docs:ops-handbook",
          source_url: "https://example.test/ops/handbook",
          algorithm: "queue pressure governor",
          when_to_use: "when workers are saturated and queue latency increases",
          summary: "Use dynamic dispatch throttles and release caps as pressure falls.",
          risks: ["Can mask structural capacity limits."],
          validation: ["A/B replay with synthetic burst traffic."],
          tags: ["backpressure", "safety"],
          quality_score: 0.74,
          freshness_score: 0.9,
          metadata: { section: "throughput-control" },
        },
      ],
    });
    expect(secondIngest.ok).toBe(true);
    expect(secondIngest.inserted).toBe(0);
    expect(secondIngest.updated).toBe(1);

    const all = store.listInspirationPatterns({ limit: 10 });
    expect(all.length).toBe(1);
    const pattern = all[0];
    expect(pattern.algorithm).toBe("queue pressure governor");
    expect(pattern.seenCount).toBe(2);
    expect(pattern.tags).toContain("backpressure");
    expect(pattern.tags).toContain("safety");
    expect(pattern.sourceRefs.some((ref) => ref.includes("github.com"))).toBe(true);
    expect(pattern.sourceRefs.some((ref) => ref.includes("ops/handbook"))).toBe(true);

    const tagFiltered = store.listInspirationPatterns({ tag: "safety", limit: 10 });
    expect(tagFiltered.length).toBe(1);
    const queryFiltered = store.listInspirationPatterns({
      q: "queue latency",
      limit: 10,
    });
    expect(queryFiltered.length).toBe(1);
  });

  test("answerQuestion returns resume context and objective can be re-dispatched automatically", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_question_resume",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_question_resume",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_question_resume",
        candidate_id: "cand_question_resume",
        title: "Clarify queue priority objective",
        instruction: "Implement queue backpressure guardrail for autonomous dispatch.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["bun run test:root"],
        status: "blocked",
        block_reason: "requires_user_input",
      },
      question: {
        id: "q_question_resume",
        question: "Which queue class should receive priority under contention?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(decision.ok).toBe(true);

    const answered = store.answerQuestion(
      "q_question_resume",
      "Prioritize interactive tasks first, then normal, while capping background dispatch.",
    );
    expect(answered.ok).toBe(true);
    expect(answered.status).toBe("valid");
    expect(answered.objectiveId).toBe("obj_question_resume");
    expect(answered.resume?.objectiveId).toBe("obj_question_resume");
    expect(answered.resume?.sessionId).toBe("s1");
    expect(answered.resume?.runId).toBe("run_question_resume");
    expect(answered.resume?.snapshotId).toBe(snapshotId);
    expect(answered.resume?.patternKey).toBe(decision.patternKey);
    expect(answered.resume?.componentArea).toBe("apps/server");
    expect(answered.resume?.targetPaths).toEqual(["apps/server/src/autonomy.ts"]);
    expect(answered.resume?.writeGlobs).toEqual(["apps/server/src/*"]);
    expect(answered.resume?.idempotencyKey).toBe("autonomy_resume:q_question_resume");
    expect(String(answered.resume?.instruction ?? "")).toContain(
      "Prioritize interactive tasks first",
    );

    const db = (store as unknown as { db: any }).db;
    const gatedBeforeDispatch = db
      .prepare(`SELECT status FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_resume") as { status: string };
    expect(gatedBeforeDispatch.status).toBe("gated");

    store.markObjectiveDispatched("obj_question_resume", "req_question_resume");
    const dispatched = db
      .prepare(`SELECT status, request_id FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_resume") as { status: string; request_id: string | null };
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.request_id).toBe("req_question_resume");
  });

  test("markObjectiveRunningByJobId promotes linked objectives to running", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_running_state",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_running_state",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_running_state",
        candidate_id: "cand_running_state",
        title: "Promote objective to running on claim",
        instruction: "Run a scoped lint fix",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.91,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
        request_id: "req_running_state",
      },
    });
    expect(decision.ok).toBe(true);

    store.linkJobToObjectiveByRequest("req_running_state", "job_running_state");
    store.markObjectiveRunningByJobId("job_running_state");

    const db = (store as unknown as { db: any }).db;
    const row = db
      .prepare(`SELECT status, job_id FROM autonomy_objectives WHERE id = ?`)
      .get("obj_running_state") as { status: string; job_id: string | null };
    expect(row.status).toBe("running");
    expect(row.job_id).toBe("job_running_state");
  });

  test("safety state kill switch blocks eligibility", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_safety_gate",
    }).snapshot_id;
    const toggled = store.updateSafetyState({ killSwitchEnabled: true });
    expect(toggled.ok).toBe(true);
    expect(toggled.state.killSwitchEnabled).toBe(true);

    const result = store.evaluateEligibility({
      runId: "run_safety_gate",
      snapshotId,
      candidates: [
        {
          candidate_id: "cand_safety_gate",
          objective_type: "lint_fix",
          component_area: "apps/server",
          pattern_key: "pk_safety_gate",
          confidence: 0.95,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.results?.[0]?.ok).toBe(false);
    expect(String(result.results?.[0]?.reason ?? "")).toContain("kill switch");
  });

  test("question actions support skip/close/escalate", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_question_actions",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_question_actions",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_question_actions",
        candidate_id: "cand_question_actions",
        title: "Question action target",
        instruction: "Need user preference.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "blocked",
      },
      question: {
        id: "q_question_actions",
        question: "Continue with strict priority?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(decision.ok).toBe(true);

    const escalated = store.actOnQuestion("q_question_actions", "escalate", "Need manual call");
    expect(escalated.ok).toBe(true);
    expect(escalated.action).toBe("escalate");

    const db = (store as unknown as { db: any }).db;
    const questionRow = db
      .prepare(`SELECT status, closed_reason FROM questions_queue WHERE id = ?`)
      .get("q_question_actions") as { status: string; closed_reason: string | null };
    expect(questionRow.status).toBe("closed");
    expect(questionRow.closed_reason).toBe("escalated_to_human");
    const objectiveRow = db
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_question_actions") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("escalated");
    expect(objectiveRow.block_reason).toBe("escalated_to_human");
  });

  test("stale objective sweeper dead-letters stale active objectives", () => {
    const store = makeStore();
    const snapshotId = store.createSnapshot({
      sessionId: "s1",
      runId: "run_stale_sweep",
    }).snapshot_id;
    const decision = store.recordObjectiveDecision({
      runId: "run_stale_sweep",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_stale_sweep",
        candidate_id: "cand_stale_sweep",
        title: "Stale objective candidate",
        instruction: "Test stale sweep.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "lint_failure",
        target_paths: ["apps/server/src/autonomy.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.92,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "dispatched",
      },
    });
    expect(decision.ok).toBe(true);
    const db = (store as unknown as { db: any }).db;
    db.prepare(
      `UPDATE autonomy_objectives SET updated_at = datetime('now', '-5 hours') WHERE id = ?`,
    ).run("obj_stale_sweep");

    const sweep = store.maybeSweepStaleObjectives(new Date(Date.now() + 120_000).toISOString());
    expect(sweep.ok).toBe(true);
    expect(sweep.deadLettered).toBeGreaterThanOrEqual(1);
    const objectiveRow = db
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_stale_sweep") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("dead_letter");
    expect(objectiveRow.block_reason).toBe("stale_objective_timeout");
  });

  test("restart recovery sweep closes stale blocked objective + question without orphans", () => {
    const { store: firstStore, dbPath } = makePersistentStore("pushpals-autonomy-recovery-");
    const snapshotId = firstStore.createSnapshot({
      sessionId: "s1",
      runId: "run_restart_recovery",
    }).snapshot_id;
    const created = firstStore.recordObjectiveDecision({
      runId: "run_restart_recovery",
      snapshotId,
      sessionId: "s1",
      objective: {
        id: "obj_restart_recovery",
        candidate_id: "cand_restart_recovery",
        title: "Pending clarification objective",
        instruction: "Need clarification before dispatch.",
        objective_type: "lint_fix",
        component_area: "apps/server",
        trigger_type: "queue_health",
        target_paths: ["apps/server/src/server_main.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/server/src/*.ts"] },
        confidence: 0.9,
        risk_level: "low",
        expected_validation: ["bun run lint"],
        status: "blocked",
        block_reason: "requires_user_input",
      },
      question: {
        id: "q_restart_recovery",
        question: "Should interactive requests always preempt background work?",
        question_type: "bounded_text",
        expected_answer_schema: { min_length: 3, max_length: 300 },
      },
    });
    expect(created.ok).toBe(true);

    const firstDb = (firstStore as unknown as { db: any }).db;
    firstDb
      .prepare(
        `UPDATE autonomy_objectives SET updated_at = datetime('now', '-6 hours') WHERE id = ?`,
      )
      .run("obj_restart_recovery");

    closeTrackedStore(firstStore);
    const resumedStore = new AutonomyStore(dbPath);
    stores.push(resumedStore);

    const sweep = resumedStore.maybeSweepStaleObjectives(
      new Date(Date.now() + 120_000).toISOString(),
    );
    expect(sweep.ok).toBe(true);
    expect(sweep.deadLettered).toBeGreaterThanOrEqual(1);

    const resumedDb = (resumedStore as unknown as { db: any }).db;
    const objectiveRow = resumedDb
      .prepare(`SELECT status, block_reason FROM autonomy_objectives WHERE id = ?`)
      .get("obj_restart_recovery") as { status: string; block_reason: string | null };
    expect(objectiveRow.status).toBe("dead_letter");
    expect(objectiveRow.block_reason).toBe("stale_objective_timeout");
    const questionRow = resumedDb
      .prepare(`SELECT status, closed_reason FROM questions_queue WHERE id = ?`)
      .get("q_restart_recovery") as { status: string; closed_reason: string | null };
    expect(questionRow.status).toBe("closed");
    expect(questionRow.closed_reason).toBe("stale_objective_timeout");
  });
});
