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
    `PY="\${PUSHPALS_OPENAI_CODEX_PYTHON:-${sharedVenvPython}}"; ` +
    'AUTH_MODE_RAW="${PUSHPALS_OPENAI_CODEX_AUTH_MODE:-auto}"; ' +
    'AUTH_MODE="$(printf %s "$AUTH_MODE_RAW" | tr "[:upper:]" "[:lower:]")"; ' +
    'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi; ' +
    '[ -n "$PY" ] || { echo "python runtime not found" >&2; exit 1; }; ' +
    "if command -v codex >/dev/null 2>&1; then " +
    '  CODEX_CMD="codex"; ' +
    "elif command -v bunx >/dev/null 2>&1; then " +
    '  CODEX_CMD="bunx --yes @openai/codex"; ' +
    "else " +
    '  echo "Neither bunx nor codex was found in PATH" >&2; ' +
    "  exit 1; " +
    "fi; " +
    'sh -lc "$CODEX_CMD --version"; ' +
    'NEED_LOGIN="0"; ' +
    'if [ "$AUTH_MODE" = "chatgpt" ] || [ "$AUTH_MODE" = "chatgpt_login" ] || [ "$AUTH_MODE" = "subscription" ]; then NEED_LOGIN="1"; fi; ' +
    'if [ "$AUTH_MODE" = "auto" ] && [ -z "${OPENAI_API_KEY:-}" ]; then NEED_LOGIN="1"; fi; ' +
    'if [ "$NEED_LOGIN" = "1" ]; then ' +
    '  sh -lc "$CODEX_CMD login status" >/dev/null 2>&1 || { ' +
    '    echo "Codex CLI login is required for PUSHPALS_OPENAI_CODEX_AUTH_MODE=${AUTH_MODE}. Run codex login (or bunx --yes @openai/codex login)." >&2; ' +
    "    exit 1; " +
    "  }; " +
    "fi"
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
    scriptPath: resolveWorkerpalsSourcePath("backends", "openai_codex", "openai_codex_executor.py"),
    scriptSegments: [
      "apps",
      "workerpals",
      "src",
      "backends",
      "openai_codex",
      "openai_codex_executor.py",
    ],
    pythonConfigKey: "openaiCodexPython",
    timeoutConfigKey: "openaiCodexTimeoutMs",
  }),
};
