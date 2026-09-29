/**
 * Best-effort observations of a child validation script's aggregate markers.
 * These observations are not command outcomes and must not renew health leases,
 * decide validation success, or authorize publication. Construct one collector
 * per command attempt; retry attempts must never share correlation state.
 */
import {
  VALIDATION_SUBSTEP_LIMITS,
  type ValidationSubstepFinishReason,
  type ValidationSubstepReport,
  type ValidationSubstepTiming,
} from "../../../packages/shared/src/validation_substeps.js";
export {
  VALIDATION_SUBSTEP_LIMITS,
  type ValidationSubstepFinishReason,
  type ValidationSubstepReport,
  type ValidationSubstepTiming,
} from "../../../packages/shared/src/validation_substeps.js";

export interface ValidationSubstepCollector {
  onStdoutLine(line: string): void;
  onStderrLine(line: string): void;
  /** Idempotent. Later child output is ignored, including delayed completion markers. */
  finish(reason?: ValidationSubstepFinishReason): ValidationSubstepReport;
}

type ParsedLine =
  | { kind: "start"; ordinal: number; total: number; label: string; aggregatePrefix: string }
  | {
      kind: "complete";
      label: string;
      marker: "ok" | "fail" | "error";
      reportedDurationMs: number;
    };

type Stage = {
  // Raw labels are retained only in bounded, attempt-local correlation state.
  // They are erased on finalization and never emitted or returned.
  label: string;
  startedAtMs: number | null;
  timing: ValidationSubstepTiming;
};

function parseLine(raw: string): ParsedLine | "limit" | null {
  // Strip SGR colors only. Cursor movement, OSC payloads, embedded newlines,
  // NULs, and other controls are not an alternate telemetry protocol.
  const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r$/, "");
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(line)) return null;
  const text = line.trim();
  const start =
    /^\[(?:([^\[\]]{1,96})[ \t]+)?([1-9]\d{0,4})\/([1-9]\d{0,4})\][ \t]+\[([^\[\]]+)\][ \t]+(.+)$/.exec(
      text,
    );
  if (start) {
    const aggregatePrefix = (start[1] ?? "").trim().replace(/[ \t]+/g, " ");
    const ordinal = Number(start[2]);
    const total = Number(start[3]);
    const label = start[5]!.trim();
    if (ordinal > total || total > VALIDATION_SUBSTEP_LIMITS.ordinal || !start[4]!.trim() || !label)
      return null;
    if (
      start[4]!.length > VALIDATION_SUBSTEP_LIMITS.stageTokenChars ||
      label.length > VALIDATION_SUBSTEP_LIMITS.labelChars
    )
      return "limit";
    return { kind: "start", ordinal, total, label, aggregatePrefix };
  }
  const complete = /^\[(ok|fail|error)\][ \t]+/.exec(text);
  if (!complete) return null;
  // Split the terminal duration explicitly instead of backtracking across an
  // arbitrary label/whitespace run from untrusted process output.
  const durationOffset = text.lastIndexOf("(");
  if (durationOffset <= complete[0].length || !/[ \t]/.test(text[durationOffset - 1]!)) return null;
  const duration = /^\((\d+(?:\.\d+)?) ms\)$/.exec(text.slice(durationOffset));
  if (!duration) return null;
  const label = text.slice(complete[0].length, durationOffset).trim();
  const reportedDurationMs = Number(duration[1]);
  if (
    !label ||
    !Number.isFinite(reportedDurationMs) ||
    reportedDurationMs > VALIDATION_SUBSTEP_LIMITS.durationMs
  )
    return null;
  if (label.length > VALIDATION_SUBSTEP_LIMITS.labelChars) return "limit";
  return {
    kind: "complete",
    label,
    marker: complete[1] as "ok" | "fail" | "error",
    reportedDurationMs,
  };
}

