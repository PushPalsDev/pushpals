import { existsSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";

type TomlValue = string | number | boolean | null | TomlObject | TomlValue[];
interface TomlObject {
  [key: string]: TomlValue;
}

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
const DEFAULT_CONFIG_DIR = "configs";
const LEGACY_CONFIG_DIR = "config";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE = 8;
const DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 1;
const DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
const DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
const DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
const DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
const DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 45_000;
const DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16_000;
const DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8_000;
const DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
const DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
const DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
const DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
const DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
const REDACTED_LOG_VALUE = "[REDACTED]";
const SENSITIVE_CONFIG_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key)/i;

export interface PushPalsLlmConfig {
  backend: string;
  endpoint: string;
  model: string;
  apiKey: string;
  sessionId: string;
  reasoningEffort: string;
  codexAuthMode: string;
  codexBin: string;
  codexTimeoutMs: number;
}

export interface PushPalsLmStudioConfig {
  contextWindow: number;
  minOutputTokens: number;
  tokenSafetyMargin: number;
  batchTailMessages: number;
  batchChunkTokens: number;
  batchMemoryChars: number;
}

export interface PushPalsCheckConfig {
  name: string;
  command: string;
  timeoutMs: number;
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
    enabled: boolean;
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
    crashRestartEnabled: boolean;
    crashRestartMaxRestarts: number;
    crashRestartBackoffMs: number;
    memory: {
      enabled: boolean;
      includeCrossSession: boolean;
      maxRecallItems: number;
      maxRecallChars: number;
      maxSummaryChars: number;
      retentionDays: number;
    };
    autonomy: {
      enabled: boolean;
      killSwitchEnabled: boolean;
      tickIntervalMs: number;
      heartbeatLogMs: number;
      visionContextMaxChars: number;
      ideationBudgetMs: number;
      llmTimeoutMs: number;
      allowDirtyWorktree: boolean;
      ideationMaxCandidates: number;
      topK: number;
      exploreRate: number;
      minConfidence: number;
      maxConcurrentObjectives: number;
      maxDispatchPerHour: number;
      maxDispatchPerHourByType: Record<string, number>;
      maxDispatchPerHourByComponent: Record<string, number>;
      maxTokenUsagePerHour: number;
      maxRuntimeMsPerHour: number;
      cooldownFailStreakThreshold: number;
      cooldownMs: number;
      staleObjectiveTtlMs: number;
      staleObjectiveSweepIntervalMs: number;
      autoFreezeFailStreakThreshold: number;
      autoFreezeDurationMs: number;
      evaluatorWindowHours: number;
      evaluatorMinSamples: number;
      evaluatorMinSuccessRate: number;
      evaluatorMaxRegretRate: number;
      evaluatorRunIntervalMs: number;
      alertQueuePendingThreshold: number;
      alertJobFailureRateThreshold: number;
      alertAutonomyFailureRateThreshold: number;
      allowReadAnywhere: boolean;
      prFeedbackCommentRows: number;
      prFeedbackCommentChars: number;
      prFeedbackSummaryChars: number;
      questionTtlMs: number;
      policyVersion: string;
      impactModelVersion: string;
      replay: {
        storePromptPayloads: boolean;
        maxRunsWithPayloads: number;
        maxPayloadBytes: number;
      };
    };
    llm: PushPalsLlmConfig;
  };
  workerpals: {
    pollMs: number;
    heartbeatMs: number;
    executor: string;
    openhandsPython: string;
    openhandsTimeoutMs: number;
    miniswePython: string;
    minisweTimeoutMs: number;
    openaiCodexPython: string;
    openaiCodexTimeoutMs: number;
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
    fileModifyingJobs: string[];
    outputMaxChars: number;
    outputMaxLines: number;
    outputMaxHeadLines: number;
    qualityMaxAutoRevisions: number;
    qualityValidationStepTimeoutMs: number;
    qualityCriticTimeoutMs: number;
    qualitySoftPassOnExhausted: boolean;
    qualityCriticMinScore: number;
    qualityCriticMaxDiffChars: number;
    qualityCriticMaxValidationOutputChars: number;
    executorResultPrefix: string;
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
    checks: PushPalsCheckConfig[];
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
    reviewAgent: {
      enabled: boolean;
      pollIntervalMs: number;
      reviewerMdPath: string;
      passThreshold: number;
      maxPrCommentsBeforeGiveUp: number;
      mergeMethod: "squash" | "merge" | "rebase";
      codexBin: string;
      codexAuthMode: string;
      codexHomeDir: string;
      codexTimeoutMs: number;
    };
  };
  startup: {
    workerImageRebuild: "auto" | "always" | "never";
    logConfigOnStart: boolean;
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
    portPreflight: boolean;
    portConflictPolicy: "fail" | "terminate_pushpals";
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

export function invalidatePushPalsConfigCache(): void {
  cachedConfig = null;
  cachedConfigKey = "";
}

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
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function asCheckArray(value: unknown): PushPalsCheckConfig[] {
  if (!Array.isArray(value)) return [];
  const checks: PushPalsCheckConfig[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const name = asString(entry.name, "").trim();
    const command = asString(entry.command, "").trim();
    if (!name || !command) continue;
    const timeoutMs = Math.max(1_000, asInt(entry.timeout_ms ?? entry.timeoutMs, 300_000));
    checks.push({ name, command, timeoutMs });
  }
  return checks;
}

function asStringNumberRecord(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name) continue;
    const num =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseInt(raw.trim(), 10)
          : Number.NaN;
    if (!Number.isFinite(num)) continue;
    out[name] = Math.max(0, Math.floor(num));
  }
  return out;
}

