import { existsSync, readFileSync } from "fs";

/**
 * Check configuration — a command to run and its timeout.
 */
export interface CheckConfig {
  /** A human-readable name for the check. */
  name: string;
  /** Shell command to execute (run via `sh -c` / `cmd /c`). */
  command: string;
  /** Timeout in milliseconds. Default: 300_000 (5 min). */
  timeoutMs?: number;
}

/**
 * Serial pusher configuration.
 */
export interface SerialPusherConfig {
  /** Absolute path to the git repository to manage. */
  repoPath: string;
  /** Git remote name. Default: "origin". */
  remote: string;
  /** The main branch to merge into. Default: "main". */
  mainBranch: string;
  /** Prefix for agent branches to discover. Default: "agent/". */
  branchPrefix: string;
  /** How often to poll for new branches (seconds). Default: 10. */
  pollIntervalSeconds: number;
  /** Ordered list of checks to run on the temp branch after merge, before pushing. */
  checks: CheckConfig[];
  /** Directory for SQLite DB and lock file. Default: "./state". */
  stateDir: string;
  /** Port for the HTTP status server. Default: 3002. */
  port: number;
  /** Whether to delete remote agent branches after successful merge. Default: false. */
  deleteAfterMerge: boolean;
  /** Max consecutive failures before a branch is skipped. Default: 3. */
  maxAttempts: number;
  /** Merge strategy: "no-ff" for merge commits, "ff-only" for linear. Default: "no-ff". */
  mergeStrategy: "no-ff" | "ff-only";
}

const DEFAULTS: SerialPusherConfig = {
  repoPath: process.cwd(),
  remote: "origin",
  mainBranch: "main",
  branchPrefix: "agent/",
  pollIntervalSeconds: 10,
  checks: [],
  stateDir: "./state",
  port: 3002,
  deleteAfterMerge: false,
  maxAttempts: 3,
  mergeStrategy: "no-ff",
};

/**
 * Load config from a JSON file, merging with defaults.
 */
export function loadConfig(configPath?: string): SerialPusherConfig {
  let fileConfig: Partial<SerialPusherConfig> = {};

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw) as Partial<SerialPusherConfig>;
  }

  return { ...DEFAULTS, ...fileConfig };
}

/**
 * Apply CLI overrides on top of loaded config.
 */
export function applyCliOverrides(
  config: SerialPusherConfig,
  overrides: Partial<SerialPusherConfig>,
): SerialPusherConfig {
  const merged = { ...config };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  }

  return merged;
}

/**
 * Validate critical config fields. Throws on invalid values.
 * Call once at startup to catch misconfigurations early.
 */
export function validateConfig(config: SerialPusherConfig): void {
  if (typeof config.port !== "number" || !Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid config: port must be 1-65535, got ${JSON.stringify(config.port)}`);
  }
  if (typeof config.pollIntervalSeconds !== "number" || !Number.isFinite(config.pollIntervalSeconds) || config.pollIntervalSeconds < 1) {
    throw new Error(`Invalid config: pollIntervalSeconds must be >= 1, got ${JSON.stringify(config.pollIntervalSeconds)}`);
  }
  if (typeof config.maxAttempts !== "number" || !Number.isFinite(config.maxAttempts) || config.maxAttempts < 1) {
    throw new Error(`Invalid config: maxAttempts must be >= 1, got ${JSON.stringify(config.maxAttempts)}`);
  }
  if (config.mergeStrategy !== "no-ff" && config.mergeStrategy !== "ff-only") {
    throw new Error(`Invalid config: mergeStrategy must be "no-ff" or "ff-only", got ${JSON.stringify(config.mergeStrategy)}`);
  }
  if (typeof config.repoPath !== "string" || config.repoPath.length === 0) {
    throw new Error(`Invalid config: repoPath must be a non-empty string`);
  }
  if (typeof config.mainBranch !== "string" || config.mainBranch.length === 0) {
    throw new Error(`Invalid config: mainBranch must be a non-empty string`);
  }
}