export function createValidationSubstepCollector(
  options: {
    /** Observation-only sink, separate from authoritative command/health callbacks. */
    onEvent?: (event: Readonly<ValidationSubstepTiming>) => unknown;
    /** Monotonic clock seam for deterministic tests. */
    nowMs?: () => number;
  } = {},
): ValidationSubstepCollector {
  const stages = new Map<number, Stage>();
  const labelUses = new Map<string, number>();
  // Rejected headers still make their labels ambiguous. Retain at most one
  // additional stage budget of labels; never retain arbitrary ignored output.
  const ignoredStartLabels = new Set<string>();
  let ignoredStartLabelsOverflowed = false;
  let total: number | null = null;
  // Private, bounded identity of the first accepted aggregate. Another prefix
  // must not consume its ordinals, even when nested totals happen to match.
  let aggregatePrefix: string | null = null;
  let observedLines = 0;
  let ignoredLines = 0;
  let truncated = false;
  let finished = false;

  const now = (): number | null => {
    try {
      const value = (options.nowMs ?? (() => performance.now()))();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const elapsed = (startedAt: number | null, endedAt: number | null): number | null => {
    if (startedAt == null || endedAt == null) return null;
    const value = endedAt - startedAt;
    return value >= 0 && value <= VALIDATION_SUBSTEP_LIMITS.durationMs ? value : null;
  };
  const ignore = () => {
    ignoredLines = Math.min(VALIDATION_SUBSTEP_LIMITS.ignoredLines, ignoredLines + 1);
  };
  const observeIgnoredStart = (label: string) => {
    if (labelUses.has(label)) {
      labelUses.set(label, 2);
    } else if (!ignoredStartLabels.has(label)) {
      if (ignoredStartLabels.size < VALIDATION_SUBSTEP_LIMITS.stages) {
        ignoredStartLabels.add(label);
      } else {
        ignoredStartLabelsOverflowed = true;
        truncated = true;
      }
    }
  };
  const emit = (timing: ValidationSubstepTiming) => {
    try {
      // Give observers an isolated immutable copy. Async observer rejection is
      // swallowed too: telemetry cannot break process draining or validation.
      const returned = options.onEvent?.(Object.freeze({ ...timing }));
      if (returned != null && typeof (returned as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(returned).catch(() => {});
      }
    } catch {
      // Deliberately non-authoritative observability.
    }
  };
  const onLine = (raw: string) => {
    if (finished) return;
    if (observedLines >= VALIDATION_SUBSTEP_LIMITS.lines) {
      truncated = true;
      ignore();
      return;
    }
    observedLines++;
    if (typeof raw !== "string" || raw.length > VALIDATION_SUBSTEP_LIMITS.lineChars) {
      truncated = true;
      ignore();
      return;
    }
    const parsed = parseLine(raw);
    if (parsed === "limit") {
      truncated = true;
      ignore();
      return;
    }
    if (!parsed) {
      ignore();
      return;
    }
    if (parsed.kind === "start") {
      if (
        stages.has(parsed.ordinal) ||
        (total != null && total !== parsed.total) ||
        (aggregatePrefix != null && aggregatePrefix !== parsed.aggregatePrefix)
      ) {
        observeIgnoredStart(parsed.label);
        ignore();
        return;
      }
      if (stages.size >= VALIDATION_SUBSTEP_LIMITS.stages) {
        observeIgnoredStart(parsed.label);
        truncated = true;
        ignore();
        return;
      }
      total = parsed.total;
      aggregatePrefix = parsed.aggregatePrefix;
      const startedAtMs = now();
      const timing: ValidationSubstepTiming = {
        source: "aggregate_lines",
        observationOnly: true,
        stageId: `substep-${parsed.ordinal}`,
        ordinal: parsed.ordinal,
        total: parsed.total,
        boundary: "start",
        durationMs: null,
        observedElapsedMs: startedAtMs == null ? null : 0,
        reportedDurationMs: null,
      };
      stages.set(parsed.ordinal, { label: parsed.label, startedAtMs, timing });
      labelUses.set(
        parsed.label,
        labelUses.has(parsed.label) ||
          ignoredStartLabels.has(parsed.label) ||
          ignoredStartLabelsOverflowed
          ? 2
          : 1,
      );
      emit(timing);
      return;
    }
    const matching = [...stages.values()].filter(
      (stage) => stage.timing.boundary === "start" && stage.label === parsed.label,
    );
    // Accepted, rejected, nested, and duplicate headers all participate in label
    // ambiguity. A completion has no stage identity, so never guess which start
    // it belongs to, including after bounded ignored-header history overflows.
    if (matching.length !== 1 || labelUses.get(parsed.label) !== 1) {
      ignore();
      return;
    }
    const stage = matching[0]!;
    const observedElapsedMs = elapsed(stage.startedAtMs, now());
    stage.timing = {
      ...stage.timing,
      boundary: "complete",
      durationMs: observedElapsedMs,
      observedElapsedMs,
      reportedDurationMs: parsed.reportedDurationMs,
      completionMarker: parsed.marker,
    };
    stage.label = "";
    emit(stage.timing);
  };

  return {
    onStdoutLine: onLine,
    onStderrLine: onLine,
    finish(reason = "command_finished") {
      if (!finished) {
        finished = true;
        const endedAtMs = now();
        const safeReason = [
          "command_finished",
          "timed_out",
          "aborted",
          "output_incomplete",
        ].includes(reason)
          ? reason
          : "command_finished";
        const terminalEvents: ValidationSubstepTiming[] = [];
        for (const stage of stages.values()) {
          if (stage.timing.boundary !== "start") continue;
          stage.timing = {
            ...stage.timing,
            boundary: "incomplete",
            durationMs: null,
            observedElapsedMs: elapsed(stage.startedAtMs, endedAtMs),
            incompleteReason: truncated ? "observation_limit" : safeReason,
          };
          stage.label = "";
          terminalEvents.push(stage.timing);
        }
        labelUses.clear();
        ignoredStartLabels.clear();
        aggregatePrefix = null;
        for (const event of terminalEvents) emit(event);
      }
      return {
        stages: [...stages.values()].map((stage) => ({ ...stage.timing })),
        truncated,
        ignoredLines,
      };
    },
  };
}
