# PushPals Server

A simple Bun-based server that streams events to clients via **SSE (Server-Sent Events)** and **WebSocket**.

## Quick Start

```bash
# Install dependencies (from repo root)
bun install

# Run the server
bun --cwd apps/server dev

# Server runs on http://localhost:3001
```

## Architecture

### Event Bus

Each session has an internal `SessionEventBus` that:

- Manages subscriptions (in-memory)
- Validates events against JSON Schema before emitting
- Notifies all SSE and WebSocket subscribers simultaneously

### Endpoints

- `POST /sessions` - Create a new session
- `GET /sessions/:id/events` - SSE stream
- `GET /sessions/:id/ws` - WebSocket stream
- `POST /sessions/:id/message` - Send a message
- `POST /approvals/:id` - Submit approval decision

### Session Manager

Global `SessionManager` handles:

- Session creation and lifecycle
- Event emission
- Approval workflows
- In-memory storage (cleared on restart)

## Key Features

✅ Validates all events against JSON Schema  
✅ SSE and WebSocket emit identical EventEnvelope messages  
✅ Same event bus for both transports  
✅ In-memory approvals and sessions  
✅ Keepalive pings on SSE (15 seconds)  
✅ 100% local; no external dependencies

## Files

- `src/index.ts` - HTTP server and route handlers
- `src/events.ts` - SessionEventBus and SessionManager

## Protocol

All events conform to the shared `EventEnvelope` schema in `packages/protocol`.

See [Protocol README](../../packages/protocol/README.md) for details.

## Future

- Persist sessions to database (PostgreSQL)
- Real Git integration (currently mocked)
- Authentication / authorization
- Rate limiting
