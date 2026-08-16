import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "shared";
import {
  createJobCommit,
  syncHiddenRefWithRemoteBranchByRebase,
} from "../apps/workerpals/src/execute_job";

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
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw error;
  }
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

const skipRebaseSyncTest = await shouldSkipForGitSpawnPermission();
const runRebaseSyncTest = skipRebaseSyncTest ? test.skip : test;
const REBASE_SYNC_TEST_TIMEOUT_MS = 15_000;

describe("workerpals rebase sync", () => {
  runRebaseSyncTest(
    "syncs hidden ref with pull --rebase and auto-resolves conflicts in worker favor",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const worker = join(root, "worker");
      const branch = "agent/workerpal-test/job-branch";
      const file = "apps/localbuddy/tests/request_status.test.ts";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-123";

      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(root, ["clone", remote, worker], "clone worker");

        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );

        mkdirSync(join(maintainer, "apps", "localbuddy", "tests"), { recursive: true });
        writeFileSync(join(maintainer, file), "status: base\n", "utf8");
        await mustGit(maintainer, ["add", "-A"], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push base branch",
        );

        await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
        await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");

        writeFileSync(join(worker, file), "status: worker\n", "utf8");
        await mustGit(worker, ["add", "-A"], "stage worker commit");
        await mustGit(worker, ["commit", "-m", "worker change"], "worker commit");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");
        mkdirSync(join(worker, "workspace"), { recursive: true });
        writeFileSync(
          join(worker, "workspace", "should-stay-untracked.txt"),
          "transient\n",
          "utf8",
        );

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "maintainer checkout",
        );
        writeFileSync(join(maintainer, file), "status: remote\n", "utf8");
        await mustGit(maintainer, ["add", "-A"], "stage remote commit");
        await mustGit(maintainer, ["commit", "-m", "remote change"], "remote commit");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote change",
        );

        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-12345678",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) {
          throw new Error(sync.error);
        }

        const resolvedSha = await mustGit(
          worker,
          ["rev-parse", hiddenRef],
          "resolved hidden ref sha",
        );
        expect(resolvedSha).toBe(sync.sha);
        const resolvedFile = await mustGit(
          worker,
          ["show", `${sync.sha}:${file}`],
          "show resolved file",
        );
        expect(resolvedFile).toContain("status: worker");
        const transientLookup = await git(worker, [
          "show",
          `${sync.sha}:workspace/should-stay-untracked.txt`,
        ]);
        expect(transientLookup.ok).toBe(false);

        const rebaseTempBranches = await mustGit(
          worker,
          ["branch", "--list", "_pushpals/rebase-*"],
          "list temp rebase branches",
        );
        expect(rebaseTempBranches).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    REBASE_SYNC_TEST_TIMEOUT_MS,
  );

  runRebaseSyncTest(
    "syncs hidden ref through add/add conflicts and keeps the worker version",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-add-add-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const worker = join(root, "worker");
      const branch = "agent/workerpal-test/add-add";
      const file = "components/__tests__/AnimatedSelectionRing.test.tsx";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-add-add";

      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(root, ["clone", remote, worker], "clone worker");

        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );

        writeFileSync(join(maintainer, "README.md"), "base\n", "utf8");
        await mustGit(maintainer, ["add", "README.md"], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push base branch",
        );

        await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
        await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");
        mkdirSync(join(worker, "components", "__tests__"), { recursive: true });
        writeFileSync(join(worker, file), "export const source = 'worker';\n", "utf8");
        await mustGit(worker, ["add", file], "stage worker add");
        await mustGit(worker, ["commit", "-m", "worker add"], "worker commit");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "maintainer checkout",
        );
        mkdirSync(join(maintainer, "components", "__tests__"), { recursive: true });
        writeFileSync(join(maintainer, file), "export const source = 'remote';\n", "utf8");
        await mustGit(maintainer, ["add", file], "stage remote add");
        await mustGit(maintainer, ["commit", "-m", "remote add"], "remote commit");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote add",
        );

        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-addadd",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) throw new Error(sync.error);

        const resolvedFile = await mustGit(
          worker,
          ["show", `${sync.sha}:${file}`],
          "show resolved file",
        );
        expect(resolvedFile).toContain("worker");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    REBASE_SYNC_TEST_TIMEOUT_MS,
  );

  runRebaseSyncTest(
    "syncs hidden ref through remote delete versus worker modify conflicts and keeps the worker file",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-mod-del-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const worker = join(root, "worker");
      const branch = "agent/workerpal-test/modify-delete";
      const file = "apps/localbuddy/tests/request_status.test.ts";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-modify-delete";

      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(root, ["clone", remote, worker], "clone worker");

        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );

        mkdirSync(join(maintainer, "apps", "localbuddy", "tests"), { recursive: true });
        writeFileSync(join(maintainer, file), "status: base\n", "utf8");
        await mustGit(maintainer, ["add", "-A"], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push base branch",
        );

        await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
        await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");
        writeFileSync(join(worker, file), "status: worker\n", "utf8");
        await mustGit(worker, ["add", file], "stage worker modify");
        await mustGit(worker, ["commit", "-m", "worker modify"], "worker commit");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "maintainer checkout",
        );
        await mustGit(maintainer, ["rm", file], "remove remote file");
        await mustGit(maintainer, ["commit", "-m", "remote delete"], "remote delete commit");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote delete",
        );

        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-moddel",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) throw new Error(sync.error);

        const resolvedFile = await mustGit(
          worker,
          ["show", `${sync.sha}:${file}`],
          "show resolved file",
        );
        expect(resolvedFile).toContain("worker");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    REBASE_SYNC_TEST_TIMEOUT_MS,
  );

  runRebaseSyncTest(
    "preserves the hidden commit ref and returns publish-blocked diagnostics when required push sync cannot reach origin",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-publish-blocked-"));
      const repo = join(root, "repo");

      try {
        mkdirSync(repo, { recursive: true });
        await mustGit(root, ["init", repo], "init repo");
        await mustGit(repo, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          repo,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );
        writeFileSync(join(repo, "README.md"), "base\n", "utf8");
        await mustGit(repo, ["add", "README.md"], "stage base");
        await mustGit(repo, ["commit", "-m", "base"], "commit base");
        await mustGit(
          repo,
          ["remote", "add", "origin", join(root, "missing-remote.git")],
          "add broken origin",
        );

        writeFileSync(join(repo, "README.md"), "updated\n", "utf8");
        const runtimeConfig = loadPushPalsConfig();
        runtimeConfig.workerpals.llm.model = "";

        const commitResult = await createJobCommit(
          repo,
          "workerpal-test",
          {
            id: "job-publish-blocked",
            taskId: "task-publish-blocked",
            kind: "task.execute",
            params: {
              instruction: "Update README",
              completionBranch: "agent/workerpal-test/publish-blocked",
            },
            context: "host",
          },
          runtimeConfig,
        );

        expect(commitResult.ok).toBe(false);
        expect(commitResult.publishBlocked?.stage).toBe("sync");
        expect(commitResult.publishBlocked?.summary).toBe(
          "Failed to sync and push task.execute commit",
        );
        expect(commitResult.branch).toContain(
          "refs/pushpals/agent/workerpal-test/job-publish-blocked",
        );
        expect(commitResult.sha).toBeTruthy();

        const hiddenSha = await mustGit(
          repo,
          ["rev-parse", "refs/pushpals/agent/workerpal-test/job-publish-blocked"],
          "resolve hidden ref",
        );
        expect(hiddenSha).toBe(commitResult.sha);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "retains trusted-validation candidates locally even when normal publication is required",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-validation-hold-"));
      const repo = join(root, "repo");
      try {
        mkdirSync(repo, { recursive: true });
        await mustGit(root, ["init", repo], "init repo");
        await mustGit(repo, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          repo,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );
        writeFileSync(join(repo, "README.md"), "base\n", "utf8");
        await mustGit(repo, ["add", "README.md"], "stage base");
        await mustGit(repo, ["commit", "-m", "base"], "commit base");
        await mustGit(
          repo,
          ["remote", "add", "origin", join(root, "missing-remote.git")],
          "add broken origin",
        );
        writeFileSync(join(repo, "README.md"), "candidate\n", "utf8");

        const runtimeConfig = loadPushPalsConfig();
        runtimeConfig.workerpals.requirePush = true;
        runtimeConfig.workerpals.llm.model = "";
        const commitResult = await createJobCommit(
          repo,
          "workerpal-test",
          {
            id: "job-validation-hold",
            taskId: "task-validation-hold",
            kind: "task.execute",
            params: {
              instruction: "Update README",
              completionBranch: "agent/workerpal-test/validation-hold",
            },
            context: "host",
            deferPublication: true,
          },
          runtimeConfig,
        );

        expect(commitResult.ok).toBe(true);
        expect(commitResult.branch).toBe(
          "refs/pushpals/agent/workerpal-test/job-validation-hold",
        );
        expect(commitResult.publicBranch).toBe(
          "agent/workerpal-test/validation-hold",
        );
        expect(commitResult.sha).toBeTruthy();
        expect(commitResult.publishBlocked).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "retains review-fix commits locally for SourceControlManager without worker-side pushes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-review-fix-handoff-"));
      const remote = join(root, "remote.git");
      const repo = join(root, "repo");
      const publicBranch = "agent/review/existing-pr";
      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, repo], "clone worker repo");
        await mustGit(repo, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          repo,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );
        writeFileSync(join(repo, "README.md"), "base\n", "utf8");
        await mustGit(repo, ["add", "README.md"], "stage base");
        await mustGit(repo, ["commit", "-m", "base"], "commit base");
        await mustGit(
          repo,
          ["push", "origin", `HEAD:refs/heads/${publicBranch}`],
          "publish PR head",
        );
        const originalHead = await mustGit(repo, ["rev-parse", "HEAD"], "resolve original head");

        writeFileSync(join(repo, "README.md"), "review fix\n", "utf8");
        const runtimeConfig = loadPushPalsConfig();
        runtimeConfig.workerpals.llm.model = "";
        const commitResult = await createJobCommit(
          repo,
          "workerpal-test",
          {
            id: "job-review-fix",
            taskId: "task-review-fix",
            kind: "task.execute",
            params: {
              instruction: "Address reviewer feedback in README",
              completionBranch: publicBranch,
              reviewAgent: {
                resolutionType: "review_fix",
                prHeadRef: publicBranch,
                prHeadSha: originalHead,
                prBaseRef: "main",
              },
            },
            context: "docker",
          },
          runtimeConfig,
        );

        expect(commitResult.ok).toBe(true);
        expect(commitResult.branch).toBe("refs/pushpals/review/workerpal-test/job-review-fix");
        expect(commitResult.sha).toBeTruthy();
        expect(commitResult.sha).not.toBe(originalHead);
        const publicHead = await mustGit(
          repo,
          ["ls-remote", "--heads", "origin", `refs/heads/${publicBranch}`],
          "inspect public PR branch",
        );
        expect(publicHead.startsWith(`${originalHead}\t`)).toBe(true);
        const completionHead = await mustGit(
          repo,
          ["rev-parse", commitResult.branch!],
          "inspect immutable local review completion",
        );
        expect(completionHead).toBe(commitResult.sha);
        const remoteCompletionHead = await mustGit(
          repo,
          ["ls-remote", "origin", commitResult.branch!],
          "confirm worker did not upload the review completion",
        );
        expect(remoteCompletionHead).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "removes a managed node_modules link before host-side review finalization",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-review-fix-dependency-artifact-"));
      const remote = join(root, "remote.git");
      const repo = join(root, "repo");
      const dependencyProjection = join(root, "linux-dependency-projection");
      const publicBranch = "agent/review/dependency-artifact";
      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, repo], "clone worker repo");
        await mustGit(repo, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          repo,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );
        writeFileSync(join(repo, "README.md"), "base\n", "utf8");
        await mustGit(repo, ["add", "README.md"], "stage base");
        await mustGit(repo, ["commit", "-m", "base"], "commit base");
        await mustGit(
          repo,
          ["push", "origin", `HEAD:refs/heads/${publicBranch}`],
          "publish PR head",
        );
        const originalHead = await mustGit(repo, ["rev-parse", "HEAD"], "resolve original head");

        mkdirSync(dependencyProjection, { recursive: true });
        writeFileSync(join(dependencyProjection, "container-only-package"), "fixture\n", "utf8");
        symlinkSync(
          dependencyProjection,
          join(repo, "node_modules"),
          process.platform === "win32" ? "junction" : "dir",
        );
        writeFileSync(join(repo, "README.md"), "review fix\n", "utf8");

        const runtimeConfig = loadPushPalsConfig();
        runtimeConfig.workerpals.llm.model = "";
        const commitResult = await createJobCommit(
          repo,
          "workerpal-test",
          {
            id: "job-review-fix-dependency-artifact",
            taskId: "task-review-fix-dependency-artifact",
            kind: "task.execute",
            params: {
              instruction: "Address reviewer feedback in README",
              completionBranch: publicBranch,
              reviewAgent: {
                resolutionType: "review_fix",
                prHeadRef: publicBranch,
                prHeadSha: originalHead,
                prBaseRef: "main",
              },
            },
            context: "docker",
          },
          runtimeConfig,
        );

        expect(commitResult.ok).toBe(true);
        expect(existsSync(join(repo, "node_modules"))).toBe(false);
        const committedPaths = await mustGit(
          repo,
          ["show", "--pretty=format:", "--name-only", commitResult.sha!],
          "inspect finalized paths",
        );
        expect(committedPaths.split(/\r?\n/).filter(Boolean)).toEqual(["README.md"]);
        expect(readFileSync(join(dependencyProjection, "container-only-package"), "utf8")).toBe(
          "fixture\n",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "scrubs transient untracked .codex artifacts before pull --rebase sync",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-codex-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const worker = join(root, "worker");
      const branch = "agent/workerpal-test/codex-artifact";
      const file = "README.md";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-codex-artifact";

      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(root, ["clone", remote, worker], "clone worker");

        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );

        writeFileSync(join(maintainer, file), "base\n", "utf8");
        await mustGit(maintainer, ["add", file], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push base branch",
        );

        await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
        await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");
        writeFileSync(join(worker, file), "worker change\n", "utf8");
        await mustGit(worker, ["add", file], "stage worker change");
        await mustGit(worker, ["commit", "-m", "worker change"], "worker commit");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");
        writeFileSync(join(worker, ".codex"), "transient codex state\n", "utf8");

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "maintainer checkout",
        );
        writeFileSync(join(maintainer, ".codex"), "tracked remote codex file\n", "utf8");
        await mustGit(maintainer, ["add", ".codex"], "stage remote codex");
        await mustGit(maintainer, ["commit", "-m", "remote codex"], "remote codex commit");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote codex",
        );

        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-codex",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) throw new Error(sync.error);

        expect(git(worker, ["status", "--porcelain", "--", ".codex"])).resolves.toMatchObject({
          stdout: "",
        });
        const syncedCodex = await mustGit(
          worker,
          ["show", `${sync.sha}:.codex`],
          "show synced .codex",
        );
        expect(syncedCodex).toContain("tracked remote codex file");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "preserves tracked .codex sentinels across rebase retry after conflict resolution",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-sync-codex-retry-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const worker = join(root, "worker");
      const branch = "agent/workerpal-test/codex-retry";
      const file = "README.md";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-codex-retry";

      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(root, ["clone", remote, worker], "clone worker");

        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );

        writeFileSync(join(maintainer, file), "base\n", "utf8");
        await mustGit(maintainer, ["add", file], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push base branch",
        );

        await mustGit(worker, ["fetch", "origin", branch], "worker fetch");
        await mustGit(worker, ["checkout", "-B", branch, `origin/${branch}`], "worker checkout");
        writeFileSync(join(worker, file), "worker change\n", "utf8");
        await mustGit(worker, ["add", file], "stage worker change");
        await mustGit(worker, ["commit", "-m", "worker change"], "worker commit");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "update hidden ref");
        writeFileSync(join(worker, ".codex"), "transient codex state\n", "utf8");

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "maintainer checkout",
        );
        writeFileSync(join(maintainer, file), "remote change\n", "utf8");
        writeFileSync(join(maintainer, ".codex"), "tracked remote codex file\n", "utf8");
        await mustGit(maintainer, ["add", file, ".codex"], "stage remote conflict and codex");
        await mustGit(maintainer, ["commit", "-m", "remote conflict and codex"], "remote commit");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote branch",
        );

        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-codex-retry",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) throw new Error(sync.error);

        await expect(git(worker, ["status", "--porcelain", "--", ".codex"])).resolves.toMatchObject(
          {
            stdout: "",
          },
        );
        const syncedCodex = await mustGit(
          worker,
          ["show", `${sync.sha}:.codex`],
          "show synced .codex",
        );
        expect(syncedCodex).toContain("tracked remote codex file");
        const syncedReadme = await mustGit(
          worker,
          ["show", `${sync.sha}:${file}`],
          "show synced readme",
        );
        expect(syncedReadme).toContain("worker change");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  runRebaseSyncTest(
    "resets tracked and colliding untracked residue only inside a disposable publication worktree",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pushpals-rebase-dirty-linked-"));
      const remote = join(root, "remote.git");
      const maintainer = join(root, "maintainer");
      const host = join(root, "host");
      const worker = join(root, "worker-worktree");
      const branch = "agent/workerpal-test/dirty-linked";
      const hiddenRef = "refs/pushpals/agent/workerpal-test/job-dirty-linked";
      try {
        await mustGit(root, ["init", "--bare", remote], "init bare remote");
        await mustGit(root, ["clone", remote, maintainer], "clone maintainer");
        await mustGit(maintainer, ["config", "user.name", "PushPals Test"], "set maintainer name");
        await mustGit(
          maintainer,
          ["config", "user.email", "pushpals-test@example.com"],
          "set maintainer email",
        );
        writeFileSync(join(maintainer, "tracked.txt"), "base\n", "utf8");
        await mustGit(maintainer, ["add", "tracked.txt"], "stage base");
        await mustGit(maintainer, ["commit", "-m", "base"], "commit base");
        await mustGit(maintainer, ["push", "origin", `HEAD:refs/heads/${branch}`], "push base");

        await mustGit(root, ["clone", remote, host], "clone host");
        await mustGit(host, ["fetch", "origin", branch], "fetch branch");
        await mustGit(
          host,
          ["worktree", "add", "--detach", worker, `origin/${branch}`],
          "create linked worker worktree",
        );
        await mustGit(worker, ["config", "user.name", "PushPals Worker"], "set worker name");
        await mustGit(
          worker,
          ["config", "user.email", "pushpals-worker@example.com"],
          "set worker email",
        );
        writeFileSync(join(worker, "worker.txt"), "worker committed\n", "utf8");
        await mustGit(worker, ["add", "worker.txt"], "stage worker file");
        await mustGit(worker, ["commit", "-m", "worker change"], "commit worker file");
        const workerSha = await mustGit(worker, ["rev-parse", "HEAD"], "resolve worker sha");
        await mustGit(worker, ["update-ref", hiddenRef, workerSha], "retain worker commit");

        await mustGit(
          maintainer,
          ["checkout", "-B", branch, `origin/${branch}`],
          "checkout remote branch",
        );
        writeFileSync(join(maintainer, "remote.txt"), "remote advanced\n", "utf8");
        writeFileSync(join(maintainer, "collision.txt"), "remote collision\n", "utf8");
        await mustGit(maintainer, ["add", "remote.txt", "collision.txt"], "stage remote change");
        await mustGit(maintainer, ["commit", "-m", "remote change"], "commit remote change");
        await mustGit(
          maintainer,
          ["push", "origin", `HEAD:refs/heads/${branch}`],
          "push remote change",
        );

        writeFileSync(join(worker, "worker.txt"), "dirty residue\n", "utf8");
        writeFileSync(join(worker, "collision.txt"), "untracked residue\n", "utf8");
        const sync = await syncHiddenRefWithRemoteBranchByRebase(
          worker,
          hiddenRef,
          branch,
          "job-dirty-linked",
        );
        expect(sync.ok).toBe(true);
        if (!sync.ok) throw new Error(sync.error);
        expect(readFileSync(join(worker, "worker.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
          "worker committed\n",
        );
        expect(readFileSync(join(worker, "collision.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
          "remote collision\n",
        );
        expect((await git(worker, ["status", "--porcelain"])).stdout).toBe("");
      } finally {
        try {
          await git(host, ["worktree", "remove", "--force", worker]);
        } catch {
          // Best-effort cleanup for failed setup.
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
