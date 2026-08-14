import { describe, expect, test } from "bun:test";
import {
  buildTrustedValidationCompletionPayload,
  didWorkerWatchdogFire,
  failCompletionEnqueue,
  holdCommitForTrustedValidation,
  inferWorkerTerminalFailureClass,
  shouldDeferDockerCodexStartupStallForDirectRetry,
  shouldEmitDirectSessionJobEvent,
  shouldRecycleWorkerForCodexUnavailableFailure,
  shouldRecycleWorkerForHeartbeatDegradation,
  workerJobResultFromDocker,
  workerRecycleExitCodeForResult,
} from "../apps/workerpals/src/workerpals_main";

describe("workerpals session event emission", () => {
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

  test("completes an environment-deferred no-change job without publication", () => {
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
    expect(held.result.ok).toBe(true);
    expect(held.result.publishBlocked).toBeUndefined();
    expect(held.result.validationBlocked).toBeUndefined();
    expect(held.result.summary).toContain("no candidate changes require publication");
    expect(inferWorkerTerminalFailureClass(held.result)).toBe("success");
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
        summary: "Job timed out in Docker executor after 900000ms",
        exitCode: 124,
      }),
    ).toBe(true);
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
