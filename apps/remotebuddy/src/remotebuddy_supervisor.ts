#!/usr/bin/env bun

import { loadPushPalsConfig, terminateProcessTree } from "shared";

const CONFIG = loadPushPalsConfig();
const restartEnabled = CONFIG.remotebuddy.crashRestartEnabled;
const maxRestarts = Math.max(0, CONFIG.remotebuddy.crashRestartMaxRestarts);
const restartBackoffMs = Math.max(0, CONFIG.remotebuddy.crashRestartBackoffMs);
const bunExecPath = (process.execPath ?? "").trim() || "bun";
const command = [bunExecPath, "run", "src/remotebuddy_main.ts"];

let activeChild: ReturnType<typeof Bun.spawn> | null = null;
let shuttingDown = false;

function requestShutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const child = activeChild;
  void (async () => {
    if (child) {
      await terminateProcessTree(child, {
        terminationTimeoutMs: 5_000,
        exitGraceMs: 2_000,
      });
    }
  })().finally(() => process.exit(exitCode));
}

process.on("SIGINT", () => requestShutdown(130));
process.on("SIGTERM", () => requestShutdown(143));

function shouldAttemptRestart(exitCode: number): boolean {
  if (shuttingDown) return false;
  if (!restartEnabled) return false;
  if (exitCode === 0) return false;
  if (exitCode === 130 || exitCode === 143) return false;
  return true;
}

async function run(): Promise<never> {
  if (restartEnabled) {
    console.log(
      `[RemoteBuddySupervisor] Crash restart enabled (max_restarts=${maxRestarts}, backoff_ms=${restartBackoffMs}).`,
    );
  } else {
    console.log("[RemoteBuddySupervisor] Crash restart disabled.");
  }

  let restartCount = 0;
  while (true) {
    activeChild = Bun.spawn(command, {
      cwd: process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
      detached: process.platform !== "win32",
    });

    const exitCode = await activeChild.exited;
    activeChild = null;

    if (!shouldAttemptRestart(exitCode)) {
      if (shuttingDown) {
        await new Promise<never>(() => undefined);
      }
      process.exit(exitCode);
    }

    if (restartCount >= maxRestarts) {
      console.error(
        `[RemoteBuddySupervisor] RemoteBuddy exited with code ${exitCode}; restart limit reached (${restartCount}/${maxRestarts}).`,
      );
      process.exit(exitCode);
    }

    restartCount += 1;
    console.warn(
      `[RemoteBuddySupervisor] RemoteBuddy exited with code ${exitCode}; restarting (${restartCount}/${maxRestarts}) in ${restartBackoffMs}ms.`,
    );
    if (restartBackoffMs > 0) {
      await Bun.sleep(restartBackoffMs);
    }
  }
}

run().catch((err) => {
  console.error(`[RemoteBuddySupervisor] Fatal: ${String(err)}`);
  process.exit(1);
});
