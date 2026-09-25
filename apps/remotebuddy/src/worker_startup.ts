// Image preparation has its own bounded subprocess deadline. A cold image may
// take longer than daemon registration, but output is never proof of readiness.
import {
  isWorkerStartupPhase,
  WORKER_STARTUP_CLEANUP_GRACE_MS,
  workerStartupAllowanceMs,
  workerStartupPhaseTimeoutMs,
  type WorkerStartupPhase,
} from "shared";
const STARTUP_PROGRESS_PREFIX = "[WorkerPalStartup] ";
const MAX_STARTUP_LINE_CHARS = 2_048;
export class WorkerStartupProgress {
  readonly absoluteDeadlineMs: number;
  deadlineMs: number;
  private activePhase: { name: WorkerStartupPhase; deadlineMs: number } | null = null;
  private readonly startedPhases = new Set<WorkerStartupPhase>();

  constructor(
    private readonly timeoutMs: number,
    startedAtMs: number,
    private readonly docker: boolean,
  ) {
    this.deadlineMs = startedAtMs + timeoutMs;
    this.absoluteDeadlineMs = startedAtMs + workerStartupAllowanceMs(timeoutMs, docker);
  }

  observeLine(line: string, nowMs = Date.now()): boolean {
    if (
      !this.docker ||
      nowMs >= this.deadlineMs ||
      line.length > MAX_STARTUP_LINE_CHARS ||
      !line.startsWith(STARTUP_PROGRESS_PREFIX)
    ) {
      return false;
    }
    let data: unknown;
    try {
      data = JSON.parse(line.slice(STARTUP_PROGRESS_PREFIX.length));
    } catch {
      return false;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const { phase, event, timeoutMs } = data as Record<string, unknown>;
    if (
      !isWorkerStartupPhase(phase) ||
      typeof event !== "string" ||
      !["start", "progress", "complete", "failed"].includes(event) ||
      typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return false;
    }

    if (event === "start") {
      // A duplicate start must not slide the phase's absolute command deadline.
      if (this.activePhase || this.startedPhases.has(phase)) return false;
      this.startedPhases.add(phase);
      this.activePhase = {
        name: phase,
        deadlineMs: Math.min(
          nowMs +
            Math.min(timeoutMs, workerStartupPhaseTimeoutMs(phase, this.timeoutMs)) +
            WORKER_STARTUP_CLEANUP_GRACE_MS,
          this.absoluteDeadlineMs,
        ),
      };
    } else if (this.activePhase?.name !== phase) {
      return false;
    }

    if (event === "complete" || event === "failed") {
      this.activePhase = null;
      // Allow normal registration (or a fallback phase), never mark it online.
      this.deadlineMs = Math.min(nowMs + this.timeoutMs, this.absoluteDeadlineMs);
    } else if (this.activePhase) {
      // Quiet commands can be healthy. Their fixed budget includes bounded
      // termination/draining grace, so timeout failure markers can still arrive.
      // Progress bytes neither prove readiness nor move this deadline.
      this.deadlineMs = this.activePhase.deadlineMs;
    }
    return true;
  }
}

/** Forward raw bytes unchanged while inspecting only bounded, complete lines. */
export async function forwardWorkerOutput(
  stream: ReadableStream<Uint8Array>,
  write: (chunk: Uint8Array) => void | Promise<void>,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let oversized = false;
  let completed = false;
  let releaseWrite: (() => void) | null = null;
  const abort = () => {
    releaseWrite?.();
    // Cancellation itself may be implemented by an inherited, stalled pipe.
    // Request it without making shutdown wait for that external resource.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const inspect = (text: string) => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      if (!oversized) {
        if (pending.length + end - offset > MAX_STARTUP_LINE_CHARS) {
          pending = "";
          oversized = true;
        } else {
          pending += text.slice(offset, end);
        }
      }
      if (newline < 0) break;
      if (!oversized) onLine(pending.replace(/\r$/, ""));
      pending = "";
      oversized = false;
      offset = newline + 1;
    }
  };
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (signal?.aborted) break;
      inspect(decoder.decode(value, { stream: true }));
      // Await downstream consumption so a slow log sink cannot accumulate an
      // unbounded in-memory copy of a worker's lifetime stdout/stderr.
      await new Promise<void>((resolve, reject) => {
        releaseWrite = resolve;
        try {
          Promise.resolve(write(value)).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
      releaseWrite = null;
    }
    if (!signal?.aborted) {
      inspect(decoder.decode());
      if (pending && !oversized) onLine(pending.replace(/\r$/, ""));
    }
  } finally {
    releaseWrite = null;
    signal?.removeEventListener("abort", abort);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
