# 04. Server Control Plane (`apps/server`)

## Purpose

`apps/server` is the system backbone. It is responsible for:

- session lifecycle,
- event transport and replay,
- request/job/completion queue APIs,
- a service-neutral RepositoryAgent request broker,
- evidence-backed shared memory APIs,
- worker heartbeat and claim lifecycle,
- autonomy state and lock APIs.

If PushPals were an operating system, this is the kernel.

## Component Contract

- Receives: session commands and queue mutations from every runtime service.
- Owns: durable SQLite state, queue transitions, request/worker/publisher/RepositoryAgent leases, shared memory records, and session history.
- Produces: replayable events, queue claims, RepositoryAgent results, memory operations, status snapshots, and recovery projections.
- Does not own: LLM planning or repository analysis, repository execution, or git publication.

Publication-bearing jobs follow `pending -> claimed (pre-start) -> claimed (started) -> finalizing -> completed`. Successful no-candidate jobs can move directly from `claimed (started)` to `completed`; recovery may return work to `pending`, while `failed`, `abandoned`, and `publish_blocked` are terminal branches.

## Key Files

- `apps/server/src/server_main.ts` - HTTP router and endpoint orchestration.
- `apps/server/src/events.ts` - session manager and event bus semantics.
- `apps/server/src/db.ts` - durable event store.
- `apps/server/src/requests.ts` - request queue model.
- `apps/server/src/jobs.ts` - job queue + logs + worker state.
- `apps/server/src/completions.ts` - completion queue model.
- `apps/server/src/repository_agent_queue.ts` - durable RepositoryAgent requests, leases, deadlines, and stale-claim recovery.
- `apps/server/src/repository_agent_context.ts` - canonical repository identity and exact-snapshot validation.
- `apps/server/src/memory_store.ts` - server-owned shared memory records and reinforcement observations.
- `apps/server/src/autonomy.ts` - autonomy snapshot/policy persistence and lock state.
- `apps/server/src/lifecycle_reconciliation.ts` - guarded startup and periodic recovery tracking.

## Design Choices That Matter

### 1) Event durability first

Events are persisted before live broadcast. This keeps SSE/WS replay consistent across crashes.

### 2) Cursor-based replay

Sessions use monotonic event cursors (`event_id`) so clients can reconnect with `after=<cursor>`.
Each connection replays one page of at most 1,000 later events before moving to
live delivery; it is not an unbounded history export.

The session rows and events are durable, but `SessionManager` does not hydrate
its active in-memory session map during process startup. After a Server restart,
a client must first rejoin the stable ID with `POST /sessions` before opening
SSE/WS or posting commands. Startup-readiness bookkeeping and pending approval
objects are also process-local; an approval event is durable, but an interrupted
in-memory approval continuation is not reconstructed automatically.

### 3) Queue state is explicit

Each queue has typed statuses (`pending`, `claimed`, `completed`, `failed`, etc.) and transition checks.

Autonomy requests add a two-phase admission fence without inventing a hidden
claim state. A provisional `pending` row carries a one-time confirmation token
and absolute expiry, is excluded from queue position, backlog counts, recovery,
and claim selection, and becomes eligible only after exact confirmation.
Abandoned provisional rows become failed audit records and their idempotency key
can be safely rearmed on the next live cycle. The capability token is returned
only by enqueue and is redacted from request detail, list, claim, and telemetry
projections. Confirmation retries remain idempotent after claim or completion.

### 4) Built-in stale recovery

Jobs claimed by dead workers can be recovered through stale-claim sweeps.

### 5) Durable WorkerPal runtime circuit

Repeated structurally owned WorkerPal runtime failures open a SQLite-backed
circuit for the packaged runtime generation. The generation comes from the CLI
runtime tag in packaged installs; source runs use a server epoch. An open
circuit keeps new autonomy admission closed and defers every `task.execute`
claim for at most 30 seconds at a time.

After the cooldown, one atomic half-open lease admits exactly one execution
canary. Heartbeats renew that lease. A successful execution closes the circuit
and releases tagged request/job deferrals; a matching runtime failure renews
the full cooldown; a different failure or lost lease schedules another bounded
recheck. On restart, the same packaged generation retains its circuit and old
long deferrals are shortened. A changed packaged generation starts clean.

