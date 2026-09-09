import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GitHubPR } from "../apps/source_control_manager/src/github_pr";
import {
  buildReviewPublicationPushArgs,
  parseReviewPublicationLease,
  type ReviewPublicationLease,
} from "../apps/source_control_manager/src/review_publication";
import {
  assertReviewCompletionLease,
  assertReviewPublicationBaseUnchanged,
  buildReviewPublicationSettlement,
  prepareReviewPublicationCandidate,
  resolveReviewPublicationAuthority,
  reviewPublicationFailureDisposition,
  ReviewPublicationDeferredError,
  ReviewPublicationSupersededError,
} from "../apps/source_control_manager/src/review_publication_recovery";
import {
  isValidationCheckpointPublished,
  publicationFailureDisposition,
} from "../apps/source_control_manager/src/publication_recovery";
import {
  loadLatestValidationCheckpoint,
  persistValidationCheckpoint,
  persistValidationSuccessProof,
  validationCheckpointRefs,
  type ValidationRepairGitResult,
} from "../apps/source_control_manager/src/validation_repair_publication";

const remoteUrl = "https://github.com/example/portable-project.git";
const prUrl = "https://github.com/example/portable-project/pull/17";
const lease: ReviewPublicationLease = {
  targetBranch: "agent/feature",
  baseBranch: "main",
  expectedHeadSha: "a".repeat(40),
  expectedBaseSha: "b".repeat(40),
};
const liveBaseSha = "c".repeat(40);
function pullRequest(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 17,
    html_url: prUrl,
    title: "Repair a portable project",
    body: "",
    state: "open",
    head: {
      ref: lease.targetBranch,
      sha: lease.expectedHeadSha,
      label: "example:agent/feature",
      repo: { full_name: "example/portable-project" },
    },
    base: { ref: "main", sha: lease.expectedBaseSha! },
    ...overrides,
  };
}
function authorityOptions(pr = pullRequest()) {
  return {
    token: "fixture-token",
    remoteUrl,
    prUrl,
    lease,
    getPr: async () => pr,
    getBase: async () => liveBaseSha,
  };
}

