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

Push Pals is a **queue-based polling architecture** rather than a WebSocket-based event system, for improved reliability, scalability, and clarity.

```
Client (HTTP POST)
        ↓
Local Agent HTTP Server
        ├─ Detects repo root from cwd
        ├─ Reads git status, branch, commits
        ├─ Enhances prompt with LLM + repo context
        └─ Streams status updates back to client (SSE)
        └─ POST /requests/enqueue
        ↓
Request Queue (SQLite: pushpals.db)
        ├─ Status: pending → claimed → completed/failed
        └─ Atomic claiming via transactions
        ↓
Remote Agent (polls every 2s)
        ├─ POST /requests/claim
        ├─ Detects repo root from cwd
        ├─ Processes with LLM brain
        ├─ Creates tasks and enqueues jobs
        └─ POST /requests/:id/complete
        ↓
Job Queue (SQLite: pushpals.db)
        ↓
Worker (polls every 2s)
        ├─ Executes job
        ├─ Creates git commit on branch: agent/{workerId}/{jobId}
        ├─ Pushes branch to origin
        └─ POST /completions/enqueue
        ↓
Completion Queue (SQLite: pushpals.db)
        ├─ Status: pending → claimed → processed/failed
        └─ Contains commit SHA + branch info
        ↓
Serial Pusher (polls every 10s)
        ├─ POST /completions/claim
        ├─ Fetches branch from remote
        ├─ Creates temp branch and merges
        ├─ Runs checks: bun run format, bun run test
        ├─ If pass: FF merge to main (NO automatic push)
        └─ POST /completions/:id/processed
        ↓
User manually runs: git push origin main
```

## Key Components

### 1. **Request Queue** (`apps/server/src/requests.ts`)

- **Purpose**: Stores enhanced prompts from Local Agent for Remote Agent
- **Schema**: `id, sessionId, originalPrompt, enhancedPrompt, status, agentId, result, error`
- **Endpoints**:
  - `POST /requests/enqueue` - Local Agent enqueues enhanced prompts
  - `POST /requests/claim` - Remote Agent claims requests
  - `POST /requests/:id/complete` - Mark request done
  - `POST /requests/:id/fail` - Mark request failed

### 2. **Completion Queue** (`apps/server/src/completions.ts`)

- **Purpose**: Stores completed work with commit info for Serial Pusher
- **Schema**: `id, jobId, sessionId, commitSha, branch, message, status, pusherId`
- **Endpoints**:
  - `POST /completions/enqueue` - Worker enqueues completed work
  - `POST /completions/claim` - Serial Pusher claims completions
  - `POST /completions/:id/processed` - Mark completion processed
  - `POST /completions/:id/fail` - Mark completion failed

### 3. **Local Agent** (`apps/agent-local`)

- **Type**: HTTP Server (port 3003)
- **Detects**: Repo root from `process.cwd()`
- **Functionality**:
  - Receives client messages via `POST /message`
  - Reads git status, branch, recent commits
  - Enhances prompt with LLM + repo context
  - Streams status updates to client via SSE
  - Enqueues to Request Queue
- **Status Updates** (SSE):
  ```
  data: {"type":"status","message":"Detected repo: /path/to/repo"}
  data: {"type":"status","message":"Reading git status, branch, and commits..."}
  data: {"type":"status","message":"Current branch: main","data":{"branch":"main"}}
  data: {"type":"status","message":"Enhancing prompt with LLM..."}
  data: {"type":"status","message":"Enhanced prompt (542 chars)"}
  data: {"type":"status","message":"Enqueuing to Request Queue..."}
  data: {"type":"complete","message":"Request enqueued successfully","data":{"requestId":"...","sessionId":"..."}}
  ```

### 4. **Remote Agent** (`apps/agent-remote`)

- **Type**: Polling Daemon
- **Detects**: Repo root from `process.cwd()`
- **Functionality**:
  - Polls `/requests/claim` every 2 seconds
  - Processes enhanced prompts with LLM brain
  - Creates tasks and enqueues jobs to Job Queue
  - Marks request complete
- **No longer**: WebSocket subscriptions, job completion tracking

### 5. **Worker** (`apps/worker`)

- **Type**: Polling Daemon
- **Functionality**:
  - Polls Job Queue for work
  - Executes jobs through an **OpenHands SDK wrapper** (workspace API)
  - Uses isolated git worktrees so your active workspace branch is not switched
  - Creates git commit on new branch
  - Pushes branch to origin
  - Enqueues to Completion Queue
