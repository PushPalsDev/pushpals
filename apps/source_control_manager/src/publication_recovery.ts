export type PublicationAncestryCheck = (ancestor: string, descendant: string) => Promise<boolean>;

export type DurablePublicationRecoveryState = {
  skipPublicationMutation: boolean;
  protectFromTerminalFailure: boolean;
};

export type PublicationMutationResult = {
  ok: boolean;
  stdout?: string | null;
  stderr?: string | null;
};

export type AuthoritativeGitProbeResult = PublicationMutationResult & {
  exitCode: number;
};

export type AuthoritativePublicationReprobe = "published" | "absent" | "unreachable";

/**
 * The publication mutation crossed its side-effect boundary, but the
 * authoritative ref could not be read. This is deliberately distinct from a
 * reachable ref proving the candidate absent: marking the completion failed
 * while authority is unreachable can turn a successful push into a false
 * terminal failure.
 */
export class PublicationAuthorityUnreachableError extends Error {
  readonly mutationError: unknown;
  readonly probeError: unknown;

  constructor(options: { failurePrefix: string; mutationError?: unknown; probeError: unknown }) {
    const probeDetail =
      options.probeError instanceof Error
        ? options.probeError.message
        : String(options.probeError ?? "unknown authority error");
    super(
      `${options.failurePrefix}; authoritative publication state is unreachable: ${probeDetail}`,
    );
    this.name = "PublicationAuthorityUnreachableError";
    this.mutationError = options.mutationError;
    this.probeError = options.probeError;
  }
}

export class PublicationProofLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationProofLostError";
  }
}

function authoritativeGitFailureDetail(result: AuthoritativeGitProbeResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || "no output";
}

/**
 * `git rev-parse --verify --quiet` uses exit 1 for a missing ref. Every other
 * nonzero result is an operational failure and must remain distinguishable
 * from authoritative absence.
 */
export function authoritativeRefShaFromGitResult(
  result: AuthoritativeGitProbeResult,
  label: string,
): string | null {
  if (!result.ok) {
    if (result.exitCode === 1) return null;
    throw new Error(
      `Authoritative ref probe failed for ${label} (exit ${result.exitCode}): ${authoritativeGitFailureDetail(result)}`,
    );
  }
  const sha = String(result.stdout ?? "")
    .trim()
    .toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`Authoritative ref probe for ${label} returned a non-commit SHA.`);
  }
  return sha;
}

/** `git merge-base --is-ancestor` uses exit 1 for a definitive false. */
export function authoritativeAncestryFromGitResult(
  result: AuthoritativeGitProbeResult,
  label: string,
): boolean {
  if (result.ok) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `Authoritative ancestry probe failed for ${label} (exit ${result.exitCode}): ${authoritativeGitFailureDetail(result)}`,
  );
}

export type PublicationFailureDisposition = "finalize" | "reconcile" | "fail";

export function publicationFailureDisposition(options: {
  publicationReadyForFinalization: boolean;
  publicationAttemptUncertain: boolean;
  authoritativeReprobe: AuthoritativePublicationReprobe;
  validatedCheckpointRecoveryPending?: boolean;
}): PublicationFailureDisposition {
  if (options.publicationReadyForFinalization || options.authoritativeReprobe === "published") {
    return "finalize";
  }
  if (options.validatedCheckpointRecoveryPending) return "reconcile";
  if (options.publicationAttemptUncertain && options.authoritativeReprobe === "unreachable") {
    return "reconcile";
  }
  return "fail";
}

/**
 * Re-check the authoritative ref at the finalization boundary. Review PR heads
 * require exact equality, so a branch moved after push/PR creation cannot be
 * finalized from a stale earlier proof.
 */
export async function assertFinalAuthoritativePublicationProof(options: {
  provePublished: () => Promise<boolean>;
  failurePrefix: string;
}): Promise<void> {
  let published: boolean;
  try {
    published = await options.provePublished();
  } catch (probeError) {
    throw new PublicationAuthorityUnreachableError({
      failurePrefix: options.failurePrefix,
      probeError,
    });
  }
  if (!published) {
    throw new PublicationProofLostError(options.failurePrefix);
  }
}

export function durablePublicationRecoveryState(
  durablePublicationProven: boolean,
): DurablePublicationRecoveryState {
  return {
    skipPublicationMutation: durablePublicationProven,
    protectFromTerminalFailure: durablePublicationProven,
  };
}

export function shouldSkipValidationForDurableRecovery(options: {
  validationProven: boolean;
  publicationProven: boolean;
}): boolean {
  return options.validationProven && options.publicationProven;
}

/**
 * Remote commands can report failure after the server accepted the update.
 * Always ask the authoritative ref whether the exact validated candidate is
 * durable before deciding that publication failed.
 */
export async function publishWithAuthoritativeProof<T extends PublicationMutationResult>(options: {
  mutate: () => Promise<T>;
  provePublished: () => Promise<boolean>;
  failurePrefix: string;
}): Promise<{ result: T; recoveredFromAmbiguousFailure: boolean }> {
  let result: T;
  try {
    result = await options.mutate();
  } catch (error) {
    let published: boolean;
    try {
      published = await options.provePublished();
    } catch (probeError) {
      throw new PublicationAuthorityUnreachableError({
        failurePrefix: options.failurePrefix,
        mutationError: error,
        probeError,
      });
    }
    if (published) {
      return {
        result: {
          ok: false,
          stderr: error instanceof Error ? error.message : String(error),
        } as T,
        recoveredFromAmbiguousFailure: true,
      };
    }
    throw error;
  }

  let published: boolean;
  try {
    published = await options.provePublished();
  } catch (probeError) {
    throw new PublicationAuthorityUnreachableError({
      failurePrefix: options.failurePrefix,
      probeError,
    });
  }
  if (!published) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${options.failurePrefix}${detail ? `: ${detail}` : ""}`);
  }
  return { result, recoveredFromAmbiguousFailure: !result.ok };
}

/**
 * Selects the durable head that proves publication actually happened. A local
 * integration merge is authoritative only when remote pushing is disabled;
 * normal publication must be visible on remote main, and ReviewAgent
 * publication must be visible on its remote review branch.
 */
export async function isValidationCheckpointPublished(options: {
  candidateSha: string;
  localIntegrationHeadSha: string | null;
  remoteIntegrationHeadSha: string | null;
  reviewRemoteHeadSha: string | null;
  pushMainAfterMerge: boolean;
  useReviewPublicationFlow: boolean;
  isAncestor: PublicationAncestryCheck;
}): Promise<boolean> {
  const candidateSha = String(options.candidateSha ?? "").trim();
  if (!candidateSha) return false;

  const publicationHead = options.useReviewPublicationFlow
    ? options.reviewRemoteHeadSha
    : options.pushMainAfterMerge
      ? options.remoteIntegrationHeadSha
      : options.localIntegrationHeadSha;
  const normalizedHead = String(publicationHead ?? "").trim();
  if (!normalizedHead) return false;
  // An individual review branch is the PR head. A descendant can contain
  // additional unvalidated commits, so only exact equality proves that the PR
  // exposes the tree that crossed the validation barrier.
  if (options.useReviewPublicationFlow) {
    return normalizedHead.toLowerCase() === candidateSha.toLowerCase();
  }
  return options.isAncestor(candidateSha, normalizedHead);
}
