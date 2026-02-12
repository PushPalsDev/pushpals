export interface PullRequestUpsertResult {
  created: boolean;
  number: number;
  htmlUrl: string;
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
