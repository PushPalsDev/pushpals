// @bun
var __require = import.meta.require;

// apps/source_control_manager/src/source_control_manager_main.ts
import { parseArgs } from "util";
import { isAbsolute as isAbsolute3, join as join5, relative, resolve as resolve8 } from "path";
import { mkdirSync as mkdirSync2 } from "fs";

// packages/shared/src/communication.ts
function stripPresenceSourcePrefix(value) {
  return value.replace(/^(agent|client)(?:[\s:./_-]+)+/i, "");
}
function normalizePresenceClientId(value) {
  const raw = stripPresenceSourcePrefix(String(value ?? "").trim());
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").trim();
}
function normalizePresenceClientLabel(value) {
  return stripPresenceSourcePrefix(String(value ?? "")).replace(/\s+/g, " ").trim();
}
class CommunicationManager {
  serverUrl;
  sessionId;
  from;
  authToken;
  fetchImpl;
  constructor(opts) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.from = opts.from;
    this.authToken = opts.authToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return headers;
  }
  commandUrl(sessionId) {
    return `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/command`;
  }
  buildSessionTransportPresence(sessionId) {
    const normalizedFrom = normalizePresenceClientId(this.from);
    const labelFrom = normalizePresenceClientLabel(this.from);
    const normalizedSessionId = normalizePresenceClientId(sessionId);
    const isDefaultSession = sessionId === this.sessionId;
    const repoRoot = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE ?? process.cwd()).trim();
    return {
      clientId: isDefaultSession ? normalizedFrom || "agent" : `${normalizedFrom || "agent"}__${normalizedSessionId || "session"}`,
      kind: "agent",
      label: labelFrom || normalizedFrom || "Agent",
      version: String(process.env.PUSHPALS_RUNTIME_TAG ?? process.env.npm_package_version ?? "").trim(),
      platform: `${process.platform}/${process.arch}`,
      repoRoot
    };
  }
  async emitToSession(sessionId, type, payload, meta = {}) {
    try {
      const body = {
        type,
        payload,
        from: meta.from ?? this.from
      };
      if (meta.to)
        body.to = meta.to;
      if (meta.correlationId)
        body.correlationId = meta.correlationId;
      if (meta.turnId)
        body.turnId = meta.turnId;
      if (meta.parentId)
        body.parentId = meta.parentId;
      const response = await this.fetchImpl(this.commandUrl(sessionId), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async emit(type, payload, meta = {}) {
    return this.emitToSession(this.sessionId, type, payload, meta);
  }
  async assistantMessageToSession(sessionId, text, meta = {}) {
    return this.emitToSession(sessionId, "assistant_message", { text }, meta);
  }
  async assistantMessage(text, meta = {}) {
    return this.assistantMessageToSession(this.sessionId, text, meta);
  }
  async userMessageToSession(sessionId, text, meta = {}) {
    return this.emitToSession(sessionId, "message", { text }, {
      ...meta,
      from: meta.from ?? "client"
    });
  }
  async userMessage(text, meta = {}) {
    return this.userMessageToSession(this.sessionId, text, meta);
  }
  async taskProgressToSession(sessionId, taskId, message, percent, meta = {}) {
    const payload = percent == null ? { taskId, message } : { taskId, message, percent };
    return this.emitToSession(sessionId, "task_progress", payload, meta);
  }
  async taskProgress(taskId, message, percent, meta = {}) {
    return this.taskProgressToSession(this.sessionId, taskId, message, percent, meta);
  }
  async statusToSession(sessionId, agentId, state, detail, meta = {}) {
    const payload = detail == null ? { agentId, state } : { agentId, state, detail };
    return this.emitToSession(sessionId, "status", payload, meta);
  }
  async status(agentId, state, detail, meta = {}) {
    return this.statusToSession(this.sessionId, agentId, state, detail, meta);
  }
  subscribeSessionEventsForSession(sessionId, onEvent, options = {}) {
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;
    let latestCursor = Math.max(0, options.afterCursor ?? 0);
    const reconnectMs = Math.max(500, options.reconnectMs ?? 3000);
    const onError = options.onError ?? (() => {});
    const onOpen = options.onOpen ?? (() => {});
    const connect = () => {
      if (disposed)
        return;
      try {
        const url = new URL(this.serverUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `/sessions/${encodeURIComponent(sessionId)}/ws`;
        const presence = this.buildSessionTransportPresence(sessionId);
        if (latestCursor > 0) {
          url.searchParams.set("after", String(latestCursor));
        }
        url.searchParams.set("clientId", presence.clientId);
        url.searchParams.set("clientKind", presence.kind);
        url.searchParams.set("clientLabel", presence.label);
        if (presence.version) {
          url.searchParams.set("clientVersion", presence.version);
        }
        if (presence.platform) {
          url.searchParams.set("clientPlatform", presence.platform);
        }
        if (presence.repoRoot) {
          url.searchParams.set("clientRepoRoot", presence.repoRoot);
        }
        ws = new WebSocket(url.toString());
      } catch (err) {
        onError(`[SessionEvents] Failed to connect: ${String(err)}`);
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
        return;
      }
      ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === "string" ? JSON.parse(event.data) : null;
          if (!raw)
            return;
          const envelope = raw.envelope ?? raw;
          const cursor = typeof raw.cursor === "number" ? raw.cursor : 0;
          if (cursor > latestCursor)
            latestCursor = cursor;
          onEvent(envelope, cursor);
        } catch (err) {
          onError(`[SessionEvents] Parse error: ${String(err)}`);
        }
      };
      ws.onopen = () => {
        onOpen();
      };
      ws.onerror = () => {
        onError("[SessionEvents] WebSocket error");
      };
      ws.onclose = () => {
        ws = null;
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer)
        clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {}
      }
      ws = null;
    };
  }
  subscribeSessionEvents(onEvent, options = {}) {
    return this.subscribeSessionEventsForSession(this.sessionId, onEvent, options);
  }
}

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
var PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
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
  if (!existsSync(path))
    return {};
  const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  const parsed = Bun.TOML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed;
}
function parseRequiredTomlFile(path) {
  if (!existsSync(path)) {
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
    return resolve(value);
  return resolve(projectRoot, value);
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
  const projectRoot = resolve(projectRootOverride);
  const configDirOverride = firstNonEmpty(options.configDir, process.env.PUSHPALS_CONFIG_DIR_OVERRIDE, "");
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }
  const defaultToml = parseRequiredTomlFile(join(configDir, "default.toml"));
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlFile(join(configDir, `${preferredProfile}.toml`));
  const localExampleToml = parseTomlFile(join(configDir, "local.example.toml"));
  const localToml = parseTomlFile(join(configDir, "local.toml"));
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

// apps/source_control_manager/src/db.ts
import { Database } from "bun:sqlite";

class MergeQueueDB {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        branch      TEXT NOT NULL,
        remote      TEXT NOT NULL DEFAULT 'origin',
        head_sha    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'queued',
        priority    INTEGER NOT NULL DEFAULT 0,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_head
        ON jobs(remote, branch, head_sha);

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
        ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS seen (
        remote        TEXT NOT NULL,
        branch        TEXT NOT NULL,
        last_seen_sha TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        PRIMARY KEY(remote, branch)
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id  INTEGER NOT NULL,
        ts      TEXT NOT NULL,
        level   TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
    `);
  }
  getSeenSha(remote, branch) {
    const row = this.db.prepare(`SELECT last_seen_sha FROM seen WHERE remote = ? AND branch = ?`).get(remote, branch);
    return row?.last_seen_sha ?? null;
  }
  updateSeen(remote, branch, sha) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO seen (remote, branch, last_seen_sha, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(remote, branch)
         DO UPDATE SET last_seen_sha = excluded.last_seen_sha,
                       last_seen_at  = excluded.last_seen_at`).run(remote, branch, sha, now);
  }
  removeSeen(remote, branch) {
    this.db.prepare(`DELETE FROM seen WHERE remote = ? AND branch = ?`).run(remote, branch);
  }
  pruneSeenBranches(remote, activeBranches) {
    const rows = this.db.prepare(`SELECT remote, branch FROM seen WHERE remote = ?`).all(remote);
    let pruned = 0;
    for (const row of rows) {
      if (!activeBranches.has(row.branch)) {
        this.removeSeen(row.remote, row.branch);
        pruned++;
      }
    }
    return pruned;
  }
  enqueue(remote, branch, headSha, priority = 0) {
    const now = new Date().toISOString();
    try {
      const info = this.db.prepare(`INSERT INTO jobs (branch, remote, head_sha, status, priority, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`).run(branch, remote, headSha, priority, now, now);
      return Number(info.lastInsertRowid);
    } catch (err) {
      const code = err.code ?? err.errno;
      if (code === 19 || err.message?.includes("UNIQUE"))
        return null;
      throw err;
    }
  }
  claimNext() {
    const tx = this.db.transaction(() => {
      const running = this.db.prepare(`SELECT id FROM jobs WHERE status = 'running' LIMIT 1`).get();
      if (running)
        return null;
      const row = this.db.prepare(`SELECT * FROM jobs
           WHERE status = 'queued'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`).get();
      if (!row)
        return null;
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE jobs
           SET status = 'running', attempts = attempts + 1,
               started_at = ?, updated_at = ?
           WHERE id = ?`).run(now, now, row.id);
      return {
        ...row,
        status: "running",
        attempts: row.attempts + 1,
        started_at: now,
        updated_at: now
      };
    });
    return tx();
  }
  markSuccess(jobId) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'success', finished_at = ?, updated_at = ? WHERE id = ?`).run(now, now, jobId);
  }
  markFailed(jobId, error) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(error, now, now, jobId);
  }
  markSkipped(jobId, reason) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'skipped', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(reason, now, now, jobId);
  }
  requeue(jobId) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status = 'queued', started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`).run(now, jobId);
  }
  getJob(jobId) {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) ?? null;
  }
  getJobsByStatus(status, limit) {
    if (limit != null && limit > 0) {
      return this.db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`).all(status, limit);
    }
    return this.db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC`).all(status);
  }
  getRecentJobs(limit = 50) {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
  getQueuedCount() {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM jobs WHERE status = 'queued'`).get();
    return row.cnt;
  }
  getStatusCounts() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status`).all();
    const counts = {};
    for (const row of rows) {
      counts[row.status] = row.cnt;
    }
    return counts;
  }
  addLog(jobId, message, level = "info") {
    this.db.prepare(`INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)`).run(jobId, new Date().toISOString(), level, message);
  }
  getJobLogs(jobId, limit = 500) {
    const safeLimit = Math.max(1, Math.min(limit, 2001));
    return this.db.prepare(`SELECT ts, level, message FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT ?`).all(jobId, safeLimit);
  }
  recoverStuckJobs() {
    const now = new Date().toISOString();
    const info = this.db.prepare(`UPDATE jobs SET status = 'queued', started_at = NULL, updated_at = ?
         WHERE status = 'running'`).run(now);
    return info.changes;
  }
  close() {
    this.db.close();
  }
}

// apps/source_control_manager/src/lock.ts
import { existsSync as existsSync2, mkdirSync, writeFileSync, unlinkSync, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";

class FileLock {
  lockPath;
  held = false;
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.lockPath = join2(stateDir, "merge_queue.lock");
  }
  acquire() {
    if (this.held)
      return true;
    if (existsSync2(this.lockPath)) {
      try {
        const contents = readFileSync2(this.lockPath, "utf-8");
        const parsed = JSON.parse(contents);
        const pid = parsed.pid;
        if (isProcessAlive(pid)) {
          return false;
        }
        unlinkSync(this.lockPath);
      } catch {
        try {
          unlinkSync(this.lockPath);
        } catch {}
      }
    }
    const lockData = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    });
    try {
      writeFileSync(this.lockPath, lockData, { flag: "wx" });
      this.held = true;
      process.on("exit", () => this.release());
      return true;
    } catch {
      return false;
    }
  }
  release() {
    if (!this.held)
      return;
    try {
      unlinkSync(this.lockPath);
    } catch {}
    this.held = false;
  }
  isHeld() {
    return this.held;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "EPERM")
      return true;
    return false;
  }
}

// apps/source_control_manager/src/git.ts
import { resolve as resolve4, win32 as pathWin32 } from "path";

// packages/shared/src/repo.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync } from "fs";
import { resolve as resolve2 } from "path";
function resolveDotGitEntry(repoRoot) {
  return resolve2(repoRoot, ".git");
}
function findGitRepoRoot(startDir) {
  const override = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? "").trim();
  if (override) {
    const resolvedOverride = resolve2(override);
    if (resolveGitMetadataDir(resolvedOverride)) {
      return resolvedOverride;
    }
    console.warn(`[repo] PUSHPALS_REPO_ROOT_OVERRIDE does not point to a git repository: ${resolvedOverride}`);
  }
  let current = resolve2(startDir);
  const root = resolve2(current, "/");
  while (current !== root) {
    if (resolveGitMetadataDir(current)) {
      return current;
    }
    current = resolve2(current, "..");
  }
  return resolveGitMetadataDir(root) ? root : null;
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
    const gitDir = resolve2(repoRoot, match[1].trim());
    return existsSync3(gitDir) ? gitDir : null;
  } catch {
    return null;
  }
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
import { readFileSync as readFileSync4 } from "fs";
import { join as join3, resolve as resolve3 } from "path";
var TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
var promptTemplateCache = new Map;
var repoDocCache = new Map;
function resolvePromptPath(relativePath) {
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const repoRoot = promptRootOverride ? resolve3(promptRootOverride) : detectRepoRoot(process.cwd());
  return join3(repoRoot, "prompts", relativePath);
}
function loadPromptTemplate(relativePath, replacements) {
  const promptPath = resolvePromptPath(relativePath);
  let template = promptTemplateCache.get(promptPath);
  if (template === undefined) {
    template = readFileSync4(promptPath, "utf8");
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
// packages/shared/src/source_control_api.ts
function normalizeSourceControlProvider(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!normalized)
    return null;
  if (normalized === "auto")
    return "git";
  if (normalized === "git")
    return "git";
  if (normalized === "sapling" || normalized === "sl")
    return "sapling";
  if (normalized === "mercurial" || normalized === "mercury" || normalized === "hg") {
    return "mercurial";
  }
  return null;
}
function hasSourceControlProviderValue(value) {
  return String(value ?? "").trim().length > 0;
}
function formatUnknownSourceControlProvider(value) {
  return String(value ?? "").trim() || "(empty)";
}
function resolveSourceControlProvider(value, env = process.env) {
  if (hasSourceControlProviderValue(value)) {
    const explicit = normalizeSourceControlProvider(value);
    if (explicit)
      return explicit;
    throw new Error(`Unknown source control provider '${formatUnknownSourceControlProvider(value)}'.`);
  }
  const envValue = env.PUSHPALS_SOURCE_CONTROL_PROVIDER ?? env.SOURCE_CONTROL_PROVIDER;
  if (hasSourceControlProviderValue(envValue)) {
    const fromEnv = normalizeSourceControlProvider(envValue);
    if (fromEnv)
      return fromEnv;
    throw new Error(`Unknown source control provider '${formatUnknownSourceControlProvider(envValue)}'.`);
  }
  return "git";
}
function assertSupportedSourceControlProvider(provider) {
  if (provider === "git")
    return "git";
  throw new Error(`Source control provider '${provider}' is recognized but not supported yet. PushPals currently supports git only.`);
}
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
// packages/shared/src/toolchain.ts
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
// packages/shared/src/trusted_validation.ts
var MAX_TRUSTED_VALIDATION_COMMANDS = 8;
var MAX_TRUSTED_VALIDATION_COMMAND_LENGTH = 1000;
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
function tokenizeTrustedValidationCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed || trimmed.length > MAX_TRUSTED_VALIDATION_COMMAND_LENGTH)
    return null;
  const argv = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const pushCurrent = () => {
    if (!current)
      return;
    argv.push(current);
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
      } else if (ch === quote) {
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
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === `
` || ch === "\r") {
      return null;
    }
    current += ch;
  }
  if (escaped || quote)
    return null;
  pushCurrent();
  if (argv.length === 0)
    return null;
  if (argv.some((entry) => entry.includes("$(") || entry.includes("${")))
    return null;
  if (argv[0].includes("/") || argv[0].includes("\\"))
    return null;
  const executable = argv[0].toLowerCase();
  if (!TRUSTED_VALIDATION_EXECUTABLES.has(executable))
    return null;
  const firstArg = argv[1]?.toLowerCase() ?? "";
  if (["bun", "deno", "node"].includes(executable) && ["-e", "--eval"].includes(firstArg) || ["python", "python3"].includes(executable) && firstArg === "-c") {
    return null;
  }
  return argv;
}
function normalizeTrustedValidationCommands(value) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: "trusted validation commands must be a JSON array" };
    }
  }
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return { ok: false, message: "trusted validation commands must be a non-empty array" };
  }
  if (candidate.length > MAX_TRUSTED_VALIDATION_COMMANDS) {
    return {
      ok: false,
      message: `trusted validation is limited to ${MAX_TRUSTED_VALIDATION_COMMANDS} commands`
    };
  }
  const commands = [];
  const seen = new Set;
  for (const entry of candidate) {
    if (typeof entry !== "string") {
      return { ok: false, message: "trusted validation commands must contain only strings" };
    }
    const command = entry.trim();
    if (!tokenizeTrustedValidationCommand(command)) {
      return { ok: false, message: `unsafe or unsupported trusted validation command: ${command}` };
    }
    const key = command.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    commands.push(command);
  }
  return commands.length > 0 ? { ok: true, commands } : { ok: false, message: "trusted validation commands must be a non-empty array" };
}
// packages/shared/src/session_event_visibility.ts
var ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/source_control_manager/src/git.ts
function readSubprocessOutput(output) {
  if (!output || typeof output === "number")
    return Promise.resolve("");
  return new Response(output).text();
}
function normalizeFsPathForComparison(value) {
  const resolved = resolve4(String(value ?? "").trim()).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function parseGitWorktreeListPorcelain(stdout) {
  const entries = [];
  const blocks = String(stdout ?? "").split(/\r?\n\r?\n/g).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/g);
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine)
      continue;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    entries.push({
      path: pathLine.slice("worktree ".length).trim(),
      branch: branchLine ? branchLine.slice("branch ".length).trim() : null,
      detached: lines.includes("detached")
    });
  }
  return entries;
}
function resolveGitExecutableCandidatesFromEnv() {
  const candidates = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push(trimmed);
  };
  pushCandidate(process.env.PUSHPALS_GIT_BIN ?? "");
  pushCandidate(process.env.PUSHPALS_GIT_BIN_ABSOLUTE ?? "");
  pushCandidate("git");
  return candidates;
}
function pushUniqueCandidate(candidates, seen, value, platform = process.platform) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed)
    return;
  const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
  if (seen.has(key))
    return;
  seen.add(key);
  candidates.push(trimmed);
}
function resolveWindowsShellExecutableCandidates(env = process.env, platform = process.platform) {
  if (platform !== "win32")
    return [];
  const candidates = [];
  const seen = new Set;
  const comSpec = String(env.ComSpec ?? env.COMSPEC ?? "").trim();
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();
  pushUniqueCandidate(candidates, seen, comSpec, platform);
  if (systemRoot) {
    pushUniqueCandidate(candidates, seen, pathWin32.join(systemRoot, "System32", "cmd.exe"), platform);
    pushUniqueCandidate(candidates, seen, pathWin32.join(systemRoot, "Sysnative", "cmd.exe"), platform);
  }
  pushUniqueCandidate(candidates, seen, "cmd.exe", platform);
  return candidates;
}
function resolveWindowsWhereExecutableCandidates(env = process.env, platform = process.platform) {
  if (platform !== "win32")
    return [];
  const candidates = [];
  const seen = new Set;
  const systemRoot = String(env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();
  if (systemRoot) {
    pushUniqueCandidate(candidates, seen, pathWin32.join(systemRoot, "System32", "where.exe"), platform);
    pushUniqueCandidate(candidates, seen, pathWin32.join(systemRoot, "Sysnative", "where.exe"), platform);
  }
  pushUniqueCandidate(candidates, seen, "where.exe", platform);
  pushUniqueCandidate(candidates, seen, "where", platform);
  return candidates;
}
function formatGitSpawnFailure(gitExecutable, err) {
  return `spawn ${gitExecutable} failed: ${err instanceof Error ? err.message : String(err)}`;
}
function quoteWindowsCmdArg(value) {
  const str = String(value ?? "");
  if (!str.length)
    return '""';
  if (!/[ \t"]/.test(str))
    return str;
  const escaped = str.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}
function isWindowsCommandNotFound(output, exitCode) {
  if (exitCode === 9009)
    return true;
  return /is not recognized as an internal or external command/i.test(output);
}
async function runViaWindowsCmd(repoPath, commandArgs, timeout) {
  const commandLine = commandArgs.map((arg) => quoteWindowsCmdArg(arg)).join(" ");
  const env = process.env;
  const shellCandidates = resolveWindowsShellExecutableCandidates(env);
  const spawnFailures = [];
  for (const shellExecutable of shellCandidates) {
    let proc;
    try {
      proc = Bun.spawn([shellExecutable, "/d", "/s", "/c", commandLine], {
        cwd: repoPath,
        env,
        stdout: "pipe",
        stderr: "pipe"
      });
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(shellExecutable, err));
      continue;
    }
    let timer;
    if (timeout) {
      timer = setTimeout(() => proc.kill(), timeout);
    }
    const [stdout, stderr] = await Promise.all([
      readSubprocessOutput(proc.stdout),
      readSubprocessOutput(proc.stderr)
    ]);
    const exitCode = await proc.exited;
    if (timer)
      clearTimeout(timer);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    };
  }
  throw new Error(spawnFailures.length > 0 ? spawnFailures.join(" | ") : "spawn cmd.exe failed: no Windows shell candidates were available");
}
async function expandWindowsGitExecutableCandidates(repoPath, candidates) {
  if (process.platform !== "win32")
    return candidates;
  const expanded = [];
  const seen = new Set;
  const pushCandidate = (value) => {
    const trimmed = String(value ?? "").trim();
    if (!trimmed)
      return;
    const key = trimmed.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    expanded.push(trimmed);
  };
  for (const candidate of candidates) {
    const hasPath = /[\\/]/.test(candidate) || /^[A-Za-z]:/.test(candidate);
    if (!hasPath) {
      const whereCandidates = resolveWindowsWhereExecutableCandidates(process.env);
      for (const whereExecutable of whereCandidates) {
        try {
          const proc = Bun.spawn([whereExecutable, candidate], {
            cwd: repoPath,
            env: process.env,
            stdout: "pipe",
            stderr: "ignore"
          });
          const [stdout, exitCode] = await Promise.all([
            readSubprocessOutput(proc.stdout),
            proc.exited
          ]);
          if (exitCode === 0) {
            for (const resolved of stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)) {
              pushCandidate(resolved);
            }
          }
          break;
        } catch {}
      }
    }
    pushCandidate(candidate);
  }
  return expanded.length > 0 ? expanded : candidates;
}
async function runGitCommandCapture(repoPath, args, opts) {
  const gitExecutables = await expandWindowsGitExecutableCandidates(repoPath, resolveGitExecutableCandidatesFromEnv());
  const spawnFailures = [];
  for (const gitExecutable of gitExecutables) {
    const gitArgs = opts?.githubToken && opts.githubToken.length > 0 ? [
      gitExecutable,
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.githubToken}`, "utf-8").toString("base64")}`,
      ...args
    ] : [gitExecutable, ...args];
    let proc;
    try {
      proc = Bun.spawn(gitArgs, {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe"
      });
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(gitExecutable, err));
      if (process.platform === "win32") {
        try {
          const shellResult = await runViaWindowsCmd(repoPath, gitArgs, opts?.timeout);
          const output = [shellResult.stdout, shellResult.stderr].filter(Boolean).join(`
