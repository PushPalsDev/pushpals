# 06. RemoteBuddy (`apps/remotebuddy`)

## Purpose

RemoteBuddy is the planning and orchestration brain.

It owns:

- claiming queued requests,
- generating structured plans,
- deciding lane (`deterministic` vs `worker`),
- emitting assistant/task/job status events,
- enqueueing executable jobs for WorkerPals,
- maintaining durable planning memory for the repository.

It does not own:

- code execution (WorkerPals),
- git integration/PR merge policy (SourceControlManager),
- queue persistence (Server).

## Key Files

- `apps/remotebuddy/src/remotebuddy_main.ts` - orchestrator loop, planning, dispatch, and memory usage.
- `apps/remotebuddy/src/brain.ts` - planner contract + repair/fallback behavior.
- `apps/remotebuddy/src/memory.ts` - memory backend interface, noop/in-memory/composite backends.
- `apps/remotebuddy/src/persistent_memory.ts` - SQLite-backed persistent memory backend.
- `apps/remotebuddy/src/idempotency.ts` - replay-safe duplicate suppression.
- `apps/remotebuddy/src/autonomous_engine.ts` - bounded autonomous objective dispatch.

## New Memory Layer

RemoteBuddy now has a modular memory backend layer instead of hardwiring a single store.

`memory.ts` defines a pluggable interface:

- `remember(input, options)`
- `recallForPlanning(options)`
- `purgeExpired(retentionDays, repoRoot?)`
- `close()`

`createSessionMemoryBackend(enabled, factories)` builds one of:

- `NoopSessionMemory` when disabled,
- a single backend instance,
- `CompositeSessionMemory` when multiple backends are provided.

This allows adding a new memory system by appending another factory in one place (`remotebuddy_main.ts`) without changing orchestrator call sites.

## Persistent Memory Backend (SQLite)

`PersistentSessionMemory` stores rows in `remotebuddy_memory` with:

- `repoRoot`
- `sessionId`
- `requestId`
- `kind`
- `summary`
- `createdAt`

It uses:

- WAL mode,
- bounded summary truncation (`max_summary_chars`),
- bounded recall (`max_recall_items`, `max_recall_chars`),
- TTL-based pruning (`retention_days`), both at startup and during writes.

RemoteBuddy currently initializes memory as `composite(sqlite)` when enabled.

## What Gets Remembered

RemoteBuddy persists high-signal orchestration facts, including:

- incoming request summary (`kind=request`),
- planner decision summary (`kind=plan`),
- job enqueue success/failure (`kind=job_enqueued`, `kind=job_enqueue_failed`),
- observed worker outcomes (`kind=job_completed`, `kind=job_failed`),
- planning failures (`kind=planning_failed`).

This history is scoped by repo root and session.

## How Memory Is Used In Planning

At plan time, RemoteBuddy builds context from:

1. persistent recall (`recallForPlanning`)
2. current in-process recent context ring buffer

It then de-duplicates and passes the merged list to the planner.

When `include_cross_session=true`, recall includes repo history from prior sessions; otherwise it can remain session-local.

## Request Lifecycle (Current)

For each claimed request:

1. Parse routing/force metadata.
2. Build planning context (persistent + live).
3. Call planner and sanitize plan.
4. Patch scope/write globs when needed.
5. Emit task/job progress events.
6. Enqueue `task.execute` or return direct response.
7. Persist request/plan/outcome memory entries.

## Config Knobs

Primary knobs live in `config/*.toml` under `[remotebuddy.memory]`:

- `enabled`
- `include_cross_session`
- `max_recall_items`
- `max_recall_chars`
- `max_summary_chars`
- `retention_days`

Env overrides are also supported via `REMOTEBUDDY_MEMORY_*` variables in `packages/shared/src/config.ts`.

## Debugging Checklist

- "Memory appears unused":
  - confirm `remotebuddy.memory.enabled=true`.
  - check startup log line for `Persistent memory backend: composite(sqlite)`.
- "No cross-session recall":
  - confirm `include_cross_session=true`.
  - inspect `retention_days` and whether old entries were purged.
- "Planner quality regressed":
  - inspect `Recent PR/job/request memory` lines injected into planning context.

## Tradeoffs

Pros:

- durable repo-level context across sessions,
- backend modularity for future memory systems,
- bounded recall/summary size protects prompt budgets.

Cons:

- more state to reason about,
- risk of stale memory bias if retention is too long,
- extra storage/maintenance path (SQLite + pruning).
