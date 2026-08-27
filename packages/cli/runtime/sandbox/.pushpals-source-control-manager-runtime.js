// @bun
var __require = import.meta.require;

// apps/source_control_manager/src/source_control_manager_main.ts
import { parseArgs } from "util";
import { isAbsolute as isAbsolute3, join as join7, relative as relative2, resolve as resolve11 } from "path";
import { mkdirSync as mkdirSync4 } from "fs";
import { createHash as createHash5, randomUUID as randomUUID3 } from "crypto";

// packages/shared/src/bounded_fetch.ts
var DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024;
async function fetchWithHardDeadline(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.max(1, Math.floor(options.timeoutMs)) : 1;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController;
  const upstreamSignal = options.init?.signal;
  let rejectUpstreamAbort = null;
  const upstreamAbort = new Promise((_resolve, reject) => {
    rejectUpstreamAbort = reject;
  });
  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
    rejectUpstreamAbort?.(upstreamSignal?.reason instanceof Error ? upstreamSignal.reason : new DOMException("The HTTP request was aborted", "AbortError"));
  };
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  let timer = null;
  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(options.input, {
      ...options.init,
      signal: controller.signal
    });
    return await options.consume(response, controller.signal);
  });
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(options.timeoutMessage ?? `HTTP request timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race(upstreamSignal ? [operation, deadline, upstreamAbort] : [operation, deadline]);
  } finally {
    if (timer)
      clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
async function fetchBufferedWithHardDeadline(options) {
  const { maxResponseBytes: configuredMaxResponseBytes, ...requestOptions } = options;
  const maxResponseBytes = typeof configuredMaxResponseBytes === "number" && Number.isFinite(configuredMaxResponseBytes) && configuredMaxResponseBytes >= 0 ? Math.floor(configuredMaxResponseBytes) : DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  return fetchWithHardDeadline({
    ...requestOptions,
    consume: async (response, signal) => {
      const responseInit = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      };
      if (!response.body)
        return new Response(null, responseInit);
      const reader = response.body.getReader();
      const sizeError = () => new Error(`HTTP response exceeded ${maxResponseBytes} byte buffer limit`);
      const cancelReader = () => {
        try {
          reader.cancel(signal.reason).catch(() => {
            return;
          });
        } catch {}
      };
      signal.addEventListener("abort", cancelReader, { once: true });
      if (signal.aborted)
        cancelReader();
      try {
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
        if (contentLength != null && Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          const error = sizeError();
          await reader.cancel(error).catch(() => {
            return;
          });
          throw error;
        }
        const chunks = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            const error = sizeError();
            await reader.cancel(error).catch(() => {
              return;
            });
            throw error;
          }
          chunks.push(value);
        }
        if (totalBytes === 0)
          return new Response(null, responseInit);
        const body = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new Response(body, responseInit);
      } finally {
        signal.removeEventListener("abort", cancelReader);
        try {
          reader.releaseLock();
        } catch {}
      }
    }
  });
}

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
  requestTimeoutMs;
  constructor(opts) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.from = opts.from;
    this.authToken = opts.authToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = Math.max(1, Math.min(120000, Math.floor(opts.requestTimeoutMs ?? 1e4)));
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
      const response = await fetchBufferedWithHardDeadline({
        input: this.commandUrl(sessionId),
        init: {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body)
        },
        timeoutMs: this.requestTimeoutMs,
        fetchImpl: this.fetchImpl,
        timeoutMessage: `session command timed out after ${this.requestTimeoutMs}ms`
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
  const workerDependencyPreparationTimeoutMs = Math.max(30000, Math.min(20 * 60000, asInt(parseIntEnv("WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS") ?? parseIntEnv("PUSHPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS") ?? workerNode.dependency_preparation_timeout_ms, 5 * 60000)));
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
        maxTokenUsagePerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR") ?? remoteAutonomyNode.max_token_usage_per_hour, 0)),
        maxRuntimeMsPerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_RUNTIME_MS_PER_HOUR") ?? remoteAutonomyNode.max_runtime_ms_per_hour, 0)),
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
      dependencyPreparationTimeoutMs: workerDependencyPreparationTimeoutMs,
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

// packages/shared/src/bounded_process.ts
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The subprocess was aborted", "AbortError");
}
var DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
var DEFAULT_DRAIN_TIMEOUT_MS = 2000;
var DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
var DEFAULT_EXIT_GRACE_MS = 250;
var MAX_STREAMING_LINE_CHARS = 64 * 1024;
function defaultSpawner(argv, options) {
  return Bun.spawn(argv, options);
}
function buildWindowsProcessTreeTerminationArgv(pid) {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}
function buildWindowsDescendantSweepArgv(pid) {
  const rootPid = Math.max(0, Math.floor(pid));
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$rootPid = ${rootPid}`,
    "$processes = @(Get-CimInstance Win32_Process)",
    "$children = @{}",
    "foreach ($process in $processes) {",
    "  $parent = [int]$process.ParentProcessId",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[int]]::new() }",
    "  $children[$parent].Add([int]$process.ProcessId)",
    "}",
    "$stack = [System.Collections.Generic.Stack[int]]::new()",
    "$targets = [System.Collections.Generic.List[int]]::new()",
    "$stack.Push($rootPid)",
    "while ($stack.Count -gt 0) {",
    "  $parent = $stack.Pop()",
    "  if (-not $children.ContainsKey($parent)) { continue }",
    "  foreach ($child in $children[$parent]) { $targets.Add($child); $stack.Push($child) }",
    "}",
    "for ($index = $targets.Count - 1; $index -ge 0; $index--) { Stop-Process -Id $targets[$index] -Force -ErrorAction SilentlyContinue }"
  ].join(`
`);
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}
async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((resolve2) => {
        timer = setTimeout(() => resolve2({ settled: false }), Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
function captureBoundedStream(stream, maxBytes, options = {}) {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { done: Promise.resolve(""), cancel: () => {
      return;
    } };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder;
  const headLimit = options.retainTail ? Math.max(1, Math.floor(maxBytes / 2)) : maxBytes;
  const tailLimit = options.retainTail ? Math.max(0, maxBytes - headLimit) : 0;
  let head = "";
  let tail = "";
  let observedChars = 0;
  let lineBuffer = "";
  let truncated = false;
  let cancelled = false;
  const emitLine = (line) => {
    try {
      options.onLine?.(line);
    } catch {}
  };
  const retainAndEmit = (text) => {
    if (!text)
      return;
    observedChars += text.length;
    const headRemaining = Math.max(0, headLimit - head.length);
    const headPart = headRemaining > 0 ? text.slice(0, headRemaining) : "";
    head += headPart;
    const remainder = text.slice(headPart.length);
    if (remainder && tailLimit > 0)
      tail = `${tail}${remainder}`.slice(-tailLimit);
    truncated = observedChars > maxBytes;
    if (!options.onLine)
      return;
    lineBuffer += text;
    const lines = lineBuffer.split(`
`);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines)
      emitLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lineBuffer.length > MAX_STREAMING_LINE_CHARS) {
      emitLine(`${lineBuffer.slice(0, MAX_STREAMING_LINE_CHARS)}
[pushpals: streaming line truncated]`);
      lineBuffer = "";
    }
  };
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          break;
        retainAndEmit(decoder.decode(chunk.value, { stream: true }));
      }
      retainAndEmit(decoder.decode());
      if (options.onLine && lineBuffer.length > 0) {
        emitLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer);
        lineBuffer = "";
      }
    } catch {} finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    if (!truncated)
      return head + tail;
    const marker = `
[pushpals: process output truncated]`;
    return options.retainTail ? `${head}${marker}
${tail}` : `${head}${marker}`;
  })();
  return {
    done,
    cancel: () => {
      if (cancelled)
        return;
      cancelled = true;
      try {
        reader.cancel().catch(() => {
          return;
        });
      } catch {}
    }
  };
}
async function terminateProcessTree(proc, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawner;
  const terminationTimeoutMs = Math.max(1, options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS);
  const exitGraceMs = Math.max(1, options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
  const gracefulSignalAlreadySent = options.gracefulSignalAlreadySent === true;
  const pid = Number(proc.pid);
  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const killer = spawn(buildWindowsProcessTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore"
      });
      const taskkillExit = await settleWithin(killer.exited, terminationTimeoutMs);
      if (!taskkillExit.settled) {
        try {
          killer.kill("SIGKILL");
        } catch {}
      }
      if (!taskkillExit.settled || taskkillExit.value !== 0) {
        try {
          const sweeper = spawn(buildWindowsDescendantSweepArgv(pid), {
            stdout: "ignore",
            stderr: "ignore"
          });
          if (!(await settleWithin(sweeper.exited, terminationTimeoutMs)).settled) {
            try {
              sweeper.kill("SIGKILL");
            } catch {}
          }
        } catch {}
      }
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } catch {}
  }
  if (platform !== "win32" && Number.isFinite(pid) && pid > 0) {
    if (gracefulSignalAlreadySent) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          return;
        }
      }
      await settleWithin(proc.exited, exitGraceMs);
      return;
    }
    let signalledProcessGroup = false;
    try {
      process.kill(-pid, "SIGTERM");
      signalledProcessGroup = true;
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        return;
      }
    }
    if (!signalledProcessGroup) {
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } else {
      const groupDeadline = Date.now() + exitGraceMs;
      while (Date.now() < groupDeadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH")
            return;
          break;
        }
        await new Promise((resolve2) => setTimeout(resolve2, Math.min(25, Math.max(1, groupDeadline - Date.now()))));
      }
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    await settleWithin(proc.exited, exitGraceMs);
    return;
  }
  if (!gracefulSignalAlreadySent) {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    if ((await settleWithin(proc.exited, exitGraceMs)).settled)
      return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
  await settleWithin(proc.exited, exitGraceMs);
}
async function runBoundedProcess(argv, options) {
  if (options.signal?.aborted)
    throw abortReason(options.signal);
  const spawn = options.spawn ?? defaultSpawner;
  const platform = options.platform ?? process.platform;
  const proc = spawn(argv, {
    ...options.cwd ? { cwd: options.cwd } : {},
    ...options.env ? { env: options.env } : {},
    ...options.stdin ? { stdin: options.stdin } : {},
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    detached: platform !== "win32"
  });
  const maxBytes = Math.max(1, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const stdoutCapture = captureBoundedStream(proc.stdout, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStdoutLine
  });
  const stderrCapture = captureBoundedStream(proc.stderr, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStderrLine
  });
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const maxTotalTimeoutMs = Math.max(timeoutMs, Math.floor(options.maxTotalTimeoutMs ?? timeoutMs));
  const startedAtMs = Date.now();
  let effectiveTimeoutMs = timeoutMs;
  let deadlineAtMs = startedAtMs + timeoutMs;
  let timer = null;
  let removeAbortListener = () => {
    return;
  };
  const aborted = new Promise((resolve2) => {
    const onAbort = () => resolve2({
      timedOut: false,
      aborted: true,
      exitCode: 130,
      reason: abortReason(options.signal)
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    if (options.signal?.aborted)
      onAbort();
  });
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({
      timedOut: false,
      aborted: false,
      exitCode
    })),
    new Promise((resolve2) => {
      const scheduleDeadline = () => {
        timer = setTimeout(() => {
          const nowMs = Date.now();
          let requestedExtensionValue = 0;
          try {
            requestedExtensionValue = options.extendTimeoutMs?.({
              startedAtMs,
              deadlineAtMs,
              elapsedMs: Math.max(0, nowMs - startedAtMs)
            }) ?? 0;
          } catch {
            requestedExtensionValue = 0;
          }
          const extensionMs = Math.min(Math.max(0, Math.floor(requestedExtensionValue)), Math.max(0, maxTotalTimeoutMs - effectiveTimeoutMs));
          if (extensionMs > 0) {
            effectiveTimeoutMs += extensionMs;
            deadlineAtMs = nowMs + extensionMs;
            try {
              options.onTimeoutExtended?.(extensionMs, deadlineAtMs);
            } catch {}
            scheduleDeadline();
            return;
          }
          try {
            options.onTimeout?.(Math.max(1, nowMs - startedAtMs));
          } catch {}
          resolve2({ timedOut: true, aborted: false, exitCode: 124 });
        }, Math.max(1, deadlineAtMs - Date.now()));
      };
      scheduleDeadline();
    }),
    ...options.signal ? [aborted] : []
  ]);
  if (timer)
    clearTimeout(timer);
  removeAbortListener();
  const terminate = options.terminate ?? ((target) => terminateProcessTree(target, { platform, spawn }));
  if (outcome.timedOut || outcome.aborted)
    await terminate(proc);
  const drainTimeoutMs = Math.max(1, options.streamDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let streams = await settleWithin(Promise.all([stdoutCapture.done, stderrCapture.done]), drainTimeoutMs);
  const drainTimedOut = !streams.settled;
  if (!streams.settled) {
    if (!outcome.timedOut && !outcome.aborted) {
      if (options.terminate) {
        await options.terminate(proc);
      } else {
        await terminateProcessTree(proc, {
          platform,
          spawn,
          exitGraceMs: Math.min(250, Math.max(25, drainTimeoutMs))
        });
      }
    }
    stdoutCapture.cancel();
    stderrCapture.cancel();
    streams = await settleWithin(Promise.all([stdoutCapture.done, stderrCapture.done]), 250);
  }
  const [stdout, rawStderr] = streams.settled ? streams.value : ["", ""];
  const timeoutDetail = outcome.timedOut ? `Command timed out after ${effectiveTimeoutMs}ms; terminated process tree.` : "";
  const drainDetail = drainTimedOut ? `Process streams did not close after ${drainTimeoutMs}ms; terminated process tree and stopped draining.` : "";
  const trimOutput = (text) => options.preserveOutputWhitespace ? text : text.trim();
  if (outcome.aborted)
    throw outcome.reason;
  return {
    stdout: trimOutput(stdout),
    stderr: [trimOutput(rawStderr), timeoutDetail, drainDetail].filter(Boolean).join(`
`),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    drainTimedOut
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
    const result = await runBoundedProcess(command, {
      cwd,
      timeoutMs: 1e4,
      outputLimitBytes: 256 * 1024
    });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
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

// packages/shared/src/memory.ts
import { createHash, randomUUID } from "crypto";
var MEMORY_REINFORCEMENT_OUTCOMES = Object.freeze([
  "confirmed",
  "successful",
  "failed",
  "contradicted"
]);
var MEMORY_LIMITS = Object.freeze({
  namespaceChars: 128,
  repositoryIdChars: 256,
  sessionIdChars: 256,
  keyChars: 512,
  kindChars: 128,
  subjectKeyChars: 512,
  summaryChars: 16000,
  listItems: 128,
  listItemChars: 256,
  tagChars: 128,
  evidenceItems: 128,
  evidencePathChars: 1000,
  evidenceBlobOidChars: 256,
  evidenceSourceIdChars: 512,
  evidenceDetailChars: 2000,
  provenanceServiceChars: 128,
  provenanceFieldChars: 512,
  searchTextChars: 2000,
  selectorReasonChars: 1000,
  recordIdChars: 256,
  searchMaxItems: 128,
  searchMaxChars: 1e6,
  searchCandidateRows: 4096
});
var MEMORY_HTTP_CALLER_HEADER = "x-pushpals-memory-caller";
var MEMORY_HTTP_AUTHORITY_HEADER = "x-pushpals-memory-authority";
var REPOSITORY_AGENT_MEMORY_NAMESPACES = Object.freeze([
  "repository_agent_cache",
  "repository_agent_capabilities",
  "repository_facts"
]);
var MAX_MEMORY_REINFORCEMENT_OBSERVATIONS = 256;
function assertMemoryPutFence(options, nowMs) {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("The memory write was aborted", "AbortError");
  }
  if (options.validUntil === undefined)
    return;
  if (typeof options.validUntil !== "string") {
    throw new TypeError("validUntil must be an ISO timestamp");
  }
  const validUntilMs = Date.parse(options.validUntil);
  if (!Number.isFinite(validUntilMs))
    throw new TypeError("validUntil must be an ISO timestamp");
  if (validUntilMs <= nowMs) {
    throw new Error("Memory write commit fence expired before mutation");
  }
}

class MemoryConflictError extends Error {
  code;
  constructor(message, code = "conflict") {
    super(message);
    this.name = "MemoryConflictError";
    this.code = code;
  }
}

class MemoryStoreClosedError extends Error {
  constructor() {
    super("Memory store is closed");
    this.name = "MemoryStoreClosedError";
  }
}

class MemoryValidationError extends TypeError {
  code;
  constructor(message, code) {
    super(message);
    this.name = "MemoryValidationError";
    this.code = code;
  }
}

class MemoryHttpError extends Error {
  status;
  code;
  constructor(message, status = 0, code) {
    super(message);
    this.name = "MemoryHttpError";
    this.status = status;
    this.code = typeof code === "string" && code.trim() ? code.trim() : null;
  }
}
function isMemoryReinforcementOutcome(value) {
  return typeof value === "string" && MEMORY_REINFORCEMENT_OUTCOMES.includes(value);
}
function assertMemoryReinforcementOutcome(value) {
  if (isMemoryReinforcementOutcome(value))
    return;
  throw new MemoryValidationError(`memory reinforcement outcome must be one of: ${MEMORY_REINFORCEMENT_OUTCOMES.join(", ")}`, "invalid_reinforcement_outcome");
}
function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function requiredText(value, label) {
  const normalized = normalizedText(value);
  if (!normalized)
    throw new TypeError(`${label} is required`);
  return normalized;
}
function compactText(value, maxChars) {
  return normalizedText(value).slice(0, maxChars);
}
function boundedAddressText(value, label, maxChars, required) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    if (required)
      throw new TypeError(`${label} is required`);
    return null;
  }
  if (normalized.length > maxChars) {
    throw new TypeError(`${label} must be at most ${maxChars} characters`);
  }
  if (normalized.includes("\x00"))
    throw new TypeError(`${label} must not contain NUL characters`);
  return normalized;
}
function normalizedOptionalText(value) {
  return normalizedText(value) || null;
}
function normalizeScope(scope) {
  return {
    namespace: boundedAddressText(scope?.namespace, "memory scope namespace", MEMORY_LIMITS.namespaceChars, true),
    repositoryId: boundedAddressText(scope?.repositoryId, "memory scope repositoryId", MEMORY_LIMITS.repositoryIdChars, false),
    sessionId: boundedAddressText(scope?.sessionId, "memory scope sessionId", MEMORY_LIMITS.sessionIdChars, false)
  };
}
function scopeKey(scope) {
  const normalized = normalizeScope(scope);
  return JSON.stringify([
    normalized.namespace,
    normalized.repositoryId ?? "",
    normalized.sessionId ?? ""
  ]);
}
function addressKey(address) {
  const key = boundedAddressText(address.key, "memory key", MEMORY_LIMITS.keyChars, true);
  return `${scopeKey(address.scope)}\x00${key}`;
}
function clampUnit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.max(0, Math.min(1, parsed));
}
function normalizedStringList(values, maxItems = MEMORY_LIMITS.listItems, maxChars = MEMORY_LIMITS.listItemChars) {
  if (!Array.isArray(values))
    return [];
  const output = [];
  const seen = new Set;
  for (const value of values) {
    const item = compactText(value, maxChars);
    if (!item || seen.has(item))
      continue;
    seen.add(item);
    output.push(item);
    if (output.length >= maxItems)
      break;
  }
  return output;
}
function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence))
    return [];
  const output = [];
  for (const raw of evidence.slice(0, MEMORY_LIMITS.evidenceItems)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      continue;
    const row = raw;
    const path = compactText(row.path, MEMORY_LIMITS.evidencePathChars).replace(/\\/g, "/") || undefined;
    if (path && (/^(?:[a-z]:)?\//i.test(path) || path.split("/").includes(".."))) {
      throw new TypeError("memory evidence paths must be repository-relative and contained");
    }
    const normalized = {
      ...path ? { path } : {},
      ...compactText(row.blobOid, MEMORY_LIMITS.evidenceBlobOidChars) ? { blobOid: compactText(row.blobOid, MEMORY_LIMITS.evidenceBlobOidChars) } : {},
      ...compactText(row.sourceId, MEMORY_LIMITS.evidenceSourceIdChars) ? { sourceId: compactText(row.sourceId, MEMORY_LIMITS.evidenceSourceIdChars) } : {},
      ...compactText(row.detail, MEMORY_LIMITS.evidenceDetailChars) ? { detail: compactText(row.detail, MEMORY_LIMITS.evidenceDetailChars) } : {},
      ...normalizedOptionalText(row.observedAt) ? { observedAt: normalizeTimestamp(row.observedAt, "evidence observedAt") } : {}
    };
    if (Object.keys(normalized).length > 0)
      output.push(normalized);
  }
  return output;
}
function normalizeProvenance(value) {
  const service = compactText(value?.service, MEMORY_LIMITS.provenanceServiceChars);
  if (!service)
    throw new TypeError("memory provenance service is required");
  const optional = (input) => compactText(input, MEMORY_LIMITS.provenanceFieldChars) || undefined;
  return {
    service,
    ...optional(value.agentId) ? { agentId: optional(value.agentId) } : {},
    ...optional(value.runId) ? { runId: optional(value.runId) } : {},
    ...optional(value.requestId) ? { requestId: optional(value.requestId) } : {},
    ...optional(value.jobId) ? { jobId: optional(value.jobId) } : {},
    ...optional(value.modelId) ? { modelId: optional(value.modelId) } : {},
    ...optional(value.headSha) ? { headSha: optional(value.headSha) } : {},
    ...optional(value.promptVersion) ? { promptVersion: optional(value.promptVersion) } : {}
  };
}
function normalizeTimestamp(value, label) {
  const timestamp = compactText(value, 64);
  const parsed = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(parsed))
    throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}
function normalizeStatus(value, fallback = "active") {
  return value === "active" || value === "stale" || value === "superseded" || value === "invalid" ? value : fallback;
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function cloneObservation(observation) {
  return {
    ...observation,
    ...observation.evidence ? { evidence: observation.evidence.map((entry) => ({ ...entry })) } : {},
    ...observation.provenance ? { provenance: { ...observation.provenance } } : {}
  };
}
function cloneRecord(record) {
  return {
    ...record,
    scope: { ...record.scope },
    value: record.value == null ? null : cloneJson(record.value),
    tags: [...record.tags],
    evidence: record.evidence.map((entry) => ({ ...entry })),
    observations: record.observations.map(cloneObservation),
    provenance: { ...record.provenance }
  };
}
function serializedMemoryRecordChars(record) {
  return JSON.stringify(record).length;
}
function isExpired(record, nowMs) {
  return record.expiresAt != null && Date.parse(record.expiresAt) <= nowMs;
}
function sameScope(left, right) {
  return scopeKey(left) === scopeKey(right);
}
function matchesAny(value, candidates, maxChars = MEMORY_LIMITS.listItemChars) {
  if (!candidates || candidates.length === 0)
    return true;
  if (value == null)
    return false;
  return new Set(normalizedStringList(candidates, MEMORY_LIMITS.listItems, maxChars).map((entry) => entry.toLowerCase())).has(value.toLowerCase());
}
function hasAllTags(record, tags) {
  const requested = normalizedStringList(tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars).map((tag) => tag.toLowerCase());
  if (requested.length === 0)
    return true;
  const available = new Set(record.tags.map((tag) => tag.toLowerCase()));
  return requested.every((tag) => available.has(tag));
}
function hasAnyEvidencePath(record, paths) {
  const requested = normalizedStringList(paths, MEMORY_LIMITS.listItems, MEMORY_LIMITS.evidencePathChars).map((path) => path.replace(/\\/g, "/"));
  if (requested.length === 0)
    return true;
  const available = new Set(record.evidence.map((entry) => entry.path?.replace(/\\/g, "/")).filter((path) => Boolean(path)));
  return requested.some((path) => available.has(path));
}
function hasAllEvidencePaths(record, paths) {
  const requested = normalizedStringList(paths, MEMORY_LIMITS.listItems, MEMORY_LIMITS.evidencePathChars).map((path) => path.replace(/\\/g, "/"));
  if (requested.length === 0)
    return true;
  const available = new Set(record.evidence.map((entry) => entry.path?.replace(/\\/g, "/")).filter((path) => Boolean(path)));
  return requested.every((path) => available.has(path));
}
function resolveMemoryReinforcement(record, outcome, requestedWeight = 1) {
  assertMemoryReinforcementOutcome(outcome);
  const parsedWeight = Number(requestedWeight);
  const weight = Math.max(0, Math.min(4, Number.isFinite(parsedWeight) ? parsedWeight : 1));
  const positive = outcome === "confirmed" || outcome === "successful";
  const confidence = positive ? record.confidence + (1 - record.confidence) * 0.15 * weight : record.confidence * (1 - 0.25 * weight);
  const usefulness = positive ? record.usefulness + (1 - record.usefulness) * 0.12 * weight : record.usefulness * (1 - 0.2 * weight);
  const status = outcome === "contradicted" ? "superseded" : positive && record.status === "stale" ? "active" : record.status;
  return {
    weight,
    confidence: clampUnit(confidence, record.confidence),
    usefulness: clampUnit(usefulness, record.usefulness),
    status
  };
}
function reinforcementObservationId(recordId, input) {
  const explicit = normalizedOptionalText(input.observationId);
  const provenance = input.provenance;
  const inferredParts = provenance ? [
    normalizedOptionalText(provenance.service),
    normalizedOptionalText(provenance.requestId),
    normalizedOptionalText(provenance.jobId),
    normalizedOptionalText(provenance.runId)
  ].filter((part) => part != null) : [];
  const inferredIdentity = inferredParts.length > 1 ? inferredParts.join("\x00") : null;
  if (!explicit && !inferredIdentity)
    return randomUUID();
  const identity = explicit ? [recordId, "explicit", explicit] : [recordId, "inferred", inferredIdentity, input.outcome];
  return `observation_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}
function createMemoryReinforcementObservation(recordId, input, observedAt) {
  assertMemoryReinforcementOutcome(input.outcome);
  const effect = resolveMemoryReinforcement({ confidence: 0, usefulness: 0, status: "active" }, input.outcome, input.weight);
  const evidence = normalizeEvidence(input.evidence);
  return {
    id: reinforcementObservationId(recordId, input),
    outcome: input.outcome,
    weight: effect.weight,
    observedAt: normalizeTimestamp(observedAt, "reinforcement observedAt"),
    ...evidence.length > 0 ? { evidence } : {},
    ...input.provenance ? { provenance: normalizeProvenance(input.provenance) } : {}
  };
}
function appendMemoryReinforcementObservation(existing, observation) {
  const prior = existing.find((entry) => entry.id === observation.id);
  if (prior)
    assertMemoryReinforcementObservationCompatible(prior, observation);
  const appended = prior == null;
  const candidates = appended ? [...existing, observation] : existing;
  const seen = new Set;
  const observations = [];
  for (let index = candidates.length - 1;index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate || seen.has(candidate.id))
      continue;
    seen.add(candidate.id);
    observations.unshift(cloneObservation(candidate));
    if (observations.length >= MAX_MEMORY_REINFORCEMENT_OBSERVATIONS)
      break;
  }
  return { observations, appended };
}
function canonicalObservationPayload(observation) {
  const evidence = (observation.evidence ?? []).map((entry) => JSON.stringify({
    path: entry.path ?? null,
    blobOid: entry.blobOid ?? null,
    sourceId: entry.sourceId ?? null,
    detail: entry.detail ?? null,
    observedAt: entry.observedAt ?? null
  })).sort();
  const provenance = observation.provenance ? {
    service: observation.provenance.service,
    agentId: observation.provenance.agentId ?? null,
    runId: observation.provenance.runId ?? null,
    requestId: observation.provenance.requestId ?? null,
    jobId: observation.provenance.jobId ?? null,
    modelId: observation.provenance.modelId ?? null,
    headSha: observation.provenance.headSha ?? null,
    promptVersion: observation.provenance.promptVersion ?? null
  } : null;
  return JSON.stringify({
    outcome: observation.outcome,
    weight: observation.weight,
    evidence,
    provenance
  });
}
function assertMemoryReinforcementObservationCompatible(existing, candidate) {
  if (existing.id !== candidate.id)
    return;
  if (canonicalObservationPayload(existing) === canonicalObservationPayload(candidate))
    return;
  throw new MemoryConflictError(`Memory observation conflict for ${candidate.id}: the id was already used for a different outcome payload`);
}
function memoryRecordRankingQuality(record) {
  return (clampUnit(record.confidence, 0.5) + clampUnit(record.usefulness, 0.5)) / 2;
}
function searchScore(record, text) {
  const tokens = normalizedText(text).toLowerCase().split(/[^a-z0-9_.\/-]+/).filter((token) => token.length > 1).slice(0, 64);
  if (tokens.length === 0)
    return 0;
  const subject = (record.subjectKey ?? "").toLowerCase();
  const haystack = [record.key, record.kind, subject, record.summary, ...record.tags].join(" ").toLowerCase();
  let score = 0;
  for (const token of new Set(tokens)) {
    if (record.key.toLowerCase() === token || subject === token)
      score += 6;
    else if (record.key.toLowerCase().includes(token) || subject.includes(token))
      score += 3;
    else if (haystack.includes(token))
      score += 1;
  }
  return score;
}

class InMemoryMemoryStore {
  records = new Map;
  now;
  closed = false;
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date);
  }
  assertOpen() {
    if (this.closed)
      throw new MemoryStoreClosedError;
  }
  async put(input, options = {}) {
    this.assertOpen();
    const normalizedScope = normalizeScope(input.scope);
    const key = boundedAddressText(input.key, "memory key", MEMORY_LIMITS.keyChars, true);
    const storageKey = addressKey({ scope: normalizedScope, key });
    const existing = this.records.get(storageKey);
    if (options.expectedRevision != null) {
      const actualRevision = existing?.revision ?? 0;
      if (actualRevision !== options.expectedRevision) {
        throw new MemoryConflictError(`Memory revision conflict for ${key}: expected ${options.expectedRevision}, got ${actualRevision}`);
      }
    }
    const writeNow = this.now();
    assertMemoryPutFence(options, writeNow.getTime());
    const now = writeNow.toISOString();
    let expiresAt;
    if (input.expiresAt !== undefined) {
      expiresAt = input.expiresAt == null ? null : normalizeTimestamp(input.expiresAt, "expiresAt");
    } else if (input.ttlMs !== undefined && input.ttlMs !== null) {
      const ttlMs = Number(input.ttlMs);
      if (!Number.isFinite(ttlMs) || ttlMs <= 0)
        throw new TypeError("ttlMs must be positive");
      expiresAt = new Date(Date.parse(now) + Math.floor(ttlMs)).toISOString();
    } else {
      expiresAt = existing?.expiresAt ?? null;
    }
    const status = normalizeStatus(input.status, existing?.status ?? "active");
    const preserveLearnedScores = existing != null && options.expectedRevision === undefined;
    const remainsInvalid = status === "invalid" && existing?.status === "invalid";
    const record = {
      id: existing?.id ?? randomUUID(),
      scope: normalizedScope,
      key,
      kind: requiredText(compactText(input.kind, MEMORY_LIMITS.kindChars), "memory kind"),
      subjectKey: compactText(input.subjectKey, MEMORY_LIMITS.subjectKeyChars) || null,
      summary: requiredText(compactText(input.summary, MEMORY_LIMITS.summaryChars), "memory summary"),
      value: input.value == null ? null : cloneJson(input.value),
      tags: normalizedStringList(input.tags, MEMORY_LIMITS.listItems, MEMORY_LIMITS.tagChars),
      evidence: normalizeEvidence(input.evidence),
      observations: existing?.observations.map(cloneObservation) ?? [],
      provenance: existing?.provenance ?? normalizeProvenance(input.provenance),
      confidence: preserveLearnedScores ? existing.confidence : clampUnit(input.confidence, existing?.confidence ?? 0.5),
      usefulness: preserveLearnedScores ? existing.usefulness : clampUnit(input.usefulness, existing?.usefulness ?? 0.5),
      status,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expiresAt,
      invalidatedAt: status === "invalid" ? remainsInvalid ? existing.invalidatedAt : now : null,
      invalidationReason: status === "invalid" && remainsInvalid ? existing.invalidationReason : null
    };
    assertMemoryPutFence(options, this.now().getTime());
    this.records.set(storageKey, record);
    return cloneRecord(record);
  }
  async get(address, options = {}) {
    this.assertOpen();
    const record = this.records.get(addressKey(address));
    if (!record)
      return null;
    if (!options.includeExpired && isExpired(record, this.now().getTime()))
      return null;
    const statuses = options.statuses?.length ? options.statuses : ["active"];
    if (!statuses.includes(record.status))
      return null;
    return cloneRecord(record);
  }
  async search(query) {
    this.assertOpen();
    const scope = normalizeScope(query.scope);
    const statuses = query.statuses?.length ? query.statuses : ["active"];
    const nowMs = this.now().getTime();
    const candidates = [...this.records.values()].filter((record) => sameScope(record.scope, scope)).filter((record) => query.includeExpired || !isExpired(record, nowMs)).filter((record) => statuses.includes(record.status)).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.revision - left.revision || left.key.localeCompare(right.key)).slice(0, MEMORY_LIMITS.searchCandidateRows);
    const scored = candidates.filter((record) => matchesAny(record.kind, query.kinds, MEMORY_LIMITS.kindChars)).filter((record) => matchesAny(record.subjectKey, query.subjectKeys, MEMORY_LIMITS.subjectKeyChars)).filter((record) => hasAllTags(record, query.tags)).filter((record) => hasAllEvidencePaths(record, query.evidencePaths)).map((record) => ({
      record,
      score: searchScore(record, compactText(query.text, MEMORY_LIMITS.searchTextChars))
    })).filter((entry) => !compactText(query.text, MEMORY_LIMITS.searchTextChars) || entry.score > 0).sort((left, right) => right.score - left.score || memoryRecordRankingQuality(right.record) - memoryRecordRankingQuality(left.record) || Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt) || right.record.revision - left.record.revision || left.record.key.localeCompare(right.record.key));
    const requestedMaxItems = Number(query.maxItems ?? 12);
    const maxItems = Math.max(1, Math.min(MEMORY_LIMITS.searchMaxItems, Number.isFinite(requestedMaxItems) ? Math.floor(requestedMaxItems) : 12));
    const requestedMaxChars = Number(query.maxChars ?? 16000);
    const maxChars = Math.max(1, Math.min(MEMORY_LIMITS.searchMaxChars, Number.isFinite(requestedMaxChars) ? Math.floor(requestedMaxChars) : 16000));
    const output = [];
    let usedChars = 0;
    for (const { record } of scored) {
      if (output.length >= maxItems)
        break;
      const cloned = cloneRecord(record);
      const cost = serializedMemoryRecordChars(cloned);
      if (usedChars + cost > maxChars)
        continue;
      output.push(cloned);
      usedChars += cost;
    }
    return output;
  }
  async invalidate(selector) {
    this.assertOpen();
    const scope = normalizeScope(selector.scope);
    const reason = compactText(selector.reason, MEMORY_LIMITS.selectorReasonChars) || "invalidated";
    const now = this.now().toISOString();
    let changed = 0;
    for (const [key, record] of this.records) {
      if (!sameScope(record.scope, scope))
        continue;
      if (!matchesAny(record.key, selector.keys, MEMORY_LIMITS.keyChars))
        continue;
      if (!matchesAny(record.kind, selector.kinds, MEMORY_LIMITS.kindChars))
        continue;
      if (!matchesAny(record.subjectKey, selector.subjectKeys, MEMORY_LIMITS.subjectKeyChars))
        continue;
      if (!hasAllTags(record, selector.tags))
        continue;
      if (!hasAnyEvidencePath(record, selector.evidencePaths))
        continue;
      if (selector.statuses?.length && !selector.statuses.includes(record.status))
        continue;
      if (record.status === "invalid")
        continue;
      this.records.set(key, {
        ...record,
        status: "invalid",
        revision: record.revision + 1,
        updatedAt: now,
        invalidatedAt: now,
        invalidationReason: reason
      });
      changed++;
    }
    return changed;
  }
  async reinforce(input) {
    this.assertOpen();
    assertMemoryReinforcementOutcome(input?.outcome);
    const storageKey = addressKey(input);
    const record = this.records.get(storageKey);
    if (!record)
      return null;
    if (input.expectedId !== undefined) {
      const expectedId = boundedAddressText(input.expectedId, "memory expectedId", MEMORY_LIMITS.recordIdChars, true);
      if (record.id !== expectedId) {
        throw new MemoryConflictError(`Memory record conflict for ${record.scope.namespace}/${record.key}: expected id ${expectedId}, got ${record.id}`, "record_conflict");
      }
    }
    const effect = resolveMemoryReinforcement(record, input.outcome, input.weight);
    const now = this.now().toISOString();
    const observation = createMemoryReinforcementObservation(record.id, input, now);
    const appended = appendMemoryReinforcementObservation(record.observations, observation);
    if (!appended.appended)
      return cloneRecord(record);
    const updated = {
      ...record,
      confidence: effect.confidence,
      usefulness: effect.usefulness,
      status: effect.status,
      evidence: input.evidence && input.evidence.length > 0 ? normalizeEvidence([...record.evidence, ...input.evidence]) : record.evidence,
      observations: appended.observations,
      provenance: record.provenance,
      revision: record.revision + 1,
      updatedAt: now,
      invalidatedAt: effect.status === "invalid" ? record.invalidatedAt : null,
      invalidationReason: effect.status === "invalid" ? record.invalidationReason : null
    };
    this.records.set(storageKey, updated);
    return cloneRecord(updated);
  }
  async prune(options = {}) {
    this.assertOpen();
    const expiryCutoff = options.expiredBefore ? Date.parse(normalizeTimestamp(options.expiredBefore, "expiredBefore")) : this.now().getTime();
    const updatedCutoff = options.updatedBefore ? Date.parse(normalizeTimestamp(options.updatedBefore, "updatedBefore")) : null;
    const ageStatuses = options.statuses?.length ? options.statuses : ["invalid", "superseded"];
    let removed = 0;
    for (const [key, record] of this.records) {
      if (options.scope && !sameScope(record.scope, options.scope))
        continue;
      const expired = record.expiresAt != null && Date.parse(record.expiresAt) <= expiryCutoff;
      const agedTerminal = updatedCutoff != null && ageStatuses.includes(record.status) && Date.parse(record.updatedAt) <= updatedCutoff;
      if (!expired && !agedTerminal)
        continue;
      this.records.delete(key);
      removed++;
    }
    return removed;
  }
  async close() {
    this.closed = true;
  }
}

class MemoryHttpClient {
  serverUrl;
  authToken;
  callerService;
  authority;
  fetchImpl;
  timeoutMs;
  maxResponseBytes;
  closed = false;
  constructor(options) {
    this.serverUrl = requiredText(options.serverUrl, "memory server URL").replace(/\/+$/, "");
    this.authToken = normalizedOptionalText(options.authToken);
    const callerService = normalizedText(options.callerService ?? "client");
    if (callerService !== "server" && callerService !== "localbuddy" && callerService !== "remotebuddy" && callerService !== "workerpals" && callerService !== "source_control_manager" && callerService !== "repository_agent" && callerService !== "cli" && callerService !== "client") {
      throw new TypeError(`Unsupported memory caller service: ${callerService}`);
    }
    this.callerService = callerService;
    const authority = normalizedOptionalText(options.authority);
    if (authority && authority !== "repository_agent" && authority !== "server") {
      throw new TypeError(`Unsupported memory authority: ${authority}`);
    }
    this.authority = authority === "repository_agent" || authority === "server" ? authority : null;
    this.fetchImpl = options.fetchImpl;
    const requestedTimeoutMs = Number(options.timeoutMs ?? 1e4);
    this.timeoutMs = Math.max(1, Math.min(120000, Number.isFinite(requestedTimeoutMs) ? Math.floor(requestedTimeoutMs) : 1e4));
    const requestedMaxResponseBytes = Number(options.maxResponseBytes ?? 2 * 1024 * 1024);
    this.maxResponseBytes = Math.max(1024, Math.min(32 * 1024 * 1024, Number.isFinite(requestedMaxResponseBytes) ? Math.floor(requestedMaxResponseBytes) : 2 * 1024 * 1024));
  }
  async request(path, method, body, signal) {
    if (this.closed)
      throw new MemoryStoreClosedError;
    const headers = {
      "Content-Type": "application/json",
      [MEMORY_HTTP_CALLER_HEADER]: this.callerService,
      ...this.authority ? { [MEMORY_HTTP_AUTHORITY_HEADER]: this.authority } : {}
    };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${this.serverUrl}${path}`,
      init: { method, headers, body: JSON.stringify(body), ...signal ? { signal } : {} },
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      fetchImpl: this.fetchImpl,
      timeoutMessage: `Memory request ${method} ${path} timed out after ${this.timeoutMs}ms`
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      if (response.ok)
        throw new MemoryHttpError("Memory server returned invalid JSON", response.status);
    }
    if (!response.ok || payload.ok === false) {
      const detail = normalizedText(payload.message ?? payload.error) || response.statusText || "request failed";
      if (response.status === 409) {
        throw new MemoryConflictError(detail, payload.code === "record_conflict" ? "record_conflict" : "conflict");
      }
      throw new MemoryHttpError(`Memory server request failed: ${detail}`, response.status, payload.code);
    }
    return payload;
  }
  async put(input, options = {}) {
    const { signal, ...durableOptions } = options;
    const payload = await this.request("/memory/records", "PUT", { input, options: durableOptions }, signal);
    if (!payload.record)
      throw new MemoryHttpError("Memory server response omitted record");
    return payload.record;
  }
  async get(address, options = {}) {
    const payload = await this.request("/memory/get", "POST", { address, options });
    return payload.record ?? null;
  }
  async search(query) {
    const payload = await this.request("/memory/search", "POST", { query });
    if (!Array.isArray(payload.records)) {
      throw new MemoryHttpError("Memory server response omitted records");
    }
    return payload.records;
  }
  async invalidate(selector) {
    const payload = await this.request("/memory/invalidate", "POST", { selector });
    return Math.max(0, Math.floor(Number(payload.count ?? 0)) || 0);
  }
  async reinforce(input) {
    assertMemoryReinforcementOutcome(input?.outcome);
    const payload = await this.request("/memory/reinforce", "POST", { input });
    return payload.record ?? null;
  }
  async prune(options = {}) {
    const payload = await this.request("/memory/prune", "POST", { options });
    return Math.max(0, Math.floor(Number(payload.count ?? 0)) || 0);
  }
  async close() {
    this.closed = true;
  }
}