`);
          if (!isWindowsCommandNotFound(output, shellResult.exitCode)) {
            return shellResult;
          }
          spawnFailures.push(`spawn ${gitExecutable} via cmd.exe failed: ${shellResult.stderr || shellResult.stdout || `exit ${shellResult.exitCode}`}`);
        } catch (shellErr) {
          spawnFailures.push(formatGitSpawnFailure("cmd.exe", shellErr));
        }
      }
      continue;
    }
    let timer;
    if (opts?.timeout) {
      timer = setTimeout(() => proc.kill(), opts.timeout);
    }
    const [stdout, stderr] = await Promise.all([
      readSubprocessOutput(proc.stdout),
      readSubprocessOutput(proc.stderr)
    ]);
    const exitCode = await proc.exited;
    if (timer)
      clearTimeout(timer);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    };
  }
  return {
    ok: false,
    stdout: "",
    stderr: spawnFailures.length > 0 ? spawnFailures.join(" | ") : "spawn git failed: no executable candidates were available",
    exitCode: 127
  };
}
async function git(repoPath, args, opts) {
  return runGitCommandCapture(repoPath, args, opts);
}
function assertOk(result, context) {
  if (!result.ok) {
    throw new Error(`git ${context} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
}
function sanitizeBranchComponent(value) {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  return cleaned || "integration";
}
function createSourceControlApi(config, options = {}) {
  const provider = resolveSourceControlProvider(options.provider);
  assertSupportedSourceControlProvider(provider);
  return new GitSourceControlApi(config);
}

class GitSourceControlApi {
  provider = "git";
  repoPath;
  remote;
  mainBranch;
  localMainRef;
  integrationBaseBranch;
  branchPrefix;
  githubToken;
  constructor(config) {
    this.repoPath = config.repoPath;
    this.remote = config.remote;
    this.mainBranch = config.mainBranch;
    this.localMainRef = `refs/pushpals/source_control_manager/local/${sanitizeBranchComponent(config.mainBranch)}`;
    this.integrationBaseBranch = config.integrationBaseBranch;
    this.branchPrefix = config.branchPrefix;
    this.githubToken = config.gitToken ?? null;
  }
  async gitConfigValue(key) {
    const result = await git(this.repoPath, ["config", "--get", key]);
    return result.ok ? sanitizeSourceControlIdentityField(result.stdout) : "";
  }
  async getCommitIdentity() {
    const fallbackEmail = await this.gitConfigValue("user.email");
    const explicit = explicitSourceControlCommitIdentityFromEnv(process.env, fallbackEmail);
    if (explicit)
      return explicit;
    const name = await this.gitConfigValue("user.name");
    if (name && fallbackEmail) {
      return { name, email: fallbackEmail, source: "source-control-config" };
    }
    return null;
  }
  remoteMainRef() {
    return `${this.remote}/${this.mainBranch}`;
  }
  integrationBaseRef() {
    return `${this.remote}/${this.integrationBaseBranch}`;
  }
  async resolveMainBaseRef() {
    const remoteMain = this.remoteMainRef();
    if (await this.revParse(remoteMain))
      return remoteMain;
    if (await this.revParse(this.localMainRef))
      return this.localMainRef;
    const remoteHead = `${this.remote}/HEAD`;
    if (await this.revParse(remoteHead)) {
      console.warn(`[source_control_manager] ${remoteMain} not found; bootstrapping ${this.mainBranch} from ${remoteHead}.`);
      return remoteHead;
    }
    console.warn(`[source_control_manager] ${remoteMain} and ${this.localMainRef} not found; bootstrapping from HEAD.`);
    return "HEAD";
  }
  async resolveAgentMergeRef(agentBranch) {
    if (agentBranch.startsWith("refs/")) {
      const exists = await this.revParse(agentBranch);
      if (exists)
        return agentBranch;
    }
    const hiddenRef = `refs/pushpals/${agentBranch.replace(/^\/+/, "")}`;
    if (await this.revParse(hiddenRef))
      return hiddenRef;
    const localRef = `refs/heads/${agentBranch}`;
    const remoteRef = `refs/remotes/${this.remote}/${agentBranch}`;
    const localExists = await this.revParse(localRef);
    if (localExists)
      return agentBranch;
    const remoteExists = await this.revParse(remoteRef);
    if (remoteExists)
      return `${this.remote}/${agentBranch}`;
    throw new Error(`Branch not found locally or on ${this.remote}: ${agentBranch} (checked ${localRef} and ${remoteRef})`);
  }
  async fetchPrune() {
    const result = await git(this.repoPath, ["fetch", this.remote, "--prune", "--quiet"], this.githubToken ? { githubToken: this.githubToken } : undefined);
    assertOk(result, "fetch --prune");
  }
  async bootstrapMainBranchFromBase() {
    await this.fetchPrune();
    const baseRef = this.integrationBaseRef();
    const baseSha = await this.revParse(baseRef);
    if (!baseSha) {
      throw new Error(`Cannot bootstrap ${this.mainBranch}: base ref ${baseRef} not found.`);
    }
    const checkoutResult = await git(this.repoPath, ["checkout", "--detach", baseRef, "--quiet"]);
    assertOk(checkoutResult, `checkout --detach ${baseRef}`);
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
    const pushResult = await git(this.repoPath, ["push", this.remote, `HEAD:refs/heads/${this.mainBranch}`], this.githubToken ? { githubToken: this.githubToken } : undefined);
    if (!pushResult.ok) {
      await this.fetchPrune();
      if (await this.revParse(this.remoteMainRef())) {
        console.warn(`[source_control_manager] Push failed while bootstrapping ${this.mainBranch}, but remote branch now exists.`);
        return;
      }
      throw new Error(`Failed to push bootstrap branch ${this.mainBranch}: ${pushResult.stderr || pushResult.stdout}`);
    }
  }
  async discoverAgentBranches() {
    const refPrefix = `refs/remotes/${this.remote}/${this.branchPrefix}`;
    const result = await git(this.repoPath, [
      "for-each-ref",
      "--format=%(refname:strip=3)\t%(objectname)",
      refPrefix
    ]);
    if (!result.ok || !result.stdout)
      return [];
    return result.stdout.split(`
`).map((line) => {
      const tabIdx = line.lastIndexOf("\t");
      return {
        branch: line.slice(0, tabIdx),
        sha: line.slice(tabIdx + 1)
      };
    });
  }
  async getMainHeadSha() {
    const result = await git(this.repoPath, ["rev-parse", this.localMainRef]);
    assertOk(result, "rev-parse main");
    return result.stdout;
  }
  async checkoutMain() {
    const localMainExists = await this.revParse(this.localMainRef);
    const result = localMainExists ? await git(this.repoPath, ["checkout", "--detach", this.localMainRef, "--quiet"]) : await git(this.repoPath, [
      "checkout",
      "--detach",
      await this.resolveMainBaseRef(),
      "--quiet"
    ]);
    assertOk(result, "checkout main");
  }
  async alignMainToRemote() {
    const remoteMain = this.remoteMainRef();
    const remoteHeadSha = await this.revParse(remoteMain);
    if (!remoteHeadSha)
      return null;
    const checkoutResult = await git(this.repoPath, [
      "checkout",
      "--detach",
      remoteMain,
      "--quiet"
    ]);
    assertOk(checkoutResult, `checkout --detach ${remoteMain}`);
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, remoteHeadSha]);
    assertOk(pinResult, `align ${this.localMainRef} to ${remoteMain}`);
    return remoteHeadSha;
  }
  async pullMainFF() {
    const remoteMain = this.remoteMainRef();
    if (!await this.revParse(remoteMain)) {
      console.warn(`[source_control_manager] Skipping pull: remote branch ${remoteMain} does not exist yet.`);
      return;
    }
    const result = await git(this.repoPath, ["merge", remoteMain, "--ff-only", "--quiet"]);
    assertOk(result, "merge --ff-only remote-main");
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
  }
  async syncMainWithBaseBranch() {
    const baseRef = this.integrationBaseRef();
    const baseHeadSha = await this.revParse(baseRef);
    if (!baseHeadSha) {
      console.warn(`[source_control_manager] Skipping base sync: ${baseRef} does not exist.`);
      throw new Error(`Cannot sync ${this.mainBranch}: base ref ${baseRef} does not exist.`);
    }
    const integrationHeadSha = await this.revParse(this.localMainRef);
    if (!integrationHeadSha) {
      console.warn(`[source_control_manager] Skipping base sync: local integration ref ${this.localMainRef} is missing.`);
      throw new Error(`Cannot sync ${this.mainBranch}: local integration ref ${this.localMainRef} is missing.`);
    }
    const alreadySynced = await this.isAncestor(baseRef, this.localMainRef);
    if (alreadySynced) {
      return {
        status: "up_to_date",
        integrationHeadSha,
        baseHeadSha,
        conflictPaths: []
      };
    }
    let mergeResult = await git(this.repoPath, ["merge", baseRef, "--no-edit"]);
    if (!mergeResult.ok) {
      const conflicts = await git(this.repoPath, ["diff", "--name-only", "--diff-filter=U"]);
      const conflictPaths = conflicts.ok ? conflicts.stdout.split(/\r?\n/).map((value) => value.trim().replace(/\\/g, "/")).filter(Boolean) : [];
      let detail = mergeResult.stderr || mergeResult.stdout || "merge failed";
      if (conflictPaths.length === 0) {
        const mergeHead = await git(this.repoPath, ["rev-parse", "--verify", "MERGE_HEAD"]);
        const stagedDiff = await git(this.repoPath, ["diff", "--cached", "--quiet"]);
        if (mergeHead.ok && stagedDiff.exitCode === 1) {
          const continued = await git(this.repoPath, ["commit", "--no-edit"]);
          if (continued.ok) {
            mergeResult = continued;
          } else {
            detail = [detail, continued.stderr, continued.stdout].filter(Boolean).join(`
`);
          }
        }
      }
      if (!mergeResult.ok) {
        await git(this.repoPath, ["merge", "--abort"]);
        const restore = await git(this.repoPath, [
          "checkout",
          "--detach",
          this.localMainRef,
          "--quiet"
        ]);
        assertOk(restore, `restore ${this.localMainRef} after base-sync conflict`);
        if (conflictPaths.length === 0) {
          throw new Error(`Failed to sync ${this.mainBranch} with ${baseRef}: ${detail}`);
        }
        return {
          status: "conflicted",
          integrationHeadSha,
          baseHeadSha,
          conflictPaths,
          detail
        };
      }
    }
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
    const mergedHeadSha = await this.revParse("HEAD");
    if (!mergedHeadSha) {
      throw new Error(`Failed to resolve merged ${this.mainBranch} head after syncing ${baseRef}.`);
    }
    return {
      status: "updated",
      integrationHeadSha,
      baseHeadSha,
      mergedHeadSha,
      conflictPaths: []
    };
  }
  async createTempBranch(name) {
    const baseRef = await this.revParse(this.localMainRef) ? this.localMainRef : await this.resolveMainBaseRef();
    const result = await git(this.repoPath, ["checkout", "-B", name, baseRef, "--quiet"]);
    assertOk(result, `checkout -B ${name}`);
  }
  async mergeNoFF(agentBranch, message) {
    const mergeRef = await this.resolveAgentMergeRef(agentBranch);
    return git(this.repoPath, ["merge", mergeRef, "--no-ff", "-m", message]);
  }
  async mergeFFOnly(agentBranch) {
    const mergeRef = await this.resolveAgentMergeRef(agentBranch);
    return git(this.repoPath, ["merge", mergeRef, "--ff-only"]);
  }
  async mergeFFOnlyRef(ref) {
    return git(this.repoPath, ["merge", ref, "--ff-only"]);
  }
  async cherryPickRef(ref) {
    return git(this.repoPath, ["cherry-pick", ref]);
  }
  async pushMain() {
    return git(this.repoPath, ["push", this.remote, `HEAD:refs/heads/${this.mainBranch}`, "--atomic"], this.githubToken ? { githubToken: this.githubToken } : undefined);
  }
  async deleteTempBranch(name) {
    await git(this.repoPath, ["branch", "-D", name]);
  }
  async cleanupLocalTempBranches(prefix = "_source_control_manager/") {
    const normalizedPrefix = prefix.trim().replace(/^\/+/, "");
    const warnings = [];
    const deletedBranches = [];
    const removedWorktrees = [];
    const failedBranches = [];
    if (!normalizedPrefix) {
      return { deletedBranches, removedWorktrees, failedBranches, warnings };
    }
    try {
      await this.resetToClean();
    } catch (err) {
      warnings.push(`resetToClean failed before temp-branch cleanup: ${err?.message ?? err}`);
    }
    const listResult = await git(this.repoPath, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${normalizedPrefix}`], { timeout: 15000 });
    if (!listResult.ok) {
      warnings.push(`for-each-ref failed: ${listResult.stderr || listResult.stdout}`);
      return { deletedBranches, removedWorktrees, failedBranches, warnings };
    }
    const worktreeList = await git(this.repoPath, ["worktree", "list", "--porcelain"], {
      timeout: 15000
    });
    if (!worktreeList.ok) {
      warnings.push(`worktree list failed: ${worktreeList.stderr || worktreeList.stdout}`);
    } else {
      const currentRepoPath = normalizeFsPathForComparison(this.repoPath);
      const linkedWorktrees = parseGitWorktreeListPorcelain(worktreeList.stdout).filter((entry) => {
        if (!entry.branch)
          return false;
        if (!entry.branch.startsWith(`refs/heads/${normalizedPrefix}`))
          return false;
        return normalizeFsPathForComparison(entry.path) !== currentRepoPath;
      });
      for (const entry of linkedWorktrees) {
        const removeResult = await git(this.repoPath, ["worktree", "remove", "--force", "--force", entry.path], { timeout: 15000 });
        if (removeResult.ok) {
          removedWorktrees.push(entry.path);
          continue;
        }
        warnings.push(`failed to remove linked temp worktree ${entry.path}: ${removeResult.stderr || removeResult.stdout}`);
      }
    }
    const branches = listResult.stdout.split(/\r?\n/g).map((value) => value.trim()).filter((value) => value.length > 0 && value.startsWith(normalizedPrefix));
    for (const branch of branches) {
      const deleteResult = await git(this.repoPath, ["branch", "-D", branch], { timeout: 15000 });
      if (deleteResult.ok) {
        deletedBranches.push(branch);
      } else {
        failedBranches.push(`${branch}: ${deleteResult.stderr || deleteResult.stdout}`);
      }
    }
    const pruneResult = await git(this.repoPath, ["worktree", "prune"], { timeout: 15000 });
    if (!pruneResult.ok) {
      warnings.push(`worktree prune failed: ${pruneResult.stderr || pruneResult.stdout}`);
    }
    return { deletedBranches, removedWorktrees, failedBranches, warnings };
  }
  async deleteRemoteBranch(branch) {
    await git(this.repoPath, ["push", this.remote, "--delete", branch], this.githubToken ? { githubToken: this.githubToken } : undefined);
  }
  async deleteLocalRef(ref) {
    await git(this.repoPath, ["update-ref", "-d", ref]);
  }
  async resetToClean() {
    await git(this.repoPath, ["rebase", "--abort"]);
    await git(this.repoPath, ["merge", "--abort"]);
    await git(this.repoPath, ["cherry-pick", "--abort"]);
    const baseRef = await this.resolveMainBaseRef();
    const checkoutResult = await git(this.repoPath, ["checkout", "--detach", baseRef, "--quiet"]);
    assertOk(checkoutResult, `checkout --detach ${baseRef}`);
    const remoteRef = this.remoteMainRef();
    const remoteSha = await this.revParse(remoteRef);
    const resetTarget = remoteSha ? remoteRef : "HEAD";
    if (!remoteSha) {
      console.warn(`[source_control_manager] Remote-tracking ref ${remoteRef} not found; using detached HEAD state.`);
    }
    const resetResult = await git(this.repoPath, ["reset", "--hard", resetTarget, "--quiet"]);
    assertOk(resetResult, `reset --hard ${resetTarget}`);
    const pinResult = await git(this.repoPath, ["update-ref", this.localMainRef, "HEAD"]);
    assertOk(pinResult, `update-ref ${this.localMainRef} HEAD`);
  }
  async isRepoClean() {
    const result = await git(this.repoPath, ["status", "--porcelain"]);
    return result.ok && result.stdout.length === 0;
  }
  async revParse(ref) {
    const result = await git(this.repoPath, ["rev-parse", ref]);
    return result.ok ? result.stdout : null;
  }
  async isAncestor(ancestor, descendant) {
    const result = await git(this.repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result.ok;
  }
  async shortLog(from, to) {
    const result = await git(this.repoPath, ["log", "--oneline", `${from}..${to}`]);
    return result.ok ? result.stdout : "";
  }
  async isMerged(branch) {
    const branchTip = `${this.remote}/${branch}`;
    const mainTip = `${this.remote}/${this.mainBranch}`;
    return this.isAncestor(branchTip, mainTip);
  }
}

// apps/source_control_manager/src/github_pr.ts
function parseGitHubRepo2(remoteUrl) {
  const raw = (remoteUrl ?? "").trim();
  if (!raw)
    return null;
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match)
      continue;
    return { owner: match[1], repo: match[2] };
  }
  return null;
}
function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pushpals-source-control-manager",
    "Content-Type": "application/json"
  };
}
function githubError(responseStatus, bodyText) {
  return new Error(`GitHub API ${responseStatus}: ${bodyText || "no response body"}`);
}
async function ensureIntegrationPullRequest(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}. Supported: https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git`);
  }
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const headSpec = `${repo.owner}:${opts.headBranch}`;
  const listUrl = `${apiBase}/pulls?state=open&head=${encodeURIComponent(headSpec)}&base=${encodeURIComponent(opts.baseBranch)}`;
  const listResponse = await fetch(listUrl, {
    method: "GET",
    headers: githubHeaders(opts.token)
  });
  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw githubError(listResponse.status, text);
  }
  const openPrs = await listResponse.json();
  if (Array.isArray(openPrs) && openPrs.length > 0) {
    const existing = openPrs[0];
    return { created: false, number: existing.number, htmlUrl: existing.html_url };
  }
  const createResponse = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({
      title: opts.title,
      head: opts.headBranch,
      base: opts.baseBranch,
      body: opts.body,
      draft: !!opts.draft
    })
  });
  if (createResponse.ok) {
    const created = await createResponse.json();
    return { created: true, number: created.number, htmlUrl: created.html_url };
  }
  if (createResponse.status === 422) {
    const retryListResponse = await fetch(listUrl, {
      method: "GET",
      headers: githubHeaders(opts.token)
    });
    if (retryListResponse.ok) {
      const retryOpenPrs = await retryListResponse.json();
      if (Array.isArray(retryOpenPrs) && retryOpenPrs.length > 0) {
        const existing = retryOpenPrs[0];
        return { created: false, number: existing.number, htmlUrl: existing.html_url };
      }
    }
  }
  const createBody = await createResponse.text();
  throw githubError(createResponse.status, createBody);
}
async function listOpenPullRequests(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const url = `${apiBase}/pulls?state=open&base=${encodeURIComponent(opts.base)}&per_page=100`;
  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(opts.token)
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  const prs = await response.json();
  if (!Array.isArray(prs))
    return [];
  if (!opts.headPrefix)
    return prs;
  return prs.filter((pr) => pr.head.ref.startsWith(opts.headPrefix));
}
async function getPullRequestDiff(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      ...githubHeaders(opts.token),
      Accept: "application/vnd.github.diff"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  return response.text();
}
async function getCommitMessage(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${encodeURIComponent(opts.sha)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(opts.token)
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  const data = await response.json();
  const message = data && data.commit && typeof data.commit.message === "string" ? data.commit.message : "";
  if (!message) {
    throw new Error(`GitHub API commit ${opts.sha} missing commit.message`);
  }
  return message;
}
function parseNextLink(linkHeader) {
  if (!linkHeader)
    return null;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (match && match[2] === "next")
      return match[1];
  }
  return null;
}
async function getPullRequestCommitMessage(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  let url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/commits?per_page=100`;
  let pages = 0;
  let latestMessage = "";
  while (url && pages < 50) {
    pages += 1;
    const response = await fetch(url, {
      method: "GET",
      headers: githubHeaders(opts.token)
    });
    if (!response.ok) {
      const text = await response.text();
      throw githubError(response.status, text);
    }
    const commits = await response.json();
    if (!Array.isArray(commits) || commits.length === 0)
      break;
    for (const commit of commits) {
      const sha = typeof commit.sha === "string" ? commit.sha : "";
      const message = commit.commit && typeof commit.commit.message === "string" ? commit.commit.message : "";
      if (sha === opts.sha && message.trim())
        return message;
    }
    for (let i = commits.length - 1;i >= 0; i -= 1) {
      const entry = commits[i];
      const messageCandidate = entry && entry.commit ? entry.commit.message : undefined;
      const message = typeof messageCandidate === "string" ? messageCandidate : "";
      if (message && message.trim()) {
        latestMessage = message;
        break;
      }
    }
    url = parseNextLink(response.headers.get("link")) ?? "";
  }
  if (latestMessage)
    return latestMessage;
  throw new Error(`Could not resolve commit message from PR #${opts.prNumber} for sha ${opts.sha}`);
}
async function mergePullRequest(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/merge`;
  const body = {
    merge_method: opts.mergeMethod ?? "squash"
  };
  if (opts.commitTitle)
    body.commit_title = opts.commitTitle;
  if (opts.commitMessage)
    body.commit_message = opts.commitMessage;
  const response = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(opts.token),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  const data = await response.json();
  return data;
}
async function closePullRequest(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ state: "closed" })
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  const data = await response.json();
  const state = typeof data.state === "string" ? data.state : "";
  return { state, closed: state.toLowerCase() === "closed" };
}
async function deleteBranchRef(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const normalizedRef = String(opts.branchRef ?? "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalizedRef) {
    throw new Error("branchRef is required to delete a branch");
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/refs/heads/${encodeURIComponent(normalizedRef)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(opts.token)
  });
  if (response.status === 404) {
    return { deleted: false, reason: "not_found" };
  }
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  return { deleted: true, reason: "deleted" };
}
async function listPullRequestComments(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const requested = Number.isFinite(opts.maxComments) ? Math.trunc(opts.maxComments ?? 0) : 0;
  const perPage = Math.max(1, Math.min(100, requested > 0 ? requested : 20));
  const issueUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${opts.prNumber}/comments?sort=created&direction=desc&per_page=${perPage}`;
  const issueResponse = await fetch(issueUrl, {
    method: "GET",
    headers: githubHeaders(opts.token)
  });
  if (!issueResponse.ok) {
    const text = await issueResponse.text();
    throw githubError(issueResponse.status, text);
  }
  const issueComments = await issueResponse.json();
  const normalizedIssueComments = Array.isArray(issueComments) ? issueComments : [];
  const reviewUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}/comments?sort=created&direction=desc&per_page=${perPage}`;
  let normalizedReviewComments = [];
  const reviewResponse = await fetch(reviewUrl, {
    method: "GET",
    headers: githubHeaders(opts.token)
  });
  if (reviewResponse.ok) {
    const reviewComments = await reviewResponse.json();
    normalizedReviewComments = Array.isArray(reviewComments) ? reviewComments : [];
  }
  return [...normalizedIssueComments, ...normalizedReviewComments].map((comment) => {
    const id = typeof comment.id === "number" ? comment.id : Number(comment.id);
    if (!Number.isFinite(id))
      return null;
    const body = typeof comment.body === "string" ? comment.body : "";
    const createdAt = typeof comment.created_at === "string" ? comment.created_at : "";
    const htmlUrl = typeof comment.html_url === "string" ? comment.html_url : "";
    const userLogin = comment.user && typeof comment.user.login === "string" ? comment.user.login : "";
    return {
      id,
      body,
      userLogin,
      createdAt,
      htmlUrl
    };
  }).filter((comment) => !!comment).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, perPage);
}
async function addPullRequestComment(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues/${opts.prNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({ body: opts.body })
  });
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
}

// apps/source_control_manager/src/integration_reconciliation.ts
function normalizeBranch(value) {
  const normalized = String(value ?? "").trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock") || /[~^:?*\[\]\s]/.test(normalized)) {
    throw new Error(`Unsafe integration reconciliation branch: ${JSON.stringify(value)}`);
  }
  return normalized;
}
function normalizeConflictPaths(values) {
  const seen = new Set;
  const paths = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..") || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths.slice(0, 64);
}
function quoteCommandArg(value) {
  return /^[A-Za-z0-9_./@+-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function validationSteps(conflictPaths) {
  const tests = conflictPaths.filter((path) => /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path));
  if (tests.length > 0) {
    return tests.slice(0, 8).map((path) => `bun test ${quoteCommandArg(path)}`);
  }
  return ["bun run validate"];
}
function integrationReconciliationFingerprint(options) {
  return [
    "integration-reconcile",
    normalizeBranch(options.integrationBranch),
    options.integrationHeadSha.trim().toLowerCase(),
    options.baseHeadSha.trim().toLowerCase()
  ].join(":");
}
function buildIntegrationReconciliationJob(options) {
  const integrationBranch = normalizeBranch(options.integrationBranch);
  const baseBranch = normalizeBranch(options.baseBranch);
  if (integrationBranch === baseBranch) {
    throw new Error("Integration reconciliation requires distinct integration and base branches.");
  }
  const conflictPaths = normalizeConflictPaths(options.sync.conflictPaths);
  if (conflictPaths.length === 0) {
    throw new Error("Integration reconciliation requires at least one safe conflicted path.");
  }
  const now = Number.isFinite(options.now) ? Math.floor(options.now ?? Date.now()) : Date.now();
  const shortIntegration = options.sync.integrationHeadSha.slice(0, 12);
  const shortBase = options.sync.baseHeadSha.slice(0, 12);
  const instruction = [
    `Reconcile the PushPals integration branch ${integrationBranch} with ${baseBranch}.`,
    `The host prepared ${integrationBranch} at ${shortIntegration} and began rebasing it onto ${baseBranch} at ${shortBase}.`,
    `Resolve only the prepared conflicts: ${conflictPaths.join(", ")}.`,
    "Preserve the intended behavior from both branches and run focused validation.",
    "Do not checkout, switch, reset, merge, rebase, stage, commit, or push. Host-side SCM owns the rebase and exact-lease publication."
  ].join(`
