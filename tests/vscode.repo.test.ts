import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findWorkspaceRepoRoot,
  looksLikePushPalsSourceCheckout,
  resolveWorkspaceGitStateFilePath,
} from "../apps/vscode-client/src/repo";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

describe("vscode repo helpers", () => {
  test("findWorkspaceRepoRoot walks up from nested workspace folders", () => {
    const root = makeTempRoot("pushpals-vscode-repo-");
    const nested = join(root, "packages", "feature");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(findWorkspaceRepoRoot(nested)).toBe(resolve(root));
  });

  test("resolveWorkspaceGitStateFilePath uses worktree metadata for nested paths", () => {
    const root = makeTempRoot("pushpals-vscode-worktree-");
    const nested = join(root, "apps", "client");
    const metadataDir = join(root, "gitdir-store", "worktrees", "demo");
    mkdirSync(metadataDir, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${metadataDir}\n`, "utf8");

    expect(resolveWorkspaceGitStateFilePath(nested, "pushpals-client-state.json")).toBe(
      join(metadataDir, "pushpals-client-state.json"),
    );
  });

  test("looksLikePushPalsSourceCheckout detects contributor workspaces only", () => {
    const sourceRoot = makeTempRoot("pushpals-vscode-source-");
    mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
    mkdirSync(join(sourceRoot, "apps", "server", "src"), { recursive: true });
    mkdirSync(join(sourceRoot, "apps", "vscode-client"), { recursive: true });
    writeFileSync(join(sourceRoot, "scripts", "client-preflight.ts"), "", "utf8");
    writeFileSync(join(sourceRoot, "apps", "server", "src", "server_main.ts"), "", "utf8");
    writeFileSync(join(sourceRoot, "apps", "vscode-client", "package.json"), "{}\n", "utf8");

    const plainRepo = makeTempRoot("pushpals-vscode-plain-");
    mkdirSync(join(plainRepo, ".git"), { recursive: true });

    expect(looksLikePushPalsSourceCheckout(sourceRoot)).toBe(true);
    expect(looksLikePushPalsSourceCheckout(plainRepo)).toBe(false);
  });
});
