/**
 * Repository utilities for detecting git root and reading context
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

function resolveDotGitEntry(repoRoot: string): string {
  return resolve(repoRoot, ".git");
}

export function findGitRepoRoot(startDir: string): string | null {
  const override = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? "").trim();
  if (override) {
    const resolvedOverride = resolve(override);
    if (resolveGitMetadataDir(resolvedOverride)) {
      return resolvedOverride;
    }
    console.warn(
      `[repo] PUSHPALS_REPO_ROOT_OVERRIDE does not point to a git repository: ${resolvedOverride}`,
    );
  }

  let current = resolve(startDir);
  const root = resolve(current, "/");

  while (current !== root) {
    if (resolveGitMetadataDir(current)) {
      return current;
    }
    current = resolve(current, "..");
  }

  return resolveGitMetadataDir(root) ? root : null;
}

export function resolveGitMetadataDir(repoRoot: string): string | null {
  const dotGitPath = resolveDotGitEntry(repoRoot);
  if (!existsSync(dotGitPath)) return null;

  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const firstLine = readFileSync(dotGitPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match) return null;
    const gitDir = resolve(repoRoot, match[1].trim());
    return existsSync(gitDir) ? gitDir : null;
  } catch {
    return null;
  }
}

export function resolveGitStateFilePath(repoRoot: string, fileName: string): string | null {
  const gitMetadataDir = resolveGitMetadataDir(repoRoot);
  const normalizedFileName = String(fileName ?? "").trim();
  if (!gitMetadataDir || !normalizedFileName) return null;
  return resolve(gitMetadataDir, normalizedFileName);
}

/**
 * Detect git repository root by walking up from start directory.
 * Returns the directory containing git metadata, or start directory if not found.
 *
 * @param startDir - Directory to start searching from (typically process.cwd())
 * @returns Absolute path to repository root
 */
export function detectRepoRoot(startDir: string): string {
  const repoRoot = findGitRepoRoot(startDir);
  if (repoRoot) {
    return repoRoot;
  }

  // Fallback to start directory if no .git found
  console.warn(`[repo] No .git directory found, using: ${startDir}`);
  return startDir;
}

/**
 * Read basic repository context for LLM enhancement.
 * Executes git commands to gather current branch, status, and recent commits.
 *
 * @param repoRoot - Absolute path to repository root
 * @returns Repository context object
 */
export async function getRepoContext(repoRoot: string): Promise<{
  branch: string;
  status: string;
  recentCommits: string;
}> {
  const git = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr}`);
    }

    return stdout.trim();
  };

  try {
    const [branch, status, recentCommits] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown"),
      git(["status", "--porcelain"]).catch(() => "unknown"),
      git(["log", "--oneline", "-n", "5"]).catch(() => "unknown"),
    ]);

    return { branch, status, recentCommits };
  } catch (err) {
    console.error("[repo] Failed to get repo context:", err);
    return {
      branch: "unknown",
      status: "unknown",
      recentCommits: "unknown",
    };
  }
}
