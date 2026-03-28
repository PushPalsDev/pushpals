import { resolve } from "path";
import { loadPushPalsConfig, type PushPalsConfig } from "../../../packages/shared/src/config.js";
import { resolveLocalServerConnection } from "../../../packages/shared/src/local_network.js";

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

type LoadConfigOptions = {
  reload?: boolean;
};

function buildDefaults(options: LoadConfigOptions = {}): SourceControlManagerConfig {
  const pushConfig = loadPushPalsConfig({ reload: options.reload });
  const defaultLocalServer = resolveLocalServerConnection({
    serverUrl: pushConfig.server.url,
    authToken: pushConfig.authToken,
    fallbackPort: pushConfig.server.port,
  });

  return {
    repoPath: resolve(pushConfig.sourceControlManager.repoPath),
    serverUrl: defaultLocalServer.serverUrl,
    remote: pushConfig.sourceControlManager.remote,
    mainBranch: pushConfig.sourceControlManager.mainBranch,
    integrationBaseBranch: pushConfig.sourceControlManager.baseBranch,
    branchPrefix: pushConfig.sourceControlManager.branchPrefix,
    pollIntervalSeconds: pushConfig.sourceControlManager.pollIntervalSeconds,
    checks: pushConfig.sourceControlManager.checks.map((check) => ({ ...check })),
    stateDir: resolve(pushConfig.sourceControlManager.stateDir),
    port: pushConfig.sourceControlManager.port,
    deleteAfterMerge: pushConfig.sourceControlManager.deleteAfterMerge,
    maxAttempts: pushConfig.sourceControlManager.maxAttempts,
    mergeStrategy: pushConfig.sourceControlManager.mergeStrategy,
    pushMainAfterMerge: pushConfig.sourceControlManager.pushMainAfterMerge,
    openPrAfterPush: pushConfig.sourceControlManager.openPrAfterPush,
    prBaseBranch: pushConfig.sourceControlManager.prBaseBranch,
    prTitle: pushConfig.sourceControlManager.prTitle,
    prBody: pushConfig.sourceControlManager.prBody,
    prDraft: pushConfig.sourceControlManager.prDraft,
    authToken: undefined,
    gitToken: pushConfig.gitToken,
    statusHeartbeatMs: pushConfig.sourceControlManager.statusHeartbeatMs,
    skipCleanCheck: pushConfig.sourceControlManager.skipCleanCheck,
    autoCreateMainBranch: pushConfig.sourceControlManager.autoCreateMainBranch,
    reviewAgent: { ...pushConfig.sourceControlManager.reviewAgent },
  };
}

/**
 * Load SourceControlManager config strictly from shared PushPals config.
 */
export function loadConfig(options: LoadConfigOptions = {}): SourceControlManagerConfig {
  const defaults = buildDefaults(options);
  return {
    ...defaults,
    checks: defaults.checks.map((check) => ({ ...check })),
    reviewAgent: {
      ...defaults.reviewAgent,
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

  const pushConfig = loadPushPalsConfig();
  const resolved = resolveLocalServerConnection({
    serverUrl: merged.serverUrl,
    authToken: merged.authToken ?? null,
    fallbackPort: pushConfig.server.port,
  });
  merged.serverUrl = resolved.serverUrl;
  merged.authToken = undefined;

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
    typeof config.reviewAgent.maxPrCommentsBeforeGiveUp !== "number" ||
    !Number.isFinite(config.reviewAgent.maxPrCommentsBeforeGiveUp) ||
    config.reviewAgent.maxPrCommentsBeforeGiveUp < 1 ||
    config.reviewAgent.maxPrCommentsBeforeGiveUp > 100
  ) {
    throw new Error(
      `Invalid config: reviewAgent.maxPrCommentsBeforeGiveUp must be between 1 and 100, got ${JSON.stringify(config.reviewAgent.maxPrCommentsBeforeGiveUp)}`,
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
