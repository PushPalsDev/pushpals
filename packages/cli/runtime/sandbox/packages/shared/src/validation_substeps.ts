/** Fixed resource limits for non-authoritative validation-output observations. */
export const VALIDATION_SUBSTEP_LIMITS = Object.freeze({
  stages: 64,
  lines: 65_536,
  lineChars: 4_096,
  labelChars: 512,
  stageTokenChars: 128,
  ordinal: 10_000,
  durationMs: 24 * 60 * 60 * 1_000,
  ignoredLines: 1_000_000,
});

export type ValidationSubstepFinishReason =
  | "command_finished"
  | "timed_out"
  | "aborted"
  | "output_incomplete";

export interface ValidationSubstepTiming {
  source: "aggregate_lines";
  observationOnly: true;
  /** Generated ordinal ID, never the untrusted stage token or label. */
  stageId: string;
  ordinal: number;
  total: number;
  boundary: "start" | "complete" | "incomplete";
  /** Observed start-to-marker elapsed time; null without a complete observation. */
  durationMs: number | null;
  /** Partial observed elapsed time is separate from a completed duration. */
  observedElapsedMs: number | null;
  /** Untrusted child-reported timing, never substituted for observed duration. */
  reportedDurationMs: number | null;
  completionMarker?: "ok" | "fail" | "error";
  incompleteReason?: ValidationSubstepFinishReason | "observation_limit";
}

export interface ValidationSubstepReport {
  /** Final observations only, with at most one entry per accepted ordinal. */
  stages: ValidationSubstepTiming[];
  truncated: boolean;
  ignoredLines: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function duration(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= VALIDATION_SUBSTEP_LIMITS.durationMs)
  );
}

function normalizeStage(value: unknown): ValidationSubstepTiming | null {
  if (
    !record(value) ||
    value.source !== "aggregate_lines" ||
    value.observationOnly !== true ||
    !integer(value.ordinal, 1, VALIDATION_SUBSTEP_LIMITS.ordinal) ||
    !integer(value.total, value.ordinal, VALIDATION_SUBSTEP_LIMITS.ordinal) ||
    !duration(value.durationMs) ||
    !duration(value.observedElapsedMs) ||
    !duration(value.reportedDurationMs)
  )
    return null;
  const stage = {
    source: "aggregate_lines" as const,
    observationOnly: true as const,
    stageId: `substep-${value.ordinal}`,
    ordinal: value.ordinal,
    total: value.total,
    durationMs: value.durationMs,
    observedElapsedMs: value.observedElapsedMs,
    reportedDurationMs: value.reportedDurationMs,
  };
  if (value.boundary === "complete") {
    if (
      value.durationMs !== value.observedElapsedMs ||
      typeof value.completionMarker !== "string" ||
      !["ok", "fail", "error"].includes(value.completionMarker)
    )
      return null;
    return {
      ...stage,
      boundary: "complete",
      completionMarker: value.completionMarker as "ok" | "fail" | "error",
    };
  }
  if (value.boundary === "incomplete") {
    if (
      value.durationMs !== null ||
      value.reportedDurationMs !== null ||
      typeof value.incompleteReason !== "string" ||
      ![
        "command_finished",
        "timed_out",
        "aborted",
        "output_incomplete",
        "observation_limit",
      ].includes(value.incompleteReason)
    )
      return null;
    return {
      ...stage,
      boundary: "incomplete",
      incompleteReason: value.incompleteReason as NonNullable<
        ValidationSubstepTiming["incompleteReason"]
      >,
    };
  }
  // An in-progress start is not a final command report.
  return null;
}

/**
 * Defensive persistence/wire boundary for optional observations. No raw string
 * from child output, caller-provided stage ID, or extra authority field survives.
 * Invalid entries are omitted visibly; malformed reports are absent. This must
 * never be used as evidence that validation passed or a health lease progressed.
 */
export function normalizeValidationSubstepReport(
  value: unknown,
): ValidationSubstepReport | undefined {
  try {
    if (
      !record(value) ||
      !Array.isArray(value.stages) ||
      typeof value.truncated !== "boolean" ||
      !integer(value.ignoredLines, 0, VALIDATION_SUBSTEP_LIMITS.ignoredLines)
    )
      return undefined;
    const stages: ValidationSubstepTiming[] = [];
    const ordinals = new Set<number>();
    let truncated = value.truncated || value.stages.length > VALIDATION_SUBSTEP_LIMITS.stages;
    let total: number | null = null;
    for (const candidate of value.stages.slice(0, VALIDATION_SUBSTEP_LIMITS.stages)) {
      const stage = normalizeStage(candidate);
      if (!stage || ordinals.has(stage.ordinal) || (total != null && stage.total !== total)) {
        truncated = true;
        continue;
      }
      total = stage.total;
      ordinals.add(stage.ordinal);
      stages.push(stage);
    }
    return { stages, truncated, ignoredLines: value.ignoredLines };
  } catch {
    // Telemetry must not disrupt authoritative result handling, even for an
    // unusual local caller supplying throwing getters instead of decoded JSON.
    return undefined;
  }
}
