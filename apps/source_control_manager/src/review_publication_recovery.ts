import {
  getBranchHeadSha,
  getPullRequest,
  pullRequestHeadBelongsToRemoteRepository,
  type GitHubPR,
} from "./github_pr";
import type { ReviewPublicationLease } from "./review_publication";
import { resolveReconciledReviewValidationPlan } from "../../../packages/shared/src/review_publication_validation.js";
import { normalizeRepositoryOriginRemote } from "../../../packages/shared/src/repository_identity.js";
import {
  validationCheckpointNamespace,
  type ValidationRepairGitCommand,
} from "./validation_repair_publication";

export function assertReviewCompletionLease(
  branch: string,
  lease: ReviewPublicationLease | null,
): void {
  if (branch.startsWith("refs/pushpals/review/") && !lease) {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      "Review completion has a missing or malformed publication lease; refusing an unleased replacement PR.",
    );
  }
}

export class ReviewPublicationDeferredError extends Error {
  constructor(
    readonly code:
      | "review_base_moved"
      | "review_authority_unavailable"
      | "review_base_conflict"
      | "review_validation_pending"
      | "review_validation_unavailable",
    message: string,
    readonly detail: {
      candidateSha?: string;
      expectedBaseSha?: string;
      currentBaseSha?: string;
    } = {},
  ) {
    super(message);
    this.name = "ReviewPublicationDeferredError";
  }
}

/** Base coordination is not a failed/uncertain push. A reachable unchanged PR
 * head still requires another bounded claim, never an LLM repair retry. */
export function reviewPublicationFailureDisposition(
  deferred: ReviewPublicationDeferredError | null,
  publicationDisposition: "finalize" | "reconcile" | "fail",
): "finalize" | "reconcile" | "fail" {
  if (publicationDisposition === "finalize") return "finalize";
  if (
    deferred &&
    deferred.code !== "review_base_conflict" &&
    deferred.code !== "review_validation_unavailable"
  )
    return "reconcile";
  return publicationDisposition;
}

/** A host merge changes the tested tree even when it was restored from an
 * earlier claim's checkpoint. Its full original plan must run again. */
export function resolveReviewPublicationValidationCommands(options: {
  originalCandidateSha: string;
  candidateSha: string;
  claimGeneration: number;
  deferredCommandsJson: string | null;
  fullPlan: unknown;
}): string | null {
  if (options.candidateSha === options.originalCandidateSha) return options.deferredCommandsJson;
  const plan = resolveReconciledReviewValidationPlan(
    options.fullPlan,
    options.deferredCommandsJson,
  );
  if (plan.status === "ready") return JSON.stringify(plan.commands);
  // Completion enqueue precedes the final diagnostics upload. Allow that
  // bounded race, but do not strand legacy completions without a full plan.
  const pending = plan.status === "pending" && options.claimGeneration < 3;
  throw new ReviewPublicationDeferredError(
    pending ? "review_validation_pending" : "review_validation_unavailable",
    `${plan.reason ?? "Full validation authority is unavailable."} ${
      pending
        ? "Retaining the changed candidate for the next diagnostics-aware claim."
        : "Holding the retained candidate without publication or a duplicate worker retry."
    }`,
    { candidateSha: options.candidateSha },
  );
}

export type SupersededReviewPublication = {
  version: 1;
  code: "publication_superseded";
  repositoryIdentity: string;
  prNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  observedHeadSha: string;
  observedState: "open" | "closed";
};

export class ReviewPublicationSupersededError extends Error {
  constructor(readonly outcome: SupersededReviewPublication) {
    super(
      `Original PR #${outcome.prNumber} is ${outcome.observedState} at ${outcome.observedHeadSha.slice(0, 8)}; refusing superseded review publication.`,
    );
    this.name = "ReviewPublicationSupersededError";
  }
}

export type ReviewPublicationAuthority = {
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
};

export type ReviewPublicationClaimAuthority = {
  repositoryIdentity: string;
  prNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  resolutionType: string;
};

/** The completion's worker-side base may have been refreshed by the host at
 * execution start. Settlement still belongs to the server's original job tuple. */
