import { reinforceRepositoryAgentMemoryRefs, type MemoryStore } from "shared";
import type { AutonomyStore, RepositoryAgentMemoryFeedbackRow } from "./autonomy.js";

export interface RepositoryAgentMemoryFeedbackLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface RepositoryAgentMemoryFeedbackBatchResult {
  scanned: number;
  applied: number;
  deferred: number;
  missingRecords: number;
  staleRecords: number;
}

/**
 * Apply one bounded batch of already-reconciled authoritative outcomes.
 * The durable observation ID makes a crash after memory reinforcement but
 * before queue acknowledgement safe to replay.
 */
export async function applyRepositoryAgentMemoryFeedbackBatch(input: {
  autonomyStore: Pick<
    AutonomyStore,
    "claimRepositoryAgentMemoryFeedback" | "markRepositoryAgentMemoryFeedback"
  >;
  memoryStore: MemoryStore;
  limit?: number;
  logger?: RepositoryAgentMemoryFeedbackLogger;
}): Promise<RepositoryAgentMemoryFeedbackBatchResult> {
  const logger = input.logger ?? console;
  const batchLimit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  let scanned = 0;
  let appliedCount = 0;
  let deferred = 0;
  let missingRecords = 0;
  let staleRecords = 0;

  while (scanned < batchLimit) {
    // Acquire one lease only when its work is about to start. This keeps a
    // bounded batch from consuming the lease time of later queue entries.
    const feedback = input.autonomyStore.claimRepositoryAgentMemoryFeedback(1, 5 * 60_000)[0];
    if (!feedback) break;
    scanned += 1;
    try {
      const result = await applyRepositoryAgentMemoryFeedback(input.memoryStore, feedback);
      const replacedRecords = result.failed.filter((entry) => entry.code === "record_conflict");
      const retryableFailures = result.failed.filter((entry) => entry.code !== "record_conflict");
      if (retryableFailures.length > 0) {
        throw new Error(
          `failed to reinforce ${retryableFailures.length}/${result.attempted} memory record(s): ${retryableFailures
            .map((entry) => `${entry.namespace}/${entry.key}: ${entry.message}`)
            .join("; ")}`,
        );
      }
      missingRecords += result.missing.length + replacedRecords.length;
      staleRecords += replacedRecords.length;
      if (result.missing.length > 0 || replacedRecords.length > 0) {
        logger.warn(
          `[Memory] authoritative RepositoryAgent outcome ${feedback.observationId} referenced ` +
            `${result.missing.length} expired/removed and ${replacedRecords.length} replaced ` +
            `record(s); remaining records were applied.`,
        );
      }
      const acknowledged = input.autonomyStore.markRepositoryAgentMemoryFeedback(
        feedback.observationId,
        {
          claimToken: feedback.claimToken,
          claimGeneration: feedback.claimGeneration,
        },
        true,
      );
      if (!acknowledged) {
        throw new Error("feedback claim expired or was superseded before acknowledgement");
      }
      appliedCount += 1;
    } catch (error) {
      input.autonomyStore.markRepositoryAgentMemoryFeedback(
        feedback.observationId,
        {
          claimToken: feedback.claimToken,
          claimGeneration: feedback.claimGeneration,
        },
        false,
        error,
      );
      deferred += 1;
      logger.error(
        `[Memory] RepositoryAgent outcome reinforcement ${feedback.observationId} failed and will be retried: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
  }

  return {
    scanned,
    applied: appliedCount,
    deferred,
    missingRecords,
    staleRecords,
  };
}

async function applyRepositoryAgentMemoryFeedback(
  memoryStore: MemoryStore,
  feedback: RepositoryAgentMemoryFeedbackRow,
) {
  return reinforceRepositoryAgentMemoryRefs({
    memory: memoryStore,
    repositoryId: feedback.repositoryId,
    memoryRefs: feedback.memoryRefs,
    outcome: feedback.outcome,
    observationId: feedback.observationId,
    // Weight is assigned by the server-side outcome classifier. The worker
    // must not reinterpret authority or infer quality from raw job status.
    weight: feedback.weight,
    provenance: {
      service: "server",
      requestId: feedback.repositoryAgentRequestId,
      runId: feedback.objectiveId,
    },
  });
}
