#!/usr/bin/env bun
import { existsSync, lstatSync } from "fs";
import { resolve, relative } from "path";
import { createRequire } from "module";

const CLI_USAGE =
  "Usage: bun run apps/remotebuddy/src/preflight.ts [--json] [--repo <path>]\n";
const PREFLIGHT_REPO_ENV = "PUSHPALS_PREFLIGHT_REPO_ROOT";
const PREFLIGHT_OVERRIDES_ENV = "PUSHPALS_PREFLIGHT_TEST_OVERRIDES";
const PREFLIGHT_FORCE_RUN_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_RUN_ERROR";
const PREFLIGHT_FORCE_SNAPSHOT_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_SNAPSHOT_ERROR";
const PREFLIGHT_FORCE_HEALTHY_ERROR_ENV = "PUSHPALS_PREFLIGHT_TEST_FORCE_HEALTHY_ERROR";

function detectRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  const root = resolve(current, "/");

  while (current !== root) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    current = resolve(current, "..");
  }

  if (existsSync(resolve(root, ".git"))) {
    return root;
  }

  console.warn(`[preflight] No .git directory found, using: ${startDir}`);
  return startDir;
}

type DependencyProbeDefinition = {
  label: string;
  fromDir: string;
  moduleSpecifier: string;
};

type RootLinkDefinition = {
  path: string;
  label: string;
};

type WorkspaceNodeModulesDefinition = {
  nodeModulesPath: string;
  resolveFromDir: string;
  moduleSpecifier: string;
  label: string;
  moduleLabel: string;
};

type ModuleProbeIssue = DependencyProbeDefinition & { probeError: string };
type RootLinkIssue = RootLinkDefinition & { probeError: string };
type NodeModulesIssue = WorkspaceNodeModulesDefinition & { probeError: string };

export type DependencyIssueCategory =
  | "module_probe"
  | "workspace_link"
  | "node_modules"
  | "exception";

export interface DependencyIssue {
  category: DependencyIssueCategory;
  label: string;
  detail: string;
  moduleSpecifier?: string;
  path?: string;
  probeError?: string;
}

export interface DependencyPreflightReport {
  ok: boolean;
  issues: DependencyIssue[];
  checkedAt: number;
}

interface DependencySnapshotData {
  repoRoot: string;
  missingProbes: ModuleProbeIssue[];
  brokenNodeModules: NodeModulesIssue[];
  brokenRootLinks: RootLinkIssue[];
  capturedAt: number;
}

export interface DependencyConfigOverrides {
  probes?: DependencyProbeDefinition[];
  rootLinks?: RootLinkDefinition[];
  nodeModules?: WorkspaceNodeModulesDefinition[];
}

interface DependencyConfig {
  probes: DependencyProbeDefinition[];
  rootLinks: RootLinkDefinition[];
  nodeModules: WorkspaceNodeModulesDefinition[];
}

export interface EnsureDependencySnapshotOptions {
  repoRoot?: string;
  configOverrides?: DependencyConfigOverrides;
}

export class DependencyPreflight {
  constructor(private readonly snapshot: DependencySnapshotData) {}

  healthy(): DependencyPreflightReport {
    const issues: DependencyIssue[] = [];
    for (const probe of this.snapshot.missingProbes) {
      issues.push({
        category: "module_probe",
        label: probe.label,
        moduleSpecifier: probe.moduleSpecifier,
        probeError: probe.probeError,
        detail: `Unable to resolve ${probe.moduleSpecifier} from ${repoRelative(
          this.snapshot.repoRoot,
          probe.fromDir,
        )} (error=${probe.probeError || "unknown"}).`,
      });
    }
    for (const entry of this.snapshot.brokenNodeModules) {
      issues.push({
        category: "node_modules",
        label: entry.label,
        moduleSpecifier: entry.moduleSpecifier,
        probeError: entry.probeError,
        detail: `${entry.moduleLabel} cannot be resolved from ${repoRelative(
          this.snapshot.repoRoot,
          entry.resolveFromDir,
        )} (error=${entry.probeError || "unknown"}).`,
      });
    }
    for (const link of this.snapshot.brokenRootLinks) {
      issues.push({
        category: "workspace_link",
        label: link.label,
        path: repoRelative(this.snapshot.repoRoot, link.path),
        probeError: link.probeError,
        detail: `${link.label} is inaccessible (${link.probeError || "unknown"}).`,
      });
    }
    return {
      ok: issues.length === 0,
      issues,
      checkedAt: this.snapshot.capturedAt,
    };
  }
}

function repoRelative(repoRoot: string, targetPath: string): string {
  return relative(repoRoot, targetPath).replace(/\\/g, "/") || ".";
}

