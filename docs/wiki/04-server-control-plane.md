# 04. Server Control Plane (`apps/server`)

## Purpose

`apps/server` is the system backbone. It is responsible for:

- session lifecycle,
- event transport and replay,
- request/job/completion queue APIs,
- worker heartbeat and claim lifecycle,
- autonomy state and lock APIs.

If PushPals were an operating system, this is the kernel.

## Key Files

- `apps/server/src/server_main.ts` - HTTP router and endpoint orchestration.
- `apps/server/src/events.ts` - session manager and event bus semantics.
- `apps/server/src/db.ts` - durable event store.
- `apps/server/src/requests.ts` - request queue model.
- `apps/server/src/jobs.ts` - job queue + logs + worker state.
- `apps/server/src/completions.ts` - completion queue model.
- `apps/server/src/autonomy.ts` - autonomy snapshot/policy persistence and lock state.

## Design Choices That Matter

### 1) Event durability first

Events are persisted before live broadcast. This keeps SSE/WS replay consistent across crashes.

### 2) Cursor-based replay

Sessions use monotonic event cursors (`event_id`) so clients can reconnect with `after=<cursor>`.

### 3) Queue state is explicit

Each queue has typed statuses (`pending`, `claimed`, `completed`, `failed`, etc.) and transition checks.

### 4) Built-in stale recovery

Jobs claimed by dead workers can be recovered through stale-claim sweeps.

## Request Queue Model

Requests support:

- priority ordering,
- force-lane hints (`worker` vs deterministic),
- queue wait budgets,
- optional autonomy metadata with scope invariants.

The queue validates autonomy-origin metadata against component scope policy to prevent broad writes.

## Job Queue Model

Jobs include:

- execution/finalization budgets,
- worker claim metadata,
- structured logs,
- queue metrics and SLO summaries.

Worker heartbeats are persisted to infer online/offline state.

## Completion Queue Model

Completions are the handoff from execution to integration:

- commit SHA + branch,
- optional worker-supplied PR metadata,
- process state (`pending`, `claimed`, `processed`, `failed`).

## Tradeoffs

Pros:

- complete operational traceability,
- robust reconnect behavior,
- clear contracts for each downstream service.

Cons:

- database-centric logic is dense and non-trivial,
- endpoint surface is broad,
- queue semantics require rigorous test coverage to avoid regressions.

## Future Improvements

- Add migration framework with versioned schema history instead of inline additive migrations.
- Add queue state transition audit table for deeper root-cause analysis.
- Add rate limiting and overload admission control for bursty workloads.
