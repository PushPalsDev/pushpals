import { describe, expect, test } from "bun:test";
import {
  classifyRemoteRequestPriority,
  formatEtaFromMs,
  isLikelyLocalOnlyPrompt,
  parseRemoteBuddyCommand,
  parseStatusHeartbeatMs,
  queueWaitBudgetForPriority,
  sanitizeLocalReply,
  summarizeFailureForPrompt,
  tryParseJsonObject,
} from "./localbuddy_helpers";

const HELLO_FALLBACK =
  "Hello. I can answer lightweight questions directly, or route execution work with /ask_remote_buddy <request>.";

describe("parseStatusHeartbeatMs", () => {
  test("enforces sane bounds and defaults", () => {
    expect(parseStatusHeartbeatMs(45_000)).toBe(45_000);
    expect(parseStatusHeartbeatMs(10_000)).toBe(30_000);
    expect(parseStatusHeartbeatMs(-5)).toBe(0);
    expect(parseStatusHeartbeatMs(Number.NaN)).toBe(120_000);
  });
});

describe("summarizeFailureForPrompt", () => {
  test("maps known failure signatures to friendly text", () => {
    expect(summarizeFailureForPrompt("Context size has been exceeded"))
      .toBe("Prompt/context exceeded the model window.");
    expect(summarizeFailureForPrompt("ECONNREFUSED from llm"))
      .toBe("LLM endpoint connection error.");
    expect(summarizeFailureForPrompt("Job timed out after waiting"))
      .toBe("Worker job timed out.");
  });
});

describe("tryParseJsonObject", () => {
  test("parses direct json and nested json packed as string", () => {
    expect(tryParseJsonObject('{"reply":"hi"}')).toEqual({ reply: "hi" });
    expect(tryParseJsonObject('  "{\\"reply\\":\\"hello\\"}"  ')).toEqual({ reply: "hello" });
  });
});

describe("sanitizeLocalReply", () => {
  test("extracts reply field from fenced json", () => {
    const result = sanitizeLocalReply('```json\n{"reply":"All set"}\n```', "status?");
    expect(result).toBe("All set");
  });

  test("falls back when reasoning text leaks through", () => {
    const result = sanitizeLocalReply("Analysis: step-by-step plan", "hello");
    expect(result).toBe(HELLO_FALLBACK);
  });
});

describe("classifyRemoteRequestPriority", () => {
  test("detects interactive status requests", () => {
    expect(classifyRemoteRequestPriority("what's the status of my job"))
      .toBe("interactive");
  });

  test("treats comprehensive prompts as background", () => {
    expect(classifyRemoteRequestPriority("Comprehensive deep dive across all components"))
      .toBe("background");
  });

  test("defaults to normal otherwise", () => {
    expect(classifyRemoteRequestPriority("please add logs"))
      .toBe("normal");
  });
});

describe("queueWaitBudgetForPriority", () => {
  test("returns tuned wait budgets", () => {
    expect(queueWaitBudgetForPriority("interactive")).toBe(20_000);
    expect(queueWaitBudgetForPriority("background")).toBe(240_000);
    expect(queueWaitBudgetForPriority("normal")).toBe(90_000);
  });
});

describe("formatEtaFromMs", () => {
  test("formats ms, seconds, and minutes", () => {
    expect(formatEtaFromMs(500)).toBe("500ms");
    expect(formatEtaFromMs(15_000)).toBe("15s");
    expect(formatEtaFromMs(65_000)).toBe("1m 5s");
    expect(formatEtaFromMs(undefined)).toBe("now");
  });
});

describe("parseRemoteBuddyCommand", () => {
  test("detects forced routing commands", () => {
    expect(parseRemoteBuddyCommand("/ask_remote_buddy fix the tests")).toEqual({
      forceRemote: true,
      prompt: "fix the tests",
    });
  });

  test("returns usage hint when body missing", () => {
    const result = parseRemoteBuddyCommand("/ask_remote_buddy ");
    expect(result.forceRemote).toBe(true);
    expect(result.prompt).toBe("");
    expect(result.usageMessage).toContain("Usage: /ask_remote_buddy");
  });

  test("leaves non-command prompts untouched", () => {
    expect(parseRemoteBuddyCommand("hello there")).toEqual({
      forceRemote: false,
      prompt: "hello there",
    });
  });
});

describe("isLikelyLocalOnlyPrompt", () => {
  test("flags greetings but forwards execution cues", () => {
    expect(isLikelyLocalOnlyPrompt("hey buddy"))
      .toBe(true);
    expect(isLikelyLocalOnlyPrompt("can you fix the failing test"))
      .toBe(false);
    expect(isLikelyLocalOnlyPrompt("yes"))
      .toBe(false);
  });
});
