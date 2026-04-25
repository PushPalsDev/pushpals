import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createJobCommit,
  executeJob,
  resumePreparedMergeConflictRebase,
} from "../apps/workerpals/src/execute_job";
import { prepareMergeConflictTaskRepo } from "../apps/workerpals/src/merge_conflict_job";
import { loadPushPalsConfig } from "shared";
import type { WorkerpalsRuntimeConfig } from "../apps/workerpals/src/common/executor_backend";
import type { ExecutorBackend } from "../apps/workerpals/src/common/types";
import { BACKEND_EXECUTOR_SCRIPT_SEGMENTS } from "../apps/workerpals/src/backends/backend_config";
import {
  getBackendTaskExecutor,
  registerBackendTaskExecutor,
  unregisterBackendTaskExecutor,
  type BackendTaskExecutor,
} from "../apps/workerpals/src/backends/task_execute_registry";

const TEST_BACKEND = "__test_merge_conflict_backend__" as ExecutorBackend;

function stubBackendScriptSegmentsForTesting(
  backend: ExecutorBackend,
  segments: readonly string[] = [],
): () => void {
  const hadEntry = Object.prototype.hasOwnProperty.call(BACKEND_EXECUTOR_SCRIPT_SEGMENTS, backend);
  const previousSegments = BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend];
  BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend] = segments;
  return () => {
    if (!hadEntry) {
      delete BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend];
    } else {
      BACKEND_EXECUTOR_SCRIPT_SEGMENTS[backend] = previousSegments ?? [];
    }
  };
}

function installTestBackendExecutor(executor: BackendTaskExecutor): () => void {
  const previousExecutor = getBackendTaskExecutor(TEST_BACKEND);
  registerBackendTaskExecutor(TEST_BACKEND, executor);
  return () => {
    if (previousExecutor) {
      registerBackendTaskExecutor(TEST_BACKEND, previousExecutor);
    } else {
      unregisterBackendTaskExecutor(TEST_BACKEND);
    }
  };
}

function isGitSpawnPermissionDenied(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "")
    .trim()
    .toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "")
    .trim()
    .toLowerCase();
  return (
    code === "EPERM" &&
    message.includes("uv_spawn") &&
    (message.includes("'git'") || message.includes('"git"'))
  );
}

