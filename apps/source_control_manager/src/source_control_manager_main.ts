import { parseArgs } from "util";
import { isAbsolute, join, relative, resolve } from "path";
import { mkdirSync } from "fs";
import { createHash } from "crypto";
import { CommunicationManager } from "../../../packages/shared/src/communication.js";
import { loadPushPalsConfig } from "../../../packages/shared/src/config.js";
import { resolveGitTokenForRemote } from "../../../packages/shared/src/git_backend.js";
import { MergeQueueDB } from "./db";
import { FileLock } from "./lock";
import { createSourceControlApi, runGitCommandCapture, type SourceControlApi } from "./git";
import { ensureIntegrationPullRequest } from "./github_pr";
import {
  IntegrationMaintenanceRunner,
  maintainIntegrationBeforeCompletionClaim,
} from "./integration_maintenance";
import { ReviewAgent } from "./review_agent";
import { deriveReviewPrHeadBranch } from "./review_pr_branch";
import {
  buildReviewCompletionValidationCheckoutArgs,
  buildReviewPublicationPushArgs,
  parseReviewPublicationLease,
  reviewCompletionHandoffMatches,
  shouldCleanupCompletionHandoff,
  shouldPublishWithExactReviewLease,
  shouldUseReviewPublicationFlow,
} from "./review_publication";
import { normalizePrTitleCandidate, resolveReviewAgentPrTitle } from "./pr_title";
import { shouldBypassApplyFailureInReviewMode } from "./review_apply_fallback";
import {
  cloneSourceControlManagerConfigSnapshot,
  createStartupStatusTracker,
  createSourceControlManagerHealthTracker,
  createSingleFlightExecutor,
  probeReviewAgentRuntimeReadiness,
  type SourceControlManagerPublicationHealth,
} from "./runtime_helpers";
import { createStatusServer } from "./http";
import { resolveSourceControlManagerRuntimeRepoRoot } from "./runtime_paths";
import { runProcessWithTreeTimeout, runTrustedValidationCommands } from "./trusted_validation";
import type {
  TrustedValidationExecutionResult,
  TrustedValidationReport,
} from "../../../packages/shared/src/trusted_validation.js";
import {
  loadConfig,
  applyCliOverrides,
  validateConfig,
  type SourceControlManagerConfig,
  type CheckConfig,
} from "./config";

type GitCmdResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const PUSH_CONFIG = loadPushPalsConfig();
const repoRoot = resolveSourceControlManagerRuntimeRepoRoot(PUSH_CONFIG.projectRoot, process.cwd());
const defaultSourceControlManagerRepoPath = resolve(PUSH_CONFIG.sourceControlManager.repoPath);
const COMPLETION_LEASE_MS = 3 * 60_000;
const COMPLETION_LEASE_HEARTBEAT_MS = 30_000;
const PUBLICATION_HEALTH_POLL_MS = 10_000;
const SCM_TICK_STALL_MS = Math.max(
  60_000,
  Number(process.env.PUSHPALS_SCM_TICK_STALL_MS) || 17 * 60_000,
);

// ─── CLI ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    repo: { type: "string", short: "r" },
    server: { type: "string", short: "s" },
    port: { type: "string", short: "p" },
    remote: { type: "string" },
    branch: { type: "string", short: "b" },
    prefix: { type: "string" },
    interval: { type: "string", short: "i" },
    "state-dir": { type: "string" },
    "delete-after-merge": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "skip-clean-check": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

if (args.help) {
  console.log(`
source_control_manager — SourceControlManager merge queue daemon

Usage:
  bun run apps/source_control_manager/src/source_control_manager_main.ts [options]

Options:
  -r, --repo <path>         Git repository path (default: configs/default.toml source_control_manager.repo_path)
  -s, --server <url>        PushPals server URL (default: http://localhost:3001)
  -p, --port <number>       HTTP status server port (default: 3002)
      --remote <name>       Git remote (default: origin)
  -b, --branch <name>       Integration branch name (default: main_agents)
      --prefix <prefix>     Agent branch prefix (default: agent/)
  -i, --interval <seconds>  Poll interval in seconds (default: 10)
      --state-dir <path>    State directory for DB & lock (default: outputs/data/source_control_manager)
      --delete-after-merge  Delete remote branch after merge
      --dry-run             Discover and enqueue only, do not process
      --skip-clean-check    Skip the clean-repo guard (for dev working copies)
  -h, --help                Show this help
`);
  process.exit(0);
}

// ─── Config ─────────────────────────────────────────────────────────────────
if (typeof args.config === "string" && args.config.trim()) {
  console.warn(
    `[${new Date().toISOString()}] Ignoring --config override; SourceControlManager now uses shared PushPals config only.`,
  );
}

let config = loadConfig();

const cliOverrides: Partial<SourceControlManagerConfig> = {};
if (typeof args.repo === "string") cliOverrides.repoPath = resolve(args.repo);
if (typeof args.server === "string") cliOverrides.serverUrl = args.server;
if (typeof args.port === "string") {
  const n = parseInt(args.port, 10);
  if (Number.isFinite(n) && n > 0) cliOverrides.port = n;
  else {
    console.error(`Invalid --port value: ${args.port}`);
    process.exit(1);
  }
}
if (typeof args.remote === "string") cliOverrides.remote = args.remote;
if (typeof args.branch === "string") cliOverrides.mainBranch = args.branch;
if (typeof args.prefix === "string") cliOverrides.branchPrefix = args.prefix;
if (typeof args.interval === "string") {
  const n = parseInt(args.interval, 10);
  if (Number.isFinite(n) && n > 0) cliOverrides.pollIntervalSeconds = n;
  else {
    console.error(`Invalid --interval value: ${args.interval}`);
    process.exit(1);
  }
}
if (typeof args["state-dir"] === "string") cliOverrides.stateDir = resolve(args["state-dir"]);
if (args["delete-after-merge"]) cliOverrides.deleteAfterMerge = true;

config = applyCliOverrides(config, cliOverrides);
config.repoPath = resolve(config.repoPath);
const integrationBaseBranch = config.integrationBaseBranch;
const integrationBaseRef = `${config.remote}/${integrationBaseBranch}`;
const usingDefaultRepoPath =
  resolve(config.repoPath) === resolve(defaultSourceControlManagerRepoPath);

