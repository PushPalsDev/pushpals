import { resolve } from "path";
import { loadPushPalsConfig, type PushPalsConfig } from "../../../packages/shared/src/config.js";

export type ReviewAgentConfig = PushPalsConfig["sourceControlManager"]["reviewAgent"];
type SharedSourceControlManagerConfig = PushPalsConfig["sourceControlManager"];

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
export interface SourceControlManagerConfig
  extends Omit<SharedSourceControlManagerConfig, "baseBranch" | "reviewAgent" | "checks"> {
  /** PushPals server URL. */
  serverUrl: string;
  /** Base branch used for integration bootstrap/sync. */
  integrationBaseBranch: string;
  /** Ordered list of checks to run on the temp branch after merge, before pushing. */
  checks: CheckConfig[];
  /** Authentication token for server API calls. */
  authToken?: string;
  /** Git token for authenticated git push/fetch. */
  gitToken?: string | null;
  /** ReviewAgent configuration. */
  reviewAgent: ReviewAgentConfig;
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
  checks: PUSH_CONFIG.sourceControlManager.checks.map((check) => ({ ...check })),
  stateDir: resolve(PUSH_CONFIG.sourceControlManager.stateDir),
  port: PUSH_CONFIG.sourceControlManager.port,
  deleteAfterMerge: PUSH_CONFIG.sourceControlManager.deleteAfterMerge,
  maxAttempts: PUSH_CONFIG.sourceControlManager.maxAttempts,
  mergeStrategy: PUSH_CONFIG.sourceControlManager.mergeStrategy,
  pushMainAfterMerge: PUSH_CONFIG.sourceControlManager.pushMainAfterMerge,
  openPrAfterPush: PUSH_CONFIG.sourceControlManager.openPrAfterPush,
  prBaseBranch: PUSH_CONFIG.sourceControlManager.prBaseBranch,
  prTitle: PUSH_CONFIG.sourceControlManager.prTitle,
  prBody: PUSH_CONFIG.sourceControlManager.prBody,
  prDraft: PUSH_CONFIG.sourceControlManager.prDraft,
  authToken: PUSH_CONFIG.authToken ?? undefined,
  gitToken: PUSH_CONFIG.gitToken,
  statusHeartbeatMs: PUSH_CONFIG.sourceControlManager.statusHeartbeatMs,
  skipCleanCheck: PUSH_CONFIG.sourceControlManager.skipCleanCheck,
  autoCreateMainBranch: PUSH_CONFIG.sourceControlManager.autoCreateMainBranch,
  reviewAgent: PUSH_CONFIG.sourceControlManager.reviewAgent,
};

/**
 * Load SourceControlManager config strictly from shared PushPals config.
 */
export function loadConfig(): SourceControlManagerConfig {
  return {
    ...DEFAULTS,
    checks: DEFAULTS.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...DEFAULTS.reviewAgent,
    },
  };
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
  if (
    typeof config.reviewAgent.pollIntervalMs !== "number" ||
    !Number.isFinite(config.reviewAgent.pollIntervalMs) ||
    config.reviewAgent.pollIntervalMs < 5_000
  ) {
    throw new Error(
      `Invalid config: reviewAgent.pollIntervalMs must be >= 5000, got ${JSON.stringify(config.reviewAgent.pollIntervalMs)}`,
    );
  }
  if (
    typeof config.reviewAgent.passThreshold !== "number" ||
    !Number.isFinite(config.reviewAgent.passThreshold) ||
    config.reviewAgent.passThreshold < 1 ||
    config.reviewAgent.passThreshold > 10
  ) {
    throw new Error(
      `Invalid config: reviewAgent.passThreshold must be between 1 and 10, got ${JSON.stringify(config.reviewAgent.passThreshold)}`,
    );
  }
  if (
    config.reviewAgent.mergeMethod !== "squash" &&
    config.reviewAgent.mergeMethod !== "merge" &&
    config.reviewAgent.mergeMethod !== "rebase"
  ) {
    throw new Error(
      `Invalid config: reviewAgent.mergeMethod must be \"squash\", \"merge\", or \"rebase\", got ${JSON.stringify(config.reviewAgent.mergeMethod)}`,
    );
  }
  if (
    typeof config.reviewAgent.codexTimeoutMs !== "number" ||
    !Number.isFinite(config.reviewAgent.codexTimeoutMs) ||
    config.reviewAgent.codexTimeoutMs < 30_000
  ) {
    throw new Error(
      `Invalid config: reviewAgent.codexTimeoutMs must be >= 30000, got ${JSON.stringify(config.reviewAgent.codexTimeoutMs)}`,
    );
  }
}
