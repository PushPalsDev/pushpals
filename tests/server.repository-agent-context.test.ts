import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveRepositoryIdentity, resolveRepositorySnapshot } from "shared";
import { resolveRepositoryAgentContext } from "../apps/server/src/repository_agent_context";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function fixture(): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "pushpals-repository-context-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "PushPals Test");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "fixture");
  const worktreesDir = join(root, ".worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const worktree = join(worktreesDir, "agent");
  git(root, "worktree", "add", "--detach", worktree, "HEAD");
  return { root, worktree };
}

describe("RepositoryAgent server repository context", () => {
  test("maps service-local paths onto the registered host repository", async () => {
    const { root } = fixture();
    try {
      const identity = await resolveRepositoryIdentity(root);
      const resolved = await resolveRepositoryAgentContext({
        canonicalRepoRoot: root,
        requested: {
          identity: identity.repositoryId,
          root: "/workspace/container-only-path",
        },
      });
      expect(resolved.requestedRootMapped).toBe(true);
      expect(resolved.repository.identity).toBe(identity.repositoryId);
      expect(comparablePath(resolved.repository.root)).toBe(comparablePath(root));
      expect(resolved.repository.dirty).toBe(true); // .worktrees is deliberately untracked.
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("accepts the exact registered linked worktree and rejects stale baselines", async () => {
    const { root, worktree } = fixture();
    try {
      const identity = await resolveRepositoryIdentity(root);
      const resolved = await resolveRepositoryAgentContext({
        canonicalRepoRoot: root,
        requested: { identity: identity.repositoryId, root: worktree },
      });
      expect(resolved.requestedRootMapped).toBe(false);
      expect(comparablePath(resolved.repository.root)).toBe(comparablePath(worktree));
      expect(resolved.repository.dirty).toBe(false);
      await expect(
        resolveRepositoryAgentContext({
          canonicalRepoRoot: root,
          requested: {
            ...resolved.repository,
            revision: "0000000000000000000000000000000000000000",
          },
        }),
      ).rejects.toThrow("baseline is stale");
    } finally {
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {}
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("accepts an exact Git-registered worktree outside the repository directory", async () => {
    const { root, worktree } = fixture();
    const externalParent = mkdtempSync(join(tmpdir(), "pushpals-external-worktree-"));
    const externalWorktree = join(externalParent, "job-external");
    try {
      git(root, "worktree", "add", "--detach", externalWorktree, "HEAD");
      writeFileSync(join(externalWorktree, "README.md"), "# external registered worktree\n");
      git(externalWorktree, "add", "README.md");
      git(externalWorktree, "commit", "-m", "external worktree revision");
      const requested = await resolveRepositorySnapshot(externalWorktree);

      const resolved = await resolveRepositoryAgentContext({
        canonicalRepoRoot: root,
        requested,
      });

      expect(resolved.requestedRootMapped).toBe(false);
      expect(comparablePath(resolved.repository.root)).toBe(comparablePath(externalWorktree));
      expect(resolved.repository.identity).toBe(requested.identity);
      expect(resolved.repository.revision).toBe(requested.revision);
      expect(resolved.repository.tree).toBe(requested.tree);
      expect(resolved.repository.dirty).toBe(false);
    } finally {
      try {
        git(root, "worktree", "remove", "--force", externalWorktree);
      } catch {}
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {}
      try {
        rmSync(externalParent, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("rejects an existing external checkout that Git has not registered as a worktree", async () => {
    const { root, worktree } = fixture();
    const externalParent = mkdtempSync(join(tmpdir(), "pushpals-unregistered-worktree-"));
    const externalCheckout = join(externalParent, "unregistered");
    try {
      execFileSync("git", ["clone", "--quiet", root, externalCheckout], {
        cwd: externalParent,
        encoding: "utf8",
      });
      const canonical = await resolveRepositorySnapshot(root);

      await expect(
        resolveRepositoryAgentContext({
          canonicalRepoRoot: root,
          requested: {
            ...canonical,
            root: externalCheckout,
          },
        }),
      ).rejects.toThrow("not registered with this repository");
    } finally {
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {}
      try {
        rmSync(externalParent, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("rejects a registered path whose Git common directory was replaced", async () => {
    const { root, worktree } = fixture();
    const externalParent = mkdtempSync(join(tmpdir(), "pushpals-worktree-identity-fence-"));
    const registeredWorktree = join(externalParent, "registered");
    const impostor = join(externalParent, "impostor");
    const sharedOrigin = "https://example.invalid/pushpals/repository-agent-fixture.git";
    let registeredGitFile: string | null = null;
    try {
      git(root, "remote", "add", "origin", sharedOrigin);
      git(root, "worktree", "add", "--detach", registeredWorktree, "HEAD");
      execFileSync("git", ["clone", "--quiet", root, impostor], {
        cwd: externalParent,
        encoding: "utf8",
      });
      git(impostor, "remote", "set-url", "origin", sharedOrigin);

      const canonicalIdentity = await resolveRepositoryIdentity(root);
      const impostorIdentity = await resolveRepositoryIdentity(impostor);
      expect(impostorIdentity.repositoryId).toBe(canonicalIdentity.repositoryId);
      expect(impostorIdentity.gitCommonDir).not.toBe(canonicalIdentity.gitCommonDir);

      registeredGitFile = readFileSync(join(registeredWorktree, ".git"), "utf8");
      writeFileSync(
        join(registeredWorktree, ".git"),
        `gitdir: ${join(impostor, ".git").replace(/\\/g, "/")}\n`,
        "utf8",
      );

      await expect(
        resolveRepositoryAgentContext({
          canonicalRepoRoot: root,
          requested: {
            identity: canonicalIdentity.repositoryId,
            root: registeredWorktree,
          },
        }),
      ).rejects.toThrow("does not belong to the registered repository");
    } finally {
      if (registeredGitFile != null) {
        try {
          writeFileSync(join(registeredWorktree, ".git"), registeredGitFile, "utf8");
        } catch {}
      }
      try {
        git(root, "worktree", "remove", "--force", registeredWorktree);
      } catch {}
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {}
      try {
        git(root, "worktree", "prune");
      } catch {}
      try {
        rmSync(externalParent, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("maps a service-local path to the exact divergent linked worktree snapshot", async () => {
    const { root, worktree } = fixture();
    try {
      writeFileSync(join(worktree, "README.md"), "# divergent linked worktree\n");
      git(worktree, "add", "README.md");
      git(worktree, "commit", "-m", "divergent worktree");
      const requested = await resolveRepositorySnapshot(worktree);

      const resolved = await resolveRepositoryAgentContext({
        canonicalRepoRoot: root,
        requested: {
          ...requested,
          root: "/workspace/container-job-worktree",
        },
      });

      expect(resolved.requestedRootMapped).toBe(true);
      expect(comparablePath(resolved.repository.root)).toBe(comparablePath(worktree));
      expect(resolved.repository.revision).toBe(requested.revision);
      expect(resolved.repository.tree).toBe(requested.tree);
      expect(resolved.repository.dirty).toBe(false);
    } finally {
      try {
        git(root, "worktree", "remove", "--force", worktree);
      } catch {}
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    }
  });

  test("rejects another repository identity", async () => {
    const first = fixture();
    const second = fixture();
    try {
      const other = await resolveRepositoryIdentity(second.root);
      await expect(
        resolveRepositoryAgentContext({
          canonicalRepoRoot: first.root,
          requested: { identity: other.repositoryId, root: second.root },
        }),
      ).rejects.toThrow("identity does not match");
    } finally {
      for (const item of [first, second]) {
        try {
          git(item.root, "worktree", "remove", "--force", item.worktree);
        } catch {}
        try {
          rmSync(item.root, { recursive: true, force: true });
        } catch {}
      }
    }
  });
});
