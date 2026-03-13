#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolveBundledRuntimeAssetSource } from "./pushpals-cli.ts";

const repoRoot = resolve(import.meta.dir, "..");
const outDir = join(repoRoot, "packages", "cli", "runtime");

const source = resolveBundledRuntimeAssetSource();
if (!source) {
  console.error("[cli-runtime-assets] Could not locate source runtime assets.");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copyPairs: Array<[string, string]> = [
  [source.envExamplePath, join(outDir, ".env.example")],
  [source.visionExamplePath, join(outDir, "vision.example.md")],
  [source.configsDir, join(outDir, "configs")],
  [source.promptsDir, join(outDir, "prompts")],
  [source.protocolSchemasDir, join(outDir, "protocol", "schemas")],
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

console.log(`[cli-runtime-assets] Synced runtime assets into ${outDir}`);
