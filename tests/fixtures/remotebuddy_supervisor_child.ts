#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { bootstrapRuntime } from "../../packages/shared/src/runtime";
import { loadPushPalsConfig } from "../../packages/shared/src/config";

const logPath = process.env.REMOTEBUDDY_SUPERVISOR_CHILD_LOG;
const counterPath = process.env.REMOTEBUDDY_SUPERVISOR_CHILD_COUNTER;
const failUntil = Number(process.env.REMOTEBUDDY_SUPERVISOR_CHILD_FAILS ?? "0");

if (!logPath || !counterPath) {
  console.error("Missing log/counter paths for supervisor child test harness.");
  process.exit(64);
}

async function main(): Promise<void> {
  let attempt = 1;
  try {
    const current = parseInt(readFileSync(counterPath, "utf8"), 10);
    if (Number.isFinite(current)) {
      attempt = current + 1;
    }
  } catch {
    attempt = 1;
  }
  writeFileSync(counterPath, String(attempt));

  const runtime = await bootstrapRuntime({
    config: loadPushPalsConfig(),
    argv: process.argv.slice(2),
    ensureSession: false,
  });

  const payload = JSON.stringify({
    attempt,
    args: process.argv.slice(2),
    runtime: {
      server: runtime.runtime.server,
      sessionId: runtime.runtime.sessionId,
      authToken: runtime.runtime.authToken,
      rest: runtime.runtime.rest,
    },
  });
  appendFileSync(logPath, `${payload}\n`, "utf8");

  if (attempt <= failUntil) {
    process.exit(86);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[SupervisorChild] Fatal:", err);
    process.exit(1);
  },
);
