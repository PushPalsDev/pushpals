import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { resolveVisionDocPath } from "shared";
import type { CommunicationManager, PushPalsConfig } from "shared";
import { RemoteBuddyAutonomousEngine } from "../apps/remotebuddy/src/autonomous_engine";
import type { LLMClient } from "../apps/remotebuddy/src/llm";

const dummyLLM: LLMClient = {
  async generate() {
    return { text: "" };
  },
};

function buildTestConfig(repoRoot: string): PushPalsConfig {
  return {
    remotebuddy: {
      autonomy: {
        enabled: true,
        tickIntervalMs: 1_000,
        heartbeatLogMs: 5_000,
        ideationBudgetMs: 5_000,
        llmTimeoutMs: 5_000,
        allowDirtyWorktree: true,
        ideationMaxCandidates: 5,
        topK: 3,
        minConfidence: 0.25,
        maxConcurrentObjectives: 1,
        maxDispatchPerHour: 1,
        maxDispatchPerHourByType: {},
        cooldownFailStreakThreshold: 1,
      cooldownMs: 5_000,
      allowReadAnywhere: false,
      questionTtlMs: 60_000,
      policyVersion: "test",
      impactModelVersion: "test",
      visionDocPath: "vision.md",
      replay: { storePromptPayloads: false, maxRunsWithPayloads: 0, maxPayloadBytes: 0 },
    },
    },
    sourceControlManager: {
      remote: "origin",
      mainBranch: "main",
      baseBranch: "main",
    },
  } as unknown as PushPalsConfig;
}

describe("RemoteBuddy autonomy vision refresh", () => {
  test("loadVisionContext picks up updated vision.md content without caching", () => {
    const tempDir = mkdtempSync(join(process.cwd(), "vision-autonomy-"));
    try {
      const visionPath = join(tempDir, "vision.md");
      const initialDoc = [
        "# Vision",
        "> **One sentence:** Align every repo with the PushPals mission.",
        "",
        "## 1) Who this is for",
        "Builders.",
      "",
      "## 2) The problem we solve",
      "Their blockers.",
    ].join("\n");
    writeFileSync(visionPath, initialDoc, "utf8");

      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "test-session",
        authToken: null,
        repo: process.cwd(),
        llm: dummyLLM,
        comm: {} as CommunicationManager,
        config: buildTestConfig(process.cwd()),
        visionDocPath: visionPath,
      });

      const first = (engine as any).loadVisionContext("run_1");
      expect(first?.one_sentence).toContain("PushPals mission");

      const updatedDoc = [
        "# Vision",
        "> **One sentence:** Updated direction for PushPals.",
        "",
        "## 1) Who this is for",
        "Operators.",
      "",
      "## 2) The problem we solve",
      "New blockers appear.",
    ].join("\n");
    writeFileSync(visionPath, updatedDoc, "utf8");

      const second = (engine as any).loadVisionContext("run_2");
      expect(second?.one_sentence).toContain("Updated direction");
      expect(second?.sha256).not.toBe(first?.sha256);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("custom vision path preflight matches runtime loader", () => {
    const tempDir = mkdtempSync(join(process.cwd(), "vision-custom-path-"));
    try {
      const customVisionPath = join(tempDir, "custom-vision.md");
      const customDoc = [
        "# Custom Vision",
        "> **One sentence:** Custom path support.",
        "",
        "## 1) Who this is for",
        "Runtime alignment testers.",
        "",
        "## 2) The problem we solve",
        "Ensuring consistent path resolution.",
      ].join("\n");
      writeFileSync(customVisionPath, customDoc, "utf8");

      const relativeConfigPath = relative(process.cwd(), customVisionPath).replace(/\\/g, "/");
      const config = buildTestConfig(process.cwd());
      config.remotebuddy.autonomy.visionDocPath = relativeConfigPath;

      const engine = new RemoteBuddyAutonomousEngine({
        server: "http://localhost:3001",
        sessionId: "custom-session",
        authToken: null,
        repo: process.cwd(),
        llm: dummyLLM,
        comm: {} as CommunicationManager,
        config,
      });

      const runtimeVisionPath = (engine as any).visionDocPath;
      const preflightVisionPath = resolveVisionDocPath(relativeConfigPath);

      expect(runtimeVisionPath).toBe(preflightVisionPath);

      const context = (engine as any).loadVisionContext("custom_run");
      expect(context?.path).toBe(preflightVisionPath);
      expect(context?.one_sentence).toContain("Custom path support");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