function resolvePathFromRoot(projectRoot: string, value: string): string {
  if (!value) return projectRoot;
  if (isAbsolute(value)) return resolve(value);
  return resolve(projectRoot, value);
}

function resolveRuntimeConfigDir(projectRoot: string, configuredDir?: string): string {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(projectRoot, configuredDir);
  }

  const canonicalDir = resolvePathFromRoot(projectRoot, DEFAULT_CONFIG_DIR);
  const legacyDir = resolvePathFromRoot(projectRoot, LEGACY_CONFIG_DIR);
  if (existsSync(join(canonicalDir, "default.toml"))) return canonicalDir;
  if (existsSync(join(legacyDir, "default.toml"))) return legacyDir;
  return canonicalDir;
}

function parseTomlWithLegacyFallback(
  primaryPath: string,
  fallbackPath?: string,
): TomlObject {
  if (existsSync(primaryPath)) return parseTomlFile(primaryPath);
  if (fallbackPath && existsSync(fallbackPath)) return parseTomlFile(fallbackPath);
  return {};
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

function normalizeStartupPortConflictPolicy(value: string): "fail" | "terminate_pushpals" {
  const text = value.trim().toLowerCase().replace(/-/g, "_");
  if (
    text === "terminate_pushpals" ||
    text === "kill_pushpals" ||
    text === "auto_kill_pushpals"
  ) {
    return "terminate_pushpals";
  }
  return "fail";
}

function defaultApiKeyForBackend(backend: string, endpoint: string): string {
  const normalizedBackend = backend.trim().toLowerCase();
  const normalizedEndpoint = endpoint.trim().toLowerCase();
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();

  if (normalizedBackend === "openai") {
    return openAiKey;
  }
  if (normalizedBackend === "lmstudio") {
    return "lmstudio";
  }

  // Safety: if backend is omitted/legacy but endpoint points to OpenAI,
  // still allow OPENAI_API_KEY as fallback.
  if (normalizedEndpoint.includes("api.openai.com")) {
    return openAiKey;
  }
  return "";
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
    defaultApiKeyForBackend(backend, endpoint),
  );
  const reasoningEffort = firstNonEmpty(
    process.env[`${envPrefix}_LLM_REASONING_EFFORT`],
    asString(llmNode.reasoning_effort, ""),
  );
  const codexAuthMode = firstNonEmpty(
    process.env[`${envPrefix}_LLM_CODEX_AUTH_MODE`],
    asString(llmNode.codex_auth_mode, ""),
  );
  const codexBin = firstNonEmpty(
    process.env[`${envPrefix}_LLM_CODEX_BIN`],
    asString(llmNode.codex_bin, ""),
  );
  const codexTimeoutMs = Math.max(
    10_000,
    asInt(
      parseIntEnv(`${envPrefix}_LLM_CODEX_TIMEOUT_MS`) ?? llmNode.codex_timeout_ms,
      120_000,
    ),
  );
  return {
    backend,
    endpoint,
    model,
    sessionId,
    apiKey,
    reasoningEffort,
    codexAuthMode,
    codexBin,
    codexTimeoutMs,
  };
}

