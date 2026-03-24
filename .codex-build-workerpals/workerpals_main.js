#!/usr/bin/env bun
// @bun

// apps/workerpals/src/workerpals_main.ts
import { randomUUID as randomUUID2 } from "crypto";
import { mkdirSync as mkdirSync2 } from "fs";
import { resolve as resolve10 } from "path";

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
    return normalized[0] ?? null;
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
  const normalizedComponentArea = normalizeAutonomyComponentArea(componentArea) ?? deriveAutonomyComponentArea(targetPathsInput, writeGlobsInput);
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
  if (!normalizedComponentArea) {
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
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/workerpals/src/backends/backend_config.ts
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "fs";
import { join as join3 } from "path";

// apps/workerpals/src/backends/miniswe_backend.ts
import { resolve as resolve5 } from "path";

// apps/workerpals/src/common/generic_python_executor.ts
import { existsSync as existsSync3 } from "fs";
import { resolve as resolve4 } from "path";

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

// apps/workerpals/src/common/generic_python_executor.ts
function resolveRuntimeSettings(config, runtimeConfig) {
  const workerCfg = runtimeConfig.workerpals;
  const rawPython = String(workerCfg[config.pythonConfigKey] ?? "python");
  const pythonBin = rawPython.includes("/") || rawPython.includes("\\") ? resolve4(runtimeConfig.projectRoot, rawPython) : rawPython;
  const rawTimeout = Number(workerCfg[config.timeoutConfigKey]);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(1e4, Math.floor(rawTimeout)) : 300000;
  return { pythonBin, timeoutMs };
}
function createGenericPythonExecutor(config) {
  const { backendName, scriptPath } = config;
  const backendLabel = backendName[0].toUpperCase() + backendName.slice(1);
  return async (kind, params, repo, runtimeConfig, onLog, budgets) => {
    if (!existsSync3(scriptPath)) {
      return {
        ok: false,
        summary: `${backendName} wrapper script not found: ${scriptPath}`,
        exitCode: 1
      };
    }
    const { pythonBin, timeoutMs: configuredTimeoutMs } = resolveRuntimeSettings(config, runtimeConfig);
    const executionBudgetMs = typeof budgets?.executionBudgetMs === "number" && Number.isFinite(budgets.executionBudgetMs) ? Math.max(1e4, Math.floor(budgets.executionBudgetMs)) : null;
    const timeoutMs = executionBudgetMs != null ? Math.min(configuredTimeoutMs, executionBudgetMs) : configuredTimeoutMs;
    const payloadBase64 = Buffer.from(JSON.stringify({
      kind,
      params,
      repo
    }), "utf-8").toString("base64");
    const args = [pythonBin, scriptPath, payloadBase64];
    onLog?.("stdout", `[${backendLabel}Executor] Spawning ${backendName} executor (timeout=${timeoutMs}ms)`);
    try {
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
          ...process.env,
          PUSHPALS_REPO_PATH: repo,
          PUSHPALS_ASSIGNED_REPO_ROOT: repo,
          PYTHONIOENCODING: "utf-8"
        }
      });
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        onLog?.("stdout", `[${backendLabel}Executor] Timeout reached after ${timeoutMs}ms; terminating process.`);
        proc.kill();
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
      clearInterval(progressTimer);
      const stdout = rawStdout ?? "";
      const stderr = rawStderr ?? "";
      const parsed = parseStructuredResult(stdout, outputPolicy.executorResultPrefix);
      const filteredStdout = filterResultLines(stdout, outputPolicy.executorResultPrefix);
      if (!parsed) {
        if (timedOut) {
          return {
            ok: false,
            summary: `${backendName} wrapper timed out after ${timeoutMs}ms for ${kind}`,
            stdout: truncate(filteredStdout, outputPolicy),
            stderr: truncate(stderr, outputPolicy),
            exitCode: exitCode === 0 ? 124 : exitCode
          };
        }
        return {
          ok: false,
          summary: `${backendName} wrapper did not return a structured result for ${kind}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode
        };
      }
      return {
        ok: typeof parsed.ok === "boolean" ? parsed.ok : exitCode === 0,
        summary: typeof parsed.summary === "string" ? parsed.summary : exitCode === 0 ? `${kind} passed via ${backendName}` : `${kind} failed via ${backendName} (exit ${exitCode})`,
        stdout: truncate(typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout, outputPolicy),
        stderr: truncate(typeof parsed.stderr === "string" ? parsed.stderr : stderr, outputPolicy),
        exitCode: typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode) ? parsed.exitCode : exitCode
      };
    } catch (err) {
      return {
        ok: false,
        summary: `${backendName} wrapper execution error for ${kind}: ${String(err)}`,
        exitCode: 1
      };
    }
  };
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
    scriptPath: resolve5(import.meta.dir, "miniswe", "miniswe_executor.py"),
    pythonConfigKey: "miniswePython",
    timeoutConfigKey: "minisweTimeoutMs"
  })
};

// apps/workerpals/src/backends/openai_codex_backend.ts
import { resolve as resolve6 } from "path";
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
  return `PY="\${PUSHPALS_OPENAI_CODEX_PYTHON:-${sharedVenvPython}}"; ` + 'AUTH_MODE_RAW="${PUSHPALS_OPENAI_CODEX_AUTH_MODE:-auto}"; ' + 'AUTH_MODE="$(printf %s "$AUTH_MODE_RAW" | tr "[:upper:]" "[:lower:]")"; ' + 'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' + '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' + "if command -v bunx >/dev/null 2>&1; then " + '  CODEX_CMD="bunx --yes @openai/codex"; ' + "elif command -v codex >/dev/null 2>&1; then " + '  CODEX_CMD="codex"; ' + "else " + '  echo "Neither bunx nor codex was found in PATH" >&2; ' + "  exit 1; " + "fi; " + 'sh -lc "$CODEX_CMD --version"; ' + 'NEED_LOGIN="0"; ' + 'if [ "$AUTH_MODE" = "chatgpt" ] || [ "$AUTH_MODE" = "chatgpt_login" ] || [ "$AUTH_MODE" = "subscription" ]; then NEED_LOGIN="1"; fi; ' + 'if [ "$AUTH_MODE" = "auto" ] && [ -z "${OPENAI_API_KEY:-}" ]; then NEED_LOGIN="1"; fi; ' + 'if [ "$NEED_LOGIN" = "1" ]; then ' + '  sh -lc "$CODEX_CMD login status" >/dev/null 2>&1 || { ' + '    echo "Codex CLI login is required for PUSHPALS_OPENAI_CODEX_AUTH_MODE=${AUTH_MODE}. Run codex login (or bunx --yes @openai/codex login)." >&2; ' + "    exit 1; " + "  }; " + "fi";
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
    scriptPath: resolve6(import.meta.dir, "openai_codex", "openai_codex_executor.py"),
    pythonConfigKey: "openaiCodexPython",
    timeoutConfigKey: "openaiCodexTimeoutMs"
  })
};

// apps/workerpals/src/backends/openhands_task_execute.ts
import { existsSync as existsSync4 } from "fs";
import { resolve as resolve7 } from "path";

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
var OPENHANDS_SCRIPT_PATH = resolve7(import.meta.dir, "openhands", "openhands_executor.py");
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
  if (!existsSync4(scriptPath)) {
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
  const outputPolicy = {
    maxOutputChars: runtimeConfig.workerpals.outputMaxChars,
    maxOutputLines: runtimeConfig.workerpals.outputMaxLines,
    maxOutputHeadLines: runtimeConfig.workerpals.outputMaxHeadLines,
    executorResultPrefix: runtimeConfig.workerpals.executorResultPrefix
  };
  try {
    const proc = Bun.spawn([pythonBin, scriptPath, payload], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
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
    if (!parsed) {
      if (timedOut) {
        const stuckNote = stuckGuardTriggered ? ` Stuck guard warning was raised at ${stuckGuardAfterMs}ms (${stuckGuardReason}).` : "";
        return {
          ok: false,
          summary: `OpenHands wrapper timed out after ${timedOutAfterMs}ms for ${kind} (effective limit: ${timeoutLimitSource}${extendedByActivityMs > 0 ? ` + activity extension ${extendedByActivityMs}ms` : ""}). Worker returned a timeout failure.${stuckNote}`,
          stdout: truncate(filteredStdout, outputPolicy),
          stderr: truncate(stderr, outputPolicy),
          exitCode: exitCode === 0 ? 124 : exitCode
        };
      }
      return {
        ok: false,
        summary: `OpenHands wrapper did not return a structured result for ${kind}`,
        stdout: truncate(filteredStdout, outputPolicy),
        stderr: truncate(stderr, outputPolicy),
        exitCode
      };
    }
    const summary = typeof parsed.summary === "string" ? parsed.summary : exitCode === 0 ? `${kind} passed via OpenHands` : `${kind} failed via OpenHands (exit ${exitCode})`;
    const parsedStdout = typeof parsed.stdout === "string" ? parsed.stdout : filteredStdout;
    const parsedStderr = typeof parsed.stderr === "string" ? parsed.stderr : stderr;
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
          exitCode: 0
        };
      }
    }
    return {
      ok: parsedOk,
      summary,
      stdout: truncate(parsedStdout ?? "", outputPolicy),
      stderr: truncate(parsedStderr ?? "", outputPolicy),
      exitCode: parsedExitCode
    };
  } catch (err) {
    return {
      ok: false,
      summary: `OpenHands wrapper execution error for ${kind}: ${String(err)}`,
      exitCode: 1
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
  if (!existsSync5(path)) {
    throw new Error(`Missing required runtime backend config file: ${path}`);
  }
  const parsed = Bun.TOML.parse(readFileSync4(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid runtime backend config file: ${path}`);
  }
  return parsed;
}
function resolveBackendTomlPath(configDir) {
  return join3(configDir, "backend.toml");
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
import { readFileSync as readFileSync5, unlinkSync } from "fs";
import { resolve as resolve8 } from "path";
var DEFAULT_CONFIG3 = loadPushPalsConfig();
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
  return [
    `Critic score ${critic.score.toFixed(1)} is below required threshold ${qualityCriticMinScore}.`
  ];
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
var SHELL_CONTROL_TOKENS = new Set(["&&", "||", ";", "|"]);
function tokenizeValidationCommandArgv(command) {
  const trimmed = command.trim();
  if (!trimmed)
    return null;
  const out = [];
  let current = "";
  let quote = null;
  const pushCurrent = () => {
    if (!current)
      return;
    out.push(current);
    current = "";
  };
  for (const ch of trimmed) {
    if (quote) {
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
async function runValidationCommand(repo, command, timeoutMs, outputPolicy) {
  const argv = tokenizeValidationCommandArgv(command);
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
  const startedAt = Date.now();
  const proc = Bun.spawn(argv, {
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
  }, Math.max(1000, timeoutMs));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timer);
  return {
    step: command,
    command,
    ok: !timedOut && exitCode === 0,
    exitCode: timedOut ? 124 : exitCode,
    stdout: compactJobOutput(stdout.trim(), outputPolicy),
    stderr: compactJobOutput(stderr.trim(), outputPolicy),
    elapsedMs: Math.max(1, Date.now() - startedAt)
  };
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
function isLikelyTestPath(path) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/tests/") || normalized.includes("/test/") || normalized.includes("__tests__/") || /\.test\.[a-z0-9]+$/i.test(normalized) || /\.spec\.[a-z0-9]+$/i.test(normalized);
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
  const runnable = new Set(["bun", "npm", "pnpm", "yarn", "pytest", "python", "uv", "coverage"]);
  if (runnable.has(firstToken))
    return maybeStripped;
  return null;
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
  const normalizedTarget = (targetPath ?? "").replace(/\\/g, "/").trim();
  if (normalizedTarget && isLikelyTestPath(normalizedTarget)) {
    add(pythonSignal ? `pytest ${normalizedTarget}` : `bun test ${normalizedTarget}`);
  }
  if (changedTestPaths.length > 0) {
    const focused = changedTestPaths.slice(0, 4).join(" ");
    add(pythonSignal ? `pytest ${focused}` : `bun test ${focused}`);
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
function isTestFocusedTask(instruction, planning, targetPath) {
  const lowerInstruction = instruction.toLowerCase();
  if (/\b(test|tests|coverage|unit test|integration test|unittest|pytest)\b/.test(lowerInstruction)) {
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
  if (planning.validationSteps.some((entry) => /\b(test|tests|coverage|pytest|vitest|jest|bun test)\b/i.test(entry))) {
    return true;
  }
  if (planning.acceptanceCriteria.some((entry) => /\b(test|tests|coverage|unit|integration|negative|invalid|valid)\b/i.test(entry))) {
    return true;
  }
  return false;
}
function hasBalancedPositiveNegativeAssertions(paths, repo) {
  const negativeSignal = /\b(invalid|negative|error|throw|reject|null|undefined|non[- ]?existent|toThrow|toBeNull|toBeUndefined|<\s*0|<=\s*0)\b/i;
  let positiveAssertions = 0;
  let negativeAssertions = 0;
  for (const rel of paths) {
    const fullPath = resolve8(repo, rel);
    let content = "";
    try {
      content = readFileSync5(fullPath, "utf-8");
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
async function runDeterministicQualityGate(repo, params, runtimeConfig, onLog) {
  const instruction = String(params.instruction ?? "");
  const targetPath = String(params.targetPath ?? params.path ?? "").trim() || undefined;
  const planning = params.planning;
  const isTestTask = isTestFocusedTask(instruction, planning, targetPath);
  if (!isTestTask) {
    return {
      ok: true,
      skipped: true,
      issues: [],
      changedPaths: [],
      changedTestPaths: [],
      validationRuns: []
    };
  }
  const statusResult = await git(repo, ["status", "--porcelain"]);
  const changedPaths = statusResult.ok ? parseChangedPathsFromStatus(statusResult.stdout) : [];
  const changedTestPaths = changedPaths.filter((path) => isLikelyTestPath(path));
  const issues = [];
  if (changedTestPaths.length === 0) {
    issues.push("No relevant test file was modified for this test-focused task.");
  }
  if (changedTestPaths.length > 0 && !hasBalancedPositiveNegativeAssertions(changedTestPaths, repo)) {
    issues.push("Changed test files do not show both positive and negative assertion coverage (expected both).");
  }
  const runnableSteps = planning.validationSteps.map((step) => extractRunnableValidationCommand(step)).filter((entry) => Boolean(entry)).slice(0, 4);
  const fallbackValidationSteps = runnableSteps.length === 0 ? inferFallbackValidationCommandsForTestTask(instruction, targetPath, planning, changedTestPaths) : [];
  const commandsToRun = runnableSteps.length > 0 ? runnableSteps : fallbackValidationSteps;
  const validationRuns = [];
  const outputPolicy = outputPolicyForRuntime(runtimeConfig);
  const qualityValidationStepTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityValidationStepTimeoutMs);
    if (!Number.isFinite(value))
      return 180000;
    return Math.max(1000, Math.min(7200000, Math.floor(value)));
  })();
  if (commandsToRun.length === 0) {
    issues.push("No runnable validation command was provided in planning.validationSteps (expected at least one test command).");
  } else {
    if (runnableSteps.length === 0) {
      onLog?.("stdout", `[QualityGate] No runnable planning.validationSteps found; using fallback validation command(s): ${commandsToRun.join(" | ")}`);
    }
    for (const command of commandsToRun) {
      onLog?.("stdout", `[QualityGate] Quality gate validation: running "${command}"`);
      const run = await runValidationCommand(repo, command, qualityValidationStepTimeoutMs, outputPolicy);
      validationRuns.push(run);
      const runSummary = `[QualityGate] Quality gate validation ${run.ok ? "passed" : "failed"} (${run.elapsedMs}ms, exit ${run.exitCode}): ${command}`;
      onLog?.(run.ok ? "stdout" : "stderr", runSummary);
    }
    const notFoundRuns = validationRuns.filter((run) => run.exitCode === 127);
    const executedRuns = validationRuns.filter((run) => run.exitCode !== 127);
    if (notFoundRuns.length > 0) {
      const cmds = notFoundRuns.map((run) => run.command).join(", ");
      onLog?.("stderr", `[QualityGate] Some validation commands not found (exit 127 \u2014 wrong tool?): ${cmds}. This project uses Bun: prefer "bun test".`);
    }
    if (executedRuns.length > 0 && executedRuns.every((run) => !run.ok)) {
      issues.push("Validation commands were executed but none passed.");
    } else if (executedRuns.length === 0 && notFoundRuns.length > 0) {
      issues.push('No validation command could be run (command not found). Use "bun test" or another available test runner.');
    }
    if (!validationRuns.some((run) => /\b(test|pytest|coverage|vitest|jest)\b/i.test(run.command))) {
      issues.push("Validation steps did not execute a recognizable test command.");
    }
  }
  return {
    ok: issues.length === 0,
    skipped: false,
    issues,
    changedPaths,
    changedTestPaths,
    validationRuns
  };
}
async function runTaskCriticReview(repo, params, quality, runtimeConfig, onLog) {
  const endpoint = normalizeChatCompletionsEndpoint(runtimeConfig.workerpals.llm.endpoint);
  const model = runtimeConfig.workerpals.llm.model.trim();
  if (!endpoint || !model)
    return null;
  const changedForDiff = quality.changedPaths.slice(0, 8);
  let diffText = "";
  if (changedForDiff.length > 0) {
    const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
    diffText = diffResult.ok ? diffResult.stdout : diffResult.stderr;
  }
  const qualityCriticMaxDiffChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
    if (!Number.isFinite(value))
      return 16000;
    return Math.max(256, Math.min(524288, Math.floor(value)));
  })();
  const qualityCriticMaxValidationOutputChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
    if (!Number.isFinite(value))
      return 8000;
    return Math.max(256, Math.min(524288, Math.floor(value)));
  })();
  const qualityCriticTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
    if (!Number.isFinite(value))
      return 45000;
    return Math.max(1000, Math.min(7200000, Math.floor(value)));
  })();
  diffText = compactJobOutput(diffText, outputPolicyForRuntime(runtimeConfig)).slice(0, qualityCriticMaxDiffChars);
  const validationSummary = quality.validationRuns.map((run) => {
    const output = [run.stdout, run.stderr].filter(Boolean).join(`
`).slice(0, qualityCriticMaxValidationOutputChars);
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
  const planning = params.planning;
  const instruction = String(params.instruction ?? "").trim();
  const acceptanceCriteriaText = planning.acceptanceCriteria.map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const validationStepsText = planning.validationSteps.map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const changedPathsText = quality.changedPaths.map((entry) => `- ${entry}`).join(`
`) || "- (none)";
  const criticSystem = loadPromptTemplate("workerpals/task_quality_critic_system_prompt.md").trim();
  const criticUser = loadPromptTemplate("workerpals/task_quality_critic_user_prompt.md", {
    instruction,
    acceptance_criteria: acceptanceCriteriaText,
    validation_steps: validationStepsText,
    changed_paths: changedPathsText,
    diff_excerpt: diffText || "(empty diff excerpt)",
    validation_evidence: validationSummary || "(no validation output)"
  });
  const apiKey = runtimeConfig.workerpals.llm.apiKey.trim() || "local";
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`;
  const bodyBase = {
    model,
    messages: [
      { role: "system", content: criticSystem },
      { role: "user", content: criticUser }
    ],
    temperature: 0,
    max_tokens: 700
  };
  const runCriticRequest = async (responseFormat) => {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), qualityCriticTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(responseFormat ? { ...bodyBase, response_format: responseFormat } : bodyBase),
        signal: controller.signal
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let request = await runCriticRequest({ type: "json_object" });
    if (!request.response.ok && request.response.status === 400) {
      const lowered = request.text.toLowerCase();
      if (lowered.includes("response_format")) {
        onLog?.("stdout", "[QualityGate] Critic fallback: response_format json_object unsupported; retrying without strict response_format.");
        request = await runCriticRequest(null);
      }
    }
    if (!request.response.ok) {
      onLog?.("stderr", `[QualityGate] Critic review request failed (${request.response.status}): ${toSingleLine(request.text, 240)}`);
      return null;
    }
    const payload = parseJsonObjectLoose(request.text) ?? JSON.parse(request.text);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = String(choices[0]?.message?.content ?? "").trim();
    const reviewObj = parseJsonObjectLoose(content);
    if (!reviewObj) {
      onLog?.("stderr", `[QualityGate] Critic produced non-JSON content; skipping critic gate. Raw: ${toSingleLine(content, 220)}`);
      return null;
    }
    const scoreRaw = Number(reviewObj.score);
    const findings = Array.isArray(reviewObj.findings) ? reviewObj.findings.map((entry) => String(entry).trim()).filter(Boolean) : [];
    const mustFix = Array.isArray(reviewObj.must_fix) ? reviewObj.must_fix.map((entry) => String(entry).trim()).filter(Boolean) : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "").trim().slice(0, 2000);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    return {
      score,
      findings,
      mustFix,
      revisionGuidance,
      raw: compactJobOutput(content, outputPolicyForRuntime(runtimeConfig))
    };
  } catch (err) {
    onLog?.("stderr", `[QualityGate] Critic review unavailable: ${toSingleLine(err, 220)} (continuing without critic gate).`);
    return null;
  }
}
function buildQualityRevisionHint(issues, critic, planning) {
  const lines = [];
  lines.push("Quality revision required before completion.");
  if (issues.length > 0) {
    lines.push("Deterministic quality issues:");
    for (const issue of issues)
      lines.push(`- ${issue}`);
  }
  if (critic) {
    lines.push(`Critic score: ${critic.score.toFixed(1)} / 10`);
    if (critic.mustFix.length > 0) {
      lines.push("Critic must-fix findings:");
      for (const issue of critic.mustFix)
        lines.push(`- ${issue}`);
    }
    if (critic.revisionGuidance) {
      lines.push(`Critic revision guidance: ${critic.revisionGuidance}`);
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
  lines.push("Apply a minimal corrective patch, run focused validation, then finish.");
  return lines.join(`
`).slice(0, 6000);
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
async function git(cwd, args) {
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
    return { ok: exitCode === 0, stdout: stdout.trimEnd(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err) };
  }
}
async function createJobCommit(repo, workerId, job, runtimeConfig = DEFAULT_CONFIG3) {
  const defaultPublicBranchName = `agent/${workerId}/${job.id}`;
  const reviewAgentHeadRef = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" && !Array.isArray(job.params.reviewAgent) ? job.params.reviewAgent.prHeadRef : undefined;
  const resolvedPublicBranch = resolveReviewFixCompletionBranch(job.params?.completionBranch ?? reviewAgentHeadRef, defaultPublicBranchName);
  const publicBranchName = resolvedPublicBranch.branch;
  const requirePush = runtimeConfig.workerpals.requirePush || resolvedPublicBranch.overridden;
  const pushAgentBranch = requirePush || runtimeConfig.workerpals.pushAgentBranch || resolvedPublicBranch.overridden;
  const hiddenCommitRef = `refs/pushpals/agent/${workerId}/${job.id}`;
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
    result = await git(repo, stageArgs);
    if (!result.ok) {
      const stageErr = result.stderr || result.stdout;
      if (/pathspec .* did not match any files/i.test(stageErr) || /invalid path/i.test(stageErr) || /outside repository/i.test(stageErr)) {
        console.warn(`[WorkerPals] Stage target invalid/missing for ${job.kind}; retrying with fallback "git add -A".`);
        result = await git(repo, [
          "add",
          "-A",
          "--",
          ".",
          ":(exclude)workspace/**",
          ":(exclude)outputs/**"
        ]);
      }
      if (!result.ok) {
        return { ok: false, error: `Failed to stage changes: ${result.stderr || result.stdout}` };
      }
    }
    result = await git(repo, ["diff", "--cached", "--quiet"]);
    if (result.ok) {
      console.log(`[WorkerPals] No changes to commit for job ${job.id}`);
      return { ok: true, branch: hiddenCommitRef, sha: "no-changes" };
    }
    const cachedDiff = await git(repo, ["diff", "--cached"]);
    const diff = cachedDiff.ok ? cachedDiff.stdout : "";
    const cachedNameOnly = await git(repo, ["diff", "--cached", "--name-only"]);
    const changedPaths = cachedNameOnly.ok ? parseChangedPathsFromNameOnlyOutput(cachedNameOnly.stdout) : [];
    const jobPlanning = job.params?.planning;
    const jobValidationSteps = toNonEmptyStringArray(jobPlanning?.validationSteps ?? job.params?.validationSteps);
    const llmCommitMsg = await generateCommitMessageFromDiff(diff, {
      instruction: String(job.params?.instruction ?? ""),
      type: normalizeCommitType(job.kind, job.params),
      area: inferCommitArea(job.kind, job.params, changedPaths),
      validationSteps: jobValidationSteps
    }, repo, runtimeConfig).catch(() => null);
    if (!llmCommitMsg) {
      console.warn(`[WorkerPals] Commit message generator unavailable for job ${job.id}; using deterministic fallback.`);
    }
    const commitMsg = llmCommitMsg ?? buildWorkerCommitMessage(workerId, job, changedPaths);
    result = await git(repo, ["commit", "-m", commitMsg]);
    if (!result.ok) {
      return { ok: false, error: `Failed to commit: ${result.stderr}` };
    }
    result = await git(repo, ["rev-parse", "HEAD"]);
    if (!result.ok) {
      return { ok: false, error: `Failed to get commit SHA: ${result.stderr}` };
    }
    let sha = result.stdout;
    result = await git(repo, ["update-ref", hiddenCommitRef, sha]);
    if (!result.ok) {
      return { ok: false, error: `Failed to store worker commit ref: ${result.stderr}` };
    }
    hiddenRefCreated = true;
    if (pushAgentBranch) {
      const maxPushAttempts = 3;
      let pushed = false;
      let pushError = "";
      for (let attempt = 1;attempt <= maxPushAttempts; attempt++) {
        const sync = await syncHiddenRefWithRemoteBranchByRebase(repo, hiddenCommitRef, publicBranchName, job.id);
        if (!sync.ok) {
          pushError = `Failed to sync branch before push: ${redactSensitiveText(sync.error)}`;
          break;
        }
        sha = sync.sha;
        result = await git(repo, [
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
          if (hiddenRefCreated) {
            await git(repo, ["update-ref", "-d", hiddenCommitRef]);
          }
          return { ok: false, error: pushError };
        }
        console.warn(`[WorkerPals] ${pushError}. Continuing with local commit ref only (set WORKERPALS_REQUIRE_PUSH=1 to enforce push).`);
        return { ok: true, branch: completionRef, sha };
      }
    } else {
      console.log(`[WorkerPals] Skipping push for ${publicBranchName} (WORKERPALS_PUSH_AGENT_BRANCH is disabled).`);
    }
    console.log(`[WorkerPals] Created commit ${sha} on ref ${completionRef}`);
    return { ok: true, branch: completionRef, sha };
  } catch (err) {
    if (hiddenRefCreated) {
      await git(repo, ["update-ref", "-d", hiddenCommitRef]);
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
  const targets = buildStageTargets(kind, params);
  if (targets.length === 0) {
    if (kind === "task.execute") {
      return ["add", "-A", "--", ".", ":(exclude)workspace/**", ":(exclude)outputs/**"];
    }
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
  return "worker";
}
function summarizeScope(kind, params, changedPaths = []) {
  const targets = changedPaths.length > 0 ? changedPaths : buildStageTargets(kind, params).filter((p) => p !== ".");
  if (targets.length === 0)
    return "repository-level changes";
  const visible = targets.slice(0, 3).join(", ");
  return targets.length > 3 ? `${visible}, +${targets.length - 3} more` : visible;
}
function isDocPath(path) {
  const lower = path.toLowerCase();
  return lower.startsWith("docs/") || lower.startsWith("wiki/") || lower === "readme.md" || lower.endsWith(".md");
}
function isTestPath(path) {
  return /(?:^|[/\\])tests?[/\\]|\.test\.[a-z0-9]+$|\.spec\.[a-z0-9]+$/i.test(path);
}
function humanizeCommitArea(area) {
  switch (area) {
    case "local_agent":
      return "localbuddy";
    case "remote_agent":
      return "remotebuddy";
    case "source_control_manager":
      return "source control manager";
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
    const testCount = changedPaths.filter(isTestPath).length;
    const docCount = changedPaths.filter(isDocPath).length;
    const codeCount = changedPaths.length - testCount - docCount;
    if (testCount > 0 && codeCount === 0 && docCount === 0) {
      return sanitizeCommitValue(`expand ${label} test coverage`, 72);
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
    if (isTestPath(path)) {
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
      case "npm":
      case "pnpm":
      case "yarn": {
        if (hasToken("test"))
          return true;
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
        return argv.length >= 3 && argv[1].toLowerCase() === "-m" && argv[2].toLowerCase() === "pytest";
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
    ...toNonEmptyStringArray(params?.validation_steps),
    ...toNonEmptyStringArray(planning?.validationSteps),
    ...toNonEmptyStringArray(planning?.validation_steps)
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
  return normalized.includes("cannot pull with rebase: you have unstaged changes") || normalized.includes("cannot rebase: you have unstaged changes") || normalized.includes("please commit or stash them");
}
async function currentRefSha(repo, ref) {
  const result = await git(repo, ["rev-parse", ref]);
  if (!result.ok)
    return null;
  return result.stdout.trim() || null;
}
async function autoResolveRebaseConflicts(repo, maxPasses = 8) {
  for (let pass = 1;pass <= maxPasses; pass++) {
    const unresolved = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
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
        let checkout = await git(repo, ["checkout", "--theirs", "--", path]);
        if (!checkout.ok) {
          checkout = await git(repo, ["checkout", "--ours", "--", path]);
          if (!checkout.ok) {
            return {
              ok: false,
              error: `Failed to resolve rebase conflict for ${path}: ${combinedGitOutput(checkout)}`
            };
          }
        }
      }
      const addAll = await git(repo, ["add", "--update", "--", "."]);
      if (!addAll.ok) {
        return {
          ok: false,
          error: `Failed to stage resolved rebase conflicts: ${combinedGitOutput(addAll)}`
        };
      }
    }
    let rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    let continueOutput = combinedGitOutput(rebaseContinue);
    if (!rebaseContinue.ok && isRebaseEditorPromptOutput(continueOutput)) {
      rebaseContinue = await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      continueOutput = combinedGitOutput(rebaseContinue);
    }
    if (rebaseContinue.ok) {
      continue;
    }
    if (/no rebase in progress/i.test(continueOutput)) {
      return { ok: true };
    }
    if (/no changes - did you forget to use 'git add'|nothing to commit/i.test(continueOutput)) {
      const rebaseSkip = await git(repo, ["rebase", "--skip"]);
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
  const pullRebaseNonInteractive = () => git(repo, [
    "-c",
    "core.editor=true",
    "-c",
    "rebase.autoStash=true",
    "pull",
    "--rebase",
    "origin",
    publicBranchName
  ]);
  const remoteHead = await git(repo, [
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
    const checkout = await git(repo, ["checkout", "-B", tempBranch, hiddenCommitRef]);
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
      let pullRebase = await pullRebaseNonInteractive();
      if (!pullRebase.ok && isPullRebaseDirtyWorkingTreeOutput(combinedGitOutput(pullRebase))) {
        const reset = await git(repo, ["reset", "--hard", "HEAD"]);
        if (!reset.ok) {
          return {
            ok: false,
            error: `Failed to clean working tree before retrying pull --rebase: ${combinedGitOutput(reset)}`
          };
        }
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
        await git(repo, ["rebase", "--abort"]);
        return {
          ok: false,
          error: `Rebase conflict resolution failed for ${publicBranchName}: ${resolved.error}`
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
    const updateHiddenRef = await git(repo, ["update-ref", hiddenCommitRef, rebasedSha]);
    if (!updateHiddenRef.ok) {
      return {
        ok: false,
        error: `Failed to update hidden commit ref after rebase: ${combinedGitOutput(updateHiddenRef)}`
      };
    }
    return { ok: true, sha: rebasedSha };
  } finally {
    if (branchCheckedOut) {
      await git(repo, ["checkout", "--detach", hiddenCommitRef]);
      await git(repo, ["branch", "-D", tempBranch]);
    }
  }
}
function shouldUseCodexCliForExecutor(executor) {
  return executor.trim().toLowerCase() === "openai_codex";
}
function normalizeCodexReasoningEffort(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "high";
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
  const codexPrefix = await resolveCodexCommandPrefix(repo, runtimeConfig.workerpals.llm.codexBin);
  if (!codexPrefix)
    return null;
  const model = runtimeConfig.workerpals.llm.model.trim();
  const timeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.llm.codexTimeoutMs);
    if (!Number.isFinite(value))
      return 120000;
    return Math.max(1e4, Math.min(600000, Math.floor(value)));
  })();
  const reasoningEffort = normalizeCodexReasoningEffort(runtimeConfig.workerpals.llm.reasoningEffort);
  const tmpOutputPath = resolve8(Bun.env.TEMP || Bun.env.TMP || Bun.env.TMPDIR || "/tmp", `pushpals-commit-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
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
  try {
    const stdinText = `${prompt.systemPrompt}

${prompt.userMessage}`;
    const proc = Bun.spawn(cmd, {
      cwd: repo,
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
      content = readFileSync5(tmpOutputPath, "utf8").trim();
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
  const timer = setTimeout(() => controller.abort(), 30000);
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
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function hasInvalidRepoPathHint(values) {
  return values.some((entry) => normalizeStagePath(entry) === null);
}
function asAutonomyComponentArea(value) {
  return normalizeAutonomyComponentArea(value);
}
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
async function collectWriteScopeWarnings(repo, planning) {
  const writeGlobs = toStringArray(planning.scope.writeGlobs ?? []);
  if (writeGlobs.length === 0)
    return { warnings: [] };
  const statusResult = await git(repo, ["status", "--porcelain"]);
  if (!statusResult.ok) {
    return { warnings: ["Unable to evaluate changed paths for scope suggestion check."] };
  }
  const changedPaths = parseChangedPathsFromStatus(statusResult.stdout).map((entry) => normalizeStagePath(entry)).filter((entry) => Boolean(entry) && entry !== ".");
  if (changedPaths.length === 0)
    return { warnings: [] };
  const forbidden = toStringArray(planning.scope.forbiddenGlobs ?? []);
  const warnings = [];
  const outOfScope = changedPaths.filter((path) => !writeGlobs.some((glob) => matchesGlob(path, glob)));
  if (outOfScope.length > 0) {
    warnings.push(`Scope suggestion: modified paths outside writeGlobs: ${outOfScope.join(", ")}`);
  }
  const forbiddenTouched = changedPaths.filter((path) => forbidden.some((glob) => matchesGlob(path, glob)));
  if (forbiddenTouched.length > 0) {
    warnings.push(`Scope suggestion: modified paths matching forbiddenGlobs: ${forbiddenTouched.join(", ")}`);
  }
  return { warnings };
}
function sanitizeTaskExecutePlanningPathHints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const planning = value;
  const out = { ...planning };
  if (planning.scope && typeof planning.scope === "object" && !Array.isArray(planning.scope)) {
    const scope = planning.scope;
    const normalizedScope = { ...scope };
    if (isStringArray(scope.writeGlobs)) {
      normalizedScope.writeGlobs = toStringArray(scope.writeGlobs);
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
      normalizedDiscovery.likelyDirs = toStringArray(discovery.likelyDirs);
    }
    out.discovery = normalizedDiscovery;
  }
  return out;
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
    const normalizedWriteGlobs = isStringArray(scope.writeGlobs) ? toStringArray(scope.writeGlobs) : [];
    if (origin === "autonomy") {
      const declaredComponentArea = asAutonomyComponentArea(options?.autonomyComponentArea);
      const inferredComponentArea = deriveAutonomyComponentArea(normalizedTargetPaths, normalizedWriteGlobs);
      const componentArea = declaredComponentArea ?? inferredComponentArea;
      if (!componentArea) {
        return {
          ok: false,
          message: "task.execute planning.targetPaths must resolve to a repo-relative componentArea"
        };
      }
      if (declaredComponentArea && inferredComponentArea && declaredComponentArea !== inferredComponentArea) {
        return {
          ok: false,
          message: "task.execute planning.targetPaths do not match autonomy componentArea"
        };
      }
      const validatedScope = validateScopeInvariants(componentArea, normalizedTargetPaths, normalizedWriteGlobs, { requireWriteGlobs: false });
      if (!validatedScope.ok) {
        return {
          ok: false,
          message: `task.execute scope invariants failed: ${validatedScope.errors.join("; ")}`
        };
      }
    } else if (normalizedWriteGlobs.length > 0) {
      const uncoveredPaths = normalizedTargetPaths.filter((targetPath) => !normalizedWriteGlobs.some((glob) => matchesGlob(targetPath, glob)));
      if (uncoveredPaths.length > 0) {
        return {
          ok: false,
          message: `task.execute planning.targetPaths must be covered by planning.scope.writeGlobs: ${uncoveredPaths.join(", ")}`
        };
      }
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
    onLog?.("stderr", "[QualityGate] Codex critic: unable to resolve Codex CLI command (workerpals.llm.codex_bin/PATH); skipping.");
    return null;
  }
  const instruction = String(params.instruction ?? "").trim();
  const planning = params.planning;
  const changedForDiff = quality.changedPaths.slice(0, 8);
  let diffText = "";
  const qualityCriticMaxDiffChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxDiffChars);
    if (!Number.isFinite(value))
      return 16000;
    return Math.max(256, Math.min(524288, Math.floor(value)));
  })();
  const qualityCriticMaxValidationOutputChars = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMaxValidationOutputChars);
    if (!Number.isFinite(value))
      return 8000;
    return Math.max(256, Math.min(524288, Math.floor(value)));
  })();
  const qualityCriticTimeoutMs = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticTimeoutMs);
    if (!Number.isFinite(value))
      return 45000;
    return Math.max(1000, Math.min(7200000, Math.floor(value)));
  })();
  if (changedForDiff.length > 0) {
    const diffResult = await git(repo, ["diff", "--", ...changedForDiff]);
    diffText = (diffResult.ok ? diffResult.stdout : diffResult.stderr).slice(0, qualityCriticMaxDiffChars);
  }
  const validationSummary = quality.validationRuns.map((run) => {
    const output = [run.stdout, run.stderr].filter(Boolean).join(`
`).slice(0, qualityCriticMaxValidationOutputChars);
    return [
      `Command: ${run.command}`,
      `Result: ${run.ok ? "pass" : "fail"} (exit ${run.exitCode})`,
      output
    ].filter(Boolean).join(`
`);
  }).join(`
---
`);
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
  const tmpOutputPath = `/tmp/pushpals-critic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const cmd = [
    ...codexPrefix,
    "-c",
    'model_reasoning_effort="low"',
    "-a",
    "never",
    "exec",
    "-s",
    "read-only",
    "--output-last-message",
    tmpOutputPath,
    "-"
  ];
  try {
    const proc = Bun.spawn(cmd, {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([criticInstruction])
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
      onLog?.("stderr", "[QualityGate] Codex critic timed out; skipping.");
      return null;
    }
    if (exitCode !== 0) {
      const stderrText = await new Response(proc.stderr).text();
      onLog?.("stderr", `[QualityGate] Codex critic exited ${exitCode}: ${toSingleLine(stderrText, 220)}`);
      return null;
    }
    let lastMessage = "";
    try {
      lastMessage = (await Bun.file(tmpOutputPath).text()).trim();
    } catch {}
    try {
      unlinkSync(tmpOutputPath);
    } catch {}
    if (!lastMessage) {
      onLog?.("stderr", "[QualityGate] Codex critic: no output message captured; skipping.");
      return null;
    }
    const reviewObj = parseJsonObjectLoose(lastMessage);
    if (!reviewObj) {
      onLog?.("stderr", `[QualityGate] Codex critic returned non-JSON: ${toSingleLine(lastMessage, 220)}`);
      return null;
    }
    const scoreRaw = Number(reviewObj.score);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0;
    const findings = Array.isArray(reviewObj.findings) ? reviewObj.findings.map((f) => String(f).trim()).filter(Boolean) : [];
    const mustFix = Array.isArray(reviewObj.must_fix) ? reviewObj.must_fix.map((f) => String(f).trim()).filter(Boolean) : [];
    const revisionGuidance = String(reviewObj.revision_guidance ?? "").trim().slice(0, 2000);
    onLog?.("stdout", `[QualityGate] Codex critic score: ${score}/10`);
    return {
      score,
      findings,
      mustFix,
      revisionGuidance,
      raw: compactJobOutput(lastMessage, outputPolicyForRuntime(runtimeConfig))
    };
  } catch (err) {
    onLog?.("stderr", `[QualityGate] Codex critic error: ${toSingleLine(err, 220)} (skipping).`);
    return null;
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
  const planningValidation = validateTaskExecutePlanning(params.planning, {
    origin,
    autonomyComponentArea: autonomyScope?.componentArea ?? autonomyScope?.component_area
  });
  if (!planningValidation.ok) {
    return {
      ok: false,
      summary: planningValidation.message,
      exitCode: 2
    };
  }
  const sanitizedPlanning = sanitizeTaskExecutePlanningPathHints(params.planning);
  const planning = sanitizedPlanning;
  if (origin === "autonomy" && toStringArray(planning.scope.writeGlobs ?? []).length === 0) {
    onLog?.("stdout", "[TaskExecute] Scope suggestion: planning.scope.writeGlobs is empty for autonomy-origin task.");
  }
  const instruction = String(params.instruction ?? "").trim();
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
  const executionBudgetMs = Number(planning.executionBudgetMs);
  const finalizationBudgetMs = Number(planning.finalizationBudgetMs);
  const qualityMaxAutoRevisions = Math.max(0, Math.min(10, Number.isFinite(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions)) ? Math.floor(Number(runtimeConfig.workerpals.qualityMaxAutoRevisions)) : 4));
  const qualitySoftPassOnExhausted = typeof runtimeConfig.workerpals.qualitySoftPassOnExhausted === "boolean" ? runtimeConfig.workerpals.qualitySoftPassOnExhausted : true;
  const qualityCriticMinScore = (() => {
    const value = Number(runtimeConfig.workerpals.qualityCriticMinScore);
    if (!Number.isFinite(value))
      return 8;
    return Math.max(0, Math.min(10, value));
  })();
  onLog?.("stdout", `[QualityGate] Policy: max_auto_revisions=${qualityMaxAutoRevisions}, soft_pass_on_exhausted=${qualitySoftPassOnExhausted ? "true" : "false"}, critic_min_score=${qualityCriticMinScore}`);
  let revisionAttempt = 0;
  let revisionHint = "";
  while (revisionAttempt <= qualityMaxAutoRevisions) {
    const attemptParams = { ...normalizedParams };
    if (revisionHint) {
      attemptParams.qualityRevisionHint = revisionHint;
      attemptParams.qualityRevisionAttempt = revisionAttempt;
    }
    const executor = resolveExecutor(runtimeConfig);
    const executeBudgets = { executionBudgetMs, finalizationBudgetMs };
    const runExecutor = getBackendTaskExecutor(executor);
    if (!runExecutor) {
      return {
        ok: false,
        summary: `No task executor registered for backend "${executor}"`,
        exitCode: 1
      };
    }
    const result = await runExecutor(kind, attemptParams, repo, runtimeConfig, onLog, executeBudgets);
    if (!result.ok)
      return result;
    const scopeCheck = await collectWriteScopeWarnings(repo, planning);
    for (const warning of scopeCheck.warnings) {
      onLog?.("stdout", `[TaskExecute] ${warning}`);
    }
    const quality = await runDeterministicQualityGate(repo, attemptParams, runtimeConfig, onLog);
    const critic = quality.skipped ? null : executor === "openai_codex" ? await runCodexCriticReview(repo, attemptParams, quality, runtimeConfig, onLog) : await runTaskCriticReview(repo, attemptParams, quality, runtimeConfig, onLog);
    const criticRequiresRevision = Boolean(critic && critic.score < qualityCriticMinScore);
    if (!criticRequiresRevision) {
      if (critic) {
        onLog?.("stdout", `[QualityGate] Critic review score ${critic.score.toFixed(1)}/10 (threshold ${qualityCriticMinScore}).`);
      }
      return result;
    }
    const issues = [];
    if (criticRequiresRevision && critic) {
      issues.push(...buildCriticRevisionIssues(critic, qualityCriticMinScore));
    }
    const issueSummary = issues.map((entry) => toSingleLine(entry, 180)).join(" | ");
    if (revisionAttempt >= qualityMaxAutoRevisions) {
      if (qualitySoftPassOnExhausted) {
        const diagnostics = truncate([result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig));
        onLog?.("stderr", `[QualityGate] Soft-pass after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(issueSummary, 260)}`);
        return {
          ...result,
          summary: `${result.summary} (quality gate soft-pass after ${revisionAttempt} auto-revision attempt(s))`,
          stderr: diagnostics,
          exitCode: typeof result.exitCode === "number" ? result.exitCode : 0
        };
      }
      return {
        ok: false,
        summary: `Quality gate failed after ${revisionAttempt} auto-revision attempt(s): ${toSingleLine(issueSummary, 240)}`,
        stdout: result.stdout,
        stderr: truncate([result.stderr ?? "", critic ? `Critic raw: ${critic.raw}` : ""].filter(Boolean).join(`
