import {
  runStartupPreflight,
  type StartupChecklistOptions,
  type StartupChecklistResult,
  type StartupCheckRecord,
} from "./checklist";
import {
  createSystemStartupContext,
  type SystemStartupContextOptions,
} from "./system_preflight";

export interface RemoteBuddyStartupGuardOptions {
  repoRoot: string;
  serverUrl: string;
  authToken: string | null;
  allowDirtyWorktree?: boolean;
  syntheticMaxLatencyMs?: number;
  syntheticProbeName?: string;
  skip?: boolean;
  log?: (entry: StartupCheckRecord) => void;
  contextOverrides?: RemoteBuddyStartupGuardContextOverrides;
}

type RemoteBuddyStartupGuardContextOverrides = Partial<
  Omit<SystemStartupContextOptions, "repoRoot" | "serverUrl" | "authToken">
>;

export type RemoteBuddyStartupGuardResult = StartupChecklistResult;

export async function runRemoteBuddyStartupGuard(
  options: RemoteBuddyStartupGuardOptions,
): Promise<RemoteBuddyStartupGuardResult> {
  if (options.skip) {
    return { ok: true, history: [] };
  }

  const context = createSystemStartupContext({
    repoRoot: options.repoRoot,
    serverUrl: options.serverUrl,
    authToken: options.authToken,
    fetchImpl: options.contextOverrides?.fetchImpl,
    now: options.contextOverrides?.now,
    log: options.log ?? options.contextOverrides?.log,
    describeRepo: options.contextOverrides?.describeRepo,
    listFiringAlerts: options.contextOverrides?.listFiringAlerts,
    syntheticTester: options.contextOverrides?.syntheticTester,
  });

  const checklistOptions: StartupChecklistOptions = {
    allowDirtyWorktree: options.allowDirtyWorktree ?? false,
    syntheticMaxLatencyMs: options.syntheticMaxLatencyMs,
    syntheticProbeName: options.syntheticProbeName,
  };

  return runStartupPreflight(context, checklistOptions);
}
