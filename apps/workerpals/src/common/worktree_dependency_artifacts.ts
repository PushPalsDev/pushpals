import { createHash } from "crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";

type JobLog = (stream: "stdout" | "stderr", line: string) => void;

export const DIRECT_WORKTREE_DEPENDENCY_ARTIFACTS = ["node_modules"] as const;
export const DIRECT_WORKTREE_DEPENDENCY_SNAPSHOT_MARKER = ".pushpals-dependency-snapshot";
export const DIRECT_WORKTREE_VALIDATION_SAFE_DEPENDENCY_SNAPSHOT_MARKER =
  ".pushpals-validation-safe-dependency-snapshot";
export const VALIDATION_SAFE_DEPENDENCY_PROJECTION_VERSION = "container-volume-v1";

export type DirectWorktreeDependencyArtifactResult = {
  linked: string[];
  skipped: string[];
  warnings: string[];
};

function pathExistsOrLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sourceCanBeLinked(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function linkTypeForHost(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}

const MUTABLE_DEPENDENCY_DIRS = new Set([".cache", ".expo", ".vite"]);

export function dependencySnapshotKey(repo: string): string {
  const hash = createHash("sha256");
  let included = 0;
  for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
    const path = resolve(repo, name);
    try {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(path));
      hash.update("\0");
      included += 1;
    } catch {
      // A repository may use only one lockfile format.
    }
  }
  return included > 0 ? hash.digest("hex") : "unversioned";
}

function materializeDependencySnapshot(
  source: string,
  destination: string,
  snapshotKey: string,
): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourceEntry = resolve(source, entry);
    const destinationEntry = resolve(destination, entry);
    const stat = lstatSync(sourceEntry);
    if (MUTABLE_DEPENDENCY_DIRS.has(entry)) {
      mkdirSync(destinationEntry, { recursive: true });
    } else if (
      stat.isDirectory() ||
      (stat.isSymbolicLink() && statSync(sourceEntry).isDirectory())
    ) {
      symlinkSync(sourceEntry, destinationEntry, linkTypeForHost());
    } else {
      copyFileSync(sourceEntry, destinationEntry);
    }
  }
  writeFileSync(
    resolve(destination, DIRECT_WORKTREE_DEPENDENCY_SNAPSHOT_MARKER),
    `${snapshotKey}\n`,
    "utf8",
  );
}

export function linkDirectWorktreeDependencyArtifacts(
  repo: string,
  worktreePath: string,
  onLog?: JobLog,
  artifactNames: readonly string[] = DIRECT_WORKTREE_DEPENDENCY_ARTIFACTS,
): DirectWorktreeDependencyArtifactResult {
  const linked: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const name of artifactNames) {
    const source = resolve(repo, name);
    const destination = resolve(worktreePath, name);
    if (!sourceCanBeLinked(source)) {
      skipped.push(name);
      continue;
    }
    if (pathExistsOrLink(destination)) {
      skipped.push(name);
      continue;
    }

    try {
      if (name === "node_modules") {
        materializeDependencySnapshot(source, destination, dependencySnapshotKey(repo));
      } else {
        symlinkSync(source, destination, linkTypeForHost());
      }
      linked.push(name);
    } catch (err) {
      if (name === "node_modules" && pathExistsOrLink(destination)) {
        rmSync(destination, { recursive: true, force: true });
      }
      const warning = `[WorkerPals] Worktree dependency artifact linking skipped for ${name}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      warnings.push(warning);
      console.warn(warning);
      onLog?.("stderr", warning);
    }
  }

  if (linked.length > 0) {
    const note =
      `[WorkerPals] Materialized content-addressed worktree dependency snapshot(s): ` +
      linked.join(", ");
    console.log(note);
    onLog?.("stdout", note);
  }

  return { linked, skipped, warnings };
}
