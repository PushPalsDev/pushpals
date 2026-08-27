import type { JobResult, JobTokenUsage, JobUsageAttempt, JobUsageStage } from "./common/types.js";

// The ledger must not manufacture wall-clock time for short synthetic jobs.
// Individual process runners may enforce a larger launch floor, but the
// cross-phase ledger itself is exact down to one millisecond.
const MIN_PHASE_TIMEOUT_MS = 1;

function boundedBudget(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * One monotonic wall-clock ledger for an entire WorkerPal job. Revisions,
 * critics and dedicated repair gates borrow from the same deadline; none of
 * them can mint a fresh timeout. The finalization reserve is never exposed to
 * worker/critic/validation phases.
 */
export class JobDeadlineLedger {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly finalizationReserveMs: number;
  private readonly now: () => number;

  constructor(options: {
    executionBudgetMs: number;
    finalizationBudgetMs: number;
    startedAtMs?: number;
    now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = options.startedAtMs ?? this.now();
    const executionBudgetMs = boundedBudget(options.executionBudgetMs);
    this.finalizationReserveMs = boundedBudget(options.finalizationBudgetMs);
    this.deadlineAtMs = this.startedAtMs + executionBudgetMs + this.finalizationReserveMs;
  }

  remainingTotalMs(atMs = this.now()): number {
    return Math.max(0, Math.floor(this.deadlineAtMs - atMs));
  }

  remainingWorkMs(atMs = this.now()): number {
    return Math.max(0, this.remainingTotalMs(atMs) - this.finalizationReserveMs);
  }

  workExpired(atMs = this.now()): boolean {
    return this.remainingWorkMs(atMs) < MIN_PHASE_TIMEOUT_MS;
  }

  capWorkTimeout(requestedMs: number, minimumMs = MIN_PHASE_TIMEOUT_MS): number {
    const available = this.remainingWorkMs();
    if (available < minimumMs) return 0;
    const requested = boundedBudget(requestedMs);
    if (requested < minimumMs) return 0;
    return Math.min(requested, available);
  }

  executorBudgets(
    requestedExecutionMs: number,
    requestedFinalizationMs: number,
  ): {
    executionBudgetMs: number;
    finalizationBudgetMs: number;
  } | null {
    const executionBudgetMs = this.capWorkTimeout(requestedExecutionMs);
    if (executionBudgetMs <= 0) return null;
    const remainingAfterExecutionMs = Math.max(0, this.remainingTotalMs() - executionBudgetMs);
    return {
      executionBudgetMs,
      finalizationBudgetMs: Math.min(
        boundedBudget(requestedFinalizationMs),
        this.finalizationReserveMs,
        remainingAfterExecutionMs,
      ),
    };
  }

  snapshot(): Record<string, number> {
    return {
      startedAtMs: this.startedAtMs,
      deadlineAtMs: this.deadlineAtMs,
      finalizationReserveMs: this.finalizationReserveMs,
      remainingTotalMs: this.remainingTotalMs(),
      remainingWorkMs: this.remainingWorkMs(),
    };
  }
}

function normalizeUsage(usage: JobTokenUsage): JobTokenUsage {
  const promptTokens = Math.max(0, Math.floor(Number(usage.promptTokens) || 0));
  const completionTokens = Math.max(0, Math.floor(Number(usage.completionTokens) || 0));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: usage.estimated === true,
    ...(usage.backend ? { backend: usage.backend } : {}),
    ...(usage.modelId ? { modelId: usage.modelId } : {}),
  };
}

/** Accumulates every model call and retains stage/attempt provenance. */
export class UsageAccumulator {
  private readonly records: JobUsageAttempt[] = [];

  add(
    usage: JobTokenUsage | null | undefined,
    provenance: {
      stage: JobUsageStage;
      attempt: number;
      source: string;
      timedOut?: boolean;
    },
  ): void {
    if (!usage) return;
    const normalized = normalizeUsage(usage);
    this.records.push({ ...normalized, ...provenance });
  }

  addAttempts(attempts: JobUsageAttempt[] | null | undefined): void {
    for (const attempt of attempts ?? []) {
      const { stage, source, attempt: attemptNumber, timedOut, ...usage } = attempt;
      this.add(usage, {
        stage,
        source,
        attempt: attemptNumber,
        ...(timedOut === true ? { timedOut: true } : {}),
      });
    }
  }

  attempts(): JobUsageAttempt[] {
    return this.records.map((record) => ({ ...record }));
  }

  total(): JobTokenUsage | undefined {
    if (this.records.length === 0) return undefined;
    const promptTokens = this.records.reduce((sum, usage) => sum + usage.promptTokens, 0);
    const completionTokens = this.records.reduce((sum, usage) => sum + usage.completionTokens, 0);
    const backends = new Set(this.records.map((usage) => usage.backend).filter(Boolean));
    const models = new Set(this.records.map((usage) => usage.modelId).filter(Boolean));
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: this.records.some((usage) => usage.estimated === true),
      ...(backends.size === 1
        ? { backend: [...backends][0] }
        : backends.size > 1
          ? { backend: "mixed" }
          : {}),
      ...(models.size === 1 ? { modelId: [...models][0] } : {}),
    };
  }

  apply<T extends JobResult>(result: T): T {
    const usage = this.total();
    if (!usage) return result;
    return {
      ...result,
      usage,
      usageAttempts: this.attempts(),
      diagnostics: {
        ...(result.diagnostics ?? {}),
        metadata: {
          ...(result.diagnostics?.metadata ?? {}),
          usageAttemptCount: this.records.length,
          timedOutUsageAttemptCount: this.records.filter((record) => record.timedOut).length,
        },
      },
    };
  }
}
