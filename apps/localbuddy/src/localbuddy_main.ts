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
 * - Routed requests are enqueued immediately; RemoteBuddy handles deeper planning/context.
 */

import { randomUUID } from "crypto";
import { CommunicationManager, detectRepoRoot } from "shared";
import { createLLMClient, type LLMClient } from "../../remotebuddy/src/llm.js";
import {
  buildJobStatusReply,
  buildRequestStatusReply,
  extractReferencedJobToken,
  isStatusLookupPrompt,
  type JobApiRow,
  type JobLogApiRow,
  type RequestApiRow,
} from "./request_status.js";
import { answerLocalReadonlyQuery, isLocalReadonlyQueryPrompt } from "./local_readonly.js";

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

Return ONLY the final user-facing reply. Never reveal internal reasoning, analysis steps, or chain-of-thought.
Do not include numbered analysis, "identify constraints", "self-correction", or planning text.
Keep replies concise and helpful (max 2 short sentences).
If unclear, ask one brief clarifying question.
`.trim();

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse failure
    }
  }
  return null;
}

function extractLocalReplyFromObject(value: Record<string, unknown> | null): string {
  if (!value) return "";
  const candidates = [
    value.reply,
    value.assistant_message,
    value.message,
    value.text,
    value.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function fallbackLocalReply(userPrompt: string): string {
  const text = userPrompt.trim().toLowerCase();
  if (/^(hi|hello|hey)\b/.test(text)) {
    return "Hello. I can answer lightweight questions directly, or route execution work with /ask_remote_buddy <request>.";
  }
  if (/status|what'?s the status|whats the status/.test(text)) {
    return "I’m online and ready. For full job/repo status, use /ask_remote_buddy <request>.";
  }
  return "I can answer lightweight questions directly. For execution or coding work, use /ask_remote_buddy <request>.";
}

function sanitizeLocalReply(raw: string, userPrompt: string): string {
  let text = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!text) return fallbackLocalReply(userPrompt);

  // Some providers ignore/relax JSON schema and return alternate keys.
  const parsed = tryParseJsonObject(text);
  const extracted = extractLocalReplyFromObject(parsed);
  if (extracted) {
    text = extracted;
  }

  const lowered = text.toLowerCase();
  const reasoningSignals = [
    "analyze the user's request",
    "identify the constraints",
    "self-correction",
    "step-by-step",
    "my reasoning",
    "chain-of-thought",
  ];
  if (reasoningSignals.some((signal) => lowered.includes(signal))) {
    return fallbackLocalReply(userPrompt);
  }

  // Keep only the first short paragraph/sentence if model rambles.
  const firstParagraph = text.split(/\n\s*\n/)[0]?.trim() ?? text;
  text = firstParagraph.length > 320 ? `${firstParagraph.slice(0, 317)}...` : firstParagraph;

  if (/^\d+\.\s+\*\*/.test(text) || /^analysis[:\s]/i.test(text)) {
    return fallbackLocalReply(userPrompt);
  }
  return text || fallbackLocalReply(userPrompt);
}

interface RequestListResponse {
  ok: boolean;
  requests?: RequestApiRow[];
  message?: string;
}

interface JobListResponse {
  ok: boolean;
  jobs?: JobApiRow[];
  message?: string;
}

interface JobLogListResponse {
  ok: boolean;
  logs?: JobLogApiRow[];
  cursor?: number | null;
  message?: string;
}

type RequestPriority = "interactive" | "normal" | "background";

function classifyRemoteRequestPriority(input: string): RequestPriority {
  const text = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!text) return "normal";

  if (
    /\b(status|progress|queue|queued|eta|where|hows my job|what'?s my status|check on)\b/.test(text)
  ) {
    return "interactive";
  }

  if (
    /\b(comprehensive|deep dive|full pass|phase\s+\d|architecture|migration|refactor|rewrite|all components|everything)\b/.test(
      text,
    ) ||
    text.length > 1200
  ) {
    return "background";
  }

  return "normal";
}

function queueWaitBudgetForPriority(priority: RequestPriority): number {
  switch (priority) {
    case "interactive":
      return 20_000;
    case "background":
      return 240_000;
    default:
      return 90_000;
  }
}

function formatEtaFromMs(ms: number | undefined): string {
  if (!Number.isFinite(ms as number) || (ms as number) <= 0) return "now";
  const value = Math.max(0, Math.floor(ms as number));
  if (value < 1_000) return `${value}ms`;
  const secs = Math.ceil(value / 1_000);
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${minutes}m ${remSecs}s` : `${minutes}m`;
}

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
  const text = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!text) return true;

  if (isLocalReadonlyQueryPrompt(text)) {
    return true;
  }

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
  private readonly seenJobFailureKeys = new Set<string>();

  constructor(opts: { server: string; sessionId: string; authToken: string | null }) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;

    // Detect repo root from current working directory
    this.repo = detectRepoRoot(process.cwd());
    console.log(`[LocalBuddy] Detected repo root: ${this.repo}`);

    // Initialize LLM client for prompt enhancement
    this.llm = createLLMClient({ service: "localbuddy", sessionId: this.sessionId });
    console.log(`[LocalBuddy] LLM client initialized`);
  }

  private async answerLocally(userPrompt: string): Promise<string> {
    const normalized = String(userPrompt ?? "").trim();
    if (!normalized) {
      return "I didn't receive a request. Try a quick question, or use /ask_remote_buddy <request> to route work to RemoteBuddy.";
    }

    const statusReply = await this.answerRequestStatus(normalized);
    if (statusReply) return statusReply;

    const readonlyReply = await answerLocalReadonlyQuery(normalized, {
      repoRoot: this.repo,
      serverUrl: this.server,
      authHeaders: this.authHeaders(),
    });
    if (readonlyReply) return readonlyReply;

    try {
      const output = await this.llm.generate({
        system: `${LOCAL_QUICK_REPLY_SYSTEM_PROMPT}

Respond in strict JSON with this shape:
{"reply":"<final user-facing response>"}`,
        messages: [
          {
            role: "user",
            content: `User message: ${normalized}\nReturn JSON only.`,
          },
        ],
        json: true,
        maxTokens: 300,
        temperature: 0.2,
      });
      const parsed = tryParseJsonObject(output.text);
      const reply = extractLocalReplyFromObject(parsed) || output.text;
      const text = sanitizeLocalReply(reply, normalized);
      if (text) return text;
    } catch (err) {
      console.error("[LocalBuddy] Local reply generation failed:", err);
    }

    return fallbackLocalReply(normalized);
  }

  private authHeaders(contentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = "application/json";
    if (this.authToken) headers["Authorization"] = `Bearer ${this.authToken}`;
    return headers;
  }

  private toSingleLine(value: unknown, maxChars = 220): string {
    const text = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  }

  private async fetchJobLogTail(jobId: string, limit = 8): Promise<string[]> {
    try {
      const res = await fetch(
        `${this.server}/jobs/${encodeURIComponent(jobId)}/logs?limit=${Math.max(1, Math.min(20, limit))}`,
        { headers: this.authHeaders() },
      );
      if (!res.ok) return [];
      const payload = (await res.json()) as JobLogListResponse;
      if (!payload.ok || !Array.isArray(payload.logs)) return [];
      return payload.logs
        .map((row) => this.toSingleLine(row?.message, 220))
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(10, limit)));
    } catch {
      return [];
    }
  }

  private async emitProactiveFailureUpdate(
    comm: CommunicationManager,
    jobId: string,
    message: string,
    detail: string,
  ): Promise<void> {
    const shortJob = jobId.slice(0, 8);
    const messageText = this.toSingleLine(message, 220) || "WorkerPal job failed.";
    const detailText = this.toSingleLine(detail, 200);
    const detailSuffix = detailText && detailText !== messageText ? ` (${detailText})` : "";
    const intro =
      `WorkerPal job ${shortJob} failed: ${messageText}${detailSuffix}. ` +
      "I got the failure and I'm checking recent logs now.";
    const introOk = await comm.assistantMessage(intro);
    if (!introOk) {
      console.warn(`[LocalBuddy] Failed to emit proactive failure intro for job ${jobId}`);
    }

    const tail = await this.fetchJobLogTail(jobId, 8);
    if (tail.length === 0) return;

    const likelyCause = summarizeFailureForPrompt(tail[tail.length - 1] ?? detail ?? message);
    const diagnosis = `Diagnosis for job ${shortJob}: ${likelyCause}\nRecent logs:\n\`\`\`\n${tail.join("\n")}\n\`\`\``;
    const diagnosisOk = await comm.assistantMessage(diagnosis);
    if (!diagnosisOk) {
      console.warn(`[LocalBuddy] Failed to emit proactive failure diagnosis for job ${jobId}`);
    }
  }

  private async answerRequestStatus(userPrompt: string): Promise<string | null> {
    if (!isStatusLookupPrompt(userPrompt)) return null;

    try {
      const [requestData, jobData] = await Promise.all([
        fetch(`${this.server}/requests?status=all&limit=200`, {
          headers: this.authHeaders(),
        }),
        fetch(`${this.server}/jobs?status=all&limit=400`, {
          headers: this.authHeaders(),
        }),
      ]);

      if (!requestData.ok) {
        return `I couldn't check request status right now (requests API ${requestData.status}).`;
      }
      if (!jobData.ok) {
        return `I couldn't check request status right now (jobs API ${jobData.status}).`;
      }

      const requestsPayload = (await requestData.json()) as RequestListResponse;
      const jobsPayload = (await jobData.json()) as JobListResponse;
      const sessionJobs = (jobsPayload.jobs ?? []).filter(
        (row) => row.sessionId === this.sessionId,
      );

      let logs: JobLogApiRow[] = [];
      const requestedJobToken = extractReferencedJobToken(userPrompt);
      const mightBeJobQuery =
        Boolean(requestedJobToken) || /\b(job|workerpal|task)\b/i.test(userPrompt);
      if (mightBeJobQuery && sessionJobs.length > 0) {
        let selectedJob: JobApiRow | null =
          sessionJobs.find((row) => row.status === "claimed") ??
          sessionJobs.find((row) => row.status === "pending") ??
          sessionJobs[0];
        if (requestedJobToken) {
          const token = requestedJobToken.toLowerCase();
          const matchedJob =
            sessionJobs.find((row) => row.id.toLowerCase() === token) ??
            sessionJobs.find((row) => row.id.toLowerCase().startsWith(token)) ??
            null;
          selectedJob = matchedJob;
        }
        if (selectedJob) {
          const logsRes = await fetch(`${this.server}/jobs/${selectedJob.id}/logs?limit=10`, {
            headers: this.authHeaders(),
          });
          if (logsRes.ok) {
            const logsPayload = (await logsRes.json()) as JobLogListResponse;
            logs = logsPayload.logs ?? [];
          }
        }
      }

      const jobReply = buildJobStatusReply({
        userPrompt,
        sessionId: this.sessionId,
        jobs: jobsPayload.jobs ?? [],
        logs,
        summarizeFailure: summarizeFailureForPrompt,
      });
      if (jobReply) return jobReply;

      return buildRequestStatusReply({
        userPrompt,
        sessionId: this.sessionId,
        requests: requestsPayload.requests ?? [],
        jobs: sessionJobs,
        summarizeFailure: summarizeFailureForPrompt,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `I couldn't check request status right now (${summarizeFailureForPrompt(reason)}).`;
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

      const startupDeadlineMs = Date.now() + 15_000;
      while (!stopping) {
        const statusOk = await comm.status(agentId, "idle", "LocalBuddy online and ready");
        if (statusOk) return;

        statusSessionReady = false;
        if (Date.now() >= startupDeadlineMs) break;
        await Bun.sleep(1_000);
        statusSessionReady = await ensureSessionWithRetry(3, 400, 2_500);
      }
      console.warn("[LocalBuddy] Failed to emit startup status event");
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
        if (stopping) return;
        const tsMs = Date.parse(envelope.ts);
        if (Number.isFinite(tsMs) && tsMs + 2000 < monitorStartedAt) return;
        const payload = envelope.payload as {
          jobId?: unknown;
          message?: unknown;
          detail?: unknown;
        };
        const jobId = String(payload.jobId ?? "").trim();
        const message = summarizeFailureForPrompt(payload.message);
        const detail = summarizeFailureForPrompt(payload.detail);
        if (!jobId || !message) return;
        const dedupeKey = `${jobId}:${message}`;
        if (this.seenJobFailureKeys.has(dedupeKey)) return;
        this.seenJobFailureKeys.add(dedupeKey);
        if (this.seenJobFailureKeys.size > 200) {
          const oldest = this.seenJobFailureKeys.values().next().value;
          if (typeof oldest === "string") {
            this.seenJobFailureKeys.delete(oldest);
          }
        }
        const summary =
          detail && detail !== message ? `${message} (detail: ${detail.slice(0, 120)})` : message;
        this.recentJobFailures.unshift({ jobId, summary, ts: envelope.ts });
        if (this.recentJobFailures.length > 20) {
          this.recentJobFailures.length = 20;
        }
        console.warn(`[LocalBuddy] Observed WorkerPal job failure ${jobId}: ${summary}`);
        void this.emitProactiveFailureUpdate(comm, jobId, message, detail);
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
            const statusLookupIntent = isStatusLookupPrompt(routedPrompt);
            const localOnly =
              !forceRemote && (statusLookupIntent || isLikelyLocalOnlyPrompt(routedPrompt));

            if (!rawPrompt.trim()) {
              return makeJson({ ok: false, message: "text is required" }, 400);
            }

            console.log(
              `[LocalBuddy] Received message: ${rawPrompt.substring(0, 80)}${rawPrompt.length > 80 ? "..." : ""}`,
            );
            if (forceRemote) {
              console.log("[LocalBuddy] Routing mode: forced RemoteBuddy via /ask_remote_buddy");
            } else if (statusLookupIntent) {
              console.log("[LocalBuddy] Routing mode: local status lookup");
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
                    : "Received your request. Queueing this to RemoteBuddy now.",
              )
              .then((ok) => {
                if (!ok) {
                  console.error(`[LocalBuddy] Failed to emit immediate acknowledgement message`);
                }
              })
              .catch((err) =>
                console.error(
                  `[LocalBuddy] Failed to emit immediate acknowledgement message:`,
                  err,
                ),
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

                  // Queue immediately; RemoteBuddy handles context/planning.
                  send({ type: "status", message: "Enqueuing to Request Queue..." });

                  const priority = classifyRemoteRequestPriority(routedPrompt);
                  const queueWaitBudgetMs = queueWaitBudgetForPriority(priority);

                  const res = await fetch(`${serverUrl}/requests/enqueue`, {
                    method: "POST",
                    headers: cmdHeaders,
                    body: JSON.stringify({
                      sessionId,
                      prompt: routedPrompt,
                      priority,
                      queueWaitBudgetMs,
                    }),
                  });

                  if (!res.ok) {
                    const err = await res.text();
                    console.error(`[LocalBuddy] Failed to enqueue request: ${err}`);
                    send({ type: "error", message: `Failed to enqueue: ${err}` });
                    close();
                    return;
                  }

                  const data = (await res.json()) as {
                    ok: boolean;
                    requestId?: string;
                    queuePosition?: number;
                    etaMs?: number;
                  };
                  console.log(`[LocalBuddy] Enqueued request: ${data.requestId}`);

                  const requestSuffix = data.requestId ? ` (${data.requestId.slice(0, 8)})` : "";
                  const queueSuffix =
                    Number.isFinite(data.queuePosition as number) &&
                    (data.queuePosition as number) > 0
                      ? ` Priority ${priority}; queue #${data.queuePosition} (ETA ${formatEtaFromMs(
                          data.etaMs,
                        )}).`
                      : ` Priority ${priority}.`;
                  await comm.assistantMessage(
                    `Request queued${requestSuffix}.${queueSuffix} RemoteBuddy is planning and will assign a WorkerPal.`,
                  );

                  // Final success message
                  send({
                    type: "complete",
                    message: "Request enqueued successfully",
                    data: {
                      requestId: data.requestId,
                      sessionId,
                      priority,
                      queuePosition: data.queuePosition,
                      etaMs: data.etaMs,
                    },
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
