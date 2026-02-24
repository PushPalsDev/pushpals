export type WorkerSpawnCommandOptions = {
  server: string;
  workerId: string;
  pollMs: number | null;
  heartbeatMs: number | null;
  labels: string[];
  docker: boolean;
  requireDocker: boolean;
  dockerImage: string | null;
  passthrough?: readonly string[];
};

export function buildWorkerSpawnCommand(options: WorkerSpawnCommandOptions): string[] {
  const args = [
    "bun",
    "run",
    "--cwd",
    "apps/workerpals",
    "--env-file",
    "../../.env",
    "src/workerpals_main.ts",
    "--server",
    options.server,
    "--workerId",
    options.workerId,
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
  if (options.passthrough && options.passthrough.length > 0) {
    args.push(...options.passthrough);
  }
  return args;
}
