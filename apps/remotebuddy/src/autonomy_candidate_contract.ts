/** The RepositoryAgent and autonomy admission must agree on this wire contract. */
export const AUTONOMY_CANDIDATE_ENUMS = {
  objective_type: [
    "flaky_test",
    "lint_fix",
    "type_fix",
    "small_refactor",
    "feature_small",
    "feature_medium",
    "feature_large",
    "docs",
    "dep_bump",
  ],
  trigger_type: [
    "test_failure",
    "lint_failure",
    "typecheck_failure",
    "queue_health",
    "regret_signal",
  ],
  risk_level: ["low", "medium", "high"],
  estimated_effort: ["small", "medium", "large"],
} as const;

const stringFields = [
  "id",
  "title",
  "problem_statement",
  "component_area",
  "vision_alignment_reason",
];
const arrayFields = [
  "target_paths",
  "expected_validation",
  "why_now_signal_ids",
  "vision_section_refs",
  "feature_hypotheses",
];
const strings = { type: "array", items: { type: "string" } };

export const AUTONOMY_CANDIDATES_DATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          ...stringFields,
          ...arrayFields,
          ...Object.keys(AUTONOMY_CANDIDATE_ENUMS),
          "scope",
          "confidence",
        ],
        properties: {
          ...Object.fromEntries(
            stringFields.map((field) => [field, { type: "string", minLength: 1 }]),
          ),
          ...Object.fromEntries(arrayFields.map((field) => [field, strings])),
          ...Object.fromEntries(
            Object.entries(AUTONOMY_CANDIDATE_ENUMS).map(([field, values]) => [
              field,
              { type: "string", enum: values },
            ]),
          ),
          scope: {
            type: "object",
            additionalProperties: false,
            required: ["read_anywhere", "write_globs"],
            properties: { read_anywhere: { type: "boolean" }, write_globs: strings },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          requires_user_input: { type: "boolean" },
          question_if_blocked: { type: "string" },
          vision_objective_id: { type: "string" },
        },
      },
    },
  },
};

export function autonomyCandidateContractErrors(data: unknown): string[] {
  const object = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!object(data) || !Array.isArray(data.candidates)) return ["data.candidates must be an array"];
  if (data.candidates.length > 64) return ["data.candidates exceeds 64 entries"];
  const errors: string[] = [];
  if (Object.keys(data).some((key) => key !== "candidates"))
    errors.push("data contains unsupported fields");
  const candidateFields = new Set([
    ...stringFields,
    ...arrayFields,
    ...Object.keys(AUTONOMY_CANDIDATE_ENUMS),
    "scope",
    "confidence",
    "requires_user_input",
    "question_if_blocked",
    "vision_objective_id",
  ]);
  for (const [index, candidate] of data.candidates.entries()) {
    const prefix = `data.candidates[${index}]`;
    if (!object(candidate)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (Object.keys(candidate).some((key) => !candidateFields.has(key)))
      errors.push(`${prefix} contains unsupported fields`);
    for (const field of stringFields) {
      if (typeof candidate[field] !== "string" || !candidate[field].trim())
        errors.push(`${prefix}.${field} must be a nonempty string`);
    }
    for (const field of arrayFields) {
      if (
        !Array.isArray(candidate[field]) ||
        !candidate[field].every((entry) => typeof entry === "string")
      )
        errors.push(`${prefix}.${field} must be a string array`);
    }
    for (const [field, values] of Object.entries(AUTONOMY_CANDIDATE_ENUMS)) {
      if (!(values as readonly unknown[]).includes(candidate[field]))
        errors.push(`${prefix}.${field} must be one of ${values.join(", ")}`);
    }
    if (
      !object(candidate.scope) ||
      typeof candidate.scope.read_anywhere !== "boolean" ||
      !Array.isArray(candidate.scope.write_globs) ||
      !candidate.scope.write_globs.every((entry) => typeof entry === "string")
    )
      errors.push(`${prefix}.scope requires read_anywhere and write_globs`);
    if (
      object(candidate.scope) &&
      Object.keys(candidate.scope).some((key) => key !== "read_anywhere" && key !== "write_globs")
    )
      errors.push(`${prefix}.scope contains unsupported fields`);
    if (
      candidate.requires_user_input !== undefined &&
      typeof candidate.requires_user_input !== "boolean"
    )
      errors.push(`${prefix}.requires_user_input must be boolean`);
    for (const field of ["question_if_blocked", "vision_objective_id"]) {
      if (candidate[field] !== undefined && typeof candidate[field] !== "string")
        errors.push(`${prefix}.${field} must be a string`);
    }
    if (
      typeof candidate.confidence !== "number" ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    )
      errors.push(`${prefix}.confidence must be between 0 and 1`);
  }
  return errors.slice(0, 16);
}
