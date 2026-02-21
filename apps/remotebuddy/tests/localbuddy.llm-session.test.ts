import { afterEach, describe, expect, test } from "bun:test";
import { createLLMClient, LmStudioClient, setPushPalsConfigLoader } from "../src/llm";
import type { PushPalsConfig, PushPalsLlmConfig, PushPalsLmStudioConfig } from "shared";

type SessionCase = {
  label: string;
  serviceSessionId: string;
  globalSessionId?: string;
  expectedTag: string;
};

const DEFAULT_LMSTUDIO_LIMITS: PushPalsLmStudioConfig = {
  contextWindow: 4096,
  minOutputTokens: 256,
  tokenSafetyMargin: 64,
  batchTailMessages: 3,
  batchChunkTokens: 0,
  batchMemoryChars: 0,
};

function buildServiceLlm(sessionId: string): PushPalsLlmConfig {
  return {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "stub-model",
    apiKey: "lmstudio",
    sessionId,
    reasoningEffort: "",
    codexAuthMode: "",
    codexBin: "",
    codexTimeoutMs: 120_000,
  };
}

function stubConfig(serviceSessionId: string, globalSessionId = "global-session"): PushPalsConfig {
  const config = {
    sessionId: globalSessionId,
    llm: { lmstudio: DEFAULT_LMSTUDIO_LIMITS },
    localbuddy: { llm: buildServiceLlm(serviceSessionId) },
    remotebuddy: { llm: buildServiceLlm("remotebuddy-default") },
    workerpals: { llm: buildServiceLlm("workerpals-default") },
  } satisfies PushPalsConfig;
  return config;
}

const SESSION_CASES: SessionCase[] = [
  {
    label: "uses sanitized lowercase suffix for canonical ids",
    serviceSessionId: "DevSession42",
    expectedTag: "pushpals-localbuddy-devsession42",
  },
  {
    label: "falls back to default when session id empty",
    serviceSessionId: "",
    globalSessionId: "",
    expectedTag: "pushpals-localbuddy-default",
  },
  {
    label: "uses global session id when service session id is empty but global config has value",
    serviceSessionId: "",
    globalSessionId: "Global Session 3",
    expectedTag: "pushpals-localbuddy-global-session-3",
  },
  {
    label: "falls back to default when session id is whitespace",
    serviceSessionId: "   \n\t  ",
    globalSessionId: "",
    expectedTag: "pushpals-localbuddy-default",
  },
  {
    label: "strips punctuation and collapses separators",
    serviceSessionId: "Prod/US-West #Blue*Session!!",
    expectedTag: "pushpals-localbuddy-prod-us-west-blue-session",
  },
  {
    label: "truncates normalized suffix beyond 96 characters",
    serviceSessionId:
      "AlphaBetaGammaDeltaEpsilonZetaEtaThetaIotaKappaLambdaMuNuXiOmicronPiRhoSigmaTauUpsilonPhiChiPsiOmega-Run-2025",
    expectedTag:
      "pushpals-localbuddy-alphabetagammadeltaepsilonzetaetathetaiotakappalambdamunuxiomicronpirhosigmatauupsilonphichipsio",
  },
];

describe("LocalBuddy LLM session tags", () => {
  afterEach(() => {
    setPushPalsConfigLoader();
  });

  for (const { label, serviceSessionId, globalSessionId, expectedTag } of SESSION_CASES) {
    test(label, () => {
      setPushPalsConfigLoader(() => stubConfig(serviceSessionId, globalSessionId));
      const client = createLLMClient({ service: "localbuddy" });
      expect(client).toBeInstanceOf(LmStudioClient);
      expect((client as LmStudioClient).getSessionTag()).toBe(expectedTag);
    });
  }
});