// Validate config before proceeding
try {
  validateConfig(config);
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

const dryRun = args["dry-run"] === true;
const skipCleanCheckFlag = args["skip-clean-check"] === true;
const skipCleanCheck = skipCleanCheckFlag || config.skipCleanCheck;
const statusSessionId = PUSH_CONFIG.sessionId.trim() || "dev";
const statusHeartbeatMs = Math.max(0, config.statusHeartbeatMs);

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString();

console.log(`[${ts()}] source_control_manager starting`);
console.log(`[${ts()}]   config:   shared (packages/shared/src/config.ts)`);
console.log(`[${ts()}]   repo:     ${config.repoPath}`);
console.log(`[${ts()}]   remote:   ${config.remote}`);
console.log(`[${ts()}]   main:     ${config.mainBranch}`);
console.log(`[${ts()}]   prefix:   ${config.branchPrefix}`);
console.log(`[${ts()}]   interval: ${config.pollIntervalSeconds}s`);
console.log(`[${ts()}]   state:    ${config.stateDir}`);
console.log(`[${ts()}]   port:     ${config.port}`);
console.log(`[${ts()}]   checks:   ${config.checks.length}`);
if (dryRun) console.log(`[${ts()}]   mode:     DRY RUN`);
if (skipCleanCheck) {
  const source = skipCleanCheckFlag
    ? "--skip-clean-check flag"
    : "source_control_manager.skip_clean_check";
  console.log(`[${ts()}]   mode:     SKIP CLEAN CHECK (${source})`);
}

// Ensure state directory exists
mkdirSync(config.stateDir, { recursive: true });

// ── Lock ────────────────────────────────────────────────────────────────────

const lock = new FileLock(config.stateDir);
if (!lock.acquire()) {
  console.error(`[${ts()}] Another source_control_manager instance is already running. Exiting.`);
  process.exit(1);
}
console.log(`[${ts()}] Lock acquired`);

// ── Database ────────────────────────────────────────────────────────────────

const dbPath = join(config.stateDir, "merge_queue.db");
const db = new MergeQueueDB(dbPath);
console.log(`[${ts()}] Database opened: ${dbPath}`);

const sourceControlManagerPusherId = `source_control_manager-${createHash("sha256")
  .update(`${config.repoPath}\n${config.mainBranch}\n${config.remote}`)
  .digest("hex")
  .slice(0, 12)}`;
let reconcilePusherOnNextClaim = true;
const healthTracker = createSourceControlManagerHealthTracker({
  tickStallMs: SCM_TICK_STALL_MS,
  idleBacklogGraceMs: Math.max(30_000, config.pollIntervalSeconds * 3_000),
});

// Recover any jobs stuck in 'running' from a previous crash
const recovered = db.recoverStuckJobs();
if (recovered > 0) {
  console.log(`[${ts()}] Recovered ${recovered} stuck running job(s) -> queued`);
}

// ── Git Operations ─────────────────────────────────────────────────────────

const gitOps: SourceControlApi = createSourceControlApi(config);

// ── HTTP server ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof createStatusServer> | undefined;
try {
  server = createStatusServer(db, config.port, healthTracker.snapshot);
  console.log(`[${ts()}] Status server listening on http://127.0.0.1:${config.port}`);
} catch (err: unknown) {
  const code = err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
  if (code === "EADDRINUSE") {
    console.error(`[${ts()}] Port ${config.port} already in use — status server disabled.`);
    console.error(`  TIP: kill the old process or use --port <N> / config "port" to pick another.`);
  } else {
    throw err;
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────────────

let running = true;
let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let publicationHealthTimer: ReturnType<typeof setInterval> | null = null;
let publicationHealthProbeInFlight = false;
let reviewAgentPollTimer: ReturnType<typeof setInterval> | null = null;
let reviewAgentConfigPollTimer: ReturnType<typeof setInterval> | null = null;
let reviewAgentInstance: ReviewAgent | null = null;
let statusSessionReady = false;
let shutdownPromise: Promise<void> | null = null;
const startupStatusTracker = createStartupStatusTracker();
let reviewAgentRuntimeStateKey = "startup";
let reviewAgentRuntimeFingerprint = "";

async function refreshPublicationHealth(): Promise<void> {
  if (publicationHealthProbeInFlight) return;
  publicationHealthProbeInFlight = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const headers: Record<string, string> = {};
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    const response = await fetch(`${config.serverUrl}/workers/autoscale?ttlMs=15000`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as {
      publication?: SourceControlManagerPublicationHealth;
    };
    if (payload.publication) healthTracker.updatePublication(payload.publication);
  } catch {
    // A transient status-probe failure must not restart a healthy publisher.
  } finally {
    clearTimeout(timer);
    publicationHealthProbeInFlight = false;
  }
}

function startPublicationHealthPolling(): void {
  if (publicationHealthTimer) return;
  void refreshPublicationHealth();
  publicationHealthTimer = setInterval(
    () => void refreshPublicationHealth(),
    PUBLICATION_HEALTH_POLL_MS,
  );
}

const integrationMaintenanceIntervalMs = Math.max(
  10_000,
  Math.min(60_000, config.pollIntervalSeconds * 3_000),
);
const integrationMaintenanceRunner = new IntegrationMaintenanceRunner({
  gitOps,
  sessionId: statusSessionId,
  intervalMs: integrationMaintenanceIntervalMs,
});

const reviewAgentConfigPollMs = 3_000;
const syncReviewAgentRuntimeConfigSingleFlight = createSingleFlightExecutor(async () => {
  const latestConfig = applyCliOverrides(loadConfig({ reload: true }), cliOverrides);
  validateConfig(latestConfig);
  config.reviewAgent = { ...latestConfig.reviewAgent };
  config.prBaseBranch = latestConfig.prBaseBranch;
  config.gitToken = latestConfig.gitToken;

  if (!config.reviewAgent.enabled) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      "disabled",
      `[${ts()}] ReviewAgent disabled via runtime config (source_control_manager.review_agent.enabled=false).`,
    );
    return;
  }

  const runtimeReadiness = await probeReviewAgentRuntimeReadiness({
    serverUrl: config.serverUrl,
    sessionId: statusSessionId,
    authToken: config.authToken,
    timeoutMs: 2_500,
  });
  if (!runtimeReadiness.ready) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      `blocked:runtime_not_ready:${runtimeReadiness.detail}`,
      `[${ts()}] ReviewAgent waiting for embedded runtime readiness before polling PRs (${runtimeReadiness.detail}).`,
      "warn",
    );
    return;
  }

  const remoteUrlResult = await runGitCapture(
    ["-C", config.repoPath, "remote", "get-url", config.remote],
    repoRoot,
  );
  const remoteUrl = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "";
  if (!remoteUrl) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      "blocked:missing_remote",
      `[${ts()}] ReviewAgent enabled but could not resolve remote URL; waiting for runtime config or git remote changes before starting.`,
      "warn",
    );
    return;
  }

  const gitProviderToken = await resolveGitAuthToken(remoteUrl, config.gitToken ?? "");
  if (!gitProviderToken) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      "blocked:missing_token",
      `[${ts()}] ReviewAgent enabled but no git provider token found (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN); waiting for credentials before starting.`,
      "warn",
    );
    return;
  }

  const prBaseBranch = (config.prBaseBranch || integrationBaseBranch).trim();
  const fingerprint = JSON.stringify({
    serverUrl: config.serverUrl,
    remoteUrl,
    prBaseBranch,
    reviewAgent: config.reviewAgent,
    gitProviderToken,
  });
  if (
    reviewAgentInstance &&
    reviewAgentPollTimer &&
    reviewAgentRuntimeFingerprint === fingerprint
  ) {
    return;
  }

  clearReviewAgentPollLoop();
  const reviewAgent = new ReviewAgent(
    config.reviewAgent,
    config.serverUrl,
    gitProviderToken,
    remoteUrl,
    prBaseBranch,
    config.authToken,
  );
  reviewAgentInstance = reviewAgent;
  reviewAgentRuntimeFingerprint = fingerprint;
  reviewAgentPollTimer = setInterval(
    () =>
      reviewAgent.poll().catch((err: any) => {
        console.error(`[${ts()}] [ReviewAgent] Poll error: ${err?.message ?? err}`);
      }),
    config.reviewAgent.pollIntervalMs,
  );
  logReviewAgentRuntimeState(
    `running:${fingerprint}`,
    `[${ts()}] ReviewAgent started (poll interval: ${config.reviewAgent.pollIntervalMs}ms, pass threshold: ${config.reviewAgent.passThreshold}/10)`,
  );
  void reviewAgent.poll().catch((err: any) => {
    console.error(`[${ts()}] [ReviewAgent] Initial poll error: ${err?.message ?? err}`);
  });
});

