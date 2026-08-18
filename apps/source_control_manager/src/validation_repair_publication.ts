import { createHash } from "crypto";
import {
  validateValidationRepairPublicationLease as validateLease,
  type ValidationRepairPublicationLease,
} from "shared";
export {
  appendValidationRepairPublicationLease,
  parseValidationRepairPublicationLease,
  validationRepairPublicationLeaseFromJobParams,
  type ValidationRepairPublicationLease,
} from "shared";

export type ValidationRepairGitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  idempotent?: boolean;
};

export type ValidationRepairGitCommand = (args: string[]) => Promise<ValidationRepairGitResult>;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_REPAIR_CHAIN_COMMITS = 32;

function normalizeSha(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE.test(normalized) ? normalized : "";
}

export function validationCheckpointNamespace(completionId: string): string {
  const key = createHash("sha256").update(String(completionId)).digest("hex").slice(0, 32);
  return `refs/pushpals/validation/${key}`;
}

export function validationCheckpointRefs(
  completionId: string,
  claimGeneration: number,
): {
  baselineRef: string;
  candidateRef: string;
  validatedRef: string;
} {
  const generation = Math.max(1, Math.floor(claimGeneration));
  const namespace = validationCheckpointNamespace(completionId);
  return {
    baselineRef: `${namespace}/${generation}/baseline`,
    candidateRef: `${namespace}/${generation}/candidate`,
    validatedRef: `${namespace}/${generation}/validated`,
  };
}

async function immutableRefSha(
  git: ValidationRepairGitCommand,
  ref: string,
): Promise<string | null> {
  const result = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!result.ok) return null;
  const sha = normalizeSha(result.stdout);
  if (!sha) throw new Error(`Validation checkpoint ${ref} did not resolve to an exact commit.`);
  return sha;
}

export async function loadValidationCheckpoint(options: {
  completionId: string;
  claimGeneration: number;
  git: ValidationRepairGitCommand;
}): Promise<{
  baselineRef: string;
  baselineSha: string;
  candidateRef: string;
  candidateSha: string;
  validatedRef: string;
  validationProven: boolean;
} | null> {
  const refs = validationCheckpointRefs(options.completionId, options.claimGeneration);
  const [baselineSha, candidateSha, validatedSha] = await Promise.all([
    immutableRefSha(options.git, refs.baselineRef),
    immutableRefSha(options.git, refs.candidateRef),
    immutableRefSha(options.git, refs.validatedRef),
  ]);
  if (!baselineSha && !candidateSha && !validatedSha) return null;
  if (!baselineSha || !candidateSha) {
    throw new Error(
      `Validation checkpoint for completion ${options.completionId} is incomplete; refusing generic-base recovery.`,
    );
  }
  if (validatedSha && validatedSha !== candidateSha) {
    throw new Error(
      `Immutable validation-success proof ${refs.validatedRef} points to ${validatedSha}, not candidate ${candidateSha}.`,
    );
  }
  return {
    ...refs,
    baselineSha,
    candidateSha,
    validationProven: validatedSha === candidateSha,
  };
}

export async function loadLatestValidationCheckpoint(options: {
  completionId: string;
  beforeClaimGeneration: number;
  git: ValidationRepairGitCommand;
}): Promise<{
  claimGeneration: number;
  baselineRef: string;
  baselineSha: string;
  candidateRef: string;
  candidateSha: string;
  validatedRef: string;
  validationProven: boolean;
} | null> {
  const namespace = validationCheckpointNamespace(options.completionId);
  const listed = await options.git(["for-each-ref", "--format=%(refname)", `${namespace}/`]);
  if (!listed.ok) {
    throw new Error(
      `Failed to enumerate retained validation checkpoints for ${options.completionId}: ${listed.stderr || listed.stdout}.`,
    );
  }
  const generations = [
    ...new Set(
      listed.stdout
        .split(/\r?\n/)
        .map((ref) =>
          Number(ref.trim().match(new RegExp(`^${namespace}/([1-9][0-9]*)/candidate$`))?.[1]),
        )
        .filter(
          (generation) =>
            Number.isSafeInteger(generation) &&
            generation > 0 &&
            generation < options.beforeClaimGeneration,
        ),
    ),
  ].sort((a, b) => b - a);
  for (const claimGeneration of generations) {
    const checkpoint = await loadValidationCheckpoint({
      completionId: options.completionId,
      claimGeneration,
      git: options.git,
    });
    if (checkpoint) return { claimGeneration, ...checkpoint };
  }
  return null;
}

