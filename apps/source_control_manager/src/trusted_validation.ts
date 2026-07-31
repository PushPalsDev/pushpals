import {
  normalizeTrustedValidationCommands,
  tokenizeTrustedValidationCommand,
} from "../../../packages/shared/src/trusted_validation.js";

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
  runner?: CommandRunner;
}): Promise<TrustedValidationCommandResult[]> {
  const normalized = normalizeTrustedValidationCommands(options.commandsJson);
  if (!normalized.ok) {
    throw new Error(`Invalid trusted-validation handoff: ${normalized.message}`);
  }

  const runner = options.runner ?? runArgv;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS);
  const results: TrustedValidationCommandResult[] = [];
  for (const command of normalized.commands) {
    const argv = tokenizeTrustedValidationCommand(command);
    if (!argv) {
      throw new Error(`Invalid trusted-validation command after normalization: ${command}`);
    }
    const result = await runner(argv, { cwd: options.repoPath, timeoutMs });
    results.push({ command, ...result });
    if (!result.ok) break;
  }
  return results;
}
