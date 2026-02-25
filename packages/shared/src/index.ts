/**
 * Shared utilities package
 */

export { detectRepoRoot, getRepoContext } from "./repo.js";
export { CommunicationManager, type CommunicationManagerOptions } from "./communication.js";
export { loadPromptTemplate } from "./prompts.js";
export {
  inferGitBackendFromRemote,
  parseGitHubRepo,
  parseGitRemoteHost,
  resolveGitTokenForRemote,
  sanitizeGitRemoteUrl,
  toGitHubRepoWebUrl,
  type CommandCaptureResult,
  type GitBackendId,
  type GitHubRepoRef,
  type GitTokenResolution,
  type GitTokenSource,
  type ResolveGitTokenOptions,
} from "./git_backend.js";
export {
  loadPushPalsConfig,
  sanitizePushPalsConfigForLogging,
  type PushPalsConfig,
  type PushPalsLlmConfig,
  type PushPalsLmStudioConfig,
} from "./config.js";
export {
  resolveRuntimeArgs,
  ensureSessionWithRetry,
  bootstrapRuntime,
  extractForwardedArgs,
  type RuntimeArgDefaults,
  type RuntimeArgResolution,
  type ResolveRuntimeArgsOptions,
  type EnsureSessionOptions,
  type BootstrapRuntimeOptions,
  type BootstrapRuntimeResult,
} from "./runtime.js";
export {
  classifyGlobBreadth,
  componentRootPrefix,
  containsGlobMeta,
  globBreadthScore,
  literalPrefix,
  makePatternKey,
  matchesGlob,
  normalizePenalties,
  normalizeRepoRelativePath,
  normalizeTargetPath,
  normalizeWriteGlob,
  penaltyTotal,
  validateScopeInvariants,
  type AutonomyComponentArea,
  type AutonomyGlobBreadth,
  type AutonomyObjectiveType,
  type AutonomyPenalty,
  type AutonomyPenaltyKind,
  type AutonomyRiskLevel,
  type ScopeValidationResult,
} from "./autonomy_policy.js";
export {
  loadWorkerRuntimeOptions,
  resolveWorkerRuntimeDefaults,
  loadRemoteBuddyRuntimeOptions,
  resolveRemoteBuddyRuntimeDefaults,
  loadLocalBuddyRuntimeOptions,
  resolveLocalBuddyRuntimeDefaults,
  RuntimeCliError,
  type WorkerRuntimeDefaults,
  type WorkerRuntimeOptions,
  type RemoteBuddyRuntimeDefaults,
  type RemoteBuddyRuntimeOptions,
  type LocalBuddyRuntimeDefaults,
  type LocalBuddyRuntimeOptions,
} from "./runtime_options.js";
export {
  ensureSessionExists,
  connectSessionWithRetry,
  SessionConnectionAbortedError,
  type EnsureSessionOptions,
  type ConnectSessionWithRetryOptions,
  type SessionRetryNotice,
} from "./session.js";
export {
  computeTimeoutWarningWindow,
  DEFAULT_DOCKER_TIMEOUT_MS,
  DEFAULT_OPENHANDS_TIMEOUT_MS,
  parseDockerTimeoutMs,
  parseOpenHandsTimeoutMs,
} from "./timeout_policy.js";
