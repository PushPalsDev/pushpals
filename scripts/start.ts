#!/usr/bin/env bun
/**
 * Stable start entrypoint.
 *
 * `bun run start` can be invoked with accidental extra CLI flags (e.g. `-c`)
 * from shell wrappers. This wrapper intentionally ignores forwarded args and
 * always launches `dev:full` with the canonical script options.
 *
 * It also performs startup preflights:
 * - LLM endpoint reachability (and optional local vLLM auto-start)
 * - integration branch/worktree safety
 * - worker Docker image existence
 */

import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const DEFAULT_IMAGE = "pushpals-worker-sandbox:latest";
const DEFAULT_LLM_ENDPOINT = "http://localhost:18123";
const DEFAULT_PLANNER_ENDPOINT = "http://localhost:18123/v1/chat/completions";
const DEFAULT_LLM_MODEL = "zai-org/GLM-4.7-Flash";
const DEFAULT_VLLM_DOCKER_IMAGE = "vllm/vllm-openai:latest";
const DEFAULT_VLLM_DOCKER_CONTAINER_PORT = 8000;
const DEFAULT_VLLM_READY_TIMEOUT_MS = 600_000;
const DEFAULT_INTEGRATION_BRANCH = "main_agents";
const INTEGRATION_BRANCH =
  (process.env.PUSHPALS_INTEGRATION_BRANCH ?? "").trim() || DEFAULT_INTEGRATION_BRANCH;
const INTEGRATION_REMOTE_REF = `origin/${INTEGRATION_BRANCH}`;
const DEFAULT_INTEGRATION_BASE_BRANCH = "main";
const INTEGRATION_BASE_BRANCH =
  (process.env.PUSHPALS_INTEGRATION_BASE_BRANCH ?? "").trim() || DEFAULT_INTEGRATION_BASE_BRANCH;
const INTEGRATION_BASE_REMOTE_REF = `origin/${INTEGRATION_BASE_BRANCH}`;
const workerImage = process.env.WORKERPALS_DOCKER_IMAGE ?? DEFAULT_IMAGE;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const DEFAULT_SOURCE_CONTROL_MANAGER_WORKTREE = resolve(
  repoRoot,
  ".worktrees",
  "source_control_manager",
);
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const managedVllmLogTail: string[] = [];
let managedVllmProc: ReturnType<typeof Bun.spawn> | null = null;
let managedVllmRuntime: "python" | "docker" | null = null;
let managedVllmDockerContainerName: string | null = null;
let managedVllmDockerOwned = false;

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? "").toLowerCase());
}

