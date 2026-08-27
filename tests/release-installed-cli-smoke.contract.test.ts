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
  assertCliVersionCommand,
  expectedCliVersionFromReleaseInput,
  runtimeCandidateBinaryNames,
  seedCandidateRuntimeBinaries,
} from "../scripts/release-installed-cli-smoke.ts";

function isValidProcessId(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isEffectivelyAlive(pid: number): boolean {
  if (!isValidProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/, 1)[0];
      // Minimal containers without a subreaper can retain a terminated orphan
      // as a zombie. It has no executable process left to terminate.
      if (state === "Z") return false;
    } catch {
      // If procfs is restricted or unavailable, keep treating a PID that still
      // answers kill(0) as alive. A second probe closes the normal exit race.
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  }
  return true;
}

describe("published Windows CLI runtime soak contract", () => {
  test("derives and verifies the exact installed CLI release version", () => {
    expect(expectedCliVersionFromReleaseInput("@pushpalsdev/cli@1.2.42", null)).toBe("1.2.42");
    expect(
      expectedCliVersionFromReleaseInput("C:/artifacts/pushpalsdev-cli-1.2.42.tgz", "v1.2.42"),
    ).toBe("1.2.42");
    expect(expectedCliVersionFromReleaseInput("@pushpalsdev/cli@latest", null)).toBeNull();

    const smoke = readFileSync(
      join(process.cwd(), "scripts", "release-installed-cli-smoke.ts"),
      "utf8",
    );
    expect(smoke).toContain("await assertCliVersionCommand");
    expect(smoke).toContain('label: "Installed pushpals --version"');
  });

  test("runs version checks through the bounded process harness", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-version-contract-"));
    const fixture = join(root, "version-fixture.ts");
    try {
      writeFileSync(
        fixture,
        `if (!process.argv.includes("--version")) process.exit(2);
console.log("[pushpals] version=1.2.42 runtime=bun@" + Bun.version);
console.log("[pushpals] platform=" + process.platform + "/" + process.arch);
`,
        "utf8",
      );
      const output = await assertCliVersionCommand({
        command: [process.execPath, fixture],
        cwd: root,
        env: process.env,
        expectedVersion: "1.2.42",
        timeoutMs: 5_000,
      });
      expect(output).toContain("[pushpals] version=1.2.42 runtime=bun@");
      await expect(
        assertCliVersionCommand({
          command: [process.execPath, fixture],
          cwd: root,
          env: process.env,
          expectedVersion: "1.2.43",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("did not report exact package version 1.2.43");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("times out a stuck version command and terminates its descendant", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-cli-version-timeout-"));
    const fixture = join(root, "stuck-version-fixture.ts");
    const childPidFile = join(root, "child.pid");
    let childPid = 0;
    try {
      writeFileSync(
        fixture,
        `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
await Bun.write(String(process.env.PUSHPALS_SMOKE_CHILD_PID_FILE ?? ""), String(child.pid));
setInterval(() => {}, 1000);
`,
        "utf8",
      );
      const startedAt = Date.now();
      await expect(
        assertCliVersionCommand({
          command: [process.execPath, fixture],
          cwd: root,
          env: {
            ...process.env,
            PUSHPALS_SMOKE_CHILD_PID_FILE: childPidFile,
          },
          expectedVersion: "1.2.42",
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("Timed out after 1000ms");
      expect(Date.now() - startedAt).toBeLessThan(8_000);

      childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
      expect(isValidProcessId(childPid)).toBeTrue();
      let alive = true;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!isEffectivelyAlive(childPid)) {
          alive = false;
          break;
        }
        await Bun.sleep(50);
      }
      expect(alive).toBeFalse();
    } finally {
      if (!isValidProcessId(childPid) && existsSync(childPidFile)) {
        try {
          childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
        } catch {
          // The fixture may have failed before persisting its descendant PID.
        }
      }
      if (isValidProcessId(childPid) && isEffectivelyAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The bounded runner already cleaned it up.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

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
