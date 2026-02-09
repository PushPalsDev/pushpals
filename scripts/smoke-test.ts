#!/usr/bin/env bun
/**
 * End-to-end smoke test for PushPals multi-agent system.
 *
 * Exercises the full pipeline:
 *   Client -> Server -> Agent-local -> Tools/Workers -> Server -> Client
 *
 * Prerequisites:
 *   1. bun run server        (port 3001)
 *   2. bun run agent-local   (connects to server)
 *   3. bun run worker        (polls job queue)
 *
 * Usage:
 *   PUSHPALS_AUTH_TOKEN=<token> bun run scripts/smoke-test.ts
 *
 * The test creates a session, sends a message, and asserts that the expected
 * event types arrive within a timeout window.
 */

const BASE = process.env.PUSHPALS_URL ?? "http://localhost:3001";
const AUTH = process.env.PUSHPALS_AUTH_TOKEN ?? "";
const TIMEOUT_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`[smoke] ${new Date().toISOString().slice(11, 23)} ${msg}`);
}

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}

// ─── 1. Create session ──────────────────────────────────────────────────────
log("Creating session...");
const createRes = await fetch(`${BASE}/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
});
if (!createRes.ok) fail(`POST /sessions -> ${createRes.status}`);
const { sessionId } = (await createRes.json()) as { sessionId: string };
log(`Session: ${sessionId}`);

// ─── 2. Connect SSE stream ──────────────────────────────────────────────────
const events: Array<{ type: string; payload: any; from?: string; turnId?: string }> = [];
const seenTypes = new Set<string>();

const evtSource = new EventSource(`${BASE}/sessions/${sessionId}/events`);
evtSource.onmessage = (msg) => {
  try {
    const data = JSON.parse(msg.data);
    events.push(data);
    seenTypes.add(data.type);
    log(`<- ${data.type}${data.from ? ` (from=${data.from})` : ""}`);
  } catch {
    /* ignore parse errors */
  }
};
evtSource.onerror = () => {
  /* reconnect is automatic */
};

// Give SSE a moment to connect
await new Promise((r) => setTimeout(r, 500));

// ─── 3. Send user message ────────────────────────────────────────────────────
const userMessage = "Run git status on this repo";
log(`Sending message: "${userMessage}"`);

const msgRes = await fetch(`${BASE}/sessions/${sessionId}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: userMessage }),
});
if (!msgRes.ok) fail(`POST /sessions/${sessionId}/message -> ${msgRes.status}`);
log("Message sent OK");

// ─── 4. Wait for expected events ─────────────────────────────────────────────
// The minimum expected flow:
//   task_created -> agent acknowledges the message
//   (task_started, task_progress, tool_call, tool_result are possible)
//   task_completed | task_failed -> agent finishes
//
// We require at least task_created to prove the agent received and processed
// the message. Additional events are bonuses that show the pipeline works.

const REQUIRED_TYPES = ["task_created"];
const BONUS_TYPES = [
  "agent_status",
  "task_started",
  "task_progress",
  "tool_call",
  "tool_result",
  "task_completed",
  "task_failed",
  "job_enqueued",
  "job_claimed",
  "job_completed",
  "job_failed",
  "assistant_message",
];

log(`Waiting up to ${TIMEOUT_MS / 1000}s for events...`);

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  // Check if all required types have been seen
  const allRequired = REQUIRED_TYPES.every((t) => seenTypes.has(t));
  // Also wait for some terminal event
  const hasTerminal =
    seenTypes.has("task_completed") || seenTypes.has("task_failed") || seenTypes.has("done");

  if (allRequired && hasTerminal) break;
  await new Promise((r) => setTimeout(r, 500));
}

evtSource.close();

// ─── 5. Report ───────────────────────────────────────────────────────────────
console.log("\n─── Smoke Test Report ───");
console.log(`Session:    ${sessionId}`);
console.log(`Events:     ${events.length} total`);
console.log(`Types seen: ${[...seenTypes].join(", ")}`);

// Check required
const missingRequired = REQUIRED_TYPES.filter((t) => !seenTypes.has(t));
if (missingRequired.length > 0) {
  fail(`Missing required event types: ${missingRequired.join(", ")}`);
}

// Report bonuses
const bonusSeen = BONUS_TYPES.filter((t) => seenTypes.has(t));
console.log(`Bonus:      ${bonusSeen.length}/${BONUS_TYPES.length} (${bonusSeen.join(", ")})`);

// Full trace
console.log("\n─── Event Trace ───");
for (const ev of events) {
  const from = ev.from ? ` [${ev.from}]` : "";
  const turn = ev.turnId ? ` turn=${ev.turnId.substring(0, 8)}` : "";
  const summary =
    typeof ev.payload === "object"
      ? JSON.stringify(ev.payload).substring(0, 100)
      : String(ev.payload);
  console.log(`  ${ev.type}${from}${turn}  ${summary}`);
}

console.log("\nPASS: All required events received.\n");
process.exit(0);
