export type GitBaseRefCommandResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
};

export type GitBaseRefCommand = (args: string[]) => Promise<GitBaseRefCommandResult>;

export type WorktreeBaseRefLogLevel = "info" | "warn";

type ResolveReviewWorktreeBaseOptions = {
  jobId: string;
  params: Record<string, unknown>;
  git: GitBaseRefCommand;
  fallback: () => Promise<string>;
  log?: (level: WorktreeBaseRefLogLevel, message: string) => void;
};

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

export function normalizeReviewHeadRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock") ||
    /[~^:?*\[\]\s]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeExpectedSha(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/.test(normalized) ? normalized : null;
}

function isReviewResolutionType(value: string): boolean {
  return value === "review_fix" || value === "merge_conflict" || value === "integration_reconcile";
}

export async function resolveReviewWorktreeBase(
  options: ResolveReviewWorktreeBaseOptions,
): Promise<string> {
  const reviewAgent =
    options.params.reviewAgent &&
    typeof options.params.reviewAgent === "object" &&
    !Array.isArray(options.params.reviewAgent)
      ? (options.params.reviewAgent as Record<string, unknown>)
      : null;
  const resolutionType =
    typeof reviewAgent?.resolutionType === "string"
      ? reviewAgent.resolutionType.trim().toLowerCase()
      : "";
  if (!reviewAgent || !isReviewResolutionType(resolutionType)) {
    return options.fallback();
  }

  const headRef = normalizeReviewHeadRef(reviewAgent?.prHeadRef);
  const expectedHeadSha = normalizeExpectedSha(reviewAgent?.prHeadSha);
  if (!headRef || !expectedHeadSha) {
    throw new Error(
      `${resolutionType} job ${options.jobId} is missing a valid prHeadRef/prHeadSha publication lease; refusing to start from a generic base.`,
    );
  }

  const remoteRef = `origin/${headRef}`;
  const fetch = await options.git([
    "fetch",
    "origin",
    `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
    "--quiet",
  ]);
  if (!fetch.ok) {
    const detail = [fetch.stderr, fetch.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `${resolutionType} job ${options.jobId} could not refresh ${remoteRef}${
        detail ? `: ${detail}` : ""
      }.`,
    );
  }

  const verify = await options.git(["rev-parse", "--verify", `${remoteRef}^{commit}`]);
  const actualHeadSha = verify.ok
    ? String(verify.stdout ?? "")
        .trim()
        .toLowerCase()
    : "";
  if (!actualHeadSha) {
    throw new Error(`${resolutionType} job ${options.jobId} could not verify ${remoteRef}.`);
  }
  if (actualHeadSha !== expectedHeadSha) {
    throw new Error(
      `${resolutionType} job ${options.jobId} has a stale PR-head lease: expected ${expectedHeadSha}, but ${remoteRef} is ${actualHeadSha}. Requeue from the current PR head.`,
    );
  }

  if (resolutionType === "merge_conflict" || resolutionType === "integration_reconcile") {
    const baseRef = normalizeReviewHeadRef(reviewAgent?.prBaseRef);
    const expectedBaseSha = normalizeExpectedSha(reviewAgent?.prBaseSha);
    if (!baseRef || !expectedBaseSha) {
      throw new Error(
        `merge_conflict job ${options.jobId} is missing a valid prBaseRef/prBaseSha lease; refusing host-side rebase preparation.`,
      );
    }
    const baseRemoteRef = `origin/${baseRef}`;
    const fetchBase = await options.git([
      "fetch",
      "origin",
      `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      "--quiet",
    ]);
    if (!fetchBase.ok) {
      const detail = [fetchBase.stderr, fetchBase.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `merge_conflict job ${options.jobId} could not refresh ${baseRemoteRef}${
          detail ? `: ${detail}` : ""
        }.`,
      );
    }
    const verifyBase = await options.git(["rev-parse", "--verify", `${baseRemoteRef}^{commit}`]);
    const actualBaseSha = verifyBase.ok
      ? String(verifyBase.stdout ?? "")
          .trim()
          .toLowerCase()
      : "";
    if (actualBaseSha !== expectedBaseSha) {
      if (!normalizeExpectedSha(actualBaseSha)) {
        throw new Error(
          `${resolutionType} job ${options.jobId} could not refresh its stale base lease: expected ${expectedBaseSha}, but ${baseRemoteRef} is unavailable.`,
        );
      }
      reviewAgent.prBaseSha = actualBaseSha;
      reviewAgent.prBaseLeaseRefreshedFrom = expectedBaseSha;
      reviewAgent.prBaseLeaseRefreshedAt = new Date().toISOString();
      const existingGuidance =
        typeof options.params.plannerWorkerInstruction === "string"
          ? options.params.plannerWorkerInstruction.trim()
          : "";
      options.params.plannerWorkerInstruction = [
        existingGuidance,
        `Host lease refresh: ${baseRemoteRef} advanced from ${expectedBaseSha} to ${actualBaseSha} before execution. The host updated this job to the current exact base before preparing any worker checkout.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      options.log?.(
        "warn",
        `${resolutionType} job ${options.jobId}: refreshed stale base lease for ${baseRemoteRef} from ${expectedBaseSha} to ${actualBaseSha} before execution.`,
      );
    }
    options.log?.(
      "info",
      `${resolutionType} job ${options.jobId}: host verified ${baseRemoteRef} at exact base ${actualBaseSha}.`,
    );
  }

  options.log?.(
    "info",
    `${resolutionType} job ${options.jobId}: host verified ${remoteRef} at exact PR head ${actualHeadSha}.`,
  );
  return actualHeadSha;
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
    const integrationIsOnlyBehind = await isAncestor(options.git, resolvedRef, sourceBaseRef);
    if (!integrationIsOnlyBehind) {
      options.log?.(
        "warn",
        `Worktree base ${resolvedRef} has diverged from ${sourceBaseRef}; preserving the integration head while SourceControlManager reconciles it so new jobs retain integrated context.`,
      );
      return resolvedRef;
    }
  }

  options.log?.(
    "warn",
    `Worktree base ${resolvedRef} is behind ${sourceBaseRef}; using ${sourceBaseRef} for new WorkerPal jobs until SourceControlManager fast-forwards the integration branch.`,
  );
  return sourceBaseRef;
}
