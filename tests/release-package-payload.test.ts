import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  findDisallowedCliPackageEntries,
  findDisallowedReleaseArtifactEntries,
  NPM_PACK_DRY_RUN_TIMEOUT_MS,
  REQUIRED_CLI_PACKAGE_PATHS,
} from "../scripts/verify-cli-package-payload.ts";

const repoRoot = resolve(import.meta.dir, "..");
const verifierScript = join(repoRoot, "scripts", "verify-cli-package-payload.ts");
const VERIFIER_PROCESS_TIMEOUT_MS = NPM_PACK_DRY_RUN_TIMEOUT_MS + 5_000;
const VERIFIER_TEST_TIMEOUT_MS = VERIFIER_PROCESS_TIMEOUT_MS + 5_000;
function requiredCliPackageFiles() {
  return REQUIRED_CLI_PACKAGE_PATHS.map((path) => ({
    path,
    ...(path === "bin/pushpals.cjs" || path === "dist/pushpals-cli.js" ? { mode: 0o755 } : {}),
  }));
}

function withTempPackage<T>(fn: (packageDir: string) => T): T {
  const packageDir = mkdtempSync(join(tmpdir(), "pushpals-package-payload-test-"));
  try {
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    mkdirSync(join(packageDir, "runtime", "sandbox"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name: "pushpals-package-payload-fixture",
          version: "1.0.0",
          bin: {
            pushpals: "bin/pushpals.cjs",
          },
          files: ["bin", "dist", "runtime", "README.md"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(packageDir, "README.md"), "# fixture\n", "utf8");
    for (const requiredPath of REQUIRED_CLI_PACKAGE_PATHS) {
      const fixturePath = join(packageDir, requiredPath);
      mkdirSync(dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, "fixture\n", "utf8");
    }
    return fn(packageDir);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
}

function runVerifier(args: string[], env: Record<string, string | undefined> = process.env) {
  return spawnSync(process.execPath, ["run", verifierScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: VERIFIER_PROCESS_TIMEOUT_MS,
  });
}

function envWithoutExecutableSearchPath(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
    ),
    PATH: "",
  };
}

describe("release package payload verification", () => {
  test("requires the complete WorkerPal sandbox bootstrap surface", () => {
    expect(REQUIRED_CLI_PACKAGE_PATHS).toEqual(
      expect.arrayContaining([
        "runtime/sandbox/package.json",
        "runtime/sandbox/bun.lock",
        "runtime/sandbox/configs/default.toml",
        "runtime/sandbox/apps/workerpals/Dockerfile.sandbox",
        "runtime/sandbox/apps/workerpals/package.json",
        "runtime/sandbox/apps/workerpals/uv.lock",
        "runtime/sandbox/apps/workerpals/src/job_runner.ts",
        "runtime/sandbox/apps/workerpals/src/common/generic_python_executor.ts",
        "runtime/sandbox/apps/workerpals/src/backends/openai_codex/openai_codex_executor.py",
        "runtime/sandbox/packages/shared/src/index.ts",
        "runtime/sandbox/packages/shared/src/memory.ts",
        "runtime/sandbox/packages/shared/src/repo_validation.ts",
        "runtime/sandbox/packages/shared/src/repository_agent.ts",
        "runtime/sandbox/packages/shared/src/repository_identity.ts",
        "runtime/sandbox/packages/shared/src/repository_snapshot.ts",
        "runtime/sandbox/packages/shared/src/scm_repair_authority.ts",
        "runtime/sandbox/packages/shared/src/tooling.ts",
        "runtime/sandbox/packages/protocol/package.json",
        "runtime/sandbox/packages/protocol/src/index.ts",
        "runtime/sandbox/packages/protocol/src/schemas/envelope.schema.json",
        "runtime/prompts/remotebuddy/repository_agent_codex_prompt_template.md",
        "runtime/sandbox/prompts/remotebuddy/repository_agent_codex_prompt_template.md",
      ]),
    );
  });

  test("bounds npm package inspection below the verifier and test deadlines", () => {
    expect(NPM_PACK_DRY_RUN_TIMEOUT_MS).toBe(30_000);
    expect(VERIFIER_PROCESS_TIMEOUT_MS).toBeGreaterThan(NPM_PACK_DRY_RUN_TIMEOUT_MS);
    expect(VERIFIER_TEST_TIMEOUT_MS).toBeGreaterThan(VERIFIER_PROCESS_TIMEOUT_MS);
  });

  test("rejects developer-local runtime configuration from npm packages", () => {
    const issues = findDisallowedCliPackageEntries([
      ...requiredCliPackageFiles(),
      { path: "runtime/configs/local.toml", mode: 0o644 },
      { path: "runtime/sandbox/configs/local.toml", mode: 0o644 },
    ]);

    expect(issues).toEqual([
      {
        path: "runtime/configs/local.toml",
        reason: "package payload includes a developer-local runtime override",
      },
      {
        path: "runtime/sandbox/configs/local.toml",
        reason: "package payload includes a developer-local runtime override",
      },
    ]);
  });

  test("fresh CLI package builds compile the protocol workspace before runtime source bundles", () => {
    const cliPackage = JSON.parse(
      readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ) as { scripts?: { build?: string } };
    const buildScript = String(cliPackage.scripts?.build ?? "");

    expect(buildScript.startsWith("bun --cwd ../protocol build && ")).toBe(true);
    expect(buildScript.indexOf("../protocol build")).toBeLessThan(
      buildScript.indexOf("sync-cli-runtime-assets.ts"),
    );
  });

  test("CLI E2E prebuilds the package before concurrent test files consume it", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: { "test:cli:e2e"?: string };
    };
    const e2eScript = String(rootPackage.scripts?.["test:cli:e2e"] ?? "");

    expect(e2eScript.startsWith("bun run cli:bundle && bun test ")).toBe(true);
    expect(e2eScript.indexOf("cli:bundle")).toBeLessThan(e2eScript.indexOf("bun test"));
  });

  test("hosted Windows CI exercises source-only startup without compiling standalone runtimes", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "cli-e2e.yml"), "utf8");
    const e2eSource = readFileSync(join(repoRoot, "tests", "integration", "cli.e2e.ts"), "utf8");

    expect(workflow).toContain("Verify isolated Windows source-only runtime startup");
    expect(workflow).toContain(
      '--test-name-pattern "boots (packaged Windows runtime|every Windows service)"',
    );
    expect(workflow).toContain(
      "windows_host_docker_e2e:\n    name: Windows Host Docker E2E\n    if: github.event_name == 'workflow_dispatch'",
    );
    expect(e2eSource).toContain("buildRuntimeBinaries: false");
    expect(e2eSource).toContain(
      "PushPals source-only startup test: standalone runtime deliberately unavailable.",
    );
  });

  test("hosted Linux CI exercises dependency projection before release tags", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "cli-e2e.yml"), "utf8");
    const workerJobIndex = workflow.indexOf("workerpals_control_plane_e2e_linux:");
    const windowsDockerJobIndex = workflow.indexOf("windows_host_docker_e2e:");
    const workerJob = workflow.slice(workerJobIndex, windowsDockerJobIndex);

    expect(workflow.match(/- "tests\/workerpals\.docker-executor\.test\.ts"/g)).toHaveLength(2);
    expect(workerJobIndex).toBeGreaterThanOrEqual(0);
    expect(windowsDockerJobIndex).toBeGreaterThan(workerJobIndex);
    expect(workerJob).toContain("Verify Linux dependency projection contract");
    expect(workerJob).toContain('PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION: "1"');
    expect(workerJob).toContain("bun test tests/workerpals.docker-executor.test.ts");
  });

  test("hosted Linux CI verifies package payload changes before release tags", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "cli-e2e.yml"), "utf8");
    const packagedJobIndex = workflow.indexOf("packaged_cli_e2e_linux:");
    const workerJobIndex = workflow.indexOf("workerpals_control_plane_e2e_linux:");
    const packagedJob = workflow.slice(packagedJobIndex, workerJobIndex);

    expect(workflow.match(/- "tests\/release-package-payload\.test\.ts"/g)).toHaveLength(2);
    expect(packagedJobIndex).toBeGreaterThanOrEqual(0);
    expect(workerJobIndex).toBeGreaterThan(packagedJobIndex);
    expect(packagedJob).toContain("Verify release package payload contract");
    expect(packagedJob).toContain("bun test tests/release-package-payload.test.ts");
  });

  test("allows the expected CLI package payload shape without vendored tool binaries", () => {
    const issues = findDisallowedCliPackageEntries([
      { path: "README.md" },
      ...requiredCliPackageFiles(),
      { path: "runtime/configs/default.toml" },
      {
        path: "monitor-ui/assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf",
      },
    ]);

    expect(issues).toEqual([]);
  });

  test("rejects external toolchain binaries and runtime dependency directories", () => {
    const issues = findDisallowedCliPackageEntries([
      ...requiredCliPackageFiles(),
      { path: "runtime/bin/bun.exe" },
      { path: "runtime/bin/node" },
      { path: "runtime/bin/git.cmd" },
      { path: "runtime/bin/docker" },
      { path: "runtime/bin/codex" },
      { path: "runtime/bin/uv" },
      { path: "runtime/lib/native.node" },
      { path: "runtime/bin/helper", mode: 0o755 },
      { path: "runtime/vendor/libsqlite3.so.0" },
      { path: "runtime/sandbox/node_modules/package/index.js" },
      { path: "runtime/sandbox/apps/workerpals/.venv/bin/python" },
    ]);

    expect(issues.map((issue) => issue.path)).toEqual([
      "runtime/bin/bun.exe",
      "runtime/bin/node",
      "runtime/bin/git.cmd",
      "runtime/bin/docker",
      "runtime/bin/codex",
      "runtime/bin/uv",
      "runtime/lib/native.node",
      "runtime/bin/helper",
      "runtime/vendor/libsqlite3.so.0",
      "runtime/sandbox/node_modules/package/index.js",
      "runtime/sandbox/apps/workerpals/.venv/bin/python",
    ]);
  });

  test("normalizes Windows package paths before matching blocked tools and directories", () => {
    const issues = findDisallowedCliPackageEntries([
      ...requiredCliPackageFiles().map((entry) => ({
        ...entry,
        path: entry.path.replaceAll("/", "\\"),
      })),
      { path: "runtime\\bin\\bun.exe" },
      { path: "runtime\\sandbox\\node_modules\\package\\index.js" },
    ]);

    expect(issues.map((issue) => issue.path)).toEqual([
      "runtime/bin/bun.exe",
      "runtime/sandbox/node_modules/package/index.js",
    ]);
  });

  test("rejects package payloads missing required CLI entry files", () => {
    const issues = findDisallowedCliPackageEntries([{ path: "README.md" }]);

    expect(issues.map((issue) => issue.path)).toEqual([...REQUIRED_CLI_PACKAGE_PATHS]);
    expect(issues.every((issue) => issue.reason === "required CLI package entry is missing")).toBe(
      true,
    );
  });

  test("rejects packages missing required shared runtime code or the isolated RepositoryAgent prompt", () => {
    const requiredRuntimePaths = [
      "runtime/sandbox/packages/shared/src/memory.ts",
      "runtime/sandbox/packages/shared/src/repository_agent.ts",
      "runtime/sandbox/packages/shared/src/scm_repair_authority.ts",
      "runtime/prompts/remotebuddy/repository_agent_codex_prompt_template.md",
      "runtime/sandbox/prompts/remotebuddy/repository_agent_codex_prompt_template.md",
    ];

    for (const missingPath of requiredRuntimePaths) {
      const issues = findDisallowedCliPackageEntries(
        requiredCliPackageFiles().filter((file) => file.path !== missingPath),
      );

      expect(issues).toEqual([
        {
          path: missingPath,
          reason: "required CLI package entry is missing",
        },
      ]);
    }
  });

  test("packaged sandbox shared index resolves and imports SCM repair authority", () => {
    const sandboxRoot = join(repoRoot, "packages", "cli", "runtime", "sandbox");
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const shared = await import("./packages/shared/src/index.ts");',
          'const secret = "s".repeat(32);',
          'const body = { requestId: "req_packaged_scm_repair" };',
          "const nowMs = 1770000000000;",
          'const proof = shared.createScmRepairAuthorityProof(body, secret, { nowMs, nonce: "packaged_probe_01" });',
          "const verified = shared.verifyScmRepairAuthorityProof({ body, proof, secret, nowMs });",
          "if (!verified.ok) throw new Error(`packaged authority verification failed: ${verified.reason}`);",
          'if (shared.SCM_REPAIR_AUTHORITY_HEADER !== "x-pushpals-scm-repair-authority") throw new Error("missing packaged authority export");',
        ].join("\n"),
      ],
      {
        cwd: sandboxRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr }).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  test("release artifact guard allows only PushPals release assets", () => {
    expect(
      findDisallowedReleaseArtifactEntries([
        "pushpals-linux-x64",
        "pushpals-windows-x64.exe",
        "pushpals-macos-x64",
        "pushpals-macos-arm64",
        "pushpals-runtime-server-linux-x64",
        "pushpals-runtime-source-control-manager-windows-x64.exe",
        "SHA256SUMS.txt",
        "SHA256SUMS.txt.asc",
      ]),
    ).toEqual([]);

    expect(
      findDisallowedReleaseArtifactEntries([
        "bun.exe",
        "node",
        "codex",
        "pushpals-runtime-workerpals-windows-x64.exe.old",
      ]).map((issue) => issue.path),
    ).toEqual(["bun.exe", "node", "codex", "pushpals-runtime-workerpals-windows-x64.exe.old"]);
  });

  test(
    "script succeeds against a clean packed package fixture",
    () => {
      withTempPackage((packageDir) => {
        const result = runVerifier(["--package-dir", packageDir]);

        expect({
          status: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
        }).toEqual({
          status: 0,
          signal: null,
          error: null,
          stdout: expect.stringContaining("verified npm package payload"),
          stderr: "",
        });
      });
    },
    VERIFIER_TEST_TIMEOUT_MS,
  );

  test(
    "script fails against a package fixture that would ship Bun",
    () => {
      withTempPackage((packageDir) => {
        mkdirSync(join(packageDir, "runtime", "bin"), { recursive: true });
        writeFileSync(join(packageDir, "runtime", "bin", "bun.exe"), "not really bun\n", "utf8");

        const result = runVerifier(["--package-dir", packageDir]);

        expect({
          status: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
        }).toEqual({
          status: 1,
          signal: null,
          error: null,
          stdout: "",
          stderr: expect.stringContaining("runtime/bin/bun.exe"),
        });
        expect(result.stderr).toContain("runtime/bin/bun.exe");
        expect(result.stderr).toContain("external toolchain");
      });
    },
    VERIFIER_TEST_TIMEOUT_MS,
  );

  test(
    "script preserves npm launch diagnostics when the executable search path is empty",
    () => {
      withTempPackage((packageDir) => {
        const result = runVerifier(["--package-dir", packageDir], envWithoutExecutableSearchPath());

        expect({
          status: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
          stdout: result.stdout,
        }).toEqual({
          status: 1,
          signal: null,
          error: null,
          stdout: "",
        });
        expect(result.stderr).toContain("npm pack --dry-run failed");
        expect(result.stderr).toMatch(
          /(?:spawn error:|no such file or directory|not (?:found|recognized))/i,
        );
        expect(result.stderr).not.toContain("TypeError");
      });
    },
    VERIFIER_TEST_TIMEOUT_MS,
  );

  test("release workflow tests and publishes one immutable CLI package artifact", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release-cli.yml"),
      "utf8",
    );

    const buildJobIndex = workflow.indexOf("build_cli_package:");
    const reliabilityJobIndex = workflow.indexOf("reliability_contract:");
    const publishJobIndex = workflow.indexOf("publish_npm:");
    const publishedSmokeJobIndex = workflow.indexOf("smoke_published_cli_linux:");
    const publishReleaseJobIndex = workflow.indexOf("publish_release:");
    const buildJob = workflow.slice(buildJobIndex, reliabilityJobIndex);
    const reliabilityJob = workflow.slice(reliabilityJobIndex, publishJobIndex);
    const publishJob = workflow.slice(publishJobIndex, publishedSmokeJobIndex);
    const publishReleaseJob = workflow.slice(publishReleaseJobIndex);
    const setVersionIndex = buildJob.indexOf("Set CLI package version from tag");
    const buildPackageIndex = buildJob.indexOf("Build CLI package payload");
    const verifyPackageIndex = buildJob.indexOf(
      "Verify CLI package payload excludes external toolchains",
    );
    const packPackageIndex = buildJob.indexOf("Pack immutable CLI package artifact");
    const uploadPackageIndex = buildJob.indexOf("Upload immutable CLI package artifact");
    const reliabilityDownloadIndex = reliabilityJob.indexOf(
      "Download immutable CLI package artifact",
    );
    const reliabilityUnpackIndex = reliabilityJob.indexOf(
      "Verify and unpack immutable CLI package artifact",
    );
    const reliabilityDockerIndex = reliabilityJob.indexOf("Build packaged WorkerPal sandbox image");
    const reliabilityCliSmokeIndex = reliabilityJob.indexOf(
      "Smoke exact immutable CLI and runtime candidate artifacts",
    );
    const reliabilityRuntimeDownloadIndex = reliabilityJob.indexOf(
      "Download immutable Linux runtime candidates",
    );
    const reliabilityHarnessIndex = reliabilityJob.indexOf("bun run harness:reliability");
    const publishDownloadIndex = publishJob.indexOf(
      "Download tested immutable CLI package artifact",
    );
    const publishVerifyIndex = publishJob.indexOf("Verify tested immutable CLI package artifact");
    const publishIndex = publishJob.indexOf("Publish to npm");
    const checksumIndex = workflow.indexOf("Generate checksums");
    const verifyReleaseIndex = workflow.indexOf(
      "Verify GitHub release assets exclude external tool artifacts",
    );
    const createReleaseIndex = workflow.indexOf("Create GitHub release (release log)");
    const reliabilityInstallIndex = reliabilityJob.indexOf("bun install --frozen-lockfile");
    const reliabilityProtocolBuildIndex = reliabilityJob.indexOf("bun run protocol:build");

    expect(buildJobIndex).toBeGreaterThanOrEqual(0);
    expect(reliabilityJobIndex).toBeGreaterThan(buildJobIndex);
    expect(publishJobIndex).toBeGreaterThan(reliabilityJobIndex);
    expect(publishedSmokeJobIndex).toBeGreaterThan(publishJobIndex);
    expect(publishReleaseJobIndex).toBeGreaterThan(publishedSmokeJobIndex);
    expect(buildJob).toContain("needs: meta");
    expect(setVersionIndex).toBeGreaterThanOrEqual(0);
    expect(buildPackageIndex).toBeGreaterThanOrEqual(0);
    expect(buildPackageIndex).toBeGreaterThan(setVersionIndex);
    expect(verifyPackageIndex).toBeGreaterThan(buildPackageIndex);
    expect(packPackageIndex).toBeGreaterThan(verifyPackageIndex);
    expect(uploadPackageIndex).toBeGreaterThan(packPackageIndex);
    expect(buildJob).toContain(
      "npm pack ./packages/cli --ignore-scripts --pack-destination dist/tested-cli-artifact",
    );
    expect(buildJob).toContain('sha256sum "$tarball_name" > SHA256SUMS.txt');
    expect(buildJob).toContain("name: pushpals-cli-package-${{ needs.meta.outputs.version }}");

    expect(reliabilityJob).toContain("- build_cli_package");
    expect(reliabilityJob).toContain("- build_runtime_binaries");
    expect(reliabilityDownloadIndex).toBeGreaterThan(reliabilityProtocolBuildIndex);
    expect(reliabilityUnpackIndex).toBeGreaterThan(reliabilityDownloadIndex);
    expect(reliabilityRuntimeDownloadIndex).toBeGreaterThan(reliabilityUnpackIndex);
    expect(reliabilityCliSmokeIndex).toBeGreaterThan(reliabilityRuntimeDownloadIndex);
    expect(reliabilityDockerIndex).toBeGreaterThan(reliabilityCliSmokeIndex);
    expect(reliabilityHarnessIndex).toBeGreaterThan(reliabilityDockerIndex);
    expect(reliabilityJob).toContain("sha256sum -c SHA256SUMS.txt");
    expect(reliabilityJob).toContain('tar -xzf "${tarballs[0]}"');
    expect(reliabilityJob).toContain(
      '--package-spec "${{ steps.tested_package.outputs.tarball }}"',
    );
    expect(reliabilityJob).toContain("name: runtime-linux-x64");
    expect(reliabilityJob).toContain(
      '--runtime-bin-dir "${{ github.workspace }}/dist/tested-runtime-linux-x64"',
    );
    expect(reliabilityJob).toContain('--runtime-tag "${{ needs.meta.outputs.tag }}"');
    expect(reliabilityJob).toContain(
      "GitHub release assets do not exist yet. Seed the exact same-run Actions",
    );
    expect(reliabilityJob).toContain(
      "PUSHPALS_PACKAGED_RUNTIME_ROOT: ${{ github.workspace }}/dist/tested-cli-package/package/runtime/sandbox",
    );
    expect(reliabilityJob).toContain(
      "docker build -f dist/tested-cli-package/package/runtime/sandbox/apps/workerpals/Dockerfile.sandbox -t pushpals-worker-sandbox:latest dist/tested-cli-package/package/runtime/sandbox",
    );
    expect(reliabilityJob).not.toContain(
      "docker build -f apps/workerpals/Dockerfile.sandbox -t pushpals-worker-sandbox:latest .",
    );
    expect(reliabilityJob).not.toContain(
      "docker build -f packages/cli/runtime/sandbox/apps/workerpals/Dockerfile.sandbox",
    );

    expect(publishJob).toContain("- build_cli_package");
    expect(workflow).toContain("- reliability_contract");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain('node-version: "24.11.0"');
    expect(publishJob).toContain("npm install --global npm@11.6.1");
    expect(publishJob).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(publishJob).not.toContain("NPM_TOKEN");
    expect(publishJob).not.toContain("NODE_AUTH_TOKEN");
    expect(publishJob).not.toContain("npm whoami");
    expect(publishJob).not.toContain("registry-url:");
    expect(publishJob).not.toContain("_authToken");
    expect(workflow).toContain('if [[ "${GITHUB_REF_TYPE}" != "tag" ]]');
    expect(publishDownloadIndex).toBeGreaterThanOrEqual(0);
    expect(publishVerifyIndex).toBeGreaterThan(publishDownloadIndex);
    expect(publishIndex).toBeGreaterThan(publishVerifyIndex);
    expect(publishJob).toContain("sha256sum -c SHA256SUMS.txt");
    expect(publishJob).toContain(
      'npm publish "${{ steps.tested_package.outputs.tarball }}" --ignore-scripts --access public --provenance',
    );
    expect(publishJob).not.toContain("bun run --cwd packages/cli build");
    expect(publishJob).not.toContain("working-directory: packages/cli");
    expect(publishJob).not.toContain("npm publish --access public");
    expect(publishJob.match(/^\s+npm publish /gm)).toHaveLength(1);

    expect(workflow).toContain(
      "--define \"process.env.PUSHPALS_CLI_PACKAGE_VERSION='${{ needs.meta.outputs.version }}'\"",
    );
    expect(workflow).toContain("bun run scripts/release-cli-version-smoke.ts");
    expect(workflow).toContain('--expected-version "${{ needs.meta.outputs.version }}"');
    expect(workflow).toContain("--timeout-ms 60000");
    expect(workflow).toContain("runs_on: macos-15-intel");
    expect(workflow).toContain("runs_on: macos-15");

    expect(publishReleaseJob).toContain("name: pushpals-linux-x64");
    expect(publishReleaseJob).toContain("name: pushpals-windows-x64.exe");
    expect(publishReleaseJob).toContain("name: pushpals-macos-x64");
    expect(publishReleaseJob).toContain("name: pushpals-macos-arm64");
    expect(publishReleaseJob).toContain("pattern: runtime-*");
    expect(publishReleaseJob.match(/uses: actions\/download-artifact@v8/g)).toHaveLength(5);
    expect(publishReleaseJob).not.toContain("name: pushpals-cli-package-");
    expect(publishReleaseJob).not.toContain("- name: Download binaries");

    expect(reliabilityInstallIndex).toBeGreaterThanOrEqual(0);
    expect(reliabilityProtocolBuildIndex).toBeGreaterThan(reliabilityInstallIndex);
    expect(workflow).toContain('PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION: "1"');
    expect(workflow).toContain('PUSHPALS_RUN_CONTAINER_VOLUME_INTEGRATION: "1"');
    expect(workflow).not.toContain('PUSHPALS_RUN_WINDOWS_LINUX_CONTAINER_INTEGRATION: "1"');
    expect(checksumIndex).toBeGreaterThanOrEqual(0);
    expect(verifyReleaseIndex).toBeGreaterThan(checksumIndex);
    expect(createReleaseIndex).toBeGreaterThan(verifyReleaseIndex);
    expect(workflow).toContain("bun run cli:verify-package-payload");
    expect(workflow).toContain(
      "bun run scripts/verify-cli-package-payload.ts --skip-package --release-dir dist",
    );
  });
});
