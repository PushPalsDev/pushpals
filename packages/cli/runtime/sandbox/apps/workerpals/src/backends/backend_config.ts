import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { DEFAULT_WORKERPALS_EXECUTOR, loadPushPalsConfig } from "shared";
import type { ExecutorBackend } from "../common/types.js";
import { MINISWE_BACKEND } from "./miniswe_backend.js";
import { OPENAI_CODEX_BACKEND } from "./openai_codex_backend.js";
import { OPENHANDS_BACKEND } from "./openhands_backend.js";
import type { BackendTaskExecutor, DockerBackendSpec } from "./types.js";
import { registerBackendTaskExecutor } from "./task_execute_registry.js";

const FALLBACK_DEFAULT_EXECUTOR: ExecutorBackend = DEFAULT_WORKERPALS_EXECUTOR;

interface BackendTomlShape {
  default_backend?: string;
  env?: { shared_passthrough?: unknown };
  backends?: Record<
    string,
    {
      script_segments?: unknown;
      passthrough_env?: unknown;
      python_config_key?: string;
      timeout_config_key?: string;
    }
  >;
}

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseRequiredBackendToml(path: string): BackendTomlShape {
  if (!existsSync(path)) {
    throw new Error(`Missing required runtime backend config file: ${path}`);
  }

  const parsed = Bun.TOML.parse(readFileSync(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid runtime backend config file: ${path}`);
  }
  return parsed as BackendTomlShape;
}

function loadBackendToml(): BackendTomlShape {
  const projectRoot = loadPushPalsConfig().projectRoot;
  const path = resolve(projectRoot, "configs", "backend.toml");
  return parseRequiredBackendToml(path);
}

const config = loadBackendToml();
const backendEntries = Object.entries(config.backends ?? {});

export const BACKEND_EXECUTOR_SCRIPT_SEGMENTS: Record<string, readonly string[]> =
  Object.fromEntries(
    backendEntries.map(([name, spec]) => [name, toStrings(spec?.script_segments)]),
  );

export const EXECUTOR_BACKENDS = Object.keys(BACKEND_EXECUTOR_SCRIPT_SEGMENTS) as ExecutorBackend[];

export const DEFAULT_EXECUTOR = (
  typeof config.default_backend === "string" &&
  EXECUTOR_BACKENDS.includes(config.default_backend as ExecutorBackend)
    ? config.default_backend
    : EXECUTOR_BACKENDS.includes(FALLBACK_DEFAULT_EXECUTOR)
      ? FALLBACK_DEFAULT_EXECUTOR
      : (EXECUTOR_BACKENDS[0] ?? FALLBACK_DEFAULT_EXECUTOR)
) as ExecutorBackend;

export const SHARED_DOCKER_PASSTHROUGH_ENV = toStrings(config.env?.shared_passthrough);

export const BACKEND_DOCKER_PASSTHROUGH_ENV: Record<string, readonly string[]> = Object.fromEntries(
  backendEntries.map(([name, spec]) => [name, toStrings(spec?.passthrough_env)]),
);

export const BACKEND_RUNTIME_CONFIG_KEYS: Record<
  string,
  { pythonKey: string; timeoutKey: string }
> = Object.fromEntries(
  backendEntries.map(([name, spec]) => [
    name,
    {
      pythonKey: spec?.python_config_key?.trim() || `${name}Python`,
      timeoutKey: spec?.timeout_config_key?.trim() || `${name}TimeoutMs`,
    },
  ]),
);

export const DOCKER_BACKENDS: readonly DockerBackendSpec[] = [
  OPENHANDS_BACKEND,
  MINISWE_BACKEND,
  OPENAI_CODEX_BACKEND,
];

export function getDockerBackendSpec(name: ExecutorBackend): DockerBackendSpec {
  const spec = DOCKER_BACKENDS.find((entry) => entry.name === name);
  if (!spec) {
    throw new Error(`Unknown docker backend: ${name}`);
  }
  return spec;
}

// ---- Auto-register task executors from backend modules ----------------------
// Each DockerBackendSpec provides a taskExecute hook. Register them so that
// execute_job.ts can discover executors via the registry without hardcoding
// backend names.

for (const backend of DOCKER_BACKENDS) {
  registerBackendTaskExecutor(backend.name, backend.taskExecute);
}

export function getBackendTaskExecutorFromSpec(
  name: ExecutorBackend,
): BackendTaskExecutor | undefined {
  const spec = DOCKER_BACKENDS.find((entry) => entry.name === name);
  return spec?.taskExecute ?? undefined;
}
