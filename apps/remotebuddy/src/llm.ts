/**
 * LLM client abstraction with supported backends:
 * - LM Studio
 * - OpenAI
 * - Ollama
 * - OpenAI Codex CLI
 */

import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPromptTemplate, loadPushPalsConfig, type PushPalsLmStudioConfig } from "shared";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMGenerateInput {
  system: string;
  messages: LLMMessage[];
  // Request JSON output when provider supports it.
  json?: boolean;
  // Optional JSON schema for strict structured responses.
  // If omitted and json=true, client requests generic JSON object mode.
  jsonSchema?: Record<string, unknown>;
  // Max tokens to generate.
  maxTokens?: number;
  temperature?: number;
}

export interface LLMGenerateOutput {
  text: string;
  // Usage stats if available.
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMClient {
  generate(input: LLMGenerateInput): Promise<LLMGenerateOutput>;
}

type LlmBackend = "lmstudio" | "ollama" | "openai" | "openai_codex";
type LlmService = "localbuddy" | "remotebuddy" | "workerpals";

export interface LLMUsageEvent {
  service: LlmService;
  sessionId?: string;
  backend: LlmBackend;
  modelId?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface LLMUsageReporter {
  reportUsage(event: LLMUsageEvent): Promise<void>;
}

export interface LLMClientOptions {
  service?: LlmService;
  sessionId?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  backend?: string;
  reasoningEffort?: string;
  codexAuthMode?: string;
  codexBin?: string;
  codexTimeoutMs?: number;
  lmStudio?: PushPalsLmStudioConfig;
  serverUrl?: string;
  authToken?: string | null;
  usageReporter?: LLMUsageReporter;
}

interface ResolvedServiceLlmConfig {
  backend: LlmBackend;
  endpoint: string;
  model: string;
  apiKey: string;
  sessionId: string;
  reasoningEffort: string;
  codexAuthMode: string;
  codexBin: string;
  codexTimeoutMs: number;
  lmStudio: PushPalsLmStudioConfig;
}

const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "local-model";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const LEGACY_CODEX_MODEL_FALLBACK = "gpt-5.4";
const DEFAULT_CODEX_REASONING_EFFORT = "xhigh";
const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
const DEFAULT_LMSTUDIO_CONTEXT_WINDOW = 4096;
const DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS = 256;
const DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN = 64;
const DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES = 3;
const CONTEXT_PACKER_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/context_packer_system_prompt.md",
).trim();
const CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT = loadPromptTemplate(
  "remotebuddy/context_packer_condensed_history_system_prompt.md",
).trim();
const KNOWN_PROVIDER_PREFIXES = new Set([
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
  "fireworks_ai",
]);

type CodexAuthMode = "auto" | "api_key" | "chatgpt";

type ProcessRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CodexVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
};

type CodexCommandProbe = {
  command: string[];
  version: CodexVersion | null;
  versionText: string;
};

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
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
  if (escaped) current += "\\";
  if (current.length > 0) out.push(current);
  return out;
}

function normalizeCodexAuthMode(value: string | null | undefined): CodexAuthMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "api_key" || normalized === "api-key" || normalized === "api") {
    return "api_key";
  }
  if (
    normalized === "chatgpt" ||
    normalized === "chatgpt_login" ||
    normalized === "chatgpt-pro" ||
    normalized === "subscription"
  ) {
    return "chatgpt";
  }
  return "auto";
}

function codexConfiguredAuthMode(configuredValue?: string | null): CodexAuthMode {
  return normalizeCodexAuthMode(
    firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_AUTH_MODE, configuredValue, "auto"),
  );
}

function codexCommandOverrideParts(configuredValue?: string | null): string[] {
  const jsonOverride = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_BIN_JSON);
  if (jsonOverride) {
    try {
      const parsed = JSON.parse(jsonOverride);
      if (Array.isArray(parsed)) {
        const args = parsed
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter((item) => item.length > 0);
        if (args.length > 0) return args;
      }
    } catch {
      // fall through to string override parsing
    }
  }
  const stringOverride =
    firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_BIN, configuredValue, "") ?? "";
  if (!stringOverride) return [];
  return splitArgs(stringOverride);
}

function codexBaseUrlOverride(): string {
  return firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_BASE_URL, "") ?? "";
}

function codexTimeoutMs(configuredTimeoutMs?: number | null): number {
  const raw =
    typeof configuredTimeoutMs === "number" &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
      ? String(Math.floor(configuredTimeoutMs))
      : "";
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CODEX_TIMEOUT_MS;
}

function codexReasoningEffort(
  configured: string | null | undefined,
  model: string,
): "low" | "medium" | "high" | "xhigh" {
  const raw = (configured ?? "").trim().toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(model.trim());
  const defaultEffort = supportsExtraHigh ? DEFAULT_CODEX_REASONING_EFFORT : "high";
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw === "xhigh" && !supportsExtraHigh ? "high" : raw;
  }
  if (raw === "extra high" || raw === "extra-high" || raw === "extrahigh" || raw === "x-high") {
    return supportsExtraHigh ? "xhigh" : "high";
  }
  return defaultEffort;
}

function isDefaultCodexLauncher(command: string[]): boolean {
  const normalized = command.map((part) => part.trim().toLowerCase()).filter(Boolean);
  return (
    normalized.length === 0 ||
    normalized.join("\u0000") === ["bun", "x", "--yes", "@openai/codex"].join("\u0000") ||
    normalized.join("\u0000") === ["bunx", "--yes", "@openai/codex"].join("\u0000")
  );
}

