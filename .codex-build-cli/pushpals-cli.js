#!/usr/bin/env bun
// @bun

// scripts/pushpals-cli.ts
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync as existsSync4,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync as readFileSync4,
  rmSync,
  writeFileSync
} from "fs";
import { basename, delimiter, dirname, extname, join as join2, resolve as resolve4, win32 as pathWin32 } from "path";
import { createInterface } from "readline";

// packages/shared/src/client_preflight.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { relative, resolve as resolve2 } from "path";

// packages/shared/src/config.ts
import { existsSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";

// packages/shared/src/autonomy_policy.ts
var DRIVE_RE = /^[A-Za-z]:\//;
var SLASH_RE = /\/+/g;
function normalizeAutonomyComponentArea(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  return normalized;
}
function normalizeRepoRelativePath(value) {
  if (typeof value !== "string")
    return null;
  let path = value.trim();
  if (!path)
    return null;
  path = path.normalize("NFC").replace(/\\/g, "/");
  if (path.startsWith("/"))
    return null;
  if (DRIVE_RE.test(path))
    return null;
  path = path.replace(SLASH_RE, "/");
  const out = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".")
      continue;
    if (segment === "..")
      return null;
    out.push(segment);
  }
  if (out.length === 0)
    return null;
  return out.join("/");
}

