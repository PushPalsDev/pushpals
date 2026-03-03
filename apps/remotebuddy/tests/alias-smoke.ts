import { PROTOCOL_VERSION } from "protocol";
import {
  loadPushPalsConfig,
  matchesGlob,
  normalizeTargetPath,
  sanitizePushPalsConfigForLogging,
  type PushPalsConfig,
} from "shared";

function formatConfigSummary(config: PushPalsConfig): string {
  const sanitized = sanitizePushPalsConfigForLogging(config);
  return `${Object.keys(sanitized).length}keys`;
}

export function runRemotebuddyAliasSmoke(config: PushPalsConfig): string {
  const repoHit = matchesGlob("apps/remotebuddy", "apps/**");
  const normalized = normalizeTargetPath("apps/remotebuddy/src");
  const summary = formatConfigSummary(config);
  return `[RemoteBuddyAliasSmoke] protocol=${PROTOCOL_VERSION} glob=${repoHit} normalized=${normalized} config=${summary}`;
}

if (import.meta.main) {
  const config = loadPushPalsConfig();
  console.log(runRemotebuddyAliasSmoke(config));
}
