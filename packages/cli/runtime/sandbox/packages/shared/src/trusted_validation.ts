export const MAX_TRUSTED_VALIDATION_COMMANDS = 8;
export const MAX_TRUSTED_VALIDATION_COMMAND_LENGTH = 1_000;

const TRUSTED_VALIDATION_EXECUTABLES = new Set([
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
  "yarn",
]);

export type TrustedValidationCommandsResult =
  | { ok: true; commands: string[] }
  | { ok: false; message: string };

export type TrustedValidationPhase = "dependency_install" | "validation";

export interface TrustedValidationFailureEvidence {
  failureClass:
    | "dependency_setup_failed"
    | "lint_failure"
    | "test_failure"
    | "timeout"
    | "trusted_validation_failed"
    | "typecheck_failure";
  failedTests: string[];
  targetPathHints: string[];
}

export interface TrustedValidationExecutionResult {
  ok: boolean;
  command: string;
  output: string;
  exitCode: number;
  durationMs: number;
  cached?: boolean;
  phase: TrustedValidationPhase;
  failureClass?: TrustedValidationFailureEvidence["failureClass"];
  failedTests?: string[];
  targetPathHints?: string[];
}

export interface TrustedValidationReport {
  version: 1;
  baselineSha: string | null;
  candidateSha: string | null;
  results: TrustedValidationExecutionResult[];
}

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TEST_DURATION_SUFFIX_RE = /\s+\[(?:\d+(?:\.\d+)?)(?:ms|s)\]\s*$/i;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function normalizeEvidencePath(value: string): string | null {
  let normalized = value
    .trim()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/\\/g, "/");
  normalized = normalized.replace(/:\d+(?::\d+)?$/, "").replace(/:\s*$/, "");
  normalized = normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.includes("node_modules/")) return null;
  if (!/\.[a-z0-9]+$/i.test(normalized)) return null;
  return normalized;
}

/**
 * Extract stable test names and paths before transport truncates noisy command
 * output. The evidence deliberately excludes durations and candidate SHAs so
 * the same baseline failure can be correlated across unrelated jobs.
 */
export function extractTrustedValidationFailureEvidence(options: {
  command: string;
  phase: TrustedValidationPhase;
  output: string;
  exitCode: number;
}): TrustedValidationFailureEvidence {
  const command = String(options.command ?? "")
    .trim()
    .toLowerCase();
  const output = String(options.output ?? "").replace(ANSI_ESCAPE_RE, "");
  const failedTests: string[] = [];
  const targetPathHints: string[] = [];
  let currentTestPath: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bunPath = line.match(/^(.+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/i)?.[1];
    const suitePath = line.match(
      /^(?:FAIL|failed)\s+(.+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s|$)/i,
    )?.[1];
    const diagnosticPath = line.match(/^([^:(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s+error\b/i)?.[1];
    const path = normalizeEvidencePath(bunPath ?? suitePath ?? diagnosticPath ?? "");
    if (path) {
      currentTestPath = path;
      targetPathHints.push(path);
    }

    const bunFailure = line.match(/^\(fail\)\s+(.+)$/i)?.[1];
    const jestFailure = line.match(/^[\u2715\u2717]\s+(.+)$/)?.[1];
    const namedFailure = (bunFailure ?? jestFailure ?? "")
      .replace(TEST_DURATION_SUFFIX_RE, "")
      .trim();
    if (namedFailure) {
      failedTests.push(namedFailure);
      if (currentTestPath) targetPathHints.push(currentTestPath);
    }
  }

  let failureClass: TrustedValidationFailureEvidence["failureClass"];
  if (options.phase === "dependency_install") {
    failureClass = "dependency_setup_failed";
  } else if (options.exitCode === 124) {
    failureClass = "timeout";
  } else if (failedTests.length > 0) {
    failureClass = "test_failure";
  } else if (/timed?\s*out|timeout/i.test(output)) {
    failureClass = "timeout";
  } else if (/(?:^|\s)(?:test|jest|vitest)(?:\s|$)/i.test(command)) {
    failureClass = "test_failure";
  } else if (/\b(?:tsc|typecheck|type-check)\b/i.test(command)) {
    failureClass = "typecheck_failure";
  } else if (/\b(?:eslint|lint)\b/i.test(command)) {
    failureClass = "lint_failure";
  } else {
    failureClass = "trusted_validation_failed";
  }

  return {
    failureClass,
    failedTests: uniqueSorted(failedTests),
    targetPathHints: uniqueSorted(targetPathHints),
  };
}

export function truncateTrustedValidationOutput(output: string, maxChars = 16_000): string {
  const text = String(output ?? "");
  const boundedMax = Math.max(1_000, Math.floor(maxChars));
  if (text.length <= boundedMax) return text;
  const headChars = Math.min(4_000, Math.floor(boundedMax / 3));
  const tailChars = boundedMax - headChars;
  return `${text.slice(0, headChars)}\n... trusted validation output truncated ...\n${text.slice(-tailChars)}`;
}

/**
 * Parse a validation command without invoking a shell. This intentionally
 * supports quoted arguments while rejecting shell control syntax and command
 * substitution. SourceControlManager executes the returned argv directly.
 */
export function tokenizeTrustedValidationCommand(command: string): string[] | null {
  const trimmed = String(command ?? "").trim();
  if (!trimmed || trimmed.length > MAX_TRUSTED_VALIDATION_COMMAND_LENGTH) return null;

  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = () => {
    if (!current) return;
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
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`" || ch === "\n" || ch === "\r") {
      return null;
    }
    current += ch;
  }

  if (escaped || quote) return null;
  pushCurrent();
  if (argv.length === 0) return null;
  if (argv.some((entry) => entry.includes("$(") || entry.includes("${"))) return null;

  if (argv[0].includes("/") || argv[0].includes("\\")) return null;
  const executable = argv[0].toLowerCase();
  if (!TRUSTED_VALIDATION_EXECUTABLES.has(executable)) return null;
  const firstArg = argv[1]?.toLowerCase() ?? "";
  if (
    (["bun", "deno", "node"].includes(executable) && ["-e", "--eval"].includes(firstArg)) ||
    (["python", "python3"].includes(executable) && firstArg === "-c")
  ) {
    return null;
  }
  return argv;
}

export function normalizeTrustedValidationCommands(
  value: unknown,
): TrustedValidationCommandsResult {
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
      message: `trusted validation is limited to ${MAX_TRUSTED_VALIDATION_COMMANDS} commands`,
    };
  }

  const commands: string[] = [];
  const seen = new Set<string>();
  for (const entry of candidate) {
    if (typeof entry !== "string") {
      return { ok: false, message: "trusted validation commands must contain only strings" };
    }
    const command = entry.trim();
    if (!tokenizeTrustedValidationCommand(command)) {
      return { ok: false, message: `unsafe or unsupported trusted validation command: ${command}` };
    }
    const key = command.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
  }

  return commands.length > 0
    ? { ok: true, commands }
    : { ok: false, message: "trusted validation commands must be a non-empty array" };
}
