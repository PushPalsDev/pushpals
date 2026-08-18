type ProcessStream = ReadableStream<Uint8Array> | number | null | undefined;

export type BoundedSubprocess = {
  pid: number;
  stdout?: ProcessStream;
  stderr?: ProcessStream;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

export type BoundedProcessSpawner = (
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Blob | "ignore";
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
    detached?: boolean;
  },
) => BoundedSubprocess;

export type BoundedProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  drainTimedOut: boolean;
};

const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_GRACE_MS = 250;
const MAX_STREAMING_LINE_CHARS = 64 * 1024;

function defaultSpawner(
  argv: string[],
  options: Parameters<BoundedProcessSpawner>[1],
): BoundedSubprocess {
  return Bun.spawn(argv, options) as unknown as BoundedSubprocess;
}

export function buildWindowsProcessTreeTerminationArgv(pid: number): string[] {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}

/**
 * `taskkill /T` cannot discover descendants after their root has already
 * exited. Win32_Process retains creator PIDs, so a bounded CIM sweep provides
 * the fallback needed for inherited-pipe stalls caused by an orphan child.
 */
export function buildWindowsDescendantSweepArgv(pid: number): string[] {
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
    "powershell.exe",
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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function captureBoundedStream(
  stream: ProcessStream,
  maxBytes: number,
  options: {
    retainTail?: boolean;
    onLine?: (line: string) => void;
  } = {},
): { done: Promise<string>; cancel: () => void } {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { done: Promise.resolve(""), cancel: () => undefined };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const headLimit = options.retainTail ? Math.max(1, Math.floor(maxBytes / 2)) : maxBytes;
  const tailLimit = options.retainTail ? Math.max(0, maxBytes - headLimit) : 0;
  let head = "";
  let tail = "";
  let observedChars = 0;
  let lineBuffer = "";
  let truncated = false;
  let cancelled = false;
  const emitLine = (line: string) => {
    try {
      options.onLine?.(line);
    } catch {
      // Observability callbacks must not strand the subprocess or its pipes.
    }
  };
  const retainAndEmit = (text: string) => {
    if (!text) return;
    observedChars += text.length;
    const headRemaining = Math.max(0, headLimit - head.length);
    const headPart = headRemaining > 0 ? text.slice(0, headRemaining) : "";
    head += headPart;
    const remainder = text.slice(headPart.length);
    if (remainder && tailLimit > 0) tail = `${tail}${remainder}`.slice(-tailLimit);
    truncated = observedChars > maxBytes;

    if (!options.onLine) return;
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) emitLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lineBuffer.length > MAX_STREAMING_LINE_CHARS) {
      emitLine(
        `${lineBuffer.slice(0, MAX_STREAMING_LINE_CHARS)}\n[pushpals: streaming line truncated]`,
      );
      lineBuffer = "";
    }
  };
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        retainAndEmit(decoder.decode(chunk.value, { stream: true }));
      }
      retainAndEmit(decoder.decode());
      if (options.onLine && lineBuffer.length > 0) {
        emitLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer);
        lineBuffer = "";
      }
    } catch {
      // Deadlines and inherited-pipe recovery deliberately cancel readers.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // best-effort stream cleanup
      }
    }
    if (!truncated) return head + tail;
    const marker = "\n[pushpals: process output truncated]";
    return options.retainTail ? `${head}${marker}\n${tail}` : `${head}${marker}`;
  })();

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // best-effort stream cleanup
      }
    },
  };
}

export async function terminateProcessTree(
  proc: BoundedSubprocess,
  options: {
    platform?: NodeJS.Platform;
    spawn?: BoundedProcessSpawner;
    terminationTimeoutMs?: number;
    exitGraceMs?: number;
    gracefulSignalAlreadySent?: boolean;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawner;
  const terminationTimeoutMs = Math.max(
    1,
    options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS,
  );
  const exitGraceMs = Math.max(1, options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
  const gracefulSignalAlreadySent = options.gracefulSignalAlreadySent === true;
  const pid = Number(proc.pid);

  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const killer = spawn(buildWindowsProcessTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore",
      });
      const taskkillExit = await settleWithin(killer.exited, terminationTimeoutMs);
      if (!taskkillExit.settled) {
        try {
          killer.kill("SIGKILL");
        } catch {
          // taskkill already exited
        }
      }
      if (!taskkillExit.settled || taskkillExit.value !== 0) {
        try {
          const sweeper = spawn(buildWindowsDescendantSweepArgv(pid), {
            stdout: "ignore",
            stderr: "ignore",
          });
          if (!(await settleWithin(sweeper.exited, terminationTimeoutMs)).settled) {
            try {
              sweeper.kill("SIGKILL");
            } catch {
              // descendant sweep already exited
            }
          }
        } catch {
          // Direct termination below remains the final fallback.
        }
      }
      if ((await settleWithin(proc.exited, exitGraceMs)).settled) return;
    } catch {
      // Fall through to direct termination when taskkill cannot start.
    }
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
      // No detached process group exists (common for injected test doubles and
      // already-reaped roots). The root exit is authoritative here, so do not
      // impose the full group grace after direct termination succeeds.
      if ((await settleWithin(proc.exited, exitGraceMs)).settled) return;
    } else {
      const groupDeadline = Date.now() + exitGraceMs;
      while (Date.now() < groupDeadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
          break;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(25, Math.max(1, groupDeadline - Date.now()))),
        );
      }
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // process tree already exited
      }
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
    if ((await settleWithin(proc.exited, exitGraceMs)).settled) return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // process already exited
  }
  await settleWithin(proc.exited, exitGraceMs);
}

