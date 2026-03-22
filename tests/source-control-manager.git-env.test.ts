import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GitOps,
  resolveGitExecutableCandidatesFromEnv,
  resolveGitExecutableFromEnv,
  resolveWindowsShellExecutableCandidates,
  resolveWindowsWhereExecutableCandidates,
} from "../apps/source_control_manager/src/git.ts";

const originalGitBin = process.env.PUSHPALS_GIT_BIN;
const originalGitBinAbsolute = process.env.PUSHPALS_GIT_BIN_ABSOLUTE;

afterEach(() => {
  if (originalGitBin === undefined) {
    delete process.env.PUSHPALS_GIT_BIN;
  } else {
    process.env.PUSHPALS_GIT_BIN = originalGitBin;
  }
  if (originalGitBinAbsolute === undefined) {
    delete process.env.PUSHPALS_GIT_BIN_ABSOLUTE;
  } else {
    process.env.PUSHPALS_GIT_BIN_ABSOLUTE = originalGitBinAbsolute;
  }
});

describe("source_control_manager git executable resolution", () => {
  test("defaults to git when no override is configured", () => {
    delete process.env.PUSHPALS_GIT_BIN;
    delete process.env.PUSHPALS_GIT_BIN_ABSOLUTE;
    expect(resolveGitExecutableFromEnv()).toBe("git");
  });

  test("uses PUSHPALS_GIT_BIN when configured", () => {
    process.env.PUSHPALS_GIT_BIN = "C:\\Program Files\\Git\\cmd\\git.exe";
    delete process.env.PUSHPALS_GIT_BIN_ABSOLUTE;
    expect(resolveGitExecutableFromEnv()).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  test("keeps PATH command first and absolute override as fallback", () => {
    process.env.PUSHPALS_GIT_BIN = "git.exe";
    process.env.PUSHPALS_GIT_BIN_ABSOLUTE = "D:\\PortableGit\\cmd\\git.exe";
    expect(resolveGitExecutableFromEnv()).toBe("git.exe");
    expect(resolveGitExecutableCandidatesFromEnv()).toEqual([
      "git.exe",
      "D:\\PortableGit\\cmd\\git.exe",
      "git",
    ]);
  });

  test("falls back to PATH git when the absolute override cannot be spawned", async () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-scm-git-fallback-"));
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });

    try {
      const init = Bun.spawnSync(["git", "init"], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(init.exitCode).toBe(0);

      process.env.PUSHPALS_GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
      process.env.PUSHPALS_GIT_BIN_ABSOLUTE =
        process.platform === "win32"
          ? join(root, "missing", "git.exe")
          : join(root, "missing", "git");

      const ops = new GitOps({
        repoPath: repoRoot,
        remote: "origin",
        mainBranch: "main_agents",
        integrationBaseBranch: "main",
        branchPrefix: "agent/",
        gitToken: null,
      } as any);

      expect(await ops.isRepoClean()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves Windows shell candidates from ComSpec and SystemRoot before bare cmd.exe", () => {
    const candidates = resolveWindowsShellExecutableCandidates(
      {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        SYSTEMROOT: "C:\\Windows",
      },
      "win32",
    );

    expect(candidates).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\Sysnative\\cmd.exe",
      "cmd.exe",
    ]);
  });

  test("resolves Windows where.exe candidates from SystemRoot before PATH lookup", () => {
    const candidates = resolveWindowsWhereExecutableCandidates(
      {
        SYSTEMROOT: "C:\\Windows",
      },
      "win32",
    );

    expect(candidates).toEqual([
      "C:\\Windows\\System32\\where.exe",
      "C:\\Windows\\Sysnative\\where.exe",
      "where.exe",
      "where",
    ]);
  });
});
