export type RuntimeActiveOperation = { stage: string; elapsedMs: number };
export type RuntimeDiagnosticContext = {
  /** CPU is process-wide over the sampler window, not attributed to one operation. */
  sampleElapsedMs?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  rssBytes?: number;
  activeOperations?: RuntimeActiveOperation[];
};

export type RuntimeDiagnosticEvent = {
  service: string;
  observedAt: string;
  context?: RuntimeDiagnosticContext;
} & (
  | { event: "runtime_event_loop_delay"; delayMs: number; sampleIntervalMs: number }
  | { event: "runtime_slow_operation"; stage: string; durationMs: number }
);

/** A fixed-size, allowlisted view suitable for health lifecycle telemetry. */
export type RuntimeDiagnosticsSummary = {
  service: string;
  lastEventLoopDelayMs?: number;
  maxEventLoopDelayMs?: number;
  slowEventLoopSamples?: number;
  slowOperationSamples?: number;
  latestEventLoopDelay?: RuntimeDiagnosticEvent;
  latestSlowOperation?: RuntimeDiagnosticEvent;
  activeOperations?: RuntimeActiveOperation[];
};

export interface RuntimeDiagnosticsOptions {
  service: string;
  now?: () => number;
  wallNow?: () => number;
  onEvent?: (event: RuntimeDiagnosticEvent) => void;
  sampleIntervalMs?: number;
  slowThresholdMs?: number;
  maxSamples?: number;
  /** Optional process-wide counters. Failures only omit resource context. */
  cpuUsage?: () => { user: number; system: number };
  rssBytes?: () => number;
  /** Test seam. Return a cancellation function; production timers are unref'd. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

const LABEL = /^[a-zA-Z0-9_.:-]{1,96}$/;
const MAX_ACTIVE_OPERATIONS = 8;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteMeasurement(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function activeOperationSummary(value: unknown): RuntimeActiveOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_ACTIVE_OPERATIONS).flatMap((entry) => {
    const item = recordValue(entry);
    return item &&
      typeof item.stage === "string" &&
      LABEL.test(item.stage) &&
      finiteMeasurement(item.elapsedMs)
      ? [{ stage: item.stage, elapsedMs: item.elapsedMs }]
      : [];
  });
}

function diagnosticContext(value: unknown): RuntimeDiagnosticContext | undefined {
  const input = recordValue(value);
  if (!input) return undefined;
  const context: RuntimeDiagnosticContext = {};
  for (const key of ["sampleElapsedMs", "cpuUserMs", "cpuSystemMs", "rssBytes"] as const) {
    if (finiteMeasurement(input[key])) context[key] = input[key];
  }
  const activeOperations = activeOperationSummary(input.activeOperations);
  if (activeOperations) context.activeOperations = activeOperations;
  return Object.keys(context).length ? context : undefined;
}

function diagnosticEvent(value: unknown, service: string): RuntimeDiagnosticEvent | undefined {
  const input = recordValue(value);
  if (
    !input ||
    typeof input.observedAt !== "string" ||
    input.observedAt.length > 32 ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    return undefined;
  const context = diagnosticContext(input.context);
  const base = { service, observedAt: input.observedAt, ...(context ? { context } : {}) };
  if (
    input.event === "runtime_event_loop_delay" &&
    finiteMeasurement(input.delayMs) &&
    finiteMeasurement(input.sampleIntervalMs)
  ) {
    return {
      ...base,
      event: input.event,
      delayMs: input.delayMs,
      sampleIntervalMs: input.sampleIntervalMs,
    };
  }
  if (
    input.event === "runtime_slow_operation" &&
    typeof input.stage === "string" &&
    LABEL.test(input.stage) &&
    finiteMeasurement(input.durationMs)
  ) {
    return { ...base, event: input.event, stage: input.stage, durationMs: input.durationMs };
  }
  return undefined;
}

/** Never forward arbitrary health body fields, paths, errors, or unbounded history. */
export function summarizeRuntimeDiagnostics(value: unknown): RuntimeDiagnosticsSummary | undefined {
  const input = recordValue(value);
  if (!input || typeof input.service !== "string" || !LABEL.test(input.service)) return undefined;
  const summary: RuntimeDiagnosticsSummary = { service: input.service };
  for (const key of [
    "lastEventLoopDelayMs",
    "maxEventLoopDelayMs",
    "slowEventLoopSamples",
    "slowOperationSamples",
  ] as const) {
    if (finiteMeasurement(input[key])) summary[key] = input[key];
  }
  // Old runtimes expose only the chronological ring. Inspect at most its last
  // 64 entries; never let its oldest sample hide the incident that just ended.
  const recent = Array.isArray(input.recentSlowEvents) ? input.recentSlowEvents.slice(-64) : [];
  for (const value of [...recent, input.latestEventLoopDelay, input.latestSlowOperation]) {
    const event = diagnosticEvent(value, input.service);
    if (!event) continue;
    if (event.event === "runtime_event_loop_delay") summary.latestEventLoopDelay = event;
    else summary.latestSlowOperation = event;
  }
  const activeOperations = activeOperationSummary(input.activeOperations);
  if (activeOperations) summary.activeOperations = activeOperations;
  return summary;
}

function copyEvent(event: RuntimeDiagnosticEvent): RuntimeDiagnosticEvent {
  return { ...event, ...(event.context ? { context: diagnosticContext(event.context) } : {}) };
}

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
  private readonly cpuUsage: NonNullable<RuntimeDiagnosticsOptions["cpuUsage"]>;
  private readonly rssBytes: NonNullable<RuntimeDiagnosticsOptions["rssBytes"]>;
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
  private latestEventLoopDelay: RuntimeDiagnosticEvent | undefined;
  private latestSlowOperation: RuntimeDiagnosticEvent | undefined;
  private readonly activeOperations = new Map<symbol, { stage: string; startedAt: number }>();

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
    for (const name of ["now", "wallNow", "onEvent", "schedule", "cpuUsage", "rssBytes"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
    }
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.onEvent = options.onEvent;
    this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.rssBytes = options.rssBytes ?? (() => process.memoryUsage.rss());
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
      latestEventLoopDelay: this.latestEventLoopDelay
        ? copyEvent(this.latestEventLoopDelay)
        : undefined,
      latestSlowOperation: this.latestSlowOperation
        ? copyEvent(this.latestSlowOperation)
        : undefined,
      activeOperations: this.activeOperationSnapshot(),
      recentSlowEvents: this.recentSlowEvents.map(copyEvent),
    };
  }

  run<T>(stage: string, fn: () => T): T {
    const startedAt = this.readNow();
    const operation = this.trackOperation(stage, startedAt);
    try {
      return fn();
    } finally {
      if (operation) this.activeOperations.delete(operation);
      this.observeOperation(stage, startedAt);
    }
  }

  async runAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.readNow();
    const operation = this.trackOperation(stage, startedAt);
    try {
      return await fn();
    } finally {
      if (operation) this.activeOperations.delete(operation);
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
    const cpuBefore = this.readCpuUsage();
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
                context: this.sampleContext(startedAt, observed, cpuBefore),
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

  private trackOperation(stage: string, startedAt: number | null): symbol | undefined {
    if (startedAt === null || this.activeOperations.size >= MAX_ACTIVE_OPERATIONS) return undefined;
    const key = Symbol();
    this.activeOperations.set(key, {
      stage: typeof stage === "string" && LABEL.test(stage) ? stage : "operation",
      startedAt,
    });
    return key;
  }

  private activeOperationSnapshot(): RuntimeActiveOperation[] {
    const now = this.readNow();
    if (now === null) return [];
    return [...this.activeOperations.values()].map(({ stage, startedAt }) => ({
      stage,
      elapsedMs: Math.max(0, now - startedAt),
    }));
  }

  private readCpuUsage(): { user: number; system: number } | null {
    try {
      const usage = this.cpuUsage();
      return finiteMeasurement(usage.user) && finiteMeasurement(usage.system) ? usage : null;
    } catch {
      return null;
    }
  }

  private sampleContext(
    startedAt: number,
    observed: number,
    before: { user: number; system: number } | null,
  ): RuntimeDiagnosticContext {
    const context: RuntimeDiagnosticContext = {
      sampleElapsedMs: Math.max(0, observed - startedAt),
      activeOperations: this.activeOperationSnapshot(),
    };
    const after = this.readCpuUsage();
    if (before && after && after.user >= before.user && after.system >= before.system) {
      context.cpuUserMs = (after.user - before.user) / 1000;
      context.cpuSystemMs = (after.system - before.system) / 1000;
    }
    try {
      const rss = this.rssBytes();
      if (finiteMeasurement(rss)) context.rssBytes = rss;
    } catch {
      // Missing/failed resource APIs cannot hide the timer-delay observation.
    }
    return context;
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
    if (event.event === "runtime_event_loop_delay") this.latestEventLoopDelay = event;
    else this.latestSlowOperation = event;
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
      void Promise.resolve(this.onEvent(copyEvent(event))).catch(() => undefined);
    } catch {
      // Logging is best effort and cannot break the instrumented operation.
    }
  }
}

