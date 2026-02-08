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

// Summary
console.log(`\nResults: ${passedTests} passed, ${failedTests} failed`);
if (failedTests === 0) {
  console.log("All tests passed!");
  process.exit(0);
} else {
  console.log(`${failedTests} test(s) failed`);
  process.exit(1);
}
