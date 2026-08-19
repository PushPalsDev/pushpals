import { describe, expect, test } from "bun:test";
import {
  classifyToolFailure,
  createToolRunRecordFromFailure,
  inferToolNameFromFailureText,
  resolveToolKind,
} from "shared";

describe("shared tool failure classification", () => {
  test("classifies Codex npm-shim node runtime failures distinctly", () => {
    const input = {
      summary: "Tool self-check failed",
      stdout: "codex --version failed: env: 'node': No such file or directory",
      stderr: "",
      exitCode: 127,
    };

    expect(inferToolNameFromFailureText(input)).toBe("codex");
    expect(classifyToolFailure(input)).toEqual({
      failureClass: "missing_runtime",
      retryable: false,
      remediation:
        "Codex was invoked through a launcher that requires node, but node is absent in this environment. Use a Bun-backed Codex launcher or install node in the sandbox image.",
    });
  });

  test("keeps future tools as discovered while still recording nonzero exits", () => {
    expect(resolveToolKind("sapling")).toBe("discovered");
    expect(
      classifyToolFailure({
        tool: "sapling",
        argv: ["sl", "status"],
        exitCode: 2,
        stderr: "unknown workspace",
      }),
    ).toMatchObject({
      failureClass: "nonzero_exit",
      retryable: false,
    });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: [
          "ReferenceError: route state is unavailable",
          "    at src/routeShell.ts:42:7",
          "    at /workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13",
        ].join("\n"),
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "nonzero_exit", retryable: false });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "TypeError: user fixture broke\n    at src/generic_python_executor.ts:42:7",
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "nonzero_exit", retryable: false });
  });

  test("does not mistake configured timeout budgets for an observed timeout", () => {
    expect(
      classifyToolFailure({
        tool: "bun",
        commandLine: "bun apps/workerpals/src/workerpals_main.ts",
        stdout:
          "[DockerExecutor] running with timeout=1320000ms codex_child_timeout=1200000ms\nDependency projection: /workspace/node_modules",
        stderr:
          "ReferenceError: Cannot access 'timedOut' before initialization\n    at /workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13",
        exitCode: 1,
      }),
    ).toMatchObject({
      failureClass: "worker_runtime_failure",
      retryable: false,
    });

    expect(
      classifyToolFailure({
        tool: "bun",
        stdout: "An earlier focused test timed out before this attempt restarted.",
        stderr:
          "ReferenceError: Cannot access 'timedOut' before initialization\n    at /workspace/apps/workerpals/src/common/generic_python_executor.ts:412:13",
        exitCode: 1,
      }),
    ).toMatchObject({
      failureClass: "worker_runtime_failure",
      retryable: false,
    });
  });

  test("still classifies observed timeout signals and explicit timeout state", () => {
    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "Command timed out after 1320000ms; terminated process tree.",
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "timeout", retryable: true });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "process exited after its deadline handler",
        exitCode: 124,
      }),
    ).toMatchObject({ failureClass: "timeout", retryable: true });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "context deadline exceeded",
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "timeout", retryable: true });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "Operation timeout after 5000ms",
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "timeout", retryable: true });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: "process exited without a timeout message",
        exitCode: 1,
        timedOut: true,
      }),
    ).toMatchObject({ failureClass: "timeout", retryable: true });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: 'AssertionError: expected "failure" to contain "timed out"',
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "nonzero_exit", retryable: false });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: 'Test expected output to contain "timed out", but received "failed"',
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "nonzero_exit", retryable: false });

    expect(
      classifyToolFailure({
        tool: "bun",
        stderr: 'Command option --message="timed out" was rejected',
        exitCode: 1,
      }),
    ).toMatchObject({ failureClass: "nonzero_exit", retryable: false });
  });

  test("attributes .codex branch-sync blockers to git rather than Codex", () => {
    const input = {
      summary: "Failed to sync and push task.execute commit",
      stderr:
        "Failed to sync branch before push: Tracked .codex path blocks branch sync. Move Codex state outside the repo worktree before retrying.",
      exitCode: 1,
    };

    expect(inferToolNameFromFailureText(input)).toBe("git");
    expect(classifyToolFailure(input)).toMatchObject({
      failureClass: "repo_state",
      retryable: false,
    });
  });

  test("classifies known runtime availability failures with actionable remediation", () => {
    expect(
      classifyToolFailure({
        tool: "codex",
        stderr:
          "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
        exitCode: 1,
      }),
    ).toEqual({
      failureClass: "missing_runtime",
      retryable: false,
      remediation: "Upgrade the Codex CLI/runtime used by PushPals before retrying this model.",
    });

    expect(
      classifyToolFailure({
        tool: "docker",
        stderr:
          "failed to connect to the docker API at npipe:////./pipe/docker_engine; check if the daemon is running",
        exitCode: 1,
      }),
    ).toEqual({
      failureClass: "missing_runtime",
      retryable: false,
      remediation:
        "Start Docker Desktop/the Docker daemon, then retry the Docker-backed operation.",
    });
  });

  test("creates redacted tool-run records from failure output", () => {
    const record = createToolRunRecordFromFailure({
      id: "tool-run-1",
      jobId: "job-1",
      workerId: "worker-1",
      phase: "task.execute",
      tool: "gh",
      argv: ["gh", "pr", "merge"],
      stderr: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 failed",
      exitCode: 1,
    });

    expect(record.tool).toBe("gh");
    expect(record.kind).toBe("known");
    expect(record.failureClass).toBe("nonzero_exit");
    expect(record.stderrTail).toContain("GITHUB_TOKEN=[redacted]");
    expect(record.stderrTail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });
});
