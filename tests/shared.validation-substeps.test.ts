import { describe, expect, test } from "bun:test";
import {
  normalizeValidationSubstepReport,
  VALIDATION_SUBSTEP_LIMITS,
  type ValidationSubstepReport,
} from "../packages/shared/src/validation_substeps";

function report(): ValidationSubstepReport {
  return {
    stages: [
      {
        source: "aggregate_lines",
        observationOnly: true,
        stageId: "substep-1",
        ordinal: 1,
        total: 2,
        boundary: "complete",
        durationMs: 40,
        observedElapsedMs: 40,
        reportedDurationMs: 31.2,
        completionMarker: "ok",
      },
      {
        source: "aggregate_lines",
        observationOnly: true,
        stageId: "substep-2",
        ordinal: 2,
        total: 2,
        boundary: "incomplete",
        durationMs: null,
        observedElapsedMs: 100,
        reportedDurationMs: null,
        incompleteReason: "timed_out",
      },
    ],
    truncated: false,
    ignoredLines: 5,
  };
}

describe("validation substep persistence normalization", () => {
  test("round trips bounded observations and preserves unknown durations as null", () => {
    const input = report();
    const normalized = normalizeValidationSubstepReport(JSON.parse(JSON.stringify(input)));
    expect(normalized).toEqual(input);
    expect(normalized?.stages[1]?.durationMs).toBeNull();
    expect(normalized?.stages[1]?.observedElapsedMs).toBe(100);
  });

  test("regenerates ordinal-only stage IDs and strips all raw strings/extra authority fields", () => {
    const input: any = report();
    Object.assign(input, { secret: "raw-report-secret", ok: true, healthLease: "renew" });
    for (const stage of input.stages)
      Object.assign(stage, {
        stageId: "--token=raw-stage-secret",
        label: "raw-label-secret",
        stageToken: "raw-token-secret",
        output: "raw-log-secret",
        ok: true,
        success: true,
        publish: true,
        renewLease: true,
      });
    const normalized = normalizeValidationSubstepReport(input);
    expect(normalized).toEqual(report());
    expect(JSON.stringify(normalized)).not.toContain("secret");
    expect(normalized?.stages.every((stage) => !("ok" in stage) && !("success" in stage))).toBe(
      true,
    );
  });

  test.each(
    [
      undefined,
      null,
      [],
      {},
      { stages: [], truncated: false },
      { stages: [], truncated: "false", ignoredLines: 0 },
      { stages: [], truncated: false, ignoredLines: -1 },
      { stages: [], truncated: false, ignoredLines: "0" },
      { stages: [], truncated: false, ignoredLines: Number.POSITIVE_INFINITY },
      { stages: [], truncated: false, ignoredLines: VALIDATION_SUBSTEP_LIMITS.ignoredLines + 1 },
    ].map((input) => ({ input })),
  )("omits malformed report %# without throwing", ({ input }) => {
    expect(normalizeValidationSubstepReport(input)).toBeUndefined();
  });

  test.each([
    { ordinal: 0 },
    { ordinal: "1" },
    { total: 0 },
    { total: 10_001 },
    { durationMs: -1 },
    { durationMs: Number.NaN },
    { durationMs: 86_400_001 },
    { durationMs: "40" },
    { observedElapsedMs: 39 },
    { reportedDurationMs: Number.POSITIVE_INFINITY },
    { source: "raw-secret" },
    { observationOnly: false },
    { boundary: "start" },
    { completionMarker: "success-and-publish" },
    { completionMarker: { toString: () => "ok" } },
  ])("visibly drops invalid completed stage %# while preserving valid siblings", (fields) => {
    const input: any = report();
    Object.assign(input.stages[0], fields);
    const normalized = normalizeValidationSubstepReport(input);
    expect(normalized).toMatchObject({ truncated: true, stages: [report().stages[1]] });
    expect(normalized?.stages).toHaveLength(1);
  });

  test.each([
    { durationMs: 0 },
    { reportedDurationMs: 1 },
    { incompleteReason: "raw-secret-reason" },
    { incompleteReason: { toString: () => "timed_out" } },
    { observedElapsedMs: -1 },
  ])("never turns incomplete observations into complete/zero-duration stages %#", (fields) => {
    const input: any = report();
    Object.assign(input.stages[1], fields);
    const normalized = normalizeValidationSubstepReport(input);
    expect(normalized).toMatchObject({ truncated: true, stages: [report().stages[0]] });
    expect(normalized?.stages).toHaveLength(1);
  });

  test("preserves null completed duration when the observer clock was unavailable", () => {
    const input = report();
    input.stages[0]!.durationMs = null;
    input.stages[0]!.observedElapsedMs = null;
    expect(normalizeValidationSubstepReport(input)).toEqual(input);
  });

  test("caps huge arrays, deduplicates ordinals, and rejects inconsistent aggregate totals", () => {
    const input = report();
    input.stages = Array.from({ length: 1_000 }, (_, index) => ({
      ...input.stages[0]!,
      ordinal: index + 1,
      total: 1_000,
    }));
    const normalized = normalizeValidationSubstepReport(input);
    expect(normalized?.truncated).toBe(true);
    expect(normalized?.stages).toHaveLength(VALIDATION_SUBSTEP_LIMITS.stages);
    expect(normalized?.stages.at(-1)?.stageId).toBe(`substep-${VALIDATION_SUBSTEP_LIMITS.stages}`);
    const duplicate = report();
    duplicate.stages[1]!.ordinal = 1;
    expect(normalizeValidationSubstepReport(duplicate)?.stages).toHaveLength(1);
    const inconsistent = report();
    inconsistent.stages[1]!.total = 3;
    expect(normalizeValidationSubstepReport(inconsistent)).toMatchObject({
      truncated: true,
      stages: [inconsistent.stages[0]],
    });
  });

  test("does not let throwing local getters disrupt authoritative result handling", () => {
    const input = Object.defineProperty({}, "stages", {
      get() {
        throw new Error("private error");
      },
    });
    expect(normalizeValidationSubstepReport(input)).toBeUndefined();
  });
});
