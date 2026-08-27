#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { copyTrackedRepoPath, resolveBundledRuntimeAssetSource } from "./pushpals-cli.ts";

const repoRoot = resolve(import.meta.dir, "..");
const outDir = join(repoRoot, "packages", "cli", "runtime");

async function removeTreeWithRetries(pathValue: string, attempts = 8): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(pathValue, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
}

const source = resolveBundledRuntimeAssetSource();
if (!source) {
  console.error("[cli-runtime-assets] Could not locate source runtime assets.");
  process.exit(1);
}

await removeTreeWithRetries(outDir);
mkdirSync(outDir, { recursive: true });

const copyPairs: Array<[string, string]> = [
  [source.envExamplePath, join(outDir, ".env.example")],
  [source.visionExamplePath, join(outDir, "vision.example.md")],
  [source.promptsDir, join(outDir, "prompts")],
  [source.protocolSchemasDir, join(outDir, "protocol", "schemas")],
  // The containerized quality gate also consumes shared review-agent prompts.
  // Copy the complete prompt contract rather than maintaining a fragile list.
  [source.promptsDir, join(outDir, "sandbox", "prompts")],
  [source.protocolSchemasDir, join(outDir, "sandbox", "protocol", "schemas")],
  // Keep newly introduced runtime primitives available during pre-commit
  // package validation; the tracked-tree copy below cannot see new files yet.
  [
    join(repoRoot, "packages", "shared", "src", "bounded_fetch.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "bounded_fetch.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "bounded_process.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "bounded_process.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "validation_repair_lease.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "validation_repair_lease.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "repo_validation.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "repo_validation.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "memory.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "memory.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "repository_agent.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "repository_agent.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "repository_identity.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "repository_identity.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "repository_snapshot.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "repository_snapshot.ts"),
  ],
  [
    join(repoRoot, "packages", "shared", "src", "scm_repair_authority.ts"),
    join(outDir, "sandbox", "packages", "shared", "src", "scm_repair_authority.ts"),
  ],
];
const trackedSandboxCopyPairs: Array<[string, string]> = [
  ["package.json", join(outDir, "sandbox", "package.json")],
  ["apps/workerpals", join(outDir, "sandbox", "apps", "workerpals")],
  ["packages/shared", join(outDir, "sandbox", "packages", "shared")],
  ["packages/protocol", join(outDir, "sandbox", "packages", "protocol")],
];

for (const [fromPath, toPath] of copyPairs) {
  if (!existsSync(fromPath)) {
    console.error(`[cli-runtime-assets] Missing source asset: ${fromPath}`);
    process.exit(1);
  }
}

for (const [fromPath, toPath] of copyPairs) {
  mkdirSync(dirname(toPath), { recursive: true });
  cpSync(fromPath, toPath, {
    recursive: true,
    force: true,
  });
}

// Runtime packages must never inherit ignored developer overrides such as
// configs/local.toml. npm includes untracked files under a package's `files`
// directories, so copy the committed config surface explicitly.
for (const destination of [join(outDir, "configs"), join(outDir, "sandbox", "configs")]) {
  copyTrackedRepoPath(repoRoot, "configs", destination, true);
}

for (const [fromPath, toPath] of trackedSandboxCopyPairs) {
  copyTrackedRepoPath(repoRoot, fromPath, toPath, true);
}

if (existsSync(join(repoRoot, "bun.lock"))) {
  copyTrackedRepoPath(repoRoot, "bun.lock", join(outDir, "sandbox", "bun.lock"), true);
}

const bundledWindowsRuntimeEntrypoints = [
  {
    label: "server",
    sourcePath: "apps/server/src/server_main.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-server-runtime.js"),
  },
  {
    label: "LocalBuddy",
    sourcePath: "apps/localbuddy/src/localbuddy_main.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-localbuddy-runtime.js"),
  },
  {
    label: "RemoteBuddy",
    sourcePath: "apps/remotebuddy/src/remotebuddy_main.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-remotebuddy-fallback.js"),
  },
  {
    label: "WorkerPal",
    sourcePath: "apps/workerpals/src/workerpals_main.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-workerpals-runtime.js"),
  },
  {
    label: "SourceControlManager",
    sourcePath: "apps/source_control_manager/src/source_control_manager_main.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-source-control-manager-runtime.js"),
  },
  {
    label: "runtime launch trampoline",
    sourcePath: "scripts/runtime-launch-trampoline.ts",
    outputPath: join(outDir, "sandbox", ".pushpals-runtime-launch-trampoline.js"),
  },
] as const;

for (const asset of bundledWindowsRuntimeEntrypoints) {
  const build = Bun.spawnSync(
    [process.execPath, "build", asset.sourcePath, "--target=bun", `--outfile=${asset.outputPath}`],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode === 0 && existsSync(asset.outputPath)) continue;

  const stdout = Buffer.from(build.stdout ?? [])
    .toString("utf8")
    .trim();
  const stderr = Buffer.from(build.stderr ?? [])
    .toString("utf8")
    .trim();
  const detail = [stdout, stderr].filter(Boolean).join("\n");
  console.error(
    `[cli-runtime-assets] Failed to build bundled ${asset.label} asset.` +
      (detail ? `\n${detail}` : ""),
  );
  process.exit(1);
}

console.log(`[cli-runtime-assets] Synced runtime assets into ${outDir}`);
