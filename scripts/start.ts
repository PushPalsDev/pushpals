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
const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").toLowerCase());
}

async function runQuiet(cmd: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

async function runInherited(cmd: string[], cwd?: string): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

async function ensureGitHubAuth(): Promise<void> {
  const skipCheck = envTruthy("PUSHPALS_SKIP_GH_AUTH_CHECK");
  const serialPusherPushDisabled = envTruthy("SERIAL_PUSHER_NO_PUSH");
  if (skipCheck || serialPusherPushDisabled) {
    return;
  }

  const gitToken =
    process.env.PUSHPALS_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  if (gitToken) {
    // Token auth is enough for serial-pusher git push; no `gh` required.
    process.env.PUSHPALS_GIT_TOKEN = gitToken;
    return;
  }

  const ghAvailable = (await runQuiet(["gh", "--version"])) === 0;
  if (ghAvailable) {
    const ghAuthed = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (ghAuthed) return;

    console.log("[start] GitHub CLI is not authenticated. Starting `gh auth login`...");
    const loginExitCode = await runInherited(["gh", "auth", "login"]);
    if (loginExitCode !== 0) {
      console.error("[start] `gh auth login` failed.");
      process.exit(loginExitCode);
    }

    const ghAuthedAfterLogin = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (!ghAuthedAfterLogin) {
      console.error("[start] GitHub CLI is still not authenticated after login.");
      process.exit(1);
    }
    return;
  }

  console.error("[start] Serial pusher push is enabled but no GitHub auth is configured.");
  console.error("[start] Provide one of: PUSHPALS_GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN.");
  console.error(
    "[start] Or install GitHub CLI (`gh`) for interactive login, or disable push via SERIAL_PUSHER_NO_PUSH=1.",
  );
  process.exit(1);
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

await ensureGitHubAuth();
await ensureDockerImage();

const proc = Bun.spawn(["bun", "run", "dev:full"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
process.exit(exitCode);
