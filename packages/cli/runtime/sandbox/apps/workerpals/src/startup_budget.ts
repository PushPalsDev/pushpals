import {
  WORKER_STARTUP_CLEANUP_GRACE_MS,
  WORKER_STARTUP_DEADLINE_ENV,
  WORKER_STARTUP_TIMEOUT_ENV,
  workerStartupAllowanceMs,
  workerStartupPhaseTimeoutMs,
  type WorkerStartupPhase,
} from "shared";
import { JobDeadlineLedger } from "./quality_loop_durability.js";

/** One startup ceiling, including cleanup; never retained by normal job execution. */
export class WorkerStartupBudget {
  private readonly total: JobDeadlineLedger;
  private active: {
    ledger: JobDeadlineLedger;
    cleanup: boolean;
    report: (bytes: number) => void;
  } | null = null;
  private cancelled = false;
  private cleanupDepth = 0;
  private readonly startedPhases = new Set<WorkerStartupPhase>();
  readonly normalTimeoutMs: number;

  constructor(options: {
    normalTimeoutMs: number;
    docker: boolean;
    env?: Record<string, string | undefined>;
    now?: () => number;
    monotonicNow?: () => number;
    log?: (line: string) => void;
  }) {
    this.options = options;
    const env = options.env ?? process.env;
    const configured = Number(env[WORKER_STARTUP_TIMEOUT_ENV]);
    this.normalTimeoutMs =
      Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : Number.isFinite(options.normalTimeoutMs) && options.normalTimeoutMs > 0
          ? Math.max(1, Math.floor(options.normalTimeoutMs))
          : 120_000;
    const now = (options.now ?? Date.now)();
    const inheritedDeadline = Number(env[WORKER_STARTUP_DEADLINE_ENV]);
    const allowance = workerStartupAllowanceMs(this.normalTimeoutMs, options.docker);
    const budget =
      Number.isFinite(inheritedDeadline) && inheritedDeadline > 0
        ? Math.max(0, Math.min(allowance, inheritedDeadline - now))
        : allowance;
    this.total = new JobDeadlineLedger({
      executionBudgetMs: budget,
      finalizationBudgetMs: 0,
      now: options.now,
      monotonicNow: options.monotonicNow,
    });
  }

  private readonly options: {
    normalTimeoutMs: number;
    docker: boolean;
    env?: Record<string, string | undefined>;
    now?: () => number;
    monotonicNow?: () => number;
    log?: (line: string) => void;
  };

  cancel(): void {
    this.cancelled = true;
  }

  workLedger(): JobDeadlineLedger {
    return this.active?.ledger ?? this.total;
  }

  capTimeout(requestedMs: number, forCleanup = false): number {
    // Cleanup scope selects the reserve; only explicitly marked cleanup commands
    // may run after cancellation. An overlapping startup continuation stays fenced.
    if (this.cancelled && !forCleanup) return 0;
    const phaseRemaining = this.active
      ? this.active.cleanup || forCleanup
        ? this.active.ledger.remainingTotalMs()
        : this.active.ledger.remainingWorkMs()
      : this.total.remainingTotalMs();
    return Math.max(
      0,
      Math.min(Math.floor(requestedMs), phaseRemaining, this.total.remainingTotalMs()),
    );
  }

  async cleanup<T>(action: () => Promise<T>): Promise<T> {
    const active = this.active;
    this.cleanupDepth += 1;
    if (active) active.cleanup = true;
    try {
      return await action();
    } finally {
      this.cleanupDepth -= 1;
      if (active) active.cleanup = this.cleanupDepth > 0;
    }
  }

  output(bytes: number): void {
    this.active?.report(bytes);
  }

  async phase<T>(
    phase: WorkerStartupPhase,
    action: (timeoutMs: number) => Promise<T>,
    succeeded: (result: T) => boolean = () => true,
    timeoutLimitMs = Number.POSITIVE_INFINITY,
  ): Promise<T> {
    if (this.active) throw new Error("Worker startup phases must not overlap");
    if (this.startedPhases.has(phase))
      throw new Error(`Worker startup phase already attempted: ${phase}`);
    const timeoutMs = Math.max(
      0,
      Math.min(
        workerStartupPhaseTimeoutMs(phase, this.normalTimeoutMs),
        timeoutLimitMs,
        this.total.remainingTotalMs() -
          WORKER_STARTUP_CLEANUP_GRACE_MS -
          Math.min(10_000, this.normalTimeoutMs),
      ),
    );
    if (this.cancelled || timeoutMs <= 0)
      throw new Error(`Worker startup deadline expired before ${phase}`);
    this.startedPhases.add(phase);
    const ledger = new JobDeadlineLedger({
      executionBudgetMs: timeoutMs,
      finalizationBudgetMs: WORKER_STARTUP_CLEANUP_GRACE_MS,
      now: this.options.now,
      monotonicNow: this.options.monotonicNow,
    });
    let outputBytes = 0;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    const report = (event: "start" | "progress" | "complete" | "failed") => {
      const elapsedMs = timeoutMs + WORKER_STARTUP_CLEANUP_GRACE_MS - ledger.remainingTotalMs();
      (this.options.log ?? console.log)(
        `[WorkerPalStartup] ${JSON.stringify({ phase, event, timeoutMs, elapsedMs, outputBytes })}`,
      );
    };
    this.active = {
      ledger,
      cleanup: false,
      report: (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + Math.floor(bytes));
        const elapsed = timeoutMs + WORKER_STARTUP_CLEANUP_GRACE_MS - ledger.remainingTotalMs();
        if (elapsed - lastProgressAt < 1_000) return;
        lastProgressAt = elapsed;
        report("progress");
      },
    };
    report("start");
    try {
      const result = await action(timeoutMs);
      if (this.cancelled) throw new Error("Worker startup cancelled");
      if (this.total.remainingTotalMs() <= 0 || ledger.remainingTotalMs() <= 0) {
        throw new Error(`Worker startup deadline expired during ${phase}`);
      }
      report(succeeded(result) ? "complete" : "failed");
      return result;
    } catch (error) {
      report("failed");
      throw error;
    } finally {
      this.active = null;
    }
  }
}
