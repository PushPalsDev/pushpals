#!/usr/bin/env bun
/**
 * PushPals LocalBuddy - HTTP Server
 *
 * Usage:
 *   bun run localbuddy --server http://localhost:3001 [--port 3003] [--sessionId <id>]
 *
 * Accepts messages from clients via HTTP.
 * - Lightweight chat can be answered directly by LocalBuddy.
 * - Requests can be explicitly routed to RemoteBuddy via `/ask_remote_buddy ...`.
 * - Routed requests are enhanced with LLM + repo context, then enqueued.
 */

import { randomUUID } from "crypto";
import { CommunicationManager, detectRepoRoot, getRepoContext, loadPromptTemplate } from "shared";
import { createLLMClient, type LLMClient } from "../../remotebuddy/src/llm.js";

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(): {
  server: string;
  port: number;
  sessionId: string;
  authToken: string | null;
} {
  const args = process.argv.slice(2);
  let server = "http://localhost:3001";
  let port = parseInt(process.env.LOCAL_AGENT_PORT ?? "3003", 10);
  let sessionId = process.env.PUSHPALS_SESSION_ID ?? "dev";
  let authToken = process.env.PUSHPALS_AUTH_TOKEN ?? null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--port":
        port = parseInt(args[++i], 10);
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
    }
  }

  return { server, port, sessionId, authToken };
}

function parseStatusHeartbeatMs(serviceEnvName: string, fallbackMs: number): number {
  const raw = (
    process.env[serviceEnvName] ??
    process.env.PUSHPALS_STATUS_HEARTBEAT_MS ??
    ""
  ).trim();
  if (!raw) return fallbackMs;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallbackMs;
  if (parsed <= 0) return 0;
  return Math.max(30_000, parsed);
}

function summarizeFailureForPrompt(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const lowered = text.toLowerCase();
  if (
    lowered.includes("cannot truncate prompt with n_keep") ||
    lowered.includes("context size has been exceeded") ||
    (lowered.includes("prompt exceeded") && lowered.includes("context"))
  ) {
    return "Prompt/context exceeded the model window.";
  }
  if (
    lowered.includes("connection refused") ||
    lowered.includes("connection error") ||
    lowered.includes("econnrefused")
  ) {
    return "LLM endpoint connection error.";
  }
  if (lowered.includes("timed out") || lowered.includes("job timeout")) {
    return "Worker job timed out.";
  }
  if (lowered.includes("response did not contain parseable json")) {
    return "Model returned non-JSON output when structured output was expected.";
  }

  const stackLikeIndex = text.search(/\b(traceback|stack trace| at [A-Za-z0-9_.]+[:(])/i);
  const compact = stackLikeIndex > 0 ? text.slice(0, stackLikeIndex).trim() : text;
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 217)}...`;
}

const ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";

const LOCAL_QUICK_REPLY_SYSTEM_PROMPT = `
You are PushPals LocalBuddy.

Respond directly and briefly for lightweight chat and coordination questions.
If the user asks for coding/execution work, remind them to use:
/ask_remote_buddy <request>

