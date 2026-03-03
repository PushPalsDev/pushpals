import { afterEach, describe, expect, test } from "bun:test";
import { AutonomyStore } from "../apps/server/src/autonomy";
import {
  handleAutonomyPrFeedbackRequest,
  type AutonomyPrFeedbackEvent,
} from "../apps/server/src/autonomy_pr_feedback_handler";

const stores: AutonomyStore[] = [];

function makeStore(): AutonomyStore {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  return store;
}

function seedObjective(
  store: AutonomyStore,
  objectiveId: string,
): { objectiveId: string; patternKey: string } {
  const sessionId = "s-autonomy-route-tests";
  const snapshotId = store.createSnapshot({ sessionId, runId: "run_route_seed" }).snapshot_id;
  const decision = store.recordObjectiveDecision({
    runId: `run_${objectiveId}`,
    snapshotId,
    sessionId,
    objective: {
      id: objectiveId,
      title: `Seed objective ${objectiveId}`,
      instruction: "Seed objective for PR feedback route tests",
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
  return { objectiveId, patternKey: decision.patternKey };
}

const compact = (value: unknown, maxChars = 500): string => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
};

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("handleAutonomyPrFeedbackRequest", () => {
  test("stores feedback and returns event payload when sessionId is provided", () => {
    const store = makeStore();
    const sessionId = "sess-route-success";
    const { objectiveId } = seedObjective(store, "obj_route_success");

    const { status, response, event } = handleAutonomyPrFeedbackRequest({
      body: {
        sessionId,
        objectiveId,
        verdict: "rejected_policy_gap",
        summary: "Needs additional safeguards",
      },
      autonomyStore: store,
      compactText: compact,
    });

    expect(status).toBe(200);
    const data = response as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect((event as AutonomyPrFeedbackEvent | undefined)?.success).toBe(false);
    expect(event?.sessionId).toBe(sessionId);
  });

  test("deduped feedback preserves single row but still produces event metadata", () => {
    const store = makeStore();
    const sessionId = "sess-route-dedupe";
    const { objectiveId, patternKey } = seedObjective(store, "obj_route_dedupe");
    const body = {
      sessionId,
      objectiveId,
      verdict: "rejected_conflict",
      feedbackKey: "route-dedupe-key",
    };

    const first = handleAutonomyPrFeedbackRequest({
      body,
      autonomyStore: store,
      compactText: compact,
    });
    expect(first.status).toBe(200);
    const firstData = first.response as { ok?: boolean };
    expect(firstData.ok).toBe(true);
    expect(first.event?.sessionId).toBe(sessionId);

    const second = handleAutonomyPrFeedbackRequest({
      body,
      autonomyStore: store,
      compactText: compact,
    });
    expect(second.status).toBe(200);
    const secondData = second.response as { deduped?: boolean };
    expect(secondData.deduped).toBe(true);
    expect(second.event?.sessionId).toBe(sessionId);

    const db = (store as unknown as { db: any }).db;
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM autonomy_pr_feedback WHERE pattern_key = ?`)
      .get(patternKey) as { count: number };
    expect(row.count).toBe(1);
  });

  test("returns 400 with no event when pattern context is missing", () => {
    const store = makeStore();
    const { status, response, event } = handleAutonomyPrFeedbackRequest({
      body: { sessionId: "sess-route-error", verdict: "rejected_merge_conflict" },
      autonomyStore: store,
      compactText: compact,
    });

    expect(status).toBe(400);
    const data = response as { ok?: boolean };
    expect(data.ok).toBe(false);
    expect(event).toBeUndefined();
  });

  test("maps positive verdict payloads to acceptance metadata", () => {
    const store = makeStore();
    const sessionId = "sess-route-positive";
    const { objectiveId } = seedObjective(store, "obj_route_positive");

    const { status, response, event } = handleAutonomyPrFeedbackRequest({
      body: {
        sessionId,
        objectiveId,
        verdict: "approved_merged",
        summary: "Ship it",
      },
      autonomyStore: store,
      compactText: compact,
    });

    expect(status).toBe(200);
    const data = response as { success?: boolean };
    expect(data.success).toBe(true);
    expect(event?.success).toBe(true);
    expect(event?.outcome).toContain("approved");
  });

  test("fills missing event metadata using resolved store context", () => {
    const store = makeStore();
    const sessionId = "sess-route-metadata";
    const { objectiveId, patternKey } = seedObjective(store, "obj_route_metadata");

    const { status, response, event } = handleAutonomyPrFeedbackRequest({
      body: {
        sessionId,
        objectiveId,
        patternKey: "   ",
        verdict: "rejected_ci_failed",
        summary: "CI never passed",
      },
      autonomyStore: store,
      compactText: compact,
    });

    expect(status).toBe(200);
    const data = response as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(event?.sessionId).toBe(sessionId);
    expect(event?.patternKey).toBe(patternKey);
    expect(event?.objectiveId).toBe(objectiveId);
    expect(event?.outcome).toContain("rejected");
  });
});
