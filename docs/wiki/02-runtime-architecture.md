# 02. Runtime Architecture

## End-to-End Flow

At runtime, a typical interactive request flows like this:

1. Client sends user message to LocalBuddy (`POST /message`).
2. LocalBuddy may answer directly or enqueue a request into Server (`/requests/enqueue`).
3. RemoteBuddy claims request (`/requests/claim`), plans work, emits status/messages.
4. RemoteBuddy may enqueue a job (`/jobs/enqueue`).
5. WorkerPals claims and executes (`/jobs/claim` -> run -> complete/fail).
6. WorkerPals enqueues completion metadata (`/completions/enqueue`).
7. SourceControlManager claims completion and integrates it.
8. Server emits session events over SSE/WS so UI can render the full lifecycle.

## Control Plane and Data Plane Split

- Control plane: `apps/server`
  - queue state, event history, session transport, autonomy APIs.
- Data plane:
  - Worker execution in isolated worktrees/containers (`apps/workerpals`).
  - Git integration work in SourceControlManager.

This split limits blast radius: service crashes should not directly corrupt execution worktrees.

## Persistence Model

Server uses SQLite (`outputs/data/pushpals.db`) for:

- sessions,
- append-only events (cursor replay),
- request queue,
- job queue and logs,
- completion queue,
- autonomy state/snapshots/locks.

Important design detail:

- persist first, broadcast second for events.

This guarantees replay correctness after crashes or reconnects.

## Session Transport

Two transport options are supported:

- SSE (`/sessions/:id/events`) with cursor replay (`after` query param).
- WebSocket (`/sessions/:id/ws`) also cursor-aware.

Client libraries choose transport by environment and fall back with reconnect policies.

## Queue Semantics

Both requests and jobs support priority tiers:

- `interactive`
- `normal`
- `background`

Ordering is priority first, then age. Queue stats and SLO summaries are computed from persisted timestamps.

## Reliability Patterns Used

- Idempotency store in RemoteBuddy to avoid duplicate processing on reconnect.
- Stale-claim recovery sweeps for jobs in Server.
- Lock lease lifecycle for autonomy dispatch (`acquire`, `renew`, `release`).
- Retry policies and bounded attempt counts in WorkerPals and SourceControlManager.
- Worktree isolation per execution job.

## Tradeoffs

Pros:

- replayable lifecycle for debugging and audits,
- strong failure containment,
- policy-first autonomous execution model.

Cons:

- operational complexity for local development,
- more infrastructure code compared to direct single-agent execution,
- requires disciplined schema/version management across components.

## Future Improvements

- Add OpenTelemetry-style trace propagation through request/job/completion IDs.
- Add dead-letter queues for repeatedly failing requests/jobs/completions.
- Add adaptive queue fairness (aging + priority balancing) for long-running background workloads.
