# Push Pals

**Multi-device, autonomous always-on multi-agent coding — with observability and safety.**

Push Pals™ is a self-hostable "coding team" that lives alongside your repo. You can talk to it from any device (including your phone). It coordinates multiple code-capable agents on a remote server to plan, implement, test, and land changes — **and it keeps working even if your laptop sleeps**.

Instead of one monolithic agent doing everything, Push Pals acts like a tiny engineering org:

- a **Local Buddy** (phone/desktop) that relays chat instantly and keeps you in the loop
- a **Remote Buddy** (server-side, always-on) that decides what to do next and orchestrates work
- **Workers** that execute scoped tasks (OpenHands or other tooling)
- a **serial-pusher** daemon that merges approved work into `main` safely and serially

---

## The core idea: Local Buddy never blocks

Push Pals is not "turn-based chat."

When you send a message, **Local Buddy immediately acknowledges** and forwards it to Remote Buddy. Remote Buddy streams decisions and progress back as events. This makes conversations **multi-speaker, interruptible, and always responsive**.

- chat feels instant
- you can keep talking while jobs run
- your laptop can sleep and the system keeps progressing server-side

---

## What Push Pals does

### Ship features from your phone

Tell Push Pals what you want:

- "Add a settings screen"
- "Fix this crash and add a test"
- "Refactor the combat module"
- "Make the build faster"

Push Pals will:

1. **Remote Buddy** builds a candidate list of next actions (from repo + runtime signals)
2. Remote Buddy picks one (or a small batch)
3. Remote Buddy dispatches scoped work to workers with budgets + stop conditions
4. Workers implement and run checks
5. Results come back as **reviewable diffs and artifacts**
6. If allowed, Remote Buddy lands via **serial-pusher** (or requests approval first)

### Improve your codebase continuously

Push Pals can proactively propose improvements based on repo signals:

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
- Server persists sessions, event history, and job state
- Local Buddy can reconnect from any device and resume instantly

### 2) No "agent thrash"

Only **Remote Buddy** chooses what's next globally.

- **Remote Buddy**: decides priorities and dispatches jobs
- **Local Buddy**: relays chat + can propose candidate next actions
- **Workers**: execute assigned tasks only (no global decision-making)

### 3) Security first (no "agent chaos")

Push Pals is built around capabilities and approvals:

- workers run in isolated workspaces/sandboxes
- commands are allowlisted by default
- secrets are never committed
- network access can be restricted
- anything risky triggers a clear approval request

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
     LOCAL (near you)                          REMOTE (remote & always-on)
┌─────────────────────────┐               ┌─────────────────────────┐
│       Client            │               │       Server            │
│                         │               │                         │
│                   WS/SSE events + chat + approvals                │
│                         │◄─────────────►│                         │
│ (mobile/desktop/web)    │               │ (auth + sessions + hub) │
│ - chat UI               │               │ - routes events         │
│ - diffs/logs/artifacts  │               │ - persists session state│
│ - approvals             │               └───────────┬─────────────┘
└───────────┬─────────────┘                           │
            │ (optional local hop)                    │
            v                                         v
┌──────────────────────────┐               ┌───────────────────────────┐
│     Local Buddy (AI)     │               │     Remote Buddy (AI)     │
│                          │               │                           │
│                     proposals / status / questions                   │
│                          │◄─────────────►│                           │
│ (fast companion daemon)  │               │ (global scheduler/planner)│
│ - immediate ACK to client│               │ - picks "what's next"     │
│ - local-only tools       │               │ - dispatches work         │
│ - proposes next-actions  │               │ - evaluates outcomes      │
│ - executes assigned work │               │ - retries/abandons        │
└──────────────────────────┘               └───────────┬───────────────┘
                                                       │ dispatch tasks
                                                       v
                                          ┌─────────────────────────┐
                                          │       Workers           │
                                          │ (OpenHands/tool runners)│
                                          │ - execute scoped tasks  │
                                          │ - produce branches/diffs│
                                          │ - report results        │
                                          └───────────┬─────────────┘
                                                      │ land changes
                                                      v
                                          ┌─────────────────────────┐
                                          │    serial-pusher        │
                                          │  (merge queue daemon)   │
                                          │ - watches agent branches│
                                          │ - merges serially → main│
                                          │ - runs checks → pushes  │
                                          └─────────────────────────┘
