# Push Pals

Multi-device, always-on, multi-agent coding with clear orchestration and auditability.

## Overview

Push Pals runs a small software "team" around your repository:

- `apps/client`: chat UI (Expo web/mobile)
- `apps/server`: event hub + persistence + queues (SQLite)
- `apps/localbuddy`: `LocalBuddy` HTTP ingress + prompt enhancement
- `apps/remotebuddy`: `RemoteBuddy` orchestrator and scheduler
- `apps/workerpals`: `WorkerPals` execution daemons (host or Docker/OpenHands)
- `apps/source_control_manager`: `SourceControlManager` merge/push daemon

## Current Architecture

### Fast path (chat and status)

1. Client sends message to `LocalBuddy` (`POST /message`).
2. LocalBuddy emits immediate user/session events through `CommunicationManager`.
3. LocalBuddy enriches prompt with repo context and enqueues request (`/requests/enqueue`).
4. RemoteBuddy claims request (`/requests/claim`), plans, and emits progress events.
5. Client receives all updates from server event stream (`SSE` or `WS`) and re-renders incrementally.

### Slow path (execution and integration)

1. RemoteBuddy schedules WorkerPal jobs (`/jobs/enqueue`), optionally targeting an idle WorkerPal.
2. WorkerPals claim jobs (`/jobs/claim`), execute in isolated worktrees (and Docker when enabled).
3. For mutating work, WorkerPals create commits on per-job branches: `agent/<workerId>/<jobId>`.
4. WorkerPals enqueue completions (`/completions/enqueue`).
5. SourceControlManager claims completions (`/completions/claim`), cherry-picks/merges into integration branch (`main_agents` by default), runs checks, and pushes integration branch.

## Communication Model

`packages/shared/src/communication.ts` provides a shared `CommunicationManager` used by LocalBuddy, RemoteBuddy, and SourceControlManager.

This keeps session messaging consistent:

- user messages
- assistant messages
- task lifecycle (`task_created`, `task_started`, `task_progress`, ...)
- job lifecycle (`job_claimed`, `job_completed`, `job_failed`)
- integration status (SourceControlManager merge/push success/failure)

## Branching Model

- `main` is the source-of-truth branch.
- Integration branch defaults to `main_agents` (`PUSHPALS_INTEGRATION_BRANCH`).
- Integration branch upstream can track `origin/main` (`PUSHPALS_INTEGRATION_BASE_BRANCH=main`).
- Worker branches are ephemeral and namespaced: `agent/<workerId>/<jobId>`.
- SourceControlManager serializes integration into `main_agents` and pushes it.

## Isolation Model

- Worker execution uses isolated git worktrees under `.worktrees/`.
- Docker worker mode isolates runtime and toolchain per job container.
- SourceControlManager uses a dedicated worktree by default:
  - `.worktrees/source_control_manager`
- Startup refuses running SourceControlManager directly in your active workspace.

## Startup

Use:

```bash
bun run start
```

`scripts/start.ts` preflights:

- integration branch existence/bootstrapping
- git auth requirements for push flows
- SourceControlManager dedicated worktree
- worker Docker image existence (auto-build if missing)

Then it starts full dev stack via `dev:full`.

## Key Scripts

- `bun run dev:full`: full local stack
- `bun run workerpals:only:docker`: WorkerPal in strict Docker mode
- `bun run source_control_manager:only`: SourceControlManager daemon
- `bun run source_control_manager:only:dev`: same, with clean-check bypass

## Core Environment Variables

See `.env.example` for full details. Most important:

- `PUSHPALS_SESSION_ID`
- `PUSHPALS_AUTH_TOKEN`
- `PUSHPALS_INTEGRATION_BRANCH` (default `main_agents`)
- `PUSHPALS_INTEGRATION_BASE_BRANCH` (default `main`)
- `SOURCE_CONTROL_MANAGER_MAIN_BRANCH`
- `SOURCE_CONTROL_MANAGER_REPO_PATH`
- `REMOTEBUDDY_MAX_WORKERPALS`
- `REMOTEBUDDY_AUTO_SPAWN_WORKERPALS`
- `REMOTEBUDDY_WAIT_FOR_WORKERPAL_MS`
- `WORKERPALS_EXECUTOR` (`openhands` default)
- `WORKERPALS_DOCKER_IMAGE`
- `WORKERPALS_REQUIRE_DOCKER`

## Repo Layout

- `apps/server`: HTTP API, sessions, queues, worker heartbeats
- `apps/client`: chat UI + event subscription
- `apps/localbuddy`: LocalBuddy prompt ingestion/enrichment
- `apps/remotebuddy`: RemoteBuddy planning, scheduling, queue orchestration
- `apps/workerpals`: WorkerPals execution, commits, completion enqueue
- `apps/source_control_manager`: SourceControlManager integration pipeline
- `packages/protocol`: shared event/request/response schema
- `packages/shared`: shared repo helpers + `CommunicationManager`

## Status

Under active development.
