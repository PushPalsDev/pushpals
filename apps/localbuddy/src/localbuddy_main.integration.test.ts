import { describe, expect, test } from "bun:test";
import { createLocalBuddyFetchHandler } from "./localbuddy_main";

class FakeComm {
  readonly assistantMessages: string[] = [];
  readonly userMessages: string[] = [];

  async assistantMessage(text: string): Promise<boolean> {
    this.assistantMessages.push(text);
    return true;
  }

  async userMessage(text: string): Promise<boolean> {
    this.userMessages.push(text);
    return true;
  }
}

async function readSseEvents(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const line = block.split("\n").find((entry) => entry.startsWith("data:"));
      const payload = line?.slice(5).trim();
      return payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
    });
}

function stubConsoleError() {
  type ConsoleArgs = Parameters<typeof console.error>;
  const calls: ConsoleArgs[] = [];
  const original = console.error;
  console.error = (...args: ConsoleArgs) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console.error = original;
    },
  };
}

function createHandler(options?: {
  answerLocally?: (prompt: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}) {
  const comm = new FakeComm();
  const fetchStub: typeof fetch =
    options?.fetchImpl ??
    (async () => {
      throw new Error("fetchImpl should be stubbed during tests");
    });
  const handler = createLocalBuddyFetchHandler({
    agentId: "agent-local-test",
    repo: "/repo",
    serverUrl: "http://remote.test",
    sessionId: "session-123",
    authToken: "token-xyz",
    comm,
    answerLocally: options?.answerLocally ?? (async () => "local-response"),
    fetchImpl: fetchStub,
  });
  return { handler, comm };
}

describe("LocalBuddy server routing", () => {
  test("rejects POST /message without text", async () => {
    const { handler } = createHandler();
    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, message: "text is required" });
  });

  test("responds to OPTIONS /message with CORS preflight headers", async () => {
    const { handler } = createHandler();

    const response = await handler(
      new Request("http://localhost/message", {
        method: "OPTIONS",
        headers: { Origin: "https://client.test" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "content-type, authorization",
    );
  });

  test("surfaces usage hint when /ask_remote_buddy lacks body", async () => {
    const { handler, comm } = createHandler({
      fetchImpl: async () => {
        throw new Error("should not enqueue when usage hint is returned");
      },
    });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "/ask_remote_buddy" }),
      }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    expect(events[0]).toEqual({ type: "status", message: "Command missing request body." });
    expect(events.at(-1)).toEqual({
      type: "complete",
      message: "Handled locally",
      data: { mode: "local_usage_hint", sessionId: "session-123" },
    });
    expect(comm.assistantMessages.some((msg) => msg.includes("Usage: /ask_remote_buddy"))).toBe(
      true,
    );
  });

  test("returns deterministic error for malformed JSON body", async () => {
    const { handler } = createHandler();
    const consoleErr = stubConsoleError();

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ not-valid-json }",
        }),
      );

      expect(response.status).toBe(500);
      const payload = (await response.json()) as { ok: boolean; message: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain("SyntaxError");
      const logged = consoleErr.calls.find((args) => args[0] === "[LocalBuddy] Error processing message:");
      expect(logged).toBeDefined();
      expect(String(logged?.[1])).toContain("SyntaxError");
    } finally {
      consoleErr.restore();
    }
  });

  test("answers locally for lightweight prompts", async () => {
    const localReply = "Local status is green.";
    const { handler, comm } = createHandler({
      answerLocally: async (prompt) => {
        expect(prompt).toBe("hello");
        return localReply;
      },
      fetchImpl: async () => {
        throw new Error("remote fetch should not be invoked for local replies");
      },
    });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    expect(events.at(-1)).toEqual({
      type: "complete",
      message: "Responded locally",
      data: { mode: "local", sessionId: "session-123" },
    });
    expect(comm.userMessages).toEqual(["hello"]);
    expect(comm.assistantMessages).toContain(localReply);
  });

  test("routes status lookup prompts locally without forcing remote queueing", async () => {
    const prompt = "Need WorkerPal job status update for job 12345678";
    const { handler, comm } = createHandler({
      answerLocally: async (incomingPrompt) => {
        expect(incomingPrompt).toBe(prompt);
        return "WorkerPal job 12345678 is claimed.";
      },
      fetchImpl: async () => {
        throw new Error("status lookups should not enqueue remotely");
      },
    });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      }),
    );

    const events = await readSseEvents(response);
    expect(events[0]).toEqual({ type: "status", message: "Generating LocalBuddy response..." });
    expect(events.at(-1)).toEqual({
      type: "complete",
      message: "Responded locally",
      data: { mode: "local", sessionId: "session-123" },
    });
    expect(comm.assistantMessages).toContain("WorkerPal job 12345678 is claimed.");
    expect(
      comm.assistantMessages.includes(
        "Received your request. I can answer this directly as LocalBuddy.",
      ),
    ).toBe(true);
  });

  test("queues remote requests when routed via /ask_remote_buddy", async () => {
    const remoteCalls: Array<{ url: string; body: any }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      remoteCalls.push({ url: String(url), body: bodyText ? JSON.parse(bodyText) : null });
      return new Response(
        JSON.stringify({
          ok: true,
          requestId: "req-abc123",
          queuePosition: 4,
          etaMs: 45_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const { handler, comm } = createHandler({
      answerLocally: async () => {
        throw new Error("should not answer locally for forced remote commands");
      },
      fetchImpl,
    });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "/ask_remote_buddy: fix the tests" }),
      }),
    );

    const events = await readSseEvents(response);
    expect(events.some((evt) => evt.type === "status")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "complete",
      message: "Request enqueued successfully",
      data: {
        requestId: "req-abc123",
        sessionId: "session-123",
        priority: "normal",
        queuePosition: 4,
        etaMs: 45_000,
      },
    });
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]?.url).toBe("http://remote.test/requests/enqueue");
    expect(remoteCalls[0]?.body).toMatchObject({
      prompt: "fix the tests",
      sessionId: "session-123",
      priority: "normal",
    });
    expect(remoteCalls[0]?.body?.queueWaitBudgetMs).toBeGreaterThan(0);
    expect(
      comm.assistantMessages.some(
        (msg) =>
          msg.includes("Request queued (req-abc1)") &&
          msg.includes("Priority normal") &&
          msg.includes("queue #4") &&
          msg.includes("ETA 45s"),
      ),
    ).toBe(true);
  });

  test("emits SSE status first and completes last for successful remote queueing", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          requestId: "req-ordered",
          queuePosition: 2,
          etaMs: 12_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const { handler } = createHandler({ fetchImpl });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Ship a full search feature in the API." }),
      }),
    );

    const events = await readSseEvents(response);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "status",
      message: "Enqueuing to Request Queue...",
    });
    expect(events[1]).toEqual({
      type: "complete",
      message: "Request enqueued successfully",
      data: {
        requestId: "req-ordered",
        sessionId: "session-123",
        priority: "normal",
        queuePosition: 2,
        etaMs: 12_000,
      },
    });
  });

  test("passes Authorization header through when authToken is configured", async () => {
    const headers: Headers[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      headers.push(new Headers(init?.headers ?? {}));
      return new Response(
        JSON.stringify({
          ok: true,
          requestId: "req-auth",
          queuePosition: 1,
          etaMs: 5_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const { handler } = createHandler({ fetchImpl });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "/ask_remote_buddy: tighten auth checks" }),
      }),
    );

    await readSseEvents(response);

    expect(headers).toHaveLength(1);
    expect(headers[0]?.get("Authorization")).toBe("Bearer token-xyz");
    expect(headers[0]?.get("Content-Type")).toBe("application/json");
  });

  test("surfaces remote enqueue failures to SSE clients", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("backend unavailable", { status: 502 });
    const { handler, comm } = createHandler({ fetchImpl });
    const consoleErr = stubConsoleError();

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "fix login bug" }),
        }),
      );

      const events = await readSseEvents(response);
      const errorEvent = events.find((evt) => evt.type === "error");
      expect(errorEvent).toEqual({
        type: "error",
        message: "Failed to enqueue: backend unavailable",
      });
      expect(
        comm.assistantMessages.includes(
          "Received your request. Queueing this to RemoteBuddy now.",
        ),
      ).toBe(true);
      expect(
        comm.assistantMessages.some((msg) => msg.startsWith("Request queued")),
      ).toBe(false);
      const logged = consoleErr.calls.find(
        (args) => args[0] === "[LocalBuddy] Failed to enqueue request: backend unavailable",
      );
      expect(logged).toBeDefined();
    } finally {
      consoleErr.restore();
    }
  });

  test("emits an SSE error when enqueue fetch rejects", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    const { handler, comm } = createHandler({ fetchImpl });
    const consoleErr = stubConsoleError();

    try {
      const response = await handler(
        new Request("http://localhost/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "fix flaky tests" }),
        }),
      );

      const events = await readSseEvents(response);
      expect(events[0]).toEqual({ type: "status", message: "Enqueuing to Request Queue..." });
      expect(events.some((evt) => evt.type === "complete")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "error", message: "Error: network down" });
      expect(
        comm.assistantMessages.some((msg) => msg.startsWith("Request queued")),
      ).toBe(false);
      const logged = consoleErr.calls.find((args) => args[0] === "[LocalBuddy] Error processing message:");
      expect(logged?.[1]).toBeInstanceOf(Error);
      expect((logged?.[1] as Error).message).toBe("network down");
    } finally {
      consoleErr.restore();
    }
  });

  test.each([
    {
      name: "interactive status query forced remote",
      text: "/ask_remote_buddy: what's the status of request 42?",
      expectedPrompt: "what's the status of request 42?",
      priority: "interactive",
      queueWaitBudgetMs: 20_000,
    },
    {
      name: "normal feature work",
      text: "Please update the login error messaging to be clearer",
      expectedPrompt: "Please update the login error messaging to be clearer",
      priority: "normal",
      queueWaitBudgetMs: 90_000,
    },
    {
      name: "background-scale architecture rewrite",
      text: "/ask_remote_buddy: comprehensive architecture rewrite plan covering all components",
      expectedPrompt: "comprehensive architecture rewrite plan covering all components",
      priority: "background",
      queueWaitBudgetMs: 240_000,
    },
  ])("queues remote payloads with derived priority for %s", async (scenario) => {
    const remoteBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      remoteBodies.push(parsed);
      return new Response(
        JSON.stringify({ ok: true, requestId: randomId(), queuePosition: 1, etaMs: 5_000 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const { handler } = createHandler({ fetchImpl });

    const response = await handler(
      new Request("http://localhost/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: scenario.text }),
      }),
    );

    await readSseEvents(response);
    expect(remoteBodies).toHaveLength(1);
    expect(remoteBodies[0]).toMatchObject({
      prompt: scenario.expectedPrompt,
      priority: scenario.priority,
      queueWaitBudgetMs: scenario.queueWaitBudgetMs,
    });
  });
});

