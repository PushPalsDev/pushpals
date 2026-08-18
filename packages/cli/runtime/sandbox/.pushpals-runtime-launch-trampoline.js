#!/usr/bin/env bun
// @bun

// packages/shared/src/bounded_process.ts
var DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
var DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
var DEFAULT_EXIT_GRACE_MS = 250;
var MAX_STREAMING_LINE_CHARS = 64 * 1024;
function defaultSpawner(argv, options) {
  return Bun.spawn(argv, options);
}
function buildWindowsProcessTreeTerminationArgv(pid) {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}
function buildWindowsDescendantSweepArgv(pid) {
  const rootPid = Math.max(0, Math.floor(pid));
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$rootPid = ${rootPid}`,
    "$processes = @(Get-CimInstance Win32_Process)",
    "$children = @{}",
    "foreach ($process in $processes) {",
    "  $parent = [int]$process.ParentProcessId",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[int]]::new() }",
    "  $children[$parent].Add([int]$process.ProcessId)",
    "}",
    "$stack = [System.Collections.Generic.Stack[int]]::new()",
    "$targets = [System.Collections.Generic.List[int]]::new()",
    "$stack.Push($rootPid)",
    "while ($stack.Count -gt 0) {",
    "  $parent = $stack.Pop()",
    "  if (-not $children.ContainsKey($parent)) { continue }",
    "  foreach ($child in $children[$parent]) { $targets.Add($child); $stack.Push($child) }",
    "}",
    "for ($index = $targets.Count - 1; $index -ge 0; $index--) { Stop-Process -Id $targets[$index] -Force -ErrorAction SilentlyContinue }"
  ].join(`
`);
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}
async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
async function terminateProcessTree(proc, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawner;
  const terminationTimeoutMs = Math.max(1, options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS);
  const exitGraceMs = Math.max(1, options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
  const gracefulSignalAlreadySent = options.gracefulSignalAlreadySent === true;
  const pid = Number(proc.pid);
  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const killer = spawn(buildWindowsProcessTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore"
      });
      const taskkillExit = await settleWithin(killer.exited, terminationTimeoutMs);
      if (!taskkillExit.settled) {
        try {
          killer.kill("SIGKILL");
        } catch {}
      }
      if (!taskkillExit.settled || taskkillExit.value !== 0) {
        try {
          const sweeper = spawn(buildWindowsDescendantSweepArgv(pid), {
            stdout: "ignore",
            stderr: "ignore"
          });
          if (!(await settleWithin(sweeper.exited, terminationTimeoutMs)).settled) {
            try {
              sweeper.kill("SIGKILL");
            } catch {}
          }
        } catch {}
      }
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } catch {}
  }
  if (platform !== "win32" && Number.isFinite(pid) && pid > 0) {
    if (gracefulSignalAlreadySent) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          return;
        }
      }
      await settleWithin(proc.exited, exitGraceMs);
      return;
    }
    let signalledProcessGroup = false;
    try {
      process.kill(-pid, "SIGTERM");
      signalledProcessGroup = true;
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        return;
      }
    }
    if (!signalledProcessGroup) {
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } else {
      const groupDeadline = Date.now() + exitGraceMs;
      while (Date.now() < groupDeadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH")
            return;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, groupDeadline - Date.now()))));
      }
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    await settleWithin(proc.exited, exitGraceMs);
    return;
  }
  if (!gracefulSignalAlreadySent) {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    if ((await settleWithin(proc.exited, exitGraceMs)).settled)
      return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
  await settleWithin(proc.exited, exitGraceMs);
}

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
    await terminateProcessTree(child);
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
