import { describe, expect, mock, test } from "bun:test";

import { createLocalBuddyMessageHandler } from "../localbuddy_main";

const baseOptions = {
  serverUrl: "http://localhost:3001",
  sessionId: "test-session",
  authToken: "test-token",
};

describe("createLocalBuddyMessageHandler", () => {
  test("responds locally without hitting the queue", async () => {
    const userMessage = mock(async () => true);
    const assistantMessage = mock(async () => true);
    const answerLocally = mock(async () => "Local reply");
    const handler = createLocalBuddyMessageHandler({
      comm: { userMessage, assistantMessage },
      answerLocally,
      ...baseOptions,
    });

    const fetchSpy = mock(async () => {
      throw new Error("fetch should not be called for local replies");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "hello localbuddy" }),
        }),
      );

      const body = await response.text();
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(body).toContain("\"message\":\"Responded locally\"");
      expect(body).not.toContain("Request enqueued successfully");
      expect(answerLocally).toHaveBeenCalledTimes(1);
      expect(answerLocally).toHaveBeenCalledWith("hello localbuddy");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("enqueues remote /ask_remote_buddy requests with priority budget", async () => {
    const userMessage = mock(async () => true);
    const assistantMessage = mock(async () => true);
    const answerLocally = mock(async () => "Local reply should not run");
    const handler = createLocalBuddyMessageHandler({
      comm: { userMessage, assistantMessage },
      answerLocally,
      ...baseOptions,
    });

    const fetchSpy = mock(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          requestId: "req-12345",
          queuePosition: 4,
          etaMs: 15000,
        }),
        { status: 200 },
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "/ask_remote_buddy status of my job" }),
        }),
      );

      const body = await response.text();
      expect(body).toContain("\"message\":\"Request enqueued successfully\"");
      expect(body).toContain("\"priority\":\"interactive\"");
      expect(answerLocally).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:3001/requests/enqueue");
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        sessionId: "test-session",
        prompt: "status of my job",
        priority: "interactive",
      });
      expect(payload.queueWaitBudgetMs).toBe(20_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provides usage hint SSE when /ask_remote_buddy lacks a request body", async () => {
    const userMessage = mock(async () => true);
    const assistantMessage = mock(async () => true);
    const answerLocally = mock(async () => {
      throw new Error("should not run for usage guidance");
    });
    const handler = createLocalBuddyMessageHandler({
      comm: { userMessage, assistantMessage },
      answerLocally,
      ...baseOptions,
    });

    const fetchSpy = mock(async () => {
      throw new Error("fetch should not run for usage guidance");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "/ask_remote_buddy   " }),
        }),
      );

      const body = await response.text();
      expect(body).toContain("\"message\":\"Command missing request body.\"");
      expect(body).toContain("\"message\":\"Handled locally\"");
      expect(body).toContain("\"mode\":\"local_usage_hint\"");
      expect(body).not.toContain("Request enqueued successfully");
      expect(answerLocally).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      const assistantMessages = assistantMessage.mock.calls.map((call) => String(call[0]));
      expect(
        assistantMessages.some((msg) => msg.startsWith("Usage: /ask_remote_buddy")),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("emits SSE error when enqueue request fails", async () => {
    const userMessage = mock(async () => true);
    const assistantMessage = mock(async () => true);
    const answerLocally = mock(async () => "Local reply should not run");
    const handler = createLocalBuddyMessageHandler({
      comm: { userMessage, assistantMessage },
      answerLocally,
      ...baseOptions,
    });

    const fetchSpy = mock(async () => new Response("Queue offline", { status: 500 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "/ask_remote_buddy check my status" }),
        }),
      );

      const body = await response.text();
      expect(body).toContain("\"message\":\"Failed to enqueue: Queue offline\"");
      expect(body).toContain("\"type\":\"error\"");
      expect(body).not.toContain("Request enqueued successfully");
      expect(assistantMessage).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("emits error event when local reply generation fails", async () => {
    const userMessage = mock(async () => true);
    const assistantMessage = mock(async () => true);
    const answerLocally = mock(async () => {
      throw new Error("Local LLM failure");
    });
    const handler = createLocalBuddyMessageHandler({
      comm: { userMessage, assistantMessage },
      answerLocally,
      ...baseOptions,
    });

    const fetchSpy = mock(async () => {
      throw new Error("fetch should not run for local replies");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        }),
      );

      const body = await response.text();
      expect(body).toContain("\"message\":\"Generating LocalBuddy response...\"");
      expect(body).toContain("\"message\":\"Error: Local LLM failure\"");
      expect(body).toContain("\"type\":\"error\"");
      expect(body).not.toContain("Responded locally");
      expect(answerLocally).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(assistantMessage).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