/** Memory-only observations for the synchronous supervisor log sink. This has
 * deliberately no event callback: reporting a failed/slow write through that
 * same sink would recurse or add another blocking write to the incident. */
export class RuntimeLogSinkDiagnostics {
  private attempts = 0;
  private failures = 0;
  private slowWrites = 0;
  private activeWrites = 0;
  private lastWriteDurationMs: number | null = null;
  private maxWriteDurationMs = 0;
  private lastSlowWriteAt: number | null = null;
  private lastFailureAt: number | null = null;
  private readonly threshold: number;

  constructor(private readonly options: { now?: () => number; slowThresholdMs?: number } = {}) {
    this.threshold = boundedInteger(options.slowThresholdMs ?? 1000, "slowThresholdMs", 86_400_000);
  }

  /** Best-effort logging must not throw into child-stream or supervision work. */
  write(append: () => void): boolean {
    const startedAt = this.readNow();
    this.attempts = Math.min(Number.MAX_SAFE_INTEGER, this.attempts + 1);
    this.activeWrites += 1;
    try {
      append();
      return true;
    } catch {
      this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
      this.lastFailureAt = this.readNow();
      return false;
    } finally {
      this.activeWrites -= 1;
      const endedAt = this.readNow();
      this.lastWriteDurationMs =
        startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null;
      if (this.lastWriteDurationMs !== null) {
        this.maxWriteDurationMs = Math.max(this.maxWriteDurationMs, this.lastWriteDurationMs);
        if (this.lastWriteDurationMs >= this.threshold) {
          this.slowWrites = Math.min(Number.MAX_SAFE_INTEGER, this.slowWrites + 1);
          this.lastSlowWriteAt = endedAt;
        }
      }
    }
  }

  snapshot() {
    const now = this.readNow();
    const age = (at: number | null) => (now !== null && at !== null ? Math.max(0, now - at) : null);
    return {
      attempts: this.attempts,
      failures: this.failures,
      slowWrites: this.slowWrites,
      activeWrites: this.activeWrites,
      lastWriteDurationMs: this.lastWriteDurationMs,
      maxWriteDurationMs: this.maxWriteDurationMs,
      lastSlowWriteAgoMs: age(this.lastSlowWriteAt),
      lastFailureAgoMs: age(this.lastFailureAt),
    };
  }

  private readNow(): number | null {
    try {
      const value = (this.options.now ?? (() => performance.now()))();
      return finiteMeasurement(value) ? value : null;
    } catch {
      return null;
    }
  }
}
