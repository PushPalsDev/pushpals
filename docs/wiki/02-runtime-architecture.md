# 02. Runtime Architecture

## End-to-End Flow

At runtime, a typical interactive request flows like this:

1. CLI, Expo, or VS Code submits a Server session message (`POST /sessions/:id/message`).
2. Server persists the message and enqueues a durable request.
3. RemoteBuddy claims the request (`/requests/claim`), plans work, and emits status/messages. When it needs repository-level judgment, it can use the same RepositoryAgent interface available to every other service.
4. RemoteBuddy may enqueue a job (`/jobs/enqueue`).
5. WorkerPals claims, starts, and executes the job.
6. Candidate-producing work enters the completion queue; other outcomes terminate on the job.
7. SourceControlManager claims a completion and integrates or publishes it.
8. Server emits session events over SSE/WS so clients can render the full lifecycle.

LocalBuddy provides an optional `POST /message` ingress that can answer locally
or enqueue into the same Server request queue.

## Repository Assistance Side Flow

RepositoryAgent questions do not enter the user request or execution job queues. They use a separate durable Server queue:

1. A caller resolves a stable repository identity and exact snapshot (`revision`, content `tree`, and dirty state).
2. It submits a typed question to `POST /repository-agent/requests` and either polls or uses the bounded `ask(...)` helper.
3. Server validates the snapshot against its canonical worktree, persists the request, and deduplicates by repository identity, caller service, session, and idempotency key.
4. The RepositoryAgent worker hosted inside RemoteBuddy claims a fenced lease and renews it while host-side inspection builds bounded evidence for the assigned LLM. Codex runs in a neutral no-tools repository, never the target worktree.
5. Server accepts a result only from the current claim generation and only when its analyzed repository identity, revision, and tree match the request.
6. The caller consumes the structured advice, then applies its own deterministic gates.

The queue/worker boundary is deliberate. Any service can use the capability without importing RemoteBuddy or knowing where the worker is hosted. A caller timeout stops only that caller's wait; the durable request remains recoverable until its declared deadline.

## Flow Boundaries

Four boundaries matter most during design and debugging:

- Planning boundary:
  - RemoteBuddy decides what planned work should be done; LocalBuddy only decides quick reply versus delegation on its ingress.
- Repository-assistance boundary:
  - Callers define and consume the question; Server owns durability; the RemoteBuddy-hosted RepositoryAgent worker owns advisory analysis.
- Execution boundary:
  - WorkerPals decides how planned work is executed.
- Integration boundary:
  - SourceControlManager decides whether and how execution output lands on integration branch.

## Control Plane and Data Plane Split

- Control plane: `apps/server`
  - queue state, event history, session transport, autonomy APIs, the RepositoryAgent broker, and shared memory persistence.
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
- RepositoryAgent request queue and lease state,
- evidence-backed shared memory records and reinforcement observations,
- autonomy state/snapshots/locks.

Important design detail:

- persist first, broadcast second for events.

This keeps the replay source durable after crashes or reconnects. Transport
replay is intentionally bounded per connection, as described below.

## Failure Domains

- If `apps/client` fails:
  - request/job pipelines still run; only user visibility is reduced.
- If `apps/remotebuddy` fails:
  - user requests and RepositoryAgent questions accumulate; workers continue current claimed jobs. Expired RepositoryAgent leases are returned to its pending queue when a worker resumes claiming.
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

Both transports deliver `{ envelope, cursor }` wrappers. On each new
connection, Server currently replays at most 1,000 persisted events after the
requested cursor and then subscribes the connection to live events. Expo and
CLI clients retain their latest cursors; the current VS Code webview reconnects
from cursor `0` and can therefore redisplay replayed events. Client libraries
choose transport by environment and use bounded reconnect policies.

## Queue Semantics

Requests, jobs, and RepositoryAgent requests support priority tiers:

- `interactive`
- `normal`
- `background`

Request and RepositoryAgent claims sort by priority and then creation time;
completion claims are FIFO. Job ordering is richer: overdue deadlines come
first, followed by bounded work-class fairness and remaining deadlines, then
priority and creation time. Worker affinity also constrains job eligibility.
Queue stats and SLO summaries are computed from persisted timestamps.

## Correlation and Traceability

To trace one unit of work end-to-end, follow:

- `requestId` (request lifecycle),
- `jobId` (execution lifecycle),
- `completionId` (integration lifecycle),
- RepositoryAgent `requestId` plus caller `correlationId` (repository-assistance lifecycle),
- `sessionId` and event cursor (user-visible timeline).

## Reliability Patterns Used

- Server-side idempotency keys plus fenced claims and callbacks. RemoteBuddy's
  local `IdempotencyStore` remains a constructed compatibility object but is not
  called by the current polling path.
- Stale-claim recovery sweeps for jobs in Server.
- Lock lease lifecycle for autonomy dispatch (`acquire`, `renew`, `release`).
- Fenced RepositoryAgent claim tokens/generations, heartbeats, request deadlines, and stale-claim recovery.
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
