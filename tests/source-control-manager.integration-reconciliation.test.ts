import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitOps, runGitCommandCapture } from "../apps/source_control_manager/src/git";
import {
  buildIntegrationReconciliationJob,
  integrationReconciliationFingerprint,
} from "../apps/source_control_manager/src/integration_reconciliation";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-integration-reconcile-"));
  tempDirs.push(dir);
  return dir;
}

async function mustGit(repoPath: string, args: string[]): Promise<string> {
  const result = await runGitCommandCapture(repoPath, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function createFixture(options: { conflicting: boolean }): Promise<{
  remote: string;
  scm: string;
  integrationHeadSha: string;
  baseHeadSha: string;
}> {
  const root = makeTempDir();
  const remote = join(root, "remote.git");
  const maintainer = join(root, "maintainer");
  const scm = join(root, "scm");
  mkdirSync(remote, { recursive: true });
  await mustGit(remote, ["init", "--bare"]);
  await mustGit(root, ["clone", remote, maintainer]);
  await mustGit(maintainer, ["config", "user.name", "PushPals Test"]);
  await mustGit(maintainer, ["config", "user.email", "tests@pushpals.dev"]);
  await mustGit(maintainer, ["checkout", "-B", "main"]);
  writeFileSync(join(maintainer, "shared.txt"), "base\n", "utf8");
  await mustGit(maintainer, ["add", "shared.txt"]);
  await mustGit(maintainer, ["commit", "-m", "seed"]);
  await mustGit(maintainer, ["push", "origin", "main"]);
  await mustGit(maintainer, ["checkout", "-B", "main_agents"]);
  writeFileSync(
    join(maintainer, options.conflicting ? "shared.txt" : "integration.txt"),
    "integration\n",
    "utf8",
  );
  await mustGit(maintainer, ["add", "-A"]);
  await mustGit(maintainer, ["commit", "-m", "integration work"]);
  await mustGit(maintainer, ["push", "origin", "main_agents"]);
  const integrationHeadSha = await mustGit(maintainer, ["rev-parse", "HEAD"]);

  await mustGit(maintainer, ["checkout", "main"]);
  writeFileSync(
    join(maintainer, options.conflicting ? "shared.txt" : "base.txt"),
    "main\n",
    "utf8",
  );
  await mustGit(maintainer, ["add", "-A"]);
  await mustGit(maintainer, ["commit", "-m", "advance main"]);
  await mustGit(maintainer, ["push", "origin", "main"]);
  const baseHeadSha = await mustGit(maintainer, ["rev-parse", "HEAD"]);

  await mustGit(root, ["clone", remote, scm]);
  await mustGit(scm, ["config", "user.name", "PushPals Test"]);
  await mustGit(scm, ["config", "user.email", "tests@pushpals.dev"]);
  await mustGit(scm, ["fetch", "origin", "main", "main_agents"]);

  return { remote, scm, integrationHeadSha, baseHeadSha };
}

function createGitOps(repoPath: string): GitOps {
  return new GitOps({
    repoPath,
    remote: "origin",
    mainBranch: "main_agents",
    integrationBaseBranch: "main",
    branchPrefix: "agent/",
    gitToken: null,
  } as any);
}

describe("source_control_manager integration reconciliation", () => {
  test("merges and pushes cleanly diverged integration history without a completion", async () => {
    const fixture = await createFixture({ conflicting: false });
    const gitOps = createGitOps(fixture.scm);

    await gitOps.fetchPrune();
    await gitOps.checkoutMain();
    await gitOps.pullMainFF();
    const sync = await gitOps.syncMainWithBaseBranch();

    expect(sync.status).toBe("updated");
    if (sync.status !== "updated") throw new Error(`unexpected sync status ${sync.status}`);
    expect(sync.integrationHeadSha).toBe(fixture.integrationHeadSha);
    expect(sync.baseHeadSha).toBe(fixture.baseHeadSha);
    expect((await gitOps.pushMain()).ok).toBe(true);
    await gitOps.fetchPrune();
    expect(await gitOps.isAncestor("origin/main", "origin/main_agents")).toBe(true);
    expect(await gitOps.isAncestor(fixture.integrationHeadSha, "origin/main_agents")).toBe(true);
  }, 20_000);

  test("returns exact conflict state, aborts the host merge, and builds a leased repair job", async () => {
    const fixture = await createFixture({ conflicting: true });
    const gitOps = createGitOps(fixture.scm);

    await gitOps.fetchPrune();
    await gitOps.checkoutMain();
    await gitOps.pullMainFF();
    const sync = await gitOps.syncMainWithBaseBranch();

    expect(sync.status).toBe("conflicted");
    if (sync.status !== "conflicted") throw new Error(`unexpected sync status ${sync.status}`);
    expect(sync.integrationHeadSha).toBe(fixture.integrationHeadSha);
    expect(sync.baseHeadSha).toBe(fixture.baseHeadSha);
    expect(sync.conflictPaths).toEqual(["shared.txt"]);
    expect(await gitOps.isRepoClean()).toBe(true);
    expect(await gitOps.getMainHeadSha()).toBe(fixture.integrationHeadSha);

    const payload = buildIntegrationReconciliationJob({
      sessionId: "dev",
      integrationBranch: "main_agents",
      baseBranch: "main",
      sync,
      now: 1_700_000_000_000,
    });
    expect(payload.priority).toBe("interactive");
    expect(payload.dedupeKey).toBe(
      integrationReconciliationFingerprint({
        integrationBranch: "main_agents",
        integrationHeadSha: fixture.integrationHeadSha,
        baseHeadSha: fixture.baseHeadSha,
      }),
    );
    expect(payload.params.completionBranch).toBe("main_agents");
    expect(payload.params.planning).toMatchObject({
      targetPaths: ["shared.txt"],
      scope: { writeGlobs: ["shared.txt"] },
    });
    expect(payload.params.reviewAgent).toMatchObject({
      resolutionType: "integration_reconcile",
      prHeadRef: "main_agents",
      prBaseRef: "main",
      prHeadSha: fixture.integrationHeadSha,
      prBaseSha: fixture.baseHeadSha,
    });
  }, 20_000);
});
