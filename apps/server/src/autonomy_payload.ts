function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return objectRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function compactText(value: unknown, maxChars: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maxChars);
}

function stringValues(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const normalized = entry.trim();
      if (normalized) out.add(normalized);
    }
  }
  return [...out];
}

export type AutonomyPayloadDetails = {
  objectiveId: string | null;
  snapshotId: string | null;
  patternKey: string | null;
  targetPaths: string[];
  writeGlobs: string[];
  reservationRequired: boolean;
  validationIncidentId: string | null;
  isValidationIncidentRepair: boolean;
  workClass: string | null;
  isRecoveryWork: boolean;
};

export function extractAutonomyPayloadDetails(
  value: Record<string, unknown>,
): AutonomyPayloadDetails {
  const params = objectRecord(value.params) ?? parseJsonRecord(value.params);
  const metadata =
    objectRecord(value.metadata) ?? objectRecord(value.meta) ?? parseJsonRecord(value.metadataJson);
  const metadataAutonomy = objectRecord(metadata.autonomy);
  const paramsAutonomy = objectRecord(params.autonomy);
  const planning = objectRecord(params.planning);
  const scope = objectRecord(planning?.scope);
  const validationIncident =
    objectRecord(metadataAutonomy?.validationIncident ?? metadataAutonomy?.validation_incident) ??
    objectRecord(paramsAutonomy?.validationIncident ?? paramsAutonomy?.validation_incident);
  const validationIncidentId =
    compactText(validationIncident?.incidentId ?? validationIncident?.incident_id, 256) || null;
  const objectiveId =
    compactText(
      metadataAutonomy?.objectiveId ??
        metadataAutonomy?.objective_id ??
        paramsAutonomy?.objectiveId ??
        paramsAutonomy?.objective_id,
      128,
    ) || null;
  const snapshotId =
    compactText(
      metadataAutonomy?.snapshotId ??
        metadataAutonomy?.snapshot_id ??
        paramsAutonomy?.snapshotId ??
        paramsAutonomy?.snapshot_id,
      128,
    ) || null;
  const reservationRequired = Boolean(
    metadataAutonomy?.reservationRequired === true ||
    metadataAutonomy?.reservation_required === true ||
    paramsAutonomy?.reservationRequired === true ||
    paramsAutonomy?.reservation_required === true,
  );
  const patternKey =
    compactText(
      metadataAutonomy?.patternKey ??
        metadataAutonomy?.pattern_key ??
        paramsAutonomy?.patternKey ??
        paramsAutonomy?.pattern_key,
      240,
    ) || null;
  const workClass =
    compactText(
      value.workClass ??
        value.work_class ??
        planning?.workClass ??
        planning?.work_class ??
        metadataAutonomy?.workClass ??
        metadataAutonomy?.work_class ??
        paramsAutonomy?.workClass ??
        paramsAutonomy?.work_class,
      32,
    )
      .toLowerCase()
      .replace(/[_\s]+/g, "-") || null;
  const lifecycleRecovery = Boolean(
    metadataAutonomy?.lifecycleRecovery === true ||
    metadataAutonomy?.lifecycle_recovery === true ||
    paramsAutonomy?.lifecycleRecovery === true ||
    paramsAutonomy?.lifecycle_recovery === true,
  );

  return {
    objectiveId,
    snapshotId,
    patternKey,
    reservationRequired,
    validationIncidentId,
    isValidationIncidentRepair: Boolean(validationIncidentId),
    workClass,
    isRecoveryWork:
      Boolean(validationIncidentId) ||
      lifecycleRecovery ||
      workClass === "recovery" ||
      workClass === "repair",
    targetPaths: stringValues(
      metadataAutonomy?.targetPaths,
      metadataAutonomy?.target_paths,
      metadataAutonomy?.targetPath,
      metadataAutonomy?.target_path,
      paramsAutonomy?.targetPaths,
      paramsAutonomy?.target_paths,
      paramsAutonomy?.targetPath,
      paramsAutonomy?.target_path,
      params.paths,
      params.path,
      params.targetPaths,
      params.target_paths,
      params.targetPath,
      params.target_path,
      planning?.targetPaths,
      planning?.target_paths,
      planning?.targetPath,
      planning?.target_path,
      value.targetPaths,
      value.target_paths,
      value.targetPath,
      value.target_path,
    ),
    writeGlobs: stringValues(
      metadataAutonomy?.writeGlobs,
      metadataAutonomy?.write_globs,
      metadataAutonomy?.writeGlob,
      metadataAutonomy?.write_glob,
      paramsAutonomy?.writeGlobs,
      paramsAutonomy?.write_globs,
      paramsAutonomy?.writeGlob,
      paramsAutonomy?.write_glob,
      scope?.writeGlobs,
      scope?.write_globs,
      scope?.writeGlob,
      scope?.write_glob,
    ),
  };
}
