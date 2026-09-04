# PushPals Protocol (v0.1.0)

The `protocol` workspace defines PushPals' shared session-event contracts. It is used by Server, the browser and native clients, and the agent services that publish events through Server.

This package covers:

- the versioned `EventEnvelope` and every supported event payload;
- the core session, command, message, and approval HTTP shapes;
- the cursor-bearing frame delivered over SSE and WebSocket;
- AJV runtime validators for filesystem-backed Bun services and browser/React Native consumers; and
- future Agent-to-Agent (A2A) adapter scaffolding.

Queue, autonomy-management, memory, and other operational Server APIs use service-local contracts and are not part of this package.

## Sources of truth

- `src/version.ts` contains `PROTOCOL_VERSION` (`0.1.0`).
- `src/types.ts` contains the hand-maintained TypeScript contracts.
- `src/schemas/envelope.schema.json` defines the envelope and event-name enum.
- `src/schemas/events.schema.json` defines each event's payload.
- `src/schemas/http.schema.json` defines the core HTTP and transport-frame shapes.
- `src/validate.ts` and `src/validate.browser.ts` expose the filesystem-backed and browser validators.
- `src/a2a/` is design scaffolding only; A2A transport is not implemented.

The TypeScript declarations are not generated. When a contract changes, update the declarations, JSON Schemas, validators, tests, and this document together.

## Event envelope

Every persisted session event uses this shape:

```typescript
interface EventEnvelope<T extends EventType = EventType> {
  protocolVersion: "0.1.0";
  id: string;
  ts: string; // ISO-8601 date-time
  sessionId: string;
  type: T;
  payload: EventTypePayloadMap[T];

  traceId?: string;
  from?: string;
  to?: string;
  correlationId?: string;
  parentId?: string;
  turnId?: string;
}
```

`id` identifies the event. It is distinct from the numeric database `cursor` used for ordered replay.

### Supported event types

The complete event-name set is:

- Conversation and status: `message`, `assistant_message`, `log`, `status`, `agent_status`, `error`, `done`.
- Repository workflow: `scan_result`, `suggestions`, `diff_ready`, `committed`.
- Approvals: `approval_required`, `approved`, `denied`.
- Task lifecycle: `task_created`, `task_started`, `task_progress`, `task_completed`, `task_failed`.
- Tools and delegation: `tool_call`, `tool_result`, `delegate_request`, `delegate_response`.
- Job lifecycle: `job_enqueued`, `job_claimed`, `job_completed`, `job_failed`, `job_log`.
- Autonomy: `autonomy_cycle_started`, `autonomy_candidates_generated`, `autonomy_objective_dispatched`, `autonomy_objective_blocked`, `autonomy_feedback_recorded`.
- Questions: `question_asked`, `question_answered`.

Use `EventTypePayloadMap` or `events.schema.json` for the exact payload required by each name.

## HTTP contracts

These are the core session routes implemented by Server. Create or join a session before opening its event stream.

### Create or join a session

`POST /sessions`

The body is optional. A caller may request a stable session ID and announce client-presence metadata:

```json
{
  "sessionId": "dev",
  "client": {
    "clientId": "web-7c2f",
    "kind": "web",
    "label": "Web Client",
    "version": "1.2.47",
    "platform": "web",
    "repoRoot": "C:/src/project"
  }
}
```

`sessionId` must contain only letters, digits, `.`, `_`, or `-` and be 1-64 characters. Server generates an ID when it is omitted. A new session returns HTTP 201; joining an existing session returns HTTP 200. Both return:

```json
{ "sessionId": "dev", "protocolVersion": "0.1.0" }
```

### Submit a user message

`POST /sessions/:id/message`

```json
{
  "text": "Inspect the failing queue",
  "intent": { "surface": "dashboard", "readOnly": true }
}
```

`intent` is optional, opaque object metadata. Scalar and array values are rejected. On success, Server persists a `message` event and normally enqueues a RemoteBuddy request. The acknowledgment includes the accepted event ID and, when queue ingress is active, queue metadata:

```json
{
  "ok": true,
  "code": "accepted",
  "eventId": "event-uuid",
  "requestId": "request-uuid",
  "queuePosition": 1,
  "etaMs": 0
}
```

`requestId`, `queuePosition`, and `etaMs` are optional. Failure codes are `invalid`, `session_not_found`, and `enqueue_failed`, with a human-readable `message` when available.

