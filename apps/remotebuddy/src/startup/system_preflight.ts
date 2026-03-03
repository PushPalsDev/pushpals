import type {
  RepoStatus,
  StartupChecklistContext,
  StartupCheckRecord,
  SyntheticStartupTester,
  SyntheticStartupTestOptions,
  SyntheticStartupTestResult,
} from "./checklist";

type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SystemStartupContextOptions {
  repoRoot: string;
  serverUrl: string;
  authToken?: string | null;
  fetchImpl?: FetchImpl;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
  describeRepo?: () => Promise<RepoStatus>;
  listFiringAlerts?: () => Promise<string[]>;
  syntheticTester?: SyntheticStartupTester;
}

export function createSystemStartupContext(
  options: SystemStartupContextOptions,
): StartupChecklistContext {
  const describeRepo =
    options.describeRepo ?? (() => describeRepoStatus(options.repoRoot).catch(reportRepoError));
  const listFiringAlerts = options.listFiringAlerts ?? (() => Promise.resolve<string[]>([]));
  const syntheticTester =
    options.syntheticTester ??
    createHealthzSyntheticTester({
      serverUrl: options.serverUrl,
      authToken: options.authToken ?? null,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });

  return {
    describeRepo,
    listFiringAlerts,
    syntheticTester,
    now: options.now,
    log: options.log,
  };
}

async function describeRepoStatus(repoRoot: string): Promise<RepoStatus> {
  const porcelain = await gitOutput(repoRoot, ["status", "--porcelain=v1"]);
  const branchRaw = await gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const mergeHead = await gitOutput(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);

  const branch = (branchRaw || "").trim() || undefined;
  const isDirty = porcelain.trim().length > 0;
  const isMergeInProgress = mergeHead.trim().length > 0;
  const detail = buildRepoDetail(porcelain, branch);

  return {
    isDirty,
    isMergeInProgress,
    branch,
    detail,
  };
}

function buildRepoDetail(porcelain: string, branch?: string): string | undefined {
  const lines = porcelain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    if (branch) return `${branch} is clean.`;
    return undefined;
  }
  const snippet = lines.slice(0, 3).join("; ");
  if (lines.length <= 3) return snippet;
  return `${snippet}; … (${lines.length} total change(s))`;
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
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
  } catch {
    return "";
  }
}

function reportRepoError(error: unknown): RepoStatus {
  const detail =
    error instanceof Error
      ? error.message
      : `Unknown repo status error: ${String(error)}`;
  return {
    isDirty: false,
    isMergeInProgress: false,
    detail,
  };
}

function createHealthzSyntheticTester(options: {
  serverUrl: string;
  authToken: string | null;
  fetchImpl?: FetchImpl;
  now?: () => number;
}): SyntheticStartupTester {
  const fetcher = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const serverUrl = options.serverUrl;

  const runSyntheticJob = async (
    job: SyntheticStartupTestOptions,
  ): Promise<SyntheticStartupTestResult> => {
    if (!fetcher || !serverUrl) {
      return { ok: true, latencyMs: 0 };
    }
    const started = now();
    try {
      const url = new URL("/healthz", serverUrl);
      const res = await fetcher(url, {
        headers: options.authToken
          ? { Authorization: `Bearer ${options.authToken}` }
          : undefined,
      });
      const latencyMs = Math.max(0, now() - started);
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          failureDetail: `HTTP ${res.status} ${res.statusText}`.trim(),
        };
      }
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Math.max(0, now() - started);
      return {
        ok: false,
        latencyMs,
        failureDetail: error instanceof Error ? error.message : "Synthetic probe failed",
      };
    }
  };

  return { runSyntheticJob };
}
