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
  [source.configsDir, join(outDir, "configs")],
  [source.promptsDir, join(outDir, "prompts")],
  [source.protocolSchemasDir, join(outDir, "protocol", "schemas")],
  [source.configsDir, join(outDir, "sandbox", "configs")],
  [join(source.promptsDir, "workerpals"), join(outDir, "sandbox", "prompts", "workerpals")],
  [source.protocolSchemasDir, join(outDir, "sandbox", "protocol", "schemas")],
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

for (const [fromPath, toPath] of trackedSandboxCopyPairs) {
  copyTrackedRepoPath(repoRoot, fromPath, toPath, true);
}

if (existsSync(join(repoRoot, "bun.lock"))) {
  copyTrackedRepoPath(repoRoot, "bun.lock", join(outDir, "sandbox", "bun.lock"), true);
}

const remoteBuddyFallbackBundlePath = join(outDir, "sandbox", ".pushpals-remotebuddy-fallback.js");
const remoteBuddyFallbackBuild = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "apps/remotebuddy/src/remotebuddy_main.ts",
    "--target=bun",
    `--outfile=${remoteBuddyFallbackBundlePath}`,
  ],
  {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (remoteBuddyFallbackBuild.exitCode !== 0 || !existsSync(remoteBuddyFallbackBundlePath)) {
  const stdout = Buffer.from(remoteBuddyFallbackBuild.stdout ?? [])
    .toString("utf8")
    .trim();
  const stderr = Buffer.from(remoteBuddyFallbackBuild.stderr ?? [])
    .toString("utf8")
    .trim();
  const detail = [stdout, stderr].filter(Boolean).join("\n");
  console.error(
    "[cli-runtime-assets] Failed to build bundled RemoteBuddy fallback asset." +
      (detail ? `\n${detail}` : ""),
  );
  process.exit(1);
}

console.log(`[cli-runtime-assets] Synced runtime assets into ${outDir}`);
