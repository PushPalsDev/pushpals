#!/usr/bin/env bun
/**
 * Integration test suite for PushPals protocol and server
 */

import {
  EventEnvelope,
  PROTOCOL_VERSION,
  validateEventEnvelope,
  validateMessageRequest,
  validateApprovalDecisionRequest,
  validateCommandRequest,
  AnyEventEnvelope,
} from "protocol";
import { randomUUID } from "crypto";

console.log("PushPals Protocol Integration Test\n");

let passedTests = 0;
let failedTests = 0;

function test(name: string, fn: () => boolean) {
  try {
    const result = fn();
    if (result) {
      console.log(`[PASS] ${name}`);
      passedTests++;
    } else {
      console.log(`[FAIL] ${name}: assertion failed`);
      failedTests++;
    }
  } catch (err) {
    console.log(`[FAIL] ${name}: ${err}`);
    failedTests++;
  }
}

// Test 1: Valid EventEnvelope
test("Valid EventEnvelope passes validation", () => {
  const validEvent: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "log",
    payload: {
      level: "info",
      message: "Test message",
    },
  };
  const result = validateEventEnvelope(validEvent);
  return result.ok === true;
});

// Test 2: Invalid protocol version is rejected
test("Invalid protocol version rejected", () => {
  const invalidEvent = {
    protocolVersion: "1.0.0", // Wrong version
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "log",
    payload: { level: "info", message: "Test" },
  };
  const result = validateEventEnvelope(invalidEvent);
  return result.ok === false && result.errors !== undefined;
});

// Test: Invalid ts (non-ISO) should be rejected when formats are enabled
test("Invalid ts format rejected", () => {
  const event: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: "not-a-date",
    sessionId: randomUUID(),
    type: "log",
    payload: { level: "info", message: "Bad ts" },
  };
  const result = validateEventEnvelope(event);
  return result.ok === false;
});

// Test 3: Message request with valid text passes
test("Valid message request passes", () => {
  const result = validateMessageRequest({ text: "Hello" });
  return result.ok === true;
});

// Test 4: Message request with invalid type fails
test("Invalid message text type rejected", () => {
  const result = validateMessageRequest({ text: 123 } as any);
  return result.ok === false;
});

// Test 5: Approval decision "approve" is valid
test("Approval decision 'approve' is valid", () => {
  const result = validateApprovalDecisionRequest({ decision: "approve" });
  return result.ok === true;
});

// Test 6: Approval decision "deny" is valid
test("Approval decision 'deny' is valid", () => {
  const result = validateApprovalDecisionRequest({ decision: "deny" });
  return result.ok === true;
});

// Test 7: Invalid approval decision rejected
test("Invalid approval decision rejected", () => {
  const result = validateApprovalDecisionRequest({ decision: "maybe" } as any);
  return result.ok === false;
});

