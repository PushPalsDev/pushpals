# agent-remote — Remote Orchestrator

Lightweight orchestrator (no DB) that maintains in-memory task/job state
and uses cursor replay for reconnects. Subscribes to a PushPals session via
WebSocket, reacts to user `message` events, creates tasks, enqueues jobs for
workers, and closes out tasks when jobs complete or fail.

## Usage

```bash
bun run dev                       # watch mode
bun run start                     # one-shot

# CLI flags
bun run src/index.ts \
  --server http://localhost:3001 \
  --sessionId <uuid>              # omit to auto-create
  --token <auth-token>            # or set PUSHPALS_AUTH_TOKEN
```

## Event flow

```
Client  ──POST /message──▶  Server  ──emit message──▶  agent-remote
                                                            │
                                          emit task_created ◀┘
                                          emit task_started
                                          POST /jobs/enqueue
                                          emit job_enqueued
                                                            │
Worker  ──emit job_completed/failed──▶  agent-remote        │
                                          emit task_completed / task_failed
```
