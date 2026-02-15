import { existsSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";

type TomlValue = string | number | boolean | null | TomlObject | TomlValue[];
interface TomlObject {
  [key: string]: TomlValue;
}

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
const DEFAULT_CONFIG_DIR = "config";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface PushPalsLlmConfig {
  backend: string;
  endpoint: string;
  model: string;
  apiKey: string;
  sessionId: string;
}

export interface PushPalsLmStudioConfig {
  contextWindow: number;
  minOutputTokens: number;
  tokenSafetyMargin: number;
  batchTailMessages: number;
  batchChunkTokens: number;
  batchMemoryChars: number;
}

export interface PushPalsConfig {
  projectRoot: string;
  configDir: string;
  profile: string;
  sessionId: string;
  authToken: string | null;
  gitToken: string | null;
  llm: {
    lmstudio: PushPalsLmStudioConfig;
  };
  paths: {
    dataDir: string;
    sharedDbPath: string;
    remotebuddyDbPath: string;
  };
  server: {
    url: string;
    host: string;
    port: number;
    debugHttp: boolean;
    staleClaimTtlMs: number;
    staleClaimSweepIntervalMs: number;
  };
  localbuddy: {
    port: number;
    statusHeartbeatMs: number;
    llm: PushPalsLlmConfig;
  };
  remotebuddy: {
    pollMs: number;
    statusHeartbeatMs: number;
    workerpalOnlineTtlMs: number;
    waitForWorkerpalMs: number;
    autoSpawnWorkerpals: boolean;
    maxWorkerpals: number;
    workerpalStartupTimeoutMs: number;
    workerpalDocker: boolean;
    workerpalRequireDocker: boolean;
    workerpalImage: string | null;
    workerpalPollMs: number | null;
    workerpalHeartbeatMs: number | null;
    workerpalLabels: string[];
    executionBudgetInteractiveMs: number;
    executionBudgetNormalMs: number;
    executionBudgetBackgroundMs: number;
    finalizationBudgetMs: number;
    llm: PushPalsLlmConfig;
  };
  workerpals: {
    pollMs: number;
    heartbeatMs: number;
    executor: string;
    openhandsPython: string;
    openhandsTimeoutMs: number;
    openhandsStuckGuardEnabled: boolean;
    openhandsStuckGuardExploreLimit: number;
    openhandsStuckGuardMinElapsedMs: number;
    openhandsStuckGuardBroadScanLimit: number;
    openhandsStuckGuardNoProgressMaxMs: number;
    openhandsAutoSteerEnabled: boolean;
    openhandsAutoSteerInitialDelaySec: number;
    openhandsAutoSteerIntervalSec: number;
    openhandsAutoSteerMaxNudges: number;
    requirePush: boolean;
    pushAgentBranch: boolean;
    requireDocker: boolean;
    skipDockerSelfCheck: boolean;
    dockerImage: string;
    dockerTimeoutMs: number;
    dockerIdleTimeoutMs: number;
    dockerAgentStartupTimeoutMs: number;
    dockerWarmMaxAttempts: number;
    dockerWarmRetryBackoffMs: number;
    dockerJobMaxAttempts: number;
    dockerJobRetryBackoffMs: number;
    dockerNetworkMode: string;
    dockerWarmMemoryMb: number;
    dockerWarmCpus: number;
    baseRef: string;
    labels: string[];
    failureCooldownMs: number;
    llm: PushPalsLlmConfig;
  };
  sourceControlManager: {
    repoPath: string;
    remote: string;
    mainBranch: string;
    baseBranch: string;
    branchPrefix: string;
    pollIntervalSeconds: number;
    stateDir: string;
    port: number;
    deleteAfterMerge: boolean;
    maxAttempts: number;
    mergeStrategy: "cherry-pick" | "no-ff" | "ff-only";
    pushMainAfterMerge: boolean;
    openPrAfterPush: boolean;
    prBaseBranch: string;
    prTitle: string | null;
    prBody: string | null;
    prDraft: boolean;
    statusHeartbeatMs: number;
    skipCleanCheck: boolean;
    autoCreateMainBranch: boolean;
  };
  startup: {
    workerImageRebuild: "auto" | "always" | "never";
    syncIntegrationWithMain: boolean;
    skipLlmPreflight: boolean;
    autoStartLmStudio: boolean;
    lmStudioReadyTimeoutMs: number;
    lmStudioCli: string;
    lmStudioPort: number;
    lmStudioStartArgs: string;
    startupWarmup: boolean;
    startupWarmupTimeoutMs: number;
    startupWarmupPollMs: number;
    allowExternalClean: boolean;
  };
  client: {
    localAgentUrl: string;
    traceTailLines: number;
  };
}

interface LoadOptions {
  projectRoot?: string;
  configDir?: string;
  reload?: boolean;
}

let cachedConfig: PushPalsConfig | null = null;
let cachedConfigKey = "";

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function parseBoolEnv(name: string): boolean | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (TRUTHY.has(raw)) return true;
  if (FALSY.has(raw)) return false;
  return null;
}

