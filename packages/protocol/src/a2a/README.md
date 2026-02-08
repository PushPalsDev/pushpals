# A2A Protocol Adapter (Future)

## Overview

PushPals will provide an adapter layer to support integration with the [A2A (Agent-to-Agent) Project](https://github.com/a2aproject).

This directory contains placeholders and design notes for how PushPals events and approvals will map to A2A message formats.

## Mapping Strategy

### EventEnvelope → A2A Message

PushPals `EventEnvelope` and A2A message envelopes share similar concerns:
- Versioning
- Tracing (id, traceId)
- Timestamps
- Payload discrimination by type

**Planned mapping:**
- `EventEnvelope.id` ↔ A2A `message.id`
- `EventEnvelope.ts` ↔ A2A `message.timestamp`
- `EventEnvelope.type` ↔ A2A `message.type`
- `EventEnvelope.payload` ↔ A2A `message.body` (may require re-serialization)

### Approvals as Tool Results

A2A supports "tools" and tool invocations with results. Approvals in PushPals map naturally:
- `approval_required` event → Tool invocation awaiting result
- `approved` / `denied` events → Tool result (success/failure)

**Planned mapping:**
- `approval_required.approvalId` ↔ A2A `tool.invocationId`
- `approval_required.action` ↔ A2A `tool.name`
- `approved.approvalId` ↔ A2A `result.invocationId` with `status: "success"`
- `denied.approvalId` ↔ A2A `result.invocationId` with `status: "failure"`

## Implementation Notes

- **Not implemented yet.** No A2A dependencies or endpoints yet.
- Adapter will be in `packages/protocol/src/a2a/adapter.ts` (future).
- Server will accept A2A messages alongside native protocol (future).
- Client will be able to display A2A workflows (future).

## References

- [A2A Project](https://github.com/a2aproject)
- PushPals EventEnvelope: `packages/protocol/src/types.ts`
- PushPals Event Types: `packages/protocol/src/schemas/events.schema.json`