Job logs carry the claim generation so late output from an abandoned claim
cannot refresh a newer claim's stale-activity clock. Repeated circuit-deferral
logs are fingerprint-deduplicated and retention-bounded.

Every WorkerPal-owned mutation (logs, diagnostics, deferral, terminal status,
and completion handoff) carries the worker ID and claim generation. The server
checks both in the same transaction as the state change, so a delayed callback
cannot mutate a reclaimed job. Repeating `/jobs/claim` with the same worker ID
replays its active claim and generation, which makes a lost claim response
recoverable without dequeuing another job. Publication handoff additionally
requires a commit SHA, branch, and the parent job's session ID. Worker IDs are
process identities: manually launched concurrent workers must never reuse one.
Worker IDs are trimmed consistently and limited to 128 characters; overlength
identities are rejected instead of being silently truncated.

Claim liveness is tracked with a server-receipt activity timestamp refreshed by
claim replay, an exact-authority execution-start acknowledgement, busy
heartbeats, and authorized logs. A claim remains explicitly pre-execution until
`POST /jobs/:id/start` is positively acknowledged; recovery before that boundary
is retry-safe and does not become WorkerPal runtime-failure evidence. Indexed
stale sweeps therefore stay bounded and cannot be delayed or accelerated by a
worker clock. Heartbeat recovery, periodic recovery, and deferred-maintenance
failure share the same replay-safe session, request, autonomy, and runtime-canary
projection path.

WorkerPal retries the identical lease-bound deferral, completion handoff, or
terminal request after an ambiguous response. WorkerPal and
SourceControlManager require an explicit JSON `{ "ok": true }` acknowledgement
for authoritative state changes; a malformed HTTP success remains unconfirmed.
If persistence still cannot be confirmed, the process suppresses terminal
projection and recycles so stale recovery remains authoritative. An active
half-open runtime canary keeps its sole lease until success, failure, or lease
recovery, even when older in-flight work reports a matching failure. Startup
migrations preserve every unresolved publication candidate while releasing
only duplicate active dedupe-key ownership.

### 6) Brokered repository intelligence

RepositoryAgent is a logical capability, not Server-side model execution. Server validates and persists typed questions, while a worker currently hosted inside RemoteBuddy claims them from a dedicated queue. Claim token plus generation fencing prevents a stale worker from renewing, completing, or failing a newer claim. Heartbeats extend leases; expired claims return to `pending`; retryable failures use bounded backoff; exhausted attempts and passed deadlines become terminal. Canonical request fingerprints prevent a reused idempotency key from returning an unrelated result, and terminal retention bounds the queue.

Submission is idempotent within `(repository identity, caller service, session, idempotency key)`. This lets independent services use conventional operation names without colliding. Before enqueue, Server resolves the request against its canonical repository root and rejects identity, revision, or content-tree drift. Completion repeats that identity/revision/tree fence so an answer cannot silently describe another checkout.

Shared memory is a separate Server-owned subsystem. Other processes call memory
operations through the typed HTTP client and do not access its tables directly.
This keeps validation, compare-and-set revisions, invalidation, expiry, and
reinforcement behavior consistent. One current layering exception is
RemoteBuddy: it opens the same shared database and issues `SELECT` queries
against `jobs` to resolve a failed job's worker and assemble recent planning
context. It does not use that connection for memory or queue mutations; those
still go through Server. Server also reconciles authoritative autonomy lifecycle
outcomes into a durable, leased, idempotent RepositoryAgent feedback ledger;
only analysis-cache references are trained by delivery outcomes, and
infrastructure/environment failures are excluded.

## Endpoint Families

Server endpoints are easiest to reason about by family:

- Session/event transport:
  - session create, SSE/WS stream, command/message ingress.
- Request queue:
  - enqueue, claim, complete/fail, list/snapshot.
- Job queue:
  - enqueue, claim, log, complete/fail, worker heartbeat.