function parseCodexCliVersion(text: string): CodexVersion | null {
  const match = text.match(
    /(?:codex(?:-cli)?|openai\s+codex)?\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?/i,
  );
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4] ?? "",
  };
}

function compareCodexVersions(a: CodexVersion | null, b: CodexVersion | null): number {
  if (a && !b) return 1;
  if (!a && b) return -1;
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function chooseCodexCommandProbe(
  probes: CodexCommandProbe[],
  opts: { preferNewestCompatible: boolean },
): CodexCommandProbe | null {
  if (probes.length === 0) return null;
  if (!opts.preferNewestCompatible) return probes[0]!;
  return probes.reduce((best, probe) =>
    compareCodexVersions(probe.version, best.version) > 0 ? probe : best,
  );
}

function requiresNewerCodexForModel(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("requires a newer version of codex") ||
    (combined.includes("requires newer") && combined.includes("codex"))
  );
}

function isDefaultCodexModel(model: string): boolean {
  return model.trim().toLowerCase() === DEFAULT_CODEX_MODEL.toLowerCase();
}

function normalizeCodexModel(rawModel: string): string {
  const model = rawModel.trim();
  if (!model) return DEFAULT_CODEX_MODEL;
  if (!model.includes("/")) return model;
  const [provider, bare] = model.split("/", 2);
  if (provider.trim().toLowerCase() === "openai" && bare.trim()) {
    return bare.trim();
  }
  return model;
}

function normalizeOpenAiBaseFromEndpoint(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  if (trimmed.endsWith("/chat/completions")) {
    const base = trimmed.slice(0, -"/chat/completions".length);
    if (!base) return "";
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return trimmed;
}

async function runProcess(
  command: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
): Promise<ProcessRunResult> {
  const bunRuntime = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  if (typeof bunRuntime?.spawn === "function") {
    return runProcessWithBun(command, opts);
  }
  return runProcessWithNode(command, opts);
}

async function runProcessWithBun(
  command: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
): Promise<ProcessRunResult> {
  const bunRuntime = (globalThis as any).Bun;
  const timeoutMs = opts.timeoutMs ?? 0;
  let timedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  let killTimeout: NodeJS.Timeout | null = null;
  const proc = bunRuntime.spawn(command, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // best effort
      }
      killTimeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // best effort
        }
      }, 1_000);
      killTimeout.unref?.();
    }, timeoutMs);
  }

  try {
    if (typeof opts.stdin === "string") {
      proc.stdin?.write(opts.stdin);
    }
    proc.stdin?.end();
    const code = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      code,
      signal: null,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (killTimeout) clearTimeout(killTimeout);
  }
}

async function runProcessWithNode(
  command: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
): Promise<ProcessRunResult> {
  const timeoutMs = opts.timeoutMs ?? 0;
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;

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
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // best effort
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
        }, 1_000).unref();
      }, timeoutMs);
    }

    if (typeof opts.stdin === "string") {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

const cachedCodexCommandPrefix = new Map<string, string[]>();

function bunCodexCommandFromEnv(env: NodeJS.ProcessEnv): string[] {
  const bunBin = (env.PUSHPALS_BUN_BIN ?? "").trim();
  return bunBin ? [bunBin, "x", "--yes", "@openai/codex"] : [];
}

async function resolveCodexCommandPrefix(configuredCommand?: string | null): Promise<string[]> {
  const override = codexCommandOverrideParts(configuredCommand);
  const cacheKey = override.join("\u0000");
  const cached = cachedCodexCommandPrefix.get(cacheKey);
  if (cached) return cached;
  const preferred = override.length > 0 ? override : ["bun", "x", "--yes", "@openai/codex"];
  const preferNewestCompatible = isDefaultCodexLauncher(preferred);
  const candidates: string[][] = [];
  const pushCandidate = (cmd: string[]) => {
    if (cmd.length === 0) return;
    const key = cmd.join("\u0000");
    if (candidates.some((existing) => existing.join("\u0000") === key)) return;
    candidates.push(cmd);
  };
  pushCandidate(preferred);
  pushCandidate(bunCodexCommandFromEnv(process.env));
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
  const attemptErrors: string[] = [];
  const successfulProbes: CodexCommandProbe[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const rendered = `${candidate.join(" ")} --version`;
    try {
      const probe = await runProcess([...candidate, "--version"], {
        cwd,
        env,
        timeoutMs: 15_000,
      });
      if (probe.code === 0) {
        const versionText = (probe.stdout || probe.stderr || "").trim().split(/\r?\n/, 1)[0] ?? "";
        successfulProbes.push({
          command: candidate,
          version: parseCodexCliVersion(versionText),
          versionText,
        });
        if (!preferNewestCompatible) break;
        continue;
      }
      const detail = (probe.stderr || probe.stdout || "").trim();
      attemptErrors.push(
        `${rendered} -> exit ${probe.code ?? "unknown"}${detail ? ` (${detail.split(/\r?\n/, 1)[0]})` : ""}`,
      );
    } catch (err) {
      attemptErrors.push(`${rendered} -> ${String(err)}`);
    }
  }
  const selected = chooseCodexCommandProbe(successfulProbes, { preferNewestCompatible });
  if (selected) {
    cachedCodexCommandPrefix.set(cacheKey, selected.command);
    console.log(
      `[LLM] Resolved Codex CLI command: ${selected.command.join(" ")}${
        selected.versionText ? ` (${selected.versionText})` : ""
      }.`,
    );
    return selected.command;
  }
  const details = attemptErrors.length > 0 ? ` Tried: ${attemptErrors.join("; ")}` : "";
  throw new Error(
    "OpenAI Codex CLI is unavailable. Install/use Codex CLI (`bun x --yes @openai/codex` or `codex`) and retry." +
      details,
  );
}
function normalizeBackend(value: string | null | undefined): LlmBackend | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  if (normalized === "openai" || normalized === "openai_compatible") return "openai";
  if (normalized === "openai_codex" || normalized === "codex" || normalized === "codex_cli") {
    return "openai_codex";
  }
  return null;
}

