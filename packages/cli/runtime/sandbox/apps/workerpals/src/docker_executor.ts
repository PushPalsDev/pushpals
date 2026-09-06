/**
 * DockerExecutor - Runs jobs inside Docker containers with git worktree isolation
 *
 * This executor:
 * 1. Creates isolated git worktrees for each job
 * 2. Runs jobs in a warm Docker container mounting the repo root
 * 3. Parses structured output from the container
 * 4. Cleans up worktrees after execution
 *
 * Architecture:
 *   HOST: Worker daemon → git worktree add → docker exec (warm container) → git worktree remove
 *   CONTAINER: job_runner.ts → executeJob (review jobs edit/validate only) → ___RESULT___
 *   HOST SCM: prepare/rebase/finalize review worktree → retain immutable local completion ref
 */

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, relative, resolve } from "path";
import { fetchWithHardDeadline, loadPushPalsConfig } from "shared";
import { resolveExecutor, type WorkerpalsRuntimeConfig } from "./common/executor_backend.js";
import type {
  ExecutorBackend,
  JobCandidateState,
  JobDiagnostics,
  JobTokenUsage,
  JobUsageAttempt,
} from "./common/types.js";
import { validateStructuredJobResultEnvelope } from "./common/execution_utils.js";
import {
  isJobResultFrame,
  JOB_RESULT_MAX_CHARS,
  oversizedJobResultFrame,
} from "./common/job_result_transport.js";
import { computeTimeoutWarningWindow, DEFAULT_DOCKER_TIMEOUT_MS } from "./timeout_policy.js";
import {
  BACKEND_DOCKER_PASSTHROUGH_ENV,
  BACKEND_RUNTIME_CONFIG_KEYS,
  DOCKER_BACKENDS,
  SHARED_DOCKER_PASSTHROUGH_ENV,
  getDockerBackendSpec,
} from "./backends/backend_config.js";
import { forceDeleteWorktreePath } from "./common/worktree_cleanup.js";
import { VALIDATION_SAFE_DEPENDENCY_PROJECTION_VERSION } from "./common/worktree_dependency_artifacts.js";
import type {
  DockerBackendRuntimeConfig,
  DockerBackendSpec,
  DockerWarmShellResult,
  DockerWarmStartupContext,
} from "./backends/types.js";
import { resolveFreshWorktreeBaseRef, resolveReviewWorktreeBase } from "./worktree_base_ref.js";
import { JobDeadlineLedger, UsageAccumulator } from "./quality_loop_durability.js";
import {
  checkpointJobCandidate,
  createJobCommit,
  git,
  resumePreparedMergeConflictRebase,
  shouldCommit,
} from "./execute_job.js";
import {
  applyMergeConflictExecutionHints,
  isHostScmOwnedReviewParams,
  isMergeConflictResolutionParams,
  isReviewResolutionParams,
  markHostScmGitOwnership,
  prepareMergeConflictWorktreeOnHost,
  refreshMergeConflictWorktreeHints,
} from "./merge_conflict_job.js";

const DEFAULT_OPENHANDS_MODEL = "local-model";
const DEFAULT_CONFIG = loadPushPalsConfig();
const SHARED_CONTAINER_VENV_PYTHON = "/workspace/.venv/bin/python";
const WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL = "pushpals.runtime_tag";
const WORKERPAL_SANDBOX_COMPONENT_LABEL = "pushpals.component=workerpals-sandbox";
const WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID = "pushpals_extra_ca";
const WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH = "/run/pushpals/host-extra-ca.pem";
const WORKERPAL_SANDBOX_MERGED_CA_PATH = "/run/pushpals/ca-bundle.pem";
const WORKERPAL_SANDBOX_SYSTEM_CA_PATH = "/etc/ssl/certs/ca-certificates.crt";
const DEFAULT_OPENAI_CODEX_CONTAINER_HOME = "/workspace/.pushpals/codex-home";
const WORKERPAL_HOST_CODEX_AUTH_PATH = "/run/pushpals/host-codex-auth.json";
const DOCKER_IMAGE_INSPECT_TIMEOUT_MS = 15_000;
const DOCKER_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;
const DOCKER_IMAGE_PULL_TIMEOUT_MS = 10 * 60_000;
const DOCKER_CONTROL_TIMEOUT_MS = 30_000;
const DOCKER_PROBE_TIMEOUT_MS = 15_000;
const DOCKER_SELF_CHECK_TIMEOUT_MS = 60_000;
const HOST_GIT_CONTROL_TIMEOUT_MS = 60_000;
const DEFAULT_UNPLANNED_FINALIZATION_BUDGET_MAX_MS = 120_000;
const DEFAULT_UNPLANNED_FINALIZATION_BUDGET_DIVISOR = 5;
const SETUP_WORKTREE_RECONCILIATION_TIMEOUT_MS = 5_000;
const BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS = 3;
const BROWSER_VALIDATION_JOB_OVERHEAD_MS = 5 * 60_000;
const BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS = 20 * 60_000;
const BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS = 45 * 60_000;
const DOCKER_EXEC_TREE_TERMINATION_TIMEOUT_MS = 5_000;
const DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS = 2_000;
const DOCKER_TIMEOUT_RECYCLE_TIMEOUT_MS = 15_000;
const DOCKER_CAPTURE_MAX_CHARS = 2_000_000;
const DOCKER_STREAM_TRUNCATION_MARKER = "[PushPals] Earlier process output truncated";
const DOCKER_PENDING_LINE_MAX_CHARS = 64 * 1024;
const DOCKER_PENDING_LINE_TRUNCATION_MARKER =
  "[PushPals] Oversized unterminated process-output line truncated; continuing to drain";
const DEPENDENCY_SNAPSHOT_MAX_ENTRIES = 8;
const DEPENDENCY_SNAPSHOT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export async function probeWorkerLlmHttpEndpointStatus(
  probe: string,
  timeoutMs = 2_500,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return fetchWithHardDeadline({
    input: probe,
    init: {
      method: "GET",
      headers: { Accept: "application/json, text/plain, */*" },
    },
    timeoutMs: boundedTimeoutMs,
    fetchImpl: fetchFn,
    timeoutMessage: `WorkerPal LLM endpoint probe timed out after ${boundedTimeoutMs}ms`,
    consume: async (response) => {
      if (response.body) await response.body.cancel();
      return response.status;
    },
  });
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readCapturedProcessStream(
  readable: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxChars = DOCKER_CAPTURE_MAX_CHARS,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = readable.getReader();
  let captured = "";
  const abortReader = () => {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // Reader already closed.
    }
  };
  signal.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      captured += decoder.decode(value, { stream: true });
      if (captured.length > maxChars) {
        captured = `[output truncated to final ${maxChars} characters]\n${captured.slice(-maxChars)}`;
      }
    }
    captured += decoder.decode();
    return captured;
  } catch (error) {
    if (!signal.aborted) throw error;
    return captured;
  } finally {
    signal.removeEventListener("abort", abortReader);
    try {
      reader.releaseLock();
    } catch {
      // Reader already released or cancelled.
    }
  }
}

export function buildWindowsDockerExecTreeTerminationArgv(pid: number): string[] {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}

export function buildDockerRuntimeCapabilityCanaryCommand(backend: ExecutorBackend): string {
  const requiredTools = ["git", "bun", "node", "flock", "sha256sum", "readlink"];
  const backendRuntimeCheck =
    backend === "openai_codex"
      ? [
          "if command -v codex >/dev/null 2>&1; then codex_runtime=codex;",
          "elif command -v bunx >/dev/null 2>&1; then codex_runtime=bunx;",
          'else echo "Neither codex nor bunx is available" >&2; exit 1; fi',
        ].join(" ")
      : "codex_runtime=not-required";
  return [
    "set -eu",
    ...requiredTools.map((tool) => `command -v ${tool} >/dev/null`),
    'PY="/workspace/.venv/bin/python"',
    'if [ ! -x "$PY" ]; then PY="$(command -v python3 || command -v python || true)"; fi',
    '[ -n "$PY" ] && [ -x "$PY" ]',
    backendRuntimeCheck,
    'dependency_store="/workspace/.pushpals/dependency-store"',
    'test -d "$dependency_store" && test -w "$dependency_store"',
    'dependency_probe="$dependency_store/.pushpals-capability-$$"',
    'rm -rf -- "$dependency_probe"',
    'mkdir "$dependency_probe"',
    'printf pushpals > "$dependency_probe/source"',
    'ln "$dependency_probe/source" "$dependency_probe/link"',
    'test "$(cat "$dependency_probe/link")" = pushpals',
    'rm -rf -- "$dependency_probe"',
    "printf 'runtime_tools=%s codex_runtime=%s docker_socket=%s dependency_store=write-delete-ok\\n' " +
      `${shellSingleQuote(`${requiredTools.join(",")},python`)} ` +
      '"$codex_runtime" ' +
      '"$(if [ -S /var/run/docker.sock ]; then printf available; else printf trusted-host-only; fi)"',
  ].join("\n");
}

export function resolveOpenAiCodexContainerHome(configured: string | undefined): string {
  const raw = String(configured ?? "").trim();
  if (!raw) return DEFAULT_OPENAI_CODEX_CONTAINER_HOME;
  if (!raw.startsWith("/") || raw.includes("\\") || raw.split("/").includes("..")) {
    return DEFAULT_OPENAI_CODEX_CONTAINER_HOME;
  }
  const normalized = raw.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const isDedicatedCodexHome =
    normalized.startsWith("/workspace/.pushpals/") ||
    /^\/(?:root|home\/[^/]+)\/\.codex(?:\/.*)?$/.test(normalized);
  if (!normalized || !isDedicatedCodexHome) {
    return DEFAULT_OPENAI_CODEX_CONTAINER_HOME;
  }
  return normalized;
}

export function buildOpenAiCodexHomeStartupCommand(options: {
  containerHome: string;
  runtimeTag?: string;
  hostAuthMounted: boolean;
}): string {
  const home = shellSingleQuote(resolveOpenAiCodexContainerHome(options.containerHome));
  const runtimeTag = shellSingleQuote(String(options.runtimeTag ?? "").trim() || "unversioned");
  const commands = [
    `codex_home=${home}`,
    `codex_runtime_tag=${runtimeTag}`,
    'mkdir -p "$codex_home"',
    'runtime_marker="$codex_home/.pushpals-runtime-tag"',
    'previous_runtime_tag="$(cat "$runtime_marker" 2>/dev/null || true)"',
    'if [ "$previous_runtime_tag" != "$codex_runtime_tag" ]; then find "$codex_home" -mindepth 1 -maxdepth 1 ! -name auth.json ! -name .pushpals-host-auth.sha256 ! -name .pushpals-runtime-tag -exec rm -rf -- {} +; printf \'%s\\n\' "$codex_runtime_tag" > "$runtime_marker"; fi',
  ];
  if (options.hostAuthMounted) {
    commands.push(
      `host_auth=${shellSingleQuote(WORKERPAL_HOST_CODEX_AUTH_PATH)}`,
      'host_auth_hash="$(sha256sum "$host_auth" | cut -d " " -f 1)"',
      'host_auth_marker="$codex_home/.pushpals-host-auth.sha256"',
      'previous_host_auth_hash="$(cat "$host_auth_marker" 2>/dev/null || true)"',
      'if [ ! -s "$codex_home/auth.json" ] || [ "$host_auth_hash" != "$previous_host_auth_hash" ]; then cp "$host_auth" "$codex_home/.auth.json.pushpals-tmp"; chmod 0600 "$codex_home/.auth.json.pushpals-tmp"; mv -f "$codex_home/.auth.json.pushpals-tmp" "$codex_home/auth.json"; printf \'%s\\n\' "$host_auth_hash" > "$host_auth_marker"; fi',
    );
  }
  return commands.join("; ");
}

export function prependOpenAiCodexHomeStartup(
  startupCommand: string,
  options: { containerHome: string; runtimeTag?: string; hostAuthMounted: boolean } | null,
): string {
  if (!options) return startupCommand;
  return `${buildOpenAiCodexHomeStartupCommand(options)}; ${startupCommand}`;
}

async function terminateDockerExecProcessTree(
  proc: ReturnType<typeof Bun.spawn>,
  platform = process.platform,
): Promise<void> {
  const pid = Number(proc.pid);
  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const taskkill = Bun.spawn(buildWindowsDockerExecTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore",
      });
      const result = await settleWithin(taskkill.exited, DOCKER_EXEC_TREE_TERMINATION_TIMEOUT_MS);
      if (result === null) {
        taskkill.kill("SIGKILL");
      } else if (
        result === 0 &&
        (await settleWithin(proc.exited, DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS)) !== null
      ) {
        return;
      }
    } catch {
      // Fall through to direct termination of the Docker client.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Process already exited.
  }
}

