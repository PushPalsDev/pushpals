# PushPals Chat Screen

This directory contains the Chat screen used by the PushPals client. The app opens directly to a single-screen chat experience.

How it works

- `app/index.tsx` — Chat UI wired to `usePushPalsSession(baseUrl)`.
- Messages are displayed as bubbles. Sending a message calls `session.send(text)` and appends a local user bubble immediately.
- Incoming server events (EventEnvelope) are mapped to assistant/system bubbles and deduplicated by envelope id.

Configuration

- The client uses `EXPO_PUBLIC_PUSHPALS_URL` (env) or falls back to `http://localhost:3001`.
- For device/emulator testing, replace the base URL with your machine's LAN IP if necessary.

Run

Use the existing scripts from the root package.json:

```bash
# Start server
bun --cwd apps/server dev

# Start client (Expo)
bun --cwd apps/client start
```
