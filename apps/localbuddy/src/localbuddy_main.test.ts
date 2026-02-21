import { describe, expect, test } from "bun:test";
import {
  classifyRemoteRequestPriority,
  parseRemoteBuddyCommand,
  parseStatusHeartbeatMs,
  queueWaitBudgetForPriority,
  summarizeFailureForPrompt,
} from "./localbuddy_utils";

describe("parseStatusHeartbeatMs", () => {
  test("returns default heartbeat when input is NaN", () => {
    expect(parseStatusHeartbeatMs(Number.NaN)).toBe(120_000);
  });

  test("clamps small positive values to the 30s heartbeat floor", () => {
    expect(parseStatusHeartbeatMs(15_000)).toBe(30_000);
  });

  test("allows larger values after flooring and respects zero for non-positive", () => {
    expect(parseStatusHeartbeatMs(50_550.5)).toBe(50_550);
    expect(parseStatusHeartbeatMs(0)).toBe(0);
    expect(parseStatusHeartbeatMs(-45)).toBe(0);
  });
});

describe("summarizeFailureForPrompt", () => {
  test("detects context window errors", () => {
    const summary = summarizeFailureForPrompt("Context size has been exceeded again");
    expect(summary).toBe("Prompt/context exceeded the model window.");
  });

  test("detects connection failures", () => {
    const summary = summarizeFailureForPrompt("ECONNREFUSED connecting to localhost");
    expect(summary).toBe("LLM endpoint connection error.");
  });

  test("detects timeout failures", () => {
    const summary = summarizeFailureForPrompt("Worker job timed out after 30s");
    expect(summary).toBe("Worker job timed out.");
  });

  test("detects non-JSON structured output errors", () => {
    const summary = summarizeFailureForPrompt(
      "Generation failed: response did not contain parseable JSON payload",
    );
    expect(summary).toBe(
      "Model returned non-JSON output when structured output was expected.",
    );
  });

  test("strips stack traces and truncates long text", () => {
    const verbose =
      "Error: Explosion!\nStack trace:\n at module.js:12:5\n at other.js:1:1\n" +
      " ".repeat(30) +
      "tail";
    expect(summarizeFailureForPrompt(verbose)).toBe("Error: Explosion!");
  });
});

describe("parseRemoteBuddyCommand", () => {
  test("respects /ask_remote_buddy command regardless of casing", () => {
    const result = parseRemoteBuddyCommand("/ASK_REMOTE_BUDDY build the thing");
    expect(result).toEqual({
      forceRemote: true,
      prompt: "build the thing",
      usageMessage: undefined,
    });
  });

  test("accepts colon-delimited command bodies", () => {
    const result = parseRemoteBuddyCommand("/ask_remote_buddy: status update, please");
    expect(result).toEqual({
      forceRemote: true,
      prompt: "status update, please",
      usageMessage: undefined,
    });
  });

  test("accepts dash-delimited command bodies", () => {
    const result = parseRemoteBuddyCommand("/ask_remote_buddy - investigate prod issue");
    expect(result).toEqual({
      forceRemote: true,
      prompt: "investigate prod issue",
      usageMessage: undefined,
    });
  });

  test("provides usage hint when command body missing", () => {
    const result = parseRemoteBuddyCommand("/ask_remote_buddy");
    expect(result.forceRemote).toBe(true);
    expect(result.prompt).toBe("");
    expect(result.usageMessage).toContain("Usage");
  });

  test("provides usage hint when command body is whitespace only", () => {
    const result = parseRemoteBuddyCommand("/ask_remote_buddy    \t\n");
    expect(result.forceRemote).toBe(true);
    expect(result.prompt).toBe("");
    expect(result.usageMessage).toContain("Usage");
  });

  test("leaves other prompts untouched", () => {
    const result = parseRemoteBuddyCommand("hello world");
    expect(result).toEqual({
      forceRemote: false,
      prompt: "hello world",
      usageMessage: undefined,
    });
  });
});

describe("classifyRemoteRequestPriority", () => {
  test("flags status-oriented prompts as interactive", () => {
    expect(classifyRemoteRequestPriority("What's my status right now?")).toBe("interactive");
  });

  test("identifies background-scale work by keywords and length", () => {
    expect(
      classifyRemoteRequestPriority(
        "Deep dive architecture refactor touching everything in the repo",
      ),
    ).toBe("background");
    expect(classifyRemoteRequestPriority("x".repeat(1500))).toBe("background");
  });

  test("treats 1200-char requests as normal but 1201-char requests as background", () => {
    expect(classifyRemoteRequestPriority("x".repeat(1200))).toBe("normal");
    expect(classifyRemoteRequestPriority("x".repeat(1201))).toBe("background");
  });

  test("defaults to normal when no signals present", () => {
    expect(classifyRemoteRequestPriority("Please update the docs later")).toBe("normal");
  });
});

describe("integration: remote routing helpers", () => {
  test("routes forced remote status requests as interactive with short budget", () => {
    const routing = parseRemoteBuddyCommand("/ask_remote_buddy: What's my status?");
    expect(routing).toEqual({
      forceRemote: true,
      prompt: "What's my status?",
      usageMessage: undefined,
    });

    const priority = classifyRemoteRequestPriority(routing.prompt);
    expect(priority).toBe("interactive");

    const budget = queueWaitBudgetForPriority(priority);
    expect(budget).toBe(20_000);
  });
});

describe("queueWaitBudgetForPriority", () => {
  test("returns appropriate queue wait budgets", () => {
    expect(queueWaitBudgetForPriority("interactive")).toBe(20_000);
    expect(queueWaitBudgetForPriority("normal")).toBe(90_000);
    expect(queueWaitBudgetForPriority("background")).toBe(240_000);
  });
});
