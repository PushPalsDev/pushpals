import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPushPalsConfig } from "shared";
import {
  capQualityRepairContinuationToDeadline,
  enforceJobDeadlineBeforeSuccess,
  enforceTimeoutCandidateValidationProof,
  executeJob,
  shouldValidateExecutorTimeoutCandidate,
  type CriticOutcome,
  type DeterministicQualityResult,
} from "../apps/workerpals/src/execute_job";
import { JobDeadlineLedger } from "../apps/workerpals/src/quality_loop_durability";
import type { JobResult } from "../apps/workerpals/src/common/types";
import {
  getBackendTaskExecutor,
  registerBackendTaskExecutor,
  unregisterBackendTaskExecutor,
} from "../apps/workerpals/src/backends/task_execute_registry";

const partial: JobResult = {
  ok: false,
  exitCode: 124,
  summary: "openai_codex timed out with a retained partial candidate",
  candidateState: { status: "partial", reason: "executor_timeout", changedPaths: ["candidate.ts"] },
};
const policy = {
  mode: "default" as const,
  scopeGateEnabled: true,
  validationGateEnabled: true,
  criticGateEnabled: true,
  publishGateEnabled: true,
};
function quality(): DeterministicQualityResult {
  return {
    ok: true,
    skipped: false,
    issues: [],
    scopeIssues: [],
    validationIssues: [],
    changedPaths: ["candidate.ts"],
    changedTestPaths: ["candidate.test.ts"],
    validationRuns: [
      {
        command: "bun test candidate.test.ts",
        step: "bun test candidate.test.ts",
        ok: true,
        exitCode: 0,
        stdout: "1 pass",
        stderr: "",
        elapsedMs: 10,
      },
    ],
    requiredValidationFailures: [],
    blocker: null,
    validationFailureScope: "none",
  };
}
function verdict(score = 9, mustFix: string[] = []): CriticOutcome {
  return {
    kind: "verdict",
    review: { score, mustFix, findings: [], revisionGuidance: "", raw: "fixture" },
    usageAttempts: [],
  };
}

