import { afterEach, describe, expect, test } from "bun:test";
import { AutonomyStore } from "../apps/server/src/autonomy";

const stores: AutonomyStore[] = [];

function makeStore(): AutonomyStore {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("server AutonomyStore policy gates", () => {
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

  test("rejects read_anywhere=true when not allowlisted", () => {
    const store = makeStore();
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

    expect(result.ok).toBe(false);
    expect(String(result.reason ?? "")).toContain("read_anywhere");
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
});
