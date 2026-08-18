import {
  buildWindowsProcessTreeTerminationArgv,
  runBoundedProcess,
  terminateProcessTree,
  type BoundedProcessResult,
  type BoundedProcessSpawner,
  type BoundedSubprocess,
} from "../../../packages/shared/src/bounded_process.js";

export type ScmSubprocess = BoundedSubprocess;
export type ScmProcessSpawner = BoundedProcessSpawner;
export type { BoundedProcessResult };

export const buildWindowsScmProcessTreeTerminationArgv = buildWindowsProcessTreeTerminationArgv;

export async function terminateScmProcessTree(
  proc: ScmSubprocess,
  options: {
    platform?: NodeJS.Platform;
    spawn?: ScmProcessSpawner;
    terminationTimeoutMs?: number;
  } = {},
): Promise<void> {
  await terminateProcessTree(proc, options);
}

export async function runBoundedScmProcess(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Blob | "ignore";
    stdout?: "pipe" | "ignore";
    stderr?: "pipe" | "ignore";
    timeoutMs: number;
    outputLimitBytes?: number;
    streamDrainTimeoutMs?: number;
    platform?: NodeJS.Platform;
    spawn?: ScmProcessSpawner;
    terminate?: (proc: ScmSubprocess) => Promise<void>;
  },
): Promise<BoundedProcessResult> {
  return runBoundedProcess(argv, options);
}