`);
  const fingerprint = integrationReconciliationFingerprint({
    integrationBranch,
    integrationHeadSha: options.sync.integrationHeadSha,
    baseHeadSha: options.sync.baseHeadSha
  });
  return {
    taskId: `integration-reconcile-${now}`,
    sessionId: options.sessionId,
    kind: "task.execute",
    dedupeKey: fingerprint,
    dedupeCooldownMs: 30000,
    priority: "interactive",
    params: {
      schemaVersion: 2,
      origin: "autonomy",
      instruction,
      plannerWorkerInstruction: [
        "Integration reconciliation brief:",
        `- Integration branch: ${integrationBranch} (${options.sync.integrationHeadSha})`,
        `- Base branch: ${baseBranch} (${options.sync.baseHeadSha})`,
        `- Prepared conflict paths: ${conflictPaths.join(", ")}`,
        "- Resolve the host-prepared rebase state and validate the affected files.",
        "- SourceControlManager alone publishes the rebased integration head with an exact force-with-lease."
      ].join(`
`),
      recentContext: [
        `${integrationBranch} and ${baseBranch} diverged and the deterministic host merge found conflicts.`,
        `Reconciliation fingerprint: ${fingerprint}`
      ],
      planning: {
        intent: "code_change",
        riskLevel: "high",
        targetPaths: conflictPaths,
        acceptanceCriteria: [
          `${integrationBranch} contains the current ${baseBranch} history without unresolved conflicts.`,
          "Both branches' intended behavior is preserved in every conflicted file.",
          "Focused validation for the conflicted paths passes."
        ],
        validationSteps: validationSteps(conflictPaths),
        queuePriority: "interactive",
        queueWaitBudgetMs: 30000,
        executionBudgetMs: 1200000,
        finalizationBudgetMs: 120000,
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: conflictPaths
        },
        discovery: {
          ripgrepQueries: conflictPaths.map((path) => path.split("/").at(-1) ?? path).slice(0, 8),
          likelyDirs: [
            ...new Set(conflictPaths.map((path) => path.split("/").slice(0, -1).join("/")).filter(Boolean))
          ].slice(0, 12),
          keywords: ["integration reconciliation", integrationBranch, baseBranch]
        }
      },
      completionBranch: integrationBranch,
      reviewAgent: {
        prHeadSha: options.sync.integrationHeadSha,
        prBaseSha: options.sync.baseHeadSha,
        prHeadRef: integrationBranch,
        prBaseRef: baseBranch,
        resolutionType: "integration_reconcile",
        mergeError: options.sync.detail,
        requestedAt: new Date(now).toISOString()
      },
      lane: "worker",
      recentJobs: []
    }
  };
}

// apps/source_control_manager/src/integration_maintenance.ts
class IntegrationMaintenanceRunner {
  gitOps;
  sessionId;
  intervalMs;
  now;
  fetchImpl;
  logger;
  nextRunAtMs = 0;
  lastObservedNowMs = null;
  inFlight = null;
  stateKey = "startup";
  constructor(options) {
    this.gitOps = options.gitOps;
    this.sessionId = options.sessionId;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMs));
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger ?? {
      log: (message) => console.log(message),
      warn: (message) => console.warn(message)
    };
  }
  logState(key, message, level = "log") {
    if (this.stateKey === key)
      return;
    this.stateKey = key;
    this.logger[level](message);
  }
  run(runtimeConfig, headers) {
    if (this.inFlight)
      return this.inFlight;
    const now = this.now();
    const clockMovedBackward = this.lastObservedNowMs !== null && now < this.lastObservedNowMs;
    this.lastObservedNowMs = now;
    if (!clockMovedBackward && now < this.nextRunAtMs) {
      return Promise.resolve({ status: "skipped", nextRunAtMs: this.nextRunAtMs });
    }
    this.nextRunAtMs = now + this.intervalMs;
    this.inFlight = this.execute(runtimeConfig, headers, now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  async execute(runtimeConfig, headers, now) {
    const timestamp = new Date(now).toISOString();
    try {
      await this.gitOps.fetchPrune();
      const alignedRemoteHead = await this.gitOps.alignMainToRemote();
      if (!alignedRemoteHead) {
        await this.gitOps.checkoutMain();
        await this.gitOps.pullMainFF();
      }
      const sync = await this.gitOps.syncMainWithBaseBranch();
      if (sync.status === "up_to_date") {
        this.logState(`healthy:${sync.integrationHeadSha}:${sync.baseHeadSha}`, `[${timestamp}] Integration branch ${runtimeConfig.remote}/${runtimeConfig.mainBranch} contains ${runtimeConfig.remote}/${runtimeConfig.integrationBaseBranch}; continuous dispatch is ready.`);
        return { status: "up_to_date", nextRunAtMs: this.nextRunAtMs };
      }
      if (sync.status === "updated") {
        if (!runtimeConfig.pushMainAfterMerge) {
          this.logState(`updated-local:${sync.mergedHeadSha}`, `[${timestamp}] Integration branch ${runtimeConfig.mainBranch} was reconciled locally with ${runtimeConfig.integrationBaseBranch}, but push_main_after_merge=false prevents remote publication.`, "warn");
          return {
            status: "local_only",
            nextRunAtMs: this.nextRunAtMs,
            mergedHeadSha: sync.mergedHeadSha
          };
        }
        const push = await this.gitOps.pushMain();
        if (!push.ok) {
          throw new Error(`Failed to push reconciled ${runtimeConfig.mainBranch}: ${push.stderr || push.stdout}`);
        }
        await this.gitOps.fetchPrune();
        this.logState(`reconciled:${sync.mergedHeadSha}`, `[${timestamp}] Reconciled ${runtimeConfig.remote}/${runtimeConfig.mainBranch} with ${runtimeConfig.remote}/${runtimeConfig.integrationBaseBranch} (${sync.integrationHeadSha.slice(0, 8)} -> ${sync.mergedHeadSha.slice(0, 8)}) and pushed the result.`);
        return {
          status: "reconciled",
          nextRunAtMs: this.nextRunAtMs,
          mergedHeadSha: sync.mergedHeadSha
        };
      }
      const payload = buildIntegrationReconciliationJob({
        sessionId: this.sessionId,
        integrationBranch: runtimeConfig.mainBranch,
        baseBranch: runtimeConfig.integrationBaseBranch,
        sync,
        now
      });
      const response = await this.fetchImpl(`${runtimeConfig.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`Failed to enqueue integration reconciliation job: HTTP ${response.status}${typeof responseBody?.message === "string" ? ` ${responseBody.message}` : ""}`);
      }
      const jobId = typeof responseBody?.jobId === "string" && responseBody.jobId.trim() ? responseBody.jobId.trim() : "unknown";
      const deduped = responseBody?.deduped === true;
      this.logState(`repair:${payload.dedupeKey}:${jobId}`, `[${timestamp}] ${runtimeConfig.mainBranch} conflicts with ${runtimeConfig.integrationBaseBranch}; ${deduped ? "reusing" : "dispatched"} exact-lease integration reconciliation job ${jobId} for ${sync.conflictPaths.join(", ")}.`, "warn");
      return {
        status: deduped ? "repair_deduped" : "repair_dispatched",
        nextRunAtMs: this.nextRunAtMs,
        jobId,
        dedupeKey: payload.dedupeKey
      };
    } catch (err) {
      try {
        await this.gitOps.resetToClean();
      } catch {}
      const detail = err instanceof Error ? err.message : String(err);
      this.logState(`error:${detail}`, `[${timestamp}] Integration maintenance failed; SourceControlManager will retry without freezing autonomy: ${detail}`, "warn");
      return {
        status: "retry_scheduled",
        nextRunAtMs: this.nextRunAtMs,
        error: detail
      };
    }
  }
}
async function maintainIntegrationBeforeCompletionClaim(options) {
  await options.maintain();
  return options.claimCompletion();
}

// apps/source_control_manager/src/review_agent.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "fs";
import { tmpdir } from "os";
import { basename, delimiter, isAbsolute as isAbsolute2, join as join4, resolve as resolve5 } from "path";
var MAX_DIFF_BYTES = 150000;
var MAX_PR_RE_REVIEW_ENQUEUES = 3;
var MAX_REVIEW_CONTEXT_COMMENTS = 8;
var MAX_REVIEW_CONTEXT_COMMENT_CHARS = 320;
var MAX_REVIEW_CONTEXT_TOTAL_CHARS = 3000;
var MAX_AUTONOMY_FEEDBACK_COMMENTS = 12;
var MAX_AUTONOMY_FEEDBACK_COMMENT_CHARS = 500;
var MAX_AUTONOMY_FEEDBACK_SUMMARY_CHARS = 500;
var MAX_ACTIVE_FIX_JOB_SCAN = 500;
var REVIEW_FIX_JOB_DEDUPE_COOLDOWN_MS = 60000;
var REVIEW_MERGE_CONFLICT_JOB_DEDUPE_COOLDOWN_MS = 30 * 60000;
var MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT = 2;
var MERGE_CONFLICT_COMPLETION_SETTLE_MS = 30 * 60000;
var REPEATED_REVIEW_FINDING_MIN_PRIOR_COMMENTS = 3;
var PROTECTED_BRANCHES_FOR_AUTO_DELETE = new Set(["main", "main_agent", "main_agents"]);
var JOB_ID_MARKER = "pushpals-jobId";
var SESSION_ID_MARKER = "pushpals-sessionId";
var DEFAULT_WORKSPACE_ROOT = resolve5(import.meta.dir, "..", "..", "..");
var ts = () => new Date().toISOString();
var DEFAULT_DEPS = {
  listOpenPullRequests,
  getPullRequestDiff,
  getCommitMessage,
  getPullRequestCommitMessage,
  listPullRequestComments,
  mergePullRequest,
  closePullRequest,
  deleteBranchRef,
  addPullRequestComment,
  invokeCodexReview,
  fetchImpl: fetch,
  now: () => Date.now(),
  logInfo: (line) => console.log(line),
  logWarn: (line) => console.warn(line),
  logError: (line) => console.error(line)
};
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
function currentBunExecPath() {
  const explicit = String(process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit) {
    const leaf2 = basename(explicit).toLowerCase();
    if (leaf2 === "bun" || leaf2 === "bun.exe")
      return explicit;
  }
  const execPath = (process.execPath ?? "").trim();
  if (!execPath)
    return "";
  const leaf = basename(execPath).toLowerCase();
  if (leaf === "bun" || leaf === "bun.exe")
    return execPath;
  const pathValue = process.platform === "win32" ? String(process.env.PATH ?? process.env.Path ?? "").trim() : String(process.env.PATH ?? "").trim();
  if (!pathValue)
    return "";
  const candidates = process.platform === "win32" ? ["bun.exe", "bun", "bun.cmd", "bun.bat"] : ["bun"];
  for (const rawDir of pathValue.split(delimiter)) {
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
function resolveCodexCmd(codexBin) {
  const bunExec = currentBunExecPath();
  const overrideParts = splitArgs(codexBin);
  const parts = overrideParts.length > 0 ? overrideParts : bunExec ? [bunExec, "x", "--yes", "@openai/codex"] : ["bun", "x", "--yes", "@openai/codex"];
  const first = (parts[0] ?? "").trim().toLowerCase();
  if (!first)
    return parts;
  if (first === "bunx" && bunExec) {
    return [bunExec, "x", ...parts.slice(1)];
  }
  if (first === "bun" && bunExec) {
    return [bunExec, ...parts.slice(1)];
  }
  return parts;
}
function buildCodexExecArgs(codexCmd, outputPath) {
  return [
    ...codexCmd,
    "-c",
    "model_reasoning_effort=low",
    "-a",
    "never",
    "exec",
    "-s",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
    "-"
  ];
}
function resolveReviewerMdPath(reviewerMdPath, options) {
  const raw = reviewerMdPath.trim();
  if (!raw)
    return "";
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const workspaceRoot = resolve5(promptRootOverride || options?.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  const cwd = resolve5(options?.cwd || process.cwd());
  if (isAbsolute2(raw))
    return raw;
  const candidates = new Set;
  candidates.add(resolve5(workspaceRoot, raw));
  candidates.add(resolve5(cwd, raw));
  let cursor = cwd;
  for (let i = 0;i < 6; i += 1) {
    const parent = resolve5(cursor, "..");
    if (parent === cursor)
      break;
    candidates.add(resolve5(parent, raw));
    cursor = parent;
  }
  for (const candidate of candidates) {
    if (existsSync4(candidate))
      return candidate;
  }
  return resolve5(workspaceRoot, raw);
}
function buildCodexEnv(config) {
  const env = { ...process.env };
  if (config.codexAuthMode === "chatgpt" && config.codexHomeDir) {
    env.CODEX_HOME = config.codexHomeDir;
    env.HOME = config.codexHomeDir;
  }
  return env;
}
async function invokeCodexReview(prompt, config) {
  const tmpFile = join4(tmpdir(), `review-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const codexCmd = resolveCodexCmd(config.codexBin);
  const args = buildCodexExecArgs(codexCmd, tmpFile);
  const proc = Bun.spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "ignore",
    stderr: "pipe",
    env: buildCodexEnv(config)
  });
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, config.codexTimeoutMs);
  try {
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) {
      throw new Error(`Codex review timed out after ${config.codexTimeoutMs}ms`);
    }
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 800);
      throw new Error(`Codex review failed (exit ${exitCode}): ${detail || "no stderr"}`);
    }
    return (await Bun.file(tmpFile).text()).trim();
  } finally {
    clearTimeout(killTimer);
    await Bun.file(tmpFile).delete().catch(() => {});
  }
}
function parseReviewVerdict(raw) {
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const obj = parsed;
    const score = typeof obj.score === "number" ? obj.score : Number.parseFloat(String(obj.score));
    if (!Number.isFinite(score))
      return null;
    if (score < 1 || score > 10)
      return null;
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const issues = Array.isArray(obj.issues) ? obj.issues.filter((entry) => typeof entry === "string").map(String) : [];
    const fixInstruction = typeof obj.fix_instruction === "string" ? obj.fix_instruction : "";
    return {
      score,
      summary,
      issues,
      fix_instruction: fixInstruction
    };
  } catch {
    return null;
  }
}
function extractMetaMarker(body, markerName) {
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<!--\\s*${escaped}:\\s*([^\\s>]+)\\s*-->`);
  const match = body.match(re);
  return match ? match[1] : null;
}
function extractPrMeta(body) {
  if (!body)
    return { jobId: null, sessionId: null };
  return {
    jobId: extractMetaMarker(body, JOB_ID_MARKER),
    sessionId: extractMetaMarker(body, SESSION_ID_MARKER)
  };
}
function buildReviewPrompt(reviewerMd, pr, diff, passThreshold) {
  const truncatedDiff = diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}
...(diff truncated)` : diff;
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  return loadPromptTemplate("review_agent/review_prompt_template.md", {
    pass_threshold: normalizedThreshold.toFixed(1),
    reviewer_md: reviewerMd,
    pr_number: String(pr.number),
    pr_title: String(pr.title ?? ""),
    head_ref: String(pr.head?.ref ?? ""),
    base_ref: String(pr.base?.ref ?? ""),
    diff: truncatedDiff
  });
}
function formatRejectionComment(verdict) {
  const reasoning = deriveReviewGuidance(verdict).items;
  const lines = [
    `## ReviewAgent: Changes Rejected (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    ""
  ];
  if (reasoning.length > 0) {
    lines.push("**Why this was rejected:**");
    for (const issue of reasoning) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }
  lines.push("_This PR has been re-queued for automated fixes. A worker will address the issues above._");
  return lines.join(`
`);
}
function formatGiveUpComment(verdict, reason) {
  const lines = [
    `## ReviewAgent: PR Closed Without Merge (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    `**Reason:** ${reason}`,
    "",
    "_No additional auto-fix attempts will be made for this PR. The PR is being closed and its branch deleted._"
  ];
  return lines.join(`
`);
}
function formatApprovalComment(verdict, passThreshold) {
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  const guidance = deriveReviewGuidance(verdict);
  const lines = [
    `## ReviewAgent: Changes Approved (score ${verdict.score.toFixed(1)}/10)`,
    "",
    `**Verdict:** ${verdict.summary}`,
    `**Threshold:** ${normalizedThreshold.toFixed(1)}/10`,
    `**Why this passed:** Score ${verdict.score.toFixed(1)}/10 is >= ${normalizedThreshold.toFixed(1)}/10.`,
    ""
  ];
  if (guidance.items.length > 0) {
    lines.push(guidance.source === "summary" ? "**Reviewer Notes:**" : "**Potential Improvements:**");
    for (const issue of guidance.items) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push("**Potential Improvements:**");
    lines.push("- None noted by reviewer.");
  }
  lines.push("", "_This PR met the configured review threshold and is approved for automated merge._");
  return lines.join(`
`);
}
function splitCommitTitleAndBody(message) {
  const normalized = message.replace(/\r\n/g, `
`).trimEnd();
  if (!normalized)
    return { title: "", body: "" };
  const [firstLine, ...rest] = normalized.split(`
`);
  return {
    title: firstLine.trim(),
    body: rest.join(`
`).replace(/^\n+/, "").trimEnd()
  };
}
function formatReviewAgentMergeSection(pr, verdict, passThreshold) {
  const normalizedThreshold = Math.max(1, Math.min(10, passThreshold));
  return [
    "ReviewAgent:",
    `- Merged, passed threshold of ${normalizedThreshold.toFixed(1)}, commit rating ${verdict.score.toFixed(1)}/10.`,
    `- PR: ${pr.html_url}`
  ].join(`
`);
}
function buildMergeCommitText(args) {
  const parsed = splitCommitTitleAndBody(args.sourceCommitMessage);
  const commitTitle = parsed.title || `${args.pr.title} (#${args.pr.number})`;
  const reviewAgentSection = formatReviewAgentMergeSection(args.pr, args.verdict, args.passThreshold);
  const commitMessage = parsed.body ? `${parsed.body}

${reviewAgentSection}` : reviewAgentSection;
  return { commitTitle, commitMessage };
}
function buildFallbackFixInstruction(pr, verdict) {
  const reasoning = deriveReviewGuidance(verdict).items;
  const issueBlock = reasoning.length > 0 ? reasoning.map((issue, index) => `${index + 1}. ${issue}`).join(`
`) : verdict.summary || "Address all review issues and raise quality to the required threshold.";
  return [
    `Address ReviewAgent feedback for PR #${pr.number} (${pr.html_url}) on branch ${pr.head.ref}.`,
    "Fix all issues listed below while preserving intended behavior.",
    "",
    issueBlock,
    "",
    "Run relevant tests and ensure both positive and negative/edge cases are covered."
  ].join(`
`);
}
function normalizeCommentBody(body) {
  return body.replace(/\r\n/g, `
`).trim();
}
function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}
function truncateText(value, maxChars) {
  if (maxChars <= 0)
    return "";
  if (value.length <= maxChars)
    return value;
  if (maxChars <= 3)
    return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}
