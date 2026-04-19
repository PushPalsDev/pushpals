import { describe, expect, test } from "bun:test";
import {
  deriveQualityGatePolicy,
  extractReviewFixContext,
  resolveReviewFixCompletionBranch,
  resolveReviewNoChangeCompletionBranch,
  shouldEnqueueNoChangeReviewCompletion,
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

  test("tightens the quality gate only for review-fix jobs", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: {
        ...base.workerpals,
        qualityMaxAutoRevisions: 1,
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
    expect(policy.softPassOnExhausted).toBe(false);
    expect(policy.criticMinScore).toBeCloseTo(8.3, 5);
  });

  test("disables soft-pass for merge-conflict jobs", () => {
    const base = loadPushPalsConfig({ reload: true });
    const runtimeConfig = {
      ...base,
      workerpals: {
        ...base.workerpals,
        qualityMaxAutoRevisions: 1,
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
    expect(policy.softPassOnExhausted).toBe(false);
    expect(policy.criticMinScore).toBe(8);
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
    expect(shouldEnqueueNoChangeReviewCompletion({ completionBranch: "agent/workerpal-1/job-xyz" })).toBe(
      true,
    );
  });
});
