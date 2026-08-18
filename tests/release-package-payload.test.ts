import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  findDisallowedCliPackageEntries,
  findDisallowedReleaseArtifactEntries,
} from "../scripts/verify-cli-package-payload.ts";

const repoRoot = resolve(import.meta.dir, "..");
const verifierScript = join(repoRoot, "scripts", "verify-cli-package-payload.ts");
const windowsSourceRuntimeAssets = [
  ".pushpals-server-runtime.js",
  ".pushpals-localbuddy-runtime.js",
  ".pushpals-remotebuddy-fallback.js",
  ".pushpals-workerpals-runtime.js",
  ".pushpals-source-control-manager-runtime.js",
  ".pushpals-runtime-launch-trampoline.js",
];
const requiredRuntimePayloadEntries = windowsSourceRuntimeAssets.map((asset) => ({
  path: `runtime/sandbox/${asset}`,
}));
const requiredSandboxPromptEntries = [
  "runtime/sandbox/prompts/review_agent/reviewer.md",
  "runtime/sandbox/prompts/workerpals/task_quality_critic_system_prompt.md",
  "runtime/sandbox/prompts/workerpals/task_quality_critic_user_prompt.md",
].map((path) => ({ path }));

function requiredCliPackageFiles() {
  return [
    { path: "bin/pushpals.cjs", mode: 0o755 },
    { path: "dist/pushpals-cli.js", mode: 0o755 },
    ...requiredRuntimePayloadEntries,
    ...requiredSandboxPromptEntries,
  ];
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
    writeFileSync(join(packageDir, "bin", "pushpals.cjs"), "console.log('fixture');\n", "utf8");
    writeFileSync(join(packageDir, "dist", "pushpals-cli.js"), "export {};\n", "utf8");
    for (const asset of windowsSourceRuntimeAssets) {
      writeFileSync(join(packageDir, "runtime", "sandbox", asset), "export {};\n", "utf8");
    }
    for (const prompt of requiredSandboxPromptEntries) {
      const promptPath = join(packageDir, prompt.path);
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, "# fixture prompt\n", "utf8");
    }
    return fn(packageDir);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
}

function runVerifier(args: string[]) {
  return spawnSync(process.execPath, ["run", verifierScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("release package payload verification", () => {
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

  test("allows the expected CLI package payload shape without vendored tool binaries", () => {
    const issues = findDisallowedCliPackageEntries([
      { path: "README.md" },
      { path: "bin/pushpals.cjs", mode: 0o755 },
      { path: "dist/pushpals-cli.js", mode: 0o755 },
      { path: "runtime/configs/default.toml" },
      ...windowsSourceRuntimeAssets.map((asset) => ({
        path: `runtime/sandbox/${asset}`,
        mode: 0o755,
      })),
      ...requiredSandboxPromptEntries,
      { path: "runtime/sandbox/bun.lock" },
      { path: "runtime/sandbox/apps/workerpals/uv.lock" },
      {
        path: "monitor-ui/assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf",
      },
    ]);

    expect(issues).toEqual([]);
  });

  test("rejects external toolchain binaries and runtime dependency directories", () => {
    const issues = findDisallowedCliPackageEntries([
      { path: "bin/pushpals.cjs" },
      { path: "dist/pushpals-cli.js" },
      ...requiredRuntimePayloadEntries,
      ...requiredSandboxPromptEntries,
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
      { path: "bin\\pushpals.cjs" },
      { path: "dist\\pushpals-cli.js" },
      ...windowsSourceRuntimeAssets.map((asset) => ({
        path: `runtime\\sandbox\\${asset}`,
      })),
      ...requiredSandboxPromptEntries.map((entry) => ({
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

    expect(issues.map((issue) => issue.path)).toEqual([
      "bin/pushpals.cjs",
      "dist/pushpals-cli.js",
      ...windowsSourceRuntimeAssets.map((asset) => `runtime/sandbox/${asset}`),
      ...requiredSandboxPromptEntries.map((entry) => entry.path),
    ]);
    expect(issues.every((issue) => issue.reason === "required CLI package entry is missing")).toBe(
      true,
    );
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

  test("script succeeds against a clean packed package fixture", () => {
    withTempPackage((packageDir) => {
      const result = runVerifier(["--package-dir", packageDir]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("verified npm package payload");
      expect(result.stderr).toBe("");
    });
  });

  test("script fails against a package fixture that would ship Bun", () => {
    withTempPackage((packageDir) => {
      mkdirSync(join(packageDir, "runtime", "bin"), { recursive: true });
      writeFileSync(join(packageDir, "runtime", "bin", "bun.exe"), "not really bun\n", "utf8");

      const result = runVerifier(["--package-dir", packageDir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("runtime/bin/bun.exe");
      expect(result.stderr).toContain("external toolchain");
    });
  });

  test("release workflow verifies package payload before npm publish and artifacts before upload", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release-cli.yml"),
      "utf8",
    );

    const buildPackageIndex = workflow.indexOf("Build CLI package payload");
    const reliabilityJobIndex = workflow.indexOf("reliability_contract:");
    const publishJobIndex = workflow.indexOf("publish_npm:");
    const verifyPackageIndex = workflow.indexOf(
      "Verify CLI package payload excludes external toolchains",
    );
    const publishIndex = workflow.indexOf("Publish to npm");
    const checksumIndex = workflow.indexOf("Generate checksums");
    const verifyReleaseIndex = workflow.indexOf(
      "Verify GitHub release assets exclude external tool artifacts",
    );
    const createReleaseIndex = workflow.indexOf("Create GitHub release (release log)");
    const reliabilityJob = workflow.slice(reliabilityJobIndex, publishJobIndex);
    const reliabilityInstallIndex = reliabilityJob.indexOf("bun install --frozen-lockfile");
    const reliabilityProtocolBuildIndex = reliabilityJob.indexOf("bun run protocol:build");
    const reliabilityHarnessIndex = reliabilityJob.indexOf("bun run harness:reliability");

    expect(buildPackageIndex).toBeGreaterThanOrEqual(0);
    expect(reliabilityJobIndex).toBeGreaterThanOrEqual(0);
    expect(publishJobIndex).toBeGreaterThan(reliabilityJobIndex);
    expect(workflow).toContain("- reliability_contract");
    expect(reliabilityInstallIndex).toBeGreaterThanOrEqual(0);
    expect(reliabilityProtocolBuildIndex).toBeGreaterThan(reliabilityInstallIndex);
    expect(reliabilityHarnessIndex).toBeGreaterThan(reliabilityProtocolBuildIndex);
    expect(workflow).toContain('PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION: "1"');
    expect(workflow).toContain('PUSHPALS_RUN_CONTAINER_VOLUME_INTEGRATION: "1"');
    expect(workflow).not.toContain('PUSHPALS_RUN_WINDOWS_LINUX_CONTAINER_INTEGRATION: "1"');
    expect(verifyPackageIndex).toBeGreaterThan(buildPackageIndex);
    expect(publishIndex).toBeGreaterThan(verifyPackageIndex);
    expect(checksumIndex).toBeGreaterThanOrEqual(0);
    expect(verifyReleaseIndex).toBeGreaterThan(checksumIndex);
    expect(createReleaseIndex).toBeGreaterThan(verifyReleaseIndex);
    expect(workflow).toContain("bun run cli:verify-package-payload");
    expect(workflow).toContain(
      "bun run scripts/verify-cli-package-payload.ts --skip-package --release-dir dist",
    );
  });
});