/**
 * Records that the exact immutable candidate checkpoint crossed every trusted
 * validation and configured-check barrier. Candidate refs are created before
 * validation so failures can be repaired; this separate ref is created only
 * after validation succeeds and must never be inferred from candidate presence.
 */
export async function persistValidationSuccessProof(options: {
  completionId: string;
  claimGeneration: number;
  candidateSha: string;
  git: ValidationRepairGitCommand;
}): Promise<{ validatedRef: string; candidateSha: string }> {
  const candidateSha = normalizeSha(options.candidateSha);
  if (!candidateSha) throw new Error("Validation-success proof requires an exact candidate SHA.");
  const checkpoint = await loadValidationCheckpoint({
    completionId: options.completionId,
    claimGeneration: options.claimGeneration,
    git: options.git,
  });
  if (!checkpoint || checkpoint.candidateSha !== candidateSha) {
    throw new Error(
      `Validation-success proof requires the matching immutable candidate checkpoint ${candidateSha}.`,
    );
  }
  const existing = await immutableRefSha(options.git, checkpoint.validatedRef);
  if (existing && existing !== candidateSha) {
    throw new Error(
      `Immutable validation-success proof ${checkpoint.validatedRef} already points to ${existing}, not ${candidateSha}.`,
    );
  }
  if (!existing) {
    const zeroOid = "0".repeat(candidateSha.length);
    const update = await options.git([
      "update-ref",
      checkpoint.validatedRef,
      candidateSha,
      zeroOid,
    ]);
    if (!update.ok) {
      const concurrent = await immutableRefSha(options.git, checkpoint.validatedRef);
      if (concurrent !== candidateSha) {
        throw new Error(
          `Failed atomic creation of validation-success proof ${checkpoint.validatedRef}: ${update.stderr || update.stdout}.`,
        );
      }
    }
  }
  const verified = await immutableRefSha(options.git, checkpoint.validatedRef);
  if (verified !== candidateSha) {
    throw new Error(
      `Validation-success proof ${checkpoint.validatedRef} failed exact-SHA verification after update.`,
    );
  }
  return { validatedRef: checkpoint.validatedRef, candidateSha };
}

export async function persistValidationCheckpoint(options: {
  completionId: string;
  claimGeneration: number;
  baselineSha: string;
  candidateSha: string;
  git: ValidationRepairGitCommand;
}): Promise<{
  baselineRef: string;
  baselineSha: string;
  candidateRef: string;
  candidateSha: string;
  validatedRef: string;
  validationProven: boolean;
}> {
  const baselineSha = normalizeSha(options.baselineSha);
  const candidateSha = normalizeSha(options.candidateSha);
  if (!baselineSha || !candidateSha || baselineSha === candidateSha) {
    throw new Error("Validation checkpoint requires distinct exact baseline and candidate SHAs.");
  }
  await resolveExactCommit(options.git, baselineSha, "validation baseline");
  await resolveExactCommit(options.git, candidateSha, "tested candidate");
  await requireAncestor(
    options.git,
    baselineSha,
    candidateSha,
    `tested candidate ${candidateSha} is not descended from validation baseline ${baselineSha}`,
  );
  const refs = validationCheckpointRefs(options.completionId, options.claimGeneration);
  for (const [ref, sha] of [
    [refs.baselineRef, baselineSha],
    [refs.candidateRef, candidateSha],
  ] as const) {
    const existing = await immutableRefSha(options.git, ref);
    if (existing && existing !== sha) {
      throw new Error(
        `Immutable validation checkpoint ${ref} already points to ${existing}, not ${sha}.`,
      );
    }
    if (!existing) {
      const zeroOid = "0".repeat(sha.length);
      const update = await options.git(["update-ref", ref, sha, zeroOid]);
      if (!update.ok) {
        const concurrent = await immutableRefSha(options.git, ref);
        if (concurrent !== sha) {
          throw new Error(
            `Failed atomic creation of trusted-validation checkpoint ${ref}: ${update.stderr || update.stdout}.`,
          );
        }
      }
    }
    const verified = await immutableRefSha(options.git, ref);
    if (verified !== sha) {
      throw new Error(`Validation checkpoint ${ref} failed exact-SHA verification after update.`);
    }
  }
  const validatedSha = await immutableRefSha(options.git, refs.validatedRef);
  if (validatedSha && validatedSha !== candidateSha) {
    throw new Error(
      `Immutable validation-success proof ${refs.validatedRef} points to ${validatedSha}, not candidate ${candidateSha}.`,
    );
  }
  return {
    ...refs,
    baselineSha,
    candidateSha,
    validationProven: validatedSha === candidateSha,
  };
}

