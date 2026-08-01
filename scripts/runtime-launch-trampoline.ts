#!/usr/bin/env bun

const READY_PREFIX = "[pushpals-launch-trampoline] child-started";
const separatorIndex = process.argv.indexOf("--", 2);
// Bun consumes the conventional `--` separator before populating process.argv,
// while bundled executables may preserve it. Support both forms.
const command =
  separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);

if (command.length === 0) {
  console.error("[pushpals-launch-trampoline] missing child command after --");
  process.exit(64);
}

let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;

async function stopChild(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (child) {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
    await Promise.race([child.exited.catch(() => 0), Bun.sleep(2_000)]);
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort final termination only.
    }
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGTERM", () => void stopChild("SIGTERM"));
process.on("SIGINT", () => void stopChild("SIGINT"));

try {
  child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
} catch (error) {
  console.error(`[pushpals-launch-trampoline] child launch failed: ${String(error)}`);
  process.exit(70);
}

console.log(`${READY_PREFIX} pid=${child.pid ?? "unknown"}`);
const exitCode = await child.exited;
process.exit(Number.isFinite(exitCode) ? exitCode : 1);