/**
 * Execute a helper command with a hard deadline, whole-tree termination,
 * bounded output capture, and bounded inherited-pipe draining.
 */
export async function runBoundedProcess(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Blob | "ignore";
    stdout?: "pipe" | "ignore";
    stderr?: "pipe" | "ignore";
    timeoutMs: number;
    outputLimitBytes?: number;
    streamDrainTimeoutMs?: number;
    platform?: NodeJS.Platform;
    spawn?: BoundedProcessSpawner;
    terminate?: (proc: BoundedSubprocess) => Promise<void>;
    retainOutputTail?: boolean;
    preserveOutputWhitespace?: boolean;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
    extendTimeoutMs?: (context: {
      startedAtMs: number;
      deadlineAtMs: number;
      elapsedMs: number;
    }) => number;
    onTimeoutExtended?: (extensionMs: number, deadlineAtMs: number) => void;
    onTimeout?: (elapsedMs: number) => void;
    maxTotalTimeoutMs?: number;
  },
): Promise<BoundedProcessResult> {
  const spawn = options.spawn ?? defaultSpawner;
  const platform = options.platform ?? process.platform;
  const proc = spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    detached: platform !== "win32",
  });
  const maxBytes = Math.max(1, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const stdoutCapture = captureBoundedStream(proc.stdout, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStdoutLine,
  });
  const stderrCapture = captureBoundedStream(proc.stderr, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStderrLine,
  });
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const maxTotalTimeoutMs = Math.max(timeoutMs, Math.floor(options.maxTotalTimeoutMs ?? timeoutMs));
  const startedAtMs = Date.now();
  let effectiveTimeoutMs = timeoutMs;
  let deadlineAtMs = startedAtMs + timeoutMs;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    new Promise<{ timedOut: true; exitCode: 124 }>((resolve) => {
      const scheduleDeadline = () => {
        timer = setTimeout(
          () => {
            const nowMs = Date.now();
            let requestedExtensionValue = 0;
            try {
              requestedExtensionValue =
                options.extendTimeoutMs?.({
                  startedAtMs,
                  deadlineAtMs,
                  elapsedMs: Math.max(0, nowMs - startedAtMs),
                }) ?? 0;
            } catch {
              requestedExtensionValue = 0;
            }
            const extensionMs = Math.min(
              Math.max(0, Math.floor(requestedExtensionValue)),
              Math.max(0, maxTotalTimeoutMs - effectiveTimeoutMs),
            );
            if (extensionMs > 0) {
              effectiveTimeoutMs += extensionMs;
              deadlineAtMs = nowMs + extensionMs;
              try {
                options.onTimeoutExtended?.(extensionMs, deadlineAtMs);
              } catch {
                // Observability callbacks do not control the deadline.
              }
              scheduleDeadline();
              return;
            }
            try {
              options.onTimeout?.(Math.max(1, nowMs - startedAtMs));
            } catch {
              // Observability callbacks do not control termination.
            }
            resolve({ timedOut: true, exitCode: 124 });
          },
          Math.max(1, deadlineAtMs - Date.now()),
        );
      };
      scheduleDeadline();
    }),
  ]);
  if (timer) clearTimeout(timer);

  const terminate =
    options.terminate ??
    ((target: BoundedSubprocess) => terminateProcessTree(target, { platform, spawn }));
  if (outcome.timedOut) await terminate(proc);

  const drainTimeoutMs = Math.max(1, options.streamDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let streams = await settleWithin(
    Promise.all([stdoutCapture.done, stderrCapture.done]),
    drainTimeoutMs,
  );
  const drainTimedOut = !streams.settled;
  if (!streams.settled) {
    if (!outcome.timedOut) {
      if (options.terminate) {
        await options.terminate(proc);
      } else {
        // The root already exited, so only descendants retaining inherited
        // pipes remain. Give that orphan group a short grace window before the
        // forced group kill; waiting the normal process-exit grace adds latency
        // without yielding any stronger root-exit evidence.
        await terminateProcessTree(proc, {
          platform,
          spawn,
          exitGraceMs: Math.min(250, Math.max(25, drainTimeoutMs)),
        });
      }
    }
    stdoutCapture.cancel();
    stderrCapture.cancel();
    streams = await settleWithin(Promise.all([stdoutCapture.done, stderrCapture.done]), 250);
  }
  const [stdout, rawStderr] = streams.settled ? streams.value : ["", ""];
  const timeoutDetail = outcome.timedOut
    ? `Command timed out after ${effectiveTimeoutMs}ms; terminated process tree.`
    : "";
  const drainDetail = drainTimedOut
    ? `Process streams did not close after ${drainTimeoutMs}ms; terminated process tree and stopped draining.`
    : "";
  const trimOutput = (text: string) => (options.preserveOutputWhitespace ? text : text.trim());

  return {
    stdout: trimOutput(stdout),
    stderr: [trimOutput(rawStderr), timeoutDetail, drainDetail].filter(Boolean).join("\n"),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    drainTimedOut,
  };
}
