import { describe, expect, test } from "bun:test";
import { extractAutonomyPayloadDetails } from "../apps/server/src/autonomy_payload";

describe("server autonomy payload extraction", () => {
  test("collects scalar and array target aliases without duplicates", () => {
    const details = extractAutonomyPayloadDetails({
      targetPath: "apps/root.ts",
      metadata: {
        autonomy: {
          patternKey: "route-shell",
          targetPath: "apps/metadata.ts",
          targetPaths: ["apps/shared.ts"],
          writeGlob: "apps/**",
        },
      },
      params: {
        path: "apps/param-path.ts",
        target_path: "apps/param-target.ts",
        paths: ["apps/shared.ts"],
        autonomy: {
          target_path: "apps/autonomy.ts",
        },
        planning: {
          targetPath: "apps/planning.ts",
          scope: {
            write_glob: "tests/**",
          },
        },
      },
    });

    expect(details).toEqual({
      objectiveId: null,
      snapshotId: null,
      patternKey: "route-shell",
      reservationRequired: false,
      validationIncidentId: null,
      isValidationIncidentRepair: false,
      workClass: null,
      isRecoveryWork: false,
      targetPaths: [
        "apps/shared.ts",
        "apps/metadata.ts",
        "apps/autonomy.ts",
        "apps/param-path.ts",
        "apps/param-target.ts",
        "apps/planning.ts",
        "apps/root.ts",
      ],
      writeGlobs: ["apps/**", "tests/**"],
    });
  });

  test("supports JSON encoded params and metadata", () => {
    const details = extractAutonomyPayloadDetails({
      metadataJson: JSON.stringify({
        autonomy: {
          pattern_key: "encoded-pattern",
          target_path: "src/metadata.ts",
        },
      }),
      params: JSON.stringify({
        targetPath: "src/params.ts",
        planning: {
          target_paths: ["src/planning.ts"],
        },
      }),
    });

    expect(details.patternKey).toBe("encoded-pattern");
    expect(details.targetPaths).toEqual(["src/metadata.ts", "src/params.ts", "src/planning.ts"]);
  });

  test("detects bounded validation repair markers across request and job payloads", () => {
    const request = extractAutonomyPayloadDetails({
      metadata: {
        autonomy: {
          objective_id: "obj_parser",
          snapshot_id: "snapshot_parser",
          reservation_required: true,
          validation_incident: { incident_id: "valid_inc_parser" },
        },
      },
    });
    expect(request.validationIncidentId).toBe("valid_inc_parser");
    expect(request.isValidationIncidentRepair).toBe(true);
    expect(request.isRecoveryWork).toBe(true);
    expect(request.objectiveId).toBe("obj_parser");
    expect(request.snapshotId).toBe("snapshot_parser");
    expect(request.reservationRequired).toBe(true);

    const job = extractAutonomyPayloadDetails({
      params: JSON.stringify({
        autonomy: {
          objectiveId: "obj_runtime",
          snapshotId: "snapshot_runtime",
          reservationRequired: true,
          validationIncident: { incidentId: "valid_inc_runtime" },
        },
      }),
    });
    expect(job.validationIncidentId).toBe("valid_inc_runtime");
    expect(job.isValidationIncidentRepair).toBe(true);
    expect(job.isRecoveryWork).toBe(true);
    expect(job.objectiveId).toBe("obj_runtime");
    expect(job.snapshotId).toBe("snapshot_runtime");
    expect(job.reservationRequired).toBe(true);

    expect(
      extractAutonomyPayloadDetails({
        metadata: { autonomy: { validationIncident: { incidentId: "" } } },
      }).isValidationIncidentRepair,
    ).toBe(false);

    expect(
      extractAutonomyPayloadDetails({
        params: { origin: "autonomy", planning: { work_class: "repair" } },
      }),
    ).toMatchObject({ workClass: "repair", isRecoveryWork: true });
  });
});