function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

function isOpenAIEndpoint(endpoint: string): boolean {
  const host = endpointHost(endpoint);
  if (!host) return false;
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}

function configuredBackend(
  endpoint: string,
  explicitBackend?: string | null | undefined,
): LlmBackend {
  const explicit = normalizeBackend(explicitBackend);
  if (explicit === "openai_codex") return explicit;
  if (explicit === "ollama") return explicit;
  if (isOpenAIEndpoint(endpoint)) return "openai";
  if (explicit) return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveServiceLlmConfig(opts: LLMClientOptions = {}): ResolvedServiceLlmConfig {
  const service = opts.service ?? "remotebuddy";
  const config = loadPushPalsConfig();
  const serviceLlmConfig =
    service === "localbuddy"
      ? config.localbuddy.llm
      : service === "workerpals"
        ? config.workerpals.llm
        : config.remotebuddy.llm;

  const explicitBackend = normalizeBackend(firstNonEmpty(opts.backend, serviceLlmConfig.backend));
  const fallbackEndpoint =
    explicitBackend === "ollama"
      ? DEFAULT_OLLAMA_ENDPOINT
      : explicitBackend === "openai" || explicitBackend === "openai_codex"
        ? DEFAULT_OPENAI_ENDPOINT
        : DEFAULT_LMSTUDIO_ENDPOINT;
  const endpoint = firstNonEmpty(opts.endpoint, serviceLlmConfig.endpoint, fallbackEndpoint);
  let backend = configuredBackend(endpoint ?? "", explicitBackend);

  const configuredModel = firstNonEmpty(opts.model, serviceLlmConfig.model, "");
  let model =
    firstNonEmpty(
      configuredModel,
      backend === "openai_codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    ) ?? DEFAULT_MODEL;
  if (backend === "openai_codex" && model === DEFAULT_MODEL) {
    model = DEFAULT_CODEX_MODEL;
  }
  const requestedCodexAuthMode =
    firstNonEmpty(opts.codexAuthMode, serviceLlmConfig.codexAuthMode, "") ?? "";
  const openAiApiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const apiKey =
    firstNonEmpty(
      opts.apiKey,
      serviceLlmConfig.apiKey,
      backend === "lmstudio"
        ? "lmstudio"
        : backend === "openai" || backend === "openai_codex"
          ? openAiApiKey
          : "",
    ) ?? "";
  if (
    service !== "workerpals" &&
    shouldUseCodexCliFallback(backend, model, apiKey, requestedCodexAuthMode)
  ) {
    backend = "openai_codex";
  }
  const normalizedEndpoint =
    backend === "ollama"
      ? normalizeOllamaEndpoint(endpoint ?? DEFAULT_OLLAMA_ENDPOINT)
      : normalizeLmStudioEndpoint(
          endpoint ?? (backend === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT),
        );
  const sessionId =
    firstNonEmpty(opts.sessionId, serviceLlmConfig.sessionId, config.sessionId, "default") ??
    "default";

  return {
    backend,
    endpoint: normalizedEndpoint,
    model,
    apiKey,
    sessionId,
    reasoningEffort:
      firstNonEmpty(
        opts.reasoningEffort,
        serviceLlmConfig.reasoningEffort,
        backend === "openai_codex" ? DEFAULT_CODEX_REASONING_EFFORT : "",
      ) ?? "",
    codexAuthMode: requestedCodexAuthMode,
    codexBin: firstNonEmpty(opts.codexBin, serviceLlmConfig.codexBin, "") ?? "",
    codexTimeoutMs: opts.codexTimeoutMs ?? serviceLlmConfig.codexTimeoutMs,
    lmStudio: opts.lmStudio ?? config.llm.lmstudio,
  };
}

function normalizeLmStudioEndpoint(endpoint: string): string {
  const source = (endpoint.trim() || DEFAULT_LMSTUDIO_ENDPOINT).replace(/\/+$/, "");
  if (source.includes("/chat/completions")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function normalizeOllamaEndpoint(endpoint: string): string {
  const source = (endpoint.trim() || DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, "");
  if (source.endsWith("/api/chat")) return source;
  return `${source}/api/chat`;
}

function lmStudioHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

// Conservative estimate to stay safely under provider context limits.
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 3);
}

function truncateKeepingStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 12)}\n...[truncated]`;
}

function truncateKeepingEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 12) return text.slice(text.length - maxChars);
  return `...[truncated]\n${text.slice(text.length - (maxChars - 12))}`;
}

function sumEstimatedTokens(messages: Array<{ role: string; content: string }>): number {
  return messages.reduce((acc, msg) => acc + estimateTokensFromText(msg.content), 0);
}

function tokenUsageFromEstimate(
  messages: Array<{ role: string; content: string }>,
  responseText: string,
): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: Math.max(0, sumEstimatedTokens(messages)),
    completionTokens: Math.max(0, estimateTokensFromText(responseText)),
  };
}

function normalizeTokenUsage(
  usage: { promptTokens: number; completionTokens: number } | undefined,
  fallback: { promptTokens: number; completionTokens: number },
): { promptTokens: number; completionTokens: number; estimated: boolean } {
  if (
    usage &&
    Number.isFinite(usage.promptTokens) &&
    usage.promptTokens >= 0 &&
    Number.isFinite(usage.completionTokens) &&
    usage.completionTokens >= 0
  ) {
    return {
      promptTokens: Math.round(usage.promptTokens),
      completionTokens: Math.round(usage.completionTokens),
      estimated: false,
    };
  }
  return {
    promptTokens: Math.round(fallback.promptTokens),
    completionTokens: Math.round(fallback.completionTokens),
    estimated: true,
  };
}

function createHttpUsageReporter(opts: {
  serverUrl?: string;
  authToken?: string | null;
}): LLMUsageReporter | null {
  const serverUrl = (opts.serverUrl ?? "").trim().replace(/\/+$/, "");
  if (!serverUrl) return null;
  return {
    async reportUsage(event: LLMUsageEvent): Promise<void> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const authToken = (opts.authToken ?? "").trim();
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const response = await fetch(`${serverUrl}/telemetry/llm-usage`, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `usage telemetry rejected (${response.status})${detail ? `: ${detail.trim()}` : ""}`,
        );
      }
    },
  };
}

function providerlessModelName(raw: string): string {
  const normalized = raw.trim();
  if (!normalized.includes("/")) return normalized;
  const [provider, rest] = normalized.split("/", 2);
  if (KNOWN_PROVIDER_PREFIXES.has(provider.trim().toLowerCase())) {
    return (rest ?? "").trim();
  }
  return normalized;
}

function isLikelyCodexModel(raw: string): boolean {
  const normalized = providerlessModelName(raw).trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("codex");
}

function shouldUseCodexCliFallback(
  backend: LlmBackend,
  model: string,
  apiKey: string,
  configuredAuthMode?: string,
): boolean {
  if (backend !== "openai") return false;
  if (!isLikelyCodexModel(model)) return false;
  const mode = codexConfiguredAuthMode(configuredAuthMode);
  if (mode === "api_key") return false;
  if (mode === "chatgpt") return true;
  return !apiKey.trim();
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeSessionTag(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed) return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
}

function stableConversationTag(service: LlmService, sessionId?: string): string {
  const source = firstNonEmpty(sessionId, "default") ?? "default";
  return `pushpals-${service}-${normalizeSessionTag(source)}`;
}

function pickConfiguredOrAvailableModel(
  configuredModel: string,
  availableModels: string[],
): {
  model: string;
  source:
    | "configured"
    | "available_fallback"
    | "available_default"
    | "configured_unverified"
    | "default_local_model";
} {
  const configured = configuredModel.trim();
  if (availableModels.length > 0) {
    if (configured) {
      const configuredLower = configured.toLowerCase();
      const configuredBare = providerlessModelName(configured).toLowerCase();
      const matched = availableModels.find((candidate) => {
        const lower = candidate.toLowerCase();
        return (
          lower === configuredLower ||
          providerlessModelName(candidate).toLowerCase() === configuredBare
        );
      });
      if (matched) return { model: matched, source: "configured" };
      return { model: availableModels[0], source: "available_fallback" };
    }
    return { model: availableModels[0], source: "available_default" };
  }

  if (configured) return { model: configured, source: "configured_unverified" };
  return { model: DEFAULT_MODEL, source: "default_local_model" };
}

function chunkByCharBudget(text: string, charBudget: number): string[] {
  if (!text) return [];
  const safeBudget = Math.max(256, charBudget);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + safeBudget);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function serializeMessagesForBatch(messages: Array<{ role: string; content: string }>): string {
  return messages
    .map(
      (message, index) =>
        `[#${index + 1}] role=${message.role}\n<<<BEGIN_CONTENT>>>\n${message.content}\n<<<END_CONTENT>>>`,
    )
    .join("\n\n====\n\n");
}

