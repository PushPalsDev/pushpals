import type { DockerBackendSpec } from "./types.js";
import { createGenericPythonExecutor } from "../common/generic_python_executor.js";
import { resolveWorkerpalsSourcePath } from "../common/runtime_paths.js";

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

function warmupProbeCommand(sharedVenvPython: string): string {
  return (
    `PY="\${WORKERPALS_MINISWE_PYTHON:-${sharedVenvPython}}"; ` +
    'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
    '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' +
    `"$PY" -c "import minisweagent; print('mini-swe-agent ready')"`
  );
}

export const MINISWE_BACKEND: DockerBackendSpec = {
  name: "miniswe",
  configuredPython: (config) => config.miniswe?.python ?? "python",
  timeoutMs: (config) => config.miniswe?.timeoutMs ?? 300_000,
  normalizeContainerPython,
  warmContainerStartupCommand: () => "tail -f /dev/null",
  warmContainerEnv: () => ({}),
  ensureWarmRuntime: null,
  diagnosticChecks: () => [],
  warmupProbeCommand,
  taskExecute: createGenericPythonExecutor({
    backendName: "miniswe",
    scriptPath: resolveWorkerpalsSourcePath("backends", "miniswe", "miniswe_executor.py"),
    scriptSegments: ["apps", "workerpals", "src", "backends", "miniswe", "miniswe_executor.py"],
    pythonConfigKey: "miniswePython",
    timeoutConfigKey: "minisweTimeoutMs",
  }),
};