function parsePositiveInt(value: string | null | undefined): number | null {
  const normalized = (value ?? "").trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function appendVllmLogTail(line: string): void {
  managedVllmLogTail.push(line);
  if (managedVllmLogTail.length > 120) {
    managedVllmLogTail.splice(0, managedVllmLogTail.length - 120);
  }
}

function normalizeCompletionEndpoint(raw: string, fallback: string): string {
  const source = (raw.trim() || fallback).replace(/\/+$/, "");
  if (source.includes("/chat/completions")) return source;
  if (source.endsWith("/api/chat")) return source;
  if (source.endsWith("/v1")) return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function pythonAliasOrder(): string[] {
  // Windows commonly has `python`; Linux often has only `python3`.
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

function detectedPythonAliases(): string[] {
  const detected: string[] = [];
  for (const alias of pythonAliasOrder()) {
    try {
      if (Bun.which(alias)) detected.push(alias);
    } catch {
      // ignore and fallback below
    }
  }
  return detected;
}

function preferredPythonAlias(): string {
  const detected = detectedPythonAliases();
  return detected[0] ?? pythonAliasOrder()[0] ?? "python3";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeVllmFlag(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function configuredVllmRuntime(): "auto" | "docker" | "python" {
  const raw = normalizeVllmFlag(process.env.PUSHPALS_VLLM_RUNTIME);
  if (raw === "docker" || raw === "python" || raw === "auto") {
    return raw;
  }
  return "docker";
}

function preferredVllmRuntimeOrder(): Array<"docker" | "python"> {
  const configured = configuredVllmRuntime();
  if (configured === "docker") return ["docker"];
  if (configured === "python") return ["python"];
  return process.platform === "win32" ? ["docker", "python"] : ["python", "docker"];
}

function vllmModeConfigured(): boolean {
  const provider = normalizeVllmFlag(process.env.PUSHPALS_LLM_PROVIDER);
  if (provider === "vllm") return true;

  const keys = [
    process.env.LLM_API_KEY,
    process.env.PLANNER_API_KEY,
    process.env.WORKERPALS_OPENHANDS_API_KEY,
  ];
  return keys.some((value) => normalizeVllmFlag(value) === "vllm");
}

function shouldAutoStartVllm(primaryEndpoint: string): boolean {
  const explicit = process.env.PUSHPALS_AUTO_START_VLLM;
  const enabled = explicit == null || explicit.trim() === "" ? vllmModeConfigured() : envTruthy("PUSHPALS_AUTO_START_VLLM");
  if (!enabled) return false;

  const parsed = parseUrl(primaryEndpoint);
  return parsed ? isLoopbackHost(parsed.hostname) : false;
}

function llmPreflightTargets(): Array<{ name: string; endpoint: string; probes: string[] }> {
  const out: Array<{ name: string; endpoint: string; probes: string[] }> = [];
  const seenEndpoints = new Set<string>();

  const addTarget = (name: string, endpoint: string) => {
    const normalized = endpoint.trim();
    if (!normalized || seenEndpoints.has(normalized)) return;
    seenEndpoints.add(normalized);

    const probes: string[] = [];
    const parsed = parseUrl(normalized);
    if (normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    }
    probes.push(normalized);
    if (parsed) {
      probes.push(`${parsed.origin}/health`);
      probes.push(parsed.origin);
    }

    const dedupedProbes = Array.from(new Set(probes));
    out.push({ name, endpoint: normalized, probes: dedupedProbes });
  };

  addTarget(
    "RemoteBuddy LLM",
    normalizeCompletionEndpoint(process.env.LLM_ENDPOINT ?? "", DEFAULT_LLM_ENDPOINT),
  );
  addTarget(
    "LocalBuddy Planner",
    normalizeCompletionEndpoint(process.env.PLANNER_ENDPOINT ?? "", DEFAULT_PLANNER_ENDPOINT),
  );

  return out;
}

async function probeHttpReachable(
  url: string,
  timeoutMs = 2500,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    // Any HTTP response means endpoint is reachable (even 404/401).
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkTargetReachable(
  target: { name: string; endpoint: string; probes: string[] },
): Promise<{ ok: boolean; url?: string; status?: number; error?: string }> {
  let lastError = "unknown error";
  for (const probe of target.probes) {
    const result = await probeHttpReachable(probe);
    if (result.ok) return { ok: true, url: probe, status: result.status };
    lastError = `${probe}: ${result.error ?? "connection failed"}`;
  }
  return { ok: false, error: lastError };
}

type VllmLaunchConfig = {
  host: string;
  port: number;
  model: string;
};

function resolveVllmLaunchConfig(endpoint: string): VllmLaunchConfig {
  const parsed = parseUrl(endpoint);
  const endpointHost = parsed?.hostname || "127.0.0.1";
  const endpointPort = parsed?.port ? Number.parseInt(parsed.port, 10) : 18123;

  const host = (process.env.PUSHPALS_VLLM_HOST ?? endpointHost).trim() || "127.0.0.1";
  const port =
    parsePositiveInt(process.env.PUSHPALS_VLLM_PORT) ??
    (Number.isFinite(endpointPort) ? endpointPort : 18123);
  const model =
    (process.env.PUSHPALS_VLLM_MODEL ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL).trim() ||
    DEFAULT_LLM_MODEL;

  return { host, port, model };
}

function vllmReadyTimeoutMs(): number {
  return parsePositiveInt(process.env.PUSHPALS_VLLM_READY_TIMEOUT_MS) ?? DEFAULT_VLLM_READY_TIMEOUT_MS;
}

function sanitizeContainerName(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_.-]/g, "-");
  const compact = normalized.replace(/-+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return compact || "pushpals-vllm";
}

function defaultVllmContainerName(port: number): string {
  return sanitizeContainerName(`pushpals-vllm-${port}`);
}

type VllmDockerLaunch = {
  args: string[];
  image: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  model: string;
};

function vllmDockerStartArgs(endpoint: string): VllmDockerLaunch {
  const launch = resolveVllmLaunchConfig(endpoint);
  const image =
    (process.env.PUSHPALS_VLLM_DOCKER_IMAGE ?? DEFAULT_VLLM_DOCKER_IMAGE).trim() ||
    DEFAULT_VLLM_DOCKER_IMAGE;
  const containerPort =
    parsePositiveInt(process.env.PUSHPALS_VLLM_DOCKER_CONTAINER_PORT) ??
    DEFAULT_VLLM_DOCKER_CONTAINER_PORT;
  const containerName = sanitizeContainerName(
    process.env.PUSHPALS_VLLM_DOCKER_CONTAINER_NAME ?? defaultVllmContainerName(launch.port),
  );

  const args = [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "-p",
    `${launch.port}:${containerPort}`,
  ];

  const hfToken = (process.env.HUGGING_FACE_HUB_TOKEN ?? process.env.HF_TOKEN ?? "").trim();
  if (hfToken) {
    args.push("-e", `HUGGING_FACE_HUB_TOKEN=${hfToken}`, "-e", `HF_TOKEN=${hfToken}`);
  }

  args.push(
    image,
    "--host",
    "0.0.0.0",
    "--port",
    String(containerPort),
    "--model",
    launch.model,
  );

  return { args, image, containerName, hostPort: launch.port, containerPort, model: launch.model };
}

async function dockerContainerRunning(name: string): Promise<boolean> {
  const result = await runCapture(
    ["docker", "ps", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    repoRoot,
  );
  return result.ok && result.stdout.length > 0;
}

async function dockerContainerExists(name: string): Promise<boolean> {
  const result = await runCapture(
    ["docker", "ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    repoRoot,
  );
  return result.ok && result.stdout.length > 0;
}

async function ensureVllmDockerImage(image: string): Promise<void> {
  const imageExists = (await runQuiet(["docker", "image", "inspect", image])) === 0;
  if (imageExists) return;

  console.log(`[start] vLLM image not found locally: ${image}`);
  console.log("[start] Pulling vLLM image (first run may take a few minutes)...");

  const proc = Bun.spawn(["docker", "pull", image], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const recent: string[] = [];
  const captureRecent = (line: string) => {
    if (!line.trim()) return;
    recent.push(line.trim());
    if (recent.length > 30) {
      recent.splice(0, recent.length - 30);
    }
  };

  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) captureRecent(raw.replace(/\r$/, ""));
    }
    if (buffer.trim()) captureRecent(buffer.replace(/\r$/, ""));
  };

  const startedAt = Date.now();
  let ticker: ReturnType<typeof setInterval> | null = null;
  ticker = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    if (process.stdout.isTTY) {
      process.stdout.write(`\r[start] Pulling vLLM image... ${elapsedSec}s elapsed`);
    } else {
      console.log(`[start] Pulling vLLM image... ${elapsedSec}s elapsed`);
    }
  }, 5000);

  const exitCode = await Promise.all([consume(proc.stdout), consume(proc.stderr), proc.exited]).then(
    ([, , code]) => code,
  );

  if (ticker) {
    clearInterval(ticker);
    if (process.stdout.isTTY) {
      process.stdout.write("\r");
    }
  }

  if (exitCode !== 0) {
    const detail = recent.length > 0 ? recent.slice(-8).join("\n") : "no docker pull output captured";
    throw new Error(`docker pull failed for ${image} (exit ${exitCode})\n${detail}`);
  }

  console.log("[start] vLLM image pull complete.");
}

function streamVllmOutput(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  emitToConsole = true,
): void {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(/\r$/, "");
        if (!clean.trim()) continue;
        appendVllmLogTail(clean);
        if (emitToConsole) {
          console.log(`${prefix}${clean}`);
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      appendVllmLogTail(tail);
      if (emitToConsole) {
        console.log(`${prefix}${tail}`);
      }
    }
  })();
}

function vllmModuleMissingFromLogs(): boolean {
  const haystack = managedVllmLogTail.join("\n").toLowerCase();
  return (
    haystack.includes("modulenotfounderror") &&
    (haystack.includes("no module named 'vllm'") ||
      haystack.includes('no module named "vllm"') ||
      haystack.includes("module specification for 'vllm"))
  );
}

function vllmUvloopMissingFromLogs(): boolean {
  const haystack = managedVllmLogTail.join("\n").toLowerCase();
  return haystack.includes("modulenotfounderror") && haystack.includes("no module named 'uvloop'");
}

function dockerCommandMissingFromLogs(): boolean {
  const haystack = managedVllmLogTail.join("\n").toLowerCase();
  return haystack.includes("docker") && (haystack.includes("not found") || haystack.includes("enoent"));
}

function printVllmAutoStartHelp(primaryEndpoint: string): void {
  const endpoint = parseUrl(primaryEndpoint);
  const host = endpoint?.hostname ?? "localhost";
  const port = endpoint?.port || "18123";
  const installPython = preferredPythonAlias();
  const detectedAliases = detectedPythonAliases();
  const runtimePreference = configuredVllmRuntime();

  if (vllmModuleMissingFromLogs()) {
    console.error("[start] vLLM Python package was not found.");
    console.error("[start] Next steps:");
    console.error(
      `[start] 1) Install vLLM in a Python env: "${installPython} -m pip install vllm" (or use the interpreter that already has it).`,
    );
    console.error(
      "[start] 2) Point startup at that interpreter: set PUSHPALS_VLLM_PYTHON=<path-to-python>.",
    );
    if (detectedAliases.length > 0) {
      console.error(`[start]    Detected aliases on this machine: ${detectedAliases.join(", ")}`);
    } else {
      console.error(
        "[start]    No python/python3 alias detected in PATH. Install Python or set PUSHPALS_VLLM_PYTHON explicitly.",
      );
    }
    console.error(
      `[start] 3) Retry "bun run start". Expected endpoint: http://${host}:${port}/v1/chat/completions`,
    );
    console.error(
      "[start] 4) If you do not want auto-start, set PUSHPALS_AUTO_START_VLLM=0 and run your own LLM server.",
    );
    return;
  }

  if (vllmUvloopMissingFromLogs()) {
    console.error("[start] vLLM Python startup failed because `uvloop` is unavailable.");
    console.error("[start] Native Windows Python cannot install uvloop.");
    console.error("[start] Next steps:");
    console.error("[start] 1) Use Docker runtime (recommended on Windows): set PUSHPALS_VLLM_RUNTIME=docker");
    console.error(
      "[start] 2) Ensure Docker Desktop is running and retry `bun run start` (startup will launch a Linux vLLM container).",
    );
    console.error(
      "[start] 3) Or run from Linux/WSL with a compatible Python env and keep PUSHPALS_VLLM_RUNTIME=python.",
    );
    return;
  }

  if (dockerCommandMissingFromLogs()) {
    console.error("[start] Docker runtime was selected for vLLM, but Docker CLI was not available.");
    console.error("[start] Install/start Docker Desktop or switch to Python runtime:");
    console.error("[start] - PUSHPALS_VLLM_RUNTIME=python");
    console.error("[start] - PUSHPALS_AUTO_START_VLLM=0 (if running your own endpoint)");
    return;
  }

  console.error("[start] Could not auto-start vLLM.");
  console.error("[start] Verify:");
  if (runtimePreference === "docker" || (runtimePreference === "auto" && process.platform === "win32")) {
    const dockerLaunch = vllmDockerStartArgs(primaryEndpoint);
    console.error("[start] - Docker Desktop is running and the Docker daemon is reachable");
    console.error(`[start] - image exists or can be pulled: ${dockerLaunch.image}`);
    console.error(
      `[start] - host port ${dockerLaunch.hostPort} is free and maps to container port ${dockerLaunch.containerPort}`,
    );
    console.error(`[start] - model name is valid: ${dockerLaunch.model}`);
  } else {
    console.error("[start] - vLLM is installed in the Python interpreter being used");
    console.error("[start] - your selected model is available and valid");
    console.error("[start] - host/port are free and reachable");
  }
  console.error(
    "[start] Optional: set PUSHPALS_AUTO_START_VLLM=0 and point LLM_ENDPOINT/PLANNER_ENDPOINT to an already-running server.",
  );
}

function vllmPythonStartArgs(endpoint: string): string[][] {
  const launch = resolveVllmLaunchConfig(endpoint);
  const override = (process.env.PUSHPALS_VLLM_PYTHON ?? "").trim();
  const pythonCandidates = Array.from(
    new Set([
      override,
      ...detectedPythonAliases(),
      ...pythonAliasOrder(),
      "python3",
      "python",
    ]).values(),
  ).filter(Boolean);

  return pythonCandidates.map((pythonBin) => [
    pythonBin,
    "-m",
    "vllm.entrypoints.openai.api_server",
    "--host",
    launch.host,
    "--port",
    String(launch.port),
    "--model",
    launch.model,
  ]);
}

async function startManagedVllmPython(primaryEndpoint: string): Promise<void> {
  const commandCandidates = vllmPythonStartArgs(primaryEndpoint);
  let lastFailure = "unknown failure";

  for (const cmd of commandCandidates) {
    try {
      console.log(`[start] Launching local vLLM (python): ${cmd.join(" ")}`);
      const proc = Bun.spawn(cmd, {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      managedVllmProc = proc;
      managedVllmRuntime = "python";

      streamVllmOutput(proc.stdout, "[vllm] ");
      streamVllmOutput(proc.stderr, "[vllm] ");

      const early = await Promise.race([
        proc.exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false; code: null }>((resolveRace) =>
          setTimeout(() => resolveRace({ exited: false, code: null }), 900),
        ),
      ]);

      if (early.exited) {
        managedVllmProc = null;
        managedVllmRuntime = null;
        lastFailure = `${cmd[0]} exited immediately with code ${early.code}`;
        continue;
      }

      return;
    } catch (err) {
      managedVllmProc = null;
      managedVllmRuntime = null;
      lastFailure = `${cmd[0]} failed to start: ${String(err)}`;
    }
  }

  throw new Error(lastFailure);
}

async function startManagedVllmDocker(primaryEndpoint: string): Promise<void> {
  const dockerAvailable = (await runQuiet(["docker", "version"])) === 0;
  if (!dockerAvailable) {
    throw new Error("Docker daemon is unavailable");
  }

  const launch = vllmDockerStartArgs(primaryEndpoint);
  await ensureVllmDockerImage(launch.image);

  const alreadyRunning = await dockerContainerRunning(launch.containerName);
  if (alreadyRunning) {
    managedVllmRuntime = "docker";
    managedVllmDockerContainerName = launch.containerName;
    managedVllmDockerOwned = false;
    console.log(`[start] Reusing existing vLLM container: ${launch.containerName}`);
    return;
  }

  if (await dockerContainerExists(launch.containerName)) {
    const removeExit = await runQuiet(["docker", "rm", "-f", launch.containerName]);
    if (removeExit !== 0) {
      throw new Error(`could not remove stale container ${launch.containerName}`);
    }
  }

  console.log(
    `[start] Launching local vLLM (docker): image=${launch.image}, model=${launch.model}, port=${launch.hostPort}`,
  );

  const proc = Bun.spawn(launch.args, {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  managedVllmProc = proc;
  managedVllmRuntime = "docker";
  managedVllmDockerContainerName = launch.containerName;
  managedVllmDockerOwned = true;

  // Keep logs buffered for failure diagnostics, but avoid noisy startup output.
  streamVllmOutput(proc.stdout, "[vllm] ", false);
  streamVllmOutput(proc.stderr, "[vllm] ", false);

  const early = await Promise.race([
    proc.exited.then((code) => ({ exited: true, code })),
    new Promise<{ exited: false; code: null }>((resolveRace) =>
      setTimeout(() => resolveRace({ exited: false, code: null }), 1200),
    ),
  ]);

  if (early.exited) {
    managedVllmProc = null;
    managedVllmRuntime = null;
    managedVllmDockerContainerName = null;
    managedVllmDockerOwned = false;
    throw new Error(`docker run exited immediately with code ${early.code}`);
  }
}

async function startManagedVllm(primaryEndpoint: string): Promise<void> {
  if (managedVllmProc || managedVllmDockerContainerName) return;
  managedVllmLogTail.length = 0;

  let lastFailure = "unknown failure";
  for (const runtime of preferredVllmRuntimeOrder()) {
    try {
      if (runtime === "docker") {
        await startManagedVllmDocker(primaryEndpoint);
      } else {
        await startManagedVllmPython(primaryEndpoint);
      }
      return;
    } catch (err) {
      lastFailure = `${runtime} runtime failed: ${String(err)}`;
      managedVllmProc = null;
      managedVllmRuntime = null;
      managedVllmDockerContainerName = null;
      managedVllmDockerOwned = false;
    }
  }

  throw new Error(
    `${lastFailure}. Set PUSHPALS_VLLM_RUNTIME to docker/python, or disable auto-start with PUSHPALS_AUTO_START_VLLM=0.`,
  );
}

async function stopManagedVllm(): Promise<void> {
  const proc = managedVllmProc;
  const runtime = managedVllmRuntime;
  const containerName = managedVllmDockerContainerName;
  const containerOwned = managedVllmDockerOwned;

  managedVllmProc = null;
  managedVllmRuntime = null;
  managedVllmDockerContainerName = null;
  managedVllmDockerOwned = false;

  if (proc) {
    try {
      proc.kill();
    } catch {}
    try {
      await Promise.race([proc.exited, new Promise((resolveWait) => setTimeout(resolveWait, 2500))]);
    } catch {}
  }

  if (runtime === "docker" && containerOwned && containerName) {
    await runQuiet(["docker", "stop", "-t", "5", containerName]);
  }
}

async function ensureLlmPreflight(): Promise<void> {
  if (envTruthy("PUSHPALS_SKIP_LLM_PREFLIGHT")) return;

  const targets = llmPreflightTargets();
  if (targets.length === 0) return;

  const primary = targets[0];
  const autoStartEligible = shouldAutoStartVllm(primary.endpoint);
  let autoStartAttempted = false;
  let primaryReachable = await checkTargetReachable(primary);

  if (!primaryReachable.ok && autoStartEligible) {
    try {
      autoStartAttempted = true;
      await startManagedVllm(primary.endpoint);
      const readyTimeoutMs = vllmReadyTimeoutMs();
      console.log(`[start] Waiting for local vLLM to become reachable (timeout ${readyTimeoutMs}ms)...`);
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        primaryReachable = await checkTargetReachable(primary);
        if (primaryReachable.ok) break;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 1200));
      }
    } catch (err) {
      console.error(`[start] Failed to auto-start vLLM: ${String(err)}`);
      if (managedVllmLogTail.length > 0) {
        console.error("[start] vLLM recent logs:");
        for (const line of managedVllmLogTail.slice(-25)) {
          console.error(`[vllm] ${line}`);
        }
      }
      printVllmAutoStartHelp(primary.endpoint);
      process.exit(1);
    }
  }

  for (const target of targets) {
    const check = target === primary ? primaryReachable : await checkTargetReachable(target);
    if (check.ok) continue;

    console.error(`[start] LLM preflight failed for ${target.name}.`);
    console.error(`[start] Endpoint: ${target.endpoint}`);
    console.error(`[start] Probes: ${target.probes.join(", ")}`);
    console.error(`[start] Last error: ${check.error ?? "connection failed"}`);
    console.error(
      "[start] Start your model server or set PUSHPALS_SKIP_LLM_PREFLIGHT=1 to bypass this check.",
    );
    if (vllmModeConfigured()) {
      if (autoStartAttempted && target === primary) {
        console.error("[start] vLLM auto-start was attempted but endpoint stayed unreachable.");
      } else if (!autoStartEligible && target === primary) {
        console.error(
          "[start] vLLM mode is configured. Auto-start is disabled; set PUSHPALS_AUTO_START_VLLM=1 to enable it.",
        );
      }
    }
    process.exit(1);
  }
}

async function runQuiet(cmd: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

async function runInherited(cmd: string[], cwd?: string): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  } catch {
    return 127;
  }
}

type CmdResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCapture(cmd: string[], cwd = repoRoot): Promise<CmdResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: 127,
      stdout: "",
      stderr: String(err),
    };
  }
}

async function git(args: string[]): Promise<CmdResult> {
  return runCapture(["git", ...args], repoRoot);
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`${question} [y/N]: `, (value) => resolveAnswer(value));
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function ensureGitHubAuth(force = false): Promise<void> {
  const skipCheck = envTruthy("PUSHPALS_SKIP_GH_AUTH_CHECK");
  const sourceControlManagerPushDisabled = envTruthy("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (!force && (skipCheck || sourceControlManagerPushDisabled)) {
    return;
  }

  const gitToken =
    process.env.PUSHPALS_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
  if (gitToken) {
    // Token auth is enough for SourceControlManager git push; no `gh` required.
    process.env.PUSHPALS_GIT_TOKEN = gitToken;
    return;
  }

  const ghAvailable = (await runQuiet(["gh", "--version"])) === 0;
  if (ghAvailable) {
    const ghAuthed = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (ghAuthed) return;

    console.log("[start] GitHub CLI is not authenticated. Starting `gh auth login`...");
    const loginExitCode = await runInherited(["gh", "auth", "login"]);
    if (loginExitCode !== 0) {
      console.error("[start] `gh auth login` failed.");
      process.exit(loginExitCode);
    }

    const ghAuthedAfterLogin = (await runQuiet(["gh", "auth", "status"])) === 0;
    if (!ghAuthedAfterLogin) {
      console.error("[start] GitHub CLI is still not authenticated after login.");
      process.exit(1);
    }
    return;
  }

  console.error("[start] SourceControlManager push is enabled but no GitHub auth is configured.");
  console.error("[start] Provide one of: PUSHPALS_GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN.");
  console.error(
    "[start] Or install GitHub CLI (`gh`) for interactive login, or disable push via SOURCE_CONTROL_MANAGER_NO_PUSH=1.",
  );
  process.exit(1);
}