// packages/shared/src/local_network.ts
var DEFAULT_LOCAL_LOOPBACK_HOST = "127.0.0.1";
function isLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
function normalizeLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(normalized))
    return DEFAULT_LOCAL_LOOPBACK_HOST;
  return DEFAULT_LOCAL_LOOPBACK_HOST;
}
function normalizeLoopbackHttpUrl(value, fallbackPort) {
  const fallback = `http://${DEFAULT_LOCAL_LOOPBACK_HOST}:${Math.max(1, fallbackPort)}`;
  const text = String(value ?? "").trim();
  if (!text)
    return fallback;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = normalizeLoopbackHost(parsed.hostname);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.port) {
      parsed.port = String(Math.max(1, fallbackPort));
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

// packages/shared/src/config.ts
var PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
var DEFAULT_CONFIG_DIR = "configs";
var LEGACY_CONFIG_DIR = "config";
var TRUTHY = new Set(["1", "true", "yes", "on"]);
var FALSY = new Set(["0", "false", "no", "off"]);
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE = 8;
var DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 1;
var DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
var DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
var DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
var DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
var DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 45000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8000;
var DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
var DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
var cachedConfig = null;
var cachedConfigKey = "";
function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return "";
}
function parseBoolEnv(name) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw)
    return null;
  if (TRUTHY.has(raw))
    return true;
  if (FALSY.has(raw))
    return false;
  return null;
}
function parseIntEnv(name) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw)
    return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseTomlFile(path) {
  if (!existsSync(path))
    return {};
  const raw = readFileSync(path, "utf-8");
  const parsed = Bun.TOML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed;
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function mergeDeep(base, override) {
  const out = { ...base };
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
function getObject(parent, key) {
  const value = parent[key];
  if (isObject(value))
    return value;
  return {};
}
function asString(value, fallback) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  return fallback;
}
function asBoolean(value, fallback) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUTHY.has(lowered))
      return true;
    if (FALSY.has(lowered))
      return false;
  }
  return fallback;
}
function asInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function asIntOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return null;
}
function asStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function asCheckArray(value) {
  if (!Array.isArray(value))
    return [];
  const checks = [];
  for (const entry of value) {
    if (!isObject(entry))
      continue;
    const name = asString(entry.name, "").trim();
    const command = asString(entry.command, "").trim();
    if (!name || !command)
      continue;
    const timeoutMs = Math.max(1000, asInt(entry.timeout_ms ?? entry.timeoutMs, 300000));
    checks.push({ name, command, timeoutMs });
  }
  return checks;
}
function asStringNumberRecord(value) {
  if (!isObject(value))
    return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name)
      continue;
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
    if (!Number.isFinite(num))
      continue;
    out[name] = Math.max(0, Math.floor(num));
  }
  return out;
}
function resolvePathFromRoot(projectRoot, value) {
  if (!value)
    return projectRoot;
  if (isAbsolute(value))
    return resolve(value);
  return resolve(projectRoot, value);
}
function resolveRuntimeConfigDir(projectRoot, configuredDir) {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(projectRoot, configuredDir);
  }
  const canonicalDir = resolvePathFromRoot(projectRoot, DEFAULT_CONFIG_DIR);
  const legacyDir = resolvePathFromRoot(projectRoot, LEGACY_CONFIG_DIR);
  if (existsSync(join(canonicalDir, "default.toml")))
    return canonicalDir;
  if (existsSync(join(legacyDir, "default.toml")))
    return legacyDir;
  return canonicalDir;
}
function parseTomlWithLegacyFallback(primaryPath, fallbackPath) {
  if (existsSync(primaryPath))
    return parseTomlFile(primaryPath);
  if (fallbackPath && existsSync(fallbackPath))
    return parseTomlFile(fallbackPath);
  return {};
}
function normalizeBackend(value) {
  const text = value.trim().toLowerCase();
  if (!text)
    return "lmstudio";
  if (text === "openai_compatible")
    return "lmstudio";
  if (text === "ollama_chat")
    return "ollama";
  return text;
}
function normalizeWorkerImageRebuildMode(value) {
  const text = value.trim().toLowerCase();
  if (text === "always" || text === "1" || text === "true" || text === "yes" || text === "on") {
    return "always";
  }
  if (text === "never" || text === "0" || text === "false" || text === "no" || text === "off") {
    return "never";
  }
  return "auto";
}
function normalizeStartupPortConflictPolicy(value) {
  const text = value.trim().toLowerCase().replace(/-/g, "_");
  if (text === "terminate_pushpals" || text === "kill_pushpals" || text === "auto_kill_pushpals") {
    return "terminate_pushpals";
  }
  return "fail";
}
function defaultApiKeyForBackend(backend, endpoint) {
  const normalizedBackend = backend.trim().toLowerCase();
  const normalizedEndpoint = endpoint.trim().toLowerCase();
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (normalizedBackend === "openai") {
    return openAiKey;
  }
  if (normalizedBackend === "lmstudio") {
    return "lmstudio";
  }
  if (normalizedEndpoint.includes("api.openai.com")) {
    return openAiKey;
  }
  return "";
}
function resolveLlmConfig(serviceNode, envPrefix, defaults, globalSessionId) {
  const llmNode = getObject(serviceNode, "llm");
  const backend = normalizeBackend(firstNonEmpty(process.env[`${envPrefix}_LLM_BACKEND`], asString(llmNode.backend, defaults.backend), defaults.backend));
  const endpoint = firstNonEmpty(process.env[`${envPrefix}_LLM_ENDPOINT`], asString(llmNode.endpoint, defaults.endpoint), defaults.endpoint);
  const model = firstNonEmpty(process.env[`${envPrefix}_LLM_MODEL`], asString(llmNode.model, defaults.model), defaults.model);
  const sessionId = firstNonEmpty(process.env[`${envPrefix}_LLM_SESSION_ID`], asString(llmNode.session_id, defaults.sessionId), process.env.PUSHPALS_LLM_SESSION_ID, globalSessionId);
  const apiKey = firstNonEmpty(process.env[`${envPrefix}_LLM_API_KEY`], defaultApiKeyForBackend(backend, endpoint));
  const reasoningEffort = firstNonEmpty(process.env[`${envPrefix}_LLM_REASONING_EFFORT`], asString(llmNode.reasoning_effort, ""));
  const codexAuthMode = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_AUTH_MODE`], asString(llmNode.codex_auth_mode, ""));
  const codexBin = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_BIN`], asString(llmNode.codex_bin, ""));
  const codexTimeoutMs = Math.max(1e4, asInt(parseIntEnv(`${envPrefix}_LLM_CODEX_TIMEOUT_MS`) ?? llmNode.codex_timeout_ms, 120000));
  return {
    backend,
    endpoint,
    model,
    sessionId,
    apiKey,
    reasoningEffort,
    codexAuthMode,
    codexBin,
    codexTimeoutMs
  };
}
function loadPushPalsConfig(options = {}) {
  const projectRootOverride = firstNonEmpty(options.projectRoot, process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE, PROJECT_ROOT);
  const projectRoot = resolve(projectRootOverride);
  const configDirOverride = firstNonEmpty(options.configDir, process.env.PUSHPALS_CONFIG_DIR_OVERRIDE, "");
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const legacyConfigDir = resolvePathFromRoot(projectRoot, LEGACY_CONFIG_DIR);
  const fallbackConfigDir = !configDirOverride && configDir !== legacyConfigDir ? legacyConfigDir : "";
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }
  const defaultToml = parseTomlWithLegacyFallback(join(configDir, "default.toml"), fallbackConfigDir ? join(fallbackConfigDir, "default.toml") : undefined);
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlWithLegacyFallback(join(configDir, `${preferredProfile}.toml`), fallbackConfigDir ? join(fallbackConfigDir, `${preferredProfile}.toml`) : undefined);
  const localExampleToml = parseTomlWithLegacyFallback(join(configDir, "local.example.toml"), fallbackConfigDir ? join(fallbackConfigDir, "local.example.toml") : undefined);
  const localToml = parseTomlWithLegacyFallback(join(configDir, "local.toml"), fallbackConfigDir ? join(fallbackConfigDir, "local.toml") : undefined);
  const merged = mergeDeep(mergeDeep(mergeDeep(defaultToml, profileToml), localExampleToml), localToml);
  const profile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(merged.profile, preferredProfile), preferredProfile);
  const sessionId = firstNonEmpty(process.env.PUSHPALS_SESSION_ID, asString(merged.session_id, "dev"), "dev");
  const llmNode = getObject(merged, "llm");
  const lmStudioNode = getObject(llmNode, "lmstudio");
  const lmStudioContextWindow = Math.max(512, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_CONTEXT_WINDOW") ?? lmStudioNode.context_window, 4096));
  const lmStudioMinOutputTokens = Math.max(64, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_MIN_OUTPUT_TOKENS") ?? lmStudioNode.min_output_tokens, 256));
  const lmStudioTokenSafetyMargin = Math.max(16, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_TOKEN_SAFETY_MARGIN") ?? lmStudioNode.token_safety_margin, 64));
  const lmStudioBatchTailMessages = Math.max(1, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_TAIL_MESSAGES") ?? lmStudioNode.batch_tail_messages, 3));
  const lmStudioBatchChunkTokens = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_CHUNK_TOKENS") ?? lmStudioNode.batch_chunk_tokens, 0));
  const lmStudioBatchMemoryChars = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_MEMORY_CHARS") ?? lmStudioNode.batch_memory_chars, 0));
  const pathsNode = getObject(merged, "paths");
  const dataDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DATA_DIR, asString(pathsNode.data_dir, "outputs/data")));
  const sharedDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DB_PATH, asString(pathsNode.shared_db_path, join(dataDir, "pushpals.db"))));
  const remotebuddyDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.REMOTEBUDDY_DB_PATH, asString(pathsNode.remotebuddy_db_path, join(dataDir, "remotebuddy-state.db"))));
  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(1, asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001));
  const serverUrl = normalizeLoopbackHttpUrl(firstNonEmpty(process.env.PUSHPALS_SERVER_URL, asString(serverNode.url, `http://127.0.0.1:${serverPort}`), `http://127.0.0.1:${serverPort}`), serverPort);
  const serverHost = normalizeLoopbackHost(firstNonEmpty(process.env.PUSHPALS_HOST, asString(serverNode.host, "127.0.0.1")));
  const debugHttp = parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(5000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms, 120000));
  const staleClaimSweepIntervalMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS") ?? serverNode.stale_claim_sweep_interval_ms, 5000));
  const globalStatusHeartbeatMs = parseIntEnv("PUSHPALS_STATUS_HEARTBEAT_MS");
  const localNode = getObject(merged, "localbuddy");
  const localEnabled = parseBoolEnv("LOCALBUDDY_ENABLED") ?? asBoolean(localNode.enabled, false);
  const localPort = Math.max(1, asInt(parseIntEnv("LOCAL_AGENT_PORT") ?? localNode.port, 3003));
  const localStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("LOCALBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? localNode.status_heartbeat_ms, 120000));
  const localLlm = resolveLlmConfig(localNode, "LOCALBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "localbuddy-dev"
  }, sessionId);
  const remoteNode = getObject(merged, "remotebuddy");
  const remoteStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? remoteNode.status_heartbeat_ms, 120000));
  const remotePollMs = Math.max(200, asInt(parseIntEnv("REMOTEBUDDY_POLL_MS") ?? remoteNode.poll_ms, 2000));
  const remoteLlm = resolveLlmConfig(remoteNode, "REMOTEBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "remotebuddy-dev"
  }, sessionId);
  const remoteMemoryNode = getObject(remoteNode, "memory");
  const remoteMemoryEnabled = parseBoolEnv("REMOTEBUDDY_MEMORY_ENABLED") ?? asBoolean(remoteMemoryNode.enabled, true);
  const remoteMemoryIncludeCrossSession = parseBoolEnv("REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION") ?? asBoolean(remoteMemoryNode.include_cross_session, true);
  const remoteMemoryMaxRecallItems = Math.max(1, Math.min(128, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS") ?? remoteMemoryNode.max_recall_items, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS)));
  const remoteMemoryMaxRecallChars = Math.max(120, Math.min(64000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS") ?? remoteMemoryNode.max_recall_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS)));
  const remoteMemoryMaxSummaryChars = Math.max(64, Math.min(16000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS") ?? remoteMemoryNode.max_summary_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS)));
  const remoteMemoryRetentionDays = Math.max(1, Math.min(3650, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_RETENTION_DAYS") ?? remoteMemoryNode.retention_days, DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS)));
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
    dep_bump: 0
  };
  const remoteAutonomyDispatchByType = {
    ...remoteAutonomyDispatchByTypeCfg,
    ...asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_type)
  };
  const remoteAutonomyDispatchByComponentCfg = {
    "apps/server": 3,
    "apps/remotebuddy": 2,
    "apps/workerpals": 2,
    "apps/client": 2,
    "packages/protocol": 1,
    "packages/shared": 2,
    "tests/integration": 2,
    "tests/unit": 2
  };
  const remoteAutonomyDispatchByComponentRaw = asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_component);
  const legacyAutonomyComponentAliasMap = new Map(Object.keys(remoteAutonomyDispatchByComponentCfg).flatMap((key) => {
    const direct = normalizeAutonomyComponentArea(key);
    const legacyUnderscore = normalizeAutonomyComponentArea(key.replace(/\//g, "_"));
    const legacyHyphen = normalizeAutonomyComponentArea(key.replace(/\//g, "-"));
    return [direct, legacyUnderscore, legacyHyphen].filter((value) => Boolean(value)).map((value) => [value, key]);
  }));
  const coerceAutonomyComponentConfigKey = (value) => {
    const direct = normalizeAutonomyComponentArea(value);
    const legacyAliasCandidate = normalizeAutonomyComponentArea(value.trim().toLowerCase().replace(/\\/g, "/").replace(/_+/g, "/").replace(/-+/g, "/").replace(/\/+/g, "/"));
    if (legacyAliasCandidate && legacyAutonomyComponentAliasMap.has(legacyAliasCandidate)) {
      return legacyAutonomyComponentAliasMap.get(legacyAliasCandidate) ?? legacyAliasCandidate;
    }
    return direct;
  };
  const remoteAutonomyDispatchByComponent = Object.fromEntries(Object.entries(remoteAutonomyDispatchByComponentCfg).map(([key, value]) => [
    coerceAutonomyComponentConfigKey(key) ?? key,
    value
  ]));
  for (const [rawKey, rawValue] of Object.entries(remoteAutonomyDispatchByComponentRaw)) {
    const canonical = coerceAutonomyComponentConfigKey(rawKey);
    if (!canonical)
      continue;
    const parsed = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerPollMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2000));
  const workerHeartbeatMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_HEARTBEAT_MS") ?? workerNode.heartbeat_ms, 5000));
  const workerExecutor = firstNonEmpty(process.env.WORKERPALS_EXECUTOR, asString(workerNode.executor, "openhands"), "openhands").toLowerCase();
  const workerOpenHandsPython = firstNonEmpty(process.env.WORKERPALS_OPENHANDS_PYTHON, asString(workerNode.openhands_python, "python"), "python");
  const workerOpenHandsTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_OPENHANDS_TIMEOUT_MS") ?? workerNode.openhands_timeout_ms, 1800000));
  const workerMiniswePython = firstNonEmpty(process.env.WORKERPALS_MINISWE_PYTHON, asString(workerNode.miniswe_python, "python"), "python");
  const workerMinisweTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_MINISWE_TIMEOUT_MS") ?? workerNode.miniswe_timeout_ms, 1800000));
  const workerOpenAICodexPython = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_PYTHON, asString(workerNode.openai_codex_python, "python"), "python");
  const workerOpenAICodexTimeoutMs = Math.max(1e4, asInt(workerNode.openai_codex_timeout_ms, 7200000));
  const workerQualityMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_MAX_AUTO_REVISIONS") ?? workerNode.quality_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerFileModifyingJobs = (() => {
    const envRaw = firstNonEmpty(process.env.WORKERPALS_FILE_MODIFYING_JOBS);
    const parsed = envRaw ? envRaw.split(",").map((entry) => entry.trim()).filter(Boolean) : asStringArray(workerNode.file_modifying_jobs);
    const out = parsed.length > 0 ? parsed : DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS;
    return [...new Set(out)];
  })();
  const workerOutputMaxChars = Math.max(8192, Math.min(4194304, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_CHARS") ?? workerNode.output_max_chars, DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS)));
  const workerOutputMaxLines = Math.max(50, Math.min(20000, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_LINES") ?? workerNode.output_max_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_LINES)));
  const workerOutputMaxHeadLines = Math.max(1, Math.min(workerOutputMaxLines, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_HEAD_LINES") ?? workerNode.output_max_head_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES)));
  const workerQualityValidationStepTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS") ?? workerNode.quality_validation_step_timeout_ms, DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS));
  const workerQualityCriticTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS") ?? workerNode.quality_critic_timeout_ms, DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS));
  const workerQualitySoftPassOnExhausted = parseBoolEnv("WORKERPALS_QUALITY_SOFT_PASS_ON_EXHAUSTED") ?? asBoolean(workerNode.quality_soft_pass_on_exhausted, true);
  const workerQualityCriticMinScore = (() => {
    const configThresholdRaw = workerNode.quality_critic_min_score == null ? "" : String(workerNode.quality_critic_min_score);
    const raw = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE, configThresholdRaw, String(DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE));
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed))
      return DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    return Math.max(0, Math.min(10, parsed));
  })();
  const workerQualityCriticMaxDiffChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS") ?? workerNode.quality_critic_max_diff_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS)));
  const workerQualityCriticMaxValidationOutputChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS") ?? workerNode.quality_critic_max_validation_output_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS)));
  const workerExecutorResultPrefix = (() => {
    if (process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX !== undefined) {
      const raw = process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX;
      if (typeof raw === "string" && raw.length > 0)
        return raw;
    }
    if (Object.prototype.hasOwnProperty.call(workerNode, "executor_result_prefix") && typeof workerNode.executor_result_prefix === "string" && workerNode.executor_result_prefix.length > 0) {
      return workerNode.executor_result_prefix;
    }
    return DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX;
  })();
  const workerOpenHandsStuckGuardEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_ENABLED") ?? asBoolean(workerNode.openhands_stuck_guard_enabled, true);
  const workerOpenHandsStuckGuardExploreLimit = Math.max(6, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_EXPLORE_LIMIT") ?? workerNode.openhands_stuck_guard_explore_limit, 18));
  const workerOpenHandsStuckGuardMinElapsedMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_MIN_ELAPSED_MS") ?? workerNode.openhands_stuck_guard_min_elapsed_ms, 180000));
  const workerOpenHandsStuckGuardBroadScanLimit = Math.max(1, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_BROAD_SCAN_LIMIT") ?? workerNode.openhands_stuck_guard_broad_scan_limit, 2));
  const workerOpenHandsStuckGuardNoProgressMaxMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_NO_PROGRESS_MAX_MS") ?? workerNode.openhands_stuck_guard_no_progress_max_ms, 300000));
  const workerOpenHandsAutoSteerEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_AUTO_STEER_ENABLED") ?? asBoolean(workerOpenHandsNode.auto_steer_enabled, true);
  const workerOpenHandsAutoSteerInitialDelaySec = Math.max(0, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INITIAL_DELAY_SEC") ?? workerOpenHandsNode.auto_steer_initial_delay_sec, 90)));
  const workerOpenHandsAutoSteerIntervalSec = Math.max(15, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INTERVAL_SEC") ?? workerOpenHandsNode.auto_steer_interval_sec, 60)));
  const workerOpenHandsAutoSteerMaxNudges = Math.max(0, Math.min(120, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES") ?? workerOpenHandsNode.auto_steer_max_nudges, 30)));
  const workerRequirePush = parseBoolEnv("WORKERPALS_REQUIRE_PUSH") ?? asBoolean(workerNode.require_push, false);
  const workerPushAgentBranchEnv = parseBoolEnv("WORKERPALS_PUSH_AGENT_BRANCH");
  const workerPushAgentBranch = workerRequirePush || (workerPushAgentBranchEnv ?? asBoolean(workerNode.push_agent_branch, false));
  const workerSkipDockerSelfCheck = parseBoolEnv("WORKERPALS_SKIP_DOCKER_SELF_CHECK") ?? asBoolean(workerNode.skip_docker_self_check, false);
  const workerDockerAgentStartupTimeoutMs = Math.max(1e4, Math.min(180000, asInt(parseIntEnv("WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS") ?? workerNode.docker_agent_startup_timeout_ms, 45000)));
  const workerDockerWarmMaxAttempts = Math.max(1, Math.min(5, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MAX_ATTEMPTS") ?? workerNode.docker_warm_max_attempts, 3)));
  const workerDockerWarmRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_RETRY_BACKOFF_MS") ?? workerNode.docker_warm_retry_backoff_ms, 2000)));
  const workerDockerJobMaxAttempts = Math.max(1, Math.min(3, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_MAX_ATTEMPTS") ?? workerNode.docker_job_max_attempts, 2)));
  const workerDockerJobRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_RETRY_BACKOFF_MS") ?? workerNode.docker_job_retry_backoff_ms, 3000)));
  const workerDockerWarmMemoryMb = Math.max(512, Math.min(32768, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MEMORY_MB") ?? workerNode.docker_warm_memory_mb, 2048)));
  const workerDockerWarmCpus = Math.max(1, Math.min(16, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_CPUS") ?? workerNode.docker_warm_cpus, 2)));
  const workerLlm = resolveLlmConfig(workerNode, "WORKERPALS", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "workerpals-dev"
  }, sessionId);
  const scmNode = getObject(merged, "source_control_manager");
  const scmRepoPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REPO_PATH, asString(scmNode.repo_path, ".worktrees/source_control_manager"), ".worktrees/source_control_manager"));
  const scmRemote = asString(process.env.SOURCE_CONTROL_MANAGER_REMOTE ?? scmNode.remote, "origin");
  const scmMainBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MAIN_BRANCH, process.env.PUSHPALS_INTEGRATION_BRANCH, asString(scmNode.pushpals_branch, "main_agents"), "main_agents");
  const scmBaseBranch = firstNonEmpty(process.env.PUSHPALS_INTEGRATION_BASE_BRANCH, asString(scmNode.base_branch, "main"), "main");
  const scmBranchPrefix = asString(process.env.SOURCE_CONTROL_MANAGER_BRANCH_PREFIX ?? scmNode.branch_prefix, "agent/");
  const scmPollIntervalSeconds = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_POLL_INTERVAL_SECONDS") ?? scmNode.poll_interval_seconds, 10));
  const scmChecks = asCheckArray(scmNode.checks);
  const scmStateDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_STATE_DIR, asString(scmNode.state_dir, join(dataDir, "source_control_manager")), join(dataDir, "source_control_manager")));
  const scmPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_PORT") ?? scmNode.port, 3002)));
  const scmDeleteAfterMerge = parseBoolEnv("SOURCE_CONTROL_MANAGER_DELETE_AFTER_MERGE") ?? asBoolean(scmNode.delete_after_merge, false);
  const scmMaxAttempts = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_MAX_ATTEMPTS") ?? scmNode.max_attempts, 3));
  const scmMergeStrategyRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MERGE_STRATEGY, asString(scmNode.merge_strategy, "cherry-pick"), "cherry-pick");
  const scmMergeStrategy = scmMergeStrategyRaw === "no-ff" || scmMergeStrategyRaw === "ff-only" ? scmMergeStrategyRaw : "cherry-pick";
  let scmPushMainAfterMerge = asBoolean(scmNode.push_main_after_merge, true);
  const scmPushMainAfterMergeEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_PUSH_MAIN_AFTER_MERGE");
  if (scmPushMainAfterMergeEnv != null)
    scmPushMainAfterMerge = scmPushMainAfterMergeEnv;
  const scmNoPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (scmNoPushEnv != null)
    scmPushMainAfterMerge = !scmNoPushEnv;
  let scmOpenPrAfterPush = asBoolean(scmNode.open_pr_after_push, true);
  const scmOpenPrAfterPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_OPEN_PR_AFTER_PUSH");
  if (scmOpenPrAfterPushEnv != null)
    scmOpenPrAfterPush = scmOpenPrAfterPushEnv;
  const scmDisableAutoPrEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_DISABLE_AUTO_PR");
  if (scmDisableAutoPrEnv != null)
    scmOpenPrAfterPush = !scmDisableAutoPrEnv;
  const scmPrBaseBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BASE_BRANCH, asString(scmNode.pr_base_branch, scmBaseBranch), scmBaseBranch);
  const scmPrTitle = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_TITLE, asString(scmNode.pr_title, ""));
  const scmPrBody = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BODY, asString(scmNode.pr_body, ""));
  const scmPrDraft = parseBoolEnv("SOURCE_CONTROL_MANAGER_PR_DRAFT") ?? asBoolean(scmNode.pr_draft, false);
  const scmStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? scmNode.status_heartbeat_ms, 120000));
  const scmSkipCleanCheck = parseBoolEnv("SOURCE_CONTROL_MANAGER_SKIP_CLEAN_CHECK") ?? asBoolean(scmNode.skip_clean_check, false);
  const scmAutoCreateMainBranch = parseBoolEnv("SOURCE_CONTROL_MANAGER_AUTO_CREATE_MAIN_BRANCH") ?? asBoolean(scmNode.auto_create_main_branch, false);
  const scmReviewAgentNode = getObject(scmNode, "review_agent");
  const scmReviewAgentEnabled = parseBoolEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_ENABLED") ?? asBoolean(scmReviewAgentNode.enabled, false);
  const scmReviewAgentPollIntervalMs = Math.max(5000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_POLL_INTERVAL_MS") ?? scmReviewAgentNode.poll_interval_ms, 60000));
  const scmReviewAgentReviewerMdPath = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_REVIEWER_MD_PATH, asString(scmReviewAgentNode.reviewer_md_path, "prompts/review_agent/reviewer.md"), "prompts/review_agent/reviewer.md");
  const scmReviewAgentPassThreshold = (() => {
    const configThresholdRaw = scmReviewAgentNode.pass_threshold == null ? "" : String(scmReviewAgentNode.pass_threshold);
    const raw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD, configThresholdRaw, "9.5");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 9.5;
  })();
  const scmReviewAgentMaxPrCommentsBeforeGiveUp = Math.max(1, Math.min(100, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP") ?? scmReviewAgentNode.max_pr_comments_before_give_up, 10)));
  const scmReviewAgentMergeMethodRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MERGE_METHOD, asString(scmReviewAgentNode.merge_method, "squash"), "squash").toLowerCase();
  const scmReviewAgentMergeMethod = scmReviewAgentMergeMethodRaw === "merge" || scmReviewAgentMergeMethodRaw === "rebase" ? scmReviewAgentMergeMethodRaw : "squash";
  const scmReviewAgentCodexBin = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_BIN, asString(scmReviewAgentNode.codex_bin, "bun x --yes @openai/codex"), "bun x --yes @openai/codex");
  const scmReviewAgentCodexAuthMode = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_AUTH_MODE, asString(scmReviewAgentNode.codex_auth_mode, "chatgpt"), "chatgpt");
  const scmReviewAgentCodexHomeDir = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_HOME_DIR, asString(scmReviewAgentNode.codex_home_dir, ""));
  const scmReviewAgentCodexTimeoutMs = Math.max(30000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_TIMEOUT_MS") ?? scmReviewAgentNode.codex_timeout_ms, 300000));
  const startupNode = getObject(merged, "startup");
  const startupWorkerImageRebuild = normalizeWorkerImageRebuildMode(firstNonEmpty(process.env.PUSHPALS_WORKER_IMAGE_REBUILD, asString(startupNode.worker_image_rebuild, "auto"), "auto"));
  const startupLogConfigOnStart = parseBoolEnv("PUSHPALS_LOG_CONFIG_ON_START") ?? asBoolean(startupNode.log_config_on_start, true);
  const startupSyncIntegrationWithMain = parseBoolEnv("PUSHPALS_SYNC_INTEGRATION_WITH_MAIN") ?? asBoolean(startupNode.sync_integration_with_main, true);
  const startupSkipLlmPreflight = parseBoolEnv("PUSHPALS_SKIP_LLM_PREFLIGHT") ?? asBoolean(startupNode.skip_llm_preflight, false);
  const startupAutoStartLmStudio = parseBoolEnv("PUSHPALS_AUTO_START_LMSTUDIO") ?? asBoolean(startupNode.auto_start_lmstudio, true);
  const startupLmStudioReadyTimeoutMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_READY_TIMEOUT_MS") ?? startupNode.lmstudio_ready_timeout_ms, 120000));
  const startupLmStudioCli = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_CLI, asString(startupNode.lmstudio_cli, "lms"), "lms");
  const startupLmStudioPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_PORT") ?? startupNode.lmstudio_port, 1234)));
  const startupLmStudioStartArgs = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_START_ARGS, asString(startupNode.lmstudio_start_args, ""));
  const startupWarmup = parseBoolEnv("PUSHPALS_STARTUP_WARMUP") ?? asBoolean(startupNode.startup_warmup, true);
  const startupWarmupTimeoutMs = Math.max(15000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_TIMEOUT_MS") ?? startupNode.startup_warmup_timeout_ms, 120000));
  const startupWarmupPollMs = Math.max(250, Math.min(5000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_POLL_MS") ?? startupNode.startup_warmup_poll_ms, 1000)));
  const startupAllowExternalClean = parseBoolEnv("PUSHPALS_ALLOW_EXTERNAL_CLEAN") ?? asBoolean(startupNode.allow_external_clean, false);
  const startupPortPreflight = parseBoolEnv("PUSHPALS_STARTUP_PORT_PREFLIGHT") ?? asBoolean(startupNode.port_preflight, true);
  const startupPortConflictPolicy = normalizeStartupPortConflictPolicy(firstNonEmpty(process.env.PUSHPALS_STARTUP_PORT_CONFLICT_POLICY, asString(startupNode.port_conflict_policy, "terminate_pushpals"), "terminate_pushpals"));
  const clientNode = getObject(merged, "client");
  const authToken = firstNonEmpty(process.env.PUSHPALS_AUTH_TOKEN) || null;
  const gitToken = firstNonEmpty(process.env.PUSHPALS_GIT_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN) || null;
  const config = {
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
        batchMemoryChars: lmStudioBatchMemoryChars
      }
    },
    paths: {
      dataDir,
      sharedDbPath,
      remotebuddyDbPath
    },
    server: {
      url: serverUrl,
      host: serverHost,
      port: serverPort,
      debugHttp,
      staleClaimTtlMs,
      staleClaimSweepIntervalMs
    },
    localbuddy: {
      enabled: localEnabled,
      port: localPort,
      statusHeartbeatMs: localStatusHeartbeatMs,
      llm: localLlm
    },
    remotebuddy: {
      pollMs: remotePollMs,
      statusHeartbeatMs: remoteStatusHeartbeatMs,
      workerpalOnlineTtlMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_ONLINE_TTL_MS") ?? remoteNode.workerpal_online_ttl_ms, 15000)),
      waitForWorkerpalMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_WAIT_FOR_WORKERPAL_MS") ?? remoteNode.wait_for_workerpal_ms, 15000)),
      autoSpawnWorkerpals: parseBoolEnv("REMOTEBUDDY_AUTO_SPAWN_WORKERPALS") ?? asBoolean(remoteNode.auto_spawn_workerpals, true),
      maxWorkerpals: Math.max(1, asInt(remoteNode.max_workerpals, 20)),
      workerpalStartupTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS") ?? remoteNode.workerpal_startup_timeout_ms, 1e4)),
      workerpalDocker: parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ?? asBoolean(remoteNode.workerpal_docker, true),
      workerpalRequireDocker: parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ?? asBoolean(remoteNode.workerpal_require_docker, true),
      workerpalImage: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_IMAGE, asString(remoteNode.workerpal_image, "")) || null,
      workerpalPollMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_POLL_MS")) ?? asIntOrNull(remoteNode.workerpal_poll_ms),
      workerpalHeartbeatMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_HEARTBEAT_MS")) ?? asIntOrNull(remoteNode.workerpal_heartbeat_ms),
      workerpalLabels: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS) ? firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(remoteNode.workerpal_labels),
      executionBudgetInteractiveMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_INTERACTIVE_MS") ?? remoteNode.execution_budget_interactive_ms, 300000)),
      executionBudgetNormalMs: Math.max(120000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_NORMAL_MS") ?? remoteNode.execution_budget_normal_ms, 900000)),
      executionBudgetBackgroundMs: Math.max(180000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_BACKGROUND_MS") ?? remoteNode.execution_budget_background_ms, 1800000)),
      finalizationBudgetMs: Math.max(30000, asInt(parseIntEnv("REMOTEBUDDY_FINALIZATION_BUDGET_MS") ?? remoteNode.finalization_budget_ms, 120000)),
      crashRestartEnabled: parseBoolEnv("REMOTEBUDDY_CRASH_RESTART_ENABLED") ?? asBoolean(remoteNode.crash_restart_enabled, true),
      crashRestartMaxRestarts: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS") ?? remoteNode.crash_restart_max_restarts, 3)),
      crashRestartBackoffMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS") ?? remoteNode.crash_restart_backoff_ms, 3000)),
      memory: {
        enabled: remoteMemoryEnabled,
        includeCrossSession: remoteMemoryIncludeCrossSession,
        maxRecallItems: remoteMemoryMaxRecallItems,
        maxRecallChars: remoteMemoryMaxRecallChars,
        maxSummaryChars: remoteMemoryMaxSummaryChars,
        retentionDays: remoteMemoryRetentionDays
      },
      autonomy: {
        enabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ENABLED") ?? asBoolean(remoteAutonomyNode.enabled, true),
        killSwitchEnabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED") ?? asBoolean(remoteAutonomyNode.kill_switch_enabled, false),
        tickIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TICK_INTERVAL_MS") ?? remoteAutonomyNode.tick_interval_ms, 120000)),
        heartbeatLogMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS") ?? remoteAutonomyNode.heartbeat_log_ms, 30000)),
        visionContextMaxChars: Math.max(1000, Math.min(1e6, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS") ?? remoteAutonomyNode.vision_context_max_chars, 65536))),
        ideationBudgetMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_BUDGET_MS") ?? remoteAutonomyNode.ideation_budget_ms, 20000)),
        llmTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_LLM_TIMEOUT_MS") ?? remoteAutonomyNode.llm_timeout_ms, 12000)),
        allowDirtyWorktree: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE") ?? asBoolean(remoteAutonomyNode.allow_dirty_worktree, false),
        ideationMaxCandidates: Math.max(1, Math.min(100, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_MAX_CANDIDATES") ?? remoteAutonomyNode.ideation_max_candidates, 20))),
        topK: Math.max(1, Math.min(20, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TOP_K") ?? remoteAutonomyNode.top_k, 3))),
        exploreRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EXPLORE_RATE, asString(remoteAutonomyNode.explore_rate, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        minConfidence: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_MIN_CONFIDENCE, asString(remoteAutonomyNode.min_confidence, "0.65"), "0.65")));
          return Number.isFinite(parsed) ? parsed : 0.65;
        })())),
        maxConcurrentObjectives: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_CONCURRENT_OBJECTIVES") ?? remoteAutonomyNode.max_concurrent_objectives, 2)),
        maxDispatchPerHour: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_DISPATCH_PER_HOUR") ?? remoteAutonomyNode.max_dispatch_per_hour, 6)),
        maxDispatchPerHourByType: remoteAutonomyDispatchByType,
        maxDispatchPerHourByComponent: remoteAutonomyDispatchByComponent,
        maxTokenUsagePerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR") ?? remoteAutonomyNode.max_token_usage_per_hour, 120000)),
        maxRuntimeMsPerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_RUNTIME_MS_PER_HOUR") ?? remoteAutonomyNode.max_runtime_ms_per_hour, 5400000)),
        cooldownFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.cooldown_fail_streak_threshold, 2)),
        cooldownMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_MS") ?? remoteAutonomyNode.cooldown_ms, 1800000)),
        staleObjectiveTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_TTL_MS") ?? remoteAutonomyNode.stale_objective_ttl_ms, 2700000)),
        staleObjectiveSweepIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_SWEEP_INTERVAL_MS") ?? remoteAutonomyNode.stale_objective_sweep_interval_ms, 60000)),
        autoFreezeFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.auto_freeze_fail_streak_threshold, 3)),
        autoFreezeDurationMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_DURATION_MS") ?? remoteAutonomyNode.auto_freeze_duration_ms, 1800000)),
        evaluatorWindowHours: Math.max(1, Math.min(168, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_WINDOW_HOURS") ?? remoteAutonomyNode.evaluator_window_hours, 24))),
        evaluatorMinSamples: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SAMPLES") ?? remoteAutonomyNode.evaluator_min_samples, 6)),
        evaluatorMinSuccessRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SUCCESS_RATE, asString(remoteAutonomyNode.evaluator_min_success_rate, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        evaluatorMaxRegretRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MAX_REGRET_RATE, asString(remoteAutonomyNode.evaluator_max_regret_rate, "0.35"), "0.35")));
          return Number.isFinite(parsed) ? parsed : 0.35;
        })())),
        evaluatorRunIntervalMs: Math.max(1e4, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_RUN_INTERVAL_MS") ?? remoteAutonomyNode.evaluator_run_interval_ms, 120000)),
        alertQueuePendingThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_ALERT_QUEUE_PENDING_THRESHOLD") ?? remoteAutonomyNode.alert_queue_pending_threshold, 20)),
        alertJobFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_JOB_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_job_failure_rate_threshold, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        alertAutonomyFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_AUTONOMY_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_autonomy_failure_rate_threshold, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        allowReadAnywhere: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_READ_ANYWHERE") ?? asBoolean(remoteAutonomyNode.allow_read_anywhere, false),
        prFeedbackCommentRows: Math.max(1, Math.min(200, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_ROWS") ?? remoteAutonomyNode.pr_feedback_comment_rows, 16))),
        prFeedbackCommentChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_CHARS") ?? remoteAutonomyNode.pr_feedback_comment_chars, 600))),
        prFeedbackSummaryChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_SUMMARY_CHARS") ?? remoteAutonomyNode.pr_feedback_summary_chars, 600))),
        questionTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_QUESTION_TTL_MS") ?? remoteAutonomyNode.question_ttl_ms, 259200000)),
        policyVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_POLICY_VERSION, asString(remoteAutonomyNode.policy_version, "policy-v3.3"), "policy-v3.3"),
        impactModelVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_IMPACT_MODEL_VERSION, asString(remoteAutonomyNode.impact_model_version, "impact-v1"), "impact-v1"),
        replay: {
          storePromptPayloads: parseBoolEnv("REMOTEBUDDY_AUTONOMY_REPLAY_STORE_PROMPT_PAYLOADS") ?? asBoolean(remoteAutonomyReplayNode.store_prompt_payloads, false),
          maxRunsWithPayloads: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_RUNS_WITH_PAYLOADS") ?? remoteAutonomyReplayNode.max_runs_with_payloads, 50)),
          maxPayloadBytes: Math.max(1024, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_PAYLOAD_BYTES") ?? remoteAutonomyReplayNode.max_payload_bytes, 262144))
        }
      },
      llm: remoteLlm
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
      requireDocker: parseBoolEnv("WORKERPALS_REQUIRE_DOCKER") ?? asBoolean(workerNode.require_docker, false),
      skipDockerSelfCheck: workerSkipDockerSelfCheck,
      dockerImage: firstNonEmpty(process.env.WORKERPALS_DOCKER_IMAGE, asString(workerNode.docker_image, "pushpals-worker-sandbox:latest"), "pushpals-worker-sandbox:latest"),
      dockerTimeoutMs: Math.max(1e4, asInt(parseIntEnv("WORKERPALS_DOCKER_TIMEOUT_MS") ?? workerNode.docker_timeout_ms, 7260000)),
      dockerIdleTimeoutMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_DOCKER_IDLE_TIMEOUT_MS") ?? workerNode.docker_idle_timeout_ms, 600000)),
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
      dockerNetworkMode: asString(process.env.WORKERPALS_DOCKER_NETWORK_MODE ?? workerNode.docker_network_mode, "bridge"),
      baseRef: firstNonEmpty(process.env.WORKERPALS_BASE_REF, asString(workerNode.base_ref, "origin/main_agents"), "origin/main_agents"),
      labels: firstNonEmpty(process.env.WORKERPALS_LABELS) ? firstNonEmpty(process.env.WORKERPALS_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(workerNode.labels),
      failureCooldownMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_FAILURE_COOLDOWN_MS") ?? parseIntEnv("WORKERPALS_DOCKER_FAILURE_COOLDOWN_MS") ?? workerNode.failure_cooldown_ms, 20000)),
      llm: workerLlm
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
        codexTimeoutMs: scmReviewAgentCodexTimeoutMs
      }
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
      startupWarmupTimeoutMs,
      startupWarmupPollMs,
      allowExternalClean: startupAllowExternalClean,
      portPreflight: startupPortPreflight,
      portConflictPolicy: startupPortConflictPolicy
    },
    client: {
      localAgentUrl: normalizeLoopbackHttpUrl(firstNonEmpty(process.env.EXPO_PUBLIC_LOCAL_AGENT_URL, asString(clientNode.local_agent_url, `http://127.0.0.1:${localPort}`), `http://127.0.0.1:${localPort}`), localPort),
      traceTailLines: Math.max(10, asInt(parseIntEnv("EXPO_PUBLIC_PUSHPALS_TRACE_TAIL_LINES") ?? clientNode.trace_tail_lines, 100))
    }
  };
  cachedConfig = config;
  cachedConfigKey = cacheKey;
  return config;
}