function trimLmStudioMessagesToBudget(
  system: string,
  inputMessages: LLMMessage[],
  promptTokenBudget: number,
  systemTokenBudget: number,
): {
  messages: Array<{ role: string; content: string }>;
  promptTokensEstimate: number;
  trimmed: boolean;
  latestUserOverflow: boolean;
} {
  let trimmed = false;
  let latestUserOverflow = false;
  let remainingPromptTokens = promptTokenBudget;
  let systemContent = system;
  if (estimateTokensFromText(systemContent) > systemTokenBudget) {
    systemContent = truncateKeepingStart(systemContent, systemTokenBudget * 3);
    trimmed = true;
  }
  remainingPromptTokens = Math.max(64, promptTokenBudget - estimateTokensFromText(systemContent));

  const selectedMessages: Array<{ role: string; content: string }> = [];
  const lastUserIndex = (() => {
    for (let i = inputMessages.length - 1; i >= 0; i--) {
      if (inputMessages[i]?.role === "user") return i;
    }
    return -1;
  })();

  for (let i = inputMessages.length - 1; i >= 0; i--) {
    const source = inputMessages[i];
    let content = source.content ?? "";
    const estimated = estimateTokensFromText(content);
    if (estimated <= remainingPromptTokens) {
      selectedMessages.push({ role: source.role, content });
      remainingPromptTokens -= estimated;
      continue;
    }

    // Never silently trim the most recent user instruction.
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

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemContent },
    ...selectedMessages.reverse(),
  ];
  const promptTokensEstimate = sumEstimatedTokens(messages);
  return { messages, promptTokensEstimate, trimmed, latestUserOverflow };
}

