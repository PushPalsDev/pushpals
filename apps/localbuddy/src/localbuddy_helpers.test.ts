import { describe, expect, test } from "bun:test";
import {
  classifyRemoteRequestPriority,
  extractLocalReplyFromJsonLikeText,
  extractLocalReplyFromObject,
  fallbackLocalReply,
  formatEtaFromMs,
  isLikelyLocalOnlyPrompt,
  parseRemoteBuddyCommand,
  queueWaitBudgetForPriority,
  sanitizeLocalReply,
  summarizeFailureForPrompt,
  tryParseJsonObject,
} from "./localbuddy_helpers";

describe("request routing helpers", () => {
  test("parseRemoteBuddyCommand enforces explicit body and captures prompt", () => {
    const missingBody = parseRemoteBuddyCommand("/ask_remote_buddy");
    expect(missingBody.forceRemote).toBe(true);
    expect(missingBody.prompt).toBe("");
    expect(missingBody.usageMessage).toContain("Usage");

    const routed = parseRemoteBuddyCommand("/ask_remote_buddy: fix login bug");
    expect(routed.forceRemote).toBe(true);
    expect(routed.prompt).toBe("fix login bug");
    expect(routed.usageMessage).toBeUndefined();

    const casual = parseRemoteBuddyCommand("hello there");
    expect(casual.forceRemote).toBe(false);
    expect(casual.prompt).toBe("hello there");
  });

  test("isLikelyLocalOnlyPrompt distinguishes chit-chat from execution", () => {
    expect(isLikelyLocalOnlyPrompt("hey there")).toBe(true);
    expect(isLikelyLocalOnlyPrompt("status?")).toBe(true);
    expect(isLikelyLocalOnlyPrompt("fix the failing build in apps/server")).toBe(false);
    expect(isLikelyLocalOnlyPrompt("yes")).toBe(false);
  });

  test("classifyRemoteRequestPriority covers interactive/background cues", () => {
    expect(classifyRemoteRequestPriority("what's my status?")).toBe("interactive");
    expect(classifyRemoteRequestPriority("Give me a comprehensive architecture rewrite plan.")).toBe(
      "background",
    );
    expect(classifyRemoteRequestPriority("fix login form padding")).toBe("normal");
  });

  test("queueWaitBudgetForPriority maps to expected windows", () => {
    expect(queueWaitBudgetForPriority("interactive")).toBe(20_000);
    expect(queueWaitBudgetForPriority("normal")).toBe(90_000);
    expect(queueWaitBudgetForPriority("background")).toBe(240_000);
  });

  test("formatEtaFromMs humanizes durations", () => {
    expect(formatEtaFromMs(undefined)).toBe("now");
    expect(formatEtaFromMs(500)).toBe("500ms");
    expect(formatEtaFromMs(1_500)).toBe("2s");
    expect(formatEtaFromMs(75_000)).toBe("1m 15s");
    expect(formatEtaFromMs(120_000)).toBe("2m");
  });
});

describe("reply validation and sanitization", () => {
  test("tryParseJsonObject peels nested JSON strings", () => {
    const nested = tryParseJsonObject('" {\\"reply\\":\\"ok\\"} "');
    expect(nested).not.toBeNull();
    expect(nested?.reply).toBe("ok");

    const sliced = tryParseJsonObject('noise {"assistant_message": "ready"} trailer');
    expect(sliced).not.toBeNull();
    expect(sliced?.assistant_message).toBe("ready");
  });

  test("extractLocalReply helpers surface assistant message fields", () => {
    const reply = extractLocalReplyFromObject({ reply: "done" });
    expect(reply).toBe("done");

    const assistant = extractLocalReplyFromObject({ assistant_message: "roger" });
    expect(assistant).toBe("roger");

    const fromJsonText = extractLocalReplyFromJsonLikeText(
      '{"content":"All set"} and trailing text',
    );
    expect(fromJsonText).toBe("All set");
  });

  test("sanitizeLocalReply handles JSON wrappers and reasoning spillover", () => {
    const viaJson = sanitizeLocalReply('{"reply":"Handled"}', "status?");
    expect(viaJson).toBe("Handled");

    const reasoningFallback = sanitizeLocalReply("Here is my reasoning...", "hey");
    expect(reasoningFallback).toContain("I can answer lightweight questions");

    const jsonLike = sanitizeLocalReply('{"reply":["analysis"]}', "hello");
    expect(jsonLike).toContain("I can answer lightweight questions");
  });

  test("fallbackLocalReply adapts to greetings and status probes", () => {
    expect(fallbackLocalReply("hello")).toContain("Hello");
    expect(fallbackLocalReply("what's the status?")).toContain("online and ready");
    expect(fallbackLocalReply("anything else")).toContain("/ask_remote_buddy");
  });
});

describe("failure handling heuristics", () => {
  test("summarizeFailureForPrompt normalizes known categories", () => {
    expect(summarizeFailureForPrompt("context size has been exceeded")).toBe(
      "Prompt/context exceeded the model window.",
    );
    expect(summarizeFailureForPrompt("ECONNREFUSED at fetch")).toBe(
      "LLM endpoint connection error.",
    );
    expect(summarizeFailureForPrompt("Job timed out while waiting")).toBe("Worker job timed out.");
  });

  test("summarizeFailureForPrompt compresses long traces", () => {
    const longMsg = `Error: boom ${"stacktrace ".repeat(40)} at File.ts:10:5`;
    const summary = summarizeFailureForPrompt(longMsg);
    expect(summary.length).toBeLessThanOrEqual(220);
    expect(summary).toContain("Error: boom");
  });
});
