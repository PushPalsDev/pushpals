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
        lane: "openhands",
        target_paths: ["README.md"],
        validation_steps: ["none"],
        risk_level: "low",
        assistant_message: "Handled directly.",
        worker_instruction: "",
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
        target_paths: ["apps/server/src/jobs.ts"],
        validation_steps: ["bun test tests/server.jobs.stale-recovery.test.ts"],
        risk_level: "medium",
        assistant_message: "I will delegate to a WorkerPal.",
        worker_instruction: "Fix the queue migration issue.",
      }),
    ]);
    const brain = new AgentBrain(llm);

    const plan = await brain.think("fix one bug in jobs queue");

    expect(plan.requires_worker).toBe(true);
    expect(plan.job_kind).toBe("task.execute");
    expect(plan.lane).toBe("deterministic");
    expect(plan.target_paths).toEqual(["apps/server/src/jobs.ts"]);
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
        lane: "openhands",
        target_paths: [],
        validation_steps: [],
        risk_level: "high",
        assistant_message: "Delegating for deeper analysis.",
        worker_instruction: "",
      }),
    ]);
    const brain = new AgentBrain(llm);

    const plan = await brain.think(userText);

    expect(plan.requires_worker).toBe(true);
    expect(plan.worker_instruction).toBe(userText);
  });
});