export class LmStudioClient implements LLMClient {
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private service: LlmService;
  private sessionTag: string;
  private providerKind: "lmstudio" | "openai";
  private providerLabel: string;
  private usageReporter: LLMUsageReporter | null;
  private contextWindow: number;
  private minOutputTokens: number;
  private tokenSafetyMargin: number;
  private batchTailMessages: number;
  private batchChunkTokens: number;
  private batchMemoryChars: number;
  private resolvedModel: string | null = null;
  private resolveModelPromise: Promise<string> | null = null;
  private lmStudioSupportsExtendedSessionFields: boolean | null = null;
  private lmStudioSupportsResponseFormat: boolean | null = null;

  constructor(opts?: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    backend?: "lmstudio" | "openai";
    service?: LlmService;
    sessionId?: string;
    lmStudio?: PushPalsLmStudioConfig;
    usageReporter?: LLMUsageReporter | null;
  }) {
    this.providerKind = opts?.backend ?? "lmstudio";
    this.providerLabel = this.providerKind === "openai" ? "OpenAI" : "LM Studio";
    const defaultEndpoint =
      this.providerKind === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
    const rawEndpoint = opts?.endpoint ?? defaultEndpoint;
    this.endpoint = normalizeLmStudioEndpoint(rawEndpoint);
    this.apiKey = opts?.apiKey ?? (this.providerKind === "lmstudio" ? "lmstudio" : "");
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
    const lmStudio = opts?.lmStudio;
    this.contextWindow = Math.max(512, lmStudio?.contextWindow ?? DEFAULT_LMSTUDIO_CONTEXT_WINDOW);
    this.minOutputTokens = Math.max(
      64,
      lmStudio?.minOutputTokens ?? DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS,
    );
    this.tokenSafetyMargin = Math.max(
      16,
      lmStudio?.tokenSafetyMargin ?? DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN,
    );
    this.batchTailMessages = Math.max(
      1,
      lmStudio?.batchTailMessages ?? DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES,
    );
    this.batchChunkTokens = Math.max(0, lmStudio?.batchChunkTokens ?? 0);
    this.batchMemoryChars = Math.max(0, lmStudio?.batchMemoryChars ?? 0);
  }

  private async maybeReportUsage(
    modelId: string,
    usage: { promptTokens: number; completionTokens: number; estimated: boolean },
  ): Promise<void> {
    if (!this.usageReporter) return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: this.providerKind,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated,
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }

  private modelProbeUrls(): string[] {
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

  private async discoverAvailableModels(): Promise<{ models: string[]; detail: string }> {
    const probes = this.modelProbeUrls();
    const headers: Record<string, string> = { Accept: "application/json" };
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

        const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const models = Array.isArray(payload?.data)
          ? payload.data
              .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
              .filter((id) => id.length > 0)
          : [];

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

  private async resolveModelForRequest(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    if (this.resolveModelPromise) return this.resolveModelPromise;

    this.resolveModelPromise = (async () => {
      const configuredModel = this.model.trim();
      const discovered = await this.discoverAvailableModels();
      const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);

      if (selected.source === "available_fallback") {
        console.warn(
          `[LLM] Configured model "${configuredModel || "(empty)"}" not present in ${this.providerLabel} model list; using discovered fallback "${selected.model}".`,
        );
      } else if (selected.source === "available_default") {
        console.warn(
          `[LLM] No model configured; using discovered ${this.providerLabel} model "${selected.model}".`,
        );
      } else if (selected.source === "default_local_model") {
        console.warn(
          `[LLM] No configured/discovered ${this.providerLabel} model available; falling back to default "${DEFAULT_MODEL}".`,
        );
      } else if (selected.source === "configured_unverified") {
        console.warn(
          `[LLM] Could not verify configured model "${configuredModel}" via model list (${discovered.detail}); continuing with configured model.`,
        );
      }

      console.log(
        `[LLM] ${this.providerLabel} resolved model "${selected.model}" (${selected.source}).`,
      );

      return selected.model;
    })();

    try {
      this.resolvedModel = await this.resolveModelPromise;
      return this.resolvedModel;
    } finally {
      this.resolveModelPromise = null;
    }
  }

  async preflightConfiguredModel(): Promise<void> {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(
        `${this.providerLabel} model preflight failed for ${this.endpoint}: ${discovered.detail}`,
      );
    }

    const configuredModel = this.model.trim();
    if (!configuredModel) return;

    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(
        `Configured ${this.providerLabel} model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`,
      );
    }
  }

  private async runLmStudioCompletion(
    messages: Array<{ role: string; content: string }>,
    opts: {
      json?: boolean;
      jsonSchema?: Record<string, unknown>;
      maxTokens: number;
      temperature: number;
    },
  ): Promise<LLMGenerateOutput> {
    const model = await this.resolveModelForRequest();
    const coreBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    const sessionAwareBodyBases: Array<Record<string, unknown>> = this.sessionTag
      ? [
          ...(this.lmStudioSupportsExtendedSessionFields !== false
            ? [
                {
                  ...coreBody,
                  user: this.sessionTag,
                  session_id: this.sessionTag,
                  conversation_id: this.sessionTag,
                },
              ]
            : []),
          {
            ...coreBody,
            user: this.sessionTag,
          },
          {
            ...coreBody,
          },
        ]
      : [coreBody];

    const bodyVariants: Array<Record<string, unknown>> = [];
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
            json_schema: opts.jsonSchema,
          },
        });
      } else {
        bodyVariants.push({
          ...baseBody,
          response_format: { type: "json_object" },
        });
      }
      bodyVariants.push({
        ...baseBody,
        response_format: { type: "text" },
      });
    }

    let lastStatus = 0;
    let lastError = "unknown error";
    let loggedSessionFallback = false;
    let loggedResponseFormatFallback = false;
    for (let i = 0; i < bodyVariants.length; i++) {
      const body = bodyVariants[i];
      const headers: Record<string, string> = {
        ...lmStudioHeaders(this.apiKey),
      };
      if (this.sessionTag) {
        headers["X-PushPals-Session-Id"] = this.sessionTag;
        headers["X-Session-Id"] = this.sessionTag;
        headers["X-Conversation-Id"] = this.sessionTag;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        lastStatus = res.status;
        lastError = await res.text();
        const hasFallback = i < bodyVariants.length - 1;
        if (hasFallback && res.status === 400) {
          const lowered = lastError.toLowerCase();
          const sessionFieldRejected =
            lowered.includes("session_id") ||
            lowered.includes("conversation_id") ||
            lowered.includes("unknown field") ||
            lowered.includes("unknown property") ||
            lowered.includes("additional properties");
          const responseFormatRejected = lowered.includes("response_format");
          if (sessionFieldRejected && !loggedSessionFallback) {
            this.lmStudioSupportsExtendedSessionFields = false;
            loggedSessionFallback = true;
            console.warn(
              `[LLM] ${this.providerLabel} rejected session hint fields, retrying compatibility payload (${lastStatus}).`,
            );
          } else if (responseFormatRejected && !loggedResponseFormatFallback) {
            this.lmStudioSupportsResponseFormat = false;
            loggedResponseFormatFallback = true;
            console.warn(
              `[LLM] ${this.providerLabel} rejected response_format payload, retrying with fallback (${lastStatus}).`,
            );
          }
          continue;
        }
        throw new Error(`${this.providerLabel} API error ${res.status}: ${lastError}`);
      }

      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      if ("session_id" in body || "conversation_id" in body) {
        this.lmStudioSupportsExtendedSessionFields = true;
      }
      if ("response_format" in body) {
        this.lmStudioSupportsResponseFormat = true;
      }
      const usage = normalizeTokenUsage(
        data.usage
          ? {
              promptTokens: Number(data.usage.prompt_tokens ?? 0),
              completionTokens: Number(data.usage.completion_tokens ?? 0),
            }
          : undefined,
        tokenUsageFromEstimate(messages, text),
      );
      await this.maybeReportUsage(model, usage);

      return {
        text,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
      };
    }

    throw new Error(`${this.providerLabel} API error ${lastStatus}: ${lastError}`);
  }

  private async packContextInBatches(
    fullMessages: Array<{ role: string; content: string }>,
    promptTokenBudget: number,
  ): Promise<{ messages: Array<{ role: string; content: string }>; chunkCount: number }> {
    const tailCount = this.batchTailMessages;
    const tailMessages = fullMessages.slice(-tailCount);
    // Reserve budget for tail messages and packed-context wrapper system messages.
    const reservedTailTokens = sumEstimatedTokens(tailMessages) + 220;
    const adaptiveMemoryTokenBudget = Math.max(
      256,
      Math.min(Math.floor(promptTokenBudget * 0.6), promptTokenBudget - reservedTailTokens),
    );

    const chunkTokenBudget =
      this.batchChunkTokens > 0
        ? this.batchChunkTokens
        : Math.max(256, Math.floor(promptTokenBudget * 0.55));
    const chunkCharBudget = chunkTokenBudget * 3;
    const memoryCharBudget =
      this.batchMemoryChars > 0
        ? this.batchMemoryChars
        : Math.max(900, adaptiveMemoryTokenBudget * 3);
    const packMaxTokens = Math.max(128, Math.min(1024, Math.floor(this.contextWindow * 0.25)));
    const serialized = serializeMessagesForBatch(fullMessages);
    const chunks = chunkByCharBudget(serialized, chunkCharBudget);
    if (chunks.length <= 1) {
      return { messages: fullMessages, chunkCount: chunks.length };
    }

    let memory = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const packPrompt = loadPromptTemplate("remotebuddy/context_packer_user_prompt.md", {
        batch_index: String(i + 1),
        batch_count: String(chunks.length),
        batch_chunk: chunk,
        current_memory: memory || "(empty)",
        memory_char_budget: String(memoryCharBudget),
      });

      const packed = await this.runLmStudioCompletion(
        [
          {
            role: "system",
            content: CONTEXT_PACKER_SYSTEM_PROMPT,
          },
          { role: "user", content: packPrompt },
        ],
        { json: false, maxTokens: packMaxTokens, temperature: 0.0 },
      );
      memory = packed.text.trim() || memory;
    }

    const packedMessages: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content: CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: `PACKED_CONTEXT\n${memory}`,
      },
      ...tailMessages,
    ];
    return { messages: packedMessages, chunkCount: chunks.length };
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const contextWindow = this.contextWindow;
    const minOutputTokens = this.minOutputTokens;
    const desiredMaxTokens = input.maxTokens ?? 2048;
    const clampedMinOutput = Math.max(64, Math.min(minOutputTokens, Math.floor(contextWindow / 2)));
    const promptTokenBudget = Math.max(
      384,
      contextWindow - clampedMinOutput - this.tokenSafetyMargin,
    );
    const systemTokenBudget = Math.max(
      128,
      Math.min(Math.floor(promptTokenBudget * 0.45), promptTokenBudget - 128),
    );

    const fullMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: input.system },
      ...input.messages.map((message) => ({ role: message.role, content: message.content ?? "" })),
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
            role: message.role as LLMMessage["role"],
            content: message.content,
          }));
          const packedTrimmed = trimLmStudioMessagesToBudget(
            packedSystem,
            packedInput,
            promptTokenBudget,
            systemTokenBudget,
          );
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
      throw new Error(
        `Latest user request exceeds ${this.providerLabel} context window and cannot be safely truncated. Increase model context window or split the request into smaller messages.`,
      );
    }

    const safeMaxTokens = Math.max(
      64,
      Math.min(desiredMaxTokens, contextWindow - promptTokensEstimate - this.tokenSafetyMargin),
    );

    if (packedChunkCount > 1) {
      console.warn(
        `[LLM] Packed oversized prompt context across ${packedChunkCount} batches (window ~${contextWindow}, est prompt ${promptTokensEstimate}).`,
      );
    } else if (trimmed) {
      console.warn(
        `[LLM] Trimmed ${this.providerLabel} prompt context to fit window (~${contextWindow} tokens, est prompt ${promptTokensEstimate}).`,
      );
    }

    return this.runLmStudioCompletion(messages, {
      json: input.json,
      jsonSchema: input.jsonSchema,
      maxTokens: safeMaxTokens,
      temperature: input.temperature ?? 0.3,
    });
  }
}