// packages/shared/src/repository_agent.ts
var REPOSITORY_AGENT_SCHEMA_VERSION = 1;
var REPOSITORY_AGENT_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  responseBytes: 2 * 1024 * 1024,
  deadlineHorizonMs: 60 * 60000,
  questionChars: 32000,
  contextChars: 96000,
  contextDepth: 8,
  contextEntries: 1024,
  contextStringChars: 16000,
  answerChars: 128000,
  summaryChars: 16000,
  evidenceItems: 128,
  recommendationItems: 64,
  validationProposalItems: 32,
  memoryRefItems: 128
});

class RepositoryAgentClientError extends Error {
  code;
  status;
  requestId;
  retryAfterMs;
  remoteCode;
  detail;
  retryable;
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepositoryAgentClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.remoteCode = options.remoteCode ?? null;
    this.detail = options.detail ?? null;
    this.retryable = options.retryable ?? null;
  }
}
var CALLER_SERVICES = new Set([
  "server",
  "localbuddy",
  "remotebuddy",
  "workerpals",
  "source_control_manager",
  "repository_agent",
  "cli",
  "client"
]);
var PURPOSES = new Set([
  "architecture",
  "priority",
  "ownership",
  "validation",
  "debug",
  "impact",
  "general"
]);
var PRIORITIES = new Set(["interactive", "normal", "background"]);
var FRESHNESS_VALUES = new Set([
  "cache_preferred",
  "fresh_required",
  "cache_only"
]);
var MEMORY_ROLES = new Set([
  "analysis_cache",
  "evidence_fact",
  "recalled_fact"
]);
var REQUEST_STATUSES = new Set([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired"
]);
var TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired"
]);
function invalidRequest(message) {
  throw new RepositoryAgentClientError("invalid_request", message);
}
function invalidResponse(message) {
  throw new RepositoryAgentClientError("invalid_response", message);
}
function contractViolation(source, message) {
  return source === "request" ? invalidRequest(message) : invalidResponse(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function requiredString(value, label, maxChars, source) {
  if (typeof value !== "string") {
    return source === "request" ? invalidRequest(`${label} must be a string`) : invalidResponse(`${label} must be a string`);
  }
  const normalized = value.replace(/\u0000/g, "").trim();
  if (!normalized) {
    return source === "request" ? invalidRequest(`${label} is required`) : invalidResponse(`${label} is required`);
  }
  if (normalized.length > maxChars) {
    return source === "request" ? invalidRequest(`${label} exceeds ${maxChars} characters`) : `${normalized.slice(0, Math.max(1, maxChars - 14))}...[truncated]`;
  }
  return normalized;
}
function optionalString(value, maxChars) {
  if (typeof value !== "string")
    return;
  const normalized = value.replace(/\u0000/g, "").trim();
  if (!normalized)
    return;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(1, maxChars - 14))}...[truncated]`;
}
function finiteInt(value, options) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    if (options.fallback !== undefined)
      return options.fallback;
    invalidResponse("Expected a finite integer");
  }
  return Math.max(options.min, Math.min(options.max, Math.floor(parsed)));
}
function normalizedIso(value, label, source) {
  const raw = requiredString(value, label, 128, source);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return source === "request" ? invalidRequest(`${label} must be a valid ISO-8601 timestamp`) : invalidResponse(`${label} must be a valid ISO-8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}