async function shouldSkipForGitSpawnPermission(): Promise<boolean> {
  try {
    const probe = await git(process.cwd(), ["--version"]);
    return !probe.ok && probe.stderr.toLowerCase().includes("eperm");
  } catch (error) {
    if (isGitSpawnPermissionDenied(error)) return true;
    throw error;
  }
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function mustGit(cwd: string, args: string[], label: string): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error(`${label} failed: git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

type ConflictFixture = {
  root: string;
  remote: string;
  sourceRepo: string;
  publicBranch: string;
  baseBranch: string;
  prHeadSha: string;
  conflictFile: string;
  params: Record<string, unknown>;
};

async function createConflictFixture(): Promise<ConflictFixture> {
  const root = mkdtempSync(join(tmpdir(), "pushpals-merge-conflict-job-"));
  const remote = join(root, "remote.git");
  const maintainer = join(root, "maintainer");
  const sourceRepo = join(root, "source");
  const publicBranch = "agent/test-branch";
  const baseBranch = "main";
  const conflictFile = "apps/client/src/conflict.tsx";

  await mustGit(root, ["init", "--bare", remote], "init bare remote");
  await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
  await mustGit(root, ["clone", remote, sourceRepo], "clone source repo");

  for (const repo of [maintainer, sourceRepo]) {
    await mustGit(repo, ["config", "user.name", "PushPals Test"], "set user.name");
    await mustGit(repo, ["config", "user.email", "pushpals-test@example.com"], "set user.email");
  }

  await mustGit(maintainer, ["checkout", "-B", baseBranch], "checkout main");
  mkdirSync(join(maintainer, "apps", "client", "src"), { recursive: true });
  writeFileSync(join(maintainer, conflictFile), "export const conflict = 'base';\n", "utf8");
  await mustGit(maintainer, ["add", "-A"], "stage base");
  await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
  await mustGit(maintainer, ["push", "origin", `HEAD:refs/heads/${baseBranch}`], "push main");

  await mustGit(
    maintainer,
    ["checkout", "-B", publicBranch, `origin/${baseBranch}`],
    "checkout public branch",
  );
  writeFileSync(join(maintainer, conflictFile), "export const conflict = 'branch';\n", "utf8");
  await mustGit(maintainer, ["add", "-A"], "stage branch change");
  await mustGit(maintainer, ["commit", "-m", "branch change"], "commit branch change");
  await mustGit(
    maintainer,
    ["push", "origin", `HEAD:refs/heads/${publicBranch}`],
    "push branch change",
  );
  const prHeadSha = await mustGit(maintainer, ["rev-parse", "HEAD"], "resolve branch HEAD");

  await mustGit(maintainer, ["checkout", "-B", baseBranch, `origin/${baseBranch}`], "return to main");
  writeFileSync(join(maintainer, conflictFile), "export const conflict = 'main';\n", "utf8");
  await mustGit(maintainer, ["add", "-A"], "stage main conflict");
  await mustGit(maintainer, ["commit", "-m", "main conflict"], "commit main conflict");
  await mustGit(maintainer, ["push", "origin", `HEAD:refs/heads/${baseBranch}`], "push main conflict");

  await mustGit(sourceRepo, ["fetch", "origin", baseBranch, publicBranch], "fetch source refs");
  await mustGit(sourceRepo, ["checkout", "-B", baseBranch, `origin/${baseBranch}`], "source checkout main");

  return {
    root,
    remote,
    sourceRepo,
    publicBranch,
    baseBranch,
    prHeadSha,
    conflictFile,
    params: {
      schemaVersion: 2,
      instruction: "Resolve the merge conflict and update the approved PR branch.",
      planning: {
        intent: "code_change",
        riskLevel: "medium",
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: ["apps/client/**"],
        },
        acceptanceCriteria: ["PR branch rebases cleanly onto main."],
        validationSteps: ["bun test"],
      },
      lane: "deterministic",
      completionBranch: publicBranch,
      reviewAgent: {
        prHeadRef: publicBranch,
        prBaseRef: baseBranch,
        prHeadSha,
        resolutionType: "merge_conflict",
        mergeError: "Pull Request is not mergeable",
      },
    },
  };
}

const skipMergeConflictTests = await shouldSkipForGitSpawnPermission();
const runMergeConflictTest = skipMergeConflictTests ? test.skip : test;

describe("workerpals merge-conflict sandbox", () => {
  runMergeConflictTest("prepares merge-conflict repo in isolated sandbox without switching source checkout", async () => {
    const fixture = await createConflictFixture();
    try {
      const sourceBranchBefore = await mustGit(
        fixture.sourceRepo,
        ["branch", "--show-current"],
        "source branch before preparation",
      );
      const prepared = await prepareMergeConflictTaskRepo(
        fixture.sourceRepo,
        "job-merge-conflict",
        fixture.params,
      );
        try {
          expect(prepared.repoPath).not.toBe(fixture.sourceRepo);
          expect(prepared.plannerGuidance).toContain("isolated container-local clone");
          expect(prepared.plannerGuidance).toContain("Use direct commands only while resolving this rebase");
          expect(prepared.conflictPaths).toEqual([fixture.conflictFile]);
          const sandboxBranchList = await mustGit(
            prepared.repoPath,
          ["branch", "--list", fixture.publicBranch],
          "list sandbox branch",
        );
        expect(sandboxBranchList).toContain(fixture.publicBranch);
        const unresolved = await mustGit(
          prepared.repoPath,
          ["diff", "--name-only", "--diff-filter=U"],
          "list unresolved files",
        );
        expect(unresolved).toBe(fixture.conflictFile);
        const sourceBranchAfter = await mustGit(
          fixture.sourceRepo,
          ["branch", "--show-current"],
          "source branch after preparation",
        );
        expect(sourceBranchAfter).toBe(sourceBranchBefore);
      } finally {
        prepared.cleanup();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  runMergeConflictTest(
    "createJobCommit force-pushes a completed merge-conflict rebase back to the same PR branch",
    async () => {
      const fixture = await createConflictFixture();
      try {
        const prepared = await prepareMergeConflictTaskRepo(
          fixture.sourceRepo,
          "job-merge-conflict",
          fixture.params,
        );
        try {
          writeFileSync(
            join(prepared.repoPath, fixture.conflictFile),
            "export const conflict = 'resolved';\n",
            "utf8",
          );
          await mustGit(prepared.repoPath, ["add", fixture.conflictFile], "stage resolved conflict");
          await mustGit(
            prepared.repoPath,
            ["-c", "core.editor=true", "rebase", "--continue"],
            "continue rebase",
          );

          const runtimeConfig = loadPushPalsConfig();
          const commitResult = await createJobCommit(
            prepared.repoPath,
            "workerpal-test",
            {
              id: "job-merge-conflict",
              taskId: "task-merge-conflict",
              kind: "task.execute",
              params: fixture.params,
              context: "docker",
            },
            runtimeConfig,
          );
          expect(commitResult.ok).toBe(true);
          expect(commitResult.branch).toBe(fixture.publicBranch);
          expect(commitResult.sha).toBeTruthy();
          expect(commitResult.sha).not.toBe(fixture.prHeadSha);

          const lsRemote = await mustGit(
            fixture.sourceRepo,
            ["ls-remote", "--heads", "origin", `refs/heads/${fixture.publicBranch}`],
            "inspect remote branch",
          );
          expect(lsRemote.startsWith(`${commitResult.sha}\t`)).toBe(true);
          const resolvedFile = readFileSync(join(prepared.repoPath, fixture.conflictFile), "utf8");
          expect(resolvedFile).toContain("resolved");
        } finally {
          prepared.cleanup();
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  runMergeConflictTest(
    "executeJob fails before quality validation when a merge-conflict rebase is still active",
    async () => {
      const fixture = await createConflictFixture();
      const restoreSegments = stubBackendScriptSegmentsForTesting(TEST_BACKEND);
      const restoreExecutor = installTestBackendExecutor(async (_kind, _params, _repo, _runtime, onLog) => {
        onLog?.("stdout", "[stub] merge-conflict executor returned without finishing the rebase");
        return {
          ok: true,
          summary: "stub executor completed",
          stdout: "__stub_stdout__",
          stderr: "__stub_stderr__",
          exitCode: 0,
        };
      });
      try {
        const prepared = await prepareMergeConflictTaskRepo(
          fixture.sourceRepo,
          "job-merge-conflict-active-rebase",
          fixture.params,
        );
        try {
          const base = loadPushPalsConfig({ reload: true });
          const runtimeConfig: WorkerpalsRuntimeConfig = {
            ...base,
            workerpals: {
              ...base.workerpals,
              executor: TEST_BACKEND,
              qualityMaxAutoRevisions: 1,
              qualitySoftPassOnExhausted: true,
            },
          };
          const forwardedLogs: Array<{ stream: "stdout" | "stderr"; line: string }> = [];

          const result = await executeJob(
            "task.execute",
            fixture.params,
            prepared.repoPath,
            (stream, line) => {
              forwardedLogs.push({ stream, line });
            },
            runtimeConfig,
          );

          expect(result.ok).toBe(false);
          expect(result.exitCode).toBe(4);
          expect(result.summary).toContain("git rebase still in progress");
          expect(result.stderr).toContain("git rebase still in progress");
          expect(
            forwardedLogs.some((entry) => entry.line.includes("merge_conflict override active")),
          ).toBe(true);
          expect(
            forwardedLogs.some((entry) => entry.line.includes("Soft-pass after")),
          ).toBe(false);
          expect(
            forwardedLogs.some((entry) => entry.line.includes("Quality gate validation failed")),
          ).toBe(false);
        } finally {
          prepared.cleanup();
        }
      } finally {
        restoreExecutor();
        restoreSegments();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  runMergeConflictTest(
    "resumePreparedMergeConflictRebase stages a resolved conflict and continues the prepared rebase",
    async () => {
      const fixture = await createConflictFixture();
      try {
        const prepared = await prepareMergeConflictTaskRepo(
          fixture.sourceRepo,
          "job-merge-conflict-resume",
          fixture.params,
        );
        try {
          writeFileSync(
            join(prepared.repoPath, fixture.conflictFile),
            "export const conflict = 'resolved-by-helper';\n",
            "utf8",
          );

          const forwardedLogs: Array<{ stream: "stdout" | "stderr"; line: string }> = [];
          const resume = await resumePreparedMergeConflictRebase(
            prepared.repoPath,
            "task.execute",
            fixture.params,
            (stream, line) => forwardedLogs.push({ stream, line }),
          );

          expect(resume.ok).toBe(true);
          if (!resume.ok) return;
          expect(resume.resumed).toBe(true);
          expect(resume.sequencer).toBe(null);
          expect(
            forwardedLogs.some((entry) =>
              entry.line.includes("Auto-continued the prepared rebase"),
            ),
          ).toBe(true);

          const status = await mustGit(
            prepared.repoPath,
            ["status", "--porcelain"],
            "inspect working tree after auto-continue",
          );
          expect(status).not.toContain("UU ");
          const resolvedFile = readFileSync(join(prepared.repoPath, fixture.conflictFile), "utf8");
          expect(resolvedFile).toContain("resolved-by-helper");
        } finally {
          prepared.cleanup();
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  runMergeConflictTest(
    "executeJob treats prepared merge-conflict test paths as changed and stops on repo validation blockers without a revision retry",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-merge-conflict-quality-"));
      const repo = join(root, "repo");
      mkdirSync(join(repo, "components", "__tests__"), { recursive: true });
      const testPath = "components/__tests__/AnimatedSelectionRing.test.tsx";
      const restoreSegments = stubBackendScriptSegmentsForTesting(TEST_BACKEND);
      const restoreExecutor = installTestBackendExecutor(async () => ({
        ok: true,
        summary: "stub merge-conflict resolution completed",
        stdout: "__stub_stdout__",
        stderr: "",
        exitCode: 0,
      }));
      try {
        await mustGit(root, ["init", repo], "init merge-conflict quality repo");
        await mustGit(repo, ["config", "user.name", "PushPals Test"], "set user.name");
        await mustGit(repo, ["config", "user.email", "pushpals-test@example.com"], "set user.email");
        writeFileSync(
          join(repo, testPath),
          "import missingHelper from '../../tests/reactNativeMock';\nvoid missingHelper;\ntest('placeholder', () => { expect(true).toBe(true); expect(null).toBeNull(); });\n",
          "utf8",
        );
        await mustGit(repo, ["add", "-A"], "stage quality repo");
        await mustGit(repo, ["commit", "-m", "seed test repo"], "commit quality repo");

        const base = loadPushPalsConfig({ reload: true });
        const runtimeConfig: WorkerpalsRuntimeConfig = {
          ...base,
          workerpals: {
            ...base.workerpals,
            executor: TEST_BACKEND,
            qualityMaxAutoRevisions: 1,
            qualitySoftPassOnExhausted: false,
          },
        };
        const params = {
          schemaVersion: 2,
          instruction: `Resolve the merge conflict in ${testPath} and validate the test file.`,
          planning: {
            intent: "code_change",
            riskLevel: "medium",
            scope: {
              readAnywhere: true,
              writeAllowed: true,
              writeGlobs: ["components/**"],
            },
            discovery: {
              ripgrepQueries: ["AnimatedSelectionRing"],
              likelyDirs: ["components/__tests__"],
            },
            acceptanceCriteria: ["Resolve the merge conflict and keep the test healthy."],
            validationSteps: [`bun test ${testPath}`],
            queuePriority: "normal",
            queueWaitBudgetMs: 90_000,
            executionBudgetMs: 1_800_000,
            finalizationBudgetMs: 120_000,
          },
          lane: "deterministic",
          completionBranch: "agent/test-branch",
          reviewAgent: {
            prHeadRef: "agent/test-branch",
            prBaseRef: "main",
            prHeadSha: "1234567890abcdef",
            resolutionType: "merge_conflict",
            mergeError: "Pull Request has merge conflicts",
            preparedConflictPaths: [testPath],
            preparedRebaseState: "clean",
          },
        };
        const forwardedLogs: Array<{ stream: "stdout" | "stderr"; line: string }> = [];

        const result = await executeJob(
          "task.execute",
          params,
          repo,
          (stream, line) => forwardedLogs.push({ stream, line }),
          runtimeConfig,
        );

        expect(result.ok).toBe(false);
        expect(result.summary).toContain("Quality gate blocked by repo issue");
        expect(result.summary).not.toContain("No relevant test file was modified");
        expect(
          forwardedLogs.some((entry) => entry.line.includes("Quality gate requested revision")),
        ).toBe(false);
        expect(
          forwardedLogs.some((entry) => entry.line.includes("No relevant test file was modified")),
        ).toBe(false);
      } finally {
        restoreExecutor();
        restoreSegments();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
