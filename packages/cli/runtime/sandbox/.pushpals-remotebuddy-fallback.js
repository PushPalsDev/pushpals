#!/usr/bin/env bun
// @bun

// apps/remotebuddy/src/remotebuddy_main.ts
import { randomUUID as randomUUID2 } from "crypto";
import { Database as Database3 } from "bun:sqlite";

// apps/remotebuddy/src/llm.ts
import { spawn } from "child_process";
import { existsSync as existsSync3, mkdtempSync, readFileSync as readFileSync4, rmSync } from "fs";
import { tmpdir } from "os";
import { join as join3 } from "path";

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
function detectRepoRoot(startDir) {
  const repoRoot = findGitRepoRoot(startDir);
  if (repoRoot) {
    return repoRoot;
  }
  console.warn(`[repo] No .git directory found, using: ${startDir}`);
  return startDir;
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
  constructor(opts) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.from = opts.from;
    this.authToken = opts.authToken ?? null;
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
      const response = await fetch(this.commandUrl(sessionId), {
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
function resolveRepoDocPath(relativePath) {
  const repoRoot = detectRepoRoot(process.cwd());
  return join(repoRoot, relativePath);
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
function loadRepoDocText(relativePath, opts) {
  const pathValue = String(relativePath ?? "").trim();
  if (!pathValue) {
    throw new Error("[docs] relativePath is required");
  }
  const docPath = resolveRepoDocPath(pathValue);
  const shouldCache = opts?.cache !== false;
  if (shouldCache) {
    const cached = repoDocCache.get(docPath);
    if (cached !== undefined)
      return cached;
  }
  const text = readFileSync2(docPath, "utf8");
  if (shouldCache) {
    repoDocCache.set(docPath, text);
  }
  return text;
}
// packages/shared/src/config.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { join as join2, resolve as resolve3, isAbsolute } from "path";

// packages/shared/src/autonomy_policy.ts
import { createHash } from "crypto";
var PATH_META_RE = /[*?\[\]{}()!]/;
var DRIVE_RE = /^[A-Za-z]:\//;
var SLASH_RE = /\/+/g;
function parentPath(path) {
  const idx = path.lastIndexOf("/");
  if (idx <= 0)
    return path;
  return path.slice(0, idx);
}
function isProbablyFilePath(path) {
  const lastSegment = path.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
}
function scopeSeedPath(path) {
  return isProbablyFilePath(path) ? parentPath(path) : path;
}
function commonRepoAncestor(paths) {
  const normalized = paths.map((entry) => normalizeRepoRelativePath(entry)).filter((entry) => Boolean(entry));
  if (normalized.length === 0)
    return null;
  if (normalized.length === 1)
    return normalized[0] ?? null;
  const segments = normalized.map((entry) => entry.split("/"));
  const shared = [];
  const first = segments[0] ?? [];
  for (let idx = 0;idx < first.length; idx += 1) {
    const segment = first[idx];
    if (!segment)
      break;
    if (segments.every((parts) => parts[idx] === segment)) {
      shared.push(segment);
      continue;
    }
    break;
  }
  if (shared.length === 0)
    return null;
  return shared.join("/");
}
function normalizeAutonomyComponentArea(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  return normalized;
}
function deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput) {
  const writePrefixes = Array.isArray(writeGlobsInput) ? writeGlobsInput.map((entry) => normalizeWriteGlob(entry)).filter((entry) => Boolean(entry)).map((entry) => literalPrefix(entry)).map((entry) => scopeSeedPath(entry)).filter(Boolean) : [];
  if (writePrefixes.length > 0) {
    return commonRepoAncestor(writePrefixes);
  }
  const targetSeeds = Array.isArray(targetPathsInput) ? targetPathsInput.map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry)).map((entry) => scopeSeedPath(entry)).filter(Boolean) : [];
  if (targetSeeds.length === 0)
    return null;
  return commonRepoAncestor(targetSeeds);
}
function collectScopeSeedPaths(targetPathsInput, writeGlobsInput) {
  const seeds = new Set;
  if (Array.isArray(writeGlobsInput)) {
    for (const raw of writeGlobsInput) {
      const normalized = normalizeWriteGlob(raw);
      if (!normalized)
        continue;
      const prefix = literalPrefix(normalized);
      if (!prefix)
        continue;
      const seed = scopeSeedPath(prefix);
      if (seed)
        seeds.add(seed);
    }
  }
  if (Array.isArray(targetPathsInput)) {
    for (const raw of targetPathsInput) {
      const normalized = normalizeTargetPath(raw);
      if (!normalized)
        continue;
      const seed = scopeSeedPath(normalized);
      if (seed)
        seeds.add(seed);
    }
  }
  return [...seeds];
}
function componentRootPrefix(area) {
  const normalized = normalizeAutonomyComponentArea(area);
  if (!normalized)
    return "";
  return `${normalized}/`;
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
function isSupportedGlobSyntax(glob) {
  if (!glob)
    return false;
  if (glob.includes("\\"))
    return false;
  if (/[{}\[\]()!]/.test(glob))
    return false;
  const segments = glob.split("/");
  for (const segment of segments) {
    if (!segment || segment === ".")
      return false;
    if (segment === "..")
      return false;
    const idx = segment.indexOf("**");
    if (idx >= 0 && segment !== "**")
      return false;
  }
  return true;
}
function normalizeWriteGlob(value) {
  if (typeof value !== "string")
    return null;
  let glob = value.trim();
  if (!glob)
    return null;
  glob = glob.normalize("NFC").replace(/\\/g, "/");
  if (glob.startsWith("/"))
    return null;
  if (DRIVE_RE.test(glob))
    return null;
  while (glob.startsWith("./"))
    glob = glob.slice(2);
  glob = glob.replace(SLASH_RE, "/").replace(/\/+$/, "");
  if (!glob)
    return null;
  if (!isSupportedGlobSyntax(glob))
    return null;
  return glob;
}
function literalPrefix(glob) {
  const segments = glob.split("/");
  const out = [];
  for (const segment of segments) {
    if (segment === "**" || segment.includes("*") || segment.includes("?"))
      break;
    out.push(segment);
  }
  return out.join("/");
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
function clamp01(value) {
  if (!Number.isFinite(value))
    return 0;
  if (value < 0)
    return 0;
  if (value > 1)
    return 1;
  return value;
}
function normalizePenalties(values) {
  const map = new Map;
  for (const value of values) {
    const reason = String(value.reason ?? "").trim();
    const kind = value.kind;
    if (!kind || !reason)
      continue;
    const key = `${kind}\u241F${reason}`;
    if (map.has(key))
      continue;
    map.set(key, {
      kind,
      reason,
      weight: clamp01(Number(value.weight)),
      evidence_ids: Array.isArray(value.evidence_ids) ? value.evidence_ids.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, 24) : []
    });
  }
  return [...map.values()].sort((a, b) => {
    if (a.kind === b.kind)
      return a.reason.localeCompare(b.reason);
    return a.kind.localeCompare(b.kind);
  });
}
function penaltyTotal(values) {
  return normalizePenalties(values).reduce((sum, value) => sum + clamp01(value.weight), 0);
}
function globBreadthScore(glob) {
  const hasGlobStar = glob.includes("**") ? 1 : 0;
  const wildcardCount = (glob.match(/[\*\?]/g) ?? []).length;
  const rootWide = /^[\*]/.test(glob) || glob.startsWith("**/") ? 1 : 0;
  const literalSegments = glob.split("/").filter((segment) => segment.length > 0 && !segment.includes("*") && !segment.includes("?")).length;
  const shallowPenalty = Math.max(0, 2 - Math.min(literalSegments, 2));
  return 4 * hasGlobStar + 2 * rootWide + Math.min(4, wildcardCount) + shallowPenalty;
}
function classifyGlobBreadth(writeGlobs) {
  const scores = writeGlobs.map(globBreadthScore);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const max = Math.max(...scores, 0);
  if (max <= 3 && total <= 6 && writeGlobs.length <= 3)
    return "narrow";
  if (max <= 6 && total <= 12 && writeGlobs.length <= 5)
    return "medium";
  return "broad";
}
function underRoot(path, rootPrefix) {
  if (path.startsWith(rootPrefix))
    return true;
  return rootPrefix.endsWith("/") && path === rootPrefix.slice(0, -1);
}
function hasForbiddenBroadGlob(glob) {
  if (glob === "." || glob === "**")
    return true;
  if (glob === "*" || glob === "*/**")
    return true;
  if (glob === "**/*" || glob === "**/**")
    return true;
  return false;
}
function validateScopeInvariants(componentArea, targetPathsInput, writeGlobsInput, options) {
  const errors = [];
  const scopeSeeds = collectScopeSeedPaths(targetPathsInput, writeGlobsInput);
  const normalizedComponentArea = normalizeAutonomyComponentArea(componentArea) ?? deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput);
  const allowMultipleComponentRoots = options?.allowMultipleComponentRoots === true;
  if (!normalizedComponentArea && scopeSeeds.length > 1 && !allowMultipleComponentRoots) {
    errors.push(`scope spans multiple component roots: ${scopeSeeds.slice(0, 6).join(", ")}`);
  }
  const rootPrefix = normalizedComponentArea ? componentRootPrefix(normalizedComponentArea) : "";
  const normalizedTargetPaths = [];
  const targetSeen = new Set;
  for (const raw of targetPathsInput) {
    const normalized = normalizeTargetPath(raw);
    if (!normalized) {
      errors.push(`invalid target_path: ${String(raw ?? "")}`);
      continue;
    }
    if (rootPrefix && !underRoot(normalized, rootPrefix)) {
      errors.push(`target_path outside component root: ${normalized}`);
      continue;
    }
    if (targetSeen.has(normalized))
      continue;
    targetSeen.add(normalized);
    normalizedTargetPaths.push(normalized);
  }
  normalizedTargetPaths.sort();
  if (normalizedTargetPaths.length === 0) {
    errors.push("target_paths must contain at least one literal path");
  }
  const normalizedWriteGlobs = [];
  const writeSeen = new Set;
  for (const raw of writeGlobsInput) {
    const normalized = normalizeWriteGlob(raw);
    if (!normalized) {
      errors.push(`invalid write_glob: ${String(raw ?? "")}`);
      continue;
    }
    if (hasForbiddenBroadGlob(normalized)) {
      errors.push(`forbidden broad write_glob: ${normalized}`);
      continue;
    }
    const prefix = literalPrefix(normalized);
    if (!prefix) {
      errors.push(`write_glob literal prefix cannot be empty: ${normalized}`);
      continue;
    }
    if (rootPrefix && !underRoot(prefix, rootPrefix)) {
      errors.push(`write_glob outside component root: ${normalized}`);
      continue;
    }
    if (!normalizedTargetPaths.some((targetPath) => targetPath === prefix || targetPath.startsWith(`${prefix}/`))) {
      errors.push(`write_glob prefix does not align with target_paths: ${normalized}`);
      continue;
    }
    if (writeSeen.has(normalized))
      continue;
    writeSeen.add(normalized);
    normalizedWriteGlobs.push(normalized);
  }
  normalizedWriteGlobs.sort();
  if ((options?.requireWriteGlobs ?? true) && normalizedWriteGlobs.length === 0) {
    errors.push("write_globs must be provided and non-empty");
  }
  if (normalizedTargetPaths.length > 0 && normalizedWriteGlobs.length > 0) {
    for (const targetPath of normalizedTargetPaths) {
      const covered = normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob));
      if (!covered)
        errors.push(`target_path not covered by write_globs: ${targetPath}`);
    }
  }
  if (!normalizedComponentArea && !allowMultipleComponentRoots) {
    errors.push("component_area could not be derived from scope");
  }
  const breadth = classifyGlobBreadth(normalizedWriteGlobs);
  return {
    ok: errors.length === 0,
    componentArea: normalizedComponentArea,
    normalizedTargetPaths,
    normalizedWriteGlobs,
    breadth,
    errors
  };
}
function makePatternKey(objectiveType, targetPaths, triggerType, componentArea) {
  const normalizedTargets = [...targetPaths].map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry)).filter((entry, index, array) => array.indexOf(entry) === index).sort();
  const payload = [
    String(objectiveType ?? "").trim(),
    normalizedTargets.join(","),
    String(triggerType ?? "").trim(),
    String(componentArea ?? "").trim()
  ].join("|");
  const digest = createHash("sha256").update(payload).digest("hex");
  return `pk_${digest}`;
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
var DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 1;
var DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
var DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
var DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
var DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
var DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 45000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8000;
var DEFAULT_WORKERPALS_EXECUTOR = "openai_codex";
var DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
var DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
var REDACTED_LOG_VALUE = "[REDACTED]";
var SENSITIVE_CONFIG_KEY_PATTERN = /(token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key)/i;
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
  const raw = readFileSync3(path, "utf-8");
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
  const sessionTokenBudget = Math.max(0, asInt(parseIntEnv("PUSHPALS_SESSION_TOKEN_BUDGET") ?? serverNode.session_token_budget, 1e6));
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
    const parsed = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
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
function sanitizeConfigString(value) {
  let out = String(value ?? "");
  if (!out)
    return out;
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
  out = out.replace(/https%3a\/\/[^@\s/]+@/gi, "https%3A//***@");
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-:+/=]+\b/gi, "$1***");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***");
  out = out.replace(/\bglpat-[A-Za-z0-9\-_]{20,}\b/gi, "glpat-***");
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-***");
  return out;
}
function sanitizeConfigValueForLogging(value, parentKey = "") {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
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
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeConfigValueForLogging(entry, key);
    }
    return out;
  }
  return String(value);
}
function sanitizePushPalsConfigForLogging(value) {
  return sanitizeConfigValueForLogging(value);
}

// packages/shared/src/vision.ts
var SECTION_HEADING_RE = /^##\s+(\d+)\)\s+(.+?)\s*$/;
var ANY_HEADING_RE = /^##+\s+(.+?)\s*$/;
var ONE_SENTENCE_PROMPT_RE = /^\>\s*\*\*One sentence:\*\*\s*(.+)\s*$/i;
var BLOCKQUOTE_RE = /^\>\s*(.+?)\s*$/;
var BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
var MAX_KEY_ITEMS_PER_BUCKET = 8;
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
function normalizeVisionSectionRef(value) {
  const text = String(value ?? "").trim();
  if (!text)
    return "";
  const match = text.match(/\d+/);
  if (!match)
    return "";
  const numeric = Number.parseInt(match[0], 10);
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "";
}
function normalizeVisionSectionRefs(values, allowedSectionNumbers) {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    const normalized = normalizeVisionSectionRef(value);
    if (!normalized)
      continue;
    if (allowedSectionNumbers && !allowedSectionNumbers.has(normalized))
      continue;
    if (seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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
    riskPolicy: dedupeAndClamp(buckets.riskPolicy),
    operatingModel: dedupeAndClamp(buckets.operatingModel),
    governance: dedupeAndClamp(buckets.governance)
  };
}
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/remotebuddy/src/llm.ts
var DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
var DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
var DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
var DEFAULT_MODEL = "local-model";
var DEFAULT_CODEX_MODEL = "gpt-5.4";
var DEFAULT_CODEX_TIMEOUT_MS = 120000;
var DEFAULT_LMSTUDIO_CONTEXT_WINDOW = 4096;
var DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS = 256;
var DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN = 64;
var DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES = 3;
var CONTEXT_PACKER_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/context_packer_system_prompt.md").trim();
var CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/context_packer_condensed_history_system_prompt.md").trim();
var KNOWN_PROVIDER_PREFIXES = new Set([
  "openai",
  "azure",
  "ollama",
  "openrouter",
  "anthropic",
  "google",
  "gemini",
  "vertex_ai",
  "bedrock",
  "cohere",
  "groq",
  "mistral",
  "huggingface",
  "replicate",
  "deepseek",
  "xai",
  "together_ai",
  "fireworks_ai"
]);
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
function normalizeCodexAuthMode(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "auto")
    return "auto";
  if (normalized === "api_key" || normalized === "api-key" || normalized === "api") {
    return "api_key";
  }
  if (normalized === "chatgpt" || normalized === "chatgpt_login" || normalized === "chatgpt-pro" || normalized === "subscription") {
    return "chatgpt";
  }
  return "auto";
}
function codexConfiguredAuthMode(configuredValue) {
  return normalizeCodexAuthMode(firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_AUTH_MODE, configuredValue, "auto"));
}
function codexCommandOverrideParts(configuredValue) {
  const jsonOverride = firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BIN_JSON);
  if (jsonOverride) {
    try {
      const parsed = JSON.parse(jsonOverride);
      if (Array.isArray(parsed)) {
        const args = parsed.map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0);
        if (args.length > 0)
          return args;
      }
    } catch {}
  }
  const stringOverride = firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BIN, configuredValue, "") ?? "";
  if (!stringOverride)
    return [];
  return splitArgs(stringOverride);
}
function codexBaseUrlOverride() {
  return firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BASE_URL, "") ?? "";
}
function codexTimeoutMs(configuredTimeoutMs) {
  const raw = typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? String(Math.floor(configuredTimeoutMs)) : "";
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0)
    return parsed;
  return DEFAULT_CODEX_TIMEOUT_MS;
}
function codexReasoningEffort(configured, model) {
  const raw = (configured ?? "").trim().toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(model.trim());
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw === "xhigh" && !supportsExtraHigh ? "high" : raw;
  }
  if (raw === "extra high" || raw === "extra-high" || raw === "extrahigh" || raw === "x-high") {
    return supportsExtraHigh ? "xhigh" : "high";
  }
  return "high";
}
function normalizeCodexModel(rawModel) {
  const model = rawModel.trim();
  if (!model)
    return DEFAULT_CODEX_MODEL;
  if (!model.includes("/"))
    return model;
  const [provider, bare] = model.split("/", 2);
  if (provider.trim().toLowerCase() === "openai" && bare.trim()) {
    return bare.trim();
  }
  return model;
}
function normalizeOpenAiBaseFromEndpoint(rawEndpoint) {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  if (!trimmed)
    return "";
  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  if (trimmed.endsWith("/chat/completions")) {
    const base = trimmed.slice(0, -"/chat/completions".length);
    if (!base)
      return "";
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return trimmed;
}
async function runProcess(command, opts) {
  const timeoutMs = opts.timeoutMs ?? 0;
  return new Promise((resolve4, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe"
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeout = null;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (err) => {
      if (finished)
        return;
      finished = true;
      cleanup();
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (finished)
        return;
      finished = true;
      cleanup();
      resolve4({ code, signal, stdout, stderr, timedOut });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1000).unref();
      }, timeoutMs);
    }
    if (typeof opts.stdin === "string") {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}
var cachedCodexCommandPrefix = new Map;
async function resolveCodexCommandPrefix(configuredCommand) {
  const override = codexCommandOverrideParts(configuredCommand);
  const cacheKey = override.join("\x00");
  const cached = cachedCodexCommandPrefix.get(cacheKey);
  if (cached)
    return cached;
  const preferred = override.length > 0 ? override : ["bun", "x", "--yes", "@openai/codex"];
  const candidates = [];
  const pushCandidate = (cmd) => {
    if (cmd.length === 0)
      return;
    const key = cmd.join("\x00");
    if (candidates.some((existing) => existing.join("\x00") === key))
      return;
    candidates.push(cmd);
  };
  pushCandidate(preferred);
  const execPath = (process.execPath ?? "").trim();
  if (execPath) {
    const lower = execPath.toLowerCase();
    if (lower.endsWith("bun") || lower.endsWith("bun.exe")) {
      pushCandidate([execPath, "x", "--yes", "@openai/codex"]);
    }
  }
  pushCandidate(["bun", "x", "--yes", "@openai/codex"]);
  pushCandidate(["bunx", "--yes", "@openai/codex"]);
  pushCandidate(["codex"]);
  const cwd = process.cwd();
  const env = process.env;
  const attemptErrors = [];
  for (const candidate of candidates) {
    if (candidate.length === 0)
      continue;
    const rendered = `${candidate.join(" ")} --version`;
    try {
      const probe = await runProcess([...candidate, "--version"], {
        cwd,
        env,
        timeoutMs: 15000
      });
      if (probe.code === 0) {
        cachedCodexCommandPrefix.set(cacheKey, candidate);
        return candidate;
      }
      const detail = (probe.stderr || probe.stdout || "").trim();
      attemptErrors.push(`${rendered} -> exit ${probe.code ?? "unknown"}${detail ? ` (${detail.split(/\r?\n/, 1)[0]})` : ""}`);
    } catch (err) {
      attemptErrors.push(`${rendered} -> ${String(err)}`);
    }
  }
  const details = attemptErrors.length > 0 ? ` Tried: ${attemptErrors.join("; ")}` : "";
  throw new Error("OpenAI Codex CLI is unavailable. Install/use Codex CLI (`bun x --yes @openai/codex` or `codex`) and retry." + details);
}
function normalizeBackend2(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio")
    return "lmstudio";
  if (normalized === "ollama")
    return "ollama";
  if (normalized === "openai" || normalized === "openai_compatible")
    return "openai";
  if (normalized === "openai_codex" || normalized === "codex" || normalized === "codex_cli") {
    return "openai_codex";
  }
  return null;
}
function endpointHost(endpoint) {
  const trimmed = endpoint.trim();
  if (!trimmed)
    return "";
  try {
    return new URL(trimmed).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}
function isOpenAIEndpoint(endpoint) {
  const host = endpointHost(endpoint);
  if (!host)
    return false;
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}
function configuredBackend(endpoint, explicitBackend) {
  const explicit = normalizeBackend2(explicitBackend);
  if (explicit === "openai_codex")
    return explicit;
  if (explicit === "ollama")
    return explicit;
  if (isOpenAIEndpoint(endpoint))
    return "openai";
  if (explicit)
    return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}
function firstNonEmpty2(...values) {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return null;
}
function resolveServiceLlmConfig(opts = {}) {
  const service = opts.service ?? "remotebuddy";
  const config = loadPushPalsConfig();
  const serviceLlmConfig = service === "localbuddy" ? config.localbuddy.llm : service === "workerpals" ? config.workerpals.llm : config.remotebuddy.llm;
  const explicitBackend = normalizeBackend2(firstNonEmpty2(opts.backend, serviceLlmConfig.backend));
  const fallbackEndpoint = explicitBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : explicitBackend === "openai" || explicitBackend === "openai_codex" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
  const endpoint = firstNonEmpty2(opts.endpoint, serviceLlmConfig.endpoint, fallbackEndpoint);
  let backend = configuredBackend(endpoint ?? "", explicitBackend);
  const model = firstNonEmpty2(opts.model, serviceLlmConfig.model, DEFAULT_MODEL) ?? DEFAULT_MODEL;
  const requestedCodexAuthMode = firstNonEmpty2(opts.codexAuthMode, serviceLlmConfig.codexAuthMode, "") ?? "";
  const openAiApiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const apiKey = firstNonEmpty2(opts.apiKey, serviceLlmConfig.apiKey, backend === "lmstudio" ? "lmstudio" : backend === "openai" || backend === "openai_codex" ? openAiApiKey : "") ?? "";
  if (service !== "workerpals" && shouldUseCodexCliFallback(backend, model, apiKey, requestedCodexAuthMode)) {
    backend = "openai_codex";
  }
  const normalizedEndpoint = backend === "ollama" ? normalizeOllamaEndpoint(endpoint ?? DEFAULT_OLLAMA_ENDPOINT) : normalizeLmStudioEndpoint(endpoint ?? (backend === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT));
  const sessionId = firstNonEmpty2(opts.sessionId, serviceLlmConfig.sessionId, config.sessionId, "default") ?? "default";
  return {
    backend,
    endpoint: normalizedEndpoint,
    model,
    apiKey,
    sessionId,
    reasoningEffort: firstNonEmpty2(opts.reasoningEffort, serviceLlmConfig.reasoningEffort, "") ?? "",
    codexAuthMode: requestedCodexAuthMode,
    codexBin: firstNonEmpty2(opts.codexBin, serviceLlmConfig.codexBin, "") ?? "",
    codexTimeoutMs: opts.codexTimeoutMs ?? serviceLlmConfig.codexTimeoutMs,
    lmStudio: opts.lmStudio ?? config.llm.lmstudio
  };
}
function normalizeLmStudioEndpoint(endpoint) {
  const source = (endpoint.trim() || DEFAULT_LMSTUDIO_ENDPOINT).replace(/\/+$/, "");
  if (source.includes("/chat/completions"))
    return source;
  if (source.endsWith("/v1"))
    return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}
function normalizeOllamaEndpoint(endpoint) {
  const source = (endpoint.trim() || DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, "");
  if (source.endsWith("/api/chat"))
    return source;
  return `${source}/api/chat`;
}
function lmStudioHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}
function estimateTokensFromText(text) {
  return Math.ceil(text.length / 3);
}
function truncateKeepingStart(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  if (maxChars <= 12)
    return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 12)}
...[truncated]`;
}
function truncateKeepingEnd(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  if (maxChars <= 12)
    return text.slice(text.length - maxChars);
  return `...[truncated]
${text.slice(text.length - (maxChars - 12))}`;
}
function sumEstimatedTokens(messages) {
  return messages.reduce((acc, msg) => acc + estimateTokensFromText(msg.content), 0);
}
function tokenUsageFromEstimate(messages, responseText) {
  return {
    promptTokens: Math.max(0, sumEstimatedTokens(messages)),
    completionTokens: Math.max(0, estimateTokensFromText(responseText))
  };
}
function normalizeTokenUsage(usage, fallback) {
  if (usage && Number.isFinite(usage.promptTokens) && usage.promptTokens >= 0 && Number.isFinite(usage.completionTokens) && usage.completionTokens >= 0) {
    return {
      promptTokens: Math.round(usage.promptTokens),
      completionTokens: Math.round(usage.completionTokens),
      estimated: false
    };
  }
  return {
    promptTokens: Math.round(fallback.promptTokens),
    completionTokens: Math.round(fallback.completionTokens),
    estimated: true
  };
}
function createHttpUsageReporter(opts) {
  const serverUrl = (opts.serverUrl ?? "").trim().replace(/\/+$/, "");
  if (!serverUrl)
    return null;
  return {
    async reportUsage(event) {
      const headers = { "Content-Type": "application/json" };
      const authToken = (opts.authToken ?? "").trim();
      if (authToken)
        headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch(`${serverUrl}/telemetry/llm-usage`, {
        method: "POST",
        headers,
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`usage telemetry rejected (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
      }
    }
  };
}
function providerlessModelName(raw) {
  const normalized = raw.trim();
  if (!normalized.includes("/"))
    return normalized;
  const [provider, rest] = normalized.split("/", 2);
  if (KNOWN_PROVIDER_PREFIXES.has(provider.trim().toLowerCase())) {
    return (rest ?? "").trim();
  }
  return normalized;
}
function isLikelyCodexModel(raw) {
  const normalized = providerlessModelName(raw).trim().toLowerCase();
  if (!normalized)
    return false;
  return normalized.includes("codex");
}
function shouldUseCodexCliFallback(backend, model, apiKey, configuredAuthMode) {
  if (backend !== "openai")
    return false;
  if (!isLikelyCodexModel(model))
    return false;
  const mode = codexConfiguredAuthMode(configuredAuthMode);
  if (mode === "api_key")
    return false;
  if (mode === "chatgpt")
    return true;
  return !apiKey.trim();
}
function uniqueNonEmptyStrings(values) {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed)
      continue;
    if (seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function normalizeSessionTag(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed)
    return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
}
function stableConversationTag(service, sessionId) {
  const source = firstNonEmpty2(sessionId, "default") ?? "default";
  return `pushpals-${service}-${normalizeSessionTag(source)}`;
}
function pickConfiguredOrAvailableModel(configuredModel, availableModels) {
  const configured = configuredModel.trim();
  if (availableModels.length > 0) {
    if (configured) {
      const configuredLower = configured.toLowerCase();
      const configuredBare = providerlessModelName(configured).toLowerCase();
      const matched = availableModels.find((candidate) => {
        const lower = candidate.toLowerCase();
        return lower === configuredLower || providerlessModelName(candidate).toLowerCase() === configuredBare;
      });
      if (matched)
        return { model: matched, source: "configured" };
      return { model: availableModels[0], source: "available_fallback" };
    }
    return { model: availableModels[0], source: "available_default" };
  }
  if (configured)
    return { model: configured, source: "configured_unverified" };
  return { model: DEFAULT_MODEL, source: "default_local_model" };
}
function chunkByCharBudget(text, charBudget) {
  if (!text)
    return [];
  const safeBudget = Math.max(256, charBudget);
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + safeBudget);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
function serializeMessagesForBatch(messages) {
  return messages.map((message, index) => `[#${index + 1}] role=${message.role}
<<<BEGIN_CONTENT>>>
${message.content}
<<<END_CONTENT>>>`).join(`

====

`);
}
function trimLmStudioMessagesToBudget(system, inputMessages, promptTokenBudget, systemTokenBudget) {
  let trimmed = false;
  let latestUserOverflow = false;
  let remainingPromptTokens = promptTokenBudget;
  let systemContent = system;
  if (estimateTokensFromText(systemContent) > systemTokenBudget) {
    systemContent = truncateKeepingStart(systemContent, systemTokenBudget * 3);
    trimmed = true;
  }
  remainingPromptTokens = Math.max(64, promptTokenBudget - estimateTokensFromText(systemContent));
  const selectedMessages = [];
  const lastUserIndex = (() => {
    for (let i = inputMessages.length - 1;i >= 0; i--) {
      if (inputMessages[i]?.role === "user")
        return i;
    }
    return -1;
  })();
  for (let i = inputMessages.length - 1;i >= 0; i--) {
    const source = inputMessages[i];
    let content = source.content ?? "";
    const estimated = estimateTokensFromText(content);
    if (estimated <= remainingPromptTokens) {
      selectedMessages.push({ role: source.role, content });
      remainingPromptTokens -= estimated;
      continue;
    }
    if (i === lastUserIndex) {
      selectedMessages.push({ role: source.role, content });
      latestUserOverflow = true;
      break;
    }
    const charBudget = Math.max(192, remainingPromptTokens * 3);
    content = truncateKeepingEnd(content, charBudget);
    selectedMessages.push({ role: source.role, content });
    trimmed = true;
    break;
  }
  const messages = [
    { role: "system", content: systemContent },
    ...selectedMessages.reverse()
  ];
  const promptTokensEstimate = sumEstimatedTokens(messages);
  return { messages, promptTokensEstimate, trimmed, latestUserOverflow };
}

