import { existsSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

const requireShared = createRequire(import.meta.url);
type SharedRuntimeModule = typeof import("shared");
let cachedSharedModule: SharedRuntimeModule | null = null;

function isSharedResolutionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  if (typeof err.code === "string" && ["ENOENT", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(err.code)) {
    return true;
  }
  if (typeof err.message === "string" && err.message.includes("node_modules/shared")) {
    return true;
  }
  return false;
}

function loadSharedRuntime(): SharedRuntimeModule {
  if (cachedSharedModule) return cachedSharedModule;
  try {
    cachedSharedModule = requireShared("shared") as SharedRuntimeModule;
    return cachedSharedModule;
  } catch (error) {
    if (!isSharedResolutionError(error)) {
      throw error;
    }
  }
  const fallbackPath = resolve(process.cwd(), "packages/shared/src/index.ts");
  if (!existsSync(fallbackPath)) {
    throw new Error(
      `Shared runtime fallback missing at ${fallbackPath}. Run bun install or ensure workspace packages are available.`,
    );
  }
  cachedSharedModule = requireShared(fallbackPath) as SharedRuntimeModule;
  return cachedSharedModule;
}

const sharedRuntime = loadSharedRuntime();

export const {
  CommunicationManager,
  componentRootPrefix,
  detectRepoRoot,
  extractVisionKeyItems,
  loadPromptTemplate,
  loadPushPalsConfig,
  loadRepoDocText,
  makePatternKey,
  matchesGlob,
  normalizePenalties,
  normalizeTargetPath,
  normalizeVisionSectionRefs,
  normalizeWriteGlob,
  penaltyTotal,
  parseVisionDoc,
  sanitizePushPalsConfigForLogging,
  validateScopeInvariants,
} = sharedRuntime;

export type {
  AutonomyComponentArea,
  AutonomyObjectiveType,
  CommunicationManager,
  PushPalsConfig,
  PushPalsLmStudioConfig,
} from "shared";

export function getSharedRuntime(): SharedRuntimeModule {
  return sharedRuntime;
}
