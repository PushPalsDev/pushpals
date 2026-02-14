import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { loadPushPalsConfig } from "../../../packages/shared/src/config.js";

/**
 * Check configuration - a command to run and its timeout.
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
 * SourceControlManager configuration.
 */
export interface SourceControlManagerConfig {
  /** Absolute path to the git repository to manage. */
  repoPath: string;
  /** PushPals server URL. */
  serverUrl: string;
  /** Git remote name. */
  remote: string;
  /** The integration branch to merge into. */
  mainBranch: string;
  /** Base branch used for integration bootstrap/sync. */
  integrationBaseBranch: string;
  /** Prefix for agent branches to discover. */
  branchPrefix: string;
  /** How often to poll for new branches (seconds). */
  pollIntervalSeconds: number;
  /** Ordered list of checks to run on the temp branch after merge, before pushing. */
  checks: CheckConfig[];
  /** Directory for SQLite DB and lock file. */
  stateDir: string;
  /** Port for the HTTP status server. */
  port: number;
  /** Whether to delete remote agent branches after successful merge. */
  deleteAfterMerge: boolean;
  /** Max consecutive failures before a branch is skipped. */
  maxAttempts: number;
  /**
   * Integration strategy:
   * - "cherry-pick": apply worker commit(s) onto integration branch
   * - "no-ff": merge commit
   * - "ff-only": fast-forward only
   */
  mergeStrategy: "cherry-pick" | "no-ff" | "ff-only";
  /** Push integration branch to remote after successful merge/checks. */
  pushMainAfterMerge: boolean;
  /** Open or reuse a PR from integration branch to base branch after successful push. */
  openPrAfterPush: boolean;
  /** Base branch for auto-opened PRs. */
  prBaseBranch: string;
  /** Optional PR title override for auto-opened PRs. */
  prTitle?: string;
  /** Optional PR body override for auto-opened PRs. */
  prBody?: string;
  /** Open PR as draft. */
  prDraft: boolean;
  /** Authentication token for server API calls. */
  authToken?: string;
  /** Git token for authenticated git push/fetch. */
  gitToken?: string | null;
  /** Emit SCM status heartbeat interval (ms). */
  statusHeartbeatMs: number;
  /** Skip clean-repo guard at startup. */
  skipCleanCheck: boolean;
  /** Auto-create missing integration branch without prompt. */
  autoCreateMainBranch: boolean;
}

const PUSH_CONFIG = loadPushPalsConfig();

const DEFAULTS: SourceControlManagerConfig = {
  repoPath: resolve(PUSH_CONFIG.sourceControlManager.repoPath),
  serverUrl: PUSH_CONFIG.server.url,
  remote: PUSH_CONFIG.sourceControlManager.remote,
  mainBranch: PUSH_CONFIG.sourceControlManager.mainBranch,
  integrationBaseBranch: PUSH_CONFIG.sourceControlManager.baseBranch,
  branchPrefix: PUSH_CONFIG.sourceControlManager.branchPrefix,
  pollIntervalSeconds: PUSH_CONFIG.sourceControlManager.pollIntervalSeconds,
  checks: [],
  stateDir: resolve(PUSH_CONFIG.sourceControlManager.stateDir),
  port: PUSH_CONFIG.sourceControlManager.port,
  deleteAfterMerge: PUSH_CONFIG.sourceControlManager.deleteAfterMerge,
  maxAttempts: PUSH_CONFIG.sourceControlManager.maxAttempts,
  mergeStrategy: PUSH_CONFIG.sourceControlManager.mergeStrategy,
  pushMainAfterMerge: PUSH_CONFIG.sourceControlManager.pushMainAfterMerge,
  openPrAfterPush: PUSH_CONFIG.sourceControlManager.openPrAfterPush,
  prBaseBranch: PUSH_CONFIG.sourceControlManager.prBaseBranch,
  prTitle: PUSH_CONFIG.sourceControlManager.prTitle ?? undefined,
  prBody: PUSH_CONFIG.sourceControlManager.prBody ?? undefined,
  prDraft: PUSH_CONFIG.sourceControlManager.prDraft,
  authToken: PUSH_CONFIG.authToken ?? undefined,
  gitToken: PUSH_CONFIG.gitToken,
  statusHeartbeatMs: PUSH_CONFIG.sourceControlManager.statusHeartbeatMs,
  skipCleanCheck: PUSH_CONFIG.sourceControlManager.skipCleanCheck,
  autoCreateMainBranch: PUSH_CONFIG.sourceControlManager.autoCreateMainBranch,
};

/**
 * Load config from a JSON file, merging with defaults.
 */
export function loadConfig(configPath?: string): SourceControlManagerConfig {
  let fileConfig: Partial<SourceControlManagerConfig> = {};

  if (configPath && existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw) as Partial<SourceControlManagerConfig>;
  }

  return { ...DEFAULTS, ...fileConfig };
}

/**
 * Apply CLI overrides on top of loaded config.
 */
export function applyCliOverrides(
  config: SourceControlManagerConfig,
  overrides: Partial<SourceControlManagerConfig>,
): SourceControlManagerConfig {
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
export function validateConfig(config: SourceControlManagerConfig): void {
  if (
    typeof config.port !== "number" ||
    !Number.isFinite(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error(`Invalid config: port must be 1-65535, got ${JSON.stringify(config.port)}`);
  }
  if (
    typeof config.pollIntervalSeconds !== "number" ||
    !Number.isFinite(config.pollIntervalSeconds) ||
    config.pollIntervalSeconds < 1
  ) {
    throw new Error(
      `Invalid config: pollIntervalSeconds must be >= 1, got ${JSON.stringify(config.pollIntervalSeconds)}`,
    );
  }
  if (
    typeof config.maxAttempts !== "number" ||
    !Number.isFinite(config.maxAttempts) ||
    config.maxAttempts < 1
  ) {
    throw new Error(
      `Invalid config: maxAttempts must be >= 1, got ${JSON.stringify(config.maxAttempts)}`,
    );
  }
  if (
    config.mergeStrategy !== "cherry-pick" &&
    config.mergeStrategy !== "no-ff" &&
    config.mergeStrategy !== "ff-only"
  ) {
    throw new Error(
      `Invalid config: mergeStrategy must be "cherry-pick", "no-ff", or "ff-only", got ${JSON.stringify(config.mergeStrategy)}`,
    );
  }
  if (typeof config.repoPath !== "string" || config.repoPath.length === 0) {
    throw new Error(`Invalid config: repoPath must be a non-empty string`);
  }
  if (typeof config.mainBranch !== "string" || config.mainBranch.length === 0) {
    throw new Error(`Invalid config: mainBranch must be a non-empty string`);
  }
  if (
    typeof config.integrationBaseBranch !== "string" ||
    config.integrationBaseBranch.length === 0
  ) {
    throw new Error(`Invalid config: integrationBaseBranch must be a non-empty string`);
  }
  if (typeof config.prBaseBranch !== "string" || config.prBaseBranch.length === 0) {
    throw new Error(`Invalid config: prBaseBranch must be a non-empty string`);
  }
}