describe("original PR publication authority", () => {
  test("conflict settlement keeps original server authority separate from refreshed worker base", () => {
    const completionId = "settlement-retained";
    const options = {
      completionId,
      claimGeneration: 2,
      lease: { ...lease, expectedBaseSha: liveBaseSha },
      claimedAuthority: {
        repositoryIdentity: remoteUrl,
        prNumber: 17,
        expectedHeadSha: lease.expectedHeadSha,
        expectedBaseSha: lease.expectedBaseSha!,
        resolutionType: "merge_conflict",
      },
      superseded: null,
      observedAuthority: {
        prNumber: 17,
        prUrl,
        headSha: lease.expectedHeadSha,
        baseSha: liveBaseSha,
      },
      checkpointPersisted: true,
      candidateSha: "d".repeat(40),
      candidateRef: validationCheckpointRefs(completionId, 2).candidateRef,
    };
    expect(buildReviewPublicationSettlement(options)).toMatchObject({
      code: "publication_conflict",
      expectedBaseSha: lease.expectedBaseSha,
      observedBaseSha: liveBaseSha,
      retainedCandidateSha: "d".repeat(40),
      retainedCandidateRef: options.candidateRef,
    });
    for (const override of [
      { checkpointPersisted: false },
      { candidateRef: null },
      { candidateRef: validationCheckpointRefs(completionId, 3).candidateRef },
      { candidateRef: validationCheckpointRefs("another-completion", 2).candidateRef },
      { claimedAuthority: null },
      {
        claimedAuthority: {
          ...options.claimedAuthority,
          repositoryIdentity: "https://github.com/another/project.git",
        },
      },
      { claimedAuthority: { ...options.claimedAuthority, expectedHeadSha: "e".repeat(40) } },
    ]) {
      try {
        buildReviewPublicationSettlement({ ...options, ...override });
        throw new Error("unexpected terminal settlement");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewPublicationDeferredError);
        expect(
          reviewPublicationFailureDisposition(error as ReviewPublicationDeferredError, "fail"),
        ).toBe("reconcile");
      }
    }
  });

  test("uses the live target ref, never the PR's stale historical base SHA", async () => {
    const authority = await resolveReviewPublicationAuthority(authorityOptions());
    expect(authority.baseSha).toBe(liveBaseSha);
    expect(authority.headSha).toBe(lease.expectedHeadSha);
    expect(lease.expectedBaseSha).toBe("b".repeat(40));
  });

  test.each(["closed", "changed head"])(
    "settles verified %s without creating a replacement PR",
    async (reason) => {
      const pr = pullRequest(
        reason === "closed"
          ? { state: "closed" }
          : {
              head: { ...pullRequest().head, sha: "d".repeat(40) },
            },
      );
      try {
        await resolveReviewPublicationAuthority(authorityOptions(pr));
        throw new Error("unexpected publication authority");
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewPublicationSupersededError);
        const outcome = (error as ReviewPublicationSupersededError).outcome;
        expect(outcome.expectedHeadSha).toBe(lease.expectedHeadSha);
        expect(outcome.expectedBaseSha).toBe(lease.expectedBaseSha!);
        expect(outcome.observedHeadSha).toBe(pr.head.sha);
        expect(outcome.observedState).toBe(pr.state);
      }
    },
  );

  test("a validation checkpoint alone does not authorize a changed provider head", async () => {
    const candidateSha = "d".repeat(40);
    const pr = pullRequest({ head: { ...pullRequest().head, sha: candidateSha } });
    await expect(resolveReviewPublicationAuthority(authorityOptions(pr))).rejects.toBeInstanceOf(
      ReviewPublicationSupersededError,
    );
    expect(
      (
        await resolveReviewPublicationAuthority({
          ...authorityOptions(pr),
          publishedCandidateSha: candidateSha,
          publishedRecoveryProven: true,
        })
      ).headSha,
    ).toBe(candidateSha);
  });

  test("closed PR recovery requires exact already-published checkpoint proof", async () => {
    const candidateSha = "d".repeat(40);
    const pr = pullRequest({ state: "closed", head: { ...pullRequest().head, sha: candidateSha } });
    await expect(
      resolveReviewPublicationAuthority({
        ...authorityOptions(pr),
        publishedCandidateSha: candidateSha,
      }),
    ).rejects.toBeInstanceOf(ReviewPublicationSupersededError);
    expect(
      (
        await resolveReviewPublicationAuthority({
          ...authorityOptions(pr),
          publishedCandidateSha: candidateSha,
          publishedRecoveryProven: true,
        })
      ).headSha,
    ).toBe(candidateSha);
  });

  test.each([
    "provider unavailable",
    "base unavailable",
    "malformed base",
    "wrong repository",
    "retargeted PR",
  ])("fails closed on %s", async (reason) => {
    const options = authorityOptions();
    if (reason === "provider unavailable")
      options.getPr = async () => {
        throw new Error("provider offline");
      };
    if (reason === "base unavailable")
      options.getBase = async () => {
        throw new Error("ref deleted");
      };
    if (reason === "malformed base") options.getBase = async () => "main";
    if (reason === "wrong repository")
      options.getPr = async () =>
        pullRequest({ html_url: "https://github.com/another/project/pull/17" });
    if (reason === "retargeted PR")
      options.getPr = async () => pullRequest({ base: { ref: "release", sha: liveBaseSha } });
    await expect(resolveReviewPublicationAuthority(options)).rejects.toBeInstanceOf(
      ReviewPublicationDeferredError,
    );
  });

  test("missing or malformed review leases cannot fall through to unleased publication", () => {
    for (const body of [
      "",
      "<!-- pushpals-reviewTargetBranch: agent/feature -->",
      "<!-- pushpals-reviewExpectedHeadSha: main -->",
    ]) {
      expect(() =>
        assertReviewCompletionLease(
          "refs/pushpals/review/job-1",
          parseReviewPublicationLease(body),
        ),
      ).toThrow("malformed publication lease");
    }
    expect(() => assertReviewCompletionLease("refs/pushpals/review/job-1", lease)).not.toThrow();
    expect(() => assertReviewCompletionLease("refs/pushpals/jobs/job-1", null)).not.toThrow();
  });

  test.each(["review_base_moved", "review_authority_unavailable"] as const)(
    "%s stays nonterminal even when remote publication is provably absent",
    (code) => {
      const ordinary = publicationFailureDisposition({
        publicationReadyForFinalization: false,
        publicationAttemptUncertain: false,
        authoritativeReprobe: "absent",
      });
      expect(ordinary).toBe("fail");
      const deferred = new ReviewPublicationDeferredError(code, "bounded reconciliation pending");
      expect(reviewPublicationFailureDisposition(deferred, ordinary)).toBe("reconcile");
      expect(reviewPublicationFailureDisposition(deferred, "finalize")).toBe("finalize");
      expect(
        reviewPublicationFailureDisposition(
          new ReviewPublicationDeferredError("review_base_conflict", "manual resolution required"),
          ordinary,
        ),
      ).toBe("fail");
    },
  );
});

