import { existsSync } from "fs";
import { join } from "path";
import {
  runStartupPreflight,
  type RepoStatus,
  type StartupChecklistContext,
  type StartupChecklistFailure,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupCheckMode,
  type StartupCheckRecord,
  type SyntheticStartupTester,
} from "./checklist.js";

export interface RemoteBuddyStartupChecksConfig {
  allowDirtyWorktree: boolean;
  alertsCheckMode: StartupCheckMode;
  syntheticCheckMode: StartupCheckMode;
  syntheticProbeName: string;
  syntheticMaxLatencyMs: number;
  alertsEndpoint?: string | null;
}

export interface RemoteBuddyLlmRuntimeConfig {
  backend: string;
  endpoint: string | null;
  model: string | null;
  apiKey: string | null;
}

export interface RemoteBuddyPreflightRuntimeConfig {
  repoRoot: string;
  server: string;
  sessionId: string | null;
  authToken: string | null;
  llm: RemoteBuddyLlmRuntimeConfig;
  startup: RemoteBuddyStartupChecksConfig;
}

export class RemoteBuddyPreflightError extends Error {
  readonly failure: StartupChecklistFailure;
  readonly history: StartupCheckRecord[];
  readonly runtime: RemoteBuddyPreflightRuntimeConfig;

  constructor(
    failure: StartupChecklistFailure,
    history: StartupCheckRecord[],
    runtime: RemoteBuddyPreflightRuntimeConfig,
  ) {
    super(
      `[RemoteBuddyPreflight] ${failure.code} step=${failure.step} category=${failure.category}: ${failure.detail}`,
    );
    this.name = "RemoteBuddyPreflightError";
    this.failure = failure;
    this.history = history;
    this.runtime = runtime;
  }
}

export interface StartupContextOverrides {
  describeRepo?: () => Promise<RepoStatus>;
  listFiringAlerts?: () => Promise<string[]>;
  syntheticTester?: SyntheticStartupTester;
  now?: () => number;
  log?: (entry: StartupCheckRecord) => void;
}

export const buildStartupChecklistContext = (
  runtime: RemoteBuddyPreflightRuntimeConfig,
  overrides: StartupContextOverrides = {},
): StartupChecklistContext => {
  const describeRepo =
    overrides.describeRepo ?? (() => describeRepoStatus(runtime.repoRoot));
  const listFiringAlerts =
    overrides.listFiringAlerts ??
    (() => defaultAlertFetcher(runtime.startup, runtime.authToken));
  const syntheticTester =
    overrides.syntheticTester ??
    resolveSyntheticTester(runtime.startup, overrides.syntheticTester);
  return {
    describeRepo,
    listFiringAlerts,
    syntheticTester,
    now: overrides.now,
    log: overrides.log,
  };
};

export interface EnsureRemoteBuddyPreflightOptions {
  context?: StartupChecklistContext;
  overrides?: StartupContextOverrides;
  checklistOptions?: Partial<StartupChecklistOptions>;
  logger?: (line: string) => void;
}

export const ensureRemoteBuddyPreflight = async (
  runtime: RemoteBuddyPreflightRuntimeConfig,
  options: EnsureRemoteBuddyPreflightOptions = {},
): Promise<StartupChecklistResult> => {
  const logger = options.logger ?? defaultLogger;
  logger(
    `[RemoteBuddyPreflight] Target server=${runtime.server} sessionId=${runtime.sessionId ?? "auto"} backend=${runtime.llm.backend} model=${runtime.llm.model ?? "n/a"} endpoint=${runtime.llm.endpoint ?? "n/a"}`,
  );
  const context =
    options.context ??
    buildStartupChecklistContext(runtime, {
      ...options.overrides,
      log: (entry) => {
        options.overrides?.log?.(entry);
        logger(
          `[RemoteBuddyPreflight] step=${entry.step} ${entry.category} ${entry.status} (${entry.code}): ${entry.detail}`,
        );
      },
    });
  const checklistOptions: StartupChecklistOptions = {
    allowDirtyWorktree: runtime.startup.allowDirtyWorktree,
    syntheticMaxLatencyMs: runtime.startup.syntheticMaxLatencyMs,
    syntheticProbeName: runtime.startup.syntheticProbeName,
    alertCheckMode: runtime.startup.alertsCheckMode,
    syntheticCheckMode: runtime.startup.syntheticCheckMode,
    ...options.checklistOptions,
  };
  const result = await runStartupPreflight(context, checklistOptions);
  if (!result.ok && result.failure) {
    throw new RemoteBuddyPreflightError(result.failure, result.history, runtime);
  }
  logger("[RemoteBuddyPreflight] Startup checklist passed.");
  return result;
};

const defaultLogger = (line: string): void => {
  console.log(line);
};

const resolveSyntheticTester = (
  startup: RemoteBuddyStartupChecksConfig,
  testerOverride?: SyntheticStartupTester,
): SyntheticStartupTester => {
  if (startup.syntheticCheckMode === "skip") {
    return {
      runSyntheticJob: async () => ({
        ok: true,
        latencyMs: 0,
        failureDetail: "syntheticCheckMode=skip",
      }),
    };
  }
  if (testerOverride) return testerOverride;
  throw new Error(
    "Synthetic startup check is enforced but no tester implementation was provided.",
  );
};

const MERGE_STATE_MARKERS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "REBASE_MERGE",
  "REBASE_APPLY",
  "CHERRY_PICK_HEAD",
  "BISECT_LOG",
] as const;

const describeRepoStatus = async (repoRoot: string): Promise<RepoStatus> => {
  const branch = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(
    () => "unknown",
  );
  const statusOutput = await runGit(repoRoot, ["status", "--porcelain"]);
  const isDirty = statusOutput.trim().length > 0;
  const firstDirty = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const mergeDetail = detectMergeState(repoRoot);
  const detailParts: string[] = [];
  if (firstDirty) detailParts.push(`dirty: ${firstDirty}`);
  if (mergeDetail) detailParts.push(mergeDetail);
  if (branch && detailParts.length === 0) detailParts.push(`branch: ${branch}`);
  return {
    isDirty,
    isMergeInProgress: Boolean(mergeDetail),
    branch,
    detail: detailParts.join(" | ") || undefined,
  };
};

const detectMergeState = (repoRoot: string): string | null => {
  const gitDir = join(repoRoot, ".git");
  for (const marker of MERGE_STATE_MARKERS) {
    if (existsSync(join(gitDir, marker))) {
      return `${marker} present`;
    }
  }
  return null;
};

const runGit = async (repoRoot: string, args: string[]): Promise<string> => {
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
  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${detail}`);
  }
  return stdout.trim();
};

const defaultAlertFetcher = async (
  startup: RemoteBuddyStartupChecksConfig,
  authToken: string | null,
): Promise<string[]> => {
  if (startup.alertsCheckMode === "skip") {
    return [];
  }
  const endpoint = startup.alertsEndpoint?.trim();
  if (!endpoint) {
    throw new Error(
      "Alert polling is enabled but no alerts_endpoint is configured. Set remotebuddy.startup.alerts_endpoint or switch alerts_check to \"skip\".",
    );
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(
      `Alert endpoint ${endpoint} failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as unknown;
  if (Array.isArray(data)) {
    return data.map((value) => String(value));
  }
  if (
    data &&
    typeof data === "object" &&
    "alerts" in data &&
    Array.isArray((data as Record<string, unknown>).alerts)
  ) {
    return ((data as Record<string, unknown>).alerts as unknown[]).map((value) =>
      String(value),
    );
  }
  throw new Error("Alert endpoint returned an unexpected payload.");
};
