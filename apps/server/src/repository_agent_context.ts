import { existsSync, realpathSync, statSync } from "fs";
import { resolve } from "path";
import {
  resolveRepositoryIdentity,
  resolveRepositorySnapshot,
  runBoundedProcess,
  type RepositoryIdentity,
  type RepositoryAgentRepositoryRef,
} from "shared";

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  const canonical = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  const normalized = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

interface RegisteredWorktree {
  root: string;
  head: string | null;
}

async function registeredWorktrees(canonicalRepoRoot: string): Promise<RegisteredWorktree[]> {
  const result = await runBoundedProcess(
    ["git", "-C", canonicalRepoRoot, "worktree", "list", "--porcelain", "-z"],
    {
      timeoutMs: 5_000,
      outputLimitBytes: 512 * 1024,
      streamDrainTimeoutMs: 1_000,
    },
  );
  if (result.timedOut || result.drainTimedOut || result.exitCode !== 0) return [];
  const worktrees: RegisteredWorktree[] = [];
  const seen = new Set<string>();
  let current: RegisteredWorktree | null = null;

  const appendCurrent = () => {
    if (!current || seen.has(current.root)) return;
    seen.add(current.root);
    worktrees.push(current);
  };

  for (const field of result.stdout.split("\0")) {
    if (!field) {
      appendCurrent();
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      appendCurrent();
      current = null;
      const raw = field.slice("worktree ".length).trim();
      if (!raw || !existsSync(raw)) continue;
      try {
        if (!statSync(raw).isDirectory()) continue;
        current = { root: canonicalPath(raw), head: null };
      } catch {
        // A stale/prunable registration is not a usable repository context.
      }
      continue;
    }
    if (current && field.startsWith("HEAD ")) {
      const head = field.slice("HEAD ".length).trim().toLowerCase();
      current.head = /^[0-9a-f]{7,128}$/.test(head) ? head : null;
    }
  }
  appendCurrent();
  return worktrees;
}

function assertSameRepository(
  canonicalIdentity: RepositoryIdentity,
  candidateIdentity: RepositoryIdentity,
): void {
  if (
    candidateIdentity.repositoryId !== canonicalIdentity.repositoryId ||
    candidateIdentity.gitCommonDir !== canonicalIdentity.gitCommonDir
  ) {
    throw new Error("requested worktree does not belong to the registered repository");
  }
}

function snapshotMatchesRequested(
  snapshot: RepositoryAgentRepositoryRef,
  requested: Partial<RepositoryAgentRepositoryRef> | null | undefined,
): boolean {
  const revision = String(requested?.revision ?? "").trim();
  const tree = String(requested?.tree ?? "").trim();
  return (
    (!revision || snapshot.revision === revision) &&
    (!tree || snapshot.tree === tree) &&
    (typeof requested?.dirty !== "boolean" || snapshot.dirty === requested.dirty)
  );
}

export interface ResolvedRepositoryAgentContext {
  repository: RepositoryAgentRepositoryRef;
  requestedRootMapped: boolean;
}

/**
 * Resolve a caller-supplied repository reference onto this server's registered
 * repository. A caller path is advisory because container paths do not match
 * host paths. An existing non-root host path is accepted only when it is an
 * exact entry in the canonical repository's `git worktree list`, and Git also
 * proves that it shares both repository identity and common directory.
 */
