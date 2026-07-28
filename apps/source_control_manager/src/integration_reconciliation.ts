import type { IntegrationBaseSyncResult } from "./git";

export type IntegrationReconciliationJobPayload = {
  taskId: string;
  sessionId: string;
  kind: "task.execute";
  dedupeKey: string;
  dedupeCooldownMs: number;
  priority: "interactive";
  params: Record<string, unknown>;
};

function normalizeBranch(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    normalized.endsWith(".") ||
    normalized.endsWith(".lock") ||
    /[~^:?*\[\]\s]/.test(normalized)
  ) {
    throw new Error(`Unsafe integration reconciliation branch: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeConflictPaths(values: string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..") ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths.slice(0, 64);
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./@+-]+$/.test(value)
    ? value
    : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function validationSteps(conflictPaths: string[]): string[] {
  const tests = conflictPaths.filter((path) =>
    /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path),
  );
  if (tests.length > 0) {
    return tests.slice(0, 8).map((path) => `bun test ${quoteCommandArg(path)}`);
  }
  return ["bun run validate"];
}

export function integrationReconciliationFingerprint(options: {
  integrationBranch: string;
  integrationHeadSha: string;
  baseHeadSha: string;
}): string {
  return [
    "integration-reconcile",
    normalizeBranch(options.integrationBranch),
    options.integrationHeadSha.trim().toLowerCase(),
    options.baseHeadSha.trim().toLowerCase(),
  ].join(":");
}

export function buildIntegrationReconciliationJob(options: {
  sessionId: string;
  integrationBranch: string;
  baseBranch: string;
  sync: Extract<IntegrationBaseSyncResult, { status: "conflicted" }>;
  now?: number;
}): IntegrationReconciliationJobPayload {
  const integrationBranch = normalizeBranch(options.integrationBranch);
  const baseBranch = normalizeBranch(options.baseBranch);
  if (integrationBranch === baseBranch) {
    throw new Error("Integration reconciliation requires distinct integration and base branches.");
  }
  const conflictPaths = normalizeConflictPaths(options.sync.conflictPaths);
  if (conflictPaths.length === 0) {
    throw new Error("Integration reconciliation requires at least one safe conflicted path.");
  }
  const now = Number.isFinite(options.now) ? Math.floor(options.now ?? Date.now()) : Date.now();
  const shortIntegration = options.sync.integrationHeadSha.slice(0, 12);
  const shortBase = options.sync.baseHeadSha.slice(0, 12);
  const instruction = [
    `Reconcile the PushPals integration branch ${integrationBranch} with ${baseBranch}.`,
    `The host prepared ${integrationBranch} at ${shortIntegration} and began rebasing it onto ${baseBranch} at ${shortBase}.`,
    `Resolve only the prepared conflicts: ${conflictPaths.join(", ")}.`,
    "Preserve the intended behavior from both branches and run focused validation.",
    "Do not checkout, switch, reset, merge, rebase, stage, commit, or push. Host-side SCM owns the rebase and exact-lease publication.",
  ].join("\n");
  const fingerprint = integrationReconciliationFingerprint({
    integrationBranch,
    integrationHeadSha: options.sync.integrationHeadSha,
    baseHeadSha: options.sync.baseHeadSha,
  });

  return {
    taskId: `integration-reconcile-${now}`,
    sessionId: options.sessionId,
    kind: "task.execute",
    dedupeKey: fingerprint,
    dedupeCooldownMs: 30_000,
    priority: "interactive",
    params: {
      schemaVersion: 2,
      origin: "autonomy",
      instruction,
      plannerWorkerInstruction: [
        "Integration reconciliation brief:",
        `- Integration branch: ${integrationBranch} (${options.sync.integrationHeadSha})`,
        `- Base branch: ${baseBranch} (${options.sync.baseHeadSha})`,
        `- Prepared conflict paths: ${conflictPaths.join(", ")}`,
        "- Resolve the host-prepared rebase state and validate the affected files.",
        "- SourceControlManager alone publishes the rebased integration head with an exact force-with-lease.",
      ].join("\n"),
      recentContext: [
        `${integrationBranch} and ${baseBranch} diverged and the deterministic host merge found conflicts.`,
        `Reconciliation fingerprint: ${fingerprint}`,
      ],
      planning: {
        intent: "code_change",
        riskLevel: "high",
        targetPaths: conflictPaths,
        acceptanceCriteria: [
          `${integrationBranch} contains the current ${baseBranch} history without unresolved conflicts.`,
          "Both branches' intended behavior is preserved in every conflicted file.",
          "Focused validation for the conflicted paths passes.",
        ],
        validationSteps: validationSteps(conflictPaths),
        queuePriority: "interactive",
        queueWaitBudgetMs: 30_000,
        executionBudgetMs: 1_200_000,
        finalizationBudgetMs: 120_000,
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: conflictPaths,
        },
        discovery: {
          ripgrepQueries: conflictPaths.map((path) => path.split("/").at(-1) ?? path).slice(0, 8),
          likelyDirs: [
            ...new Set(
              conflictPaths.map((path) => path.split("/").slice(0, -1).join("/")).filter(Boolean),
            ),
          ].slice(0, 12),
          keywords: ["integration reconciliation", integrationBranch, baseBranch],
        },
      },
      completionBranch: integrationBranch,
      reviewAgent: {
        prHeadSha: options.sync.integrationHeadSha,
        prBaseSha: options.sync.baseHeadSha,
        prHeadRef: integrationBranch,
        prBaseRef: baseBranch,
        resolutionType: "integration_reconcile",
        mergeError: options.sync.detail,
        requestedAt: new Date(now).toISOString(),
      },
      lane: "worker",
      recentJobs: [],
    },
  };
}
