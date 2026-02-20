import { describe, expect, test } from "bun:test";

import {
  classifyRemoteRequestPriority,
  formatEtaFromMs,
  isLikelyLocalOnlyPrompt,
  parseRemoteBuddyCommand,
  parseStatusHeartbeatMs,
  queueWaitBudgetForPriority,
} from "../localbuddy_helpers";

describe("parseStatusHeartbeatMs", () => {
  test("clamps to sane bounds", () => {
    expect(parseStatusHeartbeatMs(Number.NaN)).toBe(120_000);
    expect(parseStatusHeartbeatMs(-10)).toBe(0);
    expect(parseStatusHeartbeatMs(0)).toBe(0);
    expect(parseStatusHeartbeatMs(15_000)).toBe(30_000);
    expect(parseStatusHeartbeatMs(90_000)).toBe(90_000);
  });
});

describe("parseRemoteBuddyCommand", () => {
  test("detects force remote command and strips prompt", () => {
    expect(
      parseRemoteBuddyCommand("/ask_remote_buddy please fix tests"),
    ).toEqual({ forceRemote: true, prompt: "please fix tests" });
  });

  test("returns usage message when missing prompt", () => {
    expect(parseRemoteBuddyCommand("/ask_remote_buddy")).toEqual({
      forceRemote: true,
      prompt: "",
      usageMessage:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    });
  });

  test("treats plain prompts as local context unless command prefix", () => {
    expect(parseRemoteBuddyCommand("what's up local buddy?")).toEqual({
      forceRemote: false,
      prompt: "what's up local buddy?",
    });
  });
});

describe("classifyRemoteRequestPriority", () => {
  test("recognizes status checks as interactive", () => {
    expect(classifyRemoteRequestPriority("/ask_remote_buddy status of my job")).toBe(
      "interactive",
    );
  });

  test("treats massive prompts and deep dives as background", () => {
    expect(
      classifyRemoteRequestPriority("/ask_remote_buddy comprehensive migration plan"),
    ).toBe("background");
  });

  test("defaults to normal priority for lightweight chat", () => {
    expect(classifyRemoteRequestPriority("hi there!")).toBe("normal");
  });
});

describe("queueWaitBudgetForPriority", () => {
  test("returns per-priority budgets", () => {
    expect(queueWaitBudgetForPriority("interactive")).toBe(20_000);
    expect(queueWaitBudgetForPriority("normal")).toBe(90_000);
    expect(queueWaitBudgetForPriority("background")).toBe(240_000);
  });
});

describe("formatEtaFromMs", () => {
  test("handles invalid or small values", () => {
    expect(formatEtaFromMs(undefined)).toBe("now");
    expect(formatEtaFromMs(-1)).toBe("now");
    expect(formatEtaFromMs(500)).toBe("500ms");
  });

  test("formats seconds and minutes", () => {
    expect(formatEtaFromMs(30_000)).toBe("30s");
    expect(formatEtaFromMs(75_000)).toBe("1m 15s");
    expect(formatEtaFromMs(2 * 60_000)).toBe("2m");
  });
});

describe("isLikelyLocalOnlyPrompt", () => {
  test("routes greetings locally and execution cues remotely", () => {
    expect(isLikelyLocalOnlyPrompt("hello localbuddy")).toBe(true);
    expect(isLikelyLocalOnlyPrompt("can you fix the failing build")).toBe(false);
  });

  test("sends affirmative approvals to RemoteBuddy but keeps neutral replies local", () => {
    expect(isLikelyLocalOnlyPrompt("yes")).toBe(false);
    expect(isLikelyLocalOnlyPrompt("thanks!")).toBe(true);
  });

  test("detects readonly queries as local while ignoring task requests", () => {
    expect(isLikelyLocalOnlyPrompt("git status please")).toBe(true);
    expect(isLikelyLocalOnlyPrompt("please fix the status page")).toBe(false);
  });

  test("keeps ambiguous short prompts local by default", () => {
    expect(isLikelyLocalOnlyPrompt("maybe later")).toBe(true);
    expect(isLikelyLocalOnlyPrompt("maybe later implement the fix")).toBe(false);
  });
});