function sanitizeRelativePath(value, label) {
  const path = optionalString(value, 1024)?.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:\//i.test(path))
    return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === "."))
    return null;
  return segments.join("/") || (label === "cwd" && path === "." ? "." : null);
}
function sanitizeJsonValue(value, label, depth, budget, source) {
  if (depth > REPOSITORY_AGENT_LIMITS.contextDepth) {
    contractViolation(source, `${label} exceeds maximum nesting depth`);
  }
  if (value === null || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      contractViolation(source, `${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > REPOSITORY_AGENT_LIMITS.contextStringChars) {
      contractViolation(source, `${label} contains a string longer than ${REPOSITORY_AGENT_LIMITS.contextStringChars} characters`);
    }
    budget.chars += value.length;
    if (budget.chars > REPOSITORY_AGENT_LIMITS.contextChars) {
      contractViolation(source, `${label} exceeds ${REPOSITORY_AGENT_LIMITS.contextChars} characters`);
    }
    return value.replace(/\u0000/g, "");
  }
  if (Array.isArray(value)) {
    budget.entries += value.length;
    if (budget.entries > REPOSITORY_AGENT_LIMITS.contextEntries) {
      contractViolation(source, `${label} contains too many entries`);
    }
    return value.map((entry, index) => sanitizeJsonValue(entry, `${label}[${index}]`, depth + 1, budget, source));
  }
  if (!isRecord(value)) {
    contractViolation(source, `${label} must contain JSON-compatible values`);
  }
  const entries = Object.entries(value);
  budget.entries += entries.length;
  if (budget.entries > REPOSITORY_AGENT_LIMITS.contextEntries) {
    contractViolation(source, `${label} contains too many entries`);
  }
  const output = {};
  for (const [rawKey, entry] of entries) {
    const key = rawKey.replace(/\u0000/g, "").trim();
    if (!key || key.length > 256) {
      contractViolation(source, `${label} contains an invalid key`);
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      contractViolation(source, `${label} contains an unsafe key`);
    }
    budget.chars += key.length;
    output[key] = sanitizeJsonValue(entry, `${label}.${key}`, depth + 1, budget, source);
  }
  return output;
}
function sanitizeContext(value, label = "context", source = "request") {
  if (value == null)
    return;
  if (!isRecord(value))
    contractViolation(source, `${label} must be an object`);
  return sanitizeJsonValue(value, label, 0, { entries: 0, chars: 0 }, source);
}
function sanitizeCaller(value, source) {
  if (!isRecord(value)) {
    return source === "request" ? invalidRequest("caller must be an object") : invalidResponse("caller must be an object");
  }
  const service = requiredString(value.service, "caller.service", 64, source);
  if (!CALLER_SERVICES.has(service)) {
    return source === "request" ? invalidRequest(`Unsupported caller.service: ${service}`) : invalidResponse(`Unsupported caller.service: ${service}`);
  }
  return {
    service,
    ...optionalString(value.instanceId, 256) ? { instanceId: optionalString(value.instanceId, 256) } : {},
    ...optionalString(value.sessionId, 256) ? { sessionId: optionalString(value.sessionId, 256) } : {},
    ...optionalString(value.correlationId, 256) ? { correlationId: optionalString(value.correlationId, 256) } : {}
  };
}
function sanitizeRepository(value, source) {
  if (!isRecord(value)) {
    return source === "request" ? invalidRequest("repository must be an object") : invalidResponse("repository must be an object");
  }
  if (typeof value.dirty !== "boolean") {
    return source === "request" ? invalidRequest("repository.dirty must be a boolean") : invalidResponse("repository.dirty must be a boolean");
  }
  return {
    identity: requiredString(value.identity, "repository.identity", 1024, source),
    root: requiredString(value.root, "repository.root", 4096, source),
    revision: requiredString(value.revision, "repository.revision", 512, source),
    tree: requiredString(value.tree, "repository.tree", 512, source),
    dirty: value.dirty
  };
}
function sanitizeRequest(value, source) {
  if (!isRecord(value)) {
    return source === "request" ? invalidRequest("Repository Agent request must be an object") : invalidResponse("Repository Agent request must be an object");
  }
  if (value.schemaVersion !== REPOSITORY_AGENT_SCHEMA_VERSION) {
    return source === "request" ? invalidRequest(`schemaVersion must be ${REPOSITORY_AGENT_SCHEMA_VERSION}`) : invalidResponse(`Unsupported Repository Agent schemaVersion: ${String(value.schemaVersion)}`);
  }
  const purpose = requiredString(value.purpose, "purpose", 32, source);
  const priority = requiredString(value.priority, "priority", 32, source);
  const freshness = requiredString(value.freshness, "freshness", 32, source);
  if (!PURPOSES.has(purpose)) {
    return source === "request" ? invalidRequest(`Unsupported purpose: ${purpose}`) : invalidResponse(`Unsupported purpose: ${purpose}`);
  }
  if (!PRIORITIES.has(priority)) {
    return source === "request" ? invalidRequest(`Unsupported priority: ${priority}`) : invalidResponse(`Unsupported priority: ${priority}`);
  }
  if (!FRESHNESS_VALUES.has(freshness)) {
    return source === "request" ? invalidRequest(`Unsupported freshness: ${freshness}`) : invalidResponse(`Unsupported freshness: ${freshness}`);
  }
  const deadlineAt = normalizedIso(value.deadlineAt, "deadlineAt", source);
  if (source === "request" && Date.parse(deadlineAt) <= Date.now()) {
    invalidRequest("deadlineAt must be in the future");
  }
  if (source === "request" && Date.parse(deadlineAt) - Date.now() > REPOSITORY_AGENT_LIMITS.deadlineHorizonMs) {
    invalidRequest(`deadlineAt must be no more than ${REPOSITORY_AGENT_LIMITS.deadlineHorizonMs}ms in the future`);
  }
  const context = sanitizeContext(value.context, "context", source);
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    caller: sanitizeCaller(value.caller, source),
    purpose,
    repository: sanitizeRepository(value.repository, source),
    question: requiredString(value.question, "question", REPOSITORY_AGENT_LIMITS.questionChars, source),
    ...context ? { context } : {},
    priority,
    deadlineAt,
    freshness,
    idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey", 256, source)
  };
}
function sanitizeStatus(value) {
  const status = requiredString(value, "status", 32, "response");
  if (!REQUEST_STATUSES.has(status)) {
    invalidResponse(`Unsupported Repository Agent request status: ${status}`);
  }
  return status;
}
function sanitizeEvidence(value) {
  if (!isRecord(value))
    return null;
  const path = sanitizeRelativePath(value.path, "path");
  const revision = optionalString(value.revision, 512);
  if (!path || !revision)
    return null;
  const startLine = value.startLine == null ? undefined : finiteInt(value.startLine, { min: 1, max: 1e7, fallback: 1 });
  const endLine = value.endLine == null ? undefined : finiteInt(value.endLine, {
    min: startLine ?? 1,
    max: 1e7,
    fallback: startLine ?? 1
  });
  return {
    path,
    revision,
    ...optionalString(value.blobHash, 512) ? { blobHash: optionalString(value.blobHash, 512) } : {},
    ...startLine == null ? {} : { startLine },
    ...endLine == null ? {} : { endLine },
    ...optionalString(value.excerpt, 4000) ? { excerpt: optionalString(value.excerpt, 4000) } : {},
    ...optionalString(value.rationale, 2000) ? { rationale: optionalString(value.rationale, 2000) } : {}
  };
}
function sanitizeRecommendation(value) {
  if (!isRecord(value))
    return null;
  const title = optionalString(value.title, 1000);
  const rationale = optionalString(value.rationale, 4000);
  if (!title || !rationale)
    return null;
  const priority = optionalString(value.priority, 16);
  const paths = Array.isArray(value.paths) ? value.paths.map((path) => sanitizeRelativePath(path, "path")).filter((path) => Boolean(path)).slice(0, 64) : undefined;
  return {
    title,
    rationale,
    ...priority === "high" || priority === "normal" || priority === "low" ? { priority } : {},
    ...paths?.length ? { paths } : {}
  };
}
function sanitizeValidationProposal(value) {
  if (!isRecord(value))
    return null;
  const label = optionalString(value.label, 1000);
  const rationale = optionalString(value.rationale, 4000);
  const rawCwd = optionalString(value.cwd, 1024) ?? ".";
  const cwd = rawCwd === "." ? "." : sanitizeRelativePath(rawCwd, "cwd");
  const argv = Array.isArray(value.argv) ? value.argv.filter((entry) => typeof entry === "string").map((entry) => entry.replace(/\u0000/g, "").trim()).filter(Boolean).slice(0, 64).map((entry) => entry.length <= 4096 ? entry : `${entry.slice(0, 4082)}...[truncated]`) : [];
  if (!label || !rationale || !cwd || argv.length === 0)
    return null;
  return { label, cwd, argv, rationale };
}
function sanitizeMemoryRef(value) {
  if (!isRecord(value))
    return null;
  const id = optionalString(value.id, 512);
  const namespace = optionalString(value.namespace, 256);
  const role = optionalString(value.role, 64);
  if (!id || !namespace || !MEMORY_ROLES.has(role))
    return null;
  const relevance = typeof value.relevance === "number" && Number.isFinite(value.relevance) ? Math.max(0, Math.min(1, value.relevance)) : undefined;
  return {
    id,
    namespace,
    role,
    ...optionalString(value.key, 512) ? { key: optionalString(value.key, 512) } : {},
    ...relevance == null ? {} : { relevance },
    ...optionalString(value.sourceRevision, 512) ? { sourceRevision: optionalString(value.sourceRevision, 512) } : {}
  };
}
function sanitizeRepositoryAgentResult(value, expectedRequestId) {
  if (!isRecord(value))
    invalidResponse("Repository Agent result must be an object");
  if (value.schemaVersion !== REPOSITORY_AGENT_SCHEMA_VERSION) {
    invalidResponse(`Unsupported Repository Agent result schemaVersion: ${String(value.schemaVersion)}`);
  }
  const requestId = requiredString(value.requestId, "result.requestId", 256, "response");
  if (expectedRequestId && requestId !== expectedRequestId) {
    invalidResponse(`Repository Agent result requestId does not match ${expectedRequestId}`);
  }
  if (!isRecord(value.analyzedRepository)) {
    invalidResponse("result.analyzedRepository must be an object");
  }
  const analyzedRepository = {
    identity: requiredString(value.analyzedRepository.identity, "result.analyzedRepository.identity", 1024, "response"),
    revision: requiredString(value.analyzedRepository.revision, "result.analyzedRepository.revision", 512, "response"),
    tree: requiredString(value.analyzedRepository.tree, "result.analyzedRepository.tree", 512, "response")
  };
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence))
    invalidResponse("result.confidence must be finite");
  const cacheRecord = isRecord(value.cache) ? value.cache : {};
  const completedAt = normalizedIso(value.completedAt, "result.completedAt", "response");
  const data = value.data === undefined ? undefined : sanitizeJsonValue(value.data, "result.data", 0, { entries: 0, chars: 0 }, "response");
  return {
    schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
    requestId,
    analyzedRepository,
    answer: requiredString(value.answer, "result.answer", REPOSITORY_AGENT_LIMITS.answerChars, "response"),
    summary: requiredString(value.summary, "result.summary", REPOSITORY_AGENT_LIMITS.summaryChars, "response"),
    ...data === undefined ? {} : { data },
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(0, REPOSITORY_AGENT_LIMITS.evidenceItems).map(sanitizeEvidence).filter((entry) => Boolean(entry)),
    recommendations: (Array.isArray(value.recommendations) ? value.recommendations : []).slice(0, REPOSITORY_AGENT_LIMITS.recommendationItems).map(sanitizeRecommendation).filter((entry) => Boolean(entry)),
    validationProposals: (Array.isArray(value.validationProposals) ? value.validationProposals : []).slice(0, REPOSITORY_AGENT_LIMITS.validationProposalItems).map(sanitizeValidationProposal).filter((entry) => Boolean(entry)),
    cache: {
      hit: cacheRecord.hit === true,
      key: optionalString(cacheRecord.key, 1024) ?? null,
      ...optionalString(cacheRecord.storedAt, 128) ? { storedAt: optionalString(cacheRecord.storedAt, 128) } : {},
      ...optionalString(cacheRecord.expiresAt, 128) ? { expiresAt: optionalString(cacheRecord.expiresAt, 128) } : {}
    },
    memoryRefs: (Array.isArray(value.memoryRefs) ? value.memoryRefs : []).slice(0, REPOSITORY_AGENT_LIMITS.memoryRefItems).map(sanitizeMemoryRef).filter((entry) => Boolean(entry)),
    completedAt
  };
}
function sanitizeRemoteError(value) {
  if (!isRecord(value))
    return;
  const code = optionalString(value.code, 128);
  const message = optionalString(value.message, 8000);
  if (!code || !message)
    return;
  return {
    code,
    message,
    ...optionalString(value.detail, 16000) ? { detail: optionalString(value.detail, 16000) } : {},
    retryable: value.retryable === true
  };
}
function sanitizeSnapshot(value, expectedRequestId) {
  if (!isRecord(value))
    invalidResponse("Repository Agent request snapshot must be an object");
  const requestId = requiredString(value.requestId, "requestId", 256, "response");
  if (requestId !== expectedRequestId)
    invalidResponse("Repository Agent snapshot requestId mismatch");
  const status = sanitizeStatus(value.status);
  const result = value.result == null ? undefined : sanitizeRepositoryAgentResult(value.result, requestId);
  const error = sanitizeRemoteError(value.error);
  return {
    requestId,
    status,
    submittedAt: normalizedIso(value.submittedAt, "submittedAt", "response"),
    updatedAt: normalizedIso(value.updatedAt, "updatedAt", "response"),
    ...value.pollAfterMs == null ? {} : { pollAfterMs: finiteInt(value.pollAfterMs, { min: 100, max: 30000, fallback: 1000 }) },
    ...result ? { result } : {},
    ...error ? { error } : {}
  };
}
function normalizePositiveDuration(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}
function sleepWithSignal(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new RepositoryAgentClientError("aborted", "Repository Agent call aborted"));
  }
  return new Promise((resolve2, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer)
        clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new RepositoryAgentClientError("aborted", "Repository Agent call aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class RepositoryAgentHttpClient {
  serverUrl;
  authToken;
  fetchImpl;
  requestTimeoutMs;
  pollIntervalMs;
  maxResponseBytes;
  constructor(options) {
    const rawServerUrl = requiredString(options.serverUrl, "serverUrl", 4096, "request").replace(/\/+$/, "");
    let parsedUrl;
    try {
      parsedUrl = new URL(rawServerUrl);
    } catch {
      invalidRequest("serverUrl must be an absolute HTTP URL");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      invalidRequest("serverUrl must use HTTP or HTTPS");
    }
    this.serverUrl = rawServerUrl;
    this.authToken = optionalString(options.authToken, 8192) ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = normalizePositiveDuration(options.requestTimeoutMs, 1e4, 120000);
    this.pollIntervalMs = normalizePositiveDuration(options.pollIntervalMs, 1000, 30000);
    this.maxResponseBytes = normalizePositiveDuration(options.maxResponseBytes, REPOSITORY_AGENT_LIMITS.responseBytes, 16 * 1024 * 1024);
  }
  headers() {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}
    };
  }
  async requestJson(path, init, options = {}) {
    const timeoutMs = normalizePositiveDuration(options.timeoutMs, this.requestTimeoutMs, 30 * 60000);
    try {
      const response = await fetchBufferedWithHardDeadline({
        input: `${this.serverUrl}${path}`,
        init: {
          ...init,
          headers: { ...this.headers(), ...init.headers ?? {} },
          signal: options.signal
        },
        timeoutMs,
        fetchImpl: this.fetchImpl,
        maxResponseBytes: this.maxResponseBytes,
        timeoutMessage: `Repository Agent request timed out after ${timeoutMs}ms`
      });
      const text = await response.text();
      let payload = {};
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch (cause) {
          throw new RepositoryAgentClientError("invalid_response", "Repository Agent returned malformed JSON", { status: response.status, cause });
        }
      }
      if (!isRecord(payload)) {
        throw new RepositoryAgentClientError("invalid_response", "Repository Agent response must be a JSON object", { status: response.status });
      }
      if (!response.ok) {
        const retryAfterHeaderMs = Number(response.headers.get("retry-after")) * 1000;
        const retryAfterMs = Number(payload.retryAfterMs);
        throw new RepositoryAgentClientError("http_error", optionalString(payload.message, 8000) ?? `Repository Agent request failed with HTTP ${response.status}`, {
          status: response.status,
          requestId: optionalString(payload.requestId, 256) ?? null,
          remoteCode: optionalString(payload.code, 128) ?? null,
          detail: optionalString(payload.detail, 16000) ?? null,
          retryable: typeof payload.retryable === "boolean" ? payload.retryable : response.status >= 500,
          retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.floor(retryAfterMs)) : Number.isFinite(retryAfterHeaderMs) ? Math.max(0, Math.floor(retryAfterHeaderMs)) : null
        });
      }
      if (payload.ok !== true) {
        throw new RepositoryAgentClientError("invalid_response", "Repository Agent response is missing an exact positive acknowledgement", { status: response.status });
      }
      return payload;
    } catch (error) {
      if (error instanceof RepositoryAgentClientError)
        throw error;
      if (options.signal?.aborted) {
        throw new RepositoryAgentClientError("aborted", "Repository Agent call aborted", {
          cause: error
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|timeout/i.test(message)) {
        throw new RepositoryAgentClientError("timeout", message, { cause: error });
      }
      throw new RepositoryAgentClientError("transport_error", message, { cause: error });
    }
  }
}

class RepositoryAgentClient extends RepositoryAgentHttpClient {
  callerService;
  callerInstanceId;
  askTimeoutMs;
  constructor(options) {
    super(options);
    if (!CALLER_SERVICES.has(options.callerService)) {
      invalidRequest(`Unsupported callerService: ${String(options.callerService)}`);
    }
    this.callerService = options.callerService;
    this.callerInstanceId = optionalString(options.callerInstanceId, 256);
    this.askTimeoutMs = normalizePositiveDuration(options.askTimeoutMs, 120000, 30 * 60000);
  }
  buildRequest(input) {
    const request = sanitizeRequest({
      ...input,
      schemaVersion: REPOSITORY_AGENT_SCHEMA_VERSION,
      caller: {
        ...input.caller ?? {},
        ...this.callerInstanceId ? { instanceId: this.callerInstanceId } : {},
        service: this.callerService
      }
    }, "request");
    const encoded = JSON.stringify(request);
    if (new TextEncoder().encode(encoded).byteLength > REPOSITORY_AGENT_LIMITS.requestBytes) {
      invalidRequest(`Repository Agent request exceeds ${REPOSITORY_AGENT_LIMITS.requestBytes} bytes`);
    }
    return request;
  }
  async submit(input, options = {}) {
    const request = this.buildRequest(input);
    const payload = await this.requestJson("/repository-agent/requests", { method: "POST", body: JSON.stringify(request) }, options);
    const requestId = requiredString(payload.requestId, "requestId", 256, "response");
    const status = sanitizeStatus(payload.status);
    const result = payload.result == null ? undefined : sanitizeRepositoryAgentResult(payload.result, requestId);
    return {
      requestId,
      status,
      deduplicated: payload.deduplicated === true,
      pollAfterMs: finiteInt(payload.pollAfterMs, {
        min: 100,
        max: 30000,
        fallback: this.pollIntervalMs
      }),
      ...result ? { result } : {}
    };
  }
  async get(requestIdRaw, options = {}) {
    const requestId = requiredString(requestIdRaw, "requestId", 256, "request");
    const payload = await this.requestJson(`/repository-agent/requests/${encodeURIComponent(requestId)}`, { method: "GET" }, options);
    return sanitizeSnapshot(payload.request, requestId);
  }
  async ask(input, options = {}) {
    const overallTimeoutMs = normalizePositiveDuration(options.timeoutMs, this.askTimeoutMs, 30 * 60000);
    const durableDeadlineMs = Date.parse(input.deadlineAt);
    const deadlineMs = Math.min(Date.now() + overallTimeoutMs, durableDeadlineMs);
    const remaining = () => Math.max(0, deadlineMs - Date.now());
    const callOptions = () => ({
      signal: options.signal,
      timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, remaining()))
    });
    if (remaining() <= 0)
      invalidRequest("deadlineAt must be in the future");
    const submitted = await this.submit(input, callOptions());
    if (submitted.status === "completed" && submitted.result)
      return submitted.result;
    let pollAfterMs = normalizePositiveDuration(options.pollIntervalMs ?? submitted.pollAfterMs, this.pollIntervalMs, 30000);
    while (remaining() > 0) {
      await sleepWithSignal(Math.min(pollAfterMs, remaining()), options.signal);
      if (remaining() <= 0)
        break;
      const snapshot = await this.get(submitted.requestId, callOptions());
      if (snapshot.status === "completed") {
        if (!snapshot.result) {
          invalidResponse("Completed Repository Agent request has no result");
        }
        return snapshot.result;
      }
      if (snapshot.status === "failed") {
        throw new RepositoryAgentClientError("remote_failed", snapshot.error?.message ?? "Repository Agent request failed", {
          requestId: snapshot.requestId,
          remoteCode: snapshot.error?.code ?? null,
          detail: snapshot.error?.detail ?? null,
          retryable: snapshot.error?.retryable ?? null
        });
      }
      if (snapshot.status === "cancelled") {
        throw new RepositoryAgentClientError("remote_cancelled", snapshot.error?.message ?? "Repository Agent request was cancelled", {
          requestId: snapshot.requestId,
          remoteCode: snapshot.error?.code ?? null,
          detail: snapshot.error?.detail ?? null,
          retryable: snapshot.error?.retryable ?? null
        });
      }
      if (snapshot.status === "expired") {
        throw new RepositoryAgentClientError("remote_expired", snapshot.error?.message ?? "Repository Agent request expired", {
          requestId: snapshot.requestId,
          remoteCode: snapshot.error?.code ?? null,
          detail: snapshot.error?.detail ?? null,
          retryable: snapshot.error?.retryable ?? null
        });
      }
      pollAfterMs = normalizePositiveDuration(options.pollIntervalMs ?? snapshot.pollAfterMs, pollAfterMs, 30000);
    }
    throw new RepositoryAgentClientError("timeout", `Repository Agent request ${submitted.requestId} did not complete before the caller deadline`, { requestId: submitted.requestId });
  }
}
function createRepositoryAgentServiceClients(options) {
  const repositoryAgent = options.repositoryAgent ?? new RepositoryAgentClient({
    serverUrl: options.serverUrl,
    callerService: options.callerService,
    callerInstanceId: options.callerInstanceId,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
    askTimeoutMs: options.askTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    maxResponseBytes: options.maxResponseBytes
  });
  const ownsMemoryStore = options.memoryStore === undefined;
  const memoryStore = options.memoryStore ?? new MemoryHttpClient({
    serverUrl: options.serverUrl,
    authToken: options.authToken,
    callerService: options.callerService,
    authority: options.memoryAuthority,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.memoryTimeoutMs,
    maxResponseBytes: options.memoryMaxResponseBytes
  });
  let closePromise = null;
  return Object.freeze({
    repositoryAgent,
    memoryStore,
    close() {
      if (!closePromise) {
        closePromise = ownsMemoryStore ? memoryStore.close() : Promise.resolve();
      }
      return closePromise;
    }
  });
}

// packages/shared/src/scm_repair_authority.ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync as readFileSync2,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { join as join2, resolve as resolve2 } from "path";
var SCM_REPAIR_AUTHORITY_HEADER = "x-pushpals-scm-repair-authority";
var SCM_REPAIR_AUTHORITY_SECRET_ENV = "PUSHPALS_SCM_REPAIR_AUTHORITY_SECRET";
var SCM_REPAIR_AUTHORITY_VERSION = "v1";
var SCM_REPAIR_AUTHORITY_MAX_AGE_MS = 2 * 60000;
var SCM_REPAIR_AUTHORITY_MIN_SECRET_CHARS = 32;
var SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS = 5000;
var SCM_REPAIR_AUTHORITY_INVALID_STABILITY_MS = 2000;
var SCM_REPAIR_AUTHORITY_CREATE_RETRY_MIN_DELAY_MS = 10;
var SCM_REPAIR_AUTHORITY_CREATE_RETRY_MAX_DELAY_MS = 100;
var SCM_REPAIR_AUTHORITY_RETRYABLE_IO_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EEXIST",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "EPERM",
  "ETXTBSY"
]);
var SCM_REPAIR_AUTHORITY_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));
function normalizeAuthoritySecret(value) {
  const secret = String(value ?? "").trim();
  if (secret.length < SCM_REPAIR_AUTHORITY_MIN_SECRET_CHARS)
    return "";
  return secret;
}
function filesystemErrorCode(error) {
  return String(error?.code ?? "").toUpperCase();
}
function isRetryableAuthorityIoError(error) {
  return SCM_REPAIR_AUTHORITY_RETRYABLE_IO_CODES.has(filesystemErrorCode(error));
}
function waitForAuthorityCreationRetry(delayMs) {
  Atomics.wait(SCM_REPAIR_AUTHORITY_RETRY_WAIT, 0, 0, Math.max(1, Math.floor(delayMs)));
}
function scrubScmRepairAuthoritySecretFromEnv(env) {
  const target = SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target)
      delete env[key];
  }
}
function copyEnvWithoutScmRepairAuthoritySecret(env = process.env) {
  const copy = {};
  const target = SCM_REPAIR_AUTHORITY_SECRET_ENV.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === target || typeof value !== "string")
      continue;
    copy[key] = value;
  }
  return copy;
}
function canonicalJson(value) {
  if (value === null)
    return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value;
    const entries = Object.keys(record).filter((key) => record[key] !== undefined).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}
function authorityMessage(body, issuedAtMs, nonce) {
  return `${SCM_REPAIR_AUTHORITY_VERSION}
${issuedAtMs}
${nonce}
${canonicalJson(body)}`;
}
function authoritySignature(body, secret, issuedAtMs, nonce) {
  return createHmac("sha256", secret).update(authorityMessage(body, issuedAtMs, nonce), "utf8").digest("base64url");
}
function resolveScmRepairAuthoritySecret(options) {
  const env = options.env ?? process.env;
  const configured = String(env[SCM_REPAIR_AUTHORITY_SECRET_ENV] ?? "").trim();
  if (configured) {
    const valid = normalizeAuthoritySecret(configured);
    if (!valid) {
      throw new Error(`${SCM_REPAIR_AUTHORITY_SECRET_ENV} must contain at least 32 characters`);
    }
    return valid;
  }
  const authorityDir = resolve2(options.dataDir, "control-plane");
  const secretPath = join2(authorityDir, "scm-repair-authority.key");
  mkdirSync(authorityDir, { recursive: true, mode: 448 });
  let lastRetryableIssue = `SCM repair authority key at ${secretPath} was not ready`;
  const inspectExisting = () => {
    try {
      const raw = readFileSync2(secretPath, "utf8");
      const existing = normalizeAuthoritySecret(raw);
      if (existing)
        return { state: "valid", secret: existing };
      const stats = statSync(secretPath);
      lastRetryableIssue = `SCM repair authority key at ${secretPath} was incomplete`;
      return {
        state: "invalid",
        fingerprint: `${stats.size}:${Math.floor(stats.mtimeMs)}:${raw}`
      };
    } catch (error) {
      if (!isRetryableAuthorityIoError(error))
        throw error;
      const code = filesystemErrorCode(error);
      lastRetryableIssue = `SCM repair authority key at ${secretPath} was not readable${code ? ` (${code})` : ""}`;
      return code === "ENOENT" ? { state: "missing" } : { state: "transient", code };
    }
  };
  const initial = inspectExisting();
  if (initial.state === "valid")
    return initial.secret;
  const generated = randomBytes(32).toString("base64url");
  const temporaryPath = join2(authorityDir, `.scm-repair-authority.${process.pid}.${randomBytes(9).toString("hex")}.tmp`);
  writeFileSync(temporaryPath, `${generated}
`, {
    encoding: "utf8",
    flag: "wx",
    mode: 384
  });
  const retryDeadlineMs = Date.now() + SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS;
  let retryCount = 0;
  let stableInvalidFingerprint = "";
  let stableInvalidSinceMs = 0;
  try {
    while (true) {
      const nowMs = Date.now();
      const existing = inspectExisting();
      if (existing.state === "valid")
        return existing.secret;
      if (existing.state === "invalid") {
        if (existing.fingerprint !== stableInvalidFingerprint) {
          stableInvalidFingerprint = existing.fingerprint;
          stableInvalidSinceMs = nowMs;
        } else if (nowMs - stableInvalidSinceMs >= SCM_REPAIR_AUTHORITY_INVALID_STABILITY_MS) {
          const confirmed = inspectExisting();
          if (confirmed.state === "invalid" && confirmed.fingerprint === stableInvalidFingerprint) {
            try {
              unlinkSync(secretPath);
              stableInvalidFingerprint = "";
              stableInvalidSinceMs = 0;
              continue;
            } catch (error) {
              if (!isRetryableAuthorityIoError(error))
                throw error;
            }
          }
        }
      } else {
        stableInvalidFingerprint = "";
        stableInvalidSinceMs = 0;
      }
      if (existing.state === "missing") {
        try {
          linkSync(temporaryPath, secretPath);
          try {
            chmodSync(secretPath, 384);
          } catch {}
          return generated;
        } catch (error) {
          if (!isRetryableAuthorityIoError(error))
            throw error;
          const code = filesystemErrorCode(error);
          lastRetryableIssue = `SCM repair authority key creation at ${secretPath} is still in progress${code ? ` (${code})` : ""}`;
        }
      }
      const remainingMs = retryDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`${lastRetryableIssue}; timed out after ${SCM_REPAIR_AUTHORITY_CREATE_RETRY_MS}ms waiting for a concurrent first-start writer`);
      }
      retryCount += 1;
      const delayMs = Math.min(remainingMs, SCM_REPAIR_AUTHORITY_CREATE_RETRY_MAX_DELAY_MS, SCM_REPAIR_AUTHORITY_CREATE_RETRY_MIN_DELAY_MS * retryCount);
      waitForAuthorityCreationRetry(delayMs);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {}
  }
}
function createScmRepairAuthorityProof(body, secret, options = {}) {
  const normalizedSecret = normalizeAuthoritySecret(secret);
  if (!normalizedSecret)
    throw new Error("SCM repair authority secret must contain 32 characters");
  const issuedAtMs = Math.floor(options.nowMs ?? Date.now());
  const nonce = String(options.nonce ?? randomBytes(18).toString("base64url")).trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error("SCM repair authority nonce is invalid");
  }
  const signature = authoritySignature(body, normalizedSecret, issuedAtMs, nonce);
  return `${SCM_REPAIR_AUTHORITY_VERSION}.${issuedAtMs}.${nonce}.${signature}`;
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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, unlinkSync as unlinkSync2, readFileSync as readFileSync3 } from "fs";
import { join as join3 } from "path";

class FileLock {
  lockPath;
  held = false;
  constructor(stateDir) {
    mkdirSync2(stateDir, { recursive: true });
    this.lockPath = join3(stateDir, "merge_queue.lock");
  }
  acquire() {
    if (this.held)
      return true;
    if (existsSync2(this.lockPath)) {
      try {
        const contents = readFileSync3(this.lockPath, "utf-8");
        const parsed = JSON.parse(contents);
        const pid = parsed.pid;
        if (isProcessAlive(pid)) {
          return false;
        }
        unlinkSync2(this.lockPath);
      } catch {
        try {
          unlinkSync2(this.lockPath);
        } catch {}
      }
    }
    const lockData = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    });
    try {
      writeFileSync2(this.lockPath, lockData, { flag: "wx" });
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
      unlinkSync2(this.lockPath);
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
import { resolve as resolve6, win32 as pathWin32 } from "path";

// packages/shared/src/repo.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, statSync as statSync2 } from "fs";
import { resolve as resolve3 } from "path";
function resolveDotGitEntry(repoRoot) {
  return resolve3(repoRoot, ".git");
}
function findGitRepoRoot(startDir) {
  const override = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? "").trim();
  if (override) {
    const resolvedOverride = resolve3(override);
    if (resolveGitMetadataDir(resolvedOverride)) {
      return resolvedOverride;
    }
    console.warn(`[repo] PUSHPALS_REPO_ROOT_OVERRIDE does not point to a git repository: ${resolvedOverride}`);
  }
  let current = resolve3(startDir);
  const root = resolve3(current, "/");
  while (current !== root) {
    if (resolveGitMetadataDir(current)) {
      return current;
    }
    current = resolve3(current, "..");
  }
  return resolveGitMetadataDir(root) ? root : null;
}
function resolveGitMetadataDir(repoRoot) {
  const dotGitPath = resolveDotGitEntry(repoRoot);
  if (!existsSync3(dotGitPath))
    return null;
  try {
    const stat = statSync2(dotGitPath);
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
    const firstLine = readFileSync4(dotGitPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match)
      return null;
    const gitDir = resolve3(repoRoot, match[1].trim());
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
// packages/shared/src/repository_snapshot.ts
var DEFAULT_DIFF_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
var MAX_DIFF_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
var SMALL_GIT_OUTPUT_LIMIT_BYTES = 256 * 1024;
var MAX_HASH_PATH_ARGUMENT_BYTES = 16 * 1024;
// packages/shared/src/prompts.ts
import { readFileSync as readFileSync5 } from "fs";
import { join as join4, resolve as resolve4 } from "path";
var TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
var promptTemplateCache = new Map;
var repoDocCache = new Map;
function resolvePromptPath(relativePath) {
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const repoRoot = promptRootOverride ? resolve4(promptRootOverride) : detectRepoRoot(process.cwd());
  return join4(repoRoot, "prompts", relativePath);
}
function loadPromptTemplate(relativePath, replacements) {
  const promptPath = resolvePromptPath(relativePath);
  let template = promptTemplateCache.get(promptPath);
  if (template === undefined) {
    template = readFileSync5(promptPath, "utf8");
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
// packages/shared/src/repo_validation.ts
import { closeSync, existsSync as existsSync4, openSync, readSync, readdirSync } from "fs";
import { basename, dirname, extname, relative, resolve as resolve5 } from "path";

// packages/shared/src/trusted_validation.ts
var MAX_TRUSTED_VALIDATION_COMMANDS = 8;
var MAX_TRUSTED_VALIDATION_COMMAND_LENGTH = 1000;
var TRUSTED_VALIDATION_EXECUTABLES = new Set([
  "bazel",
  "bun",
  "bunx",
  "buf",
  "bundle",
  "cabal",
  "cargo",
  "clojure",
  "cmake",
  "coverage",
  "ctest",
  "dart",
  "deno",
  "docker",
  "docker-compose",
  "dotnet",
  "eslint",
  "flutter",
  "git",
  "go",
  "gradle",
  "jest",
  "lein",
  "make",
  "mix",
  "mvn",
  "mypy",
  "node",
  "npm",
  "npx",
  "pnpm",
  "composer",
  "php",
  "pytest",
  "python",
  "python3",
  "ruff",
  "rscript",
  "ruby",
  "stack",
  "swift",
  "terraform",
  "tsc",
  "uv",
  "vitest",
  "zig",
  "luac",
  "yarn"
]);
var ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
var TEST_DURATION_SUFFIX_RE = /\s+\[(?:\d+(?:\.\d+)?)(?:ms|s)\]\s*$/i;
var FAILURE_LINE_RE = /(?:^|\s)(?:error|fail(?:ed|ure)?|fatal|panic|panicked|timed?\s*out|timeout|expected|received|assert(?:ion|ionerror)?)(?:\b|:)/i;
var PASS_LINE_RE = /^(?:\(pass\)|PASS\b|\u2713\s|\u2714\s|Tests?\s+\d+\s+passed\b)/i;
function uniqueSorted(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function normalizeEvidencePath(value) {
  let normalized = value.trim().replace(/^['"`]|['"`]$/g, "").replace(/\\/g, "/");
  normalized = normalized.replace(/:\d+(?::\d+)?$/, "").replace(/:\s*$/, "");
  normalized = normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.includes("node_modules/"))
    return null;
  if (!/\.[a-z0-9]+$/i.test(normalized))
    return null;
  return normalized;
}
function normalizeTrustedValidationFingerprintLine(value) {
  return value.replace(ANSI_ESCAPE_RE, "").trim().replace(/\\/g, "/").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>").replace(/\b(?:job|req|request|completion|crash|task|run)_[a-z0-9][a-z0-9_-]{5,}\b/gi, (match) => `${match.slice(0, match.indexOf("_") + 1)}<id>`).replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi, "<timestamp>").replace(TEST_DURATION_SUFFIX_RE, "").replace(/\b[0-9a-f]{40,64}\b/gi, "<sha>").replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, "<duration>").replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/gi, "$1:<port>").replace(/\bport\s*[:=#]?\s*\d{2,5}\b/gi, "port <port>").replace(/\b(pid|process(?:\s+id)?)\s*[:=#]?\s*\d+\b/gi, "$1 <pid>").replace(/(\.[a-z][a-z0-9]{0,7}):\d+:\d+\b/gi, "$1:<line>:<column>").replace(/(\.[a-z][a-z0-9]{0,7}):\d+\b/gi, "$1:<line>").replace(/\(\d+,\d+\)/g, "(<line>,<column>)").replace(/(?:[a-z]:)?\/(?:users\/[^/\s]+\/appdata\/local\/temp|tmp|var\/tmp)\/[^\s'"`]+/gi, "<temp-path>").replace(/(?:[a-z]:)?\/[^\s'"`]*?\.pushpals\/(?:runtime\/)?worktrees?\/[^/\s'"`]+/gi, "<worktree>").replace(/(?:[a-z]:)?\/[^\s'"`]*?\/\.worktrees\/[^/\s'"`]+/gi, "<worktree>").replace(/\s+/g, " ").slice(0, 1000);
}
function normalizeFailureLine(value) {
  return normalizeTrustedValidationFingerprintLine(value);
}
function failureNeighborhoodLines(output, radius = 2) {
  const lines = output.replace(ANSI_ESCAPE_RE, "").split(/\r?\n/);
  const selected = new Set;
  for (let index = 0;index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || PASS_LINE_RE.test(line) || !FAILURE_LINE_RE.test(line))
      continue;
    for (let candidate = Math.max(0, index - radius);candidate <= Math.min(lines.length - 1, index + radius); candidate += 1) {
      if (lines[candidate]?.trim())
        selected.add(candidate);
    }
  }
  return [...selected].sort((a, b) => a - b).map((index) => lines[index]?.trim() ?? "").filter(Boolean);
}
function extractTrustedValidationFailureEvidence(options) {
  const command = String(options.command ?? "").trim().toLowerCase();
  const output = String(options.output ?? "").replace(ANSI_ESCAPE_RE, "");
  const failedTests = [];
  const targetPathHints = [];
  const failureLines = [];
  let currentTestPath = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line)
      continue;
    const bunPath = line.match(/^(.+\.(?:test|spec|vitest)\.[cm]?[jt]sx?):\s*$/i)?.[1];
    const suitePath = line.match(/^(?:FAIL|failed)\s+(.+\.(?:test|spec|vitest)\.[cm]?[jt]sx?)(?:\s|$)/i)?.[1];
    const diagnosticPath = line.match(/^([^:(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s+error\b/i)?.[1];
    const pytestFailure = line.match(/^FAILED\s+(.+?\.py)::([^\s]+)(?:\s+-\s+|$)/i);
    const portableDiagnosticPath = line.match(/^(.+?\.(?:py|go|rs)):\d+(?::\d+)?:/i)?.[1];
    const cargoPanic = line.match(/^thread\s+['"]([^'"]+)['"]\s+panicked\s+at\s+(.+?\.rs):\d+(?::\d+)?:/i);
    const bunContextPath = normalizeEvidencePath(bunPath ?? "");
    if (bunContextPath)
      currentTestPath = bunContextPath;
    const failingPath = normalizeEvidencePath(suitePath ?? pytestFailure?.[1] ?? cargoPanic?.[2] ?? diagnosticPath ?? portableDiagnosticPath ?? "");
    if (failingPath) {
      currentTestPath = failingPath;
      targetPathHints.push(failingPath);
    }
    const bunFailure = line.match(/^\(fail\)\s+(.+)$/i)?.[1];
    const jestFailure = line.match(/^[\u2715\u2717]\s+(.+)$/)?.[1];
    const vitestFailure = line.match(/^FAIL\s+.+?\.(?:test|spec|vitest)\.[cm]?[jt]sx?\s*>\s*(.+)$/i)?.[1];
    const jestSuiteFailure = line.match(/^\u25cf\s+(.+)$/)?.[1];
    const goFailure = line.match(/^---\s+FAIL:\s+([^\s(]+)(?:\s+\(|$)/i)?.[1];
    const cargoStdoutFailure = line.match(/^----\s+(.+?)\s+stdout\s+----$/i)?.[1];
    const cargoTestFailure = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED$/i)?.[1];
    const namedFailure = (bunFailure ?? jestFailure ?? vitestFailure ?? jestSuiteFailure ?? pytestFailure?.[2] ?? goFailure ?? cargoStdoutFailure ?? cargoTestFailure ?? cargoPanic?.[1] ?? "").replace(TEST_DURATION_SUFFIX_RE, "").trim();
    if (namedFailure) {
      failedTests.push(namedFailure);
      if (currentTestPath)
        targetPathHints.push(currentTestPath);
    }
    if (!PASS_LINE_RE.test(line) && (Boolean(namedFailure) || Boolean(failingPath) || FAILURE_LINE_RE.test(line))) {
      failureLines.push(normalizeFailureLine(line));
    }
  }
  let failureClass;
  if (options.phase === "dependency_install") {
    failureClass = "dependency_setup_failed";
  } else if (options.exitCode === 124) {
    failureClass = "timeout";
  } else if (failedTests.length > 0) {
    failureClass = "test_failure";
  } else if (/timed?\s*out|timeout/i.test(output)) {
    failureClass = "timeout";
  } else if (/(?:^|\s)(?:test|pytest|jest|vitest)(?:\s|$)/i.test(command)) {
    failureClass = "test_failure";
  } else if (/\b(?:tsc|typecheck|type-check)\b/i.test(command)) {
    failureClass = "typecheck_failure";
  } else if (/\b(?:eslint|lint|ruff)\b/i.test(command)) {
    failureClass = "lint_failure";
  } else {
    failureClass = "trusted_validation_failed";
  }
  return {
    failureClass,
    failedTests: uniqueSorted(failedTests),
    targetPathHints: uniqueSorted(targetPathHints),
    failureLines: uniqueSorted(failureLines).slice(0, 20)
  };
}
function truncateTrustedValidationOutput(output, maxChars = 16000) {
  const text = String(output ?? "");
  const boundedMax = Math.max(1000, Math.floor(maxChars));
  if (text.length <= boundedMax)
    return text;
  const headChars = Math.min(3000, Math.floor(boundedMax / 4));
  const failureContext = failureNeighborhoodLines(text).join(`
`).slice(0, Math.max(2000, Math.floor(boundedMax / 2)));
  const remaining = Math.max(1000, boundedMax - headChars - failureContext.length - 100);
  return [
    text.slice(0, headChars),
    "... trusted validation output truncated ...",
    failureContext ? `Failure context:
${failureContext}` : "",
    text.slice(-remaining)
  ].filter(Boolean).join(`
`).slice(0, boundedMax);
}
function isSafeRelativeValidationPath(value, allowDot = false) {
  const normalized = String(value ?? "").replace(/\\/g, "/");
  const pathSegments = normalized.replace(/^\.\//, "").split("/");
  if (allowDot && normalized === ".")
    return true;
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("://") || pathSegments.some((segment) => segment === ".." || [".git", ".pushpals", ".worktrees", "node_modules"].includes(segment.toLowerCase())) || normalized.startsWith("-") && !normalized.startsWith("./-")) {
    return false;
  }
  return /^[\p{L}\p{N}_@+.,()[\]/ -]+$/u.test(normalized);
}
function isSafeTestSourcePath(value, extensions) {
  if (!isSafeRelativeValidationPath(value))
    return false;
  const normalized = value.toLowerCase().replace(/^\.\//, "");
  if (/(^|\/)(?:tests?|specs?|integration_test)$/.test(normalized))
    return true;
  return extensions.some((extension) => normalized.endsWith(extension)) && /(^|\/)(?:tests?|specs?|integration_test)(\/|$)|_(?:test|spec)\.[^/]+$/.test(normalized);
}
function expectedCmakeBuildPath(sourcePath) {
  return sourcePath === "." ? "build" : `${sourcePath.replace(/\/$/, "")}/build`;
}
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
  if (executable === "ruby" && (firstArg !== "-c" || argv.length !== 3 || !isSafeRelativeValidationPath(argv[2] ?? "") || !argv[2]?.toLowerCase().endsWith(".rb"))) {
    return null;
  }
  if (executable === "php" && (firstArg !== "-l" || argv.length !== 3 || !isSafeRelativeValidationPath(argv[2] ?? "") || !argv[2]?.toLowerCase().endsWith(".php"))) {
    return null;
  }
  if (executable === "dotnet" && !(firstArg === "test" && (argv.length === 2 || argv.length === 3 && isSafeRelativeValidationPath(argv[2] ?? "") && /\.(?:sln|csproj|fsproj)$/i.test(argv[2] ?? "")))) {
    return null;
  }
  if (executable === "bundle" && !(firstArg === "exec" && (argv[2]?.toLowerCase() === "rspec" || argv[2]?.toLowerCase() === "rake" && argv.length === 4 && argv[3]?.toLowerCase() === "test"))) {
    return null;
  }
  if (executable === "bundle" && argv[2]?.toLowerCase() === "rspec" && (argv.length > 7 || argv.slice(3).some((path) => !isSafeTestSourcePath(path, [".rb"])))) {
    return null;
  }
  const trailingTest = argv[argv.length - 1]?.toLowerCase() === "test";
  const safeComposer = argv.length === 2 && firstArg === "test" || argv.length === 3 && firstArg === "run" && argv[2]?.toLowerCase() === "test" || argv.length === 4 && firstArg === "--working-dir" && trailingTest || argv.length === 3 && firstArg.startsWith("--working-dir=") && trailingTest;
  if (executable === "composer" && (!safeComposer || firstArg === "--working-dir" && !isSafeRelativeValidationPath(argv[2] ?? "") || firstArg.startsWith("--working-dir=") && !isSafeRelativeValidationPath(argv[1]?.slice("--working-dir=".length) ?? ""))) {
    return null;
  }
  const safeMavenOrGradle = argv.length === 2 && trailingTest || argv.length === 4 && ["-f", "--file", "-p", "--project-dir"].includes(firstArg) && trailingTest;
  if (["mvn", "gradle"].includes(executable) && !safeMavenOrGradle) {
    return null;
  }
  if (["mvn", "gradle"].includes(executable) && argv.length === 4 && (!isSafeRelativeValidationPath(argv[2] ?? "") || executable === "mvn" && !argv[2]?.toLowerCase().endsWith("pom.xml"))) {
    return null;
  }
  if (executable === "git" && !(argv.length === 3 && firstArg === "diff" && argv[2]?.toLowerCase() === "--check")) {
    return null;
  }
  if (executable === "cmake") {
    const safeConfigure = argv.length === 5 && firstArg === "-s" && argv[3]?.toLowerCase() === "-b" && isSafeRelativeValidationPath(argv[2] ?? "", true) && isSafeRelativeValidationPath(argv[4] ?? "") && argv[4] === expectedCmakeBuildPath(argv[2] ?? "");
    const safeBuild = argv.length === 3 && firstArg === "--build" && isSafeRelativeValidationPath(argv[2] ?? "") && /(^|\/)build$/.test(argv[2] ?? "");
    if (!safeConfigure && !safeBuild)
      return null;
  }
  if (executable === "ctest" && !(argv.length === 4 && firstArg === "--test-dir" && isSafeRelativeValidationPath(argv[2] ?? "") && /(^|\/)build$/.test(argv[2] ?? "") && argv[3]?.toLowerCase() === "--output-on-failure")) {
    return null;
  }
  if (executable === "make" && !(argv.length === 2 && ["test", "check"].includes(firstArg) || argv.length === 4 && firstArg === "-c" && isSafeRelativeValidationPath(argv[2] ?? "") && ["test", "check"].includes(argv[3]?.toLowerCase() ?? ""))) {
    return null;
  }
  if (executable === "bazel" && !(argv.length === 3 && firstArg === "test" && /^\/\/[A-Za-z0-9_@+.,/-]*\.\.\.$/.test(argv[2] ?? ""))) {
    return null;
  }
  if (executable === "buf" && !(firstArg === "lint" && (argv.length === 2 || argv.length === 3 && isSafeRelativeValidationPath(argv[2] ?? "")))) {
    return null;
  }
  if (executable === "swift" && !(argv.length === 2 && firstArg === "test" || argv.length === 4 && firstArg === "test" && argv[2]?.toLowerCase() === "--package-path" && isSafeRelativeValidationPath(argv[3] ?? ""))) {
    return null;
  }
  if (["dart", "flutter"].includes(executable)) {
    const safeDartDirectoryTest = executable === "dart" && firstArg === "--directory" && argv.length === 4 && isSafeRelativeValidationPath(argv[2] ?? "") && argv[3]?.toLowerCase() === "test";
    if (!safeDartDirectoryTest && (firstArg !== "test" || argv.length > 6 || argv.slice(2).some((path) => !isSafeTestSourcePath(path, [".dart"])))) {
      return null;
    }
  }
  if (executable === "mix" && !(firstArg === "test" && argv.length <= 6 && argv.slice(2).every((path) => isSafeTestSourcePath(path, [".exs"])) || firstArg === "--cd" && argv.length === 4 && isSafeRelativeValidationPath(argv[2] ?? "") && argv[3]?.toLowerCase() === "test")) {
    return null;
  }
  if (executable === "cabal" && !(argv.length === 3 && firstArg === "test" && argv[2]?.toLowerCase() === "all")) {
    return null;
  }
  if (executable === "stack" && !(argv.length === 2 && firstArg === "test" || argv.length === 4 && firstArg === "--stack-yaml" && isSafeRelativeValidationPath(argv[2] ?? "") && argv[2]?.toLowerCase().endsWith("/stack.yaml") && argv[3]?.toLowerCase() === "test")) {
    return null;
  }
  if (executable === "clojure" && !(argv.length === 2 && ["-x:test", "-m:test"].includes(firstArg))) {
    return null;
  }
  if (executable === "lein" && !(argv.length === 2 && firstArg === "test"))
    return null;
  if (executable === "zig" && !(argv.length === 3 && firstArg === "build" && argv[2]?.toLowerCase() === "test" || argv.length === 5 && firstArg === "build" && argv[2]?.toLowerCase() === "--build-file" && isSafeRelativeValidationPath(argv[3] ?? "") && argv[3]?.toLowerCase().endsWith("/build.zig") && argv[4]?.toLowerCase() === "test")) {
    return null;
  }
  if (executable === "terraform" && !(firstArg === "fmt" && argv[2]?.toLowerCase() === "-check" && argv.length >= 4 && argv.length <= 7 && argv.slice(3).every((path) => isSafeRelativeValidationPath(path) && /\.(?:tf|tfvars)$/i.test(path)))) {
    return null;
  }
  if (executable === "luac") {
    if (firstArg !== "-p" || argv.length !== 3 || !isSafeRelativeValidationPath(argv[2] ?? "") || !argv[2]?.toLowerCase().endsWith(".lua")) {
      return null;
    }
  }
  if (executable === "rscript") {
    const expression = argv.length === 3 && firstArg === "-e" ? argv[2] ?? "" : "";
    const parsedPath = expression.match(/^parse\(file='([^']+)'\)$/)?.[1] ?? "";
    if (!parsedPath || !isSafeRelativeValidationPath(parsedPath) || !parsedPath.toLowerCase().endsWith(".r")) {
      return null;
    }
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

// packages/shared/src/repo_validation.ts
var FALLBACK_VALIDATION_STEP = "git diff --check";
var MAX_JSON_BYTES = 1e6;
var MAX_PROJECT_EVIDENCE_BYTES = 256000;
function normalizeRepoPath(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "").trim();
  if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "..") || !/^[\p{L}\p{N}_@+.,()[\]/ -]+$/u.test(normalized)) {
    return "";
  }
  return normalized;
}
function commandPathArg(value, prefixRelative = false) {
  const normalized = normalizeRepoPath(value);
  if (!normalized)
    return "";
  const optionSafe = normalized.startsWith("-") ? `./${normalized}` : prefixRelative && !normalized.startsWith("./") ? `./${normalized}` : normalized;
  return /\s/.test(optionSafe) ? `"${optionSafe}"` : optionSafe;
}
function dedupeCompletePlans(plans, maxItems) {
  const out = [];
  const seen = new Set;
  for (const plan of plans) {
    const pending = [];
    for (const rawValue of plan) {
      const value = String(rawValue ?? "").trim();
      if (!value)
        continue;
      const key = value.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key) || pending.some((entry) => entry.key === key))
        continue;
      pending.push({ value, key });
    }
    if (out.length + pending.length > maxItems)
      continue;
    for (const entry of pending) {
      seen.add(entry.key);
      out.push(entry.value);
    }
  }
  return out;
}
function readTextBounded(path, maxBytes = MAX_PROJECT_EVIDENCE_BYTES) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0)
        break;
      bytesRead += count;
    }
    return {
      text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
      truncated: bytesRead > maxBytes
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
function readJson(path) {
  const read = readTextBounded(path, MAX_JSON_BYTES);
  if (!read || read.truncated)
    return null;
  try {
    const parsed = JSON.parse(read.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function ecosystemForPath(path) {
  const filename = basename(path).toLowerCase();
  const extension = extname(path).toLowerCase();
  if (filename === "package.json" || ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"].includes(filename)) {
    return "package";
  }
  if (["pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", "tox.ini"].includes(filename) || /^requirements(?:-[^.]+)?\.txt$/.test(filename)) {
    return "python";
  }
  if (filename === "go.mod" || filename === "go.sum")
    return "go";
  if (filename === "cargo.toml" || filename === "cargo.lock")
    return "rust";
  if ([
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts"
  ].includes(filename)) {
    return "jvm";
  }
  if (/\.(?:sln|csproj|fsproj)$/i.test(filename))
    return "dotnet";
  if (["gemfile", "rakefile", ".rspec"].includes(filename))
    return "ruby";
  if (filename === "composer.json" || filename === "composer.lock")
    return "php";
  if (filename === "cmakelists.txt" || ["makefile", "gnumakefile"].includes(filename) || ["build", "build.bazel", "module.bazel", "workspace", "workspace.bazel"].includes(filename)) {
    return "native";
  }
  if (["buf.yaml", "buf.work.yaml", "buf.gen.yaml", "buf.lock"].includes(filename)) {
    return "protobuf";
  }
  if (filename === "package.swift" || filename === "package.resolved")
    return "swift";
  if (["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"].includes(filename))
    return "dart";
  if (filename === "mix.exs" || filename === "mix.lock")
    return "elixir";
  if (filename === "cabal.project" || filename === "cabal.project.local" || filename === "stack.yaml" || extension === ".cabal") {
    return "haskell";
  }
  if (["deps.edn", "project.clj", "build.clj"].includes(filename))
    return "clojure";
  if (["build.zig", "build.zig.zon"].includes(filename))
    return "zig";
  if (filename === ".terraform.lock.hcl")
    return "terraform";
  if ([
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".svelte",
    ".css",
    ".scss",
    ".less",
    ".html",
    ".htm"
  ].includes(extension)) {
    return "package";
  }
  if (extension === ".py")
    return "python";
  if (extension === ".go")
    return "go";
  if (extension === ".rs")
    return "rust";
  if ([".java", ".kt", ".kts", ".scala"].includes(extension))
    return "jvm";
  if ([".cs", ".fs", ".fsx"].includes(extension))
    return "dotnet";
  if (extension === ".rb")
    return "ruby";
  if (extension === ".php")
    return "php";
  if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(extension)) {
    return "native";
  }
  if (extension === ".proto")
    return "protobuf";
  if (extension === ".swift")
    return "swift";
  if (extension === ".dart")
    return "dart";
  if ([".ex", ".exs"].includes(extension))
    return "elixir";
  if ([".hs", ".lhs"].includes(extension))
    return "haskell";
  if ([".clj", ".cljs", ".cljc", ".edn"].includes(extension))
    return "clojure";
  if (extension === ".zig")
    return "zig";
  if ([".tf", ".tfvars"].includes(extension))
    return "terraform";
  if (extension === ".r")
    return "r";
  if (extension === ".lua")
    return "lua";
  return null;
}
function pathsByEcosystem(paths) {
  const grouped = new Map;
  for (const path of paths) {
    const ecosystem = ecosystemForPath(path);
    if (!ecosystem)
      continue;
    const existing = grouped.get(ecosystem);
    if (existing)
      existing.push(path);
    else
      grouped.set(ecosystem, [path]);
  }
  return [...grouped.entries()].map(([ecosystem, ecosystemPaths]) => ({
    ecosystem,
    paths: ecosystemPaths
  }));
}
function validationSearchDirectories(paths) {
  const out = [];
  const seen = new Set;
  const add = (directory) => {
    const normalized = directory === "." ? "" : normalizeRepoPath(directory);
    if (directory && directory !== "." && !normalized)
      return;
    if (seen.has(normalized))
      return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const path of paths) {
    let directory = dirname(path).replace(/\\/g, "/");
    while (directory && directory !== ".") {
      add(directory);
      const parent = dirname(directory).replace(/\\/g, "/");
      if (parent === directory)
        break;
      directory = parent;
    }
  }
  add("");
  return out;
}
function packageManagerAt(directory) {
  const manifest = readJson(resolve5(directory, "package.json"));
  const declared = String(manifest?.packageManager ?? "").trim().split("@")[0]?.toLowerCase();
  if (["bun", "pnpm", "yarn", "npm"].includes(declared)) {
    return declared;
  }
  if (existsSync4(resolve5(directory, "bun.lock")) || existsSync4(resolve5(directory, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync4(resolve5(directory, "pnpm-lock.yaml")))
    return "pnpm";
  if (existsSync4(resolve5(directory, "yarn.lock")))
    return "yarn";
  if (existsSync4(resolve5(directory, "package-lock.json")))
    return "npm";
  return null;
}
function resolvePackageManager(repoRoot, manifestDirectory) {
  const absoluteRoot = resolve5(repoRoot);
  let cursor = resolve5(manifestDirectory);
  while (true) {
    const manager = packageManagerAt(cursor);
    if (manager)
      return manager;
    if (cursor === absoluteRoot)
      break;
    const parent = dirname(cursor);
    const relativeParent = relative(absoluteRoot, parent).replace(/\\/g, "/");
    if (parent === cursor || relativeParent.startsWith("../"))
      break;
    cursor = parent;
  }
  return "npm";
}
function isJavaScriptTestPath(path) {
  return /(^|\/)(?:__tests__|tests?)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}
function packageValidationSteps(repoRoot, directory, changedPaths) {
  const manifestDirectory = resolve5(repoRoot, directory || ".");
  const manifest = readJson(resolve5(manifestDirectory, "package.json"));
  if (!manifest)
    return null;
  const manager = resolvePackageManager(repoRoot, manifestDirectory);
  const scripts = manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts) ? manifest.scripts : {};
  const directoryArg = directory ? commandPathArg(directory) : "";
  if (directory && !directoryArg)
    return null;
  if (manager === "bun") {
    const focusedTests = changedPaths.filter(isJavaScriptTestPath).map((path) => {
      const relativeTest = relative(manifestDirectory, resolve5(repoRoot, path)).replace(/\\/g, "/");
      if (!relativeTest || relativeTest.startsWith("../"))
        return "";
      return commandPathArg(relativeTest, true);
    }).filter(Boolean).slice(0, 4);
    if (focusedTests.length > 0) {
      return [`${directory ? `bun --cwd ${directoryArg}` : "bun"} test ${focusedTests.join(" ")}`];
    }
  }
  const scriptName = ["test", "check", "lint"].find((name) => {
    const script = typeof scripts[name] === "string" ? scripts[name].trim() : "";
    return Boolean(script && !(name === "test" && (/no test specified/i.test(script) || /(?:^|[;&|])\s*exit\s+1(?:\s|$)/i.test(script))));
  });
  if (!scriptName)
    return null;
  if (manager === "bun") {
    return [directoryArg ? `bun --cwd ${directoryArg} run ${scriptName}` : `bun run ${scriptName}`];
  }
  if (manager === "pnpm") {
    return [
      directoryArg ? `pnpm --dir ${directoryArg} run ${scriptName}` : `pnpm run ${scriptName}`
    ];
  }
  if (manager === "yarn") {
    return [
      directoryArg ? `yarn --cwd ${directoryArg} run ${scriptName}` : `yarn run ${scriptName}`
    ];
  }
  return [
    directoryArg ? `npm --prefix ${directoryArg} run ${scriptName}` : `npm run ${scriptName}`
  ];
}
function pythonValidationSteps(repoRoot, directory, paths) {
  const root = resolve5(repoRoot, directory || ".");
  const manifestNames = [
    "pyproject.toml",
    "setup.cfg",
    "setup.py",
    "pytest.ini",
    "tox.ini",
    "requirements.txt"
  ];
  const hasManifest = manifestNames.some((name) => existsSync4(resolve5(root, name)));
  const pythonPaths = paths.filter((path) => extname(path).toLowerCase() === ".py");
  if (!hasManifest)
    return null;
  const testPaths = pythonPaths.filter((path) => /(^|\/)(?:tests?|specs?)(\/|$)|(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path)).map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
  let evidence = "";
  for (const name of [...manifestNames, "requirements-dev.txt", "conftest.py"]) {
    const read = readTextBounded(resolve5(root, name));
    if (read)
      evidence += `
${read.text}`;
  }
  if (testPaths.length > 0 || /\bpytest\b/i.test(evidence)) {
    return [`python -m pytest${testPaths.length > 0 ? ` ${testPaths.join(" ")}` : ""}`];
  }
  if (existsSync4(resolve5(root, "manage.py"))) {
    const managePath = commandPathArg(directory ? `${directory}/manage.py` : "manage.py");
    return managePath ? [`python ${managePath} test`] : null;
  }
  const compileTargets = pythonPaths.map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
  return compileTargets.length > 0 ? [`python -m compileall ${compileTargets.join(" ")}`] : null;
}
function goValidationSteps(repoRoot, directory) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "go.mod")))
    return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `go -C ${directoryArg} test ./...` : "go test ./..."];
}
function rustValidationSteps(repoRoot, directory) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "Cargo.toml")))
    return null;
  if (!directory)
    return ["cargo test"];
  const manifestArg = commandPathArg(`${directory}/Cargo.toml`);
  return manifestArg ? [`cargo test --manifest-path ${manifestArg}`] : null;
}
function jvmValidationSteps(repoRoot, directory) {
  const root = resolve5(repoRoot, directory || ".");
  const directoryArg = directory ? commandPathArg(directory) : "";
  if (existsSync4(resolve5(root, "pom.xml"))) {
    const manifestArg = commandPathArg(directory ? `${directory}/pom.xml` : "pom.xml");
    return [directory && manifestArg ? `mvn -f ${manifestArg} test` : "mvn test"];
  }
  if (existsSync4(resolve5(root, "build.gradle")) || existsSync4(resolve5(root, "build.gradle.kts"))) {
    return [directoryArg ? `gradle -p ${directoryArg} test` : "gradle test"];
  }
  return null;
}
function dotnetValidationSteps(repoRoot, directory, paths) {
  const root = resolve5(repoRoot, directory || ".");
  const explicitProject = paths.find((path) => /\.(?:sln|csproj|fsproj)$/i.test(path));
  let project = explicitProject ?? "";
  if (!project) {
    try {
      const filename = readdirSync(root).filter((entry) => /\.(?:sln|csproj|fsproj)$/i.test(entry)).sort()[0];
      project = filename ? directory ? `${directory}/${filename}` : filename : "";
    } catch {
      project = "";
    }
  }
  const projectArg = commandPathArg(project);
  return projectArg ? [`dotnet test ${projectArg}`] : null;
}
function rubyValidationSteps(repoRoot, directory, paths) {
  const root = resolve5(repoRoot, directory || ".");
  const rubyPaths = paths.filter((path) => extname(path).toLowerCase() === ".rb");
  const hasRubyProjectEvidence = existsSync4(resolve5(root, "Gemfile")) || existsSync4(resolve5(root, "Rakefile")) || existsSync4(resolve5(root, ".rspec"));
  if (directory && !hasRubyProjectEvidence)
    return null;
  if (!directory && existsSync4(resolve5(root, "Gemfile"))) {
    const tests = rubyPaths.filter((path) => /(^|\/)spec(s)?(\/|$)|_spec\.rb$/i.test(path)).map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
    if (tests.length > 0 || existsSync4(resolve5(root, "spec")) || existsSync4(resolve5(root, ".rspec"))) {
      return [`bundle exec rspec${tests.length > 0 ? ` ${tests.join(" ")}` : ""}`];
    }
    if (existsSync4(resolve5(root, "Rakefile")))
      return ["bundle exec rake test"];
  }
  const target = commandPathArg(rubyPaths[0] ?? "");
  return target ? [`ruby -c ${target}`] : null;
}
function phpValidationSteps(repoRoot, directory, paths) {
  const root = resolve5(repoRoot, directory || ".");
  const composer = readJson(resolve5(root, "composer.json"));
  if (directory && !composer)
    return null;
  const scripts = composer?.scripts && typeof composer.scripts === "object" && !Array.isArray(composer.scripts) ? composer.scripts : null;
  if (scripts?.test != null) {
    const directoryArg = directory ? commandPathArg(directory) : "";
    return [directoryArg ? `composer --working-dir ${directoryArg} test` : "composer test"];
  }
  const phpPath = paths.find((path) => extname(path).toLowerCase() === ".php") ?? "";
  const target = commandPathArg(phpPath);
  return target ? [`php -l ${target}`] : null;
}
function changedManifestAt(paths, directory, names) {
  const expectedDir = directory || ".";
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return paths.some((path) => {
    const pathDirectory = dirname(path).replace(/\\/g, "/");
    return (pathDirectory || ".") === expectedDir && lowerNames.has(basename(path).toLowerCase());
  });
}
function makeValidationSteps(repoRoot, directory) {
  const root = resolve5(repoRoot, directory || ".");
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find((name) => existsSync4(resolve5(root, name)));
  if (!makefile)
    return null;
  const evidence = readTextBounded(resolve5(root, makefile));
  if (!evidence)
    return null;
  const target = ["test", "check"].find((name) => new RegExp(`^${name}\\s*:(?![=])`, "m").test(evidence.text));
  if (!target)
    return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `make -C ${directoryArg} ${target}` : `make ${target}`];
}
function cmakeValidationSteps(repoRoot, directory) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "CMakeLists.txt")))
    return null;
  const sourceArg = directory ? commandPathArg(directory) : ".";
  const buildPath = directory ? `${directory}/build` : "build";
  const buildArg = commandPathArg(buildPath);
  if (!sourceArg || !buildArg)
    return null;
  return [
    `cmake -S ${sourceArg} -B ${buildArg}`,
    `cmake --build ${buildArg}`,
    `ctest --test-dir ${buildArg} --output-on-failure`
  ];
}
function hasBazelWorkspaceAt(repoRoot) {
  return ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"].some((name) => existsSync4(resolve5(repoRoot, name)));
}
function bazelValidationSteps(repoRoot, directory) {
  if (!hasBazelWorkspaceAt(repoRoot))
    return null;
  const root = resolve5(repoRoot, directory || ".");
  const hasPackage = existsSync4(resolve5(root, "BUILD")) || existsSync4(resolve5(root, "BUILD.bazel"));
  if (directory && !hasPackage)
    return null;
  const target = directory ? `//${directory}/...` : "//...";
  return /^\/\/[A-Za-z0-9_@+.,/-]*\.\.\.$/.test(target) ? [`bazel test ${target}`] : null;
}
function nativeValidationSteps(repoRoot, directory, paths) {
  const directCMake = changedManifestAt(paths, directory, ["CMakeLists.txt"]);
  const directMake = changedManifestAt(paths, directory, ["Makefile", "makefile", "GNUmakefile"]);
  const directBazel = changedManifestAt(paths, directory, [
    "BUILD",
    "BUILD.bazel",
    "MODULE.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel"
  ]);
  if (directCMake)
    return cmakeValidationSteps(repoRoot, directory);
  if (directBazel)
    return bazelValidationSteps(repoRoot, directory);
  if (directMake)
    return makeValidationSteps(repoRoot, directory);
  return cmakeValidationSteps(repoRoot, directory) ?? bazelValidationSteps(repoRoot, directory) ?? makeValidationSteps(repoRoot, directory);
}
function protobufValidationSteps(repoRoot, directory) {
  const root = resolve5(repoRoot, directory || ".");
  if (!existsSync4(resolve5(root, "buf.yaml")) && !existsSync4(resolve5(root, "buf.work.yaml"))) {
    return null;
  }
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `buf lint ${directoryArg}` : "buf lint"];
}
function swiftValidationSteps(repoRoot, directory) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "Package.swift")))
    return null;
  const directoryArg = directory ? commandPathArg(directory) : "";
  return [directoryArg ? `swift test --package-path ${directoryArg}` : "swift test"];
}
function isDartTestPath(path) {
  return /(^|\/)(?:test|integration_test)(\/|$)|_test\.dart$/i.test(path);
}
function withoutYamlComments(text) {
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*#.*$|\s+#.*$/, "")).join(`
`);
}
function dartValidationSteps(repoRoot, directory, paths) {
  const root = resolve5(repoRoot, directory || ".");
  const pubspec = readTextBounded(resolve5(root, "pubspec.yaml"));
  if (!pubspec)
    return null;
  const pubspecEvidence = withoutYamlComments(pubspec.text);
  const executable = /\bsdk\s*:\s*flutter\b|^flutter\s*:/m.test(pubspecEvidence) ? "flutter" : "dart";
  if (directory && executable === "flutter") {
    const rootPubspec = readTextBounded(resolve5(repoRoot, "pubspec.yaml"));
    if (!rootPubspec || !/^workspace\s*:/m.test(withoutYamlComments(rootPubspec.text)) || !/^resolution\s*:\s*workspace\s*$/m.test(pubspecEvidence)) {
      return null;
    }
  }
  if (directory && executable === "dart") {
    const directoryArg = commandPathArg(directory);
    return directoryArg ? [`dart --directory ${directoryArg} test`] : null;
  }
  const focusedTests = paths.filter(isDartTestPath).map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
  if (focusedTests.length > 0)
    return [`${executable} test ${focusedTests.join(" ")}`];
  if (!directory)
    return [`${executable} test`];
  const relativeTests = existsSync4(resolve5(root, "test")) ? `${directory}/test` : existsSync4(resolve5(root, "integration_test")) ? `${directory}/integration_test` : "";
  const target = commandPathArg(relativeTests);
  return target ? [`${executable} test ${target}`] : null;
}
function elixirValidationSteps(repoRoot, directory, paths) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "mix.exs")))
    return null;
  if (directory) {
    const directoryArg = commandPathArg(directory);
    return directoryArg ? [`mix --cd ${directoryArg} test`] : null;
  }
  const focusedTests = paths.filter((path) => /(^|\/)test(\/|$)|_test\.exs$/i.test(path)).map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
  return [`mix test${focusedTests.length > 0 ? ` ${focusedTests.join(" ")}` : ""}`];
}
function hasCabalManifest(directory) {
  if (existsSync4(resolve5(directory, "cabal.project")))
    return true;
  try {
    return readdirSync(directory).some((entry) => entry.toLowerCase().endsWith(".cabal"));
  } catch {
    return false;
  }
}
function haskellValidationSteps(repoRoot, directory) {
  const root = resolve5(repoRoot, directory || ".");
  if (existsSync4(resolve5(root, "stack.yaml"))) {
    if (!directory)
      return ["stack test"];
    const yamlArg = commandPathArg(`${directory}/stack.yaml`);
    return yamlArg ? [`stack --stack-yaml ${yamlArg} test`] : null;
  }
  if (!directory && hasCabalManifest(root))
    return ["cabal test all"];
  return null;
}
function ednMapAfterKeyword(text, keyword) {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const keywordIndex = text.indexOf(keyword, searchFrom);
    if (keywordIndex < 0)
      return "";
    const next = text[keywordIndex + keyword.length] ?? "";
    if (next && /[A-Za-z0-9_!?*+.-]/.test(next)) {
      searchFrom = keywordIndex + keyword.length;
      continue;
    }
    let cursor = keywordIndex + keyword.length;
    while (cursor < text.length && /[\s,]/.test(text[cursor] ?? ""))
      cursor += 1;
    if (text[cursor] !== "{") {
      searchFrom = cursor + 1;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = cursor;index < text.length; index += 1) {
      const ch = text[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted)
        continue;
      if (ch === "{")
        depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0)
          return text.slice(cursor, index + 1);
      }
    }
    return "";
  }
  return "";
}
function clojureValidationSteps(repoRoot, directory) {
  if (directory)
    return null;
  const deps = readTextBounded(resolve5(repoRoot, "deps.edn"));
  if (deps) {
    const testAlias = ednMapAfterKeyword(deps.text, ":test");
    if (/:exec-fn\b/.test(testAlias))
      return ["clojure -X:test"];
    if (/:main-opts\b/.test(testAlias))
      return ["clojure -M:test"];
  }
  if (existsSync4(resolve5(repoRoot, "project.clj")))
    return ["lein test"];
  return null;
}
function zigValidationSteps(repoRoot, directory) {
  if (!existsSync4(resolve5(repoRoot, directory || ".", "build.zig")))
    return null;
  if (!directory)
    return ["zig build test"];
  const buildFile = commandPathArg(`${directory}/build.zig`);
  return buildFile ? [`zig build --build-file ${buildFile} test`] : null;
}
function terraformValidationSteps(paths) {
  const targets = paths.filter((path) => [".tf", ".tfvars"].includes(extname(path).toLowerCase())).map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
  return targets.length > 0 ? [`terraform fmt -check ${targets.join(" ")}`] : null;
}
function validationForEcosystem(ecosystem, repoRoot, directory, paths) {
  if (ecosystem === "package")
    return packageValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "python")
    return pythonValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "go")
    return goValidationSteps(repoRoot, directory);
  if (ecosystem === "rust")
    return rustValidationSteps(repoRoot, directory);
  if (ecosystem === "jvm")
    return jvmValidationSteps(repoRoot, directory);
  if (ecosystem === "dotnet")
    return dotnetValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "ruby")
    return rubyValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "php")
    return phpValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "native")
    return nativeValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "protobuf")
    return protobufValidationSteps(repoRoot, directory);
  if (ecosystem === "swift")
    return swiftValidationSteps(repoRoot, directory);
  if (ecosystem === "dart")
    return dartValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "elixir")
    return elixirValidationSteps(repoRoot, directory, paths);
  if (ecosystem === "haskell")
    return haskellValidationSteps(repoRoot, directory);
  if (ecosystem === "clojure")
    return clojureValidationSteps(repoRoot, directory);
  if (ecosystem === "zig")
    return zigValidationSteps(repoRoot, directory);
  if (ecosystem === "terraform")
    return terraformValidationSteps(paths);
  return null;
}
function syntaxFallbackForEcosystem(ecosystem, paths) {
  if (ecosystem === "python") {
    const targets = paths.filter((path) => extname(path).toLowerCase() === ".py").map((path) => commandPathArg(path)).filter(Boolean).slice(0, 4);
    return targets.length > 0 ? [`python -m compileall ${targets.join(" ")}`] : null;
  }
  if (ecosystem === "ruby") {
    const target = commandPathArg(paths.find((path) => extname(path).toLowerCase() === ".rb") ?? "");
    return target ? [`ruby -c ${target}`] : null;
  }
  if (ecosystem === "php") {
    const target = commandPathArg(paths.find((path) => extname(path).toLowerCase() === ".php") ?? "");
    return target ? [`php -l ${target}`] : null;
  }
  if (ecosystem === "r") {
    const target = normalizeRepoPath(paths.find((path) => extname(path).toLowerCase() === ".r") ?? "");
    return target ? [`Rscript -e "parse(file='${target}')"`] : null;
  }
  if (ecosystem === "lua") {
    const target = commandPathArg(paths.find((path) => extname(path).toLowerCase() === ".lua") ?? "");
    return target ? [`luac -p ${target}`] : null;
  }
  return null;
}
function isFallbackEligiblePath(path) {
  const filename = basename(path).toLowerCase();
  const extension = extname(path).toLowerCase();
  if (/^(?:readme|license|licence|changelog|contributing|authors|notice)(?:\..*)?$/.test(filename)) {
    return true;
  }
  return [
    ".md",
    ".mdx",
    ".rst",
    ".adoc",
    ".txt",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp3",
    ".mp4",
    ".wav",
    ".webm"
  ].includes(extension);
}
function inferRepositoryValidationSteps(options) {
  const maxSteps = Math.max(1, Math.min(8, Math.floor(options.maxSteps ?? 4)));
  const repoRoot = resolve5(options.repoRoot || ".");
  const paths = (options.changedPaths ?? []).map(normalizeRepoPath).filter(Boolean);
  const plans = [];
  for (const group of pathsByEcosystem(paths)) {
    const pathsByOwner = new Map;
    const pathsWithoutOwner = [];
    for (const path of group.paths) {
      const owner = validationSearchDirectories([path]).find((directory) => Boolean(validationForEcosystem(group.ecosystem, repoRoot, directory, [path])?.length));
      if (owner === undefined) {
        pathsWithoutOwner.push(path);
        continue;
      }
      const ownerPaths = pathsByOwner.get(owner) ?? [];
      ownerPaths.push(path);
      pathsByOwner.set(owner, ownerPaths);
    }
    for (const [directory, ownerPaths] of pathsByOwner) {
      const plan = validationForEcosystem(group.ecosystem, repoRoot, directory, ownerPaths);
      if (plan?.length)
        plans.push(plan);
    }
    const fallback = syntaxFallbackForEcosystem(group.ecosystem, pathsWithoutOwner);
    if (fallback?.length)
      plans.push(fallback);
  }
  if (plans.length > 0)
    return dedupeCompletePlans(plans, maxSteps);
  if (paths.length === 0 || paths.every(isFallbackEligiblePath)) {
    return [FALLBACK_VALIDATION_STEP];
  }
  return [];
}
// packages/shared/src/validation_repair_lease.ts
var LEASE_KEYS = {
  version: "pushpals-validationRepairLeaseVersion",
  scope: "pushpals-validationRepairScope",
  incidentId: "pushpals-validationRepairIncidentId",
  baselineSha: "pushpals-validationRepairBaselineSha",
  candidateSha: "pushpals-validationRepairCandidateSha",
  candidateRef: "pushpals-validationRepairCandidateRef",
  expectedCompletionSha: "pushpals-validationRepairCompletionSha"
};
var LEASE_MARKER_RE = /<!--\s*pushpals-validationRepair/i;
var SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var INCIDENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
var VALIDATION_CANDIDATE_REF_RE = /^refs\/pushpals\/validation\/[0-9a-f]{32}\/[1-9][0-9]*\/candidate$/;
function normalizeSha(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE.test(normalized) ? normalized : "";
}
function normalizeIncidentId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return INCIDENT_ID_RE.test(normalized) ? normalized : "";
}
function normalizeCandidateRef(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALIDATION_CANDIDATE_REF_RE.test(normalized) ? normalized : "";
}
function metadataValues(body, key) {
  return [...body.matchAll(new RegExp(`<!--\\s*${key}\\s*:\\s*([^>]*?)\\s*-->`, "gi"))].map((match) => String(match[1] ?? "").trim());
}
function singleMetadataValue(body, key) {
  const values = metadataValues(body, key);
  if (values.length !== 1) {
    throw new Error(`Malformed validation-repair publication lease: expected exactly one ${key} marker, found ${values.length}.`);
  }
  return values[0] ?? "";
}
function validateValidationRepairPublicationLease(input) {
  if (String(input.version ?? "").trim() !== "1") {
    throw new Error("Malformed validation-repair publication lease: unsupported lease version.");
  }
  if (String(input.scope ?? "").trim().toLowerCase() !== "candidate_specific") {
    throw new Error("Malformed validation-repair publication lease: scope must be candidate_specific.");
  }
  const incidentId = normalizeIncidentId(input.incidentId);
  const baselineSha = normalizeSha(input.baselineSha);
  const candidateSha = normalizeSha(input.candidateSha);
  const candidateRef = normalizeCandidateRef(input.candidateRef);
  const expectedCompletionSha = normalizeSha(input.expectedCompletionSha);
  if (!incidentId || !baselineSha || !candidateSha || !candidateRef || !expectedCompletionSha) {
    throw new Error("Malformed validation-repair publication lease: incident ID, retained candidate ref, and exact baseline/candidate/completion SHAs are required.");
  }
  if (baselineSha === candidateSha || candidateSha === expectedCompletionSha) {
    throw new Error("Malformed validation-repair publication lease: baseline, candidate, and completion must identify distinct revisions.");
  }
  return {
    version: 1,
    scope: "candidate_specific",
    incidentId,
    baselineSha,
    candidateSha,
    candidateRef,
    expectedCompletionSha
  };
}
function parseValidationRepairPublicationLease(prBody) {
  const body = String(prBody ?? "");
  if (!LEASE_MARKER_RE.test(body))
    return null;
  return validateValidationRepairPublicationLease({
    version: singleMetadataValue(body, LEASE_KEYS.version),
    scope: singleMetadataValue(body, LEASE_KEYS.scope),
    incidentId: singleMetadataValue(body, LEASE_KEYS.incidentId),
    baselineSha: singleMetadataValue(body, LEASE_KEYS.baselineSha),
    candidateSha: singleMetadataValue(body, LEASE_KEYS.candidateSha),
    candidateRef: singleMetadataValue(body, LEASE_KEYS.candidateRef),
    expectedCompletionSha: singleMetadataValue(body, LEASE_KEYS.expectedCompletionSha)
  });
}
// packages/shared/src/session_event_visibility.ts
var ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/source_control_manager/src/bounded_process.ts
async function runBoundedScmProcess(argv, options) {
  return runBoundedProcess(argv, options);
}

// apps/source_control_manager/src/git.ts
var DEFAULT_GIT_COMMAND_TIMEOUT_MS = 2 * 60000;
var DEFAULT_GIT_NETWORK_TIMEOUT_MS = 5 * 60000;
var DEFAULT_GIT_DISCOVERY_TIMEOUT_MS = 1e4;
function positiveTimeoutFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1000, Math.floor(parsed)) : fallback;
}
function resolveGitCommandTimeoutMs(args, requestedTimeout, env = process.env) {
  if (Number.isFinite(requestedTimeout) && Number(requestedTimeout) > 0) {
    return Math.max(1, Math.floor(Number(requestedTimeout)));
  }
  const networkCommand = args.some((arg) => /^(?:clone|fetch|ls-remote|pull|push|submodule)$/i.test(String(arg).trim()));
  return networkCommand ? positiveTimeoutFromEnv(env.PUSHPALS_SCM_GIT_NETWORK_TIMEOUT_MS, DEFAULT_GIT_NETWORK_TIMEOUT_MS) : positiveTimeoutFromEnv(env.PUSHPALS_SCM_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_COMMAND_TIMEOUT_MS);
}
function normalizeFsPathForComparison(value) {
  const resolved = resolve6(String(value ?? "").trim()).replace(/\\/g, "/").replace(/\/+$/, "");
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
    try {
      const result = await runBoundedScmProcess([shellExecutable, "/d", "/s", "/c", commandLine], {
        timeoutMs: timeout,
        platform: "win32",
        cwd: repoPath,
        env,
        stdout: "pipe",
        stderr: "pipe"
      });
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(shellExecutable, err));
      continue;
    }
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
          const lookup = await runBoundedScmProcess([whereExecutable, candidate], {
            timeoutMs: positiveTimeoutFromEnv(process.env.PUSHPALS_SCM_GIT_DISCOVERY_TIMEOUT_MS, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS),
            cwd: repoPath,
            env: copyEnvWithoutScmRepairAuthoritySecret(process.env),
            stdout: "pipe",
            stderr: "ignore"
          });
          if (lookup.exitCode === 0 && !lookup.timedOut) {
            for (const resolved of lookup.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)) {
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
  const timeoutMs = resolveGitCommandTimeoutMs(args, opts?.timeout);
  const gitExecutables = await expandWindowsGitExecutableCandidates(repoPath, resolveGitExecutableCandidatesFromEnv());
  const spawnFailures = [];
  for (const gitExecutable of gitExecutables) {
    const gitArgs = opts?.githubToken && opts.githubToken.length > 0 ? [
      gitExecutable,
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.githubToken}`, "utf-8").toString("base64")}`,
      ...args
    ] : [gitExecutable, ...args];
    try {
      const result = await runBoundedScmProcess(gitArgs, {
        cwd: repoPath,
        env: copyEnvWithoutScmRepairAuthoritySecret(process.env),
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs
      });
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    } catch (err) {
      spawnFailures.push(formatGitSpawnFailure(gitExecutable, err));
      if (process.platform === "win32") {
        try {
          const shellResult = await runViaWindowsCmd(repoPath, gitArgs, timeoutMs);
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
var DEFAULT_GITHUB_API_TIMEOUT_MS = 30000;
var MAX_OPEN_PR_PAGES = 4;
var MAX_RECENTLY_CLOSED_PR_PAGES = 4;
var GITHUB_PULL_REQUEST_PAGE_SIZE = 100;
function normalizePullRequestScanCursor(cursor) {
  const rawPage = Number(cursor?.page);
  const rawOffset = Number(cursor?.offset);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 && rawOffset < GITHUB_PULL_REQUEST_PAGE_SIZE ? rawOffset : 0;
  return { page, offset };
}
function notifyPullRequestScanComplete(callback, nextCursor) {
  callback?.(nextCursor);
}
function githubApiTimeoutMs() {
  const configured = Number(process.env.PUSHPALS_GITHUB_API_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.floor(configured)) : DEFAULT_GITHUB_API_TIMEOUT_MS;
}
function githubFetch(input, init, fetchImpl) {
  const timeoutMs = githubApiTimeoutMs();
  return fetchBufferedWithHardDeadline({
    input,
    init,
    timeoutMs,
    fetchImpl,
    timeoutMessage: `GitHub API request timed out after ${timeoutMs}ms`
  });
}
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
function isSupportedGitHubRemoteUrl(remoteUrl) {
  return parseGitHubRepo2(remoteUrl) !== null;
}
function parseGitHubPullRequestNumberForRemote(prUrl, remoteUrl) {
  const repo = parseGitHubRepo2(remoteUrl);
  if (!repo)
    return null;
  let parsed;
  try {
    parsed = new URL(String(prUrl ?? "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com")
    return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0]?.toLowerCase() !== repo.owner.toLowerCase() || parts[1]?.toLowerCase() !== repo.repo.toLowerCase() || parts[2]?.toLowerCase() !== "pull") {
    return null;
  }
  if (!/^[1-9]\d*$/.test(parts[3] ?? ""))
    return null;
  const prNumber = Number.parseInt(parts[3] ?? "", 10);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null;
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
function pullRequestHeadBelongsToRepo(pr, repo) {
  const expected = `${repo.owner}/${repo.repo}`.toLowerCase();
  const headRepo = pr?.head?.repo;
  if (!headRepo)
    return false;
  const fullName = typeof headRepo.full_name === "string" ? headRepo.full_name.trim() : "";
  if (fullName)
    return fullName.toLowerCase() === expected;
  const owner = headRepo.owner && typeof headRepo.owner.login === "string" ? headRepo.owner.login.trim() : "";
  const name = typeof headRepo.name === "string" ? headRepo.name.trim() : "";
  return Boolean(owner && name && `${owner}/${name}`.toLowerCase() === expected);
}
function pullRequestHeadBelongsToRemoteRepository(pr, remoteUrl) {
  const repo = parseGitHubRepo2(remoteUrl);
  return repo ? pullRequestHeadBelongsToRepo(pr, repo) : false;
}
async function ensureIntegrationPullRequest(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}. Supported: https://github.com/<owner>/<repo>.git or git@github.com:<owner>/<repo>.git`);
  }
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const headSpec = `${repo.owner}:${opts.headBranch}`;
  const listUrl = `${apiBase}/pulls?state=open&head=${encodeURIComponent(headSpec)}&base=${encodeURIComponent(opts.baseBranch)}`;
  const listResponse = await githubFetch(listUrl, {
    method: "GET",
    headers: githubHeaders(opts.token)
  }, opts.fetchImpl);
  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw githubError(listResponse.status, text);
  }
  const openPrs = await listResponse.json();
  const existing = Array.isArray(openPrs) ? openPrs.find((pr) => pr.head?.ref === opts.headBranch && pr.base?.ref === opts.baseBranch && pullRequestHeadBelongsToRepo(pr, repo)) : undefined;
  if (existing) {
    return { created: false, number: existing.number, htmlUrl: existing.html_url };
  }
  const createResponse = await githubFetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: githubHeaders(opts.token),
    body: JSON.stringify({
      title: opts.title,
      head: opts.headBranch,
      base: opts.baseBranch,
      body: opts.body,
      draft: !!opts.draft
    })
  }, opts.fetchImpl);
  if (createResponse.ok) {
    const created = await createResponse.json();
    return { created: true, number: created.number, htmlUrl: created.html_url };
  }
  if (createResponse.status === 422) {
    const retryListResponse = await githubFetch(listUrl, {
      method: "GET",
      headers: githubHeaders(opts.token)
    }, opts.fetchImpl);
    if (retryListResponse.ok) {
      const retryOpenPrs = await retryListResponse.json();
      const racedExisting = Array.isArray(retryOpenPrs) ? retryOpenPrs.find((pr) => pr.head?.ref === opts.headBranch && pr.base?.ref === opts.baseBranch && pullRequestHeadBelongsToRepo(pr, repo)) : undefined;
      if (racedExisting) {
        return {
          created: false,
          number: racedExisting.number,
          htmlUrl: racedExisting.html_url
        };
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
  const matches = [];
  const cursor = normalizePullRequestScanCursor(opts.cursor);
  let page = cursor.page;
  let offset = cursor.offset;
  for (let pagesFetched = 0;pagesFetched < MAX_OPEN_PR_PAGES; pagesFetched += 1) {
    const url = `${apiBase}/pulls?state=open&base=${encodeURIComponent(opts.base)}` + `&per_page=${GITHUB_PULL_REQUEST_PAGE_SIZE}&page=${page}`;
    const response = await githubFetch(url, {
      method: "GET",
      headers: githubHeaders(opts.token)
    }, opts.fetchImpl);
    if (!response.ok) {
      const text = await response.text();
      throw githubError(response.status, text);
    }
    const prs = await response.json();
    if (!Array.isArray(prs)) {
      notifyPullRequestScanComplete(opts.onScanComplete, null);
      return matches;
    }
    for (const pr of prs.slice(offset)) {
      const headRef = typeof pr?.head?.ref === "string" ? pr.head.ref : "";
      if (opts.headPrefix && !headRef.startsWith(opts.headPrefix))
        continue;
      if (!pullRequestHeadBelongsToRepo(pr, repo))
        continue;
      matches.push(pr);
    }
    if (prs.length < GITHUB_PULL_REQUEST_PAGE_SIZE) {
      notifyPullRequestScanComplete(opts.onScanComplete, null);
      return matches;
    }
    page += 1;
    offset = 0;
  }
  notifyPullRequestScanComplete(opts.onScanComplete, { page, offset: 0 });
  return matches;
}
async function listRecentlyClosedPullRequests(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit ?? 50))) : 50;
  const cutoffMs = Date.parse(String(opts.updatedSince ?? "").trim());
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`updatedSince must be a valid timestamp, got ${JSON.stringify(opts.updatedSince)}`);
  }
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const matches = [];
  const cursor = normalizePullRequestScanCursor(opts.cursor);
  let page = cursor.page;
  let offset = cursor.offset;
  for (let pagesFetched = 0;pagesFetched < MAX_RECENTLY_CLOSED_PR_PAGES; pagesFetched += 1) {
    const url = `${apiBase}/pulls?state=closed&base=${encodeURIComponent(opts.base)}` + `&sort=updated&direction=desc&per_page=${GITHUB_PULL_REQUEST_PAGE_SIZE}&page=${page}`;
    const response = await githubFetch(url, {
      method: "GET",
      headers: githubHeaders(opts.token)
    }, opts.fetchImpl);
    if (!response.ok) {
      const text = await response.text();
      throw githubError(response.status, text);
    }
    const prs = await response.json();
    if (!Array.isArray(prs)) {
      notifyPullRequestScanComplete(opts.onScanComplete, null);
      return matches;
    }
    let reachedCutoff = false;
    let nextOffset = offset;
    for (let index = offset;index < prs.length; index += 1) {
      const pr = prs[index];
      nextOffset = index + 1;
      const updatedAtMs = Date.parse(String(pr.updated_at ?? pr.closed_at ?? ""));
      if (!Number.isFinite(updatedAtMs))
        continue;
      if (updatedAtMs < cutoffMs) {
        reachedCutoff = true;
        break;
      }
      const headRef = typeof pr?.head?.ref === "string" ? pr.head.ref : "";
      if (opts.headPrefix && !headRef.startsWith(opts.headPrefix))
        continue;
      if (!pullRequestHeadBelongsToRepo(pr, repo))
        continue;
      matches.push(pr);
      if (matches.length >= limit) {
        const nextCursor = nextOffset < prs.length ? { page, offset: nextOffset } : prs.length >= GITHUB_PULL_REQUEST_PAGE_SIZE ? { page: page + 1, offset: 0 } : null;
        notifyPullRequestScanComplete(opts.onScanComplete, nextCursor);
        return matches;
      }
    }
    if (reachedCutoff || prs.length < GITHUB_PULL_REQUEST_PAGE_SIZE) {
      notifyPullRequestScanComplete(opts.onScanComplete, null);
      return matches;
    }
    page += 1;
    offset = 0;
  }
  notifyPullRequestScanComplete(opts.onScanComplete, { page, offset: 0 });
  return matches;
}
async function getPullRequest(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  if (!Number.isSafeInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error(`prNumber must be a positive integer, got ${JSON.stringify(opts.prNumber)}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await githubFetch(url, {
    method: "GET",
    headers: githubHeaders(opts.token)
  }, opts.fetchImpl);
  if (!response.ok) {
    const text = await response.text();
    throw githubError(response.status, text);
  }
  return await response.json();
}
async function getPullRequestDiff(opts) {
  const repo = parseGitHubRepo2(opts.remoteUrl);
  if (!repo) {
    throw new Error(`Remote URL is not a supported GitHub URL: ${opts.remoteUrl}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${opts.prNumber}`;
  const response = await githubFetch(url, {
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
  const response = await githubFetch(url, {
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
    const response = await githubFetch(url, {
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
  const response = await githubFetch(url, {
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
  const response = await githubFetch(url, {
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
  const response = await githubFetch(url, {
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
  const issueResponse = await githubFetch(issueUrl, {
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
  const reviewResponse = await githubFetch(reviewUrl, {
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
  const response = await githubFetch(url, {
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
  httpTimeoutMs;
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
    this.httpTimeoutMs = Math.max(1, Math.floor(options.httpTimeoutMs ?? 1e4));
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
      const response = await fetchBufferedWithHardDeadline({
        input: `${runtimeConfig.serverUrl}/jobs/enqueue`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        },
        timeoutMs: this.httpTimeoutMs,
        fetchImpl: this.fetchImpl,
        timeoutMessage: `Integration reconciliation enqueue timed out after ${this.httpTimeoutMs}ms`
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
import { existsSync as existsSync5, readFileSync as readFileSync6 } from "fs";
import { tmpdir } from "os";
import { basename as basename2, delimiter, isAbsolute as isAbsolute2, join as join5, resolve as resolve7 } from "path";
async function listPersistedPrLinks(opts) {
  const headers = {};
  if (opts.authToken)
    headers.Authorization = `Bearer ${opts.authToken}`;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit ?? 8))) : 8;
  const cursor = String(opts.cursor ?? "").trim();
  const url = new URL(`${opts.serverUrl.replace(/\/+$/, "")}/jobs/pr-links`);
  url.searchParams.set("limit", String(limit));
  if (cursor)
    url.searchParams.set("cursor", cursor);
  const response = await opts.fetchImpl(url, { method: "GET", headers });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`persisted PR link scan failed: HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`);
  }
  let payload = null;
  try {
    const parsed = responseText ? JSON.parse(responseText) : null;
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    payload = null;
  }
  if (payload?.ok !== true || !Array.isArray(payload.links)) {
    throw new Error("persisted PR link scan did not return an acknowledged compact page");
  }
  const links = [];
  const seenPrNumbers = new Set;
  for (const entry of payload.links.slice(0, limit)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const row = entry;
    const jobId = String(row.jobId ?? "").trim();
    const prUrl = String(row.prUrl ?? "").trim();
    const prNumber = parseGitHubPullRequestNumberForRemote(prUrl, opts.remoteUrl);
    if (!jobId || !prNumber || seenPrNumbers.has(prNumber))
      continue;
    seenPrNumbers.add(prNumber);
    links.push({
      jobId,
      sessionId: String(row.sessionId ?? "").trim() || null,
      prNumber,
      prUrl,
      updatedAt: String(row.updatedAt ?? "").trim() || null
    });
  }
  const nextCursor = String(payload.nextCursor ?? "").trim();
  if (nextCursor && !/^\d{1,20}$/.test(nextCursor)) {
    throw new Error("persisted PR link scan returned an invalid next cursor");
  }
  return { links, nextCursor: nextCursor || null };
}
var MAX_DIFF_BYTES = 150000;
var MAX_PR_RE_REVIEW_ENQUEUES = 3;
var MAX_REVIEW_CONTEXT_COMMENTS = 8;
var MAX_REVIEW_CONTEXT_COMMENT_CHARS = 320;
var MAX_REVIEW_CONTEXT_TOTAL_CHARS = 3000;
var MAX_AUTONOMY_FEEDBACK_COMMENTS = 12;
var MAX_AUTONOMY_FEEDBACK_COMMENT_CHARS = 500;
var MAX_AUTONOMY_FEEDBACK_SUMMARY_CHARS = 500;
var MAX_RECENTLY_CLOSED_PRS = 50;
var MAX_CLOSED_PR_RECONCILIATIONS_PER_POLL = 8;
var MAX_PERSISTED_PR_STATE_PROBES_PER_POLL = 8;
var MAX_PERSISTED_PR_RETRY_PROBES_PER_POLL = 4;
var MAX_PERSISTED_PR_RETRY_QUEUE_SIZE = 64;
var PROVIDER_RECONCILIATION_MIN_INTERVAL_MS = 60000;
var PROVIDER_RECONCILIATION_STALL_MS = 5 * 60000;
var MAX_OPEN_PR_REVIEWS_PER_LANE_RUN = 1;
var CLOSED_PR_RECONCILIATION_WINDOW_MS = 7 * 24 * 60 * 60000;
var CLOSED_PR_RECONCILIATION_RETRY_COOLDOWN_MS = 60000;
var AUTONOMY_FEEDBACK_MAX_ATTEMPTS = 3;
var AUTONOMY_FEEDBACK_RETRY_DELAYS_MS = [0, 100, 300];
var MAX_ACTIVE_FIX_JOB_SCAN = 500;
var REVIEW_FIX_JOB_DEDUPE_COOLDOWN_MS = 60000;
var REVIEW_MERGE_CONFLICT_JOB_DEDUPE_COOLDOWN_MS = 30 * 60000;
var MAX_MERGE_CONFLICT_ATTEMPTS_PER_FINGERPRINT = 2;
var MERGE_CONFLICT_COMPLETION_SETTLE_MS = 30 * 60000;
var REPEATED_REVIEW_FINDING_MIN_PRIOR_COMMENTS = 3;
var PROTECTED_BRANCHES_FOR_AUTO_DELETE = new Set(["main", "main_agent", "main_agents"]);
var JOB_ID_MARKER = "pushpals-jobId";
var SESSION_ID_MARKER = "pushpals-sessionId";
var DEFAULT_WORKSPACE_ROOT = resolve7(import.meta.dir, "..", "..", "..");
var DEFAULT_REVIEW_AGENT_HTTP_TIMEOUT_MS = 5000;
var DEFAULT_REVIEW_AGENT_HTTP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var ts = () => new Date().toISOString();
function resolveReviewValidationRepoRoot() {
  try {
    const config = loadPushPalsConfig();
    const scmRepo = String(config.sourceControlManager.repoPath ?? "").trim();
    if (scmRepo && existsSync5(scmRepo))
      return resolve7(scmRepo);
    const projectRoot = String(config.projectRoot ?? "").trim();
    if (projectRoot && existsSync5(projectRoot))
      return resolve7(projectRoot);
  } catch {}
  return resolve7(process.cwd());
}
var DEFAULT_DEPS = {
  repositoryServices: null,
  listOpenPullRequests,
  listRecentlyClosedPullRequests,
  getPullRequest,
  listPersistedPrLinks,
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
  feedbackFetchImpl: fetch,
  httpTimeoutMs: DEFAULT_REVIEW_AGENT_HTTP_TIMEOUT_MS,
  httpMaxResponseBytes: DEFAULT_REVIEW_AGENT_HTTP_MAX_RESPONSE_BYTES,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve8) => setTimeout(resolve8, ms)),
  logInfo: (line) => console.log(line),
  logWarn: (line) => console.warn(line),
  logError: (line) => console.error(line),
  validationRepoRoot: resolveReviewValidationRepoRoot,
  scmRepairAuthoritySecret: null
};
function createBoundedReviewAgentFetch(fetchImpl, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : DEFAULT_REVIEW_AGENT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = typeof options.maxResponseBytes === "number" && Number.isFinite(options.maxResponseBytes) ? Math.max(0, Math.floor(options.maxResponseBytes)) : DEFAULT_REVIEW_AGENT_HTTP_MAX_RESPONSE_BYTES;
  return (input, init) => fetchBufferedWithHardDeadline({
    input,
    init,
    timeoutMs,
    maxResponseBytes,
    fetchImpl,
    timeoutMessage: `ReviewAgent HTTP request timed out after ${timeoutMs}ms`
  });
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
function currentBunExecPath() {
  const explicit = String(process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (explicit) {
    const leaf2 = basename2(explicit).toLowerCase();
    if (leaf2 === "bun" || leaf2 === "bun.exe")
      return explicit;
  }
  const execPath = (process.execPath ?? "").trim();
  if (!execPath)
    return "";
  const leaf = basename2(execPath).toLowerCase();
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
      const fullPath = join5(dir, candidate);
      if (existsSync5(fullPath))
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
  const workspaceRoot = resolve7(promptRootOverride || options?.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  const cwd = resolve7(options?.cwd || process.cwd());
  if (isAbsolute2(raw))
    return raw;
  const candidates = new Set;
  candidates.add(resolve7(workspaceRoot, raw));
  candidates.add(resolve7(cwd, raw));
  let cursor = cwd;
  for (let i = 0;i < 6; i += 1) {
    const parent = resolve7(cursor, "..");
    if (parent === cursor)
      break;
    candidates.add(resolve7(parent, raw));
    cursor = parent;
  }
  for (const candidate of candidates) {
    if (existsSync5(candidate))
      return candidate;
  }
  return resolve7(workspaceRoot, raw);
}
function buildCodexEnv(config) {
  const env = copyEnvWithoutScmRepairAuthoritySecret(process.env);
  if (config.codexAuthMode === "chatgpt" && config.codexHomeDir) {
    env.CODEX_HOME = config.codexHomeDir;
    env.HOME = config.codexHomeDir;
  }
  return env;
}
async function invokeCodexReview(prompt, config) {
  const tmpFile = join5(tmpdir(), `review-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const codexCmd = resolveCodexCmd(config.codexBin);
  const args = buildCodexExecArgs(codexCmd, tmpFile);
  try {
    const result = await runBoundedScmProcess(args, {
      stdin: new Blob([prompt]),
      stdout: "ignore",
      stderr: "pipe",
      env: buildCodexEnv(config),
      timeoutMs: config.codexTimeoutMs
    });
    if (result.timedOut) {
      throw new Error(`Codex review timed out after ${config.codexTimeoutMs}ms`);
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(0, 800);
      throw new Error(`Codex review failed (exit ${result.exitCode}): ${detail || "no stderr"}`);
    }
    return (await Bun.file(tmpFile).text()).trim();
  } finally {
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
    patterns: [/\b(workerpal|remotebuddy|pushpals)\b/i]
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
    if (!/^[+-](?![+-])/.test(line))
      continue;
    const declaration = line.slice(1).trim();
    const isTestDeclaration = /^(?:(?:test|it|describe|context|RSpec\.describe)\s*\(|(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(|func\s+Test[A-Za-z0-9_]*\s*\(|#\[test\]|@Test\b|\[(?:Fact|Theory|Test|TestCase)\b|(?:public\s+|private\s+|internal\s+)?(?:async\s+)?(?:void|Task|ValueTask|func)\s+[Tt]est[A-Za-z0-9_]*\s*\(|(?:public\s+|protected\s+)?function\s+test[A-Za-z0-9_]*\s*\()/i.test(declaration);
    if (!isTestDeclaration)
      continue;
    if (line.startsWith("+"))
      added += 1;
    else
      removed += 1;
  }
  return { added, removed };
}
function isReviewTestPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return /(^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(normalized) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base) || /^test_.*\.py$/i.test(base) || /_test\.go$/i.test(base) || /_spec\.rb$/i.test(base) || /(?:Test|Tests)\.(?:java|kt|kts|cs|fs|php|swift)$/i.test(base) || /\.Tests?\.(?:csproj|fsproj)$/i.test(base);
}
function isPushPalsSelfRepository(identity) {
  return /(?:^|[:/])pushpalsdev\/pushpals(?:\.git)?\/?$/i.test(String(identity ?? "").trim());
}
function explicitlyAllowsTestRemoval(taskIntent) {
  const normalized = collapseWhitespace(taskIntent);
  return /\b(?:delete|remove|retire|replace|consolidate|migrate|refactor)\w*\b.{0,80}\b(?:test|coverage|suite)s?\b/i.test(normalized) || /\b(?:test|coverage|suite)s?\b.{0,80}\b(?:delete|remove|retire|replace|consolidate|migrate|refactor)\w*\b/i.test(normalized);
}
function addedDiffText(diff) {
  return diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join(`
`);
}
function collectReviewHygieneIssuesFromDiff(diff, context = {}) {
  const changedPaths = parseChangedPathsFromDiff(diff);
  const issues = [];
  const declarationCounts = testDeclarationCounts(diff);
  if (declarationCounts.removed >= 3 && declarationCounts.removed > declarationCounts.added && !explicitlyAllowsTestRemoval(context.taskIntent ?? "")) {
    issues.push("PR removes multiple existing test declarations without replacing equivalent coverage. Preserve existing coverage unless the task is explicitly a test deletion/refactor.");
  }
  const changedTestPaths = changedPaths.filter(isReviewTestPath);
  const externalRepo = Boolean(String(context.repositoryIdentity ?? "").trim()) && !isPushPalsSelfRepository(context.repositoryIdentity ?? "");
  const leakedInternalSourceLayout = /(?:^|["'`\s(])(?:\.\.\/)*(?:apps\/(?:workerpals|remotebuddy|source_control_manager)|packages\/cli\/runtime\/sandbox\/apps\/(?:workerpals|remotebuddy|source_control_manager))(?:\/|["'`\s)])/im.test(addedDiffText(diff).replace(/\\/g, "/"));
  if (externalRepo && changedTestPaths.length > 0 && leakedInternalSourceLayout) {
    issues.push("User-repo tests reference PushPals' private monorepo source layout. Exercise the installed public interface instead of coupling another repository to PushPals internals.");
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
function normalizeReviewPrHeadRef(value, headPrefix = "agent/") {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const withoutPrefix = trimmed.replace(/^refs\/heads\//, "");
  const normalized = withoutPrefix.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized)
    return null;
  const normalizedHeadPrefix = String(headPrefix ?? "").trim().replace(/^refs\/heads\//, "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
  if (!normalizedHeadPrefix || !normalized.startsWith(normalizedHeadPrefix))
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
function deriveReviewTaskValidationSteps(paths, repoRoot) {
  return inferRepositoryValidationSteps({ repoRoot, changedPaths: paths, maxSteps: 4 });
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
function providerStateFeedbackKey(pr, state, jobId) {
  const normalizedHeadSha = normalizeReviewFixHeadSha(pr.head?.sha ?? "") || "unknown";
  const normalizedJobId = String(jobId ?? "").trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120);
  return `review_agent:pr:${pr.number}:head:${normalizedHeadSha}:state:${state}${normalizedJobId ? `:job:${normalizedJobId}` : ""}`;
}
function persistedLinkReconciliationKey(link) {
  return `${link.prNumber}:${link.jobId}:${link.updatedAt ?? "unknown"}`;
}
function reviewFixDedupeKey(prNumber, headSha, baseSha) {
  return [
    "review-fix",
    Math.floor(prNumber),
    normalizeReviewFixHeadSha(headSha),
    normalizeReviewFixHeadSha(baseSha)
  ].join(":");
}
function reviewRevisionFingerprint(pr) {
  return `${normalizeReviewFixHeadSha(pr.head.sha)}:${normalizeReviewFixHeadSha(pr.base.sha)}`;
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
    dedupeKey: resolutionType === "merge_conflict" ? mergeConflictDedupeKey(Math.floor(prNumber), prHeadSha, prBaseSha) : reviewFixDedupeKey(Math.floor(prNumber), prHeadSha, prBaseSha),
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
  reconciledClosedPrStates = new Map;
  attemptedClosedPrStates = new Map;
  reconciledPersistedLinkStates = new Map;
  persistedPrLinkRetries = new Map;
  persistedPrLinkCursor = null;
  openPrScanCursor = null;
  recentlyClosedPrScanCursor = null;
  lastProviderPollStartedAtMs = null;
  lastProviderPollCompletedAtMs = null;
  lastSuccessfulProviderPollAtMs = null;
  consecutiveFailedProviderPolls = 0;
  providerFailureEvents = 0;
  lastProviderError = null;
  lastOpenPrReviewNumber = null;
  reviewerMd = "";
  providerPollInFlight = false;
  reviewPollInFlight = false;
  stopped = false;
  activePollRuns = new Set;
  deps;
  headPrefix;
  constructor(config, serverUrl, githubToken, remoteUrl, prBaseBranch, authToken, deps, headPrefix = "agent/") {
    this.config = config;
    this.serverUrl = serverUrl;
    this.githubToken = githubToken;
    this.remoteUrl = remoteUrl;
    this.prBaseBranch = prBaseBranch;
    this.authToken = authToken;
    this.headPrefix = String(headPrefix ?? "").trim() || "agent/";
    const resolvedDeps = { ...DEFAULT_DEPS, ...deps ?? {} };
    const rawFeedbackFetchImpl = deps?.feedbackFetchImpl ?? deps?.fetchImpl ?? fetch;
    this.deps = {
      ...resolvedDeps,
      fetchImpl: createBoundedReviewAgentFetch(resolvedDeps.fetchImpl, {
        timeoutMs: resolvedDeps.httpTimeoutMs,
        maxResponseBytes: resolvedDeps.httpMaxResponseBytes
      }),
      feedbackFetchImpl: createBoundedReviewAgentFetch(rawFeedbackFetchImpl, {
        timeoutMs: resolvedDeps.httpTimeoutMs,
        maxResponseBytes: resolvedDeps.httpMaxResponseBytes
      })
    };
  }
  requestReReview(prNumber, sha) {
    if (this.stopped)
      return;
    const normalizedSha = String(sha ?? "").trim();
    if (!normalizedSha)
      return;
    this.forceReReview.set(prNumber, normalizedSha);
  }
  updateRuntimeConfig(nextConfig) {
    if (this.stopped)
      return { becameEnabled: false };
    const becameEnabled = !this.config.enabled && nextConfig.enabled;
    const reviewerPathChanged = String(this.config.reviewerMdPath ?? "").trim() !== String(nextConfig.reviewerMdPath ?? "").trim();
    this.config = { ...nextConfig };
    if (reviewerPathChanged)
      this.reviewerMd = "";
    return { becameEnabled };
  }
  getProviderHealthSnapshot() {
    const toIso = (value) => value === null ? null : new Date(value).toISOString();
    const rawPollAgeMs = this.providerPollInFlight && this.lastProviderPollStartedAtMs !== null ? this.deps.now() - this.lastProviderPollStartedAtMs : 0;
    const pollAgeMs = Number.isFinite(rawPollAgeMs) ? Math.max(0, rawPollAgeMs) : 0;
    const stalled = this.providerPollInFlight && pollAgeMs >= PROVIDER_RECONCILIATION_STALL_MS;
    const status = stalled ? "stalled" : this.providerPollInFlight ? "running" : this.consecutiveFailedProviderPolls > 0 ? "degraded" : this.lastProviderPollCompletedAtMs === null ? "idle" : "ok";
    return {
      status,
      inFlight: this.providerPollInFlight,
      pollAgeMs,
      stalled,
      lastPollStartedAt: toIso(this.lastProviderPollStartedAtMs),
      lastPollCompletedAt: toIso(this.lastProviderPollCompletedAtMs),
      lastSuccessfulPollAt: toIso(this.lastSuccessfulProviderPollAtMs),
      consecutiveFailedPolls: this.consecutiveFailedProviderPolls,
      failureEvents: this.providerFailureEvents,
      lastError: this.lastProviderError,
      persistedLinkRetryCount: this.persistedPrLinkRetries.size,
      persistedLinkCursor: this.persistedPrLinkCursor
    };
  }
  recordProviderFailure(context, err) {
    const detail = String(err instanceof Error ? err.message : err ?? "").trim();
    this.providerFailureEvents += 1;
    this.lastProviderError = `${context}${detail ? `: ${detail}` : ""}`.slice(0, 600);
  }
  loadReviewerMd() {
    if (this.reviewerMd)
      return this.reviewerMd;
    try {
      const mdPath = resolveReviewerMdPath(this.config.reviewerMdPath);
      this.reviewerMd = readFileSync6(mdPath, "utf-8");
      return this.reviewerMd;
    } catch (err) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] Could not load reviewer.md from ${this.config.reviewerMdPath} (cwd=${process.cwd()}): ${err?.message ?? err}`);
      return "";
    }
  }
  poll() {
    if (this.stopped)
      return Promise.resolve();
    let trackedPoll;
    trackedPoll = this.pollLanes().finally(() => {
      this.activePollRuns.delete(trackedPoll);
    });
    this.activePollRuns.add(trackedPoll);
    return trackedPoll;
  }
  async stopAndDrain() {
    this.stopped = true;
    while (this.activePollRuns.size > 0) {
      await Promise.allSettled([...this.activePollRuns]);
    }
  }
  async pollLanes() {
    const lanes = [this.pollProviderOutcomes()];
    if (this.config.enabled)
      lanes.push(this.pollOpenPrReviews());
    await Promise.all(lanes);
  }
  async pollProviderOutcomes() {
    if (this.providerPollInFlight) {
      this.deps.logInfo("[ReviewAgent] Provider reconciliation already in progress, skipping overlapping lane tick.");
      return;
    }
    const nowMs = this.deps.now();
    if (this.lastProviderPollStartedAtMs !== null && nowMs >= this.lastProviderPollStartedAtMs && nowMs - this.lastProviderPollStartedAtMs < PROVIDER_RECONCILIATION_MIN_INTERVAL_MS) {
      return;
    }
    this.lastProviderPollStartedAtMs = nowMs;
    const failureEventsAtStart = this.providerFailureEvents;
    this.providerPollInFlight = true;
    try {
      const closedPrCutoff = new Date(nowMs - CLOSED_PR_RECONCILIATION_WINDOW_MS).toISOString();
      const recentClosedPrs = this.deps.listRecentlyClosedPullRequests({
        token: this.githubToken,
        remoteUrl: this.remoteUrl,
        headPrefix: this.headPrefix,
        base: this.prBaseBranch,
        updatedSince: closedPrCutoff,
        limit: MAX_CLOSED_PR_RECONCILIATIONS_PER_POLL,
        cursor: this.recentlyClosedPrScanCursor,
        onScanComplete: (nextCursor) => {
          this.recentlyClosedPrScanCursor = nextCursor;
        }
      }).catch((err) => {
        this.recordProviderFailure("list recently closed pull requests", err);
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to list recently closed PRs for outcome reconciliation: ${err?.message ?? err}`);
        return [];
      });
      const persistedProviderOutcomes = (async () => {
        let pageLinks = [];
        try {
          const page = await this.deps.listPersistedPrLinks({
            serverUrl: this.serverUrl,
            remoteUrl: this.remoteUrl,
            authToken: this.authToken,
            fetchImpl: this.deps.fetchImpl,
            cursor: this.persistedPrLinkCursor,
            limit: MAX_PERSISTED_PR_STATE_PROBES_PER_POLL
          });
          pageLinks = page.links;
          this.persistedPrLinkCursor = page.nextCursor;
        } catch (err) {
          this.recordProviderFailure("list persisted job/PR links", err);
          this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to reconcile persisted job/PR links: ${err?.message ?? err}`);
        }
        const retryLinks = this.takeDuePersistedPrLinkRetries(nowMs);
        const uniqueLinks = new Map;
        for (const link of pageLinks) {
          if (this.persistedPrLinkRetryIsCoolingDown(link, nowMs))
            continue;
          if (!uniqueLinks.has(link.prNumber))
            uniqueLinks.set(link.prNumber, link);
        }
        for (const link of retryLinks) {
          if (!uniqueLinks.has(link.prNumber))
            uniqueLinks.set(link.prNumber, link);
        }
        return this.reconcilePersistedPrLinks([...uniqueLinks.values()], nowMs);
      })();
      const persistedAuthorityPrNumbers = await persistedProviderOutcomes;
      await this.reconcileRecentlyClosedPrFeedback(await recentClosedPrs, nowMs, new Map, persistedAuthorityPrNumbers);
    } finally {
      const completedAtMs = this.deps.now();
      this.lastProviderPollCompletedAtMs = completedAtMs;
      if (this.providerFailureEvents === failureEventsAtStart) {
        this.lastSuccessfulProviderPollAtMs = completedAtMs;
        this.consecutiveFailedProviderPolls = 0;
        this.lastProviderError = null;
      } else {
        this.consecutiveFailedProviderPolls += 1;
      }
      this.providerPollInFlight = false;
    }
  }
  takeDuePersistedPrLinkRetries(nowMs) {
    const due = [];
    for (const retry of this.persistedPrLinkRetries.values()) {
      const retryDelayMs = this.persistedPrLinkRetryDelayMs(retry.failures);
      const elapsedMs = nowMs - retry.lastAttemptedAtMs;
      if (elapsedMs >= 0 && elapsedMs < retryDelayMs)
        continue;
      due.push(retry.link);
      if (due.length >= MAX_PERSISTED_PR_RETRY_PROBES_PER_POLL)
        break;
    }
    return due;
  }
  persistedPrLinkRetryDelayMs(failures) {
    return Math.min(6 * 60 * 60000, CLOSED_PR_RECONCILIATION_RETRY_COOLDOWN_MS * 2 ** Math.min(8, Math.max(0, failures - 1)));
  }
  persistedPrLinkRetryIsCoolingDown(link, nowMs) {
    const retry = this.persistedPrLinkRetries.get(link.prNumber);
    if (!retry)
      return false;
    if (persistedLinkReconciliationKey(retry.link) !== persistedLinkReconciliationKey(link)) {
      return false;
    }
    const elapsedMs = nowMs - retry.lastAttemptedAtMs;
    return elapsedMs >= 0 && elapsedMs < this.persistedPrLinkRetryDelayMs(retry.failures);
  }
  retainPersistedPrLinkRetry(link, nowMs) {
    const prior = this.persistedPrLinkRetries.get(link.prNumber);
    this.persistedPrLinkRetries.delete(link.prNumber);
    this.persistedPrLinkRetries.set(link.prNumber, {
      link,
      lastAttemptedAtMs: nowMs,
      failures: (prior?.failures ?? 0) + 1
    });
    while (this.persistedPrLinkRetries.size > MAX_PERSISTED_PR_RETRY_QUEUE_SIZE) {
      const oldestPrNumber = this.persistedPrLinkRetries.keys().next().value;
      if (oldestPrNumber === undefined)
        break;
      this.persistedPrLinkRetries.delete(oldestPrNumber);
    }
  }
  async reconcilePersistedPrLinks(links, nowMs) {
    const resolvedCutoffMs = nowMs - CLOSED_PR_RECONCILIATION_WINDOW_MS;
    for (const [linkKey, reconciledAtMs] of this.reconciledPersistedLinkStates) {
      if (reconciledAtMs < resolvedCutoffMs || reconciledAtMs > nowMs) {
        this.reconciledPersistedLinkStates.delete(linkKey);
      }
    }
    const candidates = links.filter((link) => {
      if (!this.reconciledPersistedLinkStates.has(persistedLinkReconciliationKey(link)))
        return true;
      this.persistedPrLinkRetries.delete(link.prNumber);
      return false;
    });
    if (candidates.length === 0)
      return new Set;
    const persistedMetadata = new Map;
    const closedPrs = (await Promise.all(candidates.map(async (link) => {
      try {
        const pr = await this.deps.getPullRequest({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          prNumber: link.prNumber
        });
        if (pr.number !== link.prNumber) {
          throw new Error(`provider returned PR #${pr.number} while probing persisted PR #${link.prNumber}`);
        }
        if (String(pr.state ?? "").trim().toLowerCase() !== "closed") {
          this.persistedPrLinkRetries.delete(link.prNumber);
          return null;
        }
        persistedMetadata.set(pr.number, {
          jobId: link.jobId,
          sessionId: link.sessionId,
          allowBranchDelete: String(pr.head?.ref ?? "").startsWith(this.headPrefix) && pullRequestHeadBelongsToRemoteRepository(pr, this.remoteUrl)
        });
        return pr;
      } catch (err) {
        this.recordProviderFailure(`probe persisted PR #${link.prNumber}`, err);
        this.retainPersistedPrLinkRetry(link, nowMs);
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed persisted provider-state probe for PR #${link.prNumber}: ${err?.message ?? err}`);
        return null;
      }
    }))).filter((pr) => Boolean(pr));
    await this.reconcileRecentlyClosedPrFeedback(closedPrs, nowMs, persistedMetadata);
    for (const pr of closedPrs) {
      const providerState = pr.merged_at ? "merged" : "closed_unmerged";
      const metadata = persistedMetadata.get(pr.number);
      const link = candidates.find((candidate) => candidate.prNumber === pr.number && candidate.jobId === metadata?.jobId);
      if (link && this.reconciledClosedPrStates.has(providerStateFeedbackKey(pr, providerState, metadata?.jobId))) {
        this.reconciledPersistedLinkStates.set(persistedLinkReconciliationKey(link), nowMs);
        this.persistedPrLinkRetries.delete(pr.number);
      } else {
        if (link)
          this.retainPersistedPrLinkRetry(link, nowMs);
      }
    }
    return new Set(closedPrs.map((pr) => pr.number));
  }
  async pollOpenPrReviews() {
    if (this.reviewPollInFlight) {
      this.deps.logInfo("[ReviewAgent] Open PR review already in progress, skipping overlapping lane tick.");
      return;
    }
    this.reviewPollInFlight = true;
    try {
      let prs;
      try {
        prs = await this.deps.listOpenPullRequests({
          token: this.githubToken,
          remoteUrl: this.remoteUrl,
          headPrefix: this.headPrefix,
          base: this.prBaseBranch,
          cursor: this.openPrScanCursor,
          onScanComplete: (nextCursor) => {
            this.openPrScanCursor = nextCursor;
          }
        });
      } catch (err) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to list PRs: ${err?.message ?? err}`);
        return;
      }
      const eligible = prs.filter((pr) => {
        const reviewedRevision = this.reviewed.get(pr.number);
        const forcedSha = this.forceReReview.get(pr.number);
        return reviewedRevision !== reviewRevisionFingerprint(pr) || forcedSha === pr.head.sha;
      }).sort((a, b) => a.number - b.number);
      const startIndex = this.lastOpenPrReviewNumber == null ? 0 : Math.max(0, eligible.findIndex((pr) => pr.number > (this.lastOpenPrReviewNumber ?? -1)));
      const ordered = startIndex > 0 ? [...eligible.slice(startIndex), ...eligible.slice(0, startIndex)] : eligible;
      for (const pr of ordered.slice(0, MAX_OPEN_PR_REVIEWS_PER_LANE_RUN)) {
        this.lastOpenPrReviewNumber = pr.number;
        await this.reviewPr(pr);
      }
    } finally {
      this.reviewPollInFlight = false;
    }
  }
  async reconcileRecentlyClosedPrFeedback(prs, nowMs, persistedMetadata = new Map, skipPrNumbers = new Set) {
    const cacheCutoffMs = nowMs - CLOSED_PR_RECONCILIATION_WINDOW_MS;
    for (const [key, acknowledgedAtMs] of this.reconciledClosedPrStates) {
      if (acknowledgedAtMs < cacheCutoffMs || acknowledgedAtMs > nowMs) {
        this.reconciledClosedPrStates.delete(key);
      }
    }
    for (const [key, attempt] of this.attemptedClosedPrStates) {
      if (attempt.lastAttemptedAtMs < cacheCutoffMs)
        this.attemptedClosedPrStates.delete(key);
    }
    const freshPending = [];
    const retryPending = [];
    for (const pr of prs.slice(0, MAX_RECENTLY_CLOSED_PRS)) {
      if (skipPrNumbers.has(pr.number))
        continue;
      const bodyMetadata = extractPrMeta(pr.body);
      const authoritativeMetadata = persistedMetadata.get(pr.number);
      const jobId = authoritativeMetadata?.jobId ?? bodyMetadata.jobId;
      const sessionId = authoritativeMetadata?.sessionId ?? bodyMetadata.sessionId;
      if (!jobId) {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] Skipping closed PR #${pr.number} reconciliation: missing ${JOB_ID_MARKER} metadata.`);
        continue;
      }
      const providerState = pr.merged_at ? "merged" : "closed_unmerged";
      const stateKey = providerStateFeedbackKey(pr, providerState, jobId);
      const allowBranchDelete = authoritativeMetadata?.allowBranchDelete ?? true;
      if (this.reconciledClosedPrStates.has(stateKey))
        continue;
      const priorAttempt = this.attemptedClosedPrStates.get(stateKey);
      if (!priorAttempt) {
        freshPending.push({
          pr,
          jobId,
          sessionId,
          providerState,
          stateKey,
          allowBranchDelete
        });
        continue;
      }
      const retryDelayMs = Math.min(6 * 60 * 60000, CLOSED_PR_RECONCILIATION_RETRY_COOLDOWN_MS * 2 ** Math.min(8, Math.max(0, priorAttempt.failures - 1)));
      const elapsedSinceAttemptMs = nowMs - priorAttempt.lastAttemptedAtMs;
      if (elapsedSinceAttemptMs < 0 || elapsedSinceAttemptMs >= retryDelayMs) {
        retryPending.push({
          pr,
          jobId,
          sessionId,
          providerState,
          stateKey,
          allowBranchDelete
        });
      }
    }
    const pending = [...freshPending, ...retryPending];
    await Promise.all(pending.slice(0, MAX_CLOSED_PR_RECONCILIATIONS_PER_POLL).map(async (entry) => {
      const { pr, jobId, sessionId, providerState, stateKey, allowBranchDelete } = entry;
      const priorFailures = this.attemptedClosedPrStates.get(stateKey)?.failures ?? 0;
      this.attemptedClosedPrStates.set(stateKey, {
        lastAttemptedAtMs: nowMs,
        failures: priorFailures + 1
      });
      const feedbackAcknowledged = await this.postAutonomyPrFeedback({
        pr,
        feedbackKey: stateKey,
        verdict: providerState === "merged" ? "approved_merged" : "closed_unmerged",
        providerStateAt: providerState === "merged" ? pr.merged_at ?? undefined : pr.closed_at ?? undefined,
        verdictSummary: providerState === "merged" ? `GitHub confirms PR #${pr.number} merged${pr.merged_at ? ` at ${pr.merged_at}` : ""}.` : `GitHub confirms PR #${pr.number} closed without merge${pr.closed_at ? ` at ${pr.closed_at}` : ""}.`,
        jobId,
        sessionId
      });
      if (!feedbackAcknowledged) {
        this.recordProviderFailure(`publish provider outcome for PR #${pr.number}`);
        return;
      }
      this.attemptedClosedPrStates.delete(stateKey);
      this.reconciledClosedPrStates.set(stateKey, nowMs);
      if (allowBranchDelete) {
        await this.deletePrHeadBranch(pr, providerState === "merged" ? "merged" : "closed");
      } else {
        this.deps.logInfo(`[${ts()}] [ReviewAgent] Preserved unowned persisted PR head ${pr.head?.ref ?? "(unknown)"} after ${providerState} reconciliation for PR #${pr.number}.`);
      }
      this.reReviewEnqueueCounts.delete(pr.number);
      this.forceReReview.delete(pr.number);
      this.reviewed.delete(pr.number);
      this.deps.logInfo(`[${ts()}] [ReviewAgent] Reconciled ${providerState} outcome for closed PR #${pr.number}.`);
    }));
  }
  async reviewPr(pr) {
    const sha = pr.head.sha;
    const revisionFingerprint = reviewRevisionFingerprint(pr);
    const reviewedRevision = this.reviewed.get(pr.number);
    const forcedSha = this.forceReReview.get(pr.number);
    if (reviewedRevision !== revisionFingerprint && forcedSha) {
      this.forceReReview.delete(pr.number);
    }
    if (reviewedRevision === revisionFingerprint) {
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
      this.reviewed.set(pr.number, revisionFingerprint);
      return;
    }
    if (diff.length > MAX_DIFF_BYTES * 2) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} diff is too large (${diff.length} bytes) - skipping`);
      this.reviewed.set(pr.number, revisionFingerprint);
      return;
    }
    const deterministicHygieneIssues = collectReviewHygieneIssuesFromDiff(diff, {
      repositoryIdentity: this.remoteUrl,
      taskIntent: `${pr.title ?? ""}
${pr.body ?? ""}`
    });
    if (deterministicHygieneIssues.length > 0) {
      const verdict2 = buildDeterministicReviewHygieneVerdict(deterministicHygieneIssues, this.config.passThreshold);
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} failed deterministic hygiene gate (${deterministicHygieneIssues.length} issue(s)); skipping Codex review.`);
      const finalized2 = await this.rejectPr(pr, verdict2, diff);
      if (finalized2) {
        this.reviewed.set(pr.number, revisionFingerprint);
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
      this.reviewed.set(pr.number, revisionFingerprint);
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
      if (result.merged !== true) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] GitHub did not merge PR #${pr.number}: ${result.message || "provider returned merged=false"}`);
        return false;
      }
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} merged (score ${verdict.score.toFixed(1)}/10, sha ${String(result.sha ?? "").slice(0, 8) || "unknown"})`);
      const comments = await this.listRecentPrComments(pr.number);
      const feedbackAcknowledged = await this.postAutonomyPrFeedback({
        pr,
        feedbackKey: providerStateFeedbackKey(pr, "merged", jobId),
        verdict: "approved_merged",
        verdictSummary: verdict.summary,
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments
      });
      if (!feedbackAcknowledged) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} merged, but its autonomy outcome was not acknowledged; closed-PR reconciliation will retry it.`);
        return false;
      }
      await this.deleteMergedPrHeadBranch(pr);
      this.reReviewEnqueueCounts.delete(pr.number);
      this.forceReReview.delete(pr.number);
      this.reviewed.delete(pr.number);
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
      const feedbackAcknowledged = await this.postAutonomyPrFeedback({
        pr,
        verdict: "approved_unmergeable",
        verdictSummary: `${verdict.summary} merge blocked: ${String(mergeError?.message ?? mergeError ?? "")}`.trim(),
        reviewScore: verdict.score,
        jobId,
        sessionId,
        comments
      });
      if (!feedbackAcknowledged) {
        this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} merge-conflict feedback was not acknowledged; the unchanged PR will be reviewed again.`);
        return false;
      }
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
    const acknowledgeRejection = async () => {
      const commentAlreadyPresent = recentComments.some((comment) => collapseWhitespace(comment.body) === collapseWhitespace(rejectionComment));
      if (!commentAlreadyPresent) {
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
      }
      return this.postAutonomyPrFeedback({
        pr,
        verdict: "rejected",
        verdictSummary: effectiveVerdict.summary,
        reviewScore: effectiveVerdict.score,
        jobId,
        sessionId,
        comments: recentComments
      });
    };
    if (!sessionId) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} has no pushpals-sessionId in body - cannot re-queue`);
      return acknowledgeRejection();
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
    const existingFixJobId = await this.findActiveReviewJobIdForPrHead(pr.number, pr.head.sha, "review_fix", pr.base.sha);
    if (existingFixJobId) {
      this.deps.logInfo(`[${ts()}] [ReviewAgent] PR #${pr.number} already has active fix job ${existingFixJobId} for head ${pr.head.sha.slice(0, 8)}; skipping duplicate enqueue.`);
      return acknowledgeRejection();
    }
    const nextReReviewEnqueues = priorReReviewEnqueues + 1;
    this.reReviewEnqueueCounts.set(pr.number, nextReReviewEnqueues);
    const enqueued = await this.enqueueFixJob(pr, effectiveVerdict, sessionId, jobId, diff, [rejectionComment], recentComments);
    if (!enqueued && priorReReviewEnqueues > 0) {
      this.reReviewEnqueueCounts.set(pr.number, priorReReviewEnqueues);
    } else if (!enqueued) {
      this.reReviewEnqueueCounts.delete(pr.number);
    }
    if (!enqueued) {
      return false;
    }
    if (nextReReviewEnqueues === MAX_PR_RE_REVIEW_ENQUEUES) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} hit max re-review cap (${MAX_PR_RE_REVIEW_ENQUEUES}); future rejections will not auto-enqueue fix jobs.`);
    }
    return acknowledgeRejection();
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
    const feedbackAcknowledged = await this.postAutonomyPrFeedback({
      pr,
      feedbackKey: providerStateFeedbackKey(pr, "closed_unmerged", context.jobId),
      verdict: context.feedbackVerdict ?? "rejected_comment_cap_closed",
      verdictSummary: `${verdict.summary} | ${context.feedbackSummarySuffix ?? `closed after reaching PR comment cap (${context.maxPrCommentsBeforeGiveUp}).`}`,
      reviewScore: verdict.score,
      jobId: context.jobId,
      sessionId: context.sessionId,
      comments: context.recentComments
    });
    this.reReviewEnqueueCounts.delete(pr.number);
    this.forceReReview.delete(pr.number);
    this.reviewed.delete(pr.number);
    if (!feedbackAcknowledged) {
      this.deps.logWarn(`[${ts()}] [ReviewAgent] PR #${pr.number} closed, but its autonomy outcome was not acknowledged; closed-PR reconciliation will retry it.`);
      return false;
    }
    await this.deletePrHeadBranch(pr, "closed");
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
          if (normalizedBaseSha && context.baseSha !== normalizedBaseSha) {
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
      return false;
    const providerStateAt = String(args.providerStateAt ?? "").trim();
    const headers = { "Content-Type": "application/json" };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    const normalizedHeadSha = normalizeReviewFixHeadSha(args.pr.head.sha) || "unknown";
    const feedbackKey = String(args.feedbackKey ?? "").trim().slice(0, 512) || `review_agent:pr:${args.pr.number}:head:${normalizedHeadSha}:verdict:${normalizedVerdict}`;
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
      providerStateAt: providerStateAt || undefined,
      reviewScore: Number.isFinite(args.reviewScore) ? args.reviewScore : undefined,
      reviewThreshold: this.config.passThreshold,
      summary: summarizeFeedbackText(args.verdictSummary || args.pr.title || normalizedVerdict),
      commentCount: comments.length,
      comments
    };
    let lastFailure = "feedback acknowledgement missing";
    let attemptsMade = 0;
    for (let attempt = 1;attempt <= AUTONOMY_FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
      attemptsMade = attempt;
      const retryDelayMs = AUTONOMY_FEEDBACK_RETRY_DELAYS_MS[attempt - 1] ?? 0;
      if (retryDelayMs > 0)
        await this.deps.sleep(retryDelayMs);
      let retryable = true;
      try {
        const response = await this.deps.feedbackFetchImpl(`${this.serverUrl}/autonomy/pr-feedback`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
        const responseText = await response.text().catch(() => "");
        if (response.ok) {
          let acknowledgement = null;
          try {
            const parsed = responseText ? JSON.parse(responseText) : null;
            acknowledgement = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
          } catch {
            acknowledgement = null;
          }
          if (acknowledgement?.ok === true && (acknowledgement.ignored !== true || acknowledgement.acknowledged === true)) {
            return true;
          }
          lastFailure = acknowledgement?.ignored === true ? "server returned ignored=true" : "server response did not contain a positive acknowledgement";
          if (acknowledgement?.ignored === true)
            retryable = false;
        } else {
          lastFailure = `HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`;
          retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        }
      } catch (err) {
        lastFailure = String(err?.message ?? err);
      }
      if (!retryable || attempt >= AUTONOMY_FEEDBACK_MAX_ATTEMPTS)
        break;
    }
    this.deps.logWarn(`[${ts()}] [ReviewAgent] Failed to post acknowledged autonomy PR feedback for PR #${args.pr.number} after ${attemptsMade} bounded attempt(s): ${lastFailure}`);
    return false;
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
    const validationSteps2 = deriveReviewTaskValidationSteps(changedPaths, this.deps.validationRepoRoot());
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref, this.headPrefix);
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
      workClass: "repair",
      repositoryIdentity: this.remoteUrl,
      prUrl: pr.html_url,
      dedupeKey: reviewFixDedupeKey(pr.number, pr.head.sha, pr.base.sha),
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
          queuePriority: "interactive",
          workClass: "repair",
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
          branchPrefix: this.headPrefix,
          prNumber: pr.number,
          prUrl: pr.html_url,
          repositoryIdentity: this.remoteUrl,
          prHeadSha: normalizeReviewFixHeadSha(pr.head.sha),
          prBaseSha: normalizeReviewFixHeadSha(pr.base.sha),
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
    const requestBody = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };
    if (this.deps.scmRepairAuthoritySecret) {
      headers[SCM_REPAIR_AUTHORITY_HEADER] = createScmRepairAuthorityProof(payload, this.deps.scmRepairAuthoritySecret);
    }
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: requestBody
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      const responseBody = await response.json().catch(() => null);
      const enqueuedJobId = responseBody && typeof responseBody.jobId === "string" ? responseBody.jobId.trim() : "";
      const deduped = responseBody?.deduped === true;
      const dedupeMessage = responseBody && typeof responseBody.message === "string" ? responseBody.message : "";
      if (!enqueuedJobId) {
        throw new Error("Server accepted repair enqueue without returning a jobId; exact repair ownership is unconfirmed");
      }
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
    const validationSteps2 = deriveReviewTaskValidationSteps(changedPaths, this.deps.validationRepoRoot());
    const prHeadRef = normalizeReviewPrHeadRef(pr.head.ref, this.headPrefix);
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
      workClass: "repair",
      repositoryIdentity: this.remoteUrl,
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
          queuePriority: "interactive",
          workClass: "repair",
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
          branchPrefix: this.headPrefix,
          prNumber: pr.number,
          prUrl: pr.html_url,
          repositoryIdentity: this.remoteUrl,
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
    const requestBody = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };
    if (this.deps.scmRepairAuthoritySecret) {
      headers[SCM_REPAIR_AUTHORITY_HEADER] = createScmRepairAuthorityProof(payload, this.deps.scmRepairAuthoritySecret);
    }
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    try {
      const response = await this.deps.fetchImpl(`${this.serverUrl}/jobs/enqueue`, {
        method: "POST",
        headers,
        body: requestBody
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
function normalizeSha2(value) {
  const sha = value.trim().toLowerCase();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : "";
}
function parseReviewPublicationLease(prBody) {
  const body = String(prBody ?? "");
  const targetBranch = normalizeBranch2(metadataValue(body, "pushpals-reviewTargetBranch"));
  const baseBranch = normalizeBranch2(metadataValue(body, "pushpals-reviewBaseBranch"));
  const expectedHeadSha = normalizeSha2(metadataValue(body, "pushpals-reviewExpectedHeadSha"));
  const expectedBaseSha = normalizeSha2(metadataValue(body, "pushpals-reviewExpectedBaseSha"));
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
  return normalizeSha2(String(resolvedSha ?? "")) === normalizeSha2(expectedSha);
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
function reviewApplyFailureBlocksPublication(input) {
  const combined = [input.applyStderr ?? "", input.applyStdout ?? ""].filter(Boolean).join(`
`);
  isCherryPickConflictOutput(combined);
  return true;
}

// apps/source_control_manager/src/runtime_helpers.ts
function buildReviewAgentRuntimeFingerprint(params) {
  return JSON.stringify({
    serverUrl: params.serverUrl,
    remoteUrl: params.remoteUrl,
    prBaseBranch: params.prBaseBranch,
    branchPrefix: params.branchPrefix,
    pollIntervalMs: params.reviewAgent.pollIntervalMs,
    gitProviderToken: params.gitProviderToken,
    serverAuthToken: params.serverAuthToken ?? ""
  });
}
function createBlockedReviewProviderHealth(reason) {
  return {
    status: "degraded",
    inFlight: false,
    pollAgeMs: 0,
    stalled: false,
    lastPollStartedAt: null,
    lastPollCompletedAt: null,
    lastSuccessfulPollAt: null,
    consecutiveFailedPolls: 1,
    failureEvents: 1,
    lastError: String(reason || "review provider reconciliation is blocked").slice(0, 600),
    persistedLinkRetryCount: 0,
    persistedLinkCursor: null
  };
}
function withReviewProviderHealth(snapshot, reviewProvider) {
  const providerStalled = reviewProvider?.stalled === true;
  const degradedComponents = new Set(snapshot.degradedComponents ?? []);
  if (reviewProvider && (reviewProvider.status === "degraded" || reviewProvider.status === "stalled" || reviewProvider.consecutiveFailedPolls > 0)) {
    degradedComponents.add("review_provider");
  } else {
    degradedComponents.delete("review_provider");
  }
  return {
    ...snapshot,
    healthy: snapshot.healthy && !providerStalled,
    status: snapshot.healthy && providerStalled ? "unhealthy" : snapshot.status,
    reason: snapshot.reason ?? (providerStalled ? `review_provider_reconciliation_stalled_${reviewProvider.pollAgeMs}ms` : null),
    reviewProvider: reviewProvider ? { ...reviewProvider } : null,
    degradedComponents: [...degradedComponents]
  };
}
function createSourceControlManagerHealthTracker(options) {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  let lastTickStartedAtMs = null;
  let lastTickCompletedAtMs = null;
  let lastProgressAtMs = startedAtMs;
  let activeTick = false;
  let activeCompletionId = null;
  let phase = "startup";
  let publication = null;
  const toIso = (value) => value === null ? null : new Date(value).toISOString();
  return {
    beginTick(nextPhase = "polling") {
      const at = now();
      activeTick = true;
      activeCompletionId = null;
      phase = nextPhase;
      lastTickStartedAtMs = at;
      lastProgressAtMs = at;
    },
    progress(nextPhase, completionId) {
      phase = String(nextPhase || phase);
      if (completionId !== undefined)
        activeCompletionId = completionId;
      lastProgressAtMs = now();
    },
    completeTick() {
      const at = now();
      activeTick = false;
      activeCompletionId = null;
      phase = "idle";
      lastTickCompletedAtMs = at;
      lastProgressAtMs = at;
    },
    updatePublication(nextPublication) {
      publication = nextPublication ? { ...nextPublication } : null;
    },
    snapshot() {
      const at = now();
      const progressAgeMs = Math.max(0, at - lastProgressAtMs);
      let reason = null;
      if (activeTick && progressAgeMs >= Math.max(1000, options.tickStallMs)) {
        reason = `tick_stalled_${progressAgeMs}ms_phase_${phase}`;
      } else if (publication?.unhealthy && !activeTick) {
        const idleSince = lastTickCompletedAtMs ?? startedAtMs;
        const idleAgeMs = Math.max(0, at - idleSince);
        if (idleAgeMs >= Math.max(1000, options.idleBacklogGraceMs)) {
          reason = `publication_backlog_stalled_${publication.backlog}_oldest_${Math.max(publication.oldestPendingAgeMs, publication.oldestFinalizingAgeMs)}ms`;
        }
      }
      return {
        healthy: reason === null,
        status: reason === null ? "ok" : "unhealthy",
        reason,
        startedAt: new Date(startedAtMs).toISOString(),
        lastTickStartedAt: toIso(lastTickStartedAtMs),
        lastTickCompletedAt: toIso(lastTickCompletedAtMs),
        lastProgressAt: new Date(lastProgressAtMs).toISOString(),
        activeTick,
        activeCompletionId,
        phase,
        publication: publication ? { ...publication } : null,
        reviewProvider: null
      };
    }
  };
}
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
function isRecord2(value) {
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
  if (!isRecord2(statusPayload))
    return [];
  const clients = statusPayload.clients;
  if (!isRecord2(clients) || !Array.isArray(clients.items))
    return [];
  return clients.items.filter((row) => isRecord2(row));
}
function getFiniteNonNegativeNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0)
    return null;
  return numberValue;
}
function getWorkerCapacity(statusPayload) {
  if (!isRecord2(statusPayload) || !isRecord2(statusPayload.workers)) {
    return { online: null, idle: null };
  }
  return {
    online: getFiniteNonNegativeNumber(statusPayload.workers.online),
    idle: getFiniteNonNegativeNumber(statusPayload.workers.idle)
  };
}
function summarizeReviewAgentRuntimeReadiness(statusPayload, sessionId) {
  if (!isRecord2(statusPayload) || statusPayload.ok !== true) {
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
  try {
    const headers = {};
    if (options.authToken)
      headers.Authorization = `Bearer ${options.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${options.serverUrl.replace(/\/+$/, "")}/system/status`,
      init: { headers },
      timeoutMs,
      fetchImpl,
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMessage: `system status probe timed out after ${timeoutMs}ms`
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
  }
}

// apps/source_control_manager/src/http.ts
function createStatusServer(db, port, healthProvider = () => ({
  healthy: true,
  status: "ok",
  reason: null,
  startedAt: new Date().toISOString(),
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastProgressAt: new Date().toISOString(),
  activeTick: false,
  activeCompletionId: null,
  phase: "unknown",
  publication: null,
  reviewProvider: null
})) {
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
        const health = healthProvider();
        return Response.json({ ...health, pid: process.pid }, { status: health.healthy ? 200 : 503, headers });
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
import { resolve as resolve8 } from "path";
function resolveSourceControlManagerRuntimeRepoRoot(projectRoot, fallbackCwd = process.cwd()) {
  const configuredRoot = String(projectRoot ?? "").trim();
  if (configuredRoot) {
    return resolve8(configuredRoot);
  }
  return resolve8(fallbackCwd);
}

// apps/source_control_manager/src/completion_callback.ts
async function parseCompletionPositiveAck(response) {
  const payload = await response.json().catch(() => null);
  const explicitlyAcknowledged = typeof payload === "object" && payload !== null && !Array.isArray(payload) && payload.ok === true;
  return {
    ok: response.ok && explicitlyAcknowledged,
    status: response.status
  };
}
async function withHardDeadline(operation, timeoutMs, timeoutMessage = "operation timed out") {
  const controller = new AbortController;
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, Math.max(1, Math.floor(timeoutMs)));
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
async function postCompletionCallbackWithRetry(options) {
  const attempts = Math.max(1, Math.min(5, Math.floor(options.attempts ?? 3)));
  const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 5000));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 200));
  const wait = options.wait ?? ((delayMs) => Bun.sleep(delayMs));
  let lastStatus = null;
  let lastError = null;
  let attempted = 0;
  for (let attempt = 1;attempt <= attempts; attempt += 1) {
    attempted = attempt;
    try {
      const response = await withHardDeadline(options.request, timeoutMs, `completion callback timed out after ${timeoutMs}ms`);
      lastStatus = response.status;
      lastError = null;
      if (response.ok) {
        return { confirmed: true, attempts: attempt, lastStatus, lastError };
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408)
        break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts && retryDelayMs > 0) {
      await wait(retryDelayMs * attempt);
    }
  }
  return { confirmed: false, attempts: attempted, lastStatus, lastError };
}
var postCompletionProcessedWithRetry = postCompletionCallbackWithRetry;