function renderCodexPrompt(input: LLMGenerateInput): string {
  const jsonRequirements = input.json
    ? loadPromptTemplate("remotebuddy/codex_adapter_json_requirements.md").trim()
    : "";
  const jsonSchemaBlock = input.jsonSchema
    ? `${loadPromptTemplate("remotebuddy/codex_adapter_json_schema_intro.md").trim()}\n${JSON.stringify(input.jsonSchema, null, 2)}`
    : "";
  const maxTokensLine =
    typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? loadPromptTemplate("remotebuddy/codex_adapter_max_tokens_line.md", {
          max_tokens: String(Math.max(64, Math.floor(input.maxTokens))),
        }).trim()
      : "";
  const conversationTranscript = input.messages
    .map((message) => `[${message.role}]\n${message.content ?? ""}\n`)
    .join("\n");

  return loadPromptTemplate("remotebuddy/codex_adapter_prompt_template.md", {
    json_requirements: jsonRequirements,
    json_schema_block: jsonSchemaBlock,
    max_tokens_line: maxTokensLine,
    system_instruction: input.system,
    conversation_transcript: conversationTranscript,
  });
}

export class OpenAiCodexCliClient implements LLMClient {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly codexAuthMode: string;
  private readonly codexBin: string;
  private readonly codexTimeoutMs: number;
  private readonly service: LlmService;
  private readonly sessionTag: string;
  private readonly reasoningEffort: string;
  private readonly usageReporter: LLMUsageReporter | null;

