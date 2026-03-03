import { existsSync } from "fs";
import { join, relative, resolve } from "path";

import type { PreflightCheckResult, PreflightFailure } from "./preflight_report.js";

export interface DependencyCheckIssue {
  code: string;
  label: string;
  path: string;
  detail: string;
}

export interface DependencyCheckOutcome {
  ok: boolean;
  record: PreflightCheckResult;
  failure?: PreflightFailure;
  issues: DependencyCheckIssue[];
}

const REQUIRED_DEPENDENCY_ARTIFACTS: Array<{
  code: string;
  label: string;
  relPath: string;
}> = [
  {
    code: "dependencies.package_manifest_missing",
    label: "package.json",
    relPath: "package.json",
  },
  {
    code: "dependencies.lockfile_missing",
    label: "bun.lock",
    relPath: "bun.lock",
  },
  {
    code: "dependencies.default_config_missing",
    label: "configs/default.toml",
    relPath: join("configs", "default.toml"),
  },
];

const DEPENDENCY_FAILURE_ACTION =
  "Run `bun install` from the repo root to restore workspace dependencies, then retry remotebuddy:preflight.";

export async function runDependencyPreflight(
  repoRoot: string,
): Promise<DependencyCheckOutcome> {
  const started = Date.now();
  const issues: DependencyCheckIssue[] = [];
  for (const artifact of REQUIRED_DEPENDENCY_ARTIFACTS) {
    const fullPath = resolve(repoRoot, artifact.relPath);
    if (!existsSync(fullPath)) {
      const rel = relative(repoRoot, fullPath) || artifact.relPath;
      issues.push({
        code: artifact.code,
        label: artifact.label,
        path: fullPath,
        detail: `${artifact.label} is missing (${rel}).`,
      });
    }
  }

  const elapsedMs = Math.max(0, Date.now() - started);
  if (issues.length === 0) {
    const record: PreflightCheckResult = {
      code: "dependencies.healthy",
      label: "Workspace dependency manifest is present.",
      category: "dependencies",
      step: 0,
      status: "pass",
      detail: "package.json, bun.lock, and configs/default.toml detected.",
      elapsedMs,
    };
    return { ok: true, record, issues };
  }

  const detail =
    issues.length === 1
      ? issues[0]!.detail
      : `${issues.length} dependency artifacts are missing.`;
  const failure: PreflightFailure = {
    code: issues[0]!.code,
    detail,
    action: DEPENDENCY_FAILURE_ACTION,
    category: "dependencies",
    step: 0,
  };
  const record: PreflightCheckResult = {
    code: failure.code,
    label: "Workspace dependencies must be installed.",
    category: "dependencies",
    step: 0,
    status: "fail",
    detail,
    action: DEPENDENCY_FAILURE_ACTION,
    elapsedMs,
  };
  return { ok: false, record, failure, issues };
}

export function notifyDependencyPreflightBlock(outcome: DependencyCheckOutcome, repoRoot: string): void {
  if (outcome.ok) return;
  const relRepo = repoRoot.replace(/\\/g, "/");
  console.error(`[preflight] Dependency check blocked startup: ${outcome.record.detail}`);
  for (const issue of outcome.issues) {
    const rel = relative(repoRoot, issue.path) || issue.path;
    console.error(`[preflight]   - missing ${issue.label} (${rel.replace(/\\/g, "/")})`);
  }
  console.error(
    `[preflight] Run \`bun install\` from ${relRepo} to restore workspace dependencies.`,
  );
  console.error(
    "[preflight] If this host was previously set up on a different OS, remove node_modules and rerun bun install.",
  );
}