// apps/source_control_manager/src/completion_gc.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "crypto";
import {
  closeSync as closeSync2,
  existsSync as existsSync6,
  fsyncSync,
  mkdirSync as mkdirSync3,
  openSync as openSync2,
  readFileSync as readFileSync7,
  readdirSync as readdirSync2,
  renameSync,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync3
} from "fs";
import { join as join6 } from "path";
var COMPLETION_GC_VERSION = 1;
var SHA_RE2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
var SAFE_COMPLETION_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
var SAFE_REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
var SAFE_PUSHPALS_REF_RE = /^refs\/pushpals\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
var SAFE_VALIDATION_REF_RE = /^refs\/pushpals\/validation\/[0-9a-f]{32}\/[1-9][0-9]*\/(?:baseline|candidate|validated)$/i;
var MAX_ADDITIONAL_VALIDATION_REFS = 24;
function validationNamespace(completionId) {
  const key = createHash2("sha256").update(completionId).digest("hex").slice(0, 32);
  return `refs/pushpals/validation/${key}`;
}
function isSafePushpalsRef(value) {
  return SAFE_PUSHPALS_REF_RE.test(value) && !value.includes("..") && !value.includes("//") && !value.includes("@{") && !value.endsWith("/") && !value.endsWith(".") && !value.split("/").some((part) => part.endsWith(".lock"));
}
function normalizeRecord(input) {
  if (input?.version !== COMPLETION_GC_VERSION) {
    throw new Error("Completion GC record has an unsupported version.");
  }
  const completionId = String(input?.completionId ?? "").trim();
  if (!SAFE_COMPLETION_ID_RE.test(completionId)) {
    throw new Error("Completion GC record has an invalid completion ID.");
  }
  const completionBranch = String(input?.completionBranch ?? "").trim();
  if (!completionBranch || completionBranch.length > 512 || /[\u0000-\u001f\u007f]/.test(completionBranch)) {
    throw new Error(`Completion GC record ${completionId} has an invalid completion branch.`);
  }
  if (completionBranch.startsWith("refs/pushpals/") && !isSafePushpalsRef(completionBranch)) {
    throw new Error(`Completion GC record ${completionId} has an unsafe PushPals ref.`);
  }
  const commitSha = String(input?.commitSha ?? "").trim().toLowerCase();
  if (!SHA_RE2.test(commitSha)) {
    throw new Error(`Completion GC record ${completionId} has an invalid commit SHA.`);
  }
  const claimGeneration = Number(input?.claimGeneration);
  if (!Number.isSafeInteger(claimGeneration) || claimGeneration < 1) {
    throw new Error(`Completion GC record ${completionId} has an invalid claim generation.`);
  }
  const remote = input?.remote === null ? null : String(input?.remote ?? "").trim();
  if (remote !== null && (!SAFE_REMOTE_RE.test(remote) || remote.includes("..") || remote.includes("//"))) {
    throw new Error(`Completion GC record ${completionId} has an invalid remote.`);
  }
  if (remote !== null && !isSafePushpalsRef(completionBranch)) {
    throw new Error(`Completion GC record ${completionId} cannot delete a non-PushPals remote ref.`);
  }
  const additionalValidationRefs = [
    ...new Set((Array.isArray(input?.additionalValidationRefs) ? input.additionalValidationRefs : []).map((value) => String(value ?? "").trim()))
  ].sort((a, b) => a.localeCompare(b));
  if (additionalValidationRefs.length > MAX_ADDITIONAL_VALIDATION_REFS) {
    throw new Error(`Completion GC record ${completionId} has too many retained validation refs.`);
  }
  for (const ref of additionalValidationRefs) {
    if (!isSafePushpalsRef(ref) || !SAFE_VALIDATION_REF_RE.test(ref)) {
      throw new Error(`Completion GC record ${completionId} contains an invalid validation checkpoint ref.`);
    }
  }
  const createdAt = String(input?.createdAt ?? "").trim();
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`Completion GC record ${completionId} has an invalid creation time.`);
  }
  return {
    version: COMPLETION_GC_VERSION,
    completionId,
    completionBranch,
    commitSha,
    claimGeneration,
    remote,
    additionalValidationRefs,
    createdAt
  };
}
function sameRecord(left, right) {
  return left.completionId === right.completionId && left.completionBranch === right.completionBranch && left.commitSha === right.commitSha && left.claimGeneration === right.claimGeneration && left.remote === right.remote && left.additionalValidationRefs.join(`
`) === right.additionalValidationRefs.join(`
`);
}
function createCompletionGcRecord(input) {
  return normalizeRecord({
    version: COMPLETION_GC_VERSION,
    completionId: input.completionId,
    completionBranch: input.completionBranch,
    commitSha: input.commitSha,
    claimGeneration: input.claimGeneration,
    remote: input.remote ?? null,
    additionalValidationRefs: input.additionalValidationRefs ?? [],
    createdAt: input.createdAt ?? new Date().toISOString()
  });
}
function completionGcValidationNamespace(record) {
  return validationNamespace(record.completionId);
}
function completionGcAuthorityConfirmsProcessed(record, authority) {
  if (!authority || authority.status !== "processed")
    return false;
  const authoritySha = String(authority.commitSha ?? "").trim().toLowerCase();
  const authorityGeneration = Number(authority.claimGeneration);
  return authority.id === record.completionId && authority.branch === record.completionBranch && authoritySha === record.commitSha && Number.isSafeInteger(authorityGeneration) && authorityGeneration >= record.claimGeneration;
}
function buildCompletionGcLocalDeleteArgs(record, resolvedSha) {
  if (!record.completionBranch.startsWith("refs/pushpals/"))
    return null;
  const normalizedResolvedSha = String(resolvedSha ?? "").trim().toLowerCase();
  if (normalizedResolvedSha !== record.commitSha)
    return null;
  return ["update-ref", "-d", record.completionBranch, record.commitSha];
}
function buildCompletionGcRemoteDeleteArgs(record, resolvedSha) {
  if (!record.remote)
    return null;
  const normalizedResolvedSha = String(resolvedSha ?? "").trim().toLowerCase();
  if (normalizedResolvedSha !== record.commitSha)
    return null;
  return [
    "push",
    `--force-with-lease=${record.completionBranch}:${record.commitSha}`,
    record.remote,
    `:${record.completionBranch}`
  ];
}

