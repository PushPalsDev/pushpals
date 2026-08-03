import {
  normalizeTrustedValidationCommands,
  tokenizeTrustedValidationCommand,
} from "../../../packages/shared/src/trusted_validation.js";
import { existsSync } from "fs";
import { basename } from "path";

export type TrustedValidationCommandResult = {
  ok: boolean;
  command: string;
  output: string;
  exitCode: number;
};

type CommandRunner = (
  argv: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ ok: boolean; output: string; exitCode: number }>;

const DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS = 15 * 60_000;
const BUN_DEPENDENCY_COMMANDS = new Set([
  "bun",
  "bunx",
  "eslint",
  "jest",
  "node",
  "npm",
  "npx",
  "tsc",
  "vitest",
]);

function currentBunExecutable(explicit?: string): string {
  const configured = String(explicit ?? process.env.PUSHPALS_BUN_BIN ?? "").trim();
  if (configured) return configured;
  const execPath = String(process.execPath ?? "").trim();
  return /^(?:bun|bun\.exe)$/i.test(basename(execPath)) ? execPath : "";
}

export function resolveTrustedValidationArgv(argv: string[], bunExecutable?: string): string[] {
  if (argv.length === 0) return [];
  const bun = currentBunExecutable(bunExecutable);
  if (!bun) return [...argv];
  const executable = String(argv[0] ?? "")
    .trim()
    .toLowerCase();
  if (executable === "bun" || executable === "bun.exe") {
    return [bun, ...argv.slice(1)];
  }
  if (executable === "bunx" || executable === "bunx.exe") {
    return [bun, "x", ...argv.slice(1)];
  }
  return [...argv];
}

export function resolveTrustedValidationPreparationArgv(options: {
  repoPath: string;
  commandArgv: string[][];
  bunExecutable?: string;
}): string[] | null {
  const hasBunProject =
    existsSync(`${options.repoPath}/package.json`) &&
    (existsSync(`${options.repoPath}/bun.lock`) || existsSync(`${options.repoPath}/bun.lockb`));
  const needsDependencies = options.commandArgv.some((argv) =>
    BUN_DEPENDENCY_COMMANDS.has(
      String(argv[0] ?? "")
        .trim()
        .toLowerCase(),
    ),
  );
  if (!hasBunProject || !needsDependencies) return null;

  const bun = currentBunExecutable(options.bunExecutable);
  return [bun || "bun", "install", "--frozen-lockfile"];
}

async function runArgv(
  argv: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    ok: exitCode === 0,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
    exitCode,
  };
}

export async function runTrustedValidationCommands(options: {
  repoPath: string;
  commandsJson: string;
  timeoutMs?: number;
  bunExecutable?: string;
  runner?: CommandRunner;
}): Promise<TrustedValidationCommandResult[]> {
  const normalized = normalizeTrustedValidationCommands(options.commandsJson);
  if (!normalized.ok) {
    throw new Error(`Invalid trusted-validation handoff: ${normalized.message}`);
  }

  const runner = options.runner ?? runArgv;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS);
  const results: TrustedValidationCommandResult[] = [];
  const commandsWithArgv = normalized.commands.map((command) => {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv)
      throw new Error(`Invalid trusted-validation command after normalization: ${command}`);
    return { command, argv };
  });
  const preparationArgv = resolveTrustedValidationPreparationArgv({
    repoPath: options.repoPath,
    commandArgv: commandsWithArgv.map(({ argv }) => argv),
    bunExecutable: options.bunExecutable,
  });
  if (preparationArgv) {
    const preparation = await runner(preparationArgv, { cwd: options.repoPath, timeoutMs });
    results.push({ command: "bun install --frozen-lockfile", ...preparation });
    if (!preparation.ok) return results;
  }

  for (const { command, argv } of commandsWithArgv) {
    const resolvedArgv = resolveTrustedValidationArgv(argv, options.bunExecutable);
    const result = await runner(resolvedArgv, { cwd: options.repoPath, timeoutMs });
    results.push({ command, ...result });
    if (!result.ok) break;
  }
  return results;
}