describe("LocalBuddy handler metadata and routing regression coverage", () => {
  test("GET /healthz returns the configured agent metadata", async () => {
    const { handler } = createHandler();

    const response = await handler(new Request("http://localhost/healthz", { method: "GET" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      agentId: "agent-local-test",
      repo: "/repo",
      sessionId: "session-123",
    });
  });

  test("GET / returns service manifest with routes", async () => {
    const { handler } = createHandler();

    const response = await handler(new Request("http://localhost/", { method: "GET" }));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.name).toBe("PushPals LocalBuddy");
    expect(payload.endpoints).toMatchObject({
      "POST /message": expect.any(String),
      "GET /healthz": expect.any(String),
    });
  });

  test("rejects unsupported route or method combinations with 404 JSON response", async () => {
    const { handler } = createHandler();

    const methodMismatch = await handler(
      new Request("http://localhost/message", { method: "GET" }),
    );
    expect(methodMismatch.status).toBe(404);
    await expect(methodMismatch.json()).resolves.toEqual({ ok: false, message: "Not found" });

    const unknownPath = await handler(
      new Request("http://localhost/does-not-exist", { method: "POST" }),
    );
    expect(unknownPath.status).toBe(404);
    await expect(unknownPath.json()).resolves.toEqual({ ok: false, message: "Not found" });
  });
});

function randomId() {
  return `req-${Math.random().toString(16).slice(2)}`;
}
