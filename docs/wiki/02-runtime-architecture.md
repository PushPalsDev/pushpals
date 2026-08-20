# 02. Runtime Architecture

## End-to-End Flow

At runtime, a typical interactive request flows like this:

1. CLI, Expo, or VS Code submits a Server session message (`POST /sessions/:id/message`).
2. Server persists the message and enqueues a durable request.
3. RemoteBuddy claims the request (`/requests/claim`), plans work, and emits status/messages.
4. RemoteBuddy may enqueue a job (`/jobs/enqueue`).
5. WorkerPals claims, starts, and executes the job.
6. Candidate-producing work enters the completion queue; other outcomes terminate on the job.
7. SourceControlManager claims a completion and integrates or publishes it.
8. Server emits session events over SSE/WS so clients can render the full lifecycle.

LocalBuddy provides an optional `POST /message` ingress that can answer locally
or enqueue into the same Server request queue.

## Flow Boundaries

Three boundaries matter most during design and debugging:

- Planning boundary:
  - RemoteBuddy decides what planned work should be done; LocalBuddy only decides quick reply versus delegation on its ingress.
- Execution boundary:
  - WorkerPals decides how planned work is executed.
- Integration boundary:
  - SourceControlManager decides whether and how execution output lands on integration branch.

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

## Failure Domains

- If `apps/client` fails:
  - request/job pipelines still run; only user visibility is reduced.
- If `apps/remotebuddy` fails:
  - requests accumulate; workers continue current claimed jobs.
- If `apps/workerpals` fails:
  - jobs remain pending/claimed until recovery sweeps and worker return.
- If `apps/source_control_manager` fails:
  - completions accumulate pending integration.
- If `apps/server` fails:
  - control plane is unavailable; all components degrade until restart.

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

## Correlation and Traceability

To trace one unit of work end-to-end, follow:

- `requestId` (request lifecycle),
- `jobId` (execution lifecycle),
- `completionId` (integration lifecycle),
- `sessionId` and event cursor (user-visible timeline).

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

## Safe Change Checklist

When modifying runtime flow:

1. Confirm queue status transitions still form a valid state machine.
2. Confirm session events remain replay-safe.
3. Confirm idempotency behavior on reconnect/restart.
4. Update the corresponding component wiki pages.

## Future Improvements

- Add OpenTelemetry-style trace propagation through request/job/completion IDs.
- Add dead-letter queues for repeatedly failing requests/jobs/completions.
- Add adaptive queue fairness (aging + priority balancing) for long-running background workloads.
