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
