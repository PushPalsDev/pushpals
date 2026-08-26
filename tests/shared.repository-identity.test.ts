import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeRepositoryOriginRemote, resolveRepositoryIdentity } from "shared";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-repository-identity-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, [
    "-c",
    "user.name=PushPals Tests",
    "-c",
    "user.email=pushpals-tests@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("repository identity", () => {
  test("normalizes equivalent HTTPS and SSH origins without credentials", () => {
    expect(
      normalizeRepositoryOriginRemote(
        "https://oauth2:super-secret@example.com/Acme/Project.git?access_token=also-secret#fragment",
      ),
    ).toBe("example.com/Acme/Project");
    expect(normalizeRepositoryOriginRemote("git@example.com:Acme/Project.git")).toBe(
      "example.com/Acme/Project",
    );
    expect(normalizeRepositoryOriginRemote("ssh://git@example.com/Acme/Project.git")).toBe(
      "example.com/Acme/Project",
    );
  });

  test("origin plus root commit is stable across linked worktrees and transport spellings", async () => {
    const root = fixture();
    const main = join(root, "main");
    const linked = join(root, "linked");
    initializeRepository(main);
    git(main, [
      "remote",
      "add",
      "origin",
      "https://oauth2:secret@example.com/Acme/Project.git?token=never-store",
    ]);
    git(main, ["worktree", "add", "-b", "linked-fixture", linked, "HEAD"]);

    const mainIdentity = await resolveRepositoryIdentity(main);
    const linkedIdentity = await resolveRepositoryIdentity(linked);
    expect(linkedIdentity.repositoryId).toBe(mainIdentity.repositoryId);
    expect(linkedIdentity.gitCommonDir).toBe(mainIdentity.gitCommonDir);
    expect(mainIdentity.source).toBe("origin");
    expect(mainIdentity.normalizedOrigin).toBe("example.com/Acme/Project");
    expect(JSON.stringify(mainIdentity)).not.toContain("secret");
    expect(JSON.stringify(mainIdentity)).not.toContain("token=never-store");
    expect(mainIdentity.rootCommit).toMatch(/^[0-9a-f]{40,64}$/);

    git(main, ["remote", "set-url", "origin", "git@example.com:Acme/Project.git"]);
    const sshIdentity = await resolveRepositoryIdentity(main);
    expect(sshIdentity.repositoryId).toBe(mainIdentity.repositoryId);
  });

  test("repositories without an origin use their canonical common Git directory", async () => {
    const root = fixture();
    const main = join(root, "main");
    const linked = join(root, "linked");
    initializeRepository(main);
    git(main, ["worktree", "add", "-b", "local-linked-fixture", linked, "HEAD"]);

    const mainIdentity = await resolveRepositoryIdentity(main);
    const linkedIdentity = await resolveRepositoryIdentity(linked);
    expect(mainIdentity.source).toBe("git-common-dir");
    expect(mainIdentity.normalizedOrigin).toBeNull();
    expect(linkedIdentity.repositoryId).toBe(mainIdentity.repositoryId);
    expect(linkedIdentity.gitCommonDir).toBe(mainIdentity.gitCommonDir);
  });

  test("fails closed when the directory is not a Git repository", async () => {
    const root = fixture();
    await expect(resolveRepositoryIdentity(root)).rejects.toThrow("Git common directory");
  });
});
