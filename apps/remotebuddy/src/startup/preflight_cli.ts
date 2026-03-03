#!/usr/bin/env bun

import { existsSync } from "fs";
import { resolve } from "path";

import type {
  RepoStatus,
  StartupChecklistContext,
  SyntheticStartupTestOptions,
  SyntheticStartupTestResult,
} from "./checklist.js";
import { formatPreflightReport } from "./preflight_report.js";
import { runRemotebuddyPreflight } from "./preflight_runner.js";

function fallbackDetectRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  const root = resolve(current, "/");
  while (current !== root) {
    if (existsSync(resolve(current, ".git"))) return current;
    current = resolve(current, "..");
  }
  if (existsSync(resolve(root, ".git"))) return root;
  console.warn(`[preflight] No .git directory found, using: ${startDir}`);
  return startDir;
}

async function resolveRepoContext(
  explicitRepoRoot?: string,
): Promise<{ repoRoot: string; defaultAllowDirty: boolean }> {
  const startDir = explicitRepoRoot ?? process.cwd();
  try {
    const shared = (await import("shared")) as {
      detectRepoRoot?: (dir: string) => string;
      loadPushPalsConfig?: (options?: { projectRoot?: string }) => any;
    };
    const repoRoot =
      explicitRepoRoot ?? (typeof shared.detectRepoRoot === "function"
        ? shared.detectRepoRoot(startDir)
        : fallbackDetectRepoRoot(startDir));
    const config =
      typeof shared.loadPushPalsConfig === "function"
        ? shared.loadPushPalsConfig({ projectRoot: repoRoot })
        : null;
    const allowDirty = Boolean(config?.remotebuddy?.autonomy?.allowDirtyWorktree);
    return { repoRoot, defaultAllowDirty: allowDirty };
  } catch {
    const repoRoot = explicitRepoRoot ?? fallbackDetectRepoRoot(startDir);
    return { repoRoot, defaultAllowDirty: false };
  }
}

interface CliOptions {
  repoRoot?: string;
  outputJson: boolean;
  allowDirtyWorktree?: boolean;
  skipDependencies?: boolean;
  help?: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outputJson: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      options.outputJson = true;
      continue;
    }
    if (arg === "--repo" || arg === "-r") {
      const value = argv[++i];
      if (!value) throw new Error("--repo requires a path argument");
      options.repoRoot = resolve(value);
      continue;
    }
    if (arg === "--allow-dirty-worktree") {
      options.allowDirtyWorktree = true;
      continue;
    }
    if (arg === "--skip-deps") {
      options.skipDependencies = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function describeRepoStatus(repoRoot: string): Promise<RepoStatus> {
  const porcelain = await git(repoRoot, ["status", "--porcelain=v1", "--branch"]);
  if (!porcelain.ok) {
    return {
      isDirty: true,
      isMergeInProgress: false,
      branch: "unknown",
      detail: `git status failed: ${porcelain.stderr || porcelain.stdout}`,
    };
  }

  const lines = porcelain.stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("##")) ?? "";
  const branchMatch = branchLine.match(/^##\s+([^\.]+)(?:\.\.\.)?/);
  const branch = branchMatch ? branchMatch[1]?.trim() ?? "unknown" : "unknown";
  const dirtyRows = lines.filter((line) => !line.startsWith("##"));
  const isDirty = dirtyRows.length > 0;
  const dirtyDetail = isDirty ? dirtyRows.slice(0, 3).join(", ") : "Worktree is clean.";

  const mergeHead = await git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const isMergeInProgress = mergeHead.ok && Boolean(mergeHead.stdout);

  return {
    isDirty,
    isMergeInProgress,
    branch,
    detail: dirtyDetail,
  };
}

function listFiringAlerts(): string[] {
  const envAlerts = process.env.REMOTEBUDDY_PREFLIGHT_ALERTS;
  if (!envAlerts) return [];
  return envAlerts
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function runSyntheticProbe(
  _options: SyntheticStartupTestOptions,
): Promise<SyntheticStartupTestResult> {
  const started = Date.now();
  const forcedFailure = process.env.REMOTEBUDDY_PREFLIGHT_SYNTHETIC_FAIL;
  const latencyMs = Math.max(5, Date.now() - started);
  if (forcedFailure) {
    return { ok: false, latencyMs, failureDetail: forcedFailure };
  }
  return { ok: true, latencyMs };
}

function printUsage(): void {
  console.log("Usage: bun run remotebuddy:preflight [options]");
  console.log("\nOptions:");
  console.log("  --json                     Print JSON report to stdout.");
  console.log("  --repo <path>              Override repo root (defaults to auto-detect).");
  console.log("  --allow-dirty-worktree     Allow dirty worktrees to pass repo checks.");
  console.log("  --skip-deps                Skip dependency manifest check (advanced).");
  console.log("  -h, --help                 Show this help message.");
}

async function main(): Promise<number> {
  let parsedArgs: CliOptions;
  try {
    parsedArgs = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[preflight] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    return 1;
  }
  if (parsedArgs.help) {
    printUsage();
    return 0;
  }
  const { repoRoot, defaultAllowDirty } = await resolveRepoContext(parsedArgs.repoRoot);
  const ctx: StartupChecklistContext = {
    describeRepo: () => describeRepoStatus(repoRoot),
    listFiringAlerts: async () => listFiringAlerts(),
    syntheticTester: {
      runSyntheticJob: async (options) => runSyntheticProbe(options),
    },
  };

  const { report } = await runRemotebuddyPreflight(ctx, {
    repoRoot,
    allowDirtyWorktree: parsedArgs.allowDirtyWorktree ?? defaultAllowDirty,
    skipDependencyCheck: parsedArgs.skipDependencies,
  });

  if (parsedArgs.outputJson) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      for (const line of formatPreflightReport(report)) {
        console.error(line);
      }
    }
  } else {
    for (const line of formatPreflightReport(report)) {
      console.log(line);
    }
  }

  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(`[preflight] Unexpected failure: ${String(error)}`);
    process.exit(1);
  });
