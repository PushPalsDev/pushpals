export interface RuntimeConfigImpact {
  restartRequiredKeys: string[];
  warnings: string[];
}

const BASE_RESTART_REQUIRED_PREFIXES = [
  "server.host",
  "server.port",
  "paths.data_dir",
  "paths.shared_db_path",
  "paths.remotebuddy_db_path",
  "source_control_manager.repo_path",
];

export function normalizeRuntimeConfigKey(raw: string): string {
  return String(raw ?? "")
    .split(".")
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean)
    .join(".");
}

function normalizeRuntimeConfigEnvAlias(raw: string): string {
  const key = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (!key) return "";
  if (key === "LOCALBUDDY_ENABLED") return "localbuddy.enabled";
  if (key === "LOCAL_AGENT_PORT") return "localbuddy.port";
  if (key === "LOCALBUDDY_STATUS_HEARTBEAT_MS") return "localbuddy.status_heartbeat_ms";
  if (!key.startsWith("LOCALBUDDY_")) return "";

  const suffix = key.slice("LOCALBUDDY_".length);
  if (!suffix) return "";
  if (suffix.startsWith("LLM_")) {
    const llmSuffix = suffix.slice("LLM_".length).toLowerCase();
    if (!llmSuffix) return "";
    return `localbuddy.llm.${llmSuffix}`;
  }
  return "";
}

export function deriveRuntimeConfigImpact(appliedKeys: string[]): RuntimeConfigImpact {
  const restartRequiredKeys: string[] = [];
  const warnings: string[] = [];

  let hasLocalBuddyEnabledMutation = false;
  let hasRestartOnlyLocalBuddyMutation = false;

  for (const rawKey of appliedKeys) {
    const normalized = normalizeRuntimeConfigEnvAlias(rawKey) || normalizeRuntimeConfigKey(rawKey);
    if (!normalized) continue;

    const needsBaseRestart = BASE_RESTART_REQUIRED_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`),
    );
    const isLocalBuddyEnabled = normalized === "localbuddy.enabled";
    const isLocalBuddyRestartOnly = normalized.startsWith("localbuddy.") && !isLocalBuddyEnabled;

    if (needsBaseRestart || isLocalBuddyRestartOnly) {
      restartRequiredKeys.push(rawKey);
    }
    if (isLocalBuddyEnabled) {
      hasLocalBuddyEnabledMutation = true;
    }
    if (isLocalBuddyRestartOnly) {
      hasRestartOnlyLocalBuddyMutation = true;
    }
  }

  if (hasLocalBuddyEnabledMutation) {
    warnings.push(
      "localbuddy.enabled applies live when the stack is managed by bun run start or the VS Code stack manager; other supervisors may require restart.",
    );
  }
  if (hasRestartOnlyLocalBuddyMutation) {
    warnings.push(
      "LocalBuddy config changes other than localbuddy.enabled require a LocalBuddy restart to take effect.",
    );
  }

  return { restartRequiredKeys, warnings };
}