```

### Responsibilities

**Local Buddy (local client-side AI)**

- Runs near the client (phone/desktop/laptop)
- Chat UI + intent shaping
- Immediate ACK + forward to the Server/Remote Buddy
- Streams remote events back to the client UI
- May execute _assigned_ work locally (optional), but does not choose global tasks

**Server (remote event hub + persistence)**

- Session state + multi-device message history
- Durable queues (jobs, outbox/events)
- Authentication and policy enforcement plumbing
- Transport: SSE (web) + WebSocket (mobile/desktop)

**Remote Buddy (remote AI always-on brain)**

- Reads repo + runtime signals
- Builds "candidate next actions"
- Picks next work item(s) and dispatches to workers
- Evaluates results (checks + heuristics)
- If good: lands via serial-pusher (or requests approval)

**Workers (remote AI dedicated workers) **

- Code-capable agents (e.g., OpenHands) and/or tooling
- Receive a scoped task, produce artifacts, run checks
- Never push to `main` directly

**serial-pusher (remote git merge queue daemon)**

- Watches for agent branches and merges them serially into `main`
- Runs configurable checks and safely pushes the result
- Pins jobs to SHAs to avoid stale merges

---

## Repo layout (current)

- **`packages/protocol`**: Shared schema definitions, TypeScript types, Ajv validators
- **`apps/server`**: Bun server — event hub + session state + job queue (SQLite)
- **`apps/client`**: Expo client (web + mobile) with automatic transport selection
- **`apps/agent-local`**: Local Buddy daemon — instant relay, optional local execution, approvals UI bridge
- **`apps/worker`**: Worker daemon — polls job queue, executes heavy tasks
- **`apps/serial-pusher`**: SQLite-backed merge-queue daemon for safe merges to `main`

---

## Current flows

### Chat / coordination (fast path)

1. Client sends a message to Local Buddy
2. Local Buddy immediately ACKs and forwards it to the Server/Remote Buddy
3. Remote Buddy emits streaming events (questions, status, decisions)
4. Local Buddy relays events to the client UI

### Work execution (slow path)

1. Remote Buddy enqueues a job to the Server queue
2. A Worker claims the job and executes (tool calls, code changes, tests)
3. Worker publishes artifacts and diffs back through the Server
4. Remote Buddy evaluates
5. If approved: changes land via serial-pusher

---

## Safety model (high level)

Push Pals treats a repo like production equipment:

- changes happen on branches/workspaces
- results come back as diffs + proposed commits
- push/commit/PR creation can require explicit approval
- unapproved commands don't run

---

## Prerequisites

- **Bun** (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js** (optional, for dev tools)
- **Expo CLI** (`bun add -g expo-cli`)

---

## Quick start

```bash
bun install

# Build protocol (required first time)
cd packages/protocol && bun run build && cd ../..

# Auth token (used by server, agent-local, worker)
export PUSHPALS_AUTH_TOKEN=my-secret-token

# Run full stack
bun run dev:full
```

---

## Dogfood scenario (definition of done)

Use Push Pals to change Push Pals:

1. **Start the stack**: `bun run dev:full`
2. **Open the UI** at `http://localhost:8081`
3. **Send a message**: "Run git status on this repo"
4. **Watch the trace** in the UI:
   - Local Buddy **ACKs instantly**
   - Remote Buddy streams `task_created` → `task_started`
   - `tool_call` (git.status) → `tool_result`
   - `task_completed` with summary
   - `agent_status` returns to idle
5. **Try an approval flow**: "Apply a patch to fix the README"
   - UI shows **Approve / Deny**
   - Approve → `approved` event → tool runs → `diff_ready`
6. **Try the "always-on" path**:
   - Start a longer task (e.g. "Run tests and fix failures")
   - Close your laptop / disconnect the client
   - Reopen later from another device and confirm:
     - the session history is still there
     - jobs continued running server-side
     - results and artifacts are available

Smoke test:

```bash
# Requires server + agent-local running
PUSHPALS_AUTH_TOKEN=my-secret-token bun run scripts/smoke-test.ts
```

---

## Event types (protocol)

| Category       | Types                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| **Chat**       | `assistant_message`, `log`, `error`, `done`                                      |
| **Repo**       | `scan_result`, `suggestions`, `diff_ready`, `committed`                          |
| **Approvals**  | `approval_required`, `approved`, `denied`                                        |
| **Agent**      | `agent_status`                                                                   |
| **Tasks**      | `task_created`, `task_started`, `task_progress`, `task_completed`, `task_failed` |
| **Tools**      | `tool_call`, `tool_result`                                                       |
| **Delegation** | `delegate_request`, `delegate_response`                                          |
| **Jobs**       | `job_enqueued`, `job_claimed`, `job_completed`, `job_failed`                     |

---

## Status

Early-stage / under active development.

If you're interested in contributing, feel free to open a PR. Or get in touch via `push.pals.dev@gmail.com`

---

## Trademark and Licensing

**Push Pals™** and the Push Pals logo are trademarks of the project authors.

While the source code of this project is licensed under the **MIT License**, the "Push Pals" name and branding are not included in that license. If you fork this project or use the code in your own product, please use a distinct name to avoid user confusion.
