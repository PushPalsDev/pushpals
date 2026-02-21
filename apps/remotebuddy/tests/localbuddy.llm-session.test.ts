import { describe, expect, test } from "bun:test";
import { createLLMClient } from "../src/llm";
import type {
  PushPalsConfig,
  PushPalsLlmConfig,
  PushPalsLmStudioConfig,
} from "../../../packages/shared/src/config";

describe("localbuddy LLM session dependencies", () => {
  test("deps.config takes precedence over deps.loadConfig", () => {
    const configModel = "localbuddy-config-model";
    const loaderModel = "localbuddy-loader-model";
    const client = createLLMClient(
      { service: "localbuddy" },
      {
        config: stubConfig({ localbuddy: { model: configModel } }),
        loadConfig: () => stubConfig({ localbuddy: { model: loaderModel } }),
      },
    );

    expect((client as any).model).toBe(configModel);
  });

  test("deps.loadConfig is skipped when deps.config is provided", () => {
    let loadCalls = 0;
    createLLMClient(
      { service: "localbuddy" },
      {
        config: stubConfig(),
        loadConfig: () => {
          loadCalls += 1;
          return stubConfig({ localbuddy: { model: "unused" } });
        },
      },
    );

    expect(loadCalls).toBe(0);
  });

  test("service session id overrides global session id", () => {
    const localbuddySession = "localbuddy-svc-session";
    const client = createLLMClient(
      { service: "localbuddy" },
      {
        config: stubConfig({
          globalSessionId: "global-session-x",
          localbuddy: { sessionId: localbuddySession },
        }),
      },
    );

    expect((client as any).sessionTag).toBe(`pushpals-localbuddy-${localbuddySession}`);
  });
});

interface StubConfigOverrides {
  globalSessionId?: string;
  localbuddy?: Partial<PushPalsLlmConfig>;
  remotebuddy?: Partial<PushPalsLlmConfig>;
  workerpals?: Partial<PushPalsLlmConfig>;
  lmstudio?: Partial<PushPalsLmStudioConfig>;
}

