/**
 * Shared utilities package
 */

export {
  detectRepoRoot,
  findGitRepoRoot,
  getRepoContext,
  resolveGitMetadataDir,
  resolveGitStateFilePath,
} from "./repo.js";
export { CommunicationManager, type CommunicationManagerOptions } from "./communication.js";
export { loadPromptTemplate, loadRepoDocText } from "./prompts.js";
export {
  evaluateClientRuntimePreflight,
  formatClientRuntimePreflightLines,
  type ClientPreflightCopyCommands,
  type ClientPreflightIssue,
  type ClientRuntimePreflightResult,
} from "./client_preflight.js";
export {
  extractVisionKeyItems,
  normalizeVisionSectionRef,
  normalizeVisionSectionRefs,
  parseVisionDoc,
  validateVisionDocStructure,
  type ParsedVisionDoc,
  type VisionDocValidation,
  type VisionKeyItems,
  type VisionSection,
} from "./vision.js";
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
  DEFAULT_WORKERPALS_EXECUTOR,
  invalidatePushPalsConfigCache,
  loadPushPalsConfig,
  sanitizePushPalsConfigForLogging,
  type PushPalsConfig,
  type PushPalsLlmConfig,
  type PushPalsLmStudioConfig,
} from "./config.js";
export {
  buildLocalCorsHeaders,
  isLoopbackOrigin,
  isLoopbackHost,
  normalizeLoopbackHost,
  normalizeLoopbackHttpUrl,
  resolveLocalServerConnection,
} from "./local_network.js";
export {
  isHeartbeatStatusSessionEvent,
  shouldDisplayInteractiveSessionEvent,
} from "./session_event_visibility.js";
export {
  DEFAULT_LOCALBUDDY_PORT,
  computeLocalBuddyRestartBackoffMs,
  loadLocalBuddyRuntimeSnapshotFromFiles,
  parseLocalBuddyRuntimeSnapshot,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  type LocalBuddyRuntimeAction,
  type LocalBuddyRuntimeSnapshot,
  type LocalBuddyStartGateReason,
} from "./localbuddy_runtime.js";
export {
  classifyGlobBreadth,
  componentRootPrefix,
  containsGlobMeta,
  deriveAutonomyComponentArea,
  globBreadthScore,
  literalPrefix,
  makePatternKey,
  matchesGlob,
  normalizeAutonomyComponentArea,
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
