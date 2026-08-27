import { parseArgs } from "util";
import { isAbsolute, join, relative, resolve } from "path";
import { mkdirSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { CommunicationManager } from "../../../packages/shared/src/communication.js";
import { loadPushPalsConfig } from "../../../packages/shared/src/config.js";
import {
  parseGitRemoteHost,
  resolveGitTokenForRemote,
} from "../../../packages/shared/src/git_backend.js";
import { fetchBufferedWithHardDeadline } from "../../../packages/shared/src/bounded_fetch.js";
import { createRepositoryAgentServiceClients } from "../../../packages/shared/src/repository_agent.js";
import { MergeQueueDB } from "./db";
import { FileLock } from "./lock";
import { createSourceControlApi, runGitCommandCapture, type SourceControlApi } from "./git";
import { ensureIntegrationPullRequest, isSupportedGitHubRemoteUrl } from "./github_pr";
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
  shouldPublishWithExactReviewLease,
  shouldUseReviewPublicationFlow,
} from "./review_publication";
import { normalizePrTitleCandidate, resolveReviewAgentPrTitle } from "./pr_title";
import { reviewApplyFailureBlocksPublication } from "./review_apply_fallback";
import {
  buildReviewAgentRuntimeFingerprint,
  cloneSourceControlManagerConfigSnapshot,
  createBlockedReviewProviderHealth,
  createStartupStatusTracker,
  createSourceControlManagerHealthTracker,
  createSingleFlightExecutor,
  probeReviewAgentRuntimeReadiness,
  withReviewProviderHealth,
  type SourceControlManagerPublicationHealth,
  type SourceControlManagerReviewProviderHealth,
} from "./runtime_helpers";
import { createStatusServer } from "./http";
import { resolveSourceControlManagerRuntimeRepoRoot } from "./runtime_paths";
import {
  parseCompletionPositiveAck,
  postCompletionCallbackWithRetry,
  postCompletionProcessedWithRetry,
} from "./completion_callback";
import {
  CompletionGcJournal,
  buildCompletionGcLocalDeleteArgs,
  buildCompletionGcRemoteDeleteArgs,
  claimBeforeCompletionGc,
  completionGcValidationNamespace,
  createCompletionGcRecord,
  reconcileCompletionGcJournal,
  type CompletionGcRecord,
  type CompletionProcessingAuthority,
} from "./completion_gc";
import {
  CompletionLeaseRenewalCoordinator,
  parseCompletionLeaseRenewalResponse,
} from "./completion_lease";
import {
  assertFinalAuthoritativePublicationProof,
  authoritativeAncestryFromGitResult,
  authoritativeRefShaFromGitResult,
  durablePublicationRecoveryState,
  isValidationCheckpointPublished,
  PublicationAuthorityUnreachableError,
  PublicationConfirmationPendingError,
  publicationFailureDisposition,
  publishWithAuthoritativeProof,
  shouldSkipValidationForDurableRecovery,
  type AuthoritativePublicationReprobe,
} from "./publication_recovery";
import {
  normalizeTrustedValidationAffectedPaths,
  resolveTrustedValidationOutcome,
  runProcessWithTreeTimeout,
  runTrustedValidationCommands,
  trustedValidationHealthPhase,
} from "./trusted_validation";
import {
  applyRetainedValidationCheckpoint,
  applyValidationRepairPublication,
  loadLatestValidationCheckpoint,
  parseValidationRepairPublicationLease,
  persistValidationCheckpoint,
  persistValidationSuccessProof,
  resolveValidationCheckpointBaseline,
  validationCheckpointRefs,
  type ValidationRepairPublicationLease,
} from "./validation_repair_publication";
import {
  assertExactCleanValidationWorktree,
  ValidationWorktreeInvariantError,
} from "./validation_worktree";
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
  idempotent?: boolean;
};