function summarizeFeedbackText(value) {
  return truncateText(collapseWhitespace(value), MAX_AUTONOMY_FEEDBACK_SUMMARY_CHARS);
}
function deriveReviewGuidance(verdict) {
  const explicitIssues = verdict.issues.map((issue) => collapseWhitespace(String(issue ?? ""))).filter(Boolean);
  if (explicitIssues.length > 0) {
    return { items: explicitIssues, source: "issues" };
  }
  const instructionLines = String(verdict.fix_instruction ?? "").replace(/\r\n/g, `
`).split(`
`).map((line) => collapseWhitespace(line)).filter(Boolean).filter((line) => !/^address reviewagent feedback\b/i.test(line) && !/^fix all issues listed below\b/i.test(line) && !/^run relevant tests\b/i.test(line));
  if (instructionLines.length > 0) {
    return { items: instructionLines, source: "fix_instruction" };
  }
  const summary = collapseWhitespace(verdict.summary);
  if (summary) {
    return { items: [summary], source: "summary" };
  }
  return { items: [], source: "none" };
}
function buildReviewFeedbackContext(comments, excludedBodies = []) {
  const excluded = new Set(excludedBodies.map((body) => normalizeCommentBody(body)).filter((body) => body.length > 0));
  const lines = [];
  let usedChars = 0;
  for (const comment of comments) {
    if (lines.length >= MAX_REVIEW_CONTEXT_COMMENTS)
      break;
    const normalizedBody = normalizeCommentBody(comment.body);
    if (!normalizedBody || excluded.has(normalizedBody))
      continue;
    const compactBody = truncateText(collapseWhitespace(normalizedBody), MAX_REVIEW_CONTEXT_COMMENT_CHARS);
    if (!compactBody)
      continue;
    const author = comment.userLogin.trim() ? `@${comment.userLogin.trim()}` : "unknown";
    const line = `- ${author}: ${compactBody}`;
    if (usedChars + line.length > MAX_REVIEW_CONTEXT_TOTAL_CHARS)
      break;
    lines.push(line);
    usedChars += line.length;
  }
  if (lines.length === 0)
    return [];
  return ["Recent PR feedback comments:", ...lines];
}
var REVIEW_FINDING_THEMES = [
  {
    key: "gitignore-node-modules-noise",
    label: "unrelated .gitignore/node_modules noise",
    patterns: [/\.gitignore/i, /\bnode_modules\b/i]
  },
  {
    key: "unused-react-native-mock",
    label: "unused or unrelated React Native mock changes",
    patterns: [/reactnativemock/i]
  },
  {
    key: "deleted-existing-coverage",
    label: "deleted or weakened existing test coverage",
    patterns: [/\b(delet|remov)\w*\b.{0,80}\b(test|coverage|assertion|case)s?\b/i]
  },
  {
    key: "self-referential-tests",
    label: "self-referential or tautological tests",
    patterns: [
      /\b(self[- ]?referential|tautolog|only tests? the helper|duplicates? implementation)\b/i
    ]
  },
  {
    key: "unintegrated-helper",
    label: "new helper is not integrated into runtime behavior",
    patterns: [
      /\b(unintegrated|not integrated|unused helper|dead helper|only referenced by tests?)\b/i
    ]
  },
  {
    key: "hardcoded-diagnostics",
    label: "hard-coded or hidden diagnostics instead of product behavior",
    patterns: [/\b(hard[- ]?coded|hidden diagnostics?|static diagnostics?|debug-only)\b/i]
  },
  {
    key: "compile-or-validation-failure",
    label: "compile, typecheck, lint, or validation failure",
    patterns: [/\b(typecheck|tsc|lint|compile|validation|test)\b.{0,80}\b(fail|error|broken)\b/i]
  },
  {
    key: "duplicate-or-misplaced-tests",
    label: "duplicate or misplaced tests",
    patterns: [
      /\b(duplicate|misplaced|wrong file|wrong path)\b.{0,80}\b(test|coverage|assertion)s?\b/i
    ]
  },
  {
    key: "pushpals-internal-leak",
    label: "PushPals-internal/autonomy concepts leaked into the user repo",
    patterns: [
      /\b(queue_health|workerpal|remotebuddy|sourcecontrolmanager|reviewagent|pushpals)\b/i
    ]
  }
];
function reviewFindingThemeKeys(text) {
  const normalized = String(text ?? "").replace(/[_-]+/g, " ");
  const keys = new Set;
  for (const theme of REVIEW_FINDING_THEMES) {
    if (theme.patterns.some((pattern) => pattern.test(normalized))) {
      keys.add(theme.key);
    }
  }
  return [...keys];
}
function reviewFindingThemeLabel(key) {
  return REVIEW_FINDING_THEMES.find((theme) => theme.key === key)?.label ?? key;
}
function summarizeRepeatedReviewFindings(args) {
  const currentKeys = new Set(args.currentFindings.flatMap((entry) => reviewFindingThemeKeys(String(entry ?? ""))));
  if (currentKeys.size === 0) {
    return { issues: [], repeatedThemeKeys: [], shouldGiveUp: false };
  }
  const previousCounts = new Map;
  for (const feedback of args.previousFeedback) {
    const keysInComment = new Set(reviewFindingThemeKeys(feedback));
    for (const key of keysInComment) {
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
  }
  const repeatedThemeKeys = [...currentKeys].filter((key) => (previousCounts.get(key) ?? 0) >= 2);
  const issues = repeatedThemeKeys.map((key) => `Repeated unresolved ReviewAgent finding: ${reviewFindingThemeLabel(key)}. The next fix must directly remove this pattern instead of reworking adjacent code.`);
  const minPriorComments = Math.max(1, Math.floor(args.minPriorComments ?? REPEATED_REVIEW_FINDING_MIN_PRIOR_COMMENTS));
  return {
    issues,
    repeatedThemeKeys,
    shouldGiveUp: issues.length > 0 && args.previousFeedback.length >= minPriorComments
  };
}
function uniqueNonEmptyLines(values) {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    const line = collapseWhitespace(String(value ?? ""));
    if (!line)
      continue;
    const key = line.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
function testDeclarationCounts(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (/^\+\s*(?:test|it|describe)\s*\(/.test(line))
      added += 1;
    if (/^-\s*(?:test|it|describe)\s*\(/.test(line))
      removed += 1;
  }
  return { added, removed };
}
function countDiffTokenOutsideFile(diff, token, excludedPath) {
  let currentPath = "";
  let count = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitLinePaths(line);
      currentPath = normalizeDiffPath(parsed?.bPath ?? parsed?.aPath ?? "") ?? "";
      continue;
    }
    if (currentPath === excludedPath)
      continue;
    if (token.test(line))
      count += 1;
  }
  return count;
}
function collectReviewHygieneIssuesFromDiff(diff) {
  const changedPaths = parseChangedPathsFromDiff(diff);
  const changedPathSet = new Set(changedPaths);
  const issues = [];
  if (changedPathSet.has(".gitignore") && /^\+node_modules\s*$/m.test(diff)) {
    issues.push("PR adds bare node_modules noise to .gitignore. Keep dependency/cache hygiene out of feature PRs unless the task explicitly changes repo ignore policy.");
  }
  if (changedPathSet.has("tests/reactNativeMock.ts") && countDiffTokenOutsideFile(diff, /reactNativeMock/i, "tests/reactNativeMock.ts") === 0) {
    issues.push("PR adds or changes tests/reactNativeMock.ts without wiring it into a changed test. Remove the unrelated mock or add a focused consumer in the same PR.");
  }
  const declarationCounts = testDeclarationCounts(diff);
  if (declarationCounts.removed >= 3 && declarationCounts.removed > declarationCounts.added) {
    issues.push("PR removes multiple existing test declarations without replacing equivalent coverage. Preserve existing coverage unless the task is explicitly a test deletion/refactor.");
  }
  const changedTestPaths = changedPaths.filter((path) => /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path));
  const changedRuntimePaths = changedPaths.filter((path) => /\.(?:[cm]?[jt]sx?)$/i.test(path) && !/(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path));
  if (changedTestPaths.length > 0 && changedRuntimePaths.length > 0 && changedRuntimePaths.every((path) => /^utils\//i.test(path)) && !changedRuntimePaths.some((path) => /(?:index|route|screen|component|store|service)/i.test(path))) {
    issues.push("PR adds utility/helper code with tests but no clear runtime integration point. Integrate the helper into behavior-owning code or keep it as a test fixture.");
  }
  if (changedPaths.some((path) => /(^|\/)_layout\.autonomy\.test\.[cm]?[jt]sx?$/i.test(path)) && /\b(queue_health|workerpal|remotebuddy|sourcecontrolmanager|reviewagent|pushpals)\b/i.test(diff)) {
    issues.push("Layout autonomy tests contain PushPals-internal orchestration concepts. Keep user-repo review coverage focused on app behavior and route/startup contracts.");
  }
  return uniqueNonEmptyLines(issues);
}
function buildDeterministicReviewHygieneVerdict(issues, passThreshold) {
  return {
    score: Math.max(1, Math.min(6, passThreshold - 1)),
    summary: "Deterministic PR hygiene gate rejected unrelated or risky changes before LLM review.",
    issues,
    fix_instruction: "Remove the hygiene violations first, keep the branch focused on the requested product behavior, preserve existing tests, and rerun the repo-native validation commands."
  };
}
function normalizeDiffPath(value) {
  const trimmed = value.trim().replace(/^"+|"+$/g, "");
  if (!trimmed || trimmed === "/dev/null")
    return null;
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized))
    return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0)
    return null;
  if (parts.some((part) => part === "." || part === ".."))
    return null;
  return parts.join("/");
}
function normalizeReviewPrHeadRef(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const withoutPrefix = trimmed.replace(/^refs\/heads\//, "");
  const normalized = withoutPrefix.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized)
    return null;
  if (!normalized.startsWith("agent/"))
    return null;
  if (normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    return null;
  }
  if (/[~^:?*\[\]\s]/.test(normalized))
    return null;
  return normalized;
}
function normalizeBranchRef(value) {
  return String(value ?? "").trim().replace(/^refs\/heads\//, "").replace(/^heads\//, "").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}
function isSafeBranchRefForDelete(ref) {
  const normalized = normalizeBranchRef(ref);
  if (!normalized)
    return false;
  if (normalized.includes(".."))
    return false;
  if (normalized.includes("@{"))
    return false;
  if (normalized.endsWith("."))
    return false;
  if (normalized.endsWith(".lock"))
    return false;
  if (/[\s~^:?*\[\]\\]/.test(normalized))
    return false;
  return true;
}
function resolveMergedBranchDeletionPlan(pr) {
  const normalizedHeadRef = normalizeBranchRef(pr.head.ref);
  if (!normalizedHeadRef) {
    return {
      shouldDelete: false,
      normalizedHeadRef: "",
      reason: "head ref missing or invalid"
    };
  }
  const headLower = normalizedHeadRef.toLowerCase();
  if (PROTECTED_BRANCHES_FOR_AUTO_DELETE.has(headLower)) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: `protected branch (${normalizedHeadRef})`
    };
  }
  const baseLower = normalizeBranchRef(pr.base.ref).toLowerCase();
  if (baseLower && baseLower === headLower) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: "head branch matches base branch"
    };
  }
  if (!isSafeBranchRefForDelete(normalizedHeadRef)) {
    return {
      shouldDelete: false,
      normalizedHeadRef,
      reason: "head branch ref failed safety validation"
    };
  }
  return {
    shouldDelete: true,
    normalizedHeadRef,
    reason: ""
  };
}
function decodeQuotedGitPath(value) {
  return value.replace(/\\([0-7]{1,3}|.)/g, (_match, token) => {
    if (/^[0-7]{1,3}$/.test(token)) {
      return String.fromCharCode(Number.parseInt(token, 8));
    }
    switch (token) {
      case "n":
        return `
`;
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return token;
    }
  });
}
function parseDiffGitLinePaths(line) {
  const body = line.slice("diff --git ".length).trim();
  const match = body.match(/^(?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+))\s+(?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+))$/);
  if (!match)
    return null;
  const aRaw = match[1] ?? match[2] ?? "";
  const bRaw = match[3] ?? match[4] ?? "";
  return {
    aPath: decodeQuotedGitPath(aRaw),
    bPath: decodeQuotedGitPath(bRaw)
  };
}
function parseChangedPathsFromDiff(diff) {
  const paths = new Set;
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("diff --git "))
      continue;
    const parsed = parseDiffGitLinePaths(line);
    if (!parsed)
      continue;
    const aPath = normalizeDiffPath(parsed.aPath);
    const bPath = normalizeDiffPath(parsed.bPath);
    const path = bPath ?? aPath;
    if (path)
      paths.add(path);
  }
  return [...paths];
}
function scopeGlobForPath(path) {
  const parts = path.split("/");
  if (parts.length === 1)
    return path;
  const [first, second] = parts;
  if (parts.length === 2 && second.includes(".")) {
    return `${first}/**`;
  }
  if ((first === "apps" || first === "packages" || first === "tests") && second) {
    return `${first}/${second}/**`;
  }
  return `${first}/**`;
}
function deriveFixWriteGlobsFromDiff(diff) {
  const changedPaths = parseChangedPathsFromDiff(diff);
  if (changedPaths.length === 0) {
    return ["apps/**", "packages/**", "tests/**", "configs/**", "scripts/**"];
  }
  const globs = new Set;
  for (const path of changedPaths)
    globs.add(scopeGlobForPath(path));
  return [...globs].slice(0, 16);
}
function deriveReviewTaskTargetPathsFromDiff(diff) {
  return parseChangedPathsFromDiff(diff).slice(0, 24);
}
function deriveReviewTaskLikelyDirs(paths) {
  const dirs = new Set;
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    if (slash <= 0)
      continue;
    dirs.add(normalized.slice(0, slash));
    if (dirs.size >= 12)
      break;
  }
  return [...dirs];
}
function deriveReviewTaskValidationSteps(paths) {
  const targeted = paths.filter((path) => /(^tests\/|__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/i.test(path)).slice(0, 4).map((path) => `bun test ${formatBunTestPathArg(path)}`);
  return targeted.length > 0 ? targeted : ["bun test"];
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
function buildReviewFixPlannerWorkerInstruction(options) {
  const lines = [
    "Rejected PR revision brief:",
    `- PR: #${options.prNumber} (${options.prUrl})`,
    `- Existing PR branch: ${options.prHeadRef}`,
    `- Base branch: ${options.prBaseRef}`,
    `- Previous ReviewAgent score: ${options.reviewScore.toFixed(1)} / 10`,
    `- Required approval threshold: ${options.reviewThreshold.toFixed(1)} / 10`,
    `- Minimum score improvement needed: +${Math.max(0, options.reviewThreshold - options.reviewScore).toFixed(1)}`,
    "- Make at least one concrete repo change that addresses reviewer feedback, or explicitly document why a finding is invalid in a committed code/test/docs update.",
    "- Do not return an unchanged branch: PushPals refuses unchanged review-fix re-reviews.",
    `- The prepared checkout is the exact leased head of ${options.prHeadRef}. Edit and validate only; do not checkout, switch, reset, merge, rebase, stage, commit, or push.`,
    `- SourceControlManager publication target after host finalization: ${options.prHeadRef} (update the existing PR branch only).`
  ];
  if (options.reviewerFindings.length > 0) {
    lines.push("- Current reviewer must-fix items:");
    for (const finding of options.reviewerFindings.slice(0, 6)) {
      lines.push(`  - ${finding}`);
    }
  }
  if (options.changedPaths.length > 0) {
    lines.push(`- Candidate changed paths from the current PR: ${options.changedPaths.join(", ")}`);
  }
  if (options.feedbackHighlights.length > 0) {
    lines.push("- Recent reviewer comment excerpts:");
    for (const item of options.feedbackHighlights.slice(0, 4)) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push("- Keep the patch focused on the rejected areas, preserve already accepted behavior, and prefer targeted validation before broader test runs.");
  return lines.join(`
`).slice(0, 6000);
}
function buildMergeConflictPlannerWorkerInstruction(options) {
  const lines = [
    "Merge-conflict resolution brief:",
    `- PR: #${options.prNumber} (${options.prUrl})`,
    `- Existing PR branch: ${options.prHeadRef}`,
    `- Deterministic orchestration rebase target: ${options.prBaseRef}`,
    `- SourceControlManager publication target: ${options.prHeadRef} (update the existing PR branch only).`,
    `- Expected remote lease SHA: ${options.prHeadSha}`
  ];
  if (options.mergeErrorSummary) {
    lines.push(`- GitHub mergeability error: ${options.mergeErrorSummary}`);
  }
  if (options.changedPaths.length > 0) {
    lines.push(`- Candidate changed paths from the approved PR: ${options.changedPaths.join(", ")}`);
  }
  lines.push("- Treat the prepared checkout and any in-progress rebase state as authoritative. The worker edits and validates file content only; it must not checkout, switch, reset, merge, rebase, stage, commit, or push.");
  lines.push(`- Resolve conflict markers and run focused validation. Deterministic orchestration continues the rebase onto ${options.prBaseRef}, and SourceControlManager alone publishes ${options.prHeadRef}.`);
  return lines.join(`
`);
}
function normalizeReviewFixHeadSha(value) {
  return String(value ?? "").trim().toLowerCase();
}
function reviewFixDedupeKey(prNumber, headSha) {
  return `${prNumber}:${normalizeReviewFixHeadSha(headSha)}`;
}
function mergeConflictDedupeKey(prNumber, headSha, baseSha) {
  return [
    "merge-conflict",
    Math.floor(prNumber),
    normalizeReviewFixHeadSha(headSha),
    normalizeReviewFixHeadSha(baseSha)
  ].join(":");
}
function extractGitHubApiStatus(error) {
  const message = String(error?.message ?? error ?? "");
  const match = message.match(/\bGitHub API\s+(\d{3})\b/i);
  if (!match)
    return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function isUnmergeablePullRequestError(error) {
  const status = extractGitHubApiStatus(error);
  if (status !== 405 && status !== 409 && status !== 422)
    return false;
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("not mergeable") || message.includes("cannot be merged") || message.includes("merge conflict") || message.includes("has conflicts");
}
function extractActiveReviewJobContextFromJob(job) {
  if (String(job.kind ?? "").trim() !== "task.execute")
    return null;
  const rawParams = job.params;
  let params = {};
  if (typeof rawParams === "string") {
    try {
      const parsed = JSON.parse(rawParams);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed;
      }
    } catch {
      return null;
    }
  } else if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
    params = rawParams;
  } else {
    return null;
  }
  const reviewAgent = params.reviewAgent;
  if (!reviewAgent || typeof reviewAgent !== "object" || Array.isArray(reviewAgent))
    return null;
  const reviewAgentRecord = reviewAgent;
  const prNumber = Number(reviewAgentRecord.prNumber);
  const prHeadSha = normalizeReviewFixHeadSha(String(reviewAgentRecord.prHeadSha ?? ""));
  if (!Number.isFinite(prNumber) || prNumber <= 0 || !prHeadSha)
    return null;
  const rawResolutionType = String(reviewAgentRecord.resolutionType ?? "").trim().toLowerCase();
  const resolutionType = rawResolutionType || "review_fix";
  const prBaseSha = normalizeReviewFixHeadSha(String(reviewAgentRecord.prBaseSha ?? ""));
  return {
    dedupeKey: resolutionType === "merge_conflict" ? mergeConflictDedupeKey(Math.floor(prNumber), prHeadSha, prBaseSha) : reviewFixDedupeKey(Math.floor(prNumber), prHeadSha),
    resolutionType,
    prNumber: Math.floor(prNumber),
    headSha: prHeadSha,
    baseSha: prBaseSha
  };
}

class ReviewAgent {
  config;
  serverUrl;
  githubToken;
  remoteUrl;
  prBaseBranch;
  authToken;
  reviewed = new Map;
  forceReReview = new Map;
  reReviewEnqueueCounts = new Map;
  reviewerMd = "";
  pollInFlight = false;
  deps;
  constructor(config, serverUrl, githubToken, remoteUrl, prBaseBranch, authToken, deps) {
    this.config = config;
    this.serverUrl = serverUrl;
    this.githubToken = githubToken;
    this.remoteUrl = remoteUrl;
    this.prBaseBranch = prBaseBranch;
    this.authToken = authToken;
    this.deps = { ...DEFAULT_DEPS, ...deps ?? {} };
  }
  requestReReview(prNumber, sha) {
    const normalizedSha = String(sha ?? "").trim();
    if (!normalizedSha)
      return;
    this.forceReReview.set(prNumber, normalizedSha);
  }
  loadReviewerMd() {
    if (this.reviewerMd)
      return this.reviewerMd;
    try {
      const mdPath = resolveReviewerMdPath(this.config.reviewerMdPath);
      this.reviewerMd = readFileSync5(mdPath, "utf-8");
      return this.reviewerMd;
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Could not load reviewer.md from ${this.config.reviewerMdPath} (cwd=${process.cwd()}): ${err?.message ?? err}`);
      return "";
    }
  }
  async poll() {
    if (this.pollInFlight) {
      this.deps.logInfo("[ReviewAgent] Poll already in progress, skipping overlapping tick.");
      return;
    }
    this.pollInFlight = true;
    try {
      let prs;
      try {
        prs = await this.deps.listOpenPullRequests({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          headPrefix: "agent/",
          base: this.prBaseBranch
        });
      } catch (err) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to list PRs: ${err?.message ?? err}`);
        return;
      }
      for (const pr of prs) {
        await this.reviewPr(pr);
      }
    } finally {
      this.pollInFlight = false;
    }
  }
  async reviewPr(pr) {
    const sha = pr.head.sha;
    const reviewedSha = this.reviewed.get(pr.number);
    const forcedSha = this.forceReReview.get(pr.number);
    if (reviewedSha !== sha && forcedSha) {
      this.forceReReview.delete(pr.number);
    }
    if (reviewedSha === sha) {
      if (forcedSha !== sha)
        return;
      this.forceReReview.delete(pr.number);
      this.deps.logInfo(`[${ts()}] [ReviewAgent] Re-reviewing PR #${pr.number} at unchanged head ${sha.slice(0, 8)} (forced re-review).`);
    }
    this.deps.logInfo(`[${ts()}] [ReviewAgent] Reviewing PR #${pr.number} (${pr.head.ref} @ ${sha.slice(0, 8)})`);
    let diff;
    try {
      diff = await this.deps.getPullRequestDiff({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number
      });
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to get diff for PR #${pr.number}: ${err?.message ?? err}`);
      return;
    }
    if (!diff.trim()) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} has an empty diff - skipping`);
      this.reviewed.set(pr.number, sha);
      return;
    }
    if (diff.length > MAX_DIFF_BYTES * 2) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} diff is too large (${diff.length} bytes) - skipping`);
      this.reviewed.set(pr.number, sha);
      return;
    }
    const deterministicHygieneIssues = collectReviewHygieneIssuesFromDiff(diff);
    if (deterministicHygieneIssues.length > 0) {
      const verdict2 = buildDeterministicReviewHygieneVerdict(deterministicHygieneIssues, this.config.passThreshold);
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} failed deterministic hygiene gate (${deterministicHygieneIssues.length} issue(s)); skipping Codex review.`);
      const finalized2 = await this.rejectPr(pr, verdict2, diff);
      if (finalized2) {
        this.reviewed.set(pr.number, sha);
      }
      return;
    }
    const reviewerMd = this.loadReviewerMd();
    const prompt = buildReviewPrompt(reviewerMd, pr, diff, this.config.passThreshold);
    let raw;
    try {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] Invoking Codex review for PR #${pr.number}...`);
      raw = await this.deps.invokeCodexReview(prompt, this.config);
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Codex invocation failed for PR #${pr.number}: ${err?.message ?? err}`);
      return;
    }
    const verdict = parseReviewVerdict(raw);
    if (!verdict) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Could not parse Codex verdict for PR #${pr.number}. Raw output:
${raw.slice(0, 500)}`);
      return;
    }
    const approved = verdict.score >= this.config.passThreshold;
    this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} score: ${verdict.score.toFixed(1)}/10 - ${approved ? "APPROVED" : "REJECTED"} (threshold ${this.config.passThreshold.toFixed(1)}/10) - ${verdict.summary}`);
    const finalized = approved ? await this.approvePr(pr, verdict, diff) : await this.rejectPr(pr, verdict, diff);
    if (finalized) {
      this.reviewed.set(pr.number, sha);
    }
  }
  async approvePr(pr, verdict, diff) {
    const { jobId, sessionId } = extractPrMeta(pr.body);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: formatApprovalComment(verdict, this.config.passThreshold)
      });
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to post approval comment on PR #${pr.number}: ${err?.message ?? err}`);
      return false;
    }
    let commitTitle = `${pr.title} (#${pr.number})`;
    let commitMessage = formatReviewAgentMergeSection(pr, verdict, this.config.passThreshold);
    try {
      let sourceCommitMessage = "";
      try {
        sourceCommitMessage = await this.deps.getCommitMessage({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          sha: pr.head.sha
        });
      } catch (primaryErr) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to fetch head commit message for PR #${pr.number} (${pr.head.sha.slice(0, 8)}): ${primaryErr?.message ?? primaryErr}. Trying PR commit fallback...`);
        sourceCommitMessage = await this.deps.getPullRequestCommitMessage({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          prNumber: pr.number,
          sha: pr.head.sha
        });
      }
      const composed = buildMergeCommitText({
        pr,
        verdict,
        passThreshold: this.config.passThreshold,
        sourceCommitMessage
      });
      commitTitle = composed.commitTitle;
      commitMessage = composed.commitMessage;
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to resolve source commit message for PR #${pr.number}; using PR metadata fallback: ${err?.message ?? err}`);
    }
    try {
      const result = await this.deps.mergePullRequest({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        mergeMethod: this.config.mergeMethod,
        commitTitle,
        commitMessage
      });
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} merged (score ${verdict.score.toFixed(1)}/10, sha ${result.sha.slice(0, 8)})`);
      await this.deleteMergedPrHeadBranch(pr);
      this.reReviewEnqueueCounts.delete(pr.number);
      this.forceReReview.delete(pr.number);
      this.reviewed.delete(pr.number);
      const comments = await this.listRecentPrComments(pr.number);
      await this.postAutonomyPrFeedback({
        pr,
        verdict: "approved_merged",
        verdictSummary: verdict.summary,
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments
      });
      return true;
    } catch (err) {
      if (isUnmergeablePullRequestError(err)) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} is approved but not mergeable at ${pr.head.sha.slice(0, 8)}. Enqueueing merge-conflict resolution job.`);
        const handled = await this.handleApprovedMergeConflict(pr, verdict, diff, err);
        if (handled)
          return true;
      }
      this.deps.logError(`[${ts()}] [ReviewAgent] Failed to merge PR #${pr.number}: ${err?.message ?? err}`);
      return false;
    }
  }
  async handleApprovedMergeConflict(pr, verdict, diff, mergeError) {
    const { jobId, sessionId } = extractPrMeta(pr.body);
    if (!sessionId) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} merge conflict handler requires pushpals-sessionId metadata; cannot enqueue resolution job.`);
      return false;
    }
    const existingReviewJobId = await this.findActiveReviewJobIdForPrHead(pr.number, pr.head.sha, "merge_conflict", pr.base.sha);
    if (existingReviewJobId) {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} already has active merge-conflict job ${existingReviewJobId} for fingerprint ${pr.head.sha.slice(0, 8)}:${pr.base.sha.slice(0, 8)}; skipping duplicate merge-conflict enqueue.`);
      return true;
    }
    const circuit = await this.inspectMergeConflictCircuit(pr);
    if (circuit.state !== "closed") {
      const reason = circuit.state === "settling" ? `a completed resolution job is still inside the ${Math.round(MERGE_CONFLICT_COMPLETION_SETTLE_MS / 60000)} minute SourceControlManager settle window` : `${circuit.failedAttempts} failed attempts reached the per-fingerprint limit of ${MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT}`;
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Merge-conflict circuit ${circuit.state} for PR #${pr.number} fingerprint ${circuit.fingerprint}: ${reason}. Waiting for the PR head or base SHA to change before another attempt.`);
      return true;
    }
    const handled = await this.enqueueMergeConflictJob(pr, verdict, sessionId, jobId, diff, mergeError);
    if (handled) {
      const comments = await this.listRecentPrComments(pr.number);
      await this.postAutonomyPrFeedback({
        pr,
        verdict: "approved_unmergeable",
        verdictSummary: `${verdict.summary} merge blocked: ${String(mergeError?.message ?? mergeError ?? "")}`.trim(),
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments
      });
    }
    return handled;
  }
  async rejectPr(pr, verdict, diff) {
    const maxPrCommentsBeforeGiveUp = Math.max(1, Math.floor(this.config.maxPrCommentsBeforeGiveUp));
    const { jobId, sessionId } = extractPrMeta(pr.body);
    const recentComments = await this.listRecentPrComments(pr.number, Math.max(MAX_REVIEW_CONTEXT_COMMENTS * 3, maxPrCommentsBeforeGiveUp));
    if (recentComments.length >= maxPrCommentsBeforeGiveUp) {
      return await this.giveUpOnRejectedPr(pr, verdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp
      });
    }
    const repeatedReviewFindings = summarizeRepeatedReviewFindings({
      currentFindings: [verdict.summary, verdict.fix_instruction, ...verdict.issues],
      previousFeedback: recentComments.map((comment) => comment.body)
    });
    const effectiveVerdict = repeatedReviewFindings.issues.length > 0 ? {
      ...verdict,
      summary: `${verdict.summary} Persistent unresolved review findings remain.`,
      issues: uniqueNonEmptyLines([...verdict.issues, ...repeatedReviewFindings.issues]),
      fix_instruction: uniqueNonEmptyLines([
        verdict.fix_instruction,
        ...repeatedReviewFindings.issues
      ]).join(`
`)
    } : verdict;
    if (repeatedReviewFindings.shouldGiveUp) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} repeated unresolved findings (${repeatedReviewFindings.repeatedThemeKeys.join(", ")}); closing instead of enqueueing another low-signal review-fix job.`);
      return await this.giveUpOnRejectedPr(pr, effectiveVerdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp
      });
    }
    const rejectionComment = formatRejectionComment(effectiveVerdict);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: rejectionComment
      });
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to comment on PR #${pr.number}: ${err?.message ?? err}`);
    }
    await this.postAutonomyPrFeedback({
      pr,
      verdict: "rejected",
      verdictSummary: effectiveVerdict.summary,
      reviewScore: effectiveVerdict.score,
      jobId,
      sessionId,
      comments: recentComments
    });
    if (!sessionId) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} has no pushpals-sessionId in body - cannot re-queue`);
      return true;
    }
    const priorReReviewEnqueues = this.reReviewEnqueueCounts.get(pr.number) ?? 0;
    if (priorReReviewEnqueues >= MAX_PR_RE_REVIEW_ENQUEUES) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} reached max re-review cap (${MAX_PR_RE_REVIEW_ENQUEUES}); closing instead of enqueueing another fix job.`);
      return await this.giveUpOnRejectedPr(pr, effectiveVerdict, {
        jobId,
        sessionId,
        recentComments,
        maxPrCommentsBeforeGiveUp,
        reason: `Reached automated review-fix retry cap (${MAX_PR_RE_REVIEW_ENQUEUES}).`,
        feedbackVerdict: "rejected_re_review_cap_closed",
        feedbackSummarySuffix: `closed after reaching automated review-fix retry cap (${MAX_PR_RE_REVIEW_ENQUEUES}).`
      });
    }
    const existingFixJobId = await this.findActiveReviewJobIdForPrHead(pr.number, pr.head.sha, "review_fix");
    if (existingFixJobId) {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} already has active fix job ${existingFixJobId} for head ${pr.head.sha.slice(0, 8)}; skipping duplicate enqueue.`);
      return true;
    }
    const nextReReviewEnqueues = priorReReviewEnqueues + 1;
    this.reReviewEnqueueCounts.set(pr.number, nextReReviewEnqueues);
    const enqueued = await this.enqueueFixJob(pr, effectiveVerdict, sessionId, jobId, diff, [rejectionComment], recentComments);
    if (enqueued) {
      if (nextReReviewEnqueues === MAX_PR_RE_REVIEW_ENQUEUES) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} hit max re-review cap (${MAX_PR_RE_REVIEW_ENQUEUES}); future rejections will not auto-enqueue fix jobs.`);
      }
    } else if (priorReReviewEnqueues > 0) {
      this.reReviewEnqueueCounts.set(pr.number, priorReReviewEnqueues);
    } else {
      this.reReviewEnqueueCounts.delete(pr.number);
    }
    return true;
  }
  async giveUpOnRejectedPr(pr, verdict, context) {
    const reason = context.reason ?? `Reached PR feedback comment cap (${context.recentComments.length}/${context.maxPrCommentsBeforeGiveUp}).`;
    this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} ${reason} Closing without merge.`);
    try {
      const result = await this.deps.closePullRequest({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number
      });
      if (!result.closed) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Close PR #${pr.number} request returned state=${result.state || "(unknown)"}; will retry on next poll.`);
        return false;
      }
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to close PR #${pr.number} after give-up condition: ${err?.message ?? err}`);
      return false;
    }
    const giveUpComment = formatGiveUpComment(verdict, reason);
    try {
      await this.deps.addPullRequestComment({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber: pr.number,
        body: giveUpComment
      });
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Closed PR #${pr.number} but failed to post give-up comment: ${err?.message ?? err}`);
    }
    await this.postAutonomyPrFeedback({
      pr,
      verdict: context.feedbackVerdict ?? "rejected_comment_cap_closed",
      verdictSummary: `${verdict.summary} | ${context.feedbackSummarySuffix ?? `closed after reaching PR comment cap (${context.maxPrCommentsBeforeGiveUp}).`}`,
      reviewScore: verdict.score,
      jobId: context.jobId,
      sessionId: context.sessionId,
      comments: context.recentComments
    });
    await this.deletePrHeadBranch(pr, "closed");
    this.reReviewEnqueueCounts.delete(pr.number);
    this.forceReReview.delete(pr.number);
    this.reviewed.delete(pr.number);
    return true;
  }
  async deleteMergedPrHeadBranch(pr) {
    await this.deletePrHeadBranch(pr, "merged");
  }
  async deletePrHeadBranch(pr, mode) {
    const plan = resolveMergedBranchDeletionPlan(pr);
    if (!plan.shouldDelete) {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] Skipping branch delete for ${mode} PR #${pr.number}: ${plan.reason}`);
      return;
    }
    try {
      const result = await this.deps.deleteBranchRef({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        branchRef: plan.normalizedHeadRef
      });
      if (result.deleted) {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] Deleted ${mode} PR head branch ${plan.normalizedHeadRef} for PR #${pr.number}`);
      } else {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] Branch ${plan.normalizedHeadRef} already absent after ${mode} for PR #${pr.number}`);
      }
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to delete ${mode} branch ${plan.normalizedHeadRef} for PR #${pr.number}: ${err?.message ?? err}`);
    }
  }
  async sendSessionCommand(sessionId, headers, command) {
    const response = await this.deps.fetchImpl(`${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify(command)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`session command failed: HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }
  }
  async findActiveReviewJobIdForPrHead(prNumber, headSha, resolutionType, baseSha = "") {
    const normalizedHeadSha = normalizeReviewFixHeadSha(headSha);
    const normalizedBaseSha = normalizeReviewFixHeadSha(baseSha);
    const headers = {};
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    for (const status of ["pending", "claimed"]) {
      try {
        const url = `${this.serverUrl}/jobs?status=${status}&limit=${MAX_ACTIVE_FIX_JOB_SCAN}`;
        const response = await this.deps.fetchImpl(url, { headers });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed active-fix dedupe scan (${status}) for PR #${prNumber}: HTTP ${response.status}${text ? `: ${text}` : ""}`);
          continue;
        }
        const payload = await response.json().catch(() => null);
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
        for (const rawJob of jobs) {
          if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob))
            continue;
          const job = rawJob;
          const context = extractActiveReviewJobContextFromJob(job);
          if (!context || context.prNumber !== Math.floor(prNumber) || context.headSha !== normalizedHeadSha) {
            continue;
          }
          if (resolutionType && context.resolutionType !== resolutionType)
            continue;
          if (resolutionType === "merge_conflict" && normalizedBaseSha && context.baseSha && context.baseSha !== normalizedBaseSha) {
            continue;
          }
          const jobId = typeof job.id === "string" && job.id.trim().length > 0 ? job.id.trim() : "(unknown)";
          return jobId;
        }
      } catch (err) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Active-fix dedupe scan failed for PR #${prNumber} (${status}): ${err?.message ?? err}`);
      }
    }
    return null;
  }
  async inspectMergeConflictCircuit(pr) {
    const fingerprint = mergeConflictDedupeKey(pr.number, pr.head.sha, pr.base.sha);
    const headers = {};
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    let failedAttempts = 0;
    let newestCompletedAt = 0;
    for (const status of ["failed", "publish_blocked", "completed"]) {
      try {
        const url = `${this.serverUrl}/jobs?status=${status}&limit=${MAX_ACTIVE_FIX_JOB_SCAN}`;
        const response = await this.deps.fetchImpl(url, { headers });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed merge-conflict circuit scan (${status}) for PR #${pr.number}: HTTP ${response.status}${text ? `: ${text}` : ""}`);
          continue;
        }
        const payload = await response.json().catch(() => null);
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
        for (const rawJob of jobs) {
          if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob))
            continue;
          const job = rawJob;
          const context = extractActiveReviewJobContextFromJob(job);
          if (!context || context.resolutionType !== "merge_conflict" || context.dedupeKey !== fingerprint) {
            continue;
          }
          if (status === "completed") {
            const completedAt = Date.parse(String(job.completedAt ?? job.completed_at ?? job.updatedAt ?? job.updated_at ?? job.createdAt ?? job.created_at ?? ""));
            if (Number.isFinite(completedAt)) {
              newestCompletedAt = Math.max(newestCompletedAt, completedAt);
            }
          } else {
            failedAttempts += 1;
          }
        }
      } catch (err) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Merge-conflict circuit scan failed for PR #${pr.number} (${status}): ${err?.message ?? err}`);
      }
    }
    if (failedAttempts >= MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT) {
      return { state: "open", fingerprint, failedAttempts };
    }
    if (newestCompletedAt > 0 && this.deps.now() - newestCompletedAt < MERGE_CONFLICT_COMPLETION_SETTLE_MS) {
      return { state: "settling", fingerprint, failedAttempts };
    }
    return { state: "closed", fingerprint, failedAttempts };
  }
  async emitFixJobQueuedEvents(args) {
    const ensureSessionResponse = await this.deps.fetchImpl(`${this.serverUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: args.sessionId })
    });
    if (!ensureSessionResponse.ok) {
      const text = await ensureSessionResponse.text().catch(() => "");
      throw new Error(`failed to ensure session ${args.sessionId}: HTTP ${ensureSessionResponse.status}${text ? `: ${text}` : ""}`);
    }
    const from = "agent:source_control_manager/review_agent";
    const defaultTaskDescription = args.verdict.summary.trim() || `Address ReviewAgent feedback and update PR #${args.pr.number} (${args.pr.html_url}).`;
    const taskDescription = args.taskDescription?.trim() || defaultTaskDescription;
    const shortHeadSha = normalizeReviewFixHeadSha(args.pr.head.sha).slice(0, 8) || "unknown";
    const taskTitle = args.taskTitle?.trim() || `Address ReviewAgent feedback for PR #${args.pr.number} @ ${shortHeadSha}`;
    const taskTags = Array.isArray(args.taskTags) && args.taskTags.length > 0 ? args.taskTags : ["review-agent", "pr-fix"];
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "task_created",
      from,
      correlationId: args.taskId,
      payload: {
        taskId: args.taskId,
        title: taskTitle,
        description: taskDescription,
        createdBy: "review_agent",
        priority: "normal",
        tags: taskTags
      }
    });
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "task_started",
      from,
      correlationId: args.taskId,
      payload: {
        taskId: args.taskId
      }
    });
    await this.sendSessionCommand(args.sessionId, args.headers, {
      type: "job_enqueued",
      from,
      correlationId: args.taskId,
      payload: {
        jobId: args.jobId,
        taskId: args.taskId,
        kind: args.kind,
        params: args.params,
        origin: "autonomy"
      }
    });
  }
  async listRecentPrComments(prNumber, maxComments = MAX_REVIEW_CONTEXT_COMMENTS * 3) {
    try {
      return await this.deps.listPullRequestComments({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        prNumber,
        maxComments: Math.max(1, Math.floor(maxComments))
      });
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to load comments for PR #${prNumber}: ${err?.message ?? err}`);
      return [];
    }
  }
  async getRecentFeedbackContext(pr, excludedBodies = [], prefetchedComments) {
    const comments = Array.isArray(prefetchedComments) && prefetchedComments.length > 0 ? prefetchedComments : await this.listRecentPrComments(pr.number);
    if (comments.length === 0)
      return [];
    return buildReviewFeedbackContext(comments, excludedBodies);
  }
  async postAutonomyPrFeedback(args) {
    const normalizedVerdict = String(args.verdict ?? "").trim().toLowerCase();
    if (!normalizedVerdict)
      return;
    const headers = { "Content-Type": "application/json" };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    const normalizedHeadSha = normalizeReviewFixHeadSha(args.pr.head.sha) || "unknown";
    const feedbackKey = `review_agent:pr:${args.pr.number}:head:${normalizedHeadSha}:verdict:${normalizedVerdict}`;
    const comments = (Array.isArray(args.comments) ? args.comments : []).slice(0, MAX_AUTONOMY_FEEDBACK_COMMENTS).map((comment) => ({
      body: truncateText(normalizeCommentBody(comment.body), MAX_AUTONOMY_FEEDBACK_COMMENT_CHARS),
      userLogin: String(comment.userLogin ?? "").trim(),
      createdAt: String(comment.createdAt ?? "").trim(),
      htmlUrl: String(comment.htmlUrl ?? "").trim()
    })).filter((row) => row.body.length > 0);
    const payload = {
      source: "review_agent",
      feedbackKey,
      jobId: args.jobId ?? undefined,
      sessionId: args.sessionId ?? undefined,
      prNumber: args.pr.number,
      prUrl: args.pr.html_url,
      verdict: normalizedVerdict,
      reviewScore: Number.isFinite(args.reviewScore) ? args.reviewScore : undefined,
      reviewThreshold: this.config.passThreshold,
      summary: summarizeFeedbackText(args.verdictSummary || args.pr.title || normalizedVerdict),
      commentCount: comments.length,
      comments
    };
    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/autonomy/pr-feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to post autonomy PR feedback for PR #${args.pr.number}: HTTP ${response.status}${text ? `: ${text}` : ""}`);
      }
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to post autonomy PR feedback for PR #${args.pr.number}: ${err?.message ?? err}`);
    }
  }
  async enqueueFixJob(pr, verdict, sessionId, jobId, diff, excludedBodies = [], prefetchedComments) {
    const taskId = `review-fix-pr${pr.number}-${this.deps.now()}`;
    const reviewGuidance = deriveReviewGuidance(verdict);
    const rejectionReasoning = reviewGuidance.items;
    const issuesSummary = rejectionReasoning.length > 0 ? rejectionReasoning.join("; ") : "see summary";
    const fixInstruction = verdict.fix_instruction.trim() || buildFallbackFixInstruction(pr, verdict);
    const writeGlobs = deriveFixWriteGlobsFromDiff(diff);
    const changedPaths = deriveReviewTaskTargetPathsFromDiff(diff);
    const likelyDirs = deriveReviewTaskLikelyDirs(changedPaths);
    const validationSteps2 = deriveReviewTaskValidationSteps(changedPaths);
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref);
    const feedbackContext = await this.getRecentFeedbackContext(pr, excludedBodies, prefetchedComments);
    const feedbackHighlights = feedbackContext.filter((line) => line.trim().startsWith("- ")).map((line) => line.trim().replace(/^- /, "")).slice(0, 4);
    const plannerWorkerInstruction = buildReviewFixPlannerWorkerInstruction({
      prNumber: pr.number,
      prUrl: pr.html_url,
      prHeadRef: prHeadRef ?? pr.head.ref,
      prBaseRef: pr.base.ref,
      reviewScore: verdict.score,
      reviewThreshold: this.config.passThreshold,
      reviewerFindings: rejectionReasoning,
      changedPaths,
      feedbackHighlights
    });
    const discoveryKeywords = [...new Set([...rejectionReasoning, ...feedbackHighlights])].map((entry) => truncateText(collapseWhitespace(entry), 180)).filter(Boolean).slice(0, 8);
    const payload = {
      taskId,
      sessionId,
      kind: "task.execute",
      prUrl: pr.html_url,
      dedupeKey: reviewFixDedupeKey(pr.number, pr.head.sha),
      dedupeCooldownMs: REVIEW_FIX_JOB_DEDUPE_COOLDOWN_MS,
      params: {
        schemaVersion: 2,
        origin: "autonomy",
        instruction: fixInstruction,
        plannerWorkerInstruction,
        recentContext: [
          loadPromptTemplate("review_agent/fix_job_intro_line.md", {
            pr_number: String(pr.number),
            pr_url: pr.html_url,
            pr_head_ref: String(pr.head?.ref ?? "")
          }),
          "The host prepared the exact leased PR-head checkout. Edit and validate only; deterministic finalization creates the completion commit and SourceControlManager owns publication.",
          "Review-fix jobs must produce at least one concrete committed change. If a reviewer finding is invalid, make a small code/test/docs update that documents the reason; unchanged branch re-review is refused.",
          `Raise this PR from ${verdict.score.toFixed(1)}/10 to at least ${this.config.passThreshold.toFixed(1)}/10 without reopening already accepted behavior.`,
          `Reviewer score was ${verdict.score.toFixed(1)}/10. Issues: ${issuesSummary}`,
          ...feedbackContext
        ],
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          ...changedPaths.length > 0 ? { targetPaths: changedPaths } : {},
          acceptanceCriteria: [
            `Reviewer scores >= ${this.config.passThreshold}/10`,
            "Address the latest reviewer must-fix items without regressing accepted behavior",
            "All relevant tests pass"
          ],
          validationSteps: validationSteps2,
          queuePriority: "normal",
          queueWaitBudgetMs: 90000,
          executionBudgetMs: 1200000,
          finalizationBudgetMs: 120000,
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs },
          discovery: {
            ripgrepQueries: [...changedPaths.slice(0, 6), ...rejectionReasoning.slice(0, 2)],
            likelyDirs,
            keywords: discoveryKeywords
          }
        },
        completionBranch: prHeadRef ?? undefined,
        reviewAgent: {
          prNumber: pr.number,
          prUrl: pr.html_url,
          prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
          prHeadRef: prHeadRef ?? pr.head.ref,
          prBaseRef: pr.base.ref,
          resolutionType: "review_fix",
          previousReviewScore: verdict.score,
          reviewThreshold: this.config.passThreshold,
          previousReviewSummary: verdict.summary,
          reviewerFindings: rejectionReasoning.slice(0, 8),
          reviewerFindingsSource: reviewGuidance.source,
          rejectedAt: new Date().toISOString(),
          sourceJobId: jobId
        },
        lane: "worker",
        recentJobs: []
      }
    };
    const headers = { "Content-Type": "application/json" };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      const responseBody = await response.json().catch(() => null);
      const enqueuedJobId = responseBody && typeof responseBody.jobId === "string" ? responseBody.jobId : "";
      const deduped = responseBody?.deduped === true;
      const dedupeMessage = responseBody && typeof responseBody.message === "string" ? responseBody.message : "";
      if (enqueuedJobId && !deduped) {
        try {
          await this.emitFixJobQueuedEvents({
            sessionId,
            taskId,
            jobId: enqueuedJobId,
            kind: "task.execute",
            params: payload.params,
            pr,
            verdict,
            headers,
            taskDescription: `Raise PR #${pr.number} from ${verdict.score.toFixed(1)}/10 to >= ${this.config.passThreshold.toFixed(1)}/10 on the existing branch.`,
            taskTags: ["review-agent", "review-fix"]
          });
        } catch (emitErr) {
          this.deps.logWarn(`[${ts()}] [ReviewAgent] Fix job ${enqueuedJobId} enqueued for PR #${pr.number}, but failed to emit session task/job events: ${emitErr?.message ?? emitErr}`);
        }
      }
      if (deduped) {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} fix request deduped to existing active job ${enqueuedJobId || "(unknown)"} for head ${pr.head.sha.slice(0, 8)}${dedupeMessage ? ` (${dedupeMessage})` : ""}; skipping duplicate task events.`);
        return true;
      }
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} rejected (score ${verdict.score.toFixed(1)}/10) - fix job ${taskId}${enqueuedJobId ? ` (${enqueuedJobId})` : ""} enqueued`);
      return true;
    } catch (err) {
      this.deps.logError(`[${ts()}] [ReviewAgent] Failed to enqueue fix job for PR #${pr.number}: ${err?.message ?? err}`);
      return false;
    }
  }
  async enqueueMergeConflictJob(pr, verdict, sessionId, jobId, diff, mergeError) {
    const taskId = `review-merge-conflict-pr${pr.number}-${this.deps.now()}`;
    const writeGlobs = deriveFixWriteGlobsFromDiff(diff);
    const changedPaths = deriveReviewTaskTargetPathsFromDiff(diff);
    const likelyDirs = deriveReviewTaskLikelyDirs(changedPaths);
    const validationSteps2 = deriveReviewTaskValidationSteps(changedPaths);
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref);
    const mergeErrorSummary = truncateText(collapseWhitespace(String(mergeError?.message ?? mergeError ?? "")), 360);
    const plannerWorkerInstruction = buildMergeConflictPlannerWorkerInstruction({
      prNumber: pr.number,
      prUrl: pr.html_url,
      prHeadRef: prHeadRef ?? pr.head.ref,
      prBaseRef: pr.base.ref,
      prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
      mergeErrorSummary,
      changedPaths
    });
    const instruction = loadPromptTemplate("review_agent/merge_conflict_instruction.md", {
      pr_number: String(pr.number),
      pr_url: pr.html_url,
      pr_head_ref: String(pr.head?.ref ?? ""),
      pr_base_ref: String(pr.base?.ref ?? ""),
      review_score: verdict.score.toFixed(1)
    });
    const payload = {
      taskId,
      sessionId,
      kind: "task.execute",
      prUrl: pr.html_url,
      dedupeKey: mergeConflictDedupeKey(pr.number, pr.head.sha, pr.base.sha),
      dedupeCooldownMs: REVIEW_MERGE_CONFLICT_JOB_DEDUPE_COOLDOWN_MS,
      params: {
        schemaVersion: 2,
        origin: "autonomy",
        instruction,
        plannerWorkerInstruction,
        recentContext: [
          loadPromptTemplate("review_agent/merge_conflict_context_intro_line.md", {
            pr_number: String(pr.number),
            pr_url: pr.html_url
          }),
          `Approved score: ${verdict.score.toFixed(1)}/10`,
          mergeErrorSummary ? `GitHub merge error: ${mergeErrorSummary}` : "GitHub merge error: (unavailable)"
        ],
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          ...changedPaths.length > 0 ? { targetPaths: changedPaths } : {},
          acceptanceCriteria: [
            `Branch ${pr.head.ref} rebases cleanly onto ${pr.base.ref} with conflicts resolved.`,
            `PR #${pr.number} becomes mergeable without manual GitHub conflict edits.`,
            "Validation commands relevant to changed files pass."
          ],
          validationSteps: validationSteps2,
          queuePriority: "normal",
          queueWaitBudgetMs: 90000,
          executionBudgetMs: 1200000,
          finalizationBudgetMs: 120000,
          scope: { readAnywhere: true, writeAllowed: true, writeGlobs },
          discovery: {
            ripgrepQueries: changedPaths.slice(0, 8),
            likelyDirs,
            keywords: ["merge conflict", pr.head.ref, pr.base.ref]
          }
        },
        completionBranch: prHeadRef ?? undefined,
        reviewAgent: {
          prNumber: pr.number,
          prUrl: pr.html_url,
          prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
          prBaseSha: normalizeReviewFixHeadSha(pr.base.sha),
          prHeadRef: prHeadRef ?? pr.head.ref,
          prBaseRef: pr.base.ref,
          resolutionType: "merge_conflict",
          previousReviewScore: verdict.score,
          previousReviewSummary: verdict.summary,
          mergeError: mergeErrorSummary,
          requestedAt: new Date().toISOString(),
          sourceJobId: jobId
        },
        lane: "worker",
        recentJobs: []
      }
    };
    const headers = { "Content-Type": "application/json" };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      const responseBody = await response.json().catch(() => null);
      const enqueuedJobId = responseBody && typeof responseBody.jobId === "string" ? responseBody.jobId : "";
      const deduped = responseBody?.deduped === true;
      const dedupeMessage = responseBody && typeof responseBody.message === "string" ? responseBody.message : "";
      if (enqueuedJobId && !deduped) {
        try {
          const shortHeadSha = normalizeReviewFixHeadSha(pr.head.sha).slice(0, 8) || "unknown";
          await this.emitFixJobQueuedEvents({
            sessionId,
            taskId,
            jobId: enqueuedJobId,
            kind: "task.execute",
            params: payload.params,
            pr,
            verdict,
            headers,
            taskTitle: `Resolve merge conflicts for PR #${pr.number} @ ${shortHeadSha}`,
            taskDescription: mergeErrorSummary || `Resolve merge conflicts on ${pr.head.ref} so PR #${pr.number} can be merged.`,
            taskTags: ["review-agent", "merge-conflict"]
          });
        } catch (emitErr) {
          this.deps.logWarn(`[${ts()}] [ReviewAgent] Merge-conflict job ${enqueuedJobId} enqueued for PR #${pr.number}, but failed to emit session task/job events: ${emitErr?.message ?? emitErr}`);
        }
      }
      if (deduped) {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} merge-conflict request deduped to existing active job ${enqueuedJobId || "(unknown)"} for head ${pr.head.sha.slice(0, 8)}${dedupeMessage ? ` (${dedupeMessage})` : ""}; skipping duplicate task events.`);
        return true;
      }
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} approved but unmergeable; merge-conflict job ${taskId}${enqueuedJobId ? ` (${enqueuedJobId})` : ""} enqueued`);
      return true;
    } catch (err) {
      this.deps.logError(`[${ts()}] [ReviewAgent] Failed to enqueue merge-conflict job for PR #${pr.number}: ${err?.message ?? err}`);
      return false;
    }
  }
}