function defaultDependencyProbes(repoRoot: string): DependencyProbeDefinition[] {
  const root = (path: string) => resolve(repoRoot, path);
  return [
    {
      label: "TypeScript compiler",
      fromDir: root("packages/protocol"),
      moduleSpecifier: "typescript/bin/tsc",
    },
    {
      label: "Expo runtime package",
      fromDir: root("apps/client"),
      moduleSpecifier: "expo/package.json",
    },
    {
      label: "Server protocol workspace package",
      fromDir: root("apps/server"),
      moduleSpecifier: "protocol/package.json",
    },
    {
      label: "LocalBuddy shared workspace package",
      fromDir: root("apps/localbuddy"),
      moduleSpecifier: "shared",
    },
    {
      label: "RemoteBuddy shared workspace package",
      fromDir: root("apps/remotebuddy"),
      moduleSpecifier: "shared",
    },
    {
      label: "WorkerPals shared workspace package",
      fromDir: root("apps/workerpals"),
      moduleSpecifier: "shared",
    },
    {
      label: "SourceControlManager protocol workspace package",
      fromDir: root("apps/source_control_manager"),
      moduleSpecifier: "protocol/package.json",
    },
    {
      label: "packages/shared protocol workspace package",
      fromDir: root("packages/shared"),
      moduleSpecifier: "protocol/package.json",
    },
  ];
}

function defaultRootLinkChecks(repoRoot: string): RootLinkDefinition[] {
  return [
    { path: resolve(repoRoot, "node_modules/shared"), label: "node_modules/shared workspace link" },
    { path: resolve(repoRoot, "node_modules/protocol"), label: "node_modules/protocol workspace link" },
    { path: resolve(repoRoot, "node_modules/client"), label: "node_modules/client workspace link" },
  ];
}

function defaultWorkspaceNodeModules(repoRoot: string): WorkspaceNodeModulesDefinition[] {
  const root = (path: string) => resolve(repoRoot, path);
  return [
    {
      nodeModulesPath: root("packages/protocol/node_modules"),
      resolveFromDir: root("packages/protocol"),
      moduleSpecifier: "typescript/bin/tsc",
      label: "packages/protocol node_modules",
      moduleLabel: "packages/protocol TypeScript compiler",
    },
    {
      nodeModulesPath: root("apps/client/node_modules"),
      resolveFromDir: root("apps/client"),
      moduleSpecifier: "expo/package.json",
      label: "apps/client node_modules",
      moduleLabel: "apps/client Expo runtime package",
    },
    {
      nodeModulesPath: root("apps/server/node_modules"),
      resolveFromDir: root("apps/server"),
      moduleSpecifier: "protocol/package.json",
      label: "apps/server node_modules",
      moduleLabel: "apps/server protocol workspace link",
    },
    {
      nodeModulesPath: root("apps/localbuddy/node_modules"),
      resolveFromDir: root("apps/localbuddy"),
      moduleSpecifier: "shared",
      label: "apps/localbuddy node_modules",
      moduleLabel: "apps/localbuddy shared workspace link",
    },
    {
      nodeModulesPath: root("apps/remotebuddy/node_modules"),
      resolveFromDir: root("apps/remotebuddy"),
      moduleSpecifier: "shared",
      label: "apps/remotebuddy node_modules",
      moduleLabel: "apps/remotebuddy shared workspace link",
    },
    {
      nodeModulesPath: root("apps/workerpals/node_modules"),
      resolveFromDir: root("apps/workerpals"),
      moduleSpecifier: "shared",
      label: "apps/workerpals node_modules",
      moduleLabel: "apps/workerpals shared workspace link",
    },
    {
      nodeModulesPath: root("apps/source_control_manager/node_modules"),
      resolveFromDir: root("apps/source_control_manager"),
      moduleSpecifier: "protocol/package.json",
      label: "apps/source_control_manager node_modules",
      moduleLabel: "apps/source_control_manager protocol workspace link",
    },
    {
      nodeModulesPath: root("packages/shared/node_modules"),
      resolveFromDir: root("packages/shared"),
      moduleSpecifier: "protocol/package.json",
      label: "packages/shared node_modules",
      moduleLabel: "packages/shared protocol workspace link",
    },
  ];
}

function buildDependencyConfig(
  repoRoot: string,
  overrides?: DependencyConfigOverrides,
): DependencyConfig {
  return {
    probes: overrides?.probes ?? defaultDependencyProbes(repoRoot),
    rootLinks: overrides?.rootLinks ?? defaultRootLinkChecks(repoRoot),
    nodeModules: overrides?.nodeModules ?? defaultWorkspaceNodeModules(repoRoot),
  };
}

