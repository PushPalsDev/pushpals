import { describe, expect, test } from "bun:test";
import {
  resolveExistingWorktreeBaseRef,
  resolveFreshWorktreeBaseRef,
  type GitBaseRefCommand,
} from "../apps/workerpals/src/worktree_base_ref";

function createGitMock(options: {
  refs: Set<string>;
  ancestors?: Set<string>;
  fetchFailures?: Set<string>;
}): { git: GitBaseRefCommand; commands: string[][] } {
  const commands: string[][] = [];
  const ancestors = options.ancestors ?? new Set<string>();
  const fetchFailures = options.fetchFailures ?? new Set<string>();

  return {
    commands,
    git: async (args: string[]) => {
      commands.push(args);
      if (args[0] === "fetch") {
        const branch = args[2] ?? "";
        return { ok: !fetchFailures.has(branch), stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        const ref = args[args.length - 1] ?? "";
        return { ok: options.refs.has(ref), stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { ok: ancestors.has(`${args[2]}..${args[3]}`), stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
    },
  };
}

describe("workerpals worktree base ref resolution", () => {
  test("keeps integration branch when it already contains source base", async () => {
    const { git } = createGitMock({
      refs: new Set(["origin/main_agents", "origin/main"]),
      ancestors: new Set(["origin/main..origin/main_agents"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
    });

    expect(resolved).toBe("origin/main_agents");
  });

  test("uses source base when default integration branch is stale", async () => {
    const messages: string[] = [];
    const { git } = createGitMock({
      refs: new Set(["origin/main_agents", "origin/main"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
      log: (_level, message) => messages.push(message),
    });

    expect(resolved).toBe("origin/main");
    expect(messages.join("\n")).toContain("does not contain origin/main");
  });

  test("uses cached source base when refresh fails but local ref exists", async () => {
    const messages: string[] = [];
    const { git } = createGitMock({
      refs: new Set(["origin/main_agents", "origin/main"]),
      fetchFailures: new Set(["main"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
      log: (_level, message) => messages.push(message),
    });

    expect(resolved).toBe("origin/main");
    expect(messages.join("\n")).toContain("Could not refresh origin/main");
  });

  test("keeps integration branch when source base cannot be fetched or verified", async () => {
    const { git } = createGitMock({
      refs: new Set(["origin/main_agents"]),
      fetchFailures: new Set(["main"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
    });

    expect(resolved).toBe("origin/main_agents");
  });

  test("does not override an explicit custom worker base", async () => {
    const { git } = createGitMock({
      refs: new Set(["origin/feature/refactor", "origin/main"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/feature/refactor",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
    });

    expect(resolved).toBe("origin/feature/refactor");
  });

  test("keeps existing fallback behavior when no refs can be verified", async () => {
    const { git } = createGitMock({
      refs: new Set<string>(),
    });

    const resolved = await resolveExistingWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      git,
    });

    expect(resolved).toBe("HEAD");
  });
});
