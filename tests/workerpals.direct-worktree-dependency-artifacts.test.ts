import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { linkDirectWorktreeDependencyArtifacts } from "../apps/workerpals/src/common/worktree_dependency_artifacts";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pushpals-direct-worktree-artifacts-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("direct worktree dependency artifacts", () => {
  test("links root node_modules into a direct isolated worktree", () => {
    const root = createTempRoot();
    const repo = join(root, "repo");
    const worktree = join(repo, ".worktrees", "job-browser-smoke");
    mkdirSync(join(repo, "node_modules", "react-native-svg"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"snapshot-fixture"}\n', "utf8");
    mkdirSync(worktree, { recursive: true });
    const logs: string[] = [];

    const result = linkDirectWorktreeDependencyArtifacts(repo, worktree, (stream, line) =>
      logs.push(`${stream}:${line}`),
    );

    const linkedPath = join(worktree, "node_modules");
    expect(result.linked).toEqual(["node_modules"]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(linkedPath)).toBe(true);
    expect(lstatSync(linkedPath).isSymbolicLink() || lstatSync(linkedPath).isDirectory()).toBe(
      true,
    );
    expect(lstatSync(linkedPath).isSymbolicLink()).toBe(false);
    expect(
      readFileSync(join(linkedPath, ".pushpals-dependency-snapshot"), "utf8").trim(),
    ).toHaveLength(64);
    expect(logs.join("\n")).toContain(
      "Materialized content-addressed worktree dependency snapshot(s): node_modules",
    );
  });

  test("skips dependency artifacts when the worktree already has its own", () => {
    const root = createTempRoot();
    const repo = join(root, "repo");
    const worktree = join(repo, ".worktrees", "job-existing-deps");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(join(worktree, "node_modules"), { recursive: true });

    const result = linkDirectWorktreeDependencyArtifacts(repo, worktree);

    expect(result.linked).toEqual([]);
    expect(result.skipped).toEqual(["node_modules"]);
    expect(result.warnings).toEqual([]);
  });
});
