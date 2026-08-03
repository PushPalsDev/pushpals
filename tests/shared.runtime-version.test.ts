import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MINIMUM_SUPPORTED_BUN_VERSION,
  isSupportedBunVersion,
  parseRuntimeVersion,
} from "../packages/shared/src/runtime_version";

describe("shared Bun runtime compatibility", () => {
  test("rejects the crashing 1.3.9 runtime and accepts the pinned release runtime", () => {
    expect(MINIMUM_SUPPORTED_BUN_VERSION).toBe("1.3.14");
    expect(isSupportedBunVersion("1.3.9")).toBe(false);
    expect(isSupportedBunVersion("1.3.13")).toBe(false);
    expect(isSupportedBunVersion("1.3.14")).toBe(true);
    expect(isSupportedBunVersion("1.4.0-canary.1")).toBe(true);
    expect(isSupportedBunVersion("unknown")).toBe(false);
    expect(parseRuntimeVersion("Bun v1.3.14 (Windows x64)")).toEqual([1, 3, 14]);
  });

  test("keeps the npm package engine floor aligned with the runtime guard", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "packages", "cli", "package.json"), "utf8"),
    ) as { engines?: { bun?: string } };
    expect(packageJson.engines?.bun).toBe(`>=${MINIMUM_SUPPORTED_BUN_VERSION}`);
  });

  test("keeps the packaged sandbox runtime guard identical to the shared source", () => {
    const source = readFileSync(
      join(process.cwd(), "packages", "shared", "src", "runtime_version.ts"),
      "utf8",
    );
    const packaged = readFileSync(
      join(
        process.cwd(),
        "packages",
        "cli",
        "runtime",
        "sandbox",
        "packages",
        "shared",
        "src",
        "runtime_version.ts",
      ),
      "utf8",
    );
    expect(packaged).toBe(source);
  });
});