function parseIntEnv(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTomlFile(path: string): TomlObject {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  const parsed = Bun.TOML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as TomlObject;
}

function isObject(value: unknown): value is TomlObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base: TomlObject, override: TomlObject): TomlObject {
  const out: TomlObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isObject(existing) && isObject(value)) {
      out[key] = mergeDeep(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getObject(parent: TomlObject, key: string): TomlObject {
  const value = parent[key];
  if (isObject(value)) return value;
  return {};
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUTHY.has(lowered)) return true;
    if (FALSY.has(lowered)) return false;
  }
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function resolvePathFromRoot(projectRoot: string, value: string): string {
  if (!value) return projectRoot;
  if (isAbsolute(value)) return resolve(value);
  return resolve(projectRoot, value);
}

function normalizeBackend(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text) return "lmstudio";
  if (text === "openai_compatible") return "lmstudio";
  if (text === "ollama_chat") return "ollama";
  return text;
}

function normalizeWorkerImageRebuildMode(value: string): "auto" | "always" | "never" {
  const text = value.trim().toLowerCase();
  if (text === "always" || text === "1" || text === "true" || text === "yes" || text === "on") {
    return "always";
  }
  if (text === "never" || text === "0" || text === "false" || text === "no" || text === "off") {
    return "never";
  }
  return "auto";
}

function defaultApiKeyForBackend(backend: string): string {
  return backend === "lmstudio" ? "lmstudio" : "";
}

function resolveLlmConfig(
  serviceNode: TomlObject,
  envPrefix: "LOCALBUDDY" | "REMOTEBUDDY" | "WORKERPALS",
  defaults: { backend: string; endpoint: string; model: string; sessionId: string },
  globalSessionId: string,
): PushPalsLlmConfig {
  const llmNode = getObject(serviceNode, "llm");
  const backend = normalizeBackend(
    firstNonEmpty(
      process.env[`${envPrefix}_LLM_BACKEND`],
      asString(llmNode.backend, defaults.backend),
      defaults.backend,
    ),
  );
  const endpoint = firstNonEmpty(
    process.env[`${envPrefix}_LLM_ENDPOINT`],
    asString(llmNode.endpoint, defaults.endpoint),
    defaults.endpoint,
  );
  const model = firstNonEmpty(
    process.env[`${envPrefix}_LLM_MODEL`],
    asString(llmNode.model, defaults.model),
    defaults.model,
  );
  const sessionId = firstNonEmpty(
    process.env[`${envPrefix}_LLM_SESSION_ID`],
    asString(llmNode.session_id, defaults.sessionId),
    process.env.PUSHPALS_LLM_SESSION_ID,
    globalSessionId,
  );
  const apiKey = firstNonEmpty(
    process.env[`${envPrefix}_LLM_API_KEY`],
    defaultApiKeyForBackend(backend),
  );
  return { backend, endpoint, model, sessionId, apiKey };
}