async function ensureIntegrationBranch(): Promise<void> {
  const fetchResult = await git(["fetch", "origin", "--prune", "--quiet"]);
  if (!fetchResult.ok) {
    console.error("[start] Failed to fetch remote refs before integration-branch precheck.");
    console.error(fetchResult.stderr || fetchResult.stdout);
    process.exit(fetchResult.exitCode || 1);
  }

  const remoteExists = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${INTEGRATION_REMOTE_REF}`,
  ]);
  if (remoteExists.ok) {
    const localExists = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${INTEGRATION_BRANCH}`,
    ]);
    if (!localExists.ok) {
      const createLocal = await git(["branch", "-f", INTEGRATION_BRANCH, INTEGRATION_REMOTE_REF]);
      if (!createLocal.ok) {
        console.error(
          `[start] Failed to create local ${INTEGRATION_BRANCH} from ${INTEGRATION_REMOTE_REF}.`,
        );
        console.error(createLocal.stderr || createLocal.stdout);
        process.exit(createLocal.exitCode || 1);
      }
    }

    const setUpstream = await git([
      "branch",
      "--set-upstream-to",
      INTEGRATION_BASE_REMOTE_REF,
      INTEGRATION_BRANCH,
    ]);
    if (!setUpstream.ok) {
      console.error(
        `[start] Failed to set upstream for ${INTEGRATION_BRANCH} to ${INTEGRATION_BASE_REMOTE_REF}.`,
      );
      console.error(setUpstream.stderr || setUpstream.stdout);
      process.exit(setUpstream.exitCode || 1);
    }

    process.env.WORKERPALS_BASE_REF = process.env.WORKERPALS_BASE_REF ?? INTEGRATION_REMOTE_REF;
    return;
  }

  console.warn(`[start] Required branch ${INTEGRATION_REMOTE_REF} does not exist on remote.`);
  const autoCreate = envTruthy("PUSHPALS_AUTO_CREATE_INTEGRATION_BRANCH");

  let approved = autoCreate;
  if (!approved) {
    approved = await promptYesNo(
      `Create ${INTEGRATION_BRANCH} from ${INTEGRATION_BASE_REMOTE_REF} and push it to origin now?`,
    );
  }

  if (!approved) {
    console.error(
      `[start] Cannot continue without ${INTEGRATION_REMOTE_REF}. Create it on the remote repo, then rerun.`,
    );
    process.exit(1);
  }

  // Branch creation requires push credentials regardless of SOURCE_CONTROL_MANAGER_NO_PUSH mode.
  await ensureGitHubAuth(true);

  const ensureLocalBranch = await git([
    "branch",
    "-f",
    INTEGRATION_BRANCH,
    INTEGRATION_BASE_REMOTE_REF,
  ]);
  if (!ensureLocalBranch.ok) {
    console.error(
      `[start] Failed to create local ${INTEGRATION_BRANCH} from ${INTEGRATION_BASE_REMOTE_REF}.`,
    );
    console.error(ensureLocalBranch.stderr || ensureLocalBranch.stdout);
    process.exit(ensureLocalBranch.exitCode || 1);
  }

  const setUpstream = await git([
    "branch",
    "--set-upstream-to",
    INTEGRATION_BASE_REMOTE_REF,
    INTEGRATION_BRANCH,
  ]);
  if (!setUpstream.ok) {
    console.error(
      `[start] Failed to set upstream for ${INTEGRATION_BRANCH} to ${INTEGRATION_BASE_REMOTE_REF}.`,
    );
    console.error(setUpstream.stderr || setUpstream.stdout);
    process.exit(setUpstream.exitCode || 1);
  }

  const pushResult = await git([
    "push",
    "origin",
    `refs/heads/${INTEGRATION_BRANCH}:refs/heads/${INTEGRATION_BRANCH}`,
  ]);
  if (!pushResult.ok) {
    console.error(`[start] Failed to push ${INTEGRATION_BRANCH} to origin.`);
    console.error(pushResult.stderr || pushResult.stdout);
    console.error(
      `[start] Cannot continue unless ${INTEGRATION_REMOTE_REF} exists on the remote repository.`,
    );
    process.exit(pushResult.exitCode || 1);
  }

  const refresh = await git(["fetch", "origin", INTEGRATION_BRANCH, "--quiet"]);
  if (!refresh.ok) {
    console.warn(
      `[start] Created ${INTEGRATION_BRANCH}, but refresh fetch failed: ${refresh.stderr || refresh.stdout}`,
    );
  }

  process.env.WORKERPALS_BASE_REF = process.env.WORKERPALS_BASE_REF ?? INTEGRATION_REMOTE_REF;
  console.log(`[start] Ready: ${INTEGRATION_REMOTE_REF} exists and workers will base from it.`);
}

