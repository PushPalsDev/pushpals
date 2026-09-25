import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { workerStartupAllowanceMs } from "shared";
import { WorkerStartupBudget } from "../apps/workerpals/src/startup_budget";
import {
  confirmsOwnedContainerRemoval,
  DockerExecutor,
} from "../apps/workerpals/src/docker_executor";

function clockBudget(deadline = workerStartupAllowanceMs(120_000, true)) {
  let now = 0;
  const lines: string[] = [];
  const budget = new WorkerStartupBudget({
    normalTimeoutMs: 120_000,
    docker: true,
    env: { PUSHPALS_WORKER_STARTUP_DEADLINE_MS: String(deadline) },
    now: () => now,
    monotonicNow: () => now,
    log: (line) => lines.push(line),
  });
  return {
    budget,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("WorkerPal startup phase budget", () => {
  test("a primary registry pull retains its existing ten-minute command budget", async () => {
    const { budget, advance } = clockBudget();
    await budget.phase("docker-image-pull", async (timeoutMs) => {
      expect(timeoutMs).toBe(600_000);
      advance(150_000);
      expect(budget.capTimeout(600_000)).toBe(450_000);
    });
  });

  test("sequential preflight commands spend one phase budget and preserve cleanup", async () => {
    const { budget, advance, lines } = clockBudget();
    await budget.phase("docker-startup-preflight", async (timeoutMs) => {
      expect(timeoutMs).toBe(120_000);
      expect(budget.capTimeout(60_000)).toBe(60_000);
      advance(95_000);
      expect(budget.capTimeout(60_000)).toBe(25_000);
      advance(25_000);
      expect(budget.capTimeout(60_000)).toBe(0);
      await budget.cleanup(async () => {
        expect(budget.capTimeout(60_000)).toBe(30_000);
        advance(5_000);
      });
    });
    expect(lines.at(-1)).toContain('"elapsedMs":125000');
  });

  test("selfcheck consumes one deadline across retries and cleanup", async () => {
    const { budget, advance } = clockBudget();
    await budget.phase("docker-startup-selfcheck", async () => {
      advance(250_000);
      expect(budget.capTimeout(60_000)).toBe(50_000);
      advance(50_000);
      expect(budget.capTimeout(15_000)).toBe(0);
      expect(budget.capTimeout(60_000, true)).toBe(30_000);
    });
    await expect(budget.phase("docker-startup-selfcheck", async () => {})).rejects.toThrow(
      "already attempted",
    );
  });

  test("inherited global deadline retains registration and cleanup headroom", async () => {
    const { budget, advance } = clockBudget(100_000);
    await budget.phase("docker-image-build", async (timeoutMs) => {
      expect(timeoutMs).toBe(60_000);
      advance(60_000);
      expect(budget.capTimeout(600_000)).toBe(0);
      expect(budget.capTimeout(600_000, true)).toBe(30_000);
      advance(5_000);
    });
    await expect(budget.phase("docker-image-pull", async () => {})).rejects.toThrow(
      "deadline expired",
    );
  });

  test("cancellation prevents new work even while explicit cleanup is active", async () => {
    const { budget } = clockBudget();
    await expect(
      budget.phase("docker-startup-selfcheck", async () => {
        budget.cancel();
        expect(budget.capTimeout(30_000)).toBe(0);
        await budget.cleanup(async () => {
          expect(budget.capTimeout(30_000)).toBe(0);
          expect(budget.capTimeout(30_000, true)).toBe(30_000);
        });
      }),
    ).rejects.toThrow("cancelled");
  });

  test("phase marker reports the actual shorter command bound", async () => {
    const { budget, lines } = clockBudget();
    await budget.phase(
      "docker-image-build",
      async (timeoutMs) => {
        expect(timeoutMs).toBe(5_000);
        return false;
      },
      (result) => result,
      5_000,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"timeoutMs":5000');
    expect(lines[1]).toContain('"event":"failed"');
  });

  test("expired inherited startup deadline never invokes a phase", async () => {
    const { budget, advance, lines } = clockBudget(100_000);
    advance(100_000);
    let invoked = false;
    await expect(
      budget.phase("docker-image-build", async () => {
        invoked = true;
      }),
    ).rejects.toThrow("deadline expired");
    expect(invoked).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("WorkerPal owned startup cleanup", () => {
  test("mixed missing-container and permission errors never confirm owned cleanup", () => {
    const names = new Set(["selfcheck-a", "selfcheck-b"]);
    const result = {
      exitCode: 1,
      timedOut: false,
      drainTimedOut: false,
      stdout: "",
      stderr:
        "Error response from daemon: No such container: selfcheck-a\nError response from daemon: permission denied removing selfcheck-b",
    };
    expect(confirmsOwnedContainerRemoval(result, names)).toBe(false);
    expect(
      confirmsOwnedContainerRemoval(
        {
          ...result,
          stdout: "selfcheck-b",
          stderr: "Error response from daemon: No such container: selfcheck-a",
        },
        names,
      ),
    ).toBe(true);
    expect(
      confirmsOwnedContainerRemoval(
        { ...result, stderr: "Error response from daemon: No such container: unrelated" },
        names,
      ),
    ).toBe(false);
    expect(
      confirmsOwnedContainerRemoval(
        {
          ...result,
          timedOut: true,
          stdout: "selfcheck-b",
          stderr: "Error response from daemon: No such container: selfcheck-a",
        },
        names,
      ),
    ).toBe(false);
  });

  test("cancelled startup worktree cleanup explicitly marks each Git capture", async () => {
    const { budget } = clockBudget();
    const commands: string[][] = [];
    const executor = Object.create(DockerExecutor.prototype) as any;
    Object.assign(executor, {
      options: { repo: process.cwd() },
      startupBudget: budget,
      runHostCommandCapture: async (
        command: string[],
        options: { timeoutMs: number; startupCleanup?: boolean },
      ) => {
        commands.push(command);
        expect(options.startupCleanup).toBe(true);
        expect(budget.capTimeout(options.timeoutMs, options.startupCleanup)).toBeGreaterThan(0);
        expect(budget.capTimeout(10_000)).toBe(0);
        return { timedOut: false, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const fixture = mkdtempSync(join(tmpdir(), "pushpals-startup-cleanup-"));
    try {
      await expect(
        budget.phase("docker-startup-selfcheck", async () => {
          budget.cancel();
          await executor.removeWorktree(join(fixture, "absent-worktree"), budget.workLedger());
        }),
      ).rejects.toThrow("cancelled");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    expect(commands.map((command) => command.slice(0, 3))).toEqual([
      ["git", "worktree", "remove"],
      ["git", "worktree", "prune"],
    ]);
  });

  test("failure after warm creation cleans Docker before propagating startup failure", async () => {
    const calls: string[] = [];
    const executor = Object.create(DockerExecutor.prototype) as any;
    Object.assign(executor, {
      options: { baseRef: "HEAD" },
      worktreeDir: process.cwd(),
      buildEphemeralWorktreeName: () => "selfcheck-mocked",
      createWorktree: async () => {
        calls.push("worktree");
      },
      runGitSelfCheckContainer: async () => {},
      ensureWorktreeAccessibleInWarmContainer: async () => {
        calls.push("warm-container");
      },
      currentBackend: () => "openai_codex",
      runWarmShell: async () => ({ ok: false, stdout: "", stderr: "canary failure", exitCode: 1 }),
      shutdown: async () => {
        calls.push("docker-cleanup");
      },
      removeWorktree: async () => {
        calls.push("worktree-cleanup");
      },
    });
    await expect(executor.validateWorktreeGitInterop()).rejects.toThrow("canary failure");
    expect(calls).toEqual(["worktree", "warm-container", "docker-cleanup", "worktree-cleanup"]);
  });

  test("one-shot startup containers carry exact ownership labels and remain tracked on timeout", async () => {
    const commands: string[][] = [];
    const executor = Object.create(DockerExecutor.prototype) as any;
    Object.assign(executor, {
      options: { repo: process.cwd(), workerId: "workerpal-owned-test", imageName: "mock-image" },
      startupSelfCheckContainers: new Set<string>(),
      runDockerCommandCapture: async (command: string[]) => {
        commands.push(command);
        return { timedOut: true, exitCode: 124, stdout: "", stderr: "" };
      },
    });
    await expect(executor.runGitSelfCheckContainer(process.cwd())).rejects.toThrow("timed out");
    expect(commands[0]).toContain("pushpals.component=workerpals-selfcheck");
    expect(commands[0]).toContain(`pushpals.repo=${process.cwd()}`);
    expect(commands[0]).toContain("pushpals.worker_id=workerpal-owned-test");
    expect(executor.startupSelfCheckContainers.size).toBe(1);
  });

  test("shutdown removes tracked one-shot and warm containers without dropping failed ownership", async () => {
    const calls: string[] = [];
    const executor = Object.create(DockerExecutor.prototype) as any;
    Object.assign(executor, {
      preparedDependencyProjectionIds: new Set(),
      startupSelfCheckContainers: new Set(["pushpals-workerpal-owned-test-selfcheck"]),
      runDockerCommandCapture: async (command: string[]) => {
        calls.push(command.slice(1).join(" "));
        return { timedOut: true, exitCode: 124, stdout: "", stderr: "timeout" };
      },
      stopWarmContainer: async () => {
        calls.push("warm cleanup");
      },
    });
    await expect(executor.shutdown()).rejects.toThrow("cleanup was not confirmed");
    expect(calls).toEqual(["rm -f pushpals-workerpal-owned-test-selfcheck", "warm cleanup"]);
    expect(executor.startupSelfCheckContainers.size).toBe(1);
  });

  test("clearing startup budget prevents a past startup deadline from capping job commands", async () => {
    const { budget, advance } = clockBudget(100_000);
    const executor = Object.create(DockerExecutor.prototype) as any;
    executor.setStartupBudget(budget);
    advance(100_000);
    const expired = await executor.runHostCommandCapture(["not-a-real-program"], {
      timeoutMs: 10_000,
    });
    expect(expired.exitCode).toBe(124);
    executor.setStartupBudget(null);
    expect(executor.startupBudget).toBeNull();
    expect(executor.startupCleanupLedger).toBeNull();
  });
});