describe("retained executor timeout candidates fail closed", () => {
  test("requires exact structured timeout metadata, time remaining, and every quality gate", () => {
    const eligible = { result: partial, remainingWorkMs: 90_000, policy };
    expect(shouldValidateExecutorTimeoutCandidate(eligible)).toBe(true);
    for (const result of [
      { ...partial, candidateState: undefined },
      { ...partial, exitCode: 1 },
      { ...partial, candidateState: { ...partial.candidateState!, reason: "startup_stall" } },
      { ...partial, candidateState: { ...partial.candidateState!, changedPaths: [] } },
    ])
      expect(shouldValidateExecutorTimeoutCandidate({ ...eligible, result })).toBe(false);
    expect(shouldValidateExecutorTimeoutCandidate({ ...eligible, remainingWorkMs: 89_999 })).toBe(
      false,
    );
    for (const gate of [
      "scopeGateEnabled",
      "validationGateEnabled",
      "criticGateEnabled",
      "publishGateEnabled",
    ])
      expect(
        shouldValidateExecutorTimeoutCandidate({
          ...eligible,
          policy: { ...policy, [gate]: false },
        }),
      ).toBe(false);
  });

  test("rejects failed, skipped, missing, required, scope, and no-diff validation evidence", () => {
    const base = quality();
    const variants: DeterministicQualityResult[] = [
      { ...base, skipped: true },
      { ...base, validationRuns: [] },
      { ...base, changedPaths: [] },
      { ...base, scopeIssues: ["unrelated edit"] },
      { ...base, issues: ["missing acceptance coverage"] },
      { ...base, blocker: { category: "repo", detail: "missing module" } },
      { ...base, requiredValidationFailures: ["bun run validate was not executed"] },
      {
        ...base,
        validationRuns: [
          {
            ...base.validationRuns[0]!,
            ok: false,
            exitCode: 1,
            stderr: "AssertionError: Expected 1 to be 2",
          },
        ],
      },
    ];
    for (const candidateQuality of variants) {
      expect(
        enforceTimeoutCandidateValidationProof(
          { ...partial, ok: true },
          { quality: candidateQuality, criticOutcome: verdict(), criticMinScore: 8 },
        ).ok,
      ).toBe(false);
    }
  });

  test("requires a real passing critic with no must-fix findings even at a high score", () => {
    const outcomes: CriticOutcome[] = [
      verdict(7),
      verdict(9, ["Preserve candidate behavior"]),
      { kind: "skipped", reason: "executor_timeout", usageAttempts: [] },
      { kind: "timeout", reason: "deadline", usageAttempts: [] },
      { kind: "invalid", reason: "missing JSON", usageAttempts: [] },
      { kind: "unavailable", reason: "missing CLI", usageAttempts: [] },
    ];
    for (const criticOutcome of outcomes)
      expect(
        enforceTimeoutCandidateValidationProof(
          { ...partial, ok: true },
          { quality: quality(), criticOutcome, criticMinScore: 8 },
        ).ok,
      ).toBe(false);
    const result = enforceTimeoutCandidateValidationProof(
      { ...partial, ok: true },
      { quality: quality(), criticOutcome: verdict(), criticMinScore: 8 },
    );
    expect(result.ok).toBe(true);
    expect(result.candidateState).toBeUndefined();
    expect(result.diagnostics?.metadata?.executorTimeoutRecovery).toMatchObject({
      status: "validated",
    });
  });

  test("keeps an environment-only validation handoff held, never hides a mixed assertion failure", () => {
    const base = quality();
    const environmentRun = {
      ...base.validationRuns[0]!,
      command: "bun run validate",
      ok: false,
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    };
    const held: JobResult = {
      ...partial,
      ok: true,
      validationBlocked: {
        commands: ["bun run validate"],
        category: "environment",
        summary: "Docker unavailable",
        detail: "Docker unavailable",
      },
    };
    const deferred = {
      ...base,
      ok: false,
      issues: ["ValidationGate: Required vision.md validation failed"],
      requiredValidationFailures: ["bun run validate exited 1"],
      blocker: { category: "environment" as const, detail: "Docker unavailable" },
      validationRuns: [...base.validationRuns, environmentRun],
    };
    const recovered = enforceTimeoutCandidateValidationProof(held, {
      quality: deferred,
      criticOutcome: verdict(),
      criticMinScore: 8,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.validationBlocked).toEqual(held.validationBlocked);
    expect(recovered.diagnostics?.metadata?.executorTimeoutRecovery).toMatchObject({
      status: "trusted_validation_pending",
    });
    deferred.validationRuns.push({
      ...base.validationRuns[0]!,
      ok: false,
      exitCode: 1,
      stderr: "AssertionError: Expected 1 to be 2",
    });
    expect(
      enforceTimeoutCandidateValidationProof(held, {
        quality: deferred,
        criticOutcome: verdict(),
        criticMinScore: 8,
      }).ok,
    ).toBe(false);
  });

  test("caps continuation promises and promotion to the original absolute work deadline", () => {
    let now = 0;
    const ledger = new JobDeadlineLedger({
      executionBudgetMs: 1_200_000,
      finalizationBudgetMs: 120_000,
      startedAtMs: 0,
      now: () => now,
    });
    now = 964_436;
    const continuation = capQualityRepairContinuationToDeadline(
      {
        shouldContinue: true,
        executionBudgetMs: 420_000,
        finalizationBudgetMs: 120_000,
        reason: "focused critic repair",
      },
      ledger,
    );
    expect(continuation.executionBudgetMs).toBe(235_564);
    now = 1_200_001;
    const proven = enforceTimeoutCandidateValidationProof(
      { ...partial, ok: true },
      { quality: quality(), criticOutcome: verdict(), criticMinScore: 8 },
    );
    expect(enforceJobDeadlineBeforeSuccess(proven, ledger, ["candidate.ts"]).ok).toBe(false);
    expect(capQualityRepairContinuationToDeadline(continuation, ledger).shouldContinue).toBe(false);
  });
});

async function runRecoveryFixture(
  options: { score?: number; mustFix?: string[]; failAfterRevision?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pushpals-timeout-recovery-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const previous = getBackendTaskExecutor("openai_codex");
  const marker = join(root, "critic-called.txt");
  let attempts = 0;
  const logs: string[] = [];
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "Fixture"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    writeFileSync(join(repo, "candidate.ts"), "export const candidate = 1;\n");
    writeFileSync(
      join(repo, "candidate.test.ts"),
      'import { expect, test } from "bun:test";\nimport { candidate } from "./candidate";\ntest("candidate", () => expect(candidate).toBe(1));\n',
    );
    for (const args of [
      ["add", "."],
      ["commit", "-qm", "fixture"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    const criticScript = join(root, "critic.ts");
    writeFileSync(
      criticScript,
      [
        'if (process.argv.includes("--version")) { console.log("fixture codex 1"); process.exit(0); }',
        "await Bun.stdin.text();",
        `await Bun.write(${JSON.stringify(marker)}, "called");`,
        'const output = process.argv[process.argv.indexOf("--output-last-message") + 1];',
        `await Bun.write(output, ${JSON.stringify(JSON.stringify({ score: options.score ?? 9, must_fix: options.mustFix ?? [], findings: [], revision_guidance: "Improve the candidate implementation." }))});`,
      ].join("\n"),
    );
    registerBackendTaskExecutor("openai_codex", async () => {
      attempts++;
      writeFileSync(join(repo, "candidate.ts"), "export const candidate = 2;\n");
      writeFileSync(
        join(repo, "candidate.test.ts"),
        'import { expect, test } from "bun:test";\nimport { candidate } from "./candidate";\ntest("candidate", () => {\n  expect(candidate).toBe(2);\n  expect(candidate).not.toBe(1);\n});\n',
      );
      if (options.failAfterRevision && attempts === 1)
        return { ok: true, exitCode: 0, summary: "candidate changed" };
      return options.failAfterRevision ? { ...partial, candidateState: undefined } : partial;
    });
    const config = loadPushPalsConfig({ projectRoot: process.cwd() });
    const runtime = {
      ...config,
      workerpals: {
        ...config.workerpals,
        executor: "openai_codex" as const,
        qualityMaxAutoRevisions: 1,
        qualityValidationMaxAutoRevisions: 1,
        qualitySoftPassOnExhausted: false,
        qualityScopeGateEnabled: true,
        qualityValidationGateEnabled: true,
        qualityCriticGateEnabled: true,
        qualityPublishGateEnabled: true,
        qualityCriticMinScore: 8,
        qualityCriticTimeoutMs: 5_000,
        llm: {
          ...config.workerpals.llm,
          codexBin: `"${process.execPath.replace(/\\/g, "/")}" "${criticScript.replace(/\\/g, "/")}"`,
        },
      },
    };
    const result = await executeJob(
      "task.execute",
      {
        schemaVersion: 2,
        instruction: "Change candidate from one to two and update its unit test.",
        planning: {
          intent: "code_change",
          riskLevel: "low",
          scope: {
            readAnywhere: true,
            writeAllowed: true,
            writeGlobs: ["candidate.ts", "candidate.test.ts"],
          },
          discovery: { ripgrepQueries: ["candidate"], likelyDirs: ["."] },
          acceptanceCriteria: ["candidate returns two"],
          validationSteps: ["bun test candidate.test.ts"],
          requiredValidationSteps: ["bun test candidate.test.ts"],
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_200_000,
          finalizationBudgetMs: 120_000,
        },
      },
      repo,
      (_stream, line) => logs.push(line),
      runtime,
      undefined,
      {
        resolveCodexCommandPrefix: async (_repo, command) => {
          expect(command).toBe(runtime.workerpals.llm.codexBin);
          const prefix = [process.execPath, criticScript];
          const preflight = Bun.spawnSync([...prefix, "--version"], {
            cwd: repo,
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(preflight.exitCode).toBe(0);
          expect(preflight.stdout.toString()).toContain("fixture codex 1");
          return prefix;
        },
      },
    );
    let criticCalled = false;
    try {
      criticCalled = readFileSync(marker, "utf8") === "called";
    } catch {}
    return { result, logs, criticCalled, attempts };
  } finally {
    if (previous) registerBackendTaskExecutor("openai_codex", previous);
    else unregisterBackendTaskExecutor("openai_codex");
    rmSync(root, { recursive: true, force: true });
  }
}

describe("executeJob timeout recovery with real Git, tests, and critic subprocess", () => {
  test("validates a retained candidate and invokes the configured critic despite the timeout summary", async () => {
    const observed = await runRecoveryFixture();
    expect(
      observed.criticCalled,
      JSON.stringify({ result: observed.result, logs: observed.logs }),
    ).toBe(true);
    expect(
      observed.result.ok,
      JSON.stringify({ result: observed.result, logs: observed.logs }),
    ).toBe(true);
    expect(observed.attempts).toBe(1);
    expect(observed.result.diagnostics?.validationRuns?.some((run) => run.passed)).toBe(true);
    expect(observed.result.diagnostics?.metadata?.executorTimeoutRecovery).toMatchObject({
      status: "validated",
    });
  }, 20_000);
  test("keeps low-scoring and high-scoring must-fix candidates failed without more editing", async () => {
    for (const score of [7, 9]) {
      const observed = await runRecoveryFixture({
        score,
        mustFix: ["Candidate changes the public behavior incorrectly"],
      });
      expect(observed.criticCalled).toBe(true);
      expect(observed.result.ok).toBe(false);
      expect(observed.attempts).toBe(1);
      expect(["partial", "held"]).toContain(observed.result.candidateState?.status);
    }
  }, 30_000);
  test("preserves earlier validation and patch evidence when a later executor turn fails", async () => {
    const observed = await runRecoveryFixture({
      score: 7,
      mustFix: ["Candidate changes the public behavior incorrectly"],
      failAfterRevision: true,
    });
    expect(observed.attempts).toBe(2);
    expect(observed.result.ok).toBe(false);
    expect(observed.result.exitCode).toBe(124);
    expect(observed.result.diagnostics?.validationRuns?.some((run) => run.passed)).toBe(true);
    expect(observed.result.diagnostics?.patchSnapshots?.length).toBeGreaterThan(0);
    expect(observed.result.diagnostics?.metadata?.qualityReviews).toEqual([
      expect.objectContaining({ attempt: 0, kind: "verdict", score: 7 }),
    ]);
  }, 20_000);
});