const PUSH_CONFIG = loadPushPalsConfig();
const repoRoot = resolveSourceControlManagerRuntimeRepoRoot(PUSH_CONFIG.projectRoot, process.cwd());
const defaultSourceControlManagerRepoPath = resolve(PUSH_CONFIG.sourceControlManager.repoPath);
const COMPLETION_LEASE_MS = 3 * 60_000;
const COMPLETION_LEASE_HEARTBEAT_MS = 30_000;
const PUBLICATION_HEALTH_POLL_MS = 10_000;
const SERVER_CONTROL_HTTP_TIMEOUT_MS = 5_000;
const COMPLETION_GC_RECORDS_PER_TICK = 1;
const COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS = 3_000;
const COMPLETION_GC_REMOTE_GIT_TIMEOUT_MS = 10_000;
const COMPLETION_GC_REFS_PER_RECORD_PER_TICK = 4;
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
  .slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`;
const repositoryServices = createRepositoryAgentServiceClients({
  serverUrl: config.serverUrl,
  callerService: "source_control_manager",
  callerInstanceId: sourceControlManagerPusherId,
  authToken: config.authToken,
});
const healthTracker = createSourceControlManagerHealthTracker({
  tickStallMs: SCM_TICK_STALL_MS,
  idleBacklogGraceMs: Math.max(30_000, config.pollIntervalSeconds * 3_000),
});
let reviewAgentInstance: ReviewAgent | null = null;
let blockedReviewProviderHealth: SourceControlManagerReviewProviderHealth | null = null;

function sourceControlManagerHealthSnapshot() {
  const reviewProvider =
    reviewAgentInstance?.getProviderHealthSnapshot() ?? blockedReviewProviderHealth;
  return withReviewProviderHealth(healthTracker.snapshot(), reviewProvider);
}

// Recover any jobs stuck in 'running' from a previous crash
const recovered = db.recoverStuckJobs();
if (recovered > 0) {
  console.log(`[${ts()}] Recovered ${recovered} stuck running job(s) -> queued`);
}

// ── Git Operations ─────────────────────────────────────────────────────────

const gitOps: SourceControlApi = createSourceControlApi(config);
const completionGcJournal = new CompletionGcJournal(config.stateDir);

// ── HTTP server ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof createStatusServer> | undefined;
try {
  server = createStatusServer(db, config.port, sourceControlManagerHealthSnapshot);
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
let statusSessionReady = false;
let shutdownPromise: Promise<void> | null = null;
const startupStatusTracker = createStartupStatusTracker();
let reviewAgentRuntimeStateKey = "startup";
let reviewAgentRuntimeFingerprint = "";
let reviewAgentProviderRetryKey = "";
let reviewAgentProviderRetryAfterMs = 0;
let reviewAgentProviderTokenCache: {
  key: string;
  token: string;
  expiresAtMs: number;
} | null = null;

async function refreshPublicationHealth(): Promise<void> {
  if (publicationHealthProbeInFlight) return;
  publicationHealthProbeInFlight = true;
  try {
    const headers: Record<string, string> = {};
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${config.serverUrl}/workers/autoscale?ttlMs=15000`,
      init: { headers },
      timeoutMs: 3_000,
      timeoutMessage: "SourceControlManager publication-health probe timed out after 3000ms",
    });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as {
      publication?: SourceControlManagerPublicationHealth;
    };
    if (payload.publication) healthTracker.updatePublication(payload.publication);
  } catch {
    // A transient status-probe failure must not restart a healthy publisher.
  } finally {
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
const reviewAgentProviderRetryBackoffMs = 30_000;
const reviewAgentProviderTokenCacheMs = 5 * 60_000;
const syncReviewAgentRuntimeConfigSingleFlight = createSingleFlightExecutor(async () => {
  const latestConfig = applyCliOverrides(loadConfig({ reload: true }), cliOverrides);
  validateConfig(latestConfig);
  config.reviewAgent = { ...latestConfig.reviewAgent };
  config.prBaseBranch = latestConfig.prBaseBranch;
  config.gitToken = latestConfig.gitToken;

  // Provider reconciliation must remain active even when AI review is disabled.
  // Only the AI review path depends on RemoteBuddy and WorkerPal readiness; the
  // lightweight closed-PR poll needs just provider and server connectivity.
  let aiReviewRuntimeReady = false;
  let aiReviewRuntimeDetail = "AI review is disabled";

  const remoteUrlResult = await runGitCapture(
    ["-C", config.repoPath, "remote", "get-url", config.remote],
    repoRoot,
  );
  const remoteUrl = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "";
  if (!remoteUrl) {
    blockedReviewProviderHealth = createBlockedReviewProviderHealth(
      "git remote URL could not be resolved",
    );
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      "blocked:missing_remote",
      `[${ts()}] PR outcome reconciliation could not resolve remote URL; waiting for runtime config or git remote changes before starting.`,
      "warn",
    );
    return;
  }

  if (!isSupportedGitHubRemoteUrl(remoteUrl)) {
    const remoteHost = parseGitRemoteHost(remoteUrl) || "unknown host";
    blockedReviewProviderHealth = createBlockedReviewProviderHealth(
      `unsupported git provider host: ${remoteHost}`,
    );
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      `blocked:unsupported_provider:${remoteHost}`,
      `[${ts()}] PR outcome reconciliation is unavailable for provider host ${remoteHost}; the current reconciler supports GitHub remotes only.`,
      "warn",
    );
    return;
  }

  const providerRetryKey = JSON.stringify({ remoteUrl, gitToken: config.gitToken ?? "" });
  const providerNowMs = Date.now();
  if (
    reviewAgentProviderRetryKey === providerRetryKey &&
    providerNowMs < reviewAgentProviderRetryAfterMs &&
    reviewAgentProviderRetryAfterMs - providerNowMs <= reviewAgentProviderRetryBackoffMs
  ) {
    return;
  }
  let gitProviderToken =
    reviewAgentProviderTokenCache?.key === providerRetryKey &&
    providerNowMs < reviewAgentProviderTokenCache.expiresAtMs &&
    reviewAgentProviderTokenCache.expiresAtMs - providerNowMs <= reviewAgentProviderTokenCacheMs
      ? reviewAgentProviderTokenCache.token
      : "";
  let resolvedProviderTokenFresh = false;
  if (!gitProviderToken) {
    gitProviderToken = await resolveGitAuthToken(remoteUrl, config.gitToken ?? "");
    resolvedProviderTokenFresh = true;
  }
  if (!gitProviderToken) {
    reviewAgentProviderTokenCache = null;
    reviewAgentProviderRetryKey = providerRetryKey;
    reviewAgentProviderRetryAfterMs = providerNowMs + reviewAgentProviderRetryBackoffMs;
    blockedReviewProviderHealth = createBlockedReviewProviderHealth(
      "git provider token is unavailable",
    );
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(
      "blocked:missing_token",
      `[${ts()}] PR outcome reconciliation has no git provider token (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN); waiting for credentials before starting.`,
      "warn",
    );
    return;
  }
  if (resolvedProviderTokenFresh) {
    reviewAgentProviderTokenCache = {
      key: providerRetryKey,
      token: gitProviderToken,
      expiresAtMs: providerNowMs + reviewAgentProviderTokenCacheMs,
    };
  }
  reviewAgentProviderRetryKey = "";
  reviewAgentProviderRetryAfterMs = 0;
  blockedReviewProviderHealth = null;

  if (config.reviewAgent.enabled) {
    const runtimeReadiness = await probeReviewAgentRuntimeReadiness({
      serverUrl: config.serverUrl,
      sessionId: statusSessionId,
      authToken: config.authToken,
      timeoutMs: 2_500,
    });
    aiReviewRuntimeReady = runtimeReadiness.ready;
    aiReviewRuntimeDetail = runtimeReadiness.detail;
  }

  const prBaseBranch = (config.prBaseBranch || integrationBaseBranch).trim();
  const effectiveReviewAgentConfig = {
    ...config.reviewAgent,
    enabled: config.reviewAgent.enabled && aiReviewRuntimeReady,
  };
  const fingerprint = buildReviewAgentRuntimeFingerprint({
    serverUrl: config.serverUrl,
    remoteUrl,
    prBaseBranch,
    branchPrefix: config.branchPrefix,
    reviewAgent: config.reviewAgent,
    gitProviderToken,
    serverAuthToken: config.authToken,
  });
  if (
    reviewAgentInstance &&
    reviewAgentPollTimer &&
    reviewAgentRuntimeFingerprint === fingerprint
  ) {
    const runtimeUpdate = reviewAgentInstance.updateRuntimeConfig(effectiveReviewAgentConfig);
    logReviewAgentRuntimeState(
      `running:${fingerprint}:ai:${effectiveReviewAgentConfig.enabled ? "ready" : "waiting"}`,
      effectiveReviewAgentConfig.enabled
        ? `[${ts()}] ReviewAgent AI review became ready without restarting provider reconciliation.`
        : config.reviewAgent.enabled
          ? `[${ts()}] ReviewAgent AI review is waiting for embedded runtime readiness without resetting provider reconciliation state (${aiReviewRuntimeDetail}).`
          : `[${ts()}] PR outcome reconciliation remains active while AI review is disabled.`,
    );
    if (runtimeUpdate.becameEnabled) {
      void reviewAgentInstance.poll().catch((err: any) => {
        console.error(
          `[${ts()}] [ReviewAgent] Readiness transition poll error: ${err?.message ?? err}`,
        );
      });
    }
    return;
  }

  await clearReviewAgentPollLoop();
  const reviewAgent = new ReviewAgent(
    effectiveReviewAgentConfig,
    config.serverUrl,
    gitProviderToken,
    remoteUrl,
    prBaseBranch,
    config.authToken,
    { repositoryServices },
    config.branchPrefix,
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
    effectiveReviewAgentConfig.enabled
      ? `[${ts()}] ReviewAgent started (poll interval: ${config.reviewAgent.pollIntervalMs}ms, pass threshold: ${config.reviewAgent.passThreshold}/10, branch prefix: ${config.branchPrefix})`
      : config.reviewAgent.enabled
        ? `[${ts()}] PR outcome reconciler started while AI review waits for embedded runtime readiness (${aiReviewRuntimeDetail}; poll interval: ${config.reviewAgent.pollIntervalMs}ms, branch prefix: ${config.branchPrefix})`
        : `[${ts()}] PR outcome reconciler started while AI review is disabled (poll interval: ${config.reviewAgent.pollIntervalMs}ms, branch prefix: ${config.branchPrefix})`,
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
      const response = await fetchBufferedWithHardDeadline({
        input: `${config.serverUrl}/sessions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        },
        timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
        timeoutMessage: `SourceControlManager session registration timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms`,
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

async function clearReviewAgentPollLoop(): Promise<void> {
  if (reviewAgentPollTimer) {
    clearInterval(reviewAgentPollTimer);
    reviewAgentPollTimer = null;
  }
  const retiringReviewAgent = reviewAgentInstance;
  reviewAgentInstance = null;
  reviewAgentRuntimeFingerprint = "";
  await retiringReviewAgent?.stopAndDrain();
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

async function resolveCompletionProcessingAuthority(
  runtimeConfig: SourceControlManagerConfig,
  headers: Record<string, string>,
  record: CompletionGcRecord,
): Promise<CompletionProcessingAuthority | null> {
  const response = await fetchBufferedWithHardDeadline({
    input: `${runtimeConfig.serverUrl}/completions/${encodeURIComponent(record.completionId)}/status`,
    init: { headers },
    timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
    timeoutMessage: `Completion ${record.completionId} status probe timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`completion status authority returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    ok?: boolean;
    completion?: CompletionProcessingAuthority;
  };
  if (!payload.ok || !payload.completion) {
    throw new Error("completion status authority returned a malformed response");
  }
  return payload.completion;
}

async function cleanupProcessedCompletionRefs(
  runtimeConfig: SourceControlManagerConfig,
  record: CompletionGcRecord,
): Promise<boolean> {
  const validationNamespace = completionGcValidationNamespace(record);
  const listed = await runGitCommandCapture(
    repoRoot,
    [
      "-C",
      runtimeConfig.repoPath,
      "for-each-ref",
      "--format=%(refname)",
      `${validationNamespace}/`,
      ...record.additionalValidationRefs,
    ],
    { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS },
  );
  if (!listed.ok) {
    throw new Error(
      `failed to list retained validation refs: ${listed.stderr || listed.stdout || `exit ${listed.exitCode}`}`,
    );
  }

  const additionalValidationRefSet = new Set(record.additionalValidationRefs);
  const validationRefs = [
    ...new Set(
      listed.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(
          (ref) => ref.startsWith(`${validationNamespace}/`) || additionalValidationRefSet.has(ref),
        ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const refsForThisTick = validationRefs.slice(0, COMPLETION_GC_REFS_PER_RECORD_PER_TICK);
  for (const ref of refsForThisTick) {
    const deleted = await runGitCommandCapture(
      repoRoot,
      ["-C", runtimeConfig.repoPath, "update-ref", "-d", ref],
      { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS },
    );
    if (!deleted.ok) {
      throw new Error(
        `failed to delete retained validation ref ${ref}: ${deleted.stderr || deleted.stdout || `exit ${deleted.exitCode}`}`,
      );
    }
  }
  if (validationRefs.length > refsForThisTick.length) {
    return false;
  }

  if (record.completionBranch.startsWith("refs/pushpals/")) {
    const resolvedLocal = authoritativeRefShaFromGitResult(
      await runGitCommandCapture(
        repoRoot,
        [
          "-C",
          runtimeConfig.repoPath,
          "rev-parse",
          "--verify",
          "--quiet",
          `${record.completionBranch}^{commit}`,
        ],
        { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS },
      ),
      record.completionBranch,
    );
    const localDeleteArgs = buildCompletionGcLocalDeleteArgs(record, resolvedLocal);
    if (resolvedLocal && !localDeleteArgs) {
      console.warn(
        `[${ts()}] Retained completion ref ${record.completionBranch} moved to ${resolvedLocal}; preserving its new owner instead of deleting it for processed completion ${record.completionId}.`,
      );
    }
    if (localDeleteArgs) {
      const deletedLocal = await runGitCommandCapture(
        repoRoot,
        ["-C", runtimeConfig.repoPath, ...localDeleteArgs],
        { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS },
      );
      if (!deletedLocal.ok) {
        throw new Error(
          `failed leased deletion of local completion ref ${record.completionBranch}: ${deletedLocal.stderr || deletedLocal.stdout || `exit ${deletedLocal.exitCode}`}`,
        );
      }
    }
  }

  if (record.remote) {
    const remoteOptions = {
      timeout: COMPLETION_GC_REMOTE_GIT_TIMEOUT_MS,
      ...(runtimeConfig.gitToken ? { githubToken: runtimeConfig.gitToken } : {}),
    };
    const remoteRefResult = await runGitCommandCapture(
      repoRoot,
      ["-C", runtimeConfig.repoPath, "ls-remote", "--refs", record.remote, record.completionBranch],
      remoteOptions,
    );
    if (!remoteRefResult.ok) {
      throw new Error(
        `failed to resolve remote completion ref ${record.completionBranch}: ${remoteRefResult.stderr || remoteRefResult.stdout || `exit ${remoteRefResult.exitCode}`}`,
      );
    }
    const remoteMatches = remoteRefResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 2))
      .filter((parts) => parts.length === 2 && parts[1] === record.completionBranch);
    if (remoteMatches.length > 1) {
      throw new Error(
        `remote returned multiple values for completion ref ${record.completionBranch}`,
      );
    }
    const resolvedRemote = remoteMatches[0]?.[0] ?? null;
    if (resolvedRemote && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(resolvedRemote)) {
      throw new Error(`remote returned an invalid SHA for ${record.completionBranch}`);
    }
    const remoteDeleteArgs = buildCompletionGcRemoteDeleteArgs(record, resolvedRemote);
    if (resolvedRemote && !remoteDeleteArgs) {
      console.warn(
        `[${ts()}] Remote completion ref ${record.completionBranch} moved to ${resolvedRemote}; preserving its new owner instead of deleting it for processed completion ${record.completionId}.`,
      );
    }
    if (remoteDeleteArgs) {
      const deletedRemote = await runGitCommandCapture(
        repoRoot,
        ["-C", runtimeConfig.repoPath, ...remoteDeleteArgs],
        remoteOptions,
      );
      if (!deletedRemote.ok) {
        throw new Error(
          `failed leased deletion of remote completion ref ${record.completionBranch}: ${deletedRemote.stderr || deletedRemote.stdout || `exit ${deletedRemote.exitCode}`}`,
        );
      }
    }
  }
  return true;
}

async function reconcileRetainedCompletionRefs(
  runtimeConfig: SourceControlManagerConfig,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const result = await reconcileCompletionGcJournal({
      journal: completionGcJournal,
      limit: COMPLETION_GC_RECORDS_PER_TICK,
      resolveAuthority: (record) =>
        resolveCompletionProcessingAuthority(runtimeConfig, headers, record),
      cleanup: (record) => cleanupProcessedCompletionRefs(runtimeConfig, record),
      onWarning: (message) => console.warn(`[${ts()}] ${message}`),
    });
    if (result.cleaned > 0) {
      console.log(
        `[${ts()}] Reconciled ${result.cleaned} processed completion ref handoff(s); examined=${result.examined} retained=${result.retained} uncertain=${result.uncertain}.`,
      );
    }
  } catch (error) {
    console.warn(
      `[${ts()}] Completion ref GC pass failed safely; publication polling will continue: ${error instanceof Error ? error.message : String(error)}`,
    );
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

    const response = await claimBeforeCompletionGc({
      claim: () =>
        maintainIntegrationBeforeCompletionClaim({
          maintain: () => integrationMaintenanceRunner.run(runtimeConfig, headers),
          claimCompletion: async () => {
            const rawResponse = await fetchBufferedWithHardDeadline({
              input: `${runtimeConfig.serverUrl}/completions/claim`,
              init: {
                method: "POST",
                headers,
                body: JSON.stringify({
                  pusherId,
                  leaseMs: COMPLETION_LEASE_MS,
                }),
              },
              timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
              timeoutMessage: `Completion claim timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`,
            });
            return {
              ok: rawResponse.ok,
              status: rawResponse.status,
              data: rawResponse.ok ? await rawResponse.json() : null,
            };
          },
        }),
      isIdle: (claimResult) =>
        claimResult.status === 404 ||
        (claimResult.ok &&
          !(
            claimResult.data as
              | { ok?: boolean; completion?: Record<string, unknown> }
              | null
              | undefined
          )?.completion),
      reconcile: () => reconcileRetainedCompletionRefs(runtimeConfig, headers),
    });

    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[${ts()}] Failed to claim completion: ${response.status}`);
      }
      return;
    }

    const data = response.data as {
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
        claimToken: string;
        claimGeneration: number;
        createdAt: string;
        updatedAt: string;
      };
      message?: string;
    };

    if (!data.ok || !data.completion) {
      return; // No completions available
    }

    const completion = data.completion;
    const completionClaimToken = String(completion.claimToken ?? "").trim();
    const completionClaimGeneration = Number(completion.claimGeneration);
    if (
      !completionClaimToken ||
      !Number.isSafeInteger(completionClaimGeneration) ||
      completionClaimGeneration < 1
    ) {
      throw new Error(
        `Claimed completion ${completion.id} did not include a valid fencing token/generation; refusing publication.`,
      );
    }
    healthTracker.progress("completion_claimed", completion.id);
    const reviewPublicationLease = completion.branch.startsWith("refs/pushpals/review/")
      ? parseReviewPublicationLease(completion.prBody)
      : null;
    let validationRepairPublicationLease: ValidationRepairPublicationLease | null = null;
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
    const completionLeaseRenewal = new CompletionLeaseRenewalCoordinator(async () => {
      const leaseResponse = await fetchBufferedWithHardDeadline({
        input: `${runtimeConfig.serverUrl}/completions/${completion.id}/lease/renew`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({
            pusherId,
            claimToken: completionClaimToken,
            leaseMs: COMPLETION_LEASE_MS,
          }),
        },
        timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
        timeoutMessage: `Completion publication lease renewal timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`,
      });
      return parseCompletionLeaseRenewalResponse(leaseResponse);
    });
    const renewCompletionLease = async (required = false): Promise<boolean> => {
      const renewed = await completionLeaseRenewal.renew(required);
      if (!renewed && !required) {
        console.warn(
          `[${ts()}] Completion lease heartbeat failed for ${completion.id}: ${
            completionLeaseRenewal.failureDetail() ?? "renewal was not confirmed"
          }`,
        );
      }
      return renewed;
    };
    const requireCompletionLease = async (operation: string): Promise<void> => {
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(
          `Completion publication lease was lost before ${operation}; refusing stale-owner mutation.`,
        );
      }
      await renewCompletionLease(true);
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(
          `Completion publication lease was lost before ${operation}; refusing stale-owner mutation.`,
        );
      }
    };
    const completionLeaseHeartbeatTimer = setInterval(
      () => void renewCompletionLease(false),
      COMPLETION_LEASE_HEARTBEAT_MS,
    );
    let tempBranch = "";
    let cleanupCompletionHandoff = false;
    let completionGcRecord: CompletionGcRecord | null = null;
    let trustedInstallDurationMs: number | null = null;
    let trustedValidationDurationMs: number | null = null;
    let trustedValidationCacheHit: boolean | null = null;
    let trustedValidationBaselineSha: string | null = null;
    let trustedValidationCandidateSha: string | null = null;
    let trustedValidationCandidateRef: string | null = null;
    let trustedValidationAffectedPaths: string[] = [];
    let trustedValidationResults: TrustedValidationExecutionResult[] = [];
    let publicationAlreadyIntegrated = false;
    let publicationReadyForFinalization = false;
    let validationCheckpointPersisted = false;
    let validationSuccessProven = false;
    let skipValidationForDurableRecovery = false;
    let validationCheckpointGeneration = completionClaimGeneration;
    let validationWorktreeInvariantFailed = false;
    let validatedCheckpointRecoveryPending = false;
    let previousValidationCheckpoint: Awaited<ReturnType<typeof loadLatestValidationCheckpoint>> =
      null;
    const completionValidationRefs = validationCheckpointRefs(
      completion.id,
      completionClaimGeneration,
    );
    const trustedValidationReport = (): TrustedValidationReport | null =>
      completion.trustedValidationCommandsJson
        ? {
            version: 1,
            baselineSha: trustedValidationBaselineSha,
            candidateSha: trustedValidationCandidateSha,
            candidateRef: trustedValidationCandidateRef,
            results: trustedValidationResults,
          }
        : null;
    const persistExactValidationCheckpoint = async (): Promise<void> => {
      if (
        validationCheckpointPersisted ||
        !trustedValidationBaselineSha ||
        !trustedValidationCandidateSha
      ) {
        return;
      }
      const checkpoint = await persistValidationCheckpoint({
        completionId: completion.id,
        claimGeneration: completionClaimGeneration,
        baselineSha: trustedValidationBaselineSha,
        candidateSha: trustedValidationCandidateSha,
        git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot),
      });
      trustedValidationCandidateRef = checkpoint.candidateRef;
      validationCheckpointPersisted = true;
      validationCheckpointGeneration = completionClaimGeneration;
    };
    const validationGit = (gitArgs: string[]) =>
      runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot);
    const probeAuthoritativeRefSha = async (ref: string): Promise<string | null> =>
      authoritativeRefShaFromGitResult(
        await validationGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
        ref,
      );
    const probeAuthoritativeAncestry = async (
      ancestor: string,
      descendant: string,
    ): Promise<boolean> =>
      authoritativeAncestryFromGitResult(
        await validationGit(["merge-base", "--is-ancestor", ancestor, descendant]),
        `${ancestor} -> ${descendant}`,
      );
    const assertValidationWorktree = async (phase: string): Promise<void> => {
      try {
        await assertExactCleanValidationWorktree({
          expectedSha: trustedValidationCandidateSha ?? "",
          phase,
          git: validationGit,
        });
      } catch (error) {
        if (error instanceof ValidationWorktreeInvariantError) {
          validationWorktreeInvariantFailed = true;
        }
        throw error;
      }
    };
    const proveValidatedCandidatePublished = async (): Promise<boolean> => {
      if (!validationSuccessProven || !trustedValidationCandidateSha) return false;
      if (useReviewPublicationFlow || runtimeConfig.pushMainAfterMerge) {
        await gitOps.fetchPrune();
      }
      const reviewHeadBranch = useReviewPublicationFlow
        ? (reviewPublicationLease?.targetBranch ??
          deriveReviewPrHeadBranch(completion.branch, completion.id).headBranch)
        : null;
      const reviewRemoteHeadSha = reviewHeadBranch
        ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${reviewHeadBranch}`)
        : null;
      const remoteIntegrationHeadSha =
        !useReviewPublicationFlow && runtimeConfig.pushMainAfterMerge
          ? await probeAuthoritativeRefSha(
              `refs/remotes/${runtimeConfig.remote}/${runtimeConfig.mainBranch}`,
            )
          : null;
      const localIntegrationHeadSha =
        !useReviewPublicationFlow && !runtimeConfig.pushMainAfterMerge
          ? await probeAuthoritativeRefSha(`refs/heads/${runtimeConfig.mainBranch}`)
          : null;
      return isValidationCheckpointPublished({
        candidateSha: trustedValidationCandidateSha,
        localIntegrationHeadSha,
        remoteIntegrationHeadSha,
        reviewRemoteHeadSha,
        pushMainAfterMerge: runtimeConfig.pushMainAfterMerge,
        useReviewPublicationFlow,
        isAncestor: probeAuthoritativeAncestry,
      });
    };
    const markPublicationDurable = (): void => {
      const recoveryState = durablePublicationRecoveryState(true);
      publicationAlreadyIntegrated = recoveryState.skipPublicationMutation;
      publicationReadyForFinalization = recoveryState.protectFromTerminalFailure;
    };
    const confirmLeaseAfterPublication = async (operation: string): Promise<void> => {
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(
          `Completion publication became durable during ${operation}, but this owner lost its lease; leaving finalization to the current owner.`,
        );
      }
      await renewCompletionLease(true);
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(
          `Completion publication became durable during ${operation}, but this owner lost its lease; leaving finalization to the current owner.`,
        );
      }
    };
    try {
      validationRepairPublicationLease = parseValidationRepairPublicationLease(completion.prBody);
      if (validationRepairPublicationLease && reviewPublicationLease) {
        throw new Error(
          "Completion contains conflicting review and validation-repair publication leases.",
        );
      }
      previousValidationCheckpoint = await loadLatestValidationCheckpoint({
        completionId: completion.id,
        beforeClaimGeneration: completionClaimGeneration,
        git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot),
      });
      validatedCheckpointRecoveryPending = previousValidationCheckpoint?.validationProven === true;
      let processedPrUrl: string | null =
        typeof completion.prUrl === "string" && completion.prUrl.trim().length > 0
          ? completion.prUrl.trim()
          : null;
      // 1. Refresh refs before applying completion commit/ref
      healthTracker.progress("refreshing_refs", completion.id);
      console.log(`[${ts()}] Refreshing refs before applying ${completion.branch}...`);
      try {
        await gitOps.fetchPrune();
      } catch (error) {
        // A prior validated checkpoint may represent an accepted push whose
        // response was lost. Do not terminally fail it merely because the
        // authority is still unreachable on the next lease generation.
        throw error;
      }
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
      trustedValidationBaselineSha = await probeAuthoritativeRefSha("HEAD");
      if (!trustedValidationBaselineSha) {
        throw new Error("SourceControlManager worktree has no authoritative HEAD commit.");
      }
      let retainedCheckpointApplyResult: GitCmdResult | null = null;
      if (previousValidationCheckpoint?.validationProven) {
        validationSuccessProven = true;
        trustedValidationCandidateSha = previousValidationCheckpoint.candidateSha;
        const checkpointHead = useReviewPublicationFlow
          ? (reviewPublicationLease?.targetBranch ??
            deriveReviewPrHeadBranch(completion.branch, completion.id).headBranch)
          : null;
        const reviewRemoteHeadSha = checkpointHead
          ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${checkpointHead}`)
          : null;
        const remoteIntegrationHeadSha =
          !useReviewPublicationFlow && runtimeConfig.pushMainAfterMerge
            ? await probeAuthoritativeRefSha(
                `refs/remotes/${runtimeConfig.remote}/${runtimeConfig.mainBranch}`,
              )
            : null;
        const checkpointPublished = await isValidationCheckpointPublished({
          candidateSha: previousValidationCheckpoint.candidateSha,
          localIntegrationHeadSha: trustedValidationBaselineSha,
          remoteIntegrationHeadSha,
          reviewRemoteHeadSha,
          pushMainAfterMerge: runtimeConfig.pushMainAfterMerge,
          useReviewPublicationFlow,
          isAncestor: probeAuthoritativeAncestry,
        });
        // Authority was reachable and gave a definitive answer. From here,
        // replay/apply failures are real repair failures, not uncertainty from
        // the earlier publication attempt.
        validatedCheckpointRecoveryPending = false;
        if (
          shouldSkipValidationForDurableRecovery({
            validationProven: previousValidationCheckpoint.validationProven,
            publicationProven: checkpointPublished,
          })
        ) {
          const recoveryState = durablePublicationRecoveryState(true);
          const restoreCheckpoint = await runGitCapture(
            [
              "-C",
              runtimeConfig.repoPath,
              "checkout",
              "-B",
              tempBranch,
              previousValidationCheckpoint.candidateSha,
            ],
            repoRoot,
          );
          if (!restoreCheckpoint.ok) {
            throw new Error(
              `Failed to restore exact trusted-validation checkpoint ${previousValidationCheckpoint.candidateRef}: ${restoreCheckpoint.stderr || restoreCheckpoint.stdout}`,
            );
          }
          trustedValidationBaselineSha = previousValidationCheckpoint.baselineSha;
          trustedValidationCandidateSha = previousValidationCheckpoint.candidateSha;
          trustedValidationCandidateRef = previousValidationCheckpoint.candidateRef;
          validationCheckpointPersisted = true;
          validationCheckpointGeneration = previousValidationCheckpoint.claimGeneration;
          skipValidationForDurableRecovery = true;
          publicationAlreadyIntegrated = recoveryState.skipPublicationMutation;
          publicationReadyForFinalization = recoveryState.protectFromTerminalFailure;
          retainedCheckpointApplyResult = {
            ok: true,
            stdout: "Reused already-published immutable validation checkpoint.",
            stderr: "",
            exitCode: 0,
          };
          console.log(
            `[${ts()}] Reusing already-published trusted-validation checkpoint ${previousValidationCheckpoint.candidateSha.slice(0, 8)} without duplicate mutation.`,
          );
        } else {
          validationSuccessProven = false;
          trustedValidationCandidateSha = null;
          retainedCheckpointApplyResult = await applyRetainedValidationCheckpoint({
            baselineSha: previousValidationCheckpoint.baselineSha,
            candidateSha: previousValidationCheckpoint.candidateSha,
            currentIntegrationSha: trustedValidationBaselineSha ?? "",
            git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot),
          });
          console.log(
            `[${ts()}] Replayed exact retained checkpoint ${previousValidationCheckpoint.candidateRef} onto the current integration head.`,
          );
        }
      } else if (previousValidationCheckpoint) {
        retainedCheckpointApplyResult = await applyRetainedValidationCheckpoint({
          baselineSha: previousValidationCheckpoint.baselineSha,
          candidateSha: previousValidationCheckpoint.candidateSha,
          currentIntegrationSha: trustedValidationBaselineSha ?? "",
          git: validationGit,
        });
        console.log(
          `[${ts()}] Replayed unvalidated retained checkpoint ${previousValidationCheckpoint.candidateRef}; validation-success proof is required before publication.`,
        );
      }

      const applyResult = retainedCheckpointApplyResult
        ? retainedCheckpointApplyResult
        : reviewPublicationLease
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
          : validationRepairPublicationLease
            ? await (async () => {
                console.log(
                  `[${ts()}] Applying exact validation-repair chain ${validationRepairPublicationLease.baselineSha.slice(0, 8)} -> ${validationRepairPublicationLease.candidateSha.slice(0, 8)} -> ${completion.commitSha.slice(0, 8)} for incident ${validationRepairPublicationLease.incidentId}...`,
                );
                return applyValidationRepairPublication({
                  lease: validationRepairPublicationLease,
                  completionSha: completion.commitSha,
                  currentIntegrationSha: trustedValidationBaselineSha ?? "",
                  git: (gitArgs) =>
                    runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot),
                });
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
          !validationRepairPublicationLease &&
          useReviewPublicationFlow &&
          reviewApplyFailureBlocksPublication({
            reviewAgentEnabled: useReviewPublicationFlow,
            mergeStrategy: runtimeConfig.mergeStrategy,
            applyStdout: applyResult.stdout,
            applyStderr: applyResult.stderr,
          })
        ) {
          throw new Error(
            `Review candidate apply failed; publication is blocked until the exact candidate can be prepared and checked: ${applyResult.stderr || applyResult.stdout}`,
          );
        }
        throw new Error(`Apply failed: ${applyResult.stderr || applyResult.stdout}`);
      }
      if (!trustedValidationCandidateSha) {
        trustedValidationCandidateSha = await gitOps.revParse("HEAD");
        if (!trustedValidationCandidateSha) {
          throw new Error("Unable to capture the exact applied candidate SHA before validation.");
        }
      }
      if ("idempotent" in applyResult && applyResult.idempotent) {
        // Patch equivalence proves only that the candidate is present in this
        // local checkout. It does not prove a prior remote push/PR publication;
        // only the remote-authoritative checks above may suppress publication.
        if (previousValidationCheckpoint) {
          trustedValidationBaselineSha = previousValidationCheckpoint.baselineSha;
        } else if (validationRepairPublicationLease) {
          trustedValidationBaselineSha = validationRepairPublicationLease.baselineSha;
        }
      }
      if (
        trustedValidationBaselineSha &&
        trustedValidationCandidateSha &&
        !(await gitOps.isAncestor(trustedValidationBaselineSha, trustedValidationCandidateSha))
      ) {
        trustedValidationBaselineSha = await resolveValidationCheckpointBaseline({
          preApplyBaselineSha: trustedValidationBaselineSha,
          candidateSha: trustedValidationCandidateSha,
          git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot),
        });
      }
      await persistExactValidationCheckpoint();

      if (
        !skipValidationForDurableRecovery &&
        completion.trustedValidationCommandsJson &&
        trustedValidationBaselineSha &&
        trustedValidationCandidateSha
      ) {
        const affectedPathDiff = await validationGit([
          "diff",
          "--name-only",
          "-z",
          trustedValidationBaselineSha,
          trustedValidationCandidateSha,
          "--",
        ]);
        if (!affectedPathDiff.ok) {
          throw new Error(
            `Unable to derive trusted-validation affected paths for the immutable candidate: ${affectedPathDiff.stderr || affectedPathDiff.stdout}`,
          );
        }
        trustedValidationAffectedPaths = normalizeTrustedValidationAffectedPaths(
          affectedPathDiff.stdout.split("\0"),
        );
      }

      // 4. Run checks against the exact immutable candidate. A durable success
      // proof plus authoritative publication proof is the only recovery path
      // allowed to skip re-running mutable validation.
      if (skipValidationForDurableRecovery) {
        await assertValidationWorktree("published recovery");
        console.log(
          `[${ts()}] Exact candidate ${trustedValidationCandidateSha?.slice(0, 8)} already has immutable validation-success and publication proof; skipping duplicate validation.`,
        );
      } else {
        await assertValidationWorktree("before trusted validation");
        if (completion.trustedValidationCommandsJson) {
          healthTracker.progress("trusted_validation", completion.id);
          console.log(
            `[${ts()}] Running trusted-environment validation for ${completion.commitSha.slice(0, 8)}...`,
          );
          trustedValidationResults = await runTrustedValidationCommands({
            repoPath: runtimeConfig.repoPath,
            commandsJson: completion.trustedValidationCommandsJson,
            invariantContext:
              trustedValidationBaselineSha && trustedValidationCandidateSha
                ? {
                    baseSha: trustedValidationBaselineSha,
                    affectedPaths: trustedValidationAffectedPaths,
                  }
                : undefined,
            onProgress: (event) =>
              healthTracker.progress(trustedValidationHealthPhase(event), completion.id),
          });
          const validationOutcome = resolveTrustedValidationOutcome(trustedValidationResults);
          const terminalResults = new Set(validationOutcome.terminalResults);
          for (const trustedResult of trustedValidationResults) {
            if (trustedResult.phase === "dependency_install") {
              trustedInstallDurationMs = (trustedInstallDurationMs ?? 0) + trustedResult.durationMs;
              trustedValidationCacheHit = Boolean(trustedResult.cached);
            } else {
              trustedValidationDurationMs =
                (trustedValidationDurationMs ?? 0) + trustedResult.durationMs;
            }
            const timing = `${trustedResult.durationMs}ms${trustedResult.cached ? ", cache hit" : ""}`;
            console.log(
              `[${ts()}] trustedValidationTiming=${JSON.stringify({
                event: "trusted_validation_timing",
                jobId: completion.jobId,
                commitSha: completion.commitSha,
                command: trustedResult.command,
                phase: trustedResult.phase,
                durationMs: trustedResult.durationMs,
                cached: Boolean(trustedResult.cached),
                ok: trustedResult.ok,
                attempt: trustedResult.attempt ?? 1,
                retryReason: trustedResult.retryReason ?? null,
              })}`,
            );
            if (trustedResult.ok) {
              console.log(
                `[${ts()}]   - Trusted validation passed (${timing}, attempt ${trustedResult.attempt ?? 1}): ${trustedResult.command}`,
              );
            } else if (!terminalResults.has(trustedResult)) {
              console.warn(
                `[${ts()}]   - Trusted validation attempt ${trustedResult.attempt ?? 1} failed after ${timing} and was retried: ${trustedResult.command}`,
              );
            }
          }
          if (validationOutcome.terminalFailure) {
            const trustedResult = validationOutcome.terminalFailure;
            const timing = `${trustedResult.durationMs}ms${trustedResult.cached ? ", cache hit" : ""}`;
            throw new Error(
              `Trusted validation "${trustedResult.command}" failed after ${timing} (exit ${trustedResult.exitCode}): ${trustedResult.output}`,
            );
          }
          await assertValidationWorktree("after trusted validation");
        }
        console.log(`[${ts()}] Running checks...`);
        for (const check of runtimeConfig.checks) {
          console.log(`[${ts()}]   - Running check: ${check.name}`);
          const checkResult = await runCheck(runtimeConfig.repoPath, check);

          if (!checkResult.ok) {
            throw new Error(`Check "${check.name}" failed: ${checkResult.output}`);
          }

          console.log(`[${ts()}]   - Check passed: ${check.name}`);
          await assertValidationWorktree(`after check ${check.name}`);
        }
        await assertValidationWorktree("after all checks");
        await persistValidationSuccessProof({
          completionId: completion.id,
          claimGeneration: validationCheckpointGeneration,
          candidateSha: trustedValidationCandidateSha ?? "",
          git: validationGit,
        });
        validationSuccessProven = true;

        // A worker may have pre-created a remote review branch. It is not
        // publication proof until the exact tree has crossed validation. Once
        // both proofs exist, publication can be recovered without mutation.
        if (await proveValidatedCandidatePublished()) {
          const recoveryState = durablePublicationRecoveryState(true);
          publicationAlreadyIntegrated = recoveryState.skipPublicationMutation;
          publicationReadyForFinalization = recoveryState.protectFromTerminalFailure;
          console.log(
            `[${ts()}] Exact validated candidate ${trustedValidationCandidateSha?.slice(0, 8)} is already durable on its authoritative publication ref.`,
          );
        }
      }

      await persistExactValidationCheckpoint();

      // 5. Merge to main OR create individual PR (ReviewAgent mode)
      healthTracker.progress("publication", completion.id);
      await requireCompletionLease("publication");
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
        if (publicationAlreadyIntegrated) {
          console.log(
            `[${ts()}] Review completion ${completion.id} is already present on ${prHeadBranch}; skipping duplicate branch mutation.`,
          );
        } else if (shouldPublishWithExactReviewLease(reviewPublicationLease)) {
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
          await requireCompletionLease(`review branch push ${prHeadBranch}`);
          const publication = await publishWithAuthoritativeProof({
            mutate: () =>
              runGitCapture(
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
              ),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Failed exact-lease publication for review branch ${prHeadBranch}`,
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(
              `[${ts()}] Review push reported failure after ${prHeadBranch} became authoritative; continuing with durable recovery.`,
            );
          }
          await confirmLeaseAfterPublication(`review branch push ${prHeadBranch}`);
        } else if (resolvedHead.requiresMaterialize) {
          const publishRef = "HEAD";
          const remoteHeadBeforePublication = await gitOps.revParse(
            `refs/remotes/${runtimeConfig.remote}/${prHeadBranch}`,
          );
          const explicitLease = `--force-with-lease=refs/heads/${prHeadBranch}:${remoteHeadBeforePublication ?? ""}`;
          console.log(
            `[${ts()}] ReviewAgent mode - materializing hidden completion ref ${completion.branch} -> refs/heads/${prHeadBranch} with an exact remote lease.`,
          );
          await requireCompletionLease(`review branch materialization ${prHeadBranch}`);
          const publication = await publishWithAuthoritativeProof({
            mutate: () =>
              runGitCapture(
                [
                  "-C",
                  runtimeConfig.repoPath,
                  "push",
                  explicitLease,
                  runtimeConfig.remote,
                  `${publishRef}:refs/heads/${prHeadBranch}`,
                ],
                repoRoot,
              ),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Failed to publish review branch ${prHeadBranch}`,
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(
              `[${ts()}] Review materialization reported failure after ${prHeadBranch} became authoritative; continuing with durable recovery.`,
            );
          }
          await confirmLeaseAfterPublication(`review branch materialization ${prHeadBranch}`);
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

        await requireCompletionLease(`pull request creation for ${prHeadBranch}`);
        const pr = await ensureIntegrationPullRequest({
          token,
          remoteUrl,
          headBranch: prHeadBranch,
          baseBranch: prBaseBranch,
          title: prTitle,
          body: prBody,
          draft: false,
        });
        if (!pr.created && !publicationAlreadyIntegrated) {
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
        if (!publicationAlreadyIntegrated) {
          await requireCompletionLease(`merge to ${runtimeConfig.mainBranch}`);
          console.log(`[${ts()}] Merging ${tempBranch} to ${runtimeConfig.mainBranch}...`);
          await gitOps.checkoutMain();
          const ffResult = await gitOps.mergeFFOnlyRef(tempBranch);

          if (!ffResult.ok) {
            throw new Error(`FF merge to main failed: ${ffResult.stderr || ffResult.stdout}`);
          }

          console.log(
            `[${ts()}] ✓ Successfully merged ${completion.branch} to ${config.mainBranch}`,
          );
        } else {
          console.log(
            `[${ts()}] Completion ${completion.id} is already present on ${runtimeConfig.mainBranch}; skipping duplicate merge and push.`,
          );
        }
        if (runtimeConfig.pushMainAfterMerge && !publicationAlreadyIntegrated) {
          await requireCompletionLease(
            `push to ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`,
          );
          console.log(
            `[${ts()}] Pushing ${runtimeConfig.mainBranch} to ${runtimeConfig.remote}...`,
          );
          const publication = await publishWithAuthoritativeProof({
            mutate: () => gitOps.pushMain(),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Push failed for ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`,
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(
              `[${ts()}] Push reported failure after ${runtimeConfig.remote}/${runtimeConfig.mainBranch} contained the exact validated candidate; continuing with durable recovery.`,
            );
          } else {
            console.log(`[${ts()}] Push succeeded for ${runtimeConfig.mainBranch}`);
          }
          await confirmLeaseAfterPublication(
            `push to ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`,
          );
          if (runtimeConfig.openPrAfterPush) {
            try {
              await requireCompletionLease("aggregated pull request creation");
              const pr = await ensureMainPullRequest(completion, runtimeConfig);
              const prMessage = pr.created
                ? `Opened PR #${pr.number}: ${pr.htmlUrl}`
                : `Reused existing PR #${pr.number}: ${pr.htmlUrl}`;
              processedPrUrl = pr.htmlUrl;
              console.log(`[${ts()}] ${prMessage}`);
              await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
            } catch (prErr: any) {
              if (completionLeaseRenewal.hasLostLease()) throw prErr;
              const warning = `Push succeeded, but PR auto-open failed: ${prErr?.message ?? prErr}`;
              console.error(`[${ts()}] ${warning}`);
              await emitPusherMessage(comm, warning, completion.id, completionEventMeta);
            }
          }
        } else if (!publicationAlreadyIntegrated) {
          console.log(`[${ts()}] pushMainAfterMerge=false - skipping push`);
          if (!(await proveValidatedCandidatePublished())) {
            throw new Error(
              `Local publication proof for ${runtimeConfig.mainBranch} did not contain exact validated candidate ${trustedValidationCandidateSha}.`,
            );
          }
          markPublicationDurable();
          await confirmLeaseAfterPublication(`local merge to ${runtimeConfig.mainBranch}`);
        }
      }

      await requireCompletionLease("final authoritative publication proof");
      // An earlier proof can become stale while a PR provider request is in
      // flight. Clear it before the final probe so an unreachable or moved ref
      // can never inherit permission to finalize from a cached boolean.
      publicationAlreadyIntegrated = false;
      publicationReadyForFinalization = false;
      await assertFinalAuthoritativePublicationProof({
        provePublished: proveValidatedCandidatePublished,
        failurePrefix: `Final authoritative publication proof no longer contains exact validated candidate ${trustedValidationCandidateSha}`,
      });
      markPublicationDurable();

      if (!publicationReadyForFinalization) {
        throw new Error(
          "Publication finished without authoritative validation and durability proof; refusing completion finalization.",
        );
      }
      // 6. Clean up temp branch
      await gitOps.deleteTempBranch(tempBranch);

      // 7. Mark completion as processed
      healthTracker.progress("completion_callback", completion.id);
      await requireCompletionLease("processed callback");
      const additionalValidationRefs = validationRepairPublicationLease?.candidateRef
        ? [
            validationRepairPublicationLease.candidateRef,
            validationRepairPublicationLease.candidateRef.replace(/\/candidate$/, "/baseline"),
            validationRepairPublicationLease.candidateRef.replace(/\/candidate$/, "/validated"),
          ]
        : [];
      completionGcRecord = completionGcJournal.enqueue(
        createCompletionGcRecord({
          completionId: completion.id,
          completionBranch: completion.branch,
          commitSha: completion.commitSha,
          claimGeneration: completionClaimGeneration,
          remote:
            reviewPublicationLease && completion.branch.startsWith("refs/pushpals/")
              ? runtimeConfig.remote
              : null,
          additionalValidationRefs,
        }),
      );
      const markResult = await postCompletionProcessedWithRetry({
        request: async (signal) => {
          const response = await fetchBufferedWithHardDeadline({
            input: `${config.serverUrl}/completions/${completion.id}/processed`,
            init: {
              method: "POST",
              headers,
              signal,
              body: JSON.stringify({
                pusherId,
                claimToken: completionClaimToken,
                prUrl: processedPrUrl,
                trustedInstallDurationMs,
                trustedValidationDurationMs,
                trustedValidationCacheHit,
                trustedValidationReport: trustedValidationReport(),
              }),
            },
            timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
            timeoutMessage: `Completion processed callback timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`,
          });
          return parseCompletionPositiveAck(response);
        },
      });

      if (!markResult.confirmed) {
        const callbackDetail = markResult.lastStatus
          ? `HTTP ${markResult.lastStatus}`
          : markResult.lastError || "no response";
        console.warn(
          `[${ts()}] Publication completed for ${completion.id}, but its processed callback is unconfirmed after ${markResult.attempts} attempt(s): ${callbackDetail}. Retaining the immutable checkpoint for stale-claim reconciliation.`,
        );
        await emitPusherMessage(
          comm,
          `Publication completed for ${completion.id.slice(0, 8)}, but finalization acknowledgement is pending. SourceControlManager retained the exact checkpoint and will reconcile it without publishing again.`,
          completion.id,
          completionEventMeta,
        );
      } else {
        console.log(`[${ts()}] Marked completion ${completion.id} as processed`);
        cleanupCompletionHandoff = true;
        const pushMessage = useReviewPublicationFlow
          ? `Checks passed for ${completion.commitSha.slice(0, 8)} from ${completion.branch}. Individual PR is ready for ReviewAgent review.`
          : config.pushMainAfterMerge
            ? `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} and pushed to ${config.remote}/${config.mainBranch}.`
            : `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} (push disabled).`;
        await emitPusherMessage(comm, pushMessage, completion.id, completionEventMeta);
      }
    } catch (err: any) {
      const publicationConfirmationPending = err instanceof PublicationConfirmationPendingError;
      const publicationAttemptUncertain = err instanceof PublicationAuthorityUnreachableError;
      let authoritativeReprobe: AuthoritativePublicationReprobe = "absent";
      if (validatedCheckpointRecoveryPending && previousValidationCheckpoint?.validationProven) {
        validationSuccessProven = true;
        trustedValidationBaselineSha = previousValidationCheckpoint.baselineSha;
        trustedValidationCandidateSha = previousValidationCheckpoint.candidateSha;
        trustedValidationCandidateRef = previousValidationCheckpoint.candidateRef;
        validationCheckpointPersisted = true;
        validationCheckpointGeneration = previousValidationCheckpoint.claimGeneration;
      }
      try {
        await persistExactValidationCheckpoint();
      } catch (checkpointError) {
        err = new Error(
          `${err?.message ?? err}; additionally failed to retain exact trusted-validation candidate: ${
            checkpointError instanceof Error ? checkpointError.message : String(checkpointError)
          }`,
        );
      }
      if (!publicationReadyForFinalization && validationSuccessProven) {
        try {
          if (await proveValidatedCandidatePublished()) {
            markPublicationDurable();
            authoritativeReprobe = "published";
            console.warn(
              `[${ts()}] Recovered authoritative publication proof for ${completion.id} after an ambiguous publication error.`,
            );
          } else {
            authoritativeReprobe = "absent";
          }
        } catch (publicationProbeError) {
          authoritativeReprobe = "unreachable";
          console.warn(
            `[${ts()}] Could not confirm authoritative publication state for ${completion.id}: ${
              publicationProbeError instanceof Error
                ? publicationProbeError.message
                : String(publicationProbeError)
            }`,
          );
        }
      }
      const failureDisposition = publicationFailureDisposition({
        publicationReadyForFinalization,
        publicationAttemptUncertain,
        publicationConfirmationPending,
        authoritativeReprobe,
        validatedCheckpointRecoveryPending,
      });
      if (failureDisposition === "finalize") {
        console.warn(
          `[${ts()}] Publication completed for ${completion.id}, but finalization is pending after: ${err.message}. Retaining the completion for idempotent stale-claim recovery.`,
        );
        try {
          await emitPusherMessage(
            comm,
            `Publication completed for ${completion.id.slice(0, 8)}, but finalization acknowledgement is pending. SourceControlManager retained the exact checkpoint and will reconcile it without publishing again. Detail: ${err.message}`,
            completion.id,
            completionEventMeta,
          );
        } catch (messageError) {
          console.warn(
            `[${ts()}] Could not emit pending-finalization status for ${completion.id}: ${messageError instanceof Error ? messageError.message : String(messageError)}`,
          );
        }
      } else if (failureDisposition === "reconcile") {
        console.warn(
          `[${ts()}] Publication outcome is not yet confirmed for ${completion.id}. Retaining the immutable checkpoint and leaving the completion nonterminal for stale-claim reconciliation.`,
        );
        try {
          await emitPusherMessage(
            comm,
            `Publication outcome is temporarily unconfirmed for ${completion.id.slice(0, 8)}. SourceControlManager retained the exact validated checkpoint and will reconcile it on the next authoritative recheck; the job was not marked failed.`,
            completion.id,
            completionEventMeta,
          );
        } catch (messageError) {
          console.warn(
            `[${ts()}] Could not emit uncertain-publication status for ${completion.id}: ${messageError instanceof Error ? messageError.message : String(messageError)}`,
          );
        }
      } else {
        console.error(`[${ts()}] Failed to process completion ${completion.id}: ${err.message}`);

        // Mark completion as failed only before publication has completed. Once
        // a side effect is durable, stale-claim reconciliation owns recovery.
        const failResult = await postCompletionCallbackWithRetry({
          attempts: 2,
          request: async (signal) => {
            const response = await fetchBufferedWithHardDeadline({
              input: `${config.serverUrl}/completions/${completion.id}/fail`,
              init: {
                method: "POST",
                headers,
                signal,
                body: JSON.stringify({
                  pusherId,
                  claimToken: completionClaimToken,
                  error: err.message,
                  trustedInstallDurationMs,
                  trustedValidationDurationMs,
                  trustedValidationCacheHit,
                  trustedValidationReport: trustedValidationReport(),
                }),
              },
              timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
              timeoutMessage: `Completion failure callback timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`,
            });
            return parseCompletionPositiveAck(response);
          },
        });

        if (!failResult.confirmed) {
          const callbackDetail = failResult.lastStatus
            ? `HTTP ${failResult.lastStatus}`
            : failResult.lastError || "no response";
          console.warn(
            `[${ts()}] Completion ${completion.id} failed, but its failure callback is unconfirmed after ${failResult.attempts} attempt(s): ${callbackDetail}. Lease recovery will reconcile it.`,
          );
        }
        await emitPusherMessage(
          comm,
          `Failed to apply completion ${completion.id.slice(0, 8)} from ${completion.branch}: ${err.message}`,
          completion.id,
          completionEventMeta,
        );
      }
    } finally {
      clearInterval(completionLeaseHeartbeatTimer);
      try {
        await gitOps.resetToClean();
      } catch (err: any) {
        console.warn(
          `[${ts()}] Failed to reset SourceControlManager worktree after completion ${completion.id}: ${err?.message ?? err}`,
        );
      }
      if (validationWorktreeInvariantFailed) {
        try {
          const cleanResult = await validationGit(["clean", "-ffd"]);
          if (!cleanResult.ok) {
            console.warn(
              `[${ts()}] Failed to remove files created by a mutating validation command: ${cleanResult.stderr || cleanResult.stdout}`,
            );
          }
        } catch (err: any) {
          console.warn(
            `[${ts()}] Failed to clean validation-created files from the disposable SourceControlManager worktree: ${err?.message ?? err}`,
          );
        }
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
      if (cleanupCompletionHandoff && completionGcRecord) {
        try {
          const cleaned = await cleanupProcessedCompletionRefs(runtimeConfig, completionGcRecord);
          if (cleaned) {
            completionGcJournal.remove(completionGcRecord);
          } else {
            console.warn(
              `[${ts()}] Processed completion ${completion.id} has more retained refs than one bounded cleanup batch; the journal will resume cleanup next tick.`,
            );
          }
        } catch (err: any) {
          console.warn(
            `[${ts()}] Failed to clean processed completion refs for ${completion.id}; the durable GC journal will retry: ${err?.message ?? err}`,
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

  startReviewAgentRuntimeConfigPolling();
  void syncReviewAgentRuntimeConfig().catch((err: any) => {
    const detail = err?.message ?? String(err);
    logReviewAgentRuntimeState(
      `config-error:${detail}`,
      `[${ts()}] Initial ReviewAgent runtime config sync failed: ${detail}`,
      "warn",
    );
  });

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
    await clearReviewAgentPollLoop();
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

    await repositoryServices.close();
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
