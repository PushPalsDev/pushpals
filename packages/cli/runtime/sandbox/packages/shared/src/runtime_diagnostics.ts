export type RuntimeDiagnosticEvent = {
  service: string;
  observedAt: string;
} & (
  | { event: "runtime_event_loop_delay"; delayMs: number; sampleIntervalMs: number }
  | { event: "runtime_slow_operation"; stage: string; durationMs: number }
);

export interface RuntimeDiagnosticsOptions {
  service: string;
  now?: () => number;
  wallNow?: () => number;
  onEvent?: (event: RuntimeDiagnosticEvent) => void;
  sampleIntervalMs?: number;
  slowThresholdMs?: number;
  maxSamples?: number;
  /** Test seam. Return a cancellation function; production timers are unref'd. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

const LABEL = /^[a-zA-Z0-9_.:-]{1,96}$/;

function boundedInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

/**
 * Bounded diagnostics, not a health gate: timer lateness does not identify its
 * root cause or prove service downtime. Operation durations include elapsed
 * waits, not only CPU time. Use fixed stage labels, never requests or errors.
 * Construction starts no timers; operation wrappers work independently of start().
 */
export class RuntimeDiagnostics {
  private readonly service: string;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly onEvent?: (event: RuntimeDiagnosticEvent) => void;
  private readonly sampleIntervalMs: number;
  private readonly slowThresholdMs: number;
  private readonly maxSamples: number;
  private readonly schedule: NonNullable<RuntimeDiagnosticsOptions["schedule"]>;
  private running = false;
  private generation = 0;
  private cancelTimer: (() => void) | null = null;
  private lastEventLoopDelayMs: number | null = null;
  private maxEventLoopDelayMs = 0;
  private slowEventLoopSamples = 0;
  private slowOperationSamples = 0;
  private suppressedLogEvents = 0;
  private lastLoggedAt = -Infinity;
  private readonly recentSlowEvents: RuntimeDiagnosticEvent[] = [];

  constructor(options: RuntimeDiagnosticsOptions) {
    if (typeof options.service !== "string" || !LABEL.test(options.service)) {
      throw new TypeError("service must be a fixed identifier of 1 to 96 characters");
    }
    this.service = options.service;
    this.sampleIntervalMs = boundedInteger(
      options.sampleIntervalMs ?? 1000,
      "sampleIntervalMs",
      60_000,
    );
    this.slowThresholdMs = boundedInteger(
      options.slowThresholdMs ?? 1000,
      "slowThresholdMs",
      86_400_000,
    );
    this.maxSamples = Math.min(
      64,
      boundedInteger(options.maxSamples ?? 16, "maxSamples", Number.MAX_SAFE_INTEGER),
    );
    for (const name of ["now", "wallNow", "onEvent", "schedule"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
    }
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.onEvent = options.onEvent;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    const cancel = this.cancelTimer;
    this.cancelTimer = null;
    try {
      cancel?.();
    } catch {
      // A failed diagnostic timer cancellation must not interrupt shutdown.
    }
  }

  snapshot() {
    return {
      service: this.service,
      running: this.running,
      measurement: "Timer lateness is measured delay, not proof of root cause or service downtime.",
      sampleIntervalMs: this.sampleIntervalMs,
      slowThresholdMs: this.slowThresholdMs,
      lastEventLoopDelayMs: this.lastEventLoopDelayMs,
      maxEventLoopDelayMs: this.maxEventLoopDelayMs,
      slowEventLoopSamples: this.slowEventLoopSamples,
      slowOperationSamples: this.slowOperationSamples,
      suppressedLogEvents: this.suppressedLogEvents,
      recentSlowEvents: this.recentSlowEvents.map((event) => ({ ...event })),
    };
  }

  run<T>(stage: string, fn: () => T): T {
    const startedAt = this.readNow();
    try {
      return fn();
    } finally {
      this.observeOperation(stage, startedAt);
    }
  }

  async runAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.readNow();
    try {
      return await fn();
    } finally {
      this.observeOperation(stage, startedAt);
    }
  }

  private scheduleNext(generation: number): void {
    const startedAt = this.readNow();
    if (startedAt === null) {
      this.stop();
      return;
    }
    const expectedAt = startedAt + this.sampleIntervalMs;
    const callback = () => {
      if (!this.running || this.generation !== generation) return;
      this.cancelTimer = null;
      try {
        const observed = this.readNow();
        if (observed === null) {
          this.stop();
          return;
        }
        const delayMs = Math.max(0, observed - expectedAt);
        if (Number.isFinite(delayMs)) {
          this.lastEventLoopDelayMs = delayMs;
          this.maxEventLoopDelayMs = Math.max(this.maxEventLoopDelayMs, delayMs);
          if (delayMs >= this.slowThresholdMs) {
            this.slowEventLoopSamples += 1;
            this.record(
              {
                event: "runtime_event_loop_delay",
                service: this.service,
                observedAt: new Date(this.wallNow()).toISOString(),
                delayMs,
                sampleIntervalMs: this.sampleIntervalMs,
              },
              observed,
            );
          }
        }
      } catch {
        // Diagnostics must not crash the sampler or a service's event loop.
      }
      // Rebase to the current time: never replay missed intervals after a stall.
      if (this.running && this.generation === generation) this.scheduleNext(generation);
    };
    try {
      this.cancelTimer = this.schedule(callback, this.sampleIntervalMs);
    } catch {
      // Timing is optional instrumentation, never a reason to stop the service.
      this.stop();
    }
  }

  private readNow(): number | null {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private observeOperation(stage: string, startedAt: number | null): void {
    try {
      if (startedAt === null) return;
      const observed = this.readNow();
      if (observed === null) return;
      const durationMs = Math.max(0, observed - startedAt);
      if (!Number.isFinite(durationMs) || durationMs < this.slowThresholdMs) return;
      this.slowOperationSamples += 1;
      this.record(
        {
          event: "runtime_slow_operation",
          service: this.service,
          observedAt: new Date(this.wallNow()).toISOString(),
          stage: typeof stage === "string" && LABEL.test(stage) ? stage : "operation",
          durationMs,
        },
        observed,
      );
    } catch {
      // Never replace a successful result, synchronous throw, or rejection.
    }
  }

  private record(event: RuntimeDiagnosticEvent, observed: number): void {
    this.recentSlowEvents.push(event);
    if (this.recentSlowEvents.length > this.maxSamples) this.recentSlowEvents.shift();
    if (!this.onEvent) return;
    if (observed - this.lastLoggedAt < 1000) {
      this.suppressedLogEvents += 1;
      return;
    }
    this.lastLoggedAt = observed;
    try {
      // Copy before handing to the sink; tolerate accidental async sinks too.
      void Promise.resolve(this.onEvent({ ...event })).catch(() => undefined);
    } catch {
      // Logging is best effort and cannot break the instrumented operation.
    }
  }
}