- **Git Workflow**:
  ```bash
  # in an isolated worktree (host) or isolated container worktree (docker)
  git checkout -B agent/{workerId}/{jobId}
  git add -A
  git commit -m "{kind}: {taskId}\n\nJob: {jobId}\nWorker: {workerId}"
  git push origin agent/{workerId}/{jobId}
  ```

### 6. **Serial Pusher** (`apps/serial-pusher`)

- **Type**: Polling Daemon
- **Functionality**:
  - Polls `/completions/claim` every 10 seconds
  - Fetches branch from remote
  - Creates temp branch: `_serial-pusher/{completionId}`
  - Merges agent branch into temp
  - Runs checks: `bun run format`, `bun run test`
  - If checks pass: FF merges to main
  - **Does NOT push** to remote (user pushes manually)
  - Marks completion as processed/failed

### 7. **Client** (`apps/client`)

- **Type**: React Native/Web App
- **Functionality**:
  - Sends messages to Local Agent at `http://localhost:3003/message`
  - Receives SSE status updates during processing
  - Subscribes to Server for events (assistant messages, task updates)
- **Environment**: `EXPO_PUBLIC_LOCAL_AGENT_URL=http://localhost:3003`

## Running the System

### Prerequisites

- **Bun** runtime installed
- **Git** repository with remote configured
- **LLM API Key** (OpenAI, Anthropic, or Ollama endpoint)

### Environment Variables

Create `.env` file in root:

```bash
# Server
PUSHPALS_SERVER_URL=http://localhost:3001
PUSHPALS_DATA_DIR=./outputs/data

# Local Agent
LOCAL_AGENT_PORT=3003
PUSHPALS_SESSION_ID=dev

# Remote Agent
REMOTE_AGENT_POLL_MS=2000
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
# or
LLM_ENDPOINT=http://localhost:11434/v1  # Ollama

# Worker
WORKER_POLL_MS=2000
# Executor backend: "openhands" (default) or "native" (legacy fallback)
WORKER_EXECUTOR=openhands
# Optional python binary for wrapper process
WORKER_OPENHANDS_PYTHON=python
# Optional workspace-side python binary used by OpenHands commands
WORKER_OPENHANDS_WORKSPACE_PYTHON=python3
# Max time per OpenHands job execution
WORKER_OPENHANDS_TIMEOUT_MS=120000
# Require Docker isolation when running --docker
WORKER_REQUIRE_DOCKER=1

# Serial Pusher
SERIAL_PUSHER_POLL_MS=10000
SERIAL_PUSHER_SERVER_URL=http://localhost:3001

# Client
EXPO_PUBLIC_LOCAL_AGENT_URL=http://localhost:3003
EXPO_PUBLIC_PUSHPALS_SESSION_ID=dev
```

## Flow

| Aspect                   | Polling                    |
| ------------------------ | -------------------------- |
| **Client → Server**      | Via Local Agent            |
| **Request Distribution** | Request Queue polling      |
| **Prompt Enhancement**   | Local Agent enhances first |
| **Job Completion**       | Completion Queue           |
| **Merge Process**        | Completion Queue polling   |
| **Status Updates**       | SSE from Local Agent       |
| **Repo Detection**       | Auto-detect from cwd       |
| **Push to Remote**       | Manual (user controlled)   |

## Database Schema

All queues use the same SQLite database: `pushpals.db`

**requests table:**

```sql
CREATE TABLE requests (
    id             TEXT PRIMARY KEY,
    sessionId      TEXT NOT NULL,
    originalPrompt TEXT NOT NULL,
    enhancedPrompt TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    agentId        TEXT,
    result         TEXT,
    error          TEXT,
    createdAt      TEXT NOT NULL,
    updatedAt      TEXT NOT NULL
);
CREATE INDEX idx_requests_status ON requests(status);
```

**completions table:**

```sql
CREATE TABLE completions (
    id        TEXT PRIMARY KEY,
    jobId     TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    commitSha TEXT,
    branch    TEXT,
    message   TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending',
    pusherId  TEXT,
    error     TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
CREATE INDEX idx_completions_status ON completions(status);
```

## Security Notes

- Local Agent runs with **full repo access** (started from repo root)
- Remote Agent runs with **full repo access** (started from repo root)
- Worker creates **branches and commits** (pushes to origin)
- Serial Pusher **merges to main locally** (no automatic push)
- **User reviews** git log before pushing: `git log --oneline -10`
- **User controls** when changes go to remote: `git push origin main`

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
# or use the stable wrapper:
# bun run start
# `start` preflights Docker and auto-builds the worker image if missing.
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
- `worker:only:docker` = strict Docker worker mode (`--docker --require-docker`) using OpenHands wrapper execution
- `worker:only` = host mode worker (still OpenHands-backed by default)
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
