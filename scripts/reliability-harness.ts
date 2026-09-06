import { copyEnvWithoutScmRepairAuthoritySecret } from "../packages/shared/src/scm_repair_authority.js";

type HarnessPhase = {
  name: string;
  files: string[];
  timeoutMs: number;
  command?: string[];
};

type HarnessEvent = {
  event: "phase_started" | "phase_completed" | "harness_completed";
  harness: "pushpals_reliability";
  phase?: string;
  files?: string[];
  durationMs?: number;
  exitCode?: number;
  ok?: boolean;
  passedPhases?: number;
  totalPhases?: number;
  timedOut?: boolean;
  terminationSettled?: boolean;
  observedAt: string;
};

const phases: HarnessPhase[] = [
  {
    name: "repository_intelligence",
    files: [
      "tests/shared.repository-agent-client.test.ts",
      "tests/shared.repository-snapshot.test.ts",
      "tests/shared.memory.test.ts",
      "tests/memory-store-conformance.test.ts",
      "tests/server.repository-agent-queue.test.ts",
      "tests/server.repository-agent-context.test.ts",
      "tests/server.memory-repository-agent-routes.test.ts",
      "tests/remotebuddy.repository-agent.test.ts",
      "tests/remotebuddy.llm-repository-context.test.ts",
      "tests/remotebuddy.autonomous-engine.tick.test.ts",
    ],
    timeoutMs: 300_000,
  },
  {
    name: "failure_evidence",
    files: [
      "tests/shared.trusted-validation-evidence.test.ts",
      "tests/client.pushpals-api.test.ts",
      "tests/server.completions-queue.test.ts",
      "tests/source-control-manager.trusted-validation.test.ts",
      "tests/workerpals.session-events.test.ts",
    ],
    timeoutMs: 120_000,
  },
  {
    name: "durable_lifecycle",
    files: [
      "tests/server.autonomy-store.test.ts",
      "tests/server.lifecycle-reconciliation.test.ts",
      "tests/server.job-diagnostics.test.ts",
      "tests/server.jobs.stale-recovery.test.ts",
      "tests/server.jobs-repair-scheduling.test.ts",
      "tests/server.requests-queue.test.ts",
      "tests/server.session-message-route.test.ts",
      "tests/remotebuddy.task-dedupe.test.ts",
    ],
    timeoutMs: 180_000,
  },
  {
    name: "repair_orchestration",
    files: [
      "tests/remotebuddy.autonomous-engine.tick.test.ts",
      "tests/source-control-manager.bounded-process.test.ts",
      "tests/source-control-manager.completion-callback.test.ts",
      "tests/source-control-manager.completion-gc.test.ts",
      "tests/source-control-manager.completion-lease.test.ts",
      "tests/source-control-manager.integration-maintenance.test.ts",
      "tests/source-control-manager.publication-recovery.test.ts",
      "tests/source-control-manager.review-agent.test.ts",
      "tests/source-control-manager.validation-repair-publication.test.ts",
      "tests/workerpals.review-fix-branch.test.ts",
      "tests/workerpals.worktree-base-ref.test.ts",
    ],
    timeoutMs: 120_000,
  },
  {
    name: "quality_loop",
    files: [
      "tests/workerpals.execute-job-clarification.test.ts",
      "tests/workerpals.quality-gate-issues.test.ts",
      "tests/workerpals.quality-loop-durability.test.ts",
      "tests/workerpals.docker-deadline.test.ts",
      "tests/workerpals.commit-message-generation.test.ts",
      "tests/workerpals.validation-command-safety.test.ts",
      "tests/workerpals.job-runner.test.ts",
      "tests/workerpals.generic-python-executor.test.ts",
      "tests/workerpals.session-events.test.ts",
    ],
    timeoutMs: 300_000,
  },
  {
    name: "worker_watchdog",
    files: ["apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py"],
    command: [
      process.env.PYTHON?.trim() || "python",
      "-u",
      "apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py",
    ],
    timeoutMs: 300_000,
  },
  {
    name: "runtime_boundary",
    files: [
      "tests/workerpals.docker-executor.test.ts",
      "tests/workerpals.job-result-transport.test.ts",
      "tests/workerpals.worktree-boundary.test.ts",
      "tests/workerpals.http-deadline.test.ts",
      "tests/workerpals.server-transport.test.ts",
      "tests/bounded-line-buffer.test.ts",
      "tests/shared.bounded-fetch.test.ts",
      "tests/shared.bounded-process.test.ts",
      "tests/shared.scm-repair-authority.test.ts",
      "tests/workerpals.bounded-process.test.ts",
      "tests/shared.communication.test.ts",
      "tests/workerpals.generic-python-executor.test.ts",
      "tests/workerpals.packaged-generic-python-executor.test.ts",
      "apps/localbuddy/src/http_deadlines.test.ts",
      "tests/cli.http-deadline.test.ts",
      "tests/cli.runtime-bootstrap.test.ts",
      "tests/cli.sse-buffer.test.ts",
      "tests/client.http-deadline.test.ts",
      "tests/vscode.http-deadline.test.ts",
      "tests/vscode.bounded-process.test.ts",
      "tests/start.runtime-services.test.ts",
      "tests/remotebuddy.llm-codex.test.ts",
      "tests/workerpals.validation-command-safety.test.ts",
      "tests/workerpals.sandbox-env.test.ts",
      "tests/workerpals.runtime-sandbox-mirror.test.ts",
      "tests/release-package-payload.test.ts",
      "tests/release-workflow-actions.test.ts",
      "tests/reliability-harness.test.ts",
    ],
    timeoutMs: 360_000,
  },
];

