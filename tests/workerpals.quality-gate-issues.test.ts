import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  canReturnTrustedEnvironmentValidationHandoff,
  buildBrowserValidationRepairPacket,
  buildCriticDiffText,
  browserValidationRepairContinuationBudgetDecision,
  buildQualityRevisionHint,
  buildCriticRevisionIssues,
  buildQualityGateRevisionIssues,
  buildTaskFailureJobFamily,
  classifyValidationRunFailure,
  detectValidationBlocker,
  expandKnownArtifactDirectoryPaths,
  findUnchangedValidationFailure,
  extractValidationFailureRetryDigest,
  isBrowserValidationInfrastructureDigest,
  knownFailureHintsForPacket,
  knownValidationRemedyHintsForRuns,
  inScopeValidationRepairContinuationBudgetDecision,
  isolatePureEnvironmentValidationDeferral,
  publishableChangedPaths,
  qualityRevisionBudgetDecision,
  qualityRevisionLoopUpperBound,
  recordBrowserFailureMemory,
  recordValidationRemedyMemory,
  repoValidationLeaseRecoveryReason,
  repoValidationRepairContinuationBudgetDecision,
  shouldSkipCriticAfterExecutorTimeout,
  shouldSkipCriticForDeterministicValidationRevision,
  shouldSkipCriticToPreserveRevisionBudget,
  shouldRepairOutsideTaskRequiredValidation,
  shouldRetryCriticTimeoutWithCompact,
  shouldReviseRequiredValidationBlocker,
  shouldRetryBrowserValidationRunOnce,
  shouldRetryPassingVitestTeardownOnce,
  shouldRetryTransientInfrastructureValidationOnce,
  shouldDeferHigherTierValidationAfterFailure,
  validationCommandExecutionTier,
  revisionLimitForQualityGateFailures,
  relaxAdvisoryQualityIssues,
  shouldSoftPassCriticOnlyBudgetExhaustion,
  workerAttemptRolloutScore,
} from "../apps/workerpals/src/execute_job";

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("workerpals quality gate critic issue formatting", () => {
  test("isolates pure environment failures from critic and revision inputs", () => {
    const result = isolatePureEnvironmentValidationDeferral({
      ok: false,
      skipped: false,
      issues: [
        "ScopeGate: acceptance criterion is not covered.",
        "ValidationGate: Required vision.md validation failed: bun run validate exited 1",
      ],
      scopeIssues: ["acceptance criterion is not covered."],
      validationIssues: ["Required vision.md validation failed: bun run validate exited 1"],
      changedPaths: ["src/example.ts"],
      changedTestPaths: [],
      validationRuns: [
        {
          step: "bun test focused.test.ts",
          command: "bun test focused.test.ts",
          ok: true,
          exitCode: 0,
          stdout: "1 pass",
          stderr: "",
          elapsedMs: 10,
        },
        {
          step: "bun run validate",
          command: "bun run validate",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
          elapsedMs: 20,
        },
      ],
      requiredValidationFailures: ["bun run validate exited 1"],
      blocker: { category: "environment", detail: "Docker is unavailable" },
      validationFailureScope: "outside_task_scope",
    });

    expect(result.pureEnvironmentDeferral).toBe(true);
    expect(result.blockedCommands).toEqual(["bun run validate"]);
    expect(result.qualityForCritic.issues).toEqual([
      "ScopeGate: acceptance criterion is not covered.",
    ]);
    expect(result.qualityForCritic.validationRuns.map((run) => run.command)).toEqual([
      "bun test focused.test.ts",
    ]);
    expect(result.qualityForCritic.requiredValidationFailures).toEqual([]);
    expect(result.qualityForCritic.blocker).toBeNull();
    expect(result.qualityForCritic.validationFailureScope).toBe("none");
  });

  test("does not defer a mixed environment and assertion failure cluster", () => {
    const environmentRun = {
      step: "bun run validate",
      command: "bun run validate",
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      elapsedMs: 20,
    };
    const assertionRun = {
      step: "bun test focused.test.ts",
      command: "bun test focused.test.ts",
      ok: false,
      exitCode: 1,
      stdout: "Expected 1 to be 2",
      stderr: "1 test failed",
      elapsedMs: 10,
    };
    const quality = {
      ok: false,
      skipped: false,
      issues: ["ValidationGate: executed validation commands, but none passed."],
      scopeIssues: [],
      validationIssues: ["executed validation commands, but none passed."],
      changedPaths: ["src/example.ts"],
      changedTestPaths: ["focused.test.ts"],
      validationRuns: [environmentRun, assertionRun],
      requiredValidationFailures: ["bun run validate exited 1"],
      blocker: { category: "environment" as const, detail: "Docker is unavailable" },
      validationFailureScope: "task_scope" as const,
    };

    const result = isolatePureEnvironmentValidationDeferral(quality);
    expect(result.pureEnvironmentDeferral).toBe(false);
    expect(result.qualityForCritic).toBe(quality);
  });

  test("does not defer repository dependency failures", () => {
    const quality = {
      ok: false,
      skipped: false,
      issues: ["ValidationGate: executed validation commands, but none passed."],
      scopeIssues: [],
      validationIssues: ["executed validation commands, but none passed."],
      changedPaths: ["src/example.ts"],
      changedTestPaths: [],
      validationRuns: [
        {
          step: "bun test",
          command: "bun test",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Cannot find module './missing.ts'",
          elapsedMs: 10,
        },
      ],
      requiredValidationFailures: ["bun test exited 1"],
      blocker: { category: "repo" as const, detail: "missing imported file" },
      validationFailureScope: "task_scope" as const,
    };
    expect(isolatePureEnvironmentValidationDeferral(quality).pureEnvironmentDeferral).toBe(false);
  });

  test("requires an enabled critic to meet the final threshold before environment handoff", () => {
    expect(
      canReturnTrustedEnvironmentValidationHandoff({
        pureEnvironmentDeferral: true,
        deterministicRequiresRevision: false,
        criticGateEnabled: true,
        criticScore: 8.4,
        criticMinScore: 8.5,
      }),
    ).toBe(false);
    expect(
      canReturnTrustedEnvironmentValidationHandoff({
        pureEnvironmentDeferral: true,
        deterministicRequiresRevision: false,
        criticGateEnabled: true,
        criticScore: null,
        criticMinScore: 8.5,
      }),
    ).toBe(false);
    expect(
      canReturnTrustedEnvironmentValidationHandoff({
        pureEnvironmentDeferral: true,
        deterministicRequiresRevision: false,
        criticGateEnabled: true,
        criticScore: 8.5,
        criticMinScore: 8.5,
      }),
    ).toBe(true);
    expect(
      canReturnTrustedEnvironmentValidationHandoff({
        pureEnvironmentDeferral: true,
        deterministicRequiresRevision: true,
        criticGateEnabled: false,
        criticScore: null,
        criticMinScore: 8.5,
      }),
    ).toBe(false);
  });

  test("builds critic diff evidence for tracked and untracked changes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pushpals-critic-diff-"));
    try {
      runGit(tempRoot, ["init"]);
      runGit(tempRoot, ["config", "user.name", "PushPals Test"]);
      runGit(tempRoot, ["config", "user.email", "pushpals-test@example.com"]);
      writeFileSync(join(tempRoot, "tracked.txt"), "before\n");
      runGit(tempRoot, ["add", "tracked.txt"]);
      runGit(tempRoot, ["commit", "-m", "initial"]);

      writeFileSync(join(tempRoot, "tracked.txt"), "after\n");
      mkdirSync(join(tempRoot, "docs"), { recursive: true });
      writeFileSync(join(tempRoot, "docs", "new-guide.md"), "# New guide\n");

      const diff = await buildCriticDiffText(tempRoot, ["tracked.txt", "docs/new-guide.md"]);

      expect(diff).toContain("-before");
      expect(diff).toContain("+after");
      expect(diff).toContain("new file mode");
      expect(diff).toContain("+++ b/docs/new-guide.md");
      expect(diff).toContain("+# New guide");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("recovers heartbeat leases only for dead owners or stale heartbeats", () => {
    const owner = {
      owner: "123-lease",
      heartbeatVersion: 1,
      pid: 123,
      host: "worker-a",
    };

    expect(
      repoValidationLeaseRecoveryReason({
        owner,
        ownerMtimeMs: 90_000,
        nowMs: 100_000,
        currentHost: "worker-a",
        ownerProcessAlive: false,
      }),
    ).toBe("dead owner process");
    expect(
      repoValidationLeaseRecoveryReason({
        owner,
        ownerMtimeMs: 60_000,
        nowMs: 100_000,
        currentHost: "worker-b",
        ownerProcessAlive: null,
      }),
    ).toBe("stale heartbeat");
    expect(
      repoValidationLeaseRecoveryReason({
        owner,
        ownerMtimeMs: 90_000,
        nowMs: 100_000,
        currentHost: "worker-b",
        ownerProcessAlive: null,
      }),
    ).toBeNull();
  });

  test("keeps the longer safety window for legacy validation leases", () => {
    expect(
      repoValidationLeaseRecoveryReason({
        owner: { owner: "legacy" },
        ownerMtimeMs: 0,
        nowMs: 89 * 60_000,
        currentHost: "worker-a",
        ownerProcessAlive: null,
      }),
    ).toBeNull();
    expect(
      repoValidationLeaseRecoveryReason({
        owner: { owner: "legacy" },
        ownerMtimeMs: 0,
        nowMs: 91 * 60_000,
        currentHost: "worker-a",
        ownerProcessAlive: null,
      }),
    ).toBe("stale legacy lease");
  });

  test("filters dependency and runtime artifacts out of publishable changed paths", () => {
    expect(
      publishableChangedPaths([
        "components/GameControlPanel.tsx",
        "node_modules/react/index.js",
        "outputs/data/runtime.log",
        ".worktrees/job-123/tmp.txt",
        ".codex/session.json",
        "Microsoft/Windows/PowerShell/ModuleAnalysisCache",
        "tests/playerActionControls.test.ts",
      ]),
    ).toEqual(["components/GameControlPanel.tsx", "tests/playerActionControls.test.ts"]);
  });

  test("expands Windows PowerShell cache directories before publishable filtering", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pushpals-powershell-cache-"));
    try {
      const cacheDir = join(tempRoot, "Microsoft", "Windows", "PowerShell");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "ModuleAnalysisCache"), "cache artifact\n");

      const expanded = expandKnownArtifactDirectoryPaths(tempRoot, ["Microsoft/"]);

      expect(expanded).toEqual(["Microsoft/Windows/PowerShell/ModuleAnalysisCache"]);
      expect(publishableChangedPaths(expanded)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("stops quality revisions when the remaining execution budget is too small", () => {
    expect(
      qualityRevisionBudgetDecision({
        jobElapsedMs: 600_000,
        executionBudgetMs: 1_200_000,
      }),
    ).toEqual({
      shouldStart: true,
      remainingBudgetMs: 600_000,
      minimumRevisionBudgetMs: 300_000,
    });

    expect(
      qualityRevisionBudgetDecision({
        jobElapsedMs: 1_000_000,
        executionBudgetMs: 1_200_000,
      }),
    ).toEqual({
      shouldStart: false,
      remainingBudgetMs: 200_000,
      minimumRevisionBudgetMs: 300_000,
    });
  });

  test("soft-passes critic-only revision when validation passed but budget is exhausted", () => {
    expect(
      shouldSoftPassCriticOnlyBudgetExhaustion({
        softPassOnExhausted: true,
        deterministicRequiresRevision: false,
        criticRequiresRevision: true,
        requiredValidationFailures: [],
        changedPaths: ["components/Planet.tsx", "scripts/test-web-e2e.js"],
      }),
    ).toBe(true);

    expect(
      shouldSoftPassCriticOnlyBudgetExhaustion({
        softPassOnExhausted: true,
        deterministicRequiresRevision: true,
        criticRequiresRevision: true,
        requiredValidationFailures: [],
        changedPaths: ["components/Planet.tsx"],
      }),
    ).toBe(false);

    expect(
      shouldSoftPassCriticOnlyBudgetExhaustion({
        softPassOnExhausted: true,
        deterministicRequiresRevision: false,
        criticRequiresRevision: true,
        requiredValidationFailures: ["bun run web:e2e"],
        changedPaths: ["components/Planet.tsx"],
      }),
    ).toBe(false);

    expect(
      shouldSoftPassCriticOnlyBudgetExhaustion({
        softPassOnExhausted: true,
        deterministicRequiresRevision: false,
        criticRequiresRevision: true,
        requiredValidationFailures: [],
        changedPaths: ["node_modules/react/index.js"],
      }),
    ).toBe(false);
  });

  test("continues in-scope browser validation repair after the generic revision budget is exhausted", () => {
    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: 1_200_000,
      executionBudgetMs: 1_200_000,
    });
    const packet = {
      command: "bun run web:e2e",
      failureKind: "assertion" as const,
      stage: "settings return navigation",
      selector: '[data-testid="settings-home-button"]',
      expected: "settings home button returns to the home screen",
      failureFocus: "phase/progression",
      digest: "Navigation/phase progression smoke failure",
      previousDigest: "home route startup",
      previousStage: "home route startup",
      previousSelector: '[data-testid="home-screen"]',
      previousExpected: "home screen is visible",
      previousFailureFocus: "route/startup",
      progress: "new_failure" as const,
      needsDiagnosticProbe: false,
      artifacts: ["artifacts/web-e2e/settings-return.png"],
      output: "visible settings home button did not return to home",
    };

    expect(
      browserValidationRepairContinuationBudgetDecision({
        browserRepairPacket: packet,
        validationOutsideTaskScope: false,
        changedPaths: ["scripts/test-web-e2e.js"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: true,
      executionBudgetMs: 900_000,
      finalizationBudgetMs: 120_000,
      reason:
        "browser validation repair made a publishable patch but exhausted the original revision budget",
    });
  });

  test("does not continue browser validation repair without a publishable patch", () => {
    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: 1_200_000,
      executionBudgetMs: 1_200_000,
    });
    const packet = {
      command: "bun run web:e2e",
      failureKind: "assertion" as const,
      stage: "settings return navigation",
      selector: '[data-testid="settings-home-button"]',
      expected: "settings home button returns to the home screen",
      failureFocus: "phase/progression",
      digest: "Navigation/phase progression smoke failure",
      previousDigest: "home route startup",
      previousStage: "home route startup",
      previousSelector: '[data-testid="home-screen"]',
      previousExpected: "home screen is visible",
      previousFailureFocus: "route/startup",
      progress: "new_failure" as const,
      needsDiagnosticProbe: false,
      artifacts: ["artifacts/web-e2e/settings-return.png"],
      output: "visible settings home button did not return to home",
    };

    expect(
      browserValidationRepairContinuationBudgetDecision({
        browserRepairPacket: packet,
        validationOutsideTaskScope: false,
        changedPaths: ["Microsoft/Windows/PowerShell/ModuleAnalysisCache"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable browser repair patch is present",
    });
  });

  test("enters repo validation repair mode for outside-scope required validation blockers", () => {
    expect(
      shouldRepairOutsideTaskRequiredValidation({
        requiredValidationFailures: [
          'bun run lint exited 1 (error: "eslint.exe" exited with code 1)',
        ],
        validationFailureScope: "outside_task_scope",
        changedPaths: ["README.md", "package.json"],
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(true);

    expect(
      shouldRepairOutsideTaskRequiredValidation({
        requiredValidationFailures: ["bun run lint exited 1"],
        validationFailureScope: "outside_task_scope",
        changedPaths: ["Microsoft/Windows/PowerShell/ModuleAnalysisCache"],
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);

    expect(
      shouldRepairOutsideTaskRequiredValidation({
        requiredValidationFailures: ["bun run lint exited 1"],
        validationFailureScope: "outside_task_scope",
        changedPaths: ["README.md"],
        revisionAttempt: 3,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);

    expect(
      shouldRepairOutsideTaskRequiredValidation({
        requiredValidationFailures: ["bun run lint exited 1"],
        validationFailureScope: "outside_task_scope",
        changedPaths: ["package.json", "tsconfig.json"],
        revisionAttempt: 3,
        maxAutoRevisions: 4,
      }),
    ).toBe(true);
  });

  test("continues repo validation repair after the generic revision budget is exhausted", () => {
    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: 1_200_000,
      executionBudgetMs: 1_200_000,
    });

    expect(
      repoValidationRepairContinuationBudgetDecision({
        repoValidationRepairMode: true,
        changedPaths: ["README.md", "package.json"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: true,
      executionBudgetMs: 900_000,
      finalizationBudgetMs: 120_000,
      reason:
        "repo validation repair has publishable work but exhausted the original revision budget",
    });

    expect(
      repoValidationRepairContinuationBudgetDecision({
        repoValidationRepairMode: true,
        changedPaths: ["outputs/web-e2e/failure.png"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable patch is present",
    });
  });

  test("continues in-scope deterministic validation repair after the generic revision budget is exhausted", () => {
    const revisionBudget = qualityRevisionBudgetDecision({
      jobElapsedMs: 1_200_000,
      executionBudgetMs: 1_200_000,
    });

    expect(
      inScopeValidationRepairContinuationBudgetDecision({
        requiredValidationFailures: [
          "bun test exited 1 (Export named 'getReactNativeMock' not found)",
        ],
        validationOutsideTaskScope: false,
        changedPaths: ["tests/reactNativeMock.ts", "app/__tests__/_layout.autonomy.test.ts"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: true,
      executionBudgetMs: 600_000,
      finalizationBudgetMs: 120_000,
      reason:
        "in-scope validation repair has publishable work but exhausted the original revision budget",
    });

    expect(
      inScopeValidationRepairContinuationBudgetDecision({
        requiredValidationFailures: ["bun test exited 1"],
        validationOutsideTaskScope: false,
        changedPaths: ["outputs/web-e2e/failure.png"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "no publishable validation repair patch is present",
    });

    expect(
      inScopeValidationRepairContinuationBudgetDecision({
        requiredValidationFailures: ["bun test exited 1"],
        validationOutsideTaskScope: true,
        changedPaths: ["tests/reactNativeMock.ts"],
        revisionBudget,
      }),
    ).toEqual({
      shouldContinue: false,
      executionBudgetMs: 0,
      finalizationBudgetMs: 0,
      reason: "validation failure is outside task scope",
    });
  });

  test("skips low-value compact critic retries after clean validation", () => {
    expect(
      shouldRetryCriticTimeoutWithCompact({
        timeoutBehavior: "retry_once",
        qualityOk: true,
        validationPassed: true,
        initialPromptChars: 8_908,
        compactPromptChars: 8_560,
      }),
    ).toBe(false);

    expect(
      shouldRetryCriticTimeoutWithCompact({
        timeoutBehavior: "retry_once",
        qualityOk: true,
        validationPassed: true,
        initialPromptChars: 12_000,
        compactPromptChars: 7_000,
      }),
    ).toBe(true);

    expect(
      shouldRetryCriticTimeoutWithCompact({
        timeoutBehavior: "retry_once",
        qualityOk: false,
        validationPassed: false,
        initialPromptChars: 8_908,
        compactPromptChars: 8_560,
      }),
    ).toBe(true);
  });

  test("skips critic only for clean default jobs after primary Codex timeout", () => {
    const base = {
      executor: "openai_codex",
      executorText: "openai_codex timed out after modifying 2 publishable file(s)",
      qualityOk: true,
      validationPassed: true,
      qualityIssues: [],
      changedPaths: ["src/file.ts"],
    };

    expect(shouldSkipCriticAfterExecutorTimeout({ ...base, policyMode: "default" })).toBe(true);
    expect(shouldSkipCriticAfterExecutorTimeout({ ...base, policyMode: "review_fix" })).toBe(false);
    expect(shouldSkipCriticAfterExecutorTimeout({ ...base, policyMode: "merge_conflict" })).toBe(
      false,
    );
    expect(
      shouldSkipCriticAfterExecutorTimeout({
        ...base,
        policyMode: "default",
        validationPassed: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipCriticAfterExecutorTimeout({
        ...base,
        policyMode: "default",
        executorText: "openai_codex completed normally",
      }),
    ).toBe(false);
  });

  test("skips critic when deterministic fast validation already requires revision", () => {
    expect(
      shouldSkipCriticForDeterministicValidationRevision({
        deterministicRequiresRevision: true,
        validationOutsideTaskScope: false,
        validationRuns: [
          {
            step: "bun x tsc --noEmit",
            command: "bun x tsc --noEmit",
            ok: false,
            exitCode: 2,
            stdout: "",
            stderr:
              "error TS2418: Type of computed property's value is not assignable to type 'number'.",
            elapsedMs: 13_242,
          },
        ],
      }),
    ).toBe(true);

    expect(
      shouldSkipCriticForDeterministicValidationRevision({
        deterministicRequiresRevision: true,
        validationOutsideTaskScope: false,
        validationRuns: [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "Browser validation failed during shell stage: Expected start button",
            elapsedMs: 140_855,
          },
        ],
      }),
    ).toBe(false);

    expect(
      shouldSkipCriticForDeterministicValidationRevision({
        deterministicRequiresRevision: true,
        validationOutsideTaskScope: true,
        validationRuns: [
          {
            step: "bun run lint",
            command: "bun run lint",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: 'error: "eslint" exited with code 1',
            elapsedMs: 37_046,
          },
        ],
      }),
    ).toBe(false);
  });

  test("skips critic when deterministic revision needs the remaining budget", () => {
    expect(
      shouldSkipCriticToPreserveRevisionBudget({
        deterministicRequiresRevision: true,
        remainingBudgetMs: 400_000,
        minimumRevisionBudgetMs: 300_000,
        criticTimeoutMs: 90_000,
        criticTimeoutBehavior: "retry_once",
      }),
    ).toBe(true);

    expect(
      shouldSkipCriticToPreserveRevisionBudget({
        deterministicRequiresRevision: true,
        remainingBudgetMs: 500_000,
        minimumRevisionBudgetMs: 300_000,
        criticTimeoutMs: 90_000,
        criticTimeoutBehavior: "retry_once",
      }),
    ).toBe(false);

    expect(
      shouldSkipCriticToPreserveRevisionBudget({
        deterministicRequiresRevision: true,
        remainingBudgetMs: 700_000,
        minimumRevisionBudgetMs: 300_000,
        criticTimeoutMs: 90_000,
        criticTimeoutBehavior: "retry_once",
      }),
    ).toBe(false);

    expect(
      shouldSkipCriticToPreserveRevisionBudget({
        deterministicRequiresRevision: false,
        remainingBudgetMs: 100_000,
        minimumRevisionBudgetMs: 300_000,
        criticTimeoutMs: 90_000,
        criticTimeoutBehavior: "retry_once",
      }),
    ).toBe(false);
  });

  test("scores worker rollouts by publishable progress, validation, and time", () => {
    expect(
      workerAttemptRolloutScore({
        executorElapsedMs: 600_000,
        qualityElapsedMs: 60_000,
        changedPaths: ["src/feature.ts", "tests/feature.test.ts"],
        validationRuns: [
          {
            step: "bun test",
            command: "bun test",
            ok: true,
            exitCode: 0,
            stdout: "",
            stderr: "",
            elapsedMs: 100,
          },
        ],
        qualityIssues: [],
        criticScore: 8.4,
      }).score,
    ).toBeGreaterThan(50);

    const artifactOnly = workerAttemptRolloutScore({
      executorElapsedMs: 2_000_000,
      qualityElapsedMs: 10_000,
      changedPaths: ["node_modules/pkg/index.js"],
      validationRuns: [],
      qualityIssues: ["ScopeGate: attempted to publish node_modules changes"],
      criticScore: null,
    });
    expect(artifactOnly.score).toBeLessThan(0);
    expect(artifactOnly.reasons).toContain("artifact_only_diff");
  });

  test("persists generic validation remedy hints per repo and job family", () => {
    const root = mkdtempSync(join(tmpdir(), "pushpals-remedy-memory-"));
    try {
      const run = {
        step: "bun test",
        command: "bun test",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "Cannot find module './missing-helper' from 'tests/example.test.ts'",
        elapsedMs: 42,
      };
      recordValidationRemedyMemory(root, "validation|tests", [run]);
      const hints = knownValidationRemedyHintsForRuns(root, "validation|tests", [run]);
      expect(hints.join("\n")).toContain("module-resolution");
      expect(hints.join("\n")).toContain("Fix or avoid the missing import/path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns no issues when score is at/above threshold, regardless of must-fix entries", () => {
    const issues = buildCriticRevisionIssues(
      {
        score: 8.8,
        mustFix: ["Fix validation command scope"],
      },
      8,
    );

    expect(issues).toEqual([]);
  });

  test("emits only score-threshold issue when score is below threshold", () => {
    const mustFix = Array.from({ length: 10 }, (_, idx) => `issue-${idx + 1}`);
    const issues = buildCriticRevisionIssues(
      {
        score: 7.9,
        mustFix,
      },
      8,
    );

    expect(issues).toEqual([
      "Critic score 7.9 is below required threshold 8.",
      "Critic must-fix: issue-1",
      "Critic must-fix: issue-2",
      "Critic must-fix: issue-3",
    ]);
  });

  test("includes revision guidance and findings fallback when must-fix entries are missing", () => {
    const issues = buildCriticRevisionIssues(
      {
        score: 2,
        findings: [
          "Validation output shows bun run test:root failing before completion.",
          "The worker did not update the baseline browser tuple metadata checks.",
        ],
        mustFix: [],
        revisionGuidance:
          "Fix the failing root test first, then update the tuple metadata validation so every browser tuple carries the required fields.",
      },
      8,
    );

    expect(issues).toEqual([
      "Critic score 2.0 is below required threshold 8.",
      "Critic finding: Validation output shows bun run test:root failing before completion.",
      "Critic finding: The worker did not update the baseline browser tuple metadata checks.",
      "Critic revision guidance: Fix the failing root test first, then update the tuple metadata validation so every browser tuple carries the required fields.",
    ]);
  });

  test("merges deterministic quality failures with critic guidance", () => {
    const issues = buildQualityGateRevisionIssues(
      [
        "Validation commands were executed but none passed.",
        "Validation steps did not execute a recognizable test command.",
      ],
      {
        score: 6.5,
        findings: ["The updated tests still do not cover the negative assertion path."],
        mustFix: ["Add negative-path assertions for the updated behavior."],
        revisionGuidance:
          "Fix the failing test command, then add the missing negative-path assertion coverage.",
        raw: "{}",
      },
      8,
    );

    expect(issues).toEqual([
      "Validation commands were executed but none passed.",
      "Validation steps did not execute a recognizable test command.",
      "Critic score 6.5 is below required threshold 8.",
      "Critic must-fix: Add negative-path assertions for the updated behavior.",
      "Critic revision guidance: Fix the failing test command, then add the missing negative-path assertion coverage.",
    ]);
  });

  test("includes prior review-fix requirements in quality revision hints", () => {
    const hint = buildQualityRevisionHint(
      ["Validation commands were executed but none passed."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: ["Reviewer scores >= 8.5/10", "All relevant tests pass"],
        validationSteps: ["bun test tests/api/review.test.ts"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      {
        resolutionType: "review_fix",
        prHeadRef: "agent/workerpal-1/job-xyz",
        prBaseRef: "main",
        previousReviewScore: 7.8,
        reviewThreshold: 8.5,
        previousReviewSummary: "Tests need stronger failure-path coverage",
        reviewerFindings: ["Add negative-path assertions"],
      },
    );

    expect(hint).toContain("Rejected PR retry requirements:");
    expect(hint).toContain("Previous ReviewAgent score: 7.8 / 10");
    expect(hint).toContain("Required approval threshold: 8.5 / 10");
    expect(hint).toContain("Previous reviewer must-fix items:");
    expect(hint).toContain("- Add negative-path assertions");
  });

  test("includes failed validation output in quality revision hints", () => {
    const hint = buildQualityRevisionHint(
      ["Required vision.md validation failed: bun test exited 1."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: [],
        requiredValidationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun test",
          command: "bun test",
          ok: false,
          exitCode: 1,
          stdout: "1 tests failed",
          stderr: "Cannot find module '../../tests/reactNativeMock'",
          elapsedMs: 123,
        },
      ],
      {
        category: "repo",
        detail: "Validation is blocked by missing repo dependencies or imported files.",
      },
      null,
      ["components/__tests__/AnimatedSelectionRing.test.tsx"],
    );

    expect(hint).toContain("Validation blocker: repo");
    expect(hint).toContain("Validation failure diagnostics:");
    expect(hint).toContain("- bun test failed with exit 1 after 123ms.");
    expect(hint).toContain("Cannot find module '../../tests/reactNativeMock'");
    expect(hint).toContain("Validation repair continuity rule");
    expect(hint).toContain("Prepared candidate paths to preserve during this repair:");
    expect(hint).toContain("Validation ownership rule");
  });

  test("marks outside-scope required validation revisions as repo validation repair mode", () => {
    const hint = buildQualityRevisionHint(
      [
        "ValidationGate: Required vision.md validation failed: bun run lint exited 1; bun run web:e2e exited 1",
      ],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: {
          readAnywhere: true,
          writeAllowed: true,
          writeGlobs: ["README.md", "package.json"],
        },
        acceptanceCriteria: [],
        validationSteps: [],
        requiredValidationSteps: ["bun run lint", "bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_200_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun run lint",
          command: "bun run lint",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Unable to resolve path to module 'react-native-svg'",
          elapsedMs: 234,
        },
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Web end-to-end smoke test failed: waiting for getByTestId('home-screen') to be visible",
          elapsedMs: 127_000,
        },
      ],
      { category: "repo", detail: "Required validation fails in repo-owned code." },
      null,
      ["README.md", "package.json"],
      [],
      true,
    );

    expect(hint).toContain("Repo validation repair mode");
    expect(hint).toContain("original target/relevance hints");
    expect(hint).toContain("forbidden paths and generated/runtime artifacts are still off limits");
    expect(hint).toContain("- bun run lint failed with exit 1 after 234ms.");
    expect(hint).toContain("react-native-svg");
    expect(hint).toContain("- bun run web:e2e failed with exit 1 after 127000ms.");
    expect(hint).toContain("home-screen");
  });

  test("freezes the validated patch when requesting post-validation cleanup", () => {
    const hint = buildQualityRevisionHint(
      ["Critic score 7.0 is below required threshold 8."],
      {
        score: 7,
        findings: ["Clean up an accidental artifact."],
        mustFix: ["Remove generated node_modules changes."],
        revisionGuidance: "Keep the implementation unchanged.",
        raw: "{}",
      },
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun test", "bun run web:e2e"],
        requiredValidationSteps: ["bun test", "bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun test",
          command: "bun test",
          ok: true,
          exitCode: 0,
          stdout: "tests passed",
          stderr: "",
          elapsedMs: 120,
        },
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: true,
          exitCode: 0,
          stdout: "Web end-to-end smoke test completed successfully.",
          stderr: "",
          elapsedMs: 80_000,
        },
      ],
    );

    expect(hint).toContain("Validation-preserving cleanup mode");
    expect(hint).toContain("Treat the validated patch and browser path as frozen");
    expect(hint).toContain("Do not rewrite app behavior, route flow, browser smoke selectors");
    expect(hint).toContain("Remove generated node_modules changes.");
  });

  test("builds focused browser validation repair packets with progress breadcrumbs", () => {
    const previous = new Map<string, string>([
      [
        "bun run web:e2e",
        "Browser validation failed during shell stage: Expected home screen to be visible",
      ],
    ]);

    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
            "Call log:",
            " - waiting for getByTestId('help-primary-action').last() to be visible",
          ].join("\n"),
          elapsedMs: 127_732,
        },
      ],
      previous,
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "in-game UI",
      expected: "help menu primary action to be visible",
      selector: "getByTestId('help-primary-action')",
      previousStage: "shell",
      previousExpected: "home screen to be visible",
      progress: "new_failure",
      mustReadArtifactsBeforeEdit: true,
    });
    expect(packet?.previousDigest).toContain("shell stage");
    expect(packet?.output).toContain("help menu primary action");
  });

  test("extracts browser failure artifacts and exact assertion details for repair guidance", () => {
    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected resource allocation control to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
            "Saved screenshot: /repo/outputs/web-e2e/failure-in-game-ui.png",
            "Saved trace: /repo/outputs/web-e2e/failure-in-game-ui-trace.zip",
            "Call log:",
            " - waiting for getByText('Keep (Resource)') to be visible",
          ].join("\n"),
          elapsedMs: 127_732,
        },
      ],
      new Map([
        [
          "bun run web:e2e",
          "Browser validation failed during shell stage: Expected home Play action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded. waiting for getByRole('button', { name: 'Play' })",
        ],
      ]),
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "in-game UI",
      expected: "resource allocation control to be visible",
      selector: "getByText('Keep (Resource)')",
      previousStage: "shell",
      previousExpected: "home Play action to be visible",
      previousSelector: "getByRole('button', { name: 'Play' })",
      progress: "new_failure",
    });
    expect(packet?.artifacts).toEqual([
      "/repo/outputs/web-e2e/failure-in-game-ui.png",
      "/repo/outputs/web-e2e/failure-in-game-ui-trace.zip",
    ]);
    expect(packet?.artifactSummaries?.[0]).toContain("stage=in game ui");
  });

  test("hydrates browser repair packets from recent e2e artifact logs when command output is generic", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-artifacts-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "03-settings.png");
      const logPath = join(artifactDir, "expo-web.log");
      writeFileSync(screenshotPath, "not a real image");
      writeFileSync(
        logPath,
        [
          "Verified: settings screen",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('settings-home-button').last() to be visible",
        ].join("\n"),
      );

      const packet = buildBrowserValidationRepairPacket(
        [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
            elapsedMs: 111_031,
          },
        ],
        new Map(),
        repo,
      );

      expect(packet?.selector).toBe("getByTestId('settings-home-button')");
      expect(packet?.lastVerifiedStage).toBe("settings screen");
      expect(packet?.artifacts).toContain(screenshotPath);
      expect(packet?.artifacts).toContain(logPath);
      expect(packet?.artifactSummaries?.join("\n")).toContain(
        "selector=getByTestId('settings-home-button')",
      );
      expect(packet?.output).toContain("Verified: settings screen");
      expect(packet?.output).toContain("settings-home-button");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("keeps selector and last verified stage in browser retry digests", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-retry-digest-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "expo-web.log"),
        [
          "Verified: game screen",
          "Verified: owned planet",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('game-control-panel') to be visible",
        ].join("\n"),
      );

      const digest = extractValidationFailureRetryDigest(
        {
          command: "bun run web:e2e",
          exitCode: 1,
          stdout: "",
          stderr: "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          elapsedMs: 145_252,
        },
        repo,
      );

      expect(digest).toContain("stage=planet control panel");
      expect(digest).toContain("selector=getByTestId('game-control-panel')");
      expect(digest).toContain("last verified=owned planet");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("persists known browser failure fingerprints for repo job families", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-failure-memory-"));
    try {
      const params = {
        planning: {
          intent: "code_change",
          riskLevel: "medium",
          scope: {
            readAnywhere: true,
            writeAllowed: true,
            writeGlobs: ["app/**", "scripts/**"],
          },
          targetPaths: ["app/__tests__/_layout.autonomy.test.ts"],
          acceptanceCriteria: ["web smoke catches shell startup"],
          validationSteps: ["bun run web:e2e"],
          requiredValidationSteps: ["bun run web:e2e"],
          queuePriority: "normal",
          queueWaitBudgetMs: 90_000,
          executionBudgetMs: 1_800_000,
          finalizationBudgetMs: 120_000,
        },
      };
      const packet = buildBrowserValidationRepairPacket([
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Browser validation failed during shell stage: Expected home screen to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded. page url: http://127.0.0.1:19006/",
          elapsedMs: 30_000,
        },
      ]);
      expect(packet).not.toBeNull();

      const jobFamily = buildTaskFailureJobFamily(params);
      recordBrowserFailureMemory(repo, jobFamily, packet!);
      recordBrowserFailureMemory(repo, jobFamily, packet!);

      const hints = knownFailureHintsForPacket(repo, jobFamily, packet!);
      expect(hints.join("\n")).toContain("seen 2x before");
      expect(hints.join("\n")).toContain("Read the latest artifact/log/DOM state before editing");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("treats repeated generic browser timeouts as same selector failures once logs hydrate them", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushpals-browser-same-selector-"));
    try {
      const artifactDir = join(repo, "outputs", "web-e2e");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "expo-web.log"),
        [
          "Verified: game screen",
          "Verified: owned planet",
          "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
          "Call log:",
          " - waiting for getByTestId('game-control-panel') to be visible",
        ].join("\n"),
      );

      const previousDigest =
        "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded. | stage=planet control panel | selector=getByTestId('game-control-panel') | last verified=owned planet";
      const packet = buildBrowserValidationRepairPacket(
        [
          {
            step: "bun run web:e2e",
            command: "bun run web:e2e",
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "Web end-to-end smoke test failed: locator.waitFor: Timeout 30000ms exceeded.",
            elapsedMs: 144_591,
          },
        ],
        new Map([["bun run web:e2e", previousDigest]]),
        repo,
      );

      expect(packet).toMatchObject({
        stage: "planet control panel",
        selector: "getByTestId('game-control-panel')",
        previousStage: "planet control panel",
        previousSelector: "getByTestId('game-control-panel')",
        progress: "same_failure",
        needsDiagnosticProbe: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("switches repeated browser assertion failures to diagnostic-first guidance", () => {
    const previous = new Map<string, string>([
      [
        "bun run web:e2e",
        'Web end-to-end smoke test failed: Error: Expected selected large UI option to include [x], found "Large (Game UI Style)[ ]".',
      ],
    ]);
    const packet = buildBrowserValidationRepairPacket(
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: [
            'Web end-to-end smoke test failed: Error: Expected selected large UI option marker to include "[x]", found "[ ]".',
            "Verified: settings screen",
            "Verified: settings UI size section",
            "Saved screenshot: /repo/outputs/web-e2e/02-settings.png",
          ].join("\n"),
          elapsedMs: 133_942,
        },
      ],
      previous,
    );

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "assertion",
      stage: "settings UI size section",
      failureFocus: "settings UI size",
      previousFailureFocus: "settings UI size",
      needsDiagnosticProbe: true,
    });

    const hint = buildQualityRevisionHint(
      ["ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun run web:e2e"],
        requiredValidationSteps: ["bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [],
      null,
      packet,
    );

    expect(hint).toContain("Convergence mode: diagnostic-first repair");
    expect(hint).toContain("Worker phase contract");
    expect(hint).toContain("Diagnostic artifact read requirement");
    expect(hint).toContain("do not guess another selector");
    expect(hint).toContain("locator counts");
    expect(hint).toContain("bounding boxes");
    expect(hint).toContain("Artifact freshness rule");
    expect(hint).toContain("nearby DOM snippet");
    expect(hint).toContain("React Native Web note");
    expect(hint).toContain("Do not stop after fast checks only");
    expect(hint).toContain("Do not hand off another unverified selector guess.");
  });

  test("classifies killed browser smoke commands as runtime repair packets", () => {
    const packet = buildBrowserValidationRepairPacket([
      {
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 124,
        elapsedMs: 602_015,
        stdout: "",
        stderr: 'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
      },
    ]);

    expect(packet).toMatchObject({
      command: "bun run web:e2e",
      failureKind: "runtime",
      digest: 'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
      output: 'error: script "web:e2e" was terminated by signal SIGTERM (Polite quit request)',
    });
  });

  test("does not treat Playwright locator assertion timeouts as infrastructure blockers", () => {
    expect(
      isBrowserValidationInfrastructureDigest(
        "locator.waitFor: Timeout 30000ms exceeded waiting for getByTestId('help-primary-action')",
      ),
    ).toBe(false);

    expect(isBrowserValidationInfrastructureDigest("ERR_SOCKET_BAD_PORT at port 65536")).toBe(true);
  });

  test("does not infer blockers from successful validation fallback output", () => {
    expect(
      detectValidationBlocker([
        {
          step: "bun run validate",
          command: "bun run validate",
          ok: true,
          exitCode: 0,
          elapsedMs: 264_168,
          stdout: [
            "Browser launch failed for Microsoft Edge: Chromium distribution 'msedge' is not found",
            'Run "npx playwright install msedge"',
            "Using Google Chrome for browser automation.",
            "Web end-to-end smoke test completed successfully.",
            "Publish readiness validation completed successfully.",
          ].join("\n"),
          stderr: "",
        },
      ]),
    ).toBeNull();
  });

  test("does not treat an optional browser fallback as the cause of a later failure", () => {
    expect(
      detectValidationBlocker([
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          elapsedMs: 90_000,
          stdout: [
            "Browser launch failed for Microsoft Edge: Chromium distribution 'msedge' is not found",
            'Run "npx playwright install msedge"',
            "Using Google Chrome for browser automation.",
          ].join("\n"),
          stderr: "Expected battlefield readability cue to remain visible.",
        },
      ]),
    ).toBeNull();
  });

  test("still detects a missing browser when no fallback succeeds", () => {
    expect(
      detectValidationBlocker([
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          elapsedMs: 2_000,
          stdout: "",
          stderr:
            'Browser launch failed. Run "npx playwright install chromium" to download new browsers.',
        },
      ]),
    ).toMatchObject({ category: "environment" });
  });

  test("classifies an inaccessible nested Docker daemon as an environment blocker", () => {
    expect(
      detectValidationBlocker([
        {
          step: "bun run validate",
          command: "bun run validate",
          ok: false,
          exitCode: 1,
          elapsedMs: 210_000,
          stdout: "",
          stderr:
            "[supabase tests] Failed to start the local stack.\n" +
            "[supabase tests] Supabase CLI stderr:\n" +
            "failed to inspect service: connect /var/run/docker.sock: operation not permitted",
        },
      ]),
    ).toMatchObject({
      category: "environment",
    });

    expect(
      detectValidationBlocker([
        {
          step: "bun run validate",
          command: "bun run validate",
          ok: false,
          exitCode: 1,
          elapsedMs: 23_255,
          stdout: "[publish readiness 2/8] Supabase database tests",
          stderr:
            "[supabase tests] Failed to start the local stack.\n" +
            "[supabase tests] Supabase CLI stderr:\n" +
            "failed to inspect service: Cannot connect to the Docker daemon at " +
            "unix:///var/run/docker.sock. Is the docker daemon running?",
        },
      ]),
    ).toEqual({
      category: "environment",
      detail:
        "Validation requires access to a Docker daemon that is unavailable inside the worker sandbox. Preserve the candidate and rerun the blocked command in a trusted host environment.",
    });
    expect(
      detectValidationBlocker([
        {
          step: "bun test",
          command: "bun test",
          ok: false,
          exitCode: 1,
          elapsedMs: 1_000,
          stdout: "",
          stderr: "Expected documentation to mention /var/run/docker.sock",
        },
      ]),
    ).toBeNull();
  });

  test("does not label fast validation failures as timeouts from incidental test output", () => {
    expect(
      classifyValidationRunFailure({
        step: "bun run validate",
        command: "bun run validate",
        ok: false,
        exitCode: 1,
        elapsedMs: 23_255,
        stdout:
          "(pass) timeout policy keeps browser budgets bounded\n" +
          "[publish readiness 2/8] Supabase database tests",
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. " +
          "Is the docker daemon running?",
      }),
    ).toBe("environment");
    expect(
      classifyValidationRunFailure({
        step: "bun test",
        command: "bun test",
        ok: false,
        exitCode: 1,
        elapsedMs: 1_200,
        stdout: "(pass) timeout policy keeps browser budgets bounded",
        stderr: "Expected route shell to render",
      }),
    ).toBe("nonzero_exit");
    expect(
      classifyValidationRunFailure({
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 124,
        elapsedMs: 300_000,
        stdout: "",
        stderr: "browser validation timed out after 300000ms",
      }),
    ).toBe("timeout");
  });

  test("retries route startup browser smoke failures once", () => {
    expect(
      shouldRetryBrowserValidationRunOnce({
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 1,
        elapsedMs: 110_633,
        stdout: "",
        stderr:
          "Web end-to-end smoke test failed: Route/startup smoke failure (route/startup) | phase: home route startup | expected: home screen is visible | observed: locator.waitFor: Timeout 30000ms exceeded",
      }),
    ).toBe(true);

    expect(
      shouldRetryBrowserValidationRunOnce({
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 1,
        elapsedMs: 127_732,
        stdout: "",
        stderr:
          "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
      }),
    ).toBe(false);
  });

  test("retries a Vitest worker teardown only when every reported test passed", () => {
    const passingTeardown = {
      step: "bun run validate",
      command: "bun run validate",
      ok: false,
      exitCode: 1,
      elapsedMs: 53_848,
      stdout: [
        'EnvironmentTeardownError: [vitest-worker]: Closing rpc while "resolve" was pending',
        " Test Files  1 passed (1)",
        "      Tests  27 passed (27)",
        "     Errors  1 error",
      ].join("\n"),
      stderr: 'error: script "test:worker" exited with code 1',
    };

    expect(shouldRetryPassingVitestTeardownOnce(passingTeardown)).toBe(true);
    expect(
      shouldRetryPassingVitestTeardownOnce({
        ...passingTeardown,
        stdout: [passingTeardown.stdout, " Test Files  1 failed | 1 passed (2)"].join("\n"),
      }),
    ).toBe(false);
    expect(
      shouldRetryPassingVitestTeardownOnce({
        ...passingTeardown,
        stdout:
          'EnvironmentTeardownError: [vitest-worker]: Closing rpc while "resolve" was pending',
      }),
    ).toBe(false);
  });

  test("orders focused tests before invariant and aggregate validation gates", () => {
    expect(validationCommandExecutionTier("bun test tests/route-shell.test.ts")).toBeLessThan(
      validationCommandExecutionTier("bun x tsc --noEmit"),
    );
    expect(validationCommandExecutionTier("bun x tsc --noEmit")).toBeLessThan(
      validationCommandExecutionTier("bun run validate"),
    );
    expect(validationCommandExecutionTier("bun run validate")).toBeLessThan(
      validationCommandExecutionTier("bun run web:e2e"),
    );
  });

  test("defers expensive higher-tier gates after a focused failure", () => {
    const focusedFailure = {
      step: "bun test tests/route-shell.test.ts",
      command: "bun test tests/route-shell.test.ts",
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "AssertionError: route shell boundary remains broken",
      elapsedMs: 100,
    };
    expect(
      shouldDeferHigherTierValidationAfterFailure("bun run validate", [focusedFailure]),
    ).toContain("lower-tier validation already failed");
    expect(
      shouldDeferHigherTierValidationAfterFailure("bun test tests/another.test.ts", [
        focusedFailure,
      ]),
    ).toBeNull();
    expect(
      shouldDeferHigherTierValidationAfterFailure("bun run web:e2e", [
        {
          ...focusedFailure,
          command: "bun run validate",
          step: "bun run validate",
        },
      ]),
    ).toContain('lower-tier validation already failed for "bun run validate"');
  });

  test("retries transient infrastructure failures once without retrying assertions", () => {
    const base = {
      step: "bun test",
      command: "bun test",
      ok: false,
      exitCode: 1,
      stdout: "",
      elapsedMs: 100,
    };
    expect(
      shouldRetryTransientInfrastructureValidationOnce({
        ...base,
        stderr: "fetch failed: ECONNRESET",
      }),
    ).toBe(true);
    expect(
      shouldRetryTransientInfrastructureValidationOnce({
        ...base,
        stderr: "AssertionError: expected true to be false",
      }),
    ).toBe(false);
  });

  test("opens the local revision circuit on the second unchanged failure digest", () => {
    const run = {
      step: "bun test tests/route-shell.test.ts",
      command: "bun test tests/route-shell.test.ts",
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "Error: route shell import boundary still fails",
      elapsedMs: 100,
    };
    const digest = extractValidationFailureRetryDigest(run, process.cwd());
    expect(
      findUnchangedValidationFailure(
        [run],
        new Map([["bun test tests/route-shell.test.ts", digest]]),
        process.cwd(),
      ),
    ).toEqual({
      command: run.command,
      digest,
    });
  });

  test("prioritizes browser validation repair guidance over lower-priority gate chatter", () => {
    const packet = buildBrowserValidationRepairPacket([
      {
        step: "bun run web:e2e",
        command: "bun run web:e2e",
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr:
          "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
        elapsedMs: 127_732,
      },
    ]);

    const hint = buildQualityRevisionHint(
      [
        "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).",
        "ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1.",
      ],
      {
        score: 7,
        findings: ["Generic code quality could be improved later."],
        mustFix: ["Rename helper for clarity."],
        revisionGuidance: "Polish naming.",
        raw: "{}",
      },
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        acceptanceCriteria: [],
        validationSteps: ["bun run web:e2e"],
        requiredValidationSteps: ["bun run web:e2e"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun run web:e2e",
          command: "bun run web:e2e",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Web end-to-end smoke test failed: Error: Browser validation failed during in-game UI stage: Expected help menu primary action to be visible within 30000ms: locator.waitFor: Timeout 30000ms exceeded.",
          elapsedMs: 127_732,
        },
      ],
      null,
      packet,
    );

    expect(hint).toContain("Primary ValidationGate repair objective:");
    expect(hint).toContain("Worker phase contract");
    expect(hint).toContain("Diagnostic artifact read requirement");
    expect(hint).toContain("- Failure type: browser assertion");
    expect(hint).toContain("- Stage: in-game UI");
    expect(hint).toContain("inspect the captured browser output/artifacts");
    expect(hint).toContain("If the expected text/role/test id is not present in the screenshot");
    expect(hint).toContain("prefer existing data-testid/accessibility labels/roles");
    expect(hint).toContain("Do not invent a combined phrase for split text");
    expect(hint).toContain("preserve stages that already passed");
    expect(hint).toContain("Do not change browser startup, port selection");
    expect(hint).toContain('PushPals ValidationGate will rerun "bun run web:e2e"');
    expect(hint).toContain("Executor sandbox rule:");
    expect(hint).toContain("treat that as a Codex executor verification limitation");
    expect(hint).toContain(
      "do not run the full browser command from the Codex executor by default",
    );
    expect(hint).toContain("fast non-browser checks");
    expect(hint).toContain("let ValidationGate perform the authoritative browser run");
    expect(hint).toContain("Suppressed 1 lower-priority ScopeGate/CriticGate note");
    expect(hint).toContain("CriticGate notes deferred");
    expect(hint).not.toContain("Critic score: 7.0 / 10");
    expect(hint).not.toContain("Rename helper for clarity.");
  });

  test("warns when a small repair drifts beyond the diff budget", () => {
    const hint = buildQualityRevisionHint(
      ["ScopeGate: review changed files carefully."],
      null,
      {
        intent: "code_change",
        riskLevel: "low",
        scope: { readAnywhere: true, writeAllowed: true, maxFilesToEdit: 2 },
        targetPaths: ["app/game.tsx"],
        acceptanceCriteria: ["game control stays visible"],
        validationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [],
      null,
      null,
      ["app/game.tsx", "components/GameControlPanel.tsx", "scripts/test-web-e2e.js"],
    );

    expect(hint).toContain("Diff budget warning");
    expect(hint).toContain("above the 2-file planning.scope.maxFilesToEdit");
    expect(hint).toContain("remove unrelated churn");
  });

  test("steers visual derivation work toward pure helper tests instead of full RN render harnesses", () => {
    const hint = buildQualityRevisionHint(
      ["ValidationGate: focused regression failed in test harness setup."],
      null,
      {
        intent: "code_change",
        riskLevel: "medium",
        scope: { readAnywhere: true, writeAllowed: true },
        targetPaths: ["app/game.tsx"],
        acceptanceCriteria: [
          "Improve battlefield readability with clearer planet rings and projectile threat cues",
        ],
        validationSteps: ["bun test app/__tests__/battlefieldReadability.test.ts"],
        requiredValidationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [
        {
          step: "bun test app/__tests__/battlefieldReadability.test.tsx",
          command: "bun test app/__tests__/battlefieldReadability.test.tsx",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr:
            "Cannot find module '../../tests/reactNativeMock' from components/__tests__/PlanetConquest.test.tsx",
          elapsedMs: 12_000,
        },
      ],
    );

    expect(hint).toContain("Test harness convergence warning");
    expect(hint).toContain("prefer pure helper/state/style-prop tests");
    expect(hint).toContain("Do not keep expanding broad shared mocks");
    expect(hint).toContain("Visual derivation testing rule");
    expect(hint).toContain("roughly 20 minutes");
  });

  test("warns when a small visual task starts changing broad shared mocks", () => {
    const hint = buildQualityRevisionHint(
      ["ScopeGate: review changed files carefully."],
      null,
      {
        intent: "code_change",
        riskLevel: "low",
        scope: { readAnywhere: true, writeAllowed: true },
        targetPaths: ["app/game.tsx"],
        acceptanceCriteria: ["Improve projectile readability"],
        validationSteps: ["bun test"],
        queuePriority: "normal",
        queueWaitBudgetMs: 90_000,
        executionBudgetMs: 1_800_000,
        finalizationBudgetMs: 120_000,
      },
      null,
      [],
      null,
      null,
      ["app/game.tsx", "tests/reactNativeMock.ts", "components/__tests__/PlanetConquest.test.tsx"],
    );

    expect(hint).toContain("Broad mock warning");
    expect(hint).toContain("tests/reactNativeMock.ts");
    expect(hint).toContain("prefer behavior-owned helper/state tests");
  });

  test("revises required validation repo blockers until the auto-revision budget is exhausted", () => {
    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(true);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 3,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
        outsideTaskScope: true,
      }),
    ).toBe(false);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun test exited 1"],
        blocker: { category: "repo", detail: "missing imported file" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
        outsideTaskScope: true,
        allowOutsideTaskScope: true,
      }),
    ).toBe(true);

    expect(
      shouldReviseRequiredValidationBlocker({
        requiredValidationFailures: ["bun run web:e2e exited 124"],
        blocker: { category: "environment", detail: "missing browser runtime" },
        revisionAttempt: 0,
        maxAutoRevisions: 3,
      }),
    ).toBe(false);
  });

  test("uses the ValidationGate retry budget for validation failures", () => {
    const policy = {
      maxAutoRevisions: 1,
      validationMaxAutoRevisions: 3,
    };

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: ["ValidationGate: executed validation commands, but none passed."],
        requiredValidationFailures: [],
        blocker: null,
      }),
    ).toBe(3);

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: [
          "ValidationGate: Required vision.md validation failed: bun run lint exited 1",
        ],
        requiredValidationFailures: ["bun run lint exited 1"],
        blocker: { category: "repo", detail: "missing repo dependency" },
      }),
    ).toBe(4);

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: ["ScopeGate: target_path outside component root"],
        requiredValidationFailures: [],
        blocker: null,
      }),
    ).toBe(1);
  });

  test("keeps browser validation convergence inside the configured validation retry budget", () => {
    const policy = {
      maxAutoRevisions: 1,
      validationMaxAutoRevisions: 3,
    };

    expect(
      revisionLimitForQualityGateFailures({
        policy,
        qualityIssues: [
          "ValidationGate: Required vision.md validation failed: bun run web:e2e exited 1",
        ],
        requiredValidationFailures: ["bun run web:e2e exited 1"],
        blocker: null,
        browserRepairPacket: {
          command: "bun run web:e2e",
          failureKind: "assertion",
          stage: "shell",
          selector: "getByTestId('home-screen')",
          expected: "home screen",
          failureFocus: "home shell",
          digest: "Browser validation failed during shell stage",
          previousDigest: null,
          previousStage: null,
          previousSelector: null,
          previousExpected: null,
          previousFailureFocus: null,
          progress: "first_failure",
          needsDiagnosticProbe: false,
          artifacts: [],
          output: "Web end-to-end smoke test failed",
        },
      }),
    ).toBe(3);
  });

  test("keeps the outer revision loop at the configured limit for non-browser work", () => {
    expect(
      qualityRevisionLoopUpperBound({
        maxAutoRevisions: 1,
        validationMaxAutoRevisions: 3,
      }),
    ).toBe(3);
  });

  test("does not extend the outer revision loop beyond validation retry budget for browser work", () => {
    expect(
      qualityRevisionLoopUpperBound(
        {
          maxAutoRevisions: 1,
          validationMaxAutoRevisions: 3,
        },
        { browserValidation: true },
      ),
    ).toBe(3);
  });

  test("downgrades assertion-balance failures when validation passed and critic score meets threshold", () => {
    const issues = relaxAdvisoryQualityIssues(
      [
        "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).",
        "Validation steps did not execute a recognizable test command.",
      ],
      [{ ok: false }, { ok: true }],
      {
        score: 8.8,
        findings: [],
        mustFix: [],
        revisionGuidance: "",
        raw: "{}",
      },
      8,
    );

    expect(issues).toEqual(["Validation steps did not execute a recognizable test command."]);
  });

  test("keeps assertion-balance failures blocking when validation did not pass or critic score is low", () => {
    const issue =
      "ScopeGate: found changed test files without both positive and negative assertion coverage (expected both).";

    expect(
      relaxAdvisoryQualityIssues(
        [issue],
        [{ ok: false }],
        {
          score: 8.8,
          findings: [],
          mustFix: [],
          revisionGuidance: "",
          raw: "{}",
        },
        8,
      ),
    ).toEqual([issue]);

    expect(
      relaxAdvisoryQualityIssues(
        [issue],
        [{ ok: true }],
        {
          score: 7.9,
          findings: [],
          mustFix: [],
          revisionGuidance: "",
          raw: "{}",
        },
        8,
      ),
    ).toEqual([issue]);
  });
});