export function buildReviewPublicationSettlement(options: {
  completionId: string;
  claimGeneration: number;
  lease: ReviewPublicationLease | null;
  claimedAuthority: ReviewPublicationClaimAuthority | null | undefined;
  superseded: ReviewPublicationSupersededError | null;
  observedAuthority: ReviewPublicationAuthority | null;
  checkpointPersisted: boolean;
  candidateSha: string | null;
  candidateRef: string | null;
  heldCode?: "publication_conflict" | "publication_validation_unavailable";
}): Record<string, unknown> {
  const claimed = options.claimedAuthority;
  const observedPrNumber =
    options.superseded?.outcome.prNumber ?? options.observedAuthority?.prNumber;
  const observedRepository =
    options.superseded?.outcome.repositoryIdentity ??
    options.observedAuthority?.prUrl.replace(/\/pull\/[1-9][0-9]*\/?$/, "") ??
    "";
  if (
    !claimed ||
    claimed.prNumber !== observedPrNumber ||
    claimed.expectedHeadSha !== options.lease?.expectedHeadSha ||
    !claimed.repositoryIdentity ||
    normalizeRepositoryOriginRemote(claimed.repositoryIdentity).toLowerCase() !==
      normalizeRepositoryOriginRemote(observedRepository).toLowerCase() ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(claimed.expectedBaseSha)
  ) {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      "Claim response lacks matching durable review-job authority for neutral publication settlement; retaining candidate without guessing the original lease.",
    );
  }
  if (options.superseded)
    return {
      ...options.superseded.outcome,
      repositoryIdentity: claimed.repositoryIdentity,
      expectedHeadSha: claimed.expectedHeadSha,
      expectedBaseSha: claimed.expectedBaseSha,
    };
  const checkpointPrefix = `${validationCheckpointNamespace(options.completionId)}/`;
  const checkpointGeneration = options.candidateRef?.startsWith(checkpointPrefix)
    ? options.candidateRef.slice(checkpointPrefix.length).match(/^([1-9][0-9]*)\/candidate$/)?.[1]
    : null;
  if (
    !options.observedAuthority ||
    !options.checkpointPersisted ||
    !options.candidateSha ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.candidateSha) ||
    !checkpointGeneration ||
    !Number.isSafeInteger(Number(checkpointGeneration)) ||
    Number(checkpointGeneration) > options.claimGeneration
  ) {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      "Held publication candidate retention is not proven; preserving the completion for safe host recovery.",
    );
  }
  return {
    version: 1,
    code: options.heldCode ?? "publication_conflict",
    repositoryIdentity: claimed.repositoryIdentity,
    prNumber: claimed.prNumber,
    expectedHeadSha: claimed.expectedHeadSha,
    expectedBaseSha: claimed.expectedBaseSha,
    observedHeadSha: options.observedAuthority.headSha,
    observedBaseSha: options.observedAuthority.baseSha,
    observedState: "open",
    retainedCandidateSha: options.candidateSha,
    retainedCandidateRef: options.candidateRef,
  };
}

