import { describe, expect, test } from "bun:test";
import {
  ensureIntegrationPullRequest,
  listOpenPullRequests,
  listRecentlyClosedPullRequests,
  type GitHubPR,
  type PullRequestScanCursor,
} from "../apps/source_control_manager/src/github_pr";

function closedPr(overrides: Partial<GitHubPR> = {}): GitHubPR {
  const { head, base, ...rest } = overrides;
  return {
    number: 1,
    html_url: "https://github.com/org/repo/pull/1",
    title: "Repository improvement",
    body: "<!-- pushpals-jobId: job-1 -->\n<!-- pushpals-sessionId: dev -->",
    state: "closed",
    merged_at: null,
    closed_at: "2026-08-25T17:00:00.000Z",
    updated_at: "2026-08-25T17:00:00.000Z",
    head: {
      ref: "agent/repository-improvement",
      sha: "abc123",
      label: "org:agent/repository-improvement",
      repo: {
        full_name: "org/repo",
        name: "repo",
        owner: { login: "org" },
      },
      ...(head ?? {}),
    },
    base: {
      ref: "main",
      sha: "base123",
      ...(base ?? {}),
    },
    ...rest,
  };
}

describe("source control manager GitHub PR provider", () => {
  test("reuses only a same-repository integration PR when a fork result appears first", async () => {
    const fork = closedPr({
      number: 21,
      state: "open",
      head: {
        ref: "automation/integration",
        sha: "fork-sha",
        label: "org:automation/integration",
        repo: {
          full_name: "attacker/repo",
          name: "repo",
          owner: { login: "attacker" },
        },
      },
    });
    const owned = closedPr({
      number: 22,
      state: "open",
      head: {
        ref: "automation/integration",
        sha: "owned-sha",
        label: "org:automation/integration",
      },
    });
    let calls = 0;

    const result = await ensureIntegrationPullRequest({
      token: "provider-token",
      remoteUrl: "https://github.com/org/repo.git",
      headBranch: "automation/integration",
      baseBranch: "main",
      title: "Integration",
      body: "Managed integration PR",
      fetchImpl: async (_input, init) => {
        calls += 1;
        expect(init?.method).toBe("GET");
        return Response.json([fork, owned]);
      },
    });

    expect(result).toEqual({ created: false, number: 22, htmlUrl: owned.html_url });
    expect(calls).toBe(1);
  });

  test("filters a fork result after a create race before reusing the owned PR", async () => {
    const fork = closedPr({
      number: 23,
      state: "open",
      head: {
        ref: "automation/integration",
        sha: "fork-race-sha",
        label: "org:automation/integration",
        repo: {
          full_name: "attacker/repo",
          name: "repo",
          owner: { login: "attacker" },
        },
      },
    });
    const owned = closedPr({
      number: 24,
      state: "open",
      head: {
        ref: "automation/integration",
        sha: "owned-race-sha",
        label: "org:automation/integration",
      },
    });
    let call = 0;

    const result = await ensureIntegrationPullRequest({
      token: "provider-token",
      remoteUrl: "git@github.com:org/repo.git",
      headBranch: "automation/integration",
      baseBranch: "main",
      title: "Integration",
      body: "Managed integration PR",
      fetchImpl: async (_input, init) => {
        call += 1;
        if (call === 1) return Response.json([]);
        if (call === 2) {
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ message: "already exists" }), { status: 422 });
        }
        return Response.json([fork, owned]);
      },
    });

    expect(result).toEqual({ created: false, number: 24, htmlUrl: owned.html_url });
    expect(call).toBe(3);
  });

  test("lists only bounded, recent, agent-prefixed closed PRs", async () => {
    let requestedUrl = "";
    let authorization = "";
    const recentMerged = closedPr({
      number: 11,
      merged_at: "2026-08-25T16:00:00.000Z",
    });
    const recentClosed = closedPr({ number: 12 });
    const staleAgentPr = closedPr({
      number: 13,
      closed_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const unrelatedBranchPr = closedPr({
      number: 14,
      head: {
        ref: "feature/manual-change",
        sha: "manual123",
        label: "org:feature/manual-change",
      },
    });
    const forkWithSpoofedLabel = closedPr({
      number: 15,
      head: {
        ref: "agent/spoofed-fork",
        sha: "fork123",
        label: "org:agent/spoofed-fork",
        repo: {
          full_name: "attacker/repo",
          name: "repo",
          owner: { login: "attacker" },
        },
      },
    });

    const prs = await listRecentlyClosedPullRequests({
      token: "provider-token",
      remoteUrl: "https://github.com/org/repo.git",
      headPrefix: "agent/",
      base: "main",
      updatedSince: "2026-08-20T00:00:00.000Z",
      limit: 500,
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        authorization = headers?.Authorization ?? "";
        return new Response(
          JSON.stringify([
            recentMerged,
            recentClosed,
            staleAgentPr,
            unrelatedBranchPr,
            forkWithSpoofedLabel,
          ]),
          { status: 200 },
        );
      },
    });

    const parsedUrl = new URL(requestedUrl);
    expect(parsedUrl.hostname).toBe("api.github.com");
    expect(parsedUrl.pathname).toBe("/repos/org/repo/pulls");
    expect(parsedUrl.searchParams.get("state")).toBe("closed");
    expect(parsedUrl.searchParams.get("base")).toBe("main");
    expect(parsedUrl.searchParams.get("sort")).toBe("updated");
    expect(parsedUrl.searchParams.get("direction")).toBe("desc");
    expect(parsedUrl.searchParams.get("per_page")).toBe("100");
    expect(authorization).toBe("Bearer provider-token");
    expect(prs.map((pr) => pr.number)).toEqual([11, 12]);
    expect(prs[0]?.merged_at).toBe("2026-08-25T16:00:00.000Z");
  });

  test("paginates open PRs past unrelated entries and rejects spoofed fork heads", async () => {
    const unrelatedFirstPage = Array.from({ length: 99 }, (_, index) =>
      closedPr({
        number: 2_000 + index,
        state: "open",
        head: {
          ref: `feature/manual-${index}`,
          sha: `manual-${index}`,
          label: `org:feature/manual-${index}`,
        },
      }),
    );
    unrelatedFirstPage.push(
      closedPr({
        number: 2_099,
        state: "open",
        head: {
          ref: "agent/spoofed-fork",
          sha: "spoofed-fork-sha",
          label: "org:agent/spoofed-fork",
          repo: {
            full_name: "attacker/repo",
            name: "repo",
            owner: { login: "attacker" },
          },
        },
      }),
    );
    const managedPr = closedPr({
      number: 2_100,
      state: "open",
      head: {
        ref: "agent/managed-change",
        sha: "managed-sha",
        label: "org:agent/managed-change",
        repo: {
          full_name: null,
          name: "repo",
          owner: { login: "ORG" },
        },
      },
    });
    const requestedPages: string[] = [];

    const prs = await listOpenPullRequests({
      token: "provider-token",
      remoteUrl: "git@github.com:org/repo.git",
      headPrefix: "agent/",
      base: "main",
      fetchImpl: async (input) => {
        const page = new URL(String(input)).searchParams.get("page") ?? "";
        requestedPages.push(page);
        return Response.json(page === "1" ? unrelatedFirstPage : [managedPr]);
      },
    });

    expect(requestedPages).toEqual(["1", "2"]);
    expect(prs.map((pr) => pr.number)).toEqual([2_100]);
  });

  test("rejects an invalid reconciliation cutoff before calling GitHub", async () => {
    let fetchCalls = 0;
    await expect(
      listRecentlyClosedPullRequests({
        token: "provider-token",
        remoteUrl: "git@github.com:org/repo.git",
        headPrefix: "agent/",
        base: "main",
        updatedSince: "not-a-timestamp",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("[]", { status: 200 });
        },
      }),
    ).rejects.toThrow("updatedSince must be a valid timestamp");
    expect(fetchCalls).toBe(0);
  });

  test("paginates past unrelated closed PRs to find configured-prefix outcomes", async () => {
    const unrelatedFirstPage = Array.from({ length: 100 }, (_, index) =>
      closedPr({
        number: 1_000 + index,
        head: {
          ref: `feature/manual-${index}`,
          sha: `manual-${index}`,
          label: `org:feature/manual-${index}`,
        },
      }),
    );
    const managedPr = closedPr({
      number: 1_200,
      head: {
        ref: "automation/recovered-outcome",
        sha: "managed-sha",
        label: "org:automation/recovered-outcome",
      },
    });
    const requestedPages: string[] = [];

    const prs = await listRecentlyClosedPullRequests({
      token: "provider-token",
      remoteUrl: "https://github.com/org/repo.git",
      headPrefix: "automation/",
      base: "main",
      updatedSince: "2026-08-20T00:00:00.000Z",
      limit: 50,
      fetchImpl: async (input) => {
        const page = new URL(String(input)).searchParams.get("page") ?? "";
        requestedPages.push(page);
        return Response.json(page === "1" ? unrelatedFirstPage : [managedPr]);
      },
    });

    expect(requestedPages).toEqual(["1", "2"]);
    expect(prs.map((pr) => pr.number)).toEqual([1_200]);
  });

  test("advances bounded open scans beyond page four across calls", async () => {
    let cursor: PullRequestScanCursor | null = null;
    const requestedPages: number[] = [];
    const unrelatedPage = Array.from({ length: 100 }, (_, index) =>
      closedPr({
        number: 3_000 + index,
        state: "open",
        head: {
          ref: `feature/unrelated-${index}`,
          sha: `unrelated-${index}`,
          label: `org:feature/unrelated-${index}`,
        },
      }),
    );
    const managedPr = closedPr({
      number: 3_500,
      state: "open",
      head: {
        ref: "agent/eventually-visible",
        sha: "eventually-visible-sha",
        label: "org:agent/eventually-visible",
      },
    });
    const scan = () =>
      listOpenPullRequests({
        token: "provider-token",
        remoteUrl: "https://github.com/org/repo.git",
        headPrefix: "agent/",
        base: "main",
        cursor,
        onScanComplete: (nextCursor) => {
          cursor = nextCursor;
        },
        fetchImpl: async (input) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          requestedPages.push(page);
          return Response.json(page === 5 ? [managedPr] : unrelatedPage);
        },
      });

    expect(await scan()).toEqual([]);
    expect(cursor).toEqual({ page: 5, offset: 0 });
    expect((await scan()).map((pr) => pr.number)).toEqual([3_500]);
    expect(cursor).toBeNull();
    expect(requestedPages).toEqual([1, 2, 3, 4, 5]);
  });

  test("continues within a busy closed page instead of repeating its newest matches", async () => {
    let cursor: PullRequestScanCursor | null = null;
    const recentManagedPage = Array.from({ length: 100 }, (_, index) =>
      closedPr({
        number: 4_000 + index,
        head: {
          ref: `agent/outcome-${index}`,
          sha: `outcome-${index}`,
          label: `org:agent/outcome-${index}`,
        },
      }),
    );
    const scan = () =>
      listRecentlyClosedPullRequests({
        token: "provider-token",
        remoteUrl: "https://github.com/org/repo.git",
        headPrefix: "agent/",
        base: "main",
        updatedSince: "2026-08-20T00:00:00.000Z",
        limit: 3,
        cursor,
        onScanComplete: (nextCursor) => {
          cursor = nextCursor;
        },
        fetchImpl: async () => Response.json(recentManagedPage),
      });

    expect((await scan()).map((pr) => pr.number)).toEqual([4_000, 4_001, 4_002]);
    expect(cursor).toEqual({ page: 1, offset: 3 });
    expect((await scan()).map((pr) => pr.number)).toEqual([4_003, 4_004, 4_005]);
    expect(cursor).toEqual({ page: 1, offset: 6 });
  });

  test("resets a rotated closed scan when the recency cutoff is reached", async () => {
    let cursor: PullRequestScanCursor | null = null;
    const requestedPages: number[] = [];
    const unrelatedRecentPage = Array.from({ length: 100 }, (_, index) =>
      closedPr({
        number: 5_000 + index,
        head: {
          ref: `feature/unrelated-${index}`,
          sha: `unrelated-${index}`,
          label: `org:feature/unrelated-${index}`,
        },
      }),
    );
    const managedRecent = closedPr({ number: 5_500 });
    const staleManaged = closedPr({
      number: 5_501,
      closed_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    const pageAtCutoff = [
      managedRecent,
      staleManaged,
      ...Array.from({ length: 98 }, (_, index) => closedPr({ number: 5_600 + index })),
    ];
    const scan = () =>
      listRecentlyClosedPullRequests({
        token: "provider-token",
        remoteUrl: "https://github.com/org/repo.git",
        headPrefix: "agent/",
        base: "main",
        updatedSince: "2026-08-20T00:00:00.000Z",
        limit: 50,
        cursor,
        onScanComplete: (nextCursor) => {
          cursor = nextCursor;
        },
        fetchImpl: async (input) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          requestedPages.push(page);
          return Response.json(page === 5 ? pageAtCutoff : unrelatedRecentPage);
        },
      });

    expect(await scan()).toEqual([]);
    expect(cursor).toEqual({ page: 5, offset: 0 });
    expect((await scan()).map((pr) => pr.number)).toEqual([5_500]);
    expect(cursor).toBeNull();
    expect(requestedPages).toEqual([1, 2, 3, 4, 5]);
  });
});
