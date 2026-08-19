export type ToolKind = "known" | "discovered" | "shell";

export type ToolFailureClass =
  | "missing_binary"
  | "missing_runtime"
  | "auth"
  | "network"
  | "permission"
  | "policy_denied"
  | "timeout"
  | "worker_runtime_failure"
  | "nonzero_exit"
  | "repo_state"
  | "sandbox_mount"
  | "unknown";

export type ToolEffect = "read" | "write" | "network" | "git" | "process";

export interface ToolFailureClassification {
  failureClass: ToolFailureClass;
  retryable: boolean;
  remediation: string;
}

export interface ToolFailureInput {
  tool?: string | null;
  argv?: string[] | null;
  commandLine?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  summary?: string | null;
  detail?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface ToolRunRecord {
  id: string;
  jobId?: string | null;
  workerId?: string | null;
  sessionId?: string | null;
  phase?: string | null;
  tool: string;
  kind: ToolKind;
  capability?: string | null;
  envProfile?: string | null;
  cwd?: string | null;
  argv: string[];
  commandLine?: string | null;
  allowedEffects: ToolEffect[];
  ok: boolean;
  exitCode?: number | null;
  failureClass?: ToolFailureClass | null;
  retryable: boolean;
  remediation?: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ToolAdapter {
  tool: string;
  kind: ToolKind;
  executableHints?: string[];
  defaultEffects?: ToolEffect[];
}

export interface ToolRegistry {
  adapters: ToolAdapter[];
  fallbackKind: ToolKind;
}

const KNOWN_TOOL_NAMES = new Set([
  "bun",
  "codex",
  "docker",
  "gh",
  "git",
  "node",
  "npm",
  "python",
  "shell",
]);

export const DEFAULT_TOOL_REGISTRY: ToolRegistry = {
  fallbackKind: "discovered",
  adapters: [
    {
      tool: "git",
      kind: "known",
      executableHints: ["git"],
      defaultEffects: ["read", "write", "git"],
    },
    {
      tool: "codex",
      kind: "known",
      executableHints: ["codex", "bunx @openai/codex"],
      defaultEffects: ["read", "write", "network", "process"],
    },
    {
      tool: "bun",
      kind: "known",
      executableHints: ["bun"],
      defaultEffects: ["read", "write", "process"],
    },
    {
      tool: "docker",
      kind: "known",
      executableHints: ["docker"],
      defaultEffects: ["read", "write", "network", "process"],
    },
    {
      tool: "gh",
      kind: "known",
      executableHints: ["gh"],
      defaultEffects: ["read", "write", "network"],
    },
    {
      tool: "node",
      kind: "known",
      executableHints: ["node"],
      defaultEffects: ["read", "write", "process"],
    },
    {
      tool: "shell",
      kind: "shell",
      executableHints: ["sh", "bash", "cmd", "powershell"],
      defaultEffects: ["read", "write", "process"],
    },
  ],
};

export const TOOL_RUN_TAIL_CHARS = 8_000;

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function basename(command: string): string {
  const trimmed = command.trim();
  const withoutQuotes = trimmed.replace(/^["']|["']$/g, "");
  const parts = withoutQuotes.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuotes;
}

export function truncateToolText(value: unknown, maxChars = TOOL_RUN_TAIL_CHARS): string {
  const text = cleanText(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `...[truncated]...\n${text.slice(-maxChars)}`;
}

export function redactToolText(value: unknown): string {
  const text = cleanText(value);
  if (!text) return "";
  return text
    .replace(
      /\b(OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|PUSHPALS_AUTH_TOKEN)=([^\s]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(/\b(ghp|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]");
}

export function normalizeToolName(tool: unknown): string {
  const raw = cleanText(tool).toLowerCase();
  if (!raw) return "shell";
  if (raw.includes("@openai/codex") || raw.includes("openai_codex")) return "codex";
  const name = basename(raw).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (name === "bunx") return "bun";
  if (name === "python3") return "python";
  if (
    name === "pwsh" ||
    name === "powershell" ||
    name === "bash" ||
    name === "sh" ||
    name === "cmd"
  ) {
    return "shell";
  }
  return name || "shell";
}

export function resolveToolKind(tool: string, registry = DEFAULT_TOOL_REGISTRY): ToolKind {
  const normalized = normalizeToolName(tool);
  const adapter = registry.adapters.find((entry) => normalizeToolName(entry.tool) === normalized);
  if (adapter) return adapter.kind;
  return KNOWN_TOOL_NAMES.has(normalized) ? "known" : registry.fallbackKind;
}

export function inferToolNameFromFailureText(input: ToolFailureInput): string {
  const explicit = normalizeToolName(input.tool);
  if (explicit !== "shell") return explicit;

  const argv = Array.isArray(input.argv) ? input.argv : [];
  const argvText = argv.join(" ");
  const text = [
    input.commandLine,
    argvText,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr,
  ]
    .map((part) => cleanText(part).toLowerCase())
    .filter(Boolean)
    .join("\n");

  if (
    text.includes("failed to sync branch before push") ||
    text.includes("tracked .codex path blocks branch sync") ||
    text.includes("untracked working tree files would be overwritten") ||
    text.includes("git pull --rebase") ||
    text.includes("could not detach head") ||
    text.includes("could not apply")
  ) {
    return "git";
  }
  if (text.includes("@openai/codex") || text.includes("openai_codex") || /\bcodex\b/.test(text)) {
    return "codex";
  }
  if (/\bgit\b/.test(text) || /\b(rebase|cherry-pick|checkout|merge conflict)\b/.test(text)) {
    return "git";
  }
  if (/\bdocker\b/.test(text) || text.includes("docker_engine")) return "docker";
  if (/\bgh\b/.test(text) || text.includes("github api")) return "gh";
  if (/\bbun\b/.test(text)) return "bun";
  if (/\bnode\b/.test(text)) return "node";
  return "shell";
}

function combinedFailureText(input: ToolFailureInput): string {
  return [
    input.tool,
    input.argv?.join(" "),
    input.commandLine,
    input.summary,
    input.detail,
    input.stdout,
    input.stderr,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function hasNodeEnvRuntimeFailure(text: string): boolean {
  return (
    /env:\s*[`'"\u2018\u2019\u201c\u201d]?node[`'"\u2018\u2019\u201c\u201d]?:?\s+no such file or directory/i.test(
      text,
    ) ||
    /\bnode:\s+not found\b/i.test(text) ||
    /\bnode\.exe.*not found\b/i.test(text)
  );
}

function hasObservedTimeoutFailure(input: ToolFailureInput, text: string): boolean {
  if (input.timedOut || input.exitCode === 124) return true;
  return (
    /(?:^|[\r\n])\s*(?:error:\s*)?(?:command|job|process|request|operation|executor|wrapper|script|test|validation|build|fetch)\s+(?:(?:was|has been)\s+)?timed out(?:\s+(?:after|while|waiting)\b|\s*[.!:]|$)/i.test(
      text,
    ) ||
    /(?:^|[\r\n])\s*(?:error:\s*)?timed out(?:\s+after\b|\s*[.!:]|$)/i.test(text) ||
    /\b(?:context )?deadline exceeded\b/i.test(text) ||
    /\bETIMEDOUT\b/i.test(text) ||
    /(?:^|[\r\n])\s*(?:error:\s*)?(?:(?:command|job|process|request|operation|executor|wrapper|script|test|validation|build|fetch)\s+)?timeout\s+(?:reached|expired|exceeded|after|while|waiting|occurred)\b/i.test(
      text,
    ) ||
    /(?:^|[\r\n])\s*(?:error:\s*)?(?:job|command|process|request|operation|executor|wrapper)\s+timeout(?:\s+(?:reached|expired|after)\b|\s*[.!:]|$)/i.test(
      text,
    ) ||
    /(?:^|[\r\n])\s*timeout\s*(?:[.!:]|$)/i.test(text)
  );
}

export function isWorkerOwnedRuntimeStackFrame(frame: unknown): boolean {
  const normalized = String(frame ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.includes("/workspace/apps/workerpals/") ||
    normalized.includes("/pushpals/apps/workerpals/") ||
    normalized.includes("/packages/cli/runtime/sandbox/apps/workerpals/") ||
    normalized.includes("/.pushpals/runtime/sandbox/apps/workerpals/") ||
    normalized.includes("/.pushpals/runtime/sandbox/.pushpals-workerpals-runtime.js")
  );
}

function hasWorkerRuntimeFailure(text: string): boolean {
  const exception =
    /\b(?:referenceerror|typeerror|syntaxerror|rangeerror|urierror|evalerror|aggregateerror|error):[^\r\n]*/i.exec(
      text,
    );
  if (!exception) return false;
  const firstFrame = text
    .slice((exception.index ?? 0) + exception[0].length)
    .split(/\r?\n/)
    .find((line) => /^\s*at\b/i.test(line));
  return isWorkerOwnedRuntimeStackFrame(firstFrame);
}

export function classifyToolFailure(input: ToolFailureInput): ToolFailureClassification {
  const tool = inferToolNameFromFailureText(input);
  const text = combinedFailureText(input);
  const lower = text.toLowerCase();
  const terminalText = [input.summary, input.detail, input.stderr]
    .map(cleanText)
    .filter(Boolean)
    .join("\n");

  if (hasWorkerRuntimeFailure(terminalText)) {
    return {
      failureClass: "worker_runtime_failure",
      retryable: false,
      remediation:
        "The PushPals WorkerPal runtime failed internally. Use a fixed PushPals runtime before retrying this workload.",
    };
  }

  // Timeout configuration, task wording, and earlier stdout are context, not
  // terminal evidence. Only explicit process state/exit or terminal fields may
  // make a failed tool run a timeout.
  if (hasObservedTimeoutFailure(input, terminalText)) {
    return {
      failureClass: "timeout",
      retryable: true,
      remediation: "Retry with a larger tool budget or reduce the command scope.",
    };
  }

  if (hasNodeEnvRuntimeFailure(text)) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation:
        tool === "codex"
          ? "Codex was invoked through a launcher that requires node, but node is absent in this environment. Use a Bun-backed Codex launcher or install node in the sandbox image."
          : "Install the missing node runtime or invoke the tool through a runtime available in this environment.",
    };
  }

  if (
    lower.includes("requires a newer version of codex") ||
    (lower.includes("requires newer") && lower.includes("codex"))
  ) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Upgrade the Codex CLI/runtime used by PushPals before retrying this model.",
    };
  }

  if (
    lower.includes("docker_engine") ||
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("docker daemon is not running") ||
    (lower.includes("failed to connect to the docker api") && lower.includes("docker"))
  ) {
    return {
      failureClass: "missing_runtime",
      retryable: false,
      remediation:
        "Start Docker Desktop/the Docker daemon, then retry the Docker-backed operation.",
    };
  }

  if (
    lower.includes("command-router") ||
    lower.includes("policy rejection") ||
    lower.includes("policy denied") ||
    lower.includes("disallowed command") ||
    lower.includes("command policy")
  ) {
    return {
      failureClass: "policy_denied",
      retryable: false,
      remediation: "Adjust the tool invocation to comply with the configured command policy.",
    };
  }

  if (
    lower.includes("login is required") ||
    lower.includes("not logged in") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("api_key auth requires")
  ) {
    return {
      failureClass: "auth",
      retryable: false,
      remediation: `Authenticate ${tool} or provide the required token before retrying.`,
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("failed to connect") ||
    lower.includes("connection reset") ||
    lower.includes("network is unreachable")
  ) {
    return {
      failureClass: "network",
      retryable: true,
      remediation: "Retry after the dependent service or network path is available.",
    };
  }

  if (
    lower.includes("read-only file system") ||
    lower.includes("mounted read-only") ||
    lower.includes("operation not permitted") ||
    lower.includes("permission denied") ||
    lower.includes("eacces") ||
    lower.includes("eperm")
  ) {
    const sandboxMount = lower.includes("read-only") || lower.includes("mounted");
    return {
      failureClass: sandboxMount ? "sandbox_mount" : "permission",
      retryable: false,
      remediation: sandboxMount
        ? "Remount the sandbox/worktree with writable metadata or move mutable tool state outside the read-only mount."
        : "Fix filesystem or process permissions before retrying.",
    };
  }

  if (
    lower.includes("rebase in progress") ||
    lower.includes("merge conflict") ||
    lower.includes("tracked .codex path blocks branch sync") ||
    lower.includes("untracked working tree files would be overwritten") ||
    lower.includes("could not apply") ||
    lower.includes("please move or remove them before you switch branches")
  ) {
    return {
      failureClass: "repo_state",
      retryable: false,
      remediation:
        "Resolve the repository state conflict before retrying the same publish/sync step.",
    };
  }

  if (
    lower.includes("command not found") ||
    lower.includes("not recognized as an internal or external command") ||
    lower.includes("neither bunx nor codex was found") ||
    lower.includes("no such file or directory")
  ) {
    return {
      failureClass: "missing_binary",
      retryable: false,
      remediation: `Install ${tool} or configure its executable path before retrying.`,
    };
  }

  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return {
      failureClass: "nonzero_exit",
      retryable: false,
      remediation: `Inspect ${tool} stdout/stderr and fix the command-specific failure before retrying.`,
    };
  }

  return {
    failureClass: "unknown",
    retryable: false,
    remediation: "Inspect the tool output and add a classifier if this failure mode recurs.",
  };
}

export function createToolRunRecordFromFailure(
  input: ToolFailureInput & {
    id: string;
    jobId?: string | null;
    workerId?: string | null;
    sessionId?: string | null;
    phase?: string | null;
    kind?: ToolKind;
    capability?: string | null;
    envProfile?: string | null;
    cwd?: string | null;
    allowedEffects?: ToolEffect[];
    durationMs?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): ToolRunRecord {
  const finishedAt = cleanText(input.finishedAt) || new Date().toISOString();
  const durationMs =
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
      ? Math.round(input.durationMs)
      : 0;
  const finishedMs = Date.parse(finishedAt);
  const fallbackStartedAt = Number.isFinite(finishedMs)
    ? new Date(Math.max(0, finishedMs - durationMs)).toISOString()
    : new Date().toISOString();
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
    exitCode:
      typeof input.exitCode === "number" && Number.isFinite(input.exitCode) ? input.exitCode : null,
    failureClass: classification.failureClass,
    retryable: classification.retryable,
    remediation: classification.remediation,
    startedAt,
    finishedAt,
    durationMs,
    stdoutTail: truncateToolText(redactToolText(input.stdout)),
    stderrTail: truncateToolText(redactToolText(input.stderr ?? input.detail)),
    metadata: input.metadata ?? {},
  };
}
