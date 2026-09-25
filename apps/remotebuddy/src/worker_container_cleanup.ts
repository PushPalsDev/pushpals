import {
  runBoundedProcess,
  terminateProcessTree,
  WORKER_STARTUP_CLEANUP_GRACE_MS,
  type BoundedProcessResult,
} from "shared";

const OWNED_COMPONENTS = ["workerpals-warm", "workerpals-selfcheck"] as const;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAX_OWNED_CONTAINERS = 64;
const COMMAND_TIMEOUT_MS = 3_000;
const INSPECT_OWNERSHIP_FORMAT = '{"Id":{{json .Id}},"Labels":{{json .Config.Labels}}}';

export type WorkerContainerCleanupOptions = {
  run?: typeof runBoundedProcess;
  timeoutMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function completeCapture(result: BoundedProcessResult): boolean {
  return (
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    result.timedOut === false &&
    result.drainTimedOut === false &&
    result.stdoutTruncated === false &&
    result.stderrTruncated === false &&
    result.stdoutDecodeError === false &&
    result.stderrDecodeError === false &&
    result.stdoutReadError !== true &&
    result.stderrReadError !== true
  );
}

function onlyAlreadyAbsentErrors(result: BoundedProcessResult, ids: Set<string>): boolean {
  if (!completeCapture(result) || result.exitCode === 0 || !result.stderr.trim()) return false;
  return result.stderr
    .trim()
    .split(/\r?\n/)
    .every((line) => {
      const match =
        /^Error(?: response from daemon)?: No such (?:container|object): ([a-f0-9]{64})$/.exec(
          line.trim(),
        );
      return match !== null && ids.has(match[1]);
    });
}

/**
 * Call only after the worker process tree has stopped creating containers.
 * Names are never deletion authority: both discovery and explicit-ID inspection
 * must match all ownership labels. Any uncertainty fences replacement workers.
 */
export async function cleanupOwnedWorkerContainers(
  repo: string,
  workerId: string,
  options: WorkerContainerCleanupOptions = {},
): Promise<boolean> {
  if (!repo.trim() || /[\0\r\n]/.test(repo) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(workerId))
    return false;
  const requestedTimeoutMs = options.timeoutMs ?? WORKER_STARTUP_CLEANUP_GRACE_MS;
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) return false;
  const timeoutMs = Math.min(WORKER_STARTUP_CLEANUP_GRACE_MS, Math.floor(requestedTimeoutMs));
  const now = options.now ?? Date.now;
  const deadlineMs = now() + timeoutMs;
  const run = options.run ?? runBoundedProcess;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const docker =
    String(env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "").trim() ||
    String(env.PUSHPALS_DOCKER_BIN ?? "").trim() ||
    (platform === "win32" ? "docker.exe" : "docker");
  const controller = new AbortController();
  const withinBudget = () => !controller.signal.aborted && now() < deadlineMs;
  const command = async (args: string[]): Promise<BoundedProcessResult | null> => {
    if (!withinBudget()) return null;
    try {
      const result = await run([docker, ...args], {
        timeoutMs: Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadlineMs - now())),
        outputLimitBytes: 64 * 1024,
        streamDrainTimeoutMs: 250,
        signal: controller.signal,
        ...(options.env ? { env: options.env } : {}),
        platform,
        terminate: (proc) =>
          terminateProcessTree(proc, {
            platform,
            terminationTimeoutMs: 500,
            exitGraceMs: 250,
          }),
      });
      return withinBudget() && completeCapture(result) ? result : null;
    } catch {
      return null;
    }
  };
  const listOwned = async (): Promise<Map<string, string> | null> => {
    const found = new Map<string, string>();
    for (const component of OWNED_COMPONENTS) {
      const result = await command([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=pushpals.repo=${repo}`,
        "--filter",
        `label=pushpals.worker_id=${workerId}`,
        "--filter",
        `label=pushpals.component=${component}`,
      ]);
      if (!result || result.exitCode !== 0) return null;
      const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
      for (const line of lines) {
        const id = line.trim();
        if (!CONTAINER_ID.test(id) || found.has(id) || found.size >= MAX_OWNED_CONTAINERS)
          return null;
        found.set(id, component);
      }
    }
    return withinBudget() ? found : null;
  };
  const verifyEmpty = async () => (await listOwned())?.size === 0 && withinBudget();
  const cleanup = async (): Promise<boolean> => {
    const owned = await listOwned();
    if (!owned) return false;
    if (owned.size === 0) return withinBudget();
    const ids = Array.from(owned.keys());
    const inspection = await command([
      "container",
      "inspect",
      "--format",
      INSPECT_OWNERSHIP_FORMAT,
      ...ids,
    ]);
    if (!inspection) return false;
    if (inspection.exitCode !== 0) {
      return onlyAlreadyAbsentErrors(inspection, new Set(ids)) ? verifyEmpty() : false;
    }
    const lines = inspection.stdout.trim().split(/\r?\n/);
    if (lines.length !== ids.length) return false;
    const verified = new Set<string>();
    for (const line of lines) {
      let item: unknown;
      try {
        item = JSON.parse(line);
      } catch {
        return false;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const { Id: id, Labels: labels } = item as Record<string, unknown>;
      if (
        typeof id !== "string" ||
        !owned.has(id) ||
        verified.has(id) ||
        !labels ||
        typeof labels !== "object" ||
        Array.isArray(labels)
      )
        return false;
      const ownership = labels as Record<string, unknown>;
      if (
        ownership["pushpals.repo"] !== repo ||
        ownership["pushpals.worker_id"] !== workerId ||
        ownership["pushpals.component"] !== owned.get(id)
      )
        return false;
      verified.add(id);
    }
    const removal = await command(["rm", "-f", ...ids]);
    if (!removal || (removal.exitCode !== 0 && !onlyAlreadyAbsentErrors(removal, verified)))
      return false;
    return verifyEmpty();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The outer deadline also bounds a stalled injected runner or cancellation.
    // A late runner cannot launch another command after this abort fires.
    return await Promise.race([
      cleanup().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
