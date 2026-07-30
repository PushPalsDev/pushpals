import { describe, expect, test } from "bun:test";
import { posix, win32 } from "path";
import {
  directWorktreePoolRoot,
  isDirectWorkerWorktreePath,
  resolveLegacyDirectWorktreeRoot,
  resolveDirectWorktreePath,
  resolveDirectWorktreeRoot,
} from "../apps/workerpals/src/common/direct_worktree";

describe("direct WorkerPal worktree paths", () => {
  test("keeps non-Windows direct worktrees under the repository", () => {
    const repo = "/srv/projects/example";
    const path = resolveDirectWorktreePath(repo, "ABC-123", "nonce-1", "linux", "/tmp");

    expect(path).toBe(posix.resolve(repo, ".worktrees", "job-abc123-nonce-1"));
    expect(isDirectWorkerWorktreePath(repo, path, "linux", "/tmp")).toBe(true);
  });

  test("uses a bounded user-profile path for Windows direct worktrees", () => {
    const repo =
      "C:\\Users\\example\\Documents\\an-intentionally-long-parent\\another-parent\\SectorCommand";
    const homeRoot = "C:\\Users\\example";
    const tempRoot = "C:\\Users\\example\\AppData\\Local\\Temp";
    const path = resolveDirectWorktreePath(
      repo,
      "7d1d441f-7986-46b1-891f-e66983cac5b7",
      "77ghsi-c97n",
      "win32",
      homeRoot,
    );

    expect(path.toLowerCase()).toContain("\\users\\example\\.ppw\\");
    expect(path.toLowerCase()).not.toContain("\\sectorcommand\\");
    expect(path.length).toBeLessThan(70);
    expect(isDirectWorkerWorktreePath(repo, path, "win32", homeRoot, tempRoot)).toBe(true);
    expect(directWorktreePoolRoot(path, "win32")).toBe(
      resolveDirectWorktreeRoot(repo, "win32", homeRoot).replace(/\\/g, "/").toLowerCase(),
    );
  });

  test("does not classify another repository's Windows worktree as disposable", () => {
    const homeRoot = "C:\\Users\\example";
    const tempRoot = "C:\\Users\\example\\AppData\\Local\\Temp";
    const firstRepo = "C:\\projects\\first";
    const secondRepo = "C:\\projects\\second";
    const firstPath = resolveDirectWorktreePath(firstRepo, "job-first", "nonce", "win32", homeRoot);

    expect(win32.dirname(firstPath)).not.toBe(
      resolveDirectWorktreeRoot(secondRepo, "win32", homeRoot),
    );
    expect(isDirectWorkerWorktreePath(secondRepo, firstPath, "win32", homeRoot, tempRoot)).toBe(
      false,
    );
  });

  test("uses the same Windows pool for equivalent path casing and separators", () => {
    const homeRoot = "C:\\Users\\Example";
    const firstRoot = resolveDirectWorktreeRoot(
      "C:\\Users\\Example\\SectorCommand",
      "win32",
      homeRoot,
    );
    const secondRoot = resolveDirectWorktreeRoot(
      "c:/users/example/sectorcommand",
      "win32",
      homeRoot,
    );

    expect(firstRoot.toLowerCase()).toBe(secondRoot.toLowerCase());
  });

  test("recognizes v1.2.14 temp-pool worktrees for upgrade cleanup", () => {
    const repo = "C:\\projects\\example";
    const homeRoot = "C:\\Users\\example";
    const tempRoot = "C:\\Users\\example\\AppData\\Local\\Temp";
    const legacyPath = win32.resolve(
      resolveLegacyDirectWorktreeRoot(repo, "win32", tempRoot),
      "job-abc123-oldrun",
    );

    expect(isDirectWorkerWorktreePath(repo, legacyPath, "win32", homeRoot, tempRoot)).toBe(true);
    expect(directWorktreePoolRoot(legacyPath, "win32")).toBe(
      resolveLegacyDirectWorktreeRoot(repo, "win32", tempRoot).replace(/\\/g, "/").toLowerCase(),
    );
  });

  test("rejects unrelated files beneath the short worktree pool", () => {
    const repo = "C:\\projects\\example";
    const homeRoot = "C:\\Users\\example";
    const tempRoot = "C:\\Temp";
    const root = resolveDirectWorktreeRoot(repo, "win32", homeRoot);

    expect(
      isDirectWorkerWorktreePath(repo, win32.resolve(root, "notes"), "win32", homeRoot, tempRoot),
    ).toBe(false);
    expect(
      isDirectWorkerWorktreePath(
        repo,
        win32.resolve(root, "nested", "job-abc"),
        "win32",
        homeRoot,
        tempRoot,
      ),
    ).toBe(false);
  });
});