// packages/shared/src/vision.ts
var SECTION_HEADING_RE = /^##\s+(\d+)\)\s+(.+?)\s*$/;
var ONE_SENTENCE_PROMPT_RE = /^\>\s*\*\*One sentence:\*\*\s*(.+)\s*$/i;
var BLOCKQUOTE_RE = /^\>\s*(.+?)\s*$/;
function toLines(markdown) {
  return String(markdown ?? "").replace(/\r\n/g, `
`).split(`
`);
}
function extractOneSentence(lines) {
  let expectNextBlockquoteSentence = false;
  for (const line of lines) {
    const marker = line.match(ONE_SENTENCE_PROMPT_RE);
    if (marker) {
      const inline = marker[1].trim();
      if (inline)
        return inline;
      expectNextBlockquoteSentence = true;
      continue;
    }
    const block = line.match(BLOCKQUOTE_RE);
    if (expectNextBlockquoteSentence) {
      if (!block)
        continue;
      const text = block[1].trim();
      if (!text)
        continue;
      if (/^Example:/i.test(text))
        continue;
      return text;
    }
  }
  for (const line of lines) {
    const block = line.match(BLOCKQUOTE_RE);
    if (!block)
      continue;
    const text = block[1].trim();
    if (!text)
      continue;
    if (/^\*\*One sentence:\*\*/i.test(text))
      continue;
    if (/^Example:/i.test(text))
      continue;
    return text;
  }
  return "";
}
function parseVisionDoc(markdown) {
  const lines = toLines(markdown);
  const sections = [];
  let currentNumber = "";
  let currentTitle = "";
  let currentBody = [];
  const flushCurrent = () => {
    if (!currentNumber)
      return;
    sections.push({
      number: currentNumber,
      title: currentTitle,
      markdown: currentBody.join(`
`).trim()
    });
    currentNumber = "";
    currentTitle = "";
    currentBody = [];
  };
  for (const line of lines) {
    const heading = line.match(SECTION_HEADING_RE);
    if (heading) {
      flushCurrent();
      currentNumber = heading[1];
      currentTitle = heading[2].trim();
      continue;
    }
    if (currentNumber) {
      currentBody.push(line);
    }
  }
  flushCurrent();
  const sectionByNumber = {};
  for (const section of sections) {
    if (!sectionByNumber[section.number]) {
      sectionByNumber[section.number] = section;
    }
  }
  return {
    oneSentence: extractOneSentence(lines),
    sections,
    sectionByNumber
  };
}
function validateVisionDocStructure(markdown) {
  const parsed = parseVisionDoc(markdown);
  const missingSectionNumbers = [];
  const errors = [];
  if (!parsed.oneSentence) {
    errors.push('Missing one-sentence vision line (expected near the top as a blockquote after "**One sentence:**").');
  }
  return {
    ok: errors.length === 0,
    sectionCount: parsed.sections.length,
    hasOneSentence: Boolean(parsed.oneSentence),
    missingSectionNumbers,
    errors
  };
}