/** PR.base.sha is a diff snapshot, not authoritative evidence of the target ref. */
export async function resolveReviewPublicationAuthority(options: {
  token: string;
  remoteUrl: string;
  prUrl: string | null;
  lease: ReviewPublicationLease;
  publishedCandidateSha?: string;
  publishedRecoveryProven?: boolean;
  getPr?: (options: { token: string; remoteUrl: string; prNumber: number }) => Promise<GitHubPR>;
  getBase?: (options: { token: string; remoteUrl: string; branchRef: string }) => Promise<string>;
}): Promise<ReviewPublicationAuthority> {
  const normalizeUrl = (value: string) => value.replace(/\/+$/, "").toLowerCase();
  let prNumber: number;
  try {
    const url = new URL(options.prUrl ?? "");
    const match = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)\/?$/);
    if (url.protocol !== "https:" || !match || !options.lease.baseBranch)
      throw new Error("missing original PR or base branch");
    prNumber = Number(match[1]);
    if (!Number.isSafeInteger(prNumber)) throw new Error("invalid PR number");
  } catch {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      "Review publication requires the original PR URL and exact base branch; refusing creation of a replacement PR.",
    );
  }
  let pr: GitHubPR;
  let baseSha: string;
  try {
    pr = await (options.getPr ?? getPullRequest)({
      token: options.token,
      remoteUrl: options.remoteUrl,
      prNumber,
    });
    if (
      pr.number !== prNumber ||
      !["open", "closed"].includes(pr.state) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pr.head?.sha ?? "") ||
      normalizeUrl(pr.html_url) !== normalizeUrl(options.prUrl!) ||
      pr.head?.ref !== options.lease.targetBranch ||
      pr.base?.ref !== options.lease.baseBranch ||
      !pullRequestHeadBelongsToRemoteRepository(pr, options.remoteUrl)
    )
      throw new Error("provider returned incompatible original PR metadata");
  } catch (error) {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      `Unable to verify original PR publication authority: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const headSha = pr.head.sha.toLowerCase();
  const recoveringPublishedCandidate =
    options.publishedRecoveryProven === true && headSha === options.publishedCandidateSha;
  if (
    (pr.state === "closed" && !recoveringPublishedCandidate) ||
    (headSha !== options.lease.expectedHeadSha && !recoveringPublishedCandidate)
  ) {
    throw new ReviewPublicationSupersededError({
      version: 1,
      code: "publication_superseded",
      repositoryIdentity: options.remoteUrl,
      prNumber,
      expectedHeadSha: options.lease.expectedHeadSha,
      expectedBaseSha: options.lease.expectedBaseSha ?? "",
      observedHeadSha: headSha,
      observedState: pr.state as "open" | "closed",
    });
  }
  try {
    baseSha = await (options.getBase ?? getBranchHeadSha)({
      token: options.token,
      remoteUrl: options.remoteUrl,
      branchRef: options.lease.baseBranch!,
    });
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseSha))
      throw new Error("target ref is not an exact commit");
  } catch (error) {
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      `Unable to resolve live review base: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { prNumber, prUrl: pr.html_url, headSha, baseSha: baseSha.toLowerCase() };
}

/** One bounded host merge per claim, retaining every original worker commit.
 * Callers must checkpoint and validate the returned SHA before any push. */