function stubConfig(overrides: StubConfigOverrides = {}): PushPalsConfig {
  const makeLlm = (
    sessionId: string,
    partial?: Partial<PushPalsLlmConfig>,
  ): PushPalsLlmConfig => ({
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    apiKey: "lmstudio",
    sessionId,
    reasoningEffort: "high",
    codexAuthMode: "auto",
    codexBin: "/tmp/codex",
    codexTimeoutMs: 120_000,
    ...partial,
  });

  const lmstudio: PushPalsLmStudioConfig = {
    contextWindow: 4096,
    minOutputTokens: 256,
    tokenSafetyMargin: 64,
    batchTailMessages: 3,
    batchChunkTokens: 0,
    batchMemoryChars: 0,
    ...overrides.lmstudio,
  };

  return {
    projectRoot: "/repo",
    configDir: "/repo/config",
    profile: "test",
    sessionId: overrides.globalSessionId ?? "global-session",
    authToken: null,
    gitToken: null,
    llm: { lmstudio },
    paths: {
      dataDir: "/tmp/data",
      sharedDbPath: "/tmp/shared.db",
      remotebuddyDbPath: "/tmp/remotebuddy.db",
    },
    server: {
      url: "http://localhost:3001",
      host: "0.0.0.0",
      port: 3001,
      debugHttp: false,
      staleClaimTtlMs: 1000,
      staleClaimSweepIntervalMs: 1000,
    },
    localbuddy: {
      port: 3003,
      statusHeartbeatMs: 1000,
      llm: makeLlm("localbuddy-session", overrides.localbuddy),
    },
    remotebuddy: {
      pollMs: 1000,
      statusHeartbeatMs: 1000,
      workerpalOnlineTtlMs: 1000,
      waitForWorkerpalMs: 1000,
      autoSpawnWorkerpals: false,
      maxWorkerpals: 1,
      workerpalStartupTimeoutMs: 1000,
      workerpalDocker: false,
      workerpalRequireDocker: false,
      workerpalImage: null,
      workerpalPollMs: null,
      workerpalHeartbeatMs: null,
      workerpalLabels: [],
      executionBudgetInteractiveMs: 1000,
      executionBudgetNormalMs: 1000,
      executionBudgetBackgroundMs: 1000,
      finalizationBudgetMs: 1000,
      memory: {
        enabled: false,
        includeCrossSession: false,
        maxRecallItems: 1,
        maxRecallChars: 1,
        maxSummaryChars: 1,
        retentionDays: 1,
      },
      autonomy: {
        enabled: false,
        tickIntervalMs: 1000,
        ideationBudgetMs: 1000,
        llmTimeoutMs: 1000,
        ideationMaxCandidates: 1,
        topK: 1,
        minConfidence: 0.5,
        maxConcurrentObjectives: 1,
        maxDispatchPerHour: 1,
        maxDispatchPerHourByType: {},
        cooldownFailStreakThreshold: 1,
        cooldownMs: 1000,
        allowReadAnywhere: false,
        questionTtlMs: 1000,
        policyVersion: "policy",
        impactModelVersion: "impact",
        replay: {
          storePromptPayloads: false,
          maxRunsWithPayloads: 1,
          maxPayloadBytes: 1024,
        },
      },
      llm: makeLlm("remotebuddy-session", overrides.remotebuddy),
    },
    workerpals: {
      pollMs: 1000,
      heartbeatMs: 1000,
      executor: "none",
      openhandsPython: "python",
      openhandsTimeoutMs: 1000,
      miniswePython: "python",
      minisweTimeoutMs: 1000,
      openaiCodexPython: "python",
      openaiCodexTimeoutMs: 1000,
      openhandsStuckGuardEnabled: false,
      openhandsStuckGuardExploreLimit: 1,
      openhandsStuckGuardMinElapsedMs: 1000,
      openhandsStuckGuardBroadScanLimit: 1,
      openhandsStuckGuardNoProgressMaxMs: 1000,
      openhandsAutoSteerEnabled: false,
      openhandsAutoSteerInitialDelaySec: 1,
      openhandsAutoSteerIntervalSec: 1,
      openhandsAutoSteerMaxNudges: 1,
      requirePush: false,
      pushAgentBranch: false,
      requireDocker: false,
      skipDockerSelfCheck: false,
      dockerImage: "worker",
      dockerTimeoutMs: 1000,
      dockerIdleTimeoutMs: 1000,
      dockerAgentStartupTimeoutMs: 1000,
      dockerWarmMaxAttempts: 1,
      dockerWarmRetryBackoffMs: 1,
      dockerJobMaxAttempts: 1,
      dockerJobRetryBackoffMs: 1,
      dockerNetworkMode: "bridge",
      dockerWarmMemoryMb: 1,
      dockerWarmCpus: 1,
      fileModifyingJobs: [],
      outputMaxChars: 1000,
      outputMaxLines: 100,
      outputMaxHeadLines: 10,
      qualityMaxAutoRevisions: 1,
      qualityValidationStepTimeoutMs: 1000,
      qualityCriticTimeoutMs: 1000,
      qualitySoftPassOnExhausted: false,
      qualityCriticMinScore: 1,
      qualityCriticMaxDiffChars: 1000,
      qualityCriticMaxValidationOutputChars: 1000,
      executorResultPrefix: "__",
      baseRef: "origin/main",
      labels: [],
      failureCooldownMs: 1000,
      llm: makeLlm("workerpals-session", overrides.workerpals),
    },
    sourceControlManager: {
      repoPath: "/repo",
      remote: "origin",
      mainBranch: "main",
      baseBranch: "main_agents",
      branchPrefix: "agent/",
      pollIntervalSeconds: 60,
      checks: [],
      stateDir: "/tmp/state",
      port: 4000,
      deleteAfterMerge: false,
      maxAttempts: 1,
      mergeStrategy: "no-ff",
      pushMainAfterMerge: false,
      openPrAfterPush: false,
      prBaseBranch: "main",
      prTitle: null,
      prBody: null,
      prDraft: false,
      statusHeartbeatMs: 1000,
      skipCleanCheck: true,
      autoCreateMainBranch: false,
      reviewAgent: {
        enabled: false,
        pollIntervalMs: 1000,
        reviewerMdPath: "",
        passThreshold: 10,
        mergeMethod: "squash",
        codexBin: "",
        codexAuthMode: "auto",
        codexHomeDir: "",
        codexTimeoutMs: 120_000,
      },
    },
    startup: {
      workerImageRebuild: false,
      syncIntegrationWithMain: false,
      skipLlmPreflight: true,
      autoStartLmStudio: false,
      lmStudioReadyTimeoutMs: 1_000,
      lmStudioCli: "",
      lmStudioPort: 1234,
      lmStudioStartArgs: [],
      startupWarmup: [],
      startupWarmupTimeoutMs: 1_000,
      startupWarmupPollMs: 1_000,
      allowExternalClean: false,
      portPreflight: [],
      portConflictPolicy: "ignore",
    },
    client: {
      localAgentUrl: "http://localhost:3003",
      traceTailLines: 100,
    },
  } satisfies PushPalsConfig;
}
