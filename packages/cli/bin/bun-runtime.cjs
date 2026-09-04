"use strict";

const { win32: pathWin32 } = require("node:path");

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

function candidateKey(command) {
  return String(command).replace(/\//g, "\\").toLowerCase();
}

function buildBunVersionProbeInvocation(candidate) {
  if (candidate?.shell) {
    return {
      command: `${candidate.command} --version`,
      args: [],
      shell: true,
    };
  }
  return {
    command: String(candidate?.command ?? ""),
    args: ["--version"],
    shell: false,
  };
}

function enumerateWindowsBunCandidates(
  whereOutput,
  { explicitBunBin = "", pathExists = () => false } = {},
) {
  const explicit = String(explicitBunBin ?? "").trim();
  if (explicit) {
    return [{ command: explicit, source: "PUSHPALS_BUN_BIN", shell: false }];
  }

  const candidates = [];
  const seen = new Set();
  const append = (command, source, shell = false) => {
    const normalized = String(command ?? "").trim();
    if (!normalized) return;
    const key = candidateKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ command: normalized, source, shell });
  };

  for (const rawCandidate of String(whereOutput ?? "").split(/\r?\n/g)) {
    const candidate = rawCandidate.trim();
    if (!candidate) continue;

    if (candidate.toLowerCase().endsWith(".exe") && pathExists(candidate)) {
      append(candidate, "PATH");
      continue;
    }

    // Resolve both global npm shims (<prefix>/bun.cmd) and project-local npm
    // shims (<repo>/node_modules/.bin/bun.cmd) to the native executable so
    // Node can spawn it without a shell.
    const shimDirectory = pathWin32.dirname(candidate);
    const shimTargets = [];
    if (pathWin32.basename(shimDirectory).toLowerCase() === ".bin") {
      shimTargets.push(pathWin32.join(shimDirectory, "..", "bun", "bin", "bun.exe"));
    }
    shimTargets.push(pathWin32.join(shimDirectory, "node_modules", "bun", "bin", "bun.exe"));
    for (const shimTarget of shimTargets) {
      if (pathExists(shimTarget)) append(shimTarget, "npm-shim");
    }
  }

  if (candidates.length === 0) {
    append("bun", "PATH-fallback", true);
  }
  return candidates;
}

function describeProbeError(result) {
  const errorMessage = String(result?.error?.message ?? "").trim();
  if (errorMessage) return errorMessage;
  const stderr = String(result?.stderr ?? "").trim();
  if (stderr) return stderr;
  if (result?.status !== null && result?.status !== undefined) {
    return `exit ${result.status}`;
  }
  return "could not be launched";
}

function selectCompatibleBunRuntime(
  candidates,
  { minimumVersion, timeoutMs, probe, now = Date.now } = {},
) {
  const totalTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
  const startedAt = now();
  const attempts = [];
  let firstRunnable = null;
  let budgetExhausted = false;

  for (const candidate of candidates) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (totalTimeoutMs > 0 && elapsedMs >= totalTimeoutMs) {
      budgetExhausted = true;
      break;
    }
    const remainingMs = totalTimeoutMs > 0 ? Math.max(1, totalTimeoutMs - elapsedMs) : 0;

    let result;
    try {
      result = probe(candidate, remainingMs);
    } catch (error) {
      result = { status: null, stdout: "", stderr: "", error };
    }

    const version = String(result?.stdout ?? "").trim();
    const runnable = result?.status === 0;
    const timedOut = result?.error?.code === "ETIMEDOUT";
    const attempt = {
      ...candidate,
      runnable,
      timedOut,
      version,
      detail: runnable ? "" : describeProbeError(result),
      timeoutMs: remainingMs,
    };
    attempts.push(attempt);

    if (runnable && !firstRunnable) firstRunnable = attempt;
    if (runnable && versionAtLeast(version, minimumVersion)) {
      return {
        ok: true,
        compatible: true,
        timedOut: false,
        budgetExhausted: false,
        command: candidate.command,
        shell: Boolean(candidate.shell),
        version,
        attempts,
      };
    }
  }

  if (totalTimeoutMs > 0 && now() - startedAt >= totalTimeoutMs) {
    budgetExhausted = true;
  }
  return {
    ok: Boolean(firstRunnable),
    compatible: false,
    timedOut: budgetExhausted || attempts.some((attempt) => attempt.timedOut),
    budgetExhausted,
    command: firstRunnable?.command ?? "",
    shell: Boolean(firstRunnable?.shell),
    version: firstRunnable?.version ?? "",
    attempts,
  };
}

module.exports = {
  buildBunVersionProbeInvocation,
  enumerateWindowsBunCandidates,
  parseVersion,
  selectCompatibleBunRuntime,
  versionAtLeast,
};