- Completion queue:
  - enqueue, claim, processed/failed state updates.
- RepositoryAgent broker:
  - `POST /repository-agent/requests` to submit,
  - `GET /repository-agent/requests/:id` to poll,
  - `POST /repository-agent/requests/claim` to claim,
  - `POST /repository-agent/requests/:id/lease/renew` to heartbeat,
  - `POST /repository-agent/requests/:id/complete` for fenced completion,
  - `POST /repository-agent/requests/:id/fail` for fenced failure.
- Shared memory:
  - `PUT /memory/records`,
  - `POST /memory/get`, `/memory/search`, `/memory/invalidate`, `/memory/reinforce`, and `/memory/prune`.
- Runtime configuration and operations:
  - `GET`/`POST /config/runtime`,
  - `GET /system/status` and `GET /healthz`,
  - `POST /telemetry/llm-usage`,
  - local `POST /admin/shutdown`.
- Autonomy:
  - snapshot/objective state, lock lifecycle, replay payload storage.

The general route-level bearer check is intentionally inert in the current
loopback-only runtime because Server sets the session auth token to `null`.
Queue claim generations/tokens, memory caller authority, and SCM repair proofs
remain separate integrity mechanisms; none of them makes the API safe to expose
off-host.

The bounded streaming JSON reader is currently used only by the memory and
RepositoryAgent submission surfaces. Many session, configuration, queue, and
autonomy routes still call `request.json()` directly and therefore have no
application-level request-body cap. The loopback boundary is part of their
current denial-of-service threat model.

## Request Queue Model

Requests support:

- priority ordering,
- force-lane hints (`worker` vs deterministic),
- queue wait budgets,
- optional autonomy metadata with scope invariants.

Ordinary request idempotency keys are currently global rather than scoped by
session/caller. Reusing a key for a different prompt can return the existing
non-failed request without comparing its content. Callers must allocate one
stable key per logical request and never recycle it for unrelated work.

The request queue sanitizes and validates the shape of autonomy-origin scope
hints, but evaluates them in advisory `hintsOnly` mode. They do not prevent
broad writes; execution isolation and the later deterministic validation,
review, and publication gates provide the enforcement boundaries.

Jobs also carry an authoritative work class. Elevated `repair` and `recovery`
admission is derived from an existing Server-owned validation incident or PR
repair lifecycle; caller-provided labels alone cannot bypass an autonomy freeze
or queue backpressure. Claim ordering combines deadlines and aging with a
bounded elevated-work burst, so urgent recovery makes progress without
permanently starving interactive or ordinary work. An overdue recovery blocks
new ideation, not the recovery itself.

## Job Queue Model

Jobs include:

- execution/finalization budgets,
- worker claim metadata,
- packaged runtime and claim generations,
- structured logs,
- queue metrics and SLO summaries.

Worker heartbeats are persisted to infer online/offline state.

Autonomy health uses independent root objectives for global freeze sampling;
child repairs do not manufacture extra samples. Attempt outcomes distinguish
quality rejection, environment blocking, orchestration/runtime failure,
publication failure, no-change completion, and confirmed product regression.
Latency and review metrics include unresolved reviewed objectives and successful
provider outcomes rather than silently dropping null terminal rows. Semantic
failure clusters include stable vision lineage plus component/target family, so
adjacent-path retries coalesce without suppressing unrelated work.

## Completion Queue Model

Completions are the handoff from execution to integration:

- commit SHA + branch,
- optional worker-supplied PR metadata,
- process state (`pending`, `claimed`, `processed`, `failed`).

## On-Call Debug Checklist

When a workflow appears stuck:

1. Check request queue pending/claimed counts.
2. Check job queue pending/claimed counts and worker heartbeat recency.
3. Check completion queue pending/claimed counts.
4. Check latest session cursor and whether new events are still being persisted.
5. Check stale-claim recovery logs for automatic handback behavior.
6. For repository assistance, inspect request deadline, lease expiry, claim generation, and requested versus canonical snapshot.
7. For stale guidance, inspect memory scope, evidence blob IDs, status, expiry, and reinforcement observations.

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
