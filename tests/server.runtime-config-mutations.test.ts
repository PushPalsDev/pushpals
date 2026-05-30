import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyRuntimeConfigMutations,
  describeRuntimeConfigFiles,
  getRuntimeConfigFiles,
} from "../apps/server/src/runtime_config";
import type { PushPalsConfig } from "../packages/shared/src/config";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pushpals-runtime-config-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(projectRoot: string): PushPalsConfig {
  return {
    projectRoot,
    configDir: join(projectRoot, "configs"),
    profile: "dev",
    sessionId: "dev",
    authToken: null,
    gitToken: null,
    llm: {
      lmstudio: {
        contextWindow: 4096,
        minOutputTokens: 256,
        tokenSafetyMargin: 64,
        batchTailMessages: 3,
        batchChunkTokens: 0,
        batchMemoryChars: 0,
      },
    },
    paths: {
      dataDir: join(projectRoot, "outputs", "data"),
      sharedDbPath: join(projectRoot, "outputs", "data", "pushpals.db"),
      remotebuddyDbPath: join(projectRoot, "outputs", "data", "remotebuddy-state.db"),
    },
    server: {
      url: "http://localhost:3001",
      host: "0.0.0.0",
      port: 3001,
      debugHttp: false,
      staleClaimTtlMs: 120000,
      staleClaimSweepIntervalMs: 5000,
    },
    localbuddy: {
      enabled: false,
      port: 3003,
      statusHeartbeatMs: 120000,
      llm: {
        backend: "lmstudio",
        endpoint: "http://127.0.0.1:1234",
        model: "local-model",
        apiKey: "",
        sessionId: "localbuddy-dev",
        reasoningEffort: "high",
        codexAuthMode: "chatgpt",
        codexBin: "",
        codexTimeoutMs: 120000,
      },
    },
    remotebuddy: {
      pollMs: 2000,
      statusHeartbeatMs: 120000,
      workerpalOnlineTtlMs: 15000,
      waitForWorkerpalMs: 15000,
      autoSpawnWorkerpals: true,
      minWorkerpals: 1,
      maxWorkerpals: 20,
      workerpalStartupTimeoutMs: 10000,
      workerpalDocker: true,
      workerpalRequireDocker: true,
      workerpalImage: null,
      workerpalPollMs: 0,
      workerpalHeartbeatMs: 0,
      workerpalLabels: [],
      executionBudgetInteractiveMs: 600000,
      executionBudgetNormalMs: 1500000,
      executionBudgetBackgroundMs: 1800000,
      finalizationBudgetMs: 120000,
      crashRestartEnabled: true,
      crashRestartMaxRestarts: 3,
      crashRestartBackoffMs: 3000,
      memory: {
        enabled: true,
        includeCrossSession: true,
        maxRecallItems: 12,
        maxRecallChars: 2400,
        maxSummaryChars: 420,
        retentionDays: 30,
      },
      autonomy: {
        enabled: true,
        tickIntervalMs: 120000,
        heartbeatLogMs: 30000,
        visionContextMaxChars: 65536,
        ideationBudgetMs: 20000,
        llmTimeoutMs: 60000,
        allowDirtyWorktree: false,
        ideationMaxCandidates: 20,
        topK: 3,
        minConfidence: 0.65,
        maxConcurrentObjectives: 2,
        maxDispatchPerHour: 6,
        maxDispatchPerHourByType: {},
        cooldownFailStreakThreshold: 2,
        cooldownMs: 1800000,
        allowReadAnywhere: true,
        questionTtlMs: 259200000,
        policyVersion: "policy-v3.3",
        impactModelVersion: "impact-v1",
        replay: {
          storePromptPayloads: false,
          maxRunsWithPayloads: 50,
          maxPayloadBytes: 262144,
        },
      },
      llm: {
        backend: "lmstudio",
        endpoint: "http://127.0.0.1:1234",
        model: "local-model",
        apiKey: "",
        sessionId: "remotebuddy-dev",
        reasoningEffort: "high",
        codexAuthMode: "chatgpt",
        codexBin: "",
        codexTimeoutMs: 120000,
      },
    },
    workerpals: {
      pollMs: 2000,
      heartbeatMs: 5000,
      executor: "openai_codex",
      openhandsPython: "python",
      openhandsTimeoutMs: 1800000,
      miniswePython: "python",
      minisweTimeoutMs: 1800000,
      openaiCodexPython: "python",
      openaiCodexTimeoutMs: 7200000,
      openhandsStuckGuardEnabled: true,
      openhandsStuckGuardExploreLimit: 18,
      openhandsStuckGuardMinElapsedMs: 180000,
      openhandsStuckGuardBroadScanLimit: 2,
      openhandsStuckGuardNoProgressMaxMs: 300000,
      openhandsAutoSteerEnabled: true,
      openhandsAutoSteerInitialDelaySec: 90,
      openhandsAutoSteerIntervalSec: 60,
      openhandsAutoSteerMaxNudges: 30,
      requirePush: false,
      pushAgentBranch: false,
      requireDocker: false,
      skipDockerSelfCheck: false,
      dockerImage: "pushpals-worker-sandbox:latest",
      dockerTimeoutMs: 7260000,
      dockerIdleTimeoutMs: 600000,
      dockerAgentStartupTimeoutMs: 45000,
      dockerWarmMaxAttempts: 3,
      dockerWarmRetryBackoffMs: 2000,
      dockerJobMaxAttempts: 2,
      dockerJobRetryBackoffMs: 3000,
      dockerNetworkMode: "bridge",
      dockerWarmMemoryMb: 2048,
      dockerWarmCpus: 2,
      fileModifyingJobs: ["task.execute"],
      outputMaxChars: 196608,
      outputMaxLines: 600,
      outputMaxHeadLines: 120,
      qualityMaxAutoRevisions: 4,
      qualityValidationMaxAutoRevisions: 3,
      qualityScopeGateEnabled: true,
      qualityValidationGateEnabled: true,
      qualityCriticGateEnabled: true,
      qualityPublishGateEnabled: true,
      qualityValidationStepTimeoutMs: 180000,
      qualityCriticTimeoutMs: 90000,
      qualityCriticTimeoutBehavior: "retry_once",
      qualitySoftPassOnExhausted: true,
      qualityCriticMinScore: 8,
      qualityCriticModel: "",
      qualityCriticMaxDiffChars: 16000,
      qualityCriticMaxValidationOutputChars: 8000,
      executorResultPrefix: "__PUSHPALS_OH_RESULT__ ",
      baseRef: "origin/main_agents",
      labels: [],
      failureCooldownMs: 20000,
      llm: {
        backend: "lmstudio",
        endpoint: "http://127.0.0.1:1234",
        model: "local-model",
        apiKey: "",
        sessionId: "workerpals-dev",
        reasoningEffort: "high",
        codexAuthMode: "chatgpt",
        codexBin: "",
        codexTimeoutMs: 120000,
      },
    },
    sourceControlManager: {
      repoPath: ".worktrees/source_control_manager",
      remote: "origin",
      mainBranch: "main_agents",
      baseBranch: "main",
      branchPrefix: "agent/",
      pollIntervalSeconds: 10,
      checks: [],
      stateDir: "outputs/data/source_control_manager",
      port: 3002,
      deleteAfterMerge: false,
      maxAttempts: 3,
      mergeStrategy: "cherry-pick",
      pushMainAfterMerge: true,
      openPrAfterPush: true,
      prBaseBranch: "main",
      prTitle: null,
      prBody: null,
      prDraft: false,
      statusHeartbeatMs: 120000,
      skipCleanCheck: false,
      autoCreateMainBranch: false,
      reviewAgent: {
        enabled: true,
        pollIntervalMs: 60000,
        reviewerMdPath: "prompts/review_agent/reviewer.md",
        passThreshold: 8.1,
        maxPrCommentsBeforeGiveUp: 10,
        mergeMethod: "squash",
        codexBin: "bun x --yes @openai/codex",
        codexAuthMode: "chatgpt",
        codexHomeDir: "",
        codexTimeoutMs: 300000,
      },
    },
    startup: {
      workerImageRebuild: "auto",
      logConfigOnStart: true,
      syncIntegrationWithMain: true,
      skipLlmPreflight: false,
      autoStartLmStudio: true,
      lmStudioReadyTimeoutMs: 120000,
      lmStudioCli: "lms",
      lmStudioPort: 1234,
      lmStudioStartArgs: "",
      startupWarmup: true,
      startupWarmupTimeoutMs: 120000,
      startupWarmupPollMs: 1000,
      allowExternalClean: false,
      portPreflight: true,
      portConflictPolicy: "terminate_pushpals",
    },
    client: {
      localAgentUrl: "http://localhost:3003",
      traceTailLines: 100,
    },
  };
}

