import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  appendValidationRepairPublicationLease,
  applyRetainedValidationCheckpoint,
  applyValidationRepairPublication,
  loadLatestValidationCheckpoint,
  loadValidationCheckpoint,
  parseValidationRepairPublicationLease,
  persistValidationCheckpoint,
  persistValidationSuccessProof,
  resolveValidationCheckpointBaseline,
  validationCheckpointRefs,
  validationRepairPublicationLeaseFromJobParams,
  type ValidationRepairGitResult,
} from "../apps/source_control_manager/src/validation_repair_publication";

function runGit(repoPath: string, args: string[]): ValidationRepairGitResult {
  const result = spawnSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-C", repoPath, ...args],
    { encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? result.error?.message ?? "").trim(),
    exitCode: result.status ?? -1,
  };
}

function requireGit(repoPath: string, args: string[]): string {
  const result = runGit(repoPath, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function commitFile(repoPath: string, path: string, contents: string, message: string): string {
  writeFileSync(join(repoPath, path), contents);
  requireGit(repoPath, ["add", "--", path]);
  requireGit(repoPath, ["commit", "-m", message]);
  return requireGit(repoPath, ["rev-parse", "HEAD"]);
}

function initializeRepository(prefix: string): { root: string; repoPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  requireGit(repoPath, ["init", "--initial-branch=main"]);
  requireGit(repoPath, ["config", "user.name", "PushPals Test"]);
  requireGit(repoPath, ["config", "user.email", "pushpals-test@example.invalid"]);
  return { root, repoPath };
}

const candidateRef = `refs/pushpals/validation/${"1".repeat(32)}/1/candidate`;

describe("SourceControlManager validation-repair publication lease", () => {
  test("builds a strict candidate-specific lease from worker job metadata", () => {
    const baselineSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const completionSha = "c".repeat(40);
    const lease = validationRepairPublicationLeaseFromJobParams(
      {
        autonomy: {
          validationIncident: {
            incidentId: "valid_inc_deadbeef",
            validationScope: "candidate_specific",
            baselineSha,
            candidateSha,
            candidateRef,
          },
        },
      },
      completionSha,
    );
    const originalBody = "### Summary\n\nWorker-authored description.";
    const body = appendValidationRepairPublicationLease(originalBody, lease);

    expect(body.startsWith(originalBody)).toBe(true);
    expect(parseValidationRepairPublicationLease(body)).toEqual({
      version: 1,
      scope: "candidate_specific",
      incidentId: "valid_inc_deadbeef",
      baselineSha,
      candidateSha,
      candidateRef,
      expectedCompletionSha: completionSha,
    });
  });

  test("does not attach a candidate lease to baseline-suspected repairs", () => {
    expect(
      validationRepairPublicationLeaseFromJobParams(
        {
          autonomy: {
            validationIncident: {
              incidentId: "valid_inc_deadbeef",
              validationScope: "baseline_suspected",
              baselineSha: "a".repeat(40),
              candidateSha: "b".repeat(40),
              candidateRef,
            },
          },
        },
        "c".repeat(40),
      ),
    ).toBeNull();
  });

  test("rejects incomplete, duplicate, and mismatched lease metadata", async () => {
    expect(() =>
      parseValidationRepairPublicationLease(
        "<!-- pushpals-validationRepairCandidateSha malformed reserved marker -->",
      ),
    ).toThrow("expected exactly one pushpals-validationRepairLeaseVersion marker");
    expect(() =>
      validationRepairPublicationLeaseFromJobParams(
        {
          autonomy: {
            validationIncident: {
              incidentId: "valid_inc_deadbeef",
              validationScope: "candidate_specific",
              candidateSha: "b".repeat(40),
              candidateRef,
            },
          },
        },
        "c".repeat(40),
      ),
    ).toThrow("exact baseline/candidate/completion SHAs are required");

    const validBody = appendValidationRepairPublicationLease("body", {
      version: 1,
      scope: "candidate_specific",
      incidentId: "valid_inc_deadbeef",
      baselineSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      candidateRef,
      expectedCompletionSha: "c".repeat(40),
    });
    expect(() =>
      parseValidationRepairPublicationLease(
        `${validBody}\n<!-- pushpals-validationRepairCandidateSha: ${"d".repeat(40)} -->`,
      ),
    ).toThrow("expected exactly one pushpals-validationRepairCandidateSha marker");

    const lease = parseValidationRepairPublicationLease(validBody)!;
    let gitCalled = false;
    await expect(
      applyValidationRepairPublication({
        lease,
        completionSha: "d".repeat(40),
        currentIntegrationSha: "a".repeat(40),
        git: async () => {
          gitCalled = true;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      }),
    ).rejects.toThrow("expected completion");
    expect(gitCalled).toBe(false);
  });

  test("creates immutable generation-scoped checkpoints and recovers the latest prior claim", async () => {
    const { root, repoPath } = initializeRepository("pushpals-validation-checkpoint-");
    try {
      const baselineSha = commitFile(repoPath, "base.txt", "base\n", "A: baseline");
      const candidateSha = commitFile(repoPath, "candidate.txt", "candidate\n", "B: candidate");
      const first = await persistValidationCheckpoint({
        completionId: "completion-checkpoint",
        claimGeneration: 1,
        baselineSha,
        candidateSha,
        git: async (args) => runGit(repoPath, args),
      });

      expect(
        await loadValidationCheckpoint({
          completionId: "completion-checkpoint",
          claimGeneration: 1,
          git: async (args) => runGit(repoPath, args),
        }),
      ).toEqual(first);
      expect(
        await loadLatestValidationCheckpoint({
          completionId: "completion-checkpoint",
          beforeClaimGeneration: 2,
          git: async (args) => runGit(repoPath, args),
        }),
      ).toEqual({ claimGeneration: 1, ...first });

      expect(first.validationProven).toBe(false);
      const proof = await persistValidationSuccessProof({
        completionId: "completion-checkpoint",
        claimGeneration: 1,
        candidateSha,
        git: async (args) => runGit(repoPath, args),
      });
      expect(requireGit(repoPath, ["rev-parse", proof.validatedRef])).toBe(candidateSha);
      expect(
        await loadValidationCheckpoint({
          completionId: "completion-checkpoint",
          claimGeneration: 1,
          git: async (args) => runGit(repoPath, args),
        }),
      ).toMatchObject({ validationProven: true, candidateSha });
      const replacementProofSha = commitFile(
        repoPath,
        "proof-replacement.txt",
        "different proof\n",
        "proof replacement",
      );
      await expect(
        persistValidationSuccessProof({
          completionId: "completion-checkpoint",
          claimGeneration: 1,
          candidateSha: replacementProofSha,
          git: async (args) => runGit(repoPath, args),
        }),
      ).rejects.toThrow("matching immutable candidate checkpoint");

      const replacementSha = commitFile(repoPath, "replacement.txt", "different\n", "C: different");
      await expect(
        persistValidationCheckpoint({
          completionId: "completion-checkpoint",
          claimGeneration: 1,
          baselineSha,
          candidateSha: replacementSha,
          git: async (args) => runGit(repoPath, args),
        }),
      ).rejects.toThrow("Immutable validation checkpoint");
      expect(requireGit(repoPath, ["rev-parse", first.candidateRef])).toBe(candidateSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives the common ancestor when a reviewed candidate diverges from the integration head", async () => {
    const { root, repoPath } = initializeRepository("pushpals-validation-merge-base-");
    try {
      const commonSha = commitFile(repoPath, "base.txt", "base\n", "A: common baseline");
      requireGit(repoPath, ["branch", "candidate", commonSha]);
      const integrationSha = commitFile(
        repoPath,
        "integration.txt",
        "integration\n",
        "D: integration",
      );
      requireGit(repoPath, ["checkout", "candidate"]);
      const reviewedCandidateSha = commitFile(
        repoPath,
        "candidate.txt",
        "candidate\n",
        "B: reviewed candidate",
      );

      expect(
        await resolveValidationCheckpointBaseline({
          preApplyBaselineSha: integrationSha,
          candidateSha: reviewedCandidateSha,
          git: async (args) => runGit(repoPath, args),
        }),
      ).toBe(commonSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replays a failed claim's exact retained candidate onto a newer integration head", async () => {
    const { root, repoPath } = initializeRepository("pushpals-validation-reclaim-");
    try {
      const baselineSha = commitFile(repoPath, "base.txt", "base\n", "A: baseline");
      requireGit(repoPath, ["branch", "original-candidate", baselineSha]);
      const integrationSha = commitFile(
        repoPath,
        "integration.txt",
        "integration\n",
        "D: integration",
      );
      requireGit(repoPath, ["checkout", "original-candidate"]);
      const originalCandidateSha = commitFile(
        repoPath,
        "candidate.txt",
        "candidate\n",
        "B: original candidate",
      );
      requireGit(repoPath, ["checkout", "-B", "claim-one", integrationSha]);
      requireGit(repoPath, ["cherry-pick", originalCandidateSha]);
      const testedCandidateSha = requireGit(repoPath, ["rev-parse", "HEAD"]);
      const first = await persistValidationCheckpoint({
        completionId: "completion-reclaim",
        claimGeneration: 1,
        baselineSha: integrationSha,
        candidateSha: testedCandidateSha,
        git: async (args) => runGit(repoPath, args),
      });

      requireGit(repoPath, ["checkout", "-B", "main_agents", integrationSha]);
      const advancedIntegrationSha = commitFile(
        repoPath,
        "concurrent.txt",
        "concurrent\n",
        "E: concurrent integration",
      );
      const replay = await applyRetainedValidationCheckpoint({
        baselineSha: first.baselineSha,
        candidateSha: first.candidateSha,
        currentIntegrationSha: advancedIntegrationSha,
        git: async (args) => runGit(repoPath, args),
      });

      expect(replay.ok).toBe(true);
      expect(replay.idempotent).not.toBe(true);
      expect(requireGit(repoPath, ["show", "HEAD:candidate.txt"])).toBe("candidate");
      expect(requireGit(repoPath, ["show", "HEAD:concurrent.txt"])).toBe("concurrent");

      const replayedCandidateSha = requireGit(repoPath, ["rev-parse", "HEAD"]);
      const second = await persistValidationCheckpoint({
        completionId: "completion-reclaim",
        claimGeneration: 2,
        baselineSha: advancedIntegrationSha,
        candidateSha: replayedCandidateSha,
        git: async (args) => runGit(repoPath, args),
      });
      expect(second.candidateRef).toBe(
        validationCheckpointRefs("completion-reclaim", 2).candidateRef,
      );

      const replayAfterCallbackLoss = await applyRetainedValidationCheckpoint({
        baselineSha: first.baselineSha,
        candidateSha: first.candidateSha,
        currentIntegrationSha: replayedCandidateSha,
        git: async (args) => runGit(repoPath, args),
      });
      expect(replayAfterCallbackLoss).toMatchObject({ ok: true, idempotent: true });
      expect(requireGit(repoPath, ["rev-parse", "HEAD"])).toBe(replayedCandidateSha);
      const callbackRecoveryCheckpoint = await persistValidationCheckpoint({
        completionId: "completion-reclaim",
        claimGeneration: 3,
        baselineSha: first.baselineSha,
        candidateSha: replayedCandidateSha,
        git: async (args) => runGit(repoPath, args),
      });
      expect(callbackRecoveryCheckpoint).toMatchObject({
        baselineSha: first.baselineSha,
        candidateSha: replayedCandidateSha,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("publishes D + exact tested B' + repair C' onto concurrent E exactly once", async () => {
    const { root, repoPath } = initializeRepository("pushpals-validation-publication-");
    const remotePath = join(root, "remote.git");
    try {
      const baselineASha = commitFile(repoPath, "base.txt", "base\n", "A: root baseline");
      requireGit(repoPath, ["branch", "worker-candidate", baselineASha]);
      const integrationDSha = commitFile(
        repoPath,
        "integration.txt",
        "integration D\n",
        "D: integration baseline",
      );
      requireGit(repoPath, ["checkout", "worker-candidate"]);
      const originalBSha = commitFile(
        repoPath,
        "candidate.txt",
        "candidate behavior\n",
        "B: worker candidate",
      );

      requireGit(repoPath, ["checkout", "-B", "validation-claim", integrationDSha]);
      requireGit(repoPath, ["cherry-pick", originalBSha]);
      const testedBPrimeSha = requireGit(repoPath, ["rev-parse", "HEAD"]);
      expect(testedBPrimeSha).not.toBe(originalBSha);
      const checkpoint = await persistValidationCheckpoint({
        completionId: "completion-a-to-b-to-c",
        claimGeneration: 1,
        baselineSha: integrationDSha,
        candidateSha: testedBPrimeSha,
        git: async (args) => runGit(repoPath, args),
      });

      requireGit(repoPath, ["checkout", "-B", "repair-worker", testedBPrimeSha]);
      const repairCPrimeSha = commitFile(
        repoPath,
        "repair.txt",
        "repair behavior\n",
        "C: validation repair",
      );
      requireGit(repoPath, ["checkout", "-B", "main_agents", integrationDSha]);
      const concurrentESha = commitFile(
        repoPath,
        "concurrent.txt",
        "integration E\n",
        "E: concurrent integration",
      );

      const body = appendValidationRepairPublicationLease(
        "Candidate repair completion.",
        validationRepairPublicationLeaseFromJobParams(
          {
            autonomy: {
              validationIncident: {
                incidentId: "valid_inc_a_to_b_to_c",
                validationScope: "candidate_specific",
                baselineSha: checkpoint.baselineSha,
                candidateSha: checkpoint.candidateSha,
                candidateRef: checkpoint.candidateRef,
              },
            },
          },
          repairCPrimeSha,
        ),
      );
      const lease = parseValidationRepairPublicationLease(body)!;
      const result = await applyValidationRepairPublication({
        lease,
        completionSha: repairCPrimeSha,
        currentIntegrationSha: concurrentESha,
        git: async (args) => runGit(repoPath, args),
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("Applied 2 leased validation-repair commit(s)");
      requireGit(root, ["init", "--bare", remotePath]);
      requireGit(repoPath, ["remote", "add", "origin", remotePath]);
      requireGit(repoPath, ["push", "origin", "HEAD:refs/heads/main_agents"]);
      expect(requireGit(remotePath, ["show", "refs/heads/main_agents:candidate.txt"])).toBe(
        "candidate behavior",
      );
      expect(requireGit(remotePath, ["show", "refs/heads/main_agents:repair.txt"])).toBe(
        "repair behavior",
      );
      expect(requireGit(remotePath, ["show", "refs/heads/main_agents:integration.txt"])).toBe(
        "integration D",
      );
      expect(requireGit(remotePath, ["show", "refs/heads/main_agents:concurrent.txt"])).toBe(
        "integration E",
      );

      const publishedSha = requireGit(repoPath, ["rev-parse", "HEAD"]);
      const retry = await applyValidationRepairPublication({
        lease,
        completionSha: repairCPrimeSha,
        currentIntegrationSha: publishedSha,
        git: async (args) => runGit(repoPath, args),
      });
      expect(retry).toMatchObject({ ok: true, idempotent: true });
      expect(requireGit(repoPath, ["rev-parse", "HEAD"])).toBe(publishedSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a lease when its retained candidate ref has moved", async () => {
    const { root, repoPath } = initializeRepository("pushpals-validation-moved-ref-");
    try {
      const baselineSha = commitFile(repoPath, "base.txt", "base\n", "A: baseline");
      const candidateSha = commitFile(repoPath, "candidate.txt", "candidate\n", "B: candidate");
      const completionSha = commitFile(repoPath, "repair.txt", "repair\n", "C: repair");
      const checkpoint = await persistValidationCheckpoint({
        completionId: "completion-moved-ref",
        claimGeneration: 1,
        baselineSha,
        candidateSha,
        git: async (args) => runGit(repoPath, args),
      });
      requireGit(repoPath, ["update-ref", checkpoint.candidateRef, completionSha, candidateSha]);
      const lease = {
        version: 1 as const,
        scope: "candidate_specific" as const,
        incidentId: "valid_inc_moved_ref",
        baselineSha,
        candidateSha,
        candidateRef: checkpoint.candidateRef,
        expectedCompletionSha: completionSha,
      };

      await expect(
        applyValidationRepairPublication({
          lease,
          completionSha,
          currentIntegrationSha: completionSha,
          git: async (args) => runGit(repoPath, args),
        }),
      ).rejects.toThrow("does not resolve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