// apps/source_control_manager/src/review_pr_branch.ts
function sanitizeBranchName(raw) {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized;
}
function deriveReviewPrHeadBranch(completionBranch, completionId) {
  const trimmed = completionBranch.trim();
  const fallback = `agent/source_control_manager/${completionId}`;
  if (trimmed.startsWith("refs/pushpals/")) {
    const suffix = sanitizeBranchName(trimmed.slice("refs/pushpals/".length));
    const candidate = suffix.startsWith("agent/") ? suffix : fallback;
    return {
      headBranch: sanitizeBranchName(candidate) || sanitizeBranchName(fallback),
      requiresMaterialize: true
    };
  }
  if (trimmed.startsWith("refs/heads/")) {
    const branch = sanitizeBranchName(trimmed.slice("refs/heads/".length));
    return {
      headBranch: branch || sanitizeBranchName(fallback),
      requiresMaterialize: false
    };
  }
  if (trimmed.startsWith("refs/remotes/")) {
    const parts = trimmed.split("/");
    const branch = sanitizeBranchName(parts.slice(3).join("/"));
    return {
      headBranch: branch || sanitizeBranchName(fallback),
      requiresMaterialize: false
    };
  }
  const plain = sanitizeBranchName(trimmed.replace(/^refs\//, ""));
  return {
    headBranch: plain || sanitizeBranchName(fallback),
    requiresMaterialize: false
  };
}

// apps/source_control_manager/src/review_publication.ts
function metadataValue(body, key) {
  const matches = [...body.matchAll(new RegExp(`<!--\\s*${key}:\\s*([^>]+?)\\s*-->`, "gi"))];
  return matches.at(-1)?.[1]?.trim() ?? "";
}
function normalizeBranch2(value) {
  const branch = value.trim().replace(/^refs\/heads\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!branch || branch.includes("..") || branch.includes("@{") || branch.endsWith(".") || branch.endsWith(".lock") || /[~^:?*\[\]\s]/.test(branch)) {
    return "";
  }
  return branch;
}
function normalizeSha(value) {
  const sha = value.trim().toLowerCase();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : "";
}
function parseReviewPublicationLease(prBody) {
  const body = String(prBody ?? "");
  const targetBranch = normalizeBranch2(metadataValue(body, "pushpals-reviewTargetBranch"));
  const baseBranch = normalizeBranch2(metadataValue(body, "pushpals-reviewBaseBranch"));
  const expectedHeadSha = normalizeSha(metadataValue(body, "pushpals-reviewExpectedHeadSha"));
  const expectedBaseSha = normalizeSha(metadataValue(body, "pushpals-reviewExpectedBaseSha"));
  if (!targetBranch || !expectedHeadSha)
    return null;
  return {
    targetBranch,
    baseBranch: baseBranch || null,
    expectedHeadSha,
    expectedBaseSha: expectedBaseSha || null
  };
}
function buildReviewPublicationPushArgs(args) {
  return [
    "push",
    `--force-with-lease=refs/heads/${args.lease.targetBranch}:${args.lease.expectedHeadSha}`,
    args.remote,
    `${args.commitSha}:refs/heads/${args.lease.targetBranch}`
  ];
}
function buildReviewCompletionValidationCheckoutArgs(tempBranch, commitSha) {
  return ["checkout", "-B", tempBranch, commitSha];
}
function reviewCompletionHandoffMatches(resolvedSha, expectedSha) {
  return normalizeSha(String(resolvedSha ?? "")) === normalizeSha(expectedSha);
}
function shouldCleanupCompletionHandoff(processedConfirmed) {
  return processedConfirmed;
}
function shouldUseReviewPublicationFlow(reviewAgentEnabled, lease) {
  return reviewAgentEnabled || lease !== null;
}
function shouldPublishWithExactReviewLease(lease) {
  return lease !== null;
}

// apps/source_control_manager/src/pr_title.ts
function firstNonEmptyLine(value) {
  const raw = (value ?? "").trim();
  if (!raw)
    return "";
  const line = raw.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}
function normalizePrTitleCandidate(value) {
  const firstLine = firstNonEmptyLine(value);
  if (!firstLine)
    return "";
  const dashIndex = firstLine.indexOf(" - ");
  if (dashIndex < 0)
    return firstLine;
  return firstLine.slice(0, dashIndex).trim();
}
function resolveReviewAgentPrTitle(args) {
  const commitSubject = normalizePrTitleCandidate(args.commitSubject);
  if (commitSubject)
    return commitSubject;
  const completionPrTitle = normalizePrTitleCandidate(args.completionPrTitle ?? "");
  if (completionPrTitle)
    return completionPrTitle;
  return `PushPals: ${args.prHeadBranch.replace(/^agent\//, "")} -> ${args.integrationBaseBranch}`;
}

// apps/source_control_manager/src/review_apply_fallback.ts
function normalize(value) {
  return value.trim().toLowerCase();
}
function isCherryPickConflictOutput(text) {
  const normalized = normalize(text);
  if (!normalized)
    return false;
  return normalized.includes("could not apply") || normalized.includes("after resolving the conflicts") || normalized.includes("cherry-pick --continue") || normalized.includes("merge conflict") || normalized.includes("conflict (content)");
}
function shouldBypassApplyFailureInReviewMode(input) {
  if (!input.reviewAgentEnabled)
    return false;
  if (normalize(input.mergeStrategy) !== "cherry-pick")
    return false;
  const combined = [input.applyStderr ?? "", input.applyStdout ?? ""].filter(Boolean).join(`
`);
  return isCherryPickConflictOutput(combined);
}

// apps/source_control_manager/src/runtime_helpers.ts
function cloneSourceControlManagerConfigSnapshot(config) {
  return {
    ...config,
    checks: config.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...config.reviewAgent
    }
  };
}
function createSingleFlightExecutor(worker) {
  let inFlight = null;
  return () => {
    if (inFlight)
      return inFlight;
    inFlight = (async () => worker())().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
function createStartupStatusTracker(initialPhase = "startup") {
  let phase = initialPhase;
  return {
    getPhase: () => phase,
    canEmitInitializing: (running) => running && phase === "startup",
    beginOnlineTransition: () => {
      if (phase !== "startup")
        return false;
      phase = "online";
      return true;
    },
    revertOnlineTransition: () => {
      if (phase === "online") {
        phase = "startup";
      }
    },
    markShutdown: () => {
      phase = "shutdown";
    }
  };
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizePresenceToken(value) {
  return String(value ?? "").trim().toLowerCase();
}
function isRemoteBuddyClientRow(row) {
  const clientId = normalizePresenceToken(row.clientId);
  const label = normalizePresenceToken(row.label);
  return clientId.includes("remotebuddy") || label.includes("remotebuddy");
}
function getStatusClientRows(statusPayload) {
  if (!isRecord(statusPayload))
    return [];
  const clients = statusPayload.clients;
  if (!isRecord(clients) || !Array.isArray(clients.items))
    return [];
  return clients.items.filter((row) => isRecord(row));
}
function getFiniteNonNegativeNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0)
    return null;
  return numberValue;
}
function getWorkerCapacity(statusPayload) {
  if (!isRecord(statusPayload) || !isRecord(statusPayload.workers)) {
    return { online: null, idle: null };
  }
  return {
    online: getFiniteNonNegativeNumber(statusPayload.workers.online),
    idle: getFiniteNonNegativeNumber(statusPayload.workers.idle)
  };
}
function summarizeReviewAgentRuntimeReadiness(statusPayload, sessionId) {
  if (!isRecord(statusPayload) || statusPayload.ok !== true) {
    return { ready: false, detail: "server /system/status is not healthy" };
  }
  const expectedSessionId = sessionId.trim();
  const rows = getStatusClientRows(statusPayload);
  const sessionRows = rows.filter((row) => String(row.sessionId ?? "").trim() === expectedSessionId);
  const remoteBuddyRows = sessionRows.filter(isRemoteBuddyClientRow);
  const connectedRemoteBuddy = remoteBuddyRows.find((row) => normalizePresenceToken(row.status) === "connected");
  if (!connectedRemoteBuddy) {
    const anyRemoteBuddyRows = rows.filter(isRemoteBuddyClientRow);
    const connectedOtherSession = anyRemoteBuddyRows.find((row) => {
      const rowSessionId = String(row.sessionId ?? "").trim();
      return rowSessionId && rowSessionId !== expectedSessionId && normalizePresenceToken(row.status) === "connected";
    });
    if (connectedOtherSession) {
      const otherSession = String(connectedOtherSession.sessionId ?? "").trim() || "unknown";
      const otherClient = String(connectedOtherSession.clientId ?? "").trim() || "unknown client";
      return {
        ready: false,
        detail: `RemoteBuddy is connected to session ${otherSession} (${otherClient}), not ${expectedSessionId}`
      };
    }
    if (remoteBuddyRows.length > 0) {
      return {
        ready: false,
        detail: `RemoteBuddy session consumer exists for ${expectedSessionId} but is not connected`
      };
    }
    return {
      ready: false,
      detail: `No connected RemoteBuddy session consumer found for session ${expectedSessionId}`
    };
  }
  const workers = getWorkerCapacity(statusPayload);
  if (workers.online === null || workers.online < 1) {
    return {
      ready: false,
      detail: "WorkerPal capacity is not online yet"
    };
  }
  const clientId = String(connectedRemoteBuddy.clientId ?? "").trim() || "unknown client";
  const idleDetail = workers.idle === null ? "unknown idle" : `${workers.idle} idle`;
  return {
    ready: true,
    detail: `RemoteBuddy session consumer connected (${clientId}); WorkerPals online=${workers.online}, ${idleDetail}`
  };
}
async function probeReviewAgentRuntimeReadiness(options) {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 2500);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (options.authToken)
      headers.Authorization = `Bearer ${options.authToken}`;
    const response = await fetchImpl(`${options.serverUrl.replace(/\/+$/, "")}/system/status`, {
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ready: false,
        detail: `system status probe failed with HTTP ${response.status}`
      };
    }
    const payload = await response.json().catch(() => ({}));
    return summarizeReviewAgentRuntimeReadiness(payload, options.sessionId);
  } catch (err) {
    return {
      ready: false,
      detail: `system status probe failed: ${String(err)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

// apps/source_control_manager/src/http.ts
function createStatusServer(db, port) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      if (req.method === "GET" && pathname === "/health") {
        return Response.json({ status: "ok", pid: process.pid }, { headers });
      }
      if (req.method === "GET" && pathname === "/jobs") {
        const statusFilter = url.searchParams.get("status");
        const limitParam = url.searchParams.get("limit");
        const rawLimit = limitParam ? parseInt(limitParam, 10) : 50;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
        const validStatuses = new Set(["queued", "running", "success", "failed", "skipped"]);
        if (statusFilter && !validStatuses.has(statusFilter)) {
          return Response.json({
            error: `Invalid status: ${statusFilter}. Valid values: ${[...validStatuses].join(", ")}`
          }, { status: 400, headers });
        }
        const jobs = statusFilter ? db.getJobsByStatus(statusFilter, limit) : db.getRecentJobs(limit);
        return Response.json({ jobs, count: jobs.length }, { headers });
      }
      const jobMatch = pathname.match(/^\/jobs\/(\d+)$/);
      if (req.method === "GET" && jobMatch) {
        const jobId = parseInt(jobMatch[1], 10);
        const job = db.getJob(jobId);
        if (!job) {
          return Response.json({ error: "Job not found" }, { status: 404, headers });
        }
        const logLimitParam = url.searchParams.get("logLimit");
        const rawLogLimit = logLimitParam ? parseInt(logLimitParam, 10) : 500;
        const logLimit = Number.isFinite(rawLogLimit) && rawLogLimit > 0 ? Math.min(rawLogLimit, 2000) : 500;
        const rawLogs = db.getJobLogs(jobId, logLimit + 1);
        const logsClamped = rawLogs.length > logLimit;
        const logs = logsClamped ? rawLogs.slice(0, logLimit) : rawLogs;
        return Response.json({ job, logs, logsClamped }, { headers });
      }
      if (req.method === "GET" && pathname === "/stats") {
        const counts = db.getStatusCounts();
        return Response.json({
          queued: counts.queued ?? 0,
          running: counts.running ?? 0,
          success: counts.success ?? 0,
          failed: counts.failed ?? 0,
          skipped: counts.skipped ?? 0
        }, { headers });
      }
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }
  });
}

// apps/source_control_manager/src/runtime_paths.ts
import { resolve as resolve6 } from "path";
function resolveSourceControlManagerRuntimeRepoRoot(projectRoot, fallbackCwd = process.cwd()) {
  const configuredRoot = String(projectRoot ?? "").trim();
  if (configuredRoot) {
    return resolve6(configuredRoot);
  }
  return resolve6(fallbackCwd);
}

// apps/source_control_manager/src/trusted_validation.ts
var DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS = 15 * 60000;
async function runArgv(argv, options) {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env }
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timer);
  return {
    ok: exitCode === 0,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join(`
`),
    exitCode
  };
}
async function runTrustedValidationCommands(options) {
  const normalized = normalizeTrustedValidationCommands(options.commandsJson);
  if (!normalized.ok) {
    throw new Error(`Invalid trusted-validation handoff: ${normalized.message}`);
  }
  const runner = options.runner ?? runArgv;
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS);
  const results = [];
  for (const command of normalized.commands) {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv) {
      throw new Error(`Invalid trusted-validation command after normalization: ${command}`);
    }
    const result = await runner(argv, { cwd: options.repoPath, timeoutMs });
    results.push({ command, ...result });
    if (!result.ok)
      break;
  }
  return results;
}

// apps/source_control_manager/src/config.ts
import { resolve as resolve7 } from "path";
function buildDefaults(options = {}) {
  const pushConfig = loadPushPalsConfig({ reload: options.reload });
  const defaultLocalServer = resolveLocalServerConnection({
    serverUrl: pushConfig.server.url,
    authToken: pushConfig.authToken,
    fallbackPort: pushConfig.server.port
  });
  return {
    repoPath: resolve7(pushConfig.sourceControlManager.repoPath),
    serverUrl: defaultLocalServer.serverUrl,
    remote: pushConfig.sourceControlManager.remote,
    mainBranch: pushConfig.sourceControlManager.mainBranch,
    integrationBaseBranch: pushConfig.sourceControlManager.baseBranch,
    branchPrefix: pushConfig.sourceControlManager.branchPrefix,
    pollIntervalSeconds: pushConfig.sourceControlManager.pollIntervalSeconds,
    checks: pushConfig.sourceControlManager.checks.map((check) => ({ ...check })),
    stateDir: resolve7(pushConfig.sourceControlManager.stateDir),
    port: pushConfig.sourceControlManager.port,
    deleteAfterMerge: pushConfig.sourceControlManager.deleteAfterMerge,
    maxAttempts: pushConfig.sourceControlManager.maxAttempts,
    mergeStrategy: pushConfig.sourceControlManager.mergeStrategy,
    pushMainAfterMerge: pushConfig.sourceControlManager.pushMainAfterMerge,
    openPrAfterPush: pushConfig.sourceControlManager.openPrAfterPush,
    prBaseBranch: pushConfig.sourceControlManager.prBaseBranch,
    prTitle: pushConfig.sourceControlManager.prTitle,
    prBody: pushConfig.sourceControlManager.prBody,
    prDraft: pushConfig.sourceControlManager.prDraft,
    authToken: undefined,
    gitToken: pushConfig.gitToken,
    statusHeartbeatMs: pushConfig.sourceControlManager.statusHeartbeatMs,
    skipCleanCheck: pushConfig.sourceControlManager.skipCleanCheck,
    autoCreateMainBranch: pushConfig.sourceControlManager.autoCreateMainBranch,
    reviewAgent: { ...pushConfig.sourceControlManager.reviewAgent }
  };
}
function loadConfig(options = {}) {
  const defaults = buildDefaults(options);
  return {
    ...defaults,
    checks: defaults.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...defaults.reviewAgent
    }
  };
}
function applyCliOverrides(config, overrides) {
  const merged = { ...config };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  const pushConfig = loadPushPalsConfig();
  const resolved = resolveLocalServerConnection({
    serverUrl: merged.serverUrl,
    authToken: merged.authToken ?? null,
    fallbackPort: pushConfig.server.port
  });
  merged.serverUrl = resolved.serverUrl;
  merged.authToken = undefined;
  return merged;
}
function validateConfig(config) {
  if (typeof config.port !== "number" || !Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid config: port must be 1-65535, got ${JSON.stringify(config.port)}`);
  }
  if (typeof config.pollIntervalSeconds !== "number" || !Number.isFinite(config.pollIntervalSeconds) || config.pollIntervalSeconds < 1) {
    throw new Error(`Invalid config: pollIntervalSeconds must be >= 1, got ${JSON.stringify(config.pollIntervalSeconds)}`);
  }
  if (typeof config.maxAttempts !== "number" || !Number.isFinite(config.maxAttempts) || config.maxAttempts < 1) {
    throw new Error(`Invalid config: maxAttempts must be >= 1, got ${JSON.stringify(config.maxAttempts)}`);
  }
  if (config.mergeStrategy !== "cherry-pick" && config.mergeStrategy !== "no-ff" && config.mergeStrategy !== "ff-only") {
    throw new Error(`Invalid config: mergeStrategy must be "cherry-pick", "no-ff", or "ff-only", got ${JSON.stringify(config.mergeStrategy)}`);
  }
  if (typeof config.repoPath !== "string" || config.repoPath.length === 0) {
    throw new Error(`Invalid config: repoPath must be a non-empty string`);
  }
  if (typeof config.mainBranch !== "string" || config.mainBranch.length === 0) {
    throw new Error(`Invalid config: mainBranch must be a non-empty string`);
  }
  if (typeof config.integrationBaseBranch !== "string" || config.integrationBaseBranch.length === 0) {
    throw new Error(`Invalid config: integrationBaseBranch must be a non-empty string`);
  }
  if (typeof config.prBaseBranch !== "string" || config.prBaseBranch.length === 0) {
    throw new Error(`Invalid config: prBaseBranch must be a non-empty string`);
  }
  if (typeof config.reviewAgent.pollIntervalMs !== "number" || !Number.isFinite(config.reviewAgent.pollIntervalMs) || config.reviewAgent.pollIntervalMs < 5000) {
    throw new Error(`Invalid config: reviewAgent.pollIntervalMs must be >= 5000, got ${JSON.stringify(config.reviewAgent.pollIntervalMs)}`);
  }
  if (typeof config.reviewAgent.passThreshold !== "number" || !Number.isFinite(config.reviewAgent.passThreshold) || config.reviewAgent.passThreshold < 1 || config.reviewAgent.passThreshold > 10) {
    throw new Error(`Invalid config: reviewAgent.passThreshold must be between 1 and 10, got ${JSON.stringify(config.reviewAgent.passThreshold)}`);
  }
  if (typeof config.reviewAgent.maxPrCommentsBeforeGiveUp !== "number" || !Number.isFinite(config.reviewAgent.maxPrCommentsBeforeGiveUp) || config.reviewAgent.maxPrCommentsBeforeGiveUp < 1 || config.reviewAgent.maxPrCommentsBeforeGiveUp > 100) {
    throw new Error(`Invalid config: reviewAgent.maxPrCommentsBeforeGiveUp must be between 1 and 100, got ${JSON.stringify(config.reviewAgent.maxPrCommentsBeforeGiveUp)}`);
  }
  if (config.reviewAgent.mergeMethod !== "squash" && config.reviewAgent.mergeMethod !== "merge" && config.reviewAgent.mergeMethod !== "rebase") {
    throw new Error(`Invalid config: reviewAgent.mergeMethod must be "squash", "merge", or "rebase", got ${JSON.stringify(config.reviewAgent.mergeMethod)}`);
  }
  if (typeof config.reviewAgent.codexTimeoutMs !== "number" || !Number.isFinite(config.reviewAgent.codexTimeoutMs) || config.reviewAgent.codexTimeoutMs < 30000) {
    throw new Error(`Invalid config: reviewAgent.codexTimeoutMs must be >= 30000, got ${JSON.stringify(config.reviewAgent.codexTimeoutMs)}`);
  }
}