export function loadPushPalsConfig(options: LoadOptions = {}): PushPalsConfig {
  const projectRoot = resolve(options.projectRoot ?? PROJECT_ROOT);
  const configDir = resolvePathFromRoot(projectRoot, options.configDir ?? DEFAULT_CONFIG_DIR);
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }

  const defaultToml = parseTomlFile(join(configDir, "default.toml"));
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlFile(join(configDir, `${preferredProfile}.toml`));
  const localToml = parseTomlFile(join(configDir, "local.toml"));
  const merged = mergeDeep(mergeDeep(defaultToml, profileToml), localToml);

  const profile = firstNonEmpty(
    process.env.PUSHPALS_PROFILE,
    asString(merged.profile, preferredProfile),
    preferredProfile,
  );
  const sessionId = firstNonEmpty(process.env.PUSHPALS_SESSION_ID, asString(merged.session_id, "dev"), "dev");

  const llmNode = getObject(merged, "llm");
  const lmStudioNode = getObject(llmNode, "lmstudio");
  const lmStudioContextWindow = Math.max(
    512,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_CONTEXT_WINDOW") ?? lmStudioNode.context_window,
      4096,
    ),
  );
  const lmStudioMinOutputTokens = Math.max(
    64,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_MIN_OUTPUT_TOKENS") ?? lmStudioNode.min_output_tokens,
      256,
    ),
  );
  const lmStudioTokenSafetyMargin = Math.max(
    16,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_TOKEN_SAFETY_MARGIN") ?? lmStudioNode.token_safety_margin,
      64,
    ),
  );
  const lmStudioBatchTailMessages = Math.max(
    1,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_TAIL_MESSAGES") ?? lmStudioNode.batch_tail_messages,
      3,
    ),
  );
  const lmStudioBatchChunkTokens = Math.max(
    0,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_CHUNK_TOKENS") ?? lmStudioNode.batch_chunk_tokens,
      0,
    ),
  );
  const lmStudioBatchMemoryChars = Math.max(
    0,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_MEMORY_CHARS") ?? lmStudioNode.batch_memory_chars,
      0,
    ),
  );

  const pathsNode = getObject(merged, "paths");
  const dataDir = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(process.env.PUSHPALS_DATA_DIR, asString(pathsNode.data_dir, "outputs/data")),
  );
  const sharedDbPath = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(process.env.PUSHPALS_DB_PATH, asString(pathsNode.shared_db_path, join(dataDir, "pushpals.db"))),
  );
  const remotebuddyDbPath = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(
      process.env.REMOTEBUDDY_DB_PATH,
      asString(pathsNode.remotebuddy_db_path, join(dataDir, "remotebuddy-state.db")),
    ),
  );

  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(
    1,
    asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001),
  );
  const serverUrl = firstNonEmpty(
    process.env.PUSHPALS_SERVER_URL,
    asString(serverNode.url, `http://localhost:${serverPort}`),
    `http://localhost:${serverPort}`,
  );
  const serverHost = asString(serverNode.host, "0.0.0.0");
  const debugHttp =
    parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(
    5_000,
    asInt(
      parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms,
      120_000,
    ),
  );
  const staleClaimSweepIntervalMs = Math.max(
    1_000,
    asInt(
      parseIntEnv("PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS") ??
        serverNode.stale_claim_sweep_interval_ms,
      5_000,
    ),
  );

  const globalStatusHeartbeatMs = parseIntEnv("PUSHPALS_STATUS_HEARTBEAT_MS");

  const localNode = getObject(merged, "localbuddy");
  const localPort = Math.max(1, asInt(parseIntEnv("LOCAL_AGENT_PORT") ?? localNode.port, 3003));
  const localStatusHeartbeatMs = Math.max(
    0,
    asInt(
      parseIntEnv("LOCALBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? localNode.status_heartbeat_ms,
      120_000,
    ),
  );
  const localLlm = resolveLlmConfig(
    localNode,
    "LOCALBUDDY",
    {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "local-model",
      sessionId: "localbuddy-dev",
    },
    sessionId,
  );

  const remoteNode = getObject(merged, "remotebuddy");
  const remoteStatusHeartbeatMs = Math.max(
    0,
    asInt(
      parseIntEnv("REMOTEBUDDY_STATUS_HEARTBEAT_MS") ??
        globalStatusHeartbeatMs ??
        remoteNode.status_heartbeat_ms,
      120_000,
    ),
  );
  const remotePollMs = Math.max(
    200,
    asInt(parseIntEnv("REMOTEBUDDY_POLL_MS") ?? remoteNode.poll_ms, 2_000),
  );
  const remoteLlm = resolveLlmConfig(
    remoteNode,
    "REMOTEBUDDY",
    {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "local-model",
      sessionId: "remotebuddy-dev",
    },
    sessionId,
  );

  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerPollMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2_000));
  const workerHeartbeatMs = Math.max(
    200,
    asInt(parseIntEnv("WORKERPALS_HEARTBEAT_MS") ?? workerNode.heartbeat_ms, 5_000),
  );
  const workerExecutor = firstNonEmpty(
    process.env.WORKERPALS_EXECUTOR,
    asString(workerNode.executor, "openhands"),
    "openhands",
  ).toLowerCase();
  const workerOpenHandsPython = firstNonEmpty(
    process.env.WORKERPALS_OPENHANDS_PYTHON,
    asString(workerNode.openhands_python, "python"),
    "python",
  );
  const workerOpenHandsTimeoutMs = Math.max(
    10_000,
    asInt(
      parseIntEnv("WORKERPALS_OPENHANDS_TIMEOUT_MS") ?? workerNode.openhands_timeout_ms,
      1_800_000,
    ),
  );
  const workerOpenHandsStuckGuardEnabled =
    parseBoolEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_ENABLED") ??
    asBoolean(workerNode.openhands_stuck_guard_enabled, true);
  const workerOpenHandsStuckGuardExploreLimit = Math.max(
    6,
    asInt(
      parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_EXPLORE_LIMIT") ??
        workerNode.openhands_stuck_guard_explore_limit,
      18,
    ),
  );
  const workerOpenHandsStuckGuardMinElapsedMs = Math.max(
    60_000,
    asInt(
      parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_MIN_ELAPSED_MS") ??
        workerNode.openhands_stuck_guard_min_elapsed_ms,
      180_000,
    ),
  );
  const workerOpenHandsStuckGuardBroadScanLimit = Math.max(
    1,
    asInt(
      parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_BROAD_SCAN_LIMIT") ??
        workerNode.openhands_stuck_guard_broad_scan_limit,
      2,
    ),
  );
  const workerOpenHandsStuckGuardNoProgressMaxMs = Math.max(
    60_000,
    asInt(
      parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_NO_PROGRESS_MAX_MS") ??
        workerNode.openhands_stuck_guard_no_progress_max_ms,
      300_000,
    ),
  );
  const workerOpenHandsAutoSteerEnabled =
    parseBoolEnv("WORKERPALS_OPENHANDS_AUTO_STEER_ENABLED") ??
    asBoolean(workerOpenHandsNode.auto_steer_enabled, true);
  const workerOpenHandsAutoSteerInitialDelaySec = Math.max(
    0,
    Math.min(
      600,
      asInt(
        parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INITIAL_DELAY_SEC") ??
          workerOpenHandsNode.auto_steer_initial_delay_sec,
        90,
      ),
    ),
  );
  const workerOpenHandsAutoSteerIntervalSec = Math.max(
    15,
    Math.min(
      600,
      asInt(
        parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INTERVAL_SEC") ??
          workerOpenHandsNode.auto_steer_interval_sec,
        60,
      ),
    ),
  );
  const workerOpenHandsAutoSteerMaxNudges = Math.max(
    0,
    Math.min(
      8,
      asInt(
        parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES") ??
          workerOpenHandsNode.auto_steer_max_nudges,
        4,
      ),
    ),
  );
  const workerRequirePush =
    parseBoolEnv("WORKERPALS_REQUIRE_PUSH") ?? asBoolean(workerNode.require_push, false);
  const workerPushAgentBranchEnv = parseBoolEnv("WORKERPALS_PUSH_AGENT_BRANCH");
  const workerPushAgentBranch =
    workerRequirePush || (workerPushAgentBranchEnv ?? asBoolean(workerNode.push_agent_branch, false));
  const workerSkipDockerSelfCheck =
    parseBoolEnv("WORKERPALS_SKIP_DOCKER_SELF_CHECK") ??
    asBoolean(workerNode.skip_docker_self_check, false);
  const workerDockerAgentStartupTimeoutMs = Math.max(
    10_000,
    Math.min(
      180_000,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS") ??
          workerNode.docker_agent_startup_timeout_ms,
        45_000,
      ),
    ),
  );
  const workerDockerWarmMaxAttempts = Math.max(
    1,
    Math.min(
      5,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_WARM_MAX_ATTEMPTS") ?? workerNode.docker_warm_max_attempts,
        3,
      ),
    ),
  );
  const workerDockerWarmRetryBackoffMs = Math.max(
    250,
    Math.min(
      60_000,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_WARM_RETRY_BACKOFF_MS") ??
          workerNode.docker_warm_retry_backoff_ms,
        2_000,
      ),
    ),
  );
  const workerDockerJobMaxAttempts = Math.max(
    1,
    Math.min(
      3,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_JOB_MAX_ATTEMPTS") ?? workerNode.docker_job_max_attempts,
        2,
      ),
    ),
  );
  const workerDockerJobRetryBackoffMs = Math.max(
    250,
    Math.min(
      60_000,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_JOB_RETRY_BACKOFF_MS") ??
          workerNode.docker_job_retry_backoff_ms,
        3_000,
      ),
    ),
  );
  const workerDockerWarmMemoryMb = Math.max(
    512,
    Math.min(
      32_768,
      asInt(
        parseIntEnv("WORKERPALS_DOCKER_WARM_MEMORY_MB") ?? workerNode.docker_warm_memory_mb,
        2_048,
      ),
    ),
  );
  const workerDockerWarmCpus = Math.max(
    1,
    Math.min(
      16,
      asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_CPUS") ?? workerNode.docker_warm_cpus, 2),
    ),
  );
  const workerLlm = resolveLlmConfig(
    workerNode,
    "WORKERPALS",
    {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "local-model",
      sessionId: "workerpals-dev",
    },
    sessionId,
  );

  const scmNode = getObject(merged, "source_control_manager");
  const scmRepoPath = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(
      process.env.SOURCE_CONTROL_MANAGER_REPO_PATH,
      asString(scmNode.repo_path, ".worktrees/source_control_manager"),
      ".worktrees/source_control_manager",
    ),
  );
  const scmRemote = asString(process.env.SOURCE_CONTROL_MANAGER_REMOTE ?? scmNode.remote, "origin");
  const scmMainBranch = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_MAIN_BRANCH,
    process.env.PUSHPALS_INTEGRATION_BRANCH,
    asString(scmNode.pushpals_branch, "main_agents"),
    "main_agents",
  );
  const scmBaseBranch = firstNonEmpty(
    process.env.PUSHPALS_INTEGRATION_BASE_BRANCH,
    asString(scmNode.base_branch, "main"),
    "main",
  );
  const scmBranchPrefix = asString(
    process.env.SOURCE_CONTROL_MANAGER_BRANCH_PREFIX ?? scmNode.branch_prefix,
    "agent/",
  );
  const scmPollIntervalSeconds = Math.max(
    1,
    asInt(
      parseIntEnv("SOURCE_CONTROL_MANAGER_POLL_INTERVAL_SECONDS") ?? scmNode.poll_interval_seconds,
      10,
    ),
  );
  const scmStateDir = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(
      process.env.SOURCE_CONTROL_MANAGER_STATE_DIR,
      asString(scmNode.state_dir, join(dataDir, "source_control_manager")),
      join(dataDir, "source_control_manager"),
    ),
  );
  const scmPort = Math.max(
    1,
    Math.min(65_535, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_PORT") ?? scmNode.port, 3002)),
  );
  const scmDeleteAfterMerge =
    parseBoolEnv("SOURCE_CONTROL_MANAGER_DELETE_AFTER_MERGE") ??
    asBoolean(scmNode.delete_after_merge, false);
  const scmMaxAttempts = Math.max(
    1,
    asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_MAX_ATTEMPTS") ?? scmNode.max_attempts, 3),
  );
  const scmMergeStrategyRaw = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_MERGE_STRATEGY,
    asString(scmNode.merge_strategy, "cherry-pick"),
    "cherry-pick",
  );
  const scmMergeStrategy =
    scmMergeStrategyRaw === "no-ff" || scmMergeStrategyRaw === "ff-only"
      ? scmMergeStrategyRaw
      : "cherry-pick";
  let scmPushMainAfterMerge = asBoolean(scmNode.push_main_after_merge, true);
  const scmPushMainAfterMergeEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_PUSH_MAIN_AFTER_MERGE");
  if (scmPushMainAfterMergeEnv != null) scmPushMainAfterMerge = scmPushMainAfterMergeEnv;
  const scmNoPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (scmNoPushEnv != null) scmPushMainAfterMerge = !scmNoPushEnv;
  let scmOpenPrAfterPush = asBoolean(scmNode.open_pr_after_push, true);
  const scmOpenPrAfterPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_OPEN_PR_AFTER_PUSH");
  if (scmOpenPrAfterPushEnv != null) scmOpenPrAfterPush = scmOpenPrAfterPushEnv;
  const scmDisableAutoPrEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_DISABLE_AUTO_PR");
  if (scmDisableAutoPrEnv != null) scmOpenPrAfterPush = !scmDisableAutoPrEnv;
  const scmPrBaseBranch = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_PR_BASE_BRANCH,
    asString(scmNode.pr_base_branch, scmBaseBranch),
    scmBaseBranch,
  );
  const scmPrTitle = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_PR_TITLE,
    asString(scmNode.pr_title, ""),
  );
  const scmPrBody = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_PR_BODY,
    asString(scmNode.pr_body, ""),
  );
  const scmPrDraft =
    parseBoolEnv("SOURCE_CONTROL_MANAGER_PR_DRAFT") ?? asBoolean(scmNode.pr_draft, false);
  const scmStatusHeartbeatMs = Math.max(
    0,
    asInt(
      parseIntEnv("SOURCE_CONTROL_MANAGER_STATUS_HEARTBEAT_MS") ??
        globalStatusHeartbeatMs ??
        scmNode.status_heartbeat_ms,
      120_000,
    ),
  );
  const scmSkipCleanCheck =
    parseBoolEnv("SOURCE_CONTROL_MANAGER_SKIP_CLEAN_CHECK") ??
    asBoolean(scmNode.skip_clean_check, false);
  const scmAutoCreateMainBranch =
    parseBoolEnv("SOURCE_CONTROL_MANAGER_AUTO_CREATE_MAIN_BRANCH") ??
    asBoolean(scmNode.auto_create_main_branch, false);

  const startupNode = getObject(merged, "startup");
  const startupWorkerImageRebuild = normalizeWorkerImageRebuildMode(
    firstNonEmpty(
      process.env.PUSHPALS_WORKER_IMAGE_REBUILD,
      asString(startupNode.worker_image_rebuild, "auto"),
      "auto",
    ),
  );
  const startupSyncIntegrationWithMain =
    parseBoolEnv("PUSHPALS_SYNC_INTEGRATION_WITH_MAIN") ??
    asBoolean(startupNode.sync_integration_with_main, true);
  const startupSkipLlmPreflight =
    parseBoolEnv("PUSHPALS_SKIP_LLM_PREFLIGHT") ?? asBoolean(startupNode.skip_llm_preflight, false);
  const startupAutoStartLmStudio =
    parseBoolEnv("PUSHPALS_AUTO_START_LMSTUDIO") ?? asBoolean(startupNode.auto_start_lmstudio, true);
  const startupLmStudioReadyTimeoutMs = Math.max(
    1_000,
    asInt(
      parseIntEnv("PUSHPALS_LMSTUDIO_READY_TIMEOUT_MS") ?? startupNode.lmstudio_ready_timeout_ms,
      120_000,
    ),
  );
  const startupLmStudioCli = firstNonEmpty(
    process.env.PUSHPALS_LMSTUDIO_CLI,
    asString(startupNode.lmstudio_cli, "lms"),
    "lms",
  );
  const startupLmStudioPort = Math.max(
    1,
    Math.min(65_535, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_PORT") ?? startupNode.lmstudio_port, 1234)),
  );
  const startupLmStudioStartArgs = firstNonEmpty(
    process.env.PUSHPALS_LMSTUDIO_START_ARGS,
    asString(startupNode.lmstudio_start_args, ""),
  );
  const startupWarmup =
    parseBoolEnv("PUSHPALS_STARTUP_WARMUP") ?? asBoolean(startupNode.startup_warmup, true);
  const startupWarmupTimeoutMs = Math.max(
    15_000,
    asInt(
      parseIntEnv("PUSHPALS_STARTUP_WARMUP_TIMEOUT_MS") ?? startupNode.startup_warmup_timeout_ms,
      120_000,
    ),
  );
  const startupWarmupPollMs = Math.max(
    250,
    Math.min(
      5_000,
      asInt(
        parseIntEnv("PUSHPALS_STARTUP_WARMUP_POLL_MS") ?? startupNode.startup_warmup_poll_ms,
        1_000,
      ),
    ),
  );
  const startupAllowExternalClean =
    parseBoolEnv("PUSHPALS_ALLOW_EXTERNAL_CLEAN") ?? asBoolean(startupNode.allow_external_clean, false);

  const clientNode = getObject(merged, "client");

  const authToken = firstNonEmpty(process.env.PUSHPALS_AUTH_TOKEN) || null;
  const gitToken =
    firstNonEmpty(process.env.PUSHPALS_GIT_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN) ||
    null;

  const config: PushPalsConfig = {
    projectRoot,
    configDir,
    profile,
    sessionId,
    authToken,
    gitToken,
    llm: {
      lmstudio: {
        contextWindow: lmStudioContextWindow,
        minOutputTokens: lmStudioMinOutputTokens,
        tokenSafetyMargin: lmStudioTokenSafetyMargin,
        batchTailMessages: lmStudioBatchTailMessages,
        batchChunkTokens: lmStudioBatchChunkTokens,
        batchMemoryChars: lmStudioBatchMemoryChars,
      },
    },
    paths: {
      dataDir,
      sharedDbPath,
      remotebuddyDbPath,
    },
    server: {
      url: serverUrl,
      host: serverHost,
      port: serverPort,
      debugHttp,
      staleClaimTtlMs,
      staleClaimSweepIntervalMs,
    },
    localbuddy: {
      port: localPort,
      statusHeartbeatMs: localStatusHeartbeatMs,
      llm: localLlm,
    },
    remotebuddy: {
      pollMs: remotePollMs,
      statusHeartbeatMs: remoteStatusHeartbeatMs,
      workerpalOnlineTtlMs: Math.max(
        1_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_WORKERPAL_ONLINE_TTL_MS") ?? remoteNode.workerpal_online_ttl_ms,
          15_000,
        ),
      ),
      waitForWorkerpalMs: Math.max(
        0,
        asInt(
          parseIntEnv("REMOTEBUDDY_WAIT_FOR_WORKERPAL_MS") ?? remoteNode.wait_for_workerpal_ms,
          15_000,
        ),
      ),
      autoSpawnWorkerpals:
        parseBoolEnv("REMOTEBUDDY_AUTO_SPAWN_WORKERPALS") ??
        asBoolean(remoteNode.auto_spawn_workerpals, true),
      maxWorkerpals: Math.max(
        1,
        asInt(parseIntEnv("REMOTEBUDDY_MAX_WORKERPALS") ?? remoteNode.max_workerpals, 1),
      ),
      workerpalStartupTimeoutMs: Math.max(
        1_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS") ??
            remoteNode.workerpal_startup_timeout_ms,
          10_000,
        ),
      ),
      workerpalDocker:
        parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ?? asBoolean(remoteNode.workerpal_docker, true),
      workerpalRequireDocker:
        parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ??
        asBoolean(remoteNode.workerpal_require_docker, true),
      workerpalImage:
        firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_IMAGE, asString(remoteNode.workerpal_image, "")) ||
        null,
      workerpalPollMs:
        asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_POLL_MS")) ??
        asIntOrNull(remoteNode.workerpal_poll_ms),
      workerpalHeartbeatMs:
        asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_HEARTBEAT_MS")) ??
        asIntOrNull(remoteNode.workerpal_heartbeat_ms),
      workerpalLabels: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS)
        ? firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : asStringArray(remoteNode.workerpal_labels),
      executionBudgetInteractiveMs: Math.max(
        60_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_INTERACTIVE_MS") ??
            remoteNode.execution_budget_interactive_ms,
          300_000,
        ),
      ),
      executionBudgetNormalMs: Math.max(
        120_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_NORMAL_MS") ??
            remoteNode.execution_budget_normal_ms,
          900_000,
        ),
      ),
      executionBudgetBackgroundMs: Math.max(
        180_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_BACKGROUND_MS") ??
            remoteNode.execution_budget_background_ms,
          1_800_000,
        ),
      ),
      finalizationBudgetMs: Math.max(
        30_000,
        asInt(
          parseIntEnv("REMOTEBUDDY_FINALIZATION_BUDGET_MS") ?? remoteNode.finalization_budget_ms,
          120_000,
        ),
      ),
      llm: remoteLlm,
    },
    workerpals: {
      pollMs: workerPollMs,
      heartbeatMs: workerHeartbeatMs,
      executor: workerExecutor,
      openhandsPython: workerOpenHandsPython,
      openhandsTimeoutMs: workerOpenHandsTimeoutMs,
      openhandsStuckGuardEnabled: workerOpenHandsStuckGuardEnabled,
      openhandsStuckGuardExploreLimit: workerOpenHandsStuckGuardExploreLimit,
      openhandsStuckGuardMinElapsedMs: workerOpenHandsStuckGuardMinElapsedMs,
      openhandsStuckGuardBroadScanLimit: workerOpenHandsStuckGuardBroadScanLimit,
      openhandsStuckGuardNoProgressMaxMs: workerOpenHandsStuckGuardNoProgressMaxMs,
      openhandsAutoSteerEnabled: workerOpenHandsAutoSteerEnabled,
      openhandsAutoSteerInitialDelaySec: workerOpenHandsAutoSteerInitialDelaySec,
      openhandsAutoSteerIntervalSec: workerOpenHandsAutoSteerIntervalSec,
      openhandsAutoSteerMaxNudges: workerOpenHandsAutoSteerMaxNudges,
      requirePush: workerRequirePush,
      pushAgentBranch: workerPushAgentBranch,
      requireDocker:
        parseBoolEnv("WORKERPALS_REQUIRE_DOCKER") ?? asBoolean(workerNode.require_docker, false),
      skipDockerSelfCheck: workerSkipDockerSelfCheck,
      dockerImage: firstNonEmpty(
        process.env.WORKERPALS_DOCKER_IMAGE,
        asString(workerNode.docker_image, "pushpals-worker-sandbox:latest"),
        "pushpals-worker-sandbox:latest",
      ),
      dockerTimeoutMs: Math.max(
        10_000,
        asInt(parseIntEnv("WORKERPALS_DOCKER_TIMEOUT_MS") ?? workerNode.docker_timeout_ms, 1_800_000),
      ),
      dockerIdleTimeoutMs: Math.max(
        0,
        asInt(
          parseIntEnv("WORKERPALS_DOCKER_IDLE_TIMEOUT_MS") ?? workerNode.docker_idle_timeout_ms,
          600_000,
        ),
      ),
      dockerAgentStartupTimeoutMs: workerDockerAgentStartupTimeoutMs,
      dockerWarmMaxAttempts: workerDockerWarmMaxAttempts,
      dockerWarmRetryBackoffMs: workerDockerWarmRetryBackoffMs,
      dockerJobMaxAttempts: workerDockerJobMaxAttempts,
      dockerJobRetryBackoffMs: workerDockerJobRetryBackoffMs,
      dockerWarmMemoryMb: workerDockerWarmMemoryMb,
      dockerWarmCpus: workerDockerWarmCpus,
      dockerNetworkMode: asString(
        process.env.WORKERPALS_DOCKER_NETWORK_MODE ?? workerNode.docker_network_mode,
        "bridge",
      ),
      baseRef: firstNonEmpty(
        process.env.WORKERPALS_BASE_REF,
        asString(workerNode.base_ref, "origin/main_agents"),
        "origin/main_agents",
      ),
      labels: firstNonEmpty(process.env.WORKERPALS_LABELS)
        ? firstNonEmpty(process.env.WORKERPALS_LABELS)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : asStringArray(workerNode.labels),
      failureCooldownMs: Math.max(
        0,
        asInt(
          parseIntEnv("WORKERPALS_FAILURE_COOLDOWN_MS") ??
            parseIntEnv("WORKERPALS_DOCKER_FAILURE_COOLDOWN_MS") ??
            workerNode.failure_cooldown_ms,
          20_000,
        ),
      ),
      llm: workerLlm,
    },
    sourceControlManager: {
      repoPath: scmRepoPath,
      remote: scmRemote,
      mainBranch: scmMainBranch,
      baseBranch: scmBaseBranch,
      branchPrefix: scmBranchPrefix,
      pollIntervalSeconds: scmPollIntervalSeconds,
      stateDir: scmStateDir,
      port: scmPort,
      deleteAfterMerge: scmDeleteAfterMerge,
      maxAttempts: scmMaxAttempts,
      mergeStrategy: scmMergeStrategy,
      pushMainAfterMerge: scmPushMainAfterMerge,
      openPrAfterPush: scmOpenPrAfterPush,
      prBaseBranch: scmPrBaseBranch,
      prTitle: scmPrTitle || null,
      prBody: scmPrBody || null,
      prDraft: scmPrDraft,
      statusHeartbeatMs: scmStatusHeartbeatMs,
      skipCleanCheck: scmSkipCleanCheck,
      autoCreateMainBranch: scmAutoCreateMainBranch,
    },
    startup: {
      workerImageRebuild: startupWorkerImageRebuild,
      syncIntegrationWithMain: startupSyncIntegrationWithMain,
      skipLlmPreflight: startupSkipLlmPreflight,
      autoStartLmStudio: startupAutoStartLmStudio,
      lmStudioReadyTimeoutMs: startupLmStudioReadyTimeoutMs,
      lmStudioCli: startupLmStudioCli,
      lmStudioPort: startupLmStudioPort,
      lmStudioStartArgs: startupLmStudioStartArgs,
      startupWarmup,
      startupWarmupTimeoutMs: startupWarmupTimeoutMs,
      startupWarmupPollMs: startupWarmupPollMs,
      allowExternalClean: startupAllowExternalClean,
    },
    client: {
      localAgentUrl: firstNonEmpty(
        process.env.EXPO_PUBLIC_LOCAL_AGENT_URL,
        asString(clientNode.local_agent_url, `http://localhost:${localPort}`),
        `http://localhost:${localPort}`,
      ),
      traceTailLines: Math.max(
        10,
        asInt(parseIntEnv("EXPO_PUBLIC_PUSHPALS_TRACE_TAIL_LINES") ?? clientNode.trace_tail_lines, 100),
      ),
    },
  };

  cachedConfig = config;
  cachedConfigKey = cacheKey;
  return config;
}
