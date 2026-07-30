import { createHash } from "crypto";
import { homedir, tmpdir } from "os";
import { posix, win32, type PlatformPath } from "path";

export const WINDOWS_DIRECT_WORKTREE_ROOT_NAME = ".ppw";
export const LEGACY_WINDOWS_DIRECT_WORKTREE_ROOT_NAME = "ppw";

function pathApi(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function repoKey(repo: string, platform: NodeJS.Platform): string {
  return createHash("sha256")
    .update(normalizeForComparison(repo, platform))
    .digest("hex")
    .slice(0, 12);
}

export function resolveDirectWorktreeRoot(
  repo: string,
  platform: NodeJS.Platform = process.platform,
  homeRoot: string = homedir(),
): string {
  const path = pathApi(platform);
  if (platform !== "win32") return path.resolve(repo, ".worktrees");
  return path.resolve(homeRoot, WINDOWS_DIRECT_WORKTREE_ROOT_NAME, repoKey(repo, platform));
}

export function resolveLegacyDirectWorktreeRoot(
  repo: string,
  platform: NodeJS.Platform = process.platform,
  tempRoot: string = tmpdir(),
): string {
  return pathApi(platform).resolve(
    tempRoot,
    LEGACY_WINDOWS_DIRECT_WORKTREE_ROOT_NAME,
    repoKey(repo, platform),
  );
}

export function resolveDirectWorktreePath(
  repo: string,
  jobId: string,
  nonce: string,
  platform: NodeJS.Platform = process.platform,
  homeRoot: string = homedir(),
): string {
  const safeJobId =
    jobId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 8) || "host";
  const safeNonce =
    nonce
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "")
      .slice(0, 16) || "run";
  return pathApi(platform).resolve(
    resolveDirectWorktreeRoot(repo, platform, homeRoot),
    `job-${safeJobId}-${safeNonce}`,
  );
}

export function directWorktreePoolRoot(
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const path = pathApi(platform);
  const leaf = path.basename(worktreePath);
  const poolRoot = path.dirname(worktreePath);
  if (!/^job-[a-z0-9][a-z0-9-]*$/i.test(leaf)) return undefined;
  if (!/^[a-f0-9]{12}$/i.test(path.basename(poolRoot))) return undefined;
  const rootName = path.basename(path.dirname(poolRoot)).toLowerCase();
  if (
    rootName !== WINDOWS_DIRECT_WORKTREE_ROOT_NAME &&
    rootName !== LEGACY_WINDOWS_DIRECT_WORKTREE_ROOT_NAME
  ) {
    return undefined;
  }
  return normalizeForComparison(poolRoot, platform);
}

export function isDirectWorkerWorktreePath(
  repo: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
  homeRoot: string = homedir(),
  legacyTempRoot: string = tmpdir(),
): boolean {
  const path = pathApi(platform);
  const leaf = path.basename(worktreePath);
  if (!/^(job|selfcheck)-[a-z0-9][a-z0-9._-]*$/i.test(leaf)) return false;

  const normalizedParent = normalizeForComparison(path.dirname(worktreePath), platform);
  const repoLocalRoot = normalizeForComparison(path.resolve(repo, ".worktrees"), platform);
  if (normalizedParent === repoLocalRoot) return true;

  if (platform !== "win32") return false;
  const windowsRoots = [
    resolveDirectWorktreeRoot(repo, platform, homeRoot),
    resolveLegacyDirectWorktreeRoot(repo, platform, legacyTempRoot),
  ].map((root) => normalizeForComparison(root, platform));
  return windowsRoots.includes(normalizedParent);
}
