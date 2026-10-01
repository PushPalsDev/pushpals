import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexUsageAttempt, parseCodexTerminalUsage } from "../apps/workerpals/src/codex_usage";
import { UsageAccumulator } from "../apps/workerpals/src/quality_loop_durability";
import {
  buildCompleteWorkerReviewDiff,
  buildValidationRunDiagnostics,
  collectRequiredValidationFailures,
  buildWorkerCommitMessage,
  runValidationArgv,
  buildCommitMessageCodexCommand,
  resolveIsolatedCodexCommandPrefix,
} from "../apps/workerpals/src/execute_job";
import { validationObservationState } from "../packages/shared/src/validation_observation";
import { JobQueue } from "../apps/server/src/jobs";
import { durableCodexCommandTimings } from "../apps/workerpals/src/command_timing_diagnostics";
import { coerceCodexCommandTimings } from "../apps/workerpals/src/common/generic_python_executor";

describe("four-hour observation regressions", () => {
  test("provider usage ignores transcripts, duplicate events and subset counters", () => {
    const event = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 90,
        reasoning_output_tokens: 10,
      },
    });
    const usage = parseCodexTerminalUsage(`${"x".repeat(512 * 1024)}\n${event}\n${event}\n{`);
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      estimated: false,
      cachedInputTokens: 90,
      reasoningOutputTokens: 10,
    });
    expect(
      parseCodexTerminalUsage(
        '{"type":"turn.completed","usage":{"input_tokens":null,"output_tokens":20}}',
      ),
    ).toBeNull();
    expect(
      parseCodexTerminalUsage(
        '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":-1}}',
      ),
    ).toBeNull();
  });

  test("missing provider accounting estimates final text, not tool transcript bytes", () => {
    const usage = codexUsageAttempt({
      jsonl: "tool output".repeat(50_000),
      promptChars: 300,
      finalMessage: "done",
      stage: "critic",
      source: "quality_critic_codex",
      modelId: "test",
      attempt: 2,
      timedOut: true,
    });
    expect(usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 2,
      totalTokens: 102,
      estimated: true,
      timedOut: true,
    });
  });

  test("commit formatting is an evidence-only short call with no project tools or inherited rules", () => {
    const command = buildCommitMessageCodexCommand(["codex"], "model-test", "/tmp/message.txt");
    for (const flag of [
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--strict-config",
    ])
      expect(command).toContain(flag);
    expect(command.join(" ")).toContain("--disable shell_tool --disable apps");
    expect(command.join(" ")).toContain('model_reasoning_effort="low"');
    expect(command).toContain("model-test");
  });

  test("neutral commit workspace preserves repo-relative custom launchers", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-launcher-prefix-"));
    try {
      writeFileSync(join(repo, "wrapper.js"), "");
      expect(resolveIsolatedCodexCommandPrefix(repo, ["bun", "./wrapper.js"])).toEqual([
        "bun",
        join(repo, "wrapper.js"),
      ]);
      expect(resolveIsolatedCodexCommandPrefix(repo, ["./tools/codex"])).toEqual([
        join(repo, "tools", "codex"),
      ]);
      expect(
        resolveIsolatedCodexCommandPrefix(repo, ["bun", "x", "--yes", "@openai/codex"]),
      ).toEqual(["bun", "x", "--yes", "@openai/codex"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("timing truncation counts survive repeated transport sanitization", () => {
    const raw = {
      schemaVersion: 1,
      attempts: Array.from({ length: 4 }, (_, n) => ({
        attempt: n + 1,
        commands: Array.from({ length: 64 }, (_, index) => ({
          commandId: `command-${index + 1}`,
          category: "validation",
          digest: "a".repeat(64),
          durationMs: 1,
          observedDurationMs: 1,
          incomplete: false,
          exitCode: 0,
        })),
      })),
    };
    const sanitized = coerceCodexCommandTimings(raw);
    expect(coerceCodexCommandTimings(sanitized)).toEqual(sanitized);
    expect(durableCodexCommandTimings(sanitized)).toEqual(durableCodexCommandTimings(raw));
    expect(Number(durableCodexCommandTimings(raw)?.omittedCommands)).toBeGreaterThanOrEqual(160);
  });

  test("usage detail survives SQLite restart and remains detail of one aggregate", () => {
    const directory = mkdtempSync(join(tmpdir(), "pushpals-usage-evidence-"));
    const path = join(directory, "jobs.db");
    let queue = new JobQueue(path);
    try {
      const jobId = queue.enqueue({
        taskId: "usage",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      }).jobId!;
      const job = queue.claim("worker-observation").job!;
      const accumulator = new UsageAccumulator();
      accumulator.add(
        { promptTokens: 100, completionTokens: 20, estimated: false },
        { stage: "executor", source: "provider", attempt: 1 },
      );
      accumulator.add(
        { promptTokens: 10, completionTokens: 2, estimated: true },
        { stage: "critic", source: "fallback", attempt: 1 },
      );
      const result = accumulator.apply({ ok: false, summary: "retained" });
      expect(result.usage?.totalTokens).toBe(132);
      expect(
        queue.saveJobDiagnostics(
          jobId,
          { diagnostics: result.diagnostics },
          { workerId: job.workerId!, claimGeneration: job.claimGeneration },
        ).ok,
      ).toBe(true);
      queue.close();
      queue = new JobQueue(path);
      const metadata = (queue.getJobDiagnostics(jobId).terminal as any).metadata;
      expect(metadata.usageAttempts).toHaveLength(2);
      expect(metadata.usageAccounting).toEqual({
        providerReportedTokens: 120,
        estimatedTextTokens: 12,
        aggregation: "detail_of_job_total",
      });
      for (let attempt = 3; attempt <= 65; attempt++)
        accumulator.add(
          { promptTokens: 1, completionTokens: 1 },
          { stage: "critic", source: "provider", attempt },
        );
      expect(
        queue.saveJobDiagnostics(
          jobId,
          { diagnostics: accumulator.apply({ ok: false, summary: "retained" }).diagnostics },
          { workerId: job.workerId!, claimGeneration: job.claimGeneration },
        ).ok,
      ).toBe(true);
      const bounded = (queue.getJobDiagnostics(jobId).terminal as any).metadata;
      expect(bounded.usageAttempts).toHaveLength(50);
      expect(bounded.usageAttempts[49].attempt).toBe(65);
      expect(bounded.usageAttemptsDropped).toBe(15);
      expect(bounded.usageAttemptsTruncated).toBe(true);
      const timings = durableCodexCommandTimings({
        schemaVersion: 1,
        attempts: [
          {
            attempt: 1,
            commands: [
              {
                commandId: "command-1",
                category: "validation",
                digest: "a".repeat(64),
                durationMs: 10,
                observedDurationMs: 10,
                incomplete: false,
                exitCode: 1,
                secretCommand: "not durable",
              },
            ],
          },
        ],
      });
      expect(
        queue.saveJobDiagnostics(
          jobId,
          {
            diagnostics: { attempts: [{ attempt: 1, metadata: { codexCommandTimings: timings } }] },
          },
          { workerId: job.workerId!, claimGeneration: job.claimGeneration },
        ).ok,
      ).toBe(true);
      const storedTimings = (queue.getJobDiagnostics(jobId).attempts as any[])[0].metadata
        .codexCommandTimings;
      expect(storedTimings.commands[0]).toMatchObject({
        recoveryAttempt: 1,
        commandId: "command-1",
        durationMs: 10,
        exitCode: 1,
      });
      expect(JSON.stringify(storedTimings)).not.toContain("not durable");
      expect(JSON.stringify(storedTimings)).not.toContain("[truncated]");
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("deferred and unstarted validation never masquerade as failed processes", () => {
    const run = {
      step: "bun run all",
      command: "bun run all",
      ok: false,
      exitCode: 125,
      stdout: "",
      stderr: "not run",
      elapsedMs: 0,
      executionState: "not_started" as const,
      deferredByCommand: "bun run typecheck",
    };
    expect(buildValidationRunDiagnostics([run], 1)[0]).toMatchObject({
      passed: false,
      exitCode: null,
      durationMs: 0,
      metadata: { executionState: "not_started", deferredByCommand: "bun run typecheck" },
    });
    expect(collectRequiredValidationFailures([run.command], [run])[0]).toContain(
      "not_started after bun run typecheck",
    );
    expect(
      collectRequiredValidationFailures([run.command], [{ ...run, executionState: "executed" }])[0],
    ).toContain("exited 125");
    expect(validationObservationState({ source: "worker", capability: "trusted_host" })).toBe(
      "deferred",
    );
    expect(validationObservationState({ source: "trusted_host", capability: "trusted_host" })).toBe(
      "executed",
    );
    expect(validationObservationState({ exitCode: 125 })).toBe("executed");
  });

  test("final plan is complete despite more than twenty observations across revisions", () => {
    const queue = new JobQueue(":memory:");
    try {
      const id = queue.enqueue({
        taskId: "many-observations",
        sessionId: "dev",
        kind: "task.execute",
        params: {},
      }).jobId!;
      const job = queue.claim("worker-observation").job!;
      const runs = Array.from({ length: 3 }, (_, attempt) =>
        Array.from({ length: 12 }, (_, n) => ({
          attempt,
          command: `bun run gate${n}`,
          passed: attempt === 2,
        })),
      ).flat();
      const save = (count: number) =>
        queue.saveJobDiagnostics(
          id,
          {
            diagnostics: {
              validationRuns: runs,
              terminal: { metadata: { revisionAttempt: 2, validationRuns: count } },
            },
          },
          { workerId: job.workerId!, claimGeneration: job.claimGeneration },
        );
      expect(save(12).ok).toBe(true);
      const snapshot = () =>
        (queue as any).db
          .query("SELECT commandsJson FROM job_validation_snapshots WHERE jobId = ?")
          .get(id).commandsJson;
      expect(JSON.parse(snapshot())).toEqual(
        runs.filter((r) => r.attempt === 2).map((r) => r.command),
      );
      expect(save(13).ok).toBe(true);
      expect(JSON.parse(snapshot())).toBeNull();
    } finally {
      queue.close();
    }
  });

  test("worker validation retains bounded substep timings without turning markers into success", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-validation-timings-"));
    try {
      writeFileSync(
        join(repo, "gate.js"),
        'console.log("[1/1] [stage/check] Private command label"); await Bun.sleep(10); process.stdout.write("[ok] Private command label (10 ms)"); process.exit(7);',
      );
      const run = await runValidationArgv(
        repo,
        "bun gate.js",
        [process.execPath, "gate.js"],
        { ...process.env } as Record<string, string>,
        10_000,
        {},
        "deadline",
      );
      expect(run.ok).toBe(false);
      expect(run.exitCode).toBe(7);
      expect(run.substepTimings?.stages[0]).toMatchObject({
        stageId: "substep-1",
        boundary: "complete",
        observationOnly: true,
      });
      expect(JSON.stringify(run.substepTimings)).not.toContain("Private command label");
      expect(buildValidationRunDiagnostics([run], 0)[0]?.metadata?.substepTimings).toEqual(
        run.substepTimings,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("critic sees ninth file, over 600 lines and over 16k characters; a small budget holds instead of clipping", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-complete-review-"));
    try {
      for (const args of [
        ["init"],
        ["config", "user.name", "test"],
        ["config", "user.email", "test@example.com"],
      ])
        expect(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode).toBe(0);
      writeFileSync(join(repo, "base.txt"), "base\n");
      expect(Bun.spawnSync(["git", "add", "."], { cwd: repo }).exitCode).toBe(0);
      expect(Bun.spawnSync(["git", "commit", "-m", "base"], { cwd: repo }).exitCode).toBe(0);
      const paths = Array.from({ length: 9 }, (_, n) => `file${n}.txt`);
      for (const path of paths)
        writeFileSync(
          join(repo, path),
          `${"complete evidence Unicode 界\n".repeat(90)}LAST-${path}\n`,
        );
      const patch = await buildCompleteWorkerReviewDiff(repo, paths, 65_536);
      expect(patch.length).toBeGreaterThan(16_000);
      expect(patch.split("\n").length).toBeGreaterThan(600);
      expect(patch).toContain("LAST-file8.txt");
      await expect(buildCompleteWorkerReviewDiff(repo, paths, 16_000)).rejects.toThrow(
        "Review evidence incomplete",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("accompanying documentation does not turn implementation work into a docs-scoped commit", () => {
    const message = buildWorkerCommitMessage(
      "worker",
      { id: "job", kind: "task.execute", params: { instruction: "Fix navigation state" } },
      ["docs/navigation.md", "utils/navigation.ts", "tests/navigation.test.ts"],
    );
    expect(message.split("\n")[0]).toContain("(utils)");
  });
});
