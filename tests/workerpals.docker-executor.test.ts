import { describe, expect, test } from "bun:test";
import {
  buildDockerRuntimeCapabilityCanaryCommand,
  buildDependencyStoreReconciliationCommand,
  buildWindowsDockerExecTreeTerminationArgv,
  buildOpenAiCodexHomeStartupCommand,
  buildWorktreeDependencyPreparationCommand,
  collectPrunableEphemeralWorktrees,
  DockerExecutor,
  isEphemeralWorkerWorktreePath,
  parseGitWorktreeListPorcelain,
  prependWorkerpalRuntimeCaStartup,
  probeWorkerLlmHttpEndpointStatus,
  resolveOpenAiCodexContainerHome,
  resolveDockerJobTimeoutMs,
  resolveWorkerpalDockerBuildCaSecretArgs,
  resolveWorkerpalDockerRuntimeCaArgs,
} from "../apps/workerpals/src/docker_executor";
import { removeLinkedNodeModulesDependencyArtifact } from "../apps/workerpals/src/execute_job";
import { inferWorkerTerminalFailureClass } from "../apps/workerpals/src/workerpals_main";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createExecutor() {
  return new DockerExecutor({
    repo: process.cwd(),
    workerId: "workerpal-test",
    imageName: "pushpals-worker-sandbox:latest",
    timeoutMs: 1_800_000,
  });
}

