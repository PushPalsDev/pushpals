import { describe, expect, test } from "bun:test";
import {
  buildWindowsDockerExecTreeTerminationArgv,
  buildOpenAiCodexHomeStartupCommand,
  buildWorktreeDependencyPreparationCommand,
  collectPrunableEphemeralWorktrees,
  DockerExecutor,
  isEphemeralWorkerWorktreePath,
  parseGitWorktreeListPorcelain,
  prependWorkerpalRuntimeCaStartup,
  resolveOpenAiCodexContainerHome,
  resolveDockerJobTimeoutMs,
  resolveWorkerpalDockerBuildCaSecretArgs,
  resolveWorkerpalDockerRuntimeCaArgs,
} from "../apps/workerpals/src/docker_executor";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
  test("builds forced Windows process-tree termination for Docker exec clients", () => {
    expect(buildWindowsDockerExecTreeTerminationArgv(9876)).toEqual([
      "taskkill",
      "/PID",
      "9876",
      "/T",
      "/F",
    ]);
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
    executor.removeWorktree = async () => {
      calls.push("cleanup");
    };

    await executor.validateWorktreeGitInterop();

    expect(calls).toEqual(["create", "fresh", "warm", "cleanup"]);
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

  test("keys shared Linux snapshots by lockfiles and isolates workspace dependency links", () => {
    const command = buildWorktreeDependencyPreparationCommand("/repo/.worktrees/job-native-deps");

    expect(command).toContain(
      "printf 'projection=container-volume-v1\\nbun=%s\\n' \"$(bun --version)\"",
    );
    expect(command).toContain(
      'for manifest in "$worktree/package.json" "$worktree/bun.lock" "$worktree/bun.lockb"',
    );
    expect(command).toContain('sha256sum "$manifest" | cut -d " " -f 1');
    expect(command).toContain("jq -e '.workspaces != null'");
    expect(command).toContain('snapshot_key="$snapshot_key-$worktree_id"');
    expect(command).toContain('while [ ! -f "$snapshot_ready" ]; do');
    expect(command).toContain('if [ "$wait_count" -ge 300 ]; then');
    expect(command).toContain('printf \'%s\\n\' "$snapshot_key" > "$snapshot_ready"');
  });

  (process.platform === "linux" &&
    process.env.PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION === "1"
    ? test
    : test.skip)(
    "projects dependencies through a container-native store without copying into the bind path",
    async () => {
      const worktree = mkdtempSync(join(tmpdir(), "pushpals-container-deps-"));
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

        const command = buildWorktreeDependencyPreparationCommand(worktree);
        const first = Bun.spawn(["sh", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [firstExit, firstStdout] = await Promise.all([
          first.exited,
          new Response(first.stdout).text(),
        ]);
        expect(firstExit).toBe(0);
        expect(firstStdout).toContain("node_modules-container-native");
        expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
        expect(
          await Bun.file(join(worktree, "node_modules", ".pushpals-dependency-snapshot")).exists(),
        ).toBe(true);

        const second = Bun.spawn(["sh", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [secondExit, secondStderr] = await Promise.all([
          second.exited,
          new Response(second.stderr).text(),
        ]);
        expect(secondExit).toBe(0);
        expect(secondStderr).toContain("phase=snapshot_cache_hit");
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    },
  );

  (process.env.PUSHPALS_RUN_WINDOWS_LINUX_CONTAINER_INTEGRATION === "1" ? test : test.skip)(
    "reuses dependency and isolated Codex volumes through a Windows-host Linux container",
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
        expect(createLockfile.exitCode).toBe(0);
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