class CompletionGcJournal {
  directory;
  cursor = 0;
  constructor(stateDir) {
    this.directory = join6(stateDir, "completion-ref-gc");
    mkdirSync3(this.directory, { recursive: true });
  }
  pathFor(record) {
    const key = createHash2("sha256").update(record.completionId).digest("hex").slice(0, 32);
    return join6(this.directory, `${key}-${record.claimGeneration}.json`);
  }
  enqueue(input) {
    const record = normalizeRecord(input);
    const destination = this.pathFor(record);
    if (existsSync6(destination)) {
      const existing = normalizeRecord(JSON.parse(readFileSync7(destination, "utf8")));
      if (!sameRecord(existing, record)) {
        throw new Error(`Completion GC record ${record.completionId}/${record.claimGeneration} conflicts with an existing durable record.`);
      }
      return existing;
    }
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID2()}`;
    let fd = null;
    try {
      fd = openSync2(temporary, "wx", 384);
      writeFileSync3(fd, `${JSON.stringify(record)}
`, "utf8");
      fsyncSync(fd);
      closeSync2(fd);
      fd = null;
      renameSync(temporary, destination);
      return record;
    } catch (error) {
      if (fd !== null)
        closeSync2(fd);
      try {
        unlinkSync3(temporary);
      } catch {}
      if (existsSync6(destination)) {
        const existing = normalizeRecord(JSON.parse(readFileSync7(destination, "utf8")));
        if (sameRecord(existing, record))
          return existing;
      }
      throw error;
    }
  }
  list(limit = 4, onWarning = () => {
    return;
  }) {
    const names = readdirSync2(this.directory).filter((name) => /^[0-9a-f]{32}-[1-9][0-9]*\.json$/i.test(name)).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      this.cursor = 0;
      return [];
    }
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    const selectedCount = Math.min(boundedLimit, names.length);
    const start = this.cursor % names.length;
    const selected = Array.from({ length: selectedCount }, (_unused, index) => names[(start + index) % names.length]);
    this.cursor = (start + selectedCount) % names.length;
    const records = [];
    for (const name of selected) {
      const path = join6(this.directory, name);
      try {
        const record = normalizeRecord(JSON.parse(readFileSync7(path, "utf8")));
        if (this.pathFor(record) !== path) {
          throw new Error("record identity does not match its journal filename");
        }
        records.push(record);
      } catch (error) {
        onWarning(`Ignoring invalid completion GC journal ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }
  remove(record) {
    try {
      unlinkSync3(this.pathFor(normalizeRecord(record)));
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw error;
    }
  }
}
async function reconcileCompletionGcJournal(options) {
  const onWarning = options.onWarning ?? (() => {
    return;
  });
  const records = options.journal.list(options.limit ?? 4, onWarning);
  const result = {
    examined: records.length,
    cleaned: 0,
    retained: 0,
    uncertain: 0
  };
  const authorityResults = await Promise.all(records.map(async (record) => {
    try {
      return { record, authority: await options.resolveAuthority(record), error: null };
    } catch (error) {
      return { record, authority: null, error };
    }
  }));
  for (const authorityResult of authorityResults) {
    const { record, authority, error } = authorityResult;
    if (error) {
      result.uncertain += 1;
      result.retained += 1;
      onWarning(`Completion ${record.completionId} cleanup authority is unreachable; retaining refs: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!completionGcAuthorityConfirmsProcessed(record, authority)) {
      result.retained += 1;
      continue;
    }
    try {
      const cleaned = await options.cleanup(record);
      if (!cleaned) {
        result.retained += 1;
        continue;
      }
      options.journal.remove(record);
      result.cleaned += 1;
    } catch (cleanupError) {
      result.retained += 1;
      onWarning(`Completion ${record.completionId} ref cleanup failed and will be retried: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
  return result;
}
async function claimBeforeCompletionGc(options) {
  const result = await options.claim();
  if (options.isIdle(result))
    await options.reconcile();
  return result;
}

// apps/source_control_manager/src/completion_lease.ts
async function parseCompletionLeaseRenewalResponse(response) {
  const acknowledgement = await parseCompletionPositiveAck(response);
  if (acknowledgement.ok)
    return { ok: true };
  const malformedPositiveResponse = response.ok;
  return {
    ok: false,
    leaseLost: response.status === 409,
    detail: malformedPositiveResponse ? `Completion publication lease renewal returned HTTP ${response.status} without an explicit positive acknowledgement.` : `Completion publication lease could not be renewed (HTTP ${response.status}).`
  };
}

class CompletionLeaseRenewalCoordinator {
  attempt;
  inFlight = null;
  lastFailureDetail = null;
  leaseLost = false;
  constructor(attempt) {
    this.attempt = attempt;
  }
  async renew(required = false) {
    if (this.leaseLost) {
      const detail = this.lastFailureDetail ?? "Completion publication lease was permanently lost.";
      if (required)
        throw new Error(detail);
      return false;
    }
    try {
      const result = await this.sharedAttempt();
      if (result.ok) {
        this.lastFailureDetail = null;
        return true;
      }
      this.lastFailureDetail = String(result.detail ?? "").trim() || "Completion publication lease was not renewed.";
      if (result.leaseLost)
        this.leaseLost = true;
      if (required)
        throw new Error(this.lastFailureDetail);
      return false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastFailureDetail = detail || "Completion publication lease renewal failed.";
      if (required)
        throw error;
      return false;
    }
  }
  failureDetail() {
    return this.lastFailureDetail;
  }
  hasLostLease() {
    return this.leaseLost;
  }
  sharedAttempt() {
    if (this.inFlight)
      return this.inFlight;
    const attempt = Promise.resolve().then(() => this.attempt());
    this.inFlight = attempt;
    attempt.then(() => {
      if (this.inFlight === attempt)
        this.inFlight = null;
    }, () => {
      if (this.inFlight === attempt)
        this.inFlight = null;
    });
    return attempt;
  }
}

// apps/source_control_manager/src/publication_recovery.ts
var DEFAULT_PUBLICATION_PROOF_ATTEMPTS = 5;
var DEFAULT_PUBLICATION_PROOF_INITIAL_DELAY_MS = 250;
var DEFAULT_PUBLICATION_PROOF_MAX_DELAY_MS = 2000;

class PublicationAuthorityUnreachableError extends Error {
  mutationError;
  probeError;
  constructor(options) {
    const probeDetail = options.probeError instanceof Error ? options.probeError.message : String(options.probeError ?? "unknown authority error");
    super(`${options.failurePrefix}; authoritative publication state is unreachable: ${probeDetail}`);
    this.name = "PublicationAuthorityUnreachableError";
    this.mutationError = options.mutationError;
    this.probeError = options.probeError;
  }
}

class PublicationConfirmationPendingError extends Error {
  proofAttempts;
  lastProbeError;
  constructor(options) {
    super(`${options.failurePrefix}; the publication command succeeded, but the authoritative ref did not expose the exact candidate after ${options.proofAttempts} bounded proof attempt(s).`);
    this.name = "PublicationConfirmationPendingError";
    this.proofAttempts = options.proofAttempts;
    this.lastProbeError = options.lastProbeError ?? null;
  }
}

class PublicationProofLostError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicationProofLostError";
  }
}
function authoritativeGitFailureDetail(result) {
  return [result.stderr, result.stdout].filter(Boolean).join(`
`).trim() || "no output";
}
function authoritativeRefShaFromGitResult(result, label) {
  if (!result.ok) {
    if (result.exitCode === 1)
      return null;
    throw new Error(`Authoritative ref probe failed for ${label} (exit ${result.exitCode}): ${authoritativeGitFailureDetail(result)}`);
  }
  const sha = String(result.stdout ?? "").trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error(`Authoritative ref probe for ${label} returned a non-commit SHA.`);
  }
  return sha;
}
function authoritativeAncestryFromGitResult(result, label) {
  if (result.ok)
    return true;
  if (result.exitCode === 1)
    return false;
  throw new Error(`Authoritative ancestry probe failed for ${label} (exit ${result.exitCode}): ${authoritativeGitFailureDetail(result)}`);
}
function publicationFailureDisposition(options) {
  if (options.publicationReadyForFinalization || options.authoritativeReprobe === "published") {
    return "finalize";
  }
  if (options.validatedCheckpointRecoveryPending)
    return "reconcile";
  if (options.publicationConfirmationPending)
    return "reconcile";
  if (options.publicationAttemptUncertain && options.authoritativeReprobe === "unreachable") {
    return "reconcile";
  }
  return "fail";
}
async function assertFinalAuthoritativePublicationProof(options) {
  let published;
  try {
    published = await options.provePublished();
  } catch (probeError) {
    throw new PublicationAuthorityUnreachableError({
      failurePrefix: options.failurePrefix,
      probeError
    });
  }
  if (!published) {
    throw new PublicationProofLostError(options.failurePrefix);
  }
}
function durablePublicationRecoveryState(durablePublicationProven) {
  return {
    skipPublicationMutation: durablePublicationProven,
    protectFromTerminalFailure: durablePublicationProven
  };
}
function shouldSkipValidationForDurableRecovery(options) {
  return options.validationProven && options.publicationProven;
}
function positiveIntegerOrDefault(value, fallback) {
  if (!Number.isFinite(value) || Number(value) <= 0)
    return fallback;
  return Math.max(1, Math.floor(Number(value)));
}
function nonNegativeIntegerOrDefault(value, fallback) {
  if (!Number.isFinite(value) || Number(value) < 0)
    return fallback;
  return Math.floor(Number(value));
}
async function provePublicationWithBoundedRetry(options) {
  const attempts = positiveIntegerOrDefault(options.retry?.attempts, DEFAULT_PUBLICATION_PROOF_ATTEMPTS);
  const initialDelayMs = nonNegativeIntegerOrDefault(options.retry?.initialDelayMs, DEFAULT_PUBLICATION_PROOF_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, nonNegativeIntegerOrDefault(options.retry?.maxDelayMs, DEFAULT_PUBLICATION_PROOF_MAX_DELAY_MS));
  const wait = options.retry?.wait ?? ((delayMs) => Bun.sleep(delayMs));
  let lastProbeError = null;
  for (let attempt = 1;attempt <= attempts; attempt += 1) {
    try {
      if (await options.provePublished()) {
        return { published: true, attempts: attempt, lastProbeError: null };
      }
      lastProbeError = null;
    } catch (error) {
      return { published: false, attempts: attempt, lastProbeError: error };
    }
    if (attempt < attempts) {
      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await wait(delayMs);
    }
  }
  return { published: false, attempts, lastProbeError };
}
async function publishWithAuthoritativeProof(options) {
  let result;
  try {
    result = await options.mutate();
  } catch (error) {
    const proof2 = await provePublicationWithBoundedRetry({
      provePublished: options.provePublished,
      retry: options.proofRetry
    });
    if (proof2.lastProbeError) {
      throw new PublicationAuthorityUnreachableError({
        failurePrefix: options.failurePrefix,
        mutationError: error,
        probeError: proof2.lastProbeError
      });
    }
    if (proof2.published) {
      return {
        result: {
          ok: false,
          stderr: error instanceof Error ? error.message : String(error)
        },
        recoveredFromAmbiguousFailure: true
      };
    }
    throw error;
  }
  const proof = await provePublicationWithBoundedRetry({
    provePublished: options.provePublished,
    retry: options.proofRetry
  });
  if (proof.published) {
    return { result, recoveredFromAmbiguousFailure: !result.ok };
  }
  if (result.ok) {
    throw new PublicationConfirmationPendingError({
      failurePrefix: options.failurePrefix,
      proofAttempts: proof.attempts,
      lastProbeError: proof.lastProbeError
    });
  }
  if (proof.lastProbeError) {
    throw new PublicationAuthorityUnreachableError({
      failurePrefix: options.failurePrefix,
      probeError: proof.lastProbeError
    });
  }
  const detail = [result.stderr, result.stdout].filter(Boolean).join(`
`).trim();
  throw new Error(`${options.failurePrefix}${detail ? `: ${detail}` : ""}`);
}
async function isValidationCheckpointPublished(options) {
  const candidateSha = String(options.candidateSha ?? "").trim();
  if (!candidateSha)
    return false;
  const publicationHead = options.useReviewPublicationFlow ? options.reviewRemoteHeadSha : options.pushMainAfterMerge ? options.remoteIntegrationHeadSha : options.localIntegrationHeadSha;
  const normalizedHead = String(publicationHead ?? "").trim();
  if (!normalizedHead)
    return false;
  if (options.useReviewPublicationFlow) {
    return normalizedHead.toLowerCase() === candidateSha.toLowerCase();
  }
  return options.isAncestor(candidateSha, normalizedHead);
}

