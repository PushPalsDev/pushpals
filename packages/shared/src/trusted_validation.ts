export const MAX_TRUSTED_VALIDATION_COMMANDS = 8;
export const MAX_TRUSTED_VALIDATION_COMMAND_LENGTH = 1_000;

const TRUSTED_VALIDATION_EXECUTABLES = new Set([
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
  /** Stable, failure-adjacent lines used for incident identity and repair prompts. */
  failureLines: string[];
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
  failureLines?: string[];
  attempt?: number;
  retryReason?: "transient_infrastructure";
  /** Tree that was executed; baseline proof must never be inferred from candidate count. */
  validationTarget?: "candidate" | "baseline";
  baselineFailureProven?: boolean;
}

export interface TrustedValidationReport {
  version: 1;
  baselineSha: string | null;
  candidateSha: string | null;
  /** Durable hidden ref retaining the exact tree that trusted validation executed. */
  candidateRef: string | null;
  results: TrustedValidationExecutionResult[];
}

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TEST_DURATION_SUFFIX_RE = /\s+\[(?:\d+(?:\.\d+)?)(?:ms|s)\]\s*$/i;
const FAILURE_LINE_RE =
  /(?:^|\s)(?:error|fail(?:ed|ure)?|fatal|panic|panicked|timed?\s*out|timeout|expected|received|assert(?:ion|ionerror)?)(?:\b|:)/i;
const PASS_LINE_RE = /^(?:\(pass\)|PASS\b|\u2713\s|\u2714\s|Tests?\s+\d+\s+passed\b)/i;

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
 * Remove per-run identity from validation evidence without erasing assertion
 * values. Incident fingerprints use this to remain stable across worktrees,
 * ports, process ids, and retries of the same underlying failure.
 */
export function normalizeTrustedValidationFingerprintLine(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<uuid>",
    )
    .replace(
      /\b(?:job|req|request|completion|crash|task|run)_[a-z0-9][a-z0-9_-]{5,}\b/gi,
      (match) => `${match.slice(0, match.indexOf("_") + 1)}<id>`,
    )
    .replace(
      /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/gi,
      "<timestamp>",
    )
    .replace(TEST_DURATION_SUFFIX_RE, "")
    .replace(/\b[0-9a-f]{40,64}\b/gi, "<sha>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, "<duration>")
    .replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/gi, "$1:<port>")
    .replace(/\bport\s*[:=#]?\s*\d{2,5}\b/gi, "port <port>")
    .replace(/\b(pid|process(?:\s+id)?)\s*[:=#]?\s*\d+\b/gi, "$1 <pid>")
    .replace(/(\.[a-z][a-z0-9]{0,7}):\d+:\d+\b/gi, "$1:<line>:<column>")
    .replace(/(\.[a-z][a-z0-9]{0,7}):\d+\b/gi, "$1:<line>")
    .replace(/\(\d+,\d+\)/g, "(<line>,<column>)")
    .replace(
      /(?:[a-z]:)?\/(?:users\/[^/\s]+\/appdata\/local\/temp|tmp|var\/tmp)\/[^\s'"`]+/gi,
      "<temp-path>",
    )
    .replace(
      /(?:[a-z]:)?\/[^\s'"`]*?\.pushpals\/(?:runtime\/)?worktrees?\/[^/\s'"`]+/gi,
      "<worktree>",
    )
    .replace(/(?:[a-z]:)?\/[^\s'"`]*?\/\.worktrees\/[^/\s'"`]+/gi, "<worktree>")
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
}

function normalizeFailureLine(value: string): string {
  return normalizeTrustedValidationFingerprintLine(value);
}

function failureNeighborhoodLines(output: string, radius = 2): string[] {
  const lines = output.replace(ANSI_ESCAPE_RE, "").split(/\r?\n/);
  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line || PASS_LINE_RE.test(line) || !FAILURE_LINE_RE.test(line)) continue;
    for (
      let candidate = Math.max(0, index - radius);
      candidate <= Math.min(lines.length - 1, index + radius);
      candidate += 1
    ) {
      if (lines[candidate]?.trim()) selected.add(candidate);
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index]?.trim() ?? "")
    .filter(Boolean);
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
  const failureLines: string[] = [];
  let currentTestPath: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // A bare Bun test-file heading is not failure evidence. Keep it as context
    // and associate it with a path only after a named failure is observed.
    const bunPath = line.match(/^(.+\.(?:test|spec|vitest)\.[cm]?[jt]sx?):\s*$/i)?.[1];
    const suitePath = line.match(
      /^(?:FAIL|failed)\s+(.+\.(?:test|spec|vitest)\.[cm]?[jt]sx?)(?:\s|$)/i,
    )?.[1];
    const diagnosticPath = line.match(/^([^:(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s+error\b/i)?.[1];
    const pytestFailure = line.match(/^FAILED\s+(.+?\.py)::([^\s]+)(?:\s+-\s+|$)/i);
    const portableDiagnosticPath = line.match(/^(.+?\.(?:py|go|rs)):\d+(?::\d+)?:/i)?.[1];
    const cargoPanic = line.match(
      /^thread\s+['"]([^'"]+)['"]\s+panicked\s+at\s+(.+?\.rs):\d+(?::\d+)?:/i,
    );
    const bunContextPath = normalizeEvidencePath(bunPath ?? "");
    if (bunContextPath) currentTestPath = bunContextPath;
    const failingPath = normalizeEvidencePath(
      suitePath ??
        pytestFailure?.[1] ??
        cargoPanic?.[2] ??
        diagnosticPath ??
        portableDiagnosticPath ??
        "",
    );
    if (failingPath) {
      currentTestPath = failingPath;
      targetPathHints.push(failingPath);
    }

    const bunFailure = line.match(/^\(fail\)\s+(.+)$/i)?.[1];
    const jestFailure = line.match(/^[\u2715\u2717]\s+(.+)$/)?.[1];
    const vitestFailure = line.match(
      /^FAIL\s+.+?\.(?:test|spec|vitest)\.[cm]?[jt]sx?\s*>\s*(.+)$/i,
    )?.[1];
    const jestSuiteFailure = line.match(/^\u25cf\s+(.+)$/)?.[1];
    const goFailure = line.match(/^---\s+FAIL:\s+([^\s(]+)(?:\s+\(|$)/i)?.[1];
    const cargoStdoutFailure = line.match(/^----\s+(.+?)\s+stdout\s+----$/i)?.[1];
    const cargoTestFailure = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED$/i)?.[1];
    const namedFailure = (
      bunFailure ??
      jestFailure ??
      vitestFailure ??
      jestSuiteFailure ??
      pytestFailure?.[2] ??
      goFailure ??
      cargoStdoutFailure ??
      cargoTestFailure ??
      cargoPanic?.[1] ??
      ""
    )
      .replace(TEST_DURATION_SUFFIX_RE, "")
      .trim();
    if (namedFailure) {
      failedTests.push(namedFailure);
      if (currentTestPath) targetPathHints.push(currentTestPath);
    }

    if (
      !PASS_LINE_RE.test(line) &&
      (Boolean(namedFailure) || Boolean(failingPath) || FAILURE_LINE_RE.test(line))
    ) {
      failureLines.push(normalizeFailureLine(line));
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
    failureLines: uniqueSorted(failureLines).slice(0, 20),
  };
}

export function truncateTrustedValidationOutput(output: string, maxChars = 16_000): string {
  const text = String(output ?? "");
  const boundedMax = Math.max(1_000, Math.floor(maxChars));
  if (text.length <= boundedMax) return text;
  const headChars = Math.min(3_000, Math.floor(boundedMax / 4));
  const failureContext = failureNeighborhoodLines(text)
    .join("\n")
    .slice(0, Math.max(2_000, Math.floor(boundedMax / 2)));
  const remaining = Math.max(1_000, boundedMax - headChars - failureContext.length - 100);
  return [
    text.slice(0, headChars),
    "... trusted validation output truncated ...",
    failureContext ? `Failure context:\n${failureContext}` : "",
    text.slice(-remaining),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, boundedMax);
}

function isSafeRelativeValidationPath(value: string, allowDot = false): boolean {
  const normalized = String(value ?? "").replace(/\\/g, "/");
  const pathSegments = normalized.replace(/^\.\//, "").split("/");
  if (allowDot && normalized === ".") return true;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("://") ||
    pathSegments.some(
      (segment) =>
        segment === ".." ||
        [".git", ".pushpals", ".worktrees", "node_modules"].includes(segment.toLowerCase()),
    ) ||
    (normalized.startsWith("-") && !normalized.startsWith("./-"))
  ) {
    return false;
  }
  return /^[\p{L}\p{N}_@+.,()[\]/ -]+$/u.test(normalized);
}

function isSafeTestSourcePath(value: string, extensions: string[]): boolean {
  if (!isSafeRelativeValidationPath(value)) return false;
  const normalized = value.toLowerCase().replace(/^\.\//, "");
  if (/(^|\/)(?:tests?|specs?|integration_test)$/.test(normalized)) return true;
  return (
    extensions.some((extension) => normalized.endsWith(extension)) &&
    /(^|\/)(?:tests?|specs?|integration_test)(\/|$)|_(?:test|spec)\.[^/]+$/.test(normalized)
  );
}

function expectedCmakeBuildPath(sourcePath: string): string {
  return sourcePath === "." ? "build" : `${sourcePath.replace(/\/$/, "")}/build`;
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
  if (
    executable === "ruby" &&
    (firstArg !== "-c" ||
      argv.length !== 3 ||
      !isSafeRelativeValidationPath(argv[2] ?? "") ||
      !argv[2]?.toLowerCase().endsWith(".rb"))
  ) {
    return null;
  }
  if (
    executable === "php" &&
    (firstArg !== "-l" ||
      argv.length !== 3 ||
      !isSafeRelativeValidationPath(argv[2] ?? "") ||
      !argv[2]?.toLowerCase().endsWith(".php"))
  ) {
    return null;
  }
  if (
    executable === "dotnet" &&
    !(
      firstArg === "test" &&
      (argv.length === 2 ||
        (argv.length === 3 &&
          isSafeRelativeValidationPath(argv[2] ?? "") &&
          /\.(?:sln|csproj|fsproj)$/i.test(argv[2] ?? "")))
    )
  ) {
    return null;
  }
  if (
    executable === "bundle" &&
    !(
      firstArg === "exec" &&
      (argv[2]?.toLowerCase() === "rspec" ||
        (argv[2]?.toLowerCase() === "rake" &&
          argv.length === 4 &&
          argv[3]?.toLowerCase() === "test"))
    )
  ) {
    return null;
  }
  if (
    executable === "bundle" &&
    argv[2]?.toLowerCase() === "rspec" &&
    (argv.length > 7 || argv.slice(3).some((path) => !isSafeTestSourcePath(path, [".rb"])))
  ) {
    return null;
  }
  const trailingTest = argv[argv.length - 1]?.toLowerCase() === "test";
  const safeComposer =
    (argv.length === 2 && firstArg === "test") ||
    (argv.length === 3 && firstArg === "run" && argv[2]?.toLowerCase() === "test") ||
    (argv.length === 4 && firstArg === "--working-dir" && trailingTest) ||
    (argv.length === 3 && firstArg.startsWith("--working-dir=") && trailingTest);
  if (
    executable === "composer" &&
    (!safeComposer ||
      (firstArg === "--working-dir" && !isSafeRelativeValidationPath(argv[2] ?? "")) ||
      (firstArg.startsWith("--working-dir=") &&
        !isSafeRelativeValidationPath(argv[1]?.slice("--working-dir=".length) ?? "")))
  ) {
    return null;
  }
  const safeMavenOrGradle =
    (argv.length === 2 && trailingTest) ||
    (argv.length === 4 &&
      ["-f", "--file", "-p", "--project-dir"].includes(firstArg) &&
      trailingTest);
  if (["mvn", "gradle"].includes(executable) && !safeMavenOrGradle) {
    return null;
  }
  if (
    ["mvn", "gradle"].includes(executable) &&
    argv.length === 4 &&
    (!isSafeRelativeValidationPath(argv[2] ?? "") ||
      (executable === "mvn" && !argv[2]?.toLowerCase().endsWith("pom.xml")))
  ) {
    return null;
  }
  if (
    executable === "git" &&
    !(argv.length === 3 && firstArg === "diff" && argv[2]?.toLowerCase() === "--check")
  ) {
    return null;
  }
  if (executable === "cmake") {
    const safeConfigure =
      argv.length === 5 &&
      firstArg === "-s" &&
      argv[3]?.toLowerCase() === "-b" &&
      isSafeRelativeValidationPath(argv[2] ?? "", true) &&
      isSafeRelativeValidationPath(argv[4] ?? "") &&
      argv[4] === expectedCmakeBuildPath(argv[2] ?? "");
    const safeBuild =
      argv.length === 3 &&
      firstArg === "--build" &&
      isSafeRelativeValidationPath(argv[2] ?? "") &&
      /(^|\/)build$/.test(argv[2] ?? "");
    if (!safeConfigure && !safeBuild) return null;
  }
  if (
    executable === "ctest" &&
    !(
      argv.length === 4 &&
      firstArg === "--test-dir" &&
      isSafeRelativeValidationPath(argv[2] ?? "") &&
      /(^|\/)build$/.test(argv[2] ?? "") &&
      argv[3]?.toLowerCase() === "--output-on-failure"
    )
  ) {
    return null;
  }
  if (
    executable === "make" &&
    !(
      (argv.length === 2 && ["test", "check"].includes(firstArg)) ||
      (argv.length === 4 &&
        firstArg === "-c" &&
        isSafeRelativeValidationPath(argv[2] ?? "") &&
        ["test", "check"].includes(argv[3]?.toLowerCase() ?? ""))
    )
  ) {
    return null;
  }
  if (
    executable === "bazel" &&
    !(
      argv.length === 3 &&
      firstArg === "test" &&
      /^\/\/[A-Za-z0-9_@+.,/-]*\.\.\.$/.test(argv[2] ?? "")
    )
  ) {
    return null;
  }
  if (
    executable === "buf" &&
    !(
      firstArg === "lint" &&
      (argv.length === 2 || (argv.length === 3 && isSafeRelativeValidationPath(argv[2] ?? "")))
    )
  ) {
    return null;
  }
  if (
    executable === "swift" &&
    !(
      (argv.length === 2 && firstArg === "test") ||
      (argv.length === 4 &&
        firstArg === "test" &&
        argv[2]?.toLowerCase() === "--package-path" &&
        isSafeRelativeValidationPath(argv[3] ?? ""))
    )
  ) {
    return null;
  }
  if (["dart", "flutter"].includes(executable)) {
    const safeDartDirectoryTest =
      executable === "dart" &&
      firstArg === "--directory" &&
      argv.length === 4 &&
      isSafeRelativeValidationPath(argv[2] ?? "") &&
      argv[3]?.toLowerCase() === "test";
    if (
      !safeDartDirectoryTest &&
      (firstArg !== "test" ||
        argv.length > 6 ||
        argv.slice(2).some((path) => !isSafeTestSourcePath(path, [".dart"])))
    ) {
      return null;
    }
  }
  if (
    executable === "mix" &&
    !(
      (firstArg === "test" &&
        argv.length <= 6 &&
        argv.slice(2).every((path) => isSafeTestSourcePath(path, [".exs"]))) ||
      (firstArg === "--cd" &&
        argv.length === 4 &&
        isSafeRelativeValidationPath(argv[2] ?? "") &&
        argv[3]?.toLowerCase() === "test")
    )
  ) {
    return null;
  }
  if (
    executable === "cabal" &&
    !(argv.length === 3 && firstArg === "test" && argv[2]?.toLowerCase() === "all")
  ) {
    return null;
  }
  if (
    executable === "stack" &&
    !(
      (argv.length === 2 && firstArg === "test") ||
      (argv.length === 4 &&
        firstArg === "--stack-yaml" &&
        isSafeRelativeValidationPath(argv[2] ?? "") &&
        argv[2]?.toLowerCase().endsWith("/stack.yaml") &&
        argv[3]?.toLowerCase() === "test")
    )
  ) {
    return null;
  }
  if (
    executable === "clojure" &&
    !(argv.length === 2 && ["-x:test", "-m:test"].includes(firstArg))
  ) {
    return null;
  }
  if (executable === "lein" && !(argv.length === 2 && firstArg === "test")) return null;
  if (
    executable === "zig" &&
    !(
      (argv.length === 3 && firstArg === "build" && argv[2]?.toLowerCase() === "test") ||
      (argv.length === 5 &&
        firstArg === "build" &&
        argv[2]?.toLowerCase() === "--build-file" &&
        isSafeRelativeValidationPath(argv[3] ?? "") &&
        argv[3]?.toLowerCase().endsWith("/build.zig") &&
        argv[4]?.toLowerCase() === "test")
    )
  ) {
    return null;
  }
  if (
    executable === "terraform" &&
    !(
      firstArg === "fmt" &&
      argv[2]?.toLowerCase() === "-check" &&
      argv.length >= 4 &&
      argv.length <= 7 &&
      argv
        .slice(3)
        .every((path) => isSafeRelativeValidationPath(path) && /\.(?:tf|tfvars)$/i.test(path))
    )
  ) {
    return null;
  }
  if (executable === "luac") {
    if (
      firstArg !== "-p" ||
      argv.length !== 3 ||
      !isSafeRelativeValidationPath(argv[2] ?? "") ||
      !argv[2]?.toLowerCase().endsWith(".lua")
    ) {
      return null;
    }
  }
  if (executable === "rscript") {
    const expression = argv.length === 3 && firstArg === "-e" ? (argv[2] ?? "") : "";
    const parsedPath = expression.match(/^parse\(file='([^']+)'\)$/)?.[1] ?? "";
    if (
      !parsedPath ||
      !isSafeRelativeValidationPath(parsedPath) ||
      !parsedPath.toLowerCase().endsWith(".r")
    ) {
      return null;
    }
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