export async function resolveRepositoryAgentContext(options: {
  canonicalRepoRoot: string;
  requested?: Partial<RepositoryAgentRepositoryRef> | null;
}): Promise<ResolvedRepositoryAgentContext> {
  const canonicalRepoRoot = canonicalPath(options.canonicalRepoRoot);
  // The exact snapshot already resolves the stable repository identity. Avoid
  // a second identity/Git probe on the common service/container-path flow.
  const canonicalSnapshot = await resolveRepositorySnapshot(canonicalRepoRoot, {
    timeoutMs: 10_000,
  });
  const requestedIdentity = String(options.requested?.identity ?? "").trim();
  if (requestedIdentity && requestedIdentity !== canonicalSnapshot.identity) {
    throw new Error("RepositoryAgent request identity does not match the server repository");
  }

  const requestedRoot = String(options.requested?.root ?? "").trim();
  let repositoryRoot = canonicalRepoRoot;
  let requestedRootMapped = Boolean(
    requestedRoot && canonicalPath(requestedRoot) !== canonicalRepoRoot,
  );
  let exactHostRootSelected = false;
  if (requestedRoot && existsSync(requestedRoot)) {
    if (!statSync(requestedRoot).isDirectory()) {
      throw new Error("RepositoryAgent requested repository root is not a directory");
    }
    const canonicalRequestedRoot = canonicalPath(requestedRoot);
    if (canonicalRequestedRoot === canonicalRepoRoot) {
      requestedRootMapped = false;
      exactHostRootSelected = true;
    } else {
      const registrations = await registeredWorktrees(canonicalRepoRoot);
      const registration = registrations.find((entry) => entry.root === canonicalRequestedRoot);
      if (!registration) {
        throw new Error(
          "RepositoryAgent requested worktree is not registered with this repository",
        );
      }
      const canonicalIdentity = await resolveRepositoryIdentity(canonicalRepoRoot);
      const requestedRepoIdentity = await resolveRepositoryIdentity(requestedRoot);
      assertSameRepository(canonicalIdentity, requestedRepoIdentity);
      repositoryRoot = registration.root;
      requestedRootMapped = false;
      exactHostRootSelected = true;
    }
  }

  let snapshot =
    repositoryRoot === canonicalRepoRoot
      ? canonicalSnapshot
      : await resolveRepositorySnapshot(repositoryRoot, { timeoutMs: 10_000 });
  if (!exactHostRootSelected && !snapshotMatchesRequested(snapshot, options.requested)) {
    const canonicalIdentity = await resolveRepositoryIdentity(canonicalRepoRoot);
    const requestedRevision = String(options.requested?.revision ?? "")
      .trim()
      .toLowerCase();
    const candidates = await registeredWorktrees(canonicalRepoRoot);
    let mapped: RepositoryAgentRepositoryRef | null = null;
    for (const candidate of candidates) {
      if (candidate.root === canonicalRepoRoot) continue;
      if (requestedRevision && candidate.head && candidate.head !== requestedRevision) continue;
      try {
        const candidateIdentity = await resolveRepositoryIdentity(candidate.root);
        assertSameRepository(canonicalIdentity, candidateIdentity);
        const candidateSnapshot = await resolveRepositorySnapshot(candidate.root, {
          timeoutMs: 10_000,
        });
        if (
          candidateSnapshot.identity === canonicalSnapshot.identity &&
          snapshotMatchesRequested(candidateSnapshot, options.requested)
        ) {
          mapped = candidateSnapshot;
          break;
        }
      } catch {
        // One stale/broken linked worktree must not prevent another exact match.
      }
    }
    if (mapped) {
      snapshot = mapped;
      repositoryRoot = mapped.root;
      requestedRootMapped = true;
    }
  }
  if (repositoryRoot !== canonicalRepoRoot) {
    const [canonicalIdentity, selectedIdentity] = await Promise.all([
      resolveRepositoryIdentity(canonicalRepoRoot),
      resolveRepositoryIdentity(repositoryRoot),
    ]);
    assertSameRepository(canonicalIdentity, selectedIdentity);
    if (canonicalPath(snapshot.root) !== canonicalPath(repositoryRoot)) {
      throw new Error("RepositoryAgent snapshot root does not match the registered worktree");
    }
  }
  const { revision, tree, dirty } = snapshot;

  const requestedRevision = String(options.requested?.revision ?? "").trim();
  if (requestedRevision && requestedRevision !== revision) {
    throw new Error(
      `RepositoryAgent baseline is stale: requested ${requestedRevision}, server has ${revision}`,
    );
  }
  const requestedTree = String(options.requested?.tree ?? "").trim();
  if (requestedTree && requestedTree !== tree) {
    throw new Error("RepositoryAgent content-tree fingerprint is stale");
  }

  return {
    repository: {
      identity: canonicalSnapshot.identity,
      root: repositoryRoot,
      revision,
      tree,
      dirty,
    },
    requestedRootMapped,
  };
}