function summarizeBranchNames(names: string[], max = 5): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, +${names.length - max} more`;
}

function createSessionComm(sessionId: string): CommunicationManager {
  return new CommunicationManager({
    serverUrl: config.serverUrl,
    sessionId,
    authToken: config.authToken,
    from: "agent:source_control_manager",
  });
}

async function ensureSessionWithRetry(
  sessionId: string,
  maxRetries = 10,
  baseDelayMs = 1000,
  maxDelayMs = 10000,
): Promise<boolean> {
  let attempt = 0;
  while (running) {
    attempt += 1;
    try {
      const response = await fetch(`${config.serverUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (response.ok) return true;
      throw new Error(`HTTP ${response.status}`);
    } catch (err: any) {
      if (attempt >= maxRetries) {
        console.warn(
          `[${ts()}] Could not ensure session "${sessionId}" for source_control_manager status events: ${err?.message ?? err}`,
        );
        return false;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await Bun.sleep(delayMs);
    }
  }
  return false;
}

async function emitStartupStatus(): Promise<void> {
  if (!startupStatusTracker.canEmitInitializing(running)) return;
  const sessionReady = await ensureSessionWithRetry(statusSessionId);
  if (!sessionReady) return;
  if (!startupStatusTracker.beginOnlineTransition()) return;
  statusSessionReady = true;
  const comm = createSessionComm(statusSessionId);
  const ok = await comm.status(
    "source_control_manager",
    "idle",
    "SourceControlManager online and monitoring completions",
  );
  if (!ok) {
    statusSessionReady = false;
    startupStatusTracker.revertOnlineTransition();
    console.warn(`[${ts()}] Failed to emit source_control_manager startup status event`);
  }
}

async function emitInitializingStatus(): Promise<void> {
  // Keep retrying in the background so UI gets an initializing signal even if
  // server/session startup races SourceControlManager boot checks.
  while (startupStatusTracker.canEmitInitializing(running) && !statusSessionReady) {
    const sessionReady = await ensureSessionWithRetry(statusSessionId, 6, 400, 2_500);
    if (!sessionReady) {
      await Bun.sleep(1_000);
      continue;
    }
    if (!startupStatusTracker.canEmitInitializing(running)) return;
    statusSessionReady = true;
    const comm = createSessionComm(statusSessionId);
    const ok = await comm.status(
      "source_control_manager",
      "idle",
      "SourceControlManager initializing startup checks",
    );
    if (ok) return;
    statusSessionReady = false;
    console.warn(`[${ts()}] Failed to emit source_control_manager initializing status event`);
    await Bun.sleep(1_000);
  }
}

function startStatusHeartbeat(): void {
  if (statusHeartbeatMs <= 0 || statusHeartbeatTimer) return;
  const comm = createSessionComm(statusSessionId);
  statusHeartbeatTimer = setInterval(() => {
    if (!running) return;
    void (async () => {
      if (!statusSessionReady) {
        statusSessionReady = await ensureSessionWithRetry(statusSessionId, 3, 400, 2500);
      }
      const ok = await comm.status(
        "source_control_manager",
        "idle",
        "SourceControlManager heartbeat",
      );
      if (!ok) {
        statusSessionReady = false;
      }
    })();
  }, statusHeartbeatMs);
}

function clearReviewAgentPollLoop(): void {
  if (reviewAgentPollTimer) {
    clearInterval(reviewAgentPollTimer);
    reviewAgentPollTimer = null;
  }
  reviewAgentInstance = null;
  reviewAgentRuntimeFingerprint = "";
}

function logReviewAgentRuntimeState(
  key: string,
  message: string,
  level: "log" | "warn" = "log",
): void {
  if (reviewAgentRuntimeStateKey === key) return;
  reviewAgentRuntimeStateKey = key;
  if (level === "warn") {
    console.warn(message);
    return;
  }
  console.log(message);
}

async function syncReviewAgentRuntimeConfig(): Promise<void> {
  await syncReviewAgentRuntimeConfigSingleFlight();
}

function startReviewAgentRuntimeConfigPolling(): void {
  if (reviewAgentConfigPollTimer) return;
  reviewAgentConfigPollTimer = setInterval(() => {
    if (!running) return;
    void syncReviewAgentRuntimeConfig().catch((err: any) => {
      const detail = err?.message ?? String(err);
      logReviewAgentRuntimeState(
        `config-error:${detail}`,
        `[${ts()}] ReviewAgent runtime config poll failed: ${detail}`,
        "warn",
      );
    });
  }, reviewAgentConfigPollMs);
}

async function emitPusherMessage(
  comm: CommunicationManager,
  text: string,
  correlationId: string,
  meta: Parameters<CommunicationManager["assistantMessage"]>[1] = {},
): Promise<void> {
  const ok = await comm.assistantMessage(text, { ...meta, correlationId });
  if (!ok) {
    console.error(`[${ts()}] Failed to emit source_control_manager message: ${text}`);
  }
}