// Test 8: Different event types validate correctly
test("Event type 'scan_result' validates", () => {
  const event: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "scan_result",
    payload: {
      summary: "Scanned 5 files",
      filesRead: ["file1.ts"],
      gitStatusPorcelain: "M file1.ts",
      gitDiff: "diff content",
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// Test 9: Event type 'approval_required' validates
test("Event type 'approval_required' validates", () => {
  const event: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "approval_required",
    payload: {
      approvalId: randomUUID(),
      action: "git.commit",
      summary: "Commit changes",
      details: {},
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// Test 10: Event type 'done' validates
test("Event type 'done' validates", () => {
  const event: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "done",
    payload: { ok: true },
  };
  return validateEventEnvelope(event).ok === true;
});

// Test 11: assistant_message validates
test("Event type 'assistant_message' validates", () => {
  const event: EventEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "assistant_message",
    payload: { text: "Got it — I'm going to plan tasks..." } as any,
  };
  return validateEventEnvelope(event).ok === true;
});

// Test 11: Protocol version constant is correct
test("Protocol version is 0.1.0", () => {
  return PROTOCOL_VERSION === "0.1.0";
});

// Test 12: Deny decision enum value
test("Denial decision strictly checked", () => {
  // This should fail for typo like "den"
  const bad = validateApprovalDecisionRequest({ decision: "den" } as any);
  const good = validateApprovalDecisionRequest({ decision: "deny" });
  return bad.ok === false && good.ok === true;
});

// ── Routing / meta fields ───────────────────────────────────────────────────

test("Envelope with routing fields (from, to, turnId, correlationId, parentId) validates", () => {
  const event: EventEnvelope<"log"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "log",
    from: "agent:local1",
    to: "broadcast",
    correlationId: randomUUID(),
    parentId: randomUUID(),
    turnId: randomUUID(),
    payload: { level: "info", message: "routed" },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Envelope with only some routing fields validates", () => {
  const event: EventEnvelope<"log"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "log",
    from: "client",
    payload: { level: "info", message: "partial routing" },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── agent_status ────────────────────────────────────────────────────────────

test("Event type 'agent_status' validates (idle)", () => {
  const event: EventEnvelope<"agent_status"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "agent_status",
    from: "agent:local1",
    payload: { agentId: "local1", status: "idle" },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'agent_status' validates (busy with message)", () => {
  const event: EventEnvelope<"agent_status"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "agent_status",
    payload: { agentId: "local1", status: "busy", message: "Processing task" },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'agent_status' rejects invalid status", () => {
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "agent_status",
    payload: { agentId: "local1", status: "sleeping" },
  };
  return validateEventEnvelope(event).ok === false;
});

// ── task_created ────────────────────────────────────────────────────────────

test("Event type 'task_created' validates (minimal)", () => {
  const event: EventEnvelope<"task_created"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_created",
    payload: {
      taskId: randomUUID(),
      title: "Add tests",
      description: "Add unit tests for the companion module",
      createdBy: "agent:local1",
    },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'task_created' validates (with priority & tags)", () => {
  const event: EventEnvelope<"task_created"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_created",
    turnId: randomUUID(),
    payload: {
      taskId: randomUUID(),
      title: "Fix lint",
      description: "Run lint and fix errors",
      createdBy: "planner",
      priority: "high",
      tags: ["lint", "ci"],
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── task_started ────────────────────────────────────────────────────────────

test("Event type 'task_started' validates", () => {
  const event: EventEnvelope<"task_started"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_started",
    payload: { taskId: randomUUID() },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── task_progress ───────────────────────────────────────────────────────────

test("Event type 'task_progress' validates (with percent)", () => {
  const event: EventEnvelope<"task_progress"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_progress",
    payload: { taskId: randomUUID(), message: "Running tests…", percent: 42 },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'task_progress' validates (no percent)", () => {
  const event: EventEnvelope<"task_progress"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_progress",
    payload: { taskId: randomUUID(), message: "Still going" },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── task_completed ──────────────────────────────────────────────────────────

test("Event type 'task_completed' validates (with artifacts)", () => {
  const event: EventEnvelope<"task_completed"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_completed",
    payload: {
      taskId: randomUUID(),
      summary: "All tests pass",
      artifacts: [
        { kind: "log", text: "3 passed, 0 failed" },
        { kind: "file", uri: "coverage/lcov.info" },
      ],
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── task_failed ─────────────────────────────────────────────────────────────

test("Event type 'task_failed' validates", () => {
  const event: EventEnvelope<"task_failed"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "task_failed",
    payload: { taskId: randomUUID(), message: "Lint detected 3 errors", detail: "src/foo.ts:12" },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── tool_call ───────────────────────────────────────────────────────────────

test("Event type 'tool_call' validates (requiresApproval=true)", () => {
  const event: EventEnvelope<"tool_call"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "tool_call",
    from: "agent:local1",
    payload: {
      toolCallId: randomUUID(),
      taskId: randomUUID(),
      tool: "git.applyPatch",
      args: { patch: "diff --git …" },
      requiresApproval: true,
    },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'tool_call' validates (no approval)", () => {
  const event: EventEnvelope<"tool_call"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "tool_call",
    payload: {
      toolCallId: randomUUID(),
      tool: "git.status",
      args: {},
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── tool_result ─────────────────────────────────────────────────────────────

test("Event type 'tool_result' validates (ok=true)", () => {
  const event: EventEnvelope<"tool_result"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "tool_result",
    payload: {
      toolCallId: randomUUID(),
      ok: true,
      stdout: "M src/index.ts",
      exitCode: 0,
    },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'tool_result' validates (ok=false with stderr)", () => {
  const event: EventEnvelope<"tool_result"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "tool_result",
    payload: {
      toolCallId: randomUUID(),
      taskId: randomUUID(),
      ok: false,
      stderr: "error: patch does not apply",
      exitCode: 1,
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── delegate_request ────────────────────────────────────────────────────────

test("Event type 'delegate_request' validates", () => {
  const event: EventEnvelope<"delegate_request"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "delegate_request",
    from: "agent:local1",
    to: "agent:remote2",
    payload: {
      requestId: randomUUID(),
      toAgentId: "remote2",
      input: { userText: "Describe the repo" },
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── delegate_response ───────────────────────────────────────────────────────

test("Event type 'delegate_response' validates (ok)", () => {
  const event: EventEnvelope<"delegate_response"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "delegate_response",
    payload: {
      requestId: randomUUID(),
      ok: true,
      output: { tasks: [] },
    },
  };
  return validateEventEnvelope(event).ok === true;
});

test("Event type 'delegate_response' validates (error)", () => {
  const event: EventEnvelope<"delegate_response"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "delegate_response",
    payload: {
      requestId: randomUUID(),
      ok: false,
      error: "Agent unreachable",
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── job_enqueued ────────────────────────────────────────────────────────────

test("Event type 'job_enqueued' validates", () => {
  const event: EventEnvelope<"job_enqueued"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "job_enqueued",
    payload: {
      jobId: randomUUID(),
      taskId: randomUUID(),
      kind: "bun.test",
      params: { cwd: "." },
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── job_claimed ─────────────────────────────────────────────────────────────

test("Event type 'job_claimed' validates", () => {
  const event: EventEnvelope<"job_claimed"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "job_claimed",
    payload: { jobId: randomUUID(), workerId: "worker-1" },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── job_completed ───────────────────────────────────────────────────────────

test("Event type 'job_completed' validates", () => {
  const event: EventEnvelope<"job_completed"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "job_completed",
    payload: {
      jobId: randomUUID(),
      summary: "All 12 tests passed",
      artifacts: [{ kind: "log", text: "output…" }],
    },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── job_failed ──────────────────────────────────────────────────────────────

test("Event type 'job_failed' validates", () => {
  const event: EventEnvelope<"job_failed"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: "job_failed",
    payload: { jobId: randomUUID(), message: "Timeout after 30s" },
  };
  return validateEventEnvelope(event).ok === true;
});

// ── validateCommandRequest ──────────────────────────────────────────────────

test("validateCommandRequest accepts valid command", () => {
  return (
    validateCommandRequest({
      type: "agent_status",
      payload: { agentId: "local1", status: "busy" },
      from: "agent:local1",
      turnId: randomUUID(),
    }).ok === true
  );
});

test("validateCommandRequest rejects unknown type", () => {
  return (
    validateCommandRequest({
      type: "unknown_event",
      payload: {},
    }).ok === false
  );
});

test("validateCommandRequest rejects missing payload", () => {
  return validateCommandRequest({ type: "log" }).ok === false;
});

// Summary
console.log(`\nResults: ${passedTests} passed, ${failedTests} failed`);
if (failedTests === 0) {
  console.log("All tests passed!");
  process.exit(0);
} else {
  console.log(`${failedTests} test(s) failed`);
  process.exit(1);
}
