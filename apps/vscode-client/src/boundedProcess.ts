import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT_CHARS = 512 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;

export type BoundedNodeCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  drainTimedOut: boolean;
};

function appendBounded(existing: string, next: string, maxChars: number): string {
  const combined = `${existing}${next}`;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runKiller(command: string, args: string[], timeoutMs: number): Promise<void> {
  let killer: ChildProcess | null = null;
  try {
    killer = spawn(command, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    if (!(await waitForExit(killer, timeoutMs))) killer.kill("SIGKILL");
  } catch {
    try {
      killer?.kill("SIGKILL");
    } catch {
      // best-effort cleanup only
    }
  }
}

export function buildWindowsDescendantSweepArgs(pid: number): string[] {
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
    "for ($index = $targets.Count - 1; $index -ge 0; $index--) { Stop-Process -Id $targets[$index] -Force -ErrorAction SilentlyContinue }",
  ].join("\n");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export async function terminateNodeProcessTree(
  child: ChildProcess,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS);
  const pid = Number(child.pid);
  const rootAlreadyExited = child.exitCode != null || child.signalCode != null;

  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    if (!rootAlreadyExited) {
      await runKiller("taskkill", ["/PID", String(pid), "/T", "/F"], timeoutMs);
    }
    // taskkill cannot discover descendants after their parent has exited. A
    // bounded CIM sweep closes inherited pipes held by those orphan children.
    await runKiller("powershell.exe", buildWindowsDescendantSweepArgs(pid), timeoutMs);
    if (rootAlreadyExited || (await waitForExit(child, 1_000))) return;
  } else if (Number.isFinite(pid) && pid > 0) {
    if (!rootAlreadyExited) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          return;
        }
      }
      await waitForExit(child, 1_000);
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // direct kill below remains the fallback
    }
    if (rootAlreadyExited || child.exitCode != null || child.signalCode != null) return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForExit(child, 1_000);
}

/**
 * Execute a VS Code helper command with a hard deadline, process-tree cleanup,
 * bounded output retention, and a bounded inherited-pipe drain.
 */
export async function runBoundedNodeCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitChars?: number;
  drainTimeoutMs?: number;
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
}): Promise<BoundedNodeCommandResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    shell: false,
    env: options.env ?? process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const maxChars = Math.max(1, options.outputLimitChars ?? DEFAULT_OUTPUT_LIMIT_CHARS);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let settled = false;
  let timedOut = false;
  let exitCode = 1;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  const capture = (current: string, chunk: Buffer): string => {
    const text = chunk.toString("utf8");
    if (current.length + text.length > maxChars) truncated = true;
    return appendBounded(current, text, maxChars);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = capture(stdout, chunk);
    try {
      options.onStdoutChunk?.(chunk);
    } catch {
      // Logging callbacks cannot strand the subprocess.
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = capture(stderr, chunk);
    try {
      options.onStderrChunk?.(chunk);
    } catch {
      // Logging callbacks cannot strand the subprocess.
    }
  });

  return await new Promise<BoundedNodeCommandResult>((resolve, reject) => {
    const finish = (drainTimedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (drainTimedOut) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const marker = truncated ? "\n[pushpals: process output truncated]" : "";
      resolve({
        code: timedOut ? 124 : exitCode,
        stdout: `${stdout}${marker}`,
        stderr: `${stderr}${timedOut ? `\nCommand timed out after ${timeoutMs}ms.` : ""}`,
        timedOut,
        drainTimedOut,
      });
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      reject(error);
    });
    child.once("exit", (code) => {
      exitCode = code ?? 1;
      drainTimer = setTimeout(() => {
        void terminateNodeProcessTree(child).finally(() => finish(true));
      }, drainTimeoutMs);
    });
    child.once("close", (code) => {
      exitCode = code ?? exitCode;
      finish(false);
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      exitCode = 124;
      void terminateNodeProcessTree(child).finally(() => {
        if (!settled) {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(true);
        }
      });
    }, timeoutMs);
  });
}
