import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  assertSupportedSourceControlProvider,
  normalizeSourceControlProvider,
  resolveSourceControlProvider,
} from "../packages/shared/src/source_control_api";
import {
  createSourceControlApi,
  GitSourceControlApi,
  runGitCommandCapture,
} from "../apps/source_control_manager/src/git";
import type { SourceControlManagerConfig } from "../apps/source_control_manager/src/config";

function makeConfig(repoPath: string): SourceControlManagerConfig {
  return {
    repoPath,
    serverUrl: "http://127.0.0.1:3001",
    remote: "origin",
    mainBranch: "main_agents",
    integrationBaseBranch: "main",
    branchPrefix: "agent/",
    pollIntervalSeconds: 10,
    checks: [],
    stateDir: join(repoPath, ".pushpals-source-control-manager"),
    port: 3002,
    deleteAfterMerge: false,
    maxAttempts: 3,
    mergeStrategy: "cherry-pick",
    pushMainAfterMerge: false,
    openPrAfterPush: false,
    prBaseBranch: "main",
    prTitle: "",
    prBody: "",
    prDraft: false,
    gitToken: null,
    statusHeartbeatMs: 10_000,
    skipCleanCheck: false,
    autoCreateMainBranch: false,
    reviewAgent: {
      enabled: false,
      mode: "local",
      minScore: 8,
      openPrOnFailure: true,
      openPrOnSuccess: true,
      deleteBranchOnMerge: false,
      checks: [],
    },
  } as SourceControlManagerConfig;
}

async function git(repoPath: string, args: string[]): Promise<void> {
  const result = await runGitCommandCapture(repoPath, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

describe("source control API", () => {
  test("normalizes known providers and aliases", () => {
    expect(normalizeSourceControlProvider("git")).toBe("git");
    expect(normalizeSourceControlProvider("auto")).toBe("git");
    expect(normalizeSourceControlProvider("sl")).toBe("sapling");
    expect(normalizeSourceControlProvider("mercury")).toBe("mercurial");
    expect(normalizeSourceControlProvider("hg")).toBe("mercurial");
    expect(normalizeSourceControlProvider("svn")).toBeNull();
  });

  test("only git is supported for now", () => {
    expect(assertSupportedSourceControlProvider("git")).toBe("git");
    expect(() => assertSupportedSourceControlProvider("sapling")).toThrow(/supports git only/);
    expect(() => assertSupportedSourceControlProvider("mercurial")).toThrow(/supports git only/);
  });

  test("provider resolution can be selected through environment", () => {
    expect(resolveSourceControlProvider(undefined, { PUSHPALS_SOURCE_CONTROL_PROVIDER: "git" })).toBe(
      "git",
    );
    expect(
      resolveSourceControlProvider(undefined, { SOURCE_CONTROL_PROVIDER: "mercury" }),
    ).toBe("mercurial");
    expect(resolveSourceControlProvider("sapling", {})).toBe("sapling");
    expect(() => resolveSourceControlProvider("svn", {})).toThrow(/Unknown source control provider/);
  });

  test("creates the git source control implementation", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-source-control-api-"));
    try {
      const api = createSourceControlApi(makeConfig(repoPath), { provider: "git" });
      expect(api.provider).toBe("git");
      expect(api.repoPath).toBe(repoPath);
      expect(api).toBeInstanceOf(GitSourceControlApi);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("rejects recognized but unsupported providers", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-source-control-api-"));
    try {
      expect(() => createSourceControlApi(makeConfig(repoPath), { provider: "mercury" })).toThrow(
        /supports git only/,
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test("git source control identity reads git config", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "pushpals-source-control-api-"));
    const previousEnv = {
      WORKERPALS_GIT_AUTHOR_NAME: process.env.WORKERPALS_GIT_AUTHOR_NAME,
      WORKERPALS_GIT_AUTHOR_EMAIL: process.env.WORKERPALS_GIT_AUTHOR_EMAIL,
      PUSHPALS_GIT_AUTHOR_NAME: process.env.PUSHPALS_GIT_AUTHOR_NAME,
      PUSHPALS_GIT_AUTHOR_EMAIL: process.env.PUSHPALS_GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    };
    try {
      delete process.env.WORKERPALS_GIT_AUTHOR_NAME;
      delete process.env.WORKERPALS_GIT_AUTHOR_EMAIL;
      delete process.env.PUSHPALS_GIT_AUTHOR_NAME;
      delete process.env.PUSHPALS_GIT_AUTHOR_EMAIL;
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;

      await git(repoPath, ["init"]);
      await git(repoPath, ["config", "user.name", "PiyushDatta"]);
      await git(repoPath, ["config", "user.email", "piyushdattaca@gmail.com"]);

      await expect(
        createSourceControlApi(makeConfig(repoPath), { provider: "git" }).getCommitIdentity(),
      ).resolves.toEqual({
          name: "PiyushDatta",
          email: "piyushdattaca@gmail.com",
          source: "source-control-config",
        });
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
