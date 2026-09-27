import {
  normalizeVisionSectionRefs,
  validateScopeInvariants,
  type AutonomyObjectiveType,
} from "shared";

type PolicyRule = {
  maxRisk: "low" | "medium" | "high";
  maxBreadth: "narrow" | "medium" | "broad";
  autonomousAllowed: boolean;
  requireValidation: boolean;
};

// Keep discovery's cache admission and dispatch's policy on the same rules.
export const AUTONOMY_CANDIDATE_POLICY: Record<AutonomyObjectiveType, PolicyRule> = {
  flaky_test: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
  },
  lint_fix: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true,
  },
  type_fix: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  small_refactor: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_small: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_medium: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true,
  },
  feature_large: {
    maxRisk: "high",
    maxBreadth: "broad",
    autonomousAllowed: false,
    requireValidation: true,
  },
  docs: { maxRisk: "low", maxBreadth: "medium", autonomousAllowed: true, requireValidation: false },
  dep_bump: {
    maxRisk: "medium",
    maxBreadth: "narrow",
    autonomousAllowed: false,
    requireValidation: true,
  },
};

export const AUTONOMY_RISK_ORDER = { low: 0, medium: 1, high: 2 };

/** Input has already passed the wire contract. Only snapshot-stable rejection belongs here. */
export function staticAutonomyCandidateRejection(
  candidate: Record<string, unknown>,
  context: {
    trackedPaths: readonly string[];
    allowedObjectiveTypes: readonly string[];
    disabledObjectiveTypes: readonly string[];
    disabledComponents: readonly string[];
    allowReadAnywhere: boolean;
    minimumConfidence: number;
    visionSectionNumbers: ReadonlySet<string>;
  },
): string | null {
  const type = candidate.objective_type as AutonomyObjectiveType;
  if (Number(candidate.confidence) < context.minimumConfidence) return "confidence_below_threshold";
  const policy = AUTONOMY_CANDIDATE_POLICY[type];
  if (
    !policy?.autonomousAllowed ||
    context.disabledObjectiveTypes.includes(type) ||
    (context.allowedObjectiveTypes.length > 0 && !context.allowedObjectiveTypes.includes(type))
  ) {
    return "objective_type_not_allowed";
  }
  const risk = candidate.risk_level as keyof typeof AUTONOMY_RISK_ORDER;
  if (!(risk in AUTONOMY_RISK_ORDER)) return "invalid_risk_level";
  if (AUTONOMY_RISK_ORDER[risk] > AUTONOMY_RISK_ORDER[policy.maxRisk]) return "risk_exceeds_policy";
  const scope = candidate.scope as { read_anywhere: boolean; write_globs: string[] };
  const checked = validateScopeInvariants(
    candidate.component_area as string,
    candidate.target_paths as string[],
    scope.write_globs,
    { requireWriteGlobs: true, hintsOnly: true },
  );
  if (!checked.ok) return "scope_validation_failed";
  if (
    context.disabledComponents.includes(checked.componentArea ?? String(candidate.component_area))
  )
    return "component_disabled_by_policy";
  if (scope.read_anywhere && !context.allowReadAnywhere) return "read_anywhere_not_allowed";
  if (
    context.visionSectionNumbers.size > 0 &&
    normalizeVisionSectionRefs(
      candidate.vision_section_refs as string[],
      new Set(context.visionSectionNumbers),
    ).length === 0
  )
    return "missing_vision_section_refs";
  const tracked = new Set(context.trackedPaths);
  if (
    checked.normalizedTargetPaths.some(
      (path) =>
        !tracked.has(path) && !context.trackedPaths.some((file) => file.startsWith(`${path}/`)),
    )
  ) {
    return "target_paths_missing_in_repo";
  }
  // Validation may be inferred from repository manifests later. Cooldowns,
  // open work, ranking scores and consumed queue capacity are current eligibility,
  // not structural invalidity: never bake them into this cached decision.
  return null;
}
