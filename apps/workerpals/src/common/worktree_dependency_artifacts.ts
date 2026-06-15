import { lstatSync, symlinkSync } from "fs";
import { resolve } from "path";

type JobLog = (stream: "stdout" | "stderr", line: string) => void;

export const DIRECT_WORKTREE_DEPENDENCY_ARTIFACTS = ["node_modules"] as const;

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
      symlinkSync(source, destination, linkTypeForHost());
      linked.push(name);
    } catch (err) {
      const warning = `[WorkerPals] Worktree dependency artifact linking skipped for ${name}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      warnings.push(warning);
      console.warn(warning);
      onLog?.("stderr", warning);
    }
  }

  if (linked.length > 0) {
    const note = `[WorkerPals] Linked worktree dependency artifact(s): ${linked.join(", ")}`;
    console.log(note);
    onLog?.("stdout", note);
  }

  return { linked, skipped, warnings };
}
