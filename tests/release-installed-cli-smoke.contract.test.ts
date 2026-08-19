import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runtimeCandidateBinaryNames,
  seedCandidateRuntimeBinaries,
} from "../scripts/release-installed-cli-smoke.ts";

describe("published Windows CLI runtime soak contract", () => {
  test("validates the exact CLI tarball against same-run runtime candidates", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "release-cli.yml"),
      "utf8",
    );
    const smoke = readFileSync(
      join(process.cwd(), "scripts", "release-installed-cli-smoke.ts"),
      "utf8",
    );
    const reliabilityStart = workflow.indexOf("reliability_contract:");
    const publishStart = workflow.indexOf("publish_npm:");
    const reliabilityJob = workflow.slice(reliabilityStart, publishStart);

    expect(reliabilityStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(reliabilityStart);
    expect(reliabilityJob).toContain("- build_runtime_binaries");
    expect(reliabilityJob).toContain("name: runtime-linux-x64");
    expect(reliabilityJob).toContain(
      '--runtime-bin-dir "${{ github.workspace }}/dist/tested-runtime-linux-x64"',
    );
    expect(reliabilityJob).toContain('--runtime-tag "${{ needs.meta.outputs.tag }}"');
    expect(reliabilityJob).toContain("--duration-ms 240000");
    expect(smoke).toContain('case "--runtime-bin-dir"');
    expect(smoke).toContain("Embedded runtime binaries are already present.");
    expect(smoke).toContain("attempted a GitHub runtime download during candidate validation");
  });

  test("seeds all five candidate binaries and writes the runtime tag marker", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-candidate-runtime-test-"));
    const sourceDir = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const binaryNames = runtimeCandidateBinaryNames("linux-x64");
    try {
      mkdirSync(sourceDir, { recursive: true });
      for (const name of binaryNames) {
        writeFileSync(join(sourceDir, name), `candidate:${name}\n`, "utf8");
      }

      const seeded = seedCandidateRuntimeBinaries({
        runtimeRoot,
        runtimeBinDir: sourceDir,
        runtimeTag: "v1.2.39",
        platformKey: "linux-x64",
      });

      expect(seeded.binaryNames).toEqual(binaryNames);
      expect(readFileSync(seeded.tagMarkerPath, "utf8")).toBe("v1.2.39\n");
      for (const name of binaryNames) {
        const installed = join(seeded.binDir, name);
        expect(readFileSync(installed, "utf8")).toBe(`candidate:${name}\n`);
        if (process.platform !== "win32") {
          expect(statSync(installed).mode & 0o111).not.toBe(0);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes a stale marker and copies nothing when a candidate file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-candidate-runtime-missing-"));
    const sourceDir = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const binDir = join(runtimeRoot, "bin", "linux-x64");
    const marker = join(binDir, ".runtime-tag");
    const binaryNames = runtimeCandidateBinaryNames("linux-x64");
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(marker, "v0.0.0\n", "utf8");
      for (const name of binaryNames.slice(0, -1)) {
        writeFileSync(join(sourceDir, name), `candidate:${name}\n`, "utf8");
      }

      expect(() =>
        seedCandidateRuntimeBinaries({
          runtimeRoot,
          runtimeBinDir: sourceDir,
          runtimeTag: "v1.2.39",
          platformKey: "linux-x64",
        }),
      ).toThrow(binaryNames.at(-1)!);
      expect(existsSync(marker)).toBe(false);
      for (const name of binaryNames) {
        expect(existsSync(join(binDir, name))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not write the authoritative marker when a candidate copy fails", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-candidate-runtime-copy-failure-"));
    const sourceDir = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const binDir = join(runtimeRoot, "bin", "linux-x64");
    const marker = join(binDir, ".runtime-tag");
    const binaryNames = runtimeCandidateBinaryNames("linux-x64");
    try {
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(marker, "v0.0.0\n", "utf8");
      for (const name of binaryNames) {
        writeFileSync(join(sourceDir, name), `candidate:${name}\n`, "utf8");
      }
      mkdirSync(join(binDir, binaryNames[1]!), { recursive: true });

      expect(() =>
        seedCandidateRuntimeBinaries({
          runtimeRoot,
          runtimeBinDir: sourceDir,
          runtimeTag: "v1.2.39",
          platformKey: "linux-x64",
        }),
      ).toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the installed package alive beyond RemoteBuddy's 120 second autonomy grace", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "release-cli.yml"),
      "utf8",
    );
    const smoke = readFileSync(
      join(process.cwd(), "scripts", "release-installed-cli-smoke.ts"),
      "utf8",
    );

    expect(workflow).toContain("--soak-ms 150000");
    expect(smoke).toContain('[options.pushpalsPath, "--runtime-only"');
    expect(smoke).toContain('"embeddedRuntimeCrash="');
    expect(smoke).toContain('"embeddedRuntime=degraded"');
    expect(smoke).toContain("Runtime remained healthy");
  });
});
