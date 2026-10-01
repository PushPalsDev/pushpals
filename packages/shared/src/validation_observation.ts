/** Execution state is explicit: a deferred/unstarted gate is still required,
 * but is not a failed process. Never infer non-execution from an exit code. */
export type ValidationExecutionState = "executed" | "deferred" | "not_started";

export function validationObservationState(metadata: unknown): ValidationExecutionState {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  if (record.executionState === "deferred" || record.executionState === "not_started")
    return record.executionState;
  if (record.executionState === "executed") return "executed";
  // Compatibility with older worker handoffs. Host results may have the same
  // capability, so source must also be checked.
  if (record.source === "worker" && record.capability === "trusted_host") return "deferred";
  return "executed";
}
