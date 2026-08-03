#!/usr/bin/env bun
// @bun

// apps/workerpals/src/workerpals_main.ts
import { randomUUID as randomUUID2 } from "crypto";
import { mkdirSync as mkdirSync5 } from "fs";
import { resolve as resolve12 } from "path";

// packages/shared/src/repo.ts
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
function resolveDotGitEntry(repoRoot) {
  return resolve(repoRoot, ".git");
}
function findGitRepoRoot(startDir) {
  const override = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? "").trim();
  if (override) {
    const resolvedOverride = resolve(override);
    if (resolveGitMetadataDir(resolvedOverride)) {
      return resolvedOverride;
    }
    console.warn(`[repo] PUSHPALS_REPO_ROOT_OVERRIDE does not point to a git repository: ${resolvedOverride}`);
  }
  let current = resolve(startDir);
  const root = resolve(current, "/");
  while (current !== root) {
    if (resolveGitMetadataDir(current)) {
      return current;
    }
    current = resolve(current, "..");
  }
  return resolveGitMetadataDir(root) ? root : null;
}
function resolveGitMetadataDir(repoRoot) {
  const dotGitPath = resolveDotGitEntry(repoRoot);
  if (!existsSync(dotGitPath))
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
    const firstLine = readFileSync(dotGitPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match)
      return null;
    const gitDir = resolve(repoRoot, match[1].trim());
    return existsSync(gitDir) ? gitDir : null;
  } catch {
    return null;
  }
}
function resolveGitStateFilePath(repoRoot, fileName) {
  const gitMetadataDir = resolveGitMetadataDir(repoRoot);
  const normalizedFileName = String(fileName ?? "").trim();
  if (!gitMetadataDir || !normalizedFileName)
    return null;
  return resolve(gitMetadataDir, normalizedFileName);
}
function detectRepoRoot(startDir) {
  const repoRoot = findGitRepoRoot(startDir);
  if (repoRoot) {
    return repoRoot;
  }
  console.warn(`[repo] No .git directory found, using: ${startDir}`);
  return startDir;
}
// packages/shared/src/prompts.ts
import { readFileSync as readFileSync2 } from "fs";
import { join, resolve as resolve2 } from "path";
var TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
var promptTemplateCache = new Map;
var repoDocCache = new Map;
function resolvePromptPath(relativePath) {
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const repoRoot = promptRootOverride ? resolve2(promptRootOverride) : detectRepoRoot(process.cwd());
  return join(repoRoot, "prompts", relativePath);
}
function loadPromptTemplate(relativePath, replacements) {
  const promptPath = resolvePromptPath(relativePath);
  let template = promptTemplateCache.get(promptPath);
  if (template === undefined) {
    template = readFileSync2(promptPath, "utf8");
    promptTemplateCache.set(promptPath, template);
  }
  if (!replacements || Object.keys(replacements).length === 0) {
    return template;
  }
  return template.replace(TEMPLATE_TOKEN, (_match, token) => {
    const value = replacements[token];
    if (value === undefined) {
      throw new Error(`[prompts] Missing replacement for "{{${token}}}" in ${promptPath}`);
    }
    return value;
  });
}
// packages/shared/src/config.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { join as join2, resolve as resolve3, isAbsolute } from "path";

// packages/shared/src/autonomy_policy.ts
var PATH_META_RE = /[*?\[\]{}()!]/;
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
function normalizeTargetPath(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  if (PATH_META_RE.test(normalized))
    return null;
  return normalized;
}
function escapeRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchesSegment(pathSegment, globSegment) {
  const regexSource = `^${escapeRegex(globSegment).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`;
  return new RegExp(regexSource).test(pathSegment);
}
function matchesGlob(path, glob) {
  const pathSegs = path.split("/");
  const globSegs = glob.split("/");
  const walk = (pi, gi) => {
    if (gi >= globSegs.length)
      return pi >= pathSegs.length;
    const g = globSegs[gi];
    if (g === "**") {
      if (gi === globSegs.length - 1)
        return true;
      for (let k = pi;k <= pathSegs.length; k++) {
        if (walk(k, gi + 1))
          return true;
      }
      return false;
    }
    if (pi >= pathSegs.length)
      return false;
    if (!matchesSegment(pathSegs[pi], g))
      return false;
    return walk(pi + 1, gi + 1);
  };
  return walk(0, 0);
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
function resolveLocalServerConnection(options) {
  const rawServer = String(options.serverUrl ?? "").trim().replace(/\/+$/, "");
  const normalizedServer = normalizeLoopbackHttpUrl(rawServer, options.fallbackPort);
  const authToken = String(options.authToken ?? "").trim();
  return {
    serverUrl: normalizedServer,
    authToken: null,
    serverWasNormalized: !!rawServer && normalizedServer !== rawServer,
    authTokenWasIgnored: authToken.length > 0
  };
}

// packages/shared/src/config.ts
var PROJECT_ROOT = resolve3(import.meta.dir, "..", "..", "..");
var DEFAULT_CONFIG_DIR = "configs";
var TRUTHY = new Set(["1", "true", "yes", "on"]);
var FALSY = new Set(["0", "false", "no", "off"]);
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE = 8;
var DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 3;
var DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
var DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
var DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
var DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
var DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 90000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR = "retry_once";
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8000;
var DEFAULT_WORKERPALS_EXECUTOR = "openai_codex";
var DEFAULT_WORKERPALS_EXECUTION_PLATFORM = "auto";
var DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
var DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
var DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.6-sol";
var DEFAULT_OPENAI_CODEX_REASONING_EFFORT = "xhigh";
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
  if (!existsSync2(path))
    return {};
  const raw = readFileSync3(path, "utf-8").replace(/^\uFEFF/, "");
  const parsed = Bun.TOML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed;
}
function parseRequiredTomlFile(path) {
  if (!existsSync2(path)) {
    throw new Error(`Missing required runtime config file: ${path}`);
  }
  return parseTomlFile(path);
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
function asQualityCriticTimeoutBehavior(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "skip" || normalized === "retry_once" || normalized === "block") {
    return normalized;
  }
  return DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR;
}
function normalizeWorkerPalsExecutionPlatform(value, fallback = DEFAULT_WORKERPALS_EXECUTION_PLATFORM) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "auto" || normalized === "windows" || normalized === "linux_docker") {
    return normalized;
  }
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
    return resolve3(value);
  return resolve3(projectRoot, value);
}
function resolveRuntimeConfigDir(projectRoot, configuredDir) {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(projectRoot, configuredDir);
  }
  return resolvePathFromRoot(projectRoot, DEFAULT_CONFIG_DIR);
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
  const envModel = firstNonEmpty(process.env[`${envPrefix}_LLM_MODEL`]);
  const configuredFileModel = firstNonEmpty(asString(llmNode.model, ""));
  const configuredModel = firstNonEmpty(envModel, configuredFileModel);
  const modelFallback = backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_MODEL : defaults.model;
  const model = backend === "openai_codex" && !envModel && (!configuredFileModel || configuredFileModel === defaults.model) ? DEFAULT_OPENAI_CODEX_MODEL : firstNonEmpty(configuredModel, modelFallback) ?? modelFallback;
  const sessionId = firstNonEmpty(process.env[`${envPrefix}_LLM_SESSION_ID`], asString(llmNode.session_id, defaults.sessionId), process.env.PUSHPALS_LLM_SESSION_ID, globalSessionId);
  const apiKey = firstNonEmpty(process.env[`${envPrefix}_LLM_API_KEY`], defaultApiKeyForBackend(backend, endpoint));
  const reasoningEffort = firstNonEmpty(process.env[`${envPrefix}_LLM_REASONING_EFFORT`], asString(llmNode.reasoning_effort, ""), backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_REASONING_EFFORT : "");
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
  const projectRoot = resolve3(projectRootOverride);
  const configDirOverride = firstNonEmpty(options.configDir, process.env.PUSHPALS_CONFIG_DIR_OVERRIDE, "");
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }
  const defaultToml = parseRequiredTomlFile(join2(configDir, "default.toml"));
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlFile(join2(configDir, `${preferredProfile}.toml`));
  const localExampleToml = parseTomlFile(join2(configDir, "local.example.toml"));
  const localToml = parseTomlFile(join2(configDir, "local.toml"));
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
  const sharedDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DB_PATH, asString(pathsNode.shared_db_path, join2(dataDir, "pushpals.db"))));
  const remotebuddyDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.REMOTEBUDDY_DB_PATH, asString(pathsNode.remotebuddy_db_path, join2(dataDir, "remotebuddy-state.db"))));
  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(1, asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001));
  const serverUrl = normalizeLoopbackHttpUrl(firstNonEmpty(process.env.PUSHPALS_SERVER_URL, asString(serverNode.url, `http://127.0.0.1:${serverPort}`), `http://127.0.0.1:${serverPort}`), serverPort);
  const serverHost = normalizeLoopbackHost(firstNonEmpty(process.env.PUSHPALS_HOST, asString(serverNode.host, "127.0.0.1")));
  const debugHttp = parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(5000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms, 120000));
  const staleClaimSweepIntervalMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS") ?? serverNode.stale_claim_sweep_interval_ms, 5000));
  const sessionTokenBudget = Math.max(0, asInt(parseIntEnv("PUSHPALS_SESSION_TOKEN_BUDGET") ?? serverNode.session_token_budget, 0));
  const sessionTokenBudgetAction = "pause";
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
  const remoteMaxWorkerpals = Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_MAX_WORKERPALS") ?? remoteNode.max_workerpals, 20));
  const remoteMinWorkerpals = Math.max(1, Math.min(remoteMaxWorkerpals, asInt(parseIntEnv("REMOTEBUDDY_MIN_WORKERPALS") ?? remoteNode.min_workerpals, 1)));
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
    const parsed = rawValue;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerExecutionPlatform = normalizeWorkerPalsExecutionPlatform(firstNonEmpty(process.env.WORKERPALS_EXECUTION_PLATFORM, process.env.PUSHPALS_WORKERPALS_EXECUTION_PLATFORM, asString(workerNode.execution_platform, DEFAULT_WORKERPALS_EXECUTION_PLATFORM), DEFAULT_WORKERPALS_EXECUTION_PLATFORM));
  const configuredRemoteWorkerpalDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ?? asBoolean(remoteNode.workerpal_docker, true);
  const configuredRemoteWorkerpalRequireDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ?? asBoolean(remoteNode.workerpal_require_docker, true);
  const configuredWorkerRequireDocker = parseBoolEnv("WORKERPALS_REQUIRE_DOCKER") ?? asBoolean(workerNode.require_docker, false);
  const effectiveRemoteWorkerpalDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalDocker;
  const effectiveRemoteWorkerpalRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalRequireDocker;
  const effectiveWorkerRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredWorkerRequireDocker;
  const workerPollMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2000));
  const workerHeartbeatMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_HEARTBEAT_MS") ?? workerNode.heartbeat_ms, 5000));
  const workerExecutor = firstNonEmpty(process.env.WORKERPALS_EXECUTOR, asString(workerNode.executor, DEFAULT_WORKERPALS_EXECUTOR), DEFAULT_WORKERPALS_EXECUTOR).toLowerCase();
  const workerOpenHandsPython = firstNonEmpty(process.env.WORKERPALS_OPENHANDS_PYTHON, asString(workerNode.openhands_python, "python"), "python");
  const workerOpenHandsTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_OPENHANDS_TIMEOUT_MS") ?? workerNode.openhands_timeout_ms, 1800000));
  const workerMiniswePython = firstNonEmpty(process.env.WORKERPALS_MINISWE_PYTHON, asString(workerNode.miniswe_python, "python"), "python");
  const workerMinisweTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_MINISWE_TIMEOUT_MS") ?? workerNode.miniswe_timeout_ms, 1800000));
  const workerOpenAICodexPython = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_PYTHON, asString(workerNode.openai_codex_python, "python"), "python");
  const workerOpenAICodexTimeoutMs = Math.max(1e4, asInt(workerNode.openai_codex_timeout_ms, 7200000));
  const workerQualityMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_MAX_AUTO_REVISIONS") ?? workerNode.quality_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerQualityValidationMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_MAX_AUTO_REVISIONS") ?? workerNode.quality_validation_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
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
  const workerQualityCriticTimeoutBehavior = asQualityCriticTimeoutBehavior(process.env.WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR ?? workerNode.quality_critic_timeout_behavior);
  const workerQualitySoftPassOnExhausted = parseBoolEnv("WORKERPALS_QUALITY_SOFT_PASS_ON_EXHAUSTED") ?? asBoolean(workerNode.quality_soft_pass_on_exhausted, true);
  const workerQualityScopeGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_SCOPE_GATE_ENABLED") ?? asBoolean(workerNode.quality_scope_gate_enabled, true);
  const workerQualityValidationGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_VALIDATION_GATE_ENABLED") ?? asBoolean(workerNode.quality_validation_gate_enabled, true);
  const workerQualityCriticGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_CRITIC_GATE_ENABLED") ?? asBoolean(workerNode.quality_critic_gate_enabled, true);
  const workerQualityPublishGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_PUBLISH_GATE_ENABLED") ?? asBoolean(workerNode.quality_publish_gate_enabled, true);
  const workerQualityCriticMinScore = (() => {
    const configThresholdRaw = workerNode.quality_critic_min_score == null ? "" : String(workerNode.quality_critic_min_score);
    const raw = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE, configThresholdRaw, String(DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE));
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed))
      return DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    return Math.max(0, Math.min(10, parsed));
  })();
  const workerQualityCriticModel = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MODEL, asString(workerNode.quality_critic_model, ""), "");
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
  const scmStateDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_STATE_DIR, asString(scmNode.state_dir, join2(dataDir, "source_control_manager")), join2(dataDir, "source_control_manager")));
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
      staleClaimSweepIntervalMs,
      sessionTokenBudget,
      sessionTokenBudgetAction
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
      minWorkerpals: remoteMinWorkerpals,
      maxWorkerpals: remoteMaxWorkerpals,
      workerpalStartupTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS") ?? remoteNode.workerpal_startup_timeout_ms, 1e4)),
      workerpalDocker: effectiveRemoteWorkerpalDocker,
      workerpalRequireDocker: effectiveRemoteWorkerpalRequireDocker,
      workerpalImage: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_IMAGE, asString(remoteNode.workerpal_image, "")) || null,
      workerpalPollMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_POLL_MS")) ?? asIntOrNull(remoteNode.workerpal_poll_ms),
      workerpalHeartbeatMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_HEARTBEAT_MS")) ?? asIntOrNull(remoteNode.workerpal_heartbeat_ms),
      workerpalLabels: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS) ? firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(remoteNode.workerpal_labels),
      executionBudgetInteractiveMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_INTERACTIVE_MS") ?? remoteNode.execution_budget_interactive_ms, 300000)),
      executionBudgetNormalMs: Math.max(120000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_NORMAL_MS") ?? remoteNode.execution_budget_normal_ms, 900000)),
      executionBudgetBackgroundMs: Math.max(180000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_BACKGROUND_MS") ?? remoteNode.execution_budget_background_ms, 1200000)),
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
        startupGraceMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STARTUP_GRACE_MS") ?? remoteAutonomyNode.startup_grace_ms, 120000)),
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
        allowReadAnywhere: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_READ_ANYWHERE") ?? asBoolean(remoteAutonomyNode.allow_read_anywhere, true),
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
      executionPlatform: workerExecutionPlatform,
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
      requireDocker: effectiveWorkerRequireDocker,
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
      qualityValidationMaxAutoRevisions: workerQualityValidationMaxAutoRevisions,
      qualityScopeGateEnabled: workerQualityScopeGateEnabled,
      qualityValidationGateEnabled: workerQualityValidationGateEnabled,
      qualityCriticGateEnabled: workerQualityCriticGateEnabled,
      qualityPublishGateEnabled: workerQualityPublishGateEnabled,
      qualityValidationStepTimeoutMs: workerQualityValidationStepTimeoutMs,
      qualityCriticTimeoutMs: workerQualityCriticTimeoutMs,
      qualityCriticTimeoutBehavior: workerQualityCriticTimeoutBehavior,
      qualitySoftPassOnExhausted: workerQualitySoftPassOnExhausted,
      qualityCriticMinScore: workerQualityCriticMinScore,
      qualityCriticModel: workerQualityCriticModel,
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
var ANY_HEADING_RE = /^##+\s+(.+?)\s*$/;
var BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
var MAX_KEY_ITEMS_PER_BUCKET = 8;
function toLines(markdown) {
  return String(markdown ?? "").replace(/\r\n/g, `
`).split(`
`);
}
function normalizeItem(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function dedupeAndClamp(values) {
  const out = [];
  const seen = new Set;
  for (const raw of values) {
    const value = normalizeItem(raw);
    if (!value)
      continue;
    const key = value.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_KEY_ITEMS_PER_BUCKET)
      break;
  }
  return out;
}
function classifyHeadingBucket(heading) {
  const text = heading.toLowerCase();
  if (text.includes("who this is for") || text.includes("user"))
    return "targetUsers";
  if (text.includes("priorit"))
    return "priorities";
  if (text.includes("objective"))
    return "objectives";
  if (text.includes("principle") || text.includes("guardrail"))
    return "guardrails";
  if (text.includes("constraint"))
    return "constraints";
  if (text.includes("non-goal") || text.includes("out of scope") || text.includes("not ")) {
    return "nonGoals";
  }
  if (text.includes("testing criteria") || text.includes("test criteria") || text.includes("required tests") || text.includes("required validation") || text.includes("validation criteria")) {
    return "testingCriteria";
  }
  if (text.includes("measure") || text.includes("metric") || text.includes("good looks like")) {
    return "metrics";
  }
  if (text.includes("risk") || text.includes("gate"))
    return "riskPolicy";
  if (text.includes("operating model") || text.includes("role"))
    return "operatingModel";
  if (text.includes("decision") || text.includes("governance"))
    return "governance";
  return null;
}
function extractVisionKeyItems(markdown) {
  const lines = toLines(markdown);
  const buckets = {
    targetUsers: [],
    priorities: [],
    objectives: [],
    guardrails: [],
    constraints: [],
    nonGoals: [],
    metrics: [],
    testingCriteria: [],
    riskPolicy: [],
    operatingModel: [],
    governance: []
  };
  let activeBucket = null;
  for (const line of lines) {
    const heading = line.match(ANY_HEADING_RE);
    if (heading) {
      activeBucket = classifyHeadingBucket(heading[1]);
      continue;
    }
    const bullet = line.match(BULLET_RE);
    if (!bullet)
      continue;
    if (!activeBucket)
      continue;
    buckets[activeBucket].push(bullet[1]);
  }
  return {
    targetUsers: dedupeAndClamp(buckets.targetUsers),
    priorities: dedupeAndClamp(buckets.priorities),
    objectives: dedupeAndClamp(buckets.objectives),
    guardrails: dedupeAndClamp(buckets.guardrails),
    constraints: dedupeAndClamp(buckets.constraints),
    nonGoals: dedupeAndClamp(buckets.nonGoals),
    metrics: dedupeAndClamp(buckets.metrics),
    testingCriteria: dedupeAndClamp(buckets.testingCriteria),
    riskPolicy: dedupeAndClamp(buckets.riskPolicy),
    operatingModel: dedupeAndClamp(buckets.operatingModel),
    governance: dedupeAndClamp(buckets.governance)
  };
}
// packages/shared/src/git_backend.ts
function trimToken(value) {
  return String(value ?? "").trim();
}
function firstNonEmpty2(env, keys) {
  for (const key of keys) {
    const value = trimToken(env[key]);
    if (value)
      return value;
  }
  return "";
}
function parseGitRemoteHost(remoteUrl) {
  const raw = trimToken(remoteUrl);
  if (!raw)
    return "";
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^ssh:\/\/(?:[^@/]+@)?([^/:?#]+)(?::\d+)?(?:[/?#].*)?$/i,
    /^(?:[^@:\s]+@)?([^:/\s]+):[^?\s]+$/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const host = match?.[1] ? trimToken(match[1]) : "";
    if (host)
      return host.toLowerCase();
  }
  return "";
}
function inferGitBackendFromRemote(remoteUrl) {
  const host = parseGitRemoteHost(remoteUrl);
  if (!host)
    return "unknown";
  if (host === "github.com" || host.endsWith(".github.com") || host.includes("github")) {
    return "github";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.includes("gitlab")) {
    return "gitlab";
  }
  return "unknown";
}
async function defaultRunCommand(command, cwd) {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: String(err),
      exitCode: 127
    };
  }
}
async function resolveGitHubCliToken(host, runCommand, cwd) {
  const useHostname = host && host !== "github.com";
  const command = useHostname ? ["gh", "auth", "token", "--hostname", host] : ["gh", "auth", "token"];
  const result = await runCommand(command, cwd);
  return result.ok ? trimToken(result.stdout) : "";
}
async function resolveGitLabCliToken(runCommand, cwd) {
  const result = await runCommand(["glab", "auth", "token"], cwd);
  return result.ok ? trimToken(result.stdout) : "";
}
async function resolveGitTokenForRemote(options) {
  const configuredToken = trimToken(options.configuredToken);
  const host = parseGitRemoteHost(options.remoteUrl);
  const backend = inferGitBackendFromRemote(options.remoteUrl);
  const env = options.env ?? process.env;
  if (configuredToken) {
    return { backend, host, token: configuredToken, source: "configured" };
  }
  const envVarOrder = backend === "gitlab" ? ["PUSHPALS_GIT_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"] : backend === "github" ? ["PUSHPALS_GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] : ["PUSHPALS_GIT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"];
  const envToken = firstNonEmpty2(env, envVarOrder);
  if (envToken) {
    return { backend, host, token: envToken, source: "env" };
  }
  const runCommand = options.runCommand ?? defaultRunCommand;
  let cliToken = "";
  if (backend === "github") {
    cliToken = await resolveGitHubCliToken(host, runCommand, options.cwd);
  } else if (backend === "gitlab") {
    cliToken = await resolveGitLabCliToken(runCommand, options.cwd);
  } else {
    cliToken = await resolveGitHubCliToken(host, runCommand, options.cwd);
    if (!cliToken) {
      cliToken = await resolveGitLabCliToken(runCommand, options.cwd);
    }
  }
  if (cliToken) {
    return { backend, host, token: cliToken, source: "cli" };
  }
  return { backend, host, token: "", source: "none" };
}
// packages/shared/src/source_control_api.ts
function firstNonEmptyString(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return "";
}
function sanitizeSourceControlIdentityField(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}
function explicitSourceControlCommitIdentityFromEnv(env, fallbackEmail = "") {
  const name = sanitizeSourceControlIdentityField(firstNonEmptyString(env.WORKERPALS_GIT_AUTHOR_NAME, env.PUSHPALS_GIT_AUTHOR_NAME, env.GIT_AUTHOR_NAME));
  const email = sanitizeSourceControlIdentityField(firstNonEmptyString(env.WORKERPALS_GIT_AUTHOR_EMAIL, env.PUSHPALS_GIT_AUTHOR_EMAIL, env.GIT_AUTHOR_EMAIL, fallbackEmail));
  if (!name || !email)
    return null;
  return { name, email, source: "env" };
}
function buildGitCommitArgs(commitMsg, identity) {
  const args = [];
  if (identity?.name && identity.email) {
    args.push("-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`);
  }
  args.push("commit");
  if (identity?.name && identity.email) {
    args.push("--author", `${identity.name} <${identity.email}>`);
  }
  args.push("-m", commitMsg);
  return args;
}
// packages/shared/src/tooling.ts
var KNOWN_TOOL_NAMES = new Set([
  "bun",
  "codex",
  "docker",
  "gh",
  "git",
  "node",
  "npm",
  "python",
  "shell"
]);
var DEFAULT_TOOL_REGISTRY = {
  fallbackKind: "discovered",
  adapters: [
    { tool: "git", kind: "known", executableHints: ["git"], defaultEffects: ["read", "write", "git"] },
    { tool: "codex", kind: "known", executableHints: ["codex", "bunx @openai/codex"], defaultEffects: ["read", "write", "network", "process"] },
    { tool: "bun", kind: "known", executableHints: ["bun"], defaultEffects: ["read", "write", "process"] },
    { tool: "docker", kind: "known", executableHints: ["docker"], defaultEffects: ["read", "write", "network", "process"] },
    { tool: "gh", kind: "known", executableHints: ["gh"], defaultEffects: ["read", "write", "network"] },
    { tool: "node", kind: "known", executableHints: ["node"], defaultEffects: ["read", "write", "process"] },
    { tool: "shell", kind: "shell", executableHints: ["sh", "bash", "cmd", "powershell"], defaultEffects: ["read", "write", "process"] }
  ]
};
var TOOL_RUN_TAIL_CHARS = 8000;
function cleanText(value) {
  return String(value ?? "").trim();
}
function basename(command) {
  const trimmed = command.trim();
  const withoutQuotes = trimmed.replace(/^["']|["']$/g, "");
  const parts = withoutQuotes.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuotes;
}
function truncateToolText(value, maxChars = TOOL_RUN_TAIL_CHARS) {
  const text = cleanText(value);
  if (!text)
    return "";
  if (text.length <= maxChars)
    return text;
  return `...[truncated]...
${text.slice(-maxChars)}`;
}
function redactToolText(value) {
  const text = cleanText(value);
  if (!text)
    return "";
  return text.replace(/\b(OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|PUSHPALS_AUTH_TOKEN)=([^\s]+)/gi, "$1=[redacted]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]").replace(/\b(ghp|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]").replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]");
}
function normalizeToolName(tool) {
  const raw = cleanText(tool).toLowerCase();
  if (!raw)
    return "shell";
  if (raw.includes("@openai/codex") || raw.includes("openai_codex"))
    return "codex";
  const name = basename(raw).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (name === "bunx")
    return "bun";
  if (name === "python3")
    return "python";
  if (name === "pwsh" || name === "powershell" || name === "bash" || name === "sh" || name === "cmd") {
    return "shell";
  }
  return name || "shell";
}
function resolveToolKind(tool, registry = DEFAULT_TOOL_REGISTRY) {
  const normalized = normalizeToolName(tool);
  const adapter = registry.adapters.find((entry) => normalizeToolName(entry.tool) === normalized);
  if (adapter)
    return adapter.kind;
  return KNOWN_TOOL_NAMES.has(normalized) ? "known" : registry.fallbackKind;
}
function inferToolNameFromFailureText(input) {
  const explicit = normalizeToolName(input.tool);
  if (explicit !== "shell")
    return explicit;
  const argv = Array.isArray(input.argv) ? input.argv : [];
  const argvText = argv.join(" ");
  const text = [
    input.commandLine,
    argvText,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr
  ].map((part) => cleanText(part).toLowerCase()).filter(Boolean).join(`
`);
  if (text.includes("failed to sync branch before push") || text.includes("tracked .codex path blocks branch sync") || text.includes("untracked working tree files would be overwritten") || text.includes("git pull --rebase") || text.includes("could not detach head") || text.includes("could not apply")) {
    return "git";
  }
  if (text.includes("@openai/codex") || text.includes("openai_codex") || /\bcodex\b/.test(text)) {
    return "codex";
  }
  if (/\bgit\b/.test(text) || /\b(rebase|cherry-pick|checkout|merge conflict)\b/.test(text)) {
    return "git";
  }
  if (/\bdocker\b/.test(text) || text.includes("docker_engine"))
    return "docker";
  if (/\bgh\b/.test(text) || text.includes("github api"))
    return "gh";
  if (/\bbun\b/.test(text))
    return "bun";
  if (/\bnode\b/.test(text))
    return "node";
  return "shell";
}
function combinedFailureText(input) {
  return [
    input.tool,
    input.argv?.join(" "),
    input.commandLine,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr
  ].map(cleanText).filter(Boolean).join(`
`);
}
function hasNodeEnvRuntimeFailure(text) {
  return /env:\s*[`'"\u2018\u2019\u201c\u201d]?node[`'"\u2018\u2019\u201c\u201d]?:?\s+no such file or directory/i.test(text) || /\bnode:\s+not found\b/i.test(text) || /\bnode\.exe.*not found\b/i.test(text);
}
function classifyToolFailure(input) {
  const tool = inferToolNameFromFailureText(input);
  const text = combinedFailureText(input);
  const lower = text.toLowerCase();
  if (input.timedOut || lower.includes("timed out") || lower.includes("timeout")) {
    return {
      failureClass: "timeout",
      retryable: true,
      remediation: "Retry with a larger tool budget or reduce the command scope."
    };
  }
  if (hasNodeEnvRuntimeFailure(text)) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: tool === "codex" ? "Codex was invoked through a launcher that requires node, but node is absent in this environment. Use a Bun-backed Codex launcher or install node in the sandbox image." : "Install the missing node runtime or invoke the tool through a runtime available in this environment."
    };
  }
  if (lower.includes("requires a newer version of codex") || lower.includes("requires newer") && lower.includes("codex")) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Upgrade the Codex CLI/runtime used by PushPals before retrying this model."
    };
  }
  if (lower.includes("docker_engine") || lower.includes("cannot connect to the docker daemon") || lower.includes("docker daemon is not running") || lower.includes("failed to connect to the docker api") && lower.includes("docker")) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Start Docker Desktop/the Docker daemon, then retry the Docker-backed operation."
    };
  }
  if (lower.includes("command-router") || lower.includes("policy rejection") || lower.includes("policy denied") || lower.includes("disallowed command") || lower.includes("command policy")) {
    return {
      failureClass: "policy_denied",
      retryable: false,
      remediation: "Adjust the tool invocation to comply with the configured command policy."
    };
  }
  if (lower.includes("login is required") || lower.includes("not logged in") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("api_key auth requires")) {
    return {
      failureClass: "auth",
      retryable: false,
      remediation: `Authenticate ${tool} or provide the required token before retrying.`
    };
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("failed to connect") || lower.includes("connection reset") || lower.includes("network is unreachable")) {
    return {
      failureClass: "network",
      retryable: true,
      remediation: "Retry after the dependent service or network path is available."
    };
  }
  if (lower.includes("read-only file system") || lower.includes("mounted read-only") || lower.includes("operation not permitted") || lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) {
    const sandboxMount = lower.includes("read-only") || lower.includes("mounted");
    return {
      failureClass: sandboxMount ? "sandbox_mount" : "permission",
      retryable: false,
      remediation: sandboxMount ? "Remount the sandbox/worktree with writable metadata or move mutable tool state outside the read-only mount." : "Fix filesystem or process permissions before retrying."
    };
  }
  if (lower.includes("rebase in progress") || lower.includes("merge conflict") || lower.includes("tracked .codex path blocks branch sync") || lower.includes("untracked working tree files would be overwritten") || lower.includes("could not apply") || lower.includes("please move or remove them before you switch branches")) {
    return {
      failureClass: "repo_state",
      retryable: false,
      remediation: "Resolve the repository state conflict before retrying the same publish/sync step."
    };
  }
  if (lower.includes("command not found") || lower.includes("not recognized as an internal or external command") || lower.includes("neither bunx nor codex was found") || lower.includes("no such file or directory")) {
    return {
      failureClass: "missing_binary",
      retryable: false,
      remediation: `Install ${tool} or configure its executable path before retrying.`
    };
  }
  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return {
      failureClass: "nonzero_exit",
      retryable: false,
      remediation: `Inspect ${tool} stdout/stderr and fix the command-specific failure before retrying.`
    };
  }
  return {
    failureClass: "unknown",
    retryable: false,
    remediation: "Inspect the tool output and add a classifier if this failure mode recurs."
  };
}
function createToolRunRecordFromFailure(input) {
  const finishedAt = cleanText(input.finishedAt) || new Date().toISOString();
  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : 0;
  const finishedMs = Date.parse(finishedAt);
  const fallbackStartedAt = Number.isFinite(finishedMs) ? new Date(Math.max(0, finishedMs - durationMs)).toISOString() : new Date().toISOString();
  const startedAt = cleanText(input.startedAt) || fallbackStartedAt;
  const tool = inferToolNameFromFailureText(input);
  const classification = classifyToolFailure({ ...input, tool });
  return {
    id: input.id,
    jobId: input.jobId ?? null,
    workerId: input.workerId ?? null,
    sessionId: input.sessionId ?? null,
    phase: input.phase ?? null,
    tool,
    kind: input.kind ?? resolveToolKind(tool),
    capability: input.capability ?? null,
    envProfile: input.envProfile ?? null,
    cwd: input.cwd ?? null,
    argv: Array.isArray(input.argv) ? input.argv.map((arg) => cleanText(arg)).filter(Boolean) : [],
    commandLine: cleanText(input.commandLine) || null,
    allowedEffects: Array.isArray(input.allowedEffects) ? input.allowedEffects : [],
    ok: false,
    exitCode: typeof input.exitCode === "number" && Number.isFinite(input.exitCode) ? input.exitCode : null,
    failureClass: classification.failureClass,
    retryable: classification.retryable,
    remediation: classification.remediation,
    startedAt,
    finishedAt,
    durationMs,
    stdoutTail: truncateToolText(redactToolText(input.stdout)),
    stderrTail: truncateToolText(redactToolText(input.stderr ?? input.detail)),
    metadata: input.metadata ?? {}
  };
}
// packages/shared/src/toolchain.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, readdirSync, statSync as statSync2 } from "fs";
import { isAbsolute as isAbsolute2, join as join3, normalize, resolve as resolve4 } from "path";
var SHELL_CONTROL_TOKENS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"]);
var NODE_BACKED_CLI_NAMES = new Set([
  "astro",
  "babel",
  "cypress",
  "eslint",
  "expo",
  "jest",
  "metro",
  "next",
  "nuxt",
  "playwright",
  "react-native",
  "rollup",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "webpack"
]);
var DIRECT_TOOL_CANDIDATES = {
  bash: ["bash"],
  bun: ["bun"],
  bunx: ["bun"],
  cargo: ["cargo"],
  cc: ["cc"],
  clang: ["clang"],
  "clang++": ["clang++"],
  cmake: ["cmake"],
  cypress: ["cypress"],
  docker: ["docker"],
  eslint: ["eslint"],
  expo: ["expo"],
  gcc: ["gcc"],
  "g++": ["g++"],
  gh: ["gh"],
  go: ["go"],
  java: ["java"],
  javac: ["javac"],
  make: ["make"],
  mvn: ["mvn"],
  next: ["next"],
  ninja: ["ninja"],
  node: ["node"],
  npm: ["npm"],
  npx: ["npx"],
  playwright: ["playwright"],
  pnpm: ["pnpm"],
  powershell: ["powershell"],
  pwsh: ["pwsh"],
  python: ["python3", "python", "py"],
  python3: ["python3", "python"],
  pytest: ["python3", "python", "py"],
  rustc: ["rustc"],
  sh: ["sh"],
  tsc: ["tsc"],
  vite: ["vite"],
  vitest: ["vitest"],
  yarn: ["yarn"]
};
var BUN_OPTIONS_WITH_VALUE = new Set(["--cwd", "-C"]);
var PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set([
  "--cwd",
  "--dir",
  "--filter",
  "--prefix",
  "--workspace",
  "-C",
  "-F"
]);
function tokenizeToolchainCommand(command) {
  const input = command.trim();
  if (!input)
    return null;
  const out = [];
  let current = "";
  let quote = null;
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed)
      out.push(trimmed);
    current = "";
  };
  for (let index = 0;index < input.length; index += 1) {
    const ch = input[index] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (quote)
    return null;
  pushCurrent();
  if (out.length === 0)
    return null;
  if (out.some((token) => SHELL_CONTROL_TOKENS.has(token)))
    return null;
  return out;
}
function buildToolchainPlan(options) {
  const repoRoot = options.repoRoot;
  const nativeSignals = detectNativeSignals(repoRoot, options.maxNativeScanEntries ?? 1000);
  const requirements = [];
  for (const command of options.validationCommands) {
    requirements.push(...inferToolRequirementsForValidationCommand(repoRoot, command, nativeSignals, options.maxScriptScanChars ?? 64000));
  }
  return {
    requirements: dedupeToolRequirements(requirements),
    environmentSource: detectToolchainEnvironmentSource(repoRoot)
  };
}
function inferToolRequirementsForValidationCommand(repoRoot, command, nativeSignals = detectNativeSignals(repoRoot), maxScriptScanChars = 64000) {
  const tokens = tokenizeToolchainCommand(command);
  if (!tokens)
    return [];
  const requirements = [];
  const first = normalizeToolToken(tokens[0] ?? "");
  addDirectExecutableRequirement(requirements, first, command);
  addNodeBackedCliRequirement(requirements, first, `validation command "${command}"`, command);
  const bunSubcommand = resolveBunSubcommand(tokens);
  if (bunSubcommand?.kind === "x") {
    addNodeBackedCliRequirement(requirements, normalizeToolToken(bunSubcommand.value), `bun x package "${bunSubcommand.value}"`, command);
  }
  const script = resolvePackageScript(repoRoot, tokens);
  if (script) {
    addScriptRequirements(requirements, repoRoot, script.scriptCwd, script.script, script.detectedFrom, command, {
      maxScriptScanChars,
      depth: 0
    });
  }
  if (usesNativeBuildCommand(tokens)) {
    if (nativeSignals.hasC) {
      requirements.push({
        tool: "c-compiler",
        candidates: ["cc", "gcc", "clang"],
        reason: "native C sources may be compiled by this validation command",
        detectedFrom: nativeSignals.hasCMake ? "CMakeLists.txt/native source scan" : "Makefile/native source scan",
        requiredFor: [command]
      });
    }
    if (nativeSignals.hasCxx) {
      requirements.push({
        tool: "cxx-compiler",
        candidates: ["c++", "g++", "clang++"],
        reason: "native C++ sources may be compiled by this validation command",
        detectedFrom: nativeSignals.hasCMake ? "CMakeLists.txt/native source scan" : "Makefile/native source scan",
        requiredFor: [command]
      });
    }
  }
  return dedupeToolRequirements(requirements);
}
function requirementsForValidationCommand(plan, command) {
  return plan.requirements.filter((requirement) => requirement.requiredFor.includes(command));
}
function formatToolRequirement(requirement) {
  const candidates = requirement.candidates.length === 1 ? requirement.candidates[0] : `${requirement.tool} (${requirement.candidates.join(" or ")})`;
  return `${candidates} from ${requirement.detectedFrom}`;
}
function addDirectExecutableRequirement(requirements, tool, command) {
  const candidates = DIRECT_TOOL_CANDIDATES[tool];
  if (!candidates)
    return;
  requirements.push({
    tool: canonicalToolName(tool),
    candidates,
    reason: `validation command invokes ${tool}`,
    detectedFrom: `validation command "${command}"`,
    requiredFor: [command]
  });
}
function addNodeBackedCliRequirement(requirements, cliName, detectedFrom, command) {
  if (!NODE_BACKED_CLI_NAMES.has(cliName))
    return;
  requirements.push({
    tool: "node",
    candidates: ["node"],
    reason: `${cliName} is normally distributed as a Node.js CLI`,
    detectedFrom,
    requiredFor: [command]
  });
}
function addScriptRequirements(requirements, repoRoot, scriptCwd, script, detectedFrom, command, options) {
  const tokens = tokenizeToolchainCommand(script) ?? script.split(/\s+/).filter(Boolean);
  const first = normalizeToolToken(tokens[0] ?? "");
  if (!NODE_BACKED_CLI_NAMES.has(first)) {
    addDirectExecutableRequirement(requirements, first, command);
  }
  addNodeBackedCliRequirement(requirements, first, detectedFrom, command);
  for (const token of tokens) {
    addNodeBackedCliRequirement(requirements, normalizeToolToken(token), detectedFrom, command);
  }
  for (const scriptPath of inferReferencedScriptPaths(repoRoot, scriptCwd, tokens)) {
    const scanned = scanScriptFileForToolRequirements(requirements, repoRoot, scriptPath, command, options);
    if (scanned)
      continue;
  }
  if (/\bnode\b/.test(script)) {
    requirements.push({
      tool: "node",
      candidates: ["node"],
      reason: "package script invokes node directly",
      detectedFrom,
      requiredFor: [command]
    });
  }
  if (/\bbun\b/.test(script)) {
    requirements.push({
      tool: "bun",
      candidates: ["bun"],
      reason: "package script invokes bun",
      detectedFrom,
      requiredFor: [command]
    });
  }
}
function scanScriptFileForToolRequirements(requirements, repoRoot, scriptPath, command, options) {
  if (options.depth > 2 || !existsSync3(scriptPath))
    return false;
  let text = "";
  try {
    const stats = statSync2(scriptPath);
    if (!stats.isFile() || stats.size > options.maxScriptScanChars)
      return false;
    text = readFileSync4(scriptPath, "utf8");
  } catch {
    return false;
  }
  const detectedFrom = `${repoRelativePath(repoRoot, scriptPath)} referenced by validation command "${command}"`;
  for (const cliName of NODE_BACKED_CLI_NAMES) {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(cliName)}(?:$|[^A-Za-z0-9_-])`);
    if (pattern.test(text)) {
      addNodeBackedCliRequirement(requirements, cliName, detectedFrom, command);
    }
  }
  if (/\bnode\b/.test(text)) {
    requirements.push({
      tool: "node",
      candidates: ["node"],
      reason: "referenced validation script invokes node directly",
      detectedFrom,
      requiredFor: [command]
    });
  }
  if (/\bbun\b/.test(text)) {
    requirements.push({
      tool: "bun",
      candidates: ["bun"],
      reason: "referenced validation script invokes bun",
      detectedFrom,
      requiredFor: [command]
    });
  }
  return true;
}
function resolveBunSubcommand(tokens) {
  if (normalizeToolToken(tokens[0] ?? "") !== "bun")
    return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const bunOption = parseOptionWithValue(token, BUN_OPTIONS_WITH_VALUE, tokens[index + 1]);
    if (bunOption) {
      index += bunOption.consumed;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = normalizeToolToken(tokens[index] ?? "");
  if ((subcommand === "run" || subcommand === "x") && tokens[index + 1]) {
    return { kind: subcommand, value: tokens[index + 1] ?? "" };
  }
  return null;
}
function resolvePackageScript(repoRoot, tokens) {
  const first = normalizeToolToken(tokens[0] ?? "");
  let cwd = repoRoot;
  let scriptName = "";
  if (first === "bun") {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const bunOption = parseOptionWithValue(token, BUN_OPTIONS_WITH_VALUE, tokens[index + 1]);
      if (bunOption) {
        cwd = resolveWorkspacePath(repoRoot, bunOption.value);
        index += bunOption.consumed;
        continue;
      }
      if (token.startsWith("--")) {
        index += 1;
        continue;
      }
      break;
    }
    if (normalizeToolToken(tokens[index] ?? "") === "run") {
      scriptName = tokens[index + 1] ?? "";
    } else {
      const candidate = tokens[index] ?? "";
      if (candidate && !["install", "test", "x"].includes(normalizeToolToken(candidate))) {
        scriptName = candidate;
      }
    }
  } else if (first === "npm" || first === "pnpm" || first === "yarn") {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      const normalized = normalizeToolToken(token);
      const packageOption = parseOptionWithValue(token, packageManagerOptionsWithValue(first), tokens[index + 1]);
      if (packageOption) {
        if (packageOption.name !== "--filter" && packageOption.name !== "-F") {
          const optionCwd = resolvePackageOptionCwd(repoRoot, packageOption.name, packageOption.value);
          if (!optionCwd && isWorkspacePackageOption(packageOption.name))
            return null;
          if (optionCwd)
            cwd = optionCwd;
        }
        index += packageOption.consumed;
        continue;
      }
      if (first === "yarn" && normalized === "workspace" && tokens[index + 2]) {
        const workspaceCwd = resolveWorkspacePackageCwd(repoRoot, tokens[index + 1] ?? "");
        if (!workspaceCwd)
          return null;
        cwd = workspaceCwd;
        scriptName = tokens[index + 2] ?? "";
        break;
      }
      if (normalized === "run") {
        scriptName = tokens[index + 1] ?? "";
        break;
      }
      if (!token.startsWith("-")) {
        scriptName = normalized;
        break;
      }
      index += 1;
    }
  }
  if (!scriptName)
    return null;
  const packagePath = join3(cwd, "package.json");
  if (!existsSync3(packagePath))
    return null;
  try {
    const parsed = JSON.parse(readFileSync4(packagePath, "utf8"));
    const script = parsed.scripts?.[scriptName];
    if (typeof script !== "string" || !script.trim())
      return null;
    return {
      script,
      scriptCwd: cwd,
      detectedFrom: `${repoRelativePath(repoRoot, packagePath)} script "${scriptName}"`
    };
  } catch {
    return null;
  }
}
function inferReferencedScriptPaths(repoRoot, scriptCwd, tokens) {
  const out = [];
  const seen = new Set;
  for (const token of tokens) {
    const normalized = normalizeReferencedScriptToken(token);
    if (!normalized)
      continue;
    const resolved = isAbsolute2(normalized) ? normalized : join3(scriptCwd, normalized);
    const key = normalize(resolved);
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}
function resolveWorkspacePath(repoRoot, pathValue) {
  return isAbsolute2(pathValue) ? normalize(pathValue) : resolve4(repoRoot, pathValue);
}
function resolvePackageOptionCwd(repoRoot, optionName, optionValue) {
  if (isWorkspacePackageOption(optionName)) {
    return resolveWorkspacePackageCwd(repoRoot, optionValue);
  }
  const optionCwd = resolveWorkspacePath(repoRoot, optionValue);
  return existsSync3(join3(optionCwd, "package.json")) ? optionCwd : null;
}
function resolveWorkspacePackageCwd(repoRoot, workspaceRef) {
  const directCwd = resolveWorkspacePath(repoRoot, workspaceRef);
  if (existsSync3(join3(directCwd, "package.json")))
    return directCwd;
  for (const candidate of expandWorkspacePackageDirs(repoRoot)) {
    try {
      const parsed = JSON.parse(readFileSync4(join3(candidate, "package.json"), "utf8"));
      if (parsed.name === workspaceRef)
        return candidate;
    } catch {}
  }
  return null;
}
function expandWorkspacePackageDirs(repoRoot, maxPackages = 200) {
  const packageJsonPath = join3(repoRoot, "package.json");
  if (!existsSync3(packageJsonPath))
    return [];
  let patterns = [];
  try {
    const parsed = JSON.parse(readFileSync4(packageJsonPath, "utf8"));
    if (Array.isArray(parsed.workspaces)) {
      patterns = parsed.workspaces.filter((entry) => typeof entry === "string");
    } else if (parsed.workspaces && typeof parsed.workspaces === "object" && Array.isArray(parsed.workspaces.packages)) {
      patterns = parsed.workspaces.packages.filter((entry) => typeof entry === "string");
    }
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set;
  for (const pattern of patterns) {
    if (out.length >= maxPackages)
      break;
    for (const candidate of expandWorkspacePattern(repoRoot, pattern, maxPackages - out.length)) {
      const key = normalize(candidate);
      if (seen.has(key) || !existsSync3(join3(candidate, "package.json")))
        continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= maxPackages)
        break;
    }
  }
  return out;
}
function expandWorkspacePattern(repoRoot, pattern, maxPackages) {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalizedPattern || normalizedPattern.startsWith("!"))
    return [];
  const segments = normalizedPattern.split("/").filter(Boolean);
  let dirs = [repoRoot];
  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (next.length >= maxPackages)
        break;
      if (segment === "**") {
        next.push(...collectDescendantDirs(dir, Math.max(0, maxPackages - next.length), 3));
        continue;
      }
      if (segment.includes("*")) {
        const patternRegex = wildcardSegmentRegex(segment);
        for (const entry of safeReadDir(dir)) {
          if (next.length >= maxPackages)
            break;
          if (!patternRegex.test(entry))
            continue;
          const candidate2 = join3(dir, entry);
          if (safeIsDirectory(candidate2))
            next.push(candidate2);
        }
        continue;
      }
      const candidate = join3(dir, segment);
      if (safeIsDirectory(candidate))
        next.push(candidate);
    }
    dirs = next;
    if (dirs.length === 0)
      break;
  }
  return dirs;
}
function collectDescendantDirs(dir, limit, maxDepth) {
  const out = [];
  const visit = (current, depth) => {
    if (out.length >= limit || depth > maxDepth)
      return;
    for (const entry of safeReadDir(current)) {
      if (entry === "node_modules" || entry === ".git")
        continue;
      const candidate = join3(current, entry);
      if (!safeIsDirectory(candidate))
        continue;
      out.push(candidate);
      visit(candidate, depth + 1);
      if (out.length >= limit)
        return;
    }
  };
  visit(dir, 0);
  return out;
}
function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function safeIsDirectory(pathValue) {
  try {
    return statSync2(pathValue).isDirectory();
  } catch {
    return false;
  }
}
function wildcardSegmentRegex(segment) {
  return new RegExp(`^${segment.split("*").map(escapeRegExp).join(".*")}$`);
}
function isWorkspacePackageOption(optionName) {
  return optionName === "--workspace" || optionName === "-w";
}
function parseOptionWithValue(token, optionsWithValue, nextToken) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    const name = token.slice(0, equalsIndex);
    if (!optionsWithValue.has(name))
      return null;
    const value = token.slice(equalsIndex + 1);
    return value ? { name, value, consumed: 1 } : null;
  }
  if (!optionsWithValue.has(token) || !nextToken)
    return null;
  return { name: token, value: nextToken, consumed: 2 };
}
function packageManagerOptionsWithValue(packageManager) {
  if (packageManager === "npm") {
    return new Set([...PACKAGE_MANAGER_OPTIONS_WITH_VALUE, "-w"]);
  }
  return PACKAGE_MANAGER_OPTIONS_WITH_VALUE;
}
function normalizeReferencedScriptToken(token) {
  let normalized = token.replace(/\\/g, "/");
  if (normalized.startsWith("-")) {
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex === -1)
      return null;
    normalized = normalized.slice(equalsIndex + 1);
  }
  if (!/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(normalized))
    return null;
  if (normalized.includes("://"))
    return null;
  return normalized;
}
function detectToolchainEnvironmentSource(repoRoot) {
  if (existsSync3(join3(repoRoot, ".devcontainer", "devcontainer.json")))
    return "devcontainer";
  if (existsSync3(join3(repoRoot, "devcontainer.json")))
    return "devcontainer";
  if (existsSync3(join3(repoRoot, "Dockerfile")))
    return "dockerfile";
  if (existsSync3(join3(repoRoot, "mise.toml")) || existsSync3(join3(repoRoot, ".mise.toml"))) {
    return "mise";
  }
  if (existsSync3(join3(repoRoot, ".tool-versions")))
    return "asdf";
  if (existsSync3(join3(repoRoot, "flake.nix")) || existsSync3(join3(repoRoot, "shell.nix"))) {
    return "nix";
  }
  return "pushpals-default-sandbox";
}
function detectNativeSignals(repoRoot, maxEntries = 1000) {
  const signals = {
    hasC: false,
    hasCxx: false,
    hasMakefile: existsSync3(join3(repoRoot, "Makefile")) || existsSync3(join3(repoRoot, "makefile")) || existsSync3(join3(repoRoot, "GNUmakefile")),
    hasCMake: existsSync3(join3(repoRoot, "CMakeLists.txt"))
  };
  const ignored = new Set([
    ".git",
    ".worktrees",
    "node_modules",
    "outputs",
    "dist",
    "build",
    ".next",
    ".expo"
  ]);
  let visited = 0;
  const scan = (dir, depth) => {
    if (visited >= maxEntries || depth > 4 || signals.hasC && signals.hasCxx)
      return;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries)
        return;
      if (ignored.has(entry))
        continue;
      const fullPath = join3(dir, entry);
      visited += 1;
      let stats;
      try {
        stats = statSync2(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        scan(fullPath, depth + 1);
        continue;
      }
      const lower = entry.toLowerCase();
      if (/\.(c|h)$/.test(lower))
        signals.hasC = true;
      if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(lower))
        signals.hasCxx = true;
      if (lower === "cmakelists.txt")
        signals.hasCMake = true;
    }
  };
  scan(repoRoot, 0);
  return signals;
}
function usesNativeBuildCommand(tokens) {
  return tokens.some((token) => {
    const normalized = normalizeToolToken(token);
    return normalized === "make" || normalized === "cmake" || normalized === "ninja";
  });
}
function dedupeToolRequirements(requirements) {
  const merged = new Map;
  for (const requirement of requirements) {
    const key = requirement.tool;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...requirement,
        candidates: Array.from(new Set(requirement.candidates)),
        requiredFor: Array.from(new Set(requirement.requiredFor))
      });
      continue;
    }
    for (const candidate of requirement.candidates) {
      if (!existing.candidates.includes(candidate))
        existing.candidates.push(candidate);
    }
    for (const command of requirement.requiredFor) {
      if (!existing.requiredFor.includes(command))
        existing.requiredFor.push(command);
    }
    if (!existing.detectedFrom.includes(requirement.detectedFrom)) {
      existing.detectedFrom = `${existing.detectedFrom}; ${requirement.detectedFrom}`;
    }
    if (!existing.reason.includes(requirement.reason)) {
      existing.reason = `${existing.reason}; ${requirement.reason}`;
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.tool.localeCompare(b.tool));
}
function canonicalToolName(tool) {
  if (tool === "bunx")
    return "bun";
  if (tool === "python3" || tool === "pytest")
    return "python";
  return tool;
}
function normalizeToolToken(token) {
  const normalizedToken = token.trim().replace(/\\/g, "/").split("/").pop() ?? token;
  return normalizedToken.toLowerCase().replace(/\.(cmd|exe|ps1)$/i, "");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function repoRelativePath(repoRoot, pathValue) {
  const root = normalize(repoRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const path = normalize(pathValue).replace(/\\/g, "/");
  if (path.startsWith(`${root}/`))
    return path.slice(root.length + 1);
  return path;
}
// packages/shared/src/trusted_validation.ts
var TRUSTED_VALIDATION_EXECUTABLES = new Set([
  "bun",
  "bunx",
  "cargo",
  "coverage",
  "deno",
  "docker",
  "docker-compose",
  "eslint",
  "go",
  "jest",
  "make",
  "mypy",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "ruff",
  "tsc",
  "uv",
  "vitest",
  "yarn"
]);
// packages/shared/src/session_event_visibility.ts
var ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/workerpals/src/backends/backend_config.ts
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "fs";
import { join as join7 } from "path";

// apps/workerpals/src/common/generic_python_executor.ts
import { existsSync as existsSync5 } from "fs";
import { dirname as dirname2, join as join6, resolve as resolve6 } from "path";

// apps/workerpals/src/common/execution_utils.ts
var DEFAULT_CONFIG = loadPushPalsConfig();
function resolveOutputCompactionPolicy(overrides = {}) {
  const worker = DEFAULT_CONFIG.workerpals;
  const maxOutputChars = Number(overrides.maxOutputChars ?? worker.outputMaxChars);
  const maxOutputLines = Number(overrides.maxOutputLines ?? worker.outputMaxLines);
  const maxOutputHeadLines = Number(overrides.maxOutputHeadLines ?? worker.outputMaxHeadLines);
  const executorResultPrefixRaw = overrides.executorResultPrefix ?? worker.executorResultPrefix;
  const executorResultPrefix = typeof executorResultPrefixRaw === "string" && executorResultPrefixRaw.length > 0 ? executorResultPrefixRaw : "__PUSHPALS_OH_RESULT__ ";
  return {
    maxOutputChars: Number.isFinite(maxOutputChars) && maxOutputChars >= 8192 ? Math.min(Math.floor(maxOutputChars), 4194304) : 192 * 1024,
    maxOutputLines: Number.isFinite(maxOutputLines) && maxOutputLines >= 50 ? Math.min(Math.floor(maxOutputLines), 20000) : 600,
    maxOutputHeadLines: Number.isFinite(maxOutputHeadLines) && maxOutputHeadLines >= 1 ? Math.max(1, Math.min(Math.floor(maxOutputHeadLines), Math.floor(maxOutputLines) || 600)) : 120,
    executorResultPrefix
  };
}
function compactJobOutput(text, policyOverrides = {}) {
  if (!text)
    return "";
  const policy = resolveOutputCompactionPolicy(policyOverrides);
  const maxOutputChars = policy.maxOutputChars;
  const maxOutputLines = policy.maxOutputLines;
  const maxOutputHeadLines = Math.min(policy.maxOutputHeadLines, maxOutputLines);
  let compact = text;
  const lines = compact.split(/\r?\n/);
  if (lines.length > maxOutputLines) {
    const headCount = Math.min(maxOutputHeadLines, maxOutputLines, lines.length);
    const tailBudget = Math.max(0, maxOutputLines - headCount);
    const tailCount = Math.max(0, Math.min(lines.length - headCount, tailBudget));
    const omitted = Math.max(0, lines.length - headCount - tailCount);
    const marker = omitted > 0 ? [`... (${omitted} lines omitted) ...`] : [];
    const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
    compact = [...lines.slice(0, headCount), ...marker, ...tail].join(`
`);
  }
  if (compact.length > maxOutputChars) {
    const markerPrefix = "... (";
    const markerSuffix = ` chars omitted) ...
`;
    const markerBudget = markerPrefix.length + markerSuffix.length + 20;
    if (markerBudget >= maxOutputChars) {
      compact = compact.slice(-maxOutputChars);
    } else {
      const keepChars = Math.max(0, maxOutputChars - markerBudget);
      const omittedChars = Math.max(0, compact.length - keepChars);
      const marker = `${markerPrefix}${omittedChars}${markerSuffix}`;
      const tail = keepChars > 0 ? compact.slice(-keepChars) : "";
      compact = `${marker}${tail}`;
    }
  }
  return compact;
}
function truncate(s, policyOverrides = {}) {
  return compactJobOutput(s, policyOverrides);
}
async function streamLines(readable, streamName, onLine) {
  const decoder = new TextDecoder;
  const reader = readable.getReader();
  let full = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;
    const lines = buffer.split(`
`);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      onLine(streamName, clean);
    }
  }
  if (buffer.length > 0) {
    const clean = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    onLine(streamName, clean);
  }
  return full;
}
function parseStructuredResult(stdout, executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1;i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(executorResultPrefix))
      continue;
    const raw = line.slice(executorResultPrefix.length).trim();
    if (!raw)
      continue;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}
function filterResultLines(stdout, executorResultPrefix = resolveOutputCompactionPolicy().executorResultPrefix) {
  return stdout.split(/\r?\n/).filter((line) => !line.trim().startsWith(executorResultPrefix)).join(`
`).trim();
}

// apps/workerpals/src/common/sandbox_env.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync5, writeFileSync } from "fs";
import { homedir as homedir2, tmpdir as tmpdir2 } from "os";
import { basename as basename2, dirname, join as join4, resolve as resolve5 } from "path";

// apps/workerpals/src/common/direct_worktree.ts
import { createHash } from "crypto";
import { homedir, tmpdir } from "os";
import { posix, win32 } from "path";
var WINDOWS_DIRECT_WORKTREE_ROOT_NAME = ".ppw";
var LEGACY_WINDOWS_DIRECT_WORKTREE_ROOT_NAME = "ppw";
function pathApi(platform) {
  return platform === "win32" ? win32 : posix;
}
function normalizeForComparison(value, platform) {
  const normalized = pathApi(platform).resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
function repoKey(repo, platform) {
  return createHash("sha256").update(normalizeForComparison(repo, platform)).digest("hex").slice(0, 12);
}
function resolveDirectWorktreeRoot(repo, platform = process.platform, homeRoot = homedir()) {
  const path = pathApi(platform);
  if (platform !== "win32")
    return path.resolve(repo, ".worktrees");
  return path.resolve(homeRoot, WINDOWS_DIRECT_WORKTREE_ROOT_NAME, repoKey(repo, platform));
}
function resolveDirectWorktreePath(repo, jobId, nonce, platform = process.platform, homeRoot = homedir()) {
  const safeJobId = jobId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "host";
  const safeNonce = nonce.toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 16) || "run";
  return pathApi(platform).resolve(resolveDirectWorktreeRoot(repo, platform, homeRoot), `job-${safeJobId}-${safeNonce}`);
}
function directWorktreePoolRoot(worktreePath, platform = process.platform) {
  const path = pathApi(platform);
  const leaf = path.basename(worktreePath);
  const poolRoot = path.dirname(worktreePath);
  if (!/^job-[a-z0-9][a-z0-9-]*$/i.test(leaf))
    return;
  if (!/^[a-f0-9]{12}$/i.test(path.basename(poolRoot)))
    return;
  const rootName = path.basename(path.dirname(poolRoot)).toLowerCase();
  if (rootName !== WINDOWS_DIRECT_WORKTREE_ROOT_NAME && rootName !== LEGACY_WINDOWS_DIRECT_WORKTREE_ROOT_NAME) {
    return;
  }
  return normalizeForComparison(poolRoot, platform);
}

// apps/workerpals/src/common/sandbox_env.ts
var WINDOWS_WORKER_SANDBOX_ROOT_NAME = ".ppe";
var TEMP_WORKER_SANDBOX_ROOT_NAME = "pushpals-worker-env";
var WINDOWS_PLAYWRIGHT_CACHE_NAME = "pw";
var TEMP_PLAYWRIGHT_CACHE_NAME = "playwright-browsers";
function stringEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string")
      env[key] = value;
  }
  return env;
}
function pathListDelimiter(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}
function commandLeaf(value) {
  return (value.trim().replace(/\\/g, "/").split("/").pop() ?? value).toLowerCase();
}
function isBunCommandPath(value) {
  const leaf = commandLeaf(value);
  return leaf === "bun" || leaf === "bun.exe" || leaf === "bun.cmd" || leaf === "bun.bat";
}
function normalizePathEnv(env, platform = process.platform) {
  const out = { ...env };
  const pathValue = platform === "win32" ? String(out.PATH ?? out.Path ?? "").trim() : String(out.PATH ?? "").trim();
  if (pathValue) {
    out.PATH = pathValue;
    if (platform === "win32")
      out.Path = pathValue;
  }
  return out;
}
function resolveBunExecutableFromEnv(sourceEnv, platform = process.platform, currentExecPathOverride = process.execPath) {
  const env = normalizePathEnv(stringEnv(sourceEnv), platform);
  const explicit = String(env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit && isBunCommandPath(explicit))
    return explicit;
  const currentExecPath = String(currentExecPathOverride ?? "").trim();
  if (currentExecPath && isBunCommandPath(currentExecPath))
    return currentExecPath;
  const pathValue = platform === "win32" ? String(env.PATH ?? env.Path ?? "").trim() : String(env.PATH ?? "").trim();
  if (!pathValue)
    return "";
  const candidates = platform === "win32" ? ["bun.exe", "bun", "bun.cmd", "bun.bat"] : ["bun"];
  for (const rawDir of pathValue.split(pathListDelimiter(platform))) {
    const dir = rawDir.trim();
    if (!dir)
      continue;
    for (const candidate of candidates) {
      const fullPath = join4(dir, candidate);
      if (existsSync4(fullPath))
        return fullPath;
    }
  }
  return "";
}
function commandDirectory(value) {
  if (!/[\\/]/.test(value))
    return "";
  return dirname(value);
}
function withResolvedBunOnPath(sourceEnv, platform = process.platform, currentExecPathOverride = process.execPath) {
  const env = normalizePathEnv(stringEnv(sourceEnv), platform);
  const bunBin = resolveBunExecutableFromEnv(env, platform, currentExecPathOverride);
  if (!bunBin)
    return env;
  const out = {
    ...env,
    PUSHPALS_BUN_BIN: bunBin
  };
  const bunDir = commandDirectory(bunBin);
  if (!bunDir)
    return out;
  const delimiter = pathListDelimiter(platform);
  const existing = String(out.PATH ?? out.Path ?? "").trim();
  const existingParts = existing.split(delimiter).map((part) => part.trim()).filter(Boolean);
  const alreadyPresent = existingParts.some((part) => platform === "win32" ? part.toLowerCase() === bunDir.toLowerCase() : part === bunDir);
  const nextPath = alreadyPresent ? existing : [bunDir, ...existingParts].join(delimiter);
  out.PATH = nextPath;
  if (platform === "win32")
    out.Path = nextPath;
  return out;
}
function safeRepoSlug(repo, platform = process.platform) {
  const leaf = basename2(resolve5(repo)).replace(/[^A-Za-z0-9_.-]+/g, "-") || "repo";
  const resolvedRepo = resolve5(repo);
  const hashInput = platform === "win32" ? resolvedRepo.replace(/\\/g, "/").toLowerCase() : resolvedRepo;
  const hash = createHash2("sha256").update(hashInput).digest("hex").slice(0, 12);
  if (platform === "win32")
    return hash;
  return `${leaf}-${hash}`;
}
function browserCacheRepoKey(repo, platform = process.platform) {
  const normalized = resolve5(repo).replace(/\\/g, "/");
  const marker = "/.worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0)
    return normalized.slice(0, markerIndex);
  return directWorktreePoolRoot(repo, platform) ?? resolve5(repo);
}
function resolveWorkerSandboxRoot(repo, platform = process.platform, homeRoot = homedir2(), tempRoot = tmpdir2()) {
  const parent = platform === "win32" ? resolve5(homeRoot, WINDOWS_WORKER_SANDBOX_ROOT_NAME) : resolve5(tempRoot, TEMP_WORKER_SANDBOX_ROOT_NAME);
  return resolve5(parent, safeRepoSlug(repo, platform));
}
function defaultExpoPortForRepo(repo) {
  const hashPrefix = createHash2("sha256").update(resolve5(repo)).digest("hex").slice(0, 8);
  const offset = Number.parseInt(hashPrefix, 16) % 1000;
  return String(19006 + offset);
}
function resolveExpoRouterAppRoot(repo) {
  try {
    const packageJson = JSON.parse(readFileSync5(resolve5(repo, "package.json"), "utf8"));
    const usesExpoRouter = typeof packageJson.main === "string" && packageJson.main.includes("expo-router") || packageJson.dependencies?.["expo-router"] !== undefined || packageJson.devDependencies?.["expo-router"] !== undefined;
    if (!usesExpoRouter)
      return;
    for (const candidate of [resolve5(repo, "src", "app"), resolve5(repo, "app")]) {
      if (existsSync4(candidate))
        return candidate;
    }
  } catch {}
  return;
}
function ensureDirs(paths) {
  for (const path of paths) {
    try {
      mkdirSync(path, { recursive: true });
    } catch {}
  }
}
function ensureSandboxGitConfig(homeDir) {
  const gitConfigPath = resolve5(homeDir, ".gitconfig");
  try {
    const existing = existsSync4(gitConfigPath) ? readFileSync5(gitConfigPath, "utf8") : "";
    if (/(^|\n)\s*directory\s*=\s*\*/.test(existing))
      return;
    const prefix = existing.trim() ? `${existing.replace(/\s+$/, "")}

` : "";
    writeFileSync(gitConfigPath, `${prefix}[safe]
	directory = *
`, "utf8");
  } catch {}
}
function withWorkerNodeOptions(value) {
  const options = (value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!options.some((option) => option.startsWith("--dns-result-order="))) {
    options.push("--dns-result-order=ipv4first");
  }
  return options.join(" ");
}
function withWorkerNodePath(repo, value, platform = process.platform) {
  const delimiter = pathListDelimiter(platform);
  const jobNodeModules = resolve5(repo, "node_modules");
  const existing = (value ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const remaining = existing.filter((entry) => !(platform === "win32" ? resolve5(entry).toLowerCase() === jobNodeModules.toLowerCase() : resolve5(entry) === jobNodeModules));
  return [jobNodeModules, ...remaining].join(delimiter);
}
function resolveOriginalHome(env) {
  return env.HOME || env.USERPROFILE || homedir2();
}
function resolveCodexHome(env, originalHome) {
  if (env.CODEX_HOME)
    return env.CODEX_HOME;
  const defaultCodexHome = resolve5(originalHome, ".codex");
  return existsSync4(defaultCodexHome) ? defaultCodexHome : undefined;
}
function buildWorkerSandboxWritableEnv(repo, sourceEnv = process.env, platform = process.platform) {
  const env = withResolvedBunOnPath(sourceEnv);
  const originalHome = resolveOriginalHome(env);
  const sandboxHomeRoot = platform === "win32" ? env.USERPROFILE || originalHome : originalHome;
  const codexHome = resolveCodexHome(env, originalHome);
  const baseDir = resolveWorkerSandboxRoot(repo, platform, sandboxHomeRoot);
  const homeDir = resolve5(baseDir, "home");
  const cacheDir = resolve5(baseDir, "cache");
  const expoDir = resolve5(baseDir, "expo");
  const tempDir = resolve5(baseDir, "tmp");
  const configDir = resolve5(baseDir, "config");
  const roamingDir = resolve5(baseDir, "roaming");
  const localAppDataDir = resolve5(baseDir, "local");
  const powershellAnalysisCachePath = resolve5(localAppDataDir, "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache");
  const playwrightBrowsersDir = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? env.PLAYWRIGHT_BROWSERS_PATH : resolve5(resolveWorkerSandboxRoot(browserCacheRepoKey(repo, platform), platform, sandboxHomeRoot), platform === "win32" ? WINDOWS_PLAYWRIGHT_CACHE_NAME : TEMP_PLAYWRIGHT_CACHE_NAME);
  const defaultExpoPort = defaultExpoPortForRepo(repo);
  const expoRouterAppRoot = resolveExpoRouterAppRoot(repo);
  ensureDirs([
    homeDir,
    cacheDir,
    expoDir,
    tempDir,
    configDir,
    ...platform === "win32" ? [roamingDir, localAppDataDir] : [],
    ...platform === "win32" ? [dirname(powershellAnalysisCachePath)] : [],
    resolve5(cacheDir, "npm"),
    playwrightBrowsersDir
  ]);
  ensureSandboxGitConfig(homeDir);
  return {
    ...env,
    ...codexHome ? { CODEX_HOME: codexHome } : {},
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    ...platform === "win32" ? {
      APPDATA: roamingDir,
      LOCALAPPDATA: localAppDataDir,
      PSModuleAnalysisCachePath: powershellAnalysisCachePath
    } : {},
    npm_config_cache: resolve5(cacheDir, "npm"),
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH ?? playwrightBrowsersDir,
    EXPO_HOME: expoDir,
    EXPO_NO_TELEMETRY: env.EXPO_NO_TELEMETRY ?? "1",
    EXPO_NO_INTERACTIVE: env.EXPO_NO_INTERACTIVE ?? "1",
    CI: env.CI ?? "1",
    BROWSER: env.BROWSER ?? "none",
    ...expoRouterAppRoot ? {
      EXPO_ROUTER_APP_ROOT: expoRouterAppRoot,
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir
    } : {},
    NODE_OPTIONS: withWorkerNodeOptions(env.NODE_OPTIONS),
    NODE_PATH: withWorkerNodePath(repo, env.NODE_PATH),
    REACT_NATIVE_PACKAGER_HOSTNAME: env.REACT_NATIVE_PACKAGER_HOSTNAME ?? "127.0.0.1",
    EXPO_DEV_SERVER_PORT: env.EXPO_DEV_SERVER_PORT ?? defaultExpoPort,
    RCT_METRO_PORT: env.RCT_METRO_PORT ?? defaultExpoPort,
    PUSHPALS_VALIDATION_REPO: repo
  };
}

// apps/workerpals/src/common/python_payload_transport.ts
import { mkdtempSync, rmSync, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { join as join5 } from "path";
function createPythonPayloadTransport(payloadBase64) {
  const dir = mkdtempSync(join5(tmpdir3(), "pushpals-python-payload-"));
  const filePath = join5(dir, "payload.b64");
  writeFileSync2(filePath, payloadBase64, { encoding: "utf8", mode: 384 });
  let cleaned = false;
  return {
    args: ["--payload-file", filePath],
    filePath,
    cleanup: () => {
      if (cleaned)
        return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// apps/workerpals/src/common/generic_python_executor.ts
var BACKEND_TIMEOUT_RESULT_GRACE_MS = 30000;
var OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS = 240000;
var OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS = 720000;
var OPENAI_CODEX_MIN_PRIMARY_TURN_BUDGET_MS = 540000;
var OPENAI_CODEX_VALIDATION_RESERVE_RATIO = 0.25;
function estimateTokensFromText(text) {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}
function estimateJobTokenUsage(backendName, modelId, params, summary, stdout, stderr) {
  const promptSource = (() => {
    try {
      return JSON.stringify(params);
    } catch {
      return String(params?.instruction ?? params?.prompt ?? "");
    }
  })();
  const completionSource = [summary, stdout, stderr].filter(Boolean).join(`

`);
  const promptTokens = estimateTokensFromText(promptSource);
  const completionTokens = estimateTokensFromText(completionSource);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
    backend: backendName,
    modelId
  };
}
function coerceJobTokenUsage(value, fallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const raw = value;
  const promptTokens = Number(raw.promptTokens ?? raw.prompt_tokens);
  const completionTokens = Number(raw.completionTokens ?? raw.completion_tokens);
  const totalTokens = Number(raw.totalTokens ?? raw.total_tokens);
  const hasPrompt = Number.isFinite(promptTokens) && promptTokens >= 0;
  const hasCompletion = Number.isFinite(completionTokens) && completionTokens >= 0;
  const hasTotal = Number.isFinite(totalTokens) && totalTokens >= 0;
  if (!hasPrompt && !hasCompletion && !hasTotal) {
    return fallback;
  }
  const normalizedPrompt = hasPrompt ? Math.round(promptTokens) : hasTotal ? Math.max(0, Math.round(totalTokens) - fallback.completionTokens) : fallback.promptTokens;
  const normalizedCompletion = hasCompletion ? Math.round(completionTokens) : hasTotal ? Math.max(0, Math.round(totalTokens) - normalizedPrompt) : fallback.completionTokens;
  const normalizedTotal = hasTotal ? Math.round(totalTokens) : normalizedPrompt + normalizedCompletion;
  return {
    promptTokens: normalizedPrompt,
    completionTokens: normalizedCompletion,
    totalTokens: normalizedTotal,
    estimated: typeof raw.estimated === "boolean" ? raw.estimated : false,
    backend: typeof raw.backend === "string" && raw.backend.trim().length > 0 ? raw.backend.trim() : fallback.backend,
    modelId: typeof raw.modelId === "string" && raw.modelId.trim().length > 0 ? raw.modelId.trim() : fallback.modelId
  };
}
function resolveRuntimeSettings(config, runtimeConfig) {
  const workerCfg = runtimeConfig.workerpals;
  const rawPython = String(workerCfg[config.pythonConfigKey] ?? "python");
  const pythonBin = rawPython.includes("/") || rawPython.includes("\\") ? resolve6(runtimeConfig.projectRoot, rawPython) : rawPython;
  const rawTimeout = Number(workerCfg[config.timeoutConfigKey]);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(1e4, Math.floor(rawTimeout)) : 300000;
  return { pythonBin, timeoutMs };
}
function resolveGenericPythonExecutorTimeoutMs(params) {
  const configuredTimeoutMs = Math.max(1e4, Math.floor(params.configuredTimeoutMs));
  const executionBudgetMs = typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs) ? Math.max(1e4, Math.floor(params.executionBudgetMs)) : null;
  const finalizationBudgetMs = typeof params.finalizationBudgetMs === "number" && Number.isFinite(params.finalizationBudgetMs) ? Math.max(0, Math.floor(params.finalizationBudgetMs)) : 0;
  if (executionBudgetMs != null && params.capTimeoutToExecutionBudget !== false) {
    return Math.min(configuredTimeoutMs, executionBudgetMs + finalizationBudgetMs);
  }
  return configuredTimeoutMs;
}
function resolveOpenAICodexValidationReserveMs(executionBudgetMs) {
  if (typeof executionBudgetMs !== "number" || !Number.isFinite(executionBudgetMs))
    return 0;
  const budgetMs = Math.max(1e4, Math.floor(executionBudgetMs));
  const targetReserveMs = Math.floor(Math.min(budgetMs, Math.max(OPENAI_CODEX_MIN_VALIDATION_RESERVE_MS, Math.min(OPENAI_CODEX_MAX_VALIDATION_RESERVE_MS, budgetMs * OPENAI_CODEX_VALIDATION_RESERVE_RATIO))));
  const maxReserveAfterPrimaryTurn = Math.max(0, budgetMs - OPENAI_CODEX_MIN_PRIMARY_TURN_BUDGET_MS);
  return Math.max(0, Math.min(targetReserveMs, maxReserveAfterPrimaryTurn));
}
function resolveGenericPythonExecutorChildTimeoutMs(params) {
  const hostTimeoutMs = Math.max(1e4, Math.floor(params.hostTimeoutMs));
  if (params.backendName !== "openai_codex")
    return null;
  const executionBudgetMs = typeof params.executionBudgetMs === "number" && Number.isFinite(params.executionBudgetMs) ? Math.max(1e4, Math.floor(params.executionBudgetMs)) : null;
  const validationReserveMs = resolveOpenAICodexValidationReserveMs(executionBudgetMs);
  const childBudgetMs = executionBudgetMs == null ? hostTimeoutMs : Math.min(hostTimeoutMs, Math.max(1000, executionBudgetMs - validationReserveMs));
  const graceMs = Math.min(BACKEND_TIMEOUT_RESULT_GRACE_MS, Math.max(2000, Math.floor(childBudgetMs / 10)));
  return Math.max(1000, childBudgetMs - graceMs);
}
function toSnakeConfigKey(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function formatGenericPythonExecutorTimeoutDetail(config, configuredTimeoutMs, executionBudgetMs, finalizationBudgetMs, timeoutMs) {
  const configPath = `workerpals.${toSnakeConfigKey(config.timeoutConfigKey)}`;
  if (executionBudgetMs == null) {
    return `${configPath}=${configuredTimeoutMs}ms`;
  }
  if (config.capTimeoutToExecutionBudget === false) {
    return `${configPath}=${configuredTimeoutMs}ms; planning executionBudgetMs=${executionBudgetMs}ms ignored by backend opt-out`;
  }
  if (timeoutMs < configuredTimeoutMs) {
    const finalizationDetail = finalizationBudgetMs && finalizationBudgetMs > 0 ? ` + finalizationBudgetMs=${finalizationBudgetMs}ms` : "";
    return `${configPath}=${configuredTimeoutMs}ms capped by planning executionBudgetMs=${executionBudgetMs}ms${finalizationDetail}`;
  }
  return `${configPath}=${configuredTimeoutMs}ms within planning executionBudgetMs=${executionBudgetMs}ms`;
}
function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
function resolveGenericPythonExecutorScriptPath(config, runtimeConfig) {
  const candidates = [];
  if (config.scriptSegments && config.scriptSegments.length > 0) {
    const runtimeRoot = dirname2(runtimeConfig.configDir);
    candidates.push(join6(runtimeRoot, "sandbox", ...config.scriptSegments));
    candidates.push(config.scriptPath);
    candidates.push(join6(runtimeRoot, ...config.scriptSegments));
    candidates.push(join6(runtimeConfig.projectRoot, ...config.scriptSegments));
  } else {
    candidates.push(config.scriptPath);
  }
  const uniqueCandidates = uniqueStrings(candidates.map((candidate) => resolve6(candidate)));
  return {
    scriptPath: uniqueCandidates.find((candidate) => existsSync5(candidate)) ?? null,
    candidates: uniqueCandidates
  };
}
function normalizeGenericPythonExecutorParsedResultForTimeout(params) {
  const signalTerminatedCodex = params.timedOut && params.backendName === "openai_codex" && /\bopenai_codex interrupted by signal 15\b/i.test(params.summary);
  if (!signalTerminatedCodex) {
    return {
      summary: params.summary,
      stdout: params.stdout,
      stderr: params.stderr,
      exitCode: params.exitCode
    };
  }
  const timeoutDetail = String(params.timeoutDetail ?? "").trim();
  const cleanedStderr = String(params.stderr ?? "").replace(/\bopenai_codex interrupted by signal 15\b/gi, "OpenAI Codex exceeded the execution budget").trim();
  const stderr = [
    `OpenAI Codex exceeded the PushPals execution budget before returning a completed result.`,
    timeoutDetail ? `Timeout detail: ${timeoutDetail}.` : "",
    cleanedStderr ? `Last stderr:
${cleanedStderr}` : ""
  ].filter(Boolean).join(`
`);
  return {
    summary: `${params.backendName} execution budget expired after ${params.timeoutMs}ms for ${params.kind}`,
    stdout: params.stdout,
    stderr,
    exitCode: 124
  };
}
function createGenericPythonExecutor(config) {
  const { backendName } = config;
  const backendLabel = backendName[0].toUpperCase() + backendName.slice(1);
  return async (kind, params, repo, runtimeConfig, onLog, budgets) => {
    const resolvedScript = resolveGenericPythonExecutorScriptPath(config, runtimeConfig);
    const scriptPath = resolvedScript.scriptPath;
    if (scriptPath == null) {
      return {
        ok: false,
        summary: `${backendName} wrapper script not found`,
        stderr: `Checked wrapper script path(s): ${resolvedScript.candidates.join("; ")}`,
        exitCode: 1
      };
    }
    const { pythonBin, timeoutMs: configuredTimeoutMs } = resolveRuntimeSettings(config, runtimeConfig);
    const modelId = runtimeConfig.workerpals.llm.model.trim();
    const executionBudgetMs = typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs) ? Math.max(1e4, Math.floor(budgets.executionBudgetMs)) : null;
    const finalizationBudgetMs = typeof budgets?.finalizationBudgetMs === "number" && Number.isFinite(budgets.finalizationBudgetMs) ? Math.max(0, Math.floor(budgets.finalizationBudgetMs)) : null;
    const timeoutMs = resolveGenericPythonExecutorTimeoutMs({
      configuredTimeoutMs,
      executionBudgetMs,
      finalizationBudgetMs,
      capTimeoutToExecutionBudget: config.capTimeoutToExecutionBudget
    });
    const timeoutDetail = formatGenericPythonExecutorTimeoutDetail(config, configuredTimeoutMs, executionBudgetMs, finalizationBudgetMs, timeoutMs);
    const payloadBase64 = Buffer.from(JSON.stringify({
      kind,
      params,
      repo
    }), "utf-8").toString("base64");
    const childTimeoutMs = resolveGenericPythonExecutorChildTimeoutMs({
      backendName,
      hostTimeoutMs: timeoutMs,
      executionBudgetMs
    });
    const childTimeoutEnv = childTimeoutMs == null ? {} : {
      WORKERPALS_OPENAI_CODEX_TIMEOUT_MS: String(childTimeoutMs),
      WORKERPALS_OPENAI_CODEX_TIMEOUT_S: String(Math.max(1, Math.floor(childTimeoutMs / 1000)))
    };
    const childTimeoutDetail = childTimeoutMs != null ? `; codex_child_timeout=${childTimeoutMs}ms; reserved_validation_budget=${resolveOpenAICodexValidationReserveMs(executionBudgetMs)}ms` : "";
    let payloadTransport = null;
    try {
      payloadTransport = createPythonPayloadTransport(payloadBase64);
      const args = [pythonBin, scriptPath, ...payloadTransport.args];
      onLog?.("stdout", `[${backendLabel}Executor] Spawning ${backendName} executor (timeout=${timeoutMs}ms; ${timeoutDetail}${childTimeoutDetail})`);
      const outputPolicy = {
        maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
        maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
        maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
        executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix
      };
      const proc = Bun.spawn(args, {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...buildWorkerSandboxWritableEnv(repo),
          ...childTimeoutEnv,
          PUSHPALS_REPO_PATH: repo,
          PUSHPALS_ASSIGNED_REPO_ROOT: repo,
          PYTHONIOENCODING: "utf-8"
        }
      });
      let timedOut = false;
      let hardKillTimer = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        onLog?.("stdout", `[${backendLabel}Executor] Timeout reached after ${timeoutMs}ms; terminating process.`);
        proc.kill();
        hardKillTimer = setTimeout(() => {
          onLog?.("stdout", `[${backendLabel}Executor] Process did not exit after graceful timeout termination; forcing kill.`);
          proc.kill("SIGKILL");
        }, 5000);
      }, timeoutMs);
      const progressIntervalMs = 15000;
      const startedAt = Date.now();
      let sawProcessOutput = false;
      const progressTimer = setInterval(() => {
        if (timedOut || sawProcessOutput)
          return;
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        onLog?.("stdout", `[${backendLabel}Executor] Still running (${Math.floor(elapsedMs / 1000)}s elapsed); waiting for executor output...`);
      }, progressIntervalMs);
      const onProcessLine = (stream, line) => {
        if (!line.trim())
          return;
        sawProcessOutput = true;
        if (stream === "stdout" && line.startsWith(outputPolicy.executorResultPrefix)) {
          return;
        }
        onLog?.(stream, line);
      };
      const [rawStdout, rawStderr, exitCode] = await Promise.all([
        proc.stdout ? streamLines(proc.stdout, "stdout", onProcessLine) : Promise.resolve(""),
        proc.stderr ? streamLines(proc.stderr, "stderr", onProcessLine) : Promise.resolve(""),
        proc.exited
      ]);
      clearTimeout(timeoutTimer);
      if (hardKillTimer)
        clearTimeout(hardKillTimer);
      clearInterval(progressTimer);
      const stdout = rawStdout ?? "";
      const stderr = rawStderr ?? "";
      const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
      const filteredStdout = filterResultLines(stdout, outputPolicy.executorResultPrefix);
      const fallbackUsage = estimateJobTokenUsage(backendName, modelId, params, "", filteredStdout, stderr);
      if (!parsed) {
        if (timedOut) {
          return {
            ok: false,
            summary: `${backendName} wrapper timed out after ${timeoutMs}ms for ${kind}`,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(stderr, outputPolicy),
            exitCode: exitCode === 0 ? 124 : exitCode,
            usage: fallbackUsage
          };
        }
        return {
          ok: false,
          summary: `${backendName} wrapper did not return a structured result for ${kind}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode,
          usage: fallbackUsage
        };
      }
      const summary = typeof parsed.summary === "string" ? parsed.summary : exitCode === 0 ? `${kind} passed via ${backendName}` : `${kind} failed via ${backendName} (exit ${exitCode})`;
      const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
      const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
      const usage = coerceJobTokenUsage(parsed.usage, estimateJobTokenUsage(backendName, modelId, params, summary, parsedStdout, parsedStderr));
      const normalized = normalizeGenericPythonExecutorParsedResultForTimeout({
        backendName,
        kind,
        timedOut,
        timeoutMs,
        timeoutDetail,
        summary,
        stdout: parsedStdout,
        stderr: parsedStderr,
        exitCode: typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : exitCode
      });
      return {
        ok: typeof parsed.ok === "boolean" ? parsed.ok : exitCode === 0,
        summary: normalized.summary,
        stdout: truncate(normalized.stdout, outputPolicy),
        stderr: truncate(normalized.stderr, outputPolicy),
        exitCode: normalized.exitCode,
        usage
      };
    } catch (err) {
      return {
        ok: false,
        summary: `${backendName} wrapper execution error for ${kind}: ${String(err)}`,
        exitCode: 1,
        usage: estimateJobTokenUsage(backendName, runtimeConfig.workerpals.llm.model.trim(), params, `${backendName} wrapper execution error for ${kind}: ${String(err)}`, "", "")
      };
    } finally {
      payloadTransport?.cleanup();
    }
  };
}

// apps/workerpals/src/common/runtime_paths.ts
import { resolve as resolve7 } from "path";
function resolveWorkerpalsSourcePath(...segments) {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SOURCE_ROOT ?? "").trim();
  const sourceRoot = configuredRoot || resolve7(import.meta.dir, "..");
  return resolve7(sourceRoot, ...segments);
}

// apps/workerpals/src/backends/miniswe_backend.ts
function normalizeContainerPython(configuredPython, sharedVenvPython) {
  const configured = configuredPython.trim();
  if (!configured) {
    return sharedVenvPython;
  }
  const lowered = configured.toLowerCase();
  if (lowered === "python" || lowered === "python3" || configured.includes("\\") || /^[a-zA-Z]:/.test(configured) || configured.startsWith(".")) {
    return sharedVenvPython;
  }
  return configured;
}
function warmupProbeCommand(sharedVenvPython) {
  return `PY="\${WORKERPALS_MINISWE_PYTHON:-${sharedVenvPython}}"; ` + 'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' + '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' + `"$PY" -c "import minisweagent; print('mini-swe-agent ready')"`;
}
var MINISWE_BACKEND = {
  name: "miniswe",
  configuredPython: (config) => config.miniswe?.python ?? "python",
  timeoutMs: (config) => config.miniswe?.timeoutMs ?? 300000,
  normalizeContainerPython,
  warmContainerStartupCommand: () => "tail -f /dev/null",
  warmContainerEnv: () => ({}),
  ensureWarmRuntime: null,
  diagnosticChecks: () => [],
  warmupProbeCommand,
  taskExecute: createGenericPythonExecutor({
    backendName: "miniswe",
    scriptPath: resolveWorkerpalsSourcePath("backends", "miniswe", "miniswe_executor.py"),
    scriptSegments: ["apps", "workerpals", "src", "backends", "miniswe", "miniswe_executor.py"],
    pythonConfigKey: "miniswePython",
    timeoutConfigKey: "minisweTimeoutMs"
  })
};

// apps/workerpals/src/backends/openai_codex_backend.ts
function normalizeContainerPython2(configuredPython, sharedVenvPython) {
  const configured = configuredPython.trim();
  if (!configured) {
    return sharedVenvPython;
  }
  const lowered = configured.toLowerCase();
  if (lowered === "python" || lowered === "python3" || configured.includes("\\") || /^[a-zA-Z]:/.test(configured) || configured.startsWith(".")) {
    return sharedVenvPython;
  }
  return configured;
}
function warmupProbeCommand2(sharedVenvPython) {
  return `PY="\${PUSHPALS_OPENAI_CODEX_PYTHON:-${sharedVenvPython}}"; ` + 'AUTH_MODE_RAW="${PUSHPALS_OPENAI_CODEX_AUTH_MODE:-auto}"; ' + 'AUTH_MODE="$(printf %s "$AUTH_MODE_RAW" | tr "[:upper:]" "[:lower:]")"; ' + 'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' + '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' + "if command -v codex >/dev/null 2>&1; then " + '  CODEX_CMD="codex"; ' + "elif command -v bunx >/dev/null 2>&1; then " + '  CODEX_CMD="bunx --yes @openai/codex"; ' + "else " + '  echo "Neither bunx nor codex was found in PATH" >&2; ' + "  exit 1; " + "fi; " + 'sh -lc "$CODEX_CMD --version"; ' + 'NEED_LOGIN="0"; ' + 'if [ "$AUTH_MODE" = "chatgpt" ] || [ "$AUTH_MODE" = "chatgpt_login" ] || [ "$AUTH_MODE" = "subscription" ]; then NEED_LOGIN="1"; fi; ' + 'if [ "$AUTH_MODE" = "auto" ] && [ -z "${OPENAI_API_KEY:-}" ]; then NEED_LOGIN="1"; fi; ' + 'if [ "$NEED_LOGIN" = "1" ]; then ' + '  sh -lc "$CODEX_CMD login status" >/dev/null 2>&1 || { ' + '    echo "Codex CLI login is required for PUSHPALS_OPENAI_CODEX_AUTH_MODE=${AUTH_MODE}. Run codex login (or bunx --yes @openai/codex login)." >&2; ' + "    exit 1; " + "  }; " + "fi";
}
var OPENAI_CODEX_BACKEND = {
  name: "openai_codex",
  configuredPython: (config) => config.openai_codex?.python ?? "python",
  timeoutMs: (config) => config.openai_codex?.timeoutMs ?? 300000,
  normalizeContainerPython: normalizeContainerPython2,
  warmContainerStartupCommand: () => "tail -f /dev/null",
  warmContainerEnv: () => ({}),
  ensureWarmRuntime: null,
  diagnosticChecks: () => [],
  warmupProbeCommand: warmupProbeCommand2,
  taskExecute: createGenericPythonExecutor({
    backendName: "openai_codex",
    scriptPath: resolveWorkerpalsSourcePath("backends", "openai_codex", "openai_codex_executor.py"),
    scriptSegments: [
      "apps",
      "workerpals",
      "src",
      "backends",
      "openai_codex",
      "openai_codex_executor.py"
    ],
    pythonConfigKey: "openaiCodexPython",
    timeoutConfigKey: "openaiCodexTimeoutMs"
  })
};

// apps/workerpals/src/backends/openhands_task_execute.ts
import { existsSync as existsSync6 } from "fs";

// apps/workerpals/src/timeout_policy.ts
var DEFAULT_DOCKER_TIMEOUT_MS = 1860000;
function parseDockerTimeoutMs(raw) {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_DOCKER_TIMEOUT_MS;
  return Math.max(1e4, parsed);
}
function computeTimeoutWarningWindow(timeoutMs) {
  const normalized = Math.max(1e4, Math.floor(timeoutMs));
  const leadMs = Math.min(60000, Math.max(1e4, normalized - 5000));
  const delayMs = Math.max(1000, normalized - leadMs);
  return { leadMs, delayMs };
}

// apps/workerpals/src/backends/openhands_task_execute.ts
var OPENHANDS_SCRIPT_PATH = resolveWorkerpalsSourcePath("backends", "openhands", "openhands_executor.py");
function estimateTokensFromText2(text) {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}
function estimateJobTokenUsage2(runtimeConfig, params, summary, stdout, stderr) {
  const promptSource = (() => {
    try {
      return JSON.stringify(params);
    } catch {
      return String(params?.instruction ?? params?.prompt ?? "");
    }
  })();
  const completionSource = [summary, stdout, stderr].filter(Boolean).join(`

`);
  const promptTokens = estimateTokensFromText2(promptSource);
  const completionTokens = estimateTokensFromText2(completionSource);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
    backend: "openhands",
    modelId: runtimeConfig.workerpals.llm.model.trim()
  };
}
function coerceJobTokenUsage2(value, fallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const raw = value;
  const promptTokens = Number(raw.promptTokens ?? raw.prompt_tokens);
  const completionTokens = Number(raw.completionTokens ?? raw.completion_tokens);
  const totalTokens = Number(raw.totalTokens ?? raw.total_tokens);
  const hasPrompt = Number.isFinite(promptTokens) && promptTokens >= 0;
  const hasCompletion = Number.isFinite(completionTokens) && completionTokens >= 0;
  const hasTotal = Number.isFinite(totalTokens) && totalTokens >= 0;
  if (!hasPrompt && !hasCompletion && !hasTotal) {
    return fallback;
  }
  const normalizedPrompt = hasPrompt ? Math.round(promptTokens) : hasTotal ? Math.max(0, Math.round(totalTokens) - fallback.completionTokens) : fallback.promptTokens;
  const normalizedCompletion = hasCompletion ? Math.round(completionTokens) : hasTotal ? Math.max(0, Math.round(totalTokens) - normalizedPrompt) : fallback.completionTokens;
  const normalizedTotal = hasTotal ? Math.round(totalTokens) : normalizedPrompt + normalizedCompletion;
  return {
    promptTokens: normalizedPrompt,
    completionTokens: normalizedCompletion,
    totalTokens: normalizedTotal,
    estimated: typeof raw.estimated === "boolean" ? raw.estimated : false,
    backend: typeof raw.backend === "string" && raw.backend.trim().length > 0 ? raw.backend.trim() : fallback.backend,
    modelId: typeof raw.modelId === "string" && raw.modelId.trim().length > 0 ? raw.modelId.trim() : fallback.modelId
  };
}
function classifyShellCommand(cmd) {
  const trimmed = cmd.trim().toLowerCase();
  if (!trimmed)
    return "explore";
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  if (token === "ls" || token === "find" || token === "rg" || token === "grep" || token === "cat" || token === "head" || token === "tail" || token === "sed" || token === "awk") {
    return "explore";
  }
  if (token === "git") {
    if (/\bgit\s+(status|log|show|diff|branch|rev-parse|ls-files)\b/.test(trimmed) || /\bgit\s+grep\b/.test(trimmed)) {
      return "explore";
    }
  }
  return "progress";
}
function classifyFileEditorSummary(line) {
  const lowered = line.toLowerCase();
  if (!lowered.startsWith("summary: file_editor"))
    return null;
  if (lowered.includes('"command": "view"') || lowered.includes('"command":"view"') || lowered.includes('"command": "list"') || lowered.includes('"command":"list"')) {
    return "explore";
  }
  if (lowered.includes('"command": "create"') || lowered.includes('"command":"create"') || lowered.includes('"command": "str_replace"') || lowered.includes('"command":"str_replace"') || lowered.includes('"command": "insert"') || lowered.includes('"command":"insert"') || lowered.includes('"command": "delete"') || lowered.includes('"command":"delete"')) {
    return "progress";
  }
  return null;
}
var OPENHANDS_NO_CHANGE_SIGNAL = ["no file changes detected", "no modified files were detected"];
var CLARIFICATION_SIGNAL_REGEX = /\b(clarif(?:y|ication)|need to know which|could you clarify|please clarify|which .* would you like|let me ask for clarification)\b/i;
var NON_AGENT_LOG_LINE_REGEX = /^(message from user|requested task:|tokens:|summary:|observation|tool:|result:|\$ )/i;
function hasOpenHandsNoChangeSignal(text) {
  const lowered = text.toLowerCase();
  return OPENHANDS_NO_CHANGE_SIGNAL.some((token) => lowered.includes(token));
}
function normalizeAgentOutputLine(line) {
  return line.replace(/^\[[^\]]+\]\s*/g, "").replace(/<\/?think>/gi, " ").replace(/```+/g, " ").replace(/\s+/g, " ").trim();
}
function extractClarificationQuestionFromOutput(output) {
  if (!output.trim())
    return null;
  const rawLines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rawLines.length === 0)
    return null;
  const markerIndex = rawLines.findIndex((line) => /message from agent/i.test(line));
  const scopedLines = markerIndex >= 0 ? rawLines.slice(markerIndex + 1) : rawLines;
  const lines = scopedLines.map(normalizeAgentOutputLine).filter((line) => Boolean(line) && !NON_AGENT_LOG_LINE_REGEX.test(line));
  if (lines.length === 0)
    return null;
  const joined = lines.join(`
`);
  if (!CLARIFICATION_SIGNAL_REGEX.test(joined))
    return null;
  const explicitQuestion = [...lines].reverse().find((line) => line.includes("?"));
  if (explicitQuestion)
    return explicitQuestion.slice(0, 280);
  const fallback = [...lines].reverse().find((line) => CLARIFICATION_SIGNAL_REGEX.test(line));
  return fallback ? fallback.slice(0, 280) : null;
}
async function executeWithOpenHands(kind, params, repo, runtimeConfig, onLog, budgets) {
  const pythonBin = runtimeConfig.workerpals.openhandsPython || "python";
  const scriptPath = OPENHANDS_SCRIPT_PATH;
  if (!existsSync6(scriptPath)) {
    return {
      ok: false,
      summary: `OpenHands wrapper script not found: ${scriptPath}`,
      exitCode: 1
    };
  }
  const configuredTimeoutMs = Math.max(1e4, runtimeConfig.workerpals.openhandsTimeoutMs);
  const executionBudgetMs = typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs) ? Math.max(1e4, Math.floor(budgets.executionBudgetMs)) : null;
  const timeoutMs = executionBudgetMs != null ? Math.min(configuredTimeoutMs, executionBudgetMs) : configuredTimeoutMs;
  const timeoutLimitSource = executionBudgetMs == null ? `workerpals.openhands_timeout_ms=${configuredTimeoutMs}ms` : executionBudgetMs < configuredTimeoutMs ? `planning executionBudgetMs=${executionBudgetMs}ms (worker cap=${configuredTimeoutMs}ms)` : executionBudgetMs > configuredTimeoutMs ? `workerpals.openhands_timeout_ms=${configuredTimeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms)` : `planning executionBudgetMs=${executionBudgetMs}ms (matches worker cap)`;
  if (executionBudgetMs != null && executionBudgetMs < configuredTimeoutMs) {
    onLog?.("stdout", `[OpenHandsExecutor] Capping execution timeout to ${timeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms, worker cap=${configuredTimeoutMs}ms).`);
  } else if (executionBudgetMs != null && executionBudgetMs > configuredTimeoutMs) {
    onLog?.("stdout", `[OpenHandsExecutor] Capping execution timeout to ${timeoutMs}ms (planning executionBudgetMs=${executionBudgetMs}ms, configured cap=${configuredTimeoutMs}ms).`);
  }
  const { leadMs: timeoutWarningLeadMs, delayMs: timeoutWarningDelayMs } = computeTimeoutWarningWindow(timeoutMs);
  const finalizationBudgetMs = typeof budgets?.finalizationBudgetMs === "number" && Number.isFinite(budgets.finalizationBudgetMs) ? Math.max(1e4, Math.floor(budgets.finalizationBudgetMs)) : 0;
  const activityExtensionMs = Math.min(finalizationBudgetMs, 10 * 60000);
  const activityWindowMs = 90000;
  const payload = Buffer.from(JSON.stringify({
    kind,
    params,
    repo,
    timeoutMs,
    executionBudgetMs: executionBudgetMs ?? undefined,
    finalizationBudgetMs: finalizationBudgetMs > 0 ? finalizationBudgetMs : undefined
  }), "utf-8").toString("base64");
  let warningTimer = null;
  let timeoutTimer = null;
  let stuckNudgeStartTimer = null;
  let stuckNudgeTimer = null;
  let payloadTransport = null;
  const outputPolicy = {
    maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
    maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
    maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
    executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix
  };
  try {
    payloadTransport = createPythonPayloadTransport(payload);
    const proc = Bun.spawn([pythonBin, scriptPath, ...payloadTransport.args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...buildWorkerSandboxWritableEnv(repo),
        PUSHPALS_REPO_PATH: repo,
        PUSHPALS_ASSIGNED_REPO_ROOT: repo,
        PYTHONIOENCODING: "utf-8"
      }
    });
    let timedOut = false;
    const startedAtMs = Date.now();
    let lastActivityAtMs = startedAtMs;
    let timeoutDeadlineMs = startedAtMs + timeoutMs;
    let extendedByActivityMs = 0;
    let timedOutAfterMs = timeoutMs;
    const stuckGuardEnabled = runtimeConfig.workerpals.openhandsStuckGuardEnabled;
    const stuckExploreLimit = runtimeConfig.workerpals.openhandsStuckGuardExploreLimit;
    const stuckMinElapsedMs = runtimeConfig.workerpals.openhandsStuckGuardMinElapsedMs;
    const stuckBroadScanLimit = runtimeConfig.workerpals.openhandsStuckGuardBroadScanLimit;
    const stuckNoProgressMaxMs = runtimeConfig.workerpals.openhandsStuckGuardNoProgressMaxMs;
    const stuckNudgeEnabled = runtimeConfig.workerpals.openhandsAutoSteerEnabled;
    const stuckNudgeInitialDelayMs = Math.max(0, Math.floor(runtimeConfig.workerpals.openhandsAutoSteerInitialDelaySec * 1000));
    const stuckNudgeIntervalMs = Math.max(5000, Math.floor(runtimeConfig.workerpals.openhandsAutoSteerIntervalSec * 1000));
    const stuckNudgeMaxCount = Math.max(0, runtimeConfig.workerpals.openhandsAutoSteerMaxNudges);
    let exploreOps = 0;
    let progressOps = 0;
    let broadRepoScans = 0;
    let stuckGuardTriggered = false;
    let stuckGuardReason = "";
    let stuckGuardAfterMs = 0;
    let stuckNudgeCount = 0;
    const stopStuckNudges = (reason) => {
      const hadActiveTimer = Boolean(stuckNudgeStartTimer || stuckNudgeTimer);
      if (stuckNudgeStartTimer) {
        clearTimeout(stuckNudgeStartTimer);
        stuckNudgeStartTimer = null;
      }
      if (stuckNudgeTimer) {
        clearInterval(stuckNudgeTimer);
        stuckNudgeTimer = null;
      }
      if (reason && hadActiveTimer) {
        onLog?.("stdout", `[OpenHandsExecutor] Auto-steering nudges paused: ${reason}.`);
      }
    };
    const buildSteeringNudge = (nudgeIndex) => {
      if (nudgeIndex === 1) {
        return "Auto-steering nudge 1: stop broad exploration and lock onto one concrete target file. " + "Make one minimal edit and run one focused validation command.";
      }
      if (nudgeIndex === 2) {
        return "Auto-steering nudge 2: choose the best candidate file now, apply a small correct patch, " + "then run a narrow test/lint command for that change.";
      }
      return "Auto-steering nudge: if still blocked, stop scanning loops and return concise blocker status " + "with the next concrete command you would run.";
    };
    const startStuckNudges = () => {
      if (!stuckNudgeEnabled || stuckNudgeMaxCount <= 0)
        return;
      if (stuckNudgeStartTimer || stuckNudgeTimer)
        return;
      const emitNudge = () => {
        if (timedOut) {
          stopStuckNudges();
          return;
        }
        if (progressOps > 0) {
          stopStuckNudges("progress detected");
          return;
        }
        stuckNudgeCount += 1;
        const elapsedMs = Date.now() - startedAtMs;
        onLog?.("stdout", `[OpenHandsExecutor] Auto-steering nudge ${stuckNudgeCount}/${stuckNudgeMaxCount} after ${elapsedMs}ms (${stuckGuardReason || "no edit/test progress"}): ${buildSteeringNudge(stuckNudgeCount)}`);
        if (stuckNudgeCount >= stuckNudgeMaxCount) {
          stopStuckNudges();
        }
      };
      const startInterval = () => {
        if (stuckNudgeTimer || stuckNudgeCount >= stuckNudgeMaxCount)
          return;
        stuckNudgeTimer = setInterval(emitNudge, stuckNudgeIntervalMs);
      };
      if (stuckNudgeInitialDelayMs <= 0) {
        emitNudge();
        startInterval();
        return;
      }
      stuckNudgeStartTimer = setTimeout(() => {
        stuckNudgeStartTimer = null;
        emitNudge();
        startInterval();
      }, stuckNudgeInitialDelayMs);
    };
    const onProcessLine = (stream, line) => {
      lastActivityAtMs = Date.now();
      const trimmed = line.trim();
      if (trimmed.startsWith("$ ")) {
        const commandText = trimmed.slice(2).trim();
        if (classifyShellCommand(commandText) === "explore") {
          exploreOps += 1;
        } else {
          progressOps += 1;
        }
        const lowered = commandText.toLowerCase();
        if (/\bfind\s+\/repo\b/.test(lowered) || /\bfind\s+\/\b/.test(lowered)) {
          broadRepoScans += 1;
        }
      }
      const fileEditorClass = classifyFileEditorSummary(trimmed);
      if (fileEditorClass === "explore")
        exploreOps += 1;
      if (fileEditorClass === "progress")
        progressOps += 1;
      if (stuckGuardTriggered && progressOps > 0) {
        stopStuckNudges("progress detected");
      }
      if (!stuckGuardTriggered && stuckGuardEnabled && progressOps === 0) {
        const elapsedMs = Date.now() - startedAtMs;
        const noProgressTooLong = elapsedMs >= stuckNoProgressMaxMs;
        const tooManyExplores = elapsedMs >= stuckMinElapsedMs && exploreOps >= stuckExploreLimit;
        const tooManyBroadScans = broadRepoScans >= stuckBroadScanLimit;
        if (noProgressTooLong || tooManyExplores || tooManyBroadScans) {
          stuckGuardTriggered = true;
          stuckGuardAfterMs = elapsedMs;
          if (tooManyBroadScans) {
            stuckGuardReason = `repeated broad filesystem scans (count=${broadRepoScans}) with no edits/tests`;
          } else if (tooManyExplores) {
            stuckGuardReason = `repeated exploratory actions (count=${exploreOps}) with no edits/tests`;
          } else {
            stuckGuardReason = `no edit/test progress for ${stuckNoProgressMaxMs}ms`;
          }
          onLog?.("stdout", `[OpenHandsExecutor] Stuck guard triggered after ${stuckGuardAfterMs}ms: ${stuckGuardReason}. Steering hint: stop broad exploration, pick a concrete target file, make a minimal edit, then run a focused validation command.`);
          startStuckNudges();
        }
      }
      onLog?.(stream, line);
    };
    const resetWarningTimer = () => {
      if (warningTimer) {
        clearTimeout(warningTimer);
        warningTimer = null;
      }
      const msUntilWarn = timeoutDeadlineMs - Date.now() - timeoutWarningLeadMs;
      if (msUntilWarn <= 0)
        return;
      warningTimer = setTimeout(() => {
        onLog?.("stdout", `[OpenHandsExecutor] Timeout approaching for ${kind} (${Math.round(timeoutWarningLeadMs / 1000)}s remaining). If unfinished, return a concise status/failure update now.`);
      }, msUntilWarn);
    };
    const resetTimeoutTimer = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const msUntilTimeout = Math.max(1, timeoutDeadlineMs - Date.now());
      timeoutTimer = setTimeout(() => {
        const nowMs = Date.now();
        const quietForMs = nowMs - lastActivityAtMs;
        if (extendedByActivityMs === 0 && activityExtensionMs > 0 && quietForMs <= activityWindowMs) {
          extendedByActivityMs = activityExtensionMs;
          timeoutDeadlineMs = nowMs + activityExtensionMs;
          onLog?.("stdout", `[OpenHandsExecutor] Extending timeout by ${activityExtensionMs}ms because the agent is still active (last output ${Math.round(quietForMs / 1000)}s ago).`);
          resetWarningTimer();
          resetTimeoutTimer();
          return;
        }
        timedOut = true;
        timedOutAfterMs = Math.max(1, nowMs - startedAtMs);
        onLog?.("stdout", `[OpenHandsExecutor] Timeout reached for ${kind} after ${timedOutAfterMs}ms (effective limit: ${timeoutLimitSource}${extendedByActivityMs > 0 ? ` + activity extension ${extendedByActivityMs}ms` : ""}); terminating wrapper process.`);
        stopStuckNudges();
        try {
          proc.kill();
        } catch (_e) {}
      }, msUntilTimeout);
    };
    resetWarningTimer();
    resetTimeoutTimer();
    const [stdout, stderr] = await Promise.all([
      streamLines(proc.stdout, "stdout", onProcessLine),
      streamLines(proc.stderr, "stderr", onProcessLine)
    ]);
    if (warningTimer) {
      clearTimeout(warningTimer);
      warningTimer = null;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    stopStuckNudges();
    const exitCode = await proc.exited;
    const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
    const filteredStdout = filterResultLines(stdout, outputPolicy.executorResultPrefix);
    const fallbackUsage = estimateJobTokenUsage2(runtimeConfig, params, "", filteredStdout, stderr);
    if (!parsed) {
      if (timedOut) {
        const stuckNote = stuckGuardTriggered ? ` Stuck guard warning was raised at ${stuckGuardAfterMs}ms (${stuckGuardReason}).` : "";
        return {
          ok: false,
          summary: `OpenHands wrapper timed out after ${timedOutAfterMs}ms for ${kind} (effective limit: ${timeoutLimitSource}${extendedByActivityMs > 0 ? ` + activity extension ${extendedByActivityMs}ms` : ""}). Worker returned a timeout failure.${stuckNote}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode: exitCode === 0 ? 124 : exitCode,
          usage: fallbackUsage
        };
      }
      return {
        ok: false,
        summary: `OpenHands wrapper did not return a structured result for ${kind}`,
        stdout: truncate(filteredStdout, outputPolicy),
        stderr: truncate(stderr, outputPolicy),
        exitCode,
        usage: fallbackUsage
      };
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary : exitCode === 0 ? `${kind} passed via OpenHands` : `${kind} failed via OpenHands (exit ${exitCode})`;
    const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
    const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
    const usage = coerceJobTokenUsage2(parsed.usage, estimateJobTokenUsage2(runtimeConfig, params, summary, parsedStdout, parsedStderr));
    const parsedExitCode = typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : exitCode;
    const parsedOk = typeof parsed.ok === "boolean" ? parsed.ok : parsedExitCode === 0;
    const noChangeResult = parsedOk && (hasOpenHandsNoChangeSignal(summary) || hasOpenHandsNoChangeSignal(String(parsedStdout ?? "")) || hasOpenHandsNoChangeSignal(String(parsedStderr ?? "")));
    if (noChangeResult) {
      const clarificationQuestion = extractClarificationQuestionFromOutput(filteredStdout);
      if (clarificationQuestion) {
        return {
          ok: true,
          summary: `OpenHands needs clarification: ${clarificationQuestion}`,
          stdout: truncate(filteredStdout || String(parsedStdout ?? ""), outputPolicy),
          stderr: truncate(`Clarification needed: ${clarificationQuestion}`, outputPolicy),
          exitCode: 0,
          usage
        };
      }
    }
    return {
      ok: parsedOk,
      summary,
      stdout: truncate(parsedStdout ?? "", outputPolicy),
      stderr: truncate(parsedStderr ?? "", outputPolicy),
      exitCode: parsedExitCode,
      usage
    };
  } catch (err) {
    return {
      ok: false,
      summary: `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
      exitCode: 1,
      usage: estimateJobTokenUsage2(runtimeConfig, params, `OpenHands wrapper execution error for ${kind}: ${String(err)}`, "", "")
    };
  } finally {
    if (warningTimer) {
      clearTimeout(warningTimer);
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (stuckNudgeStartTimer) {
      clearTimeout(stuckNudgeStartTimer);
    }
    if (stuckNudgeTimer) {
      clearInterval(stuckNudgeTimer);
    }
    payloadTransport?.cleanup();
  }
}

// apps/workerpals/src/backends/openhands_backend.ts
function normalizeContainerPython3(configuredPython, sharedVenvPython) {
  const configured = configuredPython.trim();
  if (!configured) {
    return sharedVenvPython;
  }
  const lowered = configured.toLowerCase();
  if (lowered === "python" || lowered === "python3" || configured.includes("\\") || /^[a-zA-Z]:/.test(configured) || configured.startsWith(".")) {
    return sharedVenvPython;
  }
  return configured;
}
function openHandsResolvePythonCommand(sharedVenvPython) {
  return `PY="\${WORKERPALS_OPENHANDS_PYTHON:-${sharedVenvPython}}"; ` + 'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' + '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }';
}
function openHandsHealthCommand(port) {
  return `curl -fsS http://127.0.0.1:${port}/health >/dev/null 2>&1 ` + `|| curl -fsS http://127.0.0.1:${port}/ >/dev/null 2>&1`;
}
function openHandsStartupCommand(context) {
  const { sharedVenvPython, warmAgentPort: port, startupAttempts, sleepSeconds } = context;
  const healthCmd = openHandsHealthCommand(port);
  const resolvePythonCmd = openHandsResolvePythonCommand(sharedVenvPython);
  return `${resolvePythonCmd}; ` + ": >/tmp/openhands-agent.log; " + `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${port} >/tmp/openhands-agent.log 2>&1 & ` + `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` + `${healthCmd} || { ` + 'echo "agent server health check failed"; ' + 'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true; ' + "ls -l /tmp/openhands-agent.log 2>/dev/null || true; " + "tail -n 160 /tmp/openhands-agent.log 2>/dev/null; " + "exit 1; }; " + "tail -f /dev/null";
}
function openHandsRestartCommand(context) {
  const { sharedVenvPython, warmAgentPort: port, startupAttempts, sleepSeconds } = context;
  const healthCmd = openHandsHealthCommand(port);
  const resolvePythonCmd = openHandsResolvePythonCommand(sharedVenvPython);
  return `OLD_PIDS="$(ps -eo pid,args | awk '/[o]penhands\\.agent_server/ {print $1}' | tr '\\n' ' ')"; ` + 'if [ -n "$OLD_PIDS" ]; then kill $OLD_PIDS >/dev/null 2>&1 || true; fi; ' + "sleep 0.2; " + `${resolvePythonCmd}; ` + ": >/tmp/openhands-agent.log; " + `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${port} >/tmp/openhands-agent.log 2>&1 & ` + `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` + healthCmd;
}
function openHandsDiagnosticChecks(sharedVenvPython) {
  return [
    {
      label: "processes",
      command: 'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true'
    },
    {
      label: "python",
      command: `${openHandsResolvePythonCommand(sharedVenvPython)}; ` + 'echo "configured=$PY"; ' + 'if [ -x "$PY" ]; then "$PY" -V 2>&1; else echo "configured python missing"; fi; ' + "(command -v python3 && python3 -V) 2>/dev/null || true"
    },
    {
      label: "agent-log-meta",
      command: "ls -l /tmp/openhands-agent.log 2>/dev/null || true"
    },
    {
      label: "agent-log-tail",
      command: "tail -n 160 /tmp/openhands-agent.log 2>/dev/null || true"
    }
  ];
}
async function ensureOpenHandsWarmRuntime(context) {
  const healthCmd = openHandsHealthCommand(context.warmAgentPort);
  const healthy = await context.runWarmShell(healthCmd);
  if (healthy.ok)
    return;
  console.warn(`[DockerExecutor] Warm agent server is unhealthy in ${context.warmContainerName}; restarting it...`);
  const restarted = await context.runWarmShell(openHandsRestartCommand(context));
  if (restarted.ok)
    return;
  let recreateError = "";
  try {
    console.warn(`[DockerExecutor] Warm agent restart failed in ${context.warmContainerName}; recreating warm container once...`);
    await context.restartWarmContainer();
    const postRecreateHealth = await context.runWarmShell(`for i in $(seq 1 ${context.startupAttempts}); do ${healthCmd} && exit 0; sleep ${context.sleepSeconds}; done; exit 1`);
    if (postRecreateHealth.ok)
      return;
    const postRecreateOutput = [postRecreateHealth.stderr, postRecreateHealth.stdout].filter(Boolean).join(`
`).trim();
    recreateError = `post-recreate health check failed (exit ${postRecreateHealth.exitCode})${postRecreateOutput ? `: ${postRecreateOutput}` : "."}`;
  } catch (error) {
    recreateError = `recreate warm container failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const restartOutput = [restarted.stderr, restarted.stdout].filter(Boolean).join(`
`).trim();
  const diagnostics = await context.collectWarmDiagnostics();
  throw new Error(`Warm OpenHands agent server could not be started (exit ${restarted.exitCode})${restartOutput ? `: ${restartOutput}` : "."}${recreateError ? `
${recreateError}` : ""}
${diagnostics}`);
}
var OPENHANDS_BACKEND = {
  name: "openhands",
  configuredPython: (config) => config.openhands?.python ?? "python",
  timeoutMs: (config) => config.openhands?.timeoutMs ?? 300000,
  normalizeContainerPython: normalizeContainerPython3,
  warmContainerStartupCommand: openHandsStartupCommand,
  warmContainerEnv: (context) => ({
    WORKERPALS_OPENHANDS_AGENT_SERVER_URL: `http://127.0.0.1:${context.warmAgentPort}`
  }),
  ensureWarmRuntime: ensureOpenHandsWarmRuntime,
  diagnosticChecks: openHandsDiagnosticChecks,
  warmupProbeCommand: null,
  taskExecute: executeWithOpenHands
};

// apps/workerpals/src/backends/task_execute_registry.ts
var specializedTaskExecutors = new Map;
function registerBackendTaskExecutor(backend, executor) {
  specializedTaskExecutors.set(backend, executor);
}
function getBackendTaskExecutor(backend) {
  return specializedTaskExecutors.get(backend);
}

// apps/workerpals/src/backends/backend_config.ts
var FALLBACK_DEFAULT_EXECUTOR = DEFAULT_WORKERPALS_EXECUTOR;
function toStrings(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}
function parseRequiredBackendToml(path) {
  if (!existsSync7(path)) {
    throw new Error(`Missing required runtime backend config file: ${path}`);
  }
  const parsed = Bun.TOML.parse(readFileSync6(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid runtime backend config file: ${path}`);
  }
  return parsed;
}
function resolveBackendTomlPath(configDir) {
  return join7(configDir, "backend.toml");
}
function loadBackendToml() {
  const path = resolveBackendTomlPath(loadPushPalsConfig().configDir);
  return parseRequiredBackendToml(path);
}
var config = loadBackendToml();
var backendEntries = Object.entries(config.backends ?? {});
var BACKEND_EXECUTOR_SCRIPT_SEGMENTS = Object.fromEntries(backendEntries.map(([name, spec]) => [name, toStrings(spec?.script_segments)]));
var EXECUTOR_BACKENDS = Object.keys(BACKEND_EXECUTOR_SCRIPT_SEGMENTS);
var DEFAULT_EXECUTOR = typeof config.default_backend === "string" && EXECUTOR_BACKENDS.includes(config.default_backend) ? config.default_backend : EXECUTOR_BACKENDS.includes(FALLBACK_DEFAULT_EXECUTOR) ? FALLBACK_DEFAULT_EXECUTOR : EXECUTOR_BACKENDS[0] ?? FALLBACK_DEFAULT_EXECUTOR;
var SHARED_DOCKER_PASSTHROUGH_ENV = toStrings(config.env?.shared_passthrough);
var BACKEND_DOCKER_PASSTHROUGH_ENV = Object.fromEntries(backendEntries.map(([name, spec]) => [name, toStrings(spec?.passthrough_env)]));
var BACKEND_RUNTIME_CONFIG_KEYS = Object.fromEntries(backendEntries.map(([name, spec]) => [
  name,
  {
    pythonKey: spec?.python_config_key?.trim() || `${name}Python`,
    timeoutKey: spec?.timeout_config_key?.trim() || `${name}TimeoutMs`
  }
]));
var DOCKER_BACKENDS = [
  OPENHANDS_BACKEND,
  MINISWE_BACKEND,
  OPENAI_CODEX_BACKEND
];
function getDockerBackendSpec(name) {
  const spec = DOCKER_BACKENDS.find((entry) => entry.name === name);
  if (!spec) {
    throw new Error(`Unknown docker backend: ${name}`);
  }
  return spec;
}
for (const backend of DOCKER_BACKENDS) {
  registerBackendTaskExecutor(backend.name, backend.taskExecute);
}

// apps/workerpals/src/common/executor_backend.ts
var DEFAULT_CONFIG2 = loadPushPalsConfig();
function resolveExecutor(config2 = DEFAULT_CONFIG2) {
  const raw = config2.workerpals.executor.trim().toLowerCase();
  if (raw in BACKEND_EXECUTOR_SCRIPT_SEGMENTS)
    return raw;
  console.warn(`[WorkerPals] Unknown workerpals.executor="${raw}", falling back to "${DEFAULT_EXECUTOR}".`);
  return DEFAULT_EXECUTOR;
}

// apps/workerpals/src/common/logger.ts
var LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
function normalizeLevel(raw) {
  const value = raw.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}
function resolveMinLevel() {
  const explicit = normalizeLevel(process.env.WORKERPALS_LOG_LEVEL ?? "");
  if (explicit)
    return explicit;
  const debugFlag = (process.env.WORKERPALS_DEBUG ?? "").trim().toLowerCase();
  return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes" ? "debug" : "info";
}

class Logger {
  minLevel;
  prefix;
  constructor(prefix, minLevel = resolveMinLevel()) {
    this.prefix = prefix.trim();
    this.minLevel = minLevel;
  }
  isDebugEnabled() {
    return this.canLog("debug");
  }
  debug(message) {
    if (!this.canLog("debug"))
      return;
    console.log(this.format(message));
  }
  info(message) {
    if (!this.canLog("info"))
      return;
    console.log(this.format(message));
  }
  warn(message) {
    if (!this.canLog("warn"))
      return;
    console.warn(this.format(message));
  }
  error(message) {
    if (!this.canLog("error"))
      return;
    console.error(this.format(message));
  }
  canLog(level) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }
  format(message) {
    return this.prefix ? `[${this.prefix}] ${message}` : message;
  }
}

// apps/workerpals/src/execute_job.ts
import { createHash as createHash4 } from "crypto";
import {
  existsSync as existsSync8,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync3,
  readFileSync as readFileSync8,
  renameSync,
  rmSync as rmSync3,
  statSync as statSync4,
  unlinkSync,
  writeFileSync as writeFileSync4
} from "fs";
import { resolve as resolve10 } from "path";

// apps/workerpals/src/common/worktree_dependency_artifacts.ts
import { createHash as createHash3 } from "crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync7,
  readdirSync as readdirSync2,
  rmSync as rmSync2,
  statSync as statSync3,
  symlinkSync,
  writeFileSync as writeFileSync3
} from "fs";
import { resolve as resolve8 } from "path";
var DIRECT_WORKTREE_DEPENDENCY_ARTIFACTS = ["node_modules"];
var DIRECT_WORKTREE_DEPENDENCY_SNAPSHOT_MARKER = ".pushpals-dependency-snapshot";
function pathExistsOrLink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function sourceCanBeLinked(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function linkTypeForHost() {
  return process.platform === "win32" ? "junction" : "dir";
}
var MUTABLE_DEPENDENCY_DIRS = new Set([".cache", ".expo", ".vite"]);
function dependencySnapshotKey(repo) {
  const hash = createHash3("sha256");
  let included = 0;
  for (const name of ["package.json", "bun.lock", "bun.lockb"]) {
    const path = resolve8(repo, name);
    try {
      hash.update(name);
      hash.update("\x00");
      hash.update(readFileSync7(path));
      hash.update("\x00");
      included += 1;
    } catch {}
  }
  return included > 0 ? hash.digest("hex") : "unversioned";
}
function materializeDependencySnapshot(source, destination, snapshotKey) {
  mkdirSync2(destination, { recursive: true });
  for (const entry of readdirSync2(source)) {
    const sourceEntry = resolve8(source, entry);
    const destinationEntry = resolve8(destination, entry);
    const stat = lstatSync(sourceEntry);
    if (MUTABLE_DEPENDENCY_DIRS.has(entry)) {
      mkdirSync2(destinationEntry, { recursive: true });
    } else if (stat.isDirectory() || stat.isSymbolicLink() && statSync3(sourceEntry).isDirectory()) {
      symlinkSync(sourceEntry, destinationEntry, linkTypeForHost());
    } else {
      copyFileSync(sourceEntry, destinationEntry);
    }
  }
  writeFileSync3(resolve8(destination, DIRECT_WORKTREE_DEPENDENCY_SNAPSHOT_MARKER), `${snapshotKey}
`, "utf8");
}
function linkDirectWorktreeDependencyArtifacts(repo, worktreePath, onLog, artifactNames = DIRECT_WORKTREE_DEPENDENCY_ARTIFACTS) {
  const linked = [];
  const skipped = [];
  const warnings = [];
  for (const name of artifactNames) {
    const source = resolve8(repo, name);
    const destination = resolve8(worktreePath, name);
    if (!sourceCanBeLinked(source)) {
      skipped.push(name);
      continue;
    }
    if (pathExistsOrLink(destination)) {
      skipped.push(name);
      continue;
    }
    try {
      if (name === "node_modules") {
        materializeDependencySnapshot(source, destination, dependencySnapshotKey(repo));
      } else {
        symlinkSync(source, destination, linkTypeForHost());
      }
      linked.push(name);
    } catch (err) {
      if (name === "node_modules" && pathExistsOrLink(destination)) {
        rmSync2(destination, { recursive: true, force: true });
      }
      const warning = `[WorkerPals] Worktree dependency artifact linking skipped for ${name}: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(warning);
      console.warn(warning);
      onLog?.("stderr", warning);
    }
  }
  if (linked.length > 0) {
    const note = `[WorkerPals] Materialized content-addressed worktree dependency snapshot(s): ` + linked.join(", ");
    console.log(note);
    onLog?.("stdout", note);
  }
  return { linked, skipped, warnings };
}
// apps/workerpals/src/merge_conflict_job.ts
import { basename as basename3, dirname as dirname3, resolve as resolve9 } from "path";
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function normalizeBranchName(value, resolutionType) {
  const trimmed = String(value ?? "").trim().replace(/^refs\/heads\//, "");
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (resolutionType === "merge_conflict" && !normalized.startsWith("agent/"))
    return "";
  if (normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    return "";
  }
  if (/[~^:?*\[\]\s]/.test(normalized))
    return "";
  return normalized;
}
function normalizeBaseBranch(value) {
  return String(value ?? "").trim().replace(/^refs\/heads\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}
function isMergeConflictOutput(text) {
  const normalized = String(text ?? "").toLowerCase();
  return normalized.includes("could not apply") || normalized.includes("resolve all conflicts manually") || normalized.includes("merge conflict") || normalized.includes("fix conflicts and then run");
}
async function git(cwd, args) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return {
    ok: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}
async function mustGit(cwd, args, label) {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new Error(`${label} failed: git ${args.join(" ")}
${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
function dedupeStrings(values, maxItems = 16) {
  const seen = new Set;
  const out = [];
  for (const entry of values) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems)
      break;
  }
  return out;
}
function deriveLikelyDirs(paths) {
  return dedupeStrings(paths.map((entry) => dirname3(entry).replace(/\\/g, "/")).filter((entry) => entry && entry !== "."), 12);
}
function deriveRipgrepQueries(paths) {
  return dedupeStrings(paths.map((entry) => basename3(entry)).filter(Boolean), 8);
}
function isTestPath(path) {
  return /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path);
}
function formatBunTestPathArg(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").trim();
  if (!normalized)
    return normalized;
  const pathArg = normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ? normalized : `./${normalized}`;
  return quoteValidationCommandArg(pathArg);
}
function quoteValidationCommandArg(arg) {
  if (!/[\s"\\]/.test(arg))
    return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function deriveValidationSteps(existing, conflictPaths) {
  const preserved = Array.isArray(existing) ? existing.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
  const targeted = conflictPaths.filter(isTestPath).map((entry) => `bun test ${formatBunTestPathArg(entry)}`);
  const merged = dedupeStrings([...targeted, ...preserved], 8);
  return merged.length > 0 ? merged : ["bun test"];
}
function extractConflictPaths(stdout) {
  return dedupeStrings(String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean), 32);
}
function buildPlannerGuidance(context, conflictPaths, rebasedCleanly) {
  const lines = [
    "Merge-conflict host-prepared worktree state:",
    `- The host prepared an isolated detached worktree at the exact leased head for ${context.publicBranch}.`,
    `- SourceControlManager publication target: origin/${context.publicBranch}.`,
    `- Host-side source-control orchestration owns rebase continuation onto origin/${context.baseBranch}.`
  ];
  if (context.expectedHeadSha) {
    lines.push(`- Expected remote lease SHA for SourceControlManager publication: ${context.expectedHeadSha}. If origin/${context.publicBranch} moved, stop and report the mismatch instead of overwriting newer work.`);
  }
  if (context.mergeError) {
    lines.push(`- GitHub mergeability error: ${context.mergeError}`);
  }
  if (rebasedCleanly) {
    lines.push(`- The branch is already rebased cleanly onto origin/${context.baseBranch}. Edit only if validation identifies a content defect, then leave publication to SourceControlManager.`);
  } else {
    lines.push(`- The host-prepared worktree is already paused mid-rebase onto origin/${context.baseBranch}. Resolve the conflicts in the current repo state instead of re-discovering branch topology.`);
    if (conflictPaths.length > 0) {
      lines.push(`- Unresolved conflict files: ${conflictPaths.join(", ")}`);
    }
    lines.push("- Edit the conflicted files, remove conflict markers, preserve both sides' intended behavior, and run focused validation. Read-only Git inspection such as `git diff -- <path>` is allowed.");
    lines.push("- Do not run checkout, switch, reset, merge, rebase, add, commit, or push commands. Host-side source-control orchestration will stage resolved files and continue the prepared rebase after you return.");
    lines.push("- Budget rule: choose the smallest side-preserving file resolution and focused checks. Do not broaden or refactor beyond what is required to remove conflict markers and retain intended behavior.");
  }
  lines.push("- Do not create a new PR or alternate branch. SourceControlManager owns publication and is the sole process allowed to update the existing PR branch.");
  return lines.join(`
`);
}
function extractMergeConflictReviewContext(params) {
  const reviewAgent = asRecord(params?.reviewAgent);
  if (!reviewAgent)
    return null;
  const resolutionType = String(reviewAgent.resolutionType ?? "").trim().toLowerCase();
  if (resolutionType !== "merge_conflict" && resolutionType !== "integration_reconcile") {
    return null;
  }
  const publicBranch = normalizeBranchName(params?.completionBranch ?? reviewAgent.prHeadRef, resolutionType);
  const baseBranch = normalizeBaseBranch(reviewAgent.prBaseRef);
  if (!publicBranch || !baseBranch || publicBranch === baseBranch)
    return null;
  return {
    resolutionType,
    publicBranch,
    baseBranch,
    expectedHeadSha: String(reviewAgent.prHeadSha ?? "").trim(),
    expectedBaseSha: String(reviewAgent.prBaseSha ?? "").trim(),
    mergeError: String(reviewAgent.mergeError ?? "").trim()
  };
}
function isMergeConflictResolutionParams(params) {
  return extractMergeConflictReviewContext(params) !== null;
}
function isReviewResolutionParams(params) {
  const reviewAgent = asRecord(params?.reviewAgent);
  const resolutionType = String(reviewAgent?.resolutionType ?? "").trim().toLowerCase();
  return resolutionType === "review_fix" || resolutionType === "merge_conflict" || resolutionType === "integration_reconcile";
}
function isHostScmOwnedReviewParams(params) {
  const reviewAgent = asRecord(params?.reviewAgent);
  return isReviewResolutionParams(params) && reviewAgent?.hostScmGitOwner === true;
}
function markHostScmGitOwnership(params) {
  const reviewAgent = asRecord(params.reviewAgent);
  if (!reviewAgent || !isReviewResolutionParams(params))
    return params;
  return {
    ...params,
    reviewAgent: {
      ...reviewAgent,
      hostScmGitOwner: true
    }
  };
}
function applyMergeConflictExecutionHints(params, preparation) {
  const next = { ...params };
  const planning = asRecord(next.planning) ? { ...next.planning } : {};
  const existingGuidance = String(next.plannerWorkerInstruction ?? "").trim();
  next.plannerWorkerInstruction = [existingGuidance, preparation.plannerGuidance].filter(Boolean).join(`

`);
  const hintedPaths = preparation.conflictPaths;
  if (hintedPaths.length > 0) {
    const currentTargetPaths = Array.isArray(planning.targetPaths) ? planning.targetPaths.map((entry) => String(entry ?? "")).filter(Boolean) : [];
    planning.targetPaths = dedupeStrings([...hintedPaths, ...currentTargetPaths], 24);
    const discovery = asRecord(planning.discovery) ? { ...planning.discovery } : {};
    const likelyDirs = Array.isArray(discovery.likelyDirs) ? discovery.likelyDirs.map((entry) => String(entry ?? "")).filter(Boolean) : [];
    const ripgrepQueries = Array.isArray(discovery.ripgrepQueries) ? discovery.ripgrepQueries.map((entry) => String(entry ?? "")).filter(Boolean) : [];
    discovery.likelyDirs = dedupeStrings([...deriveLikelyDirs(hintedPaths), ...likelyDirs], 16);
    discovery.ripgrepQueries = dedupeStrings([...deriveRipgrepQueries(hintedPaths), ...ripgrepQueries], 16);
    planning.discovery = discovery;
    planning.validationSteps = deriveValidationSteps(planning.validationSteps, hintedPaths);
  }
  next.planning = planning;
  const reviewAgent = asRecord(next.reviewAgent);
  if (reviewAgent) {
    next.reviewAgent = {
      ...reviewAgent,
      preparedWorkspaceMode: "host_prepared_linked_worktree",
      preparedRebaseState: preparation.rebasedCleanly ? "clean" : "conflicted",
      preparedConflictPaths: preparation.conflictPaths,
      preparedHeadSha: preparation.currentHeadSha
    };
  }
  return next;
}
async function prepareMergeConflictWorktreeOnHost(worktreePath, jobId, params, onLog) {
  const context = extractMergeConflictReviewContext(params);
  if (!context) {
    return {
      repoPath: worktreePath,
      cleanup: () => {},
      conflictPaths: [],
      plannerGuidance: "",
      rebasedCleanly: false,
      currentHeadSha: ""
    };
  }
  const currentHeadSha = (await mustGit(worktreePath, ["rev-parse", "HEAD"], "resolve host worktree HEAD")).trim().toLowerCase();
  if (context.expectedHeadSha && currentHeadSha !== context.expectedHeadSha.trim().toLowerCase()) {
    throw new Error(`Stale merge-conflict worktree lease for ${jobId}: expected PR head ${context.expectedHeadSha}, but host worktree is ${currentHeadSha}.`);
  }
  const baseRef = context.expectedBaseSha || `refs/remotes/origin/${context.baseBranch}`;
  const resolvedBaseSha = (await mustGit(worktreePath, ["rev-parse", `${baseRef}^{commit}`], "resolve leased PR base")).trim().toLowerCase();
  if (context.expectedBaseSha && resolvedBaseSha !== context.expectedBaseSha.trim().toLowerCase()) {
    throw new Error(`Stale merge-conflict base lease for ${jobId}: expected ${context.expectedBaseSha}, but host resolved ${resolvedBaseSha}.`);
  }
  await mustGit(worktreePath, ["config", "rerere.enabled", "true"], "enable rerere");
  await mustGit(worktreePath, ["config", "rerere.autoupdate", "true"], "enable rerere autoupdate");
  const rebase = await git(worktreePath, ["-c", "core.editor=true", "rebase", resolvedBaseSha]);
  let rebasedCleanly = false;
  let conflictPaths = [];
  if (rebase.ok) {
    rebasedCleanly = true;
    onLog?.("stdout", `[MergeConflictHost] ${jobId}: detached PR head rebased cleanly onto ${resolvedBaseSha.slice(0, 12)} before container execution.`);
  } else if (isMergeConflictOutput(`${rebase.stderr}
${rebase.stdout}`)) {
    const unresolved = await mustGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], "list host-prepared unresolved conflict paths");
    conflictPaths = extractConflictPaths(unresolved);
    onLog?.("stdout", `[MergeConflictHost] ${jobId}: host paused the detached worktree rebase with ${conflictPaths.length} unresolved file(s) before container execution.`);
  } else {
    throw new Error(rebase.stderr || rebase.stdout || "unknown host-side rebase failure");
  }
  const preparedHeadSha = (await mustGit(worktreePath, ["rev-parse", "HEAD"], "resolve prepared host worktree HEAD")).trim();
  return {
    repoPath: resolve9(worktreePath),
    cleanup: () => {},
    conflictPaths,
    plannerGuidance: buildPlannerGuidance(context, conflictPaths, rebasedCleanly),
    rebasedCleanly,
    currentHeadSha: preparedHeadSha
  };
}
async function refreshMergeConflictWorktreeHints(worktreePath, params) {
  const context = extractMergeConflictReviewContext(params);
  if (!context)
    return params;
  const unresolved = await mustGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], "refresh host-prepared unresolved conflict paths");
  const conflictPaths = extractConflictPaths(unresolved);
  const currentHeadSha = (await mustGit(worktreePath, ["rev-parse", "HEAD"], "refresh host-prepared worktree HEAD")).trim();
  return applyMergeConflictExecutionHints(params, {
    repoPath: resolve9(worktreePath),
    cleanup: () => {},
    conflictPaths,
    plannerGuidance: buildPlannerGuidance(context, conflictPaths, false),
    rebasedCleanly: false,
    currentHeadSha
  });
}

// apps/workerpals/src/execute_job.ts
var DEFAULT_CONFIG3 = loadPushPalsConfig();
var BROWSER_VALIDATION_MAX_AUTO_REVISIONS = 3;
var REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS = 4;
var CRITIC_COMPACT_RETRY_MIN_REDUCTION_RATIO = 0.25;
var MAX_DIAGNOSTIC_PATH_SAMPLES = 50;
var MAX_DIAGNOSTIC_TEXT_CHARS = 8000;
var QUALITY_MIN_REVISION_BUDGET_MS = 120000;
var QUALITY_MAX_REVISION_BUDGET_MS = 420000;
var QUALITY_REVISION_BUDGET_RATIO = 0.25;
var BROWSER_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 900000;
var BROWSER_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120000;
var REPO_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 900000;
var REPO_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120000;
var IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS = 600000;
var IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS = 120000;
function qualityRevisionLoopUpperBound(policy, opts = {}) {
  return Math.max(policy.maxAutoRevisions, policy.validationMaxAutoRevisions, opts.browserValidation ? BROWSER_VALIDATION_MAX_AUTO_REVISIONS : 0);
}
function qualityRevisionBudgetDecision(opts) {
  const executionBudgetMs = Number(opts.executionBudgetMs);
  if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
    return {
      shouldStart: true,
      remainingBudgetMs: Number.POSITIVE_INFINITY,
      minimumRevisionBudgetMs: 0
    };
  }
  const elapsedMs = Math.max(0, Number(opts.jobElapsedMs) || 0);
  const remainingBudgetMs = Math.max(0, Math.floor(executionBudgetMs - elapsedMs));
  const minimumRevisionBudgetMs = Math.floor(Math.min(executionBudgetMs, Math.max(QUALITY_MIN_REVISION_BUDGET_MS, Math.min(QUALITY_MAX_REVISION_BUDGET_MS, executionBudgetMs * QUALITY_REVISION_BUDGET_RATIO))));
  return {
    shouldStart: remainingBudgetMs >= minimumRevisionBudgetMs,
    remainingBudgetMs,
    minimumRevisionBudgetMs
  };
}
function browserValidationRepairContinuationBudgetDecision(opts) {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available"
    };
  }
  if (!opts.browserRepairPacket) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no browser validation repair packet"
    };
  }
  if (opts.validationOutsideTaskScope) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "browser validation failure is outside task scope"
    };
  }
  const publishablePaths = publishableChangedPaths(opts.changedPaths);
  if (publishablePaths.length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable browser repair patch is present"
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: BROWSER_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: BROWSER_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason: "browser validation repair made a publishable patch but exhausted the original revision budget"
  };
}
function shouldRepairOutsideTaskRequiredValidation(opts) {
  if (opts.validationFailureScope !== "outside_task_scope")
    return false;
  if (opts.requiredValidationFailures.length === 0)
    return false;
  if (opts.revisionAttempt >= opts.maxAutoRevisions)
    return false;
  return publishableChangedPaths(opts.changedPaths).length > 0;
}
function repoValidationRepairContinuationBudgetDecision(opts) {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available"
    };
  }
  if (!opts.repoValidationRepairMode) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "not in repo validation repair mode"
    };
  }
  if (publishableChangedPaths(opts.changedPaths).length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable patch is present"
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: REPO_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: REPO_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason: "repo validation repair has publishable work but exhausted the original revision budget"
  };
}
function inScopeValidationRepairContinuationBudgetDecision(opts) {
  if (opts.revisionBudget.shouldStart) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "standard revision budget is available"
    };
  }
  if (opts.requiredValidationFailures.length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no required validation failure is present"
    };
  }
  if (opts.validationOutsideTaskScope) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "validation failure is outside task scope"
    };
  }
  if (publishableChangedPaths(opts.changedPaths).length === 0) {
    return {
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable validation repair patch is present"
    };
  }
  return {
    shouldContinue: true,
    executionBudgetMs: IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_EXECUTION_BUDGET_MS,
    finalizationBudgetMs: IN_SCOPE_VALIDATION_REPAIR_CONTINUATION_FINALIZATION_BUDGET_MS,
    reason: "in-scope validation repair has publishable work but exhausted the original revision budget"
  };
}
function shouldSoftPassCriticOnlyBudgetExhaustion(opts) {
  if (!opts.softPassOnExhausted)
    return false;
  if (opts.deterministicRequiresRevision)
    return false;
  if (!opts.criticRequiresRevision)
    return false;
  if (opts.requiredValidationFailures.length > 0)
    return false;
  return publishableChangedPaths(opts.changedPaths).length > 0;
}
var MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS = 300000;
var MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS = 60000;
var MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS = 120000;
function mergeConflictResolverRetryBudgetDecision(opts) {
  const configuredExecutionBudgetMs = Number(opts.executionBudgetMs);
  if (!Number.isFinite(configuredExecutionBudgetMs) || configuredExecutionBudgetMs <= 0) {
    return {
      shouldStart: true,
      executionBudgetMs: MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS,
      finalizationBudgetMs: MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS,
      remainingTotalBudgetMs: Number.POSITIVE_INFINITY,
      minimumExecutionBudgetMs: MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS
    };
  }
  const configuredFinalizationBudgetMs = Math.max(0, Number(opts.finalizationBudgetMs) || 0);
  const elapsedMs = Math.max(0, Number(opts.jobElapsedMs) || 0);
  const remainingTotalBudgetMs = Math.max(0, Math.floor(configuredExecutionBudgetMs + configuredFinalizationBudgetMs - elapsedMs));
  const finalizationBudgetMs = Math.min(MERGE_CONFLICT_RETRY_FINALIZATION_BUDGET_MS, configuredFinalizationBudgetMs, remainingTotalBudgetMs);
  const availableExecutionBudgetMs = Math.max(0, remainingTotalBudgetMs - finalizationBudgetMs);
  const executionBudgetMs = Math.min(MERGE_CONFLICT_RETRY_EXECUTION_BUDGET_MS, Math.floor(availableExecutionBudgetMs));
  return {
    shouldStart: executionBudgetMs >= MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS,
    executionBudgetMs: Math.max(1e4, executionBudgetMs),
    finalizationBudgetMs,
    remainingTotalBudgetMs,
    minimumExecutionBudgetMs: MERGE_CONFLICT_MIN_RETRY_EXECUTION_BUDGET_MS
  };
}
function shouldRetryCriticTimeoutWithCompact(opts) {
  if (opts.timeoutBehavior !== "retry_once")
    return false;
  if (!opts.qualityOk || !opts.validationPassed)
    return true;
  const initialPromptChars = Math.max(1, Math.floor(opts.initialPromptChars));
  const compactPromptChars = Math.max(0, Math.floor(opts.compactPromptChars));
  const reductionRatio = 1 - compactPromptChars / initialPromptChars;
  return reductionRatio >= CRITIC_COMPACT_RETRY_MIN_REDUCTION_RATIO;
}
function shouldSkipCriticAfterExecutorTimeout(opts) {
  if (opts.executor !== "openai_codex")
    return false;
  if (opts.policyMode !== "default")
    return false;
  if (!opts.qualityOk || !opts.validationPassed)
    return false;
  if (opts.qualityIssues.length > 0 || opts.changedPaths.length === 0)
    return false;
  return /\b(openai_codex|codex(?: exec)?)\b[^\r\n]*\btimed out\b/i.test(opts.executorText);
}
function shouldSkipCriticForDeterministicValidationRevision(opts) {
  if (!opts.deterministicRequiresRevision || opts.validationOutsideTaskScope)
    return false;
  return opts.validationRuns.some(isDeterministicFastValidationFailure);
}
function shouldSkipCriticToPreserveRevisionBudget(opts) {
  if (!opts.deterministicRequiresRevision)
    return false;
  const remainingBudgetMs = Math.max(0, Math.floor(opts.remainingBudgetMs));
  const minimumRevisionBudgetMs = Math.max(0, Math.floor(opts.minimumRevisionBudgetMs));
  const criticTimeoutMs = Math.max(0, Math.floor(opts.criticTimeoutMs));
  const criticAttempts = opts.criticTimeoutBehavior === "retry_once" ? 2 : 1;
  const criticWorstCaseMs = criticTimeoutMs * criticAttempts;
  return remainingBudgetMs < minimumRevisionBudgetMs + criticWorstCaseMs;
}
function workerAttemptRolloutScore(params) {
  let score = 0;
  const reasons = [];
  const publishable = publishableChangedPaths(params.changedPaths);
  if (publishable.length > 0) {
    score += 35;
    reasons.push("publishable_diff");
  } else if (params.changedPaths.length > 0) {
    score -= 35;
    reasons.push("artifact_only_diff");
  } else {
    score -= 20;
    reasons.push("no_diff");
  }
  const passedFast = params.validationRuns.filter((run) => run.ok && !isLongRunningBrowserValidationCommand(run.command)).length;
  const failedFast = params.validationRuns.filter((run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command)).length;
  if (passedFast > 0) {
    score += Math.min(20, passedFast * 8);
    reasons.push("fast_validation_passed");
  }
  if (failedFast > 0) {
    score -= Math.min(20, failedFast * 8);
    reasons.push("fast_validation_failed");
  }
  if (params.validationRuns.some((run) => run.ok && isLongRunningBrowserValidationCommand(run.command))) {
    score += 15;
    reasons.push("long_validation_passed");
  }
  if (params.qualityIssues.length === 0) {
    score += 20;
    reasons.push("quality_clean");
  } else {
    score -= Math.min(30, params.qualityIssues.length * 6);
    reasons.push("quality_issues");
  }
  if (typeof params.criticScore === "number" && Number.isFinite(params.criticScore)) {
    score += Math.max(-20, Math.min(20, Math.round((params.criticScore - 8) * 5)));
    reasons.push("critic_scored");
  }
  const totalElapsedMs = Math.max(0, params.executorElapsedMs + params.qualityElapsedMs);
  if (totalElapsedMs > 1800000) {
    score -= 20;
    reasons.push("over_30m");
  } else if (totalElapsedMs <= 1200000) {
    score += 10;
    reasons.push("under_20m");
  }
  return {
    score: Math.max(-100, Math.min(100, score)),
    reasons: reasons.slice(0, 8)
  };
}
function taskRequestsBrowserValidation(params) {
  const candidates = [];
  const collect = (value) => {
    if (typeof value === "string") {
      candidates.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value)
        collect(item);
    }
  };
  const planning = params.planning && typeof params.planning === "object" ? params.planning : {};
  collect(planning.requiredValidationSteps);
  collect(planning.validationSteps);
  collect(params.requiredValidationSteps);
  collect(params.validationSteps);
  collect(params.instruction);
  return candidates.some((candidate) => isLongRunningBrowserValidationCommand(candidate));
}
function shouldSoftPassValidationBlocker(policy, blocker) {
  if (!blocker)
    return false;
  if (!policy.softPassOnExhausted)
    return false;
  return policy.mode === "review_fix" || policy.mode === "merge_conflict";
}
function shouldReviseRequiredValidationBlocker(opts) {
  if (opts.requiredValidationFailures.length === 0)
    return false;
  if (!opts.blocker)
    return false;
  if (opts.outsideTaskScope && !opts.allowOutsideTaskScope)
    return false;
  if (opts.blocker.category !== "repo")
    return false;
  return opts.revisionAttempt < opts.maxAutoRevisions;
}
function revisionLimitForQualityGateFailures(opts) {
  const hasValidationGateFailure = opts.requiredValidationFailures.length > 0 || opts.blocker !== null || opts.qualityIssues.some((issue) => issue.startsWith("ValidationGate:"));
  if (!hasValidationGateFailure)
    return opts.policy.maxAutoRevisions;
  if (opts.browserRepairPacket) {
    return Math.max(opts.policy.validationMaxAutoRevisions, BROWSER_VALIDATION_MAX_AUTO_REVISIONS);
  }
  if (opts.requiredValidationFailures.length > 0 && opts.blocker?.category === "repo") {
    return Math.max(opts.policy.validationMaxAutoRevisions, REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS);
  }
  return opts.policy.validationMaxAutoRevisions;
}
function shouldCommit(kind, runtimeConfig = DEFAULT_CONFIG3) {
  const configured = Array.isArray(runtimeConfig.workerpals.fileModifyingJobs) ? runtimeConfig.workerpals.fileModifyingJobs : [];
  const fallback = ["task.execute"];
  const jobs = configured.length > 0 ? configured : fallback;
  return jobs.includes(kind);
}
function outputPolicyForRuntime(runtimeConfig) {
  return {
    maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
    maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
    maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
    executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix
  };
}
function toSingleLine(value, max = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text)
    return "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}
function redactSensitiveText(value) {
  let out = String(value ?? "");
  if (!out)
    return "";
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  out = out.replace(/https%3a\/\/[^@\s/]+@/gi, "https%3A//***@");
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-:+/=]+\b/gi, "$1***");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  out = out.replace(/\bglpat-[A-Za-z0-9\-_]{20,}\b/gi, "glpat-***");
  return out;
}
function buildCriticRevisionIssues(critic, qualityCriticMinScore) {
  if (!critic)
    return [];
  if (critic.score >= qualityCriticMinScore)
    return [];
  const issues = [
    `Critic score ${critic.score.toFixed(1)} is below required threshold ${qualityCriticMinScore}.`
  ];
  const mustFix = Array.isArray(critic.mustFix) ? critic.mustFix : [];
  const findings = Array.isArray(critic.findings) ? critic.findings : [];
  const revisionGuidance = String(critic.revisionGuidance ?? "").trim();
  const actionableItems = (mustFix.length > 0 ? mustFix : findings).map((entry) => toSingleLine(entry, 180)).filter(Boolean).slice(0, 3);
  for (const item of actionableItems) {
    issues.push(mustFix.length > 0 ? `Critic must-fix: ${item}` : `Critic finding: ${item}`);
  }
  if (revisionGuidance) {
    issues.push(`Critic revision guidance: ${toSingleLine(revisionGuidance, 220)}`);
  }
  return issues;
}
function buildQualityGateRevisionIssues(qualityIssues, critic, qualityCriticMinScore) {
  const normalizedQualityIssues = qualityIssues.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (!critic || critic.score >= qualityCriticMinScore) {
    return [...normalizedQualityIssues];
  }
  const merged = [
    ...normalizedQualityIssues,
    ...buildCriticRevisionIssues(critic, qualityCriticMinScore)
  ];
  return [...new Set(merged)];
}
function buildDiffBudgetWarning(planning, changedPaths, focusedBrowserRepair) {
  const meaningfulChangedPaths = changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
  if (meaningfulChangedPaths.length === 0)
    return null;
  const explicitBudget = Number(planning.scope.maxFilesToEdit);
  const hasExplicitBudget = Number.isFinite(explicitBudget) && explicitBudget > 0;
  const smallTask = focusedBrowserRepair || planning.riskLevel !== "high" && (planning.targetPaths?.length ?? 0) <= 2 && planning.acceptanceCriteria.length <= 3;
  const budget = hasExplicitBudget ? Math.floor(explicitBudget) : smallTask ? 5 : 10;
  if (meaningfulChangedPaths.length <= budget)
    return null;
  return `Diff budget warning: this task now changes ${meaningfulChangedPaths.length} file(s), above the ${budget}-file ${hasExplicitBudget ? "planning.scope.maxFilesToEdit" : smallTask ? "small-task" : "default"} budget. Before editing more, remove unrelated churn and keep only behavior-owning files needed for the current repair. Changed files: ${meaningfulChangedPaths.slice(0, 12).join(", ")}${meaningfulChangedPaths.length > 12 ? ", ..." : ""}`;
}
function isNonPublishableArtifactPath(path) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (/^Microsoft\/Windows\/PowerShell\/(?:ModuleAnalysisCache|PSReadLine(?:\/|$))/i.test(normalized)) {
    return true;
  }
  return /(^|\/)(outputs|node_modules|\.worktrees|\.codex|dist|build|coverage)(\/|$)/i.test(normalized);
}
function isNestedNodeModulesChange(path) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  return /(^|\/)node_modules\/.+/i.test(normalized);
}
function publishableChangedPaths(changedPaths) {
  return changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
}
function compactDiagnosticText(value, maxChars = MAX_DIAGNOSTIC_TEXT_CHARS) {
  const text = String(value ?? "").replace(/\s+$/g, "");
  if (!text.trim())
    return null;
  return text.length <= maxChars ? text : text.slice(Math.max(0, text.length - maxChars));
}
function diagnosticPathSample(paths, limit = MAX_DIAGNOSTIC_PATH_SAMPLES) {
  const out = [];
  const seen = new Set;
  for (const raw of paths) {
    const path = String(raw ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (!path || seen.has(path))
      continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit)
      break;
  }
  return out;
}
function diagnosticTopLevelDirs(paths) {
  const seen = new Set;
  for (const path of paths) {
    const normalized = String(path ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (!normalized)
      continue;
    const top = normalized.includes("/") ? normalized.split("/", 1)[0] : normalized;
    if (top)
      seen.add(top);
    if (seen.size >= 20)
      break;
  }
  return [...seen];
}
function buildPatchSnapshotDiagnostics(changedPaths, attempt, phase) {
  const publishable = publishableChangedPaths(changedPaths);
  const artifactOnly = changedPaths.filter((path) => isNonPublishableArtifactPath(path));
  return {
    attempt,
    phase,
    publishableFileCount: publishable.length,
    artifactOnlyPathCount: artifactOnly.length,
    changedPathSample: diagnosticPathSample(changedPaths),
    topLevelDirs: diagnosticTopLevelDirs(publishable.length > 0 ? publishable : changedPaths),
    capturedAt: new Date().toISOString()
  };
}
function isDockerDaemonValidationBlocker(value) {
  const socketUnavailable = /\/var\/run\/docker\.sock/i.test(value) && /\b(?:cannot connect|failed to connect|permission denied|operation not permitted|eacces|eperm)\b/i.test(value);
  return socketUnavailable || /cannot connect to (?:the )?docker daemon/i.test(value) || /is the docker daemon running/i.test(value) || /docker daemon is not running/i.test(value) || /failed to connect to the docker api/i.test(value);
}
function classifyValidationRunFailure(run) {
  if (run.ok)
    return null;
  const combined = `${run.command}
${run.stdout}
${run.stderr}`.toLowerCase();
  const command = run.command.toLowerCase();
  const output = `${run.stdout}
${run.stderr}`.toLowerCase();
  if (isDockerDaemonValidationBlocker(combined)) {
    return "environment";
  }
  if (run.exitCode === 124 || /\b(?:command|process|request|connection|validation|test|browser|playwright|executor)\s+timed out\b/i.test(combined) || /\btimeout(?:error)?\b[^a-z0-9]*(?:after|exceeded|expired)/i.test(combined)) {
    return "timeout";
  }
  if (run.exitCode === 127 || combined.includes("missing required tool") || combined.includes("command not found") || combined.includes("executable not found") || combined.includes("not recognized as an internal or external command")) {
    return "missing_tool";
  }
  if (/(?:browser|playwright|cypress|web:e2e)/.test(command) || /\b(?:playwright|cypress|locator|screenshot)\b|page\.(?:goto|waitfor|locator|click|fill)/.test(output)) {
    return "browser_validation";
  }
  if (/cannot find module|import error|does not provide an export|no exported member|mock/.test(combined)) {
    return "test_harness";
  }
  return "nonzero_exit";
}
function buildValidationRunDiagnostics(runs, attempt) {
  return runs.slice(0, 20).map((run) => ({
    attempt,
    command: run.command,
    exitCode: run.exitCode,
    durationMs: run.elapsedMs,
    passed: run.ok,
    failureClass: classifyValidationRunFailure(run),
    stdoutTail: compactDiagnosticText(run.stdout),
    stderrTail: compactDiagnosticText(run.stderr)
  }));
}
function inferTerminalFailureClass(result, changedPaths) {
  if (result.ok)
    return "success";
  const summaryText = `${result.summary ?? ""}`.toLowerCase();
  const text = `${result.summary ?? ""}
${result.stderr ?? ""}
${result.stdout ?? ""}`.toLowerCase();
  const publishableCount = publishableChangedPaths(changedPaths).length;
  if (text.includes("stalled before first response") || text.includes("startup stall")) {
    return "codex_startup_stall";
  }
  if (summaryText.includes("validationgate") || summaryText.includes("validation")) {
    return "validation";
  }
  if (changedPaths.length > 0 && publishableCount === 0)
    return "artifact_only_no_publishable_patch";
  if (result.exitCode === 124 || text.includes("timed out") || text.includes("timeout"))
    return "timeout";
  if (text.includes("validationgate") || text.includes("validation"))
    return "validation";
  if (text.includes("scopegate") || text.includes("scope"))
    return "scope";
  if (text.includes("criticgate") || text.includes("critic"))
    return "critic";
  if (text.includes("publish"))
    return "publish";
  if (text.includes("shell-wrapper") || text.includes("command-router"))
    return "command_policy";
  return "executor_failure";
}
function inferTerminalStage(result, fallback) {
  if (fallback === "validation_circuit_breaker" || fallback === "trusted_environment_validation_required") {
    return fallback;
  }
  const text = `${result.summary ?? ""}
${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("stalled before first response") || text.includes("startup stall")) {
    return "executor_startup";
  }
  if (text.includes("validationgate") || text.includes("validation"))
    return "validation";
  if (text.includes("scopegate") || text.includes("scope"))
    return "scope";
  if (text.includes("criticgate") || text.includes("critic"))
    return "critic";
  if (text.includes("publish"))
    return "publish";
  if (text.includes("quality gate"))
    return "quality";
  if (text.includes("codex") || text.includes("executor"))
    return "executor";
  return fallback;
}
function mergeJobDiagnostics(base, extra) {
  return {
    ...base ?? {},
    ...extra,
    attempts: [...base?.attempts ?? [], ...extra.attempts ?? []],
    phaseSpans: [...base?.phaseSpans ?? [], ...extra.phaseSpans ?? []],
    validationRuns: [...base?.validationRuns ?? [], ...extra.validationRuns ?? []],
    patchSnapshots: [...base?.patchSnapshots ?? [], ...extra.patchSnapshots ?? []],
    terminal: extra.terminal ?? base?.terminal,
    metadata: {
      ...base?.metadata ?? {},
      ...extra.metadata ?? {}
    }
  };
}
function withJobDiagnostics(result, diagnostics) {
  return {
    ...result,
    diagnostics: mergeJobDiagnostics(result.diagnostics, diagnostics)
  };
}
function buildTerminalDiagnostics(args) {
  const publishable = publishableChangedPaths(args.changedPaths);
  const artifactOnly = args.changedPaths.filter((path) => isNonPublishableArtifactPath(path));
  const text = `${args.result.summary ?? ""}
${args.result.stderr ?? ""}
${args.result.stdout ?? ""}`;
  return {
    failureClass: inferTerminalFailureClass(args.result, args.changedPaths),
    terminalStage: inferTerminalStage(args.result, args.terminalStage),
    executorBackend: args.executor,
    summary: compactDiagnosticText(args.result.summary, 1000),
    watchdogFired: /watchdog|rollout coach|stalled before first response|startup stall/i.test(text),
    timeoutMs: args.timeoutMs ?? null,
    publishableFileCount: publishable.length,
    artifactOnlyPathCount: artifactOnly.length,
    changedPathSample: diagnosticPathSample(args.changedPaths),
    metadata: args.metadata
  };
}
function collectPlanningText(planning) {
  return [
    planning.intent,
    planning.riskLevel,
    ...planning.targetPaths ?? [],
    ...planning.acceptanceCriteria ?? [],
    ...planning.validationSteps ?? [],
    ...planning.requiredValidationSteps ?? [],
    ...planning.repoHintDiagnostics ?? [],
    ...planning.discovery?.keywords ?? [],
    ...planning.discovery?.likelyDirs ?? [],
    ...planning.discovery?.ripgrepQueries ?? []
  ].map((part) => String(part ?? "")).join(`
`).toLowerCase();
}
function planningLooksLikeVisualDerivationTask(planning) {
  const text = collectPlanningText(planning);
  return /\b(visual|readability|battlefield|render(?:ing)?|projectile|planet|ship|ring|danger|threat|ownership|dense action|style|ui surface)\b/i.test(text);
}
function buildTestHarnessConvergenceWarning(planning, issues, validationRuns) {
  const combined = [
    ...issues,
    ...validationRuns.flatMap((run) => [run.command, run.stdout, run.stderr])
  ].map((part) => String(part ?? "")).join(`
`);
  const hasMockImportFailure = /\bCannot find module\b|\bdoes not provide an export\b|\bno exported member\b|\bimport error\b|\bundefined is not a function\b/i.test(combined) && /\b(react[- ]native|reactNativeMock|Animated\.View|expo-secure-store|SettingsContext|skin validator|mock|test helper|__mocks__)\b/i.test(combined);
  if (!hasMockImportFailure)
    return null;
  const visualPrefix = planningLooksLikeVisualDerivationTask(planning) ? " For this visual/rendering task, prefer pure helper/state/style-prop tests over a full React Native surface render." : "";
  return "Test harness convergence warning: validation is failing in mock/import setup rather than product behavior." + visualPrefix + " Do not keep expanding broad shared mocks to rescue an over-scoped component render test. If the repo does not already have stable React Native render-test infrastructure for this surface, replace the full-surface regression with smaller deterministic helper/state coverage and one focused assertion on the behavior-owning API.";
}
function buildBroadSharedMockWarning(planning, changedPaths) {
  const meaningfulChangedPaths = changedPaths.filter((path) => !isNonPublishableArtifactPath(path));
  const broadMockPaths = meaningfulChangedPaths.filter((path) => /(^|\/)(__mocks__|tests\/.*mock|test.*mock|reactNativeMock|setupTests?|jest\.|vitest\.|mock)(\.|\/|$)/i.test(path));
  if (broadMockPaths.length === 0)
    return null;
  const smallTask = planning.riskLevel !== "high" && ((planning.targetPaths?.length ?? 0) <= 2 || planning.acceptanceCriteria.length <= 3);
  if (!smallTask && !planningLooksLikeVisualDerivationTask(planning))
    return null;
  const explicitlyRequested = /mock|test harness|react native test|component render/i.test(collectPlanningText(planning));
  if (explicitlyRequested)
    return null;
  return `Broad mock warning: this focused task now changes shared mock/test-harness file(s): ${broadMockPaths.slice(0, 6).join(", ")}${broadMockPaths.length > 6 ? ", ..." : ""}. Before continuing, prefer behavior-owned helper/state tests or existing stable render-test infrastructure; do not add broad React Native mocks for a small visual/control change unless the task explicitly requires harness repair.`;
}
var TEST_ASSERTION_BALANCE_ISSUE = "Changed test files do not show both positive and negative assertion coverage (expected both).";
function isAssertionBalanceIssue(issue) {
  return issue === TEST_ASSERTION_BALANCE_ISSUE || issue.includes("positive and negative assertion coverage");
}
function relaxAdvisoryQualityIssues(qualityIssues, validationRuns, critic, qualityCriticMinScore) {
  const normalizedQualityIssues = qualityIssues.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (normalizedQualityIssues.length === 0)
    return [];
  const hasPassingValidation = validationRuns.some((run) => Boolean(run?.ok));
  const criticPasses = !critic || critic.score >= qualityCriticMinScore;
  if (!hasPassingValidation || !criticPasses) {
    return normalizedQualityIssues;
  }
  const relaxed = normalizedQualityIssues.filter((issue) => !isAssertionBalanceIssue(issue));
  return relaxed;
}
function resolveReviewFixCompletionBranch(value, fallbackBranch) {
  if (typeof value !== "string") {
    return { branch: fallbackBranch, overridden: false };
  }
  const trimmed = value.trim();
  if (!trimmed)
    return { branch: fallbackBranch, overridden: false };
  const withoutPrefix = trimmed.replace(/^refs\/heads\//, "");
  const normalized = withoutPrefix.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("agent/"))
    return { branch: fallbackBranch, overridden: false };
  if (normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    return { branch: fallbackBranch, overridden: false };
  }
  if (/[~^:?*\[\]\s]/.test(normalized))
    return { branch: fallbackBranch, overridden: false };
  return { branch: normalized, overridden: true };
}
function resolveReviewNoChangeCompletionBranch(params) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const reviewAgent = params.reviewAgent && typeof params.reviewAgent === "object" && !Array.isArray(params.reviewAgent) ? params.reviewAgent : null;
  const reviewAgentHeadRef = reviewAgent?.prHeadRef;
  const candidate = params.completionBranch ?? reviewAgentHeadRef;
  const resolved = resolveReviewFixCompletionBranch(candidate, "");
  return resolved.overridden ? resolved.branch : null;
}
function toFiniteReviewScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    return null;
  return Math.max(0, Math.min(10, parsed));
}
function toNonEmptyReviewStringArray(value, limit = 8) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, limit);
}
function extractReviewFixContext(params) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return null;
  const reviewAgent = params.reviewAgent && typeof params.reviewAgent === "object" && !Array.isArray(params.reviewAgent) ? params.reviewAgent : null;
  if (!reviewAgent)
    return null;
  const resolutionType = String(reviewAgent.resolutionType ?? "").trim().toLowerCase();
  if (resolutionType === "merge_conflict")
    return null;
  const looksLikeLegacyReviewFix = typeof reviewAgent.prHeadRef === "string" || typeof reviewAgent.previousReviewSummary === "string" || Number.isFinite(Number(reviewAgent.previousReviewScore)) || Array.isArray(reviewAgent.reviewerFindings);
  if (resolutionType && resolutionType !== "review_fix")
    return null;
  if (!resolutionType && !looksLikeLegacyReviewFix)
    return null;
  return {
    resolutionType: "review_fix",
    prHeadRef: typeof reviewAgent.prHeadRef === "string" ? reviewAgent.prHeadRef.trim() || null : null,
    prBaseRef: typeof reviewAgent.prBaseRef === "string" ? reviewAgent.prBaseRef.trim() || null : null,
    previousReviewScore: toFiniteReviewScore(reviewAgent.previousReviewScore),
    reviewThreshold: toFiniteReviewScore(reviewAgent.reviewThreshold),
    previousReviewSummary: String(reviewAgent.previousReviewSummary ?? "").trim(),
    reviewerFindings: toNonEmptyReviewStringArray(reviewAgent.reviewerFindings)
  };
}
function shouldEnqueueNoChangeReviewCompletion(params) {
  return extractReviewFixContext(params) == null;
}
function deriveQualityGatePolicy(params, runtimeConfig = DEFAULT_CONFIG3) {
  const baseMaxAutoRevisions = Math.max(0, Math.min(10, Number.isFinite(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions)) ? Math.floor(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions)) : 3));
  const baseValidationMaxAutoRevisions = Math.max(0, Math.min(10, Number.isFinite(Number(runtimeConfig.workerpals.qualityValidationMaxAutoRevisions)) ? Math.floor(Number(runtimeConfig.workerpals.qualityValidationMaxAutoRevisions)) : 3));
  const baseSoftPassOnExhausted = typeof runtimeConfig.workerpals.qualitySoftPassOnExhausted === "boolean" ? runtimeConfig.workerpals.qualitySoftPassOnExhausted : true;
  const gateSwitches = {
    scopeGateEnabled: typeof runtimeConfig.workerpals.qualityScopeGateEnabled === "boolean" ? runtimeConfig.workerpals.qualityScopeGateEnabled : true,
    validationGateEnabled: typeof runtimeConfig.workerpals.qualityValidationGateEnabled === "boolean" ? runtimeConfig.workerpals.qualityValidationGateEnabled : true,
    criticGateEnabled: typeof runtimeConfig.workerpals.qualityCriticGateEnabled === "boolean" ? runtimeConfig.workerpals.qualityCriticGateEnabled : true,
    publishGateEnabled: typeof runtimeConfig.workerpals.qualityPublishGateEnabled === "boolean" ? runtimeConfig.workerpals.qualityPublishGateEnabled : true
  };
  const baseCriticMinScore = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMinScore);
    if (!Number.isFinite(value))
      return 8;
    return Math.max(0, Math.min(10, value));
  })();
  const reviewFix = extractReviewFixContext(params);
  if (!reviewFix) {
    const mergeConflict = extractMergeConflictReviewContext(params);
    if (mergeConflict) {
      return {
        mode: "merge_conflict",
        maxAutoRevisions: baseMaxAutoRevisions,
        validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
        ...gateSwitches,
        softPassOnExhausted: baseSoftPassOnExhausted,
        criticMinScore: baseCriticMinScore
      };
    }
    return {
      mode: "default",
      maxAutoRevisions: baseMaxAutoRevisions,
      validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
      ...gateSwitches,
      softPassOnExhausted: baseSoftPassOnExhausted,
      criticMinScore: baseCriticMinScore
    };
  }
  const tightenedCriticMinScore = reviewFix.reviewThreshold != null ? Math.max(baseCriticMinScore, Math.max(0, Math.min(10, reviewFix.reviewThreshold - 0.2))) : baseCriticMinScore;
  return {
    mode: "review_fix",
    maxAutoRevisions: Math.max(baseMaxAutoRevisions, 2),
    validationMaxAutoRevisions: baseValidationMaxAutoRevisions,
    ...gateSwitches,
    softPassOnExhausted: baseSoftPassOnExhausted,
    criticMinScore: tightenedCriticMinScore
  };
}
function normalizeChatCompletionsEndpoint(endpoint) {
  const source = endpoint.trim().replace(/\/+$/, "");
  if (!source)
    return "http://127.0.0.1:1234/v1/chat/completions";
  if (source.endsWith("/chat/completions"))
    return source;
  if (source.endsWith("/v1"))
    return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}
function splitArgs(raw) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped)
    current += "\\";
  if (current.length > 0)
    out.push(current);
  return out;
}
function parseJsonObjectLoose(text) {
  const trimmed = text.trim();
  if (!trimmed)
    return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return null;
}
var COMMIT_MSG_MAX_DIFF_CHARS = 120000;
var COMMIT_MSG_LLM_MAX_CHANGED_PATHS = 20;
var COMMIT_MSG_GENERATOR_DEFAULT_TIMEOUT_MS = 15000;
var COMMIT_MSG_GENERATOR_MIN_TIMEOUT_MS = 3000;
var COMMIT_MSG_GENERATOR_MAX_TIMEOUT_MS = 30000;
var SHELL_CONTROL_TOKENS2 = new Set(["&&", "||", ";", "|"]);
var BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND = "bun install --offline --frozen-lockfile --ignore-scripts";
function tokenizeValidationCommandArgv(command) {
  const trimmed = command.trim();
  if (!trimmed)
    return null;
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const pushCurrent = () => {
    if (!current)
      return;
    out.push(current);
    current = "";
  };
  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === ">" || ch === "<" || ch === "`" || ch === "$") {
      return null;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  if (escaped)
    current += "\\";
  if (quote)
    return null;
  pushCurrent();
  if (out.length === 0)
    return null;
  if (out.some((token) => SHELL_CONTROL_TOKENS2.has(token)))
    return null;
  return out;
}
async function terminateValidationProcessTree(proc) {
  const pid = Number(proc.pid);
  if (process.platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe"
      });
      return;
    } catch {}
  }
  if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    await Bun.sleep(2000);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    return;
  }
  try {
    proc.kill();
  } catch {}
}
function captureValidationStream(stream, onChunk) {
  let text = "";
  let done = false;
  const reader = stream?.getReader();
  const promise = reader ? (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done)
          break;
        const chunk = Buffer.from(result.value).toString("utf8");
        text += chunk;
        onChunk?.(chunk);
      }
    } catch {} finally {
      done = true;
      try {
        reader.releaseLock();
      } catch {}
    }
  })() : Promise.resolve().then(() => {
    done = true;
  });
  return {
    cancel: async () => {
      try {
        await reader?.cancel();
      } catch {}
    },
    isDone: () => done,
    promise,
    text: () => text
  };
}
var DEFAULT_BROWSER_VALIDATION_FAILURE_IDLE_MS = 15000;
var DEFAULT_BROWSER_VALIDATION_SUCCESS_IDLE_MS = 1000;
function browserValidationFailureIdleMs(env) {
  const configured = Number(env.PUSHPALS_VALIDATION_FAILURE_IDLE_MS ?? "");
  if (Number.isFinite(configured) && configured >= 250) {
    return Math.min(120000, Math.trunc(configured));
  }
  return DEFAULT_BROWSER_VALIDATION_FAILURE_IDLE_MS;
}
function browserValidationSuccessIdleMs(env) {
  const configured = Number(env.PUSHPALS_VALIDATION_SUCCESS_IDLE_MS ?? "");
  if (Number.isFinite(configured) && configured >= 250) {
    return Math.min(120000, Math.trunc(configured));
  }
  return DEFAULT_BROWSER_VALIDATION_SUCCESS_IDLE_MS;
}
function hasBrowserValidationFailureSignal(output) {
  const text = String(output ?? "");
  if (!text.trim())
    return false;
  const patterns = [
    /\bAssertionError\b/i,
    /\bTimeoutError\b/i,
    /\bWeb end-to-end smoke test failed:/i,
    /\bexpect\([^)]*\)\.[a-z0-9_]+\([^)]*\)\s+failed/i,
    /\bError:\s+expect\(/i,
    /\blocator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded\b/i,
    /\bpage\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded\b/i,
    /\bTimeout\s+\d+ms\s+exceeded\b/i,
    /\bTest timeout of \d+ms exceeded\b/i,
    /\bCall log:\s*(?:\r?\n|$)/i,
    /\bwaiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)]*\)/i,
    /\bpage\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+/i,
    /\bbrowserType\.launch:/i,
    /\bERR_SOCKET_BAD_PORT\b/i,
    /\blisten\s+EPERM\b/i,
    /\bEADDRINUSE\b/i,
    /\berror:\s+script\s+"[^"]+"\s+exited with code\s+\d+/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}
function hasBrowserValidationSuccessSignal(output) {
  const text = String(output ?? "");
  if (!text.trim())
    return false;
  const patterns = [
    /\bWeb end-to-end smoke test completed successfully\./i,
    /\bWeb smoke test completed successfully\./i,
    /\bBrowser smoke test completed successfully\./i
  ];
  return patterns.some((pattern) => pattern.test(text));
}
async function runValidationArgv(repo, command, argv, env, timeoutMs, outputPolicy, timeoutMessage) {
  const startedAt = Date.now();
  const spawnEnv = withResolvedBunOnPath(env);
  const spawnArgv = prepareValidationSpawnArgv(argv, spawnEnv);
  let proc;
  try {
    proc = Bun.spawn(spawnArgv, {
      cwd: repo,
      env: spawnEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32"
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      step: command,
      command,
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: compactJobOutput([`Validation command could not start executable "${spawnArgv[0] ?? ""}".`, detail].filter(Boolean).join(`
`), outputPolicy),
      elapsedMs: Math.max(1, Date.now() - startedAt)
    };
  }
  let lastOutputAt = Date.now();
  const noteOutput = () => {
    lastOutputAt = Date.now();
  };
  const stdoutCapture = captureValidationStream(proc.stdout ?? null, noteOutput);
  const stderrCapture = captureValidationStream(proc.stderr ?? null, noteOutput);
  let timedOut = false;
  let stoppedAfterFailureSignal = false;
  let stoppedAfterSuccessSignal = false;
  const timeout = Math.max(1000, timeoutMs);
  let timeoutTimer = null;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      resolveTimeout({ type: "timeout" });
    }, timeout);
  });
  let browserSignalTimer = null;
  const browserSignalPromise = isLongRunningBrowserValidationCommand(command) ? new Promise((resolveBrowserSignal) => {
    const idleMs = browserValidationFailureIdleMs(spawnEnv);
    const successIdleMs = browserValidationSuccessIdleMs(spawnEnv);
    browserSignalTimer = setInterval(() => {
      const combinedOutput = `${stdoutCapture.text()}
${stderrCapture.text()}`;
      if (hasBrowserValidationFailureSignal(combinedOutput) && Date.now() - lastOutputAt >= idleMs) {
        stoppedAfterFailureSignal = true;
        resolveBrowserSignal({ type: "failure-signal" });
        return;
      }
      if (hasBrowserValidationSuccessSignal(combinedOutput) && Date.now() - lastOutputAt >= successIdleMs) {
        stoppedAfterSuccessSignal = true;
        resolveBrowserSignal({ type: "success-signal" });
      }
    }, 250);
  }) : new Promise(() => {});
  const exitOrTimeout = await Promise.race([
    proc.exited.then((code) => ({ type: "exit", code })),
    timeoutPromise,
    browserSignalPromise
  ]);
  if (timeoutTimer)
    clearTimeout(timeoutTimer);
  if (browserSignalTimer)
    clearInterval(browserSignalTimer);
  if (timedOut || stoppedAfterFailureSignal || stoppedAfterSuccessSignal) {
    await terminateValidationProcessTree(proc);
  }
  const exitCode = exitOrTimeout.type === "timeout" ? 124 : exitOrTimeout.type === "failure-signal" ? 1 : exitOrTimeout.type === "success-signal" ? 0 : exitOrTimeout.code;
  if (!timedOut && !stoppedAfterFailureSignal && !stoppedAfterSuccessSignal) {
    await Promise.race([
      Promise.all([stdoutCapture.promise, stderrCapture.promise]),
      Bun.sleep(1000)
    ]);
    if (!stdoutCapture.isDone() || !stderrCapture.isDone()) {
      await terminateValidationProcessTree(proc);
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    }
  } else {
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
  }
  await Promise.race([Promise.all([stdoutCapture.promise, stderrCapture.promise]), Bun.sleep(500)]);
  return {
    step: command,
    command,
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout: compactJobOutput(stdoutCapture.text().trim(), outputPolicy),
    stderr: compactJobOutput([
      stderrCapture.text().trim(),
      timedOut ? timeoutMessage : "",
      stoppedAfterFailureSignal ? `Validation command emitted a browser/e2e failure signal and then produced no output for ${browserValidationFailureIdleMs(spawnEnv)}ms. PushPals terminated the leaked process tree and preserved the captured failure output for repair.` : ""
    ].filter(Boolean).join(`
`), outputPolicy),
    elapsedMs: Math.max(1, Date.now() - startedAt)
  };
}
async function runValidationCommand(repo, command, timeoutMs, outputPolicy) {
  const env = buildWorkerSandboxWritableEnv(repo);
  const argv = prepareValidationCommandArgv(command, env);
  if (!argv) {
    return {
      step: command,
      command,
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: "Validation command could not be parsed safely. Use a plain command without shell chaining/pipes.",
      elapsedMs: 1
    };
  }
  return runValidationArgv(repo, command, argv, env, timeoutMs, outputPolicy, `Validation command timed out after ${Math.max(1000, timeoutMs)}ms. Captured output is the process output emitted before PushPals terminated the command and its process tree.`);
}
function isRepoAggregateValidationCommand(repo, command) {
  const resolvedScript = resolvePackageScriptForValidationCommand(repo, command);
  if (!resolvedScript)
    return false;
  if (/(?:^|:)(?:validate|validation|readiness|verify)(?:$|:)/i.test(resolvedScript.scriptName)) {
    return true;
  }
  const text = `${resolvedScript.script}
${readReferencedValidationScriptText(resolvedScript.cwd, resolvedScript.script)}`.toLowerCase();
  const layers = [
    /\b(?:bun|npm|pnpm|yarn|vitest|jest)\b[\s\S]{0,80}\btest\b/.test(text),
    /\blint\b/.test(text),
    /\b(?:typecheck|tsc)\b/.test(text),
    /\b(?:e2e|playwright|browser)\b/.test(text)
  ].filter(Boolean).length;
  return layers >= 2;
}
var REPO_VALIDATION_LEASE_HEARTBEAT_INTERVAL_MS = 5000;
var REPO_VALIDATION_LEASE_HEARTBEAT_STALE_MS = 30000;
var LEGACY_REPO_VALIDATION_LEASE_STALE_MS = 90 * 60000;
function validationLeaseHostId() {
  return String(process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "").trim();
}
function readRepoValidationLeaseOwner(ownerPath) {
  try {
    const parsed = JSON.parse(readFileSync8(ownerPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function repoValidationLeaseRecoveryReason(opts) {
  const ownerHost = typeof opts.owner?.host === "string" ? opts.owner.host.trim() : "";
  const ownerPid = typeof opts.owner?.pid === "number" && Number.isInteger(opts.owner.pid) ? opts.owner.pid : null;
  if (ownerHost && opts.currentHost && ownerHost === opts.currentHost && ownerPid !== null && opts.ownerProcessAlive === false) {
    return "dead owner process";
  }
  const ageMs = Math.max(0, opts.nowMs - opts.ownerMtimeMs);
  if (opts.owner?.heartbeatVersion === 1) {
    return ageMs > REPO_VALIDATION_LEASE_HEARTBEAT_STALE_MS ? "stale heartbeat" : null;
  }
  return ageMs > LEGACY_REPO_VALIDATION_LEASE_STALE_MS ? "stale legacy lease" : null;
}
async function acquireRepoValidationLease(repo, command, onLog) {
  if (!isRepoAggregateValidationCommand(repo, command))
    return () => {};
  const commonDirResult = await git2(repo, ["rev-parse", "--git-common-dir"]);
  if (!commonDirResult.ok || !commonDirResult.stdout.trim())
    return () => {};
  const commonDir = resolve10(repo, commonDirResult.stdout.trim());
  const leaseParent = resolve10(commonDir, "pushpals");
  const leaseDir = resolve10(leaseParent, "validation-lease");
  const ownerPath = resolve10(leaseDir, "owner.json");
  const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerHost = validationLeaseHostId();
  const waitStartedAt = Date.now();
  let lastWaitLogAt = 0;
  mkdirSync3(leaseParent, { recursive: true });
  while (Date.now() - waitStartedAt < 15 * 60000) {
    try {
      mkdirSync3(leaseDir);
      const acquiredAt = new Date().toISOString();
      const ownerRecord = {
        owner,
        command,
        acquiredAt,
        heartbeatAt: acquiredAt,
        heartbeatVersion: 1,
        pid: process.pid,
        host: ownerHost
      };
      try {
        writeFileSync4(ownerPath, JSON.stringify(ownerRecord), "utf8");
      } catch (error) {
        rmSync3(leaseDir, { recursive: true, force: true });
        throw error;
      }
      const heartbeat = setInterval(() => {
        try {
          const currentOwner = readRepoValidationLeaseOwner(ownerPath);
          if (currentOwner?.owner !== owner) {
            clearInterval(heartbeat);
            return;
          }
          ownerRecord.heartbeatAt = new Date().toISOString();
          writeFileSync4(ownerPath, JSON.stringify(ownerRecord), "utf8");
        } catch {
          clearInterval(heartbeat);
        }
      }, REPO_VALIDATION_LEASE_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
      const waitedMs = Date.now() - waitStartedAt;
      onLog?.("stdout", `[ValidationGate] Acquired repo aggregate-validation lease${waitedMs >= 1000 ? ` after ${waitedMs}ms` : ""}: ${command}`);
      return () => {
        clearInterval(heartbeat);
        try {
          const currentOwner = readRepoValidationLeaseOwner(ownerPath);
          if (currentOwner?.owner === owner)
            rmSync3(leaseDir, { recursive: true, force: true });
        } catch {}
      };
    } catch {
      try {
        const currentOwner = readRepoValidationLeaseOwner(ownerPath);
        const ownerMtimeMs = statSync4(ownerPath).mtimeMs;
        const sameHost = Boolean(currentOwner?.host) && Boolean(ownerHost) && currentOwner?.host === ownerHost;
        const ownerProcessAlive = sameHost && typeof currentOwner?.pid === "number" ? isProcessAlive(currentOwner.pid) : null;
        const recoveryReason = repoValidationLeaseRecoveryReason({
          owner: currentOwner,
          ownerMtimeMs,
          nowMs: Date.now(),
          currentHost: ownerHost,
          ownerProcessAlive
        });
        if (recoveryReason) {
          rmSync3(leaseDir, { recursive: true, force: true });
          onLog?.("stderr", `[ValidationGate] Recovered repo validation lease (${recoveryReason}).`);
          continue;
        }
      } catch {}
      if (Date.now() - lastWaitLogAt >= 30000) {
        lastWaitLogAt = Date.now();
        onLog?.("stdout", `[ValidationGate] Waiting for another WorkerPal's aggregate validation to finish: ${command}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    }
  }
  return null;
}
async function runValidationCommandWithRepoLease(repo, command, timeoutMs, outputPolicy, onLog) {
  const release = await acquireRepoValidationLease(repo, command, onLog);
  if (!release) {
    return {
      step: command,
      command,
      ok: false,
      exitCode: 75,
      stdout: "",
      stderr: "Timed out waiting for the repo aggregate-validation lease. Another WorkerPal is still validating this repository; retry after it completes.",
      elapsedMs: 15 * 60000
    };
  }
  try {
    return await runValidationCommand(repo, command, timeoutMs, outputPolicy);
  } finally {
    release();
  }
}
function isLongRunningBrowserValidationCommand(command) {
  const normalized = validationCommandKey(command);
  if (!normalized)
    return false;
  const tokens = tokenizeValidationCommandArgv(command)?.map((token) => token.toLowerCase()) ?? [];
  const joined = tokens.join(" ");
  return /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke)\b/.test(normalized) || /\b(playwright|cypress)\b/.test(joined) || /\bexpo\b/.test(joined) && /\b(web|start)\b/.test(joined);
}
function textIncludesLongRunningBrowserValidation(text) {
  return /(?:^|[^a-z0-9_-])(?:web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke|playwright|cypress)(?:$|[^a-z0-9_-])/i.test(text) || /\bexpo\b[\s\S]{0,160}\b(?:--web|web|start)\b/i.test(text);
}
function validationCommandIncludesLongRunningBrowserWork(repo, command) {
  const visited = new Set;
  const visit = (cwd, currentCommand, depth) => {
    if (isLongRunningBrowserValidationCommand(currentCommand))
      return true;
    if (depth >= 8)
      return false;
    const resolvedScript = resolvePackageScriptForValidationCommand(cwd, currentCommand);
    if (!resolvedScript)
      return false;
    const visitKey = `${resolvedScript.cwd}\x00${resolvedScript.script}`;
    if (visited.has(visitKey))
      return false;
    visited.add(visitKey);
    const referencedText = readReferencedValidationScriptText(resolvedScript.cwd, resolvedScript.script);
    if (textIncludesLongRunningBrowserValidation(`${resolvedScript.script}
${referencedText}`)) {
      return true;
    }
    for (const match of resolvedScript.script.matchAll(/\b(bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9][A-Za-z0-9:._-]*)\b/gi)) {
      const packageManager = match[1] ?? "";
      const scriptName = match[2] ?? "";
      if (!packageManager || !scriptName)
        continue;
      if (visit(resolvedScript.cwd, `${packageManager} run ${scriptName}`, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return visit(repo, command, 0);
}
function textIncludesTestValidation(text) {
  if (/(?:^|[^a-z0-9_-])(?:bun|bunx|npm|npx|pnpm|yarn)\s+(?:run\s+)?test(?::[a-z0-9._-]+)?(?:$|[^a-z0-9_-])/im.test(text) || /(?:^|[^a-z0-9_-])(?:pytest|vitest|jest)(?:$|[^a-z0-9_-])/im.test(text) || /(?:^|[^a-z0-9_-])(?:python|python3)\s+-m\s+pytest(?:$|[^a-z0-9_-])/im.test(text) || /(?:^|[^a-z0-9_-])(?:go|cargo|make)\s+test(?:$|[^a-z0-9_-])/im.test(text)) {
    return true;
  }
  return /["'`](?:bun|bunx|npm|npx|pnpm|yarn)["'`][\s\S]{0,240}?\[\s*["'`](?:test|run["'`]\s*,\s*["'`]test(?::[a-z0-9._-]+)?)["'`]/i.test(text);
}
function validationCommandIncludesTestWork(repo, command) {
  const visited = new Set;
  const visit = (cwd, currentCommand, depth) => {
    if (isTestLikeValidationStep(currentCommand))
      return true;
    if (depth >= 8)
      return false;
    const resolvedScript = resolvePackageScriptForValidationCommand(cwd, currentCommand);
    if (!resolvedScript)
      return false;
    const visitKey = `${resolvedScript.cwd}\x00${resolvedScript.script}`;
    if (visited.has(visitKey))
      return false;
    visited.add(visitKey);
    const referencedText = readReferencedValidationScriptText(resolvedScript.cwd, resolvedScript.script);
    const aggregateText = `${resolvedScript.script}
${referencedText}`;
    if (textIncludesTestValidation(aggregateText))
      return true;
    for (const match of aggregateText.matchAll(/\b(bun|npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9][A-Za-z0-9:._-]*)\b/gi)) {
      const packageManager = match[1] ?? "";
      const scriptName = match[2] ?? "";
      if (!packageManager || !scriptName)
        continue;
      if (visit(resolvedScript.cwd, `${packageManager} run ${scriptName}`, depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return visit(repo, command, 0);
}
function isParallelSafeFastValidationCommand(repo, command) {
  if (isLongRunningBrowserValidationCommand(command))
    return false;
  if (shouldEnsurePlaywrightBrowserRuntime(repo, command))
    return false;
  const tokens = tokenizeValidationCommandArgv(command);
  if (!tokens || tokens.length === 0)
    return false;
  const lower = tokens.map((token) => token.toLowerCase());
  if (lower[0] !== "bun")
    return false;
  if (lower[1] === "test")
    return true;
  if (lower[1] === "x" && lower[2] === "tsc")
    return true;
  if (lower[1] === "run" && ["lint", "typecheck", "test", "test:unit"].includes(lower[2] ?? "")) {
    return true;
  }
  return false;
}
function isDeterministicFastValidationFailure(run) {
  if (run.ok || run.exitCode === 127 || isLongRunningBrowserValidationCommand(run.command)) {
    return false;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  if (!combined.trim())
    return false;
  return /\bCannot find module\b|\bmodule not found\b|\bfailed to resolve import\b|\bcould not resolve\b|\bNo such file or directory\b|\bENOENT\b/i.test(combined) || /\bTS\d{4}\b|\btype error\b|\bno exported member\b|\bdoes not exist on type\b|\bis not assignable to\b/i.test(combined) || /\berror:\s+"eslint"\s+exited with code\s+\d+\b/i.test(combined) || /\bSyntaxError\b|\bReferenceError\b|\bTypeError\b/i.test(combined);
}
function shouldDeferLongValidationAfterFastFailures(command, previousRuns, repo) {
  if (!isLongRunningBrowserValidationCommand(command) && !(repo && validationCommandIncludesLongRunningBrowserWork(repo, command))) {
    return null;
  }
  const deterministicFailures = previousRuns.filter(isDeterministicFastValidationFailure);
  if (deterministicFailures.length === 0)
    return null;
  const first = deterministicFailures[0];
  const digest = extractValidationFailureDigest(first);
  return `fast validation already failed for "${first.command}"${digest ? ` (${digest})` : ""}`;
}
function readPackageJson(repo) {
  const packagePath = resolve10(repo, "package.json");
  if (!existsSync8(packagePath))
    return null;
  try {
    return JSON.parse(readFileSync8(packagePath, "utf8"));
  } catch {
    return null;
  }
}
function packageJsonDeclaresPlaywright(repo) {
  const parsed = readPackageJson(repo);
  if (!parsed)
    return false;
  const dependencyGroups = [
    parsed.dependencies,
    parsed.devDependencies,
    parsed.optionalDependencies,
    parsed.peerDependencies
  ];
  return dependencyGroups.some((group) => Boolean(group && (group.playwright || group["@playwright/test"])));
}
function resolvePackageScriptForValidationCommand(repo, command) {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv || argv.length === 0)
    return null;
  const first = argv[0]?.toLowerCase();
  let cwd = repo;
  let scriptName = "";
  const consumeCwdOption = (index) => {
    const token = argv[index] ?? "";
    if ((token === "--cwd" || token === "-C" || token === "--prefix") && argv[index + 1]) {
      cwd = resolve10(repo, argv[index + 1] ?? "");
      return index + 2;
    }
    for (const prefix of ["--cwd=", "-C=", "--prefix="]) {
      if (token.startsWith(prefix)) {
        cwd = resolve10(repo, token.slice(prefix.length));
        return index + 1;
      }
    }
    return null;
  };
  if (first === "bun") {
    let index = 1;
    while (index < argv.length) {
      const consumed = consumeCwdOption(index);
      if (consumed !== null) {
        index = consumed;
        continue;
      }
      if ((argv[index] ?? "").startsWith("--")) {
        index += 1;
        continue;
      }
      break;
    }
    if ((argv[index] ?? "").toLowerCase() === "run") {
      scriptName = argv[index + 1] ?? "";
    } else {
      const candidate = argv[index] ?? "";
      if (candidate && !["install", "test", "x"].includes(candidate.toLowerCase())) {
        scriptName = candidate;
      }
    }
  } else if (first === "npm" || first === "pnpm" || first === "yarn") {
    let index = 1;
    while (index < argv.length) {
      const consumed = consumeCwdOption(index);
      if (consumed !== null) {
        index = consumed;
        continue;
      }
      if ((argv[index] ?? "").toLowerCase() === "run") {
        scriptName = argv[index + 1] ?? "";
        break;
      }
      if (!(argv[index] ?? "").startsWith("-")) {
        scriptName = argv[index] ?? "";
        break;
      }
      index += 1;
    }
  }
  if (!scriptName)
    return null;
  const script = readPackageJson(cwd)?.scripts?.[scriptName];
  if (typeof script !== "string" || !script.trim())
    return null;
  return { script, scriptName, cwd };
}
function readReferencedValidationScriptText(cwd, script) {
  const texts = [];
  const tokens = tokenizeValidationCommandArgv(script) ?? script.split(/\s+/).filter(Boolean);
  for (const rawToken of tokens) {
    const token = rawToken.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\\/g, "/");
    if (!/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(token))
      continue;
    if (token.includes("://") || token.includes("node_modules/"))
      continue;
    const scriptPath = resolve10(cwd, token);
    if (!existsSync8(scriptPath))
      continue;
    try {
      texts.push(readFileSync8(scriptPath, "utf8").slice(0, 64000));
    } catch {}
  }
  return texts.join(`
`);
}
function shouldEnsurePlaywrightBrowserRuntime(repo, command) {
  if (!validationCommandIncludesLongRunningBrowserWork(repo, command))
    return false;
  if (/\bplaywright\b/i.test(command))
    return true;
  const script = resolvePackageScriptForValidationCommand(repo, command);
  const scriptCwd = script?.cwd ?? repo;
  if (packageJsonDeclaresPlaywright(repo) || packageJsonDeclaresPlaywright(scriptCwd)) {
    return true;
  }
  if (!script)
    return false;
  return /(?:^|[^A-Za-z0-9_-])(?:@playwright\/test|playwright)(?:$|[^A-Za-z0-9_-])/i.test(`${script.script}
${readReferencedValidationScriptText(script.cwd, script.script)}`);
}
var PLAYWRIGHT_BROWSER_INSTALL_TARGETS = new Set([
  "chromium",
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "msedge",
  "msedge-beta",
  "msedge-dev",
  "msedge-canary",
  "firefox",
  "webkit"
]);
function addPlaywrightInstallTarget(targets, rawValue) {
  const value = rawValue.trim().toLowerCase();
  if (!value)
    return;
  const normalized = value === "edge" ? "msedge" : value;
  if (PLAYWRIGHT_BROWSER_INSTALL_TARGETS.has(normalized)) {
    targets.add(normalized);
  }
}
function inferPlaywrightBrowserInstallTargets(repo, command) {
  const targets = new Set(["chromium"]);
  const script = resolvePackageScriptForValidationCommand(repo, command);
  const scriptText = script ? `${script.script}
${readReferencedValidationScriptText(script.cwd, script.script)}` : "";
  const text = `${command}
${scriptText}`;
  for (const match of text.matchAll(/\bchannel\s*:\s*["'`]([^"'`]+)["'`]/gi)) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const match of text.matchAll(/\bbrowserName\s*:\s*["'`]([^"'`]+)["'`]/gi)) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const match of text.matchAll(/(?:^|\s)(?:--browser|--browser-name|--channel)[=\s]+["'`]?([A-Za-z0-9_-]+)/gi)) {
    addPlaywrightInstallTarget(targets, match[1] ?? "");
  }
  for (const target of PLAYWRIGHT_BROWSER_INSTALL_TARGETS) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\s*\\.\\s*launch\\b`, "i").test(text)) {
      addPlaywrightInstallTarget(targets, target);
    }
  }
  return Array.from(targets).sort((a, b) => {
    if (a === "chromium")
      return -1;
    if (b === "chromium")
      return 1;
    return a.localeCompare(b);
  });
}
function playwrightBrowserInstallArgv(targets = ["chromium"]) {
  const installTargets = Array.from(new Set(targets.map((target) => target.trim()).filter(Boolean)));
  return [
    "bunx",
    "playwright",
    "install",
    ...installTargets.length > 0 ? installTargets : ["chromium"]
  ];
}
async function runPlaywrightBrowserRuntimePreflight(repo, command, targets, timeoutMs, outputPolicy) {
  const env = buildWorkerSandboxWritableEnv(repo);
  const timeout = Math.max(120000, Math.min(600000, timeoutMs));
  return runValidationArgv(repo, command, playwrightBrowserInstallArgv(targets), env, timeout, outputPolicy, `Browser runtime preflight timed out after ${timeout}ms while ensuring Playwright browser target(s): ${targets.join(", ")}. Captured output is the process output emitted before PushPals terminated the installer process tree.`);
}
function resolveValidationCommandTimeoutMs(command, baseTimeoutMs, repo) {
  const normalizedBase = Number.isFinite(Number(baseTimeoutMs)) ? Math.max(1000, Math.min(7200000, Math.floor(Number(baseTimeoutMs)))) : 180000;
  const includesBrowserWork = isLongRunningBrowserValidationCommand(command) || Boolean(repo && validationCommandIncludesLongRunningBrowserWork(repo, command));
  if (!includesBrowserWork)
    return normalizedBase;
  return Math.max(normalizedBase, 600000);
}
function commandHasPortArg(argv) {
  return argv.some((token) => token === "--port" || token.startsWith("--port="));
}
function shouldInjectBrowserValidationPort(command, argv) {
  if (commandHasPortArg(argv))
    return false;
  if (!isLongRunningBrowserValidationCommand(command))
    return false;
  return /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke)\b/.test(validationCommandKey(command));
}
function prepareValidationCommandArgv(command, env) {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv)
    return null;
  const spawnArgv = prepareValidationSpawnArgv(argv, env);
  const port = String(env.EXPO_DEV_SERVER_PORT ?? "").trim();
  if (!port || !shouldInjectBrowserValidationPort(command, spawnArgv))
    return spawnArgv;
  return [...spawnArgv, "--", "--port", port];
}
function commandLeaf2(value) {
  return (value.trim().replace(/\\/g, "/").split("/").pop() ?? value).toLowerCase();
}
function isBunCommandToken(value) {
  const leaf = commandLeaf2(value);
  return leaf === "bun" || leaf === "bun.exe" || leaf === "bun.cmd" || leaf === "bun.bat";
}
function isBunxCommandToken(value) {
  const leaf = commandLeaf2(value);
  return leaf === "bunx" || leaf === "bunx.exe" || leaf === "bunx.cmd" || leaf === "bunx.bat";
}
function prepareValidationSpawnArgv(argv, env) {
  const first = argv[0] ?? "";
  if (!first)
    return argv;
  const bunBin = resolveBunExecutableFromEnv(env);
  if (!bunBin)
    return argv;
  if (isBunCommandToken(first))
    return [bunBin, ...argv.slice(1)];
  if (isBunxCommandToken(first))
    return [bunBin, "x", ...argv.slice(1)];
  return argv;
}
function readJsonRecord(path) {
  try {
    return asRecord2(JSON.parse(readFileSync8(path, "utf8")));
  } catch {
    return null;
  }
}
function declaredPackageDependencyNames(packageJson, fields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies"
]) {
  const out = new Set;
  for (const field of fields) {
    const dependencies = asRecord2(packageJson[field]);
    if (!dependencies)
      continue;
    for (const name of Object.keys(dependencies)) {
      if (name.trim())
        out.add(name.trim());
    }
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}
function packageJsonDeclaresDependency(packageJson, name) {
  return declaredPackageDependencyNames(packageJson).includes(name);
}
function hasBunLockfile(repo) {
  return existsSync8(resolve10(repo, "bun.lock")) || existsSync8(resolve10(repo, "bun.lockb"));
}
function isBunPackageManagedValidationCommand(command) {
  const tokens = tokenizeValidationCommandArgv(command);
  if (!tokens || tokens.length === 0)
    return false;
  const first = tokens[0] ?? "";
  if (isBunxCommandToken(first))
    return true;
  if (!isBunCommandToken(first))
    return false;
  for (let index = 1;index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").toLowerCase();
    if (token === "--cwd" || token === "-c" || token === "-C") {
      index += 1;
      continue;
    }
    if (token.startsWith("--cwd="))
      continue;
    if (token.startsWith("-"))
      continue;
    return token === "run" || token === "x" || token === "test";
  }
  return false;
}
function resolvePackageRoot(nodeModulesDir, packageName) {
  return resolve10(nodeModulesDir, ...packageName.split("/").filter(Boolean));
}
function defaultBinNameForPackage(packageName) {
  return packageName.split("/").filter(Boolean).pop() ?? packageName;
}
function isSafeBinName(value) {
  return Boolean(value.trim()) && !/[\\/:\0]/.test(value);
}
function isPathInside(parent, child) {
  const normalizedParent = resolve10(parent).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedChild = resolve10(child).replace(/\\/g, "/");
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}
function packageBinaryNames(packageRoot, dependencyName) {
  const packageJson = readJsonRecord(resolve10(packageRoot, "package.json"));
  if (!packageJson)
    return [];
  const packageName = typeof packageJson.name === "string" && packageJson.name.trim() ? packageJson.name.trim() : dependencyName;
  const bin = packageJson.bin;
  const entries = [];
  if (typeof bin === "string" && bin.trim()) {
    entries.push([defaultBinNameForPackage(packageName), bin.trim()]);
  } else {
    const binRecord = asRecord2(bin);
    if (binRecord) {
      for (const [name, target] of Object.entries(binRecord)) {
        if (typeof target === "string" && target.trim())
          entries.push([name, target.trim()]);
      }
    }
  }
  return Array.from(new Set(entries.filter(([name, target]) => {
    if (!isSafeBinName(name))
      return false;
    const targetPath = resolve10(packageRoot, target);
    return isPathInside(packageRoot, targetPath) && existsSync8(targetPath);
  }).map(([name]) => name))).sort((a, b) => a.localeCompare(b));
}
function hasLocalBinShim(binDir, binName) {
  const candidates = ["", ".bunx", ".exe", ".cmd", ".ps1"].map((extension) => resolve10(binDir, `${binName}${extension}`));
  return candidates.some((candidate) => existsSync8(candidate));
}
function isLinkedNodeModulesDependencyArtifact(repo) {
  try {
    return lstatSync2(resolve10(repo, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
}
function isManagedLinkedPackageDependencySnapshot(repo) {
  return existsSync8(resolve10(repo, "node_modules", DIRECT_WORKTREE_DEPENDENCY_SNAPSHOT_MARKER));
}
function validationNeedsExpoRouterBrowserLocalInstall(repo, packageJson, validationCommands) {
  return packageJsonDeclaresDependency(packageJson, "expo-router") && validationCommands.some((command) => validationCommandIncludesLongRunningBrowserWork(repo, command));
}
function collectMissingTopLevelDependencyPackages(repo, packageJson) {
  const nodeModulesDir = resolve10(repo, "node_modules");
  const missing = [];
  for (const dependencyName of declaredPackageDependencyNames(packageJson, [
    "dependencies",
    "devDependencies"
  ])) {
    if (!existsSync8(resolvePackageRoot(nodeModulesDir, dependencyName))) {
      missing.push(dependencyName);
      if (missing.length >= 8)
        return missing;
    }
  }
  return missing;
}
function collectMissingTopLevelDependencyBinaryShims(repo, packageJson) {
  const nodeModulesDir = resolve10(repo, "node_modules");
  const binDir = resolve10(nodeModulesDir, ".bin");
  const missing = [];
  for (const dependencyName of declaredPackageDependencyNames(packageJson)) {
    const packageRoot = resolvePackageRoot(nodeModulesDir, dependencyName);
    if (!existsSync8(packageRoot))
      continue;
    for (const binName of packageBinaryNames(packageRoot, dependencyName)) {
      if (!hasLocalBinShim(binDir, binName))
        missing.push(binName);
      if (missing.length >= 8)
        return Array.from(new Set(missing));
    }
  }
  return Array.from(new Set(missing));
}
function resolveBunDependencyLayoutPreflight(repo, validationCommands) {
  if (!validationCommands.some((command) => isBunPackageManagedValidationCommand(command))) {
    return null;
  }
  if (!hasBunLockfile(repo))
    return null;
  const packageJson = readJsonRecord(resolve10(repo, "package.json"));
  if (!packageJson)
    return null;
  const nodeModulesDir = resolve10(repo, "node_modules");
  if (!existsSync8(nodeModulesDir)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules is missing for Bun validation commands"
    };
  }
  if (isManagedLinkedPackageDependencySnapshot(repo)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules contains linked package directories from a PushPals dependency snapshot",
      removeLinkedNodeModules: true
    };
  }
  if (isLinkedNodeModulesDependencyArtifact(repo) && validationNeedsExpoRouterBrowserLocalInstall(repo, packageJson, validationCommands)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules is linked for Expo Router browser validation commands",
      removeLinkedNodeModules: true
    };
  }
  const binDir = resolve10(nodeModulesDir, ".bin");
  if (!existsSync8(binDir)) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: "node_modules/.bin is missing for Bun validation commands"
    };
  }
  const missingPackages = collectMissingTopLevelDependencyPackages(repo, packageJson);
  if (missingPackages.length > 0) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: `installed dependency package(s) missing: ${missingPackages.join(", ")}`
    };
  }
  const missingBins = collectMissingTopLevelDependencyBinaryShims(repo, packageJson);
  if (missingBins.length > 0) {
    return {
      command: BUN_DEPENDENCY_LAYOUT_PREFLIGHT_COMMAND,
      reason: `local dependency binary shim(s) missing: ${missingBins.join(", ")}`
    };
  }
  return null;
}
function resolveBunDependencyLayoutPreflightTimeoutMs(timeoutMs) {
  return Math.min(Math.max(30000, timeoutMs), 600000);
}
function resolveBunDependencyLayoutPreflightTimeoutForValidationCommands(repo, validationCommands, baseTimeoutMs) {
  const longestValidationTimeoutMs = validationCommands.reduce((longest, command) => Math.max(longest, resolveValidationCommandTimeoutMs(command, baseTimeoutMs, repo)), baseTimeoutMs);
  return resolveBunDependencyLayoutPreflightTimeoutMs(longestValidationTimeoutMs);
}
function buildBunDependencyLayoutPreflightFailureRun(args) {
  const validationCommand = args.validationCommand.trim() || args.validationCommands[0] || args.preflightCommand;
  return {
    step: validationCommand,
    command: validationCommand,
    ok: false,
    exitCode: args.run.exitCode,
    stdout: args.run.stdout,
    stderr: [
      `Dependency layout preflight failed before validation command "${validationCommand}". WorkerPals could not repair the local Bun dependency layout safely.`,
      `Preflight reason: ${args.preflightReason}.`,
      `Repair command: ${args.preflightCommand}.`,
      args.run.stderr
    ].filter(Boolean).join(`
`),
    elapsedMs: args.run.elapsedMs
  };
}
function removeLinkedNodeModulesDependencyArtifact(repo, onLog) {
  const nodeModulesDir = resolve10(repo, "node_modules");
  if (!isLinkedNodeModulesDependencyArtifact(repo) && !isManagedLinkedPackageDependencySnapshot(repo)) {
    return;
  }
  try {
    rmSync3(nodeModulesDir, { recursive: true, force: true });
    onLog?.("stdout", "[ValidationGate] Dependency layout preflight removed linked-package node_modules artifact before local Bun install repair.");
  } catch (err) {
    onLog?.("stderr", `[ValidationGate] Dependency layout preflight could not remove linked node_modules artifact: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function runBunDependencyLayoutPreflight(repo, validationCommands, failureValidationCommand, timeoutMs, outputPolicy, onLog) {
  const preflight = resolveBunDependencyLayoutPreflight(repo, validationCommands);
  if (!preflight)
    return null;
  onLog?.("stdout", `[ValidationGate] Dependency layout preflight: ${preflight.reason}; running "${preflight.command}".`);
  if (preflight.removeLinkedNodeModules) {
    removeLinkedNodeModulesDependencyArtifact(repo, onLog);
  }
  const run = await runValidationCommand(repo, preflight.command, resolveBunDependencyLayoutPreflightTimeoutForValidationCommands(repo, validationCommands, timeoutMs), outputPolicy);
  if (run.ok) {
    onLog?.("stdout", `[ValidationGate] Dependency layout preflight repaired local Bun install layout (${run.elapsedMs}ms).`);
    return null;
  }
  const digest = extractValidationFailureDigest(run);
  onLog?.("stderr", `[ValidationGate] Dependency layout preflight failed (${run.elapsedMs}ms, exit ${run.exitCode})${digest ? ` - ${digest}` : ""}. Blocking validation because the dependency tree may be incomplete after repair failure.`);
  return buildBunDependencyLayoutPreflightFailureRun({
    validationCommand: failureValidationCommand,
    validationCommands,
    preflightCommand: preflight.command,
    preflightReason: preflight.reason,
    run
  });
}
function isBrowserAssertionDigest(digest) {
  return /\b(Web end-to-end smoke test failed|locator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded|page\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded|waiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\(|Expected .+ to be .+ within \d+ms|AssertionError|Error:\s+expect\()/i.test(digest);
}
function isBrowserValidationInfrastructureDigest(digest) {
  if (isBrowserAssertionDigest(digest))
    return false;
  return /\b(browserType\.launch|ERR_SOCKET_BAD_PORT|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|listen\s+EPERM|EPERM|EACCES|freeport|port selection|browser runtime|playwright install|executable doesn't exist|Expo exited early|local port bind|Validation command timed out|terminated by signal)\b/i.test(digest);
}
function toolProbeArgv(candidate, env) {
  const normalized = candidate.toLowerCase();
  let argv;
  if (normalized === "sh") {
    argv = [candidate, "-c", "exit 0"];
  } else if (normalized === "cmd") {
    argv = [candidate, "/c", "exit 0"];
  } else if (normalized === "bash") {
    argv = [candidate, "-lc", "exit 0"];
  } else if (normalized === "powershell" || normalized === "pwsh") {
    argv = [candidate, "-NoProfile", "-Command", "exit 0"];
  } else {
    argv = [candidate, "--version"];
  }
  return prepareValidationSpawnArgv(argv, env);
}
async function checkToolCandidate(candidate, env, timeoutMs = 5000) {
  const spawnEnv = withResolvedBunOnPath(env);
  try {
    const proc = Bun.spawn(toolProbeArgv(candidate, spawnEnv), {
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, Math.max(1000, timeoutMs));
    try {
      const [exitCode] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => "")
      ]);
      return !timedOut && exitCode === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
async function checkToolAvailability(requirements, env = withResolvedBunOnPath(process.env)) {
  const cache = new Map;
  const check = (candidate) => {
    const key = candidate.toLowerCase();
    let cached = cache.get(key);
    if (!cached) {
      cached = checkToolCandidate(candidate, env);
      cache.set(key, cached);
    }
    return cached;
  };
  const out = [];
  for (const requirement of requirements) {
    let availableCandidate = null;
    for (const candidate of requirement.candidates) {
      if (await check(candidate)) {
        availableCandidate = candidate;
        break;
      }
    }
    out.push({
      requirement,
      ok: Boolean(availableCandidate),
      candidate: availableCandidate,
      detail: availableCandidate ? `${availableCandidate} is available` : `missing ${formatToolRequirement(requirement)}`
    });
  }
  return out;
}
function formatMissingToolRequirements(requirements) {
  return requirements.map(formatToolRequirement).join(", ");
}
function extractPreparedMergeConflictPaths(params) {
  const reviewAgent = params.reviewAgent && typeof params.reviewAgent === "object" && !Array.isArray(params.reviewAgent) ? params.reviewAgent : null;
  const preparedPaths = Array.isArray(reviewAgent?.preparedConflictPaths) ? reviewAgent.preparedConflictPaths : [];
  return preparedPaths.map((entry) => String(entry ?? "").trim().replace(/\\/g, "/")).filter(Boolean);
}
function normalizeValidationPathToken(value) {
  const normalized = value.trim().replace(/^['"`(<[]+/, "").replace(/[>'"`)\],.;:]+$/, "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../"))
    return null;
  if (!/[./]/.test(normalized))
    return null;
  if (/^(https?|file):/i.test(normalized))
    return null;
  return normalized;
}
function extractPathTokensFromValidationOutput(value) {
  const seen = new Set;
  const out = [];
  const add = (raw) => {
    if (!raw)
      return;
    const normalized2 = normalizeValidationPathToken(raw);
    if (!normalized2 || seen.has(normalized2))
      return;
    seen.add(normalized2);
    out.push(normalized2);
  };
  const normalized = stripAnsiControlSequences(value);
  for (const match of normalized.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_.-]+)?/g)) {
    add(match[0]);
  }
  for (const match of normalized.matchAll(/(?:from|in|at)\s+['"`]?([^'"`\s]+\/[^'"`\s]+)['"`]?/gi)) {
    add(match[1]);
  }
  return out;
}
function literalScopePrefix(value) {
  const normalized = normalizeValidationPathToken(value.replace(/\*\*?.*$/, "").replace(/\/+$/, ""));
  if (!normalized || normalized === ".")
    return null;
  return normalized;
}
function pathMatchesScopeHint(path, hint) {
  const normalizedPath = normalizeValidationPathToken(path);
  const normalizedHint = hint.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalizedPath || !normalizedHint)
    return false;
  if (matchesGlob(normalizedPath, normalizedHint))
    return true;
  const prefix = literalScopePrefix(normalizedHint);
  if (!prefix)
    return false;
  return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}
function isValidationScopeTestPathHint(path) {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}
function shouldTreatBrowserAssertionAsTaskScope(planning, changedPaths, targetPath) {
  const pathHints = [
    targetPath ?? "",
    ...changedPaths,
    ...planning.targetPaths ?? [],
    ...planning.scope.writeGlobs ?? []
  ].map((entry) => entry.trim().replace(/\\/g, "/")).filter(Boolean);
  const allHintsAreTests = pathHints.length > 0 && pathHints.every((hint) => isValidationScopeTestPathHint(hint));
  const planningText = collectPlanningText(planning);
  const explicitlyBrowserValidation = /\b(browser|web:e2e|e2e|playwright|smoke)\b/i.test(planningText);
  if (allHintsAreTests && !explicitlyBrowserValidation)
    return false;
  const productPathChanged = changedPaths.some((path) => {
    const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    return !isValidationScopeTestPathHint(normalized) && /^(app|components|screens|styles|utils)\//i.test(normalized);
  });
  if (productPathChanged)
    return true;
  return /\b(ui|visual|render(?:ing)?|style|screen|route|home|settings|shop|game|battlefield|component|control panel|control-panel)\b/i.test(planningText);
}
function classifyValidationFailureScope(runs, planning, changedPaths, targetPath) {
  const failedRuns = runs.filter((run) => !run.ok && run.exitCode !== 127);
  if (failedRuns.length === 0)
    return "none";
  const scopeHints = [
    targetPath ?? "",
    ...changedPaths,
    ...planning.targetPaths ?? [],
    ...planning.scope.writeGlobs ?? []
  ].map((entry) => entry.trim().replace(/\\/g, "/")).filter(Boolean);
  if (scopeHints.length === 0)
    return "none";
  const combined = failedRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean).join(`
`);
  const hasBrowserAssertionFailure = failedRuns.some((run) => isLongRunningBrowserValidationCommand(run.command) && isBrowserAssertionDigest([run.stdout, run.stderr].filter(Boolean).join(`
`)));
  if (hasBrowserAssertionFailure && shouldTreatBrowserAssertionAsTaskScope(planning, changedPaths, targetPath)) {
    return "task_scope";
  }
  const lowerCombined = combined.toLowerCase().replace(/\\/g, "/");
  for (const hint of scopeHints) {
    const normalized = literalScopePrefix(hint);
    if (normalized && normalized.length >= 4 && lowerCombined.includes(normalized.toLowerCase())) {
      return "task_scope";
    }
  }
  const pathTokens = extractPathTokensFromValidationOutput(combined).filter((token) => !/^(node_modules|\.bun|bun|npm|pnpm|yarn)\//i.test(token));
  if (pathTokens.length === 0) {
    return hasBrowserAssertionFailure ? "outside_task_scope" : "none";
  }
  if (pathTokens.some((token) => scopeHints.some((hint) => pathMatchesScopeHint(token, hint)))) {
    return "task_scope";
  }
  return "outside_task_scope";
}
function detectValidationBlocker(runs) {
  const failedRuns = runs.filter((run) => !run.ok);
  if (failedRuns.length === 0)
    return null;
  const combined = failedRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean).join(`
`).toLowerCase();
  if (!combined)
    return null;
  const browserFallbackSucceeded = combined.includes("using google chrome for browser automation") || combined.includes("using chromium for browser automation") || combined.includes("using firefox for browser automation") || combined.includes("using webkit for browser automation");
  const hasMissingBrowserRuntime = !browserFallbackSucceeded && (combined.includes("browser runtime preflight failed") || combined.includes("playwright install") || combined.includes("executable doesn't exist") || combined.includes("please run the following command to download new browsers"));
  if (isDockerDaemonValidationBlocker(combined)) {
    return {
      category: "environment",
      detail: "Validation requires access to a Docker daemon that is unavailable inside the worker sandbox. Preserve the candidate and rerun the blocked command in a trusted host environment."
    };
  }
  if (combined.includes("validation skipped before execution because required tool") || combined.includes("missing required tool") || combined.includes("command not found") || combined.includes("executable not found") || hasMissingBrowserRuntime || combined.includes("not recognized as an internal or external command")) {
    return {
      category: "environment",
      detail: "Validation is blocked by missing required toolchain executables or browser runtime support in the worker environment. Install/provision the missing tools or browser runtime before retrying this job."
    };
  }
  if (combined.includes("cannot find module") || combined.includes("module not found") || combined.includes("failed to resolve import") || combined.includes("could not resolve") || combined.includes("no such file or directory") || combined.includes("package not found")) {
    return {
      category: "repo",
      detail: "Validation is blocked by missing repo dependencies or imported files. Fix the repository test/runtime setup before retrying this job."
    };
  }
  if (combined.includes("read-only file system") || combined.includes("permission denied") || combined.includes("network access") || combined.includes("connection refused") || combined.includes("getaddrinfo") || combined.includes("err_socket_bad_port") || combined.includes("expo exited early") || combined.includes("eperm") || combined.includes("operation not permitted") || combined.includes("eacces")) {
    return {
      category: "environment",
      detail: "Validation is blocked by sandbox environment restrictions (filesystem, permissions, or network). Retry only after the worker environment is fixed."
    };
  }
  return null;
}
function stripAnsiControlSequences(value) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
function parseChangedPathsFromStatus(statusOutput) {
  const out = [];
  const seen = new Set;
  const addPath = (rawPath) => {
    let path = rawPath;
    if (path.includes(" -> ")) {
      path = path.split(" -> ", 2)[1] ?? path;
    }
    path = path.trim();
    if (!path || seen.has(path))
      return;
    seen.add(path);
    out.push(path);
  };
  const normalizedOutput = stripAnsiControlSequences(statusOutput);
  if (normalizedOutput.includes("\x00")) {
    const entries = normalizedOutput.split("\x00");
    for (let i = 0;i < entries.length; i++) {
      const raw = (entries[i] ?? "").replace(/\r$/, "");
      if (!raw.trim())
        continue;
      const porcelain = raw.match(/^(.{2}) (.*)$/);
      if (!porcelain) {
        addPath(raw);
        continue;
      }
      const status = porcelain[1] ?? "";
      let path = porcelain[2] ?? "";
      if ((status.includes("R") || status.includes("C")) && i + 1 < entries.length) {
        const renamedTo = entries[i + 1] ?? "";
        if (renamedTo) {
          path = renamedTo;
          i += 1;
        }
      }
      addPath(path);
    }
    return out;
  }
  for (const line of normalizedOutput.split(/\r?\n/)) {
    const raw = line.replace(/\r$/, "");
    if (!raw.trim())
      continue;
    let path = "";
    const porcelain = raw.match(/^.. (.+)$/);
    if (porcelain?.[1]) {
      path = porcelain[1];
    } else {
      const degraded = raw.match(/^. (.+)$/);
      if (degraded?.[1]) {
        path = degraded[1];
      } else {
        const loose = raw.match(/^[A-Z?]{1,2}\s+(.+)$/i);
        path = loose?.[1] ?? raw;
      }
    }
    addPath(path);
  }
  return out;
}
function expandKnownArtifactDirectoryPaths(repo, paths) {
  const out = [];
  const seen = new Set;
  const addPath = (rawPath) => {
    const path = String(rawPath ?? "").replace(/\\/g, "/").trim();
    if (!path || seen.has(path))
      return;
    seen.add(path);
    out.push(path);
  };
  for (const rawPath of paths) {
    const normalized = String(rawPath ?? "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
    if (normalized.toLowerCase() !== "microsoft") {
      addPath(rawPath);
      continue;
    }
    const powerShellRoot = resolve10(repo, "Microsoft", "Windows", "PowerShell");
    const knownArtifacts = [];
    const moduleCache = resolve10(powerShellRoot, "ModuleAnalysisCache");
    if (existsSync8(moduleCache))
      knownArtifacts.push("Microsoft/Windows/PowerShell/ModuleAnalysisCache");
    const psReadLineRoot = resolve10(powerShellRoot, "PSReadLine");
    if (existsSync8(psReadLineRoot)) {
      for (const entry of readdirSync3(psReadLineRoot, { withFileTypes: true })) {
        if (entry.isFile()) {
          knownArtifacts.push(`Microsoft/Windows/PowerShell/PSReadLine/${entry.name}`);
        }
      }
    }
    if (knownArtifacts.length === 0) {
      addPath(rawPath);
      continue;
    }
    for (const artifact of knownArtifacts.sort())
      addPath(artifact);
  }
  return out;
}
function isAssertionCoverageTestPath(path) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/tests/") || normalized.includes("/test/") || normalized.includes("__tests__/") || /\.test\.[a-z0-9]+$/i.test(normalized) || /\.spec\.[a-z0-9]+$/i.test(normalized);
}
function isBrowserSmokeHarnessPath(path) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)scripts\/test-[^/]*\.(?:c?js|m?js|ts)$/.test(normalized) || /(^|\/)scripts\/[^/]*(?:e2e|smoke|playwright|browser)[^/]*\.(?:c?js|m?js|ts)$/.test(normalized) || /(^|\/)(?:playwright|cypress)\.config\.(?:c?js|m?js|ts)$/.test(normalized);
}
function isTestSupportPath(path) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:tests?|__tests__|__mocks__)\//.test(normalized);
}
function isLikelyTestPath(path) {
  return isAssertionCoverageTestPath(path) || isBrowserSmokeHarnessPath(path) || isTestSupportPath(path);
}
function isValidationToolingPath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
  const base = normalized.split("/").pop() ?? normalized;
  return /^(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(base) || /^(tsconfig|jsconfig)(?:\.[a-z0-9_-]+)?\.json$/.test(base) || /^(eslint|prettier|babel|metro|jest|vitest|playwright)\.config\.(?:cjs|mjs|js|ts)$/.test(base) || /^\.eslintrc(?:\.(?:cjs|js|json|yaml|yml))?$/.test(base) || /^\.prettierrc(?:\.(?:cjs|js|json|yaml|yml))?$/.test(base) || base === "bunfig.toml";
}
function allowsValidationToolingOnlyChangeForTestFocusedTask(params) {
  const changedPaths = params.changedPaths.map((path) => String(path ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "")).filter(Boolean);
  if (changedPaths.length === 0)
    return false;
  if (!changedPaths.every(isValidationToolingPath))
    return false;
  const guidance = [
    params.instruction,
    ...params.planning.targetPaths ?? [],
    ...params.planning.scope.writeGlobs ?? [],
    ...params.planning.discovery?.likelyDirs ?? [],
    ...params.planning.acceptanceCriteria ?? [],
    ...params.planning.validationSteps ?? [],
    ...params.planning.requiredValidationSteps ?? []
  ].join(`
`);
  return /\b(lint|eslint|prettier|format|type\s*check|typecheck|tsc|typescript|validation|tooling|toolchain|package\.json|tsconfig|expo lint|cli)\b/i.test(guidance);
}
function extractRunnableValidationCommand(step) {
  const trimmed = step.trim();
  if (!trimmed)
    return null;
  const fenced = trimmed.match(/`([^`]+)`/)?.[1]?.trim();
  if (fenced)
    return fenced;
  const lower = trimmed.toLowerCase();
  const maybeStripped = lower.startsWith("run ") ? trimmed.slice(4).trim() : lower.startsWith("execute ") ? trimmed.slice(8).trim() : trimmed;
  const firstToken = maybeStripped.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const runnable = new Set([
    "bun",
    "bunx",
    "git",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "node",
    "pytest",
    "python",
    "python3",
    "uv",
    "coverage",
    "vitest",
    "jest",
    "tsc",
    "eslint",
    "ruff",
    "mypy",
    "go",
    "cargo",
    "make",
    "docker",
    "pwsh",
    "powershell",
    "sh",
    "bash"
  ]);
  if (runnable.has(firstToken))
    return maybeStripped;
  return null;
}
function validationCommandKey(command) {
  const argv = tokenizeValidationCommandArgv(command);
  if (argv && argv.length > 0) {
    const normalized = argv.map((entry) => entry.trim()).filter(Boolean);
    if (normalized[0]?.toLowerCase() === "bunx") {
      normalized.splice(0, 1, "bun", "x");
    }
    return normalized.join(" ").replace(/\s+/g, " ").toLowerCase();
  }
  return command.trim().replace(/\s+/g, " ").replace(/^bunx\b/i, "bun x").toLowerCase();
}
function validationCommandExecutionTier(command) {
  const normalized = validationCommandKey(command);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?\b/i.test(normalized) || /\btests?\/[^\s]+\b/i.test(normalized) || /\b(?:pytest|vitest|jest)\s+[^\s]+\b/i.test(normalized)) {
    return 0;
  }
  if (/\b(?:tsc|typecheck|lint|eslint|ruff|mypy)\b/i.test(normalized) && !/\b(?:validate|test:all|test:root)\b/i.test(normalized)) {
    return 1;
  }
  if (isLongRunningBrowserValidationCommand(command))
    return 3;
  if (/\b(?:validate|test:all|test:root|test:integration|test:e2e|test:worker)\b/i.test(normalized) || /^(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+test$/i.test(normalized)) {
    return 2;
  }
  return 1;
}
function shouldDeferHigherTierValidationAfterFailure(command, previousRuns) {
  const candidateTier = validationCommandExecutionTier(command);
  const blocker = previousRuns.find((run) => !run.ok && run.exitCode !== 125 && validationCommandExecutionTier(run.command) < candidateTier);
  if (!blocker)
    return null;
  const digest = extractValidationFailureDigest(blocker);
  return `lower-tier validation already failed for "${blocker.command}"${digest ? ` (${digest})` : ""}`;
}
function validationFileFingerprint(repo, changedPaths) {
  const hash = createHash4("sha256");
  hash.update(`${process.platform}\x00${process.arch}\x00`);
  const fingerprintPaths = ["bun.lock", "bun.lockb", "package.json", ...changedPaths].map((entry) => entry.replace(/\\/g, "/")).filter((entry, index, values) => values.indexOf(entry) === index).sort();
  for (const relativePath of fingerprintPaths) {
    const absolutePath = resolve10(repo, relativePath);
    hash.update(relativePath);
    hash.update("\x00");
    if (!existsSync8(absolutePath)) {
      hash.update("missing\x00");
      continue;
    }
    try {
      const stats = statSync4(absolutePath);
      if (!stats.isFile()) {
        hash.update(`non-file:${stats.size}\x00`);
        continue;
      }
      hash.update(readFileSync8(absolutePath));
      hash.update("\x00");
    } catch (error) {
      hash.update(`unreadable:${String(error)}\x00`);
    }
  }
  return hash.digest("hex");
}
async function validationCacheContext(repo, changedPaths) {
  const head = await git2(repo, ["rev-parse", "HEAD"]);
  return `${head.ok ? head.stdout.trim() : "unknown-head"}:${validationFileFingerprint(repo, changedPaths)}`;
}
function findUnchangedValidationFailure(runs, previousFailureDigests, repo) {
  for (const run of runs) {
    if (run.ok || run.exitCode === 127 || run.exitCode === 125)
      continue;
    const digest = repo ? extractValidationFailureRetryDigest(run, repo) : extractValidationFailureDigest(run);
    if (!digest)
      continue;
    if (previousFailureDigests.get(validationCommandKey(run.command)) === digest) {
      return { command: run.command, digest };
    }
  }
  return null;
}
function extractValidationFailureDigest(run) {
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  const patterns = [
    /\bCannot find module\s+['"`][^'"`\r\n]+['"`][^\r\n]*/i,
    /\bFailed to resolve import\s+['"`][^'"`\r\n]+['"`][^\r\n]*/i,
    /\bCould not resolve\s+['"`]?[^'"`\r\n]+['"`]?[^\r\n]*/i,
    /\bModule not found[^\r\n]*/i,
    /\bWeb end-to-end smoke test failed:[^\r\n]*/i,
    /\bbrowserType\.launch:[^\r\n]*/i,
    /\blocator\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bpage\.[a-z0-9_]+:\s+Timeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bTimeout\s+\d+ms\s+exceeded[^\r\n]*/i,
    /\bwaiting for getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)]*\)[^\r\n]*/i,
    /\bpage\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+[^\r\n]*/i,
    /\bExecutable doesn't exist[^\r\n]*/i,
    /\bPlease run the following command to download new browsers:[^\r\n]*(?:\r?\n\s+[^\r\n]+)?/i,
    /\bRun ["`]?npx playwright install[^'"`\r\n]*["`]?[^\r\n]*/i,
    /\bERR_SOCKET_BAD_PORT[^\r\n]*/i,
    /\berror TS\d+:[^\r\n]*/i,
    /\bError:\s+[^\r\n]*/i
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match?.[0])
      return toSingleLine(match[0], 180);
  }
  const firstMeaningfulLine = combined.split(/\r?\n/).map((line) => line.trim()).find((line) => /\b(error|failed|cannot|could not|timeout|timed out)\b/i.test(line));
  if (firstMeaningfulLine)
    return toSingleLine(firstMeaningfulLine, 180);
  if (Number(run.exitCode) === 124) {
    const elapsed = Number.isFinite(Number(run.elapsedMs)) ? ` after ${Number(run.elapsedMs)}ms` : "";
    return `timed out${elapsed}`;
  }
  return "";
}
function classifyBrowserValidationFailureKindFromText(text) {
  const combined = stripAnsiControlSequences(text);
  if (/\b(browserType\.launch|Executable doesn't exist|playwright install|Browser runtime preflight failed|Please run the following command to download new browsers|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)\b/i.test(combined)) {
    return "runtime";
  }
  if (/\b(ERR_SOCKET_BAD_PORT|EADDRINUSE|listen\s+EPERM|EPERM|EACCES|freeport|port selection|Expo exited early|local port bind|cannot bind|operation not permitted)\b/i.test(combined)) {
    return "startup";
  }
  if (/\b(page\.[a-z0-9_]+:\s+net::ERR_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/i.test(combined)) {
    return "network";
  }
  if (isBrowserAssertionDigest(combined)) {
    return "assertion";
  }
  return "unknown";
}
function shouldRetryBrowserValidationRunOnce(run, repo) {
  if (run.ok || !isLongRunningBrowserValidationCommand(run.command) && !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command))) {
    return false;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  const digest = extractValidationFailureDigest(run);
  const failureKind = classifyBrowserValidationFailureKindFromText(`${digest}
${combined}`);
  if (failureKind === "runtime" || failureKind === "network")
    return true;
  if (failureKind === "startup")
    return true;
  return /\b(Route\/startup smoke failure|startup smoke failure|home route startup)\b/i.test(`${digest}
${combined}`);
}
function shouldRetryAggregateWorkerValidationRunOnce(run, repo) {
  if (run.ok || !repo || !validationCommandIncludesLongRunningBrowserWork(repo, run.command)) {
    return false;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  if (/\berror:\s*script\s+["'`]test:worker["'`]\s+exited with code\s+1\b/i.test(combined)) {
    return true;
  }
  return /\bError:\s*Test timed out in \d+ms\b/i.test(combined) && /\b(?:Worker tests|test:worker|cloudflare\/test)\b/i.test(combined);
}
function aggregateWorkerValidationRetryCommand(run, repo) {
  if (!repo || !shouldRetryAggregateWorkerValidationRunOnce(run, repo))
    return null;
  const focusedCommand = "bun run test:worker";
  return resolvePackageScriptForValidationCommand(repo, focusedCommand) ? focusedCommand : null;
}
function shouldRetryPassingVitestTeardownOnce(run) {
  if (run.ok)
    return false;
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  if (!/EnvironmentTeardownError/i.test(combined) || !/\[vitest-worker\]:\s*Closing rpc while ["']resolve["'] was pending/i.test(combined)) {
    return false;
  }
  const summaryLines = combined.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:Test Files|Tests)\b/i.test(line));
  const testFilesSummary = summaryLines.find((line) => /^Test Files\b/i.test(line)) ?? "";
  const testsSummary = summaryLines.find((line) => /^Tests\b/i.test(line)) ?? "";
  if (!/\b\d+\s+passed\b/i.test(testFilesSummary) || !/\b\d+\s+passed\b/i.test(testsSummary)) {
    return false;
  }
  return !summaryLines.some((line) => /\b\d+\s+failed\b/i.test(line));
}
function shouldRetryTransientInfrastructureValidationOnce(run) {
  if (run.ok || run.exitCode === 127)
    return false;
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  if (/\b(?:assert|expected|received|test failed|tests? failed|syntaxerror|typeerror|TS\d{4})\b/i.test(combined)) {
    return false;
  }
  return /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|socket hang up|temporary failure in name resolution|service unavailable|bad gateway|gateway timeout|Docker daemon is not running|cannot connect to the Docker daemon|spawn EBUSY|spawn EPERM)\b/i.test(combined);
}
function extractBrowserValidationStage(text) {
  const patterns = [
    /\bBrowser validation failed during\s+([^:.\r\n|]+?)\s+stage\b/i,
    /\bfailed during\s+([^:.\r\n|]+?)\s+stage\b/i,
    /\b(?:stage|phase)\s*[:=]\s*["'`]?([^"'`.\r\n|]+)["'`]?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value)
      return toSingleLine(value, 80);
  }
  const verifiedStages = [...text.matchAll(/\bVerified:\s+([^|\r\n]+)/gi)].map((match) => match[1]?.trim()).filter((entry) => Boolean(entry));
  const lastVerifiedStage = verifiedStages.at(-1);
  if (lastVerifiedStage)
    return toSingleLine(lastVerifiedStage, 80);
  return null;
}
function refineBrowserValidationStage(stage, selector, expected, text) {
  const combined = stripAnsiControlSequences([stage, selector, expected, text].filter(Boolean).join(" ")).toLowerCase();
  if (/\b(game-control-panel|planet control panel|selected planet panel)\b/i.test(combined)) {
    return "planet control panel";
  }
  if (/\bsettings-home-button\b|\breturn to home from settings\b/i.test(combined)) {
    return "settings return";
  }
  if (/\bshop-home-button\b|\breturn to home from shop\b/i.test(combined)) {
    return "shop return";
  }
  return stage;
}
function inferBrowserValidationFailureFocus(params) {
  const combined = stripAnsiControlSequences([params.stage, params.selector, params.expected, params.text].filter(Boolean).join(" ")).toLowerCase();
  if (!combined.trim())
    return null;
  const focusRules = [
    [
      /\b(settings|ui[-\s]?size|scale(?:\s+option)?|settings-ui-|large ui option|medium|compact)\b/i,
      "settings UI size"
    ],
    [/\b(shop|skin|ship-option|projectile-option)\b/i, "shop navigation"],
    [/\b(home|shell|home-screen|home-play|play button|landing)\b/i, "home shell"],
    [/\b(match[-\s]?entry|start match|game-screen|countdown)\b/i, "match entry"],
    [
      /\b(in[-\s]?game|game-control|help-menu|planet|deploy|allocation|resource|decoy|attack|defense|tank)\b/i,
      "in-game UI"
    ]
  ];
  for (const [pattern, label] of focusRules) {
    if (pattern.test(combined))
      return label;
  }
  const stableLocatorMatch = combined.match(/\b(?:getbytestid|data-testid|testid)\(?['"`]?([a-z0-9_-]+)/i);
  if (stableLocatorMatch?.[1])
    return `test id ${stableLocatorMatch[1]}`;
  const compact = combined.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).slice(0, 5).join(" ");
  return compact ? toSingleLine(compact, 80) : null;
}
function extractBalancedLocatorCall(text) {
  const callPattern = /\b(?:getBy(?:TestId|Role|Text|Label|Placeholder|Title)|locator\.[a-z0-9_]+|page\.[a-z0-9_]+)\(/gi;
  let match;
  while ((match = callPattern.exec(text)) != null) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = match.index;index < text.length; index += 1) {
      const char = text[index] ?? "";
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0)
          return toSingleLine(text.slice(match.index, index + 1), 120);
      }
      if (depth <= 0 && /\s/.test(char) && index > match.index)
        break;
    }
  }
  return null;
}
function extractBrowserValidationSelector(text) {
  const balanced = extractBalancedLocatorCall(text);
  if (balanced)
    return balanced;
  const patterns = [
    /\bwaiting for\s+(getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)\r\n]+\))/i,
    /\b(locator\.[a-z0-9_]+\([^)\r\n]*\))/i,
    /\b(page\.[a-z0-9_]+\([^)\r\n]*\))/i,
    /\b(getBy(?:TestId|Role|Text|Label|Placeholder|Title)\([^)\r\n]+\))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value)
      return toSingleLine(value, 120);
  }
  return null;
}
function extractBrowserValidationExpectedUi(text) {
  const patterns = [
    /\bExpected\s+([^:.\r\n]+?)\s+within\s+\d+ms\b/i,
    /\bExpected\s+([^:.\r\n]+?)(?:[:.]|\r?\n)/i,
    /\bExpected\s+([^:.\r\n]+?)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value)
      return toSingleLine(value, 140);
  }
  return null;
}
function extractBrowserValidationArtifacts(text) {
  const combined = stripAnsiControlSequences(text);
  const out = [];
  const seen = new Set;
  const addArtifact = (raw) => {
    const artifact = String(raw ?? "").trim().replace(/[),.;:]+$/, "");
    if (!artifact || seen.has(artifact))
      return;
    seen.add(artifact);
    out.push(toSingleLine(artifact, 220));
  };
  const patterns = [
    /\b(?:screenshot|snapshot|trace|video|artifact|output|saved|wrote)[^:\r\n]*:\s*(["'`]?)([^"'`\s]+(?:outputs|test-results|playwright-report)[^\s"'`]+(?:\.png|\.jpg|\.jpeg|\.webp|\.zip|\.json|\.txt|\.webm))\1/gi,
    /((?:\/repo|\/workspace|[A-Za-z]:[\\/])?[^\s"'`]*?(?:outputs|test-results|playwright-report)[\\/][^\s"'`]+(?:\.png|\.jpg|\.jpeg|\.webp|\.zip|\.json|\.txt|\.webm))/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(combined)) != null) {
      addArtifact(match[2] ?? match[1]);
      if (out.length >= 4)
        return out;
    }
  }
  return out;
}
function collectRecentBrowserValidationFiles(repo, extensions, limit = 8) {
  if (!repo)
    return [];
  const roots = ["outputs/web-e2e", "test-results", "playwright-report"].map((entry) => resolve10(repo, entry)).filter((entry) => existsSync8(entry));
  const files = [];
  const visit = (dir, depth) => {
    if (depth > 4 || files.length > 2000)
      return;
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryName = String(entry.name);
      const path = resolve10(dir, entryName);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !extensions.test(entryName))
        continue;
      try {
        const stat = lstatSync2(path);
        files.push({ path, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  };
  for (const root of roots)
    visit(root, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((entry) => entry.path);
}
function collectRecentBrowserValidationArtifacts(repo) {
  return collectRecentBrowserValidationFiles(repo, /\.(?:png|jpe?g|webp|zip|json|txt|log|webm)$/i, 6).map((entry) => toSingleLine(entry, 220));
}
function summarizeRecentBrowserValidationLogs(repo) {
  const logFiles = collectRecentBrowserValidationFiles(repo, /\.(?:log|txt)$/i, 3);
  const summaries = [];
  for (const logFile of logFiles) {
    let content = "";
    try {
      content = readFileSync8(logFile, "utf8");
    } catch {
      continue;
    }
    const lines = stripAnsiControlSequences(content).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => /\b(Web end-to-end smoke test failed|Browser validation failed|Expected |locator\.|page\.|waiting for |Call log:|Verified:|Saved screenshot|Saved trace|ERR_SOCKET_BAD_PORT|EADDRINUSE|EPERM|EACCES|browserType\.launch|Expo exited early|freeport|net::ERR_|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)/i.test(line));
    if (lines.length === 0)
      continue;
    summaries.push(`${logFile}: ${lines.slice(-18).join(" | ")}`);
  }
  return toSingleLine(summaries.join(" | "), 1400);
}
function mergeBrowserValidationArtifacts(...sources) {
  const out = [];
  const seen = new Set;
  for (const source of sources) {
    for (const artifact of source ?? []) {
      const clean = toSingleLine(artifact, 220);
      if (!clean || seen.has(clean))
        continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= 8)
        return out;
    }
  }
  return out;
}
function summarizeBrowserValidationOutput(text) {
  const lines = stripAnsiControlSequences(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => /\b(Web end-to-end smoke test failed|Browser validation failed|Expected |locator\.|page\.|waiting for getBy|Call log:|Verified:|Saved screenshot|Saved trace|ERR_SOCKET_BAD_PORT|EADDRINUSE|EPERM|EACCES|browserType\.launch|Executable doesn't exist|Expo exited early|freeport|net::ERR_|Validation command timed out|terminated by signal|SIGTERM|timed out after \d+ms)/i.test(line));
  return toSingleLine(lines.slice(0, 8).join(" | "), 900);
}
function lastBrowserVerifiedStage(text) {
  const verifiedStages = [
    ...stripAnsiControlSequences(text).matchAll(/\bVerified:\s+([^|\r\n]+)/gi)
  ].map((match) => match[1]?.trim()).filter((entry) => Boolean(entry));
  const lastVerified = verifiedStages.at(-1);
  return lastVerified ? toSingleLine(lastVerified, 80) : null;
}
function extractBrowserValidationUrl(text) {
  const clean = stripAnsiControlSequences(text);
  const patterns = [
    /\b(?:page\s+url|current\s+url|browser\s+url|url)\s*[:=]\s*(https?:\/\/[^\s|"'`<>]+)/i,
    /\b(?:navigated\s+to|opened|loading)\s+(https?:\/\/[^\s|"'`<>]+)/i,
    /\b(https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+\/?[^\s|"'`<>]*)/i
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const url = match?.[1]?.replace(/[),.;]+$/, "").trim();
    if (url)
      return toSingleLine(url, 160);
  }
  return null;
}
function inferBrowserArtifactKind(path) {
  if (/\.(?:png|jpe?g|webp)$/i.test(path))
    return "screenshot";
  if (/\.zip$/i.test(path))
    return "trace";
  if (/\.webm$/i.test(path))
    return "video";
  if (/\.(?:log|txt)$/i.test(path))
    return "log";
  if (/\.json$/i.test(path))
    return "json";
  return "artifact";
}
function inferBrowserArtifactStageFromPath(path) {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const candidates = [
    baseName.match(/^\d+[-_](.+)$/)?.[1],
    baseName.match(/(?:failure|failed|screenshot|snapshot)[-_](.+)$/i)?.[1]
  ];
  const raw = candidates.find((entry) => entry && entry.trim());
  if (!raw)
    return null;
  return toSingleLine(raw.replace(/[-_]+/g, " "), 80);
}
function summarizeBrowserValidationArtifacts(params) {
  const allArtifacts = mergeBrowserValidationArtifacts(params.artifacts, collectRecentBrowserValidationArtifacts(params.repo));
  const out = [];
  const contextStage = extractBrowserValidationStage(params.context);
  const contextSelector = extractBrowserValidationSelector(params.context);
  const contextUrl = extractBrowserValidationUrl(params.context);
  const contextLastVerified = lastBrowserVerifiedStage(params.context);
  for (const artifact of allArtifacts.slice(0, 6)) {
    const kind = inferBrowserArtifactKind(artifact);
    let artifactText = "";
    if (params.repo && !/^(?:\/repo|\/workspace|[A-Za-z]:[\\/])/.test(artifact)) {
      try {
        artifactText = readFileSync8(resolve10(params.repo, artifact), "utf8");
      } catch {
        artifactText = "";
      }
    } else if (existsSync8(artifact) && /\.(?:log|txt|json)$/i.test(artifact)) {
      try {
        artifactText = readFileSync8(artifact, "utf8");
      } catch {
        artifactText = "";
      }
    }
    const artifactContext = artifactText ? stripAnsiControlSequences(artifactText) : "";
    const stage = inferBrowserArtifactStageFromPath(artifact) || extractBrowserValidationStage(artifactContext) || contextStage;
    const selector = extractBrowserValidationSelector(artifactContext) || contextSelector;
    const url = extractBrowserValidationUrl(artifactContext) || contextUrl;
    const lastVerified = lastBrowserVerifiedStage(artifactContext) || contextLastVerified;
    const detail = [
      `${artifact} [${kind}]`,
      stage ? `stage=${stage}` : "",
      selector ? `selector=${selector}` : "",
      url ? `url=${url}` : "",
      lastVerified ? `last_verified=${lastVerified}` : ""
    ].filter(Boolean).join(" ");
    out.push(toSingleLine(detail, 280));
  }
  return out;
}
function browserFailureSuggestedRemedy(packet) {
  if (packet.failureKind === "assertion") {
    return [
      "Read the latest artifact/log/DOM state before editing.",
      "Preserve already-passing browser stages.",
      packet.selector ? `Repair or replace the exact failing locator ${packet.selector} with a stable rendered signal for the same UI stage.` : "Repair the exact visible UI assertion or add a stable test id/accessibility label to existing UI."
    ].join(" ");
  }
  if (packet.failureKind === "startup" || packet.failureKind === "runtime") {
    return "Treat as browser startup/runtime provisioning; do not rewrite product UI assertions until ValidationGate reaches an assertion stage.";
  }
  if (packet.failureKind === "network") {
    return "Treat as local server/network readiness; add bounded startup diagnostics and avoid changing gameplay/UI behavior.";
  }
  return "Inspect captured validation output and repair the current failing stage with the smallest behavior-owning diff.";
}
function normalizeFailureMemoryToken(value) {
  return toSingleLine(value ?? "", 120).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildTaskFailureJobFamily(params) {
  const planning = params.planning && typeof params.planning === "object" ? params.planning : {};
  const autonomy = params.autonomy && typeof params.autonomy === "object" ? params.autonomy : {};
  const targetHints = [
    ...Array.isArray(planning.targetPaths) ? planning.targetPaths : [],
    ...Array.isArray(planning.scope?.writeGlobs) ? planning.scope.writeGlobs : [],
    ...Array.isArray(planning.validationSteps) ? planning.validationSteps : [],
    ...Array.isArray(planning.requiredValidationSteps) ? planning.requiredValidationSteps : []
  ].map((entry) => normalizeFailureMemoryToken(String(entry))).filter(Boolean).slice(0, 8);
  const area = normalizeFailureMemoryToken(String(autonomy.componentArea ?? autonomy.component_area ?? ""));
  const intent = normalizeFailureMemoryToken(String(planning.intent ?? ""));
  return [area, intent, ...targetHints].filter(Boolean).join("|") || "general";
}
function browserFailureMemoryKey(jobFamily, packet) {
  return [
    jobFamily,
    validationCommandKey(packet.command),
    packet.failureKind,
    normalizeFailureMemoryToken(packet.failureFocus),
    normalizeFailureMemoryToken(packet.stage),
    normalizeFailureMemoryToken(packet.selector),
    normalizeFailureMemoryToken(packet.expected)
  ].filter(Boolean).join("|");
}
function resolveFailureMemoryPath(repo) {
  const rootCandidates = [
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_PATH,
    repo
  ].map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const root = rootCandidates.find((entry) => existsSync8(entry)) ?? repo;
  const gitStatePath = resolveGitStateFilePath(root, "pushpals-worker-failure-memory.json");
  if (gitStatePath)
    return gitStatePath;
  return resolve10(root, "outputs", "data", "workerpals-failure-memory.json");
}
function resolveRemedyMemoryPath(repo) {
  const rootCandidates = [
    process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_ROOT_OVERRIDE,
    process.env.PUSHPALS_REPO_PATH,
    repo
  ].map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const root = rootCandidates.find((entry) => existsSync8(entry)) ?? repo;
  const gitStatePath = resolveGitStateFilePath(root, "pushpals-worker-remedy-memory.json");
  if (gitStatePath)
    return gitStatePath;
  return resolve10(root, "outputs", "data", "workerpals-remedy-memory.json");
}
function readBrowserFailureMemory(repo) {
  const memoryPath = resolveFailureMemoryPath(repo);
  try {
    const parsed = JSON.parse(readFileSync8(memoryPath, "utf8"));
    if (!Array.isArray(parsed.entries))
      return [];
    return parsed.entries.filter((entry) => Boolean(entry && typeof entry === "object")).slice(0, 80);
  } catch {
    return [];
  }
}
function knownFailureHintsForPacket(repo, jobFamily, packet) {
  const entries = readBrowserFailureMemory(repo).filter((entry) => {
    if (entry.jobFamily !== jobFamily)
      return false;
    if (validationCommandKey(entry.command) !== validationCommandKey(packet.command))
      return false;
    if (entry.failureKind !== packet.failureKind)
      return false;
    if (packet.failureFocus && entry.failureFocus && packet.failureFocus !== entry.failureFocus)
      return false;
    if (packet.stage && entry.stage && packet.stage !== entry.stage)
      return false;
    return true;
  }).sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 3);
  return entries.map((entry) => toSingleLine(`seen ${entry.count}x before for this repo/job family; last=${entry.lastSeenAt}; focus=${entry.failureFocus ?? entry.stage ?? "unknown"}; remedy=${entry.suggestedRemedy}`, 360));
}
function recordBrowserFailureMemory(repo, jobFamily, packet) {
  const memoryPath = resolveFailureMemoryPath(repo);
  const now = new Date().toISOString();
  const entries = readBrowserFailureMemory(repo);
  const key = browserFailureMemoryKey(jobFamily, packet);
  const existing = entries.find((entry) => entry.key === key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    existing.digest = packet.digest;
    existing.lastVerifiedStage = packet.lastVerifiedStage ?? null;
    existing.pageUrl = packet.pageUrl ?? null;
    existing.artifactSummaries = (packet.artifactSummaries ?? []).slice(0, 6);
    existing.suggestedRemedy = browserFailureSuggestedRemedy(packet);
  } else {
    entries.push({
      key,
      jobFamily,
      command: packet.command,
      failureKind: packet.failureKind,
      stage: packet.stage,
      selector: packet.selector,
      expected: packet.expected,
      failureFocus: packet.failureFocus,
      digest: packet.digest,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastVerifiedStage: packet.lastVerifiedStage ?? null,
      pageUrl: packet.pageUrl ?? null,
      artifactSummaries: (packet.artifactSummaries ?? []).slice(0, 6),
      suggestedRemedy: browserFailureSuggestedRemedy(packet)
    });
  }
  const next = entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 80);
  try {
    mkdirSync3(resolve10(memoryPath, ".."), { recursive: true });
    writeFileSync4(memoryPath, `${JSON.stringify({ version: 1, entries: next }, null, 2)}
`);
  } catch {}
}
function classifyValidationFailureForRemedy(run) {
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  if (isLongRunningBrowserValidationCommand(run.command))
    return "browser";
  if (/\bCannot find module\b|\bmodule not found\b|\bfailed to resolve import\b|\bcould not resolve\b/i.test(combined)) {
    return "module-resolution";
  }
  if (/\bTS\d{4}\b|\btype error\b|\bno exported member\b|\bdoes not exist on type\b|\bis not assignable to\b/i.test(combined)) {
    return "typecheck";
  }
  if (/\bESLint\b|\beslint\b|\blint\b/i.test(run.command) || /\berror:\s+"eslint"\s+exited/i.test(combined)) {
    return "lint";
  }
  if (/\bNo such file or directory\b|\bENOENT\b|\bpath does not exist\b/i.test(combined)) {
    return "missing-path";
  }
  if (/\breact[- ]native|mock|__mocks__|setupTests?|jest|vitest|test helper\b/i.test(combined)) {
    return "test-harness";
  }
  return "validation";
}
function validationRemedyMemoryKey(jobFamily, run) {
  const failureClass = classifyValidationFailureForRemedy(run);
  const digest = extractValidationFailureRetryDigest(run);
  return [
    jobFamily,
    validationCommandKey(run.command),
    failureClass,
    normalizeFailureMemoryToken(digest)
  ].filter(Boolean).join("|");
}
function validationFailureSuggestedRemedy(run) {
  const failureClass = classifyValidationFailureForRemedy(run);
  switch (failureClass) {
    case "module-resolution":
      return "Fix or avoid the missing import/path first; do not run long browser validation while module resolution is broken.";
    case "typecheck":
      return "Fix TypeScript/type errors before broader validation; prefer the smallest type-safe patch over test-harness expansion.";
    case "lint":
      return "Fix lint/static issues before expensive runtime checks; avoid unrelated formatting churn.";
    case "missing-path":
      return "Treat absent hinted paths as stale unless the task explicitly asks to create them; switch to an existing repo-native owner.";
    case "test-harness":
      return "If failures are in mocks/import setup, reduce to smaller helper/state coverage instead of broad shared mock expansion.";
    default:
      return "Repair the first deterministic fast validation failure before running long browser/e2e validation.";
  }
}
function readValidationRemedyMemory(repo) {
  const memoryPath = resolveRemedyMemoryPath(repo);
  try {
    const parsed = JSON.parse(readFileSync8(memoryPath, "utf8"));
    if (!Array.isArray(parsed.entries))
      return [];
    return parsed.entries.filter((entry) => Boolean(entry && typeof entry === "object")).slice(0, 120);
  } catch {
    return [];
  }
}
function knownValidationRemedyHintsForRuns(repo, jobFamily, runs) {
  const failed = runs.filter((run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command));
  if (failed.length === 0)
    return [];
  const entries = readValidationRemedyMemory(repo);
  const hints = [];
  for (const run of failed.slice(0, 4)) {
    const failureClass = classifyValidationFailureForRemedy(run);
    const commandKey = validationCommandKey(run.command);
    const matches = entries.filter((entry) => entry.jobFamily === jobFamily && validationCommandKey(entry.command) === commandKey && entry.failureClass === failureClass).sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 2);
    for (const entry of matches) {
      hints.push(toSingleLine(`${entry.command} ${entry.failureClass} seen ${entry.count}x before; last=${entry.lastSeenAt}; remedy=${entry.suggestedRemedy}`, 360));
    }
  }
  return Array.from(new Set(hints)).slice(0, 5);
}
function recordValidationRemedyMemory(repo, jobFamily, runs) {
  const failed = runs.filter((run) => !run.ok && !isLongRunningBrowserValidationCommand(run.command));
  if (failed.length === 0)
    return;
  const memoryPath = resolveRemedyMemoryPath(repo);
  const now = new Date().toISOString();
  const entries = readValidationRemedyMemory(repo);
  for (const run of failed.slice(0, 6)) {
    const key = validationRemedyMemoryKey(jobFamily, run);
    const existing = entries.find((entry) => entry.key === key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      existing.digest = extractValidationFailureRetryDigest(run);
      existing.suggestedRemedy = validationFailureSuggestedRemedy(run);
    } else {
      entries.push({
        key,
        jobFamily,
        command: run.command,
        failureClass: classifyValidationFailureForRemedy(run),
        digest: extractValidationFailureRetryDigest(run),
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        suggestedRemedy: validationFailureSuggestedRemedy(run)
      });
    }
  }
  const next = entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 120);
  try {
    mkdirSync3(resolve10(memoryPath, ".."), { recursive: true });
    writeFileSync4(memoryPath, `${JSON.stringify({ version: 1, entries: next }, null, 2)}
`);
  } catch {}
}
function extractValidationFailureRetryDigest(run, repo) {
  const baseDigest = extractValidationFailureDigest(run);
  if (!isLongRunningBrowserValidationCommand(run.command) && !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command))) {
    return baseDigest;
  }
  const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
  const failureKind = classifyBrowserValidationFailureKindFromText(`${baseDigest}
${combined}`);
  if (failureKind !== "assertion")
    return baseDigest;
  const recentLogSummary = summarizeRecentBrowserValidationLogs(repo);
  const enrichedBrowserContext = [combined, recentLogSummary].filter(Boolean).join(`
`);
  const selector = extractBrowserValidationSelector(enrichedBrowserContext);
  const expected = extractBrowserValidationExpectedUi(enrichedBrowserContext);
  const stage = refineBrowserValidationStage(extractBrowserValidationStage(enrichedBrowserContext), selector, expected, enrichedBrowserContext);
  const lastVerified = lastBrowserVerifiedStage(enrichedBrowserContext);
  const output = summarizeBrowserValidationOutput(enrichedBrowserContext);
  const parts = [
    baseDigest,
    stage ? `stage=${stage}` : "",
    selector ? `selector=${selector}` : "",
    expected ? `expected=${expected}` : "",
    lastVerified ? `last verified=${lastVerified}` : "",
    output && output !== baseDigest ? output : ""
  ].filter(Boolean);
  return toSingleLine(parts.join(" | "), 900) || baseDigest;
}
function buildBrowserValidationRepairPacket(validationRuns, previousFailureDigests = new Map, repo, knownFailureHints = []) {
  for (const run of validationRuns) {
    if (run.ok || !isLongRunningBrowserValidationCommand(run.command) && !(repo && validationCommandIncludesLongRunningBrowserWork(repo, run.command))) {
      continue;
    }
    const combined = stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`));
    const baseDigest = extractValidationFailureDigest(run);
    const failureKind = classifyBrowserValidationFailureKindFromText(`${baseDigest}
${combined}`);
    if (failureKind === "unknown")
      continue;
    const digest = failureKind === "assertion" ? extractValidationFailureRetryDigest(run, repo) || baseDigest : baseDigest;
    const previousDigest = previousFailureDigests.get(validationCommandKey(run.command)) ?? null;
    const recentLogSummary = summarizeRecentBrowserValidationLogs(repo);
    const enrichedBrowserContext = [combined, recentLogSummary].filter(Boolean).join(`
`);
    const selector = extractBrowserValidationSelector(enrichedBrowserContext);
    const expected = extractBrowserValidationExpectedUi(enrichedBrowserContext);
    const lastVerifiedStage = lastBrowserVerifiedStage(enrichedBrowserContext);
    const pageUrl = extractBrowserValidationUrl(enrichedBrowserContext);
    const stage = refineBrowserValidationStage(extractBrowserValidationStage(enrichedBrowserContext), selector, expected, enrichedBrowserContext);
    const previousStage = previousDigest ? extractBrowserValidationStage(previousDigest) : null;
    const previousSelector = previousDigest ? extractBrowserValidationSelector(previousDigest) : null;
    const previousExpected = previousDigest ? extractBrowserValidationExpectedUi(previousDigest) : null;
    const failureFocus = inferBrowserValidationFailureFocus({
      stage,
      selector,
      expected,
      text: enrichedBrowserContext
    });
    const previousFailureFocus = previousDigest ? inferBrowserValidationFailureFocus({
      stage: previousStage,
      selector: previousSelector,
      expected: previousExpected,
      text: previousDigest
    }) : null;
    const sameFailureSignal = Boolean(previousDigest) && (previousDigest === digest || Boolean(failureFocus) && failureFocus === previousFailureFocus && (!selector || !previousSelector || selector === previousSelector));
    const progress = previousDigest == null ? "first_failure" : sameFailureSignal ? "same_failure" : "new_failure";
    const needsDiagnosticProbe = failureKind === "assertion" && sameFailureSignal;
    const artifacts = mergeBrowserValidationArtifacts(extractBrowserValidationArtifacts(combined), collectRecentBrowserValidationArtifacts(repo));
    const artifactSummaries = summarizeBrowserValidationArtifacts({
      repo,
      artifacts,
      context: enrichedBrowserContext
    });
    return {
      command: run.command,
      failureKind,
      stage,
      selector,
      expected,
      failureFocus,
      lastVerifiedStage,
      pageUrl,
      digest,
      previousDigest,
      previousStage,
      previousSelector,
      previousExpected,
      previousFailureFocus,
      progress,
      needsDiagnosticProbe,
      mustReadArtifactsBeforeEdit: failureKind === "assertion",
      artifacts,
      artifactSummaries,
      knownFailureHints: knownFailureHints.slice(0, 3),
      output: [summarizeBrowserValidationOutput(combined) || digest, recentLogSummary].filter(Boolean).join(" | ")
    };
  }
  return null;
}
function collectRequiredValidationFailures(requiredCommands, validationRuns) {
  const requiredKeys = new Set(requiredCommands.map(validationCommandKey).filter(Boolean));
  if (requiredKeys.size === 0)
    return [];
  return validationRuns.filter((run) => requiredKeys.has(validationCommandKey(run.command)) && !run.ok).map((run) => {
    const exitCode = Number.isFinite(Number(run.exitCode)) ? Number(run.exitCode) : "unknown";
    const digest = extractValidationFailureDigest(run);
    return `${run.command} exited ${exitCode}${digest ? ` (${digest})` : ""}`;
  });
}
function extractRequiredValidationStepsFromVisionMarkdown(markdown) {
  const out = [];
  const seen = new Set;
  for (const criterion of extractVisionKeyItems(markdown).testingCriteria) {
    const command = extractRunnableValidationCommand(String(criterion ?? ""));
    if (!command)
      continue;
    const key = command.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(command);
    if (out.length >= 12)
      break;
  }
  return out;
}
function loadRequiredValidationStepsFromVision(repo) {
  const visionPath = resolve10(repo, "vision.md");
  if (!existsSync8(visionPath))
    return [];
  try {
    return extractRequiredValidationStepsFromVisionMarkdown(readFileSync8(visionPath, "utf8"));
  } catch {
    return [];
  }
}
function resolveRequiredValidationSteps(repo, planning) {
  return dedupeValidationCommands(runnableValidationCommandsFromSteps(planning.requiredValidationSteps), loadRequiredValidationStepsFromVision(repo)).slice(0, 12);
}
function runnableValidationCommandsFromSteps(steps) {
  const out = [];
  const seen = new Set;
  for (const step of steps ?? []) {
    const extracted = extractRunnableValidationCommand(String(step ?? ""));
    const command = extracted ? normalizeRunnableValidationCommand(extracted) : null;
    if (!command)
      continue;
    const key = command.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}
function normalizeRunnableValidationCommand(command) {
  if (/<[A-Za-z][A-Za-z0-9:._ -]*>/.test(command))
    return null;
  if (!tokenizeValidationCommandArgv(command))
    return null;
  const bunTestCommand = normalizeBunTestValidationCommand(command);
  return bunTestCommand === undefined ? command : bunTestCommand;
}
function normalizeBunTestValidationCommand(command) {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv || argv.length === 0 || !isBunCommandToken(argv[0] ?? ""))
    return;
  let testIndex = -1;
  for (let index = 1;index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--cwd" || lower === "-c" || lower === "-C" || lower === "--prefix") {
      index += 1;
      continue;
    }
    if (lower.startsWith("--cwd=") || lower.startsWith("-c=") || lower.startsWith("--prefix=")) {
      continue;
    }
    if (lower.startsWith("-"))
      continue;
    if (lower === "test")
      testIndex = index;
    break;
  }
  if (testIndex < 0)
    return;
  const prefix = argv.slice(0, testIndex + 1);
  const args = argv.slice(testIndex + 1);
  let droppedSupportPath = false;
  let runnablePathCount = 0;
  const keptArgs = [];
  for (const arg of args) {
    const normalizedPath = normalizeValidationPathToken(arg);
    if (normalizedPath && isTestSupportPath(normalizedPath) && !isAssertionCoverageTestPath(normalizedPath) && !isBrowserSmokeHarnessPath(normalizedPath)) {
      droppedSupportPath = true;
      continue;
    }
    if (normalizedPath && (isAssertionCoverageTestPath(normalizedPath) || isBrowserSmokeHarnessPath(normalizedPath))) {
      runnablePathCount += 1;
    }
    keptArgs.push(arg);
  }
  if (!droppedSupportPath)
    return command;
  if (runnablePathCount === 0)
    return null;
  return [...prefix, ...keptArgs].map((entry) => quoteValidationCommandArg2(entry)).join(" ");
}
function sanitizeMissingExplicitTestTargets(repo, command) {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv || argv.length === 0 || !isBunCommandToken(argv[0] ?? ""))
    return command;
  const lower = argv.map((entry) => entry.toLowerCase());
  const testIndex = lower.findIndex((entry) => entry === "test");
  if (testIndex < 0)
    return command;
  let droppedMissingTarget = false;
  let keptConcreteTarget = false;
  const keptArgs = [];
  for (const arg of argv.slice(testIndex + 1)) {
    const normalizedPath = normalizeValidationPathToken(arg);
    const isConcreteTestTarget = Boolean(normalizedPath) && (isAssertionCoverageTestPath(normalizedPath ?? "") || isBrowserSmokeHarnessPath(normalizedPath ?? ""));
    if (isConcreteTestTarget && normalizedPath && !existsSync8(resolve10(repo, normalizedPath))) {
      droppedMissingTarget = true;
      continue;
    }
    if (isConcreteTestTarget)
      keptConcreteTarget = true;
    keptArgs.push(arg);
  }
  if (!droppedMissingTarget)
    return command;
  if (!keptConcreteTarget)
    return null;
  return [...argv.slice(0, testIndex + 1), ...keptArgs].map((entry) => quoteValidationCommandArg2(entry)).join(" ");
}
function sanitizeValidationCommandsForCurrentCheckout(repo, commands) {
  if (!repo)
    return commands;
  return commands.map((command) => sanitizeMissingExplicitTestTargets(repo, command)).filter((command) => Boolean(command));
}
function dedupeValidationCommands(...groups) {
  const out = [];
  const seen = new Set;
  for (const group of groups) {
    for (const command of group) {
      const trimmed = command.trim();
      if (!trimmed)
        continue;
      const key = validationCommandKey(trimmed);
      if (seen.has(key))
        continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}
function isFocusedValidationCommand(command) {
  const argv = tokenizeValidationCommandArgv(command);
  if (!argv)
    return false;
  const lower = argv.map((entry) => entry.toLowerCase());
  const testIndex = lower.findIndex((entry) => entry === "test");
  if (testIndex < 0)
    return false;
  return argv.slice(testIndex + 1).some((entry) => {
    const normalized = normalizeValidationPathToken(entry);
    return Boolean(normalized && !entry.startsWith("-"));
  });
}
function escapeRegExp2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function validationCommandSubsumes(repo, aggregateCommand, candidateCommand) {
  if (validationCommandKey(aggregateCommand) === validationCommandKey(candidateCommand)) {
    return true;
  }
  const aggregate = resolvePackageScriptForValidationCommand(repo, aggregateCommand);
  if (!aggregate)
    return false;
  const candidate = resolvePackageScriptForValidationCommand(repo, candidateCommand);
  const aggregateText = [
    aggregate.script,
    readReferencedValidationScriptText(aggregate.cwd, aggregate.script)
  ].join(`
`);
  const normalizedCandidate = candidateCommand.trim().replace(/\s+/g, " ");
  if (new RegExp(escapeRegExp2(normalizedCandidate).replace(/\\ /g, "\\s+"), "i").test(aggregateText)) {
    return true;
  }
  if (candidate) {
    const scriptNamePattern = new RegExp(`(?:bun|npm|pnpm|yarn)(?:["'\`\\s,\\[\\]]+run)?["'\`\\s,\\[\\]]+${escapeRegExp2(candidate.scriptName)}(?:["'\`\\s,\\[\\]]|$)`, "i");
    if (scriptNamePattern.test(aggregateText))
      return true;
    if (candidate.script.length >= 8 && aggregateText.toLowerCase().includes(candidate.script.toLowerCase())) {
      return true;
    }
  }
  return false;
}
function buildValidationExecutionDag(repo, commands) {
  const deduped = dedupeValidationCommands(commands);
  const retained = deduped.filter((candidate, candidateIndex) => {
    if (isFocusedValidationCommand(candidate))
      return true;
    return !deduped.some((aggregate, aggregateIndex) => aggregateIndex !== candidateIndex && validationCommandSubsumes(repo, aggregate, candidate) && (!validationCommandSubsumes(repo, candidate, aggregate) || aggregateIndex < candidateIndex));
  });
  return retained.sort((left, right) => {
    const focusedDelta = Number(isFocusedValidationCommand(right)) - Number(isFocusedValidationCommand(left));
    if (focusedDelta !== 0)
      return focusedDelta;
    const leftAggregate = resolvePackageScriptForValidationCommand(repo, left) ? deduped.some((candidate) => candidate !== left && validationCommandSubsumes(repo, left, candidate)) : false;
    const rightAggregate = resolvePackageScriptForValidationCommand(repo, right) ? deduped.some((candidate) => candidate !== right && validationCommandSubsumes(repo, right, candidate)) : false;
    return Number(leftAggregate) - Number(rightAggregate);
  });
}
function collectQualityGateValidationCommands(params) {
  const requiredRunnableSteps = sanitizeValidationCommandsForCurrentCheckout(params.repo, runnableValidationCommandsFromSteps(params.planning.requiredValidationSteps).slice(0, 12));
  const plannerRunnableSteps = sanitizeValidationCommandsForCurrentCheckout(params.repo, runnableValidationCommandsFromSteps(params.planning.validationSteps).slice(0, 4));
  const fallbackValidationSteps = sanitizeValidationCommandsForCurrentCheckout(params.repo, params.isTestTask && plannerRunnableSteps.length === 0 ? inferFallbackValidationCommandsForTestTask(params.instruction, params.targetPath, params.planning, params.changedTestPaths) : []);
  const inferredRepoNativeValidationSteps = params.repo ? inferRepoNativeValidationCommands(params.repo, params.changedPaths ?? []) : [];
  const discoveredCommands = dedupeValidationCommands(requiredRunnableSteps, plannerRunnableSteps.length > 0 ? plannerRunnableSteps : fallbackValidationSteps, inferredRepoNativeValidationSteps).slice(0, 16);
  const commandsToRun = params.repo ? buildValidationExecutionDag(params.repo, discoveredCommands) : discoveredCommands;
  return {
    commandsToRun,
    requiredRunnableSteps,
    plannerRunnableSteps,
    fallbackValidationSteps,
    inferredRepoNativeValidationSteps
  };
}
function inferFallbackValidationCommandsForTestTask(instruction, targetPath, planning, changedTestPaths) {
  const candidates = [];
  const seen = new Set;
  const add = (command) => {
    const trimmed = command.trim();
    if (!trimmed)
      return;
    const key = trimmed.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  const lowerInstruction = instruction.toLowerCase();
  const pythonSignal = /\b(pytest|python)\b/.test(lowerInstruction) || changedTestPaths.some((entry) => entry.toLowerCase().endsWith(".py"));
  const bunTestPath = (path) => formatBunTestPathArg2(path);
  const normalizedTarget = (targetPath ?? "").replace(/\\/g, "/").trim();
  if (normalizedTarget && (isAssertionCoverageTestPath(normalizedTarget) || isBrowserSmokeHarnessPath(normalizedTarget))) {
    add(pythonSignal ? `pytest ${normalizedTarget}` : `bun test ${bunTestPath(normalizedTarget)}`);
  }
  const runnableChangedTestPaths = changedTestPaths.filter((entry) => isAssertionCoverageTestPath(entry) || isBrowserSmokeHarnessPath(entry));
  if (runnableChangedTestPaths.length > 0) {
    const focused = runnableChangedTestPaths.slice(0, 4);
    add(pythonSignal ? `pytest ${focused.join(" ")}` : `bun test ${focused.map((entry) => bunTestPath(entry)).join(" ")}`);
  }
  const scopeHints = [
    targetPath ?? "",
    ...planning.targetPaths ?? [],
    ...planning.scope.writeGlobs ?? [],
    ...planning.discovery?.likelyDirs ?? []
  ].map((entry) => entry.replace(/\\/g, "/").trim()).filter(Boolean);
  const appRoot = scopeHints.map((entry) => {
    const match = entry.match(/^apps\/[^/]+/i);
    return match?.[0] ?? "";
  }).find(Boolean);
  if (appRoot) {
    add(pythonSignal ? `pytest ${appRoot}` : `bun --cwd ${appRoot} test`);
  }
  if (candidates.length === 0) {
    add(pythonSignal ? "pytest" : "bun test");
  }
  return candidates.slice(0, 4);
}
function formatBunTestPathArg2(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/").trim();
  if (!normalized)
    return normalized;
  const pathArg = normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ? normalized : `./${normalized}`;
  return quoteValidationCommandArg2(pathArg);
}
function quoteValidationCommandArg2(arg) {
  if (!/[\s"\\]/.test(arg))
    return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function isTestFocusedTask(instruction, planning, targetPath) {
  const lowerInstruction = instruction.toLowerCase();
  if (/\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b.{0,80}\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/.test(lowerInstruction) || /\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b.{0,80}\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b/.test(lowerInstruction)) {
    return true;
  }
  if (targetPath && isLikelyTestPath(targetPath))
    return true;
  const pathHints = [
    ...planning.scope.writeGlobs ?? [],
    ...planning.discovery?.likelyDirs ?? []
  ];
  if (pathHints.some((entry) => isLikelyTestPath(entry)))
    return true;
  if (planning.acceptanceCriteria.some((entry) => /\b(add|write|create|update|extend|expand|harden|improve|refactor|move|extract|fix)\b.{0,80}\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/i.test(entry))) {
    return true;
  }
  return false;
}
function hasBalancedPositiveNegativeAssertions(paths, repo) {
  const negativeSignal = /(\.not\b|\b(invalid|negative|error|throw|reject|null|undefined|non[- ]?existent|toThrow|toBeNull|toBeUndefined|without|missing|absent|unchanged|same|remains?|stays?|prevent|avoid|zero|none)\b|<\s*0|<=\s*0)/i;
  let positiveAssertions = 0;
  let negativeAssertions = 0;
  for (const rel of paths) {
    const fullPath = resolve10(repo, rel);
    let content = "";
    try {
      content = readFileSync8(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!/\b(expect\(|assert\s+)/.test(line))
        continue;
      if (negativeSignal.test(line))
        negativeAssertions += 1;
      else
        positiveAssertions += 1;
    }
  }
  return positiveAssertions > 0 && negativeAssertions > 0;
}
function asRecord2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function changedPathMentionsGuidance(pathPattern, guidance) {
  return pathPattern.test(guidance);
}
function collectPrePublishHygieneIssues(params) {
  const changedPaths = params.changedPaths.map((path) => path.replace(/\\/g, "/"));
  const changedPathSet = new Set(changedPaths);
  const guidance = [
    params.instruction,
    params.targetPath ?? "",
    ...params.planning.targetPaths ?? [],
    ...params.planning.scope.writeGlobs ?? [],
    ...params.planning.acceptanceCriteria ?? [],
    ...params.planning.validationSteps ?? [],
    ...params.reviewAgent?.reviewerFindings ?? []
  ].join(`
`).toLowerCase();
  const issues = [];
  if (changedPathSet.has(".gitignore") && !changedPathMentionsGuidance(/\b(gitignore|ignore file|node_modules|dependency cache)\b/i, guidance)) {
    issues.push("modified .gitignore without task or reviewer guidance requesting ignore-policy changes.");
  }
  if (changedPathSet.has("tests/reactNativeMock.ts")) {
    const changedTestPaths = changedPaths.filter((path) => isAssertionCoverageTestPath(path));
    const hasConsumerInChangedTests = changedTestPaths.some((rel) => {
      try {
        return /reactNativeMock/i.test(readFileSync8(resolve10(params.repo, rel), "utf8"));
      } catch {
        return false;
      }
    });
    const explicitlyRequested = changedPathMentionsGuidance(/reactnativemock|react native mock/i, guidance);
    if (!hasConsumerInChangedTests && !explicitlyRequested) {
      issues.push("changed tests/reactNativeMock.ts without a changed test importing it or explicit reviewer guidance.");
    }
  }
  if (changedPaths.some((path) => isNestedNodeModulesChange(path))) {
    issues.push("attempted to publish node_modules changes; dependency installs must not become PR content.");
  }
  return Array.from(new Set(issues));
}
function inferRepoNativeValidationCommands(repo, changedPaths) {
  const packageJsonPath = resolve10(repo, "package.json");
  if (!existsSync8(packageJsonPath))
    return [];
  let packageJson = {};
  try {
    packageJson = JSON.parse(readFileSync8(packageJsonPath, "utf8"));
  } catch {
    return [];
  }
  const scripts = packageJson.scripts ?? {};
  const dependencies = {
    ...packageJson.dependencies ?? {},
    ...packageJson.devDependencies ?? {}
  };
  const normalizedPaths = changedPaths.map((path) => path.replace(/\\/g, "/"));
  const hasNonDocChange = normalizedPaths.some((path) => !/\.(?:md|mdx|txt)$/i.test(path));
  const hasTsChange = normalizedPaths.some((path) => /\.[cm]?tsx?$/i.test(path));
  const commands = [];
  if (hasTsChange) {
    if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
      commands.push("bun run typecheck");
    } else if (existsSync8(resolve10(repo, "tsconfig.json")) || Object.prototype.hasOwnProperty.call(dependencies, "typescript")) {
      commands.push("bun x tsc --noEmit");
    }
  }
  if (hasNonDocChange && typeof scripts.lint === "string" && scripts.lint.trim()) {
    commands.push("bun run lint");
  }
  return dedupeValidationCommands(commands).slice(0, 4);
}
async function runDeterministicQualityGate(repo, params, runtimeConfig, qualityGatePolicy, onLog, validationRetryState) {
  const instruction = String(params.instruction ?? "");
  const targetPath = String(params.targetPath ?? params.path ?? "").trim() || undefined;
  const planning = params.planning;
  const requiredValidationSteps = resolveRequiredValidationSteps(repo, planning);
  if (requiredValidationSteps.length > 0) {
    planning.requiredValidationSteps = requiredValidationSteps;
  }
  const isTestTask = isTestFocusedTask(instruction, planning, targetPath);
  const hasRequiredValidationCriteria = requiredValidationSteps.length > 0;
  if (!qualityGatePolicy.scopeGateEnabled && !qualityGatePolicy.validationGateEnabled && !qualityGatePolicy.criticGateEnabled && !isTestTask && !hasRequiredValidationCriteria) {
    return {
      ok: true,
      skipped: true,
      issues: [],
      scopeIssues: [],
      validationIssues: [],
      changedPaths: [],
      changedTestPaths: [],
      validationRuns: [],
      requiredValidationFailures: [],
      blocker: null,
      validationFailureScope: "none"
    };
  }
  const statusResult = await git2(repo, ["status", "--porcelain"]);
  const rawChangedPaths = statusResult.ok ? expandKnownArtifactDirectoryPaths(repo, parseChangedPathsFromStatus(statusResult.stdout)) : [];
  const changedPaths = statusResult.ok ? await filterChangedPathsByGitContentDelta(repo, rawChangedPaths) : rawChangedPaths;
  const preparedMergeConflictPaths = extractPreparedMergeConflictPaths(params);
  const changedTestPaths = Array.from(new Set([...changedPaths, ...preparedMergeConflictPaths].filter((path) => isLikelyTestPath(path))));
  const changedAssertionCoverageTestPaths = changedTestPaths.filter((path) => isAssertionCoverageTestPath(path));
  const issues = [];
  const scopeIssues = [];
  const validationIssues = [];
  const addScopeIssue = (issue) => {
    scopeIssues.push(issue);
    issues.push(`ScopeGate: ${issue}`);
  };
  const addValidationIssue = (issue) => {
    validationIssues.push(issue);
    issues.push(`ValidationGate: ${issue}`);
  };
  if (qualityGatePolicy.scopeGateEnabled) {
    if (!statusResult.ok) {
      addScopeIssue("could not evaluate changed paths from git status.");
    }
    for (const issue of collectPrePublishHygieneIssues({
      repo,
      changedPaths,
      instruction,
      targetPath,
      planning,
      reviewAgent: asRecord2(params.reviewAgent ?? params.review_agent)
    })) {
      addScopeIssue(issue);
    }
    for (const issue of collectWriteScopeIssuesFromChangedPaths(changedPaths, planning)) {
      addScopeIssue(issue);
    }
    if (isTestTask && changedTestPaths.length === 0 && !allowsValidationToolingOnlyChangeForTestFocusedTask({
      instruction,
      planning,
      changedPaths
    })) {
      addScopeIssue("found no relevant test file modified for this test-focused task.");
    }
    if (isTestTask && changedAssertionCoverageTestPaths.length > 0 && !hasBalancedPositiveNegativeAssertions(changedAssertionCoverageTestPaths, repo)) {
      addScopeIssue("found changed test files without both positive and negative assertion coverage (expected both).");
    }
    for (const issue of scopeIssues) {
      onLog?.("stderr", `[ScopeGate] ${issue}`);
    }
  } else {
    onLog?.("stdout", "[ScopeGate] Disabled by workerpals.quality_scope_gate_enabled=false.");
  }
  if (!qualityGatePolicy.validationGateEnabled) {
    onLog?.("stdout", "[ValidationGate] Disabled by workerpals.quality_validation_gate_enabled=false.");
  }
  const {
    commandsToRun: collectedCommandsToRun,
    requiredRunnableSteps,
    plannerRunnableSteps,
    fallbackValidationSteps
  } = collectQualityGateValidationCommands({
    instruction,
    targetPath,
    planning,
    changedTestPaths,
    isTestTask,
    repo,
    changedPaths
  });
  const commandsToRun = collectedCommandsToRun.map((command, index) => ({ command, index })).sort((left, right) => {
    const tierDelta = validationCommandExecutionTier(left.command) - validationCommandExecutionTier(right.command);
    return tierDelta !== 0 ? tierDelta : left.index - right.index;
  }).map((entry) => entry.command);
  const validationRuns = [];
  const cacheContext = await validationCacheContext(repo, changedPaths);
  const runValidationWithCache = async (command, runner) => {
    const cacheKey = `${cacheContext}\x00${validationCommandKey(command)}`;
    const cached = validationRetryState?.passingValidationCache?.get(cacheKey);
    if (cached?.ok) {
      onLog?.("stdout", `[ValidationGate] Cache hit for unchanged passing gate: ${command}`);
      return {
        ...cached,
        step: command,
        command,
        elapsedMs: 0
      };
    }
    const run = await runner();
    if (run.ok) {
      validationRetryState?.passingValidationCache?.set(cacheKey, { ...run });
    }
    return run;
  };
  const outputPolicy = outputPolicyForRuntime(runtimeConfig);
  const qualityValidationStepTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityValidationStepTimeoutMs);
    if (!Number.isFinite(value))
      return 180000;
    return Math.max(1000, Math.min(7200000, Math.floor(value)));
  })();
  let requiredValidationFailures = [];
  if (qualityGatePolicy.validationGateEnabled) {
    if (hasRequiredValidationCriteria && requiredRunnableSteps.length === 0) {
      addValidationIssue("found vision.md testing criteria, but none contained a runnable validation command.");
    }
    if (commandsToRun.length === 0) {
      addValidationIssue(hasRequiredValidationCriteria ? "found no runnable validation command from vision.md testing criteria or planning.validationSteps." : "found no runnable validation command in planning.validationSteps (expected at least one test command).");
    } else {
      if (requiredRunnableSteps.length > 0) {
        onLog?.("stdout", `[ValidationGate] Running required vision.md testing criteria: ${requiredRunnableSteps.join(" | ")}`);
      }
      if (isTestTask && plannerRunnableSteps.length === 0 && fallbackValidationSteps.length > 0) {
        onLog?.("stdout", `[ValidationGate] No runnable planning.validationSteps found; using fallback validation command(s): ${commandsToRun.join(" | ")}`);
      }
      const dependencyPreflightFailure = await runBunDependencyLayoutPreflight(repo, commandsToRun, requiredRunnableSteps[0] ?? commandsToRun[0] ?? "", qualityValidationStepTimeoutMs, outputPolicy, onLog);
      if (dependencyPreflightFailure) {
        validationRuns.push(dependencyPreflightFailure);
        onLog?.("stderr", `[ValidationGate] Dependency layout preflight blocked validation before "${dependencyPreflightFailure.command}".`);
      } else {
        const toolchainPlan = buildToolchainPlan({
          repoRoot: repo,
          validationCommands: commandsToRun
        });
        if (toolchainPlan.requirements.length > 0) {
          onLog?.("stdout", `[ValidationGate] Toolchain preflight: source=${toolchainPlan.environmentSource}, required=${toolchainPlan.requirements.map((requirement) => requirement.tool).join(", ")}`);
        }
        const toolAvailability = await checkToolAvailability(toolchainPlan.requirements, buildWorkerSandboxWritableEnv(repo));
        const missingToolRequirements = toolAvailability.filter((entry) => !entry.ok).map((entry) => entry.requirement);
        if (missingToolRequirements.length > 0) {
          onLog?.("stderr", `[ValidationGate] Toolchain preflight blocked dependent validation command(s): ${formatMissingToolRequirements(missingToolRequirements)}`);
        }
        const playwrightBrowserRuntimeReadyTargets = new Set;
        for (let commandIndex = 0;commandIndex < commandsToRun.length; ) {
          const nextCommand = commandsToRun[commandIndex];
          const higherTierDeferredReason = shouldDeferHigherTierValidationAfterFailure(nextCommand, validationRuns);
          if (higherTierDeferredReason) {
            commandIndex += 1;
            const stderr = `Skipped higher-tier validation command because ${higherTierDeferredReason}. ` + "Fix the focused blocker first; PushPals will run this gate after lower-tier validation is clean.";
            validationRuns.push({
              step: nextCommand,
              command: nextCommand,
              ok: false,
              exitCode: 125,
              stdout: "",
              stderr,
              elapsedMs: 1
            });
            onLog?.("stderr", `[ValidationGate] Deferred higher-tier validation after lower-tier failure: ${nextCommand} (${higherTierDeferredReason})`);
            continue;
          }
          const parallelBatch = [];
          const parallelTier = validationCommandExecutionTier(nextCommand);
          while (commandIndex + parallelBatch.length < commandsToRun.length && parallelBatch.length < 3) {
            const candidate = commandsToRun[commandIndex + parallelBatch.length];
            if (validationCommandExecutionTier(candidate) !== parallelTier || !isParallelSafeFastValidationCommand(repo, candidate)) {
              break;
            }
            parallelBatch.push(candidate);
          }
          if (parallelBatch.length > 1) {
            onLog?.("stdout", `[ValidationGate] Running fast validation batch in parallel: ${parallelBatch.join(" | ")}`);
            const batchRuns = await Promise.all(parallelBatch.map(async (command2) => {
              const commandMissingTools2 = requirementsForValidationCommand(toolchainPlan, command2).filter((requirement) => missingToolRequirements.some((missing) => missing.tool === requirement.tool));
              if (commandMissingTools2.length > 0) {
                const stderr = `Validation skipped before execution because required tool(s) are missing: ${formatMissingToolRequirements(commandMissingTools2)}.`;
                return {
                  run: {
                    step: command2,
                    command: command2,
                    ok: false,
                    exitCode: 127,
                    stdout: "",
                    stderr,
                    elapsedMs: 1
                  },
                  stream: "stderr",
                  summary: `[ValidationGate] Validation skipped (missing toolchain): ${command2}`
                };
              }
              let run2 = await runValidationWithCache(command2, () => runValidationCommand(repo, command2, resolveValidationCommandTimeoutMs(command2, qualityValidationStepTimeoutMs, repo), outputPolicy));
              if (!run2.ok && (shouldRetryPassingVitestTeardownOnce(run2) || shouldRetryTransientInfrastructureValidationOnce(run2))) {
                const firstDigest2 = extractValidationFailureDigest(run2);
                onLog?.("stderr", `[ValidationGate] Retrying fast validation once after transient infrastructure/teardown failure: ${command2}${firstDigest2 ? ` - ${firstDigest2}` : ""}`);
                run2 = await runValidationCommand(repo, command2, resolveValidationCommandTimeoutMs(command2, qualityValidationStepTimeoutMs, repo), outputPolicy);
                if (run2.ok) {
                  validationRetryState?.passingValidationCache?.set(`${cacheContext}\x00${validationCommandKey(command2)}`, { ...run2, step: command2, command: command2 });
                }
              }
              const digest2 = run2.ok ? "" : extractValidationFailureDigest(run2);
              return {
                run: run2,
                stream: run2.ok ? "stdout" : "stderr",
                summary: `[ValidationGate] ${run2.ok ? "Passed" : "Failed"} (${run2.elapsedMs}ms, exit ${run2.exitCode}): ${command2}${digest2 ? ` - ${digest2}` : ""}`
              };
            }));
            for (const { run: run2, stream, summary } of batchRuns) {
              validationRuns.push(run2);
              onLog?.(stream, summary);
            }
            commandIndex += parallelBatch.length;
            continue;
          }
          const command = commandsToRun[commandIndex];
          commandIndex += 1;
          const commandMissingTools = requirementsForValidationCommand(toolchainPlan, command).filter((requirement) => missingToolRequirements.some((missing) => missing.tool === requirement.tool));
          if (commandMissingTools.length > 0) {
            const stderr = `Validation skipped before execution because required tool(s) are missing: ${formatMissingToolRequirements(commandMissingTools)}.`;
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 127,
              stdout: "",
              stderr,
              elapsedMs: 1
            });
            onLog?.("stderr", `[ValidationGate] Validation skipped (missing toolchain): ${command}`);
            continue;
          }
          const deferredReason = shouldDeferLongValidationAfterFastFailures(command, validationRuns, repo);
          if (deferredReason) {
            const stderr = `Skipped long validation command because ${deferredReason}. ` + "Fix the deterministic fast validation blocker first; PushPals will run long browser/e2e validation after the fast layer is clean.";
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 125,
              stdout: "",
              stderr,
              elapsedMs: 1
            });
            onLog?.("stderr", `[ValidationGate] Deferred long validation after fast failure: ${command} (${deferredReason})`);
            continue;
          }
          const commandNeedsPlaywrightBrowserRuntime = shouldEnsurePlaywrightBrowserRuntime(repo, command);
          const playwrightBrowserTargets = commandNeedsPlaywrightBrowserRuntime ? inferPlaywrightBrowserInstallTargets(repo, command) : [];
          const missingPlaywrightBrowserTargets = playwrightBrowserTargets.filter((target) => !playwrightBrowserRuntimeReadyTargets.has(target));
          let commandBrowserRuntimeEnsured = commandNeedsPlaywrightBrowserRuntime && missingPlaywrightBrowserTargets.length === 0;
          if (missingPlaywrightBrowserTargets.length > 0) {
            const browserEnv = buildWorkerSandboxWritableEnv(repo);
            onLog?.("stdout", `[ValidationGate] Browser runtime preflight: ensuring Playwright browser target(s) ${missingPlaywrightBrowserTargets.join(", ")} for "${command}" at ${browserEnv.PLAYWRIGHT_BROWSERS_PATH ?? "(default browser cache)"}`);
            const browserPreflight = await runPlaywrightBrowserRuntimePreflight(repo, command, missingPlaywrightBrowserTargets, resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo), outputPolicy);
            if (!browserPreflight.ok) {
              const digest2 = extractValidationFailureDigest(browserPreflight);
              validationRuns.push({
                ...browserPreflight,
                stderr: [
                  `Browser runtime preflight failed before validation command "${command}". WorkerPals could not ensure Playwright browser target(s) ${missingPlaywrightBrowserTargets.join(", ")} in PLAYWRIGHT_BROWSERS_PATH=${browserEnv.PLAYWRIGHT_BROWSERS_PATH ?? "(default)"}.`,
                  browserPreflight.stderr
                ].filter(Boolean).join(`
`)
              });
              onLog?.("stderr", `[ValidationGate] Browser runtime preflight failed for "${command}"${digest2 ? ` - ${digest2}` : ""}`);
              continue;
            }
            for (const target of missingPlaywrightBrowserTargets) {
              playwrightBrowserRuntimeReadyTargets.add(target);
            }
            onLog?.("stdout", `[ValidationGate] Browser runtime preflight passed for "${command}" (${missingPlaywrightBrowserTargets.join(", ")})`);
            commandBrowserRuntimeEnsured = true;
          }
          const previousDigest = validationRetryState?.previousFailureDigests?.get(validationCommandKey(command));
          if (previousDigest && Number(validationRetryState?.revisionAttempt ?? 0) > 0 && validationCommandIncludesLongRunningBrowserWork(repo, command) && isBrowserValidationInfrastructureDigest(previousDigest) && !commandBrowserRuntimeEnsured) {
            const stderr = `Skipped repeated browser validation after the same command failed in an earlier revision: ${previousDigest}. ` + "Run it once after the underlying blocker changes.";
            validationRuns.push({
              step: command,
              command,
              ok: false,
              exitCode: 124,
              stdout: "",
              stderr,
              elapsedMs: 1
            });
            onLog?.("stderr", `[ValidationGate] Skipped repeated long browser validation: ${command} (${previousDigest})`);
            continue;
          }
          onLog?.("stdout", `[ValidationGate] Running "${command}"`);
          let run = await runValidationWithCache(command, () => runValidationCommandWithRepoLease(repo, command, resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo), outputPolicy, onLog));
          const firstDigest = run.ok ? "" : extractValidationFailureDigest(run);
          const retryBrowserValidation = shouldRetryBrowserValidationRunOnce(run, repo);
          const retryAggregateWorkerValidation = shouldRetryAggregateWorkerValidationRunOnce(run, repo);
          const focusedAggregateRetryCommand = retryAggregateWorkerValidation ? aggregateWorkerValidationRetryCommand(run, repo) : null;
          const retryPassingVitestTeardown = shouldRetryPassingVitestTeardownOnce(run);
          const retryTransientInfrastructure = shouldRetryTransientInfrastructureValidationOnce(run);
          if (retryBrowserValidation || retryAggregateWorkerValidation || retryPassingVitestTeardown || retryTransientInfrastructure) {
            onLog?.("stderr", retryPassingVitestTeardown ? `[ValidationGate] Retrying validation once after all Vitest assertions passed but worker teardown failed: ${command}${firstDigest ? ` - ${firstDigest}` : ""}` : retryAggregateWorkerValidation ? `[ValidationGate] Retrying only the failed Worker validation stage after aggregate cold-start failure: ${focusedAggregateRetryCommand ?? command}${firstDigest ? ` - ${firstDigest}` : ""}` : retryBrowserValidation ? `[ValidationGate] Retrying browser validation once after retryable startup/runtime failure: ${command}${firstDigest ? ` - ${firstDigest}` : ""}` : `[ValidationGate] Retrying validation once after transient infrastructure failure: ${command}${firstDigest ? ` - ${firstDigest}` : ""}`);
            if (retryAggregateWorkerValidation) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
            }
            const retryCommand = focusedAggregateRetryCommand ?? command;
            let retryRun = await runValidationCommandWithRepoLease(repo, retryCommand, resolveValidationCommandTimeoutMs(retryCommand, qualityValidationStepTimeoutMs, repo), outputPolicy, onLog);
            if (focusedAggregateRetryCommand && retryRun.ok) {
              onLog?.("stdout", `[ValidationGate] Focused Worker stage passed; rerunning the aggregate command once to verify all remaining stages: ${command}`);
              retryRun = await runValidationCommandWithRepoLease(repo, command, resolveValidationCommandTimeoutMs(command, qualityValidationStepTimeoutMs, repo), outputPolicy, onLog);
            } else if (focusedAggregateRetryCommand) {
              retryRun = {
                ...retryRun,
                step: command,
                command,
                stderr: [
                  `Aggregate validation retry narrowed to failed stage "${focusedAggregateRetryCommand}" and it remained failing.`,
                  retryRun.stderr
                ].filter(Boolean).join(`
`)
              };
            }
            if (!retryRun.ok && firstDigest) {
              retryRun.stderr = [
                `Previous validation attempt failed before retry: ${firstDigest}`,
                retryRun.stderr
              ].filter(Boolean).join(`
`);
            }
            run = retryRun;
          }
          if (run.ok && validationCommandKey(run.command) === validationCommandKey(command)) {
            validationRetryState?.passingValidationCache?.set(`${cacheContext}\x00${validationCommandKey(command)}`, { ...run, step: command, command });
          }
          validationRuns.push(run);
          const digest = run.ok ? "" : extractValidationFailureDigest(run);
          const runSummary = `[ValidationGate] ${run.ok ? "Passed" : "Failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}${digest ? ` - ${digest}` : ""}`;
          onLog?.(run.ok ? "stdout" : "stderr", runSummary);
        }
      }
      const notFoundRuns = validationRuns.filter((run) => run.exitCode === 127);
      const executedRuns = validationRuns.filter((run) => run.exitCode !== 127);
      if (notFoundRuns.length > 0) {
        const cmds = notFoundRuns.map((run) => run.command).join(", ");
        onLog?.("stderr", `[ValidationGate] Some validation commands not found (exit 127 - wrong tool?): ${cmds}. This project uses Bun: prefer "bun test".`);
      }
      if (executedRuns.length > 0 && executedRuns.every((run) => !run.ok)) {
        addValidationIssue("executed validation commands, but none passed.");
      } else if (executedRuns.length === 0 && notFoundRuns.length > 0) {
        addValidationIssue('could not run any validation command (command not found). Use "bun test" or another available test runner.');
      }
      if (isTestTask && !validationRuns.some((run) => validationCommandIncludesTestWork(repo, run.command))) {
        addValidationIssue("did not execute a recognizable test command.");
      }
    }
    requiredValidationFailures = collectRequiredValidationFailures(requiredRunnableSteps, validationRuns);
    if (requiredValidationFailures.length > 0) {
      addValidationIssue(`Required vision.md validation failed: ${requiredValidationFailures.join("; ")}`);
    }
  }
  const blocker = qualityGatePolicy.validationGateEnabled ? detectValidationBlocker(validationRuns) : null;
  const scopedValidationFailure = qualityGatePolicy.validationGateEnabled ? classifyValidationFailureScope(validationRuns, planning, changedPaths, targetPath) : "none";
  if (scopedValidationFailure === "outside_task_scope") {
    onLog?.("stderr", "[ValidationGate] Required validation failures appear outside the task target/relevance hints; blocking publish and allowing guarded repo validation repair when auto-revision budget remains.");
  }
  return {
    ok: issues.length === 0 && blocker === null,
    skipped: false,
    issues,
    scopeIssues,
    validationIssues,
    changedPaths,
    changedTestPaths,
    validationRuns,
    requiredValidationFailures,
    blocker,
    validationFailureScope: scopedValidationFailure
  };
}
function resolveQualityCriticTimeoutMs(runtimeConfig) {
  const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
  if (!Number.isFinite(value))
    return 90000;
  return Math.max(1000, Math.min(7200000, Math.floor(value)));
}
function resolveQualityCriticTimeoutBehavior(runtimeConfig) {
  const value = String(runtimeConfig.workerpals.qualityCriticTimeoutBehavior ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (value === "skip" || value === "retry_once" || value === "block")
    return value;
  return "retry_once";
}
function resolveQualityCriticModel(runtimeConfig, fallback = "") {
  return String(runtimeConfig.workerpals.qualityCriticModel ?? "").trim() || fallback.trim();
}
function resolveQualityCriticMaxDiffChars(runtimeConfig, compact = false) {
  const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
  const max = Number.isFinite(value) ? value : 16000;
  const bounded = Math.max(256, Math.min(524288, Math.floor(max)));
  return compact ? Math.min(bounded, 6000) : bounded;
}
function resolveQualityCriticMaxValidationOutputChars(runtimeConfig, compact = false) {
  const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
  const max = Number.isFinite(value) ? value : 8000;
  const bounded = Math.max(256, Math.min(524288, Math.floor(max)));
  return compact ? Math.min(bounded, 2000) : bounded;
}
function buildCriticValidationSummary(quality, maxValidationOutputChars) {
  const allPassed = quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
  return quality.validationRuns.map((run) => {
    const output = allPassed ? "" : [run.stdout, run.stderr].filter(Boolean).join(`
`).slice(0, maxValidationOutputChars);
    return [
      `Command: ${run.command}`,
      `Result: ${run.ok ? "pass" : "fail"} (exit ${run.exitCode}, ${run.elapsedMs}ms)`,
      output ? `Output:
${output}` : ""
    ].filter(Boolean).join(`
`);
  }).join(`

---

`);
}
function criticTimeoutReview(source, timeoutMs, elapsedMs) {
  const summary = `${source} critic timed out after ${elapsedMs}ms (timeout=${timeoutMs}ms).`;
  return {
    score: 0,
    findings: [summary],
    mustFix: [
      "CriticGate timeout behavior is set to block; complete the critic review by reducing critic input, choosing a faster critic model, or increasing workerpals.quality_critic_timeout_ms."
    ],
    revisionGuidance: "Do not change product code for this finding unless product code caused the critic prompt explosion. Adjust CriticGate configuration or reduce validation/diff evidence volume.",
    raw: JSON.stringify({ score: 0, findings: [summary], must_fix: ["CriticGate timed out"] })
  };
}
async function runTaskCriticReview(repo, params, quality, runtimeConfig, onLog) {
  const endpoint = normalizeChatCompletionsEndpoint(runtimeConfig.workerpals.llm.endpoint);
  const model = resolveQualityCriticModel(runtimeConfig, runtimeConfig.workerpals.llm.model.trim());
  if (!endpoint || !model)
    return null;
  const qualityCriticTimeoutMs = resolveQualityCriticTimeoutMs(runtimeConfig);
  const timeoutBehavior = resolveQualityCriticTimeoutBehavior(runtimeConfig);
  const planning = params.planning;
  const instruction = String(params.instruction ?? "").trim();
  const acceptanceCriteriaText = planning.acceptanceCriteria.map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const validationStepsText = [
    ...planning.validationSteps,
    ...(planning.requiredValidationSteps ?? []).map((entry) => `${entry} (required by vision.md testing criteria)`)
  ].map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const changedPathsText = quality.changedPaths.map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const criticSystem = loadPromptTemplate("workerpals/task_quality_critic_system_prompt.md").trim();
  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`;
  const buildAttemptPayload = async (compact) => {
    const changedForDiff = quality.changedPaths.slice(0, compact ? 4 : 8);
    let diffText = await buildCriticDiffText(repo, changedForDiff);
    diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(0, resolveQualityCriticMaxDiffChars(runtimeConfig, compact));
    const validationSummary = buildCriticValidationSummary(quality, resolveQualityCriticMaxValidationOutputChars(runtimeConfig, compact));
    const criticUser = loadPromptTemplate("workerpals/task_quality_critic_user_prompt.md", {
      instruction,
      acceptance_criteria: acceptanceCriteriaText,
      validation_steps: validationStepsText,
      changed_paths: changedPathsText,
      diff_excerpt: diffText || "(empty diff excerpt)",
      validation_evidence: validationSummary || "(no validation output)"
    });
    const promptChars = criticSystem.length + criticUser.length;
    const promptBytes = new TextEncoder().encode(`${criticSystem}
${criticUser}`).length;
    return {
      bodyBase: {
        model,
        messages: [
          { role: "system", content: criticSystem },
          { role: "user", content: criticUser }
        ],
        temperature: 0,
        max_tokens: compact ? 500 : 700
      },
      promptChars,
      promptBytes,
      diffChars: diffText.length,
      validationChars: validationSummary.length
    };
  };
  const runCriticRequest = async (bodyBase, responseFormat) => {
    const controller = new AbortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, qualityCriticTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(responseFormat ? { ...bodyBase, response_format: responseFormat } : bodyBase),
        signal: controller.signal
      });
      const text = await response.text();
      return { timedOut: false, response, text };
    } catch (err) {
      if (!timedOut && String(err?.name ?? "") !== "AbortError") {
        throw err;
      }
      return { timedOut: true, err };
    } finally {
      clearTimeout(timer);
    }
  };
  const runAttempt = async (attempt, compact) => {
    const payload = await buildAttemptPayload(compact);
    const startedAt = Date.now();
    onLog?.("stdout", `[CriticGate] LLM review attempt ${attempt}${compact ? " (compact)" : ""}: model=${model} timeout_ms=${qualityCriticTimeoutMs} behavior=${timeoutBehavior} prompt_chars=${payload.promptChars} prompt_bytes=${payload.promptBytes} diff_chars=${payload.diffChars} validation_chars=${payload.validationChars}`);
    let request = await runCriticRequest(payload.bodyBase, { type: "json_object" });
    if (request.timedOut)
      return { status: "timeout" };
    if (!request.response.ok && request.response.status === 400) {
      const lowered = request.text.toLowerCase();
      if (lowered.includes("response_format")) {
        onLog?.("stdout", "[CriticGate] fallback: response_format json_object unsupported; retrying without strict response_format.");
        request = await runCriticRequest(payload.bodyBase, null);
        if (request.timedOut)
          return { status: "timeout" };
      }
    }
    if (!request.response.ok) {
      onLog?.("stderr", `[CriticGate] review request failed (${request.response.status}): ${toSingleLine(request.text, 240)}`);
      return { status: "done", review: null };
    }
    const responsePayload = parseJsonObjectLoose(request.text) ?? JSON.parse(request.text);
    const choices = Array.isArray(responsePayload.choices) ? responsePayload.choices : [];
    const content = String(choices[0]?.message?.content ?? "").trim();
    const reviewObj = parseJsonObjectLoose(content);
    if (!reviewObj) {
      onLog?.("stderr", `[CriticGate] produced non-JSON content; skipping critic gate. Raw: ${toSingleLine(content, 220)}`);
      return { status: "done", review: null };
    }
    const scoreRaw = Number(reviewObj.score);
    const findings = Array.isArray(reviewObj.findings) ? reviewObj.findings.map((entry) => String(entry).trim()).filter(Boolean) : [];
    const mustFix = Array.isArray(reviewObj.must_fix) ? reviewObj.must_fix.map((entry) => String(entry).trim()).filter(Boolean) : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "").trim().slice(0, 2000);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    onLog?.("stdout", `[CriticGate] LLM review completed in ${Date.now() - startedAt}ms (attempt ${attempt}).`);
    return {
      status: "done",
      review: {
        score,
        findings,
        mustFix,
        revisionGuidance,
        raw: compactJobOutput(content, outputPolicyForRuntime(runtimeConfig))
      }
    };
  };
  try {
    let attempt = await runAttempt(1, false);
    if (attempt.status === "timeout" && timeoutBehavior === "retry_once") {
      onLog?.("stderr", `[CriticGate] LLM review timed out after ${qualityCriticTimeoutMs}ms; retrying once with compact critic input.`);
      attempt = await runAttempt(2, true);
    }
    if (attempt.status === "timeout") {
      if (timeoutBehavior === "block") {
        onLog?.("stderr", `[CriticGate] LLM review timed out after ${qualityCriticTimeoutMs}ms; blocking because quality_critic_timeout_behavior=block.`);
        return criticTimeoutReview("LLM", qualityCriticTimeoutMs, qualityCriticTimeoutMs);
      }
      onLog?.("stderr", `[CriticGate] LLM timed out after ${qualityCriticTimeoutMs}ms; skipping.`);
      return null;
    }
    return attempt.review;
  } catch (err) {
    onLog?.("stderr", `[CriticGate] review unavailable: ${toSingleLine(err, 220)} (continuing without critic gate).`);
    return null;
  }
}
function buildQualityRevisionHint(issues, critic, planning, reviewFixContext, validationRuns = [], validationBlocker = null, browserRepairPacket = null, changedPaths = [], validationRemedyHints = [], repoValidationRepairMode = false) {
  const lines = [];
  lines.push("Quality revision required before completion.");
  const focusedBrowserRepair = Boolean(browserRepairPacket) && !repoValidationRepairMode;
  if (repoValidationRepairMode) {
    lines.push("Repo validation repair mode: required project validation failed outside the original target/relevance hints. Keep the original patch only if it remains useful, but temporarily broaden discovery and edits to the smallest behavior-owning source, test, mock, package, or config files needed to make the failed validation commands pass.");
    lines.push("Scope rule for this repair: original target paths and write globs are stale/advisory for the validation blocker; forbidden paths and generated/runtime artifacts are still off limits.");
  }
  lines.push("Worker phase contract: (1) discovering - inspect only the relevant files/artifacts and name the current hypothesis; (2) editing - make the smallest behavior-owning patch; (3) focused validation - run targeted fast checks; (4) full validation - let PushPals ValidationGate own long required checks unless a single local confirmation is explicitly useful; (5) final diff review - verify changed files are necessary and no unrelated churn remains.");
  const diffBudgetWarning = buildDiffBudgetWarning(planning, changedPaths, focusedBrowserRepair);
  if (diffBudgetWarning)
    lines.push(diffBudgetWarning);
  const broadSharedMockWarning = buildBroadSharedMockWarning(planning, changedPaths);
  if (broadSharedMockWarning)
    lines.push(broadSharedMockWarning);
  const testHarnessConvergenceWarning = buildTestHarnessConvergenceWarning(planning, issues, validationRuns);
  if (testHarnessConvergenceWarning)
    lines.push(testHarnessConvergenceWarning);
  if ((planning.repoHintDiagnostics ?? []).length > 0) {
    lines.push("Repo hint diagnostics:");
    for (const hint of planning.repoHintDiagnostics ?? []) {
      lines.push(`- ${hint}`);
    }
    lines.push("Hint handling rule: stale or absent path hints are advisory context, not permission to invent repo-specific scaffolding. Prefer an existing behavior owner or existing nearby test.");
  }
  if (validationRemedyHints.length > 0) {
    lines.push("Known issue/remedy memory for this repo/job family:");
    for (const hint of validationRemedyHints.slice(0, 5)) {
      lines.push(`- ${hint}`);
    }
  }
  if (planningLooksLikeVisualDerivationTask(planning)) {
    lines.push("Visual derivation testing rule: prefer pure helper/state/style-prop tests for planet/projectile/ownership/readability cues. Only add a full React Native render regression when this repo already has a stable harness for that exact surface; otherwise keep render-visible behavior covered through the derived inputs that drive it.");
  }
  lines.push("Phase soft-budget reminder: if discovery, test-harness setup, or validation repair is running long, reduce the approach before spending more time. Small/medium tasks should converge toward a useful patch within roughly 20 minutes.");
  const validationAlreadyPassed = validationRuns.length > 0 && validationRuns.every((run) => run.ok);
  if (validationAlreadyPassed && !focusedBrowserRepair) {
    lines.push("Validation-preserving cleanup mode: the previous ValidationGate pass succeeded. Treat the validated patch and browser path as frozen; address only the listed ScopeGate/CriticGate cleanup with the smallest possible diff.");
    lines.push("Do not rewrite app behavior, route flow, browser smoke selectors, validation scripts, or unrelated tests unless the listed cleanup explicitly requires that exact change.");
    lines.push("After the cleanup, run fast focused checks if useful and let PushPals ValidationGate rerun the full required validation set.");
  }
  if (browserRepairPacket && !repoValidationRepairMode) {
    lines.push("Primary ValidationGate repair objective:");
    lines.push(`- Command: ${browserRepairPacket.command}`);
    lines.push(`- Failure type: browser ${browserRepairPacket.failureKind}`);
    lines.push("- First action: inspect the captured browser output/artifacts and actual rendered UI before editing; do not guess from component names or intended copy.");
    if (browserRepairPacket.stage)
      lines.push(`- Stage: ${browserRepairPacket.stage}`);
    if (browserRepairPacket.failureFocus) {
      lines.push(`- Failure focus: ${browserRepairPacket.failureFocus}`);
    }
    if (browserRepairPacket.lastVerifiedStage) {
      lines.push(`- Last verified browser checkpoint: ${browserRepairPacket.lastVerifiedStage}`);
    }
    if (browserRepairPacket.pageUrl) {
      lines.push(`- Browser URL at failure: ${browserRepairPacket.pageUrl}`);
    }
    if (browserRepairPacket.expected) {
      lines.push(`- Expected UI: ${browserRepairPacket.expected}`);
    }
    if (browserRepairPacket.selector) {
      lines.push(`- Selector/wait: ${browserRepairPacket.selector}`);
    }
    if (browserRepairPacket.artifacts.length > 0) {
      lines.push("Failure artifacts to inspect:");
      for (const artifact of browserRepairPacket.artifacts) {
        lines.push(`- ${artifact}`);
      }
    } else {
      lines.push("- Failure artifacts: none were captured in command output; if this repo writes screenshots/traces, inspect the latest browser failure artifact before changing selectors.");
    }
    if ((browserRepairPacket.artifactSummaries ?? []).length > 0) {
      lines.push("Latest browser artifact summaries:");
      for (const artifactSummary of browserRepairPacket.artifactSummaries ?? []) {
        lines.push(`- ${artifactSummary}`);
      }
    }
    if ((browserRepairPacket.knownFailureHints ?? []).length > 0) {
      lines.push("Known issue/remedy memory for this repo/job family:");
      for (const hint of browserRepairPacket.knownFailureHints ?? []) {
        lines.push(`- ${hint}`);
      }
    }
    if (browserRepairPacket.digest) {
      lines.push(`- Current failure: ${browserRepairPacket.digest}`);
    }
    if (browserRepairPacket.previousDigest) {
      const breadcrumb = browserRepairPacket.progress === "same_failure" ? "same failure repeated for this command" : "new failure for this command after the previous revision";
      lines.push(`- Breadcrumb: ${breadcrumb}; previous failure was ${browserRepairPacket.previousDigest}`);
      if (browserRepairPacket.previousStage || browserRepairPacket.previousExpected || browserRepairPacket.previousSelector) {
        lines.push("Previous browser failure detail:");
        if (browserRepairPacket.previousStage) {
          lines.push(`- Previous stage: ${browserRepairPacket.previousStage}`);
        }
        if (browserRepairPacket.previousExpected) {
          lines.push(`- Previous expected UI: ${browserRepairPacket.previousExpected}`);
        }
        if (browserRepairPacket.previousSelector) {
          lines.push(`- Previous selector/wait: ${browserRepairPacket.previousSelector}`);
        }
      }
    } else {
      lines.push("- Breadcrumb: first captured failure for this command in this revision loop");
    }
    if (browserRepairPacket.mustReadArtifactsBeforeEdit) {
      lines.push("- Diagnostic artifact read requirement: before editing, explicitly inspect the listed latest artifact/log/DOM summary for the failing stage. If the artifacts are missing, stale, or stop before the failing locator, add a tiny temporary diagnostic/log for locator counts, visible text, URL, and nearby DOM/test-id state before changing product code or selectors.");
    }
    if (browserRepairPacket.needsDiagnosticProbe) {
      lines.push("- Convergence mode: diagnostic-first repair. This same browser focus failed in the previous revision, so do not guess another selector or rewrite a different stage.");
      lines.push("- Diagnostic requirement: before editing again, inspect or add a tiny temporary diagnostic around the failing stage that records locator counts, visible textContent, role/ARIA attributes, data-testid values, bounding boxes, and a nearby DOM snippet for the candidate nodes.");
      lines.push("- Artifact freshness rule: only trust screenshots/logs captured after the failing action in the current revision. If the screenshot is stale or stops before the failing locator, capture or print the DOM state instead of reasoning from that image.");
      lines.push("- React Native Web note: screenshots can show the intended state while Playwright reads a duplicate or stale rendered node. Prefer one unique selected-state test id or a semantic checked attribute on the stable pressable, then assert locator count and visibility.");
    }
    if (browserRepairPacket.output) {
      lines.push(`- Relevant output: ${browserRepairPacket.output}`);
    }
    if (browserRepairPacket.failureKind === "assertion") {
      lines.push("Repair direction: fix this exact visible UI assertion or the app state that should make it true. If the expected text/role/test id is not present in the screenshot, update the smoke assertion to the visible product UI that proves the same stage, or add accessibility metadata to an existing control. Do not add optional navigation or broaden the smoke path. Do not change browser startup, port selection, Playwright installation, or unrelated e2e harness behavior unless the captured failure is reclassified as startup/setup.");
      lines.push("Selector stability rule: prefer existing data-testid/accessibility labels/roles and stage containers over guessed title/body text. If a stage already passed with a stable container such as a home/shell/test-id locator, reuse that signal instead of replacing it with copy checks.");
      lines.push("Text assertion rule: rendered titles may be split across sibling nodes. Do not invent a combined phrase for split text; either assert the individual visible fragments within the stage container or add/reuse a stable test id/accessibility label.");
      if (browserRepairPacket.progress === "same_failure" || browserRepairPacket.stage && browserRepairPacket.previousStage && browserRepairPacket.stage === browserRepairPacket.previousStage) {
        lines.push("Repeated-stage rule: this browser stage has failed before in the current revision loop, so treat the previous selector/copy assumption as suspect and switch to the most stable rendered locator for that same stage.");
      }
    } else {
      lines.push("Repair direction: this is a browser startup/runtime/network failure. Fix only startup/runtime provisioning for this command and do not rewrite app UI assertions unless a later ValidationGate run reaches an assertion stage.");
    }
    lines.push("Convergence rule: preserve stages that already passed, repair only the current failing browser stage, and stop after one targeted browser confirmation so the next ValidationGate run gets a clean signal.");
    lines.push("Executor sandbox rule: if the full browser command cannot run inside this edit turn because local server binding is denied or Expo/Playwright reports ERR_SOCKET_BAD_PORT, listen EPERM, EACCES, or a local port bind/freeport failure before reaching the app, treat that as a Codex executor verification limitation. Do not change app startup, ports, or browser provisioning for that local-only signal unless the ValidationGate failure above is also a startup/setup failure. Use the captured artifacts plus fast checks, then let ValidationGate perform the authoritative browser run.");
    if (browserRepairPacket.needsDiagnosticProbe) {
      lines.push(`Validation rerun rule: PushPals ValidationGate will rerun "${browserRepairPacket.command}" after the patch, but this is now a repeated browser assertion. If a quick local startup probe shows the browser server can run in this executor, run exactly one targeted "${browserRepairPacket.command}" confirmation after the DOM-backed fix. Do not stop after fast checks only. Do not hand off another unverified selector guess.`);
    } else {
      lines.push(`Validation rerun rule: PushPals ValidationGate will rerun "${browserRepairPacket.command}" after the patch. During a focused browser repair turn, run fast non-browser checks and inspect captured artifacts first; do not run the full browser command from the Codex executor by default. Only run the full browser command for one targeted confirmation if artifacts are missing and a quick local bind/startup probe shows the browser server can actually run in this executor. Otherwise stop after fast checks so ValidationGate gets the clean authoritative signal.`);
    }
  }
  if (reviewFixContext) {
    lines.push("Rejected PR retry requirements:");
    if (reviewFixContext.previousReviewScore != null) {
      lines.push(`Previous ReviewAgent score: ${reviewFixContext.previousReviewScore.toFixed(1)} / 10`);
    }
    if (reviewFixContext.reviewThreshold != null) {
      lines.push(`Required approval threshold: ${reviewFixContext.reviewThreshold.toFixed(1)} / 10`);
    }
    if (reviewFixContext.previousReviewSummary) {
      lines.push(`Previous reviewer summary: ${toSingleLine(reviewFixContext.previousReviewSummary, 220)}`);
    }
    if (reviewFixContext.reviewerFindings.length > 0) {
      lines.push("Previous reviewer must-fix items:");
      for (const finding of reviewFixContext.reviewerFindings.slice(0, 5)) {
        lines.push(`- ${finding}`);
      }
    }
    lines.push("Raise the score above the approval threshold without reopening already accepted behavior.");
  }
  if (issues.length > 0) {
    const displayedIssues = focusedBrowserRepair ? issues.filter((issue) => issue.startsWith("ValidationGate:") || issue.includes("Required vision.md validation") || issue.includes("Validation blocker")) : issues;
    if (displayedIssues.length > 0) {
      lines.push(focusedBrowserRepair ? "Deterministic quality issues relevant to this validation repair:" : "Deterministic quality issues:");
      for (const issue of displayedIssues)
        lines.push(`- ${issue}`);
    }
    const suppressedCount = issues.length - displayedIssues.length;
    if (focusedBrowserRepair && suppressedCount > 0) {
      lines.push(`Suppressed ${suppressedCount} lower-priority ScopeGate/CriticGate note(s) until the browser validation repair passes.`);
    }
  }
  if (validationBlocker) {
    lines.push(`Validation blocker: ${validationBlocker.category} - ${toSingleLine(validationBlocker.detail, 300)}`);
  }
  const failedValidationRuns = validationRuns.filter((run) => !run.ok);
  if (failedValidationRuns.length > 0) {
    lines.push("Validation repair continuity rule: existing content changes from earlier repair attempts are prepared candidate fixes. Preserve them unless the latest failing command proves a specific change is wrong; do not revert them merely to restore the original narrow file count, target paths, or write globs.");
    if (changedPaths.length > 0) {
      lines.push("Prepared candidate paths to preserve during this repair:");
      for (const path of changedPaths.slice(0, 12))
        lines.push(`- ${path}`);
    }
    lines.push("Validation ownership rule: diagnose and run the smallest focused command or failing subcommand needed for this repair. Do not rerun a long aggregate required-validation command inside the executor; PushPals ValidationGate will rerun the authoritative aggregate after the repair turn.");
    lines.push("Validation failure diagnostics:");
    const runsToShow = browserRepairPacket ? failedValidationRuns.filter((run) => run.command === browserRepairPacket.command).slice(0, 1) : failedValidationRuns.slice(0, 5);
    for (const run of runsToShow) {
      lines.push(`- ${run.command} failed with exit ${run.exitCode} after ${run.elapsedMs}ms.`);
      const output = toSingleLine(stripAnsiControlSequences([run.stderr, run.stdout].filter(Boolean).join(`
`)), 700);
      if (output)
        lines.push(`  Output: ${output}`);
    }
  }
  if (critic) {
    const deferCriticForBrowserAssertion = focusedBrowserRepair && browserRepairPacket?.failureKind === "assertion";
    const criticIsSevere = critic.score <= 4 || [...critic.mustFix, ...critic.findings, critic.revisionGuidance].some((entry) => /\b(browser|e2e|validation|web smoke|playwright)\b/i.test(entry));
    if (deferCriticForBrowserAssertion) {
      lines.push(`CriticGate notes deferred while repairing the primary browser assertion failure (score ${critic.score.toFixed(1)} / 10).`);
    } else if (!focusedBrowserRepair || criticIsSevere) {
      lines.push(`Critic score: ${critic.score.toFixed(1)} / 10`);
    }
    if (!deferCriticForBrowserAssertion && (!focusedBrowserRepair || criticIsSevere) && critic.mustFix.length > 0) {
      lines.push("Critic must-fix findings:");
      for (const issue of critic.mustFix)
        lines.push(`- ${issue}`);
    }
    if (!deferCriticForBrowserAssertion && (!focusedBrowserRepair || criticIsSevere) && critic.revisionGuidance) {
      lines.push(`Critic revision guidance: ${critic.revisionGuidance}`);
    }
    if (focusedBrowserRepair && !criticIsSevere && !deferCriticForBrowserAssertion) {
      lines.push(`CriticGate notes deferred while repairing the primary browser validation failure (score ${critic.score.toFixed(1)} / 10).`);
    }
  }
  if (planning.acceptanceCriteria.length > 0) {
    lines.push("Required acceptance criteria:");
    for (const criterion of planning.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  if (planning.validationSteps.length > 0) {
    lines.push("Required validation steps:");
    for (const step of planning.validationSteps)
      lines.push(`- ${step}`);
  }
  if ((planning.requiredValidationSteps ?? []).length > 0) {
    lines.push("Required vision.md testing criteria:");
    for (const step of planning.requiredValidationSteps ?? [])
      lines.push(`- ${step}`);
  }
  lines.push("Apply a minimal corrective patch, run focused validation, then finish.");
  return lines.join(`
`).slice(0, 8000);
}
function inferTargetPathFromInstruction(text) {
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match)
      continue;
    const raw = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!raw)
      continue;
    if (raw.includes("/") || raw.includes("\\") || raw.includes("."))
      return raw;
  }
  return null;
}
function normalizeStagePath(value) {
  if (typeof value !== "string")
    return null;
  let path = value.trim();
  if (!path)
    return null;
  path = path.replace(/\\/g, "/");
  if (path === "/repo" || path === "/workspace")
    return ".";
  if (path.startsWith("/repo/"))
    path = path.slice("/repo/".length);
  else if (path.startsWith("/workspace/"))
    path = path.slice("/workspace/".length);
  else if (path.startsWith("/"))
    return null;
  if (/^[A-Za-z]:[\\/]/.test(path))
    return null;
  path = path.replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
  if (!path || path === ".")
    return ".";
  if (path.startsWith(":("))
    return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".")
      continue;
    if (segment === "..")
      return null;
  }
  return path.length > 0 ? path : null;
}
function toStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => normalizeStagePath(entry)).filter((entry) => Boolean(entry));
}
function normalizeChangedPathForCommit(value) {
  if (typeof value !== "string")
    return null;
  let path = value.trim();
  if (!path)
    return null;
  if (path.startsWith('"') && path.endsWith('"') || path.startsWith("'") && path.endsWith("'")) {
    path = path.slice(1, -1).trim();
  }
  path = path.replace(/\\ /g, " ").replace(/\\/g, "/");
  if (path === "." || path === "/repo" || path === "/workspace")
    return null;
  if (path.startsWith("/repo/"))
    path = path.slice("/repo/".length);
  else if (path.startsWith("/workspace/"))
    path = path.slice("/workspace/".length);
  else if (path.startsWith("/"))
    return null;
  if (/^[A-Za-z]:[\\/]/.test(path))
    return null;
  path = path.replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
  if (!path || path === ".")
    return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".")
      continue;
    if (segment === "..")
      return null;
  }
  return path;
}
function parseChangedPathsFromNameOnlyOutput(output) {
  const seen = new Set;
  const out = [];
  for (const raw of output.split(/\r?\n/)) {
    const path = normalizeChangedPathForCommit(raw);
    if (!path || seen.has(path))
      continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
async function git2(cwd, args) {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { ok: exitCode === 0, stdout: stdout.trimEnd(), stderr: stderr.trim(), exitCode };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), exitCode: null };
  }
}
async function buildCriticDiffText(repo, changedPaths) {
  const paths = Array.from(new Set(changedPaths.map((path) => normalizeChangedPathForCommit(String(path ?? ""))).filter((path) => Boolean(path))));
  if (paths.length === 0)
    return "";
  const chunks = [];
  const trackedDiff = await git2(repo, ["diff", "HEAD", "--", ...paths]);
  if (trackedDiff.stdout) {
    chunks.push(trackedDiff.stdout);
  } else if (!trackedDiff.ok) {
    const [unstagedDiff, stagedDiff] = await Promise.all([
      git2(repo, ["diff", "--", ...paths]),
      git2(repo, ["diff", "--cached", "--", ...paths])
    ]);
    if (unstagedDiff.stdout)
      chunks.push(unstagedDiff.stdout);
    if (stagedDiff.stdout)
      chunks.push(stagedDiff.stdout);
  }
  const untrackedResult = await git2(repo, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
    "--",
    ...paths
  ]);
  if (untrackedResult.ok) {
    const untrackedPaths = untrackedResult.stdout.split("\x00").map((path) => normalizeChangedPathForCommit(path)).filter((path) => Boolean(path));
    for (const path of untrackedPaths) {
      const newFileDiff = await git2(repo, ["diff", "--no-index", "--", "/dev/null", path]);
      if (newFileDiff.stdout)
        chunks.push(newFileDiff.stdout);
    }
  }
  return chunks.join(`
`);
}
async function trackedPathHasGitContentDelta(repo, path) {
  const tracked = await git2(repo, ["ls-files", "--error-unmatch", "--", path]);
  if (!tracked.ok)
    return null;
  const unstaged = await git2(repo, ["diff", "--quiet", "--", path]);
  if (unstaged.exitCode === 1)
    return true;
  if (unstaged.exitCode !== 0)
    return null;
  const staged = await git2(repo, ["diff", "--cached", "--quiet", "--", path]);
  if (staged.exitCode === 1)
    return true;
  if (staged.exitCode !== 0)
    return null;
  return false;
}
async function filterChangedPathsByGitContentDelta(repo, changedPaths) {
  const [trackedResult, unstagedResult, stagedResult] = await Promise.all([
    git2(repo, ["ls-files"]),
    git2(repo, ["diff", "--name-only", "--no-renames"]),
    git2(repo, ["diff", "--cached", "--name-only", "--no-renames"])
  ]);
  const canFilterInBatch = trackedResult.ok && unstagedResult.ok && stagedResult.ok;
  const trackedPaths = new Set(canFilterInBatch ? parseChangedPathsFromNameOnlyOutput(trackedResult.stdout) : []);
  const trackedContentDeltas = new Set(canFilterInBatch ? [
    ...parseChangedPathsFromNameOnlyOutput(unstagedResult.stdout),
    ...parseChangedPathsFromNameOnlyOutput(stagedResult.stdout)
  ] : []);
  const out = [];
  const seen = new Set;
  for (const rawPath of changedPaths) {
    const path = String(rawPath ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (!path || seen.has(path))
      continue;
    seen.add(path);
    const trackedDelta = canFilterInBatch ? trackedPaths.has(path) ? trackedContentDeltas.has(path) : null : await trackedPathHasGitContentDelta(repo, path);
    if (trackedDelta === false)
      continue;
    out.push(path);
  }
  return out;
}
var explicitWorkerCommitIdentityFromEnv = explicitSourceControlCommitIdentityFromEnv;
function buildSandboxArtifactUnstageCommand() {
  return ["reset", "-q", "--", ...SANDBOX_STAGE_ARTIFACT_PATHS];
}
async function unstageSandboxArtifactPaths(repo) {
  return git2(repo, buildSandboxArtifactUnstageCommand());
}
async function resolveGitConfigValue(repo, key) {
  const value = await git2(repo, ["config", "--get", key]);
  return value.ok ? sanitizeSourceControlIdentityField(value.stdout) : "";
}
async function resolveWorkerCommitIdentity(repo, _runtimeConfig = DEFAULT_CONFIG3) {
  const fallbackEmail = await resolveGitConfigValue(repo, "user.email");
  const explicit = explicitWorkerCommitIdentityFromEnv(process.env, fallbackEmail);
  if (explicit)
    return explicit;
  const name = await resolveGitConfigValue(repo, "user.name");
  if (name && fallbackEmail)
    return { name, email: fallbackEmail, source: "source-control-config" };
  return null;
}
function buildGitCommitArgs2(commitMsg, identity) {
  return buildGitCommitArgs(commitMsg, identity);
}
function buildPublishBlockedCommitResult(options) {
  return {
    ok: false,
    branch: options.localRef,
    sha: options.sha,
    error: options.detail,
    publishBlocked: {
      summary: options.summary,
      detail: options.detail,
      publicBranch: options.publicBranch,
      localRef: options.localRef,
      sha: options.sha,
      stage: options.stage
    }
  };
}
async function createJobCommit(repo, workerId, job, runtimeConfig = DEFAULT_CONFIG3) {
  const defaultPublicBranchName = `agent/${workerId}/${job.id}`;
  const reviewAgentHeadRef = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" && !Array.isArray(job.params.reviewAgent) ? job.params.reviewAgent.prHeadRef : undefined;
  const resolvedPublicBranch = resolveReviewFixCompletionBranch(job.params?.completionBranch ?? reviewAgentHeadRef, defaultPublicBranchName);
  const publicBranchName = resolvedPublicBranch.branch;
  const reviewFixContext = extractReviewFixContext(job.params ?? null);
  if (extractMergeConflictReviewContext(job.params ?? null)) {
    return createMergeConflictJobCommit(repo, workerId, job, publicBranchName, runtimeConfig);
  }
  const requirePush = !job.deferPublication && (runtimeConfig.workerpals.requirePush || resolvedPublicBranch.overridden);
  const pushAgentBranch = !job.deferPublication && (requirePush || runtimeConfig.workerpals.pushAgentBranch || resolvedPublicBranch.overridden);
  const hiddenCommitRef = reviewFixContext ? `refs/pushpals/review/${workerId}/${job.id}` : `refs/pushpals/agent/${workerId}/${job.id}`;
  let completionRef = hiddenCommitRef;
  let hiddenRefCreated = false;
  try {
    let result;
    const stageArgs = buildStageCommand(job.kind, job.params);
    if (!stageArgs) {
      return {
        ok: false,
        error: `Unable to determine files to stage for job kind: ${job.kind}`
      };
    }
    result = await git2(repo, stageArgs);
    if (!result.ok) {
      const stageErr = result.stderr || result.stdout;
      if (/pathspec .* did not match any files/i.test(stageErr) || /invalid path/i.test(stageErr) || /outside repository/i.test(stageErr)) {
        console.warn(`[WorkerPals] Stage target invalid/missing for ${job.kind}; retrying with fallback "git add -A".`);
        result = await git2(repo, ["add", "-A"]);
      }
      if (!result.ok) {
        return { ok: false, error: `Failed to stage changes: ${result.stderr || result.stdout}` };
      }
    }
    if (job.kind === "task.execute") {
      const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
      if (!unstageArtifacts.ok) {
        return {
          ok: false,
          error: `Failed to unstage sandbox artifact paths: ${unstageArtifacts.stderr || unstageArtifacts.stdout}`
        };
      }
    }
    result = await git2(repo, ["diff", "--cached", "--quiet"]);
    if (result.ok) {
      console.log(`[WorkerPals] No changes to commit for job ${job.id}`);
      return {
        ok: true,
        branch: hiddenCommitRef,
        publicBranch: publicBranchName,
        sha: "no-changes"
      };
    }
    const cachedDiff = await git2(repo, ["diff", "--cached"]);
    const diff = cachedDiff.ok ? cachedDiff.stdout : "";
    const cachedNameOnly = await git2(repo, ["diff", "--cached", "--name-only"]);
    const changedPaths = cachedNameOnly.ok ? parseChangedPathsFromNameOnlyOutput(cachedNameOnly.stdout) : [];
    const jobPlanning = job.params?.planning;
    const jobValidationSteps = [
      ...toNonEmptyStringArray(job.params?.validationSteps),
      ...toNonEmptyStringArray(job.params?.requiredValidationSteps),
      ...toNonEmptyStringArray(jobPlanning?.validationSteps),
      ...toNonEmptyStringArray(jobPlanning?.requiredValidationSteps),
      ...loadRequiredValidationStepsFromVision(repo)
    ];
    const llmCommitMsg = shouldUseLlmCommitMessageForStagedDiff({ changedPaths, diff }) ? await generateCommitMessageFromDiff(diff, {
      instruction: String(job.params?.instruction ?? ""),
      type: normalizeCommitType(job.kind, job.params),
      area: inferCommitArea(job.kind, job.params, changedPaths),
      validationSteps: jobValidationSteps
    }, repo, runtimeConfig).catch(() => null) : null;
    if (!llmCommitMsg) {
      console.warn(`[WorkerPals] Commit message generator unavailable for job ${job.id}; using deterministic fallback.`);
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);
    const commitIdentity = await resolveWorkerCommitIdentity(repo, runtimeConfig);
    result = await git2(repo, buildGitCommitArgs2(commitMsg, commitIdentity));
    if (!result.ok) {
      return { ok: false, error: `Failed to commit: ${result.stderr}` };
    }
    result = await git2(repo, ["rev-parse", "HEAD"]);
    if (!result.ok) {
      return { ok: false, error: `Failed to get commit SHA: ${result.stderr}` };
    }
    let sha = result.stdout;
    result = await git2(repo, ["update-ref", hiddenCommitRef, sha]);
    if (!result.ok) {
      return { ok: false, error: `Failed to store worker commit ref: ${result.stderr}` };
    }
    hiddenRefCreated = true;
    if (reviewFixContext) {
      console.log(`[WorkerPals] Retained immutable review-fix completion ${hiddenCommitRef} in the shared host repository; SourceControlManager owns publication to ${publicBranchName}.`);
      return { ok: true, branch: hiddenCommitRef, publicBranch: publicBranchName, sha };
    }
    if (pushAgentBranch) {
      const maxPushAttempts = 3;
      let pushed = false;
      let pushError = "";
      for (let attempt = 1;attempt <= maxPushAttempts; attempt++) {
        const sync = await syncHiddenRefWithRemoteBranchByRebase(repo, hiddenCommitRef, publicBranchName, job.id);
        if (!sync.ok) {
          pushError = `Failed to sync branch before push: ${redactSensitiveText(sync.error)}`;
          return buildPublishBlockedCommitResult({
            summary: `Failed to sync and push ${job.kind} commit`,
            detail: pushError,
            publicBranch: publicBranchName,
            localRef: hiddenCommitRef,
            sha,
            stage: "sync"
          });
        }
        sha = sync.sha;
        result = await git2(repo, [
          "push",
          "origin",
          `${hiddenCommitRef}:refs/heads/${publicBranchName}`
        ]);
        if (result.ok) {
          completionRef = publicBranchName;
          pushed = true;
          break;
        }
        pushError = `Failed to push branch: ${redactSensitiveText(result.stderr || result.stdout)}`;
        if (attempt < maxPushAttempts && isNonFastForwardPushOutput(pushError)) {
          console.warn(`[WorkerPals] Push rejected as non-fast-forward for ${publicBranchName}; retrying after git pull --rebase (attempt ${attempt + 1}/${maxPushAttempts}).`);
          continue;
        }
        break;
      }
      if (!pushed) {
        if (requirePush) {
          return buildPublishBlockedCommitResult({
            summary: `Failed to sync and push ${job.kind} commit`,
            detail: pushError || `Failed to push ${publicBranchName}`,
            publicBranch: publicBranchName,
            localRef: hiddenCommitRef,
            sha,
            stage: "push"
          });
        }
        console.warn(`[WorkerPals] ${pushError}. Continuing with local commit ref only (set WORKERPALS_REQUIRE_PUSH=1 to enforce push).`);
        return { ok: true, branch: completionRef, publicBranch: publicBranchName, sha };
      }
    } else {
      console.log(`[WorkerPals] Skipping push for ${publicBranchName} (WORKERPALS_PUSH_AGENT_BRANCH is disabled).`);
    }
    console.log(`[WorkerPals] Created commit ${sha} on ref ${completionRef}`);
    return { ok: true, branch: completionRef, publicBranch: publicBranchName, sha };
  } catch (err) {
    if (hiddenRefCreated) {
      await git2(repo, ["update-ref", "-d", hiddenCommitRef]);
    }
    return { ok: false, error: String(err) };
  }
}
function toPath(value) {
  return normalizeStagePath(value);
}
function dedupePaths(paths) {
  const seen = new Set;
  const out = [];
  for (const path of paths) {
    if (!path || seen.has(path))
      continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
function planningPathHints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [];
  const planning = value;
  const hints = [];
  const scope = planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope) ? planning.scope : null;
  if (scope) {
    hints.push(...toStringArray(scope.writeGlobs));
  }
  const discovery = planning.discovery && typeof planning.discovery === "object" && !Array.isArray(planning.discovery) ? planning.discovery : null;
  if (discovery) {
    hints.push(...toStringArray(discovery.likelyDirs));
  }
  return hints.slice(0, 12);
}
function buildStageTargets(kind, params) {
  const p = params ?? {};
  switch (kind) {
    case "task.execute": {
      const paths = toStringArray(p.paths);
      const planHints = planningPathHints(p.planning);
      const inferred = toPath(inferTargetPathFromInstruction(String(p.instruction ?? "")));
      return dedupePaths([...paths, ...planHints, toPath(p.targetPath), toPath(p.path), inferred]);
    }
    default:
      return [];
  }
}
function buildStageCommand(kind, params) {
  if (kind === "task.execute") {
    return ["add", "-A"];
  }
  const targets = buildStageTargets(kind, params);
  if (targets.length === 0) {
    return null;
  }
  return ["add", "-A", "--", ...targets];
}
function sanitizeCommitValue(value, max = 140) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s)
    return "";
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
function normalizeCommitType(kind, params) {
  const raw = String(params?.commitType ?? params?.changeType ?? params?.type ?? "").trim().toLowerCase();
  const mapped = raw === "bugfix" || raw === "bug" || raw === "fix" ? "fix" : raw === "feature" || raw === "feat" || raw === "new" ? "feat" : raw === "docs" || raw === "doc" ? "docs" : raw === "refactor" ? "refactor" : raw === "chore" ? "chore" : "";
  if (mapped)
    return mapped;
  switch (kind) {
    case "file.patch":
      return "fix";
    case "file.delete":
    case "file.rename":
    case "file.copy":
    case "file.append":
    case "file.mkdir":
      return "refactor";
    default:
      return "feat";
  }
}
function normalizeCommitArea(raw) {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/-+/g, "_").replace(/[^a-z0-9_]/g, "");
  return cleaned || "worker";
}
function normalizeCommitPath(path) {
  return String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}
function inferRepoNativeCommitArea(targets) {
  const normalized = targets.map(normalizeCommitPath).filter((path) => path && path !== ".");
  if (normalized.length === 0)
    return null;
  if (normalized.every(isDocPath))
    return "docs";
  if (normalized.some(isTestPath2) && normalized.every((path) => isTestPath2(path) || isDocPath(path))) {
    return "tests";
  }
  const basis = normalized.find((path) => !isTestPath2(path) && !isDocPath(path)) ?? normalized.find((path) => !isDocPath(path)) ?? normalized[0];
  if (!basis)
    return null;
  if (/^(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(basis)) {
    return "package";
  }
  if (/^(tsconfig|vite\.config|metro\.config|babel\.config|jest\.config|vitest\.config|playwright\.config|eslint\.config|prettier\.config)/i.test(basis)) {
    return "tooling";
  }
  const segments = basis.split("/").filter(Boolean);
  if ((segments[0] === "apps" || segments[0] === "packages") && segments[1]) {
    return normalizeCommitArea(segments[1]);
  }
  const first = segments[0] ?? "";
  if ([
    "app",
    "components",
    "screens",
    "features",
    "src",
    "scripts",
    "utils",
    "hooks",
    "styles",
    "tests"
  ].includes(first)) {
    return normalizeCommitArea(first);
  }
  return first ? normalizeCommitArea(first) : null;
}
function inferCommitArea(kind, params, changedPaths = []) {
  const explicit = String(params?.area ?? params?.scope ?? params?.component ?? "").trim();
  if (explicit)
    return normalizeCommitArea(explicit);
  const targets = changedPaths.length > 0 ? changedPaths : buildStageTargets(kind, params).filter((p) => p !== ".");
  const pick = (prefix) => targets.some((path) => path.toLowerCase().startsWith(prefix.toLowerCase()));
  if (pick("scripts/start.ts") || pick(".env") || pick(".env.example"))
    return "startup";
  if (pick("apps/remotebuddy/"))
    return "remote_agent";
  if (pick("apps/localbuddy/"))
    return "local_agent";
  if (pick("apps/workerpals/"))
    return "worker";
  if (pick("apps/source_control_manager/"))
    return "source_control_manager";
  if (pick("apps/client/"))
    return "client";
  if (pick("apps/server/"))
    return "server";
  if (pick("README.md") || pick("docs/"))
    return "docs";
  return inferRepoNativeCommitArea(targets) ?? "repo";
}
function summarizeScope(kind, params, changedPaths = []) {
  const targets = changedPaths.length > 0 ? changedPaths : buildStageTargets(kind, params).filter((p) => p !== ".");
  if (targets.length === 0)
    return "repository-level changes";
  const visible = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `${visible}, +${targets.length - 3} more` : visible;
}
function isDocPath(path) {
  const lower = normalizeCommitPath(path);
  return lower.startsWith("docs/") || lower.startsWith("wiki/") || lower === "readme.md" || lower.endsWith(".md") || lower.endsWith(".mdx");
}
function isTestPath2(path) {
  const normalized = normalizeCommitPath(path);
  if (/(^|\/)(?:__tests__|tests?|e2e|smoke|specs?)(?:\/|$)/i.test(normalized)) {
    return true;
  }
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized))
    return true;
  const base = normalized.split("/").pop() ?? normalized;
  return /(?:^|[-_.])(?:test|spec|e2e|smoke|coverage)(?:[-_.]|$)/i.test(base);
}
function humanizeCommitArea(area) {
  switch (area) {
    case "local_agent":
      return "localbuddy";
    case "remote_agent":
      return "remotebuddy";
    case "source_control_manager":
      return "source control manager";
    case "tests":
      return "test";
    default:
      return area.replace(/_/g, " ");
  }
}
function deriveSummary(action, params, changedPaths = [], areaHint = "worker") {
  const explicit = sanitizeCommitValue(params?.commitSummary, 72);
  if (explicit)
    return explicit;
  if (changedPaths.length > 0) {
    const label = humanizeCommitArea(areaHint);
    const testCount = changedPaths.filter(isTestPath2).length;
    const docCount = changedPaths.filter(isDocPath).length;
    const codeCount = changedPaths.length - testCount - docCount;
    if (testCount > 0 && codeCount === 0 && docCount === 0) {
      const coverageLabel = label === "test" ? "test" : `${label} test`;
      return sanitizeCommitValue(`expand ${coverageLabel} coverage`, 72);
    }
    if (docCount > 0 && codeCount === 0 && testCount === 0) {
      return sanitizeCommitValue(`update ${label} documentation`, 72);
    }
    if (testCount > 0 && codeCount > 0) {
      return sanitizeCommitValue(`update ${label} implementation and test coverage`, 72);
    }
    if (codeCount > 0) {
      return sanitizeCommitValue(`update ${label} implementation`, 72);
    }
  }
  const raw = sanitizeCommitValue(action, 72);
  if (!raw)
    return "apply requested repository update";
  return raw;
}
function isBoilerplateCriterion(criterion) {
  return /produce a correct and helpful result|complete the requested task|accomplish the (?:stated )?goal|provide a (?:correct|good|helpful) (?:solution|result|answer)|the task (?:is|should be) completed|successfully complete(?:d)? the task/i.test(criterion);
}
function buildChangedPathImplementationPoints(changedPaths) {
  if (changedPaths.length === 0)
    return "";
  const lines = [];
  for (const path of changedPaths.slice(0, 6)) {
    if (isTestPath2(path)) {
      lines.push(`- add or update tests in ${sanitizeCommitValue(path, 220)}`);
    } else if (isDocPath(path)) {
      lines.push(`- update documentation in ${sanitizeCommitValue(path, 220)}`);
    } else {
      lines.push(`- update ${sanitizeCommitValue(path, 220)}`);
    }
  }
  if (changedPaths.length > 6) {
    lines.push(`- update +${changedPaths.length - 6} additional file(s)`);
  }
  return lines.join(`
`);
}
function buildImplementationPoints(kind, params, changedPaths = []) {
  const explicitPoints = toNonEmptyStringArray(params?.commitPoints ?? params?.changeDetails ?? params?.implementationPoints);
  if (explicitPoints.length > 0) {
    return explicitPoints.slice(0, 8).map((point) => `- ${sanitizeCommitValue(point, 220)}`).join(`
`);
  }
  const planning = params && typeof params.planning === "object" && !Array.isArray(params.planning) ? params.planning : undefined;
  const criteria = toNonEmptyStringArray(planning?.acceptanceCriteria ?? planning?.acceptance_criteria).filter((criterion) => !isBoilerplateCriterion(criterion));
  if (criteria.length > 0) {
    return criteria.slice(0, 6).map((criterion) => `- ${sanitizeCommitValue(criterion, 220)}`).join(`
`);
  }
  const fromChangedPaths = buildChangedPathImplementationPoints(changedPaths);
  if (fromChangedPaths)
    return fromChangedPaths;
  const targets = buildStageTargets(kind, params).filter((target) => target !== ".");
  if (targets.length === 0)
    return "";
  const lines = [];
  for (const target of targets.slice(0, 5)) {
    lines.push(`- update ${sanitizeCommitValue(target, 220)}`);
  }
  if (targets.length > 5) {
    lines.push(`- update +${targets.length - 5} additional file(s)`);
  }
  return lines.join(`
`);
}
function parseBooleanFlag(value) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return value !== 0;
  if (typeof value !== "string")
    return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function toNonEmptyStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => sanitizeCommitValue(entry, 240)).filter((entry) => entry.length > 0);
}
function isTestLikeValidationStep(step) {
  const classify = (candidate) => {
    const argv = tokenizeValidationCommandArgv(candidate);
    if (!argv || argv.length === 0)
      return false;
    const tool = argv[0].toLowerCase();
    const hasToken = (token) => argv.some((entry) => entry.toLowerCase() === token);
    switch (tool) {
      case "bun":
      case "bunx":
      case "npm":
      case "npx":
      case "pnpm":
      case "yarn": {
        if (hasToken("test"))
          return true;
        if (["bunx", "npx"].includes(tool)) {
          const runner = argv[1]?.toLowerCase() ?? "";
          if (runner === "vitest" || runner === "jest" || runner === "playwright")
            return true;
        }
        const sub = argv[1]?.toLowerCase() ?? "";
        if (sub === "run" && argv[2]?.toLowerCase().startsWith("test"))
          return true;
        if (sub.startsWith("test"))
          return true;
        if (tool === "bun") {
          return argv.slice(1).some((arg) => /(?:^|[/\\])tests?[/\\]|\.test\.[a-z]+$|\.spec\.[a-z]+$/i.test(arg));
        }
        return false;
      }
      case "pytest":
      case "vitest":
      case "jest":
        return true;
      case "python":
      case "python3":
        return argv.length >= 3 && argv[1].toLowerCase() === "-m" && argv[2].toLowerCase() === "pytest";
      case "go":
      case "cargo":
      case "make":
        return hasToken("test");
      case "coverage":
        return hasToken("pytest");
      default:
        return false;
    }
  };
  if (classify(step))
    return true;
  const fenced = step.match(/`([^`]+)`/)?.[1]?.trim() ?? "";
  return fenced ? classify(fenced) : false;
}
function buildCommitTestsBlock(params) {
  const planning = params && typeof params.planning === "object" && !Array.isArray(params.planning) ? params.planning : undefined;
  const candidates = [
    ...toNonEmptyStringArray(params?.validationSteps),
    ...toNonEmptyStringArray(params?.requiredValidationSteps),
    ...toNonEmptyStringArray(params?.validation_steps),
    ...toNonEmptyStringArray(params?.required_validation_steps),
    ...toNonEmptyStringArray(planning?.validationSteps),
    ...toNonEmptyStringArray(planning?.requiredValidationSteps),
    ...toNonEmptyStringArray(planning?.validation_steps),
    ...toNonEmptyStringArray(planning?.required_validation_steps)
  ];
  const seen = new Set;
  const unique = candidates.filter((entry) => {
    if (seen.has(entry))
      return false;
    seen.add(entry);
    return true;
  }).filter(isTestLikeValidationStep);
  if (unique.length === 0)
    return "- not run (no test commands provided)";
  return unique.map((entry) => `- ${entry}`).join(`
`);
}
function shouldIncludeCommitMeta(params) {
  return parseBooleanFlag(params?.commitIncludeMeta) || parseBooleanFlag(params?.includeCommitMeta) || parseBooleanFlag(params?.commit_meta);
}
function buildCommitMetaBlock(kind, params, replacements, changedPaths = []) {
  const lines = [
    "Meta:",
    `- scope: ${sanitizeCommitValue(summarizeScope(kind, params, changedPaths), 220)}`,
    `- job kind: ${sanitizeCommitValue(kind, 64)}`,
    `- traceability: worker ${replacements.worker_id}, task ${replacements.task_id}, job ${replacements.job_id}`,
    `- execution context: ${replacements.context}`
  ];
  if (replacements.session_line)
    lines.push(replacements.session_line);
  return `

${lines.join(`
`)}`;
}
function summarizeJobAction(kind, params) {
  const p = params ?? {};
  const get = (key) => sanitizeCommitValue(p[key]);
  switch (kind) {
    case "file.write":
      return `write ${get("path") || "<path>"}`;
    case "file.patch":
      return `patch ${get("path") || "<path>"}`;
    case "file.append":
      return `append ${get("path") || "<path>"}`;
    case "file.rename":
      return `rename ${get("from") || "<from>"} -> ${get("to") || "<to>"}`;
    case "file.copy":
      return `copy ${get("from") || "<from>"} -> ${get("to") || "<to>"}`;
    case "file.delete":
      return `delete ${get("path") || "<path>"}`;
    case "file.mkdir":
      return `mkdir ${get("path") || "<path>"}`;
    case "shell.exec":
      return `exec ${get("command") || "<command>"}`;
    case "bun.test":
      return get("filter") ? `test filter=${get("filter")}` : "run bun test";
    case "bun.lint":
      return "run bun lint";
    case "web.fetch":
      return `fetch ${get("url") || "<url>"}`;
    case "web.search":
      return `search ${get("query") || "<query>"}`;
    case "task.execute":
      return `execute ${get("targetPath") || get("path") || inferTargetPathFromInstruction(get("instruction")) || "task"}`;
    default:
      return kind;
  }
}
function combinedGitOutput(result) {
  return [result.stderr, result.stdout].filter(Boolean).join(`
`).trim();
}
function isNonFastForwardPushOutput(text) {
  const normalized = text.toLowerCase();
  return normalized.includes("non-fast-forward") || normalized.includes("fetch first") || normalized.includes("failed to push some refs") || normalized.includes("updates were rejected because") || normalized.includes("tip is behind its remote counterpart");
}
function isRebaseConflictOutput(text) {
  const normalized = text.toLowerCase();
  return normalized.includes("conflict") || normalized.includes("resolve all conflicts manually") || normalized.includes("could not apply") || normalized.includes("fix conflicts and then run");
}
function isRebaseEditorPromptOutput(text) {
  const normalized = text.toLowerCase();
  return normalized.includes("terminal is dumb, but editor unset") || normalized.includes("please supply the message using either -m or -f option") || normalized.includes("waiting for your editor to close the file");
}
function isPullRebaseDirtyWorkingTreeOutput(text) {
  const normalized = text.toLowerCase();
  return normalized.includes("cannot pull with rebase: you have unstaged changes") || normalized.includes("cannot rebase: you have unstaged changes") || normalized.includes("please commit or stash them") || normalized.includes("your local changes to the following files would be overwritten by merge") || normalized.includes("please commit your changes or stash them before you merge") || normalized.includes("untracked working tree files would be overwritten by merge");
}
async function currentRefSha(repo, ref) {
  const result = await git2(repo, ["rev-parse", ref]);
  if (!result.ok)
    return null;
  return result.stdout.trim() || null;
}
async function gitDirPath(repo) {
  const result = await git2(repo, ["rev-parse", "--git-dir"]);
  if (!result.ok)
    return null;
  const gitDir = result.stdout.trim();
  if (!gitDir)
    return null;
  return resolve10(repo, gitDir);
}
async function activeGitOperation(repo) {
  const gitDir = await gitDirPath(repo);
  if (!gitDir)
    return null;
  if (existsSync8(resolve10(gitDir, "rebase-merge")) || existsSync8(resolve10(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync8(resolve10(gitDir, "MERGE_HEAD")))
    return "merge";
  if (existsSync8(resolve10(gitDir, "CHERRY_PICK_HEAD")))
    return "cherry-pick";
  return null;
}
async function resumePreparedMergeConflictRebase(repo, kind, params, onLog) {
  const sequencer = await activeGitOperation(repo);
  if (sequencer !== "rebase") {
    return { ok: true, resumed: false, sequencer };
  }
  const unresolved = await git2(repo, ["diff", "--name-only", "--diff-filter=U"]);
  if (!unresolved.ok) {
    return {
      ok: false,
      error: `Failed to inspect unresolved merge-conflict paths: ${combinedGitOutput(unresolved)}`
    };
  }
  const unresolvedPaths = parseChangedPathsFromNameOnlyOutput(unresolved.stdout);
  if (unresolvedPaths.length > 0) {
    const stillMarked = unresolvedPaths.filter((relativePath) => {
      try {
        const contents = readFileSync8(resolve10(repo, relativePath), "utf8");
        return /^(<{7}|={7}|>{7})( .*)?$/m.test(contents);
      } catch {
        return true;
      }
    });
    if (stillMarked.length > 0) {
      return {
        ok: true,
        resumed: false,
        sequencer,
        detail: `rebase still has ${stillMarked.length} unresolved conflict marker file(s)`
      };
    }
    onLog?.("stdout", `[MergeConflict] Found ${unresolvedPaths.length} resolved-but-unstaged conflict file(s); staging them before continuing the rebase.`);
  }
  let stageResult;
  const stageArgs = buildStageCommand(kind, params);
  if (stageArgs) {
    stageResult = await git2(repo, stageArgs);
    if (!stageResult.ok) {
      const stageErr = stageResult.stderr || stageResult.stdout;
      if (/pathspec .* did not match any files/i.test(stageErr) || /invalid path/i.test(stageErr) || /outside repository/i.test(stageErr)) {
        onLog?.("stdout", `[MergeConflict] Stage target invalid/missing for ${kind}; retrying with fallback "git add -A".`);
        stageResult = await git2(repo, ["add", "-A"]);
      }
    }
  } else {
    stageResult = await git2(repo, ["add", "-A"]);
  }
  if (!stageResult.ok) {
    return {
      ok: false,
      error: "Failed to stage resolved merge-conflict changes before continuing rebase: " + combinedGitOutput(stageResult)
    };
  }
  const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
  if (!unstageArtifacts.ok) {
    return {
      ok: false,
      error: "Failed to unstage sandbox artifact paths before continuing rebase: " + combinedGitOutput(unstageArtifacts)
    };
  }
  const maxContinuationPasses = Math.max(1, MAX_MERGE_CONFLICT_RESOLUTION_PASSES);
  let lastContinueOutput = "";
  for (let pass = 1;pass <= maxContinuationPasses; pass += 1) {
    let rebaseContinue = await git2(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    let continueOutput = combinedGitOutput(rebaseContinue);
    if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
      rebaseContinue = await git2(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      continueOutput = combinedGitOutput(rebaseContinue);
    }
    lastContinueOutput = continueOutput;
    if (!rebaseContinue.ok) {
      if (/no rebase in progress/i.test(continueOutput)) {
        onLog?.("stdout", "[MergeConflict] Prepared rebase was already complete after continuation.");
        return { ok: true, resumed: true, sequencer: null };
      }
      if (/no changes - did you forget to use 'git add'|nothing to commit/i.test(continueOutput)) {
        const rebaseSkip = await git2(repo, ["rebase", "--skip"]);
        const skipOutput = combinedGitOutput(rebaseSkip);
        lastContinueOutput = skipOutput || continueOutput;
        if (!rebaseSkip.ok && !isRebaseConflictOutput(skipOutput)) {
          return {
            ok: false,
            error: `Failed to skip empty prepared merge-conflict rebase commit: ${skipOutput}`
          };
        }
      } else {
        const continuingSequencer = await activeGitOperation(repo);
        if (continuingSequencer === "rebase") {
          const nextUnresolved2 = await git2(repo, ["diff", "--name-only", "--diff-filter=U"]);
          if (nextUnresolved2.ok) {
            const nextPaths = parseChangedPathsFromNameOnlyOutput(nextUnresolved2.stdout);
            if (nextPaths.length > 0) {
              onLog?.("stdout", `[MergeConflict] Rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s); rerunning the resolver on updated sandbox state.`);
              return {
                ok: true,
                resumed: true,
                sequencer: "rebase",
                detail: `rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s)`,
                advancedToNextConflict: true
              };
            }
          }
        }
        return {
          ok: false,
          error: `Failed to continue prepared merge-conflict rebase: ${continueOutput}`
        };
      }
    }
    const remainingSequencer = await activeGitOperation(repo);
    if (!remainingSequencer) {
      onLog?.("stdout", "[MergeConflict] Auto-continued the prepared rebase after the executor returned with no unresolved conflicts.");
      return { ok: true, resumed: true, sequencer: null };
    }
    if (remainingSequencer !== "rebase") {
      return { ok: true, resumed: true, sequencer: remainingSequencer };
    }
    const nextUnresolved = await git2(repo, ["diff", "--name-only", "--diff-filter=U"]);
    if (nextUnresolved.ok) {
      const nextPaths = parseChangedPathsFromNameOnlyOutput(nextUnresolved.stdout);
      if (nextPaths.length > 0) {
        onLog?.("stdout", `[MergeConflict] Rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s); rerunning the resolver on updated sandbox state.`);
        return {
          ok: true,
          resumed: true,
          sequencer: "rebase",
          detail: `rebase advanced into another conflicted commit with ${nextPaths.length} unresolved file(s)`,
          advancedToNextConflict: true
        };
      }
    }
    onLog?.("stdout", `[MergeConflict] Rebase still active after continuation pass ${pass}/${maxContinuationPasses}; trying another non-interactive continue.`);
  }
  return {
    ok: false,
    error: `Prepared merge-conflict rebase remained active after ${maxContinuationPasses} continuation pass(es).` + (lastContinueOutput ? ` Last output: ${lastContinueOutput}` : "")
  };
}
async function isAncestorRef(repo, ancestor, descendant) {
  const result = await git2(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.ok;
}
async function refreshMergeConflictTrackingRefs(repo, publicBranchName, baseBranchName) {
  const refspecs = [
    `+refs/heads/${publicBranchName}:refs/remotes/origin/${publicBranchName}`,
    `+refs/heads/${baseBranchName}:refs/remotes/origin/${baseBranchName}`
  ];
  const fetch2 = await git2(repo, ["fetch", "--quiet", "origin", ...new Set(refspecs)]);
  if (!fetch2.ok) {
    return {
      ok: false,
      error: `Failed to refresh merge-conflict refs for ${publicBranchName}: ${redactSensitiveText(fetch2.stderr || fetch2.stdout)}`
    };
  }
  return { ok: true };
}
async function createMergeConflictJobCommit(repo, workerId, job, publicBranchName, runtimeConfig) {
  const mergeConflictContext = extractMergeConflictReviewContext(job.params ?? null);
  if (!mergeConflictContext) {
    return { ok: false, error: "Merge-conflict context is missing required branch metadata." };
  }
  const sequencer = await activeGitOperation(repo);
  if (sequencer) {
    return {
      ok: false,
      error: `Merge-conflict job ${job.id} left a git ${sequencer} in progress. Finish the ${sequencer} before returning control to WorkerPals.`
    };
  }
  const refreshed = await refreshMergeConflictTrackingRefs(repo, publicBranchName, mergeConflictContext.baseBranch);
  if (!refreshed.ok)
    return refreshed;
  const remoteHeadSha = await currentRefSha(repo, `refs/remotes/origin/${publicBranchName}`);
  if (mergeConflictContext.expectedHeadSha && remoteHeadSha !== mergeConflictContext.expectedHeadSha) {
    return {
      ok: false,
      error: `origin/${publicBranchName} moved from expected ${mergeConflictContext.expectedHeadSha.slice(0, 8)} to ${remoteHeadSha?.slice(0, 8) || "unknown"} while the job was running. Requeue on the newer branch head instead of overwriting it.`
    };
  }
  const remoteBaseSha = await currentRefSha(repo, `refs/remotes/origin/${mergeConflictContext.baseBranch}`);
  if (mergeConflictContext.expectedBaseSha && remoteBaseSha !== mergeConflictContext.expectedBaseSha) {
    return {
      ok: false,
      error: `origin/${mergeConflictContext.baseBranch} moved from expected ${mergeConflictContext.expectedBaseSha.slice(0, 8)} to ${remoteBaseSha?.slice(0, 8) || "unknown"} while the job was running. Requeue against the newer base instead of publishing a stale rebase.`
    };
  }
  let result;
  const stageArgs = buildStageCommand(job.kind, job.params);
  if (!stageArgs) {
    return {
      ok: false,
      error: `Unable to determine files to stage for merge-conflict job kind: ${job.kind}`
    };
  }
  result = await git2(repo, stageArgs);
  if (!result.ok) {
    const stageErr = result.stderr || result.stdout;
    if (/pathspec .* did not match any files/i.test(stageErr) || /invalid path/i.test(stageErr) || /outside repository/i.test(stageErr)) {
      console.warn(`[WorkerPals] Stage target invalid/missing for merge-conflict job ${job.id}; retrying with fallback "git add -A".`);
      result = await git2(repo, ["add", "-A"]);
    }
    if (!result.ok) {
      return {
        ok: false,
        error: `Failed to stage merge-conflict changes: ${result.stderr || result.stdout}`
      };
    }
  }
  const unstageArtifacts = await unstageSandboxArtifactPaths(repo);
  if (!unstageArtifacts.ok) {
    return {
      ok: false,
      error: `Failed to unstage sandbox artifact paths: ${unstageArtifacts.stderr || unstageArtifacts.stdout}`
    };
  }
  const cachedDiffQuiet = await git2(repo, ["diff", "--cached", "--quiet"]);
  let headSha = await currentRefSha(repo, "HEAD");
  if (!headSha) {
    return { ok: false, error: `Failed to resolve HEAD SHA for merge-conflict job ${job.id}.` };
  }
  if (!cachedDiffQuiet.ok) {
    const cachedDiff = await git2(repo, ["diff", "--cached"]);
    const diff = cachedDiff.ok ? cachedDiff.stdout : "";
    const cachedNameOnly = await git2(repo, ["diff", "--cached", "--name-only"]);
    const changedPaths = cachedNameOnly.ok ? parseChangedPathsFromNameOnlyOutput(cachedNameOnly.stdout) : [];
    const jobPlanning = job.params?.planning;
    const jobValidationSteps = [
      ...toNonEmptyStringArray(job.params?.validationSteps),
      ...toNonEmptyStringArray(job.params?.requiredValidationSteps),
      ...toNonEmptyStringArray(jobPlanning?.validationSteps),
      ...toNonEmptyStringArray(jobPlanning?.requiredValidationSteps),
      ...loadRequiredValidationStepsFromVision(repo)
    ];
    const llmCommitMsg = shouldUseLlmCommitMessageForStagedDiff({ changedPaths, diff }) ? await generateCommitMessageFromDiff(diff, {
      instruction: String(job.params?.instruction ?? ""),
      type: normalizeCommitType(job.kind, job.params),
      area: inferCommitArea(job.kind, job.params, changedPaths),
      validationSteps: jobValidationSteps
    }, repo, runtimeConfig).catch(() => null) : null;
    if (!llmCommitMsg) {
      console.warn(`[WorkerPals] Commit message generator unavailable for merge-conflict job ${job.id}; using deterministic fallback.`);
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);
    const commitIdentity = await resolveWorkerCommitIdentity(repo, runtimeConfig);
    const commit = await git2(repo, buildGitCommitArgs2(commitMsg, commitIdentity));
    if (!commit.ok) {
      return { ok: false, error: `Failed to commit merge-conflict resolution: ${commit.stderr}` };
    }
    headSha = await currentRefSha(repo, "HEAD");
    if (!headSha) {
      return {
        ok: false,
        error: `Failed to resolve committed HEAD SHA for merge-conflict job ${job.id}.`
      };
    }
  }
  const baseRemoteRef = `refs/remotes/origin/${mergeConflictContext.baseBranch}`;
  const rebasedOntoBase = await isAncestorRef(repo, baseRemoteRef, "HEAD");
  if (!rebasedOntoBase) {
    return {
      ok: false,
      error: `Merge-conflict job ${job.id} did not finish rebased onto origin/${mergeConflictContext.baseBranch}. Detached host worktree HEAD must be a descendant of ${baseRemoteRef} before WorkerPals can hand it to SourceControlManager.`
    };
  }
  const hiddenCompletionRef = `refs/pushpals/review/${workerId}/${job.id}`;
  const retain = await git2(repo, ["update-ref", hiddenCompletionRef, headSha]);
  if (!retain.ok) {
    return {
      ok: false,
      error: `Failed to retain rebased merge-conflict commit for SourceControlManager: ${combinedGitOutput(retain)}`
    };
  }
  return {
    ok: true,
    branch: hiddenCompletionRef,
    publicBranch: publicBranchName,
    sha: headSha
  };
}
async function autoResolveRebaseConflicts(repo, maxPasses = 8) {
  for (let pass = 1;pass <= maxPasses; pass++) {
    const unresolved = await git2(repo, ["diff", "--name-only", "--diff-filter=U"]);
    if (!unresolved.ok) {
      return {
        ok: false,
        error: `Failed to inspect rebase conflicts: ${combinedGitOutput(unresolved)}`
      };
    }
    const unresolvedPaths = parseChangedPathsFromNameOnlyOutput(unresolved.stdout);
    if (unresolvedPaths.length > 0) {
      console.warn(`[WorkerPals] Rebase conflict detected (${unresolvedPaths.length} file(s)); auto-resolving in favor of worker changes (pass ${pass}/${maxPasses}).`);
      for (const path of unresolvedPaths) {
        let checkout = await git2(repo, ["checkout", "--theirs", "--", path]);
        if (!checkout.ok) {
          checkout = await git2(repo, ["checkout", "--ours", "--", path]);
          if (!checkout.ok) {
            const rm = await git2(repo, ["rm", "--force", "--", path]);
            if (!rm.ok) {
              return {
                ok: false,
                error: `Failed to resolve rebase conflict for ${path}: ${combinedGitOutput(checkout)}`
              };
            }
          }
        }
      }
      const addAll = await git2(repo, ["add", "-A", "--", ...unresolvedPaths]);
      if (!addAll.ok) {
        return {
          ok: false,
          error: `Failed to stage resolved rebase conflicts: ${combinedGitOutput(addAll)}`
        };
      }
    }
    let rebaseContinue = await git2(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    let continueOutput = combinedGitOutput(rebaseContinue);
    if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
      rebaseContinue = await git2(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      continueOutput = combinedGitOutput(rebaseContinue);
    }
    if (rebaseContinue.ok) {
      continue;
    }
    if (/no rebase in progress/i.test(continueOutput)) {
      return { ok: true };
    }
    if (/no changes - did you forget to use 'git add'|nothing to commit/i.test(continueOutput)) {
      const rebaseSkip = await git2(repo, ["rebase", "--skip"]);
      if (rebaseSkip.ok) {
        continue;
      }
      const skipOutput = combinedGitOutput(rebaseSkip);
      if (isRebaseConflictOutput(skipOutput)) {
        continue;
      }
      return { ok: false, error: `Failed to skip empty rebase commit: ${skipOutput}` };
    }
    if (isRebaseConflictOutput(continueOutput)) {
      continue;
    }
    return { ok: false, error: `Failed to continue rebase: ${continueOutput}` };
  }
  return {
    ok: false,
    error: `Rebase conflict auto-resolution exceeded ${maxPasses} passes; manual intervention required.`
  };
}
async function syncHiddenRefWithRemoteBranchByRebase(repo, hiddenCommitRef, publicBranchName, jobId) {
  const resetPublicationResidueInDisposableWorktree = async (reason) => {
    const gitDir = await git2(repo, ["rev-parse", "--git-dir"]);
    const commonDir = await git2(repo, ["rev-parse", "--git-common-dir"]);
    if (!gitDir.ok || !commonDir.ok) {
      return {
        ok: false,
        error: `Refusing to reset publication checkout because its Git directory layout could not be verified: ${combinedGitOutput(!gitDir.ok ? gitDir : commonDir)}`
      };
    }
    const resolvedGitDir = resolve10(repo, gitDir.stdout.trim());
    const resolvedCommonDir = resolve10(repo, commonDir.stdout.trim());
    const normalizePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    if (normalizePath(resolvedGitDir) === normalizePath(resolvedCommonDir)) {
      return {
        ok: false,
        error: "Refusing to reset a dirty publication checkout that is not a disposable linked worktree."
      };
    }
    console.warn(`[WorkerPals] Resetting tracked and untracked residue in disposable publication worktree before ${reason}.`);
    const reset = await git2(repo, ["reset", "--hard", "HEAD"]);
    if (!reset.ok) {
      return {
        ok: false,
        error: `Failed to reset disposable publication worktree: ${combinedGitOutput(reset)}`
      };
    }
    const clean = await git2(repo, ["clean", "-fd"]);
    if (!clean.ok) {
      return {
        ok: false,
        error: `Failed to clean disposable publication worktree: ${combinedGitOutput(clean)}`
      };
    }
    const status = await git2(repo, ["status", "--porcelain"]);
    if (!status.ok) {
      return {
        ok: false,
        error: `Failed to verify publication worktree after reset: ${combinedGitOutput(status)}`
      };
    }
    const residue = status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (residue.length > 0) {
      return {
        ok: false,
        error: "Changes remain in disposable publication worktree after reset and clean: " + residue.slice(0, 10).join(", ")
      };
    }
    return { ok: true };
  };
  const verifyCleanTrackedStateBeforeRebase = async () => {
    const status = await git2(repo, ["status", "--porcelain"]);
    if (!status.ok) {
      return {
        ok: false,
        error: `Failed to inspect publication worktree before rebase: ${combinedGitOutput(status)}`
      };
    }
    const trackedResidue = status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith("?? "));
    if (trackedResidue.length === 0)
      return { ok: true };
    return resetPublicationResidueInDisposableWorktree("git pull --rebase");
  };
  const scrubKnownPreSyncArtifacts = async () => {
    const codexPath = resolve10(repo, ".codex");
    if (!existsSync8(codexPath))
      return { ok: true };
    const trackedCodex = await git2(repo, ["ls-files", "--error-unmatch", "--", ".codex"]);
    if (trackedCodex.ok) {
      const restoreTrackedCodex = await git2(repo, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        ".codex"
      ]);
      if (!restoreTrackedCodex.ok) {
        return {
          ok: false,
          error: `Tracked .codex path blocks branch sync and could not be restored to HEAD: ${combinedGitOutput(restoreTrackedCodex)}`
        };
      }
      const trackedCodexStatus = await git2(repo, ["status", "--porcelain", "--", ".codex"]);
      if (!trackedCodexStatus.ok) {
        return {
          ok: false,
          error: `Tracked .codex path blocks branch sync and its status could not be verified: ${combinedGitOutput(trackedCodexStatus)}`
        };
      }
      if (trackedCodexStatus.stdout.trim().length > 0) {
        return {
          ok: false,
          error: "Tracked .codex path blocks branch sync because local changes remain after restore. Move Codex state outside the repo worktree before retrying."
        };
      }
      console.warn("[WorkerPals] Preserved tracked .codex sentinel before branch sync.");
      return { ok: true };
    }
    try {
      rmSync3(codexPath, { recursive: true, force: true });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to scrub transient .codex artifact before branch sync: ${String(error)}`
      };
    }
    if (existsSync8(codexPath)) {
      return {
        ok: false,
        error: "Failed to scrub transient .codex artifact before branch sync: path still exists."
      };
    }
    console.warn("[WorkerPals] Removed transient .codex artifact before branch sync.");
    return { ok: true };
  };
  const pullRebaseNonInteractive = () => git2(repo, [
    "-c",
    "core.editor=true",
    "-c",
    "rebase.autoStash=true",
    "pull",
    "--rebase",
    "origin",
    publicBranchName
  ]);
  const remoteHead = await git2(repo, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${publicBranchName}`
  ]);
  if (!remoteHead.ok) {
    return {
      ok: false,
      error: `Failed to inspect remote branch ${publicBranchName}: ${combinedGitOutput(remoteHead)}`
    };
  }
  const remoteExists = remoteHead.stdout.trim().length > 0;
  if (!remoteExists) {
    const sha = await currentRefSha(repo, hiddenCommitRef);
    if (!sha)
      return { ok: false, error: `Failed to resolve commit SHA for ${hiddenCommitRef}.` };
    return { ok: true, sha };
  }
  const tempBranch = `_pushpals/rebase-${jobId.slice(0, 8)}-${Date.now().toString(36)}`;
  let branchCheckedOut = false;
  try {
    const checkout = await git2(repo, ["checkout", "-B", tempBranch, hiddenCommitRef]);
    if (!checkout.ok) {
      return {
        ok: false,
        error: `Failed to prepare temporary rebase branch ${tempBranch}: ${combinedGitOutput(checkout)}`
      };
    }
    branchCheckedOut = true;
    const maxPullRebaseAttempts = 5;
    let syncedWithRemote = false;
    for (let attempt = 1;attempt <= maxPullRebaseAttempts; attempt++) {
      const preSyncGuard = await scrubKnownPreSyncArtifacts();
      if (!preSyncGuard.ok) {
        return { ok: false, error: preSyncGuard.error };
      }
      const cleanBeforeRebase = await verifyCleanTrackedStateBeforeRebase();
      if (!cleanBeforeRebase.ok) {
        return { ok: false, error: cleanBeforeRebase.error };
      }
      let pullRebase = await pullRebaseNonInteractive();
      if (!pullRebase.ok && isPullRebaseDirtyWorkingTreeOutput(combinedGitOutput(pullRebase))) {
        const reset = await resetPublicationResidueInDisposableWorktree("retrying git pull --rebase after a dirty-tree rejection");
        if (!reset.ok)
          return { ok: false, error: reset.error };
        pullRebase = await pullRebaseNonInteractive();
      }
      if (pullRebase.ok) {
        syncedWithRemote = true;
        break;
      }
      const pullOutput = combinedGitOutput(pullRebase);
      if (!isRebaseConflictOutput(pullOutput)) {
        return {
          ok: false,
          error: `git pull --rebase failed for ${publicBranchName}: ${pullOutput}`
        };
      }
      const resolved = await autoResolveRebaseConflicts(repo);
      if (!resolved.ok) {
        const unresolved = await git2(repo, ["diff", "--name-only", "--diff-filter=U"]);
        const unresolvedPaths = unresolved.ok ? parseChangedPathsFromNameOnlyOutput(unresolved.stdout).join(", ") : "";
        await git2(repo, ["rebase", "--abort"]);
        return {
          ok: false,
          error: `Rebase conflict resolution failed for ${publicBranchName}: ${resolved.error}${unresolvedPaths ? ` | unresolved=${unresolvedPaths}` : ""}`
        };
      }
      if (attempt < maxPullRebaseAttempts) {
        console.warn(`[WorkerPals] Rebase conflicts resolved for ${publicBranchName}; re-running git pull --rebase (attempt ${attempt + 1}/${maxPullRebaseAttempts}).`);
      }
    }
    if (!syncedWithRemote) {
      return {
        ok: false,
        error: `Failed to sync ${publicBranchName} after ${maxPullRebaseAttempts} pull --rebase attempt(s).`
      };
    }
    const rebasedSha = await currentRefSha(repo, "HEAD");
    if (!rebasedSha) {
      return { ok: false, error: "Failed to resolve rebased commit SHA after pull --rebase." };
    }
    const updateHiddenRef = await git2(repo, ["update-ref", hiddenCommitRef, rebasedSha]);
    if (!updateHiddenRef.ok) {
      return {
        ok: false,
        error: `Failed to update hidden commit ref after rebase: ${combinedGitOutput(updateHiddenRef)}`
      };
    }
    return { ok: true, sha: rebasedSha };
  } finally {
    if (branchCheckedOut) {
      await git2(repo, ["checkout", "--detach", hiddenCommitRef]);
      await git2(repo, ["branch", "-D", tempBranch]);
    }
  }
}
function shouldUseCodexCliForExecutor(executor) {
  return executor.trim().toLowerCase() === "openai_codex";
}
function codexProjectConfigRoots(repo, env) {
  const roots = [];
  const seen = new Set;
  const add = (raw) => {
    const text = String(raw ?? "").trim();
    if (!text)
      return;
    const root = resolve10(text);
    const key = root.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    roots.push(root);
  };
  add(repo);
  for (const key of [
    "PUSHPALS_REPO_ROOT_OVERRIDE",
    "PUSHPALS_PROJECT_ROOT_OVERRIDE",
    "PUSHPALS_ASSIGNED_REPO_ROOT",
    "PUSHPALS_REPO_PATH"
  ]) {
    add(env[key]);
  }
  return roots;
}
function maskRepoLocalCodexFilesForCodexCli(repo, env) {
  const masked = [];
  for (const root of codexProjectConfigRoots(repo, env)) {
    const codexPath = resolve10(root, ".codex");
    if (!existsSync8(codexPath))
      continue;
    try {
      if (lstatSync2(codexPath).isDirectory())
        continue;
      let backupPath = resolve10(root, `.codex.pushpals-masked-${process.pid}-${masked.length}`);
      let suffix = 0;
      while (existsSync8(backupPath)) {
        suffix += 1;
        backupPath = resolve10(root, `.codex.pushpals-masked-${process.pid}-${masked.length}-${suffix}`);
      }
      renameSync(codexPath, backupPath);
      masked.push({ codexPath, backupPath });
      console.warn(`[WorkerPals] Temporarily masked repo-local .codex file so Codex CLI can use CODEX_HOME: ${codexPath}`);
    } catch (error) {
      console.warn(`[WorkerPals] Failed to mask repo-local .codex file ${codexPath}: ${String(error)}`);
    }
  }
  return masked;
}
function restoreRepoLocalCodexFilesForCodexCli(masked) {
  for (const entry of [...masked].reverse()) {
    try {
      if (existsSync8(entry.codexPath)) {
        rmSync3(entry.codexPath, { recursive: true, force: true });
      }
      if (existsSync8(entry.backupPath)) {
        renameSync(entry.backupPath, entry.codexPath);
      }
    } catch (error) {
      console.warn(`[WorkerPals] Failed to restore repo-local .codex file ${entry.codexPath}: ${String(error)}`);
    }
  }
}
function normalizeCodexReasoningEffort(value, model = "") {
  const normalized = String(value ?? "").trim().toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(String(model ?? "").trim());
  const defaultEffort = supportsExtraHigh ? "xhigh" : "high";
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized === "xhigh" && !supportsExtraHigh ? "high" : normalized;
  }
  if (normalized === "extra high" || normalized === "extra-high" || normalized === "extrahigh" || normalized === "x-high") {
    return supportsExtraHigh ? "xhigh" : "high";
  }
  return defaultEffort;
}
async function generateCommitMessageFromDiff(diff, opts, repo, runtimeConfig) {
  const prompt = buildCommitMessageGeneratorPrompt(diff, opts);
  if (!prompt)
    return null;
  if (shouldUseCodexCliForExecutor(resolveExecutor(runtimeConfig))) {
    return generateCommitMessageFromDiffViaCodex(prompt, opts, repo, runtimeConfig);
  }
  return generateCommitMessageFromDiffViaHttp(prompt, opts, runtimeConfig);
}
function resolveCommitMessageGeneratorTimeoutMs(runtimeConfig = DEFAULT_CONFIG3) {
  const workerpalsConfig = runtimeConfig.workerpals;
  const llmConfig = workerpalsConfig.llm && typeof workerpalsConfig.llm === "object" ? workerpalsConfig.llm : {};
  const configuredRaw = workerpalsConfig.commitMessageTimeoutMs ?? workerpalsConfig.commit_message_timeout_ms ?? llmConfig.commitMessageTimeoutMs ?? llmConfig.commit_message_timeout_ms ?? Bun.env.WORKERPALS_COMMIT_MESSAGE_TIMEOUT_MS;
  const configured = Number(configuredRaw);
  const value = Number.isFinite(configured) ? configured : COMMIT_MSG_GENERATOR_DEFAULT_TIMEOUT_MS;
  return Math.max(COMMIT_MSG_GENERATOR_MIN_TIMEOUT_MS, Math.min(COMMIT_MSG_GENERATOR_MAX_TIMEOUT_MS, Math.floor(value)));
}
function shouldUseLlmCommitMessageForStagedDiff(params) {
  if (!String(params.diff ?? "").trim())
    return false;
  return params.changedPaths.length <= COMMIT_MSG_LLM_MAX_CHANGED_PATHS;
}
function buildCommitMessageGeneratorPrompt(diff, opts) {
  if (!diff.trim())
    return null;
  let systemPrompt;
  try {
    systemPrompt = loadPromptTemplate("workerpals/commit_message_prompt.md", {
      type: opts.type,
      area: opts.area
    }).trim();
    if (!systemPrompt || systemPrompt.includes("{{"))
      return null;
  } catch {
    return null;
  }
  const userMessage = buildCommitMessageGeneratorUserMessage(opts.instruction, opts.validationSteps, diff);
  return { systemPrompt, userMessage };
}
async function generateCommitMessageFromDiffViaCodex(prompt, opts, repo, runtimeConfig) {
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!model)
    return null;
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix)
    return null;
  const timeoutMs = resolveCommitMessageGeneratorTimeoutMs(runtimeConfig);
  const reasoningEffort = normalizeCodexReasoningEffort(runtimeConfig.workerpals.llm.reasoningEffort, model);
  const tmpOutputPath = resolve10(Bun.env.TEMP || Bun.env.TMP || Bun.env.TMPDIR || "/tmp", `pushpals-commit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const cmd = [
    ...codexPrefix,
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-a",
    "never",
    "-s",
    "read-only",
    "exec",
    "--color",
    "never",
    "--output-last-message",
    tmpOutputPath
  ];
  if (model)
    cmd.push("-m", model);
  cmd.push("-");
  const env = buildWorkerSandboxWritableEnv(repo);
  const codexMask = maskRepoLocalCodexFilesForCodexCli(repo, env);
  try {
    const stdinText = `${prompt.systemPrompt}

${prompt.userMessage}`;
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([stdinText])
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (timedOut || exitCode !== 0)
      return null;
    let content = "";
    try {
      content = readFileSync8(tmpOutputPath, "utf8").trim();
    } catch {
      content = "";
    }
    if (!content) {
      content = (await new Response(proc.stdout).text()).trim();
    }
    if (!content)
      return null;
    const clean = sanitizeGeneratedCommitMessage(content, opts.type, opts.area);
    return clean;
  } catch {
    return null;
  } finally {
    restoreRepoLocalCodexFilesForCodexCli(codexMask);
    try {
      unlinkSync(tmpOutputPath);
    } catch {}
  }
}
async function generateCommitMessageFromDiffViaHttp(prompt, opts, runtimeConfig) {
  const endpoint = normalizeChatCompletionsEndpoint(runtimeConfig.workerpals.llm.endpoint);
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!endpoint || !model)
    return null;
  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers = { "Content-Type": "application/json" };
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`;
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), resolveCommitMessageGeneratorTimeoutMs(runtimeConfig));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: prompt.userMessage }
        ],
        temperature: 0,
        max_tokens: 500
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok)
      return null;
    const payload = parseJsonObjectLoose(await response.text());
    if (!payload)
      return null;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = String(choices[0]?.message?.content ?? "").trim();
    if (!content)
      return null;
    const clean = sanitizeGeneratedCommitMessage(content, opts.type, opts.area);
    if (!clean)
      return null;
    return clean;
  } catch {
    clearTimeout(timer);
    return null;
  }
}
function buildCommitMessageGeneratorUserMessage(instruction, validationSteps, diff) {
  const testLines = validationSteps.filter(isTestLikeValidationStep).map((step) => `- ${step}`).join(`
`) || "- (none)";
  return loadPromptTemplate("workerpals/commit_message_user_prompt.md", {
    diff_excerpt: diff.slice(0, COMMIT_MSG_MAX_DIFF_CHARS),
    test_lines: testLines,
    instruction_excerpt: instruction.slice(0, 400)
  });
}
function isPlanningLanguageBullet(bullet) {
  return /^at least\b|^all existing\b|^no unrelated\b|\bshould be\b|\bmust be\b|\bwill (pass|work|run|be)\b|\bare (added|modified|changed|updated|created)\b/i.test(bullet);
}
function sanitizeGeneratedCommitMessage(content, type, area) {
  const clean = content.replace(/^```[^\n]*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  if (!clean.startsWith(`${type}(${area})`))
    return null;
  const lines = clean.split(`
`);
  const testsSectionIndex = lines.findIndex((line) => /^Tests:\s*$/i.test(line.trim()));
  const implementationLines = testsSectionIndex >= 0 ? lines.slice(0, testsSectionIndex) : lines;
  const bullets = implementationLines.filter((line) => /^\s*-\s+\S/.test(line) && !/^Tests:/i.test(line.trim())).map((line) => line.replace(/^\s*-\s+/, "").trim());
  const planningCount = bullets.filter(isPlanningLanguageBullet).length;
  if (bullets.length > 0 && planningCount / bullets.length >= 0.67)
    return null;
  return clean;
}
function buildWorkerCommitMessage(workerId, job, changedPaths = []) {
  const normalizedChangedPaths = parseChangedPathsFromNameOnlyOutput(changedPaths.join(`
`));
  const action = summarizeJobAction(job.kind, job.params);
  const type = normalizeCommitType(job.kind, job.params);
  const area = inferCommitArea(job.kind, job.params, normalizedChangedPaths);
  const summary = deriveSummary(action, job.params, normalizedChangedPaths, area);
  const implementationPoints = buildImplementationPoints(job.kind, job.params, normalizedChangedPaths) || `- ${sanitizeCommitValue(action, 220) || "apply requested repository update"}`;
  const testsBlock = buildCommitTestsBlock(job.params);
  const lines = [
    `${sanitizeCommitValue(type, 16)}(${sanitizeCommitValue(area, 48)}): ${sanitizeCommitValue(summary, 72)}`,
    "",
    implementationPoints,
    "",
    "Tests:",
    testsBlock
  ];
  if (shouldIncludeCommitMeta(job.params)) {
    const contextValue = sanitizeCommitValue(job.context ?? "host", 32);
    const sessionValue = sanitizeCommitValue(job.sessionId ?? "", 128);
    lines.push(buildCommitMetaBlock(job.kind, job.params, {
      worker_id: sanitizeCommitValue(workerId, 64),
      task_id: sanitizeCommitValue(job.taskId, 128),
      job_id: sanitizeCommitValue(job.id, 128),
      context: contextValue || "host",
      session_line: sessionValue ? `- session: ${sessionValue}` : ""
    }, normalizedChangedPaths));
  }
  return lines.join(`
`);
}
var SUPPORTED_JOB_KINDS = new Set(["warmup.execute", "task.execute"]);
var MAX_MERGE_CONFLICT_RESOLUTION_PASSES = 8;
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function hasInvalidRepoPathHint(values) {
  return values.some((entry) => normalizeStagePath(entry) === null);
}
var SANDBOX_STAGE_ARTIFACT_PATHS = ["workspace", "outputs", ".codex", "node_modules"];
function taskExecuteOrigin(params) {
  const explicit = String(params.origin ?? "").trim().toLowerCase();
  if (explicit === "autonomy")
    return "autonomy";
  const autonomy = params.autonomy;
  if (autonomy && typeof autonomy === "object" && !Array.isArray(autonomy)) {
    const nested = String(autonomy.origin ?? "").trim().toLowerCase();
    if (nested === "autonomy")
      return "autonomy";
  }
  return "user";
}
function collectWriteScopeIssuesFromChangedPaths(changedPaths, planning) {
  return [];
}
function pathHintHasGlob(value) {
  return /[*?[\]{}]/.test(value);
}
function pathHintLooksLikeConcreteFile(value) {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const tail = normalized.split("/").pop() ?? normalized;
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/.test(tail);
}
function taskTextAllowsCreatingMissingPaths(value) {
  return /\b(create|add|new|scaffold|generate|introduce|write)\b.{0,80}\b(file|test|module|component|script|page|route|fixture|helper)\b/i.test(value);
}
function shouldTreatMissingPathHintAsStale(repo, path, taskText) {
  const normalized = normalizeStagePath(path);
  if (!normalized || normalized === "." || pathHintHasGlob(normalized))
    return false;
  if (existsSync8(resolve10(repo, normalized)))
    return false;
  if (!pathHintLooksLikeConcreteFile(normalized))
    return false;
  if (taskTextAllowsCreatingMissingPaths(taskText))
    return false;
  return true;
}
function pathParentExists(repo, path) {
  const normalized = normalizeStagePath(path);
  if (!normalized || normalized === "." || pathHintHasGlob(normalized))
    return true;
  const parts = normalized.split("/");
  if (parts.length <= 1)
    return true;
  return existsSync8(resolve10(repo, parts.slice(0, -1).join("/")));
}
function sanitizeStalePathHints(repo, values, taskText, opts = {}) {
  const stale = [];
  const diagnostics = [];
  const seen = new Set;
  const out = [];
  for (const raw of toStringArray(values)) {
    if (seen.has(raw.toLowerCase()))
      continue;
    seen.add(raw.toLowerCase());
    if (shouldTreatMissingPathHintAsStale(repo, raw, taskText)) {
      stale.push(raw);
      diagnostics.push(`Path hint "${raw}" does not exist in this checkout; treat it as stale unless the task explicitly asks to create it.`);
      continue;
    }
    if (!pathParentExists(repo, raw) && !taskTextAllowsCreatingMissingPaths(taskText)) {
      const diagnostic = `Path hint "${raw}" has a missing parent directory; verify the existing repo owner before editing.`;
      diagnostics.push(diagnostic);
      if (opts.dropMissingParentHints) {
        stale.push(raw);
        continue;
      }
    }
    out.push(raw);
  }
  return { values: out, stale, diagnostics };
}
function validationStepMentionsAnyPath(step, paths) {
  const lower = step.replace(/\\/g, "/").toLowerCase();
  return paths.some((path) => lower.includes(path.replace(/\\/g, "/").toLowerCase()));
}
function sanitizeTaskExecutePlanningPathHints(value, repo, instruction = "") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const planning = value;
  const out = { ...planning };
  const taskText = [
    instruction,
    planning.intent,
    ...isStringArray(planning.targetPaths) ? planning.targetPaths : [],
    ...isStringArray(planning.acceptanceCriteria) ? planning.acceptanceCriteria : [],
    ...isStringArray(planning.validationSteps) ? planning.validationSteps : []
  ].map((entry) => String(entry ?? "")).join(`
`);
  const repoDiagnostics = isStringArray(planning.repoHintDiagnostics) ? toStringArray(planning.repoHintDiagnostics) : [];
  const staleHints = [];
  if (repo && isStringArray(planning.targetPaths)) {
    const sanitized = sanitizeStalePathHints(repo, planning.targetPaths, taskText);
    out.targetPaths = sanitized.values;
    staleHints.push(...sanitized.stale);
    repoDiagnostics.push(...sanitized.diagnostics);
  }
  if (planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope)) {
    const scope = planning.scope;
    const normalizedScope = { ...scope };
    if (isStringArray(scope.writeGlobs)) {
      const sanitized = repo ? sanitizeStalePathHints(repo, scope.writeGlobs, taskText) : { values: toStringArray(scope.writeGlobs), stale: [], diagnostics: [] };
      normalizedScope.writeGlobs = sanitized.values;
      staleHints.push(...sanitized.stale);
      repoDiagnostics.push(...sanitized.diagnostics);
    }
    if (isStringArray(scope.forbiddenGlobs)) {
      normalizedScope.forbiddenGlobs = toStringArray(scope.forbiddenGlobs);
    }
    out.scope = normalizedScope;
  }
  if (planning.discovery && typeof planning.discovery === "object" && !Array.isArray(planning.discovery)) {
    const discovery = planning.discovery;
    const normalizedDiscovery = { ...discovery };
    if (isStringArray(discovery.likelyDirs)) {
      const sanitized = repo ? sanitizeStalePathHints(repo, discovery.likelyDirs, taskText, {
        dropMissingParentHints: true
      }) : { values: toStringArray(discovery.likelyDirs), stale: [], diagnostics: [] };
      normalizedDiscovery.likelyDirs = sanitized.values;
      staleHints.push(...sanitized.stale);
      repoDiagnostics.push(...sanitized.diagnostics);
    }
    out.discovery = normalizedDiscovery;
  }
  if (staleHints.length > 0 && isStringArray(planning.validationSteps)) {
    out.validationSteps = toStringArray(planning.validationSteps).filter((step) => !validationStepMentionsAnyPath(step, staleHints));
  }
  if (staleHints.length > 0 && isStringArray(planning.requiredValidationSteps)) {
    out.requiredValidationSteps = toStringArray(planning.requiredValidationSteps).filter((step) => !validationStepMentionsAnyPath(step, staleHints));
  }
  if (repoDiagnostics.length > 0) {
    out.repoHintDiagnostics = Array.from(new Set(repoDiagnostics)).slice(0, 8);
  }
  if (staleHints.length > 0) {
    out.repoHintStalePaths = Array.from(new Set(staleHints)).slice(0, 16);
  }
  return out;
}
function sanitizePlannerWorkerInstructionPathHints(value, staleHints) {
  const text = String(value ?? "").trim();
  if (!text)
    return;
  const normalizedHints = toStringArray(staleHints).map((hint) => normalizeStagePath(hint)).filter((hint) => Boolean(hint)).map((hint) => hint.toLowerCase());
  if (normalizedHints.length === 0)
    return text;
  const uniqueHints = Array.from(new Set(normalizedHints));
  const hasStaleHint = (line) => {
    const lower = line.replace(/\\/g, "/").toLowerCase();
    return uniqueHints.some((hint) => lower.includes(hint));
  };
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !hasStaleHint(line)).map((line) => line.trim()).filter(Boolean);
  if (kept.length === lines.length)
    return text;
  return [
    "Planner path guidance was sanitized because it referenced paths absent from this checkout; rely on the Task planning contract target path hints and existing repo owners instead.",
    ...kept
  ].join(`
`);
}
function validateTaskExecutePlanning(value, options) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "task.execute requires params.planning object" };
  }
  const planning = value;
  const origin = options?.origin === "autonomy" ? "autonomy" : "user";
  const intent = String(planning.intent ?? "");
  const riskLevel = String(planning.riskLevel ?? "");
  const queuePriority = String(planning.queuePriority ?? "");
  const queueWaitBudgetMs = Number(planning.queueWaitBudgetMs);
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);
  const validIntents = ["chat", "status", "code_change", "analysis", "other"];
  const validRisks = ["low", "medium", "high"];
  const validPriorities = ["interactive", "normal", "background"];
  if (!validIntents.includes(intent)) {
    return { ok: false, message: "task.execute planning.intent is invalid" };
  }
  if (!validRisks.includes(riskLevel)) {
    return { ok: false, message: "task.execute planning.riskLevel is invalid" };
  }
  if (!validPriorities.includes(queuePriority)) {
    return { ok: false, message: "task.execute planning.queuePriority is invalid" };
  }
  if (!planning.scope || typeof planning.scope !== "object" || Array.isArray(planning.scope)) {
    return { ok: false, message: "task.execute planning.scope must be an object" };
  }
  const scope = planning.scope;
  if (typeof scope.readAnywhere !== "boolean") {
    return { ok: false, message: "task.execute planning.scope.readAnywhere must be boolean" };
  }
  if (typeof scope.writeAllowed !== "boolean") {
    return { ok: false, message: "task.execute planning.scope.writeAllowed must be boolean" };
  }
  if (scope.writeGlobs !== undefined && !isStringArray(scope.writeGlobs)) {
    return { ok: false, message: "task.execute planning.scope.writeGlobs must be a string array" };
  }
  if (isStringArray(scope.writeGlobs) && hasInvalidRepoPathHint(scope.writeGlobs)) {
    return {
      ok: false,
      message: "task.execute planning.scope.writeGlobs must contain repo-relative path hints only"
    };
  }
  if (scope.forbiddenGlobs !== undefined && !isStringArray(scope.forbiddenGlobs)) {
    return {
      ok: false,
      message: "task.execute planning.scope.forbiddenGlobs must be a string array"
    };
  }
  if (isStringArray(scope.forbiddenGlobs) && hasInvalidRepoPathHint(scope.forbiddenGlobs)) {
    return {
      ok: false,
      message: "task.execute planning.scope.forbiddenGlobs must contain repo-relative path hints only"
    };
  }
  if (scope.maxFilesToEdit !== undefined && (!Number.isFinite(Number(scope.maxFilesToEdit)) || Number(scope.maxFilesToEdit) <= 0)) {
    return { ok: false, message: "task.execute planning.scope.maxFilesToEdit must be > 0" };
  }
  if (planning.targetPaths !== undefined && !isStringArray(planning.targetPaths)) {
    return { ok: false, message: "task.execute planning.targetPaths must be a string array" };
  }
  if (isStringArray(planning.targetPaths)) {
    const normalizedTargetPaths = planning.targetPaths.map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry));
    if (normalizedTargetPaths.length !== planning.targetPaths.length) {
      return {
        ok: false,
        message: "task.execute planning.targetPaths must contain literal repo-relative paths"
      };
    }
  }
  if (planning.discovery !== undefined) {
    if (!planning.discovery || typeof planning.discovery !== "object" || Array.isArray(planning.discovery)) {
      return { ok: false, message: "task.execute planning.discovery must be an object" };
    }
    const discovery = planning.discovery;
    if (!isStringArray(discovery.ripgrepQueries)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.ripgrepQueries must be a string array"
      };
    }
    if (discovery.likelyDirs !== undefined && !isStringArray(discovery.likelyDirs)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.likelyDirs must be a string array"
      };
    }
    if (isStringArray(discovery.likelyDirs) && hasInvalidRepoPathHint(discovery.likelyDirs)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.likelyDirs must be repo-relative path hints"
      };
    }
    if (discovery.keywords !== undefined && !isStringArray(discovery.keywords)) {
      return {
        ok: false,
        message: "task.execute planning.discovery.keywords must be a string array"
      };
    }
  }
  if (!isStringArray(planning.acceptanceCriteria)) {
    return {
      ok: false,
      message: "task.execute planning.acceptanceCriteria must be a string array"
    };
  }
  if (!isStringArray(planning.validationSteps)) {
    return { ok: false, message: "task.execute planning.validationSteps must be a string array" };
  }
  if (planning.requiredValidationSteps !== undefined && !isStringArray(planning.requiredValidationSteps)) {
    return {
      ok: false,
      message: "task.execute planning.requiredValidationSteps must be a string array"
    };
  }
  if (planning.acceptanceCriteria.length === 0) {
    return {
      ok: false,
      message: "task.execute planning.acceptanceCriteria must include at least one acceptance criterion"
    };
  }
  if (planning.validationSteps.length === 0) {
    return {
      ok: false,
      message: "task.execute planning.validationSteps must include at least one validation step"
    };
  }
  if (!Number.isFinite(queueWaitBudgetMs) || queueWaitBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.queueWaitBudgetMs must be > 0" };
  }
  if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.executionBudgetMs must be > 0" };
  }
  if (!Number.isFinite(finalizationBudgetMs) || finalizationBudgetMs <= 0) {
    return { ok: false, message: "task.execute planning.finalizationBudgetMs must be > 0" };
  }
  return { ok: true };
}
var cachedCodexCommandPrefix = new Map;
async function canExecuteCodexCommandCandidate(repo, candidate) {
  if (candidate.length === 0)
    return false;
  try {
    const proc = Bun.spawn([...candidate, "--version"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, 15000);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return !timedOut && exitCode === 0;
  } catch {
    return false;
  }
}
async function resolveCodexCommandPrefix(repo, configuredCommand = "") {
  const cacheKey = `${repo}\x00${configuredCommand.trim()}`;
  const cached = cachedCodexCommandPrefix.get(cacheKey);
  if (cached)
    return [...cached];
  const candidates = [];
  const configured = splitArgs(configuredCommand);
  if (configured.length > 0)
    candidates.push(configured);
  candidates.push(["bun", "x", "--yes", "@openai/codex"]);
  candidates.push(["bunx", "--yes", "@openai/codex"]);
  candidates.push(["codex"]);
  for (const candidate of candidates) {
    if (await canExecuteCodexCommandCandidate(repo, candidate)) {
      cachedCodexCommandPrefix.set(cacheKey, [...candidate]);
      return candidate;
    }
  }
  return null;
}
async function runCodexCriticReview(repo, params, quality, runtimeConfig, onLog) {
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix) {
    onLog?.("stderr", "[CriticGate] Codex: unable to resolve Codex CLI command (workerpals.llm.codex_bin/PATH); skipping.");
    return null;
  }
  const instruction = String(params.instruction ?? "").trim();
  const planning = params.planning;
  const qualityCriticTimeoutMs = resolveQualityCriticTimeoutMs(runtimeConfig);
  const timeoutBehavior = resolveQualityCriticTimeoutBehavior(runtimeConfig);
  const criticModel = resolveQualityCriticModel(runtimeConfig);
  const buildCriticInstruction = async (compact) => {
    const changedForDiff = quality.changedPaths.slice(0, compact ? 4 : 8);
    let diffText = await buildCriticDiffText(repo, changedForDiff);
    diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(0, resolveQualityCriticMaxDiffChars(runtimeConfig, compact));
    const validationSummary = buildCriticValidationSummary(quality, resolveQualityCriticMaxValidationOutputChars(runtimeConfig, compact));
    const criticInstruction = loadPromptTemplate("workerpals/codex_quality_critic_instruction_prompt.md", {
      instruction,
      acceptance_criteria: planning.acceptanceCriteria.map((c) => `- ${c}`).join(`
`) || "- (none)",
      changed_paths: quality.changedPaths.join(", ") || "(none)",
      diff_section: diffText ? `Diff:
${diffText}` : "Diff: (empty - no changes detected)",
      validation_section: validationSummary ? `Validation:
${validationSummary}` : "Validation: (none)"
    });
    return {
      criticInstruction,
      promptChars: criticInstruction.length,
      promptBytes: new TextEncoder().encode(criticInstruction).length,
      diffChars: diffText.length,
      validationChars: validationSummary.length
    };
  };
  const tmpOutputPath = `/tmp/pushpals-critic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const buildCmd = () => {
    const cmd = [
      ...codexPrefix,
      "-c",
      'model_reasoning_effort="low"',
      "-a",
      "never",
      "exec",
      "-s",
      "read-only",
      "--color",
      "never",
      "--output-last-message",
      tmpOutputPath
    ];
    if (criticModel)
      cmd.push("-m", criticModel);
    cmd.push("-");
    return cmd;
  };
  const env = buildWorkerSandboxWritableEnv(repo);
  const codexMask = maskRepoLocalCodexFilesForCodexCli(repo, env);
  const runAttempt = async (attempt, compact, payloadOverride) => {
    try {
      unlinkSync(tmpOutputPath);
    } catch {}
    const payload = payloadOverride ?? await buildCriticInstruction(compact);
    const startedAt = Date.now();
    onLog?.("stdout", `[CriticGate] Codex review attempt ${attempt}${compact ? " (compact)" : ""}: model=${criticModel || "(codex default)"} timeout_ms=${qualityCriticTimeoutMs} behavior=${timeoutBehavior} prompt_chars=${payload.promptChars} prompt_bytes=${payload.promptBytes} diff_chars=${payload.diffChars} validation_chars=${payload.validationChars}`);
    const proc = Bun.spawn(buildCmd(), {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([payload.criticInstruction])
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, qualityCriticTimeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (timedOut) {
      return { status: "timeout", payload };
    }
    if (exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      onLog?.("stderr", `[CriticGate] Codex exited ${exitCode}: ${toSingleLine(stderrText, 220)}`);
      return { status: "done", review: null, payload };
    }
    let lastMessage = "";
    try {
      lastMessage = (await Bun.file(tmpOutputPath).text()).trim();
    } catch {}
    try {
      unlinkSync(tmpOutputPath);
    } catch {}
    if (!lastMessage) {
      onLog?.("stderr", "[CriticGate] Codex: no output message captured; skipping.");
      return { status: "done", review: null, payload };
    }
    const reviewObj = parseJsonObjectLoose(lastMessage);
    if (!reviewObj) {
      onLog?.("stderr", `[CriticGate] Codex returned non-JSON: ${toSingleLine(lastMessage, 220)}`);
      return { status: "done", review: null, payload };
    }
    const scoreRaw = Number(reviewObj.score);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    const findings = Array.isArray(reviewObj.findings) ? reviewObj.findings.map((f) => String(f).trim()).filter(Boolean) : [];
    const mustFix = Array.isArray(reviewObj.must_fix) ? reviewObj.must_fix.map((f) => String(f).trim()).filter(Boolean) : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "").trim().slice(0, 2000);
    onLog?.("stdout", `[CriticGate] Codex score: ${score}/10 (${Date.now() - startedAt}ms, attempt ${attempt})`);
    return {
      status: "done",
      payload,
      review: {
        score,
        findings,
        mustFix,
        revisionGuidance,
        raw: compactJobOutput(lastMessage, outputPolicyForRuntime(runtimeConfig))
      }
    };
  };
  try {
    let attempt = await runAttempt(1, false);
    if (attempt.status === "timeout" && timeoutBehavior === "retry_once") {
      const compactPayload = await buildCriticInstruction(true);
      const validationPassed = quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
      if (shouldRetryCriticTimeoutWithCompact({
        timeoutBehavior,
        qualityOk: quality.ok,
        validationPassed,
        initialPromptChars: attempt.payload.promptChars,
        compactPromptChars: compactPayload.promptChars
      })) {
        onLog?.("stderr", `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; retrying once with compact critic input.`);
        attempt = await runAttempt(2, true, compactPayload);
      } else {
        const reductionPct = Math.max(0, Math.round((1 - compactPayload.promptChars / Math.max(1, attempt.payload.promptChars)) * 100));
        onLog?.("stderr", `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; compact critic input only reduced prompt by ${reductionPct}% after clean validation; skipping retry.`);
        return null;
      }
    }
    if (attempt.status === "timeout") {
      if (timeoutBehavior === "block") {
        onLog?.("stderr", `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; blocking because quality_critic_timeout_behavior=block.`);
        return criticTimeoutReview("Codex", qualityCriticTimeoutMs, qualityCriticTimeoutMs);
      }
      onLog?.("stderr", `[CriticGate] Codex timed out after ${qualityCriticTimeoutMs}ms; skipping.`);
      return null;
    }
    return attempt.review;
  } catch (err) {
    onLog?.("stderr", `[CriticGate] Codex error: ${toSingleLine(err, 220)} (skipping).`);
    return null;
  } finally {
    restoreRepoLocalCodexFilesForCodexCli(codexMask);
    try {
      unlinkSync(tmpOutputPath);
    } catch {}
  }
}
async function executeJob(kind, params, repo, onLog, runtimeConfig = DEFAULT_CONFIG3) {
  if (!SUPPORTED_JOB_KINDS.has(kind)) {
    return {
      ok: false,
      summary: `Unsupported job kind "${kind}". WorkerPals accepts only ${[...SUPPORTED_JOB_KINDS].join(" or ")}.`
    };
  }
  if (kind === "warmup.execute") {
    return {
      ok: true,
      summary: "Startup warmup completed (no-op, no commit).",
      stdout: "warmup.execute completed",
      exitCode: 0
    };
  }
  const schemaVersion = Number(params.schemaVersion);
  if (!Number.isFinite(schemaVersion) || Math.floor(schemaVersion) !== 2) {
    return {
      ok: false,
      summary: "task.execute requires params.schemaVersion=2",
      exitCode: 2
    };
  }
  const origin = taskExecuteOrigin(params);
  const autonomyScope = params.autonomy && typeof params.autonomy === "object" && !Array.isArray(params.autonomy) ? params.autonomy : null;
  const reviewAgent = params.reviewAgent && typeof params.reviewAgent === "object" && !Array.isArray(params.reviewAgent) ? params.reviewAgent : null;
  const planningValidation = validateTaskExecutePlanning(params.planning, {
    origin,
    autonomyComponentArea: autonomyScope?.componentArea ?? autonomyScope?.component_area,
    reviewAgentResolutionType: reviewAgent?.resolutionType
  });
  if (!planningValidation.ok) {
    return {
      ok: false,
      summary: planningValidation.message,
      exitCode: 2
    };
  }
  const instruction = String(params.instruction ?? "").trim();
  const sanitizedPlanning = sanitizeTaskExecutePlanningPathHints(params.planning, repo, instruction);
  const planning = sanitizedPlanning;
  if (origin === "autonomy" && toStringArray(planning.scope.writeGlobs ?? []).length === 0) {
    onLog?.("stdout", "[TaskExecute] Scope suggestion: planning.scope.writeGlobs is empty for autonomy-origin task.");
  }
  if ((planning.repoHintDiagnostics ?? []).length > 0) {
    onLog?.("stdout", `[TaskExecute] Repo hint preflight: ${(planning.repoHintDiagnostics ?? []).slice(0, 3).map((entry) => toSingleLine(entry, 180)).join(" | ")}`);
  }
  if (!instruction) {
    return {
      ok: false,
      summary: "task.execute requires an 'instruction' param"
    };
  }
  const normalizedParams = {
    ...params,
    planning: sanitizedPlanning,
    instruction
  };
  const sanitizedPlannerWorkerInstruction = sanitizePlannerWorkerInstructionPathHints(params.plannerWorkerInstruction, planning.repoHintStalePaths ?? []);
  if (sanitizedPlannerWorkerInstruction !== undefined) {
    normalizedParams.plannerWorkerInstruction = sanitizedPlannerWorkerInstruction;
  }
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);
  const mergeConflictContext = extractMergeConflictReviewContext(normalizedParams);
  const reviewFixContext = extractReviewFixContext(normalizedParams);
  const qualityGatePolicy = deriveQualityGatePolicy(normalizedParams, runtimeConfig);
  const qualityMaxAutoRevisions = qualityGatePolicy.maxAutoRevisions;
  const qualityValidationMaxAutoRevisions = qualityGatePolicy.validationMaxAutoRevisions;
  const qualityRepoValidationRepairMaxAutoRevisions = Math.max(qualityValidationMaxAutoRevisions, REPO_VALIDATION_REPAIR_MAX_AUTO_REVISIONS);
  const qualityRevisionLoopMax = Math.max(qualityRevisionLoopUpperBound(qualityGatePolicy, {
    browserValidation: taskRequestsBrowserValidation(normalizedParams)
  }), qualityRepoValidationRepairMaxAutoRevisions);
  const qualitySoftPassOnExhausted = qualityGatePolicy.softPassOnExhausted;
  const qualityCriticMinScore = qualityGatePolicy.criticMinScore;
  onLog?.("stdout", `[QualityGate] Policy: max_auto_revisions=${qualityMaxAutoRevisions}, validation_max_auto_revisions=${qualityValidationMaxAutoRevisions}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}, critic_min_score=${qualityCriticMinScore}`);
  onLog?.("stdout", `[QualityGate] Gates: scope=${qualityGatePolicy.scopeGateEnabled ? "on" : "off"}, validation=${qualityGatePolicy.validationGateEnabled ? "on" : "off"}, critic=${qualityGatePolicy.criticGateEnabled ? "on" : "off"}, publish=${qualityGatePolicy.publishGateEnabled ? "on" : "off"}`);
  if (qualityGatePolicy.mode === "review_fix") {
    const priorScore = reviewFixContext?.previousReviewScore != null ? reviewFixContext.previousReviewScore.toFixed(1) : "unknown";
    const threshold = reviewFixContext?.reviewThreshold != null ? reviewFixContext.reviewThreshold.toFixed(1) : qualityCriticMinScore.toFixed(1);
    onLog?.("stdout", `[QualityGate] review_fix policy active: prior_score=${priorScore}, target_threshold=${threshold}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; unfinished branch-state blockers fail hard, but repo/environment validation blockers soft-pass once the update is publishable.`);
  } else if (qualityGatePolicy.mode === "merge_conflict") {
    onLog?.("stdout", `[QualityGate] merge_conflict policy active: soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}; unfinished rebases still fail hard, but repo/environment validation blockers soft-pass once the rebase is publishable.`);
  }
  let revisionAttempt = 0;
  let revisionHint = "";
  const jobStartedAt = Date.now();
  const previousValidationFailureDigests = new Map;
  const passingValidationCache = new Map;
  const failureJobFamily = buildTaskFailureJobFamily(normalizedParams);
  const diagnosticValidationRuns = [];
  const diagnosticPatchSnapshots = [];
  let nextQualityRevisionExecuteBudgets = null;
  while (revisionAttempt <= qualityRevisionLoopMax) {
    const attemptStartedAt = Date.now();
    const attemptParams = { ...normalizedParams };
    if (revisionHint) {
      attemptParams.qualityRevisionHint = revisionHint;
      attemptParams.qualityRevisionAttempt = revisionAttempt;
    }
    const executor = resolveExecutor(runtimeConfig);
    const defaultExecuteBudgets = nextQualityRevisionExecuteBudgets ?? {
      executionBudgetMs,
      finalizationBudgetMs
    };
    nextQualityRevisionExecuteBudgets = null;
    const runExecutor = getBackendTaskExecutor(executor);
    if (!runExecutor) {
      return {
        ok: false,
        summary: `No task executor registered for backend "${executor}"`,
        exitCode: 1
      };
    }
    let result = null;
    let mergeConflictPass = 0;
    let executorElapsedMs = 0;
    let nextMergeConflictExecuteBudgets = null;
    while (true) {
      const currentExecuteBudgets = nextMergeConflictExecuteBudgets ?? defaultExecuteBudgets;
      nextMergeConflictExecuteBudgets = null;
      const currentResult = await runExecutor(kind, attemptParams, repo, runtimeConfig, onLog, currentExecuteBudgets);
      if (!currentResult.ok)
        return currentResult;
      result = currentResult;
      if (!mergeConflictContext)
        break;
      if (isHostScmOwnedReviewParams(attemptParams)) {
        onLog?.("stdout", "[MergeConflict] Container editing pass complete; host-side SCM will stage and continue the prepared rebase.");
        break;
      }
      const resume = await resumePreparedMergeConflictRebase(repo, kind, attemptParams, onLog);
      if (!resume.ok) {
        onLog?.("stderr", `[MergeConflict] ${resume.error}`);
        return {
          ok: false,
          summary: "Merge-conflict rebase continuation failed",
          stdout: currentResult.stdout,
          stderr: [currentResult.stderr ?? "", resume.error].filter(Boolean).join(`
`),
          exitCode: 4
        };
      }
      const sequencer = resume.sequencer;
      if (!sequencer)
        break;
      if (sequencer === "rebase" && resume.resumed && resume.advancedToNextConflict) {
        mergeConflictPass += 1;
        if (mergeConflictPass >= MAX_MERGE_CONFLICT_RESOLUTION_PASSES) {
          const detail2 = `Merge-conflict rebase required more than ${MAX_MERGE_CONFLICT_RESOLUTION_PASSES} resolver passes. Stopping to avoid an infinite conflict-resolution loop.`;
          onLog?.("stderr", `[MergeConflict] ${detail2}`);
          return {
            ok: false,
            summary: detail2,
            stdout: currentResult.stdout,
            stderr: [currentResult.stderr ?? "", resume.detail ?? detail2].filter(Boolean).join(`
`),
            exitCode: 4
          };
        }
        const retryBudget = mergeConflictResolverRetryBudgetDecision({
          jobElapsedMs: Date.now() - attemptStartedAt,
          executionBudgetMs,
          finalizationBudgetMs
        });
        if (!retryBudget.shouldStart) {
          const detail2 = `Merge-conflict rebase advanced into another conflicted commit, but remaining job budget is ${retryBudget.remainingTotalBudgetMs}ms (< ${retryBudget.minimumExecutionBudgetMs}ms execution).`;
          onLog?.("stderr", `[MergeConflict] ${detail2}`);
          return {
            ok: false,
            summary: detail2,
            stdout: currentResult.stdout,
            stderr: [currentResult.stderr ?? "", resume.detail ?? detail2].filter(Boolean).join(`
`),
            exitCode: 4
          };
        }
        nextMergeConflictExecuteBudgets = {
          executionBudgetMs: retryBudget.executionBudgetMs,
          finalizationBudgetMs: retryBudget.finalizationBudgetMs
        };
        onLog?.("stdout", `[MergeConflict] Rebase surfaced another conflicted commit after auto-continue; rerunning resolver pass ${mergeConflictPass + 1} with a capped completion budget (${retryBudget.executionBudgetMs}ms execution).`);
        continue;
      }
      if (sequencer === "rebase" && !resume.resumed) {
        mergeConflictPass += 1;
        const budget = mergeConflictResolverRetryBudgetDecision({
          jobElapsedMs: Date.now() - attemptStartedAt,
          executionBudgetMs,
          finalizationBudgetMs
        });
        if (mergeConflictPass < MAX_MERGE_CONFLICT_RESOLUTION_PASSES && budget.shouldStart) {
          const retryDetail = resume.detail ?? "the previous resolver pass returned before the prepared rebase completed";
          const previousHint = String(attemptParams.qualityRevisionHint ?? "").trim();
          attemptParams.qualityRevisionHint = [
            previousHint,
            [
              `Merge-conflict resolver pass ${mergeConflictPass} left the rebase unfinished: ${retryDetail}.`,
              "Focus only on the unresolved file content. Inspect unresolved files read-only, remove remaining conflict markers, and run focused validation.",
              "Do not checkout, switch, stage, commit, rebase, or push. The deterministic job orchestrator owns staging and rebase continuation after the editing pass."
            ].join(`
`)
          ].filter(Boolean).join(`

`);
          nextMergeConflictExecuteBudgets = {
            executionBudgetMs: budget.executionBudgetMs,
            finalizationBudgetMs: budget.finalizationBudgetMs
          };
          onLog?.("stdout", `[MergeConflict] ${retryDetail}; rerunning resolver pass ${mergeConflictPass + 1} with focused rebase-completion guidance and capped budget (${budget.executionBudgetMs}ms execution).`);
          continue;
        }
        if (!budget.shouldStart) {
          onLog?.("stderr", `[MergeConflict] Not rerunning unfinished rebase resolver: remaining total budget is ${budget.remainingTotalBudgetMs}ms (< ${budget.minimumExecutionBudgetMs}ms execution).`);
        }
      }
      const detail = `Merge-conflict job returned with git ${sequencer} still in progress. Finish the ${sequencer} before returning control to WorkerPals.`;
      onLog?.("stderr", `[MergeConflict] ${detail}`);
      return {
        ok: false,
        summary: detail,
        stdout: currentResult.stdout,
        stderr: [currentResult.stderr ?? "", detail].filter(Boolean).join(`
`),
        exitCode: 4
      };
    }
    if (!result) {
      return {
        ok: false,
        summary: "Merge-conflict execution ended without an executor result.",
        exitCode: 4
      };
    }
    executorElapsedMs = Date.now() - attemptStartedAt;
    const preQualityStatus = await git2(repo, ["status", "--porcelain"]);
    const rawPreQualityChangedPaths = preQualityStatus.ok ? expandKnownArtifactDirectoryPaths(repo, parseChangedPathsFromStatus(preQualityStatus.stdout)) : [];
    const preQualityChangedPaths = preQualityStatus.ok ? await filterChangedPathsByGitContentDelta(repo, rawPreQualityChangedPaths) : rawPreQualityChangedPaths;
    const preQualityPublishablePaths = publishableChangedPaths(preQualityChangedPaths);
    if (preQualityChangedPaths.length > 0) {
      diagnosticPatchSnapshots.push(buildPatchSnapshotDiagnostics(preQualityChangedPaths, revisionAttempt, "executor"));
    }
    const executorText = `${result.summary ?? ""}
${result.stdout ?? ""}
${result.stderr ?? ""}`;
    const shellWrapperReturn = /shell-wrapper command rejections|command-router shell-wrapper|command policy rejection/i.test(executorText);
    if (preQualityChangedPaths.length > 0 && preQualityPublishablePaths.length === 0) {
      const detail = `Executor changed only non-publishable dependency/runtime artifact path(s): ${preQualityChangedPaths.slice(0, 12).join(", ")}${preQualityChangedPaths.length > 12 ? ", ..." : ""}.`;
      onLog?.("stderr", `[QualityGate] ${detail} Skipping ValidationGate/CriticGate because there is no PR-worthy patch to validate.`);
      const failure = {
        ok: false,
        summary: `Executor produced no publishable code changes (${detail})`,
        stdout: result.stdout,
        stderr: [result.stderr ?? "", detail].filter(Boolean).join(`
`),
        exitCode: 4
      };
      return withJobDiagnostics(failure, {
        terminal: buildTerminalDiagnostics({
          result: failure,
          executor,
          changedPaths: preQualityChangedPaths,
          terminalStage: "executor",
          timeoutMs: executionBudgetMs,
          metadata: { revisionAttempt, executorElapsedMs }
        }),
        patchSnapshots: [...diagnosticPatchSnapshots]
      });
    }
    if (preQualityPublishablePaths.length === 0 && (qualityGatePolicy.mode === "review_fix" || shellWrapperReturn)) {
      const reason = qualityGatePolicy.mode === "review_fix" ? "Review-fix executor returned without publishable code changes." : "Codex hit shell-wrapper command rejections without leaving a publishable patch.";
      onLog?.("stderr", `[QualityGate] ${reason} Skipping ValidationGate/CriticGate and failing fast.`);
      const failure = {
        ok: false,
        summary: reason,
        stdout: result.stdout,
        stderr: [result.stderr ?? "", reason].filter(Boolean).join(`
`),
        exitCode: 4
      };
      return withJobDiagnostics(failure, {
        terminal: buildTerminalDiagnostics({
          result: failure,
          executor,
          changedPaths: preQualityChangedPaths,
          terminalStage: "executor",
          timeoutMs: executionBudgetMs,
          metadata: { revisionAttempt, executorElapsedMs, shellWrapperReturn }
        }),
        patchSnapshots: [...diagnosticPatchSnapshots]
      });
    }
    const qualityStartedAt = Date.now();
    const quality = await runDeterministicQualityGate(repo, attemptParams, runtimeConfig, qualityGatePolicy, onLog, {
      previousFailureDigests: previousValidationFailureDigests,
      revisionAttempt,
      passingValidationCache
    });
    const qualityElapsedMs = Date.now() - qualityStartedAt;
    diagnosticPatchSnapshots.push(buildPatchSnapshotDiagnostics(quality.changedPaths, revisionAttempt, "quality"));
    diagnosticValidationRuns.push(...buildValidationRunDiagnostics(quality.validationRuns, revisionAttempt));
    const validationCommandElapsedMs = quality.validationRuns.reduce((total, run) => total + Math.max(0, Number(run.elapsedMs) || 0), 0);
    onLog?.("stdout", `[JobRunner] Performance summary: attempt=${revisionAttempt}, executor=${executorElapsedMs}ms, quality=${qualityElapsedMs}ms, validation_commands=${quality.validationRuns.length}, validation_command_time=${validationCommandElapsedMs}ms, changed_files=${quality.changedPaths.length}`);
    recordValidationRemedyMemory(repo, failureJobFamily, quality.validationRuns);
    const validationRemedyHints = knownValidationRemedyHintsForRuns(repo, failureJobFamily, quality.validationRuns);
    let browserRepairPacket = buildBrowserValidationRepairPacket(quality.validationRuns, previousValidationFailureDigests, repo);
    if (browserRepairPacket) {
      const knownFailureHints = knownFailureHintsForPacket(repo, failureJobFamily, browserRepairPacket);
      browserRepairPacket = {
        ...browserRepairPacket,
        knownFailureHints
      };
      recordBrowserFailureMemory(repo, failureJobFamily, browserRepairPacket);
    }
    const unchangedValidationFailure = revisionAttempt > 0 ? findUnchangedValidationFailure(quality.validationRuns, previousValidationFailureDigests, repo) : null;
    for (const run of quality.validationRuns) {
      if (run.ok)
        continue;
      const digest = extractValidationFailureRetryDigest(run, repo);
      if (digest)
        previousValidationFailureDigests.set(validationCommandKey(run.command), digest);
    }
    const validationOutsideTaskScope = quality.validationFailureScope === "outside_task_scope";
    const repoValidationRepairMode = shouldRepairOutsideTaskRequiredValidation({
      requiredValidationFailures: quality.requiredValidationFailures,
      validationFailureScope: quality.validationFailureScope,
      changedPaths: quality.changedPaths,
      revisionAttempt,
      maxAutoRevisions: qualityRepoValidationRepairMaxAutoRevisions
    });
    const validationOutsideTaskScopeBlocksOnly = validationOutsideTaskScope && !repoValidationRepairMode;
    if (repoValidationRepairMode) {
      onLog?.("stderr", `[ValidationGate] Required validation failed outside original task scope; entering guarded repo validation repair mode for revision ${revisionAttempt + 1}/${qualityRepoValidationRepairMaxAutoRevisions}: ${quality.requiredValidationFailures.join("; ")}`);
    }
    const qualityForCritic = validationOutsideTaskScopeBlocksOnly ? {
      ...quality,
      issues: quality.issues.filter((issue) => !issue.startsWith("ValidationGate:")),
      validationIssues: [],
      validationRuns: [],
      blocker: null
    } : quality;
    const validationPassed = quality.validationRuns.length > 0 && quality.validationRuns.every((run) => run.ok);
    const skipCriticAfterExecutorTimeout = shouldSkipCriticAfterExecutorTimeout({
      executor,
      policyMode: qualityGatePolicy.mode,
      executorText,
      qualityOk: quality.ok,
      validationPassed,
      qualityIssues: qualityForCritic.issues,
      changedPaths: quality.changedPaths
    });
    const preCriticEffectiveQualityIssues = validationOutsideTaskScopeBlocksOnly ? quality.issues.filter((issue) => !issue.startsWith("ValidationGate:")) : quality.issues;
    const preCriticDeterministicRequiresRevision = preCriticEffectiveQualityIssues.length > 0 || quality.blocker !== null && !validationOutsideTaskScopeBlocksOnly;
    const skipCriticForDeterministicValidationRevision = shouldSkipCriticForDeterministicValidationRevision({
      deterministicRequiresRevision: preCriticDeterministicRequiresRevision,
      validationOutsideTaskScope: validationOutsideTaskScopeBlocksOnly,
      validationRuns: quality.validationRuns
    });
    const preCriticRevisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: Date.now() - jobStartedAt,
      executionBudgetMs
    });
    const skipCriticForRevisionBudget = shouldSkipCriticToPreserveRevisionBudget({
      deterministicRequiresRevision: preCriticDeterministicRequiresRevision,
      remainingBudgetMs: preCriticRevisionBudget.remainingBudgetMs,
      minimumRevisionBudgetMs: preCriticRevisionBudget.minimumRevisionBudgetMs,
      criticTimeoutMs: resolveQualityCriticTimeoutMs(runtimeConfig),
      criticTimeoutBehavior: resolveQualityCriticTimeoutBehavior(runtimeConfig)
    });
    const critic = quality.skipped || !qualityGatePolicy.criticGateEnabled || unchangedValidationFailure !== null || skipCriticAfterExecutorTimeout || skipCriticForDeterministicValidationRevision || skipCriticForRevisionBudget ? null : executor === "openai_codex" ? await runCodexCriticReview(repo, attemptParams, qualityForCritic, runtimeConfig, onLog) : await runTaskCriticReview(repo, attemptParams, qualityForCritic, runtimeConfig, onLog);
    const annotateTerminalResult = (terminalResult, terminalStage, changedPaths = quality.changedPaths) => withJobDiagnostics(terminalResult, {
      terminal: buildTerminalDiagnostics({
        result: terminalResult,
        executor,
        changedPaths,
        terminalStage,
        timeoutMs: executionBudgetMs,
        metadata: {
          revisionAttempt,
          executorElapsedMs,
          qualityElapsedMs,
          validationFailureScope: quality.validationFailureScope,
          repoValidationRepairMode,
          validationRuns: quality.validationRuns.length,
          criticScore: critic?.score ?? null
        }
      }),
      validationRuns: [...diagnosticValidationRuns],
      patchSnapshots: [...diagnosticPatchSnapshots]
    });
    if (unchangedValidationFailure) {
      const detail = `Validation failed unchanged after two attempts for "${unchangedValidationFailure.command}": ${unchangedValidationFailure.digest}. Stopping revisions for this failure cluster; dispatch a root-cause repair or move to another component.`;
      onLog?.("stderr", `[ValidationGate] ${detail}`);
      const failure = {
        ok: false,
        summary: "Repeated unchanged validation failure circuit opened",
        stdout: result.stdout,
        stderr: truncate([
          result.stderr ?? "",
          detail,
          ...quality.validationRuns.filter((run) => !run.ok).flatMap((run) => [run.stdout, run.stderr]).filter(Boolean)
        ].join(`
`), outputPolicyForRuntime(runtimeConfig)),
        exitCode: 4
      };
      return annotateTerminalResult(failure, "validation_circuit_breaker");
    }
    if (!qualityGatePolicy.criticGateEnabled) {
      onLog?.("stdout", "[CriticGate] Disabled by workerpals.quality_critic_gate_enabled=false.");
    } else if (skipCriticAfterExecutorTimeout) {
      onLog?.("stdout", "[CriticGate] Skipping Codex critic after primary Codex executor timeout because deterministic quality and validation are clean.");
    } else if (skipCriticForDeterministicValidationRevision) {
      onLog?.("stdout", "[CriticGate] Skipping critic because deterministic fast validation already requires a quality revision.");
    } else if (skipCriticForRevisionBudget) {
      onLog?.("stdout", `[CriticGate] Skipping critic because deterministic quality already requires revision and remaining budget (${preCriticRevisionBudget.remainingBudgetMs}ms) must be reserved for the next worker turn.`);
    }
    const rolloutScore = workerAttemptRolloutScore({
      executorElapsedMs,
      qualityElapsedMs,
      changedPaths: quality.changedPaths,
      validationRuns: quality.validationRuns,
      qualityIssues: quality.issues,
      criticScore: critic?.score
    });
    onLog?.("stdout", `[JobRunner] Rollout score: score=${rolloutScore.score} reasons=${rolloutScore.reasons.join(",") || "none"}`);
    const advisoryRelaxedQualityIssues = relaxAdvisoryQualityIssues(quality.issues, quality.validationRuns, critic, qualityCriticMinScore);
    let effectiveQualityIssues = advisoryRelaxedQualityIssues;
    if (validationOutsideTaskScopeBlocksOnly) {
      effectiveQualityIssues = effectiveQualityIssues.filter((issue) => !issue.startsWith("ValidationGate:"));
      if (effectiveQualityIssues.length !== quality.issues.length) {
        onLog?.("stderr", "[ValidationGate] Validation failures are outside the task scope; they will block publishing but will not drive another code revision.");
      }
    }
    if (!validationOutsideTaskScope && advisoryRelaxedQualityIssues.length !== quality.issues.length) {
      onLog?.("stdout", "[QualityGate] Assertion-balance heuristic downgraded to advisory because validation passed and critic score met threshold.");
    }
    const deterministicRequiresRevision = effectiveQualityIssues.length > 0 || quality.blocker !== null && !validationOutsideTaskScopeBlocksOnly;
    const criticRequiresRevision = Boolean(critic && critic.score < qualityCriticMinScore);
    if (!qualityGatePolicy.publishGateEnabled && (deterministicRequiresRevision || criticRequiresRevision)) {
      onLog?.("stderr", "[PublishGate] Disabled by workerpals.quality_publish_gate_enabled=false; returning worker result despite gate failures.");
      const advisoryResult = {
        ...result,
        summary: `${result.summary} (publish gate disabled; quality gate findings were advisory)`,
        stderr: truncate([
          result.stderr ?? "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          critic ? `Critic raw: ${critic.raw}` : ""
        ].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig)),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0
      };
      return annotateTerminalResult(advisoryResult, "quality");
    }
    if (quality.blocker?.category === "environment") {
      const blockedCommands = quality.validationRuns.filter((run) => !run.ok).map((run) => run.command);
      const blockerDiagnostics = truncate([
        result.stderr ?? "",
        ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean)
      ].join(`
`), outputPolicyForRuntime(runtimeConfig));
      const summary = "Candidate patch requires trusted-environment validation before publication";
      onLog?.("stderr", `[QualityGate] ${summary}: ${toSingleLine(quality.blocker.detail, 260)}`);
      const heldCandidate = {
        ...result,
        ok: true,
        summary,
        stderr: blockerDiagnostics,
        exitCode: 0,
        validationBlocked: {
          category: "environment",
          summary,
          detail: quality.blocker.detail,
          commands: blockedCommands
        }
      };
      return annotateTerminalResult(heldCandidate, "trusted_environment_validation_required");
    }
    if (!deterministicRequiresRevision && !criticRequiresRevision) {
      if (quality.requiredValidationFailures.length > 0) {
        const requiredSummary = `Required vision.md validation blocked publishing: ${quality.requiredValidationFailures.join("; ")}`;
        const diagnostics = truncate([
          result.stderr ?? "",
          validationOutsideTaskScope ? "Validation failures appear outside the task target/relevance hints and are treated as pre-existing repo blockers." : "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean)
        ].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig));
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: diagnostics,
          exitCode: 4
        };
        return annotateTerminalResult(failure, "validation");
      }
      if (critic) {
        onLog?.("stdout", `[CriticGate] review score ${critic.score.toFixed(1)}/10 (threshold ${qualityCriticMinScore}).`);
      }
      return annotateTerminalResult(result, "completed");
    }
    const blockerIssue = quality.blocker ? [
      `Validation blocker (${quality.blocker.category}): ${toSingleLine(quality.blocker.detail, 240)}`
    ] : [];
    const issues = buildQualityGateRevisionIssues([...effectiveQualityIssues, ...blockerIssue], critic, qualityCriticMinScore);
    const activeMaxAutoRevisions = revisionLimitForQualityGateFailures({
      policy: qualityGatePolicy,
      qualityIssues: effectiveQualityIssues,
      requiredValidationFailures: validationOutsideTaskScopeBlocksOnly ? [] : quality.requiredValidationFailures,
      blocker: validationOutsideTaskScopeBlocksOnly ? null : quality.blocker,
      browserRepairPacket: validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode ? null : browserRepairPacket
    });
    const issueSummary = browserRepairPacket && !validationOutsideTaskScopeBlocksOnly && !repoValidationRepairMode ? `ValidationGate browser ${browserRepairPacket.failureKind} repair for ${browserRepairPacket.command}: ${toSingleLine(browserRepairPacket.digest, 180)}` : issues.map((entry) => toSingleLine(entry, 180)).join(" | ");
    if (quality.blocker && !validationOutsideTaskScopeBlocksOnly) {
      const blockerSummary = `Quality gate blocked by ${quality.blocker.category} issue: ${quality.blocker.detail}`;
      const blockerDiagnostics = truncate([
        result.stderr ?? "",
        ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean)
      ].join(`
`), outputPolicyForRuntime(runtimeConfig));
      const requiredValidationCanRevise = shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: quality.requiredValidationFailures,
        blocker: quality.blocker,
        revisionAttempt,
        maxAutoRevisions: activeMaxAutoRevisions,
        outsideTaskScope: validationOutsideTaskScope,
        allowOutsideTaskScope: repoValidationRepairMode
      });
      if (requiredValidationCanRevise) {
        onLog?.("stderr", `[QualityGate] Required vision.md validation hit a repo blocker; requesting revision ${revisionAttempt + 1}/${activeMaxAutoRevisions} instead of failing immediately: ${quality.requiredValidationFailures.join("; ")}`);
      } else if (quality.requiredValidationFailures.length > 0) {
        const requiredSummary = `Required vision.md validation blocked publishing: ${quality.requiredValidationFailures.join("; ")}`;
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: blockerDiagnostics,
          exitCode: 4
        };
        return annotateTerminalResult(failure, "validation");
      } else if (shouldSoftPassValidationBlocker(qualityGatePolicy, quality.blocker)) {
        onLog?.("stderr", `[QualityGate] Soft-pass on ${quality.blocker.category} blocker for publishable ${qualityGatePolicy.mode} job: ${toSingleLine(quality.blocker.detail, 260)}`);
        const softPass = {
          ...result,
          summary: `${result.summary} (quality gate soft-pass on ${quality.blocker.category} blocker after publishable ${qualityGatePolicy.mode} update)`,
          stderr: blockerDiagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0
        };
        return annotateTerminalResult(softPass, "quality");
      } else {
        onLog?.("stderr", `[QualityGate] ${blockerSummary}`);
        const failure = {
          ok: false,
          summary: blockerSummary,
          stdout: result.stdout,
          stderr: blockerDiagnostics,
          exitCode: 4
        };
        return annotateTerminalResult(failure, "quality");
      }
    }
    if (revisionAttempt >= activeMaxAutoRevisions) {
      if (quality.requiredValidationFailures.length > 0) {
        const diagnostics = truncate([
          result.stderr ?? "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          critic ? `Critic raw: ${critic.raw}` : ""
        ].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig));
        const requiredSummary = `Required vision.md validation failed after ${revisionAttempt} auto-revision attempt(s): ${quality.requiredValidationFailures.join("; ")}`;
        onLog?.("stderr", `[QualityGate] ${requiredSummary}`);
        const failure2 = {
          ok: false,
          summary: requiredSummary,
          stdout: result.stdout,
          stderr: diagnostics,
          exitCode: 4
        };
        return annotateTerminalResult(failure2, "validation");
      }
      if (qualitySoftPassOnExhausted) {
        const diagnostics = truncate([result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig));
        onLog?.("stderr", `[QualityGate] Soft-pass after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(issueSummary, 260)}`);
        const softPass = {
          ...result,
          summary: `${result.summary} (quality gate soft-pass after ${revisionAttempt} auto-revision attempt(s))`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0
        };
        return annotateTerminalResult(softPass, "quality");
      }
      const failure = {
        ok: false,
        summary: `Quality gate failed after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(issueSummary, 240)}`,
        stdout: result.stdout,
        stderr: truncate([result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig)),
        exitCode: 4
      };
      return annotateTerminalResult(failure, "quality");
    }
    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: Date.now() - jobStartedAt,
      executionBudgetMs
    });
    const browserValidationContinuation = browserValidationRepairContinuationBudgetDecision({
      browserRepairPacket: validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode ? null : browserRepairPacket,
      validationOutsideTaskScope,
      changedPaths: quality.changedPaths,
      revisionBudget
    });
    const repoValidationContinuation = repoValidationRepairContinuationBudgetDecision({
      repoValidationRepairMode,
      changedPaths: quality.changedPaths,
      revisionBudget
    });
    const inScopeValidationContinuation = inScopeValidationRepairContinuationBudgetDecision({
      requiredValidationFailures: validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode ? [] : quality.requiredValidationFailures,
      validationOutsideTaskScope,
      changedPaths: quality.changedPaths,
      revisionBudget
    });
    if (!revisionBudget.shouldStart && !browserValidationContinuation.shouldContinue && !repoValidationContinuation.shouldContinue && !inScopeValidationContinuation.shouldContinue) {
      if (shouldSoftPassCriticOnlyBudgetExhaustion({
        softPassOnExhausted: qualitySoftPassOnExhausted,
        deterministicRequiresRevision,
        criticRequiresRevision,
        requiredValidationFailures: quality.requiredValidationFailures,
        changedPaths: quality.changedPaths
      })) {
        const diagnostics = truncate([
          result.stderr ?? "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          critic ? `Critic raw: ${critic.raw}` : ""
        ].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig));
        onLog?.("stderr", `[QualityGate] Soft-pass critic-only revision after validation passed but remaining execution budget ${revisionBudget.remainingBudgetMs}ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(issueSummary, 260)}`);
        const softPass = {
          ...result,
          summary: `${result.summary} (quality gate soft-pass after critic-only budget exhaustion with validation passing)`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0
        };
        return annotateTerminalResult(softPass, "quality");
      }
      const budgetSummary = `Quality gate needs revision ${revisionAttempt + 1}/${activeMaxAutoRevisions}, but remaining execution budget is ${revisionBudget.remainingBudgetMs}ms (< ${revisionBudget.minimumRevisionBudgetMs}ms); stopping before another worker turn to preserve a structured result: ${toSingleLine(issueSummary, 220)}`;
      onLog?.("stderr", `[QualityGate] ${budgetSummary}`);
      const failure = {
        ok: false,
        summary: budgetSummary,
        stdout: result.stdout,
        stderr: truncate([
          result.stderr ?? "",
          ...quality.validationRuns.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean),
          critic ? `Critic raw: ${critic.raw}` : ""
        ].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig)),
        exitCode: 4
      };
      return annotateTerminalResult(failure, "quality");
    }
    if (!revisionBudget.shouldStart && browserValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: browserValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: browserValidationContinuation.finalizationBudgetMs
      };
      onLog?.("stderr", `[QualityGate] Continuing browser validation repair ${revisionAttempt + 1}/${activeMaxAutoRevisions} with dedicated budget ${browserValidationContinuation.executionBudgetMs}ms execution + ${browserValidationContinuation.finalizationBudgetMs}ms finalization after original remaining budget ${revisionBudget.remainingBudgetMs}ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(issueSummary, 220)}`);
    } else if (!revisionBudget.shouldStart && repoValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: repoValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: repoValidationContinuation.finalizationBudgetMs
      };
      onLog?.("stderr", `[QualityGate] Continuing repo validation repair ${revisionAttempt + 1}/${activeMaxAutoRevisions} with dedicated budget ${repoValidationContinuation.executionBudgetMs}ms execution + ${repoValidationContinuation.finalizationBudgetMs}ms finalization after original remaining budget ${revisionBudget.remainingBudgetMs}ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(issueSummary, 220)}`);
    } else if (!revisionBudget.shouldStart && inScopeValidationContinuation.shouldContinue) {
      nextQualityRevisionExecuteBudgets = {
        executionBudgetMs: inScopeValidationContinuation.executionBudgetMs,
        finalizationBudgetMs: inScopeValidationContinuation.finalizationBudgetMs
      };
      onLog?.("stderr", `[QualityGate] Continuing in-scope validation repair ${revisionAttempt + 1}/${activeMaxAutoRevisions} with dedicated budget ${inScopeValidationContinuation.executionBudgetMs}ms execution + ${inScopeValidationContinuation.finalizationBudgetMs}ms finalization after original remaining budget ${revisionBudget.remainingBudgetMs}ms fell below ${revisionBudget.minimumRevisionBudgetMs}ms: ${toSingleLine(issueSummary, 220)}`);
    }
    revisionAttempt += 1;
    revisionHint = buildQualityRevisionHint(issues, critic, planning, reviewFixContext, validationOutsideTaskScopeBlocksOnly ? [] : quality.validationRuns, validationOutsideTaskScopeBlocksOnly ? null : quality.blocker, validationOutsideTaskScopeBlocksOnly || repoValidationRepairMode ? null : browserRepairPacket, quality.changedPaths, validationRemedyHints, repoValidationRepairMode);
    onLog?.("stderr", `[QualityGate] Quality gate requested revision ${revisionAttempt}/${activeMaxAutoRevisions}: ${toSingleLine(issueSummary, 260)}`);
  }
  return {
    ok: false,
    summary: "Quality revision loop ended unexpectedly.",
    exitCode: 4
  };
}

// apps/workerpals/src/docker_executor.ts
import { randomUUID } from "crypto";
import { existsSync as existsSync10, mkdirSync as mkdirSync4, readFileSync as readFileSync9, writeFileSync as writeFileSync5 } from "fs";
import { homedir as homedir3 } from "os";
import { isAbsolute as isAbsolute3, relative, resolve as resolve11 } from "path";

// apps/workerpals/src/common/worktree_cleanup.ts
import { existsSync as existsSync9, rmSync as rmSync4 } from "fs";
function defaultSleep(ms) {
  return new Promise((resolve11) => setTimeout(resolve11, ms));
}
function windowsDeletionCandidates(worktreePath) {
  const seen = new Set;
  const out = [];
  const add = (value) => {
    if (!value || seen.has(value))
      return;
    seen.add(value);
    out.push(value);
  };
  add(worktreePath);
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(worktreePath)) {
    add(`\\\\?\\${worktreePath}`);
  }
  return out;
}
async function forceDeleteWorktreePath(worktreePath, options = {}) {
  const retries = Math.max(1, Math.floor(options.retries ?? 5));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 120));
  const sleep = options.sleepFn ?? defaultSleep;
  const removePath = options.removeFn ?? ((targetPath) => rmSync4(targetPath, { recursive: true, force: true }));
  const pathExists = options.existsFn ?? ((targetPath) => existsSync9(targetPath));
  let lastError = "";
  for (let attempt = 1;attempt <= retries; attempt++) {
    if (!pathExists(worktreePath))
      return { removed: true };
    for (const candidate of windowsDeletionCandidates(worktreePath)) {
      try {
        removePath(candidate);
      } catch (error) {
        lastError = String(error);
      }
    }
    if (!pathExists(worktreePath))
      return { removed: true };
    if (attempt < retries)
      await sleep(delayMs * attempt);
  }
  return {
    removed: !pathExists(worktreePath),
    ...lastError ? { lastError } : {}
  };
}

// apps/workerpals/src/worktree_base_ref.ts
function normalizeBranchName2(value) {
  return value.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "").replace(/^\/+|\/+$/g, "");
}
function normalizeReviewHeadRef(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const normalized = trimmed.replace(/^refs\/heads\//, "").replace(/^origin\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock") || /[~^:?*\[\]\s]/.test(normalized)) {
    return null;
  }
  return normalized;
}
function normalizeExpectedSha(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40,64}$/.test(normalized) ? normalized : null;
}
function isReviewResolutionType(value) {
  return value === "review_fix" || value === "merge_conflict" || value === "integration_reconcile";
}
async function resolveReviewWorktreeBase(options) {
  const reviewAgent = options.params.reviewAgent && typeof options.params.reviewAgent === "object" && !Array.isArray(options.params.reviewAgent) ? options.params.reviewAgent : null;
  const resolutionType = typeof reviewAgent?.resolutionType === "string" ? reviewAgent.resolutionType.trim().toLowerCase() : "";
  if (!reviewAgent || !isReviewResolutionType(resolutionType)) {
    return options.fallback();
  }
  const headRef = normalizeReviewHeadRef(reviewAgent?.prHeadRef);
  const expectedHeadSha = normalizeExpectedSha(reviewAgent?.prHeadSha);
  if (!headRef || !expectedHeadSha) {
    throw new Error(`${resolutionType} job ${options.jobId} is missing a valid prHeadRef/prHeadSha publication lease; refusing to start from a generic base.`);
  }
  const remoteRef = `origin/${headRef}`;
  const fetch2 = await options.git([
    "fetch",
    "origin",
    `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
    "--quiet"
  ]);
  if (!fetch2.ok) {
    const detail = [fetch2.stderr, fetch2.stdout].filter(Boolean).join(`
`).trim();
    throw new Error(`${resolutionType} job ${options.jobId} could not refresh ${remoteRef}${detail ? `: ${detail}` : ""}.`);
  }
  const verify = await options.git(["rev-parse", "--verify", `${remoteRef}^{commit}`]);
  const actualHeadSha = verify.ok ? String(verify.stdout ?? "").trim().toLowerCase() : "";
  if (!actualHeadSha) {
    throw new Error(`${resolutionType} job ${options.jobId} could not verify ${remoteRef}.`);
  }
  if (actualHeadSha !== expectedHeadSha) {
    throw new Error(`${resolutionType} job ${options.jobId} has a stale PR-head lease: expected ${expectedHeadSha}, but ${remoteRef} is ${actualHeadSha}. Requeue from the current PR head.`);
  }
  if (resolutionType === "merge_conflict" || resolutionType === "integration_reconcile") {
    const baseRef = normalizeReviewHeadRef(reviewAgent?.prBaseRef);
    const expectedBaseSha = normalizeExpectedSha(reviewAgent?.prBaseSha);
    if (!baseRef || !expectedBaseSha) {
      throw new Error(`merge_conflict job ${options.jobId} is missing a valid prBaseRef/prBaseSha lease; refusing host-side rebase preparation.`);
    }
    const baseRemoteRef = `origin/${baseRef}`;
    const fetchBase = await options.git([
      "fetch",
      "origin",
      `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      "--quiet"
    ]);
    if (!fetchBase.ok) {
      const detail = [fetchBase.stderr, fetchBase.stdout].filter(Boolean).join(`
`).trim();
      throw new Error(`merge_conflict job ${options.jobId} could not refresh ${baseRemoteRef}${detail ? `: ${detail}` : ""}.`);
    }
    const verifyBase = await options.git(["rev-parse", "--verify", `${baseRemoteRef}^{commit}`]);
    const actualBaseSha = verifyBase.ok ? String(verifyBase.stdout ?? "").trim().toLowerCase() : "";
    if (actualBaseSha !== expectedBaseSha) {
      if (!normalizeExpectedSha(actualBaseSha)) {
        throw new Error(`${resolutionType} job ${options.jobId} could not refresh its stale base lease: expected ${expectedBaseSha}, but ${baseRemoteRef} is unavailable.`);
      }
      reviewAgent.prBaseSha = actualBaseSha;
      reviewAgent.prBaseLeaseRefreshedFrom = expectedBaseSha;
      reviewAgent.prBaseLeaseRefreshedAt = new Date().toISOString();
      const existingGuidance = typeof options.params.plannerWorkerInstruction === "string" ? options.params.plannerWorkerInstruction.trim() : "";
      options.params.plannerWorkerInstruction = [
        existingGuidance,
        `Host lease refresh: ${baseRemoteRef} advanced from ${expectedBaseSha} to ${actualBaseSha} before execution. The host updated this job to the current exact base before preparing any worker checkout.`
      ].filter(Boolean).join(`

`);
      options.log?.("warn", `${resolutionType} job ${options.jobId}: refreshed stale base lease for ${baseRemoteRef} from ${expectedBaseSha} to ${actualBaseSha} before execution.`);
    }
    options.log?.("info", `${resolutionType} job ${options.jobId}: host verified ${baseRemoteRef} at exact base ${actualBaseSha}.`);
  }
  options.log?.("info", `${resolutionType} job ${options.jobId}: host verified ${remoteRef} at exact PR head ${actualHeadSha}.`);
  return actualHeadSha;
}
function normalizeRequestedRef(value) {
  return value.trim() || "HEAD";
}
function remoteRef(remote, branch) {
  return `${remote}/${branch}`;
}
function isIntegrationBaseRequest(ref, integrationBranch, remote) {
  const normalized = normalizeRequestedRef(ref);
  const branch = normalizeBranchName2(normalized);
  return branch === integrationBranch || normalized === remoteRef(remote, integrationBranch) || normalized === `refs/remotes/${remote}/${integrationBranch}`;
}
async function fetchRemoteBranch(git3, remote, branch) {
  if (!remote || !branch || branch === "HEAD")
    return { ok: true };
  return git3(["fetch", remote, branch, "--quiet"]);
}
async function refExists(git3, ref) {
  const result = await git3(["rev-parse", "--verify", "--quiet", ref]);
  return result.ok;
}
async function isAncestor(git3, ancestorRef, descendantRef) {
  const result = await git3(["merge-base", "--is-ancestor", ancestorRef, descendantRef]);
  return result.ok;
}
async function resolveExistingWorktreeBaseRef(options) {
  const remote = (options.remote ?? "origin").trim() || "origin";
  const requestedRef = normalizeRequestedRef(options.requestedRef);
  const integrationBranch = normalizeBranchName2(options.integrationBranch) || "main_agents";
  const integrationRemoteRef = remoteRef(remote, integrationBranch);
  const candidates = new Set([
    requestedRef,
    integrationRemoteRef,
    integrationBranch,
    "HEAD"
  ]);
  if (requestedRef.startsWith(`${remote}/`)) {
    const branch = requestedRef.slice(`${remote}/`.length);
    await fetchRemoteBranch(options.git, remote, branch);
    candidates.add(branch);
  } else if (requestedRef !== "HEAD") {
    candidates.add(remoteRef(remote, requestedRef));
  }
  for (const ref of candidates) {
    if (await refExists(options.git, ref))
      return ref;
  }
  return "HEAD";
}
async function resolveFreshWorktreeBaseRef(options) {
  const remote = (options.remote ?? "origin").trim() || "origin";
  const requestedRef = normalizeRequestedRef(options.requestedRef);
  const integrationBranch = normalizeBranchName2(options.integrationBranch) || "main_agents";
  const sourceBaseBranch = normalizeBranchName2(options.sourceBaseBranch) || "main";
  const resolvedRef = await resolveExistingWorktreeBaseRef({
    requestedRef,
    integrationBranch,
    remote,
    git: options.git
  });
  if (!sourceBaseBranch || sourceBaseBranch === integrationBranch || !isIntegrationBaseRequest(requestedRef, integrationBranch, remote)) {
    return resolvedRef;
  }
  const sourceBaseRef = remoteRef(remote, sourceBaseBranch);
  const fetchSource = await fetchRemoteBranch(options.git, remote, sourceBaseBranch);
  if (!fetchSource.ok) {
    options.log?.("warn", `Could not refresh ${sourceBaseRef}; checking local ref before keeping ${resolvedRef} (${fetchSource.stderr || fetchSource.stdout || "fetch failed"}).`);
  }
  if (!await refExists(options.git, sourceBaseRef))
    return resolvedRef;
  if (resolvedRef !== "HEAD" && await refExists(options.git, resolvedRef)) {
    const sourceAlreadyIncluded = await isAncestor(options.git, sourceBaseRef, resolvedRef);
    if (sourceAlreadyIncluded)
      return resolvedRef;
    const integrationIsOnlyBehind = await isAncestor(options.git, resolvedRef, sourceBaseRef);
    if (!integrationIsOnlyBehind) {
      options.log?.("warn", `Worktree base ${resolvedRef} has diverged from ${sourceBaseRef}; preserving the integration head while SourceControlManager reconciles it so new jobs retain integrated context.`);
      return resolvedRef;
    }
  }
  options.log?.("warn", `Worktree base ${resolvedRef} is behind ${sourceBaseRef}; using ${sourceBaseRef} for new WorkerPal jobs until SourceControlManager fast-forwards the integration branch.`);
  return sourceBaseRef;
}

// apps/workerpals/src/docker_executor.ts
var DEFAULT_OPENHANDS_MODEL = "local-model";
var DEFAULT_CONFIG4 = loadPushPalsConfig();
var SHARED_CONTAINER_VENV_PYTHON = "/workspace/.venv/bin/python";
var WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
var WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
var WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID = "pushpals_extra_ca";
var WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH = "/run/pushpals/host-extra-ca.pem";
var WORKERPAL_SANDBOX_MERGED_CA_PATH = "/run/pushpals/ca-bundle.pem";
var WORKERPAL_SANDBOX_SYSTEM_CA_PATH = "/etc/ssl/certs/ca-certificates.crt";
var DOCKER_IMAGE_INSPECT_TIMEOUT_MS = 15000;
var DOCKER_IMAGE_BUILD_TIMEOUT_MS = 10 * 60000;
var DOCKER_IMAGE_PULL_TIMEOUT_MS = 10 * 60000;
var BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS = 3;
var BROWSER_VALIDATION_JOB_OVERHEAD_MS = 5 * 60000;
var BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS = 20 * 60000;
var BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS = 45 * 60000;
function parseClampedInt(value, defaultValue, min, max) {
  const parsed = typeof value === "number" ? Math.floor(value) : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0)
    return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}
function parseClampedIntAllowZero(value, defaultValue, max) {
  const parsed = typeof value === "number" ? Math.floor(value) : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0)
    return defaultValue;
  return Math.max(0, Math.min(max, parsed));
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function buildWorktreeDependencyPreparationCommand(containerWorktreePath) {
  const worktree = shellSingleQuote(containerWorktreePath);
  const worktreePrefix = shellSingleQuote(`${containerWorktreePath}/`);
  return [
    "set -eu",
    `worktree=${worktree}`,
    'linked=""',
    'if [ -f "$worktree/package.json" ] && { [ -f "$worktree/bun.lock" ] || [ -f "$worktree/bun.lockb" ]; }; then',
    '  dependency_cache_root="/workspace/.pushpals-dependencies/linux-$(uname -m)"',
    '  mkdir -p "$dependency_cache_root"',
    `  snapshot_key="$( { printf 'bun=%s\\n' "$(bun --version)"; for manifest in "$worktree/package.json" "$worktree/bun.lock" "$worktree/bun.lockb"; do [ ! -f "$manifest" ] || sha256sum "$manifest"; done; } | sha256sum | cut -d " " -f 1)"`,
    `  if jq -e '.workspaces != null' "$worktree/package.json" >/dev/null 2>&1; then`,
    '    snapshot_key="$snapshot_key-${worktree##*/}"',
    "  fi",
    '  snapshot_root="$dependency_cache_root/$snapshot_key"',
    '  snapshot_ready="$snapshot_root/.pushpals-dependency-ready"',
    '  snapshot_lock="$snapshot_root.lock"',
    "  wait_count=0",
    '  while [ ! -f "$snapshot_ready" ]; do',
    '    if mkdir "$snapshot_lock" 2>/dev/null; then',
    '      cleanup_dependency_install() { rm -rf "$worktree/node_modules"; rm -rf "$snapshot_root"; rmdir "$snapshot_lock" 2>/dev/null || true; }',
    "      trap cleanup_dependency_install EXIT INT TERM",
    '      rm -rf "$snapshot_root"',
    '      mkdir -p "$snapshot_root/node_modules"',
    '      rm -rf "$worktree/node_modules"',
    '      ln -s "$snapshot_root/node_modules" "$worktree/node_modules"',
    '      (cd "$worktree" && bun install --frozen-lockfile --ignore-scripts >&2)',
    '      rm -f "$worktree/node_modules"',
    `      printf '%s\\n' "$snapshot_key" > "$snapshot_ready"`,
    '      rmdir "$snapshot_lock"',
    "      trap - EXIT INT TERM",
    "    else",
    "      wait_count=$((wait_count + 1))",
    '      if [ "$wait_count" -ge 600 ]; then',
    `        printf 'Timed out waiting for Linux-native dependency snapshot lock: %s\\n' "$snapshot_lock" >&2`,
    "        exit 1",
    "      fi",
    "      sleep 1",
    "    fi",
    "  done",
    '  src="$snapshot_root/node_modules"',
    `  dest=${worktreePrefix}node_modules`,
    '  rm -rf "$dest"',
    '  mkdir -p "$dest"',
    '  : > "$dest/.pushpals-dependency-projection-in-progress"',
    '  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do',
    '    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '    entry_name="${entry##*/}"',
    '    case "$entry_name" in',
    "      .cache|.expo|.vite|.vite-temp|.pushpals-dependency-snapshot|.pushpals-dependency-ready|.pushpals-dependency-projection-in-progress) continue ;;",
    "    esac",
    '    ln -s "$entry" "$dest/$entry_name"',
    "  done",
    "  for mutable in .cache .expo .vite .vite-temp; do",
    '    mkdir -p "$dest/$mutable"',
    "  done",
    '  rm -f "$dest/.pushpals-dependency-projection-in-progress"',
    `  printf '%s\\n' "$snapshot_key" > "$dest/.pushpals-dependency-snapshot"`,
    '  linked="$linked node_modules-linux-native"',
    "else",
    "  for name in node_modules; do",
    '    src="/repo/$name"',
    `    dest=${worktreePrefix}$name`,
    '    if { [ -e "$src" ] || [ -L "$src" ]; } && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then',
    '      snapshot_key="$(for manifest in /repo/package.json /repo/bun.lock /repo/bun.lockb; do [ ! -f "$manifest" ] || sha256sum "$manifest"; done | sha256sum | cut -d " " -f 1)"',
    '      mkdir -p "$dest"',
    '      : > "$dest/.pushpals-dependency-projection-in-progress"',
    "      projection_ok=1",
    '      for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do',
    '        if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '        entry_name="${entry##*/}"',
    '        case "$entry_name" in',
    "          .cache|.expo|.vite|.vite-temp|.pushpals-dependency-snapshot|.pushpals-dependency-projection-in-progress) continue ;;",
    "        esac",
    '        if ! ln -s "$entry" "$dest/$entry_name"; then projection_ok=0; break; fi',
    "      done",
    '      if [ "$projection_ok" = "1" ]; then',
    "        for mutable in .cache .expo .vite .vite-temp; do",
    '          mkdir -p "$dest/$mutable"',
    "        done",
    '        rm -f "$dest/.pushpals-dependency-projection-in-progress"',
    '        rm -f "$dest/.pushpals-dependency-snapshot"',
    `        printf '%s\\n' "$snapshot_key" > "$dest/.pushpals-dependency-snapshot"`,
    '        linked="$linked $name-host-fallback"',
    "      else",
    '        rm -rf "$dest"',
    '        ln -s "$src" "$dest"',
    '        linked="$linked $name-host-fallback-link"',
    "      fi",
    "    fi",
    "  done",
    "fi",
    `printf '%s' "$linked"`
  ].join(`
`);
}
function resolveDockerExecutable() {
  const absolute = String(process.env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "").trim();
  if (absolute)
    return absolute;
  const configured = String(process.env.PUSHPALS_DOCKER_BIN ?? "").trim();
  if (configured)
    return configured;
  return process.platform === "win32" ? "docker.exe" : "docker";
}
function resolveWorkerpalDockerBuildCaSecretArgs(env = process.env, fileExists = existsSync10) {
  const configured = String(env.PUSHPALS_DOCKER_BUILD_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS ?? "").trim();
  if (!configured)
    return [];
  const path = resolve11(configured);
  if (!fileExists(path))
    return [];
  return ["--secret", `id=${WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID},src=${path}`];
}
function resolveWorkerpalDockerRuntimeCaArgs(env = process.env, fileExists = existsSync10, dockerHostPath = (path) => path) {
  const configured = String(env.PUSHPALS_DOCKER_RUNTIME_EXTRA_CA_CERTS ?? env.PUSHPALS_DOCKER_BUILD_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS ?? "").trim();
  if (!configured)
    return [];
  const path = resolve11(configured);
  if (!fileExists(path))
    return [];
  return [
    "--mount",
    `type=bind,src=${dockerHostPath(path)},dst=${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH},readonly`,
    "-e",
    `NODE_EXTRA_CA_CERTS=${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH}`,
    "-e",
    `SSL_CERT_FILE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `GIT_SSL_CAINFO=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `REQUESTS_CA_BUNDLE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `CURL_CA_BUNDLE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `PIP_CERT=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`
  ];
}
function prependWorkerpalRuntimeCaStartup(startupCommand, runtimeCaEnabled) {
  if (!runtimeCaEnabled)
    return startupCommand;
  return [
    "set -eu",
    "mkdir -p /run/pushpals",
    `cat ${WORKERPAL_SANDBOX_SYSTEM_CA_PATH} ${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH} > ${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    `chmod 0444 ${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    startupCommand
  ].join("; ");
}
function resolveWorkerpalSandboxBuildContext(repoRoot) {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT ?? "").trim();
  const sandboxRoot = configuredRoot || repoRoot;
  const dockerfilePath = configuredRoot ? resolve11(sandboxRoot, "apps", "workerpals", "Dockerfile.sandbox") : resolve11(repoRoot, "apps", "workerpals", "Dockerfile.sandbox");
  return {
    root: sandboxRoot,
    dockerfilePath
  };
}
function resolveWorkerpalRuntimeTag() {
  return String(process.env.PUSHPALS_RUNTIME_TAG ?? "").trim();
}
function dockerBuildFileArg(root, dockerfilePath) {
  const relativePath = relative(root, dockerfilePath).replace(/\\/g, "/").trim();
  return relativePath || "apps/workerpals/Dockerfile.sandbox";
}
function isMissingDockerImageDetail(detail) {
  const text = String(detail ?? "");
  return /\b(no such object|no such image|not found)\b/i.test(text) || /\bunable to find image\b.*\blocally\b/i.test(text) || /\bpull access denied\b.*\brepository does not exist\b/i.test(text);
}
function normalizePathForMatching(path) {
  return path.replace(/\\/g, "/").toLowerCase();
}
function isEphemeralWorkerWorktreePath(path) {
  const normalized = normalizePathForMatching(path);
  const marker = "/.worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0)
    return false;
  const leaf = normalized.slice(markerIndex + marker.length);
  return leaf.startsWith("job-") || leaf.startsWith("selfcheck-");
}
function parseGitWorktreeListPorcelain(output) {
  const blocks = output.split(/\r?\n\r?\n/g).map((block) => block.trim()).filter(Boolean);
  const records = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/g).map((line) => line.trim());
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine)
      continue;
    records.push({
      path: pathLine.slice("worktree ".length).trim(),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable "))
    });
  }
  return records;
}
function collectPrunableEphemeralWorktrees(output) {
  return parseGitWorktreeListPorcelain(output).filter((entry) => entry.prunable && isEphemeralWorkerWorktreePath(entry.path)).map((entry) => entry.path);
}
function buildLinuxWorktreeAddArgs(worktreePath, baseRef, force = false) {
  return [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "worktree",
    "add",
    ...force ? ["--force"] : [],
    "--detach",
    worktreePath,
    baseRef
  ];
}

class DockerExecutionExhaustedError extends Error {
  cooldownMs;
  category;
  constructor(category, message, cooldownMs) {
    super(message);
    this.name = "DockerExecutionExhaustedError";
    this.category = category;
    this.cooldownMs = Math.max(0, Math.floor(cooldownMs));
  }
}
function compactDockerDiagnosticText(value, maxChars = 1000) {
  const text = String(value ?? "").replace(/\s+$/g, "").trim();
  if (!text)
    return null;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
function dockerFallbackDiagnostics(summary, context, exitCode, failureClass, metadata = {}) {
  return {
    terminal: {
      failureClass,
      terminalStage: "docker",
      summary: compactDockerDiagnosticText(summary),
      watchdogFired: context.timedOutByDocker,
      timeoutMs: context.timeoutMs,
      metadata: {
        structuredResult: false,
        elapsedMs: context.elapsedMs,
        exitCode,
        timedOutByDocker: context.timedOutByDocker,
        ...metadata
      }
    }
  };
}
function readPositiveNumber(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0)
    return null;
  return Math.floor(parsed);
}
function maybeRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isReadableByteStream(value) {
  return value instanceof ReadableStream;
}
function collectValidationCommandHints(params) {
  const planning = maybeRecord(params.planning);
  const values = [
    params.instruction,
    params.plannerWorkerInstruction,
    params.validationSteps,
    params.requiredValidationSteps,
    planning?.validationSteps,
    planning?.requiredValidationSteps
  ];
  const commands = [];
  for (const value of values) {
    if (typeof value === "string") {
      commands.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      commands.push(...value.filter((entry) => typeof entry === "string"));
    }
  }
  return commands;
}
function hasBrowserValidationCommand(job) {
  if (job.kind !== "task.execute")
    return false;
  return collectValidationCommandHints(job.params).some((command) => /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke|playwright|cypress)\b/i.test(command));
}
function resolveDockerJobTimeoutMs(configuredTimeoutMs, job) {
  const baseTimeoutMs = Math.max(1e4, Math.floor(configuredTimeoutMs));
  if (!hasBrowserValidationCommand(job))
    return baseTimeoutMs;
  const planning = maybeRecord(job.params.planning);
  const executionBudgetMs = readPositiveNumber(planning?.executionBudgetMs) ?? 1200000;
  const finalizationBudgetMs = readPositiveNumber(planning?.finalizationBudgetMs) ?? 120000;
  const attempts = BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS + 1;
  const estimatedTimeoutMs = attempts * (executionBudgetMs + finalizationBudgetMs + BROWSER_VALIDATION_JOB_OVERHEAD_MS);
  const boundedTimeoutMs = Math.min(BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS, Math.max(BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS, estimatedTimeoutMs));
  return Math.max(Math.min(baseTimeoutMs, boundedTimeoutMs), BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS);
}

class DockerExecutor {
  options;
  worktreeDir;
  warmContainerName;
  warmAgentPort = 39231;
  idleTimer = null;
  activeJobs = 0;
  warmAgentStartupTimeoutMs;
  warmAgentStartupPollMs = 200;
  warmSetupMaxAttempts;
  warmSetupBackoffMs;
  jobRetryMaxAttempts;
  jobRetryBackoffMs;
  failureCooldownMs;
  worktreeVisibilityTimeoutMs;
  lastLoggedExecutionConfig = "";
  lastLoggedEndpointRewrite = "";
  warmedBackends = new Set;
  preparedMergeConflictJobs = new Set;
  mergeConflictRefreshPromise = null;
  config;
  constructor(options) {
    const { config: config2, ...optionValues } = options;
    this.config = config2 ?? DEFAULT_CONFIG4;
    const startupTimeoutMs = parseClampedInt(this.config.workerpals.dockerAgentStartupTimeoutMs, 45000, 1e4, 180000);
    this.options = {
      gitToken: "",
      timeoutMs: DEFAULT_DOCKER_TIMEOUT_MS,
      idleTimeoutMs: 10 * 60 * 1000,
      baseRef: "HEAD",
      networkMode: "bridge",
      ...optionValues
    };
    this.worktreeDir = resolve11(this.options.repo, ".worktrees");
    this.warmContainerName = `pushpals-${this.options.workerId}-warm`;
    this.warmAgentStartupTimeoutMs = startupTimeoutMs;
    this.warmSetupMaxAttempts = parseClampedInt(this.config.workerpals.dockerWarmMaxAttempts, 3, 1, 5);
    this.warmSetupBackoffMs = parseClampedInt(this.config.workerpals.dockerWarmRetryBackoffMs, 2000, 250, 60000);
    this.jobRetryMaxAttempts = parseClampedInt(this.config.workerpals.dockerJobMaxAttempts, 2, 1, 3);
    this.jobRetryBackoffMs = parseClampedInt(this.config.workerpals.dockerJobRetryBackoffMs, 3000, 250, 60000);
    this.failureCooldownMs = parseClampedIntAllowZero(this.config.workerpals.failureCooldownMs, 20000, 300000);
    this.worktreeVisibilityTimeoutMs = process.platform === "win32" ? 15000 : 5000;
    try {
      mkdirSync4(this.worktreeDir, { recursive: true });
    } catch {}
  }
  async execute(job, onLog) {
    this.activeJobs += 1;
    this.clearIdleTimer();
    const worktreeName = this.buildEphemeralWorktreeName("job", job.id);
    const worktreePath = resolve11(this.worktreeDir, worktreeName);
    try {
      const worktreeBaseRef = await this.resolveWorktreeBaseRefForJob(job, onLog);
      await this.createWorktree(worktreePath, worktreeBaseRef);
      let effectiveJob = job;
      if (isReviewResolutionParams(job.params)) {
        let effectiveParams = job.params;
        if (isMergeConflictResolutionParams(job.params)) {
          const prepared = await prepareMergeConflictWorktreeOnHost(worktreePath, job.id, job.params, onLog);
          effectiveParams = applyMergeConflictExecutionHints(effectiveParams, prepared);
        }
        effectiveJob = {
          ...job,
          params: markHostScmGitOwnership(effectiveParams)
        };
      }
      for (let attempt = 1;attempt <= this.jobRetryMaxAttempts; attempt++) {
        const attemptStartedAtMs = Date.now();
        try {
          this.logExecutionConfig();
          const result = isHostScmOwnedReviewParams(effectiveJob.params) ? await this.runHostScmOwnedReviewJob(worktreePath, effectiveJob, onLog) : await this.runInWarmContainer(worktreePath, this.encodeJobSpec(effectiveJob), effectiveJob, onLog);
          if (result.ok)
            return result;
          const retryableFailure = this.isRetryableJobFailure(result);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry = retryableFailure && attempt < this.jobRetryMaxAttempts && this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableFailure || !hasBudgetForRetry) {
            if (retryableFailure && attempt >= this.jobRetryMaxAttempts && this.retryExhaustionCooldownMs(result) > 0) {
              return {
                ...result,
                cooldownMs: this.retryExhaustionCooldownMs(result)
              };
            }
            return result;
          }
          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient job failure detected for ${job.id}; retrying attempt ${attempt + 1}/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          await this.stopWarmContainer("job retry after transient failure", true);
          await this.sleep(retryInMs);
        } catch (err) {
          const retryableError = this.isRetryableError(err);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry = retryableError && attempt < this.jobRetryMaxAttempts && this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableError || !hasBudgetForRetry) {
            if (retryableError && attempt >= this.jobRetryMaxAttempts && !(err instanceof DockerExecutionExhaustedError)) {
              throw new DockerExecutionExhaustedError("job_execution", `Docker execution retries exhausted after ${this.jobRetryMaxAttempts} attempts: ${this.compactError(err)}`, this.failureCooldownMs);
            }
            throw err;
          }
          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient Docker execution error for ${job.id}: ${this.compactError(err)}. Retrying attempt ${attempt + 1}/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          await this.stopWarmContainer("job retry after execution error", true);
          await this.sleep(retryInMs);
        }
      }
      return {
        ok: false,
        summary: "Docker job retries exhausted",
        stderr: `Retries exhausted after ${this.jobRetryMaxAttempts} attempts`
      };
    } finally {
      this.preparedMergeConflictJobs.delete(job.id);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      await this.removeWorktree(worktreePath).catch((err) => {
        console.error(`[DockerExecutor] Failed to remove worktree: ${err}`);
      });
      this.scheduleIdleShutdown();
    }
  }
  async validateWorktreeGitInterop() {
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "startup");
    const worktreePath = resolve11(this.worktreeDir, worktreeName);
    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath);
      await this.ensureWorktreeAccessibleInWarmContainer(worktreePath);
      console.log(`[DockerExecutor] Startup self-check passed (git/worktree in container and warm container).`);
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {});
    }
  }
  async validateLinuxContainerWorktreeBoundary(assertLfPath) {
    const normalizedPath = String(assertLfPath ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!normalizedPath || normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.split("/").includes("..") || /[\r\n\0]/.test(normalizedPath)) {
      throw new Error(`Invalid LF boundary assertion path: ${assertLfPath}`);
    }
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "windows-linux-lf");
    const worktreePath = resolve11(this.worktreeDir, worktreeName);
    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath, normalizedPath);
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {});
    }
  }
  async createWorktree(worktreePath, baseRef) {
    await this.ensureFreshWorktreePath(worktreePath);
    let proc = Bun.spawn(["git", ...buildLinuxWorktreeAddArgs(worktreePath, baseRef)], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    let exitCode = await proc.exited;
    let stdout = await new Response(proc.stdout).text();
    let stderr = await new Response(proc.stderr).text();
    let detail = [stderr, stdout].filter(Boolean).join(`
`).trim();
    if (exitCode !== 0 && /already registered worktree/i.test(detail)) {
      const prune = Bun.spawn(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe"
      });
      await prune.exited;
      proc = Bun.spawn(["git", ...buildLinuxWorktreeAddArgs(worktreePath, baseRef, true)], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe"
      });
      exitCode = await proc.exited;
      stdout = await new Response(proc.stdout).text();
      stderr = await new Response(proc.stderr).text();
      detail = [stderr, stdout].filter(Boolean).join(`
`).trim();
    }
    if (exitCode !== 0) {
      throw new Error(`Failed to create worktree from ${baseRef}: ${detail}`);
    }
    const enableWorktreeConfig = await this.runGitBaseRefCommand([
      "config",
      "extensions.worktreeConfig",
      "true"
    ]);
    if (!enableWorktreeConfig.ok) {
      throw new Error(`Failed to enable worktree-local Git configuration: ${enableWorktreeConfig.stderr || enableWorktreeConfig.stdout}`);
    }
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.eol", "lf"]
    ]) {
      const configured = await this.runGitBaseRefCommand([
        "-C",
        worktreePath,
        "config",
        "--worktree",
        key,
        value
      ]);
      if (!configured.ok) {
        throw new Error(`Failed to configure ${key}=${value} for Linux worktree: ${configured.stderr || configured.stdout}`);
      }
    }
    this.rewriteWorktreeGitdirToRelative(worktreePath);
    console.log(`[DockerExecutor] Created worktree: ${worktreePath}`);
  }
  rewriteWorktreeGitdirToRelative(worktreePath) {
    try {
      const gitFilePath = resolve11(worktreePath, ".git");
      const raw = readFileSync9(gitFilePath, "utf-8").trim();
      const match = raw.match(/^gitdir:\s*(.+)$/i);
      if (!match)
        return;
      const gitdirRaw = match[1].trim();
      const hasWindowsDrive = /^[a-zA-Z]:[\\/]/.test(gitdirRaw);
      if (!hasWindowsDrive && !isAbsolute3(gitdirRaw)) {
        return;
      }
      const rel = relative(worktreePath, gitdirRaw).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") === false) {
        return;
      }
      writeFileSync5(gitFilePath, `gitdir: ${rel}
`, "utf-8");
    } catch {}
  }
  async removeWorktree(worktreePath) {
    const proc = Bun.spawn(["git", "worktree", "remove", "--force", "--force", worktreePath], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) {
      console.warn(`[DockerExecutor] Worktree removal warning: ${stderr || stdout}`);
    }
    const prune = Bun.spawn(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    const pruneExit = await prune.exited;
    if (pruneExit !== 0) {
      const pruneStderr = await new Response(prune.stderr).text();
      console.warn(`[DockerExecutor] Worktree prune warning: ${pruneStderr}`);
    }
    const forced = await forceDeleteWorktreePath(worktreePath, {
      sleepFn: (ms) => this.sleep(ms)
    });
    if (!forced.removed) {
      throw new Error(`worktree path persisted after cleanup (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`);
    }
    console.log(`[DockerExecutor] Removed worktree: ${worktreePath}`);
  }
  containerBackendPython(backend, runtimeConfig = this.backendRuntimeConfig()) {
    const spec = getDockerBackendSpec(backend);
    const configured = spec.configuredPython(runtimeConfig);
    return spec.normalizeContainerPython(configured, SHARED_CONTAINER_VENV_PYTHON);
  }
  backendRuntimeConfig() {
    const workerCfg = this.config.workerpals;
    const runtimeConfig = {};
    for (const backend of DOCKER_BACKENDS) {
      const keys = BACKEND_RUNTIME_CONFIG_KEYS[backend.name] ?? {
        pythonKey: `${backend.name}Python`,
        timeoutKey: `${backend.name}TimeoutMs`
      };
      const python = String(workerCfg[keys.pythonKey] ?? "python").trim() || "python";
      const timeoutRaw = Number(workerCfg[keys.timeoutKey]);
      const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(1e4, Math.floor(timeoutRaw)) : 300000;
      runtimeConfig[backend.name] = { python, timeoutMs };
    }
    return runtimeConfig;
  }
  currentBackend() {
    return resolveExecutor(this.config);
  }
  currentBackendSpec() {
    return getDockerBackendSpec(this.currentBackend());
  }
  warmStartupContext() {
    const { attempts, sleepSeconds } = this.warmAgentStartupLoop();
    return {
      sharedVenvPython: SHARED_CONTAINER_VENV_PYTHON,
      warmAgentPort: this.warmAgentPort,
      startupAttempts: attempts,
      sleepSeconds
    };
  }
  collectContainerEnv() {
    const containerLlmEndpoint = this.workerLlmEndpointForContainer();
    const runtimeConfig = this.backendRuntimeConfig();
    const fixedEnv = {
      WORKERPALS_EXECUTOR: this.config.workerpals.executor,
      WORKERPALS_LLM_MODEL: this.config.workerpals.llm.model,
      WORKERPALS_LLM_ENDPOINT: containerLlmEndpoint,
      WORKERPALS_LLM_BACKEND: this.config.workerpals.llm.backend,
      WORKERPALS_LLM_SESSION_ID: this.config.workerpals.llm.sessionId,
      PUSHPALS_PROJECT_ROOT_OVERRIDE: "/repo",
      PUSHPALS_REPO_ROOT_OVERRIDE: "/repo",
      PUSHPALS_CONFIG_DIR_OVERRIDE: "/workspace/configs",
      PUSHPALS_PROMPTS_ROOT_OVERRIDE: "/workspace",
      PUSHPALS_PROTOCOL_SCHEMAS_DIR: "/workspace/protocol/schemas"
    };
    for (const backend of DOCKER_BACKENDS) {
      const name = backend.name.toUpperCase();
      fixedEnv[`WORKERPALS_${name}_PYTHON`] = this.containerBackendPython(backend.name, runtimeConfig);
      fixedEnv[`WORKERPALS_${name}_TIMEOUT_MS`] = String(backend.timeoutMs(runtimeConfig));
    }
    if (this.config.workerpals.llm.apiKey.trim()) {
      fixedEnv.WORKERPALS_LLM_API_KEY = this.config.workerpals.llm.apiKey;
    }
    const allowlist = new Set(SHARED_DOCKER_PASSTHROUGH_ENV);
    for (const backend of DOCKER_BACKENDS) {
      const names = BACKEND_DOCKER_PASSTHROUGH_ENV[backend.name] ?? [];
      for (const name of names)
        allowlist.add(name);
    }
    const pairs = [];
    for (const [key, value] of Object.entries(fixedEnv)) {
      if (!value)
        continue;
      pairs.push("-e", `${key}=${value}`);
    }
    for (const key of allowlist) {
      const value = process.env[key];
      if (!value)
        continue;
      pairs.push("-e", `${key}=${value}`);
    }
    return pairs;
  }
  clearIdleTimer() {
    if (!this.idleTimer)
      return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  warmAgentStartupLoop() {
    const attempts = Math.max(1, Math.ceil(this.warmAgentStartupTimeoutMs / this.warmAgentStartupPollMs));
    const sleepSeconds = String(this.warmAgentStartupPollMs / 1000);
    return { attempts, sleepSeconds };
  }
  scheduleIdleShutdown() {
    if (this.options.idleTimeoutMs <= 0)
      return;
    if (this.activeJobs > 0)
      return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.activeJobs > 0)
        return;
      this.stopWarmContainer("idle timeout");
    }, this.options.idleTimeoutMs);
  }
  async startWarmContainer() {
    await this.stopWarmContainer("pre-start cleanup", true);
    const backend = this.currentBackend();
    const backendSpec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const envArgs = this.collectContainerEnv();
    const authMountArgs = this.openaiCodexAuthMountArgs(backend);
    const runtimeCaArgs = resolveWorkerpalDockerRuntimeCaArgs(process.env, existsSync10, (path) => this.toDockerPath(path));
    const args = [
      "run",
      "-d",
      "--name",
      this.warmContainerName,
      "--label",
      "pushpals.component=workerpals-warm",
      "--label",
      `pushpals.repo=${this.options.repo}`,
      "--label",
      `pushpals.worker_id=${this.options.workerId}`,
      "--memory",
      `${this.config.workerpals.dockerWarmMemoryMb}m`,
      "--cpus",
      String(this.config.workerpals.dockerWarmCpus),
      "--network",
      this.options.networkMode,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${dockerRepoPath}:/repo`,
      "-w",
      "/workspace",
      ...envArgs,
      ...authMountArgs,
      ...runtimeCaArgs
    ];
    if (this.options.gitToken) {
      args.push("-e", `GIT_TOKEN=${this.options.gitToken}`);
    }
    const backendEnv = backendSpec.warmContainerEnv?.(warmContext) ?? {};
    for (const [key, value] of Object.entries(backendEnv)) {
      if (!value)
        continue;
      args.push("-e", `${key}=${value}`);
    }
    const startupCmd = prependWorkerpalRuntimeCaStartup(backendSpec.warmContainerStartupCommand(warmContext), runtimeCaArgs.length > 0);
    if (runtimeCaArgs.length > 0) {
      console.log("[DockerExecutor] Mounting host extra CA trust into the warm container (read-only).");
    }
    args.push("--entrypoint", "/bin/sh", this.options.imageName, "-lc", startupCmd);
    const proc = Bun.spawn([resolveDockerExecutable(), ...args], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    if (exitCode !== 0) {
      throw new Error(`Failed to start warm container (exit ${exitCode}): ${stderr.trim() || stdout.trim() || "no docker output"}`);
    }
    console.log(`[DockerExecutor] Warm container started: ${this.warmContainerName}`);
  }
  openaiCodexAuthMountArgs(backend) {
    if (backend !== "openai_codex")
      return [];
    const hostCodexHomeRaw = (process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME || "").trim();
    if (hostCodexHomeRaw && !isAbsolute3(hostCodexHomeRaw)) {
      console.warn(`[DockerExecutor] Ignoring relative PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME=${hostCodexHomeRaw}; using ${resolve11(homedir3(), ".codex")} so Codex state stays outside the repo worktree.`);
    }
    const hostCodexHome = (hostCodexHomeRaw && isAbsolute3(hostCodexHomeRaw) ? hostCodexHomeRaw : resolve11(homedir3(), ".codex")).trim();
    if (!hostCodexHome)
      return [];
    if (!existsSync10(hostCodexHome)) {
      try {
        mkdirSync4(hostCodexHome, { recursive: true });
      } catch (err) {
        console.warn(`[DockerExecutor] Failed to create Codex auth directory (${hostCodexHome}); skipping mount: ${this.compactError(err)}`);
        return [];
      }
    }
    let containerCodexHome = (process.env.PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME || "/root/.codex").trim();
    if (!containerCodexHome.startsWith("/")) {
      console.warn(`[DockerExecutor] Invalid PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME=${containerCodexHome}; expected absolute path. Using /root/.codex.`);
      containerCodexHome = "/root/.codex";
    }
    const dockerHostPath = this.toDockerPath(hostCodexHome);
    console.log(`[DockerExecutor] Mounting Codex auth directory for openai_codex: ${hostCodexHome} -> ${containerCodexHome}`);
    return [
      "-v",
      `${dockerHostPath}:${containerCodexHome}`,
      "-e",
      `CODEX_HOME=${containerCodexHome}`
    ];
  }
  async ensureWarmContainer() {
    const inspect = Bun.spawn([
      resolveDockerExecutable(),
      "inspect",
      "-f",
      "{{.State.Running}}|{{.HostConfig.NetworkMode}}",
      this.warmContainerName
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      inspect.exited,
      new Response(inspect.stdout).text()
    ]);
    if (exitCode === 0) {
      const [runningRaw, networkModeRaw] = stdout.trim().split("|");
      const running = runningRaw?.trim() === "true";
      const networkMode = (networkModeRaw ?? "").trim();
      if (running && networkMode === this.options.networkMode) {
        return;
      }
      if (running && networkMode && networkMode !== this.options.networkMode) {
        console.warn(`[DockerExecutor] Warm container network mismatch (${networkMode} != ${this.options.networkMode}); recreating...`);
      }
    }
    await this.startWarmContainer();
  }
  async runWarmShell(command) {
    const proc = Bun.spawn([resolveDockerExecutable(), "exec", this.warmContainerName, "/bin/sh", "-lc", command], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    };
  }
  async runWarmWorktreeProbe(containerWorktreePath) {
    const proc = Bun.spawn([
      resolveDockerExecutable(),
      "exec",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "/bin/sh",
      "-lc",
      "git rev-parse --is-inside-work-tree && git rev-parse --git-dir"
    ], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    };
  }
  async inspectWarmContainerState() {
    const proc = Bun.spawn([
      resolveDockerExecutable(),
      "inspect",
      "-f",
      "running={{.State.Running}} status={{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} oom={{.State.OOMKilled}}",
      this.warmContainerName
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join(`
`);
    return exitCode === 0 ? out || "no inspect output" : `docker inspect failed (exit ${exitCode})${out ? `
${out}` : ""}`;
  }
  async readWarmContainerLogs(tail = 160) {
    const proc = Bun.spawn([resolveDockerExecutable(), "logs", "--tail", String(tail), this.warmContainerName], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join(`
`);
    return exitCode === 0 ? out || "(no docker logs)" : `docker logs failed (exit ${exitCode})${out ? `
${out}` : ""}`;
  }
  workerLlmProbeUrls(endpoint) {
    const normalized = endpoint.trim().replace(/\/+$/, "");
    if (!normalized)
      return [];
    const probes = [];
    if (normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    } else if (normalized.endsWith("/v1")) {
      probes.push(`${normalized}/models`);
    } else if (/^https?:\/\/[^/]+$/i.test(normalized)) {
      probes.push(`${normalized}/v1/models`);
      probes.push(`${normalized}/models`);
    }
    if (probes.length === 0) {
      probes.push(normalized);
    }
    try {
      const parsed = new URL(normalized);
      probes.push(`${parsed.origin}/health`);
    } catch {}
    return Array.from(new Set(probes));
  }
  async probeWorkerLlmEndpoint() {
    const endpoint = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!endpoint)
      return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0)
      return `endpoint malformed: ${endpoint}`;
    let lastError = "unreachable";
    for (const probe of probes) {
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort("timeout"), 2500);
      try {
        const response = await fetch(probe, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json, text/plain, */*" }
        });
        if (response.status >= 200 && response.status < 500) {
          return `reachable via ${probe} (HTTP ${response.status})`;
        }
        lastError = `${probe}: HTTP ${response.status}`;
      } catch (err) {
        lastError = `${probe}: ${String(err)}`;
      } finally {
        clearTimeout(timeout);
      }
    }
    return `UNREACHABLE (${lastError})`;
  }
  workerLlmEndpointForContainer() {
    const raw = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!raw)
      return raw;
    try {
      const parsed = new URL(raw);
      const host = (parsed.hostname ?? "").trim().toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        return raw;
      }
      parsed.hostname = "host.docker.internal";
      return parsed.toString();
    } catch {
      return raw;
    }
  }
  async probeWorkerLlmEndpointFromContainer() {
    const endpoint = this.workerLlmEndpointForContainer();
    if (!endpoint)
      return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0)
      return `endpoint malformed: ${endpoint}`;
    let lastError = "unreachable";
    for (const probe of probes) {
      const cmd = `status="$(curl -sS -m 3 -o /dev/null -w "%{http_code}" ${shellSingleQuote(probe)} || true)"; ` + 'echo "$status"';
      const result = await this.runWarmShell(cmd);
      const status = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(status) && status >= 200 && status < 500) {
        return `reachable via ${probe} (HTTP ${status})`;
      }
      if (Number.isFinite(status) && status > 0) {
        lastError = `${probe}: HTTP ${status}`;
      } else {
        const detail = result.stderr ? ` (${result.stderr})` : "";
        lastError = `${probe}: exit ${result.exitCode}${detail}`;
      }
    }
    return `UNREACHABLE (${lastError})`;
  }
  async collectWarmRuntimeDiagnostics(backend) {
    const spec = getDockerBackendSpec(backend);
    const runtimeConfig = this.backendRuntimeConfig();
    const sections = [];
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const endpoint = this.config.workerpals.llm.endpoint.trim() || "(unset)";
    const configuredPython = spec.configuredPython(runtimeConfig).trim() || "(unset)";
    const containerPython = this.containerBackendPython(backend, runtimeConfig);
    const containerEndpoint = this.workerLlmEndpointForContainer();
    sections.push(`[backend] ${backend}`);
    sections.push(`[llm-config] model=${model} provider=${provider} endpoint=${endpoint}`);
    sections.push(`[python-config] configured=${configuredPython} resolved_container_python=${containerPython}`);
    if (endpoint && containerEndpoint && endpoint !== containerEndpoint) {
      sections.push(`[llm-endpoint-rewrite] ${endpoint} -> ${containerEndpoint}`);
    }
    sections.push(`[llm-probe-host] ${await this.probeWorkerLlmEndpoint()}`);
    sections.push(`[llm-probe-container] ${await this.probeWorkerLlmEndpointFromContainer()}`);
    sections.push(`[container] ${await this.inspectWarmContainerState()}`);
    sections.push(`[container-logs]
${await this.readWarmContainerLogs(160)}`);
    const shellProbe = await this.runWarmShell("true");
    if (!shellProbe.ok) {
      const probeOut = [shellProbe.stdout, shellProbe.stderr].filter(Boolean).join(`
`);
      sections.push(`[container-exec] exit=${shellProbe.exitCode}${probeOut ? `
${probeOut}` : `
(no output)`}`);
      return sections.join(`
`);
    }
    const checks = spec.diagnosticChecks?.(SHARED_CONTAINER_VENV_PYTHON) ?? [];
    for (const check of checks) {
      const result = await this.runWarmShell(check.command);
      const text = [result.stdout, result.stderr].filter(Boolean).join(`
`);
      sections.push(`[${check.label}] exit=${result.exitCode}${text ? `
${text}` : `
(no output)`}`);
    }
    return sections.join(`
`);
  }
  async stopWarmContainer(reason, quiet = false) {
    this.clearIdleTimer();
    const stopProc = Bun.spawn([resolveDockerExecutable(), "rm", "-f", this.warmContainerName], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const exitCode = await stopProc.exited;
    if (exitCode === 0) {
      if (!quiet)
        console.log(`[DockerExecutor] Warm container stopped (${reason}): ${this.warmContainerName}`);
      return;
    }
    const stderr = (await new Response(stopProc.stderr).text()).trim();
    const notFound = /No such container/i.test(stderr);
    if (!quiet && !notFound) {
      console.error(`[DockerExecutor] Failed to stop warm container: ${stderr}`);
    }
  }
  async shutdown() {
    await this.stopWarmContainer("worker shutdown", true);
  }
  encodeJobSpec(job) {
    return Buffer.from(JSON.stringify({
      jobId: job.id,
      taskId: job.taskId,
      kind: job.kind,
      params: job.params,
      workerId: this.options.workerId
    })).toString("base64");
  }
  mergeReviewPassUsage(accumulated, current) {
    if (!accumulated)
      return current;
    if (!current)
      return accumulated;
    const promptTokens = accumulated.promptTokens + current.promptTokens;
    const completionTokens = accumulated.completionTokens + current.completionTokens;
    return {
      promptTokens,
      completionTokens,
      totalTokens: (accumulated.totalTokens ?? accumulated.promptTokens + accumulated.completionTokens) + (current.totalTokens ?? current.promptTokens + current.completionTokens),
      estimated: Boolean(accumulated.estimated || current.estimated),
      backend: current.backend || accumulated.backend,
      modelId: current.modelId || accumulated.modelId
    };
  }
  async runHostScmOwnedReviewJob(worktreePath, initialJob, onLog) {
    const maxMergeConflictPasses = 8;
    let effectiveJob = initialJob;
    let accumulatedUsage;
    for (let pass = 1;pass <= maxMergeConflictPasses; pass++) {
      const result = await this.runInWarmContainer(worktreePath, this.encodeJobSpec(effectiveJob), effectiveJob, onLog);
      accumulatedUsage = this.mergeReviewPassUsage(accumulatedUsage, result.usage);
      if (!result.ok)
        return { ...result, usage: accumulatedUsage };
      if (isMergeConflictResolutionParams(effectiveJob.params)) {
        const resume = await resumePreparedMergeConflictRebase(worktreePath, effectiveJob.kind, effectiveJob.params, onLog);
        if (!resume.ok) {
          return {
            ...result,
            ok: false,
            summary: "Host-side merge-conflict rebase continuation failed",
            stderr: [result.stderr, resume.error].filter(Boolean).join(`
`),
            exitCode: 4,
            usage: accumulatedUsage
          };
        }
        if (resume.sequencer) {
          if (resume.sequencer !== "rebase" || pass >= maxMergeConflictPasses) {
            const detail = resume.sequencer !== "rebase" ? `Host-side review worktree left unexpected git ${resume.sequencer} in progress.` : `Host-side merge-conflict repair exceeded ${maxMergeConflictPasses} focused resolver passes.`;
            return {
              ...result,
              ok: false,
              summary: detail,
              stderr: [result.stderr, resume.detail, detail].filter(Boolean).join(`
`),
              exitCode: 4,
              usage: accumulatedUsage
            };
          }
          const refreshedParams = await refreshMergeConflictWorktreeHints(worktreePath, effectiveJob.params);
          const planning = refreshedParams.planning && typeof refreshedParams.planning === "object" && !Array.isArray(refreshedParams.planning) ? { ...refreshedParams.planning } : {};
          planning.executionBudgetMs = Math.min(300000, Math.max(60000, Number(planning.executionBudgetMs) || 300000));
          planning.finalizationBudgetMs = Math.min(60000, Math.max(30000, Number(planning.finalizationBudgetMs) || 60000));
          effectiveJob = {
            ...effectiveJob,
            params: markHostScmGitOwnership({
              ...refreshedParams,
              planning,
              qualityRevisionAttempt: pass,
              qualityRevisionHint: [
                String(refreshedParams.qualityRevisionHint ?? "").trim(),
                resume.detail ?? "Host-side rebase continuation advanced to another unresolved conflict.",
                "Resolve only the currently conflicted file contents. Host-side SCM will stage and continue after this pass."
              ].filter(Boolean).join(`

`)
            })
          };
          onLog?.("stdout", `[MergeConflictHost] Rebase still requires conflict editing; starting focused container pass ${pass + 1}/${maxMergeConflictPasses}.`);
          continue;
        }
      }
      if (!shouldCommit(effectiveJob.kind, this.config)) {
        return { ...result, usage: accumulatedUsage };
      }
      const commitResult = await createJobCommit(worktreePath, this.options.workerId, {
        id: effectiveJob.id,
        taskId: effectiveJob.taskId,
        kind: effectiveJob.kind,
        params: effectiveJob.params,
        sessionId: effectiveJob.sessionId,
        context: "host",
        deferPublication: Boolean(result.validationBlocked)
      }, this.config);
      if (!commitResult.ok || !commitResult.sha || !commitResult.branch) {
        const detail = commitResult.error ?? `Host-side completion metadata missing for review job ${effectiveJob.id}.`;
        return {
          ...result,
          ok: false,
          summary: commitResult.publishBlocked?.summary ?? "Host-side review finalization failed",
          stderr: [result.stderr, detail].filter(Boolean).join(`
`),
          exitCode: result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
          publishBlocked: commitResult.publishBlocked,
          usage: accumulatedUsage
        };
      }
      return {
        ...result,
        commit: {
          branch: commitResult.branch,
          sha: commitResult.sha,
          publicBranch: commitResult.publicBranch
        },
        usage: accumulatedUsage
      };
    }
    return {
      ok: false,
      summary: "Host-side review execution exhausted resolver passes",
      exitCode: 4,
      usage: accumulatedUsage
    };
  }
  async runInWarmContainer(worktreePath, base64Spec, job, onLog) {
    await this.ensureWarmRuntimeReady(job, onLog);
    const startedAtMs = Date.now();
    const containerWorktreePath = await this.ensureWorktreeAccessibleInWarmContainer(worktreePath, onLog);
    await this.ensureWorktreeDependencyArtifacts(containerWorktreePath, onLog);
    const args = this.buildWarmContainerExecArgs(containerWorktreePath);
    console.log(`[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary()})`);
    const dockerArgv = [resolveDockerExecutable(), ...args];
    let proc;
    try {
      proc = Bun.spawn(dockerArgv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      });
    } catch (err) {
      throw new Error(`failed to spawn warm-container docker exec (${this.warmContainerName}, cwd=${containerWorktreePath}, argv_chars=${dockerArgv.join("\x00").length}, spec_chars=${base64Spec.length}): ${this.compactError(err)}`);
    }
    const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
    if (timeoutMs !== this.options.timeoutMs) {
      const verb = timeoutMs > this.options.timeoutMs ? "Extended" : "Capped";
      const note = `[DockerExecutor] ${verb} job timeout for browser validation convergence: ${timeoutMs}ms (configured ${this.options.timeoutMs}ms).`;
      console.log(note);
      onLog?.("stdout", note);
    }
    const { leadMs: warningLeadMs, delayMs: warningDelayMs } = computeTimeoutWarningWindow(timeoutMs);
    const warningTimer = setTimeout(() => {
      const warning = `[DockerExecutor] Job nearing timeout in warm container (${Math.round(warningLeadMs / 1000)}s remaining): ${this.warmContainerName}`;
      console.warn(warning);
      onLog?.("stderr", warning);
      onLog?.("stderr", "[DockerExecutor] Worker should finish quickly and return a concise failure/update if task cannot complete in time.");
    }, warningDelayMs);
    let timedOutByDocker = false;
    const timer = setTimeout(() => {
      timedOutByDocker = true;
      const elapsedMs2 = Math.max(1, Date.now() - startedAtMs);
      const timeoutMsg = `[DockerExecutor] Job timeout in warm container after ${elapsedMs2}ms (limit ${timeoutMs}ms): ${this.warmContainerName}`;
      console.log(timeoutMsg);
      onLog?.("stderr", timeoutMsg);
      try {
        proc.kill();
        Bun.spawn([resolveDockerExecutable(), "restart", "-t", "1", this.warmContainerName]);
      } catch {}
    }, timeoutMs);
    const stdoutLines = [];
    const stderrLines = [];
    try {
      const stdout = proc.stdout;
      const stderr = proc.stderr;
      if (!isReadableByteStream(stdout) || !isReadableByteStream(stderr)) {
        throw new Error("docker exec stdout/stderr pipes were not available");
      }
      await Promise.all([
        this.writeJobSpecToStdin(proc, base64Spec),
        this.readStream(stdout, "stdout", onLog, stdoutLines),
        this.readStream(stderr, "stderr", onLog, stderrLines)
      ]);
    } catch (err) {
      try {
        proc.kill();
      } catch {}
      throw new Error(`failed while streaming warm-container job execution (${this.warmContainerName}, spec_chars=${base64Spec.length}): ${this.compactError(err)}`);
    }
    clearTimeout(warningTimer);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    const elapsedMs = Math.max(1, Date.now() - startedAtMs);
    const result = this.parseResult(stdoutLines, stderrLines, exitCode, {
      timedOutByDocker,
      elapsedMs,
      timeoutMs
    });
    return result;
  }
  buildWarmContainerExecArgs(containerWorktreePath) {
    return [
      "exec",
      "-i",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "bun",
      "run",
      "/workspace/apps/workerpals/src/job_runner.ts",
      "--spec-stdin"
    ];
  }
  async writeJobSpecToStdin(proc, base64Spec) {
    const stdin = proc.stdin;
    if (!stdin) {
      throw new Error("docker exec stdin pipe was not available");
    }
    const bytes = new TextEncoder().encode(base64Spec);
    if (stdin instanceof WritableStream) {
      const writer = stdin.getWriter();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (err) {
        try {
          await writer.abort(err);
        } catch {}
        throw err;
      }
      return;
    }
    const nodeStdin = stdin;
    if (typeof nodeStdin.write === "function" && typeof nodeStdin.end === "function") {
      await nodeStdin.write(bytes);
      if (typeof nodeStdin.flush === "function") {
        await nodeStdin.flush();
      }
      await nodeStdin.end();
      return;
    }
    throw new Error("docker exec stdin pipe does not support write/end or getWriter");
  }
  async ensureWorktreeDependencyArtifacts(containerWorktreePath, onLog) {
    const startedAt = Date.now();
    const startNote = "[DockerExecutor] Preparing Linux-native dependency entries for the WorkerPal worktree.";
    console.log(startNote);
    onLog?.("stdout", startNote);
    const command = buildWorktreeDependencyPreparationCommand(containerWorktreePath);
    const result = await this.runWarmShell(command);
    if (!result.ok) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join(`
`).trim();
      const warning = `[DockerExecutor] Linux-native worktree dependency preparation failed: ${detail || `exit ${result.exitCode}`}`;
      console.warn(warning);
      onLog?.("stderr", warning);
      throw new Error(warning);
    }
    const linked = result.stdout.trim().split(/\s+/g).map((entry) => entry.trim()).filter(Boolean);
    if (linked.length === 0)
      return;
    const note = `[DockerExecutor] Prepared worktree dependency snapshot(s) in ${Date.now() - startedAt}ms: ` + linked.join(", ");
    console.log(note);
    onLog?.("stdout", note);
  }
  async waitForWorktreePathInWarmContainer(containerWorktreePath, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "";
    const command = `test -d ${shellSingleQuote(containerWorktreePath)}`;
    while (Date.now() < deadline) {
      const result = await this.runWarmShell(command);
      if (result.ok)
        return;
      lastDetail = [result.stdout, result.stderr].filter(Boolean).join(`
`).trim();
      await this.sleep(100);
    }
    throw new Error(`worktree path not visible inside warm container after ${timeoutMs}ms: ${containerWorktreePath}${lastDetail ? ` (${lastDetail})` : ""}`);
  }
  async ensureWorktreeAccessibleInWarmContainer(worktreePath, onLog) {
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    let lastError = null;
    for (let attempt = 1;attempt <= 2; attempt++) {
      try {
        await this.ensureWarmContainer();
        await this.waitForWorktreePathInWarmContainer(containerWorktreePath, this.worktreeVisibilityTimeoutMs);
        const probe = await this.runWarmWorktreeProbe(containerWorktreePath);
        if (probe.ok) {
          return containerWorktreePath;
        }
        const detail = [probe.stderr, probe.stdout].filter(Boolean).join(`
`).trim();
        throw new Error(`warm container git probe failed (exit ${probe.exitCode})${detail ? `: ${detail}` : ""}`);
      } catch (err) {
        lastError = err;
        if (attempt >= 2) {
          const diagnostics = await this.inspectWarmContainerState().catch(() => "");
          throw new Error(`worktree not accessible inside warm container after ${attempt} attempts: ${containerWorktreePath}${lastError ? ` (${this.compactError(lastError)})` : ""}${diagnostics ? ` | container=${diagnostics}` : ""}`);
        }
        const note = `[DockerExecutor] Warm container could not access worktree ${containerWorktreePath}; ` + `recycling container and retrying once (${this.compactError(err)}).`;
        console.warn(note);
        onLog?.("stderr", note);
        await this.stopWarmContainer("worktree visibility retry", true);
      }
    }
    return containerWorktreePath;
  }
  normalizeProvider(raw) {
    const value = raw.trim().toLowerCase();
    if (!value)
      return "auto";
    if (value === "lmstudio" || value === "openai_compatible")
      return "openai";
    if (value === "ollama_chat")
      return "ollama";
    return value;
  }
  executionConfigSummary() {
    const backend = resolveExecutor(this.config);
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const warmMemoryMb = this.config.workerpals.dockerWarmMemoryMb;
    const warmCpus = this.config.workerpals.dockerWarmCpus;
    const warmPython = this.containerBackendPython(backend);
    return `backend=${backend} model=${model} provider=${provider} warm_memory_mb=${warmMemoryMb} warm_cpus=${warmCpus} warm_python=${warmPython}`;
  }
  logExecutionConfig() {
    const summary = this.executionConfigSummary();
    if (summary === this.lastLoggedExecutionConfig)
      return;
    this.lastLoggedExecutionConfig = summary;
    console.log(`[DockerExecutor] Execution config: ${summary}`);
    const configuredEndpoint = this.config.workerpals.llm.endpoint.trim();
    const containerEndpoint = this.workerLlmEndpointForContainer();
    if (configuredEndpoint && configuredEndpoint !== containerEndpoint) {
      const rewriteSummary = `${configuredEndpoint} -> ${containerEndpoint}`;
      if (rewriteSummary !== this.lastLoggedEndpointRewrite) {
        this.lastLoggedEndpointRewrite = rewriteSummary;
        console.log(`[DockerExecutor] Rewriting worker LLM endpoint for container networking: ${rewriteSummary}`);
      }
    }
  }
  async runGitSelfCheckContainer(worktreePath, assertLfPath) {
    const containerName = `pushpals-${this.options.workerId}-selfcheck-${Date.now()}`;
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    const args = [
      resolveDockerExecutable(),
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "none",
      "-v",
      `${dockerRepoPath}:/repo`,
      "-w",
      containerWorktreePath,
      ...assertLfPath ? ["-e", `PUSHPALS_LF_ASSERT_PATH=${assertLfPath}`] : [],
      "--entrypoint",
      "/bin/sh",
      this.options.imageName,
      "-lc",
      [
        "set -eu",
        'test "$(git config --worktree --get core.autocrlf)" = "false"',
        'test "$(git config --worktree --get core.eol)" = "lf"',
        "git rev-parse --is-inside-work-tree",
        "git rev-parse --git-dir",
        "git status --porcelain",
        'if [ -n "${PUSHPALS_LF_ASSERT_PATH:-}" ]; then',
        '  test -f "$PUSHPALS_LF_ASSERT_PATH"',
        '  if od -An -t x1 "$PUSHPALS_LF_ASSERT_PATH" | tr -d " \\n" | grep -qi "0d0a"; then',
        '    echo "CRLF bytes found in $PUSHPALS_LF_ASSERT_PATH" >&2',
        "    exit 23",
        "  fi",
        "fi"
      ].join(`
`)
    ];
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (exitCode !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(`
`);
      throw new Error(`Docker git/worktree startup self-check failed: ${detail}`);
    }
  }
  async readStream(readable, streamName, onLog, lines) {
    const decoder = new TextDecoder;
    const reader = readable.getReader();
    let pending = "";
    const forwardLine = (line) => {
      const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!cleanLine)
        return;
      lines.push(cleanLine);
      if (streamName === "stderr") {
        try {
          const logEntry = JSON.parse(cleanLine);
          if (logEntry.stream && logEntry.line) {
            onLog?.(logEntry.stream, logEntry.line);
            return;
          }
        } catch {}
      }
      onLog?.(streamName, cleanLine);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      pending += decoder.decode(value, { stream: true });
      let newlineIndex = pending.indexOf(`
`);
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        forwardLine(line);
        newlineIndex = pending.indexOf(`
`);
      }
    }
    pending += decoder.decode();
    if (pending) {
      forwardLine(pending);
    }
  }
  parseResult(stdoutLines, stderrLines, exitCode, context) {
    let sawSentinel = false;
    let sentinelParseError = "";
    for (let i = stdoutLines.length - 1;i >= 0; i--) {
      const line = stdoutLines[i];
      const match = line.match(/^___RESULT___ (.+)$/);
      if (match) {
        sawSentinel = true;
        try {
          const result = JSON.parse(match[1]);
          return result;
        } catch (err) {
          sentinelParseError = String(err);
          console.error(`[DockerExecutor] Failed to parse result JSON (line length=${line.length}): ${sentinelParseError}`);
        }
      }
    }
    const stdout = stdoutLines.join(`
`);
    const stderr = stderrLines.join(`
`);
    if (sawSentinel) {
      const details = [
        `Malformed ___RESULT___ payload: ${sentinelParseError || "unknown parse error"}`
      ];
      if (stderr)
        details.push(stderr);
      const summary2 = `Worker returned malformed structured result after ${context.elapsedMs}ms`;
      return {
        ok: false,
        summary: summary2,
        stdout,
        stderr: details.join(`
`),
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary2, context, exitCode, "malformed_structured_result", {
          sentinelParseError
        })
      };
    }
    if (context.timedOutByDocker) {
      const summary2 = `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${context.timeoutMs}ms; terminated before structured result).`;
      return {
        ok: false,
        summary: summary2,
        stdout,
        stderr,
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary2, context, exitCode, "timeout")
      };
    }
    if (exitCode === 143 || exitCode === 137) {
      const summary2 = `Job process was terminated (exit ${exitCode}) after ${context.elapsedMs}ms before structured result was produced.`;
      return {
        ok: false,
        summary: summary2,
        stdout,
        stderr,
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary2, context, exitCode, "terminated")
      };
    }
    const summary = exitCode === 0 ? `Job completed in ${context.elapsedMs}ms` : `Job failed (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`;
    return {
      ok: exitCode === 0,
      summary,
      stdout,
      stderr,
      exitCode,
      diagnostics: exitCode === 0 ? undefined : dockerFallbackDiagnostics(summary, context, exitCode, "no_structured_result")
    };
  }
  async ensureWarmRuntimeReady(job, onLog) {
    const backend = resolveExecutor(this.config);
    let attempt = 1;
    let recoveredMissingImage = false;
    while (attempt <= this.warmSetupMaxAttempts) {
      try {
        await this.ensureWarmContainer();
        await this.ensureBackendWarmup(backend);
        return;
      } catch (err) {
        if (this.isMissingDockerImageError(err) && !recoveredMissingImage) {
          recoveredMissingImage = true;
          const rebuildNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is missing locally; rebuilding before retrying warm container startup.`;
          console.warn(rebuildNote);
          onLog?.("stderr", rebuildNote);
          await this.stopWarmContainer("missing image recovery", true);
          this.warmedBackends.clear();
          if (await this.pullImage()) {
            const retryNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is available again; retrying warm container startup.`;
            console.log(retryNote);
            onLog?.("stdout", retryNote);
            continue;
          }
        }
        const retryable = this.isRetryableError(err);
        if (attempt >= this.warmSetupMaxAttempts || !retryable) {
          if (retryable && attempt >= this.warmSetupMaxAttempts && !(err instanceof DockerExecutionExhaustedError)) {
            throw new DockerExecutionExhaustedError("warm_setup", `Warm runtime setup retries exhausted after ${this.warmSetupMaxAttempts} attempts: ${this.compactError(err)}`, this.failureCooldownMs);
          }
          throw err;
        }
        const retryInMs = this.backoffDelayMs(this.warmSetupBackoffMs, attempt);
        const note = `[DockerExecutor] Warm runtime setup failed (attempt ${attempt}/${this.warmSetupMaxAttempts}): ${this.compactError(err)}. Retrying in ${retryInMs}ms.`;
        console.warn(note);
        onLog?.("stderr", note);
        await this.stopWarmContainer("warm setup retry", true);
        await this.sleep(retryInMs);
        attempt += 1;
      }
    }
  }
  async ensureBackendWarmup(backend) {
    if (this.warmedBackends.has(backend))
      return;
    const spec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    if (spec.ensureWarmRuntime) {
      await spec.ensureWarmRuntime({
        ...warmContext,
        warmContainerName: this.warmContainerName,
        runWarmShell: (command) => this.runWarmShell(command),
        restartWarmContainer: async () => {
          await this.startWarmContainer();
        },
        collectWarmDiagnostics: async () => this.collectWarmRuntimeDiagnostics(backend)
      });
      this.warmedBackends.add(backend);
      return;
    }
    const cmd = spec.warmupProbeCommand?.(SHARED_CONTAINER_VENV_PYTHON);
    if (cmd) {
      const result = await this.runWarmShell(cmd);
      if (!result.ok) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join(`
`).trim();
        throw new Error(`${backend} runtime warmup failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
      }
    }
    this.warmedBackends.add(backend);
  }
  backoffDelayMs(baseMs, attempt) {
    const factor = Math.max(0, attempt - 1);
    const exponential = baseMs * Math.pow(2, factor);
    return Math.max(250, Math.min(60000, Math.floor(exponential)));
  }
  async sleep(ms) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }
  async runDockerCommandCapture(command, opts = {}) {
    const proc = Bun.spawn(command, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    let timer = null;
    if (typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, opts.timeoutMs);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (timer)
      clearTimeout(timer);
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      timedOut
    };
  }
  compactError(err) {
    const text = err instanceof Error ? err.message : String(err);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 280)
      return normalized;
    return `${normalized.slice(0, 277)}...`;
  }
  isRetryableError(err) {
    const text = this.compactError(err).toLowerCase();
    return this.matchesRetryablePattern(text);
  }
  isMissingDockerImageError(err) {
    return isMissingDockerImageDetail(this.compactError(err));
  }
  isRetryableJobFailure(result) {
    if (result.diagnostics?.terminal || result.publishBlocked || result.validationBlocked) {
      return false;
    }
    const text = `${result.summary ?? ""}
${result.stderr ?? ""}`.toLowerCase();
    if (text.includes("repeated unchanged validation failure circuit opened") || text.includes("stopping revisions for this failure cluster")) {
      return false;
    }
    return this.matchesRetryablePattern(text);
  }
  retryExhaustionCooldownMs(result) {
    const resultCooldownMs = readPositiveNumber(result.cooldownMs) ?? 0;
    return Math.max(this.failureCooldownMs, resultCooldownMs);
  }
  matchesRetryablePattern(text) {
    const transientPatterns = [
      /warm .*runtime/i,
      /failed to start warm container/i,
      /docker execution error/i,
      /cannot connect to the docker daemon/i,
      /agent server health check failed/i,
      /\bconnection (?:error|refused|reset|aborted|closed)\b/i,
      /\bnetwork is unreachable\b/i,
      /\b(?:econnrefused|econnreset|eai_again)\b/i,
      /\blitellm\.timeout\b/i,
      /\bapitimeouterror\b/i,
      /\b(?:api|request|connection|health check|startup|model preflight|llm)\s+timed out\b/i,
      /\bdeadline exceeded\b/i,
      /\bcontext deadline exceeded\b/i,
      /\btls handshake timeout\b/i,
      /\btemporary failure\b/i,
      /\bopenhands wrapper timed out\b/i,
      /\bjob timed out in docker executor\b/i,
      /\bworktree path not visible inside warm container\b/i,
      /\bchdir to cwd\b/i,
      /\bunable to start container process\b/i
    ];
    return transientPatterns.some((pattern) => pattern.test(text));
  }
  hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog) {
    if (attempt >= this.jobRetryMaxAttempts)
      return false;
    const consumedRatio = timeoutMs > 0 ? attemptElapsedMs / timeoutMs : 1;
    if (attemptElapsedMs < Math.max(300000, timeoutMs * 0.8) && consumedRatio < 0.8)
      return true;
    const note = `[DockerExecutor] Skipping retry attempt ${attempt + 1}/${this.jobRetryMaxAttempts}: prior attempt consumed ${attemptElapsedMs}ms of ${timeoutMs}ms budget.`;
    console.warn(note);
    onLog?.("stderr", note);
    return false;
  }
  toDockerPath(hostPath) {
    const winMatch = hostPath.match(/^([a-zA-Z]):([\\/])(.*)$/);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const rest = winMatch[3].replace(/\\/g, "/");
      return `/${drive}/${rest}`;
    }
    return hostPath;
  }
  async cleanupOrphanedWorktrees() {
    try {
      const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
        cwd: this.options.repo,
        stdout: "pipe"
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0)
        return;
      const prunablePaths = collectPrunableEphemeralWorktrees(output);
      if (prunablePaths.length > 0) {
        for (const path of prunablePaths) {
          console.log(`[DockerExecutor] Pruning stale worktree metadata: ${path}`);
        }
      }
      const prune = Bun.spawn(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        stdout: "pipe",
        stderr: "pipe"
      });
      const pruneExit = await prune.exited;
      if (pruneExit !== 0) {
        const pruneStderr = await new Response(prune.stderr).text();
        console.warn(`[DockerExecutor] Worktree prune warning: ${pruneStderr}`);
      }
    } catch (err) {
      console.error(`[DockerExecutor] Cleanup error: ${err}`);
    }
  }
  buildEphemeralWorktreeName(prefix, token) {
    const safeToken = this.sanitizeWorktreeToken(token, prefix === "job" ? 8 : 12);
    const nonce = `${Date.now().toString(36).slice(-6)}-${randomUUID().slice(0, 6).toLowerCase()}`;
    return `${prefix}-${safeToken}-${nonce}`;
  }
  sanitizeWorktreeToken(value, maxLength) {
    const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!normalized)
      return "work";
    return normalized.slice(0, maxLength);
  }
  async ensureFreshWorktreePath(worktreePath) {
    if (!existsSync10(worktreePath))
      return;
    console.warn(`[DockerExecutor] Worktree path already exists; forcing cleanup before create: ${worktreePath}`);
    const unregister = Bun.spawn(["git", "worktree", "remove", "--force", "--force", worktreePath], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    await unregister.exited;
    const prune = Bun.spawn(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    await prune.exited;
    const forced = await forceDeleteWorktreePath(worktreePath, {
      sleepFn: (ms) => this.sleep(ms)
    });
    if (!forced.removed) {
      throw new Error(`Failed to remove stale worktree path before create (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`);
    }
  }
  isMergeConflictResolutionJob(job) {
    const reviewAgent = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" ? job.params.reviewAgent : null;
    const resolutionType = reviewAgent && typeof reviewAgent.resolutionType === "string" ? reviewAgent.resolutionType.trim().toLowerCase() : "";
    return resolutionType === "merge_conflict" || resolutionType === "integration_reconcile";
  }
  shouldPrepareMergeConflictJobBeforeExecution(job) {
    return this.isMergeConflictResolutionJob(job) && !this.preparedMergeConflictJobs.has(job.id);
  }
  async prepareMergeConflictJobEnvironment(job, onLog) {
    await this.ensureFreshImageForMergeConflictJob(job, onLog);
    this.preparedMergeConflictJobs.add(job.id);
  }
  recommendedMergeConflictDeferMs() {
    return Math.max(60000, Math.min(this.options.timeoutMs, 5 * 60000));
  }
  async ensureFreshImageForMergeConflictJob(job, onLog) {
    if (!this.isMergeConflictResolutionJob(job))
      return;
    if (this.mergeConflictRefreshPromise) {
      await this.mergeConflictRefreshPromise;
      return;
    }
    this.mergeConflictRefreshPromise = this.rebuildImageForMergeConflictJob(job, onLog);
    try {
      await this.mergeConflictRefreshPromise;
    } finally {
      this.mergeConflictRefreshPromise = null;
    }
  }
  async rebuildImageForMergeConflictJob(job, onLog) {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    const dockerfilePath = sandboxContext.dockerfilePath;
    if (!existsSync10(dockerfilePath)) {
      throw new Error(`Merge-conflict job ${job.id} requires Docker image refresh, but Dockerfile is missing at ${dockerfilePath}.`);
    }
    const startMsg = `[DockerExecutor] Merge-conflict job ${job.id}: rebuilding ${this.options.imageName} with --no-cache and restarting warm runtime.`;
    console.log(startMsg);
    onLog?.("stdout", startMsg);
    await this.stopWarmContainer("merge-conflict image refresh", true);
    this.warmedBackends.clear();
    const build = Bun.spawn([
      resolveDockerExecutable(),
      "build",
      "--no-cache",
      "-f",
      dockerfilePath,
      "-t",
      this.options.imageName,
      "."
    ], {
      cwd: sandboxContext.root,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text()
    ]);
    if (exitCode !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(`
`);
      throw new Error(`Failed to rebuild Docker image for merge-conflict job ${job.id}: ${detail || `exit ${exitCode}`}`);
    }
    const doneMsg = `[DockerExecutor] Merge-conflict job ${job.id}: Docker image refresh complete (${this.options.imageName}).`;
    console.log(doneMsg);
    onLog?.("stdout", doneMsg);
  }
  async resolveWorktreeBaseRefForJob(job, onLog) {
    return resolveReviewWorktreeBase({
      jobId: job.id,
      params: job.params,
      git: (args) => this.runGitBaseRefCommand(args),
      fallback: () => resolveFreshWorktreeBaseRef({
        requestedRef: this.options.baseRef,
        integrationBranch: this.config.sourceControlManager.mainBranch || this.config.workerpals.baseRef || this.options.baseRef,
        sourceBaseBranch: this.config.sourceControlManager.baseBranch,
        git: (args) => this.runGitBaseRefCommand(args),
        log: (level, message) => {
          const line = `[DockerExecutor] ${message}`;
          if (level === "warn") {
            console.warn(line);
            onLog?.("stderr", line);
          } else {
            console.log(line);
            onLog?.("stdout", line);
          }
        }
      }),
      log: (level, message) => {
        const line = `[DockerExecutor] ${message}`;
        if (level === "warn") {
          console.warn(line);
          onLog?.("stderr", line);
        } else {
          console.log(line);
          onLog?.("stdout", line);
        }
      }
    });
  }
  async runGitBaseRefCommand(args) {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    return {
      ok: exitCode === 0,
      stdout,
      stderr
    };
  }
  async pullImage() {
    const runtimeTag = resolveWorkerpalRuntimeTag();
    const existingRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag() : "";
    if (await this.imageExists()) {
      if (!runtimeTag || existingRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using local image: ${this.options.imageName}`);
        return true;
      }
      console.warn(`[DockerExecutor] Local image ${this.options.imageName} is stale or unlabeled (runtimeTag=${existingRuntimeTag || "missing"}, expected=${runtimeTag}).`);
    }
    if (await this.buildLocalImage(runtimeTag)) {
      const rebuiltRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag() : "";
      if (!runtimeTag || rebuiltRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using locally built image: ${this.options.imageName}`);
        return true;
      }
    }
    console.log(`[DockerExecutor] Local image is unavailable or unsuitable. Pulling: ${this.options.imageName}`);
    const pull = await this.runDockerCommandCapture([resolveDockerExecutable(), "pull", this.options.imageName], { timeoutMs: DOCKER_IMAGE_PULL_TIMEOUT_MS });
    if (!pull.timedOut && pull.exitCode === 0) {
      console.log(`[DockerExecutor] Image pulled successfully`);
      return true;
    }
    const detail = pull.stderr || pull.stdout || `docker pull exited ${pull.exitCode}`;
    console.error(`[DockerExecutor] Failed to pull image: ${pull.timedOut ? `timed out after ${DOCKER_IMAGE_PULL_TIMEOUT_MS}ms` : detail}`);
    if (await this.imageExists()) {
      console.warn(`[DockerExecutor] Pull failed but local image is now available: ${this.options.imageName}`);
      return true;
    }
    return false;
  }
  async imageExists() {
    const result = await this.runDockerCommandCapture([resolveDockerExecutable(), "image", "inspect", this.options.imageName], { timeoutMs: DOCKER_IMAGE_INSPECT_TIMEOUT_MS });
    if (result.timedOut) {
      console.warn(`[DockerExecutor] Timed out checking local image ${this.options.imageName}; treating it as unavailable and attempting rebuild.`);
      return false;
    }
    return result.exitCode === 0;
  }
  async inspectImageRuntimeTag() {
    const result = await this.runDockerCommandCapture([
      resolveDockerExecutable(),
      "image",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
      this.options.imageName
    ], { timeoutMs: DOCKER_IMAGE_INSPECT_TIMEOUT_MS });
    if (result.timedOut) {
      console.warn(`[DockerExecutor] Timed out inspecting runtime tag for ${this.options.imageName}; treating the local image as stale and attempting rebuild.`);
      return "";
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
      if (!isMissingDockerImageDetail(detail)) {
        console.warn(`[DockerExecutor] Failed to inspect runtime tag for ${this.options.imageName}: ${detail}`);
      }
      return "";
    }
    const value = result.stdout.trim();
    return value === "<no value>" ? "" : value;
  }
  async buildLocalImage(runtimeTag) {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    if (!existsSync10(sandboxContext.dockerfilePath)) {
      return false;
    }
    const dockerfileArg = dockerBuildFileArg(sandboxContext.root, sandboxContext.dockerfilePath);
    const caSecretArgs = resolveWorkerpalDockerBuildCaSecretArgs();
    console.log(runtimeTag ? `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName} for runtimeTag=${runtimeTag}` : `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName}`);
    const args = [
      resolveDockerExecutable(),
      "build",
      "-f",
      dockerfileArg,
      "--label",
      WORKERPAL_SANDBOX_COMPONENT_LABEL,
      ...runtimeTag ? ["--label", `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`] : [],
      ...caSecretArgs,
      "-t",
      this.options.imageName,
      "."
    ];
    if (caSecretArgs.length > 0) {
      console.log("[DockerExecutor] Supplying host extra CA trust to the sandbox build as an ephemeral secret.");
    }
    const build = await this.runDockerCommandCapture(args, {
      cwd: sandboxContext.root,
      timeoutMs: DOCKER_IMAGE_BUILD_TIMEOUT_MS
    });
    if (!build.timedOut && build.exitCode === 0) {
      return true;
    }
    const detail = build.stderr || build.stdout || `docker build exited ${build.exitCode}`;
    console.error(`[DockerExecutor] Failed to build local image: ${build.timedOut ? `timed out after ${DOCKER_IMAGE_BUILD_TIMEOUT_MS}ms` : detail}`);
    return false;
  }
  static async isDockerAvailable() {
    try {
      const proc = Bun.spawn([resolveDockerExecutable(), "version"], {
        stdout: "pipe",
        stderr: "pipe"
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}

// apps/workerpals/src/common/server_transport.ts
function computeHeartbeatTimeoutMs(heartbeatMs) {
  return Math.max(1500, Math.min(4000, Math.floor(heartbeatMs * 0.8)));
}
function computeRequestTimeoutMs(heartbeatMs) {
  return Math.max(4000, Math.min(1e4, Math.floor(heartbeatMs * 2)));
}
async function readResponseDetail(response) {
  const text = await response.text().catch(() => "");
  return text.trim();
}

class WorkerServerTransport {
  server;
  headers;
  workerId;
  pollMs;
  staleClaimTtlMs;
  fetchFn;
  logInfo;
  logWarn;
  nowFn;
  heartbeatTimeoutMs;
  requestTimeoutMs;
  maxQueuedRequests = 256;
  queuedRequests = [];
  queueDrainInFlight = false;
  queueFlushWaiters = [];
  droppedLogRequests = 0;
  heartbeatInFlight = false;
  lastHeartbeatAttemptAt = 0;
  lastHeartbeatSuccessAt = 0;
  consecutiveHeartbeatFailures = 0;
  firstHeartbeatFailureAt = -1;
  lastHeartbeatFailureDetail = "";
  constructor(options) {
    this.server = options.server;
    this.headers = options.headers;
    this.workerId = options.workerId;
    this.pollMs = options.pollMs;
    this.staleClaimTtlMs = options.staleClaimTtlMs;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logInfo = options.logInfo ?? ((message) => console.log(message));
    this.logWarn = options.logWarn ?? ((message) => console.warn(message));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.heartbeatTimeoutMs = computeHeartbeatTimeoutMs(options.heartbeatMs);
    this.requestTimeoutMs = computeRequestTimeoutMs(options.heartbeatMs);
  }
  getHealthSnapshot() {
    return {
      heartbeatInFlight: this.heartbeatInFlight,
      consecutiveHeartbeatFailures: this.consecutiveHeartbeatFailures,
      lastHeartbeatAttemptAt: this.lastHeartbeatAttemptAt,
      lastHeartbeatSuccessAt: this.lastHeartbeatSuccessAt,
      queuedRequests: this.queuedRequests.length,
      droppedLogRequests: this.droppedLogRequests
    };
  }
  getHeartbeatStaleAgeMs(nowMs = this.nowFn()) {
    if (this.lastHeartbeatSuccessAt <= 0)
      return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - this.lastHeartbeatSuccessAt);
  }
  shouldRecycleBusyWorker(nowMs = this.nowFn()) {
    const failureAgeMs = this.firstHeartbeatFailureAt >= 0 ? Math.max(0, nowMs - this.firstHeartbeatFailureAt) : null;
    if (failureAgeMs == null)
      return false;
    const threshold = Math.min(this.staleClaimTtlMs, Math.max(30000, Math.min(this.staleClaimTtlMs - this.heartbeatTimeoutMs, Math.floor(this.staleClaimTtlMs * 0.75))));
    return failureAgeMs >= threshold;
  }
  async sendHeartbeat(payload) {
    if (this.heartbeatInFlight) {
      return false;
    }
    this.heartbeatInFlight = true;
    this.lastHeartbeatAttemptAt = this.nowFn();
    try {
      const response = await this.postJson("/workers/heartbeat", {
        workerId: this.workerId,
        status: payload.status,
        currentJobId: payload.currentJobId,
        pollMs: this.pollMs,
        capabilities: payload.capabilities ?? {},
        details: payload.details ?? {}
      }, this.heartbeatTimeoutMs);
      if (!response.ok) {
        const detail = await readResponseDetail(response);
        throw new Error(`heartbeat rejected (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      const previousFailures = this.consecutiveHeartbeatFailures;
      this.lastHeartbeatSuccessAt = this.nowFn();
      this.consecutiveHeartbeatFailures = 0;
      this.firstHeartbeatFailureAt = -1;
      this.lastHeartbeatFailureDetail = "";
      if (previousFailures > 0) {
        this.logInfo(`[WorkerPals] Heartbeat recovered for ${this.workerId} after ${previousFailures} failed attempt(s).`);
      }
      return true;
    } catch (error) {
      if (this.consecutiveHeartbeatFailures === 0) {
        this.firstHeartbeatFailureAt = this.nowFn();
      }
      this.consecutiveHeartbeatFailures += 1;
      this.lastHeartbeatFailureDetail = error instanceof Error ? error.message : String(error);
      const staleAgeMs = this.getHeartbeatStaleAgeMs();
      this.logWarn(`[WorkerPals] Heartbeat failure ${this.consecutiveHeartbeatFailures} for ${this.workerId}: ${this.lastHeartbeatFailureDetail} (lastSuccessAgeMs=${Number.isFinite(staleAgeMs) ? staleAgeMs : -1}).`);
      return false;
    } finally {
      this.heartbeatInFlight = false;
    }
  }
  queueSessionCommand(sessionId, cmd, options = {}) {
    return this.enqueueTask({
      label: `command:${cmd.type}`,
      priority: options.priority ?? "normal",
      droppable: options.droppable ?? false,
      run: async () => {
        const response = await this.postJson(`/sessions/${sessionId}/command`, cmd, this.requestTimeoutMs);
        if (!response.ok) {
          const detail = await readResponseDetail(response);
          this.logWarn(`[WorkerPals] Command ${cmd.type} failed: ${response.status}${detail ? ` ${detail}` : ""}`);
        }
      }
    });
  }
  queueJobLog(jobId, payload) {
    return this.enqueueTask({
      label: "job_log",
      priority: "normal",
      droppable: true,
      run: async () => {
        const response = await this.postJson(`/jobs/${jobId}/log`, payload, this.requestTimeoutMs);
        if (!response.ok) {
          const detail = await readResponseDetail(response);
          this.logWarn(`[WorkerPals] Job log delivery failed for ${jobId}: ${response.status}${detail ? ` ${detail}` : ""}`);
        }
      }
    });
  }
  async flush(timeoutMs = 15000) {
    if (this.queuedRequests.length === 0 && !this.queueDrainInFlight)
      return;
    await new Promise((resolve12) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled)
          return;
        settled = true;
        this.logWarn(`[WorkerPals] Timed out flushing queued server transport requests after ${timeoutMs}ms (queued=${this.queuedRequests.length}).`);
        resolve12();
      }, timeoutMs);
      this.queueFlushWaiters.push(() => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        resolve12();
      });
      this.maybeResolveFlushWaiters();
    });
  }
  enqueueTask(task) {
    if (task.droppable && this.queuedRequests.length >= this.maxQueuedRequests) {
      this.droppedLogRequests += 1;
      if (this.droppedLogRequests === 1 || this.droppedLogRequests % 25 === 0) {
        this.logWarn(`[WorkerPals] Dropped ${this.droppedLogRequests} queued low-priority transport request(s) because the queue is saturated (limit=${this.maxQueuedRequests}).`);
      }
      return Promise.resolve();
    }
    return new Promise((resolve12) => {
      const queued = { ...task, resolve: resolve12 };
      if (queued.priority === "high") {
        const firstNormalIndex = this.queuedRequests.findIndex((entry) => entry.priority !== "high");
        if (firstNormalIndex === -1) {
          this.queuedRequests.push(queued);
        } else {
          this.queuedRequests.splice(firstNormalIndex, 0, queued);
        }
      } else {
        this.queuedRequests.push(queued);
      }
      this.drainQueue();
    });
  }
  async drainQueue() {
    if (this.queueDrainInFlight)
      return;
    this.queueDrainInFlight = true;
    try {
      while (this.queuedRequests.length > 0) {
        const task = this.queuedRequests.shift();
        if (!task)
          break;
        try {
          await task.run();
        } catch (error) {
          this.logWarn(`[WorkerPals] Transport request ${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          task.resolve();
        }
      }
    } finally {
      this.queueDrainInFlight = false;
      this.maybeResolveFlushWaiters();
    }
  }
  maybeResolveFlushWaiters() {
    if (this.queuedRequests.length > 0 || this.queueDrainInFlight)
      return;
    const waiters = this.queueFlushWaiters.splice(0);
    for (const waiter of waiters)
      waiter();
  }
  async postJson(path, payload, timeoutMs) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await this.fetchFn(`${this.server}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`request timed out after ${timeoutMs}ms (${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// apps/workerpals/src/workerpals_main.ts
var DEFAULT_LLM_MODEL = "local-model";
var CODEX_UNAVAILABLE_WORKER_EXIT_CODE = 86;
var CODEX_STARTUP_STALL_WORKER_EXIT_CODE = 87;
var CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS = 5000;
var CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS = 4000;
var CODEX_STARTUP_STALL_DIRECT_RETRY_DEFER_MS = 5000;
var DEFAULT_JOB_PROGRESS_LOG_EVERY_MS = 60000;
var CONFIG = loadPushPalsConfig();
var LOG = new Logger("WorkerPals");
function workerLlmConfig(runtimeConfig) {
  const normalizeProvider = (raw) => {
    const value = raw.trim().toLowerCase();
    if (!value)
      return "auto";
    if (value === "lmstudio")
      return "openai";
    if (value === "openai_compatible")
      return "openai";
    if (value === "ollama_chat")
      return "ollama";
    return value;
  };
  const model = runtimeConfig.workerpals.llm.model.trim().replace(/\s+/g, " ");
  const provider = normalizeProvider(runtimeConfig.workerpals.llm.backend);
  const baseUrl = runtimeConfig.workerpals.llm.endpoint.trim();
  return {
    model: model || DEFAULT_LLM_MODEL,
    provider: provider || "auto",
    baseUrl
  };
}
function estimateTokensFromText3(text) {
  return Math.max(0, Math.ceil(String(text ?? "").length / 3));
}
function compactWorkerError(error, maxLength = 220) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized)
    return "unknown error";
  if (normalized.length <= maxLength)
    return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
async function postJsonWithTimeout(url, headers, body, timeoutMs = 1e4) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function persistWorkerDiagnostics(server, headers, jobId, diagnostics) {
  if (!diagnostics)
    return true;
  const expectedValidationRuns = diagnostics.validationRuns?.length ?? 0;
  const expectedPatchSnapshots = diagnostics.patchSnapshots?.length ?? 0;
  try {
    const response = await postJsonWithTimeout(`${server}/jobs/${jobId}/diagnostics`, headers, { diagnostics }, 5000);
    const payload = await response.json().catch(() => null);
    const persistedValidationRuns = Number(payload?.counts?.validationRuns ?? 0);
    const persistedPatchSnapshots = Number(payload?.counts?.patchSnapshots ?? 0);
    if (!response.ok || payload?.ok !== true || persistedValidationRuns < expectedValidationRuns || persistedPatchSnapshots < expectedPatchSnapshots) {
      console.error(`[WorkerPals] Diagnostics persistence verification failed for job ${jobId}: ` + `expected validation=${expectedValidationRuns}, patches=${expectedPatchSnapshots}; ` + `persisted validation=${persistedValidationRuns}, patches=${persistedPatchSnapshots}; ` + `HTTP ${response.status}${payload?.message ? ` (${String(payload.message)})` : ""}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[WorkerPals] Diagnostics upload failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function inferFailureToolInvocation(result) {
  const combined = [result.summary, result.stdout, result.stderr, result.publishBlocked?.detail].map((part) => String(part ?? "")).join(`
`);
  if (/codex\s+--version/i.test(combined) || /openai_codex/i.test(combined)) {
    return {
      tool: "codex",
      argv: /codex\s+--version/i.test(combined) ? ["codex", "--version"] : [],
      commandLine: /codex\s+--version/i.test(combined) ? "codex --version" : undefined,
      exitCode: result.exitCode ?? (/exit\s+127/i.test(combined) ? 127 : null)
    };
  }
  if (/git\s+pull\s+--rebase/i.test(combined)) {
    return {
      tool: "git",
      argv: ["git", "pull", "--rebase"],
      commandLine: "git pull --rebase",
      exitCode: result.exitCode ?? null
    };
  }
  if (/\bgit\b/i.test(combined) && /\b(rebase|cherry-pick|checkout|push)\b/i.test(combined)) {
    return { tool: "git", argv: [], exitCode: result.exitCode ?? null };
  }
  if (/\bdocker\b/i.test(combined) || /docker_engine/i.test(combined)) {
    return { tool: "docker", argv: [], exitCode: result.exitCode ?? null };
  }
  if (/\bbun\b/i.test(combined)) {
    return { tool: "bun", argv: [], exitCode: result.exitCode ?? null };
  }
  return { exitCode: result.exitCode ?? null };
}
async function reportToolRunForUnsuccessfulJob(args) {
  const invocation = inferFailureToolInvocation(args.result);
  const record = createToolRunRecordFromFailure({
    id: randomUUID2(),
    jobId: args.job.id,
    workerId: args.opts.workerId,
    sessionId: args.job.sessionId ?? null,
    phase: args.phase || args.job.kind,
    tool: invocation.tool,
    argv: invocation.argv,
    commandLine: invocation.commandLine,
    stdout: args.result.stdout,
    stderr: args.result.stderr ?? args.result.publishBlocked?.detail,
    summary: args.result.summary,
    detail: args.result.publishBlocked?.detail,
    exitCode: invocation.exitCode,
    durationMs: args.durationMs,
    finishedAt: new Date().toISOString(),
    envProfile: args.opts.docker ? "worker-container" : "worker-host",
    cwd: args.opts.repo,
    metadata: {
      publishBlocked: Boolean(args.result.publishBlocked),
      publishStage: args.result.publishBlocked?.stage ?? null
    }
  });
  if (record.failureClass === "unknown" && record.tool === "shell")
    return;
  try {
    const response = await postJsonWithTimeout(`${args.opts.server}/tool-runs`, args.headers, record, 5000);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(`[WorkerPals] Failed to record tool run telemetry for job ${args.job.id}: ${response.status} ${detail}`);
    }
  } catch (error) {
    console.warn(`[WorkerPals] Failed to record tool run telemetry for job ${args.job.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function buildWorkerLlmUsageEvent(job, result) {
  const sessionId = String(job.sessionId ?? CONFIG.sessionId ?? "").trim();
  if (!sessionId)
    return null;
  const llmConfig = workerLlmConfig(CONFIG);
  const explicitUsage = result.usage;
  if (explicitUsage && Number.isFinite(explicitUsage.promptTokens) && explicitUsage.promptTokens >= 0 && Number.isFinite(explicitUsage.completionTokens) && explicitUsage.completionTokens >= 0) {
    const promptTokens2 = Math.round(explicitUsage.promptTokens);
    const completionTokens2 = Math.round(explicitUsage.completionTokens);
    const totalTokens = Number.isFinite(explicitUsage.totalTokens) && (explicitUsage.totalTokens ?? 0) >= 0 ? Math.round(explicitUsage.totalTokens ?? promptTokens2 + completionTokens2) : promptTokens2 + completionTokens2;
    return {
      service: "workerpals",
      sessionId,
      backend: String(explicitUsage.backend ?? resolveExecutor(CONFIG)).trim() || resolveExecutor(CONFIG),
      modelId: String(explicitUsage.modelId ?? llmConfig.model).trim() || llmConfig.model,
      promptTokens: promptTokens2,
      completionTokens: completionTokens2,
      totalTokens,
      estimated: explicitUsage.estimated === true
    };
  }
  const promptSource = (() => {
    try {
      return JSON.stringify({
        kind: job.kind,
        params: job.params ?? {}
      });
    } catch {
      return `${job.kind}
${String(job.params?.instruction ?? job.params?.prompt ?? "")}`.trim();
    }
  })();
  const completionSource = [result.summary, result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join(`

`);
  const promptTokens = estimateTokensFromText3(promptSource);
  const completionTokens = estimateTokensFromText3(completionSource);
  return {
    service: "workerpals",
    sessionId,
    backend: resolveExecutor(CONFIG),
    modelId: llmConfig.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true
  };
}
async function reportWorkerLlmUsage(server, headers, job, result) {
  const payload = buildWorkerLlmUsageEvent(job, result);
  if (!payload)
    return;
  const response = await postJsonWithTimeout(`${server}/telemetry/llm-usage`, headers, payload);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`usage telemetry rejected (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
  }
}
function integrationBranchName() {
  const configuredIntegrationBranch = CONFIG.sourceControlManager.mainBranch.trim();
  if (configuredIntegrationBranch)
    return configuredIntegrationBranch;
  const configuredBaseRef = CONFIG.workerpals.baseRef.trim();
  if (!configuredBaseRef)
    return "main_agents";
  return configuredBaseRef.replace(/^origin\//, "").trim() || "main_agents";
}
function formatDurationMs(durationMs) {
  const ms = Math.max(0, Math.floor(durationMs));
  if (ms < 1000)
    return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0)
    return `${totalSeconds}s`;
  return `${minutes}m ${seconds}s`;
}
function resolveJobProgressLogEveryMs() {
  const raw = Number.parseInt(process.env.PUSHPALS_WORKERPAL_PROGRESS_LOG_MS ?? "", 10);
  if (Number.isFinite(raw) && raw === 0)
    return 0;
  if (Number.isFinite(raw) && raw >= 1e4)
    return raw;
  return DEFAULT_JOB_PROGRESS_LOG_EVERY_MS;
}
function sanitizeJobLogLine(line) {
  const cleaned = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
  return redactSensitiveText(cleaned);
}
function isNoisyProgressLine(line) {
  return /^(\uD83D\uDCE6 Installing \[\d+\/\d+\]|\uD83D\uDD0D Resolving\.\.\.|\uD83D\uDD12 Saving lockfile\.\.\.)$/.test(line);
}
function inferWorkerJobPhaseFromLogLine(line) {
  const text = String(line ?? "").trim();
  if (!text)
    return null;
  if (/Quality gate requested revision|Quality revision required|revision guidance/i.test(text)) {
    return "quality revision";
  }
  if (/test harness|React Native package|reactNativeMock|mock helper|mock was missing|expo-secure-store|import error|Cannot find module|does not provide an export|no exported member|Animated\.View|SettingsContext|skin validator/i.test(text)) {
    return "test harness repair";
  }
  if (/focused validation|focused checks|targeted test|focused test|new regression|focused regression|fast checks|rerunning .*regression|node --check/i.test(text)) {
    return "focused validation";
  }
  if (/ValidationGate|required validation|full .*test suite|whole Bun test|repo-level|bun test\b|bunx? tsc|typecheck|type check|bun run lint|web:e2e|browser smoke/i.test(text)) {
    return "full validation";
  }
  if (/creating commit|Publish blocked|publish-blocked|completion ref|enqueueCompletion/i.test(text)) {
    return "publishing";
  }
  if (/final diff|diff review|git diff|git status|whitespace|line-ending|line ending|pruning|remove unrelated|remaining diff|changed files/i.test(text)) {
    return "final diff review";
  }
  if (/editing|patch|implemented|adding|fixing|updating|wiring|in place|changes are in place|making .*change|tightening|restore|normalizing/i.test(text)) {
    return "editing";
  }
  if (/read|inspect|checking|locating|opening|artifact|screenshot|README|context|discover|search|rg |current checkout|worktree/i.test(text)) {
    return "discovering";
  }
  return null;
}
function mergeWorkerDiagnostics(base, extra) {
  return {
    ...base ?? {},
    ...extra,
    attempts: [...base?.attempts ?? [], ...extra.attempts ?? []],
    phaseSpans: [...base?.phaseSpans ?? [], ...extra.phaseSpans ?? []],
    validationRuns: [...base?.validationRuns ?? [], ...extra.validationRuns ?? []],
    patchSnapshots: [...base?.patchSnapshots ?? [], ...extra.patchSnapshots ?? []],
    terminal: base?.terminal || extra.terminal ? {
      ...base?.terminal ?? {},
      ...extra.terminal ?? {},
      metadata: {
        ...base?.terminal?.metadata ?? {},
        ...extra.terminal?.metadata ?? {}
      }
    } : undefined,
    metadata: {
      ...extra.metadata ?? {},
      ...base?.metadata ?? {}
    }
  };
}
function isCodexStartupStallResult(result) {
  const text = `${result.summary ?? ""}
${result.stderr ?? ""}
${result.stdout ?? ""}`.toLowerCase();
  return /stalled before first response|startup stall/.test(text);
}
function inferWorkerTerminalFailureClass(result) {
  if (result.publishBlocked?.stage === "validation")
    return "environment";
  if (result.validationBlocked)
    return "trusted_validation_required";
  if (result.ok)
    return "success";
  const summaryText = `${result.summary ?? ""}`.toLowerCase();
  const text = `${result.summary ?? ""}
${result.stderr ?? ""}
${result.stdout ?? ""}`.toLowerCase();
  if (isCodexStartupStallResult(result))
    return "codex_startup_stall";
  if (/validationgate|validation/.test(summaryText))
    return "validation";
  if (/timed out|timeout|signal 15|terminated|exit 143|exit 137/.test(text))
    return "timeout";
  if (/no publishable|non-publishable|node_modules/.test(text))
    return "artifact_only_no_publishable_patch";
  if (/validationgate|validation/.test(text))
    return "validation";
  if (/scopegate|scope/.test(text))
    return "scope";
  if (/criticgate|critic/.test(text))
    return "critic";
  if (/publish/.test(text))
    return "publish";
  return "worker_failure";
}
function buildPhaseSpanDiagnostics(spans, attempt, fallbackFinishedAtMs, outcome) {
  return spans.slice(0, 32).map((span) => {
    const startedAtMs = Math.max(0, span.startedAtMs);
    const finishedAtMs = Math.max(startedAtMs, span.finishedAtMs ?? fallbackFinishedAtMs);
    return {
      attempt,
      phase: span.phase,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      outcome
    };
  });
}
function shouldEmitDirectSessionJobEvent(options) {
  if (options.finalizing)
    return false;
  if (options.ok)
    return true;
  return !options.statusPersistedToServer;
}
function shouldRecycleWorkerForHeartbeatDegradation(options) {
  if (options.heartbeatDelivered)
    return false;
  if (!options.allowHeartbeatRecycle)
    return false;
  return options.transportStale;
}
function shouldRecycleWorkerForCodexUnavailableFailure(summary, stderr) {
  const text = `${summary}
${stderr ?? ""}`.toLowerCase();
  if (/stalled before first response|startup stall/.test(text))
    return true;
  return [
    "openai_codex cli is not installed",
    "openai_codex chatgpt auth is not ready",
    "openai_codex api_key auth requires openai_api_key",
    "openai_codex policy violation: codex cli workaround detected",
    "codex cli isn't available",
    "codex cli is mandatory in this backend"
  ].some((needle) => text.includes(needle));
}
function shouldDeferDockerCodexStartupStallForDirectRetry(options) {
  if (!options.dockerEnabled)
    return false;
  return isCodexStartupStallResult(options.result);
}
function workerRecycleExitCodeForResult(result) {
  return isCodexStartupStallResult(result) ? CODEX_STARTUP_STALL_WORKER_EXIT_CODE : CODEX_UNAVAILABLE_WORKER_EXIT_CODE;
}
async function shutdownDockerExecutorBeforeCodexRecycle(dockerExecutor) {
  if (!dockerExecutor)
    return;
  let timeout = null;
  let timedOut = false;
  try {
    await Promise.race([
      dockerExecutor.shutdown(),
      new Promise((resolvePromise) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolvePromise();
        }, CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS);
      })
    ]);
  } catch (err) {
    console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
  } finally {
    if (timeout)
      clearTimeout(timeout);
  }
  if (timedOut) {
    console.warn(`[WorkerPals] Docker shutdown cleanup exceeded ${CODEX_UNAVAILABLE_DOCKER_SHUTDOWN_GRACE_MS}ms; exiting worker for Codex recycle anyway.`);
  }
}
function parseArgs() {
  const args = process.argv.slice(2);
  let server = CONFIG.server.url;
  let pollMs = CONFIG.workerpals.pollMs;
  let heartbeatMs = CONFIG.workerpals.heartbeatMs;
  let repo = detectRepoRoot(process.cwd());
  let workerId = `workerpal-${randomUUID2().substring(0, 8)}`;
  let authToken = CONFIG.authToken;
  let docker = false;
  let requireDocker = CONFIG.workerpals.requireDocker;
  let dockerImage = CONFIG.workerpals.dockerImage;
  let gitToken = CONFIG.gitToken;
  let dockerTimeout = CONFIG.workerpals.dockerTimeoutMs;
  let dockerIdleTimeout = CONFIG.workerpals.dockerIdleTimeoutMs;
  let dockerNetworkMode = CONFIG.workerpals.dockerNetworkMode;
  let worktreeBaseRef = CONFIG.workerpals.baseRef || `origin/${integrationBranchName()}`;
  let labels = [...CONFIG.workerpals.labels];
  let failureCooldownMs = CONFIG.workerpals.failureCooldownMs;
  for (let i = 0;i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--poll":
        pollMs = parseInt(args[++i], 10);
        break;
      case "--heartbeat":
        heartbeatMs = parseInt(args[++i], 10);
        break;
      case "--repo":
        repo = detectRepoRoot(args[++i]);
        break;
      case "--workerId":
        workerId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
      case "--docker":
        docker = true;
        break;
      case "--require-docker":
        requireDocker = true;
        break;
      case "--docker-image":
        dockerImage = args[++i];
        break;
      case "--git-token":
        gitToken = args[++i];
        break;
      case "--docker-timeout":
        dockerTimeout = parseDockerTimeoutMs(args[++i]);
        break;
      case "--docker-idle-timeout":
        dockerIdleTimeout = parseInt(args[++i], 10);
        break;
      case "--docker-network":
        dockerNetworkMode = (args[++i] ?? "").trim() || dockerNetworkMode;
        break;
      case "--base-ref":
        worktreeBaseRef = args[++i];
        break;
      case "--labels":
        labels = args[++i].split(",").map((label) => label.trim()).filter(Boolean);
        break;
      case "--failure-cooldown-ms":
        failureCooldownMs = parseInt(args[++i], 10);
        break;
    }
  }
  const resolved = resolveLocalServerConnection({
    serverUrl: server,
    authToken,
    fallbackPort: CONFIG.server.port
  });
  if (resolved.serverWasNormalized) {
    LOG.warn(`Coerced server URL to local-only endpoint: ${resolved.serverUrl}`);
  }
  if (resolved.authTokenWasIgnored) {
    LOG.warn("Ignoring auth token in local-only mode.");
  }
  return {
    server: resolved.serverUrl,
    pollMs,
    heartbeatMs: Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : pollMs,
    repo,
    workerId,
    authToken: resolved.authToken,
    docker,
    requireDocker,
    dockerImage,
    gitToken,
    dockerTimeout: Number.isFinite(dockerTimeout) && dockerTimeout > 0 ? dockerTimeout : DEFAULT_DOCKER_TIMEOUT_MS,
    dockerIdleTimeout: Number.isFinite(dockerIdleTimeout) && dockerIdleTimeout >= 0 ? dockerIdleTimeout : 600000,
    dockerNetworkMode,
    worktreeBaseRef,
    labels,
    failureCooldownMs: Number.isFinite(failureCooldownMs) && failureCooldownMs >= 0 ? Math.min(failureCooldownMs, 300000) : 20000
  };
}
async function resolveGitRemoteUrl(repo, remote = "origin") {
  const result = await git2(repo, ["remote", "get-url", remote]);
  if (!result.ok)
    return "";
  return String(result.stdout ?? "").trim();
}
async function resolveWorkerGitToken(repo, configuredToken) {
  const remoteUrl = await resolveGitRemoteUrl(repo, "origin");
  const resolved = await resolveGitTokenForRemote({
    remoteUrl,
    configuredToken: configuredToken ?? "",
    cwd: repo
  });
  if (resolved.token) {
    console.log(`[WorkerPals] Git auth: backend=${resolved.backend} host=${resolved.host || "unknown"} source=${resolved.source}`);
  } else {
    console.warn(`[WorkerPals] Git auth token not found (backend=${resolved.backend}, host=${resolved.host || "unknown"}). Push-required jobs may fail.`);
  }
  return resolved.token;
}
async function runJob(job, repo, dockerExecutor, runtimeConfig, onLog) {
  if (dockerExecutor) {
    const result = await dockerExecutor.execute(job, onLog);
    return workerJobResultFromDocker(result);
  }
  return executeJob(job.kind, job.params, repo, onLog, runtimeConfig);
}
function workerJobResultFromDocker(result) {
  return {
    ok: result.ok,
    summary: result.summary,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    cooldownMs: result.cooldownMs,
    usage: result.usage,
    publishBlocked: result.publishBlocked,
    validationBlocked: result.validationBlocked,
    commit: result.commit,
    diagnostics: result.diagnostics
  };
}
function holdCommitForTrustedValidation(result, commit) {
  if (!result.validationBlocked) {
    return { result, completionCommit: commit };
  }
  if (!commit || commit.sha === "no-changes") {
    return {
      result: {
        ...result,
        ok: false,
        summary: `${result.validationBlocked.summary}; no publishable candidate commit was produced`,
        exitCode: 4
      },
      completionCommit: null
    };
  }
  return {
    result: {
      ...result,
      ok: true,
      summary: `${result.validationBlocked.summary}; queued for host-side validation`,
      exitCode: 0,
      publishBlocked: undefined
    },
    completionCommit: commit
  };
}
function failCompletionEnqueue(result, commit) {
  const validationDetail = result.validationBlocked?.detail;
  const detail = [
    validationDetail,
    `The candidate remains available at ${commit.branch} (${commit.sha}); completion handoff failed.`
  ].filter(Boolean).join(`
`);
  return {
    ...result,
    ok: false,
    summary: result.validationBlocked ? "Trusted validation could not be queued" : "Candidate publication could not be queued",
    stderr: [result.stderr, detail].filter(Boolean).join(`
`),
    exitCode: 4,
    publishBlocked: {
      summary: result.validationBlocked ? "Trusted validation could not be queued" : "Candidate publication could not be queued",
      detail,
      publicBranch: commit.publicBranch ?? commit.branch,
      localRef: commit.branch,
      sha: commit.sha,
      stage: result.validationBlocked ? "validation" : "push"
    }
  };
}
function buildTrustedValidationCompletionPayload(validationBlocked) {
  if (!validationBlocked)
    return {};
  return {
    trustedValidationCommands: [...validationBlocked.commands],
    trustedValidationSummary: validationBlocked.summary,
    trustedValidationDetail: validationBlocked.detail
  };
}
async function resolveWorktreeBaseRef(repo, requestedRef) {
  return resolveFreshWorktreeBaseRef({
    requestedRef,
    integrationBranch: integrationBranchName(),
    sourceBaseBranch: CONFIG.sourceControlManager.baseBranch,
    git: (args) => git2(repo, args),
    log: (level, message) => {
      const line = `[WorkerPals] ${message}`;
      if (level === "warn")
        console.warn(line);
      else
        console.log(line);
    }
  });
}
async function resolveWorktreeBaseRefForJob(repo, requestedRef, jobId, params) {
  return resolveReviewWorktreeBase({
    jobId,
    params,
    git: (args) => git2(repo, args),
    fallback: () => resolveWorktreeBaseRef(repo, requestedRef),
    log: (level, message) => {
      const line = `[WorkerPals] ${message}`;
      if (level === "warn")
        console.warn(line);
      else
        console.log(line);
    }
  });
}
async function createIsolatedWorktree(repo, jobId, baseRef, onLog) {
  const nonce = `${Date.now().toString(36).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
  const worktreePath = resolveDirectWorktreePath(repo, jobId, nonce);
  mkdirSync5(resolve12(worktreePath, ".."), { recursive: true });
  const addResult = await git2(repo, ["worktree", "add", "--detach", worktreePath, baseRef]);
  if (!addResult.ok) {
    throw new Error(`Failed to create isolated worktree: ${addResult.stderr}`);
  }
  linkDirectWorktreeDependencyArtifacts(repo, worktreePath, onLog);
  return worktreePath;
}
async function removeIsolatedWorktree(repo, worktreePath) {
  const removeResult = await git2(repo, ["worktree", "remove", "--force", worktreePath]);
  if (!removeResult.ok) {
    console.warn(`[WorkerPals] Worktree cleanup warning (${worktreePath}): ${removeResult.stderr || removeResult.stdout}`);
  }
  const pruneResult = await git2(repo, ["worktree", "prune"]);
  if (!pruneResult.ok) {
    console.warn(`[WorkerPals] Worktree prune warning (${worktreePath}): ${pruneResult.stderr || pruneResult.stdout}`);
  }
  const forced = await forceDeleteWorktreePath(worktreePath);
  if (!forced.removed) {
    throw new Error(`worktree path persisted after cleanup (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`);
  }
}
function sanitizePrText(value, max = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text)
    return "";
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
function inferPrArea(kind, changedPaths) {
  const looksLikeTests = (path) => {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return normalized.startsWith("tests/") || normalized.includes("/tests/") || normalized.endsWith(".test.ts") || normalized.endsWith(".test.tsx") || normalized.endsWith(".spec.ts") || normalized.endsWith(".spec.tsx") || normalized.endsWith("_test.py") || normalized.endsWith("_test.js") || normalized.endsWith("_test.ts");
  };
  if (changedPaths.some(looksLikeTests))
    return "tests";
  if (kind.startsWith("task."))
    return "repo";
  if (kind.startsWith("file."))
    return "repo";
  if (kind.startsWith("bun.test") || kind.startsWith("test."))
    return "tests";
  if (kind.startsWith("bun.lint"))
    return "repo";
  if (kind.startsWith("git."))
    return "repo";
  return "infra";
}
function inferChangedPaths(params) {
  if (!params)
    return [];
  const candidates = [];
  const add = (value) => {
    if (typeof value !== "string")
      return;
    const trimmed = value.trim();
    if (!trimmed)
      return;
    candidates.push(trimmed);
  };
  add(params.path);
  add(params.targetPath);
  add(params.from);
  add(params.to);
  if (Array.isArray(params.paths)) {
    for (const value of params.paths)
      add(value);
  }
  if (params.planning && typeof params.planning === "object") {
    const planning = params.planning;
    if (Array.isArray(planning.targetPaths)) {
      for (const value of planning.targetPaths)
        add(value);
    }
  }
  const deduped = [];
  const seen = new Set;
  for (const entry of candidates) {
    if (seen.has(entry))
      continue;
    seen.add(entry);
    deduped.push(entry);
    if (deduped.length >= 8)
      break;
  }
  return deduped;
}
function inferValidationSteps(params) {
  if (!params || !params.planning || typeof params.planning !== "object")
    return [];
  const planning = params.planning;
  const out = [];
  const seen = new Set;
  const candidates = [
    ...Array.isArray(planning.validationSteps) ? planning.validationSteps : [],
    ...Array.isArray(planning.requiredValidationSteps) ? planning.requiredValidationSteps.map((step) => `${step} (required by vision.md)`) : []
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string")
      continue;
    const step = sanitizePrText(raw, 200);
    if (!step || seen.has(step))
      continue;
    seen.add(step);
    out.push(step);
    if (out.length >= 10)
      break;
  }
  return out;
}
function inferTaskInstruction(params) {
  if (!params || typeof params.instruction !== "string")
    return "";
  return sanitizePrText(params.instruction, 240);
}
function isLowSignalResultSummary(summary) {
  const text = summary.trim().toLowerCase();
  if (!text)
    return true;
  return text.includes("executed task and modified") || text.includes("executed task via") || text.includes("no file changes detected") || text.includes("task summary");
}
function derivePrSummary(kind, params, resultSummary) {
  const workerSummary = sanitizePrText(resultSummary, 96);
  if (workerSummary && !isLowSignalResultSummary(workerSummary)) {
    return workerSummary;
  }
  const instruction = inferTaskInstruction(params);
  if (instruction) {
    let normalized = instruction.replace(/^(can you|could you|would you|please)\s+/i, "").replace(/\?+$/, "").trim();
    if (normalized.length > 0) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
      return sanitizePrText(normalized, 96);
    }
  }
  return sanitizePrText(`${kind} update`, 96);
}
function inferPrTitleType(kind, area) {
  if (area === "tests")
    return "test";
  if (kind.startsWith("task.") || kind.startsWith("file."))
    return "fix";
  return "chore";
}
function toBulletList(lines) {
  if (lines.length === 0)
    return "- None";
  return lines.map((line) => line.startsWith("- ") ? line : `- ${line}`).join(`
`);
}
function buildCompletionPrMetadataFallback(args) {
  const changesSection = args.changedPaths.length > 0 ? args.changedPaths.map((path) => `- Updated \`${sanitizePrText(path, 180)}\``) : [`- Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];
  const validationSection = args.validationSteps.length > 0 ? args.validationSteps.map((step) => `- ${sanitizePrText(step, 200)}`) : ["- Not specified by planner"];
  const body = [
    "### Summary",
    `- Apply WorkerPal completion \`${sanitizePrText(args.job.id, 64)}\` to \`${sanitizePrText(args.integrationBranch, 64)}\`.`,
    `- Integrate commit \`${sanitizePrText(args.commit.sha, 64)}\` from \`${sanitizePrText(args.commit.branch, 120)}\`.`,
    `- Worker: \`${sanitizePrText(args.workerId, 64)}\`.`,
    `- Canonical task request: ${args.taskInstruction ? `\`${sanitizePrText(args.taskInstruction, 220)}\`` : "_(not provided)_"}`,
    "",
    "### Motivation / Context",
    "- Preserve and review autonomous worker output before final merge to base branch.",
    "- Keep integration branch current with queued worker completions.",
    "",
    "### Changes",
    ...changesSection,
    "",
    "### Testing / Validation",
    ...validationSection,
    "- Worker did not provide explicit per-command pass/fail logs in completion summary.",
    "",
    "### Impact / Risk",
    `- Risk level: ${args.risk} (automated worker-generated change; maintainer review required).`,
    "- No secrets or credentials are expected in this PR body.",
    "",
    "### SourceControlManager Note",
    "- Use this worker-provided PR title/body when creating the integration PR.",
    "",
    "### Checklist",
    "- [ ] Tests added/updated where appropriate",
    "- [ ] Validation commands run (or noted as not run)",
    "- [ ] Docs/comments updated if needed",
    "- [ ] No sensitive data (secrets/tokens) committed"
  ].join(`
`);
  return { title: args.title, body };
}
function buildCompletionPrMetadata(args) {
  const changedPaths = inferChangedPaths(args.job.params);
  const validationSteps = inferValidationSteps(args.job.params);
  const taskInstruction = inferTaskInstruction(args.job.params);
  const area = inferPrArea(args.job.kind, changedPaths);
  const prType = inferPrTitleType(args.job.kind, area);
  const summary = derivePrSummary(args.job.kind, args.job.params, args.resultSummary);
  const title = `${prType}(${area}): ${summary}`;
  const risk = args.job.kind.startsWith("task.") || args.job.kind.startsWith("file.") ? "medium" : "low";
  const changesLines = changedPaths.length > 0 ? changedPaths.map((path) => `Updated \`${sanitizePrText(path, 180)}\``) : [`Updated worker completion for \`${sanitizePrText(args.job.kind, 80)}\``];
  const validationLines = validationSteps.length > 0 ? validationSteps.map((step) => `Planned: ${sanitizePrText(step, 200)}`) : ["No explicit planner validation steps were provided."];
  const motivationLines = [
    "Preserve and review autonomous worker output before final merge to base branch.",
    "Keep integration branch current with queued worker completions."
  ];
  const testingLines = [
    ...validationLines,
    "Worker completion summary did not include explicit command pass/fail output."
  ];
  const impactLines = [
    `Risk level: ${risk} (automated worker-generated change; maintainer review required).`,
    "No secrets or credentials are expected in this PR body."
  ];
  const replacements = {
    title,
    area: sanitizePrText(area, 48),
    summary: sanitizePrText(summary, 120),
    completion_id: sanitizePrText(args.job.id, 64),
    task_id: sanitizePrText(args.job.taskId, 64),
    job_kind: sanitizePrText(args.job.kind, 64),
    worker_id: sanitizePrText(args.workerId, 64),
    integration_branch: sanitizePrText(args.integrationBranch, 64),
    commit_sha: sanitizePrText(args.commit.sha, 64),
    commit_branch: sanitizePrText(args.commit.branch, 140),
    result_summary: sanitizePrText(args.resultSummary, 240),
    task_instruction: taskInstruction || "(not provided)",
    motivation_lines: toBulletList(motivationLines),
    target_paths_lines: toBulletList(changedPaths.length > 0 ? changedPaths.map((path) => `\`${sanitizePrText(path, 180)}\``) : ["None identified"]),
    validation_plan_lines: toBulletList(validationLines),
    changes_lines: toBulletList(changesLines),
    testing_lines: toBulletList(testingLines),
    impact_lines: toBulletList(impactLines),
    risk_level: risk
  };
  const isInstructionalTemplateOutput = (value) => {
    const text = value.trim().toLowerCase();
    if (!text)
      return true;
    if (text.includes("pr description writer"))
      return true;
    if (text.includes("absolute prohibitions"))
      return true;
    if (text.includes("required structure"))
      return true;
    if (text.includes("{{"))
      return true;
    return false;
  };
  try {
    const body = loadPromptTemplate("workerpals/pr_description.md", replacements).trim();
    if (!isInstructionalTemplateOutput(body)) {
      return { title, body };
    }
    console.warn(`[WorkerPals] PR description template appears instructional/unrendered; using deterministic fallback metadata.`);
  } catch (err) {
    console.warn(`[WorkerPals] Failed to load PR description template: ${String(err)}`);
  }
  return buildCompletionPrMetadataFallback({
    ...args,
    title,
    changedPaths,
    taskInstruction,
    validationSteps,
    risk
  });
}
function parseLsRemoteSha(output) {
  const firstLine = (output ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const match = firstLine.match(/^([0-9a-f]{40})\s+/i);
  return match ? match[1] : null;
}
async function resolveReReviewNoChangeCommit(repo, params) {
  const branch = resolveReviewNoChangeCompletionBranch(params);
  if (!branch)
    return null;
  const remoteRef2 = `refs/heads/${branch}`;
  const lsRemote = await git2(repo, ["ls-remote", "origin", remoteRef2]);
  if (lsRemote.ok) {
    const sha = parseLsRemoteSha(lsRemote.stdout);
    if (sha)
      return { branch, sha };
  }
  const localRefs = [branch, `refs/heads/${branch}`, `origin/${branch}`];
  for (const ref of localRefs) {
    const revParse = await git2(repo, ["rev-parse", "--verify", ref]);
    if (revParse.ok) {
      const sha = revParse.stdout.trim();
      if (sha)
        return { branch, sha };
    }
  }
  return null;
}
function failNoChangeReviewFixJob(jobId, result) {
  return {
    ...result,
    ok: false,
    summary: `Rejected review-fix job ${jobId} produced no code changes; refusing unchanged branch re-review.`,
    stderr: [
      result.stderr,
      "Review-fix jobs must make at least one concrete code/test/docs change before requesting another review.",
      "If the reviewer feedback is invalid, commit a narrow explanatory change that documents the decision; unchanged branch re-review is refused."
    ].filter(Boolean).join(`
`),
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 4
  };
}
function taskExecuteOrigin2(params) {
  if (!params)
    return "user";
  if (params.origin === "autonomy")
    return "autonomy";
  const autonomy = params.autonomy;
  return autonomy && typeof autonomy === "object" && !Array.isArray(autonomy) ? "autonomy" : "user";
}
function normalizeReviewLeaseBranch(value) {
  const branch = String(value ?? "").trim().replace(/^refs\/heads\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!branch || branch.includes("..") || branch.includes("@{") || branch.endsWith(".") || branch.endsWith(".lock") || /[~^:?*\[\]\s]/.test(branch)) {
    return "";
  }
  return branch;
}
async function enqueueCompletion(server, headers, workerId, integrationBranch, job, commit, result) {
  try {
    const reviewAgent = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" ? job.params.reviewAgent : null;
    const prUrl = reviewAgent && typeof reviewAgent.prUrl === "string" && reviewAgent.prUrl.trim().length > 0 ? reviewAgent.prUrl.trim() : null;
    const pr = buildCompletionPrMetadata({
      workerId,
      integrationBranch,
      job,
      commit,
      resultSummary: result.summary
    });
    const resolutionType = String(reviewAgent?.resolutionType ?? "").trim().toLowerCase();
    const reviewTargetBranch = normalizeReviewLeaseBranch(reviewAgent?.prHeadRef);
    const reviewExpectedHeadSha = String(reviewAgent?.prHeadSha ?? "").trim().toLowerCase();
    const reviewExpectedBaseSha = String(reviewAgent?.prBaseSha ?? "").trim().toLowerCase();
    const reviewBaseBranch = normalizeReviewLeaseBranch(reviewAgent?.prBaseRef);
    const completionPrBody = (resolutionType === "review_fix" || resolutionType === "merge_conflict" || resolutionType === "integration_reconcile") && reviewTargetBranch && reviewExpectedHeadSha ? [
      pr.body,
      "",
      "<!-- DO NOT EDIT: PushPals review publication lease below -->",
      `<!-- pushpals-reviewTargetBranch: ${reviewTargetBranch} -->`,
      ...reviewBaseBranch ? [`<!-- pushpals-reviewBaseBranch: ${reviewBaseBranch} -->`] : [],
      `<!-- pushpals-reviewExpectedHeadSha: ${reviewExpectedHeadSha} -->`,
      ...reviewExpectedBaseSha ? [`<!-- pushpals-reviewExpectedBaseSha: ${reviewExpectedBaseSha} -->`] : []
    ].join(`
`) : pr.body;
    const response = await postJsonWithTimeout(`${server}/completions/enqueue`, headers, {
      jobId: job.id,
      sessionId: job.sessionId,
      origin: taskExecuteOrigin2(job.params),
      commitSha: commit.sha,
      branch: commit.branch,
      message: `${job.kind}: ${job.taskId} (worker PR metadata attached)`,
      prUrl,
      prTitle: pr.title,
      prBody: completionPrBody,
      jobResultSummary: result.summary,
      jobArtifacts: [
        ...result.stdout ? [{ kind: "stdout", text: result.stdout }] : [],
        ...result.stderr ? [{ kind: "stderr", text: result.stderr }] : []
      ],
      ...buildTrustedValidationCompletionPayload(result.validationBlocked)
    });
    if (response.ok) {
      console.log(`[WorkerPals] Enqueued completion for job ${job.id} (commit ${commit.sha})`);
      return true;
    } else {
      console.error(`[WorkerPals] Failed to enqueue completion: ${response.status} ${await response.text()}`);
      return false;
    }
  } catch (err) {
    console.error(`[WorkerPals] Failed to enqueue completion:`, err);
    return false;
  }
}
function buildWorkerHeaders(authToken) {
  const headers = { "Content-Type": "application/json" };
  if (authToken)
    headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}
async function failActiveJobOnShutdown(opts, headers, runtimeState, transport, signalName) {
  const activeJobId = runtimeState.currentJobId;
  if (!activeJobId)
    return;
  const message = "Worker process shutting down during claimed job";
  const detail = `worker=${opts.workerId}; signal=${signalName}; action=fail-claimed-job-on-shutdown`;
  let statusPersistedToServer = false;
  try {
    const response = await postJsonWithTimeout(`${opts.server}/jobs/${activeJobId}/fail`, headers, {
      message,
      detail
    });
    statusPersistedToServer = response.ok;
  } catch (err) {
    console.error(`[WorkerPals] Failed to mark active job ${activeJobId} as failed during shutdown:`, err);
  }
  if (runtimeState.currentSessionId && shouldEmitDirectSessionJobEvent({ ok: false, statusPersistedToServer })) {
    await transport.queueSessionCommand(runtimeState.currentSessionId, {
      type: "job_failed",
      payload: {
        jobId: activeJobId,
        message,
        detail
      },
      from: `worker:${opts.workerId}`
    }, { priority: "high" });
  }
}
async function deferClaimedJobForMaintenance(opts, headers, jobId, deferMs, options = {}) {
  try {
    const body = {
      workerId: opts.workerId,
      deferMs
    };
    if (Object.prototype.hasOwnProperty.call(options, "targetWorkerId")) {
      body.targetWorkerId = options.targetWorkerId;
    }
    if (options.reason) {
      body.reason = options.reason;
    }
    const response = await postJsonWithTimeout(`${opts.server}/jobs/${jobId}/defer`, headers, body);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      return {
        ok: false,
        message: payload.message || `HTTP ${response.status}`
      };
    }
    return {
      ok: true,
      availableAt: payload.availableAt
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
async function workerLoop(opts, dockerExecutor, runtimeState, transport, requestWorkerRestart) {
  const headers = buildWorkerHeaders(opts.authToken);
  console.log(`[WorkerPals ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(`[WorkerPals ${opts.workerId}] Docker mode enabled (${opts.dockerImage}, network=${opts.dockerNetworkMode})`);
  } else {
    console.log(`[WorkerPals ${opts.workerId}] Direct mode with isolated worktrees enabled`);
  }
  console.log(`[WorkerPals ${opts.workerId}] Executor backend: ${resolveExecutor(CONFIG)}`);
  const heartbeatEveryMs = Math.max(1000, opts.heartbeatMs);
  const claimTimeoutMs = Math.max(4000, Math.min(15000, opts.pollMs * 3));
  let lastHeartbeatAt = 0;
  const buildHeartbeatPayload = (status, currentJobId) => ({
    status,
    currentJobId,
    capabilities: {
      docker: opts.docker,
      labels: opts.labels,
      executor: resolveExecutor(CONFIG),
      requireDocker: opts.requireDocker
    },
    details: {
      repo: opts.repo,
      baseRef: opts.worktreeBaseRef,
      dockerImage: opts.docker ? opts.dockerImage : null,
      dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null
    }
  });
  const maybeHeartbeat = async (status, currentJobId = null, force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatEveryMs)
      return;
    const ok = await transport.sendHeartbeat(buildHeartbeatPayload(status, currentJobId));
    if (ok)
      lastHeartbeatAt = now;
  };
  await maybeHeartbeat("idle", null, true);
  while (!runtimeState.shutdownRequested) {
    try {
      await maybeHeartbeat("idle");
      const claimRes = await postJsonWithTimeout(`${opts.server}/jobs/claim`, headers, { workerId: opts.workerId }, claimTimeoutMs);
      if (claimRes.ok) {
        const data = await claimRes.json();
        const job = data.job;
        if (job) {
          if (dockerExecutor && dockerExecutor.shouldPrepareMergeConflictJobBeforeExecution(job)) {
            const deferMs = dockerExecutor.recommendedMergeConflictDeferMs();
            const deferred = await deferClaimedJobForMaintenance(opts, headers, job.id, deferMs);
            if (!deferred.ok) {
              console.warn(`[WorkerPals] Failed to defer merge-conflict job ${job.id} for image refresh; falling back to claimed execution path: ${deferred.message || "unknown error"}`);
            } else {
              console.log(`[WorkerPals] Deferred merge-conflict job ${job.id} until ${deferred.availableAt ?? "maintenance complete"} while refreshing Docker image outside claimed-job lifetime.`);
              const maintenanceHeartbeat = setInterval(() => {
                transport.sendHeartbeat({
                  ...buildHeartbeatPayload("idle", null),
                  details: {
                    repo: opts.repo,
                    baseRef: opts.worktreeBaseRef,
                    dockerImage: opts.docker ? opts.dockerImage : null,
                    dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null,
                    maintenance: "merge_conflict_image_refresh",
                    deferredJobId: job.id
                  }
                });
              }, heartbeatEveryMs);
              try {
                await maybeHeartbeat("idle", null, true);
                await dockerExecutor.prepareMergeConflictJobEnvironment(job);
              } catch (error) {
                const detail = redactSensitiveText(error instanceof Error ? error.stack || error.message : String(error));
                console.error(`[WorkerPals] Merge-conflict environment preparation failed for ${job.id}: ${detail}`);
                try {
                  const failResponse = await postJsonWithTimeout(`${opts.server}/jobs/${job.id}/fail-deferred`, headers, {
                    workerId: opts.workerId,
                    message: "Merge-conflict environment preparation failed",
                    detail
                  });
                  const failPayload = await failResponse.json().catch(() => ({}));
                  if (!failResponse.ok || !failPayload.ok) {
                    console.error(`[WorkerPals] Failed to mark deferred job ${job.id} as failed: ${failPayload.message || `HTTP ${failResponse.status}`}`);
                  }
                } catch (failErr) {
                  console.error(`[WorkerPals] Failed to mark deferred job ${job.id} as failed: ${failErr instanceof Error ? failErr.message : String(failErr)}`);
                }
              } finally {
                clearInterval(maintenanceHeartbeat);
              }
              await maybeHeartbeat("idle", null, true);
              continue;
            }
          }
          runtimeState.currentJobId = job.id;
          runtimeState.currentSessionId = job.sessionId ?? null;
          console.log(`[WorkerPals] Claimed job ${job.id} (${job.kind})`);
          await maybeHeartbeat("busy", job.id, true);
          let allowHeartbeatRecycle = true;
          const busyHeartbeat = setInterval(() => {
            transport.sendHeartbeat(buildHeartbeatPayload("busy", job.id)).then((ok) => {
              if (!shouldRecycleWorkerForHeartbeatDegradation({
                heartbeatDelivered: ok,
                allowHeartbeatRecycle,
                transportStale: transport.shouldRecycleBusyWorker()
              })) {
                return;
              }
              requestWorkerRestart(`heartbeat transport stale while claimed job ${job.id} is still running`);
            });
          }, heartbeatEveryMs);
          if (job.sessionId) {
            await transport.queueSessionCommand(job.sessionId, {
              type: "job_claimed",
              payload: { jobId: job.id, workerId: opts.workerId },
              from: `worker:${opts.workerId}`
            }, { priority: "high" });
          }
          let stdoutSeq = 0;
          let stderrSeq = 0;
          let lastCleanLog = "";
          let lastCleanLogAt = 0;
          const jobClaimedAtMs = Date.now();
          let lastForwardedJobLogAt = jobClaimedAtMs;
          let currentJobPhase = null;
          const phaseSpans = [];
          const noteJobPhase = (phase, atMs = Date.now()) => {
            if (!phase || phase === currentJobPhase)
              return;
            const previous = phaseSpans[phaseSpans.length - 1];
            if (previous && previous.finishedAtMs == null)
              previous.finishedAtMs = atMs;
            currentJobPhase = phase;
            phaseSpans.push({ phase, startedAtMs: atMs });
          };
          const emitJobLog = job.sessionId ? (stream, line) => {
            const cleaned = sanitizeJobLogLine(line);
            if (!cleaned)
              return false;
            if (isNoisyProgressLine(cleaned))
              return false;
            const now = Date.now();
            if (cleaned === lastCleanLog && now - lastCleanLogAt < 1000)
              return false;
            lastCleanLog = cleaned;
            lastCleanLogAt = now;
            lastForwardedJobLogAt = now;
            noteJobPhase(inferWorkerJobPhaseFromLogLine(cleaned), now);
            const logTs = new Date(now).toISOString();
            const seq = stream === "stdout" ? ++stdoutSeq : ++stderrSeq;
            transport.queueSessionCommand(job.sessionId, {
              type: "job_log",
              payload: {
                jobId: job.id,
                stream,
                seq,
                line: cleaned,
                ts: logTs,
                phase: currentJobPhase
              },
              from: `worker:${opts.workerId}`
            }, { droppable: true });
            transport.queueJobLog(job.id, {
              stream,
              seq,
              message: cleaned,
              ts: logTs
            });
            return true;
          } : undefined;
          const onLog = emitJobLog ? (stream, line) => {
            const cleaned = sanitizeJobLogLine(line);
            if (LOG.isDebugEnabled() && cleaned)
              LOG.debug(`[${stream}] ${cleaned}`);
            emitJobLog(stream, line);
          } : undefined;
          const jobProgressLogEveryMs = resolveJobProgressLogEveryMs();
          const jobProgressTimer = emitJobLog && jobProgressLogEveryMs > 0 ? setInterval(() => {
            const now = Date.now();
            const quietForMs = Math.max(0, now - lastForwardedJobLogAt);
            if (quietForMs < jobProgressLogEveryMs)
              return;
            emitJobLog("stdout", `[WorkerPals] Job ${job.id} still running after ${formatDurationMs(now - jobClaimedAtMs)} (kind=${job.kind}, worker=${opts.workerId}, phase=${currentJobPhase ?? "unknown"}, quiet_for=${formatDurationMs(quietForMs)}).`);
          }, jobProgressLogEveryMs) : null;
          let directWorktreePath = null;
          let executionRepo = opts.repo;
          let result = null;
          let recycleWorkerAfterJob = false;
          try {
            let parsedParams = typeof job.params === "string" ? JSON.parse(job.params) : job.params;
            if (!dockerExecutor) {
              const jobBaseRef = await resolveWorktreeBaseRefForJob(opts.repo, opts.worktreeBaseRef, job.id, parsedParams);
              directWorktreePath = await createIsolatedWorktree(opts.repo, job.id, jobBaseRef, onLog);
              executionRepo = directWorktreePath;
              if (isMergeConflictResolutionParams(parsedParams)) {
                const prepared = await prepareMergeConflictWorktreeOnHost(executionRepo, job.id, parsedParams, onLog);
                parsedParams = applyMergeConflictExecutionHints(parsedParams, prepared);
              }
            }
            const jobData = {
              id: job.id,
              taskId: job.taskId,
              kind: job.kind,
              params: parsedParams,
              sessionId: job.sessionId
            };
            let cooldownAfterJobMs = 0;
            const jobStartedAtMs = Date.now();
            try {
              result = await runJob(jobData, executionRepo, dockerExecutor, CONFIG, onLog);
              cooldownAfterJobMs = Number.isFinite(result.cooldownMs) && (result.cooldownMs ?? 0) > 0 ? Math.floor(result.cooldownMs ?? 0) : 0;
            } catch (err) {
              if (err instanceof DockerExecutionExhaustedError) {
                cooldownAfterJobMs = Math.max(opts.failureCooldownMs, Number.isFinite(err.cooldownMs) ? err.cooldownMs : 0);
              }
              const errorSummary = compactWorkerError(err);
              result = {
                ok: false,
                summary: `Job execution failed before completion: ${errorSummary}`,
                stderr: String(err),
                ...cooldownAfterJobMs > 0 ? { cooldownMs: cooldownAfterJobMs } : {}
              };
            }
            if (!result) {
              result = {
                ok: false,
                summary: "Job execution failed before completion",
                stderr: "Worker result was not produced"
              };
            }
            const jobDurationMs = Math.max(0, Date.now() - jobStartedAtMs);
            allowHeartbeatRecycle = false;
            await transport.flush();
            try {
              await reportWorkerLlmUsage(opts.server, headers, jobData, result);
            } catch (err) {
              console.warn(`[WorkerPals] Failed to report LLM usage for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
            let completionCommit = null;
            if (result.ok && shouldCommit(job.kind, CONFIG)) {
              if (result.commit) {
                if (result.commit.sha !== "no-changes") {
                  completionCommit = result.commit;
                } else if (!shouldEnqueueNoChangeReviewCompletion(parsedParams)) {
                  console.warn(`[WorkerPals] Job ${job.id} produced no code changes for a rejected review-fix request; marking the job failed instead of enqueueing unchanged branch re-review.`);
                  result = failNoChangeReviewFixJob(job.id, result);
                } else {
                  const reReviewCommit = await resolveReReviewNoChangeCommit(executionRepo, parsedParams);
                  if (reReviewCommit) {
                    completionCommit = reReviewCommit;
                    console.log(`[WorkerPals] Job ${job.id} produced no file changes; enqueuing re-review completion for ${reReviewCommit.branch} @ ${reReviewCommit.sha.slice(0, 8)}.`);
                  } else {
                    console.log(`[WorkerPals] Job ${job.id} produced no file changes to commit.`);
                  }
                }
              } else if (dockerExecutor) {
                result = {
                  ok: false,
                  summary: `Docker job ${job.id} completed without commit metadata for ${job.kind}`,
                  stderr: [
                    result.stderr,
                    "Refusing unsafe host-side commit fallback while Docker mode is active."
                  ].filter(Boolean).join(`
`)
                };
              } else {
                console.log(`[WorkerPals] Job ${job.id} modified files, creating commit...`);
                const commitResult = await createJobCommit(executionRepo, opts.workerId, {
                  id: job.id,
                  taskId: job.taskId,
                  kind: job.kind,
                  params: parsedParams,
                  sessionId: job.sessionId,
                  context: "host",
                  deferPublication: Boolean(result.validationBlocked)
                }, CONFIG);
                if (commitResult.ok && commitResult.sha && commitResult.branch) {
                  if (commitResult.sha !== "no-changes") {
                    completionCommit = {
                      branch: commitResult.branch,
                      sha: commitResult.sha,
                      publicBranch: commitResult.publicBranch
                    };
                  } else if (!shouldEnqueueNoChangeReviewCompletion(parsedParams)) {
                    console.warn(`[WorkerPals] Job ${job.id} produced no staged review-fix changes; marking the job failed instead of enqueueing unchanged branch re-review.`);
                    result = failNoChangeReviewFixJob(job.id, result);
                  }
                } else if (commitResult.publishBlocked) {
                  result = {
                    ...result,
                    ok: false,
                    summary: commitResult.publishBlocked.summary,
                    stderr: [result.stderr, commitResult.error].filter(Boolean).join(`
`),
                    publishBlocked: commitResult.publishBlocked
                  };
                  console.error(`[WorkerPals] Publish blocked: ${commitResult.error}`);
                } else if (commitResult.error) {
                  console.error(`[WorkerPals] Failed to create commit: ${commitResult.error}`);
                }
              }
            }
            ({ result, completionCommit } = holdCommitForTrustedValidation(result, completionCommit));
            let completionEnqueued = false;
            if (completionCommit) {
              const enqueued = await enqueueCompletion(opts.server, headers, opts.workerId, integrationBranchName(), {
                id: job.id,
                taskId: job.taskId,
                kind: job.kind,
                sessionId: job.sessionId,
                params: parsedParams
              }, completionCommit, result);
              if (!enqueued) {
                result = failCompletionEnqueue(result, completionCommit);
              } else {
                completionEnqueued = true;
              }
            }
            const finalizedAtMs = Date.now();
            const jobAttemptRaw = Number(job.attempt ?? 1);
            const jobAttempt = Number.isFinite(jobAttemptRaw) && jobAttemptRaw > 0 ? Math.floor(jobAttemptRaw) : 1;
            const llm = workerLlmConfig(CONFIG);
            const terminalFailureClass = completionEnqueued ? result.validationBlocked ? "trusted_validation_required" : "publication_pending" : inferWorkerTerminalFailureClass(result);
            result = {
              ...result,
              diagnostics: mergeWorkerDiagnostics(result.diagnostics, {
                attempts: [
                  {
                    attempt: jobAttempt,
                    workerId: opts.workerId,
                    backend: resolveExecutor(CONFIG),
                    model: llm.model,
                    startedAt: new Date(jobStartedAtMs).toISOString(),
                    finishedAt: new Date(finalizedAtMs).toISOString(),
                    durationMs: Math.max(0, finalizedAtMs - jobStartedAtMs),
                    terminalReason: result.summary,
                    exitCode: result.exitCode ?? (result.ok ? 0 : 1),
                    metadata: {
                      docker: Boolean(dockerExecutor),
                      jobKind: job.kind,
                      provider: llm.provider,
                      cooldownMs: result.cooldownMs ?? 0
                    }
                  }
                ],
                phaseSpans: buildPhaseSpanDiagnostics(phaseSpans, jobAttempt, finalizedAtMs, completionEnqueued ? "finalizing" : result.ok ? "completed" : result.publishBlocked ? "publish_blocked" : "failed"),
                terminal: {
                  failureClass: terminalFailureClass,
                  terminalStage: terminalFailureClass === "codex_startup_stall" ? "executor_startup" : completionEnqueued ? result.validationBlocked ? "trusted_environment_validation" : "publication" : currentJobPhase ?? (result.ok ? "completed" : "worker"),
                  executorBackend: resolveExecutor(CONFIG),
                  summary: result.summary,
                  watchdogFired: /watchdog|rollout coach|stalled before first response|startup stall|timed out|timeout|signal 15|terminated|exit 143|exit 137/i.test(`${result.summary}
${result.stderr ?? ""}
${result.stdout ?? ""}`),
                  metadata: {
                    workerId: opts.workerId,
                    docker: Boolean(dockerExecutor),
                    jobKind: job.kind,
                    phase: currentJobPhase
                  }
                }
              })
            };
            await persistWorkerDiagnostics(opts.server, headers, job.id, result.diagnostics);
            let statusPersistedToServer = false;
            let deferredForDirectRetry = false;
            if (result.publishBlocked) {
              await reportToolRunForUnsuccessfulJob({
                opts,
                headers,
                job,
                result,
                durationMs: jobDurationMs,
                phase: `publish:${result.publishBlocked.stage}`
              });
              const response = await postJsonWithTimeout(`${opts.server}/jobs/${job.id}/publish-blocked`, headers, {
                message: result.summary,
                detail: redactSensitiveText(result.stderr ?? ""),
                publishBlocked: result.publishBlocked,
                durationMs: jobDurationMs,
                diagnostics: result.diagnostics
              });
              statusPersistedToServer = response.ok;
              console.log(`[WorkerPals] Job ${job.id} publish-blocked in ${formatDurationMs(jobDurationMs)}: ${result.summary}`);
            } else if (result.ok && completionEnqueued) {
              statusPersistedToServer = true;
              console.log(`[WorkerPals] Job ${job.id} is finalizing after ${formatDurationMs(jobDurationMs)}: ${result.summary}`);
            } else if (result.ok) {
              const reviewAgent = parsedParams.reviewAgent && typeof parsedParams.reviewAgent === "object" ? parsedParams.reviewAgent : null;
              const jobPrUrl = reviewAgent && typeof reviewAgent.prUrl === "string" && reviewAgent.prUrl.trim().length > 0 ? reviewAgent.prUrl.trim() : null;
              const response = await postJsonWithTimeout(`${opts.server}/jobs/${job.id}/complete`, headers, {
                summary: result.summary,
                durationMs: jobDurationMs,
                prUrl: jobPrUrl,
                diagnostics: result.diagnostics,
                artifacts: [
                  ...result.stdout ? [{ kind: "stdout", text: result.stdout }] : [],
                  ...result.stderr ? [{ kind: "stderr", text: result.stderr }] : []
                ]
              });
              statusPersistedToServer = response.ok;
              console.log(`[WorkerPals] Job ${job.id} completed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`);
            } else {
              const failedResult = result;
              let unsuccessfulToolRunReported = false;
              const reportUnsuccessfulToolRun = async (phase) => {
                if (unsuccessfulToolRunReported)
                  return;
                unsuccessfulToolRunReported = true;
                await reportToolRunForUnsuccessfulJob({
                  opts,
                  headers,
                  job,
                  result: failedResult,
                  durationMs: jobDurationMs,
                  phase
                });
              };
              const failCurrentJob = async () => {
                await reportUnsuccessfulToolRun(job.kind);
                const response = await postJsonWithTimeout(`${opts.server}/jobs/${job.id}/fail`, headers, {
                  message: failedResult.summary,
                  detail: redactSensitiveText(failedResult.stderr ?? ""),
                  durationMs: jobDurationMs,
                  diagnostics: failedResult.diagnostics
                });
                statusPersistedToServer = response.ok;
                console.log(`[WorkerPals] Job ${job.id} failed in ${formatDurationMs(jobDurationMs)}: ${failedResult.summary}`);
                recycleWorkerAfterJob = shouldRecycleWorkerForCodexUnavailableFailure(failedResult.summary, failedResult.stderr);
                if (recycleWorkerAfterJob) {
                  console.error(`[WorkerPals] Codex backend unavailable for job ${job.id}; terminating this worker for replacement.`);
                }
              };
              if (shouldDeferDockerCodexStartupStallForDirectRetry({
                dockerEnabled: Boolean(dockerExecutor),
                result: failedResult
              })) {
                await reportUnsuccessfulToolRun("worker:docker-codex-startup-stall-defer");
                const deferred = await deferClaimedJobForMaintenance(opts, headers, job.id, CODEX_STARTUP_STALL_DIRECT_RETRY_DEFER_MS, {
                  targetWorkerId: null,
                  reason: "codex_startup_stall_direct_retry"
                });
                if (deferred.ok) {
                  deferredForDirectRetry = true;
                  statusPersistedToServer = true;
                  recycleWorkerAfterJob = true;
                  console.warn(`[WorkerPals] Deferred job ${job.id} after Docker Codex startup stall until ${deferred.availableAt ?? "a direct WorkerPal retry"}; recycling this worker so RemoteBuddy can spawn a direct isolated-worktree WorkerPal.`);
                } else {
                  console.warn(`[WorkerPals] Failed to defer Docker Codex startup-stall job ${job.id}; marking failed: ${deferred.message || "unknown error"}`);
                  await failCurrentJob();
                }
              } else {
                await failCurrentJob();
              }
            }
            if (job.sessionId && !deferredForDirectRetry) {
              const jobOrigin = taskExecuteOrigin2(parsedParams);
              const responseMode = String(parsedParams.responseMode ?? "").trim().toLowerCase();
              if (responseMode === "assistant_message" && !completionEnqueued) {
                const maxResponseCharsRaw = Number(parsedParams.maxResponseChars ?? 8000);
                const maxResponseChars = Number.isFinite(maxResponseCharsRaw) && maxResponseCharsRaw >= 256 ? Math.min(maxResponseCharsRaw, 20000) : 8000;
                const rawText = result.ok ? String(result.stdout ?? result.summary ?? "").trim() : `Worker failed to complete request: ${String(result.summary ?? "unknown error").trim()}`;
                const assistantText = rawText.length > maxResponseChars ? `${rawText.slice(0, maxResponseChars - 3)}...` : rawText;
                if (assistantText) {
                  await transport.queueSessionCommand(job.sessionId, {
                    type: "assistant_message",
                    payload: { text: assistantText },
                    from: jobOrigin === "autonomy" ? `worker:${opts.workerId}/autonomy` : `worker:${opts.workerId}`
                  }, { priority: "high" });
                }
              }
              if (shouldEmitDirectSessionJobEvent({
                ok: result.ok,
                statusPersistedToServer,
                finalizing: completionEnqueued
              })) {
                const eventCmd = result.ok ? {
                  type: "job_completed",
                  payload: {
                    jobId: job.id,
                    summary: result.summary,
                    origin: jobOrigin,
                    artifacts: result.stdout ? [{ kind: "log", text: result.stdout }] : undefined
                  },
                  from: jobOrigin === "autonomy" ? `worker:${opts.workerId}/autonomy` : `worker:${opts.workerId}`
                } : {
                  type: "job_failed",
                  payload: {
                    jobId: job.id,
                    message: result.summary,
                    detail: redactSensitiveText(result.stderr ?? ""),
                    origin: jobOrigin
                  },
                  from: jobOrigin === "autonomy" ? `worker:${opts.workerId}/autonomy` : `worker:${opts.workerId}`
                };
                await transport.queueSessionCommand(job.sessionId, eventCmd, {
                  priority: "high"
                });
              }
            }
          } finally {
            clearInterval(busyHeartbeat);
            if (jobProgressTimer)
              clearInterval(jobProgressTimer);
            if (recycleWorkerAfterJob) {
              const recycleExitCode = result ? workerRecycleExitCodeForResult(result) : CODEX_UNAVAILABLE_WORKER_EXIT_CODE;
              runtimeState.shutdownRequested = true;
              const forceExitTimer = setTimeout(() => {
                console.warn(`[WorkerPals] Forcing worker recycle ${CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS}ms after Codex backend failure.`);
                process.exit(recycleExitCode);
              }, CODEX_UNAVAILABLE_WORKER_FORCE_EXIT_MS);
              try {
                await maybeHeartbeat("offline", null, true);
                if (directWorktreePath) {
                  await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                    console.error(`[WorkerPals] Failed to remove isolated worktree before Codex recycle: ${String(err)}`);
                  });
                  directWorktreePath = null;
                }
                await shutdownDockerExecutorBeforeCodexRecycle(dockerExecutor);
              } finally {
                clearTimeout(forceExitTimer);
                process.exit(recycleExitCode);
              }
            }
            if (job.sessionId && result?.cooldownMs && result.cooldownMs > 0) {
              await transport.queueSessionCommand(job.sessionId, {
                type: "assistant_message",
                payload: {
                  text: `WorkerPal is cooling down for ${formatDurationMs(result.cooldownMs)} after transient infrastructure failures.`
                },
                from: `worker:${opts.workerId}`
              }, { priority: "high" });
            }
            if (result?.cooldownMs && result.cooldownMs > 0) {
              const cooldownMs = Math.max(0, Math.floor(result.cooldownMs));
              console.warn(`[WorkerPals] Entering cooldown for ${formatDurationMs(cooldownMs)} after retry exhaustion.`);
              await maybeHeartbeat("offline", job.id, true);
              await new Promise((resolvePromise) => setTimeout(resolvePromise, cooldownMs));
            }
            await maybeHeartbeat("idle", null, true);
            runtimeState.currentJobId = null;
            runtimeState.currentSessionId = null;
            if (directWorktreePath) {
              await removeIsolatedWorktree(opts.repo, directWorktreePath).catch((err) => {
                console.error(`[WorkerPals] Failed to remove isolated worktree: ${String(err)}`);
              });
            }
          }
        }
      }
    } catch (err) {
      if (runtimeState.shutdownRequested)
        break;
      console.error(`[WorkerPals] Poll error:`, err);
      await maybeHeartbeat("error", null, true);
    }
    if (runtimeState.shutdownRequested)
      break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, opts.pollMs));
  }
}
async function main() {
  const opts = parseArgs();
  const llmConfig = workerLlmConfig(CONFIG);
  opts.gitToken = await resolveWorkerGitToken(opts.repo, opts.gitToken);
  console.log(`[WorkerPals] PushPals WorkerPals Daemon (${opts.workerId})`);
  console.log(`[WorkerPals] Server: ${opts.server}`);
  console.log(`[WorkerPals] Repo: ${opts.repo}`);
  console.log(`[WorkerPals] Worker LLM: model=${llmConfig.model} provider=${llmConfig.provider} baseUrl=${llmConfig.baseUrl || "(unset)"}`);
  opts.worktreeBaseRef = await resolveWorktreeBaseRef(opts.repo, opts.worktreeBaseRef);
  console.log(`[WorkerPals] Worktree base ref: ${opts.worktreeBaseRef}`);
  let dockerExecutor = null;
  if (opts.docker) {
    const dockerAvailable = await DockerExecutor.isDockerAvailable();
    if (!dockerAvailable) {
      const message = "[WorkerPals] Docker is not available. Make sure Docker is installed and running.";
      if (opts.requireDocker) {
        console.error(message);
        console.error("[WorkerPals] Exiting because --require-docker is enabled.");
        process.exit(1);
      }
      console.error(message);
      console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
    } else {
      dockerExecutor = new DockerExecutor({
        imageName: opts.dockerImage,
        repo: opts.repo,
        workerId: opts.workerId,
        gitToken: opts.gitToken ?? undefined,
        timeoutMs: opts.dockerTimeout,
        idleTimeoutMs: opts.dockerIdleTimeout,
        networkMode: opts.dockerNetworkMode,
        baseRef: opts.worktreeBaseRef,
        config: CONFIG
      });
      await dockerExecutor.cleanupOrphanedWorktrees();
      const imageReady = await dockerExecutor.pullImage();
      if (!imageReady) {
        console.error(`[WorkerPals] Failed to prepare Docker image: ${opts.dockerImage}`);
        if (opts.requireDocker) {
          console.error("[WorkerPals] Exiting because --require-docker is enabled.");
          process.exit(1);
        }
        console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
        dockerExecutor = null;
      } else if (!CONFIG.workerpals.skipDockerSelfCheck) {
        console.log("[WorkerPals] Running Docker startup self-check (git/worktree in container)...");
        try {
          await dockerExecutor.validateWorktreeGitInterop();
        } catch (err) {
          console.error(`[WorkerPals] Docker startup self-check failed: ${err instanceof Error ? err.message : String(err)}`);
          if (opts.requireDocker) {
            console.error("[WorkerPals] Exiting because --require-docker is enabled.");
            process.exit(1);
          }
          console.error("[WorkerPals] Falling back to direct mode (isolated worktrees)...");
          dockerExecutor = null;
        }
      }
    }
  } else if (opts.requireDocker) {
    console.error("[WorkerPals] --require-docker was provided without --docker.");
    process.exit(1);
  }
  const runtimeState = {
    currentJobId: null,
    currentSessionId: null,
    shutdownRequested: false
  };
  const headers = buildWorkerHeaders(opts.authToken);
  const transport = new WorkerServerTransport({
    server: opts.server,
    headers,
    workerId: opts.workerId,
    pollMs: opts.pollMs,
    heartbeatMs: opts.heartbeatMs,
    staleClaimTtlMs: CONFIG.server.staleClaimTtlMs
  });
  let shutdownTriggered = false;
  const shutdownAndExit = (signalName, code) => {
    if (shutdownTriggered)
      return;
    shutdownTriggered = true;
    runtimeState.shutdownRequested = true;
    console.warn(`[WorkerPals] Shutdown signal received (${signalName}); draining active work...`);
    const withTimeout = async (promise, timeoutMs = 3000) => {
      await Promise.race([
        promise.catch(() => {
          return;
        }),
        new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
      ]);
    };
    (async () => {
      await withTimeout(transport.sendHeartbeat({
        status: "offline",
        currentJobId: runtimeState.currentJobId ?? null,
        capabilities: {
          docker: opts.docker,
          labels: opts.labels,
          executor: resolveExecutor(CONFIG),
          requireDocker: opts.requireDocker
        },
        details: {
          repo: opts.repo,
          baseRef: opts.worktreeBaseRef,
          dockerImage: opts.docker ? opts.dockerImage : null,
          dockerNetworkMode: opts.docker ? opts.dockerNetworkMode : null
        }
      }));
      await withTimeout(failActiveJobOnShutdown(opts, headers, runtimeState, transport, signalName));
      await withTimeout(transport.flush());
      if (dockerExecutor) {
        await withTimeout(dockerExecutor.shutdown().catch((err) => {
          console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
        }), 1e4);
      }
      process.exit(code);
    })();
  };
  process.once("SIGINT", () => shutdownAndExit("SIGINT", 130));
  process.once("SIGTERM", () => shutdownAndExit("SIGTERM", 143));
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => shutdownAndExit("SIGBREAK", 131));
  }
  process.once("exit", () => {
    runtimeState.shutdownRequested = true;
    if (shutdownTriggered)
      return;
    shutdownTriggered = true;
    if (dockerExecutor) {
      dockerExecutor.shutdown().catch((err) => {
        console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
      });
    }
  });
  const requestWorkerRestart = (reason) => {
    if (shutdownTriggered)
      return;
    console.error(`[WorkerPals] Control plane unhealthy: ${reason}. Recycling worker.`);
    shutdownAndExit("CONTROL_PLANE_UNHEALTHY", 91);
  };
  workerLoop(opts, dockerExecutor, runtimeState, transport, requestWorkerRestart).catch((err) => {
    console.error("[WorkerPals] Fatal:", err);
    process.exit(1);
  });
}
main();
export {
  workerRecycleExitCodeForResult,
  workerJobResultFromDocker,
  shouldRecycleWorkerForHeartbeatDegradation,
  shouldRecycleWorkerForCodexUnavailableFailure,
  shouldEmitDirectSessionJobEvent,
  shouldDeferDockerCodexStartupStallForDirectRetry,
  inferWorkerTerminalFailureClass,
  holdCommitForTrustedValidation,
  failCompletionEnqueue,
  buildTrustedValidationCompletionPayload
};