// apps/source_control_manager/src/trusted_validation.ts
import { createHash as createHash3 } from "crypto";
import { existsSync as existsSync7, readFileSync as readFileSync8, rmSync, writeFileSync as writeFileSync4 } from "fs";
import { basename as basename3, resolve as resolve9 } from "path";
var DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS = 8 * 60000;
var PROCESS_STREAM_DRAIN_GRACE_MS = 2000;
var PROCESS_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
var TRUSTED_INSTALL_MARKER = ".pushpals-trusted-install.json";
var trustedInstallFlights = new Map;
var BUN_DEPENDENCY_COMMANDS = new Set([
  "bun",
  "bunx",
  "eslint",
  "jest",
  "node",
  "npm",
  "npx",
  "tsc",
  "vitest"
]);
function emitTrustedValidationProgress(callback, event) {
  try {
    callback?.(event);
  } catch {}
}
function trustedValidationHealthPhase(event) {
  return `trusted_validation_${event.phase}_${event.boundary}_attempt_${event.attempt}`;
}
function resolveTrustedValidationOutcome(results) {
  const terminalByCommand = new Map;
  for (const result of results) {
    terminalByCommand.set(`${result.phase}\x00${result.command}`, result);
  }
  const terminalResults = [...terminalByCommand.values()];
  return {
    terminalResults,
    terminalFailure: terminalResults.find((result) => !result.ok) ?? null
  };
}
function currentBunExecutable(explicit) {
  const configured = String(explicit ?? process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (configured)
    return configured;
  const execPath = String(process.execPath ?? "").trim();
  return /^(?:bun|bun\.exe)$/i.test(basename3(execPath)) ? execPath : "";
}
function resolveTrustedValidationArgv(argv, bunExecutable) {
  if (argv.length === 0)
    return [];
  const bun = currentBunExecutable(bunExecutable);
  if (!bun)
    return [...argv];
  const executable = String(argv[0] ?? "").trim().toLowerCase();
  if (executable === "bun" || executable === "bun.exe") {
    return [bun, ...argv.slice(1)];
  }
  if (executable === "bunx" || executable === "bunx.exe") {
    return [bun, "x", ...argv.slice(1)];
  }
  return [...argv];
}
function resolveTrustedValidationPreparationArgv(options) {
  const hasBunProject = existsSync7(`${options.repoPath}/package.json`) && (existsSync7(`${options.repoPath}/bun.lock`) || existsSync7(`${options.repoPath}/bun.lockb`));
  const needsDependencies = options.commandArgv.some((argv) => BUN_DEPENDENCY_COMMANDS.has(String(argv[0] ?? "").trim().toLowerCase()));
  if (!hasBunProject || !needsDependencies)
    return null;
  const bun = currentBunExecutable(options.bunExecutable);
  return [bun || "bun", "install", "--frozen-lockfile"];
}
function normalizeTrustedValidationAffectedPaths(paths) {
  return [
    ...new Set(paths.map((value) => String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "")).filter((value) => value.length > 0 && value !== "."))
  ].sort((left, right) => left.localeCompare(right));
}
function trustedValidationInstallFingerprint(options) {
  const candidateSha = String(options.invariantContext?.candidateSha ?? "").trim().toLowerCase();
  const baseSha = String(options.invariantContext?.baseSha ?? "").trim().toLowerCase();
  if (!candidateSha || !baseSha)
    return null;
  const packagePath = resolve9(options.repoPath, "package.json");
  const lockPath = [
    resolve9(options.repoPath, "bun.lock"),
    resolve9(options.repoPath, "bun.lockb")
  ].find((path) => existsSync7(path));
  if (!existsSync7(packagePath) || !lockPath)
    return null;
  const hash = createHash3("sha256");
  hash.update(`platform=${process.platform}-${process.arch}
`);
  hash.update(`bun=${currentBunExecutable(options.bunExecutable) || "bun"}
`);
  hash.update(`version=${typeof Bun !== "undefined" ? Bun.version : "unknown"}
`);
  if (options.invariantContext) {
    hash.update(`candidate=${candidateSha}
`);
    hash.update(`base=${baseSha}
`);
    hash.update(`affected=${JSON.stringify(normalizeTrustedValidationAffectedPaths(options.invariantContext.affectedPaths))}
`);
  }
  hash.update(readFileSync8(packagePath));
  hash.update("\x00");
  hash.update(readFileSync8(lockPath));
  return hash.digest("hex");
}
function trustedInstallMarkerPath(repoPath) {
  return resolve9(repoPath, "node_modules", TRUSTED_INSTALL_MARKER);
}
function invalidateTrustedInstallMarker(repoPath) {
  const markerPath = trustedInstallMarkerPath(repoPath);
  rmSync(markerPath, { force: true });
  if (existsSync7(markerPath)) {
    throw new Error("Could not invalidate the prior trusted dependency install marker.");
  }
}
function hasFreshTrustedValidationInstall(options) {
  const fingerprint = trustedValidationInstallFingerprint(options);
  if (!fingerprint)
    return false;
  try {
    const marker = JSON.parse(readFileSync8(trustedInstallMarkerPath(options.repoPath), "utf8"));
    return marker.fingerprint === fingerprint;
  } catch {
    return false;
  }
}
async function runTimed(runner, argv, options) {
  const startedAt = Date.now();
  const result = await runner(argv, options);
  return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
}
function trustedInstallWaitFailure(reason, durationMs) {
  const message = reason === "cancelled" ? "Trusted dependency install wait was cancelled." : "Timed out waiting for the repository's trusted dependency install lock.";
  return {
    command: "bun install --frozen-lockfile",
    ok: false,
    output: message,
    exitCode: 124,
    durationMs: Math.max(0, durationMs),
    phase: "dependency_install",
    failureClass: "timeout",
    failedTests: [],
    targetPathHints: [],
    failureLines: [message]
  };
}
async function waitForTrustedInstallFlight(promise, timeoutMs, signal) {
  if (signal?.aborted)
    return { state: "cancelled" };
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const onAbort = () => finish({ state: "cancelled" });
    const timer = setTimeout(() => finish({ state: "timeout" }), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((result) => finish({ state: "completed", result }), (error) => finish({ state: "failed", error }));
  });
}
async function ensureTrustedValidationInstall(options) {
  const waitStartedAt = Date.now();
  const waitDeadline = waitStartedAt + Math.max(1, options.singleFlightWaitMs ?? options.timeoutMs + 1000);
  const flightKey = resolve9(options.repoPath);
  const requestedFingerprint = trustedValidationInstallFingerprint(options);
  let waitedForFlight = false;
  while (true) {
    if (options.signal?.aborted) {
      return trustedInstallWaitFailure("cancelled", Date.now() - waitStartedAt);
    }
    const activeFlight = trustedInstallFlights.get(flightKey);
    if (activeFlight) {
      waitedForFlight = true;
      const remainingMs = waitDeadline - Date.now();
      if (remainingMs <= 0) {
        return trustedInstallWaitFailure("timeout", Date.now() - waitStartedAt);
      }
      const waited = await waitForTrustedInstallFlight(activeFlight.promise, remainingMs, options.signal);
      if (waited.state === "failed")
        throw waited.error;
      if (waited.state !== "completed") {
        return trustedInstallWaitFailure(waited.state, Date.now() - waitStartedAt);
      }
      if (trustedInstallFlights.get(flightKey) === activeFlight) {
        trustedInstallFlights.delete(flightKey);
      }
      if (activeFlight.fingerprint === requestedFingerprint && !waited.result.ok) {
        return waited.result;
      }
      continue;
    }
    if (hasFreshTrustedValidationInstall(options)) {
      return {
        command: "bun install --frozen-lockfile",
        ok: true,
        output: waitedForFlight ? "Trusted dependency install cache hit after waiting for another validation." : "Trusted dependency install cache hit for unchanged candidate inputs.",
        exitCode: 0,
        durationMs: 0,
        cached: true,
        phase: "dependency_install"
      };
    }
    const flight = (async () => {
      invalidateTrustedInstallMarker(options.repoPath);
      let preparation;
      try {
        preparation = await runTimed(options.runner, options.preparationArgv, {
          cwd: options.repoPath,
          timeoutMs: options.timeoutMs,
          signal: options.signal
        });
      } catch (error) {
        if (options.signal?.aborted) {
          return trustedInstallWaitFailure("cancelled", Date.now() - waitStartedAt);
        }
        throw error;
      }
      const evidence = preparation.ok ? null : extractTrustedValidationFailureEvidence({
        command: "bun install --frozen-lockfile",
        phase: "dependency_install",
        output: preparation.output,
        exitCode: preparation.exitCode
      });
      const result = {
        command: "bun install --frozen-lockfile",
        ...preparation,
        output: truncateTrustedValidationOutput(preparation.output),
        phase: "dependency_install",
        ...evidence ?? {}
      };
      if (preparation.ok) {
        const fingerprint = trustedValidationInstallFingerprint(options);
        if (fingerprint) {
          try {
            writeFileSync4(trustedInstallMarkerPath(options.repoPath), JSON.stringify({
              schemaVersion: 3,
              fingerprint,
              updatedAt: new Date().toISOString()
            }), "utf8");
          } catch {}
        }
      }
      return result;
    })();
    const flightRecord = { fingerprint: requestedFingerprint, promise: flight };
    trustedInstallFlights.set(flightKey, flightRecord);
    try {
      return await flight;
    } finally {
      if (trustedInstallFlights.get(flightKey) === flightRecord) {
        trustedInstallFlights.delete(flightKey);
      }
    }
  }
}
async function runProcessWithTreeTimeout(argv, options) {
  const result = await runBoundedProcess(argv, {
    cwd: options.cwd,
    env: copyEnvWithoutScmRepairAuthoritySecret(process.env),
    timeoutMs: Math.max(1, options.timeoutMs),
    outputLimitBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    streamDrainTimeoutMs: PROCESS_STREAM_DRAIN_GRACE_MS,
    signal: options.signal
  });
  return {
    ok: !result.timedOut && result.exitCode === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join(`
`),
    exitCode: result.exitCode,
    ...result.timedOut ? { timedOut: true } : {}
  };
}
async function runTrustedValidationCommands(options) {
  const normalized = normalizeTrustedValidationCommands(options.commandsJson);
  if (!normalized.ok) {
    throw new Error(`Invalid trusted-validation handoff: ${normalized.message}`);
  }
  const runner = options.runner ?? runProcessWithTreeTimeout;
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS);
  const results = [];
  const commandsWithArgv = normalized.commands.map((command) => {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv)
      throw new Error(`Invalid trusted-validation command after normalization: ${command}`);
    return { command, argv };
  });
  const preparationArgv = resolveTrustedValidationPreparationArgv({
    repoPath: options.repoPath,
    commandArgv: commandsWithArgv.map(({ argv }) => argv),
    bunExecutable: options.bunExecutable
  });
  if (preparationArgv) {
    const preparationCommand = "bun install --frozen-lockfile";
    emitTrustedValidationProgress(options.onProgress, {
      boundary: "start",
      phase: "dependency_install",
      command: preparationCommand,
      attempt: 1
    });
    let preparation = await ensureTrustedValidationInstall({
      repoPath: options.repoPath,
      preparationArgv,
      timeoutMs,
      bunExecutable: options.bunExecutable,
      invariantContext: options.invariantContext,
      runner,
      signal: options.signal,
      singleFlightWaitMs: options.singleFlightWaitMs
    });
    emitTrustedValidationProgress(options.onProgress, {
      boundary: "complete",
      phase: "dependency_install",
      command: preparationCommand,
      attempt: 1,
      ok: preparation.ok,
      durationMs: preparation.durationMs,
      cached: Boolean(preparation.cached)
    });
    if (!preparation.ok && options.retryTransientFailures !== false && isTransientTrustedValidationFailure(preparation)) {
      results.push({
        ...preparation,
        attempt: 1,
        retryReason: "transient_infrastructure"
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "retry",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2,
        retryReason: "transient_infrastructure"
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "start",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2
      });
      preparation = {
        ...await ensureTrustedValidationInstall({
          repoPath: options.repoPath,
          preparationArgv,
          timeoutMs,
          bunExecutable: options.bunExecutable,
          invariantContext: options.invariantContext,
          runner,
          signal: options.signal,
          singleFlightWaitMs: options.singleFlightWaitMs
        }),
        attempt: 2,
        retryReason: "transient_infrastructure"
      };
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "complete",
        phase: "dependency_install",
        command: preparationCommand,
        attempt: 2,
        ok: preparation.ok,
        durationMs: preparation.durationMs,
        cached: Boolean(preparation.cached)
      });
    }
    results.push(preparation);
    if (!preparation.ok)
      return results;
  }
  for (const { command, argv } of commandsWithArgv) {
    const resolvedArgv = resolveTrustedValidationArgv(argv, options.bunExecutable);
    const execute = async (attempt) => {
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "start",
        phase: "validation",
        command,
        attempt
      });
      const result = await runTimed(runner, resolvedArgv, {
        cwd: options.repoPath,
        timeoutMs,
        signal: options.signal
      });
      const evidence = result.ok ? null : extractTrustedValidationFailureEvidence({
        command,
        phase: "validation",
        output: result.output,
        exitCode: result.exitCode
      });
      const validationResult2 = {
        command,
        ...result,
        output: truncateTrustedValidationOutput(result.output),
        phase: "validation",
        attempt,
        ...evidence ?? {}
      };
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "complete",
        phase: "validation",
        command,
        attempt,
        ok: validationResult2.ok,
        durationMs: validationResult2.durationMs,
        cached: Boolean(validationResult2.cached)
      });
      return validationResult2;
    };
    let validationResult = await execute(1);
    if (!validationResult.ok && options.retryTransientFailures !== false && isTransientTrustedValidationFailure(validationResult)) {
      results.push({
        ...validationResult,
        retryReason: "transient_infrastructure"
      });
      emitTrustedValidationProgress(options.onProgress, {
        boundary: "retry",
        phase: "validation",
        command,
        attempt: 2,
        retryReason: "transient_infrastructure"
      });
      validationResult = {
        ...await execute(2),
        retryReason: "transient_infrastructure"
      };
    }
    results.push(validationResult);
    if (!validationResult.ok)
      break;
  }
  return results;
}
function isTransientTrustedValidationFailure(result) {
  if (result.failureClass === "timeout" || result.exitCode === 124)
    return true;
  return /\b(?:connection (?:reset|closed|refused)|econnreset|etimedout|temporary failure|temporarily unavailable|docker daemon is not responding|the docker daemon|tls handshake timeout|network is unreachable|could not resolve host|resource busy)\b/i.test(String(result.output ?? ""));
}

