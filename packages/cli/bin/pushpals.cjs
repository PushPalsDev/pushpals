#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const bundledCliPath = resolve(__dirname, "..", "dist", "pushpals-cli.js");
const packageJsonPath = resolve(__dirname, "..", "package.json");
const releaseUrl = "https://github.com/PushPalsDev/pushpals/releases";
const DEFAULT_BUN_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
const BUN_PROBE_TIMEOUT_ENV = "PUSHPALS_BUN_PROBE_TIMEOUT_MS";
const BOOTSTRAP_TIMEOUT_ENV = "PUSHPALS_CLI_BOOTSTRAP_TIMEOUT_MS";
const BOOTSTRAP_READY_MARKER_ENV = "PUSHPALS_CLI_READY_MARKER";
let packageVersion = "";
let readyMarkerPath = "";
if (existsSync(packageJsonPath)) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageVersion = String(parsed?.version ?? "").trim();
  } catch {
    packageVersion = "";
  }
}

function fail(lines) {
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(1);
}

function parseBoundedTimeoutMs(envName, defaultValue, maxValue) {
  const raw = String(process.env[envName] ?? "").trim();
  if (raw === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.max(1_000, Math.min(maxValue, parsed));
}

function parseBunProbeTimeoutMs() {
  return parseBoundedTimeoutMs(BUN_PROBE_TIMEOUT_ENV, DEFAULT_BUN_PROBE_TIMEOUT_MS, 60 * 1000);
}

function parseBootstrapTimeoutMs() {
  return parseBoundedTimeoutMs(
    BOOTSTRAP_TIMEOUT_ENV,
    DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    30 * 60 * 1000,
  );
}

function createReadyMarkerPath() {
  const root = join(tmpdir(), "pushpals-cli-ready");
  mkdirSync(root, { recursive: true });
  return join(root, `ready-${process.pid}-${Date.now()}.txt`);
}

function killChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      return;
    }
    child.kill("SIGKILL");
  } catch {
    // best-effort watchdog cleanup only
  }
}

if (!existsSync(bundledCliPath)) {
  fail([
    "[pushpals] CLI bundle is missing in this package install.",
    "[pushpals] Reinstall @pushpalsdev/cli, or download a direct binary from:",
    `[pushpals] ${releaseUrl}`,
  ]);
}

function probeBunRuntime() {
  const timeout = parseBunProbeTimeoutMs();
  const options = { stdio: "ignore", timeout };
  const result = spawnSync("bun", ["--version"], options);
  return {
    ok: result.status === 0,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
  };
}

const bunRuntime = probeBunRuntime();
if (!bunRuntime.ok) {
  if (bunRuntime.timedOut) {
    fail([
      `[pushpals] Bun runtime probe timed out after ${parseBunProbeTimeoutMs()}ms.`,
      "[pushpals] This usually means the Bun process wedged during startup; the CLI refused to continue so it does not freeze the shell.",
      `[pushpals] Set ${BUN_PROBE_TIMEOUT_ENV}=0 to disable this probe timeout, or use a direct binary release:`,
      `[pushpals] ${releaseUrl}`,
    ]);
  }
  fail([
    "[pushpals] Bun runtime is required for the npm package entrypoint.",
    "[pushpals] Install Bun from https://bun.sh, or use a direct binary release:",
    `[pushpals] ${releaseUrl}`,
  ]);
}

function spawnBunCli() {
  readyMarkerPath = process.env[BOOTSTRAP_READY_MARKER_ENV] || createReadyMarkerPath();
  const childEnv = {
    ...process.env,
    PUSHPALS_CLI_PACKAGE_VERSION: packageVersion || process.env.PUSHPALS_CLI_PACKAGE_VERSION || "",
    [BOOTSTRAP_READY_MARKER_ENV]: readyMarkerPath,
  };

  if (process.platform === "win32") {
    const quoteWindows = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
    const commandLine = [
      "bun",
      quoteWindows(bundledCliPath),
      ...process.argv.slice(2).map(quoteWindows),
    ].join(" ");
    return spawn(commandLine, {
      shell: true,
      stdio: "inherit",
      env: childEnv,
    });
  }
  return spawn("bun", [bundledCliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: childEnv,
  });
}

const child = spawnBunCli();
const bootstrapTimeoutMs = parseBootstrapTimeoutMs();
let watchdogTimer = null;
let markerPollTimer = null;
let watchdogFired = false;
let parentSignalExit = false;

function cleanupReadyMarker() {
  if (!readyMarkerPath) return;
  try {
    rmSync(readyMarkerPath, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

function clearBootstrapWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  if (markerPollTimer) {
    clearInterval(markerPollTimer);
    markerPollTimer = null;
  }
}

if (bootstrapTimeoutMs > 0) {
  markerPollTimer = setInterval(() => {
    if (readyMarkerPath && existsSync(readyMarkerPath)) {
      clearBootstrapWatchdog();
    }
  }, 1_000);
  watchdogTimer = setTimeout(() => {
    if (readyMarkerPath && existsSync(readyMarkerPath)) {
      clearBootstrapWatchdog();
      return;
    }
    watchdogFired = true;
    process.stderr.write(
      `[pushpals] Bun runtime did not finish CLI bootstrap within ${bootstrapTimeoutMs}ms; terminating Bun process tree. ` +
        `Set ${BOOTSTRAP_TIMEOUT_ENV}=0 to disable this watchdog.\n`,
    );
    killChildTree(child);
  }, bootstrapTimeoutMs);
}

function terminateChildAndExit(signal) {
  if (parentSignalExit) return;
  parentSignalExit = true;
  clearBootstrapWatchdog();
  killChildTree(child);
  cleanupReadyMarker();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => terminateChildAndExit("SIGINT"));
process.once("SIGTERM", () => terminateChildAndExit("SIGTERM"));

child.on("error", (err) => {
  clearBootstrapWatchdog();
  cleanupReadyMarker();
  fail([`[pushpals] Failed to launch Bun runtime: ${String(err?.message ?? err)}`]);
});

child.on("exit", (code, signal) => {
  clearBootstrapWatchdog();
  cleanupReadyMarker();
  if (watchdogFired) {
    process.exit(124);
    return;
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