function probeModuleResolution(
  fromDir: string,
  moduleSpecifier: string,
): { ok: boolean; probeError: string } {
  try {
    const req = createRequire(resolve(fromDir, "package.json"));
    req.resolve(moduleSpecifier);
    return { ok: true, probeError: "" };
  } catch (err: any) {
    const code = typeof err?.code === "string" ? err.code : "";
    return { ok: false, probeError: code || String(err) };
  }
}

function collectMissingDependencyProbes(
  config: DependencyConfig,
): ModuleProbeIssue[] {
  return config.probes.flatMap((entry) => {
    const probe = probeModuleResolution(entry.fromDir, entry.moduleSpecifier);
    if (probe.ok) return [];
    return [{ ...entry, probeError: probe.probeError }];
  });
}

function collectBrokenWorkspaceNodeModules(
  config: DependencyConfig,
): NodeModulesIssue[] {
  return config.nodeModules.flatMap((entry) => {
    if (!existsSync(entry.nodeModulesPath)) {
      return [{ ...entry, probeError: "ENOENT" }];
    }
    const probe = probeModuleResolution(entry.resolveFromDir, entry.moduleSpecifier);
    if (probe.ok) return [];
    return [{ ...entry, probeError: probe.probeError }];
  });
}

function inspectRootWorkspaceLinks(config: DependencyConfig): RootLinkIssue[] {
  return config.rootLinks.flatMap((entry) => {
    if (!existsSync(entry.path)) {
      return [{ ...entry, probeError: "ENOENT" }];
    }
    try {
      lstatSync(entry.path);
      return [];
    } catch (err: any) {
      const code = typeof err?.code === "string" ? err.code : "";
      return [{ ...entry, probeError: code || String(err) }];
    }
  });
}

export async function ensureDependencySnapshot(
  options: EnsureDependencySnapshotOptions = {},
): Promise<DependencyPreflight> {
  if (process.env[PREFLIGHT_FORCE_SNAPSHOT_ERROR_ENV] === "1") {
    throw new Error("Forced dependency snapshot failure (test)");
  }
  const repoRoot = options.repoRoot ?? detectRepoRoot(process.cwd());
  const config = buildDependencyConfig(repoRoot, options.configOverrides);
  const snapshot: DependencySnapshotData = {
    repoRoot,
    missingProbes: collectMissingDependencyProbes(config),
    brokenNodeModules: collectBrokenWorkspaceNodeModules(config),
    brokenRootLinks: inspectRootWorkspaceLinks(config),
    capturedAt: Date.now(),
  };
  return new DependencyPreflight(snapshot);
}

export interface PreflightCheckRecord {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
  elapsedMs: number;
  issues?: DependencyIssue[];
}

export interface PreflightFailureSummary {
  id: string;
  label: string;
  detail: string;
  issues?: DependencyIssue[];
}

export interface PreflightRunResult {
  ok: boolean;
  checks: PreflightCheckRecord[];
  failure?: PreflightFailureSummary;
}

export interface RunPreflightChecksOptions extends EnsureDependencySnapshotOptions {
  logger?: Pick<typeof console, "log" | "warn" | "error">;
}