Keep replies concise and helpful.
`.trim();

function parseRemoteBuddyCommand(input: string): {
  forceRemote: boolean;
  prompt: string;
  usageMessage?: string;
} {
  const trimmed = String(input ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { forceRemote: false, prompt: trimmed };
  }

  const rest = trimmed
    .slice(command.length)
    .replace(/^[:\-]\s*/, "")
    .trim();
  if (!rest) {
    return {
      forceRemote: true,
      prompt: "",
      usageMessage:
        "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard.",
    };
  }
  return { forceRemote: true, prompt: rest };
}

function isLikelyLocalOnlyPrompt(input: string): boolean {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return true;

  if (
    /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|good morning|good afternoon|good evening)[!. ]*$/.test(
      text,
    )
  ) {
    return true;
  }

  if (/^(how are you|what can you do|who are you|are you there|status\??)\b/.test(text)) {
    return true;
  }

  const executionCue =
    /\b(fix|implement|write|create|add|remove|delete|rename|refactor|run|test|lint|build|debug|search|find|edit|update|change)\b/.test(
      text,
    );
  if (executionCue) return false;

  return text.length <= 120;
}

// ─── LocalBuddy HTTP Server ─────────────────────────────────────────────────

class LocalBuddyServer {
  private agentId = "localbuddy-1";
  private server: string;
  private sessionId: string;
  private repo: string;
  private authToken: string | null;
  private llm: LLMClient;
  private readonly recentJobFailures: Array<{ jobId: string; summary: string; ts: string }> = [];

  constructor(opts: { server: string; sessionId: string; authToken: string | null }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;

    // Detect repo root from current working directory
    this.repo = detectRepoRoot(process.cwd());
    console.log(`[LocalBuddy] Detected repo root: ${this.repo}`);

    // Initialize LLM client for prompt enhancement
    this.llm = createLLMClient();
    console.log(`[LocalBuddy] LLM client initialized`);
  }

  /**
   * Enhance user prompt with repository context and LLM analysis.
   * Accepts pre-fetched context to avoid duplicate git calls.
   */
  private async enhancePrompt(
    originalPrompt: string,
    context: { branch: string; status: string; recentCommits: string },
  ): Promise<string> {
    try {
      const status = context.status.split("\n").slice(0, 20).join("\n") || "(clean)";
      const systemPrompt = loadPromptTemplate("localbuddy/localbuddy_system_prompt.md", {
        branch: context.branch,
        status,
        recent_commits: context.recentCommits || "(none)",
        repo_root: this.repo,
      });
      const postSystemPrompt = loadPromptTemplate("shared/post_system_prompt.md");
      const failureContext = this.recentJobFailures
        .slice(-3)
        .map((failure) => `- ${failure.jobId}: ${failure.summary}`)
        .join("\n");
      const combinedSystemPrompt = [
        systemPrompt,
        postSystemPrompt,
        failureContext
          ? `Recent WorkerPal job failures in this session (most recent first):\n${failureContext}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .trim();

      const output = await this.llm.generate({
        system: combinedSystemPrompt,
        messages: [{ role: "user", content: originalPrompt }],
        maxTokens: 1024,
        temperature: 0.3,
      });

      return output.text.trim();
    } catch (err) {
      console.error(`[LocalBuddy] LLM enhancement failed:`, err);
      // Fallback: return original prompt with basic context
      return `[Branch: ${context.branch}]\n\n${originalPrompt}`;
    }
  }

  private async answerLocally(userPrompt: string): Promise<string> {
    const normalized = String(userPrompt ?? "").trim();
    if (!normalized) {
      return "I didn't receive a request. Try a quick question, or use /ask_remote_buddy <request> to route work to RemoteBuddy.";
    }

    try {
      const output = await this.llm.generate({
        system: LOCAL_QUICK_REPLY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: normalized }],
        maxTokens: 300,
        temperature: 0.2,
      });
      const text = output.text.trim();
      if (text) return text;
    } catch (err) {
      console.error("[LocalBuddy] Local reply generation failed:", err);
    }

    if (/^(hi|hello|hey)\b/i.test(normalized)) {
      return "Hello. I can answer lightweight questions directly, or route execution work with /ask_remote_buddy <request>.";
    }
    return "I can answer lightweight questions directly. For execution or coding work, use /ask_remote_buddy <request>.";
  }

  /**
   * Start the HTTP server
   */
  startServer(port: number): void {
    // Capture `this` context for use in fetch handler
    const agentId = this.agentId;
    const repo = this.repo;
    const sessionId = this.sessionId;
    const serverUrl = this.server;
    const authToken = this.authToken;
    const enhancePrompt = this.enhancePrompt.bind(this);
    const answerLocally = this.answerLocally.bind(this);
    const comm = new CommunicationManager({
      serverUrl,
      sessionId,
      authToken,
      from: `agent:${agentId}`,
    });
    let stopping = false;
    let statusSessionReady = false;
    const ensureSessionWithRetry = async (
      maxRetries = 20,
      baseDelayMs = 500,
      maxDelayMs = 5000,
    ): Promise<boolean> => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
      for (let attempt = 1; attempt <= maxRetries && !stopping; attempt++) {
        try {
          const res = await fetch(`${serverUrl}/sessions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ sessionId }),
          });
          if (res.ok) return true;
        } catch {
          // retry
        }
        const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await Bun.sleep(delayMs);
      }
      return false;
    };
    const emitStartupPresence = async (): Promise<void> => {
      const ready = await ensureSessionWithRetry();
      if (!ready) {
        console.warn("[LocalBuddy] Could not ensure session for startup presence events");
        return;
      }
      statusSessionReady = true;
      const statusOk = await comm.status(agentId, "idle", "LocalBuddy online and ready");
      if (!statusOk) {
        statusSessionReady = false;
        console.warn("[LocalBuddy] Failed to emit startup status event");
      }
    };
    void emitStartupPresence();
    const statusHeartbeatMs = parseStatusHeartbeatMs("LOCALBUDDY_STATUS_HEARTBEAT_MS", 120_000);
    const statusHeartbeatTimer =
      statusHeartbeatMs > 0
        ? setInterval(() => {
            void (async () => {
              if (stopping) return;
              if (!statusSessionReady) {
                statusSessionReady = await ensureSessionWithRetry(3, 400, 2500);
              }
              const ok = await comm.status(agentId, "idle", "LocalBuddy heartbeat");
              if (!ok) {
                statusSessionReady = false;
              }
            })();
          }, statusHeartbeatMs)
        : null;

    const monitorStartedAt = Date.now();
    const stopSessionEvents = comm.subscribeSessionEvents(
      (envelope) => {
        if (envelope.type !== "job_failed") return;
        const tsMs = Date.parse(envelope.ts);
        if (Number.isFinite(tsMs) && tsMs + 2000 < monitorStartedAt) return;
        const payload = envelope.payload as { jobId?: unknown; message?: unknown; detail?: unknown };
        const jobId = String(payload.jobId ?? "").trim();
        const message = summarizeFailureForPrompt(payload.message);
        const detail = summarizeFailureForPrompt(payload.detail);
        if (!jobId || !message) return;
        const summary =
          detail && detail !== message
            ? `${message} (detail: ${detail.slice(0, 120)})`
            : message;
        this.recentJobFailures.unshift({ jobId, summary, ts: envelope.ts });
        if (this.recentJobFailures.length > 20) {
          this.recentJobFailures.length = 20;
        }
        console.warn(`[LocalBuddy] Observed WorkerPal job failure ${jobId}: ${summary}`);
      },
      {
        onError: (message) => console.warn(`[LocalBuddy] Session monitor: ${message}`),
      },
    );

    const stopMonitor = () => {
      stopping = true;
      void comm.status(agentId, "shutting_down", "LocalBuddy shutting down");
      if (statusHeartbeatTimer) {
        clearInterval(statusHeartbeatTimer);
      }
      try {
        stopSessionEvents();
      } catch {
        // ignore shutdown errors
      }
    };
    process.once("SIGINT", stopMonitor);
    process.once("SIGTERM", stopMonitor);
    if (process.platform === "win32") {
      process.once("SIGBREAK", stopMonitor);
    }

    Bun.serve({
      port,
      hostname: "0.0.0.0",
      idleTimeout: 120,

      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const pathname = url.pathname;
        const method = req.method;

        const jsonHeaders = {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type, authorization",
        };

        const makeJson = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: jsonHeaders });

        // Handle CORS preflight
        if (method === "OPTIONS") {
          return new Response(null, { status: 204, headers: jsonHeaders });
        }

        // POST /message - Main endpoint for client messages with streaming status
        if (pathname === "/message" && method === "POST") {
          try {
            const body = (await req.json()) as { text: string };
            const rawPrompt = String(body.text ?? "");
            const routing = parseRemoteBuddyCommand(rawPrompt);
            const routedPrompt = routing.prompt;
            const forceRemote = routing.forceRemote;
            const localOnly = !forceRemote && isLikelyLocalOnlyPrompt(routedPrompt);

            if (!rawPrompt.trim()) {
              return makeJson({ ok: false, message: "text is required" }, 400);
            }

            console.log(
              `[LocalBuddy] Received message: ${rawPrompt.substring(0, 80)}${rawPrompt.length > 80 ? "..." : ""}`,
            );
            if (forceRemote) {
              console.log("[LocalBuddy] Routing mode: forced RemoteBuddy via /ask_remote_buddy");
            } else if (localOnly) {
              console.log("[LocalBuddy] Routing mode: local-only reply");
            } else {
              console.log("[LocalBuddy] Routing mode: queue for RemoteBuddy");
            }

            // ── Step 0: Emit user message to server session so it appears in UI ──
            const cmdHeaders: Record<string, string> = { "Content-Type": "application/json" };
            if (authToken) cmdHeaders["Authorization"] = `Bearer ${authToken}`;

            void comm
              .userMessage(rawPrompt)
              .then((ok) => {
                if (!ok) {
                  console.error(`[LocalBuddy] Failed to emit user message to session`);
                }
              })
              .catch((err) =>
                console.error(`[LocalBuddy] Failed to emit user message to session:`, err),
              );

            void comm
              .assistantMessage(
                forceRemote
                  ? "Received your request. Routing this to RemoteBuddy now."
                  : localOnly
                    ? "Received your request. I can answer this directly as LocalBuddy."
                    : "Received your request. Preparing context and queueing it now.",
              )
              .then((ok) => {
                if (!ok) {
                  console.error(`[LocalBuddy] Failed to emit immediate acknowledgement message`);
                }
              })
              .catch((err) =>
                console.error(`[LocalBuddy] Failed to emit immediate acknowledgement message:`, err),
              );

            // ── Process and stream status back via SSE ──
            let closed = false;
            const stream = new ReadableStream({
              async start(controller) {
                const send = (data: { type: string; message: string; data?: any }) => {
                  if (closed) return;
                  try {
                    controller.enqueue(
                      new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`),
                    );
                  } catch {
                    closed = true;
                  }
                };

                const close = () => {
                  if (closed) return;
                  closed = true;
                  try {
                    controller.close();
                  } catch {
                    /* already closed */
                  }
                };

                try {
                  if (routing.usageMessage) {
                    send({ type: "status", message: "Command missing request body." });
                    await comm.assistantMessage(routing.usageMessage);
                    send({
                      type: "complete",
                      message: "Handled locally",
                      data: { mode: "local_usage_hint", sessionId },
                    });
                    close();
                    return;
                  }

                  if (localOnly) {
                    send({ type: "status", message: "Generating LocalBuddy response..." });
                    const localReply = await answerLocally(routedPrompt);
                    await comm.assistantMessage(localReply);
                    send({
                      type: "complete",
                      message: "Responded locally",
                      data: { mode: "local", sessionId },
                    });
                    close();
                    return;
                  }

                  // Step 1: Report repo detection
                  send({ type: "status", message: `Detected repo: ${repo}` });

                  // Step 2: Read git context
                  send({ type: "status", message: "Reading git status, branch, and commits..." });
                  const context = await getRepoContext(repo);
                  send({
                    type: "status",
                    message: `Current branch: ${context.branch}`,
                    data: { branch: context.branch },
                  });

                  // Step 3: Enhance prompt with LLM
                  send({ type: "status", message: "Enhancing prompt with LLM..." });
                  const enhancedPrompt = await enhancePrompt(routedPrompt, context);
                  send({
                    type: "status",
                    message: `Enhanced prompt (${enhancedPrompt.length} chars)`,
                  });

                  // Step 4: Enqueue to Request Queue
                  send({ type: "status", message: "Enqueuing to Request Queue..." });

                  const res = await fetch(`${serverUrl}/requests/enqueue`, {
                    method: "POST",
                    headers: cmdHeaders,
                    body: JSON.stringify({
                      sessionId,
                      originalPrompt: routedPrompt,
                      enhancedPrompt,
                    }),
                  });

                  if (!res.ok) {
                    const err = await res.text();
                    console.error(`[LocalBuddy] Failed to enqueue request: ${err}`);
                    send({ type: "error", message: `Failed to enqueue: ${err}` });
                    close();
                    return;
                  }

                  const data = (await res.json()) as { ok: boolean; requestId?: string };
                  console.log(`[LocalBuddy] Enqueued request: ${data.requestId}`);

                  const requestSuffix = data.requestId ? ` (${data.requestId.slice(0, 8)})` : "";
                  await comm.assistantMessage(
                    `Request queued${requestSuffix}. RemoteBuddy is planning and will assign a WorkerPal.`,
                  );

                  // Final success message
                  send({
                    type: "complete",
                    message: "Request enqueued successfully",
                    data: { requestId: data.requestId, sessionId },
                  });

                  close();
                } catch (err) {
                  console.error(`[LocalBuddy] Error processing message:`, err);
                  send({ type: "error", message: String(err) });
                  close();
                }
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              },
            });
          } catch (err) {
            console.error(`[LocalBuddy] Error processing message:`, err);
            return makeJson({ ok: false, message: String(err) }, 500);
          }
        }

        // GET /healthz - Health check endpoint
        if (pathname === "/healthz" && method === "GET") {
          return makeJson({
            ok: true,
            agentId,
            repo,
            sessionId,
          });
        }

        // GET / - Info endpoint
        if (pathname === "/" && method === "GET") {
          return makeJson({
            name: "PushPals LocalBuddy",
            version: "0.1.0",
            endpoints: {
              "POST /message":
                "Send a message to LocalBuddy (use /ask_remote_buddy <request> to force remote routing)",
              "GET /healthz": "Health check",
            },
          });
        }

        return makeJson({ ok: false, message: "Not found" }, 404);
      },
    });

    console.log(`[LocalBuddy] HTTP server listening on http://0.0.0.0:${port}`);
    console.log(`[LocalBuddy] Ready to receive messages at POST http://localhost:${port}/message`);
  }
}

// ─── Session creation helper ────────────────────────────────────────────────

async function connectWithRetry(
  server: string,
  sessionId: string,
  maxRetries = 10,
  baseDelay = 2000,
  maxDelay = 30000,
): Promise<string> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${server}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    } catch (err: any) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(
        `[LocalBuddy] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s… (attempt ${attempt})`,
      );
      await Bun.sleep(delay);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`[LocalBuddy] PushPals LocalBuddy - HTTP Server`);
  console.log(`[LocalBuddy] Server: ${opts.server}`);
  console.log(`[LocalBuddy] Port: ${opts.port}`);

  // Create or join session (with retry - server may not be up yet)
  console.log(`[LocalBuddy] Ensuring session "${opts.sessionId}" exists on server…`);
  const sessionId = await connectWithRetry(opts.server, opts.sessionId);
  console.log(`[LocalBuddy] Using session: ${sessionId}`);

  // Start LocalBuddy HTTP server
  const agent = new LocalBuddyServer({
    server: opts.server,
    sessionId,
    authToken: opts.authToken,
  });

  agent.startServer(opts.port);
}

main().catch((err) => {
  console.error("[LocalBuddy] Fatal:", err);
  process.exit(1);
});
