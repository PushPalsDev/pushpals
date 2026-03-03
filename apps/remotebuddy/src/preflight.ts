import { relative } from "path";
import type { CommunicationManager } from "shared";

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return "";
  return stdout.trim();
}

export type RepoPreflightResult = {
  isWorktreeDirty: boolean;
  isMergeInProgress: boolean;
};

export async function repoPreflight(repo: string): Promise<RepoPreflightResult> {
  const porcelain = await gitOutput(repo, ["status", "--porcelain"]);
  const mergeHead = await gitOutput(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  return {
    isWorktreeDirty: Boolean(porcelain),
    isMergeInProgress: Boolean(mergeHead),
  };
}

export function mergeRebaseRemediationMessage(): string {
  return "Resolve or abort the merge/rebase (git merge --abort / git rebase --abort) before restarting RemoteBuddy dispatch.";
}

export type PreflightCheckCategory = "repo" | "dependency" | "llm" | "network" | "other";

export interface PreflightCheckResult {
  code: string;
  label?: string;
  category: PreflightCheckCategory;
  ok: boolean;
  detail?: string;
  remediation?: string;
}

export interface DependencySnapshot {
  repoRoot: string;
  generatedAt: string;
  missingWorkspaceLinks: Array<{
    label: string;
    path: string;
    probeError: string;
    expectedTarget?: string;
    actualTarget?: string;
  }>;
  brokenNodeModules: Array<{
    label: string;
    nodeModulesPath: string;
    moduleLabel: string;
    moduleSpecifier: string;
    resolveFromDir: string;
    probeError: string;
  }>;
  missingArtifacts: Array<{
    label: string;
    moduleSpecifier: string;
    fromDir: string;
    probeError: string;
  }>;
}

export interface PreflightReport {
  repoRoot: string;
  generatedAt: string;
  checks: PreflightCheckResult[];
  dependencySnapshot?: DependencySnapshot | null;
}

type RawMissingArtifact = {
  label: string;
  moduleSpecifier: string;
  fromDir: string;
  probeError: string;
};

type RawBrokenNodeModule = {
  nodeModulesPath: string;
  resolveFromDir: string;
  moduleSpecifier: string;
  moduleLabel: string;
  label: string;
  probeError: string;
};

type RawWorkspaceLinkIssue = {
  path: string;
  label: string;
  probeError: string;
  expectedTarget?: string;
  actualTarget?: string;
};

export function toDependencySnapshot(input: {
  repoRoot: string;
  generatedAt?: string | Date;
  missingArtifacts?: RawMissingArtifact[];
  brokenNodeModules?: RawBrokenNodeModule[];
  rootWorkspaceLinkIssues?: RawWorkspaceLinkIssue[];
}): DependencySnapshot {
  const repoRoot = input.repoRoot;
  const generatedAt =
    typeof input.generatedAt === "string"
      ? input.generatedAt
      : input.generatedAt instanceof Date
        ? input.generatedAt.toISOString()
        : new Date().toISOString();

  const rel = (absPath: string): string => {
    const resolved = relative(repoRoot, absPath).replace(/\\/g, "/");
    if (!resolved || resolved.startsWith("..")) return absPath;
    return resolved || ".";
  };
  const relOptional = (absPath?: string): string | undefined => {
    if (!absPath) return undefined;
    return rel(absPath);
  };

  const missingArtifacts = (input.missingArtifacts ?? []).map((entry) => ({
    label: entry.label,
    moduleSpecifier: entry.moduleSpecifier,
    fromDir: rel(entry.fromDir),
    probeError: entry.probeError,
  }));

  const brokenNodeModules = (input.brokenNodeModules ?? []).map((entry) => ({
    label: entry.label,
    nodeModulesPath: rel(entry.nodeModulesPath),
    moduleLabel: entry.moduleLabel,
    moduleSpecifier: entry.moduleSpecifier,
    resolveFromDir: rel(entry.resolveFromDir),
    probeError: entry.probeError,
  }));

  const missingWorkspaceLinks = (input.rootWorkspaceLinkIssues ?? []).map((entry) => ({
    label: entry.label,
    path: rel(entry.path),
    probeError: entry.probeError,
    expectedTarget: relOptional(entry.expectedTarget),
    actualTarget: relOptional(entry.actualTarget),
  }));

  return {
    repoRoot,
    generatedAt,
    missingArtifacts,
    brokenNodeModules,
    missingWorkspaceLinks,
  };
}

export function dependencySnapshotHasIssues(snapshot: DependencySnapshot): boolean {
  return (
    snapshot.missingArtifacts.length > 0 ||
    snapshot.brokenNodeModules.length > 0 ||
    snapshot.missingWorkspaceLinks.length > 0
  );
}

function summarizeDependencySnapshot(snapshot: DependencySnapshot): string {
  const parts: string[] = [];
  if (snapshot.missingWorkspaceLinks.length > 0) {
    const items = snapshot.missingWorkspaceLinks
      .slice(0, 3)
      .map((entry) => {
        const parts = [`error=${entry.probeError}`];
        if (entry.expectedTarget) parts.push(`expected=${entry.expectedTarget}`);
        if (entry.actualTarget) parts.push(`actual=${entry.actualTarget}`);
        return `${entry.label} (${entry.path}, ${parts.join(", ")})`;
      });
    parts.push(`Missing workspace links: ${items.join("; ")}`);
  }
  if (snapshot.brokenNodeModules.length > 0) {
    const items = snapshot.brokenNodeModules
      .slice(0, 3)
      .map((entry) => `${entry.label} (${entry.nodeModulesPath}, error=${entry.probeError})`);
    parts.push(`Broken node_modules: ${items.join("; ")}`);
  }
  if (snapshot.missingArtifacts.length > 0) {
    const items = snapshot.missingArtifacts
      .slice(0, 3)
      .map(
        (entry) =>
          `${entry.label} (${entry.moduleSpecifier} from ${entry.fromDir}, error=${entry.probeError})`,
      );
    parts.push(`Missing artifacts: ${items.join("; ")}`);
  }
  if (parts.length === 0) return "Workspace dependencies healthy.";
  return parts.join(" | ");
}

export function summarizePreflightFailure(report: PreflightReport): string {
  const firstFailure = report.checks.find((check) => !check.ok);
  if (firstFailure) {
    const label = firstFailure.label ?? firstFailure.code;
    const detail = firstFailure.detail ? ` ${firstFailure.detail}` : "";
    const remediation = firstFailure.remediation ? ` Remediation: ${firstFailure.remediation}` : "";
    return `[${firstFailure.category}] ${label}.${detail}${remediation}`.trim();
  }
  if (report.dependencySnapshot && dependencySnapshotHasIssues(report.dependencySnapshot)) {
    return `[dependency] ${summarizeDependencySnapshot(report.dependencySnapshot)}`;
  }
  return "Preflight checks passed.";
}

type AssistantMessenger = Pick<CommunicationManager, "assistantMessage">;

export async function notifyDependencyPreflightBlock(
  messenger: AssistantMessenger,
  snapshot: DependencySnapshot,
  options: { detail?: string; correlationId?: string; turnId?: string } = {},
): Promise<boolean> {
  const summary = summarizeDependencySnapshot(snapshot);
  const lines = [
    options.detail ?? "RemoteBuddy dependency preflight failed.",
    "",
    summary,
    "",
    "Remediation: run `bun install` in the repo root to restore workspace links, then restart RemoteBuddy.",
  ].filter((line, index, arr) => line.length > 0 || (index > 0 && arr[index - 1].length > 0));
  const message = lines.join("\n");
  return messenger.assistantMessage(message, {
    correlationId: options.correlationId,
    turnId: options.turnId,
  });
}