// apps/source_control_manager/src/source_control_manager_main.ts
var PUSH_CONFIG = loadPushPalsConfig();
var repoRoot = resolveSourceControlManagerRuntimeRepoRoot(PUSH_CONFIG.projectRoot, process.cwd());
var defaultSourceControlManagerRepoPath = resolve8(PUSH_CONFIG.sourceControlManager.repoPath);
var { values: args } = parseArgs({
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
    help: { type: "boolean", short: "h" }
  },
  strict: false
});
if (args.help) {
  console.log(`
source_control_manager \u2014 SourceControlManager merge queue daemon

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
if (typeof args.config === "string" && args.config.trim()) {
  console.warn(`[${new Date().toISOString()}] Ignoring --config override; SourceControlManager now uses shared PushPals config only.`);
}
var config = loadConfig();
var cliOverrides = {};
if (typeof args.repo === "string")
  cliOverrides.repoPath = resolve8(args.repo);
if (typeof args.server === "string")
  cliOverrides.serverUrl = args.server;
if (typeof args.port === "string") {
  const n = parseInt(args.port, 10);
  if (Number.isFinite(n) && n > 0)
    cliOverrides.port = n;
  else {
    console.error(`Invalid --port value: ${args.port}`);
    process.exit(1);
  }
}
if (typeof args.remote === "string")
  cliOverrides.remote = args.remote;
if (typeof args.branch === "string")
  cliOverrides.mainBranch = args.branch;
if (typeof args.prefix === "string")
  cliOverrides.branchPrefix = args.prefix;
if (typeof args.interval === "string") {
  const n = parseInt(args.interval, 10);
  if (Number.isFinite(n) && n > 0)
    cliOverrides.pollIntervalSeconds = n;
  else {
    console.error(`Invalid --interval value: ${args.interval}`);
    process.exit(1);
  }
}
if (typeof args["state-dir"] === "string")
  cliOverrides.stateDir = resolve8(args["state-dir"]);
if (args["delete-after-merge"])
  cliOverrides.deleteAfterMerge = true;
config = applyCliOverrides(config, cliOverrides);
config.repoPath = resolve8(config.repoPath);
var integrationBaseBranch = config.integrationBaseBranch;
var integrationBaseRef = `${config.remote}/${integrationBaseBranch}`;
var usingDefaultRepoPath = resolve8(config.repoPath) === resolve8(defaultSourceControlManagerRepoPath);
try {
  validateConfig(config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
var dryRun = args["dry-run"] === true;
var skipCleanCheckFlag = args["skip-clean-check"] === true;
var skipCleanCheck = skipCleanCheckFlag || config.skipCleanCheck;
var statusSessionId = PUSH_CONFIG.sessionId.trim() || "dev";
var statusHeartbeatMs = Math.max(0, config.statusHeartbeatMs);
var ts2 = () => new Date().toISOString();
console.log(`[${ts2()}] source_control_manager starting`);
console.log(`[${ts2()}]   config:   shared (packages/shared/src/config.ts)`);
console.log(`[${ts2()}]   repo:     ${config.repoPath}`);
console.log(`[${ts2()}]   remote:   ${config.remote}`);
console.log(`[${ts2()}]   main:     ${config.mainBranch}`);
console.log(`[${ts2()}]   prefix:   ${config.branchPrefix}`);
console.log(`[${ts2()}]   interval: ${config.pollIntervalSeconds}s`);
console.log(`[${ts2()}]   state:    ${config.stateDir}`);
console.log(`[${ts2()}]   port:     ${config.port}`);
console.log(`[${ts2()}]   checks:   ${config.checks.length}`);
if (dryRun)
  console.log(`[${ts2()}]   mode:     DRY RUN`);
if (skipCleanCheck) {
  const source = skipCleanCheckFlag ? "--skip-clean-check flag" : "source_control_manager.skip_clean_check";
  console.log(`[${ts2()}]   mode:     SKIP CLEAN CHECK (${source})`);
}
mkdirSync2(config.stateDir, { recursive: true });
var lock = new FileLock(config.stateDir);
if (!lock.acquire()) {
  console.error(`[${ts2()}] Another source_control_manager instance is already running. Exiting.`);
  process.exit(1);
}
console.log(`[${ts2()}] Lock acquired`);
var dbPath = join5(config.stateDir, "merge_queue.db");
var db = new MergeQueueDB(dbPath);
console.log(`[${ts2()}] Database opened: ${dbPath}`);
var recovered = db.recoverStuckJobs();
if (recovered > 0) {
  console.log(`[${ts2()}] Recovered ${recovered} stuck running job(s) -> queued`);
}
var gitOps = createSourceControlApi(config);
var server;
try {
  server = createStatusServer(db, config.port);
  console.log(`[${ts2()}] Status server listening on http://127.0.0.1:${config.port}`);
} catch (err) {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  if (code === "EADDRINUSE") {
    console.error(`[${ts2()}] Port ${config.port} already in use \u2014 status server disabled.`);
    console.error(`  TIP: kill the old process or use --port <N> / config "port" to pick another.`);
  } else {
    throw err;
  }
}
var running = true;
var statusHeartbeatTimer = null;
var reviewAgentPollTimer = null;
var reviewAgentConfigPollTimer = null;
var reviewAgentInstance = null;
var statusSessionReady = false;
var shutdownPromise = null;
var startupStatusTracker = createStartupStatusTracker();
var reviewAgentRuntimeStateKey = "startup";
var reviewAgentRuntimeFingerprint = "";
var integrationMaintenanceIntervalMs = Math.max(1e4, Math.min(60000, config.pollIntervalSeconds * 3000));
var integrationMaintenanceRunner = new IntegrationMaintenanceRunner({
  gitOps,
  sessionId: statusSessionId,
  intervalMs: integrationMaintenanceIntervalMs
});
var reviewAgentConfigPollMs = 3000;
var syncReviewAgentRuntimeConfigSingleFlight = createSingleFlightExecutor(async () => {
  const latestConfig = applyCliOverrides(loadConfig({ reload: true }), cliOverrides);
  validateConfig(latestConfig);
  config.reviewAgent = { ...latestConfig.reviewAgent };
  config.prBaseBranch = latestConfig.prBaseBranch;
  config.gitToken = latestConfig.gitToken;
  if (!config.reviewAgent.enabled) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState("disabled", `[${ts2()}] ReviewAgent disabled via runtime config (source_control_manager.review_agent.enabled=false).`);
    return;
  }
  const runtimeReadiness = await probeReviewAgentRuntimeReadiness({
    serverUrl: config.serverUrl,
    sessionId: statusSessionId,
    authToken: config.authToken,
    timeoutMs: 2500
  });
  if (!runtimeReadiness.ready) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(`blocked:runtime_not_ready:${runtimeReadiness.detail}`, `[${ts2()}] ReviewAgent waiting for embedded runtime readiness before polling PRs (${runtimeReadiness.detail}).`, "warn");
    return;
  }
  const remoteUrlResult = await runGitCapture(["-C", config.repoPath, "remote", "get-url", config.remote], repoRoot);
  const remoteUrl = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "";
  if (!remoteUrl) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState("blocked:missing_remote", `[${ts2()}] ReviewAgent enabled but could not resolve remote URL; waiting for runtime config or git remote changes before starting.`, "warn");
    return;
  }
  const gitProviderToken = await resolveGitAuthToken(remoteUrl, config.gitToken ?? "");
  if (!gitProviderToken) {
    clearReviewAgentPollLoop();
    logReviewAgentRuntimeState("blocked:missing_token", `[${ts2()}] ReviewAgent enabled but no git provider token found (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN); waiting for credentials before starting.`, "warn");
    return;
  }
  const prBaseBranch = (config.prBaseBranch || integrationBaseBranch).trim();
  const fingerprint = JSON.stringify({
    serverUrl: config.serverUrl,
    remoteUrl,
    prBaseBranch,
    reviewAgent: config.reviewAgent,
    gitProviderToken
  });
  if (reviewAgentInstance && reviewAgentPollTimer && reviewAgentRuntimeFingerprint === fingerprint) {
    return;
  }
  clearReviewAgentPollLoop();
  const reviewAgent = new ReviewAgent(config.reviewAgent, config.serverUrl, gitProviderToken, remoteUrl, prBaseBranch, config.authToken);
  reviewAgentInstance = reviewAgent;
  reviewAgentRuntimeFingerprint = fingerprint;
  reviewAgentPollTimer = setInterval(() => reviewAgent.poll().catch((err) => {
    console.error(`[${ts2()}] [ReviewAgent] Poll error: ${err?.message ?? err}`);
  }), config.reviewAgent.pollIntervalMs);
  logReviewAgentRuntimeState(`running:${fingerprint}`, `[${ts2()}] ReviewAgent started (poll interval: ${config.reviewAgent.pollIntervalMs}ms, pass threshold: ${config.reviewAgent.passThreshold}/10)`);
  reviewAgent.poll().catch((err) => {
    console.error(`[${ts2()}] [ReviewAgent] Initial poll error: ${err?.message ?? err}`);
  });
});
function summarizeBranchNames(names, max = 5) {
  if (names.length <= max)
    return names.join(", ");
  return `${names.slice(0, max).join(", ")}, +${names.length - max} more`;
}
function createSessionComm(sessionId) {
  return new CommunicationManager({
    serverUrl: config.serverUrl,
    sessionId,
    authToken: config.authToken,
    from: "agent:source_control_manager"
  });
}
async function ensureSessionWithRetry(sessionId, maxRetries = 10, baseDelayMs = 1000, maxDelayMs = 1e4) {
  let attempt = 0;
  while (running) {
    attempt += 1;
    try {
      const response = await fetch(`${config.serverUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      if (response.ok)
        return true;
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (attempt >= maxRetries) {
        console.warn(`[${ts2()}] Could not ensure session "${sessionId}" for source_control_manager status events: ${err?.message ?? err}`);
        return false;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await Bun.sleep(delayMs);
    }
  }
  return false;
}
async function emitStartupStatus() {
  if (!startupStatusTracker.canEmitInitializing(running))
    return;
  const sessionReady = await ensureSessionWithRetry(statusSessionId);
  if (!sessionReady)
    return;
  if (!startupStatusTracker.beginOnlineTransition())
    return;
  statusSessionReady = true;
  const comm = createSessionComm(statusSessionId);
  const ok = await comm.status("source_control_manager", "idle", "SourceControlManager online and monitoring completions");
  if (!ok) {
    statusSessionReady = false;
    startupStatusTracker.revertOnlineTransition();
    console.warn(`[${ts2()}] Failed to emit source_control_manager startup status event`);
  }
}
async function emitInitializingStatus() {
  while (startupStatusTracker.canEmitInitializing(running) && !statusSessionReady) {
    const sessionReady = await ensureSessionWithRetry(statusSessionId, 6, 400, 2500);
    if (!sessionReady) {
      await Bun.sleep(1000);
      continue;
    }
    if (!startupStatusTracker.canEmitInitializing(running))
      return;
    statusSessionReady = true;
    const comm = createSessionComm(statusSessionId);
    const ok = await comm.status("source_control_manager", "idle", "SourceControlManager initializing startup checks");
    if (ok)
      return;
    statusSessionReady = false;
    console.warn(`[${ts2()}] Failed to emit source_control_manager initializing status event`);
    await Bun.sleep(1000);
  }
}
function startStatusHeartbeat() {
  if (statusHeartbeatMs <= 0 || statusHeartbeatTimer)
    return;
  const comm = createSessionComm(statusSessionId);
  statusHeartbeatTimer = setInterval(() => {
    if (!running)
      return;
    (async () => {
      if (!statusSessionReady) {
        statusSessionReady = await ensureSessionWithRetry(statusSessionId, 3, 400, 2500);
      }
      const ok = await comm.status("source_control_manager", "idle", "SourceControlManager heartbeat");
      if (!ok) {
        statusSessionReady = false;
      }
    })();
  }, statusHeartbeatMs);
}
function clearReviewAgentPollLoop() {
  if (reviewAgentPollTimer) {
    clearInterval(reviewAgentPollTimer);
    reviewAgentPollTimer = null;
  }
  reviewAgentInstance = null;
  reviewAgentRuntimeFingerprint = "";
}
function logReviewAgentRuntimeState(key, message, level = "log") {
  if (reviewAgentRuntimeStateKey === key)
    return;
  reviewAgentRuntimeStateKey = key;
  if (level === "warn") {
    console.warn(message);
    return;
  }
  console.log(message);
}
async function syncReviewAgentRuntimeConfig() {
  await syncReviewAgentRuntimeConfigSingleFlight();
}
function startReviewAgentRuntimeConfigPolling() {
  if (reviewAgentConfigPollTimer)
    return;
  reviewAgentConfigPollTimer = setInterval(() => {
    if (!running)
      return;
    syncReviewAgentRuntimeConfig().catch((err) => {
      const detail = err?.message ?? String(err);
      logReviewAgentRuntimeState(`config-error:${detail}`, `[${ts2()}] ReviewAgent runtime config poll failed: ${detail}`, "warn");
    });
  }, reviewAgentConfigPollMs);
}
async function emitPusherMessage(comm, text, correlationId, meta = {}) {
  const ok = await comm.assistantMessage(text, { ...meta, correlationId });
  if (!ok) {
    console.error(`[${ts2()}] Failed to emit source_control_manager message: ${text}`);
  }
}
async function tick() {
  try {
    const runtimeConfig = cloneSourceControlManagerConfigSnapshot(config);
    const reviewAgentForTick = reviewAgentInstance;
    const headers = { "Content-Type": "application/json" };
    if (runtimeConfig.authToken) {
      headers["Authorization"] = `Bearer ${runtimeConfig.authToken}`;
    }
    const pusherId = `source_control_manager-${Math.random().toString(36).substring(2, 10)}`;
    const response = await maintainIntegrationBeforeCompletionClaim({
      maintain: () => integrationMaintenanceRunner.run(runtimeConfig, headers),
      claimCompletion: () => fetch(`${runtimeConfig.serverUrl}/completions/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pusherId })
      })
    });
    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[${ts2()}] Failed to claim completion: ${response.status}`);
      }
      return;
    }
    const data = await response.json();
    if (!data.ok || !data.completion) {
      return;
    }
    const completion = data.completion;
    const reviewPublicationLease = completion.branch.startsWith("refs/pushpals/review/") ? parseReviewPublicationLease(completion.prBody) : null;
    const isIntegrationReconciliationCompletion = Boolean(reviewPublicationLease && reviewPublicationLease.targetBranch === runtimeConfig.mainBranch && reviewPublicationLease.baseBranch === runtimeConfig.integrationBaseBranch);
    const useReviewPublicationFlow = shouldUseReviewPublicationFlow(runtimeConfig.reviewAgent.enabled, reviewPublicationLease);
    const comm = createSessionComm(completion.sessionId);
    const completionEventMeta = completion.origin === "autonomy" ? { from: "agent:source_control_manager/autonomy" } : undefined;
    const cleanupHiddenCompletionRef = completion.branch.startsWith("refs/pushpals/");
    console.log(`[${ts2()}] Claimed completion ${completion.id}: ${completion.branch} (${completion.commitSha.slice(0, 8)})`);
    if ((completion.prTitle ?? "").trim() || (completion.prBody ?? "").trim()) {
      console.log(`[${ts2()}] Completion ${completion.id} includes worker-provided PR metadata; SourceControlManager will prefer it for PR creation.`);
    }
    await emitPusherMessage(comm, `SourceControlManager claimed WorkerPal completion ${completion.id.slice(0, 8)} from ${completion.branch}.`, completion.id, completionEventMeta);
    if (dryRun) {
      console.log(`[${ts2()}] Dry run mode \u2014 skipping processing`);
      await emitPusherMessage(comm, `SourceControlManager is in dry-run mode, so completion ${completion.id.slice(0, 8)} was not applied.`, completion.id, completionEventMeta);
      return;
    }
    let tempBranch = "";
    let cleanupCompletionHandoff = false;
    try {
      let processedPrUrl = typeof completion.prUrl === "string" && completion.prUrl.trim().length > 0 ? completion.prUrl.trim() : null;
      console.log(`[${ts2()}] Refreshing refs before applying ${completion.branch}...`);
      await gitOps.fetchPrune();
      if (reviewPublicationLease) {
        let resolvedCompletionSha = await runGitCapture(["-C", runtimeConfig.repoPath, "rev-parse", "--verify", completion.branch], repoRoot);
        if (!resolvedCompletionSha.ok || !reviewCompletionHandoffMatches(resolvedCompletionSha.stdout, completion.commitSha)) {
          const fetchCompletionRef = await runGitCapture([
            "-C",
            runtimeConfig.repoPath,
            "fetch",
            runtimeConfig.remote,
            `+${completion.branch}:${completion.branch}`
          ], repoRoot);
          if (!fetchCompletionRef.ok) {
            throw new Error(`Review completion ${completion.branch} was not available in the shared host repository and remote compatibility fetch failed: ${fetchCompletionRef.stderr || fetchCompletionRef.stdout}`);
          }
          resolvedCompletionSha = await runGitCapture(["-C", runtimeConfig.repoPath, "rev-parse", "--verify", completion.branch], repoRoot);
        } else {
          console.log(`[${ts2()}] Using immutable review completion ${completion.branch} from the shared host repository; no worker-side remote handoff was required.`);
        }
        if (!resolvedCompletionSha.ok || !reviewCompletionHandoffMatches(resolvedCompletionSha.stdout, completion.commitSha)) {
          throw new Error(`Review completion ref ${completion.branch} did not resolve to expected commit ${completion.commitSha}.`);
        }
      }
      tempBranch = `_source_control_manager/${completion.id}`;
      console.log(`[${ts2()}] Creating temp branch ${tempBranch}...`);
      await gitOps.resetToClean();
      await gitOps.checkoutMain();
      await gitOps.pullMainFF();
      if (!isIntegrationReconciliationCompletion) {
        const baseSync = await gitOps.syncMainWithBaseBranch();
        if (baseSync.status === "conflicted") {
          throw new Error(`Integration reconciliation is active for ${runtimeConfig.mainBranch} and ${runtimeConfig.integrationBaseBranch}; conflicted paths: ${baseSync.conflictPaths.join(", ")}.`);
        }
      }
      await gitOps.createTempBranch(tempBranch);
      let skipLocalApplyDueConflict = false;
      const applyResult = reviewPublicationLease ? await (async () => {
        console.log(`[${ts2()}] Checking out exact reviewed completion ${completion.commitSha.slice(0, 8)} on ${tempBranch} for validation...`);
        return runGitCapture([
          "-C",
          runtimeConfig.repoPath,
          ...buildReviewCompletionValidationCheckoutArgs(tempBranch, completion.commitSha)
        ], repoRoot);
      })() : runtimeConfig.mergeStrategy === "cherry-pick" ? await (async () => {
        console.log(`[${ts2()}] Cherry-picking ${completion.commitSha.slice(0, 8)} onto ${tempBranch}...`);
        return gitOps.cherryPickRef(completion.commitSha);
      })() : await (async () => {
        console.log(`[${ts2()}] Merging ${completion.branch} into ${tempBranch}...`);
        return runtimeConfig.mergeStrategy === "no-ff" ? gitOps.mergeNoFF(completion.branch, `Merge ${completion.branch}`) : gitOps.mergeFFOnly(completion.branch);
      })();
      if (!applyResult.ok) {
        if (shouldBypassApplyFailureInReviewMode({
          reviewAgentEnabled: useReviewPublicationFlow,
          mergeStrategy: runtimeConfig.mergeStrategy,
          applyStdout: applyResult.stdout,
          applyStderr: applyResult.stderr
        })) {
          skipLocalApplyDueConflict = true;
          const applyDetail = applyResult.stderr || applyResult.stdout;
          console.warn(`[${ts2()}] ReviewAgent mode - cherry-pick conflict while applying ${completion.commitSha.slice(0, 8)}; continuing with PR flow from worker branch commit.`);
          await emitPusherMessage(comm, `ReviewAgent mode: local apply conflicted (${completion.commitSha.slice(0, 8)}), so SourceControlManager continued with branch-based PR flow. Detail: ${applyDetail}`, completion.id, completionEventMeta);
          await gitOps.resetToClean();
        } else {
          throw new Error(`Apply failed: ${applyResult.stderr || applyResult.stdout}`);
        }
      }
      if (skipLocalApplyDueConflict) {
        if (completion.trustedValidationCommandsJson) {
          throw new Error("Trusted validation cannot run because the candidate was not applied to the SourceControlManager validation branch.");
        }
        console.warn(`[${ts2()}] Skipping local checks for ${completion.commitSha.slice(0, 8)} because ReviewAgent fallback bypassed temp-branch apply.`);
      } else {
        if (completion.trustedValidationCommandsJson) {
          console.log(`[${ts2()}] Running trusted-environment validation for ${completion.commitSha.slice(0, 8)}...`);
          const trustedResults = await runTrustedValidationCommands({
            repoPath: runtimeConfig.repoPath,
            commandsJson: completion.trustedValidationCommandsJson
          });
          for (const trustedResult of trustedResults) {
            if (!trustedResult.ok) {
              throw new Error(`Trusted validation "${trustedResult.command}" failed (exit ${trustedResult.exitCode}): ${trustedResult.output}`);
            }
            console.log(`[${ts2()}]   - Trusted validation passed: ${trustedResult.command}`);
          }
        }
        console.log(`[${ts2()}] Running checks...`);
        for (const check of runtimeConfig.checks) {
          console.log(`[${ts2()}]   - Running check: ${check.name}`);
          const checkResult = await runCheck(runtimeConfig.repoPath, check);
          if (!checkResult.ok) {
            throw new Error(`Check "${check.name}" failed: ${checkResult.output}`);
          }
          console.log(`[${ts2()}]   - Check passed: ${check.name}`);
        }
      }
      if (useReviewPublicationFlow) {
        console.log(`[${ts2()}] ReviewAgent mode - creating individual PR for ${completion.branch}`);
        const remoteUrlResult = await runGitCapture(["-C", runtimeConfig.repoPath, "remote", "get-url", runtimeConfig.remote], repoRoot);
        if (!remoteUrlResult.ok || !remoteUrlResult.stdout) {
          throw new Error(`Unable to resolve git remote URL for ${runtimeConfig.remote}: ${remoteUrlResult.stderr || remoteUrlResult.stdout}`);
        }
        const token = await resolveGitAuthToken(remoteUrlResult.stdout.trim(), runtimeConfig.gitToken ?? "");
        if (!token) {
          throw new Error("No git provider token available for individual PR creation (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN).");
        }
        const completionPrTitle = (completion.prTitle ?? "").trim();
        const resolvedHead = reviewPublicationLease ? { headBranch: reviewPublicationLease.targetBranch, requiresMaterialize: false } : deriveReviewPrHeadBranch(completion.branch, completion.id);
        let prHeadBranch = resolvedHead.headBranch;
        if (shouldPublishWithExactReviewLease(reviewPublicationLease)) {
          const prBaseBranch2 = reviewPublicationLease.baseBranch ?? (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();
          if (reviewPublicationLease.expectedBaseSha) {
            const remoteBase = await runGitCapture([
              "-C",
              runtimeConfig.repoPath,
              "rev-parse",
              `refs/remotes/${runtimeConfig.remote}/${prBaseBranch2}`
            ], repoRoot);
            const actualBaseSha = remoteBase.ok ? remoteBase.stdout.trim().toLowerCase() : "";
            if (actualBaseSha !== reviewPublicationLease.expectedBaseSha) {
              throw new Error(`Review base ${prBaseBranch2} moved from expected ${reviewPublicationLease.expectedBaseSha.slice(0, 8)} to ${actualBaseSha.slice(0, 8) || "unknown"}; refusing stale review publication.`);
            }
          }
          console.log(`[${ts2()}] Publishing reviewed completion ${completion.commitSha.slice(0, 8)} to ${prHeadBranch} with an exact force-with-lease.`);
          const pushResult = await runGitCapture([
            "-C",
            runtimeConfig.repoPath,
            ...buildReviewPublicationPushArgs({
              remote: runtimeConfig.remote,
              commitSha: completion.commitSha,
              lease: reviewPublicationLease
            })
          ], repoRoot);
          if (!pushResult.ok) {
            throw new Error(`Failed exact-lease publication for review branch ${prHeadBranch}: ${pushResult.stderr || pushResult.stdout}`);
          }
        } else if (resolvedHead.requiresMaterialize) {
          const publishRef = skipLocalApplyDueConflict ? completion.commitSha : "HEAD";
          console.log(`[${ts2()}] ReviewAgent mode - materializing hidden completion ref ${completion.branch} -> refs/heads/${prHeadBranch}`);
          let pushResult = await runGitCapture([
            "-C",
            runtimeConfig.repoPath,
            "push",
            runtimeConfig.remote,
            `${publishRef}:refs/heads/${prHeadBranch}`
          ], repoRoot);
          if (!pushResult.ok) {
            const detail = `${pushResult.stderr}
