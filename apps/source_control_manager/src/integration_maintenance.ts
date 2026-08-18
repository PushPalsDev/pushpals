import type { SourceControlManagerConfig } from "./config";
import type { SourceControlApi } from "./git";
import { fetchBufferedWithHardDeadline } from "../../../packages/shared/src/bounded_fetch.js";
import {
  buildIntegrationReconciliationJob,
  type IntegrationReconciliationJobPayload,
} from "./integration_reconciliation";

export type IntegrationMaintenanceConfig = Pick<
  SourceControlManagerConfig,
  "remote" | "mainBranch" | "integrationBaseBranch" | "pushMainAfterMerge" | "serverUrl"
>;

type IntegrationMaintenanceGit = Pick<
  SourceControlApi,
  | "fetchPrune"
  | "alignMainToRemote"
  | "checkoutMain"
  | "pullMainFF"
  | "syncMainWithBaseBranch"
  | "pushMain"
  | "resetToClean"
>;

export type IntegrationMaintenanceOutcome =
  | { status: "skipped"; nextRunAtMs: number }
  | { status: "up_to_date"; nextRunAtMs: number }
  | { status: "reconciled"; nextRunAtMs: number; mergedHeadSha: string }
  | { status: "local_only"; nextRunAtMs: number; mergedHeadSha: string }
  | {
      status: "repair_dispatched" | "repair_deduped";
      nextRunAtMs: number;
      jobId: string;
      dedupeKey: string;
    }
  | { status: "retry_scheduled"; nextRunAtMs: number; error: string };

export interface IntegrationMaintenanceRunnerOptions {
  gitOps: IntegrationMaintenanceGit;
  sessionId: string;
  intervalMs: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  httpTimeoutMs?: number;
  logger?: {
    log(message: string): void;
    warn(message: string): void;
  };
}

type EnqueueResponseBody = {
  jobId?: unknown;
  deduped?: unknown;
  message?: unknown;
};

export class IntegrationMaintenanceRunner {
  private readonly gitOps: IntegrationMaintenanceGit;
  private readonly sessionId: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly httpTimeoutMs: number;
  private readonly logger: NonNullable<IntegrationMaintenanceRunnerOptions["logger"]>;
  private nextRunAtMs = 0;
  private lastObservedNowMs: number | null = null;
  private inFlight: Promise<IntegrationMaintenanceOutcome> | null = null;
  private stateKey = "startup";

