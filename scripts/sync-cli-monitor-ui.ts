#!/usr/bin/env bun

import { mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";

const repoRoot = resolve(import.meta.dir, "..");
const clientRoot = join(repoRoot, "apps", "client");
const outDir = join(repoRoot, "packages", "cli", "monitor-ui");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const proc = Bun.spawnSync(
  [process.execPath, "x", "expo", "export", "--platform", "web", "--output-dir", outDir],
  {
    cwd: clientRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode || 1);
}

console.log(`[cli-monitor-ui] Exported client web monitor into ${outDir}`);
