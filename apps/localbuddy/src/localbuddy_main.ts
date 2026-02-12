#!/usr/bin/env bun
/**
 * PushPals LocalBuddy - HTTP Server
 *
 * Usage:
 *   bun run localbuddy --server http://localhost:3001 [--port 3003] [--sessionId <id>]
 *
 * Accepts messages from clients via HTTP, enhances them with LLM + repo context,
 * and enqueues to the server's Request Queue for RemoteBuddy processing.
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

// ─── LocalBuddy HTTP Server ─────────────────────────────────────────────────

class LocalBuddyServer {
  private agentId = "localbuddy-1";
  private server: string;
  private sessionId: string;
  private repo: string;
  private authToken: string | null;
  private llm: LLMClient;

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
      const combinedSystemPrompt = `${systemPrompt}\n\n${postSystemPrompt}`.trim();

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
    const comm = new CommunicationManager({
      serverUrl,
      sessionId,
      authToken,
      from: `agent:${agentId}`,
    });

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
            const originalPrompt = body.text;

            if (!originalPrompt) {
              return makeJson({ ok: false, message: "text is required" }, 400);
            }

            console.log(
              `[LocalBuddy] Received message: ${originalPrompt.substring(0, 80)}${originalPrompt.length > 80 ? "..." : ""}`,
            );

            // ── Step 0: Emit user message to server session so it appears in UI ──
            const cmdHeaders: Record<string, string> = { "Content-Type": "application/json" };
            if (authToken) cmdHeaders["Authorization"] = `Bearer ${authToken}`;

            void comm
              .userMessage(originalPrompt)
              .then((ok) => {
                if (!ok) {
                  console.error(`[LocalBuddy] Failed to emit user message to session`);
                }
              })
              .catch((err) =>
                console.error(`[LocalBuddy] Failed to emit user message to session:`, err),
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
                  const enhancedPrompt = await enhancePrompt(originalPrompt, context);
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
                      originalPrompt,
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
              "POST /message": "Send a message to be processed",
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
