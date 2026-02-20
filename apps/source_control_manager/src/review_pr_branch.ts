export interface ReviewPrHeadResolution {
  headBranch: string;
  requiresMaterialize: boolean;
}

function sanitizeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");

  return normalized;
}

export function deriveReviewPrHeadBranch(
  completionBranch: string,
  completionId: string,
): ReviewPrHeadResolution {
  const trimmed = completionBranch.trim();
  const fallback = `agent/source_control_manager/${completionId}`;

  if (trimmed.startsWith("refs/pushpals/")) {
    const suffix = sanitizeBranchName(trimmed.slice("refs/pushpals/".length));
    const candidate = suffix.startsWith("agent/") ? suffix : fallback;
    return {
      headBranch: sanitizeBranchName(candidate) || sanitizeBranchName(fallback),
      requiresMaterialize: true,
    };
  }

  if (trimmed.startsWith("refs/heads/")) {
    const branch = sanitizeBranchName(trimmed.slice("refs/heads/".length));
    return {
      headBranch: branch || sanitizeBranchName(fallback),
      requiresMaterialize: false,
    };
  }

  if (trimmed.startsWith("refs/remotes/")) {
    const parts = trimmed.split("/");
    const branch = sanitizeBranchName(parts.slice(3).join("/"));
    return {
      headBranch: branch || sanitizeBranchName(fallback),
      requiresMaterialize: false,
    };
  }

  const plain = sanitizeBranchName(trimmed.replace(/^refs\//, ""));
  return {
    headBranch: plain || sanitizeBranchName(fallback),
    requiresMaterialize: false,
  };
}
