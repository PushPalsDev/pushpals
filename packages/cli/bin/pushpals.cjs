#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const bundledCliPath = resolve(__dirname, "..", "dist", "pushpals-cli.js");
const releaseUrl = "https://github.com/PushPalsDev/pushpals/releases";

function fail(lines) {
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(1);
}

if (!existsSync(bundledCliPath)) {
  fail([
    "[pushpals] CLI bundle is missing in this package install.",
    "[pushpals] Reinstall @pushpalsdev/cli, or download a direct binary from:",
    `[pushpals] ${releaseUrl}`,
  ]);
}

function hasBunRuntime() {
  if (process.platform === "win32") {
    const probe = spawnSync("bun --version", { shell: true, stdio: "ignore" });
    return probe.status === 0;
  }
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

if (!hasBunRuntime()) {
  fail([
    "[pushpals] Bun runtime is required for the npm package entrypoint.",
    "[pushpals] Install Bun from https://bun.sh, or use a direct binary release:",
    `[pushpals] ${releaseUrl}`,
  ]);
}

function spawnBunCli() {
  if (process.platform !== "win32") {
    return spawn("bun", [bundledCliPath, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
  }

  const quoteWindows = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const commandLine = [
    "bun",
    quoteWindows(bundledCliPath),
    ...process.argv.slice(2).map(quoteWindows),
  ].join(" ");
  return spawn(commandLine, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
}

const child = spawnBunCli();

child.on("error", (err) => {
  fail([`[pushpals] Failed to launch Bun runtime: ${String(err?.message ?? err)}`]);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
