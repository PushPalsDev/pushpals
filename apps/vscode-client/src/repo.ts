import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function resolveGitMetadataDir(repoRoot: string): string | null {
  const dotGitPath = resolve(repoRoot, ".git");
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

export function findWorkspaceRepoRoot(startDir: string): string | null {
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

export function resolveWorkspaceGitStateFilePath(
  workspacePath: string,
  fileName: string,
): string | null {
  const repoRoot = findWorkspaceRepoRoot(workspacePath);
  const normalizedFileName = String(fileName ?? "").trim();
  if (!repoRoot || !normalizedFileName) return null;
  const metadataDir = resolveGitMetadataDir(repoRoot);
  if (!metadataDir) return null;
  return join(metadataDir, normalizedFileName);
}

export function looksLikePushPalsSourceCheckout(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, "scripts", "client-preflight.ts")) &&
    existsSync(join(repoRoot, "apps", "server", "src", "server_main.ts")) &&
    existsSync(join(repoRoot, "apps", "vscode-client", "package.json"))
  );
}