function summarizeIssues(issues: DependencyIssue[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  return issues
    .map((issue) => `${issue.label}: ${issue.detail}`)
    .slice(0, 5)
    .join("; ");
}

export async function runPreflightChecks(
  options: RunPreflightChecksOptions = {},
): Promise<PreflightRunResult> {
  if (process.env[PREFLIGHT_FORCE_RUN_ERROR_ENV] === "1") {
    throw new Error("Forced preflight run failure (test)");
  }
  const logger = options.logger ?? console;
  const repoRoot = options.repoRoot ?? detectRepoRoot(process.cwd());
  const checks: PreflightCheckRecord[] = [];
  let failure: PreflightFailureSummary | undefined;

  const dependencyLabel = "Workspace dependency health";
  const depStart = Date.now();
  let dependencyRecord: PreflightCheckRecord;
  try {
    const snapshot = await ensureDependencySnapshot({
      repoRoot,
      configOverrides: options.configOverrides,
    });
    let report: DependencyPreflightReport;
    try {
      if (process.env[PREFLIGHT_FORCE_HEALTHY_ERROR_ENV] === "1") {
        throw new Error("Forced dependency health failure (test)");
      }
      report = snapshot.healthy();
    } catch (err) {
      throw new Error(
        `dependencyPreflight.healthy() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    dependencyRecord = {
      id: "dependency",
      label: dependencyLabel,
      status: report.ok ? "pass" : "fail",
      detail: report.ok
        ? "All required workspace dependencies resolved."
        : summarizeIssues(report.issues) ||
          "Workspace dependency issues detected; run bun install and check workspace links.",
      elapsedMs: Math.max(0, Date.now() - depStart),
      issues: report.ok ? undefined : report.issues,
    };
  } catch (err) {
    const detail = `Dependency preflight crashed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(`[preflight] ${detail}`);
    dependencyRecord = {
      id: "dependency",
      label: dependencyLabel,
      status: "fail",
      detail,
      elapsedMs: Math.max(0, Date.now() - depStart),
    };
  }

  checks.push(dependencyRecord);
  if (dependencyRecord.status === "fail") {
    failure = {
      id: dependencyRecord.id,
      label: dependencyRecord.label,
      detail: dependencyRecord.detail,
      issues: dependencyRecord.issues,
    };
  }

  return { ok: checks.every((entry) => entry.status === "pass"), checks, failure };
}

export interface NotifyDependencyPreflightBlockOptions {
  server: string;
  requestId: string;
  authHeaders?: Record<string, string>;
  failure: PreflightFailureSummary;
  logger?: Pick<typeof console, "log" | "warn" | "error">;
}

export interface DependencyBlockNotificationResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

export async function notifyDependencyPreflightBlock(
  options: NotifyDependencyPreflightBlockOptions,
): Promise<DependencyBlockNotificationResult> {
  const logger = options.logger ?? console;
  const headers = {
    "Content-Type": "application/json",
    ...(options.authHeaders ?? {}),
  };
  const issues = options.failure.issues ?? [];
  const payload = {
    message: "Request blocked: workspace dependency preflight failed.",
    detail: options.failure.detail,
    issues,
  };
  try {
    const res = await fetch(`${options.server}/requests/${options.requestId}/fail`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const errorDetail = `HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`;
      logger.error(
        `[preflight] Failed to notify dependency block for ${options.requestId}: ${errorDetail}`,
      );
      return { delivered: false, status: res.status, error: errorDetail };
    }
    logger.warn(
      `[preflight] Request ${options.requestId.slice(0, 8)} blocked due to dependency preflight failure.`,
    );
    return { delivered: true, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[preflight] Error notifying dependency block for ${options.requestId}: ${message}`,
    );
    return { delivered: false, error: message };
  }
}

function loadOverridesFromEnv(): DependencyConfigOverrides | undefined {
  const raw = process.env[PREFLIGHT_OVERRIDES_ENV];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DependencyConfigOverrides;
    return parsed;
  } catch (err) {
    console.warn(
      `[preflight] Failed to parse ${PREFLIGHT_OVERRIDES_ENV}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

function printTextResult(result: PreflightRunResult): void {
  for (const check of result.checks) {
    const status = check.status === "pass" ? "PASS" : "FAIL";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`[${status}] ${check.label}${detail}`);
    if (check.issues && check.issues.length > 0) {
      for (const issue of check.issues) {
        console.log(`    - ${issue.label}: ${issue.detail}`);
      }
    }
  }

  const failure = result.failure;
  if (!failure) return;
  const alreadyLogged = result.checks.some((check) => check.id === failure.id);
  if (!alreadyLogged) {
    const detail = failure.detail ? ` - ${failure.detail}` : "";
    console.log(`[FAIL] ${failure.label}${detail}`);
    if (failure.issues && failure.issues.length > 0) {
      for (const issue of failure.issues) {
        console.log(`    - ${issue.label}: ${issue.detail}`);
      }
    }
  }
}

async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let outputJson = false;
  let repoRootOverride: string | undefined = process.env[PREFLIGHT_REPO_ENV];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      outputJson = true;
      continue;
    }
    if (arg === "--repo" || arg === "-r") {
      const next = args[++i];
      if (!next) {
        console.error("[preflight] --repo flag requires a path argument.");
        return 1;
      }
      repoRootOverride = resolve(next);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(CLI_USAGE);
      return 0;
    }
    console.warn(`[preflight] Ignoring unknown flag: ${arg}`);
  }

  const configOverrides = loadOverridesFromEnv();
  let result: PreflightRunResult;
  let exitCode: number;
  try {
    result = await runPreflightChecks({
      repoRoot: repoRootOverride,
      configOverrides,
    });
    exitCode = result.ok ? 0 : 2;
  } catch (err) {
    const detail = `Preflight checks crashed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.error(`[preflight] ${detail}`);
    result = {
      ok: false,
      checks: [
        {
          id: "crash",
          label: "Dependency preflight",
          status: "fail",
          detail,
          elapsedMs: 0,
        },
      ],
      failure: {
        id: "crash",
        label: "Dependency preflight",
        detail,
      },
    };
    exitCode = 1;
  }

  if (outputJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result);
  }

  return exitCode;
}

if (import.meta.main) {
  runCli(process.argv)
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error(`[preflight] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
