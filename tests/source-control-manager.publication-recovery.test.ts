import { describe, expect, test } from "bun:test";
import {
  assertFinalAuthoritativePublicationProof,
  authoritativeAncestryFromGitResult,
  authoritativeRefShaFromGitResult,
  durablePublicationRecoveryState,
  isValidationCheckpointPublished,
  PublicationAuthorityUnreachableError,
  PublicationConfirmationPendingError,
  PublicationProofLostError,
  publicationFailureDisposition,
  publishWithAuthoritativeProof,
  shouldSkipValidationForDurableRecovery,
} from "../apps/source_control_manager/src/publication_recovery";

const candidate = "b".repeat(40);
const localWithCandidate = "c".repeat(40);
const remoteWithoutCandidate = "a".repeat(40);

const ancestry = async (ancestor: string, descendant: string) =>
  ancestor === candidate && descendant === localWithCandidate;

describe("SourceControlManager publication recovery", () => {
  test("distinguishes definitive Git absence from an unreachable authority probe", () => {
    const exactSha = "d".repeat(40);
    expect(
      authoritativeRefShaFromGitResult(
        { ok: true, stdout: `${exactSha}\n`, stderr: "", exitCode: 0 },
        "refs/remotes/origin/review",
      ),
    ).toBe(exactSha);
    expect(
      authoritativeAncestryFromGitResult(
        { ok: true, stdout: "", stderr: "", exitCode: 0 },
        "candidate -> origin/main",
      ),
    ).toBe(true);
    expect(
      authoritativeRefShaFromGitResult(
        { ok: false, stdout: "", stderr: "", exitCode: 1 },
        "refs/remotes/origin/review",
      ),
    ).toBeNull();
    expect(
      authoritativeAncestryFromGitResult(
        { ok: false, stdout: "", stderr: "", exitCode: 1 },
        "candidate -> origin/main",
      ),
    ).toBe(false);

    expect(() =>
      authoritativeRefShaFromGitResult(
        { ok: false, stdout: "", stderr: "process timed out", exitCode: 124 },
        "refs/remotes/origin/review",
      ),
    ).toThrow("Authoritative ref probe failed");
    expect(() =>
      authoritativeAncestryFromGitResult(
        { ok: false, stdout: "", stderr: "index lock failure", exitCode: 128 },
        "candidate -> origin/main",
      ),
    ).toThrow("Authoritative ancestry probe failed");
  });

  test("does not treat a local merge as published after a failed remote push", async () => {
    expect(
      await isValidationCheckpointPublished({
        candidateSha: candidate,
        localIntegrationHeadSha: localWithCandidate,
        remoteIntegrationHeadSha: remoteWithoutCandidate,
        reviewRemoteHeadSha: null,
        pushMainAfterMerge: true,
        useReviewPublicationFlow: false,
        isAncestor: ancestry,
      }),
    ).toBe(false);
  });

  test("uses local integration as the durable publication head when pushing is disabled", async () => {
    expect(
      await isValidationCheckpointPublished({
        candidateSha: candidate,
        localIntegrationHeadSha: localWithCandidate,
        remoteIntegrationHeadSha: null,
        reviewRemoteHeadSha: null,
        pushMainAfterMerge: false,
        useReviewPublicationFlow: false,
        isAncestor: ancestry,
      }),
    ).toBe(true);
  });

  test("ReviewAgent recovery trusts only the remote review head", async () => {
    expect(
      await isValidationCheckpointPublished({
        candidateSha: candidate,
        localIntegrationHeadSha: localWithCandidate,
        remoteIntegrationHeadSha: localWithCandidate,
        reviewRemoteHeadSha: remoteWithoutCandidate,
        pushMainAfterMerge: true,
        useReviewPublicationFlow: true,
        isAncestor: ancestry,
      }),
    ).toBe(false);

    expect(
      await isValidationCheckpointPublished({
        candidateSha: candidate,
        localIntegrationHeadSha: remoteWithoutCandidate,
        remoteIntegrationHeadSha: remoteWithoutCandidate,
        reviewRemoteHeadSha: candidate,
        pushMainAfterMerge: true,
        useReviewPublicationFlow: true,
        isAncestor: ancestry,
      }),
    ).toBe(true);

    expect(
      await isValidationCheckpointPublished({
        candidateSha: candidate,
        localIntegrationHeadSha: null,
        remoteIntegrationHeadSha: null,
        reviewRemoteHeadSha: localWithCandidate,
        pushMainAfterMerge: true,
        useReviewPublicationFlow: true,
        isAncestor: ancestry,
      }),
    ).toBe(false);
  });

  test("durable publication proof suppresses mutation and terminal failure together", () => {
    expect(durablePublicationRecoveryState(false)).toEqual({
      skipPublicationMutation: false,
      protectFromTerminalFailure: false,
    });
    expect(durablePublicationRecoveryState(true)).toEqual({
      skipPublicationMutation: true,
      protectFromTerminalFailure: true,
    });
  });

  test("recovers when push reports failure after the authoritative ref updates", async () => {
    let remoteUpdated = false;
    const publication = await publishWithAuthoritativeProof({
      mutate: async () => {
        remoteUpdated = true;
        return { ok: false, stderr: "connection reset after receive-pack" };
      },
      provePublished: async () => remoteUpdated,
      failurePrefix: "push failed",
    });
    expect(publication.recoveredFromAmbiguousFailure).toBe(true);
  });

  test("waits for a successful push to become authoritative", async () => {
    let proofAttempts = 0;
    const waits: number[] = [];
    const publication = await publishWithAuthoritativeProof({
      mutate: async () => ({ ok: true, stderr: "push accepted" }),
      provePublished: async () => {
        proofAttempts += 1;
        return proofAttempts === 3;
      },
      failurePrefix: "push failed",
      proofRetry: {
        attempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 20,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    });

    expect(publication).toEqual({
      result: { ok: true, stderr: "push accepted" },
      recoveredFromAmbiguousFailure: false,
    });
    expect(proofAttempts).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  test("keeps a successful push nonterminal when bounded proof remains absent", async () => {
    const pending = publishWithAuthoritativeProof({
      mutate: async () => ({ ok: true, stderr: "remote accepted update" }),
      provePublished: async () => false,
      failurePrefix: "push failed",
      proofRetry: {
        attempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        wait: async () => {},
      },
    });

    await expect(pending).rejects.toBeInstanceOf(PublicationConfirmationPendingError);
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: false,
        publicationConfirmationPending: true,
        authoritativeReprobe: "absent",
      }),
    ).toBe("reconcile");
  });

  test("fails a rejected push after bounded authoritative absence", async () => {
    let proofAttempts = 0;
    const rejected = publishWithAuthoritativeProof({
      mutate: async () => ({ ok: false, stderr: "force-with-lease rejected" }),
      provePublished: async () => {
        proofAttempts += 1;
        return false;
      },
      failurePrefix: "push failed",
      proofRetry: {
        attempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        wait: async () => {},
      },
    });

    await expect(rejected).rejects.toThrow("push failed: force-with-lease rejected");
    expect(proofAttempts).toBe(2);
  });

  test("does not multiply a bounded network-probe failure", async () => {
    let proofAttempts = 0;
    const pending = publishWithAuthoritativeProof({
      mutate: async () => ({ ok: true }),
      provePublished: async () => {
        proofAttempts += 1;
        throw new Error("remote authority unavailable");
      },
      failurePrefix: "push failed",
      proofRetry: {
        attempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        wait: async () => {},
      },
    });

    await expect(pending).rejects.toBeInstanceOf(PublicationConfirmationPendingError);
    expect(proofAttempts).toBe(1);
  });

  test("keeps a mutation nonterminal when both authoritative probes are unreachable", async () => {
    const firstAttempt = publishWithAuthoritativeProof({
      mutate: async () => {
        throw new Error("connection reset after receive-pack");
      },
      provePublished: async () => {
        throw new Error("remote authority unavailable");
      },
      failurePrefix: "push failed",
      proofRetry: {
        attempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        wait: async () => {},
      },
    });

    await expect(firstAttempt).rejects.toBeInstanceOf(PublicationAuthorityUnreachableError);
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: true,
        authoritativeReprobe: "unreachable",
      }),
    ).toBe("reconcile");
  });

  test("preserves terminal failure when an authoritative reprobe proves the ref absent", () => {
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: true,
        authoritativeReprobe: "absent",
      }),
    ).toBe("fail");
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: false,
        authoritativeReprobe: "unreachable",
      }),
    ).toBe("fail");
  });

  test("keeps a validated checkpoint nonterminal when recovery cannot refresh authority", () => {
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: false,
        authoritativeReprobe: "absent",
        validatedCheckpointRecoveryPending: true,
      }),
    ).toBe("reconcile");
  });

  test("rejects a review head that moves during the PR creation window", async () => {
    let reviewHeadIsExact = true;
    await assertFinalAuthoritativePublicationProof({
      provePublished: async () => reviewHeadIsExact,
      failurePrefix: "review head moved",
    });

    // Simulate another writer moving the remote PR head after the initial push
    // proof but before SourceControlManager sends the processed callback.
    reviewHeadIsExact = false;
    await expect(
      assertFinalAuthoritativePublicationProof({
        provePublished: async () => reviewHeadIsExact,
        failurePrefix: "review head moved",
      }),
    ).rejects.toBeInstanceOf(PublicationProofLostError);
  });

  test("treats an unreachable final proof as nonterminal publication uncertainty", async () => {
    const finalProbe = assertFinalAuthoritativePublicationProof({
      provePublished: async () => {
        throw new Error("remote unavailable");
      },
      failurePrefix: "final proof unavailable",
    });

    await expect(finalProbe).rejects.toBeInstanceOf(PublicationAuthorityUnreachableError);
    expect(
      publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: true,
        authoritativeReprobe: "unreachable",
      }),
    ).toBe("reconcile");
  });

  test("protects finalization when branch push succeeds before PR creation fails", async () => {
    let publicationReadyForFinalization = false;
    await expect(
      (async () => {
        await publishWithAuthoritativeProof({
          mutate: async () => ({ ok: true }),
          provePublished: async () => true,
          failurePrefix: "push failed",
        });
        publicationReadyForFinalization =
          durablePublicationRecoveryState(true).protectFromTerminalFailure;
        throw new Error("PR provider unavailable");
      })(),
    ).rejects.toThrow("PR provider unavailable");
    expect(publicationReadyForFinalization).toBe(true);
  });

  test("skips changed validation only when success and publication proofs both exist", () => {
    expect(
      shouldSkipValidationForDurableRecovery({
        validationProven: false,
        publicationProven: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipValidationForDurableRecovery({
        validationProven: true,
        publicationProven: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipValidationForDurableRecovery({
        validationProven: true,
        publicationProven: true,
      }),
    ).toBe(true);
  });
});
