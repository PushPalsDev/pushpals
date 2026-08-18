export type ValidationRepairPublicationLease = {
  version: 1;
  scope: "candidate_specific";
  incidentId: string;
  baselineSha: string;
  candidateSha: string;
  candidateRef: string;
  expectedCompletionSha: string;
};

const LEASE_KEYS = {
  version: "pushpals-validationRepairLeaseVersion",
  scope: "pushpals-validationRepairScope",
  incidentId: "pushpals-validationRepairIncidentId",
  baselineSha: "pushpals-validationRepairBaselineSha",
  candidateSha: "pushpals-validationRepairCandidateSha",
  candidateRef: "pushpals-validationRepairCandidateRef",
  expectedCompletionSha: "pushpals-validationRepairCompletionSha",
} as const;

const LEASE_MARKER_RE = /<!--\s*pushpals-validationRepair/i;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const INCIDENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const VALIDATION_CANDIDATE_REF_RE =
  /^refs\/pushpals\/validation\/[0-9a-f]{32}\/[1-9][0-9]*\/candidate$/;

function normalizeSha(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE.test(normalized) ? normalized : "";
}

function normalizeIncidentId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return INCIDENT_ID_RE.test(normalized) ? normalized : "";
}

function normalizeCandidateRef(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALIDATION_CANDIDATE_REF_RE.test(normalized) ? normalized : "";
}

function metadataValues(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`<!--\\s*${key}\\s*:\\s*([^>]*?)\\s*-->`, "gi"))].map(
    (match) => String(match[1] ?? "").trim(),
  );
}

function singleMetadataValue(body: string, key: string): string {
  const values = metadataValues(body, key);
  if (values.length !== 1) {
    throw new Error(
      `Malformed validation-repair publication lease: expected exactly one ${key} marker, found ${values.length}.`,
    );
  }
  return values[0] ?? "";
}

export function validateValidationRepairPublicationLease(input: {
  version: unknown;
  scope: unknown;
  incidentId: unknown;
  baselineSha: unknown;
  candidateSha: unknown;
  candidateRef: unknown;
  expectedCompletionSha: unknown;
}): ValidationRepairPublicationLease {
  if (String(input.version ?? "").trim() !== "1") {
    throw new Error("Malformed validation-repair publication lease: unsupported lease version.");
  }
  if (
    String(input.scope ?? "")
      .trim()
      .toLowerCase() !== "candidate_specific"
  ) {
    throw new Error(
      "Malformed validation-repair publication lease: scope must be candidate_specific.",
    );
  }
  const incidentId = normalizeIncidentId(input.incidentId);
  const baselineSha = normalizeSha(input.baselineSha);
  const candidateSha = normalizeSha(input.candidateSha);
  const candidateRef = normalizeCandidateRef(input.candidateRef);
  const expectedCompletionSha = normalizeSha(input.expectedCompletionSha);
  if (!incidentId || !baselineSha || !candidateSha || !candidateRef || !expectedCompletionSha) {
    throw new Error(
      "Malformed validation-repair publication lease: incident ID, retained candidate ref, and exact baseline/candidate/completion SHAs are required.",
    );
  }
  if (baselineSha === candidateSha || candidateSha === expectedCompletionSha) {
    throw new Error(
      "Malformed validation-repair publication lease: baseline, candidate, and completion must identify distinct revisions.",
    );
  }
  return {
    version: 1,
    scope: "candidate_specific",
    incidentId,
    baselineSha,
    candidateSha,
    candidateRef,
    expectedCompletionSha,
  };
}

export function validationRepairPublicationLeaseFromJobParams(
  params: Record<string, unknown> | null | undefined,
  completionSha: string,
): ValidationRepairPublicationLease | null {
  const autonomy =
    params?.autonomy && typeof params.autonomy === "object" && !Array.isArray(params.autonomy)
      ? (params.autonomy as Record<string, unknown>)
      : null;
  const incident =
    autonomy?.validationIncident &&
    typeof autonomy.validationIncident === "object" &&
    !Array.isArray(autonomy.validationIncident)
      ? (autonomy.validationIncident as Record<string, unknown>)
      : null;
  if (!incident) return null;
  const scope = String(incident.validationScope ?? incident.validation_scope ?? "")
    .trim()
    .toLowerCase();
  if (scope !== "candidate_specific") return null;
  return validateValidationRepairPublicationLease({
    version: 1,
    scope,
    incidentId: incident.incidentId ?? incident.incident_id,
    baselineSha: incident.baselineSha ?? incident.baseline_sha,
    candidateSha: incident.candidateSha ?? incident.candidate_sha,
    candidateRef: incident.candidateRef ?? incident.candidate_ref,
    expectedCompletionSha: completionSha,
  });
}

export function appendValidationRepairPublicationLease(
  body: string,
  lease: ValidationRepairPublicationLease | null,
): string {
  if (!lease) return body;
  const validated = validateValidationRepairPublicationLease(lease);
  return [
    body,
    "",
    "<!-- DO NOT EDIT: PushPals validation-repair publication lease below -->",
    `<!-- ${LEASE_KEYS.version}: ${validated.version} -->`,
    `<!-- ${LEASE_KEYS.scope}: ${validated.scope} -->`,
    `<!-- ${LEASE_KEYS.incidentId}: ${validated.incidentId} -->`,
    `<!-- ${LEASE_KEYS.baselineSha}: ${validated.baselineSha} -->`,
    `<!-- ${LEASE_KEYS.candidateSha}: ${validated.candidateSha} -->`,
    `<!-- ${LEASE_KEYS.candidateRef}: ${validated.candidateRef} -->`,
    `<!-- ${LEASE_KEYS.expectedCompletionSha}: ${validated.expectedCompletionSha} -->`,
  ].join("\n");
}

export function parseValidationRepairPublicationLease(
  prBody: string | null | undefined,
): ValidationRepairPublicationLease | null {
  const body = String(prBody ?? "");
  if (!LEASE_MARKER_RE.test(body)) return null;
  return validateValidationRepairPublicationLease({
    version: singleMetadataValue(body, LEASE_KEYS.version),
    scope: singleMetadataValue(body, LEASE_KEYS.scope),
    incidentId: singleMetadataValue(body, LEASE_KEYS.incidentId),
    baselineSha: singleMetadataValue(body, LEASE_KEYS.baselineSha),
    candidateSha: singleMetadataValue(body, LEASE_KEYS.candidateSha),
    candidateRef: singleMetadataValue(body, LEASE_KEYS.candidateRef),
    expectedCompletionSha: singleMetadataValue(body, LEASE_KEYS.expectedCompletionSha),
  });
}
