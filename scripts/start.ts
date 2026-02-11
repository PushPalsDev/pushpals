#!/usr/bin/env bun
/**
 * Stable start entrypoint.
 *
 * `bun run start` can be invoked with accidental extra CLI flags (e.g. `-c`)
 * from shells/aliases. This wrapper intentionally ignores forwarded args and
 * always launches `dev:full` with the canonical script options.
 *
 * It also ensures the worker Docker image exists before launching the stack.
 */

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const DEFAULT_IMAGE = "pushpals-worker-sandbox:latest";
const workerImage = process.env.WORKER_DOCKER_IMAGE ?? DEFAULT_IMAGE;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

async function runQuiet(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

async function runInherited(cmd: string[], cwd?: string): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function ensureDockerImage(): Promise<void> {
  const dockerAvailable = (await runQuiet(["docker", "version"])) === 0;
  if (!dockerAvailable) {
    console.error("[start] Docker is required for `bun run start` but is not available.");
    process.exit(1);
  }

  const imageExists = (await runQuiet(["docker", "image", "inspect", workerImage])) === 0;
  if (imageExists) return;

  console.log(`[start] Worker image not found: ${workerImage}`);
  console.log("[start] Building worker image...");

  const buildExitCode = await runInherited(
    ["docker", "build", "-f", "apps/worker/Dockerfile.sandbox", "-t", workerImage, "."],
    repoRoot,
  );

  if (buildExitCode !== 0) {
    console.error(`[start] Failed to build worker image (${workerImage}).`);
    process.exit(buildExitCode);
  }
}

await ensureDockerImage();

const proc = Bun.spawn(["bun", "run", "dev:full"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
process.exit(exitCode);
