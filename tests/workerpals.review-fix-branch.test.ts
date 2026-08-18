import { describe, expect, test } from "bun:test";
import {
  deriveQualityGatePolicy,
  extractReviewFixContext,
  resolveReviewFixCompletionBranch,
  resolveReviewNoChangeCompletionBranch,
  resolveWorkerCriticReviewContext,
  shouldEnqueueNoChangeReviewCompletion,
  shouldFailTaskWithoutPublishableChanges,
} from "../apps/workerpals/src/execute_job";
import { loadPushPalsConfig } from "../packages/shared/src/config";

describe("workerpals review fix completion branch resolution", () => {
  test("uses ReviewAgent-provided PR head branch when valid", () => {
    const resolved = resolveReviewFixCompletionBranch(
      "refs/heads/agent/workerpal-1/job-abc",
      "agent/default",
    );
    expect(resolved).toEqual({
      branch: "agent/workerpal-1/job-abc",
      overridden: true,
    });
  });

  test("rejects unsafe branch override and falls back", () => {
    const resolved = resolveReviewFixCompletionBranch("../main", "agent/default");
    expect(resolved).toEqual({
      branch: "agent/default",
      overridden: false,
    });
  });

  test("resolves no-change re-review branch from completionBranch", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      completionBranch: "refs/heads/agent/workerpal-1/job-abc",
      reviewAgent: { prHeadRef: "refs/heads/agent/workerpal-1/ignored" },
    });
    expect(branch).toBe("agent/workerpal-1/job-abc");
  });

  test("resolves no-change re-review branch from reviewAgent.prHeadRef", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      reviewAgent: { prHeadRef: "refs/heads/agent/workerpal-1/job-xyz" },
    });
    expect(branch).toBe("agent/workerpal-1/job-xyz");
  });

  test("returns null for unsafe no-change re-review branch", () => {
    const branch = resolveReviewNoChangeCompletionBranch({
      completionBranch: "../main",
      reviewAgent: { prHeadRef: "agent/workerpal-1/job-xyz" },
    });
    expect(branch).toBeNull();
  });

  test("extracts structured review-fix metadata for rejected PR retries", () => {
    const context = extractReviewFixContext({
      reviewAgent: {
        resolutionType: "review_fix",
        prHeadRef: "refs/heads/agent/workerpal-1/job-xyz",
        prBaseRef: "main",
        previousReviewScore: 7.8,
        reviewThreshold: 8.5,
        previousReviewSummary: "Tests need stronger failure-path coverage",
        reviewerFindings: ["Add negative-path assertions", "Validate empty-state transitions"],
      },
    });
    expect(context).toEqual({
      resolutionType: "review_fix",
      prHeadRef: "refs/heads/agent/workerpal-1/job-xyz",
      prBaseRef: "main",
      previousReviewScore: 7.8,
      reviewThreshold: 8.5,
      previousReviewSummary: "Tests need stronger failure-path coverage",
      reviewerFindings: ["Add negative-path assertions", "Validate empty-state transitions"],
    });
  });

  test("tightens the quality gate only for review-fix jobs while preserving exhausted soft-pass policy", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: {
        ...base.workerpals,
        qualityMaxAutoRevisions: 1,
        qualityValidationMaxAutoRevisions: 3,
        qualityScopeGateEnabled: false,
        qualityValidationGateEnabled: true,
        qualityCriticGateEnabled: false,
        qualityPublishGateEnabled: true,
        qualitySoftPassOnExhausted: true,
        qualityCriticMinScore: 8,
      },
    };

    const policy = deriveQualityGatePolicy(
      {
        reviewAgent: {
          resolutionType: "review_fix",
          previousReviewScore: 7.8,
          reviewThreshold: 8.5,
        },
      },
      runtimeConfig,
    );

    expect(policy.mode).toBe("review_fix");
    expect(policy.maxAutoRevisions).toBe(2);
    expect(policy.validationMaxAutoRevisions).toBe(3);
    expect(policy.scopeGateEnabled).toBe(false);
    expect(policy.validationGateEnabled).toBe(true);
    expect(policy.criticGateEnabled).toBe(false);
    expect(policy.publishGateEnabled).toBe(true);
    expect(policy.softPassOnExhausted).toBe(true);
    expect(policy.criticMinScore).toBeCloseTo(8.5, 5);
  });

  test("aligns the default worker critic threshold with enabled final review", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: { ...base.workerpals, qualityCriticMinScore: 8 },
      sourceControlManager: {
        ...base.sourceControlManager,
        reviewAgent: {
          ...base.sourceControlManager.reviewAgent,
          enabled: true,
          passThreshold: 9.1,
        },
      },
    };
    expect(deriveQualityGatePolicy({}, runtimeConfig).criticMinScore).toBe(9.1);
  });

  test("feeds the final reviewer rubric and prior findings into worker review context", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      sourceControlManager: {
        ...base.sourceControlManager,
        reviewAgent: {
          ...base.sourceControlManager.reviewAgent,
          passThreshold: 8.7,
          reviewerMdPath: "missing-reviewer.md",
        },
      },
    };
    const context = resolveWorkerCriticReviewContext(
      process.cwd(),
      {
        reviewAgent: {
          resolutionType: "review_fix",
          previousReviewScore: 7.8,
          previousReviewSummary: "Rendered ownership cue can be obscured",
          reviewerFindings: ["Cover all ship variants", "Assert rendered geometry"],
        },
      },
      runtimeConfig,
    );
    expect(context.finalReviewThreshold).toBe(8.7);
    expect(context.finalReviewerRubric).toContain("Distinguished Engineer");
    expect(context.priorReviewContext).toContain("Previous final-review score: 7.8");
    expect(context.priorReviewContext).toContain("Cover all ship variants");
    expect(context.priorReviewContext).toContain("not an exhaustive checklist");
  });

  test("preserves exhausted soft-pass for merge-conflict jobs", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: {
        ...base.workerpals,
        qualityMaxAutoRevisions: 1,
        qualityValidationMaxAutoRevisions: 3,
        qualitySoftPassOnExhausted: true,
        qualityCriticMinScore: 8,
      },
    };

    const policy = deriveQualityGatePolicy(
      {
        reviewAgent: {
          resolutionType: "merge_conflict",
          prHeadRef: "refs/heads/agent/workerpal-1/job-xyz",
          prBaseRef: "main",
        },
      },
      runtimeConfig,
    );

    expect(policy.mode).toBe("merge_conflict");
    expect(policy.maxAutoRevisions).toBe(1);
    expect(policy.validationMaxAutoRevisions).toBe(3);
    expect(policy.softPassOnExhausted).toBe(true);
    expect(policy.criticMinScore).toBe(base.sourceControlManager.reviewAgent.passThreshold);
  });

  test("suppresses unchanged branch re-review for rejected review-fix jobs", () => {
    expect(
      shouldEnqueueNoChangeReviewCompletion({
        reviewAgent: {
          resolutionType: "review_fix",
          prHeadRef: "refs/heads/agent/workerpal-1/job-xyz",
        },
      }),
    ).toBe(false);
    expect(
      shouldEnqueueNoChangeReviewCompletion({
        reviewAgent: {
          prHeadRef: "refs/heads/agent/workerpal-1/job-xyz",
          previousReviewScore: 7.4,
        },
      }),
    ).toBe(false);
    expect(
      shouldEnqueueNoChangeReviewCompletion({ completionBranch: "agent/workerpal-1/job-xyz" }),
    ).toBe(true);
  });

  test("fails file-modifying jobs that return without a publishable patch", () => {
    const base = {
      planningIntent: "code_change" as const,
      writeAllowed: true,
      publishablePathCount: 0,
      shellWrapperReturn: false,
    };

    expect(shouldFailTaskWithoutPublishableChanges({ ...base, mode: "default" })).toBe(true);
    expect(shouldFailTaskWithoutPublishableChanges({ ...base, mode: "review_fix" })).toBe(true);
    expect(shouldFailTaskWithoutPublishableChanges({ ...base, mode: "merge_conflict" })).toBe(
      false,
    );
    expect(
      shouldFailTaskWithoutPublishableChanges({
        ...base,
        mode: "default",
        planningIntent: "analysis",
      }),
    ).toBe(false);
    expect(
      shouldFailTaskWithoutPublishableChanges({ ...base, mode: "default", writeAllowed: false }),
    ).toBe(false);
    expect(
      shouldFailTaskWithoutPublishableChanges({
        ...base,
        mode: "default",
        publishablePathCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldFailTaskWithoutPublishableChanges({
        ...base,
        mode: "merge_conflict",
        shellWrapperReturn: true,
      }),
    ).toBe(true);
  });
});
