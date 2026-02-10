# Push Pals

**Multi-device, autonomous always-on multi-agent coding — with observability and safety.**

Push Pals™ is a self-hostable "coding team" that lives alongside your repo. You can talk to it from any device (including your phone). It coordinates multiple code-capable agents on a server to plan, implement, test, and land changes — **and it keeps working even if your laptop sleeps**.

Instead of one monolithic agent doing everything, Push Pals acts like a tiny engineering org:

- **Client** (mobile/web/desktop) for chat, diffs, logs, artifacts, approvals
- **Server** (remote) as the event hub + persistence + job queue (SQLite)
- **Remote Buddy** (`agent-remote`) as the always-on orchestrator
- **Workers** (`worker`) that execute scoped jobs from the queue
- **serial-pusher** daemon that merges approved work into `main` safely and serially
- **Local Buddy** (`agent-local`, optional) that can run local-only tools if you want a "near-repo" agent

---

## The core idea: chat never blocks

Push Pals is not "turn-based chat".

When you send a message, the **Client posts it immediately to the Server**. Agents subscribe to the session event stream and respond asynchronously. This makes conversations **multi-speaker, interruptible, and always responsive**.

- chat feels instant
- you can keep talking while jobs run
- clients can disconnect/reconnect; server history persists

---

## What Push Pals does

### Ship features from your phone

Tell Push Pals what you want:

- "Add a settings screen"
- "Fix this crash and add a test"
- "Refactor the combat module"
- "Make the build faster"

Typical loop:

1. **Remote Buddy** reads the session + repo/runtime signals
2. Remote Buddy picks next action(s) and enqueues **scoped jobs**
3. **Workers** claim jobs and execute (tools, edits, tests)
4. Results come back as **reviewable diffs + artifacts**
5. If allowed, Remote Buddy lands via **serial-pusher** (or requests approval first)

### Improve your codebase continuously

Push Pals can proactively propose improvements based on signals:

- failing tests / flaky tests
- lint/typecheck errors
- CI regressions
- performance bottlenecks (slow builds/tests)
- risky patterns (security footguns, unsafe config)
- devex friction (docs, scripts, setup)

You stay in control — changes become reviewable diffs and merge-queued commits, not surprises.

---

## Design goals

### 1) Always-on orchestration (multi-device, sleep-proof)

- Remote Buddy runs server-side and continues work even if your laptop sleeps
- Server persists sessions, event history, and job state in SQLite
- Client can reconnect from any device and resume instantly

### 2) No "agent thrash"

Only **Remote Buddy** chooses what's next globally.

- Remote Buddy: decides priorities and dispatches jobs
- Workers: execute assigned jobs only (no global decision-making)
- Local Buddy (optional): can execute local-only work when explicitly used

### 3) Security first (no "agent chaos")

Push Pals is built around capabilities and approvals:

- work happens in branches/workspaces/sandboxes
- commands can be allowlisted
- secrets are never committed
- network access can be restricted
- risky actions can trigger explicit approval

### 4) Observability by default

Every run produces an audit trail:

- which tools ran
- which commands ran (and outputs)
- diffs produced
- tests executed and results
- approvals requested and granted/denied
- merge queue history

---

## Architecture

```
             (mobile/web/desktop)


┌────────────────────────────────────────┐
│                 Client                 │
│          - chat UI                     │
│          - diffs/logs/artifacts        │
│          - approvals                   │
└───────────────┬────────────────────────┘
                │ HTTP (post message/commands)
                │ SSE (subscribe events)
                v
┌────────────────────────────────────────┐
│                 Server                 │
│          - auth + sessions             │
│          - event hub (durable history) │
│          - job queue (SQLite)          │
└───────────────┬────────────────────────┘
                │ subscribe session events
                │
    ┌──────────┴───────────┐
    v                      v
┌─────────────────┐  ┌───────────────────┐
│  Remote Buddy   │  │   Local Buddy     │
│ (agent-remote)  │  │ (agent-local, opt)│
│ - global planner│  │ - local-only tools│
│ - enqueue jobs  │  │ - optional assist │
└─────────┬───────┘  └───────────────────┘
          │ enqueue
          v
┌────────────────────────────────────────┐
│               Workers                  │
│ (worker; many replicas supported)      │
│ - claim jobs atomically from SQLite    │
│ - run tools / edits / tests            │
│ - report results                       │
└───────────────┬────────────────────────┘
                │ land changes
                v
┌────────────────────────────────────────┐
│            serial-pusher               │
│         (merge queue daemon)           │
│ - watches agent branches               │
│ - merges serially → main               │
│ - runs checks → pushes                 │
└────────────────────────────────────────┘
```

