import { describe, expect, mock, test } from "bun:test";

mock.module("shared", () => {
  class MockCommunicationManager {
    status() {
      return Promise.resolve(true);
    }
    assistantMessage() {
      return Promise.resolve(true);
    }
    userMessage() {
      return Promise.resolve(true);
    }
    subscribeSessionEvents() {
      return () => {};
    }
  }

  return {
    CommunicationManager: MockCommunicationManager,
    detectRepoRoot: () => "/tmp/localbuddy",
    loadPushPalsConfig: () => ({
      server: { url: "http://localhost:3001" },
      localbuddy: { port: 3003, statusHeartbeatMs: 60_000 },
      sessionId: "test-session",
      authToken: null,
    }),
  };
});

mock.module("../../remotebuddy/src/llm.js", () => ({
  createLLMClient: () => ({
    generate: async () => ({ text: "ok" }),
  }),
}));

describe("localbuddy_main import safety", () => {
  test("does not start the server when imported", async () => {
    const originalServe = Bun.serve;
    const serveSpy = mock(() => {
      throw new Error("localbuddy_main should not call Bun.serve during import");
    });

    // @ts-expect-error – override Bun.serve for spy
    Bun.serve = serveSpy;

    try {
      await import("../localbuddy_main");
      expect(serveSpy).not.toHaveBeenCalled();
    } finally {
      // @ts-expect-error – restore native implementation
      Bun.serve = originalServe;
    }
  });
});
