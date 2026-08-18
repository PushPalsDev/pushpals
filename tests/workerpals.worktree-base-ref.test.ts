import { describe, expect, test } from "bun:test";
import {
  resolveExistingWorktreeBaseRef,
  resolveFreshWorktreeBaseRef,
  resolveReviewWorktreeBase,
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
  test("seeds candidate-specific validation repair from the exact host commit", async () => {
    const candidateSha = "a".repeat(40);
    const candidateRef = `refs/pushpals/validation/${"1".repeat(32)}/1/candidate`;
    let fallbackCalls = 0;
    const params: Record<string, unknown> = {
      autonomy: {
        validationIncident: {
          incidentId: "valid_inc_account",
          candidateSha,
          candidateRef,
          validationScope: "candidate_specific",
        },
      },
    };
    const resolved = await resolveReviewWorktreeBase({
      jobId: "job-validation-repair",
      params,
      git: async (args) => ({
        ok: args[0] === "rev-parse" && args.at(-1) === `${candidateRef}^{commit}`,
        stdout: candidateSha,
        stderr: "",
      }),
      fallback: async () => {
        fallbackCalls += 1;
        return "origin/main_agents";
      },
    });

    expect(resolved).toBe(candidateSha);
    expect(fallbackCalls).toBe(0);
    expect(String(params.plannerWorkerInstruction)).toContain("Host SCM prepared");
    expect(String(params.plannerWorkerInstruction)).toContain("do not switch branches");
  });

  test("refuses a generic base when an exact validation candidate is unavailable", async () => {
    const candidateSha = "b".repeat(40);
    const candidateRef = `refs/pushpals/validation/${"2".repeat(32)}/1/candidate`;
    expect(
      resolveReviewWorktreeBase({
        jobId: "job-missing-validation-candidate",
        params: {
          autonomy: {
            validationIncident: {
              incidentId: "valid_inc_missing",
              candidateSha,
              candidateRef,
              validationScope: "candidate_specific",
            },
          },
        },
        git: async () => ({ ok: false, stdout: "", stderr: "missing" }),
        fallback: async () => "origin/main_agents",
      }),
    ).rejects.toThrow("refusing a generic base");
  });

  test("refuses candidate-specific repair metadata without an immutable candidate ref", async () => {
    expect(
      resolveReviewWorktreeBase({
        jobId: "job-unretained-validation-candidate",
        params: {
          autonomy: {
            validationIncident: {
              incidentId: "valid_inc_unretained",
              candidateSha: "c".repeat(40),
              validationScope: "candidate_specific",
            },
          },
        },
        git: async () => ({ ok: true, stdout: "c".repeat(40), stderr: "" }),
        fallback: async () => "origin/main_agents",
      }),
    ).rejects.toThrow("missing its exact retained candidate ref");
  });

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
      ancestors: new Set(["origin/main_agents..origin/main"]),
    });

    const resolved = await resolveFreshWorktreeBaseRef({
      requestedRef: "origin/main_agents",
      integrationBranch: "main_agents",
      sourceBaseBranch: "main",
      git,
      log: (_level, message) => messages.push(message),
    });

    expect(resolved).toBe("origin/main");
    expect(messages.join("\n")).toContain("is behind origin/main");
  });

  test("preserves integration context while source control reconciles true divergence", async () => {
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

    expect(resolved).toBe("origin/main_agents");
    expect(messages.join("\n")).toContain("has diverged from origin/main");
  });

  test("uses cached source base when refresh fails but local ref exists", async () => {
    const messages: string[] = [];
    const { git } = createGitMock({
      refs: new Set(["origin/main_agents", "origin/main"]),
      fetchFailures: new Set(["main"]),
      ancestors: new Set(["origin/main_agents..origin/main"]),
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
