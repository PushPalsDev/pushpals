import { describe, expect, test } from "bun:test";
import {
  createValidationSubstepCollector,
  VALIDATION_SUBSTEP_LIMITS,
  type ValidationSubstepTiming,
} from "../apps/source_control_manager/src/validation_substeps";

function fixture() {
  let clock = 100;
  const events: ValidationSubstepTiming[] = [];
  const collector = createValidationSubstepCollector({
    nowMs: () => clock,
    onEvent: (event) => events.push({ ...event }),
  });
  return {
    collector,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("bounded validation substep observations", () => {
  test("correlates generic aggregate stages across streams and separates observed/reported durations", () => {
    const { collector, events, advance } = fixture();
    collector.onStdoutLine("[1/2] [quality/types] Check static types");
    expect(events[0]).toMatchObject({
      stageId: "substep-1",
      ordinal: 1,
      total: 2,
      boundary: "start",
      durationMs: null,
      observedElapsedMs: 0,
    });
    advance(250);
    collector.onStderrLine("[ok] Check static types (123.4 ms)");
    collector.onStdoutLine("[2/2] [quality/tests] Run focused checks");
    advance(50);
    collector.onStdoutLine("[ok] Run focused checks (49 ms)");
    const report = collector.finish();
    expect(events.map((event) => event.boundary)).toEqual([
      "start",
      "complete",
      "start",
      "complete",
    ]);
    expect(report).toMatchObject({ truncated: false, ignoredLines: 0 });
    expect(report.stages[0]).toMatchObject({
      boundary: "complete",
      durationMs: 250,
      observedElapsedMs: 250,
      reportedDurationMs: 123.4,
      completionMarker: "ok",
      observationOnly: true,
      source: "aggregate_lines",
    });
    expect(report.stages[1]?.durationMs).toBe(50);
    expect(report.stages.every((stage) => !("ok" in stage) && !("success" in stage))).toBe(true);
  });

  test.each(["ok", "fail", "error"])(
    "records an explicit %s marker only as an observation",
    (marker) => {
      const { collector, advance } = fixture();
      collector.onStdoutLine("[1/1] [step/id] Required checks");
      advance(10);
      collector.onStdoutLine(`[${marker}] Required checks (8 ms)`);
      expect(collector.finish().stages[0]).toMatchObject({
        boundary: "complete",
        completionMarker: marker,
        observationOnly: true,
        durationMs: 10,
      });
    },
  );

  test("accepts a bounded generic aggregate prefix without exposing it or guessing failure prose", () => {
    const { collector, events, advance } = fixture();
    collector.onStdoutLine("[build checks 1/3] [generic/type-check] Static checks");
    advance(30);
    collector.onStdoutLine("[ok] Static checks (20 ms)");
    collector.onStdoutLine("[build checks 2/3] [generic/test-check] Focused checks");
    collector.onStderrLine(
      "[build checks] failed during Focused checks [generic/test-check] after 17 ms. Command exited 1",
    );
    const report = collector.finish();
    expect(report.stages.map((stage) => stage.boundary)).toEqual(["complete", "incomplete"]);
    expect(report.stages[0]).toMatchObject({ ordinal: 1, total: 3, durationMs: 30 });
    expect(JSON.stringify({ report, events })).not.toContain("build checks");
  });

  test("never returns stage tokens, raw labels, credentials, or log output", () => {
    const { collector, events } = fixture();
    const secret = "https://user:super-secret@example.invalid --token=credential-value";
    collector.onStdoutLine(`[1/1] [private-stage-secret] ${secret}`);
    collector.onStderrLine(`ordinary output containing ${secret}`);
    collector.onStdoutLine(`[ok] ${secret} (1 ms)`);
    const encoded = JSON.stringify({ events, report: collector.finish() });
    for (const value of [
      secret,
      "private-stage-secret",
      "credential-value",
      "super-secret",
      "example.invalid",
      "ordinary output",
    ]) {
      expect(encoded).not.toContain(value);
    }
    expect(encoded).toContain("substep-1");
  });

  test("accepts SGR colors but ignores cursor/OSC/control injection and misleading unanchored text", () => {
    const { collector, advance } = fixture();
    collector.onStdoutLine("log says [1/1] [fake/id] Check");
    collector.onStdoutLine("\u001b]0;secret\u0007[1/1] [fake/id] Check");
    collector.onStdoutLine("\u001b[2J[1/1] [fake/id] Check");
    collector.onStdoutLine("[1/1] [fake/id] Check\nextra line");
    collector.onStdoutLine("[1/1] [fake/id] Check\u0000");
    collector.onStdoutLine("\u001b[32m[1/1] [generic/id] Check\u001b[0m\r");
    advance(20);
    collector.onStdoutLine("prefix [ok] Check (4 ms)");
    collector.onStdoutLine("[ok] Check (4 ms) suffix");
    collector.onStderrLine("\u001b[1;32m[ok] Check (4 ms)\u001b[0m");
    expect(collector.finish()).toMatchObject({
      truncated: false,
      ignoredLines: 7,
      stages: [{ boundary: "complete", durationMs: 20, reportedDurationMs: 4 }],
    });
  });

  test.each([
    "[0/1] [step/id] Check",
    "[2/1] [step/id] Check",
    "[1/10001] [step/id] Check",
    "[1/1] [] Check",
    "[1/1] [step/id]",
    "[1/1] [step/id]   ",
    "[1.5/2] [step/id] Check",
    "[1/2] [step/id] Check\u202e",
  ])("ignores malformed start %s", (line) => {
    const { collector } = fixture();
    collector.onStdoutLine(line);
    expect(collector.finish()).toEqual({ stages: [], truncated: false, ignoredLines: 1 });
  });

  test.each([
    "[ok] Check (-1 ms)",
    "[ok] Check (NaN ms)",
    "[ok] Check (Infinity ms)",
    "[ok] Check (1e5 ms)",
    "[ok] Check (86400001 ms)",
    "[ok] Check (2 s)",
    "[passed] Check (2 ms)",
    "[ok] Other (2 ms)",
  ])("leaves malformed or unmatched completion unknown: %s", (line) => {
    const { collector, advance } = fixture();
    collector.onStdoutLine("[1/1] [step/id] Check");
    advance(100);
    collector.onStdoutLine(line);
    expect(collector.finish().stages[0]).toMatchObject({
      boundary: "incomplete",
      durationMs: null,
      observedElapsedMs: 100,
      reportedDurationMs: null,
    });
  });

  test("fails closed on duplicate starts while ignoring unmatched completions and inconsistent totals", () => {
    const { collector, events, advance } = fixture();
    collector.onStdoutLine("[ok] Check (2 ms)");
    collector.onStdoutLine("[1/2] [step/id] Check");
    advance(30);
    collector.onStderrLine("[1/2] [step/id] Check");
    collector.onStdoutLine("[2/3] [step/id] Other");
    advance(10);
    collector.onStdoutLine("[ok] Check (2 ms)");
    collector.onStderrLine("[ok] Check (2 ms)");
    collector.onStdoutLine("[1/2] [step/other] Replacement");
    expect(collector.finish()).toMatchObject({
      ignoredLines: 6,
      stages: [{ boundary: "incomplete", durationMs: null, observedElapsedMs: 40 }],
    });
    expect(events).toHaveLength(2);
  });

  test("a duplicate completion does not change an unambiguous finished stage", () => {
    const { collector, events, advance } = fixture();
    collector.onStdoutLine("[1/1] [step/id] Check");
    advance(40);
    collector.onStdoutLine("[ok] Check (2 ms)");
    advance(60);
    collector.onStderrLine("[ok] Check (2 ms)");
    expect(collector.finish()).toMatchObject({
      ignoredLines: 1,
      stages: [{ boundary: "complete", durationMs: 40 }],
    });
    expect(events).toHaveLength(2);
  });

  test.each([
    { name: "nested different total", inner: "[nested 1/1] [private-inner] Check" },
    { name: "conflicting duplicate ordinal", inner: "[nested 1/2] [private-inner] Check" },
    { name: "same-label sibling", inner: "[build checks 2/2] [private-sibling] Check" },
  ])("does not attribute an inner completion to the outer stage: $name", ({ inner }) => {
    let clock = 0;
    const events: ValidationSubstepTiming[] = [];
    const collector = createValidationSubstepCollector({
      nowMs: () => clock,
      onEvent: (event) => events.push({ ...event }),
    });
    collector.onStdoutLine("[build checks 1/2] [private-outer] Check");
    clock = 100;
    collector.onStdoutLine(inner);
    clock = 101;
    collector.onStdoutLine("[ok] Check (1 ms)");
    expect(events.some((event) => event.boundary === "complete")).toBe(false);
    clock = 1_100;
    collector.onStdoutLine("[ok] Check (1100 ms)");
    const report = collector.finish();
    expect(report.stages[0]).toMatchObject({
      ordinal: 1,
      boundary: "incomplete",
      durationMs: null,
      observedElapsedMs: 1_100,
      reportedDurationMs: null,
    });
    expect(report.stages.every((stage) => stage.boundary === "incomplete")).toBe(true);
    expect(events.some((event) => event.boundary === "complete")).toBe(false);
    expect(JSON.stringify({ report, events })).not.toContain("private-");
    expect(JSON.stringify({ report, events })).not.toContain("Check");
    expect(report.truncated).toBe(false);
  });

  test("unrelated ignored headers do not taint current stages, but their later reused labels stay ambiguous", () => {
    const { collector, advance } = fixture();
    collector.onStdoutLine("[build checks 1/3] [outer] Outer check");
    collector.onStdoutLine("[nested 1/1] [inner] Later check");
    collector.onStderrLine("[ok] Later check (1 ms)");
    collector.onStdoutLine("ordinary harmless output");
    advance(25);
    collector.onStdoutLine("[ok] Outer check (20 ms)");
    collector.onStdoutLine("[build checks 2/3] [later] Later check");
    collector.onStdoutLine("[ok] Later check (1 ms)");
    collector.onStdoutLine("[build checks 3/3] [other] Independent check");
    advance(10);
    collector.onStdoutLine("[ok] Independent check (8 ms)");
    expect(collector.finish().stages).toMatchObject([
      { boundary: "complete", durationMs: 25 },
      { boundary: "incomplete", durationMs: null },
      { boundary: "complete", durationMs: 10 },
    ]);
  });

  test("a nested aggregate with the same total cannot consume an unused outer ordinal", () => {
    let clock = 0;
    const collector = createValidationSubstepCollector({ nowMs: () => clock });
    collector.onStdoutLine("[private outer 1/2] [first] First outer check");
    clock = 100;
    collector.onStdoutLine("[private nested 2/2] [inner] Inner check");
    clock = 101;
    collector.onStdoutLine("[ok] Inner check (1 ms)");
    clock = 1_100;
    collector.onStdoutLine("[ok] First outer check (1100 ms)");
    collector.onStdoutLine("[private outer 2/2] [second] Second outer check");
    clock = 1_200;
    collector.onStdoutLine("[ok] Second outer check (100 ms)");
    const report = collector.finish();
    expect(report.stages).toMatchObject([
      { ordinal: 1, boundary: "complete", durationMs: 1_100 },
      { ordinal: 2, boundary: "complete", durationMs: 100 },
    ]);
    expect(report.stages).toHaveLength(2);
    expect(report.ignoredLines).toBe(2);
    expect(JSON.stringify(report)).not.toContain("private");
  });

  test("a nested prefix cannot consume ordinals in a conventional unprefixed aggregate", () => {
    const { collector, advance } = fixture();
    collector.onStdoutLine("[1/2] [first] First check");
    collector.onStdoutLine("[nested 2/2] [inner] Inner check");
    collector.onStdoutLine("[ok] Inner check (1 ms)");
    advance(30);
    collector.onStdoutLine("[ok] First check (20 ms)");
    collector.onStdoutLine("[2/2] [second] Second check");
    advance(10);
    collector.onStdoutLine("[ok] Second check (8 ms)");
    expect(collector.finish().stages).toMatchObject([
      { ordinal: 1, boundary: "complete", durationMs: 30 },
      { ordinal: 2, boundary: "complete", durationMs: 10 },
    ]);
  });

  test("bounded ignored-header overflow leaves already known labels usable but later unknown labels incomplete", () => {
    const { collector, advance } = fixture();
    collector.onStdoutLine("[build checks 1/2] [outer] Known check");
    for (let index = 0; index < VALIDATION_SUBSTEP_LIMITS.stages + 10; index++) {
      collector.onStdoutLine(`[nested 1/1] [inner] Ignored check ${index}`);
      collector.onStderrLine(`[0/1] [malformed] Malformed check ${index}`);
    }
    advance(15);
    collector.onStdoutLine("[ok] Known check (10 ms)");
    collector.onStdoutLine("[build checks 2/2] [later] New check");
    collector.onStdoutLine("[ok] New check (1 ms)");
    const report = collector.finish();
    expect(report.truncated).toBe(true);
    expect(report.stages).toMatchObject([
      { boundary: "complete", durationMs: 15 },
      { boundary: "incomplete", durationMs: null, incompleteReason: "observation_limit" },
    ]);
    expect(JSON.stringify(report)).not.toContain("Ignored check");
    expect(JSON.stringify(report)).not.toContain("Malformed check");
  });

  test("does not guess which parallel stage completed when labels are ambiguous", () => {
    const { collector } = fixture();
    collector.onStdoutLine("[1/2] [one/id] Shared label");
    collector.onStdoutLine("[2/2] [two/id] Shared label");
    collector.onStdoutLine("[ok] Shared label (10 ms)");
    const report = collector.finish();
    expect(report.ignoredLines).toBe(1);
    expect(report.stages.map((stage) => stage.boundary)).toEqual(["incomplete", "incomplete"]);
  });

  test("a delayed duplicate completion cannot complete a later stage that reused the same label", () => {
    const { collector } = fixture();
    collector.onStdoutLine("[1/2] [one/id] Shared label");
    collector.onStdoutLine("[ok] Shared label (10 ms)");
    collector.onStdoutLine("[2/2] [two/id] Shared label");
    collector.onStderrLine("[ok] Shared label (10 ms)");
    expect(collector.finish().stages.map((stage) => stage.boundary)).toEqual([
      "complete",
      "incomplete",
    ]);
  });

  test.each(["command_finished", "timed_out", "aborted", "output_incomplete"] as const)(
    "missing completion at %s stays unknown, not zero or success",
    (reason) => {
      const { collector, events, advance } = fixture();
      collector.onStdoutLine("[1/1] [step/id] Still running");
      advance(321);
      const report = collector.finish(reason);
      expect(report.stages[0]).toMatchObject({
        boundary: "incomplete",
        incompleteReason: reason,
        durationMs: null,
        observedElapsedMs: 321,
        reportedDurationMs: null,
      });
      collector.onStdoutLine("[ok] Still running (300 ms)");
      expect(collector.finish()).toEqual(report);
      expect(events.map((event) => event.boundary)).toEqual(["start", "incomplete"]);
    },
  );

  test("caps stages, event count, retained labels, and oversize lines with visible truncation", () => {
    const { collector, events } = fixture();
    collector.onStdoutLine(`[1/100] [step/id] ${"x".repeat(VALIDATION_SUBSTEP_LIMITS.lineChars)}`);
    for (let ordinal = 1; ordinal <= VALIDATION_SUBSTEP_LIMITS.stages + 1; ordinal++) {
      collector.onStdoutLine(`[${ordinal}/100] [step/id] Check ${ordinal}`);
    }
    const report = collector.finish();
    expect(report.truncated).toBe(true);
    expect(report.stages).toHaveLength(VALIDATION_SUBSTEP_LIMITS.stages);
    expect(events).toHaveLength(VALIDATION_SUBSTEP_LIMITS.stages * 2);
    expect(report.ignoredLines).toBe(2);
    expect(report.stages.every((stage) => stage.incompleteReason === "observation_limit")).toBe(
      true,
    );
  });

  test.each(["label", "stage token"])(
    "reports rejected oversized %s as a visible observation limit",
    (part) => {
      const { collector } = fixture();
      const label =
        part === "label" ? "x".repeat(VALIDATION_SUBSTEP_LIMITS.labelChars + 1) : "Check";
      const token =
        part === "stage token"
          ? "x".repeat(VALIDATION_SUBSTEP_LIMITS.stageTokenChars + 1)
          : "step/id";
      collector.onStdoutLine(`[1/1] [${token}] ${label}`);
      expect(collector.finish()).toEqual({ stages: [], truncated: true, ignoredLines: 1 });
    },
  );

  test("bounds combined stdout/stderr input processing and never parses a late fake completion", () => {
    const { collector } = fixture();
    collector.onStdoutLine("[1/1] [step/id] Check");
    for (let index = 1; index < VALIDATION_SUBSTEP_LIMITS.lines; index++)
      collector.onStderrLine("unrelated output");
    collector.onStdoutLine("[ok] Check (10 ms)");
    expect(collector.finish()).toMatchObject({
      truncated: true,
      stages: [{ boundary: "incomplete", durationMs: null, incompleteReason: "observation_limit" }],
    });
  });

  test("retains later aggregate stages after thousands of ordinary test/warning lines", () => {
    const { collector } = fixture();
    collector.onStdoutLine("[build checks 1/2] [generic/tests] Repository tests");
    for (let index = 0; index < 5_000; index++)
      collector.onStdoutLine("[pass] Ordinary test or warning output");
    collector.onStdoutLine("[ok] Repository tests (100 ms)");
    collector.onStdoutLine("[build checks 2/2] [generic/types] Static checks");
    collector.onStdoutLine("[ok] Static checks (20 ms)");
    const report = collector.finish();
    expect(report.truncated).toBe(false);
    expect(report.stages.map((stage) => stage.boundary)).toEqual(["complete", "complete"]);
    expect(report.ignoredLines).toBe(5_000);
  });

  test("isolates throwing, rejecting, and mutating observers without changing collected observations", async () => {
    let calls = 0;
    const collector = createValidationSubstepCollector({
      nowMs: () => 100,
      onEvent: (event) => {
        calls++;
        if (calls === 1) throw new Error("observer failure");
        expect(Object.isFrozen(event)).toBe(true);
        return Promise.reject(new Error("async observer failure"));
      },
    });
    expect(() => collector.onStdoutLine("[1/1] [step/id] Check")).not.toThrow();
    expect(() => collector.onStdoutLine("[ok] Check (1 ms)")).not.toThrow();
    const report = collector.finish();
    report.stages[0]!.stageId = "caller-mutated-copy";
    expect(collector.finish().stages[0]?.stageId).toBe("substep-1");
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("unknown/backward clocks remain null and child-reported time never fabricates duration", () => {
    let time = 100;
    const collector = createValidationSubstepCollector({ nowMs: () => time });
    collector.onStdoutLine("[1/1] [step/id] Check");
    time = 99;
    collector.onStdoutLine("[ok] Check (5000 ms)");
    expect(collector.finish().stages[0]).toMatchObject({
      durationMs: null,
      observedElapsedMs: null,
      reportedDurationMs: 5000,
    });
    const brokenClock = createValidationSubstepCollector({
      nowMs: () => {
        throw new Error("unavailable");
      },
    });
    brokenClock.onStdoutLine("[1/1] [step/id] Check");
    expect(brokenClock.finish().stages[0]).toMatchObject({
      boundary: "incomplete",
      durationMs: null,
      observedElapsedMs: null,
    });
  });

  test("retry attempts have independent clocks, labels, ordinals, and terminal observations", () => {
    const first = fixture();
    first.collector.onStdoutLine("[1/1] [step/id] Check");
    first.advance(300);
    expect(first.collector.finish("timed_out").stages[0]?.durationMs).toBeNull();
    const retry = fixture();
    retry.collector.onStdoutLine("[ok] Check (1 ms)");
    retry.collector.onStdoutLine("[1/1] [step/id] Check");
    retry.advance(20);
    retry.collector.onStdoutLine("[ok] Check (1 ms)");
    expect(retry.collector.finish().stages[0]?.durationMs).toBe(20);
    expect(first.collector.finish().stages[0]?.boundary).toBe("incomplete");
  });
});