async function resolveExactCommit(
  git: ValidationRepairGitCommand,
  sha: string,
  label: string,
): Promise<string> {
  const result = await git(["rev-parse", "--verify", `${sha}^{commit}`]);
  const resolved = result.ok ? normalizeSha(result.stdout) : "";
  if (!resolved || resolved !== sha) {
    throw new Error(
      `Validation-repair publication lease could not verify exact ${label} ${sha}: ${result.stderr || result.stdout || "revision unavailable"}.`,
    );
  }
  return resolved;
}

async function requireAncestor(
  git: ValidationRepairGitCommand,
  ancestor: string,
  descendant: string,
  detail: string,
): Promise<void> {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (!result.ok) {
    throw new Error(`Validation-repair publication lease mismatch: ${detail}.`);
  }
}

/**
 * Returns the exact baseline for the tree that was actually validated. Review
 * completions can be checked out directly from a worker branch while the SCM
 * integration worktree is on a sibling commit. In that case the integration
 * head is not a valid baseline for the candidate; their merge-base is.
 */
export async function resolveValidationCheckpointBaseline(options: {
  preApplyBaselineSha: string;
  candidateSha: string;
  git: ValidationRepairGitCommand;
}): Promise<string> {
  const preApplyBaselineSha = normalizeSha(options.preApplyBaselineSha);
  const candidateSha = normalizeSha(options.candidateSha);
  if (!preApplyBaselineSha || !candidateSha) {
    throw new Error("Validation checkpoint baseline resolution requires exact SHAs.");
  }
  await resolveExactCommit(options.git, preApplyBaselineSha, "pre-apply baseline");
  await resolveExactCommit(options.git, candidateSha, "tested candidate");
  const directAncestry = await options.git([
    "merge-base",
    "--is-ancestor",
    preApplyBaselineSha,
    candidateSha,
  ]);
  if (directAncestry.ok) return preApplyBaselineSha;

  const mergeBase = await options.git(["merge-base", preApplyBaselineSha, candidateSha]);
  const exactMergeBase = mergeBase.ok ? normalizeSha(mergeBase.stdout) : "";
  if (!exactMergeBase) {
    throw new Error(
      `Unable to derive an exact trusted-validation baseline for candidate ${candidateSha}: ${mergeBase.stderr || mergeBase.stdout || "no merge base"}.`,
    );
  }
  await requireAncestor(
    options.git,
    exactMergeBase,
    candidateSha,
    `derived baseline ${exactMergeBase} is not an ancestor of candidate ${candidateSha}`,
  );
  return exactMergeBase;
}

