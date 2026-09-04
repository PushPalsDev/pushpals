# PushPals Client

The Expo application is PushPals' web/mobile mission-control surface. It talks
directly to the local Server control plane; LocalBuddy is not in this path.

## What the UI shows

`app/index.tsx` provides six views over the same Server session and queue state:

- **Coordination** correlates requests, jobs, and completions.
- **Chat** submits session messages and renders user-visible lifecycle events.
- **Requests** shows planning-queue state.
- **Jobs & Traces** shows jobs, completion candidates, and bounded job logs.
- **System** shows workers, queue health, runtime state, autonomy, and questions.
- **Config** reads and updates the supported runtime configuration surface.

The client keeps one cursor-aware session stream and polls the broader
observability snapshots every four seconds. Server remains the durable owner of
all state shown by the dashboard.

## Run it

From the repository root:

```bash
bun install
bun run client
```

Use `bun run web`, `bun run ios`, or `bun run android` for a specific Expo
target. The full preflighted stack is `bun run start`.

The runtime bootstrap chooses a Server URL in this order:

1. `globalThis.__PUSHPALS_WEB_BOOTSTRAP__.serverUrl`, when the packaged CLI
   injects it.
2. `EXPO_PUBLIC_PUSHPALS_URL`.
3. `http://127.0.0.1:3001`.

URLs are normalized to loopback because PushPals currently has a local-only
control plane. A browser, emulator, or device running on another host cannot use
a LAN address without a deliberate change to that security model.

## Session transport

- Web uses SSE through `GET /sessions/:id/events?after=<cursor>`.
- native runtimes use WebSocket through `GET /sessions/:id/ws?after=<cursor>`.
- both transports carry `{ envelope, cursor }` frames.
- incoming envelopes are validated through `packages/protocol`.
- the last cursor is persisted in browser local storage or native
  `AsyncStorage`, so reconnects request only later events.

Messages go directly to `POST /sessions/:id/message`, which atomically enqueues
an interactive Server request before acknowledging the message.

```typescript
import {
  createSession,
  sendSessionMessage,
  subscribeEvents,
} from "./src/lib/pushpalsApi";

const serverUrl = "http://127.0.0.1:3001";
const session = await createSession(serverUrl, "dev");
if (!session) throw new Error("Server session unavailable");

const unsubscribe = subscribeEvents(
  serverUrl,
  session.sessionId,
  (envelope, cursor) => console.log(cursor, envelope),
);

await sendSessionMessage(serverUrl, session.sessionId, "Inspect the queue");
unsubscribe();
```

## Important files

- `app/index.tsx` - mission-control composition and snapshot polling.
- `src/lib/runtimeBootstrap.ts` - packaged/environment runtime settings.
- `src/lib/usePushPalsSession.ts` - session creation, cursor persistence, event
  reduction, filtering, and approval actions.
- `src/lib/pushpalsApi.ts` - bounded HTTP, SSE, WebSocket, and observability APIs.
- `src/components/` - coordination, chat, request, job, system, and config views.

See [`docs/wiki/09-client-surfaces.md`](../../docs/wiki/09-client-surfaces.md)
for the CLI and VS Code surfaces as well as the Expo client.
