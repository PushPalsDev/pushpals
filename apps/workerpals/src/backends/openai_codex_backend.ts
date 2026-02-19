import { resolve } from "path";
import type { DockerBackendSpec } from "./types.js";
import { createGenericPythonExecutor } from "../common/generic_python_executor.js";

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
    `PY="\${WORKERPALS_OPENAI_CODEX_PYTHON:-${sharedVenvPython}}"; ` +
    'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
    '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' +
    'command -v codex >/dev/null 2>&1 || { echo "codex CLI not found in PATH" >&2; exit 1; }; ' +
    "codex --version"
  );
}

export const OPENAI_CODEX_BACKEND: DockerBackendSpec = {
  name: "openai_codex",
  configuredPython: (config) => config.openai_codex?.python ?? "python",
  timeoutMs: (config) => config.openai_codex?.timeoutMs ?? 300_000,
  normalizeContainerPython,
  warmContainerStartupCommand: () => "tail -f /dev/null",
  warmContainerEnv: () => ({}),
  ensureWarmRuntime: null,
  diagnosticChecks: () => [],
  warmupProbeCommand,
  taskExecute: createGenericPythonExecutor({
    backendName: "openai_codex",
    scriptPath: resolve(import.meta.dir, "openai_codex", "openai_codex_executor.py"),
    pythonConfigKey: "openaiCodexPython",
    timeoutConfigKey: "openaiCodexTimeoutMs",
  }),
};