export async function applyRetainedValidationCheckpoint(options: {
  baselineSha: string;
  candidateSha: string;
  currentIntegrationSha: string;
  git: ValidationRepairGitCommand;
}): Promise<ValidationRepairGitResult> {
  const baselineSha = normalizeSha(options.baselineSha);
  const candidateSha = normalizeSha(options.candidateSha);
  const currentIntegrationSha = normalizeSha(options.currentIntegrationSha);
  if (!baselineSha || !candidateSha || !currentIntegrationSha) {
    throw new Error(
      "Retained validation replay requires exact baseline, candidate, and integration SHAs.",
    );
  }
  await resolveExactCommit(options.git, baselineSha, "retained baseline");
  await resolveExactCommit(options.git, candidateSha, "retained candidate");
  await resolveExactCommit(options.git, currentIntegrationSha, "current integration head");
  await requireAncestor(
    options.git,
    baselineSha,
    candidateSha,
    `retained candidate ${candidateSha} is not descended from baseline ${baselineSha}`,
  );
  await requireAncestor(
    options.git,
    baselineSha,
    currentIntegrationSha,
    `current integration head ${currentIntegrationSha} is not descended from retained baseline ${baselineSha}`,
  );
  const chainResult = await options.git([
    "rev-list",
    "--reverse",
    "--ancestry-path",
    `${baselineSha}..${candidateSha}`,
  ]);
  const chain = chainResult.ok
    ? chainResult.stdout
        .split(/\r?\n/)
        .map((value) => normalizeSha(value))
        .filter(Boolean)
    : [];
  if (
    !chainResult.ok ||
    chain.length < 1 ||
    chain.length > MAX_REPAIR_CHAIN_COMMITS ||
    chain.at(-1) !== candidateSha
  ) {
    throw new Error(
      `Retained validation replay refused an invalid or oversized commit chain (${chain.length} commits): ${chainResult.stderr || chainResult.stdout}.`,
    );
  }
  const cherryResult = await options.git([
    "cherry",
    currentIntegrationSha,
    candidateSha,
    baselineSha,
  ]);
  if (!cherryResult.ok) {
    throw new Error(
      `Retained validation replay could not compare patch equivalence: ${cherryResult.stderr || cherryResult.stdout}.`,
    );
  }
  const equivalent = new Set(
    cherryResult.stdout
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .match(/^-\s+([0-9a-f]{40,64})(?:\s|$)/i)?.[1]
          ?.toLowerCase(),
      )
      .filter((sha): sha is string => Boolean(sha)),
  );
  const applied: string[] = [];
  for (const commitSha of chain) {
    const ancestor = await options.git([
      "merge-base",
      "--is-ancestor",
      commitSha,
      currentIntegrationSha,
    ]);
    if (ancestor.ok || equivalent.has(commitSha)) continue;
    const result = await options.git(["cherry-pick", commitSha]);
    if (!result.ok) {
      return {
        ...result,
        stderr: [
          result.stderr,
          `Failed while replaying retained trusted-validation commit ${commitSha}.`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    applied.push(commitSha);
  }
  return applied.length > 0
    ? {
        ok: true,
        stdout: `Replayed ${applied.length} retained trusted-validation commit(s).`,
        stderr: "",
        exitCode: 0,
      }
    : {
        ok: true,
        stdout: `Retained trusted-validation candidate ${candidateSha} is already integrated.`,
        stderr: "",
        exitCode: 0,
        idempotent: true,
      };
}

/**
 * Applies the complete leased baseline -> candidate -> repair chain onto the
 * current integration checkout. This deliberately does not cherry-pick only
 * the final repair commit: doing so would validate B+C and publish only C.
 */
export async function applyValidationRepairPublication(options: {
  lease: ValidationRepairPublicationLease;
  completionSha: string;
  currentIntegrationSha: string;
  git: ValidationRepairGitCommand;
}): Promise<ValidationRepairGitResult> {
  const lease = validateLease(options.lease);
  const completionSha = normalizeSha(options.completionSha);
  const currentIntegrationSha = normalizeSha(options.currentIntegrationSha);
  if (!completionSha || completionSha !== lease.expectedCompletionSha) {
    throw new Error(
      `Validation-repair publication lease expected completion ${lease.expectedCompletionSha}, received ${options.completionSha}.`,
    );
  }
  if (!currentIntegrationSha) {
    throw new Error("Validation-repair publication requires an exact current integration SHA.");
  }

  await resolveExactCommit(options.git, lease.baselineSha, "baseline");
  await resolveExactCommit(options.git, lease.candidateSha, "candidate");
  await resolveExactCommit(options.git, completionSha, "completion");
  await resolveExactCommit(options.git, currentIntegrationSha, "current integration head");
  const retainedCandidate = await options.git([
    "rev-parse",
    "--verify",
    `${lease.candidateRef}^{commit}`,
  ]);
  if (!retainedCandidate.ok || normalizeSha(retainedCandidate.stdout) !== lease.candidateSha) {
    throw new Error(
      `Validation-repair publication lease mismatch: retained candidate ref ${lease.candidateRef} does not resolve to ${lease.candidateSha}.`,
    );
  }
  await requireAncestor(
    options.git,
    lease.baselineSha,
    lease.candidateSha,
    `candidate ${lease.candidateSha} is not descended from baseline ${lease.baselineSha}`,
  );
  await requireAncestor(
    options.git,
    lease.candidateSha,
    completionSha,
    `completion ${completionSha} is not descended from candidate ${lease.candidateSha}`,
  );
  await requireAncestor(
    options.git,
    lease.baselineSha,
    currentIntegrationSha,
    `current integration head ${currentIntegrationSha} is not descended from leased baseline ${lease.baselineSha}`,
  );

  const chainResult = await options.git([
    "rev-list",
    "--reverse",
    "--ancestry-path",
    `${lease.baselineSha}..${completionSha}`,
  ]);
  if (!chainResult.ok) {
    throw new Error(
      `Validation-repair publication could not enumerate the leased commit chain: ${chainResult.stderr || chainResult.stdout}.`,
    );
  }
  const chain = chainResult.stdout
    .split(/\r?\n/)
    .map((value) => normalizeSha(value))
    .filter(Boolean);
  const candidateIndex = chain.indexOf(lease.candidateSha);
  if (
    chain.length < 2 ||
    chain.length > MAX_REPAIR_CHAIN_COMMITS ||
    candidateIndex < 0 ||
    chain.at(-1) !== completionSha
  ) {
    throw new Error(
      `Validation-repair publication refused an invalid or oversized leased chain (${chain.length} commits; candidate index ${candidateIndex}).`,
    );
  }

  const cherryResult = await options.git([
    "cherry",
    currentIntegrationSha,
    completionSha,
    lease.baselineSha,
  ]);
  if (!cherryResult.ok) {
    throw new Error(
      `Validation-repair publication could not compare patch equivalence for idempotent recovery: ${cherryResult.stderr || cherryResult.stdout}.`,
    );
  }
  const equivalentCommits = new Set(
    cherryResult.stdout
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .match(/^-\s+([0-9a-f]{40,64})(?:\s|$)/i)?.[1]
          ?.toLowerCase(),
      )
      .filter((sha): sha is string => Boolean(sha)),
  );

  const applied: string[] = [];
  for (const commitSha of chain) {
    const alreadyIntegrated = await options.git([
      "merge-base",
      "--is-ancestor",
      commitSha,
      currentIntegrationSha,
    ]);
    if (alreadyIntegrated.ok || equivalentCommits.has(commitSha)) continue;
    const appliedResult = await options.git(["cherry-pick", commitSha]);
    if (!appliedResult.ok) {
      return {
        ...appliedResult,
        stderr: [
          appliedResult.stderr,
          `Failed while applying leased validation-repair commit ${commitSha} (${applied.length + 1}/${chain.length}).`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    applied.push(commitSha);
  }

  if (applied.length === 0) {
    return {
      ok: true,
      stdout: `Validation-repair completion ${completionSha} is already integrated; no duplicate mutation was applied.`,
      stderr: "",
      exitCode: 0,
      idempotent: true,
    };
  }
  return {
    ok: true,
    stdout: `Applied ${applied.length} leased validation-repair commit(s): ${applied.join(", ")}`,
    stderr: "",
    exitCode: 0,
  };
}
