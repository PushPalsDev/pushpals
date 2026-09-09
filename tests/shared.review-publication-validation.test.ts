import { describe, expect, test } from "bun:test";
import {
  buildReviewPublicationValidationPlan,
  resolveReconciledReviewValidationPlan,
} from "../packages/shared/src/review_publication_validation";
import {
  resolveReviewPublicationValidationCommands,
  reviewPublicationFailureDisposition,
  ReviewPublicationDeferredError,
} from "../apps/source_control_manager/src/review_publication_recovery";

describe("reconciled review validation authority", () => {
  test("reruns passed and deferred gates on every changed or restored candidate", () => {
    const plan = buildReviewPublicationValidationPlan({
      complete: true,
      requiredValidationSteps: ["Run `bun run validate`"],
      validationSteps: ["The feature remains portable.", "git diff --check"],
      workerCommands: ["bun test tests/feature.test.ts", "git diff --check"],
      deferredCommands: ["bun run validate"],
    });
    expect(plan).toEqual({
      version: 1,
      status: "ready",
      commands: ["bun run validate", "git diff --check", "bun test tests/feature.test.ts"],
    });
    const originalCandidateSha = "a".repeat(40);
    for (const claimGeneration of [1, 2, 7]) {
      const commands = resolveReviewPublicationValidationCommands({
        originalCandidateSha,
        candidateSha: "b".repeat(40),
        claimGeneration,
        deferredCommandsJson: JSON.stringify(["bun run validate"]),
        fullPlan: plan,
      });
      expect(JSON.parse(commands!)).toEqual(plan.commands);
      // A worker with no deferred gates still needs its original passed gates
      // when the host changes its tree, including a resumed checkpoint.
      expect(
        JSON.parse(
          resolveReviewPublicationValidationCommands({
            originalCandidateSha,
            candidateSha: "c".repeat(40),
            claimGeneration,
            deferredCommandsJson: null,
            fullPlan: plan,
          })!,
        ),
      ).toEqual(plan.commands);
    }
    expect(
      resolveReviewPublicationValidationCommands({
        originalCandidateSha,
        candidateSha: originalCandidateSha,
        claimGeneration: 1,
        deferredCommandsJson: null,
        fullPlan: undefined,
      }),
    ).toBeNull();
  });

  test("missing diagnostics defer briefly then hold without a coding retry or silent pass", () => {
    for (const claimGeneration of [1, 2, 3, 9]) {
      try {
        resolveReviewPublicationValidationCommands({
          originalCandidateSha: "a".repeat(40),
          candidateSha: "b".repeat(40),
          claimGeneration,
          deferredCommandsJson: null,
          fullPlan: undefined,
        });
        throw new Error("Changed candidate was allowed to skip full validation");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewPublicationDeferredError);
        const deferred = error as ReviewPublicationDeferredError;
        expect(deferred.code).toBe(
          claimGeneration < 3 ? "review_validation_pending" : "review_validation_unavailable",
        );
        expect(reviewPublicationFailureDisposition(deferred, "fail")).toBe(
          claimGeneration < 3 ? "reconcile" : "fail",
        );
        expect(reviewPublicationFailureDisposition(deferred, "finalize")).toBe("finalize");
      }
    }
  });

  test("never truncates or weakens a mandatory command plan", () => {
    const options = {
      complete: true,
      requiredValidationSteps: [],
      validationSteps: [],
      workerCommands: ["git diff --check"],
    };
    expect(buildReviewPublicationValidationPlan(options).status).toBe("ready");
    expect(buildReviewPublicationValidationPlan({ ...options, complete: false }).status).toBe(
      "pending",
    );
    for (const invalid of [
      { requiredValidationSteps: ["Run the entire suite using the documented command"] },
      { workerCommands: ["bun test && git diff --check"] },
      { workerCommands: [] },
      { workerCommands: ["bun test tests/Case.test.ts", "bun test tests/case.test.ts"] },
      { workerCommands: Array.from({ length: 9 }, (_, i) => `bun test tests/gate-${i}.test.ts`) },
    ]) {
      const plan = buildReviewPublicationValidationPlan({ ...options, ...invalid });
      expect(plan.status).toBe("invalid");
      expect(plan.commands).toEqual([]);
      expect(() =>
        resolveReviewPublicationValidationCommands({
          originalCandidateSha: "a".repeat(40),
          candidateSha: "b".repeat(40),
          claimGeneration: 1,
          deferredCommandsJson: null,
          fullPlan: plan,
        }),
      ).toThrow(ReviewPublicationDeferredError);
    }
    expect(
      resolveReconciledReviewValidationPlan({ version: 1, status: "ready", commands: [] }).status,
    ).toBe("invalid");
    expect(
      resolveReconciledReviewValidationPlan({ version: 2, status: "ready", commands: ["bun test"] })
        .status,
    ).toBe("invalid");
  });
});