function parseClampedInt(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseClampedIntAllowZero(value: unknown, defaultValue: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? Math.floor(value)
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.max(0, Math.min(max, parsed));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildDependencySnapshotGcFunctionCommand(): string {
  return [
    "gc_dependency_snapshots() {",
    '  gc_cache_root="$1"',
    '  gc_current_key="${2:-}"',
    '  gc_now="$(date +%s)"',
    "  find \"$gc_cache_root\" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\\n' | sort -nr | (",
    "    gc_snapshot_count=0",
    "    while IFS=' ' read -r gc_mtime gc_snapshot_root; do",
    '      [ -n "$gc_snapshot_root" ] || continue',
    '      gc_snapshot_name="${gc_snapshot_root##*/}"',
    "      if ! printf '%s' \"$gc_snapshot_name\" | grep -Eq '^[0-9a-f]{64}$'; then continue; fi",
    "      gc_snapshot_count=$((gc_snapshot_count + 1))",
    '      [ "$gc_snapshot_name" != "$gc_current_key" ] || continue',
    '      if find "$store_root/projections" -type f -name .pushpals-dependency-snapshot -exec grep -Fqx "$gc_snapshot_name" {} \\; -print -quit | grep -q .; then continue; fi',
    '      gc_mtime_seconds="${gc_mtime%%.*}"',
    "      gc_age_seconds=$((gc_now - gc_mtime_seconds))",
    '      if [ "$gc_snapshot_count" -le "$dependency_snapshot_max_entries" ] && [ "$gc_age_seconds" -le "$dependency_snapshot_max_age_seconds" ]; then continue; fi',
    '      exec 8>"$gc_snapshot_root.lock"',
    "      if ! flock -n 8; then exec 8>&-; continue; fi",
    '      if find "$store_root/projections" -type f -name .pushpals-dependency-snapshot -exec grep -Fqx "$gc_snapshot_name" {} \\; -print -quit | grep -q .; then flock -u 8; exec 8>&-; continue; fi',
    '      rm -rf -- "$gc_snapshot_root"',
    "      flock -u 8",
    "      exec 8>&-",
    "    done",
    "  )",
    "}",
  ].join("\n");
}

export function buildDependencyStoreReconciliationCommand(
  dependencyStoreRoot = "/workspace/.pushpals/dependency-store",
  hostWorktreeRoot = "/repo/.worktrees",
): string {
  const storeRoot = shellSingleQuote(dependencyStoreRoot);
  const worktreeRoot = shellSingleQuote(hostWorktreeRoot);
  return [
    "set -eu",
    `store_root=${storeRoot}`,
    `worktree_root=${worktreeRoot}`,
    `dependency_snapshot_max_entries=${DEPENDENCY_SNAPSHOT_MAX_ENTRIES}`,
    `dependency_snapshot_max_age_seconds=${DEPENDENCY_SNAPSHOT_MAX_AGE_SECONDS}`,
    buildDependencySnapshotGcFunctionCommand(),
    'mkdir -p "$store_root/snapshots" "$store_root/projections"',
    'find "$store_root/projections" -mindepth 1 -maxdepth 1 -type d -print | while IFS= read -r projection_root; do',
    '  projection_id="${projection_root##*/}"',
    '  case "$projection_id" in job-*|selfcheck-*) ;; *) continue ;; esac',
    '  if [ ! -d "$worktree_root/$projection_id" ]; then rm -rf -- "$projection_root"; fi',
    "done",
    'for dependency_cache_root in "$store_root"/snapshots/linux-*; do',
    '  [ -d "$dependency_cache_root" ] || continue',
    '  gc_dependency_snapshots "$dependency_cache_root" ""',
    "done",
  ].join("\n");
}

export function buildWorktreeDependencyPreparationCommand(
  containerWorktreePath: string,
  dependencyStoreRoot = "/workspace/.pushpals/dependency-store",
): string {
  const worktree = shellSingleQuote(containerWorktreePath);
  const storeRoot = shellSingleQuote(dependencyStoreRoot);
  return [
    "set -eu",
    `worktree=${worktree}`,
    `store_root=${storeRoot}`,
    `dependency_snapshot_max_entries=${DEPENDENCY_SNAPSHOT_MAX_ENTRIES}`,
    `dependency_snapshot_max_age_seconds=${DEPENDENCY_SNAPSHOT_MAX_AGE_SECONDS}`,
    buildDependencySnapshotGcFunctionCommand(),
    "worktree_id=\"$(printf '%s' \"${worktree##*/}\" | tr -cd 'A-Za-z0-9_.-')\"",
    'projection_root="$store_root/projections/$worktree_id"',
    'projection_node_modules="$projection_root/node_modules"',
    'progress() { printf \'[DependencyPreparation] phase=%s progress=%s\\n\' "$1" "$2" >&2; }',
    'mkdir -p "$store_root/snapshots" "$store_root/projections"',
    "progress inspect 5",
    'linked=""',
    'if [ -f "$worktree/package.json" ] && { [ -f "$worktree/bun.lock" ] || [ -f "$worktree/bun.lockb" ]; }; then',
    // Both the immutable snapshot and the per-job projection live in a named
    // Linux volume. Only one symlink is created through the Windows bind mount.
    '  dependency_cache_root="$store_root/snapshots/linux-$(uname -m)"',
    '  mkdir -p "$dependency_cache_root"',
    `  snapshot_key="$( { printf 'projection=${VALIDATION_SAFE_DEPENDENCY_PROJECTION_VERSION}\\nbun=%s\\n' "$(bun --version)"; for manifest in "$worktree/package.json" "$worktree/bun.lock" "$worktree/bun.lockb"; do [ ! -f "$manifest" ] || sha256sum "$manifest" | cut -d " " -f 1; done; } | sha256sum | cut -d " " -f 1)"`,
    '  snapshot_root="$dependency_cache_root/$snapshot_key"',
    '  snapshot_ready="$snapshot_root/.pushpals-dependency-ready"',
    '  snapshot_lock="$snapshot_root.lock"',
    '  workspace_placeholder="/__pushpals_worktree__"',
    '  exec 9>"$snapshot_lock"',
    "  progress snapshot_lock 10",
    "  if ! flock -w 300 9; then",
    "    printf 'Timed out waiting for Linux-native dependency snapshot lock: %s\\n' \"$snapshot_lock\" >&2",
    "    exit 1",
    "  fi",
    // The shared files are read-only, but the worker runs as root and can
    // technically override that permission. Detect any content write by its
    // mtime and invalidate the snapshot before another job projects it.
    '  if [ -f "$snapshot_ready" ] && find "$snapshot_root/node_modules" -type f -newer "$snapshot_ready" -print -quit | grep -q .; then',
    "    printf 'Discarding modified Linux-native dependency snapshot: %s\\n' \"$snapshot_root\" >&2",
    '    rm -f "$snapshot_ready"',
    "  fi",
    '  if [ -f "$snapshot_ready" ]; then progress snapshot_cache_hit 25; else progress snapshot_cache_miss 10; fi',
    '  if [ ! -f "$snapshot_ready" ]; then',
    '      cleanup_dependency_install() { rm -rf "$worktree/node_modules"; rm -rf "$snapshot_root"; }',
    "      trap cleanup_dependency_install EXIT INT TERM",
    '      rm -rf "$snapshot_root"',
    '      mkdir -p "$snapshot_root/node_modules"',
    '      rm -rf "$worktree/node_modules"',
    '      ln -s "$snapshot_root/node_modules" "$worktree/node_modules"',
    "      progress install 20",
    '      (cd "$worktree" && bun install --frozen-lockfile --ignore-scripts >&2)',
    "      progress install_complete 70",
    '      rm -f "$worktree/node_modules"',
    // Replace workspace links with a stable placeholder before caching. Bun
    // emits absolute links into the ephemeral worktree; projections restore
    // those links for their own exact worktree without changing cache keys.
    '      find "$snapshot_root/node_modules" -type l -print | while IFS= read -r workspace_link; do',
    '        resolved_link="$(readlink -f "$workspace_link" 2>/dev/null || true)"',
    '        case "$resolved_link" in',
    '          "$worktree") workspace_relative="" ;;',
    '          "$worktree"/*) workspace_relative="${resolved_link#"$worktree"/}" ;;',
    "          *) continue ;;",
    "        esac",
    '        rm -f "$workspace_link"',
    '        ln -s "$workspace_placeholder${workspace_relative:+/$workspace_relative}" "$workspace_link"',
    "      done",
    '      find "$snapshot_root/node_modules" -type f -exec chmod a-w {} +',
    '      printf \'%s\\n\' "$snapshot_key" > "$snapshot_ready"',
    "      trap - EXIT INT TERM",
    "  fi",
    '  src="$snapshot_root/node_modules"',
    "  progress projection 80",
    '  rm -rf "$projection_root"',
    '  mkdir -p "$projection_node_modules"',
    '  : > "$projection_node_modules/.pushpals-dependency-projection-in-progress"',
    // Reflinks provide an inexpensive copy-on-write projection when the
    // volume filesystem supports them; GNU cp safely falls back to ordinary
    // copies otherwise. Never hardlink snapshot files into a job: the worker
    // runs as root, so a write through one projection could mutate the shared
    // inode and contaminate concurrently running jobs.
    '  cp -a --reflink=auto "$src/." "$projection_node_modules/"',
    '  find "$projection_node_modules" -type l -print | while IFS= read -r workspace_link; do',
    '    workspace_target="$(readlink "$workspace_link" 2>/dev/null || true)"',
    '    case "$workspace_target" in',
    '      "$workspace_placeholder"|"$workspace_placeholder"/*)',
    '        workspace_relative="${workspace_target#"$workspace_placeholder"}"',
    '        workspace_relative="${workspace_relative#/}"',
    '        rm -f "$workspace_link"',
    '        ln -s "$worktree${workspace_relative:+/$workspace_relative}" "$workspace_link"',
    "        ;;",
    "    esac",
    "  done",
    '  rm -rf "$projection_node_modules/.cache" "$projection_node_modules/.expo" "$projection_node_modules/.vite" "$projection_node_modules/.vite-temp"',
    "  for mutable in .cache .expo .vite .vite-temp; do",
    '    mkdir -p "$projection_node_modules/$mutable"',
    "  done",
    '  rm -f "$projection_node_modules/.pushpals-dependency-projection-in-progress"',
    '  printf \'%s\\n\' "$snapshot_key" > "$projection_node_modules/.pushpals-dependency-snapshot"',
    '  printf \'%s\\n\' "$snapshot_key" > "$projection_node_modules/.pushpals-validation-safe-dependency-snapshot"',
    '  rm -rf "$worktree/node_modules"',
    '  ln -s "$projection_node_modules" "$worktree/node_modules"',
    '  gc_dependency_snapshots "$dependency_cache_root" "$snapshot_key"',
    "  flock -u 9",
    '  linked="$linked node_modules-container-native"',
    "else",
    "  progress host_fallback 20",
    "  for name in node_modules; do",
    '    src="/repo/$name"',
    '    dest="$worktree/$name"',
    '    if { [ -e "$src" ] || [ -L "$src" ]; }; then',
    `      snapshot_key="$( { printf 'projection=${VALIDATION_SAFE_DEPENDENCY_PROJECTION_VERSION}\\nbun=%s\\n' "$(bun --version)"; for manifest in "$worktree/package.json" "$worktree/bun.lock" "$worktree/bun.lockb"; do [ ! -f "$manifest" ] || sha256sum "$manifest" | cut -d " " -f 1; done; } | sha256sum | cut -d " " -f 1)"`,
    '      rm -rf "$projection_root"',
    '      mkdir -p "$projection_node_modules"',
    '      for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do',
    '        if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
    '        entry_name="${entry##*/}"',
    '        case "$entry_name" in',
    "          .cache|.expo|.vite|.vite-temp|.pushpals-dependency-snapshot|.pushpals-dependency-projection-in-progress) continue ;;",
    "        esac",
    '        ln -s "$entry" "$projection_node_modules/$entry_name"',
    "      done",
    "      for mutable in .cache .expo .vite .vite-temp; do",
    '        mkdir -p "$projection_node_modules/$mutable"',
    "      done",
    '      printf \'%s\\n\' "$snapshot_key" > "$projection_node_modules/.pushpals-dependency-snapshot"',
    '      rm -rf "$dest"',
    '      ln -s "$projection_node_modules" "$dest"',
    '      linked="$linked $name-container-native-fallback"',
    "    fi",
    "  done",
    "fi",
    "progress complete 100",
    "printf '%s' \"$linked\"",
  ].join("\n");
}

function resolveDockerExecutable(): string {
  const absolute = String(process.env.PUSHPALS_DOCKER_BIN_ABSOLUTE ?? "").trim();
  if (absolute) return absolute;
  const configured = String(process.env.PUSHPALS_DOCKER_BIN ?? "").trim();
  if (configured) return configured;
  return process.platform === "win32" ? "docker.exe" : "docker";
}

export function resolveWorkerpalDockerBuildCaSecretArgs(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const configured = String(
    env.PUSHPALS_DOCKER_BUILD_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS ?? "",
  ).trim();
  if (!configured) return [];
  const path = resolve(configured);
  if (!fileExists(path)) return [];
  return ["--secret", `id=${WORKERPAL_SANDBOX_EXTRA_CA_SECRET_ID},src=${path}`];
}

export function resolveWorkerpalDockerRuntimeCaArgs(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
  dockerHostPath: (path: string) => string = (path) => path,
): string[] {
  const configured = String(
    env.PUSHPALS_DOCKER_RUNTIME_EXTRA_CA_CERTS ??
      env.PUSHPALS_DOCKER_BUILD_EXTRA_CA_CERTS ??
      env.NODE_EXTRA_CA_CERTS ??
      "",
  ).trim();
  if (!configured) return [];
  const path = resolve(configured);
  if (!fileExists(path)) return [];
  return [
    "--mount",
    `type=bind,src=${dockerHostPath(path)},dst=${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH},readonly`,
    "-e",
    `NODE_EXTRA_CA_CERTS=${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH}`,
    "-e",
    `SSL_CERT_FILE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `GIT_SSL_CAINFO=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `REQUESTS_CA_BUNDLE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `CURL_CA_BUNDLE=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    "-e",
    `PIP_CERT=${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
  ];
}

export function prependWorkerpalRuntimeCaStartup(
  startupCommand: string,
  runtimeCaEnabled: boolean,
): string {
  if (!runtimeCaEnabled) return startupCommand;
  return [
    "set -eu",
    "mkdir -p /run/pushpals",
    `cat ${WORKERPAL_SANDBOX_SYSTEM_CA_PATH} ${WORKERPAL_SANDBOX_HOST_EXTRA_CA_PATH} > ${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    `chmod 0444 ${WORKERPAL_SANDBOX_MERGED_CA_PATH}`,
    startupCommand,
  ].join("; ");
}

function resolveWorkerpalSandboxBuildContext(repoRoot: string): {
  root: string;
  dockerfilePath: string;
} {
  const configuredRoot = String(process.env.PUSHPALS_WORKERPALS_SANDBOX_ROOT ?? "").trim();
  const sandboxRoot = configuredRoot || repoRoot;
  const dockerfilePath = configuredRoot
    ? resolve(sandboxRoot, "apps", "workerpals", "Dockerfile.sandbox")
    : resolve(repoRoot, "apps", "workerpals", "Dockerfile.sandbox");
  return {
    root: sandboxRoot,
    dockerfilePath,
  };
}

function resolveWorkerpalRuntimeTag(): string {
  return String(process.env.PUSHPALS_RUNTIME_TAG ?? "").trim();
}

function dockerBuildFileArg(root: string, dockerfilePath: string): string {
  const relativePath = relative(root, dockerfilePath).replace(/\\/g, "/").trim();
  return relativePath || "apps/workerpals/Dockerfile.sandbox";
}

function isMissingDockerImageDetail(detail: string): boolean {
  const text = String(detail ?? "");
  return (
    /\b(no such object|no such image|not found)\b/i.test(text) ||
    /\bunable to find image\b.*\blocally\b/i.test(text) ||
    /\bpull access denied\b.*\brepository does not exist\b/i.test(text)
  );
}

type ParsedWorktreeRecord = {
  path: string;
  detached: boolean;
  prunable: boolean;
};

function normalizePathForMatching(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function isEphemeralWorkerWorktreePath(path: string): boolean {
  const normalized = normalizePathForMatching(path);
  const marker = "/.worktrees/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const leaf = normalized.slice(markerIndex + marker.length);
  return leaf.startsWith("job-") || leaf.startsWith("selfcheck-");
}

export function parseGitWorktreeListPorcelain(output: string): ParsedWorktreeRecord[] {
  const blocks = output
    .split(/\r?\n\r?\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const records: ParsedWorktreeRecord[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/g).map((line) => line.trim());
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    records.push({
      path: pathLine.slice("worktree ".length).trim(),
      detached: lines.includes("detached"),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }

  return records;
}

export function collectPrunableEphemeralWorktrees(output: string): string[] {
  return parseGitWorktreeListPorcelain(output)
    .filter((entry) => entry.prunable && isEphemeralWorkerWorktreePath(entry.path))
    .map((entry) => entry.path);
}

export function buildLinuxWorktreeAddArgs(
  worktreePath: string,
  baseRef: string,
  force = false,
): string[] {
  return [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "worktree",
    "add",
    ...(force ? ["--force"] : []),
    "--detach",
    worktreePath,
    baseRef,
  ];
}

export class DockerExecutionExhaustedError extends Error {
  readonly cooldownMs: number;
  readonly category: "warm_setup" | "job_execution";
  candidateState?: JobCandidateState;

  constructor(category: "warm_setup" | "job_execution", message: string, cooldownMs: number) {
    super(message);
    this.name = "DockerExecutionExhaustedError";
    this.category = category;
    this.cooldownMs = Math.max(0, Math.floor(cooldownMs));
  }
}

export interface DockerExecutorOptions {
  /** Path to the git repository on the host */
  repo: string;
  /** Worker ID for naming */
  workerId: string;
  /** Docker image to use */
  imageName: string;
  /** Git token for pushing from container */
  gitToken?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Idle shutdown timeout for the warm container in milliseconds */
  idleTimeoutMs?: number;
  /** Git ref used as the base for per-job worktrees */
  baseRef?: string;
  /** Docker network mode for warm container (e.g. bridge, none) */
  networkMode?: string;
  /** Shared runtime config loaded by worker entrypoint */
  config?: WorkerpalsRuntimeConfig;
}

export interface DockerJobResult {
  ok: boolean;
  summary: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cooldownMs?: number;
  usage?: JobTokenUsage;
  usageAttempts?: JobUsageAttempt[];
  candidateState?: JobCandidateState;
  publishBlocked?: {
    summary: string;
    detail: string;
    publicBranch: string;
    localRef: string;
    sha: string;
    stage: "sync" | "push" | "validation";
  };
  validationBlocked?: {
    category: "environment";
    summary: string;
    detail: string;
    commands: string[];
  };
  commit?: {
    branch: string;
    sha: string;
    publicBranch?: string;
  };
  diagnostics?: JobDiagnostics;
}

export function addHostScmReviewPassUsage(
  accumulator: UsageAccumulator,
  result: Pick<DockerJobResult, "usage" | "usageAttempts" | "exitCode">,
  pass: number,
): void {
  if ((result.usageAttempts?.length ?? 0) > 0) {
    const attemptOffset = accumulator.attempts().length;
    accumulator.addAttempts(
      (result.usageAttempts ?? []).map((attempt, index) => ({
        ...attempt,
        attempt: attemptOffset + index + 1,
        source: `${attempt.source}:host_scm_pass_${pass}`,
      })),
    );
    return;
  }
  accumulator.add(result.usage, {
    stage: pass === 1 ? "executor" : "executor_recovery",
    attempt: accumulator.attempts().length + 1,
    source: `host_scm_owned_review:pass_${pass}`,
    timedOut: result.exitCode === 124,
  });
}

export function addHostScmFinalizationUsage(
  accumulator: UsageAccumulator,
  result: { usage?: JobTokenUsage; usageAttempts?: JobUsageAttempt[] },
  pass: number,
): void {
  if ((result.usageAttempts?.length ?? 0) > 0) {
    const attemptOffset = accumulator.attempts().length;
    accumulator.addAttempts(
      (result.usageAttempts ?? []).map((attempt, index) => ({
        ...attempt,
        stage: "finalization",
        attempt: attemptOffset + index + 1,
        source: `${attempt.source}:host_scm_finalization_pass_${pass}`,
      })),
    );
    return;
  }
  accumulator.add(result.usage, {
    stage: "finalization",
    attempt: accumulator.attempts().length + 1,
    source: `host_scm_finalization:pass_${pass}`,
  });
}

export function addDockerTransportAttemptUsage(
  accumulator: UsageAccumulator,
  result: Pick<DockerJobResult, "usage" | "usageAttempts" | "exitCode">,
  attempt: number,
): void {
  const attemptOffset = accumulator.attempts().length;
  if ((result.usageAttempts?.length ?? 0) > 0) {
    accumulator.addAttempts(
      (result.usageAttempts ?? []).map((usageAttempt, index) => ({
        ...usageAttempt,
        attempt: attemptOffset + index + 1,
        source: `${usageAttempt.source}:docker_transport_attempt_${attempt}`,
      })),
    );
    return;
  }
  accumulator.add(result.usage, {
    stage: attempt === 1 ? "executor" : "executor_recovery",
    attempt: attemptOffset + 1,
    source: `docker_transport:attempt_${attempt}`,
    timedOut: result.exitCode === 124,
  });
}

export function attachHostScmUsageToError(
  accumulator: UsageAccumulator,
  error: unknown,
  pass: number,
): Error & { usage?: JobTokenUsage; usageAttempts?: JobUsageAttempt[] } {
  if (error && typeof error === "object") {
    addHostScmReviewPassUsage(
      accumulator,
      error as Pick<DockerJobResult, "usage" | "usageAttempts" | "exitCode">,
      Math.max(1, pass),
    );
  }
  const usageSnapshot = accumulator.apply<DockerJobResult>({
    ok: false,
    summary: `Host-side review pass ${Math.max(1, pass)} threw before completion`,
  });
  const propagatedError =
    error instanceof Error && Object.isExtensible(error)
      ? error
      : Object.assign(
          new Error(error instanceof Error ? error.message : String(error)),
          error && typeof error === "object" ? error : {},
        );
  if ((usageSnapshot.usageAttempts?.length ?? 0) > 0) {
    Object.assign(propagatedError, {
      usage: usageSnapshot.usage,
      usageAttempts: usageSnapshot.usageAttempts,
    });
  }
  return propagatedError;
}

interface DockerExecutionResultContext {
  timedOutByDocker: boolean;
  streamDrainTimedOut: boolean;
  elapsedMs: number;
  timeoutMs: number;
}

export interface Job {
  id: string;
  taskId: string;
  kind: string;
  params: Record<string, unknown>;
  sessionId: string;
}

function compactDockerDiagnosticText(value: unknown, maxChars = 1000): string | null {
  const text = String(value ?? "")
    .replace(/\s+$/g, "")
    .trim();
  if (!text) return null;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function dockerFallbackDiagnostics(
  summary: string,
  context: DockerExecutionResultContext,
  exitCode: number,
  failureClass: string,
  metadata: Record<string, unknown> = {},
): JobDiagnostics {
  return {
    terminal: {
      failureClass,
      terminalStage: "docker",
      summary: compactDockerDiagnosticText(summary),
      watchdogFired: context.timedOutByDocker === true || context.streamDrainTimedOut === true,
      timeoutMs: context.timeoutMs,
      metadata: {
        structuredResult: false,
        elapsedMs: context.elapsedMs,
        exitCode,
        timedOutByDocker: context.timedOutByDocker,
        streamDrainTimedOut: context.streamDrainTimedOut === true,
        ...metadata,
      },
    },
  };
}

function appendDockerFailureDetail(existing: unknown, detail: string): string {
  return [String(existing ?? "").trim(), detail.trim()].filter(Boolean).join("\n");
}

function dockerStructuredProcessFailureDiagnostics(
  existing: JobDiagnostics | undefined,
  summary: string,
  context: DockerExecutionResultContext,
  exitCode: number,
  failureClass: string,
  structuredResultSchemaValid = true,
): JobDiagnostics {
  return {
    ...(existing ?? {}),
    terminal: {
      ...(existing?.terminal ?? {}),
      failureClass,
      terminalStage: "docker",
      summary: compactDockerDiagnosticText(summary),
      watchdogFired: context.timedOutByDocker === true || context.streamDrainTimedOut === true,
      timeoutMs: context.timeoutMs,
      metadata: {
        ...(existing?.terminal?.metadata ?? {}),
        structuredResult: true,
        elapsedMs: context.elapsedMs,
        exitCode,
        timedOutByDocker: context.timedOutByDocker,
        streamDrainTimedOut: context.streamDrainTimedOut === true,
        structuredResultSchemaValid,
        processStateOverrodeStructuredResult: true,
      },
    },
  };
}

function unstructuredDockerFailureClass(stdout: string, stderr: string): string {
  const terminalText = `${stderr}\n${stdout}`;
  if (
    /(?:\[JobRunner\] Fatal error|ENOENT|no such file or directory)/i.test(terminalText) &&
    /(?:\/workspace\/prompts|[\\/]prompts[\\/]|\[prompts\])/i.test(terminalText)
  ) {
    return "missing_runtime_asset";
  }
  if (/\[JobRunner\] Fatal error/i.test(terminalText)) return "worker_runtime_failure";
  return "no_structured_result";
}

function readPositiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function maybeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

function collectValidationCommandHints(params: Record<string, unknown>): string[] {
  const planning = maybeRecord(params.planning);
  const values: unknown[] = [
    params.instruction,
    params.plannerWorkerInstruction,
    params.validationSteps,
    params.requiredValidationSteps,
    planning?.validationSteps,
    planning?.requiredValidationSteps,
  ];
  const commands: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      commands.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      commands.push(...value.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  return commands;
}

function hasBrowserValidationCommand(job: Pick<Job, "kind" | "params">): boolean {
  if (job.kind !== "task.execute") return false;
  return collectValidationCommandHints(job.params).some((command) =>
    /\b(web:e2e|e2e:web|browser:e2e|smoke:web|web:smoke|browser:smoke|playwright|cypress)\b/i.test(
      command,
    ),
  );
}

export function resolveDockerJobTimeoutMs(
  configuredTimeoutMs: number,
  job: Pick<Job, "kind" | "params">,
): number {
  const baseTimeoutMs = Math.max(10_000, Math.floor(configuredTimeoutMs));
  if (!hasBrowserValidationCommand(job)) return baseTimeoutMs;

  const planning = maybeRecord(job.params.planning);
  const executionBudgetMs = readPositiveNumber(planning?.executionBudgetMs) ?? 1_200_000;
  const finalizationBudgetMs = readPositiveNumber(planning?.finalizationBudgetMs) ?? 120_000;
  const attempts = BROWSER_VALIDATION_JOB_REPAIR_ATTEMPTS + 1; // initial attempt plus repairs
  const estimatedTimeoutMs =
    attempts * (executionBudgetMs + finalizationBudgetMs + BROWSER_VALIDATION_JOB_OVERHEAD_MS);
  const boundedTimeoutMs = Math.min(
    BROWSER_VALIDATION_JOB_MAX_TIMEOUT_MS,
    Math.max(BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS, estimatedTimeoutMs),
  );
  return Math.max(Math.min(baseTimeoutMs, boundedTimeoutMs), BROWSER_VALIDATION_JOB_MIN_TIMEOUT_MS);
}

export function resolveDockerJobDeadlineBudgets(
  configuredTimeoutMs: number,
  job: Pick<Job, "kind" | "params">,
): { executionBudgetMs: number; finalizationBudgetMs: number } {
  const totalTimeoutMs = resolveDockerJobTimeoutMs(configuredTimeoutMs, job);
  const planning = maybeRecord(job.params.planning);
  const requestedExecutionBudgetMs = readPositiveNumber(planning?.executionBudgetMs);
  const requestedFinalizationBudgetMs = readPositiveNumber(planning?.finalizationBudgetMs);
  if (requestedExecutionBudgetMs === null || requestedFinalizationBudgetMs === null) {
    // Legacy and warmup jobs do not carry planner budgets, but they still
    // create host worktrees. Reserve a bounded share for candidate-safe
    // cleanup instead of allowing setup/execution to consume the entire
    // transport timeout and strand a registered worktree.
    const finalizationBudgetMs = Math.min(
      DEFAULT_UNPLANNED_FINALIZATION_BUDGET_MAX_MS,
      Math.max(1, Math.floor(totalTimeoutMs / DEFAULT_UNPLANNED_FINALIZATION_BUDGET_DIVISOR)),
      Math.max(1, totalTimeoutMs - 1),
    );
    return {
      executionBudgetMs: Math.max(1, totalTimeoutMs - finalizationBudgetMs),
      finalizationBudgetMs,
    };
  }

  // The outer transport deadline may be stricter than a planner-provided
  // budget. Preserve finalization headroom first, then expose only the
  // remaining portion to edit/validation work.
  const finalizationBudgetMs = Math.min(
    requestedFinalizationBudgetMs,
    Math.max(0, totalTimeoutMs - 1),
  );
  return {
    executionBudgetMs: Math.min(
      requestedExecutionBudgetMs,
      Math.max(1, totalTimeoutMs - finalizationBudgetMs),
    ),
    finalizationBudgetMs,
  };
}

export function createDockerJobDeadlineLedger(
  configuredTimeoutMs: number,
  job: Pick<Job, "kind" | "params">,
  options: { startedAtMs?: number; now?: () => number; monotonicNow?: () => number } = {},
): JobDeadlineLedger {
  const budgets = resolveDockerJobDeadlineBudgets(configuredTimeoutMs, job);
  return new JobDeadlineLedger({ ...budgets, ...options });
}

/**
 * Rewrites the next container invocation to borrow from the host's absolute
 * ledger. This is intentionally repeated immediately before every retry and
 * host-owned review pass so no executeJob process can mint a new budget.
 */
export function bindDockerJobToDeadline(job: Job, ledger: JobDeadlineLedger): Job | null {
  if (ledger.workExpired()) return null;
  const planning = maybeRecord(job.params.planning);
  const requestedExecutionBudgetMs = readPositiveNumber(planning?.executionBudgetMs);
  const requestedFinalizationBudgetMs = readPositiveNumber(planning?.finalizationBudgetMs);
  if (
    planning === null ||
    requestedExecutionBudgetMs === null ||
    requestedFinalizationBudgetMs === null
  ) {
    return job;
  }
  const budgets = ledger.executorBudgets(requestedExecutionBudgetMs, requestedFinalizationBudgetMs);
  if (!budgets || budgets.finalizationBudgetMs <= 0) return null;
  return {
    ...job,
    params: {
      ...job.params,
      planning: {
        ...planning,
        executionBudgetMs: budgets.executionBudgetMs,
        finalizationBudgetMs: budgets.finalizationBudgetMs,
      },
    },
  };
}

/**
 * Planned jobs perform their candidate-safe finalization inside the worker
 * process and may therefore use the ledger's total remaining budget. Legacy
 * and warmup jobs have no valid inner finalization plan, so their transport
 * must stop at the work boundary and leave the reserved tail for host-owned
 * dependency and worktree cleanup.
 */
export function resolveDockerContainerTransportTimeoutMs(
  configuredTimeoutMs: number,
  job: Pick<Job, "params">,
  ledger?: JobDeadlineLedger,
): number {
  if (!ledger) return Math.max(0, configuredTimeoutMs);
  const planning = maybeRecord(job.params.planning);
  const hasValidInnerFinalizationPlan =
    readPositiveNumber(planning?.executionBudgetMs) !== null &&
    readPositiveNumber(planning?.finalizationBudgetMs) !== null;
  const remainingDeadlineMs = hasValidInnerFinalizationPlan
    ? ledger.remainingTotalMs()
    : ledger.remainingWorkMs();
  return Math.max(0, Math.min(configuredTimeoutMs, remainingDeadlineMs));
}

export function dockerAbsoluteDeadlineResult(
  job: Pick<Job, "id">,
  ledger: JobDeadlineLedger,
  stage: string,
  priorResult?: DockerJobResult,
): DockerJobResult {
  const detail = `The absolute Docker job deadline was exhausted during ${stage}; retries and host-owned review passes share one wall-clock budget.`;
  return {
    ...(priorResult ?? {}),
    ok: false,
    summary: `Docker job ${job.id} reached its absolute deadline`,
    stderr: appendDockerFailureDetail(priorResult?.stderr, detail),
    exitCode: 124,
    candidateState: priorResult?.candidateState ?? {
      status: "partial",
      reason: "absolute_job_deadline",
      changedPaths: [],
    },
    diagnostics: {
      ...(priorResult?.diagnostics ?? {}),
      terminal: {
        ...(priorResult?.diagnostics?.terminal ?? {}),
        failureClass: "timeout",
        terminalStage: "docker",
        summary: detail,
        watchdogFired: true,
        timeoutMs: ledger.deadlineAtMs - ledger.startedAtMs,
        metadata: {
          ...(priorResult?.diagnostics?.terminal?.metadata ?? {}),
          absoluteDeadlineStage: stage,
          jobDeadline: ledger.snapshot(),
        },
      },
      metadata: {
        ...(priorResult?.diagnostics?.metadata ?? {}),
        jobDeadline: ledger.snapshot(),
      },
    },
  };
}

export class DockerExecutor {
  private options: Required<Omit<DockerExecutorOptions, "config">>;
  private worktreeDir: string;
  private warmContainerName: string;
  private dependencyVolumeName: string;
  private codexVolumeName: string;
  private warmAgentPort = 39231;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;
  private readonly warmAgentStartupTimeoutMs: number;
  private readonly warmAgentStartupPollMs: number = 200;
  private readonly warmSetupMaxAttempts: number;
  private readonly warmSetupBackoffMs: number;
  private readonly jobRetryMaxAttempts: number;
  private readonly jobRetryBackoffMs: number;
  private readonly failureCooldownMs: number;
  private readonly worktreeVisibilityTimeoutMs: number;
  private readonly dependencyPreparationTimeoutMs: number;
  private lastLoggedExecutionConfig = "";
  private lastLoggedEndpointRewrite = "";
  private warmedBackends = new Set<string>();
  private preparedDependencyProjectionIds = new Set<string>();
  private dependencyStoreReconciled = false;
  private preparedMergeConflictJobs = new Set<string>();
  private mergeConflictRefreshPromise: Promise<void> | null = null;
  private readonly config: WorkerpalsRuntimeConfig;
  private deadlineWallNow: () => number = () => Date.now();
  private deadlineMonotonicNow: () => number = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  constructor(options: DockerExecutorOptions) {
    const { config, ...optionValues } = options;
    this.config = config ?? DEFAULT_CONFIG;
    const startupTimeoutMs = parseClampedInt(
      this.config.workerpals.dockerAgentStartupTimeoutMs,
      45_000,
      10_000,
      180_000,
    );

    this.options = {
      gitToken: "",
      // Keep headroom above backend wrapper timeout so the wrapper can emit
      // a structured timeout failure before Docker hard-kills the job.
      timeoutMs: DEFAULT_DOCKER_TIMEOUT_MS,
      idleTimeoutMs: 10 * 60 * 1000,
      baseRef: "HEAD",
      networkMode: "bridge",
      ...optionValues,
    };
    this.worktreeDir = resolve(this.options.repo, ".worktrees");
    this.warmContainerName = `pushpals-${this.options.workerId}-warm`;
    const dependencyRepoPath = resolve(this.options.repo);
    this.dependencyVolumeName = `pushpals-deps-${createHash("sha256")
      .update(process.platform === "win32" ? dependencyRepoPath.toLowerCase() : dependencyRepoPath)
      .digest("hex")
      .slice(0, 16)}`;
    this.codexVolumeName = `pushpals-codex-${createHash("sha256")
      .update(
        `${process.platform === "win32" ? dependencyRepoPath.toLowerCase() : dependencyRepoPath}\0${
          this.options.workerId
        }`,
      )
      .digest("hex")
      .slice(0, 20)}`;
    this.warmAgentStartupTimeoutMs = startupTimeoutMs;
    this.warmSetupMaxAttempts = parseClampedInt(
      this.config.workerpals.dockerWarmMaxAttempts,
      3,
      1,
      5,
    );
    this.warmSetupBackoffMs = parseClampedInt(
      this.config.workerpals.dockerWarmRetryBackoffMs,
      2_000,
      250,
      60_000,
    );
    this.jobRetryMaxAttempts = parseClampedInt(
      this.config.workerpals.dockerJobMaxAttempts,
      2,
      1,
      3,
    );
    this.jobRetryBackoffMs = parseClampedInt(
      this.config.workerpals.dockerJobRetryBackoffMs,
      3_000,
      250,
      60_000,
    );
    this.failureCooldownMs = parseClampedIntAllowZero(
      this.config.workerpals.failureCooldownMs,
      20_000,
      300_000,
    );
    this.worktreeVisibilityTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;
    this.dependencyPreparationTimeoutMs = parseClampedInt(
      this.config.workerpals.dependencyPreparationTimeoutMs,
      5 * 60_000,
      30_000,
      20 * 60_000,
    );

    // Ensure worktrees directory exists
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  /**
   * Execute a job in a Docker container with an isolated git worktree
   */
  async execute(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<DockerJobResult> {
    // Start the single outer ledger before any host-side worktree, review, or
    // warm-runtime preparation. Setup is part of the job and must not mint an
    // independent timeout before the container starts.
    const deadlineLedger = createDockerJobDeadlineLedger(this.options.timeoutMs, job, {
      startedAtMs: this.deadlineWallNow(),
      now: this.deadlineWallNow,
      monotonicNow: this.deadlineMonotonicNow,
    });
    this.activeJobs += 1;
    this.clearIdleTimer();
    const worktreeName = this.buildEphemeralWorktreeName("job", job.id);
    const worktreePath = resolve(this.worktreeDir, worktreeName);
    let terminalResult: DockerJobResult | null = null;
    let terminalError: unknown = null;
    let worktreeBaselineSha: string | null = null;
    let worktreeCreationStarted = false;
    let preserveWorktreeForCandidateRecovery = false;
    const accumulatedUsage = new UsageAccumulator();
    const finish = (result: DockerJobResult): DockerJobResult => {
      terminalResult = accumulatedUsage.apply(result);
      return terminalResult;
    };

    try {
      const worktreeBaseRef = await this.resolveWorktreeBaseRefForJob(job, onLog, deadlineLedger);
      // Step 1: Create isolated git worktree
      worktreeCreationStarted = true;
      await this.createWorktree(worktreePath, worktreeBaseRef, deadlineLedger);
      // Capture the immutable pre-preparation head before host SCM can rebase
      // or otherwise mutate it. If later preparation fails, checkpointing can
      // still distinguish and retain a clean committed candidate.
      const baseline = await this.runGitBaseRefCommand(
        ["-C", worktreePath, "rev-parse", "HEAD"],
        deadlineLedger,
      );
      if (!baseline.ok || !baseline.stdout.trim()) {
        throw new Error(
          `Unable to resolve disposable worktree baseline before preparation: ${baseline.stderr || baseline.stdout || "git rev-parse failed"}`,
        );
      }
      worktreeBaselineSha = baseline.stdout.trim();

      // Step 2: Prepare review Git state on the host before the container sees
      // the worktree. Review containers receive no branch/rebase/push duties.
      let effectiveJob: Job = job;
      if (isReviewResolutionParams(job.params)) {
        let effectiveParams = job.params;
        if (isMergeConflictResolutionParams(job.params)) {
          const prepared = await prepareMergeConflictWorktreeOnHost(
            worktreePath,
            job.id,
            job.params,
            onLog,
            deadlineLedger,
          );
          effectiveParams = applyMergeConflictExecutionHints(effectiveParams, prepared);
        }
        effectiveJob = {
          ...job,
          params: markHostScmGitOwnership(effectiveParams),
        };
      }
      // Step 3: Run Docker container with the worktree mounted
      for (let attempt = 1; attempt <= this.jobRetryMaxAttempts; attempt++) {
        const deadlineBoundJob = bindDockerJobToDeadline(effectiveJob, deadlineLedger);
        if (!deadlineBoundJob) {
          return finish(
            dockerAbsoluteDeadlineResult(job, deadlineLedger, `Docker attempt ${attempt} setup`),
          );
        }
        const attemptStartedAtMs = Date.now();
        try {
          this.logExecutionConfig();
          let result = isHostScmOwnedReviewParams(deadlineBoundJob.params)
            ? await this.runHostScmOwnedReviewJob(
                worktreePath,
                deadlineBoundJob,
                deadlineLedger,
                onLog,
              )
            : await this.runInWarmContainer(worktreePath, deadlineBoundJob, onLog, deadlineLedger);
          addDockerTransportAttemptUsage(accumulatedUsage, result, attempt);
          if (
            result.ok &&
            shouldCommit(effectiveJob.kind, this.config) &&
            !isHostScmOwnedReviewParams(effectiveJob.params) &&
            (!result.commit || !result.commit.branch || !result.commit.sha)
          ) {
            result = {
              ...result,
              ok: false,
              summary: `Docker job ${job.id} completed without durable commit metadata`,
              stderr: [
                result.stderr,
                "The container reported success for a file-modifying job without an exact retained ref/SHA; treating it as a finalization failure before worktree cleanup.",
              ]
                .filter(Boolean)
                .join("\n"),
              exitCode: 4,
              candidateState: result.candidateState ?? {
                status: "held",
                reason: "commit_finalization_failed",
                changedPaths: [],
              },
            };
          }
          if (deadlineLedger.remainingTotalMs() <= 0) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `Docker attempt ${attempt}`,
                result,
              ),
            );
          }
          if (result.ok) return finish(result);
          if (deadlineLedger.workExpired()) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `Docker attempt ${attempt}`,
                result,
              ),
            );
          }

          const retryableFailure = this.isRetryableJobFailure(result);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry =
            retryableFailure &&
            attempt < this.jobRetryMaxAttempts &&
            this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableFailure || !hasBudgetForRetry) {
            if (
              retryableFailure &&
              attempt >= this.jobRetryMaxAttempts &&
              this.retryExhaustionCooldownMs(result) > 0
            ) {
              return finish({
                ...result,
                cooldownMs: this.retryExhaustionCooldownMs(result),
              });
            }
            return finish(result);
          }

          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient job failure detected for ${job.id}; retrying attempt ${
            attempt + 1
          }/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          if (!this.hasAbsoluteBudgetForJobRetry(attempt, retryInMs, deadlineLedger, onLog)) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `retry backoff before attempt ${attempt + 1}`,
                result,
              ),
            );
          }
          await this.stopWarmContainer(
            "job retry after transient failure",
            true,
            Math.max(1, deadlineLedger.remainingWorkMs() - retryInMs),
          );
          if (!this.hasAbsoluteBudgetForJobRetry(attempt, retryInMs, deadlineLedger, onLog)) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `retry recovery before attempt ${attempt + 1}`,
                result,
              ),
            );
          }
          await this.sleep(retryInMs);
        } catch (err) {
          if (err && typeof err === "object") {
            addDockerTransportAttemptUsage(
              accumulatedUsage,
              err as Pick<DockerJobResult, "usage" | "usageAttempts" | "exitCode">,
              attempt,
            );
          }
          if (deadlineLedger.workExpired() || deadlineLedger.remainingTotalMs() <= 0) {
            return finish(
              dockerAbsoluteDeadlineResult(job, deadlineLedger, `Docker attempt ${attempt}`, {
                ok: false,
                summary: `Docker attempt ${attempt} failed at the absolute deadline`,
                stderr: this.compactError(err),
                exitCode: 124,
              }),
            );
          }
          const retryableError = this.isRetryableError(err);
          const attemptElapsedMs = Math.max(1, Date.now() - attemptStartedAtMs);
          const timeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, job);
          const hasBudgetForRetry =
            retryableError &&
            attempt < this.jobRetryMaxAttempts &&
            this.hasBudgetForJobRetry(attempt, attemptElapsedMs, timeoutMs, onLog);
          if (attempt >= this.jobRetryMaxAttempts || !retryableError || !hasBudgetForRetry) {
            if (
              retryableError &&
              attempt >= this.jobRetryMaxAttempts &&
              !(err instanceof DockerExecutionExhaustedError)
            ) {
              throw new DockerExecutionExhaustedError(
                "job_execution",
                `Docker execution retries exhausted after ${this.jobRetryMaxAttempts} attempts: ${this.compactError(
                  err,
                )}`,
                this.failureCooldownMs,
              );
            }
            throw err;
          }
          const retryInMs = this.backoffDelayMs(this.jobRetryBackoffMs, attempt);
          const note = `[DockerExecutor] Transient Docker execution error for ${job.id}: ${this.compactError(
            err,
          )}. Retrying attempt ${attempt + 1}/${this.jobRetryMaxAttempts} in ${retryInMs}ms.`;
          console.warn(note);
          onLog?.("stderr", note);
          if (!this.hasAbsoluteBudgetForJobRetry(attempt, retryInMs, deadlineLedger, onLog)) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `retry backoff before attempt ${attempt + 1}`,
              ),
            );
          }
          await this.stopWarmContainer(
            "job retry after execution error",
            true,
            Math.max(1, deadlineLedger.remainingWorkMs() - retryInMs),
          );
          if (!this.hasAbsoluteBudgetForJobRetry(attempt, retryInMs, deadlineLedger, onLog)) {
            return finish(
              dockerAbsoluteDeadlineResult(
                job,
                deadlineLedger,
                `retry recovery before attempt ${attempt + 1}`,
              ),
            );
          }
          await this.sleep(retryInMs);
        }
      }

      return finish({
        ok: false,
        summary: "Docker job retries exhausted",
        stderr: `Retries exhausted after ${this.jobRetryMaxAttempts} attempts`,
      });
    } catch (error) {
      if (deadlineLedger.workExpired() || deadlineLedger.remainingTotalMs() <= 0) {
        return finish(
          dockerAbsoluteDeadlineResult(job, deadlineLedger, "host/Docker preparation", {
            ok: false,
            summary: `Docker preparation for ${job.id} reached the absolute deadline`,
            stderr: this.compactError(error),
            exitCode: 124,
          }),
        );
      }
      const propagatedError = error instanceof Error ? error : new Error(String(error));
      const usageSnapshot = accumulatedUsage.apply<DockerJobResult>({
        ok: false,
        summary: `Docker execution threw before completion: ${this.compactError(propagatedError)}`,
      });
      if ((usageSnapshot.usageAttempts?.length ?? 0) > 0) {
        Object.assign(propagatedError, {
          usage: usageSnapshot.usage,
          usageAttempts: usageSnapshot.usageAttempts,
        });
      }
      terminalError = propagatedError;
      throw propagatedError;
    } finally {
      this.preparedMergeConflictJobs.delete(job.id);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      await this.cleanupContainerDependencyProjection(worktreePath, deadlineLedger);
      const postProjectionResult = terminalResult as DockerJobResult | null;
      if (postProjectionResult?.ok && deadlineLedger.remainingTotalMs() <= 0) {
        Object.assign(
          postProjectionResult,
          dockerAbsoluteDeadlineResult(
            job,
            deadlineLedger,
            "dependency-projection finalization",
            postProjectionResult,
          ),
        );
      }
      const resultForCleanup = (terminalResult ??
        (terminalError
          ? {
              ok: false,
              summary: `Docker execution threw before producing a structured result: ${this.compactError(terminalError)}`,
              candidateState: {
                status: "partial",
                reason: "execution_exception",
                changedPaths: [],
              },
            }
          : null)) as DockerJobResult | null;
      const setupWorktreeNeedsReconciliation =
        worktreeCreationStarted && worktreeBaselineSha === null;
      if (
        resultForCleanup &&
        !resultForCleanup.ok &&
        existsSync(worktreePath) &&
        !setupWorktreeNeedsReconciliation
      ) {
        const candidateState =
          resultForCleanup.candidateState ??
          ({
            status: resultForCleanup.exitCode === 124 ? "partial" : "held",
            reason: resultForCleanup.exitCode === 124 ? "execution_timeout" : "terminal_failure",
            changedPaths: [],
          } satisfies JobCandidateState);
        try {
          const checkpointed = await checkpointJobCandidate(
            worktreePath,
            this.options.workerId,
            job,
            candidateState,
            this.config,
            worktreeBaselineSha,
            deadlineLedger,
          );
          if (checkpointed.checkpoint) {
            resultForCleanup.candidateState = checkpointed;
            if (
              terminalError &&
              typeof terminalError === "object" &&
              Object.isExtensible(terminalError)
            ) {
              try {
                Object.assign(terminalError, { candidateState: checkpointed });
              } catch {
                // The durable Git ref is authoritative even if an unusual
                // thrown object cannot carry structured candidate metadata.
              }
            }
            resultForCleanup.stderr = [
              resultForCleanup.stderr,
              `Candidate checkpoint retained at ${checkpointed.checkpoint.ref} (${checkpointed.checkpoint.sha}).`,
            ]
              .filter(Boolean)
              .join("\n");
            onLog?.(
              "stderr",
              `[DockerExecutor] Retained ${checkpointed.status} candidate ${checkpointed.checkpoint.sha.slice(0, 12)} before disposable worktree cleanup.`,
            );
          }
        } catch (error) {
          preserveWorktreeForCandidateRecovery = true;
          resultForCleanup.candidateState = candidateState;
          resultForCleanup.stderr = [
            resultForCleanup.stderr,
            `Candidate checkpoint failed; preserving disposable worktree for recovery at ${worktreePath}: ${this.compactError(error)}`,
          ]
            .filter(Boolean)
            .join("\n");
          if (
            terminalError &&
            typeof terminalError === "object" &&
            Object.isExtensible(terminalError)
          ) {
            try {
              Object.assign(terminalError, {
                candidateState,
                candidateWorktreePath: worktreePath,
              });
            } catch {
              // Preserve the physical worktree even when the thrown value is immutable.
            }
          }
          onLog?.(
            "stderr",
            `[DockerExecutor] Candidate checkpoint failed; preserving worktree ${worktreePath}: ${this.compactError(error)}`,
          );
        }
      }
      // Step 4: Clean up only after the candidate is either absent or reachable
      // from a durable Git ref. A checkpoint failure must never destroy the
      // sole remaining copy of a partial patch.
      if (!preserveWorktreeForCandidateRecovery) {
        await this.removeWorktree(worktreePath, deadlineLedger, {
          ensureReconciliation: setupWorktreeNeedsReconciliation,
        }).catch((err) => {
          console.error(`[DockerExecutor] Failed to remove worktree: ${err}`);
        });
      }
      const postCleanupResult = terminalResult as DockerJobResult | null;
      if (postCleanupResult?.ok && deadlineLedger.remainingTotalMs() <= 0) {
        Object.assign(
          postCleanupResult,
          dockerAbsoluteDeadlineResult(
            job,
            deadlineLedger,
            "worktree finalization",
            postCleanupResult,
          ),
        );
      }
      this.scheduleIdleShutdown();
    }
  }

  /**
   * Validate that a host-created worktree is usable by git inside the Linux
   * worker container. This catches host/container path mapping issues early.
   */
  async validateWorktreeGitInterop(): Promise<void> {
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "startup");
    const worktreePath = resolve(this.worktreeDir, worktreeName);

    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath);
      await this.ensureWorktreeAccessibleInWarmContainer(worktreePath);
      const backend = this.currentBackend();
      const capabilityCheck = await this.runWarmShell(
        buildDockerRuntimeCapabilityCanaryCommand(backend),
        { timeoutMs: 15_000 },
      );
      if (!capabilityCheck.ok) {
        throw new Error(
          `Docker runtime capability canary failed: ${
            capabilityCheck.stderr || capabilityCheck.stdout || `exit ${capabilityCheck.exitCode}`
          }`,
        );
      }
      console.log(
        `[DockerExecutor] Runtime capability canary passed (${capabilityCheck.stdout.trim()}).`,
      );
      // Use the backend's production warmup probe here as well. This validates
      // the executable fallback, Python wrapper, and configured auth mode
      // before the worker advertises itself as ready for a real job.
      await this.ensureBackendWarmup(backend);
      console.log(
        `[DockerExecutor] Startup self-check passed (git/worktree, runtime tools, dependency store, and backend readiness).`,
      );
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {
        // Ignore cleanup failures for startup self-check artifacts.
      });
    }
  }

  /**
   * Dedicated Windows-host/Linux-container boundary check used by CI. Unlike
   * the broader startup self-check, this requires only a minimal Linux image
   * with Git and verifies LF bytes plus hardlink support from inside that
   * container. The hardlink probe protects the dependency projection used by
   * production Windows-host workers.
   */
  async validateLinuxContainerWorktreeBoundary(assertLfPath: string): Promise<void> {
    const normalizedPath = String(assertLfPath ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");
    if (
      !normalizedPath ||
      normalizedPath.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalizedPath) ||
      normalizedPath.split("/").includes("..") ||
      /[\r\n\0]/.test(normalizedPath)
    ) {
      throw new Error(`Invalid LF boundary assertion path: ${assertLfPath}`);
    }
    const worktreeName = this.buildEphemeralWorktreeName("selfcheck", "windows-linux-lf");
    const worktreePath = resolve(this.worktreeDir, worktreeName);
    try {
      await this.createWorktree(worktreePath, this.options.baseRef);
      await this.runGitSelfCheckContainer(worktreePath, normalizedPath);
    } finally {
      await this.removeWorktree(worktreePath).catch(() => {
        // Preserve the original boundary assertion error.
      });
    }
  }

  /**
   * Create a git worktree for isolated job execution
   */
  private async createWorktree(
    worktreePath: string,
    baseRef: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    await this.ensureFreshWorktreePath(worktreePath, deadlineLedger);

    // Create worktree from configured base ref (detached)
    let result = await this.runHostCommandCapture(
      ["git", ...buildLinuxWorktreeAddArgs(worktreePath, baseRef)],
      {
        cwd: this.options.repo,
        timeoutMs:
          deadlineLedger?.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS) ??
          HOST_GIT_CONTROL_TIMEOUT_MS,
      },
    );
    let exitCode = result.exitCode;
    let stdout = result.stdout;
    let stderr = result.stderr;
    let detail = [
      stderr,
      stdout,
      result.timedOut ? `git worktree add timed out after ${HOST_GIT_CONTROL_TIMEOUT_MS}ms` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!result.timedOut && exitCode !== 0 && /already registered worktree/i.test(detail)) {
      const prune = await this.runHostCommandCapture(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        timeoutMs:
          deadlineLedger?.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS) ??
          HOST_GIT_CONTROL_TIMEOUT_MS,
      });
      if (prune.timedOut) {
        throw new Error(`git worktree prune timed out after ${HOST_GIT_CONTROL_TIMEOUT_MS}ms`);
      }

      result = await this.runHostCommandCapture(
        ["git", ...buildLinuxWorktreeAddArgs(worktreePath, baseRef, true)],
        {
          cwd: this.options.repo,
          timeoutMs:
            deadlineLedger?.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS) ??
            HOST_GIT_CONTROL_TIMEOUT_MS,
        },
      );
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
      detail = [
        stderr,
        stdout,
        result.timedOut
          ? `forced git worktree add timed out after ${HOST_GIT_CONTROL_TIMEOUT_MS}ms`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    if (result.timedOut || exitCode !== 0) {
      throw new Error(`Failed to create worktree from ${baseRef}: ${detail}`);
    }

    const enableWorktreeConfig = await this.runGitBaseRefCommand(
      ["config", "extensions.worktreeConfig", "true"],
      deadlineLedger,
    );
    if (!enableWorktreeConfig.ok) {
      throw new Error(
        `Failed to enable worktree-local Git configuration: ${
          enableWorktreeConfig.stderr || enableWorktreeConfig.stdout
        }`,
      );
    }
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.eol", "lf"],
    ] as const) {
      const configured = await this.runGitBaseRefCommand(
        ["-C", worktreePath, "config", "--worktree", key, value],
        deadlineLedger,
      );
      if (!configured.ok) {
        throw new Error(
          `Failed to configure ${key}=${value} for Linux worktree: ${
            configured.stderr || configured.stdout
          }`,
        );
      }
    }

    this.rewriteWorktreeGitdirToRelative(worktreePath);

    console.log(`[DockerExecutor] Created worktree: ${worktreePath}`);
  }

  /**
   * On Windows hosts, git worktree writes an absolute Windows path into
   * `<worktree>/.git` (e.g. `C:/.../.git/worktrees/...`). That path is not
   * valid inside Linux containers. Rewrite to a relative gitdir so both host
   * and container can resolve it.
   */
  private rewriteWorktreeGitdirToRelative(worktreePath: string): void {
    try {
      const gitFilePath = resolve(worktreePath, ".git");
      const raw = readFileSync(gitFilePath, "utf-8").trim();
      const match = raw.match(/^gitdir:\s*(.+)$/i);
      if (!match) return;

      const gitdirRaw = match[1].trim();
      const hasWindowsDrive = /^[a-zA-Z]:[\\/]/.test(gitdirRaw);
      if (!hasWindowsDrive && !isAbsolute(gitdirRaw)) {
        return;
      }

      const rel = relative(worktreePath, gitdirRaw).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") === false) {
        return;
      }

      writeFileSync(gitFilePath, `gitdir: ${rel}\n`, "utf-8");
    } catch {
      // Best-effort normalization; if this fails, git commands will surface
      // a concrete error during execution.
    }
  }

  /**
   * Remove a git worktree
   */
  private async removeWorktree(
    worktreePath: string,
    deadlineLedger?: JobDeadlineLedger,
    options: { ensureReconciliation?: boolean } = {},
  ): Promise<void> {
    const ensureReconciliation = options.ensureReconciliation === true;
    const cleanupTimeout = (requestedMs: number): number => {
      const reservedTimeoutMs = deadlineLedger
        ? deadlineLedger.capTotalTimeout(requestedMs)
        : requestedMs;
      if (reservedTimeoutMs > 0 || !ensureReconciliation) return reservedTimeoutMs;
      return Math.min(requestedMs, SETUP_WORKTREE_RECONCILIATION_TIMEOUT_MS);
    };
    const removalTimeoutMs = cleanupTimeout(HOST_GIT_CONTROL_TIMEOUT_MS);
    if (removalTimeoutMs <= 0) {
      console.warn(
        `[DockerExecutor] Deferring worktree cleanup after the absolute job deadline: ${worktreePath}`,
      );
      return;
    }
    if (deadlineLedger?.remainingTotalMs() === 0 && ensureReconciliation) {
      console.warn(
        `[DockerExecutor] Using bounded setup-worktree reconciliation after the absolute job deadline: ${worktreePath}`,
      );
    }
    // Remove worktree
    const removal = await this.runHostCommandCapture(
      ["git", "worktree", "remove", "--force", "--force", worktreePath],
      {
        cwd: this.options.repo,
        timeoutMs: removalTimeoutMs,
      },
    );

    if (removal.timedOut || removal.exitCode !== 0) {
      console.warn(
        `[DockerExecutor] Worktree removal warning: ${
          removal.timedOut
            ? `timed out after ${removalTimeoutMs}ms`
            : removal.stderr || removal.stdout || `exit ${removal.exitCode}`
        }`,
      );
    }

    // Also prune worktree list
    const pruneTimeoutMs = cleanupTimeout(HOST_GIT_CONTROL_TIMEOUT_MS);
    if (pruneTimeoutMs <= 0) return;
    const prune = await this.runHostCommandCapture(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      timeoutMs: pruneTimeoutMs,
    });
    if (prune.timedOut || prune.exitCode !== 0) {
      console.warn(
        `[DockerExecutor] Worktree prune warning: ${
          prune.timedOut
            ? `timed out after ${pruneTimeoutMs}ms`
            : prune.stderr || prune.stdout || `exit ${prune.exitCode}`
        }`,
      );
    }

    if (deadlineLedger?.remainingTotalMs() === 0 && !ensureReconciliation) return;
    const forced = await forceDeleteWorktreePath(worktreePath, {
      ...(deadlineLedger ? { retries: 1 } : {}),
      sleepFn: (ms) => this.sleep(ms),
    });
    if (!forced.removed) {
      throw new Error(
        `worktree path persisted after cleanup (${worktreePath})${forced.lastError ? `: ${forced.lastError}` : ""}`,
      );
    }

    // If git removal timed out, pruning before the physical path disappeared
    // could not remove its registration. A final bounded prune makes the
    // forced-delete path immediately reconcilable instead of waiting for the
    // next worker restart.
    if (ensureReconciliation) {
      const finalPruneTimeoutMs = cleanupTimeout(HOST_GIT_CONTROL_TIMEOUT_MS);
      if (finalPruneTimeoutMs > 0) {
        const finalPrune = await this.runHostCommandCapture(["git", "worktree", "prune"], {
          cwd: this.options.repo,
          timeoutMs: finalPruneTimeoutMs,
        });
        if (finalPrune.timedOut || finalPrune.exitCode !== 0) {
          console.warn(
            `[DockerExecutor] Final setup-worktree prune warning: ${
              finalPrune.timedOut
                ? `timed out after ${finalPruneTimeoutMs}ms`
                : finalPrune.stderr || finalPrune.stdout || `exit ${finalPrune.exitCode}`
            }`,
          );
        }
      }
    }

    console.log(`[DockerExecutor] Removed worktree: ${worktreePath}`);
  }

  private async cleanupContainerDependencyProjection(
    worktreePath: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    const worktreeId = this.dependencyProjectionId(worktreePath);
    if (!worktreeId || !this.preparedDependencyProjectionIds.has(worktreeId)) return;
    const projectionPath = `/workspace/.pushpals/dependency-store/projections/${worktreeId}`;
    const command = `rm -rf ${shellSingleQuote(projectionPath)}`;
    const warmCleanupTimeoutMs = deadlineLedger
      ? deadlineLedger.capTotalTimeout(DOCKER_CONTROL_TIMEOUT_MS)
      : DOCKER_CONTROL_TIMEOUT_MS;
    if (warmCleanupTimeoutMs <= 0) {
      this.dependencyStoreReconciled = false;
      return;
    }
    try {
      const cleanup = await this.runWarmShell(command, { timeoutMs: warmCleanupTimeoutMs });
      if (cleanup.ok) {
        this.preparedDependencyProjectionIds.delete(worktreeId);
        return;
      }
    } catch {
      // Fall through to a one-shot volume cleanup if the warm container is gone.
    }

    const fallbackCleanupTimeoutMs = deadlineLedger
      ? deadlineLedger.capTotalTimeout(DOCKER_CONTROL_TIMEOUT_MS)
      : DOCKER_CONTROL_TIMEOUT_MS;
    if (fallbackCleanupTimeoutMs <= 0) {
      this.dependencyStoreReconciled = false;
      return;
    }
    try {
      const cleanup = await this.runDockerCommandCapture(
        [
          resolveDockerExecutable(),
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=volume,source=${this.dependencyVolumeName},target=/workspace/.pushpals/dependency-store`,
          "--entrypoint",
          "/bin/sh",
          this.options.imageName,
          "-lc",
          command,
        ],
        { timeoutMs: fallbackCleanupTimeoutMs },
      );
      if (!cleanup.timedOut && cleanup.exitCode === 0) {
        this.preparedDependencyProjectionIds.delete(worktreeId);
        return;
      }
      console.warn(
        `[DockerExecutor] Dependency projection cleanup was not confirmed for ${worktreeId}: ${
          cleanup.timedOut
            ? `timed out after ${fallbackCleanupTimeoutMs}ms`
            : cleanup.stderr || cleanup.stdout || `exit ${cleanup.exitCode}`
        }`,
      );
    } catch (error) {
      console.warn(
        `[DockerExecutor] Dependency projection cleanup failed for ${worktreeId}: ${this.compactError(error)}`,
      );
    }
    // Keep failed cleanup IDs retryable. The next warm-container startup or
    // worker shutdown reconciles them after their host worktrees disappear.
    this.dependencyStoreReconciled = false;
  }

  private dependencyProjectionId(worktreePath: string): string {
    return (
      String(worktreePath ?? "")
        .replace(/\\/g, "/")
        .split("/")
        .filter(Boolean)
        .at(-1) ?? ""
    ).replace(/[^A-Za-z0-9_.-]/g, "");
  }

  /**
   * Run the Docker container and parse output
   */
  private containerBackendPython(
    backend: ExecutorBackend,
    runtimeConfig: DockerBackendRuntimeConfig = this.backendRuntimeConfig(),
  ): string {
    const spec = getDockerBackendSpec(backend);
    const configured = spec.configuredPython(runtimeConfig);
    return spec.normalizeContainerPython(configured, SHARED_CONTAINER_VENV_PYTHON);
  }

  private backendRuntimeConfig(): DockerBackendRuntimeConfig {
    const workerCfg = this.config.workerpals as Record<string, unknown>;
    const runtimeConfig: DockerBackendRuntimeConfig = {};
    for (const backend of DOCKER_BACKENDS) {
      const keys = BACKEND_RUNTIME_CONFIG_KEYS[backend.name] ?? {
        pythonKey: `${backend.name}Python`,
        timeoutKey: `${backend.name}TimeoutMs`,
      };
      const python = String(workerCfg[keys.pythonKey] ?? "python").trim() || "python";
      const timeoutRaw = Number(workerCfg[keys.timeoutKey]);
      const timeoutMs = Number.isFinite(timeoutRaw)
        ? Math.max(10_000, Math.floor(timeoutRaw))
        : 300_000;
      runtimeConfig[backend.name] = { python, timeoutMs };
    }
    return runtimeConfig;
  }

  private currentBackend(): ExecutorBackend {
    return resolveExecutor(this.config);
  }

  private currentBackendSpec(): DockerBackendSpec {
    return getDockerBackendSpec(this.currentBackend());
  }

  private warmStartupContext(): DockerWarmStartupContext {
    const { attempts, sleepSeconds } = this.warmAgentStartupLoop();
    return {
      sharedVenvPython: SHARED_CONTAINER_VENV_PYTHON,
      warmAgentPort: this.warmAgentPort,
      startupAttempts: attempts,
      sleepSeconds,
    };
  }

  private collectContainerEnv(): string[] {
    const containerLlmEndpoint = this.workerLlmEndpointForContainer();
    const runtimeConfig = this.backendRuntimeConfig();
    const fixedEnv: Record<string, string> = {
      WORKERPALS_EXECUTOR: this.config.workerpals.executor,
      WORKERPALS_LLM_MODEL: this.config.workerpals.llm.model,
      WORKERPALS_LLM_ENDPOINT: containerLlmEndpoint,
      WORKERPALS_LLM_BACKEND: this.config.workerpals.llm.backend,
      WORKERPALS_LLM_SESSION_ID: this.config.workerpals.llm.sessionId,
      PUSHPALS_PROJECT_ROOT_OVERRIDE: "/repo",
      PUSHPALS_REPO_ROOT_OVERRIDE: "/repo",
      PUSHPALS_CONFIG_DIR_OVERRIDE: "/workspace/configs",
      PUSHPALS_PROMPTS_ROOT_OVERRIDE: "/workspace",
      PUSHPALS_PROTOCOL_SCHEMAS_DIR: "/workspace/protocol/schemas",
      // The warm worker container intentionally has no host Docker socket.
      // ValidationGate uses this capability signal to hand aggregate commands
      // that require Docker to SourceControlManager without a futile run.
      PUSHPALS_WORKER_DOCKER_CAPABILITY: "unavailable",
    };
    for (const backend of DOCKER_BACKENDS) {
      const name = backend.name.toUpperCase();
      fixedEnv[`WORKERPALS_${name}_PYTHON`] = this.containerBackendPython(
        backend.name,
        runtimeConfig,
      );
      fixedEnv[`WORKERPALS_${name}_TIMEOUT_MS`] = String(backend.timeoutMs(runtimeConfig));
    }
    if (this.config.workerpals.llm.apiKey.trim()) {
      fixedEnv.WORKERPALS_LLM_API_KEY = this.config.workerpals.llm.apiKey;
    }

    const allowlist = new Set<string>(SHARED_DOCKER_PASSTHROUGH_ENV);
    for (const backend of DOCKER_BACKENDS) {
      const names = BACKEND_DOCKER_PASSTHROUGH_ENV[backend.name] ?? [];
      for (const name of names) allowlist.add(name);
    }

    const pairs: string[] = [];
    for (const [key, value] of Object.entries(fixedEnv)) {
      if (!value) continue;
      pairs.push("-e", `${key}=${value}`);
    }
    for (const key of allowlist) {
      const value = process.env[key];
      if (!value) continue;
      pairs.push("-e", `${key}=${value}`);
    }
    return pairs;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private warmAgentStartupLoop(): { attempts: number; sleepSeconds: string } {
    const attempts = Math.max(
      1,
      Math.ceil(this.warmAgentStartupTimeoutMs / this.warmAgentStartupPollMs),
    );
    const sleepSeconds = String(this.warmAgentStartupPollMs / 1000);
    return { attempts, sleepSeconds };
  }

  private scheduleIdleShutdown(): void {
    if (this.options.idleTimeoutMs <= 0) return;
    if (this.activeJobs > 0) return;

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.activeJobs > 0) return;
      void this.stopWarmContainer("idle timeout").catch((error) => {
        console.warn(
          `[DockerExecutor] Idle warm-container cleanup failed: ${this.compactError(error)}`,
        );
      });
    }, this.options.idleTimeoutMs);
  }

  private async startWarmContainer(deadlineLedger?: JobDeadlineLedger): Promise<void> {
    const stopTimeoutMs = deadlineLedger
      ? deadlineLedger.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS)
      : DOCKER_CONTROL_TIMEOUT_MS;
    if (stopTimeoutMs <= 0) {
      throw new Error("Warm-container startup was cancelled by the absolute job work deadline.");
    }
    await this.stopWarmContainer("pre-start cleanup", true, stopTimeoutMs);
    await this.ensureNamedVolume(
      this.dependencyVolumeName,
      "workerpals-dependencies",
      deadlineLedger,
    );
    const backend = this.currentBackend();
    if (backend === "openai_codex") {
      await this.ensureNamedVolume(this.codexVolumeName, "workerpals-codex-home", deadlineLedger);
    }
    const backendSpec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const envArgs = this.collectContainerEnv();
    const authMount = this.openaiCodexAuthMount(backend);
    const runtimeCaArgs = resolveWorkerpalDockerRuntimeCaArgs(process.env, existsSync, (path) =>
      this.toDockerPath(path),
    );
    const args: string[] = [
      "run",
      "-d",
      "--name",
      this.warmContainerName,
      "--label",
      "pushpals.component=workerpals-warm",
      "--label",
      `pushpals.repo=${this.options.repo}`,
      "--label",
      `pushpals.worker_id=${this.options.workerId}`,
      "--memory",
      `${this.config.workerpals.dockerWarmMemoryMb}m`,
      "--cpus",
      String(this.config.workerpals.dockerWarmCpus),
      "--network",
      this.options.networkMode,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${dockerRepoPath}:/repo`,
      "--mount",
      `type=volume,source=${this.dependencyVolumeName},target=/workspace/.pushpals/dependency-store`,
      "-w",
      // Keep agent-server runtime artifacts off the host-mounted repo path.
      "/workspace",
      ...envArgs,
      ...authMount.args,
      ...runtimeCaArgs,
    ];

    if (this.options.gitToken) {
      args.push("-e", `GIT_TOKEN=${this.options.gitToken}`);
    }
    const backendEnv = backendSpec.warmContainerEnv?.(warmContext) ?? {};
    for (const [key, value] of Object.entries(backendEnv)) {
      if (!value) continue;
      args.push("-e", `${key}=${value}`);
    }

    const backendStartup = prependOpenAiCodexHomeStartup(
      backendSpec.warmContainerStartupCommand(warmContext),
      backend === "openai_codex"
        ? {
            containerHome: authMount.containerHome,
            runtimeTag: resolveWorkerpalRuntimeTag(),
            hostAuthMounted: authMount.hostAuthMounted,
          }
        : null,
    );
    const startupCmd = prependWorkerpalRuntimeCaStartup(backendStartup, runtimeCaArgs.length > 0);
    if (runtimeCaArgs.length > 0) {
      console.log(
        "[DockerExecutor] Mounting host extra CA trust into the warm container (read-only).",
      );
    }

    args.push("--entrypoint", "/bin/sh", this.options.imageName, "-lc", startupCmd);

    const result = await this.runDockerCommandCapture([resolveDockerExecutable(), ...args], {
      timeoutMs:
        deadlineLedger?.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS) ?? DOCKER_CONTROL_TIMEOUT_MS,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `Failed to start warm container (${result.timedOut ? `timed out after ${DOCKER_CONTROL_TIMEOUT_MS}ms` : `exit ${result.exitCode}`}): ${
          result.stderr || result.stdout || "no docker output"
        }`,
      );
    }
    console.log(`[DockerExecutor] Warm container started: ${this.warmContainerName}`);
    await this.reconcileContainerDependencyStore(deadlineLedger);
  }

  private async reconcileContainerDependencyStore(
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    if (this.dependencyStoreReconciled && this.preparedDependencyProjectionIds.size === 0) return;
    try {
      const result = await this.runWarmShell(buildDependencyStoreReconciliationCommand(), {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS) ?? DOCKER_CONTROL_TIMEOUT_MS,
      });
      if (!result.ok) {
        this.dependencyStoreReconciled = false;
        console.warn(
          `[DockerExecutor] Dependency store reconciliation was not confirmed: ${
            result.stderr || result.stdout || `exit ${result.exitCode}`
          }`,
        );
        return;
      }
      for (const worktreeId of this.preparedDependencyProjectionIds) {
        if (!existsSync(resolve(this.worktreeDir, worktreeId))) {
          this.preparedDependencyProjectionIds.delete(worktreeId);
        }
      }
      this.dependencyStoreReconciled = true;
    } catch (error) {
      this.dependencyStoreReconciled = false;
      console.warn(
        `[DockerExecutor] Dependency store reconciliation failed: ${this.compactError(error)}`,
      );
    }
  }

  private async ensureNamedVolume(
    name: string,
    component: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    const result = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "volume",
        "create",
        "--label",
        `pushpals.component=${component}`,
        "--label",
        `pushpals.repo=${this.options.repo}`,
        name,
      ],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS) ?? DOCKER_CONTROL_TIMEOUT_MS,
      },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `Failed to prepare ${component} volume (${result.timedOut ? `timed out after ${DOCKER_CONTROL_TIMEOUT_MS}ms` : `exit ${result.exitCode}`}): ${
          result.stderr || result.stdout || "no docker output"
        }`,
      );
    }
  }

  private openaiCodexAuthMount(backend: ExecutorBackend): {
    args: string[];
    containerHome: string;
    hostAuthMounted: boolean;
  } {
    if (backend !== "openai_codex") {
      return {
        args: [],
        containerHome: DEFAULT_OPENAI_CODEX_CONTAINER_HOME,
        hostAuthMounted: false,
      };
    }

    const hostCodexHomeRaw = (process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME || "").trim();
    if (hostCodexHomeRaw && !isAbsolute(hostCodexHomeRaw)) {
      console.warn(
        `[DockerExecutor] Ignoring relative PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME=${hostCodexHomeRaw}; using ${resolve(
          homedir(),
          ".codex",
        )} so Codex state stays outside the repo worktree.`,
      );
    }
    const hostCodexHome = (
      hostCodexHomeRaw && isAbsolute(hostCodexHomeRaw)
        ? hostCodexHomeRaw
        : resolve(homedir(), ".codex")
    ).trim();
    const configuredContainerHome = process.env.PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME;
    const containerCodexHome = resolveOpenAiCodexContainerHome(configuredContainerHome);
    if (
      configuredContainerHome?.trim() &&
      containerCodexHome !== configuredContainerHome.trim().replace(/\/$/, "")
    ) {
      console.warn(
        `[DockerExecutor] Invalid or unsafe PUSHPALS_OPENAI_CODEX_CONTAINER_CODEX_HOME=${configuredContainerHome}; using ${containerCodexHome}.`,
      );
    }
    const args = [
      "--mount",
      `type=volume,source=${this.codexVolumeName},target=${containerCodexHome}`,
      "-e",
      `CODEX_HOME=${containerCodexHome}`,
    ];
    const hostAuthPath = resolve(hostCodexHome, "auth.json");
    if (!existsSync(hostAuthPath)) {
      console.warn(
        `[DockerExecutor] Host Codex auth file not found at ${hostAuthPath}; preserving any auth already stored in ${this.codexVolumeName}.`,
      );
      return { args, containerHome: containerCodexHome, hostAuthMounted: false };
    }
    const dockerHostPath = this.toDockerPath(hostAuthPath);
    console.log(
      `[DockerExecutor] Mounting host Codex auth file read-only and isolating Linux state in volume ${this.codexVolumeName}.`,
    );
    args.push(
      "--mount",
      `type=bind,src=${dockerHostPath},dst=${WORKERPAL_HOST_CODEX_AUTH_PATH},readonly`,
    );
    return { args, containerHome: containerCodexHome, hostAuthMounted: true };
  }

  private async ensureWarmContainer(deadlineLedger?: JobDeadlineLedger): Promise<void> {
    const inspect = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "inspect",
        "-f",
        "{{.State.Running}}|{{.HostConfig.NetworkMode}}",
        this.warmContainerName,
      ],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS) ?? DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    if (!inspect.timedOut && inspect.exitCode === 0) {
      const [runningRaw, networkModeRaw] = inspect.stdout.trim().split("|");
      const running = runningRaw?.trim() === "true";
      const networkMode = (networkModeRaw ?? "").trim();
      if (running && networkMode === this.options.networkMode) {
        await this.reconcileContainerDependencyStore(deadlineLedger);
        return;
      }
      if (running && networkMode && networkMode !== this.options.networkMode) {
        console.warn(
          `[DockerExecutor] Warm container network mismatch (${networkMode} != ${this.options.networkMode}); recreating...`,
        );
      }
    }
    await this.startWarmContainer(deadlineLedger);
  }

  private async runWarmShell(
    command: string,
    options: {
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", line: string) => void;
    } = {},
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
  }> {
    const hasExplicitTimeout =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs);
    if (hasExplicitTimeout && Number(options.timeoutMs) <= 0) {
      return {
        ok: false,
        stdout: "",
        stderr: "Warm-container command did not start because the absolute job deadline expired.",
        exitCode: 124,
        timedOut: true,
      };
    }
    const timeoutMs = hasExplicitTimeout
      ? Math.max(1, Math.floor(Number(options.timeoutMs)))
      : DOCKER_PROBE_TIMEOUT_MS;
    const effectiveCommand = `timeout --signal=TERM --kill-after=5s ${Math.max(1, Math.ceil(timeoutMs / 1_000))}s /bin/sh -lc ${shellSingleQuote(command)}`;
    const proc = Bun.spawn(
      [
        resolveDockerExecutable(),
        "exec",
        this.warmContainerName,
        "/bin/sh",
        "-lc",
        effectiveCommand,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!isReadableByteStream(stdout) || !isReadableByteStream(stderr)) {
      await terminateDockerExecProcessTree(proc);
      throw new Error("warm shell stdout/stderr pipes were not available");
    }
    const streamAbort = new AbortController();
    const streams = Promise.all([
      this.readStream(stdout, "stdout", options.onLog, stdoutLines, streamAbort.signal),
      this.readStream(stderr, "stderr", options.onLog, stderrLines, streamAbort.signal),
    ]);
    let hostTimer: ReturnType<typeof setTimeout> | null = null;
    let hostTimedOut = false;
    let streamDrainTimedOut = false;
    let processExitCode: number | null = null;
    try {
      const streamFailure = streams.then(
        () => new Promise<never>(() => {}),
        (error) => ({ kind: "stream_error" as const, error }),
      );
      const outcome = await Promise.race([
        proc.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        streamFailure,
        new Promise<{ kind: "timeout" }>((resolvePromise) => {
          hostTimer = setTimeout(() => resolvePromise({ kind: "timeout" }), timeoutMs + 10_000);
        }),
      ]);
      if (outcome.kind === "stream_error") {
        throw outcome.error;
      }
      if (outcome.kind === "timeout") {
        hostTimedOut = true;
        await terminateDockerExecProcessTree(proc);
      } else {
        processExitCode = outcome.exitCode;
      }
      const drained = await settleWithin(
        streams.catch(() => undefined),
        DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS,
      );
      if (drained === null) {
        streamDrainTimedOut = true;
        streamAbort.abort();
        if (!hostTimedOut) await terminateDockerExecProcessTree(proc);
        await settleWithin(
          streams.catch(() => undefined),
          250,
        );
      }
    } catch (error) {
      streamAbort.abort();
      await terminateDockerExecProcessTree(proc);
      throw error;
    } finally {
      if (hostTimer) clearTimeout(hostTimer);
    }
    const exitCode =
      processExitCode ??
      (await settleWithin(proc.exited, DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS)) ??
      124;
    const timedOut = hostTimedOut || streamDrainTimedOut || exitCode === 124;
    return {
      ok: !timedOut && exitCode === 0,
      stdout: stdoutLines.join("\n").trim(),
      stderr: [
        stderrLines.join("\n").trim(),
        hostTimedOut ? `Warm-container command timed out after ${timeoutMs}ms.` : "",
        streamDrainTimedOut
          ? `Warm-container command streams did not close after ${DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS}ms; terminated the process tree.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: timedOut ? 124 : exitCode,
      ...(timedOut ? { timedOut: true } : {}),
      ...(streamDrainTimedOut ? { drainTimedOut: true } : {}),
    };
  }

  private async runBoundedDockerControl(args: string[], timeoutMs: number): Promise<boolean> {
    try {
      const result = await this.runDockerCommandCapture([resolveDockerExecutable(), ...args], {
        timeoutMs,
      });
      return !result.timedOut && result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async recycleWarmContainerAfterExecutionTimeout(
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    reason = "an execution timeout",
  ): Promise<void> {
    // Backend readiness belongs to a specific container process. Never let a
    // timed-out exec leave the replacement marked warm before it is probed.
    this.warmedBackends.clear();
    const restarted = await this.runBoundedDockerControl(
      ["restart", "-t", "1", this.warmContainerName],
      DOCKER_TIMEOUT_RECYCLE_TIMEOUT_MS,
    );
    if (restarted) return;

    const warning = `[DockerExecutor] Warm container could not be restarted cleanly after ${reason}; removing it before the next job.`;
    console.warn(warning);
    onLog?.("stderr", warning);
    await this.runBoundedDockerControl(
      ["rm", "-f", this.warmContainerName],
      DOCKER_TIMEOUT_RECYCLE_TIMEOUT_MS,
    );
  }

  private async runWarmWorktreeProbe(
    containerWorktreePath: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const result = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "exec",
        "-w",
        containerWorktreePath,
        this.warmContainerName,
        "/bin/sh",
        "-lc",
        "git rev-parse --is-inside-work-tree && git rev-parse --git-dir",
      ],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS) ?? DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    return {
      ok: !result.timedOut && result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.timedOut
        ? [result.stderr, `Docker worktree probe timed out after ${DOCKER_PROBE_TIMEOUT_MS}ms.`]
            .filter(Boolean)
            .join("\n")
        : result.stderr,
      exitCode: result.timedOut ? 124 : result.exitCode,
    };
  }

  private async inspectWarmContainerState(deadlineLedger?: JobDeadlineLedger): Promise<string> {
    const result = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "inspect",
        "-f",
        "running={{.State.Running}} status={{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} oom={{.State.OOMKilled}}",
        this.warmContainerName,
      ],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS) ?? DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.timedOut) {
      return `docker inspect timed out after ${DOCKER_PROBE_TIMEOUT_MS}ms${out ? `\n${out}` : ""}`;
    }
    return result.exitCode === 0
      ? out || "no inspect output"
      : `docker inspect failed (exit ${result.exitCode})${out ? `\n${out}` : ""}`;
  }

  private async readWarmContainerLogs(
    tail = 160,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<string> {
    const result = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "logs", "--tail", String(tail), this.warmContainerName],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS) ?? DOCKER_PROBE_TIMEOUT_MS,
      },
    );
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.timedOut) {
      return `docker logs timed out after ${DOCKER_PROBE_TIMEOUT_MS}ms${out ? `\n${out}` : ""}`;
    }
    return result.exitCode === 0
      ? out || "(no docker logs)"
      : `docker logs failed (exit ${result.exitCode})${out ? `\n${out}` : ""}`;
  }

  private workerLlmProbeUrls(endpoint: string): string[] {
    const normalized = endpoint.trim().replace(/\/+$/, "");
    if (!normalized) return [];
    const probes: string[] = [];
    if (normalized.includes("/v1/chat/completions")) {
      probes.push(normalized.replace(/\/v1\/chat\/completions$/, "/v1/models"));
    } else if (normalized.endsWith("/api/chat")) {
      probes.push(normalized.replace(/\/api\/chat$/, "/api/tags"));
    } else if (normalized.includes("/chat/completions")) {
      probes.push(normalized.replace(/\/chat\/completions$/, "/models"));
    } else if (normalized.endsWith("/v1")) {
      probes.push(`${normalized}/models`);
    } else if (/^https?:\/\/[^/]+$/i.test(normalized)) {
      probes.push(`${normalized}/v1/models`);
      probes.push(`${normalized}/models`);
    }
    if (probes.length === 0) {
      probes.push(normalized);
    }
    try {
      const parsed = new URL(normalized);
      probes.push(`${parsed.origin}/health`);
    } catch {
      // leave parsed probes empty
    }
    return Array.from(new Set(probes));
  }

  private async probeWorkerLlmEndpoint(deadlineLedger?: JobDeadlineLedger): Promise<string> {
    const endpoint = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!endpoint) return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0) return `endpoint malformed: ${endpoint}`;

    let lastError = "unreachable";
    for (const probe of probes) {
      const timeoutMs = deadlineLedger ? deadlineLedger.capWorkTimeout(2_500) : 2_500;
      if (timeoutMs <= 0) return "SKIPPED (absolute job work deadline expired)";
      try {
        const status = await probeWorkerLlmHttpEndpointStatus(probe, timeoutMs);
        if (status >= 200 && status < 500) {
          return `reachable via ${probe} (HTTP ${status})`;
        }
        lastError = `${probe}: HTTP ${status}`;
      } catch (err) {
        lastError = `${probe}: ${String(err)}`;
      }
    }
    return `UNREACHABLE (${lastError})`;
  }

  private workerLlmEndpointForContainer(): string {
    const raw = (this.config.workerpals.llm.endpoint ?? "").trim();
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      const host = (parsed.hostname ?? "").trim().toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
        return raw;
      }
      parsed.hostname = "host.docker.internal";
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  private async probeWorkerLlmEndpointFromContainer(
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<string> {
    const endpoint = this.workerLlmEndpointForContainer();
    if (!endpoint) return "endpoint not configured";
    const probes = this.workerLlmProbeUrls(endpoint);
    if (probes.length === 0) return `endpoint malformed: ${endpoint}`;

    let lastError = "unreachable";
    for (const probe of probes) {
      const timeoutMs = deadlineLedger ? deadlineLedger.capWorkTimeout(3_500) : 3_500;
      if (timeoutMs <= 0) return "SKIPPED (absolute job work deadline expired)";
      const cmd =
        `status="$(curl -sS -m 3 -o /dev/null -w "%{http_code}" ${shellSingleQuote(probe)} || true)"; ` +
        'echo "$status"';
      const result = await this.runWarmShell(cmd, { timeoutMs });
      const status = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(status) && status >= 200 && status < 500) {
        return `reachable via ${probe} (HTTP ${status})`;
      }
      if (Number.isFinite(status) && status > 0) {
        lastError = `${probe}: HTTP ${status}`;
      } else {
        const detail = result.stderr ? ` (${result.stderr})` : "";
        lastError = `${probe}: exit ${result.exitCode}${detail}`;
      }
    }
    return `UNREACHABLE (${lastError})`;
  }

  private async collectWarmRuntimeDiagnostics(
    backend: ExecutorBackend,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<string> {
    const spec = getDockerBackendSpec(backend);
    const runtimeConfig = this.backendRuntimeConfig();
    const sections: string[] = [];
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const endpoint = this.config.workerpals.llm.endpoint.trim() || "(unset)";
    const configuredPython = spec.configuredPython(runtimeConfig).trim() || "(unset)";
    const containerPython = this.containerBackendPython(backend, runtimeConfig);
    const containerEndpoint = this.workerLlmEndpointForContainer();
    sections.push(`[backend] ${backend}`);
    sections.push(`[llm-config] model=${model} provider=${provider} endpoint=${endpoint}`);
    sections.push(
      `[python-config] configured=${configuredPython} resolved_container_python=${containerPython}`,
    );
    if (endpoint && containerEndpoint && endpoint !== containerEndpoint) {
      sections.push(`[llm-endpoint-rewrite] ${endpoint} -> ${containerEndpoint}`);
    }
    sections.push(`[llm-probe-host] ${await this.probeWorkerLlmEndpoint(deadlineLedger)}`);
    sections.push(
      `[llm-probe-container] ${await this.probeWorkerLlmEndpointFromContainer(deadlineLedger)}`,
    );
    sections.push(`[container] ${await this.inspectWarmContainerState(deadlineLedger)}`);
    sections.push(`[container-logs]\n${await this.readWarmContainerLogs(160, deadlineLedger)}`);

    const shellProbe = await this.runWarmShell("true", {
      timeoutMs: deadlineLedger?.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS),
    });
    if (!shellProbe.ok) {
      const probeOut = [shellProbe.stdout, shellProbe.stderr].filter(Boolean).join("\n");
      sections.push(
        `[container-exec] exit=${shellProbe.exitCode}${probeOut ? `\n${probeOut}` : "\n(no output)"}`,
      );
      return sections.join("\n");
    }

    const checks = spec.diagnosticChecks?.(SHARED_CONTAINER_VENV_PYTHON) ?? [];

    for (const check of checks) {
      const timeoutMs = deadlineLedger
        ? deadlineLedger.capWorkTimeout(DOCKER_PROBE_TIMEOUT_MS)
        : DOCKER_PROBE_TIMEOUT_MS;
      if (timeoutMs <= 0) {
        sections.push(`[${check.label}] skipped: absolute job work deadline expired`);
        break;
      }
      const result = await this.runWarmShell(check.command, { timeoutMs });
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
      sections.push(
        `[${check.label}] exit=${result.exitCode}${text ? `\n${text}` : "\n(no output)"}`,
      );
    }
    return sections.join("\n");
  }

  private async stopWarmContainer(
    reason: string,
    quiet = false,
    timeoutMs = DOCKER_CONTROL_TIMEOUT_MS,
  ): Promise<void> {
    this.clearIdleTimer();
    const boundedTimeoutMs = Math.max(1, Math.min(DOCKER_CONTROL_TIMEOUT_MS, timeoutMs));
    const result = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "rm", "-f", this.warmContainerName],
      { timeoutMs: boundedTimeoutMs },
    );
    if (!result.timedOut && result.exitCode === 0) {
      if (!quiet) {
        console.log(
          `[DockerExecutor] Warm container stopped (${reason}): ${this.warmContainerName}`,
        );
      }
      this.warmedBackends.clear();
      return;
    }
    const stderr = [result.stderr, result.timedOut ? `timed out after ${boundedTimeoutMs}ms` : ""]
      .filter(Boolean)
      .join("\n");
    const notFound = /No such container/i.test(stderr);
    if (!quiet && !notFound) {
      console.error(`[DockerExecutor] Failed to stop warm container: ${stderr}`);
    }
    this.warmedBackends.clear();
  }

  async shutdown(): Promise<void> {
    if (this.preparedDependencyProjectionIds.size > 0) {
      await this.reconcileContainerDependencyStore();
    }
    await this.stopWarmContainer("worker shutdown", true);
  }

  private encodeJobSpec(job: Job): string {
    return Buffer.from(
      JSON.stringify({
        jobId: job.id,
        taskId: job.taskId,
        kind: job.kind,
        params: job.params,
        workerId: this.options.workerId,
      }),
    ).toString("base64");
  }

  private async runHostScmOwnedReviewJob(
    worktreePath: string,
    initialJob: Job,
    deadlineLedger: JobDeadlineLedger,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<DockerJobResult> {
    const maxMergeConflictPasses = 8;
    let effectiveJob = initialJob;
    const accumulatedUsage = new UsageAccumulator();
    const withAccumulatedUsage = (result: DockerJobResult): DockerJobResult =>
      accumulatedUsage.apply(result);
    let activePass = 0;

    try {
      for (let pass = 1; pass <= maxMergeConflictPasses; pass++) {
        activePass = pass;
        const deadlineBoundJob = bindDockerJobToDeadline(effectiveJob, deadlineLedger);
        if (!deadlineBoundJob) {
          return withAccumulatedUsage(
            dockerAbsoluteDeadlineResult(
              initialJob,
              deadlineLedger,
              `host-owned review pass ${pass}`,
            ),
          );
        }
        const result = await this.runInWarmContainer(
          worktreePath,
          deadlineBoundJob,
          onLog,
          deadlineLedger,
        );
        addHostScmReviewPassUsage(accumulatedUsage, result, pass);
        if (deadlineLedger.remainingTotalMs() <= 0) {
          return withAccumulatedUsage(
            dockerAbsoluteDeadlineResult(
              initialJob,
              deadlineLedger,
              `host-owned review pass ${pass}`,
              result,
            ),
          );
        }
        if (!result.ok) return withAccumulatedUsage(result);

        if (isMergeConflictResolutionParams(effectiveJob.params)) {
          if (deadlineLedger.workExpired()) {
            return withAccumulatedUsage(
              dockerAbsoluteDeadlineResult(
                initialJob,
                deadlineLedger,
                `host-owned rebase continuation after pass ${pass}`,
                result,
              ),
            );
          }
          const resume = await resumePreparedMergeConflictRebase(
            worktreePath,
            effectiveJob.kind,
            effectiveJob.params,
            onLog,
            deadlineLedger,
          );
          if (deadlineLedger.workExpired()) {
            return withAccumulatedUsage(
              dockerAbsoluteDeadlineResult(
                initialJob,
                deadlineLedger,
                `host-owned rebase continuation after pass ${pass}`,
                result,
              ),
            );
          }
          if (!resume.ok) {
            return withAccumulatedUsage({
              ...result,
              ok: false,
              summary: "Host-side merge-conflict rebase continuation failed",
              stderr: [result.stderr, resume.error].filter(Boolean).join("\n"),
              exitCode: 4,
            });
          }
          if (resume.sequencer) {
            if (resume.sequencer !== "rebase" || pass >= maxMergeConflictPasses) {
              const detail =
                resume.sequencer !== "rebase"
                  ? `Host-side review worktree left unexpected git ${resume.sequencer} in progress.`
                  : `Host-side merge-conflict repair exceeded ${maxMergeConflictPasses} focused resolver passes.`;
              return withAccumulatedUsage({
                ...result,
                ok: false,
                summary: detail,
                stderr: [result.stderr, resume.detail, detail].filter(Boolean).join("\n"),
                exitCode: 4,
              });
            }

            const refreshedParams = await refreshMergeConflictWorktreeHints(
              worktreePath,
              effectiveJob.params,
              deadlineLedger,
            );
            if (deadlineLedger.workExpired()) {
              return withAccumulatedUsage(
                dockerAbsoluteDeadlineResult(
                  initialJob,
                  deadlineLedger,
                  `refreshing host-owned conflict hints after pass ${pass}`,
                  result,
                ),
              );
            }
            const planning =
              refreshedParams.planning &&
              typeof refreshedParams.planning === "object" &&
              !Array.isArray(refreshedParams.planning)
                ? { ...(refreshedParams.planning as Record<string, unknown>) }
                : {};
            planning.executionBudgetMs = Math.min(
              300_000,
              Math.max(60_000, Number(planning.executionBudgetMs) || 300_000),
            );
            planning.finalizationBudgetMs = Math.min(
              60_000,
              Math.max(30_000, Number(planning.finalizationBudgetMs) || 60_000),
            );
            effectiveJob = {
              ...effectiveJob,
              params: markHostScmGitOwnership({
                ...refreshedParams,
                planning,
                qualityRevisionAttempt: pass,
                qualityRevisionHint: [
                  String(refreshedParams.qualityRevisionHint ?? "").trim(),
                  resume.detail ??
                    "Host-side rebase continuation advanced to another unresolved conflict.",
                  "Resolve only the currently conflicted file contents. Host-side SCM will stage and continue after this pass.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }),
            };
            onLog?.(
              "stdout",
              `[MergeConflictHost] Rebase still requires conflict editing; starting focused container pass ${pass + 1}/${maxMergeConflictPasses}.`,
            );
            continue;
          }
        }

        if (!shouldCommit(effectiveJob.kind, this.config)) {
          return withAccumulatedUsage(result);
        }
        if (deadlineLedger.remainingTotalMs() <= 0) {
          return withAccumulatedUsage(
            dockerAbsoluteDeadlineResult(
              initialJob,
              deadlineLedger,
              "host-owned commit finalization",
              result,
            ),
          );
        }
        const commitResult = await createJobCommit(
          worktreePath,
          this.options.workerId,
          {
            id: effectiveJob.id,
            taskId: effectiveJob.taskId,
            kind: effectiveJob.kind,
            params: effectiveJob.params,
            sessionId: effectiveJob.sessionId,
            context: "host",
            deferPublication: Boolean(result.validationBlocked),
          },
          this.config,
          deadlineLedger,
        );
        addHostScmFinalizationUsage(accumulatedUsage, commitResult, pass);
        if (deadlineLedger.remainingTotalMs() <= 0) {
          return withAccumulatedUsage(
            dockerAbsoluteDeadlineResult(
              initialJob,
              deadlineLedger,
              "host-owned commit finalization",
              {
                ...result,
                ...(commitResult.ok && commitResult.sha && commitResult.branch
                  ? {
                      commit: {
                        branch: commitResult.branch,
                        sha: commitResult.sha,
                        publicBranch: commitResult.publicBranch,
                      },
                    }
                  : {}),
              },
            ),
          );
        }
        if (!commitResult.ok || !commitResult.sha || !commitResult.branch) {
          const detail =
            commitResult.error ??
            `Host-side completion metadata missing for review job ${effectiveJob.id}.`;
          return withAccumulatedUsage({
            ...result,
            ok: false,
            summary: commitResult.publishBlocked?.summary ?? "Host-side review finalization failed",
            stderr: [result.stderr, detail].filter(Boolean).join("\n"),
            exitCode: result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
            publishBlocked: commitResult.publishBlocked,
          });
        }
        return withAccumulatedUsage({
          ...result,
          commit: {
            branch: commitResult.branch,
            sha: commitResult.sha,
            publicBranch: commitResult.publicBranch,
          },
        });
      }

      return withAccumulatedUsage({
        ok: false,
        summary: "Host-side review execution exhausted resolver passes",
        stderr: `Exceeded ${maxMergeConflictPasses} host-owned review passes.`,
        exitCode: 4,
      });
    } catch (error) {
      throw attachHostScmUsageToError(accumulatedUsage, error, activePass);
    }
  }

  private async runInWarmContainer(
    worktreePath: string,
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<DockerJobResult> {
    if (deadlineLedger?.workExpired()) {
      return dockerAbsoluteDeadlineResult(job, deadlineLedger, "warm-container setup");
    }
    await this.ensureWarmRuntimeReady(job, onLog, deadlineLedger);
    if (deadlineLedger?.workExpired()) {
      return dockerAbsoluteDeadlineResult(job, deadlineLedger, "warm-runtime setup");
    }
    const startedAtMs = Date.now();
    const containerWorktreePath = await this.ensureWorktreeAccessibleInWarmContainer(
      worktreePath,
      onLog,
      deadlineLedger,
    );
    if (deadlineLedger?.workExpired()) {
      return dockerAbsoluteDeadlineResult(job, deadlineLedger, "worktree visibility setup");
    }
    const dependencyPreparation = await this.ensureWorktreeDependencyArtifacts(
      containerWorktreePath,
      onLog,
      deadlineLedger,
    );
    if (deadlineLedger?.workExpired()) {
      return dockerAbsoluteDeadlineResult(job, deadlineLedger, "dependency preparation");
    }
    const deadlineBoundJob = deadlineLedger ? bindDockerJobToDeadline(job, deadlineLedger) : job;
    if (!deadlineBoundJob) {
      return dockerAbsoluteDeadlineResult(
        job,
        deadlineLedger as JobDeadlineLedger,
        "warm-container dependency preparation",
      );
    }
    const base64Spec = this.encodeJobSpec(deadlineBoundJob);

    const args = this.buildWarmContainerExecArgs(containerWorktreePath);

    console.log(
      `[DockerExecutor] Running job in warm container: ${this.warmContainerName} (${this.executionConfigSummary()})`,
    );

    const dockerArgv = [resolveDockerExecutable(), ...args];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(dockerArgv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      throw new Error(
        `failed to spawn warm-container docker exec (${this.warmContainerName}, cwd=${containerWorktreePath}, argv_chars=${dockerArgv.join("\u0000").length}, spec_chars=${base64Spec.length}): ${this.compactError(
          err,
        )}`,
      );
    }
    const configuredTimeoutMs = resolveDockerJobTimeoutMs(this.options.timeoutMs, deadlineBoundJob);
    const timeoutMs = resolveDockerContainerTransportTimeoutMs(
      configuredTimeoutMs,
      deadlineBoundJob,
      deadlineLedger,
    );
    if (timeoutMs <= 0) {
      await terminateDockerExecProcessTree(proc);
      return dockerAbsoluteDeadlineResult(job, deadlineLedger as JobDeadlineLedger, "Docker spawn");
    }
    if (configuredTimeoutMs !== this.options.timeoutMs) {
      const verb = configuredTimeoutMs > this.options.timeoutMs ? "Extended" : "Capped";
      const note = `[DockerExecutor] ${verb} job timeout for browser validation convergence: ${configuredTimeoutMs}ms (configured ${this.options.timeoutMs}ms).`;
      console.log(note);
      onLog?.("stdout", note);
    }
    if (timeoutMs < configuredTimeoutMs) {
      const planning = maybeRecord(deadlineBoundJob.params.planning);
      const preservesHostCleanupReserve =
        readPositiveNumber(planning?.executionBudgetMs) === null ||
        readPositiveNumber(planning?.finalizationBudgetMs) === null;
      const note = `[DockerExecutor] Capped this container invocation to ${timeoutMs}ms from the shared absolute job deadline (${preservesHostCleanupReserve ? "host cleanup reserve preserved" : "remaining work plus inner finalization"}).`;
      console.log(note);
      onLog?.("stdout", note);
    }

    const { leadMs: warningLeadMs, delayMs: warningDelayMs } =
      computeTimeoutWarningWindow(timeoutMs);
    const warningTimer = setTimeout(() => {
      const warning = `[DockerExecutor] Job nearing timeout in warm container (${Math.round(
        warningLeadMs / 1000,
      )}s remaining): ${this.warmContainerName}`;
      console.warn(warning);
      onLog?.("stderr", warning);
      onLog?.(
        "stderr",
        "[DockerExecutor] Worker should finish quickly and return a concise failure/update if task cannot complete in time.",
      );
    }, warningDelayMs);

    let timedOutByDocker = false;
    let streamDrainTimedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let processExitCode: number | null = null;

    // Process streams
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const streamAbort = new AbortController();
    try {
      const stdout = proc.stdout;
      const stderr = proc.stderr;
      if (!isReadableByteStream(stdout) || !isReadableByteStream(stderr)) {
        throw new Error("docker exec stdout/stderr pipes were not available");
      }
      const streams = Promise.all([
        this.writeJobSpecToStdin(proc, base64Spec),
        this.readStream(stdout, "stdout", onLog, stdoutLines, streamAbort.signal),
        this.readStream(stderr, "stderr", onLog, stderrLines, streamAbort.signal),
      ]);
      const streamFailure = streams.then(
        () => new Promise<never>(() => {}),
        (error) => ({ kind: "stream_error" as const, error }),
      );
      const outcome = await Promise.race([
        proc.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
        streamFailure,
        new Promise<{ kind: "timeout" }>((resolvePromise) => {
          timeoutTimer = setTimeout(() => resolvePromise({ kind: "timeout" }), timeoutMs);
        }),
      ]);
      if (outcome.kind === "stream_error") {
        throw outcome.error;
      }
      if (outcome.kind === "timeout") {
        timedOutByDocker = true;
        const elapsedMs = Math.max(1, Date.now() - startedAtMs);
        const timeoutMsg = `[DockerExecutor] Job timeout in warm container after ${elapsedMs}ms (limit ${timeoutMs}ms): ${this.warmContainerName}`;
        console.log(timeoutMsg);
        onLog?.("stderr", timeoutMsg);
        await terminateDockerExecProcessTree(proc);
        await this.recycleWarmContainerAfterExecutionTimeout(onLog);
      } else {
        processExitCode = outcome.exitCode;
      }
      const drained = await settleWithin(
        streams.catch(() => undefined),
        DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS,
      );
      if (drained === null) {
        streamDrainTimedOut = true;
        streamAbort.abort();
        if (!timedOutByDocker) {
          await terminateDockerExecProcessTree(proc);
          await this.recycleWarmContainerAfterExecutionTimeout(onLog, "a stream-drain timeout");
        }
        await settleWithin(
          streams.catch(() => undefined),
          250,
        );
      }
    } catch (err) {
      clearTimeout(warningTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      streamAbort.abort();
      await terminateDockerExecProcessTree(proc);
      throw new Error(
        `failed while streaming warm-container job execution (${this.warmContainerName}, spec_chars=${base64Spec.length}): ${this.compactError(
          err,
        )}`,
      );
    }

    clearTimeout(warningTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const exitCode =
      processExitCode ??
      (await settleWithin(proc.exited, DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS)) ??
      124;
    const elapsedMs = Math.max(1, Date.now() - startedAtMs);

    // Parse result from stdout (look for ___RESULT___ sentinel)
    const result = this.parseResult(stdoutLines, stderrLines, exitCode, {
      timedOutByDocker,
      streamDrainTimedOut,
      elapsedMs,
      timeoutMs,
    });

    const diagnostics = result.diagnostics ?? {};
    return {
      ...result,
      diagnostics: {
        ...diagnostics,
        phaseSpans: [
          {
            phase: "dependency preparation",
            startedAt: new Date(dependencyPreparation.startedAtMs).toISOString(),
            finishedAt: new Date(dependencyPreparation.finishedAtMs).toISOString(),
            durationMs: dependencyPreparation.durationMs,
            outcome: "completed",
            metadata: { artifacts: dependencyPreparation.artifacts },
          },
          ...(diagnostics.phaseSpans ?? []),
        ],
        metadata: {
          ...(diagnostics.metadata ?? {}),
          dependencyPreparationMs: dependencyPreparation.durationMs,
          dependencyArtifacts: dependencyPreparation.artifacts,
        },
      },
    };
  }

  private buildWarmContainerExecArgs(containerWorktreePath: string): string[] {
    return [
      "exec",
      "-i",
      "-w",
      containerWorktreePath,
      this.warmContainerName,
      "bun",
      "run",
      "/workspace/apps/workerpals/src/job_runner.ts",
      "--spec-stdin",
    ];
  }

  private async writeJobSpecToStdin(
    proc: ReturnType<typeof Bun.spawn>,
    base64Spec: string,
  ): Promise<void> {
    const stdin = proc.stdin as
      | WritableStream<Uint8Array>
      | {
          write?: (chunk: Uint8Array | string) => unknown;
          end?: () => unknown;
          flush?: () => unknown;
        }
      | undefined;
    if (!stdin) {
      throw new Error("docker exec stdin pipe was not available");
    }
    const bytes = new TextEncoder().encode(base64Spec);
    if (stdin instanceof WritableStream) {
      const writer = stdin.getWriter();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch (err) {
        try {
          await writer.abort(err);
        } catch {
          // Ignore abort failures; the original write error is more useful.
        }
        throw err;
      }
      return;
    }

    const nodeStdin = stdin as {
      write?: (chunk: Uint8Array | string) => unknown;
      end?: () => unknown;
      flush?: () => unknown;
    };
    if (typeof nodeStdin.write === "function" && typeof nodeStdin.end === "function") {
      await nodeStdin.write(bytes);
      if (typeof nodeStdin.flush === "function") {
        await nodeStdin.flush();
      }
      await nodeStdin.end();
      return;
    }

    throw new Error("docker exec stdin pipe does not support write/end or getWriter");
  }

  private async ensureWorktreeDependencyArtifacts(
    containerWorktreePath: string,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<{
    startedAtMs: number;
    finishedAtMs: number;
    durationMs: number;
    artifacts: string[];
  }> {
    const startedAt = Date.now();
    const worktreeId = this.dependencyProjectionId(containerWorktreePath);
    if (worktreeId) this.preparedDependencyProjectionIds.add(worktreeId);
    let currentPhase = "starting";
    let currentProgress = 0;
    const preparationTimeoutMs = deadlineLedger
      ? deadlineLedger.capWorkTimeout(this.dependencyPreparationTimeoutMs)
      : this.dependencyPreparationTimeoutMs;
    if (preparationTimeoutMs <= 0) {
      throw new Error(
        "Dependency preparation did not start because the absolute job work deadline expired.",
      );
    }
    const startNote = `[DependencyPreparation] phase=${currentPhase} progress=${currentProgress} timeout_ms=${preparationTimeoutMs}`;
    console.log(startNote);
    onLog?.("stdout", startNote);
    const command = buildWorktreeDependencyPreparationCommand(containerWorktreePath);
    const progressTimer = setInterval(() => {
      const note = `[DependencyPreparation] phase=${currentPhase} progress=${currentProgress} elapsed_ms=${Math.max(
        0,
        Date.now() - startedAt,
      )}`;
      console.log(note);
      onLog?.("stdout", note);
    }, 15_000);
    const result = await this.runWarmShell(command, {
      timeoutMs: preparationTimeoutMs,
      onLog: (stream, line) => {
        const progress = line.match(
          /^\[DependencyPreparation\]\s+phase=([^\s]+)\s+progress=(\d+)$/,
        );
        if (progress) {
          currentPhase = progress[1];
          currentProgress = Math.max(0, Math.min(100, Number(progress[2]) || 0));
        }
        onLog?.(stream, line);
      },
    }).finally(() => clearInterval(progressTimer));
    if (!result.ok) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const warning = `[DockerExecutor] Linux-native worktree dependency preparation failed: ${
        detail || `exit ${result.exitCode}`
      }`;
      console.warn(warning);
      onLog?.("stderr", warning);
      throw new Error(warning);
    }

    const linked = result.stdout
      .trim()
      .split(/\s+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const finishedAtMs = Date.now();
    const note =
      `[DependencyPreparation] phase=complete progress=100 duration_ms=${finishedAtMs - startedAt} artifacts=` +
      (linked.length > 0 ? linked.join(",") : "none");
    console.log(note);
    onLog?.("stdout", note);
    if (linked.length === 0) {
      return {
        startedAtMs: startedAt,
        finishedAtMs,
        durationMs: Math.max(0, finishedAtMs - startedAt),
        artifacts: [],
      };
    }

    return {
      startedAtMs: startedAt,
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAt),
      artifacts: linked,
    };
  }

  private async waitForWorktreePathInWarmContainer(
    containerWorktreePath: string,
    timeoutMs = 5_000,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    const boundedTimeoutMs = deadlineLedger ? deadlineLedger.capWorkTimeout(timeoutMs) : timeoutMs;
    if (boundedTimeoutMs <= 0) {
      throw new Error(
        "worktree visibility probe did not start because the absolute job work deadline expired",
      );
    }
    const deadline = Date.now() + boundedTimeoutMs;
    let lastDetail = "";
    const command = `test -d ${shellSingleQuote(containerWorktreePath)}`;
    while (Date.now() < deadline) {
      const probeTimeoutMs = deadlineLedger
        ? deadlineLedger.capWorkTimeout(Math.max(1, deadline - Date.now()))
        : Math.max(1, deadline - Date.now());
      if (probeTimeoutMs <= 0) break;
      const result = await this.runWarmShell(command, { timeoutMs: probeTimeoutMs });
      if (result.ok) return;
      lastDetail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const retryDelayMs = deadlineLedger ? deadlineLedger.capWorkTimeout(100) : 100;
      if (retryDelayMs <= 0) break;
      await this.sleep(retryDelayMs);
    }
    throw new Error(
      `worktree path not visible inside warm container after ${boundedTimeoutMs}ms: ${containerWorktreePath}${
        lastDetail ? ` (${lastDetail})` : ""
      }`,
    );
  }

  private async ensureWorktreeAccessibleInWarmContainer(
    worktreePath: string,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<string> {
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.ensureWarmContainer(deadlineLedger);
        await this.waitForWorktreePathInWarmContainer(
          containerWorktreePath,
          this.worktreeVisibilityTimeoutMs,
          deadlineLedger,
        );
        const probe = await this.runWarmWorktreeProbe(containerWorktreePath, deadlineLedger);
        if (probe.ok) {
          return containerWorktreePath;
        }
        const detail = [probe.stderr, probe.stdout].filter(Boolean).join("\n").trim();
        throw new Error(
          `warm container git probe failed (exit ${probe.exitCode})${detail ? `: ${detail}` : ""}`,
        );
      } catch (err) {
        lastError = err;
        if (attempt >= 2) {
          const diagnostics = await this.inspectWarmContainerState(deadlineLedger).catch(() => "");
          throw new Error(
            `worktree not accessible inside warm container after ${attempt} attempts: ${containerWorktreePath}${
              lastError ? ` (${this.compactError(lastError)})` : ""
            }${diagnostics ? ` | container=${diagnostics}` : ""}`,
          );
        }
        const note =
          `[DockerExecutor] Warm container could not access worktree ${containerWorktreePath}; ` +
          `recycling container and retrying once (${this.compactError(err)}).`;
        console.warn(note);
        onLog?.("stderr", note);
        const stopTimeoutMs = deadlineLedger
          ? deadlineLedger.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS)
          : DOCKER_CONTROL_TIMEOUT_MS;
        if (stopTimeoutMs <= 0) throw err;
        await this.stopWarmContainer("worktree visibility retry", true, stopTimeoutMs);
      }
    }

    return containerWorktreePath;
  }

  private normalizeProvider(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!value) return "auto";
    if (value === "lmstudio" || value === "openai_compatible") return "openai";
    if (value === "ollama_chat") return "ollama";
    return value;
  }

  private executionConfigSummary(): string {
    const backend = resolveExecutor(this.config);
    const model = this.config.workerpals.llm.model.trim() || DEFAULT_OPENHANDS_MODEL;
    const provider = this.normalizeProvider(this.config.workerpals.llm.backend);
    const warmMemoryMb = this.config.workerpals.dockerWarmMemoryMb;
    const warmCpus = this.config.workerpals.dockerWarmCpus;
    const warmPython = this.containerBackendPython(backend);
    return `backend=${backend} model=${model} provider=${provider} warm_memory_mb=${warmMemoryMb} warm_cpus=${warmCpus} warm_python=${warmPython}`;
  }

  private logExecutionConfig(): void {
    const summary = this.executionConfigSummary();
    if (summary === this.lastLoggedExecutionConfig) return;
    this.lastLoggedExecutionConfig = summary;
    console.log(`[DockerExecutor] Execution config: ${summary}`);
    const configuredEndpoint = this.config.workerpals.llm.endpoint.trim();
    const containerEndpoint = this.workerLlmEndpointForContainer();
    if (configuredEndpoint && configuredEndpoint !== containerEndpoint) {
      const rewriteSummary = `${configuredEndpoint} -> ${containerEndpoint}`;
      if (rewriteSummary !== this.lastLoggedEndpointRewrite) {
        this.lastLoggedEndpointRewrite = rewriteSummary;
        console.log(
          `[DockerExecutor] Rewriting worker LLM endpoint for container networking: ${rewriteSummary}`,
        );
      }
    }
  }

  private async runGitSelfCheckContainer(
    worktreePath: string,
    assertLfPath?: string,
  ): Promise<void> {
    const containerName = `pushpals-${this.options.workerId}-selfcheck-${Date.now()}`;
    const dockerRepoPath = this.toDockerPath(this.options.repo);
    const worktreeRelPath = relative(this.options.repo, worktreePath).replace(/\\/g, "/");
    const containerWorktreePath = `/repo/${worktreeRelPath}`;

    const args = [
      resolveDockerExecutable(),
      "run",
      "--rm",
      "--name",
      containerName,
      "--network",
      "none",
      "-v",
      `${dockerRepoPath}:/repo`,
      "-w",
      containerWorktreePath,
      ...(assertLfPath ? ["-e", `PUSHPALS_LF_ASSERT_PATH=${assertLfPath}`] : []),
      "--entrypoint",
      "/bin/sh",
      this.options.imageName,
      "-lc",
      [
        "set -eu",
        'test "$(git config --worktree --get core.autocrlf)" = "false"',
        'test "$(git config --worktree --get core.eol)" = "lf"',
        "git rev-parse --is-inside-work-tree",
        "git rev-parse --git-dir",
        "git status --porcelain",
        'if [ -n "${PUSHPALS_LF_ASSERT_PATH:-}" ]; then',
        '  test -f "$PUSHPALS_LF_ASSERT_PATH"',
        '  if od -An -t x1 "$PUSHPALS_LF_ASSERT_PATH" | tr -d " \\n" | grep -qi "0d0a"; then',
        '    echo "CRLF bytes found in $PUSHPALS_LF_ASSERT_PATH" >&2',
        "    exit 23",
        "  fi",
        '  hardlink_probe=".pushpals-hardlink-boundary-$$"',
        '  ln "$PUSHPALS_LF_ASSERT_PATH" "$hardlink_probe"',
        '  test "$PUSHPALS_LF_ASSERT_PATH" -ef "$hardlink_probe"',
        '  rm -f "$hardlink_probe"',
        "fi",
      ].join("\n"),
    ];
    const result = await this.runDockerCommandCapture(args, {
      timeoutMs: DOCKER_SELF_CHECK_TIMEOUT_MS,
    });
    if (result.timedOut || result.exitCode !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
      throw new Error(
        `Docker git/worktree startup self-check failed (${
          result.timedOut
            ? `timed out after ${DOCKER_SELF_CHECK_TIMEOUT_MS}ms`
            : `exit ${result.exitCode}`
        }): ${detail}`,
      );
    }
  }

  /**
   * Read a stream, forwarding lines to onLog callback and collecting to array
   */
  private async readStream(
    readable: ReadableStream<Uint8Array>,
    streamName: "stdout" | "stderr",
    onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
    lines: string[],
    signal?: AbortSignal,
    maxRetainedChars = DOCKER_CAPTURE_MAX_CHARS,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    let pending = "";
    const retentionLimit = Math.max(128, Math.floor(maxRetainedChars));
    let retainedChars = lines.reduce((total, line) => total + line.length + 1, 0);
    let droppedChars = 0;
    let droppedLines = 0;
    let droppedPrefixCount = 0;
    let pendingTruncationReported = false;
    let pendingLineTruncated = false;
    let discardingResultLine = false;
    let latestResultFrame: string | undefined;
    const abortReader = () => {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // Reader already closed.
      }
    };
    signal?.addEventListener("abort", abortReader, { once: true });

    const forwardLine = (line: string, truncated = false) => {
      const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!cleanLine) return;

      if (streamName === "stdout" && !truncated && isJobResultFrame(cleanLine)) {
        // Keep only the newest control frame, even if it is malformed. Falling
        // back to an older success would hide a newer terminal failure.
        latestResultFrame =
          cleanLine.length <= JOB_RESULT_MAX_CHARS ? cleanLine : oversizedJobResultFrame();
        return;
      }

      let retainedLine = cleanLine;
      if (retainedLine.length + 1 > retentionLimit) {
        const retainedLength = Math.max(1, retentionLimit - 1);
        droppedChars += retainedLine.length - retainedLength;
        retainedLine = retainedLine.slice(-retainedLength);
      }
      if (isJobResultFrame(retainedLine)) {
        // A truncated ordinary log can coincidentally begin with the sentinel.
        // Keep its identity as log output when parseResult scans the tail.
        const marker = "[truncated log] ";
        retainedLine = marker + retainedLine.slice(marker.length);
      }
      lines.push(retainedLine);
      retainedChars += retainedLine.length + 1;
      while (retainedChars > retentionLimit && droppedPrefixCount < lines.length) {
        const removed = lines[droppedPrefixCount];
        retainedChars -= removed.length + 1;
        droppedChars += removed.length + 1;
        droppedLines += 1;
        droppedPrefixCount += 1;
      }
      // Compact in batches so a noisy process cannot turn tail retention into
      // quadratic Array.shift() work while still keeping memory bounded.
      if (droppedPrefixCount >= 1_024) {
        lines.splice(0, droppedPrefixCount);
        droppedPrefixCount = 0;
      }

      // For stderr, try to parse as JSON log line
      if (streamName === "stderr") {
        try {
          const logEntry = JSON.parse(cleanLine);
          if (logEntry.stream && logEntry.line) {
            onLog?.(logEntry.stream, logEntry.line);
            return;
          }
        } catch {
          // Not JSON, forward as-is below.
        }
      }
      onLog?.(streamName, cleanLine);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        pending += decoder.decode(value, { stream: true });
        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          if (!discardingResultLine) forwardLine(line, pendingLineTruncated);
          pendingLineTruncated = false;
          discardingResultLine = false;
          newlineIndex = pending.indexOf("\n");
        }
        if (discardingResultLine) {
          pending = "";
          continue;
        }
        if (streamName === "stdout" && !pendingLineTruncated && isJobResultFrame(pending)) {
          if (pending.length > JOB_RESULT_MAX_CHARS) {
            latestResultFrame = oversizedJobResultFrame();
            pending = "";
            discardingResultLine = true;
          }
          continue;
        }
        const pendingLimit = Math.max(128, Math.min(retentionLimit, DOCKER_PENDING_LINE_MAX_CHARS));
        if (pending.length > pendingLimit) {
          const omittedChars = pending.length - pendingLimit;
          droppedChars += omittedChars;
          pending = pending.slice(-pendingLimit);
          pendingLineTruncated = true;
          if (!pendingTruncationReported) {
            pendingTruncationReported = true;
            onLog?.(
              streamName,
              `${DOCKER_PENDING_LINE_TRUNCATION_MARKER} (${omittedChars}+ chars omitted).`,
            );
          }
        }
      }

      pending += decoder.decode();
      if (pending && !discardingResultLine) {
        forwardLine(pending, pendingLineTruncated);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      signal?.removeEventListener("abort", abortReader);
      try {
        reader.releaseLock();
      } catch {
        // Reader already released or cancelled.
      }
      if (droppedPrefixCount > 0) {
        lines.splice(0, droppedPrefixCount);
      }
      if (droppedChars > 0 || droppedLines > 0) {
        lines.unshift(
          `${DOCKER_STREAM_TRUNCATION_MARKER} (${droppedLines} lines, ${droppedChars} chars omitted; bounded tail retained).`,
        );
      }
      if (latestResultFrame) lines.push(latestResultFrame);
    }
  }

  /**
   * Parse the result from stdout lines looking for ___RESULT___ sentinel
   */
  private parseResult(
    stdoutLines: string[],
    stderrLines: string[],
    exitCode: number,
    context: DockerExecutionResultContext,
  ): DockerJobResult {
    let sawSentinel = false;
    let sentinelParseError = "";
    // Look for ___RESULT___ sentinel
    for (let i = stdoutLines.length - 1; i >= 0; i--) {
      const line = stdoutLines[i];
      const match = line.trim().match(/^___RESULT___(?:\s(.*))?$/);
      if (match) {
        sawSentinel = true;
        try {
          const rawPayload = String(match[1] ?? "").trim();
          if (!rawPayload) {
            throw new Error("empty structured result payload");
          }
          const parsedValue = JSON.parse(rawPayload) as unknown;
          const parsedRecord =
            parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
              ? (parsedValue as Record<string, unknown>)
              : {};
          const result = parsedRecord as unknown as DockerJobResult;
          const envelope = validateStructuredJobResultEnvelope(parsedValue);
          if (context.timedOutByDocker) {
            const summary = `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${context.timeoutMs}ms) after returning a structured result.`;
            return {
              ...result,
              ok: false,
              summary,
              stderr: appendDockerFailureDetail(
                result.stderr,
                "Discarded the structured result because the Docker execution deadline fired.",
              ),
              exitCode: 124,
              diagnostics: dockerStructuredProcessFailureDiagnostics(
                result.diagnostics,
                summary,
                context,
                exitCode,
                "timeout",
                envelope.valid,
              ),
            };
          }
          if (context.streamDrainTimedOut) {
            const summary = `Job process streams did not close after returning a structured result (${context.elapsedMs}ms elapsed).`;
            return {
              ...result,
              ok: false,
              summary,
              stderr: appendDockerFailureDetail(
                result.stderr,
                "Discarded the structured result because the Docker stream-drain deadline fired; the process tree and warm container were recycled.",
              ),
              exitCode: 124,
              diagnostics: dockerStructuredProcessFailureDiagnostics(
                result.diagnostics,
                summary,
                context,
                exitCode,
                "timeout",
                envelope.valid,
              ),
            };
          }

          if (!envelope.valid) {
            const summary = `Worker returned malformed structured result after ${context.elapsedMs}ms`;
            const malformedExitCode = exitCode === 0 ? 1 : exitCode;
            return {
              ok: false,
              summary,
              stdout: stdoutLines.join("\n"),
              stderr: [
                `Malformed ___RESULT___ payload: ${envelope.detail}.`,
                stderrLines.join("\n"),
              ]
                .filter(Boolean)
                .join("\n"),
              exitCode: malformedExitCode,
              diagnostics: dockerFallbackDiagnostics(
                summary,
                context,
                malformedExitCode,
                "malformed_structured_result",
                {
                  structuredResult: true,
                  structuredResultSchemaValid: false,
                  schemaValidationError: envelope.detail,
                },
              ),
            };
          }

          const structuredExitCode = envelope.exitCode ?? 0;
          const authoritativeExitCode = exitCode !== 0 ? exitCode : structuredExitCode;
          if (exitCode !== 0 && !result.ok) {
            return {
              ...result,
              exitCode,
            };
          }
          if (result.ok && authoritativeExitCode !== 0) {
            const summary = `Job process exited ${authoritativeExitCode} after returning a structured success result.`;
            return {
              ...result,
              ok: false,
              summary,
              stderr: appendDockerFailureDetail(
                result.stderr,
                `Discarded the structured ok=true result because the job process exit code was ${authoritativeExitCode}.`,
              ),
              exitCode: authoritativeExitCode,
              diagnostics: dockerStructuredProcessFailureDiagnostics(
                result.diagnostics,
                summary,
                context,
                authoritativeExitCode,
                "nonzero_exit",
              ),
            };
          }
          return result;
        } catch (err) {
          sentinelParseError = String(err);
          console.error(
            `[DockerExecutor] Failed to parse result JSON (line length=${line.length}): ${sentinelParseError}`,
          );
          // The newest sentinel is authoritative. Falling back to an older
          // success after the runner emitted a malformed terminal update can
          // turn a failed/crashed job into a false pass.
          break;
        }
      }
    }

    const stdout = stdoutLines.join("\n");
    const stderr = stderrLines.join("\n");
    if (context.timedOutByDocker) {
      const summary = sawSentinel
        ? `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${context.timeoutMs}ms) after emitting a malformed structured result.`
        : `Job timed out in Docker executor after ${context.elapsedMs}ms (limit ${context.timeoutMs}ms; terminated before structured result).`;
      return {
        ok: false,
        summary,
        stdout,
        stderr,
        exitCode: 124,
        diagnostics: dockerFallbackDiagnostics(summary, context, 124, "timeout", {
          ...(sawSentinel ? { sentinelParseError } : {}),
        }),
      };
    }
    if (context.streamDrainTimedOut) {
      const summary = sawSentinel
        ? `Job process streams did not close after emitting a malformed structured result (${context.elapsedMs}ms elapsed).`
        : `Job process streams did not close before a structured result was produced (${context.elapsedMs}ms elapsed).`;
      return {
        ok: false,
        summary,
        stdout,
        stderr: appendDockerFailureDetail(
          stderr,
          "The Docker stream-drain deadline fired; the process tree and warm container were recycled.",
        ),
        exitCode: 124,
        diagnostics: dockerFallbackDiagnostics(summary, context, 124, "timeout", {
          ...(sawSentinel ? { sentinelParseError } : {}),
        }),
      };
    }
    if (sawSentinel) {
      const details = [
        `Malformed ___RESULT___ payload: ${sentinelParseError || "unknown parse error"}`,
      ];
      if (stderr) details.push(stderr);
      const summary = `Worker returned malformed structured result after ${context.elapsedMs}ms`;
      return {
        ok: false,
        summary,
        stdout,
        stderr: details.join("\n"),
        exitCode: exitCode === 0 ? 1 : exitCode,
        diagnostics: dockerFallbackDiagnostics(
          summary,
          context,
          exitCode === 0 ? 1 : exitCode,
          "malformed_structured_result",
          {
            sentinelParseError,
          },
        ),
      };
    }

    // No sentinel found: process exit zero is not proof that the job passed.
    // The job runner contract requires a validated structured result.
    if (exitCode === 143 || exitCode === 137) {
      const summary = `Job process was terminated (exit ${exitCode}) after ${context.elapsedMs}ms before structured result was produced.`;
      return {
        ok: false,
        summary,
        stdout,
        stderr,
        exitCode,
        diagnostics: dockerFallbackDiagnostics(summary, context, exitCode, "terminated"),
      };
    }

    const failureClass = unstructuredDockerFailureClass(stdout, stderr);
    const summary =
      exitCode === 0
        ? `Job process exited successfully without returning a structured result after ${context.elapsedMs}ms`
        : failureClass === "missing_runtime_asset"
          ? `Job failed because a required WorkerPal runtime asset was missing (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`
          : `Job failed (exit ${exitCode}, elapsed ${context.elapsedMs}ms)`;
    return {
      ok: false,
      summary,
      stdout,
      stderr,
      exitCode: exitCode === 0 ? 1 : exitCode,
      diagnostics: dockerFallbackDiagnostics(
        summary,
        context,
        exitCode === 0 ? 1 : exitCode,
        failureClass,
      ),
    };
  }

  private async ensureWarmRuntimeReady(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    const backend = resolveExecutor(this.config);
    let attempt = 1;
    let recoveredMissingImage = false;
    while (attempt <= this.warmSetupMaxAttempts) {
      if (deadlineLedger?.workExpired()) {
        throw new Error(
          `Warm runtime setup for ${job.id} stopped at the absolute job work deadline.`,
        );
      }
      try {
        await this.ensureWarmContainer(deadlineLedger);
        await this.ensureBackendWarmup(backend, deadlineLedger);
        return;
      } catch (err) {
        if (this.isMissingDockerImageError(err) && !recoveredMissingImage) {
          recoveredMissingImage = true;
          const rebuildNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is missing locally; rebuilding before retrying warm container startup.`;
          console.warn(rebuildNote);
          onLog?.("stderr", rebuildNote);
          const recoveryTimeoutMs = deadlineLedger
            ? deadlineLedger.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS)
            : DOCKER_CONTROL_TIMEOUT_MS;
          if (recoveryTimeoutMs <= 0) throw err;
          await this.stopWarmContainer("missing image recovery", true, recoveryTimeoutMs);
          this.warmedBackends.clear();
          if (await this.pullImage(deadlineLedger)) {
            const retryNote = `[DockerExecutor] Warm runtime image ${this.options.imageName} is available again; retrying warm container startup.`;
            console.log(retryNote);
            onLog?.("stdout", retryNote);
            continue;
          }
        }
        const retryable = this.isRetryableError(err);
        if (attempt >= this.warmSetupMaxAttempts || !retryable) {
          if (
            retryable &&
            attempt >= this.warmSetupMaxAttempts &&
            !(err instanceof DockerExecutionExhaustedError)
          ) {
            throw new DockerExecutionExhaustedError(
              "warm_setup",
              `Warm runtime setup retries exhausted after ${this.warmSetupMaxAttempts} attempts: ${this.compactError(
                err,
              )}`,
              this.failureCooldownMs,
            );
          }
          throw err;
        }
        const retryInMs = this.backoffDelayMs(this.warmSetupBackoffMs, attempt);
        const note = `[DockerExecutor] Warm runtime setup failed (attempt ${attempt}/${this.warmSetupMaxAttempts}): ${this.compactError(
          err,
        )}. Retrying in ${retryInMs}ms.`;
        console.warn(note);
        onLog?.("stderr", note);
        const retryRecoveryTimeoutMs = deadlineLedger
          ? deadlineLedger.capWorkTimeout(DOCKER_CONTROL_TIMEOUT_MS)
          : DOCKER_CONTROL_TIMEOUT_MS;
        if (retryRecoveryTimeoutMs <= 0) throw err;
        await this.stopWarmContainer("warm setup retry", true, retryRecoveryTimeoutMs);
        const boundedRetryInMs = deadlineLedger
          ? deadlineLedger.capWorkTimeout(retryInMs)
          : retryInMs;
        if (boundedRetryInMs < retryInMs) {
          throw new Error(
            `Warm runtime retry for ${job.id} was cancelled to preserve the finalization reserve.`,
          );
        }
        await this.sleep(boundedRetryInMs);
        attempt += 1;
      }
    }
  }

  private async ensureBackendWarmup(
    backend: ExecutorBackend,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    if (this.warmedBackends.has(backend)) return;
    const spec = getDockerBackendSpec(backend);
    const warmContext = this.warmStartupContext();
    if (spec.ensureWarmRuntime) {
      await spec.ensureWarmRuntime({
        ...warmContext,
        warmContainerName: this.warmContainerName,
        runWarmShell: (command: string): Promise<DockerWarmShellResult> =>
          this.runWarmShell(command, {
            timeoutMs:
              deadlineLedger?.capWorkTimeout(this.warmAgentStartupTimeoutMs) ??
              this.warmAgentStartupTimeoutMs,
          }),
        restartWarmContainer: async () => {
          await this.startWarmContainer(deadlineLedger);
        },
        collectWarmDiagnostics: async () =>
          deadlineLedger?.workExpired()
            ? "Warm-runtime diagnostics skipped because the absolute job work deadline expired."
            : this.collectWarmRuntimeDiagnostics(backend, deadlineLedger),
      });
      this.warmedBackends.add(backend);
      return;
    }
    const cmd = spec.warmupProbeCommand?.(SHARED_CONTAINER_VENV_PYTHON);
    if (cmd) {
      const result = await this.runWarmShell(cmd, {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(this.warmAgentStartupTimeoutMs) ??
          this.warmAgentStartupTimeoutMs,
      });
      if (!result.ok) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        throw new Error(
          `${backend} runtime warmup failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
        );
      }
    }
    this.warmedBackends.add(backend);
  }

  private backoffDelayMs(baseMs: number, attempt: number): number {
    const factor = Math.max(0, attempt - 1);
    const exponential = baseMs * Math.pow(2, factor);
    return Math.max(250, Math.min(60_000, Math.floor(exponential)));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  private async runHostCommandCapture(
    command: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    drainTimedOut: boolean;
  }> {
    const hasExplicitTimeout =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs);
    if (hasExplicitTimeout && Number(opts.timeoutMs) <= 0) {
      return {
        stdout: "",
        stderr: "Command did not start because the absolute job deadline expired.",
        exitCode: 124,
        timedOut: true,
        drainTimedOut: false,
      };
    }
    const timeoutMs = hasExplicitTimeout
      ? Math.max(1, Math.floor(Number(opts.timeoutMs)))
      : DOCKER_CONTROL_TIMEOUT_MS;
    const proc = Bun.spawn(command, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (!isReadableByteStream(stdout) || !isReadableByteStream(stderr)) {
      await terminateDockerExecProcessTree(proc);
      throw new Error(`bounded process capture pipes were unavailable: ${command.join(" ")}`);
    }

    const streamAbort = new AbortController();
    const streams = Promise.all([
      readCapturedProcessStream(stdout, streamAbort.signal),
      readCapturedProcessStream(stderr, streamAbort.signal),
    ]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const streamFailure = streams.then(
      () => new Promise<never>(() => {}),
      (error) => ({ kind: "stream_error" as const, error }),
    );
    const outcome = await Promise.race([
      proc.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      streamFailure,
      new Promise<{ kind: "timeout" }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (outcome.kind === "stream_error") {
      streamAbort.abort();
      await terminateDockerExecProcessTree(proc);
      throw outcome.error;
    }

    const timedOut = outcome.kind === "timeout";
    if (timedOut) {
      await terminateDockerExecProcessTree(proc);
    }

    let captured = await settleWithin(
      streams.catch(() => ["", ""] as [string, string]),
      DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS,
    );
    const drainTimedOut = captured === null;
    if (captured === null) {
      streamAbort.abort();
      if (!timedOut) await terminateDockerExecProcessTree(proc);
      captured = (await settleWithin(
        streams.catch(() => ["", ""] as [string, string]),
        250,
      )) ?? ["", ""];
    }
    const processExitCode = timedOut
      ? ((await settleWithin(proc.exited, DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS)) ?? 124)
      : outcome.exitCode;
    const effectiveTimedOut = timedOut || drainTimedOut;
    return {
      stdout: captured[0].trim(),
      stderr: [
        captured[1].trim(),
        drainTimedOut
          ? `Process streams did not close after ${DOCKER_EXEC_STREAM_DRAIN_TIMEOUT_MS}ms; terminated the process tree.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      exitCode: effectiveTimedOut ? 124 : processExitCode,
      timedOut: effectiveTimedOut,
      drainTimedOut,
    };
  }

  private async runDockerCommandCapture(
    command: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    drainTimedOut: boolean;
  }> {
    return this.runHostCommandCapture(command, opts);
  }

  private compactError(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= 280) return normalized;
    return `${normalized.slice(0, 277)}...`;
  }

  private isRetryableError(err: unknown): boolean {
    const text = this.compactError(err).toLowerCase();
    return this.matchesRetryablePattern(text);
  }

  private isMissingDockerImageError(err: unknown): boolean {
    return isMissingDockerImageDetail(this.compactError(err));
  }

  private isRetryableJobFailure(result: DockerJobResult): boolean {
    // A structured terminal result came from the job runner after it already
    // applied its own revision, validation, and circuit-breaker policies. Do
    // not reinterpret nested validation output (for example, a missing Docker
    // socket inside the sandbox) as a failure of the outer Docker transport.
    if (result.diagnostics?.terminal || result.publishBlocked || result.validationBlocked) {
      return false;
    }
    const text = `${result.summary ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
    if (
      text.includes("repeated unchanged validation failure circuit opened") ||
      text.includes("stopping revisions for this failure cluster")
    ) {
      return false;
    }
    return this.matchesRetryablePattern(text);
  }

  private retryExhaustionCooldownMs(result: DockerJobResult): number {
    const resultCooldownMs = readPositiveNumber(result.cooldownMs) ?? 0;
    return Math.max(this.failureCooldownMs, resultCooldownMs);
  }

  private matchesRetryablePattern(text: string): boolean {
    const transientPatterns: RegExp[] = [
      /warm .*runtime/i,
      /failed to start warm container/i,
      /docker execution error/i,
      /cannot connect to the docker daemon/i,
      /agent server health check failed/i,
      /\bconnection (?:error|refused|reset|aborted|closed)\b/i,
      /\bnetwork is unreachable\b/i,
      /\b(?:econnrefused|econnreset|eai_again)\b/i,
      /\blitellm\.timeout\b/i,
      /\bapitimeouterror\b/i,
      /\b(?:api|request|connection|health check|startup|model preflight|llm)\s+timed out\b/i,
      /\bdeadline exceeded\b/i,
      /\bcontext deadline exceeded\b/i,
      /\btls handshake timeout\b/i,
      /\btemporary failure\b/i,
      /\bopenhands wrapper timed out\b/i,
      /\bjob timed out in docker executor\b/i,
      /\bworktree path not visible inside warm container\b/i,
      /\bchdir to cwd\b/i,
      /\bunable to start container process\b/i,
    ];
    return transientPatterns.some((pattern) => pattern.test(text));
  }

  private hasBudgetForJobRetry(
    attempt: number,
    attemptElapsedMs: number,
    timeoutMs: number,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): boolean {
    if (attempt >= this.jobRetryMaxAttempts) return false;
    const consumedRatio = timeoutMs > 0 ? attemptElapsedMs / timeoutMs : 1;
    if (attemptElapsedMs < Math.max(300_000, timeoutMs * 0.8) && consumedRatio < 0.8) return true;
    const note = `[DockerExecutor] Skipping retry attempt ${
      attempt + 1
    }/${this.jobRetryMaxAttempts}: prior attempt consumed ${attemptElapsedMs}ms of ${timeoutMs}ms budget.`;
    console.warn(note);
    onLog?.("stderr", note);
    return false;
  }

  private hasAbsoluteBudgetForJobRetry(
    attempt: number,
    retryInMs: number,
    deadlineLedger: JobDeadlineLedger,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): boolean {
    const remainingWorkMs = deadlineLedger.remainingWorkMs();
    if (remainingWorkMs > retryInMs) return true;
    const note = `[DockerExecutor] Skipping retry attempt ${
      attempt + 1
    }/${this.jobRetryMaxAttempts}: absolute job deadline has ${remainingWorkMs}ms work budget remaining, which cannot cover ${retryInMs}ms backoff while preserving finalization reserve.`;
    console.warn(note);
    onLog?.("stderr", note);
    return false;
  }

  /**
   * Convert Windows path to Docker-compatible path
   * C:\foo\bar → /c/foo/bar
   */
  private toDockerPath(hostPath: string): string {
    // Check if Windows path (contains :\ or starts with drive letter)
    const winMatch = hostPath.match(/^([a-zA-Z]):([\\/])(.*)$/);
    if (winMatch) {
      const drive = winMatch[1].toLowerCase();
      const rest = winMatch[3].replace(/\\/g, "/");
      return `/${drive}/${rest}`;
    }
    return hostPath;
  }

  /**
   * Clean up orphaned worktrees at startup
   */
  async cleanupOrphanedWorktrees(): Promise<void> {
    try {
      // List all worktrees and only prune stale metadata entries.
      const listed = await this.runHostCommandCapture(["git", "worktree", "list", "--porcelain"], {
        cwd: this.options.repo,
        timeoutMs: HOST_GIT_CONTROL_TIMEOUT_MS,
      });

      if (listed.timedOut || listed.exitCode !== 0) {
        console.warn(
          `[DockerExecutor] Worktree discovery warning: ${
            listed.timedOut
              ? `timed out after ${HOST_GIT_CONTROL_TIMEOUT_MS}ms`
              : listed.stderr || listed.stdout || `exit ${listed.exitCode}`
          }`,
        );
        return;
      }

      const prunablePaths = collectPrunableEphemeralWorktrees(listed.stdout);
      if (prunablePaths.length > 0) {
        for (const path of prunablePaths) {
          console.log(`[DockerExecutor] Pruning stale worktree metadata: ${path}`);
        }
      }

      const prune = await this.runHostCommandCapture(["git", "worktree", "prune"], {
        cwd: this.options.repo,
        timeoutMs: HOST_GIT_CONTROL_TIMEOUT_MS,
      });
      if (prune.timedOut || prune.exitCode !== 0) {
        console.warn(
          `[DockerExecutor] Worktree prune warning: ${
            prune.timedOut
              ? `timed out after ${HOST_GIT_CONTROL_TIMEOUT_MS}ms`
              : prune.stderr || prune.stdout || `exit ${prune.exitCode}`
          }`,
        );
      }
    } catch (err) {
      console.error(`[DockerExecutor] Cleanup error: ${err}`);
    }
  }

  private buildEphemeralWorktreeName(prefix: "job" | "selfcheck", token: string): string {
    const safeToken = this.sanitizeWorktreeToken(token, prefix === "job" ? 8 : 12);
    const nonce = `${Date.now().toString(36).slice(-6)}-${randomUUID().slice(0, 6).toLowerCase()}`;
    return `${prefix}-${safeToken}-${nonce}`;
  }

  private sanitizeWorktreeToken(value: string, maxLength: number): string {
    const normalized = String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized) return "work";
    return normalized.slice(0, maxLength);
  }

  private async ensureFreshWorktreePath(
    worktreePath: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<void> {
    if (!existsSync(worktreePath)) return;

    console.warn(
      `[DockerExecutor] Worktree path already exists; forcing cleanup before create: ${worktreePath}`,
    );

    await this.runHostCommandCapture(
      ["git", "worktree", "remove", "--force", "--force", worktreePath],
      {
        cwd: this.options.repo,
        timeoutMs:
          deadlineLedger?.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS) ??
          HOST_GIT_CONTROL_TIMEOUT_MS,
      },
    );

    await this.runHostCommandCapture(["git", "worktree", "prune"], {
      cwd: this.options.repo,
      timeoutMs:
        deadlineLedger?.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS) ?? HOST_GIT_CONTROL_TIMEOUT_MS,
    });

    if (deadlineLedger?.workExpired()) {
      throw new Error(
        `Stale worktree cleanup for ${worktreePath} stopped at the absolute job work deadline.`,
      );
    }
    const forced = await forceDeleteWorktreePath(worktreePath, {
      sleepFn: (ms) => this.sleep(ms),
    });
    if (!forced.removed) {
      throw new Error(
        `Failed to remove stale worktree path before create (${worktreePath})${
          forced.lastError ? `: ${forced.lastError}` : ""
        }`,
      );
    }
  }

  private isMergeConflictResolutionJob(job: Job): boolean {
    const reviewAgent =
      job.params?.reviewAgent && typeof job.params.reviewAgent === "object"
        ? (job.params.reviewAgent as Record<string, unknown>)
        : null;
    const resolutionType =
      reviewAgent && typeof reviewAgent.resolutionType === "string"
        ? reviewAgent.resolutionType.trim().toLowerCase()
        : "";
    return resolutionType === "merge_conflict" || resolutionType === "integration_reconcile";
  }

  shouldPrepareMergeConflictJobBeforeExecution(job: Job): boolean {
    return this.isMergeConflictResolutionJob(job) && !this.preparedMergeConflictJobs.has(job.id);
  }

  async prepareMergeConflictJobEnvironment(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    await this.ensureFreshImageForMergeConflictJob(job, onLog);
    this.preparedMergeConflictJobs.add(job.id);
  }

  recommendedMergeConflictDeferMs(): number {
    return Math.max(60_000, Math.min(this.options.timeoutMs, 5 * 60_000));
  }

  private async ensureFreshImageForMergeConflictJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    if (!this.isMergeConflictResolutionJob(job)) return;

    if (this.mergeConflictRefreshPromise) {
      await this.mergeConflictRefreshPromise;
      return;
    }

    this.mergeConflictRefreshPromise = this.rebuildImageForMergeConflictJob(job, onLog);
    try {
      await this.mergeConflictRefreshPromise;
    } finally {
      this.mergeConflictRefreshPromise = null;
    }
  }

  private async rebuildImageForMergeConflictJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    const dockerfilePath = sandboxContext.dockerfilePath;
    if (!existsSync(dockerfilePath)) {
      throw new Error(
        `Merge-conflict job ${job.id} requires Docker image refresh, but Dockerfile is missing at ${dockerfilePath}.`,
      );
    }

    const startMsg = `[DockerExecutor] Merge-conflict job ${job.id}: rebuilding ${this.options.imageName} with --no-cache and restarting warm runtime.`;
    console.log(startMsg);
    onLog?.("stdout", startMsg);

    await this.stopWarmContainer("merge-conflict image refresh", true);
    this.warmedBackends.clear();

    const build = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "build",
        "--no-cache",
        "-f",
        dockerfilePath,
        "-t",
        this.options.imageName,
        ".",
      ],
      {
        cwd: sandboxContext.root,
        timeoutMs: DOCKER_IMAGE_BUILD_TIMEOUT_MS,
      },
    );
    if (build.timedOut || build.exitCode !== 0) {
      const detail = [build.stderr, build.stdout].filter(Boolean).join("\n");
      throw new Error(
        `Failed to rebuild Docker image for merge-conflict job ${job.id}: ${
          build.timedOut
            ? `timed out after ${DOCKER_IMAGE_BUILD_TIMEOUT_MS}ms`
            : detail || `exit ${build.exitCode}`
        }`,
      );
    }

    const doneMsg = `[DockerExecutor] Merge-conflict job ${job.id}: Docker image refresh complete (${this.options.imageName}).`;
    console.log(doneMsg);
    onLog?.("stdout", doneMsg);
  }

  private async resolveWorktreeBaseRefForJob(
    job: Job,
    onLog?: (stream: "stdout" | "stderr", line: string) => void,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<string> {
    return resolveReviewWorktreeBase({
      jobId: job.id,
      params: job.params,
      git: (args) => this.runGitBaseRefCommand(args, deadlineLedger),
      fallback: () =>
        resolveFreshWorktreeBaseRef({
          requestedRef: this.options.baseRef,
          integrationBranch:
            this.config.sourceControlManager.mainBranch ||
            this.config.workerpals.baseRef ||
            this.options.baseRef,
          sourceBaseBranch: this.config.sourceControlManager.baseBranch,
          git: (args) => this.runGitBaseRefCommand(args, deadlineLedger),
          log: (level, message) => {
            const line = `[DockerExecutor] ${message}`;
            if (level === "warn") {
              console.warn(line);
              onLog?.("stderr", line);
            } else {
              console.log(line);
              onLog?.("stdout", line);
            }
          },
        }),
      log: (level, message) => {
        const line = `[DockerExecutor] ${message}`;
        if (level === "warn") {
          console.warn(line);
          onLog?.("stderr", line);
        } else {
          console.log(line);
          onLog?.("stdout", line);
        }
      },
    });
  }

  private async runGitBaseRefCommand(
    args: string[],
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const timeoutMs = deadlineLedger
      ? deadlineLedger.capWorkTimeout(HOST_GIT_CONTROL_TIMEOUT_MS)
      : HOST_GIT_CONTROL_TIMEOUT_MS;
    const result = await this.runHostCommandCapture(["git", ...args], {
      cwd: this.options.repo,
      timeoutMs,
    });
    return {
      ok: !result.timedOut && result.exitCode === 0,
      stdout: result.stdout,
      stderr: [result.stderr, result.timedOut ? `git command timed out after ${timeoutMs}ms` : ""]
        .filter(Boolean)
        .join("\n"),
    };
  }

  /**
   * Pull the Docker image
   */
  async pullImage(deadlineLedger?: JobDeadlineLedger): Promise<boolean> {
    const runtimeTag = resolveWorkerpalRuntimeTag();
    const existingRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag(deadlineLedger) : "";
    if (await this.imageExists(deadlineLedger)) {
      if (!runtimeTag || existingRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using local image: ${this.options.imageName}`);
        return true;
      }
      console.warn(
        `[DockerExecutor] Local image ${this.options.imageName} is stale or unlabeled (runtimeTag=${existingRuntimeTag || "missing"}, expected=${runtimeTag}).`,
      );
    }

    if (await this.buildLocalImage(runtimeTag, deadlineLedger)) {
      const rebuiltRuntimeTag = runtimeTag ? await this.inspectImageRuntimeTag(deadlineLedger) : "";
      if (!runtimeTag || rebuiltRuntimeTag === runtimeTag) {
        console.log(`[DockerExecutor] Using locally built image: ${this.options.imageName}`);
        return true;
      }
    }

    console.log(
      `[DockerExecutor] Local image is unavailable or unsuitable. Pulling: ${this.options.imageName}`,
    );
    const pull = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "pull", this.options.imageName],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_IMAGE_PULL_TIMEOUT_MS) ??
          DOCKER_IMAGE_PULL_TIMEOUT_MS,
      },
    );
    if (!pull.timedOut && pull.exitCode === 0) {
      console.log(`[DockerExecutor] Image pulled successfully`);
      return true;
    }

    const detail = pull.stderr || pull.stdout || `docker pull exited ${pull.exitCode}`;
    console.error(
      `[DockerExecutor] Failed to pull image: ${
        pull.timedOut ? `timed out after ${DOCKER_IMAGE_PULL_TIMEOUT_MS}ms` : detail
      }`,
    );

    // Another process may have built/pulled the image while this pull was running.
    if (await this.imageExists(deadlineLedger)) {
      console.warn(
        `[DockerExecutor] Pull failed but local image is now available: ${this.options.imageName}`,
      );
      return true;
    }

    return false;
  }

  /**
   * Check if the Docker image exists locally
   */
  private async imageExists(deadlineLedger?: JobDeadlineLedger): Promise<boolean> {
    const result = await this.runDockerCommandCapture(
      [resolveDockerExecutable(), "image", "inspect", this.options.imageName],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_IMAGE_INSPECT_TIMEOUT_MS) ??
          DOCKER_IMAGE_INSPECT_TIMEOUT_MS,
      },
    );
    if (result.timedOut) {
      console.warn(
        `[DockerExecutor] Timed out checking local image ${this.options.imageName}; treating it as unavailable and attempting rebuild.`,
      );
      return false;
    }
    return result.exitCode === 0;
  }

  private async inspectImageRuntimeTag(deadlineLedger?: JobDeadlineLedger): Promise<string> {
    const result = await this.runDockerCommandCapture(
      [
        resolveDockerExecutable(),
        "image",
        "inspect",
        "--format",
        `{{ index .Config.Labels "${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}" }}`,
        this.options.imageName,
      ],
      {
        timeoutMs:
          deadlineLedger?.capWorkTimeout(DOCKER_IMAGE_INSPECT_TIMEOUT_MS) ??
          DOCKER_IMAGE_INSPECT_TIMEOUT_MS,
      },
    );
    if (result.timedOut) {
      console.warn(
        `[DockerExecutor] Timed out inspecting runtime tag for ${this.options.imageName}; treating the local image as stale and attempting rebuild.`,
      );
      return "";
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
      if (!isMissingDockerImageDetail(detail)) {
        console.warn(
          `[DockerExecutor] Failed to inspect runtime tag for ${this.options.imageName}: ${detail}`,
        );
      }
      return "";
    }
    const value = result.stdout.trim();
    return value === "<no value>" ? "" : value;
  }

  private async buildLocalImage(
    runtimeTag: string,
    deadlineLedger?: JobDeadlineLedger,
  ): Promise<boolean> {
    const sandboxContext = resolveWorkerpalSandboxBuildContext(this.options.repo);
    if (!existsSync(sandboxContext.dockerfilePath)) {
      return false;
    }

    const dockerfileArg = dockerBuildFileArg(sandboxContext.root, sandboxContext.dockerfilePath);
    const caSecretArgs = resolveWorkerpalDockerBuildCaSecretArgs();
    console.log(
      runtimeTag
        ? `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName} for runtimeTag=${runtimeTag}`
        : `[DockerExecutor] Building local WorkerPal sandbox image ${this.options.imageName}`,
    );
    const args = [
      resolveDockerExecutable(),
      "build",
      "-f",
      dockerfileArg,
      "--label",
      WORKERPAL_SANDBOX_COMPONENT_LABEL,
      ...(runtimeTag ? ["--label", `${WORKERPAL_SANDBOX_RUNTIME_TAG_LABEL}=${runtimeTag}`] : []),
      ...caSecretArgs,
      "-t",
      this.options.imageName,
      ".",
    ];
    if (caSecretArgs.length > 0) {
      console.log(
        "[DockerExecutor] Supplying host extra CA trust to the sandbox build as an ephemeral secret.",
      );
    }
    const build = await this.runDockerCommandCapture(args, {
      cwd: sandboxContext.root,
      timeoutMs:
        deadlineLedger?.capWorkTimeout(DOCKER_IMAGE_BUILD_TIMEOUT_MS) ??
        DOCKER_IMAGE_BUILD_TIMEOUT_MS,
    });
    if (!build.timedOut && build.exitCode === 0) {
      return true;
    }
    const detail = build.stderr || build.stdout || `docker build exited ${build.exitCode}`;
    console.error(
      `[DockerExecutor] Failed to build local image: ${
        build.timedOut ? `timed out after ${DOCKER_IMAGE_BUILD_TIMEOUT_MS}ms` : detail
      }`,
    );
    return false;
  }

  /**
   * Check if Docker is available
   */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([resolveDockerExecutable(), "version"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await settleWithin(proc.exited, DOCKER_PROBE_TIMEOUT_MS);
      if (exitCode === null) {
        await terminateDockerExecProcessTree(proc);
        return false;
      }
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}