class LmStudioClient {
  endpoint;
  apiKey;
  model;
  service;
  sessionTag;
  providerKind;
  providerLabel;
  usageReporter;
  contextWindow;
  minOutputTokens;
  tokenSafetyMargin;
  batchTailMessages;
  batchChunkTokens;
  batchMemoryChars;
  resolvedModel = null;
  resolveModelPromise = null;
  lmStudioSupportsExtendedSessionFields = null;
  lmStudioSupportsResponseFormat = null;
  constructor(opts) {
    this.providerKind = opts?.backend ?? "lmstudio";
    this.providerLabel = this.providerKind === "openai" ? "OpenAI" : "LM Studio";
    const defaultEndpoint = this.providerKind === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
    const rawEndpoint = opts?.endpoint ?? defaultEndpoint;
    this.endpoint = normalizeLmStudioEndpoint(rawEndpoint);
    this.apiKey = opts?.apiKey ?? (this.providerKind === "lmstudio" ? "lmstudio" : "");
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
    const lmStudio = opts?.lmStudio;
    this.contextWindow = Math.max(512, lmStudio?.contextWindow ?? DEFAULT_LMSTUDIO_CONTEXT_WINDOW);
    this.minOutputTokens = Math.max(64, lmStudio?.minOutputTokens ?? DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS);
    this.tokenSafetyMargin = Math.max(16, lmStudio?.tokenSafetyMargin ?? DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN);
    this.batchTailMessages = Math.max(1, lmStudio?.batchTailMessages ?? DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES);
    this.batchChunkTokens = Math.max(0, lmStudio?.batchChunkTokens ?? 0);
    this.batchMemoryChars = Math.max(0, lmStudio?.batchMemoryChars ?? 0);
  }
  async maybeReportUsage(modelId, usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: this.providerKind,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  modelProbeUrls() {
    const trimmed = this.endpoint.replace(/\/+$/, "");
    if (this.providerKind === "openai") {
      if (trimmed.endsWith("/v1/chat/completions")) {
        const root = trimmed.slice(0, -"/v1/chat/completions".length);
        return uniqueNonEmptyStrings([`${root}/v1/models`]);
      }
      if (trimmed.endsWith("/chat/completions")) {
        const root = trimmed.slice(0, -"/chat/completions".length);
        if (root.endsWith("/v1")) {
          return uniqueNonEmptyStrings([`${root}/models`]);
        }
        return uniqueNonEmptyStrings([`${root}/v1/models`]);
      }
      return uniqueNonEmptyStrings([`${trimmed}/v1/models`]);
    }
    if (trimmed.endsWith("/v1/chat/completions")) {
      const root = trimmed.slice(0, -"/v1/chat/completions".length);
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/chat/completions")) {
      const root = trimmed.slice(0, -"/chat/completions".length);
      if (root.endsWith("/v1")) {
        const parent = root.slice(0, -"/v1".length).replace(/\/+$/, "");
        return uniqueNonEmptyStrings([`${root}/models`, `${parent}/models`]);
      }
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/v1")) {
      const parent = trimmed.slice(0, -"/v1".length).replace(/\/+$/, "");
      return uniqueNonEmptyStrings([`${trimmed}/models`, `${parent}/models`]);
    }
    return uniqueNonEmptyStrings([`${trimmed}/v1/models`, `${trimmed}/models`]);
  }
  async discoverAvailableModels() {
    const probes = this.modelProbeUrls();
    const headers = { Accept: "application/json" };
    if (this.apiKey.trim()) {
      headers.Authorization = `Bearer ${this.apiKey.trim()}`;
    }
    let lastDetail = "model-list probe failed";
    for (const url of probes) {
      try {
        const res = await fetch(url, { method: "GET", headers });
        if (!res.ok) {
          const body = await res.text();
          const hint = body.trim().slice(0, 120);
          lastDetail = `${url} -> HTTP ${res.status}${hint ? ` (${hint})` : ""}`;
          continue;
        }
        const payload = await res.json();
        const models = Array.isArray(payload?.data) ? payload.data.map((item) => typeof item?.id === "string" ? item.id.trim() : "").filter((id) => id.length > 0) : [];
        if (models.length > 0) {
          return { models: uniqueNonEmptyStrings(models), detail: `${url} -> ${res.status}` };
        }
        lastDetail = `${url} -> no models in payload`;
      } catch (err) {
        lastDetail = `${url}: ${String(err)}`;
      }
    }
    return { models: [], detail: lastDetail };
  }
  async resolveModelForRequest() {
    if (this.resolvedModel)
      return this.resolvedModel;
    if (this.resolveModelPromise)
      return this.resolveModelPromise;
    this.resolveModelPromise = (async () => {
      const configuredModel = this.model.trim();
      const discovered = await this.discoverAvailableModels();
      const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
      if (selected.source === "available_fallback") {
        console.warn(`[LLM] Configured model "${configuredModel || "(empty)"}" not present in ${this.providerLabel} model list; using discovered fallback "${selected.model}".`);
      } else if (selected.source === "available_default") {
        console.warn(`[LLM] No model configured; using discovered ${this.providerLabel} model "${selected.model}".`);
      } else if (selected.source === "default_local_model") {
        console.warn(`[LLM] No configured/discovered ${this.providerLabel} model available; falling back to default "${DEFAULT_MODEL}".`);
      } else if (selected.source === "configured_unverified") {
        console.warn(`[LLM] Could not verify configured model "${configuredModel}" via model list (${discovered.detail}); continuing with configured model.`);
      }
      console.log(`[LLM] ${this.providerLabel} resolved model "${selected.model}" (${selected.source}).`);
      return selected.model;
    })();
    try {
      this.resolvedModel = await this.resolveModelPromise;
      return this.resolvedModel;
    } finally {
      this.resolveModelPromise = null;
    }
  }
  async preflightConfiguredModel() {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(`${this.providerLabel} model preflight failed for ${this.endpoint}: ${discovered.detail}`);
    }
    const configuredModel = this.model.trim();
    if (!configuredModel)
      return;
    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(`Configured ${this.providerLabel} model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`);
    }
  }
  async runLmStudioCompletion(messages, opts) {
    const model = await this.resolveModelForRequest();
    const coreBody = {
      model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature
    };
    const sessionAwareBodyBases = this.sessionTag ? [
      ...this.lmStudioSupportsExtendedSessionFields !== false ? [
        {
          ...coreBody,
          user: this.sessionTag,
          session_id: this.sessionTag,
          conversation_id: this.sessionTag
        }
      ] : [],
      {
        ...coreBody,
        user: this.sessionTag
      },
      {
        ...coreBody
      }
    ] : [coreBody];
    const bodyVariants = [];
    for (const baseBody of sessionAwareBodyBases) {
      if (!opts.json) {
        bodyVariants.push(baseBody);
        continue;
      }
      if (this.lmStudioSupportsResponseFormat === false) {
        bodyVariants.push(baseBody);
        continue;
      }
      if (opts.jsonSchema) {
        bodyVariants.push({
          ...baseBody,
          response_format: {
            type: "json_schema",
            json_schema: opts.jsonSchema
          }
        });
      } else {
        bodyVariants.push({
          ...baseBody,
          response_format: { type: "json_object" }
        });
      }
      bodyVariants.push({
        ...baseBody,
        response_format: { type: "text" }
      });
    }
    let lastStatus = 0;
    let lastError = "unknown error";
    let loggedSessionFallback = false;
    let loggedResponseFormatFallback = false;
    for (let i = 0;i < bodyVariants.length; i++) {
      const body = bodyVariants[i];
      const headers = {
        ...lmStudioHeaders(this.apiKey)
      };
      if (this.sessionTag) {
        headers["X-PushPals-Session-Id"] = this.sessionTag;
        headers["X-Session-Id"] = this.sessionTag;
        headers["X-Conversation-Id"] = this.sessionTag;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        lastStatus = res.status;
        lastError = await res.text();
        const hasFallback = i < bodyVariants.length - 1;
        if (hasFallback && res.status === 400) {
          const lowered = lastError.toLowerCase();
          const sessionFieldRejected = lowered.includes("session_id") || lowered.includes("conversation_id") || lowered.includes("unknown field") || lowered.includes("unknown property") || lowered.includes("additional properties");
          const responseFormatRejected = lowered.includes("response_format");
          if (sessionFieldRejected && !loggedSessionFallback) {
            this.lmStudioSupportsExtendedSessionFields = false;
            loggedSessionFallback = true;
            console.warn(`[LLM] ${this.providerLabel} rejected session hint fields, retrying compatibility payload (${lastStatus}).`);
          } else if (responseFormatRejected && !loggedResponseFormatFallback) {
            this.lmStudioSupportsResponseFormat = false;
            loggedResponseFormatFallback = true;
            console.warn(`[LLM] ${this.providerLabel} rejected response_format payload, retrying with fallback (${lastStatus}).`);
          }
          continue;
        }
        throw new Error(`${this.providerLabel} API error ${res.status}: ${lastError}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      if ("session_id" in body || "conversation_id" in body) {
        this.lmStudioSupportsExtendedSessionFields = true;
      }
      if ("response_format" in body) {
        this.lmStudioSupportsResponseFormat = true;
      }
      const usage = normalizeTokenUsage(data.usage ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0),
        completionTokens: Number(data.usage.completion_tokens ?? 0)
      } : undefined, tokenUsageFromEstimate(messages, text));
      await this.maybeReportUsage(model, usage);
      return {
        text,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens
        }
      };
    }
    throw new Error(`${this.providerLabel} API error ${lastStatus}: ${lastError}`);
  }
  async packContextInBatches(fullMessages, promptTokenBudget) {
    const tailCount = this.batchTailMessages;
    const tailMessages = fullMessages.slice(-tailCount);
    const reservedTailTokens = sumEstimatedTokens(tailMessages) + 220;
    const adaptiveMemoryTokenBudget = Math.max(256, Math.min(Math.floor(promptTokenBudget * 0.6), promptTokenBudget - reservedTailTokens));
    const chunkTokenBudget = this.batchChunkTokens > 0 ? this.batchChunkTokens : Math.max(256, Math.floor(promptTokenBudget * 0.55));
    const chunkCharBudget = chunkTokenBudget * 3;
    const memoryCharBudget = this.batchMemoryChars > 0 ? this.batchMemoryChars : Math.max(900, adaptiveMemoryTokenBudget * 3);
    const packMaxTokens = Math.max(128, Math.min(1024, Math.floor(this.contextWindow * 0.25)));
    const serialized = serializeMessagesForBatch(fullMessages);
    const chunks = chunkByCharBudget(serialized, chunkCharBudget);
    if (chunks.length <= 1) {
      return { messages: fullMessages, chunkCount: chunks.length };
    }
    let memory = "";
    for (let i = 0;i < chunks.length; i++) {
      const chunk = chunks[i];
      const packPrompt = loadPromptTemplate("remotebuddy/context_packer_user_prompt.md", {
        batch_index: String(i + 1),
        batch_count: String(chunks.length),
        batch_chunk: chunk,
        current_memory: memory || "(empty)",
        memory_char_budget: String(memoryCharBudget)
      });
      const packed = await this.runLmStudioCompletion([
        {
          role: "system",
          content: CONTEXT_PACKER_SYSTEM_PROMPT
        },
        { role: "user", content: packPrompt }
      ], { json: false, maxTokens: packMaxTokens, temperature: 0 });
      memory = packed.text.trim() || memory;
    }
    const packedMessages = [
      {
        role: "system",
        content: CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT
      },
      {
        role: "system",
        content: `PACKED_CONTEXT
${memory}`
      },
      ...tailMessages
    ];
    return { messages: packedMessages, chunkCount: chunks.length };
  }
  async generate(input) {
    const contextWindow = this.contextWindow;
    const minOutputTokens = this.minOutputTokens;
    const desiredMaxTokens = input.maxTokens ?? 2048;
    const clampedMinOutput = Math.max(64, Math.min(minOutputTokens, Math.floor(contextWindow / 2)));
    const promptTokenBudget = Math.max(384, contextWindow - clampedMinOutput - this.tokenSafetyMargin);
    const systemTokenBudget = Math.max(128, Math.min(Math.floor(promptTokenBudget * 0.45), promptTokenBudget - 128));
    const fullMessages = [
      { role: "system", content: input.system },
      ...input.messages.map((message) => ({ role: message.role, content: message.content ?? "" }))
    ];
    let messages = fullMessages;
    let promptTokensEstimate = sumEstimatedTokens(messages);
    let trimmed = false;
    let packedChunkCount = 0;
    let latestUserOverflow = false;
    if (promptTokensEstimate > promptTokenBudget) {
      try {
        const packed = await this.packContextInBatches(fullMessages, promptTokenBudget);
        messages = packed.messages;
        packedChunkCount = packed.chunkCount;
        promptTokensEstimate = sumEstimatedTokens(messages);
        if (promptTokensEstimate > promptTokenBudget && messages.length > 0) {
          const packedSystem = messages[0]?.content ?? "";
          const packedInput = messages.slice(1).map((message) => ({
            role: message.role,
            content: message.content
          }));
          const packedTrimmed = trimLmStudioMessagesToBudget(packedSystem, packedInput, promptTokenBudget, systemTokenBudget);
          messages = packedTrimmed.messages;
          promptTokensEstimate = packedTrimmed.promptTokensEstimate;
          trimmed = trimmed || packedTrimmed.trimmed;
          latestUserOverflow = latestUserOverflow || packedTrimmed.latestUserOverflow;
        }
      } catch (err) {
        throw new Error(`${this.providerLabel} batch context packing failed: ${String(err)}`);
      }
    }
    if (latestUserOverflow) {
      throw new Error(`Latest user request exceeds ${this.providerLabel} context window and cannot be safely truncated. Increase model context window or split the request into smaller messages.`);
    }
    const safeMaxTokens = Math.max(64, Math.min(desiredMaxTokens, contextWindow - promptTokensEstimate - this.tokenSafetyMargin));
    if (packedChunkCount > 1) {
      console.warn(`[LLM] Packed oversized prompt context across ${packedChunkCount} batches (window ~${contextWindow}, est prompt ${promptTokensEstimate}).`);
    } else if (trimmed) {
      console.warn(`[LLM] Trimmed ${this.providerLabel} prompt context to fit window (~${contextWindow} tokens, est prompt ${promptTokensEstimate}).`);
    }
    return this.runLmStudioCompletion(messages, {
      json: input.json,
      jsonSchema: input.jsonSchema,
      maxTokens: safeMaxTokens,
      temperature: input.temperature ?? 0.3
    });
  }
}
function renderCodexPrompt(input) {
  const jsonRequirements = input.json ? loadPromptTemplate("remotebuddy/codex_adapter_json_requirements.md").trim() : "";
  const jsonSchemaBlock = input.jsonSchema ? `${loadPromptTemplate("remotebuddy/codex_adapter_json_schema_intro.md").trim()}
${JSON.stringify(input.jsonSchema, null, 2)}` : "";
  const maxTokensLine = typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? loadPromptTemplate("remotebuddy/codex_adapter_max_tokens_line.md", {
    max_tokens: String(Math.max(64, Math.floor(input.maxTokens)))
  }).trim() : "";
  const conversationTranscript = input.messages.map((message) => `[${message.role}]
${message.content ?? ""}
`).join(`
`);
  return loadPromptTemplate("remotebuddy/codex_adapter_prompt_template.md", {
    json_requirements: jsonRequirements,
    json_schema_block: jsonSchemaBlock,
    max_tokens_line: maxTokensLine,
    system_instruction: input.system,
    conversation_transcript: conversationTranscript
  });
}

class OpenAiCodexCliClient {
  model;
  apiKey;
  endpoint;
  codexAuthMode;
  codexBin;
  codexTimeoutMs;
  service;
  sessionTag;
  reasoningEffort;
  usageReporter;
  constructor(opts) {
    this.model = normalizeCodexModel(opts?.model ?? DEFAULT_CODEX_MODEL);
    this.apiKey = (opts?.apiKey ?? "").trim();
    this.endpoint = normalizeOpenAiBaseFromEndpoint(opts?.endpoint ?? DEFAULT_OPENAI_ENDPOINT);
    this.codexAuthMode = (opts?.codexAuthMode ?? "").trim();
    this.codexBin = (opts?.codexBin ?? "").trim();
    this.codexTimeoutMs = opts?.codexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.reasoningEffort = (opts?.reasoningEffort ?? "").trim();
    this.usageReporter = opts?.usageReporter ?? null;
  }
  async maybeReportUsage(usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "openai_codex",
        modelId: this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  effectiveAuthMode() {
    const configured = codexConfiguredAuthMode(this.codexAuthMode);
    if (configured !== "auto")
      return configured;
    const envKey = (process.env.OPENAI_API_KEY ?? "").trim();
    return this.apiKey || envKey ? "api_key" : "chatgpt";
  }
  async ensureChatGptLoginReady(commandPrefix, env) {
    const status = await runProcess([...commandPrefix, "login", "status"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 25000
    });
    if (status.code === 0)
      return;
    const detail = (status.stderr || status.stdout || "").trim();
    throw new Error(`Codex CLI is not logged in for ChatGPT auth mode. Run \`bunx --yes @openai/codex login\` (or \`codex login\`) and retry.${detail ? ` Details: ${detail}` : ""}`);
  }
  async preflight() {
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env = { ...process.env };
    env.PYTHONIOENCODING = "utf-8";
    const authMode = this.effectiveAuthMode();
    if (authMode === "chatgpt") {
      delete env.OPENAI_API_KEY;
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_BASE;
      await this.ensureChatGptLoginReady(commandPrefix, env);
      return;
    }
    const finalApiKey = this.apiKey || (process.env.OPENAI_API_KEY ?? "").trim();
    if (!finalApiKey) {
      throw new Error("openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.");
    }
  }
  async runCodexExec(prompt) {
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env = { ...process.env };
    env.PYTHONIOENCODING = "utf-8";
    env.PUSHPALS_LLM_SERVICE = this.service;
    env.PUSHPALS_LLM_SESSION_TAG = this.sessionTag;
    const authMode = this.effectiveAuthMode();
    if (authMode === "chatgpt") {
      delete env.OPENAI_API_KEY;
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_BASE;
      await this.ensureChatGptLoginReady(commandPrefix, env);
    } else {
      const finalApiKey = this.apiKey || (process.env.OPENAI_API_KEY ?? "").trim();
      if (!finalApiKey) {
        throw new Error("openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.");
      }
      env.OPENAI_API_KEY = finalApiKey;
      const baseOverride = codexBaseUrlOverride();
      const baseUrl = baseOverride || this.endpoint;
      if (baseUrl) {
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_API_BASE = baseUrl;
      } else {
        delete env.OPENAI_BASE_URL;
        delete env.OPENAI_API_BASE;
      }
    }
    const tmp = mkdtempSync(join3(tmpdir(), "pushpals-codex-"));
    const lastMessagePath = join3(tmp, "codex-last-message.txt");
    try {
      const command = [
        ...commandPrefix,
        "-c",
        `model_reasoning_effort="${codexReasoningEffort(this.reasoningEffort, this.model)}"`,
        "-a",
        "never",
        "-s",
        "read-only",
        "exec",
        "--color",
        "never",
        "--output-last-message",
        lastMessagePath
      ];
      if (this.model) {
        command.push("-m", this.model);
      }
      command.push("-");
      const result = await runProcess(command, {
        cwd: process.cwd(),
        env,
        stdin: prompt,
        timeoutMs: codexTimeoutMs(this.codexTimeoutMs)
      });
      if (result.timedOut) {
        throw new Error(`Codex CLI request timed out after ${codexTimeoutMs(this.codexTimeoutMs)}ms.`);
      }
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      const lastMessage = existsSync3(lastMessagePath) ? readFileSync4(lastMessagePath, "utf8").trim() : "";
      if (result.code !== 0) {
        const detail = stderr || stdout || "codex exec exited with non-zero status";
        throw new Error(`Codex CLI request failed (exit ${result.code ?? "unknown"}): ${detail}`);
      }
      const text = lastMessage || stdout;
      if (!text) {
        throw new Error("Codex CLI completed without producing a response.");
      }
      return { text, stderr };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  async generate(input) {
    const prompt = renderCodexPrompt(input);
    const result = await this.runCodexExec(prompt);
    if (result.stderr) {
      const firstLine = result.stderr.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (firstLine) {
        console.warn(`[LLM] Codex CLI stderr (${this.service}): ${firstLine.trim()}`);
      }
    }
    const usage = normalizeTokenUsage(undefined, {
      promptTokens: estimateTokensFromText(prompt),
      completionTokens: estimateTokensFromText(result.text)
    });
    await this.maybeReportUsage(usage);
    return {
      text: result.text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      }
    };
  }
}

class OllamaClient {
  endpoint;
  model;
  service;
  sessionTag;
  usageReporter;
  constructor(opts) {
    const rawEndpoint = opts?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.endpoint = normalizeOllamaEndpoint(rawEndpoint);
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
  }
  async maybeReportUsage(usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "ollama",
        modelId: this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  async discoverAvailableModels() {
    const base = this.endpoint.replace(/\/api\/chat$/, "");
    const probes = uniqueNonEmptyStrings([`${base}/api/tags`, this.endpoint]);
    let lastDetail = "model-list probe failed";
    for (const url of probes) {
      try {
        const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
        if (!res.ok) {
          const body = await res.text();
          const hint = body.trim().slice(0, 120);
          lastDetail = `${url} -> HTTP ${res.status}${hint ? ` (${hint})` : ""}`;
          continue;
        }
        const payload = await res.json();
        const models = Array.isArray(payload.models) ? payload.models.map((item) => typeof item?.name === "string" ? item.name.trim() : "").filter((name) => name.length > 0) : [];
        if (models.length > 0) {
          return { models: uniqueNonEmptyStrings(models), detail: `${url} -> ${res.status}` };
        }
        lastDetail = `${url} -> no models in payload`;
      } catch (err) {
        lastDetail = `${url}: ${String(err)}`;
      }
    }
    return { models: [], detail: lastDetail };
  }
  async preflightConfiguredModel() {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(`Ollama model preflight failed for ${this.endpoint}: ${discovered.detail}`);
    }
    const configuredModel = this.model.trim();
    if (!configuredModel)
      return;
    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(`Configured Ollama model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`);
    }
  }
  async generate(input) {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content }))
      ],
      stream: false,
      options: {
        temperature: input.temperature ?? 0.3
      }
    };
    if (typeof input.maxTokens === "number") {
      body.options.num_predict = input.maxTokens;
    }
    if (input.json) {
      body.format = "json";
    }
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${err}`);
    }
    const data = await res.json();
    const text = data.message?.content ?? "";
    const usage = normalizeTokenUsage(undefined, tokenUsageFromEstimate(body.messages, text));
    await this.maybeReportUsage(usage);
    return {
      text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      }
    };
  }
}
function createLLMClient(opts = {}) {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";
  const usageReporter = opts.usageReporter ?? createHttpUsageReporter(opts);
  if (resolved.backend === "openai_codex") {
    console.log(`[LLM] Using OpenAI Codex CLI backend (model: ${resolved.model}, auth_mode: ${codexConfiguredAuthMode(resolved.codexAuthMode)}).`);
    return new OpenAiCodexCliClient({
      model: resolved.model,
      apiKey: resolved.apiKey,
      endpoint: resolved.endpoint,
      codexAuthMode: resolved.codexAuthMode,
      codexBin: resolved.codexBin,
      codexTimeoutMs: resolved.codexTimeoutMs,
      reasoningEffort: resolved.reasoningEffort,
      service,
      sessionId: resolved.sessionId,
      usageReporter
    });
  }
  if (resolved.backend === "ollama") {
    console.log(`[LLM] Using Ollama backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
    return new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
      service,
      sessionId: resolved.sessionId,
      usageReporter
    });
  }
  if (resolved.backend === "openai") {
    console.log(`[LLM] Using OpenAI backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
    return new LmStudioClient({
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      model: resolved.model,
      backend: "openai",
      service,
      sessionId: resolved.sessionId,
      lmStudio: resolved.lmStudio,
      usageReporter
    });
  }
  console.log(`[LLM] Using LM Studio backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
  return new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    backend: "lmstudio",
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
    usageReporter
  });
}

// apps/remotebuddy/src/path_targeting.ts
var MAX_TARGET_PATH_HINTS = 8;
function collapseGlobToPathHint(value) {
  let normalized = value.trim().replace(/\\/g, "/");
  const wildcardIndex = normalized.search(/[*?\[]/);
  if (wildcardIndex >= 0) {
    normalized = normalized.slice(0, wildcardIndex);
  }
  return normalized.replace(/\/+$/, "");
}
function normalizeRepoPathHint(value) {
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
  return path;
}
function extractExplicitTargetPath(text) {
  const stopWords = new Set(["a", "an", "the", "it", "this", "that", "there", "here", "file"]);
  const patterns = [
    /file\s+(?:called|named)\s+["'`]?([^"'`\s]+)["'`]?/i,
    /create\s+(?:a\s+)?file\s+["'`]?([^"'`\s]+)["'`]?/i,
    /write\s+(?:to|into)\s+["'`]?([^"'`\s]+)["'`]?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match)
      continue;
    const value = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!value)
      continue;
    if (!/^[A-Za-z0-9._/\-\\]+$/.test(value))
      continue;
    if (stopWords.has(value.toLowerCase()))
      continue;
    const normalized = normalizeRepoPathHint(value);
    if (normalized)
      return normalized;
  }
  return null;
}
function extractQuotedPathHints(text) {
  const out = [];
  for (const match of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
    const candidate = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!candidate || candidate.length > 220)
      continue;
    if (candidate.includes("://"))
      continue;
    if (!(candidate.includes("/") || candidate.includes("\\") || candidate.includes(".")))
      continue;
    out.push(candidate);
    if (out.length >= MAX_TARGET_PATH_HINTS)
      break;
  }
  return out;
}
function extractTokenPathHints(text) {
  const out = [];
  const tokenRegex = /\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g;
  for (const match of text.matchAll(tokenRegex)) {
    const candidate = (match[1] ?? "").trim().replace(/[.,!?;:]+$/, "");
    if (!candidate)
      continue;
    if (candidate.includes("://"))
      continue;
    out.push(candidate);
    if (out.length >= MAX_TARGET_PATH_HINTS)
      break;
  }
  return out;
}
function normalizePathHints(values) {
  const out = [];
  const seen = new Set;
  for (const raw of values) {
    const collapsed = collapseGlobToPathHint(String(raw ?? ""));
    const value = normalizeRepoPathHint(collapsed);
    if (!value)
      continue;
    if (value === ".")
      return ["."];
    const key = value.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_TARGET_PATH_HINTS)
      break;
  }
  return out;
}
function plannerTargetPaths(plan, prompt) {
  const explicit = extractExplicitTargetPath(prompt);
  const promptPathHints = normalizePathHints([
    ...explicit ? [explicit] : [],
    ...extractTokenPathHints(prompt),
    ...extractQuotedPathHints(prompt)
  ]);
  if (promptPathHints.length > 0)
    return promptPathHints;
  const plannerHints = normalizePathHints([
    ...plan.scope.write_globs ?? [],
    ...plan.discovery?.likely_dirs ?? []
  ]);
  return plannerHints.length > 0 ? plannerHints : ["."];
}

// apps/remotebuddy/src/brain.ts
var MAX_ASSISTANT_CHARS = 4000;
var MAX_WORKER_INSTRUCTION_CHARS = 12000;
var MAX_SCOPE_GLOBS = 24;
var MAX_DISCOVERY_ITEMS = 24;
var MAX_ACCEPTANCE_CRITERIA = 16;
var MAX_VALIDATION_STEPS = 16;
var BASE_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/remotebuddy_system_prompt.md", {
  repo_root: process.cwd(),
  platform: process.platform
});
var POST_SYSTEM_PROMPT = loadPromptTemplate("shared/post_system_prompt.md");
var PLANNER_POST_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/planner_post_system_prompt.md").trim();
var PLANNER_REPAIR_SUFFIX_PROMPT = loadPromptTemplate("remotebuddy/planner_repair_suffix_prompt.md").trim();
var SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

${POST_SYSTEM_PROMPT}

${PLANNER_POST_SYSTEM_PROMPT}`.trim();
var REPAIR_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

${PLANNER_REPAIR_SUFFIX_PROMPT}`.trim();
var REMOTEBUDDY_PLANNER_JSON_SCHEMA = {
  name: "remotebuddy_planner",
  strict: false,
  schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["chat", "status", "code_change", "analysis", "other"]
      },
      requires_worker: { type: "boolean" },
      job_kind: {
        type: "string",
        enum: ["task.execute", "none"]
      },
      lane: {
        type: "string",
        enum: ["deterministic", "worker"]
      },
      scope: {
        type: "object",
        properties: {
          read_anywhere: { type: "boolean" },
          write_allowed: { type: "boolean" },
          write_globs: { type: "array", items: { type: "string" } },
          forbidden_globs: { type: "array", items: { type: "string" } },
          max_files_to_edit: { type: "number" }
        },
        required: ["read_anywhere", "write_allowed"],
        additionalProperties: false
      },
      discovery: {
        type: "object",
        properties: {
          ripgrep_queries: { type: "array", items: { type: "string" } },
          likely_dirs: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } }
        },
        required: ["ripgrep_queries"],
        additionalProperties: false
      },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" }
      },
      validation_steps: {
        type: "array",
        items: { type: "string" }
      },
      risk_level: {
        type: "string",
        enum: ["low", "medium", "high"]
      },
      assistant_message: { type: "string" },
      worker_instruction: { type: "string" },
      user_message: { type: "string" }
    },
    required: [
      "intent",
      "requires_worker",
      "job_kind",
      "lane",
      "scope",
      "acceptance_criteria",
      "validation_steps",
      "risk_level",
      "assistant_message",
      "worker_instruction",
      "user_message"
    ],
    additionalProperties: false
  }
};
function parseStructuredJson(text) {
  const trimmed = text.trim();
  if (!trimmed)
    throw new Error("empty model response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {}
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const snippet = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(snippet);
      } catch {}
    }
    throw new Error("response did not contain parseable JSON");
  }
}
function normalizeJsonLikeText(input) {
  return input.replace(/\uFEFF/g, "").replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, "$1");
}
function parseStructuredJsonWithLocalRepair(text) {
  const repaired = normalizeJsonLikeText(text);
  return parseStructuredJson(repaired);
}
function asIntent(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "chat" || text === "status" || text === "code_change" || text === "analysis") {
    return text;
  }
  return "other";
}
function asRisk(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "low" || text === "high")
    return text;
  return "medium";
}
function asLane(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "deterministic" ? "deterministic" : "worker";
}
function dedupeStrings(values, limit) {
  if (!Array.isArray(values))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of values) {
    if (typeof raw !== "string")
      continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit)
      break;
  }
  return out;
}
function dedupeRepoPathHints(values, limit) {
  if (!Array.isArray(values))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of values) {
    if (typeof raw !== "string")
      continue;
    const normalized = normalizeRepoPathHint(raw);
    if (!normalized)
      continue;
    const key = normalized.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit)
      break;
  }
  return out;
}
function hasActionableWorkerVerbs(text) {
  return /\b(apply|append|add|edit|update|modify|change|replace|write|create|remove|run|verify|check|ensure)\b/i.test(text);
}
function looksContradictoryWorkerInstruction(text) {
  const normalized = text.toLowerCase();
  return normalized.includes("no worker instruction needed") || normalized.includes("no additional instruction needed") || normalized.includes("purely documentation update") || normalized.includes("already updated") || normalized.includes("nothing to do");
}
function sanitizePlannerOutput(raw, userText) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("planner output is not an object");
  }
  const record = raw;
  let intent = asIntent(record.intent);
  let requiresWorker = Boolean(record.requires_worker);
  if (!requiresWorker && (intent === "other" || intent === "analysis") && looksCodeChangeRequest(userText)) {
    console.warn(`[Brain] sanitize: upgraded intent "${intent}" \u2192 "code_change" (requires_worker=true) based on prompt heuristic`);
    intent = "code_change";
    requiresWorker = true;
  }
  const lane = asLane(record.lane);
  const riskLevel = asRisk(record.risk_level);
  const scopeRecord = record.scope && typeof record.scope === "object" && !Array.isArray(record.scope) ? record.scope : {};
  const readAnywhere = typeof scopeRecord.read_anywhere === "boolean" ? scopeRecord.read_anywhere : true;
  const writeAllowedRaw = typeof scopeRecord.write_allowed === "boolean" ? scopeRecord.write_allowed : true;
  const writeGlobs = dedupeRepoPathHints(scopeRecord.write_globs, MAX_SCOPE_GLOBS);
  const forbiddenGlobs = dedupeRepoPathHints(scopeRecord.forbidden_globs, MAX_SCOPE_GLOBS);
  const maxFilesRaw = Number(scopeRecord.max_files_to_edit);
  const maxFilesToEdit = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.floor(maxFilesRaw) : undefined;
  const discoveryRecord = record.discovery && typeof record.discovery === "object" && !Array.isArray(record.discovery) ? record.discovery : null;
  const ripgrepQueries = dedupeStrings(discoveryRecord?.ripgrep_queries, MAX_DISCOVERY_ITEMS);
  const likelyDirs = dedupeRepoPathHints(discoveryRecord?.likely_dirs, MAX_DISCOVERY_ITEMS);
  const keywords = dedupeStrings(discoveryRecord?.keywords, MAX_DISCOVERY_ITEMS);
  const acceptanceCriteria = dedupeStrings(record.acceptance_criteria, MAX_ACCEPTANCE_CRITERIA);
  const validationSteps = dedupeStrings(record.validation_steps, MAX_VALIDATION_STEPS);
  const fallbackWorkerInstruction = userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const assistantMessageRaw = String(record.assistant_message ?? "").trim();
  const workerInstructionRaw = String(record.worker_instruction ?? "").trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const userMessage = String(record.user_message ?? userText).trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS);
  const assistantMessage = (assistantMessageRaw || userMessage || workerInstructionRaw || fallbackWorkerInstruction || "Understood. I will proceed with this request.").slice(0, MAX_ASSISTANT_CHARS);
  const requires_worker = requiresWorker;
  const workerInstruction = requires_worker && workerInstructionRaw && (!hasActionableWorkerVerbs(workerInstructionRaw) || looksContradictoryWorkerInstruction(workerInstructionRaw)) ? "" : workerInstructionRaw;
  const writeAllowed = requires_worker && intent === "code_change" ? true : writeAllowedRaw;
  const job_kind = requires_worker ? "task.execute" : "none";
  return {
    intent,
    requires_worker,
    job_kind,
    lane: requires_worker ? lane : "deterministic",
    scope: {
      read_anywhere: readAnywhere,
      write_allowed: writeAllowed,
      ...writeGlobs.length > 0 ? { write_globs: writeGlobs } : {},
      ...forbiddenGlobs.length > 0 ? { forbidden_globs: forbiddenGlobs } : {},
      ...maxFilesToEdit ? { max_files_to_edit: maxFilesToEdit } : {}
    },
    ...ripgrepQueries.length > 0 || likelyDirs.length > 0 || keywords.length > 0 ? {
      discovery: {
        ripgrep_queries: ripgrepQueries,
        ...likelyDirs.length > 0 ? { likely_dirs: likelyDirs } : {},
        ...keywords.length > 0 ? { keywords } : {}
      }
    } : {},
    acceptance_criteria: acceptanceCriteria,
    validation_steps: validationSteps,
    risk_level: riskLevel,
    assistant_message: assistantMessage,
    worker_instruction: workerInstruction || fallbackWorkerInstruction,
    user_message: userMessage || userText
  };
}
function looksCodeChangeRequest(userText) {
  const lower = userText.toLowerCase();
  return /\b(add|append|implement|build|integrate|generate|setup|configure|improve|optimize|edit|update|modify|change|write|create|delete|remove|rename|refactor|fix|patch|test|run|apply|migrate|wire|hook|connect)\b/.test(lower) || /\b(file|path|prompt|readme|config|test|tests|spec|coverage|feature|function|class|module|component|ts|js|py|md|toml|json|yaml|yml)\b/.test(lower);
}
function extractPromptPathHints(userText) {
  const out = [];
  const seen = new Set;
  const add = (value) => {
    const normalized = normalizeRepoPathHint(value);
    if (!normalized)
      return;
    const key = normalized.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    out.push(normalized);
  };
  for (const match of userText.matchAll(/\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g)) {
    add(match[1]);
    if (out.length >= MAX_SCOPE_GLOBS)
      break;
  }
  if (out.length < MAX_SCOPE_GLOBS) {
    for (const match of userText.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
      const candidate = String(match[1] ?? "").trim();
      if (!(candidate.includes("/") || candidate.includes("\\") || candidate.includes("."))) {
        continue;
      }
      add(candidate);
      if (out.length >= MAX_SCOPE_GLOBS)
        break;
    }
  }
  return out;
}
function fallbackPlannerOutput(userText) {
  const requiresWorker = looksCodeChangeRequest(userText);
  const targetPaths = extractPromptPathHints(userText).filter((entry) => entry !== ".");
  const likelyDirs = dedupeRepoPathHints(targetPaths.map((entry) => {
    const idx = entry.lastIndexOf("/");
    return idx > 0 ? entry.slice(0, idx) : ".";
  }).filter(Boolean), MAX_DISCOVERY_ITEMS);
  const validation = targetPaths.length ? [`git diff -- ${targetPaths.slice(0, 4).join(" ")}`, "git status --porcelain"] : ["git status --porcelain"];
  return {
    intent: requiresWorker ? "code_change" : "chat",
    requires_worker: requiresWorker,
    job_kind: requiresWorker ? "task.execute" : "none",
    lane: requiresWorker ? "worker" : "deterministic",
    scope: {
      read_anywhere: true,
      write_allowed: requiresWorker,
      ...targetPaths.length > 0 ? { write_globs: targetPaths } : {},
      ...targetPaths.length > 0 ? { max_files_to_edit: targetPaths.length } : {}
    },
    ...requiresWorker ? {
      discovery: {
        ripgrep_queries: targetPaths.length > 0 ? [...targetPaths] : ["README.md"],
        ...likelyDirs.length > 0 ? { likely_dirs: likelyDirs } : {}
      }
    } : {},
    acceptance_criteria: [
      "Apply the requested update(s) exactly and keep unrelated content unchanged."
    ],
    validation_steps: validation,
    risk_level: targetPaths.length <= 2 ? "low" : "medium",
    assistant_message: "Planner JSON was invalid; proceeding with a safe fallback execution plan derived from your request.",
    worker_instruction: userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS),
    user_message: userText.trim().slice(0, MAX_WORKER_INSTRUCTION_CHARS)
  };
}
function applyOverrides(plan, overrides) {
  if (!overrides)
    return plan;
  const forceWorker = overrides.forceWorker === true;
  const forceLane = overrides.forceLane === "deterministic" || overrides.forceLane === "worker" ? overrides.forceLane : null;
  if (forceWorker) {
    const lane = forceLane ?? plan.lane ?? "worker";
    return {
      ...plan,
      requires_worker: true,
      job_kind: "task.execute",
      lane
    };
  }
  if (forceLane) {
    if (plan.requires_worker) {
      return { ...plan, lane: forceLane };
    }
    return { ...plan, lane: "deterministic" };
  }
  return plan;
}

class AgentBrain {
  llm;
  constructor(llm) {
    this.llm = llm;
  }
  buildMessages(userText, context) {
    const messages = [];
    if (Array.isArray(context) && context.length > 0) {
      messages.push({
        role: "user",
        content: `Recent session context:
${context.join(`
`)}

---

New user request:
${userText}`
      });
    } else {
      messages.push({ role: "user", content: userText });
    }
    return messages;
  }
  async generatePlanRaw(system, messages, maxTokens = 900) {
    const result = await this.llm.generate({
      system,
      messages,
      json: true,
      jsonSchema: REMOTEBUDDY_PLANNER_JSON_SCHEMA,
      maxTokens,
      temperature: 0
    });
    if (result.usage) {
      console.log(`[Brain] Tokens: ${result.usage.promptTokens} in, ${result.usage.completionTokens} out`);
    }
    return result.text;
  }
  async think(userText, context, overrides) {
    const messages = this.buildMessages(userText, context);
    const primaryRaw = await this.generatePlanRaw(SYSTEM_PROMPT, messages);
    try {
      const parsed = parseStructuredJson(primaryRaw);
      const plan = sanitizePlannerOutput(parsed, userText);
      return applyOverrides(plan, overrides);
    } catch (primaryErr) {
      try {
        const repairedParsed = parseStructuredJsonWithLocalRepair(primaryRaw);
        console.warn(`[Brain] Primary planner JSON was invalid; local deterministic repair succeeded (${String(primaryErr)}).`);
        const plan = sanitizePlannerOutput(repairedParsed, userText);
        return applyOverrides(plan, overrides);
      } catch (localRepairErr) {
        console.warn(`[Brain] Primary planner JSON was invalid; local repair failed, sending to LLM strict repair (${String(localRepairErr)}).`);
      }
      console.warn(`[Brain] Invalid planner JSON; attempting strict repair via LLM (${String(primaryErr)}).`);
      const repairMessages = [
        {
          role: "user",
          content: loadPromptTemplate("remotebuddy/planner_repair_user_prompt.md", {
            user_text: userText,
            primary_raw: primaryRaw
          })
        }
      ];
      try {
        const repairedRaw = await this.generatePlanRaw(REPAIR_SYSTEM_PROMPT, repairMessages, 1800);
        const repairedParsed = parseStructuredJson(repairedRaw);
        const plan = sanitizePlannerOutput(repairedParsed, userText);
        return applyOverrides(plan, overrides);
      } catch (repairErr) {
        console.warn(`[Brain] Planner repair failed; using deterministic fallback plan (${String(repairErr)}).`);
        return applyOverrides(fallbackPlannerOutput(userText), overrides);
      }
    }
  }
}

// apps/remotebuddy/src/idempotency.ts
import { Database } from "bun:sqlite";
var MAX_HANDLED_IDS = 5000;

class IdempotencyStore {
  db;
  constructor(dbPath = "remotebuddy-state.db") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_cursors (
        sessionId  TEXT PRIMARY KEY,
        cursor     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS handled_messages (
        sessionId  TEXT NOT NULL,
        eventId    TEXT NOT NULL,
        handledAt  TEXT NOT NULL,
        PRIMARY KEY (sessionId, eventId)
      );

      CREATE INDEX IF NOT EXISTS idx_handled_session
        ON handled_messages(sessionId, handledAt);
    `);
  }
  getLastCursor(sessionId) {
    const row = this.db.prepare("SELECT cursor FROM session_cursors WHERE sessionId = ?").get(sessionId);
    return row?.cursor ?? 0;
  }
  updateCursor(sessionId, cursor) {
    this.db.prepare(`INSERT INTO session_cursors (sessionId, cursor) VALUES (?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET cursor = MAX(excluded.cursor, session_cursors.cursor)`).run(sessionId, cursor);
  }
  hasHandled(sessionId, eventId) {
    const row = this.db.prepare("SELECT 1 FROM handled_messages WHERE sessionId = ? AND eventId = ?").get(sessionId, eventId);
    return !!row;
  }
  markHandled(sessionId, eventId) {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO handled_messages (sessionId, eventId, handledAt) VALUES (?, ?, ?)").run(sessionId, eventId, now);
    this._prune(sessionId);
  }
  _prune(sessionId) {
    this.db.prepare(`DELETE FROM handled_messages
         WHERE rowid IN (
           SELECT rowid FROM handled_messages
           WHERE sessionId = ?
           ORDER BY handledAt ASC
           LIMIT MAX(0, (SELECT COUNT(*) FROM handled_messages WHERE sessionId = ?) - ?)
         )`).run(sessionId, sessionId, MAX_HANDLED_IDS);
  }
  close() {
    this.db.close();
  }
}

// apps/remotebuddy/src/memory.ts
function createSessionMemoryBackend(enabled, backendFactories) {
  if (!enabled)
    return new NoopSessionMemory;
  const usable = [];
  for (const factory of backendFactories) {
    try {
      const backend = factory();
      if (backend)
        usable.push(backend);
    } catch (err) {
      console.warn("[RemoteBuddy] Memory backend factory failed:", err);
    }
  }
  if (usable.length === 0)
    return new NoopSessionMemory;
  if (usable.length === 1)
    return usable[0];
  return new CompositeSessionMemory(usable);
}
function clampPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.max(min, Math.min(max, parsed));
}
function normalizeLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function mergeMemoryLines(lines, limits) {
  const maxItems = clampPositiveInt(limits.maxItems, 8, 1, 128);
  const maxChars = clampPositiveInt(limits.maxChars, 2400, 120, 64000);
  const out = [];
  const seen = new Set;
  let usedChars = 0;
  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (!line || seen.has(line))
      continue;
    const separatorCost = out.length > 0 ? 1 : 0;
    if (out.length > 0 && usedChars + separatorCost + line.length > maxChars)
      break;
    if (out.length === 0 && line.length > maxChars) {
      out.push(`${line.slice(0, Math.max(0, maxChars - 14))} ...[truncated]`);
      return out;
    }
    out.push(line);
    seen.add(line);
    usedChars += separatorCost + line.length;
    if (out.length >= maxItems)
      break;
  }
  return out;
}

class NoopSessionMemory {
  remember(_input, _options = {}) {}
  recallForPlanning(_options) {
    return [];
  }
  purgeExpired(_retentionDays, _repoRoot) {
    return 0;
  }
  close() {}
}

class CompositeSessionMemory {
  backends;
  constructor(backends) {
    this.backends = [...backends];
  }
  remember(input, options = {}) {
    for (const backend of this.backends) {
      try {
        backend.remember(input, options);
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend remember failed:", err);
      }
    }
  }
  recallForPlanning(options) {
    const collected = [];
    for (const backend of this.backends) {
      try {
        const rows = backend.recallForPlanning(options);
        if (Array.isArray(rows) && rows.length > 0) {
          collected.push(...rows);
        }
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend recall failed:", err);
      }
    }
    return mergeMemoryLines(collected, {
      maxItems: options.maxItems,
      maxChars: options.maxChars
    });
  }
  purgeExpired(retentionDays, repoRoot) {
    let total = 0;
    for (const backend of this.backends) {
      try {
        total += backend.purgeExpired(retentionDays, repoRoot);
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend purge failed:", err);
      }
    }
    return total;
  }
  close() {
    for (const backend of this.backends) {
      try {
        backend.close();
      } catch (err) {
        console.warn("[RemoteBuddy] Memory backend close failed:", err);
      }
    }
  }
}

// apps/remotebuddy/src/persistent_memory.ts
import { Database as Database2 } from "bun:sqlite";
var SQLITE_BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]);
var SQLITE_BUSY_RETRY_ATTEMPTS = 3;
var SQLITE_BUSY_TIMEOUT_MS = 3000;
function normalizeSummary(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}
function clampPositiveInt2(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.max(min, Math.min(max, parsed));
}

