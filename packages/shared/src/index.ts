/**
 * Shared utilities package
 */

export { detectRepoRoot, getRepoContext } from "./repo.js";
export { CommunicationManager, type CommunicationManagerOptions } from "./communication.js";
export { loadPromptTemplate } from "./prompts.js";
export {
  loadPushPalsConfig,
  type PushPalsConfig,
  type PushPalsLlmConfig,
  type PushPalsLmStudioConfig,
} from "./config.js";
