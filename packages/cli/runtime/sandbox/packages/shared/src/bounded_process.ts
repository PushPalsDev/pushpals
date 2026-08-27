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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutDecodeError: boolean;
  stderrDecodeError: boolean;
  exitCode: number;
  timedOut: boolean;
  drainTimedOut: boolean;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The subprocess was aborted", "AbortError");
}

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

type BoundedStreamCaptureResult = {
  text: string;
  truncated: boolean;
  decodeError: boolean;
};

const EMPTY_STREAM_CAPTURE_RESULT: BoundedStreamCaptureResult = {
  text: "",
  truncated: false,
  decodeError: false,
};

function captureBoundedStream(
  stream: ProcessStream,
  maxBytes: number,
  options: {
    retainTail?: boolean;
    onLine?: (line: string) => void;
  } = {},
): { done: Promise<BoundedStreamCaptureResult>; cancel: () => void } {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { done: Promise.resolve(EMPTY_STREAM_CAPTURE_RESULT), cancel: () => undefined };
  }

  const reader = stream.getReader();
  const lineDecoder = new TextDecoder();
  const validationDecoder = new TextDecoder("utf-8", { fatal: true });
  const headLimit = options.retainTail ? Math.max(1, Math.floor(maxBytes / 2)) : maxBytes;
  const tailLimit = options.retainTail ? Math.max(0, maxBytes - headLimit) : 0;
  const headBuffer = new Uint8Array(headLimit);
  const tailBuffer = new Uint8Array(tailLimit);
  let headLength = 0;
  let tailLength = 0;
  let tailWriteOffset = 0;
  let observedBytes = 0;
  let lineBuffer = "";
  let decodeError = false;
  let validationActive = true;
  let cancelled = false;
  const emitLine = (line: string) => {
    try {
      options.onLine?.(line);
    } catch {
      // Observability callbacks must not strand the subprocess or its pipes.
    }
  };
  const emitDecodedLines = (text: string) => {
    if (!text || !options.onLine) return;
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
  const appendTail = (bytes: Uint8Array) => {
    if (tailLimit === 0 || bytes.byteLength === 0) return;
    if (bytes.byteLength >= tailLimit) {
      tailBuffer.set(bytes.subarray(bytes.byteLength - tailLimit));
      tailLength = tailLimit;
      tailWriteOffset = 0;
      return;
    }
    const firstLength = Math.min(bytes.byteLength, tailLimit - tailWriteOffset);
    tailBuffer.set(bytes.subarray(0, firstLength), tailWriteOffset);
    const remainingLength = bytes.byteLength - firstLength;
    if (remainingLength > 0) tailBuffer.set(bytes.subarray(firstLength), 0);
    tailWriteOffset = (tailWriteOffset + bytes.byteLength) % tailLimit;
    tailLength = Math.min(tailLimit, tailLength + bytes.byteLength);
  };
  const retainedTail = (): Uint8Array => {
    if (tailLength === 0) return new Uint8Array();
    if (tailLength < tailLimit) return tailBuffer.slice(0, tailLength);
    if (tailWriteOffset === 0) return tailBuffer.slice();
    const ordered = new Uint8Array(tailLength);
    const first = tailBuffer.subarray(tailWriteOffset);
    ordered.set(first, 0);
    ordered.set(tailBuffer.subarray(0, tailWriteOffset), first.byteLength);
    return ordered;
  };
  const retainAndValidate = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    observedBytes = Math.min(Number.MAX_SAFE_INTEGER, observedBytes + bytes.byteLength);
    const headBytes = Math.min(headLimit - headLength, bytes.byteLength);
    if (headBytes > 0) {
      headBuffer.set(bytes.subarray(0, headBytes), headLength);
      headLength += headBytes;
    }
    appendTail(bytes.subarray(headBytes));

    if (validationActive) {
      try {
        validationDecoder.decode(bytes, { stream: true });
      } catch {
        decodeError = true;
        validationActive = false;
      }
    }
    if (options.onLine) emitDecodedLines(lineDecoder.decode(bytes, { stream: true }));
  };
  const done = (async () => {
    let reachedEnd = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          reachedEnd = true;
          break;
        }
        retainAndValidate(chunk.value);
      }
      if (!cancelled && validationActive) {
        try {
          validationDecoder.decode();
        } catch {
          decodeError = true;
          validationActive = false;
        }
      }
      if (options.onLine) emitDecodedLines(lineDecoder.decode());
      if (options.onLine && reachedEnd && lineBuffer.length > 0) {
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
    const truncated = observedBytes > maxBytes;
    const head = headBuffer.subarray(0, headLength);
    const tail = retainedTail();
    if (!truncated) {
      const retained = new Uint8Array(head.byteLength + tail.byteLength);
      retained.set(head, 0);
      retained.set(tail, head.byteLength);
      return {
        text: new TextDecoder().decode(retained),
        truncated,
        decodeError,
      };
    }
    return {
      text: options.retainTail
        ? `${new TextDecoder().decode(head)}${new TextDecoder().decode(tail)}`
        : new TextDecoder().decode(head),
      truncated,
      decodeError,
    };
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
    /**
     * Cancels the command and its descendants. The returned promise rejects
     * only after whole-tree termination and bounded stream draining finish, so
     * callers can safely start replacement provider work after observing it.
     */
    signal?: AbortSignal;
  },
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) throw abortReason(options.signal);
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
  const requestedOutputLimitBytes = Number(options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const maxBytes = Number.isFinite(requestedOutputLimitBytes)
    ? Math.max(1, Math.floor(requestedOutputLimitBytes))
    : DEFAULT_OUTPUT_LIMIT_BYTES;
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
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<{
    timedOut: false;
    aborted: true;
    exitCode: 130;
    reason: Error;
  }>((resolve) => {
    const onAbort = () =>
      resolve({
        timedOut: false,
        aborted: true,
        exitCode: 130,
        reason: abortReason(options.signal!),
      });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    // Close the pre-spawn/pre-listener race without relying on another turn of
    // the event loop.
    if (options.signal?.aborted) onAbort();
  });
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({
      timedOut: false as const,
      aborted: false as const,
      exitCode,
    })),
    new Promise<{ timedOut: true; aborted: false; exitCode: 124 }>((resolve) => {
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
            resolve({ timedOut: true, aborted: false, exitCode: 124 });
          },
          Math.max(1, deadlineAtMs - Date.now()),
        );
      };
      scheduleDeadline();
    }),
    ...(options.signal ? [aborted] : []),
  ]);
  if (timer) clearTimeout(timer);
  removeAbortListener();

  const terminate =
    options.terminate ??
    ((target: BoundedSubprocess) => terminateProcessTree(target, { platform, spawn }));
  if (outcome.timedOut || outcome.aborted) await terminate(proc);

  const drainTimeoutMs = Math.max(1, options.streamDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let streams = await settleWithin(
    Promise.all([stdoutCapture.done, stderrCapture.done]),
    drainTimeoutMs,
  );
  const drainTimedOut = !streams.settled;
  if (!streams.settled) {
    if (!outcome.timedOut && !outcome.aborted) {
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
  const [stdoutCaptureResult, stderrCaptureResult] = streams.settled
    ? streams.value
    : [EMPTY_STREAM_CAPTURE_RESULT, EMPTY_STREAM_CAPTURE_RESULT];
  const timeoutDetail = outcome.timedOut
    ? `Command timed out after ${effectiveTimeoutMs}ms; terminated process tree.`
    : "";
  const drainDetail = drainTimedOut
    ? `Process streams did not close after ${drainTimeoutMs}ms; terminated process tree and stopped draining.`
    : "";
  const trimOutput = (text: string) => (options.preserveOutputWhitespace ? text : text.trim());

  if (outcome.aborted) throw outcome.reason;

  return {
    stdout: trimOutput(stdoutCaptureResult.text),
    stderr: [trimOutput(stderrCaptureResult.text), timeoutDetail, drainDetail]
      .filter(Boolean)
      .join("\n"),
    stdoutTruncated: stdoutCaptureResult.truncated,
    stderrTruncated: stderrCaptureResult.truncated,
    stdoutDecodeError: stdoutCaptureResult.decodeError,
    stderrDecodeError: stderrCaptureResult.decodeError,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    drainTimedOut,
  };
}
