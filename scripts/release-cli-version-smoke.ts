#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { assertCliVersionCommand } from "./release-installed-cli-smoke.ts";

let binaryPath = "";
let expectedVersion = "";
let timeoutMs = 30_000;

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--binary") {
    binaryPath = String(process.argv[++index] ?? "").trim();
    continue;
  }
  if (arg === "--expected-version") {
    expectedVersion = String(process.argv[++index] ?? "").trim();
    continue;
  }
  if (arg === "--timeout-ms") {
    timeoutMs = Math.max(
      1_000,
      Number.parseInt(String(process.argv[++index] ?? "30000"), 10) || 30_000,
    );
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!binaryPath) throw new Error("--binary is required");
if (!expectedVersion) throw new Error("--expected-version is required");

const isolatedCwd = mkdtempSync(join(tmpdir(), "pushpals-version-smoke-"));
try {
  const output = await assertCliVersionCommand({
    command: [resolve(binaryPath)],
    cwd: isolatedCwd,
    env: process.env as Record<string, string | undefined>,
    expectedVersion,
    timeoutMs,
    label: "Standalone pushpals --version",
  });
  process.stdout.write(output);
} finally {
  rmSync(isolatedCwd, { recursive: true, force: true });
}
