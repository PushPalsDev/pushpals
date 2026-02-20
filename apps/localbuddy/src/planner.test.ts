import { describe, expect, it, mock } from "bun:test";

mock.module("shared", () => ({
  loadPushPalsConfig: () => ({
    localbuddy: {
      llm: {
        backend: "ollama",
        endpoint: "http://localhost:11434",
        model: "stub-model",
        apiKey: null,
      },
    },
  }),
  loadPromptTemplate: () => "stub-template",
}));

const { LocalHeuristicPlanner } = await import("./planner");

describe("LocalHeuristicPlanner heuristics", () => {
  it("adds concrete tasks for execution-focused prompts", async () => {
    const planner = new LocalHeuristicPlanner();
    const plan = await planner.plan({
      userText:
        "Before we land this patch, run the tests, review the diff, search the repo, and read the helper file.",
      history: [],
    });

    expect(plan.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Run tests",
          description: expect.stringContaining("Execute the test suite"),
          toolsNeeded: ["bun.test"],
        }),
        expect.objectContaining({
          title: "Review changes",
          toolsNeeded: ["git.diff", "git.status"],
        }),
        expect.objectContaining({
          title: "Search codebase",
          toolsNeeded: ["file.search"],
        }),
        expect.objectContaining({
          title: "Read file",
          toolsNeeded: ["file.read"],
        }),
      ]),
    );
  });

  it("surfaces repo-awareness tasks when status cues appear", async () => {
    const planner = new LocalHeuristicPlanner();
    const plan = await planner.plan({
      userText: "Give me a project status report, list active branches, and check CI health.",
      history: [],
    });

    expect(plan.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Project summary",
          confidence: 0.9,
        }),
        expect.objectContaining({
          title: "List branches",
          confidence: 0.8,
        }),
        expect.objectContaining({
          title: "Check CI status",
          confidence: 0.8,
        }),
      ]),
    );
  });

  it("falls back to analyzing the request when no heuristics match", async () => {
    const planner = new LocalHeuristicPlanner();
    const plan = await planner.plan({
      userText: "Howdy?",
      history: [],
    });

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      title: "Analyze request",
      description: 'Understand user request: "Howdy?"',
      toolsNeeded: ["git.status", "project.summary"],
      confidence: 0.4,
    });
  });
});
