#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const bundledCliPath = resolve(__dirname, "..", "dist", "pushpals-cli.js");
const packageJsonPath = resolve(__dirname, "..", "package.json");
const releaseUrl = "https://github.com/PushPalsDev/pushpals/releases";
const DEFAULT_BUN_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
const BUN_PROBE_TIMEOUT_ENV = "PUSHPALS_BUN_PROBE_TIMEOUT_MS";
const BOOTSTRAP_TIMEOUT_ENV = "PUSHPALS_CLI_BOOTSTRAP_TIMEOUT_MS";
const BOOTSTRAP_READY_MARKER_ENV = "PUSHPALS_CLI_READY_MARKER";
let packageVersion = "";
let minimumBunVersion = "1.3.14";
let readyMarkerPath = "";
let resolvedBunCommand = "";
if (existsSync(packageJsonPath)) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageVersion = String(parsed?.version ?? "").trim();
    const engineFloor = String(parsed?.engines?.bun ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
    if (engineFloor) minimumBunVersion = engineFloor[0];
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
  return parseBoundedTimeoutMs(BOOTSTRAP_TIMEOUT_ENV, DEFAULT_BOOTSTRAP_TIMEOUT_MS, 30 * 60 * 1000);
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

function resolveWindowsBunCommand() {
  try {
    const where = spawnSync("where.exe", ["bun"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (where.status !== 0) return "bun";
    const candidates = String(where.stdout ?? "")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (lower.endsWith(".exe") && existsSync(candidate)) return candidate;

      // Bun installed through npm/nvm on Windows commonly exposes shell shims:
      //   <node-dir>\bun
      //   <node-dir>\bun.cmd
      // Those shims delegate to <node-dir>\node_modules\bun\bin\bun.exe.
      const shimTarget = join(dirname(candidate), "node_modules", "bun", "bin", "bun.exe");
      if (existsSync(shimTarget)) return shimTarget;
    }
  } catch {
    // Fall back to PATH/shell command resolution below.
  }
  return "bun";
}

function resolveBunCommand() {
  if (resolvedBunCommand) return resolvedBunCommand;
  resolvedBunCommand = process.platform === "win32" ? resolveWindowsBunCommand() : "bun";
  return resolvedBunCommand;
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
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout };
  const result = spawnSync(resolveBunCommand(), ["--version"], options);
  const version = String(result.stdout ?? "").trim();
  return {
    ok: result.status === 0,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    version,
  };
}

function parseVersion(value) {
  const match = String(value ?? "")
    .trim()
    .match(/v?(\d+)\.(\d+)\.(\d+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(actualValue, minimumValue) {
  const actual = parseVersion(actualValue);
  const minimum = parseVersion(minimumValue);
  if (!actual || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
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
if (!versionAtLeast(bunRuntime.version, minimumBunVersion)) {
  fail([
    `[pushpals] Unsupported Bun runtime ${bunRuntime.version || "unknown"}; this PushPals package requires Bun ${minimumBunVersion} or newer.`,
    `[pushpals] For npm-managed Bun, run: npm install -g bun@${minimumBunVersion}`,
    "[pushpals] PushPals refused to launch an incompatible runtime so it cannot crash-loop or freeze the shell.",
  ]);
}

function spawnBunCli() {
  readyMarkerPath = process.env[BOOTSTRAP_READY_MARKER_ENV] || createReadyMarkerPath();
  const childEnv = {
    ...process.env,
    PUSHPALS_CLI_PACKAGE_VERSION: packageVersion || process.env.PUSHPALS_CLI_PACKAGE_VERSION || "",
    [BOOTSTRAP_READY_MARKER_ENV]: readyMarkerPath,
  };

  const bunCommand = resolveBunCommand();
  if (process.platform === "win32" && bunCommand === "bun") {
    const quoteWindows = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
    const commandLine = [
      bunCommand,
      quoteWindows(bundledCliPath),
      ...process.argv.slice(2).map(quoteWindows),
    ].join(" ");
    return spawn(commandLine, {
      shell: true,
      stdio: "inherit",
      env: childEnv,
    });
  }
  return spawn(bunCommand, [bundledCliPath, ...process.argv.slice(2)], {
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