  constructor(opts?: {
    model?: string;
    apiKey?: string;
    endpoint?: string;
    codexAuthMode?: string;
    codexBin?: string;
    codexTimeoutMs?: number;
    reasoningEffort?: string;
    service?: LlmService;
    sessionId?: string;
    usageReporter?: LLMUsageReporter | null;
  }) {
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

  private async maybeReportUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    estimated: boolean;
    modelId?: string;
  }): Promise<void> {
    if (!this.usageReporter) return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "openai_codex",
        modelId: usage.modelId ?? this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated,
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }

  private effectiveAuthMode(): CodexAuthMode {
    const configured = codexConfiguredAuthMode(this.codexAuthMode);
    if (configured !== "auto") return configured;
    const envKey = (process.env.OPENAI_API_KEY ?? "").trim();
    return this.apiKey || envKey ? "api_key" : "chatgpt";
  }

  private async ensureChatGptLoginReady(
    commandPrefix: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const status = await runProcess([...commandPrefix, "login", "status"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 25_000,
    });
    if (status.code === 0) return;
    const detail = (status.stderr || status.stdout || "").trim();
    throw new Error(
      `Codex CLI is not logged in for ChatGPT auth mode. Run \`bunx --yes @openai/codex login\` (or \`codex login\`) and retry.${detail ? ` Details: ${detail}` : ""}`,
    );
  }

  async preflight(): Promise<void> {
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env: NodeJS.ProcessEnv = { ...process.env };
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
      throw new Error(
        "openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.",
      );
    }
  }

  private async runCodexExec(
    prompt: string,
  ): Promise<{ text: string; stderr: string; model: string }> {
    return this.runCodexExecAttempt(prompt, {
      model: this.model,
      modelCompatibilityRecoveryAttempt: 0,
    });
  }

  private async runCodexExecAttempt(
    prompt: string,
    opts: { model: string; modelCompatibilityRecoveryAttempt: number },
  ): Promise<{ text: string; stderr: string; model: string }> {
    const model = normalizeCodexModel(opts.model);
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env: NodeJS.ProcessEnv = { ...process.env };
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
        throw new Error(
          "openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.",
        );
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

    const tmp = mkdtempSync(join(tmpdir(), "pushpals-codex-"));
    const lastMessagePath = join(tmp, "codex-last-message.txt");
    try {
      const command: string[] = [
        ...commandPrefix,
        "-c",
        `model_reasoning_effort="${codexReasoningEffort(this.reasoningEffort, model)}"`,
        "-a",
        "never",
        "-s",
        "read-only",
        "exec",
        "--color",
        "never",
        "--output-last-message",
        lastMessagePath,
      ];
      if (model) {
        command.push("-m", model);
      }
      command.push("-");

      const result = await runProcess(command, {
        cwd: process.cwd(),
        env,
        stdin: prompt,
        timeoutMs: codexTimeoutMs(this.codexTimeoutMs),
      });
      if (result.timedOut) {
        throw new Error(
          `Codex CLI request timed out after ${codexTimeoutMs(this.codexTimeoutMs)}ms.`,
        );
      }
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      const lastMessage = existsSync(lastMessagePath)
        ? readFileSync(lastMessagePath, "utf8").trim()
        : "";
      if (result.code !== 0) {
        const detail = stderr || stdout || "codex exec exited with non-zero status";
        if (
          opts.modelCompatibilityRecoveryAttempt < 1 &&
          isDefaultCodexModel(model) &&
          LEGACY_CODEX_MODEL_FALLBACK.trim().toLowerCase() !== DEFAULT_CODEX_MODEL.toLowerCase() &&
          requiresNewerCodexForModel(stdout, stderr)
        ) {
          console.warn(
            `[LLM] Codex CLI rejected default model ${DEFAULT_CODEX_MODEL}; retrying once with ${LEGACY_CODEX_MODEL_FALLBACK}. Upgrade Codex CLI to use ${DEFAULT_CODEX_MODEL}.`,
          );
          return this.runCodexExecAttempt(prompt, {
            model: LEGACY_CODEX_MODEL_FALLBACK,
            modelCompatibilityRecoveryAttempt: opts.modelCompatibilityRecoveryAttempt + 1,
          });
        }
        throw new Error(`Codex CLI request failed (exit ${result.code ?? "unknown"}): ${detail}`);
      }
      const text = lastMessage || stdout;
      if (!text) {
        throw new Error("Codex CLI completed without producing a response.");
      }
      return { text, stderr, model };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
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
      completionTokens: estimateTokensFromText(result.text),
    });
    await this.maybeReportUsage({ ...usage, modelId: result.model });
    return {
      text: result.text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
    };
  }
}

