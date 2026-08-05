import {
  normalizeTrustedValidationCommands,
  tokenizeTrustedValidationCommand,
} from "../../../packages/shared/src/trusted_validation.js";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, resolve } from "path";

export type TrustedValidationCommandResult = {
  ok: boolean;
  command: string;
  output: string;
  exitCode: number;
  durationMs: number;
  cached?: boolean;
  phase: "dependency_install" | "validation";
};

type CommandRunner = (
  argv: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ ok: boolean; output: string; exitCode: number }>;

const DEFAULT_TRUSTED_VALIDATION_TIMEOUT_MS = 15 * 60_000;
const TRUSTED_INSTALL_MARKER = ".pushpals-trusted-install.json";
const trustedInstallFlights = new Map<string, Promise<TrustedValidationCommandResult>>();
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

export function trustedValidationInstallFingerprint(options: {
  repoPath: string;
  bunExecutable?: string;
}): string | null {
  const packagePath = resolve(options.repoPath, "package.json");
  const lockPath = [
    resolve(options.repoPath, "bun.lock"),
    resolve(options.repoPath, "bun.lockb"),
  ].find((path) => existsSync(path));
  if (!existsSync(packagePath) || !lockPath) return null;
  const hash = createHash("sha256");
  hash.update(`platform=${process.platform}-${process.arch}\n`);
  hash.update(`bun=${currentBunExecutable(options.bunExecutable) || "bun"}\n`);
  hash.update(`version=${typeof Bun !== "undefined" ? Bun.version : "unknown"}\n`);
  hash.update(readFileSync(packagePath));
  hash.update("\0");
  hash.update(readFileSync(lockPath));
  return hash.digest("hex");
}

function trustedInstallMarkerPath(repoPath: string): string {
  return resolve(repoPath, "node_modules", TRUSTED_INSTALL_MARKER);
}

export function hasFreshTrustedValidationInstall(options: {
  repoPath: string;
  bunExecutable?: string;
}): boolean {
  const fingerprint = trustedValidationInstallFingerprint(options);
  if (!fingerprint) return false;
  try {
    const marker = JSON.parse(readFileSync(trustedInstallMarkerPath(options.repoPath), "utf8")) as {
      fingerprint?: unknown;
    };
    return marker.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

async function runTimed(
  runner: CommandRunner,
  argv: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ ok: boolean; output: string; exitCode: number; durationMs: number }> {
  const startedAt = Date.now();
  const result = await runner(argv, options);
  return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
}

async function ensureTrustedValidationInstall(options: {
  repoPath: string;
  preparationArgv: string[];
  timeoutMs: number;
  bunExecutable?: string;
  runner: CommandRunner;
}): Promise<TrustedValidationCommandResult> {
  if (hasFreshTrustedValidationInstall(options)) {
    return {
      command: "bun install --frozen-lockfile",
      ok: true,
      output: "Trusted dependency install cache hit for unchanged package and lockfile inputs.",
      exitCode: 0,
      durationMs: 0,
      cached: true,
      phase: "dependency_install",
    };
  }

  const flightKey = resolve(options.repoPath);
  const activeFlight = trustedInstallFlights.get(flightKey);
  if (activeFlight) return await activeFlight;
  const flight = (async (): Promise<TrustedValidationCommandResult> => {
    if (hasFreshTrustedValidationInstall(options)) {
      return {
        command: "bun install --frozen-lockfile",
        ok: true,
        output: "Trusted dependency install cache hit after waiting for another validation.",
        exitCode: 0,
        durationMs: 0,
        cached: true,
        phase: "dependency_install",
      };
    }
    const preparation = await runTimed(options.runner, options.preparationArgv, {
      cwd: options.repoPath,
      timeoutMs: options.timeoutMs,
    });
    const result: TrustedValidationCommandResult = {
      command: "bun install --frozen-lockfile",
      ...preparation,
      phase: "dependency_install",
    };
    if (preparation.ok) {
      const fingerprint = trustedValidationInstallFingerprint(options);
      if (fingerprint) {
        try {
          writeFileSync(
            trustedInstallMarkerPath(options.repoPath),
            JSON.stringify({ fingerprint, updatedAt: new Date().toISOString() }),
            "utf8",
          );
        } catch {
          // A successful install remains valid for this run; a later run will
          // simply reinstall if its marker could not be persisted.
        }
      }
    }
    return result;
  })();
  trustedInstallFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (trustedInstallFlights.get(flightKey) === flight) trustedInstallFlights.delete(flightKey);
  }
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
    const preparation = await ensureTrustedValidationInstall({
      repoPath: options.repoPath,
      preparationArgv,
      timeoutMs,
      bunExecutable: options.bunExecutable,
      runner,
    });
    results.push(preparation);
    if (!preparation.ok) return results;
  }

  for (const { command, argv } of commandsWithArgv) {
    const resolvedArgv = resolveTrustedValidationArgv(argv, options.bunExecutable);
    const result = await runTimed(runner, resolvedArgv, { cwd: options.repoPath, timeoutMs });
    results.push({ command, ...result, phase: "validation" });
    if (!result.ok) break;
  }
  return results;
}