export function listReliabilityHarnessPhaseFiles(phaseName: string): string[] {
  return [...(phases.find((phase) => phase.name === phaseName)?.files ?? [])];
}

function emit(event: Omit<HarnessEvent, "harness" | "observedAt">): void {
  console.log(
    `[ReliabilityHarness] ${JSON.stringify({
      ...event,
      harness: "pushpals_reliability",
      observedAt: new Date().toISOString(),
    })}`,
  );
}

async function runPhase(phase: HarnessPhase): Promise<{ ok: boolean; durationMs: number }> {
  emit({ event: "phase_started", phase: phase.name, files: phase.files });
  const startedAt = Date.now();
  const processHandle = Bun.spawn(phase.command ?? [process.execPath, "test", ...phase.files], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...copyEnvWithoutScmRepairAuthoritySecret(process.env),
      PUSHPALS_RELIABILITY_HARNESS: "1",
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    processHandle.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
    new Promise<{ exitCode: number; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ exitCode: 124, timedOut: true }), phase.timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  let terminationSettled: boolean | undefined;
  if (outcome.timedOut) {
    terminationSettled = await terminateHarnessProcessTree(processHandle);
  }
  const exitCode = outcome.timedOut && terminationSettled === false ? 125 : outcome.exitCode;
  const durationMs = Date.now() - startedAt;
  emit({
    event: "phase_completed",
    phase: phase.name,
    files: phase.files,
    durationMs,
    exitCode,
    ok: exitCode === 0,
    timedOut: outcome.timedOut,
    ...(typeof terminationSettled === "boolean" ? { terminationSettled } : {}),
  });
  return { ok: exitCode === 0, durationMs };
}

type HarnessProcessHandle = {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: any) => void;
};

type HarnessSpawn = (
  argv: string[],
  options: { stdout: "ignore"; stderr: "ignore" },
) => HarnessProcessHandle;

async function settleHarnessExit(
  promise: Promise<number>,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.catch(() => -1),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildHarnessWindowsTreeKillArgv(pid: number): string[] {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}

export async function terminateHarnessProcessTree(
  processHandle: HarnessProcessHandle,
  options: {
    platform?: string;
    spawn?: HarnessSpawn;
    graceMs?: number;
    killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const graceMs = Math.max(1, options.graceMs ?? 5_000);
  if (platform === "win32" && Number.isFinite(processHandle.pid) && processHandle.pid > 0) {
    try {
      const killer = spawn(buildHarnessWindowsTreeKillArgv(processHandle.pid), {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await settleHarnessExit(killer.exited, graceMs)) === null) {
        try {
          killer.kill("SIGKILL");
        } catch {
          // best effort; the target process check below is authoritative
        }
      }
      if ((await settleHarnessExit(processHandle.exited, graceMs)) !== null) return true;
    } catch {
      // Fall through to direct termination, preserving a bounded deadline.
    }
  } else {
    const killGroup =
      options.killGroup ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
    try {
      killGroup(processHandle.pid, "SIGTERM");
    } catch {
      try {
        processHandle.kill("SIGTERM");
      } catch {
        return (await settleHarnessExit(processHandle.exited, graceMs)) !== null;
      }
    }
    if ((await settleHarnessExit(processHandle.exited, graceMs)) !== null) return true;
    try {
      killGroup(processHandle.pid, "SIGKILL");
    } catch {
      try {
        processHandle.kill("SIGKILL");
      } catch {
        // It may have exited between the bounded checks.
      }
    }
    return (await settleHarnessExit(processHandle.exited, graceMs)) !== null;
  }
  try {
    processHandle.kill("SIGKILL");
  } catch {
    // It may have exited between the bounded checks.
  }
  return (await settleHarnessExit(processHandle.exited, graceMs)) !== null;
}

export async function runReliabilityHarness(): Promise<number> {
  const harnessStartedAt = Date.now();
  let passedPhases = 0;
  for (const phase of phases) {
    const result = await runPhase(phase);
    if (!result.ok) {
      emit({
        event: "harness_completed",
        ok: false,
        exitCode: 1,
        durationMs: Date.now() - harnessStartedAt,
        passedPhases,
        totalPhases: phases.length,
      });
      return 1;
    }
    passedPhases += 1;
  }

  emit({
    event: "harness_completed",
    ok: true,
    exitCode: 0,
    durationMs: Date.now() - harnessStartedAt,
    passedPhases,
    totalPhases: phases.length,
  });
  return 0;
}

if (import.meta.main) {
  process.exit(await runReliabilityHarness());
}
