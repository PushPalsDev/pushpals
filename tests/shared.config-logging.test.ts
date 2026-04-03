import { describe, expect, test } from "bun:test";
import { sanitizePushPalsConfigForLogging } from "../packages/shared/src/config";

describe("shared config logging sanitization", () => {
  test("redacts sensitive key values while preserving non-sensitive config", () => {
    const input = {
      authToken: "ghp_abcdefghijklmnopqrstuvwxyz012345",
      gitToken: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      llm: {
        apiKey: "sk-supersecretopenaitoken0123456789",
        backend: "openai_codex",
        codexAuthMode: "chatgpt",
      },
      nested: {
        access_key: "abc123",
        normalValue: "keep-me",
      },
    };

    const sanitized = sanitizePushPalsConfigForLogging(input);

    expect(sanitized.authToken).toBe("[REDACTED]");
    expect(sanitized.gitToken).toBe("[REDACTED]");
    expect(sanitized.llm.apiKey).toBe("[REDACTED]");
    expect(sanitized.llm.backend).toBe("openai_codex");
    expect(sanitized.llm.codexAuthMode).toBe("chatgpt");
    expect(sanitized.nested.access_key).toBe("[REDACTED]");
    expect(sanitized.nested.normalValue).toBe("keep-me");
  });

  test("redacts embedded credentials and bearer tokens inside strings", () => {
    const input = {
      remoteUrl:
        "https://oauth2:ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/PushPalsDev/pushpals.git",
      authHeader: "Bearer sk-supersecretopenaitoken0123456789",
      plain: "https://github.com/PushPalsDev/pushpals.git",
    };

    const sanitized = sanitizePushPalsConfigForLogging(input);

    expect(sanitized.remoteUrl).toContain("https://***@github.com");
    expect(sanitized.remoteUrl).not.toContain("oauth2");
    expect(sanitized.authHeader).toBe("Bearer ***");
    expect(sanitized.plain).toBe("https://github.com/PushPalsDev/pushpals.git");
  });

  test("handles arrays recursively", () => {
    const input = {
      labels: ["ci", "worker"],
      endpoints: ["https://user:pass@example.com/path", "Bearer abcdefghijklmnopqrstuvwxyz123456"],
      tokens: ["abc", "def"],
    };

    const sanitized = sanitizePushPalsConfigForLogging(input);

    expect(sanitized.labels).toEqual(["ci", "worker"]);
    expect(sanitized.endpoints[0]).toBe("https://***@example.com/path");
    expect(sanitized.endpoints[1]).toBe("Bearer ***");
    expect(sanitized.tokens).toEqual(["[REDACTED]", "[REDACTED]"]);
  });
});
