import { resolveReconciledReviewValidationPlan } from "../../../packages/shared/src/review_publication_validation.js";
import type { ValidationRepairGitCommand } from "./validation_repair_publication";

/** Ordinary publications do not have PR repair authority. Never route missing
 * validation evidence into the PR-authority reconciliation state machine. */
export class PublicationValidationUnavailableError extends Error {
  constructor(
    readonly pending: boolean,
    message: string,
  ) {
    super(message);
    this.name = "PublicationValidationUnavailableError";
  }
}

export type PublicationValidationBinding = {
  workerTreeSha: string | null;
  candidateTreeSha: string | null;
  planSource: "identical_worker_tree" | "full_worker_plan";
};

/** Commit identities can differ after a clean cherry-pick while their trees
 * remain identical. Conversely, even one unrelated base edit invalidates the
 * old worker evidence. Missing objects/read failures fail closed to full gates. */
export async function resolveOrdinaryPublicationValidation(options: {
  originalCandidateSha: string;
  candidateSha: string;
  claimGeneration: number;
  deferredCommandsJson: string | null;
  fullPlan: unknown;
  git: ValidationRepairGitCommand;
}): Promise<{ commandsJson: string | null; binding: PublicationValidationBinding }> {
  const tree = async (sha: string): Promise<string | null> => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) return null;
    try {
      const result = await options.git(["rev-parse", "--verify", `${sha}^{tree}`]);
      const value = result.stdout.trim();
      return result.ok && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
        ? value.toLowerCase()
        : null;
    } catch {
      return null;
    }
  };
  const workerTreeSha = await tree(options.originalCandidateSha);
  const candidateTreeSha = await tree(options.candidateSha);
  if (workerTreeSha && workerTreeSha === candidateTreeSha) {
    return {
      commandsJson: options.deferredCommandsJson,
      binding: { workerTreeSha, candidateTreeSha, planSource: "identical_worker_tree" },
    };
  }
  const plan = resolveReconciledReviewValidationPlan(
    options.fullPlan,
    options.deferredCommandsJson,
  );
  if (plan.status !== "ready") {
    // Two bounded claim recoveries accommodate enqueue racing the final
    // diagnostic upload. Invalid/oversized plans cannot improve by retrying.
    const pending = plan.status === "pending" && options.claimGeneration < 3;
    throw new PublicationValidationUnavailableError(
      pending,
      `${plan.reason ?? "Full worker validation authority is unavailable."} ${
        pending
          ? "Retaining the candidate for a bounded diagnostics-aware claim retry."
          : "Publication is held; the exact candidate is retained and other completions may proceed."
      }`,
    );
  }
  return {
    commandsJson: JSON.stringify(plan.commands),
    binding: { workerTreeSha, candidateTreeSha, planSource: "full_worker_plan" },
  };
}