async function tick(): Promise<void> {
  healthTracker.beginTick("integration_maintenance");
  try {
    const runtimeConfig = cloneSourceControlManagerConfigSnapshot(config);
    const reviewAgentForTick = reviewAgentInstance;
    // ── Poll Completion Queue ──────────────────────────────────────────
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (runtimeConfig.authToken) {
      headers["Authorization"] = `Bearer ${runtimeConfig.authToken}`;
    }

    const pusherId = sourceControlManagerPusherId;

    const response = await maintainIntegrationBeforeCompletionClaim({
      maintain: () => integrationMaintenanceRunner.run(runtimeConfig, headers),
      claimCompletion: () =>
        fetch(`${runtimeConfig.serverUrl}/completions/claim`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            pusherId,
            leaseMs: COMPLETION_LEASE_MS,
            reconcilePusher: reconcilePusherOnNextClaim,
          }),
        }),
    });
    reconcilePusherOnNextClaim = false;

    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[${ts()}] Failed to claim completion: ${response.status}`);
      }
      return;
    }

    const data = (await response.json()) as {
      ok: boolean;
      completion?: {
        id: string;
        jobId: string;
        sessionId: string;
        origin?: "user" | "autonomy";
        commitSha: string;
        branch: string;
        message: string;
        prUrl: string | null;
        prTitle: string | null;
        prBody: string | null;
        trustedValidationCommandsJson: string | null;
        trustedValidationSummary: string | null;
        trustedValidationDetail: string | null;
        status: string;
        pusherId: string;
        createdAt: string;
        updatedAt: string;
      };
      message?: string;
    };

    if (!data.ok || !data.completion) {
      return; // No completions available
    }

    const completion = data.completion;
    healthTracker.progress("completion_claimed", completion.id);
    const reviewPublicationLease = completion.branch.startsWith("refs/pushpals/review/")
      ? parseReviewPublicationLease(completion.prBody)
      : null;
    const isIntegrationReconciliationCompletion = Boolean(
      reviewPublicationLease &&
      reviewPublicationLease.targetBranch === runtimeConfig.mainBranch &&
      reviewPublicationLease.baseBranch === runtimeConfig.integrationBaseBranch,
    );
    const useReviewPublicationFlow = shouldUseReviewPublicationFlow(
      runtimeConfig.reviewAgent.enabled,
      reviewPublicationLease,
    );
    const comm = createSessionComm(completion.sessionId);
    const completionEventMeta =
      completion.origin === "autonomy"
        ? { from: "agent:source_control_manager/autonomy" }
        : undefined;
    const cleanupHiddenCompletionRef = completion.branch.startsWith("refs/pushpals/");
    console.log(
      `[${ts()}] Claimed completion ${completion.id}: ${completion.branch} (${completion.commitSha.slice(0, 8)})`,
    );
    if ((completion.prTitle ?? "").trim() || (completion.prBody ?? "").trim()) {
      console.log(
        `[${ts()}] Completion ${completion.id} includes worker-provided PR metadata; SourceControlManager will prefer it for PR creation.`,
      );
    }
    await emitPusherMessage(
      comm,
      `SourceControlManager claimed WorkerPal completion ${completion.id.slice(0, 8)} from ${completion.branch}.`,
      completion.id,
      completionEventMeta,
    );

    if (dryRun) {
      console.log(`[${ts()}] Dry run mode — skipping processing`);
      await emitPusherMessage(
        comm,
        `SourceControlManager is in dry-run mode, so completion ${completion.id.slice(0, 8)} was not applied.`,
        completion.id,
        completionEventMeta,
      );
      return;
    }

    // ── Process completion ─────────────────────────────────────────────
    let completionLeaseHeartbeatInFlight = false;
    let completionLeaseLost = false;
    const renewCompletionLease = async (required = false): Promise<boolean> => {
      if (completionLeaseHeartbeatInFlight) {
        if (!required) return !completionLeaseLost;
        const deadline = Date.now() + 6_000;
        while (completionLeaseHeartbeatInFlight && Date.now() < deadline) {
          await Bun.sleep(50);
        }
        if (completionLeaseHeartbeatInFlight || completionLeaseLost) {
          throw new Error("Completion publication lease heartbeat did not settle safely.");
        }
        return true;
      }
      completionLeaseHeartbeatInFlight = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const leaseResponse = await fetch(
          `${runtimeConfig.serverUrl}/completions/${completion.id}/lease/renew`,
          {
            method: "POST",
            headers,
            signal: controller.signal,
            body: JSON.stringify({ pusherId, leaseMs: COMPLETION_LEASE_MS }),
          },
        );
        if (!leaseResponse.ok) {
          if (leaseResponse.status === 400 || leaseResponse.status === 409) {
            completionLeaseLost = true;
          }
          if (required) {
            throw new Error(
              `Completion publication lease could not be renewed (HTTP ${leaseResponse.status}).`,
            );
          }
          return false;
        }
        completionLeaseLost = false;
        return true;
      } catch (error) {
        if (required) throw error;
        console.warn(
          `[${ts()}] Completion lease heartbeat failed for ${completion.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      } finally {
        clearTimeout(timer);
        completionLeaseHeartbeatInFlight = false;
      }
    };
    const completionLeaseHeartbeatTimer = setInterval(
      () => void renewCompletionLease(false),
      COMPLETION_LEASE_HEARTBEAT_MS,
    );
    let tempBranch = "";
    let cleanupCompletionHandoff = false;
    let trustedInstallDurationMs: number | null = null;
    let trustedValidationDurationMs: number | null = null;
    let trustedValidationCacheHit: boolean | null = null;
    let trustedValidationBaselineSha: string | null = null;
    let trustedValidationResults: TrustedValidationExecutionResult[] = [];
    const trustedValidationReport = (): TrustedValidationReport | null =>
      completion.trustedValidationCommandsJson
        ? {
            version: 1,
            baselineSha: trustedValidationBaselineSha,
            candidateSha: completion.commitSha,
            results: trustedValidationResults,
          }
        : null;
    try {
      let processedPrUrl: string | null =
        typeof completion.prUrl === "string" && completion.prUrl.trim().length > 0
          ? completion.prUrl.trim()
          : null;
      // 1. Refresh refs before applying completion commit/ref
      healthTracker.progress("refreshing_refs", completion.id);
      console.log(`[${ts()}] Refreshing refs before applying ${completion.branch}...`);
      await gitOps.fetchPrune();
      if (reviewPublicationLease) {
        let resolvedCompletionSha = await runGitCapture(
          ["-C", runtimeConfig.repoPath, "rev-parse", "--verify", completion.branch],
          repoRoot,
        );
        if (
          !resolvedCompletionSha.ok ||
          !reviewCompletionHandoffMatches(resolvedCompletionSha.stdout, completion.commitSha)
        ) {
          const fetchCompletionRef = await runGitCapture(
            [
              "-C",
              runtimeConfig.repoPath,
              "fetch",
              runtimeConfig.remote,
              `+${completion.branch}:${completion.branch}`,
            ],
            repoRoot,
          );
          if (!fetchCompletionRef.ok) {
            throw new Error(
              `Review completion ${completion.branch} was not available in the shared host repository and remote compatibility fetch failed: ${fetchCompletionRef.stderr || fetchCompletionRef.stdout}`,
            );
          }
          resolvedCompletionSha = await runGitCapture(
            ["-C", runtimeConfig.repoPath, "rev-parse", "--verify", completion.branch],
            repoRoot,
          );
        } else {
          console.log(
            `[${ts()}] Using immutable review completion ${completion.branch} from the shared host repository; no worker-side remote handoff was required.`,
          );
        }
        if (
          !resolvedCompletionSha.ok ||
          !reviewCompletionHandoffMatches(resolvedCompletionSha.stdout, completion.commitSha)
        ) {
          throw new Error(
            `Review completion ref ${completion.branch} did not resolve to expected commit ${completion.commitSha}.`,
          );
        }
      }

      // 2. Create temp branch and apply worker completion
      healthTracker.progress("applying_candidate", completion.id);
      tempBranch = `_source_control_manager/${completion.id}`;
      console.log(`[${ts()}] Creating temp branch ${tempBranch}...`);

      await gitOps.resetToClean();
      await gitOps.checkoutMain();
      await gitOps.pullMainFF();
      if (!isIntegrationReconciliationCompletion) {
        const baseSync = await gitOps.syncMainWithBaseBranch();
        if (baseSync.status === "conflicted") {
          throw new Error(
            `Integration reconciliation is active for ${runtimeConfig.mainBranch} and ${runtimeConfig.integrationBaseBranch}; conflicted paths: ${baseSync.conflictPaths.join(", ")}.`,
          );
        }
      }
      await gitOps.createTempBranch(tempBranch);
      trustedValidationBaselineSha = await gitOps.revParse("HEAD");
      let skipLocalApplyDueConflict = false;

      const applyResult = reviewPublicationLease
        ? await (async () => {
            console.log(
              `[${ts()}] Checking out exact reviewed completion ${completion.commitSha.slice(0, 8)} on ${tempBranch} for validation...`,
            );
            return runGitCapture(
              [
                "-C",
                runtimeConfig.repoPath,
                ...buildReviewCompletionValidationCheckoutArgs(tempBranch, completion.commitSha),
              ],
              repoRoot,
            );
          })()
        : runtimeConfig.mergeStrategy === "cherry-pick"
          ? await (async () => {
              console.log(
                `[${ts()}] Cherry-picking ${completion.commitSha.slice(0, 8)} onto ${tempBranch}...`,
              );
              return gitOps.cherryPickRef(completion.commitSha);
            })()
          : await (async () => {
              console.log(`[${ts()}] Merging ${completion.branch} into ${tempBranch}...`);
              return runtimeConfig.mergeStrategy === "no-ff"
                ? gitOps.mergeNoFF(completion.branch, `Merge ${completion.branch}`)
                : gitOps.mergeFFOnly(completion.branch);
            })();

      if (!applyResult.ok) {
        if (
          shouldBypassApplyFailureInReviewMode({
            reviewAgentEnabled: useReviewPublicationFlow,
            mergeStrategy: runtimeConfig.mergeStrategy,
            applyStdout: applyResult.stdout,
            applyStderr: applyResult.stderr,
          })
        ) {
          skipLocalApplyDueConflict = true;
          const applyDetail = applyResult.stderr || applyResult.stdout;
          console.warn(
            `[${ts()}] ReviewAgent mode - cherry-pick conflict while applying ${completion.commitSha.slice(0, 8)}; continuing with PR flow from worker branch commit.`,
          );
          await emitPusherMessage(
            comm,
            `ReviewAgent mode: local apply conflicted (${completion.commitSha.slice(0, 8)}), so SourceControlManager continued with branch-based PR flow. Detail: ${applyDetail}`,
            completion.id,
            completionEventMeta,
          );
          await gitOps.resetToClean();
        } else {
          throw new Error(`Apply failed: ${applyResult.stderr || applyResult.stdout}`);
        }
      }

      // 4. Run checks
      if (skipLocalApplyDueConflict) {
        if (completion.trustedValidationCommandsJson) {
          throw new Error(
            "Trusted validation cannot run because the candidate was not applied to the SourceControlManager validation branch.",
          );
        }
        console.warn(
          `[${ts()}] Skipping local checks for ${completion.commitSha.slice(0, 8)} because ReviewAgent fallback bypassed temp-branch apply.`,
        );
      } else {
        if (completion.trustedValidationCommandsJson) {
          healthTracker.progress("trusted_validation", completion.id);
          console.log(
            `[${ts()}] Running trusted-environment validation for ${completion.commitSha.slice(0, 8)}...`,
          );
          trustedValidationResults = await runTrustedValidationCommands({
            repoPath: runtimeConfig.repoPath,
            commandsJson: completion.trustedValidationCommandsJson,
          });
          for (const trustedResult of trustedValidationResults) {
            if (trustedResult.phase === "dependency_install") {
              trustedInstallDurationMs = (trustedInstallDurationMs ?? 0) + trustedResult.durationMs;
              trustedValidationCacheHit = Boolean(trustedResult.cached);
            } else {
              trustedValidationDurationMs =
                (trustedValidationDurationMs ?? 0) + trustedResult.durationMs;
            }
            const timing = `${trustedResult.durationMs}ms${trustedResult.cached ? ", cache hit" : ""}`;
            if (!trustedResult.ok) {
              throw new Error(
                `Trusted validation "${trustedResult.command}" failed after ${timing} (exit ${trustedResult.exitCode}): ${trustedResult.output}`,
              );
            }
            console.log(
              `[${ts()}]   - Trusted validation passed (${timing}): ${trustedResult.command}`,
            );
            console.log(
              `[${ts()}] trustedValidationTiming=${JSON.stringify({
                event: "trusted_validation_timing",
                jobId: completion.jobId,
                commitSha: completion.commitSha,
                command: trustedResult.command,
                phase: trustedResult.phase,
                durationMs: trustedResult.durationMs,
                cached: Boolean(trustedResult.cached),
              })}`,
            );
          }
        }
        console.log(`[${ts()}] Running checks...`);
        for (const check of runtimeConfig.checks) {
          console.log(`[${ts()}]   - Running check: ${check.name}`);
          const checkResult = await runCheck(runtimeConfig.repoPath, check);

          if (!checkResult.ok) {
            throw new Error(`Check "${check.name}" failed: ${checkResult.output}`);
          }

          console.log(`[${ts()}]   - Check passed: ${check.name}`);
        }
      }

      // 5. Merge to main OR create individual PR (ReviewAgent mode)
      healthTracker.progress("publication", completion.id);
      await renewCompletionLease(true);
      if (useReviewPublicationFlow) {
        // ReviewAgent mode: create individual PR from agent branch to prBaseBranch.
        // The agent branch already exists on remote (pushed by the worker).
        // Checks have passed; we skip merging into main_agents entirely.
        console.log(`[${ts()}] ReviewAgent mode - creating individual PR for ${completion.branch}`);
        const remoteUrlResult = await runGitCapture(
          ["-C", runtimeConfig.repoPath, "remote", "get-url", runtimeConfig.remote],
          repoRoot,
        );
        if (!remoteUrlResult.ok || !remoteUrlResult.stdout) {
          throw new Error(
            `Unable to resolve git remote URL for ${runtimeConfig.remote}: ${remoteUrlResult.stderr || remoteUrlResult.stdout}`,
          );
        }
        const token = await resolveGitAuthToken(
          remoteUrlResult.stdout.trim(),
          runtimeConfig.gitToken ?? "",
        );
        if (!token) {
          throw new Error(
            "No git provider token available for individual PR creation (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN).",
          );
        }

        const completionPrTitle = (completion.prTitle ?? "").trim();
        const resolvedHead = reviewPublicationLease
          ? { headBranch: reviewPublicationLease.targetBranch, requiresMaterialize: false }
          : deriveReviewPrHeadBranch(completion.branch, completion.id);
        let prHeadBranch = resolvedHead.headBranch;
        if (shouldPublishWithExactReviewLease(reviewPublicationLease)) {
          const prBaseBranch =
            reviewPublicationLease.baseBranch ??
            (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();
          if (reviewPublicationLease.expectedBaseSha) {
            const remoteBase = await runGitCapture(
              [
                "-C",
                runtimeConfig.repoPath,
                "rev-parse",
                `refs/remotes/${runtimeConfig.remote}/${prBaseBranch}`,
              ],
              repoRoot,
            );
            const actualBaseSha = remoteBase.ok ? remoteBase.stdout.trim().toLowerCase() : "";
            if (actualBaseSha !== reviewPublicationLease.expectedBaseSha) {
              throw new Error(
                `Review base ${prBaseBranch} moved from expected ${reviewPublicationLease.expectedBaseSha.slice(0, 8)} to ${actualBaseSha.slice(0, 8) || "unknown"}; refusing stale review publication.`,
              );
            }
          }
          console.log(
            `[${ts()}] Publishing reviewed completion ${completion.commitSha.slice(0, 8)} to ${prHeadBranch} with an exact force-with-lease.`,
          );
          const pushResult = await runGitCapture(
            [
              "-C",
              runtimeConfig.repoPath,
              ...buildReviewPublicationPushArgs({
                remote: runtimeConfig.remote,
                commitSha: completion.commitSha,
                lease: reviewPublicationLease,
              }),
            ],
            repoRoot,
          );
          if (!pushResult.ok) {
            throw new Error(
              `Failed exact-lease publication for review branch ${prHeadBranch}: ${pushResult.stderr || pushResult.stdout}`,
            );
          }
        } else if (resolvedHead.requiresMaterialize) {
          const publishRef = skipLocalApplyDueConflict ? completion.commitSha : "HEAD";
          console.log(
            `[${ts()}] ReviewAgent mode - materializing hidden completion ref ${completion.branch} -> refs/heads/${prHeadBranch}`,
          );
          let pushResult = await runGitCapture(
            [
              "-C",
              runtimeConfig.repoPath,
              "push",
              runtimeConfig.remote,
              `${publishRef}:refs/heads/${prHeadBranch}`,
            ],
            repoRoot,
          );
          if (!pushResult.ok) {
            const detail = `${pushResult.stderr}\n${pushResult.stdout}`.toLowerCase();
            const likelyNonFf =
              detail.includes("non-fast-forward") ||
              detail.includes("fetch first") ||
              detail.includes("rejected");
            if (likelyNonFf) {
              console.warn(
                `[${ts()}] Non-fast-forward while publishing ${prHeadBranch}; retrying with --force-with-lease`,
              );
              pushResult = await runGitCapture(
                [
                  "-C",
                  runtimeConfig.repoPath,
                  "push",
                  "--force-with-lease",
                  runtimeConfig.remote,
                  `${publishRef}:refs/heads/${prHeadBranch}`,
                ],
                repoRoot,
              );
            }
          }
          if (!pushResult.ok) {
            throw new Error(
              `Failed to publish review branch ${prHeadBranch}: ${pushResult.stderr || pushResult.stdout}`,
            );
          }
        }
        const commitSubject = await resolveCommitSubject(completion.commitSha);
        if (!commitSubject) {
          console.warn(
            `[${ts()}] ReviewAgent mode - could not resolve commit subject for ${completion.commitSha.slice(0, 8)}; falling back to completion/default PR title`,
          );
        }
        const prTitle = resolveReviewAgentPrTitle({
          commitSubject,
          completionPrTitle,
          prHeadBranch,
          integrationBaseBranch,
        });

        const completionPrBody = (completion.prBody ?? "").trim();
        const prBody = [
          completionPrBody || "Automated PR opened by SourceControlManager.",
          "",
          `- Agent branch: \`${prHeadBranch}\``,
          ...(prHeadBranch !== completion.branch
            ? [`- Completion ref: \`${completion.branch}\``]
            : []),
          `- Commit: \`${completion.commitSha}\``,
          `- Completion ID: \`${completion.id}\``,
          "",
          "<!-- DO NOT EDIT: ReviewAgent metadata below -->",
          `<!-- pushpals-jobId: ${completion.jobId} -->`,
          `<!-- pushpals-sessionId: ${completion.sessionId} -->`,
        ].join("\n");

        const remoteUrl = remoteUrlResult.stdout.trim();
        const prBaseBranch = (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();

        const pr = await ensureIntegrationPullRequest({
          token,
          remoteUrl,
          headBranch: prHeadBranch,
          baseBranch: prBaseBranch,
          title: prTitle,
          body: prBody,
          draft: false,
        });
        if (!pr.created) {
          reviewAgentForTick?.requestReReview(pr.number, completion.commitSha);
        }
        const prMessage = pr.created
          ? `Opened individual PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}`
          : `Reused existing PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}`;
        processedPrUrl = pr.htmlUrl;
        console.log(`[${ts()}] ${prMessage}`);
        await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
      } else {
        // Normal mode: merge temp branch into main_agents, push, open aggregated PR.
        console.log(`[${ts()}] Merging ${tempBranch} to ${runtimeConfig.mainBranch}...`);
        await gitOps.checkoutMain();
        const ffResult = await gitOps.mergeFFOnlyRef(tempBranch);

        if (!ffResult.ok) {
          throw new Error(`FF merge to main failed: ${ffResult.stderr || ffResult.stdout}`);
        }

        console.log(`[${ts()}] ✓ Successfully merged ${completion.branch} to ${config.mainBranch}`);
        if (config.pushMainAfterMerge) {
          console.log(`[${ts()}] Pushing ${config.mainBranch} to ${config.remote}...`);
          const pushResult = await gitOps.pushMain();
          if (!pushResult.ok) {
            throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
          }
          console.log(`[${ts()}] Push succeeded for ${config.mainBranch}`);
          if (config.openPrAfterPush) {
            try {
              const pr = await ensureMainPullRequest(completion, runtimeConfig);
              const prMessage = pr.created
                ? `Opened PR #${pr.number}: ${pr.htmlUrl}`
                : `Reused existing PR #${pr.number}: ${pr.htmlUrl}`;
              processedPrUrl = pr.htmlUrl;
              console.log(`[${ts()}] ${prMessage}`);
              await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
            } catch (prErr: any) {
              const warning = `Push succeeded, but PR auto-open failed: ${prErr?.message ?? prErr}`;
              console.error(`[${ts()}] ${warning}`);
              await emitPusherMessage(comm, warning, completion.id, completionEventMeta);
            }
          }
        } else {
          console.log(`[${ts()}] pushMainAfterMerge=false - skipping push`);
        }
      }

      // 6. Clean up temp branch
      await gitOps.deleteTempBranch(tempBranch);

      // 7. Mark completion as processed
      healthTracker.progress("completion_callback", completion.id);
      await renewCompletionLease(true);
      const markResponse = await fetch(
        `${config.serverUrl}/completions/${completion.id}/processed`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            pusherId,
            prUrl: processedPrUrl,
            trustedInstallDurationMs,
            trustedValidationDurationMs,
            trustedValidationCacheHit,
            trustedValidationReport: trustedValidationReport(),
          }),
        },
      );

      if (!markResponse.ok) {
        console.error(`[${ts()}] Failed to mark completion processed: ${markResponse.status}`);
      } else {
        console.log(`[${ts()}] Marked completion ${completion.id} as processed`);
        cleanupCompletionHandoff = true;
        const pushMessage = useReviewPublicationFlow
          ? skipLocalApplyDueConflict
            ? `Local apply/checks were bypassed for ${completion.commitSha.slice(0, 8)} due cherry-pick conflict; individual PR flow continued for ReviewAgent.`
            : `Checks passed for ${completion.commitSha.slice(0, 8)} from ${completion.branch}. Individual PR is ready for ReviewAgent review.`
          : config.pushMainAfterMerge
            ? `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} and pushed to ${config.remote}/${config.mainBranch}.`
            : `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} (push disabled).`;
        await emitPusherMessage(comm, pushMessage, completion.id, completionEventMeta);
      }
    } catch (err: any) {
      console.error(`[${ts()}] Failed to process completion ${completion.id}: ${err.message}`);

      // Mark completion as failed
      const failResponse = await fetch(`${config.serverUrl}/completions/${completion.id}/fail`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pusherId,
          error: err.message,
          trustedInstallDurationMs,
          trustedValidationDurationMs,
          trustedValidationCacheHit,
          trustedValidationReport: trustedValidationReport(),
        }),
      });

      if (!failResponse.ok) {
        console.error(`[${ts()}] Failed to mark completion failed: ${failResponse.status}`);
      }
      await emitPusherMessage(
        comm,
        `Failed to apply completion ${completion.id.slice(0, 8)} from ${completion.branch}: ${err.message}`,
        completion.id,
        completionEventMeta,
      );
    } finally {
      clearInterval(completionLeaseHeartbeatTimer);
      try {
        await gitOps.resetToClean();
      } catch (err: any) {
        console.warn(
          `[${ts()}] Failed to reset SourceControlManager worktree after completion ${completion.id}: ${err?.message ?? err}`,
        );
      }
      try {
        if (tempBranch && (await gitOps.revParse(tempBranch))) {
          await gitOps.deleteTempBranch(tempBranch);
        }
      } catch (err: any) {
        console.warn(
          `[${ts()}] Failed to delete temp branch ${tempBranch} during final cleanup: ${err?.message ?? err}`,
        );
      }
      if (cleanupHiddenCompletionRef && shouldCleanupCompletionHandoff(cleanupCompletionHandoff)) {
        if (reviewPublicationLease) {
          try {
            const deleteRemoteCompletionRef = await runGitCapture(
              ["-C", runtimeConfig.repoPath, "push", runtimeConfig.remote, `:${completion.branch}`],
              repoRoot,
            );
            if (!deleteRemoteCompletionRef.ok) {
              console.warn(
                `[${ts()}] Failed to clean remote review completion ref ${completion.branch}: ${deleteRemoteCompletionRef.stderr || deleteRemoteCompletionRef.stdout}`,
              );
            }
          } catch (err: any) {
            console.warn(
              `[${ts()}] Failed to clean remote review completion ref ${completion.branch}: ${err?.message ?? err}`,
            );
          }
        }
        try {
          await gitOps.deleteLocalRef(completion.branch);
        } catch (err: any) {
          console.warn(
            `[${ts()}] Failed to clean local completion ref ${completion.branch}: ${err?.message ?? err}`,
          );
        }
      } else if (cleanupHiddenCompletionRef) {
        console.warn(
          `[${ts()}] Retaining completion handoff ${completion.branch} because publication did not reach a confirmed processed state.`,
        );
      }
    }
  } catch (err: any) {
    console.error(`[${ts()}] Poll error: ${err.message}`);
  } finally {
    healthTracker.completeTick();
  }
}

