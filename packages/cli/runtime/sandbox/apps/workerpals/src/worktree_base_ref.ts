export type GitBaseRefCommandResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
};

export type GitBaseRefCommand = (args: string[]) => Promise<GitBaseRefCommandResult>;

export type WorktreeBaseRefLogLevel = "info" | "warn";

export type ResolveFreshWorktreeBaseRefOptions = {
  requestedRef: string;
  integrationBranch: string;
  sourceBaseBranch: string;
  remote?: string;
  git: GitBaseRefCommand;
  log?: (level: WorktreeBaseRefLogLevel, message: string) => void;
};

function normalizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeRequestedRef(value: string): string {
  return value.trim() || "HEAD";
}

function remoteRef(remote: string, branch: string): string {
  return `${remote}/${branch}`;
}

function isIntegrationBaseRequest(ref: string, integrationBranch: string, remote: string): boolean {
  const normalized = normalizeRequestedRef(ref);
  const branch = normalizeBranchName(normalized);
  return (
    branch === integrationBranch ||
    normalized === remoteRef(remote, integrationBranch) ||
    normalized === `refs/remotes/${remote}/${integrationBranch}`
  );
}

async function fetchRemoteBranch(
  git: GitBaseRefCommand,
  remote: string,
  branch: string,
): Promise<GitBaseRefCommandResult> {
  if (!remote || !branch || branch === "HEAD") return { ok: true };
  return git(["fetch", remote, branch, "--quiet"]);
}

async function refExists(git: GitBaseRefCommand, ref: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", "--quiet", ref]);
  return result.ok;
}

async function isAncestor(
  git: GitBaseRefCommand,
  ancestorRef: string,
  descendantRef: string,
): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", ancestorRef, descendantRef]);
  return result.ok;
}

export async function resolveExistingWorktreeBaseRef(
  options: Omit<ResolveFreshWorktreeBaseRefOptions, "sourceBaseBranch" | "log">,
): Promise<string> {
  const remote = (options.remote ?? "origin").trim() || "origin";
  const requestedRef = normalizeRequestedRef(options.requestedRef);
  const integrationBranch = normalizeBranchName(options.integrationBranch) || "main_agents";
  const integrationRemoteRef = remoteRef(remote, integrationBranch);
  const candidates = new Set<string>([
    requestedRef,
    integrationRemoteRef,
    integrationBranch,
    "HEAD",
  ]);

  if (requestedRef.startsWith(`${remote}/`)) {
    const branch = requestedRef.slice(`${remote}/`.length);
    await fetchRemoteBranch(options.git, remote, branch);
    candidates.add(branch);
  } else if (requestedRef !== "HEAD") {
    candidates.add(remoteRef(remote, requestedRef));
  }

  for (const ref of candidates) {
    if (await refExists(options.git, ref)) return ref;
  }

  return "HEAD";
}

export async function resolveFreshWorktreeBaseRef(
  options: ResolveFreshWorktreeBaseRefOptions,
): Promise<string> {
  const remote = (options.remote ?? "origin").trim() || "origin";
  const requestedRef = normalizeRequestedRef(options.requestedRef);
  const integrationBranch = normalizeBranchName(options.integrationBranch) || "main_agents";
  const sourceBaseBranch = normalizeBranchName(options.sourceBaseBranch) || "main";
  const resolvedRef = await resolveExistingWorktreeBaseRef({
    requestedRef,
    integrationBranch,
    remote,
    git: options.git,
  });

  if (
    !sourceBaseBranch ||
    sourceBaseBranch === integrationBranch ||
    !isIntegrationBaseRequest(requestedRef, integrationBranch, remote)
  ) {
    return resolvedRef;
  }

  const sourceBaseRef = remoteRef(remote, sourceBaseBranch);
  const fetchSource = await fetchRemoteBranch(options.git, remote, sourceBaseBranch);
  if (!fetchSource.ok) {
    options.log?.(
      "warn",
      `Could not refresh ${sourceBaseRef}; checking local ref before keeping ${resolvedRef} (${fetchSource.stderr || fetchSource.stdout || "fetch failed"}).`,
    );
  }

  if (!(await refExists(options.git, sourceBaseRef))) return resolvedRef;

  if (resolvedRef !== "HEAD" && (await refExists(options.git, resolvedRef))) {
    const sourceAlreadyIncluded = await isAncestor(options.git, sourceBaseRef, resolvedRef);
    if (sourceAlreadyIncluded) return resolvedRef;
  }

  options.log?.(
    "warn",
    `Worktree base ${resolvedRef} does not contain ${sourceBaseRef}; using ${sourceBaseRef} for new WorkerPal jobs to avoid stale integration-branch checkouts.`,
  );
  return sourceBaseRef;
}
