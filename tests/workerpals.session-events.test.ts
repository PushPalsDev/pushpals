import { describe, expect, test } from "bun:test";
import {
  buildUnhandledWorkerFailureResult,
  buildTrustedValidationCompletionPayload,
  didWorkerWatchdogFire,
  enqueueCompletion,
  failCompletionEnqueue,
  failNoPublishableCodeChange,
  holdCommitForTrustedValidation,
  inferWorkerTerminalFailureClass,
  mergeWorkerDiagnostics,
  shouldDeferDockerCodexStartupStallForDirectRetry,
  shouldEmitDirectSessionJobEvent,
  shouldRecycleWorkerForCodexUnavailableFailure,
  shouldRecycleWorkerForHeartbeatDegradation,
  requiresPublishableCodeChange,
  resolveWorkerRuntimeGeneration,
  workerJobResultFromDocker,
  workerRecycleExitCodeForResult,
} from "../apps/workerpals/src/workerpals_main";

describe("workerpals session event emission", () => {
  test("uses the packaged runtime tag as the WorkerPal generation", () => {
    expect(
      resolveWorkerRuntimeGeneration({
        PUSHPALS_RUNTIME_TAG: "v1.2.39",
        PUSHPALS_CLI_PACKAGE_VERSION: "1.2.38",
      }),
    ).toBe("v1.2.39");
    expect(resolveWorkerRuntimeGeneration({})).toBe("");
  });

  test("classifies an unhandled WorkerPal stack at its owning runtime boundary", () => {
    const error = new ReferenceError("Cannot access 'timedOut' before initialization");
    error.stack =
      `ReferenceError: Cannot access 'timedOut' before initialization\n` +
      `    at execute (/workspace/apps/workerpals/src/workerpals_main.ts:2074:18)`;
    const result = buildUnhandledWorkerFailureResult(error, "openai_codex");

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("workerpals_main.ts");
    expect(result.diagnostics?.terminal).toMatchObject({
      failureClass: "worker_runtime_failure",
      terminalStage: "worker_runtime",
      executorBackend: "openai_codex",
      metadata: {
        classificationOwner: "workerpals_main",
        structuredResult: false,
      },
    });
  });

  test("preserves structurally owned terminal stages through final diagnostic enrichment", () => {
    for (const terminalStage of ["worker_runtime", "docker"]) {
      const merged = mergeWorkerDiagnostics(
        {
          terminal: {
            failureClass: "worker_runtime_failure",
            terminalStage,
            metadata: { structuredResult: false },
          },
        },
        {
          terminal: {
            failureClass: "worker_runtime_failure",
            terminalStage: "worker",
            metadata: { phase: "executing" },
          },
        },
      );

      expect(merged.terminal?.terminalStage).toBe(terminalStage);
      expect(merged.terminal?.metadata).toMatchObject({
        structuredResult: false,
        phase: "executing",
      });
    }
  });

  test("preserves host-executor terminal identity through final diagnostic enrichment", () => {
    for (const classificationOwner of ["generic_python_executor", "openhands_task_execute"]) {
      const merged = mergeWorkerDiagnostics(
        {
          terminal: {
            failureClass: "nonzero_exit",
            terminalStage: "executor",
            executorBackend: "test-backend",
            summary: "host process state rejected wrapper success",
            watchdogFired: false,
            timeoutMs: 10_000,
            metadata: {
              classificationOwner,
              processStateOverrodeStructuredResult: true,
            },
          },
        },
        {
          terminal: {
            failureClass: "worker_failure",
            terminalStage: "worker",
            executorBackend: "enrichment-backend",
            summary: "generic finalization summary",
            watchdogFired: true,
            timeoutMs: 99_000,
            metadata: {
              classificationOwner: "untrusted_enrichment",
              phase: "executing",
            },
          },
        },
      );

      expect(merged.terminal).toMatchObject({
        failureClass: "nonzero_exit",
        terminalStage: "executor",
        executorBackend: "test-backend",
        summary: "host process state rejected wrapper success",
        watchdogFired: false,
        timeoutMs: 10_000,
        metadata: {
          classificationOwner,
          processStateOverrodeStructuredResult: true,
          phase: "executing",
        },
      });
      expect(
        inferWorkerTerminalFailureClass({
          ok: false,
          summary: "generic finalization summary",
          exitCode: 3,
          diagnostics: merged,
        }),
      ).toBe("nonzero_exit");
    }
  });

  test("requires a publishable result only for explicit writable code-change jobs", () => {
    expect(
      requiresPublishableCodeChange({
        planning: { intent: "code_change", scope: { writeAllowed: true } },
      }),
    ).toBe(true);
    expect(
      requiresPublishableCodeChange({
        planning: { intent: "code_change", scope: { writeAllowed: false } },
      }),
    ).toBe(false);
    expect(
      requiresPublishableCodeChange({
        planning: { intent: "investigation", scope: { writeAllowed: true } },
      }),
    ).toBe(false);
    expect(
      requiresPublishableCodeChange({
        planning: { intent: "code_change", scope: { writeAllowed: true } },
        reviewAgent: { resolutionType: "merge_conflict" },
      }),
    ).toBe(false);
  });

  test("turns an unchanged writable coding attempt into a truthful failure", () => {
    const failed = failNoPublishableCodeChange("job-noop", {
      ok: true,
      summary: "task finished",
      exitCode: 0,
    });

    expect(failed.ok).toBe(false);
    expect(failed.exitCode).toBe(4);
    expect(failed.summary).toContain("no publishable changes");
    expect(failed.stderr).toContain("Refusing to report an unchanged coding attempt");
    expect(inferWorkerTerminalFailureClass(failed)).toBe("artifact_only_no_publishable_patch");
  });

  test("importing workerpals_main has no daemon startup side effects", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        "await import('./apps/workerpals/src/workerpals_main.ts'); console.log('workerpals-import-ok');",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 3_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    expect(timedOut).toBe(false);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("workerpals-import-ok");
    expect(`${stdout}\n${stderr}`).not.toContain("PushPals WorkerPals Daemon");
  });

  test("preserves Docker structured diagnostics and usage through the host boundary", () => {
    const result = workerJobResultFromDocker({
      ok: false,
      summary: "Required validation could not access the Docker daemon",
      exitCode: 1,
      cooldownMs: 60_000,
      usage: {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
      },
      diagnostics: {
        validationRuns: [
          {
            command: "bun run validate",
            exitCode: 1,
            passed: false,
            failureClass: "environment",
          },
        ],
        patchSnapshots: [
          {
            phase: "quality_gate",
            publishableFileCount: 2,
            changedPathSample: ["scripts/test-supabase.js"],
          },
        ],
      },
    });

    expect(result.cooldownMs).toBe(60_000);
    expect(result.usage?.totalTokens).toBe(125);
    expect(result.diagnostics?.validationRuns).toHaveLength(1);
    expect(result.diagnostics?.patchSnapshots).toHaveLength(1);
  });

  test("hands an environment-blocked candidate ref to the trusted validation queue", () => {
    const held = holdCommitForTrustedValidation(
      {
        ok: true,
        summary: "candidate ready",
        validationBlocked: {
          category: "environment",
          summary: "Candidate patch requires trusted-environment validation before publication",
          detail: "Docker socket access is not permitted in the sandbox.",
          commands: ["bun run validate"],
        },
      },
      {
        branch: "refs/pushpals/agent/worker/job",
        publicBranch: "agent/worker/job",
        sha: "abc123",
      },
    );

    expect(held.completionCommit).toEqual({
      branch: "refs/pushpals/agent/worker/job",
      publicBranch: "agent/worker/job",
      sha: "abc123",
    });
    expect(held.result.ok).toBe(true);
    expect(held.result.publishBlocked).toBeUndefined();
    expect(held.result.summary).toContain("queued for host-side validation");
    expect(inferWorkerTerminalFailureClass(held.result)).toBe("trusted_validation_required");
  });

  test("retains the candidate and reports publish-blocked when trusted handoff fails", () => {
    const failed = failCompletionEnqueue(
      {
        ok: true,
        summary: "queued",
        validationBlocked: {
          category: "environment",
          summary: "Trusted validation required",
          detail: "Docker is unavailable in the worker sandbox.",
          commands: ["bun run validate"],
        },
      },
      {
        branch: "refs/pushpals/agent/worker/job",
        publicBranch: "agent/worker/job",
        sha: "abc123",
      },
    );

    expect(failed.ok).toBe(false);
    expect(failed.publishBlocked?.stage).toBe("validation");
    expect(failed.publishBlocked?.localRef).toBe("refs/pushpals/agent/worker/job");
    expect(failed.stderr).toContain("candidate remains available");
    expect(inferWorkerTerminalFailureClass(failed)).toBe("environment");
  });

  test("carries exact blocked commands into the completion handoff", () => {
    expect(
      buildTrustedValidationCompletionPayload({
        category: "environment",
        summary: "Trusted validation required",
        detail: "Docker is unavailable.",
        commands: ["bun run validate:publish"],
      }),
    ).toEqual({
      trustedValidationCommands: ["bun run validate:publish"],
      trustedValidationSummary: "Trusted validation required",
      trustedValidationDetail: "Docker is unavailable.",
    });
    expect(buildTrustedValidationCompletionPayload(undefined)).toEqual({});
  });

  test("retries an identical completion handoff after the first response is lost", async () => {
    const originalFetch = globalThis.fetch;
    const bodies: string[] = [];
    let attempts = 0;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      attempts += 1;
      bodies.push(String(init?.body ?? ""));
      if (attempts === 1) throw new Error("response lost after commit");
      return Response.json(
        { ok: true, completionId: "completion-existing", deduped: true },
        {
          status: 201,
        },
      );
    }) as typeof fetch;
    try {
      const enqueued = await enqueueCompletion(
        "http://pushpals.test",
        { "Content-Type": "application/json" },
        "worker-1",
        "main_agents",
        {
          id: "job-response-lost",
          taskId: "task-response-lost",
          kind: "task.execute",
          sessionId: "dev",
          params: {},
        },
        {
          branch: "refs/pushpals/agent/worker/job-response-lost",
          sha: "a".repeat(40),
        },
        { ok: true, summary: "candidate ready" },
      );
      expect(enqueued).toBe(true);
      expect(attempts).toBe(2);
      expect(bodies[1]).toBe(bodies[0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("never reports an environment-deferred no-change job as successful", () => {
    const held = holdCommitForTrustedValidation(
      {
        ok: true,
        summary: "candidate ready",
        validationBlocked: {
          category: "environment",
          summary: "Trusted validation required",
          detail: "Docker is unavailable.",
          commands: ["bun run validate"],
        },
      },
      null,
    );

    expect(held.completionCommit).toBeNull();
    expect(held.result.ok).toBe(false);
    expect(held.result.publishBlocked).toBeUndefined();
    expect(held.result.validationBlocked).toBeDefined();
    expect(held.result.exitCode).toBe(4);
    expect(held.result.summary).toContain("no candidate was available to validate");
    expect(inferWorkerTerminalFailureClass(held.result)).toBe("trusted_validation_required");
  });

  test("does not mask an earlier host-side finalization failure with trusted validation", () => {
    const held = holdCommitForTrustedValidation(
      {
        ok: false,
        summary: "Host-side merge-conflict rebase continuation failed",
        stderr: "Failed to continue prepared merge-conflict rebase",
        exitCode: 4,
        validationBlocked: {
          category: "environment",
          summary: "Trusted validation required",
          detail: "Docker is unavailable.",
          commands: ["bun run validate"],
        },
      },
      null,
    );

    expect(held.completionCommit).toBeNull();
    expect(held.result.ok).toBe(false);
    expect(held.result.summary).toBe("Host-side merge-conflict rebase continuation failed");
    expect(held.result.stderr).toContain("Failed to continue prepared merge-conflict rebase");
  });

  test("keeps direct completion events even when server status persistence succeeds", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: true,
        statusPersistedToServer: true,
      }),
    ).toBe(true);
  });

  test("does not emit job_completed while a candidate is still finalizing", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: true,
        statusPersistedToServer: true,
        finalizing: true,
      }),
    ).toBe(false);
  });

  test("suppresses duplicate direct failure events when server fail hook accepted the status", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: false,
        statusPersistedToServer: true,
      }),
    ).toBe(false);
  });

  test("falls back to a direct failure event when server fail persistence did not succeed", () => {
    expect(
      shouldEmitDirectSessionJobEvent({
        ok: false,
        statusPersistedToServer: false,
      }),
    ).toBe(true);
  });

  test("does not recycle heartbeat transport once job execution has moved into finalization", () => {
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: false,
        allowHeartbeatRecycle: false,
        transportStale: true,
      }),
    ).toBe(false);
  });

  test("recycles heartbeat transport only while execution is still running and transport is stale", () => {
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: false,
        allowHeartbeatRecycle: true,
        transportStale: true,
      }),
    ).toBe(true);
    expect(
      shouldRecycleWorkerForHeartbeatDegradation({
        heartbeatDelivered: true,
        allowHeartbeatRecycle: true,
        transportStale: true,
      }),
    ).toBe(false);
  });

  test("classifies codex startup stalls distinctly from no-publishable patch failures", () => {
    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "openai_codex stalled before first response",
        stderr: "Codex event trace:\n- thread.started\n- turn.started",
        exitCode: 124,
      }),
    ).toBe("codex_startup_stall");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "openai_codex made no publishable changes before the no-edit watchdog",
        stderr: "Codex produced reasoning but no patch",
        exitCode: 124,
      }),
    ).toBe("artifact_only_no_publishable_patch");
  });

  test("classifies quality gate validation failures before incidental no-publishable text", () => {
    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary:
          "Quality gate needs revision 1/3: ValidationGate: Required vision.md validation failed: bun test exited 1",
        stderr: "previous context mentioned artifact_only_no_publishable_patch",
        stdout: "no publishable progress terminology appeared in an earlier worker hint",
        exitCode: 1,
      }),
    ).toBe("validation");
  });

  test("classifies internal WorkerPal JavaScript crashes before incidental runtime context", () => {
    const runtimeContext =
      "[DockerExecutor] running with timeout=1320000ms codex_child_timeout=1200000ms\nDependency projection: /workspace/node_modules";

    for (const error of [
      "ReferenceError: Cannot access 'timedOut' before initialization",
      "TypeError: undefined is not an object",
      "SyntaxError: Unexpected token '}'",
      "RangeError: Maximum call stack size exceeded",
    ]) {
      const result = {
        ok: false,
        summary: "Job failed (exit 1, elapsed 20173ms)",
        stderr: `${error}\n    at /workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13\nBun v1.3.14 (Linux x64 baseline)`,
        stdout: runtimeContext,
        exitCode: 1,
      };

      expect(inferWorkerTerminalFailureClass(result)).toBe("worker_runtime_failure");
      expect(didWorkerWatchdogFire(result)).toBe(false);
    }

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Job failed (exit 1, elapsed 20173ms)",
        stderr: "child exited before returning its result",
        stdout: "Dependency projection: /workspace/node_modules",
        exitCode: 1,
        diagnostics: {
          terminal: {
            failureClass: "worker_runtime_failure",
            terminalStage: "docker",
            metadata: {
              structuredResult: false,
              timedOutByDocker: false,
            },
          },
        },
      }),
    ).toBe("worker_runtime_failure");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Job failed",
        stderr: [
          "ReferenceError: route state is unavailable",
          "    at src/routeShell.ts:42:7",
          "    at /workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13",
        ].join("\n"),
        exitCode: 1,
      }),
    ).toBe("worker_failure");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Job failed",
        stderr: "TypeError: user fixture broke\n    at src/generic_python_executor.ts:42:7",
        exitCode: 1,
      }),
    ).toBe("worker_failure");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "WorkerPal encountered an unexpected runtime failure",
        stderr: "TypeError: internal state unavailable",
        exitCode: 1,
        diagnostics: {
          terminal: {
            failureClass: "worker_runtime_failure",
            terminalStage: "worker_runtime",
          },
        },
      }),
    ).toBe("worker_runtime_failure");
  });

  test("requires explicit no-publishable semantics for artifact-only failures", () => {
    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Worker command failed",
        stderr: "dependency projection was prepared before the command exited 1",
        stdout: "Dependency projection: /workspace/node_modules",
        exitCode: 1,
      }),
    ).toBe("worker_failure");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Executor authentication failed",
        stderr: "Unauthorized: login is required",
        stdout: "Earlier agent narration said there were no publishable changes yet",
        exitCode: 1,
      }),
    ).toBe("worker_failure");

    expect(
      inferWorkerTerminalFailureClass({
        ok: false,
        summary: "Executor produced no publishable code changes",
        stderr: "Only non-publishable artifact paths changed: node_modules/.cache",
        exitCode: 1,
      }),
    ).toBe("artifact_only_no_publishable_patch");
  });

  test("classifies missing runtime prompts before incidental timeout task text", () => {
    const result = {
      ok: false,
      summary: "Job failed (exit 1, elapsed 600000ms)",
      stderr:
        "[JobRunner] Fatal error: Error: ENOENT: no such file or directory, open '/workspace/prompts/review_agent/reviewer.md'",
      stdout: "Task: harden timeout handling and add timeout tests",
      exitCode: 1,
    };

    expect(inferWorkerTerminalFailureClass(result)).toBe("missing_runtime_asset");
    expect(didWorkerWatchdogFire(result)).toBe(false);
  });

  test("does not mark ordinary timeout-related task wording as a fired watchdog", () => {
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "Validation failed",
        stdout: "Implement timeout handling and test timeout cleanup",
        stderr: "assertion failed",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "Authentication failed",
        stdout: "Please add watchdog tests and follow the rollout coach guidance.",
        stderr: "Unauthorized",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "Validation failed",
        stdout: "Add regression coverage for signal 15 and exit 137 process cleanup.",
        stderr: "assertion failed",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "Job timed out in Docker executor after 900000ms",
        exitCode: 124,
      }),
    ).toBe(true);
  });

  test("recognizes the executor's actual rollout-coach watchdog event", () => {
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "openai_codex rollout coach could not safely reset broad changes",
        stderr: "Rollout coach fired after 180s: broad diff exceeded the safe scope. Failing fast.",
        exitCode: 124,
      }),
    ).toBe(true);
    expect(
      didWorkerWatchdogFire({
        ok: false,
        summary: "Authentication failed",
        stdout: "Please follow the rollout coach guidance before retrying.",
        stderr: "Unauthorized",
        exitCode: 1,
      }),
    ).toBe(false);
  });

  test("recycles a worker after a codex startup stall", () => {
    expect(
      shouldRecycleWorkerForCodexUnavailableFailure(
        "openai_codex stalled before first response",
        "startup stall after restart",
      ),
    ).toBe(true);
  });

  test("defers Docker Codex startup stalls for a direct WorkerPal retry", () => {
    const startupStall = {
      ok: false,
      summary: "openai_codex stalled before first response",
      stderr: "Codex subprocess emitted only startup events",
      exitCode: 124,
    };

    expect(
      shouldDeferDockerCodexStartupStallForDirectRetry({
        dockerEnabled: true,
        result: startupStall,
      }),
    ).toBe(true);
    expect(
      shouldDeferDockerCodexStartupStallForDirectRetry({
        dockerEnabled: false,
        result: startupStall,
      }),
    ).toBe(false);
    expect(
      shouldDeferDockerCodexStartupStallForDirectRetry({
        dockerEnabled: true,
        result: {
          ok: false,
          summary: "openai_codex made no publishable changes before the no-edit watchdog",
          stderr: "Codex produced tool progress but no patch",
          exitCode: 124,
        },
      }),
    ).toBe(false);
  });

  test("uses a distinct recycle exit code for Codex startup stalls", () => {
    expect(
      workerRecycleExitCodeForResult({
        ok: false,
        summary: "openai_codex stalled before first response",
        exitCode: 124,
      }),
    ).toBe(87);
    expect(
      workerRecycleExitCodeForResult({
        ok: false,
        summary: "openai_codex chatgpt auth is not ready",
        exitCode: 1,
      }),
    ).toBe(86);
  });
});