// Helper function to run a check
async function runCheck(
  repoPath: string,
  check: CheckConfig,
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = check.timeoutMs ?? 300_000;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? ["cmd", "/c"] : ["sh", "-c"];

  const result = await runProcessWithTreeTimeout([...shell, check.command], {
    cwd: repoPath,
    timeoutMs,
  });
  return { ok: result.ok, output: result.output };
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`${question} [y/N]: `, (value) => resolveAnswer(value));
  });
  rl.close();

  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function runGitCapture(args: string[], cwd = repoRoot): Promise<GitCmdResult> {
  return runGitCommandCapture(cwd, args);
}

async function resolveGitAuthToken(
  remoteUrl: string,
  configuredToken = config.gitToken ?? "",
): Promise<string> {
  const resolved = await resolveGitTokenForRemote({
    remoteUrl,
    configuredToken,
    cwd: repoRoot,
  });
  return resolved.token;
}

async function resolveCommitSubject(commitSha: string): Promise<string> {
  const showResult = await runGitCapture(
    ["-C", config.repoPath, "show", "-s", "--format=%s", commitSha],
    repoRoot,
  );
  if (!showResult.ok) return "";
  return (showResult.stdout.split(/\r?\n/, 1)[0] ?? "").trim();
}

async function ensureMainPullRequest(
  completion: {
    id: string;
    commitSha: string;
    branch: string;
    prTitle?: string | null;
    prBody?: string | null;
  },
  runtimeConfig: SourceControlManagerConfig = config,
) {
  const remoteUrlResult = await runGitCapture(
    ["-C", runtimeConfig.repoPath, "remote", "get-url", runtimeConfig.remote],
    repoRoot,
  );
  if (!remoteUrlResult.ok || !remoteUrlResult.stdout) {
    throw new Error(
      `Unable to resolve git remote URL for ${runtimeConfig.remote}: ${
        remoteUrlResult.stderr || remoteUrlResult.stdout
      }`,
    );
  }
  const remoteUrl = remoteUrlResult.stdout.trim();
  const token = await resolveGitAuthToken(remoteUrl, runtimeConfig.gitToken ?? "");
  if (!token) {
    throw new Error(
      "No git provider token available for PR creation (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN).",
    );
  }

  const prBaseBranch = (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();
  const completionPrTitle = (completion.prTitle ?? "").trim();
  const completionPrBody = (completion.prBody ?? "").trim();
  const prTitleCandidate =
    completionPrTitle ||
    (runtimeConfig.prTitle ?? "").trim() ||
    `PushPals: merge ${runtimeConfig.mainBranch} into ${prBaseBranch}`;
  const prTitle = normalizePrTitleCandidate(prTitleCandidate);
  const prBody =
    completionPrBody ||
    (config.prBody ?? "").trim() ||
    [
      "Automated PR opened by SourceControlManager.",
      "",
      `- Integration branch: \`${runtimeConfig.mainBranch}\``,
      `- Base branch: \`${prBaseBranch}\``,
      `- Latest merged completion: \`${completion.id}\``,
      `- Latest commit: \`${completion.commitSha}\``,
      "",
      "Please review and merge manually.",
    ].join("\n");

  return ensureIntegrationPullRequest({
    token,
    remoteUrl,
    headBranch: runtimeConfig.mainBranch,
    baseBranch: prBaseBranch,
    title: prTitle,
    body: prBody,
    draft: runtimeConfig.prDraft,
  });
}

async function ensureDefaultSourceControlManagerWorktree(): Promise<void> {
  if (!usingDefaultRepoPath) return;

  const probe = await runGitCapture(["-C", config.repoPath, "rev-parse", "--is-inside-work-tree"]);
  if (probe.ok) return;

  mkdirSync(resolve(config.repoPath, ".."), { recursive: true });
  await runGitCapture(["worktree", "prune"]);

  const seedCandidates = [
    `${config.remote}/${config.mainBranch}`,
    config.mainBranch,
    integrationBaseRef,
    "HEAD",
  ];
  let seedRef = "HEAD";
  for (const ref of seedCandidates) {
    const exists = await runGitCapture(["rev-parse", "--verify", "--quiet", ref]);
    if (exists.ok) {
      seedRef = ref;
      break;
    }
  }

  let addResult = await runGitCapture(["worktree", "add", "--detach", config.repoPath, seedRef]);
  if (!addResult.ok) {
    const detail = `${addResult.stderr}\n${addResult.stdout}`.toLowerCase();
    if (detail.includes("already registered worktree")) {
      await runGitCapture(["worktree", "prune"]);
      addResult = await runGitCapture([
        "worktree",
        "add",
        "--force",
        "--detach",
        config.repoPath,
        seedRef,
      ]);
    }
  }

  if (!addResult.ok) {
    throw new Error(
      `Failed to create default source_control_manager worktree (${config.repoPath}) from ${seedRef}: ${
        addResult.stderr || addResult.stdout
      }`,
    );
  }

  console.log(
    `[${ts()}] Created default source_control_manager worktree: ${config.repoPath} (seed: ${seedRef})`,
  );
}

function ensureRepoPathIsIsolatedWorktree(): void {
  const rel = relative(repoRoot, config.repoPath).replace(/\\/g, "/");
  const insideRepoRoot = rel === "" || (!rel.startsWith("../") && !isAbsolute(rel));
  const insideWorktrees = rel === ".worktrees" || rel.startsWith(".worktrees/");
  if (insideRepoRoot && !insideWorktrees) {
    throw new Error(
      `Unsafe source_control_manager repoPath (${config.repoPath}). Use a dedicated worktree path (recommended: ${defaultSourceControlManagerRepoPath}) so your active workspace branch is never switched.`,
    );
  }
}

async function ensureIntegrationBranchExists(): Promise<void> {
  const remoteRef = `${config.remote}/${config.mainBranch}`;
  if (await gitOps.revParse(remoteRef)) return;

  console.warn(`[${ts()}] Integration branch ${remoteRef} does not exist.`);

  const autoCreate = config.autoCreateMainBranch;

  let approved = autoCreate;
  if (!approved) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        `Missing ${remoteRef}. Re-run interactively to approve creation, or set source_control_manager.auto_create_main_branch=true.`,
      );
    }

    approved = await promptYesNo(
      `Create ${config.mainBranch} from ${integrationBaseRef} and push ${config.mainBranch} to ${config.remote}?`,
    );
  }

  if (!approved) {
    throw new Error(`User declined creation of ${remoteRef}.`);
  }

  await gitOps.bootstrapMainBranchFromBase();
  console.log(
    `[${ts()}] Created ${remoteRef}; source_control_manager local integration branch is based on ${integrationBaseRef}.`,
  );
}