### Publish an agent event

`POST /sessions/:id/command`

```json
{
  "type": "task_progress",
  "payload": { "taskId": "task-uuid", "message": "Running tests", "percent": 75 },
  "from": "worker:worker-1",
  "correlationId": "request-uuid",
  "turnId": "turn-uuid"
}
```

`from`, `to`, `correlationId`, `turnId`, and `parentId` are optional routing metadata. A successful response is `{ "ok": true, "eventId": "event-uuid" }`; failures may include `message`.

### Submit an approval decision

`POST /approvals/:approvalId`

```json
{ "decision": "approve" }
```

`decision` must be either `approve` or `deny`. The response contains `ok` and may contain an error `message`.

## SSE and WebSocket delivery

Both transports deliver the same `SessionEventFrame` JSON object:

```json
{
  "envelope": {
    "protocolVersion": "0.1.0",
    "id": "event-uuid",
    "ts": "2026-09-03T12:00:00.000Z",
    "sessionId": "dev",
    "type": "assistant_message",
    "payload": { "text": "Ready" }
  },
  "cursor": 42
}
```

The `cursor` is the persisted SQLite event sequence. Consumers should retain the highest processed cursor and reconnect with `?after=<cursor>`; Server replays events whose cursor is greater than that value before subscribing the connection to live events. If the supplied cursor is ahead of Server's latest cursor, Server resets replay to zero. The current replay query is bounded to 1,000 events per connection.

Client-presence metadata can accompany either transport through `clientId`, `clientKind`, `clientLabel`, `clientVersion`, `clientPlatform`, and `clientRepoRoot` query parameters. Only `clientId` and `clientKind` are required for a presence record.

### SSE

`GET /sessions/:id/events?after=41`

The response has `Content-Type: text/event-stream`. Server sends comment keepalives and default SSE message events; it does not send an explicit `event:` field.

```text
: keepalive

id: 42
data: {"envelope":{...},"cursor":42}

```

The SSE `id` and JSON `cursor` carry the same value.

### WebSocket

`GET /sessions/:id/ws?after=41`

After the HTTP upgrade, each text message is the JSON `SessionEventFrame` shown above. Server uses WebSocket ping frames for connection liveness.

## Usage

### Validate and publish an event

```typescript
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type EventEnvelope, validateEventEnvelope } from "protocol";

const envelope: EventEnvelope<"log"> = {
  protocolVersion: PROTOCOL_VERSION,
  id: randomUUID(),
  ts: new Date().toISOString(),
  sessionId: "dev",
  type: "log",
  payload: { level: "info", message: "Hello" },
};

const validation = validateEventEnvelope(envelope);
if (!validation.ok) {
  throw new Error(validation.errors?.join("; "));
}
```

### Subscribe from the Expo client

```typescript
import { subscribeEvents } from "./lib/pushpalsApi";

const unsubscribe = subscribeEvents(
  "http://127.0.0.1:3001",
  sessionId,
  (envelope, cursor) => {
    if (envelope.type === "error") {
      console.error(envelope.payload.message);
      return;
    }

    saveReplayCursor(cursor);
    console.log(envelope.type, envelope.payload);
  },
  "auto",
  lastReplayCursor,
);

// Call when the component or session is disposed.
unsubscribe();
```

Client-generated transport and parsing failures are delivered to this callback as ordinary `error` envelopes; there is no `_error` event type.

### Available validators

```typescript
import {
  validateApprovalDecisionRequest,
  validateCommandRequest,
  validateEventEnvelope,
  validateMessageRequest,
  validateMessageResponse,
  validateSessionEventFrame,
} from "protocol";
```

The `protocol/browser` and `protocol/react-native` exports provide the same validator surface without filesystem-dependent schema loading.

## Verification and versioning

From the repository root:

```sh
bun run protocol:typecheck
bun run test:protocol
bun run protocol:build
```

The build copies all JSON Schemas into `packages/protocol/dist/schemas` for filesystem-backed runtime loading. A packaged worker runtime can instead set `PUSHPALS_PROTOCOL_SCHEMAS_DIR`.

All persisted envelopes currently require protocol version `0.1.0`. Breaking wire changes require a coordinated version bump and migration across Server, clients, and agent services. A2A integration remains future work; see `src/a2a/README.md`.
