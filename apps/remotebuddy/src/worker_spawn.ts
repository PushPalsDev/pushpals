import { randomUUID } from "crypto";

export type WorkerSpawnCommandOptions = {
  server: string;
  workerId: string;
  repoRoot: string;
  pollMs: number | null;
  heartbeatMs: number | null;
  labels: string[];
  docker: boolean;
  requireDocker: boolean;
  dockerImage: string | null;
  binaryPath?: string | null;
  envFile?: string | null;
  entrypoint?: string | null;
};

export type WorkerStartupTimeoutOptions = {
  configuredMs: number;
  docker: boolean;
  dockerAgentStartupTimeoutMs: number;
};

export function createWorkerPalId(
  options: {
    nowMs?: number;
    processId?: number;
    randomId?: string;
  } = {},
): string {
  const randomPart = String(options.randomId ?? randomUUID()).replace(/[^a-z0-9]/gi, "");
  const timePart = Math.max(0, Math.floor(options.nowMs ?? Date.now())).toString(36);
  const pidPart = Math.max(0, Math.floor(options.processId ?? process.pid)).toString(36);
  const suffix = `${timePart}${pidPart}${randomPart}`.toLowerCase().slice(0, 12);
  return `workerpal-${suffix || "worker"}`;
}

export function resolveWorkerStartupTimeoutMs(options: WorkerStartupTimeoutOptions): number {
  const configuredMs = Math.max(1_000, Math.floor(options.configuredMs || 0));
  if (!options.docker) {
    return configuredMs;
  }
  const dockerFloorMs = Math.max(
    30_000,
    Math.floor(options.dockerAgentStartupTimeoutMs || 0) + 15_000,
  );
  return Math.max(configuredMs, dockerFloorMs);
}

export function buildWorkerSpawnCommand(options: WorkerSpawnCommandOptions): string[] {
  const binaryPath = String(options.binaryPath ?? "").trim();
  const envFile = String(options.envFile ?? "").trim() || ".env";
  const entrypoint =
    String(options.entrypoint ?? "").trim() || "apps/workerpals/src/workerpals_main.ts";
  const args = binaryPath
    ? [
        binaryPath,
        "--server",
        options.server,
        "--workerId",
        options.workerId,
        "--repo",
        options.repoRoot,
      ]
    : [
        "bun",
        "run",
        "--env-file",
        envFile,
        entrypoint,
        "--server",
        options.server,
        "--workerId",
        options.workerId,
        "--repo",
        options.repoRoot,
      ];
  if (options.pollMs) {
    args.push("--poll", String(options.pollMs));
  }
  if (options.heartbeatMs) {
    args.push("--heartbeat", String(options.heartbeatMs));
  }
  if (options.labels.length > 0) {
    args.push("--labels", options.labels.join(","));
  }
  if (options.docker) {
    args.push("--docker");
    if (options.requireDocker) args.push("--require-docker");
    if (options.dockerImage) {
      args.push("--docker-image", options.dockerImage);
    }
  }
  return args;
}