// apps/source_control_manager/src/validation_repair_publication.ts
import { createHash as createHash4 } from "crypto";
var SHA_RE3 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var MAX_REPAIR_CHAIN_COMMITS = 32;
function normalizeSha3(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE3.test(normalized) ? normalized : "";
}
function validationCheckpointNamespace(completionId) {
  const key = createHash4("sha256").update(String(completionId)).digest("hex").slice(0, 32);
  return `refs/pushpals/validation/${key}`;
}
function validationCheckpointRefs(completionId, claimGeneration) {
  const generation = Math.max(1, Math.floor(claimGeneration));
  const namespace = validationCheckpointNamespace(completionId);
  return {
    baselineRef: `${namespace}/${generation}/baseline`,
    candidateRef: `${namespace}/${generation}/candidate`,
    validatedRef: `${namespace}/${generation}/validated`
  };
}
async function immutableRefSha(git2, ref) {
  const result = await git2(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!result.ok)
    return null;
  const sha = normalizeSha3(result.stdout);
  if (!sha)
    throw new Error(`Validation checkpoint ${ref} did not resolve to an exact commit.`);
  return sha;
}
async function loadValidationCheckpoint(options) {
  const refs = validationCheckpointRefs(options.completionId, options.claimGeneration);
  const [baselineSha, candidateSha, validatedSha] = await Promise.all([
    immutableRefSha(options.git, refs.baselineRef),
    immutableRefSha(options.git, refs.candidateRef),
    immutableRefSha(options.git, refs.validatedRef)
  ]);
  if (!baselineSha && !candidateSha && !validatedSha)
    return null;
  if (!baselineSha || !candidateSha) {
    throw new Error(`Validation checkpoint for completion ${options.completionId} is incomplete; refusing generic-base recovery.`);
  }
  if (validatedSha && validatedSha !== candidateSha) {
    throw new Error(`Immutable validation-success proof ${refs.validatedRef} points to ${validatedSha}, not candidate ${candidateSha}.`);
  }
  return {
    ...refs,
    baselineSha,
    candidateSha,
    validationProven: validatedSha === candidateSha
  };
}
async function loadLatestValidationCheckpoint(options) {
  const namespace = validationCheckpointNamespace(options.completionId);
  const listed = await options.git(["for-each-ref", "--format=%(refname)", `${namespace}/`]);
  if (!listed.ok) {
    throw new Error(`Failed to enumerate retained validation checkpoints for ${options.completionId}: ${listed.stderr || listed.stdout}.`);
  }
  const generations = [
    ...new Set(listed.stdout.split(/\r?\n/).map((ref) => Number(ref.trim().match(new RegExp(`^${namespace}/([1-9][0-9]*)/candidate$`))?.[1])).filter((generation) => Number.isSafeInteger(generation) && generation > 0 && generation < options.beforeClaimGeneration))
  ].sort((a, b) => b - a);
  for (const claimGeneration of generations) {
    const checkpoint = await loadValidationCheckpoint({
      completionId: options.completionId,
      claimGeneration,
      git: options.git
    });
    if (checkpoint)
      return { claimGeneration, ...checkpoint };
  }
  return null;
}
async function persistValidationSuccessProof(options) {
  const candidateSha = normalizeSha3(options.candidateSha);
  if (!candidateSha)
    throw new Error("Validation-success proof requires an exact candidate SHA.");
  const checkpoint = await loadValidationCheckpoint({
    completionId: options.completionId,
    claimGeneration: options.claimGeneration,
    git: options.git
  });
  if (!checkpoint || checkpoint.candidateSha !== candidateSha) {
    throw new Error(`Validation-success proof requires the matching immutable candidate checkpoint ${candidateSha}.`);
  }
  const existing = await immutableRefSha(options.git, checkpoint.validatedRef);
  if (existing && existing !== candidateSha) {
    throw new Error(`Immutable validation-success proof ${checkpoint.validatedRef} already points to ${existing}, not ${candidateSha}.`);
  }
  if (!existing) {
    const zeroOid = "0".repeat(candidateSha.length);
    const update = await options.git([
      "update-ref",
      checkpoint.validatedRef,
      candidateSha,
      zeroOid
    ]);
    if (!update.ok) {
      const concurrent = await immutableRefSha(options.git, checkpoint.validatedRef);
      if (concurrent !== candidateSha) {
        throw new Error(`Failed atomic creation of validation-success proof ${checkpoint.validatedRef}: ${update.stderr || update.stdout}.`);
      }
    }
  }
  const verified = await immutableRefSha(options.git, checkpoint.validatedRef);
  if (verified !== candidateSha) {
    throw new Error(`Validation-success proof ${checkpoint.validatedRef} failed exact-SHA verification after update.`);
  }
  return { validatedRef: checkpoint.validatedRef, candidateSha };
}
async function persistValidationCheckpoint(options) {
  const baselineSha = normalizeSha3(options.baselineSha);
  const candidateSha = normalizeSha3(options.candidateSha);
  if (!baselineSha || !candidateSha || baselineSha === candidateSha) {
    throw new Error("Validation checkpoint requires distinct exact baseline and candidate SHAs.");
  }
  await resolveExactCommit(options.git, baselineSha, "validation baseline");
  await resolveExactCommit(options.git, candidateSha, "tested candidate");
  await requireAncestor(options.git, baselineSha, candidateSha, `tested candidate ${candidateSha} is not descended from validation baseline ${baselineSha}`);
  const refs = validationCheckpointRefs(options.completionId, options.claimGeneration);
  for (const [ref, sha] of [
    [refs.baselineRef, baselineSha],
    [refs.candidateRef, candidateSha]
  ]) {
    const existing = await immutableRefSha(options.git, ref);
    if (existing && existing !== sha) {
      throw new Error(`Immutable validation checkpoint ${ref} already points to ${existing}, not ${sha}.`);
    }
    if (!existing) {
      const zeroOid = "0".repeat(sha.length);
      const update = await options.git(["update-ref", ref, sha, zeroOid]);
      if (!update.ok) {
        const concurrent = await immutableRefSha(options.git, ref);
        if (concurrent !== sha) {
          throw new Error(`Failed atomic creation of trusted-validation checkpoint ${ref}: ${update.stderr || update.stdout}.`);
        }
      }
    }
    const verified = await immutableRefSha(options.git, ref);
    if (verified !== sha) {
      throw new Error(`Validation checkpoint ${ref} failed exact-SHA verification after update.`);
    }
  }
  const validatedSha = await immutableRefSha(options.git, refs.validatedRef);
  if (validatedSha && validatedSha !== candidateSha) {
    throw new Error(`Immutable validation-success proof ${refs.validatedRef} points to ${validatedSha}, not candidate ${candidateSha}.`);
  }
  return {
    ...refs,
    baselineSha,
    candidateSha,
    validationProven: validatedSha === candidateSha
  };
}
async function resolveExactCommit(git2, sha, label) {
  const result = await git2(["rev-parse", "--verify", `${sha}^{commit}`]);
  const resolved = result.ok ? normalizeSha3(result.stdout) : "";
  if (!resolved || resolved !== sha) {
    throw new Error(`Validation-repair publication lease could not verify exact ${label} ${sha}: ${result.stderr || result.stdout || "revision unavailable"}.`);
  }
  return resolved;
}
async function requireAncestor(git2, ancestor, descendant, detail) {
  const result = await git2(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (!result.ok) {
    throw new Error(`Validation-repair publication lease mismatch: ${detail}.`);
  }
}
async function resolveValidationCheckpointBaseline(options) {
  const preApplyBaselineSha = normalizeSha3(options.preApplyBaselineSha);
  const candidateSha = normalizeSha3(options.candidateSha);
  if (!preApplyBaselineSha || !candidateSha) {
    throw new Error("Validation checkpoint baseline resolution requires exact SHAs.");
  }
  await resolveExactCommit(options.git, preApplyBaselineSha, "pre-apply baseline");
  await resolveExactCommit(options.git, candidateSha, "tested candidate");
  const directAncestry = await options.git([
    "merge-base",
    "--is-ancestor",
    preApplyBaselineSha,
    candidateSha
  ]);
  if (directAncestry.ok)
    return preApplyBaselineSha;
  const mergeBase = await options.git(["merge-base", preApplyBaselineSha, candidateSha]);
  const exactMergeBase = mergeBase.ok ? normalizeSha3(mergeBase.stdout) : "";
  if (!exactMergeBase) {
    throw new Error(`Unable to derive an exact trusted-validation baseline for candidate ${candidateSha}: ${mergeBase.stderr || mergeBase.stdout || "no merge base"}.`);
  }
  await requireAncestor(options.git, exactMergeBase, candidateSha, `derived baseline ${exactMergeBase} is not an ancestor of candidate ${candidateSha}`);
  return exactMergeBase;
}
async function applyRetainedValidationCheckpoint(options) {
  const baselineSha = normalizeSha3(options.baselineSha);
  const candidateSha = normalizeSha3(options.candidateSha);
  const currentIntegrationSha = normalizeSha3(options.currentIntegrationSha);
  if (!baselineSha || !candidateSha || !currentIntegrationSha) {
    throw new Error("Retained validation replay requires exact baseline, candidate, and integration SHAs.");
  }
  await resolveExactCommit(options.git, baselineSha, "retained baseline");
  await resolveExactCommit(options.git, candidateSha, "retained candidate");
  await resolveExactCommit(options.git, currentIntegrationSha, "current integration head");
  await requireAncestor(options.git, baselineSha, candidateSha, `retained candidate ${candidateSha} is not descended from baseline ${baselineSha}`);
  await requireAncestor(options.git, baselineSha, currentIntegrationSha, `current integration head ${currentIntegrationSha} is not descended from retained baseline ${baselineSha}`);
  const chainResult = await options.git([
    "rev-list",
    "--reverse",
    "--ancestry-path",
    `${baselineSha}..${candidateSha}`
  ]);
  const chain = chainResult.ok ? chainResult.stdout.split(/\r?\n/).map((value) => normalizeSha3(value)).filter(Boolean) : [];
  if (!chainResult.ok || chain.length < 1 || chain.length > MAX_REPAIR_CHAIN_COMMITS || chain.at(-1) !== candidateSha) {
    throw new Error(`Retained validation replay refused an invalid or oversized commit chain (${chain.length} commits): ${chainResult.stderr || chainResult.stdout}.`);
  }
  const cherryResult = await options.git([
    "cherry",
    currentIntegrationSha,
    candidateSha,
    baselineSha
  ]);
  if (!cherryResult.ok) {
    throw new Error(`Retained validation replay could not compare patch equivalence: ${cherryResult.stderr || cherryResult.stdout}.`);
  }
  const equivalent = new Set(cherryResult.stdout.split(/\r?\n/).map((line) => line.trim().match(/^-\s+([0-9a-f]{40,64})(?:\s|$)/i)?.[1]?.toLowerCase()).filter((sha) => Boolean(sha)));
  const applied = [];
  for (const commitSha of chain) {
    const ancestor = await options.git([
      "merge-base",
      "--is-ancestor",
      commitSha,
      currentIntegrationSha
    ]);
    if (ancestor.ok || equivalent.has(commitSha))
      continue;
    const result = await options.git(["cherry-pick", commitSha]);
    if (!result.ok) {
      return {
        ...result,
        stderr: [
          result.stderr,
          `Failed while replaying retained trusted-validation commit ${commitSha}.`
        ].filter(Boolean).join(`
`)
      };
    }
    applied.push(commitSha);
  }
  return applied.length > 0 ? {
    ok: true,
    stdout: `Replayed ${applied.length} retained trusted-validation commit(s).`,
    stderr: "",
    exitCode: 0
  } : {
    ok: true,
    stdout: `Retained trusted-validation candidate ${candidateSha} is already integrated.`,
    stderr: "",
    exitCode: 0,
    idempotent: true
  };
}
async function applyValidationRepairPublication(options) {
  const lease = validateValidationRepairPublicationLease(options.lease);
  const completionSha = normalizeSha3(options.completionSha);
  const currentIntegrationSha = normalizeSha3(options.currentIntegrationSha);
  if (!completionSha || completionSha !== lease.expectedCompletionSha) {
    throw new Error(`Validation-repair publication lease expected completion ${lease.expectedCompletionSha}, received ${options.completionSha}.`);
  }
  if (!currentIntegrationSha) {
    throw new Error("Validation-repair publication requires an exact current integration SHA.");
  }
  await resolveExactCommit(options.git, lease.baselineSha, "baseline");
  await resolveExactCommit(options.git, lease.candidateSha, "candidate");
  await resolveExactCommit(options.git, completionSha, "completion");
  await resolveExactCommit(options.git, currentIntegrationSha, "current integration head");
  const retainedCandidate = await options.git([
    "rev-parse",
    "--verify",
    `${lease.candidateRef}^{commit}`
  ]);
  if (!retainedCandidate.ok || normalizeSha3(retainedCandidate.stdout) !== lease.candidateSha) {
    throw new Error(`Validation-repair publication lease mismatch: retained candidate ref ${lease.candidateRef} does not resolve to ${lease.candidateSha}.`);
  }
  await requireAncestor(options.git, lease.baselineSha, lease.candidateSha, `candidate ${lease.candidateSha} is not descended from baseline ${lease.baselineSha}`);
  await requireAncestor(options.git, lease.candidateSha, completionSha, `completion ${completionSha} is not descended from candidate ${lease.candidateSha}`);
  await requireAncestor(options.git, lease.baselineSha, currentIntegrationSha, `current integration head ${currentIntegrationSha} is not descended from leased baseline ${lease.baselineSha}`);
  const chainResult = await options.git([
    "rev-list",
    "--reverse",
    "--ancestry-path",
    `${lease.baselineSha}..${completionSha}`
  ]);
  if (!chainResult.ok) {
    throw new Error(`Validation-repair publication could not enumerate the leased commit chain: ${chainResult.stderr || chainResult.stdout}.`);
  }
  const chain = chainResult.stdout.split(/\r?\n/).map((value) => normalizeSha3(value)).filter(Boolean);
  const candidateIndex = chain.indexOf(lease.candidateSha);
  if (chain.length < 2 || chain.length > MAX_REPAIR_CHAIN_COMMITS || candidateIndex < 0 || chain.at(-1) !== completionSha) {
    throw new Error(`Validation-repair publication refused an invalid or oversized leased chain (${chain.length} commits; candidate index ${candidateIndex}).`);
  }
  const cherryResult = await options.git([
    "cherry",
    currentIntegrationSha,
    completionSha,
    lease.baselineSha
  ]);
  if (!cherryResult.ok) {
    throw new Error(`Validation-repair publication could not compare patch equivalence for idempotent recovery: ${cherryResult.stderr || cherryResult.stdout}.`);
  }
  const equivalentCommits = new Set(cherryResult.stdout.split(/\r?\n/).map((line) => line.trim().match(/^-\s+([0-9a-f]{40,64})(?:\s|$)/i)?.[1]?.toLowerCase()).filter((sha) => Boolean(sha)));
  const applied = [];
  for (const commitSha of chain) {
    const alreadyIntegrated = await options.git([
      "merge-base",
      "--is-ancestor",
      commitSha,
      currentIntegrationSha
    ]);
    if (alreadyIntegrated.ok || equivalentCommits.has(commitSha))
      continue;
    const appliedResult = await options.git(["cherry-pick", commitSha]);
    if (!appliedResult.ok) {
      return {
        ...appliedResult,
        stderr: [
          appliedResult.stderr,
          `Failed while applying leased validation-repair commit ${commitSha} (${applied.length + 1}/${chain.length}).`
        ].filter(Boolean).join(`
`)
      };
    }
    applied.push(commitSha);
  }
  if (applied.length === 0) {
    return {
      ok: true,
      stdout: `Validation-repair completion ${completionSha} is already integrated; no duplicate mutation was applied.`,
      stderr: "",
      exitCode: 0,
      idempotent: true
    };
  }
  return {
    ok: true,
    stdout: `Applied ${applied.length} leased validation-repair commit(s): ${applied.join(", ")}`,
    stderr: "",
    exitCode: 0
  };
}

// apps/source_control_manager/src/validation_worktree.ts
var SHA_RE4 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function exactSha(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA_RE4.test(normalized) ? normalized : "";
}

class ValidationWorktreeInvariantError extends Error {
  status;
  constructor(message, status = "") {
    super(message);
    this.name = "ValidationWorktreeInvariantError";
    this.status = status;
  }
}
async function assertExactCleanValidationWorktree(options) {
  const expectedSha = exactSha(options.expectedSha);
  if (!expectedSha) {
    throw new ValidationWorktreeInvariantError(`Trusted-validation ${options.phase} requires an exact candidate SHA.`);
  }
  const head = await options.git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const actualSha = head.ok ? exactSha(head.stdout) : "";
  if (actualSha !== expectedSha) {
    throw new ValidationWorktreeInvariantError(`Trusted-validation ${options.phase} moved HEAD from ${expectedSha} to ${actualSha || "unavailable"}; refusing publication.`);
  }
  const status = await options.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) {
    throw new ValidationWorktreeInvariantError(`Trusted-validation ${options.phase} could not verify worktree cleanliness: ${status.stderr || status.stdout || "git status failed"}.`);
  }
  const dirty = status.stdout.trim();
  if (dirty) {
    throw new ValidationWorktreeInvariantError(`Trusted-validation ${options.phase} mutated the candidate worktree; refusing to publish a different tree than ${expectedSha}.
${dirty}`, dirty);
  }
}