async function ensureSourceControlManagerWorktree(): Promise<void> {
  const configuredPath = (process.env.SOURCE_CONTROL_MANAGER_REPO_PATH ?? "").trim();
  const repoPath = configuredPath
    ? resolve(repoRoot, configuredPath)
    : DEFAULT_SOURCE_CONTROL_MANAGER_WORKTREE;

  if (repoPath === repoRoot) {
    console.error(
      "[start] SOURCE_CONTROL_MANAGER_REPO_PATH points to the primary workspace. Refusing to run SourceControlManager in-place.",
    );
    console.error(
      "[start] Set SOURCE_CONTROL_MANAGER_REPO_PATH to a dedicated worktree path, or unset it to use the default.",
    );
    process.exit(1);
  }

  const isGitRepo = await runCapture(
    ["git", "-C", repoPath, "rev-parse", "--is-inside-work-tree"],
    repoRoot,
  );
  if (!isGitRepo.ok) {
    mkdirSync(resolve(repoPath, ".."), { recursive: true });

    const pruneResult = await git(["worktree", "prune"]);
    if (!pruneResult.ok) {
      console.warn(
        `[start] Could not prune stale worktree metadata before creating ${repoPath}: ${pruneResult.stderr || pruneResult.stdout}`,
      );
    }

    const seedCandidates = [
      INTEGRATION_REMOTE_REF,
      INTEGRATION_BRANCH,
      INTEGRATION_BASE_REMOTE_REF,
      "HEAD",
    ];
    let seedRef = "HEAD";
    for (const ref of seedCandidates) {
      const exists = await git(["rev-parse", "--verify", "--quiet", ref]);
      if (exists.ok) {
        seedRef = ref;
        break;
      }
    }

    let addResult = await git(["worktree", "add", "--detach", repoPath, seedRef]);
    if (!addResult.ok) {
      const detail = `${addResult.stderr}\n${addResult.stdout}`.toLowerCase();
      if (detail.includes("already registered worktree")) {
        await git(["worktree", "prune"]);
        addResult = await git(["worktree", "add", "--force", "--detach", repoPath, seedRef]);
      }
    }

    if (!addResult.ok) {
      console.error(
        `[start] Failed to create SourceControlManager worktree at ${repoPath} from ${seedRef}: ${addResult.stderr || addResult.stdout}`,
      );
      process.exit(addResult.exitCode || 1);
    }
    console.log(`[start] Created SourceControlManager worktree: ${repoPath}`);
  }

  process.env.SOURCE_CONTROL_MANAGER_REPO_PATH = repoPath;
}