  constructor(options: IntegrationMaintenanceRunnerOptions) {
    this.gitOps = options.gitOps;
    this.sessionId = options.sessionId;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMs));
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.httpTimeoutMs = Math.max(1, Math.floor(options.httpTimeoutMs ?? 10_000));
    this.logger = options.logger ?? {
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
    };
  }

  private logState(key: string, message: string, level: "log" | "warn" = "log"): void {
    if (this.stateKey === key) return;
    this.stateKey = key;
    this.logger[level](message);
  }

  run(
    runtimeConfig: IntegrationMaintenanceConfig,
    headers: Record<string, string>,
  ): Promise<IntegrationMaintenanceOutcome> {
    if (this.inFlight) return this.inFlight;

    const now = this.now();
    const clockMovedBackward = this.lastObservedNowMs !== null && now < this.lastObservedNowMs;
    this.lastObservedNowMs = now;
    if (!clockMovedBackward && now < this.nextRunAtMs) {
      return Promise.resolve({ status: "skipped", nextRunAtMs: this.nextRunAtMs });
    }
    this.nextRunAtMs = now + this.intervalMs;
    this.inFlight = this.execute(runtimeConfig, headers, now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async execute(
    runtimeConfig: IntegrationMaintenanceConfig,
    headers: Record<string, string>,
    now: number,
  ): Promise<IntegrationMaintenanceOutcome> {
    const timestamp = new Date(now).toISOString();

    try {
      await this.gitOps.fetchPrune();
      const alignedRemoteHead = await this.gitOps.alignMainToRemote();
      if (!alignedRemoteHead) {
        await this.gitOps.checkoutMain();
        await this.gitOps.pullMainFF();
      }
      const sync = await this.gitOps.syncMainWithBaseBranch();
      if (sync.status === "up_to_date") {
        this.logState(
          `healthy:${sync.integrationHeadSha}:${sync.baseHeadSha}`,
          `[${timestamp}] Integration branch ${runtimeConfig.remote}/${runtimeConfig.mainBranch} contains ${runtimeConfig.remote}/${runtimeConfig.integrationBaseBranch}; continuous dispatch is ready.`,
        );
        return { status: "up_to_date", nextRunAtMs: this.nextRunAtMs };
      }

      if (sync.status === "updated") {
        if (!runtimeConfig.pushMainAfterMerge) {
          this.logState(
            `updated-local:${sync.mergedHeadSha}`,
            `[${timestamp}] Integration branch ${runtimeConfig.mainBranch} was reconciled locally with ${runtimeConfig.integrationBaseBranch}, but push_main_after_merge=false prevents remote publication.`,
            "warn",
          );
          return {
            status: "local_only",
            nextRunAtMs: this.nextRunAtMs,
            mergedHeadSha: sync.mergedHeadSha,
          };
        }
        const push = await this.gitOps.pushMain();
        if (!push.ok) {
          throw new Error(
            `Failed to push reconciled ${runtimeConfig.mainBranch}: ${push.stderr || push.stdout}`,
          );
        }
        await this.gitOps.fetchPrune();
        this.logState(
          `reconciled:${sync.mergedHeadSha}`,
          `[${timestamp}] Reconciled ${runtimeConfig.remote}/${runtimeConfig.mainBranch} with ${runtimeConfig.remote}/${runtimeConfig.integrationBaseBranch} (${sync.integrationHeadSha.slice(0, 8)} -> ${sync.mergedHeadSha.slice(0, 8)}) and pushed the result.`,
        );
        return {
          status: "reconciled",
          nextRunAtMs: this.nextRunAtMs,
          mergedHeadSha: sync.mergedHeadSha,
        };
      }

      const payload: IntegrationReconciliationJobPayload = buildIntegrationReconciliationJob({
        sessionId: this.sessionId,
        integrationBranch: runtimeConfig.mainBranch,
        baseBranch: runtimeConfig.integrationBaseBranch,
        sync,
        now,
      });
      const response = await fetchBufferedWithHardDeadline({
        input: `${runtimeConfig.serverUrl}/jobs/enqueue`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        },
        timeoutMs: this.httpTimeoutMs,
        fetchImpl: this.fetchImpl,
        timeoutMessage: `Integration reconciliation enqueue timed out after ${this.httpTimeoutMs}ms`,
      });
      const responseBody = (await response.json().catch(() => null)) as EnqueueResponseBody | null;
      if (!response.ok) {
        throw new Error(
          `Failed to enqueue integration reconciliation job: HTTP ${response.status}${
            typeof responseBody?.message === "string" ? ` ${responseBody.message}` : ""
          }`,
        );
      }
      const jobId =
        typeof responseBody?.jobId === "string" && responseBody.jobId.trim()
          ? responseBody.jobId.trim()
          : "unknown";
      const deduped = responseBody?.deduped === true;
      this.logState(
        `repair:${payload.dedupeKey}:${jobId}`,
        `[${timestamp}] ${runtimeConfig.mainBranch} conflicts with ${runtimeConfig.integrationBaseBranch}; ${
          deduped ? "reusing" : "dispatched"
        } exact-lease integration reconciliation job ${jobId} for ${sync.conflictPaths.join(", ")}.`,
        "warn",
      );
      return {
        status: deduped ? "repair_deduped" : "repair_dispatched",
        nextRunAtMs: this.nextRunAtMs,
        jobId,
        dedupeKey: payload.dedupeKey,
      };
    } catch (err: unknown) {
      try {
        await this.gitOps.resetToClean();
      } catch {
        // The next maintenance tick retries from freshly fetched remote refs.
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.logState(
        `error:${detail}`,
        `[${timestamp}] Integration maintenance failed; SourceControlManager will retry without freezing autonomy: ${detail}`,
        "warn",
      );
      return {
        status: "retry_scheduled",
        nextRunAtMs: this.nextRunAtMs,
        error: detail,
      };
    }
  }
}

export async function maintainIntegrationBeforeCompletionClaim<T>(options: {
  maintain: () => Promise<unknown>;
  claimCompletion: () => Promise<T>;
}): Promise<T> {
  await options.maintain();
  return options.claimCompletion();
}
