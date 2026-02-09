# Push Pals

**Multi-agent coding orchestration with observability and security in mind.**

Push Pals is a self-hostable “coding team” that lives alongside your repo. You talk to it from any device (including your phone), and it coordinates multiple code-capable agents on a remote server to plan, implement, test, and propose changes—without silently doing risky operations.

Instead of one monolithic agent doing everything, Push Pals acts like a tiny engineering org:

- a **Local Companion** (mobile/desktop) that understands your intent and keeps you in the loop
- a **Remote Orchestrator** (self-hosted on your cloud box) that manages workspaces, runs agents, and enforces policy
- a set of **Worker Agents** (e.g., OpenHands or other tooling) that do focused tasks and report back

---

## What Push Pals does

### Ship features from your phone

Tell Push Pals what you want:

- “Add a settings screen”
- “Fix this crash and add a test”
- “Refactor the combat system module”
- “Make the build faster”

... and keep talking and assigning to it while background agents work on other tasks! You can even get status reports on all the tasks while they are running! Agent to agent communication in the background without foreground ever being blocked!

Push Pals will:

1. create a plan and a small backlog of tasks
2. run multiple workers in parallel (each on a small, scoped ticket)
3. run tests/lint/build checks
4. set a **reviewable diff** and a **proposed commit/PR**
5. local agent notify you of this commit and ask you to approve before it commits/pushes
6. Optional: If you give agent permission, it can just auto-commit the changes, move on, and you can review later on your own time.

### Improve your codebase continuously

Push Pals can proactively propose improvements based on repo signals:

- failing tests / flaky tests
- lint/typecheck errors
- performance bottlenecks (build time, bundle size)
- risky patterns (security footguns, unsafe config)
- missing docs/devex friction

You stay in control—changes become PRs, not surprises.

---

## Design goals

### 1) Orchestration that feels like a team

- Multiple helpers working in parallel
- One orchestrator coordinating tasks and consolidating results
- Small PRs with clear scopes

### 2) Security first (no “agent chaos”)

Push Pals is built around **capabilities and approvals**:

- workers run in isolated workspaces/sandboxes
- commands are allowlisted by default
- secrets are never committed
- network access can be restricted
- anything risky triggers a clear approval request

### 3) Observability by default

Every run produces a full audit trail:

- which tools ran
- which commands ran (and outputs)
- diffs produced
- tests executed and results
- approvals requested and granted/denied

### 4) Proactive codebase improvement

Push Pals doesn’t just respond to requests — it can continuously propose high-leverage improvements:

- detect failing/flaky tests, lint/type errors, and CI regressions
- surface performance bottlenecks (slow builds, slow tests, large bundles)
- identify risky patterns (security footguns, unsafe configs, dependency issues)
- suggest refactors and cleanup (dead code, duplicated logic, TODO hotspots)
- improve developer experience (docs, scripts, setup, tooling)
- bundle suggestions into small, reviewable PRs with clear rationale

This makes it safe to use in real repos.

---

## How it works

### Components

**Local PushPal (Client + Companion)**

- Runs on phone/desktop
- Chat UI + “intent shaping”
- Shows diffs, logs, artifacts
- Handles approvals (“Commit?”, “Push?”, “Open PR?”)

**Remote PushPal (Orchestrator)**

- You self-host it (e.g., EC2, or even on the same computer!)
- Owns repo workspaces (clones), branches, sandboxes
- Spawns and coordinates workers
- Enforces policy (command allowlist, network rules)
- Requests approvals for risky actions

**Workers**

- Code-capable agents (e.g., OpenHands) and/or other tooling
- Receive a scoped task, produce artifacts, run checks
- Never push to main directly

---

## Safety model (high level)

Push Pals treats a repo like production equipment:

- changes happen on a branch
- results come back as diffs + proposed commits
- **push/commit/PR creation require approval**
- unapproved commands don’t run

---

## Use cases

- Build features while away from your laptop
- Coordinate multiple code agents without losing control
- Keep a repo healthy with automated improvements
- Run safe refactors with tight audit trails
- Turn “idea → PR” into a fast, reviewable workflow

---

## Status

Early-stage / under active development.

If you’re interested in contributing, feel free to open a PR. Or get in touch via `push.pals.dev@gmail.com`

---

### Overview

We've introduced a **shared, versioned protocol** to enable robust client-server communication:

- **`packages/protocol`**: Centralized schema definitions, TypeScript types, and validators (Ajv)
- **`apps/server`**: Bun-based server streaming events over SSE (web) and WebSocket (mobile/desktop)
- **`apps/client`**: Expo client with automatic transport selection
- **`apps/agent-local`**: Local agent daemon — runs tools, orchestrates tasks, gates approvals
- **`apps/worker`**: Worker daemon — polls job queue, runs heavy tasks (test, lint)
- **A2A Scaffolding**: Placeholder interfaces for future Agent-to-Agent support

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                Shared Protocol (packages/protocol)             │
│  - JSON Schemas (envelope, events) — 27 event types            │
│  - Routing fields: from, to, correlationId, parentId, turnId   │
│  - TypeScript types · Ajv validators · v0.1.0                  │
└────────────────────────────────────────────────────────────────┘
           ▲              ▲              ▲
           │              │              │
    ┌──────┴──┐    ┌──────┴──────┐   ┌───┴────────┐
    │ Server  │◄──►│ Agent-local │──►│  Worker(s) │
    │ (Bun)   │    │  daemon     │   │  (polling) │
    └─┬───┬───┘    │             │   └────────────┘
      │   │        │ Tools:      │         │
    SSE  WS       │ git.*       │    bun.test
      │   │        │ file.*      │    bun.lint
      │   │        │ bun.*       │    (heavy work)
    ┌─┴───┴─┐      │             │
    │ Client │     │ Planner:    │
    │ (Expo) │     │ local/LLM   │
    └────────┘     └─────────────┘

    Flow: Client → Server → Agent-local → Tools/Workers → Server → Client
```

### Components

| Component | Location | Role |
|-----------|----------|------|
| **Protocol** | `packages/protocol` | Shared types, schemas, validators |
| **Server** | `apps/server` | Event hub, session state, job queue (SQLite), auth |
| **Agent-local** | `apps/agent-local` | Tool execution, planning, approval gating |
| **Worker** | `apps/worker` | Background heavy tasks (tests, lint) |
| **Client** | `apps/client` | Expo React Native + web UI |

### Key Features

**27 Event Types**: Full multi-agent lifecycle — tasks, tools, approvals, jobs, delegation
**Rich Routing**: `from`/`to` agent attribution, `turnId` grouping, `correlationId` threading
**Safety**: Tool approval gating, path sanitization, output truncation, timeout enforcement
**SQLite Job Queue**: Atomic claim, job logs, artifact tracking (in-memory by default)
**Planner Interface**: Swap between local heuristic and remote LLM (Ollama/OpenAI compatible)
**Client UI**: Event cards by type, approval buttons, task progress, diff preview, agent filters

## Prerequisites

- **Bun** (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js** (optional, for development tools)
- **Expo CLI** (`bun add -g expo-cli`)

### Quick Start

```bash
# Install dependencies
bun install

# Build protocol (required first time)
cd packages/protocol && bun run build && cd ../..

# Set auth token (used by server, agent-local, worker)
export PUSHPALS_AUTH_TOKEN=my-secret-token

# Terminal 1: Run server
bun run server

# Terminal 2: Run agent-local daemon (connects to server, runs tools)
bun run agent-local

# Terminal 3: Run worker (polls job queue for heavy tasks)
bun run worker

# Terminal 4: Run web client
bun web

# Or run everything at once:
bun run dev:full
```

### Dogfood Scenario

The "definition of done" — use PushPals to change PushPals:

1. **Start the stack**: `bun run dev:full`
2. **Open the UI** at `http://localhost:8081`
3. **Send a message**: "Run git status on this repo"
4. **Watch the trace** in the UI:
   - `task_created` — agent plans the work
   - `agent_status` busy → `task_started`
   - `tool_call` (git.status) → `tool_result`
   - `task_completed` with summary
   - `agent_status` idle
5. **Try an approval flow**: "Apply a patch to fix the README"
   - `tool_call` (git.applyPatch, `requiresApproval=true`)
   - UI shows **Approve / Deny** buttons
   - Click Approve → `approved` event → tool runs

```bash
# Run automated smoke test (requires server + agent-local running)
PUSHPALS_AUTH_TOKEN=my-secret-token bun run scripts/smoke-test.ts
```

### Event Types

| Category | Types |
|----------|-------|
| **Chat** | `assistant_message`, `log`, `error`, `done` |
| **Repo** | `scan_result`, `suggestions`, `diff_ready`, `committed` |
| **Approvals** | `approval_required`, `approved`, `denied` |
| **Agent** | `agent_status` |
| **Tasks** | `task_created`, `task_started`, `task_progress`, `task_completed`, `task_failed` |
| **Tools** | `tool_call`, `tool_result` |
| **Delegation** | `delegate_request`, `delegate_response` |
| **Jobs** | `job_enqueued`, `job_claimed`, `job_completed`, `job_failed` |

### Protocol Documentation

- [Protocol README](packages/protocol/README.md) - Full schema reference
- [Server README](apps/server/README.md) - Event bus & endpoints
- [Client README](apps/client/README.md) - API & transport selection
- [A2A Scaffolding](packages/protocol/src/a2a/README.md) - Future integration notes
