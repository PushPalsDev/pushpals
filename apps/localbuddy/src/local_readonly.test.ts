import { afterEach, describe, expect, it } from "bun:test";
import {
  answerLocalReadonlyQuery,
  isLocalReadonlyQueryPrompt,
  isSystemStatusPrompt,
  type LocalReadonlyContext,
} from "./local_readonly";

const originalFetch = globalThis.fetch;

const BASE_CONTEXT: LocalReadonlyContext = {
  repoRoot: "/repo/path",
  serverUrl: "https://example.local",
  authHeaders: { Authorization: "Bearer token" },
};

describe("local readonly prompt detection", () => {
  it("flags system/worker status questions as readonly queries", () => {
    expect(isSystemStatusPrompt("Can you check worker status?")).toBe(true);
    expect(isLocalReadonlyQueryPrompt("Need the job queue status snapshot")).toBe(true);
  });

  it("ignores unrelated chat prompts", () => {
    expect(isSystemStatusPrompt("Hello what's next?")).toBe(false);
    expect(isLocalReadonlyQueryPrompt("review the feature spec")).toBe(false);
  });
});

describe("answerLocalReadonlyQuery for system status", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("summarizes worker and queue counts from the API payload", async () => {
    const payload = {
      ok: true,
      workers: { total: 5, online: 3, busy: 2, idle: 1 },
      queues: {
        requests: { pending: 1, claimed: 2, completed: 3, failed: 0 },
        jobs: { pending: 4, claimed: 1, completed: 2, failed: 0 },
        completions: { pending: 0, claimed: 1, processed: 5, failed: 1 },
      },
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const reply = await answerLocalReadonlyQuery("check worker status", BASE_CONTEXT);

    expect(reply).toBeTruthy();
    expect(reply).toContain("System status: workers online 3/5 (busy 2, idle 1).");
    expect(reply).toContain("Requests p/c/d/f: 1/2/3/0.");
    expect(reply).toContain("Jobs p/c/d/f: 4/1/2/0.");
    expect(reply).toContain("Completions p/c/pr/f: 0/1/5/1.");
  });

  it("surfaces API failures when the payload is not usable", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, message: "db unreachable" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const reply = await answerLocalReadonlyQuery("check the system status", BASE_CONTEXT);

    expect(reply).toBe(
      "I couldn't check system/database status right now (db unreachable).",
    );
  });
});