---

## Shared session IDs (important)

By default, all apps join the same dev session:

- `PUSHPALS_SESSION_ID=dev` (agents)
- `EXPO_PUBLIC_PUSHPALS_SESSION_ID=dev` (Expo client)

`POST /sessions` is **create-or-join**:

- returns **201** if the session was newly created in SQLite
- returns **200** if it already existed
- returns **400** if `sessionId` contains invalid characters or is not 1–64 chars

Allowed session IDs: only `[a-zA-Z0-9._-]`, length 1–64.

---

## Repo layout (current)

- `apps/server` — Bun server: session hub + event history + job queue (SQLite)
- `apps/client` — Expo client (web + mobile) using HTTP + SSE
- `apps/agent-remote` — Remote Buddy: always-on orchestrator
- `apps/agent-local` — Local Buddy (optional): local execution + helper agent
- `apps/worker` — Worker daemon: polls job queue, executes tasks
- `apps/serial-pusher` — merge queue daemon: lands changes safely/serially

---

## Current flows

### Chat / coordination (fast path)

1. Client creates or joins a session (`POST /sessions` with optional `sessionId`)
2. Client subscribes to events (`GET /sessions/:id/events` via SSE)
3. Client posts messages (`POST /sessions/:id/message`)
4. Agents observe and emit events/commands back into the session stream

### Work execution (slow path)

1. Remote Buddy enqueues a job (`POST /jobs/enqueue`)
2. One of many Workers claims the next pending job (`POST /jobs/claim`)
3. Worker executes work and reports completion (`POST /jobs/:id/complete` or `/fail`)
4. Remote Buddy evaluates results
5. If approved: changes land via serial-pusher

> Note: claims are atomic and multi-worker-safe today. There is not yet a "lease/heartbeat" reclaim for stuck claimed jobs.

---

## Prerequisites

- Bun
- Node.js (optional for some tooling)
- Expo CLI

---

## Quick start

```bash
bun install

# Run full stack (dev session defaults to "dev")
bun run dev:full
```

If you need a custom session:

```bash
export PUSHPALS_SESSION_ID=my-session
export EXPO_PUBLIC_PUSHPALS_SESSION_ID=my-session
bun run dev:full
```

### Dev scripts notes

- `client:only` = normal Expo startup (online)
- `client:only:offline` = Expo --offline (used by dev:full)
- `serial-pusher:only` = strict (requires clean clone)
- `serial-pusher:only:dev` = runs with --skip-clean-check (used by dev:full)

---

## Event types (protocol)

| Category         | Types                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| **Chat**         | `message`, `assistant_message`, `log`, `error`, `done`                           |
| **Tasks**        | `task_created`, `task_started`, `task_progress`, `task_completed`, `task_failed` |
| **Tools**        | `tool_call`, `tool_result`                                                       |
| **Jobs**         | `job_enqueued`, `job_claimed`, `job_completed`, `job_failed`                     |
| **Approvals**    | `approval_required`, `approved`, `denied`                                        |
| **Agent status** | `agent_status`                                                                   |

---

## Status

Early-stage / under active development.

If you're interested in contributing, open a PR or reach out via push.pals.dev@gmail.com.

---

## Trademark and Licensing

**Push Pals™** and the Push Pals logo are trademarks of the project authors.

The source code is licensed under the **MIT License**, but the "Push Pals" name and branding are not included in that license. If you fork this project, please use a distinct name to avoid user confusion.