export async function prepareReviewPublicationCandidate(options: {
  completionId: string;
  candidateSha: string;
  baseSha: string;
  git: ValidationRepairGitCommand;
  commitIdentity: { name: string; email: string } | null;
}): Promise<{ candidateSha: string; baseSha: string; reconciled: boolean }> {
  const { git, candidateSha, baseSha } = options;
  for (const sha of [candidateSha, baseSha]) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
      throw new Error("Review reconciliation requires exact commit SHAs.");
    const result = await git(["rev-parse", "--verify", `${sha}^{commit}`]);
    if (!result.ok || result.stdout.trim().toLowerCase() !== sha)
      throw new Error(`Review reconciliation cannot resolve ${sha}.`);
  }
  const status = await git(["status", "--porcelain"]);
  const head = await git(["rev-parse", "HEAD"]);
  if (
    !status.ok ||
    status.stdout.trim() ||
    !head.ok ||
    head.stdout.trim().toLowerCase() !== candidateSha
  )
    throw new Error(
      "Review reconciliation requires the exact clean disposable candidate checkout.",
    );
  const containsBase = await git(["merge-base", "--is-ancestor", baseSha, candidateSha]);
  if (containsBase.ok) return { candidateSha, baseSha, reconciled: false };
  if (containsBase.exitCode !== 1)
    throw new Error(`Unable to compare review candidate with base: ${containsBase.stderr}`);
  const conflictRef = `${validationCheckpointNamespace(options.completionId)}/conflicts/${baseSha}/${candidateSha}`;
  const remembered = await git(["rev-parse", "--verify", "--quiet", conflictRef]);
  if (remembered.ok) {
    if (remembered.stdout.trim().toLowerCase() !== candidateSha)
      throw new Error("Retained review conflict evidence is inconsistent.");
    throw new ReviewPublicationDeferredError(
      "review_base_conflict",
      "Unchanged candidate/base conflict remains held for resolution; not rerunning validation or worker coding.",
      { candidateSha, currentBaseSha: baseSha },
    );
  }
  if (remembered.exitCode !== 1)
    throw new Error(`Unable to inspect retained review conflict evidence: ${remembered.stderr}`);
  const identity = options.commitIdentity;
  if (!identity?.name || !identity.email)
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      "Host commit identity is unavailable for review-base reconciliation.",
    );
  const config = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
  ];
  const merged = await git([...config, "merge", "--no-ff", "--no-commit", "--no-edit", baseSha]);
  if (!merged.ok) {
    const conflicts = await git(["diff", "--name-only", "--diff-filter=U"]);
    const mergeHead = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
    if (mergeHead.ok) {
      const aborted = await git(["merge", "--abort"]);
      if (!aborted.ok)
        throw new Error(`Unable to abort disposable review reconciliation: ${aborted.stderr}`);
    } else if (mergeHead.exitCode !== 1) {
      throw new Error(`Unable to inspect disposable merge state: ${mergeHead.stderr}`);
    }
    const restored = await git(["status", "--porcelain"]);
    const restoredHead = await git(["rev-parse", "HEAD"]);
    if (
      !restored.ok ||
      restored.stdout.trim() ||
      !restoredHead.ok ||
      restoredHead.stdout.trim() !== candidateSha
    ) {
      throw new Error(
        "Failed review-base merge did not restore the exact clean retained candidate.",
      );
    }
    if (conflicts.ok && conflicts.stdout.trim()) {
      const retained = await git([
        "update-ref",
        conflictRef,
        candidateSha,
        "0".repeat(candidateSha.length),
      ]);
      if (!retained.ok)
        throw new Error(`Unable to retain review conflict checkpoint: ${retained.stderr}`);
      throw new ReviewPublicationDeferredError(
        "review_base_conflict",
        `Review base reconciliation has content conflicts in ${conflicts.stdout.trim().split(/\r?\n/).slice(0, 12).join(", ")}; original candidate retained for resolution.`,
        { candidateSha, currentBaseSha: baseSha },
      );
    }
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      `Host review-base merge could not complete: ${merged.stderr || merged.stdout}`,
      { candidateSha, currentBaseSha: baseSha },
    );
  }
  const committed = await git([
    ...config,
    "commit",
    "--no-verify",
    "-m",
    `Merge current review base ${baseSha.slice(0, 12)} into preserved candidate`,
  ]);
  if (!committed.ok) {
    await git(["merge", "--abort"]);
    throw new ReviewPublicationDeferredError(
      "review_authority_unavailable",
      `Host review-base reconciliation commit failed: ${committed.stderr || committed.stdout}`,
    );
  }
  const prepared = await git(["rev-parse", "HEAD"]);
  const resultSha = prepared.stdout.trim().toLowerCase();
  if (!prepared.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resultSha))
    throw new Error("Unable to resolve reconciled candidate.");
  for (const ancestor of [candidateSha, baseSha]) {
    if (!(await git(["merge-base", "--is-ancestor", ancestor, resultSha])).ok) {
      throw new Error(
        "Reconciled review commit failed original-candidate/base ancestry verification.",
      );
    }
  }
  const clean = await git(["status", "--porcelain"]);
  if (!clean.ok || clean.stdout.trim())
    throw new Error("Reconciled review commit is not an exact clean checkout.");
  return { candidateSha: resultSha, baseSha, reconciled: true };
}

export function assertReviewPublicationBaseUnchanged(
  expectedBaseSha: string,
  current: ReviewPublicationAuthority,
): void {
  if (current.baseSha !== expectedBaseSha)
    throw new ReviewPublicationDeferredError(
      "review_base_moved",
      `Review target base advanced from ${expectedBaseSha.slice(0, 8)} to ${current.baseSha.slice(0, 8)} during validation; retaining the candidate for a fresh bounded host reconciliation.`,
      { expectedBaseSha, currentBaseSha: current.baseSha },
    );
}
