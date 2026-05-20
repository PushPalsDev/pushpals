import { describe, expect, test } from "bun:test";
import {
  deriveAutonomyComponentArea,
  makePatternKey,
  normalizeTargetPath,
  validateScopeInvariants,
} from "../packages/shared/src/autonomy_policy";

describe("shared autonomy policy", () => {
  test("makePatternKey is deterministic and sha256-shaped", () => {
    const a = makePatternKey(
      "flaky_test",
      ["apps/server/src/server_main.ts", "apps/server/src/server_main.ts"],
      "test_failure",
      "apps/server",
    );
    const b = makePatternKey(
      "flaky_test",
      ["apps/server/src/server_main.ts"],
      "test_failure",
      "apps/server",
    );
    expect(a).toBe(b);
    expect(a.startsWith("pk_")).toBe(true);
    expect(a.length).toBe(67);
  });

  test("normalizeTargetPath rejects globs and traversal", () => {
    expect(normalizeTargetPath("apps/server/src/*.ts")).toBeNull();
    expect(normalizeTargetPath("../outside.ts")).toBeNull();
    expect(normalizeTargetPath("/abs/path.ts")).toBeNull();
  });

  test("validateScopeInvariants enforces target coverage and component root", () => {
    const ok = validateScopeInvariants(
      "apps/server",
      ["apps/server/src/server_main.ts"],
      ["apps/server/src/*.ts"],
      { requireWriteGlobs: true },
    );
    expect(ok.ok).toBe(true);
    expect(ok.componentArea).toBe("apps/server");
    expect(ok.errors.length).toBe(0);

    const bad = validateScopeInvariants(
      "apps/server",
      ["apps/server/src/server_main.ts"],
      ["apps/remotebuddy/src/*.ts"],
      { requireWriteGlobs: true },
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("outside component root");
  });

  test("validateScopeInvariants derives component area from repo-relative scope", () => {
    const derived = validateScopeInvariants(null, ["src/autonomy.ts"], ["src/autonomy.ts"], {
      requireWriteGlobs: true,
    });
    expect(derived.ok).toBe(true);
    expect(derived.componentArea).toBe("src");
  });

  test("deriveAutonomyComponentArea returns null for disjoint roots", () => {
    expect(
      deriveAutonomyComponentArea(
        ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
        ["app/**", "scripts/**"],
      ),
    ).toBeNull();
  });

  test("validateScopeInvariants rejects mixed-root autonomy scope when component area is absent", () => {
    const invalid = validateScopeInvariants(
      null,
      ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      ["app/**", "scripts/**"],
      { requireWriteGlobs: true },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(" ")).toContain("scope spans multiple component roots");
  });

  test("validateScopeInvariants can allow multiple component roots without allowing broad globs", () => {
    const valid = validateScopeInvariants(
      null,
      ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      ["app/**", "scripts/**"],
      { requireWriteGlobs: true, allowMultipleComponentRoots: true },
    );
    expect(valid.ok).toBe(true);
    expect(valid.componentArea).toBeNull();

    const broad = validateScopeInvariants(
      null,
      ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      ["**"],
      { requireWriteGlobs: true, allowMultipleComponentRoots: true },
    );
    expect(broad.ok).toBe(false);
    expect(broad.errors.join(" ")).toContain("forbidden broad write_glob");
  });

  test("validateScopeInvariants treats autonomy hint scope as non-permission metadata", () => {
    const hints = validateScopeInvariants(
      "apps/server",
      ["app/_layout.tsx", "scripts/fix-baseline-browser-mapping.js"],
      ["**/*"],
      { requireWriteGlobs: true, hintsOnly: true },
    );

    expect(hints.ok).toBe(true);
    expect(hints.componentArea).toBe("apps/server");
    expect(hints.normalizedTargetPaths).toEqual([
      "app/_layout.tsx",
      "scripts/fix-baseline-browser-mapping.js",
    ]);
    expect(hints.normalizedWriteGlobs).toEqual(["**/*"]);
    expect(hints.breadth).toBe("broad");
  });
});