// packages/shared/src/client_preflight.ts
function runtimeHasConfigDir(runtimeRoot, dirName) {
  const dirPath = resolve2(runtimeRoot, dirName);
  return existsSync2(resolve2(dirPath, "default.toml")) || existsSync2(resolve2(dirPath, "local.example.toml")) || existsSync2(resolve2(dirPath, "local.toml"));
}
function resolveClientConfigDir(projectRoot, runtimeRoot, explicitConfigDir) {
  if (explicitConfigDir && explicitConfigDir.trim()) {
    return resolve2(explicitConfigDir);
  }
  const runtimeCanonical = resolve2(runtimeRoot, "configs");
  if (runtimeHasConfigDir(runtimeRoot, "configs")) {
    return runtimeCanonical;
  }
  const runtimeLegacy = resolve2(runtimeRoot, "config");
  if (runtimeHasConfigDir(runtimeRoot, "config")) {
    return runtimeLegacy;
  }
  const projectCanonical = resolve2(projectRoot, "configs");
  if (runtimeHasConfigDir(projectRoot, "configs")) {
    return projectCanonical;
  }
  const projectLegacy = resolve2(projectRoot, "config");
  if (runtimeHasConfigDir(projectRoot, "config")) {
    return projectLegacy;
  }
  return runtimeCanonical;
}
function toDisplayPath(currentRoot, pathValue) {
  const rel = relative(currentRoot, pathValue);
  if (!rel || rel === "")
    return ".";
  if (rel.startsWith(".."))
    return pathValue;
  return rel.replace(/\\/g, "/");
}
function quotePowerShell(pathValue) {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(pathValue))
    return pathValue;
  return `'${pathValue.replace(/'/g, "''")}'`;
}
function quoteBash(pathValue) {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(pathValue))
    return pathValue;
  return "'" + pathValue.replace(/'/g, `'"'"'`) + "'";
}
function buildCopyCommands(workspaceRoot, sourcePath, destPath) {
  const displaySource = toDisplayPath(workspaceRoot, sourcePath);
  const displayDest = toDisplayPath(workspaceRoot, destPath);
  return {
    windowsPowerShell: `Copy-Item ${quotePowerShell(displaySource)} ${quotePowerShell(displayDest)}`,
    bash: `cp ${quoteBash(displaySource)} ${quoteBash(displayDest)}`
  };
}
function evaluateClientRuntimePreflight(options) {
  const projectRoot = resolve2(options.projectRoot);
  const runtimeRoot = resolve2(options.runtimeRoot ?? projectRoot);
  const configDir = resolveClientConfigDir(projectRoot, runtimeRoot, options.configDir);
  const visionTemplateRoot = resolve2(options.visionTemplateRoot ?? runtimeRoot);
  const config = options.config ?? loadPushPalsConfig({
    projectRoot,
    configDir,
    reload: true
  });
  const issues = [];
  const envPath = resolve2(runtimeRoot, ".env");
  if (!existsSync2(envPath)) {
    const envExamplePath = resolve2(runtimeRoot, ".env.example");
    issues.push({
      code: "missing_env_file",
      message: `Missing required local env file: ${toDisplayPath(projectRoot, envPath)}.`,
      copyCommands: existsSync2(envExamplePath) ? buildCopyCommands(projectRoot, envExamplePath, envPath) : undefined
    });
  }
  const localTomlPath = resolve2(runtimeRoot, "configs", "local.toml");
  const legacyLocalTomlPath = resolve2(runtimeRoot, "config", "local.toml");
  if (!existsSync2(localTomlPath) && !existsSync2(legacyLocalTomlPath)) {
    const localExamplePath = resolve2(runtimeRoot, "configs", "local.example.toml");
    issues.push({
      code: "missing_local_toml",
      message: `Missing required local config file: ${toDisplayPath(projectRoot, localTomlPath)}.`,
      copyCommands: existsSync2(localExamplePath) ? buildCopyCommands(projectRoot, localExamplePath, localTomlPath) : undefined
    });
  }
  const autonomyEnabled = Boolean(config.remotebuddy.autonomy.enabled);
  if (!autonomyEnabled) {
    return {
      ok: issues.length === 0,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null
    };
  }
  const visionPath = resolve2(projectRoot, "vision.md");
  const visionTemplatePath = resolve2(visionTemplateRoot, "vision.example.md");
  if (!existsSync2(visionPath)) {
    issues.push({
      code: "missing_vision_doc",
      message: "Missing required autonomy vision file: vision.md " + "(required when remotebuddy.autonomy.enabled=true).",
      copyCommands: existsSync2(visionTemplatePath) ? buildCopyCommands(projectRoot, visionTemplatePath, visionPath) : undefined
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null
    };
  }
  let rawVision = "";
  try {
    rawVision = readFileSync2(visionPath, "utf8");
  } catch (err) {
    issues.push({
      code: "unreadable_vision_doc",
      message: `Autonomy vision preflight failed: could not read vision.md.`,
      detail: String(err)
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null
    };
  }
  const visionText = rawVision.trim();
  if (!visionText) {
    issues.push({
      code: "empty_vision_doc",
      message: "Autonomy vision preflight failed: vision.md is empty.",
      detail: "Add repository vision/goals before startup."
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null
    };
  }
  const validation = validateVisionDocStructure(visionText);
  if (!validation.ok) {
    issues.push({
      code: "invalid_vision_doc",
      message: "Autonomy vision preflight failed: vision.md is invalid.",
      detail: validation.errors.join(" ")
    });
    return {
      ok: false,
      projectRoot,
      runtimeRoot,
      config,
      issues,
      autonomyEnabled,
      visionSummary: null
    };
  }
  return {
    ok: issues.length === 0,
    projectRoot,
    runtimeRoot,
    config,
    issues,
    autonomyEnabled,
    visionSummary: {
      path: toDisplayPath(projectRoot, visionPath),
      chars: visionText.length,
      sectionCount: validation.sectionCount,
      validation
    }
  };
}
function formatClientRuntimePreflightLines(result, prefix) {
  const normalizedPrefix = prefix.trim();
  const lines = [];
  if (result.ok) {
    if (result.visionSummary) {
      lines.push(`${normalizedPrefix} Autonomy preflight: loaded ${result.visionSummary.path} ` + `(${result.visionSummary.chars} chars, ${result.visionSummary.sectionCount} section(s)).`);
    }
    return lines;
  }
  for (const issue of result.issues) {
    lines.push(`${normalizedPrefix} ${issue.message}`);
    if (issue.detail) {
      lines.push(`${normalizedPrefix}   ${issue.detail}`);
    }
    if (issue.copyCommands) {
      lines.push(`${normalizedPrefix}   Windows (PowerShell): ${issue.copyCommands.windowsPowerShell}`);
      lines.push(`${normalizedPrefix}   Linux/macOS (bash): ${issue.copyCommands.bash}`);
    }
  }
  return lines;
}

// packages/shared/src/communication.ts
function stripPresenceSourcePrefix(value) {
  return value.replace(/^(agent|client)(?:[\s:./_-]+)+/i, "");
}
function normalizePresenceClientLabel(value) {
  return stripPresenceSourcePrefix(String(value ?? "")).replace(/\s+/g, " ").trim();
}
function normalizePresenceLookupToken(value) {
  return normalizePresenceClientLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// packages/shared/src/repo.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync } from "fs";
import { resolve as resolve3 } from "path";
function resolveDotGitEntry(repoRoot) {
  return resolve3(repoRoot, ".git");
}
function resolveGitMetadataDir(repoRoot) {
  const dotGitPath = resolveDotGitEntry(repoRoot);
  if (!existsSync3(dotGitPath))
    return null;
  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const firstLine = readFileSync3(dotGitPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match)
      return null;
    const gitDir = resolve3(repoRoot, match[1].trim());
    return existsSync3(gitDir) ? gitDir : null;
  } catch {
    return null;
  }
}
function resolveGitStateFilePath(repoRoot, fileName) {
  const gitMetadataDir = resolveGitMetadataDir(repoRoot);
  const normalizedFileName = String(fileName ?? "").trim();
  if (!gitMetadataDir || !normalizedFileName)
    return null;
  return resolve3(gitMetadataDir, normalizedFileName);
}

// packages/shared/src/session_event_visibility.ts
var HEARTBEAT_STATUS_RE = /\bheartbeat\b/i;
function isHeartbeatStatusSessionEvent(event) {
  const type = String(event?.type ?? "").trim().toLowerCase();
  if (type !== "status")
    return false;
  const payload = event?.payload ?? {};
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  return HEARTBEAT_STATUS_RE.test(detail) || HEARTBEAT_STATUS_RE.test(message);
}
function shouldDisplayInteractiveSessionEvent(event) {
  return !isHeartbeatStatusSessionEvent(event);
}

// scripts/pushpals-cli.ts
var DEFAULT_MONITOR_PORT = 8081;
var MONITOR_SCAN_PORTS = 32;
var MONITOR_POLL_MS = 2000;
var HTTP_TIMEOUT_MS = 2500;
var LOCALBUDDY_TIMEOUT_MS = 4000;
var SSE_RECONNECT_MS = 1500;
var DEFAULT_RUNTIME_BOOT_TIMEOUT_MS = 90000;
var DEFAULT_RUNTIME_BOOT_POLL_MS = 1000;
var DEFAULT_SERVER_BOOT_TIMEOUT_MS = 20000;
var DEFAULT_SERVICE_STABILITY_GRACE_MS = 4000;
var GITHUB_OWNER = "PushPalsDev";
var GITHUB_REPO = "pushpals";
var GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
var GITHUB_RELEASE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download`;
var GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "pushpals-cli"
};
var ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";
var stateVersion = 1;
var cliTimestampedConsoleInstalled = false;
function formatTimestampedCliLine(line, at = new Date) {
  const text = String(line ?? "");
  if (!text.startsWith("[pushpals]") && !text.startsWith("[localbuddy]")) {
    return text;
  }
  return `[${at.toISOString()}]${text}`;
}
function normalizeCliInteractiveMessage(input) {
  const trimmed = String(input ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { text: trimmed };
  }
  const rest = trimmed.slice(command.length).replace(/^[:\-]\s*/, "").trim();
  if (!rest) {
    return {
      text: "",
      usageMessage: "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard."
    };
  }
  return { text: rest };
}
function installTimestampedCliConsole() {
  if (cliTimestampedConsoleInstalled)
    return;
  cliTimestampedConsoleInstalled = true;
  const patch = (original) => (...args) => {
    if (args.length > 0 && typeof args[0] === "string") {
      args[0] = formatTimestampedCliLine(args[0]);
    }
    return original(...args);
  };
  console.log = patch(console.log.bind(console));
  console.warn = patch(console.warn.bind(console));
  console.error = patch(console.error.bind(console));
}
installTimestampedCliConsole();
function logCliInvocation(argv) {
  const startedAt = new Date().toISOString();
  const cliVersion = String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "unknown";
  const argsText = argv.length > 0 ? argv.join(" ") : "(none)";
  console.log(`[pushpals] invocation=${startedAt}`);
  console.log(`[pushpals] version=${cliVersion} runtime=bun@${Bun.version}`);
  console.log(`[pushpals] platform=${process.platform}/${process.arch}`);
  console.log(`[pushpals] cwd=${process.cwd()}`);
  console.log(`[pushpals] args=${argsText}`);
}
function printUsage() {
  console.log("PushPals CLI");
  console.log("");
  console.log("Usage:");
  console.log("  pushpals [options]");
  console.log("");
  console.log("Options:");
  console.log("  --server-url <url>     Override PushPals server URL");
  console.log("  --local-agent-url <url> Override LocalBuddy URL for monitoring/runtime state");
  console.log("  --session-id <id>      Override session ID");
  console.log("  --hub-url <url>        Override monitoring hub URL");
  console.log("  --runtime-root <path>  Override embedded runtime directory for auto-start");
  console.log("  --runtime-tag <tag>    Override runtime release tag (e.g. v1.0.2)");
  console.log("  --no-auto-start        Disable runtime auto-start when the server is down");
  console.log("  --no-stream            Disable live session event stream");
  console.log("  --runtime-only         Start the local runtime and wait for shutdown without opening the interactive chat");
  console.log("  --clear                Remove repo-local PushPals state and exit");
  console.log("  -h, --help             Show this help");
  console.log("");
  console.log("Chat commands:");
  console.log("  /hub                   Print monitoring hub URL");
  console.log("  /open                  Open monitoring hub in browser");
  console.log("  /status                Print active endpoints");
  console.log("  /exit, /quit           Quit CLI");
  console.log("");
  console.log("Notes:");
  console.log("  - Must be run from inside a git repository.");
  console.log("  - Auto-start can bootstrap server/remotebuddy/source_control_manager and LocalBuddy when runtime config enables it.");
  console.log("  - Interactive CLI talks directly to server sessions; LocalBuddy is optional.");
}
function parseArgs(argv) {
  const options = {
    noAutoStart: false,
    noStream: false,
    runtimeOnly: false,
    clear: false
  };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printUsage();
      return null;
    }
    if (arg === "--no-stream") {
      options.noStream = true;
      continue;
    }
    if (arg === "--no-auto-start") {
      options.noAutoStart = true;
      continue;
    }
    if (arg === "--runtime-only") {
      options.runtimeOnly = true;
      continue;
    }
    if (arg === "--clear") {
      options.clear = true;
      continue;
    }
    if (arg === "--server-url") {
      options.serverUrl = argv[++i];
      continue;
    }
    if (arg === "--local-agent-url") {
      options.localAgentUrl = argv[++i];
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = argv[++i];
      continue;
    }
    if (arg === "--hub-url") {
      options.monitoringHubUrl = argv[++i];
      continue;
    }
    if (arg === "--runtime-root") {
      options.runtimeRoot = argv[++i];
      continue;
    }
    if (arg === "--runtime-tag") {
      options.runtimeTag = argv[++i];
      continue;
    }
    console.error(`[pushpals] Unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }
  return options;
}
function normalizeUrl(value, fallback = "") {
  const text = String(value ?? "").trim();
  const selected = text || fallback;
  return selected.replace(/\/+$/, "");
}
function normalizeLoopbackUrl(value, fallback) {
  const selected = normalizeUrl(value, fallback);
  if (!selected)
    return "";
  try {
    const parsed = new URL(selected);
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return normalizeUrl(fallback);
  }
}
function isLoopbackUrl(value) {
  try {
    const parsed = new URL(normalizeUrl(value));
    const hostname = String(parsed.hostname ?? "").trim().toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;
  return parsed;
}
function jsonHtmlBootstrap(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
async function runCommandWithEnv(command, cwd, env) {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1
    };
  }
}
async function runGitWithEnv(args, cwd, env) {
  return await runCommandWithEnv(["git", ...args], cwd, env);
}
async function runGit(args, cwd) {
  return await runGitWithEnv(args, cwd, {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  });
}
async function resolveCurrentGitRepoRoot(cwd) {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout !== "true")
    return null;
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok || !root.stdout)
    return null;
  return resolve4(root.stdout);
}
function resolveDefaultRuntimeRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return resolve4(home, ".pushpals", "runtime");
}
function buildRuntimeAssetSource(root, protocolSchemasDir) {
  return {
    root,
    envExamplePath: join2(root, ".env.example"),
    visionExamplePath: join2(root, "vision.example.md"),
    configsDir: join2(root, "configs"),
    promptsDir: join2(root, "prompts"),
    protocolSchemasDir
  };
}
function buildWorkerpalSandboxPaths(runtimeRoot) {
  const root = join2(runtimeRoot, "sandbox");
  return {
    root,
    dockerfilePath: join2(root, "apps", "workerpals", "Dockerfile.sandbox"),
    packageJsonPath: join2(root, "package.json"),
    workerpalsDir: join2(root, "apps", "workerpals"),
    sharedDir: join2(root, "packages", "shared"),
    protocolDir: join2(root, "packages", "protocol"),
    configsDir: join2(root, "configs"),
    workerpalsPromptsDir: join2(root, "prompts", "workerpals"),
    protocolSchemasDir: join2(root, "protocol", "schemas")
  };
}
function normalizeGitTrackedPath(pathValue) {
  return String(pathValue ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
function listTrackedRepoFilesForPath(repoRoot, sourcePath) {
  const normalizedSource = normalizeGitTrackedPath(sourcePath);
  if (!normalizedSource)
    return [];
  const proc = Bun.spawnSync(["git", "ls-files", "-z", "--", normalizedSource], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never"
    }
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr ?? []).toString("utf8").trim();
    throw new Error(`git ls-files failed for ${normalizedSource}${stderr ? `: ${stderr}` : ""}`);
  }
  return Buffer.from(proc.stdout ?? []).toString("utf8").split("\x00").map(normalizeGitTrackedPath).filter(Boolean);
}
function copyTrackedRepoPath(repoRoot, sourcePath, destinationPath, force = true) {
  const normalizedSource = normalizeGitTrackedPath(sourcePath);
  if (!normalizedSource) {
    throw new Error("sourcePath is required");
  }
  const absoluteSource = resolve4(repoRoot, normalizedSource);
  if (!existsSync4(absoluteSource)) {
    throw new Error(`tracked repo source is missing: ${absoluteSource}`);
  }
  const trackedFiles = listTrackedRepoFilesForPath(repoRoot, normalizedSource);
  const sourceStat = lstatSync(absoluteSource);
  if (!sourceStat.isDirectory()) {
    if (!trackedFiles.includes(normalizedSource)) {
      throw new Error(`tracked repo file is not tracked by git: ${normalizedSource}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(absoluteSource, destinationPath, {
      recursive: false,
      force,
      errorOnExist: false
    });
    return;
  }
  if (trackedFiles.length === 0) {
    throw new Error(`tracked repo directory has no tracked files: ${normalizedSource}`);
  }
  for (const trackedFile of trackedFiles) {
    const relativePath = trackedFile === normalizedSource ? basename(trackedFile) : trackedFile.slice(normalizedSource.length + 1);
    const sourceFile = resolve4(repoRoot, trackedFile);
    const targetFile = join2(destinationPath, relativePath);
    mkdirSync(dirname(targetFile), { recursive: true });
    cpSync(sourceFile, targetFile, {
      recursive: false,
      force,
      errorOnExist: false
    });
  }
}
function isCompleteWorkerpalSandboxRoot(root) {
  return existsSync4(join2(root, "package.json")) && existsSync4(join2(root, "apps", "workerpals", "Dockerfile.sandbox")) && existsSync4(join2(root, "packages", "shared", "package.json")) && existsSync4(join2(root, "packages", "protocol", "package.json")) && existsSync4(join2(root, "configs", "default.toml")) && existsSync4(join2(root, "prompts", "workerpals")) && existsSync4(join2(root, "protocol", "schemas", "envelope.schema.json")) && existsSync4(join2(root, "protocol", "schemas", "events.schema.json"));
}
function populateWorkerpalSandboxRuntimeAssets(runtimeRoot, force) {
  const sandbox = buildWorkerpalSandboxPaths(runtimeRoot);
  cpSync(join2(runtimeRoot, "configs"), sandbox.configsDir, {
    recursive: true,
    force,
    errorOnExist: false
  });
  cpSync(join2(runtimeRoot, "prompts", "workerpals"), sandbox.workerpalsPromptsDir, {
    recursive: true,
    force,
    errorOnExist: false
  });
  cpSync(join2(runtimeRoot, "protocol", "schemas"), sandbox.protocolSchemasDir, {
    recursive: true,
    force,
    errorOnExist: false
  });
}
function copySourceCheckoutWorkerpalSandboxBuildContext(sourceRoot, runtimeRoot, force) {
  const sandbox = buildWorkerpalSandboxPaths(runtimeRoot);
  const copyPairs = [
    ["package.json", sandbox.packageJsonPath],
    ["apps/workerpals", sandbox.workerpalsDir],
    ["packages/shared", sandbox.sharedDir],
    ["packages/protocol", sandbox.protocolDir]
  ];
  for (const [fromPath, toPath] of copyPairs) {
    copyTrackedRepoPath(sourceRoot, fromPath, toPath, force);
  }
  if (existsSync4(join2(sourceRoot, "bun.lock"))) {
    copyTrackedRepoPath(sourceRoot, "bun.lock", join2(sandbox.root, "bun.lock"), force);
  }
  populateWorkerpalSandboxRuntimeAssets(runtimeRoot, force);
}
function copyWorkerpalSandboxBuildContext(source, runtimeRoot, force) {
  const packagedSandboxRoot = join2(source.root, "sandbox");
  if (isCompleteWorkerpalSandboxRoot(packagedSandboxRoot)) {
    cpSync(packagedSandboxRoot, join2(runtimeRoot, "sandbox"), {
      recursive: true,
      force,
      errorOnExist: false
    });
    return;
  }
  copySourceCheckoutWorkerpalSandboxBuildContext(source.root, runtimeRoot, force);
}
function isCompleteRuntimeAssetSource(source) {
  return existsSync4(source.envExamplePath) && existsSync4(source.visionExamplePath) && existsSync4(join2(source.configsDir, "default.toml")) && existsSync4(source.promptsDir) && existsSync4(join2(source.protocolSchemasDir, "envelope.schema.json")) && existsSync4(join2(source.protocolSchemasDir, "events.schema.json"));
}
function resolveBundledRuntimeAssetSource() {
  const candidates = [
    buildRuntimeAssetSource(resolve4(import.meta.dir, "..", "runtime"), resolve4(import.meta.dir, "..", "runtime", "protocol", "schemas")),
    buildRuntimeAssetSource(resolve4(import.meta.dir, ".."), resolve4(import.meta.dir, "..", "packages", "protocol", "src", "schemas")),
    buildRuntimeAssetSource(resolve4(import.meta.dir, "..", "packages", "cli", "runtime"), resolve4(import.meta.dir, "..", "packages", "cli", "runtime", "protocol", "schemas"))
  ];
  for (const candidate of candidates) {
    if (isCompleteRuntimeAssetSource(candidate))
      return candidate;
  }
  return null;
}
function looksLikeMonitoringHubBuild(root) {
  return existsSync4(join2(root, "index.html")) && existsSync4(join2(root, "_expo"));
}
function latestPathMtimeMs(pathValue) {
  if (!existsSync4(pathValue))
    return 0;
  const stat = lstatSync(pathValue);
  let latest = stat.mtimeMs;
  if (!stat.isDirectory())
    return latest;
  for (const entry of readdirSync(pathValue)) {
    latest = Math.max(latest, latestPathMtimeMs(join2(pathValue, entry)));
  }
  return latest;
}
function bundledMonitoringHubSourceWatchPaths(sourceRoot) {
  return [
    join2(sourceRoot, "apps", "client", "app"),
    join2(sourceRoot, "apps", "client", "assets"),
    join2(sourceRoot, "apps", "client", "components"),
    join2(sourceRoot, "apps", "client", "constants"),
    join2(sourceRoot, "apps", "client", "hooks"),
    join2(sourceRoot, "apps", "client", "scripts"),
    join2(sourceRoot, "apps", "client", "src"),
    join2(sourceRoot, "apps", "client", "app.json"),
    join2(sourceRoot, "apps", "client", "package.json"),
    join2(sourceRoot, "packages", "shared", "src"),
    join2(sourceRoot, "scripts", "sync-cli-monitor-ui.ts")
  ];
}
function bundledMonitoringHubNeedsRefresh(existingRoot, sourceRoot) {
  if (!looksLikeMonitoringHubBuild(existingRoot))
    return true;
  const bundleMtimeMs = latestPathMtimeMs(existingRoot);
  if (bundleMtimeMs <= 0)
    return true;
  const sourceMtimeMs = bundledMonitoringHubSourceWatchPaths(sourceRoot).reduce((latest, pathValue) => Math.max(latest, latestPathMtimeMs(pathValue)), 0);
  return sourceMtimeMs > bundleMtimeMs;
}
function resolveBundledMonitoringHubRoot() {
  const candidates = [
    resolve4(import.meta.dir, "..", "monitor-ui"),
    resolve4(import.meta.dir, "..", "packages", "cli", "monitor-ui")
  ];
  for (const candidate of candidates) {
    if (looksLikeMonitoringHubBuild(candidate))
      return candidate;
  }
  return null;
}
function resolveCliSourceCheckoutRoot() {
  const candidates = [
    resolve4(import.meta.dir, ".."),
    resolve4(import.meta.dir, "..", ".."),
    resolve4(import.meta.dir, "..", "..", "..")
  ];
  for (const candidate of candidates) {
    if (existsSync4(join2(candidate, "package.json")) && existsSync4(join2(candidate, "apps", "client", "app.json")) && existsSync4(join2(candidate, "scripts", "sync-cli-monitor-ui.ts"))) {
      return candidate;
    }
  }
  return null;
}
function exportBundledMonitoringHubFromSourceCheckout(sourceRoot) {
  const exportScriptPath = join2(sourceRoot, "scripts", "sync-cli-monitor-ui.ts");
  console.log("[pushpals] Packaged monitor UI missing; exporting the shared client monitor...");
  const proc = Bun.spawnSync([process.execPath, exportScriptPath], {
    cwd: sourceRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env
  });
  if (proc.exitCode !== 0) {
    throw new Error(`Failed to export packaged monitor UI from source checkout (exit ${proc.exitCode || 1})`);
  }
}
async function ensureBundledMonitoringHubRoot() {
  const existingRoot = resolveBundledMonitoringHubRoot();
  const sourceRoot = resolveCliSourceCheckoutRoot();
  if (!sourceRoot)
    return existingRoot;
  if (existingRoot && !bundledMonitoringHubNeedsRefresh(existingRoot, sourceRoot)) {
    return existingRoot;
  }
  if (existingRoot) {
    console.log("[pushpals] Packaged monitor UI is stale; refreshing the exported client monitor...");
  }
  exportBundledMonitoringHubFromSourceCheckout(sourceRoot);
  return resolveBundledMonitoringHubRoot();
}
function repoLooksLikePushPalsSourceCheckout(repoRoot) {
  return existsSync4(join2(repoRoot, "configs", "default.toml")) || existsSync4(join2(repoRoot, "config", "default.toml"));
}
function parseSemverFromPackageVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw)
    return "";
  const match = raw.match(/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/);
  return match ? raw : "";
}
function resolveRuntimePlatformKey() {
  if (process.platform === "win32")
    return "windows-x64";
  if (process.platform === "linux")
    return "linux-x64";
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  }
  throw new Error(`Unsupported platform for embedded runtime binaries: ${process.platform}/${process.arch}`);
}
async function fetchLatestReleaseTag() {
  const response = await fetchWithTimeout(`${GITHUB_API_URL}/releases/latest`, { headers: GITHUB_HEADERS }, 20000);
  if (!response.ok) {
    throw new Error(`Failed to resolve latest release tag (HTTP ${response.status})`);
  }
  const payload = await response.json();
  const tagName = String(payload.tag_name ?? "").trim();
  if (!tagName)
    throw new Error("Latest release payload did not include tag_name");
  return tagName;
}
function resolvePreferredRuntimeReleaseTag(explicitTag, env = process.env) {
  const fromArg = String(explicitTag ?? "").trim();
  if (fromArg)
    return fromArg;
  const fromEnv = String(env.PUSHPALS_RUNTIME_TAG ?? "").trim();
  if (fromEnv)
    return fromEnv;
  const packageVersion = parseSemverFromPackageVersion(env.PUSHPALS_CLI_PACKAGE_VERSION);
  if (packageVersion)
    return `v${packageVersion}`;
  return "";
}
async function resolveRuntimeReleaseTag(explicitTag) {
  const preferredTag = resolvePreferredRuntimeReleaseTag(explicitTag, process.env);
  if (preferredTag)
    return preferredTag;
  console.log("[pushpals] Resolving embedded runtime release tag from GitHub...");
  return await fetchLatestReleaseTag();
}
function writeTextFileIfMissing(pathValue, text) {
  if (existsSync4(pathValue))
    return;
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, text, "utf8");
}
function copyRuntimeAssetBundle(source, runtimeRoot, force) {
  mkdirSync(runtimeRoot, { recursive: true });
  cpSync(source.envExamplePath, join2(runtimeRoot, ".env.example"), {
    force,
    errorOnExist: false
  });
  cpSync(source.visionExamplePath, join2(runtimeRoot, "vision.example.md"), {
    force,
    errorOnExist: false
  });
  cpSync(source.configsDir, join2(runtimeRoot, "configs"), {
    recursive: true,
    force,
    errorOnExist: false
  });
  cpSync(source.promptsDir, join2(runtimeRoot, "prompts"), {
    recursive: true,
    force,
    errorOnExist: false
  });
  cpSync(source.protocolSchemasDir, join2(runtimeRoot, "protocol", "schemas"), {
    recursive: true,
    force,
    errorOnExist: false
  });
  copyWorkerpalSandboxBuildContext(source, runtimeRoot, force);
}
function copyBundledRuntimeAssets(runtimeRoot, force = true) {
  const bundledSource = resolveBundledRuntimeAssetSource();
  if (!bundledSource)
    return false;
  copyRuntimeAssetBundle(bundledSource, runtimeRoot, force);
  return true;
}
function seedRuntimePreflightAssets(runtimeRoot) {
  copyBundledRuntimeAssets(runtimeRoot, false);
  writeTextFileIfMissing(join2(runtimeRoot, ".env"), `# Local PushPals runtime environment
`);
  const localExamplePath = join2(runtimeRoot, "configs", "local.example.toml");
  if (existsSync4(localExamplePath)) {
    writeTextFileIfMissing(join2(runtimeRoot, "configs", "local.toml"), readFileSync4(localExamplePath, "utf8"));
  } else {
    writeTextFileIfMissing(join2(runtimeRoot, "configs", "local.toml"), `# Local PushPals runtime overrides
`);
  }
}
async function fetchTextFromUrl(url, timeoutMs = 20000) {
  const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return await response.text();
}
async function downloadRuntimeAssetsFromSourceTag(runtimeRoot, tag) {
  console.log(`[pushpals] Downloading embedded runtime assets from source tag ${tag}...`);
  const treeUrl = `${GITHUB_API_URL}/git/trees/${encodeURIComponent(tag)}?recursive=1`;
  const treeResponse = await fetchWithTimeout(treeUrl, { headers: GITHUB_HEADERS }, 30000);
  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch runtime source tree for ${tag} (HTTP ${treeResponse.status})`);
  }
  const treePayload = await treeResponse.json();
  const paths = (treePayload.tree ?? []).filter((entry) => entry.type === "blob" && typeof entry.path === "string").map((entry) => String(entry.path)).filter((pathValue) => pathValue === ".env.example" || pathValue === "vision.example.md" || pathValue === "package.json" || pathValue === "bun.lock" || pathValue.startsWith("configs/") || pathValue.startsWith("prompts/workerpals/") || pathValue.startsWith("prompts/") || pathValue.startsWith("apps/workerpals/") || pathValue.startsWith("packages/shared/") || pathValue.startsWith("packages/protocol/") || pathValue.startsWith("packages/protocol/src/schemas/"));
  if (paths.length === 0) {
    throw new Error(`Runtime source tree for ${tag} did not include prompts/config assets`);
  }
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  for (const pathValue of sorted) {
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${encodeURIComponent(tag)}/${pathValue}`;
    const body = await fetchTextFromUrl(rawUrl, 20000);
    const outPath = pathValue === "package.json" || pathValue === "bun.lock" ? join2(runtimeRoot, "sandbox", pathValue) : pathValue.startsWith("apps/workerpals/") || pathValue.startsWith("packages/shared/") || pathValue.startsWith("packages/protocol/") ? join2(runtimeRoot, "sandbox", pathValue) : join2(runtimeRoot, pathValue);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, body, "utf8");
    if (pathValue.startsWith("packages/protocol/src/schemas/")) {
      const runtimeSchemaPath = join2(runtimeRoot, "protocol", "schemas", pathValue.slice("packages/protocol/src/schemas/".length));
      mkdirSync(dirname(runtimeSchemaPath), { recursive: true });
      writeFileSync(runtimeSchemaPath, body, "utf8");
    }
  }
  populateWorkerpalSandboxRuntimeAssets(runtimeRoot, true);
}
async function ensureRuntimeAssets(runtimeRoot, runtimeTag) {
  console.log(`[pushpals] Preparing embedded runtime assets for ${runtimeTag}...`);
  const markerPath = join2(runtimeRoot, ".runtime-assets-tag");
  const currentTag = existsSync4(markerPath) ? readFileSync4(markerPath, "utf8").trim() : "";
  const protocolSchemasDir = join2(runtimeRoot, "protocol", "schemas");
  const hasProtocolSchemas = existsSync4(join2(protocolSchemasDir, "envelope.schema.json")) && existsSync4(join2(protocolSchemasDir, "events.schema.json"));
  const hasAssets = existsSync4(join2(runtimeRoot, ".env.example")) && existsSync4(join2(runtimeRoot, "vision.example.md")) && existsSync4(join2(runtimeRoot, "configs", "default.toml")) && existsSync4(join2(runtimeRoot, "prompts")) && hasProtocolSchemas && isCompleteWorkerpalSandboxRoot(join2(runtimeRoot, "sandbox"));
  if (!hasAssets || currentTag !== runtimeTag) {
    console.log(`[pushpals] Embedded runtime assets ${hasAssets ? "are stale" : "are missing"}; refreshing bundle...`);
    copyBundledRuntimeAssets(runtimeRoot);
    const hasProtocolSchemasAfterCopy = existsSync4(join2(protocolSchemasDir, "envelope.schema.json")) && existsSync4(join2(protocolSchemasDir, "events.schema.json"));
    const hasAssetsAfterCopy = existsSync4(join2(runtimeRoot, ".env.example")) && existsSync4(join2(runtimeRoot, "vision.example.md")) && existsSync4(join2(runtimeRoot, "configs", "default.toml")) && existsSync4(join2(runtimeRoot, "prompts")) && hasProtocolSchemasAfterCopy && isCompleteWorkerpalSandboxRoot(join2(runtimeRoot, "sandbox"));
    if (!hasAssetsAfterCopy) {
      console.log("[pushpals] Bundled runtime assets are incomplete; falling back to release source downloads...");
      await downloadRuntimeAssetsFromSourceTag(runtimeRoot, runtimeTag);
    }
    writeFileSync(markerPath, `${runtimeTag}
`, "utf8");
  }
  writeTextFileIfMissing(join2(runtimeRoot, ".env"), `# Local PushPals runtime environment
`);
  const localExamplePath = join2(runtimeRoot, "configs", "local.example.toml");
  if (existsSync4(localExamplePath)) {
    writeTextFileIfMissing(join2(runtimeRoot, "configs", "local.toml"), readFileSync4(localExamplePath, "utf8"));
  } else {
    writeTextFileIfMissing(join2(runtimeRoot, "configs", "local.toml"), `# Local PushPals runtime overrides
`);
  }
  console.log("[pushpals] Embedded runtime assets are ready.");
}
function resolveDeferredRuntimeTagHint(explicitTag) {
  return String(explicitTag || process.env.PUSHPALS_RUNTIME_TAG || "").trim();
}
async function prepareCliRuntime(opts) {
  const runtimeRoot = resolve4(opts.runtimeRoot || process.env.PUSHPALS_RUNTIME_ROOT || resolveDefaultRuntimeRoot());
  if (repoLooksLikePushPalsSourceCheckout(opts.repoRoot)) {
    return {
      runtimeRoot,
      runtimeTag: "",
      runtimePreflight: evaluateClientRuntimePreflight({
        projectRoot: opts.repoRoot
      }),
      preflightUsesEmbeddedRuntime: false
    };
  }
  seedRuntimePreflightAssets(runtimeRoot);
  return {
    runtimeRoot,
    runtimeTag: resolveDeferredRuntimeTagHint(opts.runtimeTag),
    runtimePreflight: evaluateClientRuntimePreflight({
      projectRoot: opts.repoRoot,
      runtimeRoot,
      visionTemplateRoot: runtimeRoot
    }),
    preflightUsesEmbeddedRuntime: true
  };
}
function emitCliRuntimePreflight(result) {
  const lines = formatClientRuntimePreflightLines(result, "[pushpals]");
  if (result.ok) {
    for (const line of lines)
      console.log(line);
    return;
  }
  for (const line of lines)
    console.error(line);
}
function runtimeBinaryFilename(serviceName, platformKey) {
  const serviceToken = serviceName === "source_control_manager" ? "source-control-manager" : serviceName;
  const extension = platformKey.startsWith("windows-") ? ".exe" : "";
  return `pushpals-runtime-${serviceToken}-${platformKey}${extension}`;
}
function buildEmbeddedRuntimeEnv(baseEnv, opts) {
  const env = normalizeChildProcessEnv(baseEnv);
  const useRuntimeConfig = opts.useRuntimeConfig !== false;
  return {
    ...env,
    PUSHPALS_REPO_ROOT_OVERRIDE: opts.repoRoot,
    PUSHPALS_PROJECT_ROOT_OVERRIDE: opts.repoRoot,
    ...useRuntimeConfig ? {
      PUSHPALS_CONFIG_DIR_OVERRIDE: join2(opts.runtimeRoot, "configs"),
      PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.runtimeRoot,
      PUSHPALS_WORKERPALS_SANDBOX_ROOT: join2(opts.runtimeRoot, "sandbox"),
      ...typeof opts.runtimeTag === "string" && opts.runtimeTag.trim() ? { PUSHPALS_RUNTIME_TAG: opts.runtimeTag.trim() } : {}
    } : {
      PUSHPALS_PROMPTS_ROOT_OVERRIDE: opts.repoRoot
    },
    PUSHPALS_PROTOCOL_SCHEMAS_DIR: join2(opts.runtimeRoot, "protocol", "schemas"),
    ...typeof opts.sessionId === "string" && opts.sessionId.trim() ? { PUSHPALS_SESSION_ID: opts.sessionId.trim() } : {},
    ...typeof env.PUSHPALS_GIT_BIN === "string" && env.PUSHPALS_GIT_BIN.trim() ? { PUSHPALS_GIT_BIN: env.PUSHPALS_GIT_BIN.trim() } : {},
    ...typeof env.PUSHPALS_GIT_BIN_ABSOLUTE === "string" && env.PUSHPALS_GIT_BIN_ABSOLUTE.trim() ? { PUSHPALS_GIT_BIN_ABSOLUTE: env.PUSHPALS_GIT_BIN_ABSOLUTE.trim() } : {},
    ...typeof env.PUSHPALS_DOCKER_BIN === "string" && env.PUSHPALS_DOCKER_BIN.trim() ? { PUSHPALS_DOCKER_BIN: env.PUSHPALS_DOCKER_BIN.trim() } : {},
    ...typeof env.PUSHPALS_DOCKER_BIN_ABSOLUTE === "string" && env.PUSHPALS_DOCKER_BIN_ABSOLUTE.trim() ? { PUSHPALS_DOCKER_BIN_ABSOLUTE: env.PUSHPALS_DOCKER_BIN_ABSOLUTE.trim() } : {}
  };
}
function normalizeChildProcessEnv(baseEnv, platform = process.platform) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string")
      env[key] = value;
  }
  if (platform === "win32") {
    const resolvedPath = String(env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? "").trim();
    if (resolvedPath) {
      env.Path = resolvedPath;
      env.PATH = resolvedPath;
    }
    const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "").trim();
    if (systemRoot) {
      env.SystemRoot = systemRoot;
      env.SYSTEMROOT = systemRoot;
    }
    const comSpec = String(env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "").trim();
    if (comSpec) {
      env.ComSpec = comSpec;
      env.COMSPEC = comSpec;
    }
  }
  return env;
}
async function resolveCommandPath(command, cwd, env) {
  const lookupCommands = process.platform === "win32" ? resolveWindowsWhereExecutableCandidatesForEnv(env, process.platform).map((lookup) => [lookup, command]) : [["which", command]];
  for (const lookup of lookupCommands) {
    try {
      const proc = Bun.spawn(lookup, {
        cwd,
        env,
        stdout: "pipe",
        stderr: "ignore"
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0)
        continue;
      const resolved = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      if (resolved)
        return resolved;
    } catch {}
  }
  return null;
}
function timestampFileToken() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function buildRuntimeServiceLogPaths(logDir, runToken) {
  return {
    server: join2(logDir, `${runToken}-server.log`),
    localbuddy: join2(logDir, `${runToken}-localbuddy.log`),
    remotebuddy: join2(logDir, `${runToken}-remotebuddy.log`),
    source_control_manager: join2(logDir, `${runToken}-source_control_manager.log`)
  };
}
function appendRuntimeServicesLogLine(logPath, line) {
  const text = String(line ?? "").trim();
  if (!text)
    return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${text}
`, "utf8");
  } catch {}
}
function readLogTail(logPath, maxLines = 40) {
  if (!existsSync4(logPath))
    return "";
  const raw = readFileSync4(logPath, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines.length === 0)
    return "";
  return lines.slice(-maxLines).join(`
`);
}
function extractRemoteBuddyAutonomousEngineState(logText) {
  const text = String(logText ?? "");
  if (!text)
    return "unknown";
  let state = "unknown";
  for (const line of text.split(/\r?\n/)) {
    if (/Autonomous engine:\s*enabled\b/i.test(line)) {
      state = "enabled";
      continue;
    }
    if (/Autonomous engine:\s*disabled\b/i.test(line)) {
      state = "disabled";
    }
  }
  return state;
}
function readRemoteBuddyAutonomousEngineState(logPath) {
  if (!existsSync4(logPath))
    return "unknown";
  try {
    return extractRemoteBuddyAutonomousEngineState(readFileSync4(logPath, "utf8"));
  } catch {
    return "unknown";
  }
}
async function downloadBinaryAsset(tag, assetName, outPath) {
  console.log(`[pushpals] Downloading embedded runtime binary ${assetName} from ${tag}...`);
  const url = `${GITHUB_RELEASE_URL}/${encodeURIComponent(tag)}/${assetName}`;
  const response = await fetchWithTimeout(url, { headers: GITHUB_HEADERS }, 60000);
  if (!response.ok) {
    throw new Error(`Failed to download ${assetName} from ${tag} (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, bytes);
}
async function ensureRuntimeBinaries(runtimeRoot, runtimeTag) {
  const platformKey = resolveRuntimePlatformKey();
  console.log(`[pushpals] Preparing embedded runtime binaries for ${runtimeTag} (${platformKey})...`);
  const binDir = join2(runtimeRoot, "bin", `${runtimeTag}-${platformKey}`);
  mkdirSync(binDir, { recursive: true });
  const runtimeBinaries = {
    server: join2(binDir, runtimeBinaryFilename("server", platformKey)),
    localbuddy: join2(binDir, runtimeBinaryFilename("localbuddy", platformKey)),
    remotebuddy: join2(binDir, runtimeBinaryFilename("remotebuddy", platformKey)),
    workerpals: join2(binDir, runtimeBinaryFilename("workerpals", platformKey)),
    sourceControlManager: join2(binDir, runtimeBinaryFilename("source_control_manager", platformKey))
  };
  const requiredAssets = [
    runtimeBinaries.server,
    runtimeBinaries.localbuddy,
    runtimeBinaries.remotebuddy,
    runtimeBinaries.workerpals,
    runtimeBinaries.sourceControlManager
  ];
  let downloadedCount = 0;
  for (const binaryPath of requiredAssets) {
    if (existsSync4(binaryPath))
      continue;
    const assetName = binaryPath.split(/[\\/]/).pop() || "";
    await downloadBinaryAsset(runtimeTag, assetName, binaryPath);
    downloadedCount++;
  }
  if (process.platform !== "win32") {
    for (const binaryPath of requiredAssets) {
      try {
        chmodSync(binaryPath, 493);
      } catch {}
    }
  }
  if (downloadedCount === 0) {
    console.log("[pushpals] Embedded runtime binaries are already present.");
  } else {
    console.log(`[pushpals] Embedded runtime binaries downloaded: ${downloadedCount}.`);
  }
  console.log("[pushpals] Embedded runtime binaries are ready.");
  return runtimeBinaries;
}
function spawnRuntimeService(name, command, cwd, env, logPath, runtimeServicesLogPath) {
  const header = `[pushpals] service=${name} command=${command.join(" ")} cwd=${cwd}`;
  writeFileSync(logPath, `${header}
`, "utf8");
  if (runtimeServicesLogPath) {
    appendRuntimeServicesLogLine(runtimeServicesLogPath, header);
  }
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe"
  });
  const pipeToLog = async (stream, channel) => {
    if (!stream)
      return;
    const reader = stream.getReader();
    const decoder = new TextDecoder;
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk)
        continue;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const serviceLine = `[${channel}] ${line}`;
        appendFileSync(logPath, `${serviceLine}
`, "utf8");
        if (runtimeServicesLogPath) {
          appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
        }
      }
    }
    const rest = decoder.decode();
    if (rest)
      pending += rest;
    if (pending.trim().length > 0) {
      const serviceLine = `[${channel}] ${pending.trimEnd()}`;
      appendFileSync(logPath, `${serviceLine}
`, "utf8");
      if (runtimeServicesLogPath) {
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[${name}] ${serviceLine}`);
      }
    }
  };
  pipeToLog(proc.stdout, "stdout");
  pipeToLog(proc.stderr, "stderr");
  const service = {
    name,
    proc,
    logPath,
    exited: false,
    exitCode: null
  };
  proc.exited.then((code) => {
    service.exited = true;
    service.exitCode = code;
  });
  return service;
}
function buildServiceStopCommand(pid, platform = process.platform) {
  if (platform === "win32" && typeof pid === "number" && pid > 0) {
    return ["taskkill", "/PID", String(pid), "/T", "/F"];
  }
  return null;
}
function stopRuntimeServices(services) {
  for (const service of services) {
    try {
      const stopCommand = buildServiceStopCommand(service.proc.pid, process.platform);
      if (stopCommand) {
        Bun.spawnSync(stopCommand, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore"
        });
      } else {
        service.proc.kill();
      }
    } catch {}
  }
}
function prependExecutableDirToPath(env, executablePath, platform = process.platform) {
  const resolvedPath = String(executablePath ?? "").trim();
  if (!resolvedPath)
    return env;
  if (!resolvedPath.includes("/") && !resolvedPath.includes("\\")) {
    return env;
  }
  const executableDir = dirname(resolvedPath);
  const existingPath = platform === "win32" ? String(env.Path ?? env.PATH ?? "") : String(env.PATH ?? "");
  const pathEntries = existingPath.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const hasDir = pathEntries.some((entry) => platform === "win32" ? entry.toLowerCase() === executableDir.toLowerCase() : entry === executableDir);
  const nextPath = hasDir ? existingPath : [executableDir, ...pathEntries].join(delimiter);
  if (platform === "win32") {
    env.Path = nextPath;
    env.PATH = nextPath;
  } else {
    env.PATH = nextPath;
  }
  return env;
}
function applyResolvedGitBinaryToRuntimeEnv(env, resolvedGitBinary, platform = process.platform) {
  const resolvedPath = String(resolvedGitBinary ?? "").trim();
  if (!resolvedPath)
    return env;
  prependExecutableDirToPath(env, resolvedPath, platform);
  env.PUSHPALS_GIT_BIN = basename(resolvedPath);
  if (resolvedPath.includes("/") || resolvedPath.includes("\\")) {
    env.PUSHPALS_GIT_BIN_ABSOLUTE = resolvedPath;
  } else {
    delete env.PUSHPALS_GIT_BIN_ABSOLUTE;
  }
  return env;
}
function applyResolvedDockerBinaryToRuntimeEnv(env, resolvedDockerBinary, platform = process.platform) {
  const resolvedPath = String(resolvedDockerBinary ?? "").trim();
  if (!resolvedPath)
    return env;
  prependExecutableDirToPath(env, resolvedPath, platform);
  env.PUSHPALS_DOCKER_BIN = basename(resolvedPath);
  if (resolvedPath.includes("/") || resolvedPath.includes("\\")) {
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE = resolvedPath;
  } else {
    delete env.PUSHPALS_DOCKER_BIN_ABSOLUTE;
  }
  return env;
}
function resolveRuntimeGitExecutableCandidates(env, platform = process.platform) {
  const candidates = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  pushCandidate(env.PUSHPALS_GIT_BIN ?? "");
  pushCandidate(env.PUSHPALS_GIT_BIN_ABSOLUTE ?? "");
  pushCandidate(platform === "win32" ? "git.exe" : "git");
  pushCandidate("git");
  return candidates;
}
function resolveRuntimeDockerExecutableCandidates(env, platform = process.platform) {
  const candidates = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  pushCandidate(env.PUSHPALS_DOCKER_BIN ?? "");
  pushCandidate(env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "");
  pushCandidate(platform === "win32" ? "docker.exe" : "docker");
  pushCandidate("docker");
  return candidates;
}
function resolveWindowsShellExecutableCandidatesForEnv(env, platform = process.platform) {
  if (platform !== "win32")
    return [];
  const candidates = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = trimmed.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  const comSpec = String(env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "").trim();
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "").trim();
  pushCandidate(comSpec);
  if (systemRoot) {
    pushCandidate(pathWin32.join(systemRoot, "System32", "cmd.exe"));
    pushCandidate(pathWin32.join(systemRoot, "Sysnative", "cmd.exe"));
  }
  pushCandidate("cmd.exe");
  return candidates;
}
function resolveWindowsWhereExecutableCandidatesForEnv(env, platform = process.platform) {
  if (platform !== "win32")
    return [];
  const candidates = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = trimmed.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "").trim();
  if (systemRoot) {
    pushCandidate(pathWin32.join(systemRoot, "System32", "where.exe"));
    pushCandidate(pathWin32.join(systemRoot, "Sysnative", "where.exe"));
  }
  pushCandidate("where.exe");
  pushCandidate("where");
  return candidates;
}
function quoteWindowsCmdArg(value) {
  const text = String(value ?? "");
  if (!text.length)
    return '""';
  if (!/[ \t"]/.test(text))
    return text;
  const escaped = text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}
function isOptionalEmbeddedService(name) {
  return name === "source_control_manager";
}
async function canSpawnCommand(command, cwd, env) {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
async function canSpawnGitViaWindowsShell(commandArgs, cwd, env, platform = process.platform) {
  if (platform !== "win32")
    return false;
  const commandLine = commandArgs.map((arg) => quoteWindowsCmdArg(arg)).join(" ");
  for (const shellExecutable of resolveWindowsShellExecutableCandidatesForEnv(env, platform)) {
    try {
      const proc = Bun.spawn([shellExecutable, "/d", "/s", "/c", commandLine], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore"
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {}
  }
  return false;
}
async function resolveSourceControlManagerGitProbe(cwd, env, platform = process.platform) {
  const candidates = resolveRuntimeGitExecutableCandidates(env, platform);
  for (const candidate of candidates) {
    if (await canSpawnCommand([candidate, "--version"], cwd, env)) {
      return { ok: true, detail: candidate };
    }
  }
  if (platform === "win32") {
    for (const candidate of candidates) {
      if (await canSpawnGitViaWindowsShell([candidate, "--version"], cwd, env, platform)) {
        return { ok: true, detail: `${candidate} via shell` };
      }
    }
  }
  return {
    ok: false,
    detail: candidates.join(", ") || "git"
  };
}
async function resolveWorkerpalDockerProbe(cwd, env, platform = process.platform) {
  const resolvedDockerBinary = await resolveCommandPath(platform === "win32" ? "docker.exe" : "docker", cwd, env);
  if (resolvedDockerBinary) {
    prependExecutableDirToPath(env, resolvedDockerBinary, platform);
    env.PUSHPALS_DOCKER_BIN = basename(resolvedDockerBinary);
    env.PUSHPALS_DOCKER_BIN_ABSOLUTE = resolvedDockerBinary;
  }
  const candidates = resolveRuntimeDockerExecutableCandidates(env, platform);
  const failures = [];
  for (const candidate of candidates) {
    const result = await runCommandWithEnv([candidate, "version", "--format", "{{.Server.Version}}"], cwd, env);
    if (result.ok) {
      const version = result.stdout.trim();
      return {
        ok: true,
        detail: version ? `${candidate} (${version})` : candidate
      };
    }
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    failures.push(`${candidate}: ${detail}`);
  }
  return {
    ok: false,
    detail: failures.join(" | ") || "docker"
  };
}
var WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
var WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
function resolveConfiguredDockerExecutable(env, platform = process.platform) {
  const configured = String(env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? env.PUSHPALS_DOCKER_BIN ?? (platform === "win32" ? "docker.exe" : "docker")).trim();
  return configured || (platform === "win32" ? "docker.exe" : "docker");
}
async function inspectDockerImageRuntimeTag(dockerExecutable, imageName, cwd, env) {
  const inspect = await runCommandWithEnv([
    dockerExecutable,
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
    imageName
  ], cwd, env);
  if (!inspect.ok)
    return "";
  const value = inspect.stdout.trim();
  return value === "<no value>" ? "" : value;
}
async function ensureWorkerpalDockerImageReady(opts) {
  const runtimeTag = String(opts.runtimeTag ?? "").trim();
  if (!runtimeTag) {
    return {
      ok: false,
      detail: "embedded runtime tag is required to prepare the WorkerPal sandbox image"
    };
  }
  await (opts.ensureRuntimeAssetsFn ?? ensureRuntimeAssets)(opts.runtimeRoot, runtimeTag);
  const sandbox = buildWorkerpalSandboxPaths(opts.runtimeRoot);
  if (!isCompleteWorkerpalSandboxRoot(sandbox.root)) {
    return {
      ok: false,
      detail: `embedded WorkerPal sandbox assets are incomplete at ${sandbox.root}`
    };
  }
  const dockerExecutable = resolveConfiguredDockerExecutable(opts.env, opts.platform ?? process.platform);
  const inspectImageRuntimeTagFn = opts.inspectImageRuntimeTagFn ?? inspectDockerImageRuntimeTag;
  const runCommandWithEnvFn = opts.runCommandWithEnvFn ?? runCommandWithEnv;
  const existingRuntimeTag = await inspectImageRuntimeTagFn(dockerExecutable, opts.dockerImage, sandbox.root, opts.env);
  if (existingRuntimeTag === runtimeTag) {
    return {
      ok: true,
      detail: `WorkerPal sandbox image is ready locally (${opts.dockerImage}, runtimeTag=${runtimeTag})`
    };
  }
  console.log(existingRuntimeTag ? `[pushpals] WorkerPal sandbox image ${opts.dockerImage} is stale (runtimeTag=${existingRuntimeTag}); rebuilding locally...` : `[pushpals] WorkerPal sandbox image ${opts.dockerImage} is missing; building locally...`);
  const build = await runCommandWithEnvFn([
    dockerExecutable,
    "build",
    "-f",
    "apps/workerpals/Dockerfile.sandbox",
    "--label",
    `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`,
    "--label",
    WORKERPAL_SANDBOX_COMPONENT_LABEL,
    "-t",
    opts.dockerImage,
    "."
  ], sandbox.root, opts.env);
  if (!build.ok) {
    const detail = build.stderr || build.stdout || `docker build exited ${build.exitCode}`;
    return {
      ok: false,
      detail: `failed to build local WorkerPal sandbox image ${opts.dockerImage}: ${detail}`
    };
  }
  return {
    ok: true,
    detail: `built local WorkerPal sandbox image ${opts.dockerImage} for runtimeTag=${runtimeTag}`
  };
}
async function prepareEmbeddedWorkerpalDockerImageIfNeeded(opts) {
  if (!opts.preparedRuntime.preflightUsesEmbeddedRuntime) {
    return {
      status: "skipped",
      detail: "repo is using source-checkout runtime assets",
      runtimeTag: ""
    };
  }
  if (!opts.config.remotebuddy.autoSpawnWorkerpals || !opts.config.remotebuddy.workerpalDocker || !opts.config.remotebuddy.workerpalRequireDocker) {
    return {
      status: "skipped",
      detail: "embedded docker-backed WorkerPal auto-spawn is not required",
      runtimeTag: ""
    };
  }
  if (opts.dockerPrecheck.status === "failed") {
    return {
      status: "failed",
      detail: opts.dockerPrecheck.detail,
      runtimeTag: ""
    };
  }
  const runtimeTag = opts.preparedRuntime.runtimeTag || String(opts.runtimeTagHint ?? "").trim() || await (opts.resolveRuntimeReleaseTagFn ?? resolveRuntimeReleaseTag)(opts.runtimeTagHint);
  if (!runtimeTag) {
    return {
      status: "failed",
      detail: "embedded runtime tag is required to prepare the WorkerPal sandbox image",
      runtimeTag: ""
    };
  }
  const ensureResult = await (opts.ensureWorkerpalDockerImageReadyFn ?? ensureWorkerpalDockerImageReady)({
    runtimeRoot: opts.preparedRuntime.runtimeRoot,
    runtimeTag,
    dockerImage: opts.config.remotebuddy.workerpalImage ?? opts.config.workerpals.dockerImage,
    env: opts.dockerPrecheck.env
  });
  return ensureResult.ok ? { status: "ok", detail: ensureResult.detail, runtimeTag } : { status: "failed", detail: ensureResult.detail, runtimeTag };
}
async function precheckSourceControlManagerGitAvailability(opts) {
  const platform = opts.platform ?? process.platform;
  const env = buildEmbeddedRuntimeEnv(opts.baseEnv ?? process.env, {
    repoRoot: opts.repoRoot,
    runtimeRoot: opts.runtimeRoot,
    useRuntimeConfig: opts.preflightUsesEmbeddedRuntime,
    sessionId: opts.sessionId
  });
  const preconfiguredGitBinary = env.PUSHPALS_GIT_BIN_ABSOLUTE ?? env.PUSHPALS_GIT_BIN;
  if (preconfiguredGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(env, preconfiguredGitBinary, platform);
  }
  const remoteStatus = opts.gitRemoteCheckFn ? await opts.gitRemoteCheckFn(opts.repoRoot, opts.remote, env) : opts.repoHasRemoteFn ? await opts.repoHasRemoteFn(opts.repoRoot, opts.remote) ? { status: "ok", remote: opts.remote } : { status: "missing_remote", remote: opts.remote } : await checkGitRemoteConfigured(opts.repoRoot, opts.remote, env);
  if (remoteStatus.status === "missing_remote") {
    return {
      status: "skipped",
      detail: `git remote "${opts.remote}" is not configured`,
      env
    };
  }
  if (remoteStatus.status === "error") {
    return {
      status: "failed",
      detail: `git remote "${opts.remote}" could not be inspected: ${remoteStatus.detail}`,
      env
    };
  }
  const gitLookupCommand = typeof env.PUSHPALS_GIT_BIN === "string" && env.PUSHPALS_GIT_BIN.trim() ? env.PUSHPALS_GIT_BIN.trim() : platform === "win32" ? "git.exe" : "git";
  const resolvedGitBinary = await (opts.resolveCommandPathFn ?? resolveCommandPath)(gitLookupCommand, opts.repoRoot, env);
  if (resolvedGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(env, resolvedGitBinary, platform);
  }
  const gitProbe = await (opts.gitProbeFn ?? resolveSourceControlManagerGitProbe)(opts.repoRoot, env, platform);
  if (!gitProbe.ok) {
    return {
      status: "failed",
      detail: gitProbe.detail,
      env
    };
  }
  return {
    status: "ok",
    detail: gitProbe.detail,
    env
  };
}
async function precheckWorkerpalDockerAvailability(opts) {
  const env = buildEmbeddedRuntimeEnv(opts.baseEnv ?? process.env, {
    repoRoot: opts.repoRoot,
    runtimeRoot: opts.runtimeRoot,
    useRuntimeConfig: opts.preflightUsesEmbeddedRuntime,
    sessionId: opts.sessionId
  });
  const preconfiguredDockerBinary = env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? env.PUSHPALS_DOCKER_BIN;
  if (preconfiguredDockerBinary) {
    applyResolvedDockerBinaryToRuntimeEnv(env, preconfiguredDockerBinary, opts.platform ?? process.platform);
  }
  if (!opts.autoSpawnWorkerpals) {
    return {
      status: "skipped",
      detail: "WorkerPal auto-spawn is disabled",
      env
    };
  }
  if (!opts.dockerEnabled) {
    return {
      status: "skipped",
      detail: "WorkerPal docker mode is disabled",
      env
    };
  }
  if (!opts.requireDocker) {
    return {
      status: "skipped",
      detail: "WorkerPal docker mode is optional",
      env
    };
  }
  const dockerProbe = await (opts.dockerProbeFn ?? resolveWorkerpalDockerProbe)(opts.repoRoot, env, opts.platform ?? process.platform);
  if (!dockerProbe.ok) {
    return {
      status: "failed",
      detail: dockerProbe.detail,
      env
    };
  }
  return {
    status: "ok",
    detail: dockerProbe.detail,
    env
  };
}
function resolveWorkerpalCapacityTimeoutMs(config) {
  return Math.max(config.remotebuddy.waitForWorkerpalMs, config.remotebuddy.workerpalStartupTimeoutMs, config.remotebuddy.workerpalDocker ? config.workerpals.dockerAgentStartupTimeoutMs + 15000 : 0, 1e4);
}
async function checkGitRemoteConfigured(repoRoot, remote, env) {
  const normalizedRemote = String(remote ?? "").trim();
  if (!normalizedRemote) {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  const result = await runGitWithEnv(["remote", "get-url", normalizedRemote], repoRoot, env ?? {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  });
  if (result.ok && result.stdout) {
    return { status: "ok", remote: normalizedRemote };
  }
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  if (/no such remote/i.test(detail)) {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  return { status: "error", remote: normalizedRemote, detail };
}
async function checkPushpalsBranchOnRemote(repoRoot, remote, branch) {
  const normalizedRemote = String(remote ?? "").trim();
  const normalizedBranch = String(branch ?? "").trim();
  if (!normalizedRemote || !normalizedBranch) {
    return { status: "ok" };
  }
  const remoteStatus = await checkGitRemoteConfigured(repoRoot, normalizedRemote);
  if (remoteStatus.status === "missing_remote") {
    return { status: "missing_remote", remote: normalizedRemote };
  }
  if (remoteStatus.status === "error") {
    return {
      status: "error",
      remote: normalizedRemote,
      branch: normalizedBranch,
      detail: remoteStatus.detail
    };
  }
  const ref = `refs/heads/${normalizedBranch}`;
  const result = await runGit(["ls-remote", "--heads", normalizedRemote, ref], repoRoot);
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    return {
      status: "error",
      remote: normalizedRemote,
      branch: normalizedBranch,
      detail
    };
  }
  if (!result.stdout.trim()) {
    return {
      status: "missing_branch",
      remote: normalizedRemote,
      branch: normalizedBranch
    };
  }
  return { status: "ok" };
}
async function enforcePushpalsRemoteBranchPrecheck(repoRoot, remote, branch) {
  const result = await checkPushpalsBranchOnRemote(repoRoot, remote, branch);
  if (result.status === "ok")
    return true;
  if (result.status === "missing_remote") {
    console.warn(`[pushpals] Precheck: git remote "${result.remote}" is not configured in this repo; cannot verify pushpals branch.`);
    return true;
  }
  if (result.status === "missing_branch") {
    console.error(`[pushpals] Precheck failed: remote branch "${result.remote}/${result.branch}" was not found.`);
    console.error("[pushpals] Precheck failed: create/push that branch first or set source_control_manager.pushpals_branch to an existing remote branch.");
    return false;
  }
  console.error(`[pushpals] Precheck failed: could not verify remote branch "${result.remote}/${result.branch}": ${result.detail}`);
  return false;
}
function isPathEqualOrWithin(parentPath, childPath) {
  const parent = normalizeRepoPathForComparison(parentPath);
  const child = normalizeRepoPathForComparison(childPath);
  return child === parent || child.startsWith(`${parent}/`);
}
function appendCliClearTarget(targets, label, pathValue) {
  const resolvedPath = String(pathValue ?? "").trim();
  if (!resolvedPath)
    return;
  const normalized = normalizeRepoPathForComparison(resolvedPath);
  if (targets.some((target) => normalizeRepoPathForComparison(target.path) === normalized))
    return;
  targets.push({ label, path: resolve4(resolvedPath) });
}
function buildCliClearTargets(opts) {
  const targets = [];
  const dataDir = resolve4(opts.config.paths.dataDir);
  appendCliClearTarget(targets, "runtime data", dataDir);
  const scmStateDir = resolve4(opts.config.sourceControlManager.stateDir);
  if (!isPathEqualOrWithin(dataDir, scmStateDir)) {
    appendCliClearTarget(targets, "SourceControlManager state", scmStateDir);
  }
  const scmRepoPath = resolve4(opts.config.sourceControlManager.repoPath);
  if (normalizeRepoPathForComparison(scmRepoPath) !== normalizeRepoPathForComparison(opts.repoRoot) && isPathEqualOrWithin(opts.repoRoot, scmRepoPath)) {
    appendCliClearTarget(targets, "SourceControlManager worktree", scmRepoPath);
  }
  appendCliClearTarget(targets, "CLI state file", opts.cliStatePath ?? null);
  appendCliClearTarget(targets, "client monitor state file", resolveGitStateFilePath(opts.repoRoot, "pushpals-client-state.json"));
  appendCliClearTarget(targets, "runtime bootstrap logs", join2(opts.runtimeRoot, "logs", "bootstrap"));
  return targets;
}
function removeCliClearTarget(target) {
  if (!existsSync4(target.path))
    return "missing";
  try {
    rmSync(target.path, { recursive: true, force: true });
    return "removed";
  } catch (err) {
    return {
      ...target,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}
async function requestLocalRuntimeShutdownForClear(serverUrl, repoRoot) {
  if (!await probeServer(serverUrl)) {
    return { attempted: false, accepted: false };
  }
  try {
    await ensureServerRepoAffinity(serverUrl, repoRoot);
  } catch (err) {
    return {
      attempted: false,
      accepted: false,
      detail: `skipping shutdown because ${String(err)}`
    };
  }
  try {
    const response = await fetchWithTimeout(`${serverUrl}/admin/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "pushpals --clear" })
    }, 5000);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        attempted: true,
        accepted: false,
        detail: `HTTP ${response.status}${detail ? ` ${detail}` : ""}`
      };
    }
    return { attempted: true, accepted: true };
  } catch (err) {
    return {
      attempted: true,
      accepted: false,
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}
async function clearPushpalsState(opts) {
  console.log("[pushpals] Clear requested. Removing repo-local PushPals state.");
  const shutdown = await requestLocalRuntimeShutdownForClear(opts.serverUrl, opts.repoRoot);
  if (shutdown.attempted && shutdown.accepted) {
    console.log("[pushpals] Local runtime shutdown accepted; waiting for services to exit...");
    await Bun.sleep(1500);
  } else if (shutdown.attempted) {
    console.warn(`[pushpals] Local runtime shutdown request was not accepted${shutdown.detail ? `: ${shutdown.detail}` : "."}`);
  } else if (shutdown.detail) {
    console.warn(`[pushpals] ${shutdown.detail}`);
  }
  const targets = buildCliClearTargets({
    repoRoot: opts.repoRoot,
    runtimeRoot: opts.runtimeRoot,
    config: opts.config,
    cliStatePath: opts.cliStatePath
  });
  const removed = [];
  const missing = [];
  let failed = [];
  for (const target of targets) {
    const result = removeCliClearTarget(target);
    if (result === "removed") {
      removed.push(target);
      continue;
    }
    if (result === "missing") {
      missing.push(target);
      continue;
    }
    failed.push(result);
  }
  if (failed.length > 0 && shutdown.accepted) {
    await Bun.sleep(1000);
    const retryFailures = [];
    for (const failure of failed) {
      const retry = removeCliClearTarget(failure);
      if (retry === "removed") {
        removed.push({ label: failure.label, path: failure.path });
        continue;
      }
      if (retry === "missing") {
        missing.push({ label: failure.label, path: failure.path });
        continue;
      }
      retryFailures.push(retry);
    }
    failed = retryFailures;
  }
  for (const target of removed) {
    console.log(`[pushpals] Cleared ${target.label}: ${target.path}`);
  }
  for (const target of missing) {
    console.log(`[pushpals] Nothing to clear for ${target.label}: ${target.path}`);
  }
  for (const failure of failed) {
    console.error(`[pushpals] Failed to clear ${failure.label}: ${failure.path} (${failure.detail})`);
  }
  if (failed.length > 0) {
    console.error("[pushpals] Clear completed with errors.");
    return 1;
  }
  console.log("[pushpals] Clear completed.");
  return 0;
}
async function probeServer(serverUrl) {
  try {
    const response = await fetchWithTimeout(`${serverUrl}/healthz`, {}, HTTP_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}
function normalizeRepoPathForComparison(repoPath) {
  const normalized = resolve4(String(repoPath ?? "")).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
async function fetchServerRepoRoot(serverUrl) {
  const response = await fetchWithTimeout(`${serverUrl}/system/status`, {}, 1e4);
  if (!response.ok) {
    throw new Error(`status probe failed with HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => ({}));
  const repoRoot = payload?.repo && typeof payload.repo.root === "string" ? payload.repo.root.trim() : "";
  if (!repoRoot) {
    throw new Error("server did not report repo.root in /system/status");
  }
  return repoRoot;
}
async function ensureServerRepoAffinity(serverUrl, currentRepoRoot) {
  const serverRepoRoot = await fetchServerRepoRoot(serverUrl);
  if (normalizeRepoPathForComparison(serverRepoRoot) === normalizeRepoPathForComparison(currentRepoRoot)) {
    return;
  }
  throw new Error(`repo mismatch: currentRepo=${currentRepoRoot} serverRepo=${serverRepoRoot}. Stop the existing runtime or switch to the matching repo.`);
}
function isRemoteBuddyClientRow(row) {
  const clientId = normalizePresenceLookupToken(row.clientId);
  const label = normalizePresenceLookupToken(row.label);
  return clientId.includes("remotebuddy") || label.includes("remotebuddy");
}
function extractRemoteBuddySessionConsumerHealth(statusPayload, sessionId) {
  const rows = Array.isArray(statusPayload?.clients?.items) ? statusPayload.clients?.items ?? [] : [];
  const sessionRows = rows.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      return false;
    return String(row.sessionId ?? "").trim() === sessionId;
  });
  const remotebuddyRows = sessionRows.filter(isRemoteBuddyClientRow);
  const connectedRow = remotebuddyRows.find((row) => String(row.status ?? "").trim().toLowerCase() === "connected");
  if (connectedRow) {
    return {
      ok: true,
      detail: `RemoteBuddy session consumer connected (${String(connectedRow.clientId ?? "").trim()})`,
      clientId: String(connectedRow.clientId ?? "").trim() || undefined,
      sessionId
    };
  }
  const anyRemoteBuddyRows = rows.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      return false;
    return isRemoteBuddyClientRow(row);
  });
  const connectedOtherSession = anyRemoteBuddyRows.find((row) => {
    const rowSessionId = String(row.sessionId ?? "").trim();
    if (!rowSessionId || rowSessionId === sessionId)
      return false;
    return String(row.status ?? "").trim().toLowerCase() === "connected";
  });
  if (connectedOtherSession) {
    const otherSessionId = String(connectedOtherSession.sessionId ?? "").trim();
    const otherClientId = String(connectedOtherSession.clientId ?? "").trim();
    return {
      ok: false,
      detail: `RemoteBuddy is connected to session ${otherSessionId || "unknown"} ` + `(${otherClientId || "unknown client"}), not ${sessionId}`,
      clientId: otherClientId || undefined,
      sessionId: otherSessionId || undefined
    };
  }
  if (remotebuddyRows.length > 0) {
    return {
      ok: false,
      detail: `RemoteBuddy session consumer exists for ${sessionId} but is not connected`,
      clientId: String(remotebuddyRows[0]?.clientId ?? "").trim() || undefined,
      sessionId
    };
  }
  if (anyRemoteBuddyRows.length > 0) {
    const knownSessions = [...new Set(anyRemoteBuddyRows.map((row) => String(row.sessionId ?? "").trim()))].filter(Boolean).sort();
    const suffix = knownSessions.length > 0 ? ` Known RemoteBuddy sessions: ${knownSessions.join(", ")}.` : "";
    return {
      ok: false,
      detail: `No connected RemoteBuddy session consumer found for session ${sessionId}.${suffix}`.trim()
    };
  }
  return {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${sessionId}`
  };
}
async function probeRemoteBuddySessionConsumer(serverUrl, sessionId) {
  try {
    const response = await fetchWithTimeout(`${serverUrl}/system/status`, {}, 1e4);
    if (!response.ok) {
      return {
        ok: false,
        detail: `system status probe failed with HTTP ${response.status}`
      };
    }
    const payload = await response.json().catch(() => ({}));
    return extractRemoteBuddySessionConsumerHealth(payload, sessionId);
  } catch (err) {
    return {
      ok: false,
      detail: `system status probe failed: ${String(err)}`
    };
  }
}
async function probeSourceControlManager(port) {
  if (!Number.isFinite(port) || port <= 0)
    return false;
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${Math.floor(port)}/health`, {}, HTTP_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}
async function fetchWorkerStatusRows(serverUrl, ttlMs) {
  const payload = await fetchJsonWithTimeout(`${serverUrl}/workers?ttlMs=${Math.max(1000, Math.floor(ttlMs))}`, {}, 1e4);
  if (!payload?.ok || !Array.isArray(payload.workers)) {
    return [];
  }
  return payload.workers;
}
async function waitForWorkerpalCapacity(opts) {
  const deadline = Date.now() + Math.max(1000, opts.timeoutMs);
  let lastObservedOnline = 0;
  while (Date.now() < deadline) {
    const workers = await (opts.fetchWorkersFn ?? fetchWorkerStatusRows)(opts.serverUrl, opts.ttlMs);
    const onlineWorkers = workers.filter((worker) => Boolean(worker?.isOnline) && String(worker?.status ?? "").trim().toLowerCase() !== "offline");
    const idleWorkers = onlineWorkers.filter((worker) => Number(worker?.activeJobCount ?? 0) <= 0);
    if (onlineWorkers.length > 0) {
      lastObservedOnline = Math.max(lastObservedOnline, onlineWorkers.length);
    }
    if (idleWorkers.length > 0) {
      return {
        ok: true,
        detail: `${idleWorkers.length} idle / ${onlineWorkers.length} online`
      };
    }
    await (opts.sleepFn ?? Bun.sleep)(DEFAULT_RUNTIME_BOOT_POLL_MS);
  }
  if (lastObservedOnline > 0) {
    return {
      ok: false,
      detail: `${lastObservedOnline} online WorkerPal(s) reported but none became idle within ${Math.max(1000, opts.timeoutMs)}ms`
    };
  }
  return {
    ok: false,
    detail: `no online WorkerPal reported within ${Math.max(1000, opts.timeoutMs)}ms`
  };
}
async function fetchWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJsonWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  try {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    if (!response.ok)
      return null;
    return await response.json();
  } catch {
    return null;
  }
}
function buildClientTransportQuery(cursor, client) {
  const params = new URLSearchParams;
  if (cursor > 0)
    params.set("after", String(cursor));
  params.set("clientId", client.clientId);
  params.set("clientKind", client.kind);
  params.set("clientLabel", client.label);
  params.set("clientVersion", client.version);
  params.set("clientPlatform", client.platform);
  params.set("clientRepoRoot", client.repoRoot);
  const query = params.toString();
  return query ? `?${query}` : "";
}
function createRuntimeClientId(prefix) {
  if (typeof crypto?.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
async function probeLocalBuddy(localAgentUrl) {
  return await fetchJsonWithTimeout(`${localAgentUrl}/healthz`, {}, LOCALBUDDY_TIMEOUT_MS);
}
function resolveCliLocalBuddyAutostart(runtimeOnly, runtimeConfigEnabled) {
  return runtimeOnly ? runtimeConfigEnabled : false;
}
async function ensureServerSession(serverUrl, requestedSessionId, client) {
  const response = await fetchWithTimeout(`${serverUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: requestedSessionId,
      client: {
        clientId: client.clientId,
        kind: client.kind,
        label: client.label,
        version: client.version,
        platform: client.platform,
        repoRoot: client.repoRoot
      }
    })
  }, 15000);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to create or join session ${requestedSessionId}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const payload = await response.json().catch(() => ({}));
  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("Server session bootstrap returned no sessionId.");
  }
  return sessionId;
}
async function autoStartRuntimeServices(opts) {
  const { runtimePreflight } = opts.preparedRuntime;
  const runtimeRoot = opts.preparedRuntime.runtimeRoot;
  const runtimeTag = opts.preparedRuntime.runtimeTag || await resolveRuntimeReleaseTag(opts.requestedRuntimeTag);
  const startLocalBuddy = opts.startLocalBuddy ?? Boolean(runtimePreflight.config.localbuddy.enabled);
  const localBuddyEnabled = startLocalBuddy;
  console.log(`[pushpals] Runtime unavailable. Auto-starting runtime for repo: ${opts.repoRoot}`);
  console.log(`[pushpals] runtimeRoot=${runtimeRoot}`);
  console.log(`[pushpals] runtimeTag=${runtimeTag}`);
  if (!runtimePreflight.ok) {
    throw new Error("Embedded runtime preflight failed.");
  }
  await ensureRuntimeAssets(runtimeRoot, runtimeTag);
  const runtimeBinaries = await ensureRuntimeBinaries(runtimeRoot, runtimeTag);
  const runtimeEnv = buildEmbeddedRuntimeEnv(opts.baseEnv ?? process.env, {
    repoRoot: opts.repoRoot,
    runtimeRoot,
    useRuntimeConfig: opts.preparedRuntime.preflightUsesEmbeddedRuntime,
    sessionId: opts.sessionId,
    runtimeTag
  });
  runtimeEnv.PUSHPALS_WORKERPALS_BIN = runtimeBinaries.workerpals;
  const preconfiguredRuntimeGitBinary = runtimeEnv.PUSHPALS_GIT_BIN_ABSOLUTE ?? runtimeEnv.PUSHPALS_GIT_BIN;
  if (preconfiguredRuntimeGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, preconfiguredRuntimeGitBinary);
  }
  const preconfiguredRuntimeDockerBinary = runtimeEnv.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? runtimeEnv.PUSHPALS_DOCKER_BIN;
  if (preconfiguredRuntimeDockerBinary) {
    applyResolvedDockerBinaryToRuntimeEnv(runtimeEnv, preconfiguredRuntimeDockerBinary);
  }
  const gitLookupCommand = typeof runtimeEnv.PUSHPALS_GIT_BIN === "string" && runtimeEnv.PUSHPALS_GIT_BIN.trim() ? runtimeEnv.PUSHPALS_GIT_BIN.trim() : "git";
  const resolvedGitBinary = await resolveCommandPath(gitLookupCommand, opts.repoRoot, runtimeEnv);
  if (resolvedGitBinary) {
    applyResolvedGitBinaryToRuntimeEnv(runtimeEnv, resolvedGitBinary);
  }
  const services = [];
  const runToken = timestampFileToken();
  const logDir = join2(runtimeRoot, "logs", "bootstrap");
  mkdirSync(logDir, { recursive: true });
  const serviceLogPaths = buildRuntimeServiceLogPaths(logDir, runToken);
  const runtimeServicesLogPath = join2(logDir, `${runToken}-runtime-services.log`);
  writeFileSync(runtimeServicesLogPath, "", "utf8");
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeRoot=${runtimeRoot}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] runtimeTag=${runtimeTag}`);
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] repoRoot=${opts.repoRoot}`);
  console.log(`[pushpals] pushpals log: ${runtimeServicesLogPath}`);
  console.log(`[pushpals] runtime services log: ${runtimeServicesLogPath}`);
  console.log(`[pushpals] service log (server)=${serviceLogPaths.server}`);
  console.log(`[pushpals] service log (localbuddy)=${serviceLogPaths.localbuddy}`);
  console.log(`[pushpals] service log (remotebuddy)=${serviceLogPaths.remotebuddy}`);
  console.log(`[pushpals] service log (source_control_manager)=${serviceLogPaths.source_control_manager}`);
  const serverHealthy = await probeServer(opts.serverUrl);
  if (!serverHealthy) {
    console.log("[pushpals] Starting embedded server...");
    const serverService = spawnRuntimeService("server", [runtimeBinaries.server], opts.repoRoot, runtimeEnv, serviceLogPaths.server, runtimeServicesLogPath);
    services.push(serverService);
    console.log(`[pushpals] server log: ${serverService.logPath}`);
    const serverDeadline = Date.now() + DEFAULT_SERVER_BOOT_TIMEOUT_MS;
    let serverIsReady = false;
    while (Date.now() < serverDeadline) {
      if (serverService.exited) {
        const tail = readLogTail(serverService.logPath);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}).`);
        stopRuntimeServices(services);
        throw new Error(`Embedded server exited during bootstrap (code=${serverService.exitCode ?? "unknown"}). ` + `See ${serverService.logPath}${tail ? `
--- server log tail ---
${tail}` : ""}`);
      }
      if (await probeServer(opts.serverUrl)) {
        serverIsReady = true;
        break;
      }
      await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
    }
    if (!serverIsReady) {
      const tail = readLogTail(serverService.logPath);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms.`);
      stopRuntimeServices(services);
      throw new Error(`Embedded server did not become healthy within ${DEFAULT_SERVER_BOOT_TIMEOUT_MS}ms. ` + `See ${serverService.logPath}${tail ? `
--- server log tail ---
${tail}` : ""}`);
    }
    console.log("[pushpals] Embedded server is healthy.");
  } else {
    console.log("[pushpals] Server already healthy; skipping embedded server start.");
    appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] server already healthy; embedded server start skipped.");
  }
  if (localBuddyEnabled) {
    console.log("[pushpals] Starting embedded LocalBuddy...");
    const localbuddyService = spawnRuntimeService("localbuddy", [runtimeBinaries.localbuddy], opts.repoRoot, runtimeEnv, serviceLogPaths.localbuddy, runtimeServicesLogPath);
    services.push(localbuddyService);
    console.log(`[pushpals] localbuddy log: ${localbuddyService.logPath}`);
  } else {
    console.log("[pushpals] Embedded LocalBuddy disabled for this CLI session; skipping start.");
    appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] localbuddy disabled for this CLI session; embedded localbuddy start skipped.");
  }
  console.log("[pushpals] Starting embedded RemoteBuddy...");
  const remotebuddyService = spawnRuntimeService("remotebuddy", [runtimeBinaries.remotebuddy], opts.repoRoot, runtimeEnv, serviceLogPaths.remotebuddy, runtimeServicesLogPath);
  services.push(remotebuddyService);
  console.log(`[pushpals] remotebuddy log: ${remotebuddyService.logPath}`);
  let lastReportedRemoteBuddyAutonomyState = "unknown";
  const reportRemoteBuddyAutonomousEngineState = () => {
    const autonomyState = readRemoteBuddyAutonomousEngineState(remotebuddyService.logPath);
    if (autonomyState === "unknown" || autonomyState === lastReportedRemoteBuddyAutonomyState) {
      return;
    }
    lastReportedRemoteBuddyAutonomyState = autonomyState;
    if (autonomyState === "enabled") {
      console.log("[pushpals] Embedded RemoteBuddy autonomous engine is enabled.");
      appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] embedded remotebuddy autonomous engine is enabled.");
      return;
    }
    console.warn("[pushpals] Embedded RemoteBuddy autonomous engine is disabled (remotebuddy.autonomy.enabled=false).");
    appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] embedded remotebuddy autonomous engine is disabled (remotebuddy.autonomy.enabled=false).");
  };
  reportRemoteBuddyAutonomousEngineState();
  if (runtimePreflight.config.remotebuddy.autoSpawnWorkerpals) {
    const workerpalReadyTimeoutMs = resolveWorkerpalCapacityTimeoutMs(runtimePreflight.config);
    const workerpalCapacity = await waitForWorkerpalCapacity({
      serverUrl: opts.serverUrl,
      timeoutMs: workerpalReadyTimeoutMs,
      ttlMs: runtimePreflight.config.remotebuddy.workerpalOnlineTtlMs
    });
    if (!workerpalCapacity.ok) {
      const tail = readLogTail(remotebuddyService.logPath);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded workerpal capacity did not become available within ${workerpalReadyTimeoutMs}ms.`);
      stopRuntimeServices(services);
      throw new Error(`Embedded WorkerPal capacity did not become available within ${workerpalReadyTimeoutMs}ms (${workerpalCapacity.detail}). ` + `See ${remotebuddyService.logPath}${tail ? `
--- remotebuddy log tail ---
${tail}` : ""}`);
    }
    console.log(`[pushpals] Embedded WorkerPal capacity is ready (${workerpalCapacity.detail}).`);
    appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded workerpal capacity ready (${workerpalCapacity.detail}).`);
  }
  const scmHealthy = await probeSourceControlManager(opts.sourceControlManagerPort);
  const scmGitProbe = await resolveSourceControlManagerGitProbe(opts.repoRoot, runtimeEnv, process.platform);
  const scmRemoteStatus = await checkGitRemoteConfigured(opts.repoRoot, opts.sourceControlManagerRemote, runtimeEnv);
  if (!scmHealthy) {
    if (!scmGitProbe.ok) {
      console.warn("[pushpals] Git is not available to embedded SourceControlManager; skipping SCM startup.");
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] source_control_manager skipped: git is unavailable in embedded runtime env (${scmGitProbe.detail}).`);
    } else if (scmRemoteStatus.status === "error") {
      console.warn(`[pushpals] Could not inspect SourceControlManager git remote "${opts.sourceControlManagerRemote}"; skipping SCM startup.`);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] source_control_manager skipped: remote "${opts.sourceControlManagerRemote}" could not be inspected (${scmRemoteStatus.detail}).`);
    } else if (scmRemoteStatus.status === "ok") {
      console.log(`[pushpals] Embedded SourceControlManager git=${scmGitProbe.detail}`);
      console.log("[pushpals] Starting embedded SourceControlManager...");
      const sourceControlManagerService = spawnRuntimeService("source_control_manager", [runtimeBinaries.sourceControlManager, "--skip-clean-check"], opts.repoRoot, runtimeEnv, serviceLogPaths.source_control_manager, runtimeServicesLogPath);
      services.push(sourceControlManagerService);
      console.log(`[pushpals] source_control_manager log: ${sourceControlManagerService.logPath}`);
    } else {
      console.log(`[pushpals] Repo has no git remote "${opts.sourceControlManagerRemote}"; skipping embedded SourceControlManager.`);
      appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] source_control_manager skipped: repo has no remote "${opts.sourceControlManagerRemote}".`);
    }
  } else {
    console.log("[pushpals] SourceControlManager already healthy; skipping embedded start.");
    appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] source_control_manager already healthy; embedded start skipped.");
  }
  const deadline = Date.now() + DEFAULT_RUNTIME_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    reportRemoteBuddyAutonomousEngineState();
    for (let i = services.length - 1;i >= 0; i--) {
      const service = services[i];
      if (service.exited) {
        if (isOptionalEmbeddedService(service.name)) {
          console.warn(`[pushpals] Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); continuing without SCM.`);
          appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}); continuing.`);
          const tail2 = readLogTail(service.logPath);
          if (tail2) {
            console.warn(`[pushpals] ${service.name} log tail:
${tail2}`);
            appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] ${service.name} log tail:
${tail2}`);
          }
          services.splice(i, 1);
          continue;
        }
        const tail = readLogTail(service.logPath);
        appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}).`);
        stopRuntimeServices(services);
        throw new Error(`Embedded ${service.name} exited during startup (code=${service.exitCode ?? "unknown"}). ` + `See ${service.logPath}${tail ? `
--- ${service.name} log tail ---
${tail}` : ""}`);
      }
    }
    const health = localBuddyEnabled ? await probeLocalBuddy(opts.localAgentUrl) : null;
    const remoteBuddyHealth2 = await probeRemoteBuddySessionConsumer(opts.serverUrl, opts.sessionId);
    if ((!localBuddyEnabled || health?.ok) && remoteBuddyHealth2.ok) {
      reportRemoteBuddyAutonomousEngineState();
      const stabilityDeadline = Date.now() + DEFAULT_SERVICE_STABILITY_GRACE_MS;
      while (Date.now() < stabilityDeadline) {
        reportRemoteBuddyAutonomousEngineState();
        for (let i = services.length - 1;i >= 0; i--) {
          const service = services[i];
          if (!service.exited)
            continue;
          if (isOptionalEmbeddedService(service.name)) {
            const tail2 = readLogTail(service.logPath);
            console.warn(`[pushpals] Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); continuing without SCM.`);
            appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}); continuing.`);
            if (tail2) {
              console.warn(`[pushpals] ${service.name} log tail:
${tail2}`);
              appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] ${service.name} log tail:
${tail2}`);
            }
            services.splice(i, 1);
            continue;
          }
          const tail = readLogTail(service.logPath);
          appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}).`);
          stopRuntimeServices(services);
          throw new Error(`Embedded ${service.name} exited immediately after bootstrap (code=${service.exitCode ?? "unknown"}). ` + `See ${service.logPath}${tail ? `
--- ${service.name} log tail ---
${tail}` : ""}`);
        }
        await Bun.sleep(250);
      }
      console.log("[pushpals] Embedded runtime is ready.");
      appendRuntimeServicesLogLine(runtimeServicesLogPath, "[pushpals] embedded runtime is ready.");
      return {
        services,
        pushpalsLogPath: runtimeServicesLogPath
      };
    }
    await Bun.sleep(DEFAULT_RUNTIME_BOOT_POLL_MS);
  }
  stopRuntimeServices(services);
  const remoteBuddyHealth = await probeRemoteBuddySessionConsumer(opts.serverUrl, opts.sessionId);
  if (!localBuddyEnabled && !remoteBuddyHealth.ok) {
    appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail}).`);
    throw new Error(`Timed out waiting for RemoteBuddy session consumer readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms (${remoteBuddyHealth.detail})`);
  }
  if (!localBuddyEnabled) {
    appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`);
    throw new Error(`Timed out waiting for embedded runtime readiness after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms`);
  }
  appendRuntimeServicesLogLine(runtimeServicesLogPath, `[pushpals] timed out waiting for LocalBuddy at ${opts.localAgentUrl} and RemoteBuddy session consumer after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms.`);
  throw new Error(`Timed out waiting for LocalBuddy at ${opts.localAgentUrl} and RemoteBuddy session consumer after ${DEFAULT_RUNTIME_BOOT_TIMEOUT_MS}ms`);
}
function readCliState(pathValue) {
  if (!existsSync4(pathValue))
    return {};
  try {
    const raw = readFileSync4(pathValue, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return {};
    return {
      monitoringHubUrl: typeof parsed.monitoringHubUrl === "string" ? parsed.monitoringHubUrl : undefined,
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : undefined,
      localAgentUrl: typeof parsed.localAgentUrl === "string" ? parsed.localAgentUrl : undefined,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      repoRoot: typeof parsed.repoRoot === "string" ? parsed.repoRoot : undefined,
      pushpalsLogPath: typeof parsed.pushpalsLogPath === "string" ? parsed.pushpalsLogPath : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
    };
  } catch {
    return {};
  }
}
function writeCliState(pathValue, state) {
  const payload = {
    version: stateVersion,
    ...state,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, `${JSON.stringify(payload, null, 2)}
`, "utf8");
}
function resolveCliStatePath(repoRoot) {
  return resolveGitStateFilePath(repoRoot, "pushpals-cli-state.json");
}
async function looksLikeMonitoringHub(url) {
  try {
    const response = await fetchWithTimeout(url, {}, 700);
    if (!response.ok)
      return false;
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html"))
      return false;
    const text = await response.text();
    const sample = text.slice(0, 8192).toLowerCase();
    return sample.includes("pushpals") || sample.includes("mission control") || sample.includes("jobs & traces");
  } catch {
    return false;
  }
}
function buildMonitoringHubRuntimeBootstrap(opts) {
  return {
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId,
    clientId: `cli-monitor-${opts.sessionId}`,
    clientKind: "cli_monitor",
    clientLabel: "CLI Monitor"
  };
}
function injectMonitoringHubBootstrap(html, bootstrap) {
  const payload = jsonHtmlBootstrap(bootstrap);
  const script = `<script>globalThis.__PUSHPALS_WEB_BOOTSTRAP__=${payload};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return `${script}${html}`;
}
function monitoringHubContentType(pathValue) {
  switch (extname(pathValue).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
function resolveMonitoringHubAssetPath(assetRoot, pathname) {
  const root = resolve4(assetRoot);
  const rootPrefix = `${root}${root.endsWith("\\") || root.endsWith("/") ? "" : process.platform === "win32" ? "\\" : "/"}`;
  const decodedPath = decodeURIComponent(pathname);
  const trimmedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const relativePath = trimmedPath.replace(/^\/+/, "");
  const candidatePath = resolve4(root, relativePath);
  if (candidatePath !== root && !candidatePath.startsWith(rootPrefix))
    return null;
  if (existsSync4(candidatePath))
    return candidatePath;
  if (!extname(relativePath)) {
    const nestedIndexPath = resolve4(root, relativePath, "index.html");
    if ((nestedIndexPath === root || nestedIndexPath.startsWith(rootPrefix)) && existsSync4(nestedIndexPath)) {
      return nestedIndexPath;
    }
    return join2(root, "index.html");
  }
  return null;
}
async function serveBundledMonitoringHub(assetRoot, pathname, bootstrap) {
  const assetPath = resolveMonitoringHubAssetPath(assetRoot, pathname);
  if (!assetPath || !existsSync4(assetPath))
    return null;
  if (assetPath.endsWith("index.html")) {
    const html = injectMonitoringHubBootstrap(readFileSync4(assetPath, "utf8"), bootstrap);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
  return new Response(Bun.file(assetPath), {
    headers: {
      "content-type": monitoringHubContentType(assetPath),
      "cache-control": "no-store"
    }
  });
}
function buildEmbeddedMonitoringHubHtml(opts) {
  const bootstrap = jsonHtmlBootstrap({
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PushPals CLI Monitor</title>
  <style>
    :root { color-scheme: dark; --bg:#08111b; --panel:#112235; --panel2:#16324a; --line:#2b5876; --fg:#edf6ff; --muted:#90b5d6; --accent:#58d8c3; --warn:#ffbf5f; --bad:#ff7f7f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Consolas, "SFMono-Regular", monospace; background:radial-gradient(circle at top, #0d2233, var(--bg) 56%); color:var(--fg); }
    main { max-width:1200px; margin:0 auto; padding:24px; }
    h1,h2 { margin:0 0 12px; }
    p { color:var(--muted); }
    .row { display:grid; gap:16px; margin-top:16px; }
    .cards { grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }
    .panels { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
    .card, .panel { border:1px solid var(--line); background:linear-gradient(180deg,var(--panel),var(--panel2)); border-radius:16px; padding:16px; box-shadow:0 12px 40px rgba(0,0,0,.22); }
    .label { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:10px; }
    .value { font-size:32px; font-weight:700; color:var(--accent); }
    .sub { margin-top:8px; color:var(--muted); white-space:pre-wrap; word-break:break-word; }
    .list { display:grid; gap:10px; margin-top:12px; }
    .item { border:1px solid rgba(88,216,195,.18); border-radius:12px; padding:12px; background:rgba(8,17,27,.42); }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 0; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:6px 10px; color:var(--muted); }
    a { color:var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>PushPals CLI Monitor</h1>
    <p>Lightweight embedded monitor for CLI-managed runtimes.</p>
    <div class="meta" id="meta"></div>
    <section class="row cards" id="cards"></section>
    <section class="row panels">
      <div class="panel">
        <h2>Requests</h2>
        <div id="requests" class="list"></div>
      </div>
      <div class="panel">
        <h2>Jobs</h2>
        <div id="jobs" class="list"></div>
      </div>
      <div class="panel">
        <h2>Completions</h2>
        <div id="completions" class="list"></div>
      </div>
    </section>
  </main>
  <script>
    const boot = ${bootstrap};
    const pollMs = ${MONITOR_POLL_MS};
    const metaEl = document.getElementById("meta");
    const cardsEl = document.getElementById("cards");
    const requestsEl = document.getElementById("requests");
    const jobsEl = document.getElementById("jobs");
    const completionsEl = document.getElementById("completions");

    function esc(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    async function fetchJson(path) {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
      return await res.json();
    }

    function setList(target, rows, emptyLabel, formatter) {
      if (!Array.isArray(rows) || rows.length === 0) {
        target.innerHTML = '<div class="item">' + esc(emptyLabel) + "</div>";
        return;
      }
      target.innerHTML = rows.map((row) => '<div class="item">' + formatter(row) + "</div>").join("");
    }

    function renderStatus(status) {
      const workers = status?.workers ?? {};
      const queues = status?.queues ?? {};
      const runtime = status?.runtime ?? {};
      const repo = status?.repo ?? {};
      const llmUsage = status?.llmUsage ?? {};
      const cards = [
        { label: "Server uptime", value: Math.round((Number(runtime.uptimeMs ?? 0) / 60000)) + "m", sub: runtime.startedAt ?? "unknown" },
        { label: "Workers online", value: String(workers.online ?? 0), sub: "busy " + String(workers.busy ?? 0) + " | idle " + String(workers.idle ?? 0) },
        { label: "Pending requests", value: String(queues.requests?.pending ?? 0), sub: "claimed " + String(queues.requests?.claimed ?? 0) },
        { label: "Pending jobs", value: String(queues.jobs?.pending ?? 0), sub: "claimed " + String(queues.jobs?.claimed ?? 0) },
        { label: "Completions", value: String(queues.completions?.pending ?? 0), sub: "processed " + String(queues.completions?.processed ?? 0) },
        { label: "LLM usage (24h)", value: String(llmUsage.totalTokens ?? 0), sub: "calls " + String(llmUsage.totalCalls ?? 0) }
      ];
      cardsEl.innerHTML = cards.map((card) => '<div class="card"><div class="label">' + esc(card.label) + '</div><div class="value">' + esc(card.value) + '</div><div class="sub">' + esc(card.sub) + '</div></div>').join("");
      metaEl.innerHTML = [
        '<span class="pill">server ' + esc(boot.serverUrl) + '</span>',
        '<span class="pill">session ' + esc(boot.sessionId) + '</span>',
        '<span class="pill">repo ' + esc(repo?.root ?? repo?.remoteUrl ?? "current repo") + '</span>'
      ].join("");
    }

    function render() {
      Promise.all([
        fetchJson('/api/status'),
        fetchJson('/api/requests'),
        fetchJson('/api/jobs'),
        fetchJson('/api/completions')
      ]).then(([status, requests, jobs, completions]) => {
        renderStatus(status);
        setList(requestsEl, requests?.requests?.slice(0, 8), 'No requests', (row) =>
          '<strong>' + esc(row?.priority ?? 'request') + '</strong><div class="sub">' +
          esc((row?.status ?? 'unknown') + ' | ' + (row?.id ?? '')) + '</div><div class="sub">' +
          esc(String(row?.prompt ?? '').slice(0, 220)) + '</div>');
        setList(jobsEl, jobs?.jobs?.slice(0, 8), 'No jobs', (row) =>
          '<strong>' + esc(row?.kind ?? 'job') + '</strong><div class="sub">' +
          esc((row?.status ?? 'unknown') + ' | worker ' + (row?.workerId ?? '--')) + '</div><div class="sub">' +
          esc((row?.summary ?? row?.error ?? row?.id ?? '').slice(0, 220)) + '</div>');
        setList(completionsEl, completions?.completions?.slice(0, 8), 'No completions', (row) =>
          '<strong>' + esc(row?.status ?? 'completion') + '</strong><div class="sub">' +
          esc((row?.jobId ?? '') + ' | ' + (row?.commitSha ?? '')) + '</div><div class="sub">' +
          esc((row?.message ?? '').slice(0, 220)) + '</div>');
      }).catch((err) => {
        cardsEl.innerHTML = '<div class="card"><div class="label">Monitor error</div><div class="sub">' + esc(err?.message ?? err) + '</div></div>';
      });
    }

    render();
    setInterval(render, pollMs);
  </script>
</body>
</html>`;
}
async function proxyMonitoringHubRequest(serverUrl, pathValue) {
  const target = `${serverUrl}${pathValue}`;
  const upstream = await fetchWithTimeout(target, {}, 1e4);
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": String(upstream.headers.get("content-type") ?? "application/json"),
      "cache-control": "no-store"
    }
  });
}
async function startEmbeddedMonitoringHub(opts) {
  const monitoringHubAssetRoot = opts.assetRoot === undefined ? await ensureBundledMonitoringHubRoot() : opts.assetRoot;
  if (!monitoringHubAssetRoot || !looksLikeMonitoringHubBuild(monitoringHubAssetRoot)) {
    console.error("[pushpals] Unified monitoring hub assets are unavailable; build or export the packaged client monitor first.");
    return null;
  }
  const bootstrap = buildMonitoringHubRuntimeBootstrap({
    serverUrl: opts.serverUrl,
    sessionId: opts.sessionId
  });
  const candidatePorts = Array.from({ length: MONITOR_SCAN_PORTS }, (_, index) => opts.preferredPort + index).concat(0);
  for (const port of candidatePorts) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        idleTimeout: 30,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({
              ok: true,
              port,
              serverUrl: opts.serverUrl,
              sessionId: opts.sessionId
            });
          }
          if (url.pathname === "/api/status") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/system/status");
          }
          if (url.pathname === "/api/requests") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/requests?status=all&limit=20");
          }
          if (url.pathname === "/api/jobs") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/jobs?status=all&limit=20");
          }
          if (url.pathname === "/api/completions") {
            return await proxyMonitoringHubRequest(opts.serverUrl, "/completions?status=all&limit=20");
          }
          const bundledResponse = await serveBundledMonitoringHub(monitoringHubAssetRoot, url.pathname, bootstrap);
          if (bundledResponse)
            return bundledResponse;
          return new Response("Not found", { status: 404 });
        }
      });
      return {
        url: `http://127.0.0.1:${server.port}`,
        port: Number(server.port),
        embedded: true,
        stop: () => server.stop(true)
      };
    } catch {}
  }
  return null;
}
async function resolveMonitoringHub(opts) {
  const explicit = normalizeUrl(opts.preferredUrl);
  if (explicit) {
    if (!isLoopbackUrl(explicit)) {
      console.warn(`[pushpals] Preferred monitoring hub ${explicit} is not local; ignoring it and starting a local monitor instead.`);
    } else if (await looksLikeMonitoringHub(explicit)) {
      return { url: explicit, port: 0, stop: () => {}, embedded: false };
    } else {
      console.warn(`[pushpals] Preferred monitoring hub ${explicit} is unavailable; starting embedded monitor instead.`);
    }
  }
  for (let port = opts.fallbackPort;port < opts.fallbackPort + MONITOR_SCAN_PORTS; port++) {
    const candidate = `http://127.0.0.1:${port}`;
    if (await looksLikeMonitoringHub(candidate)) {
      return { url: candidate, port, stop: () => {}, embedded: false };
    }
  }
  const embedded = await startEmbeddedMonitoringHub(opts);
  if (!embedded) {
    console.warn("[pushpals] Embedded monitoring hub could not start on any expected local port.");
  }
  return embedded;
}
async function sendMessageToServerSession(serverUrl, sessionId, text) {
  try {
    const response = await fetchWithTimeout(`${serverUrl}/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }, 15000);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`[pushpals] Session message rejected: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[pushpals] Failed to reach server session endpoint: ${String(err)}`);
    return false;
  }
}
function formatSessionEventLine(event) {
  const type = String(event.type ?? "").toLowerCase();
  const from = String(event.from ?? "");
  const payload = event.payload ?? {};
  if (!shouldDisplayInteractiveSessionEvent(event))
    return null;
  if (type === "message")
    return null;
  if (type === "assistant_message") {
    const text = String(payload.text ?? "").trim();
    if (!text)
      return null;
    return `assistant> ${text}`;
  }
  if (type === "task_progress") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return message ? `[task ${taskId}] ${message}` : null;
  }
  if (type === "task_failed") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[task ${taskId}] failed: ${message || "unknown"}`;
  }
  if (type === "task_completed") {
    const taskId = String(payload.taskId ?? "").slice(0, 8);
    const summary = String(payload.summary ?? "").trim();
    return `[task ${taskId}] completed${summary ? `: ${summary}` : ""}`;
  }
  if (type === "job_failed") {
    const jobId = String(payload.jobId ?? "").slice(0, 8);
    const message = String(payload.message ?? "").trim();
    return `[job ${jobId}] failed: ${message || "unknown"}`;
  }
  if (type === "error") {
    const message = String(payload.message ?? "").trim();
    return `[event error] ${message || "unknown"}`;
  }
  if (type === "status") {
    const state = String(payload.state ?? "").trim();
    const detail = String(payload.detail ?? "").trim();
    const source = from || String(payload.agentId ?? "status");
    return detail ? `[status ${source}] ${state || "unknown"} - ${detail}` : `[status ${source}] ${state || "unknown"}`;
  }
  return null;
}
async function runSessionStream(serverUrl, sessionId, client, print, signal) {
  let cursor = 0;
  while (!signal.aborted) {
    try {
      const response = await fetchWithTimeout(`${serverUrl}/sessions/${encodeURIComponent(sessionId)}/events${buildClientTransportQuery(cursor, client)}`, {}, 15000);
      if (!response.ok || !response.body) {
        print(`[pushpals] Session stream unavailable: HTTP ${response.status}`);
        await Bun.sleep(SSE_RECONNECT_MS);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder;
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(`

`);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.trim())
            continue;
          let blockCursor = 0;
          let rawData = "";
          for (const line2 of block.split(/\r?\n/)) {
            if (line2.startsWith("id:")) {
              const idText = line2.slice(3).trim();
              const parsed2 = Number.parseInt(idText, 10);
              if (Number.isFinite(parsed2) && parsed2 > 0) {
                blockCursor = parsed2;
              }
            } else if (line2.startsWith("data:")) {
              rawData += `${line2.slice(5).trim()}
`;
            }
          }
          if (!rawData.trim())
            continue;
          let parsed = null;
          try {
            parsed = JSON.parse(rawData.trim());
          } catch {
            continue;
          }
          const serverCursor = typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
          cursor = Math.max(cursor, blockCursor, serverCursor);
          if (!parsed.envelope)
            continue;
          const line = formatSessionEventLine(parsed.envelope);
          if (line)
            print(line);
        }
      }
    } catch {}
    if (!signal.aborted) {
      await Bun.sleep(SSE_RECONNECT_MS);
    }
  }
}
function buildOpenMonitoringHubCommand(url, platform = process.platform) {
  if (platform === "win32") {
    return ["cmd", "/c", "start", "", url];
  }
  if (platform === "darwin") {
    return ["open", url];
  }
  return ["xdg-open", url];
}
async function openMonitoringHub(url) {
  const cmd = buildOpenMonitoringHubCommand(url, process.platform);
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  });
  const code = await proc.exited;
  return code === 0;
}
function isCliExitCommand(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  return normalized === "/exit" || normalized === "/quit" || normalized === "exit" || normalized === "quit";
}
async function main() {
  const argv = process.argv.slice(2);
  logCliInvocation(argv);
  const parsed = parseArgs(argv);
  if (!parsed)
    return;
  const cwd = process.cwd();
  const repoRoot = await resolveCurrentGitRepoRoot(cwd);
  if (!repoRoot) {
    console.error("[pushpals] Refusing to start: current directory is not a git repository.");
    console.error(`[pushpals] cwd=${cwd}`);
    console.error("[pushpals] Run from a repo directory, or initialize one with `git init`.");
    process.exit(1);
  }
  const preparedRuntime = await prepareCliRuntime({
    repoRoot,
    runtimeRoot: parsed.runtimeRoot,
    runtimeTag: parsed.runtimeTag
  });
  const config = preparedRuntime.runtimePreflight.config;
  const statePath = resolveCliStatePath(repoRoot);
  if (parsed.clear) {
    const serverUrl2 = normalizeLoopbackUrl(parsed.serverUrl ?? process.env.PUSHPALS_SERVER_URL, config.server.url);
    const exitCode = await clearPushpalsState({
      repoRoot,
      runtimeRoot: preparedRuntime.runtimeRoot,
      config,
      serverUrl: serverUrl2,
      cliStatePath: statePath
    });
    process.exit(exitCode);
  }
  console.log("[pushpals] Running runtime preflight...");
  console.log(`[pushpals] runtimeRoot=${preparedRuntime.runtimeRoot}`);
  if (preparedRuntime.runtimeTag) {
    console.log(`[pushpals] runtimeTag=${preparedRuntime.runtimeTag}`);
  } else if (!preparedRuntime.preflightUsesEmbeddedRuntime) {
    console.log("[pushpals] runtimeTag=(deferred; using repo config for preflight)");
  } else {
    console.log("[pushpals] runtimeTag=(deferred until embedded auto-start is needed)");
  }
  emitCliRuntimePreflight(preparedRuntime.runtimePreflight);
  if (!preparedRuntime.runtimePreflight.ok) {
    process.exit(1);
  }
  if (config.remotebuddy.autonomy.enabled) {
    console.log("[pushpals] RemoteBuddy autonomy is enabled for CLI.");
  } else {
    console.warn("[pushpals] RemoteBuddy autonomy is disabled in config (remotebuddy.autonomy.enabled=false); continuing.");
  }
  const scmGitPrecheck = await precheckSourceControlManagerGitAvailability({
    repoRoot,
    remote: config.sourceControlManager.remote,
    runtimeRoot: preparedRuntime.runtimeRoot,
    preflightUsesEmbeddedRuntime: preparedRuntime.preflightUsesEmbeddedRuntime
  });
  if (scmGitPrecheck.status === "failed") {
    console.error(`[pushpals] Precheck failed: embedded SourceControlManager git command is unavailable (${scmGitPrecheck.detail}).`);
    process.exit(1);
  }
  const workerpalDockerPrecheck = await precheckWorkerpalDockerAvailability({
    repoRoot,
    runtimeRoot: preparedRuntime.runtimeRoot,
    preflightUsesEmbeddedRuntime: preparedRuntime.preflightUsesEmbeddedRuntime,
    autoSpawnWorkerpals: Boolean(config.remotebuddy.autoSpawnWorkerpals),
    dockerEnabled: Boolean(config.remotebuddy.workerpalDocker),
    requireDocker: Boolean(config.remotebuddy.workerpalRequireDocker),
    baseEnv: scmGitPrecheck.env
  });
  const precheckPassed = await enforcePushpalsRemoteBranchPrecheck(repoRoot, config.sourceControlManager.remote, config.sourceControlManager.mainBranch);
  if (!precheckPassed) {
    process.exit(1);
  }
  const serverUrl = normalizeLoopbackUrl(parsed.serverUrl ?? process.env.PUSHPALS_SERVER_URL, config.server.url);
  const localAgentUrl = normalizeLoopbackUrl(parsed.localAgentUrl ?? process.env.EXPO_PUBLIC_LOCAL_AGENT_URL, config.client.localAgentUrl);
  const sessionId = String(parsed.sessionId ?? process.env.PUSHPALS_SESSION_ID ?? config.sessionId).trim();
  const cliVersion = String(process.env.PUSHPALS_CLI_PACKAGE_VERSION ?? "").trim() || "unknown";
  const cliClient = {
    clientId: createRuntimeClientId("cli"),
    kind: "cli",
    label: "CLI",
    version: cliVersion,
    platform: `${process.platform}/${process.arch}`,
    repoRoot
  };
  let autoStartedServices = [];
  let pushpalsLogPath;
  let resolvedRuntimeTagForAutoStart = preparedRuntime.runtimeTag || parsed.runtimeTag || "";
  const stopAutoStartedServices = () => {
    if (autoStartedServices.length === 0)
      return;
    stopRuntimeServices(autoStartedServices);
    autoStartedServices = [];
  };
  let serverHealthy = await probeServer(serverUrl);
  const serverWasAlreadyHealthy = serverHealthy;
  if (!serverHealthy && workerpalDockerPrecheck.status === "failed") {
    console.error(`[pushpals] Precheck failed: Docker-backed WorkerPal auto-spawn is required but Docker is unavailable (${workerpalDockerPrecheck.detail}).`);
    console.error("[pushpals] Precheck failed: start Docker Desktop or the Docker daemon, then retry pushpals.");
    process.exit(1);
  }
  if (workerpalDockerPrecheck.status !== "failed") {
    const workerpalImagePrecheck = await prepareEmbeddedWorkerpalDockerImageIfNeeded({
      preparedRuntime,
      config,
      dockerPrecheck: workerpalDockerPrecheck,
      runtimeTagHint: resolvedRuntimeTagForAutoStart || parsed.runtimeTag
    });
    if (workerpalImagePrecheck.status === "failed") {
      console.error(`[pushpals] Precheck failed: ${workerpalImagePrecheck.detail}.`);
      process.exit(1);
    }
    if (workerpalImagePrecheck.runtimeTag) {
      resolvedRuntimeTagForAutoStart = workerpalImagePrecheck.runtimeTag;
    }
  }
  let remoteBuddyConsumerHealth = {
    ok: false,
    detail: `No connected RemoteBuddy session consumer found for session ${sessionId}`
  };
  if (!serverHealthy) {
    if (!parsed.noAutoStart) {
      try {
        const startedRuntime = await autoStartRuntimeServices({
          repoRoot,
          serverUrl,
          localAgentUrl,
          sessionId,
          sourceControlManagerPort: config.sourceControlManager.port,
          sourceControlManagerRemote: config.sourceControlManager.remote,
          preparedRuntime,
          requestedRuntimeTag: resolvedRuntimeTagForAutoStart || parsed.runtimeTag,
          startLocalBuddy: resolveCliLocalBuddyAutostart(parsed.runtimeOnly, Boolean(config.localbuddy.enabled)),
          baseEnv: workerpalDockerPrecheck.env
        });
        autoStartedServices = startedRuntime.services;
        pushpalsLogPath = startedRuntime.pushpalsLogPath;
        serverHealthy = await probeServer(serverUrl);
      } catch (err) {
        console.error(`[pushpals] Auto-start failed: ${String(err)}`);
        stopAutoStartedServices();
      }
    }
    if (!serverHealthy) {
      console.error(`[pushpals] Server is unavailable at ${serverUrl}.`);
      if (parsed.noAutoStart) {
        console.error("[pushpals] Auto-start is disabled (--no-auto-start).");
      } else {
        console.error("[pushpals] Auto-start could not bring the embedded runtime online.");
      }
      process.exit(1);
    }
  }
  try {
    await ensureServerRepoAffinity(serverUrl, repoRoot);
  } catch (err) {
    stopAutoStartedServices();
    console.error(`[pushpals] Repo affinity check failed: ${String(err)}`);
    process.exit(1);
  }
  let activeSessionId = sessionId;
  if (!parsed.runtimeOnly) {
    try {
      activeSessionId = await ensureServerSession(serverUrl, sessionId, cliClient);
    } catch (err) {
      stopAutoStartedServices();
      console.error(`[pushpals] Session bootstrap failed: ${String(err)}`);
      process.exit(1);
    }
  }
  remoteBuddyConsumerHealth = await probeRemoteBuddySessionConsumer(serverUrl, activeSessionId);
  if (!serverHealthy) {
    console.error(`[pushpals] Server is unavailable at ${serverUrl}.`);
    process.exit(1);
  }
  if (!remoteBuddyConsumerHealth.ok) {
    stopAutoStartedServices();
    console.error(`[pushpals] RemoteBuddy is not ready for session ${activeSessionId}: ${remoteBuddyConsumerHealth.detail}`);
    if (serverWasAlreadyHealthy) {
      console.error("[pushpals] A PushPals runtime is already serving this repo, but it does not have a connected RemoteBuddy consumer for this session.");
      console.error("[pushpals] Refusing to start another embedded RemoteBuddy against the same runtime. Restart or stop the existing runtime before retrying.");
    } else if (parsed.noAutoStart) {
      console.error("[pushpals] Auto-start is disabled (--no-auto-start).");
    } else {
      console.error("[pushpals] Auto-start could not bring the embedded runtime into a usable state.");
    }
    process.exit(1);
  }
  const workerpalCapacity = await waitForWorkerpalCapacity({
    serverUrl,
    timeoutMs: resolveWorkerpalCapacityTimeoutMs(config),
    ttlMs: config.remotebuddy.workerpalOnlineTtlMs
  });
  if (!workerpalCapacity.ok) {
    stopAutoStartedServices();
    console.error(`[pushpals] WorkerPal capacity is not ready for repo ${repoRoot}: ${workerpalCapacity.detail}.`);
    if (workerpalDockerPrecheck.status === "failed") {
      console.error(`[pushpals] Docker precheck detail: ${workerpalDockerPrecheck.detail}`);
    } else if (serverWasAlreadyHealthy) {
      console.error("[pushpals] A PushPals runtime is already serving this repo, but it does not currently have an idle WorkerPal available.");
      console.error("[pushpals] Wait for a worker to become idle or restart the runtime after fixing WorkerPal startup.");
    }
    process.exit(1);
  }
  const saved = statePath ? readCliState(statePath) : {};
  pushpalsLogPath = pushpalsLogPath || (typeof saved.pushpalsLogPath === "string" ? saved.pushpalsLogPath : undefined);
  const preferredHubUrl = normalizeUrl(parsed.monitoringHubUrl ?? process.env.PUSHPALS_MONITOR_URL ?? saved.monitoringHubUrl ?? "");
  const monitorPort = parsePositiveInt(process.env.PUSHPALS_CLIENT_PORT, DEFAULT_MONITOR_PORT);
  const monitoringHub = await resolveMonitoringHub({
    preferredUrl: preferredHubUrl,
    fallbackPort: monitorPort,
    serverUrl,
    sessionId: activeSessionId
  });
  const monitoringHubUrl = monitoringHub?.url ?? "";
  if (statePath) {
    writeCliState(statePath, {
      monitoringHubUrl: monitoringHubUrl || undefined,
      serverUrl,
      localAgentUrl,
      sessionId: activeSessionId,
      repoRoot,
      pushpalsLogPath
    });
  } else {
    console.warn("[pushpals] Could not resolve git metadata dir; skipping CLI state persistence.");
  }
  console.log("[pushpals] Connected.");
  if (monitoringHubUrl) {
    console.log(`[pushpals] monitoringHubUrl=${monitoringHubUrl}`);
    if (monitoringHub?.embedded) {
      console.log("[pushpals] Embedded monitoring hub is running.");
    }
  } else {
    console.log("[pushpals] monitoringHubUrl=unavailable");
  }
  console.log(`[pushpals] serverUrl=${serverUrl}`);
  console.log(`[pushpals] sessionId=${activeSessionId}`);
  console.log(`[pushpals] repoRoot=${repoRoot}`);
  console.log(`[pushpals] pushpalsLog=${pushpalsLogPath ?? "unavailable"}`);
  console.log(`[pushpals] cliStateFile=${statePath ?? "unavailable"}`);
  if (parsed.runtimeOnly) {
    console.log("[pushpals] runtimeOnly=true");
  } else {
    console.log("[pushpals] Type a message and press Enter. Use /exit or exit to quit.");
  }
  const streamAbort = new AbortController;
  let rl = null;
  const printIncoming = (line) => {
    if (!line)
      return;
    if (rl) {
      process.stdout.write(`
${line}
`);
      rl.prompt();
      return;
    }
    console.log(line);
  };
  const streamTask = parsed.noStream ? Promise.resolve() : parsed.runtimeOnly ? Promise.resolve() : runSessionStream(serverUrl, activeSessionId, cliClient, printIncoming, streamAbort.signal);
  let shuttingDown = false;
  const requestStop = () => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    console.log("[pushpals] Shutting down CLI session...");
    streamAbort.abort();
    if (rl)
      rl.close();
    try {
      monitoringHub?.stop();
    } catch {}
    if (autoStartedServices.length > 0) {
      console.log("[pushpals] Stopping embedded runtime services...");
    }
    stopAutoStartedServices();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.once("exit", requestStop);
  if (parsed.runtimeOnly) {
    console.log("[pushpals] Runtime-only mode is active. Send `exit` on stdin or terminate the process to stop.");
    await new Promise((resolveStop) => {
      let resolved = false;
      const finish = () => {
        if (resolved)
          return;
        resolved = true;
        resolveStop();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      const runtimeOnlyInput = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
      runtimeOnlyInput.on("line", (line) => {
        if (!isCliExitCommand(line))
          return;
        requestStop();
        runtimeOnlyInput.close();
        finish();
      });
      runtimeOnlyInput.on("close", () => {
        requestStop();
        finish();
      });
    });
    requestStop();
    await Promise.race([streamTask, Bun.sleep(2000)]);
    return;
  }
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  rl.setPrompt("you> ");
  rl.prompt();
  for await (const rawLine of rl) {
    const text = String(rawLine ?? "").trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (isCliExitCommand(text)) {
      requestStop();
      break;
    }
    if (text === "/hub") {
      console.log(monitoringHubUrl ? `[pushpals] monitoringHubUrl=${monitoringHubUrl}` : "[pushpals] monitoringHubUrl=unavailable");
      rl.prompt();
      continue;
    }
    if (text === "/status") {
      console.log(`[pushpals] serverUrl=${serverUrl}`);
      console.log(`[pushpals] sessionId=${activeSessionId}`);
      console.log(`[pushpals] repoRoot=${repoRoot}`);
      console.log(`[pushpals] pushpalsLog=${pushpalsLogPath ?? "unavailable"}`);
      console.log(monitoringHubUrl ? `[pushpals] monitoringHubUrl=${monitoringHubUrl}` : "[pushpals] monitoringHubUrl=unavailable");
      rl.prompt();
      continue;
    }
    if (text === "/open") {
      if (!monitoringHubUrl) {
        console.log("[pushpals] Monitoring hub is unavailable.");
        rl.prompt();
        continue;
      }
      const opened = await openMonitoringHub(monitoringHubUrl);
      console.log(opened ? `[pushpals] Opened ${monitoringHubUrl}` : `[pushpals] Failed to open browser. Use this link: ${monitoringHubUrl}`);
      rl.prompt();
      continue;
    }
    const normalized = normalizeCliInteractiveMessage(text);
    if (normalized.usageMessage) {
      console.log(`[pushpals] ${normalized.usageMessage}`);
      rl.prompt();
      continue;
    }
    const ok = await sendMessageToServerSession(serverUrl, activeSessionId, normalized.text);
    if (!ok) {
      console.log("[pushpals] Message failed.");
    }
    rl.prompt();
  }
  requestStop();
  await Promise.race([streamTask, Bun.sleep(2000)]);
}
if (import.meta.main) {
  main().catch((err) => {
    console.error(`[pushpals] Fatal: ${String(err)}`);
    process.exit(1);
  });
}
export {
  waitForWorkerpalCapacity,
  startEmbeddedMonitoringHub,
  resolveWindowsWhereExecutableCandidatesForEnv,
  resolveWindowsShellExecutableCandidatesForEnv,
  resolveRuntimeGitExecutableCandidates,
  resolveRuntimeDockerExecutableCandidates,
  resolvePreferredRuntimeReleaseTag,
  resolveCommandPath,
  resolveCliStatePath,
  resolveCliLocalBuddyAutostart,
  resolveBundledRuntimeAssetSource,
  resolveBundledMonitoringHubRoot,
  prepareEmbeddedWorkerpalDockerImageIfNeeded,
  prepareCliRuntime,
  precheckWorkerpalDockerAvailability,
  precheckSourceControlManagerGitAvailability,
  normalizeRepoPathForComparison,
  normalizeCliInteractiveMessage,
  normalizeChildProcessEnv,
  isCliExitCommand,
  injectMonitoringHubBootstrap,
  formatTimestampedCliLine,
  formatSessionEventLine,
  extractRemoteBuddySessionConsumerHealth,
  extractRemoteBuddyAutonomousEngineState,
  ensureWorkerpalDockerImageReady,
  downloadRuntimeAssetsFromSourceTag,
  copyTrackedRepoPath,
  bundledMonitoringHubNeedsRefresh,
  buildWorkerpalSandboxPaths,
  buildServiceStopCommand,
  buildRuntimeServiceLogPaths,
  buildOpenMonitoringHubCommand,
  buildEmbeddedRuntimeEnv,
  buildEmbeddedMonitoringHubHtml,
  buildCliClearTargets,
  applyResolvedGitBinaryToRuntimeEnv,
  applyResolvedDockerBinaryToRuntimeEnv
};
