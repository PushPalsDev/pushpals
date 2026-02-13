# PushPals Client

Expo-based client for iOS, Android, and web.

## Quick Start

```bash
# Install dependencies (from repo root)
bun install

# Run web version
bun web

# Run on iOS
bun ios

# Run on Android
bun android
```

## Architecture

### Transport Selection

The client automatically selects the best transport:

- **Web**: SSE via `EventSource`
- **Native / Desktop**: WebSocket

### Event Subscription

Use the `usePushPalsSession` hook:

```typescript
import { usePushPalsSession } from "./lib/usePushPalsSession";

export function MyComponent() {
  const { sessionId, events, isConnected, send } = usePushPalsSession(
    "http://localhost:3001"
  );

  return (
    // Display events and allow sending messages
  );
}
```

Or use the lower-level API:

```typescript
import {
  subscribeEvents,
  createSession,
  sendMessage,
  submitApprovalDecision,
} from "./lib/pushpalsApi";

const sessionId = await createSession("http://localhost:3001");
const unsubscribe = subscribeEvents("http://localhost:3001", sessionId, (event) => {
  console.log(event);
});

await sendMessage("http://localhost:3003", "Hello");
await submitApprovalDecision("http://localhost:3001", approvalId, "approve");

unsubscribe();
```

## Protocol

The client uses shared `EventEnvelope` types and validators from `packages/protocol`.

- Validates all incoming events
- Emits standard `error` envelopes for validation/transport failures
- Handles both SSE and WebSocket errors

## Components

- `lib/pushpalsApi.ts` - Low-level API (subscribe, send, approve)
- `lib/usePushPalsSession.ts` - React hook for session management
- `lib/PushPalsDemo.tsx` - Demo component

## Future

- Display suggestions in native UI
- Real approval flow (currently streams mock events)
- Syntax highlighting for diffs
- File explorer for scan results
