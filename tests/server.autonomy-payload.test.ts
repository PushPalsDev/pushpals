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
      patternKey: "route-shell",
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
});
