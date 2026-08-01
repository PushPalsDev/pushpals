#!/usr/bin/env bun
// @bun

// scripts/runtime-launch-trampoline.ts
var READY_PREFIX = "[pushpals-launch-trampoline] child-started";
var separatorIndex = process.argv.indexOf("--", 2);
var command = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : process.argv.slice(2);
if (command.length === 0) {
  console.error("[pushpals-launch-trampoline] missing child command after --");
  process.exit(64);
}
var child = null;
var stopping = false;
async function stopChild(signal) {
  if (stopping)
    return;
  stopping = true;
  if (child) {
    try {
      child.kill(signal);
    } catch {}
    await Promise.race([child.exited.catch(() => 0), Bun.sleep(2000)]);
    try {
      child.kill("SIGKILL");
    } catch {}
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
    stderr: "inherit"
  });
} catch (error) {
  console.error(`[pushpals-launch-trampoline] child launch failed: ${String(error)}`);
  process.exit(70);
}
console.log(`${READY_PREFIX} pid=${child.pid ?? "unknown"}`);
var exitCode = await child.exited;
process.exit(Number.isFinite(exitCode) ? exitCode : 1);