async function ensureDockerImage(): Promise<void> {
  const dockerAvailable = (await runQuiet(["docker", "version"])) === 0;
  if (!dockerAvailable) {
    console.error("[start] Docker is required for `bun run start` but is not available.");
    process.exit(1);
  }

  const imageExists = (await runQuiet(["docker", "image", "inspect", workerImage])) === 0;
  if (imageExists) return;

  console.log(`[start] Worker image not found: ${workerImage}`);
  console.log("[start] Building worker image...");

  const buildExitCode = await runInherited(
    ["docker", "build", "-f", "apps/workerpals/Dockerfile.sandbox", "-t", workerImage, "."],
    repoRoot,
  );

  if (buildExitCode !== 0) {
    console.error(`[start] Failed to build worker image (${workerImage}).`);
    process.exit(buildExitCode);
  }
}

await ensureLlmPreflight();
await ensureIntegrationBranch();
await ensureGitHubAuth();
await ensureSourceControlManagerWorktree();
await ensureDockerImage();

const proc = Bun.spawn(["bun", "run", "dev:full"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let shuttingDown = false;
const shutdown = async (code: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    proc.kill();
  } catch {}
  await stopManagedVllm();
  process.exit(code);
};

process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(143);
});

const exitCode = await proc.exited;
await stopManagedVllm();
process.exit(exitCode);
