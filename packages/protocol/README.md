# PushPals Protocol (v0.1.0)

A shared, versioned protocol package for PushPals event streaming over both SSE (web) and WebSocket (mobile/desktop).

## Overview

The protocol defines:
- **JSON Schemas** for all events and HTTP contracts
- **TypeScript types** generated from/validated against schemas
- **Runtime validators** (AJV-based) for both server and client
- **A2A adapter scaffolding** for future Agent-to-Agent integration

## Files

- `src/version.ts` - Protocol version constant (0.1.0)
- `src/types.ts` - TypeScript type definitions
- `src/validate.ts` - Runtime validators (Ajv)
- `src/index.ts` - Public API
- `src/schemas/` - JSON Schema definitions
  - `envelope.schema.json` - Base event envelope structure
  - `events.schema.json` - Event type discriminator + payloads
  - `http.schema.json` - HTTP request/response contracts
  - `approvals.schema.json` - Approval workflow schemas
- `src/a2a/` - A2A adapter scaffolding (future)
  - `README.md` - Architecture notes
  - `mapping.ts` - Placeholder interfaces

## Event Types

All events conform to `EventEnvelope`:

```typescript
{
  protocolVersion: "0.1.0",
  id: string,              // UUID or other unique ID
  ts: string,              // ISO-8601 timestamp
  sessionId: string,       // Session identifier
  type: EventType,         // Discriminator
  traceId?: string,        // Optional for debugging
  payload: Record<string, unknown>
}
```

### Supported Types

- `log` - Debug/info/warn/error logging
- `scan_result` - Repository scan results
- `suggestions` - List of actionable suggestions
- `diff_ready` - Diff and stat information
- `approval_required` - Awaiting human approval
- `approved` / `denied` - Approval decisions
- `committed` - Git commit result
- `error` - Error event
- `done` - Workflow completed

## Usage

### In Server (apps/server)

```typescript
import {
  EventEnvelope,
  validateEventEnvelope,
  PROTOCOL_VERSION,
} from "protocol";

const envelope: EventEnvelope = {
  protocolVersion: PROTOCOL_VERSION,
  id: randomUUID(),
  ts: new Date().toISOString(),
  sessionId: "...",
  type: "log",
  payload: { level: "info", message: "Hello" },
};

const validation = validateEventEnvelope(envelope);
if (validation.ok) {
  // Send via SSE or WebSocket
}
```

### In Client (apps/client)

```typescript
import { subscribeEvents } from "./lib/pushpalsApi";

subscribeEvents("http://localhost:3001", sessionId, (event) => {
  if (event.type === "_error") {
    console.error(event.message);
    return;
  }

  console.log(`Event: ${event.type}`, event.payload);
});
```

## HTTP Contracts

### POST /sessions
**Response:**
```json
{ "sessionId": "uuid", "protocolVersion": "0.1.0" }
```

### POST /sessions/:id/message
**Request:**
```json
{ "text": "user input" }
```
**Response:**
```json
{ "ok": true }
```

### POST /approvals/:approvalId
**Request:**
```json
{ "decision": "approve" | "deny" }
```
**Response:**
```json
{ "ok": true }
```

### GET /sessions/:id/events (SSE)
Content-Type: `text/event-stream`
```
event: message
data: <JSON EventEnvelope>
```

### GET /sessions/:id/ws (WebSocket)
Sends EventEnvelope as JSON messages.

## Validation

All validators are compiled at module load time for performance:

```typescript
import {
  validateEventEnvelope,
  validateMessageRequest,
  validateApprovalDecisionRequest,
} from "protocol";

const result = validateEventEnvelope(data);
if (!result.ok) {
  console.error("Validation errors:", result.errors);
}
```

## Notes

- Protocol version is pinned to **0.1.0** across all envelopes
- Event IDs should be UUIDs for traceability
- All times are ISO-8601 UTC
- The protocol is immutable; changes require a version bump
- A2A integration is future work; see `src/a2a/README.md`
