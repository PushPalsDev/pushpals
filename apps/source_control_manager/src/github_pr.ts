export interface PullRequestUpsertResult {
  created: boolean;
  number: number;
  htmlUrl: string;
}

export interface GitHubPR {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string };
}

export interface EnsurePullRequestOptions {
  token: string;
  remoteUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

type GitHubRepoRef = { owner: string; repo: string };

function parseGitHubRepo(remoteUrl: string): GitHubRepoRef | null {
  const raw = (remoteUrl ?? "").trim();
  if (!raw) return null;

  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pushpals-source-control-manager",
    "Content-Type": "application/json",
  };
}

function githubError(responseStatus: number, bodyText: string): Error {
  return new Error(`GitHub API ${responseStatus}: ${bodyText || "no response body"}`);
}

export async function ensureIntegrationPullRequest(
  opts: EnsurePullRequestOptions,
): Promise<PullRequestUpsertResult> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(
      `Remote URL is not a supported GitHub URL: ${opts.remoteUrl}. Supported: https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git`,
    );
  }

  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const headSpec = `${repo.owner}:${opts.headBranch}`;

  const listUrl = `${apiBase}/pulls?state=open&head=${encodeURIComponent(headSpec)}&base=${encodeURIComponent(opts.baseBranch)}`;
  const listResponse = await fetch(listUrl, {
    method: "GET",
    headers: githubHeaders(opts.token),
  });
  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw githubError(listResponse.status, text);
  }

  const openPrs = (await listResponse.json()) as Array<{ number: number; html_url: string }>;
  if (Array.isArray(openPrs) && openPrs.length > 0) {
    const existing = openPrs[0];
    return { created: false, number: existing.number, htmlUrl: existing.html_url };
  }

  const createResponse = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({
      title: opts.title,
      head: opts.headBranch,
      base: opts.baseBranch,
      body: opts.body,
      draft: !!opts.draft,
    }),
  });

  if (createResponse.ok) {
    const created = (await createResponse.json()) as { number: number; html_url: string };
    return { created: true, number: created.number, htmlUrl: created.html_url };
  }

  // Handle races where another process created the PR between list and create.
  if (createResponse.status === 422) {
    const retryListResponse = await fetch(listUrl, {
      method: "GET",
      headers: githubHeaders(opts.token),
    });
    if (retryListResponse.ok) {
      const retryOpenPrs = (await retryListResponse.json()) as Array<{
        number: number;
        html_url: string;
      }>;
      if (Array.isArray(retryOpenPrs) && retryOpenPrs.length > 0) {
        const existing = retryOpenPrs[0];
        return { created: false, number: existing.number, htmlUrl: existing.html_url };
      }
    }
  }

  const createBody = await createResponse.text();
  throw githubError(createResponse.status, createBody);
}

export async function listOpenPullRequests(opts: {
  token: string;
  remoteUrl: string;
  headPrefix: string;
  base: string;
}): Promise<GitHubPR[]> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const url = `${apiBase}/pulls?state=open&base=${encodeURIComponent(opts.base)}&per_page=100`;

  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(opts.token),
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }

  const prs = (await response.json()) as GitHubPR[];
  if (!Array.isArray(prs)) return [];

  if (!opts.headPrefix) return prs;
  return prs.filter((pr) => pr.head.ref.startsWith(opts.headPrefix));
}

export async function getPullRequestDiff(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
}): Promise<string> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...githubHeaders(opts.token),
      Accept: "application/vnd.github.diff",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }

  return response.text();
}

export async function getCommitMessage(opts: {
  token: string;
  remoteUrl: string;
  sha: string;
}): Promise<string> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(opts.sha)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(opts.token),
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }

  const data = (await response.json()) as { commit?: { message?: unknown } | null };
  const message =
    data && data.commit && typeof data.commit.message === "string" ? data.commit.message : "";
  if (!message) {
    throw new Error(`GitHub API commit ${opts.sha} missing commit.message`);
  }
  return message;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (match && match[2] === "next") return match[1];
  }
  return null;
}

export async function getPullRequestCommitMessage(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
  sha: string;
}): Promise<string> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  let url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/commits?per_page=100`;
  let pages = 0;
  let latestMessage = "";

  while (url && pages < 50) {
    pages += 1;
    const response = await fetch(url, {
      method: "GET",
      headers: githubHeaders(opts.token),
    });

    if (!response.ok) {
      const text = await response.text();
      throw githubError(response.status, text);
    }

    const commits = (await response.json()) as Array<{
      sha?: unknown;
      commit?: { message?: unknown } | null;
    }>;

    if (!Array.isArray(commits) || commits.length === 0) break;

    for (const commit of commits) {
      const sha = typeof commit.sha === "string" ? commit.sha : "";
      const message =
        commit.commit && typeof commit.commit.message === "string" ? commit.commit.message : "";
      if (sha === opts.sha && message.trim()) return message;
    }

    // Keep a deterministic fallback to the latest commit visible in PR history.
    for (let i = commits.length - 1; i >= 0; i -= 1) {
      const entry = commits[i];
      const messageCandidate = entry && entry.commit ? entry.commit.message : undefined;
      const message = typeof messageCandidate === "string" ? messageCandidate : "";
      if (message && message.trim()) {
        latestMessage = message;
        break;
      }
    }

    url = parseNextLink(response.headers.get("link")) ?? "";
  }

  if (latestMessage) return latestMessage;
  throw new Error(`Could not resolve commit message from PR #${opts.prNumber} for sha ${opts.sha}`);
}