describe("server runtime config mutations", () => {
  test("updates .env file and process env at runtime", () => {
    const root = makeTempDir();
    const config = makeConfig(root);
    const files = getRuntimeConfigFiles(config);
    writeFileSync(files.envPath, "PUSHPALS_PROFILE=dev\nFOO=bar\n", "utf8");

    const prior = process.env.PUSHPALS_PROFILE;
    const result = applyRuntimeConfigMutations(files, [
      { scope: "env", key: "PUSHPALS_PROFILE", value: "prod" },
    ]);

    expect(result.applied).toHaveLength(1);
    expect(readFileSync(files.envPath, "utf8")).toContain("PUSHPALS_PROFILE=prod");
    expect(process.env.PUSHPALS_PROFILE).toBe("prod");

    if (prior === undefined) delete process.env.PUSHPALS_PROFILE;
    else process.env.PUSHPALS_PROFILE = prior;
  });

  test("updates existing TOML key using camelCase path normalization", () => {
    const root = makeTempDir();
    const config = makeConfig(root);
    const files = getRuntimeConfigFiles(config);
    mkdirSync(join(root, "configs"), { recursive: true });
    writeFileSync(
      files.localTomlPath,
      "[remotebuddy.autonomy]\ntick_interval_ms = 300000\n",
      "utf8",
    );

    applyRuntimeConfigMutations(files, [
      { scope: "toml", key: "remotebuddy.autonomy.tickIntervalMs", value: 120000 },
    ]);

    const text = readFileSync(files.localTomlPath, "utf8");
    expect(text).toContain("tick_interval_ms = 120000");
  });

  test("creates missing TOML section when key does not exist", () => {
    const root = makeTempDir();
    const config = makeConfig(root);
    const files = getRuntimeConfigFiles(config);
    mkdirSync(join(root, "configs"), { recursive: true });
    writeFileSync(files.localTomlPath, "", "utf8");

    applyRuntimeConfigMutations(files, [
      {
        scope: "toml",
        key: "workerpals.file_modifying_jobs",
        value: ["task.execute", "review.merge_conflict"],
      },
    ]);

    const text = readFileSync(files.localTomlPath, "utf8");
    expect(text).toContain("[workerpals]");
    expect(text).toContain('file_modifying_jobs = ["task.execute", "review.merge_conflict"]');
  });

  test("returns runtime config file paths as project-relative when possible", () => {
    const root = makeTempDir();
    const config = makeConfig(root);
    const files = describeRuntimeConfigFiles(getRuntimeConfigFiles(config));

    expect(files.envPath).toBe(".env");
    expect(files.localTomlPath).toBe("configs/local.toml");
  });
});