`), outputPolicyForRuntime(runtimeConfig)),
        exitCode: 4
      };
    }
    revisionAttempt += 1;
    revisionHint = buildQualityRevisionHint(issues, critic, planning);
    onLog?.("stderr", `[QualityGate] Quality gate requested revision ${revisionAttempt}/${qualityMaxAutoRevisions}: ${toSingleLine(issueSummary, 260)}`);
  }
  return {
    ok: false,
    summary: "Quality revision loop ended unexpectedly.",
    exitCode: 4
  };
}

// apps/workerpals/src/docker_executor.ts
import { randomUUID } from "crypto";
import { existsSync as existsSync7, mkdirSync, readFileSync as readFileSync6, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute as isAbsolute2, relative, resolve as resolve9 } from "path";

// apps/workerpals/src/common/worktree_cleanup.ts
import { existsSync as existsSync6, rmSync } from "fs";
function defaultSleep(ms) {
  return new Promise((resolve9) => setTimeout(resolve9, ms));
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
  const removePath = options.removeFn ?? ((targetPath) => rmSync(targetPath, { recursive: true, force: true }));
  const pathExists = options.existsFn ?? ((targetPath) => existsSync6(targetPath));
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

// apps/workerpals/src/docker_executor.ts
var DEFAULT_OPENHANDS_MODEL = "local-model";
var DEFAULT_CONFIG4 = loadPushPalsConfig();
var SHARED_CONTAINER_VENV_PYTHON = "/workspace/.venv/bin/python";
var WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
var WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
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
function resolveDockerExecutable() {
  const absolute = String(process.env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "").trim();
  if (absolute)
    return absolute;
  const configured = String(process.env.PUSHPALS_DOCKER_BIN ?? "").trim();
  if (configured)
    return configured;
  return process.platform === "win32" ? "docker.exe" : "docker";
}
function resolveWorkerpalSandboxBuildContext(repoRoot) {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT ?? "").trim();
  const sandboxRoot = configuredRoot || repoRoot;
  const dockerfilePath = configuredRoot ? resolve9(sandboxRoot, "apps", "workerpals", "Dockerfile.sandbox") : resolve9(repoRoot, "apps", "workerpals", "Dockerfile.sandbox");
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
function normalizeMergeConflictHeadRef(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const withoutRefs = trimmed.replace(/^refs\/heads\//, "");
  const withoutOrigin = withoutRefs.replace(/^origin\//, "");
  const normalized = withoutOrigin.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized)
    return null;
  if (normalized.includes("..") || normalized.includes("@{") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    return null;
  }
  if (/[~^:?*\[\]\s]/.test(normalized))
    return null;
  return normalized;
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
  lastLoggedExecutionConfig = "";
  lastLoggedEndpointRewrite = "";
  warmedBackends = new Set;
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
    this.worktreeDir = resolve9(this.options.repo, ".worktrees");
    this.warmContainerName = `pushpals-${this.options.workerId}-warm`;
    this.warmAgentStartupTimeoutMs = startupTimeoutMs;
    this.warmSetupMaxAttempts = parseClampedInt(this.config.workerpals.dockerWarmMaxAttempts, 3, 1, 5);
    this.warmSetupBackoffMs = parseClampedInt(this.config.workerpals.dockerWarmRetryBackoffMs, 2000, 250, 60000);
    this.jobRetryMaxAttempts = parseClampedInt(this.config.workerpals.dockerJobMaxAttempts, 2, 1, 3);
    this.jobRetryBackoffMs = parseClampedInt(this.config.workerpals.dockerJobRetryBackoffMs, 3000, 250, 60000);
    this.failureCooldownMs = parseClampedIntAllowZero(this.config.workerpals.failureCooldownMs, 20000, 300000);
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {}
  }
  async execute(job, onLog) {
    this.activeJobs += 1;
    this.clearIdleTimer();
    const worktreeName = this.buildEphemeralWorktreeName("job", job.id);
    const worktreePath = resolve9(this.worktreeDir, worktreeName);
    try {
      await this.ensureFreshImageForMergeConflictJob(job, onLog);
      const worktreeBaseRef = await this.resolveWorktreeBaseRefForJob(job, onLog);
      await this.createWorktree(worktreePath, worktreeBaseRef);
      const jobSpec = {
        jobId: job.id,
        taskId: job.taskId,
        kind: job.kind,
        params: job.params,
        workerId: this.options.workerId
      };
      const base64Spec = Buffer.from(JSON.stringify(jobSpec)).toString("base64");
      for (let attempt = 1;attempt <= this.jobRetryMaxAttempts; attempt++) {
        try {
          this.logExecutionConfig();
          const result = await this.runInWarmContainer(worktreePath, base64Spec, job, onLog);
          if (result.ok)
            return result;
          const retryableFailure = this.isRetryableJobFailure(result);
          if (attempt >= this.jobRetryMaxAttempts || !retryableFailure) {
            if (retryableFailure && attempt >= this.jobRetryMaxAttempts && this.failureCooldownMs > 0) {
              return {
                ...result,
                cooldownMs: this.failureCooldownMs
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
          if (attempt >= this.jobRetryMaxAttempts || !retryableError) {
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
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      await this.removeWorktree(worktreePath).catch((err) => {
        console.error(`[DockerExecutor] Failed to remove worktree: ${err}`);
      });
      this.scheduleIdleShutdown();
    }
  }
  async validateWorktreeGitInterop() {
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "startup");
    const worktreePath = resolve9(this.worktreeDir, worktreeName);
    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath);
      console.log(`[DockerExecutor] Startup self-check passed (git/worktree in container).`);
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {});
    }
  }
  async createWorktree(worktreePath, baseRef) {
    await this.ensureFreshWorktreePath(worktreePath);
    let proc = Bun.spawn(["git", "worktree", "add", "--detach", worktreePath, baseRef], {
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
      proc = Bun.spawn(["git", "worktree", "add", "--force", "--detach", worktreePath, baseRef], {
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
    this.rewriteWorktreeGitdirToRelative(worktreePath);
    console.log(`[DockerExecutor] Created worktree: ${worktreePath}`);
  }
  rewriteWorktreeGitdirToRelative(worktreePath) {
    try {
      const gitFilePath = resolve9(worktreePath, ".git");
      const raw = readFileSync6(gitFilePath, "utf-8").trim();
      const match = raw.match(/^gitdir:\s*(.+)$/i);
      if (!match)
        return;
      const gitdirRaw = match[1].trim();
      const hasWindowsDrive = /^[a-zA-Z]:[\\/]/.test(gitdirRaw);
      if (!hasWindowsDrive && !isAbsolute2(gitdirRaw)) {
        return;
      }
      const rel = relative(worktreePath, gitdirRaw).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") === false) {
        return;
      }
      writeFileSync(gitFilePath, `gitdir: ${rel}
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
      ...authMountArgs
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
    const startupCmd = backendSpec.warmContainerStartupCommand(warmContext);
    args.push("--entrypoint", "/bin/sh", this.options.imageName, "-lc", startupCmd);
    const proc = Bun.spawn([resolveDockerExecutable(), ...args], { stdout: "pipe", stderr: "pipe" });
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
    const hostCodexHome = (hostCodexHomeRaw ? isAbsolute2(hostCodexHomeRaw) ? hostCodexHomeRaw : resolve9(this.options.repo, hostCodexHomeRaw) : resolve9(homedir(), ".codex")).trim();
    if (!hostCodexHome)
      return [];
    if (!existsSync7(hostCodexHome)) {
      try {
        mkdirSync(hostCodexHome, { recursive: true });
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
  async runInWarmContainer(worktreePath, base64Spec, job, onLog) {
    await this.ensureWarmRuntimeReady(job, onLog);
    const startedAtMs = Date.now();
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    const args = [
      "exec",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "bun",
      "run",
      "/workspace/apps/workerpals/src/job_runner.ts",
      base64Spec
    ];
    console.log(`[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary()})`);
    const proc = Bun.spawn([resolveDockerExecutable(), ...args], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const { leadMs: warningLeadMs, delayMs: warningDelayMs } = computeTimeoutWarningWindow(this.options.timeoutMs);
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
      const timeoutMsg = `[DockerExecutor] Job timeout in warm container after ${elapsedMs2}ms (limit ${this.options.timeoutMs}ms): ${this.warmContainerName}`;
      console.log(timeoutMsg);
      onLog?.("stderr", timeoutMsg);
      try {
        proc.kill();
        Bun.spawn([resolveDockerExecutable(), "restart", "-t", "1", this.warmContainerName]);
      } catch {}
    }, this.options.timeoutMs);
    const stdoutLines = [];
    const stderrLines = [];
    await Promise.all([
      this.readStream(proc.stdout, "stdout", onLog, stdoutLines),
      this.readStream(proc.stderr, "stderr", onLog, stderrLines)
    ]);
    clearTimeout(warningTimer);
    clearTimeout(timer);
    const exitCode = await proc.exited;
    const elapsedMs = Math.max(1, Date.now() - startedAtMs);
    const result = this.parseResult(stdoutLines, stderrLines, exitCode, {
      timedOutByDocker,
      elapsedMs
    });
    return result;
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
  async runGitSelfCheckContainer(worktreePath) {
    const containerName = `pushpals-${this.options.workerId}-selfcheck-${Date.now()}`;
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    const proc = Bun.spawn([
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
      "--entrypoint",
      "/bin/sh",
      this.options.imageName,
      "-lc",
      "git rev-parse --is-inside-work-tree && git rev-parse --git-dir && git status --porcelain"
    ], {
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
      return {
        ok: false,
        summary: `Worker returned malformed structured result after ${context.elapsedMs}ms`,
        stdout,
        stderr: details.join(`
`),
        exitCode
      };
    }
    if (context.timedOutByDocker) {
      return {
        ok: false,
        summary: `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${this.options.timeoutMs}ms; terminated before structured result).`,
        stdout,
        stderr,
        exitCode
      };
    }
    if (exitCode === 143 || exitCode === 137) {
      return {
        ok: false,
        summary: `Job process was terminated (exit ${exitCode}) after ${context.elapsedMs}ms before structured result was produced.`,
        stdout,
        stderr,
        exitCode
      };
    }
    return {
      ok: exitCode === 0,
      summary: exitCode === 0 ? `Job completed in ${context.elapsedMs}ms` : `Job failed (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`,
      stdout,
      stderr,
      exitCode
    };
  }
  async ensureWarmRuntimeReady(job, onLog) {
    const backend = resolveExecutor(this.config);
    for (let attempt = 1;attempt <= this.warmSetupMaxAttempts; attempt++) {
      try {
        await this.ensureWarmContainer();
        await this.ensureBackendWarmup(backend);
        return;
      } catch (err) {
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
  isRetryableJobFailure(result) {
    const text = `${result.summary ?? ""}
${result.stderr ?? ""}`.toLowerCase();
    return this.matchesRetryablePattern(text);
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
      /\bjob timed out in docker executor\b/i
    ];
    return transientPatterns.some((pattern) => pattern.test(text));
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
    const safeWorker = this.sanitizeWorktreeToken(this.options.workerId, 24);
    const safeToken = this.sanitizeWorktreeToken(token, 40);
    const nonce = `${Date.now().toString(36)}-${randomUUID().slice(0, 8).toLowerCase()}`;
    return `${prefix}-${safeToken}-${safeWorker}-${nonce}`;
  }
  sanitizeWorktreeToken(value, maxLength) {
    const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!normalized)
      return "work";
    return normalized.slice(0, maxLength);
  }
  async ensureFreshWorktreePath(worktreePath) {
    if (!existsSync7(worktreePath))
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
    return resolutionType === "merge_conflict";
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
    if (!existsSync7(dockerfilePath)) {
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
    const reviewAgent = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" ? job.params.reviewAgent : null;
    const resolutionType = reviewAgent && typeof reviewAgent.resolutionType === "string" ? reviewAgent.resolutionType.trim().toLowerCase() : "";
    if (resolutionType !== "merge_conflict")
      return this.options.baseRef;
    const normalizedHeadRef = normalizeMergeConflictHeadRef(reviewAgent?.prHeadRef);
    if (!normalizedHeadRef) {
      const note = `[DockerExecutor] Merge-conflict job ${job.id} has no usable prHeadRef; falling back to ${this.options.baseRef}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }
    const remoteRef = `origin/${normalizedHeadRef}`;
    const fetch2 = Bun.spawn(["git", "fetch", "origin", normalizedHeadRef, "--quiet"], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    const fetchExit = await fetch2.exited;
    if (fetchExit !== 0) {
      const fetchErr = (await new Response(fetch2.stderr).text()).trim();
      const note = `[DockerExecutor] Merge-conflict job ${job.id} could not refresh ${remoteRef}; falling back to ${this.options.baseRef}${fetchErr ? ` (${fetchErr})` : ""}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }
    const verify = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", remoteRef], {
      cwd: this.options.repo,
      stdout: "pipe",
      stderr: "pipe"
    });
    const verifyExit = await verify.exited;
    if (verifyExit !== 0) {
      const note = `[DockerExecutor] Merge-conflict job ${job.id} could not verify ${remoteRef}; falling back to ${this.options.baseRef}.`;
      console.warn(note);
      onLog?.("stderr", note);
      return this.options.baseRef;
    }
    const info = `[DockerExecutor] Merge-conflict job ${job.id}: using fresh worktree base ${remoteRef}.`;
    console.log(info);
    onLog?.("stdout", info);
    return remoteRef;
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
    const proc = Bun.spawn([resolveDockerExecutable(), "pull", this.options.imageName], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`[DockerExecutor] Image pulled successfully`);
      return true;
    }
    const stderr = (await new Response(proc.stderr).text()).trim();
    console.error(`[DockerExecutor] Failed to pull image: ${stderr}`);
    if (await this.imageExists()) {
      console.warn(`[DockerExecutor] Pull failed but local image is now available: ${this.options.imageName}`);
      return true;
    }
    return false;
  }
  async imageExists() {
    const proc = Bun.spawn([resolveDockerExecutable(), "image", "inspect", this.options.imageName], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }
  async inspectImageRuntimeTag() {
    const proc = Bun.spawn([
      resolveDockerExecutable(),
      "image",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
      this.options.imageName
    ], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0)
      return "";
    const value = stdout.trim();
    return value === "<no value>" ? "" : value;
  }
  async buildLocalImage(runtimeTag) {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    if (!existsSync7(sandboxContext.dockerfilePath)) {
      return false;
    }
    const dockerfileArg = dockerBuildFileArg(sandboxContext.root, sandboxContext.dockerfilePath);
    console.log(runtimeTag ? `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName} for runtimeTag=${runtimeTag}` : `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName}`);
    const args = [
      resolveDockerExecutable(),
      "build",
      "-f",
      dockerfileArg,
      "--label",
      WORKERPAL_SANDBOX_COMPONENT_LABEL,
      ...runtimeTag ? ["--label", `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`] : [],
      "-t",
      this.options.imageName,
      "."
    ];
    const proc = Bun.spawn(args, {
      cwd: sandboxContext.root,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (exitCode === 0) {
      return true;
    }
    const detail = stderr.trim() || stdout.trim() || `docker build exited ${exitCode}`;
    console.error(`[DockerExecutor] Failed to build local image: ${detail}`);
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

// apps/workerpals/src/workerpals_main.ts
var DEFAULT_LLM_MODEL = "local-model";
var CODEX_UNAVAILABLE_WORKER_EXIT_CODE = 86;
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
function integrationBranchName() {
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
function sanitizeJobLogLine(line) {
  const cleaned = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
  return redactSensitiveText(cleaned);
}
function isNoisyProgressLine(line) {
  return /^(\uD83D\uDCE6 Installing \[\d+\/\d+\]|\uD83D\uDD0D Resolving\.\.\.|\uD83D\uDD12 Saving lockfile\.\.\.)$/.test(line);
}
function shouldRecycleWorkerForCodexUnavailableFailure(summary, stderr) {
  const text = `${summary}
${stderr ?? ""}`.toLowerCase();
  return [
    "openai_codex cli is not installed",
    "openai_codex chatgpt auth is not ready",
    "openai_codex api_key auth requires openai_api_key",
    "openai_codex policy violation: codex cli workaround detected",
    "codex cli isn't available",
    "codex cli is mandatory in this backend"
  ].some((needle) => text.includes(needle));
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
  const result = await git(repo, ["remote", "get-url", remote]);
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
    return {
      ok: result.ok,
      summary: result.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      commit: result.commit
    };
  }
  return executeJob(job.kind, job.params, repo, onLog, runtimeConfig);
}
async function resolveWorktreeBaseRef(repo, requestedRef) {
  const integrationBranch = integrationBranchName();
  const integrationRemoteRef = `origin/${integrationBranch}`;
  const candidates = new Set([
    requestedRef,
    integrationRemoteRef,
    integrationBranch,
    "HEAD"
  ]);
  if (requestedRef.startsWith("origin/")) {
    const branch = requestedRef.slice("origin/".length);
    const fetchResult = await git(repo, ["fetch", "origin", branch, "--quiet"]);
    if (!fetchResult.ok) {
      console.warn(`[WorkerPals] Could not refresh ${requestedRef}; continuing with local refs (${fetchResult.stderr || fetchResult.stdout})`);
    }
    candidates.add(branch);
  } else if (requestedRef !== "HEAD") {
    candidates.add(`origin/${requestedRef}`);
  }
  for (const ref of candidates) {
    const parsed = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
    if (parsed.ok)
      return ref;
  }
  return "HEAD";
}
async function createIsolatedWorktree(repo, jobId, baseRef) {
  const worktreeRoot = resolve10(repo, ".worktrees");
  mkdirSync2(worktreeRoot, { recursive: true });
  const worktreePath = resolve10(worktreeRoot, `host-job-${jobId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const addResult = await git(repo, ["worktree", "add", "--detach", worktreePath, baseRef]);
  if (!addResult.ok) {
    throw new Error(`Failed to create isolated worktree: ${addResult.stderr}`);
  }
  return worktreePath;
}
async function removeIsolatedWorktree(repo, worktreePath) {
  const removeResult = await git(repo, ["worktree", "remove", "--force", worktreePath]);
  if (!removeResult.ok) {
    console.warn(`[WorkerPals] Worktree cleanup warning (${worktreePath}): ${removeResult.stderr || removeResult.stdout}`);
  }
  const pruneResult = await git(repo, ["worktree", "prune"]);
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
  if (!Array.isArray(planning.validationSteps))
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of planning.validationSteps) {
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
  const remoteRef = `refs/heads/${branch}`;
  const lsRemote = await git(repo, ["ls-remote", "origin", remoteRef]);
  if (lsRemote.ok) {
    const sha = parseLsRemoteSha(lsRemote.stdout);
    if (sha)
      return { branch, sha };
  }
  const localRefs = [branch, `refs/heads/${branch}`, `origin/${branch}`];
  for (const ref of localRefs) {
    const revParse = await git(repo, ["rev-parse", "--verify", ref]);
    if (revParse.ok) {
      const sha = revParse.stdout.trim();
      if (sha)
        return { branch, sha };
    }
  }
  return null;
}
async function enqueueCompletion(server, headers, workerId, integrationBranch, job, commit, resultSummary) {
  try {
    const reviewAgent = job.params?.reviewAgent && typeof job.params.reviewAgent === "object" ? job.params.reviewAgent : null;
    const prUrl = reviewAgent && typeof reviewAgent.prUrl === "string" && reviewAgent.prUrl.trim().length > 0 ? reviewAgent.prUrl.trim() : null;
    const pr = buildCompletionPrMetadata({
      workerId,
      integrationBranch,
      job,
      commit,
      resultSummary
    });
    const response = await fetch(`${server}/completions/enqueue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jobId: job.id,
        sessionId: job.sessionId,
        commitSha: commit.sha,
        branch: commit.branch,
        message: `${job.kind}: ${job.taskId} (worker PR metadata attached)`,
        prUrl,
        prTitle: pr.title,
        prBody: pr.body
      })
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
function sendCommand(server, sessionId, headers, cmd) {
  return fetch(`${server}/sessions/${sessionId}/command`, {
    method: "POST",
    headers,
    body: JSON.stringify(cmd)
  }).then((res) => {
    if (!res.ok)
      console.error(`[WorkerPals] Command ${cmd.type} failed: ${res.status}`);
  }).catch((err) => console.error(`[WorkerPals] Command ${cmd.type} error:`, err));
}
function buildWorkerHeaders(authToken) {
  const headers = { "Content-Type": "application/json" };
  if (authToken)
    headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}
async function sendWorkerHeartbeat(opts, headers, status, currentJobId = null) {
  try {
    await fetch(`${opts.server}/workers/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workerId: opts.workerId,
        status,
        currentJobId,
        pollMs: opts.pollMs,
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
      })
    });
  } catch (err) {
    console.error(`[WorkerPals] Heartbeat error:`, err);
  }
}
async function failActiveJobOnShutdown(opts, headers, runtimeState, signalName) {
  const activeJobId = runtimeState.currentJobId;
  if (!activeJobId)
    return;
  const message = "Worker process shutting down during claimed job";
  const detail = `worker=${opts.workerId}; signal=${signalName}; action=fail-claimed-job-on-shutdown`;
  try {
    await fetch(`${opts.server}/jobs/${activeJobId}/fail`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, detail })
    });
  } catch (err) {
    console.error(`[WorkerPals] Failed to mark active job ${activeJobId} as failed during shutdown:`, err);
  }
  if (runtimeState.currentSessionId) {
    await sendCommand(opts.server, runtimeState.currentSessionId, headers, {
      type: "job_failed",
      payload: {
        jobId: activeJobId,
        message,
        detail
      },
      from: `worker:${opts.workerId}`
    });
  }
}
async function workerLoop(opts, dockerExecutor, runtimeState) {
  const headers = buildWorkerHeaders(opts.authToken);
  console.log(`[WorkerPals ${opts.workerId}] Polling ${opts.server} every ${opts.pollMs}ms`);
  if (dockerExecutor) {
    console.log(`[WorkerPals ${opts.workerId}] Docker mode enabled (${opts.dockerImage}, network=${opts.dockerNetworkMode})`);
  } else {
    console.log(`[WorkerPals ${opts.workerId}] Direct mode with isolated worktrees enabled`);
  }
  console.log(`[WorkerPals ${opts.workerId}] Executor backend: ${resolveExecutor(CONFIG)}`);
  const heartbeatEveryMs = Math.max(1000, opts.heartbeatMs);
  let lastHeartbeatAt = 0;
  const maybeHeartbeat = async (status, currentJobId = null, force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatEveryMs)
      return;
    await sendWorkerHeartbeat(opts, headers, status, currentJobId);
    lastHeartbeatAt = now;
  };
  await maybeHeartbeat("idle", null, true);
  while (!runtimeState.shutdownRequested) {
    try {
      await maybeHeartbeat("idle");
      const claimRes = await fetch(`${opts.server}/jobs/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workerId: opts.workerId })
      });
      if (claimRes.ok) {
        const data = await claimRes.json();
        const job = data.job;
        if (job) {
          runtimeState.currentJobId = job.id;
          runtimeState.currentSessionId = job.sessionId ?? null;
          console.log(`[WorkerPals] Claimed job ${job.id} (${job.kind})`);
          await maybeHeartbeat("busy", job.id, true);
          const busyHeartbeat = setInterval(() => {
            sendWorkerHeartbeat(opts, headers, "busy", job.id);
          }, heartbeatEveryMs);
          if (job.sessionId) {
            await sendCommand(opts.server, job.sessionId, headers, {
              type: "job_claimed",
              payload: { jobId: job.id, workerId: opts.workerId },
              from: `worker:${opts.workerId}`
            });
          }
          let stdoutSeq = 0;
          let stderrSeq = 0;
          let logChain = Promise.resolve();
          let lastCleanLog = "";
          let lastCleanLogAt = 0;
          const onLog = job.sessionId ? (stream, line) => {
            const cleaned = sanitizeJobLogLine(line);
            if (!cleaned)
              return;
            if (LOG.isDebugEnabled())
              LOG.debug(`[${stream}] ${cleaned}`);
            if (isNoisyProgressLine(cleaned))
              return;
            const now = Date.now();
            if (cleaned === lastCleanLog && now - lastCleanLogAt < 1000)
              return;
            lastCleanLog = cleaned;
            lastCleanLogAt = now;
            const logTs = new Date(now).toISOString();
            const seq = stream === "stdout" ? ++stdoutSeq : ++stderrSeq;
            logChain = logChain.then(() => Promise.allSettled([
              sendCommand(opts.server, job.sessionId, headers, {
                type: "job_log",
                payload: { jobId: job.id, stream, seq, line: cleaned, ts: logTs },
                from: `worker:${opts.workerId}`
              }),
              fetch(`${opts.server}/jobs/${job.id}/log`, {
                method: "POST",
                headers,
                body: JSON.stringify({ stream, seq, message: cleaned, ts: logTs })
              })
            ]).then(() => {
              return;
            }));
          } : undefined;
          let directWorktreePath = null;
          let executionRepo = opts.repo;
          let result = null;
          let recycleWorkerAfterJob = false;
          try {
            if (!dockerExecutor) {
              directWorktreePath = await createIsolatedWorktree(opts.repo, job.id, opts.worktreeBaseRef);
              executionRepo = directWorktreePath;
            }
            const parsedParams = typeof job.params === "string" ? JSON.parse(job.params) : job.params;
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
              result = {
                ok: false,
                summary: "Job execution failed before completion",
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
            await logChain;
            let completionCommit = null;
            if (result.ok && shouldCommit(job.kind, CONFIG)) {
              if (result.commit) {
                if (result.commit.sha !== "no-changes") {
                  completionCommit = result.commit;
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
                  context: "host"
                }, CONFIG);
                if (commitResult.ok && commitResult.sha && commitResult.branch) {
                  if (commitResult.sha !== "no-changes") {
                    completionCommit = {
                      branch: commitResult.branch,
                      sha: commitResult.sha
                    };
                  }
                } else if (commitResult.error) {
                  console.error(`[WorkerPals] Failed to create commit: ${commitResult.error}`);
                }
              }
            }
            if (completionCommit) {
              const enqueued = await enqueueCompletion(opts.server, headers, opts.workerId, integrationBranchName(), {
                id: job.id,
                taskId: job.taskId,
                kind: job.kind,
                sessionId: job.sessionId,
                params: parsedParams
              }, completionCommit, result.summary);
              if (!enqueued && completionCommit.branch.startsWith("refs/pushpals/")) {
                const cleanupRef = await git(executionRepo, [
                  "update-ref",
                  "-d",
                  completionCommit.branch
                ]);
                if (!cleanupRef.ok) {
                  console.warn(`[WorkerPals] Failed to clean local completion ref ${completionCommit.branch}: ${cleanupRef.stderr || cleanupRef.stdout}`);
                }
              }
            }
            if (result.ok) {
              const reviewAgent = parsedParams.reviewAgent && typeof parsedParams.reviewAgent === "object" ? parsedParams.reviewAgent : null;
              const jobPrUrl = reviewAgent && typeof reviewAgent.prUrl === "string" && reviewAgent.prUrl.trim().length > 0 ? reviewAgent.prUrl.trim() : null;
              await fetch(`${opts.server}/jobs/${job.id}/complete`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  summary: result.summary,
                  durationMs: jobDurationMs,
                  prUrl: jobPrUrl,
                  artifacts: [
                    ...result.stdout ? [{ kind: "stdout", text: result.stdout }] : [],
                    ...result.stderr ? [{ kind: "stderr", text: result.stderr }] : []
                  ]
                })
              });
              console.log(`[WorkerPals] Job ${job.id} completed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`);
            } else {
              await fetch(`${opts.server}/jobs/${job.id}/fail`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  message: result.summary,
                  detail: redactSensitiveText(result.stderr ?? ""),
                  durationMs: jobDurationMs
                })
              });
              console.log(`[WorkerPals] Job ${job.id} failed in ${formatDurationMs(jobDurationMs)}: ${result.summary}`);
              recycleWorkerAfterJob = shouldRecycleWorkerForCodexUnavailableFailure(result.summary, result.stderr);
              if (recycleWorkerAfterJob) {
                console.error(`[WorkerPals] Codex backend unavailable for job ${job.id}; terminating this worker for replacement.`);
              }
            }
            if (job.sessionId) {
              const responseMode = String(parsedParams.responseMode ?? "").trim().toLowerCase();
              if (responseMode === "assistant_message") {
                const maxResponseCharsRaw = Number(parsedParams.maxResponseChars ?? 8000);
                const maxResponseChars = Number.isFinite(maxResponseCharsRaw) && maxResponseCharsRaw >= 256 ? Math.min(maxResponseCharsRaw, 20000) : 8000;
                const rawText = result.ok ? String(result.stdout ?? result.summary ?? "").trim() : `Worker failed to complete request: ${String(result.summary ?? "unknown error").trim()}`;
                const assistantText = rawText.length > maxResponseChars ? `${rawText.slice(0, maxResponseChars - 3)}...` : rawText;
                if (assistantText) {
                  await sendCommand(opts.server, job.sessionId, headers, {
                    type: "assistant_message",
                    payload: { text: assistantText },
                    from: `worker:${opts.workerId}`
                  });
                }
              }
              const eventCmd = result.ok ? {
                type: "job_completed",
                payload: {
                  jobId: job.id,
                  summary: result.summary,
                  artifacts: result.stdout ? [{ kind: "log", text: result.stdout }] : undefined
                },
                from: `worker:${opts.workerId}`
              } : {
                type: "job_failed",
                payload: {
                  jobId: job.id,
                  message: result.summary,
                  detail: redactSensitiveText(result.stderr ?? "")
                },
                from: `worker:${opts.workerId}`
              };
              await sendCommand(opts.server, job.sessionId, headers, eventCmd);
            }
          } finally {
            clearInterval(busyHeartbeat);
            if (!recycleWorkerAfterJob && job.sessionId && result?.cooldownMs && result.cooldownMs > 0) {
              await sendCommand(opts.server, job.sessionId, headers, {
                type: "assistant_message",
                payload: {
                  text: `WorkerPal is cooling down for ${formatDurationMs(result.cooldownMs)} after transient infrastructure failures.`
                },
                from: `worker:${opts.workerId}`
              });
            }
            if (!recycleWorkerAfterJob && result?.cooldownMs && result.cooldownMs > 0) {
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
            if (recycleWorkerAfterJob) {
              runtimeState.shutdownRequested = true;
              await maybeHeartbeat("offline", null, true);
              if (dockerExecutor) {
                try {
                  await dockerExecutor.shutdown();
                } catch (err) {
                  console.error(`[WorkerPals] Docker shutdown cleanup failed: ${String(err)}`);
                }
              }
              process.exit(CODEX_UNAVAILABLE_WORKER_EXIT_CODE);
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
      await withTimeout(sendWorkerHeartbeat(opts, headers, "offline", runtimeState.currentJobId ?? null));
      await withTimeout(failActiveJobOnShutdown(opts, headers, runtimeState, signalName));
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
  workerLoop(opts, dockerExecutor, runtimeState).catch((err) => {
    console.error("[WorkerPals] Fatal:", err);
    process.exit(1);
  });
}
main();
