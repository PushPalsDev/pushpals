import {
  summarizePreflightFailure,
  toDependencySnapshot,
  type DependencySnapshot,
  type PreflightCheckResult,
  type PreflightReport,
} from "./preflight.js";

type DependencyPreflightState =
  | { ok: true; report: PreflightReport }
  | { ok: false; report: PreflightReport; failed: PreflightCheckResult[] };

export interface DependencyPreflightCacheLike {
  healthy: () => Promise<DependencyPreflightState>;
}

export type AssistantMessenger = {
  assistantMessage: (
    text: string,
    meta: { turnId: string; correlationId: string },
  ) => Promise<void>;
};

export async function ensureDependencySnapshot(
  cache: DependencyPreflightCacheLike,
  onFailure: (report: PreflightReport) => Promise<void>,
): Promise<DependencySnapshot | null> {
  const state = await cache.healthy();
  if (!state.ok) {
    await onFailure(state.report);
    return null;
  }
  return toDependencySnapshot(state.report);
}

export async function notifyDependencyPreflightBlock(opts: {
  requestId: string;
  turnId: string;
  report: PreflightReport;
  comm: AssistantMessenger;
  server: string;
  authHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  remember: (kind: string, summary: string, requestId: string | null) => void;
  logger?: Pick<typeof console, "error">;
}): Promise<void> {
  const summary = summarizePreflightFailure(opts.report);
  const message = `Cannot dispatch a WorkerPal yet because startup prerequisites failed. ${summary} Run \`bun run remotebuddy:preflight --json\` for the full checklist.`;
  const logger = opts.logger ?? console;
  logger.error(`[RemoteBuddy] Dependency preflight blocked request ${opts.requestId}: ${summary}`);
  await opts.comm.assistantMessage(message, {
    turnId: opts.turnId,
    correlationId: opts.requestId,
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  await fetchImpl(`${opts.server}/requests/${opts.requestId}/fail`, {
    method: "POST",
    headers: opts.authHeaders(),
    body: JSON.stringify({
      message: "RemoteBuddy blocked by dependency preflight",
      detail: summary,
    }),
  }).catch(() => {});
  opts.remember("dependency_block", summary, opts.requestId);
}