class PersistentSessionMemory {
  db;
  constructor(dbPath = "remotebuddy-state.db") {
    this.db = new Database2(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.migrate();
  }
  isBusyError(error) {
    const code = String(error?.code ?? "").toUpperCase();
    if (SQLITE_BUSY_CODES.has(code))
      return true;
    const message = String(error?.message ?? "").toLowerCase();
    return message.includes("database is locked");
  }
  runWithBusyRetry(operation, action) {
    let lastError;
    for (let attempt = 0;attempt <= SQLITE_BUSY_RETRY_ATTEMPTS; attempt++) {
      try {
        return action();
      } catch (error) {
        lastError = error;
        if (!this.isBusyError(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw lastError ?? new Error(`[RemoteBuddy] SQLite busy retry exhausted for operation: ${operation}`);
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remotebuddy_memory (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repoRoot   TEXT NOT NULL,
        sessionId  TEXT NOT NULL,
        requestId  TEXT,
        kind       TEXT NOT NULL,
        summary    TEXT NOT NULL,
        createdAt  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_remotebuddy_memory_repo_created
        ON remotebuddy_memory(repoRoot, createdAt DESC);

      CREATE INDEX IF NOT EXISTS idx_remotebuddy_memory_repo_session_created
        ON remotebuddy_memory(repoRoot, sessionId, createdAt DESC);
    `);
  }
  remember(input, options = {}) {
    const repoRoot = normalizeSummary(input.repoRoot);
    const sessionId = normalizeSummary(input.sessionId);
    const kind = normalizeSummary(input.kind) || "note";
    const maxSummaryChars = clampPositiveInt2(options.maxSummaryChars, 420, 32, 8000);
    const summaryRaw = normalizeSummary(input.summary);
    if (!repoRoot || !sessionId || !summaryRaw)
      return;
    const summary = summaryRaw.length <= maxSummaryChars ? summaryRaw : `${summaryRaw.slice(0, maxSummaryChars - 14)} ...[truncated]`;
    const requestId = normalizeSummary(input.requestId ?? "") || null;
    const createdAt = new Date().toISOString();
    this.runWithBusyRetry("remember.insert", () => this.db.prepare(`INSERT INTO remotebuddy_memory (repoRoot, sessionId, requestId, kind, summary, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`).run(repoRoot, sessionId, requestId, kind, summary, createdAt));
    const retentionDays = clampPositiveInt2(options.retentionDays, 30, 1, 3650);
    try {
      this.purgeExpired(retentionDays, repoRoot);
    } catch (error) {
      console.warn("[RemoteBuddy] Persistent memory purge skipped:", error);
    }
  }
  recallForPlanning(options) {
    const repoRoot = normalizeSummary(options.repoRoot);
    const sessionId = normalizeSummary(options.sessionId);
    if (!repoRoot || !sessionId)
      return [];
    const includeCurrentSession = options.includeCurrentSession !== false;
    const includeCrossSession = options.includeCrossSession !== false;
    if (!includeCurrentSession && !includeCrossSession)
      return [];
    const maxItems = clampPositiveInt2(options.maxItems, 8, 1, 64);
    const maxChars = clampPositiveInt2(options.maxChars, 2400, 120, 24000);
    const scanLimit = Math.max(maxItems, Math.min(400, maxItems * 8));
    let sessionClause = "";
    const params = [repoRoot];
    if (includeCurrentSession && !includeCrossSession) {
      sessionClause = " AND sessionId = ?";
      params.push(sessionId);
    } else if (!includeCurrentSession && includeCrossSession) {
      sessionClause = " AND sessionId <> ?";
      params.push(sessionId);
    }
    params.push(scanLimit);
    const rows = this.db.prepare(`SELECT id, sessionId, kind, summary, createdAt
         FROM remotebuddy_memory
         WHERE repoRoot = ?${sessionClause}
         ORDER BY createdAt DESC, id DESC
         LIMIT ?`).all(...params);
    const lines = rows.map((row) => {
      const summary = normalizeSummary(row.summary);
      if (!summary)
        return "";
      const source = row.sessionId === sessionId ? "this-session" : "repo-history";
      const kind = normalizeSummary(row.kind) || "note";
      return `[memory ${source} ${kind}] ${summary}`;
    }).filter(Boolean);
    return mergeMemoryLines(lines, { maxItems, maxChars });
  }
  purgeExpired(retentionDays, repoRoot) {
    const days = clampPositiveInt2(retentionDays, 30, 1, 3650);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const repo = normalizeSummary(repoRoot ?? "");
    const result = this.runWithBusyRetry("remember.purge_expired", () => repo ? this.db.prepare(`DELETE FROM remotebuddy_memory WHERE repoRoot = ? AND createdAt < ?`).run(repo, cutoff) : this.db.prepare(`DELETE FROM remotebuddy_memory WHERE createdAt < ?`).run(cutoff));
    return Number(result.changes ?? 0);
  }
  close() {
    this.db.close();
  }
}

// apps/remotebuddy/src/remotebuddy_main.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync2 } from "fs";
import { resolve as resolve5 } from "path";

// apps/remotebuddy/src/autonomous_engine.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { existsSync as existsSync4, mkdirSync, readdirSync, rmSync as rmSync2, statSync as statSync2 } from "fs";
import { resolve as resolve4 } from "path";

// apps/remotebuddy/src/command_policy.ts
var YARN_NON_SCRIPT_COMMANDS = new Set([
  "add",
  "install",
  "remove",
  "up",
  "upgrade",
  "set",
  "config",
  "cache",
  "dlx",
  "node",
  "workspaces",
  "workspace",
  "npm",
  "init",
  "create",
  "why",
  "info",
  "pack",
  "publish",
  "version",
  "test",
  "run",
  "exec"
]);
function canonicalizeValidationCommandForBun(command) {
  let value = String(command ?? "").trim();
  if (!value)
    return "";
  value = value.replace(/^npx\s+/i, "bunx ");
  value = value.replace(/^npm\s+exec\s+/i, "bunx ");
  value = value.replace(/^pnpm\s+(?:dlx|exec)\s+/i, "bunx ");
  value = value.replace(/^yarn\s+dlx\s+/i, "bunx ");
  value = value.replace(/^npm\s+--prefix\s+(\S+)\s+run\s+/i, "bun --cwd $1 run ");
  value = value.replace(/^npm\s+--prefix\s+(\S+)\s+test\b/i, "bun --cwd $1 test");
  value = value.replace(/^npm\s+run\s+/i, "bun run ");
  value = value.replace(/^pnpm\s+run\s+/i, "bun run ");
  value = value.replace(/^yarn\s+run\s+/i, "bun run ");
  value = value.replace(/^npm\s+test\b/i, "bun test");
  value = value.replace(/^pnpm\s+test\b/i, "bun test");
  value = value.replace(/^yarn\s+test\b/i, "bun test");
  const yarnScriptMatch = value.match(/^yarn\s+([A-Za-z0-9:_-]+)(\s+.*)?$/i);
  if (yarnScriptMatch) {
    const subcommand = String(yarnScriptMatch[1] ?? "").toLowerCase();
    if (!YARN_NON_SCRIPT_COMMANDS.has(subcommand)) {
      value = `bun run ${yarnScriptMatch[1]}${yarnScriptMatch[2] ?? ""}`.trim();
    }
  }
  return value.trim();
}
function canonicalizeInstructionTextForBun(text) {
  let value = String(text ?? "");
  if (!value.trim())
    return "";
  value = value.replace(/`([^`\n]+)`/g, (_full, command) => {
    const canonical = canonicalizeValidationCommandForBun(command);
    return canonical ? `\`${canonical}\`` : `\`${command}\``;
  });
  value = value.replace(/\bnpx\s+/gi, "bunx ");
  value = value.replace(/\bnpm\s+exec\s+/gi, "bunx ");
  value = value.replace(/\bpnpm\s+(?:dlx|exec)\s+/gi, "bunx ");
  value = value.replace(/\byarn\s+dlx\s+/gi, "bunx ");
  value = value.replace(/\bnpm\s+--prefix\s+(\S+)\s+run\s+/gi, "bun --cwd $1 run ");
  value = value.replace(/\bnpm\s+--prefix\s+(\S+)\s+test\b/gi, "bun --cwd $1 test");
  value = value.replace(/\bnpm\s+run\s+/gi, "bun run ");
  value = value.replace(/\bpnpm\s+run\s+/gi, "bun run ");
  value = value.replace(/\byarn\s+run\s+/gi, "bun run ");
  value = value.replace(/\bnpm\s+test\b/gi, "bun test");
  value = value.replace(/\bpnpm\s+test\b/gi, "bun test");
  value = value.replace(/\byarn\s+test\b/gi, "bun test");
  return value;
}

// apps/remotebuddy/src/autonomous_engine.ts
var POLICY = {
  flaky_test: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true
  },
  lint_fix: {
    maxRisk: "low",
    maxBreadth: "narrow",
    autonomousAllowed: true,
    requireValidation: true
  },
  type_fix: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true
  },
  small_refactor: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true
  },
  feature_small: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true
  },
  feature_medium: {
    maxRisk: "medium",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: true
  },
  feature_large: {
    maxRisk: "high",
    maxBreadth: "broad",
    autonomousAllowed: false,
    requireValidation: true
  },
  docs: {
    maxRisk: "low",
    maxBreadth: "medium",
    autonomousAllowed: true,
    requireValidation: false
  },
  dep_bump: {
    maxRisk: "medium",
    maxBreadth: "narrow",
    autonomousAllowed: false,
    requireValidation: true
  }
};
var RISK_ORDER = { low: 0, medium: 1, high: 2 };
var BREADTH_ORDER = {
  narrow: 0,
  medium: 1,
  broad: 2
};
var IDEATION_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/autonomy_ideation_system_prompt.md").trim();
var SCORING_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/autonomy_scoring_system_prompt.md").trim();
var PLANNING_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/autonomy_planning_system_prompt.md").trim();
var IDEATION_TIMEOUT_RECOVERY_INSTRUCTION = "Previous ideation timed out before you returned JSON. For this round only, stay within the time budget: prioritize the top 1-3 highest-confidence candidates, keep reasoning brief, avoid exhaustive exploration, and return valid JSON as soon as possible.";
var VISION_DOC_FNAME = "vision.md";
var MAX_VISION_SECTION_CHARS = 1200;
var DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY = 0.45;
var DOCS_WEAK_EVIDENCE_MAX_PENALTY = 0.12;
var ENGINE_EXPLORE_RATE_DEFAULT = 0.3;
var ENGINE_EXPLORE_RATE_MIN = 0.1;
var ENGINE_EXPLORE_RATE_MAX = 0.6;
var ENGINE_NOVELTY_SAMPLE_SATURATION = 12;
var ENGINE_EXPLORE_POOL_MAX = 3;
var AUTO_INGEST_SEED_PATTERNS = [
  {
    algorithm: "autonomy_dispatch_backpressure_guard",
    whenToUse: "when worker saturation and queue latency rise together",
    summary: "Throttle autonomous dispatch based on queue pressure and available idle worker capacity to reduce thrash.",
    tags: ["queue", "backpressure", "scheduling", "autonomy"],
    risks: ["Over-throttling can starve high-value opportunities."],
    validation: [
      "Replay queue snapshots and confirm p95 latency improves without collapsing throughput."
    ],
    qualityScore: 0.78,
    freshnessScore: 0.82
  },
  {
    algorithm: "objective_scope_guardrail_feedback_loop",
    whenToUse: "when autonomous outcomes show repeated rework or scope drift",
    summary: "Use outcome feedback to tighten candidate scope defaults and reduce broad write targets for risky components.",
    tags: ["scope", "safety", "guardrails", "regret"],
    risks: ["Can become too conservative and suppress beneficial fixes."],
    validation: ["Compare regret/reopen rate before and after scope guardrail adjustments."],
    qualityScore: 0.74,
    freshnessScore: 0.8
  },
  {
    algorithm: "engine_novelty_explore_exploit_tuner",
    whenToUse: "when engine ideas overfit a small set of previously successful patterns",
    summary: "Adapt exploration rate using recent regret pressure and prior diversity to balance reliability with novelty.",
    tags: ["bandit", "explore-exploit", "novelty", "engine"],
    risks: ["Too much exploration can increase failed dispatches."],
    validation: [
      "Track novelty diversity and successful dispatch rate across rolling 24h windows."
    ],
    qualityScore: 0.76,
    freshnessScore: 0.79
  }
];
function docsWeakEvidencePenaltyForImpact(objectiveType, impactSignal) {
  if (objectiveType !== "docs")
    return 0;
  const normalizedImpact = clamp012(impactSignal);
  if (normalizedImpact >= DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY)
    return 0;
  const gapRatio = (DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY - normalizedImpact) / DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY;
  const penalty = DOCS_WEAK_EVIDENCE_MAX_PENALTY * clamp012(gapRatio);
  return Math.round(penalty * 1e6) / 1e6;
}
function feedbackPriorSignalForScoring(prior) {
  const emaSuccess = clamp012(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp012(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp012(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp012(asNumber(prior?.ema_regret, 0));
  const priorScore = 0.12 * emaSuccess + 0.08 * emaUserAccept + 0.06 * emaLatency + 0.04 * (1 - emaRegret);
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    priorScore
  };
}
function engineIdeaPriorSignalForScoring(prior) {
  const sampleCount = Math.max(0, Math.floor(asNumber(prior?.sample_count, 0)));
  if (sampleCount === 0) {
    return {
      emaSuccess: 0,
      emaUserAccept: 0,
      emaLatency: 0,
      emaRegret: 0,
      sampleCount: 0,
      noveltyScore: 1,
      priorScore: 0,
      noveltyBonus: 0.06
    };
  }
  const emaSuccess = clamp012(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp012(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp012(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp012(asNumber(prior?.ema_regret, 0));
  const noveltyScore = 1 - clamp012(sampleCount / ENGINE_NOVELTY_SAMPLE_SATURATION);
  const priorScore = 0.08 * emaSuccess + 0.05 * emaUserAccept + 0.03 * emaLatency + 0.02 * (1 - emaRegret);
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    sampleCount,
    noveltyScore,
    priorScore,
    noveltyBonus: 0.06 * noveltyScore
  };
}
function engineSourcePriorSignalForScoring(prior) {
  const sampleCount = Math.max(0, Math.floor(asNumber(prior?.sample_count, 0)));
  const curationStatus = normalizeSourceCurationStatus(prior?.curation_status);
  const curationReason = asString2(prior?.curation_reason);
  const trustScore = clamp012(asNumber(prior?.trust_score, 0));
  const freshnessScore = clamp012(asNumber(prior?.freshness_score, sampleCount > 0 ? 0.7 : 0.5));
  if (sampleCount === 0) {
    return {
      emaSuccess: 0,
      emaUserAccept: 0,
      emaLatency: 0,
      emaRegret: 0,
      sampleCount: 0,
      noveltyScore: 1,
      priorScore: 0,
      noveltyBonus: 0.03,
      curationStatus,
      curationReason,
      trustScore,
      freshnessScore,
      trustBoost: 0,
      curationPenalty: curationStatus === "archived" ? 0.14 : curationStatus === "watchlist" ? 0.05 : 0
    };
  }
  const emaSuccess = clamp012(asNumber(prior?.ema_success, 0));
  const emaUserAccept = clamp012(asNumber(prior?.ema_user_accept, 0));
  const emaLatency = clamp012(asNumber(prior?.ema_latency, 0));
  const emaRegret = clamp012(asNumber(prior?.ema_regret, 0));
  const noveltyScore = 1 - clamp012(sampleCount / ENGINE_NOVELTY_SAMPLE_SATURATION);
  const rawPriorScore = 0.06 * emaSuccess + 0.04 * emaUserAccept + 0.03 * emaLatency + 0.02 * (1 - emaRegret);
  const priorScore = rawPriorScore * (0.45 + 0.55 * freshnessScore);
  const trustBoost = curationStatus === "trusted" ? 0.04 * Math.max(trustScore, 0.6) : 0;
  const curationPenalty = curationStatus === "archived" ? 0.14 : curationStatus === "watchlist" ? 0.05 : 0;
  const noveltyBonus = curationStatus === "archived" ? 0 : 0.03 * noveltyScore;
  return {
    emaSuccess,
    emaUserAccept,
    emaLatency,
    emaRegret,
    sampleCount,
    noveltyScore,
    priorScore,
    noveltyBonus,
    curationStatus,
    curationReason,
    trustScore,
    freshnessScore,
    trustBoost,
    curationPenalty
  };
}
function normalizeSourceCurationStatus(value) {
  const raw = asString2(value).toLowerCase();
  if (raw === "trusted")
    return "trusted";
  if (raw === "watchlist")
    return "watchlist";
  if (raw === "archived")
    return "archived";
  return "candidate";
}
function deriveInspirationSourceKey(params) {
  const fingerprint = asString2(params.sourceFingerprint);
  if (fingerprint)
    return `fingerprint:${fingerprint.toLowerCase()}`;
  const sourceType = asString2(params.sourceType).toLowerCase();
  const sourceLabel = asString2(params.sourceLabel).toLowerCase();
  const sourceUrl = asString2(params.sourceUrl).toLowerCase();
  if (!sourceType && !sourceLabel && !sourceUrl)
    return "";
  return `source:${createHash2("sha256").update([sourceType, sourceLabel, sourceUrl].join("|")).digest("hex")}`;
}
function clampToRange(value, min, max) {
  if (!Number.isFinite(value))
    return min;
  if (value <= min)
    return min;
  if (value >= max)
    return max;
  return value;
}
function computeAdaptiveExploreRate(params) {
  const baseRate = clamp012(asNumber(params.baseRate, ENGINE_EXPLORE_RATE_DEFAULT));
  const minRate = clamp012(asNumber(params.minRate, ENGINE_EXPLORE_RATE_MIN));
  const maxRate = clamp012(asNumber(params.maxRate, ENGINE_EXPLORE_RATE_MAX));
  const lowerBound = Math.min(minRate, maxRate);
  const upperBound = Math.max(minRate, maxRate);
  const topSignals = Array.isArray(params.snapshot.top_signals) ? params.snapshot.top_signals : [];
  const regretSignal = clamp012(Math.max(0, ...topSignals.filter((entry) => asString2(entry.type).toLowerCase() === "regret_signal").map((entry) => asNumber(entry.value, 0))));
  const queuePressure = clamp012(Math.max(0, ...topSignals.filter((entry) => asString2(entry.type).toLowerCase() === "queue_health").map((entry) => asNumber(entry.value, 0))));
  const feedback = Array.isArray(params.snapshot.feedback_priors) ? params.snapshot.feedback_priors : [];
  let weightedTotal = 0;
  let weightedSuccess = 0;
  let weightedUserAccept = 0;
  let weightedRegret = 0;
  for (const prior of feedback) {
    const weight = Math.max(1, Math.floor(asNumber(prior.sample_count, 1)));
    weightedTotal += weight;
    weightedSuccess += weight * clamp012(asNumber(prior.ema_success, 0));
    weightedUserAccept += weight * clamp012(asNumber(prior.ema_user_accept, 0));
    weightedRegret += weight * clamp012(asNumber(prior.ema_regret, 0));
  }
  const avgSuccess = weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
  const avgUserAccept = weightedTotal > 0 ? weightedUserAccept / weightedTotal : 0;
  const avgRegret = weightedTotal > 0 ? weightedRegret / weightedTotal : 0;
  const revisionPressure = clamp012(1 - avgUserAccept);
  const stability = clamp012(0.65 * avgSuccess + 0.35 * (1 - avgRegret));
  const engineRows = Array.isArray(params.snapshot.engine_idea_priors) ? params.snapshot.engine_idea_priors : [];
  const sourceRows = Array.isArray(params.snapshot.engine_source_priors) ? params.snapshot.engine_source_priors : [];
  const sampleCounts = [...engineRows, ...sourceRows].map((row) => Math.max(0, Math.floor(asNumber(row.sample_count, 0)))).filter((count) => count > 0);
  const engineSampleTotal = sampleCounts.reduce((sum, count) => sum + count, 0);
  const topShare = engineSampleTotal > 0 ? Math.max(...sampleCounts) / engineSampleTotal : 1;
  const activeBlocks = sampleCounts.length;
  const scarcity = clamp012(1 - Math.min(activeBlocks, 5) / 5);
  const diversityDeficit = engineSampleTotal <= 0 ? 1 : clamp012(0.65 * clamp012(topShare) + 0.35 * scarcity);
  const coldStartBoost = engineSampleTotal < 6 ? 0.05 : 0;
  const upwardPressure = 0.16 * regretSignal + 0.1 * revisionPressure + 0.08 * diversityDeficit + 0.05 * queuePressure;
  const downwardPressure = 0.18 * stability + 0.08 * (1 - regretSignal);
  const rawRate = baseRate + upwardPressure - downwardPressure + coldStartBoost;
  const effectiveRate = clampToRange(rawRate, lowerBound, upperBound);
  const adjustment = effectiveRate - baseRate;
  return {
    baseRate,
    effectiveRate,
    adjustment,
    regretSignal,
    revisionPressure,
    stability,
    diversityDeficit
  };
}
function deterministicUnitInterval(seed) {
  const digest = createHash2("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0);
  return value / 4294967296;
}
function pickCandidateWithExploreExploit(params) {
  const exploreRate = clamp012(asNumber(params.exploreRate, ENGINE_EXPLORE_RATE_DEFAULT));
  if (params.rows.length === 0) {
    return { selected: null, strategy: "exploit", roll: 1 };
  }
  const exploitOrdered = [...params.rows].sort((a, b) => {
    if (b.finalScore !== a.finalScore)
      return b.finalScore - a.finalScore;
    return a.id.localeCompare(b.id);
  });
  const exploitTop = exploitOrdered[0];
  const modeRoll = deterministicUnitInterval(`${params.seed}:mode`);
  const shouldExplore = exploitOrdered.length > 1 && modeRoll < exploreRate;
  if (!shouldExplore) {
    return { selected: exploitTop, strategy: "exploit", roll: modeRoll };
  }
  const noveltyOrdered = [...params.rows].filter((row) => row.noveltyScore > 0).sort((a, b) => {
    if (b.noveltyScore !== a.noveltyScore)
      return b.noveltyScore - a.noveltyScore;
    if (b.finalScore !== a.finalScore)
      return b.finalScore - a.finalScore;
    return a.id.localeCompare(b.id);
  });
  if (noveltyOrdered.length === 0) {
    return { selected: exploitTop, strategy: "exploit", roll: modeRoll };
  }
  const pool = noveltyOrdered.slice(0, Math.min(ENGINE_EXPLORE_POOL_MAX, noveltyOrdered.length));
  const pickRoll = deterministicUnitInterval(`${params.seed}:pick`);
  const index = Math.min(pool.length - 1, Math.floor(pickRoll * pool.length));
  let selected = pool[index];
  if (selected.id === exploitTop.id && pool.length > 1) {
    selected = pool[(index + 1) % pool.length];
  }
  return { selected, strategy: "explore", roll: modeRoll };
}
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {};
  return value;
}
function asString2(value) {
  return String(value ?? "").trim();
}
function asStringArray2(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => asString2(entry)).filter(Boolean);
}
function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function uniqueLowercaseTokens(values, max = 24) {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    const normalized = asString2(value).toLowerCase();
    if (!normalized || seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max)
      break;
  }
  return out;
}
var OBJECTIVE_TYPES = new Set([
  "flaky_test",
  "lint_fix",
  "type_fix",
  "small_refactor",
  "feature_small",
  "feature_medium",
  "feature_large",
  "docs",
  "dep_bump"
]);
var COMMON_REPO_TARGET_DIRS = [
  "src",
  "app",
  "apps",
  "server",
  "client",
  "frontend",
  "backend",
  "web",
  "api",
  "lib",
  "services",
  "packages",
  "cmd",
  "internal",
  "tests",
  "test",
  "docs",
  "scripts"
];
var COMMON_REPO_TARGET_FILES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "vision.md"
];
var REPO_TARGET_SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".cs",
  ".rb",
  ".php",
  ".cpp",
  ".c",
  ".h",
  ".md",
  ".toml",
  ".json",
  ".yaml",
  ".yml"
]);
var IGNORED_REPO_TARGET_DIRS = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "outputs",
  ".next",
  ".turbo",
  ".idea",
  ".vscode",
  ".venv",
  "venv",
  "__pycache__",
  "target"
]);
function pathBasename(path) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
function pathDirname(path) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}
function pathExtname(path) {
  const base = pathBasename(path);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}
function tokenizePath(value) {
  return value.replace(/\\/g, "/").split(/[^A-Za-z0-9]+/g).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
function buildRepoTargetProfile(targetPath) {
  const normalized = asString2(targetPath).replace(/\\/g, "/");
  const componentArea = normalizeAutonomyComponentArea(pathDirname(normalized) || normalized) ?? normalized;
  const keywords = [...new Set([...tokenizePath(componentArea), ...tokenizePath(normalized)])];
  return {
    component_area: componentArea,
    target_paths: [normalized],
    write_globs: [normalized],
    label: normalized,
    keywords
  };
}
function collectRepoTargetFiles(repoRoot, startRelativePath, maxResults, maxDepth = 3) {
  const startPath = resolve4(repoRoot, startRelativePath);
  if (!existsSync4(startPath))
    return [];
  const out = [];
  const walk = (absolutePath, relativePath, depth) => {
    if (out.length >= maxResults)
      return;
    let stat;
    try {
      stat = statSync2(absolutePath);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (depth > maxDepth)
        return;
      let entries;
      try {
        entries = readdirSync(absolutePath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && IGNORED_REPO_TARGET_DIRS.has(entry.name))
          continue;
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const childAbsolute = resolve4(absolutePath, entry.name);
        if (entry.isDirectory()) {
          walk(childAbsolute, childRelative, depth + 1);
        } else if (REPO_TARGET_SCAN_EXTENSIONS.has(pathExtname(entry.name))) {
          out.push(childRelative);
          if (out.length >= maxResults)
            return;
        }
      }
      return;
    }
    if (REPO_TARGET_SCAN_EXTENSIONS.has(pathExtname(relativePath))) {
      out.push(relativePath);
    }
  };
  walk(startPath, startRelativePath, 0);
  return out;
}
function discoverRepoTargetProfiles(repoRoot, maxProfiles = 16) {
  const profiles = [];
  const seen = new Set;
  const add = (targetPath) => {
    const finalPath = normalizeAutonomyComponentArea(targetPath);
    if (!finalPath)
      return;
    if (seen.has(finalPath))
      return;
    seen.add(finalPath);
    profiles.push(buildRepoTargetProfile(finalPath));
  };
  for (const file of COMMON_REPO_TARGET_FILES) {
    const absolutePath = resolve4(repoRoot, file);
    if (existsSync4(absolutePath))
      add(file);
    if (profiles.length >= maxProfiles)
      return profiles;
  }
  for (const dir of COMMON_REPO_TARGET_DIRS) {
    const files = collectRepoTargetFiles(repoRoot, dir, 2, 3);
    for (const file of files) {
      add(file);
      if (profiles.length >= maxProfiles)
        return profiles;
    }
  }
  if (profiles.length < maxProfiles) {
    const rootFiles = collectRepoTargetFiles(repoRoot, "", Math.max(4, maxProfiles - profiles.length), 2);
    for (const file of rootFiles) {
      add(file);
      if (profiles.length >= maxProfiles)
        return profiles;
    }
  }
  return profiles;
}
function chooseRepoTargetProfile(profiles, hints, triggerType) {
  if (profiles.length === 0)
    return null;
  const hintTokens = [...new Set(hints.flatMap((hint) => tokenizePath(hint)))];
  let best = null;
  for (const profile of profiles) {
    let score = 0;
    for (const token of hintTokens) {
      if (profile.keywords.includes(token))
        score += 2;
      if (profile.label.toLowerCase().includes(token))
        score += 1;
    }
    if (triggerType === "test_failure" && /(^|\/)(test|tests)\//.test(profile.label))
      score += 3;
    if (triggerType === "queue_health" && /(server|api|queue|worker|job|task)/i.test(profile.label))
      score += 2;
    if (triggerType === "regret_signal" && /(src|app|lib|server|client|docs|readme)/i.test(profile.label))
      score += 1;
    if (!best || score > best.score)
      best = { profile, score };
  }
  return best?.profile ?? profiles[0] ?? null;
}
function adaptCandidateShapeToRepo(params) {
  const shape = params.shape;
  const scopeValidation = validateScopeInvariants(shape.component_area, shape.target_paths, shape.write_globs, {
    requireWriteGlobs: true
  });
  const pathsExist = params.repoRoot && scopeValidation.ok ? findMissingRepoTargetPaths(params.repoRoot, scopeValidation.normalizedTargetPaths).length === 0 : scopeValidation.ok;
  if (scopeValidation.ok && pathsExist) {
    return {
      ...shape,
      component_area: scopeValidation.componentArea ?? shape.component_area,
      target_paths: scopeValidation.normalizedTargetPaths,
      write_globs: scopeValidation.normalizedWriteGlobs
    };
  }
  const selected = chooseRepoTargetProfile(params.repoTargets ?? [], [shape.component_area, ...shape.target_paths, ...shape.write_globs, ...params.hints ?? []], shape.trigger_type);
  if (!selected)
    return shape;
  return {
    ...shape,
    component_area: selected.component_area,
    target_paths: selected.target_paths,
    write_globs: selected.write_globs
  };
}
function findMissingRepoTargetPaths(repoRoot, targetPaths) {
  return targetPaths.map((targetPath) => asString2(targetPath)).filter(Boolean).filter((targetPath) => !existsSync4(resolve4(repoRoot, targetPath)));
}
function asAutonomyObjectiveType(value) {
  const normalized = asString2(value);
  return OBJECTIVE_TYPES.has(normalized) ? normalized : null;
}
function asAutonomyComponentArea(value) {
  return normalizeAutonomyComponentArea(value);
}
function defaultCandidateShapeForArea(area) {
  switch (area) {
    case "apps/server":
      return {
        objective_type: "feature_small",
        trigger_type: "queue_health",
        component_area: "apps/server",
        target_paths: ["apps/server/src/autonomy.ts"],
        write_globs: ["apps/server/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "apps/remotebuddy":
      return {
        objective_type: "feature_small",
        trigger_type: "regret_signal",
        component_area: "apps/remotebuddy",
        target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
        write_globs: ["apps/remotebuddy/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "apps/workerpals":
      return {
        objective_type: "feature_small",
        trigger_type: "queue_health",
        component_area: "apps/workerpals",
        target_paths: ["apps/workerpals/src/workerpals_main.ts"],
        write_globs: ["apps/workerpals/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "apps/client":
      return {
        objective_type: "small_refactor",
        trigger_type: "regret_signal",
        component_area: "apps/client",
        target_paths: ["apps/client/src"],
        write_globs: ["apps/client/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "packages/protocol":
      return {
        objective_type: "small_refactor",
        trigger_type: "typecheck_failure",
        component_area: "packages/protocol",
        target_paths: ["packages/protocol/src"],
        write_globs: ["packages/protocol/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "packages/shared":
      return {
        objective_type: "small_refactor",
        trigger_type: "typecheck_failure",
        component_area: "packages/shared",
        target_paths: ["packages/shared/src/autonomy_policy.ts"],
        write_globs: ["packages/shared/src/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "tests/integration":
      return {
        objective_type: "flaky_test",
        trigger_type: "test_failure",
        component_area: "tests/integration",
        target_paths: ["tests/integration"],
        write_globs: ["tests/integration/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    case "tests/unit":
      return {
        objective_type: "flaky_test",
        trigger_type: "test_failure",
        component_area: "tests/unit",
        target_paths: ["tests/unit"],
        write_globs: ["tests/unit/*"],
        risk_level: "low",
        expected_validation: ["bun run test:root"]
      };
    default:
      return {
        objective_type: "small_refactor",
        trigger_type: "regret_signal",
        component_area: area,
        target_paths: [area],
        write_globs: [area],
        risk_level: "low",
        expected_validation: ["git status --porcelain"]
      };
  }
}
var ENGINE_OBJECTIVE_BLUEPRINTS = [
  {
    id: "reliable_autonomous_delivery",
    title: "Reliable Autonomous Delivery Loop",
    baseWeight: 0.62,
    keywordPattern: /\b(reliab|stable|stability|startup|failure|flake|retry|incident|deterministic|preflight|runtime)\b/i,
    buckets: ["priorities", "objectives", "metrics", "constraints"]
  },
  {
    id: "merge_conversion_and_rework",
    title: "High-Confidence Review + Merge Conversion",
    baseWeight: 0.58,
    keywordPattern: /\b(merge|review|pr|pull request|rework|conflict|approved|conversion|comment cap|unmergeable)\b/i,
    buckets: ["priorities", "objectives", "metrics", "operating_model"]
  },
  {
    id: "mass_audience_activation",
    title: "Activation: First Autonomous PR Fast",
    baseWeight: 0.5,
    keywordPattern: /\b(activation|first pr|onboard|onboarding|quickstart|time-to-first-value|30 minutes|retention)\b/i,
    buckets: ["priorities", "objectives", "metrics", "target_users"]
  },
  {
    id: "policy_and_governance",
    title: "Policy + Permission Governance",
    baseWeight: 0.55,
    keywordPattern: /\b(policy|permission|scope|guardrail|audit|risk|security|approval|governance|least privilege)\b/i,
    buckets: ["guardrails", "constraints", "risk_policy", "governance"]
  },
  {
    id: "workforce_scaling",
    title: "Workforce-Grade Delegation",
    baseWeight: 0.6,
    keywordPattern: /\b(workforce|worker|delegation|specialist|dispatch|throughput|task schema|capability|taxonomy)\b/i,
    buckets: ["priorities", "objectives", "operating_model"]
  }
];
var ENGINE_IDEA_BLUEPRINTS = [
  {
    id: "vision_compiler_refresh",
    algorithm: "vision_compiler",
    summary: "Continuously compile vision signals into weighted autonomous objectives.",
    hypothesis: "Objective-weighted planning reduces drift and increases accepted autonomous PR quality.",
    objective_ids: ["reliable_autonomous_delivery", "policy_and_governance"],
    gap_ids: ["delivery_reliability_gap", "governance_gap"],
    candidate_shape: {
      objective_type: "small_refactor",
      trigger_type: "regret_signal",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "opportunity_graph_pipeline",
    algorithm: "opportunity_graph",
    summary: "Model queue/review/runtime friction as an opportunity graph and prioritize highest leverage edges.",
    hypothesis: "Graph-ranked bottlenecks improve throughput without increasing risk by focusing on high-friction links.",
    objective_ids: ["reliable_autonomous_delivery", "workforce_scaling"],
    gap_ids: ["delivery_reliability_gap", "workforce_throughput_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "queue_health",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "motif_miner_learning_loop",
    algorithm: "motif_miner",
    summary: "Mine successful local commit/PR motifs and bias candidate generation toward those patterns.",
    hypothesis: "Learning from accepted local motifs lowers review churn and improves merge conversion.",
    objective_ids: ["merge_conversion_and_rework", "workforce_scaling"],
    gap_ids: ["merge_rework_gap", "workforce_throughput_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "regret_signal",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "regret_miner_guard",
    algorithm: "regret_miner",
    summary: "Convert rejected/unmergeable feedback into deterministic preventive heuristics.",
    hypothesis: "Explicit regret-mined heuristics reduce repeated PR rejection modes across workers.",
    objective_ids: ["merge_conversion_and_rework", "policy_and_governance"],
    gap_ids: ["merge_rework_gap", "governance_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "regret_signal",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "adjacent_possible_generator",
    algorithm: "adjacent_possible",
    summary: "Generate new ideas by recombining proven motifs with active bottlenecks.",
    hypothesis: "Adjacent-possible idea generation increases novelty while staying inside proven safety boundaries.",
    objective_ids: ["workforce_scaling", "reliable_autonomous_delivery"],
    gap_ids: ["workforce_throughput_gap", "delivery_reliability_gap"],
    candidate_shape: {
      objective_type: "feature_small",
      trigger_type: "queue_health",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "portfolio_bandit_dispatch",
    algorithm: "portfolio_bandit",
    summary: "Allocate dispatch budget across reliability, mergeability, activation, and governance idea portfolios.",
    hypothesis: "Portfolio-based dispatch improves aggregate repo outcomes versus single-metric greedy selection.",
    objective_ids: [
      "reliable_autonomous_delivery",
      "merge_conversion_and_rework",
      "mass_audience_activation",
      "policy_and_governance"
    ],
    gap_ids: ["delivery_reliability_gap", "merge_rework_gap", "activation_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "queue_health",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "counterfactual_impact_estimator",
    algorithm: "counterfactual_impact",
    summary: "Estimate prevented incidents/rework if a proposed feature had existed over recent runs.",
    hypothesis: "Counterfactual scoring improves prioritization of ideas with measurable practical payoff.",
    objective_ids: ["reliable_autonomous_delivery", "merge_conversion_and_rework"],
    gap_ids: ["delivery_reliability_gap", "merge_rework_gap"],
    candidate_shape: {
      objective_type: "small_refactor",
      trigger_type: "typecheck_failure",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    id: "workforce_capability_planner",
    algorithm: "capability_planner",
    summary: "Propose and score new worker specializations from recurring task clusters.",
    hypothesis: "Capability-aware routing raises throughput and lowers fix-loop churn for autonomous execution.",
    objective_ids: ["workforce_scaling", "mass_audience_activation"],
    gap_ids: ["workforce_throughput_gap", "activation_gap"],
    candidate_shape: {
      objective_type: "feature_medium",
      trigger_type: "queue_health",
      component_area: "apps/workerpals",
      target_paths: ["apps/workerpals/src/workerpals_main.ts"],
      write_globs: ["apps/workerpals/src/*"],
      risk_level: "medium",
      expected_validation: ["bun run test:root"]
    }
  }
];
var INSPIRATION_COMPONENT_HINTS = [
  {
    area: "apps/server",
    pattern: /\b(server|queue|backpressure|dispatch|snapshot|lock|db|sqlite|status)\b/i
  },
  {
    area: "apps/remotebuddy",
    pattern: /\b(remotebuddy|autonomous engine|ideation|planner|scoring)\b/i
  },
  { area: "apps/workerpals", pattern: /\b(worker|workerpal|sandbox|executor|task\.execute)\b/i },
  { area: "apps/client", pattern: /\b(client|ui|frontend|dashboard|react)\b/i },
  { area: "packages/protocol", pattern: /\b(protocol|schema|contract|wire format)\b/i },
  { area: "packages/shared", pattern: /\b(shared|guardrail|scope invariant|policy helper)\b/i },
  { area: "tests/integration", pattern: /\b(integration test|e2e|end-to-end)\b/i },
  { area: "tests/unit", pattern: /\b(unit test)\b/i }
];
var GAP_TEXT_RULES = [
  {
    gapId: "delivery_reliability_gap",
    pattern: /\b(reliab|stability|startup|failure|flake|retry|incident|runtime|preflight|timeout)\b/i
  },
  {
    gapId: "merge_rework_gap",
    pattern: /\b(merge|review|pr|pull request|conflict|rework|regret|reject|revision)\b/i
  },
  { gapId: "activation_gap", pattern: /\b(activation|onboard|first pr|quickstart|setup)\b/i },
  {
    gapId: "governance_gap",
    pattern: /\b(policy|permission|scope|guardrail|audit|security|compliance|risk)\b/i
  },
  {
    gapId: "workforce_throughput_gap",
    pattern: /\b(worker|delegation|dispatch|throughput|queue|backpressure|capacity)\b/i
  }
];
var COMMIT_MOTIF_RULES = [
  {
    motifId: "queue_backpressure",
    label: "Queue backpressure and throughput",
    pattern: /\b(queue|backpressure|throughput|latency|pending|saturation|dispatch)\b/i,
    objectiveIds: ["workforce_scaling", "reliable_autonomous_delivery"],
    gapIds: ["workforce_throughput_gap", "delivery_reliability_gap"],
    shape: {
      objective_type: "feature_small",
      trigger_type: "queue_health",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    motifId: "merge_rework_loop",
    label: "Merge/rework loop hardening",
    pattern: /\b(merge|conflict|rebase|review|pr|churn|rework|unmergeable)\b/i,
    objectiveIds: ["merge_conversion_and_rework", "reliable_autonomous_delivery"],
    gapIds: ["merge_rework_gap", "delivery_reliability_gap"],
    shape: {
      objective_type: "feature_small",
      trigger_type: "regret_signal",
      component_area: "apps/server",
      target_paths: ["apps/server/src/autonomy.ts"],
      write_globs: ["apps/server/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    motifId: "startup_stability",
    label: "Startup/environment stability",
    pattern: /\b(startup|preflight|boot|config|environment|timeout|offline|deterministic)\b/i,
    objectiveIds: ["reliable_autonomous_delivery", "mass_audience_activation"],
    gapIds: ["delivery_reliability_gap", "activation_gap"],
    shape: {
      objective_type: "small_refactor",
      trigger_type: "regret_signal",
      component_area: "apps/remotebuddy",
      target_paths: ["apps/remotebuddy/src/autonomous_engine.ts"],
      write_globs: ["apps/remotebuddy/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    motifId: "policy_guardrails",
    label: "Policy/scope guardrails",
    pattern: /\b(policy|permission|scope|guardrail|audit|security|risk)\b/i,
    objectiveIds: ["policy_and_governance", "reliable_autonomous_delivery"],
    gapIds: ["governance_gap", "delivery_reliability_gap"],
    shape: {
      objective_type: "small_refactor",
      trigger_type: "regret_signal",
      component_area: "packages/shared",
      target_paths: ["packages/shared/src/autonomy_policy.ts"],
      write_globs: ["packages/shared/src/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  },
  {
    motifId: "test_flake_reliability",
    label: "Test flake reliability",
    pattern: /\b(test|flaky|flake|retry|stabilize|deterministic)\b/i,
    objectiveIds: ["reliable_autonomous_delivery"],
    gapIds: ["delivery_reliability_gap"],
    shape: {
      objective_type: "flaky_test",
      trigger_type: "test_failure",
      component_area: "tests/integration",
      target_paths: ["tests/integration"],
      write_globs: ["tests/integration/*"],
      risk_level: "low",
      expected_validation: ["bun run test:root"]
    }
  }
];
function bucketLines(items, keys) {
  return keys.flatMap((key) => Array.isArray(items[key]) ? items[key] : []).filter(Boolean);
}
function keywordEvidence(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).slice(0, 6);
}
function average(values) {
  if (values.length === 0)
    return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function maxSignalScore(snapshot, types) {
  return clamp012(Math.max(0, ...snapshot.top_signals.filter((signal) => types.includes(String(signal.type ?? "").trim())).map((signal) => asNumber(signal.value, 0))));
}
function maxTraitScore(snapshot, pattern) {
  return clamp012(Math.max(0, ...snapshot.state_traits.filter((trait) => pattern.test(String(trait.focus ?? "")) || pattern.test(String(trait.evidence ?? "")) || pattern.test(String(trait.trait_id ?? ""))).map((trait) => asNumber(trait.score, 0))));
}
function normalizeValidationIdeas(ideas) {
  const out = [];
  for (const idea of ideas) {
    const canonical = canonicalizeValidationCommandForBun(idea);
    if (canonical.startsWith("bun ")) {
      out.push(canonical);
      continue;
    }
    const lower = idea.toLowerCase();
    if (lower.includes("test"))
      out.push("bun run test:root");
    else if (lower.includes("lint"))
      out.push("bun run test:root");
    else if (lower.includes("type"))
      out.push("bun run test:root");
  }
  if (out.length === 0)
    out.push("bun run test:root");
  return [...new Set(out)].slice(0, 5);
}
function inferComponentAreaFromText(text, repoTargets, triggerType) {
  const repoTargetMatch = chooseRepoTargetProfile(repoTargets ?? [], [text], triggerType);
  if (repoTargetMatch)
    return repoTargetMatch.component_area;
  for (const rule of INSPIRATION_COMPONENT_HINTS) {
    if (rule.pattern.test(text))
      return rule.area;
  }
  return "src";
}
function inferObjectiveTypeFromText(text, tags) {
  const tagSet = new Set(tags);
  if (tagSet.has("flaky_test") || tagSet.has("flake") || /\b(flaky|flake)\b/i.test(text))
    return "flaky_test";
  if (tagSet.has("lint_fix") || /\b(lint|format)\b/i.test(text))
    return "lint_fix";
  if (tagSet.has("type_fix") || /\b(typecheck|typing|typescript|type error)\b/i.test(text))
    return "type_fix";
  if (tagSet.has("docs") || /\b(doc|readme|onboarding guide)\b/i.test(text))
    return "docs";
  if (tagSet.has("small_refactor") || /\b(refactor|cleanup|simplify|hardening)\b/i.test(text)) {
    return "small_refactor";
  }
  if (tagSet.has("feature_medium") || /\b(portfolio|planner|bandit|framework|capability)\b/i.test(text)) {
    return "feature_medium";
  }
  return "feature_small";
}
function inferTriggerTypeFromText(text) {
  if (/\b(queue|backpressure|throughput|latency|pending|capacity)\b/i.test(text))
    return "queue_health";
  if (/\b(lint|format)\b/i.test(text))
    return "lint_failure";
  if (/\b(typecheck|type error|typing|typescript)\b/i.test(text))
    return "typecheck_failure";
  if (/\b(test|flake|flaky|failing test)\b/i.test(text))
    return "test_failure";
  return "regret_signal";
}
function inferRiskLevelFromText(text, tags) {
  const joined = `${text} ${tags.join(" ")}`;
  if (/\b(auth|permission|security|credential|secret|encryption)\b/i.test(joined))
    return "medium";
  if (/\b(migration|schema rewrite|large rewrite|breaking change)\b/i.test(joined))
    return "high";
  return "low";
}
function matchObjectiveIdsFromText(text, fallback) {
  const matched = ENGINE_OBJECTIVE_BLUEPRINTS.filter((entry) => entry.keywordPattern.test(text)).map((entry) => entry.id);
  if (matched.length > 0)
    return matched.slice(0, 4);
  return fallback.slice(0, 2).map((entry) => entry.id);
}
function matchGapIdsFromText(text, fallback) {
  const out = [];
  for (const rule of GAP_TEXT_RULES) {
    if (rule.pattern.test(text))
      out.push(rule.gapId);
  }
  if (out.length > 0)
    return [...new Set(out)].slice(0, 4);
  return fallback.slice(0, 2).map((entry) => entry.id);
}
function normalizeInspirationPattern(value) {
  const raw = asObject(value);
  const algorithm = asString2(raw.algorithm);
  const whenToUse = asString2(raw.whenToUse ?? raw.when_to_use);
  const summary = asString2(raw.summary);
  if (!algorithm || !whenToUse || !summary)
    return null;
  const sourceType = asString2(raw.sourceType ?? raw.source_type).toLowerCase() || "external_doc";
  const tags = uniqueLowercaseTokens(asStringArray2(raw.tags), 24);
  const sourceRefs = asStringArray2(raw.sourceRefs ?? raw.source_refs).slice(0, 12);
  const metadata = asObject(raw.metadata);
  const fingerprintSeed = `${algorithm.toLowerCase()}|${whenToUse.toLowerCase()}`;
  const fingerprint = asString2(raw.fingerprint) || sha256(fingerprintSeed);
  const sourceLabel = asString2(raw.sourceLabel ?? raw.source_label) || null;
  const sourceUrl = asString2(raw.sourceUrl ?? raw.source_url) || null;
  const sourceKey = asString2(raw.sourceKey ?? raw.source_key) || asString2(metadata.source_key) || deriveInspirationSourceKey({
    sourceFingerprint: fingerprint,
    sourceType,
    sourceLabel,
    sourceUrl
  });
  const sourceCurationStatus = normalizeSourceCurationStatus(raw.sourceCurationStatus ?? raw.source_curation_status ?? metadata.source_curation_status);
  const sourceCurationReason = asString2(raw.sourceCurationReason ?? raw.source_curation_reason ?? metadata.source_curation_reason) || null;
  const sourceTrustScore = clamp012(asNumber(raw.sourceTrustScore ?? raw.source_trust_score ?? metadata.source_trust_score, 0));
  return {
    id: asString2(raw.id) || `insp_${fingerprint.slice(0, 10)}`,
    fingerprint,
    sourceKey,
    sourceType,
    sourceLabel,
    sourceUrl,
    sourceRefs,
    algorithm,
    whenToUse,
    summary,
    risks: asStringArray2(raw.risks).slice(0, 12),
    validationIdeas: asStringArray2(raw.validationIdeas ?? raw.validation_ideas).slice(0, 12),
    tags,
    qualityScore: clamp012(asNumber(raw.qualityScore ?? raw.quality_score, 0.5)),
    freshnessScore: clamp012(asNumber(raw.freshnessScore ?? raw.freshness_score, 0.5)),
    seenCount: Math.max(0, Math.floor(asNumber(raw.seenCount ?? raw.seen_count, 0))),
    sourceCurationStatus,
    sourceCurationReason,
    sourceTrustScore,
    metadata
  };
}
function normalizeSourceCurationInsight(value) {
  const raw = asObject(value);
  const sourceType = asString2(raw.sourceType ?? raw.source_type).toLowerCase() || "unknown";
  const sourceLabel = asString2(raw.sourceLabel ?? raw.source_label) || null;
  const sourceUrl = asString2(raw.sourceUrl ?? raw.source_url) || null;
  const sourceFingerprint = asString2(raw.sourceFingerprint ?? raw.source_fingerprint) || null;
  const sourceKey = asString2(raw.sourceKey ?? raw.source_key) || deriveInspirationSourceKey({
    sourceFingerprint,
    sourceType,
    sourceLabel,
    sourceUrl
  });
  if (!sourceKey && !sourceFingerprint)
    return null;
  return {
    sourceKey,
    sourceType,
    sourceLabel,
    sourceUrl,
    sourceFingerprint,
    curationStatus: normalizeSourceCurationStatus(raw.curationStatus ?? raw.curation_status),
    curationReason: asString2(raw.curationReason ?? raw.curation_reason) || null,
    trustScore: clamp012(asNumber(raw.trustScore ?? raw.trust_score, 0)),
    freshnessScore: clamp012(asNumber(raw.freshnessScore ?? raw.freshness_score, 0.5)),
    sampleCount: Math.max(0, Math.floor(asNumber(raw.sampleCount ?? raw.sample_count, 0)))
  };
}
function applySourceCurationToPatterns(patterns, sourceInsights) {
  const normalizedInsights = sourceInsights.map((entry) => normalizeSourceCurationInsight(entry)).filter((entry) => Boolean(entry));
  const insightBySourceKey = new Map;
  const insightByFingerprint = new Map;
  for (const insight of normalizedInsights) {
    if (insight.sourceKey)
      insightBySourceKey.set(insight.sourceKey, insight);
    if (insight.sourceFingerprint)
      insightByFingerprint.set(insight.sourceFingerprint, insight);
  }
  const curated = patterns.map((pattern) => {
    const insight = insightBySourceKey.get(pattern.sourceKey) ?? insightByFingerprint.get(pattern.fingerprint);
    if (!insight) {
      if (pattern.sourceCurationStatus === "archived")
        return null;
      return pattern;
    }
    const trustScore = clamp012(asNumber(insight.trustScore, pattern.sourceTrustScore));
    const freshnessScore = clamp012(asNumber(insight.freshnessScore, pattern.freshnessScore));
    const nextStatus = insight.curationStatus;
    if (nextStatus === "archived")
      return null;
    const nextMetadata = {
      ...pattern.metadata,
      source_key: pattern.sourceKey,
      source_curation_status: nextStatus,
      source_curation_reason: insight.curationReason,
      source_trust_score: trustScore
    };
    const qualityScore = nextStatus === "trusted" ? clamp012(Math.max(pattern.qualityScore, 0.68 + 0.24 * trustScore)) : nextStatus === "watchlist" ? clamp012(Math.min(pattern.qualityScore, 0.6 * pattern.qualityScore + 0.4 * trustScore)) : clamp012(0.72 * pattern.qualityScore + 0.28 * trustScore);
    return {
      ...pattern,
      qualityScore,
      freshnessScore: Math.max(pattern.freshnessScore, freshnessScore),
      sourceCurationStatus: nextStatus,
      sourceCurationReason: insight.curationReason,
      sourceTrustScore: trustScore,
      metadata: nextMetadata
    };
  }).filter((entry) => Boolean(entry));
  const statusPriority = {
    trusted: 0,
    candidate: 1,
    watchlist: 2,
    archived: 3
  };
  return curated.sort((a, b) => {
    const pA = statusPriority[a.sourceCurationStatus];
    const pB = statusPriority[b.sourceCurationStatus];
    if (pA !== pB)
      return pA - pB;
    const signalA = 0.52 * a.qualityScore + 0.28 * a.freshnessScore + 0.2 * a.sourceTrustScore;
    const signalB = 0.52 * b.qualityScore + 0.28 * b.freshnessScore + 0.2 * b.sourceTrustScore;
    return signalB - signalA;
  });
}
function buildCandidateShapeFromPattern(params) {
  const pattern = params.pattern;
  const text = `${pattern.algorithm}
${pattern.whenToUse}
${pattern.summary}
${pattern.tags.join(" ")}`.toLowerCase();
  const metadata = pattern.metadata;
  const metadataShape = asObject(metadata.candidate_shape ?? metadata.candidateShape);
  const metadataArea = asAutonomyComponentArea(metadataShape.component_area ?? metadataShape.componentArea ?? metadata.component_area ?? metadata.componentArea) ?? null;
  const triggerTypeRaw = asString2(metadataShape.trigger_type ?? metadataShape.triggerType ?? metadata.trigger_type);
  const triggerType = isTriggerType(triggerTypeRaw) ? triggerTypeRaw : inferTriggerTypeFromText(text);
  const componentArea = metadataArea ?? inferComponentAreaFromText(text, params.repoTargets, triggerType);
  const defaults = defaultCandidateShapeForArea(componentArea);
  const objectiveType = asAutonomyObjectiveType(metadataShape.objective_type ?? metadataShape.objectiveType ?? metadata.objective_type) ?? inferObjectiveTypeFromText(text, pattern.tags) ?? defaults.objective_type;
  const riskRaw = asString2(metadataShape.risk_level ?? metadataShape.riskLevel ?? metadata.risk_level);
  const riskLevel = isRiskLevel(riskRaw) ? riskRaw : inferRiskLevelFromText(text, pattern.tags);
  const targetPaths = asStringArray2(metadataShape.target_paths ?? metadataShape.targetPaths ?? metadata.target_paths);
  const writeGlobs = asStringArray2(metadataShape.write_globs ?? metadataShape.writeGlobs ?? metadata.write_globs);
  const validationIdeas = asStringArray2(metadataShape.expected_validation ?? metadataShape.expectedValidation ?? metadata.expected_validation ?? pattern.validationIdeas);
  const scopeCheck = validateScopeInvariants(componentArea, targetPaths.length > 0 ? targetPaths : defaults.target_paths, writeGlobs.length > 0 ? writeGlobs : defaults.write_globs, { requireWriteGlobs: true });
  return adaptCandidateShapeToRepo({
    shape: {
      objective_type: objectiveType,
      trigger_type: triggerType,
      component_area: scopeCheck.componentArea ?? componentArea,
      target_paths: scopeCheck.ok ? scopeCheck.normalizedTargetPaths : defaults.target_paths,
      write_globs: scopeCheck.ok ? scopeCheck.normalizedWriteGlobs : defaults.write_globs,
      risk_level: riskLevel,
      expected_validation: normalizeValidationIdeas(validationIdeas)
    },
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets,
    hints: [
      pattern.algorithm,
      pattern.whenToUse,
      pattern.summary,
      pattern.sourceLabel ?? "",
      pattern.sourceType,
      ...pattern.tags,
      ...pattern.sourceRefs
    ]
  });
}
function buildExternalInspirationBlocks(params) {
  const objectiveWeightById = new Map(params.compiledObjectives.map((entry) => [entry.id, entry.weight]));
  const gapScoreById = new Map(params.opportunityGaps.map((entry) => [entry.id, entry.score]));
  return params.patterns.map((pattern) => {
    const text = `${pattern.algorithm}
${pattern.whenToUse}
${pattern.summary}
${pattern.tags.join(" ")}`;
    const objectiveIds = matchObjectiveIdsFromText(text, params.compiledObjectives);
    const gapIds = matchGapIdsFromText(text, params.opportunityGaps);
    const candidateShape = buildCandidateShapeFromPattern({
      pattern,
      repoRoot: params.repoRoot,
      repoTargets: params.repoTargets
    });
    const objectiveSignal = clamp012(average(objectiveIds.map((id) => objectiveWeightById.get(id) ?? 0).filter((value) => Number.isFinite(value))));
    const gapSignal = clamp012(Math.max(0, ...gapIds.map((id) => gapScoreById.get(id) ?? 0).filter((value) => Number.isFinite(value))));
    const sourceSignal = clamp012(0.42 * pattern.qualityScore + 0.3 * pattern.freshnessScore + 0.12 * pattern.sourceTrustScore + 0.16 * clamp012(Math.log1p(pattern.seenCount) / Math.log1p(12)));
    const curationAdjustment = pattern.sourceCurationStatus === "trusted" ? 0.12 + 0.06 * pattern.sourceTrustScore : pattern.sourceCurationStatus === "watchlist" ? -0.08 : 0;
    const recentTypeCount = Math.max(0, Math.floor(asNumber(params.dispatchByType[candidateShape.objective_type], 0)));
    const noveltySignal = clamp012(1 - recentTypeCount / 6);
    const score = clamp012(0.42 * objectiveSignal + 0.28 * gapSignal + 0.22 * sourceSignal + curationAdjustment + 0.16 * noveltySignal - 0.08 * params.dispatchSaturation);
    const sourceLabel = pattern.sourceLabel ? `source=${pattern.sourceLabel}` : `source=${pattern.sourceType}`;
    return {
      id: `insp_${pattern.fingerprint.slice(0, 12)}`,
      algorithm: pattern.algorithm,
      summary: pattern.summary,
      hypothesis: `Apply ${pattern.algorithm} when ${pattern.whenToUse}. ` + `Adapt the idea to the active repo constraints; avoid direct code copying.`,
      objective_ids: objectiveIds,
      gap_ids: gapIds,
      score,
      evidence: [
        `objective_signal=${objectiveSignal.toFixed(2)}`,
        `gap_signal=${gapSignal.toFixed(2)}`,
        `source_signal=${sourceSignal.toFixed(2)}`,
        `source_curation=${pattern.sourceCurationStatus}`,
        `source_trust=${pattern.sourceTrustScore.toFixed(2)}`,
        `novelty_signal=${noveltySignal.toFixed(2)}`,
        sourceLabel,
        ...pattern.sourceRefs.slice(0, 2).map((ref) => `ref=${ref}`) ?? []
      ],
      candidate_shape: candidateShape,
      source_type: pattern.sourceType,
      source_label: pattern.sourceLabel,
      source_url: pattern.sourceUrl,
      source_refs: pattern.sourceRefs,
      source_fingerprint: pattern.fingerprint,
      source_curation_status: pattern.sourceCurationStatus,
      source_curation_reason: pattern.sourceCurationReason,
      source_trust_score: pattern.sourceTrustScore,
      source_freshness_score: pattern.freshnessScore
    };
  }).sort((a, b) => b.score - a.score);
}
function summarizeCommitHistoryHints(subjects) {
  const normalizedSubjects = subjects.map((entry) => asString2(entry)).filter(Boolean).slice(0, 240);
  if (normalizedSubjects.length === 0)
    return [];
  const denominator = Math.max(6, Math.min(24, normalizedSubjects.length));
  const hints = [];
  for (const rule of COMMIT_MOTIF_RULES) {
    const matches = normalizedSubjects.filter((subject) => rule.pattern.test(subject));
    if (matches.length === 0)
      continue;
    hints.push({
      motif_id: rule.motifId,
      label: rule.label,
      count: matches.length,
      signal: clamp012(matches.length / denominator),
      objective_ids: [...rule.objectiveIds],
      gap_ids: [...rule.gapIds],
      sample_subjects: matches.slice(0, 3)
    });
  }
  return hints.sort((a, b) => {
    if (b.signal !== a.signal)
      return b.signal - a.signal;
    return b.count - a.count;
  });
}
function buildCommitHistoryBlocks(params) {
  const objectiveWeightById = new Map(params.compiledObjectives.map((entry) => [entry.id, entry.weight]));
  const gapScoreById = new Map(params.opportunityGaps.map((entry) => [entry.id, entry.score]));
  return params.hints.slice(0, 6).map((hint) => {
    const rule = COMMIT_MOTIF_RULES.find((entry) => entry.motifId === hint.motif_id);
    if (!rule)
      return null;
    const candidateShape = adaptCandidateShapeToRepo({
      shape: rule.shape,
      repoRoot: params.repoRoot,
      repoTargets: params.repoTargets,
      hints: [hint.label, ...hint.sample_subjects]
    });
    const objectiveSignal = clamp012(average(hint.objective_ids.map((id) => objectiveWeightById.get(id) ?? 0).filter((value) => Number.isFinite(value))));
    const gapSignal = clamp012(Math.max(0, ...hint.gap_ids.map((id) => gapScoreById.get(id) ?? 0).filter((value) => Number.isFinite(value))));
    const recentTypeCount = Math.max(0, Math.floor(asNumber(params.dispatchByType[candidateShape.objective_type], 0)));
    const noveltySignal = clamp012(1 - recentTypeCount / 6);
    const score = clamp012(0.4 * objectiveSignal + 0.28 * gapSignal + 0.22 * hint.signal + 0.16 * noveltySignal - 0.08 * params.dispatchSaturation);
    return {
      id: `history_${hint.motif_id}`,
      algorithm: `commit_history_${hint.motif_id}`,
      summary: `Local commit history repeatedly touches: ${hint.label.toLowerCase()}.`,
      hypothesis: `Bias autonomous idea generation toward ${hint.label.toLowerCase()} motifs seen locally ` + `to improve merge conversion and delivery reliability.`,
      objective_ids: hint.objective_ids,
      gap_ids: hint.gap_ids,
      score,
      evidence: [
        `motif_count=${hint.count}`,
        `motif_signal=${hint.signal.toFixed(2)}`,
        `objective_signal=${objectiveSignal.toFixed(2)}`,
        `gap_signal=${gapSignal.toFixed(2)}`,
        ...hint.sample_subjects.map((subject) => `commit=${subject}`)
      ],
      candidate_shape: candidateShape
    };
  }).filter((entry) => Boolean(entry)).sort((a, b) => b.score - a.score);
}
function buildEngineInspirationContext(params) {
  const oneSentence = asString2(params.vision.one_sentence);
  const keyItems = params.vision.key_items;
  const compiledObjectives = ENGINE_OBJECTIVE_BLUEPRINTS.map((blueprint) => {
    const lines = bucketLines(keyItems, blueprint.buckets);
    const evidence = keywordEvidence(lines, blueprint.keywordPattern);
    const lineHitSignal = clamp012(evidence.length / 4);
    const oneSentenceBoost = blueprint.keywordPattern.test(oneSentence) ? 0.08 : 0;
    const weight = clamp012(blueprint.baseWeight + lineHitSignal * 0.3 + oneSentenceBoost);
    return {
      id: blueprint.id,
      title: blueprint.title,
      weight,
      evidence
    };
  }).sort((a, b) => b.weight - a.weight);
  const failureSignal = maxSignalScore(params.snapshot, [
    "test_failure",
    "lint_failure",
    "typecheck_failure"
  ]);
  const queueSignal = maxSignalScore(params.snapshot, ["queue_health"]);
  const regretSignal = maxSignalScore(params.snapshot, ["regret_signal"]);
  const reliabilityTrait = maxTraitScore(params.snapshot, /\b(reliab|stability|startup|failure|flake|retry|incident|runtime|preflight)\b/i);
  const mergeTrait = maxTraitScore(params.snapshot, /\b(merge|review|pr|pull request|conflict|rework|comment)\b/i);
  const activationTrait = maxTraitScore(params.snapshot, /\b(activation|onboard|first pr|quickstart|setup|time-to-first)\b/i);
  const governanceTrait = maxTraitScore(params.snapshot, /\b(policy|permission|scope|guardrail|audit|security|compliance|risk)\b/i);
  const workforceTrait = maxTraitScore(params.snapshot, /\b(worker|delegation|dispatch|specialist|capability|throughput|queue)\b/i);
  const openObjectivePressure = clamp012(params.snapshot.open_objectives.length / 10);
  const dispatchSaturation = clamp012(params.snapshot.dispatch_budget.global_count_last_hour / 10);
  const opportunityGaps = [
    {
      id: "delivery_reliability_gap",
      label: "Delivery reliability gap",
      score: clamp012(0.5 * failureSignal + 0.25 * reliabilityTrait + 0.15 * queueSignal + 0.1 * regretSignal),
      evidence: [
        `failure_signal=${failureSignal.toFixed(2)}`,
        `reliability_trait=${reliabilityTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`
      ]
    },
    {
      id: "merge_rework_gap",
      label: "Merge/rework gap",
      score: clamp012(0.45 * regretSignal + 0.35 * mergeTrait + 0.2 * openObjectivePressure),
      evidence: [
        `regret_signal=${regretSignal.toFixed(2)}`,
        `merge_trait=${mergeTrait.toFixed(2)}`,
        `open_objective_pressure=${openObjectivePressure.toFixed(2)}`
      ]
    },
    {
      id: "activation_gap",
      label: "Activation/onboarding gap",
      score: clamp012(0.5 * activationTrait + 0.3 * queueSignal + 0.2 * dispatchSaturation),
      evidence: [
        `activation_trait=${activationTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`
      ]
    },
    {
      id: "governance_gap",
      label: "Governance guardrail gap",
      score: clamp012(0.6 * governanceTrait + 0.2 * regretSignal + 0.2 * dispatchSaturation),
      evidence: [
        `governance_trait=${governanceTrait.toFixed(2)}`,
        `regret_signal=${regretSignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`
      ]
    },
    {
      id: "workforce_throughput_gap",
      label: "Workforce throughput gap",
      score: clamp012(0.35 * workforceTrait + 0.35 * queueSignal + 0.3 * openObjectivePressure),
      evidence: [
        `workforce_trait=${workforceTrait.toFixed(2)}`,
        `queue_signal=${queueSignal.toFixed(2)}`,
        `open_objective_pressure=${openObjectivePressure.toFixed(2)}`
      ]
    }
  ].sort((a, b) => b.score - a.score);
  const objectiveWeightById = new Map(compiledObjectives.map((entry) => [entry.id, entry.weight]));
  const gapScoreById = new Map(opportunityGaps.map((entry) => [entry.id, entry.score]));
  const dispatchByType = params.snapshot.dispatch_budget.by_type_count_last_hour ?? {};
  const staticBuildingBlocks = ENGINE_IDEA_BLUEPRINTS.map((blueprint) => {
    const candidateShape = adaptCandidateShapeToRepo({
      shape: blueprint.candidate_shape,
      repoRoot: params.repoRoot,
      repoTargets: params.repoTargets,
      hints: [
        blueprint.algorithm,
        blueprint.summary,
        blueprint.hypothesis,
        ...blueprint.objective_ids,
        ...blueprint.gap_ids
      ]
    });
    const objectiveWeights = blueprint.objective_ids.map((id) => objectiveWeightById.get(id) ?? 0).filter((value) => Number.isFinite(value));
    const gapScores = blueprint.gap_ids.map((id) => gapScoreById.get(id) ?? 0).filter((value) => Number.isFinite(value));
    const objectiveSignal = clamp012(average(objectiveWeights));
    const gapSignal = clamp012(Math.max(0, ...gapScores));
    const recentTypeCount = Math.max(0, Math.floor(asNumber(dispatchByType[candidateShape.objective_type], 0)));
    const noveltySignal = clamp012(1 - recentTypeCount / 6);
    const score = clamp012(0.52 * objectiveSignal + 0.33 * gapSignal + 0.2 * noveltySignal - 0.08 * dispatchSaturation);
    return {
      ...blueprint,
      candidate_shape: candidateShape,
      score,
      evidence: [
        `objective_signal=${objectiveSignal.toFixed(2)}`,
        `gap_signal=${gapSignal.toFixed(2)}`,
        `novelty_signal=${noveltySignal.toFixed(2)}`,
        `dispatch_saturation=${dispatchSaturation.toFixed(2)}`
      ]
    };
  });
  const normalizedPatterns = (Array.isArray(params.inspirationPatterns) ? params.inspirationPatterns : []).map((entry) => normalizeInspirationPattern(entry)).filter((entry) => Boolean(entry));
  const sourceInsights = Array.isArray(params.sourceInsights) ? params.sourceInsights : [];
  const curatedPatterns = applySourceCurationToPatterns(normalizedPatterns, sourceInsights).slice(0, 80);
  const sourcePatterns = curatedPatterns.map((pattern) => ({
    id: pattern.id,
    source_type: pattern.sourceType,
    source_label: pattern.sourceLabel,
    source_url: pattern.sourceUrl,
    source_refs: pattern.sourceRefs,
    algorithm: pattern.algorithm,
    when_to_use: pattern.whenToUse,
    summary: pattern.summary,
    tags: pattern.tags,
    quality_score: pattern.qualityScore,
    freshness_score: pattern.freshnessScore,
    seen_count: pattern.seenCount,
    source_curation_status: pattern.sourceCurationStatus,
    source_curation_reason: pattern.sourceCurationReason,
    source_trust_score: pattern.sourceTrustScore
  }));
  const externalBlocks = buildExternalInspirationBlocks({
    patterns: curatedPatterns,
    compiledObjectives,
    opportunityGaps,
    dispatchByType,
    dispatchSaturation,
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets
  });
  const commitHistoryHints = Array.isArray(params.commitHistoryHints) ? params.commitHistoryHints.slice(0, 10) : [];
  const historyBlocks = buildCommitHistoryBlocks({
    hints: commitHistoryHints,
    compiledObjectives,
    opportunityGaps,
    dispatchByType,
    dispatchSaturation,
    repoRoot: params.repoRoot,
    repoTargets: params.repoTargets
  });
  const buildingBlockMap = new Map;
  for (const block of [...staticBuildingBlocks, ...externalBlocks, ...historyBlocks]) {
    if (!buildingBlockMap.has(block.id)) {
      buildingBlockMap.set(block.id, block);
      continue;
    }
    const existing = buildingBlockMap.get(block.id);
    if (!existing || block.score > existing.score) {
      buildingBlockMap.set(block.id, block);
    }
  }
  const buildingBlocks = [...buildingBlockMap.values()].sort((a, b) => b.score - a.score);
  return {
    compiled_objectives: compiledObjectives,
    opportunity_gaps: opportunityGaps,
    building_blocks: buildingBlocks,
    source_patterns: sourcePatterns,
    commit_history_hints: commitHistoryHints
  };
}
function selectVisionSectionRefs(sectionRefs) {
  const preferred = ["6", "7", "8", "4", "3", "0", "5"];
  const normalized = sectionRefs.map((value) => asString2(value)).filter(Boolean);
  const selected = preferred.filter((value) => normalized.includes(value)).slice(0, 2);
  if (selected.length > 0)
    return selected;
  return normalized.slice(0, 2);
}
function pickSignalIdsForTrigger(topSignals, triggerType) {
  const exact = topSignals.filter((signal) => asString2(signal.type) === triggerType).map((signal) => asString2(signal.signal_id)).filter(Boolean);
  if (exact.length > 0)
    return exact.slice(0, 3);
  const fallback = topSignals.filter((signal) => {
    const type = asString2(signal.type);
    return type === "queue_health" || type === "regret_signal" || type === "test_failure";
  }).map((signal) => asString2(signal.signal_id)).filter(Boolean);
  return fallback.slice(0, 3);
}
function normalizeEngineTrialMetadata(value) {
  const raw = asObject(value);
  const buildingBlockId = asString2(raw.building_block_id ?? raw.buildingBlockId ?? raw.block_id ?? raw.blockId ?? raw.engine_building_block_id);
  if (!buildingBlockId)
    return;
  const sourceRaw = asString2(raw.source).toLowerCase();
  const source = sourceRaw === "engine_fallback" || sourceRaw === "engine_mapped" ? sourceRaw : "llm";
  const score = Number.isFinite(asNumber(raw.score, Number.NaN)) ? asNumber(raw.score, 0) : undefined;
  const sourceType = asString2(raw.source_type ?? raw.sourceType);
  const sourceLabel = asString2(raw.source_label ?? raw.sourceLabel);
  const sourceUrl = asString2(raw.source_url ?? raw.sourceUrl);
  const sourceFingerprint = asString2(raw.source_fingerprint ?? raw.sourceFingerprint);
  const sourceKey = asString2(raw.source_key ?? raw.sourceKey) || deriveInspirationSourceKey({
    sourceFingerprint,
    sourceType,
    sourceLabel,
    sourceUrl
  });
  return {
    building_block_id: buildingBlockId,
    algorithm: asString2(raw.algorithm) || "engine_building_block",
    source,
    ...typeof score === "number" ? { score } : {},
    objective_ids: asStringArray2(raw.objective_ids ?? raw.objectiveIds),
    gap_ids: asStringArray2(raw.gap_ids ?? raw.gapIds ?? raw.opportunity_gap_ids),
    ...sourceKey ? { source_key: sourceKey } : {},
    ...sourceType ? { source_type: sourceType } : {},
    ...sourceLabel ? { source_label: sourceLabel } : {},
    ...sourceUrl ? { source_url: sourceUrl } : {},
    ...sourceFingerprint ? { source_fingerprint: sourceFingerprint } : {},
    summary: asString2(raw.summary) || undefined,
    hypothesis: asString2(raw.hypothesis) || undefined
  };
}
function inferEngineTrialFromCandidate(candidate, engineInspiration) {
  const exact = engineInspiration.building_blocks.find((block) => block.candidate_shape.objective_type === candidate.objective_type && block.candidate_shape.trigger_type === candidate.trigger_type && block.candidate_shape.component_area === candidate.component_area);
  const fallback = exact ?? engineInspiration.building_blocks.find((block) => block.candidate_shape.objective_type === candidate.objective_type && block.candidate_shape.component_area === candidate.component_area) ?? engineInspiration.building_blocks.find((block) => block.candidate_shape.objective_type === candidate.objective_type);
  if (!fallback)
    return;
  const sourceKey = deriveInspirationSourceKey({
    sourceFingerprint: fallback.source_fingerprint,
    sourceType: fallback.source_type,
    sourceLabel: fallback.source_label,
    sourceUrl: fallback.source_url
  });
  return {
    building_block_id: fallback.id,
    algorithm: fallback.algorithm,
    source: "engine_mapped",
    score: fallback.score,
    objective_ids: fallback.objective_ids,
    gap_ids: fallback.gap_ids,
    ...sourceKey ? { source_key: sourceKey } : {},
    ...fallback.source_type ? { source_type: fallback.source_type } : {},
    ...fallback.source_label ? { source_label: fallback.source_label } : {},
    ...fallback.source_url ? { source_url: fallback.source_url } : {},
    ...fallback.source_fingerprint ? { source_fingerprint: fallback.source_fingerprint } : {},
    summary: fallback.summary,
    hypothesis: fallback.hypothesis
  };
}
function buildEngineFallbackCandidates(params) {
  const maxCandidates = Number.isFinite(params.maxCandidates) ? Math.max(1, Math.min(6, Math.floor(params.maxCandidates))) : 3;
  const objectiveTitleById = new Map(params.engineInspiration.compiled_objectives.map((objective) => [
    objective.id,
    objective.title
  ]));
  const sectionRefs = selectVisionSectionRefs(params.visionSectionRefs);
  return params.engineInspiration.building_blocks.filter((block) => block.score >= 0.42).slice(0, maxCandidates).map((block, idx) => {
    const candidateShape = adaptCandidateShapeToRepo({
      shape: block.candidate_shape,
      repoRoot: params.repoRoot,
      repoTargets: params.repoTargets,
      hints: [block.algorithm, block.summary, block.hypothesis, ...block.evidence]
    });
    const signalIds = pickSignalIdsForTrigger(params.snapshotTopSignals, block.candidate_shape.trigger_type);
    const objectiveTitles = block.objective_ids.map((id) => objectiveTitleById.get(id)).filter((value) => typeof value === "string" && value.length > 0).slice(0, 3);
    const primaryObjectiveTitle = objectiveTitles[0] ?? "vision priorities";
    const sourceAttribution = block.source_label || block.source_type ? `Source inspiration: ${block.source_label ?? block.source_type}.` : "";
    const sourceCurationNote = block.source_curation_status && block.source_curation_status !== "candidate" ? `Source curation: ${block.source_curation_status}${block.source_curation_reason ? ` (${block.source_curation_reason})` : ""}.` : "";
    const sourceKey = deriveInspirationSourceKey({
      sourceFingerprint: block.source_fingerprint,
      sourceType: block.source_type,
      sourceLabel: block.source_label,
      sourceUrl: block.source_url
    });
    return {
      id: `cand_engine_${block.id}_${randomUUID().slice(0, 8)}`,
      title: `Engine building block: ${block.algorithm}`,
      objective_type: candidateShape.objective_type,
      problem_statement: `Implement ${block.algorithm} in the active repo autonomy loop to improve ${primaryObjectiveTitle}. ` + `Deliver a small, test-backed change with clear operational telemetry.`,
      trigger_type: candidateShape.trigger_type,
      component_area: candidateShape.component_area,
      target_paths: candidateShape.target_paths,
      scope: {
        read_anywhere: false,
        write_globs: candidateShape.write_globs
      },
      risk_level: candidateShape.risk_level,
      expected_validation: candidateShape.expected_validation,
      estimated_effort: idx === 0 ? "small" : "medium",
      why_now_signal_ids: signalIds,
      confidence: clamp012(0.45 + block.score * 0.5),
      vision_alignment_reason: `Prioritize ${primaryObjectiveTitle} using ${block.algorithm}; score=${block.score.toFixed(2)}.`,
      vision_section_refs: sectionRefs,
      feature_hypotheses: [
        block.summary,
        block.hypothesis,
        ...sourceAttribution ? [sourceAttribution] : [],
        ...sourceCurationNote ? [sourceCurationNote] : [],
        `Add measurable telemetry and guardrails for ${block.algorithm}.`
      ].slice(0, 3),
      engine_trial: {
        building_block_id: block.id,
        algorithm: block.algorithm,
        source: "engine_fallback",
        score: block.score,
        objective_ids: block.objective_ids,
        gap_ids: block.gap_ids,
        ...sourceKey ? { source_key: sourceKey } : {},
        ...block.source_type ? { source_type: block.source_type } : {},
        ...block.source_label ? { source_label: block.source_label } : {},
        ...block.source_url ? { source_url: block.source_url } : {},
        ...block.source_fingerprint ? { source_fingerprint: block.source_fingerprint } : {},
        summary: block.summary,
        hypothesis: block.hypothesis
      },
      requires_user_input: false,
      question_if_blocked: ""
    };
  });
}
function asBoolean2(value, fallback = false) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text))
      return true;
    if (["0", "false", "no", "off"].includes(text))
      return false;
  }
  return fallback;
}
function clamp012(value) {
  if (!Number.isFinite(value))
    return 0;
  if (value <= 0)
    return 0;
  if (value >= 1)
    return 1;
  return value;
}
function parseJsonObject(text) {
  const raw = text.trim();
  if (!raw)
    return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
      try {
        return asObject(JSON.parse(fenced));
      } catch {
        return {};
      }
    }
    return {};
  }
}
function sha256(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function isRiskLevel(value) {
  return value === "low" || value === "medium" || value === "high";
}
function isTriggerType(value) {
  return value === "test_failure" || value === "lint_failure" || value === "typecheck_failure" || value === "queue_health" || value === "regret_signal";
}
async function withTimeout(promise, timeoutMs, reason) {
  const timeout = Math.max(1000, timeoutMs);
  const timeoutError = new Error(reason);
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeout);
  });
  try {
    return await Promise.race([promise, timed]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
async function gitOutput(repo, args) {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0)
    return "";
  return stdout.trim();
}
function sanitizeForGitRef(value) {
  const text = value.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return text || "default";
}
async function repoPreflight(repo) {
  const porcelain = await gitOutput(repo, ["status", "--porcelain"]);
  const mergeHead = await gitOutput(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  return {
    isWorktreeDirty: Boolean(porcelain),
    isMergeInProgress: Boolean(mergeHead)
  };
}

class RemoteBuddyAutonomousEngine {
  server;
  sessionId;
  authToken;
  repoRoot;
  autonomyRepo;
  autonomyBranch;
  gitRemote;
  integrationBranch;
  baseBranch;
  llm;
  comm;
  llmCfg;
  cfg;
  runtimeEnabled = true;
  timer = null;
  heartbeatTimer = null;
  inFlight = false;
  nextTickAtMs = 0;
  currentRunId = null;
  currentPhase = "idle";
  currentPhaseStartedAtMs = 0;
  currentRunStartedAtMs = 0;
  lastOutcome = "none";
  lastDetail = "not_started";
  lastCompletedAtMs = 0;
  pendingIdeationTimeoutRecovery = null;
  constructor(opts) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.repoRoot = opts.repo;
    const safeSession = sanitizeForGitRef(this.sessionId).slice(0, 40);
    this.autonomyRepo = resolve4(this.repoRoot, ".worktrees", `remotebuddy-autonomy-${safeSession}`);
    this.autonomyBranch = `_remotebuddy/autonomy-${safeSession}`;
    this.gitRemote = String(opts.config.sourceControlManager.remote || "origin").trim() || "origin";
    this.integrationBranch = String(opts.config.sourceControlManager.mainBranch || "main_agents").trim() || "main_agents";
    this.baseBranch = String(opts.config.sourceControlManager.baseBranch || "main").trim() || "main";
    this.llm = opts.llm;
    this.comm = opts.comm;
    this.llmCfg = opts.config.remotebuddy.llm;
    this.cfg = opts.config.remotebuddy.autonomy;
    this.runtimeEnabled = this.cfg.enabled;
  }
  setRuntimeEnabled(enabled) {
    this.runtimeEnabled = Boolean(enabled);
    if (!this.runtimeEnabled) {
      this.nextTickAtMs = 0;
      if (!this.currentRunId) {
        this.lastOutcome = "skipped";
        this.lastDetail = "disabled_by_runtime_config";
        this.lastCompletedAtMs = Date.now();
        this.setPhase("idle");
      }
    }
  }
  setPhase(phase) {
    this.currentPhase = phase;
    this.currentPhaseStartedAtMs = Date.now();
  }
  markTickStart(runId) {
    const now = Date.now();
    this.currentRunId = runId;
    this.currentRunStartedAtMs = now;
    this.setPhase("acquire_lock");
  }
  markTickDone(outcome, detail) {
    this.currentRunId = null;
    this.currentRunStartedAtMs = 0;
    this.lastOutcome = outcome;
    this.lastDetail = detail || "unspecified";
    this.lastCompletedAtMs = Date.now();
    this.setPhase("idle");
  }
  logHeartbeat() {
    if (!this.runtimeEnabled)
      return;
    const now = Date.now();
    if (this.currentRunId) {
      const runElapsedMs = Math.max(0, now - this.currentRunStartedAtMs);
      const phaseElapsedMs = Math.max(0, now - this.currentPhaseStartedAtMs);
      console.log(`[RemoteBuddyAutonomousEngine] heartbeat: status=running run=${this.currentRunId} phase=${this.currentPhase} run_elapsed_ms=${runElapsedMs} phase_elapsed_ms=${phaseElapsedMs}`);
      return;
    }
    const nextTickInMs = this.timer && this.nextTickAtMs > 0 ? Math.max(0, this.nextTickAtMs - now) : 0;
    const lastAgeMs = this.lastCompletedAtMs > 0 ? Math.max(0, now - this.lastCompletedAtMs) : -1;
    console.log(`[RemoteBuddyAutonomousEngine] heartbeat: status=idle last_outcome=${this.lastOutcome} detail=${this.lastDetail} last_tick_age_ms=${lastAgeMs} next_tick_in_ms=${nextTickInMs}`);
  }
  headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.authToken)
      headers.Authorization = `Bearer ${this.authToken}`;
    return headers;
  }
  lockTtlMs() {
    const maxPhaseTimeoutMs = Math.max(this.phaseTimeoutMs("ideation"), this.phaseTimeoutMs("scoring"), this.phaseTimeoutMs("planning"));
    return Math.max(this.cfg.tickIntervalMs * 3, this.cfg.ideationBudgetMs * 2 + maxPhaseTimeoutMs * 6, 30000);
  }
  cycleBudgetMs() {
    const ideationTimeoutMs = this.phaseTimeoutMs("ideation");
    const scoringTimeoutMs = this.phaseTimeoutMs("scoring");
    const planningTimeoutMs = this.phaseTimeoutMs("planning");
    const maxPhaseTimeoutMs = Math.max(ideationTimeoutMs, scoringTimeoutMs, planningTimeoutMs);
    return Math.max(this.cfg.ideationBudgetMs + ideationTimeoutMs + scoringTimeoutMs + planningTimeoutMs, maxPhaseTimeoutMs * 4, 20000);
  }
  phaseTimeoutMs(phase) {
    const configuredTimeoutMs = Math.max(1000, this.cfg.llmTimeoutMs);
    if (phase !== "ideation")
      return configuredTimeoutMs;
    if (String(this.llmCfg.backend || "").trim().toLowerCase() !== "openai_codex") {
      return configuredTimeoutMs;
    }
    const codexTimeoutMs2 = Math.max(configuredTimeoutMs, this.llmCfg.codexTimeoutMs || 0);
    return Math.min(codexTimeoutMs2, Math.max(configuredTimeoutMs, 90000));
  }
  consumeIdeationTimeoutRecovery() {
    const recovery = this.pendingIdeationTimeoutRecovery;
    this.pendingIdeationTimeoutRecovery = null;
    return recovery;
  }
  loadVisionContext(runId) {
    const maxVisionContextChars = this.cfg.visionContextMaxChars;
    let raw = "";
    try {
      raw = loadRepoDocText(VISION_DOC_FNAME);
    } catch (error) {
      console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: failed to read ${VISION_DOC_FNAME}: ${String(error)}`);
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: ${VISION_DOC_FNAME} is empty; autonomy ideation requires non-empty vision context.`);
      return null;
    }
    const truncated = trimmed.length > maxVisionContextChars;
    if (truncated) {
      console.log(`[RemoteBuddyAutonomousEngine] tick ${runId}: ${VISION_DOC_FNAME} exceeded ${maxVisionContextChars} chars; using first ${maxVisionContextChars} chars for ideation.`);
    }
    const parsed = parseVisionDoc(trimmed);
    const keyItems = extractVisionKeyItems(trimmed);
    const section_numbers = parsed.sections.map((section) => section.number);
    const sections = parsed.sections.map((section) => {
      const sectionMarkdown = section.markdown.trim();
      const sectionTruncated = sectionMarkdown.length > MAX_VISION_SECTION_CHARS;
      return {
        number: section.number,
        title: section.title,
        markdown: sectionTruncated ? sectionMarkdown.slice(0, MAX_VISION_SECTION_CHARS) : sectionMarkdown,
        truncated: sectionTruncated
      };
    });
    return {
      path: VISION_DOC_FNAME,
      markdown: truncated ? trimmed.slice(0, maxVisionContextChars) : trimmed,
      one_sentence: parsed.oneSentence,
      sections,
      key_items: {
        target_users: keyItems.targetUsers,
        priorities: keyItems.priorities,
        objectives: keyItems.objectives,
        guardrails: keyItems.guardrails,
        constraints: keyItems.constraints,
        non_goals: keyItems.nonGoals,
        metrics: keyItems.metrics,
        risk_policy: keyItems.riskPolicy,
        operating_model: keyItems.operatingModel,
        governance: keyItems.governance
      },
      section_numbers,
      sha256: sha256(trimmed),
      truncated
    };
  }
  async runGit(cwd, args) {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  }
  async ensureAutonomyRepoReady(runId) {
    const integrationRef = `${this.gitRemote}/${this.integrationBranch}`;
    const baseRef = `${this.gitRemote}/${this.baseBranch}`;
    const fetch2 = await this.runGit(this.repoRoot, [
      "fetch",
      this.gitRemote,
      this.integrationBranch,
      this.baseBranch
    ]);
    if (!fetch2.ok) {
      console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: failed to fetch refs for autonomy worktree (${this.gitRemote} ${this.integrationBranch}/${this.baseBranch}): ${fetch2.stderr || fetch2.stdout || `exit ${fetch2.exitCode}`}`);
      return false;
    }
    if (existsSync4(this.autonomyRepo)) {
      await this.runGit(this.repoRoot, ["worktree", "remove", "--force", this.autonomyRepo]);
      try {
        rmSync2(this.autonomyRepo, { recursive: true, force: true });
      } catch (error) {
        console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: failed to delete previous autonomy worktree ${this.autonomyRepo}: ${String(error)}`);
        return false;
      }
    }
    await this.runGit(this.repoRoot, ["worktree", "prune"]);
    await this.runGit(this.repoRoot, ["branch", "-D", this.autonomyBranch]);
    const parentDir = resolve4(this.autonomyRepo, "..");
    if (!existsSync4(parentDir))
      mkdirSync(parentDir, { recursive: true });
    const add = await this.runGit(this.repoRoot, [
      "worktree",
      "add",
      "-B",
      this.autonomyBranch,
      this.autonomyRepo,
      integrationRef
    ]);
    if (!add.ok) {
      console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: failed to create autonomy worktree at ${this.autonomyRepo}: ${add.stderr || add.stdout || `exit ${add.exitCode}`}`);
      return false;
    }
    const mergeMain = await this.runGit(this.autonomyRepo, ["merge", "--ff-only", baseRef]);
    if (!mergeMain.ok) {
      const resetBase = await this.runGit(this.autonomyRepo, ["reset", "--hard", baseRef]);
      if (!resetBase.ok) {
        console.error(`[RemoteBuddyAutonomousEngine] tick ${runId}: failed to sync autonomy worktree with ${baseRef}: ${mergeMain.stderr || mergeMain.stdout || `merge exit ${mergeMain.exitCode}`}; reset failed: ${resetBase.stderr || resetBase.stdout || `exit ${resetBase.exitCode}`}`);
        return false;
      }
      console.log(`[RemoteBuddyAutonomousEngine] tick ${runId}: ff-only merge ${baseRef} into ${integrationRef} was not possible; reset autonomy worktree to ${baseRef}.`);
    }
    return true;
  }
  async fetchSnapshot(runId, preflight) {
    const qs = new URLSearchParams({
      sessionId: this.sessionId,
      runId,
      isWorktreeDirty: preflight.isWorktreeDirty ? "true" : "false",
      isMergeInProgress: preflight.isMergeInProgress ? "true" : "false"
    });
    const res = await fetch(`${this.server}/autonomy/snapshot?${qs.toString()}`, {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok)
      return null;
    const data = await res.json();
    return data.ok ? data.snapshot ?? null : null;
  }
  async fetchWorkerLoadSnapshot() {
    try {
      const res = await fetch(`${this.server}/workers/autoscale?ttlMs=15000`, {
        method: "GET",
        headers: this.headers()
      });
      if (!res.ok)
        return null;
      const data = await res.json();
      if (!data.ok || !data.workers || !data.jobs)
        return null;
      return {
        workers: data.workers,
        jobs: data.jobs,
        prs: {
          openUnmerged: Math.max(0, Math.floor(asNumber(asObject(data.prs).openUnmerged, 0)))
        }
      };
    } catch {
      return null;
    }
  }
  deferReasonForWorkerLoad(snapshot) {
    const busyWorkers = Math.max(0, Math.floor(asNumber(snapshot.workers.busy, 0)));
    const pendingJobs = Math.max(0, Math.floor(asNumber(snapshot.jobs.pending, 0)));
    const autoscalablePending = Math.max(0, Math.floor(asNumber(snapshot.jobs.autoscalablePending, 0)));
    if (busyWorkers <= 0 && pendingJobs <= 0 && autoscalablePending <= 0) {
      return null;
    }
    return `worker_load_busy_${busyWorkers}_pending_${pendingJobs}_autoscalable_${autoscalablePending}`;
  }
  async fetchInspirationPatterns(limit = 60) {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(400, Math.floor(limit))))
    });
    const res = await fetch(`${this.server}/autonomy/inspiration?${qs.toString()}`, {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok)
      return [];
    const data = await res.json();
    return data.ok && Array.isArray(data.patterns) ? data.patterns : [];
  }
  async fetchInspirationSourceInsights(limit = 120) {
    const qs = new URLSearchParams({
      limit: String(Math.max(1, Math.min(400, Math.floor(limit)))),
      feedbackLimit: "1"
    });
    const res = await fetch(`${this.server}/autonomy/insights?${qs.toString()}`, {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok)
      return [];
    const data = await res.json();
    if (!data.ok)
      return [];
    const rows = Array.isArray(data.engineSourceStats) ? data.engineSourceStats : [];
    if (rows.length > 0)
      return rows;
    const trusted = Array.isArray(data.trustedInspirationShortlist) ? data.trustedInspirationShortlist : [];
    const archived = Array.isArray(data.archivedInspirationSources) ? data.archivedInspirationSources : [];
    return [...trusted, ...archived];
  }
  buildAutoInspirationEntries(commitHistoryHints) {
    const staticEntries = AUTO_INGEST_SEED_PATTERNS.map((seed) => ({
      source_type: "internal_doc",
      source_label: "pushpals:autonomy-engine",
      source_url: "",
      algorithm: seed.algorithm,
      when_to_use: seed.whenToUse,
      summary: seed.summary,
      risks: seed.risks,
      validation: seed.validation,
      tags: seed.tags,
      quality_score: seed.qualityScore,
      freshness_score: seed.freshnessScore,
      metadata: {
        origin: "autonomy_engine_seed"
      }
    }));
    const commitEntries = commitHistoryHints.slice(0, 8).map((hint) => ({
      source_type: "internal_doc",
      source_label: "pushpals:commit-history",
      source_url: "",
      algorithm: `commit_history_${hint.motif_id}`,
      when_to_use: `when local history repeatedly indicates ${hint.label.toLowerCase()}`,
      summary: `Local commit history shows recurring ${hint.label.toLowerCase()} motifs (${hint.count} hits). ` + "Bias ideas toward this motif while keeping scope small and testable.",
      risks: ["Historical bias can overweight past patterns over current needs."],
      validation: ["Verify motif-driven objectives improve acceptance and reduce reopen rate."],
      tags: ["local_history", "motif", "autonomy", hint.motif_id],
      quality_score: clamp012(0.52 + 0.35 * clamp012(hint.signal)),
      freshness_score: 0.7,
      metadata: {
        origin: "autonomy_engine_commit_history",
        motif_id: hint.motif_id,
        motif_count: hint.count,
        objective_ids: hint.objective_ids,
        gap_ids: hint.gap_ids,
        sample_subjects: hint.sample_subjects.slice(0, 3)
      }
    }));
    return [...staticEntries, ...commitEntries];
  }
  async ingestAutoInspirationPatterns(runId, commitHistoryHints) {
    const entries = this.buildAutoInspirationEntries(commitHistoryHints);
    if (entries.length === 0)
      return;
    try {
      const res = await fetch(`${this.server}/autonomy/inspiration/ingest`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ entries })
      });
      if (!res.ok) {
        console.warn(`[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest failed with HTTP ${res.status}.`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.ok === false) {
        console.warn(`[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest returned ok=false.`);
        return;
      }
      const inserted = Math.max(0, Math.floor(asNumber(data.inserted, 0)));
      const updated = Math.max(0, Math.floor(asNumber(data.updated, 0)));
      const skipped = Math.max(0, Math.floor(asNumber(data.skipped, 0)));
      console.log(`[RemoteBuddyAutonomousEngine] tick ${runId}: ingested inspiration seeds (inserted=${inserted} updated=${updated} skipped=${skipped}).`);
    } catch (error) {
      console.warn(`[RemoteBuddyAutonomousEngine] tick ${runId}: automatic inspiration ingest errored: ${String(error)}`);
    }
  }
  async loadCommitHistoryHints() {
    const raw = await gitOutput(this.autonomyRepo, ["log", "--pretty=format:%s", "-n", "180"]);
    if (!raw)
      return [];
    const subjects = raw.split(/\r?\n/g).map((line) => asString2(line)).filter(Boolean);
    return summarizeCommitHistoryHints(subjects).slice(0, 8);
  }
  async postObjective(payload) {
    const res = await fetch(`${this.server}/autonomy/objectives`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload)
    });
    return res.ok;
  }
  async acquireDispatchLock(runId) {
    const ttlMs = this.lockTtlMs();
    const res = await fetch(`${this.server}/autonomy/lock/acquire`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        ttlMs
      })
    });
    return res.ok;
  }
  async renewDispatchLock(runId) {
    const res = await fetch(`${this.server}/autonomy/lock/renew`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        ttlMs: this.lockTtlMs()
      })
    });
    return res.ok;
  }
  async releaseDispatchLock(runId) {
    await fetch(`${this.server}/autonomy/lock/release`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId
      })
    }).catch(() => {});
  }
  async llmPhase(phase, runId, snapshotId, input, objectiveId) {
    const timeoutMs = this.phaseTimeoutMs(phase);
    const requestPayload = {
      phase,
      system: input.system,
      messages: input.messages,
      json: Boolean(input.json),
      maxTokens: input.maxTokens ?? null,
      temperature: input.temperature ?? null
    };
    const systemChars = input.system.length;
    const messageChars = (input.messages ?? []).reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload), "utf8");
    const startedAt = Date.now();
    console.log(`[RemoteBuddyAutonomousEngine] ${phase} phase start: timeout_ms=${timeoutMs} system_chars=${systemChars} message_chars=${messageChars} request_bytes=${requestBytes} max_tokens=${input.maxTokens ?? "default"} temperature=${input.temperature ?? "default"}`);
    let output;
    try {
      output = await withTimeout(this.llm.generate(input), timeoutMs, `autonomy ${phase} phase timeout`);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (phase === "ideation" && error instanceof Error && error.message === "autonomy ideation phase timeout") {
        this.pendingIdeationTimeoutRecovery = {
          previousRunId: runId,
          timedOutAt: new Date().toISOString(),
          timeoutMs
        };
      }
      console.warn(`[RemoteBuddyAutonomousEngine] ${phase} phase failed: elapsed_ms=${elapsedMs} timeout_ms=${timeoutMs} system_chars=${systemChars} message_chars=${messageChars} request_bytes=${requestBytes} error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const responseJson = parseJsonObject(output.text);
    const tokenUsage = output.usage ?? null;
    const latencyMs = Date.now() - startedAt;
    console.log(`[RemoteBuddyAutonomousEngine] ${phase} phase completed: elapsed_ms=${latencyMs} timeout_ms=${timeoutMs} response_chars=${output.text.length} prompt_tokens=${tokenUsage?.promptTokens ?? "unknown"} completion_tokens=${tokenUsage?.completionTokens ?? "unknown"}`);
    return {
      json: responseJson,
      llmCall: {
        id: randomUUID(),
        runId,
        snapshotId,
        ...objectiveId ? { objectiveId } : {},
        phase,
        promptTemplateVersion: "autonomy-v3.3",
        promptHash: sha256(`${input.system}
${JSON.stringify(input.messages ?? [])}`),
        requestPayloadHash: sha256(JSON.stringify(requestPayload)),
        requestPayload,
        promptInputs: {
          system: input.system,
          messages: input.messages ?? []
        },
        modelId: "configured",
        temperature: input.temperature ?? null,
        timeoutMs,
        response: responseJson,
        responseHash: sha256(output.text),
        tokenUsage,
        latencyMs
      }
    };
  }
  async enqueueSyntheticRequest(instruction, autonomy) {
    if (!this.runtimeEnabled)
      return null;
    const canonicalInstruction = canonicalizeInstructionTextForBun(instruction);
    const res = await fetch(`${this.server}/requests/enqueue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        prompt: canonicalInstruction,
        priority: "background",
        forceWorker: true,
        forceLane: "worker",
        metadata: {
          origin: "autonomy",
          autonomy: {
            objectiveId: autonomy.objectiveId,
            runId: autonomy.runId,
            snapshotId: autonomy.snapshotId,
            patternKey: autonomy.patternKey,
            componentArea: autonomy.componentArea,
            targetPaths: autonomy.targetPaths,
            writeGlobs: autonomy.writeGlobs
          }
        }
      })
    });
    if (!res.ok)
      return null;
    const data = await res.json();
    return data.ok && data.requestId ? data.requestId : null;
  }
  isSnapshotExpired(snapshot) {
    const createdAt = Date.parse(snapshot.snapshot_created_at);
    if (!Number.isFinite(createdAt))
      return true;
    return Date.now() > createdAt + snapshot.snapshot_ttl_ms;
  }
  impactSignalV1(snapshot, candidate) {
    const signalsById = new Map(snapshot.top_signals.map((entry) => [entry.signal_id, entry]));
    const signalPool = candidate.why_now_signal_ids.map((id) => signalsById.get(id)).filter((entry) => Boolean(entry)).slice(0, 16) || [];
    const signals = signalPool.length > 0 ? signalPool : snapshot.top_signals.slice(0, 20);
    const maxType = (types) => clamp012(Math.max(0, ...signals.filter((entry) => types.includes(entry.type)).map((entry) => asNumber(entry.value, 0))));
    const fTestFailRecurrence = maxType(["test_failure"]);
    const fLintTypeErrorDensity = maxType(["lint_failure", "typecheck_failure"]);
    const fFlakeRate = clamp012(Math.max(0, ...signals.filter((entry) => entry.type === "test_failure").map((entry) => /flake|flaky/i.test(entry.evidence) ? asNumber(entry.value, 0) : 0)));
    const fQueueHealthDegradation = maxType(["queue_health"]);
    const fRegretRate24h = maxType(["regret_signal"]);
    return clamp012(0.3 * fTestFailRecurrence + 0.2 * fLintTypeErrorDensity + 0.2 * fFlakeRate + 0.15 * fQueueHealthDegradation + 0.15 * fRegretRate24h);
  }
  scoreCandidate(snapshot, candidate, llmScore) {
    const patternKey = makePatternKey(candidate.objective_type, candidate.target_paths, candidate.trigger_type, candidate.component_area);
    const prior = snapshot.feedback_priors.find((entry) => entry.pattern_key === patternKey);
    const enginePrior = candidate.engine_trial ? (snapshot.engine_idea_priors ?? []).find((entry) => asString2(entry.engine_building_block_id) === asString2(candidate.engine_trial?.building_block_id)) : null;
    const sourceKey = candidate.engine_trial ? asString2(candidate.engine_trial.source_key) || deriveInspirationSourceKey({
      sourceFingerprint: candidate.engine_trial.source_fingerprint,
      sourceType: candidate.engine_trial.source_type,
      sourceLabel: candidate.engine_trial.source_label,
      sourceUrl: candidate.engine_trial.source_url
    }) : "";
    const sourcePrior = candidate.engine_trial ? (snapshot.engine_source_priors ?? []).find((entry) => {
      const entryKey = asString2(entry.source_key);
      if (sourceKey && entryKey === sourceKey)
        return true;
      const candidateFingerprint = asString2(candidate.engine_trial?.source_fingerprint);
      const entryFingerprint = asString2(entry.source_fingerprint);
      if (candidateFingerprint && entryFingerprint && candidateFingerprint === entryFingerprint)
        return true;
      return false;
    }) : null;
    const penalties = [];
    if (candidate.confidence < this.cfg.minConfidence) {
      penalties.push({
        kind: "low_confidence",
        weight: 0.15,
        reason: `candidate confidence ${candidate.confidence.toFixed(2)} < ${this.cfg.minConfidence}`,
        evidence_ids: candidate.why_now_signal_ids
      });
    }
    const impactSignal = this.impactSignalV1(snapshot, candidate);
    const priorSignal = feedbackPriorSignalForScoring(prior);
    const enginePriorSignal = engineIdeaPriorSignalForScoring(enginePrior);
    const sourcePriorSignal = engineSourcePriorSignalForScoring(sourcePrior);
    const docsWeakEvidencePenalty = docsWeakEvidencePenaltyForImpact(candidate.objective_type, impactSignal);
    if (docsWeakEvidencePenalty > 0) {
      penalties.push({
        kind: "docs_weak_evidence",
        weight: docsWeakEvidencePenalty,
        reason: `docs candidate impact_signal ${impactSignal.toFixed(2)} below ${DOCS_MIN_IMPACT_SIGNAL_FOR_NO_PENALTY.toFixed(2)}`,
        evidence_ids: candidate.why_now_signal_ids
      });
    }
    if (sourcePriorSignal.curationStatus === "archived") {
      penalties.push({
        kind: "source_archived",
        weight: sourcePriorSignal.curationPenalty,
        reason: sourcePriorSignal.curationReason || "inspiration source is archived due to low-performing outcomes",
        evidence_ids: candidate.why_now_signal_ids
      });
    } else if (sourcePriorSignal.curationStatus === "watchlist") {
      penalties.push({
        kind: "source_watchlist",
        weight: sourcePriorSignal.curationPenalty,
        reason: sourcePriorSignal.curationReason || "inspiration source on watchlist due to mixed outcomes",
        evidence_ids: candidate.why_now_signal_ids
      });
    }
    const normalizedPenalties = normalizePenalties(penalties);
    const finalScore = 0.46 * clamp012(llmScore) + 0.2 * clamp012(impactSignal) + priorSignal.priorScore + enginePriorSignal.priorScore + sourcePriorSignal.priorScore + enginePriorSignal.noveltyBonus + sourcePriorSignal.noveltyBonus + sourcePriorSignal.trustBoost - penaltyTotal(normalizedPenalties);
    return {
      patternKey,
      impactSignal,
      penalties: normalizedPenalties,
      finalScore,
      emaSuccess: priorSignal.emaSuccess,
      emaUserAccept: priorSignal.emaUserAccept,
      emaLatency: priorSignal.emaLatency,
      emaRegret: priorSignal.emaRegret,
      engineIdeaPriorScore: enginePriorSignal.priorScore,
      engineIdeaNoveltyScore: enginePriorSignal.noveltyScore,
      engineIdeaNoveltyBonus: enginePriorSignal.noveltyBonus,
      engineIdeaSampleCount: enginePriorSignal.sampleCount,
      engineSourcePriorScore: sourcePriorSignal.priorScore,
      engineSourceNoveltyScore: sourcePriorSignal.noveltyScore,
      engineSourceNoveltyBonus: sourcePriorSignal.noveltyBonus,
      engineSourceSampleCount: sourcePriorSignal.sampleCount,
      engineSourceTrustScore: sourcePriorSignal.trustScore,
      engineSourceFreshnessScore: sourcePriorSignal.freshnessScore,
      engineSourceCurationStatus: sourcePriorSignal.curationStatus,
      engineSourceCurationReason: sourcePriorSignal.curationReason,
      engineSourceTrustBoost: sourcePriorSignal.trustBoost
    };
  }
  async fetchEligibility(runId, snapshotId, candidates) {
    const out = new Map;
    const res = await fetch(`${this.server}/autonomy/eligibility`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        runId,
        snapshotId,
        candidates
      })
    });
    if (!res.ok) {
      for (const candidate of candidates) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
      return out;
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.results)) {
      for (const candidate of candidates) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
      return out;
    }
    for (const row of data.results) {
      const candidateId = asString2(row.candidate_id ?? row.candidateId);
      if (!candidateId)
        continue;
      out.set(candidateId, {
        ok: Boolean(row.ok),
        ...row.reason ? { reason: asString2(row.reason) } : {}
      });
    }
    for (const candidate of candidates) {
      if (!out.has(candidate.id)) {
        out.set(candidate.id, { ok: false, reason: "eligibility_unavailable" });
      }
    }
    return out;
  }
  async recordSnapshotExpired(runId, snapshotId, llmCalls, candidates, topCandidate) {
    await this.postObjective({
      runId,
      snapshotId,
      sessionId: this.sessionId,
      candidates: candidates.map((entry) => ({
        ...entry,
        selected: Boolean(topCandidate && entry.id === topCandidate.id),
        rejection_reason: "snapshot_expired",
        gate_decision: "rejected",
        gate_reasons: ["snapshot_expired"]
      })),
      ...topCandidate ? {
        objective: {
          id: `obj_${randomUUID().slice(0, 8)}`,
          candidate_id: topCandidate.id,
          title: topCandidate.title,
          instruction: topCandidate.problem_statement ?? topCandidate.title,
          objective_type: topCandidate.objective_type,
          component_area: topCandidate.component_area,
          trigger_type: topCandidate.trigger_type,
          target_paths: topCandidate.target_paths,
          scope: topCandidate.scope,
          confidence: topCandidate.confidence,
          risk_level: topCandidate.risk_level,
          status: "stale",
          block_reason: "snapshot_expired"
        }
      } : {},
      llmCalls
    });
  }
  async tick() {
    if (!this.runtimeEnabled || this.cfg.killSwitchEnabled || this.inFlight)
      return;
    this.inFlight = true;
    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
    this.markTickStart(runId);
    const cycleDeadline = Date.now() + this.cycleBudgetMs();
    let lockAcquired = false;
    let outcome = "skipped";
    let outcomeDetail = "not_dispatched";
    try {
      this.setPhase("acquire_lock");
      lockAcquired = await this.acquireDispatchLock(runId);
      if (!lockAcquired) {
        outcomeDetail = "lock_not_acquired";
        return;
      }
      this.setPhase("prepare_worktree");
      const ready = await this.ensureAutonomyRepoReady(runId);
      if (!ready) {
        outcomeDetail = "autonomy_repo_not_ready";
        return;
      }
      this.setPhase("repo_preflight");
      const preflight = await repoPreflight(this.autonomyRepo);
      if (preflight.isMergeInProgress) {
        console.log("[RemoteBuddyAutonomousEngine] tick skipped: repo preflight blocked (merge/rebase in progress).");
        outcomeDetail = "repo_preflight_merge_in_progress";
        return;
      }
      if (preflight.isWorktreeDirty && !this.cfg.allowDirtyWorktree) {
        console.log("[RemoteBuddyAutonomousEngine] tick skipped: repo preflight blocked (worktree is dirty and allow_dirty_worktree=false).");
        outcomeDetail = "repo_preflight_dirty_worktree";
        return;
      }
      this.setPhase("discover_repo_targets");
      const repoTargets = discoverRepoTargetProfiles(this.autonomyRepo, 16);
      this.setPhase("fetch_snapshot");
      const snapshot = await this.fetchSnapshot(runId, preflight);
      if (!snapshot) {
        outcomeDetail = "snapshot_unavailable";
        return;
      }
      const snapshotSafety = asObject(snapshot.safety_state);
      if (asBoolean2(snapshotSafety.kill_switch_enabled, false)) {
        outcomeDetail = "kill_switch_enabled";
        return;
      }
      if (asBoolean2(snapshotSafety.is_frozen, false)) {
        const freezeUntil = asString2(snapshotSafety.freeze_until);
        outcomeDetail = freezeUntil ? `frozen_until_${freezeUntil}` : "frozen";
        return;
      }
      const snapshotResourceBudget = asObject(snapshot.resource_budget);
      if (asBoolean2(snapshotResourceBudget.token_budget_exhausted, false)) {
        outcomeDetail = "resource_budget_token_exhausted";
        return;
      }
      if (asBoolean2(snapshotResourceBudget.runtime_budget_exhausted, false)) {
        outcomeDetail = "resource_budget_runtime_exhausted";
        return;
      }
      this.setPhase("check_worker_load");
      const workerLoad = await this.fetchWorkerLoadSnapshot();
      const workerLoadDeferReason = workerLoad ? this.deferReasonForWorkerLoad(workerLoad) : null;
      if (workerLoad && workerLoadDeferReason) {
        console.log(`[RemoteBuddyAutonomousEngine] tick ${runId}: deferring ideation due to active worker load (busy=${workerLoad.workers.busy} pending=${workerLoad.jobs.pending} autoscalablePending=${workerLoad.jobs.autoscalablePending}).`);
        outcomeDetail = workerLoadDeferReason;
        return;
      }
      this.setPhase("load_vision_context");
      const visionContext = this.loadVisionContext(runId);
      if (!visionContext) {
        outcomeDetail = "vision_unavailable";
        return;
      }
      this.setPhase("collect_engine_inspiration");
      const commitHistoryHints = await this.loadCommitHistoryHints();
      this.setPhase("ingest_engine_inspiration");
      await this.ingestAutoInspirationPatterns(runId, commitHistoryHints);
      this.setPhase("collect_engine_inspiration");
      const [inspirationPatterns, sourceInsights] = await Promise.all([
        this.fetchInspirationPatterns(80),
        this.fetchInspirationSourceInsights(160)
      ]);
      const engineInspiration = buildEngineInspirationContext({
        vision: {
          one_sentence: visionContext.one_sentence,
          key_items: visionContext.key_items,
          section_numbers: visionContext.section_numbers
        },
        snapshot: {
          top_signals: snapshot.top_signals,
          state_traits: snapshot.state_traits,
          open_objectives: snapshot.open_objectives,
          dispatch_budget: snapshot.dispatch_budget
        },
        inspirationPatterns,
        sourceInsights,
        commitHistoryHints,
        repoRoot: this.autonomyRepo,
        repoTargets
      });
      const visionSectionNumberSet = new Set(visionContext.section_numbers);
      const requireVisionSectionRefs = visionSectionNumberSet.size > 0;
      const llmCalls = [];
      let candidatesPayload = [];
      let selectedCandidatePayload;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired";
        return;
      }
      await this.comm.emit("autonomy_cycle_started", {
        runId,
        snapshotId: snapshot.snapshot_id,
        phase: "ideation"
      });
      this.setPhase("renew_lock_before_ideation");
      if (!await this.renewDispatchLock(runId)) {
        outcomeDetail = "lock_renew_failed_before_ideation";
        return;
      }
      this.setPhase("ideation");
      const ideationRecovery = this.consumeIdeationTimeoutRecovery();
      if (ideationRecovery) {
        console.warn(`[RemoteBuddyAutonomousEngine] tick ${runId}: applying one-shot ideation timeout recovery from ${ideationRecovery.previousRunId} after ${ideationRecovery.timeoutMs}ms timeout.`);
      }
      const ideationTopSignals = snapshot.top_signals.slice(0, ideationRecovery ? 10 : 16);
      const ideationStateTraits = snapshot.state_traits.slice(0, ideationRecovery ? 14 : 24);
      const ideationFeedbackPriors = snapshot.feedback_priors.slice(0, ideationRecovery ? 12 : 20);
      const ideationEngineIdeaPriors = (snapshot.engine_idea_priors ?? []).slice(0, ideationRecovery ? 12 : 20);
      const ideationOpenObjectives = snapshot.open_objectives.slice(0, ideationRecovery ? 12 : 20);
      const ideationActiveCooldowns = snapshot.active_cooldowns.slice(0, ideationRecovery ? 12 : 20);
      const ideationRepoTargets = repoTargets.slice(0, ideationRecovery ? 8 : repoTargets.length);
      const ideationPhase = await this.llmPhase("ideation", runId, snapshot.snapshot_id, {
        system: IDEATION_SYSTEM_PROMPT,
        json: true,
        maxTokens: ideationRecovery ? 1400 : 2800,
        temperature: 0.2,
        messages: [
          ...ideationRecovery ? [
            {
              role: "user",
              content: `${IDEATION_TIMEOUT_RECOVERY_INSTRUCTION} Previous timed-out run: ${ideationRecovery.previousRunId}. Timeout budget for this round: ${this.phaseTimeoutMs("ideation")}ms.`
            }
          ] : [],
          {
            role: "user",
            content: JSON.stringify({
              snapshot: {
                snapshot_id: snapshot.snapshot_id,
                top_signals: ideationTopSignals,
                state_traits: ideationStateTraits,
                feedback_priors: ideationFeedbackPriors,
                engine_idea_priors: ideationEngineIdeaPriors,
                open_objectives: ideationOpenObjectives,
                active_cooldowns: ideationActiveCooldowns
              },
              vision: visionContext,
              repo_targets: ideationRepoTargets.map((target) => ({
                component_area: target.component_area,
                target_paths: target.target_paths,
                write_globs: target.write_globs,
                label: target.label,
                keywords: target.keywords.slice(0, 8)
              })),
              engine_inspiration: engineInspiration,
              limits: {
                ideation_max_candidates: this.cfg.ideationMaxCandidates,
                min_confidence: this.cfg.minConfidence
              }
            }, null, 2)
          }
        ]
      });
      llmCalls.push(ideationPhase.llmCall);
      const ideationJson = ideationPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_ideation";
        return;
      }
      let rawCandidates = Array.isArray(ideationJson.candidates) ? ideationJson.candidates : [];
      if (rawCandidates.length === 0) {
        const synthesized = buildEngineFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
          repoRoot: this.autonomyRepo,
          repoTargets
        });
        if (synthesized.length > 0) {
          console.log(`[RemoteBuddyAutonomousEngine] tick ${runId}: ideation returned no candidates; using ${synthesized.length} deterministic engine-inspiration fallback candidates.`);
          rawCandidates = synthesized;
        }
      }
      const normalizedCandidates = [];
      const dropReasonCounts = new Map;
      const recordDropReason = (reason) => {
        dropReasonCounts.set(reason, (dropReasonCounts.get(reason) ?? 0) + 1);
      };
      const ingestRawCandidates = (rawList, source) => {
        const candidateCreatedBaseMs = Date.now();
        for (const [candidateIndex, rawCandidate] of rawList.slice(0, this.cfg.ideationMaxCandidates).entries()) {
          const c = asObject(rawCandidate);
          const triggerType = asString2(c.trigger_type);
          if (!isTriggerType(triggerType)) {
            recordDropReason(`${source}_invalid_trigger_type`);
            continue;
          }
          const candidate = {
            id: asString2(c.id) || `cand_${randomUUID().slice(0, 8)}`,
            title: asString2(c.title),
            objective_type: asString2(c.objective_type),
            problem_statement: asString2(c.problem_statement),
            trigger_type: triggerType,
            component_area: normalizeAutonomyComponentArea(c.component_area ?? c.componentArea) ?? "",
            target_paths: asStringArray2(c.target_paths),
            scope: {
              read_anywhere: asBoolean2(asObject(c.scope).read_anywhere, false),
              write_globs: asStringArray2(asObject(c.scope).write_globs)
            },
            risk_level: asString2(c.risk_level),
            expected_validation: asStringArray2(c.expected_validation).map((command) => canonicalizeValidationCommandForBun(command)).filter(Boolean),
            estimated_effort: asString2(c.estimated_effort),
            why_now_signal_ids: asStringArray2(c.why_now_signal_ids),
            confidence: clamp012(asNumber(c.confidence, 0)),
            vision_alignment_reason: asString2(c.vision_alignment_reason),
            vision_section_refs: normalizeVisionSectionRefs(asStringArray2(c.vision_section_refs), visionSectionNumberSet),
            feature_hypotheses: asStringArray2(c.feature_hypotheses).slice(0, 24),
            requires_user_input: asBoolean2(c.requires_user_input, false),
            question_if_blocked: asString2(c.question_if_blocked),
            candidate_created_at: new Date(candidateCreatedBaseMs + candidateIndex).toISOString(),
            engine_trial: normalizeEngineTrialMetadata(c.engine_trial ?? c.engineTrial ?? asObject(c.debug).engine_trial) ?? undefined
          };
          const policy = POLICY[candidate.objective_type];
          if (!policy || !policy.autonomousAllowed) {
            recordDropReason(`${source}_objective_type_not_allowed`);
            continue;
          }
          if (!isRiskLevel(candidate.risk_level)) {
            recordDropReason(`${source}_invalid_risk_level`);
            continue;
          }
          if (RISK_ORDER[candidate.risk_level] > RISK_ORDER[policy.maxRisk]) {
            recordDropReason(`${source}_risk_exceeds_policy`);
            continue;
          }
          const scopeValidation = validateScopeInvariants(candidate.component_area, candidate.target_paths, candidate.scope.write_globs, { requireWriteGlobs: true });
          if (!scopeValidation.ok) {
            recordDropReason(`${source}_scope_validation_failed`);
            continue;
          }
          if (BREADTH_ORDER[scopeValidation.breadth] > BREADTH_ORDER[policy.maxBreadth]) {
            recordDropReason(`${source}_scope_breadth_exceeds_policy`);
            continue;
          }
          if (candidate.scope.read_anywhere && !this.cfg.allowReadAnywhere) {
            recordDropReason(`${source}_read_anywhere_not_allowed`);
            continue;
          }
          if (policy.requireValidation && candidate.expected_validation.length === 0) {
            recordDropReason(`${source}_missing_validation_steps`);
            continue;
          }
          if (!candidate.vision_alignment_reason) {
            recordDropReason(`${source}_missing_vision_alignment_reason`);
            continue;
          }
          if (requireVisionSectionRefs && candidate.vision_section_refs.length === 0) {
            recordDropReason(`${source}_missing_vision_section_refs`);
            continue;
          }
          candidate.component_area = scopeValidation.componentArea ?? candidate.component_area;
          candidate.target_paths = scopeValidation.normalizedTargetPaths;
          candidate.scope.write_globs = scopeValidation.normalizedWriteGlobs;
          const missingTargetPaths = findMissingRepoTargetPaths(this.autonomyRepo, candidate.target_paths);
          if (missingTargetPaths.length > 0) {
            recordDropReason(`${source}_target_paths_missing_in_repo`);
            console.warn(`[RemoteBuddyAutonomousEngine] dropping candidate ${candidate.id}: target_paths missing in repo ${missingTargetPaths.join(", ")}`);
            continue;
          }
          if (!candidate.engine_trial) {
            const inferred = inferEngineTrialFromCandidate(candidate, engineInspiration);
            if (inferred) {
              candidate.engine_trial = {
                ...inferred,
                source: source === "engine_fallback" ? "engine_fallback" : inferred.source
              };
            }
          }
          normalizedCandidates.push(candidate);
        }
      };
      ingestRawCandidates(rawCandidates, "llm");
      if (normalizedCandidates.length === 0) {
        const synthesizedFallback = buildEngineFallbackCandidates({
          engineInspiration,
          snapshotTopSignals: snapshot.top_signals,
          visionSectionRefs: visionContext.section_numbers,
          maxCandidates: Math.max(1, Math.min(3, this.cfg.topK)),
          repoRoot: this.autonomyRepo,
          repoTargets
        });
        if (synthesizedFallback.length > 0) {
          ingestRawCandidates(synthesizedFallback, "engine_fallback");
        }
      }
      candidatesPayload = normalizedCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        objective_type: candidate.objective_type,
        problem_statement: candidate.problem_statement,
        trigger_type: candidate.trigger_type,
        component_area: candidate.component_area,
        target_paths: candidate.target_paths,
        scope: candidate.scope,
        risk_level: candidate.risk_level,
        expected_validation: candidate.expected_validation,
        estimated_effort: candidate.estimated_effort,
        why_now_signal_ids: candidate.why_now_signal_ids,
        confidence: candidate.confidence,
        vision_alignment_reason: candidate.vision_alignment_reason,
        vision_section_refs: candidate.vision_section_refs,
        feature_hypotheses: candidate.feature_hypotheses,
        ...candidate.engine_trial ? { engine_trial: candidate.engine_trial } : {},
        gate_decision: "proposed",
        gate_reasons: [],
        candidate_created_at: candidate.candidate_created_at
      }));
      if (normalizedCandidates.length === 0) {
        const dropReasons = Object.fromEntries([...dropReasonCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
        const topSignals = snapshot.top_signals.slice(0, 3).map((signal) => `${signal.signal_id}:${Number(signal.value ?? 0).toFixed(2)}`).join(", ");
        const parseHint = rawCandidates.length === 0 && Object.keys(ideationJson).length === 0 ? " (ideation returned empty or non-parseable JSON)" : "";
        console.log(`[RemoteBuddyAutonomousEngine] tick produced no eligible candidates: raw=${rawCandidates.length} normalized=0 drop_reasons=${JSON.stringify(dropReasons)} top_signals=${topSignals || "none"}${parseHint}`);
        this.setPhase("record_no_candidate_objective");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          llmCalls
        });
        outcomeDetail = "no_eligible_candidates";
        return;
      }
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_post_ideation_filter";
        return;
      }
      this.setPhase("renew_lock_before_scoring");
      if (!await this.renewDispatchLock(runId)) {
        outcomeDetail = "lock_renew_failed_before_scoring";
        return;
      }
      this.setPhase("scoring");
      const scoringPhase = await this.llmPhase("scoring", runId, snapshot.snapshot_id, {
        system: SCORING_SYSTEM_PROMPT,
        json: true,
        maxTokens: 1400,
        temperature: 0.1,
        messages: [
          {
            role: "user",
            content: JSON.stringify({ candidates: normalizedCandidates, top_k: this.cfg.topK })
          }
        ]
      });
      llmCalls.push(scoringPhase.llmCall);
      const scoringJson = scoringPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_scoring";
        return;
      }
      const scoreById = new Map;
      for (const rawScore of Array.isArray(scoringJson.scores) ? scoringJson.scores : []) {
        const s = asObject(rawScore);
        const id = asString2(s.id);
        if (!id)
          continue;
        scoreById.set(id, clamp012(asNumber(s.llm_score, 0)));
      }
      const scored = normalizedCandidates.map((candidate) => {
        const llmScore = scoreById.get(candidate.id) ?? 0;
        const scoredCandidate = this.scoreCandidate(snapshot, candidate, llmScore);
        return { candidate, llmScore, ...scoredCandidate };
      });
      scored.sort((a, b) => {
        if (b.finalScore !== a.finalScore)
          return b.finalScore - a.finalScore;
        if (a.candidate.candidate_created_at !== b.candidate.candidate_created_at) {
          return a.candidate.candidate_created_at.localeCompare(b.candidate.candidate_created_at);
        }
        return a.candidate.id.localeCompare(b.candidate.id);
      });
      const evaluatorRecommendation = asString2(snapshot.evaluator?.recommendation).toLowerCase();
      const exploreBaseRate = evaluatorRecommendation === "pause" ? 0 : evaluatorRecommendation === "constrain" ? Math.min(this.cfg.exploreRate, 0.15) : this.cfg.exploreRate;
      const adaptiveExplore = computeAdaptiveExploreRate({
        baseRate: exploreBaseRate,
        minRate: evaluatorRecommendation === "pause" ? 0 : ENGINE_EXPLORE_RATE_MIN,
        maxRate: evaluatorRecommendation === "pause" ? 0 : ENGINE_EXPLORE_RATE_MAX,
        snapshot
      });
      const eligibilityById = await this.fetchEligibility(runId, snapshot.snapshot_id, scored.map((row) => ({
        id: row.candidate.id,
        objective_type: row.candidate.objective_type,
        component_area: row.candidate.component_area,
        pattern_key: row.patternKey,
        confidence: row.candidate.confidence
      })));
      const rankedWithEligibility = scored.map((row) => ({
        ...row,
        eligibility: eligibilityById.get(row.candidate.id) ?? {
          ok: false,
          reason: "eligibility_unavailable"
        }
      }));
      candidatesPayload = rankedWithEligibility.map((row) => ({
        id: row.candidate.id,
        title: row.candidate.title,
        objective_type: row.candidate.objective_type,
        problem_statement: row.candidate.problem_statement,
        trigger_type: row.candidate.trigger_type,
        component_area: row.candidate.component_area,
        target_paths: row.candidate.target_paths,
        scope: row.candidate.scope,
        risk_level: row.candidate.risk_level,
        expected_validation: row.candidate.expected_validation,
        estimated_effort: row.candidate.estimated_effort,
        why_now_signal_ids: row.candidate.why_now_signal_ids,
        confidence: row.candidate.confidence,
        vision_alignment_reason: row.candidate.vision_alignment_reason,
        vision_section_refs: row.candidate.vision_section_refs,
        feature_hypotheses: row.candidate.feature_hypotheses,
        ...row.candidate.engine_trial ? { engine_trial: row.candidate.engine_trial } : {},
        llm_score: row.llmScore,
        impact_signal: row.impactSignal,
        ema_success: row.emaSuccess,
        ema_user_accept: row.emaUserAccept,
        engine_idea_prior_score: row.engineIdeaPriorScore,
        engine_idea_novelty_score: row.engineIdeaNoveltyScore,
        engine_idea_novelty_bonus: row.engineIdeaNoveltyBonus,
        engine_idea_sample_count: row.engineIdeaSampleCount,
        engine_source_prior_score: row.engineSourcePriorScore,
        engine_source_novelty_score: row.engineSourceNoveltyScore,
        engine_source_novelty_bonus: row.engineSourceNoveltyBonus,
        engine_source_sample_count: row.engineSourceSampleCount,
        engine_source_trust_score: row.engineSourceTrustScore,
        engine_source_freshness_score: row.engineSourceFreshnessScore,
        engine_source_curation_status: row.engineSourceCurationStatus,
        engine_source_curation_reason: row.engineSourceCurationReason,
        engine_source_trust_boost: row.engineSourceTrustBoost,
        explore_rate_configured: adaptiveExplore.baseRate,
        effective_explore_rate: adaptiveExplore.effectiveRate,
        explore_rate_adjustment: adaptiveExplore.adjustment,
        penalties: row.penalties,
        final_score: row.finalScore,
        gate_decision: row.eligibility.ok ? "approved" : "rejected",
        gate_reasons: row.eligibility.ok ? [] : [row.eligibility.reason],
        selected: false,
        selection_strategy: "not_selected",
        selection_roll: null,
        candidate_created_at: row.candidate.candidate_created_at
      }));
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload);
        outcomeDetail = "snapshot_expired_after_eligibility";
        return;
      }
      this.setPhase("renew_lock_before_selection");
      if (!await this.renewDispatchLock(runId)) {
        outcomeDetail = "lock_renew_failed_before_selection";
        return;
      }
      const top = rankedWithEligibility[0];
      if (!top) {
        outcomeDetail = "no_ranked_candidate";
        return;
      }
      const eligibleRows = rankedWithEligibility.filter((row) => row.eligibility.ok);
      const selection = pickCandidateWithExploreExploit({
        rows: eligibleRows.map((row) => ({
          id: row.candidate.id,
          finalScore: row.finalScore,
          noveltyScore: row.engineIdeaNoveltyScore
        })),
        seed: `${runId}:${snapshot.snapshot_id}:${snapshot.snapshot_created_at}`,
        exploreRate: adaptiveExplore.effectiveRate
      });
      const selected = selection.selected ? eligibleRows.find((row) => row.candidate.id === selection.selected?.id) : undefined;
      const selectedStrategy = selected ? selection.strategy : "exploit";
      const objectiveId = `obj_${randomUUID().slice(0, 8)}`;
      selectedCandidatePayload = selected ? {
        id: selected.candidate.id,
        title: selected.candidate.title,
        objective_type: selected.candidate.objective_type,
        problem_statement: selected.candidate.problem_statement,
        trigger_type: selected.candidate.trigger_type,
        component_area: selected.candidate.component_area,
        target_paths: selected.candidate.target_paths,
        scope: selected.candidate.scope,
        risk_level: selected.candidate.risk_level,
        confidence: selected.candidate.confidence,
        vision_alignment_reason: selected.candidate.vision_alignment_reason,
        vision_section_refs: selected.candidate.vision_section_refs,
        feature_hypotheses: selected.candidate.feature_hypotheses,
        ...selected.candidate.engine_trial ? { engine_trial: selected.candidate.engine_trial } : {},
        selection_strategy: selectedStrategy,
        selection_roll: selection.roll,
        effective_explore_rate: adaptiveExplore.effectiveRate
      } : {
        id: top.candidate.id,
        title: top.candidate.title,
        objective_type: top.candidate.objective_type,
        problem_statement: top.candidate.problem_statement,
        trigger_type: top.candidate.trigger_type,
        component_area: top.candidate.component_area,
        target_paths: top.candidate.target_paths,
        scope: top.candidate.scope,
        risk_level: top.candidate.risk_level,
        confidence: top.candidate.confidence,
        vision_alignment_reason: top.candidate.vision_alignment_reason,
        vision_section_refs: top.candidate.vision_section_refs,
        feature_hypotheses: top.candidate.feature_hypotheses,
        ...top.candidate.engine_trial ? { engine_trial: top.candidate.engine_trial } : {},
        selection_strategy: "none",
        selection_roll: null,
        effective_explore_rate: adaptiveExplore.effectiveRate
      };
      for (const row of candidatesPayload) {
        const isSelected = Boolean(row.id === selectedCandidatePayload.id);
        row.selected = isSelected;
        row.selection_strategy = isSelected && selected ? selectedStrategy : "not_selected";
        row.selection_roll = isSelected ? selection.roll : null;
      }
      if (!selected) {
        this.setPhase("record_rejected_objective");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: top.candidate.id,
            title: top.candidate.title,
            instruction: top.candidate.problem_statement,
            objective_type: top.candidate.objective_type,
            component_area: top.candidate.component_area,
            trigger_type: top.candidate.trigger_type,
            target_paths: top.candidate.target_paths,
            scope: top.candidate.scope,
            confidence: top.candidate.confidence,
            risk_level: top.candidate.risk_level,
            status: "rejected",
            block_reason: top.eligibility.reason ?? "no eligible candidate",
            score_breakdown: {
              llm_score: top.llmScore,
              impact_signal: top.impactSignal,
              penalties: top.penalties,
              ema_success: top.emaSuccess,
              ema_user_accept: top.emaUserAccept,
              engine_idea_prior_score: top.engineIdeaPriorScore,
              engine_idea_novelty_score: top.engineIdeaNoveltyScore,
              engine_idea_novelty_bonus: top.engineIdeaNoveltyBonus,
              engine_idea_sample_count: top.engineIdeaSampleCount,
              engine_source_prior_score: top.engineSourcePriorScore,
              engine_source_novelty_score: top.engineSourceNoveltyScore,
              engine_source_novelty_bonus: top.engineSourceNoveltyBonus,
              engine_source_sample_count: top.engineSourceSampleCount,
              engine_source_trust_score: top.engineSourceTrustScore,
              engine_source_freshness_score: top.engineSourceFreshnessScore,
              engine_source_curation_status: top.engineSourceCurationStatus,
              engine_source_curation_reason: top.engineSourceCurationReason,
              engine_source_trust_boost: top.engineSourceTrustBoost,
              explore_rate_configured: adaptiveExplore.baseRate,
              effective_explore_rate: adaptiveExplore.effectiveRate,
              explore_rate_adjustment: adaptiveExplore.adjustment,
              final_score: top.finalScore,
              selection_strategy: "none",
              selection_roll: null
            }
          },
          llmCalls
        });
        outcomeDetail = "no_eligible_candidate";
        return;
      }
      if (selected.candidate.requires_user_input) {
        this.setPhase("record_blocked_requires_input");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: selected.candidate.id,
            title: selected.candidate.title,
            instruction: selected.candidate.problem_statement,
            objective_type: selected.candidate.objective_type,
            component_area: selected.candidate.component_area,
            trigger_type: selected.candidate.trigger_type,
            target_paths: selected.candidate.target_paths,
            scope: selected.candidate.scope,
            confidence: selected.candidate.confidence,
            risk_level: selected.candidate.risk_level,
            status: "blocked",
            block_reason: "requires_user_input",
            score_breakdown: {
              llm_score: selected.llmScore,
              impact_signal: selected.impactSignal,
              penalties: selected.penalties,
              ema_success: selected.emaSuccess,
              ema_user_accept: selected.emaUserAccept,
              engine_idea_prior_score: selected.engineIdeaPriorScore,
              engine_idea_novelty_score: selected.engineIdeaNoveltyScore,
              engine_idea_novelty_bonus: selected.engineIdeaNoveltyBonus,
              engine_idea_sample_count: selected.engineIdeaSampleCount,
              engine_source_prior_score: selected.engineSourcePriorScore,
              engine_source_novelty_score: selected.engineSourceNoveltyScore,
              engine_source_novelty_bonus: selected.engineSourceNoveltyBonus,
              engine_source_sample_count: selected.engineSourceSampleCount,
              engine_source_trust_score: selected.engineSourceTrustScore,
              engine_source_freshness_score: selected.engineSourceFreshnessScore,
              engine_source_curation_status: selected.engineSourceCurationStatus,
              engine_source_curation_reason: selected.engineSourceCurationReason,
              engine_source_trust_boost: selected.engineSourceTrustBoost,
              explore_rate_configured: adaptiveExplore.baseRate,
              effective_explore_rate: adaptiveExplore.effectiveRate,
              explore_rate_adjustment: adaptiveExplore.adjustment,
              final_score: selected.finalScore,
              selection_strategy: selectedStrategy,
              selection_roll: selection.roll
            }
          },
          question: {
            question: selected.candidate.question_if_blocked || "Please confirm objective scope and constraints.",
            question_type: "bounded_text",
            expected_answer_schema: { min_length: 3, max_length: 1000 }
          },
          llmCalls
        });
        outcomeDetail = "requires_user_input";
        return;
      }
      this.setPhase("renew_lock_before_planning");
      if (!await this.renewDispatchLock(runId)) {
        outcomeDetail = "lock_renew_failed_before_planning";
        return;
      }
      this.setPhase("planning");
      const planningPhase = await this.llmPhase("planning", runId, snapshot.snapshot_id, {
        system: PLANNING_SYSTEM_PROMPT,
        json: true,
        maxTokens: 800,
        temperature: 0.1,
        messages: [
          {
            role: "user",
            content: JSON.stringify({ candidate: selected.candidate })
          }
        ]
      }, objectiveId);
      llmCalls.push(planningPhase.llmCall);
      const planningJson = planningPhase.json;
      if (this.isSnapshotExpired(snapshot) || Date.now() > cycleDeadline) {
        this.setPhase("record_snapshot_expired");
        await this.recordSnapshotExpired(runId, snapshot.snapshot_id, llmCalls, candidatesPayload, selectedCandidatePayload);
        outcomeDetail = "snapshot_expired_after_planning";
        return;
      }
      this.setPhase("renew_lock_before_enqueue");
      if (!await this.renewDispatchLock(runId)) {
        outcomeDetail = "lock_renew_failed_before_enqueue";
        return;
      }
      const instruction = canonicalizeInstructionTextForBun(asString2(planningJson.instruction) || `${selected.candidate.title}

${selected.candidate.problem_statement}

Scope:
- target_paths: ${selected.candidate.target_paths.join(", ")}
- write_globs: ${selected.candidate.scope.write_globs.join(", ")}`);
      this.setPhase("enqueue_request");
      const requestId = await this.enqueueSyntheticRequest(instruction, {
        objectiveId,
        runId,
        snapshotId: snapshot.snapshot_id,
        patternKey: selected.patternKey,
        componentArea: selected.candidate.component_area,
        targetPaths: selected.candidate.target_paths,
        writeGlobs: selected.candidate.scope.write_globs
      });
      if (!requestId) {
        this.setPhase("record_failed_enqueue");
        await this.postObjective({
          runId,
          snapshotId: snapshot.snapshot_id,
          sessionId: this.sessionId,
          candidates: candidatesPayload,
          objective: {
            id: objectiveId,
            candidate_id: selected.candidate.id,
            title: selected.candidate.title,
            instruction,
            objective_type: selected.candidate.objective_type,
            component_area: selected.candidate.component_area,
            trigger_type: selected.candidate.trigger_type,
            target_paths: selected.candidate.target_paths,
            scope: selected.candidate.scope,
            confidence: selected.candidate.confidence,
            risk_level: selected.candidate.risk_level,
            status: "failed",
            block_reason: "request_enqueue_failed"
          },
          llmCalls
        });
        outcomeDetail = "request_enqueue_failed";
        return;
      }
      this.setPhase("record_dispatched_objective");
      await this.postObjective({
        runId,
        snapshotId: snapshot.snapshot_id,
        sessionId: this.sessionId,
        candidates: candidatesPayload,
        objective: {
          id: objectiveId,
          candidate_id: selected.candidate.id,
          title: selected.candidate.title,
          instruction,
          objective_type: selected.candidate.objective_type,
          component_area: selected.candidate.component_area,
          trigger_type: selected.candidate.trigger_type,
          target_paths: selected.candidate.target_paths,
          scope: selected.candidate.scope,
          confidence: selected.candidate.confidence,
          risk_level: selected.candidate.risk_level,
          status: "dispatched",
          request_id: requestId,
          score_breakdown: {
            llm_score: selected.llmScore,
            impact_signal: selected.impactSignal,
            penalties: selected.penalties,
            ema_success: selected.emaSuccess,
            ema_user_accept: selected.emaUserAccept,
            engine_idea_prior_score: selected.engineIdeaPriorScore,
            engine_idea_novelty_score: selected.engineIdeaNoveltyScore,
            engine_idea_novelty_bonus: selected.engineIdeaNoveltyBonus,
            engine_idea_sample_count: selected.engineIdeaSampleCount,
            engine_source_prior_score: selected.engineSourcePriorScore,
            engine_source_novelty_score: selected.engineSourceNoveltyScore,
            engine_source_novelty_bonus: selected.engineSourceNoveltyBonus,
            engine_source_sample_count: selected.engineSourceSampleCount,
            engine_source_trust_score: selected.engineSourceTrustScore,
            engine_source_freshness_score: selected.engineSourceFreshnessScore,
            engine_source_curation_status: selected.engineSourceCurationStatus,
            engine_source_curation_reason: selected.engineSourceCurationReason,
            engine_source_trust_boost: selected.engineSourceTrustBoost,
            explore_rate_configured: adaptiveExplore.baseRate,
            effective_explore_rate: adaptiveExplore.effectiveRate,
            explore_rate_adjustment: adaptiveExplore.adjustment,
            final_score: selected.finalScore,
            selection_strategy: selectedStrategy,
            selection_roll: selection.roll
          }
        },
        llmCalls
      });
      outcome = "success";
      outcomeDetail = `dispatched_request_${requestId.slice(0, 8)}`;
    } catch (error) {
      console.error("[RemoteBuddyAutonomousEngine] tick failed:", error);
      outcome = "failed";
      outcomeDetail = `error:${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (lockAcquired)
        await this.releaseDispatchLock(runId);
      this.inFlight = false;
      this.markTickDone(outcome, outcomeDetail);
    }
  }
  async enqueueFromAnalysis(instruction, autonomyCtx, originRequestId) {
    if (!this.runtimeEnabled)
      return null;
    const objectiveId = autonomyCtx.objectiveId ?? `obj_${originRequestId.slice(0, 8)}`;
    const runId = autonomyCtx.runId ?? `run_${Date.now()}_${originRequestId.slice(0, 8)}`;
    const snapshotId = autonomyCtx.snapshotId ?? `snap_analysis_${originRequestId.slice(0, 8)}`;
    const patternKey = autonomyCtx.patternKey ?? "analysis_followup";
    console.log(`[RemoteBuddyAutonomousEngine] Enqueuing analysis follow-up (objective ${objectiveId})`);
    return this.enqueueSyntheticRequest(instruction, {
      objectiveId,
      runId,
      snapshotId,
      patternKey,
      componentArea: autonomyCtx.componentArea ?? "shared",
      targetPaths: autonomyCtx.targetPaths,
      writeGlobs: autonomyCtx.writeGlobs
    });
  }
  start() {
    if (!this.runtimeEnabled || this.timer)
      return;
    console.log(`[RemoteBuddyAutonomousEngine] Using dedicated autonomy worktree ${this.autonomyRepo} (remote=${this.gitRemote} integration=${this.integrationBranch} base=${this.baseBranch}).`);
    this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
    this.timer = setInterval(() => {
      this.nextTickAtMs = Date.now() + this.cfg.tickIntervalMs;
      this.tick();
    }, this.cfg.tickIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      this.logHeartbeat();
    }, this.cfg.heartbeatLogMs);
    this.logHeartbeat();
    this.tick();
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.nextTickAtMs = 0;
  }
}

// apps/remotebuddy/src/worker_spawn.ts
function resolveWorkerStartupTimeoutMs(options) {
  const configuredMs = Math.max(1000, Math.floor(options.configuredMs || 0));
  if (!options.docker) {
    return configuredMs;
  }
  const dockerFloorMs = Math.max(30000, Math.floor(options.dockerAgentStartupTimeoutMs || 0) + 15000);
  return Math.max(configuredMs, dockerFloorMs);
}
function buildWorkerSpawnCommand(options) {
  const binaryPath = String(options.binaryPath ?? "").trim();
  const envFile = String(options.envFile ?? "").trim() || ".env";
  const entrypoint = String(options.entrypoint ?? "").trim() || "apps/workerpals/src/workerpals_main.ts";
  const args = binaryPath ? [
    binaryPath,
    "--server",
    options.server,
    "--workerId",
    options.workerId,
    "--repo",
    options.repoRoot
  ] : [
    "bun",
    "run",
    "--env-file",
    envFile,
    entrypoint,
    "--server",
    options.server,
    "--workerId",
    options.workerId,
    "--repo",
    options.repoRoot
  ];
  if (options.pollMs) {
    args.push("--poll", String(options.pollMs));
  }
  if (options.heartbeatMs) {
    args.push("--heartbeat", String(options.heartbeatMs));
  }
  if (options.labels.length > 0) {
    args.push("--labels", options.labels.join(","));
  }
  if (options.docker) {
    args.push("--docker");
    if (options.requireDocker)
      args.push("--require-docker");
    if (options.dockerImage) {
      args.push("--docker-image", options.dockerImage);
    }
  }
  return args;
}

// apps/remotebuddy/src/remotebuddy_main.ts
var CONFIG = loadPushPalsConfig();
function parseArgs() {
  const args = process.argv.slice(2);
  let server = CONFIG.server.url;
  let sessionId = CONFIG.sessionId;
  let authToken = CONFIG.authToken;
  for (let i = 0;i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
    }
  }
  const resolved = resolveLocalServerConnection({
    serverUrl: server,
    authToken,
    fallbackPort: CONFIG.server.port
  });
  if (resolved.serverWasNormalized) {
    console.warn(`[RemoteBuddy] Coerced server URL to local-only endpoint: ${resolved.serverUrl}`);
  }
  if (resolved.authTokenWasIgnored) {
    console.warn("[RemoteBuddy] Ignoring auth token in local-only mode.");
  }
  return { server: resolved.serverUrl, sessionId, authToken: resolved.authToken };
}
function isLikelyChitChat(text) {
  const t = text.trim().toLowerCase();
  if (!t)
    return true;
  const short = t.length <= 64;
  return short && /^(hi|hello|hey|hi there|hello there|thanks|thank you|ok|okay|cool|nice|yo|sup|what's up|whats up)[!. ]*$/.test(t);
}
function isQuestionLike(text) {
  const t = text.trim().toLowerCase();
  if (!t)
    return false;
  if (t.includes("?"))
    return true;
  return /^(is|are|can|could|should|would|what|why|how|when|where|which|does|do)\b/.test(t);
}
function isExecutionIntent(text, targetPath) {
  const t = text.trim().toLowerCase();
  if (!t || isLikelyChitChat(t))
    return false;
  if (targetPath)
    return true;
  if (isArchitectureIntent(t))
    return true;
  const mutatingVerb = /\b(create|write|add|append|edit|update|modify|delete|remove|rename|implement|fix|refactor|generate)\b/.test(t);
  const operationalVerb = /\b(run|test|lint|build|compile|search|find|inspect|check|validate|trace|debug)\b/.test(t);
  const repoHint = /\b(repo|repository|project|architecture|structure|module|component|workflow|pipeline|branch|worker|orchestrator|server|client|docker|git|code|file|readme)\b/.test(t);
  if (mutatingVerb && (repoHint || t.length >= 12))
    return true;
  if (operationalVerb && repoHint)
    return true;
  if (isQuestionLike(t))
    return false;
  return t.length > 220;
}
function isArchitectureIntent(text) {
  const t = text.trim().toLowerCase();
  if (!t)
    return false;
  const architectureCue = /\b(architecture|repo architecture|repository architecture|system design|high[- ]level|overview|describe the architecture|how .* works|explain .* architecture)\b/.test(t);
  const codeChangeCue = /\b(refactor|rename|change|modify|edit|update|implement|fix|add|remove|delete|create|write|patch)\b/.test(t);
  return architectureCue && !codeChangeCue;
}
function parseEnabledFlag(raw, defaultValue) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text)
    return defaultValue;
  return !["0", "false", "no", "off"].includes(text);
}
function isCodexUnavailableFailureSignal(message, detail) {
  const text = `${message}
${detail}`.toLowerCase();
  return [
    "openai_codex cli is not installed",
    "openai_codex chatgpt auth is not ready",
    "openai_codex api_key auth requires openai_api_key",
    "openai_codex policy violation: codex cli workaround detected",
    "codex cli isn't available",
    "codex cli is mandatory in this backend"
  ].some((needle) => text.includes(needle));
}
function asAutonomyComponentArea2(value) {
  return normalizeAutonomyComponentArea(value) ?? undefined;
}
function normalizeRequestPriority(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "interactive" || text === "background")
    return text;
  return "normal";
}
function toSingleLine(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text)
    return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
function asObject2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  return value;
}
function normalizeMetadataTargetPaths(value, maxItems = 48) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of value) {
    const normalized = normalizeTargetPath(raw);
    if (!normalized)
      continue;
    if (seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems)
      break;
  }
  return out;
}
function normalizeMetadataWriteGlobs(value, maxItems = 48) {
  if (!Array.isArray(value))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of value) {
    const normalized = normalizeWriteGlob(raw);
    if (!normalized)
      continue;
    if (seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems)
      break;
  }
  return out;
}
function buildTaskExecuteDedupeKey(sessionId, params) {
  const normalizedSessionId = String(sessionId ?? "").trim().toLowerCase();
  if (!normalizedSessionId)
    return null;
  const normalizedOrigin = params.origin === "autonomy" ? "autonomy" : "user";
  const rawTargetPaths = Array.isArray(params.planning.targetPaths) ? params.planning.targetPaths : [];
  const normalizedTargets = rawTargetPaths.map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry)).filter((entry) => entry !== ".").slice(0, 8);
  if (normalizedTargets.length === 0)
    return null;
  const uniqueTargets = [...new Set(normalizedTargets)].sort((a, b) => a.localeCompare(b));
  if (uniqueTargets.length > 4)
    return null;
  const maxFilesToEdit = params.planning.scope.maxFilesToEdit;
  if (typeof maxFilesToEdit === "number" && Number.isFinite(maxFilesToEdit) && maxFilesToEdit > 4) {
    return null;
  }
  return `task.execute:${normalizedOrigin}:${normalizedSessionId}:${uniqueTargets.join("|")}`.toLowerCase();
}
function parseAutonomyRequestMetadata(value) {
  let root = asObject2(value);
  if (!root && typeof value === "string") {
    const text = value.trim();
    if (text) {
      try {
        root = asObject2(JSON.parse(text));
      } catch {
        root = null;
      }
    }
  }
  if (!root)
    return null;
  const rootOrigin = String(root.origin ?? "").trim().toLowerCase();
  const autonomy = asObject2(root.autonomy);
  const autonomyOrigin = String(autonomy?.origin ?? "").trim().toLowerCase();
  if (rootOrigin !== "autonomy" && autonomyOrigin !== "autonomy")
    return null;
  const payload = autonomy ?? root;
  return {
    origin: "autonomy",
    objectiveId: String(payload.objectiveId ?? payload.objective_id ?? "").trim() || undefined,
    runId: String(payload.runId ?? payload.run_id ?? "").trim() || undefined,
    snapshotId: String(payload.snapshotId ?? payload.snapshot_id ?? "").trim() || undefined,
    patternKey: String(payload.patternKey ?? payload.pattern_key ?? "").trim() || undefined,
    componentArea: asAutonomyComponentArea2(payload.componentArea ?? payload.component_area),
    targetPaths: normalizeMetadataTargetPaths(payload.targetPaths ?? payload.target_paths),
    writeGlobs: normalizeMetadataWriteGlobs(payload.writeGlobs ?? payload.write_globs)
  };
}
function ensureWriteGlobsCoverTargetPaths(targetPaths, writeGlobs) {
  const normalizedTargets = targetPaths.map((entry) => normalizeTargetPath(entry)).filter((entry) => Boolean(entry));
  const normalizedWriteGlobs = normalizeMetadataWriteGlobs(writeGlobs ?? []);
  const uncoveredTargets = normalizedTargets.filter((targetPath) => !normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob)));
  if (uncoveredTargets.length === 0) {
    return { normalizedWriteGlobs, uncoveredTargets: [], addedGlobs: [] };
  }
  const addedGlobs = [];
  const seen = new Set(normalizedWriteGlobs.map((entry) => entry.toLowerCase()));
  for (const targetPath of uncoveredTargets) {
    const exact = normalizeWriteGlob(targetPath);
    if (exact && !seen.has(exact.toLowerCase())) {
      seen.add(exact.toLowerCase());
      normalizedWriteGlobs.push(exact);
      addedGlobs.push(exact);
    }
    const tail = targetPath.split("/").pop() ?? targetPath;
    const looksDirectory = !tail.includes(".");
    if (looksDirectory) {
      const recursive = normalizeWriteGlob(`${targetPath}/**`);
      if (recursive && !seen.has(recursive.toLowerCase())) {
        seen.add(recursive.toLowerCase());
        normalizedWriteGlobs.push(recursive);
        addedGlobs.push(recursive);
      }
    }
  }
  return { normalizedWriteGlobs, uncoveredTargets, addedGlobs };
}
function buildExecutionGuidance(plan, targetPaths) {
  const lines = [];
  const targets = normalizePathHints(targetPaths.length > 0 ? targetPaths : plan.scope.write_globs ?? []);
  if (targets.length > 0) {
    lines.push("Target paths:");
    for (const path of targets)
      lines.push(`- ${path}`);
    lines.push("Path handling:");
    lines.push("- Treat all target paths as repo-relative to the current working directory.");
    lines.push("- Do not prepend a leading slash to target paths.");
  }
  lines.push("Scope:");
  lines.push(`- read_anywhere: ${plan.scope.read_anywhere ? "true" : "false"}`);
  lines.push(`- write_allowed: ${plan.scope.write_allowed ? "true" : "false"}`);
  if (plan.scope.max_files_to_edit && plan.scope.max_files_to_edit > 0) {
    lines.push(`- max_files_to_edit: ${plan.scope.max_files_to_edit}`);
  }
  if (Array.isArray(plan.scope.write_globs) && plan.scope.write_globs.length > 0) {
    lines.push("Write globs:");
    for (const glob of plan.scope.write_globs)
      lines.push(`- ${glob}`);
  }
  if (Array.isArray(plan.scope.forbidden_globs) && plan.scope.forbidden_globs.length > 0) {
    lines.push("Forbidden globs:");
    for (const glob of plan.scope.forbidden_globs)
      lines.push(`- ${glob}`);
  }
  if (plan.discovery) {
    if (plan.discovery.ripgrep_queries.length > 0) {
      lines.push("Discovery ripgrep queries:");
      for (const q of plan.discovery.ripgrep_queries)
        lines.push(`- ${q}`);
    }
    if (Array.isArray(plan.discovery.likely_dirs) && plan.discovery.likely_dirs.length > 0) {
      lines.push("Likely directories:");
      for (const d of plan.discovery.likely_dirs)
        lines.push(`- ${d}`);
    }
    if (Array.isArray(plan.discovery.keywords) && plan.discovery.keywords.length > 0) {
      lines.push("Discovery keywords:");
      for (const k of plan.discovery.keywords)
        lines.push(`- ${k}`);
    }
  }
  if (plan.acceptance_criteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const criterion of plan.acceptance_criteria)
      lines.push(`- ${criterion}`);
  }
  if (plan.validation_steps.length > 0) {
    lines.push("Validation steps:");
    for (const step of plan.validation_steps)
      lines.push(`- ${step}`);
  }
  return lines.join(`
`).trim();
}
var VALIDATION_COMMAND_PREFIX = /^(git|bun|bunx|node|python|python3|uv|pytest|vitest|jest|tsc|eslint|ruff|mypy|go|cargo|make|docker|pwsh|powershell|sh|bash)\b/i;
var VALIDATION_GENERIC_SAFE = /^(git\s+status\s+--porcelain|git\s+diff\b)/i;
var PATH_TOKEN_REGEX = /\b([A-Za-z0-9._/\-\\]+\.[A-Za-z0-9._-]+)\b/g;
function isCommandLikeValidationStep(step) {
  return VALIDATION_COMMAND_PREFIX.test(step);
}
function hasRelevantTargetPath(step, targetPaths) {
  if (targetPaths.length === 0)
    return true;
  const lower = step.toLowerCase();
  if (VALIDATION_GENERIC_SAFE.test(lower))
    return true;
  for (const target of targetPaths) {
    if (!target || target === ".")
      continue;
    if (lower.includes(target.toLowerCase()))
      return true;
  }
  const explicitPathTokens = [...step.matchAll(PATH_TOKEN_REGEX)].map((match) => String(match[1] ?? "").replace(/\\/g, "/").toLowerCase());
  if (explicitPathTokens.length === 0)
    return true;
  for (const token of explicitPathTokens) {
    for (const target of targetPaths) {
      const normalizedTarget = target.toLowerCase();
      if (token === normalizedTarget || token.startsWith(`${normalizedTarget}/`))
        return true;
    }
  }
  return false;
}
function normalizeValidationSteps(steps, targetPaths) {
  const out = [];
  const seen = new Set;
  for (const raw of steps) {
    const value = canonicalizeValidationCommandForBun(String(raw ?? "").trim());
    if (!value)
      continue;
    if (!isCommandLikeValidationStep(value))
      continue;
    if (!hasRelevantTargetPath(value, targetPaths))
      continue;
    const key = value.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
function defaultValidationStepsForRequest(prompt, targetPaths) {
  const text = prompt.toLowerCase();
  const concreteTargets = targetPaths.filter((entry) => entry && entry !== ".").slice(0, 4);
  if (/\b(lint|eslint|tsc|typecheck)\b/.test(text)) {
    return ["bun run lint"];
  }
  if (/\b(test|tests|pytest|vitest|jest|coverage)\b/.test(text)) {
    const pythonTarget = concreteTargets.some((target) => target.toLowerCase().endsWith(".py"));
    if (pythonTarget)
      return ["uv run pytest"];
    return ["bun test"];
  }
  if (concreteTargets.length > 0) {
    return [`git diff -- ${concreteTargets.join(" ")}`, "git status --porcelain"];
  }
  return ["git status --porcelain"];
}
function sanitizePlannerWorkerInstruction(workerInstruction, canonicalInstruction) {
  const value = canonicalizeInstructionTextForBun(String(workerInstruction ?? "").trim());
  if (!value)
    return "";
  const canonicalReference = canonicalizeInstructionTextForBun(String(canonicalInstruction ?? "").trim());
  if (value === canonicalReference)
    return "";
  const lower = value.toLowerCase();
  if (lower.includes("no worker instruction needed") || lower.includes("no additional instruction needed") || lower.includes("purely documentation update") || lower.includes("already updated") || lower.includes("nothing to do")) {
    return "";
  }
  if (!/\b(apply|append|add|edit|update|modify|change|replace|write|create|remove|run|verify|check|ensure)\b/i.test(value)) {
    return "";
  }
  return value;
}
function explainJobFailureFromLogs(logs, fallbackMessage, fallbackDetail) {
  const lines = logs.map((row) => toSingleLine(row.message, 420)).filter(Boolean);
  const joined = lines.join(`
`).toLowerCase();
  if (joined.includes("model preflight failed") && joined.includes("timed out")) {
    return "The worker could not reach the local LLM endpoint from Docker in time (model preflight timeout). This is usually LM Studio not responding quickly enough at host.docker.internal:1234.";
  }
  if (joined.includes("model selection exhausted")) {
    return "All candidate models failed preflight/execution, so OpenHands stopped before running the task.";
  }
  if (joined.includes("failed to load model") || joined.includes("insufficient system resources") || joined.includes("model loading was stopped")) {
    return "The selected model could not be loaded due to local resource constraints, and no fallback model succeeded.";
  }
  if (joined.includes("cannot truncate prompt with n_keep")) {
    return "The prompt exceeded the LM Studio/llama.cpp context constraints (n_keep >= n_ctx), so the request was rejected before execution.";
  }
  if (joined.includes("context size has been exceeded")) {
    return "The model context window was exceeded before execution could start.";
  }
  if (joined.includes("connection refused") || joined.includes("connection error")) {
    return "The worker could not connect to the configured LLM endpoint from the container.";
  }
  if (joined.includes("timeout reached for task.execute") || joined.includes("wrapper timed out")) {
    return "The wrapper hit its execution timeout before OpenHands returned a structured result.";
  }
  if (joined.includes("tool preflight returned non-json response") || joined.includes("preflight must return one valid json object in a single response")) {
    return "The worker stopped before running tools because strict tool preflight expected exactly one JSON object and the model returned non-JSON output.";
  }
  const lastLine = lines[lines.length - 1] ?? "";
  const fallback = [fallbackMessage, fallbackDetail].filter(Boolean).join(" | ");
  if (lastLine)
    return `Latest failure signal: ${lastLine}`;
  if (fallback)
    return `Failure signal: ${fallback}`;
  return "No additional diagnostic signal was found in the current log tail.";
}
function isStrictPreflightJsonFailure(message, detail) {
  const combined = `${message}
${detail}`.toLowerCase();
  return combined.includes("tool preflight returned non-json response") || combined.includes("preflight must return one valid json object in a single response");
}
function isNoChangeCompletionSummary(summary) {
  const text = summary.toLowerCase();
  return text.includes("no targetpath provided") || text.includes("no target path provided") || text.includes("no changes to commit") || text.includes("no file changes detected") || text.includes("no modified files were detected");
}
function extractClarificationFromCompletionSummary(summary) {
  const normalized = String(summary ?? "").trim();
  if (!normalized)
    return null;
  const match = normalized.match(/^OpenHands needs clarification:\s*(.+)$/i);
  if (!match)
    return null;
  const question = match[1]?.trim();
  return question ? question : null;
}
function isNoProgressBrokerFailure(message, detail) {
  const combined = `${message}
${detail}`.toLowerCase();
  return combined.includes("tool broker failed: did not reach done=true before limits") || combined.includes("model did not return done=true before max steps/timeout") || combined.includes("tool broker failed: no explicit validation command was executed");
}
function extractClarificationFromJobFailure(message, detail, logs = []) {
  if (isNoProgressBrokerFailure(message, detail)) {
    return "Please narrow the request to concrete target file(s), the exact test/assertion to add, and a specific validation command. " + "Example: edit `tests/remotebuddy.path-targeting.test.ts`, add one case, then run `bun test tests/remotebuddy.path-targeting.test.ts`.";
  }
  if (!Array.isArray(logs) || logs.length === 0)
    return null;
  const joined = logs.map((row) => String(row?.message ?? "")).join(`
`).toLowerCase();
  const hasBrokerSteps = joined.includes("[broker] step");
  const hasEditAction = joined.includes("append_line") || joined.includes("replace_text_once") || joined.includes("write_file");
  const hasCommandPolicyRejections = joined.includes("shell command rejected") || joined.includes("shell metacharacters are not allowed") || joined.includes("binary not allowed");
  if (hasBrokerSteps && !hasEditAction && hasCommandPolicyRejections) {
    return "Please provide a more bounded request with explicit file paths and a simple validation command (no shell pipes/chaining). " + "This helps the worker avoid exploration loops and apply an edit in one pass.";
  }
  return null;
}

class RemoteBuddyOrchestrator {
  static SESSION_MONITOR_MAX_WS_ERRORS = Math.max(1, Number.parseInt(process.env.REMOTEBUDDY_SESSION_MONITOR_MAX_WS_ERRORS ?? "6", 10) || 6);
  agentId = "remotebuddy-orchestrator";
  server;
  sessionId;
  authToken;
  repo;
  jobsDbPath;
  workerOnlineTtlMs;
  waitForWorkerMs;
  autoSpawnWorkers;
  minWorkers;
  maxWorkers;
  workerStartupTimeoutMs;
  spawnWorkerDocker;
  spawnWorkerRequireDocker;
  spawnWorkerImage;
  spawnWorkerPollMs;
  spawnWorkerHeartbeatMs;
  spawnWorkerLabels;
  workerpalsBinaryPath;
  workerpalsEnvFile;
  workerpalsEntrypoint;
  workerpalsUnavailableReason;
  statusHeartbeatMs;
  fetchFailureLogsOnJobFailure;
  executionBudgetInteractiveMs;
  executionBudgetNormalMs;
  executionBudgetBackgroundMs;
  finalizationBudgetMs;
  autonomousEngine;
  autonomyRuntimeEnabled;
  autonomyConfigPollMs;
  autonomyConfigPollTimer = null;
  managedWorkers = new Map;
  workerSpawnInFlight = null;
  workerSpawnCooldownUntil = 0;
  workerSpawnBackoffMs;
  workerAutoscalePollMs;
  lastWorkerAutoscaleAt = 0;
  comm;
  statusHeartbeatTimer = null;
  statusSessionReady = false;
  sessionEventStops = new Map;
  fatalSessionMonitors = new Set;
  seenJobFailures = new Set;
  seenJobCompletions = new Set;
  seenAutonomyFeedbackEvents = new Set;
  seenQuestionEvents = new Set;
  eventMonitorStartedAt = Date.now();
  jobsDb = null;
  disposed = false;
  sessionMonitorWsErrorCounts = new Map;
  chain = Promise.resolve();
  brain;
  idempotency;
  persistentMemory;
  recentContextBySession = new Map;
  memoryEnabled = false;
  memoryIncludeCrossSession = true;
  memoryMaxRecallItems = 12;
  memoryMaxRecallChars = 2400;
  memoryMaxSummaryChars = 420;
  memoryRetentionDays = 30;
  static MAX_CONTEXT = 20;
  static MAX_CONTEXT_ENTRY_CHARS = 1200;
  static CHAT_CONTEXT_MAX = 8;
  static CHAT_CONTEXT_ENTRY_CHARS = 420;
  constructor(opts) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.brain = opts.brain;
    this.idempotency = opts.idempotency;
    this.persistentMemory = opts.persistentMemory;
    this.jobsDbPath = opts.jobsDbPath;
    const remoteCfg = CONFIG.remotebuddy;
    this.workerOnlineTtlMs = Math.max(1000, remoteCfg.workerpalOnlineTtlMs);
    this.waitForWorkerMs = Math.max(0, remoteCfg.waitForWorkerpalMs);
    this.autoSpawnWorkers = remoteCfg.autoSpawnWorkerpals;
    this.minWorkers = Math.max(1, Math.min(remoteCfg.minWorkerpals, remoteCfg.maxWorkerpals));
    this.maxWorkers = Math.max(1, remoteCfg.maxWorkerpals);
    this.spawnWorkerDocker = remoteCfg.workerpalDocker;
    this.spawnWorkerRequireDocker = remoteCfg.workerpalRequireDocker;
    this.workerStartupTimeoutMs = resolveWorkerStartupTimeoutMs({
      configuredMs: remoteCfg.workerpalStartupTimeoutMs,
      docker: this.spawnWorkerDocker,
      dockerAgentStartupTimeoutMs: CONFIG.workerpals.dockerAgentStartupTimeoutMs
    });
    this.spawnWorkerImage = remoteCfg.workerpalImage;
    this.spawnWorkerPollMs = typeof remoteCfg.workerpalPollMs === "number" && remoteCfg.workerpalPollMs > 0 ? remoteCfg.workerpalPollMs : null;
    this.spawnWorkerHeartbeatMs = typeof remoteCfg.workerpalHeartbeatMs === "number" && remoteCfg.workerpalHeartbeatMs > 0 ? remoteCfg.workerpalHeartbeatMs : null;
    this.spawnWorkerLabels = remoteCfg.workerpalLabels;
    this.workerpalsBinaryPath = null;
    this.workerpalsEnvFile = null;
    this.workerpalsEntrypoint = null;
    this.workerpalsUnavailableReason = null;
    this.workerSpawnBackoffMs = Math.max(1000, Number.isFinite(remoteCfg.crashRestartBackoffMs) && remoteCfg.crashRestartBackoffMs > 0 ? remoteCfg.crashRestartBackoffMs : 3000);
    this.workerAutoscalePollMs = Math.max(1000, remoteCfg.pollMs);
    this.statusHeartbeatMs = Math.max(0, remoteCfg.statusHeartbeatMs);
    this.fetchFailureLogsOnJobFailure = parseEnabledFlag(process.env.REMOTEBUDDY_FETCH_FAILURE_LOGS, true);
    this.executionBudgetInteractiveMs = Math.max(60000, remoteCfg.executionBudgetInteractiveMs);
    this.executionBudgetNormalMs = Math.max(120000, remoteCfg.executionBudgetNormalMs);
    this.executionBudgetBackgroundMs = Math.max(180000, remoteCfg.executionBudgetBackgroundMs);
    this.finalizationBudgetMs = Math.max(30000, remoteCfg.finalizationBudgetMs);
    this.autonomyRuntimeEnabled = remoteCfg.autonomy.enabled;
    this.autonomyConfigPollMs = Math.max(1000, Number.parseInt(process.env.REMOTEBUDDY_AUTONOMY_CONFIG_POLL_MS ?? "3000", 10) || 3000);
    this.memoryEnabled = remoteCfg.memory.enabled;
    this.memoryIncludeCrossSession = remoteCfg.memory.includeCrossSession;
    this.memoryMaxRecallItems = Math.max(1, remoteCfg.memory.maxRecallItems);
    this.memoryMaxRecallChars = Math.max(120, remoteCfg.memory.maxRecallChars);
    this.memoryMaxSummaryChars = Math.max(64, remoteCfg.memory.maxSummaryChars);
    this.memoryRetentionDays = Math.max(1, remoteCfg.memory.retentionDays);
    this.repo = detectRepoRoot(process.cwd());
    const embeddedWorkerpalsBinary = String(process.env.PUSHPALS_WORKERPALS_BIN ?? "").trim();
    const workerpalsEntrypoint = resolve5(this.repo, "apps", "workerpals", "src", "workerpals_main.ts");
    if (embeddedWorkerpalsBinary && existsSync5(embeddedWorkerpalsBinary)) {
      this.workerpalsBinaryPath = embeddedWorkerpalsBinary;
    } else if (existsSync5(workerpalsEntrypoint)) {
      this.workerpalsEntrypoint = workerpalsEntrypoint;
      const envPath = resolve5(this.repo, ".env");
      this.workerpalsEnvFile = existsSync5(envPath) ? envPath : null;
    } else if (this.autoSpawnWorkers) {
      this.autoSpawnWorkers = false;
      this.workerpalsUnavailableReason = embeddedWorkerpalsBinary ? `WorkerPal embedded binary is missing (${embeddedWorkerpalsBinary}) and source entrypoint is missing (${workerpalsEntrypoint})` : `WorkerPal source entrypoint is missing (${workerpalsEntrypoint})`;
      console.warn(`[RemoteBuddy] Auto-spawn disabled: ${this.workerpalsUnavailableReason}.`);
      console.warn("[RemoteBuddy] No embedded WorkerPal runtime is available for auto-spawn; start WorkerPals manually if execution workers are required.");
    }
    if (this.memoryEnabled) {
      this.persistentMemory.purgeExpired(this.memoryRetentionDays, this.repo);
    }
    this.comm = new CommunicationManager({
      serverUrl: this.server,
      sessionId: this.sessionId,
      authToken: this.authToken,
      from: `agent:${this.agentId}`
    });
    this.autonomousEngine = new RemoteBuddyAutonomousEngine({
      server: this.server,
      sessionId: this.sessionId,
      authToken: this.authToken,
      repo: this.repo,
      llm: opts.llm,
      comm: this.comm,
      config: CONFIG
    });
    this.autonomousEngine.setRuntimeEnabled(this.autonomyRuntimeEnabled);
    console.log(`[RemoteBuddy] Detected repo root: ${this.repo}`);
    console.log(`[RemoteBuddy] Worker scheduler: min=${this.minWorkers} max=${this.maxWorkers} autoSpawn=${this.autoSpawnWorkers ? "on" : "off"} wait=${this.waitForWorkerMs}ms`);
    console.log(`[RemoteBuddy] Budgets: interactive=${this.executionBudgetInteractiveMs}ms normal=${this.executionBudgetNormalMs}ms background=${this.executionBudgetBackgroundMs}ms finalization=${this.finalizationBudgetMs}ms`);
    console.log(`[RemoteBuddy] Failure log fetch on job failures: ${this.fetchFailureLogsOnJobFailure ? "on" : "off"}`);
    console.log(`[RemoteBuddy] Persistent memory: ${this.memoryEnabled ? "on" : "off"} crossSession=${this.memoryIncludeCrossSession ? "on" : "off"} recallItems=${this.memoryMaxRecallItems} recallChars=${this.memoryMaxRecallChars} retentionDays=${this.memoryRetentionDays}`);
    console.log(`[RemoteBuddy] Autonomous engine: ${CONFIG.remotebuddy.autonomy.enabled ? "enabled" : "disabled"} tick=${CONFIG.remotebuddy.autonomy.tickIntervalMs}ms maxConcurrentObjectives=${CONFIG.remotebuddy.autonomy.maxConcurrentObjectives} maxDispatchPerHour=${CONFIG.remotebuddy.autonomy.maxDispatchPerHour} exploreRate=${CONFIG.remotebuddy.autonomy.exploreRate.toFixed(2)} allowDirtyWorktree=${CONFIG.remotebuddy.autonomy.allowDirtyWorktree ? "on" : "off"}`);
    console.log(`[RemoteBuddy] Autonomy runtime-config polling: every ${this.autonomyConfigPollMs}ms`);
  }
  async emitStartupStatus() {
    this.statusSessionReady = await this.ensureSessionWithRetry();
    if (!this.statusSessionReady) {
      console.warn("[RemoteBuddy] Could not ensure session for startup presence events");
      return;
    }
    const startupDeadlineMs = Date.now() + 15000;
    let startupStatusOk = false;
    while (!this.disposed) {
      startupStatusOk = await this.comm.status(this.agentId, "idle", "RemoteBuddy online and waiting for requests");
      if (startupStatusOk)
        break;
      this.statusSessionReady = false;
      if (Date.now() >= startupDeadlineMs)
        break;
      await Bun.sleep(1000);
      this.statusSessionReady = await this.ensureSessionWithRetry(3, 400, 2500);
    }
    if (!startupStatusOk) {
      console.warn("[RemoteBuddy] Failed to emit startup status event");
    }
  }
  startStatusHeartbeat() {
    if (this.statusHeartbeatMs <= 0 || this.statusHeartbeatTimer)
      return;
    this.statusHeartbeatTimer = setInterval(() => {
      if (this.disposed)
        return;
      (async () => {
        if (!this.statusSessionReady) {
          this.statusSessionReady = await this.ensureSessionWithRetry(3, 400, 2500);
        }
        const ok = await this.comm.status(this.agentId, "idle", "RemoteBuddy heartbeat");
        if (!ok) {
          this.statusSessionReady = false;
        }
      })();
    }, this.statusHeartbeatMs);
  }
  async ensureSessionWithRetry(sessionId = this.sessionId, maxRetries = 20, baseDelayMs = 500, maxDelayMs = 5000) {
    for (let attempt = 1;attempt <= maxRetries && !this.disposed; attempt++) {
      try {
        const res = await fetch(`${this.server}/sessions`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ sessionId })
        });
        if (res.ok)
          return true;
      } catch {}
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await Bun.sleep(delayMs);
    }
    return false;
  }
  authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (this.authToken)
      h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }
  async assistantMessage(sessionId, text, meta = {}) {
    try {
      const ok = await this.comm.assistantMessageToSession(sessionId, text, meta);
      if (!ok) {
        console.error(`[RemoteBuddy] assistant_message failed for session ${sessionId || "(unknown)"}`);
      }
    } catch (err) {
      console.error(`[RemoteBuddy] assistant_message error for session ${sessionId || "(unknown)"}:`, err);
    }
  }
  async sendCommand(sessionId, cmd) {
    try {
      const ok = await this.comm.emitToSession(sessionId, cmd.type, cmd.payload, {
        to: cmd.to,
        correlationId: cmd.correlationId,
        turnId: cmd.turnId,
        parentId: cmd.parentId
      });
      if (!ok) {
        console.error(`[RemoteBuddy] Command ${cmd.type} failed for session ${sessionId || "(unknown)"}`);
      }
    } catch (err) {
      console.error(`[RemoteBuddy] Command ${cmd.type} error for session ${sessionId || "(unknown)"}:`, err);
    }
  }
  async fetchJobLogs(jobId, limit = 80) {
    try {
      const res = await fetch(`${this.server}/jobs/${jobId}/logs?limit=${Math.max(1, Math.min(500, limit))}`, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (!res.ok)
        return [];
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.logs))
        return [];
      return data.logs.filter((row) => row && typeof row.message === "string").slice(-80);
    } catch {
      return [];
    }
  }
  markAutonomyFeedbackEventSeen(eventId) {
    const id = String(eventId ?? "").trim();
    if (!id)
      return true;
    if (this.seenAutonomyFeedbackEvents.has(id))
      return false;
    this.seenAutonomyFeedbackEvents.add(id);
    if (this.seenAutonomyFeedbackEvents.size > 2000) {
      const oldest = this.seenAutonomyFeedbackEvents.values().next().value;
      if (typeof oldest === "string" && oldest) {
        this.seenAutonomyFeedbackEvents.delete(oldest);
      }
    }
    return true;
  }
  markQuestionEventSeen(eventId) {
    const id = String(eventId ?? "").trim();
    if (!id)
      return true;
    if (this.seenQuestionEvents.has(id))
      return false;
    this.seenQuestionEvents.add(id);
    if (this.seenQuestionEvents.size > 2000) {
      const oldest = this.seenQuestionEvents.values().next().value;
      if (typeof oldest === "string" && oldest) {
        this.seenQuestionEvents.delete(oldest);
      }
    }
    return true;
  }
  async fetchLatestAutonomyFeedbackInsight(params) {
    const objectiveId = String(params.objectiveId ?? "").trim();
    const patternKey = String(params.patternKey ?? "").trim();
    const query = new URLSearchParams;
    if (objectiveId)
      query.set("objectiveId", objectiveId);
    if (patternKey)
      query.set("patternKey", patternKey);
    query.set("limit", "1");
    query.set("feedbackLimit", "3");
    const suffix = query.toString();
    try {
      const res = await fetch(`${this.server}/autonomy/insights${suffix ? `?${suffix}` : ""}`, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (!res.ok)
        return null;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.recentPrFeedback) || data.recentPrFeedback.length === 0) {
        return null;
      }
      const first = data.recentPrFeedback[0];
      if (!first || typeof first !== "object" || Array.isArray(first))
        return null;
      return first;
    } catch {
      return null;
    }
  }
  async rememberAutonomyFeedbackFromEvent(payload, sessionId = this.sessionId) {
    const objectiveId = toSingleLine(payload.objectiveId, 128) || "unknown";
    const patternKey = toSingleLine(payload.patternKey, 128) || "unknown";
    const outcome = toSingleLine(payload.outcome, 120) || "recorded";
    const success = Boolean(payload.success);
    const insight = await this.fetchLatestAutonomyFeedbackInsight({
      objectiveId: objectiveId !== "unknown" ? objectiveId : undefined,
      patternKey: patternKey !== "unknown" ? patternKey : undefined
    });
    const summary = toSingleLine(insight?.summary ?? payload.feedbackSummary ?? payload.outcomeReason ?? "", 320);
    const verdict = toSingleLine(insight?.verdict ?? "", 80);
    const source = toSingleLine(insight?.source ?? "", 64);
    const reviewScoreRaw = Number(insight?.reviewScore);
    const reviewThresholdRaw = Number(insight?.reviewThreshold);
    const reviewScore = Number.isFinite(reviewScoreRaw) ? reviewScoreRaw : null;
    const reviewThreshold = Number.isFinite(reviewThresholdRaw) ? reviewThresholdRaw : null;
    const commentCountRaw = Number(insight?.commentCount);
    const commentCount = Number.isFinite(commentCountRaw) ? Math.max(0, Math.floor(commentCountRaw)) : 0;
    const commentExamples = Array.isArray(insight?.comments) ? insight.comments.slice(0, 2).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return "";
      const row = entry;
      const author = toSingleLine(row.user_login ?? row.userLogin ?? row.author, 32);
      const body = toSingleLine(row.body, 140);
      if (!body)
        return "";
      return `${author ? `@${author}: ` : ""}${body}`;
    }).filter(Boolean) : [];
    const parts = [
      `objective=${objectiveId}`,
      `pattern=${patternKey}`,
      `outcome=${outcome}`,
      `success=${success ? "true" : "false"}`
    ];
    if (source)
      parts.push(`source=${source}`);
    if (verdict)
      parts.push(`verdict=${verdict}`);
    if (reviewScore != null || reviewThreshold != null) {
      parts.push(`review=${reviewScore != null ? reviewScore.toFixed(2) : "?"}/${reviewThreshold != null ? reviewThreshold.toFixed(2) : "?"}`);
    }
    if (commentCount > 0)
      parts.push(`comments=${commentCount}`);
    if (summary)
      parts.push(`why=${summary}`);
    if (commentExamples.length > 0) {
      parts.push(`examples=${commentExamples.join(" || ")}`);
    }
    const structured = parts.join(" | ");
    this.pushContext(`[autonomy_feedback] ${toSingleLine(structured, 1100)}`, sessionId);
    this.rememberPersistentMemory("autonomy_feedback", structured, null, sessionId);
  }
  async handleObservedJobFailure(sessionId, envelope, jobId, message, detail) {
    const shortJob = jobId.slice(0, 8);
    this.recycleWorkerForCodexUnavailableFailure(jobId, message, detail);
    const clarificationQuestion = extractClarificationFromJobFailure(message, detail);
    if (clarificationQuestion) {
      const clarificationMsg = `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationQuestion}

` + "Reply with the missing details and I will enqueue a focused follow-up request.";
      await this.assistantMessage(sessionId, clarificationMsg, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id
      });
      return;
    }
    const willFetchLogs = this.fetchFailureLogsOnJobFailure;
    const fetchMsg = isStrictPreflightJsonFailure(message, detail) ? willFetchLogs ? `WorkerPal job ${shortJob} stopped before tool execution because strict preflight expected one JSON response and got non-JSON output. I'm fetching logs now to diagnose what happened.` : `WorkerPal job ${shortJob} stopped before tool execution because strict preflight expected one JSON response and got non-JSON output.` : willFetchLogs ? `WorkerPal job ${shortJob} failed: ${message}${detail ? ` (${detail})` : ""} I got an error and I'm fetching logs now to diagnose what happened.` : `WorkerPal job ${shortJob} failed: ${message}${detail ? ` (${detail})` : ""}`;
    await this.assistantMessage(sessionId, fetchMsg, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id
    });
    if (!willFetchLogs) {
      const explanation2 = explainJobFailureFromLogs([], message, detail);
      await this.assistantMessage(sessionId, `Diagnosis for job ${shortJob}: ${explanation2}`, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id
      });
      return;
    }
    console.warn(`[RemoteBuddy] Fetching failure logs for job ${jobId}...`);
    const logs = await this.fetchJobLogs(jobId, 80);
    const clarificationFromLogs = extractClarificationFromJobFailure(message, detail, logs);
    if (clarificationFromLogs) {
      const tail2 = logs.slice(-6).map((row) => toSingleLine(row.message, 220)).filter(Boolean);
      const tailText2 = tail2.length ? `
Recent logs:
\`\`\`
${tail2.join(`
`)}
\`\`\`` : "";
      const clarificationMsg = `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationFromLogs}

` + "Reply with the missing details and I will enqueue a focused follow-up request." + tailText2;
      await this.assistantMessage(sessionId, clarificationMsg, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id
      });
      return;
    }
    const explanation = explainJobFailureFromLogs(logs, message, detail);
    const tail = logs.slice(-6).map((row) => toSingleLine(row.message, 220)).filter(Boolean);
    const tailText = tail.length ? `
Recent logs:
\`\`\`
${tail.join(`
`)}
\`\`\`` : "";
    await this.assistantMessage(sessionId, `Diagnosis for job ${shortJob}: ${explanation}${tailText}`, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id
    });
  }
  handleSessionEvent(envelope) {
    if (envelope.type !== "job_failed" && envelope.type !== "job_completed" && envelope.type !== "autonomy_feedback_recorded" && envelope.type !== "question_asked" && envelope.type !== "question_answered") {
      return;
    }
    const tsMs = Date.parse(String(envelope.ts ?? ""));
    if (Number.isFinite(tsMs) && tsMs + 2000 < this.eventMonitorStartedAt)
      return;
    const eventSessionId = String(envelope.sessionId ?? "").trim() || this.sessionId;
    if (envelope.type === "question_asked") {
      if (!this.markQuestionEventSeen(String(envelope.id ?? "")))
        return;
      const payload2 = asObject2(envelope.payload);
      if (!payload2)
        return;
      const questionId = toSingleLine(payload2.questionId, 128);
      const objectiveId = toSingleLine(payload2.objectiveId, 128);
      const question = toSingleLine(payload2.question, 320);
      if (!question)
        return;
      this.pushContext(`[autonomy_question] objective=${objectiveId || "unknown"} question=${question}`, eventSessionId);
      this.rememberPersistentMemory("autonomy_question", `Objective ${objectiveId || "unknown"} requires clarification: ${question}`, null, eventSessionId);
      this.assistantMessage(eventSessionId, `Autonomy objective ${objectiveId || "unknown"} needs clarification${questionId ? ` (${questionId})` : ""}: ${question}`, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id
      });
      return;
    }
    if (envelope.type === "question_answered") {
      if (!this.markQuestionEventSeen(String(envelope.id ?? "")))
        return;
      const payload2 = asObject2(envelope.payload);
      if (!payload2)
        return;
      const questionId = toSingleLine(payload2.questionId, 128);
      const objectiveId = toSingleLine(payload2.objectiveId, 128);
      const status = toSingleLine(payload2.status, 32).toLowerCase();
      const answerSummary = toSingleLine(payload2.answerSummary, 280);
      const contextLine = `[autonomy_question_answered] objective=${objectiveId || "unknown"} ` + `question=${questionId || "unknown"} status=${status || "unknown"}` + (answerSummary ? ` detail=${answerSummary}` : "");
      this.pushContext(contextLine, eventSessionId);
      this.rememberPersistentMemory("autonomy_question_answered", contextLine, null, eventSessionId);
      const note2 = status === "valid" ? `Captured clarification for autonomy objective ${objectiveId || "unknown"}; resuming execution.` : `Clarification answer for autonomy objective ${objectiveId || "unknown"} was invalid${answerSummary ? `: ${answerSummary}` : "."}`;
      this.assistantMessage(eventSessionId, note2, {
        correlationId: envelope.correlationId,
        turnId: envelope.turnId,
        parentId: envelope.id
      });
      return;
    }
    if (envelope.type === "autonomy_feedback_recorded") {
      if (!this.markAutonomyFeedbackEventSeen(String(envelope.id ?? "")))
        return;
      const payload2 = asObject2(envelope.payload);
      if (!payload2)
        return;
      this.rememberAutonomyFeedbackFromEvent(payload2, eventSessionId);
      return;
    }
    if (envelope.type === "job_failed") {
      const payload2 = envelope.payload;
      const jobId2 = String(payload2.jobId ?? "").trim();
      const message = toSingleLine(payload2.message, 220);
      const detail = toSingleLine(payload2.detail, 220);
      if (!jobId2 || !message)
        return;
      const dedupeKey = `${jobId2}:${message}`;
      if (this.seenJobFailures.has(dedupeKey))
        return;
      this.seenJobFailures.add(dedupeKey);
      const failureLine = `[job_failed ${jobId2}] ${message}${detail ? ` | ${detail}` : ""}`;
      this.pushContext(failureLine, eventSessionId);
      this.rememberPersistentMemory("job_failed", `Job ${jobId2.slice(0, 8)} failed: ${toSingleLine(`${message}${detail ? ` (${detail})` : ""}`, 360)}`, null, eventSessionId);
      console.warn(`[RemoteBuddy] Observed WorkerPal failure ${jobId2}: ${message}`);
      this.handleObservedJobFailure(eventSessionId, envelope, jobId2, message, detail);
      return;
    }
    const payload = envelope.payload;
    const jobId = String(payload.jobId ?? "").trim();
    const summary = toSingleLine(payload.summary, 240) || "Job completed";
    if (!jobId)
      return;
    if (/startup warmup completed/i.test(summary))
      return;
    if (this.seenJobCompletions.has(jobId))
      return;
    this.seenJobCompletions.add(jobId);
    this.pushContext(`[job_completed ${jobId}] ${summary}`, eventSessionId);
    this.rememberPersistentMemory("job_completed", `Job ${jobId.slice(0, 8)} completed: ${toSingleLine(summary, 360)}`, null, eventSessionId);
    const shortJob = jobId.slice(0, 8);
    const clarificationQuestion = extractClarificationFromCompletionSummary(summary);
    const note = clarificationQuestion ? `WorkerPal job ${shortJob} needs clarification before making changes: ${clarificationQuestion}

Please reply with the missing details and I will enqueue a follow-up request.` : isNoChangeCompletionSummary(summary) ? `WorkerPal job ${shortJob} completed: ${summary}. No files were changed, so no commit was created.` : `WorkerPal job ${shortJob} completed: ${summary}.`;
    this.assistantMessage(eventSessionId, note, {
      correlationId: envelope.correlationId,
      turnId: envelope.turnId,
      parentId: envelope.id
    });
  }
  ensureSessionEventMonitor(sessionId, options = {}) {
    const normalizedSessionId = String(sessionId ?? "").trim() || this.sessionId;
    if (options.fatalOnWsBudgetExhaustion) {
      this.fatalSessionMonitors.add(normalizedSessionId);
    }
    if (this.sessionEventStops.has(normalizedSessionId)) {
      return;
    }
    const stop = this.comm.subscribeSessionEventsForSession(normalizedSessionId, (envelope) => {
      this.handleSessionEvent(envelope);
    }, {
      onOpen: () => {
        this.sessionMonitorWsErrorCounts.set(normalizedSessionId, 0);
      },
      onError: (message) => {
        console.warn(`[RemoteBuddy] Session monitor (${normalizedSessionId}) failed: ${message}`);
        if (!/\[SessionEvents\] (WebSocket error|Failed to connect)/.test(message))
          return;
        const nextCount = (this.sessionMonitorWsErrorCounts.get(normalizedSessionId) ?? 0) + 1;
        this.sessionMonitorWsErrorCounts.set(normalizedSessionId, nextCount);
        if (!this.fatalSessionMonitors.has(normalizedSessionId) || nextCount < RemoteBuddyOrchestrator.SESSION_MONITOR_MAX_WS_ERRORS) {
          return;
        }
        this.fatalSessionMonitors.delete(normalizedSessionId);
        console.error(`[RemoteBuddy] Session monitor ${normalizedSessionId} exceeded retry budget (${RemoteBuddyOrchestrator.SESSION_MONITOR_MAX_WS_ERRORS} transport errors). Bailing out.`);
        this.dispose().finally(() => {
          setTimeout(() => process.exit(1), 0);
        });
      }
    });
    this.sessionEventStops.set(normalizedSessionId, stop);
  }
  startSessionEventMonitor() {
    this.ensureSessionEventMonitor(this.sessionId, { fatalOnWsBudgetExhaustion: true });
  }
  async enqueueJob(taskId, kind, sessionId, params, targetWorkerId = null) {
    try {
      const payload = {
        taskId,
        sessionId,
        kind,
        params
      };
      const dedupeKey = buildTaskExecuteDedupeKey(sessionId, params);
      if (dedupeKey)
        payload.dedupeKey = dedupeKey;
      if (targetWorkerId)
        payload.targetWorkerId = targetWorkerId;
      const res = await fetch(`${this.server}/jobs/enqueue`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[RemoteBuddy] Enqueue failed: ${res.status} ${err}`);
        return null;
      }
      const data = await res.json();
      const resolvedTaskId = String(data.taskId ?? taskId).trim();
      if (!data.ok || !data.jobId || !resolvedTaskId) {
        console.error(`[RemoteBuddy] Enqueue response missing jobId:`, data);
        return null;
      }
      return {
        jobId: data.jobId,
        taskId: resolvedTaskId,
        deduped: data.deduped === true
      };
    } catch (err) {
      console.error(`[RemoteBuddy] Enqueue error:`, err);
      return null;
    }
  }
  sessionContext(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim() || this.sessionId;
    let context = this.recentContextBySession.get(normalizedSessionId);
    if (!context) {
      context = [];
      this.recentContextBySession.set(normalizedSessionId, context);
    }
    return context;
  }
  pushContext(text, sessionId = this.sessionId) {
    const normalized = String(text ?? "").trim();
    if (!normalized)
      return;
    const capped = normalized.length <= RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS ? normalized : `${normalized.slice(0, RemoteBuddyOrchestrator.MAX_CONTEXT_ENTRY_CHARS - 16)}
...[truncated]`;
    const context = this.sessionContext(sessionId);
    context.push(capped);
    if (context.length > RemoteBuddyOrchestrator.MAX_CONTEXT) {
      context.shift();
    }
  }
  getChatContextSnapshot(sessionId = this.sessionId) {
    const filtered = this.sessionContext(sessionId).filter((entry) => !entry.startsWith("[enhanced]"));
    return filtered.slice(-RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX).map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }
  planningContextSnapshot(priority, sessionId = this.sessionId) {
    const filtered = this.sessionContext(sessionId).filter((entry) => !entry.startsWith("[enhanced]"));
    const limit = priority === "interactive" ? 6 : RemoteBuddyOrchestrator.CHAT_CONTEXT_MAX;
    return filtered.slice(-limit).map((entry) => toSingleLine(entry, RemoteBuddyOrchestrator.CHAT_CONTEXT_ENTRY_CHARS));
  }
  persistentPlanningContextSnapshot(priority, sessionId = this.sessionId) {
    if (!this.memoryEnabled)
      return [];
    const maxItems = priority === "interactive" ? Math.max(2, Math.min(this.memoryMaxRecallItems, 6)) : this.memoryMaxRecallItems;
    try {
      return this.persistentMemory.recallForPlanning({
        repoRoot: this.repo,
        sessionId,
        includeCurrentSession: true,
        includeCrossSession: this.memoryIncludeCrossSession,
        maxItems,
        maxChars: this.memoryMaxRecallChars
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not recall persistent planning memory:", err);
      return [];
    }
  }
  rememberPersistentMemory(kind, summary, requestId = null, sessionId = this.sessionId) {
    if (!this.memoryEnabled)
      return;
    try {
      this.persistentMemory.remember({
        repoRoot: this.repo,
        sessionId,
        requestId,
        kind,
        summary
      }, {
        maxSummaryChars: this.memoryMaxSummaryChars,
        retentionDays: this.memoryRetentionDays
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not persist planning memory:", err);
    }
  }
  buildPlanningContext(priority, sessionId = this.sessionId) {
    const fromMemory = this.persistentPlanningContextSnapshot(priority, sessionId);
    const live = this.planningContextSnapshot(priority, sessionId);
    if (fromMemory.length === 0)
      return live;
    const merged = [...fromMemory, ...live];
    const out = [];
    const seen = new Set;
    for (const entry of merged) {
      const line = String(entry ?? "").trim();
      if (!line || seen.has(line))
        continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }
  getRecentContextSnapshot(sessionId = this.sessionId) {
    return this.sessionContext(sessionId).slice(-RemoteBuddyOrchestrator.MAX_CONTEXT);
  }
  executionBudgetForPriority(priority) {
    switch (priority) {
      case "interactive":
        return this.executionBudgetInteractiveMs;
      case "background":
        return this.executionBudgetBackgroundMs;
      default:
        return this.executionBudgetNormalMs;
    }
  }
  chooseExecutionLane(prompt, plan, targetPathCount) {
    if (plan.intent === "status")
      return "deterministic";
    if (plan.risk_level === "low" && targetPathCount >= 1 && targetPathCount <= 3 && plan.validation_steps.length <= 4) {
      if (prompt.trim().length <= 800)
        return "deterministic";
    }
    return plan.lane;
  }
  shouldForceDirectReply(prompt, intent) {
    if (intent !== "chat" && intent !== "status")
      return false;
    return !isExecutionIntent(prompt, extractExplicitTargetPath(prompt));
  }
  resolveWorkerIdForJob(jobId) {
    const id = String(jobId ?? "").trim();
    if (!id)
      return null;
    try {
      if (!this.jobsDb) {
        this.jobsDb = new Database3(this.jobsDbPath);
      }
      const row = this.jobsDb.prepare("SELECT workerId FROM jobs WHERE id = ? LIMIT 1").get(id);
      const workerId = String(row?.workerId ?? "").trim();
      return workerId || null;
    } catch (err) {
      console.warn(`[RemoteBuddy] Could not resolve worker for failed job ${id}:`, err);
      return null;
    }
  }
  async terminateManagedWorkerProcess(workerId, proc, reason, timeoutMs = 8000) {
    const waitForExit = async (waitMs) => {
      const settled = await Promise.race([
        proc.exited.then(() => true).catch(() => true),
        Bun.sleep(Math.max(0, waitMs)).then(() => false)
      ]);
      return settled;
    };
    let exited = false;
    try {
      proc.kill("SIGTERM");
    } catch {}
    exited = await waitForExit(timeoutMs);
    if (!exited) {
      if (process.platform === "win32" && Number.isFinite(proc.pid ?? Number.NaN)) {
        try {
          Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore"
          });
        } catch {}
      } else {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      exited = await waitForExit(2000);
    }
    if (!exited) {
      console.warn(`[RemoteBuddy] WorkerPal ${workerId} did not terminate cleanly (${reason}); process may still be running.`);
    }
    this.managedWorkers.delete(workerId);
  }
  async recycleWorkerForCodexUnavailableFailure(jobId, message, detail) {
    if (!isCodexUnavailableFailureSignal(message, detail))
      return;
    const workerId = this.resolveWorkerIdForJob(jobId);
    if (!workerId) {
      console.warn(`[RemoteBuddy] Codex unavailable failure for job ${jobId}, but no workerId was found; cannot recycle.`);
      return;
    }
    const proc = this.managedWorkers.get(workerId);
    if (!proc) {
      console.warn(`[RemoteBuddy] Codex unavailable failure for job ${jobId}; worker ${workerId} is not managed by RemoteBuddy, skipping recycle.`);
      return;
    }
    console.warn(`[RemoteBuddy] Codex unavailable for job ${jobId}; recycling WorkerPal ${workerId}.`);
    await this.terminateManagedWorkerProcess(workerId, proc, "codex unavailable recycle");
    if (!this.autoSpawnWorkers) {
      console.warn(`[RemoteBuddy] Auto-spawn is disabled; WorkerPal ${workerId} was recycled without replacement.`);
      return;
    }
    const replacement = await this.spawnWorker();
    if (replacement) {
      console.log(`[RemoteBuddy] WorkerPal recycle complete: replaced ${workerId} with ${replacement}.`);
      return;
    }
    console.warn(`[RemoteBuddy] WorkerPal ${workerId} was recycled, but replacement did not become ready in time.`);
  }
  getRecentJobContext(limit = 12, sessionId = this.sessionId) {
    try {
      if (!this.jobsDb) {
        this.jobsDb = new Database3(this.jobsDbPath);
      }
      const rows = this.jobsDb.prepare(`SELECT id, taskId, kind, status, workerId, result, error, updatedAt
           FROM jobs
           WHERE sessionId = ?
           ORDER BY updatedAt DESC
           LIMIT ?`).all(sessionId, Math.max(1, Math.min(limit, 50)));
      return rows.map((row) => {
        let summary = "";
        let errorMessage = "";
        try {
          if (row.result) {
            const parsed = JSON.parse(row.result);
            summary = toSingleLine(parsed.summary ?? "");
          }
        } catch {
          summary = "";
        }
        try {
          if (row.error) {
            const parsed = JSON.parse(row.error);
            errorMessage = toSingleLine(parsed.message ?? parsed.detail ?? "");
          }
        } catch {
          errorMessage = toSingleLine(row.error ?? "");
        }
        return {
          jobId: row.id,
          taskId: row.taskId,
          kind: row.kind,
          status: row.status,
          workerId: row.workerId,
          summary,
          error: errorMessage,
          updatedAt: row.updatedAt
        };
      });
    } catch (err) {
      console.warn("[RemoteBuddy] Could not read recent job context:", err);
      return [];
    }
  }
  async fetchWorkers() {
    try {
      const res = await fetch(`${this.server}/workers?ttlMs=${this.workerOnlineTtlMs}`, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (!res.ok)
        return [];
      const data = await res.json();
      return data.ok ? data.workers ?? [] : [];
    } catch {
      return [];
    }
  }
  async fetchWorkerAutoscaleSnapshot() {
    try {
      const res = await fetch(`${this.server}/workers/autoscale?ttlMs=${this.workerOnlineTtlMs}`, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (!res.ok)
        return null;
      const data = await res.json();
      if (!data.ok || !data.workers || !data.jobs)
        return null;
      return {
        workers: data.workers,
        jobs: data.jobs,
        prs: {
          openUnmerged: Math.max(0, Math.floor(Number(data.prs?.openUnmerged ?? 0)))
        }
      };
    } catch {
      return null;
    }
  }
  pickIdleWorker(workers) {
    const idle = workers.filter((worker) => worker.isOnline && worker.status !== "offline" && worker.activeJobCount === 0).sort((a, b) => Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat));
    return idle[0] ?? null;
  }
  pickOnlineWorker(workers, preferredWorkerId) {
    const online = workers.filter((worker) => worker.isOnline && worker.status !== "offline").sort((a, b) => Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat));
    if (preferredWorkerId) {
      return online.find((worker) => worker.workerId === preferredWorkerId) ?? null;
    }
    return online[0] ?? null;
  }
  async waitForOnlineWorker(timeoutMs, preferredWorkerId) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const workers = await this.fetchWorkers();
      const online = this.pickOnlineWorker(workers, preferredWorkerId);
      if (online)
        return online;
      if (Date.now() >= deadline)
        return null;
      await Bun.sleep(500);
    }
  }
  async waitForIdleWorker(timeoutMs, preferredWorkerId) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const workers = await this.fetchWorkers();
      if (preferredWorkerId) {
        const preferred = workers.find((worker) => worker.workerId === preferredWorkerId && worker.isOnline && worker.status !== "offline" && worker.activeJobCount === 0);
        if (preferred)
          return preferred;
      }
      const idle = this.pickIdleWorker(workers);
      if (idle)
        return idle;
      if (Date.now() >= deadline)
        return null;
      await Bun.sleep(500);
    }
  }
  onlineWorkers(workers) {
    return workers.filter((worker) => worker.isOnline && worker.status !== "offline");
  }
  currentWorkerUnavailableReason() {
    if (this.workerpalsUnavailableReason) {
      return this.workerpalsUnavailableReason;
    }
    if (this.autoSpawnWorkers) {
      if (this.spawnWorkerDocker && this.spawnWorkerRequireDocker) {
        return "Docker-backed WorkerPal auto-spawn did not produce an online worker. Verify Docker is installed and running, then retry.";
      }
      return "WorkerPal auto-spawn did not produce an online worker.";
    }
    return "No online WorkerPal backends and auto-spawn is disabled.";
  }
  desiredWorkerCountFromAutoscaleSnapshot(snapshot) {
    const prBacklogFloor = Math.max(0, snapshot.prs.openUnmerged) > 0 ? Math.min(2, this.maxWorkers) : 0;
    return Math.max(this.minWorkers, Math.min(this.maxWorkers, Math.max(prBacklogFloor, snapshot.workers.online, snapshot.workers.busy + Math.max(0, snapshot.jobs.autoscalablePending))));
  }
  async ensureAutoscaledWorkerCapacity(reason = "background") {
    if (!this.autoSpawnWorkers || this.disposed)
      return;
    const snapshot = await this.fetchWorkerAutoscaleSnapshot();
    if (!snapshot)
      return;
    const desiredOnline = this.desiredWorkerCountFromAutoscaleSnapshot(snapshot);
    let online = Math.max(0, snapshot.workers.online);
    if (online >= desiredOnline)
      return;
    console.log(`[RemoteBuddy] Worker autoscaler (${reason}): online=${snapshot.workers.online} busy=${snapshot.workers.busy} pending=${snapshot.jobs.pending} autoscalablePending=${snapshot.jobs.autoscalablePending} openUnmergedPrs=${snapshot.prs.openUnmerged} target=${desiredOnline}.`);
    while (!this.disposed && online < desiredOnline) {
      const spawned = await this.spawnWorker();
      if (!spawned)
        break;
      online += 1;
    }
  }
  async maybeAutoscaleWorkers() {
    if (!this.autoSpawnWorkers || this.disposed)
      return;
    const now = Date.now();
    if (now - this.lastWorkerAutoscaleAt < this.workerAutoscalePollMs)
      return;
    this.lastWorkerAutoscaleAt = now;
    await this.ensureAutoscaledWorkerCapacity("poll");
  }
  buildWorkerSpawnCommand(workerId) {
    return buildWorkerSpawnCommand({
      server: this.server,
      workerId,
      repoRoot: this.repo,
      pollMs: this.spawnWorkerPollMs,
      heartbeatMs: this.spawnWorkerHeartbeatMs,
      labels: this.spawnWorkerLabels,
      docker: this.spawnWorkerDocker,
      requireDocker: this.spawnWorkerRequireDocker,
      dockerImage: this.spawnWorkerImage,
      binaryPath: this.workerpalsBinaryPath,
      envFile: this.workerpalsEnvFile,
      entrypoint: this.workerpalsEntrypoint
    });
  }
  async spawnWorker() {
    if (this.workerSpawnInFlight) {
      return await this.workerSpawnInFlight;
    }
    if (this.managedWorkers.size >= this.maxWorkers) {
      return null;
    }
    if (this.workerSpawnCooldownUntil > Date.now()) {
      const retryInMs = Math.max(0, this.workerSpawnCooldownUntil - Date.now());
      this.workerpalsUnavailableReason = `WorkerPal spawn cooldown in effect; retrying in ${retryInMs}ms.`;
      return null;
    }
    const spawnPromise = (async () => {
      this.workerpalsUnavailableReason = null;
      const workerId = `workerpal-${randomUUID2().substring(0, 8)}`;
      const cmd = this.buildWorkerSpawnCommand(workerId);
      console.log(`[RemoteBuddy] Spawning WorkerPal ${workerId} (${this.managedWorkers.size + 1}/${this.maxWorkers})`);
      try {
        const child = Bun.spawn(cmd, {
          cwd: this.repo,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit"
        });
        this.managedWorkers.set(workerId, child);
        child.exited.then((code) => {
          this.managedWorkers.delete(workerId);
          console.warn(`[RemoteBuddy] WorkerPal process ${workerId} exited with code ${code}`);
        });
        const ready = await this.waitForOnlineWorker(this.workerStartupTimeoutMs, workerId);
        if (ready) {
          this.workerSpawnCooldownUntil = 0;
          if (ready.activeJobCount > 0 || ready.status === "busy") {
            console.log(`[RemoteBuddy] WorkerPal ${ready.workerId} came online and is already busy; treating startup as healthy.`);
          }
          return ready.workerId;
        }
        this.workerpalsUnavailableReason = this.spawnWorkerDocker && this.spawnWorkerRequireDocker ? `WorkerPal ${workerId} did not report online within ${this.workerStartupTimeoutMs}ms. Verify Docker is installed, running, and able to start the WorkerPal sandbox image.` : `WorkerPal ${workerId} did not report online within ${this.workerStartupTimeoutMs}ms.`;
        console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
        await this.terminateManagedWorkerProcess(workerId, child, "startup timeout");
        this.workerSpawnCooldownUntil = Date.now() + this.workerSpawnBackoffMs;
        return null;
      } catch (err) {
        this.workerpalsUnavailableReason = this.spawnWorkerDocker && this.spawnWorkerRequireDocker ? `Failed to spawn Docker-backed WorkerPal: ${String(err)}` : `Failed to spawn WorkerPal: ${String(err)}`;
        console.error(`[RemoteBuddy] Failed to spawn WorkerPal ${workerId}:`, err);
        this.workerSpawnCooldownUntil = Date.now() + this.workerSpawnBackoffMs;
        return null;
      }
    })();
    this.workerSpawnInFlight = spawnPromise;
    try {
      return await spawnPromise;
    } finally {
      if (this.workerSpawnInFlight === spawnPromise) {
        this.workerSpawnInFlight = null;
      }
    }
  }
  async ensureWorkerCapacityOnStartup() {
    const workers = await this.fetchWorkers();
    if (this.pickIdleWorker(workers)) {
      return;
    }
    const onlineWorkers = this.onlineWorkers(workers);
    if (!this.autoSpawnWorkers) {
      if (onlineWorkers.length > 0) {
        const idleWorker2 = await this.waitForIdleWorker(Math.max(this.waitForWorkerMs, 5000));
        if (idleWorker2) {
          console.log(`[RemoteBuddy] Initial WorkerPal capacity became idle via ${idleWorker2.workerId}.`);
          return;
        }
        this.workerpalsUnavailableReason = `${onlineWorkers.length} online WorkerPal(s) reported but none became idle within ${Math.max(this.waitForWorkerMs, 5000)}ms.`;
        console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
      }
      return;
    }
    if (onlineWorkers.length < this.maxWorkers) {
      console.log("[RemoteBuddy] Prewarming initial WorkerPal capacity...");
      const spawned = await this.spawnWorker();
      if (spawned) {
        console.log(`[RemoteBuddy] Initial WorkerPal capacity ready via ${spawned}.`);
        this.ensureAutoscaledWorkerCapacity("startup warm pool");
        return;
      }
    }
    const idleWorker = await this.waitForIdleWorker(Math.max(this.waitForWorkerMs, this.workerStartupTimeoutMs));
    if (idleWorker) {
      console.log(`[RemoteBuddy] Initial WorkerPal capacity became idle via ${idleWorker.workerId}.`);
      this.ensureAutoscaledWorkerCapacity("startup warm pool");
      return;
    }
    const after = await this.fetchWorkers();
    const onlineAfter = this.onlineWorkers(after);
    if (onlineAfter.length > 0) {
      this.workerpalsUnavailableReason = `${onlineAfter.length} online WorkerPal(s) reported but none became idle within ${Math.max(this.waitForWorkerMs, this.workerStartupTimeoutMs)}ms.`;
      console.warn(`[RemoteBuddy] ${this.workerpalsUnavailableReason}`);
      return;
    }
    console.warn(`[RemoteBuddy] ${this.currentWorkerUnavailableReason()}`);
  }
  async selectTargetWorkerForJob() {
    const workers = await this.fetchWorkers();
    const idleNow = this.pickIdleWorker(workers);
    if (idleNow) {
      return idleNow.workerId;
    }
    const onlineWorkers = workers.filter((worker) => worker.isOnline && worker.status !== "offline");
    if (this.autoSpawnWorkers && onlineWorkers.length < this.maxWorkers) {
      const spawned = await this.spawnWorker();
      if (spawned)
        return spawned;
    }
    const waited = await this.waitForIdleWorker(this.waitForWorkerMs);
    return waited?.workerId ?? null;
  }
  async processRequest(request, queueWaitMs = 0) {
    const requestId = String(request.id ?? "").trim();
    if (!requestId)
      return;
    const requestSessionId = String(request.sessionId ?? "").trim() || this.sessionId;
    await this.ensureSessionWithRetry(requestSessionId, 3, 250, 2000);
    this.ensureSessionEventMonitor(requestSessionId);
    if (this.idempotency.hasHandled(requestSessionId, requestId)) {
      console.log(`[RemoteBuddy] Skipping already-handled request ${requestId}`);
      return;
    }
    this.idempotency.markHandled(requestSessionId, requestId);
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) {
      console.warn(`[RemoteBuddy] Request ${requestId} missing prompt; marking failed`);
      await fetch(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ message: "Request missing prompt" })
      }).catch(() => {});
      return;
    }
    const reqAny = request;
    let forceWorker = Boolean(reqAny.forceWorker ?? reqAny.force_worker);
    const laneRaw = String(reqAny.forceLane ?? reqAny.force_lane ?? "").trim().toLowerCase();
    let forceLane = laneRaw === "deterministic" || laneRaw === "worker" ? laneRaw : undefined;
    const autonomyMetadata = parseAutonomyRequestMetadata(reqAny.metadata ?? reqAny.metadataJson);
    if (autonomyMetadata) {
      forceWorker = true;
      forceLane = "worker";
    }
    const priority = normalizeRequestPriority(request.priority);
    const queueWaitBudgetMs = Math.max(5000, Number.isFinite(Number(request.queueWaitBudgetMs)) ? Number(request.queueWaitBudgetMs) : priority === "interactive" ? 20000 : priority === "background" ? 240000 : 90000);
    const turnId = randomUUID2();
    const planningContext = this.buildPlanningContext(priority, requestSessionId);
    this.rememberPersistentMemory("request", `priority=${priority} prompt=${toSingleLine(prompt, 520)}`, requestId, requestSessionId);
    try {
      console.log(`[RemoteBuddy] Planning request ${requestId.slice(0, 8)} session=${requestSessionId} priority=${priority} queueWait=${Math.max(0, Math.floor(queueWaitMs))}ms${forceWorker ? ` forceWorker=true forceLane=${forceLane ?? "worker"}` : ""}`);
      const plan = await this.brain.think(prompt, planningContext, {
        forceWorker,
        forceLane
      });
      if (autonomyMetadata) {
        if (plan.intent !== "analysis") {
          plan.requires_worker = true;
          plan.job_kind = "task.execute";
          plan.lane = "worker";
        }
        plan.scope.read_anywhere = false;
        plan.scope.write_allowed = true;
        plan.scope.write_globs = [...autonomyMetadata.writeGlobs];
      }
      this.pushContext(`[user] ${toSingleLine(prompt, 700)}`, requestSessionId);
      this.pushContext(`[plan] ${toSingleLine(JSON.stringify(plan), 900)}`, requestSessionId);
      const targetPaths = autonomyMetadata && autonomyMetadata.targetPaths.length > 0 ? autonomyMetadata.targetPaths : plannerTargetPaths(plan, prompt);
      this.rememberPersistentMemory("plan", `intent=${plan.intent} worker=${plan.requires_worker ? "yes" : "no"} lane=${plan.lane} risk=${plan.risk_level} targets=${targetPaths.slice(0, 6).join(",") || "(none)"}`, requestId, requestSessionId);
      const targetPath = targetPaths[0];
      const isAnalysisFromEngine = plan.intent === "analysis" && Boolean(autonomyMetadata);
      const requiresWorker = forceWorker && !isAnalysisFromEngine ? true : this.shouldForceDirectReply(prompt, plan.intent) ? false : plan.requires_worker;
      console.log("[RemoteBuddy] Planner output:", { plan, targetPath, requiresWorker });
      if (requiresWorker) {
        const scopeCoverage = ensureWriteGlobsCoverTargetPaths(targetPaths, plan.scope.write_globs);
        if (scopeCoverage.normalizedWriteGlobs.length > 0) {
          plan.scope.write_globs = scopeCoverage.normalizedWriteGlobs;
        }
        if (scopeCoverage.addedGlobs.length > 0) {
          console.warn(`[RemoteBuddy] Planner write_globs did not cover target paths. Added scope globs: ${scopeCoverage.addedGlobs.join(", ")}`);
        }
        if (forceWorker) {
          const concreteTargetCount = targetPaths.filter((entry) => entry && entry !== ".").length;
          if (concreteTargetCount > 0) {
            const currentMax = Number.isFinite(Number(plan.scope.max_files_to_edit)) && Number(plan.scope.max_files_to_edit) > 0 ? Math.floor(Number(plan.scope.max_files_to_edit)) : 0;
            if (currentMax < concreteTargetCount) {
              plan.scope.max_files_to_edit = concreteTargetCount;
            }
          }
        }
        if (autonomyMetadata && (!plan.scope.write_globs || plan.scope.write_globs.length === 0)) {
          throw new Error("Autonomy-origin request requires non-empty planning.scope.write_globs before task dispatch.");
        }
        if (plan.acceptance_criteria.length === 0) {
          plan.acceptance_criteria = ["Produce a correct and helpful result for the user request."];
        }
        plan.validation_steps = normalizeValidationSteps(plan.validation_steps, targetPaths);
        if (plan.validation_steps.length === 0) {
          plan.validation_steps = defaultValidationStepsForRequest(prompt, targetPaths);
          console.warn(`[RemoteBuddy] Planner returned no validation_steps; using fallback: ${plan.validation_steps.join(" | ")}`);
        }
        if (!forceWorker) {
          const missing = [];
          if (targetPaths.length === 0)
            missing.push("target_paths");
          if (plan.acceptance_criteria.length === 0)
            missing.push("acceptance_criteria");
          if (plan.validation_steps.length === 0)
            missing.push("validation_steps");
          if (missing.length > 0) {
            throw new Error(`Planner contract incomplete for task.execute: missing ${missing.join(", ")}. RemoteBuddy requires explicit target paths, acceptance criteria, and validation steps.`);
          }
        }
      }
      let lane = requiresWorker ? this.chooseExecutionLane(prompt, plan, targetPaths.length) : "deterministic";
      if (requiresWorker && lane === "deterministic" && (!targetPath || targetPath === ".")) {
        lane = "worker";
      }
      if (forceWorker) {
        lane = forceLane ?? "worker";
      }
      const canonicalInstruction = prompt.trim();
      const rawPlannerInstruction = sanitizePlannerWorkerInstruction(String(plan.worker_instruction ?? ""), canonicalInstruction);
      const executionGuidance = buildExecutionGuidance(plan, targetPaths);
      const plannerWorkerInstruction = [rawPlannerInstruction, executionGuidance].filter(Boolean).join(`

`).trim();
      if (queueWaitMs > queueWaitBudgetMs) {
        await this.assistantMessage(requestSessionId, `Request ${requestId.slice(0, 8)} waited ${Math.floor(queueWaitMs / 1000)}s in queue (budget ${Math.floor(queueWaitBudgetMs / 1000)}s). Prioritizing execution now.`, { turnId, correlationId: requestId });
      }
      if (!requiresWorker) {
        await this.sendCommand(requestSessionId, {
          type: "assistant_message",
          payload: { text: plan.assistant_message },
          turnId
        });
        if (plan.intent !== "chat" && plan.intent !== "status") {
          if (autonomyMetadata && CONFIG.remotebuddy.autonomy.enabled) {
            const workerInstruction = canonicalizeInstructionTextForBun(String(plan.worker_instruction ?? "").trim() || plan.assistant_message);
            const enqueued = await this.autonomousEngine.enqueueFromAnalysis(workerInstruction, autonomyMetadata, requestId);
            if (enqueued) {
              console.log(`[RemoteBuddy] Non-chat intent (${plan.intent}) from engine re-enqueued as worker request ${enqueued}`);
            } else {
              console.warn(`[RemoteBuddy] Non-chat intent (${plan.intent}) from engine: enqueueFromAnalysis returned null (engine disabled or enqueue failed)`);
            }
          } else if (!autonomyMetadata) {
            await this.assistantMessage(requestSessionId, "Should I have a WorkerPal implement this? Reply to confirm and I'll enqueue the work, or clarify what you'd like focused on.", { turnId, correlationId: requestId });
          }
        }
        await fetch(`${this.server}/requests/${requestId}/complete`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({
            result: {
              requiresWorker: false,
              intent: plan.intent,
              lane: "deterministic",
              priority,
              queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
              forceWorker,
              forceLane: forceLane ?? null
            }
          })
        }).catch(() => {});
        this.rememberPersistentMemory("decision", `completed_without_worker intent=${plan.intent} lane=deterministic`, requestId, requestSessionId);
        return;
      }
      const taskId = randomUUID2();
      const targetWorkerId = await this.selectTargetWorkerForJob();
      if (!targetWorkerId) {
        const onlineWorkers = this.onlineWorkers(await this.fetchWorkers());
        if (onlineWorkers.length === 0) {
          const detail = this.currentWorkerUnavailableReason();
          const userMessage = "WorkerPal execution is currently unavailable in this runtime. " + detail;
          console.warn(`[RemoteBuddy] ${userMessage}`);
          await this.assistantMessage(requestSessionId, userMessage, {
            turnId,
            correlationId: requestId
          });
          await fetch(`${this.server}/requests/${requestId}/fail`, {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({
              message: "WorkerPal backend unavailable",
              detail
            })
          }).catch(() => {});
          return;
        }
      }
      await this.assistantMessage(requestSessionId, "Understood. I am delegating this to a WorkerPal now.", {
        turnId,
        correlationId: requestId
      });
      const executionBudgetMs = this.executionBudgetForPriority(priority);
      const strictTargetPaths = targetPaths.filter((entry) => entry && entry !== ".");
      const baseParams = {
        schemaVersion: 2,
        requestId,
        sessionId: requestSessionId,
        instruction: canonicalInstruction,
        plannerWorkerInstruction: plannerWorkerInstruction && plannerWorkerInstruction !== canonicalInstruction ? plannerWorkerInstruction : undefined,
        lane,
        ...targetPaths.length > 0 ? { paths: targetPaths } : {},
        planning: {
          intent: plan.intent,
          riskLevel: plan.risk_level,
          ...strictTargetPaths.length > 0 ? { targetPaths: strictTargetPaths } : {},
          scope: {
            readAnywhere: plan.scope.read_anywhere,
            writeAllowed: plan.scope.write_allowed,
            ...plan.scope.write_globs && plan.scope.write_globs.length > 0 ? { writeGlobs: plan.scope.write_globs } : {},
            ...plan.scope.forbidden_globs && plan.scope.forbidden_globs.length > 0 ? { forbiddenGlobs: plan.scope.forbidden_globs } : {},
            ...plan.scope.max_files_to_edit && plan.scope.max_files_to_edit > 0 ? { maxFilesToEdit: plan.scope.max_files_to_edit } : {}
          },
          ...plan.discovery ? {
            discovery: {
              ripgrepQueries: plan.discovery.ripgrep_queries,
              ...plan.discovery.likely_dirs && plan.discovery.likely_dirs.length > 0 ? { likelyDirs: plan.discovery.likely_dirs } : {},
              ...plan.discovery.keywords && plan.discovery.keywords.length > 0 ? { keywords: plan.discovery.keywords } : {}
            }
          } : {},
          acceptanceCriteria: plan.acceptance_criteria,
          validationSteps: plan.validation_steps,
          queuePriority: priority,
          queueWaitBudgetMs,
          executionBudgetMs,
          finalizationBudgetMs: this.finalizationBudgetMs
        },
        targetPath,
        recentContext: this.getRecentContextSnapshot(requestSessionId),
        recentJobs: this.getRecentJobContext(12, requestSessionId)
      };
      const params = autonomyMetadata ? {
        ...baseParams,
        origin: "autonomy",
        autonomy: {
          origin: "autonomy",
          ...autonomyMetadata.objectiveId ? { objectiveId: autonomyMetadata.objectiveId } : {},
          ...autonomyMetadata.runId ? { runId: autonomyMetadata.runId } : {},
          ...autonomyMetadata.snapshotId ? { snapshotId: autonomyMetadata.snapshotId } : {},
          ...autonomyMetadata.patternKey ? { patternKey: autonomyMetadata.patternKey } : {},
          ...autonomyMetadata.componentArea ? { componentArea: autonomyMetadata.componentArea } : {}
        }
      } : {
        ...baseParams,
        origin: "user"
      };
      const enqueueResult = await this.enqueueJob(taskId, "task.execute", requestSessionId, params, targetWorkerId);
      if (enqueueResult) {
        const effectiveTaskId = enqueueResult.taskId;
        if (!enqueueResult.deduped) {
          await this.sendCommand(requestSessionId, {
            type: "task_created",
            payload: {
              taskId: effectiveTaskId,
              title: `Execute request: ${toSingleLine(prompt, 64) || "user request"}`,
              description: lane === "deterministic" ? "Deterministic execution lane (fast path)" : "Agentic worker execution lane",
              createdBy: `agent:${this.agentId}`,
              priority
            },
            turnId
          });
          await this.sendCommand(requestSessionId, {
            type: "task_started",
            payload: { taskId: effectiveTaskId },
            turnId
          });
        }
        await this.sendCommand(requestSessionId, {
          type: "task_progress",
          payload: {
            taskId: effectiveTaskId,
            message: enqueueResult.deduped ? "Reused active WorkerPal task for the same targeted file scope" : targetWorkerId ? `Assigned to WorkerPal ${targetWorkerId} (${lane} lane)` : "No idle WorkerPal available; queued for first available WorkerPal"
          },
          turnId
        });
        await this.assistantMessage(requestSessionId, enqueueResult.deduped ? "A matching WorkerPal task is already in progress for the same targeted file scope. Reusing that task instead of queuing a duplicate." : targetWorkerId ? `Assigned this request to WorkerPal ${targetWorkerId} (${lane} lane).` : "No idle WorkerPal right now; request is queued and waiting for the next available WorkerPal.", { turnId, correlationId: requestId });
        this.rememberPersistentMemory(enqueueResult.deduped ? "job_reused" : "job_enqueued", `job=${enqueueResult.jobId.slice(0, 8)} lane=${lane} intent=${plan.intent} worker=${targetWorkerId ?? "queue"} deduped=${enqueueResult.deduped ? "yes" : "no"}`, requestId, requestSessionId);
        if (!enqueueResult.deduped) {
          await this.sendCommand(requestSessionId, {
            type: "job_enqueued",
            payload: {
              jobId: enqueueResult.jobId,
              taskId: effectiveTaskId,
              kind: "task.execute",
              params,
              origin: autonomyMetadata ? "autonomy" : "user",
              ...autonomyMetadata ? {
                autonomy: {
                  ...autonomyMetadata.objectiveId ? { objectiveId: autonomyMetadata.objectiveId } : {},
                  ...autonomyMetadata.runId ? { runId: autonomyMetadata.runId } : {},
                  ...autonomyMetadata.snapshotId ? { snapshotId: autonomyMetadata.snapshotId } : {},
                  ...autonomyMetadata.patternKey ? { patternKey: autonomyMetadata.patternKey } : {}
                }
              } : {}
            },
            turnId
          });
        }
      } else {
        await this.assistantMessage(requestSessionId, "I could not queue this WorkerPal task. No task was started.", { turnId, correlationId: requestId });
        this.rememberPersistentMemory("job_enqueue_failed", `enqueue_failed lane=${lane} intent=${plan.intent}`, requestId, requestSessionId);
      }
      await fetch(`${this.server}/requests/${requestId}/complete`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          result: {
            requiresWorker: true,
            intent: plan.intent,
            lane,
            priority,
            riskLevel: plan.risk_level,
            queueWaitMs: Math.max(0, Math.floor(queueWaitMs)),
            executionBudgetMs,
            finalizationBudgetMs: this.finalizationBudgetMs,
            scope: plan.scope,
            discovery: plan.discovery ?? null,
            acceptanceCriteria: plan.acceptance_criteria,
            validationSteps: plan.validation_steps,
            forceWorker,
            forceLane: forceLane ?? null
          }
        })
      }).catch(() => {});
    } catch (err) {
      const message = `RemoteBuddy planning failed: ${toSingleLine(err, 220) || "unknown error"}`;
      console.error(`[RemoteBuddy] ${message}`);
      this.rememberPersistentMemory("planning_failed", message, requestId, requestSessionId);
      await this.assistantMessage(requestSessionId, message, { turnId, correlationId: requestId });
      await fetch(`${this.server}/requests/${requestId}/fail`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          message: "RemoteBuddy planning failed",
          detail: String(err)
        })
      }).catch(() => {});
    }
  }
  async startPolling(pollMs = 2000) {
    console.log(`[RemoteBuddy] Starting polling loop (every ${pollMs}ms)`);
    while (!this.disposed) {
      try {
        await this.maybeAutoscaleWorkers();
        const res = await fetch(`${this.server}/requests/claim`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ agentId: this.agentId })
        });
        if (res.ok) {
          const data = await res.json();
          console.log("[RemoteBuddy] claim payload:", JSON.stringify(data, null, 2));
          if (data.ok && data.request) {
            console.log(`[RemoteBuddy] Claimed request ${data.request.id}${data.request.forceWorker ? ` (forceWorker=true)` : ""}`);
            this.chain = this.chain.then(() => this.processRequest(data.request, Number(data.queueWaitMs ?? 0))).catch((err) => console.error("[RemoteBuddy] Process error:", err));
          }
        }
      } catch (err) {
        console.error(`[RemoteBuddy] Poll error:`, err);
      }
      await Bun.sleep(pollMs);
    }
  }
  startAutonomy() {
    if (!this.autonomyRuntimeEnabled) {
      console.log("[RemoteBuddy] Autonomous engine disabled by config (remotebuddy.autonomy.enabled=false).");
      this.autonomousEngine.setRuntimeEnabled(false);
      return;
    }
    this.autonomousEngine.setRuntimeEnabled(true);
    this.autonomousEngine.start();
  }
  applyAutonomyEnabledFromRuntimeConfig(enabled) {
    if (enabled === this.autonomyRuntimeEnabled)
      return;
    this.autonomyRuntimeEnabled = enabled;
    this.autonomousEngine.setRuntimeEnabled(enabled);
    if (enabled) {
      this.autonomousEngine.start();
      console.log("[RemoteBuddy] Autonomous engine enabled via runtime config (remotebuddy.autonomy.enabled=true).");
      return;
    }
    this.autonomousEngine.stop();
    console.log("[RemoteBuddy] Autonomous engine disabled via runtime config (remotebuddy.autonomy.enabled=false).");
  }
  startAutonomyRuntimeConfigPolling() {
    if (this.autonomyConfigPollTimer)
      return;
    this.autonomyConfigPollTimer = setInterval(() => {
      if (this.disposed)
        return;
      try {
        const latest = loadPushPalsConfig({ reload: true });
        const enabled = Boolean(latest.remotebuddy.autonomy.enabled);
        this.applyAutonomyEnabledFromRuntimeConfig(enabled);
      } catch (err) {
        console.warn(`[RemoteBuddy] Runtime config poll failed: ${String(err)}`);
      }
    }, this.autonomyConfigPollMs);
  }
  async dispose() {
    this.disposed = true;
    if (this.autonomyConfigPollTimer) {
      clearInterval(this.autonomyConfigPollTimer);
      this.autonomyConfigPollTimer = null;
    }
    this.autonomousEngine.stop();
    if (this.statusHeartbeatTimer) {
      clearInterval(this.statusHeartbeatTimer);
      this.statusHeartbeatTimer = null;
    }
    this.comm.status(this.agentId, "shutting_down", "RemoteBuddy shutting down");
    for (const [sessionId, stop] of this.sessionEventStops.entries()) {
      try {
        stop();
      } catch {}
      this.sessionEventStops.delete(sessionId);
    }
    this.fatalSessionMonitors.clear();
    this.sessionMonitorWsErrorCounts.clear();
    this.workerSpawnCooldownUntil = 0;
    this.workerSpawnInFlight = null;
    const shutdownWorkers = Array.from(this.managedWorkers.entries()).map(([workerId, proc]) => this.terminateManagedWorkerProcess(workerId, proc, "remotebuddy shutdown"));
    if (shutdownWorkers.length > 0) {
      await Promise.allSettled(shutdownWorkers);
    }
    if (this.jobsDb) {
      try {
        this.jobsDb.close();
      } catch {}
      this.jobsDb = null;
    }
    try {
      this.persistentMemory.close();
    } catch {}
  }
}
async function connectWithRetry(server, sessionId, maxRetries = Infinity, baseDelay = 2000, maxDelay = 30000) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {})
      });
      if (!res.ok)
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      return data.sessionId;
    } catch (err) {
      if (attempt >= maxRetries)
        throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(`[RemoteBuddy] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)} s... (attempt ${attempt})`);
      await Bun.sleep(delay);
    }
  }
}
async function main() {
  const opts = parseArgs();
  console.log("[RemoteBuddy] PushPals RemoteBuddy Orchestrator");
  console.log(`[RemoteBuddy] Server: ${opts.server}`);
  if (CONFIG.startup.logConfigOnStart) {
    console.log("[RemoteBuddy] Effective config snapshot (sanitized):");
    console.log(JSON.stringify(sanitizePushPalsConfigForLogging(CONFIG), null, 2));
  } else {
    console.log("[RemoteBuddy] Config snapshot logging disabled (startup.log_config_on_start=false).");
  }
  let brain;
  const dataDir = CONFIG.paths.dataDir;
  mkdirSync2(dataDir, { recursive: true });
  const sharedDbPath = CONFIG.paths.sharedDbPath;
  const dbPath = CONFIG.paths.remotebuddyDbPath;
  const idempotency = new IdempotencyStore(dbPath);
  const persistentMemory = createSessionMemoryBackend(CONFIG.remotebuddy.memory.enabled, [
    () => new PersistentSessionMemory(dbPath)
  ]);
  console.log(`[RemoteBuddy] Idempotency store: ${dbPath}`);
  console.log(`[RemoteBuddy] Persistent memory backend: ${CONFIG.remotebuddy.memory.enabled ? "composite(sqlite)" : "noop"}`);
  let sessionId = opts.sessionId;
  console.log(`[RemoteBuddy] Ensuring session "${sessionId}" exists on server...`);
  sessionId = await connectWithRetry(opts.server, sessionId ?? undefined);
  console.log(`[RemoteBuddy] Using session: ${sessionId}`);
  const llmCfg = CONFIG.remotebuddy.llm;
  const llm = createLLMClient({
    service: "remotebuddy",
    sessionId,
    backend: llmCfg.backend,
    endpoint: llmCfg.endpoint,
    model: llmCfg.model,
    apiKey: llmCfg.apiKey,
    serverUrl: opts.server,
    authToken: opts.authToken
  });
  brain = new AgentBrain(llm);
  const orchestrator = new RemoteBuddyOrchestrator({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
    brain,
    llm,
    idempotency,
    persistentMemory,
    jobsDbPath: sharedDbPath
  });
  let shutdownRequested = false;
  const shutdown = (signalName, code) => {
    if (shutdownRequested)
      return;
    shutdownRequested = true;
    console.log(`[RemoteBuddy] Received ${signalName}; shutting down...`);
    orchestrator.dispose().catch((err) => {
      console.error(`[RemoteBuddy] Shutdown cleanup failed: ${String(err)}`);
    }).finally(() => {
      setTimeout(() => process.exit(code), 0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT", 130));
  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => shutdown("SIGBREAK", 131));
  }
  await orchestrator.emitStartupStatus();
  orchestrator.startStatusHeartbeat();
  orchestrator.startSessionEventMonitor();
  orchestrator.startAutonomy();
  orchestrator.startAutonomyRuntimeConfigPolling();
  await orchestrator.ensureWorkerCapacityOnStartup();
  const pollMs = CONFIG.remotebuddy.pollMs;
  orchestrator.startPolling(pollMs);
}
if (import.meta.main) {
  main().catch((err) => {
    console.error("[RemoteBuddy] Fatal:", err);
    process.exit(1);
  });
}
export {
  buildTaskExecuteDedupeKey,
  RemoteBuddyOrchestrator
};