${pushResult.stdout}`.toLowerCase();
            const likelyNonFf = detail.includes("non-fast-forward") || detail.includes("fetch first") || detail.includes("rejected");
            if (likelyNonFf) {
              console.warn(`[${ts2()}] Non-fast-forward while publishing ${prHeadBranch}; retrying with --force-with-lease`);
              pushResult = await runGitCapture([
                "-C",
                runtimeConfig.repoPath,
                "push",
                "--force-with-lease",
                runtimeConfig.remote,
                `${publishRef}:refs/heads/${prHeadBranch}`
              ], repoRoot);
            }
          }
          if (!pushResult.ok) {
            throw new Error(`Failed to publish review branch ${prHeadBranch}: ${pushResult.stderr || pushResult.stdout}`);
          }
        }
        const commitSubject = await resolveCommitSubject(completion.commitSha);
        if (!commitSubject) {
          console.warn(`[${ts2()}] ReviewAgent mode - could not resolve commit subject for ${completion.commitSha.slice(0, 8)}; falling back to completion/default PR title`);
        }
        const prTitle = resolveReviewAgentPrTitle({
          commitSubject,
          completionPrTitle,
          prHeadBranch,
          integrationBaseBranch
        });
        const completionPrBody = (completion.prBody ?? "").trim();
        const prBody = [
          completionPrBody || "Automated PR opened by SourceControlManager.",
          "",
          `- Agent branch: \`${prHeadBranch}\``,
          ...prHeadBranch !== completion.branch ? [`- Completion ref: \`${completion.branch}\``] : [],
          `- Commit: \`${completion.commitSha}\``,
          `- Completion ID: \`${completion.id}\``,
          "",
          "<!-- DO NOT EDIT: ReviewAgent metadata below -->",
          `<!-- pushpals-jobId: ${completion.jobId} -->`,
          `<!-- pushpals-sessionId: ${completion.sessionId} -->`
        ].join(`
`);
        const remoteUrl = remoteUrlResult.stdout.trim();
        const prBaseBranch = (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();
        const pr = await ensureIntegrationPullRequest({
          token,
          remoteUrl,
          headBranch: prHeadBranch,
          baseBranch: prBaseBranch,
          title: prTitle,
          body: prBody,
          draft: false
        });
        if (!pr.created) {
          reviewAgentForTick?.requestReReview(pr.number, completion.commitSha);
        }
        const prMessage = pr.created ? `Opened individual PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}` : `Reused existing PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}`;
        processedPrUrl = pr.htmlUrl;
        console.log(`[${ts2()}] ${prMessage}`);
        await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
      } else {
        console.log(`[${ts2()}] Merging ${tempBranch} to ${runtimeConfig.mainBranch}...`);
        await gitOps.checkoutMain();
        const ffResult = await gitOps.mergeFFOnlyRef(tempBranch);
        if (!ffResult.ok) {
          throw new Error(`FF merge to main failed: ${ffResult.stderr || ffResult.stdout}`);
        }
        console.log(`[${ts2()}] \u2713 Successfully merged ${completion.branch} to ${config.mainBranch}`);
        if (config.pushMainAfterMerge) {
          console.log(`[${ts2()}] Pushing ${config.mainBranch} to ${config.remote}...`);
          const pushResult = await gitOps.pushMain();
          if (!pushResult.ok) {
            throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
          }
          console.log(`[${ts2()}] Push succeeded for ${config.mainBranch}`);
          if (config.openPrAfterPush) {
            try {
              const pr = await ensureMainPullRequest(completion, runtimeConfig);
              const prMessage = pr.created ? `Opened PR #${pr.number}: ${pr.htmlUrl}` : `Reused existing PR #${pr.number}: ${pr.htmlUrl}`;
              processedPrUrl = pr.htmlUrl;
              console.log(`[${ts2()}] ${prMessage}`);
              await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
            } catch (prErr) {
              const warning = `Push succeeded, but PR auto-open failed: ${prErr?.message ?? prErr}`;
              console.error(`[${ts2()}] ${warning}`);
              await emitPusherMessage(comm, warning, completion.id, completionEventMeta);
            }
          }
        } else {
          console.log(`[${ts2()}] pushMainAfterMerge=false - skipping push`);
        }
      }
      await gitOps.deleteTempBranch(tempBranch);
      const markResponse = await fetch(`${config.serverUrl}/completions/${completion.id}/processed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prUrl: processedPrUrl })
      });
      if (!markResponse.ok) {
        console.error(`[${ts2()}] Failed to mark completion processed: ${markResponse.status}`);
      } else {
        console.log(`[${ts2()}] Marked completion ${completion.id} as processed`);
        cleanupCompletionHandoff = true;
        const pushMessage = useReviewPublicationFlow ? skipLocalApplyDueConflict ? `Local apply/checks were bypassed for ${completion.commitSha.slice(0, 8)} due cherry-pick conflict; individual PR flow continued for ReviewAgent.` : `Checks passed for ${completion.commitSha.slice(0, 8)} from ${completion.branch}. Individual PR is ready for ReviewAgent review.` : config.pushMainAfterMerge ? `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} and pushed to ${config.remote}/${config.mainBranch}.` : `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} (push disabled).`;
        await emitPusherMessage(comm, pushMessage, completion.id, completionEventMeta);
      }
    } catch (err) {
      console.error(`[${ts2()}] Failed to process completion ${completion.id}: ${err.message}`);
      const failResponse = await fetch(`${config.serverUrl}/completions/${completion.id}/fail`, {
        method: "POST",
        headers,
        body: JSON.stringify({ error: err.message })
      });
      if (!failResponse.ok) {
        console.error(`[${ts2()}] Failed to mark completion failed: ${failResponse.status}`);
      }
      await emitPusherMessage(comm, `Failed to apply completion ${completion.id.slice(0, 8)} from ${completion.branch}: ${err.message}`, completion.id, completionEventMeta);
    } finally {
      try {
        await gitOps.resetToClean();
      } catch (err) {
        console.warn(`[${ts2()}] Failed to reset SourceControlManager worktree after completion ${completion.id}: ${err?.message ?? err}`);
      }
      try {
        if (tempBranch && await gitOps.revParse(tempBranch)) {
          await gitOps.deleteTempBranch(tempBranch);
        }
      } catch (err) {
        console.warn(`[${ts2()}] Failed to delete temp branch ${tempBranch} during final cleanup: ${err?.message ?? err}`);
      }
      if (cleanupHiddenCompletionRef && shouldCleanupCompletionHandoff(cleanupCompletionHandoff)) {
        if (reviewPublicationLease) {
          try {
            const deleteRemoteCompletionRef = await runGitCapture(["-C", runtimeConfig.repoPath, "push", runtimeConfig.remote, `:${completion.branch}`], repoRoot);
            if (!deleteRemoteCompletionRef.ok) {
              console.warn(`[${ts2()}] Failed to clean remote review completion ref ${completion.branch}: ${deleteRemoteCompletionRef.stderr || deleteRemoteCompletionRef.stdout}`);
            }
          } catch (err) {
            console.warn(`[${ts2()}] Failed to clean remote review completion ref ${completion.branch}: ${err?.message ?? err}`);
          }
        }
        try {
          await gitOps.deleteLocalRef(completion.branch);
        } catch (err) {
          console.warn(`[${ts2()}] Failed to clean local completion ref ${completion.branch}: ${err?.message ?? err}`);
        }
      } else if (cleanupHiddenCompletionRef) {
        console.warn(`[${ts2()}] Retaining completion handoff ${completion.branch} because publication did not reach a confirmed processed state.`);
      }
    }
  } catch (err) {
    console.error(`[${ts2()}] Poll error: ${err.message}`);
  }
}
async function runCheck(repoPath, check) {
  const timeoutMs = check.timeoutMs ?? 300000;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? ["cmd", "/c"] : ["sh", "-c"];
  const proc = Bun.spawn([...shell, check.command], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env }
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join(`
`);
  return { ok: exitCode === 0, output };
}
async function promptYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return false;
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const answer = await new Promise((resolveAnswer) => {
    rl.question(`${question} [y/N]: `, (value) => resolveAnswer(value));
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
async function runGitCapture(args2, cwd = repoRoot) {
  return runGitCommandCapture(cwd, args2);
}
async function resolveGitAuthToken(remoteUrl, configuredToken = config.gitToken ?? "") {
  const resolved = await resolveGitTokenForRemote({
    remoteUrl,
    configuredToken,
    cwd: repoRoot
  });
  return resolved.token;
}
async function resolveCommitSubject(commitSha) {
  const showResult = await runGitCapture(["-C", config.repoPath, "show", "-s", "--format=%s", commitSha], repoRoot);
  if (!showResult.ok)
    return "";
  return (showResult.stdout.split(/\r?\n/, 1)[0] ?? "").trim();
}
async function ensureMainPullRequest(completion, runtimeConfig = config) {
  const remoteUrlResult = await runGitCapture(["-C", runtimeConfig.repoPath, "remote", "get-url", runtimeConfig.remote], repoRoot);
  if (!remoteUrlResult.ok || !remoteUrlResult.stdout) {
    throw new Error(`Unable to resolve git remote URL for ${runtimeConfig.remote}: ${remoteUrlResult.stderr || remoteUrlResult.stdout}`);
  }
  const remoteUrl = remoteUrlResult.stdout.trim();
  const token = await resolveGitAuthToken(remoteUrl, runtimeConfig.gitToken ?? "");
  if (!token) {
    throw new Error("No git provider token available for PR creation (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN).");
  }
  const prBaseBranch = (runtimeConfig.prBaseBranch || integrationBaseBranch).trim();
  const completionPrTitle = (completion.prTitle ?? "").trim();
  const completionPrBody = (completion.prBody ?? "").trim();
  const prTitleCandidate = completionPrTitle || (runtimeConfig.prTitle ?? "").trim() || `PushPals: merge ${runtimeConfig.mainBranch} into ${prBaseBranch}`;
  const prTitle = normalizePrTitleCandidate(prTitleCandidate);
  const prBody = completionPrBody || (config.prBody ?? "").trim() || [
    "Automated PR opened by SourceControlManager.",
    "",
    `- Integration branch: \`${runtimeConfig.mainBranch}\``,
    `- Base branch: \`${prBaseBranch}\``,
    `- Latest merged completion: \`${completion.id}\``,
    `- Latest commit: \`${completion.commitSha}\``,
    "",
    "Please review and merge manually."
  ].join(`
`);
  return ensureIntegrationPullRequest({
    token,
    remoteUrl,
    headBranch: runtimeConfig.mainBranch,
    baseBranch: prBaseBranch,
    title: prTitle,
    body: prBody,
    draft: runtimeConfig.prDraft
  });
}
async function ensureDefaultSourceControlManagerWorktree() {
  if (!usingDefaultRepoPath)
    return;
  const probe = await runGitCapture(["-C", config.repoPath, "rev-parse", "--is-inside-work-tree"]);
  if (probe.ok)
    return;
  mkdirSync2(resolve8(config.repoPath, ".."), { recursive: true });
  await runGitCapture(["worktree", "prune"]);
  const seedCandidates = [
    `${config.remote}/${config.mainBranch}`,
    config.mainBranch,
    integrationBaseRef,
    "HEAD"
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
    const detail = `${addResult.stderr}
${addResult.stdout}`.toLowerCase();
    if (detail.includes("already registered worktree")) {
      await runGitCapture(["worktree", "prune"]);
      addResult = await runGitCapture([
        "worktree",
        "add",
        "--force",
        "--detach",
        config.repoPath,
        seedRef
      ]);
    }
  }
  if (!addResult.ok) {
    throw new Error(`Failed to create default source_control_manager worktree (${config.repoPath}) from ${seedRef}: ${addResult.stderr || addResult.stdout}`);
  }
  console.log(`[${ts2()}] Created default source_control_manager worktree: ${config.repoPath} (seed: ${seedRef})`);
}
function ensureRepoPathIsIsolatedWorktree() {
  const rel = relative(repoRoot, config.repoPath).replace(/\\/g, "/");
  const insideRepoRoot = rel === "" || !rel.startsWith("../") && !isAbsolute3(rel);
  const insideWorktrees = rel === ".worktrees" || rel.startsWith(".worktrees/");
  if (insideRepoRoot && !insideWorktrees) {
    throw new Error(`Unsafe source_control_manager repoPath (${config.repoPath}). Use a dedicated worktree path (recommended: ${defaultSourceControlManagerRepoPath}) so your active workspace branch is never switched.`);
  }
}
async function ensureIntegrationBranchExists() {
  const remoteRef = `${config.remote}/${config.mainBranch}`;
  if (await gitOps.revParse(remoteRef))
    return;
  console.warn(`[${ts2()}] Integration branch ${remoteRef} does not exist.`);
  const autoCreate = config.autoCreateMainBranch;
  let approved = autoCreate;
  if (!approved) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Missing ${remoteRef}. Re-run interactively to approve creation, or set source_control_manager.auto_create_main_branch=true.`);
    }
    approved = await promptYesNo(`Create ${config.mainBranch} from ${integrationBaseRef} and push ${config.mainBranch} to ${config.remote}?`);
  }
  if (!approved) {
    throw new Error(`User declined creation of ${remoteRef}.`);
  }
  await gitOps.bootstrapMainBranchFromBase();
  console.log(`[${ts2()}] Created ${remoteRef}; source_control_manager local integration branch is based on ${integrationBaseRef}.`);
}
async function main() {
  emitInitializingStatus();
  await ensureDefaultSourceControlManagerWorktree();
  ensureRepoPathIsIsolatedWorktree();
  if (!skipCleanCheck) {
    let clean;
    for (let attempt = 1;; attempt++) {
      try {
        clean = await gitOps.isRepoClean();
        break;
      } catch (err) {
        if (attempt >= 10)
          throw err;
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
        console.error(`[${ts2()}] git status failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s\u2026 (attempt ${attempt})`);
        await Bun.sleep(delay);
      }
    }
    if (!clean) {
      console.error(`[${ts2()}] ERROR: Repository at ${config.repoPath} has uncommitted or untracked changes.`);
      console.error(`[${ts2()}] SourceControlManager requires a dedicated clean clone. Exiting.`);
      console.error(`[${ts2()}] WARNING: Do not run this daemon in a developer working copy.`);
      console.error(`[${ts2()}] TIP: Pass --skip-clean-check to bypass this guard in dev.`);
      await shutdown();
      process.exit(1);
    }
    console.log(`[${ts2()}] Repo is clean`);
  }
  await ensureIntegrationBranchExists();
  await emitStartupStatus();
  startStatusHeartbeat();
  await syncReviewAgentRuntimeConfig();
  startReviewAgentRuntimeConfigPolling();
  for (let attempt = 1;; attempt++) {
    try {
      await tick();
      break;
    } catch (err) {
      if (attempt >= 10)
        throw err;
      const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
      console.error(`[${ts2()}] Initial tick failed (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s\u2026 (attempt ${attempt})`);
      await Bun.sleep(delay);
    }
  }
  while (running) {
    await Bun.sleep(config.pollIntervalSeconds * 1000);
    await tick();
  }
}
async function shutdown() {
  if (shutdownPromise)
    return shutdownPromise;
  shutdownPromise = (async () => {
    if (!running)
      return;
    running = false;
    startupStatusTracker.markShutdown();
    console.log(`
[${ts2()}] Shutting down...`);
    if (statusHeartbeatTimer) {
      clearInterval(statusHeartbeatTimer);
      statusHeartbeatTimer = null;
    }
    if (reviewAgentConfigPollTimer) {
      clearInterval(reviewAgentConfigPollTimer);
      reviewAgentConfigPollTimer = null;
    }
    clearReviewAgentPollLoop();
    createSessionComm(statusSessionId).status("source_control_manager", "shutting_down", "SourceControlManager shutting down");
    server?.stop();
    try {
      const cleanup = await gitOps.cleanupLocalTempBranches("_source_control_manager/");
      if (cleanup.removedWorktrees.length > 0) {
        console.log(`[${ts2()}] Shutdown cleanup removed ${cleanup.removedWorktrees.length} temp worktree(s): ${summarizeBranchNames(cleanup.removedWorktrees)}`);
      }
      if (cleanup.deletedBranches.length > 0) {
        console.log(`[${ts2()}] Shutdown cleanup removed ${cleanup.deletedBranches.length} temp branch(es): ${summarizeBranchNames(cleanup.deletedBranches)}`);
      }
      if (cleanup.failedBranches.length > 0) {
        console.warn(`[${ts2()}] Shutdown cleanup failed to remove ${cleanup.failedBranches.length} temp branch(es): ${summarizeBranchNames(cleanup.failedBranches)}`);
      }
      for (const warning of cleanup.warnings) {
        console.warn(`[${ts2()}] Shutdown cleanup warning: ${warning}`);
      }
    } catch (err) {
      console.warn(`[${ts2()}] Shutdown temp-branch cleanup failed: ${err?.message ?? err}`);
    }
    db.close();
    lock.release();
    console.log(`[${ts2()}] Goodbye.`);
  })();
  return shutdownPromise;
}
async function shutdownAndExit(code) {
  await shutdown();
  process.exit(code);
}
process.on("SIGINT", () => {
  shutdownAndExit(130);
});
process.on("SIGTERM", () => {
  shutdownAndExit(143);
});
main().catch(async (err) => {
  console.error(`[${ts2()}] Fatal: ${err.message}`);
  await shutdown();
  process.exit(1);
});
