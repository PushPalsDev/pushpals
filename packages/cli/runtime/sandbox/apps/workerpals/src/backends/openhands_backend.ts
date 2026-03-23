import type {
  DockerBackendSpec,
  DockerWarmRuntimeContext,
  DockerWarmStartupContext,
} from "./types.js";
import { executeWithOpenHands } from "./openhands_task_execute.js";

function normalizeContainerPython(configuredPython: string, sharedVenvPython: string): string {
  const configured = configuredPython.trim();
  if (!configured) {
    return sharedVenvPython;
  }
  const lowered = configured.toLowerCase();
  if (
    lowered === "python" ||
    lowered === "python3" ||
    configured.includes("\\") ||
    /^[a-zA-Z]:/.test(configured) ||
    configured.startsWith(".")
  ) {
    return sharedVenvPython;
  }
  return configured;
}

export function openHandsResolvePythonCommand(sharedVenvPython: string): string {
  return (
    `PY="\${WORKERPALS_OPENHANDS_PYTHON:-${sharedVenvPython}}"; ` +
    'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
    '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }'
  );
}

export function openHandsHealthCommand(port: number): string {
  return (
    `curl -fsS http://127.0.0.1:${port}/health >/dev/null 2>&1 ` +
    `|| curl -fsS http://127.0.0.1:${port}/ >/dev/null 2>&1`
  );
}

export function openHandsStartupCommand(context: DockerWarmStartupContext): string {
  const { sharedVenvPython, warmAgentPort: port, startupAttempts, sleepSeconds } = context;
  const healthCmd = openHandsHealthCommand(port);
  const resolvePythonCmd = openHandsResolvePythonCommand(sharedVenvPython);
  return (
    `${resolvePythonCmd}; ` +
    ": >/tmp/openhands-agent.log; " +
    `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${port} >/tmp/openhands-agent.log 2>&1 & ` +
    `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` +
    `${healthCmd} || { ` +
    'echo "agent server health check failed"; ' +
    'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true; ' +
    "ls -l /tmp/openhands-agent.log 2>/dev/null || true; " +
    "tail -n 160 /tmp/openhands-agent.log 2>/dev/null; " +
    "exit 1; }; " +
    "tail -f /dev/null"
  );
}

export function openHandsRestartCommand(context: DockerWarmStartupContext): string {
  const { sharedVenvPython, warmAgentPort: port, startupAttempts, sleepSeconds } = context;
  const healthCmd = openHandsHealthCommand(port);
  const resolvePythonCmd = openHandsResolvePythonCommand(sharedVenvPython);
  return (
    "OLD_PIDS=\"$(ps -eo pid,args | awk '/[o]penhands\\.agent_server/ {print $1}' | tr '\\n' ' ')\"; " +
    'if [ -n "$OLD_PIDS" ]; then kill $OLD_PIDS >/dev/null 2>&1 || true; fi; ' +
    "sleep 0.2; " +
    `${resolvePythonCmd}; ` +
    ": >/tmp/openhands-agent.log; " +
    `"$PY" -m openhands.agent_server --host 127.0.0.1 --port ${port} >/tmp/openhands-agent.log 2>&1 & ` +
    `for i in $(seq 1 ${startupAttempts}); do ${healthCmd} && break; sleep ${sleepSeconds}; done; ` +
    healthCmd
  );
}

export function openHandsDiagnosticChecks(sharedVenvPython: string): Array<{
  label: string;
  command: string;
}> {
  return [
    {
      label: "processes",
      command: 'ps -ef | grep -i "openhands.agent_server" | grep -v grep || true',
    },
    {
      label: "python",
      command:
        `${openHandsResolvePythonCommand(sharedVenvPython)}; ` +
        'echo "configured=$PY"; ' +
        'if [ -x "$PY" ]; then "$PY" -V 2>&1; else echo "configured python missing"; fi; ' +
        "(command -v python3 && python3 -V) 2>/dev/null || true",
    },
    {
      label: "agent-log-meta",
      command: "ls -l /tmp/openhands-agent.log 2>/dev/null || true",
    },
    {
      label: "agent-log-tail",
      command: "tail -n 160 /tmp/openhands-agent.log 2>/dev/null || true",
    },
  ];
}

export async function ensureOpenHandsWarmRuntime(context: DockerWarmRuntimeContext): Promise<void> {
  const healthCmd = openHandsHealthCommand(context.warmAgentPort);
  const healthy = await context.runWarmShell(healthCmd);
  if (healthy.ok) return;

  console.warn(
    `[DockerExecutor] Warm agent server is unhealthy in ${context.warmContainerName}; restarting it...`,
  );

  const restarted = await context.runWarmShell(openHandsRestartCommand(context));
  if (restarted.ok) return;

  let recreateError = "";
  try {
    console.warn(
      `[DockerExecutor] Warm agent restart failed in ${context.warmContainerName}; recreating warm container once...`,
    );
    await context.restartWarmContainer();
    const postRecreateHealth = await context.runWarmShell(
      `for i in $(seq 1 ${context.startupAttempts}); do ${healthCmd} && exit 0; sleep ${context.sleepSeconds}; done; exit 1`,
    );
    if (postRecreateHealth.ok) return;
    const postRecreateOutput = [postRecreateHealth.stderr, postRecreateHealth.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    recreateError = `post-recreate health check failed (exit ${postRecreateHealth.exitCode})${
      postRecreateOutput ? `: ${postRecreateOutput}` : "."
    }`;
  } catch (error) {
    recreateError = `recreate warm container failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  const restartOutput = [restarted.stderr, restarted.stdout].filter(Boolean).join("\n").trim();
  const diagnostics = await context.collectWarmDiagnostics();
  throw new Error(
    `Warm OpenHands agent server could not be started (exit ${restarted.exitCode})${
      restartOutput ? `: ${restartOutput}` : "."
    }${recreateError ? `\n${recreateError}` : ""}\n${diagnostics}`,
  );
}

export const OPENHANDS_BACKEND: DockerBackendSpec = {
  name: "openhands",
  configuredPython: (config) => config.openhands?.python ?? "python",
  timeoutMs: (config) => config.openhands?.timeoutMs ?? 300_000,
  normalizeContainerPython,
  warmContainerStartupCommand: openHandsStartupCommand,
  warmContainerEnv: (context) => ({
    WORKERPALS_OPENHANDS_AGENT_SERVER_URL: `http://127.0.0.1:${context.warmAgentPort}`,
  }),
  ensureWarmRuntime: ensureOpenHandsWarmRuntime,
  diagnosticChecks: openHandsDiagnosticChecks,
  warmupProbeCommand: null,
  taskExecute: executeWithOpenHands,
};
