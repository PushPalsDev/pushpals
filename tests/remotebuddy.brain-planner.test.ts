import { describe, expect, test } from "bun:test";
import { AgentBrain } from "../apps/remotebuddy/src/brain";
import type { LLMClient, LLMGenerateInput, LLMGenerateOutput } from "../apps/remotebuddy/src/llm";

class MockLLMClient implements LLMClient {
  calls: LLMGenerateInput[] = [];
  private readonly outputs: string[];

  constructor(outputs: string[]) {
    this.outputs = [...outputs];
  }

  async generate(input: LLMGenerateInput): Promise<LLMGenerateOutput> {
    this.calls.push(input);
    const text = this.outputs.shift() ?? "{}";
    return {
      text,
      usage: { promptTokens: 10, completionTokens: 10 },
    };
  }
}

describe("RemoteBuddy AgentBrain planner", () => {
  test("normalizes no-worker plans to deterministic lane", async () => {
    const llm = new MockLLMClient([
      JSON.stringify({
        intent: "chat",
        requires_worker: false,
        job_kind: "none",
        lane: "worker",
        scope: {
          read_anywhere: true,
          write_allowed: false,
        },
        discovery: {
          ripgrep_queries: [],
        },
        acceptance_criteria: [],
        validation_steps: [],
        risk_level: "low",
        assistant_message: "Handled directly.",
        worker_instruction: "",
        user_message: "hello",
      }),
    ]);
    const brain = new AgentBrain(llm);

    const plan = await brain.think("hello");

    expect(plan.requires_worker).toBe(false);
    expect(plan.job_kind).toBe("none");
    expect(plan.lane).toBe("deterministic");
    expect(plan.assistant_message).toContain("Handled directly");
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]?.json).toBe(true);
  });

  test("repairs invalid primary planner output", async () => {
    const llm = new MockLLMClient([
      "not valid json",
      JSON.stringify({
        intent: "code_change",
        requires_worker: true,
        job_kind: "task.execute",
        lane: "deterministic",
        scope: {
          read_anywhere: true,
          write_allowed: true,
          write_globs: ["apps/server/src/jobs.ts"],
        },
        discovery: {
          ripgrep_queries: ["jobs stale"],
          likely_dirs: ["apps/server/src"],
        },
        acceptance_criteria: ["Queue migration path is fixed with no regressions."],
        validation_steps: ["bun test tests/server.jobs.stale-recovery.test.ts"],
        risk_level: "medium",
        assistant_message: "I will delegate to a WorkerPal.",
        worker_instruction: "Fix the queue migration issue.",
        user_message: "fix one bug in jobs queue",
      }),
    ]);
    const brain = new AgentBrain(llm);

    const plan = await brain.think("fix one bug in jobs queue");

    expect(plan.requires_worker).toBe(true);
    expect(plan.job_kind).toBe("task.execute");
    expect(plan.lane).toBe("deterministic");
    expect(plan.scope.write_globs).toEqual(["apps/server/src/jobs.ts"]);
    expect(plan.acceptance_criteria.length).toBeGreaterThan(0);
    expect(llm.calls.length).toBe(2);
    expect(llm.calls[1]?.messages?.[0]?.content).toContain("Invalid planner output to repair");
  });

  test("falls back worker_instruction to user text when missing", async () => {
    const userText = "please inspect the queue and apply a minimal fix";
    const llm = new MockLLMClient([
      JSON.stringify({
        intent: "analysis",
        requires_worker: true,
        job_kind: "task.execute",
        lane: "worker",
        scope: {
          read_anywhere: true,
          write_allowed: true,
          write_globs: ["apps/workerpals/src/context_manager.ts"],
        },
        discovery: {
          ripgrep_queries: ["context manager"],
          likely_dirs: ["apps/workerpals/src"],
        },
        acceptance_criteria: ["A minimal fix is applied without unrelated refactors."],
        validation_steps: ["bun test tests/workerpals.context-manager.test.ts"],
        risk_level: "high",
        assistant_message: "Delegating for deeper analysis.",
        worker_instruction: "",
        user_message: userText,
      }),
    ]);
    const brain = new AgentBrain(llm);

    const plan = await brain.think(userText);

    expect(plan.requires_worker).toBe(true);
    expect(plan.worker_instruction).toBe(userText);
  });
});
