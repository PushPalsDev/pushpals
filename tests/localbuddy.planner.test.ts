import { afterEach, describe, expect, test } from "bun:test";
import {
  LocalHeuristicPlanner,
  RemotePlanner,
} from "../apps/localbuddy/src/planner";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LocalHeuristicPlanner", () => {
  test("adds tasks for common repo operations", async () => {
    const planner = new LocalHeuristicPlanner();
    const { tasks } = await planner.plan({
      userText:
        "Please run the tests, lint the repo, diff the changes, search for matches, read the target file and then run a shell command.",
      history: [],
    });
    const titles = tasks.map((task) => task.title);
    expect(titles).toContain("Run tests");
    expect(titles).toContain("Run linter");
    expect(titles).toContain("Review changes");
    expect(titles).toContain("Search codebase");
    expect(titles).toContain("Read file");
    expect(titles).toContain("Run command");
  });

  test("covers repo-awareness heuristics", async () => {
    const planner = new LocalHeuristicPlanner();
    const { tasks } = await planner.plan({
      userText:
        "Show the commit history, list branches, print the file tree, check CI checks and give me a project overview.",
      history: [],
    });
    const titles = tasks.map((task) => task.title);
    expect(titles).toContain("View commit history");
    expect(titles).toContain("List branches");
    expect(titles).toContain("List files");
    expect(titles).toContain("Check CI status");
    expect(titles).toContain("Project summary");
  });

  test("falls back to analyze request when no heuristics match", async () => {
    const userText = "pondering wistful possibilities";
    const planner = new LocalHeuristicPlanner();
    const { tasks } = await planner.plan({
      userText,
      history: [],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Analyze request");
    expect(tasks[0].description).toContain(userText);
    expect(tasks[0].toolsNeeded).toEqual(["git.status", "project.summary"]);
  });
});

describe("RemotePlanner", () => {
  test("returns remote tasks when API responds with JSON content", async () => {
    const remoteTasks = {
      tasks: [
        {
          title: "Remote custom task",
          description: "LLM provided work",
          toolsNeeded: ["shell.exec"],
          confidence: 0.91,
        },
      ],
    };

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          message: { content: JSON.stringify(remoteTasks) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const planner = new RemotePlanner({ endpoint: "http://mock.local/plan" });
    const output = await planner.plan({ userText: "plan remotely", history: [] });
    expect(output.tasks).toEqual(remoteTasks.tasks);
  });

  test("falls back to local heuristics when HTTP request fails", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

    const planner = new RemotePlanner({ endpoint: "http://mock.local/plan" });
    const output = await planner.plan({ userText: "run the tests please", history: [] });
    const titles = output.tasks.map((task) => task.title);
    expect(titles).toContain("Run tests");
    expect(titles).not.toContain("Analyze request");
  });
});