async function main(): Promise<void> {
  // Emit liveness early so UI doesn't stay "initializing" while startup checks run.
  void emitInitializingStatus();

  await ensureDefaultSourceControlManagerWorktree();
  ensureRepoPathIsIsolatedWorktree();
  // ── Startup safety check ──────────────────────────────────────────────
  // Skip source is already logged in the boot banner (mode: SKIP CLEAN CHECK).
  if (!skipCleanCheck) {
    // Ensure the repo is clean before we start. We don't run git clean -fd
    // during normal operation, so a dirty repo is a sign of misconfiguration.
    // Retry if `git status` itself fails (e.g. transient I/O error), but
    // always crash if the repo is genuinely dirty.
    let clean: boolean | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        clean = await gitOps.isRepoClean();
        break;
      } catch (err: any) {
        if (attempt >= 10) throw err; // give up after 10 tries
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
        console.error(
          `[${ts()}] git status failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
        );
        await Bun.sleep(delay);
      }
    }

    if (!clean) {
      console.error(
        `[${ts()}] ERROR: Repository at ${config.repoPath} has uncommitted or untracked changes.`,
      );
      console.error(`[${ts()}] SourceControlManager requires a dedicated clean clone. Exiting.`);
      console.error(`[${ts()}] WARNING: Do not run this daemon in a developer working copy.`);
      console.error(`[${ts()}] TIP: Pass --skip-clean-check to bypass this guard in dev.`);
      await shutdown();
      process.exit(1);
    }
    console.log(`[${ts()}] Repo is clean`);
  }

  await ensureIntegrationBranchExists();
  await emitStartupStatus();
  startStatusHeartbeat();
  startPublicationHealthPolling();

  await syncReviewAgentRuntimeConfig();
  startReviewAgentRuntimeConfigPolling();

  // ReviewAgent startup is managed by runtime config polling above.

  // Initial tick — retry on transient errors (e.g. remote unreachable)

  for (let attempt = 1; ; attempt++) {
    try {
      await tick();
      break;
    } catch (err: any) {
      if (attempt >= 10) throw err;
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30_000);
      console.error(
        `[${ts()}] Initial tick failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }

  // Polling loop
  while (running) {
    await Bun.sleep(config.pollIntervalSeconds * 1000);
    await tick();
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (!running) return;
    running = false;
    startupStatusTracker.markShutdown();
    console.log(`\n[${ts()}] Shutting down...`);
    if (statusHeartbeatTimer) {
      clearInterval(statusHeartbeatTimer);
      statusHeartbeatTimer = null;
    }
    if (publicationHealthTimer) {
      clearInterval(publicationHealthTimer);
      publicationHealthTimer = null;
    }
    if (reviewAgentConfigPollTimer) {
      clearInterval(reviewAgentConfigPollTimer);
      reviewAgentConfigPollTimer = null;
    }
    clearReviewAgentPollLoop();
    void createSessionComm(statusSessionId).status(
      "source_control_manager",
      "shutting_down",
      "SourceControlManager shutting down",
    );
    server?.stop();

    try {
      const cleanup = await gitOps.cleanupLocalTempBranches("_source_control_manager/");
      if (cleanup.removedWorktrees.length > 0) {
        console.log(
          `[${ts()}] Shutdown cleanup removed ${cleanup.removedWorktrees.length} temp worktree(s): ${summarizeBranchNames(
            cleanup.removedWorktrees,
          )}`,
        );
      }
      if (cleanup.deletedBranches.length > 0) {
        console.log(
          `[${ts()}] Shutdown cleanup removed ${cleanup.deletedBranches.length} temp branch(es): ${summarizeBranchNames(
            cleanup.deletedBranches,
          )}`,
        );
      }
      if (cleanup.failedBranches.length > 0) {
        console.warn(
          `[${ts()}] Shutdown cleanup failed to remove ${cleanup.failedBranches.length} temp branch(es): ${summarizeBranchNames(
            cleanup.failedBranches,
          )}`,
        );
      }
      for (const warning of cleanup.warnings) {
        console.warn(`[${ts()}] Shutdown cleanup warning: ${warning}`);
      }
    } catch (err: any) {
      console.warn(`[${ts()}] Shutdown temp-branch cleanup failed: ${err?.message ?? err}`);
    }

    db.close();
    lock.release();
    console.log(`[${ts()}] Goodbye.`);
  })();
  return shutdownPromise;
}

async function shutdownAndExit(code: number): Promise<void> {
  await shutdown();
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdownAndExit(130);
});
process.on("SIGTERM", () => {
  void shutdownAndExit(143);
});

// ─── Start ──────────────────────────────────────────────────────────────────

main().catch(async (err) => {
  console.error(`[${ts()}] Fatal: ${err.message}`);
  await shutdown();
  process.exit(1);
});
