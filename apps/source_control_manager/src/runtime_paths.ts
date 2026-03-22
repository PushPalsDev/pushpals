import { resolve } from "path";

export function resolveSourceControlManagerRuntimeRepoRoot(
  projectRoot: string | null | undefined,
  fallbackCwd = process.cwd(),
): string {
  const configuredRoot = String(projectRoot ?? "").trim();
  if (configuredRoot) {
    return resolve(configuredRoot);
  }
  return resolve(fallbackCwd);
}