export function loadPushPalsConfig(options: LoadOptions = {}): PushPalsConfig {
  const projectRootOverride = firstNonEmpty(
    options.projectRoot,
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE,
    PROJECT_ROOT,
  );
  const projectRoot = resolve(projectRootOverride);
  const configDirOverride = firstNonEmpty(
    options.configDir,
    process.env.PUSHPALS_CONFIG_DIR_OVERRIDE,
    "",
  );
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const legacyConfigDir = resolvePathFromRoot(projectRoot, LEGACY_CONFIG_DIR);
  const fallbackConfigDir =
    !configDirOverride && configDir !== legacyConfigDir ? legacyConfigDir : "";
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }

  const defaultToml = parseTomlWithLegacyFallback(
    join(configDir, "default.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "default.toml") : undefined,
  );
  const preferredProfile = firstNonEmpty(
    process.env.PUSHPALS_PROFILE,
    asString(defaultToml.profile, "dev"),
    "dev",
  );
  const profileToml = parseTomlWithLegacyFallback(
    join(configDir, `${preferredProfile}.toml`),
    fallbackConfigDir ? join(fallbackConfigDir, `${preferredProfile}.toml`) : undefined,
  );
  const localExampleToml = parseTomlWithLegacyFallback(
    join(configDir, "local.example.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "local.example.toml") : undefined,
  );
  const localToml = parseTomlWithLegacyFallback(
    join(configDir, "local.toml"),
    fallbackConfigDir ? join(fallbackConfigDir, "local.toml") : undefined,
  );
  const merged = mergeDeep(
    mergeDeep(mergeDeep(defaultToml, profileToml), localExampleToml),
    localToml,
  );

  const profile = firstNonEmpty(
    process.env.PUSHPALS_PROFILE,
    asString(merged.profile, preferredProfile),
    preferredProfile,
  );
  const sessionId = firstNonEmpty(
    process.env.PUSHPALS_SESSION_ID,
    asString(merged.session_id, "dev"),
    "dev",
  );

  const llmNode = getObject(merged, "llm");
  const lmStudioNode = getObject(llmNode, "lmstudio");
  const lmStudioContextWindow = Math.max(
    512,
    asInt(parseIntEnv("PUSHPALS_LMSTUDIO_CONTEXT_WINDOW") ?? lmStudioNode.context_window, 4096),
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
    firstNonEmpty(
      process.env.PUSHPALS_DB_PATH,
      asString(pathsNode.shared_db_path, join(dataDir, "pushpals.db")),
    ),
  );
  const remotebuddyDbPath = resolvePathFromRoot(
    projectRoot,
    firstNonEmpty(
      process.env.REMOTEBUDDY_DB_PATH,
      asString(pathsNode.remotebuddy_db_path, join(dataDir, "remotebuddy-state.db")),
    ),
  );

  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(1, asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001));
  const serverUrl = firstNonEmpty(
    process.env.PUSHPALS_SERVER_URL,
    asString(serverNode.url, `http://localhost:${serverPort}`),
    `http://localhost:${serverPort}`,
  );
  const serverHost = asString(serverNode.host, "0.0.0.0");
  const debugHttp = parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(
    5_000,
    asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms, 120_000),
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
  const localEnabled = parseBoolEnv("LOCALBUDDY_ENABLED") ?? asBoolean(localNode.enabled, false);
  const localPort = Math.max(1, asInt(parseIntEnv("LOCAL_AGENT_PORT") ?? localNode.port, 3003));
  const localStatusHeartbeatMs = Math.max(
    0,
    asInt(
      parseIntEnv("LOCALBUDDY_STATUS_HEARTBEAT_MS") ??
        globalStatusHeartbeatMs ??
        localNode.status_heartbeat_ms,
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
  const remoteMemoryNode = getObject(remoteNode, "memory");
  const remoteMemoryEnabled =
    parseBoolEnv("REMOTEBUDDY_MEMORY_ENABLED") ?? asBoolean(remoteMemoryNode.enabled, true);
  const remoteMemoryIncludeCrossSession =
    parseBoolEnv("REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION") ??
    asBoolean(remoteMemoryNode.include_cross_session, true);
  const remoteMemoryMaxRecallItems = Math.max(
    1,
    Math.min(
      128,
      asInt(
        parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS") ?? remoteMemoryNode.max_recall_items,
        DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS,
      ),
    ),
  );
  const remoteMemoryMaxRecallChars = Math.max(
    120,
    Math.min(
      64_000,
      asInt(
        parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS") ?? remoteMemoryNode.max_recall_chars,
        DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS,
      ),
    ),
  );
  const remoteMemoryMaxSummaryChars = Math.max(
    64,
    Math.min(
      16_000,
      asInt(
        parseIntEnv("REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS") ?? remoteMemoryNode.max_summary_chars,
        DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS,
      ),
    ),
  );
  const remoteMemoryRetentionDays = Math.max(
    1,
    Math.min(
      3650,
      asInt(
        parseIntEnv("REMOTEBUDDY_MEMORY_RETENTION_DAYS") ?? remoteMemoryNode.retention_days,
        DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS,
      ),
    ),
  );
  const remoteAutonomyNode = getObject(remoteNode, "autonomy");
  const remoteAutonomyReplayNode = getObject(remoteAutonomyNode, "replay");
  const remoteAutonomyDispatchByTypeCfg = {
    flaky_test: 4,
    lint_fix: 3,
    type_fix: 3,
    small_refactor: 2,
    feature_small: 2,
    feature_medium: 1,
    feature_large: 0,
    docs: 1,
    dep_bump: 0,
  };
  const remoteAutonomyDispatchByType = {
    ...remoteAutonomyDispatchByTypeCfg,
    ...asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_type),
  };
  const remoteAutonomyDispatchByComponentCfg = {
    "apps/server": 3,
    "apps/remotebuddy": 2,
    "apps/workerpals": 2,
    "apps/client": 2,
    "packages/protocol": 1,
    "packages/shared": 2,
    "tests/integration": 2,
    "tests/unit": 2,
  };
  const remoteAutonomyDispatchByComponentRaw = asStringNumberRecord(
    remoteAutonomyNode.max_dispatch_per_hour_by_component,
  );
  const remoteAutonomyDispatchByComponent: Record<string, number> = {
    ...remoteAutonomyDispatchByComponentCfg,
  };
  const normalizeAutonomyComponentKey = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/_+/g, "/")
      .replace(/-+/g, "/")
      .replace(/\/+/g, "/");
  const canonicalComponentByNormalized = new Map<string, string>(
    Object.keys(remoteAutonomyDispatchByComponentCfg).map((key) => [normalizeAutonomyComponentKey(key), key]),
  );
  for (const [rawKey, rawValue] of Object.entries(remoteAutonomyDispatchByComponentRaw)) {
    const normalized = normalizeAutonomyComponentKey(rawKey);
    const canonical = canonicalComponentByNormalized.get(normalized);
    if (!canonical) continue;
    const parsed =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string"
          ? Number.parseInt(rawValue.trim(), 10)
          : Number.NaN;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed)
      ? Math.max(0, Math.floor(parsed))
      : 0;
  }

  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerPollMs = Math.max(
    200,
    asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2_000),
  );
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
  const workerMiniswePython = firstNonEmpty(
    process.env.WORKERPALS_MINISWE_PYTHON,
    asString(workerNode.miniswe_python, "python"),
    "python",
  );
  const workerMinisweTimeoutMs = Math.max(
    10_000,
    asInt(parseIntEnv("WORKERPALS_MINISWE_TIMEOUT_MS") ?? workerNode.miniswe_timeout_ms, 1_800_000),
  );
  const workerOpenAICodexPython = firstNonEmpty(
    process.env.PUSHPALS_OPENAI_CODEX_PYTHON,
    asString(workerNode.openai_codex_python, "python"),
    "python",
  );
  const workerOpenAICodexTimeoutMs = Math.max(
    10_000,
    asInt(workerNode.openai_codex_timeout_ms, 7_200_000),
  );
  const workerQualityMaxAutoRevisions = Math.max(
    0,
    Math.min(
      10,
      asInt(
        parseIntEnv("WORKERPALS_QUALITY_MAX_AUTO_REVISIONS") ?? workerNode.quality_max_auto_revisions,
        DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS,
      ),
    ),
  );
  const workerFileModifyingJobs = (() => {
    const envRaw = firstNonEmpty(process.env.WORKERPALS_FILE_MODIFYING_JOBS);
    const parsed = envRaw
      ? envRaw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : asStringArray(workerNode.file_modifying_jobs);
    const out = parsed.length > 0 ? parsed : DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS;
    return [...new Set(out)];
  })();
  const workerOutputMaxChars = Math.max(
    8_192,
    Math.min(
      4_194_304,
      asInt(
        parseIntEnv("WORKERPALS_OUTPUT_MAX_CHARS") ?? workerNode.output_max_chars,
        DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS,
      ),
    ),
  );
  const workerOutputMaxLines = Math.max(
    50,
    Math.min(
      20_000,
      asInt(
        parseIntEnv("WORKERPALS_OUTPUT_MAX_LINES") ?? workerNode.output_max_lines,
        DEFAULT_WORKERPALS_OUTPUT_MAX_LINES,
      ),
    ),
  );
  const workerOutputMaxHeadLines = Math.max(
    1,
    Math.min(
      workerOutputMaxLines,
      asInt(
        parseIntEnv("WORKERPALS_OUTPUT_MAX_HEAD_LINES") ?? workerNode.output_max_head_lines,
        DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES,
      ),
    ),
  );
  const workerQualityValidationStepTimeoutMs = Math.max(
    1_000,
    asInt(
      parseIntEnv("WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS") ??
        workerNode.quality_validation_step_timeout_ms,
      DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS,
    ),
  );
  const workerQualityCriticTimeoutMs = Math.max(
    1_000,
    asInt(
      parseIntEnv("WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS") ??
        workerNode.quality_critic_timeout_ms,
      DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS,
    ),
  );
  const workerQualitySoftPassOnExhausted =
    parseBoolEnv("WORKERPALS_QUALITY_SOFT_PASS_ON_EXHAUSTED") ??
    asBoolean(workerNode.quality_soft_pass_on_exhausted, true);
  const workerQualityCriticMinScore = (() => {
    const configThresholdRaw =
      workerNode.quality_critic_min_score == null
        ? ""
        : String(workerNode.quality_critic_min_score);
    const raw = firstNonEmpty(
      process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE,
      configThresholdRaw,
      String(DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE),
    );
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    return Math.max(0, Math.min(10, parsed));
  })();
  const workerQualityCriticMaxDiffChars = Math.max(
    256,
    Math.min(
      524_288,
      asInt(
        parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS") ??
          workerNode.quality_critic_max_diff_chars,
        DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS,
      ),
    ),
  );
  const workerQualityCriticMaxValidationOutputChars = Math.max(
    256,
    Math.min(
      524_288,
      asInt(
        parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS") ??
          workerNode.quality_critic_max_validation_output_chars,
        DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS,
      ),
    ),
  );
  const workerExecutorResultPrefix = (() => {
    if (process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX !== undefined) {
      const raw = process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX;
      if (typeof raw === "string" && raw.length > 0) return raw;
    }
    if (
      Object.prototype.hasOwnProperty.call(workerNode, "executor_result_prefix") &&
      typeof workerNode.executor_result_prefix === "string" &&
      workerNode.executor_result_prefix.length > 0
    ) {
      return workerNode.executor_result_prefix;
    }
    return DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX;
  })();
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
      120,
      asInt(
        parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES") ??
          workerOpenHandsNode.auto_steer_max_nudges,
        30,
      ),
    ),
  );
  const workerRequirePush =
    parseBoolEnv("WORKERPALS_REQUIRE_PUSH") ?? asBoolean(workerNode.require_push, false);
  const workerPushAgentBranchEnv = parseBoolEnv("WORKERPALS_PUSH_AGENT_BRANCH");
  const workerPushAgentBranch =
    workerRequirePush ||
    (workerPushAgentBranchEnv ?? asBoolean(workerNode.push_agent_branch, false));
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
  const scmChecks = asCheckArray(scmNode.checks);
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

  const scmReviewAgentNode = getObject(scmNode, "review_agent");
  const scmReviewAgentEnabled =
    parseBoolEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_ENABLED") ??
    asBoolean(scmReviewAgentNode.enabled, false);
  const scmReviewAgentPollIntervalMs = Math.max(
    5_000,
    asInt(
      parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_POLL_INTERVAL_MS") ??
        scmReviewAgentNode.poll_interval_ms,
      60_000,
    ),
  );
  const scmReviewAgentReviewerMdPath = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_REVIEWER_MD_PATH,
    asString(scmReviewAgentNode.reviewer_md_path, "prompts/review_agent/reviewer.md"),
    "prompts/review_agent/reviewer.md",
  );
  const scmReviewAgentPassThreshold = (() => {
    const configThresholdRaw =
      scmReviewAgentNode.pass_threshold == null ? "" : String(scmReviewAgentNode.pass_threshold);
    const raw = firstNonEmpty(
      process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD,
      configThresholdRaw,
      "9.5",
    );
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 9.5;
  })();
  const scmReviewAgentMaxPrCommentsBeforeGiveUp = Math.max(
    1,
    Math.min(
      100,
      asInt(
        parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP") ??
          scmReviewAgentNode.max_pr_comments_before_give_up,
        10,
      ),
    ),
  );
  const scmReviewAgentMergeMethodRaw = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MERGE_METHOD,
    asString(scmReviewAgentNode.merge_method, "squash"),
    "squash",
  ).toLowerCase();
  const scmReviewAgentMergeMethod: "squash" | "merge" | "rebase" =
    scmReviewAgentMergeMethodRaw === "merge" || scmReviewAgentMergeMethodRaw === "rebase"
      ? scmReviewAgentMergeMethodRaw
      : "squash";
  const scmReviewAgentCodexBin = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_BIN,
    asString(scmReviewAgentNode.codex_bin, "bun x --yes @openai/codex"),
    "bun x --yes @openai/codex",
  );
  const scmReviewAgentCodexAuthMode = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_AUTH_MODE,
    asString(scmReviewAgentNode.codex_auth_mode, "chatgpt"),
    "chatgpt",
  );
  const scmReviewAgentCodexHomeDir = firstNonEmpty(
    process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_HOME_DIR,
    asString(scmReviewAgentNode.codex_home_dir, ""),
  );
  const scmReviewAgentCodexTimeoutMs = Math.max(
    30_000,
    asInt(
      parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_TIMEOUT_MS") ??
        scmReviewAgentNode.codex_timeout_ms,
      300_000,
    ),
  );

  const startupNode = getObject(merged, "startup");
  const startupWorkerImageRebuild = normalizeWorkerImageRebuildMode(
    firstNonEmpty(
      process.env.PUSHPALS_WORKER_IMAGE_REBUILD,
      asString(startupNode.worker_image_rebuild, "auto"),
      "auto",
    ),
  );
  const startupLogConfigOnStart =
    parseBoolEnv("PUSHPALS_LOG_CONFIG_ON_START") ??
    asBoolean(startupNode.log_config_on_start, true);
  const startupSyncIntegrationWithMain =
    parseBoolEnv("PUSHPALS_SYNC_INTEGRATION_WITH_MAIN") ??
    asBoolean(startupNode.sync_integration_with_main, true);
  const startupSkipLlmPreflight =
    parseBoolEnv("PUSHPALS_SKIP_LLM_PREFLIGHT") ?? asBoolean(startupNode.skip_llm_preflight, false);
  const startupAutoStartLmStudio =
    parseBoolEnv("PUSHPALS_AUTO_START_LMSTUDIO") ??
    asBoolean(startupNode.auto_start_lmstudio, true);
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
    Math.min(
      65_535,
      asInt(parseIntEnv("PUSHPALS_LMSTUDIO_PORT") ?? startupNode.lmstudio_port, 1234),
    ),
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
    parseBoolEnv("PUSHPALS_ALLOW_EXTERNAL_CLEAN") ??
    asBoolean(startupNode.allow_external_clean, false);
  const startupPortPreflight =
    parseBoolEnv("PUSHPALS_STARTUP_PORT_PREFLIGHT") ??
    asBoolean(startupNode.port_preflight, true);
  const startupPortConflictPolicy = normalizeStartupPortConflictPolicy(
    firstNonEmpty(
      process.env.PUSHPALS_STARTUP_PORT_CONFLICT_POLICY,
      asString(startupNode.port_conflict_policy, "terminate_pushpals"),
      "terminate_pushpals",
    ),
  );

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
      enabled: localEnabled,
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
        asInt(remoteNode.max_workerpals, 20),
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
        parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ??
        asBoolean(remoteNode.workerpal_docker, true),
      workerpalRequireDocker:
        parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ??
        asBoolean(remoteNode.workerpal_require_docker, true),
      workerpalImage:
        firstNonEmpty(
          process.env.REMOTEBUDDY_WORKERPAL_IMAGE,
          asString(remoteNode.workerpal_image, ""),
        ) || null,
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
      crashRestartEnabled:
        parseBoolEnv("REMOTEBUDDY_CRASH_RESTART_ENABLED") ??
        asBoolean(remoteNode.crash_restart_enabled, true),
      crashRestartMaxRestarts: Math.max(
        0,
        asInt(
          parseIntEnv("REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS") ??
            remoteNode.crash_restart_max_restarts,
          3,
        ),
      ),
      crashRestartBackoffMs: Math.max(
        0,
        asInt(
          parseIntEnv("REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS") ??
            remoteNode.crash_restart_backoff_ms,
          3_000,
        ),
      ),
      memory: {
        enabled: remoteMemoryEnabled,
        includeCrossSession: remoteMemoryIncludeCrossSession,
        maxRecallItems: remoteMemoryMaxRecallItems,
        maxRecallChars: remoteMemoryMaxRecallChars,
        maxSummaryChars: remoteMemoryMaxSummaryChars,
        retentionDays: remoteMemoryRetentionDays,
      },
      autonomy: {
        enabled:
          parseBoolEnv("REMOTEBUDDY_AUTONOMY_ENABLED") ??
          asBoolean(remoteAutonomyNode.enabled, false),
        killSwitchEnabled:
          parseBoolEnv("REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED") ??
          asBoolean(remoteAutonomyNode.kill_switch_enabled, false),
        tickIntervalMs: Math.max(
          5_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_TICK_INTERVAL_MS") ??
              remoteAutonomyNode.tick_interval_ms,
            120_000,
          ),
        ),
        heartbeatLogMs: Math.max(
          1_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS") ??
              remoteAutonomyNode.heartbeat_log_ms,
            30_000,
          ),
        ),
        visionContextMaxChars: Math.max(
          1_000,
          Math.min(
            1_000_000,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS") ??
                remoteAutonomyNode.vision_context_max_chars,
              65_536,
            ),
          ),
        ),
        ideationBudgetMs: Math.max(
          1_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_BUDGET_MS") ??
              remoteAutonomyNode.ideation_budget_ms,
            20_000,
          ),
        ),
        llmTimeoutMs: Math.max(
          1_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_LLM_TIMEOUT_MS") ??
              remoteAutonomyNode.llm_timeout_ms,
            12_000,
          ),
        ),
        allowDirtyWorktree:
          parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE") ??
          asBoolean(remoteAutonomyNode.allow_dirty_worktree, false),
        ideationMaxCandidates: Math.max(
          1,
          Math.min(
            100,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_MAX_CANDIDATES") ??
                remoteAutonomyNode.ideation_max_candidates,
              20,
            ),
          ),
        ),
        topK: Math.max(
          1,
          Math.min(
            20,
            asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TOP_K") ?? remoteAutonomyNode.top_k, 3),
          ),
        ),
        exploreRate: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_EXPLORE_RATE,
                    asString(remoteAutonomyNode.explore_rate, "0.3"),
                    "0.3",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.3;
            })(),
          ),
        ),
        minConfidence: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_MIN_CONFIDENCE,
                    asString(remoteAutonomyNode.min_confidence, "0.65"),
                    "0.65",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.65;
            })(),
          ),
        ),
        maxConcurrentObjectives: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_CONCURRENT_OBJECTIVES") ??
              remoteAutonomyNode.max_concurrent_objectives,
            2,
          ),
        ),
        maxDispatchPerHour: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_DISPATCH_PER_HOUR") ??
              remoteAutonomyNode.max_dispatch_per_hour,
            6,
          ),
        ),
        maxDispatchPerHourByType: remoteAutonomyDispatchByType,
        maxDispatchPerHourByComponent: remoteAutonomyDispatchByComponent,
        maxTokenUsagePerHour: Math.max(
          0,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR") ??
              remoteAutonomyNode.max_token_usage_per_hour,
            120_000,
          ),
        ),
        maxRuntimeMsPerHour: Math.max(
          0,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_RUNTIME_MS_PER_HOUR") ??
              remoteAutonomyNode.max_runtime_ms_per_hour,
            5_400_000,
          ),
        ),
        cooldownFailStreakThreshold: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_FAIL_STREAK_THRESHOLD") ??
              remoteAutonomyNode.cooldown_fail_streak_threshold,
            2,
          ),
        ),
        cooldownMs: Math.max(
          1_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_MS") ?? remoteAutonomyNode.cooldown_ms,
            1_800_000,
          ),
        ),
        staleObjectiveTtlMs: Math.max(
          60_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_TTL_MS") ??
              remoteAutonomyNode.stale_objective_ttl_ms,
            2_700_000,
          ),
        ),
        staleObjectiveSweepIntervalMs: Math.max(
          5_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_SWEEP_INTERVAL_MS") ??
              remoteAutonomyNode.stale_objective_sweep_interval_ms,
            60_000,
          ),
        ),
        autoFreezeFailStreakThreshold: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_FAIL_STREAK_THRESHOLD") ??
              remoteAutonomyNode.auto_freeze_fail_streak_threshold,
            3,
          ),
        ),
        autoFreezeDurationMs: Math.max(
          60_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_DURATION_MS") ??
              remoteAutonomyNode.auto_freeze_duration_ms,
            1_800_000,
          ),
        ),
        evaluatorWindowHours: Math.max(
          1,
          Math.min(
            168,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_WINDOW_HOURS") ??
                remoteAutonomyNode.evaluator_window_hours,
              24,
            ),
          ),
        ),
        evaluatorMinSamples: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SAMPLES") ??
              remoteAutonomyNode.evaluator_min_samples,
            6,
          ),
        ),
        evaluatorMinSuccessRate: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SUCCESS_RATE,
                    asString(remoteAutonomyNode.evaluator_min_success_rate, "0.45"),
                    "0.45",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.45;
            })(),
          ),
        ),
        evaluatorMaxRegretRate: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MAX_REGRET_RATE,
                    asString(remoteAutonomyNode.evaluator_max_regret_rate, "0.35"),
                    "0.35",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.35;
            })(),
          ),
        ),
        evaluatorRunIntervalMs: Math.max(
          10_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_RUN_INTERVAL_MS") ??
              remoteAutonomyNode.evaluator_run_interval_ms,
            120_000,
          ),
        ),
        alertQueuePendingThreshold: Math.max(
          1,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_ALERT_QUEUE_PENDING_THRESHOLD") ??
              remoteAutonomyNode.alert_queue_pending_threshold,
            20,
          ),
        ),
        alertJobFailureRateThreshold: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_ALERT_JOB_FAILURE_RATE_THRESHOLD,
                    asString(remoteAutonomyNode.alert_job_failure_rate_threshold, "0.3"),
                    "0.3",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.3;
            })(),
          ),
        ),
        alertAutonomyFailureRateThreshold: Math.max(
          0,
          Math.min(
            1,
            (() => {
              const parsed = Number.parseFloat(
                String(
                  firstNonEmpty(
                    process.env.REMOTEBUDDY_AUTONOMY_ALERT_AUTONOMY_FAILURE_RATE_THRESHOLD,
                    asString(remoteAutonomyNode.alert_autonomy_failure_rate_threshold, "0.45"),
                    "0.45",
                  ),
                ),
              );
              return Number.isFinite(parsed) ? parsed : 0.45;
            })(),
          ),
        ),
        allowReadAnywhere:
          parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_READ_ANYWHERE") ??
          asBoolean(remoteAutonomyNode.allow_read_anywhere, false),
        prFeedbackCommentRows: Math.max(
          1,
          Math.min(
            200,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_ROWS") ??
                remoteAutonomyNode.pr_feedback_comment_rows,
              16,
            ),
          ),
        ),
        prFeedbackCommentChars: Math.max(
          32,
          Math.min(
            20_000,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_CHARS") ??
                remoteAutonomyNode.pr_feedback_comment_chars,
              600,
            ),
          ),
        ),
        prFeedbackSummaryChars: Math.max(
          32,
          Math.min(
            20_000,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_SUMMARY_CHARS") ??
                remoteAutonomyNode.pr_feedback_summary_chars,
              600,
            ),
          ),
        ),
        questionTtlMs: Math.max(
          60_000,
          asInt(
            parseIntEnv("REMOTEBUDDY_AUTONOMY_QUESTION_TTL_MS") ??
              remoteAutonomyNode.question_ttl_ms,
            259_200_000,
          ),
        ),
        policyVersion: firstNonEmpty(
          process.env.REMOTEBUDDY_AUTONOMY_POLICY_VERSION,
          asString(remoteAutonomyNode.policy_version, "policy-v3.3"),
          "policy-v3.3",
        ),
        impactModelVersion: firstNonEmpty(
          process.env.REMOTEBUDDY_AUTONOMY_IMPACT_MODEL_VERSION,
          asString(remoteAutonomyNode.impact_model_version, "impact-v1"),
          "impact-v1",
        ),
        replay: {
          storePromptPayloads:
            parseBoolEnv("REMOTEBUDDY_AUTONOMY_REPLAY_STORE_PROMPT_PAYLOADS") ??
            asBoolean(remoteAutonomyReplayNode.store_prompt_payloads, false),
          maxRunsWithPayloads: Math.max(
            0,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_RUNS_WITH_PAYLOADS") ??
                remoteAutonomyReplayNode.max_runs_with_payloads,
              50,
            ),
          ),
          maxPayloadBytes: Math.max(
            1024,
            asInt(
              parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_PAYLOAD_BYTES") ??
                remoteAutonomyReplayNode.max_payload_bytes,
              262_144,
            ),
          ),
        },
      },
      llm: remoteLlm,
    },
    workerpals: {
      pollMs: workerPollMs,
      heartbeatMs: workerHeartbeatMs,
      executor: workerExecutor,
      openhandsPython: workerOpenHandsPython,
      openhandsTimeoutMs: workerOpenHandsTimeoutMs,
      miniswePython: workerMiniswePython,
      minisweTimeoutMs: workerMinisweTimeoutMs,
      openaiCodexPython: workerOpenAICodexPython,
      openaiCodexTimeoutMs: workerOpenAICodexTimeoutMs,
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
        asInt(
          parseIntEnv("WORKERPALS_DOCKER_TIMEOUT_MS") ?? workerNode.docker_timeout_ms,
          7_260_000,
        ),
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
      fileModifyingJobs: workerFileModifyingJobs,
      outputMaxChars: workerOutputMaxChars,
      outputMaxLines: workerOutputMaxLines,
      outputMaxHeadLines: workerOutputMaxHeadLines,
      qualityMaxAutoRevisions: workerQualityMaxAutoRevisions,
      qualityValidationStepTimeoutMs: workerQualityValidationStepTimeoutMs,
      qualityCriticTimeoutMs: workerQualityCriticTimeoutMs,
      qualitySoftPassOnExhausted: workerQualitySoftPassOnExhausted,
      qualityCriticMinScore: workerQualityCriticMinScore,
      qualityCriticMaxDiffChars: workerQualityCriticMaxDiffChars,
      qualityCriticMaxValidationOutputChars: workerQualityCriticMaxValidationOutputChars,
      executorResultPrefix: workerExecutorResultPrefix,
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
      checks: scmChecks,
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
      reviewAgent: {
        enabled: scmReviewAgentEnabled,
        pollIntervalMs: scmReviewAgentPollIntervalMs,
        reviewerMdPath: scmReviewAgentReviewerMdPath,
        passThreshold: scmReviewAgentPassThreshold,
        maxPrCommentsBeforeGiveUp: scmReviewAgentMaxPrCommentsBeforeGiveUp,
        mergeMethod: scmReviewAgentMergeMethod,
        codexBin: scmReviewAgentCodexBin,
        codexAuthMode: scmReviewAgentCodexAuthMode,
        codexHomeDir: scmReviewAgentCodexHomeDir,
        codexTimeoutMs: scmReviewAgentCodexTimeoutMs,
      },
    },
    startup: {
      workerImageRebuild: startupWorkerImageRebuild,
      logConfigOnStart: startupLogConfigOnStart,
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
      portPreflight: startupPortPreflight,
      portConflictPolicy: startupPortConflictPolicy,
    },
    client: {
      localAgentUrl: firstNonEmpty(
        process.env.EXPO_PUBLIC_LOCAL_AGENT_URL,
        asString(clientNode.local_agent_url, `http://localhost:${localPort}`),
        `http://localhost:${localPort}`,
      ),
      traceTailLines: Math.max(
        10,
        asInt(
          parseIntEnv("EXPO_PUBLIC_PUSHPALS_TRACE_TAIL_LINES") ?? clientNode.trace_tail_lines,
          100,
        ),
      ),
    },
  };

  cachedConfig = config;
  cachedConfigKey = cacheKey;
  return config;
}

function sanitizeConfigString(value: string): string {
  let out = String(value ?? "");
  if (!out) return out;
  // redact URL userinfo credentials: https://user:pass@host -> https://***@host
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  // redact malformed/encoded scheme userinfo from legacy rewrite bugs: https%3A//user%3Apass@host
  out = out.replace(/https%3a\/\/[^@\s/]+@/gi, "https%3A//***@");
  // redact bearer tokens
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-:+/=]+\b/gi, "$1***");
  // redact common token formats
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  out = out.replace(/\bglpat-[A-Za-z0-9\-_]{20,}\b/gi, "glpat-***");
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-***");
  return out;
}

function sanitizeConfigValueForLogging(
  value: unknown,
  parentKey = "",
): unknown {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value == null
  ) {
    if (typeof value === "string") {
      if (SENSITIVE_CONFIG_KEY_PATTERN.test(parentKey)) {
        return value.trim() ? REDACTED_LOG_VALUE : "";
      }
      return sanitizeConfigString(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConfigValueForLogging(entry, parentKey));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeConfigValueForLogging(entry, key);
    }
    return out;
  }

  return String(value);
}

export function sanitizePushPalsConfigForLogging<T>(value: T): T {
  return sanitizeConfigValueForLogging(value) as T;
}
