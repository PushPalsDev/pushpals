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
