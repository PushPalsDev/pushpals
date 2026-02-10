/**
 * Repository utilities for detecting git root and reading context
 */

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Detect git repository root by walking up from start directory.
 * Returns the directory containing .git/, or start directory if not found.
 *
 * @param startDir - Directory to start searching from (typically process.cwd())
 * @returns Absolute path to repository root
 */
export function detectRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  const root = resolve(current, "/"); // Drive root on Windows, "/" on Unix

  while (current !== root) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    current = resolve(current, "..");
  }

  // Check root itself
  if (existsSync(resolve(root, ".git"))) {
    return root;
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
