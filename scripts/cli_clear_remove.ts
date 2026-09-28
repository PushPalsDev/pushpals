import { lstat, opendir, realpath, rm, rmdir } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

const REMOVE_CONCURRENCY = 4;
const MAX_SPLIT_DEPTH = 3;
const MAX_SPLIT_DIRECTORIES = 128;
const MAX_PLANNED_PATHS = 4_096;

type Partition = { path: string; depth: number; directory: boolean };

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function unchangedDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      comparable(await realpath(path)) === comparable(path)
    ) {
      return true;
    }
    throw new Error(`Refusing to clear a directory whose type or resolved path changed: ${path}`);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * Remove one already-validated CLI clear target, without detached cleanup.
 * Partition only a bounded, shallow part of the tree; native rm handles the
 * deeper subtrees. Four disjoint removals amortize Windows per-entry latency
 * without unbounded filesystem pressure or a promise for every dependency file.
 * Links are always leaves, including dangling directory junctions on Windows.
 */
export async function removeCliTreeBounded(
  path: string,
  options: { removePath?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const removePath =
    options.removePath ?? ((target) => rm(target, { recursive: true, force: true, maxRetries: 0 }));
  const absolute = resolve(path);
  if (dirname(absolute) === absolute) throw new Error(`Refusing to clear filesystem root: ${path}`);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await removePath(absolute);
    return;
  }

  // Resolve parent aliases but never follow a link substituted for the target.
  const root = join(await realpath(dirname(absolute)), basename(absolute));
  if (!(await unchangedDirectory(root))) return;
  const pending: Partition[] = [{ path: root, depth: 0, directory: true }];
  const parents: string[] = [];
  const leaves: string[] = [];
  let plannedPaths = 1;
  let splitAttempts = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index]!;
    if (
      !entry.directory ||
      entry.depth >= MAX_SPLIT_DEPTH ||
      splitAttempts >= MAX_SPLIT_DIRECTORIES
    ) {
      leaves.push(entry.path);
      continue;
    }
    if (!(await unchangedDirectory(entry.path))) continue;
    const children: Partition[] = [];
    let overflow = false;
    splitAttempts += 1;
    try {
      // Streaming enumeration also bounds planning memory for unusually wide
      // directories. If the budget is exceeded, use native rm for this subtree.
      for await (const child of await opendir(entry.path)) {
        if (plannedPaths + children.length >= MAX_PLANNED_PATHS) {
          overflow = true;
          break;
        }
        children.push({
          path: join(entry.path, child.name),
          depth: entry.depth + 1,
          directory: child.isDirectory() && !child.isSymbolicLink(),
        });
      }
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (overflow) {
      leaves.push(entry.path);
    } else {
      plannedPaths += children.length;
      pending.push(...children);
      parents.push(entry.path);
    }
  }

  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed && next < leaves.length) {
      const target = leaves[next++]!;
      try {
        // A partition's ancestors must still be the physical directories we
        // planned, not new junctions leading outside the validated target.
        if (await unchangedDirectory(dirname(target))) await removePath(target);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  // Workers catch failures themselves: this never fail-fast returns with a
  // sibling deletion still running. The caller may retry only after all settle.
  await Promise.all(Array.from({ length: Math.min(REMOVE_CONCURRENCY, leaves.length) }, worker));
  if (failed) throw failure;

  // Parents are breadth-first in the plan. Remove them deepest-first, and only
  // when empty; newly created contents must produce ENOTEMPTY, not be erased by
  // an unplanned recursive sweep. The CLI's bounded lock retry can re-plan.
  for (const parent of parents.reverse()) {
    if (!(await unchangedDirectory(parent))) continue;
    try {
      await rmdir(parent);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