export class OllamaClient implements LLMClient {
  private endpoint: string;
  private model: string;
  private service: LlmService;
  private sessionTag: string;
  private usageReporter: LLMUsageReporter | null;

  constructor(opts?: {
    endpoint?: string;
    model?: string;
    service?: LlmService;
    sessionId?: string;
    usageReporter?: LLMUsageReporter | null;
  }) {
    const rawEndpoint = opts?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.endpoint = normalizeOllamaEndpoint(rawEndpoint);
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
  }

  private async maybeReportUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    estimated: boolean;
  }): Promise<void> {
    if (!this.usageReporter) return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "ollama",
        modelId: this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated,
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }

  private async discoverAvailableModels(): Promise<{ models: string[]; detail: string }> {
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

        const payload = (await res.json()) as {
          models?: Array<{ name?: unknown }>;
          message?: { content?: unknown };
        };
        const models = Array.isArray(payload.models)
          ? payload.models
              .map((item) => (typeof item?.name === "string" ? item.name.trim() : ""))
              .filter((name) => name.length > 0)
          : [];
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

  async preflightConfiguredModel(): Promise<void> {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(`Ollama model preflight failed for ${this.endpoint}: ${discovered.detail}`);
    }

    const configuredModel = this.model.trim();
    if (!configuredModel) return;

    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(
        `Configured Ollama model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`,
      );
    }
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: false,
      options: {
        temperature: input.temperature ?? 0.3,
      },
    };

    if (typeof input.maxTokens === "number") {
      (body.options as Record<string, unknown>).num_predict = input.maxTokens;
    }

    if (input.json) {
      body.format = "json";
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const text = data.message?.content ?? "";
    const usage = normalizeTokenUsage(
      undefined,
      tokenUsageFromEstimate(body.messages as Array<{ role: string; content: string }>, text),
    );
    await this.maybeReportUsage(usage);
    return {
      text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
    };
  }
}

export function createLLMClient(opts: LLMClientOptions = {}): LLMClient {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";
  const usageReporter = opts.usageReporter ?? createHttpUsageReporter(opts);

  if (resolved.backend === "openai_codex") {
    console.log(
      `[LLM] Using OpenAI Codex CLI backend (model: ${resolved.model}, auth_mode: ${codexConfiguredAuthMode(resolved.codexAuthMode)}).`,
    );
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
      usageReporter,
    });
  }

  if (resolved.backend === "ollama") {
    console.log(
      `[LLM] Using Ollama backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`,
    );
    return new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
      service,
      sessionId: resolved.sessionId,
      usageReporter,
    });
  }

  if (resolved.backend === "openai") {
    console.log(
      `[LLM] Using OpenAI backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`,
    );
    return new LmStudioClient({
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      model: resolved.model,
      backend: "openai",
      service,
      sessionId: resolved.sessionId,
      lmStudio: resolved.lmStudio,
      usageReporter,
    });
  }

  console.log(
    `[LLM] Using LM Studio backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`,
  );
  return new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    backend: "lmstudio",
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
    usageReporter,
  });
}

export async function preflightServiceLlm(opts: LLMClientOptions = {}): Promise<void> {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";

  if (resolved.backend === "openai_codex") {
    const client = new OpenAiCodexCliClient({
      model: resolved.model,
      apiKey: resolved.apiKey,
      endpoint: resolved.endpoint,
      codexAuthMode: resolved.codexAuthMode,
      codexBin: resolved.codexBin,
      codexTimeoutMs: resolved.codexTimeoutMs,
      reasoningEffort: resolved.reasoningEffort,
      service,
      sessionId: resolved.sessionId,
      usageReporter: null,
    });
    await client.preflight();
    return;
  }

  if (resolved.backend === "ollama") {
    const client = new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
      service,
      sessionId: resolved.sessionId,
      usageReporter: null,
    });
    await client.preflightConfiguredModel();
    return;
  }

  const client = new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    backend: resolved.backend === "openai" ? "openai" : "lmstudio",
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
    usageReporter: null,
  });
  await client.preflightConfiguredModel();
}

export const __TEST_ONLY__ = {
  bunCodexCommandFromEnv,
  chooseCodexCommandProbe,
  compareCodexVersions,
  parseCodexCliVersion,
  requiresNewerCodexForModel,
};