export async function mergePullRequest(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
  mergeMethod?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}): Promise<{ merged: boolean; sha: string; message: string }> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/merge`;
  const body: Record<string, string> = {
    merge_method: opts.mergeMethod ?? "squash",
  };
  if (opts.commitTitle) body.commit_title = opts.commitTitle;
  if (opts.commitMessage) body.commit_message = opts.commitMessage;

  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(opts.token),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }

  const data = (await response.json()) as { merged: boolean; sha: string; message: string };
  return data;
}

export interface ClosePullRequestResult {
  state: string;
  closed: boolean;
}

export async function closePullRequest(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
}): Promise<ClosePullRequestResult> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ state: "closed" }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }

  const data = (await response.json()) as { state?: unknown };
  const state = typeof data.state === "string" ? data.state : "";
  return { state, closed: state.toLowerCase() === "closed" };
}

export interface DeleteBranchRefResult {
  deleted: boolean;
  reason: "deleted" | "not_found";
}

export async function deleteBranchRef(opts: {
  token: string;
  remoteUrl: string;
  branchRef: string;
}): Promise<DeleteBranchRefResult> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const normalizedRef = String(opts.branchRef ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^heads\//, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalizedRef) {
    throw new Error("branchRef is required to delete a branch");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/refs/heads/${encodeURIComponent(normalizedRef)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(opts.token),
  });

  if (response.status === 404) {
    return { deleted: false, reason: "not_found" };
  }
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  return { deleted: true, reason: "deleted" };
}

export interface PullRequestComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  htmlUrl: string;
}

export async function listPullRequestComments(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
  maxComments?: number;
}): Promise<PullRequestComment[]> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const requested = Number.isFinite(opts.maxComments) ? Math.trunc(opts.maxComments ?? 0) : 0;
  const perPage = Math.max(1, Math.min(100, requested > 0 ? requested : 20));
  const issueUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${opts.prNumber}/comments?sort=created&direction=desc&per_page=${perPage}`;
  const issueResponse = await fetch(issueUrl, {
    method: "GET",
    headers: githubHeaders(opts.token),
  });

  if (!issueResponse.ok) {
    const text = await issueResponse.text();
    throw githubError(issueResponse.status, text);
  }

  const issueComments = (await issueResponse.json()) as Array<{
    id?: unknown;
    body?: unknown;
    created_at?: unknown;
    html_url?: unknown;
    user?: { login?: unknown } | null;
  }>;
  const normalizedIssueComments = Array.isArray(issueComments) ? issueComments : [];

  const reviewUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/comments?sort=created&direction=desc&per_page=${perPage}`;
  let normalizedReviewComments: Array<{
    id?: unknown;
    body?: unknown;
    created_at?: unknown;
    html_url?: unknown;
    user?: { login?: unknown } | null;
  }> = [];
  const reviewResponse = await fetch(reviewUrl, {
    method: "GET",
    headers: githubHeaders(opts.token),
  });
  if (reviewResponse.ok) {
    const reviewComments = (await reviewResponse.json()) as Array<{
      id?: unknown;
      body?: unknown;
      created_at?: unknown;
      html_url?: unknown;
      user?: { login?: unknown } | null;
    }>;
    normalizedReviewComments = Array.isArray(reviewComments) ? reviewComments : [];
  }

  return [...normalizedIssueComments, ...normalizedReviewComments]
    .map((comment): PullRequestComment | null => {
      const id = typeof comment.id === "number" ? comment.id : Number(comment.id);
      if (!Number.isFinite(id)) return null;
      const body = typeof comment.body === "string" ? comment.body : "";
      const createdAt = typeof comment.created_at === "string" ? comment.created_at : "";
      const htmlUrl = typeof comment.html_url === "string" ? comment.html_url : "";
      const userLogin =
        comment.user && typeof comment.user.login === "string" ? comment.user.login : "";
      return {
        id,
        body,
        userLogin,
        createdAt,
        htmlUrl,
      };
    })
    .filter((comment): comment is PullRequestComment => !!comment)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, perPage);
}

export async function addPullRequestComment(opts: {
  token: string;
  remoteUrl: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  const repo = parseGitHubRepo(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${opts.prNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ body: opts.body }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
}