function runGit(repo: string, args: string[]): ValidationRepairGitResult {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      repo,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? result.error?.message ?? "").trim(),
    exitCode: result.status ?? -1,
  };
}
function requireGit(repo: string, args: string[]): string {
  const result = runGit(repo, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pushpals-review-publication-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);
  mkdirSync(remote);
  try {
    requireGit(repo, ["init", "--initial-branch=main"]);
    requireGit(repo, ["config", "user.name", "PushPals Fixture"]);
    requireGit(repo, ["config", "user.email", "fixture@example.invalid"]);
    requireGit(remote, ["init", "--bare", "--initial-branch=main"]);
    requireGit(repo, ["remote", "add", "origin", remote]);
    return { root, repo, remote };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
function commit(repo: string, file: string, contents: string): string {
  writeFileSync(join(repo, file), contents);
  requireGit(repo, ["add", "--", file]);
  requireGit(repo, ["commit", "-m", `Update ${file}`]);
  return requireGit(repo, ["rev-parse", "HEAD"]);
}
const identity = { name: "PushPals Host Fixture", email: "host@example.invalid" };

describe("real Git review publication recovery", () => {
  test("preserves a worker patch across two live-base generations, restart and exact leased publication", async () => {
    const { root, repo, remote } = fixture();
    try {
      const historicalBase = commit(repo, "shared.txt", "initial\n");
      requireGit(repo, ["checkout", "-b", "agent/feature"]);
      const originalHead = commit(repo, "feature.txt", "original feature\n");
      requireGit(repo, ["push", "origin", "agent/feature"]);
      const workerCandidate = commit(repo, "feature.txt", "repaired feature\n");
      requireGit(repo, ["update-ref", "refs/pushpals/review/immutable-worker", workerCandidate]);
      requireGit(repo, ["checkout", "main"]);
      const baseOne = commit(repo, "upstream-one.txt", "first upstream addition\n");
      requireGit(repo, ["push", "origin", "main"]);
      requireGit(repo, ["checkout", "-B", "disposable", workerCandidate]);
      const git = async (args: string[]) => runGit(repo, args);
      const first = await prepareReviewPublicationCandidate({
        completionId: "review-recovery",
        candidateSha: workerCandidate,
        baseSha: baseOne,
        git,
        commitIdentity: identity,
      });
      expect(first.reconciled).toBe(true);
      expect(first.candidateSha).not.toBe(workerCandidate);
      expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("repaired feature\n");
      expect(readFileSync(join(repo, "upstream-one.txt"), "utf8")).toContain("first upstream");
      const checkpoint = await persistValidationCheckpoint({
        completionId: "review-recovery",
        claimGeneration: 1,
        baselineSha: baseOne,
        candidateSha: first.candidateSha,
        git,
      });
      await persistValidationSuccessProof({
        completionId: "review-recovery",
        claimGeneration: 1,
        candidateSha: first.candidateSha,
        git,
      });
      // Validation passed, then the target moved. The disposition cannot rearm
      // the worker, publish the stale tree, or mutate the old immutable proof.
      requireGit(repo, ["checkout", "main"]);
      const baseTwo = commit(repo, "upstream-two.txt", "second upstream addition\n");
      requireGit(repo, ["push", "origin", "main"]);
      expect(() =>
        assertReviewPublicationBaseUnchanged(baseOne, {
          prNumber: 17,
          prUrl,
          headSha: originalHead,
          baseSha: baseTwo,
        }),
      ).toThrow(ReviewPublicationDeferredError);
      const retained = await loadLatestValidationCheckpoint({
        completionId: "review-recovery",
        beforeClaimGeneration: 2,
        git,
      });
      expect(retained?.validationProven).toBe(true);
      expect(retained?.candidateSha).toBe(first.candidateSha);
      requireGit(repo, ["checkout", "-B", "disposable", retained!.candidateSha]);
      const second = await prepareReviewPublicationCandidate({
        completionId: "review-recovery",
        candidateSha: retained!.candidateSha,
        baseSha: baseTwo,
        git,
        commitIdentity: identity,
      });
      expect(second.candidateSha).not.toBe(first.candidateSha);
      expect(
        runGit(repo, ["merge-base", "--is-ancestor", workerCandidate, second.candidateSha]).ok,
      ).toBe(true);
      expect(runGit(repo, ["merge-base", "--is-ancestor", baseTwo, second.candidateSha]).ok).toBe(
        true,
      );
      const nextCheckpoint = await persistValidationCheckpoint({
        completionId: "review-recovery",
        claimGeneration: 2,
        baselineSha: baseTwo,
        candidateSha: second.candidateSha,
        git,
      });
      expect(
        (
          await loadLatestValidationCheckpoint({
            completionId: "review-recovery",
            beforeClaimGeneration: 3,
            git,
          })
        )?.validationProven,
      ).toBe(false);
      expect(requireGit(repo, ["rev-parse", checkpoint.candidateRef])).toBe(first.candidateSha);
      expect(requireGit(repo, ["rev-parse", "refs/pushpals/review/immutable-worker"])).toBe(
        workerCandidate,
      );
      expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("repaired feature\n");
      expect(readFileSync(join(repo, "upstream-two.txt"), "utf8")).toContain("second upstream");
      await persistValidationSuccessProof({
        completionId: "review-recovery",
        claimGeneration: 2,
        candidateSha: second.candidateSha,
        git,
      });
      requireGit(
        repo,
        buildReviewPublicationPushArgs({
          remote: "origin",
          commitSha: nextCheckpoint.candidateSha,
          lease: { ...lease, expectedHeadSha: originalHead, expectedBaseSha: historicalBase },
        }),
      );
      expect(requireGit(remote, ["rev-parse", "refs/heads/agent/feature"])).toBe(
        second.candidateSha,
      );
      expect(
        await isValidationCheckpointPublished({
          candidateSha: second.candidateSha,
          localIntegrationHeadSha: baseTwo,
          remoteIntegrationHeadSha: null,
          reviewRemoteHeadSha: second.candidateSha,
          useReviewPublicationFlow: true,
          pushMainAfterMerge: false,
          isAncestor: async (a, b) => runGit(repo, ["merge-base", "--is-ancestor", a, b]).ok,
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a real content conflict retains the exact candidate, aborts safely and remembers the unchanged tuple", async () => {
    const { root, repo } = fixture();
    try {
      const oldBase = commit(repo, "shared.txt", "initial\n");
      requireGit(repo, ["checkout", "-b", "worker"]);
      const candidateSha = commit(repo, "shared.txt", "worker edit\n");
      requireGit(repo, ["checkout", "main"]);
      const baseSha = commit(repo, "shared.txt", "upstream incompatible edit\n");
      requireGit(repo, ["checkout", "worker"]);
      let merges = 0;
      const git = async (args: string[]) => {
        if (args.includes("merge") && args.includes("--no-ff")) merges += 1;
        return runGit(repo, args);
      };
      for (let claim = 1; claim <= 2; claim += 1) {
        await expect(
          prepareReviewPublicationCandidate({
            completionId: "conflict-held",
            candidateSha,
            baseSha,
            git,
            commitIdentity: identity,
          }),
        ).rejects.toMatchObject({ code: "review_base_conflict" });
        const checkpoint = await persistValidationCheckpoint({
          completionId: "conflict-held",
          claimGeneration: claim,
          baselineSha: oldBase,
          candidateSha,
          git,
        });
        expect(requireGit(repo, ["rev-parse", checkpoint.candidateRef])).toBe(candidateSha);
      }
      expect(merges).toBe(1);
      expect(requireGit(repo, ["rev-parse", "HEAD"])).toBe(candidateSha);
      expect(requireGit(repo, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("worker edit\n");
      expect(
        (
          await loadLatestValidationCheckpoint({
            completionId: "conflict-held",
            beforeClaimGeneration: 3,
            git,
          })
        )?.validationProven,
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a head update between provider preflight and push is rejected by Git's original exact lease", async () => {
    const { root, repo, remote } = fixture();
    try {
      const baseSha = commit(repo, "base.txt", "base\n");
      requireGit(repo, ["checkout", "-b", "agent/feature"]);
      const originalHead = commit(repo, "feature.txt", "original\n");
      requireGit(repo, ["push", "origin", "agent/feature"]);
      const candidateSha = commit(repo, "feature.txt", "worker repair\n");
      requireGit(repo, ["checkout", "-B", "contributor", originalHead]);
      const changedHead = commit(repo, "contributor.txt", "independent revision\n");
      requireGit(repo, ["push", "origin", "HEAD:refs/heads/agent/feature"]);
      const rejected = runGit(
        repo,
        buildReviewPublicationPushArgs({
          remote: "origin",
          commitSha: candidateSha,
          lease: { ...lease, expectedHeadSha: originalHead, expectedBaseSha: baseSha },
        }),
      );
      expect(rejected.ok).toBe(false);
      expect(requireGit(remote, ["rev-parse", "refs/heads/agent/feature"])).toBe(changedHead);
      await expect(
        resolveReviewPublicationAuthority({
          ...authorityOptions(pullRequest({ head: { ...pullRequest().head, sha: changedHead } })),
          lease: { ...lease, expectedHeadSha: originalHead, expectedBaseSha: baseSha },
        }),
      ).rejects.toBeInstanceOf(ReviewPublicationSupersededError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