// apps/source_control_manager/src/config.ts
import { resolve as resolve10 } from "path";
function buildDefaults(options = {}) {
  const pushConfig = loadPushPalsConfig({ reload: options.reload });
  const defaultLocalServer = resolveLocalServerConnection({
    serverUrl: pushConfig.server.url,
    authToken: pushConfig.authToken,
    fallbackPort: pushConfig.server.port
  });
  return {
    repoPath: resolve10(pushConfig.sourceControlManager.repoPath),
    serverUrl: defaultLocalServer.serverUrl,
    remote: pushConfig.sourceControlManager.remote,
    mainBranch: pushConfig.sourceControlManager.mainBranch,
    integrationBaseBranch: pushConfig.sourceControlManager.baseBranch,
    branchPrefix: pushConfig.sourceControlManager.branchPrefix,
    pollIntervalSeconds: pushConfig.sourceControlManager.pollIntervalSeconds,
    checks: pushConfig.sourceControlManager.checks.map((check) => ({ ...check })),
    stateDir: resolve10(pushConfig.sourceControlManager.stateDir),
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
var scmRepairAuthoritySecret = null;
try {
  scmRepairAuthoritySecret = resolveScmRepairAuthoritySecret({
    dataDir: PUSH_CONFIG.paths.dataDir
  });
} catch (error) {
  console.error(`[SourceControlManager] SCM repair authority is unavailable; review repairs cannot be admitted: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  scrubScmRepairAuthoritySecretFromEnv(process.env);
}
var repoRoot = resolveSourceControlManagerRuntimeRepoRoot(PUSH_CONFIG.projectRoot, process.cwd());
var defaultSourceControlManagerRepoPath = resolve11(PUSH_CONFIG.sourceControlManager.repoPath);
var COMPLETION_LEASE_MS = 3 * 60000;
var COMPLETION_LEASE_HEARTBEAT_MS = 30000;
var PUBLICATION_HEALTH_POLL_MS = 1e4;
var SERVER_CONTROL_HTTP_TIMEOUT_MS = 5000;
var COMPLETION_GC_RECORDS_PER_TICK = 1;
var COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS = 3000;
var COMPLETION_GC_REMOTE_GIT_TIMEOUT_MS = 1e4;
var COMPLETION_GC_REFS_PER_RECORD_PER_TICK = 4;
var SCM_TICK_STALL_MS = Math.max(60000, Number(process.env.PUSHPALS_SCM_TICK_STALL_MS) || 17 * 60000);
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
  cliOverrides.repoPath = resolve11(args.repo);
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
  cliOverrides.stateDir = resolve11(args["state-dir"]);
if (args["delete-after-merge"])
  cliOverrides.deleteAfterMerge = true;
config = applyCliOverrides(config, cliOverrides);
config.repoPath = resolve11(config.repoPath);
var integrationBaseBranch = config.integrationBaseBranch;
var integrationBaseRef = `${config.remote}/${integrationBaseBranch}`;
var usingDefaultRepoPath = resolve11(config.repoPath) === resolve11(defaultSourceControlManagerRepoPath);
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
mkdirSync4(config.stateDir, { recursive: true });
var lock = new FileLock(config.stateDir);
if (!lock.acquire()) {
  console.error(`[${ts2()}] Another source_control_manager instance is already running. Exiting.`);
  process.exit(1);
}
console.log(`[${ts2()}] Lock acquired`);
var dbPath = join7(config.stateDir, "merge_queue.db");
var db = new MergeQueueDB(dbPath);
console.log(`[${ts2()}] Database opened: ${dbPath}`);
var sourceControlManagerPusherId = `source_control_manager-${createHash5("sha256").update(`${config.repoPath}
${config.mainBranch}
${config.remote}`).digest("hex").slice(0, 12)}-${process.pid}-${randomUUID3().slice(0, 8)}`;
var repositoryServices = createRepositoryAgentServiceClients({
  serverUrl: config.serverUrl,
  callerService: "source_control_manager",
  callerInstanceId: sourceControlManagerPusherId,
  authToken: config.authToken
});
var healthTracker = createSourceControlManagerHealthTracker({
  tickStallMs: SCM_TICK_STALL_MS,
  idleBacklogGraceMs: Math.max(30000, config.pollIntervalSeconds * 3000)
});
var reviewAgentInstance = null;
var blockedReviewProviderHealth = null;
function sourceControlManagerHealthSnapshot() {
  const reviewProvider = reviewAgentInstance?.getProviderHealthSnapshot() ?? blockedReviewProviderHealth;
  return withReviewProviderHealth(healthTracker.snapshot(), reviewProvider);
}
var recovered = db.recoverStuckJobs();
if (recovered > 0) {
  console.log(`[${ts2()}] Recovered ${recovered} stuck running job(s) -> queued`);
}
var gitOps = createSourceControlApi(config);
var completionGcJournal = new CompletionGcJournal(config.stateDir);
var server;
try {
  server = createStatusServer(db, config.port, sourceControlManagerHealthSnapshot);
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
var publicationHealthTimer = null;
var publicationHealthProbeInFlight = false;
var reviewAgentPollTimer = null;
var reviewAgentConfigPollTimer = null;
var statusSessionReady = false;
var shutdownPromise = null;
var startupStatusTracker = createStartupStatusTracker();
var reviewAgentRuntimeStateKey = "startup";
var reviewAgentRuntimeFingerprint = "";
var reviewAgentProviderRetryKey = "";
var reviewAgentProviderRetryAfterMs = 0;
var reviewAgentProviderTokenCache = null;
async function refreshPublicationHealth() {
  if (publicationHealthProbeInFlight)
    return;
  publicationHealthProbeInFlight = true;
  try {
    const headers = {};
    if (config.authToken)
      headers.Authorization = `Bearer ${config.authToken}`;
    const response = await fetchBufferedWithHardDeadline({
      input: `${config.serverUrl}/workers/autoscale?ttlMs=15000`,
      init: { headers },
      timeoutMs: 3000,
      timeoutMessage: "SourceControlManager publication-health probe timed out after 3000ms"
    });
    if (!response.ok)
      return;
    const payload = await response.json().catch(() => ({}));
    if (payload.publication)
      healthTracker.updatePublication(payload.publication);
  } catch {} finally {
    publicationHealthProbeInFlight = false;
  }
}
function startPublicationHealthPolling() {
  if (publicationHealthTimer)
    return;
  refreshPublicationHealth();
  publicationHealthTimer = setInterval(() => void refreshPublicationHealth(), PUBLICATION_HEALTH_POLL_MS);
}
var integrationMaintenanceIntervalMs = Math.max(1e4, Math.min(60000, config.pollIntervalSeconds * 3000));
var integrationMaintenanceRunner = new IntegrationMaintenanceRunner({
  gitOps,
  sessionId: statusSessionId,
  intervalMs: integrationMaintenanceIntervalMs
});
var reviewAgentConfigPollMs = 3000;
var reviewAgentProviderRetryBackoffMs = 30000;
var reviewAgentProviderTokenCacheMs = 5 * 60000;
var syncReviewAgentRuntimeConfigSingleFlight = createSingleFlightExecutor(async () => {
  const latestConfig = applyCliOverrides(loadConfig({ reload: true }), cliOverrides);
  validateConfig(latestConfig);
  config.reviewAgent = { ...latestConfig.reviewAgent };
  config.prBaseBranch = latestConfig.prBaseBranch;
  config.gitToken = latestConfig.gitToken;
  let aiReviewRuntimeReady = false;
  let aiReviewRuntimeDetail = "AI review is disabled";
  const remoteUrlResult = await runGitCapture(["-C", config.repoPath, "remote", "get-url", config.remote], repoRoot);
  const remoteUrl = remoteUrlResult.ok ? remoteUrlResult.stdout.trim() : "";
  if (!remoteUrl) {
    blockedReviewProviderHealth = createBlockedReviewProviderHealth("git remote URL could not be resolved");
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState("blocked:missing_remote", `[${ts2()}] PR outcome reconciliation could not resolve remote URL; waiting for runtime config or git remote changes before starting.`, "warn");
    return;
  }
  if (!isSupportedGitHubRemoteUrl(remoteUrl)) {
    const remoteHost = parseGitRemoteHost(remoteUrl) || "unknown host";
    blockedReviewProviderHealth = createBlockedReviewProviderHealth(`unsupported git provider host: ${remoteHost}`);
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState(`blocked:unsupported_provider:${remoteHost}`, `[${ts2()}] PR outcome reconciliation is unavailable for provider host ${remoteHost}; the current reconciler supports GitHub remotes only.`, "warn");
    return;
  }
  const providerRetryKey = JSON.stringify({ remoteUrl, gitToken: config.gitToken ?? "" });
  const providerNowMs = Date.now();
  if (reviewAgentProviderRetryKey === providerRetryKey && providerNowMs < reviewAgentProviderRetryAfterMs && reviewAgentProviderRetryAfterMs - providerNowMs <= reviewAgentProviderRetryBackoffMs) {
    return;
  }
  let gitProviderToken = reviewAgentProviderTokenCache?.key === providerRetryKey && providerNowMs < reviewAgentProviderTokenCache.expiresAtMs && reviewAgentProviderTokenCache.expiresAtMs - providerNowMs <= reviewAgentProviderTokenCacheMs ? reviewAgentProviderTokenCache.token : "";
  let resolvedProviderTokenFresh = false;
  if (!gitProviderToken) {
    gitProviderToken = await resolveGitAuthToken(remoteUrl, config.gitToken ?? "");
    resolvedProviderTokenFresh = true;
  }
  if (!gitProviderToken) {
    reviewAgentProviderTokenCache = null;
    reviewAgentProviderRetryKey = providerRetryKey;
    reviewAgentProviderRetryAfterMs = providerNowMs + reviewAgentProviderRetryBackoffMs;
    blockedReviewProviderHealth = createBlockedReviewProviderHealth("git provider token is unavailable");
    await clearReviewAgentPollLoop();
    logReviewAgentRuntimeState("blocked:missing_token", `[${ts2()}] PR outcome reconciliation has no git provider token (set PUSHPALS_GIT_TOKEN or provider token such as GITHUB_TOKEN/GH_TOKEN/GITLAB_TOKEN/GL_TOKEN); waiting for credentials before starting.`, "warn");
    return;
  }
  if (resolvedProviderTokenFresh) {
    reviewAgentProviderTokenCache = {
      key: providerRetryKey,
      token: gitProviderToken,
      expiresAtMs: providerNowMs + reviewAgentProviderTokenCacheMs
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
      timeoutMs: 2500
    });
    aiReviewRuntimeReady = runtimeReadiness.ready;
    aiReviewRuntimeDetail = runtimeReadiness.detail;
  }
  const prBaseBranch = (config.prBaseBranch || integrationBaseBranch).trim();
  const effectiveReviewAgentConfig = {
    ...config.reviewAgent,
    enabled: config.reviewAgent.enabled && aiReviewRuntimeReady
  };
  const fingerprint = buildReviewAgentRuntimeFingerprint({
    serverUrl: config.serverUrl,
    remoteUrl,
    prBaseBranch,
    branchPrefix: config.branchPrefix,
    reviewAgent: config.reviewAgent,
    gitProviderToken,
    serverAuthToken: config.authToken
  });
  if (reviewAgentInstance && reviewAgentPollTimer && reviewAgentRuntimeFingerprint === fingerprint) {
    const runtimeUpdate = reviewAgentInstance.updateRuntimeConfig(effectiveReviewAgentConfig);
    logReviewAgentRuntimeState(`running:${fingerprint}:ai:${effectiveReviewAgentConfig.enabled ? "ready" : "waiting"}`, effectiveReviewAgentConfig.enabled ? `[${ts2()}] ReviewAgent AI review became ready without restarting provider reconciliation.` : config.reviewAgent.enabled ? `[${ts2()}] ReviewAgent AI review is waiting for embedded runtime readiness without resetting provider reconciliation state (${aiReviewRuntimeDetail}).` : `[${ts2()}] PR outcome reconciliation remains active while AI review is disabled.`);
    if (runtimeUpdate.becameEnabled) {
      reviewAgentInstance.poll().catch((err) => {
        console.error(`[${ts2()}] [ReviewAgent] Readiness transition poll error: ${err?.message ?? err}`);
      });
    }
    return;
  }
  await clearReviewAgentPollLoop();
  const reviewAgent = new ReviewAgent(effectiveReviewAgentConfig, config.serverUrl, gitProviderToken, remoteUrl, prBaseBranch, config.authToken, { repositoryServices, scmRepairAuthoritySecret }, config.branchPrefix);
  reviewAgentInstance = reviewAgent;
  reviewAgentRuntimeFingerprint = fingerprint;
  reviewAgentPollTimer = setInterval(() => reviewAgent.poll().catch((err) => {
    console.error(`[${ts2()}] [ReviewAgent] Poll error: ${err?.message ?? err}`);
  }), config.reviewAgent.pollIntervalMs);
  logReviewAgentRuntimeState(`running:${fingerprint}`, effectiveReviewAgentConfig.enabled ? `[${ts2()}] ReviewAgent started (poll interval: ${config.reviewAgent.pollIntervalMs}ms, pass threshold: ${config.reviewAgent.passThreshold}/10, branch prefix: ${config.branchPrefix})` : config.reviewAgent.enabled ? `[${ts2()}] PR outcome reconciler started while AI review waits for embedded runtime readiness (${aiReviewRuntimeDetail}; poll interval: ${config.reviewAgent.pollIntervalMs}ms, branch prefix: ${config.branchPrefix})` : `[${ts2()}] PR outcome reconciler started while AI review is disabled (poll interval: ${config.reviewAgent.pollIntervalMs}ms, branch prefix: ${config.branchPrefix})`);
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
      const response = await fetchBufferedWithHardDeadline({
        input: `${config.serverUrl}/sessions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        },
        timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
        timeoutMessage: `SourceControlManager session registration timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms`
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
async function clearReviewAgentPollLoop() {
  if (reviewAgentPollTimer) {
    clearInterval(reviewAgentPollTimer);
    reviewAgentPollTimer = null;
  }
  const retiringReviewAgent = reviewAgentInstance;
  reviewAgentInstance = null;
  reviewAgentRuntimeFingerprint = "";
  await retiringReviewAgent?.stopAndDrain();
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
async function resolveCompletionProcessingAuthority(runtimeConfig, headers, record) {
  const response = await fetchBufferedWithHardDeadline({
    input: `${runtimeConfig.serverUrl}/completions/${encodeURIComponent(record.completionId)}/status`,
    init: { headers },
    timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
    timeoutMessage: `Completion ${record.completionId} status probe timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`
  });
  if (response.status === 404)
    return null;
  if (!response.ok) {
    throw new Error(`completion status authority returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.completion) {
    throw new Error("completion status authority returned a malformed response");
  }
  return payload.completion;
}
async function cleanupProcessedCompletionRefs(runtimeConfig, record) {
  const validationNamespace2 = completionGcValidationNamespace(record);
  const listed = await runGitCommandCapture(repoRoot, [
    "-C",
    runtimeConfig.repoPath,
    "for-each-ref",
    "--format=%(refname)",
    `${validationNamespace2}/`,
    ...record.additionalValidationRefs
  ], { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS });
  if (!listed.ok) {
    throw new Error(`failed to list retained validation refs: ${listed.stderr || listed.stdout || `exit ${listed.exitCode}`}`);
  }
  const additionalValidationRefSet = new Set(record.additionalValidationRefs);
  const validationRefs = [
    ...new Set(listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter((ref) => ref.startsWith(`${validationNamespace2}/`) || additionalValidationRefSet.has(ref)))
  ].sort((a, b) => a.localeCompare(b));
  const refsForThisTick = validationRefs.slice(0, COMPLETION_GC_REFS_PER_RECORD_PER_TICK);
  for (const ref of refsForThisTick) {
    const deleted = await runGitCommandCapture(repoRoot, ["-C", runtimeConfig.repoPath, "update-ref", "-d", ref], { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS });
    if (!deleted.ok) {
      throw new Error(`failed to delete retained validation ref ${ref}: ${deleted.stderr || deleted.stdout || `exit ${deleted.exitCode}`}`);
    }
  }
  if (validationRefs.length > refsForThisTick.length) {
    return false;
  }
  if (record.completionBranch.startsWith("refs/pushpals/")) {
    const resolvedLocal = authoritativeRefShaFromGitResult(await runGitCommandCapture(repoRoot, [
      "-C",
      runtimeConfig.repoPath,
      "rev-parse",
      "--verify",
      "--quiet",
      `${record.completionBranch}^{commit}`
    ], { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS }), record.completionBranch);
    const localDeleteArgs = buildCompletionGcLocalDeleteArgs(record, resolvedLocal);
    if (resolvedLocal && !localDeleteArgs) {
      console.warn(`[${ts2()}] Retained completion ref ${record.completionBranch} moved to ${resolvedLocal}; preserving its new owner instead of deleting it for processed completion ${record.completionId}.`);
    }
    if (localDeleteArgs) {
      const deletedLocal = await runGitCommandCapture(repoRoot, ["-C", runtimeConfig.repoPath, ...localDeleteArgs], { timeout: COMPLETION_GC_LOCAL_GIT_TIMEOUT_MS });
      if (!deletedLocal.ok) {
        throw new Error(`failed leased deletion of local completion ref ${record.completionBranch}: ${deletedLocal.stderr || deletedLocal.stdout || `exit ${deletedLocal.exitCode}`}`);
      }
    }
  }
  if (record.remote) {
    const remoteOptions = {
      timeout: COMPLETION_GC_REMOTE_GIT_TIMEOUT_MS,
      ...runtimeConfig.gitToken ? { githubToken: runtimeConfig.gitToken } : {}
    };
    const remoteRefResult = await runGitCommandCapture(repoRoot, ["-C", runtimeConfig.repoPath, "ls-remote", "--refs", record.remote, record.completionBranch], remoteOptions);
    if (!remoteRefResult.ok) {
      throw new Error(`failed to resolve remote completion ref ${record.completionBranch}: ${remoteRefResult.stderr || remoteRefResult.stdout || `exit ${remoteRefResult.exitCode}`}`);
    }
    const remoteMatches = remoteRefResult.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 2)).filter((parts) => parts.length === 2 && parts[1] === record.completionBranch);
    if (remoteMatches.length > 1) {
      throw new Error(`remote returned multiple values for completion ref ${record.completionBranch}`);
    }
    const resolvedRemote = remoteMatches[0]?.[0] ?? null;
    if (resolvedRemote && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(resolvedRemote)) {
      throw new Error(`remote returned an invalid SHA for ${record.completionBranch}`);
    }
    const remoteDeleteArgs = buildCompletionGcRemoteDeleteArgs(record, resolvedRemote);
    if (resolvedRemote && !remoteDeleteArgs) {
      console.warn(`[${ts2()}] Remote completion ref ${record.completionBranch} moved to ${resolvedRemote}; preserving its new owner instead of deleting it for processed completion ${record.completionId}.`);
    }
    if (remoteDeleteArgs) {
      const deletedRemote = await runGitCommandCapture(repoRoot, ["-C", runtimeConfig.repoPath, ...remoteDeleteArgs], remoteOptions);
      if (!deletedRemote.ok) {
        throw new Error(`failed leased deletion of remote completion ref ${record.completionBranch}: ${deletedRemote.stderr || deletedRemote.stdout || `exit ${deletedRemote.exitCode}`}`);
      }
    }
  }
  return true;
}
async function reconcileRetainedCompletionRefs(runtimeConfig, headers) {
  try {
    const result = await reconcileCompletionGcJournal({
      journal: completionGcJournal,
      limit: COMPLETION_GC_RECORDS_PER_TICK,
      resolveAuthority: (record) => resolveCompletionProcessingAuthority(runtimeConfig, headers, record),
      cleanup: (record) => cleanupProcessedCompletionRefs(runtimeConfig, record),
      onWarning: (message) => console.warn(`[${ts2()}] ${message}`)
    });
    if (result.cleaned > 0) {
      console.log(`[${ts2()}] Reconciled ${result.cleaned} processed completion ref handoff(s); examined=${result.examined} retained=${result.retained} uncertain=${result.uncertain}.`);
    }
  } catch (error) {
    console.warn(`[${ts2()}] Completion ref GC pass failed safely; publication polling will continue: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function tick() {
  healthTracker.beginTick("integration_maintenance");
  try {
    const runtimeConfig = cloneSourceControlManagerConfigSnapshot(config);
    const reviewAgentForTick = reviewAgentInstance;
    const headers = { "Content-Type": "application/json" };
    if (runtimeConfig.authToken) {
      headers["Authorization"] = `Bearer ${runtimeConfig.authToken}`;
    }
    const pusherId = sourceControlManagerPusherId;
    const response = await claimBeforeCompletionGc({
      claim: () => maintainIntegrationBeforeCompletionClaim({
        maintain: () => integrationMaintenanceRunner.run(runtimeConfig, headers),
        claimCompletion: async () => {
          const rawResponse = await fetchBufferedWithHardDeadline({
            input: `${runtimeConfig.serverUrl}/completions/claim`,
            init: {
              method: "POST",
              headers,
              body: JSON.stringify({
                pusherId,
                leaseMs: COMPLETION_LEASE_MS
              })
            },
            timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
            timeoutMessage: `Completion claim timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`
          });
          return {
            ok: rawResponse.ok,
            status: rawResponse.status,
            data: rawResponse.ok ? await rawResponse.json() : null
          };
        }
      }),
      isIdle: (claimResult) => claimResult.status === 404 || claimResult.ok && !claimResult.data?.completion,
      reconcile: () => reconcileRetainedCompletionRefs(runtimeConfig, headers)
    });
    if (!response.ok) {
      if (response.status !== 404) {
        console.error(`[${ts2()}] Failed to claim completion: ${response.status}`);
      }
      return;
    }
    const data = response.data;
    if (!data.ok || !data.completion) {
      return;
    }
    const completion = data.completion;
    const completionClaimToken = String(completion.claimToken ?? "").trim();
    const completionClaimGeneration = Number(completion.claimGeneration);
    if (!completionClaimToken || !Number.isSafeInteger(completionClaimGeneration) || completionClaimGeneration < 1) {
      throw new Error(`Claimed completion ${completion.id} did not include a valid fencing token/generation; refusing publication.`);
    }
    healthTracker.progress("completion_claimed", completion.id);
    const reviewPublicationLease = completion.branch.startsWith("refs/pushpals/review/") ? parseReviewPublicationLease(completion.prBody) : null;
    let validationRepairPublicationLease = null;
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
    const completionLeaseRenewal = new CompletionLeaseRenewalCoordinator(async () => {
      const leaseResponse = await fetchBufferedWithHardDeadline({
        input: `${runtimeConfig.serverUrl}/completions/${completion.id}/lease/renew`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({
            pusherId,
            claimToken: completionClaimToken,
            leaseMs: COMPLETION_LEASE_MS
          })
        },
        timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
        timeoutMessage: `Completion publication lease renewal timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`
      });
      return parseCompletionLeaseRenewalResponse(leaseResponse);
    });
    const renewCompletionLease = async (required = false) => {
      const renewed = await completionLeaseRenewal.renew(required);
      if (!renewed && !required) {
        console.warn(`[${ts2()}] Completion lease heartbeat failed for ${completion.id}: ${completionLeaseRenewal.failureDetail() ?? "renewal was not confirmed"}`);
      }
      return renewed;
    };
    const requireCompletionLease = async (operation) => {
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(`Completion publication lease was lost before ${operation}; refusing stale-owner mutation.`);
      }
      await renewCompletionLease(true);
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(`Completion publication lease was lost before ${operation}; refusing stale-owner mutation.`);
      }
    };
    const completionLeaseHeartbeatTimer = setInterval(() => void renewCompletionLease(false), COMPLETION_LEASE_HEARTBEAT_MS);
    let tempBranch = "";
    let cleanupCompletionHandoff = false;
    let completionGcRecord = null;
    let trustedInstallDurationMs = null;
    let trustedValidationDurationMs = null;
    let trustedValidationCacheHit = null;
    let trustedValidationBaselineSha = null;
    let trustedValidationCandidateSha = null;
    let trustedValidationCandidateRef = null;
    let trustedValidationAffectedPaths = [];
    let trustedValidationResults = [];
    let publicationAlreadyIntegrated = false;
    let publicationReadyForFinalization = false;
    let validationCheckpointPersisted = false;
    let validationSuccessProven = false;
    let skipValidationForDurableRecovery = false;
    let validationCheckpointGeneration = completionClaimGeneration;
    let validationWorktreeInvariantFailed = false;
    let validatedCheckpointRecoveryPending = false;
    let previousValidationCheckpoint = null;
    const completionValidationRefs = validationCheckpointRefs(completion.id, completionClaimGeneration);
    const trustedValidationReport = () => completion.trustedValidationCommandsJson ? {
      version: 1,
      baselineSha: trustedValidationBaselineSha,
      candidateSha: trustedValidationCandidateSha,
      candidateRef: trustedValidationCandidateRef,
      results: trustedValidationResults
    } : null;
    const persistExactValidationCheckpoint = async () => {
      if (validationCheckpointPersisted || !trustedValidationBaselineSha || !trustedValidationCandidateSha) {
        return;
      }
      const checkpoint = await persistValidationCheckpoint({
        completionId: completion.id,
        claimGeneration: completionClaimGeneration,
        baselineSha: trustedValidationBaselineSha,
        candidateSha: trustedValidationCandidateSha,
        git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot)
      });
      trustedValidationCandidateRef = checkpoint.candidateRef;
      validationCheckpointPersisted = true;
      validationCheckpointGeneration = completionClaimGeneration;
    };
    const validationGit = (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot);
    const probeAuthoritativeRefSha = async (ref) => authoritativeRefShaFromGitResult(await validationGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]), ref);
    const probeAuthoritativeAncestry = async (ancestor, descendant) => authoritativeAncestryFromGitResult(await validationGit(["merge-base", "--is-ancestor", ancestor, descendant]), `${ancestor} -> ${descendant}`);
    const assertValidationWorktree = async (phase) => {
      try {
        await assertExactCleanValidationWorktree({
          expectedSha: trustedValidationCandidateSha ?? "",
          phase,
          git: validationGit
        });
      } catch (error) {
        if (error instanceof ValidationWorktreeInvariantError) {
          validationWorktreeInvariantFailed = true;
        }
        throw error;
      }
    };
    const proveValidatedCandidatePublished = async () => {
      if (!validationSuccessProven || !trustedValidationCandidateSha)
        return false;
      if (useReviewPublicationFlow || runtimeConfig.pushMainAfterMerge) {
        await gitOps.fetchPrune();
      }
      const reviewHeadBranch = useReviewPublicationFlow ? reviewPublicationLease?.targetBranch ?? deriveReviewPrHeadBranch(completion.branch, completion.id).headBranch : null;
      const reviewRemoteHeadSha = reviewHeadBranch ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${reviewHeadBranch}`) : null;
      const remoteIntegrationHeadSha = !useReviewPublicationFlow && runtimeConfig.pushMainAfterMerge ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${runtimeConfig.mainBranch}`) : null;
      const localIntegrationHeadSha = !useReviewPublicationFlow && !runtimeConfig.pushMainAfterMerge ? await probeAuthoritativeRefSha(`refs/heads/${runtimeConfig.mainBranch}`) : null;
      return isValidationCheckpointPublished({
        candidateSha: trustedValidationCandidateSha,
        localIntegrationHeadSha,
        remoteIntegrationHeadSha,
        reviewRemoteHeadSha,
        pushMainAfterMerge: runtimeConfig.pushMainAfterMerge,
        useReviewPublicationFlow,
        isAncestor: probeAuthoritativeAncestry
      });
    };
    const markPublicationDurable = () => {
      const recoveryState = durablePublicationRecoveryState(true);
      publicationAlreadyIntegrated = recoveryState.skipPublicationMutation;
      publicationReadyForFinalization = recoveryState.protectFromTerminalFailure;
    };
    const confirmLeaseAfterPublication = async (operation) => {
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(`Completion publication became durable during ${operation}, but this owner lost its lease; leaving finalization to the current owner.`);
      }
      await renewCompletionLease(true);
      if (completionLeaseRenewal.hasLostLease()) {
        throw new Error(`Completion publication became durable during ${operation}, but this owner lost its lease; leaving finalization to the current owner.`);
      }
    };
    try {
      validationRepairPublicationLease = parseValidationRepairPublicationLease(completion.prBody);
      if (validationRepairPublicationLease && reviewPublicationLease) {
        throw new Error("Completion contains conflicting review and validation-repair publication leases.");
      }
      previousValidationCheckpoint = await loadLatestValidationCheckpoint({
        completionId: completion.id,
        beforeClaimGeneration: completionClaimGeneration,
        git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot)
      });
      validatedCheckpointRecoveryPending = previousValidationCheckpoint?.validationProven === true;
      let processedPrUrl = typeof completion.prUrl === "string" && completion.prUrl.trim().length > 0 ? completion.prUrl.trim() : null;
      healthTracker.progress("refreshing_refs", completion.id);
      console.log(`[${ts2()}] Refreshing refs before applying ${completion.branch}...`);
      try {
        await gitOps.fetchPrune();
      } catch (error) {
        throw error;
      }
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
      healthTracker.progress("applying_candidate", completion.id);
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
      trustedValidationBaselineSha = await probeAuthoritativeRefSha("HEAD");
      if (!trustedValidationBaselineSha) {
        throw new Error("SourceControlManager worktree has no authoritative HEAD commit.");
      }
      let retainedCheckpointApplyResult = null;
      if (previousValidationCheckpoint?.validationProven) {
        validationSuccessProven = true;
        trustedValidationCandidateSha = previousValidationCheckpoint.candidateSha;
        const checkpointHead = useReviewPublicationFlow ? reviewPublicationLease?.targetBranch ?? deriveReviewPrHeadBranch(completion.branch, completion.id).headBranch : null;
        const reviewRemoteHeadSha = checkpointHead ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${checkpointHead}`) : null;
        const remoteIntegrationHeadSha = !useReviewPublicationFlow && runtimeConfig.pushMainAfterMerge ? await probeAuthoritativeRefSha(`refs/remotes/${runtimeConfig.remote}/${runtimeConfig.mainBranch}`) : null;
        const checkpointPublished = await isValidationCheckpointPublished({
          candidateSha: previousValidationCheckpoint.candidateSha,
          localIntegrationHeadSha: trustedValidationBaselineSha,
          remoteIntegrationHeadSha,
          reviewRemoteHeadSha,
          pushMainAfterMerge: runtimeConfig.pushMainAfterMerge,
          useReviewPublicationFlow,
          isAncestor: probeAuthoritativeAncestry
        });
        validatedCheckpointRecoveryPending = false;
        if (shouldSkipValidationForDurableRecovery({
          validationProven: previousValidationCheckpoint.validationProven,
          publicationProven: checkpointPublished
        })) {
          const recoveryState = durablePublicationRecoveryState(true);
          const restoreCheckpoint = await runGitCapture([
            "-C",
            runtimeConfig.repoPath,
            "checkout",
            "-B",
            tempBranch,
            previousValidationCheckpoint.candidateSha
          ], repoRoot);
          if (!restoreCheckpoint.ok) {
            throw new Error(`Failed to restore exact trusted-validation checkpoint ${previousValidationCheckpoint.candidateRef}: ${restoreCheckpoint.stderr || restoreCheckpoint.stdout}`);
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
            exitCode: 0
          };
          console.log(`[${ts2()}] Reusing already-published trusted-validation checkpoint ${previousValidationCheckpoint.candidateSha.slice(0, 8)} without duplicate mutation.`);
        } else {
          validationSuccessProven = false;
          trustedValidationCandidateSha = null;
          retainedCheckpointApplyResult = await applyRetainedValidationCheckpoint({
            baselineSha: previousValidationCheckpoint.baselineSha,
            candidateSha: previousValidationCheckpoint.candidateSha,
            currentIntegrationSha: trustedValidationBaselineSha ?? "",
            git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot)
          });
          console.log(`[${ts2()}] Replayed exact retained checkpoint ${previousValidationCheckpoint.candidateRef} onto the current integration head.`);
        }
      } else if (previousValidationCheckpoint) {
        retainedCheckpointApplyResult = await applyRetainedValidationCheckpoint({
          baselineSha: previousValidationCheckpoint.baselineSha,
          candidateSha: previousValidationCheckpoint.candidateSha,
          currentIntegrationSha: trustedValidationBaselineSha ?? "",
          git: validationGit
        });
        console.log(`[${ts2()}] Replayed unvalidated retained checkpoint ${previousValidationCheckpoint.candidateRef}; validation-success proof is required before publication.`);
      }
      const applyResult = retainedCheckpointApplyResult ? retainedCheckpointApplyResult : reviewPublicationLease ? await (async () => {
        console.log(`[${ts2()}] Checking out exact reviewed completion ${completion.commitSha.slice(0, 8)} on ${tempBranch} for validation...`);
        return runGitCapture([
          "-C",
          runtimeConfig.repoPath,
          ...buildReviewCompletionValidationCheckoutArgs(tempBranch, completion.commitSha)
        ], repoRoot);
      })() : validationRepairPublicationLease ? await (async () => {
        console.log(`[${ts2()}] Applying exact validation-repair chain ${validationRepairPublicationLease.baselineSha.slice(0, 8)} -> ${validationRepairPublicationLease.candidateSha.slice(0, 8)} -> ${completion.commitSha.slice(0, 8)} for incident ${validationRepairPublicationLease.incidentId}...`);
        return applyValidationRepairPublication({
          lease: validationRepairPublicationLease,
          completionSha: completion.commitSha,
          currentIntegrationSha: trustedValidationBaselineSha ?? "",
          git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot)
        });
      })() : runtimeConfig.mergeStrategy === "cherry-pick" ? await (async () => {
        console.log(`[${ts2()}] Cherry-picking ${completion.commitSha.slice(0, 8)} onto ${tempBranch}...`);
        return gitOps.cherryPickRef(completion.commitSha);
      })() : await (async () => {
        console.log(`[${ts2()}] Merging ${completion.branch} into ${tempBranch}...`);
        return runtimeConfig.mergeStrategy === "no-ff" ? gitOps.mergeNoFF(completion.branch, `Merge ${completion.branch}`) : gitOps.mergeFFOnly(completion.branch);
      })();
      if (!applyResult.ok) {
        if (!validationRepairPublicationLease && useReviewPublicationFlow && reviewApplyFailureBlocksPublication({
          reviewAgentEnabled: useReviewPublicationFlow,
          mergeStrategy: runtimeConfig.mergeStrategy,
          applyStdout: applyResult.stdout,
          applyStderr: applyResult.stderr
        })) {
          throw new Error(`Review candidate apply failed; publication is blocked until the exact candidate can be prepared and checked: ${applyResult.stderr || applyResult.stdout}`);
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
        if (previousValidationCheckpoint) {
          trustedValidationBaselineSha = previousValidationCheckpoint.baselineSha;
        } else if (validationRepairPublicationLease) {
          trustedValidationBaselineSha = validationRepairPublicationLease.baselineSha;
        }
      }
      if (trustedValidationBaselineSha && trustedValidationCandidateSha && !await gitOps.isAncestor(trustedValidationBaselineSha, trustedValidationCandidateSha)) {
        trustedValidationBaselineSha = await resolveValidationCheckpointBaseline({
          preApplyBaselineSha: trustedValidationBaselineSha,
          candidateSha: trustedValidationCandidateSha,
          git: (gitArgs) => runGitCapture(["-C", runtimeConfig.repoPath, ...gitArgs], repoRoot)
        });
      }
      await persistExactValidationCheckpoint();
      if (!skipValidationForDurableRecovery && completion.trustedValidationCommandsJson && trustedValidationBaselineSha && trustedValidationCandidateSha) {
        const affectedPathDiff = await validationGit([
          "diff",
          "--name-only",
          "-z",
          trustedValidationBaselineSha,
          trustedValidationCandidateSha,
          "--"
        ]);
        if (!affectedPathDiff.ok) {
          throw new Error(`Unable to derive trusted-validation affected paths for the immutable candidate: ${affectedPathDiff.stderr || affectedPathDiff.stdout}`);
        }
        trustedValidationAffectedPaths = normalizeTrustedValidationAffectedPaths(affectedPathDiff.stdout.split("\x00"));
      }
      if (skipValidationForDurableRecovery) {
        await assertValidationWorktree("published recovery");
        console.log(`[${ts2()}] Exact candidate ${trustedValidationCandidateSha?.slice(0, 8)} already has immutable validation-success and publication proof; skipping duplicate validation.`);
      } else {
        await assertValidationWorktree("before trusted validation");
        if (completion.trustedValidationCommandsJson) {
          healthTracker.progress("trusted_validation", completion.id);
          console.log(`[${ts2()}] Running trusted-environment validation for ${completion.commitSha.slice(0, 8)}...`);
          trustedValidationResults = await runTrustedValidationCommands({
            repoPath: runtimeConfig.repoPath,
            commandsJson: completion.trustedValidationCommandsJson,
            invariantContext: trustedValidationBaselineSha && trustedValidationCandidateSha ? {
              baseSha: trustedValidationBaselineSha,
              candidateSha: trustedValidationCandidateSha,
              affectedPaths: trustedValidationAffectedPaths
            } : undefined,
            onProgress: (event) => healthTracker.progress(trustedValidationHealthPhase(event), completion.id)
          });
          const validationOutcome = resolveTrustedValidationOutcome(trustedValidationResults);
          const terminalResults = new Set(validationOutcome.terminalResults);
          for (const trustedResult of trustedValidationResults) {
            if (trustedResult.phase === "dependency_install") {
              trustedInstallDurationMs = (trustedInstallDurationMs ?? 0) + trustedResult.durationMs;
              trustedValidationCacheHit = Boolean(trustedResult.cached);
            } else {
              trustedValidationDurationMs = (trustedValidationDurationMs ?? 0) + trustedResult.durationMs;
            }
            const timing = `${trustedResult.durationMs}ms${trustedResult.cached ? ", cache hit" : ""}`;
            console.log(`[${ts2()}] trustedValidationTiming=${JSON.stringify({
              event: "trusted_validation_timing",
              jobId: completion.jobId,
              commitSha: completion.commitSha,
              command: trustedResult.command,
              phase: trustedResult.phase,
              durationMs: trustedResult.durationMs,
              cached: Boolean(trustedResult.cached),
              ok: trustedResult.ok,
              attempt: trustedResult.attempt ?? 1,
              retryReason: trustedResult.retryReason ?? null
            })}`);
            if (trustedResult.ok) {
              console.log(`[${ts2()}]   - Trusted validation passed (${timing}, attempt ${trustedResult.attempt ?? 1}): ${trustedResult.command}`);
            } else if (!terminalResults.has(trustedResult)) {
              console.warn(`[${ts2()}]   - Trusted validation attempt ${trustedResult.attempt ?? 1} failed after ${timing} and was retried: ${trustedResult.command}`);
            }
          }
          if (validationOutcome.terminalFailure) {
            const trustedResult = validationOutcome.terminalFailure;
            const timing = `${trustedResult.durationMs}ms${trustedResult.cached ? ", cache hit" : ""}`;
            throw new Error(`Trusted validation "${trustedResult.command}" failed after ${timing} (exit ${trustedResult.exitCode}): ${trustedResult.output}`);
          }
          await assertValidationWorktree("after trusted validation");
        }
        console.log(`[${ts2()}] Running checks...`);
        for (const check of runtimeConfig.checks) {
          console.log(`[${ts2()}]   - Running check: ${check.name}`);
          const checkResult = await runCheck(runtimeConfig.repoPath, check);
          if (!checkResult.ok) {
            throw new Error(`Check "${check.name}" failed: ${checkResult.output}`);
          }
          console.log(`[${ts2()}]   - Check passed: ${check.name}`);
          await assertValidationWorktree(`after check ${check.name}`);
        }
        await assertValidationWorktree("after all checks");
        await persistValidationSuccessProof({
          completionId: completion.id,
          claimGeneration: validationCheckpointGeneration,
          candidateSha: trustedValidationCandidateSha ?? "",
          git: validationGit
        });
        validationSuccessProven = true;
        if (await proveValidatedCandidatePublished()) {
          const recoveryState = durablePublicationRecoveryState(true);
          publicationAlreadyIntegrated = recoveryState.skipPublicationMutation;
          publicationReadyForFinalization = recoveryState.protectFromTerminalFailure;
          console.log(`[${ts2()}] Exact validated candidate ${trustedValidationCandidateSha?.slice(0, 8)} is already durable on its authoritative publication ref.`);
        }
      }
      await persistExactValidationCheckpoint();
      healthTracker.progress("publication", completion.id);
      await requireCompletionLease("publication");
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
        if (publicationAlreadyIntegrated) {
          console.log(`[${ts2()}] Review completion ${completion.id} is already present on ${prHeadBranch}; skipping duplicate branch mutation.`);
        } else if (shouldPublishWithExactReviewLease(reviewPublicationLease)) {
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
          await requireCompletionLease(`review branch push ${prHeadBranch}`);
          const publication = await publishWithAuthoritativeProof({
            mutate: () => runGitCapture([
              "-C",
              runtimeConfig.repoPath,
              ...buildReviewPublicationPushArgs({
                remote: runtimeConfig.remote,
                commitSha: completion.commitSha,
                lease: reviewPublicationLease
              })
            ], repoRoot),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Failed exact-lease publication for review branch ${prHeadBranch}`
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(`[${ts2()}] Review push reported failure after ${prHeadBranch} became authoritative; continuing with durable recovery.`);
          }
          await confirmLeaseAfterPublication(`review branch push ${prHeadBranch}`);
        } else if (resolvedHead.requiresMaterialize) {
          const publishRef = "HEAD";
          const remoteHeadBeforePublication = await gitOps.revParse(`refs/remotes/${runtimeConfig.remote}/${prHeadBranch}`);
          const explicitLease = `--force-with-lease=refs/heads/${prHeadBranch}:${remoteHeadBeforePublication ?? ""}`;
          console.log(`[${ts2()}] ReviewAgent mode - materializing hidden completion ref ${completion.branch} -> refs/heads/${prHeadBranch} with an exact remote lease.`);
          await requireCompletionLease(`review branch materialization ${prHeadBranch}`);
          const publication = await publishWithAuthoritativeProof({
            mutate: () => runGitCapture([
              "-C",
              runtimeConfig.repoPath,
              "push",
              explicitLease,
              runtimeConfig.remote,
              `${publishRef}:refs/heads/${prHeadBranch}`
            ], repoRoot),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Failed to publish review branch ${prHeadBranch}`
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(`[${ts2()}] Review materialization reported failure after ${prHeadBranch} became authoritative; continuing with durable recovery.`);
          }
          await confirmLeaseAfterPublication(`review branch materialization ${prHeadBranch}`);
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
        await requireCompletionLease(`pull request creation for ${prHeadBranch}`);
        const pr = await ensureIntegrationPullRequest({
          token,
          remoteUrl,
          headBranch: prHeadBranch,
          baseBranch: prBaseBranch,
          title: prTitle,
          body: prBody,
          draft: false
        });
        if (!pr.created && !publicationAlreadyIntegrated) {
          reviewAgentForTick?.requestReReview(pr.number, completion.commitSha);
        }
        const prMessage = pr.created ? `Opened individual PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}` : `Reused existing PR #${pr.number} for ReviewAgent: ${pr.htmlUrl}`;
        processedPrUrl = pr.htmlUrl;
        console.log(`[${ts2()}] ${prMessage}`);
        await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
      } else {
        if (!publicationAlreadyIntegrated) {
          await requireCompletionLease(`merge to ${runtimeConfig.mainBranch}`);
          console.log(`[${ts2()}] Merging ${tempBranch} to ${runtimeConfig.mainBranch}...`);
          await gitOps.checkoutMain();
          const ffResult = await gitOps.mergeFFOnlyRef(tempBranch);
          if (!ffResult.ok) {
            throw new Error(`FF merge to main failed: ${ffResult.stderr || ffResult.stdout}`);
          }
          console.log(`[${ts2()}] \u2713 Successfully merged ${completion.branch} to ${config.mainBranch}`);
        } else {
          console.log(`[${ts2()}] Completion ${completion.id} is already present on ${runtimeConfig.mainBranch}; skipping duplicate merge and push.`);
        }
        if (runtimeConfig.pushMainAfterMerge && !publicationAlreadyIntegrated) {
          await requireCompletionLease(`push to ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`);
          console.log(`[${ts2()}] Pushing ${runtimeConfig.mainBranch} to ${runtimeConfig.remote}...`);
          const publication = await publishWithAuthoritativeProof({
            mutate: () => gitOps.pushMain(),
            provePublished: proveValidatedCandidatePublished,
            failurePrefix: `Push failed for ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`
          });
          markPublicationDurable();
          if (publication.recoveredFromAmbiguousFailure) {
            console.warn(`[${ts2()}] Push reported failure after ${runtimeConfig.remote}/${runtimeConfig.mainBranch} contained the exact validated candidate; continuing with durable recovery.`);
          } else {
            console.log(`[${ts2()}] Push succeeded for ${runtimeConfig.mainBranch}`);
          }
          await confirmLeaseAfterPublication(`push to ${runtimeConfig.remote}/${runtimeConfig.mainBranch}`);
          if (runtimeConfig.openPrAfterPush) {
            try {
              await requireCompletionLease("aggregated pull request creation");
              const pr = await ensureMainPullRequest(completion, runtimeConfig);
              const prMessage = pr.created ? `Opened PR #${pr.number}: ${pr.htmlUrl}` : `Reused existing PR #${pr.number}: ${pr.htmlUrl}`;
              processedPrUrl = pr.htmlUrl;
              console.log(`[${ts2()}] ${prMessage}`);
              await emitPusherMessage(comm, prMessage, completion.id, completionEventMeta);
            } catch (prErr) {
              if (completionLeaseRenewal.hasLostLease())
                throw prErr;
              const warning = `Push succeeded, but PR auto-open failed: ${prErr?.message ?? prErr}`;
              console.error(`[${ts2()}] ${warning}`);
              await emitPusherMessage(comm, warning, completion.id, completionEventMeta);
            }
          }
        } else if (!publicationAlreadyIntegrated) {
          console.log(`[${ts2()}] pushMainAfterMerge=false - skipping push`);
          if (!await proveValidatedCandidatePublished()) {
            throw new Error(`Local publication proof for ${runtimeConfig.mainBranch} did not contain exact validated candidate ${trustedValidationCandidateSha}.`);
          }
          markPublicationDurable();
          await confirmLeaseAfterPublication(`local merge to ${runtimeConfig.mainBranch}`);
        }
      }
      await requireCompletionLease("final authoritative publication proof");
      publicationAlreadyIntegrated = false;
      publicationReadyForFinalization = false;
      await assertFinalAuthoritativePublicationProof({
        provePublished: proveValidatedCandidatePublished,
        failurePrefix: `Final authoritative publication proof no longer contains exact validated candidate ${trustedValidationCandidateSha}`
      });
      markPublicationDurable();
      if (!publicationReadyForFinalization) {
        throw new Error("Publication finished without authoritative validation and durability proof; refusing completion finalization.");
      }
      await gitOps.deleteTempBranch(tempBranch);
      healthTracker.progress("completion_callback", completion.id);
      await requireCompletionLease("processed callback");
      const additionalValidationRefs = validationRepairPublicationLease?.candidateRef ? [
        validationRepairPublicationLease.candidateRef,
        validationRepairPublicationLease.candidateRef.replace(/\/candidate$/, "/baseline"),
        validationRepairPublicationLease.candidateRef.replace(/\/candidate$/, "/validated")
      ] : [];
      completionGcRecord = completionGcJournal.enqueue(createCompletionGcRecord({
        completionId: completion.id,
        completionBranch: completion.branch,
        commitSha: completion.commitSha,
        claimGeneration: completionClaimGeneration,
        remote: reviewPublicationLease && completion.branch.startsWith("refs/pushpals/") ? runtimeConfig.remote : null,
        additionalValidationRefs
      }));
      const markResult = await postCompletionProcessedWithRetry({
        request: async (signal) => {
          const response2 = await fetchBufferedWithHardDeadline({
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
                trustedValidationReport: trustedValidationReport()
              })
            },
            timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
            timeoutMessage: `Completion processed callback timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`
          });
          return parseCompletionPositiveAck(response2);
        }
      });
      if (!markResult.confirmed) {
        const callbackDetail = markResult.lastStatus ? `HTTP ${markResult.lastStatus}` : markResult.lastError || "no response";
        console.warn(`[${ts2()}] Publication completed for ${completion.id}, but its processed callback is unconfirmed after ${markResult.attempts} attempt(s): ${callbackDetail}. Retaining the immutable checkpoint for stale-claim reconciliation.`);
        await emitPusherMessage(comm, `Publication completed for ${completion.id.slice(0, 8)}, but finalization acknowledgement is pending. SourceControlManager retained the exact checkpoint and will reconcile it without publishing again.`, completion.id, completionEventMeta);
      } else {
        console.log(`[${ts2()}] Marked completion ${completion.id} as processed`);
        cleanupCompletionHandoff = true;
        const pushMessage = useReviewPublicationFlow ? `Checks passed for ${completion.commitSha.slice(0, 8)} from ${completion.branch}. Individual PR is ready for ReviewAgent review.` : config.pushMainAfterMerge ? `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} and pushed to ${config.remote}/${config.mainBranch}.` : `Merged ${completion.commitSha.slice(0, 8)} from ${completion.branch} into ${config.mainBranch} (push disabled).`;
        await emitPusherMessage(comm, pushMessage, completion.id, completionEventMeta);
      }
    } catch (err) {
      const publicationConfirmationPending = err instanceof PublicationConfirmationPendingError;
      const publicationAttemptUncertain = err instanceof PublicationAuthorityUnreachableError;
      let authoritativeReprobe = "absent";
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
        err = new Error(`${err?.message ?? err}; additionally failed to retain exact trusted-validation candidate: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`);
      }
      if (!publicationReadyForFinalization && validationSuccessProven) {
        try {
          if (await proveValidatedCandidatePublished()) {
            markPublicationDurable();
            authoritativeReprobe = "published";
            console.warn(`[${ts2()}] Recovered authoritative publication proof for ${completion.id} after an ambiguous publication error.`);
          } else {
            authoritativeReprobe = "absent";
          }
        } catch (publicationProbeError) {
          authoritativeReprobe = "unreachable";
          console.warn(`[${ts2()}] Could not confirm authoritative publication state for ${completion.id}: ${publicationProbeError instanceof Error ? publicationProbeError.message : String(publicationProbeError)}`);
        }
      }
      const failureDisposition = publicationFailureDisposition({
        publicationReadyForFinalization,
        publicationAttemptUncertain,
        publicationConfirmationPending,
        authoritativeReprobe,
        validatedCheckpointRecoveryPending
      });
      if (failureDisposition === "finalize") {
        console.warn(`[${ts2()}] Publication completed for ${completion.id}, but finalization is pending after: ${err.message}. Retaining the completion for idempotent stale-claim recovery.`);
        try {
          await emitPusherMessage(comm, `Publication completed for ${completion.id.slice(0, 8)}, but finalization acknowledgement is pending. SourceControlManager retained the exact checkpoint and will reconcile it without publishing again. Detail: ${err.message}`, completion.id, completionEventMeta);
        } catch (messageError) {
          console.warn(`[${ts2()}] Could not emit pending-finalization status for ${completion.id}: ${messageError instanceof Error ? messageError.message : String(messageError)}`);
        }
      } else if (failureDisposition === "reconcile") {
        console.warn(`[${ts2()}] Publication outcome is not yet confirmed for ${completion.id}. Retaining the immutable checkpoint and leaving the completion nonterminal for stale-claim reconciliation.`);
        try {
          await emitPusherMessage(comm, `Publication outcome is temporarily unconfirmed for ${completion.id.slice(0, 8)}. SourceControlManager retained the exact validated checkpoint and will reconcile it on the next authoritative recheck; the job was not marked failed.`, completion.id, completionEventMeta);
        } catch (messageError) {
          console.warn(`[${ts2()}] Could not emit uncertain-publication status for ${completion.id}: ${messageError instanceof Error ? messageError.message : String(messageError)}`);
        }
      } else {
        console.error(`[${ts2()}] Failed to process completion ${completion.id}: ${err.message}`);
        const failResult = await postCompletionCallbackWithRetry({
          attempts: 2,
          request: async (signal) => {
            const response2 = await fetchBufferedWithHardDeadline({
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
                  trustedValidationReport: trustedValidationReport()
                })
              },
              timeoutMs: SERVER_CONTROL_HTTP_TIMEOUT_MS,
              timeoutMessage: `Completion failure callback timed out after ${SERVER_CONTROL_HTTP_TIMEOUT_MS}ms.`
            });
            return parseCompletionPositiveAck(response2);
          }
        });
        if (!failResult.confirmed) {
          const callbackDetail = failResult.lastStatus ? `HTTP ${failResult.lastStatus}` : failResult.lastError || "no response";
          console.warn(`[${ts2()}] Completion ${completion.id} failed, but its failure callback is unconfirmed after ${failResult.attempts} attempt(s): ${callbackDetail}. Lease recovery will reconcile it.`);
        }
        await emitPusherMessage(comm, `Failed to apply completion ${completion.id.slice(0, 8)} from ${completion.branch}: ${err.message}`, completion.id, completionEventMeta);
      }
    } finally {
      clearInterval(completionLeaseHeartbeatTimer);
      try {
        await gitOps.resetToClean();
      } catch (err) {
        console.warn(`[${ts2()}] Failed to reset SourceControlManager worktree after completion ${completion.id}: ${err?.message ?? err}`);
      }
      if (validationWorktreeInvariantFailed) {
        try {
          const cleanResult = await validationGit(["clean", "-ffd"]);
          if (!cleanResult.ok) {
            console.warn(`[${ts2()}] Failed to remove files created by a mutating validation command: ${cleanResult.stderr || cleanResult.stdout}`);
          }
        } catch (err) {
          console.warn(`[${ts2()}] Failed to clean validation-created files from the disposable SourceControlManager worktree: ${err?.message ?? err}`);
        }
      }
      try {
        if (tempBranch && await gitOps.revParse(tempBranch)) {
          await gitOps.deleteTempBranch(tempBranch);
        }
      } catch (err) {
        console.warn(`[${ts2()}] Failed to delete temp branch ${tempBranch} during final cleanup: ${err?.message ?? err}`);
      }
      if (cleanupCompletionHandoff && completionGcRecord) {
        try {
          const cleaned = await cleanupProcessedCompletionRefs(runtimeConfig, completionGcRecord);
          if (cleaned) {
            completionGcJournal.remove(completionGcRecord);
          } else {
            console.warn(`[${ts2()}] Processed completion ${completion.id} has more retained refs than one bounded cleanup batch; the journal will resume cleanup next tick.`);
          }
        } catch (err) {
          console.warn(`[${ts2()}] Failed to clean processed completion refs for ${completion.id}; the durable GC journal will retry: ${err?.message ?? err}`);
        }
      } else if (cleanupHiddenCompletionRef) {
        console.warn(`[${ts2()}] Retaining completion handoff ${completion.branch} because publication did not reach a confirmed processed state.`);
      }
    }
  } catch (err) {
    console.error(`[${ts2()}] Poll error: ${err.message}`);
  } finally {
    healthTracker.completeTick();
  }
}
async function runCheck(repoPath, check) {
  const timeoutMs = check.timeoutMs ?? 300000;
  const isWindows = process.platform === "win32";
  const shell = isWindows ? ["cmd", "/c"] : ["sh", "-c"];
  const result = await runProcessWithTreeTimeout([...shell, check.command], {
    cwd: repoPath,
    timeoutMs
  });
  return { ok: result.ok, output: result.output };
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
  mkdirSync4(resolve11(config.repoPath, ".."), { recursive: true });
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
  const rel = relative2(repoRoot, config.repoPath).replace(/\\/g, "/");
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
  startPublicationHealthPolling();
  startReviewAgentRuntimeConfigPolling();
  syncReviewAgentRuntimeConfig().catch((err) => {
    const detail = err?.message ?? String(err);
    logReviewAgentRuntimeState(`config-error:${detail}`, `[${ts2()}] Initial ReviewAgent runtime config sync failed: ${detail}`, "warn");
  });
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
    if (publicationHealthTimer) {
      clearInterval(publicationHealthTimer);
      publicationHealthTimer = null;
    }
    if (reviewAgentConfigPollTimer) {
      clearInterval(reviewAgentConfigPollTimer);
      reviewAgentConfigPollTimer = null;
    }
    await clearReviewAgentPollLoop();
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
    await repositoryServices.close();
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