describe("workerpals docker executor internals", () => {
  test("bounds LLM probes through response-body cancellation", async () => {
    let observedSignal: AbortSignal | null = null;
    let cancellationStarted = false;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancellationStarted = true;
            return new Promise<void>(() => {});
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const startedAt = Date.now();
    await expect(
      probeWorkerLlmHttpEndpointStatus("http://127.0.0.1:1234/v1/models", 20, fetchFn),
    ).rejects.toThrow("WorkerPal LLM endpoint probe timed out after 20ms");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cancellationStarted).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
  });

  test("cancels successful LLM probe bodies instead of leaving sockets open", async () => {
    let cancelled = false;
    const status = await probeWorkerLlmHttpEndpointStatus(
      "http://127.0.0.1:1234/v1/models",
      100,
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    expect(status).toBe(200);
    expect(cancelled).toBe(true);
  });

  test("requires the complete worker runtime before accepting a warm container", () => {
    const codexCanary = buildDockerRuntimeCapabilityCanaryCommand("openai_codex");
    expect(codexCanary).toContain("command -v git");
    expect(codexCanary).toContain("command -v bun");
    expect(codexCanary).toContain("command -v node");
    expect(codexCanary).toContain("command -v flock");
    expect(codexCanary).toContain("command -v codex");
    expect(codexCanary).toContain("command -v bunx");
    expect(codexCanary).toContain("/workspace/.venv/bin/python");
    expect(codexCanary).toContain('test -w "$dependency_store"');
    expect(codexCanary).toContain('ln "$dependency_probe/source" "$dependency_probe/link"');
    expect(codexCanary).toContain('rm -rf -- "$dependency_probe"');
    expect(codexCanary).toContain("trusted-host-only");

    const openHandsCanary = buildDockerRuntimeCapabilityCanaryCommand("openhands");
    expect(openHandsCanary).not.toContain("command -v codex");
  });

  test("bounds the production backend warmup probe", async () => {
    const executor = createExecutor() as unknown as {
      ensureBackendWarmup: (backend: "openai_codex") => Promise<void>;
      runWarmShell: (
        command: string,
        options?: { timeoutMs?: number },
      ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
      warmAgentStartupTimeoutMs: number;
    };
    let observedTimeoutMs = 0;
    executor.runWarmShell = async (command, options) => {
      expect(command).toContain("login status");
      observedTimeoutMs = options?.timeoutMs ?? 0;
      return { ok: true, stdout: "codex ready", stderr: "", exitCode: 0 };
    };

    await executor.ensureBackendWarmup("openai_codex");

    expect(observedTimeoutMs).toBe(executor.warmAgentStartupTimeoutMs);
    expect(observedTimeoutMs).toBeGreaterThanOrEqual(10_000);
  });

  test("bounds custom backend warmup health checks", async () => {
    const executor = createExecutor() as unknown as {
      ensureBackendWarmup: (backend: "openhands") => Promise<void>;
      runWarmShell: (
        command: string,
        options?: { timeoutMs?: number },
      ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
      warmAgentStartupTimeoutMs: number;
    };
    const observedTimeouts: number[] = [];
    executor.runWarmShell = async (command, options) => {
      expect(command).toContain("127.0.0.1");
      observedTimeouts.push(options?.timeoutMs ?? 0);
      return { ok: true, stdout: "healthy", stderr: "", exitCode: 0 };
    };

    await executor.ensureBackendWarmup("openhands");

    expect(observedTimeouts).toEqual([executor.warmAgentStartupTimeoutMs]);
  });

  test("builds forced Windows process-tree termination for Docker exec clients", () => {
    expect(buildWindowsDockerExecTreeTerminationArgv(9876)).toEqual([
      "taskkill",
      "/PID",
      "9876",
      "/T",
      "/F",
    ]);
  });

  test("bounds process exit even when a child closes its output streams before hanging", async () => {
    const executor = createExecutor() as unknown as {
      runDockerCommandCapture: (
        command: string[],
        options: { timeoutMs: number },
      ) => Promise<{ timedOut: boolean; exitCode: number; stdout: string }>;
    };
    const startedAt = Date.now();
    const result = await executor.runDockerCommandCapture(
      [
        process.execPath,
        "-e",
        'process.stdout.write("ready\\n"); process.stdout.end(); process.stderr.end(); await Bun.sleep(60_000);',
      ],
      { timeoutMs: 100 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  test("fails a timed-out host git worktree creation without continuing configuration", async () => {
    const executor = createExecutor() as unknown as {
      createWorktree: (worktreePath: string, baseRef: string) => Promise<void>;
      runHostCommandCapture: (
        command: string[],
        options: { cwd?: string; timeoutMs?: number },
      ) => Promise<{ timedOut: boolean; exitCode: number; stdout: string; stderr: string }>;
    };
    const commands: string[][] = [];
    executor.runHostCommandCapture = async (command, options) => {
      commands.push(command);
      expect(options.timeoutMs).toBeGreaterThan(0);
      return { timedOut: true, exitCode: 124, stdout: "", stderr: "" };
    };

    await expect(
      executor.createWorktree(
        join(tmpdir(), `pushpals-timeout-create-${Date.now()}`),
        "refs/heads/main",
      ),
    ).rejects.toThrow("git worktree add timed out");
    expect(commands).toHaveLength(1);
    expect(commands[0].slice(0, 4)).toEqual(["git", "-c", "core.autocrlf=false", "-c"]);
  });

  test("bounds worktree removal and prune independently before filesystem cleanup", async () => {
    const executor = createExecutor() as unknown as {
      removeWorktree: (worktreePath: string) => Promise<void>;
      runHostCommandCapture: (
        command: string[],
        options: { cwd?: string; timeoutMs?: number },
      ) => Promise<{ timedOut: boolean; exitCode: number; stdout: string; stderr: string }>;
    };
    const commands: string[][] = [];
    executor.runHostCommandCapture = async (command, options) => {
      commands.push(command);
      expect(options.timeoutMs).toBeGreaterThan(0);
      return { timedOut: true, exitCode: 124, stdout: "", stderr: "" };
    };

    await executor.removeWorktree(join(tmpdir(), `pushpals-timeout-remove-${Date.now()}`));

    expect(commands.map((command) => command.slice(0, 3))).toEqual([
      ["git", "worktree", "remove"],
      ["git", "worktree", "prune"],
    ]);
  });

  test("bounds startup worktree pruning and base-ref git probes", async () => {
    const executor = createExecutor() as unknown as {
      cleanupOrphanedWorktrees: () => Promise<void>;
      runGitBaseRefCommand: (
        args: string[],
      ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
      runHostCommandCapture: (
        command: string[],
        options: { cwd?: string; timeoutMs?: number },
      ) => Promise<{ timedOut: boolean; exitCode: number; stdout: string; stderr: string }>;
    };
    const commands: string[][] = [];
    executor.runHostCommandCapture = async (command, options) => {
      commands.push(command);
      expect(options.timeoutMs).toBeGreaterThan(0);
      if (command.includes("--porcelain")) {
        return { timedOut: false, exitCode: 0, stdout: "worktree /repo\nHEAD abc\n", stderr: "" };
      }
      return { timedOut: true, exitCode: 124, stdout: "", stderr: "" };
    };

    await executor.cleanupOrphanedWorktrees();
    const baseRef = await executor.runGitBaseRefCommand(["rev-parse", "HEAD"]);

    expect(commands.map((command) => command.join(" "))).toEqual([
      "git worktree list --porcelain",
      "git worktree prune",
      "git rev-parse HEAD",
    ]);
    expect(baseRef.ok).toBe(false);
    expect(baseRef.stderr).toContain("git command timed out");
  });

  test("awaits warm-container recycle and clears stale backend readiness after a timeout", async () => {
    const executor = createExecutor() as unknown as {
      warmedBackends: Set<string>;
      warmContainerName: string;
      runBoundedDockerControl: (args: string[], timeoutMs: number) => Promise<boolean>;
      recycleWarmContainerAfterExecutionTimeout: () => Promise<void>;
    };
    executor.warmedBackends.add("openai_codex");
    const commands: string[][] = [];
    executor.runBoundedDockerControl = async (args, timeoutMs) => {
      expect(timeoutMs).toBeGreaterThan(0);
      commands.push(args);
      return true;
    };

    await executor.recycleWarmContainerAfterExecutionTimeout();

    expect(executor.warmedBackends.size).toBe(0);
    expect(commands).toEqual([["restart", "-t", "1", executor.warmContainerName]]);
  });

  test("removes a timed-out warm container when bounded restart fails", async () => {
    const executor = createExecutor() as unknown as {
      warmContainerName: string;
      runBoundedDockerControl: (args: string[], timeoutMs: number) => Promise<boolean>;
      recycleWarmContainerAfterExecutionTimeout: () => Promise<void>;
    };
    const commands: string[][] = [];
    executor.runBoundedDockerControl = async (args) => {
      commands.push(args);
      return commands.length > 1;
    };

    await executor.recycleWarmContainerAfterExecutionTimeout();

    expect(commands).toEqual([
      ["restart", "-t", "1", executor.warmContainerName],
      ["rm", "-f", executor.warmContainerName],
    ]);
  });

  test("cleans dependency projections through the named volume when the warm container is gone", async () => {
    const executor = createExecutor() as unknown as {
      cleanupContainerDependencyProjection: (worktreePath: string) => Promise<void>;
      preparedDependencyProjectionIds: Set<string>;
      runWarmShell: () => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
      runDockerCommandCapture: (
        command: string[],
        options: { timeoutMs: number },
      ) => Promise<{ timedOut: boolean; exitCode: number; stdout: string; stderr: string }>;
    };
    executor.runWarmShell = async () => ({
      ok: false,
      stdout: "",
      stderr: "warm container missing",
      exitCode: 1,
    });
    executor.preparedDependencyProjectionIds.add("job-cleanup-123");
    let cleanupCommand: string[] = [];
    executor.runDockerCommandCapture = async (command, options) => {
      expect(options.timeoutMs).toBeGreaterThan(0);
      cleanupCommand = command;
      return { timedOut: false, exitCode: 0, stdout: "", stderr: "" };
    };

    await executor.cleanupContainerDependencyProjection(
      join(process.cwd(), ".worktrees", "job-cleanup-123"),
    );

    expect(cleanupCommand).toContain("--mount");
    expect(cleanupCommand.join(" ")).toContain("type=volume,source=pushpals-deps-");
    expect(cleanupCommand.at(-1)).toContain(
      "/workspace/.pushpals/dependency-store/projections/job-cleanup-123",
    );
  });

  test("retains failed dependency projection cleanup for a later bounded retry", async () => {
    const executor = createExecutor() as unknown as {
      cleanupContainerDependencyProjection: (worktreePath: string) => Promise<void>;
      preparedDependencyProjectionIds: Set<string>;
      dependencyStoreReconciled: boolean;
      runWarmShell: () => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
      runDockerCommandCapture: () => Promise<{
        timedOut: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    };
    const worktreeId = "job-cleanup-retry";
    const worktreePath = join(process.cwd(), ".worktrees", worktreeId);
    executor.preparedDependencyProjectionIds.add(worktreeId);
    executor.dependencyStoreReconciled = true;
    executor.runWarmShell = async () => ({
      ok: false,
      stdout: "",
      stderr: "warm cleanup failed",
      exitCode: 1,
    });
    executor.runDockerCommandCapture = async () => ({
      timedOut: true,
      exitCode: 124,
      stdout: "",
      stderr: "",
    });

    await executor.cleanupContainerDependencyProjection(worktreePath);
    expect(executor.preparedDependencyProjectionIds.has(worktreeId)).toBe(true);
    expect(executor.dependencyStoreReconciled).toBe(false);

    executor.runDockerCommandCapture = async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await executor.cleanupContainerDependencyProjection(worktreePath);
    expect(executor.preparedDependencyProjectionIds.has(worktreeId)).toBe(false);
  });

  test("reconciles orphan managed projections and bounds snapshot GC safely", async () => {
    const command = buildDependencyStoreReconciliationCommand("/store", "/repo/.worktrees");
    expect(command).toContain('case "$projection_id" in job-*|selfcheck-*');
    expect(command).toContain('[ ! -d "$worktree_root/$projection_id" ]');
    expect(command).toContain("dependency_snapshot_max_entries=8");
    expect(command).toContain("dependency_snapshot_max_age_seconds=604800");
    expect(command).toContain("-name .pushpals-dependency-snapshot");
    expect(command).toContain('exec 8>"$gc_snapshot_root.lock"');
    expect(command).toContain("flock -n 8");
    expect(command).toContain('[ "$gc_snapshot_name" != "$gc_current_key" ]');
  });

  test("clears retained orphan projection IDs only after startup reconciliation succeeds", async () => {
    const executor = createExecutor() as unknown as {
      reconcileContainerDependencyStore: () => Promise<void>;
      preparedDependencyProjectionIds: Set<string>;
      dependencyStoreReconciled: boolean;
      runWarmShell: (
        command: string,
        options: { timeoutMs: number },
      ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
    };
    const worktreeId = `job-orphan-${Date.now()}`;
    executor.preparedDependencyProjectionIds.add(worktreeId);
    let command = "";
    executor.runWarmShell = async (observed, options) => {
      command = observed;
      expect(options.timeoutMs).toBeGreaterThan(0);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };

    await executor.reconcileContainerDependencyStore();

    expect(command).toContain("gc_dependency_snapshots");
    expect(executor.preparedDependencyProjectionIds.has(worktreeId)).toBe(false);
    expect(executor.dependencyStoreReconciled).toBe(true);
  });

  test("reconciles the dependency store when adopting an already-running warm container", async () => {
    const executor = createExecutor() as unknown as {
      ensureWarmContainer: () => Promise<void>;
      reconcileContainerDependencyStore: () => Promise<void>;
      runDockerCommandCapture: () => Promise<{
        timedOut: boolean;
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    };
    executor.runDockerCommandCapture = async () => ({
      timedOut: false,
      exitCode: 0,
      stdout: "true|bridge",
      stderr: "",
    });
    let reconciliations = 0;
    executor.reconcileContainerDependencyStore = async () => {
      reconciliations += 1;
    };

    await executor.ensureWarmContainer();

    expect(reconciliations).toBe(1);
  });

  test("passes an existing host CA bundle to Docker builds as an ephemeral secret", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-docker-ca-"));
    const caPath = join(root, "extra-ca.pem");
    writeFileSync(caPath, "test certificate\n", "utf8");
    try {
      expect(resolveWorkerpalDockerBuildCaSecretArgs({ NODE_EXTRA_CA_CERTS: caPath })).toEqual([
        "--secret",
        `id=pushpals_extra_ca,src=${caPath}`,
      ]);
      expect(
        resolveWorkerpalDockerBuildCaSecretArgs({
          NODE_EXTRA_CA_CERTS: join(root, "missing.pem"),
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mounts existing host CA trust read-only and merges it with container system roots", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-docker-runtime-ca-"));
    const caPath = join(root, "extra-ca.pem");
    writeFileSync(caPath, "test certificate\n", "utf8");
    try {
      expect(
        resolveWorkerpalDockerRuntimeCaArgs(
          { NODE_EXTRA_CA_CERTS: caPath },
          (path) => path === caPath,
          (path) => `docker:${path}`,
        ),
      ).toEqual([
        "--mount",
        `type=bind,src=docker:${caPath},dst=/run/pushpals/host-extra-ca.pem,readonly`,
        "-e",
        "NODE_EXTRA_CA_CERTS=/run/pushpals/host-extra-ca.pem",
        "-e",
        "SSL_CERT_FILE=/run/pushpals/ca-bundle.pem",
        "-e",
        "GIT_SSL_CAINFO=/run/pushpals/ca-bundle.pem",
        "-e",
        "REQUESTS_CA_BUNDLE=/run/pushpals/ca-bundle.pem",
        "-e",
        "CURL_CA_BUNDLE=/run/pushpals/ca-bundle.pem",
        "-e",
        "PIP_CERT=/run/pushpals/ca-bundle.pem",
      ]);
      expect(
        resolveWorkerpalDockerRuntimeCaArgs({
          PUSHPALS_DOCKER_RUNTIME_EXTRA_CA_CERTS: join(root, "missing.pem"),
        }),
      ).toEqual([]);

      const startup = prependWorkerpalRuntimeCaStartup("tail -f /dev/null", true);
      expect(startup).toContain(
        "cat /etc/ssl/certs/ca-certificates.crt /run/pushpals/host-extra-ca.pem > /run/pushpals/ca-bundle.pem",
      );
      expect(startup.endsWith("tail -f /dev/null")).toBe(true);
      expect(prependWorkerpalRuntimeCaStartup("tail -f /dev/null", false)).toBe(
        "tail -f /dev/null",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readStream reassembles chunk-split lines", async () => {
    const executor = createExecutor() as unknown as {
      readStream: (
        readable: ReadableStream<Uint8Array>,
        streamName: "stdout" | "stderr",
        onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
        lines: string[],
      ) => Promise<void>;
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('___RESULT___ {"ok":true'));
        controller.enqueue(encoder.encode(',"summary":"ok"}\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await executor.readStream(stream, "stdout", undefined, lines);
    expect(lines).toEqual(['___RESULT___ {"ok":true,"summary":"ok"}']);
  });

  test("readStream forwards noisy output while retaining only an explicit bounded tail", async () => {
    const executor = createExecutor() as unknown as {
      readStream: (
        readable: ReadableStream<Uint8Array>,
        streamName: "stdout" | "stderr",
        onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
        lines: string[],
        signal?: AbortSignal,
        maxRetainedChars?: number,
      ) => Promise<void>;
    };
    const emittedLines = Array.from(
      { length: 2_000 },
      (_, index) => `noisy-line-${index.toString().padStart(4, "0")}-${"x".repeat(64)}`,
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${emittedLines.join("\n")}\n`));
        controller.close();
      },
    });
    const retained: string[] = [];
    const forwarded: string[] = [];

    await executor.readStream(
      stream,
      "stdout",
      (_stream, line) => forwarded.push(line),
      retained,
      undefined,
      512,
    );

    expect(forwarded).toHaveLength(emittedLines.length);
    expect(forwarded[0]).toBe(emittedLines[0]);
    expect(forwarded.at(-1)).toBe(emittedLines.at(-1));
    expect(retained[0]).toContain("[PushPals] Earlier process output truncated");
    expect(retained.join("\n")).not.toContain(emittedLines[0]);
    expect(retained.at(-1)).toBe(emittedLines.at(-1));
    expect(retained.slice(1).join("\n").length).toBeLessThanOrEqual(512);
  });

  test("readStream caps an endless no-newline line while continuing to drain", async () => {
    const executor = createExecutor() as unknown as {
      readStream: (
        readable: ReadableStream<Uint8Array>,
        streamName: "stdout" | "stderr",
        onLog: ((stream: "stdout" | "stderr", line: string) => void) | undefined,
        lines: string[],
        signal?: AbortSignal,
        maxRetainedChars?: number,
      ) => Promise<void>;
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 20; index += 1) {
          controller.enqueue(
            encoder.encode(`${String(index).padStart(2, "0")}:${"x".repeat(500)}`),
          );
        }
        controller.enqueue(encoder.encode("retained-tail"));
        controller.close();
      },
    });
    const retained: string[] = [];
    const forwarded: string[] = [];

    await executor.readStream(
      stream,
      "stdout",
      (_stream, line) => forwarded.push(line),
      retained,
      undefined,
      512,
    );

    expect(forwarded[0]).toContain("Oversized unterminated process-output line truncated");
    expect(forwarded).toHaveLength(2);
    expect(forwarded.at(-1)).toEndWith("retained-tail");
    expect(retained[0]).toContain("Earlier process output truncated");
    expect(retained.slice(1).join("\n").length).toBeLessThanOrEqual(512);
    expect(retained.at(-1)).toEndWith("retained-tail");
  });

  test("parseResult only reports docker-timeout summary when docker timeout fired", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => {
        ok: boolean;
        summary: string;
      };
    };

    const terminated = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: false,
      elapsedMs: 500_000,
      timeoutMs: 1_800_000,
    });
    expect(terminated.ok).toBe(false);
    expect(terminated.summary).toContain("terminated (exit 143)");
    expect(terminated.summary).not.toContain("timed out in Docker executor");

    const timedOut = executor.parseResult(["partial logs"], [], 143, {
      timedOutByDocker: true,
      elapsedMs: 1_234_567,
      timeoutMs: 14_400_000,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.summary).toContain("timed out in Docker executor");
    expect(timedOut.summary).toContain("1234567ms");
    expect(timedOut.summary).toContain("14400000ms");
  });

  test("parseResult rejects structured success when the Docker deadline fired", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => {
        ok: boolean;
        summary: string;
        stderr?: string;
        exitCode?: number;
        diagnostics?: {
          terminal?: { failureClass?: string; metadata?: Record<string, unknown> };
        };
      };
    };

    const result = executor.parseResult(
      [
        `___RESULT___ ${JSON.stringify({
          ok: true,
          summary: "runner claimed success before hanging",
          exitCode: 0,
        })}`,
      ],
      [],
      143,
      { timedOutByDocker: true, elapsedMs: 90_005, timeoutMs: 90_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain("timed out in Docker executor");
    expect(result.stderr).toContain("Discarded the structured result");
    expect(result.diagnostics?.terminal?.failureClass).toBe("timeout");
    expect(result.diagnostics?.terminal?.metadata).toMatchObject({
      structuredResult: true,
      processStateOverrodeStructuredResult: true,
      timedOutByDocker: true,
    });
  });

  test("parseResult rejects structured success when the job process exits nonzero", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => {
        ok: boolean;
        summary: string;
        stderr?: string;
        exitCode?: number;
        diagnostics?: { terminal?: { failureClass?: string } };
      };
    };

    const result = executor.parseResult(
      [
        `___RESULT___ ${JSON.stringify({
          ok: true,
          summary: "runner claimed success before crashing",
          exitCode: 0,
        })}`,
      ],
      [],
      3,
      { timedOutByDocker: false, elapsedMs: 1_500, timeoutMs: 90_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.summary).toContain("process exited 3");
    expect(result.stderr).toContain("Discarded the structured ok=true result");
    expect(result.diagnostics?.terminal?.failureClass).toBe("nonzero_exit");
  });

  test("parseResult preserves a valid zero-exit structured success", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => { ok: boolean; summary: string; exitCode?: number };
    };

    const result = executor.parseResult(
      [
        `___RESULT___ ${JSON.stringify({
          ok: true,
          summary: "runner completed normally",
          exitCode: 0,
        })}`,
      ],
      [],
      0,
      { timedOutByDocker: false, elapsedMs: 1_500, timeoutMs: 90_000 },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "runner completed normally",
      exitCode: 0,
    });
  });

  test("parseResult requires a strict structured-result boundary schema", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => {
        ok: boolean;
        summary: string;
        exitCode?: number;
        diagnostics?: { terminal?: { failureClass?: string } };
      };
    };
    const malformedPayloads: unknown[] = [
      { summary: "missing ok", exitCode: 0 },
      { ok: "false", summary: "string ok", exitCode: 0 },
      { ok: true, summary: "string exit", exitCode: "3" },
      { ok: true, summary: "fractional exit", exitCode: 0.5 },
      [],
    ];

    for (const payload of malformedPayloads) {
      const result = executor.parseResult([`___RESULT___ ${JSON.stringify(payload)}`], [], 0, {
        timedOutByDocker: false,
        streamDrainTimedOut: false,
        elapsedMs: 10,
        timeoutMs: 90_000,
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
      expect(inferWorkerTerminalFailureClass(result)).toBe("malformed_structured_result");
    }
  });

  test("parseResult preserves valid explicit failure and exit-code-omitted success", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => { ok: boolean; summary: string; exitCode?: number };
    };
    const context = {
      timedOutByDocker: false,
      streamDrainTimedOut: false,
      elapsedMs: 10,
      timeoutMs: 90_000,
    };

    const failure = executor.parseResult(
      [`___RESULT___ ${JSON.stringify({ ok: false, summary: "valid failure", exitCode: 0 })}`],
      [],
      0,
      context,
    );
    const success = executor.parseResult(
      [`___RESULT___ ${JSON.stringify({ ok: true, summary: "valid success" })}`],
      [],
      0,
      context,
    );

    expect(failure).toMatchObject({ ok: false, summary: "valid failure", exitCode: 0 });
    expect(success).toMatchObject({ ok: true, summary: "valid success" });
  });

  test("parseResult treats only the newest sentinel as authoritative", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => { ok: boolean; summary: string; diagnostics?: { terminal?: { failureClass?: string } } };
    };

    for (const newestSentinel of ["___RESULT___ {this-is-not-json", "___RESULT___"]) {
      const result = executor.parseResult(
        [
          `___RESULT___ ${JSON.stringify({ ok: true, summary: "stale success", exitCode: 0 })}`,
          newestSentinel,
        ],
        [],
        0,
        {
          timedOutByDocker: false,
          streamDrainTimedOut: false,
          elapsedMs: 10,
          timeoutMs: 90_000,
        },
      );

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("malformed structured result");
      expect(result.diagnostics?.terminal?.failureClass).toBe("malformed_structured_result");
    }
  });

  test("parseResult rejects zero-exit jobs without a structured result", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => {
        ok: boolean;
        summary: string;
        exitCode?: number;
        diagnostics?: { terminal?: { failureClass?: string } };
      };
    };

    const result = executor.parseResult(["runner exited quietly"], [], 0, {
      timedOutByDocker: false,
      streamDrainTimedOut: false,
      elapsedMs: 10,
      timeoutMs: 90_000,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("without returning a structured result");
    expect(result.diagnostics?.terminal?.failureClass).toBe("no_structured_result");
  });

  test("parseResult rejects structured success when stream draining times out", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => {
        ok: boolean;
        summary: string;
        exitCode?: number;
        diagnostics?: { terminal?: { failureClass?: string; metadata?: Record<string, unknown> } };
      };
    };

    const result = executor.parseResult(
      [`___RESULT___ ${JSON.stringify({ ok: true, summary: "stale success", exitCode: 0 })}`],
      [],
      0,
      {
        timedOutByDocker: false,
        streamDrainTimedOut: true,
        elapsedMs: 2_100,
        timeoutMs: 90_000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain("streams did not close");
    expect(result.diagnostics?.terminal?.metadata).toMatchObject({
      streamDrainTimedOut: true,
      processStateOverrodeStructuredResult: true,
    });
    expect(inferWorkerTerminalFailureClass(result)).toBe("timeout");
  });

  test("terminal inference trusts Docker-owned process overrides", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: {
          timedOutByDocker: boolean;
          streamDrainTimedOut: boolean;
          elapsedMs: number;
          timeoutMs: number;
        },
      ) => { ok: boolean; summary: string; diagnostics?: { terminal?: { failureClass?: string } } };
    };

    const result = executor.parseResult(
      [`___RESULT___ ${JSON.stringify({ ok: true, summary: "stale success", exitCode: 0 })}`],
      [],
      3,
      {
        timedOutByDocker: false,
        streamDrainTimedOut: false,
        elapsedMs: 10,
        timeoutMs: 90_000,
      },
    );

    expect(result.diagnostics?.terminal?.failureClass).toBe("nonzero_exit");
    expect(inferWorkerTerminalFailureClass(result)).toBe("nonzero_exit");
  });

  test("parseResult reports missing prompt assets without misclassifying them as timeouts", () => {
    const executor = createExecutor() as unknown as {
      parseResult: (
        stdoutLines: string[],
        stderrLines: string[],
        exitCode: number,
        context: { timedOutByDocker: boolean; elapsedMs: number; timeoutMs: number },
      ) => {
        summary: string;
        diagnostics?: { terminal?: { failureClass?: string; watchdogFired?: boolean } };
      };
    };
    const result = executor.parseResult(
      ["Task requested bounded timeout handling"],
      [
        "[JobRunner] Fatal error: Error: ENOENT: no such file or directory, open '/workspace/prompts/review_agent/reviewer.md'",
      ],
      1,
      { timedOutByDocker: false, elapsedMs: 600_000, timeoutMs: 7_260_000 },
    );

    expect(result.summary).toContain("required WorkerPal runtime asset was missing");
    expect(result.diagnostics?.terminal?.failureClass).toBe("missing_runtime_asset");
    expect(result.diagnostics?.terminal?.watchdogFired).toBe(false);
  });

  test("caps Docker timeout for browser-validation repair jobs", () => {
    const regularTimeout = resolveDockerJobTimeoutMs(1_860_000, {
      kind: "task.execute",
      params: {
        planning: {
          validationSteps: ["bun test", "bun x tsc --noEmit"],
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      },
    });
    expect(regularTimeout).toBe(1_860_000);

    const browserTimeout = resolveDockerJobTimeoutMs(7_260_000, {
      kind: "task.execute",
      params: {
        planning: {
          validationSteps: ["bun test", "bun run web:e2e"],
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      },
    });
    expect(browserTimeout).toBe(45 * 60_000);
  });

  test("retry matching no longer treats generic timeout words as transient", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(executor.matchesRetryablePattern("opened timeout_policy.ts for review")).toBe(false);
    expect(executor.matchesRetryablePattern("APITimeoutError: Request timed out")).toBe(true);
    expect(executor.matchesRetryablePattern("OpenHands wrapper timed out after 900000ms")).toBe(
      true,
    );
  });

  test("retry matching treats docker cwd races as transient", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(
      executor.matchesRetryablePattern(
        'OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/repo/.worktrees/job-123") set in config.json failed: no such file or directory: unknown',
      ),
    ).toBe(true);
    expect(
      executor.matchesRetryablePattern(
        "worktree path not visible inside warm container after 5000ms: /repo/.worktrees/job-123",
      ),
    ).toBe(true);
  });

  test("retry matching leaves classified Codex startup stalls to the Codex wrapper", () => {
    const executor = createExecutor() as unknown as {
      matchesRetryablePattern: (text: string) => boolean;
    };

    expect(
      executor.matchesRetryablePattern(
        "openai_codex stalled before first response\nCodex event trace:\n- thread.started\n- turn.started",
      ),
    ).toBe(false);
    expect(executor.matchesRetryablePattern("startup stall after Codex restart")).toBe(false);
    expect(executor.matchesRetryablePattern("warm runtime startup timed out")).toBe(true);
  });

  test("does not retry structured job terminals from nested validation failures", () => {
    const executor = createExecutor() as unknown as {
      isRetryableJobFailure: (result: {
        ok: boolean;
        summary: string;
        stderr?: string;
        diagnostics?: { terminal?: { terminalStage?: string } };
      }) => boolean;
    };
    const nestedDockerFailure =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. " +
      "Is the docker daemon running?";

    expect(
      executor.isRetryableJobFailure({
        ok: false,
        summary: "Repeated unchanged validation failure circuit opened",
        stderr: nestedDockerFailure,
        diagnostics: {
          terminal: {
            terminalStage: "validation_circuit_breaker",
          },
        },
      }),
    ).toBe(false);
    expect(
      executor.isRetryableJobFailure({
        ok: false,
        summary: "Repeated unchanged validation failure circuit opened",
        stderr:
          `${nestedDockerFailure}\n` +
          "Stopping revisions for this failure cluster; dispatch a root-cause repair.",
      }),
    ).toBe(false);
    expect(
      executor.isRetryableJobFailure({
        ok: false,
        summary: "Docker execution error",
        stderr: "connection reset while contacting the warm runtime",
      }),
    ).toBe(true);
  });

  test("retry exhaustion preserves longer executor-provided cooldowns", () => {
    const executor = createExecutor() as unknown as {
      retryExhaustionCooldownMs: (result: { cooldownMs?: number }) => number;
    };

    expect(executor.retryExhaustionCooldownMs({ cooldownMs: 600_000 })).toBe(600_000);
    expect(executor.retryExhaustionCooldownMs({ cooldownMs: 1_000 })).toBe(20_000);
  });

  test("worktree names stay short enough for Windows cleanup", () => {
    const executor = createExecutor() as unknown as {
      buildEphemeralWorktreeName: (prefix: "job" | "selfcheck", token: string) => string;
    };

    const jobName = executor.buildEphemeralWorktreeName(
      "job",
      "70a6e51e-485e-457c-9c76-07b1ca2b3246",
    );
    const selfcheckName = executor.buildEphemeralWorktreeName("selfcheck", "startup");

    expect(jobName).toMatch(/^job-70a6e51e-[a-z0-9]+-[a-z0-9]+$/);
    expect(jobName.length).toBeLessThanOrEqual(28);
    expect(selfcheckName).toMatch(/^selfcheck-startup-[a-z0-9]+-[a-z0-9]+$/);
    expect(selfcheckName.length).toBeLessThanOrEqual(32);
  });

  test("retry budget guard skips a second attempt after near-timeout execution", () => {
    const executor = createExecutor() as unknown as {
      hasBudgetForJobRetry: (
        attempt: number,
        attemptElapsedMs: number,
        timeoutMs: number,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => boolean;
    };
    const logs: string[] = [];

    expect(
      executor.hasBudgetForJobRetry(1, 2_690_000, 2_700_000, (stream, line) => {
        logs.push(`${stream}:${line}`);
      }),
    ).toBe(false);
    expect(logs.join("\n")).toContain("Skipping retry attempt 2");
    expect(executor.hasBudgetForJobRetry(1, 120_000, 2_700_000)).toBe(true);
  });

  test("writeJobSpecToStdin supports Web WritableStream stdin", async () => {
    const executor = createExecutor() as unknown as {
      writeJobSpecToStdin: (
        proc: { stdin?: WritableStream<Uint8Array> },
        spec: string,
      ) => Promise<void>;
    };
    const chunks: string[] = [];
    let closed = false;
    const decoder = new TextDecoder();
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(decoder.decode(chunk));
      },
      close() {
        closed = true;
      },
    });

    await executor.writeJobSpecToStdin({ stdin }, "encoded-spec");

    expect(chunks).toEqual(["encoded-spec"]);
    expect(closed).toBe(true);
  });

  test("writeJobSpecToStdin supports Bun FileSink-style stdin", async () => {
    const executor = createExecutor() as unknown as {
      writeJobSpecToStdin: (
        proc: {
          stdin?: {
            write: (chunk: Uint8Array | string) => void;
            flush: () => void;
            end: () => void;
          };
        },
        spec: string,
      ) => Promise<void>;
    };
    const calls: string[] = [];
    const decoder = new TextDecoder();
    const stdin = {
      write(chunk: Uint8Array | string) {
        calls.push(`write:${typeof chunk === "string" ? chunk : decoder.decode(chunk)}`);
      },
      flush() {
        calls.push("flush");
      },
      end() {
        calls.push("end");
      },
    };

    await executor.writeJobSpecToStdin({ stdin }, "encoded-spec");

    expect(calls).toEqual(["write:encoded-spec", "flush", "end"]);
  });

  test("warm-container docker exec keeps stdin attached for spec streaming", () => {
    const executor = createExecutor() as unknown as {
      warmContainerName: string;
      buildWarmContainerExecArgs: (containerWorktreePath: string) => string[];
    };
    executor.warmContainerName = "pushpals-workerpal-test-warm";

    const args = executor.buildWarmContainerExecArgs("/repo/.worktrees/job-abc");

    expect(args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/repo/.worktrees/job-abc"]);
    expect(args).toContain("--spec-stdin");
  });

  test("imageExists treats inspection timeouts as unavailable instead of hanging", async () => {
    const executor = createExecutor() as unknown as {
      imageExists: () => Promise<boolean>;
      runDockerCommandCapture: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      }>;
    };

    executor.runDockerCommandCapture = async () => ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: true,
    });

    await expect(executor.imageExists()).resolves.toBe(false);
  });

  test("inspectImageRuntimeTag treats inspection timeouts as stale so rebuild can proceed", async () => {
    const executor = createExecutor() as unknown as {
      inspectImageRuntimeTag: () => Promise<string>;
      runDockerCommandCapture: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      }>;
    };

    executor.runDockerCommandCapture = async () => ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: true,
    });

    await expect(executor.inspectImageRuntimeTag()).resolves.toBe("");
  });

  test("ensureWorktreeAccessibleInWarmContainer recycles the warm container after a visibility race", async () => {
    const executor = createExecutor() as unknown as {
      ensureWorktreeAccessibleInWarmContainer: (
        worktreePath: string,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<string>;
      ensureWarmContainer: () => Promise<void>;
      waitForWorktreePathInWarmContainer: (
        containerWorktreePath: string,
        timeoutMs?: number,
      ) => Promise<void>;
      runWarmWorktreeProbe: (containerWorktreePath: string) => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
      stopWarmContainer: (reason: string, quiet?: boolean) => Promise<void>;
      inspectWarmContainerState: () => Promise<string>;
    };

    let visibilityAttempts = 0;
    let stopCalls = 0;
    executor.ensureWarmContainer = async () => {};
    executor.waitForWorktreePathInWarmContainer = async () => {
      visibilityAttempts += 1;
      if (visibilityAttempts === 1) {
        throw new Error(
          "worktree path not visible inside warm container after 15000ms: /repo/.worktrees/job-123",
        );
      }
    };
    executor.runWarmWorktreeProbe = async () => ({
      ok: true,
      stdout: "true\n.git",
      stderr: "",
      exitCode: 0,
    });
    executor.stopWarmContainer = async () => {
      stopCalls += 1;
    };
    executor.inspectWarmContainerState = async () => "running=true";

    const result = await executor.ensureWorktreeAccessibleInWarmContainer(
      join(process.cwd(), ".worktrees", "job-123"),
    );

    expect(result).toContain("/repo/.worktrees/job-123");
    expect(visibilityAttempts).toBe(2);
    expect(stopCalls).toBe(1);
  });

  test("ensureWarmRuntimeReady rebuilds when the warm image vanished locally", async () => {
    const executor = createExecutor() as unknown as {
      ensureWarmRuntimeReady: (
        job: {
          id: string;
          taskId: string;
          kind: string;
          params: Record<string, unknown>;
          sessionId: string;
        },
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<void>;
      ensureWarmContainer: () => Promise<void>;
      ensureBackendWarmup: () => Promise<void>;
      pullImage: () => Promise<boolean>;
      stopWarmContainer: (reason: string, quiet?: boolean) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    };

    let warmContainerAttempts = 0;
    let pullCalls = 0;
    let stopCalls = 0;
    const logs: string[] = [];

    executor.ensureWarmContainer = async () => {
      warmContainerAttempts += 1;
      if (warmContainerAttempts === 1) {
        throw new Error(
          "Failed to start warm container (exit 125): Unable to find image 'pushpals-worker-sandbox:latest' locally docker: Error response from daemon: pull access denied for pushpals-worker-sandbox, repository does not exist or may require 'docker login': denied",
        );
      }
    };
    executor.ensureBackendWarmup = async () => {};
    executor.pullImage = async () => {
      pullCalls += 1;
      return true;
    };
    executor.stopWarmContainer = async () => {
      stopCalls += 1;
    };
    executor.sleep = async () => {};

    await executor.ensureWarmRuntimeReady(
      {
        id: "job-missing-image",
        taskId: "task-missing-image",
        kind: "task.execute",
        params: {},
        sessionId: "dev",
      },
      (stream, line) => logs.push(`${stream}:${line}`),
    );

    expect(warmContainerAttempts).toBe(2);
    expect(pullCalls).toBe(1);
    expect(stopCalls).toBe(1);
    expect(logs.join("\n")).toContain("is missing locally");
    expect(logs.join("\n")).toContain("retrying warm container startup");
  });

  test("isolates Linux Codex state and binds only the host auth file read-only", () => {
    const original = process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME;
    const root = mkdtempSync(join(tmpdir(), "pushpals-codex-auth-"));
    writeFileSync(join(root, "auth.json"), '{"tokens":{}}\n', "utf8");
    process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME = root;
    try {
      const executor = createExecutor() as unknown as {
        openaiCodexAuthMount: (backend: string) => {
          args: string[];
          containerHome: string;
          hostAuthMounted: boolean;
        };
        codexVolumeName: string;
      };
      const mount = executor.openaiCodexAuthMount("openai_codex");
      const args = mount.args;
      expect(args).toContain("-e");
      expect(args).toContain("CODEX_HOME=/workspace/.pushpals/codex-home");
      expect(args).toContain(
        `type=volume,source=${executor.codexVolumeName},target=/workspace/.pushpals/codex-home`,
      );
      expect(
        args.some((arg) => arg.includes("dst=/run/pushpals/host-codex-auth.json,readonly")),
      ).toBe(true);
      expect(args.join("\n")).not.toContain(`target=/root/.codex`);
      expect(args.join("\n")).not.toContain(`src=${root},`);
      expect(mount.hostAuthMounted).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME;
      } else {
        process.env.PUSHPALS_OPENAI_CODEX_HOST_CODEX_HOME = original;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses separate Linux Codex volumes for different workers", () => {
    const first = createExecutor() as unknown as { codexVolumeName: string };
    const second = new DockerExecutor({
      repo: process.cwd(),
      workerId: "workerpal-other",
      imageName: "pushpals-worker-sandbox:latest",
    }) as unknown as { codexVolumeName: string };
    expect(first.codexVolumeName).not.toBe(second.codexVolumeName);
  });

  test("does not mount Codex state for non-Codex backends", () => {
    const executor = createExecutor() as unknown as {
      openaiCodexAuthMount: (backend: string) => { args: string[]; hostAuthMounted: boolean };
    };
    expect(executor.openaiCodexAuthMount("miniswe")).toEqual({
      args: [],
      containerHome: "/workspace/.pushpals/codex-home",
      hostAuthMounted: false,
    });
  });

  test("rejects unsafe container Codex home paths", () => {
    expect(resolveOpenAiCodexContainerHome("relative/.codex")).toBe(
      "/workspace/.pushpals/codex-home",
    );
    expect(resolveOpenAiCodexContainerHome("/repo/.codex")).toBe("/workspace/.pushpals/codex-home");
    expect(resolveOpenAiCodexContainerHome("/etc")).toBe("/workspace/.pushpals/codex-home");
    expect(resolveOpenAiCodexContainerHome("/home/bun/.codex")).toBe("/home/bun/.codex");
    expect(resolveOpenAiCodexContainerHome("/root/.codex/")).toBe("/root/.codex");
  });

  test("preserves refreshed auth but clears runtime-specific Codex state on version changes", () => {
    const startup = buildOpenAiCodexHomeStartupCommand({
      containerHome: "/workspace/.pushpals/codex-home",
      runtimeTag: "v1.2.31",
      hostAuthMounted: true,
    });
    expect(startup).toContain(".pushpals-runtime-tag");
    expect(startup).toContain("previous_runtime_tag");
    expect(startup).toContain("! -name auth.json");
    expect(startup).toContain("! -name .pushpals-host-auth.sha256");
    expect(startup).toContain('host_auth_hash="$(sha256sum');
    expect(startup).toContain('[ ! -s "$codex_home/auth.json" ] ||');
    expect(startup).toContain('"$host_auth_hash" != "$previous_host_auth_hash"');
    expect(startup).not.toContain("/root/.codex/tmp");
  });

  test("validateWorktreeGitInterop validates warm-container accessibility too", async () => {
    const executor = createExecutor() as unknown as {
      validateWorktreeGitInterop: () => Promise<void>;
      createWorktree: (worktreePath: string, baseRef: string) => Promise<void>;
      runGitSelfCheckContainer: (worktreePath: string) => Promise<void>;
      ensureWorktreeAccessibleInWarmContainer: (worktreePath: string) => Promise<string>;
      runWarmShell: (
        command: string,
        options: { timeoutMs: number },
      ) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
      ensureBackendWarmup: (backend: string) => Promise<void>;
      removeWorktree: (worktreePath: string) => Promise<void>;
      options: { baseRef: string };
    };

    const calls: string[] = [];
    executor.createWorktree = async () => {
      calls.push("create");
    };
    executor.runGitSelfCheckContainer = async () => {
      calls.push("fresh");
    };
    executor.ensureWorktreeAccessibleInWarmContainer = async () => {
      calls.push("warm");
      return "/repo/.worktrees/selfcheck-startup";
    };
    executor.runWarmShell = async (command, options) => {
      calls.push("canary");
      expect(command).toContain("command -v codex");
      expect(command).toContain("command -v bunx");
      expect(command).toContain("dependency_probe");
      expect(options.timeoutMs).toBe(15_000);
      return {
        ok: true,
        stdout:
          "runtime_tools=git,bun,node,python codex_runtime=codex docker_socket=trusted-host-only dependency_store=write-delete-ok",
        stderr: "",
        exitCode: 0,
      };
    };
    executor.ensureBackendWarmup = async (backend) => {
      calls.push("backend-warmup");
      expect(backend).toBe("openai_codex");
    };
    executor.removeWorktree = async () => {
      calls.push("cleanup");
    };

    await executor.validateWorktreeGitInterop();

    expect(calls).toEqual(["create", "fresh", "warm", "canary", "backend-warmup", "cleanup"]);
  });

  test("prepares Linux-native dependency artifacts at constant depth for browser hydration", async () => {
    const executor = createExecutor() as unknown as {
      ensureWorktreeDependencyArtifacts: (
        containerWorktreePath: string,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<void>;
      runWarmShell: (
        command: string,
        options?: {
          timeoutMs?: number;
          onLog?: (stream: "stdout" | "stderr", line: string) => void;
        },
      ) => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    };

    let capturedCommand = "";
    let capturedTimeoutMs = 0;
    const logs: string[] = [];
    executor.runWarmShell = async (command, options) => {
      capturedCommand = command;
      capturedTimeoutMs = options?.timeoutMs ?? 0;
      options?.onLog?.("stderr", "[DependencyPreparation] phase=projection progress=80");
      return {
        ok: true,
        stdout: " node_modules-container-native",
        stderr: "",
        exitCode: 0,
      };
    };

    await executor.ensureWorktreeDependencyArtifacts(
      "/repo/.worktrees/job-browser-smoke",
      (stream, line) => logs.push(`${stream}:${line}`),
    );

    expect(capturedTimeoutMs).toBeGreaterThan(0);
    expect(capturedCommand).toContain('src="/repo/$name"');
    expect(capturedCommand).toContain("node_modules");
    expect(capturedCommand).not.toContain("cp -as");
    expect(capturedCommand).toContain(
      'dependency_cache_root="$store_root/snapshots/linux-$(uname -m)"',
    );
    expect(capturedCommand).toContain("/workspace/.pushpals/dependency-store");
    expect(capturedCommand).not.toContain("git rev-parse --git-common-dir");
    expect(capturedCommand).toContain("bun install --frozen-lockfile --ignore-scripts >&2");
    expect(capturedCommand).toContain('snapshot_lock="$snapshot_root.lock"');
    expect(capturedCommand).toContain("flock -w 300 9");
    expect(capturedCommand).toContain(
      'find "$snapshot_root/node_modules" -type f -newer "$snapshot_ready" -print -quit',
    );
    expect(capturedCommand).toContain('rm -f "$snapshot_ready"');
    expect(capturedCommand).toContain(
      'ln -s "$snapshot_root/node_modules" "$worktree/node_modules"',
    );
    expect(capturedCommand).toContain("projection=container-volume-v1");
    expect(capturedCommand).toContain("node_modules-container-native");
    expect(capturedCommand).toContain('for entry in "$src"/* "$src"/.[!.]* "$src"/..?*');
    expect(capturedCommand).toContain('cp -al "$src/." "$projection_node_modules/"');
    expect(capturedCommand).not.toContain('cp -al "$entry" "$dest/$entry_name"');
    expect(capturedCommand).toContain(
      'find "$snapshot_root/node_modules" -type f -exec chmod a-w {} +',
    );
    expect(capturedCommand).toContain(
      ".cache|.expo|.vite|.vite-temp|.pushpals-dependency-snapshot",
    );
    expect(capturedCommand).toContain("for mutable in .cache .expo .vite .vite-temp");
    expect(capturedCommand).toContain(".pushpals-dependency-projection-in-progress");
    expect(capturedCommand).toContain('ln -s "$projection_node_modules" "$worktree/node_modules"');
    expect(capturedCommand).toContain(".pushpals-dependency-snapshot");
    expect(capturedCommand).toContain(".pushpals-validation-safe-dependency-snapshot");
    expect(capturedCommand).toContain("/repo/.worktrees/job-browser-smoke");
    expect(logs.join("\n")).toContain("[DependencyPreparation] phase=starting progress=0");
    expect(logs.join("\n")).toContain("[DependencyPreparation] phase=complete progress=100");
  });

  test("keys shared Linux snapshots stably and restores isolated workspace dependency links", () => {
    const command = buildWorktreeDependencyPreparationCommand("/repo/.worktrees/job-native-deps");

    expect(command).toContain(
      "printf 'projection=container-volume-v1\\nbun=%s\\n' \"$(bun --version)\"",
    );
    expect(command).toContain(
      'for manifest in "$worktree/package.json" "$worktree/bun.lock" "$worktree/bun.lockb"',
    );
    expect(command).toContain('sha256sum "$manifest" | cut -d " " -f 1');
    expect(command).not.toContain('snapshot_key="$snapshot_key-$worktree_id"');
    expect(command).not.toContain('mkdir "$snapshot_lock"');
    expect(command).toContain('exec 9>"$snapshot_lock"');
    expect(command).toContain("flock -w 300 9");
    expect(command).toContain('workspace_placeholder="/__pushpals_worktree__"');
    expect(command).toContain('ln -s "$workspace_placeholder');
    expect(command).toContain('ln -s "$worktree${workspace_relative:+/$workspace_relative}"');
    expect(command).toContain('printf \'%s\\n\' "$snapshot_key" > "$snapshot_ready"');
    const projectionCopyIndex = command.indexOf('cp -al "$src/." "$projection_node_modules/"');
    const workspaceRebindIndex = command.indexOf(
      'ln -s "$worktree${workspace_relative:+/$workspace_relative}"',
    );
    const unlockIndex = command.indexOf("flock -u 9");
    expect(projectionCopyIndex).toBeGreaterThan(0);
    expect(workspaceRebindIndex).toBeGreaterThan(projectionCopyIndex);
    expect(unlockIndex).toBeGreaterThan(workspaceRebindIndex);
  });

  (process.platform === "linux" &&
    process.env.PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION === "1"
    ? test
    : test.skip)(
    "serializes concurrent snapshot materialization and ignores abandoned lock contents",
    async () => {
      const worktree = mkdtempSync(join(tmpdir(), "pushpals-container-deps-a-"));
      const secondWorktree = mkdtempSync(join(tmpdir(), "pushpals-container-deps-b-"));
      const thirdWorktree = mkdtempSync(join(tmpdir(), "pushpals-container-deps-c-"));
      const dependencyStore = mkdtempSync(join(tmpdir(), "pushpals-container-store-"));
      try {
        mkdirSync(join(worktree, "fixture-dep"));
        writeFileSync(
          join(worktree, "fixture-dep", "package.json"),
          '{"name":"fixture-dep","version":"1.0.0"}\n',
        );
        writeFileSync(
          join(worktree, "package.json"),
          '{"name":"projection-fixture","dependencies":{"fixture-dep":"file:./fixture-dep"}}\n',
        );
        const installTemp = join(worktree, ".tmp");
        mkdirSync(installTemp);
        const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
          cwd: worktree,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            TEMP: installTemp,
            TMP: installTemp,
            TMPDIR: installTemp,
          },
        });
        expect(await install.exited).toBe(0);
        rmSync(join(worktree, "node_modules"), { recursive: true, force: true });

        mkdirSync(join(secondWorktree, "fixture-dep"));
        copyFileSync(join(worktree, "package.json"), join(secondWorktree, "package.json"));
        copyFileSync(join(worktree, "bun.lock"), join(secondWorktree, "bun.lock"));
        copyFileSync(
          join(worktree, "fixture-dep", "package.json"),
          join(secondWorktree, "fixture-dep", "package.json"),
        );
        mkdirSync(join(thirdWorktree, "fixture-dep"));
        copyFileSync(join(worktree, "package.json"), join(thirdWorktree, "package.json"));
        copyFileSync(join(worktree, "bun.lock"), join(thirdWorktree, "bun.lock"));
        copyFileSync(
          join(worktree, "fixture-dep", "package.json"),
          join(thirdWorktree, "fixture-dep", "package.json"),
        );

        const command = buildWorktreeDependencyPreparationCommand(worktree, dependencyStore);
        const secondCommand = buildWorktreeDependencyPreparationCommand(
          secondWorktree,
          dependencyStore,
        );
        const first = Bun.spawn(["sh", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const second = Bun.spawn(["sh", "-lc", secondCommand], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [firstExit, firstStdout, firstStderr, secondExit, secondStdout, secondStderr] =
          await Promise.all([
            first.exited,
            new Response(first.stdout).text(),
            new Response(first.stderr).text(),
            second.exited,
            new Response(second.stdout).text(),
            new Response(second.stderr).text(),
          ]);
        expect(firstExit).toBe(0);
        expect(secondExit).toBe(0);
        expect(firstStdout).toContain("node_modules-container-native");
        expect(secondStdout).toContain("node_modules-container-native");
        expect(`${firstStderr}\n${secondStderr}`).toContain("phase=snapshot_cache_miss");
        expect(`${firstStderr}\n${secondStderr}`).toContain("phase=snapshot_cache_hit");
        expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(secondWorktree, "node_modules")).isSymbolicLink()).toBe(true);
        expect(
          await Bun.file(join(worktree, "node_modules", ".pushpals-dependency-snapshot")).exists(),
        ).toBe(true);
        const abandonedLockFiles = Array.from(
          new Bun.Glob("snapshots/**/*.lock").scanSync({ cwd: dependencyStore }),
        );
        expect(abandonedLockFiles).toHaveLength(1);
        writeFileSync(join(dependencyStore, abandonedLockFiles[0]), "abandoned-owner\n", "utf8");

        const thirdCommand = buildWorktreeDependencyPreparationCommand(
          thirdWorktree,
          dependencyStore,
        );
        const third = Bun.spawn(["sh", "-lc", thirdCommand], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [thirdExit, thirdStderr] = await Promise.all([
          third.exited,
          new Response(third.stderr).text(),
        ]);
        expect(thirdExit).toBe(0);
        expect(thirdStderr).toContain("phase=snapshot_cache_hit");
        expect(lstatSync(join(thirdWorktree, "node_modules")).isSymbolicLink()).toBe(true);
        const fixtureLink = join(thirdWorktree, "node_modules", "fixture-dep");
        if (lstatSync(fixtureLink).isSymbolicLink()) {
          expect(readlinkSync(fixtureLink)).toContain(thirdWorktree);
        }
        expect(await Bun.file(join(fixtureLink, "package.json")).exists()).toBe(true);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
        rmSync(secondWorktree, { recursive: true, force: true });
        rmSync(thirdWorktree, { recursive: true, force: true });
        rmSync(dependencyStore, { recursive: true, force: true });
      }
    },
  );

  (process.platform === "linux" &&
    process.env.PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION === "1"
    ? test
    : test.skip)(
    "garbage-collects orphan projections and excess snapshots without deleting referenced or locked entries",
    async () => {
      const dependencyStore = mkdtempSync(join(tmpdir(), "pushpals-container-gc-store-"));
      const worktreeRoot = mkdtempSync(join(tmpdir(), "pushpals-container-gc-worktrees-"));
      const cacheRoot = join(dependencyStore, "snapshots", "linux-x64");
      const projectionsRoot = join(dependencyStore, "projections");
      const referencedKey = "a".repeat(64);
      const lockedKey = "b".repeat(64);
      const expiredKey = "c".repeat(64);
      const freshKeys = Array.from({ length: 10 }, (_, index) =>
        (index + 1).toString(16).padStart(64, "0"),
      );
      const lockReady = join(dependencyStore, "locked.ready");
      let lockHolder: ReturnType<typeof Bun.spawn> | null = null;
      try {
        mkdirSync(cacheRoot, { recursive: true });
        mkdirSync(projectionsRoot, { recursive: true });
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60_000);
        for (const key of [referencedKey, lockedKey, expiredKey]) {
          const snapshotRoot = join(cacheRoot, key);
          mkdirSync(join(snapshotRoot, "node_modules"), { recursive: true });
          writeFileSync(join(snapshotRoot, "node_modules", "fixture.txt"), key);
          utimesSync(snapshotRoot, oldDate, oldDate);
        }
        for (const [index, key] of freshKeys.entries()) {
          const snapshotRoot = join(cacheRoot, key);
          mkdirSync(join(snapshotRoot, "node_modules"), { recursive: true });
          writeFileSync(join(snapshotRoot, "node_modules", "fixture.txt"), key);
          const timestamp = new Date(Date.now() - index * 1_000);
          utimesSync(snapshotRoot, timestamp, timestamp);
        }

        const activeProjection = join(projectionsRoot, "job-active", "node_modules");
        mkdirSync(activeProjection, { recursive: true });
        writeFileSync(
          join(activeProjection, ".pushpals-dependency-snapshot"),
          `${referencedKey}\n`,
        );
        mkdirSync(join(worktreeRoot, "job-active"));
        mkdirSync(join(projectionsRoot, "job-orphan", "node_modules"), { recursive: true });
        mkdirSync(join(projectionsRoot, "external-unmanaged", "node_modules"), {
          recursive: true,
        });

        lockHolder = Bun.spawn(
          ["sh", "-lc", 'flock "$LOCK_PATH" sh -c \': > "$READY_PATH"; sleep 2\''],
          {
            stdout: "ignore",
            stderr: "pipe",
            env: {
              ...process.env,
              LOCK_PATH: `${join(cacheRoot, lockedKey)}.lock`,
              READY_PATH: lockReady,
            },
          },
        );
        for (let attempt = 0; attempt < 100 && !existsSync(lockReady); attempt++) {
          await Bun.sleep(10);
        }
        expect(existsSync(lockReady)).toBe(true);

        const reconcile = Bun.spawn(
          ["sh", "-lc", buildDependencyStoreReconciliationCommand(dependencyStore, worktreeRoot)],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [exitCode, stderr] = await Promise.all([
          reconcile.exited,
          new Response(reconcile.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);

        expect(existsSync(join(projectionsRoot, "job-active"))).toBe(true);
        expect(existsSync(join(projectionsRoot, "job-orphan"))).toBe(false);
        expect(existsSync(join(projectionsRoot, "external-unmanaged"))).toBe(true);
        expect(existsSync(join(cacheRoot, referencedKey))).toBe(true);
        expect(existsSync(join(cacheRoot, lockedKey))).toBe(true);
        expect(existsSync(join(cacheRoot, expiredKey))).toBe(false);
        const retainedFresh = freshKeys.filter((key) => existsSync(join(cacheRoot, key)));
        expect(retainedFresh).toHaveLength(8);
        expect(retainedFresh).toEqual(freshKeys.slice(0, 8));
      } finally {
        if (lockHolder) {
          await Promise.race([lockHolder.exited, Bun.sleep(3_000)]);
          try {
            lockHolder.kill("SIGKILL");
          } catch {
            // The bounded lock holder already exited.
          }
        }
        rmSync(dependencyStore, { recursive: true, force: true });
        rmSync(worktreeRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  (process.env.PUSHPALS_RUN_CONTAINER_VOLUME_INTEGRATION === "1" ? test : test.skip)(
    "reuses dependency and isolated Codex volumes inside a Linux container",
    async () => {
      const worktree = mkdtempSync(join(tmpdir(), "pushpals-docker-desktop-deps-"));
      const authRoot = mkdtempSync(join(tmpdir(), "pushpals-docker-desktop-auth-"));
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const dependencyVolume = `pushpals-test-deps-${suffix}`;
      const codexVolume = `pushpals-test-codex-${suffix}`;
      const image = process.env.PUSHPALS_WORKERPAL_IMAGE || "pushpals-worker-sandbox:latest";
      const docker = async (args: string[]) => {
        const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      };
      const dockerHostPath = (path: string) => path.replace(/\\/g, "/");

      try {
        mkdirSync(join(worktree, "fixture-dep"));
        writeFileSync(
          join(worktree, "fixture-dep", "package.json"),
          '{"name":"fixture-dep","version":"1.0.0"}\n',
        );
        writeFileSync(
          join(worktree, "package.json"),
          '{"name":"projection-fixture","dependencies":{"fixture-dep":"file:./fixture-dep"}}\n',
        );
        expect((await docker(["volume", "create", dependencyVolume])).exitCode).toBe(0);
        expect((await docker(["volume", "create", codexVolume])).exitCode).toBe(0);
        const bindMount = `type=bind,src=${dockerHostPath(worktree)},dst=/repo/worktree`;
        const createLockfile = await docker([
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          "--mount",
          bindMount,
          image,
          "-lc",
          "cd /repo/worktree && bun install --ignore-scripts && rm -rf node_modules",
        ]);
        expect(`${createLockfile.stdout}\n${createLockfile.stderr}`).not.toContain("error:");
        if (createLockfile.exitCode !== 0) {
          throw new Error(
            `Docker lockfile preparation failed with exit ${createLockfile.exitCode}:\n${createLockfile.stdout}\n${createLockfile.stderr}`,
          );
        }
        const dependencyCommand = buildWorktreeDependencyPreparationCommand("/repo/worktree");
        const dependencyRunArgs = [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          "--mount",
          bindMount,
          "--mount",
          `type=volume,source=${dependencyVolume},target=/workspace/.pushpals/dependency-store`,
          image,
          "-lc",
          dependencyCommand,
        ];
        const firstProjection = await docker(dependencyRunArgs);
        expect(`${firstProjection.stdout}\n${firstProjection.stderr}`).toContain(
          "node_modules-container-native",
        );
        expect(firstProjection.exitCode).toBe(0);

        const secondProjection = await docker(dependencyRunArgs);
        expect(secondProjection.exitCode).toBe(0);
        expect(secondProjection.stderr).toContain("phase=snapshot_cache_hit");
        expect(secondProjection.stderr).not.toContain("phase=install progress=20");

        const hostFinalizationCleanup = removeLinkedNodeModulesDependencyArtifact(worktree);
        expect(hostFinalizationCleanup).toEqual({ ok: true, removed: true });
        expect(existsSync(join(worktree, "node_modules"))).toBe(false);
        const retainedDependencySnapshot = await docker([
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          "--mount",
          `type=volume,source=${dependencyVolume},target=/workspace/.pushpals/dependency-store`,
          image,
          "-lc",
          "find /workspace/.pushpals/dependency-store -name .pushpals-dependency-ready -print -quit | grep -q .",
        ]);
        expect(retainedDependencySnapshot.exitCode).toBe(0);

        const hostAuthPath = join(authRoot, "auth.json");
        writeFileSync(hostAuthPath, '{"source":"host"}\n', "utf8");
        const codexHome = "/workspace/.pushpals/codex-home";
        const codexMountArgs = [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          "--mount",
          `type=volume,source=${codexVolume},target=${codexHome}`,
          "--mount",
          `type=bind,src=${dockerHostPath(hostAuthPath)},dst=/run/pushpals/host-codex-auth.json,readonly`,
          image,
          "-lc",
        ];
        const firstCodexStartup = buildOpenAiCodexHomeStartupCommand({
          containerHome: codexHome,
          runtimeTag: "integration-v1",
          hostAuthMounted: true,
        });
        const firstCodex = await docker([
          ...codexMountArgs,
          `${firstCodexStartup}; printf '%s\\n' '{"source":"container-refresh"}' > "$codex_home/auth.json"; touch "$codex_home/history.json"`,
        ]);
        expect(firstCodex.exitCode).toBe(0);

        const upgradedCodexStartup = buildOpenAiCodexHomeStartupCommand({
          containerHome: codexHome,
          runtimeTag: "integration-v2",
          hostAuthMounted: true,
        });
        const upgradedCodex = await docker([
          ...codexMountArgs,
          `${upgradedCodexStartup}; test ! -e "$codex_home/history.json"; grep -q container-refresh "$codex_home/auth.json"`,
        ]);
        expect(`${upgradedCodex.stdout}\n${upgradedCodex.stderr}`).toBe("\n");
        expect(upgradedCodex.exitCode).toBe(0);
      } finally {
        await docker(["volume", "rm", "-f", dependencyVolume]);
        await docker(["volume", "rm", "-f", codexVolume]);
        rmSync(worktree, { recursive: true, force: true });
        rmSync(authRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test("stops the job when Linux-native dependency preparation fails", async () => {
    const executor = createExecutor() as unknown as {
      ensureWorktreeDependencyArtifacts: (
        containerWorktreePath: string,
        onLog?: (stream: "stdout" | "stderr", line: string) => void,
      ) => Promise<void>;
      runWarmShell: () => Promise<{
        ok: boolean;
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    };

    const logs: string[] = [];
    executor.runWarmShell = async () => ({
      ok: false,
      stdout: "",
      stderr: "bun install failed",
      exitCode: 1,
    });

    await expect(
      executor.ensureWorktreeDependencyArtifacts(
        "/repo/.worktrees/job-native-deps-failed",
        (stream, line) => logs.push(`${stream}:${line}`),
      ),
    ).rejects.toThrow("Linux-native worktree dependency preparation failed: bun install failed");
    expect(logs.join("\n")).toContain(
      "stderr:[DockerExecutor] Linux-native worktree dependency preparation failed",
    );
  });

  test("parseGitWorktreeListPorcelain extracts detached and prunable flags", () => {
    const parsed = parseGitWorktreeListPorcelain(
      [
        "worktree /repo",
        "HEAD 0123456789abcdef",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/job-123",
        "HEAD fedcba9876543210",
        "detached",
        "prunable gitdir file points to non-existent location",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      { path: "/repo", detached: false, prunable: false },
      { path: "/repo/.worktrees/job-123", detached: true, prunable: true },
    ]);
  });

  test("collectPrunableEphemeralWorktrees limits cleanup to stale managed entries", () => {
    const output = [
      "worktree /repo",
      "HEAD 1111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/job-active",
      "HEAD 2222222222222222",
      "detached",
      "",
      "worktree /repo/.worktrees/job-stale",
      "HEAD 3333333333333333",
      "detached",
      "prunable missing",
      "",
      "worktree /repo/.worktrees/selfcheck-stale",
      "HEAD 4444444444444444",
      "detached",
      "prunable missing",
      "",
      "worktree /repo/.worktrees/feature-scratch",
      "HEAD 5555555555555555",
      "detached",
      "prunable missing",
    ].join("\n");

    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/job-123")).toBe(true);
    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/selfcheck-abc")).toBe(true);
    expect(isEphemeralWorkerWorktreePath("/repo/.worktrees/feature-scratch")).toBe(false);

    expect(collectPrunableEphemeralWorktrees(output)).toEqual([
      "/repo/.worktrees/job-stale",
      "/repo/.worktrees/selfcheck-stale",
    ]);
  });

  test("execute decrements activeJobs when base ref resolution fails", async () => {
    const executor = createExecutor() as unknown as {
      execute: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<unknown>;
      activeJobs: number;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      removeWorktree: () => Promise<void>;
    };

    executor.resolveWorktreeBaseRefForJob = async () => {
      throw new Error("boom");
    };
    executor.removeWorktree = async () => {};

    await expect(
      executor.execute({
        id: "job-1",
        taskId: "task-1",
        kind: "task.execute",
        params: {},
        sessionId: "dev",
      }),
    ).rejects.toThrow("boom");
    expect(executor.activeJobs).toBe(0);
  });

  test("keeps merge-conflict image preparation explicit and never rebuilds inside execute", async () => {
    const executor = createExecutor() as unknown as {
      execute: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<{ ok: boolean; summary: string }>;
      shouldPrepareMergeConflictJobBeforeExecution: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => boolean;
      prepareMergeConflictJobEnvironment: (job: {
        id: string;
        taskId: string;
        kind: string;
        params: Record<string, unknown>;
        sessionId: string;
      }) => Promise<void>;
      rebuildImageForMergeConflictJob: () => Promise<void>;
      resolveWorktreeBaseRefForJob: () => Promise<string>;
      createWorktree: () => Promise<void>;
      logExecutionConfig: () => void;
      runInWarmContainer: () => Promise<{ ok: boolean; summary: string }>;
      removeWorktree: () => Promise<void>;
      scheduleIdleShutdown: () => void;
    };

    let rebuildCalls = 0;
    executor.rebuildImageForMergeConflictJob = async () => {
      rebuildCalls += 1;
    };
    executor.resolveWorktreeBaseRefForJob = async () => "HEAD";
    executor.createWorktree = async () => {};
    executor.logExecutionConfig = () => {};
    executor.runInWarmContainer = async () => ({ ok: true, summary: "ok" });
    executor.removeWorktree = async () => {};
    executor.scheduleIdleShutdown = () => {};

    const mergeConflictJob = {
      id: "job-merge",
      taskId: "task-merge",
      kind: "task.execute",
      params: {
        reviewAgent: {
          resolutionType: "merge_conflict",
        },
      },
      sessionId: "dev",
    };
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(true);
    await executor.prepareMergeConflictJobEnvironment(mergeConflictJob);
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(false);
    expect(rebuildCalls).toBe(1);

    const regularResult = await executor.execute({
      id: "job-regular",
      taskId: "task-regular",
      kind: "task.execute",
      params: {},
      sessionId: "dev",
    });
    expect(regularResult.ok).toBe(true);
    expect(rebuildCalls).toBe(1);

    const mergeConflictExecuteResult = await executor.execute(mergeConflictJob);
    // The intentionally incomplete review lease cannot pass the new host-side
    // PR preparation boundary, but execute must not trigger an image rebuild.
    expect(mergeConflictExecuteResult.ok).toBe(false);
    expect(rebuildCalls).toBe(1);
    expect(executor.shouldPrepareMergeConflictJobBeforeExecution(mergeConflictJob)).toBe(true);
  });
});
